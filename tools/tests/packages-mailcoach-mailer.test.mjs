// tools/tests/packages-mailcoach-mailer.test.mjs — Mailcoach transactional-mail
// port (spatie/laravel-mailcoach-mailer transport).
//
// Same harness as the notify-http cluster: a FAKE `fetch` injected as
// `env.fetchImpl` captures the outgoing request (url/method/headers/body) and
// returns a stubbed provider `Response`. We assert:
//   - the `/api/transactional-mails/send` URL + Bearer token the port builds,
//   - the JSON body mapping (`template`->`mail_name`, `replacing`->`replacements`,
//     plus `to`/`subject`/`html`),
//   - the 1:1 provider-response mapping to {status, headers, body},
//   - validation guards (missing token -> 500, missing `to` / bodyless -> 422)
//     short-circuit before any fetch.
// No network — a pure HTTPS JSON driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mailcoach, {
  sendMail,
  buildEndpoint,
  buildMailcoachBody,
} from '../../kernel/packages/mailcoach-mailer.mjs';
import { makeFetch, okCtx } from './_helpers.mjs';

// ---- sendMail: happy path + payload ---------------------------------------

test('mailcoach: posts JSON to {baseUrl}/api/transactional-mails/send with bearer token', async () => {
  const fetchImpl = makeFetch(200, { uuid: 'send-1' });
  const res = await sendMail(
    {
      template: 'welcome-mail',
      to: 'jane@example.com',
      subject: 'Welcome',
      token: 'mc-token',
      baseUrl: 'https://mydomain.mailcoach.app',
    },
    { fetchImpl },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { uuid: 'send-1' });
  assert.equal(fetchImpl.calls.length, 1);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://mydomain.mailcoach.app/api/transactional-mails/send');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Bearer mc-token');
  assert.equal(call.init.headers.accept, 'application/json');
  assert.equal(call.init.headers['content-type'], 'application/json');
});

test('mailcoach: maps template->mail_name, replacing->replacements, passes to/subject/html', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await sendMail(
    {
      template: 'order-shipped',
      replacing: { name: 'Jane', order: '1234' },
      to: 'jane@example.com',
      subject: 'Shipped',
      html: '<p>Hi</p>',
      token: 'tok',
      baseUrl: 'mydomain.mailcoach.app',
    },
    { fetchImpl },
  );

  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.mail_name, 'order-shipped');
  assert.deepEqual(sent.replacements, { name: 'Jane', order: '1234' });
  assert.equal(sent.to, 'jane@example.com');
  assert.equal(sent.subject, 'Shipped');
  assert.equal(sent.html, '<p>Hi</p>');
  // The port's contract field names must not leak into the wire body.
  assert.equal(sent.template, undefined);
  assert.equal(sent.replacing, undefined);
});

test('mailcoach: template-only send omits html', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  await sendMail(
    { template: 'newsletter', to: 'a@b.co', token: 't', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.mail_name, 'newsletter');
  assert.equal(sent.html, undefined);
});

test('mailcoach: html-only send (no template) omits mail_name', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  await sendMail(
    { html: '<b>hi</b>', to: 'a@b.co', subject: 's', token: 't', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.mail_name, undefined);
  assert.equal(sent.html, '<b>hi</b>');
});

test('mailcoach: bare-domain baseUrl is upgraded to https and trailing slash trimmed', () => {
  assert.equal(buildEndpoint('x.mailcoach.app'), 'https://x.mailcoach.app/api/transactional-mails/send');
  assert.equal(
    buildEndpoint('https://x.mailcoach.app/'),
    'https://x.mailcoach.app/api/transactional-mails/send',
  );
});

// ---- validation guards -----------------------------------------------------

test('mailcoach: missing token is 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await sendMail(
    { template: 't', to: 'a@b.co', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'missing Mailcoach credential: set MAILCOACH_TOKEN or pass `token`');
  assert.equal(fetchImpl.calls.length, 0);
});

test('mailcoach: missing baseUrl is 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await sendMail({ template: 't', to: 'a@b.co', token: 'tok' }, { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('mailcoach: missing `to` is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await sendMail(
    { template: 't', subject: 's', token: 'tok', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('mailcoach: bodyless send (neither template nor html) is 422 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await sendMail(
    { to: 'a@b.co', token: 'tok', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- provider response mapping + error handling ---------------------------

test('mailcoach: non-2xx provider status is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(422, { message: 'The given data was invalid.' });
  const res = await sendMail(
    { template: 't', to: 'a@b.co', token: 'tok', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  assert.equal(res.status, 422);
  assert.deepEqual(JSON.parse(res.body), { message: 'The given data was invalid.' });
});

test('mailcoach: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const res = await sendMail(
    { template: 't', to: 'a@b.co', token: 'tok', baseUrl: 'x.mailcoach.app' },
    { fetchImpl },
  );
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /network down/);
});

// ---- route port handle(ctx, env) ------------------------------------------

test('handle: reads params from ctx.body and falls back to env credentials', async () => {
  const fetchImpl = makeFetch(200, { uuid: 'r-1' });
  const ctx = okCtx({ template: 'welcome', to: 'a@b.co', subject: 's' });
  const env = { fetchImpl, MAILCOACH_TOKEN: 'env-token', MAILCOACH_BASE_URL: 'env.mailcoach.app' };

  const res = await mailcoach(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).uuid, 'r-1');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://env.mailcoach.app/api/transactional-mails/send');
  assert.equal(call.init.headers.authorization, 'Bearer env-token');
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.mail_name, 'welcome');
  assert.equal(sent.to, 'a@b.co');
});

test('handle: body token/baseUrl take precedence over env', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const ctx = okCtx({ template: 't', to: 'a@b.co', token: 'body-token', baseUrl: 'body.mailcoach.app' });
  const env = { fetchImpl, MAILCOACH_TOKEN: 'env-token', MAILCOACH_BASE_URL: 'env.mailcoach.app' };

  await mailcoach(ctx, env);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://body.mailcoach.app/api/transactional-mails/send');
  assert.equal(call.init.headers.authorization, 'Bearer body-token');
});

test('handle: no token anywhere is 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const res = await mailcoach(okCtx({ template: 't', to: 'a@b.co' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- pure helpers ----------------------------------------------------------

test('buildMailcoachBody: only includes defined fields, empty replacing omitted', () => {
  assert.deepEqual(
    buildMailcoachBody({ template: 't', to: 'a@b.co', subject: 's' }),
    { mail_name: 't', to: 'a@b.co', subject: 's' },
  );
  // replacing=null must not emit an empty `replacements` object.
  const body = buildMailcoachBody({ template: 't', to: 'a@b.co', replacing: null });
  assert.equal(body.replacements, undefined);
});
