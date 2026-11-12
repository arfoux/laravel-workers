// kernel/packages/webhook.mjs — shared webhook-verification primitives for the
// payment/notification package ports (Cashier/Stripe, Cashier/Paddle,
// Lemon Squeezy). One place for the signature schemes so a port handler stays
// thin and the crypto is audited once.
//
// Parity target: Laravel's Stripe/Paddle/LS controllers verify an HMAC-SHA256
// over a canonical string built from the raw request body + a timestamp, using
// `hash_equals()` (constant-time). WebCrypto gives us the identical digest; the
// only difference is that WebCrypto's sign() is async, which is fine — a webhook
// route is never hot.

import { hmacSha256Hex } from '../hmac.mjs';

//Constant-time string compare (mirrors PHP `hash_equals()`): compares every
// byte and only then folds, so length and content both influence timing as
// little as possible. Returns true iff `a` and `b` are equal-length and equal.
export function timingSafeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// Stripe: header `Stripe-Signature: t=<unix>,v1=<hex>`. The signed payload is
// `${t}.${rawBody}`. A signature is valid when at least one `v1` matches and the
// timestamp is within `tolerance` seconds of now (default 300, Stripe's default).
export async function verifyStripeSignature(header, rawBody, secret, { tolerance = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof header !== 'string' || header === '') {
    return { ok: false, reason: 'missing Stripe-Signature header' };
  }
  const parts = header.split(',').reduce((acc, kv) => {
    const eq = kv.indexOf('=');
    if (eq === -1) return acc;
    const k = kv.slice(0, eq).trim();
    const v = kv.slice(eq + 1).trim();
    (acc[k] = acc[k] || []).push(v);
    return acc;
  }, {});
  const t = (parts.t || [])[0];
  const v1s = parts.v1 || [];
  if (!t || v1s.length === 0) return { ok: false, reason: 'signature missing t or v1' };
  const age = now - Number(t);
  if (!Number.isFinite(age) || Math.abs(age) > tolerance) {
    return { ok: false, reason: `timestamp outside tolerance (${age}s)` };
  }
  const expected = await hmacSha256Hex(secret, `${t}.${String(rawBody)}`);
  for (const v1 of v1s) {
    if (timingSafeEqual(expected, v1)) return { ok: true, event: safeJson(rawBody) };
  }
  return { ok: false, reason: 'no v1 signature matched' };
}

// Paddle: header `Paddle-Signature: ts=<unix>;h1=<hex>`. Signed payload is
// `${ts}:${rawBody}`. Same tolerance model as Stripe (default 5 min).
export async function verifyPaddleSignature(header, rawBody, secret, { tolerance = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof header !== 'string' || header === '') {
    return { ok: false, reason: 'missing Paddle-Signature header' };
  }
  const kv = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq !== -1) kv[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const ts = kv.ts;
  const h1 = kv.h1;
  if (!ts || !h1) return { ok: false, reason: 'signature missing ts or h1' };
  const age = now - Number(ts);
  if (!Number.isFinite(age) || Math.abs(age) > tolerance) {
    return { ok: false, reason: `timestamp outside tolerance (${age}s)` };
  }
  const expected = await hmacSha256Hex(secret, `${ts}:${String(rawBody)}`);
  if (timingSafeEqual(expected, h1)) return { ok: true, event: safeJson(rawBody) };
  return { ok: false, reason: 'h1 did not match' };
}

// Lemon Squeezy: header `X-Signature: <hex>` = HMAC-SHA256 of the raw body
// alone (no timestamp). No replay tolerance — callers may store event ids.
export async function verifyLemonSignature(header, rawBody, secret) {
  if (typeof header !== 'string' || header === '') {
    return { ok: false, reason: 'missing X-Signature header' };
  }
  const expected = await hmacSha256Hex(secret, String(rawBody));
  if (timingSafeEqual(expected, header.trim())) return { ok: true, event: safeJson(rawBody) };
  return { ok: false, reason: 'X-Signature did not match' };
}

// Shared: parse the body once, tolerating a non-JSON payload (a verifier must
// not throw on garbage — it returns ok:false instead).
function safeJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

// The idempotent-replay guard every payment webhook shares: one row per event
// id in `lw_webhook_events`, written with INSERT OR IGNORE so a redelivered
// event is a no-op. The caller keeps its own id/type extraction (each provider
// nests them differently) and its own `ensureSchema`; this owns the table
// shape, the 8000-char payload cap and the "was this the first time?" answer.
// Written once because the three Cashier/LS ports carried byte-identical
// copies — a change to the cap or the column list silently missed the others.
export async function ensureWebhookEventsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lw_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT,
    payload TEXT,
    received_at TEXT
  )`).run();
}

export async function recordWebhookEventOnce(env, { id, provider, type, payload, receivedAt }) {
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO lw_webhook_events (id, provider, type, payload, received_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(String(id), String(provider), String(type || ''), JSON.stringify(payload).slice(0, 8000), receivedAt).run();
  return (res.meta?.changes ?? res.changes ?? 0) > 0;
}
