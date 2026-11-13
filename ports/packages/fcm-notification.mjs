// Port: kreait/laravel-firebase — FCM v1 HTTP API notification channel.
//
// Laravel's `kreait/laravel-firebase` package exposes the Firebase Cloud
// Messaging v1 HTTP API (`POST /v1/projects/{project}/messages:send`). The v1
// API is a single authenticated HTTPS POST carrying a JSON `message` object and
// a short-lived OAuth2 Bearer token minted from a service account — pure
// `fetch` + WebCrypto, so it ports 1:1 to a Worker.
//
// Edge disclosure: NONE. Signing the service-account JWT (RS256) and the send
// are both native WebCrypto / HTTPS `fetch`. The older legacy `fcm.googleapis.com/fcm/send`
// server-key path is deprecated by Google and NOT ported here — v1 is the
// supported substitute.
//
// Config (env): FCM_SERVICE_ACCOUNT_JSON (raw or base64 service-account JSON),
// FCM_PROJECT_ID (optional; falls back to the service account's `project_id`).
//
// Payload (ctx.body): either a ready FCM v1 `message` object under `message`,
// or convenience fields we assemble into one:
//   { token?|topic?|condition?, notification?: {title, body, ...}, data?: {} }.
// A message with none of token/topic/condition is a 422 — FCM would reject it.
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, jsonPort, deliverVia } from '../../kernel/packages/notify-http.mjs';
import { mintFcmAccessToken } from '../../kernel/packages/fcm-oauth.mjs';

function fcmSendUrl(projectId) {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}

// Assemble a v1 `message` object from convenience fields when the caller did
// not supply a ready `message`. `target` = token | topic | condition.
function buildMessage(raw) {
  if (raw && typeof raw.message === 'object' && raw.message !== null) {
    return raw.message;
  }
  const message = {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const target =
    str(raw.token).trim() ||
    str(raw.to).trim() ||
    str(raw.topic).trim() ||
    str(raw.condition).trim();
  if (str(raw.token).trim() || str(raw.to).trim()) message.token = str(raw.token).trim() || str(raw.to).trim();
  else if (str(raw.topic).trim()) message.topic = str(raw.topic).trim();
  else if (str(raw.condition).trim()) message.condition = str(raw.condition).trim();

  const notification = {};
  if (raw.notification && typeof raw.notification === 'object') {
    Object.assign(notification, raw.notification);
  } else {
    const title = str(raw.title);
    const body = str(raw.body);
    if (title) notification.title = title;
    if (body) notification.body = body;
  }
  if (Object.keys(notification).length) message.notification = notification;
  if (raw.data && typeof raw.data === 'object') message.data = raw.data;
  if (raw.android && typeof raw.android === 'object') message.android = raw.android;
  if (raw.apns && typeof raw.apns === 'object') message.apns = raw.apns;
  if (raw.webpush && typeof raw.webpush === 'object') message.webpush = raw.webpush;
  return message;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};
  const message = buildMessage(raw);

  if (!message.token && !message.topic && !message.condition) {
    return jsonPort({ error: 'FCM message requires a target: set token/to, topic, or condition' }, 422);
  }

  const projectId = (env && env.FCM_PROJECT_ID) || '';
  if (!projectId) {
    return jsonPort({ error: 'missing FCM_PROJECT_ID (set env FCM_PROJECT_ID or derive from the service account)' }, 500);
  }

  let accessToken;
  try {
    accessToken = await mintFcmAccessToken(env);
  } catch (err) {
    return jsonPort({ error: `FCM auth failed: ${String((err && err.message) || err)}` }, 500);
  }

  const doFetch = resolveFetch(env);
  const url = fcmSendUrl(projectId);
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  };

  // FCM v1 returns 200 with a `name` field on success; surface the provider
  // response verbatim so the caller can inspect `name`/error details.
  return deliverVia(doFetch, url, init);
}
