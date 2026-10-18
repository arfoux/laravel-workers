// kernel/hash.mjs — Hash (bcrypt)
// Uses bcryptjs (pure JS, no native).
import bcrypt from 'bcryptjs';

// constant-time string/Uint8Array compare — does not early-return on first mismatch
export function timingSafeEqual(a, b) {
  const toBytes = (v) => {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (typeof Buffer !== 'undefined' && v && Buffer.isBuffer(v)) return new Uint8Array(v);
    return new TextEncoder().encode(String(v));
  };
  const aBytes = toBytes(a);
  const bBytes = toBytes(b);
  if (aBytes.length !== bBytes.length) return false;
  try {
    const f = globalThis.crypto && globalThis.crypto.timingSafeEqual;
    if (typeof f === 'function' && typeof Buffer !== 'undefined') {
      return f(Buffer.from(aBytes), Buffer.from(bBytes));
    }
  } catch {}
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export async function make(value, { rounds = 10 } = {}) {
  const salt = await bcrypt.genSalt(rounds);
  return bcrypt.hash(String(value), salt);
}

export async function check(value, hashed) {
  if (!hashed || typeof hashed !== 'string') return false;
  const ok = await bcrypt.compare(String(value), hashed);
  return timingSafeEqual(ok ? '1' : '0', '1');
}

export function needsRehash(hashed, { rounds = 10 } = {}) {
  if (!hashed || typeof hashed !== 'string') return true;
  try {
    const r = bcrypt.getRounds(hashed);
    return r !== rounds;
  } catch {
    return true;
  }
}

// Laravel `Hash::isHashed()`: true when the value already looks like a bcrypt
// (or argon2) digest, so callers don't double-hash.
const HASHED_RE = /^\$(2[aby]\$\d{2}\$|argon2(id|i|d)\$)/;

export function isHashed(value) {
  return typeof value === 'string' && HASHED_RE.test(value);
}

export default { make, check, needsRehash, isHashed, timingSafeEqual };
