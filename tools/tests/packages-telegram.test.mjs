// tools/tests/packages-telegram.test.mjs — Telegram notification port
// (laravel-notification-channels/telegram).
//
// Same fake-fetch pattern as packages-notify-http.test.mjs: inject
// `env.fetchImpl` to capture the outgoing request (url/method/headers/body) and
// return a canned provider `Response`. We assert:
//   - the sendMessage URL (`https://api.telegram.org/bot{TOKEN}/sendMessage`),
//   - the JSON body the handler builds (chat_id/text/parse_mode/reply_markup),
//   - validation guards (missing chat_id → 422, missing token → 500) never fetch.
// No network, no D1 — a pure HTTP driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegram from '../../ports/packages/telegram-notification.mjs';

// Build a fake fetch that records the call and replies with a canned response.
function makeFetch(status, jsonBody, { rawBody, headers } = {}) {
  const calls = [];
  const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(jsonBody);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(bodyText, {
      status,
      headers: headers || { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const okCtx = (body) => ({ body, query: {}, params: {} });

// ---- Happy paths -----------------------------------------------------------

test('telegram: posts JSON sendMessage to bot{TOKEN}/sendMessage', async () => {
  const fetchImpl = makeFetch(200, { ok: true, result: { message_id: 42 } });
  const ctx = okCtx({ to: '123456', body: 'deploy finished' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.telegram.org/botBOT-TOKEN/sendMessage');
  assert.equal(init.method, 'POST');
  assert.match(String(init.headers['content-type']), /application\/json/);
  const sent = JSON.parse(init.body);
  assert.equal(sent.chat_id, '123456');
  assert.equal(sent.text, 'deploy finished');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.message_id, 42);
});

test('telegram: accepts chat_id + text as canonical field names', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ chat_id: '@mychannel', text: 'hello channel' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.chat_id, '@mychannel');
  assert.equal(sent.text, 'hello channel');
});

test('telegram: `to` overrides chat_id when both present', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: '111', chat_id: '222', text: 'hi' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  await telegram(ctx, env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.chat_id, '111');
});

test('telegram: parse_mode passes through verbatim', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: '123', text: '*bold*', parse_mode: 'MarkdownV2' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  await telegram(ctx, env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.parse_mode, 'MarkdownV2');
});

test('telegram: keyboard object maps to reply_markup verbatim', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const keyboard = {
    inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]],
  };
  const ctx = okCtx({ to: '123', text: 'with button', keyboard });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  await telegram(ctx, env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.reply_markup, keyboard);
});

test('telegram: keyboard array of rows wraps into inline_keyboard', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({
    to: '123',
    text: 'rows',
    keyboard: [[{ text: 'A', callback_data: 'a' }], [{ text: 'B', url: 'https://x' }]],
  });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  await telegram(ctx, env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.reply_markup, {
    inline_keyboard: [[{ text: 'A', callback_data: 'a' }], [{ text: 'B', url: 'https://x' }]],
  });
});

test('telegram: keyboard array of label strings becomes text buttons', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: '123', text: 'labels', keyboard: [['Yes', 'No']] });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  await telegram(ctx, env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.reply_markup, {
    inline_keyboard: [[{ text: 'Yes' }, { text: 'No' }]],
  });
});

// ---- Validation guards -----------------------------------------------------

test('telegram: missing chat_id is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ text: 'no target' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /chat_id/);
});

test('telegram: empty chat_id is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: '   ', text: 'blank target' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('telegram: missing token is 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: '123', text: 'hi' });
  const env = { fetchImpl };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /TELEGRAM_BOT_TOKEN/);
});

// ---- Cross-cutting: provider response mapping + error handling -------------

test('telegram: Telegram app-level ok:false is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(200, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  const ctx = okCtx({ to: '123', text: 'hi' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.description, /chat not found/);
});

test('telegram: non-2xx provider status is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  const ctx = okCtx({ to: '123', text: 'hi' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'WRONG' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 401);
});

test('telegram: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const ctx = okCtx({ to: '123', text: 'hi' });
  const env = { fetchImpl, TELEGRAM_BOT_TOKEN: 'BOT-TOKEN' };

  const res = await telegram(ctx, env);

  assert.equal(res.status, 502);
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /network down/);
});
