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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appRouteFiles,
  parsePhpFile,
  nodeName,
  callMethodName,
  callArgs,
  argValue,
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

  const rf = appRouteFiles(appDir);
  const files = [];
  const groupForFile = {};
  if (rf && rf.web) { files.push(rf.web); groupForFile[rf.web] = 'web'; }
  if (rf && rf.api) { files.push(rf.api); groupForFile[rf.api] = 'api'; }
  if (!rf || !rf.web) {
    const conv = join(appDir, 'routes', 'web.php');
    if (existsSync(conv)) { files.push(conv); groupForFile[conv] = 'web'; }
  }
  if (!rf || !rf.api) {
    const conv = join(appDir, 'routes', 'api.php');
    if (existsSync(conv)) { files.push(conv); groupForFile[conv] = 'api'; }
  }

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
        const innermost = steps[steps.length - 1].method;
        if (innermost && HTTP_METHODS.includes(innermost)) {
          registerVerb(steps, innermost, file);
          return;
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw' || k === 'parent') continue;
      walkNode(node[k], file);
    }
  };

  const registerVerb = (steps, verbMethod, file) => {
    // The outermost step may be a modifier (name/middleware) — the verb is
    // the innermost step (it holds the uri + action args).
    const verbStep = steps[steps.length - 1];
    const uri0 = strArg(verbStep.args[0]);
    const actionArg = verbStep.args[1] || null;
    const method = verbMethod;

    const modifiers = {};
    for (const st of steps.slice(0, -1)) {
      if (st.method === 'name') { const n = strArg(st.args[0]); if (n != null) modifiers.name = n; }
      if (st.method === 'middleware') { const m = middlewareList(st.args[0]); if (m) modifiers.middleware = m; }
      if (st.method === 'can') modifiers.can = true;
      if (st.method === 'where') modifiers.where = true;
    }

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
        if (!e || e.kind !== 'entry' || !e.key) continue;
        const key = nodeName(e.key);
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

  for (const file of files) {
    const parsed = parsePhpFile(file);
    if (parsed.error) { errors.push(parsed.error); continue; }
    const top = topStatements(phpParse(parsed.source));
    walkStatements(top, file);
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
process.stdout.write(JSON.stringify(routes) + '\n');
