import { $, store, toast, showMessage, flash, setStatus, renderLockButtons } from './ui.js';
import { Camera } from './camera.js';
import { CameraLink } from './link.js';
import { pairFromUrl, pairString } from './signal.js';
import { asFrameFile, browserStorageSink } from './frames.js';

const CAPTURE_TIMEOUT_MS = 8000;
const QR_SCAN_INTERVAL_MS = 250;
const ERROR_TOAST_MS = 4000;
const LINK_STATUS = {
  idle: ['Phone only', ''],
  connecting: ['Linking…', ''],
  reconnecting: ['Reconnecting…', 'bad'],
  linked: ['Laptop linked', 'linked'],
  'no-remote': ['Laptop not found', 'bad'],
};

export async function startCameraRole({ frames, actions, stopPlayback }) {
  const camera = new Camera($('video'));
  let link = null;
  let capturing = false;
  let lockChanging = false;
  let scanning = false;
  let captureSource = store.get('source', 'photo');
  let screenWakeLock = null;

  const sink = await browserStorageSink();
  frames.load(await sink.loadContiguous());
  frames.sink = sink;

  actions.capture = capture;
  actions.undo = deleteLastFrame;
  actions.toggleExposureLock = () => toggleLock('AE', (on) => camera.setExposureLocked(on), camera.exposureLocked);
  actions.toggleFocusLock = () => toggleLock('AF', (on) => camera.setFocusLocked(on), camera.focusLocked);
  actions.onSettingsOpen = renderCameraSettings;
  bindCameraSettings();
  bindLinkControls();
  camera.addEventListener('change', () => { renderLockButtons(camera); sendState(); });
  frames.addEventListener('change', forwardFrameChange);
  document.addEventListener('visibilitychange', resumeWhenVisible);

  await startCamera(store.get('lens', null));
  renderLinkStatus();
  const pairingFromUrl = pairFromUrl(location.href);
  if (pairingFromUrl) pairWith(pairingFromUrl);

  async function startCamera(deviceId) {
    try {
      showMessage('');
      const stream = await camera.start(deviceId);
      link?.setStream(stream);
      if (deviceId) store.set('lens', deviceId);
      keepScreenAwake();
    } catch (error) {
      console.error(error);
      if (deviceId) return startCamera(null);
      showMessage(`Camera not available: ${error.message}. This page needs camera permission and HTTPS.`,
        { label: 'Retry', run: () => startCamera(null) });
    }
  }

  async function capture() {
    if (capturing || !camera.track) return;
    stopPlayback();
    capturing = true;
    $('b-shutter').classList.add('busy');
    flash();
    try {
      const still = await withTimeout(camera.capture(captureSource), CAPTURE_TIMEOUT_MS, 'camera did not respond');
      frames.add(asFrameFile(still));
    } catch (error) {
      console.error(error);
      toast('Capture failed: ' + error.message, ERROR_TOAST_MS);
    } finally {
      capturing = false;
      $('b-shutter').classList.remove('busy');
    }
  }

  function deleteLastFrame() {
    if (!frames.count) return;
    frames.truncate(frames.count - 1);
    toast(`Deleted frame ${frames.count + 1}`);
  }

  async function toggleLock(label, setLocked, currentlyLocked) {
    if (lockChanging) return;
    lockChanging = true;
    $(label === 'AE' ? 'b-ae' : 'b-af').textContent = label + '…';
    try {
      const nowLocked = await setLocked(!currentlyLocked);
      if (!currentlyLocked && !nowLocked) toast(`This camera does not allow ${label} lock from the browser`, ERROR_TOAST_MS);
    } finally {
      lockChanging = false;
      renderLockButtons(camera);
    }
  }

  async function keepScreenAwake() {
    if (document.visibilityState !== 'visible' || screenWakeLock) return;
    screenWakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    screenWakeLock?.addEventListener('release', () => { screenWakeLock = null; });
  }

  function resumeWhenVisible() {
    sendState();
    if (document.visibilityState !== 'visible') return;
    keepScreenAwake();
    if (camera.track?.readyState === 'ended') startCamera(camera.deviceId);
  }

  function bindCameraSettings() {
    $('sel-source').value = captureSource;
    $('sel-source').onchange = (e) => {
      captureSource = e.target.value;
      store.set('source', captureSource);
    };
    $('sel-lens').onchange = (e) => startCamera(e.target.value);
    $('s-ev').oninput = (e) => camera.setExposureCompensation(+e.target.value);
    $('b-clear').onclick = () => {
      if (frames.count && confirm(`Delete all ${frames.count} frames?`)) frames.truncate(0);
    };
    $('b-fs').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };
  }

  async function renderCameraSettings() {
    $('caminfo').textContent = camera.describe();
    const range = camera.capabilities.exposureCompensation;
    $('row-ev').hidden = !range;
    if (range) {
      Object.assign($('s-ev'), { min: range.min, max: range.max, step: range.step || 0.1 });
      $('s-ev').value = camera.settings.exposureCompensation ?? 0;
    }
    const lenses = await camera.lenses();
    $('sel-lens').replaceChildren(...lenses.map((lens, i) =>
      new Option(lens.label || `Camera ${i + 1}`, lens.deviceId, false, lens.deviceId === camera.deviceId)));
    $('b-unpair').hidden = !link;
  }

  function bindLinkControls() {
    $('b-pair').onclick = scanLaptopQr;
    $('b-scancancel').onclick = stopScanning;
    $('b-unpair').onclick = () => { unpair(); $('settings').close(); };
    $('b-status').onclick = () => { if (link?.state === 'no-remote') link.connect(); };
  }

  function renderLinkStatus() {
    setStatus(LINK_STATUS[link?.state ?? 'idle']);
  }

  async function pairWith(pairing) {
    if (!camera.stream) return toast('Start the camera before pairing');
    link?.close();
    history.replaceState(null, '', '#pair=' + pairString(pairing));
    link = new CameraLink(pairing, camera.stream);
    link.addEventListener('state', renderLinkStatus);
    link.addEventListener('wire', (e) => {
      e.detail.addEventListener('message', (m) => onRemoteMessage(e.detail, m.detail));
      sendState();
    });
    try {
      await link.start();
    } catch (error) {
      link.close();
      link = null;
      toast(error.message, ERROR_TOAST_MS);
    }
    renderLinkStatus();
  }

  function unpair() {
    link?.close();
    link = null;
    history.replaceState(null, '', location.pathname + location.search);
    renderLinkStatus();
  }

  async function scanLaptopQr() {
    $('settings').close();
    if (!('BarcodeDetector' in window)) {
      return toast('QR scanning is not supported here: open the laptop QR with the regular camera app', ERROR_TOAST_MS);
    }
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    scanning = true;
    $('scanbox').hidden = false;
    while (scanning) {
      const codes = await detector.detect($('video')).catch(() => []);
      const pairing = codes.map((code) => pairFromUrl(code.rawValue)).find(Boolean);
      if (pairing) {
        stopScanning();
        toast('Pairing…');
        pairWith(pairing);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, QR_SCAN_INTERVAL_MS));
    }
  }

  function stopScanning() {
    scanning = false;
    $('scanbox').hidden = true;
  }

  function sendState() {
    link?.wire?.send({
      type: 'state',
      count: frames.count,
      exposureLocked: camera.exposureLocked,
      focusLocked: camera.focusLocked,
      info: camera.describe(),
      camera: camera.diagnostics(),
      visible: document.visibilityState === 'visible',
    });
  }

  function forwardFrameChange(e) {
    const wire = link?.wire;
    if (!wire) return;
    const change = e.detail;
    if (change.op === 'set') wire.send({ type: 'frame', index: change.index }, frames.files[change.index]);
    if (change.op === 'truncate') wire.send({ type: 'truncate', count: change.count });
    sendState();
  }

  function onRemoteMessage(wire, message) {
    if (message.type === 'hello') {
      frames.files.forEach((file, index) => {
        if (message.frameIds[index] !== file.lastModified) wire.send({ type: 'frame', index }, file);
      });
      wire.send({ type: 'truncate', count: frames.count });
      sendState();
    }
    if (message.type === 'command') {
      const commands = { capture, undo: deleteLastFrame, 'lock-exposure': actions.toggleExposureLock, 'lock-focus': actions.toggleFocusLock };
      commands[message.command]?.();
    }
  }
}

function withTimeout(promise, timeoutMs, reason) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), timeoutMs));
  return Promise.race([promise, timeout]);
}
