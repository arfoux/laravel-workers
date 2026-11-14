// tools/tests/packages-webhook-client.test.mjs — spatie/laravel-webhook-client port.
//
// Exercised with a real fetch `Request` (so the raw body bytes are exact) and a
// fake `env.DB` backed by real SQLite (`tools/tests/_fake-d1.mjs`). We assert:
//   - a VALID `webhook-signature` (base64 HMAC-SHA256 of the raw body) → 200,
//     the call is stored in `webhook_calls`, payload/processed_at populated;
//   - a WRONG / missing signature → 400 and NOTHING is written;
//   - no WEBHOOK_CLIENT_SECRET configured → 500 before any read.
// No network, no real D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle, { ensureSchema } from '../../ports/packages/webhook-client.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// ---- helpers ----------------------------------------------------------------

async function sign(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// The rows the handler stored, straight out of SQLite ([] before ensureSchema).
const storedRows = (db) => db.tables.get('webhook_calls') || [];

async function columnsOf(db, table) {
  const res = await db.prepare(`PRAGMA table_info('${table}')`).all();
  return res.results.map((r) => r.name);
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
  const db = new FakeD1();
  const ctx = makeCtx(RAW, { 'webhook-signature': sig });
  const res = await handle(ctx, { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.received, true);
  assert.equal(out.name, 'stripe');
  assert.ok(out.id);

  // stored: one row with (id, name, payload, exception, processed_at)
  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, out.id);
  assert.equal(stored[0].name, 'stripe');
  assert.equal(stored[0].payload, RAW);
  assert.equal(stored[0].exception, null);
  assert.ok(stored[0].processed_at);
});

test('webhook-client: schema creates webhook_calls with the expected columns', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  assert.ok(db.tables.has('webhook_calls'));
});

test('webhook-client: schema columns are (id, name, payload, exception, processed_at)', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  assert.deepEqual(await columnsOf(db, 'webhook_calls'), ['id', 'name', 'payload', 'exception', 'processed_at']);
});

// ---- invalid / missing signature -------------------------------------------

test('webhook-client: wrong signature is rejected (400) and nothing is stored', async () => {
  const secret = 's3cr3t';
  const wrong = await sign('another-secret', RAW);
  const db = new FakeD1();
  const res = await handle(makeCtx(RAW, { 'webhook-signature': wrong }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid signature');
  assert.equal(storedRows(db).length, 0);
});

test('webhook-client: tampered body (valid sig over different payload) is rejected', async () => {
  const secret = 's3cr3t';
  const sig = await sign(secret, RAW);
  const tampered = JSON.stringify({ event: 'payment.captured', data: { id: 'evt_1', amount: 999999 } });
  const db = new FakeD1();
  const res = await handle(makeCtx(tampered, { 'webhook-signature': sig }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 400);
  assert.equal(storedRows(db).length, 0);
});

test('webhook-client: missing signature header is a 400 and nothing is stored', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(RAW, {}), { WEBHOOK_CLIENT_SECRET: 's3cr3t', DB: db });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /missing webhook-signature/);
  assert.equal(storedRows(db).length, 0);
});

test('webhook-client: custom signature header name is honoured via env', async () => {
  const secret = 's3cr3t';
  const sig = await sign(secret, RAW);
  const db = new FakeD1();
  // signed under the default header name but configured for a custom one → 400
  const wrongHeader = await handle(
    makeCtx(RAW, { 'webhook-signature': sig }),
    { WEBHOOK_CLIENT_SECRET: secret, WEBHOOK_CLIENT_SIGNATURE_HEADER: 'x-my-signature', DB: db }
  );
  assert.equal(wrongHeader.status, 400);

  // signed + sent under the configured custom header → 200
  const db2 = new FakeD1();
  const ok = await handle(
    makeCtx(RAW, { 'x-my-signature': sig }),
    { WEBHOOK_CLIENT_SECRET: secret, WEBHOOK_CLIENT_SIGNATURE_HEADER: 'x-my-signature', DB: db2 }
  );
  assert.equal(ok.status, 200);
  assert.equal(storedRows(db2).length, 1);
});

// ---- missing secret ---------------------------------------------------------

test('webhook-client: no WEBHOOK_CLIENT_SECRET is a 500 before any read/write', async () => {
  const db = new FakeD1();
  const res = await handle(makeCtx(RAW, { 'webhook-signature': 'whatever' }), { DB: db });
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /WEBHOOK_CLIENT_SECRET not configured/);
  assert.equal(storedRows(db).length, 0);
});

// ---- non-JSON payload -------------------------------------------------------

test('webhook-client: valid signature over a non-JSON body is still stored with an exception note', async () => {
  const secret = 's3cr3t';
  const raw = 'not-json-at-all';
  const sig = await sign(secret, raw);
  const db = new FakeD1();
  const res = await handle(makeCtx(raw, { 'webhook-signature': sig }), { WEBHOOK_CLIENT_SECRET: secret, DB: db });

  assert.equal(res.status, 200);
  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload, raw);
  assert.match(String(stored[0].exception), /invalid JSON payload/);
});
