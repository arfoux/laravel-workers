// kernel/validator.mjs — Validator
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
        // find closing / respecting escapes
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
  return out.filter(s => s.length > 0);
}
function parseRuleToken(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return { name: token.toLowerCase(), param: null, raw: token };
  return { name: token.slice(0, idx).toLowerCase(), param: token.slice(idx + 1), raw: token };
}

export class Validator {
  constructor(data = {}, rules = {}, customMessages = {}) {
    this.data = data;
    this.rules = rules;
    this.customMessages = customMessages;
    this.parsed = {};
    for (const [field, raw] of Object.entries(rules)) {
      let arr;
      if (Array.isArray(raw)) arr = raw.map(String);
      else if (typeof raw === 'string') arr = parsePipeString(raw);
      else arr = [];
      this.parsed[field] = arr.map(parseRuleToken);
    }
    this._errors = null;
  }

  _ensure() {
    if (this._errors !== null) return;
    this._errors = {};
    for (const field of Object.keys(this.parsed)) {
      const fieldRules = this.parsed[field];
      const hasSometimes = fieldRules.some(r => r.name === 'sometimes');
      const hasNullable = fieldRules.some(r => r.name === 'nullable');
      const hasRequired = fieldRules.some(r => r.name === 'required');
      const isAbsent = !(field in this.data) || this.data[field] === undefined;
      const value = this.data[field];

      if (hasSometimes && isAbsent) continue;

      // required check
      if (hasRequired) {
        if (isEmptyValue(value)) {
          this._addError(field, 'required', null);
          continue; // skip other rules when required fails
        }
      } else {
        if (isAbsent) continue; // optional absent field skip
      }

      if (hasNullable && (value === null || value === '')) continue;

      // if still absent after required check, skip
      if (isAbsent) continue;

      const hasNumeric = fieldRules.some(r => r.name === 'numeric' || r.name === 'integer');

      for (const r of fieldRules) {
        if (['required', 'nullable', 'sometimes'].includes(r.name)) continue;
        // stub for future DB rules
        if (['unique', 'exists'].includes(r.name)) continue; // TODO D1
        const ok = this._checkRule(field, value, r, hasNumeric);
        if (!ok) this._addError(field, r.name, r.param);
      }
    }
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
      case 'same': {
        const other = this.data[p];
        return value === other;
      }
      case 'different': {
        const other = this.data[p];
        return value !== other;
      }
      case 'confirmed': {
        const other = this.data[field + '_confirmation'];
        return value === other;
      }
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
      default: return true; // unknown rule pass
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
    this._ensure();
    return Object.keys(this._errors).length === 0;
  }
  async fails() {
    return !(await this.passes());
  }
  errors() {
    this._ensure();
    return this._errors;
  }
  validated() {
    this._ensure();
    const out = {};
    for (const field of Object.keys(this.parsed)) {
      if (this._errors[field] && this._errors[field].length > 0) continue;
      if (field in this.data && this.data[field] !== undefined) out[field] = this.data[field];
    }
    return out;
  }
}

export async function validate(data, rules, messages) {
  const v = new Validator(data, rules, messages);
  const ok = await v.passes();
  return { ok, errors: v.errors(), validated: v.validated() };
}
export default { Validator, validate };
