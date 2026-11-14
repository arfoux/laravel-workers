// kernel/packages/socialite-providers.mjs — extra shape-only Socialite
// providers (azure, keycloak, cognito, okta) kept OUT of socialite.mjs so the
// default resolver stays byte-for-byte identical. These follow the exact
// `resolveProvider` contract from socialite.mjs: a code-side shape merged with
// env-supplied credentials - secrets never appear in the repo.
//
// Reachability: the two socialite ports try `resolveProvider` (Laravel's own
// github/google/facebook shapes) first and fall back to `resolveProviderExtra`,
// so azure/keycloak/cognito/okta are servable through the same generic
// `/auth/{provider}/redirect` + `/auth/{provider}/callback` routes.
//
// Each provider's endpoints are derived from env *location* variables
// (AZURE_TENANT / KEYCLOAK_BASE+KEYCLOAK_REALM / COGNITO_DOMAIN+REGION /
// OKTA_ORG) plus the standard *_CLIENT_ID / *_CLIENT_SECRET / *_REDIRECT_URI /
// *_SCOPES. A provider resolves to `null` when its credentials or a required
// location param is missing, mirroring resolveProvider's unconfigured return.

import { providerEnv } from './socialite.mjs';

function subEmailMap(j) {
  const id = String(j.sub != null ? j.sub : j.id != null ? j.id : '').trim();
  return {
    id: id || j.email || '',
    name: j.name || '',
    email: j.email || '',
    nickname: j.preferred_username || j.email || j.name || '',
    avatar: j.picture || '',
  };
}

// Path fragments relative to each provider's host prefix. Cognito/Okta carry a
// fixed scheme+host (`https://{domain}.auth.{region}...` / `https://{org}.okta
// .com`) that the fragment function builds; Azure/Keycloak carry a full
// authorize prefix (tenant path / realm path) that authPath returns as-is.
const SHAPES = {
  azure: {
    authPath: (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenPath: (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    // The userinfo endpoint is NOT on the login host: the tenant-agnostic
    // discovery document (`https://login.microsoftonline.com/common/v2.0/
    // .well-known/openid-configuration`) names `https://graph.microsoft.com/
    // oidc/userinfo`, and both `…/oauth2/v2.0/openid/userinfo` and
    // `…/oauth2/v2.0/userinfo` answer 404 (probed). It needs no tenant.
    userPath: () => 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
    mapUser: subEmailMap,
  },
  keycloak: {
    authPath: (base, realm) => `${base.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/authorize`,
    tokenPath: (base, realm) => `${base.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/token`,
    userPath: (base, realm) => `${base.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/userinfo`,
    scope: 'openid email profile',
    mapUser: subEmailMap,
  },
  cognito: {
    authPath: (domain, region) => `https://${domain}.auth.${region}.amazoncognito.com/oauth2/authorize`,
    tokenPath: (domain, region) => `https://${domain}.auth.${region}.amazoncognito.com/oauth2/token`,
    userPath: (domain, region) => `https://${domain}.auth.${region}.amazoncognito.com/oauth2/userInfo`,
    scope: 'openid email profile',
    mapUser: subEmailMap,
  },
  okta: {
    authPath: (org) => `https://${org}.okta.com/oauth2/v1/authorize`,
    tokenPath: (org) => `https://${org}.okta.com/oauth2/v1/token`,
    userPath: (org) => `https://${org}.okta.com/oauth2/v1/userinfo`,
    scope: 'openid email profile',
    mapUser: subEmailMap,
  },
};

const LOCATION_KEYS = {
  azure: ['AZURE_TENANT'],
  keycloak: ['KEYCLOAK_BASE', 'KEYCLOAK_REALM'],
  cognito: ['COGNITO_DOMAIN', 'COGNITO_REGION'],
  okta: ['OKTA_ORG'],
};

// Resolve `name` exactly like resolveProvider does — but the shape's URLs are
// built here from env location vars. Returns the merged provider shape usable
// by kernel/packages/oauth.mjs (authorizeUrl / exchangeCode / fetchUser), or
// null when unconfigured.
export function resolveProviderExtra(env, name) {
  const shape = SHAPES[name];
  if (!shape) return null;

  const locs = (LOCATION_KEYS[name] || []).map((k) => env[k]);
  if (!locs.length || locs.some((v) => typeof v !== 'string' || !v)) return null;

  const shared = providerEnv(env, name, { scope: shape.scope });
  if (!shared) return null;

  return {
    name,
    ...shared,
    authUrl: shape.authPath(...locs),
    tokenUrl: shape.tokenPath(...locs),
    userUrl: shape.userPath(...locs),
    mapUser: shape.mapUser,
  };
}
