const PREVIEW_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 } };
const JPEG_QUALITY = 0.95;
const EXPOSURE_TIME_UNITS_PER_SECOND = 10_000;
const SLOWEST_SHUTTER = EXPOSURE_TIME_UNITS_PER_SECOND / 30;
const EXPOSURE_STEPS = 4;
const WHITE_BALANCE_STEPS = 4;
const CALIBRATION_SETTLE_MS = 250;
const FOCUS_SETTLE_MS = 220;
const LUMA_TOLERANCE = 3;
const RED_BLUE_TOLERANCE = 0.02;
const MIREDS_PER_KELVIN = 1e6;
const DISPLAY_GAMMA = 2.2;
const MEASURE_SIZE_PX = 32;
const MEASURE_FRAMES = 3;
const FOCUS_COARSE_STEPS = 7;
const FOCUS_FINE_STEPS = 4;
const SHARPNESS_SIZE_PX = 128;
const DIAGNOSTIC_KEYS = [
  'focusMode', 'focusDistance', 'exposureMode', 'exposureTime', 'iso', 'exposureCompensation',
  'whiteBalanceMode', 'colorTemperature',
];

export class Camera extends EventTarget {
  stream = null;
  track = null;
  deviceId = null;
  exposureLocked = false;
  focusLocked = false;
  #video;
  #imageCapture = null;
  #photoCapabilities = null;
  #photoOptionsRejected = false;
  #exposureReport = '';
  #focusReport = '';

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
    this.exposureLocked = false;
    this.focusLocked = false;
    this.#announceChange();
    return this.stream;
  }

  async lenses() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  async setExposureLocked(locked) {
    const autoLook = locked ? await this.#measurePreview() : null;
    const modes = locked ? ['manual'] : ['continuous'];
    const whiteBalanceMode = await this.#applyFirstSupported('whiteBalanceMode', modes);
    const exposureMode = await this.#applyFirstSupported('exposureMode', modes);
    this.exposureLocked = locked && Boolean(whiteBalanceMode || exposureMode);
    this.#exposureReport = this.exposureLocked
      ? await this.#matchLookTo(autoLook, { whiteBalanceMode, exposureMode })
      : '';
    this.#announceChange();
    return this.exposureLocked;
  }

  async setFocusLocked(locked) {
    const focusMode = await this.#applyFirstSupported('focusMode', locked ? ['manual', 'single-shot'] : ['continuous']);
    this.focusLocked = locked && Boolean(focusMode);
    this.#focusReport = this.focusLocked && focusMode === 'manual' && this.capabilities.focusDistance
      ? await this.#focusOnSharpest()
      : focusMode ?? '';
    this.#announceChange();
    return this.focusLocked;
  }

  diagnostics() {
    const { capabilities, settings } = this;
    return Object.fromEntries(DIAGNOSTIC_KEYS.map((key) => [key, { supported: capabilities[key], current: settings[key] }]));
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
      this.exposureLocked && `AE locked: ${this.#exposureReport}`,
      this.focusLocked && `AF locked: ${this.#focusReport}`,
    ].filter(Boolean).join(' · ');
  }

  async #applyFirstSupported(modeKey, modes) {
    for (const mode of modes.filter((m) => this.capabilities[modeKey]?.includes(m))) {
      try {
        await this.track.applyConstraints({ advanced: [{ [modeKey]: mode }] });
        return mode;
      } catch (error) {
        console.warn('could not apply', modeKey, mode, error);
      }
    }
    return null;
  }

  async #matchLookTo(autoLook, appliedModes) {
    const report = [];
    if (appliedModes.whiteBalanceMode === 'manual' && this.capabilities.colorTemperature) {
      report.push(await this.#matchWhiteBalance(autoLook.redBlue));
    }
    if (appliedModes.exposureMode === 'manual' && this.capabilities.exposureTime) {
      report.push(await this.#matchExposure(autoLook.luma));
    }
    const lockedLook = await this.#measurePreview();
    report.push(`brightness ${autoLook.luma}→${lockedLook.luma}, red/blue ${autoLook.redBlue}→${lockedLook.redBlue}`);
    return report.join(', ');
  }

  async #matchWhiteBalance(targetRedBlue) {
    const range = this.capabilities.colorTemperature;
    const toMired = (kelvin) => MIREDS_PER_KELVIN / kelvin;
    const probe = async (mired) => {
      const kelvin = this.#roundToStep(MIREDS_PER_KELVIN / mired, range);
      const { redBlue } = await this.#applyAndMeasure({ whiteBalanceMode: 'manual', colorTemperature: kelvin });
      return { mired: toMired(kelvin), kelvin, redBlue };
    };
    const span = toMired(range.min) - toMired(range.max);
    let previous = await probe(toMired(range.max) + span / 4);
    let latest = await probe(toMired(range.max) + (3 * span) / 4);
    for (let step = 2; step < WHITE_BALANCE_STEPS && Math.abs(latest.redBlue - targetRedBlue) >= RED_BLUE_TOLERANCE; step++) {
      const slope = (latest.redBlue - previous.redBlue) / (latest.mired - previous.mired);
      if (!Number.isFinite(slope) || slope === 0) break;
      const nextMired = clamp(latest.mired + (targetRedBlue - latest.redBlue) / slope, toMired(range.max), toMired(range.min));
      [previous, latest] = [latest, await probe(nextMired)];
    }
    const best = Math.abs(previous.redBlue - targetRedBlue) < Math.abs(latest.redBlue - targetRedBlue) ? previous : latest;
    if (best !== latest) await probe(best.mired);
    return `${best.kelvin} K`;
  }

  async #matchExposure(targetLuma) {
    const timeRange = this.capabilities.exposureTime;
    const isoRange = this.capabilities.iso;
    let exposureTime = this.settings.exposureTime || SLOWEST_SHUTTER / 4;
    let iso = this.settings.iso || isoRange?.min;
    const applyExposure = () => this.#applyAndMeasure({ exposureMode: 'manual', exposureTime, ...(iso && { iso }) });
    let { luma } = await applyExposure();
    for (let step = 1; step < EXPOSURE_STEPS && Math.abs(luma - targetLuma) >= LUMA_TOLERANCE; step++) {
      const wanted = exposureTime * (targetLuma / Math.max(luma, 1)) ** DISPLAY_GAMMA;
      exposureTime = clamp(wanted, timeRange.min, Math.min(timeRange.max, SLOWEST_SHUTTER));
      if (iso && isoRange) iso = Math.round(clamp(iso * (wanted / exposureTime), isoRange.min, isoRange.max));
      ({ luma } = await applyExposure());
    }
    return `1/${Math.round(EXPOSURE_TIME_UNITS_PER_SECOND / exposureTime)} s, ISO ${iso}`;
  }

  async #focusOnSharpest() {
    const range = this.capabilities.focusDistance;
    const nearest = 1 / range.min;
    const farthest = 1 / range.max;
    const sharpnessAt = async (diopters) => {
      await this.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: 1 / diopters }] }).catch(console.warn);
      await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
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
