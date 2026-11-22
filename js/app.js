import { $, store, toast } from './ui.js';
import { FrameList } from './frames.js';
import { Viewer } from './view.js';
import { makeUncompressedZip } from './zip.js';
import { pairFromUrl } from './signal.js';
import { startCameraRole } from './camera-role.js';
import { startRemoteRole } from './remote-role.js';

const ONION_MAX = 3;
const FPS_RANGE = { min: 1, max: 30 };
const ZIP_URL_LIFETIME_MS = 60_000;
const ZIP_TOAST_MS = 60_000;
const ERROR_TOAST_MS = 5000;

navigator.serviceWorker?.register('sw.js');

const role = detectRole();
const frames = new FrameList();
const viewer = new Viewer({ viewport: $('viewport'), stage: $('stage'), video: $('video'), canvas: $('overlay'), frames });
const actions = { capture() {}, undo() {}, toggleExposureLock() {}, toggleFocusLock() {}, onSettingsOpen() {} };

restoreViewSettings();
bindViewControls();
bindSettingsDialog();
bindKeyboardShortcuts();
frames.addEventListener('change', () => {
  if (!frames.count) setPlayback(false);
  renderViewControls();
});
frames.addEventListener('error', (e) => toast('Saving failed: ' + e.detail.message, ERROR_TOAST_MS));
renderViewControls();

const startRole = role === 'camera' ? startCameraRole : startRemoteRole;
startRole({ frames, viewer, actions, stopPlayback: () => setPlayback(false) });

function detectRole() {
  const isMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad/i.test(navigator.userAgent);
  const detected = pairFromUrl(location.href)
    ? 'camera'
    : new URLSearchParams(location.search).get('role') ?? store.get('role', isMobile ? 'camera' : 'remote');
  const other = detected === 'camera' ? 'remote' : 'camera';
  document.body.classList.add('role-' + detected);
  $('a-role').textContent = `Use this device as the ${other} instead`;
  $('a-role').href = '?role=' + other;
  $('a-role').onclick = () => store.set('role', other);
  return detected;
}

function restoreViewSettings() {
  viewer.onionFrames = store.get('onion', 1);
  viewer.onionOpacity = store.get('opacity', 0.5);
  viewer.guideOpacity = store.get('guideOpacity', 0.5);
  viewer.fps = store.get('fps', 12);
}

function renderViewControls() {
  $('b-onion').textContent = viewer.onionFrames ? `Onion ${viewer.onionFrames}` : 'Onion off';
  $('b-onion').classList.toggle('on', viewer.onionFrames > 0);
  $('play-label').textContent = viewer.playing ? 'Stop' : 'Play';
  $('b-play').classList.toggle('on', viewer.playing);
  $('count').textContent = frames.count;
  $('o-fps').textContent = viewer.fps;
  $('s-opacity').value = viewer.onionOpacity;
  $('s-guide').value = viewer.guideOpacity;
}

function cycleOnion() {
  viewer.onionFrames = (viewer.onionFrames + 1) % (ONION_MAX + 1);
  store.set('onion', viewer.onionFrames);
  viewer.draw();
  renderViewControls();
}

function setPlayback(playing) {
  viewer.play(playing);
  renderViewControls();
}

function changeFps(delta) {
  viewer.fps = Math.min(FPS_RANGE.max, Math.max(FPS_RANGE.min, viewer.fps + delta));
  store.set('fps', viewer.fps);
  renderViewControls();
}

async function setGuideImage(file) {
  viewer.guideImage?.close();
  viewer.guideImage = file ? await createImageBitmap(file) : null;
  viewer.draw();
}

function bindViewControls() {
  $('b-onion').onclick = cycleOnion;
  $('b-play').onclick = () => setPlayback(!viewer.playing);
  $('b-shutter').onclick = () => actions.capture();
  $('b-undo').onclick = () => actions.undo();
  $('b-ae').onclick = () => actions.toggleExposureLock();
  $('b-af').onclick = () => actions.toggleFocusLock();
  $('b-fps-down').onclick = () => changeFps(-1);
  $('b-fps-up').onclick = () => changeFps(1);
  $('s-opacity').oninput = (e) => {
    viewer.onionOpacity = +e.target.value;
    store.set('opacity', viewer.onionOpacity);
    viewer.draw();
  };
  $('s-guide').oninput = (e) => {
    viewer.guideOpacity = +e.target.value;
    store.set('guideOpacity', viewer.guideOpacity);
    viewer.draw();
  };
  $('b-guide').onclick = () => $('f-guide').click();
  $('f-guide').onchange = (e) => setGuideImage(e.target.files[0]);
  $('b-guideclear').onclick = () => setGuideImage(null);
}

function bindSettingsDialog() {
  const dialog = $('settings');
  $('b-menu').onclick = () => {
    dialog.showModal();
    actions.onSettingsOpen();
  };
  $('b-close').onclick = () => dialog.close();
  dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };
  $('b-zip').onclick = downloadZip;
}

async function downloadZip() {
  if (!frames.count) return toast('No frames yet');
  if (!frames.isComplete) return toast('Still syncing frames, try again in a moment');
  toast('Building zip…', ZIP_TOAST_MS);
  try {
    const zip = await makeUncompressedZip(frames.zipEntries);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zip);
    link.download = `stopmotion-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), ZIP_URL_LIFETIME_MS);
    toast(`Zip with ${frames.count} frames ready`);
  } catch (error) {
    toast('Zip failed: ' + error.message, ERROR_TOAST_MS);
  }
}

function bindKeyboardShortcuts() {
  const shortcuts = {
    ' ': () => actions.capture(),
    Enter: () => actions.capture(),
    Backspace: () => actions.undo(),
    Delete: () => actions.undo(),
    p: () => setPlayback(!viewer.playing),
    o: cycleOnion,
    e: () => actions.toggleExposureLock(),
    f: () => actions.toggleFocusLock(),
  };
  document.addEventListener('keydown', (e) => {
    if ($('settings').open || e.target.closest('input, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const shortcut = shortcuts[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!shortcut) return;
    e.preventDefault();
    shortcut();
  });
}
