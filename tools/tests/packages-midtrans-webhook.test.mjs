// tools/tests/packages-midtrans-webhook.test.mjs — midtrans/midtrans-php
// inbound notification port.
//
// Exercised against a fake `env.DB` backed by real SQLite
// (`tools/tests/_fake-d1.mjs`), whose `transactions` table is keyed by PRIMARY
// KEY `order_id`, so it reproduces the `INSERT OR IGNORE` idempotency semantics.
// Assertions cover:
//   - a valid signature_key → 200 and the transaction row persisted,
//   - a bad/tampered signature_key → 400 and nothing persisted,
//   - a re-delivered webhook with the same order_id → idempotent (still 200,
//     no duplicate row),
//   - guards: missing order_id → 400, missing server key → 500.
// No network — the signature is computed locally with node:crypto (the same
// formula PHP `hash('sha512', order_id.status_code.gross_amount.serverKey)`
// uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler, { ensureSchema } from '../../ports/packages/midtrans-webhook.mjs';
import { FakeD1 } from './_fake-d1.mjs';
import { okCtx } from './_helpers.mjs';

const SERVER_KEY = 'SB-Mid-server-rH-test-key-1234';

// Expected lowercase-hex signature: SHA512(order_id . status_code . gross_amount . serverKey).
function expectedSig(serverKey, body) {
  return crypto
    .createHash('sha512')
    .update(
      String(body.order_id) +
        String(body.status_code) +
        String(body.gross_amount) +
        String(serverKey)
    )
    .digest('hex');
}

// The rows the handler stored, straight out of SQLite ([] before ensureSchema):
// `transactions` is keyed by PRIMARY KEY order_id, so a duplicate insert is
// ignored by the engine.
const storedRows = (db) => db.tables.get('transactions') || [];

const makeDb = async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  return db;
};

const envFor = (db) => ({ MIDTRANS_SERVER_KEY: SERVER_KEY, DB: db });

// ---- Happy path ------------------------------------------------------------

test('midtrans: valid signature stores the transaction and returns 200', async () => {
  const body = {
    order_id: 'ORD-123',
    status_code: '200',
    gross_amount: '10000.00',
    transaction_status: 'capture',
    payment_type: 'credit_card',
  };
  body.signature_key = expectedSig(SERVER_KEY, body);
  const db = await makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, order_id: 'ORD-123' });

  const stored = storedRows(db);
  assert.equal(stored.length, 1, 'transaction row should be persisted');
  const row = stored[0];
  assert.equal(row.order_id, 'ORD-123');
  assert.equal(row.status, 'capture');
  assert.equal(row.gross_amount, '10000.00');
  assert.equal(row.payment_type, 'credit_card');
  assert.ok(row.updated_at, 'updated_at should be stamped');
});

test('midtrans: numeric fields are normalised to strings for the row', async () => {
  const body = {
    order_id: 'ORD-NUM',
    status_code: '201',
    gross_amount: 2500,
    transaction_status: 'settlement',
    payment_type: 'bank_transfer',
  };
  body.signature_key = expectedSig(SERVER_KEY, body);
  const db = await makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 200);
  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].order_id, 'ORD-NUM');
  assert.equal(stored[0].gross_amount, '2500');
  assert.equal(stored[0].status, 'settlement');
});

// ---- Signature guard -------------------------------------------------------

test('midtrans: wrong signature is a 400 and nothing is stored', async () => {
  const body = {
    order_id: 'ORD-BAD',
    status_code: '200',
    gross_amount: '5000.00',
    transaction_status: 'capture',
    payment_type: 'credit_card',
    signature_key: 'deadbeef'.repeat(16), // 128-hex, same length, wrong value
  };
  const db = await makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid signature' });
  assert.equal(storedRows(db).length, 0, 'nothing should be stored on a bad signature');
});

test('midtrans: tampered payload (gross_amount changed) is a 400', async () => {
  const body = {
    order_id: 'ORD-TAMP',
    status_code: '200',
    gross_amount: '100.00',
    transaction_status: 'capture',
    payment_type: 'credit_card',
  };
  body.signature_key = expectedSig(SERVER_KEY, body);
  // Attacker flips the amount after signing.
  body.gross_amount = '999999.00';
  const db = await makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 400);
  assert.equal(storedRows(db).length, 0);
});

// ---- Idempotency -----------------------------------------------------------

test('midtrans: duplicate order_id is idempotent (same 200, one row)', async () => {
  const body = {
    order_id: 'ORD-DUP',
    status_code: '200',
    gross_amount: '1000.00',
    transaction_status: 'capture',
    payment_type: 'credit_card',
  };
  body.signature_key = expectedSig(SERVER_KEY, body);
  const db = await makeDb();

  const first = await handler(okCtx({ ...body }), envFor(db));
  const second = await handler(okCtx({ ...body }), envFor(db));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body), { ok: true, order_id: 'ORD-DUP' });
  assert.equal(storedRows(db).length, 1, 'retry must not create a duplicate row');
});

// ---- Guards ----------------------------------------------------------------

test('midtrans: missing order_id is a 400 before any signature check', async () => {
  const db = await makeDb();
  const res = await handler(
    okCtx({ status_code: '200', gross_amount: '1.00' }),
    envFor(db)
  );
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'order_id required' });
  assert.equal(storedRows(db).length, 0);
});

test('midtrans: missing MIDTRANS_SERVER_KEY is a 500', async () => {
  const body = { order_id: 'ORD-NOKEY', signature_key: 'x'.repeat(128) };
  const db = await makeDb();
  const res = await handler(okCtx(body), { DB: db });
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'MIDTRANS_SERVER_KEY not configured' });
  assert.equal(storedRows(db).length, 0);
});
