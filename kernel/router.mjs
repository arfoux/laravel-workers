// edge/kernel/router.mjs — W3 router kernel (CONTRACT-w3.md)
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
  const parts = segs.map((seg) => {
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

function methodMatches(route, method) {
  const m = String(method || 'GET').toUpperCase();
  const methods = (route.methods || []).map((x) => String(x).toUpperCase());
  if (methods.indexOf(m) !== -1) return true;
  // HEAD answered by GET routes
  if (m === 'HEAD' && methods.indexOf('GET') !== -1) return true;
  return false;
}

export function match(table, req) {
  const method = (req && req.method) || 'GET';
  let path = (req && req.path) || '/';
  // strip query string
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  // normalize trailing slashes (except root)
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');

  const tbl = Array.isArray(table) ? table : (table && table.routes) || [];
  for (const route of tbl) {
    if (!methodMatches(route, method)) continue;
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
    return { route, params };
  }
  return null;
}

export async function dispatch(req, table, handlers, env) {
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
    request: { method: (req && req.method) || 'GET', path: (req && req.path) || '/', headers: (req && req.headers) || {} },
  };
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
