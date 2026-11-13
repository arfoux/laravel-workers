// tools/tests/packages-welcome-notification.test.mjs — spatie/laravel-welcome-notification
// port (POST /welcome-notify).
//
// The handler is a thin router over the Mailgun/Postmark mail ports: it validates
// {email, mailProvider}, composes a welcome subject/body from `name`, then delegates
// to the existing driver handler. We exercise it with a FAKE `fetch` injected as
// `env.fetchImpl` that captures the outgoing Request (url/method/headers/body) and
// returns a stubbed provider Response, asserting:
//   - the Mailgun path builds the /v3/{domain}/messages multipart request,
//   - the Postmark path builds the /email JSON request,
//   - missing `email` or an unknown provider short-circuit before fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import welcome from '../../ports/packages/welcome-notification.mjs';
import { okCtx } from './_helpers.mjs';

// Build a fake fetch that records the call and replies with a canned response.
function makeFetch(status, jsonBody, { headers } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify(jsonBody), {
      status,
      headers: headers || { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ---- Mailgun path -----------------------------------------------------------

test('welcome/mailgun: posts welcome multipart message to /v3/{domain}/messages', async () => {
  const fetchImpl = makeFetch(200, { id: '<1@mg>', message: 'Queued' });
  const env = {
    fetchImpl,
    mailProvider: 'mailgun',
    mailgunDomain: 'mg.example.com',
    mailgunKey: 'key-1',
  };
  const ctx = okCtx({ email: 'new@user.com', name: 'Ana', mailProvider: 'mailgun', mailgunDomain: 'mg.example.com', mailgunKey: 'key-1' });

  const res = await welcome(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message, 'Queued');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.mailgun.net/v3/mg.example.com/messages');
  assert.equal(call.init.method, 'POST');
  const expected = 'Basic ' + Buffer.from('api:key-1').toString('base64');
  assert.equal(call.init.headers.authorization, expected);
  // Multipart body: boundary is fetch's job — no hand-set content-type.
  assert.equal(call.init.headers['content-type'], undefined);
  const fd = call.init.body;
  assert.equal(typeof fd.append, 'function');
  assert.equal(fd.get('to'), 'new@user.com');
  assert.equal(fd.get('subject'), 'Welcome, Ana!');
  assert.match(fd.get('text'), /Hi Ana/);
  assert.equal(fd.get('from'), 'postmaster@mg.example.com');
});

test('welcome/mailgun: name omitted falls back to a generic welcome', async () => {
  const fetchImpl = makeFetch(200, {});
  const ctx = okCtx({ email: 'new@user.com', mailProvider: 'mailgun' });
  const env = {
    fetchImpl,
    mailProvider: 'mailgun',
    MAILGUN_DOMAIN: 'mg.example.com',
    MAILGUN_SECRET: 'key-1',
  };

  const res = await welcome(ctx, env);

  assert.equal(res.status, 200);
  const fd = fetchImpl.calls[0].init.body;
  assert.equal(fd.get('subject'), 'Welcome!');
  assert.match(fd.get('text'), /Hi, welcome aboard/);
});

test('welcome/mailgun: missing domain or key is 500 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const ctx = okCtx({ email: 'new@user.com', mailProvider: 'mailgun' });
  const res = await welcome(ctx, { fetchImpl, mailProvider: 'mailgun' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Postmark path ----------------------------------------------------------

test('welcome/postmark: posts JSON welcome to /email with server token header', async () => {
  const fetchImpl = makeFetch(200, { MessageID: 'abc', ErrorCode: 0, Message: 'OK' });
  const ctx = okCtx({
    email: 'new@user.com',
    name: 'Ana',
    mailProvider: 'postmark',
    postmarkToken: 'srv-token',
  });
  const env = { fetchImpl, mailProvider: 'postmark', POSTMARK_FROM: 'send@x.com' };

  const res = await welcome(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).MessageID, 'abc');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.postmarkapp.com/email');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-postmark-server-token'], 'srv-token');
  assert.match(call.init.headers['content-type'], /application\/json/);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.From, 'send@x.com');
  assert.equal(sent.To, 'new@user.com');
  assert.equal(sent.Subject, 'Welcome, Ana!');
  assert.match(sent.TextBody, /Hi Ana/);
  assert.equal(sent.MessageStream, 'outbound');
});

test('welcome/postmark: missing token is 500 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const ctx = okCtx({ email: 'new@user.com', mailProvider: 'postmark' });
  const res = await welcome(ctx, { fetchImpl, mailProvider: 'postmark', POSTMARK_FROM: 's@x.com' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Validation -------------------------------------------------------------

test('welcome: missing email is 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await welcome(okCtx({ name: 'Ana', mailProvider: 'mailgun' }), {
    fetchImpl,
    mailProvider: 'mailgun',
    mailgunDomain: 'mg',
    mailgunKey: 'k',
  });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('welcome: unknown mailProvider is 422 before fetch', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await welcome(okCtx({ email: 'new@user.com', mailProvider: 'ses' }), { fetchImpl });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Cross-cutting: provider response mapping + error handling --------------

test('welcome: non-2xx provider status is surfaced verbatim', async () => {
  for (const provider of ['mailgun', 'postmark']) {
    const fetchImpl = makeFetch(401, { error: 'nope' });
    const ctx = okCtx({
      email: 'new@user.com',
      name: 'Ana',
      mailProvider: provider,
      mailgunDomain: 'mg',
      mailgunKey: 'k',
      postmarkToken: 't',
    });
    const res = await welcome(ctx, { fetchImpl, mailProvider: provider, POSTMARK_FROM: 's@x.com' });
    assert.equal(res.status, 401, `${provider} should surface provider 401`);
    assert.equal(typeof res.body, 'string');
  }
});

test('welcome: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const boom = async () => { throw new Error('dns fail'); };
  for (const provider of ['mailgun', 'postmark']) {
    const ctx = okCtx({
      email: 'new@user.com',
      name: 'Ana',
      mailProvider: provider,
      mailgunDomain: 'mg',
      mailgunKey: 'k',
      postmarkToken: 't',
    });
    const res = await welcome(ctx, { fetchImpl: boom, mailProvider: provider, POSTMARK_FROM: 's@x.com' });
    assert.equal(res.status, 502, `${provider} fetch throw should be 502`);
    assert.match(res.body, /dns fail/);
  }
});
