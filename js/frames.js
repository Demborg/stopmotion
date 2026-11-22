// Ordered list of captured frames (JPEG blobs) with optional persistence sink
// and a cache of downscaled bitmaps for onion skin / playback.

const THUMB_W = 720;

export const frameName = (i) => String(i + 1).padStart(4, '0') + '.jpg';

export class FrameList extends EventTarget {
  constructor() {
    super();
    this.blobs = [];
    this.thumbs = new Map();
    this.sink = null;
    this.q = Promise.resolve();
  }
  get count() { return this.blobs.length; }

  _emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }
  _persist(fn) {
    if (!this.sink) return;
    this.q = this.q.then(fn).catch((e) => {
      console.error(e);
      this.dispatchEvent(new CustomEvent('error', { detail: e }));
    });
  }
  _drop(i) {
    const p = this.thumbs.get(i);
    this.thumbs.delete(i);
    p?.then((b) => b?.close());
  }

  load(blobs) {
    for (const i of [...this.thumbs.keys()]) this._drop(i);
    this.blobs = blobs;
    this._emit({ op: 'load' });
  }
  set(i, blob) {
    this.blobs[i] = blob;
    this._drop(i);
    this._persist(() => this.sink.put(i, blob));
    this._emit({ op: 'set', i });
  }
  add(blob) { this.set(this.count, blob); }
  truncate(n) {
    const old = this.count;
    if (n >= old) return;
    this.blobs.length = n;
    for (let i = n; i < old; i++) this._drop(i);
    this._persist(() => this.sink.truncate(n, old));
    this._emit({ op: 'trunc', n });
  }
  // Write everything to a freshly attached sink.
  flushTo(sink) {
    this.sink = sink;
    this.blobs.forEach((b, i) => b && this._persist(() => sink.put(i, b)));
    return this.q;
  }

  thumb(i) {
    const b = this.blobs[i];
    if (!b) return Promise.resolve(null);
    let p = this.thumbs.get(i);
    if (!p) {
      p = createImageBitmap(b, { resizeWidth: THUMB_W, resizeQuality: 'medium' }).catch(() => null);
      this.thumbs.set(i, p);
    }
    return p;
  }
}

// ---- IndexedDB sink (phone keeps its frames across reloads) ----------------

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function idbSink() {
  const open = indexedDB.open('stopmo', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('frames');
  const db = await req(open);
  const st = (mode) => db.transaction('frames', mode).objectStore('frames');
  return {
    async load() {
      const s = st('readonly');
      const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      const out = [];
      keys.forEach((k, j) => { out[k] = vals[j]; });
      let n = 0;
      while (out[n]) n++;
      return out.slice(0, n);
    },
    put: (i, b) => req(st('readwrite').put(b, i)),
    truncate: (n) => req(st('readwrite').delete(IDBKeyRange.lowerBound(n))),
  };
}

// ---- folder sink (laptop writes 0001.jpg... straight to disk) ----------------

export function folderSink(dir) {
  return {
    async put(i, b) {
      const fh = await dir.getFileHandle(frameName(i), { create: true });
      const w = await fh.createWritable();
      await w.write(b);
      await w.close();
    },
    async truncate(n, old) {
      for (let i = n; i < old; i++) {
        await dir.removeEntry(frameName(i)).catch(() => {});
      }
    },
  };
}
