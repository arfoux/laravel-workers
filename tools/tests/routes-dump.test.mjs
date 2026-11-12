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

function runTool(env = {}, routesSource = ROUTES, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-routes-'));
  mkdirSync(join(dir, 'bootstrap'), { recursive: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });
  for (const [rel, body] of Object.entries(extra)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
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
  writeFileSync(join(dir, 'routes', 'web.php'), routesSource);
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

test('two URIs that compile to one controller module are refused, not silently merged', () => {
  // build.mjs slugifyRoute() turns `/clash/x` and `/clash-x` into the SAME module
  // name, `clash-x.mjs`, and writes `dist/src/controllers/<slug>.mjs` per route -
  // so one handler would overwrite the other and the route table would point both
  // URIs at it. The scan refuses instead of letting the build serve one handler
  // for two URLs.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/clash/x', fn () => 'a');
Route::get('/clash-x', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Array.isArray(entries), 'the JSON route table is still printed');
  assert.match(res.stderr, /both compile to the controller module "clash-x\.mjs"/);
  assert.match(res.stderr, /rename one route/);
});

test('routes-dump expands Route::resources()/apiResources() like route:list', () => {
  // Router::resources() loops the map and calls resource($name, $controller,
  // $options) per entry (Router.php); apiResources() is the api variant. Before
  // this, the whole chain was unrecognized and its routes were ABSENT from the
  // table — the edge would 404 what PHP answers. Verified against `artisan
  // route:list --json` for `['photos' => C, ['only'=>['index','show']]]` and
  // `apiResources(['tags' => C], ['except'=>['destroy']])`.
  const { res, entries } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\PhotoController;
use App\\Http\\Controllers\\TagController;
use Illuminate\\Support\\Facades\\Route;

Route::resources(['photos' => PhotoController::class], ['only' => ['index', 'show']]);
Route::apiResources(['tags' => TagController::class], ['except' => ['destroy']]);
`
  );
  assert.equal(res.status, 0, res.stderr);
  const rows = (entries || []).map((e) => [e.name, e.method, e.uri, e.action].join(' | '));
  assert.deepEqual(rows, [
    'photos.index | GET|HEAD | photos | App\\Http\\Controllers\\PhotoController@index',
    'photos.show | GET|HEAD | photos/{photo} | App\\Http\\Controllers\\PhotoController@show',
    'tags.index | GET|HEAD | tags | App\\Http\\Controllers\\TagController@index',
    'tags.store | POST | tags | App\\Http\\Controllers\\TagController@store',
    'tags.show | GET|HEAD | tags/{tag} | App\\Http\\Controllers\\TagController@show',
    'tags.update | PUT|PATCH | tags/{tag} | App\\Http\\Controllers\\TagController@update',
  ]);
  assert.doesNotMatch(res.stderr, /not expanded by the static scanner/);
});

test('a resources() list the scan cannot read is refused, not dropped', () => {
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::resources($dynamic);
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Array.isArray(entries), 'the JSON route table is still printed');
  assert.match(res.stderr, /Route::resources\(\) .* is not expanded by the static scanner/);
});

test('Route::singleton() is refused, not silently dropped', () => {
  // The scan cannot expand singleton/apiSingleton yet; leaving them out would
  // serve a 404 for a route PHP answers. It reports, and build.mjs blocks.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::singleton('profile', fn () => 'p');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Array.isArray(entries), 'the JSON route table is still printed');
  assert.match(res.stderr, /Route::singleton\(\) at routes\/web\.php is not expanded by the static scanner/);
});

test('a group/chain prefix is JOINED onto the uri, not concatenated', () => {
  // `Route::prefix('api')->group(fn => Route::get('users'))` answers `api/users`
  // — Router::prefix() trims and joins with '/' — and RouteGroup::formatPrefix()
  // does the same for nested group prefixes. The scan used plain `+`, so every
  // route under a prefixed group was served at a URI that does not exist
  // (`apiusers`). Same for a chain-form registrar prefix.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('api')->group(function () {
    Route::get('users', fn () => 'a');
    Route::prefix('v2')->group(function () {
        Route::get('users', fn () => 'b');
    });
});
Route::prefix('legacy')->get('ping', fn () => 'c');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(
    (entries || []).map((e) => e.uri),
    ['api/users', 'api/v2/users', 'legacy/ping']
  );
});

test('a group DOMAIN lands on the route (the edge must not serve it on any host)', () => {
  // `Route::domain('admin.example.com')->group(...)` restricts every route in
  // the group to that host; route:list prints it in the `domain` column. The scan
  // hardcoded `domain: null`, so the edge answered those routes on ANY host.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::domain('admin.example.com')->prefix('a')->group(function () {
    Route::get('dash', fn () => 'a');
});
Route::domain('api.example.com')->group(function () {
    Route::resource('z', 'App\\\\Http\\\\Controllers\\\\ZController');
});
Route::prefix('plain')->get('x', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  assert.equal(by.get('a/dash').domain, 'admin.example.com');
  assert.equal(by.get('z').domain, 'api.example.com');
  assert.equal(by.get('plain/x').domain, null);
});

test('a chain-form registrar name/middleware is kept, and a post-verb ->name() APPENDS', () => {
  // `Route::prefix('p')->name('n.')->middleware('auth')->get('u', ...)` — the
  // registrar attributes land on the route; `->name('tail')` AFTER the verb
  // concatenates (`Route::name()` appends: 'n.' + 'tail'). `Route::prefix()` in
  // a chain is NOT a group prefix (RouteRegistrar::attribute('prefix')) — it is
  // kept, as Laravel keeps it in the action.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('p')->name('n.')->middleware('auth')->get('u', fn () => 'a')->name('tail');
`
  );
  assert.equal(res.status, 0, res.stderr);
  const r = (entries || []).find((e) => e.uri === 'p/u');
  assert.equal(r.name, 'n.tail');
  assert.deepEqual(r.middleware, ['web', 'auth']);
});

test('a controller `$this->middleware()` with a chained ->except()/->only()/string value is honoured', () => {
  // `ControllerMiddlewareOptions` (`Controller::middleware()` ->
  // `new ControllerMiddlewareOptions($options)`): `$options['only']`/`['except']`
  // are CAST to array (`(array) $options['only']` and a bare string is a single
  // entry) and the chained `->only(...)`/`->except(...)` are VARIADIC
  // (`func_get_args()`). The reader used to accept the array-literal options
  // only, so `->except(['show'])` was dropped and the guard was attached to
  // EVERY method — wider than PHP, which ships a middleware the app excluded
  // (the mirror image: `->only()` narrowed away is a MISSING guard).
  const { res, entries } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\ThingController;
use Illuminate\\Support\\Facades\\Route;
Route::get('a', [ThingController::class, 'index']);
Route::get('b', [ThingController::class, 'show']);
Route::get('c', [ThingController::class, 'other']);
`,
    {
      'app/Http/Controllers/ThingController.php': `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Routing\\Controller;

class ThingController extends Controller
{
    public function __construct()
    {
        $this->middleware('auth', ['except' => ['index']]);
        $this->middleware('log')->only('index');
    }

    public function index() {}
    public function show() {}
    public function other() {}
}
`,
    }
  );
  // The controller lives beside the route file in the same temp app.
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  // `$this->middleware('auth', ['except' => ['index']])` + `$this->middleware('log')->only('index')`
  assert.deepEqual(by.get('a').middleware, ['web', 'log']);
  assert.deepEqual(by.get('b').middleware, ['web', 'auth']);
  assert.deepEqual(by.get('c').middleware, ['web', 'auth']);
});

test('a `$this->middleware()` nested in a guard SPEAKS (it cannot be evaluated)', () => {
  const { res } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\GuardedController;
use Illuminate\\Support\\Facades\\Route;
Route::get('g', [GuardedController::class, 'index']);
`,
    {
      'app/Http/Controllers/GuardedController.php': `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Routing\\Controller;

class GuardedController extends Controller
{
    public function __construct()
    {
        if (config('app.env') === 'production') {
            $this->middleware('auth');
        }
    }

    public function index() {}
}
`,
    }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /\$this->middleware\(\.\.\.\) inside a if — not evaluated/);
});

test('withoutMiddleware subtracts from the gathered list (route and group level)', () => {
  // `->withoutMiddleware('web')` removes 'web' from what the route would run
  // (Router::resolveMiddleware rejects by name); a group-level
  // `withoutMiddleware` applies to its routes too. Ignoring it would run a
  // middleware the app explicitly removed.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::middleware('web')->group(function () {
    Route::get('open', fn () => 'a')->withoutMiddleware('web');
});
Route::middleware(['a', 'b'])->withoutMiddleware('b')->group(function () {
    Route::get('g', fn () => 'b');
});
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  assert.deepEqual(by.get('open').middleware, []);
  assert.deepEqual(by.get('g').middleware, ['web', 'a']);
});

test('a STRING controller is resolved (Route::resource with a class-string)', () => {
  // `Route::resource('photos', 'App\\Http\\Controllers\\PhotoController')` is the
  // classic spelling; the scan only read `X::class`, so the resource was reported
  // "no resolvable controller" and dropped — the edge 404s what PHP answers.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::resource('photos', 'App\\\\Http\\\\Controllers\\\\PhotoController');
Route::get('/one', 'App\\\\Http\\\\Controllers\\\\PhotoController@show');
`
  );
  assert.equal(res.status, 0, res.stderr);
  const rows = (entries || []).map((e) => [e.method, e.uri, e.action].join(' | '));
  assert.ok(rows.includes('GET|HEAD | photos | App\\Http\\Controllers\\PhotoController@index'), rows.join('\n'));
  assert.ok(rows.includes('GET|HEAD | one | App\\Http\\Controllers\\PhotoController@show'), rows.join('\n'));
  assert.doesNotMatch(res.stderr, /no resolvable controller/);
});

test('softDeletableResources expands to the same route set as resources', () => {
  // `Router::softDeletableResources()` loops the map and calls
  // `resource(...)->withTrashed()`; ->withTrashed() only relaxes binding, it adds
  // NO route. Treating the helper as un-expandable refused a build whose table
  // PHP serves fine.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::softDeletableResources(['notes' => 'App\\\\Http\\\\Controllers\\\\NoteController']);
`
  );
  assert.equal(res.status, 0, res.stderr);
  const rows = (entries || []).map((e) => [e.method, e.uri].join(' | '));
  assert.deepEqual(rows, [
    'GET|HEAD | notes',
    'GET|HEAD | notes/create',
    'POST | notes',
    'GET|HEAD | notes/{note}',
    'GET|HEAD | notes/{note}/edit',
    'PUT|PATCH | notes/{note}',
    'DELETE | notes/{note}',
  ]);
  assert.doesNotMatch(res.stderr, /not expanded by the static scanner/);
});

test('a per-method resource middleware option is refused, not dropped', () => {
  // `middleware_for` / `->middlewareFor()` guards ONE resource method; ignoring
  // it would serve that method with no middleware. The scanner refuses so
  // build.mjs can block.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::resource('x', 'App\\\\Http\\\\Controllers\\\\XController', ['middleware_for' => ['show' => 'auth']]);
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Array.isArray(entries), 'the JSON route table is still printed');
  assert.match(res.stderr, /uses a per-method middleware option/);
});

test('a name-prefixed GROUP names a route that declares none', () => {
  // `Route::group(['as' => 'g2.'], fn => Route::get('y2'))` answers the name
  // `g2.` — RouteGroup::formatAs keeps the old `as` when the new one has none,
  // and route:list prints it. Without the group prefix the edge served a route
  // with route()/URL::route() unresolvable by its PHP name.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::group(['as' => 'g2.'], function () {
    Route::get('y2', fn () => 'a');
});
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal((entries || [])[0].name, 'g2.');
});

test('the root URI stays "/" when it is a group/chain root', () => {
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/', fn () => 'a');
Route::prefix('api3')->get('/', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual((entries || []).map((e) => e.uri), ['/', 'api3']);
});

test('a chain-form registrar prefix/domain before ->resource() is DROPPED (as PHP does)', () => {
  // RouteRegistrar::resource() passes its attributes as $options, but
  // ResourceRegistrar reads no 'prefix'/'domain' from $options — so
  // `Route::prefix('v2')->resource('pp', C)` answers `pp`, and
  // `Route::domain('d')->resource('rr', C)` answers an empty domain. The `as`
  // option IS read, so `->name('nn.')` prefixes every route name. Verified
  // against a booted app (Router/ResourceRegistrar, Laravel 13).
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('v2')->resource('pp', 'App\\\\Http\\\\Controllers\\\\ZController');
Route::domain('d.example.com')->resource('rr', 'App\\\\Http\\\\Controllers\\\\ZController');
Route::prefix('v3')->name('nn.')->resource('qq', 'App\\\\Http\\\\Controllers\\\\ZController');
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri + '|' + e.name, e]));
  assert.ok(by.has('pp|pp.index'), [...by.keys()].join('\n'));
  assert.equal(by.get('pp|pp.index').domain, null);
  assert.ok(by.has('rr|rr.index'));
  assert.equal(by.get('rr|rr.index').domain, null);
  assert.ok(by.has('qq|nn..qq.index'), [...by.keys()].join('\n'));
});

test('a DOMAIN on the GROUP applies to a resource (unlike the chain form)', () => {
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::domain('e.example.com')->group(function () {
    Route::resource('gg', 'App\\\\Http\\\\Controllers\\\\ZController');
});
`
  );
  assert.equal(res.status, 0, res.stderr);
  const r = (entries || []).find((e) => e.uri === 'gg');
  assert.equal(r.domain, 'e.example.com');
});

test('the root URI and /home do not collide (BookStack declares both)', () => {
  // `slugifyRoute('/')` used to fall back to the literal `home`, so the LEGAL
  // route `/home` collided with it and the whole build refused - in an app whose
  // routes nobody can rename. BookStack's routes/web.php:225-226 declares both,
  // both answering HomeController@index.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/', fn () => 'a');
Route::get('/home', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal((entries || []).length, 2);
  assert.doesNotMatch(res.stderr, /both compile to the controller module/);
});

test('the root fallback is only reachable by a URI with no alphanumeric left', async () => {
  const { slugifyRoute, ROOT_SLUG } = await import('../route-slug.mjs');
  // The empty-slug family shares one name (`/`, `/-`, `/__`): two of them at
  // once still refuse, which is honest - they really are two URIs, one module.
  assert.equal(slugifyRoute('/'), ROOT_SLUG);
  assert.equal(slugifyRoute('/__'), ROOT_SLUG);
  // A URI that carries a segment can never answer the fallback, which is what
  // made the old `home` fallback wrong: `/home` is a route of its own.
  assert.equal(slugifyRoute('/home'), 'home');
  assert.equal(slugifyRoute('/_home'), 'home');
  for (const uri of ['/home', '/root', '/_root', '/index', '/{a}/{b}']) {
    assert.notEqual(slugifyRoute(uri), ROOT_SLUG);
  }
});

test('distinct URIs that do NOT collide stay silent', () => {
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/posts/{post}', fn () => 'a');
Route::get('/posts-latest', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal((entries || []).length, 2);
  assert.doesNotMatch(res.stderr, /both compile to the controller module/);
});

test('two URIs differing only in case are refused (the modules land on one file)', () => {
  // #366: the local filesystem is case-insensitive on Windows/macOS, so
  // `/Posts` and `/posts` are two real Laravel routes whose controller modules
  // would land on ONE `posts.mjs` - whichever was written last would serve both
  // URLs. The slug is case-folded, so the scan sees the collision and refuses.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/Posts', fn () => 'a');
Route::get('/posts', fn () => 'b');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal((entries || []).length, 2, 'the JSON route table is still printed');
  assert.match(res.stderr, /both compile to the controller module "posts\.mjs"/);
});

test('the slug is case-folded: /Posts writes the same module name as /posts', async () => {
  const { slugifyRoute } = await import('../route-slug.mjs');
  assert.equal(slugifyRoute('/Posts'), 'posts');
  assert.equal(slugifyRoute('/Posts/{Post}'), 'posts-post');
  assert.equal(slugifyRoute('/API/v1'), 'api-v1');
  assert.equal(slugifyRoute('_ROOT'), 'root');
});

test('a registrar chain uses last-write-wins; a route method is case-insensitive', () => {
  // PHP method names are case-insensitive (`->Name()` IS `->name()`, probed:
  // `Route::get('case1',..)->Name('CasedName')` answers name `CasedName`;
  // `->Middleware('auth')` answers middleware `[web, auth]`). A raw-case
  // compare silently dropped the name (the route had none) or the guard (the
  // edge served it UNGUARDED).
  //
  // A `RouteRegistrar` attribute BEFORE the verb is last-write-wins, and so is
  // a registrar chain on a GROUP: probed against Laravel 13 / PHP 8.3,
  // `Route::prefix('a')->prefix('b')->group(fn)` mounts `b/`, NOT `a/b/`;
  // `Route::name('n1.')->name('n2.')->group(fn)` names the child `n2.y`;
  // `Route::as('s1.')->as('s2.')->group(fn)` names it `s2.z`; and a repeated
  // literal array key keeps the LAST one (`['prefix'=>'p1','prefix'=>'p2']`
  // mounts `p2/`).
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('a')->prefix('b')->group(function () {
    Route::get('x', fn () => 'x');
});
Route::name('n1.')->name('n2.')->group(function () {
    Route::get('y', fn () => 'y')->name('child');
});
Route::as('s1.')->as('s2.')->group(function () {
    Route::get('z', fn () => 'z')->name('child');
});
Route::group(['prefix' => 'p1', 'prefix' => 'p2'], function () {
    Route::get('w', fn () => 'w');
});
Route::get('case1', fn () => 'c')->Name('CasedName');
Route::get('case2', fn () => 'c')->Middleware('auth');
Route::prefix('mid')->group(function () {
    Route::get('case3', fn () => 'c')->WITHOUTMIDDLEWARE('web');
});
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  // `b/x` not `a/b/x`; `p2/w` not `p1/p2/w`.
  assert.ok(by.get('b/x'), `expected b/x, got: ${[...by.keys()].join(', ')}`);
  assert.equal(by.get('b/x').middleware.join(','), 'web');
  assert.ok(by.get('p2/w'), `expected p2/w, got: ${[...by.keys()].join(', ')}`);
  // `name()` and `as()` are the SAME registrar attribute, and the group prefix
  // lands in the route NAME (the URI stays `z`).
  assert.equal(by.get('z').name, 's2.child');
  assert.equal(by.get('y').name, 'n2.child');
  // the case-insensitive route methods are honored.
  assert.equal(by.get('case1').name, 'CasedName');
  assert.equal(by.get('case2').middleware.join(','), 'web,auth');
  assert.equal(by.get('mid/case3').middleware.length, 0);
});

test('an arrow-function handler is a closure route, not a dropped one', () => {
  // `fn () => ...` is a DIFFERENT php-parser node from `function () {...}`
  // (`kind: 'arrowfunc'`, and the body is the expression, not a statement
  // block). The scan must read both, because the entry it does not recognize
  // does not exist for the edge: measured on Laravel 13.37, a
  // `Route::get('/x', fn () => 'x')` served 404 on the edge where PHP answered
  // 200, and the build blamed "route(s) defined outside routes/" - the `path`
  // below is what build.mjs:isAppRoute() keys on.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/arrow', fn () => view('welcome'));
Route::get('/block', function () { return view('welcome'); });
Route::prefix('g')->middleware('auth')->group(fn () => Route::get('/inner', fn () => 'inner'));
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  assert.equal(by.get('arrow').action, 'Closure');
  assert.match(by.get('arrow').path, /^routes\/web\.php:\d+$/, 'the arrow handler carries its file:line');
  assert.match(by.get('block').path, /^routes\/web\.php:\d+$/, 'the closure handler keeps its file:line');
  // an arrow-function GROUP: every route inside it is dumped, with the group
  // attributes applied (a group the scan cannot read drops its routes with no
  // note at all).
  assert.ok(by.get('g/inner'), `expected g/inner, got: ${[...by.keys()].join(', ')}`);
  assert.equal(by.get('g/inner').action, 'Closure');
  assert.deepEqual([...by.get('g/inner').middleware].sort(), ['auth', 'web']);
  assert.match(by.get('g/inner').path, /^routes\/web\.php:\d+$/);
});

test('a controller group resolves bare method actions (Router::prependGroupController)', () => {
  // `Route::controller(X::class)->group(fn () => Route::get('/x', 'index'))` is
  // the Laravel 11+ idiom. PHP resolves a bare method name against the group -
  // `Router::prependGroupController()` (Router.php:664-684) answers `X@index` -
  // and `route:list --json` prints that FQCN. The scan used to print `index`, so
  // the build tried to resolve a CLASS named `index` ("cannot resolve index via
  // composer autoload") and a --strict build REFUSED THE WHOLE APP.
  //
  // Every expectation below is what `route:list --json` answers for the same
  // route file (PHP 8.3.30 + Laravel 13.37, probed on the e2e app; all eight
  // shapes byte-identical to the scan after the fix).
  const { res, entries } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\HomeController;
use App\\Http\\Controllers\\SecondController;
use Illuminate\\Support\\Facades\\Route;

Route::controller(HomeController::class)->group(function () {
    Route::get('/cg1', 'index');
    Route::get('/cg2', 'show')->name('cg.two');
    Route::get('/cg3', [HomeController::class, 'show']);
    Route::get('/cg4', 'App\\\\Http\\\\Controllers\\\\HomeController@show');
    Route::group(['controller' => HomeController::class], function () {
        Route::get('/cg5', 'index');
    });
    Route::controller(SecondController::class)->group(function () {
        Route::get('/cg6', 'index');
    });
    Route::get('/cg7', 'index');
});
Route::controller(SecondController::class)->group(fn () => Route::get('/cg8', 'index'));
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  const action = (uri) => (by.get(uri) || {}).action;
  // the bare method becomes Group\Controller@method
  assert.equal(action('cg1'), 'App\\Http\\Controllers\\HomeController@index');
  assert.equal(action('cg2'), 'App\\Http\\Controllers\\HomeController@show');
  assert.equal(by.get('cg2').name, 'cg.two');
  // an array action and an already-`@` string are left alone (they carry '@')
  assert.equal(action('cg3'), 'App\\Http\\Controllers\\HomeController@show');
  assert.equal(action('cg4'), 'App\\Http\\Controllers\\HomeController@show');
  // the group attributes ARRAY carries `controller` too (Router::group() reads it)
  assert.equal(action('cg5'), 'App\\Http\\Controllers\\HomeController@index');
  // RouteGroup::merge() (:23-25) unsets the outer controller as soon as an inner
  // group declares one, and the routes AFTER the inner group get the outer one back
  assert.equal(action('cg6'), 'App\\Http\\Controllers\\SecondController@index');
  assert.equal(action('cg7'), 'App\\Http\\Controllers\\HomeController@index');
  // an arrow-function group reads the same way
  assert.equal(action('cg8'), 'App\\Http\\Controllers\\SecondController@index');
});

test('a namespace group prefixes the controller action (Router::prependGroupNamespace)', () => {
  // `Route::namespace('App\\Http\\Controllers')->group(fn)` still works in
  // Laravel 13: `Router::convertToControllerAction()` (Router.php:621-641) runs
  // the controller prepend FIRST and the namespace prepend SECOND
  // (`prependGroupNamespace()`, :653-661), which skips a `uses` with a leading
  // backslash or one that already starts with the namespace;
  // `RouteGroup::formatNamespace()` (:105-114) CONCATENATES nested namespaces and
  // treats a leading backslash as absolute (replacing the outer one).
  //
  // The scan answered the bare string, so the build looked for a class named
  // `HomeController` ("cannot resolve ... via composer autoload") and a --strict
  // build refused the app. Every expectation is what `route:list --json` printed
  // for the same routes (PHP 8.3.30 + Laravel 13.37, e2e app; 7/7 identical).
  const { res, entries } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\HomeController;
use Illuminate\\Support\\Facades\\Route;

Route::namespace('App\\\\Http\\\\Controllers')->group(function () {
    Route::get('/ns1', 'HomeController@index');
    Route::get('/ns2', [HomeController::class, 'index']);
    Route::get('/ns3', 'App\\\\Http\\\\Controllers\\\\HomeController@index');
    Route::view('/ns4', 'about');
});
Route::namespace('App')->group(function () {
    Route::namespace('Http\\\\Controllers')->group(function () {
        Route::get('/ns5', 'HomeController@index');
    });
});
Route::namespace('\\\\App\\\\Http\\\\Controllers')->group(function () {
    Route::get('/ns6', 'HomeController@index');
});
Route::namespace('App\\\\Http\\\\Controllers')->group(fn () => Route::get('/ns7', 'HomeController@index'));
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  const action = (uri) => (by.get(uri) || {}).action;
  const FQ = 'App\\Http\\Controllers\\HomeController@index';
  assert.equal(action('ns1'), FQ, 'a bare string is prefixed with the group namespace');
  assert.equal(action('ns2'), FQ, 'an array action already carries the namespace');
  assert.equal(action('ns3'), FQ, 'a string that already starts with the namespace is left alone');
  // `Router::view()` registers `\\Illuminate\\Routing\\ViewController` WITH a
  // leading backslash (Router.php:301), which is what exempts it.
  assert.equal(action('ns4'), 'Illuminate\\Routing\\ViewController');
  assert.equal(action('ns5'), FQ, 'nested namespaces concatenate (App + Http\\Controllers)');
  assert.equal(action('ns6'), FQ, 'a leading backslash makes the inner namespace absolute');
  assert.equal(action('ns7'), FQ, 'an arrow-function group reads the same way');
});

test('a resource name containing a slash is a PREFIXED resource, not a wildcard', () => {
  // `ResourceRegistrar::register()` (:85-92) sends any name containing a slash to
  // `prefixedResource()`: everything before the LAST slash is a URI prefix
  // (`getResourcePrefix()`, :251-261) and only the last segment names the
  // resource. The scan used the whole string, so the show route answered
  // `admin/slugs/{admin/slug}` where PHP answers `admin/slugs/{slug}` - a
  // wildcard the app's controller (and Laravel's implicit binding) cannot match.
  //
  // Expectations are `route:list --json`'s own output for the same routes (PHP
  // 8.3.30 + Laravel 13.37 on the e2e app: uri, name and action all identical).
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;

Route::resource('admin/slugs', 'App\\\\Http\\\\Controllers\\\\SlugController')->only(['index', 'show']);
Route::resource('/lead', 'App\\\\Http\\\\Controllers\\\\SlugController')->only(['show']);
Route::resource('deep/a/b/nested', 'App\\\\Http\\\\Controllers\\\\SlugController')->only(['show']);
// a namespace group + a controller name the file does NOT import
Route::namespace('App\\\\Http\\\\Controllers')->group(fn () => Route::resource('res', 'SlugController')->only(['index']));
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  const FQ = 'App\\Http\\Controllers\\SlugController';
  // the prefix lands in the URI, the WILDCARD is the last segment only
  assert.ok(by.get('admin/slugs'), `expected admin/slugs, got: ${[...by.keys()].join(', ')}`);
  assert.ok(by.get('admin/slugs/{slug}'), `expected admin/slugs/{slug}, got: ${[...by.keys()].join(', ')}`);
  assert.equal(by.get('admin/slugs/{slug}').name, 'slugs.show');
  assert.equal(by.get('admin/slugs').name, 'slugs.index');
  assert.equal(by.get('admin/slugs/{slug}').action, FQ + '@show');
  // a LEADING slash leaves an EMPTY prefix (`explode('/')` keeps the empty first
  // segment), so the URI has no leading slash either
  assert.ok(by.get('lead/{lead}'), `expected lead/{lead}, got: ${[...by.keys()].join(', ')}`);
  assert.equal(by.get('lead/{lead}').name, 'lead.show');
  // every slash segment is a prefix, not part of the wildcard
  assert.ok(by.get('deep/a/b/nested/{nested}'), `expected deep/a/b/nested/{nested}, got: ${[...by.keys()].join(', ')}`);
  // the group namespace applies to a resource action too
  assert.equal(by.get('res').action, FQ + '@index');
  assert.equal(by.get('res').name, 'res.index');
});

test('an invokable controller route carries the class as the action and a null path', () => {
  // `Route::get('/invokable', X::class)` is Laravel's invokable form: the class
  // itself is the action and Laravel runs `X::__invoke()`, so `route:list --json`
  // prints `X@__invoke` with `path: null` (only a CLOSURE route carries a
  // file:line). That pair is what build.mjs:isAppRoute() keys on — an action that
  // is neither '' nor 'Closure' is an app route — so an entry the scan reports
  // with an empty action is blamed as "route(s) defined outside routes/" and the
  // edge answers 404 where PHP answers 200 (audit #724: the array form and the
  // class-string form must land on the SAME action, and the build's own
  // `action.slice(at + 1) : '__invoke'` fallback (build.mjs:2034) agrees).
  const { res, entries } = runTool(
    {},
    `<?php
use App\\Http\\Controllers\\HomeController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/invokable', HomeController::class);
Route::get('/array', [HomeController::class, '__invoke']);
Route::get('/named-method', [HomeController::class, 'index']);
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  const FQ = 'App\\Http\\Controllers\\HomeController';
  assert.equal(by.get('invokable').action, FQ + '@__invoke');
  assert.equal(by.get('invokable').path, null, 'a controller route has no file:line (Laravel reports path: null)');
  assert.equal(by.get('array').action, FQ + '@__invoke');
  assert.equal(by.get('named-method').action, FQ + '@index');
});

test('the scan carries every route requirement Laravel would compile', () => {
  // `route:list --json` prints NO requirement, so the only source for
  // `$route->wheres` is the route file itself — and without them the edge
  // answers a request Laravel rejects, and never reaches a `Route::fallback()`
  // (which IS `{fallbackPlaceholder}` + `where('fallbackPlaceholder', '.*')`).
  // Every expectation below was read off a live Laravel 13.37 app through
  // `$route->wheres` (the same app the kernel fuzz compares against).
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/two-arg/{id}', fn (string $id) => 'x')->where('id', '[0-9]+');
Route::get('/array/{a}/{b}', fn () => 'x')->where(['a' => '[0-9]+', 'b' => '[a-z]+']);
Route::get('/num/{id}', fn () => 'x')->whereNumber('id');
Route::get('/alpha/{id}', fn () => 'x')->whereAlpha('id');
Route::get('/alnum/{id}', fn () => 'x')->whereAlphaNumeric('id');
Route::get('/uuid/{id}', fn () => 'x')->whereUuid('id');
Route::get('/ulid/{id}', fn () => 'x')->whereUlid('id');
Route::get('/in/{slug}', fn () => 'x')->whereIn('slug', ['one', 'two.v']);
Route::get('/unused/{a}', fn () => 'x')->where('other', '[0-9]+');
Route::get('/star/{p*}', fn () => 'x');
Route::get('/empty/{id}', fn () => 'x')->where('id', '');
Route::get('/emptyin/{id}', fn () => 'x')->whereIn('id', []);
Route::where(['reg' => '[a-z]+'])->get('/reg/{reg}', fn () => 'x');
Route::where(['id' => '[0-9]+'])->get('/reg-own/{id}', fn () => 'x')->where('id', '[a-z]+');
Route::group(['where' => ['g' => '[0-9]+']], function () {
    Route::get('/g/{g}', fn () => 'x');
});
Route::prefix('gp')->where(['p' => '[0-9]+'])->group(function () {
    Route::get('/g2/{p}', fn () => 'x');
});
Route::fallback(fn () => 'FALLBACK');
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  const w = (uri) => (by.get(uri) || {}).wheres || {};

  assert.deepEqual(w('two-arg/{id}'), { id: '[0-9]+' });
  assert.deepEqual(w('array/{a}/{b}'), { a: '[0-9]+', b: '[a-z]+' });
  // the named helpers are sugar for the FIXED expressions in
  // CreatesRegularExpressionRouteConstraints (copied verbatim)
  assert.deepEqual(w('num/{id}'), { id: '[0-9]+' });
  assert.deepEqual(w('alpha/{id}'), { id: '[a-zA-Z]+' });
  assert.deepEqual(w('alnum/{id}'), { id: '[a-zA-Z0-9]+' });
  assert.deepEqual(w('uuid/{id}'), { id: '[\\da-fA-F]{8}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{12}' });
  assert.deepEqual(w('ulid/{id}'), { id: '[0-7][0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{25}' });
  // whereIn joins with '|' and escapes NOTHING (probed: the dot stays a
  // metacharacter and '/twoxv' matches in Laravel)
  assert.deepEqual(w('in/{slug}'), { slug: 'one|two.v' });
  // a requirement for a variable the uri does not use is stored by PHP and
  // ignored by its compiler; the scan keeps it too
  assert.deepEqual(w('unused/{a}'), { other: '[0-9]+' });
  // `{p*}` is NOT a wildcard in Laravel (Symfony compiles it as literal text),
  // so it is not a requirement either — the edge matches the literal path only
  assert.deepEqual(w('star/{p*}'), {});
  // an expression that is empty (`where('id','')`, `whereIn('id', [])`) is
  // recorded, NOT dropped: Symfony refuses it and the app cannot boot, so the
  // build has to stop on it rather than serve an unconstrained route
  assert.deepEqual(w('empty/{id}'), { id: '' });
  assert.deepEqual(w('emptyin/{id}'), { id: '' });
  // RouteRegistrar attribute (before the verb), array form
  assert.deepEqual(w('reg/{reg}'), { reg: '[a-z]+' });
  // ...and the route's own call AFTER the verb overwrites it per name
  assert.deepEqual(w('reg-own/{id}'), { id: '[a-z]+' });
  // group attributes apply to every route the group registers, in both shapes
  assert.deepEqual(w('g/{g}'), { g: '[0-9]+' });
  assert.deepEqual(w('gp/g2/{p}'), { p: '[0-9]+' });
  // Router::fallback(): Route::fallback() is addRoute('GET','{fallbackPlaceholder}')
  // ->where('fallbackPlaceholder', '.*'), so the catch-all is carried as the real
  // requirement it is
  assert.deepEqual(w('{fallbackPlaceholder}'), { fallbackPlaceholder: '.*' });
});

test('a resource where() map lands on every action, like ResourceRegistrar', () => {
  // `Route::resource(...)->where([...])` stores the map in the OPTIONS
  // (PendingResourceRegistration::where()), and ResourceRegistrar::getResourceAction()
  // copies it into every action — collection routes included, whose uri has no
  // such segment (probed on Laravel 13.37).
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;

Route::resource('photos', 'PhotoController')->where(['photo' => '[0-9]+']);
`
  );
  assert.equal(res.status, 0, res.stderr);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  for (const uri of ['photos', 'photos/create', 'photos/{photo}', 'photos/{photo}/edit']) {
    assert.deepEqual((by.get(uri) || {}).wheres, { photo: '[0-9]+' }, `wheres for ${uri}`);
  }
});

test('a where() before the verb with a string is reported, not silently applied', () => {
  // RouteRegistrar takes a MAP for `where`; `Route::where('id', '[0-9]+')->get(...)`
  // is a boot TypeError in Laravel 13 (RouteGroup::formatWhere -> array_merge).
  // The scan says so instead of pretending that route has a requirement.
  const { res, entries } = runTool(
    {},
    `<?php
use Illuminate\\Support\\Facades\\Route;

Route::where('id', '[0-9]+')->get('/regform/{id}', fn () => 'x');
`
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /BEFORE the verb is not a RouteRegistrar attribute/);
  const by = new Map((entries || []).map((e) => [e.uri, e]));
  assert.equal(by.get('regform/{id}').wheres, undefined);
});
