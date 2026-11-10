import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/tags.mjs — port of spatie/laravel-tags v4.12.0 seam.
//
// attach / detach / sync / toggle tags on a model plus per-model tag listing,
// all over D1. Mirrors the package's `tags` / `taggables` tables (Spatie's
// default migration: tags has id/name/slug/type + ordering column; taggables
// is the taggable_type/taggable_id/tag_id pivot).
//
// Route wiring: registry.json → "ports": {
//   "/model/{modelType}/{modelKey}/tags":       "tags",  // GET list, POST mutate
// }
//
// GET  /model/{modelType}/{modelKey}/tags[?type=...] → { tags: [..] }
// POST /model/{modelType}/{modelKey}/tags           body { action, tags: [..], type? }
//   action ∈ attach | detach | sync | toggle        → { attached|detached|synced|toggled: [names] }

const DEFAULT_MODEL_TYPE = 'App\\Models\\Post';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT,
      order_column INTEGER NOT NULL DEFAULT 0,
      UNIQUE (slug, type)
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS taggables (
      tag_id INTEGER NOT NULL,
      taggable_type TEXT NOT NULL,
      taggable_id TEXT NOT NULL,
      UNIQUE (tag_id, taggable_type, taggable_id)
    )`
  ).run();
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

// Str::slug — ascii fold is minimal (edge: no full transliteration table);
// whitespace/punctuation → '-', lowercase, collapse repeats.
function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function findOrCreateTag(env, name, type) {
  const slug = slugify(name);
  const existing = await env.DB
    .prepare('SELECT id, name, slug, type FROM tags WHERE slug = ? AND type IS ? LIMIT 1')
    .bind(slug, type)
    .first();
  if (existing) return existing;
  const res = await env.DB
    .prepare('INSERT INTO tags (name, slug, type, order_column) VALUES (?, ?, ?, 0)')
    .bind(name, slug, type)
    .run();
  return { id: res.last_row_id ?? res.meta?.last_row_id, name, slug, type };
}

async function resolveTags(env, names, type) {
  const out = [];
  for (const name of names) out.push(await findOrCreateTag(env, name, type));
  return out;
}

async function isAttached(env, tagId, modelType, modelKey) {
  const row = await env.DB
    .prepare('SELECT tag_id FROM taggables WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ? LIMIT 1')
    .bind(tagId, modelType, modelKey)
    .first();
  return !!row;
}

async function attach(env, tagId, modelType, modelKey) {
  if (await isAttached(env, tagId, modelType, modelKey)) return 0;
  const res = await env.DB
    .prepare('INSERT INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)')
    .bind(tagId, modelType, modelKey)
    .run();
  return (res && res.changes) || 0;
}

async function detach(env, tagId, modelType, modelKey) {
  const res = await env.DB
    .prepare('DELETE FROM taggables WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ?')
    .bind(tagId, modelType, modelKey)
    .run();
  return (res && res.changes) || 0;
}

async function currentTagNames(env, modelType, modelKey, type) {
  const rows = await env.DB
    .prepare(
      `SELECT t.name FROM tags AS t
       INNER JOIN taggables AS g ON g.tag_id = t.id
       WHERE g.taggable_type = ? AND g.taggable_id = ? AND t.type IS ?
       ORDER BY t.order_column, t.id`
    )
    .bind(modelType, modelKey, type)
    .all();
  return (rows.results || []).map((r) => r.name);
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    await ensureSchema(env);
    const modelType = (ctx.body && ctx.body.model_type) || (ctx.query && ctx.query.model_type) || DEFAULT_MODEL_TYPE;
    const modelKey = ctx.params && ctx.params.modelKey;
    if (!modelKey) return json(400, { error: 'modelKey route param required' });

    const method = ctx.request ? ctx.request.method : 'GET';
    const q = ctx.query || {};
    const type = q.type ?? (ctx.body && ctx.body.type) ?? null;

    if (method === 'GET') {
      return json(200, { tags: await currentTagNames(env, modelType, modelKey, type) });
    }

    const body = ctx.body || {};
    const action = body.action;
    const names = Array.isArray(body.tags)
      ? body.tags.map((n) => String(n).trim()).filter(Boolean)
      : String(body.tags || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (!action) return json(400, { error: 'body.action required (attach|detach|sync|toggle)' });
    if (!names.length && action !== 'sync') return json(400, { error: 'body.tags required' });

    const tags = await resolveTags(env, names, type);
    const changed = [];

    if (action === 'attach') {
      for (const t of tags) if (await attach(env, t.id, modelType, modelKey)) changed.push(t.name);
      return json(200, { attached: changed });
    }

    if (action === 'detach') {
      for (const t of tags) if (await detach(env, t.id, modelType, modelKey)) changed.push(t.name);
      return json(200, { detached: changed });
    }

    if (action === 'sync') {
      const desiredIds = new Set(tags.map((t) => t.id));
      // remove everything currently attached (for this type) that's not desired
      const existing = await env.DB
        .prepare(
          `SELECT g.tag_id, t.name FROM taggables AS g
           INNER JOIN tags AS t ON t.id = g.tag_id
           WHERE g.taggable_type = ? AND g.taggable_id = ? AND t.type IS ?`
        )
        .bind(modelType, modelKey, type)
        .all();
      const removed = [];
      for (const row of existing.results || []) {
        if (!desiredIds.has(row.tag_id)) {
          await detach(env, row.tag_id, modelType, modelKey);
          removed.push(row.name);
        }
      }
      const added = [];
      for (const t of tags) if (await attach(env, t.id, modelType, modelKey)) added.push(t.name);
      return json(200, { synced: { added, removed, current: await currentTagNames(env, modelType, modelKey, type) } });
    }

    if (action === 'toggle') {
      const attached = [];
      const detached = [];
      for (const t of tags) {
        if (await isAttached(env, t.id, modelType, modelKey)) {
          await detach(env, t.id, modelType, modelKey);
          detached.push(t.name);
        } else {
          await attach(env, t.id, modelType, modelKey);
          attached.push(t.name);
        }
      }
      return json(200, { toggled: { attached, detached } });
    }

    return json(400, { error: `unknown action "${action}"` });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
