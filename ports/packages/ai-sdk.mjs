// ports/packages/ai-sdk.mjs — port of laravel/ai (the `Prism` SDK) chat path.
//
// Parity target: `Laravel\Prism`'s `generate()` / `chat()` — send a message
// list (+ optional tool definitions) to an LLM provider over HTTPS, get a
// completion, and let the model call the app's tools in a loop
// (tool_calls -> dispatch -> feed results back -> the model finalises). On the
// edge the provider round-trips are plain `fetch` subrequests, so the
// non-streaming path ports 1:1.
//
// Edge disclosure: STREAMING (SSE) is NOT ported — Workers can relay the byte
// stream, but the compiled PHP app consumes it through a generator that has no
// edge equivalent. Only non-streaming `generate()` is covered; that is the
// runtime gap the orchestrator recorded under this port.
//
// Route wiring: `POST /ai/chat` -> this handler.
//
// Provider selection (env secrets, chosen per model):
//   openai     OPENAI_API_KEY        gpt-*, o1/o3/o4-*
//   anthropic  ANTHROPIC_API_KEY     claude-*
//   gemini     GEMINI_API_KEY        gemini-*
//   groq       GROQ_API_KEY          llama-*, gemma-*, mixtral-* (OpenAI wire)
// A body `provider` field overrides the model-derived choice. No configured
// key -> 500 (a deployment error, before any subrequest is spent).
//
// Request (ctx.body): { model?, messages: [...], tools?: [...], options? }
//   messages: [{ role: 'system'|'user'|'assistant'|'tool', content, ... }]
//   tools:    [{ name, description?, parameters? }] — the compiled tool classes
//   options:  { max_tokens?, /* provider-specific extras */ } (optional)
//
// In-memory conversation kept in D1 when `ctx.db` is present:
//   agent_conversations(id, provider, model) + the per-message log
//   (agent_conversation_messages) including the tool-call turns, so a client
//   can resume a thread. Persistence is best-effort: a D1 failure never fails
//   the chat response.
import { resolveFetch, jsonPort, mapProviderResponse, resolveProvider, adapterFor, dispatchToolCalls } from '../../kernel/packages/ai.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ---- D1 persistence (best-effort) -----------------------------------------

export async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS agent_conversations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       provider TEXT NOT NULL,
       model TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS agent_conversation_messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       conversation_id INTEGER NOT NULL,
       role TEXT NOT NULL,
       content TEXT,
       name TEXT,
       raw_json TEXT,
       created_at TEXT NOT NULL
     )`
  ).run();
  // The lookup index is a pure optimisation; some minimal SQL fakes don't parse
  // `CREATE INDEX`, so degrade to table-only rather than aborting persistence.
  try {
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS agent_conversation_messages_conv_idx
       ON agent_conversation_messages (conversation_id)`
    ).run();
  } catch {
    /* index is optional */
  }
}

function isoNow() {
  return new Date().toISOString();
}

async function persistConversation(db, { provider, model, messages }) {
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await ensureSchema(db);
    const res = await db
      .prepare('INSERT INTO agent_conversations (provider, model, created_at) VALUES (?, ?, ?)')
      .bind(String(provider), String(model || ''), isoNow())
      .run();
    const convId = res && (res.last_row_id ?? (res.meta && res.meta.last_row_id));
    if (convId == null) return;
    for (const m of messages) {
      await db
        .prepare(
          'INSERT INTO agent_conversation_messages (conversation_id, role, content, name, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(convId, String(m.role), typeof m.content === 'string' ? m.content : null, m.name || null, JSON.stringify(m), isoNow())
        .run();
    }
  } catch (err) {
    // Observability only — never fail the chat because the log write failed.
    // eslint-disable-next-line no-console
    console.error('ai-sdk: D1 persist skipped', err && err.message);
  }
}

// ---- request handling ------------------------------------------------------

function readBody(ctx) {
  const raw = (ctx && ctx.body) || {};
  return {
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    messages: Array.isArray(raw.messages) ? raw.messages : null,
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    provider: typeof raw.provider === 'string' ? raw.provider.trim() : '',
    options: raw.options && typeof raw.options === 'object' ? raw.options : {},
  };
}

// Build the tool map (name -> definition + executor hook). Tools are the
// compiled app classes; the port itself cannot execute PHP, so each tool's
// `executor` closure is supplied by the compiled wiring (registered by name in
// `env.ai_tool_runners`). Without an executor the tool still exists for the
// provider schema but resolves to a recovered "not available" result.
function buildToolMap(tools, env) {
  const runners = (env && env.ai_tool_runners) || {};
  const map = {};
  for (const t of tools) {
    if (!t || !t.name) continue;
    map[t.name] = {
      definition: t,
      run:
        typeof t.execute === 'function'
          ? t.execute
          : typeof runners[t.name] === 'function'
            ? runners[t.name]
            : undefined,
    };
  }
  return map;
}

// Execute one tool call against the tool map. Returns the tool output.
async function runTool(toolMap, name, args) {
  const t = toolMap && toolMap[name];
  if (!t) return { error: `tool "${name}" is not defined on this deployment` };
  if (typeof t.run !== 'function') return { error: `tool "${name}" has no executor bound on this deployment` };
  return t.run(args);
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const { model, messages, tools, provider, options } = readBody(ctx);

  if (!Array.isArray(messages)) {
    return jsonPort({ error: "body.messages must be a non-empty array of { role, content }" }, 422);
  }
  if (messages.length === 0 || !messages.every((m) => m && typeof m.role === 'string')) {
    return jsonPort({ error: 'body.messages must be a non-empty array of { role, content }' }, 422);
  }
  if (!model) {
    return jsonPort({ error: "body.model is required (e.g. 'gpt-4o', 'claude-3-5-sonnet', 'gemini-1.5-pro')" }, 422);
  }

  const resolved = resolveProvider({ model, provider, env: env || {} });
  if (!resolved.ok) {
    return jsonPort({ error: resolved.reason }, 500);
  }

  const adapter = adapterFor(resolved.provider);
  const toolMap = buildToolMap(tools, env);
  const toolDefs = tools.filter((t) => t && t.name);
  const maxTokens = options.max_tokens || 1024;
  const maxRounds = Number.isInteger(options.max_rounds) ? options.max_rounds : 16;
  const doFetch = resolveFetch(env);

  // Provider round-trip: translate unified -> provider wire, POST, parse back.
  // Tool definitions ride in `tools`; each adapter maps them to its wire shape.
  const callProvider = async (unified) => {
    const body = adapter.toRequest(unified, model, { maxTokens }, toolDefs);
    const init = {
      method: 'POST',
      headers: adapter.headers(resolved.key),
      body: JSON.stringify(body),
    };
    let resp;
    try {
      resp = await doFetch(adapter.url(model, resolved.provider, resolved.key), init);
    } catch (err) {
      return { __error: String((err && err.message) || err) };
    }
    const mapped = await mapProviderResponse(resp);
    if (mapped.status >= 400) {
      return { __error: `${resolved.provider} responded ${mapped.status}: ${mapped.body}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(mapped.body);
    } catch {
      return { __error: `${resolved.provider} returned non-JSON (${mapped.status}): ${mapped.body}` };
    }
    return adapter.fromResponse(parsed);
  };

  // The chat loop: call the provider; while it asks for tools -> dispatch ->
  // append the assistant tool_calls + tool results -> call again. `normalised`
  // is the neutral unified shape; the tool rounds grow it in place of a client
  // round-trip (the compiled app's tool classes run here, not on the client).
  let normalised = normalizeClientMessages(messages);
  let final = null;
  try {
    for (let i = 0; i < maxRounds; i += 1) {
      final = await callProvider(normalised);
      if (final.__error) return jsonPort({ error: final.__error }, 502);
      const toolCalls = final.message && final.message.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) break;
      const results = await dispatchToolCalls(
        toolCalls,
        Object.create(null),
        (name, args) => runTool(toolMap, name, args)
      );
      normalised = [...normalised, final.message, ...results];
      final = null;
    }
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }

  const assistant = (final && final.message) || { role: 'assistant', content: '' };
  if (ctx.db) await persistConversation(ctx.db, { provider: resolved.provider, model, messages: [...normalised, assistant] });

  return jsonPort({
    ok: true,
    provider: resolved.provider,
    model,
    message: assistant,
    usage: (final && final.usage) || null,
  }, 200);
}

// --- helpers -----------------------------------------------------------------

// Normalise incoming client messages to the unified shape (default missing
// content to '' and pass known fields through).
function normalizeClientMessages(messages) {
  return messages.map((m) => {
    const n = {
      role: typeof m.role === 'string' ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content : (m.content === undefined || m.content === null ? '' : JSON.stringify(m.content)),
    };
    if (m.tool_calls) n.tool_calls = m.tool_calls;
    if (m.tool_call_id) n.tool_call_id = m.tool_call_id;
    if (m.name) n.name = m.name;
    return n;
  });
}

