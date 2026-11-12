// Port of mollie/laravel-cashier-mollie v2.x — the Mollie webhook receiver at the
// edge. Parity target: Cashier Mollie's `CashierMollieWebhookController`, which
// verifies the caller and reconciles the payment state by re-fetching it from
// the Mollie API (Mollie's webhook does NOT include a status — the receiver must
// look it up).
//
// What runs at the edge (1:1 with the package flow):
//   1. read the event id: the incoming body is just `{ "id": "tr_…" }`,
//   2. if `X-Mollie-Signature` is present, verify it — hex HMAC-SHA256 over the
//      raw body, constant-time (mirrors PHP `hash_equals()`); the classic
//      Cashier-registered webhook sends no header, which is the legacy path,
//   3. reverse-reconcile: `GET https://api.mollie.com/v2/payments/{id}` with
//      `Authorization: Bearer MOLLIE_API_KEY`, tolerating just-received
//      webhooks by retrying the lookup once on a 404,
//   4. upsert the returned payment onto a D1 `mollie_payments` row.
//
// Disclosures: the classic per-resource webhook is UNSIGNED — Mollie's payload
// carries no status, so the reverse-reconcile below is what actually confirms
// the payment (Cashier Mollie does the same). Next-gen webhooks DO carry
// `X-Mollie-Signature: sha256=<hex HMAC-SHA256 of the raw body>` (mollie-api-php
// `src/Webhooks/SignatureValidator.php`: header `X-Mollie-Signature`, prefix
// `sha256=`, `hash_hmac('sha256', $payload, $secret)`), and the official
// validator treats an absent header as "legacy webhook" rather than an error.
// This port mirrors that: a present header must verify (`401` otherwise, and
// `401` too when no `MOLLIE_WEBHOOK_SECRET` is configured — an unverifiable
// claim is not accepted), an absent one continues to the reverse-reconcile.
// Payout/mandate/customer objects that a full Cashier install persists are out
// of scope: only the payment row is projected.
//
// Free tier: 1–2 subrequests + 1 D1 write per webhook; HMAC CPU negligible.

import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, mapProviderResponse } from '../../kernel/packages/notify-http.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { hmacSha256Hex as signatureFor } from '../../kernel/hmac.mjs';

// Constant-time compare comes from kernel/packages/webhook.mjs (the one
// `hash_equals()` mirror the other webhook verifiers use).

// HMAC-SHA256 of the raw body, rendered as HEX — the exact string
// `hash_hmac('sha256', $payload, $secret)` returns in Mollie's own
// SignatureValidator (`mollie/mollie-api-php`,
// `src/Webhooks/SignatureValidator.php::createSignature`), which the
// `X-Mollie-Signature` header carries (optionally prefixed `sha256=`).

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
    const apiKey = env && env.MOLLIE_API_KEY;
    if (!apiKey) return json(500, { error: 'MOLLIE_API_KEY not configured' });

    // 1. Signature gate. Mollie has two webhook generations: the classic
    // per-resource webhook Cashier Mollie registers is UNSIGNED (the body is just
    // `{ "id": "tr_..." }`), and the next-gen webhooks carry
    // `X-Mollie-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Mollie's own
    // SDK mirrors that: `SignatureValidator::validateRequest()` returns false
    // ("treat as legacy webhook") when the header is absent, and throws only when
    // a header IS present and matches no configured secret. So: no header →
    // continue to the authoritative reverse-reconcile below; header present →
    // must verify, else 401.
    const secret = env && env.MOLLIE_WEBHOOK_SECRET;
    const header = ctx.request.header('x-mollie-signature') || '';
    const rawBody = await ctx.request.text();
    const headerSig = header.replace(/^sha256=/i, '').trim();
    if (headerSig) {
      let signatureOk = false;
      if (secret) {
        try {
          signatureOk = timingSafeEqual(await signatureFor(secret, rawBody), headerSig);
        } catch {
          signatureOk = false;
        }
      }
      if (!signatureOk) return json(401, { error: 'invalid X-Mollie-Signature' });
    }

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
