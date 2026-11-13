// tools/tests/packages-midtrans-webhook.test.mjs — midtrans/midtrans-php
// inbound notification port.
//
// Exercised with a FAKE in-memory D1 (`env.DB`) that behaves like a
// `transactions` table keyed by PRIMARY KEY `order_id`, including the
// `INSERT OR IGNORE` idempotency semantics. Assertions cover:
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
import handler from '../../ports/packages/midtrans-webhook.mjs';
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

// Minimal D1 stub that records `transactions` rows keyed by order_id and
// honours INSERT OR IGNORE (a duplicate PK is absorbed, not re-inserted).
function makeDb() {
  const rows = new Map(); // order_id -> row
  const stmt = (sql) => ({
    bind: (...args) => ({
      run: async () => {
        if (/^INSERT/i.test(sql)) {
          const [order_id, status, gross_amount, payment_type, updated_at] = args;
          if (rows.has(order_id)) return { changes: 0, last_row_id: rows.size };
          const row = { order_id, status, gross_amount, payment_type, updated_at };
          rows.set(order_id, row);
          return { changes: 1, last_row_id: rows.size };
        }
        return {};
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    run: async () => ({}),
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return { rows, prepare: stmt };
}

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
  const db = makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, order_id: 'ORD-123' });

  const row = db.rows.get('ORD-123');
  assert.ok(row, 'transaction row should be persisted');
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
  const db = makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 200);
  const row = db.rows.get('ORD-NUM');
  assert.equal(row.gross_amount, '2500');
  assert.equal(row.status, 'settlement');
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
  const db = makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid signature' });
  assert.equal(db.rows.size, 0, 'nothing should be stored on a bad signature');
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
  const db = makeDb();

  const res = await handler(okCtx(body), envFor(db));

  assert.equal(res.status, 400);
  assert.equal(db.rows.size, 0);
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
  const db = makeDb();

  const first = await handler(okCtx({ ...body }), envFor(db));
  const second = await handler(okCtx({ ...body }), envFor(db));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body), { ok: true, order_id: 'ORD-DUP' });
  assert.equal(db.rows.size, 1, 'retry must not create a duplicate row');
});

// ---- Guards ----------------------------------------------------------------

test('midtrans: missing order_id is a 400 before any signature check', async () => {
  const db = makeDb();
  const res = await handler(
    okCtx({ status_code: '200', gross_amount: '1.00' }),
    envFor(db)
  );
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'order_id required' });
  assert.equal(db.rows.size, 0);
});

test('midtrans: missing MIDTRANS_SERVER_KEY is a 500', async () => {
  const body = { order_id: 'ORD-NOKEY', signature_key: 'x'.repeat(128) };
  const db = makeDb();
  const res = await handler(okCtx(body), { DB: db });
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'MIDTRANS_SERVER_KEY not configured' });
  assert.equal(db.rows.size, 0);
});
