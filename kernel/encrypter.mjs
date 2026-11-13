// kernel/encrypter.mjs - Encrypter (AES-256-CBC, Laravel-compatible)
// Uses only web-standard globals: crypto.subtle, atob/btoa, TextEncoder/TextDecoder.

import {
  bytesToHex,
  timingSafeEqual,
  base64ToBytes as b64DecodeToBytes,
  bytesToBase64 as b64EncodeBytes,
} from './digest.mjs';

// Re-exported so the Encrypter's public surface (csrf.mjs, storage.mjs,
// worker.mjs) is unchanged; the rule itself lives once in digest.mjs.
export { timingSafeEqual };

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

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
