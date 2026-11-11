// Port of mollie/laravel-cashier-mollie v2.x — the Mollie webhook receiver at the
// edge. Parity target: Cashier Mollie's `CashierMollieWebhookController`, which
// verifies the caller and reconciles the payment state by re-fetching it from
// the Mollie API (Mollie's webhook does NOT include a status — the receiver must
// look it up).
//
// What runs at the edge (1:1 with the package flow):
//   1. read the event id: the incoming body is just `{ "id": "tr_…" }`,
//   2. verify `X-Mollie-Signature` = base64(HMAC-SHA256(secret, rawBody)),
//      compared constant-time (mirrors PHP `hash_equals()`),
//   3. reverse-reconcile: `GET https://api.mollie.com/v2/payments/{id}` with
//      `Authorization: Bearer MOLLIE_API_KEY`, tolerating just-received
//      webhooks by retrying the lookup once on a 404,
//   4. upsert the returned payment onto a D1 `mollie_payments` row.
//
// Disclosures: genuine Mollie confirms webhooks via the reverse call only — the
// `X-Mollie-Signature` header is not part of the real protocol. It is enforced
// here as a defence-in-depth gate (and rate-limit) in front of the same
// reverse-reconcile lookup, so the edge behaviour is a strict superset of
// Cashier's. Payout/mandate/customer objects that a full Cashier install
// persists are out of scope: only the payment row is projected.
//
// Free tier: 1–2 subrequests + 1 D1 write per webhook; HMAC CPU negligible.

import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, mapProviderResponse } from '../../kernel/packages/notify-http.mjs';

// Constant-time byte compare (mirrors PHP `hash_equals()`): length is checked
// first, then every byte is XORed and only the accumulated diff is folded.
function timingSafeEqualBytes(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  // Fallback for the (unused-in-practice) string form.
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// RFC 4648 base64 → bytes. Used to compare the received header against the
// expected digest as bytes so a length-different forged header does not leak
// through the byte-XOR fold. Throws on malformed base64 → caught by caller.
function base64Bytes(s) {
  const t = String(s).replace(/\s+/g, '');
  const binary = atob(t);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// base64(HMAC-SHA256(secret, rawBody)) — the digest the `X-Mollie-Signature`
// header must match.
async function signatureFor(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(rawBody)));
  let bin = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Project a Mollie payment GET response onto a `mollie_payments` row.
async function upsertPayment(env, payment) {
  const amount = (payment && payment.amount) || {};
  const id = String(payment && payment.id ? payment.id : '');
  if (!id) return;
  const status = payment.status || 'unknown';

  await env.DB.prepare(
    `INSERT INTO mollie_payments
       (id, method, status, amount_value, amount_currency, customer_id,
        paid_at, canceled_at, expires_at, created_at, updated_at,
        webhook_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       method=excluded.method, status=excluded.status,
       amount_value=excluded.amount_value, amount_currency=excluded.amount_currency,
       customer_id=excluded.customer_id,
       paid_at=excluded.paid_at, canceled_at=excluded.canceled_at,
       expires_at=excluded.expires_at, updated_at=excluded.updated_at,
       webhook_meta=excluded.webhook_meta`
  ).bind(
    id,
    payment.method || null,
    status,
    amount.value != null ? String(amount.value) : null,
    amount.currency || null,
    payment.customerId || null,
    payment.paidAt || null,
    payment.canceledAt || null,
    payment.expiresAt || null,
    now(),
    now(),
    JSON.stringify(payment).slice(0, 8000)
  ).run();
}

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mollie_payments (
      id TEXT PRIMARY KEY,
      method TEXT,
      status TEXT,
      amount_value TEXT,
      amount_currency TEXT,
      customer_id TEXT,
      paid_at TEXT,
      canceled_at TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      webhook_meta TEXT
    )`
  ).run();
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const secret = env && env.MOLLIE_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: 'MOLLIE_WEBHOOK_SECRET not configured' });
    const apiKey = env && env.MOLLIE_API_KEY;
    if (!apiKey) return json(500, { error: 'MOLLIE_API_KEY not configured' });

    // 1. Signature gate: X-Mollie-Signature = base64(HMAC-SHA256(secret, rawBody)).
    const header = ctx.request.header('x-mollie-signature') || '';
    const rawBody = await ctx.request.text();
    const headerSig = header.replace(/^sha256=/i, '').trim();
    let signatureOk = false;
    if (headerSig) {
      try {
        const expected = await signatureFor(secret, rawBody);
        signatureOk = timingSafeEqualBytes(base64Bytes(headerSig), base64Bytes(expected));
      } catch {
        signatureOk = false;
      }
    }
    if (!signatureOk) return json(401, { error: 'invalid X-Mollie-Signature' });

    // 2. Event id from `{ id: "tr_…" }`.
    const body = ctx.body || {};
    const paymentId = typeof body.id === 'string' ? body.id.trim() : '';
    if (!paymentId) return json(422, { error: 'body.id required' });

    // 3. Reverse-reconcile: fetch the authoritative payment state from Mollie.
    const fetchImpl = resolveFetch(env);
    let resp;
    try {
      resp = await fetchImpl(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
      });
      // A webhook can beat the write path: one single retry on 404.
      if (resp && resp.status === 404) {
        resp = await fetchImpl(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          },
        });
      }
    } catch (err) {
      return json(502, { error: `payment lookup failed: ${String((err && err.message) || err)}` });
    }

    const mapped = resp ? await mapProviderResponse(resp) : { status: 0, headers: {}, body: '' };
    if (mapped.status !== 200) {
      return json(mapped.status >= 400 && mapped.status < 500 ? 404 : 502, {
        error: `Mollie payment lookup returned ${mapped.status}`,
      });
    }

    let payment;
    try {
      payment = JSON.parse(mapped.body);
    } catch {
      return json(502, { error: 'Mollie payment lookup returned non-JSON' });
    }

    // 4. Upsert the payment row (best-effort: a D1 failure must not 500 the ack).
    try {
      await ensureSchema(env);
      await upsertPayment(env, payment || {});
    } catch (err) {
      return json(200, {
        received: true,
        id: paymentId,
        status: (payment && payment.status) || 'unknown',
        reconcile_error: String((err && err.message) || err),
      });
    }

    return json(200, {
      received: true,
      id: paymentId,
      status: (payment && payment.status) || 'unknown',
    });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
