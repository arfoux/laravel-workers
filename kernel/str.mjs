// kernel/str.mjs - Illuminate\Support\Str (the subset that compiles at the edge).
//
// Every rule here is PHP-exact: the values are verified against the real
// Laravel (the oracle) in kernel/tests/str.test.mjs. The transliteration
// (Str::ascii) covers the Latin-1 supplement - the range Str::slug() needs.
//
// Not ported: Str::head (removed in Laravel 11+), the plural inflections, the
// random/ulid helpers and the `*Array` variants. A construct outside this
// surface fails the build (LW002), it never becomes a silent stub.

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
  æ: 'ae', œ: 'oe', đ: 'd', ð: 'd', þ: 'th',
  '·': '', '×': 'x', '©': '(c)', '®': '(r)', '™': 'tm',
};

function phpLower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function phpUpper(value) {
  return String(value == null ? '' : value).toUpperCase();
}

/** Str::ascii() - the Latin-1 transliteration (the part Str::slug needs). */
export function ascii(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
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
  value = phpLower(value);
  value = value.replace(new RegExp('[^' + escapeRe(separator) + '\\p{L}\\p{N}\\s]+', 'gu'), '');
  value = value.replace(new RegExp('[' + escapeRe(separator) + '\\s]+', 'gu'), separator);
  return trimChars(value, separator);
}

/** Str::limit() */
export function limit(value, limit = 100, end = '...') {
  const str = String(value == null ? '' : value);
  if (str.length <= limit) return str;
  return trimEnd(str.slice(0, limit)) + end;
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
  const s = studly(value);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Str::snake() */
export function snake(value, delimiter = '_') {
  let v = String(value == null ? '' : value);
  if (v !== phpLower(v)) {
    v = v.replace(/\s+/g, '');
    v = phpLower(v.replace(/(.)(?=[A-Z])/g, '$1' + delimiter));
  }
  return v;
}

/** Str::kebab() */
export function kebab(value) {
  return snake(value, '-');
}

/** Str::title() */
export function title(value) {
  return ucwords(String(value == null ? '' : value).replace(/[-_]+/g, ' '));
}

/** Str::contains() */
export function contains(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  if (Array.isArray(needles)) return needles.some((n) => h.includes(String(n)));
  return h.includes(String(needles));
}

/** Str::startsWith() */
export function startsWith(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  if (Array.isArray(needles)) return needles.some((n) => h.startsWith(String(n)));
  return h.startsWith(String(needles));
}

/** Str::endsWith() */
export function endsWith(haystack, needles) {
  const h = String(haystack == null ? '' : haystack);
  if (Array.isArray(needles)) return needles.some((n) => h.endsWith(String(n)));
  return h.endsWith(String(needles));
}

/** Str::after() */
export function after(subject, search) {
  const s = String(subject == null ? '' : subject);
  const needle = String(search == null ? '' : search);
  return needle === '' ? s : s.slice(s.indexOf(needle) + needle.length);
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
  const s = String(value == null ? '' : value);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Str::ucwords() */
export function ucwords(value) {
  return String(value == null ? '' : value).replace(/\b\w/g, (c) => c.toUpperCase());
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

// The surface the compiler allows (Str::x() -> rt.str.x()).
export const STR_METHODS = new Set([
  'slug', 'limit', 'upper', 'lower', 'studly', 'camel', 'snake', 'kebab', 'title',
  'contains', 'startsWith', 'endsWith', 'after', 'before', 'length',
  'replace', 'replaceFirst', 'replaceLast', 'squish', 'ucfirst', 'ucwords', 'ascii',
]);

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
};

export default { str, STR_METHODS, ascii };
