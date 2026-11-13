// kernel/packages/notify-http.mjs — shared HTTP-driver primitives for the
// notification cluster (Slack, Twilio SMS, Mailgun mail, Postmark mail).
//
// Parity target: each Laravel notification/mail driver that talks to its
// provider over HTTP (Slack's IncomingWebhook/`chat.postMessage`, the
// laravel-notifications Twilio channel's Twilio REST `Messages.json`, Mailgun's
// `/messages` MIME/multipart endpoint, Postmark's `/email`). None of these need
// a persistent socket, so all four port 1:1 to a Workers `fetch` — the only
// edge-impossible path is Laravel's default SMTP mail transport (a raw socket
// to port 25/587), which Workers forbids. The HTTP API drivers are the
// substitute and are disclosed in each handler header.
//
// Every handler in this cluster:
//   1. validates + normalises a notification payload (`to`/`subject`/`body`),
//   2. builds a provider request (auth + body),
//   3. calls `resolveFetch(env)(url, init)`,
//   4. maps the provider `Response` to `{status, headers, body}` via
//      `mapProviderResponse` — the same shape a Worker port returns.

import { jsonResponse } from './port-ctx.mjs';

// Resolve the fetch implementation. Tests inject `env.fetchImpl`; production
// falls back to the Workers/Node global. Never capture `globalThis.fetch` at
// module load — it must be read per call so a test can swap it in.
export function resolveFetch(env) {
  const impl = env && env.fetchImpl ? env.fetchImpl : globalThis.fetch;
  if (typeof impl !== 'function') {
    throw new Error('No fetch implementation available (set env.fetchImpl)');
  }
  return impl;
}

// Map a provider `Response` to the port return shape. Headers become a plain
// lowercase-keyed object; the body stays text (JSON callers re-parse as needed).
// A missing Response (network throw) is normalised by the caller's try/catch.
export async function mapProviderResponse(resp) {
  const headers = {};
  if (resp && resp.headers && typeof resp.headers.forEach === 'function') {
    resp.headers.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value;
    });
  }
  const body = resp && typeof resp.text === 'function' ? await resp.text() : '';
  const status = resp && typeof resp.status === 'number' ? resp.status : 0;
  return { status, headers, body };
}

// Standard `{status,headers,body}` JSON port response — the envelope lives once
// in `jsonResponse` (port-ctx.mjs); this keeps the notify cluster's
// `(body, status)` call shape.
export function jsonPort(body, status = 200) {
  return jsonResponse(status, body);
}

// Perform a provider request and map the response to the port envelope,
// normalising a network throw into a 502 JSON error. Every HTTP notification
// driver ends this way, so the rule lives here once instead of in each driver.
export async function deliverVia(doFetch, url, init) {
  try {
    const resp = await doFetch(url, init);
    return await mapProviderResponse(resp);
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}

// Basic auth header (Twilio REST uses `SID:TOKEN`). btoa is available in
// Workers and Node >= 16.
export function basicAuthHeader(user, pass) {
  const raw = `${String(user)}:${String(pass)}`;
  return `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
}

// Bearer header (Postmark uses `X-Postmark-Server-Token`; Slack bot tokens use
// `Authorization: Bearer xoxb-...`). Kept here so handlers stay thin.
export function bearerAuthHeader(token) {
  return `Bearer ${String(token)}`;
}

// URL-encode a flat object into an `application/x-www-form-urlencoded` body.
// Twilio's REST API accepts this for message creation.
export function formUrlEncoded(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.append(k, String(v));
  }
  return sp.toString();
}

// Build a `multipart/form-data` body (Mailgun `/messages`). Returns the FormData
// and lets fetch set the boundary header; callers must NOT set content-type by
// hand or the boundary is lost.
export function multipartForm(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) fd.append(k, String(item));
    } else {
      fd.append(k, String(v));
    }
  }
  return fd;
}

// Validate + normalise a notification payload. Accepts `to` (required), and
// optional `subject`/`body`. Missing `to` is a 422 — the provider would reject
// it anyway, but we fail before spending a subrequest.
export function normalisePayload(ctx) {
  const raw = (ctx && ctx.body) || {};
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (!to) {
    return { ok: false, reason: "notification payload requires a non-empty 'to'" };
  }
  return {
    ok: true,
    to,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    from: typeof raw.from === 'string' ? raw.from : '',
  };
}

// Validate + normalise an error-tracking payload (Bugsnag, Flare). The report
// carries the caller's `errorClass` plus its stack, every frame coerced to
// `{ file, lineNumber, method }`; a report with no usable stack still carries a
// single `(edge)` frame, so the provider groups it instead of dropping it. The
// rule lives here once — the two error-reporting ports differed only in which
// provider name they wrote in a comment.
export function normaliseErrorReport(ctx) {
  const body = (ctx && ctx.body) || {};
  const errorClass = body.errorClass || body.error_class || '';
  const rawFrames = Array.isArray(body.stacktrace) ? body.stacktrace : [];
  return {
    errorClass,
    stacktrace: rawFrames.length
      ? rawFrames.map(toStackFrame)
      : [{ file: '(edge)', lineNumber: 0, method: errorClass }],
  };
}

// Coerce one caller-supplied frame into `{ file, lineNumber, method }`.
function toStackFrame(frame) {
  if (typeof frame === 'string') {
    return { file: frame, lineNumber: 0, method: '(unknown)' };
  }
  const f = frame || {};
  const line = Number(f.lineNumber ?? f.line);
  return {
    file: f.file || f.filename || '(unknown)',
    lineNumber: Number.isFinite(line) ? line : 0,
    method: f.method || f.function || '(unknown)',
  };
}