// kernel/packages/ai.mjs — shared primitives for the laravel/ai SDK port
// (`ports/packages/ai-sdk.mjs`).
//
// Parity target: `laravel/ai` (the `Prism` fluent client) talks to an LLM
// provider over HTTPS (`/chat/completions`-style). On the edge that is a plain
// `fetch`, so the non-streaming chat path ports 1:1. Each provider is a thin
// ADAPTER that translates ONE neutral "unified chat" shape to/from the
// provider wire format, so the port handler stays provider-agnostic.
//
// Edge disclosure: STREAMING (SSE / `text/event-stream`) is NOT ported here —
// Workers can relay the stream, but the compiled Laravel app consumes it via a
// PHP generator, which has no edge equivalent. Only non-streaming
// `generate()`/`chat()` is covered; streaming is a disclosed runtime gap.

import { jsonResponse } from './port-ctx.mjs';

// ---- fetch plumbing --------------------------------------------------------

// Resolve the fetch implementation. Tests inject `env.fetchImpl`; production
// falls back to the Workers/Node global. Read per call so a test can swap it.
export function resolveFetch(env) {
  const f = env && (env.fetchImpl || env.fetch);
  if (typeof f === 'function') return f;
  return globalThis.fetch;
}

// Standard `{status,headers,body}` JSON port response — the envelope lives once
// in `jsonResponse` (port-ctx.mjs); this keeps the `(body, status)` call shape.
export function jsonPort(body, status = 200) {
  return jsonResponse(status, body);
}

// Map a provider `Response` to `{status, headers, body(text)}`. Headers become
// a lowercase-keyed plain object. A caller re-parses `body` as JSON as needed.
export async function mapProviderResponse(resp) {
  const headers = {};
  if (resp && typeof resp.headers !== 'undefined' && resp.headers && typeof resp.headers.forEach === 'function') {
    for (const [k, v] of resp.headers.entries()) headers[String(k).toLowerCase()] = v;
  }
  let status = 200;
  if (resp && typeof resp.status === 'number') status = resp.status;
  let body = '';
  if (resp && typeof resp.text === 'function') body = await resp.text();
  return { status, headers, body };
}

// ---- provider resolution ---------------------------------------------------

// The providers this port knows, each with the env secret that unlocks it and
// the model-name hints that route to it when the caller omits an explicit
// `provider`. Order matters only for the hint match (first hit wins).
export const PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    hints: ['gpt', 'o1', 'o3', 'o4', 'text-embedding', 'chatgpt'],
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com/v1/messages',
    hints: ['claude'],
  },
  gemini: {
    envKey: 'GEMINI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    hints: ['gemini'],
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    hints: ['llama', 'mixtral', 'gemma', 'qwen', 'deepseek-r1', 'groq'],
  },
};

// Resolve which provider to use. Precedence:
//   1. an explicit `provider` (body field or options),
//   2. a model-name hint match,
//   3. the single provider whose API key is present in env.
// Returns `{ ok, provider, key }` or `{ ok:false, reason }` (a 500 — the
// deployment is missing its secret, not a bad user request).
export function resolveProvider({ model = '', provider = '', env = {} } = {}) {
  const wanted = String(provider || '').trim().toLowerCase();
  if (wanted) {
    const p = PROVIDERS[wanted];
    if (!p) return { ok: false, reason: `unknown provider "${wanted}" (expected one of ${Object.keys(PROVIDERS).join(', ')})` };
    const key = env[p.envKey];
    if (!key) return { ok: false, reason: `missing ${p.envKey} for provider "${wanted}"` };
    return { ok: true, provider: wanted, key };
  }
  const m = String(model || '').toLowerCase();
  if (m) {
    for (const [name, p] of Object.entries(PROVIDERS)) {
      if (p.hints.some((h) => m.includes(h))) {
        const key = env[p.envKey];
        if (!key) return { ok: false, reason: `model "${model}" routes to ${name} but ${p.envKey} is not set` };
        return { ok: true, provider: name, key };
      }
    }
  }
  // No explicit provider and no hint matched: fall back to whichever key exists.
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (env[p.envKey]) return { ok: true, provider: name, key: env[p.envKey] };
  }
  return { ok: false, reason: 'no LLM provider configured: set one of ' + Object.values(PROVIDERS).map((p) => p.envKey).join(', ') };
}

// ---- unified chat shape ----------------------------------------------------
// A message is `{ role, content, tool_calls?, tool_call_id?, name? }`.
//   role: 'system' | 'user' | 'assistant' | 'tool'
//   content: string
//   tool_calls: [{ id, name, arguments(object) }]  (assistant, when it asks
//                for a tool)
//   tool_call_id + name: present on a 'tool' message carrying a tool result.
// This is closest to OpenAI's shape (it is the de-facto lingua franca), so the
// OpenAI/Groq adapter is near-identity and the others translate.

// ---- tools: app tool defs -> provider wire ---------------------------------
// A tool def is `{ name, description?, parameters? }` — the compiled app's
// tool class flattened to a JSON-Schema. A missing `parameters` gets an empty
// object schema so a provider never rejects the definition.

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

function toGeminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      })),
    },
  ];
}

// ---- OpenAI + Groq adapter (OpenAI-compatible wire) ------------------------

export const openaiAdapter = {
  name: 'openai',
  // Groq is OpenAI-wire-compatible, so this adapter serves both; the endpoint
  // comes from whichever provider the caller resolved (PROVIDERS lookup).
  url(_model, provider) {
    return (PROVIDERS[provider] || PROVIDERS.openai).endpoint;
  },
  headers(key) {
    return { authorization: bearer(key), 'content-type': 'application/json' };
  },
  toRequest(unified, model, _opts, tools = []) {
    const msgs = unified.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: str(m.content) };
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        return {
          role: 'assistant',
          content: m.content ? str(m.content) : null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
          })),
        };
      }
      return { role: m.role, content: str(m.content) };
    });
    const body = { model, messages: msgs };
    const wire = toOpenAITools(tools);
    if (wire) body.tools = wire;
    return body;
  },
  fromResponse(json) {
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          name: tc.function && tc.function.name,
          arguments: safeJson(tc.function && tc.function.arguments),
        }))
      : undefined;
    const out = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' };
    if (toolCalls) out.tool_calls = toolCalls;
    return { message: out, usage: json.usage || null, raw: json, stop: choice.finish_reason || null };
  },
};

// ---- Anthropic adapter -----------------------------------------------------

export const anthropicAdapter = {
  name: 'anthropic',
  url() {
    return PROVIDERS.anthropic.endpoint;
  },
  headers(key) {
    return { 'x-api-key': String(key), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  },
  toRequest(unified, model, { maxTokens = 1024 } = {}, tools = []) {
    // Anthropic keeps `system` out of `messages` and requires a max_tokens.
    let system;
    const msgs = [];
    for (const m of unified) {
      if (m.role === 'system') {
        system = system ? system + '\n' + str(m.content) : str(m.content);
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: str(m.content) });
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
        }
        msgs.push({ role: 'assistant', content: blocks });
        continue;
      }
      if (m.role === 'tool') {
        msgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: str(m.content) }],
        });
        continue;
      }
      msgs.push({ role: m.role, content: [{ type: 'text', text: str(m.content) }] });
    }
    const body = { model, max_tokens: maxTokens, messages: msgs };
    if (system) body.system = system;
    const wire = toAnthropicTools(tools);
    if (wire) body.tools = wire;
    return body;
  },
  fromResponse(json) {
    const blocks = Array.isArray(json.content) ? json.content : [];
    let text = '';
    const toolCalls = [];
    for (const b of blocks) {
      if (b.type === 'text') text += b.text || '';
      if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: b.input || {} });
    }
    const message = { role: 'assistant', content: text };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, usage: json.usage || null, raw: json, stop: json.stop_reason || null };
  },
};

// ---- Gemini adapter --------------------------------------------------------

export const geminiAdapter = {
  name: 'gemini',
  url(model, _provider, key) {
    return `${PROVIDERS.gemini.endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  },
  // The key rides in the URL for Gemini; no auth header.
  headers() {
    return { 'content-type': 'application/json' };
  },
  toRequest(unified, model, _opts, tools = []) {
    let systemInstruction;
    const contents = [];
    for (const m of unified) {
      if (m.role === 'system') {
        systemInstruction = systemInstruction ? systemInstruction + '\n' + str(m.content) : str(m.content);
        continue;
      }
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (m.content) parts.push({ text: str(m.content) });
        for (const tc of m.tool_calls) parts.push({ functionCall: { name: tc.name, args: tc.arguments || {} } });
      } else if (m.role === 'tool') {
        parts.push({
          functionResponse: { name: m.name || 'tool', response: { result: str(m.content) } },
        });
      } else {
        parts.push({ text: str(m.content) });
      }
      contents.push({ role, parts });
    }
    const body = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    const wire = toGeminiTools(tools);
    if (wire) body.tools = wire;
    return body;
  },
  fromResponse(json) {
    const cand = (json.candidates && json.candidates[0]) || {};
    const parts = (cand.content && cand.content.parts) || [];
    let text = '';
    const toolCalls = [];
    for (const p of parts) {
      if (typeof p.text === 'string') text += p.text;
      if (p.functionCall) {
        toolCalls.push({
          id: p.functionCall.name ? `call_${p.functionCall.name}` : 'call_0',
          name: p.functionCall.name,
          arguments: p.functionCall.args || {},
        });
      }
    }
    const message = { role: 'assistant', content: text };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, usage: json.usageMetadata || null, raw: json, stop: cand.finishReason || null };
  },
};

// Pick the adapter for a provider name. Groq is OpenAI-wire-compatible.
export function adapterFor(provider) {
  if (provider === 'anthropic') return anthropicAdapter;
  if (provider === 'gemini') return geminiAdapter;
  return openaiAdapter; // openai + groq
}

// ---- tool-use loop ---------------------------------------------------------

// Run one round of tool calls produced by the model. For each requested call,
// look the tool up by name in `toolMap` and execute it; a missing tool becomes
// an error result the model sees (it can recover). Returns unified `tool`
// messages, ready to append to the conversation and send back.
//
// `execute(name, args)` is injected by the port: production dispatches into the
// compiled app's tool class; a test injects a stub. When no executor is given
// and the tool is not in `toolMap`, the call degrades to an error result rather
// than throwing — the model, not the port, owns recovery.
export async function dispatchToolCalls(toolCalls, toolMap, execute) {
  const results = [];
  for (const tc of toolCalls || []) {
    const name = tc.name;
    const args = tc.arguments || {};
    let output;
    try {
      if (typeof execute === 'function') {
        output = await execute(name, args, tc);
      } else if (toolMap && typeof toolMap[name] === 'function') {
        output = await toolMap[name](args, tc);
      } else {
        output = { error: `tool "${name}" is not available on this deployment` };
      }
    } catch (err) {
      output = { error: String((err && err.message) || err) };
    }
    results.push({
      role: 'tool',
      tool_call_id: tc.id,
      name,
      content: typeof output === 'string' ? output : JSON.stringify(output),
    });
  }
  return results;
}

// ---- small helpers ---------------------------------------------------------

function bearer(key) {
  return `Bearer ${String(key)}`;
}

function str(v) {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

function safeJson(s) {
  if (typeof s !== 'string') return s === undefined || s === null ? {} : s;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}
