const PREVIEW_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 } };
const JPEG_QUALITY = 0.95;
const LONGEST_SHUTTER = 10_000;

export class Camera extends EventTarget {
  stream = null;
  track = null;
  deviceId = null;
  controls = null;
  #video;
  #imageCapture = null;
  #photoCapabilities = null;
  #photoOptionsRejected = false;
  #wantedControls = null;
  #applyingControls = false;

  constructor(video) {
    super();
    this.#video = video;
  }

  get capabilities() { return this.track?.getCapabilities() ?? {}; }
  get settings() { return this.track?.getSettings() ?? {}; }

  get controlRanges() {
    const capabilities = this.capabilities;
    const manualRange = (modeKey, valueKey, maxLimit = Infinity) => {
      const range = capabilities[valueKey];
      if (!capabilities[modeKey]?.includes('manual') || !range) return null;
      return { min: range.min, max: Math.min(range.max, maxLimit), step: range.step };
    };
    return {
      focusDistance: manualRange('focusMode', 'focusDistance'),
      exposureTime: manualRange('exposureMode', 'exposureTime', LONGEST_SHUTTER),
      iso: manualRange('exposureMode', 'iso'),
      colorTemperature: manualRange('whiteBalanceMode', 'colorTemperature'),
      zoom: capabilities.zoom ? { min: capabilities.zoom.min, max: capabilities.zoom.max, step: capabilities.zoom.step } : null,
    };
  }

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
    if (this.controls) await this.setControls(this.controls);
    this.#announceChange();
    return this.stream;
  }

  async lenses() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  async setControls(controls) {
    this.#wantedControls = controls;
    if (this.#applyingControls) return;
    this.#applyingControls = true;
    while (this.#wantedControls) {
      const next = this.#wantedControls;
      this.#wantedControls = null;
      await this.#applyControls(next);
      this.controls = next;
    }
    this.#applyingControls = false;
    this.#announceChange();
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
    ].filter(Boolean).join(' · ');
  }

  async #applyControls({ focus, exposure, whiteBalance, zoom }) {
    const ranges = this.controlRanges;
    const within = (value, range) => Math.min(range.max, Math.max(range.min, value));
    const constraintSets = [];
    if (ranges.focusDistance) {
      constraintSets.push(focus.manual
        ? { focusMode: 'manual', focusDistance: within(focus.metres, ranges.focusDistance) }
        : { focusMode: 'continuous' });
    }
    if (ranges.exposureTime) {
      constraintSets.push(exposure.manual
        ? { exposureMode: 'manual', exposureTime: within(exposure.time, ranges.exposureTime), ...(ranges.iso && { iso: within(exposure.iso, ranges.iso) }) }
        : { exposureMode: 'continuous' });
    }
    if (ranges.colorTemperature) {
      constraintSets.push(whiteBalance.manual
        ? { whiteBalanceMode: 'manual', colorTemperature: within(whiteBalance.kelvin, ranges.colorTemperature) }
        : { whiteBalanceMode: 'continuous' });
    }
    if (ranges.zoom) constraintSets.push({ zoom: within(zoom.level, ranges.zoom) });
    for (const constraints of constraintSets) {
      await this.track.applyConstraints({ advanced: [constraints] }).catch((error) => console.warn(constraints, error));
    }
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
