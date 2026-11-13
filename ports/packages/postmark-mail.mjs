// Port: laravel/mail Postmark driver — POST /notify/postmark.
//
// Laravel's Postmark transport (`MAIL_MAILER=postmark`, `wildbit/postmark-php`
// under the hood) sends via the Postmark HTTP API:
//   POST https://api.postmarkapp.com/email
// with header `X-Postmark-Server-Token: {token}` and a JSON body
// { From, To, Subject, TextBody, HtmlBody }. This is a plain HTTPS JSON POST —
// 1:1 port of the driver.
//
// Edge disclosure: Laravel's default SMTP transport (raw socket :25/:587) is
// impossible on Workers. This port uses the Postmark HTTP API, the documented
// substitute — disclosed as SMTP-socket → Postmark-HTTP-API. Postmark requires
// a verified sender signature / domain; `From` must match one.
//
// Config (env): POSTMARK_TOKEN. Optional POSTMARK_FROM (default From fallback).
// Payload (ctx.body): { to, subject, body (text), html?, from? }.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  normalisePayload,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const POSTMARK_URL = 'https://api.postmarkapp.com/email';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const payload = normalisePayload(ctx);
  if (!payload.ok) return jsonPort({ error: payload.reason }, 422);

  const token = env && env.POSTMARK_TOKEN;
  if (!token) return jsonPort({ error: 'missing Postmark credential: set POSTMARK_TOKEN' }, 500);

  const from = payload.from || (env && env.POSTMARK_FROM) || '';
  if (!from) return jsonPort({ error: 'missing Postmark sender: set POSTMARK_FROM or pass `from`' }, 422);

  const html = (ctx && ctx.body && ctx.body.html) || '';
  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      'x-postmark-server-token': String(token),
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      From: from,
      To: payload.to,
      Subject: payload.subject,
      TextBody: payload.body,
      ...(html ? { HtmlBody: html } : {}),
      MessageStream: (env && env.POSTMARK_STREAM) || 'outbound',
    }),
  };

  return deliverVia(doFetch, POSTMARK_URL, init);
}