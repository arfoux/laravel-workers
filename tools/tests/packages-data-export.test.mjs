// tools/tests/packages-data-export.test.mjs — cluster E (DATA & EXPORT).
// Exercises the four ports (spatie/laravel-data, spatie/laravel-settings,
// maatwebsite/excel CSV, laravel/socialite redirect+callback) against a fake
// in-memory D1 and a fake `fetch` — no network, no real D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../kernel/packages/validate.mjs';
import dataHandler, { UserData } from '../../ports/packages/spatie-data.mjs';
import settingsHandler from '../../ports/packages/spatie-settings.mjs';
import excelHandler, { csvFromRows } from '../../ports/packages/maatwebsite-excel.mjs';
import redirectHandler from '../../ports/packages/laravel-socialite-redirect.mjs';
import callbackHandler from '../../ports/packages/laravel-socialite-callback.mjs';
import { ensureSchema as ensureExcelSchema } from '../../ports/packages/maatwebsite-excel.mjs';
import { rememberState } from '../../kernel/packages/socialite.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// Build a ctx object matching the port contract.
function makeCtx({ method = 'GET', url = 'http://worker.test/x', params = {}, query = {}, body, headers = {}, fetchImpl, randomBytes, user_id } = {}) {
  return {
    params,
    query,
    body,
    user_id,
    request: {
      method,
      url,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    },
    fetchImpl,
    randomBytes,
  };
}

// Fixed randomBytes -> deterministic Str::random-like output for tokens/state.
const fixedRandom = (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 7 + 11) % 62; };

// ---------------------------------------------------------------------------
// 0. validate primitive (shared by data + settings validation surface)
// ---------------------------------------------------------------------------
test('validate: required/email/integer/min pass and fail like Laravel', () => {
  const rules = { name: 'required|min:2', email: 'required|email', age: 'integer|min:1' };
  const ok = validate({ name: 'Jo', email: 'a@b.co', age: 30 }, rules);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, {});

  const bad = validate({ name: 'J', email: 'nope', age: 'x' }, rules);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.name);
  assert.ok(bad.errors.email);
  assert.ok(bad.errors.age);
});

test('validate: required catches missing/empty; optional integer skips when absent', () => {
  const r = validate({ email: 'a@b.co' }, { name: 'required', email: 'required|email', age: 'integer' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.name);
  assert.equal(r.errors.email, undefined);
  assert.equal(r.errors.age, undefined); // age absent -> integer rule not applied
});

test('validate: the uuid rule is Laravel\'s own Str::isUuid, not a version-restricted regex', () => {
  // The bare rule is the canonical dashed form with ANY hex in the last two
  // groups: v6/v7, `nil`, `max` and a variant-0 uuid are all accepted (probed
  // on PHP 8.3 with Laravel's validateUuid).
  for (const u of [
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    '018f0c1e-6b1a-7c3d-8e4f-9a0b1c2d3e4f',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    'a0eebc99-9c0b-4ef8-0b6d-6bb9bd380a11',
  ]) {
    assert.equal(validate({ id: u }, { id: 'uuid' }).valid, true, u);
  }
  assert.equal(validate({ id: 'nope' }, { id: 'uuid' }).valid, false);
  assert.equal(validate({ id: 'a0eebc999c0b4ef8bb6d6bb9bd380a11' }, { id: 'uuid' }).valid, false);
});

test('validate: data drops unknown fields and does not mutate input', () => {
  const input = { name: 'A', email: 'a@b.co', extra: 'drop-me' };
  const r = validate(input, { name: 'required', email: 'required|email' });
  assert.equal(r.data.extra, undefined);
  assert.equal(input.extra, 'drop-me'); // input untouched
});

// ---------------------------------------------------------------------------
// 1. spatie/laravel-data — POST hydrate+validate -> DTO
// ---------------------------------------------------------------------------
test('data: valid payload -> 200 with DTO JSON and a persisted D1 row', async () => {
  const db = new FakeD1();
  const res = await dataHandler(
    makeCtx({ method: 'POST', body: { name: 'Ada Lovelace', email: 'ada@example.com', age: 36, hacker: true } }),
    { DB: db }
  );
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.data.name, 'Ada Lovelace');
  assert.equal(parsed.data.email, 'ada@example.com');
  assert.equal(parsed.data.age, 36);
  assert.equal(parsed.data.hacker, undefined); // unknown field dropped by hydration

  const rows = await db.prepare('SELECT name, email, age FROM lw_dtos').all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].email, 'ada@example.com');
});

test('data: invalid payload -> 422 with a Laravel error bag', async () => {
  const db = new FakeD1();
  const res = await dataHandler(
    makeCtx({ method: 'POST', body: { name: '', email: 'bad', age: 'nope' } }),
    { DB: db }
  );
  assert.equal(res.status, 422);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.message, 'The given data was invalid.');
  assert.ok(Array.isArray(parsed.errors.name) && parsed.errors.name.length);
  assert.ok(Array.isArray(parsed.errors.email) && parsed.errors.email.length);
  assert.ok(Array.isArray(parsed.errors.age) && parsed.errors.age.length);
  // nothing persisted on failure
  const rows = await db.prepare('SELECT * FROM lw_dtos').all();
  assert.equal(rows.results.length, 0);
});

test('data: optional integer omitted still validates, age null in DTO', async () => {
  const db = new FakeD1();
  const res = await dataHandler(
    makeCtx({ method: 'POST', body: { name: 'Grace', email: 'g@example.com' } }),
    { DB: db }
  );
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.data.age, null); // DTO defaults nullable -> null
});

// ---------------------------------------------------------------------------
// 2. spatie/laravel-settings — GET/PUT /settings/{group}
// ---------------------------------------------------------------------------
test('settings: PUT upserts keys then GET returns the parsed group', async () => {
  const db = new FakeD1();
  const put = await settingsHandler(
    makeCtx({ method: 'PUT', params: { group: 'site' }, body: { title: 'Hello', max: 10, nested: { a: 1 } } }),
    { DB: db }
  );
  assert.equal(put.status, 200);
  assert.deepEqual(JSON.parse(put.body).updated, ['title', 'max', 'nested']);

  const get = await settingsHandler(
    makeCtx({ method: 'GET', params: { group: 'site' } }),
    { DB: db }
  );
  assert.equal(get.status, 200);
  const body = JSON.parse(get.body);
  assert.equal(body.group, 'site');
  assert.equal(body.settings.title, 'Hello');
  assert.equal(body.settings.max, 10);
  assert.deepEqual(body.settings.nested, { a: 1 });
});

test('settings: PUT again overwrites (upsert) and GET reflects the new value', async () => {
  const db = new FakeD1();
  await settingsHandler(makeCtx({ method: 'PUT', params: { group: 'g' }, body: { k: 1 } }), { DB: db });
  await settingsHandler(makeCtx({ method: 'PUT', params: { group: 'g' }, body: { k: 2 } }), { DB: db });
  const get = await settingsHandler(makeCtx({ method: 'GET', params: { group: 'g' } }), { DB: db });
  assert.equal(JSON.parse(get.body).settings.k, 2);
  const rows = await db.prepare('SELECT key FROM lw_settings WHERE "group" = ?1').bind('g').all();
  assert.equal(rows.results.length, 1); // upsert, not a second row
});

test('settings: GET an unknown group -> 200 with empty settings object', async () => {
  const db = new FakeD1();
  const res = await settingsHandler(makeCtx({ method: 'GET', params: { group: 'nope' } }), { DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).settings, {});
});

// ---------------------------------------------------------------------------
// 3. maatwebsite/excel — CSV export
// ---------------------------------------------------------------------------
test('excel: csvFromRows quotes RFC4180 cells (comma/quote/CR/LF)', () => {
  const csv = csvFromRows(
    [{ a: 'plain', b: 'has,comma', c: 'has"quote', d: 'line\nbreak' }],
    ['a', 'b', 'c', 'd']
  );
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b,c,d');
  assert.equal(lines[1], 'plain,"has,comma","has""quote","line\nbreak"');
});

test('excel: GET /export?format=csv streams a CSV of D1 rows', async () => {
  const db = new FakeD1();
  await ensureExcelSchema({ DB: db }); // the export's `users` table (production path)
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(1, 'Ada', 'ada@example.com').run();
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(2, 'Last, First', 'lf@example.com').run();

  const res = await excelHandler(makeCtx({ query: { format: 'csv' }, user_id: 1 }), { DB: db });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="users\.csv"/);

  const lines = res.body.split('\r\n');
  assert.equal(lines[0], 'id,name,email');
  assert.equal(lines[1], '1,Ada,ada@example.com');
  assert.equal(lines[2], '2,"Last, First",lf@example.com');
});

test('excel: an anonymous export is a 401 and reads no rows', async () => {
  const db = new FakeD1();
  await ensureExcelSchema({ DB: db });
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(1, 'Ada', 'ada@example.com').run();

  const res = await excelHandler(makeCtx({ query: { format: 'csv' } }), { DB: db });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).message, 'Unauthenticated.');
});

test('excel: ?table= cannot redirect the export; the table comes from env', async () => {
  const db = new FakeD1();
  await ensureExcelSchema({ DB: db });
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(1, 'Ada', 'ada@example.com').run();
  db.tables.set('secrets', [{ id: 1, value: 'leak' }]);

  const res = await excelHandler(makeCtx({ query: { format: 'csv', table: 'secrets' }, user_id: 1 }), { DB: db });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="users\.csv"/);
  assert.ok(!res.body.includes('leak'), 'rows of the caller-named table must not be exported');

  const other = await excelHandler(makeCtx({ query: { format: 'csv' }, user_id: 1 }), { DB: db, EXCEL_EXPORT_TABLE: 'secrets' });
  assert.match(other.headers['content-disposition'], /attachment; filename="secrets\.csv"/);
  assert.match(other.body, /leak/);
});

test('excel: format=xlsx is refused (406), not faked as CSV', async () => {
  const db = new FakeD1();
  const res = await excelHandler(makeCtx({ query: { format: 'xlsx' }, user_id: 1 }), { DB: db });
  assert.equal(res.status, 406);
  assert.match(JSON.parse(res.body).error, /csv/);
});

// ---------------------------------------------------------------------------
// 4. laravel/socialite — redirect + callback
// ---------------------------------------------------------------------------
const PROVIDER_ENV = {
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'secret',
  GITHUB_REDIRECT_URI: 'https://app.test/auth/github/callback',
};

test('socialite redirect: 302 to authorize URL with state cookie + stored state', async () => {
  const db = new FakeD1();
  const res = await redirectHandler(
    makeCtx({ method: 'GET', params: { provider: 'github' } }),
    { DB: db, ...PROVIDER_ENV, randomBytes: fixedRandom }
  );
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://app.test/auth/github/callback');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  const state = loc.searchParams.get('state');
  assert.ok(state && state.length > 0);
  // state cookie set
  assert.match(res.headers['set-cookie'], /oauth_state=/);
  assert.match(res.headers['set-cookie'], new RegExp(state));
  // state persisted in D1
  const rows = await db.prepare('SELECT state FROM lw_oauth_state WHERE state = ?1').bind(state).all();
  assert.equal(rows.results.length, 1);
});

test('socialite redirect: unconfigured provider -> 400', async () => {
  const db = new FakeD1();
  const res = await redirectHandler(
    makeCtx({ params: { provider: 'github' } }),
    { DB: db, randomBytes: fixedRandom } // no creds in env
  );
  assert.equal(res.status, 400);
});

test('socialite callback: happy path -> verifies state, exchanges code, logs in', async () => {
  const db = new FakeD1();
  // initiate the flow so state is stored + cookie known
  const red = await redirectHandler(
    makeCtx({ params: { provider: 'github' } }),
    { DB: db, ...PROVIDER_ENV, randomBytes: fixedRandom }
  );
  const state = new URL(red.headers.location).searchParams.get('state');

  // fake provider HTTP: token endpoint + user-info endpoint
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok123', token_type: 'bearer' }) };
    }
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, json: async () => ({ id: 42, name: 'GH User', email: 'gh@example.com', login: 'ghuser', avatar_url: 'http://a/1.png' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const res = await callbackHandler(
    makeCtx({
      params: { provider: 'github' },
      query: { code: 'the-code', state },
      headers: { cookie: `oauth_state=${state}` },
      fetchImpl,
      randomBytes: fixedRandom,
    }),
    { DB: db, ...PROVIDER_ENV }
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.provider, 'github');
  assert.equal(body.user.provider_id, '42');
  assert.equal(body.user.name, 'GH User');
  assert.equal(body.user.email, 'gh@example.com');
  assert.ok(body.access_token && body.access_token.includes('|')); // Sanctum shape
  assert.deepEqual(calls, [
    'https://github.com/login/oauth/access_token',
    'https://api.github.com/user',
  ]);
  // user upserted + token persisted
  const users = await db.prepare('SELECT * FROM users').all();
  assert.equal(users.results.length, 1);
  const tokens = await db.prepare('SELECT tokenable_id, token FROM personal_access_tokens').all();
  assert.equal(tokens.results.length, 1);
  assert.equal(tokens.results[0].tokenable_id, body.user.id);
});

test('socialite callback: bad state -> 401 before any provider HTTP call', async () => {
  const db = new FakeD1();
  // the redirect leg ran first and planted some state row (production path);
  // nothing is stored for this request's `forged`.
  await rememberState({ DB: db }, 'st_from-a-prior-flow');
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const res = await callbackHandler(
    makeCtx({
      params: { provider: 'github' },
      query: { code: 'c', state: 'forged' },
      fetchImpl,
    }),
    { DB: db, ...PROVIDER_ENV }
  );
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'invalid state');
  assert.equal(called, false); // never touched the provider
});

test('socialite callback: state valid via D1 row even without cookie', async () => {
  const db = new FakeD1();
  const red = await redirectHandler(
    makeCtx({ params: { provider: 'github' } }),
    { DB: db, ...PROVIDER_ENV, randomBytes: fixedRandom }
  );
  const state = new URL(red.headers.location).searchParams.get('state');

  const fetchImpl = async (url) => (url === 'https://github.com/login/oauth/access_token'
    ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) }
    : { ok: true, status: 200, json: async () => ({ id: 7, name: 'X', email: 'x@e.com', login: 'x', avatar_url: '' }) });

  // no cookie header — callback must fall back to the stored state row
  const res = await callbackHandler(
    makeCtx({ params: { provider: 'github' }, query: { code: 'c', state }, fetchImpl, randomBytes: fixedRandom }),
    { DB: db, ...PROVIDER_ENV }
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).user.provider_id, '7');
});
