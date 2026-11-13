// kernel/packages/mailcoach-mailer.mjs — port of the Mailcoach transactional-mail
// HTTP API (the transport behind spatie/laravel-mailcoach-mailer).
//
// Parity target: Laravel's Mailcoach mailer sends transactional email through
// Mailcoach's HTTP API:
//   POST https://{mailcoach-domain}/api/transactional-mails/send
// with header `Authorization: Bearer {token}` (+ `Accept: application/json`) and
// a JSON body. Documented body fields (mailcoach.app API docs, "Transactional
// emails"):
//   mail_name    — the transactional email's name; required when `html` is absent
//   html         — inline HTML body (use instead of / on top of a template)
//   subject      — the subject line
//   from / to / cc / bcc — addresses; comma-delimited or `Name <email>` form
//   replacements — key-value map filling `::key::` replacers in a template
//   store        — default true; false skips the transactional-mail log
//   fake         — true = log only, don't actually deliver (Mailtrap-style)
// This is a plain HTTPS JSON POST — 1:1 port. No socket is involved, so unlike
// SMTP it runs natively on Workers; nothing here is edge-impossible.
//
// Reuses the notify-http primitives (resolveFetch / mapProviderResponse /
// bearerAuthHeader / jsonPort) so this driver behaves identically to the rest of
// the notification/HTTP-driver cluster.
//
// The contract-facing entry point is `sendMail({template, replacing, to, subject,
// html, token, baseUrl})`:
//   template  -> Mailcoach `mail_name`     replacing -> Mailcoach `replacements`
//   token     -> Bearer token              baseUrl   -> Mailcoach domain/origin
// `handle(ctx, env)` (the route port) parses a request `ctx` into those params,
// falling back to `env.MAILCOACH_TOKEN` / `env.MAILCOACH_BASE_URL` for the
// credentials, and returns the provider response mapped 1:1 to
// `{status, headers, body}`.

import {
  resolveFetch,
  jsonPort,
  deliverVia,
  bearerAuthHeader,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

/** Build the `/api/transactional-mails/send` endpoint from a domain or origin.
 * Accepts either a bare domain (`mailcoach.example.com`) or a full origin
 * (`https://mailcoach.example.com`); a scheme is assumed https when omitted.
 * Returns '' when no base URL is given. */
export function buildEndpoint(baseUrl) {
  const raw = String(baseUrl == null ? '' : baseUrl).trim();
  if (!raw) return '';
  const noTrail = raw.replace(/\/+$/, '');
  const origin = /^https?:\/\//i.test(noTrail) ? noTrail : `https://${noTrail}`;
  return `${origin}/api/transactional-mails/send`;
}

/** Map the port's params onto the Mailcoach `send` request body. Only defined
 * fields are included, so a template-only send omits `html` and vice-versa. */
export function buildMailcoachBody({
  template,
  replacing,
  to,
  subject,
  html,
  from,
  cc,
  bcc,
  store,
  fake,
} = {}) {
  const body = {};
  if (template != null && template !== '') body.mail_name = template;
  if (to != null && to !== '') body.to = to;
  if (subject != null && subject !== '') body.subject = subject;
  if (html != null && html !== '') body.html = html;
  if (from != null && from !== '') body.from = from;
  if (cc != null && cc !== '') body.cc = cc;
  if (bcc != null && bcc !== '') body.bcc = bcc;
  if (replacing != null) body.replacements = replacing;
  if (store != null) body.store = store;
  if (fake != null) body.fake = fake;
  return body;
}

/** Send a transactional mail via Mailcoach's API and return the provider
 * response mapped to `{status, headers, body}`. Guards fail before spending a
 * subrequest: missing token/baseUrl -> 500, missing `to` or a body-less send
 * (neither `template` nor `html`) -> 422. */
export async function sendMail(params, env = {}) {
  const {
    template,
    replacing,
    to,
    subject,
    html,
    from,
    cc,
    bcc,
    token,
    baseUrl,
  } = params || {};

  if (!token) {
    return jsonPort(
      { error: 'missing Mailcoach credential: set MAILCOACH_TOKEN or pass `token`' },
      500,
    );
  }
  const endpoint = buildEndpoint(baseUrl);
  if (!endpoint) {
    return jsonPort(
      { error: 'missing Mailcoach base URL: set MAILCOACH_BASE_URL or pass `baseUrl`' },
      500,
    );
  }
  if (to == null || String(to).trim() === '') {
    return jsonPort({ error: "mailcoach mail payload requires a non-empty 'to'" }, 422);
  }
  if ((template == null || template === '') && (html == null || html === '')) {
    return jsonPort(
      { error: 'mailcoach requires `template` (mail_name) or `html` to send' },
      422,
    );
  }

  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      authorization: bearerAuthHeader(token),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(
      buildMailcoachBody({ template, replacing, to, subject, html, from, cc, bcc }),
    ),
  };

  return deliverVia(doFetch, endpoint, init);
}

/** Route port: parse a request `ctx` into `sendMail` params and send.
 * Credentials come from the body (`token`/`baseUrl`) or the env bindings
 * (`MAILCOACH_TOKEN` / `MAILCOACH_BASE_URL`). */
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const b = (ctx && ctx.body) || {};
  return sendMail(
    {
      template: b.template,
      replacing: b.replacing,
      to: b.to,
      subject: b.subject,
      html: b.html,
      from: b.from,
      cc: b.cc,
      bcc: b.bcc,
      token: b.token || (env && env.MAILCOACH_TOKEN),
      baseUrl:
        b.baseUrl || (env && (env.MAILCOACH_BASE_URL || env.MAILCOACH_HOST)),
    },
    env,
  );
}
