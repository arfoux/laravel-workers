// kernel/hash.mjs � Hash (bcrypt)
// Uses bcryptjs (pure JS, no native).
import bcrypt from 'bcryptjs';

// constant-time string/Uint8Array compare � does not early-return on first mismatch
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

export async function make(value, { rounds = 12 } = {}) {
  const salt = await bcrypt.genSalt(rounds);
  const hash = await bcrypt.hash(String(value), salt);
  // PHP 8.3 password_hash() emits `$2y$`; bcryptjs emits `$2a$`. Store the
  // PHP prefix (like makeSync below) so password_get_info()-shaped checks
  // (isHashed, verifyConfiguration, needsRehash) treat our own hashes as
  // bcrypt - exactly like BcryptHasher.
  return hash.replace(/^\$2[abxy]\$/, '$2y$');
}

// Synchronous bcrypt for Eloquent's `hashed` cast. Laravel's
// castAttributeAsHashedString() runs Hash::make() inside setAttribute(), which is
// synchronous in PHP, so the compiled Model#set() must hash before returning.
// bcryptjs' hashSync costs the same CPU as the async form (measured in
// kernel/tests/budget.test.mjs); callers on the free plan should expect the
// configured cost (12 by default) per filled password.
export function makeSync(value, { rounds = 12 } = {}) {
  const salt = bcrypt.genSaltSync(Number(rounds));
  const hash = bcrypt.hashSync(String(value), salt);
  // PHP 8.3 password_hash() emits `$2y$`; bcryptjs emits `$2a$`. Store the
  // PHP prefix so password_get_info()-shaped checks (verifyConfiguration,
  // needsRehash) treat our own hashes as bcrypt, exactly like BcryptHasher.
  return hash.replace(/^\$2[abxy]\$/, '$2y$');
}

// PHP 8.3 password_get_info() as measured against the vendor oracle: only a
// full `$2y$NN$` + 53-char digest is bcrypt; `$2a$`/`$2b$` and truncated
// strings report algo null; any `$argon2(id|i|d)$` prefix is argon2.
const BCRYPT_2Y_60_RE = /^\$2y\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const ARGON2_PREFIX_RE = /^\$argon2(id|i|d)\$/;

export function passwordInfo(value) {
  if (typeof value !== 'string') return { algo: null, algoName: 'unknown', options: [] };
  const m = BCRYPT_2Y_60_RE.exec(value);
  if (m) {
    return { algo: '2y', algoName: 'bcrypt', options: { cost: parseInt(m[1], 10) } };
  }
  const a = ARGON2_PREFIX_RE.exec(value);
  if (a) {
    return { algo: 'argon2' + a[1], algoName: 'argon2' + a[1], options: [] };
  }
  return { algo: null, algoName: 'unknown', options: [] };
}

// Laravel 13.37 HashManager::isHashed(): `driver()->info($value)['algo'] !== null`.
// The `hashed` cast must use this exact check (a `$2a$` digest is re-hashed by
// Laravel on PHP 8.3, while `$2y$` passes through).
export function isHashedDigest(value) {
  return passwordInfo(value).algo !== null;
}

// Laravel 13.37 BcryptHasher::verifyConfiguration():
//   isUsingCorrectAlgorithm($value) && isUsingValidOptions($value)
// where PHP's password_get_info() identifies ONLY `$2y$NN$` as bcrypt, and the
// cost must be an integer <= the configured rounds (a lower cost is valid).
export function verifyConfiguration(hashed, { rounds = 12 } = {}) {
  const info = passwordInfo(hashed);
  if (info.algoName !== 'bcrypt') return false;
  return info.options.cost <= Number(rounds);
}

export async function check(value, hashed) {
  if (!hashed || typeof hashed !== 'string') return false;
  const ok = await bcrypt.compare(String(value), hashed);
  return timingSafeEqual(ok ? '1' : '0', '1');
}

export function needsRehash(hashed, { rounds = 12 } = {}) {
  if (!hashed || typeof hashed !== 'string') return true;
  try {
    const r = bcrypt.getRounds(hashed);
    return r !== rounds;
  } catch {
    return true;
  }
}

// Laravel `Hash::isHashed()` (HashManager.php:97-100): `$this->driver()->info(
// $value)['algo'] !== null` - the same rule as password_get_info(). The kernel
// used a loose regex, so a `$2a$`/`$2b$` digest or a TRUNCATED one counted as
// hashed where PHP says it is not (Laravel's own isHashedDigest() is the
// faithful rule - the driver checks the digest, not its shape).
export function isHashed(value) {
  return isHashedDigest(value);
}

export default { make, makeSync, check, needsRehash, isHashed, isHashedDigest, passwordInfo, verifyConfiguration, timingSafeEqual };
