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

// ---------------------------------------------------------------------------
// Fake D1: prepare(sql).bind(...).all()/first()/run() over an in-memory Map of
// tables. Handles the statement shapes the handlers use (CREATE/INSERT/DELETE/
// SELECT with WHERE + ORDER BY + ON CONFLICT upsert). Not a SQL engine — just
// enough to exercise real read/write logic.
// ---------------------------------------------------------------------------
function stripIdent(s) {
  return s.replace(/^["'`\[]|["'`\]]$/g, '');
}

function splitTop(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim());
}

function parseConds(str, args) {
  const out = [];
  const re = /("[^"]+"|\w+)\s*=\s*\?(\d+)/g;
  let m;
  while ((m = re.exec(str))) out.push({ col: stripIdent(m[1]), value: args[Number(m[2]) - 1] });
  return out;
}

function execSelect(db, sql, args) {
  const s = sql.trim();
  const m = /^select\s+(.*?)\s+from\s+([a-z_"]+)(.*)$/is.exec(s);
  if (!m) throw new Error(`unsupported select: ${sql}`);
  const colsPart = m[1];
  const table = stripIdent(m[2]);
  const rest = m[3] || '';
  let rows = (db.tables.get(table) || []).slice();
  const where = /\bwhere\b(.*?)(?=\border\s+by\b|$)/is.exec(rest);
  if (where) {
    const conds = parseConds(where[1], args);
    rows = rows.filter((r) => conds.every((c) => r[c.col] === c.value));
  }
  const order = /\border\s+by\s+([\w"]+)/i.exec(rest);
  if (order) {
    const col = stripIdent(order[1]);
    rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
  }
  if (colsPart.trim() === '*') return rows.map((r) => ({ ...r }));
  const cols = splitTop(colsPart).map(stripIdent);
  return rows.map((r) => {
    const o = {};
    for (const c of cols) o[c] = r[c];
    return o;
  });
}

function execMutate(db, sql, args) {
  const s = sql.trim();
  if (/^create\s+table/i.test(s)) return { success: true };
  if (/^insert\s+into/i.test(s)) {
    const m = /^insert\s+into\s+([a-z_"]+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(s);
    if (!m) throw new Error(`unsupported insert: ${sql}`);
    const table = stripIdent(m[1]);
    const cols = splitTop(m[2]).map(stripIdent);
    const valToks = splitTop(m[3]);
    const row = {};
    cols.forEach((c, i) => {
      const t = valToks[i].trim();
      row[c] = /^\?(\d+)$/.test(t) ? args[Number(t.slice(1)) - 1] : JSON.parse(t);
    });
    let arr = db.tables.get(table);
    if (!arr) { arr = []; db.tables.set(table, arr); }
    const conflict = /on\s+conflict\s*\(([^)]*)\)/i.exec(s);
    if (conflict) {
      const ccols = splitTop(conflict[1]).map(stripIdent);
      const found = arr.find((r) => ccols.every((c) => r[c] === row[c]));
      if (found) {
        for (const c of cols) if (!ccols.includes(c)) found[c] = row[c];
        return { success: true };
      }
    }
    arr.push(row);
    return { success: true };
  }
  if (/^delete\s+from/i.test(s)) {
    const m = /^delete\s+from\s+([a-z_"]+)\s*where\s+(.+)$/i.exec(s);
    const table = stripIdent(m[1]);
    const conds = parseConds(m[2], args);
    db.tables.set(table, (db.tables.get(table) || []).filter((r) => !conds.every((c) => r[c.col] === c.value)));
    return { success: true };
  }
  return { success: true };
}

class FakeD1 {
  constructor() { this.tables = new Map(); }
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async all() { return { results: execSelect(db, sql, args), success: true }; },
      async first() { const r = execSelect(db, sql, args); return r[0] ?? null; },
      async run() { return execMutate(db, sql, args); },
    };
  }
}

// Build a ctx object matching the port contract.
function makeCtx({ method = 'GET', url = 'http://worker.test/x', params = {}, query = {}, body, headers = {}, fetchImpl, randomBytes } = {}) {
  return {
    params,
    query,
    body,
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
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(1, 'Ada', 'ada@example.com').run();
  await db.prepare('INSERT INTO users (id, name, email) VALUES (?1, ?2, ?3)').bind(2, 'Last, First', 'lf@example.com').run();

  const res = await excelHandler(makeCtx({ query: { format: 'csv' } }), { DB: db });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="users\.csv"/);

  const lines = res.body.split('\r\n');
  assert.equal(lines[0], 'id,name,email');
  assert.equal(lines[1], '1,Ada,ada@example.com');
  assert.equal(lines[2], '2,"Last, First",lf@example.com');
});

test('excel: format=xlsx is refused (406), not faked as CSV', async () => {
  const db = new FakeD1();
  const res = await excelHandler(makeCtx({ query: { format: 'xlsx' } }), { DB: db });
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
