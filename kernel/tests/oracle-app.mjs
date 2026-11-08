// kernel/tests/oracle-app.mjs — the PHP oracle's app.
//
// The oracle parity tests (auth, cache, csrf, session, ratelimit, the pipeline,
// the login flow, the FormRequest/event dumps) boot a *real* Laravel app in PHP
// and compare its behaviour with the compiled rung. That needs an app with
// `vendor/` installed:
//
//   LW_LARAVEL_APP=/path/to/laravel-app
//
// Without one the oracle tests SKIP (they are not "green by omission" — the
// report says "skipped" with the reason). The CI `test` job has no app; the
// `parity-oracle` and `e2e-fresh-laravel` jobs create one (as `parity-app` /
// `e2e-app` at the repo root), point LW_LARAVEL_APP at it and run them for real.
//
// No machine-local path is committed here: without LW_LARAVEL_APP only the two
// conventional repo-root directories above are tried, so the suite behaves the
// same on every machine (a leftover dev directory can no longer decide whether
// the oracle parity runs or skips).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_APP_DIRS = ['parity-app', 'e2e-app'];

/** The conventional app root for this checkout, or null when there is none. */
export function defaultAppRoot() {
  for (const dir of DEFAULT_APP_DIRS) {
    const root = path.join(repoRoot, dir);
    if (existsSync(path.join(root, 'app'))) return root;
  }
  return null;
}

/** The Laravel app root for the PHP oracle, or null when there is none. */
export function oracleAppRoot() {
  const app = process.env.LW_LARAVEL_APP || defaultAppRoot();
  if (!app) return null;
  if (!existsSync(path.join(app, 'vendor', 'autoload.php'))) return null;
  if (!existsSync(path.join(app, 'app'))) return null;
  return app;
}

/**
 * A temp `db_path` for an oracle that creates its own sqlite file. Every such
 * oracle defaults to `<app_root>/<name>-oracle.sqlite` (documented on the tool
 * itself) — fine for a manual run, but a test that omits `db_path` leaves that
 * file inside whatever checkout it ran against. One name per test file, so
 * parallel runs never share a database.
 */
export function oracleDbPath(name) {
  return path.join(os.tmpdir(), `lw-${name}-oracle-${process.pid}.sqlite`);
}

/** The skip reason for a test file whose oracle needs an app. */
export function oracleSkip(file) {
  return (
    `${file}: no Laravel app (set LW_LARAVEL_APP to a Laravel 11+/13.x app with ` +
    'vendor/ installed) — the PHP oracle parity test is skipped'
  );
}
