// tools/tests/packages-webhook-client.test.mjs — spatie/laravel-webhook-client port.
//
// Exercised with a real fetch `Request` (so the raw body bytes are exact) and a
// fake `env.DB` that records prepared/bound statements. We assert:
//   - a VALID `webhook-signature` (base64 HMAC-SHA256 of the raw body) → 200,
//     the call is stored in `webhook_calls`, payload/processed_at populated;
//   - a WRONG / missing signature → 400 and NOTHING is written;
//   - no WEBHOOK_CLIENT_SECRET configured → 500 before any read.
// No network, no real D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle, { ensureSchema } from '../../ports/packages/webhook-client.mjs';

// ---- helpers ----------------------------------------------------------------

async function sign(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

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
      return { meta: { changes: 1 } };
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

const RAW = JSON.stringify({ event: 'payment.captured', data: { id: 'evt_1', amount: 4200 } });

function makeCtx(rawBody, headers = {}) {
  const req = new Request('https://edge.example/webhooks/stripe', {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return { request: req, params: { name: 'stripe' }, method: 'POST', body: {}, query: {} };
}

// ---- valid signature --------------------------------------------------------

test('webhook-client: valid signature is accepted (200) and stored in webhook_calls', async () => {
  const secret = 's3cr3t';
  const sig = await sign(secret, RAW);
  const db = makeDb();
  const ctx = makeCtx(RAW, { 'webhook-signature': sig });
  const res = await handle(ctx, { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.received, true);
  assert.equal(out.name, 'stripe');
  assert.ok(out.id);

  // stored: [id, name, payload, exception, processed_at]
  assert.equal(db.rows.length, 1);
  const [id, name, payload, exception, processedAt] = db.rows[0];
  assert.equal(id, out.id);
  assert.equal(name, 'stripe');
  assert.equal(payload, RAW);
  assert.equal(exception, null);
  assert.ok(processedAt);
});

test('webhook-client: schema creates webhook_calls with the expected columns', async () => {
  const db = makeDb();
  await ensureSchema({ DB: db });
  assert.match(db._ddl, /CREATE TABLE IF NOT EXISTS webhook_calls/);
});

test('webhook-client: schema columns are (id, name, payload, exception, processed_at)', async () => {
  const db = makeDb();
  await ensureSchema({ DB: db });
  for (const col of ['id', 'name', 'payload', 'exception', 'processed_at']) {
    assert.match(db._ddl, new RegExp(`\\b${col}\\b`));
  }
});

// ---- invalid / missing signature -------------------------------------------

test('webhook-client: wrong signature is rejected (400) and nothing is stored', async () => {
  const secret = 's3cr3t';
  const wrong = await sign('another-secret', RAW);
  const db = makeDb();
  const res = await handle(makeCtx(RAW, { 'webhook-signature': wrong }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid signature');
  assert.equal(db.rows.length, 0);
});

test('webhook-client: tampered body (valid sig over different payload) is rejected', async () => {
  const secret = 's3cr3t';
  const sig = await sign(secret, RAW);
  const tampered = JSON.stringify({ event: 'payment.captured', data: { id: 'evt_1', amount: 999999 } });
  const db = makeDb();
  const res = await handle(makeCtx(tampered, { 'webhook-signature': sig }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 400);
  assert.equal(db.rows.length, 0);
});

test('webhook-client: missing signature header is a 400 and nothing is stored', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(RAW, {}), { WEBHOOK_CLIENT_SECRET: 's3cr3t', DB: db });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /missing webhook-signature/);
  assert.equal(db.rows.length, 0);
});

test('webhook-client: custom signature header name is honoured via env', async () => {
  const secret = 's3cr3t';
  const sig = await sign(secret, RAW);
  const db = makeDb();
  // signed under the default header name but configured for a custom one → 400
  const wrongHeader = await handle(
    makeCtx(RAW, { 'webhook-signature': sig }),
    { WEBHOOK_CLIENT_SECRET: secret, WEBHOOK_CLIENT_SIGNATURE_HEADER: 'x-my-signature', DB: db }
  );
  assert.equal(wrongHeader.status, 400);

  // signed + sent under the configured custom header → 200
  const db2 = makeDb();
  const ok = await handle(
    makeCtx(RAW, { 'x-my-signature': sig }),
    { WEBHOOK_CLIENT_SECRET: secret, WEBHOOK_CLIENT_SIGNATURE_HEADER: 'x-my-signature', DB: db2 }
  );
  assert.equal(ok.status, 200);
  assert.equal(db2.rows.length, 1);
});

// ---- missing secret ---------------------------------------------------------

test('webhook-client: no WEBHOOK_CLIENT_SECRET is a 500 before any read/write', async () => {
  const db = makeDb();
  const res = await handle(makeCtx(RAW, { 'webhook-signature': 'whatever' }), { DB: db });
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /WEBHOOK_CLIENT_SECRET not configured/);
  assert.equal(db.rows.length, 0);
});

// ---- non-JSON payload -------------------------------------------------------

test('webhook-client: valid signature over a non-JSON body is still stored with an exception note', async () => {
  const secret = 's3cr3t';
  const raw = 'not-json-at-all';
  const sig = await sign(secret, raw);
  const db = makeDb();
  const res = await handle(makeCtx(raw, { 'webhook-signature': sig }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 200);
  assert.equal(db.rows.length, 1);
  const [, , payload, exception] = db.rows[0];
  assert.equal(payload, raw);
  assert.match(String(exception), /invalid JSON payload/);
});
