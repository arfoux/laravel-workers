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
//   body: socket_id, channel_name [, channel_data (presence, base64 JSON)]
//   → `{auth, channel_data}` signed with HMAC-SHA256 over
//     `{socket_id}:{channel_name}` using Reverb's app key/secret.
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
  signChannelAuth,
} from '../../kernel/packages/broadcast.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

function reverbConfig(env) {
  const key = env.REVERB_KEY;
  const secret = env.REVERB_SECRET;
  if (!key || !secret) {
    throw new Error('REVERB_KEY / REVERB_SECRET not configured');
  }
  return { key, secret };
}

// `Broadcast::routes()` maps POST /broadcasting/auth here.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const { key, secret } = reverbConfig(env);
    const body = typeof ctx.body === 'string' ? new URLSearchParams(ctx.body) : new URLSearchParams(ctx.body || {});
    const socketId = body.get('socket_id');
    const channelName = body.get('channel_name');
    if (!socketId || !channelName) {
      return { status: 422, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'socket_id and channel_name are required' }) };
    }
    if (!isPrivateChannel(channelName)) {
      return { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'channel must be private- or presence-' }) };
    }

    if (channelName.startsWith('presence-')) {
      const incoming = body.get('channel_data');
      let userData = null;
      if (incoming) {
        try { userData = JSON.parse(atob(String(incoming))); }
        catch { return { status: 422, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'invalid channel_data' }) }; }
      }
      const userId = userData?.user_id ?? ctx.userId ?? null;
      if (userId == null) {
        return { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'presence channel requires an authenticated user' }) };
      }
      const { auth, channel_data: channelData } = await signChannelAuth(key, secret, socketId, channelName, { user_id: userId, user_info: userData?.user_info ?? null });
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
