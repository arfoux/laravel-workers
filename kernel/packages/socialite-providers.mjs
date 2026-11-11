// kernel/packages/socialite-providers.mjs — extra shape-only Socialite
// providers (azure, keycloak, cognito, okta) kept OUT of socialite.mjs so the
// default resolver stays byte-for-byte identical. These follow the exact
// `resolveProvider` contract from socialite.mjs: a code-side shape merged with
// env-supplied credentials — secrets never appear in the repo.
//
// Each provider's endpoints are derived from env *location* variables
// (AZURE_TENANT / KEYCLOAK_BASE+KEYCLOAK_REALM / COGNITO_DOMAIN+REGION /
// OKTA_ORG) plus the standard *_CLIENT_ID / *_CLIENT_SECRET / *_REDIRECT_URI /
// *_SCOPES. A provider resolves to `null` when its credentials or a required
// location param is missing, mirroring resolveProvider's unconfigured return.

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
    userPath: (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/openid/userinfo`,
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
  const upper = String(name).toUpperCase();
  const clientId = env[`${upper}_CLIENT_ID`];
  const clientSecret = env[`${upper}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;

  const shape = SHAPES[name];
  if (!shape) return null;

  const locs = (LOCATION_KEYS[name] || []).map((k) => env[k]);
  if (!locs.length || locs.some((v) => typeof v !== 'string' || !v)) return null;

  return {
    name,
    clientId,
    clientSecret,
    redirectUri: env[`${upper}_REDIRECT_URI`] || '',
    scope: env[`${upper}_SCOPES`] || shape.scope,
    authUrl: shape.authPath(...locs),
    tokenUrl: shape.tokenPath(...locs),
    userUrl: shape.userPath(...locs),
    mapUser: shape.mapUser,
  };
}

// Normalize a provider's raw user JSON into the standard Socialite-shaped
// object `{ id, name, email, nickname, avatar }` without holding a full
// resolved provider around. Returns `null` for an unknown provider name.
export function mapUserExtra(name, data) {
  const shape = SHAPES[name];
  if (!shape || !data) return null;
  return shape.mapUser(data);
}
