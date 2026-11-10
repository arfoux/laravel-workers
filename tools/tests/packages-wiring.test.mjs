// tools/tests/packages-wiring.test.mjs — the fleet of package PORTS
// (`ports/packages/*.mjs`) wired through a REAL build, not just imported by
// their unit tests.
//
// WHY THIS FILE EXISTS. Every `ports/packages/<slug>.mjs` had a unit test that
// imported the module and called it with a hand-built ctx, so "green" proved the
// handler logic in isolation. It did NOT prove the port answers on the ctx the
// *router* hands a route port: `kernel/router.mjs` passes `ctx.request` = the
// compiled kernel Request, whose accessors are METHODS (`method()`,
// `pathInfo()`, `header()`, `json()`), plus `ctx.params` and `ctx.method` (a
// string). A port that read `ctx.request.url` / `ctx.request.method` / `ctx.body`
// as PROPERTIES got `undefined` and silently used its own default — the exact
// trap the hand-written lw-showcase ports warn about. The fix is
// `kernel/packages/port-ctx.mjs` (`normalizePortCtx`), applied at the top of each
// port's default export; this test pins that the wiring works end-to-end.
//
// It needs a Laravel app with `vendor/` (PHP 8.3 + the framework), so it SKIPS
// without one — the CI `test` job has no app, `parity-oracle` does. Run it with
//   LW_LARAVEL_APP=/path/to/app node --test tools/tests/packages-wiring.test.mjs
// or let `tools/oracle-ran.mjs` run it (that gate turns a silent skip into a
// failure, so a skip cannot hide here).
//
// The app it builds is a TEMP COPY of that app with `vendor/` symlinked and
// `routes/web.php` + `registry.json` replaced by the fleet's routes: the checked-in
// app is never modified, and the copy stays small (no vendor tree, no node_modules).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oracleAppRoot, oracleSkip } from '../../kernel/tests/oracle-app.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(repoRoot, 'build.mjs');
const PORTS_DIR = path.join(repoRoot, 'ports', 'packages');
const PHP = process.env.PHP_BIN || 'php';

const APP_ROOT = oracleAppRoot();
const noApp = APP_ROOT ? false : oracleSkip('packages-wiring.test.mjs');

// The routes the copy carries: literal, `{param}`, and several routes answered by
// ONE port module (the dispatch seam). Chosen so no two entries collide and every
// category of the port contract is exercised.
const ROUTES = `<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/sitemap.xml', fn () => '')->name('sitemap.xml');
Route::get('/sitemap', fn () => '')->name('sitemap');
Route::post('/sitemap', fn () => '')->name('sitemap.store');
Route::get('/settings/{group}', fn () => '')->name('settings.show');
Route::put('/settings/{group}', fn () => '')->name('settings.update');
Route::get('/activity', fn () => '')->name('activity.index');
Route::post('/activity', fn () => '')->name('activity.store');
Route::get('/activity/{id}', fn () => '')->name('activity.show');
Route::post('/slug', fn () => '')->name('slug');
Route::post('/data', fn () => '')->name('data');
Route::get('/search', fn () => '')->name('search');
Route::post('/sanctum/token', fn () => '')->name('sanctum.token');
Route::get('/sanctum/verify', fn () => '')->name('sanctum.verify');
Route::get('/sanctum/tokens', fn () => '')->name('sanctum.tokens');
Route::delete('/sanctum/tokens/{id}', fn () => '')->name('sanctum.tokens.revoke');
Route::post('/user/two-factor-authentication', fn () => '')->name('2fa.enable');
Route::post('/user/two-factor-authentication/confirm', fn () => '')->name('2fa.confirm');
Route::post('/user/two-factor-challenge', fn () => '')->name('2fa.challenge');
Route::post('/user/two-factor-challenge/recovery', fn () => '')->name('2fa.recovery');
Route::post('/user/confirm-password', fn () => '')->name('password.confirm');
Route::get('/user/confirm-password/status', fn () => '')->name('password.confirmation');
Route::post('/email/verification-notification', fn () => '')->name('verification.send');
Route::get('/email/verify/{id}/{hash}', fn () => '')->name('verification.verify');
`;

const PORTS = {
  '/sitemap.xml': 'spatie-sitemap',
  '/sitemap': 'spatie-sitemap',
  '/settings/{group}': 'spatie-settings',
  '/activity': 'activitylog',
  '/activity/{id}': 'activitylog',
  '/slug': 'sluggable',
  '/data': 'spatie-data',
  '/search': 'scout-meilisearch',
  '/sanctum/token': 'sanctum',
  '/sanctum/verify': 'sanctum',
  '/sanctum/tokens': 'sanctum',
  '/sanctum/tokens/{id}': 'sanctum',
  '/user/two-factor-authentication': 'fortify-two-factor',
  '/user/two-factor-authentication/confirm': 'fortify-two-factor',
  '/user/two-factor-challenge': 'fortify-two-factor',
  '/user/two-factor-challenge/recovery': 'fortify-two-factor',
  '/user/confirm-password': 'fortify-confirmation',
  '/user/confirm-password/status': 'fortify-confirmation',
  '/email/verification-notification': 'fortify-confirmation',
  '/email/verify/{id}/{hash}': 'fortify-confirmation',
};
const SLUGS = [...new Set(Object.values(PORTS))];

const SKIP_DIRS = new Set(['vendor', 'node_modules', 'dist', '.cache', '.git']);

function makeApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-pkgs-wiring-'));
  cpSync(APP_ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(APP_ROOT, src);
      if (!rel) return true;
      if (SKIP_DIRS.has(rel.split(path.sep)[0])) return false;
      // the app's own route policy + prerendered pages do not apply to the copy
      return path.basename(src) !== 'registry.json';
    },
  });
  symlinkSync(path.join(APP_ROOT, 'vendor'), path.join(dir, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(dir, 'routes', 'web.php'), ROUTES);
  writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ autoSnapshot: false, ports: PORTS }, null, 2));
  // The fleet ports, flat under the app's own ports dir, so LW_PORTS_DIR=ports
  // makes `<slug>.mjs` resolve and the ports' `../../kernel/packages/*` imports
  // resolve inside dist/ (the build copies kernel/ to dist/kernel).
  mkdirSync(path.join(dir, 'ports'), { recursive: true });
  for (const slug of SLUGS) cpSync(path.join(PORTS_DIR, slug + '.mjs'), path.join(dir, 'ports', slug + '.mjs'));
  return dir;
}

// One build, shared by both tests (PHP boots the copy several times, so it is the
// expensive part).
let built = null;
function build() {
  if (!built) {
    built = (() => {
      const dir = makeApp();
      const res = spawnSync(process.execPath, [BUILD, '--strict'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LW_NO_BUILD_CACHE: '1', LW_PORTS_DIR: 'ports', PHP_BIN: PHP },
      });
      return { dir, status: res.status, log: `${res.stdout || ''}${res.stderr || ''}` };
    })();
  }
  return built;
}

after(() => {
  if (built) rmSync(built.dir, { recursive: true, force: true });
});

// The ctx `kernel/router.mjs` hands a route port: `request` is the compiled
// Request (accessors are METHODS), plus `ctx.params` and `ctx.method`.
function kernelCtx({ method = 'GET', path: p = '/', query = '', headers = {}, json = undefined, params = {} }) {
  const q = Object.fromEntries(new URLSearchParams(query));
  return {
    method,
    params,
    request: {
      method: () => method,
      pathInfo: () => p,
      getQueryString: () => query,
      path: () => p + (query ? '?' + query : ''),
      header: (n) => headers[String(n).toLowerCase()] ?? null,
      host: () => 'edge.test',
      query: (k, d = null) => (k === undefined ? q : (q[k] ?? d)),
      json: () => json,
    },
  };
}

// A D1 stand-in good enough for the reads/writes the smoke paths make.
class FakeD1 {
  prepare() {
    const rows = [];
    return {
      bind: () => ({
        all: async () => ({ results: rows }),
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
      all: async () => ({ results: rows }),
      first: async () => null,
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
  }
}

test('the fleet ports build --strict: every route is served, none unhandled', { skip: noApp }, () => {
  const { status, log } = build();
  assert.equal(status, 0, `the wired app must build --strict:\n${log}`);
  assert.match(log, new RegExp(`ports ${Object.keys(PORTS).length}\\b`), `the port count is wrong:\n${log}`);
  assert.doesNotMatch(log, /UNHANDLED/, `a served route was reported as unhandled:\n${log}`);
  assert.doesNotMatch(log, /registry entries not found in route:list/, `a declared route is not in the app:\n${log}`);
  assert.match(log, /coverage: all \d+ route\(s\) handled/, `the coverage line is missing:\n${log}`);
});

test('the emitted ports answer on the router ctx (not a unit-test ctx)', { skip: noApp }, async () => {
  const { status, dir } = build();
  assert.equal(status, 0, 'the build must succeed before the artifacts can be read');
  const load = async (slug) =>
    (await import(pathToFileURL(path.join(dir, 'dist', 'src', 'ports', slug + '.mjs')).href)).default;
  const env = { DB: new FakeD1(), APP_KEY: 'x'.repeat(32) };

  // A port that read `ctx.request.url` as a property threw `Invalid URL` here;
  // it must answer a real response instead.
  const sitemap = await load('spatie-sitemap');
  const xml = await sitemap(kernelCtx({ path: '/sitemap.xml' }), env);
  assert.equal(xml.status, 200);
  assert.match(xml.body, /<urlset/);

  const settings = await load('spatie-settings');
  assert.equal((await settings(kernelCtx({ path: '/settings/app', params: { group: 'app' } }), env)).status, 200);

  const sluggable = await load('sluggable');
  const slug = await sluggable(kernelCtx({ method: 'POST', path: '/slug', json: { source: 'Hello World' } }), env);
  assert.deepEqual(JSON.parse(slug.body), { slug: 'hello-world' });

  // `ctx.params` from the router only carries `{param}` captures, never a literal
  // segment named `action`, so one module answers several routes by dispatching on
  // the path. Before the fix all four landed on the same branch (enable).
  const twofa = await load('fortify-two-factor');
  const answers = [];
  for (const route of [
    '/user/two-factor-authentication',
    '/user/two-factor-authentication/confirm',
    '/user/two-factor-challenge',
    '/user/two-factor-challenge/recovery',
  ]) {
    const res = await twofa(kernelCtx({ method: 'POST', path: route, json: { email: 'a@b.test' } }), env);
    assert.doesNotMatch(String(res.body), /Unknown 2FA action/, `${route} fell through the dispatch:\n${res.body}`);
    answers.push(`${res.status} ${res.body}`);
  }
  assert.equal(new Set(answers).size, 4, `the four 2FA routes must reach four handlers:\n${answers.join('\n')}`);

  // Same trap, second module: `fortify-confirmation` dispatched on
  // `ctx.params.action`, which the router never fills (no `{action}` segment) —
  // every one of its routes answered `404 Unknown confirmation action ''`. Each
  // must now reach its OWN handler, so the answers differ by route (the send /
  // confirm pair share `User not found.` because both look the user up first:
  // that is the handler's own 404, not the dispatcher's).
  const confirmation = await load('fortify-confirmation');
  const confirmExpect = [
    ['POST', '/user/confirm-password', 404, /User not found/],
    ['GET', '/user/confirm-password/status', 200, /"confirmed"/],
    ['POST', '/email/verification-notification', 404, /User not found/],
    ['GET', '/email/verify/7/abc', 403, /Invalid verification link/],
  ];
  for (const [method, route, status, body] of confirmExpect) {
    const res = await confirmation(kernelCtx({ method, path: route, json: { email: 'a@b.test' } }), env);
    assert.doesNotMatch(String(res.body), /Unknown confirmation action/, `${route} fell through the dispatch:\n${res.body}`);
    assert.equal(res.status, status, `${method} ${route} answered ${res.status}:\n${res.body}`);
    assert.match(String(res.body), body, `${method} ${route} answered the wrong handler:\n${res.body}`);
  }
});
