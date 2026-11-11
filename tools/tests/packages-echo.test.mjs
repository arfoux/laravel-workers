// tools/tests/packages-echo.test.mjs — laravel/echo broadcast-auth half.
// ports/packages/echo.mjs answers POST /broadcasting/auth for Echo clients:
// Bearer Sanctum token → user id → D1 `channel_memberships` membership check →
// signed `{auth}` (private) / `{auth, channel_data}` (presence). Exercised for
// real against an in-memory FakeD1 (no network, no real D1). Signing is cross-
// checked byte-for-byte against node:crypto HMAC-SHA256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHmac } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import handle, { ensureSchema } from '../../ports/packages/echo.mjs';
import { createPersonalAccessToken } from '../../kernel/packages/token.mjs';
import { FakeD1 } from './_batch2a-faked1.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const json = (res) => JSON.parse(res.body);

// Drive the route. `auth` is the plaintext Sanctum token (or null for none).
function ctx({ auth = null, socketId = '1.1', channelName = 'private-room', body } = {}) {
  const headers = {};
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  return {
    body: body !== undefined ? body : new URLSearchParams({ socket_id: socketId, channel_name: channelName }),
    request: { headers },
  };
}

// Mint a Sanctum plaintext token (`{id}|{random}`) and persist its sha256 row,
// exactly the shape kernel/packages/token.mjs + the `sanctum` port produce.
async function seedToken(db, { id = 1, userId = 42, plain } = {}) {
  const { plain: minted, row } = await createPersonalAccessToken(userId, 'echo-test', [], { id });
  const usePlain = plain ?? minted;
  await db.prepare(
    'INSERT INTO personal_access_tokens (id, tokenable_id, token) VALUES (?, ?, ?)'
  ).bind(id, row.tokenable_id, row.token).run();
  return usePlain;
}

// Grant (user, channel) access in the edge's stand-in for Broadcast::channel().
async function grant(db, { userId = 42, channel = 'private-room' } = {}) {
  await db.prepare('INSERT INTO channel_memberships (user_id, channel) VALUES (?, ?)')
    .bind(userId, channel).run();
}

const ENV = { BROADCAST_KEY: 'ek', BROADCAST_SECRET: 'es' };

// ---- Schema ----------------------------------------------------------------

test('echo: ensureSchema creates channel_memberships (id, user_id, channel, created_at)', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const cols = Object.keys(db.tables.get('channel_memberships')[0] || {});
  // Empty table → still registered; a row round-trips through the port later.
  assert.equal(db.tables.has('channel_memberships'), true);
  await ensureSchema({ DB: db }); // idempotent
  await grant(db, { userId: 1, channel: 'private-x' });
  const row = db.tables.get('channel_memberships')[0];
  assert.equal(row.user_id, 1);
  assert.equal(row.channel, 'private-x');
});

// ---- auth succeeds -----------------------------------------------------------

test('echo: valid token + member private channel → 200 {auth} byte-parity with HMAC', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 1, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' });

  const socketId = '99.1';
  const res = await handle(ctx({ auth: plain, socketId }), { ...ENV, DB: db });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  const { auth } = json(res);
  const expected = 'ek.' + createHmac('sha256', 'es').update(`${socketId}:private-room`).digest('hex');
  assert.equal(auth, expected);
});

test('echo: valid token + member presence channel → 200 {auth, channel_data} embedding the user', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 2, userId: 7 });
  await grant(db, { userId: 7, channel: 'presence-room' });

  const res = await handle(ctx({ auth: plain, channelName: 'presence-room' }), { ...ENV, DB: db });

  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.auth, 'ek.' + createHmac('sha256', 'es').update(`1.1:presence-room`).digest('hex'));
  assert.deepEqual(JSON.parse(body.channel_data), { user_id: 7 });
});

test('echo: config falls back to REVERB_KEY/SECRET when BROADCAST_* absent', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 3, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' });

  const res = await handle(ctx({ auth: plain }), { REVERB_KEY: 'rk', REVERB_SECRET: 'rs', DB: db });
  assert.equal(res.status, 200);
  const expected = 'rk.' + createHmac('sha256', 'rs').update('1.1:private-room').digest('hex');
  assert.equal(json(res).auth, expected);
});

// ---- unauthorized channel ----------------------------------------------------

test('echo: valid token but no membership → 403', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 4, userId: 42 });
  // NOTE: no grant() — user 42 is NOT a member of private-secret.
  const res = await handle(ctx({ auth: plain, channelName: 'private-secret' }), { ...ENV, DB: db });
  assert.equal(res.status, 403);
  assert.equal(json(res).message, 'This action is unauthorized.');
});

test('echo: another user\'s membership does not grant this user → 403', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 5, userId: 99 });
  await grant(db, { userId: 42, channel: 'private-room' }); // someone else is a member
  const res = await handle(ctx({ auth: plain, channelName: 'private-room' }), { ...ENV, DB: db });
  assert.equal(res.status, 403);
});

test('echo: public channel never authed → 403', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 6, userId: 42 });
  await grant(db, { userId: 42, channel: 'public-news' }); // even if somehow granted
  const res = await handle(ctx({ auth: plain, channelName: 'public-news' }), { ...ENV, DB: db });
  assert.equal(res.status, 403);
});

// ---- missing / invalid token -------------------------------------------------

test('echo: no Authorization header → 401', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const res = await handle(ctx({ auth: null }), { ...ENV, DB: db });
  assert.equal(res.status, 401);
  assert.equal(json(res).message, 'Unauthenticated.');
});

test('echo: malformed / unknown / wrong-token Bearer → 401', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  await seedToken(db, { id: 1, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' });

  const cases = [
    'garbage',          // no `id|random` shape
    '999|nope',         // unknown token id
    '1|WRONG',          // known id, sha256 mismatch
  ];
  for (const bad of cases) {
    const res = await handle(ctx({ auth: bad }), { ...ENV, DB: db });
    assert.equal(res.status, 401, `token ${bad} should be rejected`);
  }
});

test('echo: Bearer header with a non-Bearer scheme → 401', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  await seedToken(db, { id: 1, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' });
  const res = await handle(
    { body: new URLSearchParams({ socket_id: '1.1', channel_name: 'private-room' }), request: { headers: { authorization: 'Basic Zm9vOmJhcg==' } } },
    { ...ENV, DB: db },
  );
  assert.equal(res.status, 401);
});

// ---- validation / config guards ---------------------------------------------

test('echo: valid token but missing socket_id/channel_name → 422', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 7, userId: 42 });
  const res = await handle(ctx({ auth: plain, body: new URLSearchParams({ socket_id: '1.1' }) }), { ...ENV, DB: db });
  assert.equal(res.status, 422);
});

test('echo: unconfigured signing secret → 500', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 8, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' });
  const res = await handle(ctx({ auth: plain }), { DB: db });
  assert.equal(res.status, 500);
});

test('echo: presence membership is required too (member of private only → 403)', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const plain = await seedToken(db, { id: 9, userId: 42 });
  await grant(db, { userId: 42, channel: 'private-room' }); // only private granted
  const res = await handle(ctx({ auth: plain, channelName: 'presence-room' }), { ...ENV, DB: db });
  assert.equal(res.status, 403);
});
