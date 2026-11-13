// tools/tests/packages-webhook-server.test.mjs — spatie/laravel-webhook-server
// port (CLIENT side: sign + send an outgoing webhook, log the call to D1).
//
// Exercised with a FAKE `env.fetchImpl` that captures the outgoing request
// (url/method/headers/body) and a FAKE `env.DB` (D1) that records INSERTs, so
// we can assert the call was logged. Assertions cover:
//   - the target URL + POST + signature/timestamp headers the handler builds,
//   - the signature is a valid base64 HMAC-SHA256 over the sent raw body,
//   - the call is persisted to `webhook_calls`,
//   - validation guards (missing `url` → 422; missing secret → 500) short-circuit
//     before any fetch.
// No network — the target "endpoint" is the stubbed fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler from '../../ports/packages/webhook-server.mjs';
import { makeFetch } from './_helpers.mjs';

// `user_id` is what a `middlewarePorts` guard writes onto ctx for an
// authenticated caller (the route requires one; app code calls signPayload()
// directly instead of this HTTP seam).
const okCtx = (body) => ({ body, query: {}, params: {}, user_id: 1 });

// Minimal D1 stub: `prepare(sql).bind(...).run()/first()/all()`, recording binds.
function makeDb() {
  const inserts = [];
  let nextId = 1;
  const stmt = (sql) => ({
    bind: (...args) => ({
      run: async () => {
        if (/INSERT INTO webhook_calls/i.test(sql)) {
          inserts.push({
            uuid: args[0],
            url: args[1],
            payload: args[2],
            signature: args[3],
            headers: args[4],
            tags: args[5],
            response_status: args[6],
            response_body: args[7],
            error: args[8],
            created_at: args[9],
          });
          return { last_row_id: nextId++ };
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
  return {
    inserts,
    prepare: stmt,
  };
}

// Expected signature: base64(HMAC-SHA256(secret, rawBody)).
function expectedSig(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

const SECRET = 'top-secret-shared-key';

// ---- Happy path ------------------------------------------------------------

test('webhook-server: POSTs signed JSON payload to the target url', async () => {
  const fetchImpl = makeFetch(200, { received: true });
  const db = makeDb();
  const payload = { event: 'user.created', user: { id: 7 } };
  const res = await handler(okCtx({ url: 'https://example.com/hook', payload }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });

  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://example.com/hook');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.event, 'user.created');
  assert.equal(sent.user.id, 7);
});

test('webhook-server: signature header is valid base64 HMAC-SHA256 of the body', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = makeDb();
  const payload = { hello: 'world' };
  await handler(okCtx({ url: 'https://example.com/hook', payload }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });

  const call = fetchImpl.calls[0];
  const sig = call.init.headers['webhook-signature'];
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 0);
  // Byte-for-byte match against an independent HMAC over the exact sent body.
  assert.equal(sig, expectedSig(SECRET, call.init.body));
  // A tampered payload must not match.
  assert.notEqual(sig, expectedSig(SECRET, call.init.body + 'x'));
  // Timestamp header present and numeric.
  assert.match(call.init.headers['webhook-timestamp'], /^\d+$/);
});

test('webhook-server: records the call in D1 webhook_calls', async () => {
  const fetchImpl = makeFetch(200, { ok: true, id: 'rc_1' });
  const db = makeDb();
  const payload = { n: 1 };
  const res = await handler(okCtx({ url: 'https://example.com/hook', payload, tags: 'deploy' }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });

  assert.equal(db.inserts.length, 1);
  const row = db.inserts[0];
  assert.equal(row.url, 'https://example.com/hook');
  assert.equal(JSON.parse(row.payload).n, 1);
  assert.equal(row.signature, expectedSig(SECRET, row.payload));
  assert.equal(row.response_status, 200);
  assert.equal(JSON.parse(row.response_body).id, 'rc_1');
  assert.equal(row.tags, 'deploy');
  assert.equal(row.error, null);
  assert.ok(row.created_at);
  // Handler surfaces the logged call id.
  assert.equal(JSON.parse(res.body).call.response_status, 200);
});

// ---- Guards ----------------------------------------------------------------

test('webhook-server: missing url is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = makeDb();
  const res = await handler(okCtx({ payload: { a: 1 } }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });
  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.body).error, 'body.url (https) required');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.inserts.length, 0);
});

test('webhook-server: non-http url is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await handler(okCtx({ url: 'ftp://example.com/hook', payload: {} }), {
    fetchImpl,
    DB: makeDb(),
    WEBHOOK_SERVER_SECRET: SECRET,
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webhook-server: missing secret is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = makeDb();
  const res = await handler(okCtx({ url: 'https://example.com/hook', payload: {} }), {
    fetchImpl,
    DB: db,
  });
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'WEBHOOK_SERVER_SECRET not configured');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.inserts.length, 0);
});

// ---- Response mapping ------------------------------------------------------

test('webhook-server: non-2xx target status is surfaced (ok:false) but still logged', async () => {
  const fetchImpl = makeFetch(500, { boom: true });
  const db = makeDb();
  const res = await handler(okCtx({ url: 'https://example.com/hook', payload: {} }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.call.response_status, 500);
  assert.equal(db.inserts[0].response_status, 500);
});

test('webhook-server: a thrown fetch becomes a 502, logged with an error', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    throw new Error('network down');
  };
  const db = makeDb();
  const res = await handler(okCtx({ url: 'https://example.com/hook', payload: {} }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).error, 'network down');
  assert.equal(calls.length, 1);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].error, 'network down');
});

test('webhook-server: no identity → 401, never signs and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = makeDb();
  const res = await handler({ body: { url: 'https://example.com/hook', payload: {} }, query: {}, params: {} }, {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SECRET,
  });
  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.inserts.length, 0);
});

test('webhook-server: caller headers cannot replace the signed headers', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await handler(
    okCtx({
      url: 'https://example.com/hook',
      payload: { a: 1 },
      headers: { 'webhook-signature': 'forged', 'webhook-timestamp': '1', 'content-type': 'text/plain' },
    }),
    { fetchImpl, WEBHOOK_SERVER_SECRET: SECRET },
  );
  assert.equal(res.status, 201);
  const sent = fetchImpl.calls[0].init.headers;
  assert.notEqual(sent['webhook-signature'], 'forged');
  assert.notEqual(sent['webhook-timestamp'], '1');
  const expected = crypto.createHmac('sha256', SECRET).update(fetchImpl.calls[0].init.body).digest('base64');
  assert.equal(sent['webhook-signature'], expected);
});
