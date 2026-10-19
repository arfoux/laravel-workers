// kernel/validator.mjs — Validator (zero-dep, async-capable)
//
// Laravel-compatible subset. Rules are parsed pipe-safely (regex bodies may
// contain `|`). `unique` / `exists` are resolved against D1 when a `db` binding
// is supplied (opts.db) or an explicit resolver (opts.unique / opts.exists).
// Unknown rules fail loud instead of silently passing.

const DEFAULT_MESSAGES = (field, rule, param) => {
  const t = {
    required: `The ${field} field is required.`,
    string: `The ${field} must be a string.`,
    integer: `The ${field} must be an integer.`,
    numeric: `The ${field} must be a number.`,
    boolean: `The ${field} must be true or false.`,
    array: `The ${field} must be an array.`,
    email: `The ${field} must be a valid email address.`,
    url: `The ${field} must be a valid URL.`,
    date: `The ${field} must be a valid date.`,
    alpha: `The ${field} must only contain letters.`,
    alpha_num: `The ${field} must only contain letters and numbers.`,
    alpha_dash: `The ${field} must only contain letters, numbers, dashes and underscores.`,
    min: `The ${field} must be at least ${param}.`,
    max: `The ${field} must not be greater than ${param}.`,
    between: `The ${field} must be between ${param}.`,
    size: `The ${field} must be ${param}.`,
    in: `The selected ${field} is invalid.`,
    not_in: `The selected ${field} is invalid.`,
    same: `The ${field} and ${param} must match.`,
    different: `The ${field} and ${param} must be different.`,
    confirmed: `The ${field} confirmation does not match.`,
    regex: `The ${field} format is invalid.`,
    not_regex: `The ${field} format is invalid.`,
    accepted: `The ${field} must be accepted.`,
    declined: `The ${field} must be declined.`,
    digits: `The ${field} must be ${param} digits.`,
    digits_between: `The ${field} must be between ${param} digits.`,
    multiple_of: `The ${field} must be a multiple of ${param}.`,
    uuid: `The ${field} must be a valid UUID.`,
    ip: `The ${field} must be a valid IP address.`,
    ipv4: `The ${field} must be a valid IPv4 address.`,
    ipv6: `The ${field} must be a valid IPv6 address.`,
    mac_address: `The ${field} must be a valid MAC address.`,
    json: `The ${field} must be a valid JSON string.`,
    ascii: `The ${field} must only contain ASCII characters.`,
    lowercase: `The ${field} must be lowercase.`,
    uppercase: `The ${field} must be uppercase.`,
    hex_color: `The ${field} must be a valid hex color.`,
    starts_with: `The ${field} must start with one of: ${param}.`,
    ends_with: `The ${field} must end with one of: ${param}.`,
    before: `The ${field} must be a date before ${param}.`,
    after: `The ${field} must be a date after ${param}.`,
    before_or_equal: `The ${field} must be a date before or equal to ${param}.`,
    after_or_equal: `The ${field} must be a date after or equal to ${param}.`,
    date_equals: `The ${field} must be a date equal to ${param}.`,
    date_format: `The ${field} does not match the format ${param}.`,
    gt: `The ${field} must be greater than ${param}.`,
    gte: `The ${field} must be greater than or equal to ${param}.`,
    lt: `The ${field} must be less than ${param}.`,
    lte: `The ${field} must be less than or equal to ${param}.`,
    distinct: `The ${field} field has a duplicate value.`,
    unique: `The ${field} has already been taken.`,
    exists: `The selected ${field} is invalid.`,
    required_if: `The ${field} field is required when ${param}.`,
    required_unless: `The ${field} field is required unless ${param}.`,
    required_with: `The ${field} field is required when ${param} is present.`,
    required_without: `The ${field} field is required when ${param} is not present.`,
    required_with_all: `The ${field} field is required when ${param} is present.`,
    required_without_all: `The ${field} field is required when ${param} is not present.`,
    prohibited: `The ${field} field is prohibited.`,
    prohibited_if: `The ${field} field is prohibited when ${param}.`,
    prohibited_unless: `The ${field} field is prohibited unless ${param}.`,
    missing: `The ${field} field must be missing.`,
    present: `The ${field} field must be present.`,
    list: `The ${field} field must be a list.`,
    required_array_keys: `The ${field} field must contain entries for: ${param}.`,
    decimal: `The ${field} field must have ${param} decimal places.`,
    timezone: `The ${field} field must be a valid timezone.`,
    in_array: `The selected ${field} is invalid.`,
    doesnt_start_with: `The ${field} field must not start with one of the following: ${param}.`,
    doesnt_end_with: `The ${field} field must not end with one of the following: ${param}.`,
  };
  return t[rule] || `The ${field} is invalid.`;
};

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}
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
]);
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
function parseRuleToken(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return { name: token.toLowerCase(), param: null, raw: token };
  return { name: token.slice(0, idx).toLowerCase(), param: token.slice(idx + 1), raw: token };
}

// Minimal date-format translator (Y m d H i s only — the common set).
function matchDateFormat(value, format) {
  if (typeof value !== 'string') return false;
  const map = {
    Y: '\\d{4}', y: '\\d{2}', m: '\\d{2}', n: '\\d{1,2}', d: '\\d{2}', j: '\\d{1,2}',
    H: '\\d{2}', G: '\\d{1,2}', i: '\\d{2}', s: '\\d{2}',
  };
  let rx = '';
  for (const ch of String(format)) {
    rx += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp('^' + rx + '$').test(value); } catch { return false; }
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

// Illuminate\Validation\Concerns\FormatsMessages::replaceAttributePlaceholder().
function replaceAttributePlaceholder(message, value) {
  const upper = value.toUpperCase();
  const ucfirst = value.charAt(0).toUpperCase() + value.slice(1);
  return String(message).replace(/:attribute|:ATTRIBUTE|:Attribute/g, (m) => {
    if (m === ':ATTRIBUTE') return upper;
    if (m === ':Attribute') return ucfirst;
    return value;
  });
}

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
        if (!KNOWN_RULES.has(r.name)) {
          throw new Error('unknown validation rule: ' + r.name);
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
    return !this._isPresent(field) || isEmptyValue(this.get(field));
  }

  _conditionalRequired(rules) {
    // returns { required: bool, failed: ruleName|null, failedParam } for presence rules
    for (const r of rules) {
      if (r.name === 'required') return { required: true, rule: 'required', param: null };
      if (r.name === 'required_if') {
        const [other, ...vals] = String(r.param).split(',');
        const has = this._isPresent(other);
        if (has && vals.map(String).includes(String(this.get(other)))) {
          return { required: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'required_unless') {
        const [other, ...vals] = String(r.param).split(',');
        const has = this._isPresent(other);
        if (!has || !vals.map(String).includes(String(this.get(other)))) {
          return { required: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'required_with') {
        const others = String(r.param).split(',');
        if (others.some((o) => !this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_without') {
        const others = String(r.param).split(',');
        if (others.some((o) => this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_with_all') {
        const others = String(r.param).split(',');
        if (others.every((o) => !this._empty(o))) return { required: true, rule: r.name, param: r.param };
      } else if (r.name === 'required_without_all') {
        const others = String(r.param).split(',');
        if (others.every((o) => this._empty(o))) return { required: true, rule: r.name, param: r.param };
      }
    }
    return { required: false };
  }

  _prohibited(rules) {
    for (const r of rules) {
      if (r.name === 'prohibited') return { prohibited: true };
      if (r.name === 'prohibited_if') {
        const [other, ...vals] = String(r.param).split(',');
        if (this._isPresent(other) && vals.map(String).includes(String(this.get(other)))) {
          return { prohibited: true };
        }
      } else if (r.name === 'prohibited_unless') {
        const [other, ...vals] = String(r.param).split(',');
        if (!this._isPresent(other) || !vals.map(String).includes(String(this.get(other)))) {
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
        const [other, ...vals] = p.split(',').map((s) => s.trim());
        const has = this._isPresent(other);
        const match = has && vals.includes(String(this.get(other)));
        if (r.name === 'exclude_if' ? match : !match) return true;
      } else if (r.name === 'exclude_with') {
        if (p.split(',').map((s) => s.trim()).some((o) => this._isPresent(o))) return true;
      } else if (r.name === 'exclude_without') {
        if (p.split(',').map((s) => s.trim()).every((o) => !this._isPresent(o))) return true;
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
        const [other, ...vals] = p.split(',').map((s) => s.trim());
        const has = this._isPresent(other);
        const match = has && vals.includes(String(this.get(other)));
        if (r.name === 'missing_if' ? match : !match) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'missing_with') {
        if (p.split(',').map((s) => s.trim()).some((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'missing_with_all') {
        if (p.split(',').map((s) => s.trim()).every((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      }
    }
    return { enforced: false };
  }

  // `present*` rules (beyond plain `present`): the field must be present.
  _presentEnforced(rules) {
    for (const r of rules) {
      const p = String(r.param == null ? '' : r.param);
      if (r.name === 'present_if' || r.name === 'present_unless') {
        const [other, ...vals] = p.split(',').map((s) => s.trim());
        const has = this._isPresent(other);
        const match = has && vals.includes(String(this.get(other)));
        if (r.name === 'present_if' ? match : !match) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'present_with') {
        if (p.split(',').map((s) => s.trim()).some((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
      } else if (r.name === 'present_with_all') {
        if (p.split(',').map((s) => s.trim()).every((o) => this._isPresent(o))) return { enforced: true, rule: r.name, param: p };
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
        if (isEmptyValue(value)) {
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
      if (hasFilled && isEmptyValue(value)) {
        this._addError(field, 'required', null);
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
    const param = String(rule.param == null ? '' : rule.param);
    const parts = param.split(',').map((s) => s.trim());
    const table = parts[0];
    const column = parts[1] || field;
    // unique: table,column,except,idColumn
    const except = parts[2];
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
        const [other, ...vals] = String(p).split(',');
        if (this._isPresent(other) && vals.map(String).includes(String(this.get(other)))) {
          return value === true || value === 1 || value === '1' || value === 'yes' || value === 'on' || value === 'true';
        }
        return true;
      }
      case 'declined': return value === false || value === 0 || value === '0' || value === 'no' || value === 'off' || value === 'false';
      case 'digits': return typeof value !== 'undefined' && /^\d+$/.test(String(value)) && String(value).length === Number(p);
      case 'digits_between': {
        const [a, b] = String(p).split(',').map(Number);
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
        const list = String(p).split(',');
        return typeof value === 'string' && list.some((s) => value.startsWith(s));
      }
      case 'ends_with': {
        const list = String(p).split(',');
        return typeof value === 'string' && list.some((s) => value.endsWith(s));
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
        const n = Number(p);
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        return size >= n;
      }
      case 'max': {
        const n = Number(p);
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        return size <= n;
      }
      case 'between': {
        const [a, b] = String(p).split(',').map(Number);
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        return size >= a && size <= b;
      }
      case 'size': {
        const n = Number(p);
        const size = this._size(value, hasNumeric);
        if (size === null) return false;
        return size === n;
      }
      case 'in': {
        const list = String(p).split(',');
        return list.includes(String(value));
      }
      case 'not_in': {
        const list = String(p).split(',');
        return !list.includes(String(value));
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
        const list = String(p == null ? '' : p).split(',').map((s) => s.trim()).filter((s) => s !== '');
        return !(typeof value === 'string') || !list.some((pre) => value.startsWith(pre));
      }
      case 'doesnt_end_with': {
        const list = String(p == null ? '' : p).split(',').map((s) => s.trim()).filter((s) => s !== '');
        return !(typeof value === 'string') || !list.some((suf) => value.endsWith(suf));
      }
      case 'list':
        return Array.isArray(value);
      case 'required_array_keys': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = String(p == null ? '' : p).split(',').map((s) => s.trim());
        return keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
      }
      case 'array_keys': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = String(p == null ? '' : p).split(',').map((s) => s.trim());
        return Object.keys(value).every((k) => keys.includes(k));
      }
      case 'in_array': {
        // `in_array:other` / `in_array:other.*` — value must be one of that array's values.
        const other = String(p == null ? '' : p).replace(/\.\*$/, '');
        const arr = this.get(other);
        return Array.isArray(arr) && arr.some((x) => String(x) === String(value));
      }
      case 'decimal': {
        if (!isNumericValue(value)) return false;
        const [mn, mx] = String(p == null ? '' : p).split(',').map((s) => Number(s.trim()));
        const digits = String(value).includes('.') ? String(value).split('.')[1].length : 0;
        if (Number.isFinite(mn) && digits < mn) return false;
        if (Number.isFinite(mx) && digits > mx) return false;
        return true;
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
  // numeric rules win over array/list; files are not supported at the edge,
  // so everything else is a string.
  _attributeType(field) {
    const rules = this.parsed[field] || [];
    if (rules.some((r) => NUMERIC_RULES.has(r.name))) return 'numeric';
    if (rules.some((r) => ARRAY_RULES.has(r.name))) return 'array';
    const value = this.get(field);
    if (value && typeof value === 'object' && typeof File !== 'undefined' && value instanceof File) return 'file';
    return 'string';
  }

  _addError(field, rule, param) {
    const display = this._displayName(field);
    let msg = this._customMessage(field, rule);
    // getInlineMessage(): a size rule's array message is keyed by attribute type.
    if (isPhpArray(msg) && SIZE_RULES.has(phpSnake(rule))) {
      msg = msg[this._attributeType(field)] ?? null;
    }
    // Laravel checks `is_null($inlineMessage)`, so an empty custom message is
    // kept (it becomes an empty error string), unlike a JS truthiness check.
    if (msg == null) msg = DEFAULT_MESSAGES(display, rule, param);
    else msg = replaceAttributePlaceholder(msg, display);
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
