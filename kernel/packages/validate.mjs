// kernel/packages/validate.mjs — cluster-E (DATA & EXPORT) shared validation
// primitive. A tiny subset of Laravel's string-rule syntax: the same
// `field => 'required|email|min:3'` shape `spatie/laravel-data` and
// `laravel/framework` validators accept, evaluated against a plain object.
//
// Parity target (Laravel 11 / spatie/laravel-data v4):
//   - `required` fails on `undefined`, `null`, `''`, and `[]` (Laravel's
//     `NotEmpty`-style emptiness for scalars/arrays).
//   - `email`  — pragmatic RFC-ish check (has local@domain with a dotted TLD).
//   - `integer`— a whole number; numeric strings like `"42"` pass (Laravel's
//     `validateInteger` accepts numeric strings when `numeric` conversion holds).
//   - `min:N`  — string length for strings, numeric value for numbers
//     (mirrors Laravel, which switches on the attribute's type).
//   - `boolean`,`array`,`uuid` — common extras the settings/DTO ports use.
// A field stops at its first failing rule, and only the first error per field is
// kept — the same "bag" shape Laravel returns from a JSON validation failure.
// Errors are keyed by top-level field (nested `a.b` keys are returned as-is).

// --- individual rules -------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isBlank(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function isInteger(v) {
  if (typeof v === 'number') return Number.isInteger(v);
  if (typeof v === 'string' && v.trim() !== '') return /^-?\d+$/.test(v.trim());
  return false;
}

function ruleFailed(rule, value) {
  if (rule === 'required') return isBlank(value);
  if (rule === 'email') return typeof value !== 'string' || !EMAIL_RE.test(value);
  if (rule === 'integer') return !isInteger(value);
  if (rule === 'boolean') return typeof value !== 'boolean' && value !== 0 && value !== 1 && value !== '0' && value !== '1';
  if (rule === 'array') return !Array.isArray(value);
  if (rule === 'uuid') return typeof value !== 'string' || !UUID_RE.test(value);
  if (rule.startsWith('min:')) {
    const min = Number(rule.slice(4));
    if (typeof value === 'number') return value < min;
    if (typeof value === 'string' || Array.isArray(value)) return value.length < min;
    return false;
  }
  if (rule.startsWith('max:')) {
    const max = Number(rule.slice(4));
    if (typeof value === 'number') return value > max;
    if (typeof value === 'string' || Array.isArray(value)) return value.length > max;
    return false;
  }
  // Unknown rule: don't silently pass/fail the whole payload — ignore it, the
  // caller owns the rule vocabulary it declared.
  return false;
}

// Default messages mirror Laravel's `validation.*` lines, with `:attribute` and
// `:min`/`:max` substituted. Callers may pass `messages` to override per field.
function defaultMessage(field, rule) {
  const attr = field.replace(/_/g, ' ');
  if (rule === 'required') return `The ${attr} field is required.`;
  if (rule === 'email') return `The ${attr} field must be a valid email address.`;
  if (rule === 'integer') return `The ${attr} field must be an integer.`;
  if (rule === 'boolean') return `The ${attr} field must be true or false.`;
  if (rule === 'array') return `The ${attr} field must be an array.`;
  if (rule === 'uuid') return `The ${attr} field must be a valid UUID.`;
  if (rule.startsWith('min:')) return `The ${attr} field must be at least ${rule.slice(4)}.`;
  if (rule.startsWith('max:')) return `The ${attr} field may not be greater than ${rule.slice(4)}.`;
  return `The ${attr} field is invalid.`;
}

function parseRules(spec) {
  if (Array.isArray(spec)) return spec;
  return String(spec).split('|').map((r) => r.trim()).filter(Boolean);
}

// Validate `input` against `{ field: 'rule|rule' }` (or an array of rules).
// Returns `{ valid, data, errors }`:
//   - `valid`  — boolean, true iff no field failed.
//   - `data`   — a NEW plain object holding only the declared fields, in
//     declaration order, with `undefined` dropped (Laravel's `validated()`).
//     The input object is never mutated.
//   - `errors` — `{ field: [message] }`, Laravel's JSON error bag (first error
//     per field, since evaluation short-circuits at the first failure).
export function validate(input, rules, { messages = {} } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const data = {};
  for (const field of Object.keys(rules)) {
    const spec = parseRules(rules[field]);
    const value = source[field];
    for (const rule of spec) {
      // Laravel skips non-presence rules when the field is absent.
      if (value === undefined && rule !== 'required') continue;
      if (ruleFailed(rule, value)) {
        errors[field] = [messages[`${field}.${rule}`] || messages[field] || defaultMessage(field, rule)];
        break;
      }
    }
    if (!errors[field] && value !== undefined) data[field] = value;
  }
  return { valid: Object.keys(errors).length === 0, data, errors };
}

// Hydrate a validated payload into a class instance (spatie/laravel-data's
// `::from($payload)`). Only `knownFields` are copied; missing ones stay
// `undefined` (the DTO's nullable/defaulted properties). Never mutates input.
export function hydrate(ClassRef, payload, knownFields) {
  const obj = new ClassRef();
  for (const f of knownFields) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, f)) obj[f] = payload[f];
  }
  return obj;
}

// Laravel's JSON validation-failure response body (422):
// `{ message, errors: { field: [..] } }`.
export function errorBag(errors, message = 'The given data was invalid.') {
  return { message, errors };
}
