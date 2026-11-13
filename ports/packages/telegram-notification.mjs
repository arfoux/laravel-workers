// Port: laravel-notification-channels/telegram — Telegram Notification Channel
// (POST /notify/telegram).
//
// Parity target: the `laravel-notification-channels/telegram` package's
// `Telegram::sendMessage()` call. The package builds a Guzzle POST to
// `https://api.telegram.org/bot{TOKEN}/sendMessage` with a JSON body
// `{chat_id, text, parse_mode?, reply_markup?}` — a plain HTTPS call with the
// token carried in the URL path, so it ports 1:1 to a Workers `fetch`. No
// socket, no long-running work, no algorithmic substitution: only the
// transport, which was already HTTP.
//
// Edge disclosure: the Telegram Bot API is HTTP-only, so the port is a direct
// transport swap (Guzzle → `fetch`). The only edge constraints are the
// 50-subrequest/req and CPU limits, both irrelevant for a single sendMessage.
//
// Config (env): TELEGRAM_BOT_TOKEN (required — the bot token from @BotFather).
//
// Payload (ctx.body): { to|chat_id, body|text, parse_mode?, keyboard? }.
//   - `to` is accepted for parity with the generic notification shape and is
//     used as the target `chat_id` (overrides `chat_id` when both present).
//   - `body`/`text` are the message text (`text` is Telegram's canonical field).
//   - `parse_mode` passes through verbatim (e.g. `Markdown`, `MarkdownV2`,
//     `HTML`) — the package exposes it as the message's `parseMode`.
//   - `keyboard` is the inline keyboard; it maps to Telegram's `reply_markup`.
//     Accept either an object `{inline_keyboard: [[{text,url}...]]}` (passed
//     through verbatim) or an array of button rows (wrapped as
//     `{inline_keyboard: rows}`). A raw array of button-label strings is also
//     accepted (each string becomes `{text: label}` in a single row) for the
//     common Laravel `Keyboard::button([...])` shape.
// Provider response is mapped 1:1 to {status, headers, body} — the caller
// inspects Telegram's `{"ok":true/false,...}` envelope.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Normalise the payload. `chat_id` is required (Telegram rejects a sendMessage
// without a target), so we fail with a 422 before spending a subrequest.
function readTelegramPayload(ctx) {
  const raw = (ctx && ctx.body) || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const chatIdRaw = raw.to !== undefined ? raw.to : raw.chat_id;
  const chatId =
    typeof chatIdRaw === 'string' ? chatIdRaw.trim() : chatIdRaw;
  if (chatId === undefined || chatId === null || chatId === '') {
    return { ok: false, reason: 'telegram sendMessage requires a chat_id (set `to`/`chat_id`)' };
  }
  return {
    ok: true,
    chatId,
    text: str(raw.text) || str(raw.body),
    parseMode: str(raw.parse_mode),
    keyboard: raw.keyboard,
  };
}

// Map the payload's `keyboard` to Telegram's `reply_markup` object.
function buildReplyMarkup(keyboard) {
  if (!keyboard) return null;
  if (Array.isArray(keyboard)) {
    // Array of rows. Each row is either an array of buttons/labels or a bare label.
    const rows = keyboard.map((row) =>
      Array.isArray(row)
        ? row.map((btn) => (typeof btn === 'string' ? { text: btn } : btn))
        : [typeof row === 'string' ? { text: row } : row],
    );
    return { inline_keyboard: rows };
  }
  if (typeof keyboard === 'object') {
    // Object form: assume it is already a reply_markup shape (e.g.
    // `{inline_keyboard: [...]}`); pass through verbatim.
    return keyboard;
  }
  return null;
}

// Telegram Bot API sendMessage endpoint. The token is carried in the URL path,
// so there is no separate auth header.
export function telegramSendUrl(token) {
  return `https://api.telegram.org/bot${String(token)}/sendMessage`;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const payload = readTelegramPayload(ctx);
  if (!payload.ok) {
    return jsonPort({ error: payload.reason }, 422);
  }

  const token = env && env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return jsonPort({ error: 'missing Telegram credential: set TELEGRAM_BOT_TOKEN' }, 500);
  }

  const replyMarkup = buildReplyMarkup(payload.keyboard);
  const body = {
    chat_id: payload.chatId,
    text: payload.text,
    ...(payload.parseMode ? { parse_mode: payload.parseMode } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  const doFetch = resolveFetch(env);
  const url = telegramSendUrl(token);
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };

  // Telegram returns 200 with {"ok":false,...} on app-level errors; surface
  // that verbatim — the caller inspects `ok`.
  return deliverVia(doFetch, url, init);
}
