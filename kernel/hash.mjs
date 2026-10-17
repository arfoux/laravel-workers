// kernel/hash.mjs — bcrypt wrapper matching Laravel BcryptHasher (Workers-compatible)
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

export default { make, check, needsRehash };
