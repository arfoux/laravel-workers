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

function uriToRegex(uri) {
  const norm = normalizeUri(uri);
  const segs = norm.split('/');
  // handle root: '' segments
  const parts = segs.map((seg, i) => {
    const wild = seg.match(/^\{(\w+)\*\}$/);
    if (wild) {
      if (i !== segs.length - 1) {
        throw new Error('wildcard {param*} must be the last segment: ' + norm);
      }
      return '(?<' + wild[1] + '>.+)';
    }
    const m = seg.match(/^\{(\w+)\??\}$/);
    if (m) {
      const name = m[1];
      const optional = seg.endsWith('?}');
      return optional ? '(?<' + name + '>[^/]*)?' : '(?<' + name + '>[^/]+)';
    }
    return escapeRegex(seg);
  });
  const pattern = parts.join('/');
  return new RegExp('^' + pattern + '/?$');
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
  let path = (req && req.path) || '/';
  // strip query string
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  // normalize trailing slashes (except root)
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');

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
        if (m.groups[k] != null) {
          try { params[k] = decodeURIComponent(m.groups[k]); }
          catch (e) { params[k] = m.groups[k]; }
        }
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

export async function dispatch(req, table, handlers, env, options = {}) {
  const m = match(table, req);
  if (!m) return null;

  const key = routeKey(m.route);
  let handler = null;
  if (handlers) {
    if (typeof handlers.get === 'function') handler = handlers.get(key);
    else if (Object.prototype.hasOwnProperty.call(handlers, key)) handler = handlers[key];
  }
  if (typeof handler !== 'function') return null;

  const ctx = {
    params: m.params,
    request: { method: resolveMethod(req), path: (req && req.path) || '/', headers: (req && req.headers) || {} },
  };
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
  const res = await handler(ctx, env);
  if (!res || typeof res.status !== 'number' || typeof res.body !== 'string') {
    throw new Error('handler returned invalid response shape');
  }
  const headers = {};
  if (res.headers && typeof res.headers === 'object') {
    for (const k of Object.keys(res.headers)) headers[String(k).toLowerCase()] = res.headers[k];
  }
  return { status: res.status, headers, body: res.body };
}

export default { normalizeTable, routeKey, match, dispatch };
