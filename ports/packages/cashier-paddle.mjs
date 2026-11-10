// Port of laravel/cashier-paddle v2.8.1 — the Paddle Billing webhook endpoint.
//
// Route seam: registry.json → "ports": { "/paddle/webhook": "cashier-paddle" }
//
// Edge behavior (1:1 with Cashier Paddle's webhook controller):
//   • signature verification  = `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 over
//                              `${ts}:${rawBody}`, ±5 min tolerance (verifyPaddleSignature)
//   • idempotent replay guard = Paddle `event_id` upserted into `lw_webhook_events`
//   • state machine           = `paddle_subscriptions` (paddle_id / status / trial /
//                              paused) + `paddle_transactions` + `paddle_customers`
//
// Substitutions (disclosed):
//   • `Billable` trait / `CashierServiceProvider` are vendor code the compiled rung
//     cannot load (LW002) — D1 tables are the subscription store.
//   • Paddle is Merchant of Record — checkout, payment, tax, proration all happen on
//     Paddle's side. This port only consumes webhook events; the hosted checkout /
//     customer-portal URLs come from Paddle's REST API via `fetch` (COMPILED.md seam).
//
// Free tier: ≤2 D1 writes per event, HMAC CPU negligible, 0 subrequests.

import { verifyPaddleSignature } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lw_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT,
    payload TEXT,
    received_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paddle_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    paddle_id TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paddle_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    paddle_id TEXT NOT NULL UNIQUE,
    paddle_price_id TEXT,
    status TEXT NOT NULL,
    quantity INTEGER,
    trial_ends_at TEXT,
    paused_at TEXT,
    ends_at TEXT,
    next_billed_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paddle_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    subscription_id INTEGER,
    paddle_id TEXT NOT NULL UNIQUE,
    paddle_subscription_id TEXT,
    total TEXT,
    currency TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const isoOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
};

function json(status, payload) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

async function recordEventOnce(env, event) {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO lw_webhook_events (id, provider, type, payload, received_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(String(event.event_id), 'paddle', String(event.event_type || ''), JSON.stringify(event).slice(0, 8000), now()).run();
  return (res.meta?.changes ?? res.changes ?? 0) > 0;
}

// Paddle custom_data carries the app's user id (Cashier sets it on checkout).
function userIdOf(data) {
  const n = Number(data?.custom_data?.user_id);
  return Number.isFinite(n) ? n : null;
}

async function upsertCustomer(env, customer, userId) {
  const paddleId = customer?.id;
  if (!paddleId) return;
  await env.DB.prepare(
    `INSERT INTO paddle_customers (user_id, paddle_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(paddle_id) DO UPDATE SET
       user_id=COALESCE(excluded.user_id, paddle_customers.user_id), email=excluded.email,
       name=excluded.name, updated_at=excluded.updated_at`
  ).bind(userId, paddleId, customer.email ?? null, customer.name ?? null, now(), now()).run();
}

async function upsertSubscription(env, data) {
  const userId = userIdOf(data);
  const paddleId = data?.id;
  if (!paddleId) return;
  const priceId = data?.items?.[0]?.price?.id ?? data?.price_id ?? null;
  const quantity = data?.items?.[0]?.quantity ?? data?.quantity ?? 1;
  await env.DB.prepare(
    `INSERT INTO paddle_subscriptions (user_id, name, paddle_id, paddle_price_id, status, quantity,
       trial_ends_at, paused_at, ends_at, next_billed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(paddle_id) DO UPDATE SET
       user_id=COALESCE(excluded.user_id, paddle_subscriptions.user_id), status=excluded.status,
       paddle_price_id=excluded.paddle_price_id, quantity=excluded.quantity,
       trial_ends_at=excluded.trial_ends_at, paused_at=excluded.paused_at, ends_at=excluded.ends_at,
       next_billed_at=excluded.next_billed_at, updated_at=excluded.updated_at`
  ).bind(userId, data?.custom_data?.name || 'default', paddleId, priceId, data?.status || 'active', quantity,
    isoOrNull(data?.trial_ends_at), isoOrNull(data?.paused_at), isoOrNull(data?.ends_at),
    isoOrNull(data?.next_billed_at), now(), now()).run();
}

async function upsertTransaction(env, data) {
  const paddleId = data?.id;
  if (!paddleId) return;
  await env.DB.prepare(
    `INSERT INTO paddle_transactions (user_id, subscription_id, paddle_id, paddle_subscription_id,
       total, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(paddle_id) DO UPDATE SET status=excluded.status, total=excluded.total,
       currency=excluded.currency, updated_at=excluded.updated_at`
  ).bind(userIdOf(data), null, paddleId, data?.subscription_id ?? null, data?.details?.totals?.total ?? data?.total ?? null,
    data?.currency_code ?? null, data?.status ?? null, now(), now()).run();
}

async function applyEvent(env, event) {
  const type = event.event_type || '';
  const data = event.data || {};
  if (type.startsWith('customer.')) {
    await upsertCustomer(env, data, userIdOf(data));
  } else if (type.startsWith('subscription.')) {
    await upsertSubscription(env, data);
    // A subscription event also carries the customer — keep the customer row fresh.
    if (data?.customer_id) {
      await upsertCustomer(env, { id: data.customer_id, email: data.customer?.email }, userIdOf(data));
    }
  } else if (type.startsWith('transaction.')) {
    await upsertTransaction(env, data);
  }
  // adjustment.*, payment_method.* etc. — recorded, no D1 projection needed.
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const secret = env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: 'PADDLE_WEBHOOK_SECRET not configured' });

    const header = ctx.request.headers.get('paddle-signature') || '';
    const rawBody = await ctx.request.text();
    const { ok, event, reason } = await verifyPaddleSignature(header, rawBody, secret, {
      now: env.PADDLE_WEBHOOK_NOW ?? Math.floor(Date.now() / 1000),
    });
    if (!ok) return json(401, { error: reason || 'invalid signature' });
    if (!event || typeof event.event_id !== 'string') return json(400, { error: 'event missing event_id' });

    const first = await recordEventOnce(env, event);
    if (!first) return json(200, { received: true, idempotent: true, id: event.event_id });
    await applyEvent(env, event);
    return json(200, { received: true, id: event.event_id, type: event.event_type });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
