// edge/spikes/encrypter/js-encrypter.mjs — Laravel Encrypter (AES-256-CBC) parity, Workers-compatible
// Uses only web-standard globals: crypto.subtle, atob/btoa, TextEncoder/TextDecoder.

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

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

  const json = atob(payloadBase64);
  const payload = JSON.parse(json);

  // MAC check (constant-time)
  const expectedMacBuf = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload.iv + payload.value));
  const expectedMac = bytesToHex(new Uint8Array(expectedMacBuf));
  if (!constantTimeEqual(expectedMac, payload.mac)) {
    throw new Error('MAC invalid');
  }

  const iv = b64DecodeToBytes(payload.iv);
  const ctBytes = b64DecodeToBytes(payload.value);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ctBytes);
  return new TextDecoder().decode(ptBuf);
}

// Convenience sync-ish wrappers not possible (crypto.subtle is async). Export async only.
export default { encryptString, decryptString };
