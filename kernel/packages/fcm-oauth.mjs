// kernel/packages/fcm-oauth.mjs — FCM v1 HTTP API access-token minting.
//
// Parity target: Laravel's `kreait/laravel-firebase` (FCM v1) channel. The v1
// API authenticates with a short-lived OAuth2 access token minted from a
// Firebase service account: sign a JWT (RS256) with the account's private key,
// exchange it at Google's token endpoint, and use the returned `access_token`
// as a Bearer credential. That whole path is pure WebCrypto + `fetch`, so it
// ports 1:1 to a Worker — no socket, no long-running work.
//
// Edge disclosure: NONE, and none to add here — see `google-oauth.mjs`.
//
// Config (env): FCM_SERVICE_ACCOUNT_JSON — the Firebase service-account JSON,
// either raw or base64 (Firebase tooling commonly stores it base64-encoded;
// we auto-detect). FCM_PROJECT_ID — falls back to the `project_id` field in the
// service account when omitted.
//
// The RS256 JWT sign and the token-endpoint exchange are the same rule GA4
// (`spatie/laravel-analytics`) needs, so they live once in `google-oauth.mjs`.
// This module is the FCM binding: the FCM scope, the `FCM_SERVICE_ACCOUNT_JSON`
// env var, and the FCM spelling of the two error labels — no WebCrypto or HTTP
// call is spelled out here.
import { bearerAuthHeader } from './notify-http.mjs';
import {
  parseServiceAccount,
  buildGoogleServiceAccountJwt,
  mintGoogleAccessToken,
} from './google-oauth.mjs';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_SERVICE_ACCOUNT_ENV = 'FCM_SERVICE_ACCOUNT_JSON';
const FCM_KEY_LABEL = 'FCM service-account private_key';

// The Firebase project id, derived the way kreait's `Factory::getProjectId()`
// does when no explicit one is configured: the service-account JSON's
// `project_id` field. Returns '' when the blob is absent or unreadable — this
// helper never throws, so the port keeps its own "cannot determine the project
// id" guard (a malformed blob still fails louder at mint time).
export function serviceAccountProjectId(raw) {
  try {
    const projectId = parseServiceAccount(raw).project_id;
    return typeof projectId === 'string' ? projectId : '';
  } catch {
    return '';
  }
}

// Build and sign the RS256 JWT the OAuth2 token endpoint expects.
// Returns { assertion, header, payload } (the latter two base64url segments for
// tests to assert on).
export async function buildServiceAccountJwt(serviceAccount, { now = Math.floor(Date.now() / 1000) } = {}) {
  return buildGoogleServiceAccountJwt(serviceAccount, { scope: FCM_SCOPE, now, keyLabel: FCM_KEY_LABEL });
}

// Mint a short-lived OAuth2 access token for the FCM v1 API. Returns the raw
// `access_token` string. Throws with Google's error on a non-2xx response.
export async function mintFcmAccessToken(env, { now = Math.floor(Date.now() / 1000) } = {}) {
  return mintGoogleAccessToken(env, {
    scope: FCM_SCOPE,
    jsonEnv: FCM_SERVICE_ACCOUNT_ENV,
    now,
    keyLabel: FCM_KEY_LABEL,
    emptyLabel: FCM_SERVICE_ACCOUNT_ENV,
  });
}

// Bearer header helper re-exported for the port's thin handler.
export { bearerAuthHeader };
