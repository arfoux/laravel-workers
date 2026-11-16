// kernel/tests/hmac.test.mjs — direct coverage of the one async HMAC-SHA256
// primitive at the edge. The vectors below are fixed HMAC-SHA256 answers, so
// the test is an independent oracle: it does not re-pin the source text and it
// needs no external binary (WebCrypto is built into Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hmacSha256Bytes, hmacSha256Hex, hmacSha256Base64 } from '../hmac.mjs';
import { bytesToHex, bytesToBase64 } from '../digest.mjs';

const VECTORS = [
  {
    secret: 'key',
    message: 'The quick brown fox jumps over the lazy dog',
    hex: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    base64: '97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=',
  },
  {
    secret: 'key',
    message: '',
    hex: '5d5d139563c95b5967b9bd9a8c9b233a9dedb45072794cd232dc1b74832607d0',
    base64: 'XV0TlWPJW1lnub2ajJsjOp3ttFByeUzSMtwbdIMmB9A=',
  },
  // WebCrypto's importKey rejects a zero-length HMAC key, so all vectors use a
  // non-empty secret; this one still covers a different key/message pair.
  {
    secret: 'secret',
    message: 'payload',
    hex: 'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4',
    base64: 'uC/LeRrOxXhZuYm0MKgmSIzi5Hn9+SMmvQoug3WkK6Q=',
  },
];

test('hmacSha256Hex answers known HMAC-SHA256 vectors', async () => {
  for (const v of VECTORS) {
    assert.equal(await hmacSha256Hex(v.secret, v.message), v.hex);
  }
});

test('hmacSha256Base64 answers the same vectors in base64', async () => {
  for (const v of VECTORS) {
    assert.equal(await hmacSha256Base64(v.secret, v.message), v.base64);
  }
});

test('hmacSha256Bytes is the raw 32-byte digest behind hex and base64', async () => {
  for (const v of VECTORS) {
    const bytes = await hmacSha256Bytes(v.secret, v.message);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 32);
    assert.equal(bytesToHex(bytes), v.hex);
    assert.equal(bytesToBase64(bytes), v.base64);
  }
});

test('hmac coerces a numeric secret and non-string messages with String()', async () => {
  // hmacSha256Hex(123, 'x') == HMAC('123', 'x'), not HMAC over a 123-type value.
  assert.equal(
    await hmacSha256Hex(123, 'x'),
    'a263c013566015a22eac8b563b8223cc002f3bdf176f7d23df48d0d00dc92d68'
  );
  assert.equal(await hmacSha256Hex(123, 'x'), await hmacSha256Hex('123', 'x'));
  assert.equal(
    await hmacSha256Hex('k', 42),
    '7955074f51169f1f64053d8b2c403d7f41ee7ca4f3f9fe1c7b84f91083f2c50a'
  );
  assert.equal(await hmacSha256Hex('k', 42), await hmacSha256Hex('k', '42'));
  assert.equal(await hmacSha256Hex('k', null), await hmacSha256Hex('k', 'null'));
  assert.equal(await hmacSha256Hex('k', undefined), await hmacSha256Hex('k', 'undefined'));
  assert.equal(await hmacSha256Hex('k', true), await hmacSha256Hex('k', 'true'));
});

test('hmac argument order is (secret, message), not the reverse', async () => {
  const secret = 'a-secret';
  const message = 'a-message';
  const forward = await hmacSha256Hex(secret, message);
  // An independent implementation: the FIRST argument is the key.
  assert.equal(forward, createHmac('sha256', secret).update(message).digest('hex'));
  assert.notEqual(forward, await hmacSha256Hex(message, secret));
  assert.equal(
    await hmacSha256Hex('message', 'secret'),
    'd074bcd3007e437b849cc71b3f3e066632466ec8ee43e09f7c27e32b9b615403'
  );
});
