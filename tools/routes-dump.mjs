#!/usr/bin/env node
// tools/routes-dump.mjs — pure-JS replacement for tools/routes-dump.php
//
// Usage: node tools/routes-dump.mjs
// Output (stdout): the SAME JSON `php artisan route:list --json` prints.
// No PHP interpreter, no composer install, no vendor download needed.
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

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  appRouteFiles,
  parsePhpFile,
  nodeName,
  callMethodName,
  callArgs,
  argValue,
  classFile,
  readEnvFile,
  loadConfig,
  configGet,
} from './static.mjs';

const appDir =
  process.env.LW_APP_ROOT ||
  (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);

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

const normalizeUri = (uri) => {
  const u = String(uri || '').replace(/\\/g, '');
  if (u === '/' || u === '') return '/';
  // route:list --json shows "dashboard" not "/dashboard"; root is "/".
  return String(u).replace(/^\/+|\/+$/g, '');
};

/** The FQCN for a `Controller::class` / `Controller` action node. */
const fqcnOf = (node, parsed) => {
  let raw = '';
  if (node.kind === 'staticlookup') raw = (node.what && (node.what.name || node.what.raw)) || '';
  else if (node.kind === 'name') raw = node.name || '';
  else return null;
  raw = String(raw).replace(/^\\/, '');
  if (!raw) return null;
  if (parsed && parsed.imports && raw in parsed.imports) return parsed.imports[raw].replace(/^\\/, '');
  if (parsed && parsed.namespace && !raw.includes('\\')) return parsed.namespace + '\\' + raw;
  return raw;
};

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
  const attrs = { prefix: '', namePrefix: '', middleware: [] };
  for (const st of steps) {
    if (st.method === 'prefix') { const v = strArg(st.args[0]); if (v != null) attrs.prefix += v; }
    else if (st.method === 'name') { const v = strArg(st.args[0]); if (v != null) attrs.namePrefix = v; }
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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'head'];

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

  const providersDir = join(appDir, 'app', 'Providers');
  if (existsSync(providersDir)) {
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

  const groupStack = []; // { prefix, namePrefix, middleware[], group }
  const now = () => {
    const cur = { prefix: '', namePrefix: '', middleware: [], group: null };
    for (const g of groupStack) {
      cur.prefix += g.prefix || '';
      cur.namePrefix += g.namePrefix || '';
      cur.middleware = cur.middleware.concat(g.middleware || []);
      if (!cur.group && g.group) cur.group = g.group;
    }
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
          if (HTTP_METHODS.includes(m) || m === 'resource' || m === 'apiResource') { verbIdx = i; break; }
        }
        if (verbIdx !== -1) { registerVerb(steps, verbIdx, file); return; }
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
      if (st.method === 'name') { const n = strArg(st.args[0]); if (n != null) modifiers.name = n; }
      if (st.method === 'middleware') { const m = middlewareList(st.args[0]); if (m && m.length) modifiers.middleware = m; }
      if (st.method === 'can') modifiers.can = true;
      if (st.method === 'where') modifiers.where = true;
      // Resource shape comes in two forms: `->only([...])` (a chain step) and
      // `Route::resource(..., ['only'=>…])` (the options argument) — both count.
      if (st.method === 'only') { const l = argStrList(st.args[0]); if (l) modifiers.only = l; }
      if (st.method === 'except') { const l = argStrList(st.args[0]); if (l) modifiers.except = l; }
      if (st.method === 'names' && st.args[0]) modifiers.names = st.args[0];
      if (st.method === 'parameters' && st.args[0]) modifiers.parameters = st.args[0];
    }
    return modifiers;
  };

  const registerVerb = (steps, verbIdx, file) => {
    // The verb step holds the uri + action; every OTHER step is a modifier
    // (name/middleware/can/where), whichever end of the chain it sits at.
    const verbStep = steps[verbIdx];
    const verbMethod = verbStep.method;
    if (verbMethod === 'resource' || verbMethod === 'apiResource') {
      registerResource(verbStep, collectModifiers(steps, verbIdx), file);
      return;
    }
    const uri0 = strArg(verbStep.args[0]);
    const actionArg = verbStep.args[1] || null;
    const method = verbMethod;

    const modifiers = collectModifiers(steps, verbIdx);

    const g = now();
    const group = g.group || baseGroupFor(file);
    const uri = normalizeUri(g.prefix + (uri0 || '{any}'));
    const name = modifiers.name != null ? g.namePrefix + modifiers.name : null;
    const middleware = [group].concat(g.middleware, modifiers.middleware || []);

    let action = 'Closure';
    let path = null;
    if (actionArg) {
      if (actionArg.kind === 'closure') {
        const line = verbStep.node.loc && verbStep.node.loc.start ? verbStep.node.loc.start.line : null;
        const rel = file.replace(/\\/g, '/').replace(appDir.replace(/\\/g, '/') + '/', '');
        path = line ? rel + ':' + line : null;
      } else if (actionArg.kind === 'array') {
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
        // 'Controller@method' route action
        action = actionArg.value;
      }
    }

    // Controller-level `$this->middleware('auth', ['except'=>…])` never appears
    // in the route file — without it the edge would run publish WITHOUT auth.
    if (action.includes('@')) {
      const at = action.indexOf('@');
      const extra = controllerMiddlewareFor(action.slice(0, at), action.slice(at + 1), file);
      if (extra && extra.length) middleware.push(...extra);
    }

    const methodOut =
      method === 'get' ? 'GET|HEAD' :
      method === 'head' ? 'HEAD' :
      method.toUpperCase();

    routes.push({
      domain: null,
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
    const closureArg = groupStep.args.map(argValue).find((a) => a && a.kind === 'closure');
    if (!closureArg) return;

    const attrs = { prefix: '', namePrefix: '', middleware: [] };
    // From the chain: Route::prefix('x')->name('a.')->middleware([...])
    for (const st of steps) {
      if (st.method === 'prefix') { const v = strArg(st.args[0]); if (v != null) attrs.prefix += v; }
      if (st.method === 'name') { const v = strArg(st.args[0]); if (v != null) attrs.namePrefix = v; }
      if (st.method === 'middleware') {
        const m = middlewareList(st.args[0]);
        if (m) attrs.middleware = attrs.middleware.concat(m);
      }
    }
    // From the attributes array: Route::group(['prefix'=>..., 'name'=>...], fn)
    const attrArray = groupStep.args.find((a) => a && a.kind === 'array');
    if (attrArray) {
      for (const e of (attrArray.items || [])) {
        if (!e || e.kind !== 'entry') continue;
        const key = entryKey(e);
        if (!key) continue;
        const v = e.value;
        if (key === 'prefix') { attrs.prefix += strArg(v) || ''; }
        if (key === 'name') { attrs.namePrefix += strArg(v) || ''; }
        if (key === 'middleware') { const m = middlewareList(v); if (m) attrs.middleware = attrs.middleware.concat(m); }
      }
    }
    groupStack.push(attrs);
    const body = closureArg.body && closureArg.body.children;
    walkStatements(body, file);
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
      if (_cfg === null) _cfg = loadConfig(appDir, _env || (_env = readEnvFile(appDir))).config;
      return wrap(phpTruthy(configGet(_cfg, m[2])));
    }
    m = expr.match(/^env\(\s*(['"])(.+?)\1(?:\s*,\s*[^)]*)?\)$/);
    if (m) {
      if (_env === null) _env = readEnvFile(appDir);
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
  const singularOf = (word) => {
    const w = String(word);
    if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
    if (/(ches|shes|sses|xes|zes)$/i.test(w)) return w.slice(0, -2);
    if (/s$/i.test(w)) return w.slice(0, -1);
    return w;
  };

  const registerResource = (verbStep, modifiers, file) => {
    const isApi = verbStep.method === 'apiResource';
    const resourceName = strArg(verbStep.args[0]);
    if (!resourceName) { note(`Route::${verbStep.method} with a dynamic name at ${relOf(file)} — not expanded`); return; }
    const controllerArg = verbStep.args[1] || null;
    const fqcn = controllerArg ? fqcnOf(controllerArg, parsedOf(file)) : null;
    if (!fqcn) { note(`Route::${verbStep.method}('${resourceName}') at ${relOf(file)} has no resolvable controller — not expanded`); return; }

    const optMap = {};
    const optsArg = verbStep.args[2];
    if (optsArg && optsArg.kind === 'array') {
      for (const e of optsArg.items || []) { const k = entryKey(e); if (k) optMap[k] = e.value; }
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
      ['index', 'GET', collection],
      ['store', 'POST', collection],
      ['create', 'GET', collection + '/create'],
      ['show', 'GET', member],
      ['update', 'PUT|PATCH', member],
      ['destroy', 'DELETE', member],
      ['edit', 'GET', member + '/edit'],
    ]
      .filter(([a]) => (isApi ? a !== 'create' && a !== 'edit' : true))
      .filter(([a]) => !only || only.includes(a))
      .filter(([a]) => !except || !except.includes(a));

    const g = now();
    const group = g.group || baseGroupFor(file);
    for (const [action, http, uriRaw] of plan) {
      const middleware = [group].concat(g.middleware, modifiers.middleware || []);
      const extra = controllerMiddlewareFor(fqcn, action);
      if (extra && extra.length) middleware.push(...extra);
      const name =
        namesMap && namesMap[action] != null
          ? namesMap[action]
          : namesBase != null
            ? `${namesBase}.${action}`
            : `${g.namePrefix}${resourceName}.${action}`;
      routes.push({
        domain: null,
        method: http === 'GET' ? 'GET|HEAD' : http,
        uri: normalizeUri(uriRaw),
        name,
        action: `${fqcn}@${action}`,
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
  return _parser.parseCode(source);
}

const { routes, errors } = parse();
// stdout stays the exact `route:list --json` shape; diagnostics go to stderr,
// which the build streams into its own log (errors used to be swallowed here).
if (errors.length) process.stderr.write(errors.map((e) => '  routes: parse issue ' + e + '\n').join(''));
if (notes.length) process.stderr.write(notes.map((n) => '  routes: ' + n + '\n').join(''));
process.stdout.write(JSON.stringify(routes) + '\n');
