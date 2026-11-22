import mqtt from '../vendor/mqtt.esm.js';

const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const ROOM_BYTES = 9;
const KEY_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const BROKER_CONNECT_TIMEOUT_MS = 8000;
const BROKER_RECONNECT_MS = 2000;
const MAX_MESSAGE_AGE_MS = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64Url = (bytes) => bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
const fromBase64Url = (text) => Uint8Array.fromBase64(text, { alphabet: 'base64url' });

export const randomId = (bytes) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export const pairingsForEveryBroker = () =>
  BROKER_URLS.map((_, brokerIndex) => ({ brokerIndex, room: randomId(ROOM_BYTES), key: randomId(KEY_BYTES) }));

export const pairString = (pairing) => `${pairing.brokerIndex}.${pairing.room}.${pairing.key}`;

export function parsePairString(text) {
  const match = /^(\d)\.([\w-]{12})\.([\w-]{22})$/.exec(text ?? '');
  if (!match || +match[1] >= BROKER_URLS.length) return null;
  return { brokerIndex: +match[1], room: match[2], key: match[3] };
}

export function pairUrl(pairing) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = 'pair=' + pairString(pairing);
  return url.href;
}

export function pairFromUrl(text) {
  if (!URL.canParse(text)) return null;
  const match = /[#&]pair=([\w.-]+)/.exec(new URL(text).hash);
  return match && parsePairString(match[1]);
}

export async function openEncryptedSignal(pairing, { inbox, outbox, onMessage }) {
  const key = await crypto.subtle.importKey('raw', fromBase64Url(pairing.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const inboxTopic = `stopmo/v1/${pairing.room}/${inbox}`;
  const outboxTopic = `stopmo/v1/${pairing.room}/${outbox}`;
  const client = await connectToBroker(BROKER_URLS[pairing.brokerIndex]);
  client.subscribe(inboxTopic);
  client.on('message', async (topic, payload) => {
    if (topic !== inboxTopic) return;
    const message = await decrypt(key, topic, new Uint8Array(payload)).catch(() => null);
    if (message && Math.abs(Date.now() - message.sentAt) < MAX_MESSAGE_AGE_MS) onMessage(message);
  });
  return {
    async send(message) {
      client.publish(outboxTopic, await encrypt(key, outboxTopic, { ...message, sentAt: Date.now() }));
    },
    close() { client.end(true); },
  };
}

async function connectToBroker(url) {
  const client = mqtt.connect(url, {
    clientId: 'stopmo_' + randomId(6),
    connectTimeout: BROKER_CONNECT_TIMEOUT_MS,
    reconnectPeriod: BROKER_RECONNECT_MS,
  });
  try {
    await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Pairing broker unreachable')), BROKER_CONNECT_TIMEOUT_MS);
      client.once('connect', resolve);
    });
    return client;
  } catch (error) {
    client.end(true);
    throw error;
  }
}

async function encrypt(key, topic, message) {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(topic) },
    key, encoder.encode(JSON.stringify(message)));
  const payload = new Uint8Array(AES_GCM_IV_BYTES + ciphertext.byteLength);
  payload.set(iv);
  payload.set(new Uint8Array(ciphertext), AES_GCM_IV_BYTES);
  return payload;
}

async function decrypt(key, topic, payload) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.subarray(0, AES_GCM_IV_BYTES), additionalData: encoder.encode(topic) },
    key, payload.subarray(AES_GCM_IV_BYTES));
  return JSON.parse(decoder.decode(plaintext));
}
