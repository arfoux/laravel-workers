// ports/packages/pusher.mjs — pusher/pusher-php-server (v7.3.0) port.
//
// Two halves of the SDK, both reproducible on the edge:
//
// 1. Channel auth — `POST /broadcasting/auth`
//      body: socket_id, channel_name
//      → `{auth}` (private) / `{auth, channel_data}` (presence) signed with
//        HMAC-SHA256 (WebCrypto). The user id embedded in a presence
//        `channel_data` comes from the platform guard, never the request body
//        (the SDK's `presence_auth()` is handed `$user->getAuthIdentifier()`).
//    This is the `Pusher::socket_auth()` / `presence_auth()` half.
//
// 2. Event trigger — `POST /broadcast` (this port's trigger route)
//      body: { channel, name, data }
//      → signed query string + `fetch` to Pusher REST
//        `POST https://api-{cluster}.pusher.com/apps/{app_id}/events?{auth}`.
//    This is the `Pusher::trigger()` half.
//
// Secrets (worker env): PUSHER_KEY, PUSHER_SECRET, PUSHER_APP_ID, PUSHER_CLUSTER.
//
// Substitutions (disclosed):
//   - PHP SDK's guzzle → global `fetch` (injectable `fetchImpl` in tests).
//   - The SDK's synchronous WebCrypto-less HMAC → async WebCrypto HMAC-SHA256
//     (byte-identical output; verified against node:crypto in tests).
//
// D1 (optional): records every trigger in `pusher_events` for the free-tier
// budget dashboard. `ensureSchema` is idempotent.
//
// Free-tier: auth = 0 subrequests (pure HMAC). trigger = 1 subrequest.
// 50 subrequests/req is only reachable if a single request fans out 50 triggers,
// which the SDK's `triggerBatch` maps 1:1 onto and this port preserves.

import {
  isPrivateChannel,
  signChannelAuth,
  buildAuthQueryString,
} from '../../kernel/packages/broadcast.mjs';
import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS pusher_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}

function pusherConfig(env) {
  const key = env.PUSHER_KEY;
  const secret = env.PUSHER_SECRET;
  const appId = env.PUSHER_APP_ID;
  const cluster = env.PUSHER_CLUSTER || 'mt1';
  if (!key || !secret || !appId) {
    throw new Error('PUSHER_KEY / PUSHER_SECRET / PUSHER_APP_ID not configured');
  }
  return { key, secret, appId, cluster };
}

// ── Channel auth (`POST /broadcasting/auth`) ─────────────────────────────────
// Laravel's `Broadcast::routes()` registers this as a plain POST; the compiled
// rung answers it and WebCrypto signs the token. Returns Echo's expected body
// `{ auth }` for private channels, `{ auth, channel_data }` for presence.
export async function handleBroadcastingAuth(ctx, env) {
  try {
    const { key, secret } = pusherConfig(env);
    const body = typeof ctx.body === 'string' ? new URLSearchParams(ctx.body) : new URLSearchParams(ctx.body || {});
    const socketId = body.get('socket_id');
    const channelName = body.get('channel_name');
    if (!socketId || !channelName) {
      return { status: 422, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'socket_id and channel_name are required' }) };
    }
    if (!isPrivateChannel(channelName)) {
      return { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'channel must be private- or presence-' }) };
    }

    // The channel's identity is the platform guard's, never the caller's: the
    // PHP SDK's `presence_auth()` receives `$user->getAuthIdentifier()` from
    // `PusherBroadcaster::validAuthenticationResponse()`, and Laravel's
    // `auth()` denies a guarded channel outright when there is no user. Reading
    // `channel_data.user_id` from the body would let any caller (authenticated
    // or not) join a private/presence channel as an arbitrary user.
    const userId = await guardUserId(ctx);
    if (userId == null) {
      return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Unauthenticated.' }) };
    }

    if (channelName.startsWith('presence-')) {
      const { auth, channel_data: channelData } = await signChannelAuth(key, secret, socketId, channelName, { user_id: userId });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auth, channel_data: channelData }),
      };
    }

    const { auth } = await signChannelAuth(key, secret, socketId, channelName);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth }),
    };
  } catch (err) {
    return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
}

// ── Event trigger (`POST /broadcast`) ────────────────────────────────────────
// The port's own route — Laravel's Broadcast facade would call the SDK's
// `trigger()` server-side; here the caller POSTs the event and the worker signs
// + forwards it to Pusher REST.
export async function triggerEvent(env, { channel, name, data }, fetchImpl = globalThis.fetch) {
  const { key, secret, appId, cluster } = pusherConfig(env);
  const payload = JSON.stringify({ name, channel, data });
  const authQs = await buildAuthQueryString(key, secret, payload);
  const url = `https://api-${cluster}.pusher.com/apps/${encodeURIComponent(appId)}/events?${authQs}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: payload,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json && (json.error || json.message)) || `pusher trigger failed (${res.status})`;
    throw new Error(message);
  }
  return json ?? {};
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body || '{}') : (ctx.body || {});
    const { channel, name, data } = body;
    if (!channel || !name) {
      return { status: 422, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'channel and name are required' }) };
    }
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
    const result = await triggerEvent(env, { channel, name, data: data ?? {} }, fetchImpl);

    if (env.DB) {
      try {
        await ensureSchema(env);
        await env.DB.prepare('INSERT INTO pusher_events (channel, name, payload) VALUES (?, ?, ?)')
          .bind(String(channel), String(name), JSON.stringify(data ?? {}))
          .run();
      } catch { /* observability only */ }
    }

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, event_ids: result?.event_ids ?? {} }),
    };
  } catch (err) {
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
}

// Route table this module serves — the router maps two paths to the two halves.
export const routes = {
  '/broadcasting/auth': handleBroadcastingAuth,
  '/broadcast': handle,
};
