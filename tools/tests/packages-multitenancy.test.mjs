// tools/tests/packages-multitenancy.test.mjs — spatie/laravel-multitenancy port.
// Drives the handler against real SQLite (`tools/tests/_fake-d1.mjs`), including
// UNIQUE enforcement on `tenants.key`, then asserts the real behavior: create,
// resolve/boot, and the 422/404/409 guards. No network, no real D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler, { resolveTenant, ensureSchema } from '../../ports/packages/multitenancy.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// Build a ctx matching the port contract (kernel-style request accessors).
// `user_id` defaults to an authenticated caller: the handler answers 401 without
// one, and every test below is about what an authenticated app request does.
function makeCtx({ method = 'GET', url = 'http://worker.test/tenants', params = {}, body, query = {}, headers = {}, user_id = 1 } = {}) {
  const u = new URL(url);
  return {
    method,
    params,
    query,
    user_id,
    body: body !== undefined ? body : undefined,
    request: {
      method,
      url,
      pathInfo: () => u.pathname,
      host: () => u.host,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      header: (n) => headers[n.toLowerCase()] ?? null,
      query: (k) => (query[k] !== undefined ? query[k] : null),
      json: () => (body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      text: () => (body !== undefined ? JSON.stringify(body) : ''),
    },
  };
}

// ===========================================================================
// (0) The identity floor — no caller, no tenant data
// ===========================================================================
test('anonymous: both routes are 401 and write/read nothing', async () => {
  const db = new FakeD1();
  await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'acme', name: 'Acme Inc' } }), { DB: db });

  const created = await handler(
    makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'walk-in', name: 'Walk In' }, user_id: null }),
    { DB: db },
  );
  assert.equal(created.status, 401);
  assert.equal(JSON.parse(created.body).message, 'Unauthenticated.');

  const read = await handler(
    makeCtx({ method: 'GET', url: 'http://worker.test/tenants/acme', params: { tenantKey: 'acme' }, user_id: null }),
    { DB: db },
  );
  assert.equal(read.status, 401);
  assert.ok(!read.body.includes('acme'), 'a tenant key must not be confirmed to an anonymous caller');

  const rows = (await db.prepare('SELECT * FROM tenants').all()).results;
  assert.deepEqual(rows.map((r) => r.key), ['acme']);
});

// ===========================================================================
// (1) Create — POST /tenants
// ===========================================================================
test('create: POST /tenants inserts a row and returns 201 with the booted tenant', async () => {
  const db = new FakeD1();
  const res = await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'acme', name: 'Acme Inc', data: { plan: 'pro' } } }), { DB: db });
  assert.equal(res.status, 201);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.tenant.key, 'acme');
  assert.equal(parsed.tenant.name, 'Acme Inc');
  assert.equal(parsed.created, true);
  assert.deepEqual(parsed.data, { plan: 'pro' });

  const rows = (await db.prepare('SELECT * FROM tenants').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'acme');
  assert.equal(rows[0].name, 'Acme Inc');
  assert.deepEqual(JSON.parse(rows[0].data_json), { plan: 'pro' });
  assert.ok(rows[0].id >= 1);
});

test('create: name defaults to the key when omitted', async () => {
  const db = new FakeD1();
  const res = await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'beta' } }), { DB: db });
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body).tenant.name, 'beta');
});

test('create: duplicate key is a 409 and does not add a second row', async () => {
  const db = new FakeD1();
  await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'acme', name: 'A' } }), { DB: db });
  const dup = await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'acme', name: 'B' } }), { DB: db });
  assert.equal(dup.status, 409);
  const rows = (await db.prepare('SELECT * FROM tenants').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'A'); // first row unchanged (ON CONFLICT DO NOTHING)
});

// ===========================================================================
// (2) Resolve / boot — GET|POST /tenants/{tenantKey}
// ===========================================================================
test('lookup: GET /tenants/{key} resolves an existing tenant and boots data_json', async () => {
  const db = new FakeD1();
  await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'acme', name: 'Acme Inc', data: { plan: 'pro', seats: 5 } } }), { DB: db });

  const res = await handler(makeCtx({ method: 'GET', url: 'http://worker.test/tenants/acme', params: { tenantKey: 'acme' } }), { DB: db });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.tenant.key, 'acme');
  assert.equal(parsed.tenant.name, 'Acme Inc');
  assert.deepEqual(parsed.data, { plan: 'pro', seats: 5 });
});

test('lookup: POST /tenants/{key} boots the same context', async () => {
  const db = new FakeD1();
  await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { key: 'beta', name: 'Beta', data: { region: 'eu' } } }), { DB: db });
  const res = await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants/beta', params: { tenantKey: 'beta' } }), { DB: db });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.tenant.key, 'beta');
  assert.deepEqual(parsed.data, { region: 'eu' });
});

test('lookup: unknown key is a 404', async () => {
  const db = new FakeD1();
  const res = await handler(makeCtx({ method: 'GET', url: 'http://worker.test/tenants/nope', params: { tenantKey: 'nope' } }), { DB: db });
  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body).error, /not found/);
});

// ===========================================================================
// (3) Missing key -> 422
// ===========================================================================
test('create: POST /tenants without a key is a 422 (no row written)', async () => {
  const db = new FakeD1();
  const res = await handler(makeCtx({ method: 'POST', url: 'http://worker.test/tenants', body: { name: 'no key' } }), { DB: db });
  assert.equal(res.status, 422);
  const rows = (await db.prepare('SELECT * FROM tenants').all()).results;
  assert.equal(rows.length, 0);
});

test('lookup: keyed path without a tenantKey segment is a 422', async () => {
  const db = new FakeD1();
  const res = await handler(makeCtx({ method: 'GET', url: 'http://worker.test/tenants', params: {} }), { DB: db });
  assert.equal(res.status, 422);
});

// ===========================================================================
// (4) Exported resolver + edge data handling
// ===========================================================================
test('resolveTenant: exported helper returns null for missing key, boots data for present key', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  assert.equal(await resolveTenant(db, 'ghost'), null);
  await db.prepare('INSERT INTO tenants (key, name, data_json) VALUES (?1, ?2, ?3)').bind('acme', 'Acme', '{"plan":"pro"}').run();
  const booted = await resolveTenant(db, 'acme');
  assert.equal(booted.tenant.key, 'acme');
  assert.deepEqual(booted.data, { plan: 'pro' });
});

test('lookup: empty / invalid data_json degrades to {} rather than throwing', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  await db.prepare('INSERT INTO tenants (key, name, data_json) VALUES (?1, ?2, ?3)').bind('empty', 'E', '').run();
  const res = await handler(makeCtx({ method: 'GET', url: 'http://worker.test/tenants/empty', params: { tenantKey: 'empty' } }), { DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).data, {});
});
