// tools/tests/packages-fortify-confirmation.test.mjs — batch-2a, Fortify
// password confirmation + email verification (signed URL).
//
// Drives the real handlers against a fake D1. bcrypt is the real bcryptjs
// (same algorithm Laravel emits for `$2y$`). The signed verification URL is
// built by the send-verification action and then consumed by verify — the full
// Laravel `temporarySignedRoute` round trip — plus tamper / expiry / wrong-hash
// rejections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { FakeD1 } from './_batch2a-faked1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import fortifyConfirmation, { ensureSchema as ensureConfirmationSchema } from '../../ports/packages/fortify-confirmation.mjs';
import { signPath } from '../../kernel/packages/signedurl.mjs';

const APP_KEY = 'base64:test-app-key';

function makeEnv() {
  return { DB: new FakeD1(), APP_KEY };
}

async function seedUser(env, email, password = 'correct-horse', { verified = false } = {}) {
  await ensureConfirmationSchema(env);
  const hash = await bcrypt.hash(password, 10);
  await env.DB.prepare(
    'INSERT INTO users (email, name, password, email_verified_at) VALUES (?, ?, ?, ?)'
  ).bind(email, 'Ada', hash, verified ? '2026-01-01 00:00:00' : null).run();
  return env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
}

const confirmCtx = (body) => ({ params: { action: 'confirm-password' }, body, query: {} });
const statusCtx = (query) => ({ params: { action: 'confirm-status' }, body: {}, query });
const sendCtx = (body) => ({ params: { action: 'send-verification' }, body, query: {} });
const verifyCtx = (id, hash, query) => ({ params: { action: 'verify', id, hash }, body: {}, query });

test('fortify-confirmation: correct password confirms and stamps password_confirmed_at', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const res = await fortifyConfirmation(confirmCtx({ email: 'ada@example.com', password: 'correct-horse' }), env);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.confirmed, true);
  assert.ok(body.confirmed_at);

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind('ada@example.com').first();
  assert.equal(user.password_confirmed_at, body.confirmed_at);
});

test('fortify-confirmation: wrong password is a 422 and does not stamp', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const res = await fortifyConfirmation(confirmCtx({ email: 'ada@example.com', password: 'wrong' }), env);
  assert.equal(res.status, 422);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind('ada@example.com').first();
  assert.ok(user.password_confirmed_at == null);
});

test('fortify-confirmation: status is false before confirm and true after', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const before = JSON.parse((await fortifyConfirmation(statusCtx({ email: 'ada@example.com' }), env)).body);
  assert.equal(before.confirmed, false);

  await fortifyConfirmation(confirmCtx({ email: 'ada@example.com', password: 'correct-horse' }), env);
  const after = JSON.parse((await fortifyConfirmation(statusCtx({ email: 'ada@example.com' }), env)).body);
  assert.equal(after.confirmed, true);
});

test('fortify-confirmation: send-verification mints a Laravel-shaped signed URL', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com');
  const res = await fortifyConfirmation(sendCtx({ email: 'ada@example.com', base_url: 'https://app.test' }), env);
  assert.equal(res.status, 200);
  const { verification_url } = JSON.parse(res.body);
  assert.match(verification_url, /^https:\/\/app\.test\/email\/verify\/\d+\/[0-9a-f]{40}\?expires=\d+&signature=[0-9a-f]{64}$/);
  // the hash segment is sha1(email) — not reversible, binds the link to the account
  assert.ok(verification_url.includes(user.id + '/'));
});

test('fortify-confirmation: the minted URL verifies and flips email_verified_at', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com');
  const { verification_url } = JSON.parse(
    (await fortifyConfirmation(sendCtx({ email: 'ada@example.com', base_url: 'https://app.test' }), env)).body
  );
  const u = new URL(verification_url);
  const [, , , id, hash] = u.pathname.split('/');
  const res = await fortifyConfirmation(verifyCtx(id, hash, {
    expires: u.searchParams.get('expires'),
    signature: u.searchParams.get('signature'),
  }), env);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).verified, true);
  const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.ok(after.email_verified_at);
});

test('fortify-confirmation: a tampered signature is rejected (403), no verification', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com');
  const { verification_url } = JSON.parse(
    (await fortifyConfirmation(sendCtx({ email: 'ada@example.com', base_url: 'https://app.test' }), env)).body
  );
  const u = new URL(verification_url);
  const [, , , id, hash] = u.pathname.split('/');
  const badSig = 'f'.repeat(64);
  const res = await fortifyConfirmation(verifyCtx(id, hash, {
    expires: u.searchParams.get('expires'),
    signature: badSig,
  }), env);
  assert.equal(res.status, 403);
  const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  assert.equal(after.email_verified_at, null);
});

test('fortify-confirmation: an expired link is rejected (403 expired)', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com');
  const sha1 = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const hash = await sha1('ada@example.com');
  const path = `/email/verify/${user.id}/${hash}`;
  const past = Math.floor(Date.now() / 1000) - 10;
  const signature = await signPath(`${path}?expires=${past}`, APP_KEY.replace(/^base64:/, ''));
  const res = await fortifyConfirmation(verifyCtx(user.id, hash, { expires: String(past), signature }), env);
  assert.equal(res.status, 403);
  const body = JSON.parse(res.body);
  assert.match(body.message, /expired/i);
});

test('fortify-confirmation: a link for a different account is rejected (403)', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  await seedUser(env, 'mallory@example.com');
  // mint for ada, then present it against mallory's id
  const { verification_url } = JSON.parse(
    (await fortifyConfirmation(sendCtx({ email: 'ada@example.com', base_url: 'https://app.test' }), env)).body
  );
  const mallory = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind('mallory@example.com').first();
  const u = new URL(verification_url);
  const adaHash = u.pathname.split('/')[3];
  const res = await fortifyConfirmation(verifyCtx(mallory.id, adaHash, {
    expires: u.searchParams.get('expires'),
    signature: u.searchParams.get('signature'),
  }), env);
  // the signature was computed over ada's id, so mallory's id breaks it
  assert.equal(res.status, 403);
});

test('fortify-confirmation: already-verified user is idempotent (200)', async () => {
  const env = makeEnv();
  const user = await seedUser(env, 'ada@example.com', 'correct-horse', { verified: true });
  const { verification_url, already_verified } = JSON.parse(
    (await fortifyConfirmation(sendCtx({ email: 'ada@example.com', base_url: 'https://app.test' }), env)).body
  );
  assert.equal(already_verified, true);
  assert.equal(verification_url, null);
  void user;
});
