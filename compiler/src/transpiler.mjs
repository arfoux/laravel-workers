// compiler/src/transpiler.mjs
import parser from 'php-parser';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

// PHP variable names are mangled to JS identifiers so reserved words ($null, $new, ...) are safe.
const vname = (name) => 'v_' + String(name).replace(/^\\$/, '').replace(/[^A-Za-z0-9_]/g, '_');
const fname = (name) => 'fn_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');

function mkErr(code, message, loc, hint) {
  const e = new Error(message);
  e.lw = { code, message, line: loc?.start?.line ?? 0, column: loc?.start?.column ?? 0, hint: hint || '' };
  return e;
}

// A PHP numeric literal is a float iff its source text has '.' or an exponent.
function floatish(node) {
  if (node && node.kind === 'number') {
    return /[.eE]/.test(String(node.value));
  }
  if (node && node.kind === 'unary') {
    return floatish(node.what || node.expr || node.operand);
  }
  return false;
}

function txOffsetKey(node) {
  if (!node) return 'null';
  if (node.kind === 'identifier' || node.kind === 'name') return JSON.stringify(String(node.name));
  if (node.kind === 'string') return JSON.stringify(node.value);
  return tx(node);
}

// ---- PHP 8 precedence fix for mixed '.' / '+' / '-' chains (php-parser = PHP 7) ----
const ADDSUB = new Set(['+', '-', '.']);
function flattenMix(node, out) {
  if (node.kind === 'bin' && ADDSUB.has(node.type)) {
    flattenMix(node.left, out);
    out.push(node.type);
    flattenMix(node.right, out);
  } else {
    out.push(node);
  }
}
function txMix(node) {
  const flat = [];
  flattenMix(node, flat);
  const outStack = [];
  const opStack = [];
  const prec = { '.': 1, '+': 2, '-': 2 };
  const apply = () => {
    const op = opStack.pop();
    const b = outStack.pop();
    const a = outStack.pop();
    const fn = op === '.' ? 'rt.concat' : (op === '+' ? 'rt.add' : 'rt.sub');
    outStack.push(fn + '(' + a + ', ' + b + ')');
  };
  for (const it of flat) {
    if (typeof it === 'string') {
      while (opStack.length && prec[opStack[opStack.length - 1]] >= prec[it]) apply();
      opStack.push(it);
    } else {
      outStack.push(tx(it));
    }
  }
  while (opStack.length) apply();
  return outStack[0];
}

// ---- expression translation ----
function tx(node) {
  if (!node) throw mkErr('LW002', 'missing expression', null);
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return String(Number(node.value));
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
    case 'nullkeyword':
      return 'null';
    case 'name':
      throw mkErr('LW002', 'bare identifier not allowed: ' + node.name, node.loc);
    case 'identifier':
      return JSON.stringify(String(node.name));
    case 'variable':
      if (node.name === 'this' && CTX) {
        throw mkErr('LW002', '$this is not supported in transpiled controllers — ' + PORT_HINT, node.loc, PORT_HINT);
      }
      return vname(node.name);
    case 'encapsed': {
      const parts = node.parts || node.value || [];
      if (!parts.length) return "''";
      let acc = null;
      for (const p of parts) {
        const piece = p.expression ? tx(p.expression) : JSON.stringify(p.value ?? '');
        acc = acc === null ? piece : 'rt.concat(' + acc + ', ' + piece + ')';
      }
      return acc;
    }
    case 'offsetlookup': {
      return tx(node.what) + '[' + txOffsetKey(node.offset) + ']';
    }
    case 'propertylookup': {
      const name = node.offset && node.offset.name;
      if (typeof name !== 'string') {
        throw mkErr('LW002', 'unsupported property access', node.loc);
      }
      return 'rt.prop(' + tx(node.what) + ', ' + JSON.stringify(name) + ')';
    }
    case 'nullsafeproperty':
      throw mkErr('LW002', 'nullsafe property access (?->) is not supported', node.loc);
    case 'bin':
      return txBin(node);
    case 'unary': {
      const t = node.type;
      const expr = node.what || node.expr || node.argument || node.operand;
      if (t === '!') return 'rt.not(' + tx(expr) + ')';
      if (t === '-') return '(-' + tx(expr) + ')';
      if (t === '+') return '(+' + tx(expr) + ')';
      throw mkErr('LW002', 'unsupported unary ' + t, node.loc);
    }
    case 'post': {
      const op = node.type === '+' ? '++' : '--';
      return tx(node.what) + op;
    }
    case 'pre': {
      const op = node.type === '+' ? '++' : '--';
      return op + tx(node.what);
    }
    case 'retif': {
      const test = tx(node.test);
      if (!node.trueExpr) return '(rt.truthy(' + test + ') ? ' + test + ' : ' + tx(node.falseExpr) + ')';
      return '(rt.truthy(' + test + ') ? ' + tx(node.trueExpr) + ' : ' + tx(node.falseExpr) + ')';
    }
    case 'match': {
      const arms = (node.arms || []).map((a) => {
        const conds = a.conds && a.conds.length ? '[' + a.conds.map(tx).join(', ') + ']' : 'null';
        return '[' + conds + ', () => (' + tx(a.body) + ')]';
      });
      return 'rt.match(' + tx(node.cond) + ', ' + arms.join(', ') + ')';
    }
    case 'isset': {
      const vars = (node.variables || []).map(tx);
      return 'rt.isset(' + vars.join(', ') + ')';
    }
    case 'empty':
      return 'rt.empty(' + tx(node.expression) + ')';
    case 'assign':
      return txAssignExpr(node);
    case 'array': {
      const items = node.items || [];
      const isAssoc = items.some((it) => it.key != null);
      if (isAssoc) {
        const pairs = items.map((it) => txOffsetKey(it.key) + ': ' + tx(it.value));
        return '{' + pairs.join(', ') + '}';
      }
      return '[' + items.map((it) => tx(it.value)).join(', ') + ']';
    }
    case 'call':
      return txCall(node);
    case 'closure':
      return txClosure(node);
    case 'arrowfunc':
      return txArrowFunc(node);
    default:
      throw mkErr('LW002', 'unsupported expression kind ' + node.kind, node.loc);
  }
}

function txBin(node) {
  const t = node.type;
  const L = () => tx(node.left);
  const R = () => tx(node.right);
  // php-parser uses PHP 7 precedence where '.' sits at the same level as '+'/'-'.
  // PHP 8 lowered '.' below '+'/'-'; re-associate mixed chains to match PHP 8 bytes.
  if (t === '.' || t === '+' || t === '-') return txMix(node);
  switch (t) {
    case '??':
      return 'rt.coalesce(' + L() + ', ' + R() + ')';
    case '||':
      return '(' + L() + ' || ' + R() + ')';
    case '&&':
      return '(' + L() + ' && ' + R() + ')';
    case 'or':
      return 'rt.or(() => (' + L() + '), () => (' + R() + '))';
    case 'and':
      return 'rt.and(() => (' + L() + '), () => (' + R() + '))';
    case '==':
      return 'rt.looseEq(' + L() + ', ' + R() + ')';
    case '!=':
      return 'rt.looseNe(' + L() + ', ' + R() + ')';
    case '===':
      return 'rt.strictEq(' + L() + ', ' + R() + ', ' + floatish(node.left) + ', ' + floatish(node.right) + ')';
    case '!==':
      return 'rt.strictNe(' + L() + ', ' + R() + ', ' + floatish(node.left) + ', ' + floatish(node.right) + ')';
    case '<':
      return 'rt.lt(' + L() + ', ' + R() + ')';
    case '>':
      return 'rt.gt(' + L() + ', ' + R() + ')';
    case '<=':
      return 'rt.lte(' + L() + ', ' + R() + ')';
    case '>=':
      return 'rt.gte(' + L() + ', ' + R() + ')';
    case '+':
      return 'rt.add(' + L() + ', ' + R() + ')';
    case '-':
      return 'rt.sub(' + L() + ', ' + R() + ')';
    case '*':
      return 'rt.mul(' + L() + ', ' + R() + ')';
    case '/':
      return 'rt.div(' + L() + ', ' + R() + ')';
    case '%':
      return 'rt.mod(' + L() + ', ' + R() + ')';
    case '**':
      return 'rt.pow(' + L() + ', ' + R() + ')';
    default:
      throw mkErr('LW002', 'unsupported operator ' + t, node.loc);
  }
}

// function table is injected by `transpile` (module-level, per-parse)
let FUNCS = new Set();

// ---- controller transpilation state (injected by `transpileControllerMethod`) ----
// CTX is null when compiling Blade views; set to {models, views} when compiling a
// controller method body. It enables: model query chains, redirect()/response()->json(),
// view()/abort()/compact(), and await-based async codegen for D1 queries.
let CTX = null;
let CLOSURE_DEPTH = 0;

// Static model calls that START a chain (return a query builder, no await).
const MODEL_STATIC_START = new Set(['where', 'whereIn']);
// Static model calls that are terminal (return a Promise, must be awaited).
const MODEL_STATIC_TERMINAL = new Set(['find', 'findOrFail', 'all']);
// Chainable builder methods (kernel db.mjs API). Keep in sync with kernel/db.mjs.
const MODEL_CHAIN_BUILDER = new Set([
  'where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
  'orderBy', 'orderByDesc', 'latest', 'oldest', 'limit', 'offset', 'select',
]);
// Terminal builder methods (return a Promise).
const MODEL_CHAIN_TERMINAL = new Set(['first', 'firstOrFail', 'get', 'count', 'pluck', 'value']);

const PORT_HINT = 'write a port handler for this route (build --scaffold) instead';

// ---------------------------------------------------------------------------
// HTTP helpers available inside a compiled controller (7b)
// ---------------------------------------------------------------------------
// `session()`, `old()`, `csrf_token()`, `csrf_field()`, `request()` map straight
// onto rt.* (which reads the live session/request handed down by the kernel).
// `auth()` / `Auth::*` need the request context too and the guard resolves the
// user asynchronously (Timebox), so in controller mode those calls are awaited.
const HTTP_HELPERS = new Set(['session', 'old', 'csrf_token', 'csrf_field', 'request']);
// Recaller/guard methods that return a promise at the edge.
const AUTH_ASYNC = new Set(['check', 'guest', 'user', 'id', 'attempt', 'once', 'login', 'logout']);
const AUTH_FACADE_RE = /^rt\.auth\((?:[^()]*)\)(?:\.guard\((?:[^()]*)\))?$/;
// Session store mutation methods that touch the handler and are therefore async
// on the compiled Store (kernel/session.mjs). regenerateToken() stays sync.
const SESSION_STORE_RE = /(?:^|\.)session\(\)$/;
const SESSION_ASYNC = new Set(['regenerate', 'invalidate', 'migrate']);

// $request->method() allowlist (sync unless listed in REQUEST_ASYNC). Anything
// else fails loud at build time so the route falls back to a port instead of
// silently returning wrong data at the edge.
const REQUEST_CALL = new Set([
  'input', 'all', 'query', 'post', 'has', 'hasAny', 'filled', 'isNotFilled', 'missing',
  'only', 'except', 'string', 'integer', 'float', 'boolean', 'date', 'isMethod', 'method',
  'path', 'url', 'fullUrl', 'ajax', 'pjax', 'expectsJson', 'wantsJson', 'accepts',
  'acceptsAnyContentType', 'acceptsJson', 'prefetch', 'header', 'headers', 'hasHeader',
  'bearerToken', 'cookie', 'hasCookie', 'ip', 'userAgent', 'route', 'session', 'old',
]);
const REQUEST_ASYNC = new Set(['user']);
const REQUEST_DENY = new Set([
  'file', 'files', 'allFiles', 'hasFile', 'hasValidFile', 'fileIsValid',
]);

function txRequestCall(node, args) {
  const what = node.what;
  if (!what || what.kind !== 'propertylookup') return null;
  const inner = what.what;
  if (!inner || inner.kind !== 'variable') return null;
  if (!CTX || !CTX.requestVars || !CTX.requestVars.has(vname(inner.name))) return null;
  const meth = what.offset && what.offset.name;
  if (typeof meth !== 'string') {
    throw mkErr('LW002', 'unsupported $request property access', node.loc, PORT_HINT);
  }
  if (REQUEST_DENY.has(meth)) {
    throw mkErr(
      'LW002',
      '$request->' + meth + '() (uploaded files) is not supported by the compiled rung yet — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  // $request->validate($rules, $messages?, $attributes?) — runs kernel/validator
  // over the request input; a failure throws ValidationException, which the HTTP
  // kernel renders as redirect-back + flashed errors/old input (or 422 JSON).
  if (meth === 'validate' || meth === 'validateWithBag') {
    const expr = vname(inner.name) + '.' + meth + '(' + args + ')';
    return txAwait(expr, node, '$request->' + meth + '()');
  }
  if (!REQUEST_CALL.has(meth)) {
    throw mkErr(
      'LW002',
      'unsupported $request->' + meth + '() — allowed: ' + [...REQUEST_CALL].join(', ') + '; ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const expr = vname(inner.name) + '.' + meth + '(' + args + ')';
  return REQUEST_ASYNC.has(meth) ? txAwait(expr, node, '$request->' + meth + '()') : expr;
}

function txAwait(expr, node, label = 'database query') {
  if (CLOSURE_DEPTH > 0) {
    throw mkErr('LW002', label + ' inside a closure is not supported — move the query outside the closure', node.loc, PORT_HINT);
  }
  return '(await ' + expr + ')';
}

// Detects a model query chain starting at a model class static call.
// Returns { root, segments } or null. segments[0] is the static call; the rest are ->method() calls.
function modelChain(node) {
  if (!CTX || !CTX.models) return null;
  const segs = [];
  let root = null;
  let cur = node;
  while (cur && cur.kind === 'call') {
    const what = cur.what;
    if (!what) return null;
    if (what.kind === 'propertylookup') {
      const name = what.offset && what.offset.name;
      if (typeof name !== 'string') return null;
      segs.unshift({ name, node: cur });
      cur = what.what;
    } else if (what.kind === 'staticlookup') {
      const cls = what.what && what.what.name;
      const name = what.offset && what.offset.name;
      if (typeof cls !== 'string' || typeof name !== 'string') return null;
      if (!CTX.models.has(cls)) return null;
      segs.unshift({ name, node: cur });
      root = cls;
      break;
    } else {
      return null;
    }
  }
  if (!root) return null;
  return { root, segments: segs };
}

function txModelChain(chain, node) {
  const { root, segments } = chain;
  const first = segments[0];
  const firstArgs = (first.node.arguments || []).map(tx).join(', ');
  const clsLit = JSON.stringify(root);
  let expr;
  if (MODEL_STATIC_START.has(first.name)) {
    expr = 'rt.model(' + clsLit + ').' + first.name + '(' + firstArgs + ')';
  } else if (MODEL_STATIC_TERMINAL.has(first.name)) {
    if (segments.length > 1) {
      throw mkErr('LW003', root + '::' + first.name + '() cannot be chained — ' + PORT_HINT, node.loc, PORT_HINT);
    }
    expr = txAwait('rt.model(' + clsLit + ').' + first.name + '(' + firstArgs + ')', first.node);
  } else {
    throw mkErr('LW003', 'unsupported static call ' + root + '::' + first.name + '() — only find, findOrFail, all, where, whereIn transpile at the edge', node.loc, PORT_HINT);
  }
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const at = (seg.node.arguments || []).map(tx).join(', ');
    if (MODEL_CHAIN_BUILDER.has(seg.name)) {
      expr += '.' + seg.name + '(' + at + ')';
    } else if (MODEL_CHAIN_TERMINAL.has(seg.name)) {
      if (i !== segments.length - 1) {
        throw mkErr('LW003', 'cannot chain past ->' + seg.name + '() — ' + PORT_HINT, seg.node.loc, PORT_HINT);
      }
      expr = txAwait(expr + '.' + seg.name + '(' + at + ')', seg.node);
    } else {
      throw mkErr('LW003', 'unsupported query method ->' + seg.name + '() — ' + PORT_HINT, seg.node.loc, PORT_HINT);
    }
  }
  return expr;
}

// redirect(...), redirect()->route(...), redirect()->to(...), response()->json(...)
function txRedirectChain(node) {
  const what = node.what;
  if (!what) return null;
  if (what.kind === 'name' && what.name === 'redirect') {
    const argNodes = node.arguments || [];
    if (argNodes.length === 0) {
      throw mkErr('LW002', "redirect() with no target is not supported — use redirect('/path') or redirect()->route('name')", node.loc, PORT_HINT);
    }
    if (argNodes.length > 2) throw mkErr('LW002', 'redirect() supports at most 2 arguments', node.loc, PORT_HINT);
    return 'rt.redirect(' + argNodes.map(tx).join(', ') + ')';
  }
  if (what.kind === 'propertylookup') {
    const inner = what.what;
    const m = what.offset && what.offset.name;
    if (!inner || inner.kind !== 'call' || !inner.what || inner.what.kind !== 'name') return null;
    const base = inner.what.name;
    const innerArgs = inner.arguments || [];
    if (base === 'redirect') {
      if (innerArgs.length !== 0) throw mkErr('LW002', 'unsupported redirect(...) usage', node.loc, PORT_HINT);
      if (m === 'route') {
        const a = node.arguments || [];
        if (!a.length) throw mkErr('LW002', 'redirect()->route() needs a route name', node.loc, PORT_HINT);
        if (a[0].kind !== 'string') throw mkErr('LW002', 'redirect()->route() name must be a string literal', node.loc, PORT_HINT);
        return 'rt.redirect(rt.route(' + a.map(tx).join(', ') + '))';
      }
      if (m === 'to') {
        const a = node.arguments || [];
        if (!a.length) throw mkErr('LW002', 'redirect()->to() needs a location', node.loc, PORT_HINT);
        return 'rt.redirect(' + a.map(tx).join(', ') + ')';
      }
      // Redirector::intended($default = '/') -> pull('url.intended', $default).
      if (m === 'intended') {
        const a = node.arguments || [];
        if (a.length > 1) throw mkErr('LW002', 'redirect()->intended() supports at most 1 argument', node.loc, PORT_HINT);
        const def = a.length ? tx(a[0]) : '"/"';
        return 'rt.redirect(rt.session().pull("url.intended", ' + def + '))';
      }
      throw mkErr('LW002', 'unsupported redirect()->' + m + '() — ' + PORT_HINT, node.loc, PORT_HINT);
    }
    if (base === 'response') {
      if (innerArgs.length !== 0) throw mkErr('LW002', 'unsupported response(...) usage', node.loc, PORT_HINT);
      if (m === 'json') {
        const a = node.arguments || [];
        if (a.length < 1 || a.length > 2) throw mkErr('LW002', 'response()->json() needs 1-2 arguments', node.loc, PORT_HINT);
        return 'rt.json(' + a.map(tx).join(', ') + ')';
      }
      throw mkErr('LW002', 'unsupported response()->' + m + '() — ' + PORT_HINT, node.loc, PORT_HINT);
    }
  }
  return null;
}

function txCall(node) {
  const args = (node.arguments || []).map(tx).join(', ');
  const what = node.what;
  if (CTX) {
    const redir = txRedirectChain(node);
    if (redir) return redir;
    const chain = modelChain(node);
    if (chain) return txModelChain(chain, node);
    const reqCall = txRequestCall(node, args);
    if (reqCall) return reqCall;
  }
  if (what.kind === 'name') {
    const name = what.name;
    if (name === 'app') {
      if ((node.arguments || []).length === 0) return 'rt.app()';
      return 'rt.app(' + args + ')';
    }
    const argNodes = node.arguments || [];
    const cbRef = (n) => (n && n.kind === 'string' && FUNCS.has(n.value) ? fname(n.value) : null);
    if (name === 'array_map') {
      const cb = cbRef(argNodes[0]);
      if (!cb) throw mkErr('LW001', 'array_map requires a named function callback', node.loc);
      return 'rt.array_map(' + cb + ', ' + tx(argNodes[1]) + ')';
    }
    if (name === 'array_filter') {
      const cb = cbRef(argNodes[1]);
      if (argNodes.length > 1 && !cb) throw mkErr('LW001', 'array_filter callback must be a named function', node.loc);
      return 'rt.array_filter(' + tx(argNodes[0]) + (cb ? ', ' + cb : '') + ')';
    }
    if (CTX && CTX.controller && HTTP_HELPERS.has(name)) {
      const a = node.arguments || [];
      if (name === 'session') {
        if (a.length === 0) return 'rt.session()';
        if (a.length > 2) throw mkErr('LW002', 'session() supports at most 2 arguments', node.loc, PORT_HINT);
        if (a[0].kind === 'array') {
          throw mkErr('LW002', "session(['k' => v]) is not supported — use session()->put([...])", node.loc, PORT_HINT);
        }
        return 'rt.session().get(' + a.map(tx).join(', ') + ')';
      }
      if (name === 'old') {
        if (a.length === 0 || a.length > 2) throw mkErr('LW002', 'old() needs 1-2 arguments', node.loc, PORT_HINT);
        return 'rt.old(' + args + ')';
      }
      if (name === 'csrf_token' || name === 'csrf_field') {
        if (a.length) throw mkErr('LW002', name + '() takes no arguments', node.loc, PORT_HINT);
        return 'rt.' + name + '()';
      }
      if (name === 'request') {
        if (a.length) throw mkErr('LW002', 'request(...) with arguments is not supported', node.loc, PORT_HINT);
        return 'rt.request()';
      }
    }
    if (CTX) {
      if (name === 'view') {
        const vn = argNodes[0];
        if (!vn || vn.kind !== 'string') {
          throw mkErr('LW002', 'view() name must be a string literal so it can be compiled at build time', node.loc, PORT_HINT);
        }
        if (CTX.views && !CTX.views.has(vn.value)) {
          throw mkErr('LW002', 'view "' + vn.value + '" was not compiled for this controller — ' + PORT_HINT, node.loc, PORT_HINT);
        }
        return 'rt.view(' + args + ')';
      }
      if (name === 'abort') return 'rt.abort(' + args + ')';
      if (name === 'compact') {
        const keys = [];
        for (const a of argNodes) {
          if (a.kind !== 'string') throw mkErr('LW001', 'compact() requires string literal variable names', node.loc, PORT_HINT);
          keys.push(a.value);
        }
        return '{ ' + keys.map((k) => JSON.stringify(k) + ': ' + vname(k)).join(', ') + ' }';
      }
    }
    const whitelisted = new Set(['e', 'str_replace', 'config', 'public_path', 'file_exists', 'url', 'route', 'auth']);
    const builtins = new Set([
      'isset', 'empty', 'unset', 'count', 'in_array', 'implode', 'explode',
      'sprintf', 'strtolower', 'strtoupper', 'trim', 'number_format', 'nl2br',
      'strlen', 'substr', 'str_repeat', 'str_contains', 'str_starts_with', 'str_ends_with',
      'ucfirst', 'lcfirst', 'str_pad', 'array_key_exists', 'array_keys', 'array_values', 'array_merge',
      'ltrim', 'rtrim', 'ucwords', 'strrev', 'strpos', 'strrpos', 'substr_count', 'strip_tags', 'htmlspecialchars',
      'is_null', 'is_bool', 'is_boolean', 'is_int', 'is_integer', 'is_long', 'is_float', 'is_double', 'is_real',
      'is_string', 'is_array', 'is_object', 'is_numeric', 'is_callable', 'is_countable',
      'abs', 'round', 'floor', 'ceil', 'intval', 'floatval', 'max', 'min',
      'json_encode', 'json_decode', 'optional',
      'array_sum', 'array_slice', 'array_reverse', 'array_unique', 'array_count_values', 'array_flip',
      'now',
      'collect',
    ]);
    if (whitelisted.has(name) || builtins.has(name)) return 'rt.' + name + '(' + args + ')';
    if (FUNCS.has(name)) return fname(name) + '(' + args + ')';
    throw mkErr('LW001', 'unknown function ' + name, node.loc);
  }
  if (what.kind === 'staticlookup') {
    const cls = what.what && what.what.name;
    const meth = what.offset && what.offset.name;
    if (cls === 'Route' && meth === 'has') return 'rt.Route.has(' + args + ')';
    if ((cls === 'Auth' || cls === 'Illuminate\\Support\\Facades\\Auth') && CTX && CTX.controller) {
      if (!AUTH_ASYNC.has(meth)) {
        throw mkErr(
          'LW002',
          'Auth::' + meth + '() is not supported — allowed: ' + [...AUTH_ASYNC].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait('rt.auth().' + meth + '(' + args + ')', node, 'Auth::' + meth + '()');
    }
    throw mkErr('LW003', 'unknown class/static ' + cls + '::' + meth, node.loc);
  }
  if (what.kind === 'propertylookup') {
    const obj = tx(what.what);
    const meth = what.offset && what.offset.name;
    if (!meth) throw mkErr('LW002', 'property access without method', node.loc);
    const expr = obj + '.' + meth + '(' + args + ')';
    // auth()->user() / auth()->guard()->attempt() resolve the user async (Timebox).
    if (CTX && CTX.controller && AUTH_FACADE_RE.test(obj) && AUTH_ASYNC.has(meth)) {
      return txAwait(expr, node, 'an authenticated call');
    }
    // session()->regenerate()/invalidate()/migrate() touch the handler (async).
    if (CTX && CTX.controller && SESSION_STORE_RE.test(obj) && SESSION_ASYNC.has(meth)) {
      return txAwait(expr, node, 'session()->' + meth + '()');
    }
    return expr;
  }
  if (what.kind === 'variable') {
    return tx(what) + '(' + args + ')';
  }
  if (what.kind === 'closure' || what.kind === 'arrowfunc') {
    return tx(what) + '(' + args + ')';
  }
  if (what.kind === 'call') {
    return tx(what) + '(' + args + ')';
  }
  throw mkErr('LW002', 'unsupported call target', node.loc);
}

function getUseInfo(u){
  if(!u) return null;
  // direct variable with byref flag (php-parser read_byref sets byref:true on variable)
  if(u.kind==='variable') return { name: u.name, byref: !!u.byref };
  // wrapped byref node? (some versions)
  if(u.byref && u.what && u.what.kind==='variable') return { name: u.what.name, byref: true };
  // fallback for reference kind
  if(u.kind==='byref' && u.what) return { name: u.what.name || u.what, byref: true };
  return null;
}

function txClosure(node){
  const params=(node.arguments||[]).map(p=>{
    const pn=vname(p.name && p.name.name ? p.name.name : p.name);
    return p.value ? pn+' = '+tx(p.value) : pn;
  });
  const uses=node.uses||[];
  const byVal=[];
  const byRef=[];
  for(const u of uses){
    const info=getUseInfo(u);
    if(!info) continue;
    if(info.byref) byRef.push(info.name);
    else byVal.push(info.name);
  }
  // build body JS: need to render block children via inline walk? reuse tx for statements by emitting JS function body string
  // Instead generate JS code for body by simulating walkChildren into string buffer via helper emitClosureBody
  const bodyCode=emitClosureBody(node.body, byVal, byRef, node.arguments||[]);
  const fn='function('+params.join(', ')+'){'+bodyCode+'}';
  if(byVal.length===0){
    return '('+fn+')';
  }
  const caps=byVal.map(n=>vname(n));
  const capParams=byVal.map(n=>'__cap_'+n);
  const lets=byVal.map((n,i)=>'let '+caps[i]+'='+capParams[i]+';').join('');
  const fnWithLets='function('+params.join(', ')+'){'+lets+bodyCode+'}';
  return '(('+capParams.join(', ')+')=>('+fnWithLets+'))('+caps.join(', ')+')';
}

function emitClosureBody(body, byVal, byRef, params){
  if(!body) return '';
  if(body.kind==='block'){
    const paramSet=new Set((params||[]).map(p=> String(p.name && p.name.name ? p.name.name : p.name)));
    const byValSet=new Set(byVal||[]);
    const byRefSet=new Set(byRef||[]);
    const scan=(n, set)=>{
      if(!n||typeof n!=='object') return;
      if(Array.isArray(n)){ for(const x of n) scan(x,set); return; }
      if(n.kind==='closure' || n.kind==='arrowfunc') return;
      if(n.kind==='variable' && n.name) set.add(String(n.name));
      for(const k of Object.keys(n)){ if(k==='loc') continue; scan(n[k], set); }
    };
    const all=new Set();
    scan(body, all);
    const locals=[...all].filter(n=> !paramSet.has(n) && !byValSet.has(n) && !byRefSet.has(n));
    const lines=[];
    if(locals.length) lines.push('let '+locals.map(vname).join(', ')+';');
    CLOSURE_DEPTH++;
    try{
      walkChildren(body.children||[], lines, '', {});
    }finally{
      CLOSURE_DEPTH--;
    }
    return lines.join(' ');
  }
  CLOSURE_DEPTH++;
  try {
    return 'return '+tx(body)+';';
  } finally {
    CLOSURE_DEPTH--;
  }
}

function txArrowFunc(node){
  const params=(node.arguments||[]).map(p=>{
    const pn=vname(p.name && p.name.name ? p.name.name : p.name);
    return p.value ? pn+' = '+tx(p.value) : pn;
  });
  CLOSURE_DEPTH++;
  let expr;
  try {
    expr=tx(node.body);
  } finally {
    CLOSURE_DEPTH--;
  }
  if(params.length===1) return '('+params[0]+'=>('+expr+'))';
  return '(('+params.join(', ')+')=>('+expr+'))';
}


function txAssignExpr(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  if (left.kind === 'variable') {
    const v = vname(left.name);
    if (op === '=') return '(' + v + ' = ' + right + ')';
    if (op === '??=') return 'rt.coalesceAssign(() => (' + v + '), (x) => { ' + v + ' = x; }, ' + right + ')';
    const base = op.slice(0, -1);
    const helper = { '+': 'rt.add', '-': 'rt.sub', '.': 'rt.concat', '*': 'rt.mul', '/': 'rt.div', '%': 'rt.mod', '**': 'rt.pow' }[base];
    if (helper) return '(' + v + ' = ' + helper + '(' + v + ', ' + right + '))';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'offsetlookup') {
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return '(' + target + ' = ' + right + ')';
    if (op === '??=') return 'rt.coalesceAssign(() => (' + target + '), (x) => { ' + target + ' = x; }, ' + right + ')';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
}

function txAssignStatement(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  if (left.kind === 'variable') {
    const v = vname(left.name);
    if (op === '=') return v + ' = ' + right + ';';
    if (op === '??=') return 'if (' + v + ' === null || ' + v + ' === undefined) { ' + v + ' = ' + right + '; }';
    const base = op.slice(0, -1);
    const helper = { '+': 'rt.add', '-': 'rt.sub', '.': 'rt.concat', '*': 'rt.mul', '/': 'rt.div', '%': 'rt.mod', '**': 'rt.pow' }[base];
    if (helper) return v + ' = ' + helper + '(' + v + ', ' + right + ');';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'offsetlookup') {
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return target + ' = ' + right + ';';
    if (op === '??=') return 'if (' + target + ' === null || ' + target + ' === undefined) { ' + target + ' = ' + right + '; }';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
}

// ---- statement translation ----
function childStatements(node) {
  if (!node) return [];
  if (node.kind === 'block') return node.children || [];
  return [node];
}

function walkChildren(children, lines, indent, ctx) {
  for (const node of (children || [])) {
    walkStatement(node, lines, indent, ctx);
  }
}

function walkStatement(node, lines, indent, ctx) {
  switch (node.kind) {
    case 'inline':
      lines.push(indent + 'rt.echo(' + JSON.stringify(node.value) + ');');
      break;
    case 'echo':
      for (const expr of (node.expressions || [])) lines.push(indent + 'rt.echo(' + tx(expr) + ');');
      break;
    case 'block':
      walkChildren(node.children || [], lines, indent, ctx);
      break;
    case 'expressionstatement':
      if (node.expression && node.expression.kind === 'assign') lines.push(indent + txAssignStatement(node.expression));
      else lines.push(indent + tx(node.expression || node) + ';');
      break;
    case 'if':
      lines.push(indent + 'if (rt.truthy(' + tx(node.test) + ')) {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      if (node.alternate || node.shortForm) {
        const alt = node.alternate;
        if (alt && alt.kind === 'if') {
          lines.push(indent + '} else if (rt.truthy(' + tx(alt.test) + ')) {');
          walkChildren(childStatements(alt.body), lines, indent + '  ', ctx);
          let cur = alt;
          while (cur.alternate) {
            const a = cur.alternate;
            if (a.kind === 'if') {
              lines.push(indent + '} else if (rt.truthy(' + tx(a.test) + ')) {');
              walkChildren(childStatements(a.body), lines, indent + '  ', ctx);
              cur = a;
            } else {
              lines.push(indent + '} else {');
              walkChildren(childStatements(a), lines, indent + '  ', ctx);
              cur = a;
              break;
            }
          }
        } else if (alt && (alt.kind === 'block' || alt.children)) {
          lines.push(indent + '} else {');
          walkChildren(childStatements(alt), lines, indent + '  ', ctx);
        } else if (alt) {
          lines.push(indent + '} else {');
          walkChildren(childStatements(alt), lines, indent + '  ', ctx);
        }
      }
      lines.push(indent + '}');
      break;
    case 'while':
      lines.push(indent + 'while (rt.truthy(' + tx(node.test) + ')) {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '}');
      break;
    case 'do':
      lines.push(indent + 'do {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '} while (rt.truthy(' + tx(node.test) + '));');
      break;
    case 'for': {
      const ctx2 = ctx || {};
      const init = (node.init || []).map(tx).join(', ');
      const test = (node.test || []).length ? 'rt.truthy(' + tx(node.test[0]) + ')' : 'true';
      const incr = (node.increment || []).map(tx).join(', ');
      lines.push(indent + 'for (' + init + '; ' + test + '; ' + incr + ') {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx2);
      lines.push(indent + '}');
      break;
    }
    case 'foreach': {
      const tmp = '__e' + (walkStatement._n = (walkStatement._n || 0) + 1);
      lines.push(indent + 'for (const ' + tmp + ' of rt.entries(' + tx(node.source) + ')) {');
      if (node.key) lines.push(indent + '  ' + tx(node.key) + ' = ' + tmp + '[0];');
      lines.push(indent + '  ' + tx(node.value) + ' = ' + tmp + '[1];');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '}');
      break;
    }
    case 'switch': {
      const label = '__sw' + (walkStatement._sw = (walkStatement._sw || 0) + 1);
      const cases = childStatements(node.body);
      lines.push(indent + label + ': {');
      lines.push(indent + '  const ' + label + '_v = ' + tx(node.test) + ';');
      const realCases = cases.filter((c) => c.kind === 'case' && c.test);
      const defaults = cases.filter((c) => c.kind === 'case' && !c.test);
      lines.push(indent + '  let ' + label + '_run = false;');
      lines.push(indent + '  let ' + label + '_hit = false;');
      for (const c of realCases) {
        lines.push(indent + '  if (rt.looseEq(' + label + '_v, ' + tx(c.test) + ')) ' + label + '_hit = true;');
      }
      const inner = { ...(ctx || {}), breakLabel: label };
      for (const c of cases) {
        if (c.kind !== 'case') continue;
        const cond = c.test ? 'rt.looseEq(' + label + '_v, ' + tx(c.test) + ')' : ('!' + label + '_hit');
        lines.push(indent + '  if (' + label + '_run || ' + cond + ') {');
        lines.push(indent + '    ' + label + '_run = true;');
        walkChildren(childStatements(c.body), lines, indent + '    ', inner);
        lines.push(indent + '  }');
      }
      lines.push(indent + '}');
      break;
    }
    case 'break':
      if (ctx && ctx.breakLabel) lines.push(indent + 'break ' + ctx.breakLabel + ';');
      else lines.push(indent + 'break;');
      break;
    case 'continue':
      lines.push(indent + 'continue;');
      break;
    case 'return':
      lines.push(indent + 'return ' + (node.expr ? tx(node.expr) : '') + ';');
      break;
    case 'function': {
      const nm = fname(node.name && node.name.name ? node.name.name : node.name);
      const params = (node.arguments || []).map((p) => {
        const pn = vname(p.name && p.name.name ? p.name.name : p.name);
        return p.value ? pn + ' = ' + tx(p.value) : pn;
      });
      lines.push(indent + 'function ' + nm + '(' + params.join(', ') + ') {');
      walkChildren(childStatements(node.body), lines, indent + '  ', {});
      lines.push(indent + '}');
      break;
    }
    case 'nop':
      break;
    default:
      throw mkErr('LW002', 'unsupported construct: ' + node.kind, node.loc);
  }
}

// ---- pre-scan: collect user functions and variables ----
function collect(node, funcs, vars) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collect(n, funcs, vars); return; }
  if (node.kind === 'function' && node.name) {
    const nm = node.name.name || node.name;
    if (nm) funcs.add(String(nm));
  }
  if (node.kind === 'call' && node.what && node.what.kind === 'name' && node.what.name === 'compact') {
    // compact('post') reads $post — count it as a variable so it is declared/hoisted.
    for (const a of node.arguments || []) {
      if (a && a.kind === 'string') vars.add(vname(a.value));
    }
  }
  if (node.kind === 'closure' || node.kind === 'arrowfunc') {
    // do not hoist closure locals/params/uses to top-level; collect only variables outside closure scope
    // Still recurse into uses (they refer to outer vars, so collect them as outer vars if they are by-ref? Actually uses are outer vars)
    // For correctness, collect uses variables as outer vars, but not params or body locals
    const uses=node.uses||[];
    for(const u of uses){ if(u && u.kind==='variable' && u.name) vars.add(vname(u.name)); else if(u && u.what && u.what.name) vars.add(vname(u.what.name)); }
    // do not recurse into arguments or body (scoped)
    for(const k of Object.keys(node)){
      if(k==='loc'||k==='arguments'||k==='body'||k==='uses') continue;
      collect(node[k], funcs, vars);
    }
    return;
  }
  if (node.kind === 'variable' && node.name) vars.add(vname(node.name));
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    collect(node[k], funcs, vars);
  }
}

export function transpile(compiledSource) {
  let ast;
  try {
    ast = phpParser.parseCode(compiledSource);
  } catch (e) {
    return { code: null, errors: [{ code: 'LW004', message: 'parse error: ' + (e.message || e), line: 0, column: 0, hint: '' }] };
  }
  if (ast.errors && ast.errors.length) {
    const errors = ast.errors.map((er) => ({
      code: 'LW004',
      message: String(er.msg || er.message || er),
      line: er.loc?.start?.line ?? 0,
      column: er.loc?.start?.column ?? 0,
      hint: '',
    }));
    return { code: null, errors };
  }

  const funcs = new Set();
  const vars = new Set();
  collect(ast.children || [], funcs, vars);
  FUNCS = funcs;

  const lines = [];
  lines.push('export default function main(rt) {');
  if (vars.size) {
    lines.push('  let ' + Array.from(vars).join(', ') + ';');
    // Runtime view data injection: v_x = rt.var('x'). For static snapshots the rt has
    // no data → rt.var returns undefined → identical semantics to the pre-data era.
    for (const v of vars) {
      lines.push('  ' + v + ' = rt.var(' + JSON.stringify(String(v).replace(/^v_/, '')) + ');');
    }
  }
  try {
    walkChildren(ast.children || [], lines, '  ', {});
  } catch (e) {
    const lw = e.lw || { code: 'LW002', message: e.message, line: 0, column: 0, hint: '' };
    return { code: null, errors: [lw] };
  }
  lines.push('}');

  const code = lines.join('\n') + '\n';
  return { code, errors: [] };
}

// ---- controller method transpilation (used by compiler/src/controller.mjs) ----
// Returns { code, errors }; code is the JS body of an async request handler
// (no wrapper function — the caller generates the handler skeleton).
export function transpileControllerMethod(bodyChildren, opts = {}) {
  const funcs = new Set();
  const vars = new Set();
  collect(bodyChildren || [], funcs, vars);
  FUNCS = funcs;
  CTX = {
    models: opts.models || new Set(),
    views: opts.views || new Set(),
    controller: true,
    requestVars: opts.requestVars || new Set(),
  };
  CLOSURE_DEPTH = 0;
  const indent = opts.indent || '';
  const paramVars = opts.paramVars || new Set();
  const declared = Array.from(vars).filter((v) => !paramVars.has(v));
  const lines = [];
  if (declared.length) lines.push(indent + 'let ' + declared.join(', ') + ';');
  try {
    walkChildren(bodyChildren || [], lines, indent, {});
  } catch (e) {
    const lw = e.lw || { code: 'LW002', message: e.message, line: 0, column: 0, hint: '' };
    return { code: null, errors: [lw] };
  } finally {
    CTX = null;
    CLOSURE_DEPTH = 0;
  }
  return { code: lines.join('\n'), errors: [] };
}

export default transpile;
