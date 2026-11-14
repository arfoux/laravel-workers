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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oracleAppRoot, oracleSkip } from '../../kernel/tests/oracle-app.mjs';
import { FakeD1 } from './_fake-d1.mjs';

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
Route::get('/wrapped', fn () => '')->name('wrapped');
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
  '/wrapped': 'wrapped-port',
};
// Fleet slugs copied from ports/packages — `wrapped-port` is the app-local
// handler this test writes itself, so it is not copied.
const SLUGS = [...new Set([...Object.values(PORTS).filter((s) => s !== 'wrapped-port'), 'localization'])];

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
  // The copy compiles the source app's own classes (its models, mailables and
  // listeners are still in `app/`), so a class that reads a config group the
  // source app declared (`config: ["mail"]`, read by a MailController) fails the
  // `--strict` build once the declaration is dropped — on a route this test
  // never wrote. Keep the source's `config` groups, drop only its route policy.
  const sourceRegistry = path.join(APP_ROOT, 'registry.json');
  const sourceConfig = existsSync(sourceRegistry) ? JSON.parse(readFileSync(sourceRegistry, 'utf8')).config : null;
  const registry = { autoSnapshot: false, ports: PORTS, middlewarePorts: { '/wrapped': ['localization'] } };
  if (sourceConfig) registry.config = sourceConfig;
  writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry, null, 2));
  // The fleet ports, flat under the app's own ports dir, so LW_PORTS_DIR=ports
  // makes `<slug>.mjs` resolve and the ports' `../../kernel/packages/*` imports
  // resolve inside dist/ (the build copies kernel/ to dist/kernel).
  mkdirSync(path.join(dir, 'ports'), { recursive: true });
  for (const slug of SLUGS) cpSync(path.join(PORTS_DIR, slug + '.mjs'), path.join(dir, 'ports', slug + '.mjs'));
  // A minimal route port that the `localization` MIDDLEWARE port wraps: the
  // middleware sets ctx.locale and continues; this handler reports it.
  writeFileSync(
    path.join(dir, 'ports', 'wrapped-port.mjs'),
    [
      "export default async function handle(ctx) {",
      "  const config = ctx.config && typeof ctx.config === 'object' ? ctx.config : {};",
      "  return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'locale=' + String(ctx.locale || '') + ' app=' + String(config['app.locale'] || '') };",
      "}",
      '',
    ].join('\n')
  );
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

// A D1 stand-in over real SQLite (tools/tests/_fake-d1.mjs): the smoke paths
// below run the ports' own `ensureSchema` + reads/writes for real.

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
    // No identity on ctx: every route must REFUSE (401) and reach its own handler
    // (a dispatch bug would answer `Unknown 2FA action`, or leak a body-email
    // selection). The email is not a credential — it selects nothing.
    const res = await twofa(kernelCtx({ method: 'POST', path: route, json: { email: 'a@b.test' } }), env);
    assert.doesNotMatch(String(res.body), /Unknown 2FA action/, `${route} fell through the dispatch:\n${res.body}`);
    answers.push(`${res.status} ${res.body}`);
  }
  assert.equal(
    new Set(answers).size,
    1,
    `the four 2FA routes must all reach their handlers and refuse without identity:\n${answers.join('\n')}`
  );
  assert.equal(answers[0], '401 {"message":"Unauthenticated."}');

  // Same trap, second module: `fortify-confirmation` dispatched on
  // `ctx.params.action`, which the router never fills (no `{action}` segment) —
  // every one of its routes once answered `404 Unknown confirmation action ''`.
  // Each now reaches its OWN handler: the auth-gated routes refuse 401, and the
  // signed /email/verify stays reachable (403 for a bogus link) — so the answers
  // differ by handler, not by dispatcher.
  const confirmation = await load('fortify-confirmation');
  // No identity on ctx: confirm/status/send must REFUSE (401) — the request
  // carries no guard, and the email is not a credential (nothing is leaked,
  // and no verification URL is minted for the body email). /email/verify is
  // the signed URL, so it is reachable without auth (403 invalid link here).
  const confirmExpect = [
    ['POST', '/user/confirm-password', 401, /Unauthenticated/],
    ['GET', '/user/confirm-password/status', 401, /Unauthenticated/],
    ['POST', '/email/verification-notification', 401, /Unauthenticated/],
    ['GET', '/email/verify/7/abc', 403, /Invalid verification link/],
  ];
  for (const [method, route, status, body] of confirmExpect) {
    const res = await confirmation(kernelCtx({ method, path: route, json: { email: 'a@b.test' } }), env);
    assert.doesNotMatch(String(res.body), /Unknown confirmation action/, `${route} fell through the dispatch:\n${res.body}`);
    assert.equal(res.status, status, `${method} ${route} answered ${res.status}:\n${res.body}`);
    assert.match(String(res.body), body, `${method} ${route} answered the wrong handler:\n${res.body}`);
  }
});

// registry.json → "middlewarePorts": the port runs BEFORE the route's handler
// through the REAL emitted wiring (dist/src/routes.generated.mjs + dist/kernel/
// router.mjs), not a hand-built table — so a build that drops the middlewarePorts
// annotation or the "MW <slug>" handler key fails here, not in production.
test('a middleware port wraps the route handler in the built artifact', { skip: noApp }, async () => {
  const { status, dir } = build();
  assert.equal(status, 0, 'the build must succeed before the artifacts can be read');
  const { routeTable, handlers } = await import(
    pathToFileURL(path.join(dir, 'dist', 'src', 'routes.generated.mjs')).href
  );
  const { dispatch } = await import(pathToFileURL(path.join(dir, 'dist', 'kernel', 'router.mjs')).href);

  const entry = routeTable.find((r) => r.uri === '/wrapped');
  assert.ok(entry, 'the built route table must carry /wrapped');
  assert.deepEqual(entry.middlewarePorts, ['localization'], 'the middlewarePorts annotation was dropped');
  assert.equal(typeof handlers['MW localization'], 'function', 'the "MW <slug>" handler key is missing');

  const env = { DB: new FakeD1(), APP_KEY: 'x'.repeat(32) };
  const res = await dispatch({ method: 'GET', path: '/wrapped' }, routeTable, handlers, env, {
    db: new FakeD1(),
    ctxExtra: { config: { 'app.locale': 'en' } },
  });
  assert.equal(res.status, 200, `the wrapped route must answer 200:\n${JSON.stringify(res)}`);
  // `localization` sets ctx.locale for a path with no locale prefix and returns
  // null; the route handler behind it must see the value on the SAME ctx.
  assert.equal(res.body, 'locale=en app=en', 'the middleware port state did not reach the handler');
});

// The fail-loud contract: a middleware port runs INSIDE the Worker, so a route
// with no request-time handler (a snapshot / an unhandled route) would answer
// from the asset bundle and the port would never run — the exact silent no-op
// this seam exists to close. The build must refuse it, not ship it.
test('a middleware port on a route with no request-time handler fails the build', { skip: noApp }, () => {
  const dir = makeApp();
  // The same route, but with NO `ports` handler behind it: the closure cannot
  // compile and autoSnapshot is off, so the route resolves to 'unhandled'.
  writeFileSync(
    path.join(dir, 'registry.json'),
    JSON.stringify({ autoSnapshot: false, ports: {}, middlewarePorts: { '/wrapped': ['localization'] } }, null, 2)
  );
  const res = spawnSync(process.execPath, [BUILD, '--strict'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LW_NO_BUILD_CACHE: '1', LW_PORTS_DIR: 'ports', PHP_BIN: PHP },
  });
  rmSync(dir, { recursive: true, force: true });
  const log = `${res.stdout || ''}${res.stderr || ''}`;
  assert.notEqual(res.status, 0, `the build must fail:\n${log}`);
  assert.match(log, /no request-time handler/, `the refusal must name the reason:\n${log}`);
});
