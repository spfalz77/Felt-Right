// Push senders (supabase/functions/_shared/push.js): web push encryption is
// checked by decrypting with an independent implementation (http_ece), VAPID
// by verifying the signature, FCM by the shape of the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { encryptWebPush, vapidAuthHeader, fcmMessage, b64url, unb64url } from '../supabase/functions/_shared/push.js';

test('web push: a browser can decrypt the message (aes128gcm)', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  const msg = JSON.stringify({ title: 'Your turn', body: 'The table is waiting on you.' });
  const body = await encryptWebPush(new TextEncoder().encode(msg), b64url(ua.getPublicKey()), b64url(auth));
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.equal(plain.toString(), msg);
});

test('web push: VAPID header is a valid ES256 JWT for the push service', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', jwk, 'mailto:test@example.com');
  const m = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, h);
  const [head, claims, sig] = m[1].split('.');
  const c = JSON.parse(new TextDecoder().decode(unb64url(claims)));
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'mailto:test@example.com');
  const pub = await crypto.subtle.importKey('raw', unb64url(m[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(sig), new TextEncoder().encode(`${head}.${claims}`)));
});

test('FCM: message has a high-priority Android notification that replaces the last one for the game', () => {
  const m = fcmMessage('tok', { title: 'Your turn', body: 'x', tag: 'turn-g1', url: 'https://a/?game=1', gameId: 'g1' });
  assert.equal(m.message.token, 'tok');
  assert.deepEqual(m.message.notification, { title: 'Your turn', body: 'x' });
  assert.equal(m.message.android.priority, 'HIGH');
  assert.equal(m.message.android.notification.tag, 'turn-g1');
  assert.equal(m.message.data.gameId, 'g1');
  assert.ok(Object.values(m.message.data).every((v) => typeof v === 'string'));
});
