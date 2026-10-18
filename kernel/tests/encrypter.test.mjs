import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptString, decryptString, timingSafeEqual } from '../encrypter.mjs';

function b64(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const key = b64(32);

test('encrypter round-trip', async () => {
  for (const plain of ['', 'hello', 'Hello, World!', 'a'.repeat(300), 'unicode: café — ☕ 🎉', 'special: <>&\'' + '"', '0']) {
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

test('encrypter tampered MAC/tag fails', async () => {
  const payload = await encryptString('mac-test', key);
  const json = atob(payload);
  const obj = JSON.parse(json);
  obj.mac = obj.mac.slice(0, -1) + (obj.mac.slice(-1) === '0' ? '1' : '0');
  const tampered = btoa(JSON.stringify(obj));
  await assert.rejects(() => decryptString(tampered, key), /MAC invalid/);
});

test('encrypter modified ciphertext fails', async () => {
  const payload = await encryptString('cipher-test', key);
  const json = atob(payload);
  const obj = JSON.parse(json);
  const valBytes = Uint8Array.from(atob(obj.value), c => c.charCodeAt(0));
  valBytes[0] ^= 0x01;
  let bin = '';
  for (let i = 0; i < valBytes.length; i++) bin += String.fromCharCode(valBytes[i]);
  obj.value = btoa(bin);
  const tampered = btoa(JSON.stringify(obj));
  await assert.rejects(() => decryptString(tampered, key));
});

test('encrypter changed iv byte fails', async () => {
  const payload = await encryptString('iv-test', key);
  const json = atob(payload);
  const obj = JSON.parse(json);
  const ivBytes = Uint8Array.from(atob(obj.iv), c => c.charCodeAt(0));
  ivBytes[0] ^= 0xFF;
  let bin = '';
  for (let i = 0; i < ivBytes.length; i++) bin += String.fromCharCode(ivBytes[i]);
  obj.iv = btoa(bin);
  const tampered = btoa(JSON.stringify(obj));
  await assert.rejects(() => decryptString(tampered, key), /MAC invalid/);
});

test('encrypter valid roundTrip still passes', async () => {
  const plain = 'valid roundTrip check — 123';
  const payload = await encryptString(plain, key);
  const dec = await decryptString(payload, key);
  assert.equal(dec, plain);
});

test('encrypter timingSafeEqual zero-length handled', async () => {
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
});
