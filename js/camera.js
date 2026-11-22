const PREVIEW_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 } };
const JPEG_QUALITY = 0.95;
const EXPOSURE_TIME_UNITS_PER_SECOND = 10_000;
const SLOWEST_SHUTTER = EXPOSURE_TIME_UNITS_PER_SECOND / 30;
const CALIBRATION_STEPS = 6;
const CALIBRATION_SETTLE_MS = 350;
const LUMA_TOLERANCE = 2;
const RED_BLUE_TOLERANCE = 0.02;
const DISPLAY_GAMMA = 2.2;
const MEASURE_SIZE_PX = 32;
const MEASURE_FRAMES = 3;
const FOCUS_COARSE_STEPS = 8;
const FOCUS_FINE_STEPS = 4;
const SHARPNESS_SIZE_PX = 128;
const LOCKABLE_CONTROLS = [
  { mode: 'focusMode', label: 'focus', lockModes: ['manual', 'single-shot'], values: ['focusDistance'] },
  { mode: 'exposureMode', label: 'exposure', lockModes: ['manual'], values: ['exposureTime', 'iso', 'exposureCompensation'] },
  { mode: 'whiteBalanceMode', label: 'white balance', lockModes: ['manual'], values: ['colorTemperature'] },
];

export class Camera extends EventTarget {
  stream = null;
  track = null;
  deviceId = null;
  locked = false;
  #video;
  #imageCapture = null;
  #photoCapabilities = null;
  #photoOptionsRejected = false;
  #lockedControls = [];
  #unlockableControls = [];
  #calibration = '';

  constructor(video) {
    super();
    this.#video = video;
  }

  get capabilities() { return this.track?.getCapabilities() ?? {}; }
  get settings() { return this.track?.getSettings() ?? {}; }

  async start(deviceId) {
    this.stream?.getTracks().forEach((track) => track.stop());
    const lens = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...lens, ...PREVIEW_SIZE }, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.deviceId = this.track.getSettings().deviceId;
    this.#video.srcObject = this.stream;
    await this.#video.play().catch(() => {});
    this.#imageCapture = 'ImageCapture' in window ? new ImageCapture(this.track) : null;
    this.#photoCapabilities = await this.#imageCapture?.getPhotoCapabilities().catch(() => null);
    this.#photoOptionsRejected = false;
    this.locked = false;
    this.#announceChange();
    return this.stream;
  }

  async lenses() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  async setLocked(locked) {
    const autoLook = locked ? await this.#measurePreview() : null;
    const results = [];
    for (const control of LOCKABLE_CONTROLS) {
      results.push({ control, mode: await this.#applyFirstSupported(control, locked ? control.lockModes : ['continuous']) });
    }
    this.locked = locked;
    this.#lockedControls = results.filter((r) => r.mode).map((r) => `${r.control.label} (${r.mode})`);
    this.#unlockableControls = results.filter((r) => !r.mode).map((r) => r.control.label);
    this.#calibration = locked ? await this.#matchLockedLookTo(autoLook, results) : '';
    this.#announceChange();
    return this.#lockedControls.length > 0;
  }

  diagnostics() {
    const { capabilities, settings } = this;
    return Object.fromEntries(LOCKABLE_CONTROLS.flatMap((control) => [control.mode, ...control.values])
      .map((key) => [key, { supported: capabilities[key], current: settings[key] }]));
  }

  async setExposureCompensation(value) {
    await this.track.applyConstraints({ advanced: [{ exposureCompensation: value }] }).catch(console.warn);
  }

  async capture(source) {
    const still = source === 'photo' && this.#imageCapture
      ? await this.#takeFullResPhoto()
      : await grabPreviewFrame(this.#video);
    return rotateStillToPreviewOrientation(still, this.#video.videoWidth, this.#video.videoHeight);
  }

  describe() {
    const settings = this.settings;
    const photo = this.#photoCapabilities;
    return [
      settings.width && `preview ${settings.width}×${settings.height}`,
      photo?.imageWidth?.max && `photo ${photo.imageWidth.max}×${photo.imageHeight.max}`,
      !this.#imageCapture && 'no Image Capture API, using preview frames',
      this.locked && this.#lockedControls.length && 'locked: ' + this.#lockedControls.join(', '),
      this.locked && this.#unlockableControls.length && 'not lockable: ' + this.#unlockableControls.join(', '),
      this.locked && this.#calibration,
    ].filter(Boolean).join(' · ');
  }

  async #applyFirstSupported(control, modes) {
    for (const mode of modes.filter((m) => this.capabilities[control.mode]?.includes(m))) {
      try {
        await this.track.applyConstraints({ advanced: [{ [control.mode]: mode }] });
        return mode;
      } catch (error) {
        console.warn('could not apply', control.mode, mode, error);
      }
    }
    return null;
  }

  async #matchLockedLookTo(autoLook, lockResults) {
    const lockedManually = (mode) => lockResults.some((r) => r.control.mode === mode && r.mode === 'manual');
    const report = [];
    if (lockedManually('focusMode') && this.capabilities.focusDistance) {
      report.push(await this.#focusOnSharpest());
    }
    if (lockedManually('whiteBalanceMode') && this.capabilities.colorTemperature) {
      report.push(await this.#matchWhiteBalance(autoLook.redBlue));
    }
    if (lockedManually('exposureMode') && this.capabilities.exposureTime) {
      report.push(await this.#matchExposure(autoLook.luma));
    }
    const lockedLook = await this.#measurePreview();
    report.push(`brightness ${autoLook.luma}→${lockedLook.luma}, red/blue ${autoLook.redBlue}→${lockedLook.redBlue}`);
    return report.join(' · ');
  }

  async #matchWhiteBalance(targetRedBlue) {
    const range = this.capabilities.colorTemperature;
    let [low, high] = [range.min, range.max];
    let kelvin = this.#roundToStep((low + high) / 2, range);
    for (let step = 0; step < CALIBRATION_STEPS; step++) {
      kelvin = this.#roundToStep((low + high) / 2, range);
      const { redBlue } = await this.#applyAndMeasure({ whiteBalanceMode: 'manual', colorTemperature: kelvin });
      if (Math.abs(redBlue - targetRedBlue) < RED_BLUE_TOLERANCE) break;
      if (redBlue < targetRedBlue) low = kelvin;
      else high = kelvin;
    }
    return `${kelvin} K`;
  }

  async #matchExposure(targetLuma) {
    const timeRange = this.capabilities.exposureTime;
    const isoRange = this.capabilities.iso;
    let exposureTime = this.settings.exposureTime || SLOWEST_SHUTTER / 4;
    let iso = this.settings.iso || isoRange?.min;
    for (let step = 0; step < CALIBRATION_STEPS; step++) {
      const { luma } = await this.#applyAndMeasure({ exposureMode: 'manual', exposureTime, ...(iso && { iso }) });
      if (Math.abs(luma - targetLuma) < LUMA_TOLERANCE) break;
      const wanted = exposureTime * (targetLuma / Math.max(luma, 1)) ** DISPLAY_GAMMA;
      exposureTime = clamp(wanted, timeRange.min, Math.min(timeRange.max, SLOWEST_SHUTTER));
      if (iso && isoRange) iso = Math.round(clamp(iso * (wanted / exposureTime), isoRange.min, isoRange.max));
    }
    return `1/${Math.round(EXPOSURE_TIME_UNITS_PER_SECOND / exposureTime)} s, ISO ${iso}`;
  }

  async #focusOnSharpest() {
    const range = this.capabilities.focusDistance;
    const nearest = 1 / range.min;
    const farthest = 1 / range.max;
    const sharpnessAt = async (diopters) => {
      await this.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: 1 / diopters }] }).catch(console.warn);
      await new Promise((resolve) => setTimeout(resolve, CALIBRATION_SETTLE_MS));
      return { diopters, sharpness: await this.#measureSharpness() };
    };
    const sweep = async (from, to, steps) => {
      const probes = [];
      for (let i = 0; i < steps; i++) probes.push(await sharpnessAt(from + ((to - from) * i) / (steps - 1)));
      return probes.reduce((best, probe) => (probe.sharpness > best.sharpness ? probe : best));
    };
    const coarseSpacing = (nearest - farthest) / (FOCUS_COARSE_STEPS - 1);
    const coarse = await sweep(farthest, nearest, FOCUS_COARSE_STEPS);
    const fine = await sweep(
      Math.max(farthest, coarse.diopters - coarseSpacing),
      Math.min(nearest, coarse.diopters + coarseSpacing),
      FOCUS_FINE_STEPS + 1);
    const best = fine.sharpness >= coarse.sharpness ? fine : coarse;
    await sharpnessAt(best.diopters);
    return `focus ${(1 / best.diopters).toFixed(2)} m`;
  }

  async #measureSharpness() {
    const canvas = new OffscreenCanvas(SHARPNESS_SIZE_PX, SHARPNESS_SIZE_PX);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    await new Promise((resolve) => this.#video.requestVideoFrameCallback(resolve));
    const { videoWidth: width, videoHeight: height } = this.#video;
    context.drawImage(this.#video, width / 4, height / 4, width / 2, height / 2, 0, 0, SHARPNESS_SIZE_PX, SHARPNESS_SIZE_PX);
    const pixels = context.getImageData(0, 0, SHARPNESS_SIZE_PX, SHARPNESS_SIZE_PX).data;
    const gray = (x, y) => {
      const i = (y * SHARPNESS_SIZE_PX + x) * 4;
      return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    };
    let energy = 0;
    for (let y = 1; y < SHARPNESS_SIZE_PX - 1; y++) {
      for (let x = 1; x < SHARPNESS_SIZE_PX - 1; x++) {
        const laplacian = 4 * gray(x, y) - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1);
        energy += laplacian * laplacian;
      }
    }
    return energy;
  }

  async #applyAndMeasure(constraints) {
    await this.track.applyConstraints({ advanced: [constraints] }).catch(console.warn);
    await new Promise((resolve) => setTimeout(resolve, CALIBRATION_SETTLE_MS));
    return this.#measurePreview();
  }

  async #measurePreview() {
    const canvas = new OffscreenCanvas(MEASURE_SIZE_PX, MEASURE_SIZE_PX);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let [red, green, blue] = [0, 0, 0];
    for (let frame = 0; frame < MEASURE_FRAMES; frame++) {
      await new Promise((resolve) => this.#video.requestVideoFrameCallback(resolve));
      context.drawImage(this.#video, 0, 0, MEASURE_SIZE_PX, MEASURE_SIZE_PX);
      const pixels = context.getImageData(0, 0, MEASURE_SIZE_PX, MEASURE_SIZE_PX).data;
      for (let i = 0; i < pixels.length; i += 4) {
        red += pixels[i];
        green += pixels[i + 1];
        blue += pixels[i + 2];
      }
    }
    const samples = MEASURE_FRAMES * MEASURE_SIZE_PX * MEASURE_SIZE_PX;
    return {
      luma: Math.round((0.299 * red + 0.587 * green + 0.114 * blue) / samples),
      redBlue: +(red / Math.max(blue, 1)).toFixed(2),
    };
  }

  #roundToStep(value, range) {
    const step = range.step || 1;
    return clamp(Math.round(value / step) * step, range.min, range.max);
  }

  async #takeFullResPhoto() {
    if (!this.#photoOptionsRejected) {
      try {
        return await this.#imageCapture.takePhoto(this.#fullResPhotoSettings());
      } catch (error) {
        console.warn('takePhoto rejected full-res options', error);
        this.#photoOptionsRejected = true;
      }
    }
    return this.#imageCapture.takePhoto().catch(() => grabPreviewFrame(this.#video));
  }

  #fullResPhotoSettings() {
    const photo = this.#photoCapabilities;
    return {
      ...(photo?.imageWidth?.max && { imageWidth: photo.imageWidth.max, imageHeight: photo.imageHeight.max }),
      ...(photo?.fillLightMode?.includes('off') && { fillLightMode: 'off' }),
    };
  }

  #announceChange() {
    this.dispatchEvent(new Event('change'));
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function grabPreviewFrame(video) {
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}

async function rotateStillToPreviewOrientation(still, previewWidth, previewHeight) {
  if (!previewWidth || !previewHeight) return still;
  const bitmap = await createImageBitmap(still);
  const sameOrientation = (bitmap.height > bitmap.width) === (previewHeight > previewWidth);
  if (sameOrientation) {
    bitmap.close();
    return still;
  }
  const canvas = new OffscreenCanvas(bitmap.height, bitmap.width);
  const context = canvas.getContext('2d');
  context.translate(bitmap.height, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}
