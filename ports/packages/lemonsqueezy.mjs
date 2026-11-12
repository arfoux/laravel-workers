// Port of lemonsqueezy/laravel v1.9.0 — the Lemon Squeezy webhook endpoint +
// license-key state at the edge.
//
// Route seam: registry.json → "ports": { "/lemon-squeezy/webhook": "lemonsqueezy" }
//
// Edge behavior (1:1 with the package's webhook controller):
//   • signature verification  = `X-Signature: <hex>`, HMAC-SHA256 over the raw body
//                              alone (no timestamp — verifyLemonSignature)
//   • idempotent replay guard = `meta.event_id` upserted into `lw_webhook_events`
//                              (LS signs without a timestamp, so replay protection
//                              is BY event id — the store above is the only guard)
//   • state machine           = `lemon_squeezy_subscriptions` / `_orders` /
//                              `_customers` / `_license_keys` (v1.9.0 migration names)
//
// Substitutions (disclosed):
//   • `Billable` trait / `LemonSqueezyServiceProvider` are vendor code the compiled
//     rung cannot load (LW002) — D1 tables are the subscription/license store.
//   • LS is Merchant of Record — checkout + customer portal URLs come from the LS
//     REST API via `fetch`; this port only consumes webhook events.
//
// Free tier: ≤2 D1 writes per event, HMAC CPU negligible, 0 subrequests.

import { verifyLemonSignature, ensureWebhookEventsTable, recordWebhookEventOnce } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

export async function ensureSchema(env) {
  await ensureWebhookEventsTable(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lemon_squeezy_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ls_id TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lemon_squeezy_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    ls_id TEXT NOT NULL UNIQUE,
    ls_product_id TEXT,
    ls_variant_id TEXT,
    status TEXT NOT NULL,
    quantity INTEGER,
    trial_ends_at TEXT,
    renews_at TEXT,
    ends_at TEXT,
    paused_at TEXT,
    card_brand TEXT,
    card_last_four TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lemon_squeezy_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ls_id TEXT NOT NULL UNIQUE,
    billable_name TEXT,
    total TEXT,
    currency TEXT,
    status TEXT,
    refunded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lemon_squeezy_license_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ls_id TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL,
    key_short TEXT,
    activation_limit INTEGER,
    instances_count INTEGER,
    status TEXT,
    expires_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`.replace(/\s+/g, ' ')).run();
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
  return recordWebhookEventOnce(env, {
    id: String(event.meta?.event_id),
    provider: 'lemon-squeezy',
    type: event.meta?.event_name,
    payload: event,
    receivedAt: now(),
  });
}

// LS nests the app's user id in `meta.custom_data` (set on checkout) and the data
// object under `data` (JSON:API style). Subscription events carry the related
// subscription under `data.attributes.first_subscription_item` / relationships.
function userIdOf(event) {
  const n = Number(event.meta?.custom_data?.user_id);
  return Number.isFinite(n) ? n : null;
}

async function upsertCustomer(env, event, customer) {
  const lsId = customer?.id ? String(customer.id) : null;
  if (!lsId) return;
  await env.DB.prepare(
    `INSERT INTO lemon_squeezy_customers (user_id, ls_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ls_id) DO UPDATE SET user_id=COALESCE(excluded.user_id, lemon_squeezy_customers.user_id),
       email=excluded.email, name=excluded.name, updated_at=excluded.updated_at`
  ).bind(userIdOf(event), lsId, customer.email ?? null, customer.name ?? null, now(), now()).run();
}

async function upsertSubscription(env, event, sub) {
  const lsId = sub?.id ? String(sub.id) : null;
  const userId = userIdOf(event);
  if (!lsId) return;
  const attrs = sub.attributes || {};
  await env.DB.prepare(
    `INSERT INTO lemon_squeezy_subscriptions (user_id, name, ls_id, ls_product_id, ls_variant_id, status,
       quantity, trial_ends_at, renews_at, ends_at, paused_at, card_brand, card_last_four, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ls_id) DO UPDATE SET user_id=COALESCE(excluded.user_id, lemon_squeezy_subscriptions.user_id),
       status=excluded.status, ls_variant_id=excluded.ls_variant_id, quantity=excluded.quantity,
       trial_ends_at=excluded.trial_ends_at, renews_at=excluded.renews_at, ends_at=excluded.ends_at,
       paused_at=excluded.paused_at, card_brand=excluded.card_brand, card_last_four=excluded.card_last_four,
       updated_at=excluded.updated_at`
  ).bind(userId, event.meta?.custom_data?.name || 'default', lsId,
    sub.relationships?.product?.id ?? attrs.product_id ?? null,
    attrs.variant_id ?? null,
    attrs.status || 'active',
    attrs.quantity ?? 1,
    isoOrNull(attrs.trial_ends_at), isoOrNull(attrs.renews_at), isoOrNull(attrs.ends_at),
    isoOrNull(attrs.paused_at), attrs.card_brand ?? null, attrs.card_last_four ?? null, now(), now()).run();
}

async function upsertOrder(env, event, order) {
  const lsId = order?.id ? String(order.id) : null;
  if (!lsId) return;
  const attrs = order.attributes || {};
  await env.DB.prepare(
    `INSERT INTO lemon_squeezy_orders (user_id, ls_id, billable_name, total, currency, status, refunded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ls_id) DO UPDATE SET status=excluded.status, total=excluded.total, currency=excluded.currency,
       refunded=excluded.refunded, updated_at=excluded.updated_at`
  ).bind(userIdOf(event), lsId, attrs.customer_name ?? attrs.billing_name ?? null,
    attrs.total ?? null, attrs.currency ?? null, attrs.status ?? null, attrs.refunded ? 1 : 0, now(), now()).run();
}

async function upsertLicenseKey(env, event, key) {
  const lsId = key?.id ? String(key.id) : null;
  if (!lsId) return;
  const attrs = key.attributes || {};
  await env.DB.prepare(
    `INSERT INTO lemon_squeezy_license_keys (user_id, ls_id, key, key_short, activation_limit, instances_count, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ls_id) DO UPDATE SET key=excluded.key, key_short=excluded.key_short,
       activation_limit=excluded.activation_limit, instances_count=excluded.instances_count,
       status=excluded.status, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).bind(userIdOf(event), lsId, attrs.key ?? '', attrs.key_short ?? null,
    attrs.activation_limit ?? null, attrs.instances_count ?? null, attrs.status ?? null,
    isoOrNull(attrs.expires_at), now(), now()).run();
}

async function applyEvent(env, event) {
  const name = event.meta?.event_name || '';
  const data = event.data || {};
  if (name === 'subscription_created' || name === 'subscription_updated') {
    await upsertSubscription(env, event, data);
    if (data?.relationships?.customer?.id) {
      await upsertCustomer(env, event, { id: data.relationships.customer.id, email: data.attributes?.customer_email });
    }
  } else if (name === 'subscription_cancelled' || name === 'subscription_resumed' || name === 'subscription_expired') {
    // Same projection — status change is carried in attributes.status.
    await upsertSubscription(env, event, data);
  } else if (name === 'subscription_payment_success' || name === 'order_created' || name === 'order_refunded') {
    await upsertOrder(env, event, data);
  } else if (name === 'license_key_created' || name === 'license_key_updated') {
    await upsertLicenseKey(env, event, data);
  }
  // Other events (payment_failed, etc.) are recorded for the replay guard.
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const secret = env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: 'LEMON_SQUEEZY_WEBHOOK_SECRET not configured' });

    const header = ctx.request.headers.get('x-signature') || '';
    const rawBody = await ctx.request.text();
    const { ok, event, reason } = await verifyLemonSignature(header, rawBody, secret);
    if (!ok) return json(401, { error: reason || 'invalid signature' });
    if (!event || typeof event.meta?.event_id !== 'string') return json(400, { error: 'event missing meta.event_id' });

    const first = await recordEventOnce(env, event);
    if (!first) return json(200, { received: true, idempotent: true, id: event.meta.event_id });
    await applyEvent(env, event);
    return json(200, { received: true, id: event.meta.event_id, type: event.meta.event_name });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
