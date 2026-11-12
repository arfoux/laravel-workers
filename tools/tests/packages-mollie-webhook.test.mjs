// tools/tests/packages-mollie-webhook.test.mjs — mollie/laravel-cashier-mollie
// port (webhook receiver + reverse-reconcile).
//
// Exercised with a FAKE `env.fetchImpl` that captures the outgoing lookup
// (url/method/headers) and returns a stubbed Mollie payment, plus a FAKE
// `env.DB` (D1) that records the payment upsert. Assertions cover:
//   - a valid `X-Mollie-Signature` (hex HMAC-SHA256 of the raw body, `sha256=`
//     prefix optional) is accepted → 200 AND the reverse-reconcile GET hits the
//     payments endpoint with a Bearer key and the D1 payment row is upserted,
//   - an ABSENT header is the classic unsigned webhook (Mollie's own validator
//     calls it the legacy webhook) → same 200 + reverse-reconcile path, with or
//     without a configured signing secret,
//   - a present-but-wrong signature (or one we cannot verify, i.e. no secret
//     configured) is 401 BEFORE any fetch/D1 work,
//   - a body without `id` is a 422, again without spending a subrequest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler, { ensureSchema } from '../../ports/packages/mollie-webhook.mjs';

// Mollie's own SignatureValidator computes `hash_hmac('sha256', $payload, $secret)`
// — HEX, and the header may carry the `sha256=` prefix.
function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(String(rawBody)).digest('hex');
}

// Build a fake fetch that records lookups and replies with a canned payment.
function makeFetch(status, payment, { rawBody, headers } = {}) {
  const calls = [];
  const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(payment);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(bodyText, {
      status,
      headers: headers || { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Minimal D1 stub: records `mollie_payments` upserts by payment id.
function makeDb() {
  const payments = new Map();
  const rows = [];
  let nextId = 1;
  const stmt = (sql) => ({
    bind: (...args) => ({
      run: async () => {
        if (/INSERT INTO mollie_payments/i.test(sql)) {
          rows.push({
            id: args[0],
            fn: sql.includes('ON CONFLICT') ? 'upsert' : 'insert',
            created_at: args[9],
          });
          payments.set(String(args[0]), true);
          if (!sql.includes('ON CONFLICT')) {
            return { meta: { changes: 1 }, last_row_id: nextId++ };
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    run: async () => ({ meta: { changes: 0 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return {
    payments,
    rows,
    prepare: stmt,
  };
}

const SECRET = 'top-secret-mollie-key';
const API_KEY = 'test_api_key_123';

function okCtx(rawBody, headerSig) {
  // Mirror the kernel Request shape `normalizePortCtx` expects: both `header`
  // and `json` are methods (a plain object with only `text` is treated as a
  // kernel Request and the raw-text branch is skipped, so `json` must be here).
  return {
    request: {
      header: () => headerSig,
      json: () => JSON.parse(rawBody),
      text: async () => rawBody,
    },
    body: JSON.parse(rawBody),
    params: {},
    query: {},
  };
}

const PAYMENT = {
  id: 'tr_7UhSN1zuXS',
  method: 'ideal',
  status: 'paid',
  amount: { value: '10.00', currency: 'EUR' },
  customerId: 'cst_utCvC8UMSK',
  paidAt: '2024-10-12T10:00:00+00:00',
};

test('mollie: valid signature → 200, reverse-reconciles GET and upserts D1 payment', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });
  const ctx = okCtx(rawBody, sign(SECRET, rawBody));

  const res = await handler(ctx, {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).status, 'paid');

  // One reverse-reconcile GET against the payments endpoint + Bearer auth.
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://api.mollie.com/v2/payments/${PAYMENT.id}`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.authorization, `Bearer ${API_KEY}`);

  // Payment row was upserted with the reconciled status.
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].id, PAYMENT.id);
  assert.equal(db.payments.has(PAYMENT.id), true);
});

test('mollie: a 404 lookup is retried once before failing', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response(attempts === 1 ? 'not found' : JSON.stringify(PAYMENT), {
      status: attempts === 1 ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });
  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(attempts, 2);
  assert.equal(res.status, 200);
  assert.equal(db.rows.length, 1);
});

test('mollie: invalid signature is 401 and never fetches or writes', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, 'sha256=aGVsbG8='), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('mollie: absent signature header is the legacy webhook and still reconciles', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, ''), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(db.rows.length, 1);
});

test('mollie: legacy webhook works with no signing secret configured', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, ''), { fetchImpl, DB: db, MOLLIE_API_KEY: API_KEY });

  assert.equal(res.status, 200);
  assert.equal(db.rows.length, 1);
});

test('mollie: a present signature with no configured secret is 401', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('mollie: the `sha256=` prefix is accepted', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, `sha256=${sign(SECRET, rawBody)}`), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 200);
  assert.equal(db.rows.length, 1);
});

test('mollie: a base64 signature is rejected (the official digest is hex)', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });
  const base64 = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');

  const res = await handler(okCtx(rawBody, base64), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
});

test('mollie: webhook without an id is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ event: 'payment.captured' });

  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('mollie: a missing API key is 500 before any work', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = makeDb();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  // The API key is what the reverse-reconcile needs, so it is the hard
  // requirement; the signing secret is optional (legacy webhooks are unsigned).
  const res = await handler(okCtx(rawBody, ''), { fetchImpl, DB: db, MOLLIE_WEBHOOK_SECRET: SECRET });

  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'MOLLIE_API_KEY not configured');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('mollie: non-200 upstream payment lookup is surfaced (404 for missing payment)', async () => {
  const fetchImpl = makeFetch(404, { status: 404 });
  const db = makeDb();
  const rawBody = JSON.stringify({ id: 'tr_missing' });

  // After the single retry the payment is still missing → 404.
  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 404);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(db.rows.length, 0);
});

test('mollie: ensureSchema creates the payments table', async () => {
  const db = makeDb();
  await ensureSchema({ DB: db });
  // The CREATE TABLE ran without throwing; the stub accepts any SQL.
  assert.equal(typeof db.prepare, 'function');
});
