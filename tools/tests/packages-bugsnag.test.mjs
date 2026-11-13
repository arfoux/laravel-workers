// tools/tests/packages-bugsnag.test.mjs — bugsnag-laravel port.
//
// Same shape as packages-notify-http.test.mjs: a FAKE `env.fetchImpl` records
// the outgoing Request (url/method/headers/body) and returns a canned provider
// Response. We assert:
//   - the notify.bugsnag.com URL + auth header + Bugsnag `events` payload shape,
//   - the 1:1 mapping of the provider response to {status, headers, body},
//   - validation guards short-circuit BEFORE fetch (missing apiKey -> 500,
//     missing `errorClass` -> 422), never spending a subrequest.
// No network, no D1 — pure HTTP driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bugsnag from '../../ports/packages/bugsnag.mjs';
import { makeFetch, okCtx } from './_helpers.mjs';

const okEnv = (fetchImpl) => ({ fetchImpl, BUGSNAG_API_KEY: 'test-api-key' });

// ---- Happy path ------------------------------------------------------------

test('bugsnag: posts JSON event to notify.bugsnag.com/events with api key header', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ errorClass: 'RuntimeException', message: 'boom' });
  const res = await bugsnag(ctx, okEnv(fetchImpl));

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(fetchImpl.calls.length, 1);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://notify.bugsnag.com/events');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['bugsnag-api-key'], 'test-api-key');
  assert.equal(call.init.headers['bugsnag-payload-version'], '4');
  assert.equal(call.init.headers['content-type'], 'application/json');
});

test('bugsnag: payload shape has apiKey, notifier, events[].exceptions[]', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ errorClass: 'RuntimeException', message: 'boom' });
  await bugsnag(ctx, okEnv(fetchImpl));

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.apiKey, 'test-api-key');
  assert.ok(sent.notifier && sent.notifier.name && sent.notifier.version, 'notifier block present');
  assert.ok(Array.isArray(sent.events) && sent.events.length === 1, 'one event');

  const ex = sent.events[0].exceptions[0];
  assert.equal(ex.errorClass, 'RuntimeException');
  assert.equal(ex.message, 'boom');
  assert.ok(Array.isArray(ex.stacktrace) && ex.stacktrace.length >= 1, 'stacktrace present');
});

test('bugsnag: caller-supplied stacktrace maps to {file,lineNumber,method}', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({
    errorClass: 'Error',
    message: 'db down',
    stacktrace: [
      { file: '/app/Http/Kernel.php', lineNumber: 42, method: 'handle' },
      { file: '/app/index.php', line: 7, method: 'run' },
    ],
  });
  await bugsnag(ctx, okEnv(fetchImpl));

  const ex = JSON.parse(fetchImpl.calls[0].init.body).events[0].exceptions[0];
  assert.deepEqual(ex.stacktrace[0], {
    file: '/app/Http/Kernel.php',
    lineNumber: 42,
    method: 'handle',
  });
  assert.deepEqual(ex.stacktrace[1], {
    file: '/app/index.php',
    lineNumber: 7,
    method: 'run',
  });
});

test('bugsnag: missing stacktrace falls back to a single minimal frame', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ errorClass: 'RuntimeException', message: 'boom' });
  await bugsnag(ctx, okEnv(fetchImpl));

  const ex = JSON.parse(fetchImpl.calls[0].init.body).events[0].exceptions[0];
  assert.equal(ex.stacktrace.length, 1);
  assert.equal(ex.stacktrace[0].file, '(edge)');
});

test('bugsnag: optional appVersion and releaseStage are forwarded', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({
    errorClass: 'RuntimeException',
    message: 'boom',
    appVersion: '1.2.3',
    releaseStage: 'production',
  });
  await bugsnag(ctx, okEnv(fetchImpl));

  const event = JSON.parse(fetchImpl.calls[0].init.body).events[0];
  assert.equal(event.app.version, '1.2.3');
  assert.equal(event.releaseStage, 'production');
});

// ---- Guards (short-circuit before fetch) -----------------------------------

test('bugsnag: missing BUGSNAG_API_KEY is 500 and never fetches', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ errorClass: 'RuntimeException', message: 'boom' });
  const res = await bugsnag(ctx, { fetchImpl });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body).error, 'missing Bugsnag credential: set BUGSNAG_API_KEY');
  assert.equal(fetchImpl.calls.length, 0);
});

test('bugsnag: missing errorClass is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ message: 'boom' });
  const res = await bugsnag(ctx, okEnv(fetchImpl));

  assert.equal(res.status, 422);
  assert.deepEqual(JSON.parse(res.body).error, 'missing `errorClass`');
  assert.equal(fetchImpl.calls.length, 0);
});

test('bugsnag: missing message is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const ctx = okCtx({ errorClass: 'RuntimeException' });
  const res = await bugsnag(ctx, okEnv(fetchImpl));

  assert.equal(res.status, 422);
  assert.deepEqual(JSON.parse(res.body).error, 'missing `message`');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Cross-cutting: provider response mapping ------------------------------

test('bugsnag: non-2xx provider status is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(401, { error: 'invalid api key' });
  const res = await bugsnag(okCtx({ errorClass: 'Error', message: 'x' }), okEnv(fetchImpl));

  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid api key' });
});

test('bugsnag: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => {
    throw new Error('socket hang up');
  };
  const res = await bugsnag(okCtx({ errorClass: 'Error', message: 'x' }), { fetchImpl, BUGSNAG_API_KEY: 'k' });

  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).error, 'socket hang up');
});

test('primitive: resolveFetch falls back to globalThis.fetch when no env impl', async () => {
  const fetchImpl = makeFetch(202, { ok: true });
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const res = await bugsnag(okCtx({ errorClass: 'Error', message: 'x' }), { BUGSNAG_API_KEY: 'k' });
    assert.equal(res.status, 202);
    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});
