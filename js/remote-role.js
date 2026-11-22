import { $, toast, showMessage, flash, setStatus } from './ui.js';
import { RemoteLink } from './link.js';
import { pairString, parsePairString, pairUrl } from './signal.js';
import { folderSink } from './frames.js';

const QR_CELL_PX = 6;
const LINK_STATUS = {
  idle: ['Starting…', ''],
  starting: ['Starting…', ''],
  waiting: ['Waiting for phone', ''],
  connecting: ['Linking…', ''],
  linked: ['Phone linked', 'linked'],
  error: ['No pairing broker', 'bad'],
};

export async function startRemoteRole({ frames, actions, stopPlayback }) {
  const link = new RemoteLink();
  let phone = { count: 0, locked: false, visible: true };
  let qrDismissed = false;

  actions.capture = () => { stopPlayback(); sendCommand('capture'); };
  actions.undo = () => sendCommand('undo');
  actions.toggleLock = () => sendCommand('lock');
  $('b-shutter').title = 'Capture on phone (Space)';
  bindRemoteSettings();

  link.addEventListener('state', () => {
    if (link.state === 'waiting' && !qrDismissed) $('pairbox').hidden = false;
    if (link.state === 'linked') $('pairbox').hidden = true;
    render();
  });
  link.addEventListener('track', (e) => {
    $('video').srcObject = e.detail;
    $('video').play().catch(() => {});
  });
  link.addEventListener('wire', (e) => {
    e.detail.addEventListener('message', (m) => onPhoneMessage(m.detail));
    e.detail.send({ type: 'hello', frameIds: frames.ids });
  });
  frames.addEventListener('change', render);
  render();

  try {
    const pairing = await link.start(parsePairString(sessionStorage.getItem('stopmo.pair')));
    sessionStorage.setItem('stopmo.pair', pairString(pairing));
    showPairingQr(pairUrl(pairing));
  } catch (error) {
    showMessage(error.message, { label: 'Retry', run: () => location.reload() });
  }

  function render() {
    setStatus(statusFor());
    $('b-lock').classList.toggle('on', phone.locked);
    $('b-lock').textContent = phone.locked ? 'Locked' : 'AE/AF';
  }

  function statusFor() {
    if (link.state !== 'linked') return LINK_STATUS[link.state];
    if (frames.count !== phone.count || !frames.isComplete) return [`Syncing ${frames.count}/${phone.count}`, ''];
    if (!phone.visible) return ['Phone screen is off', 'bad'];
    return LINK_STATUS.linked;
  }

  function onPhoneMessage(message) {
    if (message.type === 'state') {
      phone = message;
      render();
    }
    if (message.type === 'frame') frames.set(message.index, message.file);
    if (message.type === 'truncate') frames.truncate(message.count);
  }

  function sendCommand(command) {
    if (!link.wire) return toast('Phone not linked');
    link.wire.send({ type: 'command', command });
    if (command === 'capture') flash();
  }

  function showPairingQr(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: QR_CELL_PX, margin: 0, scalable: true });
    $('pairurl').textContent = url;
    $('pairbox').hidden = link.state === 'linked';
  }

  function bindRemoteSettings() {
    $('b-folder').onclick = chooseFolder;
    $('b-pairhide').onclick = () => { qrDismissed = true; $('pairbox').hidden = true; };
    $('b-showqr').onclick = () => { qrDismissed = false; $('pairbox').hidden = false; $('settings').close(); };
    $('b-status').onclick = () => { qrDismissed = false; $('pairbox').hidden = link.state === 'linked'; };
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) return toast('Saving to a folder needs desktop Chrome; use Download zip');
    try {
      const directory = await showDirectoryPicker({ id: 'stopmo', mode: 'readwrite', startIn: 'downloads' });
      $('foldername').textContent = directory.name + '/';
      await frames.attachSink(folderSink(directory));
      toast(`Saving frames to ${directory.name}/`);
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message);
    }
  }
}
