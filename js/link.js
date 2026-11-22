import { openEncryptedSignal, pairingsForEveryBroker, randomId } from './signal.js';
import { Wire } from './wire.js';

const LAN_ONLY_RTC_CONFIG = { iceServers: [] };
const CAMERA_INBOX = 'cam';
const REMOTE_INBOX = 'rem';
const ICE_GATHERING_TIMEOUT_MS = 4000;
const OFFER_RESEND_MS = 3000;
const GIVE_UP_AFTER_MS = 10 * 60_000;
const RETRY_DELAY_MS = 1500;
const DISCONNECT_GRACE_MS = 4000;
const MAX_PREVIEW_BITRATE = 8_000_000;

class Link extends EventTarget {
  state = 'idle';
  wire = null;

  setState(state) {
    this.state = state;
    this.dispatchEvent(new Event('state'));
  }

  announceWire(wire) {
    this.wire = wire;
    this.setState('linked');
    this.dispatchEvent(new CustomEvent('wire', { detail: wire }));
  }
}

export class CameraLink extends Link {
  #pairing;
  #stream;
  #signal;
  #peer;
  #sender;
  #offerId;
  #answered = false;
  #closed = false;
  #resendTimer;
  #retryTimer;
  #disconnectTimer;

  constructor(pairing, stream) {
    super();
    this.#pairing = pairing;
    this.#stream = stream;
  }

  async start() {
    this.setState('connecting');
    this.#signal = await openEncryptedSignal(this.#pairing, {
      inbox: CAMERA_INBOX,
      outbox: REMOTE_INBOX,
      onMessage: (message) => this.#acceptAnswer(message),
    });
    this.connect();
  }

  setStream(stream) {
    this.#stream = stream;
    this.#sender?.replaceTrack(stream.getVideoTracks()[0]).catch((error) => console.warn(error));
  }

  connect() {
    if (this.#closed) return;
    this.#stopTimers();
    this.#peer?.close();
    this.wire = null;
    this.#offerId = randomId(6);
    this.#answered = false;
    const peer = (this.#peer = new RTCPeerConnection(LAN_ONLY_RTC_CONFIG));
    this.#sender = peer.addTrack(this.#stream.getVideoTracks()[0], this.#stream);
    const wire = new Wire(peer.createDataChannel('control', { ordered: true }));
    wire.addEventListener('open', () => { if (this.#peer === peer) this.announceWire(wire); });
    wire.addEventListener('close', () => { if (this.wire === wire) this.#retry(); });
    peer.addEventListener('connectionstatechange', () => this.#watchConnection(peer));
    if (this.state !== 'reconnecting') this.setState('connecting');
    this.#sendOfferUntilAnswered(peer).catch((error) => { console.error(error); this.#retry(); });
  }

  close() {
    this.#closed = true;
    this.#stopTimers();
    this.#peer?.close();
    this.#signal?.close();
    this.wire = null;
    this.setState('idle');
  }

  async #sendOfferUntilAnswered(peer) {
    await peer.setLocalDescription();
    await iceGatheringComplete(peer);
    if (this.#peer !== peer) return;
    const offer = { type: 'offer', offerId: this.#offerId, sdp: peer.localDescription.sdp };
    const giveUpAt = Date.now() + GIVE_UP_AFTER_MS;
    const sendOffer = () => {
      if (this.#answered || this.#peer !== peer) return clearInterval(this.#resendTimer);
      if (Date.now() > giveUpAt) {
        clearInterval(this.#resendTimer);
        this.setState('no-remote');
        return;
      }
      this.#signal.send(offer);
    };
    sendOffer();
    this.#resendTimer = setInterval(sendOffer, OFFER_RESEND_MS);
  }

  async #acceptAnswer(message) {
    if (message.type !== 'answer' || message.offerId !== this.#offerId || this.#answered) return;
    this.#answered = true;
    clearInterval(this.#resendTimer);
    try {
      await this.#peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      await this.#preferSharpPreview();
    } catch (error) {
      console.error(error);
      this.#retry();
    }
  }

  async #preferSharpPreview() {
    const parameters = this.#sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = MAX_PREVIEW_BITRATE;
    parameters.degradationPreference = 'maintain-resolution';
    await this.#sender.setParameters(parameters).catch((error) => console.warn(error));
  }

  #watchConnection(peer) {
    if (this.#peer !== peer) return;
    if (peer.connectionState === 'failed') this.#retry();
    if (peer.connectionState === 'disconnected') {
      clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = setTimeout(() => {
        if (this.#peer === peer && peer.connectionState === 'disconnected') this.#retry();
      }, DISCONNECT_GRACE_MS);
    }
  }

  #retry() {
    if (this.#closed) return;
    clearTimeout(this.#retryTimer);
    this.setState('reconnecting');
    this.#retryTimer = setTimeout(() => this.connect(), RETRY_DELAY_MS);
  }

  #stopTimers() {
    clearInterval(this.#resendTimer);
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#disconnectTimer);
  }
}

export class RemoteLink extends Link {
  #signal;
  #peer;
  #offerId;
  #answer;
  pairing;

  async start(pairingToReuse) {
    this.setState('starting');
    const candidates = [pairingToReuse, ...pairingsForEveryBroker()].filter(Boolean);
    for (const pairing of candidates) {
      try {
        this.#signal = await openEncryptedSignal(pairing, {
          inbox: REMOTE_INBOX,
          outbox: CAMERA_INBOX,
          onMessage: (message) => this.#acceptOffer(message),
        });
        this.pairing = pairing;
        this.setState('waiting');
        return pairing;
      } catch (error) {
        console.warn('broker failed', error);
      }
    }
    this.setState('error');
    throw new Error('Could not reach any pairing broker (the handshake needs internet).');
  }

  async #acceptOffer(message) {
    if (message.type !== 'offer') return;
    if (message.offerId === this.#offerId) {
      if (this.#answer) this.#signal.send(this.#answer);
      return;
    }
    if (this.#peer?.connectionState === 'connected') return;
    this.#offerId = message.offerId;
    this.#answer = null;
    this.#peer?.close();
    this.wire = null;
    const peer = (this.#peer = new RTCPeerConnection(LAN_ONLY_RTC_CONFIG));
    peer.addEventListener('track', (e) => {
      if (this.#peer === peer) this.dispatchEvent(new CustomEvent('track', { detail: e.streams[0] }));
    });
    peer.addEventListener('datachannel', (e) => this.#adoptChannel(peer, e.channel));
    peer.addEventListener('connectionstatechange', () => {
      if (this.#peer === peer && peer.connectionState === 'failed') this.#dropPeer(peer);
    });
    try {
      this.setState('connecting');
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await peer.setLocalDescription();
      await iceGatheringComplete(peer);
      if (this.#peer !== peer) return;
      this.#answer = { type: 'answer', offerId: message.offerId, sdp: peer.localDescription.sdp };
      this.#signal.send(this.#answer);
    } catch (error) {
      console.error(error);
      if (this.#peer === peer) this.#dropPeer(peer);
    }
  }

  #adoptChannel(peer, channel) {
    const wire = new Wire(channel);
    const adopt = () => { if (this.#peer === peer) this.announceWire(wire); };
    if (channel.readyState === 'open') adopt();
    else wire.addEventListener('open', adopt);
    wire.addEventListener('close', () => { if (this.wire === wire) this.#dropPeer(peer); });
  }

  #dropPeer(peer) {
    peer.close();
    this.wire = null;
    this.setState('waiting');
  }
}

function iceGatheringComplete(peer) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === 'complete') return resolve();
    setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener('icegatheringstatechange', () => {
      if (peer.iceGatheringState === 'complete') resolve();
    });
  });
}
