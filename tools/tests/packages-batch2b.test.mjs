// tools/tests/packages-batch2b.test.mjs — real tests for the batch-2b Spatie
// data/utility cluster: query-builder, translatable, model-states, enum, sitemap.
//
// Drives each handler against real SQLite through the shared
// `tools/tests/_fake-d1.mjs`. The ports own their DDL (`ensureSchema`), so the
// ON CONFLICT / IN / LIKE / json_extract / ORDER BY semantics are SQLite's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import qbHandler, { parseQueryBuilderRequest, buildSql, ensureSchema } from '../../ports/packages/spatie-query-builder.mjs';
import trHandler, { getTranslation } from '../../ports/packages/spatie-translatable.mjs';
import msHandler, { allowedTargets, canTransitionTo } from '../../ports/packages/spatie-model-states.mjs';
import enHandler, { defineEnum } from '../../ports/packages/spatie-enum.mjs';
import smHandler, { renderSitemapXml } from '../../ports/packages/spatie-sitemap.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------
function makeCtx(method, path, { query = '', body = null, params = {} } = {}) {
  const url = 'http://edge.test' + path + (query ? '?' + query : '');
  return {
    request: { method, url },
    body,
    params,
  };
}
function env() { return { DB: new FakeD1() }; }

// ===========================================================================
// query-builder
// ===========================================================================
test('query-builder: parseQueryBuilderRequest reads filter/sort/fields/append', () => {
  const sp = new URLSearchParams('filter[status]=published&filter[title]=lar&sort=-created_at,title&fields[posts]=id,title&append=excerpt');
  const p = parseQueryBuilderRequest(sp);
  assert.deepEqual(p.filters, { status: 'published', title: 'lar' });
  assert.deepEqual(p.sorts, ['-created_at', 'title']);
  assert.deepEqual(p.fields, ['id', 'title']);
  assert.deepEqual(p.appends, ['excerpt']);
});

test('query-builder: buildSql exact + partial + IN + sort + fields + allowlist', () => {
  const config = {
    exactFilters: ['status'], partialFilters: ['title'],
    allowSorts: ['id', 'created_at'], allowFields: ['id', 'title'],
  };
  const parsed = parseQueryBuilderRequest(new URLSearchParams('filter[status]=draft,published&filter[title]=lar&filter[hack]=x&sort=-created_at,badcol&fields=id,title,secret&append=nope'));
  const { sql, params } = buildSql('posts', parsed, config);
  assert.match(sql, /SELECT id, title FROM posts/);
  assert.match(sql, /status IN \(\?, \?\)/);
  assert.match(sql, /title LIKE \?/);
  assert.match(sql, /ORDER BY created_at DESC/);
  assert.equal(params[0], 'draft');
  assert.equal(params[1], 'published');
  assert.equal(params[2], '%lar%');
  // disallowed sort/filter/field never reaches SQL
  assert.doesNotMatch(sql, /hack|badcol|secret/);
});

test('query-builder: handler filters, sorts, selects, appends', async () => {
  const e = env();
  await ensureSchema(e); // the port's own DDL, applied before the direct seed
  // seed directly
  for (const p of [
    { title: 'Laravel tips', status: 'published', author_id: 1 },
    { title: 'D1 internals', status: 'draft', author_id: 2 },
    { title: 'Laravel queue', status: 'published', author_id: 1 },
  ]) {
    await e.DB.prepare('INSERT INTO posts (title, status, author_id) VALUES (?, ?, ?)').bind(p.title, p.status, p.author_id).run();
  }
  const res = await qbHandler(makeCtx('GET', '/posts', {
    query: 'filter[status]=published&filter[title]=laravel&sort=-id&fields=id,title,status&append=excerpt,is_published',
  }), e);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.applied.filters.sort(), ['status', 'title']);
  assert.deepEqual(payload.applied.sorts, ['-id']);
  assert.deepEqual(payload.data, [
    { id: 3, title: 'Laravel queue', status: 'published', excerpt: 'Laravel queue', is_published: true },
    { id: 1, title: 'Laravel tips', status: 'published', excerpt: 'Laravel tips', is_published: true },
  ]);
});

test('query-builder: disallowed filter is ignored (returns unfiltered)', async () => {
  const e = env();
  await ensureSchema(e);
  await e.DB.prepare('INSERT INTO posts (title, status, author_id) VALUES (?, ?, ?)').bind('A', 'draft', 1).run();
  await e.DB.prepare('INSERT INTO posts (title, status, author_id) VALUES (?, ?, ?)').bind('B', 'published', 1).run();
  const res = await qbHandler(makeCtx('GET', '/posts', { query: 'filter[secret_column]=x' }), e);
  const payload = JSON.parse(res.body);
  assert.equal(payload.data.length, 2); // secret_column not allowlisted -> ignored
  assert.deepEqual(payload.applied.filters, []);
});

// ===========================================================================
// translatable
// ===========================================================================
test('translatable: getTranslation resolves locale + fallback + null', () => {
  const j = JSON.stringify({ en: 'Hello', nl: 'Hallo' });
  assert.equal(getTranslation(j, 'nl'), 'Hallo');
  assert.equal(getTranslation(j, 'fr'), 'Hello'); // fallback en
  assert.equal(getTranslation(j, 'fr', { fallback: false }), null);
  assert.equal(getTranslation(JSON.stringify({ nl: 'Hallo' }), 'nl'), 'Hallo');
});

test('translatable: create + list resolve locale with fallback', async () => {
  const e = env();
  const res = await trHandler(makeCtx('POST', '/translatable', {
    body: { title: { en: 'Hello', nl: 'Hallo' }, body: { en: 'World' } },
  }), e);
  assert.equal(res.status, 201);
  const created = JSON.parse(res.body);
  assert.equal(created.title, 'Hello'); // resolved to fallback en
  assert.equal(created.translations.title.nl, 'Hallo');

  const list = await trHandler(makeCtx('GET', '/translatable', { query: 'locale=nl' }), e);
  const lp = JSON.parse(list.body);
  assert.equal(lp.locale, 'nl');
  assert.equal(lp.data[0].title, 'Hallo');
  assert.equal(lp.data[0].body, 'World'); // nl missing -> fallback en 'World'
});

test('translatable: single + fallback=false yields null', async () => {
  const e = env();
  await trHandler(makeCtx('POST', '/translatable', { body: { title: { en: 'Hi' }, body: {} } }), e);
  const res = await trHandler(makeCtx('GET', '/translatable/1', { query: 'locale=fr&fallback=false' }), e);
  const p = JSON.parse(res.body);
  assert.equal(p.title, null);
});

test('translatable: PUT setTranslation merges without clobbering', async () => {
  const e = env();
  await trHandler(makeCtx('POST', '/translatable', { body: { title: { en: 'Hello' } } }), e);
  const res = await trHandler(makeCtx('PUT', '/translatable/1', { query: 'locale=en', body: { title: { nl: 'Hallo', fr: 'Bonjour' } } }), e);
  const p = JSON.parse(res.body);
  assert.equal(p.translations.title.en, 'Hello'); // preserved
  assert.equal(p.translations.title.nl, 'Hallo'); // added
  assert.equal(p.translations.title.fr, 'Bonjour'); // added
});

test('translatable: search whereTranslationLike via json_extract', async () => {
  const e = env();
  await trHandler(makeCtx('POST', '/translatable', { body: { title: { en: 'Laravel tips' } } }), e);
  await trHandler(makeCtx('POST', '/translatable', { body: { title: { en: 'D1 internals' } } }), e);
  await trHandler(makeCtx('POST', '/translatable', { body: { title: { nl: 'Laravel wachtrij' } } }), e);
  const res = await trHandler(makeCtx('GET', '/translatable-search', { query: 'column=title&locale=en&q=laravel' }), e);
  const p = JSON.parse(res.body);
  assert.equal(p.query.sql.includes("json_extract(title, '$.en') LIKE ?"), true);
  assert.equal(p.data.length, 1); // only 'Laravel tips' matches en LIKE %laravel%
  assert.equal(p.data[0].title, 'Laravel tips');
});

// ===========================================================================
// model-states
// ===========================================================================
test('model-states: create defaults to draft; transitions list allowed targets', async () => {
  const e = env();
  const c = await msHandler(makeCtx('POST', '/state-models', { body: { title: 'Post' } }), e);
  assert.equal(c.status, 201);
  const row = JSON.parse(c.body);
  assert.equal(row.state, 'draft');

  const t = await msHandler(makeCtx('GET', '/state-models/1/transitions'), e);
  const tp = JSON.parse(t.body);
  assert.equal(tp.from, 'draft');
  assert.deepEqual(tp.allowed_targets, ['pending_review']);
});

test('model-states: legal transition draft->pending_review', async () => {
  const e = env();
  await msHandler(makeCtx('POST', '/state-models', { body: { title: 'P' } }), e);
  const res = await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'pending_review' } }), e);
  assert.equal(res.status, 200);
  const p = JSON.parse(res.body);
  assert.equal(p.data.state, 'pending_review');
  assert.equal(p.transitioned_to, 'pending_review');
});

test('model-states: illegal transition returns TransitionNotAllowed FQCN', async () => {
  const e = env();
  await msHandler(makeCtx('POST', '/state-models', { body: { title: 'P' } }), e);
  const res = await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'published' } }), e);
  assert.equal(res.status, 500);
  const p = JSON.parse(res.body);
  assert.equal(p.exception, 'Spatie\\ModelStates\\Exceptions\\TransitionNotAllowed');
  assert.equal(p.from, 'draft');
  assert.equal(p.to, 'published');
});

test('model-states: unknown target state also refused with TransitionNotAllowed', async () => {
  const e = env();
  await msHandler(makeCtx('POST', '/state-models', { body: { title: 'P' } }), e);
  const res = await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'nonexistent' } }), e);
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).exception, 'Spatie\\ModelStates\\Exceptions\\TransitionNotAllowed');
});

test('model-states: full chain + archive back to draft', async () => {
  const e = env();
  await msHandler(makeCtx('POST', '/state-models', { body: { title: 'P' } }), e);
  assert.equal(canTransitionTo('draft', 'published'), false);
  await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'pending_review' } }), e);
  await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'published' } }), e);
  const one = JSON.parse((await msHandler(makeCtx('GET', '/state-models/1'), e)).body);
  assert.equal(one.data.state, 'published');
  assert.deepEqual(allowedTargets('published'), ['draft']);
  await msHandler(makeCtx('POST', '/state-models/1/transition', { body: { to: 'draft' } }), e);
  const back = JSON.parse((await msHandler(makeCtx('GET', '/state-models/1'), e)).body);
  assert.equal(back.data.state, 'draft');
});

// ===========================================================================
// enum
// ===========================================================================
test('enum: toArray/values/names + pure defineEnum.from/tryFrom/random', () => {
  const E = defineEnum('E', { A: 'a', B: 'b' });
  assert.deepEqual(E.toArray(), { A: 'a', B: 'b' });
  assert.deepEqual(E.values(), ['a', 'b']);
  assert.deepEqual(E.names(), ['A', 'B']);
  assert.deepEqual(E.from('a'), { class: 'E', name: 'A', value: 'a' });
  assert.equal(E.tryFrom('zzz'), null);
  assert.throws(() => E.from('zzz'), (err) => err.phpException === 'ValueError');
  const r = E.random();
  assert.ok(['a', 'b'].includes(r.value));
});

test('enum: handler toArray/values/names over HTTP', async () => {
  const res = await enHandler(makeCtx('GET', '/enums/UserStatus'), { DB: null });
  const p = JSON.parse(res.body);
  assert.equal(p.class, 'UserStatus');
  assert.deepEqual(p.values, ['active', 'inactive', 'banned']);
  assert.deepEqual(p.names, ['ACTIVE', 'INACTIVE', 'BANNED']);
  assert.equal(p.toArray.ACTIVE, 'active');
});

test('enum: from valid -> instance; from invalid -> 422 ValueError', async () => {
  const ok = await enHandler(makeCtx('POST', '/enums/UserStatus/from', { body: { value: 'banned' } }), { DB: null });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).name, 'BANNED');

  const bad = await enHandler(makeCtx('POST', '/enums/UserStatus/from', { body: { value: 'nope' } }), { DB: null });
  assert.equal(bad.status, 422);
  const bp = JSON.parse(bad.body);
  assert.equal(bp.phpException, 'ValueError');
  assert.match(bp.message, /not a valid backing value/);
});

test('enum: tryFrom returns instance or null', async () => {
  const good = JSON.parse((await enHandler(makeCtx('POST', '/enums/OrderStatus/tryFrom', { body: { value: 'paid' } }), { DB: null })).body);
  assert.equal(good.result.name, 'PAID');
  const bad = JSON.parse((await enHandler(makeCtx('POST', '/enums/OrderStatus/tryFrom', { body: { value: 'zzz' } }), { DB: null })).body);
  assert.equal(bad.result, null);
});

test('enum: random over HTTP + unknown class 404 + index', async () => {
  const r = JSON.parse((await enHandler(makeCtx('GET', '/enums/UserStatus/random'), { DB: null })).body);
  assert.equal(r.class, 'UserStatus');
  assert.ok(['active', 'inactive', 'banned'].includes(r.value));

  const nf = await enHandler(makeCtx('GET', '/enums/Nope'), { DB: null });
  assert.equal(nf.status, 404);

  const idx = JSON.parse((await enHandler(makeCtx('GET', '/enums'), { DB: null })).body);
  assert.deepEqual(idx.enums, ['UserStatus', 'OrderStatus']);
});

// ===========================================================================
// sitemap
// ===========================================================================
test('sitemap: POST upsert + GET /sitemap.xml renders XML', async () => {
  const e = env();
  await smHandler(makeCtx('POST', '/sitemap', { body: { loc: 'https://x.test/a', lastmod: '2024-01-01T00:00:00+00:00', changefreq: 'daily', priority: '1.0' } }), e);
  await smHandler(makeCtx('POST', '/sitemap', { body: { loc: 'https://x.test/b' } }), e);
  const res = await smHandler(makeCtx('GET', '/sitemap.xml'), e);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/xml/);
  assert.match(res.body, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(res.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(res.body, /<loc>https:\/\/x\.test\/a<\/loc>/);
  assert.match(res.body, /<lastmod>2024-01-01T00:00:00\+00:00<\/lastmod>/);
  assert.match(res.body, /<changefreq>daily<\/changefreq>/);
  assert.match(res.body, /<\/urlset>/);
  // b has no lastmod/changefreq/priority supplied -> defaults lastmod only
  assert.match(res.body, /<loc>https:\/\/x\.test\/b<\/loc>/);
});

test('sitemap: upsert by loc updates lastmod without duplicating', async () => {
  const e = env();
  await smHandler(makeCtx('POST', '/sitemap', { body: { loc: 'https://x.test/a', lastmod: '2024-01-01T00:00:00+00:00' } }), e);
  await smHandler(makeCtx('POST', '/sitemap', { body: { loc: 'https://x.test/a', lastmod: '2024-02-02T00:00:00+00:00' } }), e);
  const list = JSON.parse((await smHandler(makeCtx('GET', '/sitemap'), e)).body);
  assert.equal(list.count, 1);
  assert.equal(list.urls[0].lastmod, '2024-02-02T00:00:00+00:00');
});

test('sitemap: renderSitemapXml escapes XML entities in loc', () => {
  const xml = renderSitemapXml([{ loc: 'https://x.test/a?b=1&c=2', lastmod: '2024-01-01T00:00:00+00:00' }]);
  assert.match(xml, /<loc>https:\/\/x\.test\/a\?b=1&amp;c=2<\/loc>/);
  assert.doesNotMatch(xml, /a\?b=1&c=2</);
});

test('sitemap: DELETE removes a URL; missing loc -> 422', async () => {
  const e = env();
  await smHandler(makeCtx('POST', '/sitemap', { body: { loc: 'https://x.test/a' } }), e);
  const del = await smHandler(makeCtx('DELETE', '/sitemap', { query: 'loc=https://x.test/a' }), e);
  assert.equal(del.status, 200);
  const list = JSON.parse((await smHandler(makeCtx('GET', '/sitemap'), e)).body);
  assert.equal(list.count, 0);
  const bad = await smHandler(makeCtx('DELETE', '/sitemap'), e);
  assert.equal(bad.status, 422);
});