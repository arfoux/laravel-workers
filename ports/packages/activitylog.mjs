import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/activitylog.mjs — port of spatie/laravel-activitylog v4.x seam.
//
// Records an activity (description / properties / causer / subject / event /
// log_name) into the `activity_log` table and reads entries back. Mirrors the
// package's default migration (causer/subject polymorphic columns, JSON
// properties, batch_uuid, event).
//
// Route wiring: registry.json → "ports": {
//   "/activity":      "activitylog",  // POST record; GET list
//   "/activity/:id":  "activitylog",  // GET single
// }
//
// POST /activity { description, log_name?, event?, subject_type?, subject_id?,
//                  causer_type?, causer_id?, properties? }
//   → { id, ... }
// GET /activity[?subject_type=&subject_id=&causer_id=&event=&log_name=&limit=]
//   → { activities: [..] }
// GET /activity/:id → { activity } or 404

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_name TEXT,
      description TEXT,
      subject_type TEXT,
      subject_id TEXT,
      causer_type TEXT,
      causer_id TEXT,
      event TEXT,
      properties TEXT,
      batch_uuid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS activity_log_subject_idx
     ON activity_log (subject_type, subject_id)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS activity_log_causer_idx
     ON activity_log (causer_type, causer_id)`
  ).run();
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function serializeProps(properties) {
  if (properties == null) return null;
  if (typeof properties === 'string') return properties;
  try {
    return JSON.stringify(properties);
  } catch {
    return null;
  }
}

function deserializeProps(row) {
  if (!row || row.properties == null) return row;
  try {
    row.properties = JSON.parse(row.properties);
  } catch {
    /* leave as stored string */
  }
  return row;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    await ensureSchema(env);
    const method = ctx.request ? ctx.request.method : 'GET';

    if (method === 'POST') {
      const body = ctx.body || {};
      if (body.description == null) return json(400, { error: 'body.description required' });
      const ts = nowIso();
      const res = await env.DB
        .prepare(
          `INSERT INTO activity_log
             (log_name, description, subject_type, subject_id, causer_type, causer_id,
              event, properties, batch_uuid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          body.log_name ?? null,
          String(body.description),
          body.subject_type ?? null,
          body.subject_id != null ? String(body.subject_id) : null,
          body.causer_type ?? null,
          body.causer_id != null ? String(body.causer_id) : null,
          body.event ?? null,
          serializeProps(body.properties),
          body.batch_uuid ?? null,
          ts,
          ts
        )
        .run();
      const id = res.last_row_id ?? res.meta?.last_row_id;
      const row = await env.DB.prepare('SELECT * FROM activity_log WHERE id = ? LIMIT 1').bind(id).first();
      return json(201, { activity: deserializeProps(row) });
    }

    // GET
    const id = ctx.params && ctx.params.id;
    if (id) {
      const row = await env.DB.prepare('SELECT * FROM activity_log WHERE id = ? LIMIT 1').bind(id).first();
      if (!row) return json(404, { error: `activity ${id} not found` });
      return json(200, { activity: deserializeProps(row) });
    }

    const q = ctx.query || {};
    const limit = Math.min(Number(q.limit) || 50, 200);
    const hasCauser = q.causer_id != null;
    const sql = hasCauser
      ? 'SELECT * FROM activity_log WHERE causer_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?';
    const rows = await env.DB
      .prepare(sql)
      .bind(...(hasCauser ? [String(q.causer_id), limit] : [limit]))
      .all();

    let activities = rows.results || [];
    if (q.subject_type) activities = activities.filter((a) => a.subject_type === q.subject_type);
    if (q.subject_id != null) activities = activities.filter((a) => a.subject_id === String(q.subject_id));
    if (q.event) activities = activities.filter((a) => a.event === q.event);
    if (q.log_name) activities = activities.filter((a) => a.log_name === q.log_name);

    return json(200, { activities: activities.map(deserializeProps) });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
