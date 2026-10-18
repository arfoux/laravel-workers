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
  const isObj = (v) => v !== null && typeof v === 'object';
  const arrValues = (v) => (Array.isArray(v) ? v.slice() : (isObj(v) ? Object.keys(v).map((k) => v[k]) : []));
  rt.implode = (glue, arr) => arrValues(arr).map((x) => (x == null ? '' : String(x))).join(glue == null ? '' : String(glue));
  rt.explode = (delim, str, limit) => String(str).split(String(delim));
  rt.array_key_exists = (k, arr) => (isObj(arr) ? Object.prototype.hasOwnProperty.call(arr, k) : false);
  rt.array_keys = (arr) => (isObj(arr) ? Object.keys(arr).map((k) => (/^\d+$/.test(k) ? Number(k) : k)) : []);
  rt.array_values = (arr) => arrValues(arr);
  rt.array_merge = (...arrs) => {
    if (arrs.every((a) => Array.isArray(a))) {
      const out = [];
      for (const a of arrs) for (const v of a) out.push(v);
      return out;
    }
    const out = {};
    for (const a of arrs) if (isObj(a)) for (const k of Object.keys(a)) out[k] = a[k];
    return out;
  };
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

  // ---- byte-oriented string helpers (PHP length semantics) ----
  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder();
  const byteLen = (s) => utf8.encode(String(s)).length;
  rt.strlen = (s) => (s == null ? 0 : byteLen(s));
  rt.substr = (s, start, len) => {
    const bytes = utf8.encode(s == null ? '' : String(s));
    const n = bytes.length;
    let st = Number(start) | 0;
    if (st < 0) st = Math.max(n + st, 0);
    if (st > n) st = n;
    let end = n;
    if (len !== undefined && len !== null) {
      const l = Number(len) | 0;
      end = l < 0 ? n + l : st + l;
    }
    if (end < st) end = st;
    if (end > n) end = n;
    return utf8d.decode(bytes.slice(st, end));
  };
  rt.str_repeat = (s, n) => String(s == null ? '' : s).repeat(Math.max(0, Number(n) | 0));
  rt.str_contains = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().includes(needle.toLowerCase());
    return hay.includes(needle);
  };
  rt.str_starts_with = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().startsWith(needle.toLowerCase());
    return hay.startsWith(needle);
  };
  rt.str_ends_with = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().endsWith(needle.toLowerCase());
    return hay.endsWith(needle);
  };
  rt.str_is = (pattern, value) => {
    const p = String(pattern == null ? '' : pattern);
    const v = String(value == null ? '' : value);
    // Laravel Str::is: * wildcard, case-sensitive, full-string match
    // Escape regex specials except *, then * -> .*
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(v);
  };
  rt.ucfirst = (s) => {
    const x = String(s == null ? '' : s);
    return x === '' ? '' : x[0].toUpperCase() + x.slice(1);
  };
  rt.lcfirst = (s) => {
    const x = String(s == null ? '' : s);
    return x === '' ? '' : x[0].toLowerCase() + x.slice(1);
  };
  rt.str_pad = (s, len, pad, type) => {
    const x = String(s == null ? '' : s);
    const target = Math.max(0, Number(len) | 0);
    const cur = byteLen(x);
    if (cur >= target) return x;
    let p = pad === undefined || pad === null || pad === '' ? ' ' : String(pad);
    const need = target - cur;
    const fill = (count) => p.repeat(Math.ceil(count / p.length)).slice(0, count);
    const t = type === undefined ? 1 : Number(type);
    if (t === 0) return fill(need) + x; // STR_PAD_LEFT
    if (t === 2) {
      const left = Math.floor(need / 2);
      return fill(left) + x + fill(need - left); // STR_PAD_BOTH
    }
    return x + fill(need); // STR_PAD_RIGHT (default)
  };

  // ---- PHP truthiness / logic ----
  rt.truthy = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '' && v !== '0';
    if (Array.isArray(v)) return v.length !== 0;
    if (typeof v === 'object') return Object.keys(v).length !== 0;
    return true;
  };
  rt.not = (v) => !rt.truthy(v);
  rt.and = (fa, fb) => (rt.truthy(fa()) ? rt.truthy(fb()) : false);
  rt.or = (fa, fb) => (rt.truthy(fa()) ? true : rt.truthy(fb()));

  // ---- PHP comparison semantics ----
  const isNumericStr = (s) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
  const tagOf = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'num';
    if (typeof v === 'string') return 'str';
    return 'arr';
  };
  const arrEmpty = (v) => (Array.isArray(v) ? v.length === 0 : (v && typeof v === 'object' ? Object.keys(v).length === 0 : true));

  rt.looseEq = (a, b) => {
    const ta = tagOf(a), tb = tagOf(b);
    if (ta === 'null' && tb === 'null') return true;
    if (ta === 'bool' || tb === 'bool') return rt.truthy(a) === rt.truthy(b);
    if (ta === 'null') {
      if (tb === 'num') return Number(b) === 0;
      if (tb === 'str') return b === '';
      if (tb === 'arr') return arrEmpty(b);
      return false;
    }
    if (tb === 'null') return rt.looseEq(b, a);
    if (ta === 'num' && tb === 'num') return a === b;
    if (ta === 'str' && tb === 'str') {
      if (isNumericStr(a) && isNumericStr(b)) return Number(a) === Number(b);
      return a === b;
    }
    if (ta === 'num' && tb === 'str') return isNumericStr(b) ? a === Number(b) : String(a) === String(b);
    if (ta === 'str' && tb === 'num') return isNumericStr(a) ? Number(a) === b : String(a) === String(b);
    return a === b;
  };
  rt.looseNe = (a, b) => !rt.looseEq(a, b);

  rt.strictEq = (a, b, la, lb) => {
    const na = a === undefined ? null : a;
    const nb = b === undefined ? null : b;
    const ta = tagOf(na), tb = tagOf(nb);
    if (ta !== tb) return false;
    if (ta === 'num' && (!!la !== !!lb)) return false;
    return na === nb;
  };
  rt.strictNe = (a, b, la, lb) => !rt.strictEq(a, b, la, lb);

  const numVal = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && isNumericStr(v) ? Number(v) : null));
  const relPair = (a, b) => {
    const na = numVal(a), nb = numVal(b);
    if (na !== null && nb !== null) return [na, nb];
    return [phpToStr(a), phpToStr(b)];
  };
  rt.lt = (a, b) => { const p = relPair(a, b); return p[0] < p[1]; };
  rt.gt = (a, b) => { const p = relPair(a, b); return p[0] > p[1]; };
  rt.lte = (a, b) => { const p = relPair(a, b); return p[0] <= p[1]; };
  rt.gte = (a, b) => { const p = relPair(a, b); return p[0] >= p[1]; };

  // ---- PHP arithmetic ----
  rt.sub = (a, b) => phpToNum(a) - phpToNum(b);
  rt.mul = (a, b) => phpToNum(a) * phpToNum(b);
  rt.div = (a, b) => phpToNum(a) / phpToNum(b);
  rt.mod = (a, b) => phpToNum(a) % phpToNum(b);
  rt.pow = (a, b) => Math.pow(phpToNum(a), phpToNum(b));

  // ---- null coalescing ----
  rt.coalesce = (a, b) => (a === null || a === undefined ? b : a);
  rt.coalesceAssign = (get, set, val) => { const cur = get(); if (cur === null || cur === undefined) set(val); return get(); };

  // ---- match (strict) ----
  rt.match = (v, ...arms) => {
    let dflt;
    for (const a of arms) {
      const conds = a[0], body = a[1];
      if (conds === null) { dflt = body; continue; }
      for (const c of conds) if (rt.strictEq(v, c, false, false)) return body();
    }
    if (dflt) return dflt();
    throw new Error('match: unhandled value');
  };

  // ---- foreach over PHP arrays/objects ----
  rt.entries = (src) => {
    if (src && typeof src === 'object') {
      const keyOf = (k) => (/^\d+$/.test(k) ? Number(k) : k);
      return Object.keys(src).map((k) => [keyOf(k), src[k]]);
    }
    return [];
  };

  // ---- type predicates ----
  const isNum = (v) => (typeof v === 'number' && !Number.isNaN(v)) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
  rt.is_null = (v) => v === null || v === undefined;
  rt.is_bool = (v) => typeof v === 'boolean';
  rt.is_int = (v) => typeof v === 'number' && Number.isInteger(v);
  rt.is_float = (v) => typeof v === 'number' && !Number.isInteger(v);
  rt.is_string = (v) => typeof v === 'string';
  rt.is_array = (v) => Array.isArray(v) || isObj(v);
  rt.is_object = (v) => isObj(v) && !Array.isArray(v);
  rt.is_numeric = isNum;
  rt.is_callable = (v) => typeof v === 'function';
  rt.is_countable = (v) => Array.isArray(v) || isObj(v);
  rt.is_boolean = rt.is_bool;
  rt.is_integer = rt.is_int;
  rt.is_long = rt.is_int;
  rt.is_double = rt.is_float;
  rt.is_real = rt.is_float;

  // ---- numbers ----
  rt.abs = (v) => Math.abs(Number(v));
  const phpRound = (x, p) => {
    const m = Math.pow(10, p);
    const v = x * m;
    return (v < 0 ? -Math.round(-v) : Math.round(v)) / m;
  };
  rt.round = (v, p) => phpRound(Number(v), p == null ? 0 : Number(p) | 0);
  rt.floor = (v) => Math.floor(Number(v));
  rt.ceil = (v) => Math.ceil(Number(v));
  rt.intval = (v, base) => {
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v == null ? '' : v).trim();
    const b = base == null ? 10 : Number(base) || 10;
    const re = b === 16 ? /^[+-]?(0x)?[0-9a-f]+/i : b === 8 ? /^[+-]?[0-7]+/ : /^[+-]?\d+/;
    const m = s.match(re);
    return m ? parseInt(m[0], b) : 0;
  };
  rt.floatval = (v) => {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).trim().match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  };
  const maxMin = (dir, a) => {
    const vals = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
    let best = vals[0];
    for (const v of vals) if (dir > 0 ? Number(v) > Number(best) : Number(v) < Number(best)) best = v;
    return best;
  };
  rt.max = (...a) => maxMin(1, a);
  rt.min = (...a) => maxMin(-1, a);

  // ---- strings (continued) ----
  const PHP_WS = ' \t\n\r\u0000\u000B';
  const trimChars = (s, chars, dir) => {
    const set = new Set(chars.split(''));
    const a = String(s == null ? '' : s).split('');
    let i = 0, j = a.length;
    if (dir !== 'r') while (i < j && set.has(a[i])) i++;
    if (dir !== 'l') while (j > i && set.has(a[j - 1])) j--;
    return a.slice(i, j).join('');
  };
  rt.ltrim = (s, chars) => trimChars(s, chars == null ? PHP_WS : String(chars), 'l');
  rt.rtrim = (s, chars) => trimChars(s, chars == null ? PHP_WS : String(chars), 'r');
  rt.ucwords = (s) => String(s == null ? '' : s).replace(/(^|[ \t\r\n\f\u000B])(\S)/g, (m, p, c) => p + c.toUpperCase());
  rt.strrev = (s) => String(s == null ? '' : s).split('').reverse().join('');
  rt.strpos = (h, n, off) => {
    const i = String(h == null ? '' : h).indexOf(String(n), off == null ? 0 : Number(off) | 0);
    return i < 0 ? false : i;
  };
  rt.strrpos = (h, n, off) => {
    const s = String(h == null ? '' : h);
    const from = off == null ? s.length : Number(off) | 0;
    const i = s.lastIndexOf(String(n), from);
    return i < 0 ? false : i;
  };
  rt.substr_count = (h, n, off, len) => {
    const s = String(h == null ? '' : h).slice(off == null ? 0 : Number(off) | 0);
    const needle = String(n);
    if (needle === '') return 0;
    let count = 0, i = 0;
    for (;;) {
      const at = s.indexOf(needle, i);
      if (at < 0) break;
      count++;
      i = at + needle.length;
    }
    return count;
  };
  rt.strip_tags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '');
  rt.htmlspecialchars = (s) => (s == null ? '' : rt.e(s));

  // ---- json ----
  rt.json_encode = (v) => JSON.stringify(v == null ? null : v).replace(/\//g, '\\/');
  rt.json_decode = (s, assoc) => JSON.parse(String(s));

  // ---- more array helpers ----
  rt.array_sum = (arr) => arrValues(arr).reduce((s, x) => s + Number(x), 0);
  rt.array_slice = (arr, offset, length) => {
    const a = arrValues(arr);
    const off = Number(offset) | 0;
    const o = off < 0 ? Math.max(a.length + off, 0) : off;
    if (length === undefined || length === null) return a.slice(o);
    return a.slice(o, o + Math.max(0, Number(length) | 0));
  };
  rt.array_reverse = (arr) => arrValues(arr).slice().reverse();
  rt.array_unique = (arr) => {
    const out = [];
    for (const v of arrValues(arr)) if (!out.some((x) => phpToStr(x) === phpToStr(v))) out.push(v);
    return out;
  };
  rt.array_count_values = (arr) => {
    const o = {};
    for (const v of arrValues(arr)) {
      const k = phpToStr(v);
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  };
  rt.array_flip = (arr) => {
    const o = {};
    if (isObj(arr)) for (const k of Object.keys(arr)) o[phpToStr(arr[k])] = /^\d+$/.test(k) ? Number(k) : k;
    return o;
  };
  rt.array_filter = (arr, cb) => arrValues(arr).filter((v) => (cb ? !!cb(v) : !!v));
  rt.array_map = (cb, arr) => arrValues(arr).map((v) => cb(v));

  rt.str = phpToStr;
  rt.optional = (value, cb = null) => {
    if (typeof cb === 'function') return value == null ? null : cb(value);
    if (value == null) {
      const fn = () => null;
      fn.toString = () => '';
      fn.valueOf = () => null;
      return new Proxy(fn, {
        get(t, prop) {
          if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) return t[prop];
          return fn;
        },
      });
    }
    return value;
  };

  rt.number_format = (n, dec = 0, dp = '.', ts = ',') => {
    const x = Number(n);
    const s = Math.abs(x).toFixed(dec);
    const [ip, fp] = s.split('.');
    const grouped = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ts);
    return (x < 0 ? '-' : '') + grouped + (fp ? dp + fp : '');
  };
  rt.nl2br = (s) => String(s == null ? '' : s).replace(/\r\n|\r|\n/g, '<br />\n');

  return rt;
}
export default buildRt;
