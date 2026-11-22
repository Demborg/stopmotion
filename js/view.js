// Live view + overlay canvas: guide image, onion skin, playback.

export class Viewer {
  constructor({ viewport, stage, video, canvas, frames }) {
    Object.assign(this, { viewport, stage, video, canvas, frames });
    this.ctx = canvas.getContext('2d');
    this.onion = 1;
    this.opacity = 0.5;
    this.guide = null;
    this.guideOpacity = 0.5;
    this.fps = 12;
    this.playing = false;
    this.hidden = false; // overlay hidden while the stage is pressed
    this.tok = 0;
    new ResizeObserver(() => this.layout()).observe(viewport);
    video.addEventListener('loadedmetadata', () => this.layout());
    video.addEventListener('resize', () => this.layout());
    frames.addEventListener('change', () => this.draw());
    stage.addEventListener('pointerdown', () => { this.hidden = true; this.draw(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      stage.addEventListener(ev, () => { if (this.hidden) { this.hidden = false; this.draw(); } });
    }
  }

  aspect() {
    const v = this.video;
    if (v.videoWidth) return [v.videoWidth, v.videoHeight];
    return this.fallbackAspect || [3, 4];
  }

  layout() {
    const [aw, ah] = this.aspect();
    const r = this.viewport.getBoundingClientRect();
    const s = Math.min(r.width / aw, r.height / ah);
    const w = Math.floor(aw * s);
    const h = Math.floor(ah * s);
    this.stage.style.width = w + 'px';
    this.stage.style.height = h + 'px';
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.draw();
  }

  cover(img, alpha) {
    const { width: cw, height: ch } = this.canvas;
    const s = Math.max(cw / img.width, ch / img.height);
    const w = img.width * s;
    const h = img.height * s;
    this.ctx.globalAlpha = alpha;
    try { this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h); } catch { /* bitmap closed */ }
  }

  async draw() {
    if (this.playing) return;
    const tok = ++this.tok;
    const count = this.frames.count;
    const n = Math.min(this.onion, count);
    const idx = [];
    for (let k = n - 1; k >= 0; k--) idx.push(count - 1 - k); // oldest first
    const bmps = await Promise.all(idx.map((i) => this.frames.thumb(i)));
    if (tok !== this.tok || this.playing) return;
    const last = bmps[bmps.length - 1];
    if (last && !this.video.videoWidth) {
      const fa = [last.width, last.height];
      if (String(fa) !== String(this.fallbackAspect)) { this.fallbackAspect = fa; this.layout(); return; }
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.hidden) {
      if (this.guide) this.cover(this.guide, this.guideOpacity);
      bmps.forEach((b, j) => {
        if (!b) return;
        const k = n - 1 - j; // 0 = newest
        this.cover(b, (this.opacity * (n - k)) / n);
      });
    }
    ctx.globalAlpha = 1;
  }

  play(on) {
    cancelAnimationFrame(this.raf);
    if (on && !this.frames.count) on = false;
    this.playing = on;
    this.canvas.classList.toggle('opaque', on);
    if (!on) { this.draw(); return false; }
    const start = performance.now();
    const loop = async (t) => {
      if (!this.playing) return;
      const i = Math.floor(((t - start) / 1000) * this.fps) % this.frames.count;
      const b = await this.frames.thumb(i);
      if (!this.playing) return;
      const ctx = this.ctx;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (b) this.cover(b, 1);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return true;
  }
}
