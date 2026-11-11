// kernel/packages/fcm-oauth.mjs — FCM v1 HTTP API access-token minting.
//
// Parity target: Laravel's `kreait/laravel-firebase` (FCM v1) channel. The v1
// API authenticates with a short-lived OAuth2 access token minted from a
// Firebase service account: sign a JWT (RS256) with the account's private key,
// exchange it at Google's token endpoint, and use the returned `access_token`
// as a Bearer credential. Everything here is pure WebCrypto + `fetch`, so it
// ports 1:1 to a Worker — no socket, no long-running work.
//
// Edge disclosure: NONE. RSASSA-PKCS1-v1_5 SHA-256 signing, the token endpoint
// and the message send are all HTTPS `fetch` + native WebCrypto. The only env
// cost is a transient importKey per mint (cheap). Workers CPU/subrequest limits
// are irrelevant for a single sign + POST.
//
// Config (env): FCM_SERVICE_ACCOUNT_JSON — the Firebase service-account JSON,
// either raw or base64 (Firebase tooling commonly stores it base64-encoded;
// we auto-detect). FCM_PROJECT_ID — falls back to the `project_id` field in the
// service account when omitted.
import { resolveFetch, bearerAuthHeader } from './notify-http.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// --- base64url --------------------------------------------------------------

function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Detect a base64-encoded service-account blob vs the raw JSON. Raw JSON always
// starts with `{`; a base64 blob is `[A-Za-z0-9+/=_-]+`. We try JSON.parse
// first and fall back to a base64 decode.
function parseServiceAccount(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('FCM_SERVICE_ACCOUNT_JSON is empty');
  if (text.startsWith('{')) {
    return JSON.parse(text);
  }
  // base64 (standard or url-safe, with or without padding).
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Build and sign the RS256 JWT the OAuth2 token endpoint expects.
// Returns { assertion, header, payload } (the latter two base64url segments for
// tests to assert on).
export async function buildServiceAccountJwt(serviceAccount, { now = Math.floor(Date.now() / 1000) } = {}) {
  const clientEmail = serviceAccount.client_email;
  const privateKeyPem = serviceAccount.private_key;
  if (!clientEmail) throw new Error('service account is missing client_email');
  if (!privateKeyPem) throw new Error('service account is missing private_key');

  // PKCS8 PEM -> ArrayBuffer for importKey.
  const pemBody = String(privateKeyPem)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = b64urlToBytes(pemBody);

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
    scope: FCM_SCOPE,
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

// Mint a short-lived OAuth2 access token for the FCM v1 API. Returns the raw
// `access_token` string. Throws with Google's error on a non-2xx response.
export async function mintFcmAccessToken(env, { now = Math.floor(Date.now() / 1000) } = {}) {
  const raw = env && env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('missing FCM_SERVICE_ACCOUNT_JSON');
  const serviceAccount = parseServiceAccount(raw);
  const { assertion } = await buildServiceAccountJwt(serviceAccount, { now });

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

// Bearer header helper re-exported for the port's thin handler.
export { bearerAuthHeader };
