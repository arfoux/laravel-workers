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

// Symfony's RouteCompiler::compilePattern() for a path pattern, transcribed:
// Laravel's Route::toSymfonyRoute() drops the '?' of every '{x?}' and hands the
// names over as defaults, so the optional run is decided HERE by the trailing
// token scan (a text token ends it) — '/a/{id?}/b' answers '/a/<id>/b' only.
//
// The regex body is returned unwrapped; the quantifier of a variable is the
// char class that forbids '/' and the separator that FOLLOWS it, so the class
// can never swallow the separator and generate the same URL back.
function compilePatternBody(pattern) {
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
    let rx =
      '[^' +
      pregQuote(DEFAULT_SEPARATOR) +
      (DEFAULT_SEPARATOR !== nextSeparator && nextSeparator !== '' ? pregQuote(nextSeparator) : '') +
      ']+';
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
// compilation is memoized per uri string (pure input, pure output).
const uriRegexCache = new Map();

function uriToRegex(uri) {
  const norm = normalizeUri(uri);
  const cached = uriRegexCache.get(norm);
  if (cached !== undefined) return cached;

  const segs = norm.split('/');
  // Laravel's catch-all is `{segment*}` as the WHOLE last segment — an extension
  // of this router (Symfony compiles '{p*}' as literal text, Laravel's
  // Route::toSymfonyRoute() passes it through). Anywhere else it is not a
  // wildcard at all: PHP then matches the literal text, and so does the
  // tokenizer below.
  for (let i = 0; i < segs.length; i++) {
    if (/^\{\w+\*\}$/.test(segs[i]) && i !== segs.length - 1) {
      throw new Error('wildcard {param*} must be the last segment: ' + norm);
    }
  }
  const wild = /^(.*)\/\{(\w+)\*\}$/.exec(norm);
  const rx = wild
    ? new RegExp(
        '^' + compilePatternBody(wild[1]) + '/(?<' + wild[2] + '>.+)' + '/?$'
      )
    : new RegExp('^' + compilePatternBody(norm) + '/?$');
  uriRegexCache.set(norm, rx);
  return rx;
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
    const rx = uriToRegex(route.uri);
    const m = rx.exec(path);
    if (!m) continue;
    const params = {};
    if (m.groups) {
      for (const k of Object.keys(m.groups)) {
        // The path was decoded before it matched, so the capture is decoded.
        if (m.groups[k] != null) params[k] = m.groups[k];
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
        rx = uriToRegex(route.uri);
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
