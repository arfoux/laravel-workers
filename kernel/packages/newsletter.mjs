// kernel/packages/newsletter.mjs — spatie/laravel-newsletter port (Mailchimp).
//
// Parity target: `spatie/laravel-newsletter` drives Mailchimp's Marketing REST
// API (the `drewm/mailchimp-api` client under the hood). It is a thin HTTP
// driver: every operation is one JSON request to
//   https://{serverPrefix}.api.mailchimp.com/3.0/lists/{listId}/members[/hash]
// authenticated with HTTP Basic where the username is the raw API key and the
// password is EMPTY:
//   Authorization: Basic base64(apikey:)
// (Mailchimp's documented "apikey:" scheme — password after the colon is blank.)
//
// The three operations the package's public API maps to, all over one endpoint:
//   subscribe(listId, email, {apiKey, serverPrefix, firstName, lastName})
//       -> POST /3.0/lists/{listId}/members      (status: "subscribed")
//   unsubscribe(listId, email, {apiKey, serverPrefix})
//       -> PUT  /3.0/lists/{listId}/members/{hash} (status: "unsubscribed")
//   isSubscribed(listId, email, {apiKey, serverPrefix})
//       -> GET /3.0/lists/{listId}/members/{hash}  -> status === "subscribed"
// The subscriber `hash` is the lowercase MD5 of the email — the same
// `md5(strtolower($email))` the package computes (via kernel/digest.mjs).
//
// Edge disclosure: none — a plain HTTPS JSON API, a 1:1 port. Not ported: the
// async queue driver and the local `newsletter_subscribers` table (an Eloquent/
// D1 concern, out of scope for the HTTP driver).
//
// `subscribe`/`unsubscribe`/`isSubscribed` are the named primitives. The
// default export is a route-port handler (port-ctx contract) dispatching on
// `ctx.body.action`, so the same driver is callable as a Worker route. Provider
// responses are mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  mapProviderResponse,
  jsonPort,
  basicAuthHeader,
} from './notify-http.mjs';
import { normalizePortCtx } from './port-ctx.mjs';
import { md5Hex } from '../digest.mjs';

function baseUrl(serverPrefix) {
  return `https://${serverPrefix}.api.mailchimp.com/3.0`;
}

// Mailchimp scheme: Basic base64(apikey:) — empty password after the colon.
function authHeader(apiKey) {
  return basicAuthHeader(String(apiKey), '');
}

// Lowercase MD5 hex of the email — the subscriber hash Mailchimp expects in the
// path. Same `md5(strtolower($email))` the package computes, via the repo's
// PHP-compatible MD5 (kernel/digest.mjs); WebCrypto exposes no MD5.
function subscriberHash(email) {
  return md5Hex(String(email).toLowerCase());
}

function requireCredentials(opts, env) {
  const o = opts || {};
  const apiKey = (typeof o.apiKey === 'string' && o.apiKey) || (env && env.MAILCHIMP_API_KEY);
  const serverPrefix =
    (typeof o.serverPrefix === 'string' && o.serverPrefix) || (env && env.MAILCHIMP_SERVER_PREFIX);
  return { apiKey, serverPrefix };
}

async function callMailchimp(url, init, env) {
  const doFetch = resolveFetch(env);
  const resp = await doFetch(url, init);
  return mapProviderResponse(resp);
}

function baseInit(apiKey, method, extraHeaders) {
  return {
    method,
    headers: {
      authorization: authHeader(apiKey),
      'content-type': 'application/json',
      accept: 'application/json',
      ...(extraHeaders || {}),
    },
  };
}

export async function subscribe(listId, email, opts = {}, env = {}) {
  const { apiKey, serverPrefix } = requireCredentials(opts, env);
  if (!apiKey) return jsonPort({ error: 'missing Mailchimp credential: set apiKey or MAILCHIMP_API_KEY' }, 500);
  if (!serverPrefix) return jsonPort({ error: 'missing Mailchimp server prefix: set serverPrefix or MAILCHIMP_SERVER_PREFIX' }, 500);

  const url = `${baseUrl(serverPrefix)}/lists/${encodeURIComponent(listId)}/members`;
  const body = { email_address: email, status: 'subscribed' };
  const merge = {};
  if (typeof opts.firstName === 'string' && opts.firstName) merge.FNAME = opts.firstName;
  if (typeof opts.lastName === 'string' && opts.lastName) merge.LNAME = opts.lastName;
  if (Object.keys(merge).length) body.merge_fields = merge;

  const init = { ...baseInit(apiKey, 'POST'), body: JSON.stringify(body) };
  try {
    const mapped = await callMailchimp(url, init, env);
    return { status: mapped.status, headers: mapped.headers, body: mapped.body };
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}

export async function unsubscribe(listId, email, opts = {}, env = {}) {
  const { apiKey, serverPrefix } = requireCredentials(opts, env);
  if (!apiKey) return jsonPort({ error: 'missing Mailchimp credential: set apiKey or MAILCHIMP_API_KEY' }, 500);
  if (!serverPrefix) return jsonPort({ error: 'missing Mailchimp server prefix: set serverPrefix or MAILCHIMP_SERVER_PREFIX' }, 500);

  const hash = subscriberHash(email);
  const url = `${baseUrl(serverPrefix)}/lists/${encodeURIComponent(listId)}/members/${hash}`;
  const init = { ...baseInit(apiKey, 'PUT'), body: JSON.stringify({ status: 'unsubscribed' }) };
  try {
    const mapped = await callMailchimp(url, init, env);
    return { status: mapped.status, headers: mapped.headers, body: mapped.body };
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}

export async function isSubscribed(listId, email, opts = {}, env = {}) {
  const { apiKey, serverPrefix } = requireCredentials(opts, env);
  if (!apiKey) return jsonPort({ error: 'missing Mailchimp credential: set apiKey or MAILCHIMP_API_KEY' }, 500);
  if (!serverPrefix) return jsonPort({ error: 'missing Mailchimp server prefix: set serverPrefix or MAILCHIMP_SERVER_PREFIX' }, 500);

  const hash = subscriberHash(email);
  const url = `${baseUrl(serverPrefix)}/lists/${encodeURIComponent(listId)}/members/${hash}`;
  const init = baseInit(apiKey, 'GET');
  try {
    const mapped = await callMailchimp(url, init, env);
    let parsed = {};
    try {
      parsed = mapped.body ? JSON.parse(mapped.body) : {};
    } catch {
      parsed = {};
    }
    const status = typeof parsed.status === 'string' ? parsed.status : '';
    return jsonPort({ subscribed: status === 'subscribed', status }, 200);
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}

// Route-port wrapper (port-ctx contract). ctx.body carries:
// { action?, listId, email, apiKey?, serverPrefix?, firstName?, lastName? }.
// Credentials fall back to env MAILCHIMP_API_KEY / MAILCHIMP_SERVER_PREFIX.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};

  const action = typeof raw.action === 'string' ? raw.action : 'subscribe';
  const listId = typeof raw.listId === 'string' ? raw.listId.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';

  if (!listId) return jsonPort({ error: "newsletter payload requires a non-empty 'listId'" }, 422);
  if (!email) return jsonPort({ error: "newsletter payload requires a non-empty 'email'" }, 422);

  const opts = {
    apiKey: raw.apiKey,
    serverPrefix: raw.serverPrefix,
    firstName: raw.firstName,
    lastName: raw.lastName,
  };

  if (action === 'subscribe') return subscribe(listId, email, opts, env || {});
  if (action === 'unsubscribe') return unsubscribe(listId, email, opts, env || {});
  if (action === 'isSubscribed') return isSubscribed(listId, email, opts, env || {});
  return jsonPort({ error: `unknown newsletter action: ${action}` }, 422);
}
