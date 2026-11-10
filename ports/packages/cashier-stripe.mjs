// Port of laravel/cashier (Stripe) v16.9.0 — the Stripe webhook endpoint at the edge.
//
// Route seam: registry.json → "ports": { "/stripe/webhook": "cashier-stripe" }
//
// What runs at the edge (1:1 with Cashier's webhook controller):
//   • signature verification  = HMAC-SHA256 over `${t}.${rawBody}`, ±5 min tolerance
//                              (kernel/packages/webhook.mjs verifyStripeSignature)
//   • idempotent replay guard = event id upserted into `lw_webhook_events`
//                              (PK event-id; a duplicate is ACKed 200 and skipped)
//   • state machine           = `subscriptions` row kept current from the event payload
//                              (status, trial, cancel_at_period_end, quantity, price)
//
// Substitutions (disclosed):
//   • The `Billable` trait / `CashierServiceProvider` are vendor code the compiled
//     rung cannot load (LW002) — the D1 tables ARE the subscription store.
//   • Card capture / checkout / portal = off-edge by design (PCI, Stripe MoR). This
//     port only consumes webhook events; `fetch` to Stripe's REST API would drive
//     the hosted checkout/portal redirects (COMPILED.md billing seam).
//   • Proration math is Stripe's, never ours — `invoice.paid` / `subscription.updated`
//     results are recorded, not recomputed.
//
// Free tier: ≤2 D1 writes per event (event row + subscription upsert), HMAC CPU
// negligible, 0 subrequests (the event is fully self-describing).

import { verifyStripeSignature } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Cashier's `subscriptions` table (v16 columns incl. meter fields). `subscription_items`
// is updated alongside for multi-price subscriptions.
export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lw_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT,
    payload TEXT,
    received_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    stripe_id TEXT NOT NULL UNIQUE,
    stripe_status TEXT NOT NULL,
    stripe_price TEXT,
    quantity INTEGER,
    trial_ends_at TEXT,
    ends_at TEXT,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    paused_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscription_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    stripe_id TEXT NOT NULL,
    stripe_product TEXT,
    stripe_price TEXT,
    quantity INTEGER,
    meter_id TEXT,
    meter_event_name TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (subscription_id, stripe_price)
  )`).run();
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const isoOrNull = (v) => (v ? new Date(typeof v === 'number' ? v * 1000 : v).toISOString().replace('T', ' ').slice(0, 19) : null);

function json(status, payload) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

// Idempotency: insert-or-ignore the event id. Returns true iff this is the FIRST
// time we've seen it (so the caller should apply the state change).
async function recordEventOnce(env, event) {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO lw_webhook_events (id, provider, type, payload, received_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(String(event.id), 'stripe', String(event.type || ''), JSON.stringify(event).slice(0, 8000), now()).run();
  return (res.meta?.changes ?? res.changes ?? 0) > 0;
}

// Project a Stripe subscription object (or checkout session) onto a Cashier row.
async function upsertSubscription(env, userId, name, sub) {
  const status = sub.status || sub.stripe_status || 'incomplete';
  const priceId = sub.items?.data?.[0]?.price?.id || sub.price || null;
  const quantity = sub.items?.data?.[0]?.quantity ?? sub.quantity ?? 1;
  const row = {
    user_id: userId,
    name: name || 'default',
    stripe_id: sub.id || sub.subscription,
    stripe_status: status,
    stripe_price: priceId,
    quantity,
    trial_ends_at: isoOrNull(sub.trial_end),
    ends_at: isoOrNull(sub.ended_at ?? sub.cancel_at),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    paused_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, name, stripe_id, stripe_status, stripe_price, quantity,
       trial_ends_at, ends_at, cancel_at_period_end, paused_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_id) DO UPDATE SET
       user_id=excluded.user_id, name=excluded.name, stripe_status=excluded.stripe_status,
       stripe_price=excluded.stripe_price, quantity=excluded.quantity,
       trial_ends_at=excluded.trial_ends_at, ends_at=excluded.ends_at,
       cancel_at_period_end=excluded.cancel_at_period_end, updated_at=excluded.updated_at`
  ).bind(row.user_id, row.name, row.stripe_id, row.stripe_status, row.stripe_price, row.quantity,
    row.trial_ends_at, row.ends_at, row.cancel_at_period_end, row.paused_at, now(), now()).run();

  // Sync the first subscription item (Cashier keeps one row per price).
  const item = sub.items?.data?.[0];
  if (item) {
    const parent = await env.DB.prepare('SELECT id FROM subscriptions WHERE stripe_id = ?').bind(row.stripe_id).first();
    if (parent) {
      await env.DB.prepare(
        `INSERT INTO subscription_items (subscription_id, stripe_id, stripe_product, stripe_price, quantity, meter_id, meter_event_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, stripe_price) DO UPDATE SET
           quantity=excluded.quantity, meter_id=excluded.meter_id,
           meter_event_name=excluded.meter_event_name, updated_at=excluded.updated_at`
      ).bind(parent.id, item.id, item.price?.product ?? null, item.price?.id ?? null, item.quantity ?? 1,
        item.price?.recurring?.meter ?? null, item.price?.metadata?.meter_event_name ?? null, now(), now()).run();
    }
  }
}

async function applyEvent(env, event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data?.object;
      const sub = s?.subscription?.object ?? s?.subscription;
      const userId = Number(s?.metadata?.userId ?? s?.client_reference_id);
      if (sub && Number.isFinite(userId)) await upsertSubscription(env, userId, s.metadata?.name, sub);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data?.object;
      const userId = Number(sub?.metadata?.userId);
      if (sub && Number.isFinite(userId)) await upsertSubscription(env, userId, sub.metadata?.name, sub);
      break;
    }
    default:
      // Other Stripe events are recorded (replay guard) but need no D1 projection.
      break;
  }
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: 'STRIPE_WEBHOOK_SECRET not configured' });

    const header = ctx.request.headers.get('stripe-signature') || '';
    const rawBody = await ctx.request.text();
    const { ok, event, reason } = await verifyStripeSignature(header, rawBody, secret, {
      now: env.STRIPE_WEBHOOK_NOW ?? Math.floor(Date.now() / 1000),
    });
    if (!ok) return json(401, { error: reason || 'invalid signature' });
    if (!event || typeof event.id !== 'string') return json(400, { error: 'event missing id' });

    const first = await recordEventOnce(env, event);
    if (!first) return json(200, { received: true, idempotent: true, id: event.id });
    await applyEvent(env, event);
    return json(200, { received: true, id: event.id, type: event.type });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
