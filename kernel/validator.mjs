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
    prohibited: `The ${field} field is prohibited.`,
    prohibited_if: `The ${field} field is prohibited when ${param}.`,
    prohibited_unless: `The ${field} field is prohibited unless ${param}.`,
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
const KNOWN_RULES = new Set([
  ...MODIFIERS,
  ...PRESENCE_RULES,
  ...ASYNC_RULES,
  'string', 'integer', 'numeric', 'boolean', 'array', 'email', 'url', 'date', 'alpha',
  'alpha_num', 'alpha_dash', 'min', 'max', 'between', 'size', 'in', 'not_in', 'same',
  'different', 'confirmed', 'regex', 'not_regex', 'accepted', 'accepted_if', 'declined',
  'digits', 'digits_between', 'multiple_of', 'uuid', 'ip', 'ipv4', 'ipv6', 'mac_address',
  'json', 'ascii', 'lowercase', 'uppercase', 'hex_color', 'starts_with', 'ends_with',
  'before', 'after', 'before_or_equal', 'after_or_equal', 'date_equals', 'date_format',
  'gt', 'gte', 'lt', 'lte', 'distinct',
]);

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

export class Validator {
  constructor(data = {}, rules = {}, customMessages = {}, opts = {}) {
    this.data = data;
    this.rules = rules;
    this.customMessages = customMessages;
    this.opts = opts || {};
    this.parsed = {};
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
      this.parsed[field] = parsed;
    }
    this._errors = null;
    this._asyncDone = false;
  }

  _resolve(name) {
    const fn = this.opts && this.opts[name];
    return typeof fn === 'function' ? fn : null;
  }

  _isPresent(field) {
    return Object.prototype.hasOwnProperty.call(this.data, field) && this.data[field] !== undefined;
  }
  _empty(field) {
    return !this._isPresent(field) || isEmptyValue(this.data[field]);
  }

  _conditionalRequired(rules) {
    // returns { required: bool, failed: ruleName|null, failedParam } for presence rules
    const data = this.data;
    for (const r of rules) {
      if (r.name === 'required') return { required: true, rule: 'required', param: null };
      if (r.name === 'required_if') {
        const [other, ...vals] = String(r.param).split(',');
        const has = this._isPresent(other);
        if (has && vals.map(String).includes(String(data[other]))) {
          return { required: true, rule: r.name, param: r.param };
        }
      } else if (r.name === 'required_unless') {
        const [other, ...vals] = String(r.param).split(',');
        const has = this._isPresent(other);
        if (!has || !vals.map(String).includes(String(data[other]))) {
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
        if (this._isPresent(other) && vals.map(String).includes(String(this.data[other]))) {
          return { prohibited: true };
        }
      } else if (r.name === 'prohibited_unless') {
        const [other, ...vals] = String(r.param).split(',');
        if (!this._isPresent(other) || !vals.map(String).includes(String(this.data[other]))) {
          return { prohibited: true };
        }
      }
    }
    return { prohibited: false };
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
      const value = this.data[field];

      if (hasSometimes && isAbsent) continue;

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
      const fieldRules = this.parsed[field];
      const bail = fieldRules.some((r) => r.name === 'bail');
      const value = this.data[field];
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
        if (this._isPresent(other) && vals.map(String).includes(String(this.data[other]))) {
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
        const other = this.data[p];
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
      case 'same': return value === this.data[p];
      case 'different': return value !== this.data[p];
      case 'confirmed': return value === this.data[field + '_confirmation'];
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

  _addError(field, rule, param) {
    const key = `${field}.${rule}`;
    let msg = this.customMessages[key];
    if (!msg) msg = DEFAULT_MESSAGES(field, rule, param);
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
      if (this._errors[field] && this._errors[field].length > 0) continue;
      if (field in this.data && this.data[field] !== undefined) out[field] = this.data[field];
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
