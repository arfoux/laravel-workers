// tools/tests/packages-auth-billing.test.mjs — the AUTH & BILLING cluster ports.
//
// Covers the four handlers with REAL logic under test against real SQLite through
// the shared `tools/tests/_fake-d1.mjs` and a fake `fetch` (captures requests,
// returns canned responses). The ports own their DDL (`ensureSchema`), so
// ON CONFLICT / UNIQUE / ORDER BY semantics come from the engine. Every assertion
// below is driven by a signed webhook / a real handler call — no empty asserts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import bcrypt from 'bcryptjs';

import * as sanctum from '../../ports/packages/sanctum.mjs';
import * as cashierStripe from '../../ports/packages/cashier-stripe.mjs';
import * as cashierPaddle from '../../ports/packages/cashier-paddle.mjs';
import * as lemonsqueezy from '../../ports/packages/lemonsqueezy.mjs';
import {
  bearerToken,
  createPersonalAccessToken,
} from '../../kernel/packages/token.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// Node 18/20 lacks globalThis.crypto.subtle sign under some flags — pin webcrypto.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function makeReq(method, { headers = {}, body = '' } = {}) {
  return new Request('https://edge.test/hook', {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

async function signHmac(secret, message) {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fake fetch — records the request, answers with a canned JSON. Asserted below to
// prove the edge never calls a payment provider during webhook handling.
function fakeFetch(responder = () => ({ status: 200, body: '{}' })) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ url: String(input), init });
    const r = responder(input, init) || { status: 200, body: '{}' };
    return new Response(r.body, { status: r.status });
  };
  fn.calls = calls;
  return fn;
}

// ===========================================================================
// 1. laravel/sanctum v4.3.3
// ===========================================================================
test('sanctum: POST /sanctum/token issues a PAT (email+password) and stores only sha256', async () => {
  const env = { DB: new FakeD1() };
  await sanctum.ensureSchema(env);
  const hash = bcrypt.hashSync('secret123', 10);
  await env.DB.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').bind('Ada', 'ada@x.test', hash).run();

  const res = await sanctum.default(
    { request: makeReq('POST', { body: JSON.stringify({ email: 'ada@x.test', password: 'secret123' }) }), body: { email: 'ada@x.test', password: 'secret123' } },
    env
  );
  assert.equal(res.status, 201);
  const payload = JSON.parse(res.body);
  assert.match(payload.token, /^\d+\|[A-Za-z0-9]{40}$/);
  assert.equal(payload.abilities.length, 0);

  const stored = await env.DB.prepare('SELECT token FROM personal_access_tokens WHERE id = ?').bind(payload.id).first();
  assert.equal(stored.token.length, 64); // hex sha256, never the plaintext
  assert.notEqual(stored.token, payload.token);
});

test('sanctum: wrong password → 422 credentials error', async () => {
  const env = { DB: new FakeD1() };
  await sanctum.ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').bind('Ada', 'ada@x.test', bcrypt.hashSync('secret123', 10)).run();
  const res = await sanctum.default(
    { request: makeReq('POST', { body: '{}' }), body: { email: 'ada@x.test', password: 'nope' } },
    env
  );
  assert.equal(res.status, 422);
  assert.match(JSON.parse(res.body).message, /credentials do not match/);
});

test('sanctum: GET verify with Bearer → valid + abilities + last_used_at touched', async () => {
  const env = { DB: new FakeD1() };
  await sanctum.ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').bind('Ada', 'ada@x.test', bcrypt.hashSync('x', 10)).run();
  const created = await sanctum.default(
    { request: makeReq('POST', { body: '{}' }), body: { email: 'ada@x.test', password: 'x', abilities: ['read', 'write'] } },
    env
  );
  const plain = JSON.parse(created.body).token;

  const verify = await sanctum.default(
    { request: makeReq('GET', { headers: { authorization: `Bearer ${plain}` } }), params: { method: 'verify' } },
    env
  );
  assert.equal(verify.status, 200);
  const v = JSON.parse(verify.body);
  assert.equal(v.valid, true);
  assert.deepEqual(v.abilities, ['read', 'write']);

  const row = await env.DB.prepare('SELECT last_used_at FROM personal_access_tokens WHERE id = ?').bind(v.token_id).first();
  assert.ok(row.last_used_at, 'last_used_at should be set after a verify');
});

test('sanctum: verify with tampered Bearer → 401; bearerToken parses header', async () => {
  assert.equal(bearerToken('Bearer abc|def'), 'abc|def');
  assert.equal(bearerToken('Not-A-Bearer'), null);
  const env = { DB: new FakeD1() };
  await sanctum.ensureSchema(env);
  const res = await sanctum.default(
    { request: makeReq('GET', { headers: { authorization: 'Bearer 1|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }), params: { method: 'verify' } },
    env
  );
  assert.equal(res.status, 401);
});

test('sanctum: createPersonalAccessToken parity — stored = sha256(plain)', async () => {
  const { plain, row } = await createPersonalAccessToken(7, 'cli', ['read'], { id: 3, randomBytes: (a) => a.fill(65) });
  assert.equal(plain, '3|' + 'D'.repeat(40)); // 65 % 62 = 3 → ALPHANUMERIC[3] = 'D'
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(row.token, hex);
});

test('sanctum: DELETE one token revokes only that id (scoped to owner)', async () => {
  const env = { DB: new FakeD1() };
  await sanctum.ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').bind('Ada', 'ada@x.test', bcrypt.hashSync('x', 10)).run();
  const a = JSON.parse((await sanctum.default({ request: makeReq('POST', { body: '{}' }), body: { email: 'ada@x.test', password: 'x' } }, env)).body);
  const b = JSON.parse((await sanctum.default({ request: makeReq('POST', { body: '{}' }), body: { email: 'ada@x.test', password: 'x' } }, env)).body);
  const res = await sanctum.default({ request: makeReq('DELETE'), params: { id: String(a.id) }, body: { email: 'ada@x.test', password: 'x' } }, env);
  assert.equal(res.status, 200);
  const rows = (await env.DB.prepare('SELECT id FROM personal_access_tokens').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, b.id);
});

// ===========================================================================
// 2. laravel/cashier (Stripe) v16.9.0
// ===========================================================================
async function stripeRequest(env, bodyObj, { secret = 'whsec_test', tamper = false, tsOffset = 0 } = {}) {
  const raw = JSON.stringify(bodyObj);
  // Pin both the signature timestamp AND the handler's verifier clock to the same
  // second, so a second-boundary flip between signing and verifying can never
  // cause a flaky 401 (age ±301s) in the wrong-secret/valid-signature cases.
  const t = env.STRIPE_WEBHOOK_NOW ?? Math.floor(Date.now() / 1000);
  const mockT = Math.floor(Date.now() / 1000) + tsOffset;
  const sigT = Math.min(mockT, t); // tsOffset < 0 exercises stale-timestamp
  const sig = await signHmac(secret, `${sigT}.${raw}`);
  const header = `t=${sigT},v1=${tamper ? sig.replace(/^./, '0') : sig}`;
  const req = makeReq('POST', { headers: { 'stripe-signature': header }, body: raw });
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  let res;
  try {
    res = await cashierStripe.default({ request: req, params: {} }, env);
  } finally {
    globalThis.fetch = saved;
  }
  return { res, fetchCalls: globalThis.fetch };
}

test('stripe: valid signature → 200 + subscription row projected', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const event = {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { userId: 42, name: 'default' },
        subscription: {
          id: 'sub_abc',
          status: 'active',
          trial_end: null,
          cancel_at_period_end: false,
          items: { data: [{ id: 'si_1', quantity: 3, price: { id: 'price_123', product: 'prod_1' } }] },
        },
      },
    },
  };
  const { res } = await stripeRequest(env, event);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).received, true);
  const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE stripe_id = ?').bind('sub_abc').first();
  assert.equal(sub.user_id, 42);
  assert.equal(sub.stripe_status, 'active');
  assert.equal(sub.stripe_price, 'price_123');
  assert.equal(sub.quantity, 3);
});

test('stripe: bad signature → 401; wrong-secret signature → 401; missing header → 401', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_WEBHOOK_NOW: Math.floor(Date.now() / 1000) };
  const event = { id: 'evt_x', type: 'invoice.paid', data: { object: {} } };
  const raw = JSON.stringify(event);
  const t = env.STRIPE_WEBHOOK_NOW;
  const good = await signHmac('whsec_test', `${t}.${raw}`);
  const wrong = await signHmac('whsec_OTHER', `${t}.${raw}`);
  const tampered = good[0] === '9' ? good.slice(1) + '0' : good.replace(/^./, '9');
  for (const header of [`t=${t},v1=${tampered}`, `t=${t},v1=${wrong}`, '']) {
    const req = makeReq('POST', { headers: header ? { 'stripe-signature': header } : {}, body: raw });
    const res = await cashierStripe.default({ request: req, params: {} }, env);
    assert.equal(res.status, 401, `expected 401 for header ${JSON.stringify(header)}`);
  }
});

test('stripe: stale timestamp outside ±300s → 401', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const { res } = await stripeRequest(env, { id: 'evt_old', type: 'invoice.paid', data: { object: {} } }, { tsOffset: -4000 });
  assert.equal(res.status, 401);
});

test('stripe: replay of the same event id → 200 idempotent, no duplicate subscription', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const event = {
    id: 'evt_replay',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_r', status: 'active', metadata: { userId: 1 }, items: { data: [{ id: 'si', quantity: 1, price: { id: 'price_r' } }] } } },
  };
  const first = await stripeRequest(env, event);
  assert.equal(first.res.status, 200);
  assert.equal(JSON.parse(first.res.body).idempotent, undefined);
  const second = await stripeRequest(env, event);
  assert.equal(JSON.parse(second.res.body).idempotent, true);
  const subs = (await env.DB.prepare('SELECT id FROM subscriptions').all()).results;
  assert.equal(subs.length, 1);
});

test('stripe: no STRIPE_WEBHOOK_SECRET → 500 (secret read from env, never hardcoded)', async () => {
  const env = { DB: new FakeD1() };
  const res = await cashierStripe.default({ request: makeReq('POST', { body: '{}' }), params: {} }, env);
  assert.equal(res.status, 500);
});

test('stripe: subscription.deleted flips status on the existing row', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  await stripeRequest(env, {
    id: 'evt_c', type: 'checkout.session.completed',
    data: { object: { metadata: { userId: 9 }, subscription: { id: 'sub_d', status: 'active', items: { data: [{ id: 'si', quantity: 1, price: { id: 'price_d' } }] } } } },
  });
  await stripeRequest(env, {
    id: 'evt_d', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_d', status: 'canceled', metadata: { userId: 9 }, items: { data: [{ id: 'si', quantity: 1, price: { id: 'price_d' } }] } } },
  });
  const sub = await env.DB.prepare('SELECT stripe_status FROM subscriptions WHERE stripe_id = ?').bind('sub_d').first();
  assert.equal(sub.stripe_status, 'canceled');
  assert.equal((await env.DB.prepare('SELECT id FROM subscriptions').all()).results.length, 1, 'upsert, not insert');
});

// ===========================================================================
// 3. laravel/cashier-paddle v2.8.1
// ===========================================================================
async function paddleRequest(env, bodyObj, { secret = 'pdl_set_1', bad = false } = {}) {
  const raw = JSON.stringify(bodyObj);
  // Sign and verify against the same second — never flaky on a boundary flip.
  const ts = env.PADDLE_WEBHOOK_NOW ?? Math.floor(Date.now() / 1000);
  const sig = await signHmac(secret, `${ts}:${raw}`);
  const badSig = sig[0] === '3' ? sig.slice(1) + '0' : sig.replace(/^./, '3');
  const header = `ts=${ts};h1=${bad ? badSig : sig}`;
  const req = makeReq('POST', { headers: { 'paddle-signature': header }, body: raw });
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  let res;
  try {
    res = await cashierPaddle.default({ request: req, params: {} }, env);
  } finally {
    globalThis.fetch = saved;
  }
  return res;
}

test('paddle: subscription.created → 200 + paddle_subscriptions + paddle_customers rows', async () => {
  const env = { DB: new FakeD1(), PADDLE_WEBHOOK_SECRET: 'pdl_set_1' };
  const res = await paddleRequest(env, {
    event_id: 'evt_p1',
    event_type: 'subscription.created',
    data: {
      id: 'sub_p1',
      status: 'active',
      custom_data: { user_id: 55, name: 'default' },
      items: [{ price: { id: 'pri_1' }, quantity: 2 }],
      customer_id: 'ctm_1',
      trial_ends_at: '2030-01-01T00:00:00Z',
      next_billed_at: '2030-02-01T00:00:00Z',
    },
  });
  assert.equal(res.status, 200);
  const sub = await env.DB.prepare('SELECT * FROM paddle_subscriptions WHERE paddle_id = ?').bind('sub_p1').first();
  assert.equal(sub.user_id, 55);
  assert.equal(sub.status, 'active');
  assert.equal(sub.paddle_price_id, 'pri_1');
  assert.equal(sub.quantity, 2);
  const cust = await env.DB.prepare('SELECT paddle_id FROM paddle_customers WHERE paddle_id = ?').bind('ctm_1').first();
  assert.ok(cust, 'customer row written from subscription event');
});

test('paddle: bad h1 → 401; transaction.completed recorded once (idempotent)', async () => {
  const env = { DB: new FakeD1(), PADDLE_WEBHOOK_SECRET: 'pdl_set_1', PADDLE_WEBHOOK_NOW: Math.floor(Date.now() / 1000) };
  const bad = await paddleRequest(env, { event_id: 'e', event_type: 'transaction.completed', data: { id: 'txn_1' } }, { bad: true });
  assert.equal(bad.status, 401);

  const tx = { event_id: 'evt_t1', event_type: 'transaction.completed', data: { id: 'txn_1', status: 'completed', currency_code: 'USD', details: { totals: { total: '1000' } }, custom_data: { user_id: 55 } } };
  const first = await paddleRequest(env, tx);
  const second = await paddleRequest(env, tx);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(second.body).idempotent, true);
  const rows = (await env.DB.prepare('SELECT paddle_id FROM paddle_transactions').all()).results;
  assert.equal(rows.length, 1);
  const t = await env.DB.prepare('SELECT total, currency FROM paddle_transactions WHERE paddle_id = ?').bind('txn_1').first();
  assert.equal(t.total, '1000');
  assert.equal(t.currency, 'USD');
});

test('paddle: subscription status transitions (active → canceled) upsert in place', async () => {
  const env = { DB: new FakeD1(), PADDLE_WEBHOOK_SECRET: 'pdl_set_1' };
  await paddleRequest(env, { event_id: 'a', event_type: 'subscription.created', data: { id: 'sub_s', status: 'active', custom_data: { user_id: 2 }, items: [{ price: { id: 'pri' }, quantity: 1 }] } });
  await paddleRequest(env, { event_id: 'b', event_type: 'subscription.canceled', data: { id: 'sub_s', status: 'canceled', custom_data: { user_id: 2 }, items: [{ price: { id: 'pri' }, quantity: 1 }] } });
  const sub = await env.DB.prepare('SELECT status FROM paddle_subscriptions WHERE paddle_id = ?').bind('sub_s').first();
  assert.equal(sub.status, 'canceled');
  assert.equal((await env.DB.prepare('SELECT id FROM paddle_subscriptions').all()).results.length, 1);
});

// ===========================================================================
// 4. lemonsqueezy/laravel v1.9.0
// ===========================================================================
async function lemonRequest(env, bodyObj, { secret = 'ls_sec', bad = false } = {}) {
  const raw = JSON.stringify(bodyObj);
  const sig = await signHmac(secret, raw);
  const req = makeReq('POST', { headers: { 'x-signature': bad ? sig.replace(/^./, '4') : sig }, body: raw });
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  let res;
  try {
    res = await lemonsqueezy.default({ request: req, params: {} }, env);
  } finally {
    globalThis.fetch = saved;
  }
  return res;
}

test('lemon: subscription_created → 200 + subscription row (variant, status, card)', async () => {
  const env = { DB: new FakeD1(), LEMON_SQUEEZY_WEBHOOK_SECRET: 'ls_sec' };
  const res = await lemonRequest(env, {
    meta: { event_id: 'evt_l1', event_name: 'subscription_created', custom_data: { user_id: 77, name: 'pro' } },
    data: {
      id: 'sub_ls1',
      attributes: { status: 'active', variant_id: 3, quantity: 1, card_brand: 'visa', card_last_four: '4242', renews_at: '2030-03-01T00:00:00Z' },
      relationships: { product: { id: '1' }, customer: { id: 'c1' } },
    },
  });
  assert.equal(res.status, 200);
  const sub = await env.DB.prepare('SELECT * FROM lemon_squeezy_subscriptions WHERE ls_id = ?').bind('sub_ls1').first();
  assert.equal(sub.user_id, 77);
  assert.equal(sub.status, 'active');
  assert.equal(sub.card_last_four, '4242');
  assert.equal(sub.ls_variant_id, '3'); // ls_variant_id is TEXT: SQLite TEXT affinity stores the id as the string '3'
});

test('lemon: bad X-Signature → 401; order_created idempotent by meta.event_id', async () => {
  const env = { DB: new FakeD1(), LEMON_SQUEEZY_WEBHOOK_SECRET: 'ls_sec' };
  const bad = await lemonRequest(env, { meta: { event_id: 'x', event_name: 'order_created' }, data: { id: 'o1', attributes: {} } }, { bad: true });
  assert.equal(bad.status, 401);

  const order = { meta: { event_id: 'evt_o1', event_name: 'order_created', custom_data: { user_id: 77 } }, data: { id: 'o1', attributes: { total: '9900', currency: 'USD', status: 'paid', customer_name: 'Grace' } } };
  const first = await lemonRequest(env, order);
  const second = await lemonRequest(env, order);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(second.body).idempotent, true);
  assert.equal((await env.DB.prepare('SELECT ls_id FROM lemon_squeezy_orders').all()).results.length, 1);
  const o = await env.DB.prepare('SELECT total, status FROM lemon_squeezy_orders WHERE ls_id = ?').bind('o1').first();
  assert.equal(o.total, '9900');
});

test('lemon: license_key_created stores the key (never logged), update refreshes it', async () => {
  const env = { DB: new FakeD1(), LEMON_SQUEEZY_WEBHOOK_SECRET: 'ls_sec' };
  const key = (k) => ({ meta: { event_id: `evt_k_${k}`, event_name: k === 'A' ? 'license_key_created' : 'license_key_updated', custom_data: { user_id: 77 } }, data: { id: 'lic_1', attributes: { key: k, key_short: 'ABCD-1234', activation_limit: 5, instances_count: 1, status: 'active' } } });
  await lemonRequest(env, key('AAAA-BBBB-CCCC-DDDD'));
  await lemonRequest(env, key('EEEE-FFFF-GGGG-HHHH'));
  const rows = (await env.DB.prepare('SELECT ls_id, key, activation_limit FROM lemon_squeezy_license_keys').all()).results;
  assert.equal(rows.length, 1, 'same license id → upsert, not insert');
  assert.equal(rows[0].key, 'EEEE-FFFF-GGGG-HHHH');
  assert.equal(rows[0].activation_limit, 5);
});

test('lemon: subscription_updated refreshes status without a second row', async () => {
  const env = { DB: new FakeD1(), LEMON_SQUEEZY_WEBHOOK_SECRET: 'ls_sec' };
  const ev = (status, id) => ({ meta: { event_id: id, event_name: 'subscription_updated', custom_data: { user_id: 1 } }, data: { id: 'sub_u', attributes: { status, variant_id: 9, quantity: 1 } } });
  await lemonRequest(env, ev('active', 'u1'));
  await lemonRequest(env, ev('paused', 'u2'));
  const rows = (await env.DB.prepare('SELECT status FROM lemon_squeezy_subscriptions').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'paused');
});

test('lemon: no LEMON_SQUEEZY_WEBHOOK_SECRET → 500', async () => {
  const res = await lemonsqueezy.default({ request: makeReq('POST', { body: '{}' }), params: {} }, { DB: new FakeD1() });
  assert.equal(res.status, 500);
});

test('billing ports never issue an outbound subrequest while handling a webhook', async () => {
  const env = { DB: new FakeD1(), STRIPE_WEBHOOK_SECRET: 'whsec_test', PADDLE_WEBHOOK_SECRET: 'pdl', LEMON_SQUEEZY_WEBHOOK_SECRET: 'ls' };
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(String(args[0])); return new Response('{}'); };
  try {
    const stripeRaw = JSON.stringify({ id: 'e1', type: 'invoice.paid', data: { object: {} } });
    const t = Math.floor(Date.now() / 1000);
    const stripeSig = await signHmac('whsec_test', `${t}.${stripeRaw}`);
    await cashierStripe.default({ request: makeReq('POST', { headers: { 'stripe-signature': `t=${t},v1=${stripeSig}` }, body: stripeRaw }), params: {} }, env);

    const paddleRaw = JSON.stringify({ event_id: 'e2', event_type: 'transaction.completed', data: { id: 'tx', status: 'completed' } });
    const ts = Math.floor(Date.now() / 1000);
    const paddleSig = await signHmac('pdl', `${ts}:${paddleRaw}`);
    await cashierPaddle.default({ request: makeReq('POST', { headers: { 'paddle-signature': `ts=${ts};h1=${paddleSig}` }, body: paddleRaw }), params: {} }, env);

    const lemonRaw = JSON.stringify({ meta: { event_id: 'e3', event_name: 'order_created' }, data: { id: 'o', attributes: {} } });
    const lemonSig = await signHmac('ls', lemonRaw);
    await lemonsqueezy.default({ request: makeReq('POST', { headers: { 'x-signature': lemonSig }, body: lemonRaw }), params: {} }, env);
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(calls, [], 'webhook handlers must stay on D1 + HMAC, no provider round-trip');
});
