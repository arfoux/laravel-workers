import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/horizon-metrics.mjs — port of the laravel/horizon job-metrics
// seam.
//
// Laravel Horizon exposes per-queue job metrics (completed / failed / pending)
// on a dashboard. On the edge those metrics live in D1:
//   - workers        -> POST /horizon/record   -> a D1 insert into `job_metrics`
//   - dashboard      -> GET  /horizon/metrics  -> per-queue aggregation of
//                                                 `job_metrics` as a JSON summary
//   - filter         -> `?queue=<name>` query param narrows the read to a single
//                       queue
//
// Route wiring: registry.json -> "ports": {
//   "/horizon/metrics": "horizon-metrics",  // GET  dashboard aggregation
//   "/horizon/record":  "horizon-metrics",  // POST record one metric
// }
//
// POST /horizon/record { type, queue?, status?, duration_ms?, created_at? }
//   -> 201 { metric: { id, ... } } | 422 when `type` is missing
// GET /horizon/metrics[?queue=<name>]
//   -> 200 { metrics: { queues: [...], total: {...} } }

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS job_metrics (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       queue TEXT,
       status TEXT,
       duration_ms REAL,
       created_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS job_metrics_queue_idx
     ON job_metrics (queue)`
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

export function statusClass(status) {
  const s = status == null ? '' : String(status).toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'pending' ? s : 'other';
}

// Aggregate a set of metric rows into the per-queue dashboard shape.
export function aggregateByQueue(rows, { queue } = {}) {
  let entries = rows || [];
  if (queue != null && queue !== '') {
    entries = entries.filter((r) => r.queue === queue);
  }

  const byQueue = new Map();
  for (const r of entries) {
    const q = r.queue == null || r.queue === '' ? '(default)' : String(r.queue);
    const cur =
      byQueue.get(q) || { queue: q, total: 0, completed: 0, failed: 0, pending: 0, other: 0, total_duration: 0, dur_count: 0 };
    cur.total += 1;
    cur[statusClass(r.status)] += 1;
    const dur = toNumber(r.duration_ms);
    if (dur != null) {
      cur.total_duration += dur;
      cur.dur_count += 1;
    }
    byQueue.set(q, cur);
  }

  const queues = [...byQueue.values()]
    .map((bq) => ({
      queue: bq.queue,
      total: bq.total,
      completed: bq.completed,
      failed: bq.failed,
      pending: bq.pending,
      other: bq.other,
      avg_duration: bq.dur_count ? bq.total_duration / bq.dur_count : 0,
    }))
    .sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));

  const total = {
    total: entries.length,
    completed: queues.reduce((s, q) => s + q.completed, 0),
    failed: queues.reduce((s, q) => s + q.failed, 0),
    pending: queues.reduce((s, q) => s + q.pending, 0),
    other: queues.reduce((s, q) => s + q.other, 0),
  };

  return { queues, total };
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
      const createdAt =
        typeof body.created_at === 'string' && body.created_at
          ? body.created_at
          : new Date().toISOString();
      const res = await env.DB
        .prepare(
          `INSERT INTO job_metrics (type, queue, status, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          String(body.type),
          body.queue != null ? String(body.queue) : null,
          body.status != null ? String(body.status) : null,
          toNumber(body.duration_ms),
          createdAt
        )
        .run();
      const id = res.last_row_id ?? res.meta?.last_row_id;
      return json(201, {
        metric: {
          id,
          type: String(body.type),
          queue: body.queue != null ? String(body.queue) : null,
          status: body.status != null ? String(body.status) : null,
          duration_ms: toNumber(body.duration_ms),
          created_at: createdAt,
        },
      });
    }

    // GET — dashboard aggregation per queue.
    const q = ctx.query || {};
    const queue = q.queue != null && q.queue !== '' ? String(q.queue) : null;
    const rows =
      queue != null
        ? await env.DB
            .prepare(
              'SELECT type, queue, status, duration_ms, created_at FROM job_metrics WHERE queue = ?'
            )
            .bind(queue)
            .all()
        : await env.DB
            .prepare('SELECT type, queue, status, duration_ms, created_at FROM job_metrics')
            .all();
    const result = aggregateByQueue(rows.results || [], { queue });
    return json(200, { metrics: result });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
