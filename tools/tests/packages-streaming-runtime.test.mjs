// tools/tests/packages-streaming-runtime.test.mjs — streaming runtime gap
//
// Orchestrator-01 finding: `kernel/router.mjs` `dispatch()` threw
// 'handler returned invalid response shape' for any body that was not
// `string | Uint8Array | null`, so a port that answered a ReadableStream (an
// SSE / streaming port) could never leave the runtime. `src/worker.mjs`
// `toResponse()` passed `res.body` straight into `new Response(...)`, which the
// Workers runtime accepts for a ReadableStream - so the ONLY blocker was the
// dispatch guard.
//
// These tests exercise the two rungs the stream crosses:
//   1. `dispatch` accepts a handler that returns a ReadableStream body.
//   2. The worker's REAL `toResponse` adapter turns that body into a live
//      Response: GET streams the bytes, HEAD sends headers only.
// `src/worker.mjs` also imports build-time modules that exist only after
// `node build.mjs`, so a small in-memory ESM loader answers just those
// specifiers with empty stubs. `toResponse` itself is imported from the real
// source file - no source-text pinning or re-implementation here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { dispatch, routeKey } from '../../kernel/router.mjs';

// The build-time modules worker.mjs imports are irrelevant to toResponse;
// answer them with one inert stub so the REAL worker module can be imported
// without running a build (and without editing source owned by another agent).
const stubSource = [
  'export const routeTable = [];',
  'export const handlers = {};',
  'export const builtAt = null;',
  'export function guardPorts() { return null; }',
  'export const events = [];',
  'export const models = {};',
  'export const classes = {};',
  "export function renderErrorView() { return ''; }",
  'export function buildRt() { return {}; }',
  'export default {};',
].join('\n');
const stubUrl = 'data:text/javascript,' + encodeURIComponent(stubSource);
const loaderUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.generated.mjs') ||
      specifier.endsWith('/error-renderer.mjs') ||
      specifier.endsWith('/rt-from-context.mjs')) {
    return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
register(loaderUrl);
const { toResponse } = await import('../../src/worker.mjs');

// Build a handler that returns a streaming text/event-stream body and, as it
// emits each chunk, records what it wrote (so the test can assert the stream
// actually carried the bytes end to end).
function sseHandler(events) {
  return async function handle(ctx) {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const ev of events) {
          controller.enqueue(enc.encode(ev));
        }
        controller.close();
      },
    });
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=UTF-8', 'cache-control': 'no-cache' },
      body: stream,
    };
  };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// The route table + handlers a port lives behind. `routeKey` derives the
// handler key exactly as dispatch does internally.
function wire(method, uri, handler) {
  const table = [{ uri, methods: [method] }];
  const handlers = { [routeKey({ uri, methods: [method] })]: handler };
  return { table, handlers };
}

test('dispatch accepts a ReadableStream body (previously: invalid response shape)', async () => {
  const handler = sseHandler(['data: hello\n\n', 'data: world\n\n']);
  const { table, handlers } = wire('GET', '/stream', handler);

  const dispatched = await dispatch({ method: 'GET', path: '/stream', headers: {} }, table, handlers, {});
  assert.ok(dispatched, 'dispatch returned a response');
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.headers['content-type'], 'text/event-stream; charset=UTF-8');
  assert.ok(dispatched.body instanceof ReadableStream, 'dispatched body is a ReadableStream');

  const bytes = await readAll(dispatched.body);
  assert.equal(new TextDecoder().decode(bytes), 'data: hello\n\ndata: world\n\n');
});

test('toResponse (the real worker adapter): GET streams the body with status and headers', async () => {
  const handler = sseHandler(['data: hi\n\n', 'data: bye\n\n']);
  const { table, handlers } = wire('GET', '/events', handler);
  const dispatched = await dispatch({ method: 'GET', path: '/events', headers: {} }, table, handlers, {});

  const response = toResponse(dispatched, 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=UTF-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.ok(response.body instanceof ReadableStream, 'Response.body is the live stream');
  assert.equal(new TextDecoder().decode(await readAll(response.body)), 'data: hi\n\ndata: bye\n\n');
});

test('toResponse (the real worker adapter): HEAD sends headers only and leaves the stream intact', async () => {
  const handler = sseHandler(['data: only-on-get\n\n']);
  const { table, handlers } = wire('HEAD', '/events', handler);
  const dispatched = await dispatch({ method: 'HEAD', path: '/events', headers: {} }, table, handlers, {});

  const head = toResponse(dispatched, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'text/event-stream; charset=UTF-8');
  assert.equal(head.headers.get('cache-control'), 'no-cache');
  assert.equal(head.body, null, 'HEAD has no body, stream or not');

  // HEAD must not consume or close the underlying stream: a GET over the same
  // dispatched result still carries the bytes.
  const get = toResponse(dispatched, 'GET');
  assert.equal(new TextDecoder().decode(await readAll(get.body)), 'data: only-on-get\n\n');
});

test('a port handler still streams when it reads ctx.method / ctx.params', async () => {
  const seen = {};
  const handler = async function handle(ctx) {
    seen.method = ctx.method;
    seen.id = ctx.params.id;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('ok ' + String(ctx.params.id)));
        c.close();
      },
    });
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: stream };
  };
  const { table, handlers } = wire('GET', '/stream/{id}', handler);
  const dispatched = await dispatch({ method: 'GET', path: '/stream/77', headers: {} }, table, handlers, {});
  assert.equal(seen.method, 'GET');
  assert.equal(seen.id, '77');
  assert.equal(new TextDecoder().decode(await readAll(dispatched.body)), 'ok 77');
});

test('non-stream bodies keep the old contract (string / Uint8Array / null pass, junk rejected)', async () => {
  const ok = (body) => async () => ({ status: 200, headers: {}, body });
  for (const body of ['plain', new Uint8Array([1, 2, 3]), null, undefined]) {
    const { table, handlers } = wire('GET', '/x', ok(body));
    const r = await dispatch({ method: 'GET', path: '/x', headers: {} }, table, handlers, {});
    assert.equal(r.status, 200);
  }
  await assert.rejects(
    async () => {
      const { table, handlers } = wire('GET', '/x', ok({ not: 'a body' }));
      await dispatch({ method: 'GET', path: '/x', headers: {} }, table, handlers, {});
    },
    /handler returned invalid response shape/
  );
});
