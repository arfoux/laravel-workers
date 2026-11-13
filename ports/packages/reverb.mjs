// ports/packages/reverb.mjs — laravel/reverb (v1.12.0) auth-half port.
//
// Reverb is a long-running WebSocket server (`php artisan reverb:start`, ReactPHP
// socket on a TCP port) — that half is edge-impossible and is refused. What CAN
// run here is the `POST /broadcasting/auth` route `Broadcast::routes()` registers:
// signing the private/presence channel token the client (Echo) presents. This
// module implements exactly that half and nothing else.
//
// Route contract (registry.json → {"ports": {"/broadcasting/auth": "reverb"}}):
//   POST /broadcasting/auth
//   body: socket_id, channel_name
//   → `{auth}` (private) / `{auth, channel_data}` (presence) signed with
//     HMAC-SHA256 over `{socket_id}:{channel_name}` using Reverb's app key/secret.
//   A guarded channel requires an authenticated request (`ctx.user()` /
//   middleware-written `ctx.user_id`); the presence user id is that identity,
//   never a value the caller supplied.
//
// Secrets (worker env): REVERB_KEY, REVERB_SECRET.
//
// REFUSAL (documented): the WS server itself. A hub that speaks the Pusher
// protocol (Reverb, soketi, a Cloudflare Durable Object, Ably) must terminate
// the socket; the edge can only sign the auth token and hand it back. Point
// Echo's `host`/`authEndpoint` at that hub and `authEndpoint` at this route.
//
// Substitutions (disclosed):
//   - Reverb's synchronous HMAC → async WebCrypto HMAC-SHA256 (byte-identical).
//   - Reverb app model (`reverb_apps` table) → worker secrets (single-app).
//
// Free-tier: 0 subrequests — pure HMAC. No D1 involved.

import {
  isPrivateChannel,
  readChannelAuthBody,
  channelAuthRefusal,
  channelAuthPayload,
  CHANNEL_AUTH_REQUIRED,
  CHANNEL_AUTH_NOT_PRIVATE,
} from '../../kernel/packages/broadcast.mjs';
import { normalizePortCtx, jsonResponse, guardUserId, unauthorized } from '../../kernel/packages/port-ctx.mjs';

function reverbConfig(env) {
  const key = env.REVERB_KEY;
  const secret = env.REVERB_SECRET;
  if (!key || !secret) {
    throw new Error('REVERB_KEY / REVERB_SECRET not configured');
  }
  return { key, secret };
}

// `Broadcast::routes()` maps POST /broadcasting/auth here. The guard bodies are
// `kernel/packages/broadcast.mjs`'s (the same ones pusher and echo answer with).
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const { key, secret } = reverbConfig(env);
    const { socketId, channelName } = readChannelAuthBody(ctx);
    if (!socketId || !channelName) {
      return channelAuthRefusal(422, CHANNEL_AUTH_REQUIRED);
    }
    if (!isPrivateChannel(channelName)) {
      return channelAuthRefusal(403, CHANNEL_AUTH_NOT_PRIVATE);
    }

    // Identity comes from the platform guard, never the caller's body:
    // `PusherBroadcaster::validAuthenticationResponse()` hands `presence_auth()`
    // `$user->getAuthIdentifier()`, and `Broadcaster::auth()` denies a guarded
    // (private-/presence-) channel when there is no user. A caller-supplied
    // `channel_data.user_id` would let anyone join as an arbitrary user.
    const userId = await guardUserId(ctx);
    if (userId == null) return unauthorized();

    return channelAuthPayload(key, secret, socketId, channelName, userId);
  } catch (err) {
    return jsonResponse(500, { error: String((err && err.message) || err) });
  }
}
