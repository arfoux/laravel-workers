import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  make,
  makeSync,
  check,
  needsRehash,
  isHashed,
  isHashedDigest,
  passwordInfo,
  verifyConfiguration,
  timingSafeEqual,
} from '../hash.mjs';

// PHP 8.3 password_get_info() oracle values (fresh-app vendor, 2026-10-19).
const HASH10 = '$2y$10$cyT1llBUHIVeZFxw/hKj0eIeqIJNsMI0SUhpbh6K5FWh7NxcNqnf.';
const HASH12 = '$2y$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH14 = '$2y$14$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH12_A = '$2a$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH12_B = '$2b$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const SHORT_2Y = '$2y$10$abcdefghijklmnopqrstuv';
const ARGON = '$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$abc';

test('hash round-trip (bcrypt)', async () => {
  const h = await make('hello', { rounds: 4 });
  assert.equal(h.slice(0, 7), '$2a$04$');
  assert.equal(await check('hello', h), true);
  assert.equal(await check('wrong', h), false);
  assert.equal(await check('hello', ''), false);
});

test('hash needsRehash', async () => {
  const h4 = await make('x', { rounds: 4 });
  assert.equal(needsRehash(h4, { rounds: 4 }), false);
  assert.equal(needsRehash(h4, { rounds: 10 }), true);
  assert.equal(needsRehash('not a hash', { rounds: 10 }), true);
});

test('isHashed detects bcrypt/argon2 digests', async () => {
  const h = await make('hello', { rounds: 4 });
  assert.equal(isHashed(h), true);
  assert.equal(isHashed('$2y$10$abcdefghijklmnopqrstuv'), true);
  assert.equal(isHashed('$argon2id$v=19$m=65536'), true);
  assert.equal(isHashed('plain'), false);
  assert.equal(isHashed(''), false);
  assert.equal(isHashed(null), false);
  assert.equal(isHashed(123), false);
});

test('hash empty/long unicode', async () => {
  for (const v of ['', 'a'.repeat(72), 'unicode: café — \u0007 emoji 👩‍💻']) {
    const h = await make(v, { rounds: 4 });
    assert.equal(await check(v, h), true);
  }
});

test('hash same password different salts both verify', async () => {
  const h1 = await make('same-password', { rounds: 4 });
  const h2 = await make('same-password', { rounds: 4 });
  assert.notEqual(h1, h2);
  assert.equal(await check('same-password', h1), true);
  assert.equal(await check('same-password', h2), true);
});

test('hash forged byte-flip fails', async () => {
  const h = await make('secret123', { rounds: 4 });
  const arr = h.split('');
  arr[20] = arr[20] === 'a' ? 'b' : 'a';
  const forged = arr.join('');
  assert.equal(await check('secret123', forged), false);
});

test('hash timingSafeEqual zero-length handled', async () => {
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  assert.equal(timingSafeEqual('', 'a'), false);
  assert.equal(timingSafeEqual('a', ''), false);
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual(new Uint8Array([1,2,3]), new Uint8Array([1,2,3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1,2,3]), new Uint8Array([1,2,4])), false);
});

test('makeSync emits PHP 8.3 $2y$ digests and verifies', async () => {
  const h = makeSync('secret', { rounds: 4 });
  assert.equal(h.slice(0, 7), '$2y$04$');
  assert.equal(h.length, 60);
  assert.equal(await check('secret', h), true);
  assert.equal(await check('wrong', h), false);
  assert.equal(makeSync('secret', { rounds: 4 }).slice(0, 7), '$2y$04$');
});

test('passwordInfo mirrors PHP 8.3 password_get_info()', () => {
  assert.deepEqual(passwordInfo(HASH10), { algo: '2y', algoName: 'bcrypt', options: { cost: 10 } });
  assert.deepEqual(passwordInfo(HASH12), { algo: '2y', algoName: 'bcrypt', options: { cost: 12 } });
  assert.equal(passwordInfo(HASH12_A).algo, null);
  assert.equal(passwordInfo(HASH12_B).algo, null);
  assert.equal(passwordInfo(SHORT_2Y).algo, null);
  assert.equal(passwordInfo(ARGON).algo, 'argon2id');
  assert.equal(passwordInfo(ARGON).algoName, 'argon2id');
  assert.equal(passwordInfo('plain').algo, null);
  assert.equal(passwordInfo('').algo, null);
  assert.equal(passwordInfo(null).algo, null);
  assert.equal(passwordInfo(123).algo, null);
});

test('isHashedDigest uses exact HashManager::isHashed semantics', () => {
  assert.equal(isHashedDigest(HASH10), true);
  assert.equal(isHashedDigest(HASH12), true);
  assert.equal(isHashedDigest(HASH12_A), false);
  assert.equal(isHashedDigest(HASH12_B), false);
  assert.equal(isHashedDigest(SHORT_2Y), false);
  assert.equal(isHashedDigest(ARGON), true);
  assert.equal(isHashedDigest('plain'), false);
  assert.equal(isHashedDigest(null), false);
  // The loose helper keeps its historical, permissive behavior.
  assert.equal(isHashed(HASH12_A), true);
  assert.equal(isHashed(SHORT_2Y), true);
});

test('verifyConfiguration accepts cost <= rounds and rejects others', () => {
  assert.equal(verifyConfiguration(HASH10, { rounds: 12 }), true);
  assert.equal(verifyConfiguration(HASH12, { rounds: 12 }), true);
  assert.equal(verifyConfiguration(HASH14, { rounds: 12 }), false);
  assert.equal(verifyConfiguration(HASH12, { rounds: 10 }), false);
  assert.equal(verifyConfiguration(HASH12_A, { rounds: 12 }), false);
  assert.equal(verifyConfiguration(SHORT_2Y, { rounds: 12 }), false);
  assert.equal(verifyConfiguration(ARGON, { rounds: 12 }), false);
  assert.equal(verifyConfiguration('plain', { rounds: 12 }), false);
  assert.equal(verifyConfiguration(null, { rounds: 12 }), false);
});
