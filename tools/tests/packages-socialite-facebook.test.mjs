// tools/tests/packages-socialite-facebook.test.mjs — batch-2a, the Facebook
// Socialite provider.
//
// laravel/socialite is provider-agnostic: the shared redirect/callback ports
// (laravel-socialite-redirect.mjs / laravel-socialite-callback.mjs, wave-1)
// dispatch on `provider`, and the provider's *shape* lives in
// kernel/packages/socialite.mjs `resolveProvider`. The batch-2a change is the
// added `facebook` shape (Graph v18). These tests drive the REAL redirect +
// callback handlers with `provider=facebook` and a stubbed `fetch`, asserting:
//   • the Graph v18 dialog/token/me URLs the resolver supplies,
//   • the code exchange POST body (client_id/secret/redirect_uri/code),
//   • the Bearer user-info GET and the mapUser flattening of picture.data.url,
//   • the end-to-end login (user upsert + minted bearer token).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeD1 } from './_fake-d1.mjs';

import redirect from '../../ports/packages/laravel-socialite-redirect.mjs';
import callback from '../../ports/packages/laravel-socialite-callback.mjs';
import { rememberState } from '../../kernel/packages/socialite.mjs';

function makeEnv(fetchImpl) {
  const DB = new FakeD1();
  return {
    DB,
    FACEBOOK_CLIENT_ID: 'fb-app-id',
    FACEBOOK_CLIENT_SECRET: 'fb-app-secret',
    FACEBOOK_REDIRECT_URI: 'https://app.test/auth/facebook/callback',
    fetchImpl,
  };
}

// A fetch stub that records every call and answers the token + me endpoints.
function facebookFetch() {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = new URL(url);
    const record = { url, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body || '' };
    calls.push(record);
    const auth = record.headers.authorization || '';
    if (u.pathname.endsWith('/oauth/access_token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'FB_AT', token_type: 'bearer', expires_in: 3600 }),
      };
    }
    if (u.pathname === '/me') {
      assert.equal(auth, `Bearer FB_AT`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1001',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          picture: { data: { url: 'https://graph.facebook.com/pic/ada.jpg' } },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

test('facebook resolver: the shape is Graph v18 dialog/token/me', async () => {
  const { resolveProvider } = await import('../../kernel/packages/socialite.mjs');
  const p = resolveProvider(makeEnv(null), 'facebook');
  assert.equal(p.authUrl, 'https://www.facebook.com/v18.0/dialog/oauth');
  assert.equal(p.tokenUrl, 'https://graph.facebook.com/v18.0/oauth/access_token');
  assert.equal(p.userUrl, 'https://graph.facebook.com/me?fields=id,name,email,picture');
  assert.equal(p.clientId, 'fb-app-id');
  assert.equal(p.clientSecret, 'fb-app-secret');
});

test('facebook redirect: 302 to the Graph v18 dialog with client_id/redirect_uri/scope/state', async () => {
  const env = makeEnv(null);
  const res = await redirect({ params: { provider: 'facebook' }, query: {}, request: new Request('https://app.test/auth/facebook/redirect') }, env);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://www.facebook.com/v18.0/dialog/oauth');
  assert.equal(loc.searchParams.get('client_id'), 'fb-app-id');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://app.test/auth/facebook/callback');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('scope'), 'email');
  assert.ok(loc.searchParams.get('state'));
  // the state is also planted as a cookie + a D1 row (defense in depth)
  assert.match(res.headers['set-cookie'], /oauth_state=/);
  const row = await env.DB.prepare('SELECT * FROM lw_oauth_state WHERE state = ?1').bind(loc.searchParams.get('state')).first();
  assert.ok(row);
});

test('facebook callback: exchanges the code, fetches /me with Bearer, flattens picture.data.url', async () => {
  const fetchImpl = facebookFetch();
  const env = makeEnv(fetchImpl);
  const state = 'st_123';
  const res = await callback(
    {
      params: { provider: 'facebook' },
      query: { code: 'FB_CODE', state },
      request: new Request('https://app.test/auth/facebook/callback?code=FB_CODE&state=' + state, {
        headers: { cookie: `oauth_state=${state}` },
      }),
    },
    env
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);

  // code exchange POST hit Graph v18 with the right body
  const tokenCall = fetchImpl.calls.find((c) => c.url.endsWith('/oauth/access_token'));
  assert.ok(tokenCall);
  assert.equal(tokenCall.method, 'POST');
  const params = new URLSearchParams(tokenCall.body);
  assert.equal(params.get('client_id'), 'fb-app-id');
  assert.equal(params.get('client_secret'), 'fb-app-secret');
  assert.equal(params.get('redirect_uri'), 'https://app.test/auth/facebook/callback');
  assert.equal(params.get('code'), 'FB_CODE');
  assert.equal(params.get('grant_type'), 'authorization_code');

  // /me GET carried the Bearer access token
  const meCall = fetchImpl.calls.find((c) => c.url.includes('/me'));
  assert.ok(meCall);
  assert.equal(meCall.headers.authorization, 'Bearer FB_AT');
  assert.ok(meCall.url.includes('fields=id,name,email,picture'));

  // mapUser flattened the nested picture object into avatar
  assert.equal(body.user.email, 'ada@example.com');
  assert.equal(body.user.name, 'Ada Lovelace');
  assert.equal(body.user.avatar, 'https://graph.facebook.com/pic/ada.jpg');
  assert.equal(body.user.provider_id, '1001');

  // end-to-end login: a bearer token was minted and persisted (sha256 stored)
  assert.match(body.access_token, /^\d+\|[A-Za-z0-9]{40}$/);
  const tok = await env.DB.prepare('SELECT * FROM personal_access_tokens WHERE tokenable_id = ?1').bind(body.user.id).first();
  assert.ok(tok);
  assert.notEqual(tok.token, body.access_token); // only the sha256 is stored
});

test('facebook callback: bad/missing state is rejected before any network call', async () => {
  const fetchImpl = facebookFetch();
  const env = makeEnv(fetchImpl);
  // the redirect leg ran first and planted the state row (production path)
  await rememberState(env, 'st_real');
  const res = await callback(
    {
      params: { provider: 'facebook' },
      query: { code: 'FB_CODE', state: 'forged' },
      request: new Request('https://app.test/auth/facebook/callback?code=FB_CODE&state=forged', {
        headers: { cookie: 'oauth_state=st_real' },
      }),
    },
    env
  );
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid state' });
  assert.equal(fetchImpl.calls.length, 0); // never talked to Facebook
});

test('facebook callback: a malformed cookie escape is a state mismatch, not a throw', async () => {
  const fetchImpl = facebookFetch();
  const env = makeEnv(fetchImpl);
  // readStateCookie ran before the handler's try block, so `decodeURIComponent('%')`
  // escaped the route as an uncaught URIError. A prior flow's row exists, but
  // nothing is stored for this query's `st_123`.
  await rememberState(env, 'st_from-a-prior-flow');
  const res = await callback(
    {
      params: { provider: 'facebook' },
      query: { code: 'FB_CODE', state: 'st_123' },
      request: new Request('https://app.test/auth/facebook/callback?code=FB_CODE&state=st_123', {
        headers: { cookie: 'oauth_state=%' },
      }),
    },
    env
  );
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid state' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('facebook callback: unconfigured provider (no creds) is a 400', async () => {
  const env = { DB: new FakeD1() }; // no FACEBOOK_* env
  const res = await callback(
    { params: { provider: 'facebook' }, query: {}, request: new Request('https://app.test/auth/facebook/callback') },
    env
  );
  assert.equal(res.status, 400);
});
