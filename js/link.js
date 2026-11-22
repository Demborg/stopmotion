// Pairing + transport.
//
// Handshake: the remote (laptop) shows a QR with a room id and a random AES key.
// The camera (phone) scans it, and both sides exchange WebRTC offer/answer through
// a public MQTT broker, encrypted with that key (the broker only relays ciphertext).
// After that everything (preview video, commands, full-res frames) goes peer-to-peer
// over the LAN. No STUN/TURN servers are configured, so traffic can never be relayed.

import mqtt from '../vendor/mqtt.esm.js';

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const RTC_CONFIG = { iceServers: [] };
const CHUNK = 64 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---- pairing strings --------------------------------------------------------

export function parsePair(s) {
  const m = /^(\d)\.([\w-]{12})\.([\w-]{22})$/.exec(s || '');
  return m && +m[1] < BROKERS.length ? { b: +m[1], room: m[2], key: m[3] } : null;
}
export const pairString = (p) => `${p.b}.${p.room}.${p.key}`;
export function pairUrl(p) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = 'pair=' + pairString(p);
  return u.href;
}
export function pairFromText(text) {
  try {
    const m = /[#&]pair=([\w.-]+)/.exec(new URL(text).hash);
    return m && parsePair(m[1]);
  } catch {
    return null;
  }
}

// ---- encrypted signalling over MQTT ----------------------------------------

async function openSignal(pair, inbox, outbox, onMsg) {
  const key = await crypto.subtle.importKey('raw', unb64u(pair.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const base = `stopmo/v1/${pair.room}/`;
  const client = mqtt.connect(BROKERS[pair.b], {
    clientId: 'stopmo_' + b64u(rand(6)),
    clean: true,
    connectTimeout: 6000,
    reconnectPeriod: 2000,
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Pairing broker unreachable')), 8000);
      client.once('connect', () => { clearTimeout(t); resolve(); });
    });
  } catch (e) {
    client.end(true);
    throw e;
  }
  client.subscribe(base + inbox);
  client.on('message', async (topic, payload) => {
    if (topic !== base + inbox) return;
    try {
      const u8 = new Uint8Array(payload);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: u8.subarray(0, 12), additionalData: enc.encode(topic) },
        key, u8.subarray(12));
      onMsg(JSON.parse(dec.decode(pt)));
    } catch (e) {
      console.warn('Ignoring undecryptable signal', e);
    }
  });
  return {
    async send(obj) {
      const iv = rand(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(base + outbox) },
        key, enc.encode(JSON.stringify(obj))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      client.publish(base + outbox, out);
    },
    close() { client.end(true); },
  };
}

function waitIce(pc, ms = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

// ---- data channel wire: JSON messages, optionally followed by a binary blob --

export class Wire extends EventTarget {
  constructor(dc) {
    super();
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    this.q = Promise.resolve();
    this.rx = null;
    dc.addEventListener('message', (e) => this.onData(e.data));
    dc.addEventListener('open', () => this.emit('open'));
    dc.addEventListener('close', () => this.emit('close'));
  }
  get open() { return this.dc.readyState === 'open'; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  send(obj, blob) {
    this.q = this.q.then(() => this._send(obj, blob)).catch((e) => console.warn('send failed', e));
    return this.q;
  }
  async _send(obj, blob) {
    if (!this.open) return;
    if (!blob) { this.dc.send(JSON.stringify(obj)); return; }
    const buf = await blob.arrayBuffer();
    if (!this.open) return;
    this.dc.send(JSON.stringify({ ...obj, size: buf.byteLength, type: blob.type }));
    for (let o = 0; o < buf.byteLength; o += CHUNK) {
      if (!this.open) return;
      if (this.dc.bufferedAmount > 16 * CHUNK) {
        await new Promise((r) => {
          this.dc.addEventListener('bufferedamountlow', r, { once: true });
          this.dc.addEventListener('close', r, { once: true });
        });
        if (!this.open) return;
      }
      this.dc.send(buf.slice(o, o + CHUNK));
    }
  }

  onData(d) {
    if (typeof d === 'string') {
      const m = JSON.parse(d);
      if (m.size != null) {
        this.rx = { m, parts: [], got: 0 };
        if (m.size === 0) this.finishRx();
      } else {
        this.emit('msg', m);
      }
      return;
    }
    if (!this.rx) return;
    this.rx.parts.push(d);
    this.rx.got += d.byteLength;
    if (this.rx.got >= this.rx.m.size) this.finishRx();
  }
  finishRx() {
    const { m, parts } = this.rx;
    this.rx = null;
    this.emit('msg', { ...m, blob: new Blob(parts, { type: m.type || 'image/jpeg' }) });
  }
}

// ---- camera side (phone): offers, sends preview video ------------------------

export class CameraLink extends EventTarget {
  constructor(pair, stream) {
    super();
    this.pair = pair;
    this.stream = stream;
    this.state = 'idle';
    this.wire = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { console.log('[link]', s); this.state = s; this.emit('state', s); }

  async start() {
    this.setState('connecting');
    this.sig = await openSignal(this.pair, 'cam', 'rem', (m) => this.onSignal(m));
    this.connect();
  }

  setStream(stream) {
    this.stream = stream;
    this.sender?.replaceTrack(stream.getVideoTracks()[0]).catch((e) => console.warn(e));
  }

  connect() {
    if (this.closed) return;
    clearInterval(this.resend);
    this.pc?.close();
    this.wire = null;
    const sid = b64u(rand(6));
    this.sid = sid;
    this.answered = false;
    const pc = (this.pc = new RTCPeerConnection(RTC_CONFIG));
    this.sender = pc.addTrack(this.stream.getVideoTracks()[0], this.stream);
    const wire = new Wire(pc.createDataChannel('ctl', { ordered: true }));
    wire.addEventListener('open', () => {
      if (this.pc !== pc) return;
      this.wire = wire;
      this.setState('linked');
      this.emit('wire', wire);
    });
    wire.addEventListener('close', () => {
      if (this.wire === wire) { this.wire = null; this.retry(); }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'failed') this.retry();
      else if (s === 'disconnected') {
        clearTimeout(this.dt);
        this.dt = setTimeout(() => {
          if (this.pc === pc && pc.connectionState === 'disconnected') this.retry();
        }, 4000);
      }
    });
    if (this.state !== 'reconnecting') this.setState('connecting');

    (async () => {
      await pc.setLocalDescription();
      await waitIce(pc);
      if (this.pc !== pc) return;
      const msg = { t: 'offer', sid, sdp: pc.localDescription.sdp };
      let n = 0;
      const tick = () => {
        if (this.answered || this.pc !== pc) return clearInterval(this.resend);
        if (++n > 200) { // ~10 minutes
          clearInterval(this.resend);
          this.setState('no-remote');
          return;
        }
        this.sig.send(msg);
      };
      tick();
      this.resend = setInterval(tick, 3000);
    })().catch((e) => { console.error(e); this.retry(); });
  }

  retry() {
    if (this.closed) return;
    clearTimeout(this.rt);
    this.setState('reconnecting');
    this.rt = setTimeout(() => this.connect(), 1500);
  }

  async onSignal(m) {
    if (m.t !== 'answer' || m.sid !== this.sid || this.answered) return;
    this.answered = true;
    clearInterval(this.resend);
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      const p = this.sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 8_000_000;
      p.degradationPreference = 'maintain-resolution';
      await this.sender.setParameters(p).catch((e) => console.warn(e));
    } catch (e) {
      console.error(e);
      this.retry();
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.resend);
    clearTimeout(this.rt);
    clearTimeout(this.dt);
    this.pc?.close();
    this.sig?.close();
    this.wire = null;
    this.setState('idle');
  }
}

// ---- remote side (laptop): listens, answers, receives preview video -----------

export class RemoteLink extends EventTarget {
  constructor() {
    super();
    this.state = 'starting';
    this.wire = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { console.log('[link]', s); this.state = s; this.emit('state', s); }

  // Reuses `saved` (so a page reload keeps the same QR) when its broker is reachable.
  async start(saved) {
    const candidates = [];
    if (saved) candidates.push(saved);
    for (let b = 0; b < BROKERS.length; b++) {
      candidates.push({ b, room: b64u(rand(9)), key: b64u(rand(16)) });
    }
    for (const p of candidates) {
      try {
        this.sig = await openSignal(p, 'rem', 'cam', (m) => this.onSignal(m));
        this.pair = p;
        this.setState('waiting');
        return p;
      } catch (e) {
        console.warn('broker failed', BROKERS[p.b], e);
      }
    }
    this.setState('error');
    throw new Error('Could not reach any pairing broker (needs internet for the handshake).');
  }

  async onSignal(m) {
    if (m.t !== 'offer') return;
    if (m.sid === this.sid) {
      if (this.answer) this.sig.send(this.answer);
      return;
    }
    this.sid = m.sid;
    this.answer = null;
    this.pc?.close();
    this.wire = null;
    const pc = (this.pc = new RTCPeerConnection(RTC_CONFIG));
    pc.addEventListener('track', (e) => {
      if (this.pc === pc) this.emit('track', e.streams[0] || new MediaStream([e.track]));
    });
    pc.addEventListener('datachannel', (e) => {
      const w = new Wire(e.channel);
      const opened = () => {
        if (this.pc !== pc) return;
        this.wire = w;
        this.setState('linked');
        this.emit('wire', w);
      };
      if (e.channel.readyState === 'open') opened();
      else w.addEventListener('open', opened);
      w.addEventListener('close', () => {
        if (this.wire === w) { this.wire = null; this.setState('waiting'); }
      });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc === pc && pc.connectionState === 'failed') {
        this.wire = null;
        this.setState('waiting');
      }
    });
    try {
      this.setState('connecting');
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription();
      await waitIce(pc);
      if (this.pc !== pc) return;
      this.answer = { t: 'answer', sid: m.sid, sdp: pc.localDescription.sdp };
      this.sig.send(this.answer);
    } catch (e) {
      console.error(e);
      this.setState('waiting');
    }
  }
}
