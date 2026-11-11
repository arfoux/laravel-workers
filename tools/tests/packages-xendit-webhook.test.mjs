// tools/tests/packages-xendit-webhook.test.mjs — xendit/xendit-php webhook port.
//
// The handler authenticates with a STATIC `x-callback-token` header compared
// constant-time against `env.XENDIT_CALLBACK_TOKEN`, then stores the callback in
// the D1 `invoices` table. Exercised with a fake `env.DB` that records bound
// INSERT rows. We assert:
//   - a VALID token → 200 {received:true} and the row (id, external_id, status,
//     created_at) is stored;
//   - a WRONG / MISSING token → 401 and NOTHING is stored;
//   - no XENDIT_CALLBACK_TOKEN configured → 500 before any read/write;
//   - a payload WITHOUT `id` → 422 and NOTHING is stored.
// No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle, { ensureSchema } from '../../ports/packages/xendit-webhook.mjs';

// ---- helpers ----------------------------------------------------------------

// Fake D1 binding: records each bound row so tests can assert what was stored.
function makeDb() {
  const rows = [];
  const stmt = {
    _args: null,
    bind: (...args) => { stmt._args = args; return stmt; },
    run: async () => {
      // only bound (INSERT) statements are recorded; bare run() = DDL (ensureSchema)
      if (stmt._args !== null) rows.push(stmt._args);
      stmt._args = null;
      return { meta: { changes: 1, last_row_id: rows.length } };
    },
    all: async () => ({ results: rows }),
    first: async () => rows[0] || null,
  };
  const db = {
    rows,
    _ddl: null,
    prepare: (sql) => { db._ddl = sql; return stmt; },
  };
  return db;
}

// Build a port ctx: token comes from a header accessor, payload from `body`.
function makeCtx(token, body) {
  return {
    request: {
      header: (n) => {
        if (n.toLowerCase() !== 'x-callback-token') return null;
        return token === undefined || token === null ? null : String(token);
      },
    },
    body,
    query: {},
    params: {},
  };
}

const TOKEN = 'cbk_tok_0123456789';
const PAYLOAD = { id: 'inv_abc', external_id: 'order-42', status: 'PAID' };

// ---- valid token ------------------------------------------------------------

test('xendit: valid token is accepted (200), stored, and ACKed', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(TOKEN, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.received, true);
  assert.equal(out.id, 'inv_abc');
  assert.equal(db.rows.length, 1);
});

test('xendit: stored row carries (id, external_id, status, created_at)', async () => {
  const db = makeDb();
  await handle(makeCtx(TOKEN, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.deepEqual(db.rows[0], ['inv_abc', 'order-42', 'PAID', db.rows[0][3]]);
  // created_at is an ISO timestamp
  assert.doesNotThrow(() => new Date(db.rows[0][3]).toISOString());
});

test('xendit: status is stored verbatim (any invoice state, not just PAID)', async () => {
  const db = makeDb();
  await handle(makeCtx(TOKEN, { id: 'inv_1', external_id: 'ord-1', status: 'EXPIRED' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  await handle(makeCtx(TOKEN, { id: 'inv_2', external_id: 'ord-2', status: 'SETTLED' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0][2], 'EXPIRED');
  assert.equal(db.rows[1][2], 'SETTLED');
});

test('xendit: missing external_id/status are stored as NULL', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(TOKEN, { id: 'inv_min' }), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 200);
  assert.deepEqual(db.rows[0], ['inv_min', null, null, db.rows[0][3]]);
});

test('xendit: header token is trimmed before comparison', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(`  ${TOKEN}  `, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  assert.equal(res.status, 200);
  assert.equal(db.rows.length, 1);
});

// ---- invalid token ----------------------------------------------------------

test('xendit: wrong token is a 401 and nothing is stored', async () => {
  const db = makeDb();
  const res = await handle(makeCtx('wrong-token', PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'invalid x-callback-token');
  assert.equal(db.rows.length, 0);
});

test('xendit: missing x-callback-token header is a 401 and nothing is stored', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(undefined, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 401);
  assert.equal(db.rows.length, 0);
});

test('xendit: a longer prefix token never matches (length leaks nothing)', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(`${TOKEN}-extra`, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  assert.equal(res.status, 401);
  assert.equal(db.rows.length, 0);
});

// ---- validation -------------------------------------------------------------

test('xendit: valid token but missing id is a 422 and nothing is stored', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(TOKEN, { external_id: 'order-42', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.body).error, 'body.id required');
  assert.equal(db.rows.length, 0);
});

test('xendit: valid token but empty body is a 422 and nothing is stored', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(TOKEN, {}), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 422);
  assert.equal(db.rows.length, 0);
});

// ---- configuration ----------------------------------------------------------

test('xendit: no XENDIT_CALLBACK_TOKEN is a 500 before any read/write', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(TOKEN, PAYLOAD), { DB: db });

  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /XENDIT_CALLBACK_TOKEN not configured/);
  assert.equal(db.rows.length, 0);
});

// ---- schema -----------------------------------------------------------------

test('xendit: schema creates invoices with the expected columns', async () => {
  const db = makeDb();
  await ensureSchema({ DB: db });
  assert.match(db._ddl, /CREATE TABLE IF NOT EXISTS invoices/);
});

test('xendit: schema columns are (id PK, external_id, status, created_at)', async () => {
  const db = makeDb();
  await ensureSchema({ DB: db });
  for (const col of ['id', 'external_id', 'status', 'created_at']) {
    assert.match(db._ddl, new RegExp(`\\b${col}\\b`));
  }
  assert.match(db._ddl, /id TEXT PRIMARY KEY/);
});

// ---- repeated calls ---------------------------------------------------------

test('xendit: two callbacks with the same token store two rows', async () => {
  const db = makeDb();
  await handle(makeCtx(TOKEN, { id: 'inv_a', external_id: 'a', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  await handle(makeCtx(TOKEN, { id: 'inv_b', external_id: 'b', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(db.rows.length, 2);
  assert.deepEqual(db.rows.map((r) => r[0]), ['inv_a', 'inv_b']);
});
