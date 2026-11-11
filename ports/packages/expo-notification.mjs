// Port: laravel notification Expo push channel — POST /notify/expo.
//
// The `laravel-notification-channels/expo` package (and Expo's own SDK) sends
// push via Expo's push service:
//   POST https://exp.host/--/api/v2/push/send
// with a JSON body { to: [ExpoPushToken,...], title?, body?, data?, ... } and an
// OPTIONAL `Authorization: Bearer <EXPO_ACCESS_TOKEN>` (auth raises the rate
// limit; it is not required to send). This is a plain HTTPS JSON POST — 1:1
// port of the driver.
//
// Edge disclosure: Expo push is HTTP-only (the SDK never opens a socket), so
// there is NO algorithmic substitution — only the transport, already `fetch`.
// The only edge constraints are the 50-subrequest/req and CPU limits, both
// irrelevant for a single push POST. ExpoPushTokens (`ExponentPushToken[...]`)
// are obtained client-side; this port only relays them.
//
// Config (env): EXPO_ACCESS_TOKEN (optional; sent as a Bearer header when set).
// Payload (ctx.body): { to (token|string|array, required), title?, subject?,
//   body?, message?, data?, sound?, badge?, channelId?, ttl?, expiration?,
//   priority?, collapseId?, mutableContent? }.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  mapProviderResponse,
  jsonPort,
  bearerAuthHeader,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';

// Normalise the `to` field to the array Expo's API expects. A single token,
// a comma separated string, or an array are all accepted. Comma-only split —
// an ExpoPushToken (`ExponentPushToken[...]`) never contains a comma.
function toTokenArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const raw = (ctx && ctx.body) || {};
  const str = (v) => (typeof v === 'string' ? v : '');

  const to = toTokenArray(raw.to);
  if (to.length === 0) {
    return jsonPort({ error: 'expo push requires `to` (one or more ExpoPushToken)' }, 422);
  }
  // `body` is the canonical Expo message field; accept generic aliases.
  const body = str(raw.body) || str(raw.message) || str(raw.content) || '';
  if (!body) {
    return jsonPort({ error: 'expo push requires `body` (message text)' }, 422);
  }

  const accessToken = env && env.EXPO_ACCESS_TOKEN;

  const payload = {
    to,
    body,
    ...(str(raw.title) || str(raw.subject) ? { title: str(raw.title) || str(raw.subject) } : {}),
    ...(raw.data ? { data: raw.data } : {}),
    ...(raw.sound ? { sound: raw.sound } : {}),
    ...(raw.badge !== undefined ? { badge: raw.badge } : {}),
    ...(raw.channelId ? { channelId: raw.channelId } : {}),
    ...(raw.ttl !== undefined ? { ttl: raw.ttl } : {}),
    ...(raw.expiration !== undefined ? { expiration: raw.expiration } : {}),
    ...(raw.priority ? { priority: raw.priority } : {}),
    ...(raw.collapseId ? { collapseId: raw.collapseId } : {}),
    ...(raw.mutableContent !== undefined ? { mutableContent: !!raw.mutableContent } : {}),
  };

  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(payload),
  };
  // Auth is optional for Expo push; send a Bearer header only when configured.
  if (accessToken) init.headers['authorization'] = bearerAuthHeader(accessToken);

  try {
    const resp = await resolveFetch(env)(EXPO_SEND, init);
    const mapped = await mapProviderResponse(resp);
    // Expo returns 200 with { data: [...], errors?: [...] }; surface verbatim —
    // the caller inspects `data`/`errors` per receipt.
    return { status: mapped.status, headers: mapped.headers, body: mapped.body };
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 502);
  }
}
