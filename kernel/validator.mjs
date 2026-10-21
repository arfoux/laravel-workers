// kernel/validator.mjs — Validator (zero-dep, async-capable)
//
// Laravel-compatible subset. Rules are parsed pipe-safely (regex bodies may
// contain `|`). `unique` / `exists` are resolved against D1 when a `db` binding
// is supplied (opts.db) or an explicit resolver (opts.unique / opts.exists).
// Unknown rules fail loud instead of silently passing.

// Illuminate\Translation's default messages (Laravel 13's lang/en/validation.php) and
// the placeholder replacement (Illuminate\Validation\ReplacesAttributes).
import {
  defaultValidationMessage,
  renderValidationMessage,
  LARAVEL_VALIDATION_MESSAGES,
} from './validation-messages.mjs';

// An uploaded file (the edge's file object).
function isUploadedFileValue(value) {
  return !!(value && typeof value === 'object' && value.__uploadedFile === true);
}

// The size of an uploaded file in kilobytes, exactly as Laravel's
// `(string) ($file->getSize() / 1024)`: a decimal string (the division by a
// power of two is exact, so the decimal expansion is exact too).
function fileSizeKb(size) {
  const bytes = BigInt(Math.trunc(Number(size) || 0));
  const whole = bytes / 1024n;
  const frac = (bytes % 1024n) * 9765625n; // 5^10: the /10^10 remainder
  return whole.toString() + '.' + frac.toString().padStart(10, '0');
}

// BigNumber::of($a)->isLessThanOrEqualTo($b) for two decimal strings.
function compareDecimal(a, b) {
  const parse = (value) => {
    const str = String(value).trim();
    const dot = str.indexOf('.');
    const int = (dot === -1 ? str : str.slice(0, dot)) || '0';
    const frac = dot === -1 ? '' : str.slice(dot + 1);
    return { int, frac };
  };
  const A = parse(a);
  const B = parse(b);
  const ai = BigInt(A.int);
  const bi = BigInt(B.int);
  if (ai !== bi) return ai < bi ? -1 : 1;
  const len = Math.max(A.frac.length, B.frac.length);
  const af = BigInt((A.frac + '0'.repeat(len)).slice(0, len) || '0');
  const bf = BigInt((B.frac + '0'.repeat(len)).slice(0, len) || '0');
  if (af === bf) return 0;
  return af < bf ? -1 : 1;
}

// The message of a rule: the table's entry, or the translator's key (Laravel
// returns the key itself when a rule has no message).
function ruleMessage(table, rule, type) {
  const raw = defaultValidationMessage(table, rule, type);
  if (raw !== null) return raw;
  return SIZE_RULES.has(rule) ? 'validation.' + rule + '.' + type : 'validation.' + rule;
}

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}
// Laravel's validateRequired (ValidatesAttributes.php:2168-2179): a string
// that is only whitespace is empty (PHP's trim strips " \t\n\r\0\x0B"), and
// so is an empty countable.
function isEmptyRequired(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '') === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object' && typeof v.length === 'number') return v.length < 1;
  return false;
}

// PHP's (string) cast: true becomes '1', false becomes '', null becomes ''.
function phpStringCast(value) {
  if (value === null || value === undefined) return '';
  if (value === true) return '1';
  if (value === false) return '';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'number' && !Number.isInteger(value)) {
    // PHP's float-to-string: the shortest representation that round-trips.
    return String(value);
  }
  return String(value);
}

// PHP's loose comparison (==) for the values a dependent rule compares.
function phpNumberEquals(num, str) {
  const s = String(str).trim();
  if (s === '') return num === 0;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return false; // PHP 8: a non-numeric string != a number
  return Number(s) === num;
}
function phpLooseEquals(a, b) {
  if (a === b) return true;
  const A = a === undefined ? null : a;
  const B = b === undefined ? null : b;
  if (A === null || B === null) {
    const other = A === null ? B : A;
    if (other === null) return true;
    if (typeof other === 'boolean') return !other;
    if (typeof other === 'number') return other === 0;
    if (typeof other === 'string') return other === '' || other === '0';
    return false;
  }
  if (typeof A === 'boolean' || typeof B === 'boolean') {
    const bool = typeof A === 'boolean' ? A : B;
    const other = typeof A === 'boolean' ? B : A;
    if (typeof other === 'number') return (bool ? 1 : 0) === other;
    if (typeof other === 'string') {
      if (other === '' || other === '0') return !bool;
      return bool;
    }
    return false;
  }
  if (typeof A === 'number' && typeof B === 'string') return phpNumberEquals(A, B);
  if (typeof A === 'string' && typeof B === 'number') return phpNumberEquals(B, A);
  return String(A) === String(B);
}

// The rules that need a minimum number of parameters (Laravel's
// requireParameterCount, ValidatesAttributes.php). A rule with too few
// parameters is an InvalidArgumentException in Laravel - a 500 - so the edge
// fails loud instead of answering something else.
const PARAMETER_COUNTS = {
  accepted_if: 2, declined_if: 2, between: 2, digits_between: 2,
  missing_if: 2, missing_unless: 2, present_if: 2, present_unless: 2,
  required_if: 2, required_unless: 2, prohibited_if: 2, prohibited_unless: 2,
  exclude_if: 2, exclude_unless: 2,
  before: 1, before_or_equal: 1, after: 1, after_or_equal: 1, array_keys: 1,
  date_format: 1, date_equals: 1, decimal: 1, different: 1, digits: 1,
  exists: 1, unique: 1, gt: 1, lt: 1, gte: 1, lte: 1, in_array: 1, max: 1, min: 1,
  missing_with: 1, missing_with_all: 1, multiple_of: 1, present_with: 1,
  present_with_all: 1, regex: 1, not_regex: 1, required_if_accepted: 1,
  required_if_declined: 1, prohibited_if_accepted: 1, prohibited_if_declined: 1,
  exclude_with: 1, exclude_without: 1, same: 1, size: 1,
};

function isNumericValue(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return true;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return true;
  return false;
}
function isIntegerValue(v) {
  if (typeof v === 'number') return Number.isInteger(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return true;
  return false;
}
function isBooleanLike(v) {
  return v === true || v === false || v === 1 || v === 0 || v === '1' || v === '0';
}

// Rules that carry no value check (modifiers / conditional-presence).
const MODIFIERS = new Set(['sometimes', 'nullable', 'bail', 'required', 'present', 'filled']);
const PRESENCE_RULES = new Set([
  'required', 'required_if', 'required_unless',
  'required_with', 'required_without', 'required_with_all', 'required_without_all',
  'prohibited', 'prohibited_if', 'prohibited_unless',
]);
const ASYNC_RULES = new Set(['unique', 'exists']);
const EXCLUDE_RULES = new Set(['exclude', 'exclude_if', 'exclude_unless', 'exclude_with', 'exclude_without']);
const MISSING_RULES = new Set(['missing', 'missing_if', 'missing_unless', 'missing_with', 'missing_with_all']);
const PRESENT_RULES = new Set(['present', 'present_if', 'present_unless', 'present_with', 'present_with_all']);
const KNOWN_RULES = new Set([
  ...MODIFIERS,
  ...PRESENCE_RULES,
  ...EXCLUDE_RULES,
  ...MISSING_RULES,
  ...PRESENT_RULES,
  ...ASYNC_RULES,
  'string', 'integer', 'numeric', 'boolean', 'array', 'email', 'url', 'date', 'alpha',
  'alpha_num', 'alpha_dash', 'min', 'max', 'between', 'size', 'in', 'not_in', 'same',
  'different', 'confirmed', 'regex', 'not_regex', 'accepted', 'accepted_if', 'declined',
  'digits', 'digits_between', 'multiple_of', 'uuid', 'ip', 'ipv4', 'ipv6', 'mac_address',
  'json', 'ascii', 'lowercase', 'uppercase', 'hex_color', 'starts_with', 'ends_with',
  'before', 'after', 'before_or_equal', 'after_or_equal', 'date_equals', 'date_format',
  'gt', 'gte', 'lt', 'lte', 'distinct',
  'doesnt_start_with', 'doesnt_end_with', 'list', 'required_array_keys', 'array_keys',
  'in_array', 'decimal', 'timezone',
  'file',
]);
// The validation rules that need the file's *content* type (finfo): the edge
// cannot sniff the content like PHP does, so they are not compiled (the build
// stops with LW002 and names the rule).
const CONTENT_MIME_RULES = new Set(['mimes', 'mimetypes', 'image', 'dimensions']);
// PHP `is_array()`: associative arrays arrive as plain JS objects, so an
// `Array.isArray()` check would miss `['string' => '...']` message maps.
const isPhpArray = (value) => typeof value === 'object' && value !== null;

// Illuminate\Validation\Validator::$sizeRules / $numericRules.
const SIZE_RULES = new Set(['size', 'between', 'min', 'max', 'gt', 'lt', 'gte', 'lte']);
const NUMERIC_RULES = new Set(['numeric', 'integer', 'decimal']);
const ARRAY_RULES = new Set(['array', 'list']);

// `preg_quote($sourceKey, '#')` + `str_replace('\*', '([^.]*)', ...)`: only
// JavaScript's regex syntax characters need escaping here (PCRE also escapes
// `-`, `:`, `#`, ... but a JS `u`-mode identity escape for those is a
// SyntaxError), then each `*` becomes one dot-free segment and `\z` becomes
// `$(?![\s\S])` so a trailing newline still fails.
const JS_REGEX_SYNTAX = /[\\^$.*+?()[\]{}|]/g;
function wildcardPattern(sourceKey) {
  const escaped = String(sourceKey).replace(JS_REGEX_SYNTAX, '\\$&');
  return new RegExp('^' + escaped.replace(/\\\*/g, '([^.]*)') + '$(?![\\s\\S])', 'u');
}

function parsePipeString(str) {
  if (!str) return [];
  const out = [];
  let i = 0;
  while (i < str.length) {
    let prefix = null;
    if (str.slice(i, i + 6) === 'regex:') prefix = 'regex:';
    else if (str.slice(i, i + 10) === 'not_regex:') prefix = 'not_regex:';
    if (prefix) {
      const start = i;
      let j = i + prefix.length;
      if (j < str.length && str[j] === '/') {
        j++; // past opening /
        let inClass = false;
        while (j < str.length) {
          const c = str[j];
          if (c === '\\') { j += 2; continue; }
          if (!inClass && c === '[') { inClass = true; j++; continue; }
          if (inClass && c === ']') { inClass = false; j++; continue; }
          if (!inClass && c === '/') break;
          j++;
        }
        if (j < str.length && str[j] === '/') {
          j++;
          while (j < str.length && /[a-zA-Z]/.test(str[j])) j++;
        }
        out.push(str.slice(start, j));
        i = j;
        if (i < str.length && str[i] === '|') i++;
        continue;
      }
      const next = str.indexOf('|', i);
      if (next === -1) { out.push(str.slice(i)); break; }
      out.push(str.slice(i, next));
      i = next + 1;
      continue;
    }
    const next = str.indexOf('|', i);
    if (next === -1) { out.push(str.slice(i)); break; }
    out.push(str.slice(i, next));
    i = next + 1;
  }
  return out.filter((s) => s.length > 0);
}
// PHP's str_getcsv($str, escape: '\\') — the parser Laravel uses for a rule's
// parameters (Illuminate\Validation\ValidationRuleParser::parseParameters).
// A quoted field keeps its commas, a doubled quote is one quote, the escape
// char makes the next char literal (and stays in the value), and nothing is
// trimmed. Ported from php-src's php_fgetcsv (ext/standard/file.c) with no
// stream to read on.
export function strGetcsv(str) {
  const s = String(str);
  // The line end (a trailing \r\n) is not part of the fields.
  let limit = s.length;
  if (limit > 0 && s[limit - 1] === '\n') limit--;
  if (limit > 0 && s[limit - 1] === '\r') limit--;
  const lineEnd = s.slice(limit);
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  const out = [];
  let bptr = 0;
  let incLen = 0;
  let first = true;
  do {
    incLen = bptr < limit ? 1 : 0;
    let field = '';
    // A field that starts with whitespace is an enclosed field only when the
    // whitespace is followed by the enclosure (PHP skips it then).
    if (incLen === 1) {
      let tmp = bptr;
      while (tmp < limit && s[tmp] !== ',' && isSpace(s[tmp])) tmp++;
      if (tmp < limit && s[tmp] === '"') bptr = tmp;
    }
    if (first && bptr === limit) return [null]; // a blank line
    first = false;
    if (incLen !== 0 && s[bptr] === '"') {
      // The enclosed field: state 0 = plain, 1 = escaped, 2 = a closing
      // enclosure to confirm.
      bptr++;
      let hunk = bptr;
      let state = 0;
      for (;;) {
        if (bptr >= limit) {
          if (state === 2) field += s.slice(hunk, bptr - 1);
          else if (state === 1) field += s.slice(hunk, bptr);
          else field += s.slice(hunk, bptr) + lineEnd;
          hunk = bptr;
          break;
        }
        if (state === 1) {
          // The escaped char is literal; the escape char stays in the value.
          bptr++;
          state = 0;
        } else if (state === 2) {
          if (s[bptr] !== '"') {
            // The enclosure closed the field.
            field += s.slice(hunk, bptr - 1);
            hunk = bptr;
            break;
          }
          // A doubled quote is one quote.
          field += s.slice(hunk, bptr);
          bptr++;
          hunk = bptr;
          state = 0;
        } else {
          if (s[bptr] === '"') state = 2;
          else if (s[bptr] === '\\') state = 1;
          bptr++;
        }
      }
      // The text after the closing enclosure, up to the delimiter.
      incLen = bptr < limit ? 1 : 0;
      for (;;) {
        if (incLen === 0) break;
        if (s[bptr] === ',') break;
        bptr += incLen;
        incLen = bptr < limit ? 1 : 0;
      }
      field += s.slice(hunk, bptr);
      bptr += incLen; // the delimiter
    } else {
      // The plain field: up to the delimiter.
      const start = bptr;
      for (;;) {
        if (incLen === 0) break;
        if (s[bptr] === ',') break;
        bptr += incLen;
        incLen = bptr < limit ? 1 : 0;
      }
      field = s.slice(start, bptr);
      if (bptr < limit && s[bptr] === ',') bptr++;
    }
    out.push(field);
  } while (incLen > 0);
  return out;
}

function parseRuleToken(token) {
  const idx = token.indexOf(':');
  // Laravel trims the rule NAME (parseStringRule: `Str::studly(trim($rule))`)
  // but not the parameter.
  if (idx === -1) return { name: token.trim().toLowerCase(), param: null, params: [], raw: token };
  const name = token.slice(0, idx).trim().toLowerCase();
  const param = token.slice(idx + 1);
  // Laravel keeps a regex rule's parameter raw; every other rule's parameters
  // are parsed as CSV.
  const params = (name === 'regex' || name === 'not_regex' || name === 'notregex')
    ? [param]
    : strGetcsv(param);
  return { name, param, params, raw: token };
}

// Illuminate\Validation\Concerns\ValidatesAttributes::validateDateFormat():
// `DateTime::createFromFormat('!'.$format, $value)` must succeed AND the
// re-formatted date must be the value (so '2026-13-01' is not a date, and
// '1-2-2026' does not match the format 'Y-m-d').
function daysInMonth(year, month) {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month !== 2) return days[month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

// Minimal date-format translator (Y y m n d j H G i s only — the common set).
function matchDateFormat(value, format) {
  if (typeof value !== 'string') return false;
  const fmt = String(format);
  const map = {
    Y: { rx: '\\d{4}', field: 'year' },
    y: { rx: '\\d{2}', field: 'year' },
    m: { rx: '\\d{2}', field: 'month' },
    n: { rx: '\\d{1,2}', field: 'month' },
    d: { rx: '\\d{2}', field: 'day' },
    j: { rx: '\\d{1,2}', field: 'day' },
    H: { rx: '\\d{2}', field: 'hour' },
    G: { rx: '\\d{1,2}', field: 'hour' },
    i: { rx: '\\d{2}', field: 'minute' },
    s: { rx: '\\d{2}', field: 'second' },
  };
  let rx = '';
  const tokens = [];
  for (const ch of fmt) {
    const spec = map[ch];
    if (spec) {
      rx += '(' + spec.rx + ')';
      tokens.push(ch);
    } else {
      rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  let m;
  try { m = new RegExp('^' + rx + '$').exec(value); } catch { return false; }
  if (!m) return false;
  const f = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  let twoDigitYear = null;
  tokens.forEach((ch, i) => {
    const n = Number(m[i + 1]);
    if (ch === 'y') { twoDigitYear = n; return; }
    f[map[ch].field] = n;
  });
  if (twoDigitYear !== null) f.year = twoDigitYear < 70 ? 2000 + twoDigitYear : 1900 + twoDigitYear;
  // The calendar: PHP rejects an impossible date.
  if (f.month < 1 || f.month > 12) return false;
  if (f.day < 1 || f.day > daysInMonth(f.year, f.month)) return false;
  if (f.hour > 23 || f.minute > 59 || f.second > 59) return false;
  // The round trip: the re-formatted date must be the value.
  let out = '';
  for (const ch of fmt) {
    const spec = map[ch];
    if (!spec) { out += ch; continue; }
    if (ch === 'Y') out += String(f.year).padStart(4, '0');
    else if (ch === 'y') out += String(f.year % 100).padStart(2, '0');
    else if (ch === 'm') out += String(f.month).padStart(2, '0');
    else if (ch === 'n') out += String(f.month);
    else if (ch === 'd') out += String(f.day).padStart(2, '0');
    else if (ch === 'j') out += String(f.day);
    else if (ch === 'H') out += String(f.hour).padStart(2, '0');
    else if (ch === 'G') out += String(f.hour);
    else if (ch === 'i') out += String(f.minute).padStart(2, '0');
    else if (ch === 's') out += String(f.second).padStart(2, '0');
  }
  return out === value;
}

function dateValue(v, data) {
  if (v === 'today') return new Date(new Date().toDateString());
  if (v === 'now') return new Date();
  if (v === 'tomorrow') return new Date(Date.now() + 86400000);
  if (v === 'yesterday') return new Date(Date.now() - 86400000);
  if (Object.prototype.hasOwnProperty.call(data, v)) return new Date(data[v]);
  return new Date(v);
}

// Dot-path helpers: Laravel validation addresses nested data as `a.b.0.c`, and
// wildcard rules (`items.*.name`) are expanded to those concrete paths.
function getIn(data, path) {
  let cur = data;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function hasIn(data, path) {
  let cur = data;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

function setIn(root, path, value) {
  const segs = String(path).split('.');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
}

// Illuminate\Support\Str::snake() (the part validation display names need):
// ctype_lower() strings pass through; otherwise ucwords -> strip whitespace ->
// insert `_` before each capital -> lower-case.
function phpSnake(value) {
  const str = String(value);
  if (str.length && /^[a-z]+$/.test(str)) return str;
  let v = str.replace(/(^|\s)([A-Za-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  v = v.replace(/\s+/gu, '');
  v = v.replace(/(.)(?=[A-Z])/gu, '$1_');
  return v.toLowerCase();
}

// Illuminate\Validation\Concerns\FormatsMessages::getAttributeFromLocalArray():
// exact key first, then `*` patterns (each star matches a dot-free segment).
function attributeFromLocalArray(attribute, source) {
  if (!source || typeof source !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(source, attribute) && source[attribute] != null) {
    return source[attribute];
  }
  for (const sourceKey of Object.keys(source)) {
    if (!String(sourceKey).includes('*')) continue;
    if (wildcardPattern(sourceKey).test(attribute)) return source[sourceKey];
  }
  return null;
}

// Illuminate\Validation\Concerns\FormatsMessages::replaceAttributePlaceholder()
// lives in kernel/validation-messages.mjs now (the renderer replaces the
// placeholders of every message, the custom ones included).

// PHP truthiness (`if ($inlineAttribute = ...)` in getDisplayableAttribute()):
// null/false/0/0.0/''/'0'/[] are falsy; everything else (including non-empty
// arrays and objects) is truthy. JavaScript's `if (custom)` differs on '0' and [].
function phpTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '' || value === '0') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export class Validator {
  constructor(data = {}, rules = {}, customMessages = {}, opts = {}) {
    this.data = data;
    this.rules = rules;
    this.customMessages = customMessages;
    this.opts = opts || {};
    this.parsed = {};
    // concrete field -> unparsed wildcard rule key (Laravel implicitAttributes)
    this._primary = {};
    this._implicit = new Set();
    for (const [field, raw] of Object.entries(rules)) {
      let arr;
      if (Array.isArray(raw)) arr = raw.map(String);
      else if (typeof raw === 'string') arr = parsePipeString(raw);
      else arr = [];
      const parsed = arr.map(parseRuleToken);
      for (const r of parsed) {
        // The rules that read the file's *content* type (finfo): the edge has
        // only the type the browser declared, so the verdict would differ from
        // PHP's. They fail loud instead of answering differently.
        if (CONTENT_MIME_RULES.has(r.name)) {
          throw new Error(
            'the ' + r.name + ' validation rule is not compiled: it reads the file\'s *content* type (finfo) and the edge ' +
              'cannot sniff the content like PHP does - use the file rule with max (the size in kilobytes) instead, ' +
              'or check the extension in the controller'
          );
        }
        if (!KNOWN_RULES.has(r.name)) {
          throw new Error('unknown validation rule: ' + r.name);
        }
        // Laravel's requireParameterCount: too few parameters is an
        // InvalidArgumentException (a 500) there - the edge fails loud too.
        const needed = PARAMETER_COUNTS[r.name];
        if (needed !== undefined && r.params.length < needed) {
          throw new Error(
            'the ' + r.name + ' validation rule requires at least ' + needed + ' parameter(s) (Laravel throws an InvalidArgumentException)'
          );
        }
      }
      if (String(field).includes('*')) this._implicit.add(field);
      for (const [concrete, rules] of this._expandField(field, parsed)) {
        this.parsed[concrete] = (this.parsed[concrete] || []).concat(rules);
        if (concrete !== field && !(concrete in this._primary)) this._primary[concrete] = field;
      }
    }
    this._errors = null;
    this._excluded = new Set();
    this._asyncDone = false;
  }

  // Expand a rule key containing `*` into concrete data paths (Laravel's
  // wildcard data addressing). Non-wildcard keys pass through unchanged.
  _expandField(field, parsed) {
    if (!String(field).includes('*')) return [[field, parsed]];
    const segs = String(field).split('.');
    const out = [];
    let seenStar = false;
    const walk = (idx, path) => {
      if (idx === segs.length) {
        out.push([path.join('.'), parsed]);
        return;
      }
      const seg = segs[idx];
      const container = path.length ? getIn(this.data, path.join('.')) : this.data;
      if (seg === '*') {
        if (container == null || typeof container !== 'object') return;
        seenStar = true;
        for (const key of Object.keys(container)) walk(idx + 1, [...path, key]);
        return;
      }
      if (container == null || typeof container !== 'object') return;
      // Before a wildcard the path must exist; after it, missing leaves are
      // still validated (Laravel reports `items.2.name` when an entry omits it).
      if (!seenStar && !Object.prototype.hasOwnProperty.call(container, seg)) return;
      walk(idx + 1, [...path, seg]);
    };
    walk(0, []);
    return out;
  }

  // Flat-first lookup, then dot-path resolution for nested/wildcard fields.
  get(field) {
    if (Object.prototype.hasOwnProperty.call(this.data, field)) return this.data[field];
    if (String(field).includes('.')) return getIn(this.data, field);
    return undefined;
  }

  _resolve(name) {
    const fn = this.opts && this.opts[name];
    return typeof fn === 'function' ? fn : null;
  }

  _isPresent(field) {
    if (Object.prototype.hasOwnProperty.call(this.data, field)) return this.data[field] !== undefined;
    if (String(field).includes('.')) return hasIn(this.data, field) && getIn(this.data, field) !== undefined;
    return false;
  }
  _empty(field) {
    return !this._isPresent(field) || isEmptyRequired(this.get(field));
  }

  // Laravel's parseDependentRuleParameters() (ValidatesAttributes.php:2472-2487)
  // and the comparison that uses it: the other field's value, the values (the
  // boolean conversion when the other field has a boolean rule or its value is
  // a bool, the null conversion when the value is null), and
  // `in_array($other, $values, is_bool($other) || is_null($other))` - strict
  // only for a bool/null.
  _dependentMatches(r) {
    const other = r.params[0];
    const otherValue = this.get(other);
    let values = r.params.slice(1);
    const otherRules = (this.parsed[other] || []).map((x) => x.name);
    if (otherRules.includes('boolean') || typeof otherValue === 'boolean') {
      values = values.map((v) => (String(v) === 'true' ? true : String(v) === 'false' ? false : v));
    }
    if (otherValue === null || otherValue === undefined) {
      values = values.map((v) => (String(v).toLowerCase() === 'null' ? null : v));
    }
    const strict = typeof otherValue === 'boolean' || otherValue === null || otherValue === undefined;
    return values.some((v) => (strict ? v === otherValue : phpLooseEquals(otherValue, v)));
  }

  _conditionalRequired(rules) {
    // returns { required: bool, failed: ruleName|null, failedParam } for presence rules
    for (const r of rules) {
      if (r.name === 'required') return { required: true, rule: 'required', param: null };
      if (r.name === 'required_if') {
        const other = r.params[0];
        const has = this._isPresent(other);
        if (has && this._dependentMatches(r)) {
          return { required: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'required_unless') {
        const other = r.params[0];
        const has = this._isPresent(other);
        if (!has || !this._dependentMatches(r)) {
          return { required: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'required_with') {
        const others = r.params;
        if (others.some((o) => !this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_without') {
        const others = r.params;
        if (others.some((o) => this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_with_all') {
        const others = r.params;
        if (others.every((o) => !this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_without_all') {
        const others = r.params;
        if (others.every((o) => this._empty(o))) return { required: true, rule: r.name, param: r.param };
      }
    }
    return { required: false };
  }

  _prohibited(rules) {
    for (const r of rules) {
      if (r.name === 'prohibited') return { prohibited: true };
      if (r.name === 'prohibited_if') {
        const other = r.params[0];
        if (this._isPresent(other) && this._dependentMatches(r)) {
          return { prohibited: true };
        }
      } else if (r.name === 'prohibited_unless') {
        const other = r.params[0];
        if (!this._isPresent(other) || !this._dependentMatches(r)) {
          return { prohibited: true };
        }
      }
    }
    return { prohibited: false };
  }

  // `exclude*` rules: when triggered the field is dropped from validated data
  // and no other rule for it runs (Laravel semantics).
  _excludeApplies(rules) {
    for (const r of rules) {
      const p = String(r.param == null ? '' : r.param);
      if (r.name === 'exclude') return true;
      if (r.name === 'exclude_if' || r.name === 'exclude_unless') {
        const other = r.params[0];
        const has = this._isPresent(other);
        const match = has && this._dependentMatches(r);
        if (r.name === 'exclude_if' ? match : !match) return true;
      } else if (r.name === 'exclude_with') {
        if (r.params.some((o) => this._isPresent(o))) return true;
      } else if (r.name === 'exclude_without') {
        if (r.params.every((o) => !this._isPresent(o))) return true;
      }
    }
    return false;
  }

  // `missing*` rules: the field must be absent (or empty) when triggered.
  _missingEnforced(rules) {
    for (const r of rules) {
      const p = String(r.param == null ? '' : r.param);
      if (r.name === 'missing') return { enforced: true, rule: 'missing', param: null };
      if (r.name === 'missing_if' || r.name === 'missing_unless') {
        const other = r.params[0];
        const has = this._isPresent(other);
        const match = has && this._dependentMatches(r);
        if (r.name === 'missing_if' ? match : !match) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'missing_with') {
        if (r.params.some((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'missing_with_all') {
        if (r.params.every((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      }
    }
    return { enforced: false };
  }

  // `present*` rules (beyond plain `present`): the field must be present.
  _presentEnforced(rules) {
    for (const r of rules) {
      const p = String(r.param == null ? '' : r.param);
      if (r.name === 'present_if' || r.name === 'present_unless') {
        const other = r.params[0];
        const has = this._isPresent(other);
        const match = has && this._dependentMatches(r);
        if (r.name === 'present_if' ? match : !match) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'present_with') {
        if (r.params.some((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'present_with_all') {
        if (r.params.every((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      }
    }
    return { enforced: false };
  }

  _ensureSync() {
    if (this._errors !== null) return;
    this._errors = {};
    for (const field of Object.keys(this.parsed)) {
      const fieldRules = this.parsed[field];
      const hasSometimes = fieldRules.some((r) => r.name === 'sometimes');
      const hasNullable = fieldRules.some((r) => r.name === 'nullable');
      const hasFilled = fieldRules.some((r) => r.name === 'filled');
      const hasPresent = fieldRules.some((r) => r.name === 'present');
      const bail = fieldRules.some((r) => r.name === 'bail');
      const isAbsent = !this._isPresent(field);
      const value = this.get(field);

      if (hasSometimes && isAbsent) continue;

      if (this._excludeApplies(fieldRules)) {
        this._excluded.add(field);
        continue;
      }

      const miss = this._missingEnforced(fieldRules);
      if (miss.enforced) {
        if (!isAbsent && !isEmptyValue(value)) this._addError(field, miss.rule, miss.param);
        continue;
      }

      const pres = this._presentEnforced(fieldRules);
      if (pres.enforced) {
        if (isAbsent) this._addError(field, pres.rule, pres.param);
        continue;
      }

      if (hasPresent && isAbsent) {
        this._addError(field, 'required', null);
        continue;
      }

      const req = this._conditionalRequired(fieldRules);
      if (req.required) {
        if (isEmptyRequired(value)) {
          this._addError(field, req.rule, req.param);
          continue;
        }
      } else if (isAbsent) {
        // prohibited still applies when present; absent is fine
        continue;
      }

      const proh = this._prohibited(fieldRules);
      if (proh.prohibited) {
        if (!isEmptyValue(value)) this._addError(field, 'prohibited', null);
        continue;
      }

      if (hasNullable && (value === null || value === '')) continue;
      if (isAbsent) continue;
      if (hasFilled && isEmptyRequired(value)) {
        // The rule name selects the message: Laravel's `filled` says "The
        // :attribute field must have a value." (not the `required` sentence).
        this._addError(field, 'filled', null);
        continue;
      }

      const hasNumeric = fieldRules.some((r) => r.name === 'numeric' || r.name === 'integer');

      for (const r of fieldRules) {
        if (MODIFIERS.has(r.name) || PRESENCE_RULES.has(r.name)) continue;
        if (EXCLUDE_RULES.has(r.name) || MISSING_RULES.has(r.name) || PRESENT_RULES.has(r.name)) continue;
        if (ASYNC_RULES.has(r.name)) continue; // handled async
        const ok = this._checkRule(field, value, r, hasNumeric);
        if (!ok) {
          this._addError(field, r.name, r.param);
          if (bail) break;
        }
      }
    }
  }

  async _resolveUniqueExists(field, value, rule, hasNumeric) {
    const parts = rule.params;
    const table = parts[0];
    // unique: table,column,except,idColumn. Laravel's rule object writes the
    // absent column AND the absent id as the string 'NULL'
    // (Unique::__toString()), and the validator reads both back: the column
    // falls back to the attribute's name (getQueryColumn,
    // ValidatesAttributes.php:1218) and the id means "no exception"
    // (DatabasePresenceVerifier::getCount: `! is_null($excludeId) &&
    // $excludeId !== 'NULL'`).
    let column = parts[1] !== undefined && parts[1] !== 'NULL' ? parts[1] : field;
    if (parts[1] === undefined || parts[1] === 'NULL') {
      // Laravel's guessColumnForQuery (:1229-1237): for an IMPLICIT attribute
      // (one the wildcard expanded) the column is the last dot segment
      // ('items.*.id' -> 'id'); every other attribute keeps its name.
      const primary = this._primary[field];
      if (primary && this._implicit.has(primary)) {
        const last = String(field).split('.').pop();
        if (!/^[0-9]+$/.test(last)) column = last;
      }
    }
    let except = parts[2] === 'NULL' || parts[2] === 'null' ? null : parts[2];
    if (typeof except === 'string') {
      // Laravel's prepareUniqueId (:1151-1155): a bracketed id ('[id]') is the
      // value of that field in the data - not the literal string.
      const m = /^\[(.*)\]$/.exec(except);
      if (m) except = this.get(m[1]);
    }
    const idColumn = parts[3] || 'id';
    const payload = { table, column, value, except, idColumn, count: 0 };

    const injected = this._resolve(rule.name);
    if (injected) {
      // Injected resolver contract: return whether the rule PASSES.
      return !!(await injected(payload));
    }
    const db = this.opts && this.opts.db;
    if (!db || typeof db.prepare !== 'function') {
      throw new Error(`validation rule "${rule.name}" needs opts.db or opts.${rule.name}`);
    }
    const ident = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    let sql = `SELECT COUNT(*) AS "aggregate" FROM ${ident(table)} WHERE ${ident(column)} = ?`;
    const bind = [value];
    if (rule.name === 'unique' && except !== undefined && except !== '') {
      sql += ` AND ${ident(idColumn)} != ?`;
      bind.push(except);
    }
    const stmt = db.prepare(sql);
    const bound = bind.length ? stmt.bind(...bind) : stmt;
    const row = (await (typeof bound.first === 'function' ? bound.first() : bound.all())) || {};
    const count = Number(row.aggregate ?? row['COUNT(*)'] ?? 0);
    payload.count = count;
    return rule.name === 'exists' ? count > 0 : count === 0;
  }

  async _runAsync() {
    if (this._asyncDone) return;
    this._ensureSync();
    for (const field of Object.keys(this.parsed)) {
      if (this._excluded.has(field)) continue;
      const fieldRules = this.parsed[field];
      const bail = fieldRules.some((r) => r.name === 'bail');
      const value = this.get(field);
      if (!this._isPresent(field)) continue;
      if (value === null || value === '') continue;
      // only run async checks when the field already has no error (or is not bailing)
      for (const r of fieldRules) {
        if (!ASYNC_RULES.has(r.name)) continue;
        if (bail && this._errors[field] && this._errors[field].length) break;
        const ok = await this._resolveUniqueExists(field, value, r);
        if (!ok) {
          this._addError(field, r.name, r.param);
          if (bail) break;
        }
      }
    }
    this._asyncDone = true;
  }

  _checkRule(field, value, rule, hasNumeric) {
    const p = rule.param;
    switch (rule.name) {
      case 'string': return typeof value === 'string';
      // Illuminate\Validation\Validator::validateFile(): a valid file instance.
      case 'file': return isUploadedFileValue(value) && value.isValid();
      case 'integer': return isIntegerValue(value);
      case 'numeric': return isNumericValue(value);
      case 'boolean': return isBooleanLike(value);
      case 'array': return Array.isArray(value);
      case 'email': return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      case 'url': {
        if (typeof value !== 'string') return false;
        try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
      }
      case 'date': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
      case 'alpha': return typeof value === 'string' && /^[A-Za-z]+$/.test(value);
      case 'alpha_num': return typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value);
      case 'alpha_dash': return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
      case 'accepted': return value === true || value === 1 || value === '1' || value === 'yes' || value === 'on' || value === 'true';
      case 'accepted_if': {
        const other = rule.params[0];
        if (this._isPresent(other) && this._dependentMatches(rule)) {
          return value === true || value === 1 || value === '1' || value === 'yes' || value === 'on' || value === 'true';
        }
        return true;
      }
      case 'declined': return value === false || value === 0 || value === '0' || value === 'no' || value === 'off' || value === 'false';
      case 'digits': return typeof value !== 'undefined' && /^\d+$/.test(String(value)) && String(value).length === Number(p);
      case 'digits_between': {
        const [a, b] = rule.params.map(Number);
        return /^\d+$/.test(String(value)) && String(value).length >= a && String(value).length <= b;
      }
      case 'multiple_of': {
        const n = Number(p);
        return isNumericValue(value) && n !== 0 && Number(value) % n === 0;
      }
      case 'uuid': return typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
      case 'ipv4': return typeof value === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((o) => Number(o) <= 255);
      case 'ipv6': return typeof value === 'string' && /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
      case 'ip': return this._checkRule(field, value, { name: 'ipv4' }, hasNumeric) || this._checkRule(field, value, { name: 'ipv6' }, hasNumeric);
      case 'mac_address': return typeof value === 'string' && /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(value);
      case 'json': {
        if (typeof value !== 'string') return false;
        try { JSON.parse(value); return true; } catch { return false; }
      }
      case 'ascii': return typeof value === 'string' && /^[\x00-\x7F]*$/.test(value);
      case 'lowercase': return typeof value === 'string' && value === value.toLowerCase();
      case 'uppercase': return typeof value === 'string' && value === value.toUpperCase();
      case 'hex_color': return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
      case 'starts_with': {
        // Laravel: `is_string($value) || is_numeric($value)` then
        // Str::startsWith((string) $value, $parameters) (ANY needle matches).
        const list = rule.params;
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        const str = phpStringCast(value);
        return list.some((s) => str.startsWith(phpStringCast(s)));
      }
      case 'ends_with': {
        const list = rule.params;
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        const str = phpStringCast(value);
        return list.some((s) => str.endsWith(phpStringCast(s)));
      }
      case 'before': {
        const v = new Date(value); const d = dateValue(p, this.data);
        return !Number.isNaN(v.getTime()) && !Number.isNaN(d.getTime()) && v < d;
      }
      case 'before_or_equal': {
        const v = new Date(value); const d = dateValue(p, this.data);
        return !Number.isNaN(v.getTime()) && !Number.isNaN(d.getTime()) && v <= d;
      }
      case 'after': {
        const v = new Date(value); const d = dateValue(p, this.data);
        return !Number.isNaN(v.getTime()) && !Number.isNaN(d.getTime()) && v > d;
      }
      case 'after_or_equal': {
        const v = new Date(value); const d = dateValue(p, this.data);
        return !Number.isNaN(v.getTime()) && !Number.isNaN(d.getTime()) && v >= d;
      }
      case 'date_equals': {
        const v = new Date(value); const d = dateValue(p, this.data);
        return !Number.isNaN(v.getTime()) && !Number.isNaN(d.getTime()) && v.getTime() === d.getTime();
      }
      case 'date_format': return matchDateFormat(value, p);
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const other = this.get(p);
        const num = hasNumeric && isNumericValue(value) && isNumericValue(other);
        const a = num ? Number(value) : (typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : NaN);
        const b = num ? Number(other) : (typeof other === 'string' ? other.length : Array.isArray(other) ? other.length : NaN);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        if (rule.name === 'gt') return a > b;
        if (rule.name === 'gte') return a >= b;
        if (rule.name === 'lt') return a < b;
        return a <= b;
      }
      case 'distinct': {
        if (!Array.isArray(value)) return true;
        const seen = new Set();
        for (const item of value) {
          const k = typeof item === 'object' ? JSON.stringify(item) : String(item);
          if (seen.has(k)) return false;
          seen.add(k);
        }
        return true;
      }
      case 'min': {
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        if (typeof size === 'string') return compareDecimal(size, p) >= 0;
        return size >= Number(p);
      }
      case 'max': {
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        if (typeof size === 'string') return compareDecimal(size, p) <= 0;
        return size <= Number(p);
      }
      case 'between': {
        const [a, b] = rule.params;
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        if (typeof size === 'string') return compareDecimal(size, a) >= 0 && compareDecimal(size, b) <= 0;
        return size >= Number(a) && size <= Number(b);
      }
      case 'size': {
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        if (typeof size === 'string') return compareDecimal(size, p) === 0;
        return size === Number(p);
      }
      case 'in': {
        // Laravel's validateIn (ValidatesAttributes.php:1558): the value is
        // cast with PHP's (string) (true -> '1', false -> '') and compared
        // strictly; with an `array` rule on the attribute every element is
        // checked instead.
        if (Array.isArray(value)) {
          const hasArrayRule = (this.parsed[field] || []).some((r) => r.name === 'array');
          if (!hasArrayRule) return false;
          return value.every((el) => !Array.isArray(el) && rule.params.includes(phpStringCast(el)));
        }
        return rule.params.includes(phpStringCast(value));
      }
      case 'not_in': {
        if (Array.isArray(value)) {
          const hasArrayRule = (this.parsed[field] || []).some((r) => r.name === 'array');
          if (!hasArrayRule) return true;
          return !value.every((el) => !Array.isArray(el) && rule.params.includes(phpStringCast(el)));
        }
        return !rule.params.includes(phpStringCast(value));
      }
      case 'same': return value === this.get(p);
      case 'different': return value !== this.get(p);
      case 'confirmed': return value === this.get(field + '_confirmation');
      case 'regex': {
        if (typeof value !== 'string') return false;
        let pattern = p, flags = '';
        if (p && p[0] === '/') {
          const last = p.lastIndexOf('/');
          pattern = p.slice(1, last);
          flags = p.slice(last + 1);
        }
        try { return new RegExp(pattern, flags).test(value); } catch { return false; }
      }
      case 'not_regex': {
        if (typeof value !== 'string') return false;
        let pattern = p, flags = '';
        if (p && p[0] === '/') {
          const last = p.lastIndexOf('/');
          pattern = p.slice(1, last);
          flags = p.slice(last + 1);
        }
        try { return !new RegExp(pattern, flags).test(value); } catch { return false; }
      }
      case 'doesnt_start_with': {
        const list = rule.params.filter((s) => s !== '');
        return !(typeof value === 'string') || !list.some((pre) => value.startsWith(pre));
      }
      case 'doesnt_end_with': {
        const list = rule.params.filter((s) => s !== '');
        return !(typeof value === 'string') || !list.some((suf) => value.endsWith(suf));
      }
      case 'list':
        return Array.isArray(value);
      case 'required_array_keys': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = rule.params;
        return keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
      }
      case 'array_keys': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = rule.params;
        return Object.keys(value).every((k) => keys.includes(k));
      }
      case 'in_array': {
        // `in_array:other` / `in_array:other.*` — value must be one of that array's values.
        const other = String(p == null ? '' : p).replace(/\.\*$/, '');
        const arr = this.get(other);
        return Array.isArray(arr) && arr.some((x) => String(x) === String(value));
      }
      case 'decimal': {
        // Illuminate\Validation\Concerns\ValidatesAttributes::validateDecimal():
        // the number of decimal places must be exactly the parameter (or
        // between the two parameters).
        if (!isNumericValue(value)) return false;
        const m = /^[+-]?\d*\.?(\d*)$/.exec(String(value));
        if (!m) return false;
        const decimals = m[1].length;
        const parts = rule.params;
        const min = Number(parts[0]);
        if (!Number.isFinite(min)) return false;
        if (parts.length < 2) return decimals === min;
        const max = Number(parts[1]);
        return decimals >= min && decimals <= max;
      }
      case 'timezone': {
        if (typeof value !== 'string') return false;
        try {
          if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
            return Intl.supportedValuesOf('timeZone').includes(value);
          }
        } catch { /* fall through to regex */ }
        return value === 'UTC' || /^[A-Za-z]+\/[A-Za-z_+\-0-9]+$/.test(value);
      }
      default:
        // Unknown rules are rejected at construction; reaching here is a bug.
        throw new Error('unhandled validation rule: ' + rule.name);
    }
  }

  _size(value, hasNumeric) {
    // An uploaded file: the size is in kilobytes (Laravel's
    // `(string) ($file->getSize() / 1024)`) and the comparison is exact
    // (BigNumber), so the size is a decimal string here.
    if (isUploadedFileValue(value)) return fileSizeKb(value.getSize());
    if (hasNumeric && isNumericValue(value)) return Number(value);
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
    return null;
  }

  // Illuminate\Validation\Validator::getPrimaryAttribute(): the unparsed
  // wildcard key that produced this concrete field.
  _primaryAttribute(attribute) {
    return this._primary[attribute] || attribute;
  }

  // Illuminate\Validation\Concerns\FormatsMessages::getDisplayableAttribute():
  // custom `$attributes` names first (exact concrete field, then primary wildcard
  // key, then wildcard patterns), otherwise implicit fields stay raw and plain
  // fields are humanised with Str::snake() + `_` -> space.
  _displayName(attribute) {
    const primary = this._primaryAttribute(attribute);
    const names = attribute !== primary ? [attribute, primary] : [attribute];
    const source = this.opts.attributes || {};
    for (const name of names) {
      const custom = attributeFromLocalArray(name, source);
      // PHP: `if ($inlineAttribute = ...)` — falsy names fall through.
      if (phpTruthy(custom)) return String(custom);
    }
    if (this._implicit.has(primary)) return String(attribute);
    return phpSnake(attribute).replace(/_/g, ' ');
  }

  // Illuminate\Validation\Concerns\FormatsMessages::getFromLocalArray() for the
  // `$messages` array: keys tried are `field.rule`, `rule`, `field`, and a
  // wildcard source key expands each `*` to one dot-free segment. Returns the
  // raw inline entry exactly like getFromLocalArray() does — the size-rule
  // attribute-type resolution happens in _addError (getInlineMessage).
  _customMessage(field, rule) {
    const lowerRule = phpSnake(rule);
    const keys = [`${field}.${lowerRule}`, lowerRule, field];
    for (const key of keys) {
      for (const sourceKey of Object.keys(this.customMessages || {})) {
        const message = this.customMessages[sourceKey];
        if (String(sourceKey).includes('*')) {
          if (wildcardPattern(sourceKey).test(key)) {
            return isPhpArray(message) ? message[lowerRule] ?? null : message;
          }
          continue;
        }
        if (sourceKey === key) {
          return sourceKey === field && isPhpArray(message) ? message[lowerRule] ?? null : message;
        }
      }
    }
    return null;
  }

  // Illuminate\Validation\Concerns\FormatsMessages::getAttributeType(): the
  // numeric rules win over array/list; an uploaded file is a file; everything
  // else is a string.
  _attributeType(field) {
    const rules = this.parsed[field] || [];
    if (rules.some((r) => NUMERIC_RULES.has(r.name))) return 'numeric';
    if (rules.some((r) => ARRAY_RULES.has(r.name))) return 'array';
    const value = this.get(field);
    if (isUploadedFileValue(value)) return 'file';
    if (value && typeof value === 'object' && typeof File !== 'undefined' && value instanceof File) return 'file';
    return 'string';
  }

  _addError(field, rule, param) {
    const display = this._displayName(field);
    // The message placeholders take the rule's parameters the way Laravel
    // parses them (CSV, except for a regex rule's raw parameter).
    const parsedParams = param === null || param === undefined
      ? []
      : (rule === 'regex' || rule === 'not_regex' || rule === 'notregex'
        ? [String(param)]
        : strGetcsv(String(param)));
    let msg = this._customMessage(field, rule);
    const type = this._attributeType(field);
    const lowerRule = phpSnake(rule);
    // getInlineMessage(): a size rule's array message is keyed by attribute type.
    if (isPhpArray(msg) && SIZE_RULES.has(lowerRule)) {
      msg = msg[type] ?? null;
    }
    // Laravel checks `is_null($inlineMessage)`, so an empty custom message is
    // kept (it becomes an empty error string), unlike a JS truthiness check.
    if (msg == null) {
      // The default message: the app's own lang file (dumped at build time)
      // else the framework's copy.
      const table = this.opts.defaultMessages && typeof this.opts.defaultMessages === 'object'
        ? this.opts.defaultMessages
        : LARAVEL_VALIDATION_MESSAGES;
      msg = ruleMessage(table, lowerRule, type);
    }
    // makeReplacements(): the placeholders (':attribute', ':max', ':values', ...).
    msg = renderValidationMessage(msg, {
      attribute: field,
      display,
      rule: lowerRule,
      params: parsedParams,
      displayOf: (other) => this._displayName(other),
      valueOf: (other) => this.get(other),
      data: this.data,
    });
    if (!this._errors[field]) this._errors[field] = [];
    this._errors[field].push(msg);
  }

  async passes() {
    this._ensureSync();
    await this._runAsync();
    return Object.keys(this._errors).length === 0;
  }
  async fails() {
    return !(await this.passes());
  }
  errors() {
    this._ensureSync();
    return this._errors;
  }
  validated() {
    this._ensureSync();
    const out = {};
    for (const field of Object.keys(this.parsed)) {
      if (this._excluded.has(field)) continue;
      if (this._errors[field] && this._errors[field].length > 0) continue;
      const value = this.get(field);
      if (value === undefined) continue;
      // Dotted (nested/wildcard) fields are re-nested; flat keys stay flat.
      if (String(field).includes('.') && !Object.prototype.hasOwnProperty.call(this.data, field)) {
        setIn(out, field, value);
      } else {
        out[field] = value;
      }
    }
    return out;
  }
}

export async function validate(data, rules, messages, opts) {
  const v = new Validator(data, rules, messages, opts);
  const ok = await v.passes();
  return { ok, errors: v.errors(), validated: v.validated() };
}

export default { Validator, validate };
