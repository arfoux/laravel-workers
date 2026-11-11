// Port: laravel/mcp — the WEB half, POST /mcp speaking MCP's JSON-RPC 2.0.
//
// laravel/mcp (v1.1.2) runs a Model Context Protocol server. Over the web it is
// a single HTTP route that answers JSON-RPC 2.0 requests:
//   POST /mcp   { jsonrpc: "2.0", id, method, params }
// with the methods an MCP client drives a server with:
//   initialize    -> server info + capabilities
//   tools/list    -> the tool definitions the server exposes
//   tools/call    -> run one tool by name with params.arguments
//   prompts/list  -> the prompt definitions
//
// The TOOLS THEMSELVES are ordinary compiled app classes — the MCP package's
// `Mcp::tool(...)` registrations live in the app's service provider, which is
// vendor code the build does not compile (LW002). So the registry the port
// dispatches into is handed to it, not discovered here: `env.MCP_TOOLS` and
// `env.MCP_TOOLS`' prompt sibling `env.MCP_PROMPTS`. Each tool is
//   { name, description?, inputSchema?, call(arguments, ctx, env) -> result }
// and each prompt is
//   { name, description?, arguments?, get(args, ctx, env) -> { messages } }.
// The registry may be an ARRAY of those or a MAP keyed by name; `call`/`get`
// (the executable half) is stripped from every listing so the definitions the
// client sees carry no functions.
//
// Edge refusals (disclosed, 1:1 with the package's own split):
//   - the STDIO transport (`local` server, `mcp:start` Artisan) is impossible
//     here — a Worker has no child process. This port serves the HTTP route
//     only; anything that is not a POST JSON-RPC call is refused below.
//   - the SSE transport rides the same gap as every streaming body on the
//     runtime (no ReadableStream body contract yet) — not served here.
//
// Config (env): MCP_TOOLS, MCP_PROMPTS (registries), optional MCP_SERVER_NAME
// / MCP_SERVER_VERSION / MCP_PROTOCOL_VERSION for the initialize response.
// No D1 is required.

import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const JSONRPC_VERSION = '2.0';

// ---- JSON-RPC 2.0 error codes (the spec's reserved range) ------------------
const CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

function rpcResult(id, result) {
  return {
    status: 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result }),
  };
}

function rpcError(id, code, message, data) {
  // A JSON-RPC error keeps the request's `id` when it could be read; a request
  // so malformed its id is unknowable answers with a null id (spec).
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return {
    status: 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error: err }),
  };
}

// ---- registry normalisation ------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Accept the registry as an array of {name,...} or a map name -> {...}. Always
// returns an array of definitions with `name` set (a map entry missing a name
// is keyed in). Entries that are not objects are dropped.
function normaliseRegistry(registry) {
  if (Array.isArray(registry)) {
    return registry.filter(isPlainObject);
  }
  if (isPlainObject(registry)) {
    const out = [];
    for (const [key, value] of Object.entries(registry)) {
      if (!isPlainObject(value)) continue;
      out.push({ name: value.name ?? key, ...value });
    }
    return out;
  }
  return [];
}

function lookupEntry(registry, name) {
  const list = normaliseRegistry(registry);
  return list.find((entry) => String(entry.name) === String(name)) || null;
}

// The listing half of a definition: every key but the executable ones.
const EXECUTABLE_KEYS = new Set(['call', 'get', 'handler', 'handle']);

function publicDefinition(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (EXECUTABLE_KEYS.has(key)) continue;
    if (typeof value === 'function') continue;
    out[key] = value;
  }
  return out;
}

function listDefinitions(registry) {
  return normaliseRegistry(registry).map(publicDefinition);
}

// ---- the server identity + capabilities ------------------------------------

function serverInfo(env) {
  return {
    name: (env && env.MCP_SERVER_NAME) || 'laravel-mcp',
    version: (env && env.MCP_SERVER_VERSION) || '1.0.0',
  };
}

function capabilities(env) {
  const caps = {};
  const tools = normaliseRegistry(env && env.MCP_TOOLS);
  const prompts = normaliseRegistry(env && env.MCP_PROMPTS);
  if (tools.length > 0) caps.tools = { listChanged: false };
  if (prompts.length > 0) caps.prompts = { listChanged: false };
  return caps;
}

// ---- tool invocation -------------------------------------------------------

// An MCP tool returns `content` (an array of {type, ...} blocks) and an
// optional `isError`. Normalise whatever the compiled handler gives back into
// that shape so a plain string/JSON result still reads as MCP content.
function toToolContent(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result; // already MCP-shaped (may carry isError)
  }
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

async function callTool(ctx, env, params) {
  const name = params && params.name;
  if (typeof name !== 'string' || name === '') {
    return rpcError(params && params._id, CODE.INVALID_PARAMS, 'tools/call requires a tool `name`.');
  }
  const entry = lookupEntry(env && env.MCP_TOOLS, name);
  if (!entry || typeof entry.call !== 'function') {
    return rpcError(params && params._id, CODE.INVALID_PARAMS, `Unknown tool: ${String(name)}.`);
  }
  const args = (params && params.arguments) || {};
  let result;
  try {
    result = await entry.call(args, ctx, env);
  } catch (err) {
    // A tool that throws is a TOOL-level error (isError content), not a
    // JSON-RPC protocol error — the call itself was well-formed.
    return rpcResult(params._id, {
      content: [{ type: 'text', text: String((err && err.message) || err) }],
      isError: true,
    });
  }
  return rpcResult(params._id, toToolContent(result));
}

// ---- method dispatch -------------------------------------------------------

async function dispatch(ctx, env, message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: (env && env.MCP_PROTOCOL_VERSION) || '2024-11-05',
        capabilities: capabilities(env),
        serverInfo: serverInfo(env),
      });

    case 'tools/list':
      return rpcResult(id, { tools: listDefinitions(env && env.MCP_TOOLS) });

    case 'tools/call': {
      // `callTool` needs the request id to answer; thread it through params.
      const callParams = { ...(params || {}), _id: id };
      return callTool(ctx, env, callParams);
    }

    case 'prompts/list':
      return rpcResult(id, { prompts: listDefinitions(env && env.MCP_PROMPTS) });

    default:
      return rpcError(id, CODE.METHOD_NOT_FOUND, `Method not found: ${String(method)}.`);
  }
}

// ---- entry point -----------------------------------------------------------

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);

  // The MCP web server is a POST route. Anything else is not the JSON-RPC
  // transport this port serves — refuse loud (this is where a stdio/SSE client
  // would land and be told the edge cannot serve that transport).
  if (ctx.method !== 'POST') {
    return rpcError(
      null,
      CODE.INVALID_REQUEST,
      `MCP web server answers POST /mcp (JSON-RPC 2.0) only; got ${ctx.method}. ` +
        `The stdio transport is not available at the edge (no child process).`
    );
  }

  const body = ctx.body;
  if (!isPlainObject(body)) {
    // normalizePortCtx gives `{}` for an empty/unparseable body.
    return rpcError(null, CODE.PARSE_ERROR, 'Request body is not a JSON-RPC 2.0 object.');
  }
  if (body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== 'string') {
    return rpcError(body.id, CODE.INVALID_REQUEST, 'Request is not a valid JSON-RPC 2.0 request.');
  }

  try {
    return await dispatch(ctx, env, body);
  } catch (err) {
    return rpcError(body.id, CODE.INTERNAL_ERROR, String((err && err.message) || err));
  }
}
