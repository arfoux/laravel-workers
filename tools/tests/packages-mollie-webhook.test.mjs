// tools/tests/packages-mollie-webhook.test.mjs — mollie/laravel-cashier-mollie
// port (webhook receiver + reverse-reconcile).
//
// Exercised with a FAKE `env.fetchImpl` that captures the outgoing lookup
// (url/method/headers) and returns a stubbed Mollie payment, plus a FAKE
// `env.DB` backed by real SQLite (`tools/tests/_fake-d1.mjs`) that stores the
// payment upsert. Assertions cover:
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
import { FakeD1 } from './_fake-d1.mjs';

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

// The rows the handler upserted into `mollie_payments` ([] before ensureSchema),
// straight out of SQLite. The port calls ensureSchema itself before the upsert.
const storedRows = (db) => db.tables.get('mollie_payments') || [];

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
  const db = new FakeD1();
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

  // Payment row was upserted with the reconciled status. The stub's parallel
  // `payments` Map (`db.payments.has(id)` — a second read of the same fact) is
  // folded into this real row assertion.
  const stored = storedRows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, PAYMENT.id);
  assert.equal(stored[0].status, 'paid');
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
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });
  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(attempts, 2);
  assert.equal(res.status, 200);
  assert.equal(storedRows(db).length, 1);
});

test('mollie: invalid signature is 401 and never fetches or writes', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, 'sha256=aGVsbG8='), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(storedRows(db).length, 0);
});

test('mollie: absent signature header is the legacy webhook and still reconciles', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, ''), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(storedRows(db).length, 1);
});

test('mollie: legacy webhook works with no signing secret configured', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, ''), { fetchImpl, DB: db, MOLLIE_API_KEY: API_KEY });

  assert.equal(res.status, 200);
  assert.equal(storedRows(db).length, 1);
});

test('mollie: a present signature with no configured secret is 401', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(storedRows(db).length, 0);
});

test('mollie: the `sha256=` prefix is accepted', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  const res = await handler(okCtx(rawBody, `sha256=${sign(SECRET, rawBody)}`), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 200);
  assert.equal(storedRows(db).length, 1);
});

test('mollie: a base64 signature is rejected (the official digest is hex)', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
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
  const db = new FakeD1();
  const rawBody = JSON.stringify({ event: 'payment.captured' });

  const res = await handler(okCtx(rawBody, sign(SECRET, rawBody)), {
    fetchImpl,
    DB: db,
    MOLLIE_WEBHOOK_SECRET: SECRET,
    MOLLIE_API_KEY: API_KEY,
  });

  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(storedRows(db).length, 0);
});

test('mollie: a missing API key is 500 before any work', async () => {
  const fetchImpl = makeFetch(200, PAYMENT);
  const db = new FakeD1();
  const rawBody = JSON.stringify({ id: PAYMENT.id });

  // The API key is what the reverse-reconcile needs, so it is the hard
  // requirement; the signing secret is optional (legacy webhooks are unsigned).
  const res = await handler(okCtx(rawBody, ''), { fetchImpl, DB: db, MOLLIE_WEBHOOK_SECRET: SECRET });

  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'MOLLIE_API_KEY not configured');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(storedRows(db).length, 0);
});

test('mollie: non-200 upstream payment lookup is surfaced (404 for missing payment)', async () => {
  const fetchImpl = makeFetch(404, { status: 404 });
  const db = new FakeD1();
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
  assert.equal(storedRows(db).length, 0);
});

test('mollie: ensureSchema creates the payments table', async () => {
  const db = new FakeD1();
  await ensureSchema({ DB: db });
  // The real table now exists, with the shape the upsert binds against.
  assert.ok(db.tables.has('mollie_payments'));
  const info = await db.prepare("PRAGMA table_info('mollie_payments')").all();
  assert.deepEqual(info.results.map((c) => c.name), [
    'id', 'method', 'status', 'amount_value', 'amount_currency', 'customer_id',
    'paid_at', 'canceled_at', 'expires_at', 'created_at', 'updated_at', 'webhook_meta',
  ]);
  assert.equal(info.results.find((c) => c.name === 'id').pk, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// The production shape: the ctx comes from a REAL kernel Request, not a
// hand-built one. `okCtx` above hands the port `text: async () => rawBody`, which
// hid the bug this test exists for: the kernel Request had no raw-body accessor,
// so `ctx.request.text()` answered JSON.stringify(parsed) — a re-serialised body
// the provider's signature cannot match. Verified by probe before the fix: a
// genuinely signed, pretty-printed payload was answered 401.
// ─────────────────────────────────────────────────────────────────────────────
test('mollie: a genuinely signed webhook over a real kernel Request reaches the reconcile', async () => {
  const { buildRequest } = await import('../../kernel/http.mjs');
  const { normalizePortCtx } = await import('../../kernel/packages/port-ctx.mjs');

  // Pretty-printed on purpose: the raw bytes differ from JSON.stringify(parsed).
  const rawBody = '{\n  "id": "tr_7UhSN1zuXS",\n  "status": "paid"\n}';
  const kernReq = buildRequest({
    method: 'POST',
    url: 'https://app.test/webhooks/mollie',
    headers: { 'content-type': 'application/json', 'x-mollie-signature': sign(SECRET, rawBody) },
    body: rawBody,
  });
  const ctx = normalizePortCtx({ method: 'POST', params: {}, query: {}, request: kernReq });

  assert.equal(await ctx.request.text(), rawBody, 'the port must see the bytes as they arrived');

  const payment = { id: 'tr_7UhSN1zuXS', status: 'paid', amount: { value: '10.00', currency: 'EUR' } };
  const fetchImpl = makeFetch(200, payment);
  const db = new FakeD1();
  const res = await handler(ctx, { fetchImpl, DB: db, MOLLIE_WEBHOOK_SECRET: SECRET, MOLLIE_API_KEY: API_KEY });

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(storedRows(db).length, 1);

  // The re-serialised body is exactly what must NOT be signed.
  const reparsed = JSON.stringify(JSON.parse(rawBody));
  const wrong = await handler(
    normalizePortCtx({
      method: 'POST', params: {}, query: {},
      request: {
        header: () => sign(SECRET, rawBody),
        json: () => JSON.parse(rawBody),
        text: () => reparsed,
      },
    }),
    { fetchImpl: makeFetch(200, payment), DB: new FakeD1(), MOLLIE_WEBHOOK_SECRET: SECRET, MOLLIE_API_KEY: API_KEY },
  );
  assert.equal(wrong.status, 401, 'a signature over re-serialised bytes stays rejected');
});
