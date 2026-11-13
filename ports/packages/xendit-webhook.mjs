// Port of the xendit/xendit-php webhook handling (payment callback) at the edge.
//
// Route seam: registry.json → "ports": { "/xendit/webhook": "xendit-webhook" }
//
// What runs at the edge (1:1 with the package's callback controller):
//   • authentication = Xendit sends a shared secret in the `x-callback-token`
//                      request header. The package (and the Xendit dashboard)
//                      configures it as "Webhook Verification Token"; the
//                      controller rejects any call whose header does not match.
//                      We compare constant-time (`hash_equals()` parity).
//   • persistence    = every accepted callback is stored in the D1 `invoices`
//                      table (id, external_id, status, created_at).
//   • ACK            = 200 once verified + stored; a bad token is a 401 and is
//                      NOT stored; a payload without `id` is a 422 and is NOT
//                      stored.
//
// Xendit callback body (trimmed to the edge-relevant fields): at minimum
//   { id, external_id, status }
// `status` carries the invoice state the package reads
// (`PAID`/`EXPIRED`/`SETTLED`/...), stored verbatim so app code can switch on it.
//
// Env: XENDIT_CALLBACK_TOKEN (the shared callback verification token).
//
// Substitutions (disclosed):
//   • The package's `InvoiceEvent::dispatch()` / event listeners are app code,
//     off-edge by design. This port stores the row and ACKs; downstream
//     reactions (revenue recognition, emails, …) are driven by a producer.
//
// Free tier: 1 D1 write per accepted call, 0 subrequests, no crypto (static token).

import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';

// D1 table (the package's invoice/callback shape, trimmed to the edge-relevant
// columns): id (Xendit invoice id, PK), external_id (merchant reference),
// status, created_at.
export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    external_id TEXT,
    status TEXT,
    created_at TEXT NOT NULL
  )`).run();
}

// port-ctx owns the envelope; this port sends no cache-control.
const json = (status, payload) => jsonResponse(status, payload, { noStore: false });

function nowIso() {
  return new Date().toISOString();
}

// Persist an accepted callback. Returns the stored id.
async function recordInvoice(env, invoice) {
  await ensureSchema(env);
  await env.DB.prepare(
    'INSERT INTO invoices (id, external_id, status, created_at) VALUES (?, ?, ?, ?)'
  ).bind(
    String(invoice.id),
    invoice.external_id == null ? null : String(invoice.external_id),
    invoice.status == null ? null : String(invoice.status),
    nowIso()
  ).run();
  return String(invoice.id);
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const expected = env && env.XENDIT_CALLBACK_TOKEN;
    if (!expected) {
      return json(500, { error: 'XENDIT_CALLBACK_TOKEN not configured' });
    }

    // Constant-time header verification (hash_equals parity): reject before
    // any read/write so an unauthenticated call never reaches the table.
    const provided = ctx.request.header('x-callback-token');
    if (typeof provided !== 'string' || provided === '' ||
        !timingSafeEqual(String(expected), provided.trim())) {
      return json(401, { error: 'invalid x-callback-token' });
    }

    const body = (ctx.body && typeof ctx.body === 'object') ? ctx.body : {};
    if (!body.id) {
      return json(422, { error: 'body.id required' });
    }

    const stored = await recordInvoice(env, {
      id: body.id,
      external_id: body.external_id,
      status: body.status,
    });

    return json(200, { received: true, id: stored });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
