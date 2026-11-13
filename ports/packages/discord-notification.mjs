// Port: laravel notification Discord channel — POST /notify/discord.
//
// The `laravel-notification-channels/discord` package ships two paths, mirroring
// Slack's: an Incoming Webhook (POST the JSON message straight to a
// `https://discord.com/api/webhooks/{id}/{token}` URL — the secret is in the URL,
// no auth header) and the full Bot API (`POST /api/channels/{channel.id}/messages`
// with `Authorization: Bot <token>`). Both are plain HTTPS `fetch`, so they port
// 1:1 to a Worker — no socket, no long-running work. Embeds are rendered
// client-side as pure JSON and pass through verbatim.
//
// Edge disclosure: the Discord channel is HTTP-only (it never opens a socket),
// so there is NO algorithmic substitution — only the transport, which is already
// `fetch`. The only edge constraints are the 50-subrequest/req and CPU limits,
// both irrelevant for a single webhook/bot POST.
//
// Config (env): DISCORD_WEBHOOK_URL (Incoming Webhook) OR DISCORD_BOT_TOKEN
// (+ channel via payload `to`/`channel` or DISCORD_CHANNEL). Webhook wins when
// both set.
//
// Payload (ctx.body): { to?, channel?, content?, text?, body?, embeds?, tts?,
//   allowed_mentions? }. `content` is the canonical Discord message field;
//   `text`/`body`/`message` are accepted as generic aliases. The bot path
//   requires a channel id (`to`/`channel` or DISCORD_CHANNEL). The webhook path
//   needs no channel at all.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Discord Bot API `create message` endpoint. The webhook URL is used verbatim
// (it is tenant-specific), so it is not joined onto this base.
const DISCORD_CHANNEL_MESSAGES = 'https://discord.com/api/channels';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};
  const str = (v) => (typeof v === 'string' ? v : '');

  const webhookUrl = env && env.DISCORD_WEBHOOK_URL;
  const botToken = env && env.DISCORD_BOT_TOKEN;
  const channel = str(raw.to).trim() || str(raw.channel).trim() || str(env && env.DISCORD_CHANNEL).trim();
  // `content` is the canonical Discord field; accept generic aliases.
  const content = str(raw.content) || str(raw.text) || str(raw.body) || str(raw.message) || '';
  // Discord requires at least one of content/embeds/file — we carry the two
  // JSON ones; fail before spending a subrequest if the message would be empty.
  const embeds = Array.isArray(raw.embeds) ? raw.embeds : undefined;
  if (!content && !embeds) {
    return jsonPort({ error: 'discord message requires `content` (or `embeds`)' }, 422);
  }

  const doFetch = resolveFetch(env);
  let url;
  const init = { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' } };

  const body = {
    ...(content ? { content } : {}),
    ...(embeds ? { embeds } : {}),
    ...(raw.tts !== undefined ? { tts: !!raw.tts } : {}),
    ...(raw.allowed_mentions ? { allowed_mentions: raw.allowed_mentions } : {}),
  };

  if (webhookUrl) {
    // Incoming Webhook: no auth header — the URL itself carries the secret.
    url = webhookUrl;
    // A webhook may target a thread; a bot needs an explicit channel id.
    if (channel) body.thread_id = channel;
    init.body = JSON.stringify(body);
  } else if (botToken) {
    // Bot API: `Authorization: Bot <token>` + explicit channel id required.
    if (!channel) {
      return jsonPort({ error: 'bot messages require a channel id (set `to`/`channel` or DISCORD_CHANNEL)' }, 422);
    }
    url = `${DISCORD_CHANNEL_MESSAGES}/${encodeURIComponent(channel)}/messages`;
    init.headers['authorization'] = `Bot ${String(botToken)}`;
    init.body = JSON.stringify(body);
  } else {
    return jsonPort({ error: 'missing Discord credential: set DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN' }, 500);
  }

  // Discord returns 200/204 with an app-level error body on failure; surface
  // the provider response verbatim — the caller inspects `status`/body.
  return deliverVia(doFetch, url, init);
}
