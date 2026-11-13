// Sending push notifications, with nothing but WebCrypto + fetch (runs in Deno
// on the server and in Node for the tests).
//
//   Web Push (browsers, the website / home-screen app): RFC 8291 message
//   encryption (aes128gcm) + RFC 8292 VAPID sign-in.
//   FCM HTTP v1 (the Android app, later iPhone through Firebase): a Google
//   service account signs a token request.
//
// Each sender returns { ok, gone } — gone = the device unsubscribed, so the
// stored token should be deleted.

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ── Web Push ───────────────────────────────────────────────────────────────

// Encrypts `payload` (Uint8Array) for a browser subscription's keys.
// Returns the request body (RFC 8188 header + one record).
/** @param {Uint8Array} payload @param {string} p256dhB64 @param {string} authB64 @param {{ salt?: Uint8Array, serverKeys?: CryptoKeyPair }} [opts] */
export async function encryptWebPush(payload, p256dhB64, authB64, { salt, serverKeys } = {}) {
  const uaPublic = unb64url(p256dhB64);
  const authSecret = unb64url(authB64);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const as = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// VAPID: the server's key, as a JWK { kty, crv, x, y, d }
const vapidKeyCache = new Map();
export async function vapidAuthHeader(endpoint, jwk, subject) {
  let key = vapidKeyCache.get(jwk.d);
  if (!key) {
    key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    vapidKeyCache.set(jwk.d, key);
  }
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  const pub = concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${b64url(pub)}`;
}

// subscription: the browser's PushSubscription JSON { endpoint, keys: { p256dh, auth } }
// message: { title, body, tag, url, ... } (sent as JSON to the service worker)
/** @param {any} subscription @param {Record<string, any>} message @param {{ vapidJwk: any, subject: string, ttl?: number, topic?: string }} opts */
export async function sendWebPush(subscription, message, { vapidJwk, subject, ttl = 120, topic }) {
  const body = await encryptWebPush(enc.encode(JSON.stringify(message)), subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: 'high',
    Authorization: await vapidAuthHeader(subscription.endpoint, vapidJwk, subject),
  };
  // Topic: a newer message with the same topic replaces an undelivered one
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  if (res.ok) return { ok: true, gone: false };
  const gone = res.status === 404 || res.status === 410;
  return { ok: false, gone, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
}

// ── FCM HTTP v1 ────────────────────────────────────────────────────────────

function pemToDer(pem) {
  return unb64url(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
}

let fcmToken = null; // { value, exp, email }
async function fcmAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.email === sa.client_email && fcmToken.exp - 300 > now) return fcmToken.value;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const claims = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri, iat: now, exp: now + 3600,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claims}`));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`FCM sign-in failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  fcmToken = { value: j.access_token, exp: now + (j.expires_in || 3600), email: sa.client_email };
  return fcmToken.value;
}

// The FCM request body (exported for the tests)
export function fcmMessage(token, { title, body, tag, url, ...data }, ttl = 120) {
  const strData = Object.fromEntries(Object.entries({ tag, url, ...data }).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  return {
    message: {
      token,
      notification: { title, body },
      data: strData,
      android: {
        priority: 'HIGH',
        ttl: `${ttl}s`,
        ...(tag ? { collapse_key: tag.slice(0, 64) } : {}),
        notification: { channel_id: 'game', ...(tag ? { tag } : {}) },
      },
      apns: { headers: { 'apns-priority': '10', ...(tag ? { 'apns-collapse-id': tag.slice(0, 64) } : {}) }, payload: { aps: { sound: 'default' } } },
    },
  };
}

export async function sendFcm(serviceAccount, token, message, { ttl = 120 } = {}) {
  const access = await fcmAccessToken(serviceAccount);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fcmMessage(token, message, ttl)),
  });
  if (res.ok) return { ok: true, gone: false };
  const text = await res.text().catch(() => '');
  const gone = res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(text);
  return { ok: false, gone, status: res.status, error: text.slice(0, 200) };
}
