import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-model-states v2.14.3 — a state field on a model backed
// by a transition map. In Laravel each state is a subclass of `State`; a model
// has a `$casts = ['state' => MyState::class]` and transitions are declared via
// `$state->transitionTo(OtherState::class)` / `DefaultTransition`. Allowed
// targets are derived from the registered transitions; an illegal transition
// throws `Spatie\ModelStates\Exceptions\TransitionNotAllowed`. Here the state is
// a string column plus a config-defined transition map; the same exception FQCN
// is returned (as a string) on an illegal transition instead of being thrown.
//
// Substitution + disclosure (structural, 1:1 intent):
//   - State subclasses -> string keys (`draft`, `pending_review`, `published`).
//   - `transitionTo()` -> POST /state-models/{id}/transition { to }.
//   - `canTransitionTo()` -> GET /state-models/{id}/transitions (allowed targets).
//   - The real package throws; this port returns HTTP 500 with the exception
//     FQCN `Spatie\ModelStates\Exceptions\TransitionNotAllowed` in the body so
//     the failure is observable over HTTP. Disclosure: no PHP exception object
//     exists at the edge — only its name/message.
//
// Route wiring: registry.json → "ports": {
//   "/state-models":              "spatie-model-states", // GET list / POST create
//   "/state-models/{id}":         "spatie-model-states", // GET one
//   "/state-models/{id}/transitions": "spatie-model-states",
//   "/state-models/{id}/transition":  "spatie-model-states",
// }
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS state_models (
//     id         INTEGER PRIMARY KEY AUTOINCREMENT,
//     title      TEXT NOT NULL,
//     state      TEXT NOT NULL DEFAULT 'draft',
//     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
//   );

// Transition map — each entry is a DefaultTransition(target) registered on the
// given source state(s). Mirrors `->allowTransition([From::class], To::class)`.
export const STATE_CONFIG = {
  states: ['draft', 'pending_review', 'published'],
  defaultState: 'draft',
  transitions: [
    { name: 'submit', from: ['draft'], to: 'pending_review' },
    { name: 'publish', from: ['pending_review'], to: 'published' },
    { name: 'reject', from: ['pending_review'], to: 'draft' },
    { name: 'archive', from: ['published'], to: 'draft' },
  ],
};

// canTransitionTo / allowedTargets — the allowed target states from a source.
export function allowedTargets(state) {
  const set = [];
  for (const t of STATE_CONFIG.transitions) {
    if (t.from.includes(state) && !set.includes(t.to)) set.push(t.to);
  }
  return set;
}

export function canTransitionTo(from, to) {
  return allowedTargets(from).includes(to);
}

const EXCEPTION_TRANSITION_NOT_ALLOWED = 'Spatie\\ModelStates\\Exceptions\\TransitionNotAllowed';

export async function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS state_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

async function findRow(env, id) {
  return env.DB.prepare('SELECT * FROM state_models WHERE id = ?').bind(Number(id)).first();
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';
  const url = new URL(ctx.request ? ctx.request.url : 'http://x/' + (ctx.url || ''));
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const segs = url.pathname.split('/').filter(Boolean);
  const id = (ctx.params && ctx.params.id) != null ? ctx.params.id : segs[1];

  try {
    await ensureSchema(env);

    // Collection: GET list / POST create (with default state)
    if (!id) {
      if (method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM state_models ORDER BY id').all();
        return json(200, { data: rows.results || [] });
      }
      if (method === 'POST') {
        const title = String(body.title ?? '');
        if (!title) return json(422, { error: 'title required' });
        const res = await env.DB.prepare(
          'INSERT INTO state_models (title, state) VALUES (?, ?)'
        ).bind(title, STATE_CONFIG.defaultState).run();
        const row = await findRow(env, res.last_row_id ?? res.meta?.last_row_id);
        return json(201, row);
      }
      return json(405, { error: 'method not allowed' });
    }

    // Single
    if (method === 'GET' && !url.pathname.endsWith('/transitions') && !url.pathname.endsWith('/transition')) {
      const row = await findRow(env, id);
      if (!row) return json(404, { error: 'not found' });
      return json(200, { data: row, allowed_targets: allowedTargets(row.state) });
    }

    // GET allowed targets (canTransitionTo surface)
    if (method === 'GET' && url.pathname.endsWith('/transitions')) {
      const row = await findRow(env, id);
      if (!row) return json(404, { error: 'not found' });
      return json(200, { from: row.state, allowed_targets: allowedTargets(row.state) });
    }

    // POST transition (transitionTo)
    if (method === 'POST' && url.pathname.endsWith('/transition')) {
      const row = await findRow(env, id);
      if (!row) return json(404, { error: 'not found' });
      const to = String(body.to ?? '');
      if (!STATE_CONFIG.states.includes(to) || !canTransitionTo(row.state, to)) {
        // Illegal / unknown transition -> the package's exception FQCN.
        return json(500, {
          exception: EXCEPTION_TRANSITION_NOT_ALLOWED,
          message: `Cannot transition from '${row.state}' to '${to}'.`,
          from: row.state,
          to,
        });
      }
      await env.DB.prepare(
        `UPDATE state_models SET state = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(to, Number(id)).run();
      const fresh = await findRow(env, id);
      return json(200, { data: fresh, transitioned_to: to });
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}