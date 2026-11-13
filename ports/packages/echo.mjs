// ports/packages/echo.mjs — laravel/echo (v2.6.3) broadcast-auth half.
//
// Echo itself is a CLIENT-side JS library (browser/Node) — it never touches the
// compiled PHP rung. What it does at startup is POST to `authEndpoint`
// (`/broadcasting/auth`) to obtain the signed token that lets it subscribe to a
// `private-*` / `presence-*` channel on a Pusher-protocol hub. THIS module is
// the server side of that handshake, answered by the edge:
//
//   POST /broadcasting/auth
//     headers: Authorization: Bearer <sanctum personal-access-token>
//     body:    socket_id, channel_name [, channel_data (presence, base64 JSON)]
//     → 200 {auth}                     (private, membership verified)
//     → 200 {auth, channel_data}       (presence, user embedded from the token)
//     → 401                            (no/invalid Bearer token)
//     → 403                            (channel not in caller's memberships,
//                                       or a public channel — never authed)
//     → 422                            (socket_id / channel_name missing)
//
// AUTHORIZATIONS: Laravel's `Broadcast::channel()` closures are PHP (LW002 —
// vendor closures cannot load in the compiled rung). The D1 `channel_memberships`
// table replaces them: a row (user_id, channel) grants subscribe access. The
// Bearer token resolves the caller via the same Sanctum `personal_access_tokens`
// store the `sanctum` port uses (kernel/packages/token.mjs: sha256 + constant-
// time compare), so `id|random` plaintext → `tokenable_id` = user id.
//
// Substitutions (disclosed):
//   - Echo's `authEndpoint` POST → this route (identical request shape).
//   - `Broadcast::channel()` closures → `channel_memberships` rows (D1).
//   - Hub (Reverb/soketi/Durable Object) signs via its app key/secret; this
//     route signs with BROADCAST_KEY/SECRET, falling back to REVERB_* / PUSHER_*,
//     so the token this route returns byte-matches the hub Echo connects to.
//
// Secrets (worker env): BROADCAST_KEY + BROADCAST_SECRET (or REVERB_KEY/SECRET /
// PUSHER_KEY/SECRET). The signing is byte-identical to the pusher/reverb ports
// (kernel/packages/broadcast.mjs, HMAC-SHA256 over `{socket_id}:{channel}`).
//
// Free-tier: 1 D1 read to resolve the token + 1 D1 read for the membership
// check. No subrequests (pure HMAC signing).

import { isPrivateChannel, signChannelAuth } from '../../kernel/packages/broadcast.mjs';
import { normalizePortCtx, jsonResponse as json, unauthorized } from '../../kernel/packages/port-ctx.mjs';
import { bearerToken, verifyPersonalAccessToken } from '../../kernel/packages/token.mjs';

// ── Schema ────────────────────────────────────────────────────────────────────
// `channel_memberships` is the edge's stand-in for `Broadcast::channel()` — one
// row per (user, channel) the user may subscribe to. Provisioned idempotently;
// the Sanctum `personal_access_tokens` table it joins against is created by the
// `sanctum` port's own `ensureSchema`.
export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

// ── Broadcast signing config (hub app key/secret) ─────────────────────────────
function broadcastConfig(env) {
  const key = env.BROADCAST_KEY || env.REVERB_KEY || env.PUSHER_KEY;
  const secret = env.BROADCAST_SECRET || env.REVERB_SECRET || env.PUSHER_SECRET;
  if (!key || !secret) {
    throw new Error('BROADCAST_KEY / BROADCAST_SECRET (or REVERB_* / PUSHER_*) not configured');
  }
  return { key, secret };
}

// Resolve the caller's user id from the Bearer Sanctum token. No aliases in the
// SELECT so the same SQL runs on real D1 and on the in-memory test fake.
// Returns the user id, or null when there is no/invalid token.
async function resolveUserId(ctx, env) {
  const plain = bearerToken(ctx.request.headers.get('authorization'));
  if (!plain) return null;
  const id = Number.parseInt(plain.split('|')[0], 10);
  if (!Number.isFinite(id)) return null;
  const row = await env.DB.prepare(
    'SELECT token, tokenable_id FROM personal_access_tokens WHERE id = ?'
  ).bind(id).first();
  if (!row) return null;
  return (await verifyPersonalAccessToken(plain, row.token)) ? row.tokenable_id : null;
}

// `POST /broadcasting/auth` — the route Laravel's `Broadcast::routes()` registers
// and Echo's `authEndpoint` POSTs to.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    // 1. Token → user id. Missing/invalid token is a 401 before anything else.
    const userId = await resolveUserId(ctx, env);
    if (userId == null) return unauthorized();

    // 2. Echo posts form-urlencoded (socket_id, channel_name[, channel_data]);
    //    a plain object / URLSearchParams body works identically.
    const raw = ctx.body && typeof ctx.body === 'string' ? ctx.body : (ctx.body || {});
    const body = raw && typeof raw.get === 'function' ? raw : new URLSearchParams(raw);
    const socketId = body.get('socket_id');
    const channelName = body.get('channel_name');
    if (!socketId || !channelName) {
      return json(422, { error: 'socket_id and channel_name are required' });
    }

    // 3. Public channels are never authed — Echo only POSTs here for
    //    private-/presence- (subscribing a public channel needs no token).
    if (!isPrivateChannel(channelName)) {
      return json(403, { message: 'channel must be private- or presence-' });
    }

    // 4. Membership = the edge's `Broadcast::channel()` closure. No row → denied.
    const member = await env.DB.prepare(
      'SELECT id FROM channel_memberships WHERE user_id = ? AND channel = ?'
    ).bind(userId, channelName).first();
    if (!member) {
      return json(403, { message: 'This action is unauthorized.' });
    }

    // 5. Sign the token byte-identical to the pusher/reverb ports. Presence
    //    channels embed the resolved user id (Laravel's `PresenceChannel` shape).
    const { key, secret } = broadcastConfig(env);
    if (channelName.startsWith('presence-')) {
      const { auth, channel_data: channelData } = await signChannelAuth(
        key, secret, socketId, channelName, { user_id: userId },
      );
      return json(200, { auth, channel_data: channelData });
    }

    const { auth } = await signChannelAuth(key, secret, socketId, channelName);
    return json(200, { auth });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// Route table this module serves — mirrors the pusher/reverb auth half.
export const routes = { '/broadcasting/auth': handle };
