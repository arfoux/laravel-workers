// kernel/packages/token.mjs — personal-access-token primitives (Laravel Sanctum
// parity). Sanctum stores `sha256(plaintext)` and hands the user `{id}|{random}`;
// verifying a Bearer token is therefore a SHA-256 + constant-time table lookup,
// which the edge can do natively (no PHP runtime).
//
// Sanctum's exact shape (Sanctum 4.x, `PersonalAccessToken`):
//   plaintext = `${token.id}|${randomString(40)}`
//   stored    = hash('sha256', plaintext)            // hex, lowercase
// `randomString(40)` uses Laravel's Str::random (alphanumeric, [A-Za-z0-9]).

import { timingSafeEqual } from './webhook.mjs';
import { bytesToHex } from '../digest.mjs';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// `crypto.getRandomValues` must be called with `crypto` as `this`; a bare
// default-parameter reference loses the receiver (ERR_INVALID_THIS), so wrap it.
const defaultRandomBytes = (arr) => crypto.getRandomValues(arr);

// Laravel `Str::random(length)` — a uniformly random alphanumeric string.
// `randomBytes` is injected so a caller (the compiled runtime) can pin the RNG;
// production callers omit it and get WebCrypto's CSPRNG.
export function randomString(length = 40, randomBytes = defaultRandomBytes) {
  const bytes = new Uint8Array(length);
  randomBytes(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return bytesToHex(new Uint8Array(digest));
}

// Mint a token for `userId` with the given `abilities`. Returns the plaintext
// (to hand to the user once) and the D1 row to persist — the stored value is
// only the SHA-256, never the plaintext.
export async function createPersonalAccessToken(userId, name, abilities = [], { id, randomBytes } = {}) {
  const tokenId = id ?? 1; // the caller assigns the real autoincrement id
  const random = randomString(40, randomBytes);
  const plain = `${tokenId}|${random}`;
  const stored = await sha256Hex(plain);
  return {
    plain,
    row: {
      tokenable_type: 'App\\Models\\User',
      tokenable_id: userId,
      name: name ?? 'default',
      token: stored,
      abilities: JSON.stringify(abilities),
      last_used_at: null,
      expires_at: null,
    },
  };
}

// Verify a Bearer token against a stored SHA-256. Returns the abilities array
// when it matches, else null. Constant-time on the digest (the digest is fixed
// length, so `timingSafeEqual` never leaks length).
export async function verifyPersonalAccessToken(plainToken, storedHash) {
  if (typeof plainToken !== 'string' || typeof storedHash !== 'string') return null;
  const computed = await sha256Hex(plainToken);
  return timingSafeEqual(computed, storedHash) ? computed : null;
}

// Parse `Authorization: Bearer <token>` into the raw plaintext token, or null.
export function bearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return m ? m[1].trim() : null;
}
