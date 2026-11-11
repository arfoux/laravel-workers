import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { jsonPort } from '../../kernel/packages/notify-http.mjs';

// ports/packages/midtrans-webhook.mjs — port of midtrans/midtrans-php inbound
// notification handling (Snap/VT-Web "HTTP notification").
//
// Parity target: package's `Notification` verifies the incoming webhook before
// trusting it, computing
//   signature_key = SHA512(order_id . status_code . gross_amount . serverKey)
// (PHP `hash('sha512', $orderId.$statusCode.$grossAmount.$serverKey)`, lowercase
// hex) and rejecting the notification when it does not match. Receipts are
// recorded in a D1 `transactions` table keyed by `order_id`, so a re-delivered
// webhook (Midtrans retries on failure) is idempotent.
//
// Edge notes:
//   - The signature is a plain SHA-512 hash (not an HMAC), computed here with
//     WebCrypto and compared constant-time over the full digest length.
//   - Midtrans sends the signature as a `signature_key` JSON *body* field (no
//     signature header), alongside the notification fields.
//
// Route wiring: registry.json → "ports": { "/midtrans/webhook": "midtrans-webhook" }
//
// POST /midtrans/webhook
//   { order_id, status_code, gross_amount, transaction_status, payment_type, signature_key }
//   → 200 { ok, order_id } and a `transactions` row (idempotent on order_id)
//   → 400 when order_id is missing or signature_key does not match
//   → 500 when MIDTRANS_SERVER_KEY is unset or the write throws

// SHA-512 in lowercase hex (WebCrypto digest; matches PHP `hash('sha512', …)`).
async function sha512Hex(input) {
  const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(String(input)));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// Compare two (hex) strings without short-circuiting on the first mismatch, so
// an attacker probing the digest cannot time how much of it matches. Uses a
// running XOR over the full longer length; length difference is folded in.
function constantTimeEqual(a, b) {
  const aStr = String(a);
  const bStr = String(b);
  const len = Math.max(aStr.length, bStr.length);
  let diff = aStr.length ^ bStr.length;
  for (let i = 0; i < len; i += 1) {
    const ca = i < aStr.length ? aStr.charCodeAt(i) : 0;
    const cb = i < bStr.length ? bStr.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS transactions (
       order_id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       gross_amount TEXT NOT NULL,
       payment_type TEXT,
       updated_at TEXT NOT NULL
     )`
  ).run();
}

function nowIso() {
  return new Date().toISOString();
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const body = ctx.body || {};
    const { order_id, status_code, gross_amount, transaction_status, payment_type, signature_key } = body;

    if (!order_id || typeof order_id !== 'string') {
      return jsonPort({ error: 'order_id required' }, 400);
    }

    const serverKey = env && env.MIDTRANS_SERVER_KEY;
    if (!serverKey) {
      return jsonPort({ error: 'MIDTRANS_SERVER_KEY not configured' }, 500);
    }

    // Midtrans signs over the exact field strings as received.
    const expected = await sha512Hex(
      String(order_id) + String(status_code) + String(gross_amount) + String(serverKey)
    );
    if (!signature_key || !constantTimeEqual(expected, signature_key)) {
      return jsonPort({ error: 'invalid signature' }, 400);
    }

    await ensureSchema(env);
    const status = typeof transaction_status === 'string' ? transaction_status : String(status_code == null ? '' : status_code);
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO transactions (order_id, status, gross_amount, payment_type, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        order_id,
        status,
        String(gross_amount == null ? '' : gross_amount),
        payment_type == null ? null : String(payment_type),
        nowIso()
      )
      .run();

    // `INSERT OR IGNORE` absorbs the duplicate order_id (Midtrans retries), so
    // a re-delivered webhook is idempotent: same 200, no duplicate row.
    return jsonPort({ ok: true, order_id });
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 500);
  }
}
