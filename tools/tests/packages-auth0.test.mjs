// tools/tests/packages-auth0.test.mjs — the Auth0 callback's cookie-only CSRF
// check. Every case injects a fake `env.fetchImpl`, so a rejected state can be
// proven to spend ZERO outbound subrequests before the 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFetch } from './_helpers.mjs';
import auth0 from '../../ports/packages/auth0.mjs';

const ENV = {
  AUTH0_DOMAIN: 'dev-abc123.us.auth0.com',
  AUTH0_CLIENT_ID: 'cid_123',
  AUTH0_CLIENT_SECRET: 'csecret_456',
  AUTH0_REDIRECT_URI: 'https://app.example.com/callback',
};

function makeEnv(fetchImpl) {
  return { ...ENV, fetchImpl };
}

// A plain port ctx: `body` is pre-parsed, and the only header we expose is the
// Cookie header the CSRF check reads.
function makeCtx({ body, cookie } = {}) {
  return {
    method: 'POST',
    body,
    query: {},
    params: {},
    request: {
      method: 'POST',
      url: 'https://app.example.com/auth/auth0/callback',
      headers: { get: (name) => (String(name).toLowerCase() === 'cookie' && cookie ? cookie : null) },
    },
  };
}

function tokenFetch() {
  return makeFetch(200, {
    access_token: 'eyJacc',
    id_token: 'eyJid',
    refresh_token: 'rt1',
    expires_in: 86400,
    token_type: 'Bearer',
    scope: 'openid profile email',
  });
}

test('auth0: a state matching the oauth_state cookie -> 200 and one token exchange', async () => {
  const fetchImpl = tokenFetch();
  const state = 'st_ok_123';
  const res = await auth0(
    makeCtx({ body: { code: 'code_1', state }, cookie: `oauth_state=${state}` }),
    makeEnv(fetchImpl)
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).access_token, 'eyJacc');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://dev-abc123.us.auth0.com/oauth/token');
  assert.equal(call.init.method, 'POST');
  const sent = new URLSearchParams(call.init.body);
  assert.equal(sent.get('code'), 'code_1');
  assert.equal(sent.get('state'), null); // CSRF state is not forwarded to Auth0
});

test('auth0: a state mismatching the cookie -> 401 invalid state before any fetch', async () => {
  const fetchImpl = tokenFetch();
  const res = await auth0(
    makeCtx({ body: { code: 'code_1', state: 'st_real' }, cookie: 'oauth_state=st_other' }),
    makeEnv(fetchImpl)
  );
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid state' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('auth0: a state with no cookie -> 401 invalid state before any fetch', async () => {
  const fetchImpl = tokenFetch();
  const res = await auth0(makeCtx({ body: { code: 'code_1', state: 'st_real' } }), makeEnv(fetchImpl));
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid state' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('auth0: no state -> pure token exchange with no cookie required', async () => {
  const fetchImpl = tokenFetch();
  const res = await auth0(makeCtx({ body: { code: 'code_2' } }), makeEnv(fetchImpl));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).refresh_token, 'rt1');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('code'), 'code_2');
});

test('auth0: an empty state is treated as absent — the caller owns CSRF', async () => {
  const fetchImpl = tokenFetch();
  const res = await auth0(
    makeCtx({ body: { code: 'code_3', state: '   ' }, cookie: 'oauth_state=anything' }),
    makeEnv(fetchImpl)
  );
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
});
