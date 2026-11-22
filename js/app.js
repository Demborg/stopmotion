import { FrameList, idbSink, folderSink, frameName } from './frames.js';
import { Viewer } from './view.js';
import { Camera } from './camera.js';
import { CameraLink, RemoteLink, pairFromText, pairUrl, parsePair, pairString } from './link.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('stopmo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stopmo.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---- role -------------------------------------------------------------------

const hashPair = pairFromText(location.href);
const isMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad/i.test(navigator.userAgent);
const urlRole = new URLSearchParams(location.search).get('role');
const role = hashPair ? 'camera' : urlRole || store.get('role', isMobile ? 'camera' : 'remote');
document.body.classList.add('role-' + role);
$('a-role').textContent = role === 'camera' ? 'Use this device as the remote instead' : 'Use this device as the camera instead';
$('a-role').href = '?role=' + (role === 'camera' ? 'remote' : 'camera');
$('a-role').addEventListener('click', () => store.set('role', role === 'camera' ? 'remote' : 'camera'));

// ---- shared UI ----------------------------------------------------------------

const frames = new FrameList();
const viewer = new Viewer({ viewport: $('viewport'), stage: $('stage'), video: $('video'), canvas: $('overlay'), frames });
viewer.onion = store.get('onion', 1);
viewer.opacity = store.get('opacity', 0.5);
viewer.guideOpacity = store.get('guideOpacity', 0.5);
viewer.fps = store.get('fps', 12);

let toastTimer;
function toast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function message(html) {
  const m = $('message');
  m.hidden = !html;
  if (html) m.innerHTML = html;
}
function flash() {
  const f = $('flash');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
}
function setStatus(text, cls = '') {
  const s = $('b-status');
  s.textContent = text;
  s.className = 'status ' + cls;
}

function renderView() {
  $('b-onion').textContent = viewer.onion ? `Onion ${viewer.onion}` : 'Onion off';
  $('b-onion').classList.toggle('on', viewer.onion > 0);
  $('o-onion').textContent = viewer.onion;
  $('o-fps').textContent = viewer.fps;
  $('s-opacity').value = viewer.opacity;
  $('s-guide').value = viewer.guideOpacity;
  $('b-play').firstChild.textContent = viewer.playing ? 'Stop ' : 'Play ';
  $('b-play').classList.toggle('on', viewer.playing);
  $('count').textContent = frames.count;
}
frames.addEventListener('change', renderView);
frames.addEventListener('error', (e) => toast('Saving failed: ' + e.detail.message, 5000));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function setOnion(n) { viewer.onion = clamp(n, 0, 5); store.set('onion', viewer.onion); viewer.draw(); renderView(); }
function setPlay(on) { viewer.play(on); renderView(); }

$('b-onion').onclick = () => setOnion(viewer.onion >= 3 ? 0 : viewer.onion + 1);
$('b-play').onclick = () => setPlay(!viewer.playing);
for (const b of document.querySelectorAll('[data-step]')) {
  b.onclick = () => {
    const [k, d] = b.dataset.step.split(':');
    if (k === 'onion') setOnion(viewer.onion + +d);
    if (k === 'fps') { viewer.fps = clamp(viewer.fps + +d, 1, 30); store.set('fps', viewer.fps); renderView(); }
  };
}
$('s-opacity').oninput = (e) => { viewer.opacity = +e.target.value; store.set('opacity', viewer.opacity); viewer.draw(); };
$('s-guide').oninput = (e) => { viewer.guideOpacity = +e.target.value; store.set('guideOpacity', viewer.guideOpacity); viewer.draw(); };
$('b-guide').onclick = () => $('f-guide').click();
$('f-guide').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  viewer.guide?.close?.();
  viewer.guide = await createImageBitmap(f);
  viewer.draw();
  toast('Guide image set');
};
$('b-guideclear').onclick = () => { viewer.guide?.close?.(); viewer.guide = null; viewer.draw(); };

$('b-menu').onclick = () => { $('sheet').hidden = false; onSheetOpen?.(); };
$('b-close').onclick = () => { $('sheet').hidden = true; };
$('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };

$('b-zip').onclick = async () => {
  if (!frames.count) return toast('No frames yet');
  toast('Building zip…', 60000);
  const zip = await makeZip(frames.blobs.map((blob, i) => ({ name: frameName(i), blob })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `stopmotion-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`Zip with ${frames.count} frames ready`);
};

// actions are role specific; keyboard + buttons call through this
let actions = {};
let onSheetOpen = null;
$('b-shutter').onclick = () => actions.capture?.();
$('b-undo').onclick = () => actions.undo?.();
$('b-lock').onclick = () => actions.lock?.();

document.addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === ' ' || k === 'Enter' || k === 'AudioVolumeUp' || k === 'VolumeUp') { e.preventDefault(); actions.capture?.(); }
  else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); actions.undo?.(); }
  else if (k === 'p' || k === 'P') setPlay(!viewer.playing);
  else if (k === 'o' || k === 'O') setOnion(viewer.onion >= 3 ? 0 : viewer.onion + 1);
  else if (k === 'l' || k === 'L') actions.lock?.();
  else if (k === 'Escape') $('sheet').hidden = true;
});

renderView();
if (role === 'camera') initCamera(); else initRemote();

// ---- camera (phone) -----------------------------------------------------------

async function initCamera() {
  const cam = new Camera($('video'));
  let link = null;
  let busy = false;
  let source = store.get('source', 'photo');
  $('sel-source').value = source;
  $('sel-source').onchange = (e) => { source = e.target.value; store.set('source', source); };

  const sink = await idbSink().catch((e) => { console.warn(e); return null; });
  if (sink) {
    frames.load(await sink.load().catch(() => []));
    frames.sink = sink;
  }

  // wake lock keeps the screen (and camera) on while shooting
  let wake = null;
  const keepAwake = async () => {
    if (document.visibilityState !== 'visible' || wake) return;
    try { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', keepAwake);

  async function startCam(deviceId) {
    try {
      message('');
      const stream = await cam.start(deviceId);
      link?.setStream(stream);
      keepAwake();
      if (deviceId) store.set('lens', deviceId);
    } catch (e) {
      console.error(e);
      if (deviceId) return startCam(); // saved lens gone: fall back to default
      message(`<p>Camera not available: ${e.message}</p><p class="small dim">This page needs camera permission and HTTPS.</p><button id="b-retry">Retry</button>`);
      $('b-retry').onclick = () => startCam();
    }
  }
  await startCam(store.get('lens', null));

  function sendState() {
    link?.wire?.send({ t: 'state', count: frames.count, locked: cam.locked, info: cam.describe() });
  }
  cam.addEventListener('change', () => {
    $('b-lock').classList.toggle('on', cam.locked);
    $('b-lock').textContent = cam.locked ? 'Locked' : 'AE/AF';
    sendState();
  });

  frames.addEventListener('change', (e) => {
    const w = link?.wire;
    if (!w) return;
    const d = e.detail;
    if (d.op === 'set') w.send({ t: 'frame', i: d.i }, frames.blobs[d.i]);
    else if (d.op === 'trunc') w.send({ t: 'trunc', n: d.n });
    sendState();
  });

  actions.capture = async () => {
    if (busy || !cam.track) return;
    if (viewer.playing) setPlay(false);
    busy = true;
    $('b-shutter').classList.add('busy');
    flash();
    try {
      frames.add(await cam.capture(source));
    } catch (e) {
      console.error(e);
      toast('Capture failed: ' + e.message, 4000);
    } finally {
      busy = false;
      $('b-shutter').classList.remove('busy');
    }
  };
  actions.undo = () => { if (frames.count) { frames.truncate(frames.count - 1); toast(`Deleted frame ${frames.count + 1}`); } };
  actions.lock = async () => {
    const d = await cam.setLock(!cam.locked);
    if (cam.locked && !Object.values(d).some(Boolean)) toast('This camera does not allow locking from the browser', 4000);
  };

  // clear needs a second tap
  let clearArmed = 0;
  $('b-clear').onclick = () => {
    if (Date.now() - clearArmed < 3000) {
      frames.truncate(0);
      clearArmed = 0;
      $('b-clear').textContent = 'Clear all';
      toast('All frames deleted');
    } else {
      clearArmed = Date.now();
      $('b-clear').textContent = 'Tap again to delete all';
      setTimeout(() => { $('b-clear').textContent = 'Clear all'; }, 3000);
    }
  };
  $('b-share').onclick = async () => {
    if (!frames.count) return toast('No frames yet');
    const zip = await makeZip(frames.blobs.map((blob, i) => ({ name: frameName(i), blob })));
    const file = new File([zip], 'stopmotion.zip', { type: 'application/zip' });
    if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
    else toast('Sharing files is not supported here, use Download');
  };
  $('b-fs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  onSheetOpen = async () => {
    $('caminfo').textContent = cam.describe();
    const caps = cam.caps;
    const ev = caps.exposureCompensation;
    $('row-ev').hidden = !ev;
    if (ev) {
      Object.assign($('s-ev'), { min: ev.min, max: ev.max, step: ev.step || 0.1 });
      $('s-ev').value = cam.settings.exposureCompensation ?? 0;
    }
    const devs = await cam.devices();
    $('sel-lens').innerHTML = '';
    devs.forEach((d, i) => {
      const o = new Option(d.label || `Camera ${i + 1}`, d.deviceId);
      o.selected = d.deviceId === cam.deviceId;
      $('sel-lens').add(o);
    });
    $('b-unpair').hidden = !link;
  };
  $('s-ev').oninput = (e) => cam.setExposureComp(+e.target.value);
  $('sel-lens').onchange = (e) => startCam(e.target.value);

  // ---- linking ----
  const statusText = {
    idle: ['Phone only', ''],
    connecting: ['Linking…', ''],
    reconnecting: ['Reconnecting…', 'bad'],
    linked: ['Laptop linked', 'linked'],
    'no-remote': ['Laptop not found', 'bad'],
  };
  function updateStatus() {
    const [t, c] = statusText[link?.state || 'idle'];
    setStatus(t, c);
  }
  updateStatus();

  async function pair(p) {
    link?.close();
    history.replaceState(null, '', '#pair=' + pairString(p));
    link = new CameraLink(p, cam.stream);
    link.addEventListener('state', updateStatus);
    link.addEventListener('wire', (e) => {
      const w = e.detail;
      w.addEventListener('msg', (ev) => onRemoteMsg(w, ev.detail));
      sendState();
    });
    try {
      await link.start();
    } catch (e) {
      toast(e.message, 5000);
      link = null;
      updateStatus();
    }
  }
  function unpair() {
    link?.close();
    link = null;
    history.replaceState(null, '', location.pathname + location.search);
    updateStatus();
  }
  $('b-unpair').onclick = () => { unpair(); $('sheet').hidden = true; };
  $('b-status').onclick = () => { if (link?.state === 'no-remote') link.connect(); };

  function onRemoteMsg(w, m) {
    if (m.t === 'hello') {
      // send whatever the remote is missing, then trim its extra frames
      frames.blobs.forEach((b, i) => { if (m.sizes?.[i] !== b.size) w.send({ t: 'frame', i }, b); });
      w.send({ t: 'trunc', n: frames.count });
      sendState();
    } else if (m.t === 'cmd') {
      if (m.c === 'capture') actions.capture();
      else if (m.c === 'undo') actions.undo();
      else if (m.c === 'lock') actions.lock();
    }
  }

  // scanning the laptop's QR with the same camera
  let scanning = false;
  $('b-pair').onclick = async () => {
    $('sheet').hidden = true;
    if (!('BarcodeDetector' in window)) {
      return toast('QR scanning not supported here: open the laptop QR with the regular camera app', 5000);
    }
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    scanning = true;
    $('scanbox').hidden = false;
    while (scanning) {
      try {
        const codes = await det.detect($('video'));
        const p = codes.map((c) => pairFromText(c.rawValue)).find(Boolean);
        if (p) { scanning = false; $('scanbox').hidden = true; toast('Pairing…'); pair(p); break; }
      } catch { /* video not ready */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  $('b-scancancel').onclick = () => { scanning = false; $('scanbox').hidden = true; };

  if (hashPair) pair(hashPair);
}

// ---- remote (laptop) ----------------------------------------------------------

async function initRemote() {
  const link = new RemoteLink();
  let wire = null;
  let remote = { count: 0, locked: false, info: '' };
  let pairHidden = false;
  $('b-shutter').title = 'Capture on phone (Space)';

  const statusText = {
    starting: ['Starting…', ''],
    waiting: ['Waiting for phone', ''],
    connecting: ['Linking…', ''],
    linked: ['Phone linked', 'linked'],
    error: ['No pairing broker', 'bad'],
  };
  function render() {
    const [t, c] = statusText[link.state] || [link.state, ''];
    const syncing = link.state === 'linked' && frames.count !== remote.count;
    setStatus(syncing ? `Syncing ${frames.count}/${remote.count}` : t, c);
    $('b-lock').classList.toggle('on', remote.locked);
    $('b-lock').textContent = remote.locked ? 'Locked' : 'AE/AF';
    if (link.state === 'linked') $('pairbox').hidden = true;
  }
  link.addEventListener('state', () => {
    if (link.state !== 'linked') wire = null;
    if (link.state === 'waiting' && !pairHidden) $('pairbox').hidden = false;
    render();
  });
  frames.addEventListener('change', render);

  link.addEventListener('track', (e) => {
    $('video').srcObject = e.detail;
    $('video').play().catch(() => {});
  });
  link.addEventListener('wire', (e) => {
    wire = e.detail;
    wire.addEventListener('msg', (ev) => {
      const m = ev.detail;
      if (m.t === 'state') { remote = m; render(); }
      else if (m.t === 'frame') frames.set(m.i, m.blob);
      else if (m.t === 'trunc') frames.truncate(m.n);
    });
    wire.send({ t: 'hello', sizes: frames.blobs.map((b) => b?.size ?? 0) });
  });

  const cmd = (c) => {
    if (!wire) return toast('Phone not linked');
    wire.send({ t: 'cmd', c });
    if (c === 'capture') flash();
  };
  actions.capture = () => { if (viewer.playing) setPlay(false); cmd('capture'); };
  actions.undo = () => cmd('undo');
  actions.lock = () => cmd('lock');

  onSheetOpen = () => {};

  $('b-folder').onclick = async () => {
    if (!window.showDirectoryPicker) return toast('Folder saving needs desktop Chrome; use Download zip');
    try {
      const dir = await window.showDirectoryPicker({ id: 'stopmo', mode: 'readwrite', startIn: 'downloads' });
      $('foldername').textContent = dir.name + '/';
      await frames.flushTo(folderSink(dir));
      toast(`Saving frames to ${dir.name}/`);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message);
    }
  };

  $('b-pairhide').onclick = () => { pairHidden = true; $('pairbox').hidden = true; };
  $('b-showqr').onclick = () => { pairHidden = false; $('pairbox').hidden = false; $('sheet').hidden = true; };
  $('b-status').onclick = () => { pairHidden = false; $('pairbox').hidden = link.state === 'linked'; };

  render();
  let saved = null;
  try { saved = parsePair(sessionStorage.getItem('stopmo.pair')); } catch { /* ignore */ }
  try {
    const p = await link.start(saved);
    try { sessionStorage.setItem('stopmo.pair', pairString(p)); } catch { /* ignore */ }
    const url = pairUrl(p);
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    $('pairurl').textContent = url;
    $('pairbox').hidden = false;
  } catch (e) {
    message(`<p>${e.message}</p><button id="b-retry">Retry</button>`);
    $('b-retry').onclick = () => location.reload();
  }
}
