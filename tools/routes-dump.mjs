#!/usr/bin/env node
// tools/routes-dump.mjs — pure-JS replacement for tools/routes-dump.php
//
// Usage: node tools/routes-dump.mjs
// Output (stdout): the same ENTRIES `php artisan route:list --json` prints.
// No PHP interpreter, no composer install, no vendor download needed.
//
// ORDER differs from route:list on purpose: route:list sorts by uri
// (RouteListCommand::sortRoutes('uri')), while this tool keeps DECLARATION
// order — the compiled router picks the FIRST route whose method + uri match
// (kernel/router.mjs `match()`), exactly like Laravel's registration-order
// precedence, so a uri-sorted table would resolve overlapping routes
// (`/posts/{post}` vs `/posts/archive`) differently from PHP. Verified against
// the oracle: PHP sorts `dashboard, login, photos, posts`, this tool answers
// `posts, login, dashboard, photos`.
//
// Each entry: { domain, method, uri, name, action, middleware, path }
//   - method is `GET|HEAD` for GET routes (route:list adds HEAD)
//   - action is `Closure` (with a `path: routes/<file>:<line>`) or the
//     FQCN Controller@method (resolved through the file's `use` imports)
//   - middleware = base group name (`web`/`api`) + the route's own chain
//     (auth/guest/throttle:...) in declaration order
//
// Groups: Route::prefix(...)/->middleware(...)->group(fn) and the
// `Route::group([...], fn)` form push a context (prefix/name/middleware) that
// nested routes inherit. Route::resource expands to the standard resource
// verbs.
//
// The non-verb helpers register routes too and are mapped to what route:list
// prints: view() -> GET|HEAD + Illuminate\Routing\ViewController,
// redirect()/permanentRedirect() -> Router::$verbs + the RedirectController,
// fallback() -> GET|HEAD on the {fallbackPlaceholder} uri, any() ->
// Router::$verbs (which includes QUERY in Laravel 13), match([...]) -> the
// uppercased list with HEAD appended when GET is present
// (Route::__construct), query() -> QUERY. A helper the scan cannot read is
// reported through `notes` instead of being dropped.

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  appRouteFiles,
  parsePhpFile,
  nodeName,
  callMethodName,
  callArgs,
  argValue,
  isClosureFn,
  closureStatements,
  classFile,
  appPsr4Dirs,
  readEnvFile,
  loadConfig,
  configGet,
  renestMixedChains,
} from './static.mjs';
import { singular as strSingular } from './inflect.mjs';
import { slugifyRoute } from './route-slug.mjs';
import { resolveAppRoot } from './native-path.mjs';

const appDir = resolveAppRoot();

if (!appDir) {
  process.stderr.write('routes-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A string literal (or const-concat) argument value; null otherwise. */
const strArg = (arg) => {
  if (!arg) return null;
  if (arg.kind === 'string') return arg.value;
  if (arg.kind === 'bin' && arg.type === '.') {
    const l = strArg(arg.left);
    const r = strArg(arg.right);
    return l !== null && r !== null ? l + r : null;
  }
  if (arg.kind === 'number') return String(arg.value);
  return null;
};

/** A middleware list from a string or array argument. */
const middlewareList = (arg) => {
  if (!arg) return null;
  if (arg.kind === 'string') return [arg.value];
  if (arg.kind === 'array') {
    const out = [];
    for (const e of (arg.items || [])) {
      if (e && e.kind === 'entry' && e.value) {
        const v = strArg(e.value);
        if (v !== null) out.push(v);
      }
    }
    return out;
  }
  return null;
};

/** The middleware list of a group attribute, or [] when absent/not a list. */
const pickMiddleware = (arg) => middlewareList(arg) || [];

/**
 * Join URI SEGMENTS with '/', trimming the edges - `Router::prefix()`
 * (`trim(trim($prefix,'/').'/'.trim($uri,'/'), '/') ?: '/'`) and
 * `RouteGroup::formatPrefix()` (`trim($old,'/').'/'.trim($new,'/')`) both do
 * exactly this. The scan used plain `+`, so a group/seed/chain prefix landed
 * WITHOUT a separator: `Route::prefix('api')->group(fn => Route::get('users'))`
 * answered `apiusers` where PHP answers `api/users` (probed vs route:list).
 */
const joinUri = (...parts) => {
  const segs = [];
  for (const p of parts) {
    if (p == null) continue;
    const s = String(p).replace(/\\/g, '').replace(/^\/+|\/+$/g, '');
    if (s !== '') segs.push(s);
  }
  return segs.join('/');
};

const normalizeUri = (uri) => {
  const u = joinUri(uri);
  // route:list --json shows "dashboard" not "/dashboard"; root is "/".
  return u === '' ? '/' : u;
};

/** The FQCN for a `Controller::class` / `Controller` action node. */
const fqcnOf = (node, parsed) => {
  let raw = '';
  if (node.kind === 'staticlookup') raw = (node.what && (node.what.name || node.what.raw)) || '';
  else if (node.kind === 'name') raw = node.name || '';
  // A plain STRING controller is a first-class Laravel spelling:
  // `Route::resource('photos', 'App\Http\Controllers\PhotoController')` and
  // `Route::get('/x', 'App\Http\Controllers\X@y')`. Returning null here made the
  // scan drop every resource registered that way ("no resolvable controller"),
  // so the edge 404'd routes PHP serves.
  else if (node.kind === 'string') raw = node.value || '';
  else return null;
  raw = String(raw).replace(/^\\/, '');
  if (!raw) return null;
  if (parsed && parsed.imports && raw in parsed.imports) return parsed.imports[raw].replace(/^\\/, '');
  if (parsed && parsed.namespace && !raw.includes('\\')) return parsed.namespace + '\\' + raw;
  return raw;
};

/**
 * `Router::prependGroupController()` (Router.php:664-684): inside a group that
 * declares `controller`, an action string that is neither already `Class@method`
 * nor a class name of its own becomes `Group\Controller@method`. PHP decides the
 * second case with `class_exists($class)`; a source scan cannot autoload, so a
 * resolved FQCN (it holds a namespace separator) stands in for it - a
 * GLOBAL-namespace controller written as a bare string is the one shape where the
 * two can disagree.
 */
const withGroupController = (action, controller) =>
  action && controller && !action.includes('@') && !action.includes('\\')
    ? controller + '@' + action
    : action;

/**
 * `Router::prependGroupNamespace()` (Router.php:653-661), applied AFTER the group
 * controller: a `uses` string that neither starts with a backslash nor already
 * starts with the group's namespace is prefixed with it. `Router::view()` /
 * `redirect()` register their framework controller with a LEADING BACKSLASH
 * (Router.php:301) - which is exactly what exempts them - so they never pass
 * through here.
 */
const withGroupNamespace = (action, namespace) =>
  action && namespace && !action.startsWith('\\') && !action.startsWith(namespace)
    ? namespace + '\\' + action
    : action;

/** The method sequence of a route chain, OUTER call -> INNER call. */
const chainSteps = (callNode) => {
  const steps = [];
  let cur = callNode;
  const seen = new Set();
  while (cur && cur.kind === 'call' && !seen.has(cur)) {
    seen.add(cur);
    const mm = (cur.what && cur.what.kind === 'propertylookup')
      ? (cur.what.offset && (cur.what.offset.name || cur.what.offset.value))
      : (cur.what && cur.what.kind === 'staticlookup')
        ? (cur.what.offset && (cur.what.offset.name || cur.what.offset.value))
        : null;
    steps.push({ method: mm, node: cur, args: callArgs(cur).map(argValue) });
    cur = cur.what && cur.what.what;
  }
  return steps; // outermost first, innermost last (PHP declaration order)
};

// php-parser's statement kinds for require/include.
const REQUIRE_KINDS = ['require', 'requireonce', 'include', 'includeonce'];

// Things the static walk could not decide, surfaced on stderr by the build:
// loud beats silent — a route table that quietly skips declarations is the bug
// this whole tool exists to avoid.
const notes = [];
const note = (msg) => { if (!notes.includes(msg)) notes.push(msg); };
const relOf = (file) => String(file).replace(/\\/g, '/').replace(String(appDir).replace(/\\/g, '/') + '/', '');

/** Raw source of a node (position-based: robust to AST shape differences). */
const sourceSlice = (parsed, node) => {
  if (!parsed || !parsed.source || !node || !node.loc || !node.loc.start || !node.loc.end) return null;
  const s = node.loc.start.offset;
  const e = node.loc.end.offset;
  if (s == null || e == null) return null;
  return parsed.source.slice(s, e);
};

/** prefix / namePrefix / middleware from the steps of a chain (group excluded). */
const chainAttrs = (steps) => {
  const attrs = { prefix: '', namePrefix: '', middleware: [], domain: null };
  for (const st of steps) {
    if (st.method === 'prefix') { const v = strArg(st.args[0]); if (v != null) attrs.prefix += v; }
    else if (st.method === 'name') { const v = strArg(st.args[0]); if (v != null) attrs.namePrefix = v; }
    else if (st.method === 'domain') { const v = strArg(st.args[0]); if (v != null) attrs.domain = v; }
    else if (st.method === 'middleware') { const m = middlewareList(st.args[0]); if (m && m.length) attrs.middleware = attrs.middleware.concat(m); }
  }
  return attrs;
};

/** A string list out of an array literal node; null otherwise. */
const argStrList = (v) => {
  if (!v || !Array.isArray(v.items)) return null;
  const out = [];
  for (const e of v.items) {
    const item = e && e.kind === 'entry' && e.key == null ? e.value : e;
    const s = item ? strArg(item) : null;
    if (s != null) out.push(s);
  }
  return out.length ? out : null;
};

/** Key of an array entry: php-parser stores `['only' => …]` keys as STRING nodes. */
const entryKey = (e) => {
  if (!e || e.kind !== 'entry' || e.key == null) return null;
  if (e.key.kind === 'string') return e.key.value;
  return nodeName(e.key) || null;
};

/**
 * Merge a route chain's registrar attributes (a call BEFORE the verb, e.g.
 * `Route::prefix('x')->get(...)`) with its route-method attributes (a call
 * AFTER the verb, e.g. `->name('a')->name('b')`). Laravel splits them exactly
 * this way: `RouteRegistrar::attribute()` is LAST-WRITE-WINS per key, while
 * `Route::name()`/`Route::middleware()` APPEND. Walking the outermost-first
 * `steps` in reverse yields source order, which is what decides both. Verified
 * against `route:list --json` for prefix/domain/name/middleware chains.
 */
const mergeRouteAttrs = (steps, verbIdx) => {
  const out = {
    prefix: '',
    name: '',
    domain: null,
    middlewareReg: [],
    excludedReg: [],
    names: [],
    middlewareRoute: [],
    excludedRoute: [],
  };
  for (let i = steps.length - 1; i >= 0; i--) {
    if (i === verbIdx) continue;
    const st = steps[i];
    const sm = st.method == null ? '' : String(st.method).toLowerCase();
    // `steps` is OUTERMOST-first (innermost last), and the verb is the inner
    // call the registrar hangs off. So a step with `i < verbIdx` is a call
    // AFTER the verb in source order -> Route-method semantics; `i > verbIdx`
    // is a call BEFORE it -> RouteRegistrar (last-write-wins) semantics.
    const afterVerb = i < verbIdx;
    if (sm === 'prefix') { const v = strArg(st.args[0]); if (v != null) out.prefix = v; }
    else if (sm === 'domain') { const v = strArg(st.args[0]); if (v != null) out.domain = v; }
    else if (sm === 'name' || sm === 'as') {
      const v = strArg(st.args[0]);
      if (v != null) { if (afterVerb) out.names.push(v); else out.name = v; }
    } else if (sm === 'middleware') {
      const l = middlewareList(st.args[0]);
      if (l && l.length) { if (afterVerb) out.middlewareRoute.push(...l); else out.middlewareReg = l.slice(); }
    } else if (sm === 'withoutmiddleware') {
      // `->withoutMiddleware('auth')` SUBTRACTS the named middleware from the
      // route's gathered list (Router::resolveMiddleware() rejects by name).
      const l = middlewareList(st.args[0]);
      if (l && l.length) { if (afterVerb) out.excludedRoute.push(...l); else out.excludedReg = l.slice(); }
    }
  }
  return out;
};

/** The callee of a call node: `base_path` / `Route::get` / `$x->y`. */
const calleeName = (node) => {
  const w = node && node.what;
  if (!w) return null;
  if (w.kind === 'name') return w.name || w.value || null;
  if (w.kind === 'staticlookup' || w.kind === 'propertylookup') return w.offset && (w.offset.name || w.offset.value) || null;
  return null;
};

/** Resolve `->group(base_path('routes/x.php'))` / `__DIR__.'/x.php'` to a file. */
const resolveRouteFile = (args, fromFile, parsed) => {
  const a0 = args && args[0];
  if (!a0) return null;
  if (a0.kind === 'call') {
    const callee = calleeName(a0);
    if (callee === 'base_path' || callee === 'app_path' || callee === 'resource_path') {
      const rel = strArg(callArgs(a0)[0]);
      if (rel) { const p = join(appDir, rel); return existsSync(p) ? p : null; }
    }
    return null;
  }
  if (a0.kind === 'string' && /\.php$/.test(a0.value)) {
    const p = a0.value.includes('/') && !/^[a-zA-Z]:/.test(a0.value)
      ? (a0.value.startsWith('routes/') ? join(appDir, a0.value) : join(dirname(fromFile), a0.value))
      : join(dirname(fromFile), a0.value);
    return existsSync(p) ? p : null;
  }
  const raw = sourceSlice(parsed, a0);
  if (raw) {
    const mBase = raw.match(/base_path\(\s*(['"])(.+?)\1\s*\)/);
    if (mBase) { const p = join(appDir, mBase[2]); return existsSync(p) ? p : null; }
    const mDir = raw.match(/__DIR__\s*\.\s*(['"])(.+?)\1/);
    if (mDir) { const p = join(dirname(fromFile), mDir[2]); return existsSync(p) ? p : null; }
  }
  return null;
};

// ---------------------------------------------------------------------------
// the route table
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'head', 'query'];

// The four `Router` helpers that register a route WITHOUT a plain verb:
// Route::view/permanentRedirect are spelled in camelCase in Laravel, so the
// lookup lowercases the step name (PHP method names are case-insensitive).
// Missing them would drop the route from the table SILENTLY — the failure the
// whole tool exists to avoid (Router.php: view() -> match(['GET','HEAD'],
// ViewController); redirect() -> any(); permanentRedirect() -> redirect(301);
// fallback() -> addRoute('GET', '{fallbackPlaceholder}')->where('.*')).
const ROUTE_HELPERS = ['view', 'redirect', 'permanentredirect', 'fallback'];
/** Plural batch helpers: `Router::resources()`/`apiResources()`/
 *  `softDeletableResources()` loop the map and register one resource per entry
 *  (`Router.php`). `softDeletableResources()` is the same route set as
 *  `resources()` — `->withTrashed()` only relaxes binding, it adds NO route
 *  (ResourceRegistrar::register() :127). */
const BATCH_RESOURCE_HELPERS = ['resources', 'apiresources', 'softdeletableresources'];
/** Route helpers this static scan cannot expand yet. Their routes would simply
 *  be absent from the table (the edge 404s what PHP answers), so the scan
 *  REPORTS them and the build refuses instead of serving a silent 404. */
const UNSUPPORTED_ROUTE_HELPERS = ['singleton', 'apisingleton', 'singletons', 'apisingletons'];
/** Is this chain step a route registration (verb, resource, batch resource, or helper)? */
const isVerbStep = (m) => m === 'resource' || m === 'apiResource'
  || (m != null && (HTTP_METHODS.includes(String(m).toLowerCase())
    || ROUTE_HELPERS.includes(String(m).toLowerCase())
    || BATCH_RESOURCE_HELPERS.includes(String(m).toLowerCase())));

/** `Router::$verbs` (Router.php:136, Laravel 13) — what `any()`/`redirect()` register. */
const ANY_METHODS = 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|QUERY';

/**
 * `Router::match($methods, $uri, $action)`: `array_map(strtoupper, (array) $methods)`,
 * and `Route::__construct` (Route.php:184-186) appends HEAD when GET is present
 * and HEAD is not — so `match(['get','post'])` answers `GET|POST|HEAD`, exactly
 * what route:list prints.
 */
const matchVerbList = (arg) => {
  const raw = argStrList(arg) || (strArg(arg) != null ? [strArg(arg)] : null);
  if (!raw || !raw.length) return null;
  const methods = raw.map((m) => String(m).toUpperCase());
  if (methods.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
  return methods;
};

/** Top-level statements (peel a namespace wrapper if present). */
function topStatements(ast) {
  if (!ast) return [];
  for (const c of (ast.children || [])) {
    if (c && c.kind === 'namespace') return c.children || [];
  }
  return ast.children || [];
}

function parse() {
  const routes = [];
  const errors = [];

  // Which files declare routes, and under which group context?
  //   1. bootstrap/app.php `withRouting()` (Laravel 11+)
  //   2. provider calls: Route::middleware('web')->group(base_path('routes/x.php'))
  //      — the shape an app upgraded from 9/10 still has, and the ONLY way to
  //      learn its `prefix('api')` (the provider wraps api.php, not the file)
  //   3. the conventional routes/web.php + routes/api.php, but only for files
  //      nothing above claimed — otherwise their group/prefix would be invented
  // `require __DIR__.'/x.php'` inside a route file is followed while walking.
  const rf = appRouteFiles(appDir);
  const files = [];
  const groupForFile = {};
  const seedFor = {}; // file -> { prefix, namePrefix, middleware } pushed while walking
  const seenFiles = new Set();
  const addFile = (file, group, seed) => {
    if (!file || seenFiles.has(file)) return;
    seenFiles.add(file);
    files.push(file);
    if (group) groupForFile[file] = group;
    if (seed && (seed.prefix || seed.namePrefix || seed.middleware.length)) seedFor[file] = seed;
  };
  if (rf && rf.web) addFile(rf.web, 'web');
  if (rf && rf.api) addFile(rf.api, 'api');
  // `withRouting(health: '/up')` (the Laravel 11+ skeleton default) registers a
  // GET route from ApplicationBuilder::withRouting() - a FRAMEWORK closure, not
  // an app route file, so no file scan can reach it. route:list prints it
  // (`up`, GET|HEAD); the edge does not serve it. Say so instead of dropping it
  // silently: a health check that answers 404 on the edge while PHP answers 200
  // is exactly the silent divergence this scan exists to prevent.
  if (rf && typeof rf.health === 'string' && rf.health.trim() !== '') {
    note(
      'the app declares a health route (`health: ' + JSON.stringify(rf.health) + '` in bootstrap/app.php) — ' +
        'the framework registers it (ApplicationBuilder::withRouting), so no route file declares it and the edge does not serve it: ' +
        'GET ' + rf.health + ' answers 404 where PHP answers 200. Declare the route in routes/ (or a port) if the edge needs it.'
    );
  }

  const providerDirs = appPsr4Dirs(appDir).map((srcDir) => join(srcDir, 'Providers'));
  for (const providersDir of providerDirs) {
    if (!existsSync(providersDir)) continue;
    for (const f of readdirSync(providersDir)) {
      if (!f.endsWith('.php')) continue;
      const pFile = join(providersDir, f);
      const pParsed = parsePhpFile(pFile);
      if (pParsed.error) continue;
      let ast = null;
      try { ast = phpParse(pParsed.source); } catch { continue; }
      (function walkProvider(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walkProvider); return; }
        if (node.kind === 'call') {
          const steps = chainSteps(node);
          // `Route::prefix('api')->middleware('api')->group(base_path(...))`:
          // group is the OUTERMOST step (steps[0]) and carries the file path.
          if (steps.length && steps[0].method === 'group') {
            const target = resolveRouteFile(steps[0].args, pFile, pParsed);
            if (target) {
              const attrs = chainAttrs(steps.slice(1)); // drop the group step itself
              const mw = attrs.middleware.length ? attrs.middleware : ['web'];
              addFile(target, mw[0], { prefix: attrs.prefix, namePrefix: attrs.namePrefix, middleware: mw.slice(1) });
            }
          }
        }
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'comments' || k === 'leadingComments' || k === 'trailingComments' || k === 'parent') continue;
          walkProvider(node[k]);
        }
      })(ast);
    }
  }

  for (const [convName, group] of [['web.php', 'web'], ['api.php', 'api']]) {
    const conv = join(appDir, 'routes', convName);
    if (existsSync(conv)) addFile(conv, group);
  }

  // Scope disclosure (one line per build): a source scan cannot see routes that
  // vendor packages register from their own service providers. Saying so beats a
  // route table that silently lacks sanctum/livewire/filament endpoints.
  note(
    `route scan = ${files.length} app route file(s): ${files.map((f) => relOf(f)).join(', ')}; ` +
      'routes registered by PACKAGE providers in vendor/ (sanctum, livewire, ignition, …) are outside any source scan — ' +
      'declare the ones the edge must serve in registry.json (static/ports/ignore)'
  );

  const groupStack = []; // { prefix, namePrefix, middleware[], group, domain, excluded[], controller, namespace }
  const now = () => {
    const prefixes = [];
    const cur = { prefix: '', namePrefix: '', middleware: [], group: null, domain: null, excluded: [], controller: null, namespace: null };
    for (const g of groupStack) {
      if (g.prefix) prefixes.push(g.prefix);
      cur.namePrefix += g.namePrefix || '';
      cur.middleware = cur.middleware.concat(g.middleware || []);
      cur.excluded = cur.excluded.concat(g.excluded || []);
      if (g.domain) cur.domain = g.domain; // the innermost non-empty domain wins
      if (!cur.group && g.group) cur.group = g.group;
      // `Router::prependGroupController()` reads the LAST group on the stack, and
      // `RouteGroup::merge()` (:23-25) UNSETS the outer 'controller' the moment an
      // inner group declares one - so the innermost declaration wins and an inner
      // group that declares none inherits the outer's.
      if (g.controller) cur.controller = g.controller;
      // Namespaces are NOT last-write-wins: `RouteGroup::formatNamespace()`
      // (:105-114) CONCATENATES an inner namespace onto the outer one, and a
      // leading backslash makes the inner one absolute (`\App\X` replaces).
      if (g.namespace) {
        const raw = String(g.namespace);
        const part = raw.replace(/^\\+/, '').replace(/\\+$/, '');
        cur.namespace = /^\\/.test(raw) || !cur.namespace ? part : cur.namespace + '\\' + part;
      }
    }
    // Nested prefixes JOIN with '/' (`RouteGroup::formatPrefix`): `prefix('a')`
    // inside `prefix('b')` answers `b/a`, not `ba`.
    cur.prefix = joinUri(...prefixes);
    return cur;
  };

  // The middleware a route inherits from its group/enclosing groups.
  const baseGroupFor = (file) => (groupForFile[file] === 'api' ? 'api' : 'web');

  const walkStatements = (stmts, file) => {
    for (const stmt of (stmts || [])) {
      if (!stmt || typeof stmt !== 'object') continue;
      const node = stmt.kind === 'expressionstatement' ? stmt.expression : stmt;
      if (!node || typeof node !== 'object') continue;
      if (node.kind === 'if') { walkIf(node, file); continue; }
      if (REQUIRE_KINDS.includes(node.kind)) { followRequire(node, file); continue; }
      walkNode(node, file);
    }
  };

  const walkNode = (node, file) => {
    if (!node || typeof node !== 'object') return;
    // A call node: this may be the outermost of a chain (Route::get(...)
    // ->name(...) ->middleware(...)). The modifiers are OUTER calls; the
    // verb is the INNERMOST. Groups are OUTERMOST (Route::prefix(...)
    // ->group(...) has steps=[group, prefix]).
    const method = callMethodName(node);
    if (method) {
      const steps = chainSteps(node);
      if (!steps.length) { /* not a chain — fall through */ }
      else if (steps[0].method === 'group') {
        registerGroup(steps, file);
        return;
      } else {
        // Laravel accepts the verb at EITHER end: Route::get(...)->name(...)
        // (verb innermost) and Route::middleware(...)->get(...) (verb
        // OUTERMOST) both register a route, as does any mix in between.
        // Find the innermost verb, fall back outward; every other step is a
        // modifier. resource/apiResource register too — expanded in registerVerb.
        let verbIdx = -1;
        for (let i = steps.length - 1; i >= 0; i--) {
          const m = steps[i].method;
          if (isVerbStep(m)) { verbIdx = i; break; }
        }
        if (verbIdx !== -1) { registerVerb(steps, verbIdx, file); return; }
        // A `Route::singleton()`/`apiSingleton()` chain: a recognized Router
        // helper this scan cannot expand. Refuse instead of returning nothing
        // (which would leave the routes missing from the table — the edge 404s
        // what PHP answers, with no signal anywhere).
        const unsupported = steps.find(
          (s) => s.method != null && UNSUPPORTED_ROUTE_HELPERS.includes(String(s.method).toLowerCase())
        );
        if (unsupported) {
          errors.push(
            `Route::${unsupported.method}() at ${relOf(file)} is not expanded by the static scanner ` +
              '— its routes would be missing from the table (the edge would 404 what PHP answers); ' +
              'declare those routes explicitly or add them to registry.json'
          );
          return;
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw' || k === 'parent') continue;
      walkNode(node[k], file);
    }
  };

  const collectModifiers = (steps, verbIdx) => {
    const modifiers = {};
    for (const st of steps.filter((_, i) => i !== verbIdx)) {
      // PHP method names are case-insensitive (`->Name('x')` IS `->name('x')`),
      // so every comparison lowercases - the verb dispatch (`vmName`) and
      // `mergeRouteAttrs` already do. Raw-case compares here silently dropped a
      // non-canonical `->Middleware('auth')` (the guard was then NOT applied) or
      // `->Name('x')` (the route name vanished).
      const sm = String(st.method == null ? '' : st.method).toLowerCase();
      if (sm === 'name') { const n = strArg(st.args[0]); if (n != null) modifiers.name = n; }
      if (sm === 'middleware') { const m = middlewareList(st.args[0]); if (m && m.length) modifiers.middleware = m; }
      if (sm === 'can') modifiers.can = true;
      if (sm === 'where') modifiers.where = true;
      // Resource shape comes in two forms: `->only([...])` (a chain step) and
      // `Route::resource(..., ['only'=>...])` (the options argument) — both count.
      if (sm === 'only') { const l = argStrList(st.args[0]); if (l) modifiers.only = l; }
      if (sm === 'except') { const l = argStrList(st.args[0]); if (l) modifiers.except = l; }
      if (sm === 'names' && st.args[0]) modifiers.names = st.args[0];
      if (sm === 'parameters' && st.args[0]) modifiers.parameters = st.args[0];
      // Per-method middleware (`->middlewareFor('show', 'auth')` /
      // `->withoutMiddlewareFor(...)`) is not modelled -> flagged so
      // registerResource can refuse instead of serving the method unguarded.
      if (sm === 'middlewarefor' || sm === 'withoutmiddlewarefor') modifiers.middlewareFor = true;
      // `RouteRegistrar::resource()` (RouteRegistrar.php:173) passes the
      // registrar attributes as $options, and `ResourceRegistrar` reads NO
      // 'prefix'/'domain' from $options — so a chain-form `Route::prefix('v2')`
      // or `Route::domain('d')` before `->resource()` is DROPPED by PHP itself
      // (probed: `Route::domain('d')->resource('rr', C)` answers `rr` with an
      // empty domain). The scanner must mirror that, not invent a prefix.
      // `as` IS read (`getResourceRouteName()` prefixes the name), so it stays.
      // A chain-form `->name()` after the verb is appended by getResourceRouteName()
      // through `$options['as']` (see registerResource).
      if (sm === 'name' || sm === 'as') {
        const v = strArg(st.args[0]);
        if (v != null) modifiers.as = (modifiers.as || '') + v;
      }
      if (sm === 'withoutmiddleware') {
        const l = middlewareList(st.args[0]);
        if (l && l.length) modifiers.excluded = (modifiers.excluded || []).concat(l);
      }
    }
    return modifiers;
  };

  const registerVerb = (steps, verbIdx, file) => {
    // The verb step holds the uri + action; every OTHER step is a modifier
    // (name/middleware/can/where), whichever end of the chain it sits at.
    const verbStep = steps[verbIdx];
    const verbMethod = verbStep.method;
    // PHP method names are case-insensitive, so `Route::ApiResource(...)` is
    // valid; compare lowercased to dispatch the same way.
    const vmName = String(verbMethod).toLowerCase();
    if (vmName === 'resource') {
      registerResource(verbStep, collectModifiers(steps, verbIdx), file);
      return;
    }
    if (vmName === 'apiresource') {
      registerResource(
        { ...verbStep, method: 'apiResource' },
        collectModifiers(steps, verbIdx),
        file
      );
      return;
    }
    if (vmName === 'resources' || vmName === 'apiresources' || vmName === 'softdeletableresources') {
      registerResources(
        { ...verbStep, method: vmName === 'apiresources' ? 'apiResources' : vmName === 'softdeletableresources' ? 'softDeletableResources' : 'resources' },
        collectModifiers(steps, verbIdx),
        file
      );
      return;
    }
    const vm = String(verbMethod).toLowerCase();
    // Argument order differs per helper: fallback(action) carries no uri, and
    // match($methods, $uri, $action) puts the verb list first.
    const isFallback = vm === 'fallback';
    const isMatch = vm === 'match';
    const uri0 = isFallback ? '{fallbackPlaceholder}' : strArg(verbStep.args[isMatch ? 1 : 0]);
    const actionArg = (isFallback ? verbStep.args[0] : verbStep.args[isMatch ? 2 : 1]) || null;
    const method = verbMethod;

    // A route chain carries attributes in TWO positions (Laravel's
    // RouteRegistrar): a call BEFORE the verb is a REGISTRAR attribute
    // (`Route::prefix('x')`, last write wins), a call AFTER the verb is a ROUTE
    // method (`->name('a')->name('b')` APPENDS, `->middleware()` appends).
    // mergeRouteAttrs reproduces both; the scan previously dropped them, so the
    // edge served a URI without its prefix, with no host restriction, and
    // WITHOUT a middleware the app expects (an auth/throttle guard).
    const attrs = mergeRouteAttrs(steps, verbIdx);
    const chainName = attrs.name + attrs.names.join('');

    const g = now();
    const group = g.group || baseGroupFor(file);
    const excluded = attrs.excludedReg.concat(attrs.excludedRoute, g.excluded);
    const uri = normalizeUri(joinUri(g.prefix, attrs.prefix, uri0 || '{any}'));
    // With no `->name()`, a route inside a NAME-PREFIXED group still carries the
    // group's prefix as its name: `Route::group(['as'=>'g2.'], fn => Route::get('y2'))`
    // answers `g2.` (RouteGroup::formatAs keeps the old `as` when the new has
    // none), and route:list prints it.
    const name = chainName || g.namePrefix ? g.namePrefix + chainName : null;
    const middleware = [group]
      .concat(g.middleware, attrs.middlewareReg, attrs.middlewareRoute)
      .filter((m) => !excluded.includes(String(m)));
    const domain = attrs.domain || g.domain || null;

    let action = 'Closure';
    let path = null;
    // A non-Closure action the ROUTE FILE declares is a controller action as far
    // as the Router is concerned (`Router::actionReferencesController()`), and
    // that is what makes the two group attributes apply - controller first, then
    // namespace (`Router::convertToControllerAction()`, Router.php:621-641).
    let fromRouteFile = false;
    // Route::view($uri, $view, ...) / Route::redirect($uri, $dest, ...) register
    // a framework controller — NOT the app action the generic branch below would
    // read out of argument #1 (that one is the view NAME / the destination).
    if (vm === 'view') action = 'Illuminate\\Routing\\ViewController';
    else if (vm === 'redirect' || vm === 'permanentredirect') action = 'Illuminate\\Routing\\RedirectController';
    else if (actionArg) {
      if (isClosureFn(actionArg)) {
        const line = verbStep.node.loc && verbStep.node.loc.start ? verbStep.node.loc.start.line : null;
        const rel = file.replace(/\\/g, '/').replace(appDir.replace(/\\/g, '/') + '/', '');
        path = line ? rel + ':' + line : null;
      } else if (actionArg.kind === 'array') {
        fromRouteFile = true;
        const items = (actionArg.items || []).filter((i) => i && i.kind === 'entry');
        if (items.length >= 2) {
          const cls = fqcnOf(items[0].value, parsedOf(file));
          const m = strArg(items[1].value);
          if (cls && m) action = cls + '@' + m;
        } else if (items.length === 1) {
          const cls = fqcnOf(items[0].value, parsedOf(file));
          if (cls) action = cls;
        }
      } else if (actionArg.kind === 'string') {
        // 'Controller@method' route action - or a BARE method name resolved
        // against the enclosing controller group (`Route::controller(X)->group`).
        fromRouteFile = true;
        action = actionArg.value;
      } else if (actionArg.kind === 'staticlookup' && actionArg.offset && actionArg.offset.name === 'class') {
        // An INVOKABLE controller: `Route::get('/x', XController::class)` — the
        // class itself is the action and Laravel runs `__invoke()`
        // (`Router::actionReferencesController()` accepts the class-constant
        // form). The scan read it as no action at all, so the route fell through
        // as a "Closure defined outside routes/" and the edge answered 404 for a
        // page PHP serves.
        const cls = fqcnOf(actionArg, parsedOf(file));
        if (cls) {
          fromRouteFile = true;
          action = cls + '@__invoke';
        }
      }
    }
    if (fromRouteFile) {
      action = withGroupController(action, g.controller);
      action = withGroupNamespace(action, g.namespace);
    }

    // Controller-level `$this->middleware('auth', ['except'=>...])` never appears
    // in the route file — without it the edge would run publish WITHOUT auth.
    if (action.includes('@')) {
      const at = action.indexOf('@');
      const extra = controllerMiddlewareFor(action.slice(0, at), action.slice(at + 1), file);
      if (extra && extra.length) middleware.push(...extra);
    }

    // The method string is what `route:list --json` prints for the route
    // (`implode('|', $route->methods())`), so it must be the REAL verb list:
    // `any()`/`redirect()` answer Router::$verbs, `match([...])` answers the
    // array it was given, `view()`/`fallback()`/`get()` add HEAD.
    const matchVerbs = vm === 'match' ? matchVerbList(verbStep.args[0]) : null;
    if (vm === 'match' && !matchVerbs) note('Route::match() with a verb list this scan cannot read (' + relOf(file) + ') — its methods are reported as MATCH; add it to registry.json if the edge must serve it');
    const methodOut =
      vm === 'get' || vm === 'view' || vm === 'fallback' ? 'GET|HEAD' :
      vm === 'head' ? 'HEAD' :
      vm === 'any' || vm === 'redirect' || vm === 'permanentredirect' ? ANY_METHODS :
      vm === 'match' ? (matchVerbs ? matchVerbs.join('|') : 'MATCH') :
      String(method).toUpperCase();

    routes.push({
      domain,
      method: methodOut,
      uri,
      name,
      action,
      middleware,
      path,
    });
  };

  const parsedCache = new Map();
  const parsedOf = (file) => {
    if (!parsedCache.has(file)) parsedCache.set(file, parsePhpFile(file));
    return parsedCache.get(file);
  };

  const registerGroup = (steps, file) => {
    // Two shapes:
    //  A) Route::prefix('x')->middleware([...])->group(fn)   steps=[group, prefix, ...]
    //  B) Route::group(['prefix' => 'x', 'middleware' => [...]], fn)
    const groupStep = steps[0];
    // A group callback may be a closure OR an arrow function: an arrow-function
    // group the scan does not recognise drops EVERY route inside it, with no
    // note (measured on Laravel 13.37: `Route::prefix('g')->group(fn () =>
    // Route::get('/x', ...))` vanished from the dump entirely).
    const closureArg = groupStep.args.map(argValue).find(isClosureFn);
    if (!closureArg) return;

    // `Route::prefix('x')->middleware([...])->group(fn)` builds a
    // `RouteRegistrar` FIRST and throws on a second set of one
    // (RouteRegistrar::__call -> attribute() -> RuntimeException("... tried to
    // set ... a second time")), so the attribute BEFORE the verb/group is
    // LAST-WRITE-WINS, not additive (probes: `prefix('a')->prefix('b')` mounts
    // `b/`, `name('n1.')->name('n2.')` names the child `n2.`, `as()` is the
    // SAME attribute as `name`). `middleware` REPLACES too (`middleware('m1')
    // ->middleware('m2')` answers `[web, m2]`), but `withoutMiddleware` is a
    // real Router method whose `->middleware()` APPENDS, so it accumulates.
    // A PHP literal array keeps only the LAST duplicate key.
    const attrs = { prefix: '', namePrefix: '', middleware: [], domain: null, excluded: [], controller: null, namespace: null };
    const chainLast = (method) => {
      // `steps` is OUTERMOST-first = REVERSE execution order (index 0 is the
      // LAST call in source, `Route::prefix('a')->prefix('b')->group()` parses
      // as steps `[group, prefix-b, prefix-a]`). The registrar write that WINS
      // is the LAST one in SOURCE = the FIRST array index, so take the first
      // matching step, not the last.
      let found = null;
      for (const st of steps) {
        if (String(st.method == null ? '' : st.method).toLowerCase() === method) { found = st; break; }
      }
      return found;
    };
    const prefStep = chainLast('prefix');
    if (prefStep) { const v = strArg(prefStep.args[0]); if (v != null) attrs.prefix = v; }
    // `as()` and `name()` are the SAME registrar attribute (`name => 'as'`), so
    // a chain may not mix the spellings; take the one that appears.
    const nameStep = chainLast('name') || chainLast('as');
    if (nameStep) { const v = strArg(nameStep.args[0]); if (v != null) attrs.namePrefix = v; }
    const domainStep = chainLast('domain');
    if (domainStep) { const v = strArg(domainStep.args[0]); if (v != null) attrs.domain = v; }
    const mwStep = chainLast('middleware');
    if (mwStep) { const m = middlewareList(mwStep.args[0]); if (m) attrs.middleware = m.slice(); }
    // `Route::controller(X::class)->group(fn () => Route::get('/x', 'index'))`:
    // Router::prependGroupController() (Router.php:664-684) turns the bare method
    // name into `X@index` when the route is registered. Without this, the dump
    // answered `action: "index"`, the build tried to resolve a CLASS named
    // `index` ("cannot resolve index via composer autoload") and a --strict build
    // refused the app - a route shape Laravel 11+ apps use as a matter of course.
    const ctlStep = chainLast('controller');
    if (ctlStep) {
      const c = fqcnOf(ctlStep.args[0], parsedOf(file));
      if (c) attrs.controller = c;
    }
    // `Route::namespace('App\Http\Controllers')->group(fn)` (the Laravel 5/6
    // spelling, still honoured by Router::prependGroupNamespace()) - a registrar
    // attribute, so it is last-write-wins like `prefix`, and the merge across
    // NESTED groups is handled in now().
    const nsStep = chainLast('namespace');
    if (nsStep) {
      const v = strArg(nsStep.args[0]) ?? fqcnOf(nsStep.args[0], parsedOf(file));
      if (v != null) attrs.namespace = v;
    }
    for (const st of steps) {
      if (String(st.method == null ? '' : st.method).toLowerCase() !== 'withoutmiddleware') continue;
      const m = middlewareList(st.args[0]);
      if (m) attrs.excluded = attrs.excluded.concat(m);
    }
    // From the attributes array: Route::group(['prefix'=>..., 'name'=>...], fn)
    const attrArray = groupStep.args.find((a) => a && a.kind === 'array');
    if (attrArray) {
      // A repeated literal key keeps the LAST value (a probe: `['prefix'=>'p1',
      // 'prefix'=>'p2']` mounts `p2/`), so assign into a raw scratch map and
      // read the typed fields back out once the array is consumed.
      const raw = Object.create(null);
      for (const e of (attrArray.items || [])) {
        if (!e || e.kind !== 'entry') continue;
        const key = entryKey(e);
        if (!key) continue;
        raw[key] = e.value;
      }
      if (raw.prefix !== undefined) attrs.prefix = strArg(raw.prefix) || '';
      const asName = raw.name !== undefined ? raw.name : raw.as;
      if (asName !== undefined) attrs.namePrefix = strArg(asName) || '';
      if (raw.domain !== undefined) attrs.domain = strArg(raw.domain) ?? null;
      if (raw.controller !== undefined) attrs.controller = fqcnOf(raw.controller, parsedOf(file));
      if (raw.namespace !== undefined) attrs.namespace = strArg(raw.namespace) ?? fqcnOf(raw.namespace, parsedOf(file));
      if (raw.middleware !== undefined) attrs.middleware = pickMiddleware(raw.middleware);
      const exAttr = pickMiddleware(raw.withoutMiddleware)
        .concat(pickMiddleware(raw.without_middleware))
        .concat(pickMiddleware(raw.excluded_middleware));
      if (exAttr.length) attrs.excluded = attrs.excluded.concat(exAttr);
    }
    groupStack.push(attrs);
    walkStatements(closureStatements(closureArg), file);
    groupStack.pop();
  };

  // ---- conditionals: only emit routes the app would really register ---------
  // `if (config('x'))` / `if (env('X'))` are decided with the SAME static
  // config/env the rest of the build uses. Anything else is UNKNOWN: both
  // branches walk (over-approximate) and a note names the spot.
  let _cfg = null;
  let _env = null;
  const phpTruthy = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (typeof v === 'string') return v !== '' && v !== '0';
    return null; // arrays/objects: PHP says non-empty array is truthy — unknown beats guessing
  };
  const condValue = (test, parsed) => {
    if (!test) return null;
    if (test.kind === 'boolean') return !!test.value;
    const raw = sourceSlice(parsed, test);
    if (!raw) return null;
    const negated = /^\s*!/.test(raw);
    const expr = raw.replace(/^\s*!\s*/, '').trim();
    const wrap = (v) => (v === null ? null : negated ? !v : v);
    let m = expr.match(/^config\(\s*(['"])(.+?)\1\s*\)$/);
    if (m) {
      if (_cfg === null) _cfg = loadConfig(appDir, _env || (_env = readEnvFile(appDir, process.env))).config;
      return wrap(phpTruthy(configGet(_cfg, m[2])));
    }
    m = expr.match(/^env\(\s*(['"])(.+?)\1(?:\s*,\s*[^)]*)?\)$/);
    if (m) {
      if (_env === null) _env = readEnvFile(appDir, process.env);
      const v = Object.prototype.hasOwnProperty.call(process.env, m[2]) ? process.env[m[2]] : _env[m[2]];
      return wrap(phpTruthy(v));
    }
    if (/^true$/i.test(expr)) return wrap(true);
    if (/^false$/i.test(expr)) return wrap(false);
    if (expr === 'null') return wrap(false);
    return null;
  };

  const walkIf = (node, file) => {
    const parsed = parsedOf(file);
    const test = node.test || node.cond;
    const v = condValue(test, parsed);
    const asStmts = (b) => (Array.isArray(b) ? b : b && b.children ? b.children : b ? [b] : []);
    if (v === false) { walkStatements(asStmts(node.alternate), file); return; }
    if (v === true) { walkStatements(asStmts(node.body), file); return; }
    const loc = test && test.loc && test.loc.start ? `:${test.loc.start.line}` : '';
    note(`conditional at ${relOf(file)}${loc} cannot be decided statically — both branches walked; verify it does not gate a runtime-only route`);
    walkStatements(asStmts(node.body), file);
    walkStatements(asStmts(node.alternate), file);
  };

  // ---- require: route files include each other ------------------------------
  const visitedRequire = new Set();
  const followRequire = (node, file) => {
    const parsed = parsedOf(file);
    const expr = node.expression || node.left || node.expr || node;
    const target = resolveRouteFile([expr], file, parsed);
    if (!target) {
      const raw = sourceSlice(parsed, expr) || '?';
      note(`dynamic require at ${relOf(file)} not followed (${raw.trim().slice(0, 60)}) — routes declared there are NOT in the table`);
      return;
    }
    if (visitedRequire.has(target)) return;
    visitedRequire.add(target);
    groupForFile[target] = groupForFile[file] || 'web';
    if (seedFor[file]) seedFor[target] = seedFor[file];
    const tp = parsePhpFile(target);
    if (tp.error) { errors.push(tp.error); return; }
    let tAst = null;
    try { tAst = phpParse(tp.source); } catch (e) { errors.push(`${relOf(target)}: ${e.message}`); return; }
    // The parent's group/seed is already on groupStack — walk the child in place.
    walkStatements(topStatements(tAst), target);
  };

  // ---- controller-level middleware ------------------------------------------
  // `$this->middleware('auth', ['except'=>…])` lives in the CONTROLLER, never in
  // the route file. Skipping it would ship `publish` WITHOUT auth at the edge.
  const controllerMwCache = new Map(); // fqcn -> [{ mw[], only, except }|null]
  const controllerMwEntries = (fqcn) => {
    if (controllerMwCache.has(fqcn)) return controllerMwCache.get(fqcn);
    const entries = [];
    const visited = new Set();
    let cls = fqcn;
    for (let depth = 0; depth < 6 && cls && !visited.has(cls); depth++) {
      visited.add(cls);
      const f = classFile(appDir, cls);
      if (!f) break; // vendor base class (Illuminate\Routing\Controller) — carries none
      const p = parsePhpFile(f);
      if (p.error) break;
      if (/\bHasMiddleware\b/.test(p.source)) {
        note(`controller ${cls} declares middleware through HasMiddleware — the static walk does not read it; declare the route middleware in routes/ if it must run`);
      }
      entries.unshift(...extractCtorMiddleware(p, cls));
      // parent class
      let ast = null;
      try { ast = phpParse(p.source); } catch { break; }
      const cn = findClassNode(ast, cls);
      const ext = cn && cn.extends && (cn.extends.name || (cn.extends.offset && cn.extends.offset.name));
      if (!ext) break;
      const parentRaw = String(ext).replace(/^\\/, '');
      cls = p.imports && p.imports[parentRaw] ? String(p.imports[parentRaw]).replace(/^\\/, '')
        : !parentRaw.includes('\\') && p.namespace ? `${p.namespace}\\${parentRaw}` : parentRaw;
    }
    controllerMwCache.set(fqcn, entries);
    return entries;
  };
  const controllerMiddlewareFor = (fqcn, actionMethod) => {
    const out = [];
    for (const e of controllerMwEntries(fqcn)) {
      if (e.only && !e.only.includes(actionMethod)) continue;
      if (e.except && e.except.includes(actionMethod)) continue;
      out.push(...e.mw);
    }
    return out;
  };

  const findClassNode = (ast, fqcn) => {
    const short = fqcn.split('\\').pop();
    let found = null;
    const walk = (n) => {
      if (!n || typeof n !== 'object' || found) return;
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (n.kind === 'class' && n.name && (n.name.name || n.name.value) === short) { found = n; return; }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'parent' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments') continue;
        walk(n[k]);
      }
    };
    walk(ast);
    return found;
  };

  const extractCtorMiddleware = (parsed, fqcn) => {
    let ast = null;
    try { ast = phpParse(parsed.source); } catch { return []; }
    const cn = findClassNode(ast, fqcn);
    if (!cn || !Array.isArray(cn.body)) return [];
    const ctor = cn.body.find(
      (s) => s && (s.kind === 'method' || s.kind === 'methoddefinition') && s.name && (s.name.name || s.name.value) === '__construct'
    );
    if (!ctor || !ctor.body) return [];
    const stmts = Array.isArray(ctor.body) ? ctor.body : ctor.body.children || [];
    const entries = [];
    for (const st of stmts) {
      const raw = sourceSlice(parsed, st);
      if (!raw || !/\$this->middleware\s*\(/.test(raw)) continue;
      let mw = null;
      const mStr = raw.match(/\$this->middleware\s*\(\s*(['"])(.+?)\1/);
      if (mStr) mw = [mStr[2]];
      else {
        const mArr = raw.match(/\$this->middleware\s*\(\s*\[(.*?)\]\s*[,)]/s);
        if (mArr) mw = [...mArr[1].matchAll(/(['"])(.+?)\1/g)].map((x) => x[2]);
      }
      if (!mw || !mw.length) {
        note(`controller ${fqcn}: $this->middleware(...) with a dynamic argument — not evaluated (declare it in routes/ if it must run)`);
        continue;
      }
      const grab = (key) => {
        const m = raw.match(new RegExp(`['"]${key}['"]\\s*=>\\s*\\[(.*?)\\]`, 's'));
        return m ? [...m[1].matchAll(/(['"])(.+?)\1/g)].map((x) => x[2]) : null;
      };
      entries.push({ mw, only: grab('only'), except: grab('except') });
    }
    return entries;
  };

  // ---- Route::resource / apiResource ---------------------------------------
  // ResourceRegistrar::getResourceWildcard(): a segment that is not in the
  // `parameters` map goes through `Str::singular()` (`$singularParameters` is
  // true by default) and every '-' becomes '_'. The old hand-rolled `s$`
  // stripper answered `{people}` for `Route::resource('people', ...)` where
  // Laravel answers `{person}`, so the compiled route broke the controller's
  // model binding; tools/inflect.mjs is the faithful Pluralizer port.
  const singularOf = (word) => strSingular(String(word)).replace(/-/g, '_');

  // `Router::resources(array $resources, array $options = [])` (Router.php):
  // each map entry is one `resource($name, $controller, $options)` — the array
  // KEY is the resource name, the VALUE its controller. `apiResources()` is the
  // `apiResource()` variant. Each entry is handed to registerResource with a
  // synthesized verb step, so the wildcards/names/plan match the singular path.
  const registerResources = (verbStep, modifiers, file) => {
    const isApi = verbStep.method === 'apiResources';
    const listArg = verbStep.args[0];
    if (!listArg || listArg.kind !== 'array') {
      errors.push(
        `Route::${verbStep.method}() at ${relOf(file)} is not expanded by the static scanner ` +
          '(a dynamic resource list) — its routes would be missing from the table ' +
          '(the edge would 404 what PHP answers); declare each resource() explicitly or add them to registry.json'
      );
      return;
    }
    const optsArg = verbStep.args[1] || null;
    for (const e of listArg.items || []) {
      if (!e || e.kind !== 'entry') continue;
      const name = entryKey(e);
      if (name == null) {
        errors.push(
          `Route::${verbStep.method}() at ${relOf(file)} has an entry without a string resource name ` +
            '— it is not expanded by the static scanner; declare the resource() explicitly'
        );
        continue;
      }
      registerResource(
        { method: isApi ? 'apiResource' : 'resource', args: [{ kind: 'string', value: name }, e.value, optsArg] },
        modifiers,
        file
      );
    }
  };

  const registerResource = (verbStep, modifiers, file) => {
    const isApi = verbStep.method === 'apiResource';
    const rawName = strArg(verbStep.args[0]);
    // `ResourceRegistrar::register()` (:85-92): a name CONTAINING a slash never
    // reaches the resource expansion - it goes to `prefixedResource()`, where the
    // segments before the last slash become the URI PREFIX and only the last
    // segment names the resource (`getResourcePrefix()`, :251-261). Missing that
    // put the slash into the parameter wildcard (`admin/slugs/{admin/slug}` where
    // PHP answers `{slug}`) and into the route names.
    const slashAt = rawName ? rawName.lastIndexOf('/') : -1;
    const uriPrefix = slashAt >= 0 ? rawName.slice(0, slashAt) : '';
    const resourceName = slashAt >= 0 ? rawName.slice(slashAt + 1) : rawName;
    if (!resourceName) { note(`Route::${verbStep.method} with a dynamic name at ${relOf(file)} — not expanded`); return; }
    const controllerArg = verbStep.args[1] || null;
    const fqcn = controllerArg ? fqcnOf(controllerArg, parsedOf(file)) : null;
    if (!fqcn) { note(`Route::${verbStep.method}('${resourceName}') at ${relOf(file)} has no resolvable controller — not expanded`); return; }

    const optMap = {};
    const optsArg = verbStep.args[2];
    if (optsArg && optsArg.kind === 'array') {
      for (const e of optsArg.items || []) { const k = entryKey(e); if (k) optMap[k] = e.value; }
    }
    // Options that attach/remove middleware on a SINGLE resource method
    // (ResourceRegistrar::register() :107-118, PendingResourceRegistration
    // ->middlewareFor()/->withoutMiddlewareFor()). The scan does not model them,
    // and silently ignoring one would serve a method WITHOUT a guard the app
    // relies on — refuse instead, like the other un-expandable constructs.
    if (optMap.middleware_for || optMap.excluded_middleware_for || modifiers.middlewareFor) {
      errors.push(
        `Route::${verbStep.method}('${resourceName}') at ${relOf(file)} uses a per-method middleware option ` +
          '(middleware_for / excluded_middleware_for / ->middlewareFor()), which the static scanner does not model — ' +
          'the guard on that method would be dropped; declare the routes explicitly or add them to registry.json'
      );
    }
    const only = (optMap.only ? argStrList(optMap.only) : null) || modifiers.only || null;
    const except = (optMap.except ? argStrList(optMap.except) : null) || modifiers.except || null;
    let namesMap = null;
    let namesBase = null;
    const namesNode = (optMap.names && optMap.names.kind ? optMap.names : null) || modifiers.names || null;
    if (namesNode && namesNode.kind === 'array') {
      namesMap = {};
      for (const e of namesNode.items || []) { const k = entryKey(e); if (k) { const s = strArg(e.value); if (s != null) namesMap[k] = s; } }
    } else if (namesNode) {
      namesBase = strArg(namesNode);
    }
    const paramsMap = {};
    const paramsNode = (optMap.parameters && optMap.parameters.kind ? optMap.parameters : null) || modifiers.parameters || null;
    if (paramsNode && paramsNode.kind === 'array') {
      for (const e of paramsNode.items || []) { const k = entryKey(e); if (k) { const s = strArg(e.value); if (s != null) paramsMap[k] = s; } }
    }
    const paramOf = (seg) => paramsMap[seg] || singularOf(seg);

    const segs = String(resourceName).split('.').filter(Boolean);
    const parents = segs.slice(0, -1).map((s) => `${s}/{${paramOf(s)}}`);
    const last = segs[segs.length - 1];
    const collection = [...parents, last].join('/');
    const member = [...parents, last, `{${paramOf(last)}}`].join('/');

    const plan = [
      // ResourceRegistrar::$resourceDefaults (:21): index, create, store,
      // show, edit, update, destroy - the order `route:list` reports.
      ['index', 'GET', collection],
      ['create', 'GET', collection + '/create'],
      ['store', 'POST', collection],
      ['show', 'GET', member],
      ['edit', 'GET', member + '/edit'],
      ['update', 'PUT|PATCH', member],
      ['destroy', 'DELETE', member],
    ]
      .filter(([a]) => (isApi ? a !== 'create' && a !== 'edit' : true))
      .filter(([a]) => !only || only.includes(a))
      .filter(([a]) => !except || !except.includes(a));

    const g = now();
    const group = g.group || baseGroupFor(file);
    const excluded = (modifiers.excluded || []).concat(g.excluded);
    for (const [action, http, uriRaw] of plan) {
      const middleware = [group]
        .concat(g.middleware, modifiers.middleware || [])
        .filter((m) => !excluded.includes(String(m)));
      const extra = controllerMiddlewareFor(fqcn, action);
      if (extra && extra.length) middleware.push(...extra);
      // `ResourceRegistrar::getResourceRouteName()`: the `as` option becomes a
      // prefix WITH its own dot (`$options['as'].'.'`), the whole string is
      // `trim(sprintf('%s%s.%s', $prefix, $name, $method), '.')` — so a chain
      // `->name('nn.')` answers `nn..qq.index` (the interior double dot is
      // real; only the EDGES are trimmed). The group's name prefix is then
      // concatenated in front by RouteGroup::merge (formatAs).
      const bare = modifiers.as
        ? `${modifiers.as}.${namesBase != null ? namesBase : resourceName}.${action}`
        : `${namesBase != null ? namesBase : resourceName}.${action}`;
      const name =
        namesMap && namesMap[action] != null
          ? namesMap[action]
          : `${g.namePrefix}${bare.replace(/^\.+|\.+$/g, '')}`;
      routes.push({
        domain: g.domain || null,
        method: http === 'GET' ? 'GET|HEAD' : http,
        // The group's prefix applies to a resource exactly as to a verb route:
        // `Route::prefix('api')->group(fn => Route::resource('photos', C))`
        // answers `api/photos`, not `photos`. The scan dropped it, so every
        // method of every resource in a prefixed group was served at the wrong
        // URI (probed vs route:list --json). A CHAIN-form `Route::prefix('v2')`
        // before `->resource()` is a registrar attribute and is deliberately NOT
        // applied: PHP drops it too (see collectModifiers).
        uri: normalizeUri(joinUri(g.prefix, uriPrefix, uriRaw)),
        name,
        action: withGroupNamespace(`${fqcn}@${action}`, g.namespace),
        middleware,
        path: null,
      });
    }
  };

  for (const file of files) {
    const parsed = parsePhpFile(file);
    if (parsed.error) { errors.push(parsed.error); continue; }
    const top = topStatements(phpParse(parsed.source));
    const seed = seedFor[file];
    if (seed) groupStack.push(seed);
    walkStatements(top, file);
    if (seed) groupStack.pop();
  }

  return { routes, errors };
}

// php-parser instance (module-local, matching static.mjs's config)
import parser from 'php-parser';
let _parser;
function phpParse(source) {
  _parser = _parser || new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });
  // php-parser nests PHP 7's `.` precedence; route conditions are PHP, so the
  // tree is re-associated to PHP 8's (`.` below `+ - << >>`) exactly as the
  // config fold does (tools/static.mjs renestMixedChains()).
  return renestMixedChains(_parser.parseCode(source));
}

const { routes, errors } = parse();
// The controller module name is ONE function of the URI (`tools/route-slug.mjs`)
// and it is CASE-FOLDED (#366), so two DIFFERENT URIs that answer the same name
// are one build defect: `/a/b`, `/a-b`, `/{a}-{b}`, `/Posts` and `/posts` all
// collapse, and the build writes `dist/src/controllers/<slug>.mjs` per route -
// one route's handler would overwrite the other's and the handler table would
// point BOTH uris at whichever was written last. A collision is a build-level
// defect the operator must resolve, not a silent wrong answer: refuse the dump.
// The remediation names both ways out, because the first one (editing routes) is
// not available inside a third-party app.
{
  const owner = new Map();
  for (const r of routes) {
    const slug = slugifyRoute(r.uri);
    const prior = owner.get(slug);
    if (prior !== undefined && prior !== r.uri) {
      errors.push(
        'the route URIs ' + JSON.stringify(prior) + ' and ' + JSON.stringify(r.uri) +
          ' both compile to the controller module "' + slug + '.mjs" — rename one route (the build would serve both URLs with one handler),' +
          ' or declare one of them in registry.json (port/ignore) if the app is not yours to rename'
      );
    } else {
      owner.set(slug, r.uri);
    }
  }
}
// stdout stays the exact `route:list --json` shape; diagnostics go to stderr,
// which the build streams into its own log (errors used to be swallowed here).
if (errors.length) process.stderr.write(errors.map((e) => '  routes: parse issue ' + e + '\n').join(''));
if (notes.length) process.stderr.write(notes.map((n) => '  routes: ' + n + '\n').join(''));
process.stdout.write(JSON.stringify(routes) + '\n');
