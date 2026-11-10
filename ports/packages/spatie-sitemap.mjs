import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-sitemap v8.2.0 — build a sitemap XML from a list of
// URLs (routes) each with a `lastmod`. In Laravel you add URLs (or let the
// package discover routes) and call `Sitemap::create()->writeToFile(...)`,
// producing `<urlset><url><loc/><lastmod/>...</url></urlset>`. Here the URL
// list lives in a D1 table and `GET /sitemap.xml` renders the same XML.
//
// Substitution + disclosure (structural, 1:1 intent):
//   - `Sitemap::create()->add(Url::create($loc)->setLastModification(...))`
//     -> POST /sitemap to upsert a `{loc, lastmod, changefreq, priority}` row;
//     GET /sitemap.xml renders the XML from those rows.
//   - No route auto-discovery: URLs are added explicitly (or seeded). Disclosure
//     noted so a caller knows the list is data-driven, not reflective.
//
// Route wiring: registry.json → "ports": {
//   "/sitemap.xml": "spatie-sitemap", // GET  -> XML
//   "/sitemap":     "spatie-sitemap", // GET list / POST upsert / DELETE by loc
// }
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS sitemap_urls (
//     id         INTEGER PRIMARY KEY AUTOINCREMENT,
//     loc        TEXT NOT NULL UNIQUE,
//     lastmod    TEXT NOT NULL,   -- W3C datetime, e.g. 2024-01-01T00:00:00+00:00
//     changefreq TEXT,
//     priority   TEXT
//   );

export async function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sitemap_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loc TEXT NOT NULL UNIQUE,
      lastmod TEXT NOT NULL,
      changefreq TEXT,
      priority TEXT
    )`
  ).run();
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function w3cNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// Render the sitemap XML (spatie's `toXmlString()` output shape).
export function renderSitemapXml(urls) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of urls) {
    lines.push('  <url>');
    lines.push(`    <loc>${xmlEscape(u.loc)}</loc>`);
    if (u.lastmod) lines.push(`    <lastmod>${xmlEscape(u.lastmod)}</lastmod>`);
    if (u.changefreq) lines.push(`    <changefreq>${xmlEscape(u.changefreq)}</changefreq>`);
    if (u.priority != null && u.priority !== '') {
      lines.push(`    <priority>${xmlEscape(u.priority)}</priority>`);
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  return lines.join('\n');
}

async function allUrls(env) {
  const rows = await env.DB.prepare(
    'SELECT loc, lastmod, changefreq, priority FROM sitemap_urls ORDER BY loc'
  ).all();
  return rows.results || [];
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';
  const url = new URL(ctx.request ? ctx.request.url : 'http://x/' + (ctx.url || ''));
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};

  try {
    await ensureSchema(env);

    // GET /sitemap.xml — render XML
    if (url.pathname.endsWith('/sitemap.xml') && method === 'GET') {
      const urls = await allUrls(env);
      const xml = renderSitemapXml(urls);
      return {
        status: 200,
        headers: {
          'content-type': 'application/xml; charset=UTF-8',
          'cache-control': 'no-store',
        },
        body: xml,
      };
    }

    // GET /sitemap — JSON list
    if (method === 'GET') {
      const urls = await allUrls(env);
      return json(200, { count: urls.length, urls });
    }

    // POST /sitemap — upsert by loc (Url::create + writeToFile equivalent)
    if (method === 'POST') {
      const loc = String(body.loc ?? '').trim();
      if (!loc) return json(422, { error: 'loc required' });
      const lastmod = String(body.lastmod ?? w3cNow());
      const changefreq = body.changefreq != null ? String(body.changefreq) : null;
      const priority = body.priority != null ? String(body.priority) : null;
      await env.DB.prepare(
        `INSERT INTO sitemap_urls (loc, lastmod, changefreq, priority)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(loc) DO UPDATE SET
           lastmod = excluded.lastmod,
           changefreq = excluded.changefreq,
           priority = excluded.priority`
      ).bind(loc, lastmod, changefreq, priority).run();
      return json(200, { loc, lastmod, changefreq, priority });
    }

    // DELETE /sitemap?loc=... — remove a URL
    if (method === 'DELETE') {
      const loc = url.searchParams.get('loc');
      if (!loc) return json(422, { error: 'loc query param required' });
      await env.DB.prepare('DELETE FROM sitemap_urls WHERE loc = ?').bind(loc).run();
      return json(200, { deleted: loc });
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}