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

import { channelAuthResponse } from '../../kernel/packages/broadcast.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

function reverbConfig(env) {
  const key = env.REVERB_KEY;
  const secret = env.REVERB_SECRET;
  if (!key || !secret) {
    throw new Error('REVERB_KEY / REVERB_SECRET not configured');
  }
  return { key, secret };
}

// `Broadcast::routes()` maps POST /broadcasting/auth here. The block is
// `channelAuthResponse()` in kernel/packages/broadcast.mjs — reverb and pusher
// answer with the identical sequence — and this port contributes Reverb's own
// secret lookup (`REVERB_*`) and its wording when the secrets are missing.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  return channelAuthResponse(ctx, () => reverbConfig(env));
}
