// Phone camera: preview stream, 3A lock (exposure / focus / white balance)
// and full-resolution stills via the Image Capture API.

const LOCK_KEYS = [
  // [mode key, value keys to pin while locked]
  ['focusMode', ['focusDistance']],
  ['exposureMode', ['exposureTime', 'iso']],
  ['whiteBalanceMode', ['colorTemperature']],
];

export class Camera extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.stream = null;
    this.track = null;
    this.ic = null;
    this.photoCaps = null;
    this.locked = false;
    this.lockDetail = {};
  }
  emit(type) { this.dispatchEvent(new Event(type)); }

  async start(deviceId) {
    this.stream?.getTracks().forEach((t) => t.stop());
    const size = { width: { ideal: 1920 }, height: { ideal: 1440 } };
    const video = deviceId
      ? { deviceId: { exact: deviceId }, ...size }
      : { facingMode: { ideal: 'environment' }, ...size };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.deviceId = this.track.getSettings().deviceId;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.ic = 'ImageCapture' in window ? new ImageCapture(this.track) : null;
    this.photoCaps = null;
    if (this.ic) {
      try { this.photoCaps = await this.ic.getPhotoCapabilities(); } catch (e) { console.warn(e); }
    }
    this.locked = false;
    this.lockDetail = {};
    this.emit('change');
    return this.stream;
  }

  async devices() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }
  get caps() { try { return this.track?.getCapabilities?.() || {}; } catch { return {}; } }
  get settings() { try { return this.track?.getSettings() || {}; } catch { return {}; } }

  // Lock = switch each supported 3A mode to 'manual', pinning the current values
  // where the browser reports them. Unlock = back to 'continuous'.
  async setLock(on) {
    const caps = this.caps;
    const cur = this.settings;
    const detail = {};
    for (const [k, valueKeys] of LOCK_KEYS) {
      const mode = on ? 'manual' : 'continuous';
      if (!caps[k]?.includes(mode)) { detail[k] = false; continue; }
      const pinned = { [k]: mode };
      if (on) for (const v of valueKeys) if (cur[v] != null && caps[v]) pinned[v] = cur[v];
      try {
        await this.track.applyConstraints({ advanced: [pinned] });
        detail[k] = true;
      } catch (e) {
        try {
          await this.track.applyConstraints({ advanced: [{ [k]: mode }] });
          detail[k] = true;
        } catch (e2) {
          console.warn('lock', k, e2);
          detail[k] = false;
        }
      }
    }
    this.locked = on;
    this.lockDetail = detail;
    this.emit('change');
    return detail;
  }

  async setExposureComp(v) {
    try { await this.track.applyConstraints({ advanced: [{ exposureCompensation: v }] }); } catch (e) { console.warn(e); }
  }

  // source: 'photo' (full sensor still) or 'frame' (grab from the preview stream)
  async capture(source) {
    let blob;
    if (source !== 'frame' && this.ic) {
      const pc = this.photoCaps;
      const s = {};
      if (pc?.imageWidth?.max) { s.imageWidth = pc.imageWidth.max; s.imageHeight = pc.imageHeight.max; }
      if (pc?.fillLightMode?.includes('off')) s.fillLightMode = 'off';
      try {
        blob = await this.ic.takePhoto(this.photoOptionsFailed ? undefined : s);
      } catch (e) {
        console.warn('takePhoto failed, retrying', e);
        if (!this.photoOptionsFailed) {
          this.photoOptionsFailed = true;
          try { blob = await this.ic.takePhoto(); } catch (e2) { console.warn(e2); }
        }
        if (!blob) blob = await grab(this.video);
      }
    } else {
      blob = await grab(this.video);
    }
    return matchOrientation(blob, this.video.videoWidth, this.video.videoHeight);
  }

  describe() {
    const s = this.settings;
    const parts = [];
    if (s.width) parts.push(`preview ${s.width}×${s.height}`);
    const pc = this.photoCaps;
    if (pc?.imageWidth?.max) parts.push(`photo ${pc.imageWidth.max}×${pc.imageHeight.max}`);
    if (!this.ic) parts.push('no Image Capture API (using preview frames)');
    if (this.locked) {
      const names = { focusMode: 'focus', exposureMode: 'exposure', whiteBalanceMode: 'white balance' };
      const ok = Object.entries(this.lockDetail).filter(([, v]) => v).map(([k]) => names[k]);
      const bad = Object.entries(this.lockDetail).filter(([, v]) => !v).map(([k]) => names[k]);
      if (ok.length) parts.push('locked: ' + ok.join(', '));
      if (bad.length) parts.push('not lockable: ' + bad.join(', '));
    }
    return parts.join(' · ');
  }
}

async function grab(video) {
  const c = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  c.getContext('2d').drawImage(video, 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

// Some devices return stills in sensor orientation; rotate to match the preview.
async function matchOrientation(blob, vw, vh) {
  if (!vw || !vh) return blob;
  const bmp = await createImageBitmap(blob);
  if ((bmp.height > bmp.width) === (vh > vw)) { bmp.close(); return blob; }
  const c = new OffscreenCanvas(bmp.height, bmp.width);
  const ctx = c.getContext('2d');
  ctx.translate(bmp.height, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}
