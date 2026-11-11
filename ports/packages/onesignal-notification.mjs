// Port: laravel notification OneSignal channel — POST /notify/onesignal.
//
// The `laravel-notification-channels/onesignal` package creates notifications
// via OneSignal's REST API:
//   POST https://api.onesignal.com/notifications
// with header `Authorization: Basic <ONESIGNAL_REST_API_KEY>` (the raw key is
// base64-encoded for HTTP Basic; the API key itself is the username, no
// password) and a JSON body carrying `app_id` plus a targeting field
// (`included_segments`, `include_player_ids`, `include_external_user_ids`, ...)
// and a `contents` map ({ "en": "..." }). This is a plain HTTPS JSON POST —
// 1:1 port of the driver.
//
// Edge disclosure: OneSignal is HTTP-only (the SDK never opens a socket), so
// there is NO algorithmic substitution — only the transport, already `fetch`.
// The only edge constraints are the 50-subrequest/req and CPU limits, both
// irrelevant for a single POST.
//
// Config (env): ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY. Optional
// ONESIGNAL_LANGUAGE (default "en" for the `contents` map key).
// Payload (ctx.body): { to?, player_ids?, external_user_ids?, segments?,
//   included_segments?, title?, subject?, body?, message?, headings?, contents?,
//   data?, url?, ios_badgeType?, ios_badgeCount?, ... }. `to`/`player_ids` map to
//   `include_player_ids`; `external_user_ids` to `include_external_user_ids`;
//   `segments`/`included_segments` to `included_segments`. `body`/`message` map to
//   `contents[lang]`; `title`/`subject` to `headings[lang]`.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  mapProviderResponse,
  jsonPort,
  basicAuthHeader,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const ONESIGNAL_URL = 'https://api.onesignal.com/notifications';

function asArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  // Comma-separated only — OneSignal segment names legitimately contain spaces
  // (e.g. "Subscribed Users"), and player/external ids never contain commas.
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};
  const str = (v) => (typeof v === 'string' ? v : '');

  const appId = env && env.ONESIGNAL_APP_ID;
  const apiKey = env && env.ONESIGNAL_REST_API_KEY;
  if (!appId) return jsonPort({ error: 'missing OneSignal credential: set ONESIGNAL_APP_ID' }, 500);
  if (!apiKey) return jsonPort({ error: 'missing OneSignal credential: set ONESIGNAL_REST_API_KEY' }, 500);

  const lang = str(env && env.ONESIGNAL_LANGUAGE) || 'en';

  // Targeting: OneSignal requires at least one of player ids / external ids /
  // segments. Map the generic `to` plus the channel-specific aliases.
  const playerIds = asArray(raw.to).concat(asArray(raw.player_ids).flatMap((v) => v.split(/[,\s]+/)).filter(Boolean));
  const externalUserIds = asArray(raw.external_user_ids);
  const segments = asArray(raw.segments).concat(asArray(raw.included_segments));

  const payload = {
    app_id: String(appId),
    ...(playerIds.length ? { include_player_ids: playerIds } : {}),
    ...(externalUserIds.length ? { include_external_user_ids: externalUserIds } : {}),
    ...(segments.length ? { included_segments: segments } : {}),
    ...(raw.data ? { data: raw.data } : {}),
    ...(str(raw.url) ? { url: str(raw.url) } : {}),
  };

  // `contents` is a language map; `headings` is the optional title map.
  if (raw.contents && typeof raw.contents === 'object') {
    payload.contents = raw.contents;
  } else {
    const message = str(raw.body) || str(raw.message) || str(raw.content) || '';
    if (!message) return jsonPort({ error: 'onesignal notification requires `body` (message text)' }, 422);
    payload.contents = { [lang]: message };
  }
  if (raw.headings && typeof raw.headings === 'object') {
    payload.headings = raw.headings;
  } else if (str(raw.title) || str(raw.subject)) {
    payload.headings = { [lang]: str(raw.title) || str(raw.subject) };
  }

  if (!playerIds.length && !externalUserIds.length && !segments.length) {
    return jsonPort({ error: 'onesignal notification requires a target: `to`/`player_ids`, `external_user_ids`, or `segments`' }, 422);
  }

  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/json',
      // OneSignal HTTP Basic: the REST API key is the username, no password.
      'authorization': basicAuthHeader(apiKey, ''),
    },
    body: JSON.stringify(payload),
  };

  try {
    const resp = await resolveFetch(env)(ONESIGNAL_URL, init);
    const mapped = await mapProviderResponse(resp);
    // OneSignal returns 200 with { id, recipients, ... } on success and a 4xx
    // with { errors: [...] } on failure; surface verbatim.
    return { status: mapped.status, headers: mapped.headers, body: mapped.body };
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}
