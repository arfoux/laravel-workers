// tools/tests/packages-discord-expo-onesignal.test.mjs — notification cluster:
// Discord (webhook + bot), Expo push, OneSignal.
//
// Same FAKE `fetch` pattern as packages-notify-http.test.mjs: an `env.fetchImpl`
// records the outgoing Request (url/method/headers/body) and returns a stubbed
// provider `Response`. We assert the provider URL + auth + body each handler
// builds, the 1:1 provider-response mapping, and that validation/credential
// guards short-circuit BEFORE any fetch. No network, no D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import discord from '../../ports/packages/discord-notification.mjs';
import expo from '../../ports/packages/expo-notification.mjs';
import onesignal from '../../ports/packages/onesignal-notification.mjs';

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

// ---- Discord ---------------------------------------------------------------

test('discord: incoming webhook posts JSON content to DISCORD_WEBHOOK_URL with no auth header', async () => {
  const fetchImpl = makeFetch(200, undefined, { rawBody: '' });
  const ctx = okCtx({ to: '111', content: 'deploy finished' });
  const env = { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' };

  const res = await discord(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://discord.com/api/webhooks/1/abc');
  assert.equal(call.init.method, 'POST');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.content, 'deploy finished');
  assert.equal(sent.thread_id, '111');
  // Webhook carries no auth header — the URL is the secret.
  assert.equal(call.init.headers.authorization, undefined);
});

test('discord: webhook needs no channel — omitting `to` still sends content', async () => {
  const fetchImpl = makeFetch(200, undefined, { rawBody: '' });
  const res = await discord(okCtx({ content: 'x' }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' });
  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.content, 'x');
  assert.equal(sent.thread_id, undefined);
});

test('discord: bot token path hits channels/{id}/messages with `Bot` auth', async () => {
  const fetchImpl = makeFetch(200, { id: 'm1', channel_id: 'C9' });
  const ctx = okCtx({ content: 'hi', channel: 'C9' });
  const env = { fetchImpl, DISCORD_BOT_TOKEN: 'tok-abc' };

  const res = await discord(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).id, 'm1');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://discord.com/api/channels/C9/messages');
  assert.equal(call.init.headers.authorization, 'Bot tok-abc');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.content, 'hi');
});

test('discord: bot path without any channel is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { id: 'm' });
  const res = await discord(okCtx({ content: 'x' }), { fetchImpl, DISCORD_BOT_TOKEN: 'tok' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord: missing credential is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { id: 'm' });
  const res = await discord(okCtx({ content: 'x', to: 'C1' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord: empty content with no embeds is a 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, undefined, { rawBody: '' });
  const res = await discord(okCtx({ to: 'C1' }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('discord: passes embeds through verbatim', async () => {
  const fetchImpl = makeFetch(200, undefined, { rawBody: '' });
  const embeds = [{ title: 't', description: 'd' }];
  await discord(okCtx({ content: 'yo', embeds }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.embeds, embeds);
});

test('discord: embeds alone (no content) is allowed and sends', async () => {
  const fetchImpl = makeFetch(200, undefined, { rawBody: '' });
  const res = await discord(okCtx({ embeds: [{ title: 'only' }] }), { fetchImpl, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' });
  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.content, undefined);
  assert.deepEqual(sent.embeds, [{ title: 'only' }]);
});

// ---- Expo ------------------------------------------------------------------

test('expo: posts JSON push to exp.host send endpoint', async () => {
  const fetchImpl = makeFetch(200, { data: [{ status: 'ok', id: 'r1' }] });
  const ctx = okCtx({ to: 'ExponentPushToken[aaa]', title: 'Hi', body: 'your code is 42' });
  const env = { fetchImpl };

  const res = await expo(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).data[0].id, 'r1');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(call.init.method, 'POST');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent.to, ['ExponentPushToken[aaa]']);
  assert.equal(sent.title, 'Hi');
  assert.equal(sent.body, 'your code is 42');
  // No EXPO_ACCESS_TOKEN configured — no auth header.
  assert.equal(call.init.headers.authorization, undefined);
});

test('expo: Bearer EXPO_ACCESS_TOKEN sent when configured', async () => {
  const fetchImpl = makeFetch(200, { data: [] });
  await expo(okCtx({ to: 'ExponentPushToken[a]', body: 'x' }), { fetchImpl, EXPO_ACCESS_TOKEN: 'sec-token' });
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sec-token');
});

test('expo: comma/space separated `to` string becomes a token array', async () => {
  const fetchImpl = makeFetch(200, { data: [] });
  await expo(okCtx({ to: 'ExponentPushToken[a], ExponentPushToken[b]', body: 'x' }), { fetchImpl });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body).to, ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
});

test('expo: missing `to` is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { data: [] });
  const res = await expo(okCtx({ body: 'x' }), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('expo: empty body is a 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, { data: [] });
  const res = await expo(okCtx({ to: 'ExponentPushToken[a]' }), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('expo: data/sound/badge/channelId passed through when present', async () => {
  const fetchImpl = makeFetch(200, { data: [] });
  await expo(okCtx({ to: 'ExponentPushToken[a]', body: 'x', data: { k: 1 }, sound: 'default', badge: 3, channelId: 'default' }), { fetchImpl });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.data, { k: 1 });
  assert.equal(sent.sound, 'default');
  assert.equal(sent.badge, 3);
  assert.equal(sent.channelId, 'default');
});

// ---- OneSignal -------------------------------------------------------------

test('onesignal: posts JSON notification with Basic rest-key auth and app_id', async () => {
  const fetchImpl = makeFetch(200, { id: 'n1', recipients: 1 });
  const ctx = okCtx({ to: 'player-1', title: 'Hello', body: 'hi there' });
  const env = { fetchImpl, ONESIGNAL_APP_ID: 'app-123', ONESIGNAL_REST_API_KEY: 'rest-key' };

  const res = await onesignal(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).id, 'n1');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.onesignal.com/notifications');
  assert.equal(call.init.method, 'POST');
  // Basic auth is base64("rest-key:").
  const expected = 'Basic ' + Buffer.from('rest-key:').toString('base64');
  assert.equal(call.init.headers.authorization, expected);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.app_id, 'app-123');
  assert.deepEqual(sent.include_player_ids, ['player-1']);
  assert.deepEqual(sent.contents, { en: 'hi there' });
  assert.deepEqual(sent.headings, { en: 'Hello' });
});

test('onesignal: segments map to included_segments', async () => {
  const fetchImpl = makeFetch(200, { id: 'n2', recipients: 10 });
  await onesignal(okCtx({ segments: 'Subscribed Users', body: 'blast' }), {
    fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key',
  });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.included_segments, ['Subscribed Users']);
  assert.equal(sent.include_player_ids, undefined);
});

test('onesignal: external_user_ids map to include_external_user_ids', async () => {
  const fetchImpl = makeFetch(200, { id: 'n3', recipients: 2 });
  await onesignal(okCtx({ external_user_ids: ['u1', 'u2'], body: 'x' }), {
    fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key',
  });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body).include_external_user_ids, ['u1', 'u2']);
});

test('onesignal: missing ONESIGNAL_APP_ID is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { id: 'n' });
  const res = await onesignal(okCtx({ to: 'p1', body: 'x' }), { fetchImpl, ONESIGNAL_REST_API_KEY: 'key' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal: missing ONESIGNAL_REST_API_KEY is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { id: 'n' });
  const res = await onesignal(okCtx({ to: 'p1', body: 'x' }), { fetchImpl, ONESIGNAL_APP_ID: 'app' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal: no target (no to/player_ids/segments) is a 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, { id: 'n' });
  const res = await onesignal(okCtx({ body: 'x' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('onesignal: empty body is a 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, { id: 'n' });
  const res = await onesignal(okCtx({ to: 'p1' }), { fetchImpl, ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Cross-cutting: provider response mapping + error handling -------------

test('all: non-2xx provider status is surfaced verbatim', async () => {
  const cases = [
    [discord, okCtx({ content: 'x' }), { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }],
    [expo, okCtx({ to: 'ExponentPushToken[a]', body: 'x' }), {}],
    [onesignal, okCtx({ to: 'p1', body: 'x' }), { ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key' }],
  ];
  for (const [handler, ctx, env] of cases) {
    const fetchImpl = makeFetch(401, { error: 'nope' });
    const res = await handler(ctx, { ...env, fetchImpl });
    assert.equal(res.status, 401, `${handler.name || 'handler'} should surface provider 401`);
    assert.equal(typeof res.body, 'string');
  }
});

test('all: provider headers are lowercased into the response map', async () => {
  const fetchImpl = makeFetch(200, { ok: true }, { headers: { 'X-Request-Id': 'req-9' } });
  const res = await expo(okCtx({ to: 'ExponentPushToken[a]', body: 'x' }), { fetchImpl });
  assert.equal(res.headers['x-request-id'], 'req-9');
});

test('all: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const boom = async () => { throw new Error('dns fail'); };
  const cases = [
    [discord, okCtx({ content: 'x' }), { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }],
    [expo, okCtx({ to: 'ExponentPushToken[a]', body: 'x' }), {}],
    [onesignal, okCtx({ to: 'p1', body: 'x' }), { ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'key' }],
  ];
  for (const [handler, ctx, env] of cases) {
    const res = await handler(ctx, { ...env, fetchImpl: boom });
    assert.equal(res.status, 502);
    assert.match(res.body, /dns fail/);
  }
});
