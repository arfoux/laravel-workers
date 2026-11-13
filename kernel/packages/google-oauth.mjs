// kernel/packages/google-oauth.mjs — Google OAuth2 access-token minting,
// generalised from the FCM path in `fcm-oauth.mjs`.
//
// FCM (`kreait/laravel-firebase`) and GA4 (`spatie/laravel-analytics`) both
// authenticate to a Google API with a short-lived OAuth2 access token minted
// from a service account: sign an RS256 JWT with the account's private key,
// exchange it at Google's token endpoint, and send the returned `access_token`
// as a Bearer credential. `fcm-oauth.mjs` bakes in the FCM scope and env var
// name; this module parameterises both, so any Google API port (GA4 analytics,
// Search Console, …) reuses the same pure WebCrypto machinery without
// duplicating it. `fcm-oauth.mjs` is left untouched (it stays the FCM binding).
//
// Edge disclosure: NONE. RSASSA-PKCS1-v1_5 SHA-256 signing and the token
// endpoint are native WebCrypto + HTTPS `fetch` — no socket, no token cache, a
// transient importKey per mint. This is the substitute for `google/apiclient`
// (Laravel's Analytics SDK), which needs a socket and a filesystem token cache.
//
// Config: the service-account JSON is read from the env var named by `jsonEnv`
// (default `GA4_SERVICE_ACCOUNT_JSON`), either raw or base64.
import { resolveFetch } from './notify-http.mjs';
import { b64url as b64urlFromBytes, b64urlToBytes, pemToDer } from './b64url.mjs';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// Same auto-detect as fcm-oauth.mjs: raw JSON always starts with `{`; a base64
// blob (how GCP tooling commonly stores key files) is decoded. Exported so
// callers/tests can reuse the parse without re-implementing it.
export function parseServiceAccount(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('service-account JSON is empty');
  if (text.startsWith('{')) {
    return JSON.parse(text);
  }
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
}

// Build and sign the RS256 JWT a Google OAuth2 token endpoint expects for
// `scope`. Returns { assertion, header, payload } (payload carries iat/exp/aud/
// scope for tests to assert on).
export async function buildGoogleServiceAccountJwt(serviceAccount, { scope = GA4_SCOPE, now = Math.floor(Date.now() / 1000) } = {}) {
  const clientEmail = serviceAccount && serviceAccount.client_email;
  const privateKeyPem = serviceAccount && serviceAccount.private_key;
  if (!clientEmail) throw new Error('service account is missing client_email');
  if (!privateKeyPem) throw new Error('service account is missing private_key');

  // PKCS8 PEM (or the bare base64 body) -> DER bytes for importKey.
  const der = pemToDer(privateKeyPem, 'Google service-account private_key');

  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope,
  };
  const signingInput = `${b64urlFromBytes(new TextEncoder().encode(JSON.stringify(header)))}.${b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
  return { assertion, header, payload };
}

// Mint a short-lived OAuth2 access token for a Google API. The service-account
// JSON comes from `env[jsonEnv]` (default `GA4_SERVICE_ACCOUNT_JSON`). Throws
// with Google's error on a non-2xx response.
export async function mintGoogleAccessToken(env, { scope = GA4_SCOPE, jsonEnv = 'GA4_SERVICE_ACCOUNT_JSON', now = Math.floor(Date.now() / 1000) } = {}) {
  const raw = env && env[jsonEnv];
  if (!raw) throw new Error(`missing ${jsonEnv}`);
  const serviceAccount = parseServiceAccount(raw);
  const { assertion } = await buildGoogleServiceAccountJwt(serviceAccount, { scope, now });

  const doFetch = resolveFetch(env);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    const message = (json && (json.error_description || json.error)) || `token mint failed (${res.status})`;
    throw new Error(message);
  }
  return json.access_token;
}
