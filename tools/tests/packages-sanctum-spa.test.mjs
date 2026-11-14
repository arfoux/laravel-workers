// tools/tests/packages-sanctum-spa.test.mjs — batch-2a, Sanctum SPA cookie
// mode (CSRF double-submit + HttpOnly session cookie), the complement to the
// PAT port.
//
// Drives the real handlers against a fake D1 with a real bcrypt password.
// Exercises the full SPA handshake: csrf-cookie → login (CSRF + creds) →
// session-cookie user → logout, plus the negative paths (missing/mismatched
// CSRF, wrong password, forged session cookie, logout invalidates the session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { FakeD1 } from './_fake-d1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import spa, { ensureSchema as ensureSpaSchema } from '../../ports/packages/sanctum-spa-cookie.mjs';

const APP_KEY = 'base64:spa-test-key';
const req = (method, { cookie, xsrf } = {}) =>
  new Request('https://app.test/', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
    },
  });

function makeEnv() {
  return { DB: new FakeD1(), APP_KEY };
}

async function seedUser(env, email, password = 'spa-password') {
  await ensureSpaSchema(env);
  const hash = await bcrypt.hash(password, 10);
  await env.DB.prepare('INSERT INTO users (email, name, password) VALUES (?, ?, ?)')
    .bind(email, 'Ada', hash).run();
  return env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
}

function setCookies(res) {
  const raw = res.headers['set-cookie'] || '';
  const out = {};
  for (const line of raw.split('\n')) {
    const m = /^([^=]+)=([^;]*)/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('sanctum-spa: csrf-cookie mints a readable XSRF-TOKEN cookie (not HttpOnly)', async () => {
  const env = makeEnv();
  const res = await spa({ params: { action: 'csrf' }, body: {}, query: {}, request: req('GET') }, env);
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  assert.match(cookies['XSRF-TOKEN'], /^[A-Za-z0-9]{40}$/);
  assert.doesNotMatch(res.headers['set-cookie'], /HttpOnly/); // SPA must read it
});

test('sanctum-spa: login without a matching CSRF header is a 419', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const res = await spa(
    { params: { action: 'login' }, body: { email: 'ada@example.com', password: 'spa-password' }, query: {}, request: req('POST', { cookie: 'XSRF-TOKEN=abc', xsrf: 'different' }) },
    env
  );
  assert.equal(res.status, 419);
});

test('sanctum-spa: a malformed cookie escape is a 419, not a 500', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  // `decodeURIComponent('%')` used to throw out of readCookie, so the client's
  // own Cookie header turned a CSRF mismatch into a 500.
  const res = await spa(
    { params: { action: 'login' }, body: { email: 'ada@example.com', password: 'spa-password' }, query: {}, request: req('POST', { cookie: 'XSRF-TOKEN=%', xsrf: 'different' }) },
    env
  );
  assert.equal(res.status, 419);
});

test('sanctum-spa: login with CSRF + correct password sets an HttpOnly session cookie', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const csrf = await spa({ params: { action: 'csrf' }, body: {}, query: {}, request: req('GET') }, env);
  const xsrf = setCookies(csrf)['XSRF-TOKEN'];

  const res = await spa(
    {
      params: { action: 'login' },
      body: { email: 'ada@example.com', password: 'spa-password' },
      query: {},
      request: req('POST', { cookie: `XSRF-TOKEN=${xsrf}`, xsrf }),
    },
    env
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.email, 'ada@example.com');

  const cookies = setCookies(res);
  assert.ok(cookies['laravel_session']);
  assert.match(res.headers['set-cookie'], /laravel_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
  // the session id is HMAC-signed (opaque), not the raw row id
  assert.match(cookies['laravel_session'], /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);

  // a session row exists server-side
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE user_id = ?1').bind(body.user.id).first();
  assert.ok(session);
});

test('sanctum-spa: wrong password is a 422 and mints no session', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const csrf = await spa({ params: { action: 'csrf' }, body: {}, query: {}, request: req('GET') }, env);
  const xsrf = setCookies(csrf)['XSRF-TOKEN'];
  const res = await spa(
    { params: { action: 'login' }, body: { email: 'ada@example.com', password: 'nope' }, query: {}, request: req('POST', { cookie: `XSRF-TOKEN=${xsrf}`, xsrf }) },
    env
  );
  assert.equal(res.status, 422);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first();
  assert.equal(n.n, 0);
});

test('sanctum-spa: the session cookie resolves to the user (GET /sanctum/spa/user)', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const xsrf = setCookies(await spa({ params: { action: 'csrf' }, body: {}, query: {}, request: req('GET') }, env))['XSRF-TOKEN'];
  const login = await spa(
    { params: { action: 'login' }, body: { email: 'ada@example.com', password: 'spa-password' }, query: {}, request: req('POST', { cookie: `XSRF-TOKEN=${xsrf}`, xsrf }) },
    env
  );
  const session = setCookies(login)['laravel_session'];

  const res = await spa(
    { params: { action: 'user' }, body: {}, query: {}, request: req('GET', { cookie: `laravel_session=${session}` }) },
    env
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).user.email, 'ada@example.com');
});

test('sanctum-spa: a forged session cookie is rejected (signature check)', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const res = await spa(
    { params: { action: 'user' }, body: {}, query: {}, request: req('GET', { cookie: 'laravel_session=forgedPayload.deadbeef' }) },
    env
  );
  assert.equal(res.status, 401);
});

test('sanctum-spa: logout with CSRF deletes the session; the cookie no longer authenticates', async () => {
  const env = makeEnv();
  await seedUser(env, 'ada@example.com');
  const xsrf = setCookies(await spa({ params: { action: 'csrf' }, body: {}, query: {}, request: req('GET') }, env))['XSRF-TOKEN'];
  const login = await spa(
    { params: { action: 'login' }, body: { email: 'ada@example.com', password: 'spa-password' }, query: {}, request: req('POST', { cookie: `XSRF-TOKEN=${xsrf}`, xsrf }) },
    env
  );
  const session = setCookies(login)['laravel_session'];

  const out = await spa(
    { params: { action: 'logout' }, body: {}, query: {}, request: req('POST', { cookie: `laravel_session=${session}; XSRF-TOKEN=${xsrf}`, xsrf }) },
    env
  );
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).logged_out, true);

  // the row is gone and the (still-present) cookie no longer resolves
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first();
  assert.equal(n.n, 0);
  const after = await spa(
    { params: { action: 'user' }, body: {}, query: {}, request: req('GET', { cookie: `laravel_session=${session}` }) },
    env
  );
  assert.equal(after.status, 401);
});

test('sanctum-spa: missing APP_KEY is a 500 (secret from env, never hardcoded)', async () => {
  const env = { DB: new FakeD1() }; // no APP_KEY
  const res = await spa({ params: { action: 'user' }, body: {}, query: {}, request: req('GET', { cookie: 'laravel_session=whatever.sig' }) }, env);
  assert.equal(res.status, 500);
});
