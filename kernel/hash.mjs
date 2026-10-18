// kernel/hash.mjs — Hash (bcrypt)
// Uses bcryptjs (pure JS, no native).
import bcrypt from 'bcryptjs';

export async function make(value, { rounds = 10 } = {}) {
  const salt = await bcrypt.genSalt(rounds);
  return bcrypt.hash(String(value), salt);
}

export async function check(value, hashed) {
  if (!hashed || typeof hashed !== 'string') return false;
  return bcrypt.compare(String(value), hashed);
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

export default { make, check, needsRehash, isHashed };
