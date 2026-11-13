// Port: laravel/mail Mailgun driver — POST /notify/mailgun.
//
// Laravel's Mailgun transport (`Symfony MailgunMailer` used by `MAIL_MAILER=
// mailgun`) sends via the Mailgun HTTP API:
//   POST https://api.mailgun.net/v3/{domain}/messages
// with HTTP Basic auth (`api:SECRET`) and a `multipart/form-data` body carrying
// from/to/subject/text-or-html. SMTP is Laravel's default mail path, but the
// Mailgun *driver* is already HTTP — so this is a 1:1 port of the driver, not a
// substitution of it.
//
// Edge disclosure: Laravel's default SMTP transport (a raw socket to :25/:587)
// is impossible on Workers. This port uses the Mailgun HTTP API driver, which is
// the documented substitute for the same provider — disclosed as
// SMTP-socket → Mailgun-HTTP-API. Multipart/form is used (not JSON) to match the
// driver and to allow attachments later.
//
// Config (env): MAILGUN_DOMAIN, MAILGUN_SECRET. Optional MAILGUN_ENDPOINT
// (default api.mailgun.net; set to api.eu.mailgun.net for EU).
// Payload (ctx.body): { to, subject, body (text), html?, from? }.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  basicAuthHeader,
  multipartForm,
  normalisePayload,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const payload = normalisePayload(ctx);
  if (!payload.ok) return jsonPort({ error: payload.reason }, 422);

  const domain = env && env.MAILGUN_DOMAIN;
  const secret = env && env.MAILGUN_SECRET;
  if (!domain || !secret) return jsonPort({ error: 'missing Mailgun credential: set MAILGUN_DOMAIN and MAILGUN_SECRET' }, 500);

  const endpoint = (env && env.MAILGUN_ENDPOINT) || 'api.mailgun.net';
  const from = payload.from || `postmaster@${domain}`;
  const html = (ctx && ctx.body && ctx.body.html) || '';

  const url = `https://${endpoint}/v3/${encodeURIComponent(domain)}/messages`;
  const doFetch = resolveFetch(env);
  const form = multipartForm({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.body,
    ...(html ? { html } : {}),
  });
  const init = {
    method: 'POST',
    headers: { 'authorization': basicAuthHeader('api', secret) },
    // Do NOT set content-type by hand — fetch must add the multipart boundary.
    body: form,
  };

  return deliverVia(doFetch, url, init);
}