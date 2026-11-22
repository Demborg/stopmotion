const DOWNSCALED_WIDTH_PX = 720;
const FRAME_FILE_PATTERN = /^(\d{4})\.jpg$/;

export const frameName = (index) => String(index + 1).padStart(4, '0') + '.jpg';

export const asFrameFile = (blob) =>
  new File([blob], 'frame.jpg', { type: 'image/jpeg', lastModified: Date.now() });

export class FrameList extends EventTarget {
  files = [];
  sink = null;
  #downscaled = new Map();
  #pendingWrites = Promise.resolve();

  get count() { return this.files.length; }
  get isComplete() { return Array.from(this.files).every(Boolean); }
  get ids() { return Array.from(this.files, (file) => file?.lastModified ?? null); }
  get zipEntries() { return this.files.map((file, index) => ({ name: frameName(index), file })); }

  load(files) {
    for (const index of this.#downscaled.keys()) this.#forgetDownscaled(index);
    this.files = files;
    this.#announce({ op: 'load' });
  }

  set(index, file) {
    this.files[index] = file;
    this.#forgetDownscaled(index);
    this.#queueWrite((sink) => sink.put(index, file));
    this.#announce({ op: 'set', index });
  }

  add(file) { this.set(this.count, file); }

  truncate(count) {
    const previousCount = this.count;
    if (count >= previousCount) return;
    this.files.length = count;
    for (let index = count; index < previousCount; index++) this.#forgetDownscaled(index);
    this.#queueWrite((sink) => sink.truncate(count));
    this.#announce({ op: 'truncate', count });
  }

  attachSink(sink) {
    this.sink = sink;
    this.files.forEach((file, index) => this.#queueWrite((s) => s.put(index, file)));
    this.#queueWrite((s) => s.truncate(this.count));
    return this.#pendingWrites;
  }

  downscaled(index) {
    const file = this.files[index];
    if (!file) return Promise.resolve(null);
    if (!this.#downscaled.has(index)) {
      const bitmap = createImageBitmap(file, { resizeWidth: DOWNSCALED_WIDTH_PX, resizeQuality: 'medium' }).catch(() => null);
      this.#downscaled.set(index, bitmap);
    }
    return this.#downscaled.get(index);
  }

  #announce(change) {
    this.dispatchEvent(new CustomEvent('change', { detail: change }));
  }

  #queueWrite(write) {
    if (!this.sink) return;
    const sink = this.sink;
    this.#pendingWrites = this.#pendingWrites.then(() => write(sink)).catch((error) => {
      console.error(error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    });
  }

  #forgetDownscaled(index) {
    this.#downscaled.get(index)?.then((bitmap) => bitmap?.close());
    this.#downscaled.delete(index);
  }
}

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function browserStorageSink() {
  const opening = indexedDB.open('stopmo', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('frames');
  const db = await settle(opening);
  const frameStore = (mode) => db.transaction('frames', mode).objectStore('frames');
  return {
    async loadContiguous() {
      const store = frameStore('readonly');
      const [keys, files] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
      const byIndex = [];
      keys.forEach((key, i) => { byIndex[key] = files[i]; });
      const firstGap = Array.from(byIndex).findIndex((file) => !file);
      return firstGap === -1 ? byIndex : byIndex.slice(0, firstGap);
    },
    put: (index, file) => settle(frameStore('readwrite').put(file, index)),
    truncate: (count) => settle(frameStore('readwrite').delete(IDBKeyRange.lowerBound(count))),
  };
}

export function folderSink(directory) {
  return {
    async put(index, file) {
      const handle = await directory.getFileHandle(frameName(index), { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
    },
    async truncate(count) {
      const surplus = [];
      for await (const name of directory.keys()) {
        const number = FRAME_FILE_PATTERN.exec(name)?.[1];
        if (number && +number > count) surplus.push(name);
      }
      for (const name of surplus) await directory.removeEntry(name);
    },
  };
}
