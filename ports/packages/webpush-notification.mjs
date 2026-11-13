// Port: laravel-notification-channels/webpush — Web Push notification channel.
//
// Laravel's `WebPushChannel` encrypts a payload to a browser push subscription
// (ECDH P-256 + HKDF + AES-128-GCM, RFC 8291) and authenticates the request
// with a VAPID JWT (RFC 8292). The actual send is a single HTTPS POST to the
// subscription's `endpoint` (FCM's push service or Mozilla's autopush) carrying
// the encrypted body + VAPID header — pure WebCrypto + `fetch`, so it ports 1:1
// to a Worker.
//
// Edge disclosure: NONE algorithmic. The one structural constraint is that the
// subscription (endpoint + p256dh + auth keys) is created in the BROWSER via
// PushManager.getSubscription() and must be stored server-side — we keep it in
// a D1 `webpush_subscriptions` table (see ensureSchema). The helper does the
// server-side encrypt + VAPID sign + send.
//
// Config (env): WEBPUSH_VAPID_PRIVATE_KEY (base64url 32-byte private scalar),
// WEBPUSH_VAPID_SUBJECT (a `mailto:` or `https:` contact URI, required by
// RFC 8292). Optional WEBPUSH_TTL / WEBPUSH_URGENCY defaults.
//
// Payload (ctx.body):
//   { id }                        -> look the subscription up in D1, or
//   { endpoint, keys:{p256dh,auth} } -> use the subscription inline.
//   { payload?, ttl?, urgency?, topic? } — payload is any JSON-serialisable
//   value; when omitted we send an empty body (a "signal" push).
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, jsonPort, deliverVia } from '../../kernel/packages/notify-http.mjs';
import { encryptAes128Gcm, buildVapidHeader } from '../../kernel/packages/webpush-crypto.mjs';
import { b64urlToBytes as base64UrlToBytes } from '../../kernel/packages/b64url.mjs';

// D1 schema for stored push subscriptions (browser-supplied). `endpoint` is the
// push-service URL (UNIQUE — a device registers at most one per service).
export async function ensureSchema(env) {
  const db = env && env.DB;
  if (!db) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS webpush_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT
    )
  `).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS webpush_subscriptions_endpoint_idx ON webpush_subscriptions (endpoint)'
  ).run();
}

// Fresh ephemeral ECDH P-256 keypair for this one message. WebCrypto keeps the
// private key non-extractable; we only need the raw public (65 bytes) to embed
// in the aes128gcm header. Returns { privateKey, publicKeyRaw }.
async function makeEphemeralKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyRaw: pubRaw };
}

// Resolve the subscription { endpoint, p256dh, auth } from D1 by id, or from
// the request body inline.
async function resolveSubscription(ctx, env, raw) {
  const id = ctx && ctx.params ? ctx.params.id : undefined;
  if (id != null && String(id) !== '') {
    const db = (env && env.DB) || (ctx && ctx.db);
    if (!db) throw new Error('no D1 binding (env.DB) to look up subscription by id');
    const row = await db
      .prepare('SELECT endpoint, p256dh, auth FROM webpush_subscriptions WHERE id = ?1 LIMIT 1')
      .bind(String(id))
      .first();
    if (!row) throw new Error(`subscription ${id} not found`);
    return { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
  }
  const keys = (raw && raw.keys) || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const endpoint = str(raw && raw.endpoint);
  const p256dh = str(keys.p256dh);
  const auth = str(keys.auth);
  if (!endpoint || !p256dh || !auth) {
    return null;
  }
  return { endpoint, p256dh, auth };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};

  const vapidPriv = env && env.WEBPUSH_VAPID_PRIVATE_KEY;
  const subject = (env && env.WEBPUSH_VAPID_SUBJECT) || '';
  if (!vapidPriv) {
    return jsonPort({ error: 'missing WEBPUSH_VAPID_PRIVATE_KEY' }, 500);
  }
  if (!subject) {
    return jsonPort({ error: 'missing WEBPUSH_VAPID_SUBJECT (a mailto:/https: contact URI is required by RFC 8292)' }, 500);
  }

  let subscription;
  try {
    subscription = await resolveSubscription(ctx, env, raw);
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 404);
  }
  if (!subscription) {
    return jsonPort({ error: 'webpush requires a subscription: pass id, or endpoint + keys{p256dh,auth}' }, 422);
  }

  const str = (v) => (typeof v === 'string' ? v : '');
  const ttl = raw.ttl != null ? Number(raw.ttl) : (env && env.WEBPUSH_TTL != null ? Number(env.WEBPUSH_TTL) : 2419200);
  const urgency = str(raw.urgency) || str(env && env.WEBPUSH_URGENCY) || 'normal';
  const topic = str(raw.topic);

  // Encrypt the payload (when present) to this subscription.
  let body;
  let authorization;
  try {
    authorization = await buildVapidHeader(subscription.endpoint, vapidPriv, subject);
  } catch (err) {
    // A corrupt/invalid VAPID private scalar dies in base64url decode, P-256
    // derivation or ECDSA key import — surface as a 500 (never an unhandled
    // reject, never a send under a broken signature).
    return jsonPort({ error: `webpush vapid sign failed: ${String((err && err.message) || err)}` }, 500);
  }
  const headers = {
    authorization,
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(Number.isFinite(ttl) ? ttl : 2419200),
    urgency,
  };
  if (topic) headers.topic = topic;

  if (raw.payload != null) {
    try {
      const eph = await makeEphemeralKeys();
      const plaintext = typeof raw.payload === 'string' ? raw.payload : JSON.stringify(raw.payload);
      // subscription.p256dh is already the raw uncompressed P-256 public key.
      const enc = await encryptAes128Gcm(subscription.auth, {
        clientPublicKey: base64UrlToBytes(subscription.p256dh),
        ephemeralPrivateKey: eph.privateKey,
        ephemeralPublicKey: eph.publicKeyRaw,
      }, plaintext);
      body = enc.ciphertext;
    } catch (err) {
      return jsonPort({ error: `webpush encrypt failed: ${String((err && err.message) || err)}` }, 500);
    }
  }

  const doFetch = resolveFetch(env);
  const init = { method: 'POST', headers };
  if (body) init.body = body;

  // Push services return 201 (created) / 200 on success; surface verbatim.
  return deliverVia(doFetch, subscription.endpoint, init);
}
