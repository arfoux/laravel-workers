import { normalizePortCtx, jsonResponse as json } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/sluggable.mjs — port of spatie/laravel-sluggable v4.0.6 seam.
//
// Generates a unique URL slug (Str::slug of the source field) and, on
// collision with an existing row, appends a numeric suffix -2, -3, … until
// free — the package's `generateUniqueSlug` loop. State lives in a D1 table
// keyed by (table, column, slug) so any model's slug column can be served.
//
// Route wiring: registry.json → "ports": {
//   "/slug": "sluggable",         // POST generate; GET list by source
// }
//
// POST /slug { source, table?, column?, separator?, exclude_id? }
//   → { slug }   (200; unique within table/column scope)
// GET  /slug?table=&column=&prefix=&exclude_id= → { candidates: [..] }

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS slugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug_table TEXT NOT NULL,
      slug_column TEXT NOT NULL,
      slug TEXT NOT NULL,
      source TEXT,
      UNIQUE (slug_table, slug_column, slug)
    )`
  ).run();
}


// Str::slug equivalent (see tags.mjs slugify — same edge-safe fold).
function strSlug(value, separator = '-') {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '')
    .toLowerCase();
}

// generateUniqueSlug: try base, then base-2, base-3, …
export async function generateUniqueSlug(env, { source, table, column, separator = '-', excludeId = null }) {
  const base = strSlug(source, separator);
  if (!base) throw new Error('source produced an empty slug');
  let candidate = base;
  for (let i = 2; i <= 1000; i += 1) {
    if (await claimSlug(env, { table, column, slug: candidate, source: String(source), excludeId })) {
      return candidate;
    }
    candidate = `${base}${separator}${i}`;
  }
  throw new Error('could not generate a unique slug');
}

// Try to claim `slug`. Returns true when claimed (inserted, or the row already
// owns it via excludeId), false when another row holds the slug (collision).
// A real D1 raises SQLITE_CONSTRAINT_UNIQUE on a duplicate INSERT — we treat
// that as a collision rather than trusting a pre-check, so concurrent
// generation stays correct at the edge.
async function claimSlug(env, { table, column, slug, source, excludeId }) {
  if (excludeId != null) {
    const owned = await env.DB
      .prepare('SELECT id, slug FROM slugs WHERE slug_table = ? AND slug_column = ? AND id = ? LIMIT 1')
      .bind(table, column, excludeId)
      .first();
    if (owned) {
      if (owned.slug === slug) return true; // already ours
      try {
        await env.DB
          .prepare('UPDATE slugs SET slug = ?, source = ? WHERE id = ? AND slug != ?')
          .bind(slug, source, excludeId, slug)
          .run();
      } catch (err) {
        if (String(err && err.message).includes('UNIQUE')) return false;
        throw err;
      }
      // Another row may already hold the target slug.
      const dup = await env.DB
        .prepare('SELECT id FROM slugs WHERE slug_table = ? AND slug_column = ? AND slug = ? AND id != ? LIMIT 1')
        .bind(table, column, slug, excludeId)
        .first();
      return !dup;
    }
  }
  try {
    await env.DB
      .prepare('INSERT INTO slugs (slug_table, slug_column, slug, source) VALUES (?, ?, ?, ?)')
      .bind(table, column, slug, source)
      .run();
    return true;
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    await ensureSchema(env);
    const method = ctx.request ? ctx.request.method : 'POST';

    if (method === 'GET') {
      const q = ctx.query || {};
      const table = q.table || 'default';
      const column = q.column || 'slug';
      const prefix = q.prefix || '';
      const rows = await env.DB
        .prepare('SELECT slug FROM slugs WHERE slug_table = ? AND slug_column = ? AND slug LIKE ? ORDER BY slug')
        .bind(table, column, `${prefix}%`)
        .all();
      return json(200, { candidates: (rows.results || []).map((r) => r.slug) });
    }

    const body = ctx.body || {};
    if (body.source == null) return json(400, { error: 'body.source required' });
    const table = body.table || 'default';
    const column = body.column || 'slug';
    const separator = body.separator || '-';
    const excludeId = body.exclude_id ?? null;

    const slug = await generateUniqueSlug(env, { source: body.source, table, column, separator, excludeId });

    return json(200, { slug });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
