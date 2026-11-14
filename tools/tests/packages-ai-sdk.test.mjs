// tools/tests/packages-ai-sdk.test.mjs — laravel/ai SDK port (POST /ai/chat).
//
// The provider round-trip is exercised with a FAKE `fetch` injected as
// `env.fetchImpl` that records the outgoing request (url/method/headers/body)
// and replies with a canned provider response — no network. We assert:
//   - provider routing by model + env secret, and the exact provider URL/auth
//     each adapter builds (OpenAI bearer, Anthropic x-api-key, Gemini key-in-url,
//     Groq on its own OpenAI-compatible host),
//   - the 200 + assistant answer for a plain completion,
//   - the tool-use loop: model asks for a tool -> the bound executor runs ->
//     results feed back -> the model finalises,
//   - structured/embeddings are out of scope here (chat only), and the
//     guardrails: no configured key -> 500, no messages -> 422,
//   - the D1 conversation log (agent_conversations / _messages) is written
//     best-effort when ctx.db is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle from '../../ports/packages/ai-sdk.mjs';
import { FakeD1 } from './_fake-d1.mjs';

const ctx = (body, db) => ({ body, query: {}, params: {}, ...(db ? { db } : {}) });

// A fake fetch that records calls and replies from the LAST recorded request,
// or a fixed reply. `replies` may be an array (consumed per call) to script a
// multi-round tool loop.
function makeFetch(replies, { json = true } = {}) {
  const seq = Array.isArray(replies) ? replies : [replies];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {}, body: JSON.parse((init && init.body) || '{}') });
    const next = seq[Math.min(calls.length - 1, seq.length - 1)];
    const payload = typeof next === 'function' ? next(calls[calls.length - 1]) : next;
    const text = json && typeof payload !== 'string' ? JSON.stringify(payload) : String(payload);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Canned OpenAI completion.
const openaiCompletion = (content) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 7 },
});

// Canned OpenAI tool-call completion.
const openaiToolCall = (id, name, args) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
});

// ---- plain non-streaming chat ----------------------------------------------

test('openai: posts chat/completions with bearer auth and returns the answer', async () => {
  const fetchImpl = makeFetch(openaiCompletion('Hello from GPT'));
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), {
    OPENAI_API_KEY: 'sk-test',
    fetchImpl,
  });
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'openai');
  assert.equal(out.message.content, 'Hello from GPT');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'gpt-4o');
  assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('groq: same OpenAI wire but hits the Groq host', async () => {
  const fetchImpl = makeFetch(openaiCompletion('Groq answer'));
  const res = await handle(ctx({ model: 'llama-3.1-70b', messages: [{ role: 'user', content: 'hi' }] }), {
    GROQ_API_KEY: 'gsk-test',
    fetchImpl,
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).provider, 'groq');
  assert.equal(fetchImpl.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer gsk-test');
});

test('anthropic: posts /v1/messages with x-api-key and parses tool_use/text blocks', async () => {
  const fetchImpl = makeFetch({ content: [{ type: 'text', text: 'Claude here' }], stop_reason: 'end_turn' });
  const res = await handle(
    ctx({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }], options: { max_tokens: 512 } }),
    { ANTHROPIC_API_KEY: 'ak-test', fetchImpl }
  );
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.provider, 'anthropic');
  assert.equal(out.message.content, 'Claude here');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'ak-test');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.max_tokens, 512);
  // system extracted out of messages; content as blocks.
  assert.deepEqual(call.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('gemini: key rides in the generateContent URL, no auth header', async () => {
  const fetchImpl = makeFetch({ candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] } }] });
  const res = await handle(ctx({ model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'hi' }] }), {
    GEMINI_API_KEY: 'gm-test',
    fetchImpl,
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message.content, 'Gemini says hi');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=gm-test');
  assert.equal(call.init.headers.authorization, undefined);
  assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
});

// ---- tool-use loop ---------------------------------------------------------

test('tool loop: model tool_call runs the bound executor then the model finalises', async () => {
  // Round 1: model asks for a tool. Round 2 (sees tool result): final answer.
  const fetchImpl = makeFetch([
    openaiToolCall('call_1', 'get_weather', { city: 'SF' }),
    openaiCompletion('It is sunny in SF'),
  ]);
  const tools = [
    {
      name: 'get_weather',
      description: 'current weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      execute: async (args) => ({ temp_c: 21, city: args.city }),
    },
  ];
  const res = await handle(
    ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'weather in SF?' }], tools }),
    { OPENAI_API_KEY: 'sk-test', fetchImpl }
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message.content, 'It is sunny in SF');
  assert.equal(fetchImpl.calls.length, 2);

  // Round 1 request carried the tool schema; round 2 carried the tool result.
  assert.equal(fetchImpl.calls[0].body.tools[0].function.name, 'get_weather');
  const toolMsg = fetchImpl.calls[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(JSON.parse(toolMsg.content).temp_c, 21);
});

test('tool runner bound via env.ai_tool_runners is used when tool has no execute', async () => {
  const fetchImpl = makeFetch([openaiToolCall('c1', 'lookup', { id: 9 }), openaiCompletion('found it')]);
  const res = await handle(
    ctx({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'lookup', description: 'db lookup' }],
    }),
    { OPENAI_API_KEY: 'sk-test', fetchImpl, ai_tool_runners: { lookup: async (args) => ({ id: args.id, name: 'Widget' }) } }
  );
  assert.equal(JSON.parse(res.body).message.content, 'found it');
  const toolMsg = fetchImpl.calls[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(JSON.parse(toolMsg.content).name, 'Widget');
});

test('tool loop: an unbound tool degrades to an error result the model sees', async () => {
  const fetchImpl = makeFetch([openaiToolCall('c1', 'nope', {}), openaiCompletion('recovered')]);
  const res = await handle(
    ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'nope' }] }),
    { OPENAI_API_KEY: 'sk-test', fetchImpl }
  );
  assert.equal(res.status, 200);
  const toolMsg = fetchImpl.calls[1].body.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /not available|no executor/);
});

// ---- guardrails ------------------------------------------------------------

test('no configured provider key is a 500 before any fetch', async () => {
  const fetchImpl = makeFetch(openaiCompletion('x'));
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(JSON.parse(res.body).error, /no LLM provider configured|OPENAI_API_KEY/);
});

test('missing messages is a 422 before any fetch', async () => {
  const fetchImpl = makeFetch(openaiCompletion('x'));
  const res = await handle(ctx({ model: 'gpt-4o' }), { OPENAI_API_KEY: 'sk-test', fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('missing model is a 422', async () => {
  const fetchImpl = makeFetch(openaiCompletion('x'));
  const res = await handle(ctx({ messages: [{ role: 'user', content: 'hi' }] }), { OPENAI_API_KEY: 'sk-test', fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a provider 4xx surfaces as a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), {
    OPENAI_API_KEY: 'sk-bad',
    fetchImpl,
  });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /401/);
});

test('a thrown fetch becomes a 502', async () => {
  const fetchImpl = async () => {
    throw new Error('socket hang up');
  };
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), {
    OPENAI_API_KEY: 'sk-test',
    fetchImpl,
  });
  assert.equal(res.status, 502);
});

// ---- D1 conversation persistence ------------------------------------------

test('persists the conversation + messages to D1 when ctx.db is present', async () => {
  const db = new FakeD1();
  const fetchImpl = makeFetch(openaiCompletion('Persisted answer'));
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'remember me' }] }, db), {
    OPENAI_API_KEY: 'sk-test',
    fetchImpl,
  });
  assert.equal(res.status, 200);

  const convs = db.tables.get('agent_conversations') || [];
  assert.equal(convs.length, 1);
  assert.equal(convs[0].provider, 'openai');
  assert.equal(convs[0].model, 'gpt-4o');

  const msgs = db.tables.get('agent_conversation_messages') || [];
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'remember me');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, 'Persisted answer');
});

test('chat still succeeds when ctx.db is absent (persistence optional)', async () => {
  const fetchImpl = makeFetch(openaiCompletion('no-db answer'));
  const res = await handle(ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), {
    OPENAI_API_KEY: 'sk-test',
    fetchImpl,
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message.content, 'no-db answer');
});

test('explicit provider override beats the model-derived choice', async () => {
  const fetchImpl = makeFetch(openaiCompletion('override'));
  const res = await handle(
    ctx({ model: 'gpt-4o', provider: 'groq', messages: [{ role: 'user', content: 'hi' }] }),
    { GROQ_API_KEY: 'gsk-test', fetchImpl }
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).provider, 'groq');
  assert.equal(fetchImpl.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
});
