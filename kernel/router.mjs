// kernel/router.mjs — Workers-native router
function normalizeUri(uri) {
  let u = uri == null ? '' : String(uri);
  if (u === '') u = '/';
  if (!u.startsWith('/')) u = '/' + u;
  return u;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function normalizeTable(routes) {
  if (!Array.isArray(routes)) throw new Error('route table must be an array');
  const out = [];
  for (const r of routes) {
    if (!r || typeof r !== 'object') throw new Error('invalid route entry');
    const uri = normalizeUri(r.uri);
    const methods = (r.methods || []).map((m) => String(m).toUpperCase());
    if (methods.length === 0) throw new Error('route has no methods: ' + uri);
    const name = r.name == null ? null : String(r.name);
    const domain = r.domain == null ? null : String(r.domain);
    const entry = { uri, name, methods, domain };
    if (r.bindings != null) entry.bindings = r.bindings;
    if (r.middleware != null) entry.middleware = r.middleware;
    // Laravel's `->where($param, $regex)` / whereNumber()/whereAlpha()/…
    // requirements: a per-variable regex that REPLACES the default `[^/]+`
    // class (`tools/routes-dump.mjs` reads the chain; `route:list --json` does
    // not carry them). `Route::fallback()` is exactly `{fallbackPlaceholder}`
    // + `where('fallbackPlaceholder', '.*')`, so the same mechanism is what
    // makes Laravel's fallback reach every unmatched path.
    if (r.wheres != null && typeof r.wheres === 'object' && Object.keys(r.wheres).length) entry.wheres = r.wheres;
    // registry.json → "middlewarePorts": the ports that run BEFORE this route's
    // handler (a `null` return continues, a response short-circuits).
    if (r.middlewarePorts != null) entry.middlewarePorts = r.middlewarePorts;

    // later registration wins for same uri+methods
    let replaced = false;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].uri === uri && arraysEqual(out[i].methods, methods)) {
        out[i] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) out.push(entry);
  }
  return out;
}

export function routeKey(route) {
  const methods = (route && route.methods) || [];
  const m = methods.length ? String(methods[0]).toUpperCase() : 'GET';
  return m + ' ' + normalizeUri(route && route.uri);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// PHP's preg_quote() without a delimiter argument: the characters PCRE treats as
// special (PHP >= 7.3 escapes '#' as well, delimiter or not). preg_quote('/') is
// '/' — Symfony's compiled path regexes keep the slash bare.
function pregQuote(s) {
  return String(s).replace(/[.\\+*?[^\]$(){}=!<>|:#-]/g, '\\$&');
}

// Symfony's RouteCompiler::SEPARATORS — the characters a path token can be
// split on. The DEFAULT separator of a path pattern is '/' ('.' for a host).
const SEPARATORS = '/,;.:-_~+*=@|';
const DEFAULT_SEPARATOR = '/';

// Symfony's placeholder token: '{name}' (and Symfony's '{!name}', an "important"
// variable Laravel never emits). `\w` cannot match '{' or '}', so a nested
// '{foo{bar}}' only matches the innermost variable — the same guarantee PHP's
// preg_match_all('#\{(!)?([\w\x80-\xFF]+)\}#') gives.
const PLACEHOLDER = /\{(!)?([\w\u0080-\uffff]+)\}/g;

// Symfony's RouteCompiler::findNextSeparator(): the next STATIC character after
// the variable, when that character is a separator ('/' or the punctuation set),
// else ''. All placeholders are removed first, so '/{a}{b}' finds none.
function findNextSeparator(rest) {
  const stripped = String(rest).replace(/\{[\w\u0080-\uffff]+\}/g, '');
  if (stripped === '') return '';
  const ch = stripped[0];
  return SEPARATORS.includes(ch) ? ch : '';
}

// Symfony's Route::sanitizeRequirement(), transcribed: a requirement anchored at
// either end LOSES that anchor (the surrounding pattern already anchors the whole
// path, and a `^`/`$` inside a named group fights it — probed through Symfony's
// own compiler: `where('id','^x$')` still matches `/c/x`). `\A`/`\z` are the same
// anchors spelled absolutely. A requirement that was nothing BUT anchors leaves
// no character behind, so it IS empty — which is where Symfony throws, and the
// app cannot boot at all.
function sanitizeRequirement(key, regex) {
  let r = String(regex);
  if (r !== '') {
    if (r[0] === '^') r = r.slice(1);
    else if (r.startsWith('\\A')) r = r.slice(2);
  }
  if (r.endsWith('$')) r = r.slice(0, -1);
  else if (r.indexOf('\\z') === r.length - 2) r = r.slice(0, -2);
  if (r === '') throw new Error(`routing requirement for "${key}" cannot be empty`);
  return r;
}

// Symfony's RouteCompiler::transformCapturingGroupsToNonCapturings(), applied
// to a requirement before it lands in the path regex. A `(` is rewritten to
// `(?:` unless the next char is `*` or `?` (a PCRE verb or an already
// non-capturing group), and an escaped `\(` is left alone. PHP does this so a
// requirement's own capture groups cannot shift the named captures of the
// path; JS named groups are addressed by NAME, but the rewrite also keeps the
// compiled pattern byte-comparable with PHP's, which is what the oracle
// compares.
function transformCapturingGroupsToNonCapturings(regexp) {
  let out = String(regexp);
  for (let i = 0; i < out.length; ++i) {
    if (out[i] === '\\') { ++i; continue; }
    if (out[i] !== '(' || i + 2 >= out.length) continue;
    ++i;
    if (out[i] === '*' || out[i] === '?') { ++i; continue; }
    out = out.slice(0, i) + '?:' + out.slice(i);
    ++i;
  }
  return out;
}

// Symfony's RouteCompiler::compilePattern() for a path pattern, transcribed:
// Laravel's Route::toSymfonyRoute() drops the '?' of every '{x?}' and hands the
// names over as defaults, so the optional run is decided HERE by the trailing
// token scan (a text token ends it) — '/a/{id?}/b' answers '/a/<id>/b' only.
//
// The regex body is returned unwrapped; the quantifier of a variable is the
// char class that forbids '/' and the separator that FOLLOWS it, so the class
// can never swallow the separator and generate the same URL back. A variable
// with a REQUIREMENT uses that requirement verbatim instead (Symfony's
// `$route->getRequirement($varName)` branch: no separator logic, no possessive
// marker) — which is what lets `.*` span segments.
function compilePatternBody(pattern, wheres) {
  const src = String(pattern);
  const optionalNames = new Set();
  for (const m of src.matchAll(/\{(\w+?)\?\}/g)) optionalNames.add(m[1]);
  const norm = src.replace(/\{(\w+?)\?\}/g, '{$1}');

  const tokens = [];
  const variables = [];
  PLACEHOLDER.lastIndex = 0;
  let pos = 0;
  let m;
  while ((m = PLACEHOLDER.exec(norm)) !== null) {
    const important = m[1] !== undefined;
    const name = m[2];
    const precedingText = norm.slice(pos, m.index);
    pos = m.index + m[0].length;

    const precedingChar = precedingText === '' ? '' : precedingText.slice(-1);
    const isSeparator = precedingChar !== '' && SEPARATORS.includes(precedingChar);

    if (variables.includes(name)) {
      // Symfony's RouteCompiler: LogicException at compile time — the app
      // cannot boot, so the edge fails loud instead of answering a wrong route.
      throw new Error(
        `Route pattern "${pattern}" cannot reference variable name "${name}" more than once.`
      );
    }
    if (isSeparator && precedingText !== precedingChar) {
      tokens.push({ text: precedingText.slice(0, -precedingChar.length) });
    } else if (!isSeparator && precedingText !== '') {
      tokens.push({ text: precedingText });
    }

    const following = norm.slice(pos);
    const nextSeparator = findNextSeparator(following);
    // Symfony: `$regexp = $route->getRequirement($varName)` — a requirement
    // REPLACES the default class entirely, and the separator/possessive logic
    // is skipped. An empty-string requirement is still a requirement (`where`
    // stores the expression as given), and a name missing from the map (an
    // unused `->where('other', ...)`, which PHP stores and ignores) falls back
    // to the class.
    const requirement =
      wheres && Object.prototype.hasOwnProperty.call(wheres, name) && wheres[name] != null
        ? transformCapturingGroupsToNonCapturings(sanitizeRequirement(name, wheres[name]))
        : null;
    let rx =
      '[^' +
      pregQuote(DEFAULT_SEPARATOR) +
      (DEFAULT_SEPARATOR !== nextSeparator && nextSeparator !== '' ? pregQuote(nextSeparator) : '') +
      ']+';
    if (requirement !== null) rx = requirement;
    // Symfony appends a POSSESSIVE quantifier when a real separator follows and
    // the next token is not an adjacent variable: the class already forbids that
    // separator, so the backtracking it prevents can never succeed. JS has no
    // possessive quantifiers; dropping the marker keeps the same matches.
    tokens.push({ name, sep: isSeparator ? precedingChar : '', rx, important });
    variables.push(name);
  }
  if (pos < norm.length) tokens.push({ text: norm.slice(pos) });

  // Symfony's first-optional scan: walking BACK from the last token, a variable
  // is optional while it has a default (Laravel: every '{x?}' name) and is not
  // "important"; anything else (a text token, a required variable) ends the run.
  let firstOptional = Number.MAX_SAFE_INTEGER;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.name !== undefined && !t.important && optionalNames.has(t.name)) firstOptional = i;
    else break;
  }

  let body = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.name === undefined) {
      body += pregQuote(t.text);
      continue;
    }
    if (i === 0 && firstOptional === 0) {
      // "When the only token is an optional variable token, the separator is
      // required" — '/{id?}' must still answer '/' + a value.
      body += pregQuote(t.sep) + '(?<' + t.name + '>' + t.rx + ')?';
      continue;
    }
    let part = pregQuote(t.sep) + '(?<' + t.name + '>' + t.rx + ')';
    if (i >= firstOptional) {
      part = '(?:' + part;
      if (i === tokens.length - 1) {
        part += ')?'.repeat(tokens.length - firstOptional - (firstOptional === 0 ? 1 : 0));
      }
    }
    body += part;
  }
  return body;
}

// A compiled uri regex is registered once and matched on every request, so the
// compilation is memoized: by uri string when the route carries no requirement,
// and by (requirements object → uri) otherwise. The requirements object is the
// table's own, so the WeakMap hits from the second request on.
const uriRegexCache = new Map();
const constrainedRegexCache = new WeakMap();

// `route` is a table entry (uri + optional wheres) or a bare uri string.
export function uriToRegex(route) {
  const isEntry = route != null && typeof route === 'object';
  const norm = normalizeUri(isEntry ? route.uri : route);
  const wheres = isEntry ? route.wheres : null;
  const hasWheres = wheres != null && typeof wheres === 'object' && Object.keys(wheres).length > 0;

  let cache = uriRegexCache;
  if (hasWheres) {
    cache = constrainedRegexCache.get(wheres);
    if (cache === undefined) {
      cache = new Map();
      constrainedRegexCache.set(wheres, cache);
    }
  }
  const cached = cache.get(norm);
  if (cached !== undefined) return cached;

  // PHP compiles the path with the `s` (PCRE_DOTALL) and `D` flags: `s` is what
  // lets a `.*` requirement reach across a newline (a decoded `%0A` is a real
  // path byte), and `D` already matches JS's `$` (neither matches just before a
  // trailing newline). A `{name*}` segment is NOT a wildcard anywhere: Symfony
  // compiles it as literal text, and PHP's router does exactly the same — a
  // catch-all is `->where('name', '.*')` (what `Route::fallback()` itself
  // uses), which is why leaving it out of the tokenizer is the parity-correct
  // behaviour rather than a missing feature.
  //
  // PHP compiles EVERY path with PCRE's `u` modifier, so `\p{...}` there is a
  // unicode property. JS reads `\p` as the LITERAL character `p` without the
  // `u` flag — measured: `->where('name', '\p{L}+')` matched nothing (the text
  // `p{L}`) and answered the fallback where PHP answered the route, for
  // `/letters/abc` and `/letters/é` alike (shadow harness, fb5). `u` is added
  // only when the pattern actually asks for it, so every other requirement
  // keeps the code-unit reading that PHP's `[^/]++`/literals agree with.
  const body = compilePatternBody(norm, hasWheres ? wheres : null);
  const bodyFlags = /\\[pP]\{/.test(body) ? 'su' : 's';
  const rx = new RegExp('^' + body + '/?$', bodyFlags);
  cache.set(norm, rx);
  return rx;
}

/**
 * Compile every entry's URI regex NOW, so a requirement the JS RegExp engine
 * cannot take (or a pattern Symfony itself would reject) fails the BUILD with
 * the route named, instead of throwing inside every request that reaches it.
 * Called by build.mjs on the finished route table.
 */
export function validateTable(routes) {
  const list = Array.isArray(routes) ? routes : (routes && routes.routes) || [];
  for (const r of list) {
    try {
      const wheres = r && typeof r === 'object' ? r.wheres : null;
      if (wheres != null && typeof wheres === 'object') {
        // Only a requirement for a variable the URI actually carries reaches
        // the pattern: Symfony compiles nothing for one naming an unused
        // variable (PHP stores it and ignores it), so refusing that one would
        // fail a build PHP boots happily.
        const used = new Set();
        for (const m of String(r.uri).replace(/\{(\w+?)\?\}/g, '{$1}').matchAll(PLACEHOLDER)) used.add(m[2]);
        for (const key of Object.keys(wheres)) {
          if (used.has(key)) assertRequirementTranslatable(key, wheres[key]);
        }
      }
      uriToRegex(r);
    } catch (e) {
      const uri = r && typeof r === 'object' ? r.uri : r;
      throw new Error('route "' + uri + '": ' + (e && e.message ? e.message : String(e)));
    }
  }
}

// PCRE constructs Laravel accepts AND the JS engine accepts — but reads as
// something else, so the pattern compiles and then matches a DIFFERENT path:
// the silent-wrong answer this build exists to prevent (a construct JS itself
// rejects needs no list — `new RegExp` throws, and the build stops on it).
// The check runs on the SANITIZED expression, so a leading `\A` / trailing `\z`
// (which `sanitizeRequirement()` has already stripped, matching Symfony) is not
// a misread, while one in the middle of the expression is.
// Measured through PCRE (PHP 8.3 `preg_match`) and the shadow harness:
// `->where('w', '\h+')` matches a tab in PHP and nothing in the kernel.
const MISREAD_REQUIREMENTS = [
  { re: /\\[hH]/, pcre: '\\h / \\H (horizontal whitespace)', js: "the literal character 'h'" },
  { re: /\\[vV]/, pcre: '\\v / \\V (vertical whitespace)', js: "a vertical tab / the literal 'v'" },
  { re: /\\R/, pcre: '\\R (any newline sequence)', js: "the literal character 'R'" },
  { re: /\\X/, pcre: '\\X (an extended grapheme cluster)', js: "the literal character 'X'" },
  { re: /\\Q/, pcre: '\\Q...\\E (quote the metacharacters)', js: "the literal character 'Q'" },
  { re: /\\K/, pcre: '\\K (reset the match start)', js: "the literal character 'K'" },
  { re: /\\[ZG]/, pcre: '\\Z / \\G (an end-of-subject / continue anchor)', js: "the literal character 'Z'/'G'" },
  { re: /\\[Az]/, pcre: '\\A / \\z (an absolute anchor) inside the expression', js: "the literal character 'A'/'z'" },
  {
    re: /\[[^\]]*\[:[a-z]+:\]/,
    pcre: 'a POSIX class ([:alpha:], [:digit:], ...)',
    js: 'the literal characters of the class name',
  },
];

function assertRequirementTranslatable(key, expression) {
  const sanitized = sanitizeRequirement(key, expression);
  for (const { re, pcre, js } of MISREAD_REQUIREMENTS) {
    if (re.test(sanitized)) {
      throw new Error(
        `the requirement for "${key}" uses ${pcre}, which this engine reads as ${js} — ` +
          'the pattern would compile and match a different path, so the build stops instead. ' +
          'Rewrite it with the JavaScript-compatible form (e.g. `[\\t ]` for `\\h`)'
      );
    }
  }
  return sanitized;
}

function domainToRegex(domain) {
  const parts = String(domain).split('.').map((seg) => {
    const m = seg.match(/^\{(\w+)\}$/);
    if (m) return '(?<' + m[1] + '>[^.]+)';
    if (seg === '*') return '[^.]+';
    return escapeRegex(seg);
  });
  return new RegExp('^' + parts.join('\\.') + '$', 'i');
}

function hostMatches(route, host) {
  if (!route.domain) return true;
  if (!host) return false;
  const h = String(host).split(':')[0];
  return domainToRegex(route.domain).test(h);
}

// PHP's rawurldecode(): the percent escapes are decoded, an invalid escape
// is left alone.
function rawurldecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try { return decodeURIComponent(m); } catch { return m; }
    });
  }
}

// The path the route matches: the query string is out, the trailing slashes
// are trimmed and the escapes are decoded — Laravel's UriValidator does
// rtrim() first and rawurldecode() second.
function requestPath(req) {
  let path = (req && req.path) || '/';
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  // UriValidator: `rtrim($request->getPathInfo(), '/') ?: '/'` — every trailing
  // slash is dropped, and a path of slashes only (or none at all) is '/'.
  const trimmed = path.replace(/\/+$/, '');
  path = trimmed === '' ? '/' : trimmed;
  return rawurldecode(path);
}

function resolveMethod(req) {
  let method = String((req && req.method) || 'GET').toUpperCase();
  if (req && req.methodOverride) return String(req.methodOverride).toUpperCase();
  const headers = (req && req.headers) || {};
  // Laravel's form spoofing, via header equivalent; only POST may be overridden.
  const override = headers['x-http-method-override'] || headers['X-HTTP-Method-Override'];
  if (override && method === 'POST') return String(override).toUpperCase();
  return method;
}

function methodMatches(route, method) {
  const m = String(method || 'GET').toUpperCase();
  const methods = (route.methods || []).map((x) => String(x).toUpperCase());
  if (methods.indexOf(m) !== -1) return true;
  // HEAD answered by GET routes
  if (m === 'HEAD' && methods.indexOf('GET') !== -1) return true;
  return false;
}

export function match(table, req) {
  const method = resolveMethod(req);
  const path = requestPath(req);

  const host = req && (req.host || req.hostname);
  const tbl = Array.isArray(table) ? table : (table && table.routes) || [];
  for (const route of tbl) {
    if (!methodMatches(route, method)) continue;
    if (!hostMatches(route, host)) continue;
    const rx = uriToRegex(route);
    const m = rx.exec(path);
    if (!m) continue;
    const params = {};
    if (m.groups) {
      for (const k of Object.keys(m.groups)) {
        // The path was decoded before it matched, so the capture is decoded.
        // Laravel's Route::parametersWithoutNulls() drops a NULL and an EMPTY
        // capture alike (probed: the fallback route matching '/' answers no
        // parameters at all), and a `.*` requirement is the one shape that can
        // match the empty remainder — so the edge must drop it too, or a
        // controller would receive an argument Laravel never passes.
        if (m.groups[k] != null && m.groups[k] !== '') params[k] = m.groups[k];
      }
    }
    if (route.domain && host) {
      const dm = domainToRegex(route.domain).exec(String(host).split(':')[0]);
      if (dm && dm.groups) for (const k of Object.keys(dm.groups)) params[k] = dm.groups[k];
    }
    return { route, params };
  }
  return null;
}

// The methods the URI accepts (Laravel's AbstractRouteCollection): the verbs
// (Router::$verbs, in Laravel's order) that have a route matching the URI —
// the method itself is left out. Laravel's router answers 405 (or the
// automatic OPTIONS response) when the URI matches a route but the method does
// not; the Allow header lists these verbs.
const ROUTER_VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY'];

export function allowedMethods(table, req) {
  const method = resolveMethod(req);
  const path = requestPath(req);
  const host = req && (req.host || req.hostname);
  const tbl = Array.isArray(table) ? table : (table && table.routes) || [];
  const verbs = [];
  for (const verb of ROUTER_VERBS) {
    if (verb === method) continue;
    let found = false;
    for (const route of tbl) {
      const methods = (route.methods || []).map((m) => String(m).toUpperCase());
      if (methods.indexOf(verb) === -1) continue;
      if (!hostMatches(route, host)) continue;
      let rx;
      try {
        rx = uriToRegex(route);
      } catch {
        continue;
      }
      if (rx.test(path)) {
        found = true;
        break;
      }
    }
    if (found) verbs.push(verb);
  }
  return verbs;
}

export async function dispatch(req, table, handlers, env, options = {}) {
  const m = match(table, req);
  if (!m) return null;

  const key = routeKey(m.route);
  const handler = resolveHandler(handlers, key);
  if (typeof handler !== 'function') return null;

  // `method` and `db` are additive and exist for the ROUTE PORTS (an
  // app-authored handler in ports/<slug>.mjs). A compiled controller reads the
  // verb through `ctx.request.method()` (a function on the kernel request) and
  // the binding through `env.DB`, neither of which a hand-written port can
  // reach without re-deriving them: `ctx.request.method` would hand a port the
  // FUNCTION, so `ctx.method` carries the resolved string. `ctx.db` is the same
  // binding the compiled rung already uses for route-model binding.
  const ctx = {
    params: m.params,
    method: resolveMethod(req),
    db: (options && options.db) || null,
    request: options.ctxRequest ?? {
      method: resolveMethod(req),
      path: (req && req.path) || '/',
      headers: (req && req.headers) || {},
      host: (req && (req.host || req.hostname)) || null,
    },
  };
  Object.assign(ctx, options.ctxExtra || {});
  const bindings = m.route && m.route.bindings;
  if (bindings && options && options.models) {
    ctx.models = {};
    for (const name of Object.keys(bindings)) {
      const b = bindings[name];
      const modelName = b == null ? b : (b.model ?? b);
      const Model = options.models[modelName];
      if (!Model) {
        const err = new Error('unknown model: ' + String(modelName));
        err.status = 500;
        throw err;
      }
      const column = (b == null) ? 'id' : (b.column || 'id');
      const instance = await Model.query(options.db).where(column, ctx.params[name]).first();
      if (!instance) {
        const err = new Error('not found: ' + String(name));
        err.status = 404;
        throw err;
      }
      ctx.models[name] = instance;
    }
  }
  const res = await runRoute(ctx, m.route, handler, handlers, env);
  const headers = {};
  if (res.headers && typeof res.headers === 'object') {
    for (const k of Object.keys(res.headers)) headers[String(k).toLowerCase()] = res.headers[k];
  }
  return { status: res.status, headers, body: res.body };
}

/** The handler registered under `key` in a handlers map or plain object. */
function resolveHandler(handlers, key) {
  if (!handlers) return null;
  if (typeof handlers.get === 'function') return handlers.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(handlers, key) ? handlers[key] : null;
}

// The body is a string (every rendered body), OR the raw bytes (a request body
// and the storage adapter's payload are Uint8Array, so a handler that answers
// one must be able to pass through), OR a ReadableStream (an SSE / streaming
// port). `new Response(body)` (the worker's toResponse) accepts all three; a
// Buffer/ArrayBuffer is rejected loudly.
function assertResponseShape(res) {
  if (
    !res ||
    typeof res.status !== 'number' ||
    !(
      typeof res.body === 'string' ||
      res.body instanceof Uint8Array ||
      res.body instanceof ReadableStream ||
      res.body === null ||
      res.body === undefined
    )
  ) {
    throw new Error('handler returned invalid response shape');
  }
  return res;
}

/**
 * Run the route's `middlewarePorts` (registry.json → "middlewarePorts") before
 * its handler, then the handler itself.
 *
 * A middleware port is a route port that may DECLINE to answer: returning
 * `null`/`undefined` continues the chain (so a URL-locale or response-cache port
 * can set state on `ctx` and let the route's own handler render), while a
 * response short-circuits it (a `302` redirect, a cache hit). The ports share
 * ONE `ctx` with the handler, so `ctx.locale = 'es'` in a middleware port is
 * visible to the compiled controller behind it.
 */
async function runRoute(ctx, route, handler, handlers, env) {
  const middlewarePorts = (route && route.middlewarePorts) || [];
  for (const slug of middlewarePorts) {
    const port = resolveHandler(handlers, 'MW ' + slug);
    if (typeof port !== 'function') {
      const err = new Error('unknown middleware port: ' + String(slug));
      err.status = 500;
      throw err;
    }
    const portRes = await port(ctx, env);
    // `null`/`undefined` = "not mine, continue" — anything else is the response.
    if (portRes !== null && portRes !== undefined) return assertResponseShape(portRes);
  }
  // A middleware port that resolved a locale (`ctx.locale` — the URL-locale
  // middleware) makes it THIS request's `app.locale`, so `__()` / `app()->getLocale()`
  // in the handler behind it translate in that locale. Laravel's App::setLocale()
  // is per request: the handler gets a SHALLOW COPY with the key overridden, never
  // the shared dump one isolate reuses for every request.
  if (ctx.locale !== null && ctx.locale !== undefined && ctx.config && typeof ctx.config === 'object') {
    const locale = String(ctx.locale);
    if (ctx.config['app.locale'] !== locale) ctx.config = { ...ctx.config, 'app.locale': locale };
  }
  return assertResponseShape(await handler(ctx, env));
}

export default { normalizeTable, routeKey, match, allowedMethods, dispatch };
