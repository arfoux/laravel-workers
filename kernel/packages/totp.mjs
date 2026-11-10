// kernel/packages/totp.mjs — TOTP (RFC 6238) over HMAC-SHA1 for the
// Fortify two-factor port. Python-style parity with laravel/fortify v1.41:
// same base32 secret handling, same dynamic truncation (RFC 4226), same
// 8-digit codes at a 30s step. WebCrypto does the HMAC-SHA1; only the RFC
// glue (base32 + truncate) is ours.
//
// The RFC 6238 SHA-1 test vector set is built into the tests
// (packages-fortify-2fa.test.mjs) and is the acceptance gate: key
// "12345678901234567890" (ASCII) → T=59:94287082 / T=1111111109:07081804 /
// T=1234567890:89005924. That key's base32 form is exactly what
// `generateSecret` returns the same shape as ("GEZDGNBV...").

import { timingSafeEqual } from './webhook.mjs';
import { randomString } from './token.mjs';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32 decode (tolerates lower-case, whitespace, '=' padding).
// Throws on any char outside the alphabet.
export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  if (!s.length) return new Uint8Array(0);
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// RFC 4648 base32 encode (padding omitted, canonical lower-case output up to
// the caller). Used to mint secrets from CSPRNG bytes.
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// 20 CSPRNG bytes → the secret a phone app imports (same entropy as
// `Str::randomBytes(20)` today we treat as equivalent to Fortify's
// `Str::random(20)` alphanumerics, only base32 for QR compatibility).
export function generateSecret(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return base32Encode(randomBytes(20));
}

async function hmacSha1(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.byteLength ? keyBytes : new Uint8Array(keyBytes),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msg);
  return new Uint8Array(sig);
}

// RFC 4226 HOTP with dynamic truncation. `counter` is a non-negative integer
// (the 8-byte big-endian time counter is built here).
export async function hotp(keyBytes, counter, digits = 8) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const hi = Math.floor(counter / 0x100000000);
  view.setUint32(0, hi >>> 0);
  view.setUint32(4, counter >>> 0);
  const mac = await hmacSha1(keyBytes, new Uint8Array(buf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = bin % 10 ** digits;
  return String(code).padStart(digits, '0');
}

// RFC 6238 TOTP. `secret` is a base32 string (or raw bytes for tests).
// `t` defaults to now in whole seconds; `step` defaults to 30 (Fortify's
// default). Returns the `digits`-wide code.
export async function totp(secret, { t = Math.floor(Date.now() / 1000), step = 30, digits = 8 } = {}) {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  return hotp(key, Math.floor(t / step), digits);
}

// Verify a candidate code allowing `window` steps of drift on each side
// (±30s each at a 30s step, Fortify uses the same ±1 window). Constant-time
// per candidate. Returns boolean.
export async function verifyTotp(secret, code, { t, step = 30, digits = 8, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d+$/.test(code) || code.length !== digits) return false;
  const now = t ?? Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i += 1) {
    const cand = await totp(secret, { t: now + i * step, step, digits });
    if (timingSafeEqual(cand, code)) return true;
  }
  return false;
}

// otpauth:// provisioning URI for authenticator-app scanning.
// issuer/name follow Fortify's Google-2FA-style URI.
export function provisioningUri(name, secretBase32, issuer = 'Fortify', { digits = 8, step = 30 } = {}) {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(name)}?${params.toString()}`;
}

// Fortify recovery codes: 8 codes, each `${Str::random(10)}-${Str::random(10)}`.
export function recoveryCodes(count = 8, randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const a = randomString(10, randomBytes);
    const b = randomString(10, randomBytes);
    codes.push(`${a}-${b}`);
  }
  return codes;
}
