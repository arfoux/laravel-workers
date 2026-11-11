// tools/tests/packages-fortify-2fa.test.mjs — batch-2a TOTP cluster.
//
// Two layers:
//   1. kernel/packages/totp.mjs against the OFFICIAL RFC 6238 SHA-1 vectors
//      (appendix B): key "12345678901234567890" (ASCII) →
//        T=59           → 94287082
//        T=1111111109   → 07081804
//        T=1234567890   → 89005924
//   2. the fortify-two-factor port: enable / confirm / challenge / recovery
//      against a fake in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { FakeD1 } from './_batch2a-faked1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  base32Decode,
  base32Encode,
  totp,
  verifyTotp,
  hotp,
  generateSecret,
  provisioningUri as fortifyProvisioningUri,
} from '../../kernel/packages/totp.mjs';
import fortifyTwoFactor, { ensureSchema } from '../../ports/packages/fortify-two-factor.mjs';

// ---------------------------------------------------------------------------
// 1. Kernel: RFC 6238 test vectors (the acceptance gate for the whole port)
// ---------------------------------------------------------------------------

const RFC_KEY_BYTES = new TextEncoder().encode('12345678901234567890');
const RFC_SECRET = base32Encode(RFC_KEY_BYTES);

// ASCII round-trips to its own base32 ("GEZDGNBV...") and back.
test('totp: base32 encode/decode round-trips the RFC key', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(Array.from(base32Decode(RFC_SECRET)), Array.from(RFC_KEY_BYTES));
  assert.throws(() => base32Decode('INVALID!'));
});

test('totp: RFC 6238 SHA-1 vector T=59 -> 94287082', async () => {
  assert.equal(await totp(RFC_SECRET, { t: 59 }), '94287082');
});

test('totp: RFC 6238 SHA-1 vector T=1111111109 -> 07081804', async () => {
  assert.equal(await totp(RFC_SECRET, { t: 1111111109 }), '07081804');
});

test('totp: RFC 6238 SHA-1 vector T=1234567890 -> 89005924', async () => {
  assert.equal(await totp(RFC_SECRET, { t: 1234567890 }), '89005924');
});

test('totp: hotp counter is T/step (T=59, step 30 => counter 1)', async () => {
  assert.equal(await hotp(base32Decode(RFC_SECRET), 1), '94287082');
});

test('totp: verifyTotp accepts the live code, rejects a wrong one, window works', async () => {
  const t = 1234567890;
  const code = await totp(RFC_SECRET, { t });
  assert.equal(await verifyTotp(RFC_SECRET, code, { t }), true);
  assert.equal(await verifyTotp(RFC_SECRET, '00000000', { t }), false);
  assert.equal(await verifyTotp(RFC_SECRET, 'not-a-code', { t }), false);
  // code from one step in the past is accepted within the ±1 window
  const prev = await totp(RFC_SECRET, { t: t - 30 });
  assert.equal(await verifyTotp(RFC_SECRET, prev, { t }), true);
  // two steps back is outside the window
  const old = await totp(RFC_SECRET, { t: t - 60 });
  assert.equal(await verifyTotp(RFC_SECRET, old, { t }), false);
});

test('totp: generateSecret produces a canonical base32 of 32 chars', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]+$/);
  assert.equal(s.length, 32); // 20 bytes → ceil(160/5)=32 base32 chars
  assert.equal(base32Decode(s).length, 20);
});

test('totp: provisioningUri is a scan-ready otpauth://totp URI', () => {
  const uri = fortifyProvisioningUri('user@example.com', RFC_SECRET, 'Acme');
  assert.ok(uri.startsWith('otpauth://totp/Acme:user%40example.com?'));
  assert.ok(uri.includes(`secret=${RFC_SECRET}`));
  assert.ok(uri.includes('algorithm=SHA1') && uri.includes('digits=8') && uri.includes('period=30'));
});

// ---------------------------------------------------------------------------
// 2. Port: fortify-two-factor endpoints on a fake D1
// ---------------------------------------------------------------------------

function makeEnv() {
  const DB = new FakeD1();
  return { DB };
}

async function seedUser(env, email, { secret = null, codes = null, confirmed = false } = {}) {
  await ensureSchema(env); // FakeD1 auto-assigns `id` only once the table exists
  await env.DB.prepare(
    'INSERT INTO users (email, name, password, two_factor_secret, two_factor_recovery_codes, two_factor_confirmed_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(email, 'Ada', 'hashed', secret, codes, confirmed ? '2026-01-01 00:00:00' : null).run();
  return env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
}

const enableCtx = (body, identity) => ({ params: { action: 'enable' }, body, query: {}, ...identity });
const confirmCtx = (body, identity) => ({ params: { action: 'confirm' }, body, query: {}, ...identity });
const challengeCtx = (body, identity) => ({ params: { action: 'challenge' }, body, query: {}, ...identity });
const recoveryCtx = (body, identity) => ({ params: { action: 'recovery' }, body, query: {}, ...identity });

// The authenticated / pending-login identity the app hands over — the accessor
// the Worker gives every port (kernel/http.mjs: `user: () => auth.guard().user()`,
// async) or an id a middleware guard wrote onto ctx. An email from the body must
// never select the account.
const guardUser = (email, id) => async () => ({ id, email, name: 'Ada' });
const asUser = (id) => ({ user_id: id });

test('fortify-2fa: enable mints a base32 secret + 8 recovery codes, stored unconfirmed', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com');
  const res = await fortifyTwoFactor(enableCtx({ email: 'someone-else@example.com' }, { user: guardUser('ada@example.com', user.id) }), env);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.match(body.secret, /^[A-Z2-7]{32}$/);
  assert.equal(body.recovery_codes.length, 8);
  assert.ok(body.uri.startsWith('otpauth://totp/'));
  assert.equal(body.confirmed, false);

  const stored = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.equal(stored.two_factor_secret, body.secret);
  assert.equal(stored.two_factor_recovery_codes, JSON.stringify(body.recovery_codes));
  assert.equal(stored.two_factor_confirmed_at, null);
});

test('fortify-2fa: confirm flips two_factor_confirmed_at with a valid TOTP; wrong code is 422', async () => {
  const env = makeEnv();
  const secret = generateSecret();
  const user = await seedUser(env, 'ada@example.com', { secret });
  const code = await totp(secret); // current step
  const res = await fortifyTwoFactor(confirmCtx({ email: 'ada@example.com', code }, { user: guardUser('ada@example.com', user.id) }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { confirmed: true });

  const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.ok(after.two_factor_confirmed_at);
});

test('fortify-2fa: confirm with a wrong code is a 422 and does NOT flip the flag', async () => {
  const env = makeEnv();
  const secret = generateSecret();
  const user = await seedUser(env, 'ada@example.com', { secret, confirmed: true });
  const res = await fortifyTwoFactor(confirmCtx({ email: 'ada@example.com', code: '12345678' }, { user: guardUser('ada@example.com', user.id) }), env);
  assert.equal(res.status, 422);
  const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.ok(after.two_factor_confirmed_at); // unchanged
});

test('fortify-2fa: challenge authenticates only a confirmed, enabled account with the right code', async () => {
  const env = makeEnv();
  const secret = generateSecret();
  const ada = await seedUser(env, 'ada@example.com', { secret, confirmed: true });

  const code = await totp(secret);
  const okRes = await fortifyTwoFactor(challengeCtx({ email: 'ada@example.com', code }, { user: guardUser('ada@example.com', ada.id) }), env);
  assert.equal(okRes.status, 200);
  const okBody = JSON.parse(okRes.body);
  assert.equal(okBody.authenticated, true);
  assert.equal(okBody.user.email, 'ada@example.com');

  const badRes = await fortifyTwoFactor(challengeCtx({ email: 'ada@example.com', code: '99999999' }, { user: guardUser('ada@example.com', ada.id) }), env);
  assert.equal(badRes.status, 422);

  // not confirmed yet → refused even with the right code
  const bob = await seedUser(env, 'bob@example.com', { secret });
  const unconfirmed = await fortifyTwoFactor(challengeCtx({ email: 'bob@example.com', code }, { user: guardUser('bob@example.com', bob.id) }), env);
  assert.equal(unconfirmed.status, 422);
});

test('fortify-2fa: a recovery code logs in once and is consumed (replay -> 422)', async () => {
  const env = makeEnv();
  const codes = ['AAAA1111-BBBB2222', 'CCCC3333-DDDD4444', 'EEEE5555-FFFF6666'];
  const ada = await seedUser(env, 'ada@example.com', { secret: generateSecret(), codes: JSON.stringify(codes), confirmed: true });

  const res = await fortifyTwoFactor(recoveryCtx({ email: 'ada@example.com', code: codes[1] }, { user: guardUser('ada@example.com', ada.id) }), env);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.authenticated, true);
  assert.equal(body.remaining, 2);

  const stored = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(ada.id).first();
  assert.deepEqual(JSON.parse(stored.two_factor_recovery_codes), [codes[0], codes[2]]);

  // replay of the consumed code is refused
  const replay = await fortifyTwoFactor(recoveryCtx({ email: 'ada@example.com', code: codes[1] }, { user: guardUser('ada@example.com', ada.id) }), env);
  assert.equal(replay.status, 422);
});

test('fortify-2fa: no identity is a 401 and touches nothing (email is not a credential)', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com', { secret: generateSecret(), confirmed: true });
  assert.equal((await fortifyTwoFactor(enableCtx({ email: 'ada@example.com' }), env)).status, 401);
  assert.equal((await fortifyTwoFactor(confirmCtx({ email: 'ada@example.com', code: '123456' }), env)).status, 401);
  assert.equal((await fortifyTwoFactor(challengeCtx({ email: 'ada@example.com' }), env)).status, 401);
  assert.equal((await fortifyTwoFactor(recoveryCtx({ email: 'ada@example.com' }), env)).status, 401);
  // the victim's row is untouched
  const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.ok(after.two_factor_secret);
  assert.ok(after.two_factor_confirmed_at);
});

test('fortify-2fa: the body email selects nothing for another identity (no cross-account)', async () => {
  const env = makeEnv();
  const adaSecret = generateSecret();
  const ada = await seedUser(env, 'ada@example.com', { secret: adaSecret, confirmed: true });
  const bob = await seedUser(env, 'bob@example.com');
  const res = await fortifyTwoFactor(enableCtx({ email: 'ada@example.com' }, { user: guardUser('bob@example.com', bob.id) }), env);
  assert.equal(res.status, 200);
  const saved = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(bob.id).first();
  assert.ok(saved.two_factor_secret, 'the secret must belong to the authenticated user (bob), not the email');
  const adaAfter = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(ada.id).first();
  assert.equal(adaAfter.two_factor_secret, adaSecret, 'ada (the email in the body) must be untouched');
});


test("fortify-2fa: an authenticated request whose user row is gone is a 401 (no 404 for the body email)", async () => {
  const env = makeEnv();
  // A guard may resolve an id with no row (deleted account / stale session):
  assert.equal((await fortifyTwoFactor(enableCtx({ email: 'nobody@example.com' }, { user: guardUser('nobody@example.com', 9999) }), env)).status, 401);
  assert.equal((await fortifyTwoFactor(challengeCtx({ email: 'nobody@example.com' }, { user: guardUser('nobody@example.com', 9999) }), env)).status, 401);
});
