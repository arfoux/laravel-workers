import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// tools/routes-dump.mjs is a pure-JS replacement for `php artisan route:list
// --json`: it scans the app's route files with php-parser and prints the entries
// the compiled router and the build's coverage report are derived from. A route
// this scan does not recognize is not reported anywhere — it simply does not
// exist for the edge, which is the silent-wrong-serve failure the tool exists to
// prevent.
//
// These tests pin the entries for the Router helpers that register a route
// WITHOUT a plain verb (view/redirect/permanentRedirect/fallback), the real verb
// lists of any()/match()/query(), and the loud `notes` path for a verb list the
// scan cannot read. Every expectation is what `route:list --json` prints for the
// same route (verified against Laravel 13 / PHP 8.3: Router::$verbs,
// Router::match() + Route::__construct's HEAD append, Router::view()).
const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes-dump.mjs');

const ROUTES = `<?php
use App\\Http\\Controllers\\HomeController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', [HomeController::class, 'index'])->name('home');
Route::view('/about', 'about');
Route::view('/legal', 'legal', ['k' => 'v'], 201);
Route::redirect('/legacy', '/about');
Route::permanentRedirect('/old-home', '/about');
Route::fallback(fn () => view('about'));
Route::any('/echo', fn () => 'ok');
Route::match(['get', 'post'], '/m', fn () => 'm');
Route::match('post', '/p', fn () => 'p');
Route::query('/q', fn () => 'q');
Route::match($verbs, '/dynamic', fn () => 'd');
`;

function runTool(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-routes-'));
  mkdirSync(join(dir, 'bootstrap'), { recursive: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });
  writeFileSync(join(dir, 'artisan'), '<?php\n');
  writeFileSync(
    join(dir, 'bootstrap', 'app.php'),
    `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        health: '/up',
    )->create();
`
  );
  writeFileSync(join(dir, 'routes', 'web.php'), ROUTES);
  const res = spawnSync(process.execPath, [TOOL], {
    cwd: dir,
    env: { ...process.env, LW_APP_ROOT: dir, ...env },
    encoding: 'utf8',
  });
  let entries = null;
  try {
    entries = JSON.parse(res.stdout);
  } catch {
    /* the assertion below names the failure */
  }
  rmSync(dir, { recursive: true, force: true });
  return { res, entries };
}

test('routes-dump prints the Router helpers that carry no plain verb', () => {
  const { res, entries } = runTool();
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Array.isArray(entries), `expected JSON entries, got: ${res.stdout.slice(0, 200)}`);
  const by = new Map(entries.map((e) => [e.uri, e]));

  // Router::view -> ViewController on GET|HEAD (Router.php view())
  assert.equal(by.get('about').method, 'GET|HEAD');
  assert.equal(by.get('about').action, 'Illuminate\\Routing\\ViewController');
  assert.equal(by.get('legal').method, 'GET|HEAD');
  assert.equal(by.get('legal').action, 'Illuminate\\Routing\\ViewController');

  // Router::redirect/permanentRedirect -> RedirectController on Router::$verbs
  const anyMethods = 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|QUERY';
  assert.equal(by.get('legacy').method, anyMethods);
  assert.equal(by.get('legacy').action, 'Illuminate\\Routing\\RedirectController');
  assert.equal(by.get('old-home').method, anyMethods);

  // Router::fallback -> the placeholder uri route:list prints, GET|HEAD
  assert.equal(by.get('{fallbackPlaceholder}').method, 'GET|HEAD');
  assert.equal(by.get('{fallbackPlaceholder}').action, 'Closure');

  // the app's own controller route is untouched (the root route's uri is '/')
  assert.equal(by.get('/').action, 'App\\Http\\Controllers\\HomeController@index');
  assert.equal(by.get('/').name, 'home');
});

test('routes-dump prints the real verb list of any/match/query', () => {
  const { res, entries } = runTool();
  assert.equal(res.status, 0, res.stderr);
  const by = new Map(entries.map((e) => [e.uri, e]));
  assert.equal(by.get('echo').method, 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|QUERY');
  // Router::match(['get','post']) -> uppercased, then HEAD appended by
  // Route::__construct because GET is present
  assert.equal(by.get('m').method, 'GET|POST|HEAD');
  assert.equal(by.get('p').method, 'POST');
  assert.equal(by.get('q').method, 'QUERY');
});

test('an unreadable match() verb list is reported instead of guessed', () => {
  const { res, entries } = runTool();
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  // the verbs come from a variable: the route is still listed (never dropped)
  assert.equal(by.get('dynamic').method, 'MATCH');
  assert.match(res.stderr, /Route::match\(\) with a verb list this scan cannot read/);
});

test('the app-declared health route is reported, never dropped silently', () => {
  const { res, entries } = runTool();
  assert.equal(res.status, 0, res.stderr);
  // `health: '/up'` (the Laravel 11+ skeleton default) is a FRAMEWORK route
  // (ApplicationBuilder::withRouting) that no route file declares; route:list
  // prints it, the edge does not serve it. The scan must say so.
  assert.match(res.stderr, /health route/);
  assert.match(res.stderr, /GET \/up answers 404 where PHP answers 200/);
  assert.ok(entries.some((e) => e.uri === 'about'), 'the app routes are still listed');
});
