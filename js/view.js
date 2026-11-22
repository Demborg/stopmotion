const DEFAULT_ASPECT = { width: 3, height: 4 };
const MAX_PIXEL_RATIO = 2;
const SQUARE_GUIDE_SHADE = 'rgba(0, 0, 0, 0.35)';
const SQUARE_GUIDE_LINE = 'rgba(255, 255, 255, 0.8)';

export class Viewer {
  onionFrames = 1;
  onionOpacity = 0.5;
  guideImage = null;
  guideOpacity = 0.5;
  squareGuide = false;
  fps = 12;
  playing = false;
  #viewport;
  #stage;
  #video;
  #canvas;
  #context;
  #frames;
  #frameAspect = null;
  #overlayHiddenWhilePressed = false;
  #drawGeneration = 0;
  #animationFrame;

  constructor({ viewport, stage, video, canvas, frames }) {
    this.#viewport = viewport;
    this.#stage = stage;
    this.#video = video;
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    this.#frames = frames;
    new ResizeObserver(() => this.layout()).observe(viewport);
    for (const event of ['loadedmetadata', 'resize']) video.addEventListener(event, () => this.layout());
    frames.addEventListener('change', () => this.draw());
    stage.addEventListener('pointerdown', () => this.#setOverlayHidden(true));
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
      stage.addEventListener(event, () => this.#setOverlayHidden(false));
    }
  }

  layout() {
    const { width: aspectWidth, height: aspectHeight } = this.#aspect();
    const box = this.#viewport.getBoundingClientRect();
    const scale = Math.min(box.width / aspectWidth, box.height / aspectHeight);
    const width = Math.floor(aspectWidth * scale);
    const height = Math.floor(aspectHeight * scale);
    this.#stage.style.width = width + 'px';
    this.#stage.style.height = height + 'px';
    const pixelRatio = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
    this.#canvas.width = Math.max(1, Math.round(width * pixelRatio));
    this.#canvas.height = Math.max(1, Math.round(height * pixelRatio));
    this.draw();
  }

  async draw() {
    if (this.playing) return;
    const generation = ++this.#drawGeneration;
    const count = this.#frames.count;
    const shown = Math.min(this.onionFrames, count);
    const oldestFirst = Array.from({ length: shown }, (_, k) => count - shown + k);
    const bitmaps = await Promise.all(oldestFirst.map((index) => this.#frames.downscaled(index)));
    if (generation !== this.#drawGeneration || this.playing) return;
    if (this.#adoptFrameAspect(bitmaps.at(-1))) return;
    this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    if (this.squareGuide) this.#drawSquareGuide();
    if (this.#overlayHiddenWhilePressed) return;
    if (this.guideImage) this.#drawCovering(this.guideImage, this.guideOpacity);
    bitmaps.forEach((bitmap, k) => {
      const ageFromNewest = shown - 1 - k;
      if (bitmap) this.#drawCovering(bitmap, this.onionOpacity * (shown - ageFromNewest) / shown);
    });
  }

  play(playing) {
    cancelAnimationFrame(this.#animationFrame);
    this.playing = playing && this.#frames.count > 0;
    this.#canvas.classList.toggle('opaque', this.playing);
    if (!this.playing) {
      this.draw();
      return;
    }
    const startedAt = performance.now();
    const showNextFrame = async (now) => {
      const count = this.#frames.count;
      if (!this.playing || !count) return;
      const index = Math.floor(((now - startedAt) / 1000) * this.fps) % count;
      const bitmap = await this.#frames.downscaled(index);
      if (!this.playing) return;
      this.#context.fillStyle = '#000';
      this.#context.globalAlpha = 1;
      this.#context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
      if (bitmap) this.#drawCovering(bitmap, 1);
      this.#animationFrame = requestAnimationFrame(showNextFrame);
    };
    this.#animationFrame = requestAnimationFrame(showNextFrame);
  }

  #aspect() {
    if (this.#video.videoWidth) return { width: this.#video.videoWidth, height: this.#video.videoHeight };
    return this.#frameAspect ?? DEFAULT_ASPECT;
  }

  #adoptFrameAspect(bitmap) {
    if (!bitmap || this.#video.videoWidth) return false;
    const current = this.#frameAspect;
    if (current?.width === bitmap.width && current?.height === bitmap.height) return false;
    this.#frameAspect = { width: bitmap.width, height: bitmap.height };
    this.layout();
    return true;
  }

  #setOverlayHidden(hidden) {
    if (this.#overlayHiddenWhilePressed === hidden) return;
    this.#overlayHiddenWhilePressed = hidden;
    this.draw();
  }

  #drawSquareGuide() {
    const { width, height } = this.#canvas;
    const side = Math.min(width, height);
    const left = (width - side) / 2;
    const top = (height - side) / 2;
    const context = this.#context;
    context.globalAlpha = 1;
    context.fillStyle = SQUARE_GUIDE_SHADE;
    context.fillRect(0, 0, width, top);
    context.fillRect(0, top + side, width, height - top - side);
    context.fillRect(0, top, left, side);
    context.fillRect(left + side, top, width - left - side, side);
    context.strokeStyle = SQUARE_GUIDE_LINE;
    context.lineWidth = Math.max(1, Math.round(devicePixelRatio));
    context.strokeRect(left, top, side, side);
  }

  #drawCovering(image, opacity) {
    const { width: canvasWidth, height: canvasHeight } = this.#canvas;
    const scale = Math.max(canvasWidth / image.width, canvasHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    this.#context.globalAlpha = opacity;
    try {
      this.#context.drawImage(image, (canvasWidth - width) / 2, (canvasHeight - height) / 2, width, height);
    } catch (bitmapAlreadyClosed) {
      return;
    }
  }
}
