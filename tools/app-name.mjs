// tools/app-name.mjs — the Worker/D1 naming rule, in one place.
//
// Three call sites derive these names and they MUST agree: the Worker name and
// the D1 database name are what `wrangler d1 create` provisions and what the
// deploy step then writes into `wrangler.jsonc`. As separate copies, a project
// could be scaffolded (`init`), built (`build.mjs`, which restores a missing
// wrangler.jsonc after a cached build) and deployed (`deploy`, guided flow)
// under three different databases — silently, since none of them can see the
// others. The bodies below were byte-identical in all three; this module is the
// one that survives.
//
// The numeric limits are Cloudflare's own: a Worker name may be up to 63
// characters, and so may a D1 database name, so the `-db` suffix comes out of
// the database's budget (63 - 3 = 60) rather than the worker's. The
// `|| 'laravel-workers-app'` fallback covers an empty name (a directory whose
// name is nothing but separators, or an empty guided-flow answer).
import { basename } from 'node:path';

/**
 * A Worker name from any raw string: lowercase, runs of anything that is not
 * `[a-z0-9-]` collapse to a single `-`, ends trimmed, capped at 63 characters.
 */
export function slugifyWorkerName(raw) {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || 'laravel-workers-app';
}

/** The automatic database name for a Worker name, capped to D1's 63-character limit. */
export function autoD1Name(workerName) {
  const suffix = '-db';
  const base = String(workerName || '')
    .slice(0, 63 - suffix.length)
    .replace(/-+$/g, '');
  return (base || 'laravel-workers-app') + suffix;
}

/** `{ worker, database }` for an app directory. */
export function workerNames(appDir) {
  const worker = slugifyWorkerName(basename(appDir));
  return { worker, database: autoD1Name(worker) };
}
