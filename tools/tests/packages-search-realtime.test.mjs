// tools/tests/packages-search-realtime.test.mjs — cluster B (search & realtime).
// Run: node --test tools/tests/packages-search-realtime.test.mjs
//
// Every test injects a fake `env.DB` (in-memory D1) and a fake `fetchImpl`
// (records the outgoing request, returns a canned response) so nothing touches
// the network. Broadcast signing is additionally cross-checked against
// node:crypto HMAC-SHA256 / MD5 to prove byte-parity with the PHP SDK.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import meilisearch, { searchMeilisearch, putSettings, ensureSchema as meiliEnsure } from '../../ports/packages/scout-meilisearch.mjs';
import algolia from '../../ports/packages/scout-algolia.mjs';
import pusher, { handleBroadcastingAuth, triggerEvent } from '../../ports/packages/pusher.mjs';
import reverb from '../../ports/packages/reverb.mjs';
import { buildAuthQueryString, signChannelAuth } from '../../kernel/packages/broadcast.mjs';

// ── Fake D1 (in-memory) ──────────────────────────────────────────────────────
// Minimal prepare(sql).bind(...).all()/first()/run() over a map of tables. Only
// the statements the handlers emit are supported: CREATE TABLE IF NOT EXISTS,
// INSERT INTO ... VALUES (?, ?, ?), SELECT ... FROM t.
class FakeD1 {
  constructor() {
    this.tables = new Map();
    this.queries = [];
  }
  _ensure(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }
  prepare(sql) {
    const self = this;
    const clean = sql.replace(/\s+/g, ' ').trim();
    const isCreate = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(clean);
    const isInsert = /^INSERT INTO (\w+)/i.exec(clean);
    const isSelect = /^SELECT .+ FROM (\w+)/i.exec(clean);
    const table = isCreate?.[1] ?? isInsert?.[1] ?? isSelect?.[1] ?? null;
    return {
      sql: clean,
      binds: [],
      bind(...args) { this.binds = args; return this; },
      async run() {
        self.queries.push({ sql: this.sql, binds: this.binds });
        if (isCreate) { self._ensure(table); return { success: true }; }
        if (isInsert) {
          const rows = self._ensure(table);
          const cols = /^INSERT INTO \w+ \(([^)]+)\)/i.exec(clean)?.[1].split(',').map((c) => c.trim()) ?? [];
          const row = {};
          cols.forEach((c, i) => { row[c] = this.binds[i]; });
          row.id = rows.length + 1;
          rows.push(row);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true };
      },
      async all() {
        await this.run();
        const rows = table ? (self.tables.get(table) ?? []) : [];
        return { results: rows };
      },
      async first() {
        const { results } = await this.all();
        return results[0] ?? null;
      },
    };
  }
}

// ── Fake fetch ───────────────────────────────────────────────────────────────
// Records every outgoing request; returns a canned response per URL pattern.
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, ...init };
    calls.push(call);
    const res = handler ? await handler(call) : null;
    return res ?? jsonResponse({});
  };
  fn.calls = calls;
  return fn;
}

const json = (r) => JSON.parse(r.body);

// ═══ MD5 pinning (official RFC 1321 vectors) ═══════════════════════════════
test('broadcast md5 (via body_md5) matches official RFC 1321 vectors', async () => {
  // buildAuthQueryString signs the query string; body_md5 is embedded in it.
  // Cross-check the embedded md5 against node:crypto for the pinned vectors.
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ];
  for (const [msg, expected] of vectors) {
    assert.equal(createHash('md5').update(msg).digest('hex'), expected, `node:crypto sanity ${JSON.stringify(msg)}`);
    const qs = await buildAuthQueryString('k', 's', msg, { timestamp: 0 });
    const got = /body_md5=([0-9a-f]{32})/.exec(qs)?.[1];
    assert.equal(got, expected, `md5(${JSON.stringify(msg)})`);
  }
});

// ═══ (1) Scout + Meilisearch ═════════════════════════════════════════════════
test('meilisearch: POST /indexes/{uid}/search, preserves hits/estimatedTotalHits', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    hits: [{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }],
    estimatedTotalHits: 42,
    processingTimeMs: 3,
  }));
  const db = new FakeD1();
  const ctx = { query: { q: 'wid', limit: '10' }, request: {}, body: '', fetchImpl };
  const res = await meilisearch(ctx, { MEILISEARCH_HOST: 'https://meili.example.com', MEILISEARCH_KEY: 'mk', DB: db });
  assert.equal(res.status, 200);
  const body = json(res);
  assert.deepEqual(body.hits, [{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }]);
  assert.equal(body.estimatedTotalHits, 42);
  assert.equal(body.processingTimeMs, 3);

  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://meili.example.com/indexes/default/search');
  assert.equal(call.headers.authorization, 'Bearer mk');
  assert.deepEqual(JSON.parse(call.body), { q: 'wid', limit: 10 });
});

test('meilisearch: index/filter/sort forwarded; search logged to D1', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }));
  const db = new FakeD1();
  await meiliEnsure({ DB: db });
  const ctx = {
    query: { q: 'x', index: 'products', filter: 'price > 10', sort: 'price:asc,name:desc' },
    request: {}, fetchImpl,
  };
  await meilisearch(ctx, { MEILISEARCH_HOST: 'https://m.test', DB: db });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://m.test/indexes/products/search');
  assert.deepEqual(JSON.parse(call.body), { q: 'x', filter: 'price > 10', sort: ['price:asc', 'name:desc'] });
  const logRows = db.tables.get('scout_search_log');
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].index_uid, 'products');
  assert.equal(logRows[0].q, 'x');
  assert.equal(logRows[0].hits, 0);
});

test('meilisearch: putSettings PUTs /settings with auth', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ taskUid: 7 }, 202));
  await putSettings(
    { MEILISEARCH_HOST: 'https://m.test', MEILISEARCH_KEY: 'mk' },
    'products',
    { searchableAttributes: ['name'] },
    fetchImpl,
  );
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, 'https://m.test/indexes/products/settings');
  assert.deepEqual(JSON.parse(call.body), { searchableAttributes: ['name'] });
});

test('meilisearch: upstream error → 502 with message', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ message: 'index not found' }, 404));
  const res = await meilisearch(
    { query: { q: 'z' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  assert.equal(res.status, 502);
  assert.match(json(res).error, /index not found/);
});

test('meilisearch: missing host → 502', async () => {
  const res = await meilisearch({ query: { q: 'z' }, request: {}, fetchImpl: fakeFetch() }, {});
  assert.equal(res.status, 502);
});

// ═══ (2) Scout + Algolia ════════════════════════════════════════════════════
test('algolia: POST /1/indexes/{name}/query with X-Algolia-* headers, preserves hits/nbHits', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    hits: [{ objectID: 'a' }], nbHits: 10, page: 0, nbPages: 1, params: 'query=foo', facets: { color: { red: 3 } },
  }));
  const env = { ALGOLIA_APP_ID: 'APPID', ALGOLIA_KEY: 'AKEY' };
  const ctx = {
    params: { name: 'products' },
    request: { headers: { 'x-algolia-application-id': 'APPID', 'x-algolia-api-key': 'AKEY' } },
    body: JSON.stringify({ query: 'foo', attributesToRetrieve: ['name'] }),
    fetchImpl,
  };
  const res = await algolia(ctx, env);
  assert.equal(res.status, 200);
  const body = json(res);
  assert.deepEqual(body.hits, [{ objectID: 'a' }]);
  assert.equal(body.nbHits, 10);
  assert.equal(body.params, 'query=foo');
  assert.deepEqual(body.facets, { color: { red: 3 } });

  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://APPID-dsn.algolia.net/1/indexes/products/query');
  assert.equal(call.headers['x-algolia-application-id'], 'APPID');
  assert.equal(call.headers['x-algolia-api-key'], 'AKEY');
  assert.deepEqual(JSON.parse(call.body), { attributesToRetrieve: ['name'], query: 'foo' });
});

test('algolia: app id mismatch → 403', async () => {
  const ctx = {
    params: { name: 'p' },
    request: { headers: { 'x-algolia-application-id': 'WRONG' } },
    body: '{}', fetchImpl: fakeFetch(),
  };
  const res = await algolia(ctx, { ALGOLIA_APP_ID: 'APPID', ALGOLIA_KEY: 'AKEY' });
  assert.equal(res.status, 403);
});

test('algolia: absent credentials → 403 (never proxied through the worker secret)', async () => {
  const env = { ALGOLIA_APP_ID: 'APPID', ALGOLIA_KEY: 'AKEY' };

  // No headers at all: previously the two presented-only checks both passed and
  // the request went upstream with the worker's own key.
  const bare = fakeFetch();
  const noHeaders = await algolia({ params: { name: 'p' }, request: { headers: {} }, body: '{}', fetchImpl: bare }, env);
  assert.equal(noHeaders.status, 403);
  assert.equal(bare.calls.length, 0);

  // App id present but key omitted — same fail-open shape.
  const halfKey = fakeFetch();
  const keyless = await algolia(
    { params: { name: 'p' }, request: { headers: { 'x-algolia-application-id': 'APPID' } }, body: '{}', fetchImpl: halfKey },
    env,
  );
  assert.equal(keyless.status, 403);
  assert.equal(halfKey.calls.length, 0);

  // Right app id, wrong key.
  const wrongKey = fakeFetch();
  const mismatched = await algolia(
    { params: { name: 'p' }, request: { headers: { 'x-algolia-application-id': 'APPID', 'x-algolia-api-key': 'NOPE' } }, body: '{}', fetchImpl: wrongKey },
    env,
  );
  assert.equal(mismatched.status, 403);
  assert.equal(wrongKey.calls.length, 0);
});

test('algolia: missing secrets → 500', async () => {
  const res = await algolia({ params: { name: 'p' }, request: { headers: {} }, body: '{}', fetchImpl: fakeFetch() }, {});
  assert.equal(res.status, 500);
});

// ═══ (3) pusher-php-server ══════════════════════════════════════════════════
test('pusher: private channel auth token byte-parity with node:crypto HMAC', async () => {
  const key = 'pusherkey', secret = 'pushersecret';
  const socketId = '1234.5678', channel = 'private-orders';
  const res = await handleBroadcastingAuth(
    { body: new URLSearchParams({ socket_id: socketId, channel_name: channel }), request: {}, user: async () => ({ id: 3 }) },
    { PUSHER_KEY: key, PUSHER_SECRET: secret, PUSHER_APP_ID: 'app', PUSHER_CLUSTER: 'mt1' },
  );
  assert.equal(res.status, 200);
  const { auth } = json(res);
  const expected = `${key}.` + createHmac('sha256', secret).update(`${socketId}:${channel}`).digest('hex');
  assert.equal(auth, expected);
});

// The presence `user_id` is the platform guard's (`$user->getAuthIdentifier()` in
// `PusherBroadcaster::validAuthenticationResponse()`), never a value the caller
// sent: a client-supplied `channel_data.user_id` used to be embedded verbatim, so
// any caller could join a presence channel as any user.
test('pusher: presence channel embeds the guard user id and ignores body channel_data', async () => {
  const key = 'k', secret = 's';
  const socketId = '1.1', channel = 'presence-room';
  const spoof = Buffer.from(JSON.stringify({ user_id: 999, user_info: { name: 'Mallory' } })).toString('base64');
  const res = await handleBroadcastingAuth(
    { body: new URLSearchParams({ socket_id: socketId, channel_name: channel, channel_data: spoof }), request: {}, user: async () => ({ id: 42 }) },
    { PUSHER_KEY: key, PUSHER_SECRET: secret, PUSHER_APP_ID: 'app' },
  );
  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.auth, `${key}.` + createHmac('sha256', secret).update(`${socketId}:${channel}`).digest('hex'));
  assert.deepEqual(JSON.parse(body.channel_data), { user_id: 42 });
});

test('pusher: guarded channel with no identity → 401; public channel → 403; missing fields → 422', async () => {
  const env = { PUSHER_KEY: 'k', PUSHER_SECRET: 's', PUSHER_APP_ID: 'a' };
  const anon = await handleBroadcastingAuth({ body: new URLSearchParams({ socket_id: '1.1', channel_name: 'private-x' }), request: {} }, env);
  assert.equal(anon.status, 401);
  const pub = await handleBroadcastingAuth({ body: new URLSearchParams({ socket_id: '1.1', channel_name: 'public-x' }), request: {} }, env);
  assert.equal(pub.status, 403);
  const missing = await handleBroadcastingAuth({ body: new URLSearchParams({ socket_id: '1.1' }), request: {}, user_id: 1 }, env);
  assert.equal(missing.status, 422);
});

test('pusher: triggerEvent signs REST query byte-parity and POSTs to api-{cluster}', async () => {
  const key = 'k', secret = 's', appId = 'app1', cluster = 'eu';
  const payload = JSON.stringify({ name: 'OrderPlaced', channel: 'private-orders', data: { id: 9 } });
  const fetchImpl = fakeFetch(() => jsonResponse({ event_ids: { 'private-orders': 'e1' } }));
  const result = await triggerEvent({ PUSHER_KEY: key, PUSHER_SECRET: secret, PUSHER_APP_ID: appId, PUSHER_CLUSTER: cluster }, { channel: 'private-orders', name: 'OrderPlaced', data: { id: 9 } }, fetchImpl);
  assert.deepEqual(result, { event_ids: { 'private-orders': 'e1' } });

  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url.startsWith(`https://api-${cluster}.pusher.com/apps/${appId}/events?`), true);
  assert.equal(call.body, payload);

  // Verify the auth query string against node:crypto HMAC.
  const url = new URL(call.url);
  const md5 = createHash('md5').update(payload).digest('hex');
  const toSign = `auth_key=${key}&auth_timestamp=${url.searchParams.get('auth_timestamp')}&auth_version=1.0&body_md5=${md5}`;
  const sig = createHmac('sha256', secret).update(toSign).digest('hex');
  assert.equal(url.searchParams.get('auth_signature'), sig);
  assert.equal(url.searchParams.get('body_md5'), md5);
  assert.equal(url.searchParams.get('auth_key'), key);
});

test('pusher: POST /broadcast handler records event to D1', async () => {
  const db = new FakeD1();
  const fetchImpl = fakeFetch(() => jsonResponse({ event_ids: { c: 'x' } }));
  const res = await pusher(
    { body: { channel: 'private-c', name: 'Ev', data: { a: 1 } }, request: {}, fetchImpl, user_id: 1 },
    { PUSHER_KEY: 'k', PUSHER_SECRET: 's', PUSHER_APP_ID: 'a', DB: db },
  );
  assert.equal(res.status, 200);
  assert.equal(db.tables.get('pusher_events').length, 1);
  assert.equal(db.tables.get('pusher_events')[0].channel, 'private-c');
});

test('pusher: POST /broadcast without an identity is 401 and never triggers', async () => {
  const db = new FakeD1();
  const fetchImpl = fakeFetch(() => jsonResponse({ event_ids: { c: 'x' } }));
  const res = await pusher(
    { body: { channel: 'private-c', name: 'Ev', data: { a: 1 } }, request: {}, fetchImpl },
    { PUSHER_KEY: 'k', PUSHER_SECRET: 's', PUSHER_APP_ID: 'a', DB: db },
  );
  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0, 'no Pusher call for an anonymous caller');
  assert.equal((db.tables.get('pusher_events') || []).length, 0);
});

// ═══ (4) laravel/reverb auth-half ═══════════════════════════════════════════
test('reverb: private channel auth token byte-parity with node:crypto HMAC', async () => {
  const key = 'rk', secret = 'rs';
  const socketId = '99.1', channel = 'private-dash';
  const res = await reverb(
    { body: new URLSearchParams({ socket_id: socketId, channel_name: channel }), request: {}, user_id: 5 },
    { REVERB_KEY: key, REVERB_SECRET: secret },
  );
  assert.equal(res.status, 200);
  const { auth } = json(res);
  const expected = `${key}.` + createHmac('sha256', secret).update(`${socketId}:${channel}`).digest('hex');
  assert.equal(auth, expected);
});

test('reverb: presence channel returns the guard identity, not the body channel_data; public → 403', async () => {
  const env = { REVERB_KEY: 'rk', REVERB_SECRET: 'rs' };
  const spoof = Buffer.from(JSON.stringify({ user_id: 999 })).toString('base64');
  const res = await reverb(
    { body: new URLSearchParams({ socket_id: '1.1', channel_name: 'presence-x', channel_data: spoof }), request: {}, user: async () => ({ id: 7 }) },
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(json(res).channel_data), { user_id: 7 });
  const anon = await reverb({ body: new URLSearchParams({ socket_id: '1.1', channel_name: 'private-x' }), request: {} }, env);
  assert.equal(anon.status, 401);
  const pub = await reverb({ body: new URLSearchParams({ socket_id: '1.1', channel_name: 'public-x' }), request: {} }, env);
  assert.equal(pub.status, 403);
});

test('reverb: missing secrets → 500', async () => {
  const res = await reverb({ body: new URLSearchParams({ socket_id: '1.1', channel_name: 'private-x' }), request: {} }, {});
  assert.equal(res.status, 500);
});

test('broadcast: signChannelAuth cross-checked vs node:crypto (no userData)', async () => {
  const { auth } = await signChannelAuth('K', 'S', '10.20', 'private-z');
  assert.equal(auth, 'K.' + createHmac('sha256', 'S').update('10.20:private-z').digest('hex'));
});
