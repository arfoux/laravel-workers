// tools/tests/packages-xendit-webhook.test.mjs — xendit/xendit-php webhook port.
//
// The handler authenticates with a STATIC `x-callback-token` header compared
// constant-time against `env.XENDIT_CALLBACK_TOKEN`, then stores the callback in
// the D1 `invoices` table. Exercised with a fake `env.DB` backed by real SQLite
// (`tools/tests/_fake-d1.mjs`). We assert:
//   - a VALID token → 200 {received:true} and the row (id, external_id, status,
//     created_at) is stored;
//   - a WRONG / MISSING token → 401 and NOTHING is stored;
//   - no XENDIT_CALLBACK_TOKEN configured → 500 before any read/write;
//   - a payload WITHOUT `id` → 422 and NOTHING is stored.
// No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle, { ensureSchema } from '../../ports/packages/xendit-webhook.mjs';

import { FakeD1 } from './_fake-d1.mjs';

// ---- helpers ----------------------------------------------------------------

// The rows the handler stored, straight out of SQLite ([] before ensureSchema).
const storedRows = (db) => db.tables.get('invoices') || [];

async function columnsOf(db, table) {
  const res = await db.prepare(`PRAGMA table_info('${table}')`).all();
  return res.results;
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
  const db = new FakeD1();
  const res = await handle(makeCtx(TOKEN, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.received, true);
  assert.equal(out.id, 'inv_abc');
  assert.equal(storedRows(db).length, 1);
});

test('xendit: stored row carries (id, external_id, status, created_at)', async () => {
  const db = new FakeD1();
  await handle(makeCtx(TOKEN, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  // exactly the four declared columns were stored
  assert.deepEqual(Object.keys(stored[0]).sort(), ['created_at', 'external_id', 'id', 'status']);
  assert.deepEqual([stored[0].id, stored[0].external_id, stored[0].status], ['inv_abc', 'order-42', 'PAID']);
  // created_at is an ISO timestamp
  assert.doesNotThrow(() => new Date(stored[0].created_at).toISOString());
});

test('xendit: status is stored verbatim (any invoice state, not just PAID)', async () => {
  const db = new FakeD1();
  await handle(makeCtx(TOKEN, { id: 'inv_1', external_id: 'ord-1', status: 'EXPIRED' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  await handle(makeCtx(TOKEN, { id: 'inv_2', external_id: 'ord-2', status: 'SETTLED' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  const stored = storedRows(db);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].status, 'EXPIRED');
  assert.equal(stored[1].status, 'SETTLED');
});

test('xendit: missing external_id/status are stored as NULL', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(TOKEN, { id: 'inv_min' }), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 200);
  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].id, stored[0].external_id, stored[0].status], ['inv_min', null, null]);
});

test('xendit: header token is trimmed before comparison', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(`  ${TOKEN}  `, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  assert.equal(res.status, 200);
  assert.equal(storedRows(db).length, 1);
});

// ---- invalid token ----------------------------------------------------------

test('xendit: wrong token is a 401 and nothing is stored', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx('wrong-token', PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'invalid x-callback-token');
  assert.equal(storedRows(db).length, 0);
});

test('xendit: missing x-callback-token header is a 401 and nothing is stored', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(undefined, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 401);
  assert.equal(storedRows(db).length, 0);
});

test('xendit: a longer prefix token never matches (length leaks nothing)', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(`${TOKEN}-extra`, PAYLOAD), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  assert.equal(res.status, 401);
  assert.equal(storedRows(db).length, 0);
});

// ---- validation -------------------------------------------------------------

test('xendit: valid token but missing id is a 422 and nothing is stored', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(TOKEN, { external_id: 'order-42', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.body).error, 'body.id required');
  assert.equal(storedRows(db).length, 0);
});

test('xendit: valid token but empty body is a 422 and nothing is stored', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(TOKEN, {}), { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  assert.equal(res.status, 422);
  assert.equal(storedRows(db).length, 0);
});

// ---- configuration ----------------------------------------------------------

test('xendit: no XENDIT_CALLBACK_TOKEN is a 500 before any read/write', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(TOKEN, PAYLOAD), { DB: db });

  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /XENDIT_CALLBACK_TOKEN not configured/);
  assert.equal(storedRows(db).length, 0);
});

// ---- schema -----------------------------------------------------------------

test('xendit: schema creates invoices with the expected columns', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  assert.ok(db.tables.has('invoices'));
});

test('xendit: schema columns are (id PK, external_id, status, created_at)', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  const cols = await columnsOf(db, 'invoices');
  assert.deepEqual(cols.map((c) => c.name), ['id', 'external_id', 'status', 'created_at']);
  const id = cols.find((c) => c.name === 'id');
  assert.equal(id.type, 'TEXT');
  assert.equal(id.pk, 1);
});

// ---- repeated calls ---------------------------------------------------------

test('xendit: two callbacks with the same token store two rows', async () => {
  const db = new FakeD1();
  await handle(makeCtx(TOKEN, { id: 'inv_a', external_id: 'a', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });
  await handle(makeCtx(TOKEN, { id: 'inv_b', external_id: 'b', status: 'PAID' }),
    { XENDIT_CALLBACK_TOKEN: TOKEN, DB: db });

  const stored = storedRows(db);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((r) => r.id), ['inv_a', 'inv_b']);
});
