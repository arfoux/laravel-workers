// tools/tests/packages-analytics.test.mjs — spatie/laravel-analytics (GA4 Data
// API) port + its Google OAuth mint (kernel/packages/google-oauth.mjs).
//
// Covered:
//   - google-oauth: RS256 JWT mint (base64url header/body segments, signature
//     verifies against the service-account public key) and a scope/jsonEnv
//     parameterised token exchange.
//   - analytics port: GET /analytics mints a Bearer token from
//     GA4_SERVICE_ACCOUNT_JSON and POSTs the runReport request (metrics /
//     dimensions / dateRanges) to the GA4 property endpoint, returning the
//     report JSON verbatim.
//   - guards: missing GA4_PROPERTY_ID → 422, missing service account → 500 —
//     both short-circuit before any mint/fetch.
// No network — the OAuth + report fetches are faked via env.fetchImpl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  buildGoogleServiceAccountJwt,
  mintGoogleAccessToken,
  GA4_SCOPE,
} from '../../kernel/packages/google-oauth.mjs';
import analyticsPort from '../../ports/packages/analytics.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const enc = new TextEncoder();
const dec = new TextDecoder();

// base64url helpers (local to the test for assert/inspect).
function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return new Uint8Array(Buffer.from(b64 + '='.repeat(pad), 'base64'));
}
function b64urlDecodeJson(seg) {
  return JSON.parse(dec.decode(b64urlToBytes(seg)));
}
function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlPemToBytes(pem) {
  const body = String(pem)
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return b64urlToBytes(body);
}

// ---- fakes -----------------------------------------------------------------

// Record every outgoing call and reply with a canned (or per-call computed)
// response.
function makeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = typeof responses === 'function' ? responses(calls.length - 1, url, init) : responses;
    return new Response(r.body, { status: r.status, headers: r.headers || { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// A GET /analytics ctx: params live on the query string.
const okCtx = (query = {}) => ({ body: {}, query, params: {} });

// Generate a fresh RSA keypair (PKCS8 PEM private) for the service account.
async function makeServiceAccount() {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await webcrypto.subtle.exportKey('spki', kp.publicKey);
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', kp.privateKey);
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const wrap = (label, data) => `${label}\n${b64(data).replace(/(.{64})/g, '$1\n')}\n${label.replace('BEGIN', 'END')}`;
  return {
    project_id: 'analytics-123',
    client_email: 'ga4-service@analytics-123.iam.gserviceaccount.com',
    private_key: wrap('-----BEGIN PRIVATE KEY-----', pkcs8),
    public_spki: wrap('-----BEGIN PUBLIC KEY-----', spki),
  };
}

// ---- google-oauth (kernel) -------------------------------------------------

test('google-oauth: buildGoogleServiceAccountJwt produces RS256 header + GA4 scope, signature verifies', async () => {
  const sa = await makeServiceAccount();
  const now = 1_700_000_000;
  const { assertion, header, payload } = await buildGoogleServiceAccountJwt(sa, { now });

  const [h, p, s] = assertion.split('.');
  assert.equal(h, b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.sub, sa.client_email);
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.iat, now);
  assert.equal(payload.exp, now + 3600);
  assert.equal(payload.scope, GA4_SCOPE);
  assert.equal(b64urlDecodeJson(p).scope, GA4_SCOPE);

  const sig = b64urlToBytes(s);
  const pub = await webcrypto.subtle.importKey(
    'spki',
    b64urlPemToBytes(sa.public_spki),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, sig, enc.encode(`${h}.${p}`));
  assert.equal(ok, true);
});

test('google-oauth: mintGoogleAccessToken honours jsonEnv + scope and exchanges for a token', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 'ya29.search' }) });
  const env = { fetchImpl, SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
  const scope = 'https://www.googleapis.com/auth/webmasters.readonly';

  const token = await mintGoogleAccessToken(env, { jsonEnv: 'SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON', scope, now: 1_700_000_000 });

  assert.equal(token, 'ya29.search');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://oauth2.googleapis.com/token');
  assert.equal(call.init.method, 'POST');
  assert.match(String(call.init.headers['content-type']), /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(call.init.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = b64urlDecodeJson(body.get('assertion').split('.')[1]);
  assert.equal(claims.scope, scope);
  assert.equal(claims.iss, sa.client_email);
});

// ---- analytics port --------------------------------------------------------

test('analytics: GET sends runReport with Bearer token and returns the GA4 report verbatim', async () => {
  const sa = await makeServiceAccount();
  // First call = token mint, second = runReport.
  const fetchImpl = makeFetch((i) =>
    i === 0
      ? { status: 200, body: JSON.stringify({ access_token: 'ya29.ga4', expires_in: 3600 }) }
      : {
          status: 200,
          body: JSON.stringify({
            dimensionHeaders: [{ name: 'date' }],
            metricHeaders: [{ name: 'activeUsers' }],
            rows: [{ dimensionValues: [{ value: '20240101' }], metricValues: [{ value: '42' }] }],
          }),
        },
  );
  const env = {
    fetchImpl,
    GA4_PROPERTY_ID: '769381901615',
    GA4_SERVICE_ACCOUNT_JSON: JSON.stringify(sa),
  };
  const ctx = okCtx({
    metrics: 'activeUsers,screenPageViews',
    dimensions: 'date,pagePath',
    dateRange: '2024-01-01,2024-01-31',
  });

  const res = await analyticsPort(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 2);

  const mint = fetchImpl.calls[0];
  assert.equal(mint.url, 'https://oauth2.googleapis.com/token');
  const mintBody = new URLSearchParams(mint.init.body);
  assert.equal(mintBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(b64urlDecodeJson(mintBody.get('assertion').split('.')[1]).scope, GA4_SCOPE);

  const report = fetchImpl.calls[1];
  assert.equal(
    report.url,
    'https://analyticsdata.googleapis.com/v1beta/properties/769381901615:runReport',
  );
  assert.equal(report.init.method, 'POST');
  assert.equal(report.init.headers.authorization, 'Bearer ya29.ga4');
  const body = JSON.parse(report.init.body);
  assert.deepEqual(body.metrics, [{ name: 'activeUsers' }, { name: 'screenPageViews' }]);
  assert.deepEqual(body.dimensions, [{ name: 'date' }, { name: 'pagePath' }]);
  assert.deepEqual(body.dateRanges, [{ startDate: '2024-01-01', endDate: '2024-01-31' }]);

  const json = JSON.parse(res.body);
  assert.equal(json.metricHeaders[0].name, 'activeUsers');
  assert.equal(json.rows[0].metricValues[0].value, '42');
});

test('analytics: GA4 non-2xx provider error is surfaced verbatim', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch(
    (i) =>
      i === 0
        ? { status: 200, body: JSON.stringify({ access_token: 't' }) }
        : {
            status: 403,
            body: JSON.stringify({
              error: { code: 403, message: 'Google Analytics API has not been used...', status: 'PERMISSION_DENIED' },
            }),
          },
  );
  const env = { fetchImpl, GA4_PROPERTY_ID: '769381901615', GA4_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };

  const res = await analyticsPort(okCtx({ metrics: 'activeUsers', dateRange: '2024-01-01,2024-01-31' }), env);

  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.status, 'PERMISSION_DENIED');
});

test('analytics: missing GA4_PROPERTY_ID is a 422 and never mints/fetches', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 't' }) });
  const env = { fetchImpl, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };

  const res = await analyticsPort(okCtx({ metrics: 'activeUsers' }), env);

  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('analytics: missing GA4_SERVICE_ACCOUNT_JSON is a 500 and never fetches', async () => {
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 't' }) });
  const env = { fetchImpl, GA4_PROPERTY_ID: '769381901615' };

  const res = await analyticsPort(okCtx({ metrics: 'activeUsers' }), env);

  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});
