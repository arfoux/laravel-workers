// kernel/packages/oauth.mjs — OAuth 2.0 authorization-code primitives shared by
// the Socialite/Passport ports. Building the authorize URL, verifying the
// callback `state`, and exchanging a code are pure string/`fetch` work the edge
// does natively; the provider-specific bits (scopes, the token endpoint, the
// user-info mapping) are passed in by each port.
//
// Parity note: Socialite's `redirect()` builds
//   {providerAuthUrl}?client_id=..&redirect_uri=..&scope=..&state=..&response_type=code
// and `user()` POSTs the code to the token endpoint then GETs the user info.
// We keep that shape; the state check is constant-time.

import { timingSafeEqual } from './webhook.mjs';

// Build the authorize redirect URL. `provider` supplies { authUrl, clientId,
// redirectUri, scope (array|string), extra (object of extra query params) }.
export function authorizeUrl(provider, state) {
  const url = new URL(provider.authUrl);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('response_type', 'code');
  const scope = Array.isArray(provider.scope) ? provider.scope.join(' ') : provider.scope;
  if (scope) url.searchParams.set('scope', scope);
  if (state != null) url.searchParams.set('state', state);
  for (const [k, v] of Object.entries(provider.extra || {})) url.searchParams.set(k, String(v));
  return url.toString();
}

// Verify the callback `state` against the one stored in the session.
// Constant-time; returns true only on an exact match.
export function verifyState(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  return timingSafeEqual(expected, actual);
}

// Exchange an authorization `code` for tokens. `provider` supplies
// { tokenUrl, clientId, clientSecret, redirectUri }. Returns the parsed token
// JSON (access_token, refresh_token, ...) or throws with the provider's error.
export async function exchangeCode(provider, code, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: provider.redirectUri,
    code,
  });
  const res = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json && (json.error_description || json.error)) || `token exchange failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

// Fetch the provider's user profile. `provider` supplies { userUrl } and an
// optional `mapUser(json)` to normalize the payload into
// { id, email, name, ... } like Socialite's provider `mapUserToObject`.
export async function fetchUser(provider, accessToken, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(provider.userUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`user fetch failed (${res.status})`);
  return provider.mapUser ? provider.mapUser(json) : json;
}
