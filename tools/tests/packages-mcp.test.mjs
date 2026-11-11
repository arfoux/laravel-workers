// tools/tests/packages-mcp.test.mjs — laravel/mcp WEB port (POST /mcp, JSON-RPC 2.0).
//
// The port is a pure JSON-RPC router: it parses the request object, dispatches
// by `method`, and dispatches `tools/call` into a registry handed to it via
// `env.MCP_TOOLS` / `env.MCP_PROMPTS` (the tools themselves are compiled app
// classes — the package's service provider is vendor code, not compiled).
// These tests exercise the JSON-RPC contract with NO network and NO D1:
//   - initialize       -> 200 + serverInfo + capabilities
//   - tools/list       -> 200 + tools array (executable half stripped)
//   - tools/call       -> dispatches to the registered handler by name
//   - prompts/list     -> 200 + prompts array
//   - unknown method   -> JSON-RPC error -32601
//   - malformed body   -> JSON-RPC parse/invalid-request errors
//   - non-POST         -> refused (the stdio transport has no edge)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcp from '../../ports/packages/mcp.mjs';

// A JSON-RPC request body, and the plain ctx a unit test hand-builds (same
// shape normalizePortCtx reads — `body` a property).
const rpc = (method, params, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const ctxFor = (body, method = 'POST') => ({ body, method, query: {}, params: {} });

// A small tool registry: one tool that records its arguments, one that throws.
function makeEnv(overrides = {}) {
  const calls = [];
  const tools = [
    {
      name: 'echo',
      description: 'Echo the arguments back as text.',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      call: async (args) => {
        calls.push({ tool: 'echo', args });
        return `echo: ${args && args.message}`;
      },
    },
    {
      name: 'boom',
      description: 'Always throws.',
      call: async () => {
        throw new Error('kaboom');
      },
    },
  ];
  const prompts = [
    {
      name: 'greet',
      description: 'A greeting prompt.',
      arguments: [{ name: 'who', description: 'Who to greet', required: true }],
      get: async (args) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `hello ${args && args.who}` } }],
      }),
    },
  ];
  return {
    env: { MCP_TOOLS: tools, MCP_PROMPTS: prompts, ...overrides },
    calls,
  };
}

const parse = (res) => JSON.parse(res.body);

// ---- initialize ------------------------------------------------------------

test('mcp: initialize returns 200 with serverInfo and capabilities', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('initialize', { protocolVersion: '2024-11-05' })), env);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  const body = parse(res);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.error, undefined);
  assert.equal(body.result.protocolVersion, '2024-11-05');
  assert.equal(body.result.serverInfo.name, 'laravel-mcp');
  // The registry exposes both tools and prompts, so both capabilities are on.
  assert.deepEqual(body.result.capabilities.tools, { listChanged: false });
  assert.deepEqual(body.result.capabilities.prompts, { listChanged: false });
});

test('mcp: initialize server name/version come from env', async () => {
  const { env } = makeEnv({ MCP_SERVER_NAME: 'acme', MCP_SERVER_VERSION: '9.9.9' });
  const res = await mcp(ctxFor(rpc('initialize', {})), env);
  const body = parse(res);
  assert.equal(body.result.serverInfo.name, 'acme');
  assert.equal(body.result.serverInfo.version, '9.9.9');
});

// ---- tools/list ------------------------------------------------------------

test('mcp: tools/list returns the tool definitions with the executable half stripped', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('tools/list', {})), env);

  assert.equal(res.status, 200);
  const body = parse(res);
  assert.equal(body.error, undefined);
  assert.ok(Array.isArray(body.result.tools));
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['boom', 'echo']);
  const echo = body.result.tools.find((t) => t.name === 'echo');
  assert.equal(echo.description, 'Echo the arguments back as text.');
  assert.deepEqual(echo.inputSchema, { type: 'object', properties: { message: { type: 'string' } } });
  // No function leaks into the wire definition.
  assert.equal(typeof echo.call, 'undefined');
});

test('mcp: tools/list accepts a map-keyed registry', async () => {
  const env = {
    MCP_TOOLS: {
      echo: { name: 'echo', call: async () => 'x' },
      solo: { call: async () => 'y' }, // no explicit name -> keyed in
    },
  };
  const res = await mcp(ctxFor(rpc('tools/list', {})), env);
  const names = parse(res).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['echo', 'solo']);
});

test('mcp: tools/list with no registry is an empty array, not a crash', async () => {
  const res = await mcp(ctxFor(rpc('tools/list', {})), {});
  assert.equal(res.status, 200);
  assert.deepEqual(parse(res).result.tools, []);
});

// ---- tools/call ------------------------------------------------------------

test('mcp: tools/call dispatches to the registered handler with params.arguments', async () => {
  const { env, calls } = makeEnv();
  const res = await mcp(
    ctxFor(rpc('tools/call', { name: 'echo', arguments: { message: 'hi edge' } })),
    env
  );

  assert.equal(res.status, 200);
  const body = parse(res);
  assert.equal(body.error, undefined);
  // The handler ran with the arguments, and its string return became MCP content.
  assert.deepEqual(calls, [{ tool: 'echo', args: { message: 'hi edge' } }]);
  assert.deepEqual(body.result.content, [{ type: 'text', text: 'echo: hi edge' }]);
  assert.equal(body.result.isError, undefined);
});

test('mcp: tools/call passes an object result through when already MCP-shaped', async () => {
  const env = {
    MCP_TOOLS: [
      {
        name: 'structured',
        call: async () => ({ content: [{ type: 'text', text: 'already' }], isError: false }),
      },
    ],
  };
  const res = await mcp(ctxFor(rpc('tools/call', { name: 'structured', arguments: {} })), env);
  const body = parse(res);
  assert.deepEqual(body.result, { content: [{ type: 'text', text: 'already' }], isError: false });
});

test('mcp: tools/call on a throwing tool is an isError content, not a protocol error', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('tools/call', { name: 'boom', arguments: {} }, 7)), env);
  const body = parse(res);
  assert.equal(body.id, 7);
  assert.equal(body.error, undefined); // the CALL was well-formed
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /kaboom/);
});

test('mcp: tools/call for an unknown tool is a JSON-RPC -32602 error', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('tools/call', { name: 'nope', arguments: {} }, 3)), env);
  const body = parse(res);
  assert.equal(body.id, 3);
  assert.equal(body.result, undefined);
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /Unknown tool: nope/);
});

test('mcp: tools/call with no name is a JSON-RPC -32602 error', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('tools/call', {}, 4)), env);
  assert.equal(parse(res).error.code, -32602);
});

// ---- prompts/list ----------------------------------------------------------

test('mcp: prompts/list returns prompt definitions with the executable half stripped', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('prompts/list', {})), env);
  const body = parse(res);
  assert.equal(res.status, 200);
  assert.equal(body.error, undefined);
  assert.deepEqual(body.result.prompts.map((p) => p.name), ['greet']);
  assert.deepEqual(body.result.prompts[0].arguments, [
    { name: 'who', description: 'Who to greet', required: true },
  ]);
  assert.equal(typeof body.result.prompts[0].get, 'undefined');
});

// ---- unknown method + malformed requests ----------------------------------

test('mcp: unknown method is a JSON-RPC -32601 error keeping the id', async () => {
  const { env } = makeEnv();
  const res = await mcp(ctxFor(rpc('resources/list', {}, 42)), env);
  assert.equal(res.status, 200);
  const body = parse(res);
  assert.equal(body.id, 42);
  assert.equal(body.result, undefined);
  assert.equal(body.error.code, -32601);
  assert.match(body.error.message, /Method not found: resources\/list/);
});

test('mcp: a non-JSON-RPC body (missing jsonrpc/method) is -32600 invalid request', async () => {
  const res = await mcp(ctxFor({ id: 1, params: {} }), {});
  assert.equal(parse(res).error.code, -32600);
});

test('mcp: a non-object body (raw non-JSON) is -32700 parse error', async () => {
  const res = await mcp(ctxFor('not json'), {}); // body is a string, not a JSON-RPC object
  assert.equal(parse(res).error.code, -32700);
});

test('mcp: a thrown internal error becomes -32603, never an unhandled reject', async () => {
  // Force the dispatcher to throw by making capabilities() blow up on a
  // getter-style registry.
  const env = {
    get MCP_TOOLS() {
      throw new Error('registry exploded');
    },
  };
  const res = await mcp(ctxFor(rpc('initialize', {}, 9)), env);
  const body = parse(res);
  assert.equal(body.id, 9);
  assert.equal(body.error.code, -32603);
  assert.match(body.error.message, /registry exploded/);
});

// ---- transport refusal -----------------------------------------------------

test('mcp: a GET is refused — the edge serves the POST JSON-RPC route only', async () => {
  const res = await mcp(ctxFor(undefined, 'GET'), {});
  const body = parse(res);
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /POST \/mcp/);
  assert.match(body.error.message, /stdio/); // names the refused transport
});
