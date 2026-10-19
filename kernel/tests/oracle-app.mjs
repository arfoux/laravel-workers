// kernel/tests/oracle-app.mjs — the PHP oracle's app.
//
// The oracle parity tests (auth, cache, csrf, session, ratelimit, the pipeline,
// the login flow) boot a *real* Laravel app in PHP and compare its behaviour
// with the compiled rung. That needs an app with `vendor/` installed:
//
//   LW_LARAVEL_APP=/path/to/laravel-app
//
// Without one the oracle tests SKIP (they are not "green by omission" — the
// report says "skipped" with the reason). The CI `test` job has no app; the
// `e2e` job creates one, points LW_LARAVEL_APP at it and runs them for real.
import { existsSync } from 'node:fs';
import path from 'node:path';

// The local development fixture (a fresh Laravel 13 app with the Breeze-shaped
// routes the parity tests drive). It is only a *default*: LW_LARAVEL_APP wins.
export const DEFAULT_APP_ROOT = 'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

/** The Laravel app root for the PHP oracle, or null when there is none. */
export function oracleAppRoot() {
  const app = process.env.LW_LARAVEL_APP || DEFAULT_APP_ROOT;
  if (!app) return null;
  return existsSync(path.join(app, 'vendor', 'autoload.php')) ? app : null;
}

/** The skip reason for a test file whose oracle needs an app. */
export function oracleSkip(file) {
  return (
    `${file}: no Laravel app (set LW_LARAVEL_APP to a Laravel 11+/13.x app with ` +
    'vendor/ installed) — the PHP oracle parity test is skipped'
  );
}
