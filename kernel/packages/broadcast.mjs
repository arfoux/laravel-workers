// kernel/packages/broadcast.mjs — Pusher-protocol broadcast primitives shared by
// the pusher-php-server and reverb ports. Both packages sign a channel
// authorization token the exact same way (`{socket_id}:{channel_name}` →
// HMAC-SHA256 hex, prefixed with the app key), so the crypto lives here once —
// along with the bodies of the `POST /broadcasting/auth` route they and `echo`
// answer (see the guard section below).
//
// Parity target (PHP `Pusher` SDK `socket_auth` / `presence_auth`):
//   private  → `{key}.{hash(socket_id:channel_name)}`
//   presence → `{key}.{hash(socket_id:channel_name)}` + a JSON `channel_data`
//              carrying `user_id` / `user_info`.
// The event trigger signs the canonical query string
//   `auth_key=..&body_md5=..&auth_timestamp=..&auth_version=1.0`
// with HMAC-SHA256 (hex) — byte-identical to the SDK's `build_auth_query_string`.
// WebCrypto's HMAC is async; every exported signer is therefore async.

import { timingSafeEqual } from './webhook.mjs';
import { hmacSha256Hex } from '../hmac.mjs';
import { jsonResponse, guardUserId, unauthorized } from './port-ctx.mjs';

// A channel is subscribable only when it is private or presence — public
// channels need no auth token (the SDK returns null for them).
export function isPrivateChannel(channelName) {
  return typeof channelName === 'string'
    && (channelName.startsWith('private-') || channelName.startsWith('presence-'));
}

// ── The `POST /broadcasting/auth` bodies ─────────────────────────────────────
// Laravel's `Broadcast::routes()` registers one path and three ports answer it:
// echo (a Sanctum-token client), pusher-php-server and reverb (the platform
// guard). Two of them answer with the SAME block — resolve the app key/secret,
// read `socket_id` + `channel_name`, refuse a missing pair (422) or a public
// channel (403), take the presence identity from the platform guard (401 when
// there is none) and sign the token — so that block lives here once, as
// `channelAuthResponse()`; `pusher` and `reverb` pass in their own secret lookup
// (and keep their own "not configured" wording, which is a 500).
// echo's ORDER is its own (it resolves its Bearer token before it reads the
// body), so it keeps its handler and reuses only the pieces below.
//
// Parity: Laravel denies a channel it cannot authorize by throwing
// `AccessDeniedHttpException`, which the framework renders as
// `{"message": "<exception message>"}` — status 403, key `message`. The ports'
// TEXT is their own (Laravel's exception carries none), which is why the two
// messages below are spelled here once. The 422 is the ports' own guard:
// Laravel has no such case (an empty `channel_name` takes the 403 path too) —
// disclosed in docs/PACKAGE-PORTS.md.
export const CHANNEL_AUTH_REQUIRED = 'socket_id and channel_name are required';
export const CHANNEL_AUTH_NOT_PRIVATE = 'channel must be private- or presence-';

// The `socket_id` / `channel_name` pair out of a form-urlencoded body (a plain
// object or an already-parsed `URLSearchParams` works identically).
export function readChannelAuthBody(ctx) {
  const raw = typeof ctx.body === 'string' ? ctx.body : (ctx.body || {});
  const body = raw && typeof raw.get === 'function' ? raw : new URLSearchParams(raw);
  return { socketId: body.get('socket_id'), channelName: body.get('channel_name') };
}

// A refusal on the auth route: Laravel's error key + the no-store JSON envelope
// every port answers with (`jsonResponse`).
export function channelAuthRefusal(status, message) {
  return jsonResponse(status, { message });
}

// The whole `POST /broadcasting/auth` block the Pusher-protocol auth ports
// answer with. `resolveKeys()` is the port's own secret lookup (`env.PUSHER_*`,
// `env.REVERB_*`), and a throw from it — or from the guard, or from the signer —
// is the same 500 the ports answered with before.
export async function channelAuthResponse(ctx, resolveKeys) {
  try {
    const { key, secret } = resolveKeys();
    const { socketId, channelName } = readChannelAuthBody(ctx);
    if (!socketId || !channelName) {
      return channelAuthRefusal(422, CHANNEL_AUTH_REQUIRED);
    }
    if (!isPrivateChannel(channelName)) {
      return channelAuthRefusal(403, CHANNEL_AUTH_NOT_PRIVATE);
    }

    // The channel's identity is the platform guard's, never the caller's: the
    // PHP SDK's `validAuthenticationResponse()` hands `presence_auth()`
    // `$user->getAuthIdentifier()`, and Laravel's `auth()` denies a guarded
    // channel outright when there is no user. Reading `channel_data.user_id`
    // from the body would let any caller (authenticated or not) join a
    // private/presence channel as an arbitrary user.
    const userId = await guardUserId(ctx);
    if (userId == null) return unauthorized();

    return channelAuthPayload(key, secret, socketId, channelName, userId);
  } catch (err) {
    return jsonResponse(500, { error: String((err && err.message) || err) });
  }
}

// The 200 the client (Echo) expects — `{ auth }` for a private channel,
// `{ auth, channel_data }` for a presence one. The presence `user_id` is the
// resolved guard identity, never a value from the request body.
export async function channelAuthPayload(key, secret, socketId, channelName, userId) {
  if (String(channelName).startsWith('presence-')) {
    const { auth, channel_data: channelData } = await signChannelAuth(
      key, secret, socketId, channelName, { user_id: userId },
    );
    return jsonResponse(200, { auth, channel_data: channelData });
  }
  const { auth } = await signChannelAuth(key, secret, socketId, channelName);
  return jsonResponse(200, { auth });
}

// Sign a private/presence channel auth token. `userData` (presence only) is
// embedded as the JSON `channel_data` the SDK hands back to Echo. The PHP SDK
// includes `user_info` only when the caller supplied it; omit when absent.
export async function signChannelAuth(key, secret, socketId, channelName, userData = null) {
  const payload = `${String(socketId)}:${String(channelName)}`;
  const signature = await hmacSha256Hex(secret, payload);
  const auth = `${key}.${signature}`;
  if (!userData) return { auth, channel_data: null };
  const channelData = userData.user_info !== undefined && userData.user_info !== null
    ? JSON.stringify({ user_id: userData.user_id, user_info: userData.user_info })
    : JSON.stringify({ user_id: userData.user_id });
  return { auth, channel_data: channelData };
}

// Full presence auth response body: `{ auth, channel_data }`.
export async function presenceAuth(key, secret, socketId, channelName, userId, userInfo = null) {
  return signChannelAuth(key, secret, socketId, channelName, { user_id: userId, user_info: userInfo });
}

// Pusher's REST auth signs the alphabetically-ordered query string and includes
// an MD5 of the raw body (`body_md5`). WebCrypto has no MD5, so this is a compact
// RFC 1321 implementation (correct, not constant-time — irrelevant: MD5 of a body
// we build ourselves, used only as an integrity hint by the REST API).
function md5(str) {
  const rl = (n, c) => ((n << c) | (n >>> (32 - c))) >>> 0;
  // UTF-8 encode (handles ASCII fast path; multibyte via manual surrogate pass).
  const s = String(str);
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const nblk = ((bytes.length + 8) >> 6) + 1;
  const x = new Array(nblk * 16).fill(0);
  for (let i = 0; i < bytes.length; i += 1) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  x[nblk * 16 - 2] = bytes.length * 8;
  const T = (k) => Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  let A = 0x67452301, B = 0xefcdab89, C = 0x98badcfe, D = 0x10325476;
  for (let i = 0; i < nblk; i += 1) {
    const o = [A, B, C, D];
    const X = x.slice(i * 16, i * 16 + 16);
    for (let j = 0; j < 64; j += 1) {
      let f, g;
      if (j < 16) { f = (B & C) | (~B & D); g = j; }
      else if (j < 32) { f = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * j) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + rl((A + f + T(j) + X[g]) >>> 0, S[j])) >>> 0;
      A = tmp;
    }
    A = (A + o[0]) >>> 0; B = (B + o[1]) >>> 0; C = (C + o[2]) >>> 0; D = (D + o[3]) >>> 0;
  }
  const hex = (n) => {
    let out = '';
    for (let j = 0; j < 4; j += 1) out += ((n >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return out;
  };
  return hex(A) + hex(B) + hex(C) + hex(D);
}

// Build the signed query string for a Pusher REST event trigger. Returns the
// full query (`auth_key=..&auth_timestamp=..&auth_version=1.0&body_md5=..&auth_signature=..`)
// ready to append to `/apps/{app_id}/events`.
export async function buildAuthQueryString(key, secret, bodyString, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const md5hex = md5(String(bodyString));
  const params = new URLSearchParams({
    auth_key: String(key),
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
    body_md5: md5hex,
  });
  // Pusher signs the alphabetically-ordered, url-encoded query string.
  const toSign = params.toString();
  const signature = await hmacSha256Hex(secret, toSign);
  params.set('auth_signature', signature);
  return params.toString();
}

// Verify a channel auth token the edge itself produced (used in tests and, if
// a hub ever echoes it back, to re-check). Constant-time on the hex signature.
export async function verifyChannelAuth(key, secret, socketId, channelName, auth) {
  const { auth: expected } = await signChannelAuth(key, secret, socketId, channelName);
  return timingSafeEqual(String(auth), expected);
}
