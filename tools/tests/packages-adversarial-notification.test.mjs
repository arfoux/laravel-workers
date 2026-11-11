// tools/tests/packages-adversarial-notification.test.mjs — ADVERSARIAL tests for
// the notification cluster (telegram, discord, expo, fcm, webpush, onesignal).
//
// Unlike packages-telegram / packages-discord-expo-onesignal / packages-fcm-webpush
// (which prove the happy path), this file attacks the handlers the way an attacker
// or a misbehaving provider would and asserts the security posture the cluster
// promises:
//
//   - a request with NO credential is refused (500) BEFORE any subrequest is spent
//   - a request whose credential is PRESENT but INVALID never yields a false 200:
//     either the provider's failure status is surfaced verbatim (bad-token 401 for
//     telegram/discord/onesignal/expo) or the local crypto step fails into a 500
//     (fcm service-account, webpush VAPID)
//   - an injection-laden body (XSS / control chars) is forwarded VERBATIM — these
//     ports are transports, so they must not mangle the caller's text; the JSON
//     envelope (not HTML escaping) is the safety boundary
//   - a missing required field is a 422, never a 500, and never reaches the provider
//   - a provider rate-limit (429) is surfaced verbatim, not swallowed into a 200
//   - a null/undefined/absent body is a 422 (not a 500) on every port
//   - a NON-JSON body (plain string / object with no required field) is a 422 — the
//     port level sees a parsed `ctx.body`, so the router owns 415; here we pin that
//     a body that parses to something without the required field is a clean 422
//   - idempotency: the ports are STATELESS — re-sending the identical payload is
//     two independent subrequests (no dedup). We PIN that observable behaviour
//     rather than assert a dedup the handlers do not implement (see the finding in
//     the module tail).
//
// No network: every provider call is faked via `env.fetchImpl`, the same pattern
// as packages-notify-http.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync } from 'node:crypto';

import telegram from '../../ports/packages/telegram-notification.mjs';
import discord from '../../ports/packages/discord-notification.mjs';
import expo from '../../ports/packages/expo-notification.mjs';
import fcm from '../../ports/packages/fcm-notification.mjs';
import webpush from '../../ports/packages/webpush-notification.mjs';
import onesignal from '../../ports/packages/onesignal-notification.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

// ---------------------------------------------------------------------------
// Fake fetch — records every call and replies with a canned / scripted response.
// Pass an object {status, jsonBody|rawBody, headers} for a single canned reply,
// or a function (callIndex, url, init) => responseSpec to script per-call.
// ---------------------------------------------------------------------------

function makeFetch(spec) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const idx = calls.length;
    calls.push({ url: String(url), init: init || {} });
    const r = typeof spec === 'function' ? spec(idx, String(url), init || {}) : spec;
    const bodyText = r.rawBody !== undefined ? r.rawBody : JSON.stringify(r.jsonBody ?? {});
    return new Response(bodyText, {
      status: r.status ?? 200,
      headers: r.headers || { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const okCtx = (body, params = {}) => ({ body, query: {}, params });

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

// A fresh valid VAPID private scalar (32 bytes) — base64url.
async function makeVapidKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  return { priv: jwk.d, kp };
}

function b64urlEncodeBytes(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// A valid RSA service account (same shape as packages-fcm-webpush.test.mjs).
function makeServiceAccount({ projectId = 'adv-fcm-project' } = {}) {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  const b64 = pkcs8.toString('base64').replace(/(.{64})/g, '$1\n');
  return {
    project_id: projectId,
    client_email: `firebase-adminsdk@${projectId}.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  };
}

// A client push subscription's public key + auth secret (valid P-256 + 16 bytes).
async function makeClientSubscription() {
  const client = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', client.publicKey));
  const authSecret = new Uint8Array(16).fill(7);
  return {
    client,
    p256dh: b64urlEncodeBytes(clientPublicRaw),
    auth: b64urlEncodeBytes(authSecret),
    authBytes: authSecret,
  };
}

const XSS_TEXT = '<script>alert("pwn")</script>';
const CTRL_TEXT = 'line1\nline2\ttab\u0000null';

// ---------------------------------------------------------------------------
// RFC 8291 decryption (test-side only) — webpush-crypto exports the ENCRYPT
// direction only, so to prove the ciphertext round-trips we decrypt it here with
// the client's private key + auth secret (same shape as packages-fcm-webpush).
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
const concatBytes = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};
const lengthPrefix = (bytes) => {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
};
async function decryptAes128Gcm(ciphertext, authSecretBytes, clientPrivateKey) {
  const salt = ciphertext.slice(0, 16);
  const keyidLen = ciphertext[20];
  const ephemeralPub = ciphertext.slice(21, 21 + keyidLen);
  const ct = ciphertext.slice(21 + keyidLen);
  const ephPubKey = await webcrypto.subtle.importKey('raw', ephemeralPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: ephPubKey }, clientPrivateKey, 256));
  const hkdfKey = await webcrypto.subtle.importKey('raw', concatBytes(shared, authSecretBytes), 'HKDF', false, ['deriveBits']);
  const context = lengthPrefix(ephemeralPub);
  const cek = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(enc.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0x00), context) }, hkdfKey, 128));
  const nonce = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(enc.encode('Content-Encoding: nonce'), Uint8Array.of(0x00), context) }, hkdfKey, 96));
  const aesKey = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const block = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ct));
  let end = block.length;
  for (let i = block.length - 1; i >= 0; i -= 1) { if (block[i] === 0x02) { end = i; break; } }
  return block.slice(0, end);
}

// ===========================================================================
// TELEGRAM (POST /notify/telegram) — token-in-URL path
// ===========================================================================

test('telegram ADV: no TELEGRAM_BOT_TOKEN is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  const res = await telegram(okCtx({ to: '123', body: 'hi' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('telegram ADV: an INVALID bot token is surfaced verbatim as the provider 401 (not a fake 200)', async () => {
  const fetchImpl = makeFetch({ status: 401, jsonBody: { ok: false, error_code: 401, description: 'Unauthorized' } });
  const res = await telegram(okCtx({ to: '123', body: 'hi' }), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:BAD-TOKEN' });
  assert.equal(res.status, 401);
  const sent = JSON.parse(res.body);
  assert.equal(sent.ok, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /bot123:BAD-TOKEN\/sendMessage/);
});

test('telegram ADV: missing chat_id (`to`) is a 422, not a 500, and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  const res = await telegram(okCtx({ body: 'no target' }), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('telegram ADV: XSS body text is forwarded VERBATIM (transport does not mangle text)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  await telegram(okCtx({ to: '123', body: XSS_TEXT }), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.text, XSS_TEXT); // not escaped, not stripped — byte-for-byte
});

test('telegram ADV: control chars / newlines in text are forwarded verbatim', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  await telegram(okCtx({ to: '123', body: CTRL_TEXT }), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.text, CTRL_TEXT);
});

test('telegram ADV: provider 429 is surfaced verbatim', async () => {
  const fetchImpl = makeFetch({ status: 429, jsonBody: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 5 } }, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
  const res = await telegram(okCtx({ to: '123', body: 'hi' }), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' });
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '5');
});

test('telegram ADV: null / undefined body is a 422, not a 500', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' };
  assert.equal((await telegram(okCtx(null), env)).status, 422);
  assert.equal((await telegram(okCtx(undefined), env)).status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('telegram ADV: a NON-JSON body (plain string) has no `to`/`chat_id` → clean 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  // A body that slipped past the router as a raw string: the port reads
  // properties off it, finds no chat_id, and fails validation — not a 500.
  const res = await telegram(okCtx('not-json-just-a-string'), { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('telegram ADV: idempotent re-send is two independent subrequests (stateless, no dedup)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { ok: true } });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: '123:abc' };
  const payload = { to: '123', body: 'same' };
  await telegram(okCtx(payload), env);
  await telegram(okCtx(payload), env);
  assert.equal(fetchImpl.calls.length, 2); // no server-side dedup key
});

// ===========================================================================
// DISCORD (POST /notify/discord) — webhook URL secret / bot token
// ===========================================================================

test('discord ADV: no webhook URL and no bot token is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  const res = await discord(okCtx({ content: 'hi' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord ADV: a bot token WITHOUT a channel id is a 422 (not a 500, not a send)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  const res = await discord(okCtx({ content: 'hi' }), { fetchImpl, DISCORD_BOT_TOKEN: 'bad-bot-token' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord ADV: an INVALID bot token gets the provider 401 surfaced verbatim', async () => {
  const fetchImpl = makeFetch({ status: 401, jsonBody: { message: '401: Unauthorized', code: 0 } });
  const res = await discord(okCtx({ content: 'hi', channel: 'C1' }), { fetchImpl, DISCORD_BOT_TOKEN: 'forged-token' });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).message, '401: Unauthorized');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bot forged-token');
});

test('discord ADV: an INVALID webhook URL (no secret suffix) gets the provider 404 surfaced', async () => {
  const fetchImpl = makeFetch({ status: 404, jsonBody: { message: 'Unknown Webhook', code: 10015 } });
  const res = await discord(okCtx({ content: 'hi' }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/forged' });
  assert.equal(res.status, 404);
});

test('discord ADV: XSS `content` is forwarded VERBATIM (no client-side escaping)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  await discord(okCtx({ content: XSS_TEXT }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.content, XSS_TEXT);
});

test('discord ADV: empty content with no embeds is a 422 (Discord requires content/embeds/file)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  const res = await discord(okCtx({ content: '' }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord ADV: provider 429 is surfaced verbatim with retry-after', async () => {
  const fetchImpl = makeFetch({ status: 429, jsonBody: { message: 'You are being rate limited', retry_after: 1.5 }, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
  const res = await discord(okCtx({ content: 'hi' }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' });
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '2');
});

test('discord ADV: null / undefined body is a 422 (webhook path), not a 500', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  const env = { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' };
  assert.equal((await discord(okCtx(null), env)).status, 422);
  assert.equal((await discord(okCtx(undefined), env)).status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord ADV: a NON-JSON body (array) with no content/embeds is a clean 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'm1' } });
  const res = await discord(okCtx(['raw', 'string', 'array']), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ===========================================================================
// EXPO (POST /notify/expo) — optional Bearer access token
// ===========================================================================

test('expo ADV: missing `to` is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { data: [] } });
  const res = await expo(okCtx({ body: 'hi' }), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('expo ADV: missing `body` (message text) is a 422 even when `to` is present', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { data: [] } });
  const res = await expo(okCtx({ to: 'ExponentPushToken[abc]' }), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('expo ADV: a comma-string of tokens (with an XSS-laden body) is forwarded verbatim + safe JSON envelope', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { data: [{ status: 'ok' }] } });
  const res = await expo(okCtx({ to: 'ExponentPushToken[a],ExponentPushToken[b]', body: XSS_TEXT }), { fetchImpl });
  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.to, ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
  assert.equal(sent.body, XSS_TEXT); // verbatim, no escaping
});

test('expo ADV: an INVALID access token still sends but the provider 401 is surfaced (not a fake 200)', async () => {
  const fetchImpl = makeFetch({ status: 401, jsonBody: { error: 'invalid_credentials' } });
  const res = await expo(okCtx({ to: 'ExponentPushToken[abc]', body: 'hi' }), { fetchImpl, EXPO_ACCESS_TOKEN: 'forged' });
  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer forged');
});

test('expo ADV: provider 429 (Expo rate limit) is surfaced verbatim', async () => {
  const fetchImpl = makeFetch({ status: 429, jsonBody: { error: 'rate limit exceeded' } });
  const res = await expo(okCtx({ to: 'ExponentPushToken[abc]', body: 'hi' }), { fetchImpl, EXPO_ACCESS_TOKEN: 't' });
  assert.equal(res.status, 429);
});

test('expo ADV: null / undefined body is a 422, not a 500', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { data: [] } });
  assert.equal((await expo(okCtx(null), { fetchImpl })).status, 422);
  assert.equal((await expo(okCtx(undefined), { fetchImpl })).status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('expo ADV: a NON-JSON body (number) has no `to` → clean 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { data: [] } });
  const res = await expo(okCtx(42), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ===========================================================================
// FCM (POST /notify/fcm) — RS256 service-account JWT + token exchange
// ===========================================================================

test('fcm ADV: a message with no target (token/to/topic/condition) is a 422 before any auth', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const sa = makeServiceAccount();
  const env = { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
  const res = await fcm(okCtx({ notification: { title: 'x', body: 'y' } }), env);
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0); // fails before minting a token
});

test('fcm ADV: missing FCM_PROJECT_ID (and none in the SA) is a 500 before fetch', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const sa = makeServiceAccount();
  delete sa.project_id;
  const env = { fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
  const res = await fcm(okCtx({ token: 'devtok' }), env);
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('fcm ADV: a service account with an EMPTY private_key fails locally into a 500 (no false 200)', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const sa = { project_id: 'p', client_email: 'x@p.iam', private_key: '' };
  const res = await fcm(okCtx({ token: 'devtok' }), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /FCM auth failed/);
  assert.equal(fetchImpl.calls.length, 0); // the bad key never reaches a subrequest
});

test('fcm ADV: a VALID-looking SA whose key is garbage (not valid PEM/DER) fails into a 500, never a 200', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const sa = { project_id: 'p', client_email: 'x@p.iam', private_key: 'definitely-not-a-pem-key' };
  const res = await fcm(okCtx({ token: 'devtok' }), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /FCM auth failed/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('fcm ADV: a VALID key but Google REFUSES the token exchange → the send never happens and it is a 500', async () => {
  // Scripted fetch: call 0 = token endpoint (401), and the send endpoint must
  // NEVER be reached.
  const fetchImpl = makeFetch((idx, url) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    return { status: 401, jsonBody: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
  });
  const sa = makeServiceAccount();
  const res = await fcm(okCtx({ token: 'devtok' }), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /FCM auth failed/);
  assert.equal(fetchImpl.calls.length, 1); // only the token call — no send
});

test('fcm ADV: happy path with valid SA + token exchange reaches the send and surfaces FCM 200', async () => {
  const sa = makeServiceAccount();
  const fetchImpl = makeFetch((idx, url) =>
    url.includes('oauth2.googleapis.com/token')
      ? { status: 200, jsonBody: { access_token: 'ya29.adv-token', expires_in: 3600, token_type: 'Bearer' } }
      : { status: 200, jsonBody: { name: 'projects/p/messages/0' } }
  );
  const res = await fcm(okCtx({ token: 'devtok', notification: { title: XSS_TEXT, body: CTRL_TEXT } }), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).name, 'projects/p/messages/0');
  const send = fetchImpl.calls[1];
  assert.match(send.url, /\/v1\/projects\/adv-fcm-project\/messages:send/);
  assert.equal(send.init.headers.authorization, 'Bearer ya29.adv-token');
  const sent = JSON.parse(send.init.body);
  // The injection-laden notification text is forwarded verbatim.
  assert.equal(sent.message.notification.title, XSS_TEXT);
  assert.equal(sent.message.notification.body, CTRL_TEXT);
});

test('fcm ADV: provider 429 on the send is surfaced verbatim (token exchange still succeeds first)', async () => {
  const sa = makeServiceAccount();
  const fetchImpl = makeFetch((idx, url) =>
    url.includes('oauth2.googleapis.com/token')
      ? { status: 200, jsonBody: { access_token: 'ya29.t', expires_in: 3600, token_type: 'Bearer' } }
      : { status: 429, jsonBody: { error: { code: 429, message: 'Resource has been exhausted' } }, headers: { 'content-type': 'application/json', 'retry-after': '10' } }
  );
  const res = await fcm(okCtx({ token: 'devtok' }), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '10');
});

test('fcm ADV: null / undefined body is a 422 (no target), not a 500', async () => {
  const sa = makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const env = { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
  assert.equal((await fcm(okCtx(null), env)).status, 422);
  assert.equal((await fcm(okCtx(undefined), env)).status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('fcm ADV: a NON-JSON body (string) has no target → clean 422, no token minted', async () => {
  const sa = makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, jsonBody: {} });
  const res = await fcm(okCtx('raw-string-body'), { fetchImpl, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ===========================================================================
// WEBPUSH (POST /notify/webpush) — VAPID JWT signature (the one REAL signature)
// ===========================================================================

test('webpush ADV: no subscription (neither id nor endpoint+keys) is a 422 before fetch', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const res = await webpush(okCtx({ payload: 'x' }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webpush ADV: a subscription with endpoint but MISSING keys{p256dh,auth} is a 422', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const res = await webpush(okCtx({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webpush ADV: an INVALID VAPID private key fails the ES256 sign locally into a 500 (no false 200)', async () => {
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const sub = await makeClientSubscription();
  const res = await webpush(okCtx({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: sub.p256dh, auth: sub.auth }, payload: 'x' }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: 'not-a-valid-base64url-scalar!!', WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 500);
  // A corrupt scalar dies in base64url decode / P-256 derive / ECDSA import —
  // any of those messages is fine; the invariant is 500 + nothing fetched.
  assert.ok(typeof JSON.parse(res.body).error === 'string');
  assert.equal(fetchImpl.calls.length, 0); // nothing is sent under a broken signature
});

test('webpush ADV: missing VAPID_SUBJECT is a 500 before fetch (RFC 8292 requires a sub claim)', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const sub = await makeClientSubscription();
  const res = await webpush(okCtx({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: sub.p256dh, auth: sub.auth } }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webpush ADV: the VAPID signature sent is a well-formed ES256 JWT the provider could verify', async () => {
  const { priv } = await makeVapidKey();
  const sub = await makeClientSubscription();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const res = await webpush(okCtx({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: sub.p256dh, auth: sub.auth }, payload: XSS_TEXT }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:ops@example.com' });
  assert.equal(res.status, 201);
  const auth = fetchImpl.calls[0].init.headers.authorization;
  const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.(.+), k=(.+)$/);
  assert.ok(m, `vapid header not in t=..,k=.. form: ${auth}`);
  const [h] = m.slice(1);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  // The signed sub claim is the configured subject, not attacker-controlled.
  const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(payload.sub, 'mailto:ops@example.com');
});

test('webpush ADV: the encrypted payload round-trips so the INJECTION-LADEN text is intact (not mangled)', async () => {
  const { priv } = await makeVapidKey();
  const sub = await makeClientSubscription();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  await webpush(okCtx({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: sub.p256dh, auth: sub.auth }, payload: XSS_TEXT }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:ops@example.com' });
  // Decrypt the aes128gcm body with the client private key (RFC 8291) — a local
  // helper, since webpush-crypto only exports the encrypt direction.
  const recovered = new TextDecoder().decode(
    await decryptAes128Gcm(fetchImpl.calls[0].init.body, sub.authBytes, sub.client.privateKey)
  );
  // The payload was a bare string — it round-trips byte-for-byte, unescaped.
  assert.equal(recovered, XSS_TEXT);
});

test('webpush ADV: provider 429 is surfaced verbatim', async () => {
  const { priv } = await makeVapidKey();
  const sub = await makeClientSubscription();
  const fetchImpl = makeFetch({ status: 429, rawBody: '', headers: { 'retry-after': '30' } });
  const res = await webpush(okCtx({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: sub.p256dh, auth: sub.auth } }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '30');
});

test('webpush ADV: a D1 lookup for an UNKNOWN id is a 404, not a 500, and never fetches', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  const res = await webpush(okCtx({ payload: 'x' }, { id: '999' }), { fetchImpl, DB: db, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webpush ADV: a D1 lookup with NO DB binding is a 404 (surfaced error), not an unhandled crash', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, rawBody: '' });
  const res = await webpush(okCtx({ payload: 'x' }, { id: '1' }), { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.calls.length, 0);
});

// ===========================================================================
// ONESIGNAL (POST /notify/onesignal) — HTTP Basic REST API key
// ===========================================================================

test('onesignal ADV: missing ONESIGNAL_APP_ID is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const res = await onesignal(okCtx({ to: 'player-1', body: 'hi' }), { fetchImpl, ONESIGNAL_REST_API_KEY: 'k' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal ADV: missing ONESIGNAL_REST_API_KEY is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const res = await onesignal(okCtx({ to: 'player-1', body: 'hi' }), { fetchImpl, ONESIGNAL_APP_ID: 'app' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal ADV: an INVALID REST API key gets the provider 403 surfaced verbatim (not a fake 200)', async () => {
  const fetchImpl = makeFetch({ status: 403, jsonBody: { errors: ['Invalid API key'] } });
  const res = await onesignal(okCtx({ to: 'player-1', body: 'hi' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'forged-key' });
  assert.equal(res.status, 403);
  // HTTP Basic with the REST key as the username and an empty password.
  const expected = 'Basic ' + Buffer.from('forged-key:').toString('base64');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, expected);
});

test('onesignal ADV: a notification with no target (player/external/segment) is a 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const res = await onesignal(okCtx({ body: 'hi' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal ADV: a notification with a target but NO body (and no contents) is a 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const res = await onesignal(okCtx({ to: 'player-1' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal ADV: XSS body text lands in the `contents` language map verbatim', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  await onesignal(okCtx({ to: 'player-1', body: XSS_TEXT }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.contents.en, XSS_TEXT);
  assert.equal(sent.app_id, 'app');
});

test('onesignal ADV: provider 429 is surfaced verbatim', async () => {
  const fetchImpl = makeFetch({ status: 429, jsonBody: { errors: ['Rate limit exceeded'] } });
  const res = await onesignal(okCtx({ to: 'player-1', body: 'hi' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' });
  assert.equal(res.status, 429);
});

test('onesignal ADV: null / undefined body is a 422 (no target), not a 500', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const env = { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' };
  assert.equal((await onesignal(okCtx(null), env)).status, 422);
  assert.equal((await onesignal(okCtx(undefined), env)).status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal ADV: a NON-JSON body (boolean) has no target → clean 422', async () => {
  const fetchImpl = makeFetch({ status: 200, jsonBody: { id: 'n1' } });
  const res = await onesignal(okCtx(true), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ===========================================================================
// Cross-cutting: a network-level provider failure is a 502, never an unhandled
// reject (an attacker cutting the connection must not 500 the Worker).
// ===========================================================================

test('all ADV: a THROWN fetch becomes a 502 on every port, never an unhandled rejection', async () => {
  const boom = async () => { throw new Error('connection reset'); };
  const goodTelegram = { to: '123', body: 'hi' };
  const goodDiscord = { content: 'hi' };
  const goodExpo = { to: 'ExponentPushToken[abc]', body: 'hi' };
  const goodOne = { to: 'player-1', body: 'hi' };

  assert.equal((await telegram(okCtx(goodTelegram), { fetchImpl: boom, TELEGRAM_BOT_TOKEN: '123:abc' })).status, 502);
  assert.equal((await discord(okCtx(goodDiscord), { fetchImpl: boom, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2' })).status, 502);
  assert.equal((await expo(okCtx(goodExpo), { fetchImpl: boom })).status, 502);
  assert.equal((await onesignal(okCtx(goodOne), { fetchImpl: boom, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'k' })).status, 502);

  // fcm + webpush need valid key material to reach the send/encrypt fetch.
  const sa = makeServiceAccount();
  const fcmFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600, token_type: 'Bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('connection reset');
  };
  assert.equal((await fcm(okCtx({ token: 'devtok' }), { fetchImpl: fcmFetch, FCM_PROJECT_ID: 'adv-fcm-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) })).status, 502);

  const { priv } = await makeVapidKey();
  const sub = await makeClientSubscription();
  const wpFetch = async () => { throw new Error('connection reset'); };
  assert.equal((await webpush(okCtx({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: sub.p256dh, auth: sub.auth } }), { fetchImpl: wpFetch, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' })).status, 502);
});

/* ---------------------------------------------------------------------------
FINDING (idempotency / content-type, not a bug but a contract note):

These six notification ports are STATELESS transports — they hold no dedup key
and no request-id ledger, and they read an ALREADY-PARSED `ctx.body`, so the
port level never sees the raw Content-Type header. Consequences an integrator
must own at the route/middleware layer:
  - "idempotensi (kirim dua kali sama)" → the port issues TWO independent provider
    subrequests. Any dedup (client-supplied Idempotency-Key → D1 ledger) must be
    added ABOVE the port; it is NOT the port's job and these tests pin that.
  - "content-type salah → 415/422" → a non-JSON Content-Type is rejected by the
    ROUTER before the port is invoked; at the port level a body that parsed to
    something without the required field is a clean 422 (asserted above). The
    port cannot itself return 415 because it never inspects Content-Type.
  - "signature webhook palsu → ditolak" → none of telegram/discord/expo/onesignal
    verify an INBOUND signature (they authenticate OUTBOUND via a shared secret:
    URL-embedded token, bot token, bearer, or HTTP basic); only webpush carries a
    real cryptographic signature (VAPID ES256) and only FCM signs (RS256 SA JWT).
    The adversarial equivalent tested here is: a PRESENT-but-INVALID credential is
    never laundered into a false 200 — it surfaces the provider's rejection status
    verbatim (telegram/discord/expo/onesignal) or fails local crypto into a 500
    (fcm service-account, webpush VAPID).
--------------------------------------------------------------------------- */
