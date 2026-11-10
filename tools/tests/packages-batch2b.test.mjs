// tools/tests/packages-batch2b.test.mjs — real tests for the batch-2b Spatie
// data/utility cluster: query-builder, translatable, model-states, enum, sitemap.
//
// Drives each handler with a fake in-memory D1 (env.DB implementing
// prepare(sql).bind(...).all()/first()/run() over a row map) supporting exactly
// the SQL subset these handlers emit (CREATE TABLE, INSERT [ON CONFLICT],
// UPDATE, DELETE, SELECT with =/IN/LIKE/json_extract, ORDER BY).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import qbHandler, { parseQueryBuilderRequest, buildSql } from '../../ports/packages/spatie-query-builder.mjs';
import trHandler, { getTranslation } from '../../ports/packages/spatie-translatable.mjs';
import msHandler, { allowedTargets, canTransitionTo } from '../../ports/packages/spatie-model-states.mjs';
import enHandler, { defineEnum } from '../../ports/packages/spatie-enum.mjs';
import smHandler, { renderSitemapXml } from '../../ports/packages/spatie-sitemap.mjs';

// ---------------------------------------------------------------------------
// Fake D1 — a small SQL interpreter for the statements this cluster emits.
// ---------------------------------------------------------------------------
class FakeD1 {
  constructor() { this.tables = new Map(); this.autoinc = new Map(); }
  _t(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }
  prepare(sql) {
    const self = this;
    const stmt = {
      _sql: sql.trim().replace(/;\s*$/, ''),
      _params: [],
      bind(...p) { this._params = p; return this; },
      async run() { return self._exec(this._sql, this._params); },
      async all() { return self._exec(this._sql, this._params); },
      async first() {
        const r = await self._exec(this._sql, this._params);
        return (r && Array.isArray(r.results)) ? (r.results[0] ?? null) : null;
      },
    };
    return stmt;
  }
  _exec(sql, params) {
    const u = sql.toUpperCase();
    if (u.startsWith('CREATE TABLE')) return { changes: 0 };
    if (u.startsWith('INSERT')) return this._insert(sql, params);
    if (u.startsWith('UPDATE')) return this._update(sql, params);
    if (u.startsWith('DELETE')) return this._delete(sql, params);
    if (u.startsWith('SELECT')) return this._select(sql, params);
    throw new Error(`FakeD1: unsupported: ${sql}`);
  }
  _insert(sql, params) {
    const m = sql.match(/INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]*)\)([\s\S]*)/i);
    if (!m) throw new Error(`FakeD1: bad INSERT: ${sql}`);
    const table = m[1];
    const cols = m[2].split(',').map((c) => c.trim().replace(/"/g, ''));
    const valueCount = m[3].split(',').length;
    const tail = m[4] || '';
    const rows = this._t(table);
    // conflict target (only loc used here)
    const cm = tail.match(/ON CONFLICT\s*\(?(\w+)\)?/i);
    const conflictCol = cm ? cm[1] : null;
    let row = {};
    let pi = 0;
    for (const c of cols) {
      const v = params[pi++];
      row[c] = v === undefined ? null : v;
    }
    if (conflictCol) {
      const existing = rows.find((r) => r[conflictCol] === row[conflictCol]);
      if (existing) {
        for (const c of cols) {
          if (c === conflictCol) continue;
          // SET uses excluded.<col> -> take from the newly supplied row
          if (tail.toLowerCase().includes(`excluded.${c}`)) existing[c] = row[c];
        }
        return { changes: 1, last_row_id: existing.id, meta: { changes: 1 } };
      }
    }
    if (!('id' in row)) {
      const id = (this.autoinc.get(table) || 0) + 1;
      this.autoinc.set(table, id);
      row.id = id;
    }
    rows.push(row);
    return { changes: 1, last_row_id: row.id, meta: { changes: 1, last_row_id: row.id } };
  }
  _update(sql, params) {
    const m = sql.match(/^UPDATE\s+"?(\w+)"?\s*SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new Error(`FakeD1: bad UPDATE: ${sql}`);
    const rows = this._t(m[1]);
    let pi = 0;
    const sets = m[2].split(',').map((s) => s.trim()).map((s) => {
      const i = s.indexOf('=');
      return { col: s.slice(0, i).trim(), expr: s.slice(i + 1).trim() };
    });
    const assign = {};
    for (const s of sets) {
      assign[s.col] = s.expr === '?' ? params[pi++] : evalLiteral(s.expr);
    }
    const where = m[3] ? compileWhere(m[3], params, pi) : () => true;
    let changes = 0;
    for (const r of rows) {
      if (!where(r)) continue;
      Object.assign(r, assign);
      changes++;
    }
    return { changes, meta: { changes } };
  }
  _delete(sql, params) {
    const m = sql.match(/^DELETE\s+FROM\s+"?(\w+)"?(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new Error(`FakeD1: bad DELETE: ${sql}`);
    const rows = this._t(m[1]);
    const where = m[2] ? compileWhere(m[2], params, 0) : () => true;
    const before = rows.length;
    const kept = rows.filter((r) => !where(r));
    this.tables.set(m[1], kept);
    return { changes: before - kept.length, meta: { changes: before - kept.length } };
  }
  _select(sql, params) {
    const m = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+"?(\w+)"?([\s\S]*)$/i);
    if (!m) throw new Error(`FakeD1: bad SELECT: ${sql}`);
    const selectList = m[1].trim();
    const rows = this._t(m[2]);
    const rest = m[3] || '';
    const wm = rest.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY\s+([\s\S]+))?$/i);
    const orderClause = rest.match(/ORDER\s+BY\s+([\s\S]+)$/i);
    let out = rows.slice();
    if (wm) {
      const pred = compileWhere(wm[1], params, 0);
      out = out.filter(pred);
    }
    if (orderClause) {
      const parts = orderClause[1].split(',').map((s) => s.trim().split(/\s+/));
      out.sort((a, b) => {
        for (const [col, dir] of parts) {
          const av = a[col], bv = b[col];
          if (av == null && bv == null) continue;
          if (av == null) return -1;
          if (bv == null) return 1;
          if (av < bv) return dir && dir.toUpperCase() === 'DESC' ? 1 : -1;
          if (av > bv) return dir && dir.toUpperCase() === 'DESC' ? -1 : 1;
        }
        return 0;
      });
    }
    let mapped;
    if (selectList === '*') {
      mapped = out.map((r) => ({ ...r }));
    } else {
      const cols = selectList.split(',').map((c) => c.trim().replace(/"/g, ''));
      mapped = out.map((r) => {
        const o = {};
        for (const c of cols) o[c] = r[c] ?? null;
        return o;
      });
    }
    return { results: mapped, meta: {} };
  }
}

function evalLiteral(expr) {
  if (/^datetime\(\s*'now'\s*\)$/i.test(expr)) return 'now';
  const n = Number(expr);
  return Number.isNaN(n) ? expr.replace(/^'|'$/g, '') : n;
}

// Compile a WHERE (AND-only) into a predicate. Consumes params starting at pi.
function compileWhere(clause, params, startPi) {
  const parts = clause.split(/\s+AND\s+/i);
  let pi = startPi;
  const preds = parts.map((raw) => {
    const p = raw.trim();
    let m;
    if ((m = p.match(/^(\w+)\s*=\s*\?$/))) {
      const col = m[1]; const val = params[pi++];
      return (r) => r[col] === val || String(r[col]) === String(val);
    }
    if ((m = p.match(/^(\w+)\s*IN\s*\(([^)]*)\)$/i))) {
      const col = m[1];
      const n = m[2].split(',').length;
      const vals = params.slice(pi, pi + n); pi += n;
      return (r) => vals.includes(r[col]) || vals.map(String).includes(String(r[col]));
    }
    if ((m = p.match(/^(\w+)\s*LIKE\s*\?$/i))) {
      const col = m[1]; const pat = params[pi++];
      const rx = new RegExp('^' + escapeRx(pat).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return (r) => rx.test(String(r[col] ?? ''));
    }
    if ((m = p.match(/^json_extract\(\s*(\w+)\s*,\s*'\$\.(\w+)'\s*\)\s*LIKE\s*\?$/i))) {
      const col = m[1]; const locale = m[2]; const pat = params[pi++];
      const rx = new RegExp('^' + escapeRx(pat).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return (r) => {
        let map = {};
        try { map = r[col] ? JSON.parse(r[col]) : {}; } catch { map = {}; }
        return rx.test(String(map[locale] ?? ''));
      };
    }
    throw new Error(`FakeD1: unsupported WHERE clause: ${p}`);
  });
  return (r) => preds.every((f) => f(r));
}

function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
  await qbHandler(makeCtx('POST', '/posts', { body: {} }), e).catch(() => {}); // ensureSchema via GET below
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