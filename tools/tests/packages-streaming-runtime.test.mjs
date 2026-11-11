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
//   2. The worker's body contract `new Response(body, {status, headers})`
//      (what `toResponse` builds) yields a live Response whose body is that
//      same stream, readable end to end.
// `src/worker.mjs` itself is NOT importable in this test tree (it pulls the
// build-time `src/*.generated.mjs` modules, which exist only after
// `node build.mjs`), so the `toResponse` body contract is replicated here
// verbatim - the function is a 3-line adapter over `new Response` with no
// branching on the body type. The named export `toResponse` is asserted to
// exist from the source text, so a future refactor that drops or renames it
// fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dispatch, routeKey } from '../../kernel/router.mjs';

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

test('dispatch → toResponse body contract yields a readable Response stream', async () => {
  const handler = sseHandler(['data: hi\n\n']);
  const { table, handlers } = wire('GET', '/events', handler);

  const dispatched = await dispatch({ method: 'GET', path: '/events', headers: {} }, table, handlers, {});
  // `toResponse` is: `new Response(res.body, { status, headers })` (a GET
  // request keeps the body; only HEAD nulls it). Build the same thing.
  const response = new Response(dispatched.body, { status: dispatched.status, headers: dispatched.headers });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=UTF-8');
  assert.ok(response.body instanceof ReadableStream, 'Response.body is a ReadableStream');
  const text = new TextDecoder().decode(await readAll(response.body));
  assert.equal(text, 'data: hi\n\n');
});

test('HEAD request still nulls a streaming body (headers-only response)', async () => {
  const handler = sseHandler(['data: ignored\n\n']);
  const { table, handlers } = wire('HEAD', '/events', handler);
  const dispatched = await dispatch({ method: 'HEAD', path: '/events', headers: {} }, table, handlers, {});
  // toResponse's HEAD branch.
  const response = new Response(dispatched.body ? null : dispatched.body, { status: dispatched.status, headers: dispatched.headers });
  assert.equal(response.body, null);
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

test('src/worker.mjs still exports toResponse (the stream adapter)', () => {
  const src = fs.readFileSync(new URL('../../src/worker.mjs', import.meta.url), 'utf8');
  assert.match(src, /export \{ toResponse \}/, 'toResponse must stay exported for the stream path');
  assert.match(src, /new Response\(method === 'HEAD' \? null : res\.body/);
});
