// kernel/str.mjs - Illuminate\Support\Str (the subset that compiles at the edge).
//
// Every rule here is PHP-exact: the values are verified against the real
// Laravel (the oracle) in kernel/tests/str.test.mjs. The transliteration
// (Str::ascii) covers the Latin-1 supplement - the range Str::slug() needs.
//
// Not ported: Str::head (removed in Laravel 11+), the plural inflections
// (plural/singular/of and the Stringable object), the ulid helpers and the
// `*Array` variants. A construct outside this surface fails the build (LW002),
// it never becomes a silent stub.

const ASCII_MAP = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a',
  ç: 'c', ć: 'c', ĉ: 'c', ċ: 'c', č: 'c',
  ď: 'd', đ: 'd',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ĕ: 'e', ė: 'e', ę: 'e', ě: 'e',
  ĝ: 'g', ğ: 'g', ġ: 'g', ģ: 'g',
  ĥ: 'h', ħ: 'h',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ĩ: 'i', ī: 'i', ĭ: 'i', į: 'i', ı: 'i',
  ĵ: 'j',
  ķ: 'k',
  ĺ: 'l', ļ: 'l', ľ: 'l', ł: 'l',
  ñ: 'n', ń: 'n', ņ: 'n', ň: 'n', ŋ: 'n',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o', ŏ: 'o', ő: 'o',
  ŕ: 'r', ŗ: 'r', ř: 'r',
  ś: 's', ŝ: 's', ş: 's', š: 's', ș: 's', ß: 'ss',
  ţ: 't', ť: 't', ŧ: 't', ț: 't',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ũ: 'u', ū: 'u', ŭ: 'u', ů: 'u', ű: 'u', Ų: 'u',
  ŵ: 'w',
  ý: 'y', ÿ: 'y', ŷ: 'y',
  ź: 'z', ż: 'z', ž: 'z',
  æ: 'ae', œ: 'oe', ð: 'd', þ: 'th',
  '·': '', '×': 'x', '©': '(c)', '®': '(r)', '™': 'tm',
  '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi',
  '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st',
};

function phpLower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function phpUpper(value) {
  return String(value == null ? '' : value).toUpperCase();
}

// PHP's mb_strtoupper: the full uppercase mapping (it expands, 'ß' -> 'SS').
function mbUpper(ch) {
  return ch.toUpperCase();
}

// PHP's mb_lcfirst: the first CHARACTER is lowercased ('Été' -> 'été').
function mbLcfirst(value) {
  const s = String(value == null ? '' : value);
  const first = [...s][0];
  if (first === undefined) return s;
  return first.toLowerCase() + s.slice(first.length);
}

// PHP's global ucwords() (not Str::ucwords): the first ASCII letter of each
// word is uppercased and the rest lowercased; the other bytes are untouched
// ('ß' stays 'ß'). Laravel's snake() uses this one.
function phpUcwords(value) {
  return String(value == null ? '' : value).replace(
    /(^|\s)([a-z])/g,
    (m, sep, ch) => sep + ch.toUpperCase(),
  );
}

// PHP's ctype_lower(): true only for a non-empty string of lowercase ASCII
// letters (the C locale) - a space or a digit is not one.
function phpCtypeLower(value) {
  return /^[a-z]+$/.test(String(value));
}

// The East Asian Wide/Fullwidth ranges: mb_strwidth() counts these as two
// columns (PHP's mbstring follows the East Asian Width property).
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18d08], [0x1b000, 0x1b152], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6f9], [0x1f910, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

// The width of one character (mbstring): the wide ones are two columns, the
// combining marks are none, the rest is one.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) break;
    if (cp <= hi) return 2;
  }
  if (/\p{Mn}|\p{Me}|\p{Cf}/u.test(ch)) return 0;
  return 1;
}

// PHP's mb_strwidth($value, 'UTF-8').
function mbStrwidth(value) {
  let w = 0;
  for (const ch of String(value)) w += charWidth(ch);
  return w;
}

// PHP's mb_strimwidth($value, $start, $width, '', 'UTF-8').
function mbStrimwidth(value, start, width) {
  let out = '';
  let w = 0;
  let skipped = 0;
  for (const ch of String(value)) {
    const cw = charWidth(ch);
    if (skipped < start) {
      skipped++;
      continue;
    }
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

// PHP's mb_substr($value, $start, $length, 'UTF-8') for one character.
function mbSubstr(value, start, length) {
  const chars = [...String(value)];
  return chars.slice(start, start + length).join('');
}

// PHP's strip_tags(): the comments go, and a tag that is never closed takes
// the rest of the string with it ('a<B' -> 'a').
function stripTags(value) {
  return String(value).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>?/g, '');
}

/** Str::ascii() - the Latin-1 transliteration (the part Str::slug needs). */
export function ascii(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    // The Turkish dotted capital I: PHP's transliteration maps it to 'I'
    // (the JS lowercase would be 'i' + a combining dot).
    if (ch === '\u0130') {
      out += 'I';
      continue;
    }
    const lower = ch.toLowerCase();
    if (ASCII_MAP[lower] !== undefined) {
      // The uppercase form maps to the uppercase letter (Str::ascii('É') = 'E').
      const mapped = ASCII_MAP[lower];
      out += ch === lower ? mapped : mapped.toUpperCase();
      continue;
    }
    if (ch.charCodeAt(0) < 128) {
      out += ch;
      continue;
    }
    // Everything else is dropped (portable-ascii does the same).
  }
  return out;
}

/** Str::slug() */
export function slug(title, separator = '-') {
  let value = ascii(title);
  value = value.replace(/[_\-]+/g, separator);
  // Laravel's dictionary: '@' becomes 'at' (wrapped in the separator), so
  // 'a@b' is 'a-at-b'.
  value = value.split('@').join(separator + 'at' + separator);
  value = phpLower(value);
  value = value.replace(new RegExp('[^' + escapeRe(separator) + '\\p{L}\\p{N}\\s]+', 'gu'), '');
  value = value.replace(new RegExp('[' + escapeRe(separator) + '\\s]+', 'gu'), separator);
  return trimChars(value, separator);
}

/** Str::limit() */
export function limit(value, limit = 100, end = '...', preserveWords = false) {
  const str = String(value == null ? '' : value);
  // Laravel: `if (mb_strwidth($value, 'UTF-8') <= $limit) return $value;` -
  // the limit is a DISPLAY width (a CJK glyph is two columns), not a count of
  // characters.
  if (mbStrwidth(str) <= limit) return str;
  if (!preserveWords) {
    return trimEnd(mbStrimwidth(str, 0, limit)) + end;
  }
  // The preserve-words branch: the tags are stripped, the newlines become
  // spaces and the cut lands on a word boundary.
  const v = trimEnd(stripTags(str.replace(/[\n\r]+/g, ' ')).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''));
  const trimmed = trimEnd(mbStrimwidth(v, 0, limit));
  if (mbSubstr(v, limit, 1) === ' ') return trimmed + end;
  const cut = trimmed.match(/^([\s\S]*)\s[\s\S]*$/);
  return (cut ? cut[1] : trimmed) + end;
}

/** Str::studly() */
export function studly(value) {
  // Laravel: the separators become spaces, the words are exploded, each is
  // ucfirst'ed and they are joined *without* the spaces.
  const words = String(value == null ? '' : value)
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '');
  return words.map((w) => ucfirst(w)).join('');
}

/** Str::camel() */
export function camel(value) {
  // Laravel: `static::lcfirst(static::studly($value))` and Str::lcfirst is
  // `mb_lcfirst` (the first CHARACTER is lowercased).
  return mbLcfirst(studly(value));
}

/** Str::snake() */
export function snake(value, delimiter = '_') {
  let v = String(value == null ? '' : value);
  // Laravel: `if (! ctype_lower($value))` - ctype_lower is true only for a
  // non-empty string of lowercase ASCII letters, so 'hello world' is NOT
  // lowercase-only and Laravel converts it ('hello_world').
  if (!phpCtypeLower(v)) {
    // Laravel uses PHP's global ucwords() here (not Str::ucwords): only the
    // ASCII letters count.
    v = phpUcwords(v).replace(/\s+/gu, '');
    v = phpLower(v.replace(/(.)(?=[A-Z])/gu, '$1' + delimiter));
  }
  return v;
}

/** Str::kebab() */
export function kebab(value) {
  return snake(value, '-');
}

/** Str::title() */
// The characters Unicode calls case-ignorable: they do not end a word, so
// 'o'brien' stays "O'brien" and 'a.b' stays 'A.b' (PHP's mb_convert_case with
// MB_CASE_TITLE - probed).
const CASE_IGNORABLE = /[\p{Mn}\p{Me}\p{Cf}\p{Lm}\p{Sk}\u0027\u002e\u003a\u00b7\u0387\u0559\u05f4\u2018\u2019\u2024\u2027\ufeff]/u;

// The titlecase mapping (the characters whose titlecase is not their
// uppercase).
const TITLE_MAP = {
  '\u01c4': '\u01c5', '\u01c5': '\u01c5', '\u01c6': '\u01c5',
  '\u01c8': '\u01c8', '\u01c9': '\u01c8',
  '\u01cc': '\u01cb', '\u01cd': '\u01cd', '\u01ce': '\u01cb',
  '\u01f2': '\u01f2', '\u01f3': '\u01f2',
  '\ufb00': 'Ffl', '\ufb01': 'Fi', '\ufb02': 'Fl', '\ufb03': 'Ffi',
  '\ufb04': 'Ffl', '\ufb05': 'St', '\ufb06': 'St',
};

function mbTitlecase(ch) {
  if (TITLE_MAP[ch] !== undefined) return TITLE_MAP[ch];
  // The Unicode's titlecase mapping of the sharp s is 'Ss' (the full
  // mapping expands it).
  if (ch === '\u00df') return 'Ss';
  if (/\p{Lt}/u.test(ch)) return ch;
  return mbUpper(ch);
}

export function title(value) {
  // Laravel: `mb_convert_case($value, MB_CASE_TITLE, 'UTF-8')`. PHP's rule
  // (php_unicode_convert_case, PHP_UNICODE_CASE_TITLE_SIMPLE): a word is a
  // run of CASED letters; a case-ignorable character does not end it ('a.b' ->
  // 'A.b'), any other character does ('a1b2' -> 'A1B2', 'hello-world' ->
  // 'Hello-World'). The first letter of a word is titlecased, the rest is
  // lowercased.
  const s = String(value == null ? '' : value);
  let out = '';
  let inWord = false;
  for (const ch of s) {
    if (/\p{Ll}|\p{Lu}|\p{Lt}/u.test(ch)) {
      out += inWord ? ch.toLowerCase() : mbTitlecase(ch);
      inWord = true;
      continue;
    }
    out += ch;
    if (!CASE_IGNORABLE.test(ch)) inWord = false;
  }
  return out;
}

/** Str::contains() */
export function contains(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  const list = Array.isArray(needles) ? needles : [needles];
  // Laravel: the needle must not be empty (`$needle !== ''`).
  return list.some((n) => String(n) !== '' && h.includes(String(n)));
}

/** Str::startsWith() */
export function startsWith(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  const list = Array.isArray(needles) ? needles : [needles];
  // Laravel: the needle must not be empty (`(string) $needle !== ''`).
  return list.some((n) => String(n) !== '' && h.startsWith(String(n)));
}

/** Str::endsWith() */
export function endsWith(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  const list = Array.isArray(needles) ? needles : [needles];
  // Laravel: the needle must not be empty (`(string) $needle !== ''`).
  return list.some((n) => String(n) !== '' && h.endsWith(String(n)));
}

/** Str::after() */
export function after(subject, search) {
  const s = String(subject == null ? '' : subject);
  const needle = String(search == null ? '' : search);
  if (needle === '') return s;
  // Laravel: `array_reverse(explode($search, $subject, 2))[0]` — a needle that
  // does not occur answers the WHOLE subject (explode has one piece), not an
  // empty string. The plain indexOf slice would cut the wrong tail.
  const at = s.indexOf(needle);
  return at === -1 ? s : s.slice(at + needle.length);
}

/** Str::before() */
export function before(subject, search) {
  const s = String(subject == null ? '' : subject);
  const needle = String(search == null ? '' : search);
  if (needle === '') return s;
  const at = s.indexOf(needle);
  return at === -1 ? s : s.slice(0, at);
}

/** Str::length() */
export function length(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

/** Str::replace() */
export function replace(search, replace, subject) {
  return String(subject == null ? '' : subject).split(String(search)).join(String(replace));
}

/** Str::replaceFirst() */
export function replaceFirst(search, replace, subject) {
  const s = String(subject == null ? '' : subject);
  const needle = String(search);
  if (needle === '') return s;
  const at = s.indexOf(needle);
  if (at === -1) return s;
  return s.slice(0, at) + String(replace) + s.slice(at + needle.length);
}

/** Str::replaceLast() */
export function replaceLast(search, replace, subject) {
  const s = String(subject == null ? '' : subject);
  const needle = String(search);
  if (needle === '') return s;
  const at = s.lastIndexOf(needle);
  if (at === -1) return s;
  return s.slice(0, at) + String(replace) + s.slice(at + needle.length);
}

/** Str::squish() */
export function squish(value) {
  return String(value == null ? '' : value)
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
    .replace(/(?:[\s\u3000])+/g, ' ');
}

/** Str::ucfirst() */
export function ucfirst(value) {
  // Laravel: `mb_ucfirst($string, 'UTF-8')` - the first CHARACTER is
  // titlecased ('ǆ' -> 'ǅ', 'ß' -> 'Ss').
  const s = String(value == null ? '' : value);
  const first = [...s][0];
  if (first === undefined) return s;
  return mbTitlecase(first) + s.slice(first.length);
}

/** Str::ucwords() */
export function ucwords(value) {
  // Laravel: `preg_replace_callback('/(^|['.preg_quote($separators).'])(\p{Ll})/u', ...)`
  // with the separators " \t\r\n\f\v" - only a LOWERCASE letter right
  // after a separator (or at the start) is uppercased ('foo_bar' -> 'Foo_bar',
  // 'école' -> 'École', 'HELLO WORLD' stays).
  return String(value == null ? '' : value).replace(
    /(^|[ \t\r\n\f\v])(\p{Ll})/gu,
    (m, sep, ch) => sep + mbUpper(ch),
  );
}

/** Str::upper() / Str::lower() */
export function upper(value) {
  return phpUpper(value);
}
export function lower(value) {
  return phpLower(value);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function trimChars(value, chars) {
  let out = String(value);
  while (out.length && out.startsWith(chars)) out = out.slice(1);
  while (out.length && out.endsWith(chars)) out = out.slice(0, -1);
  return out;
}
function trimEnd(value) {
  return String(value).replace(/\s+$/g, '');
}

/** Str::is() (Str.php:557) - `*` wildcard, full-string, case-sensitive unless $ignoreCase. */
export function is(pattern, value, ignoreCase = false) {
  const v = String(value == null ? '' : value);
  const list = Array.isArray(pattern)
    ? pattern
    : pattern !== null && typeof pattern === 'object'
      ? Object.values(pattern)
      : [pattern];
  const flags = (ignoreCase ? 'i' : '') + 'su';
  for (const raw of list) {
    const p = String(raw == null ? '' : raw);
    if (p === '*' || p === v) return true;
    if (ignoreCase && p.toLowerCase() === v.toLowerCase()) return true;
    if (new RegExp('^' + escapeRe(p).replace(/\\\*/g, '.*') + '$', flags).test(v)) return true;
  }
  return false;
}
/** Str::finish() (Str.php:496) - append `$cap` unless already fully suffixed. */
export function finish(value, cap) {
  const v = String(value == null ? '' : value);
  const c = String(cap == null ? '' : cap);
  if (c === '') return v;
  if (!v.endsWith(c)) return v + c;
  if (!v.endsWith(c + c)) return v;
  return v.replace(new RegExp('(?:' + escapeRe(c) + ')+$', 'u'), '') + c;
}
/** Str::start() (Str.php:1511) - prepend `$prefix` unless already fully prefixed. */
export function start(value, prefix) {
  const v = String(value == null ? '' : value);
  const p = String(prefix == null ? '' : prefix);
  if (p === '') return v;
  if (!v.startsWith(p)) return p + v;
  if (!v.startsWith(p + p)) return v;
  return p + v.replace(new RegExp('^(?:' + escapeRe(p) + ')+', 'u'), '');
}
// Str::random() (Str.php:1158): the base64-of-random-bytes factory strips
// '/', '+' and '=' so the alphabet is A-Za-z0-9. The VALUE cannot be
// byte-parity (it is random); the alphabet, the length and the draw are.
// crypto's CSPRNG backs it.
// `Str::random()` (Str.php:1158, Laravel 13.37): base64 of `ceil($size / 3) * 3`
// random bytes with `/`, `+`, `=` stripped, truncated to the requested length.
// Because the byte count is a multiple of three, no padding is emitted and every
// character is one uniform 6-bit base64 value over a 62-char alphabet - an
// unbiased draw. (`rawByte % 62` is NOT: 256 = 4*62 + 8, so eight characters
// carry extra weight.)
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}
export function random(length = 16) {
  const n = Math.max(0, Number(length) | 0);
  let out = '';
  while (out.length < n) {
    const size = n - out.length;
    const bytesSize = Math.ceil(size / 3) * 3;
    const bytes = new Uint8Array(bytesSize);
    globalThis.crypto.getRandomValues(bytes);
    out += base64Encode(bytes).replace(/[/+=]/g, '').slice(0, size);
  }
  return out;
}

// The surface the compiler allows (Str::x() -> rt.str.x()).
export const STR_METHODS = new Set([
  'slug', 'limit', 'upper', 'lower', 'studly', 'camel', 'snake', 'kebab', 'title',
  'contains', 'startsWith', 'endsWith', 'after', 'before', 'length',
  'replace', 'replaceFirst', 'replaceLast', 'squish', 'ucfirst', 'ucwords', 'ascii',
  'is', 'finish', 'start', 'random', 'isUrl',
]);


// `Str::isUrl()` (Str.php, Laravel 13.37): the Symfony UrlValidator 5.0.7 pattern
// with Laravel's default protocol alternation. A faithful port - the pattern is
// taken verbatim from the vendor (possessive quantifiers flattened to greedy,
// which answer the same values) and prints the same answer as `Str::isUrl()`.
const URL_PROTOCOLS =   String.raw`aaa|aaas|about|acap|acct|acd|acr|adiumxtra|adt|afp|afs|aim|amss|android|appdata|apt|ark|attachment|aw|barion|beshare|bitcoin|bitcoincash|blob|bolo|browserext|calculator|callto|cap|cast|casts|chrome|chrome-extension|cid|coap|coap\+tcp|coap\+ws|coaps|coaps\+tcp|coaps\+ws|com-eventbrite-attendee|content|conti|crid|cvs|dab|data|dav|diaspora|dict|did|dis|dlna-playcontainer|dlna-playsingle|dns|dntp|dpp|drm|drop|dtn|dvb|ed2k|elsi|example|facetime|fax|feed|feedready|file|filesystem|finger|first-run-pen-experience|fish|fm|ftp|fuchsia-pkg|geo|gg|git|gizmoproject|go|gopher|graph|gtalk|h323|ham|hcap|hcp|http|https|hxxp|hxxps|hydrazone|iax|icap|icon|im|imap|info|iotdisco|ipn|ipp|ipps|irc|irc6|ircs|iris|iris\.beep|iris\.lwz|iris\.xpc|iris\.xpcs|isostore|itms|jabber|jar|jms|keyparc|lastfm|ldap|ldaps|leaptofrogans|lorawan|lvlt|magnet|mailserver|mailto|maps|market|message|mid|mms|modem|mongodb|moz|ms-access|ms-browser-extension|ms-calculator|ms-drive-to|ms-enrollment|ms-excel|ms-eyecontrolspeech|ms-gamebarservices|ms-gamingoverlay|ms-getoffice|ms-help|ms-infopath|ms-inputapp|ms-lockscreencomponent-config|ms-media-stream-id|ms-mixedrealitycapture|ms-mobileplans|ms-officeapp|ms-people|ms-project|ms-powerpoint|ms-publisher|ms-restoretabcompanion|ms-screenclip|ms-screensketch|ms-search|ms-search-repair|ms-secondary-screen-controller|ms-secondary-screen-setup|ms-settings|ms-settings-airplanemode|ms-settings-bluetooth|ms-settings-camera|ms-settings-cellular|ms-settings-cloudstorage|ms-settings-connectabledevices|ms-settings-displays-topology|ms-settings-emailandaccounts|ms-settings-language|ms-settings-location|ms-settings-lock|ms-settings-nfctransactions|ms-settings-notifications|ms-settings-power|ms-settings-privacy|ms-settings-proximity|ms-settings-screenrotation|ms-settings-wifi|ms-settings-workplace|ms-spd|ms-sttoverlay|ms-transit-to|ms-useractivityset|ms-virtualtouchpad|ms-visio|ms-walk-to|ms-whiteboard|ms-whiteboard-cmd|ms-word|msnim|msrp|msrps|mss|mtqp|mumble|mupdate|mvn|news|nfs|ni|nih|nntp|notes|ocf|oid|onenote|onenote-cmd|opaquelocktoken|openpgp4fpr|pack|palm|paparazzi|payto|pkcs11|platform|pop|pres|prospero|proxy|pwid|psyc|pttp|qb|query|redis|rediss|reload|res|resource|rmi|rsync|rtmfp|rtmp|rtsp|rtsps|rtspu|s3|secondlife|service|session|sftp|sgn|shttp|sieve|simpleledger|sip|sips|skype|smb|sms|smtp|snews|snmp|soap\.beep|soap\.beeps|soldat|spiffe|spotify|ssh|steam|stun|stuns|submit|svn|tag|teamspeak|tel|teliaeid|telnet|tftp|tg|things|thismessage|tip|tn3270|tool|ts3server|turn|turns|tv|udp|unreal|urn|ut2004|v-event|vemmi|ventrilo|videotex|vnc|view-source|wais|webcal|wpid|ws|wss|wtai|wyciwyg|xcon|xcon-userid|xfire|xmlrpc\.beep|xmlrpc\.beeps|xmpp|xri|ymsgr|z39\.50|z39\.50r|z39\.50s`;
// `Str::isUrl($value, $protocols)` (Str.php:631) is
// `preg_match('~^ (LARAVEL_PROTOCOLS):// ... $~ix')`. PCRE's `$` (no /D) also matches just
// before a trailing newline - `http://x.co\n` IS a url in Laravel - while JS `$` does not,
// so the pattern tail is `(?=\n?$)`.
const URL_SRC = String.raw`^(URL_PROTOCOLS_PLACEHOLDER)://(((?:[_\.\p{L}\p{N}-]|%[0-9A-Fa-f]{2})+:)?((?:[_\.\p{L}\p{N}-]|%[0-9A-Fa-f]{2})+)@)?((?:(?:(?:[\p{L}\p{N}\p{S}\p{M}\-_]+\.)+(?:(?:xn--[a-z0-9-]+)|(?:[\p{L}\p{N}\p{M}]+)))|[a-z0-9\-_]+)\.?|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[(?:(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){6})(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:::(?:(?:(?:[0-9a-f]{1,4})):){5})(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:[0-9a-f]{1,4})))?::(?:(?:(?:[0-9a-f]{1,4})):){4})(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,1}(?:(?:[0-9a-f]{1,4})))?::(?:(?:(?:[0-9a-f]{1,4})):){3})(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,2}(?:(?:[0-9a-f]{1,4})))?::(?:(?:(?:[0-9a-f]{1,4})):){2})(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,3}(?:(?:[0-9a-f]{1,4})))?::(?:(?:[0-9a-f]{1,4})):)(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,4}(?:(?:[0-9a-f]{1,4})))?::)(?:(?:(?:(?:(?:[0-9a-f]{1,4})):(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,5}(?:(?:[0-9a-f]{1,4})))?::)(?:(?:[0-9a-f]{1,4})))|(?:(?:(?:(?:(?:(?:[0-9a-f]{1,4})):){0,6}(?:(?:[0-9a-f]{1,4})))?::))))\])(:[0-9]+)?(?:/(?:[\p{L}\p{N}\-._~!$&'()*,;=:@]|%[0-9A-Fa-f]{2})*)*(?:\?(?:[\p{L}\p{N}\-._~!$&'\[\]()*,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[\p{L}\p{N}\-._~!$&'()*,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?=\n?$)`;
const URL_PATTERN = new RegExp(URL_SRC.replace('URL_PROTOCOLS_PLACEHOLDER', URL_PROTOCOLS), 'iu');
// A custom list (`url:ftp,http`) is the same pattern with the alternation replaced
// (`Str::isUrl($value, $protocols)` - Str.php implodes the array). Laravel's list is used otherwise.
function urlPatternFor(protocols) {
  if (!protocols || protocols.length === 0) return URL_PATTERN;
  return new RegExp(URL_SRC.replace('URL_PROTOCOLS_PLACEHOLDER', protocols.map(String).join('|')), 'iu');
}
function isUrl(value, protocols = []) {
  if (typeof value !== 'string') return false;
  return (protocols && protocols.length ? urlPatternFor(protocols) : URL_PATTERN).test(value);
}
export const str = {
  slug,
  limit,
  upper,
  lower,
  studly,
  camel,
  snake,
  kebab,
  title,
  contains,
  startsWith,
  endsWith,
  after,
  before,
  length,
  replace,
  replaceFirst,
  replaceLast,
  squish,
  ucfirst,
  ucwords,
  ascii,
  is,
  finish,
  start,
  random,
  isUrl,
};

export default { str, STR_METHODS, ascii };
