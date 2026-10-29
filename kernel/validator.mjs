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
import { imageInfo } from './image.mjs';
import { str as strHelpers } from './str.mjs';

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
// `BigNumber::of($a)->isGreaterThan($b)` etc. for two decimal strings: -1/0/1,
// and `null` when a side is not a number (the caller answers false, like the
// `catch (MathException|BrickMathException)` arms do). brick/math reads
// exponent notation (`'1e3'`), so it is expanded before the plain-decimal
// comparison.
function expandExponent(str) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(str);
  if (m === null) return str;
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] || '0';
  const frac = m[3] || '';
  const exp = Number(m[4]);
  const digits = int + frac;
  const point = int.length + exp;
  if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
}
function cmpBig(a, b) {
  if (!isNumericValue(a) || !isNumericValue(b)) return null;
  return compareDecimal(expandExponent(phpTrim(String(a))), expandExponent(phpTrim(String(b))));
}
// `isSameType($first, $second)` (ValidatesAttributes.php:2912): `gettype()`
// equality, narrowed to the types the validator can meet - a numeric string is
// a string, an int differs from a float, and `true` is a boolean.
function samePhpType(a, b) {
  const t = (v) => (Array.isArray(v) ? 'array'
    : v === null || v === undefined ? 'null'
      : typeof v === 'boolean' ? 'boolean'
        : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'double')
          : 'string');
  return t(a) === t(b);
}

// `BigDecimal::of($a)->mod($b)->isZero()` for two plain decimal strings: scale
// both to a common number of fractional digits and test the integer remainder.
function decimalModIsZero(a, b) {
  const parse = (s) => {
    const str = /^[+-]/.test(s) ? s : '+' + s;
    const sign = str[0] === '-';
    const body = str.slice(1);
    const dot = body.indexOf('.');
    const int = dot === -1 ? body : body.slice(0, dot);
    const frac = dot === -1 ? '' : body.slice(dot + 1);
    return { sign, int: int === '' ? '0' : int, frac };
  };
  const A = parse(a);
  const B = parse(b);
  const scale = Math.max(A.frac.length, B.frac.length);
  const ai = BigInt(A.int + A.frac.padEnd(scale, '0'));
  const bi = BigInt(B.int + B.frac.padEnd(scale, '0'));
  const av = A.sign ? -ai : ai;
  const bv = B.sign ? -bi : bi;
  if (bv === 0n) return false;
  return av % bv === 0n;
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

// PHP's `is_numeric()`: a decimal with an optional leading/trailing whitespace
// run, an optional sign and an optional exponent. Hex and binary strings are NOT
// numeric (PHP 7 dropped them), and neither are 'INF'/'NAN'/'1_000'.
const NUMERIC_LIKE_RE = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
function isNumericLike(value) {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return NUMERIC_LIKE_RE.test(value);
}

// PCRE -> JS for a user-supplied `regex:`/`not_regex:` pattern. Only the parts
// that change the ANSWER are translated: PCRE's `$` without the `D` modifier (and
// its `\Z`) also match immediately before a FINAL newline, and `\z` is the
// absolute end - a bare JS `$` is `\z` (and `\z` is not a JS escape at all).
// `A` anchors the whole match at the start. The behavior-neutral PCRE-only flags
// are dropped so a pattern that uses them still compiles.
// `D` is honored while translating the `$` anchor, `U` while swapping the
// quantifier laziness, then dropped: they must not reach `new RegExp`.
const PCRE_DROPPED_FLAGS = /[SXJnDU]/g;
// PHP accepts only these modifiers; anything else (`g`, `y`, `e`, a typo) makes
// preg_match() answer FALSE, so a pattern carrying one must not compile here.
const PHP_MODIFIERS = /^[imsxuADSUXJn]*$/;
// PCRE-only escapes that JS would read as the literal LETTER (`\X` = 'X'). Each is
// either translated exactly (`PCRE_CLASSES` outside a class, `PCRE_MEMBERS` inside
// one) or refused, so a rule can never answer with a silently different meaning.
// `s`/`S` are ASCII-only without the `u` modifier while JS's `\s` is Unicode-wide;
// with `u` PCRE turns on UCP, where `\d` is `\p{Nd}` (JS's `\d` stays ASCII).
const PCRE_CLASSES = {
  R: '(?:\\r\\n|[\\n\\v\\f\\r\\x85])', // any newline sequence (default PCRE2_NEWLINE)
  N: '[^\\n]',
  h: '[\\t\\x20\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000]',
  H: '[^\\t\\x20\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000]',
  v: '[\\n\\v\\f\\r\\x85]',
  V: '[^\\n\\v\\f\\r\\x85]',
  s: '[ \\t\\n\\r\\v\\f]', // PHP's preg has no UCP unless `u` is set
  S: '[^ \\t\\n\\r\\v\\f]',
  d: '\\p{Nd}', // under `u`
  D: '\\P{Nd}',
};
// The same escapes as class MEMBERS, for use inside `[...]`, where a nested class
// or a negation cannot be expressed (those refuse the pattern instead).
const PCRE_MEMBERS = {
  h: '\\t\\x20\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000',
  v: '\\n\\v\\f\\r\\x85',
  s: ' \\t\\n\\r\\v\\f',
  d: '\\p{Nd}',
  D: '\\P{Nd}',
};
// Escapes with no exact JS equivalent at all: refuse rather than mismatch. `\p`/
// `\P` are added when the `u` modifier is absent (JS reads them as 'p'/'P').
const PCRE_REFUSED_ESCAPES = new Set(['X', 'K', 'G', 'g', 'C', 'Q', 'E']);
// A `/body/flags` parameter compiles through the PCRE translation above; anything
// else is a bare body (Laravel hands the whole parameter to preg_match, so a
// parameter without delimiters is a compile error there too - answer false).
function compileUserPattern(param) {
  if (typeof param !== 'string' || param[0] !== '/') return null;
  const last = param.lastIndexOf('/');
  if (last <= 0) return null;
  const { pattern, flags } = translatePcrePattern(param.slice(1, last), param.slice(last + 1));
  if (pattern === null) return null;
  try { return new RegExp(pattern, flags); } catch { return null; }
}
// `preg_match()` returns false (never 1) for a pattern PCRE cannot compile; a
// stray delimiter such as `/foo/bar` is not a pattern, so the rule answers false
// for both spellings. `append`/`prepend` translation is in translatePcrePattern.
function translatePcrePattern(body, flags) {
  // A modifier PHP does not know (`g`, `y`, a typo) is a preg error, not a flag:
  // refuse the whole pattern so `regex:` answers false like PHP does.
  if (!PHP_MODIFIERS.test(flags)) return { pattern: null, flags: '' };
  const multiline = flags.includes('m');
  const absolute = flags.includes('D');
  const dotAll = flags.includes('s');
  const ungreedy = flags.includes('U');
  const utf8 = flags.includes('u');
  let out = '';
  let inClass = false;
  let classJustOpened = false;
  let bareDelimiter = false;
  // Whether the previous member can take a quantifier - only needed for `U`.
  let atom = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === undefined) return { pattern: null, flags: '' };
      if (!inClass) {
        if (next === 'z') { out += '(?![\\s\\S])'; i += 1; atom = true; continue; }
        if (next === 'Z') { out += '(?=\\n?$)'; i += 1; atom = true; continue; }
        if (next === 'A') { out += '(?<![\\s\\S])'; i += 1; atom = true; continue; }
      }
      // `s`/`S` are mapped only without `u`, `d`/`D` only with it; the native JS
      // spelling is already exact in the other case (and `.*`-style behaviour for
      // `\w` under UCP is a documented limit).
      const gated =
        next === 's' || next === 'S' ? !utf8 : next === 'd' || next === 'D' ? utf8 : true;
      if (gated && PCRE_CLASSES[next] !== undefined) {
        if (inClass) {
          if (PCRE_MEMBERS[next] === undefined) return { pattern: null, flags: '' };
          out += PCRE_MEMBERS[next];
        } else {
          out += PCRE_CLASSES[next];
        }
        classJustOpened = false;
        atom = true;
        i += 1;
        continue;
      }
      if (PCRE_REFUSED_ESCAPES.has(next)) return { pattern: null, flags: '' };
      if ((next === 'p' || next === 'P') && !utf8) return { pattern: null, flags: '' };
      out += ch + next;
      // An escape is a complete member, so it also ends the "first member" state.
      if (inClass) classJustOpened = false;
      atom = true;
      i += 1;
      continue;
    }
    if (inClass) {
      // `]` closes the class unless it is the first member (`[]a]`, `[^]a]`) - PCRE
      // reads those as a class holding `]` and `a`, while JS reads `[]` as an empty
      // class, so the leading member is escaped for JS. A leading `^` negates and
      // keeps the position (see `[^]a]`).
      const first = classJustOpened;
      classJustOpened = false;
      if (first && ch === '^') { out += ch; classJustOpened = true; continue; }
      if (first && ch === ']') { out += '\\]'; continue; }
      if (ch === ']') inClass = false;
      // PHP is not class-aware when it looks for the closing delimiter, so a bare
      // `/` here ends the pattern early - a compile error there too.
      if (ch === '/') bareDelimiter = true;
      out += ch;
      continue;
    }
    if (ch === '[') { inClass = true; classJustOpened = true; out += ch; atom = false; continue; }
    if (ch === '/') { bareDelimiter = true; out += ch; continue; }
    if (ch === '$' && !multiline && !absolute) { out += '(?=\\n?$)'; atom = true; continue; }
    // PCRE's `.` is "any character except newline" regardless of `\r`; JS's `.`
    // also excludes CR, LS and PS.
    if (ch === '.') { out += dotAll ? '[\\s\\S]' : '[^\\n]'; atom = true; continue; }
    // `U` inverts each quantifier's laziness; the marker is the NEXT character, so
    // `a*?` under `U` becomes `a*`.
    if (ungreedy && atom && (ch === '*' || ch === '+' || ch === '?' || ch === '{')) {
      let quant = ch;
      if (ch === '{') {
        const brace = /^\{\d+(?:,\d*)?\}/.exec(body.slice(i));
        if (brace === null) { out += ch; atom = true; continue; }
        quant = brace[0];
        i += brace[0].length - 1;
      }
      if (body[i + 1] === '?') i += 1;
      else quant += '?';
      out += quant;
      atom = false;
      continue;
    }
    out += ch;
    atom = !(ch === '(' || ch === '|' || ch === '^');
  }
  if (bareDelimiter) return { pattern: null, flags: '' }; // a stray delimiter -> compile error
  let jsFlags = flags.replace(PCRE_DROPPED_FLAGS, '');
  let pattern = out;
  if (jsFlags.includes('A')) {
    jsFlags = jsFlags.replace(/A/g, '');
    pattern = '^(?:' + pattern + ')';
  }
  return { pattern, flags: jsFlags };
}

// PHP's (string) cast: true becomes '1', false becomes '', null becomes ''.
function phpStringCast(value) {
  if (value === null || value === undefined) return '';
  if (value === true) return '1';
  if (value === false) return '';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'number' && !Number.isInteger(value)) return phpFloatToString(value);
  return String(value);
}
// PHP's float-to-string with the default `precision=14` (php.ini): the shortest
// of `%.14G` and `%.17G` that round-trips, using the `E+NN` / `E-NN` exponent
// form (`-1e-300` prints as `-1.0E-300`, not JS's `-1e-300`). This matters
// wherever the validator casts a float with `(string)` - e.g. `alpha_dash` sees
// the `.` and fails, while a raw `String(value)` would wrongly pass.
function phpFloatToString(value) {
  if (!Number.isFinite(value)) return value > 0 ? 'INF' : (value < 0 ? '-INF' : 'NAN');
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  // PHP's float-to-string cast uses `precision=14` unconditionally (it does NOT
  // pick the shortest round-tripping form - `(string) 0.3333333333333333` is the
  // 14-digit `0.33333333333333`).
  return formatPhpG(value, 14);
}
// PHP's `%.{p}G` for a non-zero finite float: `toPrecision` already picks the
// fixed vs exponential form the way `%G` does (exponential only when the
// decimal exponent is < -4 or >= p). The result is normalised to PHP's spelling:
// an `E+`/`E-` exponent with no leading zero, a mantissa that keeps at least
// one fractional digit, and no trailing zeros.
// PHP's `%.{p}G`: the exponential form is used when the decimal exponent is
// `< -4` or `>= p`, otherwise the fixed form. The mantissa keeps a `.0` in the
// exponential form (`1.0E+16`) and drops trailing zeros otherwise. (PHP's
// `zend_gcvt` rounds half-to-even at the last digit, which JS `toPrecision`
// rounds half-away; a value landing exactly on the p-th digit can therefore
// differ in the last place - a documented limit.)
function formatPhpG(value, precision) {
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp < -4 || exp >= precision) {
    return normalizePhpExponential(value.toExponential(precision - 1));
  }
  const digits = Math.max(precision - 1 - exp, 0);
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
function normalizePhpExponential(text) {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (m === null) return text;
  const frac = (m[3] || '').replace(/0+$/, '');
  const mant = frac === '' ? m[2] + '.0' : m[2] + '.' + frac;
  return m[1] + mant + 'E' + m[4];
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
  present_with_all: 1, regex: 1, not_regex: 1, notregex: 1, required_if_accepted: 1,
  required_if_declined: 1, prohibited_if_accepted: 1, prohibited_if_declined: 1,
  exclude_with: 1, exclude_without: 1, same: 1, size: 1,
};

// Laravel's `image` list (ValidatesAttributes::validateImage(): jpg, jpeg,
// png, gif, bmp, webp, avif, heic, heif) mapped onto the formats the edge's
// header read recognises.
const IMAGE_RULE_FORMATS = new Set(['png', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'heic', 'heif']);

// `$value->getMimeType()` is image/svg+xml: an SVG is XML text, so the edge
// looks for the root element instead of a binary header.
function looksLikeSvg(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  let head = '';
  const limit = Math.min(bytes.length, 2048);
  for (let i = 0; i < limit; i++) head += String.fromCharCode(bytes[i]);
  return /<\s*svg[\s>]/i.test(head.replace(/^\uFEFF/, ''));
}

// ValidatesAttributes::failsBasicDimensionChecks() (:832-840) +
// failsRatioCheck()/failsMinRatioCheck()/failsMaxRatioCheck() (:850-909),
// verbatim: `ratio`/`min_ratio`/`max_ratio` are `n/d` (a bare `n` means n/1)
// and the tolerance is 1 / (max((w+h)/2, h) + 1).
function failsDimensionChecks(params, width, height) {
  const named = {};
  for (const param of params) {
    const at = param.indexOf('=');
    if (at < 0) {
      throw new Error('the dimensions rule parameter "' + param + '" must be name=value');
    }
    named[param.slice(0, at)] = param.slice(at + 1);
  }
  const num = (v) => Number(v);
  const basic =
    ('width' in named && num(named.width) !== width) ||
    ('min_width' in named && num(named.min_width) > width) ||
    ('max_width' in named && num(named.max_width) < width) ||
    ('height' in named && num(named.height) !== height) ||
    ('min_height' in named && num(named.min_height) > height) ||
    ('max_height' in named && num(named.max_height) < height);
  if (basic) return true;
  const ratioOf = (value) => {
    const parts = String(value).split('/');
    const numerator = parts.length ? Number(parts[0]) : 1;
    const denominator = parts.length > 1 ? Number(parts[1]) : 1;
    return [Number.isFinite(numerator) ? numerator : 1, Number.isFinite(denominator) ? denominator : 1];
  };
  const precision = 1 / (Math.max((width + height) / 2, height) + 1);
  if ('ratio' in named) {
    const [n, d] = ratioOf(named.ratio);
    if (Math.abs(n / d - width / height) > precision) return true;
  }
  if ('min_ratio' in named) {
    const [n, d] = ratioOf(named.min_ratio);
    if (n / d - width / height > precision) return true;
  }
  if ('max_ratio' in named) {
    const [n, d] = ratioOf(named.max_ratio);
    if (width / height - n / d > precision) return true;
  }
  return false;
}

// PHP's `is_numeric()` - the single "is this a number" test the validator uses
// (ValidatesAttributes::shouldBeNumeric(), validateAlphaNum(), validateSize(),
// the `(string)` casts, ...). PHP accepts surrounding whitespace, an optional
// sign, integer/decimal/exponent forms and any digit run (`'0123'`, `'1e400'`),
// but NOT hex/binary literals, underscores, or the words `Infinity`/`NaN` -
// all of which a bare JS `Number()` would happily read as numbers.
const PHP_NUMERIC_RE = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
function isNumericValue(v) {
  if (typeof v === 'number') return !Number.isNaN(v);
  if (typeof v === 'string') return PHP_NUMERIC_RE.test(v);
  return false;
}
// ValidatesAttributes::validateInteger() (:1625-1632): without the `strict`
// parameter the rule is `filter_var($value, FILTER_VALIDATE_INT) !== false` -
// a boolean casts like any PHP value (`true` is `1`), a float must be integral,
// a STRING may carry surrounding whitespace and a sign but never a leading zero
// (`'02'`/`'1.0'`/`'1e3'` are failures) and must fit in the 64-bit int range.
function isFilterVarInt(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= -9223372036854775808 && value <= 9223372036854775807;
  }
  if (typeof value !== 'string') return false;
  const m = /^[ \t\n\r\v\f]*([+-]?)(\d+)[ \t\n\r\v\f]*$/.exec(value);
  if (m === null) return false;
  if (m[2].length > 1 && m[2][0] === '0') return false;
  const n = BigInt(m[1] + m[2]);
  return n >= -9223372036854775808n && n <= 9223372036854775807n;
}
function isBooleanLike(v, params = []) {
  // ValidatesAttributes::validateBoolean() (:536-545): the acceptable list is
  // `[true, false, 0, 1, '0', '1']` compared STRICTLY, and the `strict`
  // parameter narrows it to the booleans themselves (`boolean:strict` makes
  // `1` and `'1'` failures). The edge ignored the parameter.
  if (Array.isArray(params) && params[0] === 'strict') return v === true || v === false;
  return v === true || v === false || v === 1 || v === 0 || v === '1' || v === '0';
}

// egulias' EmailLexer classifies every byte: an unreserved byte that is a
// symbol, other or control byte is INVALID, the punctuation below is a token of
// its own (the map in EmailLexer::$charValue) and anything else is GENERIC.
const EMAIL_INVALID_BYTE = /[\p{S}\p{C}\p{Cc}]/u;
const EMAIL_TOKEN_CHARS = new Set([
  ...'{}()<>[]\\/:;,."\'`-*!&^%~|_=+?#@$', ' ', '\t', '\r', '\n', '\u00a1', '\u00bf',
]);
function emailByteKind(ch) {
  if (ch === '\0') return 'nul'; // EmailLexer::C_NUL - its own token, never INVALID
  if (EMAIL_TOKEN_CHARS.has(ch)) return 'token';
  return EMAIL_INVALID_BYTE.test(ch) ? 'invalid' : 'generic';
}
// LocalPart::INVALID_TOKENS (:21-31): the tokens an unquoted local part refuses.
const EMAIL_LOCAL_INVALID = new Set([',', '[', ']', '<', '>', ':', ';']);
// `Parser\DoubleQuote`: a quoted string swallows everything up to the closing
// quote - a `\` escapes the next byte, an unescaped `"` ends it, and a control
// byte (INVALID class / C_NUL / HTAB) is refused. Returns the index just past
// the closing quote, or -1 when the string never closes.
function emailQuotedEnd(str, start) {
  // checkDQUOTE() refuses a quoted string that is glued to a GENERIC byte on BOTH
  // sides (`a"b"@c.com`, `q"a¿b"@c.com` fail) - a `"` at the start of the part,
  // after a separator or at the very end of the part is fine.
  const before = str[start - 1];
  const inside = str[start + 1];
  if (before !== undefined && inside !== undefined
    && emailByteKind(before) === 'generic' && emailByteKind(inside) === 'generic') return -1;
  // The matching quote is found by finding a SEPARATOR-aware close (see below);
  // the parser then requires the byte after the close to be the separator `@`
  // (the `@` is the end of the local slice).
  const close = emailQuotedClose(str, start);
  if (close === -1) return -1;
  const after = str[close];
  if (after !== undefined && after !== '@') return -1;
  return close;
}
// Locates the closing `"` the way DoubleQuote does: an escape (a backslash, its
// next byte skipped, though only an escaped `"` is really consumed) and a
// quoted-pair (`|` its escaped byte, if a QUOTED-PAIR) are the only ways past a
// quote. A `"` is therefore a close only when the byte before the current
// position is not a backslash and not a `|` that escaped something.
function emailQuotedClose(str, start) {
  let first = true;
  for (let i = start + 1; i < str.length; i += 1) {
    const ch = str[i];
    if (!first && (ch === '\0' || ch === '\t' || ch === '\r' || ch === '\n')) return -1;
    if (ch === '\\') { i += 1; first = false; continue; } // an escaped byte is skipped
    if (ch === '"') return i + 1;
    first = false;
  }
  return -1;
}
// `Parser\Comment` + `Parser\CommentStrategy\DomainComment`: the comment
// swallows bytes until it is balanced AND the next byte is a `.`, which must
// then be present - `a@b(c)d.com` passes (the swallowed `d` is never validated)
// while `a@b(c)` fails with ExpectingATEXT('DOT not found ...').
function emailDomainCommentEnd(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return -1; } // UnOpenedComment
    if (depth === 0 && str[i + 1] === '.') return i + 1;
  }
  return -1;
}
// `EmailParser` splits the address at the FIRST `@` the LocalPart loop hands to
// DomainPart. That loop walks TOKENS, and a quoted string is consumed wholesale
// by DoubleQuote, so an `@` inside the quotes is never seen as the separator
// (`"@x"@c.com` passes). Returns -1 when a quoted string never closes, or when
// it closes somewhere other than the separator (DoubleQuote's own
// ExpectingATEXT between DQUOTE).
function emailAtPosition(chars) {
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '"') {
      const end = emailQuotedEnd(chars, i);
      if (end === -1) return -1;
      i = end - 1;
      continue;
    }
    // A `(` starts a comment, and the comment's loop consumes tokens itself -
    // the LocalPart body only tests for a quote/comment at the TOP of an
    // iteration, so anything the comment swallows (a `"` included) is never
    // handed to DoubleQuote (`a(b)c"@d.com` passes).
    if (ch === '(') {
      const end = emailLocalCommentEnd(chars, i);
      if (end === -1) return -1;
      if (chars[end] === '@') return end;
      i = end - 1;
      continue;
    }
    if (ch === '@') return i;
  }
  return -1;
}
// `Comment::parse()` with the LocalComment strategy: the loop stops as soon as
// the NEXT token is the separator `@` (or the input ends), counting `(`/`)` on
// the way. Returns the index of the stopping byte (the `@`, or the length).
function emailLocalCommentEnd(chars, start) {
  let depth = 0;
  for (let j = start; j < chars.length; j += 1) {
    const c = chars[j];
    // Comment::parse() counts parens unconditionally - a `\` does NOT escape
    // them (`}()\{@9` still closes the comment).
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth < 0) return -1; } // UnOpenedComment
    if (j + 1 >= chars.length || chars[j + 1] === '@') return j + 1;
  }
  return chars.length;
}
// `Parser\LocalPart`: DomainPart::parse() only looks for a ConsecutiveAt AFTER
// the local part, so a `@` that sits inside the local part is consumed by the
// quoted-string/comment rules above (`"a@b"@c.com` passes the oracle, because
// DoubleQuote walks to the first `"` after the `@`).
function emailLocalPart(local) {
  let empty = true; // LocalPart::hasDotAtStart() looks at the preceding token
  let escapedNext = false; // FoldingWhiteSpace::isFWS() ignores an escaped byte
  for (let i = 0; i < local.length; i += 1) {
    const ch = local[i];
    const wasEscaped = escapedNext;
    escapedNext = false;
    if (ch === '"') {
      const end = emailQuotedEnd(local, i);
      // The closing quote must be followed by the `@` that ends the local part
      // (`"a"x@c.com` and `"a"(b)@c.com` are refused by the oracle).
      if (end === -1 || end !== local.length) return false;
      empty = false;
      i = end - 1;
      continue;
    }
    if (ch === '(') {
      // Comment::parse() + LocalComment: the comment's loop stops as soon as the
      // NEXT token is the `@` separator, so it swallows everything from the `(`
      // up to the byte before that `@` (`a(b)x@c.com`, `}()\{@9`). The LocalPart
      // body then resumes with the last swallowed byte as `current`, running its
      // own dot/token checks on it (`a(b).@c.com` is DotAtEnd, `a(b,)@c.com`
      // passes because the comment stopped on `)`).
      let depth = 0;
      let j = i;
      for (; j < local.length; j += 1) {
        const c = local[j];
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth < 0) return false; } // UnOpenedComment
      }
      if (depth !== 0) return false; // UnclosedComment
      const tail = local[j - 1];
      if (tail === '.') return false; // DotAtEnd
      // `::` is ONE token (S_DOUBLECOLON) that validateTokens() accepts, so an
      // even run of trailing colons is fine (`a(b)::@c.com`) while an odd run
      // ends on a lone `:` and fails (`a(b):::@c.com`).
      let colons = 0;
      for (let k = j - 1; k >= i && local[k] === ':'; k -= 1) colons += 1;
      if (colons % 2 === 1) return false; // Invalid token found (S_COLON)
      if (colons === 0 && EMAIL_LOCAL_INVALID.has(tail)) return false; // Invalid token
      empty = false;
      i = j - 1;
      continue;
    }
    if (ch === ')') return false; // UnOpenedComment
    if (ch === '.') {
      if (empty || local[i - 1] === '.' || i === local.length - 1) return false;
      empty = false;
      continue;
    }
    // `::` is matched as ONE token by the lexer (EmailLexer::$charValue), so a
    // lone `:` is INVALID_TOKENS while a pair is not (`a::b@c.com` passes,
    // `a:b@c.com` and `a:::@c.com` fail).
    if (ch === ':') {
      if (local[i + 1] !== ':') return false; // Invalid token found (S_COLON)
      empty = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      // LocalPart::validateEscaping(): a backslash may not escape a GENERIC byte
      // (`a\x.b@c.com` fails, `a\.b@c.com` passes - the escaped byte is then
      // validated by the next turn of the loop, like the oracle does).
      const next = local[i + 1];
      // next === undefined means the backslash is the LAST local byte, i.e. the
      // next token is the `@` separator - not GENERIC, so it is accepted
      // (`\@x` and `a\@b` pass, while `a\x@c.com` fails).
      if (next !== undefined && emailByteKind(next) === 'generic') return false;
      empty = false;
      escapedNext = true;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !wasEscaped) {
      // FoldingWhiteSpace::parse(): whitespace is legal only when the next token
      // is not a GENERIC byte (`a @c.com` passes, `a b@c.com` fails - but an
      // escaped `\ ` is not FWS and is validated as an ordinary byte). A CR/LF
      // is already refused outright by Laravel's own validateEmail().
      const next = local[i + 1];
      if (next !== undefined && emailByteKind(next) === 'generic') return false;
      empty = false;
      continue;
    }
    const kind = emailByteKind(ch);
    if (kind === 'invalid' || (kind === 'token' && EMAIL_LOCAL_INVALID.has(ch))) return false;
    empty = false;
  }
  return true;
}
// `Parser\DomainPart` + `Parser\DomainLiteral`: dot-separated labels of GENERIC
// bytes, or a bracketed literal entered at ANY `[` (the bracket is not required
// to follow the `@`: `a@b[cd]` passes). The literal swallows the text between the
// first `[` and the first `]`; the junk after the `]` is never examined
// (`a@[x]y` passes) unless the very next byte is another `[` (`a@[x][y` fails).
function emailHost(host) {
  // The domain is the bytes AFTER the separator, and the parser only ever starts
  // at the byte following the `@`: an empty domain (or one that is only SP) has
  // no part of its own (`a@ ` is NoDomainPart, `a@\t` is Invalid token in
  // domain) - so a trailing SP/HTAB cannot be a valid domain either.
  if (host.length === 0) return false;
  if (host.length === 1 && (host[0] === ' ' || host[0] === '\t')) return false;
  // checkDomainPartExceptions()/validateTokens(): only GENERIC bytes, `-` and
  // `.` are domain tokens ('_', '¡' ... are refused by the oracle). SP/HTAB are
  // never valid domain tokens either (`a@ x` fails with ExpectingATEXT), even
  // though the FWS parser accepts them.
  let label = ''; // the accumulated label starts with the dot, like DomainPart
  for (let i = 0; i < host.length; i += 1) {
    const ch = host[i];
    if (ch === '(') {
      // Comment::parse() + DomainComment: the comment swallows bytes until it is
      // balanced AND the next byte is a `.`, which must then be present.
      const next = emailDomainCommentEnd(host, i);
      if (next === -1) return false;
      i = next - 1; // resume on the `.` the comment required
      continue;
    }
    if (ch === ')') return false; // UnOpenedComment
    if (ch === '[') {
      // doParseDomainPart(): an OPENBRACKET anywhere in the domain switches to
      // parseDomainLiteral() and RETURNS - the loop's own token checks never see
      // the bracket (`a@b[cd]` and `a@b.[x]` are valid like `a@[x]`).
      //
      // parseDomainLiteral() first `find('[CLOSEBRACKET]')` on a clone, so a
      // missing `]` is an ExpectingDomainLiteralClose; DomainLiteral::parse()
      // then swallows bytes up to the FIRST `]` (the "next token is `[`" test
      // runs BEFORE the `]` test, so a second `[` - nested or right after the
      // closing bracket - is an ExpectingDTEXT failure: `a@[[x]]`, `a@[x][y]`
      // and `a@[x][` all fail).
      const close = host.indexOf(']', i + 1);
      if (close === -1) return false; // ExpectingDomainLiteralClose
      if (host.slice(i + 1, close).includes('[')) return false; // ExpectingDTEXT
      if (host[close + 1] === '[') return false; // ExpectingDTEXT (next token)
      if (!emailDomainLiteral(host, i, close)) return false;
      // DomainPart::parse() then runs checkEndOfDomain() on the literal's own
      // tokens: `$prev` is the byte just before the closing bracket, so a
      // trailing `.` or `-` inside the brackets fails (`a@[x.]`, `a@[x-]`),
      // while `a@[.x]` and `a@[x-y]` pass. The junk after `]` is never examined
      // (`a@[x]y`, `a@[]-b`).
      const last = host[close - 1];
      if (last === '.' || last === '-') return false; // DotAtEnd / DomainHyphened
      return true;
    }
    if (ch === '.') {
      if (i === 0 || host[i - 1] === '.') return false; // DotAtStart / ConsecutiveDot
      if (i === host.length - 1) return false; // DotAtEnd
      if (label.length > 63) return false; // LabelTooLong ('...' counts the dot)
      label = '.';
      continue;
    }
    if (ch === '-') {
      // DomainHyphened: never right after `@`, never right before a `.` (near
      // DOT) and never at the end of the domain.
      if (i === 0 || host[i + 1] === '.' || i === host.length - 1) return false;
    }
    if (emailByteKind(ch) !== 'generic' && ch !== '-') return false;
    label += ch;
  }
  if (label.length > 63) return false;
  return true;
}
// `Parser\DomainLiteral`: a NUL or a backslash inside the brackets is an
// ExpectingDTEXT failure; SP/HTAB are FWS; every other byte must not be an
// EmailLexer INVALID byte. The `[` test runs before the `]` test in the parser's
// loop, so nested brackets are rejected by the caller.
function emailDomainLiteral(host, open, close) {
  for (let i = open + 1; i < close; i += 1) {
    const ch = host[i];
    if (ch === '\\' || ch === '\0') return false;
    if (ch === ' ' || ch === '\t') continue;
    // `::` is one token the literal's loop never tests (`a@[::]` passes); a lone
    // `:` there is not rejected either.
    if (ch === ':') { if (host[i + 1] === ':') i += 1; continue; }
    if (emailByteKind(ch) === 'invalid') return false;
  }
  return true;
}

// ValidatesAttributes::validateDate() (:623-640) is `strtotime($value) !== false`
// AND `checkdate(date_parse($value)['month'|'day'|'year'])`. Both halves matter:
// a value whose calendar components do not exist FAILS ('2026-02-30',
// 'Feb 30 2026', '30-02-2026') even though JS `Date.parse` rolls the day over,
// while a real d-m-Y string PHP reads fine ('20-02-2026') PASSES even though JS
// refuses it. `Date.parse` stays the fallback for every shape this grammar does
// not recognize (the named-month and relative forms).
const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
// PHP's timezone abbreviations and regions (`strtotime` validates the name, so a
// trailing word like 'junk' is a failure, not a zone).
const TZ_ABBREV = new Set(['ut', 'utc', 'gmt', 'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'pst', 'pdt', 'akst', 'akdt', 'hst', 'hdt', 'ast', 'adt', 'nst', 'ndt', 'cet', 'cest', 'eet', 'eest', 'wet', 'west', 'bst', 'ist', 'jst', 'kst', 'aest', 'aedt', 'acst', 'acdt', 'awst', 'acwst', 'msk', 'msd', 'nzst', 'nzdt', 'chst', 'sst', 'hkt', 'sgt', 'wib', 'wita', 'wit', 'z']);
const TZ_REGION = new Set(['africa', 'america', 'antarctica', 'arctic', 'asia', 'atlantic', 'australia', 'europe', 'indian', 'pacific', 'etc']);
function zoneIsValid(zone) {
  if (zone === '') return true;
  if (/^(?:z|[+-]\d{2}:?\d{2}|[+-]\d{1,2}|gmt[+-]?\d{1,2}(?::?\d{2})?|am|pm)$/i.test(zone)) return true;
  const slash = zone.indexOf('/');
  const region = (slash === -1 ? zone : zone.slice(0, slash)).toLowerCase();
  const city = slash === -1 ? null : zone.slice(slash + 1);
  if (city !== null) return TZ_REGION.has(region) && /^[A-Za-z_+-]+$/.test(city);
  return TZ_ABBREV.has(region);
}
// The tail after the date: empty, a clock time (with an optional zone) or a bare
// zone. `null` means "not a tail PHP's `strtotime` would accept".
function dateTail(rest) {
  let t = rest.replace(/^\s+|\s+$/g, '');
  if (t === '') return { h: 0, i: 0, s: 0 };
  t = t.replace(/^[Tt]\s*/, '');
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?/.exec(t);
  if (tm === null) return zoneIsValid(t) ? { h: 0, i: 0, s: 0 } : null;
  return zoneIsValid(t.slice(tm[0].length).trim())
    ? { h: +tm[1], i: +tm[2], s: +(tm[3] ?? 0) }
    : null;
}
// `true`/`false` when the value is a date shape PHP's grammar covers, `null`
// when the shape is unknown (the caller keeps the `Date.parse` answer).
function phpDateVerdict(value) {
  // `strtotime` refuses the dotted YEAR-first form ('2026.02.28') that a JS
  // `Date` reads; the dotted day-first form ('28.02.2026') is fine.
  if (/^\d{4}\./.test(value)) return false;
  let y; let m; let d; let tail;
  const first = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})([\s\S]*)$/.exec(value);
  const last = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})([\s\S]*)$/.exec(value);
  if (first) {
    y = +first[1]; m = +first[2]; d = +first[3]; tail = first[4];
  } else if (last) {
    // `/` is m/d/Y (US); `-` and `.` are d-m-Y (ISO/German) - PHP refuses the
    // dotted YEAR-first form ('2026.02.28') but reads '28.02.2026'.
    const slash = value.includes('/');
    y = +last[3]; m = +(slash ? last[1] : last[2]); d = +(slash ? last[2] : last[1]); tail = last[4];
  } else {
    const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})([\s\S]*)$/.exec(value)
      || /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})([\s\S]*)$/.exec(value);
    if (named === null) return null;
    const dayFirst = /^\d/.test(value);
    const month = MONTH_NUM[(dayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    y = +named[3];
    m = month;
    d = +(dayFirst ? named[1] : named[2]);
    tail = named[4];
  }
  const time = dateTail(tail);
  if (time === null) return false;   // a tail `strtotime` refuses ('junk', ' 10')
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return false;
  // `strtotime` accepts hour 24 (it rolls into the next day) but not 25.
  return time.h <= 24 && time.i <= 59 && time.s <= 59;
}

// `validateDate()`'s tail: `date_parse($value)` then `checkdate()` on the
// resulting month/day/year. PHP sets those to 0 when the string carries only a
// time or a relative word, so `checkdate` fails - the value must name a real
// calendar date (`'2026-10-30'`, `'30-10-2026'`, `'@0'`, `'2026-10-30T…'`).
function isDateValidValue(value) {
  const str = phpStringCast(value);
  if (phpTimestampIsReadable(str) === false) return false;
  const at = /^\s*@(-?\d+)/.exec(str);
  if (at !== null) {
    const ts = Number(at[1]);
    const d = new Date(ts * 1000);
    return checkdatePhp(d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCFullYear());
  }
  const first = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str);
  if (first !== null) return checkdatePhp(Number(first[2]), Number(first[3]), Number(first[1]));
  const last = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(str);
  if (last !== null) {
    const slash = str.includes('/');
    const m = Number(slash ? last[1] : last[2]);
    const d = Number(slash ? last[2] : last[1]);
    return checkdatePhp(m, d, Number(last[3]));
  }
  const named = /^\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(str)
    || /^\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(str);
  if (named !== null) {
    const dayFirst = /^\s*\d/.test(str);
    const mon = MONTH_NUM[(dayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase()];
    if (mon === undefined) return false;
    return checkdatePhp(mon, Number(dayFirst ? named[1] : named[2]), Number(named[3]));
  }
  return false;
}
// `strtotime($value) === false`: this reuses the date grammar and adds the
// numeric/relative forms PHP reads but the grammar does not model.
function phpTimestampIsReadable(str) {
  if (/^\s*(now|today|tomorrow|yesterday)\s*$/i.test(str)) return true;
  const verdict = phpDateVerdict(str);
  if (verdict !== null) return verdict !== false;
  if (isNumericValue(str)) return strtotimeNumericReads(str);
  return !Number.isNaN(Date.parse(str));
}
// The subset of numeric strings PHP's `strtotime` accepts: a sign, a fraction
// or a 3-4 digit run read as HHMM/HMM; the bare integers `'0'`/`'00'`/`'1'`
// are NOT times (`strtotime('0') === false`).
function strtotimeNumericReads(str) {
  const s = str.trim();
  if (s === '' || /^[+-]?(0+|0*\.0*)$/.test(s)) return false;
  if (/^[+-]/.test(s)) return true;
  if (s.includes('.') || /[eE]/.test(s)) return true;
  const digits = s.replace(/^0+/, '');
  return digits.length >= 3;
}
// PHP's `checkdate($month, $day, $year)`.
function checkdatePhp(month, day, year) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return false;
  if (year < 1 || year > 32767) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}
// `is_array($value)`: a JS array or a plain object (a PHP assoc array), but not
// a null/scalar/class instance (a `Date`, a Collection with methods, ...).
function isPhpArrayValue(value) {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}
// `array_is_list($value)`: keys are `0..n-1` in order. A JS array always is; a
// plain object only when its keys are exactly `0..n-1`.
function isPhpListValue(value) {
  if (Array.isArray(value)) return true;
  if (!isPhpArrayValue(value)) return false;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== String(i)) return false;
  }
  return true;
}
// `validateRequired` and `presentOrRuleIsImplicit` use.
function phpTrim(value) {
  return String(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}
// `mb_strlen($value)` - the CODE POINT count, not the UTF-16 unit count that
// `String.length` gives (`'😀'` is 1, `'é'` written as a combining pair is 2).
function phpMbStrlen(value) {
  const str = String(value);
  let count = 0;
  for (const _ of str) count += 1;
  return count;
}

// `filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)`: four decimal
// octets, no leading zero (`01.2.3.4` is rejected) and each up to 255.
function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part[0] === '0') return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

// `filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)`: hex groups of up
// to four digits, at most one `::` (which must compress at least one group),
// exactly eight groups otherwise, and an optional trailing dotted quad that
// counts as the last two groups ('::ffff:192.168.0.1' is valid).
function isIpv6(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('%')) return false; // a zone id is not part of the address
  let head = value;
  if (head.includes('.')) {
    const at = head.lastIndexOf(':');
    if (at < 0) return false;
    if (!isIpv4(head.slice(at + 1))) return false;
    head = head.slice(0, at + 1) + '0:0';
  }
  const hexGroup = /^[0-9a-fA-F]{1,4}$/;
  const parts = head.split('::');
  if (parts.length > 2) return false;
  const groupsOf = (s) => (s === '' ? [] : s.split(':'));
  if (parts.length === 2) {
    const left = groupsOf(parts[0]);
    const right = groupsOf(parts[1]);
    return (
      left.every((g) => hexGroup.test(g)) &&
      right.every((g) => hexGroup.test(g)) &&
      left.length + right.length < 8
    );
  }
  const only = groupsOf(parts[0]);
  return only.length === 8 && only.every((g) => hexGroup.test(g));
}

// PHP's `Arr::dot()`: the nested data flattened to dotted keys with the leaf
// values (the shape `distinct` reads out of the data).
function phpDot(data, prefix = '', out = {}) {
  if (data === null || typeof data !== 'object') {
    if (prefix) out[prefix] = data;
    return out;
  }
  for (const key of Object.keys(data)) {
    const path = prefix ? prefix + '.' + key : key;
    const value = data[key];
    if (value !== null && typeof value === 'object') phpDot(value, path, out);
    else out[path] = value;
  }
  return out;
}

// Illuminate\Validation\Validator::$implicitRules (:207-231): the rules that
// still run when the attribute is absent or holds an empty (whitespace-only)
// string.
const IMPLICIT_RULES = new Set([
  'accepted', 'accepted_if', 'declined', 'declined_if', 'filled',
  'missing', 'missing_if', 'missing_unless', 'missing_with', 'missing_with_all',
  'present', 'present_if', 'present_unless', 'present_with', 'present_with_all',
  'required', 'required_if', 'required_if_accepted', 'required_if_declined',
  'required_unless', 'required_with', 'required_with_all',
  'required_without', 'required_without_all',
]);

// Rules that carry no value check (modifiers / conditional-presence).
const MODIFIERS = new Set(['sometimes', 'nullable', 'bail', 'required', 'present', 'filled']);
const PRESENCE_RULES = new Set([
  'required', 'required_if', 'required_unless',
  'required_with', 'required_without', 'required_with_all', 'required_without_all',
  'required_if_accepted', 'required_if_declined',
  'prohibited', 'prohibited_if', 'prohibited_unless',
  'prohibited_if_accepted', 'prohibited_if_declined',
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
  'different', 'confirmed', 'regex', 'not_regex', 'notregex', 'accepted', 'accepted_if', 'declined', 'declined_if',
  'digits', 'digits_between', 'multiple_of', 'uuid', 'ip', 'ipv4', 'ipv6', 'mac_address',
  'json', 'ascii', 'lowercase', 'uppercase', 'hex_color', 'starts_with', 'ends_with',
  'before', 'after', 'before_or_equal', 'after_or_equal', 'date_equals', 'date_format',
  'gt', 'gte', 'lt', 'lte', 'distinct',
  'doesnt_start_with', 'doesnt_end_with', 'list', 'required_array_keys', 'array_keys',
  'in_array', 'decimal', 'timezone',
  'file', 'image', 'dimensions',
  // Implemented with the vendor semantics in _checkRule():
  'base64', 'ulid', 'contains', 'doesnt_contain', 'in_array_keys',
  'max_digits', 'min_digits', 'prohibits', 'extensions',
]);
// The validation rules that need the file's *content* type (finfo): the edge
// cannot sniff the content like PHP does, so they are not compiled (the build
// stops with LW002 and names the rule).
const CONTENT_MIME_RULES = new Set(['mimes', 'mimetypes']);
// PHP `is_array()`: associative arrays arrive as plain JS objects, so an
// `Array.isArray()` check would miss `['string' => '...']` message maps.
// `is_array()` is FALSE for any object with a class: a model, an uploaded
// file, a Collection. `contains`/`in_array_keys` answer false for those
// (oracle: `contains:a` on a stdClass FAILS), so a class instance must not
// be read through Object.values().
const isPhpArray = (value) =>
  Array.isArray(value) ||
  (typeof value === 'object' &&
    value !== null &&
    value.__uploadedFile !== true &&
    value.__lwResource !== true &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));

// Illuminate\Validation\Validator::$sizeRules / $numericRules.
const SIZE_RULES = new Set(['size', 'between', 'min', 'max', 'gt', 'lt', 'gte', 'lte']);
// ValidatesAttributes::shouldBeNumeric() is invoked by these four rules only -
// they are the ones that re-read a numeric value through `getSize()`.
const COMPARISON_RULES = new Set(['gt', 'gte', 'lt', 'lte']);
const NUMERIC_RULES = new Set(['numeric', 'integer', 'decimal']);
const ARRAY_RULES = new Set(['array', 'list']);

// `preg_quote($sourceKey, '#')` + `str_replace('\*', '([^.]*)', ...)`: only
// JavaScript's regex syntax characters need escaping here (PCRE also escapes
// `-`, `:`, `#`, ... but a JS `u`-mode identity escape for those is a
// SyntaxError), then each `*` becomes one dot-free segment and `\z` becomes
// `$(?![\s\S])` so a trailing newline still fails.
//
// The segment is a parameter: the validation's wildcards match ONE dot-free
// segment, while Illuminate\Support\Str::is() (the MessageBag's wildcard
// lookup) lets the `*` span the dots.
const JS_REGEX_SYNTAX = /[\\^$.*+?()[\]{}|]/g;
function wildcardPattern(sourceKey, segment = '([^.]*)') {
  const escaped = String(sourceKey).replace(JS_REGEX_SYNTAX, '\\$&');
  return new RegExp('^' + escaped.replace(/\\\*/g, segment) + '$(?![\\s\\S])', 'u');
}

// Laravel explodes a STRING rule set with a naive `explode('|', $rule)`
// (ValidationRuleParser::explodeExplicitRule :92-96): EVERY pipe ends a rule,
// escaped or not (probed on 13.37: 'regex:/^a\\|b$/' -> ['regex:/^a\\','b$/']),
// so `regex:/^(a|b)$/` and `in:"a|b"` split into a rule that has no validateX()
// method - BadMethodCallException in PHP. The edge mirrors it exactly.
// The ARRAY form is NOT split: each element goes through prepareRule(), so the
// FormRequest dump's array rule sets keep their alternations and quoted
// commas. A string rule set that needs a pipe inside a parameter is written as
// an array - the same string that works at the edge works in PHP.
function splitRuleString(str) {
  return String(str).split('|');
}
// PHP's str_getcsv($str, escape: '\\') — the parser Laravel uses for a rule's
// parameters (Illuminate\Validation\ValidationRuleParser::parseParameters).
// A quoted field keeps its commas, a doubled quote is one quote, the escape
// char makes the next char literal (and stays in the value), and nothing is
// trimmed. Ported from php-src's php_fgetcsv (ext/standard/file.c) with no
// stream to read on.
const strIsUrl = strHelpers.isUrl;

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

// `getDateTime($value)` (ValidatesAttributes.php:366-373) = `Date::parse()`
// (Carbon) or null; the caller then reads `?->getTimestamp()`. A `null` here
// means "Carbon rejected it", which `compareDates()` turns into `compare(0, ..)`
// - that is why `'abc'` PASSES `before:2026-01-01` (0 < ts) yet FAILS `after`.
//
// Carbon's own numeric branch (Creator.php:79) treats a NON-`\d{1,14}` numeric
// string as a UNIX timestamp with a quirky reader (getIntegerAndDecimalParts):
// the string is split on every non-digit/non-dot run and each chunk contributes
// its integer AND fractional parts, so `'1e3'` is 1+3 = 4 seconds and `'1e300'`
// is 1+300 = 301. Pure `\d{1,14}` digit strings skip that branch and go to the
// parent DateParser, which reads `HHMM`/`HHMMSS`/`HHMMSS+` like a wall clock
// (`'1234'` -> today 12:34, `'0123'` -> today 01:23).
function carbonTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined; // Carbon raises a TypeError
    // Carbon's `createFromTimestampUTC` builds a `U u` string; a value past
    // 1e14 overflows that format and raises an uncaught
    // `InvalidFormatException` (a 500 on a real request).
    if (Math.abs(value) >= 1e14) {
      const err = new Error('Unexpected data found.');
      err.name = 'InvalidFormatException';
      throw err;
    }
    return Math.trunc(value);
  }
  if (typeof value !== 'string') return null;
  const raw = value;
  // `'@…'` is an explicit UNIX timestamp.
  const at = /^\s*@(-?[\d.]+)\s*$/.exec(raw);
  if (at !== null) return Math.trunc(Number(at[1]));
  if (isNumericValue(raw)) {
    // `\d{1,14}` (no sign, no dot, no exponent): the parent DateParser handles
    // it as a clock time / compact date, NOT as a timestamp.
    if (!/^\d{1,14}$/.test(raw)) {
      let integer = 0;
      let decimal = 0;
      for (const chunk of raw.split(/[^\d.]+/)) {
        if (chunk === '') continue;
        const [ip, dp = ''] = chunk.split('.');
        integer += Number.parseInt(ip === '' ? '0' : ip, 10) || 0;
        decimal += Number.parseFloat('0.' + dp) || 0;
      }
      const overflow = Math.floor(decimal);
      integer += overflow;
      const signed = raw.trimStart().startsWith('-') ? -integer : integer;
      // `createFromTimestampUTC` builds a `U u` string; past 1e14 that format
      // overflows and Carbon raises `InvalidFormatException`, which
      // `getDateTime()` swallows into a null (the caller then compares 0).
      if (Math.abs(signed) >= 1e14) return null;
      return signed;
    }
  }
  // Parent DateParser path: relative words, absolute shapes, and the compact
  // digit runs PHP reads as a clock time or date (`'1234'` -> today 12:34,
  // `'123456'` -> today 12:34:56, `'20261030'` -> 2026-10-30); any other pure
  // digit run is a parse failure.
  const rel = /^\s*(now|today|tomorrow|yesterday)\s*$/i.exec(raw);
  if (rel !== null) {
    const word = rel[1].toLowerCase();
    // `now` keeps the current time; the day words are midnight-based (PHP's
    // `strtotime('tomorrow')` is tomorrow 00:00:00, not now+24h). The app
    // timezone is UTC (Cloudflare Workers), so the day boundaries are UTC.
    if (word === 'now') return Math.floor(Date.now() / 1000);
    const now = new Date();
    const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (word === 'tomorrow') return (d + 86400000) / 1000;
    if (word === 'yesterday') return (d - 86400000) / 1000;
    return d / 1000;
  }
  // A bare clock time (`'12:00'`, `'12:00:30'`) is TODAY at that time (UTC).
  const clock = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(raw);
  if (clock !== null) {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)) / 1000;
  }
  const digits = /^\s*(\d+)\s*$/.exec(raw);
  if (digits !== null) {
    const run = digits[1];
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const hhmm = (h, i, s) => (base + (h * 3600 + i * 60 + s) * 1000) / 1000;
    if (run.length === 4) return hhmm(Number(run.slice(0, 2)), Number(run.slice(2)), 0);
    if (run.length === 6) return hhmm(Number(run.slice(0, 2)), Number(run.slice(2, 4)), Number(run.slice(4)));
    const ymd = /^\s*(\d{4})(\d{2})(\d{2})\s*$/.exec(raw);
    if (ymd !== null) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) / 1000;
    return null;
  }
  const verdict = phpDateVerdict(raw);
  if (verdict === false) {
    // PHP's parser OVERFLOWS an impossible calendar day (`'2026-02-30'` becomes
    // 2026-03-02) instead of refusing it, so an absolute-shaped value still
    // yields a timestamp even though the strict grammar says false.
    return looksAbsolute(raw) ? phpAbsoluteTimestamp(raw) : null;
  }
  if (verdict === true) {
    return phpAbsoluteTimestamp(raw);
  }
  return null;
}
// A leading `YYYY-MM-DD`, `D-M-YYYY` or `M/D/YYYY` (with an optional time tail).
function looksAbsolute(raw) {
  return /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.test(raw)
    || /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.test(raw);
}
// An absolute date/time the grammar validated. `Date.parse` reads `m/d/Y` but
// not the ISO/German `d-m-Y` / `d.m.Y` forms, which are normalised first.
function phpAbsoluteTimestamp(raw) {
  const ymd = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/.exec(raw);
  const dmy = /^\s*(\d{1,2})[.-](\d{1,2})[.-](\d{4})(.*)$/.exec(raw);
  const mdy = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(raw);
  let y; let mo; let d; let time = '';
  if (ymd !== null && !mdy) { y = Number(ymd[1]); mo = Number(ymd[2]); d = Number(ymd[3]); time = ymd[4]; }
  else if (mdy !== null) { mo = Number(mdy[1]); d = Number(mdy[2]); y = Number(mdy[3]); time = mdy[4]; }
  else if (dmy !== null) { d = Number(dmy[1]); mo = Number(dmy[2]); y = Number(dmy[3]); time = dmy[4]; }
  else { return null; }
  const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time || '');
  const h = clock ? Number(clock[1]) : 0;
  const mi = clock ? Number(clock[2]) : 0;
  const s = clock ? Number(clock[3] || 0) : 0;
  // PHP's parser OVERFLOWS an out-of-range day (2026-02-30 -> 2026-03-02), so
  // the parts go through `Date.UTC` directly rather than a strict check.
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
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

// The names of the error bag's methods. The edge keeps Laravel's bag a plain
// map (the map the 422 body serializes), so a field with one of these names
// would overwrite the method - the validator refuses such a field loudly.
const BAG_METHOD_NAMES = new Set([
  'add',
  'addIf',
  'has',
  'first',
  'get',
  'keys',
  'messages',
  'getMessages',
  'toArray',
  'isEmpty',
  'isNotEmpty',
]);

// Illuminate\Support\MessageBag — the bag the validator hands out.
//
// Laravel's bag keeps the messages in an array of its own; the edge keeps them
// in the map the bag IS: the 422 body the HTTP kernel serializes is that map
// (`{"field":["msg"]}`) and the callers read the messages straight off it
// (`errors().email[0]`). The bag's methods are therefore non-enumerable own
// properties of the map: the map's own enumerable keys stay exactly the
// fields, so `Object.keys(errors)` is the field list and the JSON body does
// not change.
function messageBag(messages = {}) {
  const bag = messages;
  const define = (name, fn) => {
    Object.defineProperty(bag, name, { value: fn, enumerable: false, writable: true, configurable: true });
  };

  // MessageBag::add() (MessageBag.php:59-66): the message is APPENDED to the
  // field's list, and only when the field does not hold it yet (isUnique(),
  // MessageBag.php:88-93) - so the same message is never listed twice.
  define('add', (key, message) => {
    if (BAG_METHOD_NAMES.has(String(key))) {
      throw new Error(
        'the field "' +
          key +
          '" is the name of one of the error bag\'s methods - the edge keeps the bag a plain map (the ' +
          '422 body is that map), so the field would overwrite the method - rename the field'
      );
    }
    const list = bag[key];
    if (Array.isArray(list)) {
      if (!list.includes(message)) list.push(message);
    } else {
      bag[key] = [message];
    }
    return bag;
  });
  // MessageBag::addIf() (MessageBag.php:76-79).
  define('addIf', (condition, key, message) => (condition ? bag.add(key, message) : bag));
  // MessageBag::keys() (MessageBag.php:47-50).
  define('keys', () => Object.keys(bag));
  // MessageBag::get() (MessageBag.php:186-209): the messages of the key; a
  // wildcard key collects the messages of the fields it matches (Str::is -
  // there the `*` spans the dots).
  define('get', (key) => {
    if (Object.prototype.hasOwnProperty.call(bag, key)) {
      const list = bag[key];
      return Array.isArray(list) ? list : [];
    }
    if (!String(key).includes('*')) return [];
    const pattern = wildcardPattern(key, '.*');
    const out = {};
    for (const field of Object.keys(bag)) {
      if (pattern.test(field)) out[field] = bag[field];
    }
    return out;
  });
  // MessageBag::first() (MessageBag.php:170-181): the first message of the key
  // (or of the whole bag when the key is null).
  define('first', (key = null) => {
    if (key === null) {
      for (const field of Object.keys(bag)) {
        const list = bag[field];
        if (Array.isArray(list) && list.length > 0) return list[0];
      }
      return '';
    }
    const found = bag.get(key);
    if (Array.isArray(found)) return found.length > 0 ? found[0] : '';
    for (const field of Object.keys(found)) {
      const list = found[field];
      if (Array.isArray(list) && list.length > 0) return list[0];
    }
    return '';
  });
  // MessageBag::has() (MessageBag.php:118-133): the field holds a message.
  define('has', (key = null) => {
    if (key === null) return Object.keys(bag).length > 0;
    const keys = Array.isArray(key) ? key : [key];
    return keys.every((one) => bag.first(one) !== '');
  });
  // MessageBag::messages() / getMessages() / toArray() (MessageBag.php:303,
  // 313, 396): the raw map - the shape the 422 body serializes.
  define('messages', () => bag);
  define('getMessages', () => bag);
  define('toArray', () => bag);
  // MessageBag::isEmpty() / isNotEmpty() (MessageBag.php:356-370).
  define('isEmpty', () => Object.keys(bag).length === 0);
  define('isNotEmpty', () => !bag.isEmpty());
  return bag;
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
      else if (typeof raw === 'string') arr = splitRuleString(raw);
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
          // Laravel answers an unknown rule with
          // BadMethodCallException("Method ...::validateX() does not exist")
          // (Validator::__call, Validator.php:1746-1756) - the same class the
          // string-rule pipe split produces, so the edge names it too.
          const err = new Error('unknown validation rule: ' + r.name);
          err.name = 'BadMethodCallException';
          err.phpClass = 'BadMethodCallException';
          throw err;
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
    // The after callbacks (Illuminate\Validation\Validator::$after): they run
    // at the end of the validation pass.
    this._after = [];
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
      } else if (r.name === 'required_if_accepted' || r.name === 'required_if_declined') {
        // ValidatesAttributes.php:2216-2244: the field is required when the
        // OTHER field holds an accepted (declined) value.
        const otherValue = this.get(r.params[0]);
        const accepted = otherValue === true || otherValue === 1 || otherValue === '1' ||
          otherValue === 'yes' || otherValue === 'on' || otherValue === 'true';
        const declined = otherValue === false || otherValue === 0 || otherValue === '0' ||
          otherValue === 'no' || otherValue === 'off' || otherValue === 'false';
        if (r.name === 'required_if_accepted' ? accepted : declined) {
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
      if (r.name === 'prohibited') return { prohibited: true, rule: 'prohibited', param: null };
      if (r.name === 'prohibited_if') {
        const other = r.params[0];
        if (this._isPresent(other) && this._dependentMatches(r)) {
          return { prohibited: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'prohibited_if_accepted' || r.name === 'prohibited_if_declined') {
        // ValidatesAttributes.php:2287-2315: prohibited when the OTHER field
        // holds an accepted (declined) value.
        const otherValue = this.get(r.params[0]);
        const accepted = otherValue === true || otherValue === 1 || otherValue === '1' ||
          otherValue === 'yes' || otherValue === 'on' || otherValue === 'true';
        const declined = otherValue === false || otherValue === 0 || otherValue === '0' ||
          otherValue === 'no' || otherValue === 'off' || otherValue === 'false';
        if (r.name === 'prohibited_if_accepted' ? accepted : declined) {
          return { prohibited: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'prohibited_unless') {
        const other = r.params[0];
        if (!this._isPresent(other) || !this._dependentMatches(r)) {
          return { prohibited: true, rule: r.name, param: r.param };
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
    // The error bag: the map the 422 body serializes, with Laravel's
    // MessageBag methods attached (messageBag()).
    this._errors = messageBag();
    for (const field of Object.keys(this.parsed)) {
      const fieldRules = this.parsed[field];
      const hasSometimes = fieldRules.some((r) => r.name === 'sometimes');
      const hasNullable = fieldRules.some((r) => r.name === 'nullable');
      const hasFilled = fieldRules.some((r) => r.name === 'filled');
      const hasPresent = fieldRules.some((r) => r.name === 'present');
      const bail = fieldRules.some((r) => r.name === 'bail');
      const isAbsent = !this._isPresent(field);
      const value = this.get(field);
      // presentOrRuleIsImplicit() (Validator.php:877-885): an ABSENT attribute,
      // or a string that PHP's trim() empties, is validated against the
      // IMPLICIT rules only. isNotNullIfMarkedAsNullable() (:924-931): a
      // nullable attribute whose value is null is the same. The JS used to
      // skip such a field outright, which dropped the implicit value rules
      // (accepted/declined/filled) and made the non-implicit ones run on a
      // blank string (a probe: `x='   '` with `alpha` PASSES Laravel).
      const blankString = typeof value === 'string' && phpTrim(value) === '';
      const nullableNull = hasNullable && (value === null || value === undefined);
      const onlyImplicit = isAbsent || blankString || nullableNull;

      if (hasSometimes && isAbsent) continue;

      if (this._excludeApplies(fieldRules)) {
        this._excluded.add(field);
        continue;
      }

      const miss = this._missingEnforced(fieldRules);
      if (miss.enforced) {
        // Laravel's missing rules ask whether the attribute EXISTS
        // (`hasAttribute`), so a present-but-empty value fails too.
        if (!isAbsent) this._addError(field, miss.rule, miss.param);
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
      if (req.required && isEmptyRequired(value)) {
        this._addError(field, req.rule, req.param);
        continue;
      }

      // prohibited is not an implicit rule: an absent attribute or a blank
      // string skips it (a probe: `x='   '` with `prohibited` PASSES).
      const proh = onlyImplicit ? { prohibited: false } : this._prohibited(fieldRules);
      if (proh.prohibited) {
        if (!isEmptyValue(value)) this._addError(field, proh.rule, proh.param);
        continue;
      }

      // `filled` is implicit but only when the attribute is PRESENT
      // (ValidatesAttributes.php:1298-1305: `Arr::has($this->data, ...)`).
      if (hasFilled && !isAbsent && isEmptyRequired(value)) {
        // The rule name selects the message: Laravel's `filled` says "The
        // :attribute field must have a value." (not the `required` sentence).
        this._addError(field, 'filled', null);
        continue;
      }

      // `blankString` is TRUE for a string PHP's trim() empties - the
      // NUMERIC-RULE list (Validator.php:301) is *not* consulted; it is
      // exactly `hasRule($attribute, $numericRules)`, i.e. a literal `decimal`
      // rule counts as numeric too (Validator.php:2929 `shouldBeNumeric()`).
      const hasNumeric = fieldRules.some((r) => r.name === 'numeric' || r.name === 'integer' || r.name === 'decimal');
      // true when the raw value is PHP-numeric (used by `numeric`/`integer`/
      // `decimal` and by every rule that casts with `(string)`).
      const numericValue = isNumericValue(value);

      for (const r of fieldRules) {
        if (MODIFIERS.has(r.name) || PRESENCE_RULES.has(r.name)) continue;
        if (EXCLUDE_RULES.has(r.name) || MISSING_RULES.has(r.name) || PRESENT_RULES.has(r.name)) continue;
        if (ASYNC_RULES.has(r.name)) continue; // handled async
        // presentOrRuleIsImplicit: an absent/blank/null-nullable value runs the
        // implicit rules only (accepted, declined, filled handled above).
        if (onlyImplicit && !IMPLICIT_RULES.has(r.name)) continue;
        // Laravel's `shouldBeNumeric()` is called ONLY by the four comparison
        // rules (ValidatesAttributes.php:1321/1368/1415/1462), so `gt/gte/lt/lte`
        // reconstruct the length from `getSize()` when the value is numeric. The
        // size rules (min/max/size/between) do NOT claim numeric - `min:3` on
        // `'70'` stays `validation.min.string` (length 2).
        const claimsNumeric = COMPARISON_RULES.has(r.name) && numericValue;
        if (claimsNumeric) this.numericRulesClaimed = true;
        const ok = this._checkRule(field, value, r, hasNumeric || claimsNumeric);
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
      // presentOrRuleIsImplicit(): a null value or a string that trims to ''
      // skips the non-implicit unique/exists (Laravel never queries for a
      // blank string).
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && phpTrim(value) === '') continue;
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
      // ValidatesAttributes::validateImage() (:1539-1548): the file's type is
      // one of the image types. Laravel asks the MIME guesser for the
      // extension; the edge reads the HEADER (getimagesize's job), which is
      // the same magic-byte decision for every format in the list.
      case 'image': {
        if (!isUploadedFileValue(value) || !value.isValid()) return false;
        if (rule.params.includes('allow_svg')) {
          throw new Error(
            'the image:allow_svg rule is not compiled at the edge - an SVG is XML, not a raster ' +
              'header, so the edge cannot tell an image from an XML document that says <svg>'
          );
        }
        const info = imageInfo(value.bytes);
        return info !== null && IMAGE_RULE_FORMATS.has(info.format);
      }
      // ValidatesAttributes::validateDimensions() (:792-822): an SVG passes,
      // anything else is getimagesize() plus the named checks.
      case 'dimensions': {
        if (!isUploadedFileValue(value) || !value.isValid()) return false;
        const info = imageInfo(value.bytes);
        if (info === null) return looksLikeSvg(value.bytes);
        if (info.width === null || info.height === null) return false;
        return !failsDimensionChecks(rule.params, info.width, info.height);
      }
      case 'integer': {
        // ValidatesAttributes::validateInteger() (:1625-1632): `integer:strict`
        // is `is_int($value)` - a bare `true`/`'1'` is NOT an integer there.
        if (rule.params[0] === 'strict') return typeof value === 'number' && Number.isInteger(value);
        return isFilterVarInt(value);
      }
      // ValidatesAttributes::validateNumeric() (:2022-2030): `is_numeric($value)`,
      // and the `strict` parameter only refuses a STRING (`numeric:strict` still
      // accepts the int 42). PHP's `is_numeric` never reads hex/binary or the
      // words `Infinity`/`NaN`, unlike the JS `Number()`.
      case 'numeric': {
        if (rule.params[0] === 'strict' && typeof value === 'string') return false;
        return isNumericValue(value);
      }
      case 'boolean': return isBooleanLike(value, rule.params);
      // ValidatesAttributes::validateArray() (:446): `is_array($value)`. A PHP
      // assoc array reaches the compiled side as a plain object (and a list as
      // a JS array), so BOTH count as an array - only a scalar, null or a class
      // instance is refused.
      case 'array': return isPhpArrayValue(value);
      // ValidatesAttributes::validateEmail() -> egulias RFCValidation (Laravel's
      // default EmailValidator), ported in emailLocalPart()/emailHost() below: a
      // dotless domain ('a@b') is accepted, `_` is not a host byte, a bracketed
      // literal is closed by the first `]` and the junk after it is ignored.
      case 'email': {
        // The local part is a run of atext bytes, quoted strings, obsolete `\.`
        // escapes, `(...)` comments and FWS; the domain is labels of GENERIC
        // bytes, `-` and `.`, or a bracketed literal. Both are byte-exact ports
        // of egulias' lexer/parsers - see the helpers for the oracle probes.
        if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
        // egulias' lexer reads UTF-8 bytes, so an astral character is ONE token -
        // walk the string by code point, never by UTF-16 unit.
        const chars = Array.from(value);
        // EmailLexer flags an INVALID token (any \p{S}\p{C}\p{Cc} byte other than
        // NUL) and RFCValidation refuses the address at the end - wherever the
        // byte sat, even in a comment or after the domain literal.
        for (const ch of chars) if (emailByteKind(ch) === 'invalid') return false;
        const at = emailAtPosition(chars);
        if (at <= 0 || at === chars.length - 1) return false;
        return emailLocalPart(chars.slice(0, at)) && emailHost(chars.slice(at + 1));
      }
      // ValidatesAttributes::validateUrl() -> Str::isUrl($value, $parameters)
      // (:2770) - the Symfony UrlValidator pattern with Laravel's protocol
      // list, or the rule's own list (`url:ftp,http`). The JS `new URL` used to
      // accept http/https only, so a `ftp://`/`wss://` URL Laravel accepts was
      // rejected (a probe).
      case 'url': {
        if (typeof value !== 'string') return false;
        try {
          return strIsUrl(value, rule.params);
        } catch {
          return false;
        }
      }
      case 'date': {
        // ValidatesAttributes::validateDate() (:623-640): the value must be a
        // string or numeric AND `strtotime()` must read it AND `date_parse()`
        // must yield a real calendar date (`checkdate`). A bare time or a
        // relative word parses to month/day/year 0, which `checkdate` rejects -
        // so `'0'`, `'0123'`, `'now'` and `'tomorrow'` all FAIL `date`.
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        return isDateValidValue(value);
      }
      // ValidatesAttributes.php:384-444: the default classes are UNICODE
      // (`[\pL\pM]`, `[\pL\pM\pN]`, `[\pL\pM\pN_-]`) and the `ascii` parameter
      // switches to the ASCII range. The JS regexes were ASCII-only, so
      // 'café' failed a rule Laravel accepts (a probe). alpha_num/alpha_dash
      // also accept a numeric value (PHP's `is_numeric` + the preg coercion).
      case 'alpha': {
        if (typeof value !== 'string') return false;
        if (rule.params[0] === 'ascii') return /^[a-zA-Z]+$/.test(value);
        return /^[\p{L}\p{M}]+$/u.test(value);
      }
      case 'alpha_num': {
        const str = typeof value === 'string' ? value : isNumericValue(value) ? phpStringCast(value) : null;
        if (str === null) return false;
        if (rule.params[0] === 'ascii') return /^[a-zA-Z0-9]+$/.test(str);
        return /^[\p{L}\p{M}\p{N}]+$/u.test(str);
      }
      case 'alpha_dash': {
        const str = typeof value === 'string' ? value : isNumericValue(value) ? phpStringCast(value) : null;
        if (str === null) return false;
        if (rule.params[0] === 'ascii') return /^[a-zA-Z0-9_-]+$/.test(str);
        return /^[\p{L}\p{M}\p{N}_-]+$/u.test(str);
      }
      case 'accepted': return value === true || value === 1 || value === '1' || value === 'yes' || value === 'on' || value === 'true';
      case 'accepted_if': {
        const other = rule.params[0];
        if (this._isPresent(other) && this._dependentMatches(rule)) {
          return value === true || value === 1 || value === '1' || value === 'yes' || value === 'on' || value === 'true';
        }
        return true;
      }
      case 'declined': return value === false || value === 0 || value === '0' || value === 'no' || value === 'off' || value === 'false';
      // ValidatesAttributes.php:99-112: like accepted_if, but the field must
      // hold a DECLINED value and be present (`validateRequired`).
      case 'declined_if': {
        const other = rule.params[0];
        if (this._isPresent(other) && this._dependentMatches(rule)) {
          return !isEmptyRequired(value) &&
            (value === false || value === 0 || value === '0' || value === 'no' || value === 'off' || value === 'false');
        }
        return true;
      }
      case 'digits': return typeof value !== 'undefined' && /^\d+$/.test(String(value)) && String(value).length === Number(p);
      case 'digits_between': {
        const [a, b] = rule.params.map(Number);
        return /^\d+$/.test(String(value)) && String(value).length >= a && String(value).length <= b;
      }
      // ValidatesAttributes::validateMaxDigits() (:1733-1744) and
      // validateMinDigits() (:1753-1764): a string (or a numeric value cast to
      // a string) whose characters are ALL digits, with that length compared
      // to the single parameter.
      case 'max_digits':
      case 'min_digits': {
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        const s = phpStringCast(value);
        if (/[^0-9]/.test(s)) return false;
        const bound = Number(rule.params[0]);
        if (!Number.isFinite(bound)) return false;
        return rule.name === 'max_digits' ? s.length <= bound : s.length >= bound;
      }
      case 'multiple_of': {
        // ValidatesAttributes::validateMultipleOf() (:1959+): both sides must be
        // numeric, then compared with brick/math's EXACT `BigDecimal` (not the
        // JS `%`, which loses precision past 2^53). A zero denominator is only
        // a multiple when the numerator is zero, and `0 % 0` is refused.
        if (!isNumericValue(value) || !isNumericValue(p)) return false;
        const num = expandExponent(phpTrim(phpStringCast(value)));
        const den = expandExponent(phpTrim(phpStringCast(p)));
        const zi = (s) => /^[+-]?0*(\.0*)?$/.test(s);
        if (zi(num) && zi(den)) return false;
        if (zi(num)) return true;
        if (zi(den)) return false;
        return decimalModIsZero(num, den);
      }
      // ValidatesAttributes::validateUuid() -> Str::isUuid($value, $version)
      // (Str.php:687-717). Without a parameter: the canonical dashed form only.
      // With one: Symfony parses the value, so the 32-char form counts too, the
      // variant nibble must be [89ab] and the version nibble [1-8]; `0`/`nil`
      // answer the all-zero uuid, `max` the all-`f` one (probed on PHP 8.3:
      // 'a0ee...' with uuid:4 true, with uuid:1 false, the same uuid WITHOUT
      // dashes with uuid:4 true and without a parameter false, all-zero with
      // uuid:0 true, nibble 9 with uuid:9 false).
      case 'uuid': {
        if (typeof value !== 'string') return false;
        const raw = rule.params.length ? value : null;
        if (raw === null) {
          return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
        }
        let u = value;
        if (/^[0-9a-fA-F]{32}$/.test(u)) {
          u = u.slice(0, 8) + '-' + u.slice(8, 12) + '-' + u.slice(12, 16) + '-' + u.slice(16, 20) + '-' + u.slice(20);
        } else if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(u)) {
          return false;
        }
        u = u.toLowerCase();
        const wanted = rule.params[0];
        // `$version = (int) $parameters[0]` unless it is exactly 'max'
        // (validateUuid), then `Str::isUuid` compares to the parsed fields.
        if (wanted !== 'max' && Number.parseInt(String(wanted).trim(), 10) === 0) {
          return u === '00000000-0000-0000-0000-000000000000';
        }
        if (wanted === 'max') return u === 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){2}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)) return false;
        const v = Number.parseInt(String(wanted).trim(), 10);
        if (!(v >= 1 && v <= 8)) return false;
        return u[14] === String(v);
      }
      case 'ulid': {
        // ValidatesAttributes::validateUlid() -> Str::isUlid() -> Symfony
        // Ulid::isValid(): exactly 26 Crockford base32 characters (I, L, O and
        // U excluded), case-insensitive, and the first character at most '7'
        // (the ULID is 128 bits; probed: '7ZZZ...' true, '8ZZZ...' false).
        if (typeof value !== 'string' || value.length !== 26) return false;
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.toUpperCase())) return false;
        return value.toUpperCase()[0] <= '7';
      }
      case 'base64': {
        // ValidatesAttributes::validateBase64() (:183-192): the strict decode
        // must succeed AND re-encode to the very same string, so the encoding
        // has to be canonical ('AB==' decodes but re-encodes to 'AA==').
        if (typeof value !== 'string' || value === '') return false;
        if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
        try {
          return btoa(atob(value)) === value;
        } catch {
          return false;
        }
      }
      case 'contains': {
        // validateContains (:331-338): `array_all($parameters, fn ($p) =>
        // in_array($p, $value))` - LOOSE in_array.
        if (!isPhpArray(value)) return false;
        const items = Array.isArray(value) ? value : Object.values(value);
        return rule.params.every((param) => items.some((item) => phpLooseEquals(item, param)));
      }
      case 'doesnt_contain': {
        // validateDoesntContain (:345-352): the STRICT in_array.
        if (!isPhpArray(value)) return false;
        const items = Array.isArray(value) ? value : Object.values(value);
        return rule.params.every((param) => !items.some((item) => item === param));
      }
      case 'in_array_keys': {
        // validateInArrayKeys (:359-368): `array_any($parameters, fn ($p) =>
        // Arr::exists($value, $p))` - at least one parameter is a key.
        if (!isPhpArray(value)) return false;
        if (!rule.params.length) return false;
        return rule.params.some((param) => Object.prototype.hasOwnProperty.call(value, param));
      }
      case 'prohibits': {
        // validateProhibits (:2346-2357): when the attribute is present the
        // named attributes must all be absent (Arr::get reads the same input
        // the attribute came from).
        if (isEmptyRequired(value)) return true;
        return rule.params.every((param) => isEmptyRequired(this.get(param)));
      }
      case 'extensions': {
        // validateExtensions (:1266-1277) + shouldBlockPhpUpload (:1801-1813):
        // the CLIENT-DECLARED extension, lowercased, is one of the parameters;
        // a PHP extension is refused unless 'php' is whitelisted itself.
        if (!isUploadedFileValue(value) || !value.isValid()) return false;
        const ext = String(value.getClientOriginalExtension() || '').toLowerCase().trim();
        if (!rule.params.includes('php')) {
          if (['php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar'].includes(ext)) return false;
        }
        return rule.params.some((param) => String(param) === ext);
      }
      // ValidatesAttributes.php:1526-1529: `#(?:[0-9a-f]{3}){1,2}` or
      // `#(?:[0-9a-f]{4}){1,2}` - the 4- and 8-digit forms (with alpha) count.
      case 'hex_color': return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
      case 'ipv4': return isIpv4(value);
      case 'ipv6': return isIpv6(value);
      case 'ip': return isIpv4(value) || isIpv6(value);
      case 'mac_address': return typeof value === 'string' && /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(value);
      // ValidatesAttributes::validateJson() (:1689-1700): an array or null is
      // refused, a non-scalar is refused, the rest goes through
      // `json_validate()` - i.e. `true`, `0`, `42` and `1.5` all PASS (a
      // `json_decode` probe: the JSON text `0` is valid JSON).
      case 'json': {
        // ValidatesAttributes::validateJson() (:1805+): an array, a null or a
        // class instance is refused (`is_array`/`is_null`); every other scalar
        // is stringified and run through `json_validate()`. That accepts the
        // JSON texts `true`/`false`/`0`/`42`/`1.5` (a bool is NOT special), so
        // only a non-finite number (which has no JSON form) is refused.
        if (isPhpArrayValue(value) || value === null) return false;
        if (typeof value === 'object') return false;
        if (typeof value === 'boolean') return value === true; // false -> '' is not JSON
        if (typeof value === 'number') return Number.isFinite(value);
        try { JSON.parse(value); return true; } catch { return false; }
      }
      // ValidatesAttributes::validateAscii() (:171): `is_string($value) &&
      // Str::isAscii($value)`, and voku's `is_ascii` uses the class
      // `[^\x09\x10\x13\x0A\x0D\x20-\x7E]` - a NUL (\x00), \x01-\x08 and
      // \x0E-\x1F are NOT ASCII, while \x09/\x0A/\x0D and \x7F are.
      case 'ascii': return typeof value === 'string' && !/[^\x09\x10\x13\x0A\x0D\x20-\x7E]/.test(value);
      case 'lowercase': return typeof value === 'string' && value === value.toLowerCase();
      case 'uppercase': return typeof value === 'string' && value === value.toUpperCase();
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
      // ValidatesAttributes::compareDates() (:275-307, reached by the
      // Before/After/BeforeOrEqual/AfterOrEqual/DateEquals rules): a non-string,
      // non-numeric, non-DateTime value answers false; `$parameters[0]` is first
      // read as a literal timestamp and only then as a FIELD NAME; a `null`
      // timestamp on either side is `0` for the comparison, so an unparseable
      // value PASSES `before` and FAILS `after`.
      case 'before': case 'before_or_equal': case 'after': case 'after_or_equal': {
        const rel = rule.name === 'before' || rule.name === 'before_or_equal' ? '<' : '>';
        const strict = rule.name === 'before' || rule.name === 'after';
        return this._compareDates(field, value, p, rel, strict);
      }
      case 'date_equals': {
        return this._compareDates(field, value, p, '=', true);
      }
      case 'date_format': return matchDateFormat(value, p);
      // ValidatesAttributes::validateGt() (:1315-1345) and its Lt/Gte/Lte
      // siblings, verbatim: the rule takes EITHER a literal number OR a field
      // name. A numeric parameter with a null compared value is a size
      // comparison against the trimmed parameter; a numeric parameter with a
      // non-null compared value always FAILS (`is_numeric($parameters[0])`);
      // when both sides are numeric and the attribute claims a numeric rule the
      // compare is `trim($value)` vs `trim($comparedToValue)`; otherwise the
      // sides must share a PHP type and are compared through `getSize()`.
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const other = this.get(p);
        // `getSize()` may answer a number (count/length) or a decimal string
        // (numeric mode); `cmpBig` normalises both, and a non-number side makes
        // the comparison fail like the `catch (MathException)` arms do.
        const op = (a, b) => {
          const n = cmpBig(a, b);
          if (n === null) return false;
          return rule.name === 'gt' ? n > 0
            : rule.name === 'gte' ? n >= 0
              : rule.name === 'lt' ? n < 0
                : n <= 0;
        };
        // `is_numeric($parameters[0])`: the parameter is a literal number, not a
        // field reference, and the field lookup came back null.
        const paramNumeric = isNumericValue(p);
        if ((other === null || other === undefined) && isNumericValue(value) && paramNumeric) {
          return op(this._size(value, hasNumeric), phpTrim(String(p)));
        }
        if (paramNumeric) return false;
        if (hasNumeric && isNumericValue(value) && isNumericValue(other)) {
          return op(phpTrim(String(value)), phpTrim(String(other)));
        }
        if (!samePhpType(value, other)) return false;
        return op(this._size(value, hasNumeric), this._size(other, hasNumeric));
      }
      // ValidatesAttributes.php:919-968: `distinct` compares the value against
      // the OTHER values that sit at the same wildcard path (the sibling
      // entries - `items.*.id` against the other ids), gathered from the
      // dotted data and with the value's own entry removed. The JS version
      // scanned the VALUE for duplicates instead, so it answered the opposite
      // way on both shapes (a probe: `x=[1,1]` PASSES Laravel and the
      // wildcard duplicate FAILS it).
      case 'distinct': {
        const primary = this._primaryAttribute(field);
        const source = String(primary).includes('*') ? primary : field;
        const pattern = new RegExp(
          '^' + String(source).replace(JS_REGEX_SYNTAX, '\\$&').replace(/\\\*/g, '[^.]+') + '$',
          'u'
        );
        const dotted = phpDot(this.data);
        const others = [];
        for (const key of Object.keys(dotted)) {
          if (key === field) continue;
          if (pattern.test(key)) others.push(dotted[key]);
        }
        if (rule.params.includes('ignore_case') && typeof value === 'string') {
          const lower = value.toLowerCase();
          return !others.some((other) => typeof other === 'string' && other.toLowerCase() === lower);
        }
        const strict = rule.params.includes('strict');
        return !others.some((other) => (strict ? other === value : phpLooseEquals(value, other)));
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
        // ValidatesAttributes::validateRegex() (:2131): `is_string($value) ||
        // is_numeric($value)` - a numeric value is cast by preg_match, so a
        // number passes `/^[0-9]+$/` where the old `typeof !== 'string'` refused it.
        if (typeof value !== 'string' && !isNumericLike(value)) return false;
        const compiled = compileUserPattern(p);
        if (compiled === null) return false;
        return compiled.test(phpStringCast(value));
      }
      // Laravel registers `notregex` as an alias of `not_regex`
      // (Validator::$rules -> validateNotRegex), so both spellings must answer.
      case 'not_regex':
      case 'notregex': {
        if (typeof value !== 'string' && !isNumericLike(value)) return false;
        const compiled = compileUserPattern(p);
        // `preg_match()` returns false for a pattern it cannot compile and
        // `validateNotRegex` answers `false < 1` - so an invalid pattern PASSES.
        if (compiled === null) return true;
        return !compiled.test(phpStringCast(value));
      }
      // ValidatesAttributes::validateDoesntStartWith() (:2691) / validateDoesntEndWith()
      // (:2725): `is_string($value) || is_numeric($value)` then the negated
      // `Str::startsWith/endsWith` (ANY needle), and a null/non-scalar FAILS
      // (the JS returned true for anything that was not a string).
      case 'doesnt_start_with': {
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        const str = phpStringCast(value);
        return !rule.params.some((pre) => str.startsWith(phpStringCast(pre)));
      }
      case 'doesnt_end_with': {
        if (typeof value !== 'string' && !isNumericValue(value)) return false;
        const str = phpStringCast(value);
        return !rule.params.some((suf) => str.endsWith(phpStringCast(suf)));
      }
      // ValidatesAttributes::validateList() (:485): `is_array($value) &&
      // array_is_list($value)` - i.e. a PHP list (keys `0..n-1` in order). An
      // associative map is refused; a numerically-keyed object is accepted.
      case 'list':
        return isPhpListValue(value);
      case 'required_array_keys': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = rule.params;
        return keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
      }
      case 'array_keys': {
        // ValidatesAttributes::validateArrayKeys() (:467): every key of the
        // value must appear in the parameters (`empty(array_diff_key(...))`).
        if (!isPhpArrayValue(value)) return false;
        const keys = rule.params;
        const valueKeys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
        return valueKeys.every((k) => keys.includes(k));
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

  // ValidatesAttributes::compareDates() (:275-307). `$parameters[0]` is read as
  // a timestamp first and only falls back to `getValue()` (the field name) when
  // that answers null. `getDateTimestamp()` is null for an unreadable value, and
  // `compare(0, ..)`/`compare(.., 0)` is an ordinary integer comparison, so a
  // garbage attribute PASSES `before` (0 < ts) but FAILS `after`.
  _compareDates(field, value, p, rel, strict) {
    const isDate = typeof value === 'string' || isNumericValue(value) || value instanceof Date;
    if (!isDate) return false;
    const format = this._getDateFormat(field);
    if (format) {
      return this._checkDateTimeOrder(format, value, p, rel, strict);
    }
    let other = carbonTimestamp(p);
    if (other === null || other === undefined) other = carbonTimestamp(this.get(p));
    const self = carbonTimestamp(value);
    if (self === undefined || other === undefined) return false; // Carbon TypeError
    const a = self === null ? 0 : self;
    const b = other === null || other === undefined ? 0 : other;
    if (rel === '<') return strict ? a < b : a <= b;
    if (rel === '>') return strict ? a > b : a >= b;
    return a === b;
  }

  // ValidatesAttributes::checkDateTimeOrder() (:327-345): both sides go through
  // the attribute's `date_format` first, then a plain DateTime parse; a null
  // FIELD value short-circuits to true.
  _checkDateTimeOrder(format, first, second, rel, strict) {
    const firstDate = this._dateTimeWithOptionalFormat(format, first);
    const fmt = this._getDateFormat(second) || format;
    let secondDate = this._dateTimeWithOptionalFormat(fmt, second);
    if (secondDate === null) {
      const other = this.get(second);
      if (other === null || other === undefined) return true;
      secondDate = this._dateTimeWithOptionalFormat(fmt, other);
    }
    if (firstDate === null || secondDate === null) return false;
    if (rel === '<') return strict ? firstDate < secondDate : firstDate <= secondDate;
    if (rel === '>') return strict ? firstDate > secondDate : firstDate >= secondDate;
    return firstDate === secondDate;
  }

  // ValidatesAttributes::getDateFormat($attribute) (:291-296): the parameter of
  // the attribute's own `date_format` rule, if any.
  _getDateFormat(field) {
    const rules = this.parsed ? this.parsed[field] : null;
    if (!rules) return null;
    const r = rules.find((x) => x.name === 'date_format');
    return r ? (r.params[0] == null ? null : r.params[0]) : null;
  }

  _dateTimeWithOptionalFormat(format, value) {
    if (matchDateFormat(value, format)) {
      const ts = Date.parse(String(value).replace(' ', 'T'));
      return Number.isNaN(ts) ? carbonTimestamp(value) : Math.floor(ts / 1000);
    }
    return carbonTimestamp(value);
  }

  // ValidatesAttributes::getSize() (:2817-2832), verbatim:
  //   is_numeric($value) && $hasNumeric  -> the number itself (as a string)
  //   is_array($value)                   -> count($value)
  //   $value instanceof File             -> kilobytes
  //   else                               -> mb_strlen((string) ($value ?? ''))
  // `mb_strlen` counts CODE POINTS, so `'😀'` is size 1 - `String.length`
  // counts UTF-16 units and would answer 2. The non-numeric fallthrough does
  // NOT special-case a float: `size:4` on `3.14` is `mb_strlen('3.14')` = 4.
  _size(value, hasNumeric) {
    if (hasNumeric && isNumericValue(value)) return phpTrim(String(value));
    if (Array.isArray(value)) return value.length;
    // A PHP assoc array reaches the edge as a plain object (`rt.assoc` adds a
    // non-enumerable `__lwOrder`), so count its own keys like `count()`.
    if (value !== null && typeof value === 'object' && !isUploadedFileValue(value)) return Object.keys(value).length;
    if (isUploadedFileValue(value)) return fileSizeKb(value.getSize());
    return phpMbStrlen(value === null || value === undefined ? '' : phpStringCast(value));
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
    // The bag's methods live on the map the bag IS (the edge keeps Laravel's
    // bag a plain map, so the 422 body does not change), so a field named
    // like one of them would overwrite the method. Laravel keeps the messages
    // in an array of its own and has no such clash: the edge refuses the
    // field instead of answering something else.
    if (BAG_METHOD_NAMES.has(String(field))) {
      throw new Error(
        'the validation field "' +
          field +
          '" is the name of one of the error bag\'s methods - the edge keeps the bag a plain map ' +
          '(the 422 body is that map), so the field would overwrite the method - rename the field'
      );
    }
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
    // The field's list: an own property (a field named like an inherited
    // Object property - 'constructor', 'toString' - is a plain field in PHP).
    if (!Object.prototype.hasOwnProperty.call(this._errors, field) || !Array.isArray(this._errors[field])) {
      this._errors[field] = [];
    }
    this._errors[field].push(msg);
  }

  // Illuminate\Validation\Validator::after() (Validator.php:447-461): register
  // the callback that runs at the END of the validation pass. The callback
  // receives the validator, so it can read the errors and add messages.
  after(callback) {
    // Laravel's array branch (Validator.php:449-455) registers every entry of
    // the array (the rule objects it holds); the edge has no rule objects, so
    // an array here is a list of callbacks.
    if (Array.isArray(callback)) {
      for (const one of callback) this.after(one);
      return this;
    }
    if (typeof callback !== 'function') {
      throw new Error(
        'the validator\'s after() hook takes a callback (Laravel calls it with the validator) - got ' +
          typeof callback
      );
    }
    this._after.push(callback);
    return this;
  }

  // The after callbacks run at the END of the pass, AFTER the rules - and they
  // run even when a rule failed (Illuminate\Validation\Validator::passes(),
  // Validator.php:509-511: `foreach ($this->after as $after) { $after(); }`).
  async _runAfter() {
    for (const callback of this._after) {
      // The callback is a promise when the compiled hook is async: the pass
      // awaits it, so the message it adds is in the bag when the pass ends.
      await callback(this);
    }
  }

  async passes() {
    this._ensureSync();
    await this._runAsync();
    // The after hooks run last (Laravel's order) - and they run even when a
    // rule failed: a message they add fails the validation.
    await this._runAfter();
    return Object.keys(this._errors).length === 0;
  }
  async fails() {
    return !(await this.passes());
  }
  errors() {
    this._ensureSync();
    // The bag (the map the 422 body serializes, with Laravel's MessageBag
    // methods attached). Laravel's errors() triggers the whole pass when the
    // messages are not computed yet (Validator.php:1145-1150); the kernel's
    // errors() is synchronous and cannot await the after hooks, so they run in
    // passes()/fails() - the lifecycle always calls one of them first
    // (ValidatesWhenResolvedTrait::validateResolved() calls fails()).
    return this._errors;
  }
  /**
   * `messages()` (Validator.php:1145-1152): the message container, and
   * `errors()` is its semantic shortcut (`return $this->messages()`,
   * Validator.php:1159-1161). Laravel runs the pass when the messages are not
   * computed yet; the kernel's bag is always live (see `errors()`).
   */
  messages() {
    return this.errors();
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

// The rule surface the compiler consults (compiler/src/transpiler.mjs):
// the names _checkRule() answers, plus the pipe parser the runtime splits
// string rule sets with. The build checks the app's rules with the SAME
// parser, so a build verdict can never disagree with the runtime.
export { KNOWN_RULES, splitRuleString };

export default { Validator, validate };
