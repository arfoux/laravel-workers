// tools/tests/redirect-coverage.test.mjs — `Route::redirect()` in a build with
// NO compiled controller, and the handler it emits.
//
// WHY THIS FILE EXISTS. `Route::redirect()`/`permanentRedirect()` routes are
// served by the edge (the route table's `redirect` kind), not by a compiled
// controller. The build-time probe answers 302 for them, which lands them in
// `needsPort` — a "no handler, write a port" finding that the build then
// removes, because it *does* emit a handler. That removal used to sit inside
// the controller-compile step, which is guarded by `if (prepared.length)`: an
// app whose routes are ALL redirects (no controller to compile) never ran the
// step, so it never removed the finding, so `--strict` failed on every route it
// served. The failure was *conditional on unrelated routes* — adding one
// controller route to the same app made it build clean. That is the shape this
// file pins: the app below is redirect-only on purpose.
//
// It needs a Laravel app with `vendor/` (PHP 8.3 + the framework), so it SKIPS
// without one — the CI `test` job has no app, `parity-oracle` does. Run it with
//   LW_LARAVEL_APP=/path/to/app node --test tools/tests/redirect-coverage.test.mjs
// or let `tools/oracle-ran.mjs` run it (that gate turns a silent skip into a
// failure, so a skip cannot hide here).
//
// The app it builds is a TEMP COPY of that app with `vendor/` symlinked and
// `routes/web.php` replaced by redirects only: the checked-in app is never
// modified, and the copy stays small (no vendor tree, no node_modules).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oracleAppRoot, oracleSkip } from '../../kernel/tests/oracle-app.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(repoRoot, 'build.mjs');
const PHP = process.env.PHP_BIN || 'php';

const APP_ROOT = oracleAppRoot();
const noApp = APP_ROOT ? false : oracleSkip('redirect-coverage.test.mjs');

// The routes the copy carries. `permanentRedirect` pins the status argument
// (301, not the 302 default), `{id}` pins destination-parameter substitution.
const ROUTES = `<?php

use Illuminate\\Support\\Facades\\Route;

Route::redirect('/old', '/new');
Route::permanentRedirect('/perm', '/perm-dest');
Route::redirect('/u/{id}', '/users/{id}/profile');
`;

// Directories that must not be copied: `vendor` is symlinked instead (the
// whole point of the cheap copy), and the rest are build/dev artifacts of the
// source app that would either bloat the copy or leak a stale build state.
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'dist', '.cache', '.git']);
// `registry.json` is the source app's ROUTE POLICY, and this copy replaces the
// route set. An entry for a route the copy does not declare - a `static`
// snapshot or a port - makes the build fail on a route this test never wrote,
// which is what a source app with a prerendered page (`"/architecture":
// "static"`) turned into "this test needs a redirect-only route set". The
// premise under test is the route set, so the policy file goes with it.
const SKIP_FILES = new Set(['registry.json']);

function makeRedirectOnlyApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-redirect-only-'));
  cpSync(APP_ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(APP_ROOT, src);
      if (!rel) return true;
      if (SKIP_DIRS.has(rel.split(path.sep)[0])) return false;
      return !SKIP_FILES.has(path.basename(src));
    },
  });
  // A real `vendor/` inside the copy: `artisan` requires `__DIR__.'/vendor/autoload.php'`
  // and the build's PHP children boot the app, so the copy has to look like a
  // normal app. A junction (Windows) / dir symlink (POSIX) is enough and needs
  // no elevated rights.
  symlinkSync(path.join(APP_ROOT, 'vendor'), path.join(dir, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(dir, 'routes', 'web.php'), ROUTES);
  return dir;
}

// One build, shared by both tests (it is the expensive part: PHP boots the copy
// four times for the route dump, the config fold and the probe).
let built = null;
function build() {
  if (!built) {
    built = (() => {
      const dir = makeRedirectOnlyApp();
      const res = spawnSync(process.execPath, [BUILD, '--strict'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // The assertions read the build LOG, and a warm cache prints only
        // "build cache: hit". The copy has no cache, but the build would then
        // write one: force the full pipeline so a second run in the same
        // checkout cannot turn this test into a cache check.
        env: { ...process.env, LW_NO_BUILD_CACHE: '1', PHP_BIN: PHP },
      });
      const log = `${res.stdout || ''}${res.stderr || ''}`;
      return { dir, status: res.status, log };
    })();
  }
  return built;
}

// The temp copy goes away whatever the outcome: a failing build is exactly when
// its copy used to be left behind, and the log it printed is the evidence.
after(() => {
  if (built) rmSync(built.dir, { recursive: true, force: true });
});

test('a redirect-only app builds --strict (no controller was needed to clear the finding)', { skip: noApp }, () => {
  const { status, log } = build();
  // The regression: before the fix this was exit 1 with one UNHANDLED line per
  // redirect route ("HTTP 302 non-HTML"), i.e. a hard failure on routes the
  // edge serves. The controller count is asserted because it is what makes the
  // case reachable at all: with any compiled controller the old removal ran and
  // the failure disappeared, so a green run here only means something when the
  // route set really has no controller.
  assert.match(log, /controllers 0\b/, `this test needs a redirect-only route set:\n${log}`);
  assert.equal(status, 0, `a redirect-only app must build --strict:\n${log}`);
  assert.doesNotMatch(log, /UNHANDLED/, `a served route was reported as unhandled:\n${log}`);
  assert.match(log, /coverage: all \d+ route\(s\) handled/, `the coverage line is missing:\n${log}`);
  // The controller-compile pass never runs here, so the framework's
  // `RedirectController` must not be resolved as an app class either: listing
  // the redirect routes as controller targets printed a "cannot resolve
  // Illuminate\Routing\RedirectController via composer autoload" line that read
  // like a gap the edge already covers.
  assert.doesNotMatch(log, /RedirectController/, `a redirect route was treated as a controller:\n${log}`);
});

test('the emitted redirect handlers answer with the recorded status and destination', { skip: noApp }, async () => {
  const { status } = build();
  assert.equal(status, 0, 'the build must succeed before the artifacts can be read');
  const dist = (p) => pathToFileURL(path.join(built.dir, 'dist', p)).href;
  const { routeTable, handlers } = await import(dist('src/routes.generated.mjs'));

  // The route table carries the *template* destination (Laravel's own route
  // data): `{id}` is substituted per request, not at build time.
  const redirects = routeTable.filter((r) => r.kind === 'redirect').map((r) => [r.uri, r.status, r.destination]);
  assert.deepEqual(
    redirects.sort(),
    [
      ['/old', 302, '/new'],
      ['/perm', 301, '/perm-dest'],
      ['/u/{id}', 302, '/users/{id}/profile'],
    ].sort(),
    'the route table must record each redirect as its own kind, with its status and destination'
  );

  const ctx = (params = {}) => ({ request: { routeParams: () => params } });
  const answer = async (key, params) => {
    const handler = handlers[key];
    assert.equal(typeof handler, 'function', `no handler emitted for ${key}`);
    const res = await handler(ctx(params));
    return { status: res.status, location: res.headers && res.headers.location };
  };

  // Trap 1 — `redirect($uri, $destination, $status)` takes the status from its
  // THIRD argument: recording only "permanent" would answer 302 here.
  assert.deepEqual(await answer('GET /old'), { status: 302, location: '/new' });
  assert.deepEqual(await answer('GET /perm'), { status: 301, location: '/perm-dest' });
  // Trap 2 — the destination's `{param}` comes from the request's route params.
  assert.deepEqual(await answer('GET /u/{id}', { id: '42' }), { status: 302, location: '/users/42/profile' });
  // Trap 3 — a redirect registers with `any()`, so every compiled verb answers
  // the same thing instead of falling through to a 404/405.
  for (const key of ['HEAD /old', 'POST /old', 'PUT /old', 'PATCH /old', 'DELETE /old', 'OPTIONS /old', 'QUERY /old']) {
    if (!handlers[key]) continue; // verbs the build does not compile at all
    assert.deepEqual(await answer(key), { status: 302, location: '/new' }, `${key} must answer the redirect`);
  }
  // Trap 4 — the destination is emitted raw: Laravel's `RedirectController`
  // never appends the request's query string, and the kernel absolutises it.
  assert.deepEqual(await answer('GET /old'), { status: 302, location: '/new' });
});
