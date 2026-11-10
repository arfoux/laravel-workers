// tools/tests/packages-notify-http.test.mjs — Cluster C notification/HTTP-driver
// ports: Slack, Twilio SMS, Mailgun mail, Postmark mail.
//
// Each handler is exercised with a FAKE `fetch` injected as `env.fetchImpl` that
// captures the outgoing Request (url/method/headers/body) and returns a stubbed
// provider `Response`. We assert:
//   - the provider URL + auth + body the handler builds,
//   - the 1:1 mapping of the provider response to {status, headers, body},
//   - validation guards (missing `to`/credentials) short-circuit before fetch.
// No network, no D1 — these are pure HTTP drivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import slack from '../../ports/packages/slack-notification.mjs';
import twilio from '../../ports/packages/twilio-sms.mjs';
import mailgun from '../../ports/packages/mailgun-mail.mjs';
import postmark from '../../ports/packages/postmark-mail.mjs';

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

// ---- Slack -----------------------------------------------------------------

test('slack: incoming webhook posts JSON message to SLACK_WEBHOOK_URL', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ to: 'C123', body: 'deploy finished' });
  const env = { fetchImpl, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' };

  const res = await slack(ctx, env);

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://hooks.slack.com/services/T/B/X');
  assert.equal(call.init.method, 'POST');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.text, 'deploy finished');
  assert.equal(sent.channel, 'C123');
  // Webhook carries no auth header — the URL is the secret.
  assert.equal(call.init.headers.authorization, undefined);
});

test('slack: bot token path hits chat.postMessage with bearer auth', async () => {
  const fetchImpl = makeFetch(200, { ok: true, channel: 'C9', ts: '1.2' });
  const ctx = okCtx({ body: 'hi', channel: 'C9' });
  const env = { fetchImpl, SLACK_BOT_TOKEN: 'xoxb-abc', SLACK_CHANNEL: 'C9' };

  const res = await slack(ctx, env);

  assert.equal(res.status, 200);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(call.init.headers.authorization, 'Bearer xoxb-abc');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.channel, 'C9');
  assert.equal(sent.text, 'hi');
});

test('slack: web api without any channel is a 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await slack(okCtx({ body: 'x' }), { fetchImpl, SLACK_BOT_TOKEN: 'xoxb' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('slack: missing credential is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await slack(okCtx({ body: 'x', to: 'C1' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('slack: webhook needs no channel — omitting `to` still sends', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await slack(okCtx({ body: 'x' }), { fetchImpl, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.text, 'x');
  assert.equal(sent.channel, undefined);
});

test('slack: passes blocks/attachments through verbatim', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'yo' } }];
  await slack(okCtx({ to: 'C1', body: 'yo', blocks }), { fetchImpl, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.blocks, blocks);
});

// ---- Twilio ----------------------------------------------------------------

test('twilio: posts urlencoded message create with basic auth', async () => {
  const fetchImpl = makeFetch(201, { sid: 'SM1', status: 'queued' });
  const ctx = okCtx({ to: '+15551234', body: 'your code is 42' });
  const env = { fetchImpl, TWILIO_SID: 'AC1', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15550000' };

  const res = await twilio(ctx, env);

  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body).sid, 'SM1');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers['content-type'], /application\/x-www-form-urlencoded/);
  // Basic auth is base64("AC1:tok").
  const expected = 'Basic ' + Buffer.from('AC1:tok').toString('base64');
  assert.equal(call.init.headers.authorization, expected);
  const params = new URLSearchParams(call.init.body);
  assert.equal(params.get('To'), '+15551234');
  assert.equal(params.get('From'), '+15550000');
  assert.equal(params.get('Body'), 'your code is 42');
});

test('twilio: `from` in payload overrides TWILIO_FROM', async () => {
  const fetchImpl = makeFetch(201, {});
  await twilio(okCtx({ to: '+15551234', body: 'x', from: '+15999999' }), {
    fetchImpl, TWILIO_SID: 'AC1', TWILIO_TOKEN: 't', TWILIO_FROM: '+15550000',
  });
  const params = new URLSearchParams(fetchImpl.calls[0].init.body);
  assert.equal(params.get('From'), '+15999999');
});

test('twilio: missing credentials is 500 before fetch', async () => {
  const fetchImpl = makeFetch(201, {});
  const res = await twilio(okCtx({ to: '+15551234', body: 'x' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('twilio: missing From is 422 before fetch', async () => {
  const fetchImpl = makeFetch(201, {});
  const res = await twilio(okCtx({ to: '+15551234', body: 'x' }), {
    fetchImpl, TWILIO_SID: 'AC1', TWILIO_TOKEN: 't',
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('twilio: empty body is 422 before fetch', async () => {
  const fetchImpl = makeFetch(201, {});
  const res = await twilio(okCtx({ to: '+15551234', body: '', subject: '' }), {
    fetchImpl, TWILIO_SID: 'AC1', TWILIO_TOKEN: 't', TWILIO_FROM: '+15550000',
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Mailgun ---------------------------------------------------------------

test('mailgun: posts multipart form to /v3/{domain}/messages with basic api auth', async () => {
  const fetchImpl = makeFetch(200, { id: '<1@mg>', message: 'Queued' });
  const ctx = okCtx({ to: 'a@b.com', subject: 'Hi', body: 'plain body' });
  const env = { fetchImpl, MAILGUN_DOMAIN: 'mg.example.com', MAILGUN_SECRET: 'key-1' };

  const res = await mailgun(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message, 'Queued');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.mailgun.net/v3/mg.example.com/messages');
  const expected = 'Basic ' + Buffer.from('api:key-1').toString('base64');
  assert.equal(call.init.headers.authorization, expected);
  // Multipart body must NOT have a hand-set content-type (boundary is fetch's job).
  assert.equal(call.init.headers['content-type'], undefined);
  const fd = call.init.body;
  assert.equal(typeof fd.append, 'function');
  assert.equal(fd.get('to'), 'a@b.com');
  assert.equal(fd.get('subject'), 'Hi');
  assert.equal(fd.get('text'), 'plain body');
  assert.equal(fd.get('from'), 'postmaster@mg.example.com');
});

test('mailgun: html field included when present', async () => {
  const fetchImpl = makeFetch(200, {});
  await mailgun(okCtx({ to: 'a@b.com', subject: 's', body: 't', html: '<b>t</b>' }), {
    fetchImpl, MAILGUN_DOMAIN: 'mg.example.com', MAILGUN_SECRET: 'k',
  });
  assert.equal(fetchImpl.calls[0].init.body.get('html'), '<b>t</b>');
});

test('mailgun: EU endpoint respected', async () => {
  const fetchImpl = makeFetch(200, {});
  await mailgun(okCtx({ to: 'a@b.com', subject: 's', body: 't' }), {
    fetchImpl, MAILGUN_DOMAIN: 'mg.example.com', MAILGUN_SECRET: 'k', MAILGUN_ENDPOINT: 'api.eu.mailgun.net',
  });
  assert.equal(fetchImpl.calls[0].url, 'https://api.eu.mailgun.net/v3/mg.example.com/messages');
});

test('mailgun: missing credential is 500 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await mailgun(okCtx({ to: 'a@b.com', subject: 's', body: 't' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('mailgun: missing `to` is 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await mailgun(okCtx({ subject: 's', body: 't' }), {
    fetchImpl, MAILGUN_DOMAIN: 'mg', MAILGUN_SECRET: 'k',
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Postmark --------------------------------------------------------------

test('postmark: posts JSON to /email with server token header', async () => {
  const fetchImpl = makeFetch(200, { MessageID: 'abc', ErrorCode: 0, Message: 'OK' });
  const ctx = okCtx({ to: 'dest@x.com', subject: 'Welcome', body: 'text body' });
  const env = { fetchImpl, POSTMARK_TOKEN: 'srv-token', POSTMARK_FROM: 'send@x.com' };

  const res = await postmark(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).MessageID, 'abc');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.postmarkapp.com/email');
  assert.equal(call.init.headers['x-postmark-server-token'], 'srv-token');
  assert.match(call.init.headers['content-type'], /application\/json/);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.From, 'send@x.com');
  assert.equal(sent.To, 'dest@x.com');
  assert.equal(sent.Subject, 'Welcome');
  assert.equal(sent.TextBody, 'text body');
  assert.equal(sent.MessageStream, 'outbound');
});

test('postmark: html body included when present', async () => {
  const fetchImpl = makeFetch(200, {});
  await postmark(okCtx({ to: 'd@x.com', subject: 's', body: 't', html: '<i>t</i>' }), {
    fetchImpl, POSTMARK_TOKEN: 'k', POSTMARK_FROM: 's@x.com',
  });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).HtmlBody, '<i>t</i>');
});

test('postmark: missing token is 500 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await postmark(okCtx({ to: 'd@x.com', subject: 's', body: 't' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('postmark: missing From is 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await postmark(okCtx({ to: 'd@x.com', subject: 's', body: 't' }), {
    fetchImpl, POSTMARK_TOKEN: 'k',
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Cross-cutting: provider response mapping + error handling -------------

test('all: non-2xx provider status is surfaced verbatim', async () => {
  const cases = [
    [slack, okCtx({ to: 'C1', body: 'x' }), { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }],
    [twilio, okCtx({ to: '+15551234', body: 'x' }), { TWILIO_SID: 'AC1', TWILIO_TOKEN: 't', TWILIO_FROM: '+15550000' }],
    [mailgun, okCtx({ to: 'a@b.com', subject: 's', body: 't' }), { MAILGUN_DOMAIN: 'mg', MAILGUN_SECRET: 'k' }],
    [postmark, okCtx({ to: 'd@x.com', subject: 's', body: 't' }), { POSTMARK_TOKEN: 'k', POSTMARK_FROM: 's@x.com' }],
  ];
  for (const [handler, ctx, env] of cases) {
    const fetchImpl = makeFetch(401, { error: 'nope' });
    const res = await handler(ctx, { ...env, fetchImpl });
    assert.equal(res.status, 401, `${handler.name} should surface provider 401`);
    assert.equal(typeof res.body, 'string');
  }
});

test('all: provider headers are lowercased into the response map', async () => {
  const fetchImpl = makeFetch(200, { ok: true }, { headers: { 'X-Request-Id': 'req-9' } });
  const res = await slack(okCtx({ to: 'C1', body: 'x' }), { fetchImpl, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' });
  assert.equal(res.headers['x-request-id'], 'req-9');
});

test('all: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const boom = async () => { throw new Error('dns fail'); };
  const cases = [
    [slack, okCtx({ to: 'C1', body: 'x' }), { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }],
    [twilio, okCtx({ to: '+15551234', body: 'x' }), { TWILIO_SID: 'AC1', TWILIO_TOKEN: 't', TWILIO_FROM: '+15550000' }],
    [mailgun, okCtx({ to: 'a@b.com', subject: 's', body: 't' }), { MAILGUN_DOMAIN: 'mg', MAILGUN_SECRET: 'k' }],
    [postmark, okCtx({ to: 'd@x.com', subject: 's', body: 't' }), { POSTMARK_TOKEN: 'k', POSTMARK_FROM: 's@x.com' }],
  ];
  for (const [handler, ctx, env] of cases) {
    const res = await handler(ctx, { ...env, fetchImpl: boom });
    assert.equal(res.status, 502);
    assert.match(res.body, /dns fail/);
  }
});

test('primitive: resolveFetch falls back to globalThis.fetch when no env impl', async () => {
  const { resolveFetch } = await import('../../kernel/packages/notify-http.mjs');
  assert.equal(resolveFetch({}), globalThis.fetch);
  const custom = async () => new Response('{}');
  assert.equal(resolveFetch({ fetchImpl: custom }), custom);
});