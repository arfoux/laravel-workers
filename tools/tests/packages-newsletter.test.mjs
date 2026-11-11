// tools/tests/packages-newsletter.test.mjs — spatie/laravel-newsletter port
// (kernel/packages/newsletter.mjs), a thin Mailchimp Marketing REST driver.
//
// Exercised with a FAKE `fetch` injected as `env.fetchImpl` that captures the
// outgoing Request (url/method/headers/body) and returns a stubbed provider
// `Response`. We assert:
//   - the provider URL + Basic auth header + JSON body each operation builds,
//   - the 1:1 mapping of the provider response to {status, headers, body},
//   - `isSubscribed` maps `status: "subscribed"` to a JSON boolean,
//   - the missing-credential guard short-circuits to a 500 before any fetch.
// No network, no D1 — a pure HTTP driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import handle, { subscribe, unsubscribe, isSubscribed } from '../../kernel/packages/newsletter.mjs';

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

const LIST = 'list-abc';
const EMAIL = 'Jane@Example.COM';
const HASH = createHash('md5').update(EMAIL.toLowerCase()).digest('hex');
const API_KEY = 'mailchimp-key-us9';
const SERVER = 'us9';
const ENV = { fetchImpl: null, MAILCHIMP_API_KEY: API_KEY, MAILCHIMP_SERVER_PREFIX: SERVER };
// Mailchimp basic auth is base64("apikey:") — empty password after the colon.
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');

// ---- subscribe -------------------------------------------------------------

test('newsletter: subscribe POSTs a member to /lists/{id}/members with basic auth', async () => {
  const fetchImpl = makeFetch(200, { id: 'm1', status: 'subscribed' });
  const res = await subscribe(LIST, EMAIL, { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res.body).id, 'm1');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://${SERVER}.api.mailchimp.com/3.0/lists/${LIST}/members`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, EXPECTED_AUTH);
  assert.match(call.init.headers['content-type'], /application\/json/);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.email_address, EMAIL);
  assert.equal(sent.status, 'subscribed');
});

test('newsletter: subscribe includes merge_fields when firstName/lastName given', async () => {
  const fetchImpl = makeFetch(200, { id: 'm2' });
  await subscribe(LIST, 'a@b.com', { apiKey: API_KEY, serverPrefix: SERVER, firstName: 'Jane', lastName: 'Doe' }, { fetchImpl });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.merge_fields, { FNAME: 'Jane', LNAME: 'Doe' });
});

test('newsletter: subscribe omits merge_fields when names absent', async () => {
  const fetchImpl = makeFetch(200, { id: 'm3' });
  await subscribe(LIST, 'a@b.com', { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.merge_fields, undefined);
});

test('newsletter: subscribe creds fall back to MAILCHIMP_* env', async () => {
  const fetchImpl = makeFetch(200, { id: 'm4' });
  await subscribe(LIST, 'a@b.com', {}, { fetchImpl, MAILCHIMP_API_KEY: API_KEY, MAILCHIMP_SERVER_PREFIX: SERVER });
  assert.equal(fetchImpl.calls[0].init.headers.authorization, EXPECTED_AUTH);
});

// ---- unsubscribe -----------------------------------------------------------

test('newsletter: unsubscribe PUTs status unsubscribed to the member hash', async () => {
  const fetchImpl = makeFetch(200, { id: 'm5', status: 'unsubscribed' });
  const res = await unsubscribe(LIST, EMAIL, { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://${SERVER}.api.mailchimp.com/3.0/lists/${LIST}/members/${HASH}`);
  assert.equal(call.init.method, 'PUT');
  assert.equal(call.init.headers.authorization, EXPECTED_AUTH);
  assert.equal(JSON.parse(call.init.body).status, 'unsubscribed');
});

// ---- isSubscribed ----------------------------------------------------------

test('newsletter: isSubscribed maps a subscribed member to true', async () => {
  const fetchImpl = makeFetch(200, { id: 'm6', status: 'subscribed' });
  const res = await isSubscribed(LIST, EMAIL, { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });

  assert.equal(res.status, 200);
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'GET');
  assert.equal(call.url, `https://${SERVER}.api.mailchimp.com/3.0/lists/${LIST}/members/${HASH}`);
  assert.equal(call.init.headers.authorization, EXPECTED_AUTH);
  assert.deepEqual(JSON.parse(res.body), { subscribed: true, status: 'subscribed' });
});

test('newsletter: isSubscribed maps any other status to false', async () => {
  const fetchImpl = makeFetch(200, { status: 'pending' });
  const res = await isSubscribed(LIST, EMAIL, { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });
  assert.deepEqual(JSON.parse(res.body), { subscribed: false, status: 'pending' });
});

// ---- credential / validation guards ----------------------------------------

test('newsletter: missing apiKey is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await subscribe(LIST, 'a@b.com', {}, { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  const body = JSON.parse(res.body);
  assert.match(body.error ?? '', /apiKey|API_KEY/);
});

test('newsletter: missing serverPrefix is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await subscribe(LIST, 'a@b.com', { apiKey: API_KEY }, { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- default route handler (port-ctx contract) -----------------------------

test('newsletter: default handler dispatches on ctx.body.action', async () => {
  const fetchImpl = makeFetch(200, { id: 'm7', status: 'subscribed' });
  const ctx = {
    request: { method: () => 'POST', pathInfo: () => '/api/newsletter' },
    body: { action: 'subscribe', listId: LIST, email: EMAIL, apiKey: API_KEY, serverPrefix: SERVER },
    query: {},
    params: {},
  };
  const res = await handle(ctx, { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].url, `https://${SERVER}.api.mailchimp.com/3.0/lists/${LIST}/members`);
});

test('newsletter: default handler isSubscribed maps through the JSON body', async () => {
  const fetchImpl = makeFetch(200, { status: 'subscribed' });
  const ctx = {
    request: { method: () => 'GET', pathInfo: () => '/api/newsletter' },
    body: { action: 'isSubscribed', listId: LIST, email: EMAIL, apiKey: API_KEY, serverPrefix: SERVER },
    query: {},
    params: {},
  };
  const res = await handle(ctx, { fetchImpl });
  assert.deepEqual(JSON.parse(res.body), { subscribed: true, status: 'subscribed' });
});

test('newsletter: default handler without apiKey is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await handle(
    { request: { method: () => 'POST', pathInfo: () => '/' }, body: { action: 'subscribe', listId: LIST, email: EMAIL }, query: {}, params: {} },
    { fetchImpl }
  );
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('newsletter: default handler rejects an unknown action with 422', async () => {
  const fetchImpl = makeFetch(200, {});
  const res = await handle(
    { request: { method: () => 'POST', pathInfo: () => '/' }, body: { action: 'nope', listId: LIST, email: EMAIL, apiKey: API_KEY, serverPrefix: SERVER }, query: {}, params: {} },
    { fetchImpl }
  );
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- provider error mapping -------------------------------------------------

test('newsletter: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const boom = async () => { throw new Error('dns fail'); };
  const res = await subscribe(LIST, EMAIL, { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl: boom });
  assert.equal(res.status, 502);
});

test('newsletter: non-2xx provider status is surfaced verbatim', async () => {
  const fetchImpl = makeFetch(400, { title: 'Invalid Resource', status: 400 });
  const res = await subscribe(LIST, 'a@b.com', { apiKey: API_KEY, serverPrefix: SERVER }, { fetchImpl });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body, 'string');
});
