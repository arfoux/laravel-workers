// Port: twilio/sdk (laravel-notifications Twilio channel) — POST /notify/twilio.
//
// Laravel's Twilio notification channel (`laravel-notification-channels/twilio`
// backed by `twilio/sdk`) sends SMS by POSTing to the Twilio REST API:
//   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
// with HTTP Basic auth (`SID:TOKEN`) and an `application/x-www-form-urlencoded`
// body (`To`, `From`, `Body`). The PHP SDK wraps exactly this REST call. There
// is no socket, no streaming and no local compute — it is a single HTTPS fetch,
// so it ports 1:1.
//
// Edge disclosure: no algorithmic substitution. The only thing dropped is the
// PHP SDK's helper wrappers (media/MMS helper objects, status-callback polling
// objects) — this port sends the plain SMS/MMS message create, which is what the
// notification channel actually does. Long-polling delivery receipts (a separate
// Twilio webhook) are out of scope of a send.
//
// Config (env): TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM.
// Payload (ctx.body): { to, body|text, from? }. `from` overrides TWILIO_FROM.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  basicAuthHeader,
  formUrlEncoded,
  normalisePayload,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const payload = normalisePayload(ctx);
  if (!payload.ok) return jsonPort({ error: payload.reason }, 422);

  const sid = env && env.TWILIO_SID;
  const token = env && env.TWILIO_TOKEN;
  const from = (ctx && ctx.body && ctx.body.from) || payload.from || (env && env.TWILIO_FROM) || '';
  const body = payload.body || payload.subject;

  if (!sid || !token) return jsonPort({ error: 'missing Twilio credential: set TWILIO_SID and TWILIO_TOKEN' }, 500);
  if (!from) return jsonPort({ error: 'missing Twilio sender: set TWILIO_FROM or pass `from`' }, 422);
  if (!body) return jsonPort({ error: "notification payload requires a non-empty 'body'" }, 422);

  const url = `${TWILIO_BASE}/${encodeURIComponent(sid)}/Messages.json`;
  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      'authorization': basicAuthHeader(sid, token),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: formUrlEncoded({ To: payload.to, From: from, Body: body }),
  };

  return deliverVia(doFetch, url, init);
}