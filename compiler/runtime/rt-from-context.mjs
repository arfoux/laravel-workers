// compiler/runtime/rt-from-context.mjs — Runtime helpers (context → rt)
export function buildRt(context, opts = {}) {
  const strict = !!(opts && opts.strict);
  const ctx = context || {};
  const warnings = [];

  const rt = { __warnings: warnings, __strict: strict, __output: '' };

  // ---- helpers for legacy/enriched compat ----
  const has = (k) => Object.prototype.hasOwnProperty.call(ctx, k) && ctx[k] != null;

  // app
  let appCtx = has('app') ? ctx.app : null;
  if (!appCtx && has('app_version')) {
    appCtx = { version: ctx.app_version, locale: 'en' };
    warnings.push('app: derived from app_version (legacy shape)');
  }
  if (!appCtx) {
    appCtx = { version: '', locale: 'en' };
    warnings.push('app: missing, using empty fallback');
  }

  // files / vfs
  let filesCtx = has('files') ? ctx.files : null;
  if (!filesCtx && has('vfs')) {
    filesCtx = ctx.vfs;
    warnings.push('files: derived from vfs (legacy shape)');
  }
  if (!filesCtx) {
    filesCtx = {};
    warnings.push('files: missing, using empty fallback');
  }

  // vite
  let viteCtx = has('vite') ? ctx.vite : null;
  if (!viteCtx) {
    viteCtx = { fonts: '', invoke: '' };
    warnings.push('vite: missing, fonts/invoke default to empty');
  }

  // auth
  let authCtx = has('auth') ? ctx.auth : null;
  if (!authCtx) {
    authCtx = { check: false };
    warnings.push('auth: missing, check defaults to false');
  }

  // urls
  let urlsCtx = has('urls') ? ctx.urls : null;
  if (!urlsCtx) {
    urlsCtx = {};
    warnings.push('urls: missing, url()/route() will throw when called');
  }

  // route_names
  let routeNames = has('route_names') ? ctx.route_names : null;
  if (!routeNames && Array.isArray(ctx.routes)) {
    routeNames = ctx.routes.map((r) => r && r.name).filter((n) => n != null);
    warnings.push('route_names: derived from routes (legacy shape)');
  }
  if (!Array.isArray(routeNames)) {
    routeNames = [];
    warnings.push('route_names: missing, using empty');
  }

  // config
  const configCtx = has('config') ? ctx.config : {};

  // ---- phpNumStr (PHP-style float formatting) ----
  const phpNumStr = (v) => {
    if (Number.isInteger(v)) return String(v);
    const s = v.toPrecision(14);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };

  // ---- rt.echo (PHP echo semantics) ----
  rt.echo = (v) => {
    let s;
    if (v === null || v === undefined) s = '';
    else if (v === true) s = '1';
    else if (v === false) s = '';
    else if (typeof v === 'number') s = phpNumStr(v);
    else s = String(v);
    rt.__output += s;
    return s;
  };

  // ---- rt.e (htmlspecialchars) ----
  rt.e = (v) => {
    let s;
    if (v === null || v === undefined) s = '';
    else if (v === true) s = '1';
    else if (v === false) s = '';
    else if (typeof v === 'number') s = phpNumStr(v);
    else if (Array.isArray(v)) s = 'Array';
    else if (typeof v === 'object') s = 'Object';
    else s = String(v);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ---- rt.str_replace ----
  rt.str_replace = (a, b, s) => {
    const needle = String(a);
    const subject = String(s);
    if (needle === '') return subject;
    return subject.split(needle).join(String(b));
  };

  // ---- rt.add (PHP arithmetic +) ----
  const phpToNum = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    const n = Number(String(v).trim());
    return isNaN(n) ? 0 : n;
  };
  rt.add = (a, b) => phpToNum(a) + phpToNum(b);

  // ---- rt.concat (PHP string cast + concat) ----
  const phpToStr = (v) => {
    if (v === null || v === undefined) return '';
    if (v === true) return '1';
    if (v === false) return '';
    if (typeof v === 'number') return phpNumStr(v);
    if (Array.isArray(v)) return 'Array';
    if (typeof v === 'object') return 'Object';
    return String(v);
  };
  rt.concat = (a, b) => phpToStr(a) + phpToStr(b);

  // ---- rt.config ----
  rt.config = (k, d) => {
    if (Object.prototype.hasOwnProperty.call(configCtx, k)) return configCtx[k];
    if (arguments.length >= 2) return d;
    throw new Error('config: missing key ' + JSON.stringify(k) + ' with no default');
  };

  // ---- rt.app ----
  rt.app = (name) => {
    if (name === undefined) {
      return {
        version: () => appCtx.version,
        getLocale: () => appCtx.locale,
      };
    }
    const key = String(name);
    if (key.indexOf('Illuminate\\Foundation\\Vite') !== -1 || key.indexOf('Illuminate/Foundation/Vite') !== -1) {
      const invoke = viteCtx.invoke;
      const fonts = viteCtx.fonts;
      const shim = (entries) => invoke;
      shim.fonts = () => fonts;
      return shim;
    }
    throw new Error('app: unsupported service ' + JSON.stringify(name));
  };

  // ---- rt.public_path ----
  rt.public_path = (p) => p;

  // ---- rt.file_exists ----
  rt.file_exists = (p) => {
    const key = String(p);
    if (Object.prototype.hasOwnProperty.call(filesCtx, key)) return !!filesCtx[key];
    throw new Error('file_exists: unknown path ' + JSON.stringify(key));
  };

  // ---- rt.Route ----
  rt.Route = { has: (n) => routeNames.indexOf(n) !== -1 };

  // ---- rt.auth ----
  rt.auth = () => ({
    guard: () => ({
      check: () => !!authCtx.check,
    }),
  });

  // ---- rt.url / rt.route ----
  const lookupUrl = (key) => {
    if (!Object.prototype.hasOwnProperty.call(urlsCtx, key)) {
      throw new Error('url/route: uncaptured ' + JSON.stringify(key));
    }
    const v = urlsCtx[key];
    if (v && typeof v === 'object' && v.error) throw new Error('url/route: ' + v.error);
    return v;
  };
  rt.url = (p) => lookupUrl(String(p));
  rt.route = (n, ...rest) => {
    if (rest.length > 0) throw new Error('route: uncaptured extra args');
    return lookupUrl(String(n));
  };

  // ---- builtins (flat on rt) ----
  rt.isset = (...args) => {
    // isset(var) — for our purposes, check args defined & not null
    if (args.length === 0) return false;
    for (const a of args) if (a === undefined || a === null) return false;
    return true;
  };
  rt.empty = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === 'boolean') return v === false;
    if (typeof v === 'number') return v === 0;
    if (typeof v === 'string') return v === '' || v === '0';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  };
  rt.unset = () => {}; // no-op in emitted code (variables are lets; M1 has none)
  rt.count = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0));
  rt.in_array = (needle, haystack, strict) => {
    const arr = Array.isArray(haystack) ? haystack : [];
    if (strict) return arr.some((x) => x === needle && typeof x === typeof needle);
    return arr.some((x) => x == needle); // eslint-disable-line eqeqeq
  };
  rt.implode = (glue, arr) => (Array.isArray(arr) ? arr.join(glue == null ? '' : String(glue)) : '');
  rt.explode = (delim, str, limit) => String(str).split(String(delim));
  rt.sprintf = (fmt, ...args) => {
    let i = 0;
    // collapse %% -> % first (PHP: literal percent)
    const withPlaceholders = String(fmt).replace(/%%/g, '\u0000');
    const out = withPlaceholders.replace(/%[sdu]/g, (m) => {
      const a = args[i++];
      if (m === '%d' || m === '%u') return String(parseInt(a, 10));
      return String(a == null ? '' : a);
    });
    return out.replace(/\u0000/g, '%');
  };
  rt.strtolower = (s) => String(s).toLowerCase();
  rt.strtoupper = (s) => String(s).toUpperCase();
  rt.trim = (s) => String(s).trim();

  return rt;
}
export default buildRt;
