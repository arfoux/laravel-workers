import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/pulse.mjs — port of laravel/pulse observability seam.
//
// Laravel Pulse records "entries" via recorders (requests, errors, slow queries,
// queue, cache, ...) and renders them on a dashboard. On the edge:
//   - recorders  -> POST /pulse/record   -> a D1 write into `pulse_entries`
//   - dashboard  -> GET  /pulse          -> an aggregation over `pulse_entries`
//                                            returned as a JSON summary
//   - filter/range -> `?range=<minutes>` query param on the dashboard read
//
// Route wiring: registry.json -> "ports": {
//   "/pulse":         "pulse",   // GET dashboard summary
//   "/pulse/record":  "pulse",   // POST record one entry
// }
//
// POST /pulse/record { type, path?, status?, duration_ms?, recorded_at? }
//   -> 201 { entry: { id, ... } } | 422 when `type` is missing
// GET /pulse[?range=<minutes>]
//   -> 200 { requests_count, errors_count, avg_duration, top_routes, per_minute }

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pulse_entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       path TEXT,
       status INTEGER,
       duration_ms REAL,
       recorded_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pulse_aggregates (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       period TEXT NOT NULL,
       path TEXT,
       requests INTEGER NOT NULL DEFAULT 0,
       errors INTEGER NOT NULL DEFAULT 0,
       avg_duration REAL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS pulse_entries_recorded_at_idx
     ON pulse_entries (recorded_at)`
  ).run();
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Aggregate a set of entry rows into the dashboard summary shape.
export function summarize(rows, { rangeMinutes } = {}) {
  let entries = rows || [];
  if (rangeMinutes != null) {
    const cutoff = Date.now() - rangeMinutes * 60_000;
    entries = entries.filter((r) => {
      const t = r.recorded_at ? Date.parse(r.recorded_at) : NaN;
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  const requestsCount = entries.length;
  const errorsCount = entries.filter((r) => toNumber(r.status) != null && toNumber(r.status) >= 400).length;
  const durations = entries.map((r) => toNumber(r.duration_ms)).filter((d) => d != null);
  const avgDuration = durations.length
    ? durations.reduce((sum, d) => sum + d, 0) / durations.length
    : 0;

  // Top routes by request count.
  const byPath = new Map();
  for (const r of entries) {
    const path = r.path == null ? '(unknown)' : String(r.path);
    const cur = byPath.get(path) || { path, requests: 0, errors: 0, total_duration: 0, dur_count: 0 };
    cur.requests += 1;
    const status = toNumber(r.status);
    if (status != null && status >= 400) cur.errors += 1;
    const dur = toNumber(r.duration_ms);
    if (dur != null) {
      cur.total_duration += dur;
      cur.dur_count += 1;
    }
    byPath.set(path, cur);
  }
  const topRoutes = [...byPath.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5)
    .map((r) => ({
      path: r.path,
      requests: r.requests,
      errors: r.errors,
      avg_duration: r.dur_count ? r.total_duration / r.dur_count : 0,
    }));

  // Per-minute request counts (bucketed by recorded_at minute).
  const perMinute = new Map();
  for (const r of entries) {
    const t = r.recorded_at ? Date.parse(r.recorded_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const bucket = new Date(Math.floor(t / 60_000) * 60_000).toISOString();
    perMinute.set(bucket, (perMinute.get(bucket) || 0) + 1);
  }
  const perMinuteArr = [...perMinute.entries()]
    .map(([minute, requests]) => ({ minute, requests }))
    .sort((a, b) => (a.minute < b.minute ? -1 : a.minute > b.minute ? 1 : 0));

  return {
    requests_count: requestsCount,
    errors_count: errorsCount,
    avg_duration: avgDuration,
    top_routes: topRoutes,
    per_minute: perMinuteArr,
  };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    await ensureSchema(env);
    const method = ctx.request ? ctx.request.method : 'GET';

    if (method === 'POST') {
      const body = ctx.body || {};
      if (body.type == null || body.type === '') {
        return json(422, { error: 'body.type required' });
      }
      const recordedAt =
        typeof body.recorded_at === 'string' && body.recorded_at
          ? body.recorded_at
          : new Date().toISOString();
      const res = await env.DB
        .prepare(
          `INSERT INTO pulse_entries (type, path, status, duration_ms, recorded_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          String(body.type),
          body.path != null ? String(body.path) : null,
          toNumber(body.status),
          toNumber(body.duration_ms),
          recordedAt
        )
        .run();
      const id = res.last_row_id ?? res.meta?.last_row_id;
      return json(201, {
        entry: {
          id,
          type: String(body.type),
          path: body.path != null ? String(body.path) : null,
          status: toNumber(body.status),
          duration_ms: toNumber(body.duration_ms),
          recorded_at: recordedAt,
        },
      });
    }

    // GET — dashboard summary.
    const q = ctx.query || {};
    const rangeMinutes = q.range != null ? toNumber(q.range) : null;
    const rows = await env.DB
      .prepare('SELECT type, path, status, duration_ms, recorded_at FROM pulse_entries')
      .all();
    const summary = summarize(rows.results || [], {
      rangeMinutes: rangeMinutes != null && rangeMinutes > 0 ? rangeMinutes : null,
    });
    return json(200, { summary });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
