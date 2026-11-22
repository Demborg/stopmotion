const PREVIEW_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 } };
const JPEG_QUALITY = 0.95;
const LOCKABLE_CONTROLS = [
  { mode: 'focusMode', label: 'focus', pinnedValues: ['focusDistance'] },
  { mode: 'exposureMode', label: 'exposure', pinnedValues: ['exposureTime', 'iso'] },
  { mode: 'whiteBalanceMode', label: 'white balance', pinnedValues: ['colorTemperature'] },
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
    const mode = locked ? 'manual' : 'continuous';
    const results = [];
    for (const control of LOCKABLE_CONTROLS) {
      results.push({ control, ok: await this.#applyMode(control, mode, locked) });
    }
    this.locked = locked;
    this.#lockedControls = results.filter((r) => r.ok).map((r) => r.control.label);
    this.#unlockableControls = results.filter((r) => !r.ok).map((r) => r.control.label);
    this.#announceChange();
    return this.#lockedControls.length > 0;
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
    ].filter(Boolean).join(' · ');
  }

  async #applyMode(control, mode, pinCurrentValues) {
    if (!this.capabilities[control.mode]?.includes(mode)) return false;
    const attempts = [{ [control.mode]: mode }];
    if (pinCurrentValues) attempts.unshift({ ...attempts[0], ...this.#currentValues(control.pinnedValues) });
    for (const constraints of attempts) {
      try {
        await this.track.applyConstraints({ advanced: [constraints] });
        return true;
      } catch (error) {
        console.warn('could not apply', constraints, error);
      }
    }
    return false;
  }

  #currentValues(names) {
    const { settings, capabilities } = this;
    return Object.fromEntries(names.filter((n) => settings[n] != null && capabilities[n]).map((n) => [n, settings[n]]));
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
