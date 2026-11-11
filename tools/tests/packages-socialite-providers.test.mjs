// tools/tests/packages-socialite-providers.test.mjs — extra shape-only
// Socialite providers (azure, keycloak, cognito, okta). These live in a
// separate module (socialite-providers.mjs) so the default socialite.mjs
// resolver is untouched. The shapes are pure config: authorizeUrl derived from
// env location vars, and mapUser normalizing `sub`/`email` payloads the way
// Socialite's `mapUserToObject` does. These tests assert, per provider:
//   • the derived authorize/token/user endpoints,
//   • the credentials + scope merged from env,
//   • mapUserExtra flattening of the raw sub/email JSON,
//   • the unconfigured null returns (missing creds / missing location / unknown).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderExtra, mapUserExtra } from '../../kernel/packages/socialite-providers.mjs';

function makeEnv(fragment, creds) {
  return { ...fragment, ...creds };
}

test('azure: shape is Microsoft identity v2.0 with the tenant in each endpoint', () => {
  const env = makeEnv(
    { AZURE_TENANT: 'contoso' },
    { AZURE_CLIENT_ID: 'az-id', AZURE_CLIENT_SECRET: 'az-secret', AZURE_REDIRECT_URI: 'https://app.test/cb' }
  );
  const p = resolveProviderExtra(env, 'azure');
  assert.ok(p);
  assert.equal(p.authUrl, 'https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize');
  assert.equal(p.tokenUrl, 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token');
  assert.equal(p.userUrl, 'https://login.microsoftonline.com/contoso/oauth2/v2.0/openid/userinfo');
  assert.equal(p.clientId, 'az-id');
  assert.equal(p.clientSecret, 'az-secret');
  assert.equal(p.redirectUri, 'https://app.test/cb');
  assert.equal(p.scope, 'openid email profile');
});

test('keycloak: shape is the realm openid-connect protocol endpoints', () => {
  const env = makeEnv(
    { KEYCLOAK_BASE: 'https://id.example.com/', KEYCLOAK_REALM: 'myrealm' },
    { KEYCLOAK_CLIENT_ID: 'kc-id', KEYCLOAK_CLIENT_SECRET: 'kc-secret' }
  );
  const p = resolveProviderExtra(env, 'keycloak');
  assert.ok(p);
  assert.equal(p.authUrl, 'https://id.example.com/realms/myrealm/protocol/openid-connect/authorize');
  assert.equal(p.tokenUrl, 'https://id.example.com/realms/myrealm/protocol/openid-connect/token');
  assert.equal(p.userUrl, 'https://id.example.com/realms/myrealm/protocol/openid-connect/userinfo');
});

test('keycloak: trailing slash on the base is stripped before building the realm path', () => {
  const env = makeEnv(
    { KEYCLOAK_BASE: 'https://id.example.com', KEYCLOAK_REALM: 'r2' },
    { KEYCLOAK_CLIENT_ID: 'kc-id', KEYCLOAK_CLIENT_SECRET: 'kc-secret' }
  );
  const p = resolveProviderExtra(env, 'keycloak');
  assert.equal(p.authUrl, 'https://id.example.com/realms/r2/protocol/openid-connect/authorize');
  assert.equal(p.tokenUrl, 'https://id.example.com/realms/r2/protocol/openid-connect/token');
  assert.equal(p.userUrl, 'https://id.example.com/realms/r2/protocol/openid-connect/userinfo');
});

test('cognito: shape is the pooled {domain}.auth.{region} host with /oauth2 routes', () => {
  const env = makeEnv(
    { COGNITO_DOMAIN: 'myapp-prod', COGNITO_REGION: 'us-east-1' },
    { COGNITO_CLIENT_ID: 'cg-id', COGNITO_CLIENT_SECRET: 'cg-secret', COGNITO_SCOPES: 'openid email' }
  );
  const p = resolveProviderExtra(env, 'cognito');
  assert.ok(p);
  assert.equal(p.authUrl, 'https://myapp-prod.auth.us-east-1.amazoncognito.com/oauth2/authorize');
  assert.equal(p.tokenUrl, 'https://myapp-prod.auth.us-east-1.amazoncognito.com/oauth2/token');
  assert.equal(p.userUrl, 'https://myapp-prod.auth.us-east-1.amazoncognito.com/oauth2/userInfo');
  assert.equal(p.scope, 'openid email');
});

test('okta: shape is the {org}.okta.com oauth2/v1 endpoints', () => {
  const env = makeEnv(
    { OKTA_ORG: 'dev-123456' },
    { OKTA_CLIENT_ID: 'ok-id', OKTA_CLIENT_SECRET: 'ok-secret' }
  );
  const p = resolveProviderExtra(env, 'okta');
  assert.ok(p);
  assert.equal(p.authUrl, 'https://dev-123456.okta.com/oauth2/v1/authorize');
  assert.equal(p.tokenUrl, 'https://dev-123456.okta.com/oauth2/v1/token');
  assert.equal(p.userUrl, 'https://dev-123456.okta.com/oauth2/v1/userinfo');
});

test('mapUserExtra: azure flattens sub/preferred_username/picture', () => {
  const u = mapUserExtra('azure', {
    sub: 'a1b2c3',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    preferred_username: 'ada@example.com',
    picture: 'https://id.example.com/ada.jpg',
  });
  assert.deepEqual(u, {
    id: 'a1b2c3',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    nickname: 'ada@example.com',
    avatar: 'https://id.example.com/ada.jpg',
  });
});

test('mapUserExtra: falls back to email for id when sub is absent', () => {
  const u = mapUserExtra('keycloak', { email: 'k@example.com', name: 'Grace' });
  assert.equal(u.id, 'k@example.com');
  assert.equal(u.nickname, 'k@example.com');
});

test('mapUserExtra: provider name is case-sensitive and unknown names return null', () => {
  assert.equal(mapUserExtra('Azure', { sub: 'x', email: 'e@x.com' }), null);
  assert.equal(mapUserExtra('notaprovider', { sub: 'x', email: 'e@x.com' }), null);
});

test('resolveProviderExtra: missing credentials returns null', () => {
  const env = makeEnv({ AZURE_TENANT: 'contoso' }, {});
  assert.equal(resolveProviderExtra(env, 'azure'), null);
});

test('resolveProviderExtra: missing location params return null', () => {
  const env = makeEnv(
    {},
    { KEYCLOAK_CLIENT_ID: 'kc-id', KEYCLOAK_CLIENT_SECRET: 'kc-secret' }
  );
  assert.equal(resolveProviderExtra(env, 'keycloak'), null);
});

test('resolveProviderExtra: unknown provider returns null even with creds', () => {
  const env = makeEnv({}, { FOO_CLIENT_ID: 'x', FOO_CLIENT_SECRET: 'y' });
  assert.equal(resolveProviderExtra(env, 'foo'), null);
});
