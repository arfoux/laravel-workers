// tools/tests/packages-multitenancy.test.mjs — spatie/laravel-multitenancy port.
// Drives the handler against a fake in-memory D1 (prepare(sql).bind(...).all()/
// first()/run() over a row map) with UNIQUE enforcement on `tenants.key`, then
// asserts the real behavior: create, resolve/boot, and the 422/404/409 guards.
// No network, no real D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler, { resolveTenant } from '../../ports/packages/multitenancy.mjs';

// ---------------------------------------------------------------------------
// Fake D1 (in-memory). Handles exactly the statements the handler emits:
//   CREATE TABLE IF NOT EXISTS tenants (... key UNIQUE ...)
//   INSERT INTO tenants (key,name,data_json) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING
//   SELECT id,key,name,data_json,created_at FROM tenants WHERE key = ?1 [LIMIT 1]
// `.run()` -> { success, meta: { changes, last_row_id } }; `.first()`/`.all()`.
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

class FakeD1 {
  constructor() { this.tables = new Map(); this.autoinc = new Map(); }
  _rows(name) {
    if (!this.tables.has(name)) { this.tables.set(name, []); this.autoinc.set(name, 0); }
    return this.tables.get(name);
  }
  prepare(sql) {
    const db = this;
    const clean = sql.replace(/\s+/g, ' ').trim();
    const createM = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(clean);
    const insertM = /^INSERT INTO (\w+)/i.exec(clean);
    const selectM = /^SELECT .+ FROM (\w+)/i.exec(clean);
    const table = createM ? createM[1] : insertM ? insertM[1] : selectM ? selectM[1] : null;
    return {
      sql: clean,
      binds: [],
      bind(...a) { this.binds = a; return this; },
      async run() {
        if (createM) {
          db._ddl = db._ddl || new Map();
          if (!db._ddl.has(table)) db._ddl.set(table, clean);
          db._rows(table);
          return { success: true, meta: { changes: 0 } };
        }
        if (insertM) {
          const colsM = /^INSERT INTO \w+ \(([^)]+)\) VALUES \(([^)]+)\)/i.exec(clean);
          if (!colsM) throw new Error(`unsupported insert: ${sql}`);
          const cols = colsM[1].split(',').map((c) => stripIdent(c.trim()));
          const row = {};
          colsM[2].split(',').forEach((t, i) => {
            const tok = t.trim();
            row[cols[i]] = /^\?(\d+)$/.test(tok) ? this.binds[Number(tok.slice(1)) - 1] : JSON.parse(tok);
          });
          const rows = db._rows(table);
          const conflictCols = /ON CONFLICT\s*\(([^)]+)\)/i.exec(clean);
          if (conflictCols) {
            const cc = conflictCols[1].split(',').map((c) => stripIdent(c.trim()));
            const dup = rows.find((r) => cc.every((c) => r[c] === row[c]));
            if (dup && /\bDO NOTHING\b/i.test(clean)) {
              return { success: true, meta: { changes: 0, last_row_id: dup.id } };
            }
          }
          let next = db.autoinc.get(table) + 1;
          while (rows.some((r) => r.id === next)) next += 1;
          db.autoinc.set(table, next);
          row.id = next;
          rows.push({ ...row });
          return { success: true, meta: { changes: 1, last_row_id: next } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      async all() {
        const m = /^SELECT (.*?) FROM (\w+)(.*)$/is.exec(clean);
        if (!m) return { results: [], success: true };
        let rows = db._rows(m[2]).slice();
        const whereM = /\bWHERE (.+?)(?: ORDER BY| LIMIT|$)/i.exec(m[3] || '');
        if (whereM) {
          const conds = [...whereM[1].matchAll(/("([^"]+)"|\w+)\s*=\s*\?(\d+)/g)]
            .map((x) => ({ col: stripIdent(x[1]), value: this.binds[Number(x[3]) - 1] }));
          rows = rows.filter((r) => conds.every((c) => r[c.col] === c.value));
        }
        if (m[1].trim() === '*') return { results: rows, success: true };
        const cols = splitTop(m[1]).map(stripIdent);
        return { results: rows.map((r) => { const o = {}; for (const c of cols) o[c] = r[c]; return o; }), success: true };
      },
      async first() {
        const { results } = await this.all();
        return results[0] ?? null;
      },
    };
  }
}

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
  assert.equal(await resolveTenant(db, 'ghost'), null);
  await db.prepare('INSERT INTO tenants (key, name, data_json) VALUES (?1, ?2, ?3)').bind('acme', 'Acme', '{"plan":"pro"}').run();
  const booted = await resolveTenant(db, 'acme');
  assert.equal(booted.tenant.key, 'acme');
  assert.deepEqual(booted.data, { plan: 'pro' });
});

test('lookup: empty / invalid data_json degrades to {} rather than throwing', async () => {
  const db = new FakeD1();
  await db.prepare('INSERT INTO tenants (key, name, data_json) VALUES (?1, ?2, ?3)').bind('empty', 'E', '').run();
  const res = await handler(makeCtx({ method: 'GET', url: 'http://worker.test/tenants/empty', params: { tenantKey: 'empty' } }), { DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).data, {});
});
