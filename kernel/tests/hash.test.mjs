import { test } from 'node:test';
import assert from 'node:assert/strict';
import { make, check, needsRehash, isHashed } from '../hash.mjs';

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
