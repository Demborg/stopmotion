const CHUNK_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 16 * CHUNK_BYTES;
const BUFFER_LOW_BYTES = 1 << 20;

export class Wire extends EventTarget {
  #channel;
  #sendQueue = Promise.resolve();
  #incoming = null;

  constructor(channel) {
    super();
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
    channel.addEventListener('message', (e) => this.#receive(e.data));
    channel.addEventListener('open', () => this.dispatchEvent(new Event('open')));
    channel.addEventListener('close', () => this.dispatchEvent(new Event('close')));
  }

  get open() { return this.#channel.readyState === 'open'; }

  send(message, file) {
    this.#sendQueue = this.#sendQueue
      .then(() => (file ? this.#sendWithFile(message, file) : this.#sendJson(message)))
      .catch((error) => console.warn('send failed', error));
  }

  #sendJson(message) {
    if (this.open) this.#channel.send(JSON.stringify(message));
  }

  async #sendWithFile(message, file) {
    const bytes = await file.arrayBuffer();
    this.#sendJson({ ...message, file: { size: bytes.byteLength, type: file.type, lastModified: file.lastModified } });
    for (let offset = 0; offset < bytes.byteLength && this.open; offset += CHUNK_BYTES) {
      if (this.#channel.bufferedAmount > MAX_BUFFERED_BYTES) await this.#bufferDrained();
      if (this.open) this.#channel.send(bytes.slice(offset, offset + CHUNK_BYTES));
    }
  }

  #bufferDrained() {
    const done = new AbortController();
    return new Promise((resolve) => {
      for (const event of ['bufferedamountlow', 'close']) {
        this.#channel.addEventListener(event, resolve, { once: true, signal: done.signal });
      }
    }).finally(() => done.abort());
  }

  #receive(data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.file) this.#startIncomingFile(message);
      else this.#deliver(message);
      return;
    }
    if (!this.#incoming) return;
    this.#incoming.chunks.push(data);
    this.#incoming.received += data.byteLength;
    if (this.#incoming.received >= this.#incoming.message.file.size) this.#finishIncomingFile();
  }

  #startIncomingFile(message) {
    this.#incoming = { message, chunks: [], received: 0 };
    if (message.file.size === 0) this.#finishIncomingFile();
  }

  #finishIncomingFile() {
    const { message, chunks } = this.#incoming;
    this.#incoming = null;
    const { type, lastModified } = message.file;
    this.#deliver({ ...message, file: new File(chunks, 'frame.jpg', { type, lastModified }) });
  }

  #deliver(message) {
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }
}
