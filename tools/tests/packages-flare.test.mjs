// tools/tests/packages-flare.test.mjs — spatie/laravel-flare error-reporting port.
//
// The handler is exercised with a FAKE `fetch` injected as `env.fetchImpl` that
// captures the outgoing Request (url/method/headers/body) and returns a stubbed
// provider `Response`. We assert:
//   - the Flare endpoint + X-Flare-Key auth + JSON payload the handler builds,
//   - the 1:1 mapping of the provider response to {status, headers, body},
//   - validation guards (missing errorClass / credentials) short-circuit.
// No network, no D1 — a pure HTTP driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import flare from '../../ports/packages/flare.mjs';
import { makeFetch, okCtx } from './_helpers.mjs';

test('flare: posts report JSON to Flare with X-Flare-Key auth', async () => {
  const fetchImpl = makeFetch(200, { message: 'Reported successfully' });
  const ctx = okCtx({
    errorClass: 'RuntimeException',
    message: 'Something exploded',
    stacktrace: [{ file: '/app/Http/Controllers/Foo.php', lineNumber: 42, method: 'bar' }],
    metadata: { url: '/foo', user: 'jane' },
  });
  const env = { fetchImpl, FLARE_KEY: 'secret', FLARE_PROJECT_KEY: 'proj-123' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { message: 'Reported successfully' });
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://flareapp.io/api/report');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-flare-key'], 'secret:proj-123');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.errorClass, 'RuntimeException');
  assert.equal(sent.message, 'Something exploded');
  assert.deepEqual(sent.stacktrace, [
    { file: '/app/Http/Controllers/Foo.php', lineNumber: 42, method: 'bar' },
  ]);
  assert.deepEqual(sent.metadata, { url: '/foo', user: 'jane' });
});

test('flare: string stack frames are coerced and metadata passthrough preserved', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({
    errorClass: 'Error',
    stacktrace: ['/app/bootstrap/app.php'],
    metadata: { context: 'deploy' },
  });
  const env = { fetchImpl, FLARE_KEY: 'k', FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 200);
  const call = fetchImpl.calls[0];
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent.stacktrace, [{ file: '/app/bootstrap/app.php', lineNumber: 0, method: '(unknown)' }]);
  assert.deepEqual(sent.metadata, { context: 'deploy' });
  assert.equal(sent.message, undefined);
});

test('flare: missing FLARE_KEY is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ errorClass: 'Error' });
  const env = { fetchImpl, FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 500);
  assert.match(res.body, /FLARE_KEY/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('flare: missing FLARE_PROJECT_KEY is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ errorClass: 'Error' });
  const env = { fetchImpl, FLARE_KEY: 'k' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 500);
  assert.match(res.body, /FLARE_PROJECT_KEY/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('flare: missing errorClass is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ message: 'no class here' });
  const env = { fetchImpl, FLARE_KEY: 'k', FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 422);
  assert.match(res.body, /errorClass/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('flare: without a stack a minimal (edge) frame is sent', async () => {
  const fetchImpl = makeFetch(201, { ok: true });
  const ctx = okCtx({ errorClass: 'TypeError' });
  const env = { fetchImpl, FLARE_KEY: 'k', FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 201);
  const call = fetchImpl.calls[0];
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.stacktrace.length, 1);
  assert.equal(sent.stacktrace[0].file, '(edge)');
  assert.equal(sent.stacktrace[0].method, 'TypeError');
});

test('flare: non-2xx provider status is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(400, { error: 'bad payload' });
  const ctx = okCtx({ errorClass: 'Error' });
  const env = { fetchImpl, FLARE_KEY: 'k', FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'bad payload' });
});

test('flare: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const ctx = okCtx({ errorClass: 'Error' });
  const env = { fetchImpl, FLARE_KEY: 'k', FLARE_PROJECT_KEY: 'p' };

  const res = await flare(ctx, env);

  assert.equal(res.status, 502);
  assert.match(res.body, /network down/);
});
