// kernel/packages/port-ctx.mjs — normalise the `ctx` a ROUTE PORT receives.
//
// The router hands a port (`kernel/router.mjs`, `dispatch`) a `ctx` whose
// `request` is the compiled kernel Request — its accessors are METHODS:
// `method()`, `pathInfo()`, `getQueryString()`, `header(name)`, `input()`,
// `query()`, `json()`, `host()`. It also adds `ctx.params` (route segments),
// `ctx.method` (the resolved verb as a string) and `ctx.db` (the binding).
//
// A port that reads `ctx.request.url`, `ctx.request.method`, `ctx.body` or
// `ctx.query` as PROPERTIES gets `undefined` and silently falls back to its own
// default — the bug the lw-showcase ports warn about by name. This helper
// rewrites the ctx INTO the shape a port expects (`request.method` a string,
// `request.url` a full URL string, `request.headers.get()`, `request.text()`,
// plus `ctx.query`/`ctx.body`/`ctx.params`), so the same port code is correct on
// the real kernel Request and on the plain object a unit test hand-builds.
//
// It is a no-op on the shape a test already passes (those fields are recomputed
// from the same inputs), so a named export a test calls directly stays green.
//
//   export default async function handle(ctx, env) {
//     ctx = normalizePortCtx(ctx);
//     ...
//   }
//
// `readPortContext(ctx)` is the same parse, returned as a flat view for ports
// that prefer destructuring.

function parse(ctx) {
  const req = (ctx && ctx.request) || {};
  const call = (name, ...args) => (typeof req[name] === 'function' ? req[name](...args) : undefined);
  // A fetch `Request` (what a unit test hand-builds) and the kernel Request both
  // expose `json()`, but only the kernel's is synchronous and side-effect-free:
  // reading a fetch Request's body consumes the stream, and calling `json()` on an
  // empty one rejects. Only the kernel shape is read for the body; a fetch
  // Request's body must come from `ctx.body` / `text()`. The RAW body is read
  // through `getContent()` (the kernel Request carries one since the webhook
  // verifiers were found to be HMACing a re-serialised copy — see `rawText`).
  const isFetchRequest = typeof Request === 'function' && req instanceof Request;

  const method = String(
    call('method') || (typeof req.method === 'string' ? req.method : '') || (ctx && ctx.method) || 'GET'
  ).toUpperCase();

  const raw = String(
    call('pathInfo') || (typeof req.url === 'string' ? req.url : '') || req.path || (ctx && ctx.url) || '/'
  );
  let path;
  let queryString;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const u = new URL(raw);
    path = u.pathname || '/';
    queryString = u.search.replace(/^\?/, '');
  } else {
    path = raw.split('?')[0] || '/';
    queryString = String(
      call('getQueryString') || (raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '')
    );
  }

  const host = (() => {
    const h = call('host');
    if (h) return String(h);
    if (typeof req.host === 'string' && req.host) return req.host;
    return 'port.local';
  })();
  const urlString = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  const url = new URL(urlString);

  const headerOf = (name) => {
    const v = call('header', name);
    if (v !== undefined && v !== null) return String(v);
    const h = req.headers;
    if (h && typeof h.get === 'function') {
      const g = h.get(name);
      return g === undefined || g === null ? null : String(g);
    }
    if (h && typeof h === 'object') {
      const g = h[name] !== undefined ? h[name] : h[String(name).toLowerCase()];
      return g === undefined || g === null ? null : String(g);
    }
    return null;
  };

  const query = (() => {
    if (ctx && ctx.query && typeof ctx.query === 'object') return ctx.query;
    const q = call('query');
    if (q && typeof q === 'object') return q;
    return Object.fromEntries(url.searchParams);
  })();

  const body =
    ctx && ctx.body !== undefined && ctx.body !== null
      ? ctx.body
      : isFetchRequest || typeof req.json !== 'function'
        ? {}
        : (() => {
            const j = call('json');
            return j === undefined || j === null ? {} : j;
          })();

  const rawText = async () => {
    if (isFetchRequest && typeof req.text === 'function') return String(await req.text());
    // The bytes as they arrived, in precedence order: the kernel Request's own
    // accessor (`getContent()`, Symfony parity, added because webhook verifiers
    // HMAC exactly these bytes), then any `text()` a test ctx hands over, then a
    // port's `text()`. Falling through to `json()` RE-SERIALISES the parsed body,
    // which is a different message to a provider's signature: a genuinely signed
    // Mollie/Stripe/… webhook was answered 401 on the kernel path until the
    // `getContent()` branch existed.
    const content = call('getContent');
    if (typeof content === 'string') return content;
    if (typeof req.getContent === 'string') return req.getContent;
    if (typeof req.text === 'function') return String(await req.text());
    const j = call('json');
    return j === undefined || j === null ? '' : JSON.stringify(j);
  };

  return { method, path, queryString, url, urlString, host, query, body, headerOf, rawText };
}

/** Rewrite `ctx` into the plain shape a port reads (`request.*` as data). */
export function normalizePortCtx(ctx = {}) {
  const p = parse(ctx);
  return {
    ...ctx,
    method: p.method,
    params: (ctx && ctx.params) || {},
    query: p.query,
    body: p.body,
    request: {
      method: p.method,
      url: p.urlString,
      path: p.path,
      pathInfo: () => p.path,
      getQueryString: () => p.queryString,
      host: () => p.host,
      headers: { get: (n) => p.headerOf(n) },
      header: (n) => p.headerOf(n),
      input: (k, d) => {
        const v = p.query[k] !== undefined ? p.query[k] : p.body && p.body[k];
        return v === undefined ? d : v;
      },
      json: () => p.body,
      text: () => p.rawText(),
    },
  };
}

/**
 * The identity a port may act on: the platform's own guard — `ctx.user()`, the
 * awaited accessor the Worker hands every port (`kernel/http.mjs`:
 * `user: () => auth.guard().user()`), or the `ctx.user` object a test passes —
 * or an id a `middlewarePorts` guard wrote onto `ctx` (`kernel/router.mjs`).
 *
 * A value a CALLER supplied (`ctx.body` / `ctx.query` / `ctx.params`) is never
 * read: at the edge that lets any caller pick the account it acts as (Laravel
 * takes the same ids from `$request->user()`, never the request body). Returns a
 * finite number, or `null` when the request carries no identity — the caller's
 * handlers must answer 401/403 on `null`, never fall back to a client value.
 */
export async function guardUserId(ctx = {}) {
  if (ctx.user_id != null && ctx.user_id !== '') {
    const injected = Number(ctx.user_id);
    if (Number.isFinite(injected)) return injected;
  }
  try {
    const u = typeof ctx.user === 'function' ? await ctx.user() : ctx.user;
    if (u && u.id != null) {
      const id = Number(u.id);
      if (Number.isFinite(id)) return id;
    }
  } catch {
    /* guard threw (unauthenticated) — treat as no identity */
  }
  return null;
}

/** The same parse as a flat view, for ports that prefer destructuring. */
export function readPortContext(ctx = {}) {
  const p = parse(ctx);
  return {
    method: p.method,
    path: p.path,
    queryString: p.queryString,
    url: p.url,
    query: p.query,
    body: p.body,
    params: (ctx && ctx.params) || {},
    headerOf: p.headerOf,
    hostOf: () => p.host,
    text: () => p.rawText(),
    request: ctx && ctx.request,
  };
}

/**
 * The JSON envelope a route port answers with: `content-type: application/json`
 * and `cache-control: no-store` (a port response is per-request state, never
 * cacheable). The rule lives here once — the same body was copied into every
 * port that answers JSON, and the copies drifted.
 */
export function jsonResponse(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

/**
 * The JSON error envelope a route port answers with: `jsonResponse` plus the
 * `{ ok: false, error }` body the PDF/image ports share. Same rule, once.
 */
export function jsonError(status, message) {
  return jsonResponse(status, { ok: false, error: message });
}

/**
 * The 401 a guard answers with when the caller is not authenticated. The body is
 * Laravel's own `AuthenticationException` message (`kernel/auth.mjs`), so a port
 * that answers through this cannot drift from the framework by a word — and the
 * status/headers are the shared JSON envelope, not a hand-rolled copy.
 */
export function unauthorized() {
  return jsonResponse(401, { message: 'Unauthenticated.' });
}
