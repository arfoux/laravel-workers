// tools/php-funcs.mjs — the PHP function surface the BUILD-TIME config evaluator
// (tools/static.mjs) folds. Build-time only: this file is never shipped to a
// worker, so it may import node built-ins.
//
// Two rules, both from the audit:
//   1. A function that IS implemented must answer exactly what PHP 8.3 answers
//      (pinned by tools/tests/config-eval.test.mjs against the PHP oracle).
//   2. A function that is NOT implemented, or that PHP cannot answer
//      deterministically, is REFUSED BY NAME (PHP_REFUSED) instead of silently
//      answering `undefined` — the caller turns that into a named drop report
//      (`config-dump.mjs` stderr), so a config value never vanishes unseen.
//
// The evaluator's convention: a value of `undefined` means "not statically
// evaluable" (the array/keyed branches then drop the entry). PHP_FUNCS entries
// return real values; PHP_REFUSED entries are checked first and record a reason.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { phpJsonEncode, phpJsonDecode } from '../kernel/php-json.mjs';
import { looseEq, phpBool } from '../kernel/php-loose-eq.mjs';
import { phpNumeric, phpSortCompare } from '../kernel/collections.mjs';
import { str as kernelStr } from '../kernel/str.mjs';

// One canon for PHP's `(bool)`: kernel/php-loose-eq.mjs owns it (the validator
// and the Collection share that implementation), so the fold re-exports that
// function instead of carrying a second copy of the '0'/[]/NAN rules.
export { phpBool };

/** PHP's string cast, narrowed to the types a config value can hold.
 *
 * A FLOAT that is not integral is refused, like `phpStringCast()`: PHP renders it
 * with precision=14, so `(0.1 + 0.2)` interpolates as '0.3' where JS writes
 * '0.30000000000000004'. This is the shared cast (tools/static.mjs `.` uses it
 * for concatenation too), so one rule covers `'x' . $f`, `implode(',', [..])`,
 * `str_replace()` and `strval()`. */
export function phpStr(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '';
  if (typeof v === 'number' && !Number.isInteger(v)) {
    throw new FoldRefusal(
      `the float ${v} interpolates as PHP's precision=14 rendering (0.1 + 0.2 is '0.3'), which JS would print differently`
    );
  }
  if (Array.isArray(v) || (v && typeof v === 'object')) {
    // PHP 8: "Array to string conversion" is a Warning, and Laravel's error
    // handler promotes it to an ErrorException — the app would not boot, so the
    // fold refuses instead of writing the word 'Array' into the config (the one
    // canon is phpStringCast's rule).
    throw new FoldRefusal('array to string conversion is a PHP warning (an ErrorException under Laravel)');
  }
  return String(v);
}

/**
 * PHP's global `strtolower()` / `strtoupper()` are BYTE functions: only the 26
 * ASCII letters change case, every other byte is copied. JS's toLowerCase() is
 * Unicode-aware, so the old table answered `strtolower('ABÇ')` = 'abç' where PHP
 * answers 'abÇ' — a different config value. (Laravel's `Str::lower()` IS
 * `mb_strtolower`, so kernel/str.mjs keeps its Unicode mapping; only these two
 * GLOBAL functions are ASCII.)
 */
function asciiLower(s) {
  return phpStr(s).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
function asciiUpper(s) {
  return phpStr(s).replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}
/** PHP's `ucfirst()`/`lcfirst()`: the same ASCII-only rule (a leading 'é' is
 * left alone; JS's charAt(0).toLowerCase() changed it). */
function asciiUcfirst(s) {
  const t = phpStr(s);
  return /^[a-z]/.test(t) ? asciiUpper(t[0]) + t.slice(1) : t;
}
function asciiLcfirst(s) {
  const t = phpStr(s);
  return /^[A-Z]/.test(t) ? asciiLower(t[0]) + t.slice(1) : t;
}
/** PHP's `ucwords()`: the delimiters are the six ASCII whitespace characters,
 * NOT "any non-letter" — `ucwords('a-b')` is 'A-b'. */
function asciiUcwords(s) {
  return phpStr(s).replace(/(^|[ \t\r\n\f\v])([a-z])/g, (_m, pre, c) => pre + asciiUpper(c));
}
/** A byte slice of a PHP string, refused when the cut leaves invalid UTF-8.
 * PHP slices BYTES, so `substr('héllo', 0, 2)` ends mid-sequence; the dumped
 * config is JSON text, which cannot carry those bytes — the fold refuses rather
 * than writing U+FFFD (a different string) or a longer one. */
function byteSlice(buf, from, to) {
  const slice = buf.subarray(Math.max(from, 0), Math.max(to, from));
  const out = slice.toString('utf8');
  if (!Buffer.from(out, 'utf8').equals(slice)) {
    throw new FoldRefusal('the byte slice cuts a UTF-8 sequence in half (PHP strings are bytes; the config dump is JSON text)');
  }
  return out;
}

/**
 * PHP's `trim()` family charset: a *set* of characters, with `a..z` ranges;
 * `..` alone is a literal two-dot. JS `String.prototype.trim` strips more
 * (U+00A0, U+2000-200A, U+FEFF) than PHP's default `" \t\n\r\0\x0B"`, so the
 * default list is written out instead of delegated.
 */
const TRIM_DEFAULT = ' \t\n\r\0\u000B';
function charsetRe(chars) {
  const out = [];
  const s = String(chars);
  for (let i = 0; i < s.length; i++) {
    if (i + 3 < s.length && s[i + 1] === '.' && s[i + 2] === '.') {
      out.push(`${s[i]}-${s[i + 3]}`);
      i += 3;
      continue;
    }
    out.push(s[i].replace(/[\\\]^$.*+?()[\]{}|/-]/g, '\\$&'));
  }
  return new RegExp('[' + out.join('') + ']');
}
/** PHP's `trim($s, $chars)` — also the twin of `Str::trim()`. */
export function phpTrim(value, chars) {
  return trimSide(value, chars, true, true);
}

function trimSide(value, chars, left, right) {
  const list = chars === undefined || chars === null ? TRIM_DEFAULT : phpStr(chars);
  // PHP trims byte by byte: a charset that contains a character above U+007F
  // would strip the individual BYTES of it, which a per-character JS walk
  // cannot express (trim($s, 'é') strips 0xC3 and 0xA9 separately).
  if (/[^\x00-\x7F]/.test(list)) {
    throw new FoldRefusal('a trim() charset with a non-ASCII character trims its individual bytes in PHP');
  }
  const re = charsetRe(list);
  const s = phpStr(value);
  let a = 0;
  let b = s.length;
  if (left) while (a < b && re.test(s[a])) a++;
  if (right) while (b > a && re.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * PHP's `explode($separator, $string, $limit)` — the same shape as the runtime's
 * rt.explode() (compiler/runtime/rt-from-context.mjs), which the corpus pins
 * against PHP: an empty separator is a ValueError, limit 0 counts as 1, a
 * negative limit drops the last |limit| elements.
 */
function phpExplode(delim, str, limit) {
  const d = phpStr(delim);
  const s = phpStr(str);
  if (d === '') return undefined; // ValueError in PHP: refuse, never guess
  const parts = s.split(d);
  if (limit === undefined || limit === null) return parts;
  const n = Math.trunc(Number(limit)) | 0;
  if (n === 0) return [s];
  if (n > 0) return n >= parts.length ? parts : [...parts.slice(0, n - 1), parts.slice(n - 1).join(d)];
  return parts.slice(0, Math.max(parts.length + n, 0));
}

/** PHP's `implode()` (a.k.a. `join`): null glue is '', every element is cast. */
function phpImplode(glue, parts) {
  // Two call shapes: implode($glue, $array) and the legacy implode($array),
  // which glues with ''. The old code refused the one-argument form (the array
  // landed in the `glue` slot and `parts` was undefined) where PHP answers the
  // concatenation.
  if (parts === undefined) {
    parts = glue;
    glue = '';
  }
  // `valuesOf` (not Object.values) so a PHP array kept as an object is read in
  // its declared `__lwOrder`.
  const list = valuesOf(parts);
  if (list === null) return undefined; // a scalar argument is a TypeError in PHP 8
  return list.map(phpStr).join(glue === null || glue === undefined ? '' : phpStr(glue));
}

/** PHP's numeric-string test (is_numeric): leading/trailing whitespace is allowed. */
function isNumericPhp(v) {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  return /^[ \t\n\r\0\x0B]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\0\x0B]*$/.test(v);
}

/** PHP's `str_replace()`: arrays on any side, recursion over array subjects. */
function phpStrReplace(search, replace, subject) {
  const searches = Array.isArray(search) ? search : [search];
  // PHP: "If search is an array and replace is a string, then this replacement
  // string is used for every value of search." Only an ARRAY replacement may be
  // shorter than the search list (the missing ones become ''); the old code
  // treated the single string that way and deleted the rest of the matches.
  const replaceIsArray = Array.isArray(replace);
  const replaces = replaceIsArray ? replace : searches.map(() => replace);
  const one = (s) => {
    let out = phpStr(s);
    for (let i = 0; i < searches.length; i++) {
      const from = phpStr(searches[i]);
      if (from === '') continue;
      const to = replaces[i] === undefined ? '' : phpStr(replaces[i]);
      out = out.split(from).join(to);
    }
    return out;
  };
  if (Array.isArray(subject)) return subject.map(one);
  return one(subject);
}

/** PHP `array_keys()`: list indices for a list, insertion order for an object. */
function keysOf(v) {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (v && typeof v === 'object') {
    const order = Array.isArray(v.__lwOrder) ? v.__lwOrder : null;
    const own = Object.keys(v);
    if (!order) return own;
    const seen = new Set();
    const out = [];
    for (const k of order) { if (own.includes(k) && !seen.has(k)) { seen.add(k); out.push(k); } }
    for (const k of own) if (!seen.has(k)) out.push(k);
    return out;
  }
  return null;
}
const numericKey = (k) => (/^-?\d+$/.test(String(k)) ? Number(k) : String(k));
function listOrObject(entries) {
  if (entries.every(([k], i) => String(k) === String(i))) return entries.map(([, v]) => v);
  const obj = {};
  for (const [k, v] of entries) obj[k] = v;
  Object.defineProperty(obj, '__lwOrder', { value: entries.map(([k]) => String(k)), enumerable: false });
  return obj;
}
function valuesOf(v) {
  const keys = keysOf(v);
  return keys === null ? null : keys.map((k) => v[k]);
}

/** PHP's callable argument: a closure/arrow function (the evaluator hands over a
 * JS function) or a function NAME resolved in the fold's own table. A name the
 * fold does not implement is a REFUSAL: `array_map('strtoupper', $a)` used to
 * answer the list UNCHANGED (a string is not a JS function, so the map fell
 * through) and `array_map('nope', $a)` answered it too, where PHP raises a
 * TypeError/Error for an unknown callable.
 *
 * `array_map()` takes ONE array in this fold (the table's maxArgs guard refuses
 * the multi-array ZIP form); `array_filter()` takes the three modes below. */
function resolveCallback(cb, funcs, where) {
  if (typeof cb === 'function') return cb;
  if (typeof cb === 'string' && funcs && typeof funcs[cb] === 'function') {
    const impl = funcs[cb];
    return (...args) => impl(...args);
  }
  if (typeof cb === 'string') {
    throw new FoldRefusal(`${where}() calls '${cb}', a function the build-time fold does not implement (PHP would call the real one)`);
  }
  throw new FoldRefusal(`${where}() was given a value that is not callable (PHP raises a TypeError)`);
}

/** PHP `array_filter()`: keys are PRESERVED, and the callback gets the value
 * (mode 0), the key (ARRAY_FILTER_USE_KEY = 2) or the (value, key) pair
 * (ARRAY_FILTER_USE_BOTH = 1) — PHP's numbers, see PHP_CONSTANTS. */
function phpArrayFilter(arr, cb, mode = 0, funcs) {
  const keys = keysOf(arr);
  if (keys === null) return undefined;
  const fn = cb === null || cb === undefined ? null : resolveCallback(cb, funcs, 'array_filter');
  const out = [];
  for (const k of keys) {
    const v = arr[k];
    // ARRAY_FILTER_USE_KEY (2) passes the KEY, ARRAY_FILTER_USE_BOTH (1) the
    // (value, key) pair, the default the value.
    const keep = fn ? phpBool(fn(...(mode === 2 ? [k] : mode === 1 ? [v, k] : [v]))) : phpBool(v);
    if (keep) out.push([k, v]);
  }
  return listOrObject(out);
}

function phpArrayMap(cb, arr, funcs) {
  const keys = keysOf(arr);
  if (keys === null) return undefined;
  // PHP's `array_map()` PRESERVES the source keys when exactly one array is
  // passed — a string key stays a string key, a gap in the numeric keys stays a
  // gap. Verified against PHP 8.3.30: `array_map($f, ['k'=>1,'m'=>2])` answers
  // `{"k":2,"m":4}`, and `array_map(null, [5=>'a'])` answers `{"5":"a"}`. The
  // fold used to answer a plain list here, which silently changed the shape of
  // an associative config array (`listOrObject` is the same idiom
  // `phpArrayFilter` already uses).
  if (cb === null || cb === undefined) return listOrObject(keys.map((k) => [k, arr[k]]));
  const fn = resolveCallback(cb, funcs, 'array_map');
  return listOrObject(keys.map((k) => [k, fn(arr[k])]));
}

const PHP_URL_COMPONENTS = ['scheme', 'host', 'port', 'user', 'pass', 'path', 'query', 'fragment'];

/** PHP `parse_url()`: a statement-by-statement port of `php_url_parse_ex2()`
 * (php-src ext/standard/url.c, PHP 8.3), because PHP's URL parser is full of
 * cases a regex cannot express:
 *
 *   'a:2'    -> {host: 'a', port: 2}     but  'a:2x' -> {scheme: 'a', path: '2x'}
 *   'h:1:2'  -> {scheme: 'h', path: '1:2'}    'localhost:8080' -> {host, port}
 *   ':x'     -> {path: ':x'}             but  ':'     -> false (all parts empty)
 *   '//:1'   -> false                    but  ':1'    -> false (empty host)
 *   '///'    -> false                    but  '#f'    -> {fragment: 'f'}
 *   'file:///tmp/x' -> {scheme: 'file', path: '/tmp/x'}
 *   'file:///c:/x'  -> {scheme: 'file', path: 'c:/x'}   (the Windows-drive case)
 *
 * Returns `false` exactly where PHP's parse_url() returns false, a component's
 * value (or `null` where PHP answers NULL) when `component` is given, and throws
 * for a component id outside PHP_URL_* (PHP 8 raises ValueError there, which in
 * a Laravel boot is a fatal — refusing is the honest answer).
 *
 * `php_replace_controlchars_ex()` rewrites every control character of a produced
 * string to '_'; since that mapping never turns a control character into one of
 * the delimiters the parser looks for, applying it to the produced parts is the
 * same as PHP applying it to the parts it produced.
 */
function phpParseUrl(input, component) {
  const str = phpStr(input);
  const ue = str.length;
  const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  const isDigit = (c) => c >= '0' && c <= '9';
  const ctl = (t) => t.replace(/[\u0000-\u001f\u007f]/g, '_');
  // binary_strcspn(s, ue, "/?#")
  const strcspn = (from) => {
    let end = ue;
    for (const c of ['/', '?', '#']) {
      const i = str.indexOf(c, from);
      if (i !== -1 && i < end) end = i;
    }
    return end;
  };
  // ZEND_STRTOL: leading blanks, an optional sign, then digits; `end` must move.
  const strtol = (text) => {
    const m = /^\s*[+-]?\d+/.exec(text);
    return m ? Number(m[0]) : null;
  };

  const r = { scheme: null, host: null, user: null, pass: null, path: null, query: null, fragment: null, port: 0, hasPort: false };
  let s = 0;
  let e = str.indexOf(':');
  let p;
  let pp;

  let state = 'scheme';
  for (;;) {
    switch (state) {
      // ---- parse scheme ----
      case 'scheme': {
        if (e !== -1 && e !== s) {
          let bad = -1;
          for (p = s; p < e; p++) {
            const c = str[p];
            if (!isAlpha(c) && !isDigit(c) && c !== '+' && c !== '.' && c !== '-') {
              bad = p;
              break;
            }
          }
          if (bad !== -1) {
            if (e + 1 < ue && e < strcspn(s)) {
              state = 'parse_port';
              continue;
            }
            if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') {
              s += 2;
              e = 0;
              state = 'parse_host';
              continue;
            }
            state = 'just_path';
            continue;
          }
          if (e + 1 === ue) {
            // "only scheme is available"
            r.scheme = ctl(str.slice(s, e));
            return r;
          }
          if (str[e + 1] !== '/') {
            // The tail's digits may be a port: `a.com:80`.
            p = e + 1;
            while (p < ue && isDigit(str[p])) p++;
            if ((p === ue || str[p] === '/') && p - e < 7) {
              state = 'parse_port';
              continue;
            }
            r.scheme = ctl(str.slice(s, e));
            s = e + 1;
            state = 'just_path';
            continue;
          }
          r.scheme = ctl(str.slice(s, e));
          if (e + 2 < ue && str[e + 2] === '/') {
            s = e + 3;
            if (r.scheme.toLowerCase() === 'file') {
              if (e + 3 < ue && str[e + 3] === '/') {
                // `file:///c:/x`: a Windows drive letter drops one more slash.
                if (e + 5 < ue && str[e + 5] === ':') s = e + 4;
                state = 'just_path';
                continue;
              }
            }
            state = 'parse_host';
            continue;
          }
          s = e + 1;
          state = 'just_path';
          continue;
        }
        if (e !== -1) {
          // "no scheme; starts with colon: look for port"
          state = 'parse_port';
          continue;
        }
        if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') {
          s += 2;
          state = 'parse_host';
          continue;
        }
        state = 'just_path';
        continue;
      }
      // ---- parse_port ----
      case 'parse_port': {
        p = e + 1;
        pp = p;
        while (pp < ue && pp - p < 6 && isDigit(str[pp])) pp++;
        if (pp - p > 0 && pp - p < 6 && (pp === ue || str[pp] === '/')) {
          const n = Number(str.slice(p, pp));
          if (n >= 0 && n <= 65535) {
            r.hasPort = true;
            r.port = n;
            if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') s += 2;
          } else {
            return false;
          }
        } else if (p === pp && pp === ue) {
          return false;
        } else if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') {
          s += 2;
        } else {
          state = 'just_path';
          continue;
        }
        state = 'parse_host';
        continue;
      }
      // ---- parse_host ----
      case 'parse_host': {
        e = strcspn(s);
        const at = str.lastIndexOf('@', e - 1); // zend_memrchr(s, '@', e - s)
        if (at !== -1 && at >= s) {
          const colon = str.indexOf(':', s); // memchr(s, ':', p - s)
          if (colon !== -1 && colon < at) {
            r.user = ctl(str.slice(s, colon));
            r.pass = ctl(str.slice(colon + 1, at));
          } else {
            r.user = ctl(str.slice(s, at));
          }
          s = at + 1;
        }
        // An IPv6 literal short-circuits the port scan (`[::1]`).
        let hp;
        if (s < ue && str[s] === '[' && e - 1 >= 0 && str[e - 1] === ']') hp = -1;
        else hp = str.lastIndexOf(':', e - 1); // zend_memrchr(s, ':', e - s)
        if (hp !== -1 && hp < s) hp = -1;
        if (hp !== -1) {
          if (!r.port) {
            const ps = hp + 1;
            if (e - ps > 5) return false; // a port is at most 5 characters
            if (e - ps > 0) {
              const n = strtol(str.slice(ps, e));
              if (n !== null && n >= 0 && n <= 65535) {
                r.hasPort = true;
                r.port = n;
              } else {
                return false;
              }
            }
            // p-- : the host ends at the colon either way.
          }
          p = hp;
        } else {
          p = e;
        }
        if (p - s < 1) return false; // no host at all: not a URL
        r.host = ctl(str.slice(s, p));
        if (e === ue) return r;
        s = e;
        state = 'just_path';
        continue;
      }
      // ---- just_path ----
      default: {
        e = ue;
        p = str.indexOf('#', s);
        if (p !== -1) {
          p++;
          r.fragment = p < e ? ctl(str.slice(p, e)) : '';
          e = p - 1;
        }
        p = str.indexOf('?', s);
        if (p !== -1 && p >= e) p = -1;
        if (p !== -1) {
          p++;
          r.query = p < e ? ctl(str.slice(p, e)) : '';
          e = p - 1;
        }
        if (s < e || s === ue) r.path = ctl(str.slice(s, e));
        return r;
      }
    }
  }
}

/** The component view of a `phpParseUrl()` result (PHP's parse_url($u, $c)). */
function phpParseUrlComponent(value, component) {
  const r = phpParseUrl(value, component);
  if (r === false) return false;
  if (component === undefined || component === null) {
    const out = {};
    const present = [];
    for (let i = 0; i < 8; i++) {
      const name = PHP_URL_COMPONENTS[i];
      const v = name === 'port' ? (r.hasPort ? r.port : null) : r[name];
      if (v !== null && v !== undefined) {
        out[name] = v;
        present.push(name);
      }
    }
    Object.defineProperty(out, '__lwOrder', { value: present, enumerable: false });
    return out;
  }
  const c = Number(component);
  if (!Number.isInteger(c) || c < 0 || c > 7) {
    throw new FoldRefusal(`parse_url(): component ${phpStr(component)} is not a PHP_URL_* id (PHP 8 raises ValueError)`);
  }
  if (c === 2) return r.hasPort ? r.port : null;
  const v = r[PHP_URL_COMPONENTS[c]];
  return v === undefined ? null : v;
}

/**
 * The PHP constants a config file may use as a VALUE or as an argument. Only
 * deterministic, platform-independent ones: PHP_EOL / DIRECTORY_SEPARATOR /
 * PHP_INT_MAX / PHP_VERSION answer the HOST the fold runs on, so folding them
 * would bake the build machine into the dump (audit: extension_loaded class).
 */
export const PHP_CONSTANTS = new Map([
  ['PHP_URL_SCHEME', 0],
  ['PHP_URL_HOST', 1],
  ['PHP_URL_PORT', 2],
  ['PHP_URL_USER', 3],
  ['PHP_URL_PASS', 4],
  ['PHP_URL_PATH', 5],
  ['PHP_URL_QUERY', 6],
  ['PHP_URL_FRAGMENT', 7],
  // The mode arguments of the two implemented functions that take one. Without
  // these the constant refused, the argument became `undefined`, and the
  // CALLEE'S DEFAULT PARAMETER swallowed the refusal: `str_pad('7', 3, '0',
  // STR_PAD_LEFT)` folded to '700' (the STR_PAD_RIGHT default) with no report at
  // all. The values are PHP's own and do not depend on the host:
  // str_pad: left 0, right 1, both 2 — array_filter: USE_BOTH 1, USE_KEY 2
  // (php_array_filter() passes callable($value, $key) for BOTH and
  // callable($key) for KEY; the pair was swapped here, so an app that asked
  // `array_filter($a, $cb, ARRAY_FILTER_USE_KEY)` folded the list filtered BY
  // VALUE — a different config array, silently).
  ['STR_PAD_LEFT', 0],
  ['STR_PAD_RIGHT', 1],
  ['STR_PAD_BOTH', 2],
  ['ARRAY_FILTER_USE_BOTH', 1],
  ['ARRAY_FILTER_USE_KEY', 2],
]);

/** Constants that exist in PHP but must NOT be folded (host/platform bound). */
export const PHP_CONSTANTS_REFUSED = new Map([
  ['PHP_EOL', 'PHP_EOL is the line ending of the host PHP runs on (CRLF on Windows, LF elsewhere)'],
  ['PHP_OS', 'PHP_OS names the build host'],
  ['PHP_OS_FAMILY', 'PHP_OS_FAMILY names the build host'],
  ['PHP_VERSION', 'PHP_VERSION is the build host\'s interpreter version'],
  ['PHP_INT_MAX', 'PHP_INT_MAX is the build host\'s integer width and exceeds JSON number safety'],
  ['PHP_INT_MIN', 'PHP_INT_MIN is the build host\'s integer width and exceeds JSON number safety'],
  ['PHP_INT_SIZE', 'PHP_INT_SIZE is the build host\'s integer width'],
  ['DIRECTORY_SEPARATOR', 'DIRECTORY_SEPARATOR is the build host\'s path separator'],
  // A mode/flag the fold's implementation of that family ignores. Refusing is
  // the honest answer: the alternative is answering the UN-flagged result and
  // calling it the same value (`count($a, COUNT_RECURSIVE)`,
  // `json_encode($v, JSON_PRETTY_PRINT)`, `array_unique($a, SORT_STRING)`).
  ['COUNT_RECURSIVE', 'the fold\'s count() counts one level only; a recursive count is a different number'],
  ['JSON_PRETTY_PRINT', 'the fold\'s json_encode() writes the un-flagged form; the app would read a different string'],
  ['JSON_UNESCAPED_SLASHES', 'the fold\'s json_encode() writes the un-flagged form; the app would read a different string'],
  ['JSON_UNESCAPED_UNICODE', 'the fold\'s json_encode() writes the un-flagged form; the app would read a different string'],
  ['JSON_THROW_ON_ERROR', 'the fold\'s json_encode() writes the un-flagged form; the app would read a different string'],
  ['SORT_REGULAR', 'the fold\'s array_unique() compares with PHP\'s loose ==; a sort flag is a different comparison'],
  ['SORT_NUMERIC', 'the fold\'s array_unique() compares with PHP\'s loose ==; a sort flag is a different comparison'],
  ['SORT_STRING', 'the fold\'s array_unique() compares with PHP\'s loose ==; a sort flag is a different comparison'],
]);

/**
 * Named refusals: a function a config file may call that this evaluator will NOT
 * answer, with the reason the report prints. Silence is what the audit found
 * dangerous; a name plus a reason is actionable.
 */
export const PHP_REFUSED = new Map([
  ['time', 'the value changes on every boot'],
  ['microtime', 'the value changes on every boot'],
  ['hrtime', 'the value changes on every boot'],
  ['date', 'the value changes on every boot'],
  ['gmdate', 'the value changes on every boot'],
  ['strtotime', 'the value changes with the current time'],
  ['mktime', 'the value changes with the timezone and the current time'],
  ['now', 'a Laravel helper that reads the clock'],
  ['today', 'a Laravel helper that reads the clock'],
  ['random_bytes', 'the value changes on every boot'],
  ['random_int', 'the value changes on every boot'],
  ['rand', 'the value changes on every boot'],
  ['mt_rand', 'the value changes on every boot'],
  ['uniqid', 'the value changes on every boot'],
  ['gethostname', 'the value names the machine the fold runs on'],
  ['php_uname', 'the value names the machine the fold runs on'],
  ['php_sapi_name', 'the value names the fold\'s SAPI (cli), not the edge'],
  ['getmypid', 'the value names the fold\'s process'],
  ['memory_get_usage', 'the value describes the fold\'s process'],
  ['sprintf', 'PHP\'s format engine is not JS\'s: a port would silently diverge'],
  ['vsprintf', 'PHP\'s format engine is not JS\'s: a port would silently diverge'],
  ['printf', 'PHP\'s format engine is not JS\'s: a port would silently diverge'],
  ['number_format', 'PHP\'s rounding mode (half-up on the decimal string) is not JS toFixed'],
  ['round', 'PHP\'s round() has a half-up decimal mode JS does not'],
  ['floor', 'not implemented — add it to tools/php-funcs.mjs with an oracle test'],
  ['ceil', 'not implemented — add it to tools/php-funcs.mjs with an oracle test'],
  ['abs', 'not implemented — add it to tools/php-funcs.mjs with an oracle test'],
  ['min', 'not implemented — add it to tools/php-funcs.mjs with an oracle test'],
  ['max', 'not implemented — add it to tools/php-funcs.mjs with an oracle test'],
  ['preg_match', 'PCRE and JS RegExp are different engines: a port would silently diverge'],
  ['preg_replace', 'PCRE and JS RegExp are different engines: a port would silently diverge'],
  ['preg_split', 'PCRE and JS RegExp are different engines: a port would silently diverge'],
  ['config', 'a config file that reads config() depends on the load order; declare the value instead'],
  ['app', 'the service container does not exist at build time'],
  ['resolve', 'the service container does not exist at build time'],
  ['class_exists', 'reflection over the app\'s PHP code is not available at build time'],
  ['method_exists', 'reflection over the app\'s PHP code is not available at build time'],
  ['function_exists', 'reflection over the app\'s PHP code is not available at build time'],
  ['defined', 'reflection over constants of the app\'s PHP code is not available at build time'],
  ['curl_version', 'requires the curl extension'],
]);

/**
 * The extensions the EDGE has. The compiled rung is JavaScript: no PHP
 * extension exists, so `extension_loaded()` answers false for every name —
 * except the ones the kernel itself implements in JS (none today: a driver
 * check in a config file must not claim a PHP extension the worker cannot use).
 */
const EDGE_EXTENSIONS = new Set();

/* ---------------------------------------------------------------------------
 * PHP's OPERATORS and CASTS, as the fold needs them.
 *
 * Every entry here exists because the evaluator previously answered a plain
 * `undefined` for the operator ("not evaluable") and the entry vanished from the
 * dumped config while PHP booted with a value. Where the semantics are exact
 * they are implemented; where PHP's answer depends on something the fold cannot
 * know (a float printed with precision=14, a bytewise string bit-op, `+` on
 * arrays as a key union) they REFUSE with a reason.
 * ------------------------------------------------------------------------- */

/** "PHP raises / this is not modellable" — the evaluator turns it into a NAMED
 * drop report (`config-dump.mjs`), never a silent hole in the config. */
export class FoldRefusal extends Error {}

/** A PHP function whose ANSWER depends on an argument the fold does not model:
 * more arguments than the modelled shape is a refusal, never a silent drop of
 * the extra one. `count($a, COUNT_RECURSIVE)` counts recursively and
 * `array_map($cb, $a, $b)` ZIPS its arrays; answering them as if the extra
 * argument were absent is a WRONG config value, which is worse than a drop. */
function maxArgs(fn, max, note) {
  return (...args) => {
    if (args.length > max) throw new FoldRefusal(note);
    return fn(...args);
  };
}

/** PHP's `(int)` / `intval($v, 10)` — one canon for both call shapes. */
export function phpIntCast(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  // NAN and ±INF are 0 in PHP 8 (they were 1 before 7).
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    // A NUMERIC string casts its number (`(int) '1e3'` is 1000), a string with
    // only a numeric PREFIX its leading digits (`(int) '5a'` is 5) — the old
    // fold answered `parseInt('1e3')` = 1.
    if (isNumericPhp(v)) return Math.trunc(Number(v));
    const m = /^[ \t\n\r\0\x0B]*[+-]?\d+/.exec(v);
    return m ? Number(m[0].replace(/[ \t\n\r\0\x0B]/g, '')) : 0;
  }
  if (Array.isArray(v) || (v && typeof v === 'object')) return isEmptyArrayLike(v) ? 0 : 1;
  return 0;
}

/** PHP's `(float)` / `floatval()` / `doubleval()`. */
export function phpFloatCast(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const m = /^[ \t\n\r\0\x0B]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(v);
    return m ? Number(m[0]) : 0;
  }
  if (Array.isArray(v) || (v && typeof v === 'object')) return isEmptyArrayLike(v) ? 0 : 1;
  return 0;
}

/** PHP's `(string)` cast. Refuses the two shapes whose PHP answer is a warning
 * (Laravel promotes those to ErrorException, so the app would not boot) or a
 * precision=14 float rendering the fold cannot reproduce. */
export function phpStringCast(v) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new FoldRefusal(
        `(string) of the float ${v} is PHP's precision=14 rendering (0.1 + 0.2 answers '0.3'), ` +
          'which JS would print as 0.30000000000000004 — the fold refuses instead of guessing'
      );
    }
    return String(v);
  }
  if (Array.isArray(v) || (v && typeof v === 'object')) {
    throw new FoldRefusal('array to string conversion is a PHP warning (an ErrorException under Laravel)');
  }
  return phpStr(v);
}

/** PHP's `(array)` cast: a scalar becomes a one-element list, null `[]`. */
export function phpArrayCast(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && isArrayObject(v)) return v; // a PHP array kept as an object
  if (typeof v === 'object') return Object.keys(v).filter((k) => !k.startsWith('_')).map((k) => v[k]);
  return [v];
}

/** PHP's `(bool)` — the kernel's one canon, re-stated for the evaluator's use. */
export const phpBoolCast = (v) => phpBool(v);

// --- helpers ---------------------------------------------------------------

const isArrayObject = (v) => v !== null && typeof v === 'object' && Array.isArray(v.__lwOrder);

function isEmptyArrayLike(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (isArrayObject(v)) return v.__lwOrder.length === 0;
  return Object.keys(v).filter((k) => !k.startsWith('_')).length === 0;
}

/** PHP's numeric operand for an arithmetic/bitwise operator. `phpNumeric()` is
 * the runtime's own implementation (kernel/collections.mjs); it throws a
 * TypeError-named error for a non-numeric string, an array or an object, which
 * is exactly PHP 8's behaviour. */
const numericOperand = (v) => phpNumeric(v);

function int64(v) {
  const n = Math.trunc(numericOperand(v));
  if (!Number.isSafeInteger(n)) {
    throw new FoldRefusal(`integer operand ${n} is outside the 64-bit integer range the fold models`);
  }
  return BigInt(n);
}

function bitResult(res) {
  const n = Number(BigInt.asIntN(64, res));
  if (!Number.isSafeInteger(n)) throw new FoldRefusal('the bitwise result exceeds JSON number safety');
  return n;
}

/** PHP's `<`/`>`/`<=>` (`SORT_REGULAR`) — the runtime's `phpSortCompare()`. */
export const phpCompare = (a, b) => phpSortCompare(a, b);

/** PHP's `===`: same type AND value; two arrays/objects compare key by key.
 * (int 1 and float 1.0 are indistinguishable in JS — the project's documented
 * normalization, see kernel/php-serialize.mjs.) */
export function phpIdentical(a, b) {
  if (a === b) return true;
  const ta = foldType(a);
  if (ta !== foldType(b)) return false;
  if (ta === 'array') {
    const ka = foldKeys(a);
    const kb = foldKeys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && phpIdentical(entryOf(a, k), entryOf(b, k)));
  }
  if (ta === 'object') {
    const ka = Object.keys(a).filter((k) => !k.startsWith('_'));
    const kb = Object.keys(b).filter((k) => !k.startsWith('_'));
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && phpIdentical(a[k], b[k]));
  }
  return false;
}

function foldType(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'boolean' || t === 'number' || t === 'string') return t;
  return 'object';
}
const foldKeys = (v) => (Array.isArray(v) ? v.map((_, i) => i) : v.__lwOrder.slice());
const entryOf = (v, k) => v[k];

const shiftCount = (v) => {
  const n = Math.trunc(numericOperand(v));
  if (!Number.isSafeInteger(n)) throw new FoldRefusal('shift counts must be 64-bit integers');
  if (n < 0) throw new FoldRefusal('a negative shift count is a PHP ArithmeticError');
  if (n > 63) throw new FoldRefusal('a shift count above 63 is not modellable as a 64-bit PHP int');
  return BigInt(n);
};

/**
 * PHP's binary operators (`tools/static.mjs` evaluates the operand nodes and
 * calls this; `tools/config-script.mjs` reuses it for `+=` and friends).
 * `undefined` means "an operand was not statically evaluable" — the caller
 * reports the drop. A `FoldRefusal` means PHP itself would fail or the rule is
 * not modelled; a TypeError-named error from `phpNumeric()` means PHP 8 raises
 * "Unsupported operand types", i.e. the app does not boot with this config.
 */
export function phpBinaryOp(type, l, r) {
  switch (type) {
    case '.':
      return phpStr(l) + phpStr(r);
    case '+':
      if (isPhpArrayValue(l) || isPhpArrayValue(r)) {
        throw new FoldRefusal('`+` on two arrays is PHP\'s key UNION (left wins) — use array_merge() instead');
      }
      return numericOperand(l) + numericOperand(r);
    case '-':
      return numericOperand(l) - numericOperand(r);
    case '*':
      return numericOperand(l) * numericOperand(r);
    case '/':
      if (numericOperand(r) === 0) throw new FoldRefusal('division by zero (PHP 8 DivisionByZeroError)');
      return numericOperand(l) / numericOperand(r);
    case '%': {
      const a = Math.trunc(numericOperand(l));
      const b = Math.trunc(numericOperand(r));
      if (b === 0) throw new FoldRefusal('modulo by zero (PHP 8 DivisionByZeroError)');
      return a % b;
    }
    case '**':
      return Math.pow(numericOperand(l), numericOperand(r));
    case '&':
      if (typeof l === 'string' && typeof r === 'string') {
        throw new FoldRefusal('`&` on two strings is PHP\'s BYTEWISE string op');
      }
      return bitResult(int64(l) & int64(r));
    case '|':
      if (typeof l === 'string' && typeof r === 'string') {
        throw new FoldRefusal('`|` on two strings is PHP\'s BYTEWISE string op');
      }
      return bitResult(int64(l) | int64(r));
    case '^':
      if (typeof l === 'string' && typeof r === 'string') {
        throw new FoldRefusal('`^` on two strings is PHP\'s BYTEWISE string op');
      }
      return bitResult(int64(l) ^ int64(r));
    case '<<':
      return bitResult(int64(l) << shiftCount(r));
    case '>>':
      return bitResult(int64(l) >> shiftCount(r));
    case '<':
      return phpCompare(l, r) < 0;
    case '<=':
      return phpCompare(l, r) <= 0;
    case '>':
      return phpCompare(l, r) > 0;
    case '>=':
      return phpCompare(l, r) >= 0;
    case '<=>':
      return phpCompare(l, r);
    case '==':
      return looseEq(l, r);
    case '!=':
      return !looseEq(l, r);
    case '===':
      return phpIdentical(l, r);
    case '!==':
      return !phpIdentical(l, r);
    case 'xor':
      return phpBool(l) !== phpBool(r);
    default:
      throw new FoldRefusal(`the binary operator '${type}' is not modelled by the fold`);
  }
}

export const isPhpArrayValue = (v) => Array.isArray(v) || isArrayObject(v);

/** PHP's unary operators, `!` included (the caller handles the branch
 * selection for `!`/`&&`/`||`, which short-circuit). */
export function phpUnaryOp(type, v) {
  switch (type) {
    case '-':
      return -numericOperand(v);
    case '+':
      return +numericOperand(v);
    case '!':
      return !phpBool(v);
    case '~': {
      if (typeof v === 'string') throw new FoldRefusal('`~` on a string is PHP\'s BYTEWISE string op');
      return bitResult(~int64(v));
    }
    default:
      throw new FoldRefusal(`the unary operator '${type}' is not modelled by the fold`);
  }
}

/**
 * A PHP number LITERAL (the raw source text php-parser keeps in
 * `number.value`) as a JS number. The old fold used `Number(node.value)`, which
 * answered 17 for the OCTAL `017` (PHP: 15) and NaN for `1_000` and `1_000.5`
 * — the NaN then dropped the entry from the dumped config with no trace.
 * Returns null when the literal is a 64-bit integer outside JSON number safety
 * (PHP holds it exactly; folding it would round silently).
 */
export function phpNumberLiteral(raw) {
  const s = String(raw).replace(/_/g, '');
  const asInt = (v) => (Number.isSafeInteger(v) ? v : null);
  let m;
  if ((m = /^0[xX]([0-9a-fA-F]+)$/.exec(s))) return asInt(parseInt(m[1], 16));
  if ((m = /^0[bB]([01]+)$/.exec(s))) return asInt(parseInt(m[1], 2));
  if ((m = /^0[oO]([0-7]+)$/.exec(s))) return asInt(parseInt(m[1], 8));
  if (/^0[0-7]+$/.test(s)) return asInt(parseInt(s, 8));
  if (/^\d+$/.test(s)) return asInt(Number(s));
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

/** PHP's `is_numeric()` (the numeric-string test, exported for the tests). */
export const isNumericString = (v) => isNumericPhp(v);

/**
 * The build-time function table. `ctx` carries { env, appDir, file, funcs } so a
 * helper can resolve paths against the app root exactly like PHP's CLI SAPI
 * (whose CWD is the app root).
 */
export function phpFuncs(ctx) {
  const appDir = ctx.appDir;
  const env = ctx.env || {};
  const abs = (p) => {
    const s = phpStr(p);
    return isAbsolute(s) ? normalize(s) : resolve(appDir, s);
  };
  return {
    // ---- JSON (kernel/php-json.mjs is the one implementation, verified there)
    json_encode: maxArgs((v) => phpJsonEncode(v), 1, 'json_encode() with flags or a depth argument is not modelled (they change the bytes)'),
    json_decode: maxArgs((text, assoc = false) => phpJsonDecode(text, { assoc: phpBool(assoc) }), 2, 'json_decode() with a depth or flags argument is not modelled'),

    // ---- strings
    explode: phpExplode,
    implode: maxArgs(phpImplode, 2, 'implode() takes a glue and an array (PHP raises an ArgumentCountError for a third argument)'),
    join: maxArgs(phpImplode, 2, 'join() takes a glue and an array (PHP raises an ArgumentCountError for a third argument)'),
    str_replace: maxArgs(phpStrReplace, 3, 'str_replace() with the by-reference count argument is not modelled'),
    str_contains: (h, n) => kernelStr.contains(h, n),
    str_starts_with: (h, n) => kernelStr.startsWith(h, n),
    str_ends_with: (h, n) => kernelStr.endsWith(h, n),
    strtolower: (s) => asciiLower(s),
    strtoupper: (s) => asciiUpper(s),
    ucfirst: (s) => asciiUcfirst(s),
    ucwords: maxArgs((s) => asciiUcwords(s), 1, 'ucwords() with its PHP 8 separators argument is not modelled'),
    lcfirst: (s) => asciiLcfirst(s),
    trim: (s, chars) => trimSide(s, chars, true, true),
    ltrim: (s, chars) => trimSide(s, chars, true, false),
    rtrim: (s, chars) => trimSide(s, chars, false, true),
    str_repeat: (s, n) => { const c = Math.trunc(Number(n)); return Number.isFinite(c) && c >= 0 ? phpStr(s).repeat(c) : undefined; },
    // PHP strings are BYTE strings: strlen() counts bytes and substr() cuts at
    // byte offsets. JS counts UTF-16 code units, so `strlen('héllo')` answered 5
    // where PHP answers 6. Byte slices that leave invalid UTF-8 are refused
    // (byteSlice) because the config dump is JSON text.
    substr: maxArgs((s, start, len) => {
      const buf = Buffer.from(phpStr(s), 'utf8');
      let a = Math.trunc(Number(start));
      if (!Number.isFinite(a)) return undefined;
      if (a < 0) a = Math.max(buf.length + a, 0);
      let end = buf.length;
      if (len !== undefined && len !== null) {
        const l = Math.trunc(Number(len));
        if (!Number.isFinite(l)) return undefined;
        end = l < 0 ? Math.max(buf.length + l, 0) : a + l;
      }
      return byteSlice(buf, a, end);
    }, 3, 'substr() takes three arguments (PHP raises an ArgumentCountError for a fourth)'),
    strlen: (s) => Buffer.byteLength(phpStr(s), 'utf8'),
    str_pad: maxArgs((s, len, pad = ' ', type = 1) => {
      const t = phpStr(s);
      const n = Math.trunc(Number(len));
      if (!Number.isFinite(n)) return undefined;
      const padStr = phpStr(pad);
      // PHP 8: str_pad() with an empty pad string is a ValueError (the old code
      // quietly padded with a space).
      if (padStr === '') throw new FoldRefusal('str_pad() with an empty pad string is a ValueError in PHP 8');
      const cur = Buffer.from(t, 'utf8');
      if (n <= cur.length) return t;
      const need = n - cur.length;
      const build = (count) => {
        const per = Buffer.byteLength(padStr, 'utf8');
        return Buffer.from(padStr.repeat(Math.ceil(count / per) + 1), 'utf8').subarray(0, count);
      };
      const mode = Number(type);
      const pieces = mode === 0
        ? [build(need), cur]
        : mode === 2
          ? [build(Math.floor(need / 2)), cur, build(need - Math.floor(need / 2))]
          : [cur, build(need)];
      const joined = Buffer.concat(pieces);
      return byteSlice(joined, 0, joined.length);
    }, 4, 'str_pad() takes four arguments (PHP raises an ArgumentCountError for a fifth)'),

    // ---- arrays
    count: maxArgs((v) => { const k = keysOf(v); return k === null ? undefined : k.length; }, 1, 'count() with a mode argument (COUNT_RECURSIVE) is not modelled'),
    sizeof: maxArgs((v) => { const k = keysOf(v); return k === null ? undefined : k.length; }, 1, 'sizeof() with a mode argument (COUNT_RECURSIVE) is not modelled'),
    array_keys: maxArgs((v) => keysOf(v), 1, 'array_keys() with a search value is not modelled'),
    // PHP 8.1's array_is_list(): the keys are exactly 0..n-1 in order. The
    // fold's own list/keyed convention (`__lwOrder`) is what the kernel reads,
    // so this answers without a guess.
    array_is_list: maxArgs((v) => {
      const k = keysOf(v);
      if (k === null) return undefined;
      return k.every((x, i) => String(x) === String(i));
    }, 1, 'array_is_list() takes one array'),
    array_values: (v) => valuesOf(v),
    array_filter: (arr, cb, mode = 0) => phpArrayFilter(arr, cb, mode, ctx.funcs),
    array_map: maxArgs((cb, arr) => phpArrayMap(cb, arr, ctx.funcs), 2, 'array_map() over more than one array ZIPS them, which the fold does not model'),
    array_key_exists: (key, v) => { const k = keysOf(v); return k === null ? undefined : k.some((x) => phpStr(x) === phpStr(key)); },
    in_array: (needle, hay, strict = false) => {
      const vals = valuesOf(hay);
      if (vals === null) return undefined;
      return phpBool(strict) ? vals.some((v) => v === needle) : vals.some((v) => looseEq(v, needle));
    },
    array_search: (needle, hay, strict = false) => {
      const keys = keysOf(hay);
      if (keys === null) return undefined;
      for (const k of keys) {
        const v = hay[k];
        if (phpBool(strict) ? v === needle : looseEq(v, needle)) return numericKey(k);
      }
      return false;
    },
    array_merge: (...arrays) => {
      const out = [];
      let next = 0;
      for (const a of arrays) {
        const keys = keysOf(a);
        if (keys === null) return undefined;
        for (const k of keys) {
          const v = a[k];
          if (typeof k === 'number' || /^-?\d+$/.test(String(k))) out.push([next++, v]);
          else {
            const at = out.findIndex(([k2]) => String(k2) === String(k));
            if (at >= 0) out[at] = [String(k), v];
            else out.push([String(k), v]);
          }
        }
      }
      return listOrObject(out);
    },
    // PHP's array_reverse(): `preserve_keys = false` (the default) REINDEXES the
    // result. The old code kept the source keys, so a config list came out
    // reversed but as an OBJECT (`array_reverse([1,2,3])` was `{"0":1,...}`
    // instead of `[3,2,1]`) — an is_list()-dependent branch answers differently.
    array_reverse: maxArgs((v, preserve = false) => {
      const k = keysOf(v);
      if (k === null) return undefined;
      const flipped = k.map((x) => [x, v[x]]).reverse();
      if (phpBool(preserve)) return listOrObject(flipped);
      // Without preserve_keys PHP keeps STRING keys and reindexes the numeric
      // ones in the new order.
      const out = [];
      let next = 0;
      for (const [key, val] of flipped) out.push(/^-?\d+$/.test(String(key)) ? [next++, val] : [String(key), val]);
      return listOrObject(out);
    }, 2, 'array_reverse() takes an array and preserve_keys (PHP raises an ArgumentCountError for a third argument)'),
    array_slice: (v, offset, length, preserve = false) => {
      const k = keysOf(v);
      if (k === null) return undefined;
      let off = Math.trunc(Number(offset));
      if (!Number.isFinite(off)) return undefined;
      if (off < 0) off = Math.max(k.length + off, 0);
      const end = length === undefined || length === null
        ? k.length
        : Math.max(off + Math.trunc(Number(length)), 0);
      const picked = k.slice(off, end).map((x) => [x, v[x]]);
      if (phpBool(preserve)) return listOrObject(picked);
      return picked.map(([, val]) => val);
    },
    array_unique: maxArgs((v) => {
      const k = keysOf(v);
      if (k === null) return undefined;
      const seen = [];
      const out = [];
      for (const key of k) {
        const val = v[key];
        if (seen.some((s) => looseEq(s, val))) continue;
        seen.push(val);
        out.push([key, val]);
      }
      return listOrObject(out);
    }, 1, 'array_unique() with a sort flag (SORT_REGULAR/…) is not modelled'),

    // ---- types
    is_string: (v) => typeof v === 'string',
    is_int: (v) => typeof v === 'number' && Number.isInteger(v),
    is_integer: (v) => typeof v === 'number' && Number.isInteger(v),
    is_long: (v) => typeof v === 'number' && Number.isInteger(v),
    is_float: (v) => typeof v === 'number' && !Number.isInteger(v),
    is_double: (v) => typeof v === 'number' && !Number.isInteger(v),
    is_bool: (v) => typeof v === 'boolean',
    is_array: (v) => v !== null && typeof v === 'object',
    is_null: (v) => v === null,
    is_numeric: (v) => isNumericPhp(v),
    // PHP's `intval()`/`floatval()` ARE its casts — one canon with `(int)` and
    // `(float)`. The copy that lived here answered `intval('1e3')` = 1 where PHP
    // answers 1000 (a numeric string is its number, not its leading digits).
    intval: maxArgs((v, base = 10) => {
      // PHP: "the base has no effect unless the value is a string" —
      // `intval(20, 8)` is 20, not 16 (the old code re-read every value in the
      // given base and answered 16).
      if (typeof v !== 'string') return phpIntCast(v);
      const b = Math.trunc(Number(base));
      // PHP: a base outside 0/2..36 is ignored (the value is read base 10) —
      // `intval('0x1f', 1)` is 0, `intval('11', 37)` is 11.
      const eff = b === 0 || (b >= 2 && b <= 36) ? b : 10;
      if (eff === 10) return phpIntCast(v);
      let s = v.trim();
      let sign = 1;
      if (s[0] === '-') { sign = -1; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
      // Base 0 means "detect": 0x hex, 0b binary, a leading 0 octal, else decimal.
      let radix = eff;
      if (radix === 0) {
        if (s.startsWith('0x') || s.startsWith('0X')) { radix = 16; s = s.slice(2); }
        else if (s.startsWith('0b') || s.startsWith('0B')) { radix = 2; s = s.slice(2); }
        else if (s.startsWith('0')) { radix = 8; s = s.slice(1); }
        else radix = 10;
      } else if (radix === 16 && (s.startsWith('0x') || s.startsWith('0X'))) {
        s = s.slice(2);
      } else if (radix === 2 && (s.startsWith('0b') || s.startsWith('0B'))) {
        s = s.slice(2);
      }
      const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
      let out = 0;
      let i = 0;
      for (; i < s.length; i++) {
        const d = digits.indexOf(s[i].toLowerCase());
        if (d < 0) break;
        out = out * radix + d;
      }
      return i === 0 ? 0 : sign * out;
    }, 2, 'intval() takes a value and a base (PHP raises an ArgumentCountError for a third argument)'),
    floatval: phpFloatCast,
    doubleval: phpFloatCast,
    strval: (v) => phpStr(v),
    boolval: (v) => phpBool(v),

    // ---- url / path / environment
    parse_url: (v, c) => phpParseUrlComponent(v, c),
    // PHP's pair: rawurlencode() keeps `~` and encodes ' ' as %20 (RFC 3986),
    // urlencode() encodes ' ' as '+' and `~` as %7E (RFC 1738 form encoding).
    // Both encode the UTF-8 BYTES of the string, so a char above U+007F must be
    // percent-encoded per byte: the old urlencode() mapped one JS code unit at a
    // time, which wrote '%E9' for 'é' where PHP writes '%C3%A9' (and four hex
    // digits for a character outside Latin-1).
    rawurlencode: (s) => encodeURIComponent(phpStr(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    urlencode: (s) => {
      let out = '';
      for (const b of new TextEncoder().encode(phpStr(s))) {
        const c = String.fromCharCode(b);
        if (/[A-Za-z0-9_.-]/.test(c)) out += c;
        else if (c === ' ') out += '+';
        else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
      return out;
    },
    extension_loaded: (name) => EDGE_EXTENSIONS.has(phpStr(name).toLowerCase()),
    getenv: (name) => {
      if (name === undefined || name === null) return undefined; // the whole table is a refusal
      const key = phpStr(name);
      // getenv() reads the REAL process environment: vlucas/phpdotenv (the
      // default immutable repository) never calls putenv(), so a value that
      // only lives in .env is NOT visible to getenv() — env() is.
      return Object.prototype.hasOwnProperty.call(process.env, key) ? String(process.env[key]) : false;
    },
    file_exists: (p) => { try { return existsSync(abs(p)); } catch { return false; } },
    is_file: (p) => { try { return existsSync(abs(p)); } catch { return false; } },
    is_dir: (p) => { try { return existsSync(abs(p)); } catch { return false; } },
    realpath: (p) => {
      try {
        return realpathSync.native(abs(p)).replace(/\\/g, '/');
      } catch {
        return false; // PHP answers false for a path that does not exist
      }
    },
    dirname: (p) => {
      const s = phpStr(p);
      const cut = s.replace(/[\\/]+$/, '');
      const i = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'));
      if (i < 0) return '.';
      if (i === 0) return '/';
      return cut.slice(0, i);
    },
    basename: (p) => {
      const s = phpStr(p).replace(/[\\/]+$/, '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i < 0 ? s : s.slice(i + 1);
    },
    // A path helper PHP has that the evaluator already answers by name below
    // (`resource_path` etc. are handled in static.mjs, where appDir is known).
  };
}

export default {
  phpFuncs,
  PHP_CONSTANTS,
  PHP_CONSTANTS_REFUSED,
  PHP_REFUSED,
  phpBool,
  phpStr,
  phpTrim,
  phpIntCast,
  phpFloatCast,
  phpStringCast,
  phpArrayCast,
  phpNumberLiteral,
  phpBinaryOp,
  phpUnaryOp,
  phpCompare,
  phpIdentical,
  isNumericString,
  FoldRefusal,
};
