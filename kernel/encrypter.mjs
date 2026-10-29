// kernel/encrypter.mjs - Encrypter (AES-256-CBC, Laravel-compatible)
// Uses only web-standard globals: crypto.subtle, atob/btoa, TextEncoder/TextDecoder.

/**
 * Illuminate\Contracts\Encryption\DecryptException. Every decryption failure
 * (bad base64, malformed JSON envelope, missing field, bad MAC) answers this
 * class, which is what the PHP side throws and what cookie/CSRF callers catch.
 */
export class DecryptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptException';
    this.phpClass = 'Illuminate\\Contracts\\Encryption\\DecryptException';
  }
}

function b64EncodeBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64DecodeToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

async function importAesKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

async function importHmacKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function encryptString(plaintext, keyBase64) {
  const keyBytes = b64DecodeToBytes(keyBase64);
  const aesKey = await importAesKey(keyBytes);
  const hmacKey = await importHmacKey(keyBytes);

  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv);

  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, ptBytes);
  const ctBytes = new Uint8Array(ctBuf);

  const ivB64 = b64EncodeBytes(iv);
  const valueB64 = b64EncodeBytes(ctBytes);

  const macBuf = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(ivB64 + valueB64));
  const macHex = bytesToHex(new Uint8Array(macBuf));

  const payload = { iv: ivB64, value: valueB64, mac: macHex, tag: '' };
  const json = JSON.stringify(payload); // field order iv,value,mac,tag matches Laravel json_encode
  return btoa(json);
}

export async function decryptString(payloadBase64, keyBase64) {
  const keyBytes = b64DecodeToBytes(keyBase64);
  const aesKey = await importAesKey(keyBytes);
  const hmacKey = await importHmacKey(keyBytes);

  // DecryptException, like the PHP oracle (tools/php-crypto-oracle.php:48):
  // a payload that is not base64/JSON, or whose envelope lacks iv/value/mac,
  // is a decryption FAILURE - not the SyntaxError/TypeError that used to
  // escape. Callers (cookies.mjs, csrf.mjs) catch this class only.
  let payload;
  try {
    payload = JSON.parse(atob(payloadBase64));
  } catch {
    throw new DecryptError('The payload is invalid.');
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.iv !== 'string' ||
    typeof payload.value !== 'string' ||
    typeof payload.mac !== 'string'
  ) {
    throw new DecryptError('The payload is invalid.');
  }

  // MAC check (constant-time) - replaces early-exit string ===
  const expectedMacBuf = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload.iv + payload.value));
  const expectedMac = bytesToHex(new Uint8Array(expectedMacBuf));
  if (!timingSafeEqual(expectedMac, payload.mac)) {
    throw new DecryptError('MAC invalid');
  }

  const iv = b64DecodeToBytes(payload.iv);
  const ctBytes = b64DecodeToBytes(payload.value);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ctBytes);
  return new TextDecoder().decode(ptBuf);
}

// Convenience sync-ish wrappers not possible (crypto.subtle is async). Export async only.
export default { encryptString, decryptString, timingSafeEqual, DecryptError };
