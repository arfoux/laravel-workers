// Port of spatie/laravel-webhook-client — the receiving webhook endpoint at the edge.
//
// Route seam: registry.json → "ports": { "/webhooks/{name}": "webhook-client" }
//
// What runs at the edge (1:1 with the package's WebhookController):
//   • signature verification = HMAC-SHA256 over the RAW request body, base64-encoded,
//                              compared constant-time against the signature header
//                              (default `webhook-signature`, override WEBHOOK_CLIENT_SIGNATURE_HEADER)
//   • persistence            = every call stored in the D1 `webhook_calls` table
//                              (id, name, payload, exception, processed_at)
//   • ACK                    = 200 {received:true} once verified + stored; a bad
//                              signature is a 400 and is NOT stored.
//
// Signature scheme (spatie default): `base64(HMAC-SHA256(secret, rawBody))`.
// The secret comes from `env.WEBHOOK_CLIENT_SECRET`; `{name}` (the route param)
// is the webhook config name and is stored with the call for multi-webhook apps.
//
// Substitutions (disclosed):
//   • The package's queued `ProcessWebhookCallJob` (config `process_webhook_job`)
//     is off-edge by design — it is app code. This port stores the call row and
//     ACKs; job dispatch would be driven by a queue producer (COMPILED.md seam).
//   • `when_valid_signature` middleware is folded in: verification happens before
//     anything is written, so an unverified call never reaches the job/table.
//
// Free tier: 1 D1 write per accepted call, one HMAC, 0 subrequests.

import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { hmacSha256Base64 } from '../../kernel/hmac.mjs';

const SIGNATURE_HEADER_DEFAULT = 'webhook-signature';

// D1 table (spatie's `webhook_calls` migration, trimmed to the edge-relevant
// columns): id, name, payload, exception, processed_at.
export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_calls (
    id TEXT PRIMARY KEY,
    name TEXT,
    payload TEXT,
    exception TEXT,
    processed_at TEXT
  )`).run();
}

// port-ctx owns the envelope; this port sends no cache-control.
const json = (status, payload) => jsonResponse(status, payload, { noStore: false });

async function recordCall(env, name, rawBody, exception) {
  await ensureSchema(env);
  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    `wc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await env.DB.prepare(
    'INSERT INTO webhook_calls (id, name, payload, exception, processed_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    id,
    String(name || ''),
    String(rawBody).slice(0, 8000),
    exception ? String(exception) : null,
    new Date().toISOString()
  ).run();
  return id;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const secret = env.WEBHOOK_CLIENT_SECRET;
    if (!secret) return json(500, { error: 'WEBHOOK_CLIENT_SECRET not configured' });

    const headerName = env.WEBHOOK_CLIENT_SIGNATURE_HEADER || SIGNATURE_HEADER_DEFAULT;
    const header = ctx.request.headers.get(headerName) || '';
    const rawBody = await ctx.request.text();

    if (typeof header !== 'string' || header === '') {
      return json(400, { error: `missing ${headerName} header` });
    }

    const expected = await hmacSha256Base64(secret, rawBody);
    if (!timingSafeEqual(expected, header.trim())) {
      return json(400, { error: 'invalid signature' });
    }

    // Verified: persist the call. A malformed JSON payload is still stored —
    // spatie records the call and lets the job/`exception` column carry the error.
    let payloadNote = null;
    try { JSON.parse(String(rawBody)); } catch (e) { payloadNote = `invalid JSON payload: ${e.message}`; }

    const name = (ctx.params && ctx.params.name) || '';
    const id = await recordCall(env, name, rawBody, payloadNote);

    return json(200, { received: true, id, name });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
