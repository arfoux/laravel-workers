// kernel/packages/signedurl.mjs — Laravel-style signed values and signed URLs
// (HMAC-SHA256 over the app key), shared by the Fortify email-verification /
// password-confirm port and the Sanctum SPA-cookie session. This is the
// equivalent of `Illuminate\Support\Facades\URL::temporarySignedRoute` +
// `Illuminate\Encryption\Encrypter`'s MAC, reduced to the two shapes the edge
// actually needs:
//   1. a signed, optionally-expiring VALUE (used for the session cookie);
//   2. a signed PATH (`/email/verify/{id}/{hash}?expires=..&signature=..`),
//      where the signature is HMAC over `${path}?expires=${expires}` and the
//      expiry rides in the query string exactly like Laravel's.
//
// The secret is the app key (env.APP_KEY / env.SESSION_SECRET). It never
// appears in code or in the signed output — only the HMAC does.

import { timingSafeEqual } from './webhook.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Signed VALUE (session cookie, general purpose)
// ---------------------------------------------------------------------------

// Produce `<b64url(json)>.<hex-hmac>` for `value`, embedding an absolute
// expiry when `ttlSeconds` is given. Opaque to the client (payload is only
// base64, the MAC is what protects it).
export async function signValue(value, secret, { ttlSeconds = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const payload = { value, expires: ttlSeconds != null ? now + ttlSeconds : null };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmacHex(secret, body);
  return `${body}.${sig}`;
}

// Verify a signed value. Returns `{ valid: true, value }` on success;
// `{ valid: false }` on a bad MAC; `{ valid: false, expired: true, value }`
// when the MAC is good but the value has aged past `expires`.
export async function verifyValue(token, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string') return { valid: false };
  const dot = token.lastIndexOf('.');
  if (dot === -1) return { valid: false };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await hmacHex(secret, body);
  if (!timingSafeEqual(expect, sig)) return { valid: false };
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(body)));
  } catch {
    return { valid: false };
  }
  if (payload.expires != null && now > payload.expires) {
    return { valid: false, expired: true, value: payload.value };
  }
  return { valid: true, value: payload.value };
}

// ---------------------------------------------------------------------------
// Signed PATH (Laravel `URL::temporarySignedRoute` shape)
// ---------------------------------------------------------------------------

// Sign `${path}?expires=${expires}` → hex signature. Caller builds the public
// URL as `${base}${path}?expires=${expires}&signature=${sig}`.
export async function signPath(pathWithExpires, secret) {
  return hmacHex(secret, pathWithExpires);
}

// Verify the `${path}?expires=${expires}` the client presented against the
// `signature` param. Also enforces that `expires` (a unix second) is in the
// future. Constant-time on the MAC.
export async function verifyPath(pathWithExpires, signature, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof signature !== 'string' || !signature) return { valid: false };
  const expiresMatch = /[?&]expires=(\d+)/.exec(pathWithExpires || '');
  if (!expiresMatch) return { valid: false };
  const expires = Number(expiresMatch[1]);
  if (now > expires) return { valid: false, expired: true };
  const expect = await signPath(pathWithExpires, secret);
  return timingSafeEqual(expect, signature) ? { valid: true } : { valid: false };
}
