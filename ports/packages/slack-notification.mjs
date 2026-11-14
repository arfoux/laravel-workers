// Port: laravel/slack — Slack Notification Channel (POST /notify/slack).
//
// Laravel ships two Slack paths: the Incoming Webhook (POST the JSON message
// straight to a `https://hooks.slack.com/services/...` URL) and the full Slack
// Web API (`chat.postMessage` with a bot token). Both are plain HTTPS `fetch`,
// so they port 1:1 to a Worker — no socket, no long-running work. The package
// also renders Block Kit / attachments client-side; that rendering is pure JSON
// and is preserved here as a pass-through `blocks`/`attachments` field.
//
// Edge disclosure: Laravel's `Slack` channel itself is HTTP-only (it never opens
// SMTP), so there is NO algorithmic substitution here — only the transport,
// which is already `fetch`. The only edge constraint is the 50-subrequest/req
// and CPU limits, both irrelevant for a single webhook POST.
//
// Config (env): SLACK_WEBHOOK_URL (Incoming Webhook) OR SLACK_BOT_TOKEN +
// SLACK_CHANNEL (Web API `chat.postMessage`). Webhook wins when both set.
//
// Payload (ctx.body): { to?, text?, body?, blocks?, attachments?, channel? }.
//   `to` is accepted for parity with the generic notification shape; when
//   present it is used as the target channel (overrides `channel`).
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  bearerAuthHeader,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Slack has NO required address: an Incoming Webhook needs no channel at all,
// and the bot path falls back to SLACK_CHANNEL. So unlike the address-based
// drivers (Twilio number, Mailgun/Postmark email) we read the payload laxly —
// a missing `to`/channel is not itself an error here.
function readSlackPayload(ctx) {
  const raw = (ctx && ctx.body) || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    to: str(raw.to).trim(),
    channel: str(raw.channel).trim(),
    text: str(raw.text),
    body: str(raw.body),
    subject: str(raw.subject),
    blocks: raw.blocks,
    attachments: raw.attachments,
  };
}

// Slack Web API base. Incoming Webhook URL is used verbatim (it is tenant-
// specific), so it is not joined onto this base.
const SLACK_API = 'https://slack.com/api/chat.postMessage';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const payload = readSlackPayload(ctx);

  const webhookUrl = env && env.SLACK_WEBHOOK_URL;
  const botToken = env && env.SLACK_BOT_TOKEN;
  const channel = payload.to || payload.channel || (env && env.SLACK_CHANNEL) || '';
  // `text` is the canonical Slack field; accept `body`/`subject` as generic aliases.
  const text = payload.text || payload.body || payload.subject || '';

  const doFetch = resolveFetch(env);
  let url;
  const init = { method: 'POST', headers: {} };

  if (webhookUrl) {
    // Incoming Webhook: no auth header, the URL itself carries the secret.
    url = webhookUrl;
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify({
      text,
      ...(channel ? { channel } : {}),
      ...(payload.blocks ? { blocks: payload.blocks } : {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
    });
  } else if (botToken) {
    // Web API: bearer bot token + explicit channel required.
    if (!channel) return jsonPort({ error: 'chat.postMessage requires a channel (set `to`/`channel` or SLACK_CHANNEL)' }, 422);
    url = SLACK_API;
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.headers['authorization'] = bearerAuthHeader(botToken);
    init.body = JSON.stringify({
      channel,
      text,
      ...(payload.blocks ? { blocks: payload.blocks } : {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
    });
  } else {
    return jsonPort({ error: 'missing Slack credential: set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN' }, 500);
  }

  // Slack returns 200 with {"ok":false,...} on app-level errors; surface that
  // verbatim — the caller inspects `ok`.
  return deliverVia(doFetch, url, init);
}