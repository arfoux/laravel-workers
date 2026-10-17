import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptString, decryptString } from '../encrypter.mjs';

function b64(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const key = b64(32);

test('encrypter round-trip', async () => {
  for (const plain of ['', 'hello', 'Hello, World!', 'a'.repeat(300), 'unicode: café — ☕ 🎉', 'special: <>&\'"', '0']) {
    const payload = await encryptString(plain, key);
    const dec = await decryptString(payload, key);
    assert.equal(dec, plain);
  }
});

test('encrypter random IV uniqueness', async () => {
  const a = await encryptString('same', key);
  const b = await encryptString('same', key);
  assert.notEqual(a, b);
});

test('encrypter tamper rejects (MAC)', async () => {
  const payload = await encryptString('tamper me', key);
  const raw = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
  // flip byte inside base64-decoded JSON payload
  raw[20] ^= 0xFF;
  let bin = '';
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  const tampered = btoa(bin);
  await assert.rejects(() => decryptString(tampered, key));
});

test('encrypter wrong key rejects', async () => {
  const payload = await encryptString('secret', key);
  const wrongKey = b64(32);
  await assert.rejects(() => decryptString(payload, wrongKey));
});
