// kernel/validation-messages.mjs — Laravel's validation messages.
//
// The texts come from Laravel's own `lang/en/validation.php` (the framework's
// copy is generated into kernel/validation-messages.data.mjs; the app may
// publish its own copy, which the build dumps with the translations and the
// runtime prefers — Laravel's order: the app's file wins).
//
// The placeholders are replaced the way Laravel does it
// (Illuminate\Validation\ReplacesAttributes + FormatsMessages):
//   :attribute (the display name) · :input · :index/:position · and the
//   per-rule placeholders (:max, :min, :size, :values, :other, :value, ...).
import { LARAVEL_VALIDATION_MESSAGES } from './validation-messages.data.mjs';

export { LARAVEL_VALIDATION_MESSAGES };

// Str::upper() / Str::ucfirst() — the case variants of a placeholder.
const ucfirst = (value) => {
  const str = String(value);
  return str.charAt(0).toUpperCase() + str.slice(1);
};

// Illuminate\Validation\ReplacesAttributes::replaceWhileKeepingCase() —
// ':other', ':OTHER' and ':Other' all point at the same value.
function replaceKeepingCase(message, mapping) {
  let out = message;
  for (const [placeholder, value] of Object.entries(mapping)) {
    const str = String(value);
    out = out
      .split(':' + placeholder).join(str)
      .split(':' + placeholder.toUpperCase()).join(str.toUpperCase())
      .split(':' + ucfirst(placeholder)).join(ucfirst(str));
  }
  return out;
}

/**
 * The default message of a rule.
 *
 * @param {object} messages  the message table (the app's + the framework's)
 * @param {string} rule      the rule name (snake_case)
 * @param {string} type      the attribute's type ('string'|'numeric'|'array'|'file')
 * @returns {string|null}    the message with its placeholders, or null
 */
export function defaultValidationMessage(messages, rule, type) {
  const table = messages && typeof messages === 'object' ? messages : LARAVEL_VALIDATION_MESSAGES;
  const entry = table[rule];
  if (entry === undefined || entry === null) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return null;
  // The size rules pick the message by the attribute's type
  // (Laravel's getSizeMessage(): `validation.max.file`).
  if (type && entry[type] !== undefined) return entry[type];
  const first = Object.values(entry)[0];
  return typeof first === 'string' ? first : null;
}

/**
 * Replace the placeholders of a validation message, like Laravel does.
 *
 * @param {string} raw       the message (with the placeholders)
 * @param {object} ctx
 *   attribute  the attribute name
 *   display    the displayable attribute (the name the message shows)
 *   rule       the rule name (snake_case)
 *   params     the rule's parameters (the strings after the colon)
 *   displayOf  (attribute) => the display name of another attribute
 *   valueOf    (attribute) => the value of another attribute
 *   data       the validated data
 * @returns {string}
 */
export function renderValidationMessage(raw, ctx) {
  const {
    attribute,
    display,
    rule,
    params = [],
    displayOf = () => '',
    valueOf = () => undefined,
    data = {},
  } = ctx;
  let message = String(raw == null ? '' : raw);

  // FormatsMessages::replaceAttributePlaceholder() — ':attribute', ':ATTRIBUTE'
  // and ':Attribute'.
  message = replaceKeepingCase(message, { attribute: display });

  // FormatsMessages::replaceInputPlaceholder() — the value of the attribute.
  if (message.includes(':input')) {
    const actual = data && typeof data === 'object' ? data[attribute] : undefined;
    if (actual === null || actual === undefined || ['string', 'number', 'boolean'].includes(typeof actual)) {
      message = message.split(':input').join(actual === null || actual === undefined ? '' : String(actual));
    }
  }

  // The per-rule placeholders (ReplacesAttributes).
  const p = (i) => (params[i] === undefined ? '' : String(params[i]));
  const other = () => displayOf(params[0]);
  const otherValue = () => valueOf(params[0]);
  const values = (sep) => params.map((v) => String(v)).join(sep);

  switch (rule) {
    case 'accepted_if':
    case 'declined_if':
    case 'required_if':
    case 'missing_if':
    case 'present_if':
    case 'prohibited_if':
      message = replaceKeepingCase(message, { other: other(), value: String(otherValue() ?? '') });
      break;
    case 'required_if_accepted':
    case 'required_if_declined':
    case 'prohibited_if_accepted':
    case 'prohibited_if_declined':
      message = replaceKeepingCase(message, { other: other() });
      break;
    case 'required_unless':
    case 'missing_unless':
    case 'present_unless':
    case 'prohibited_unless': {
      const list = params.slice(1).map((v) => String(v));
      message = replaceKeepingCase(message, { other: other() });
      message = message
        .split(':values').join(list.join(', '))
        .split(':VALUES').join(list.join(', ').toUpperCase())
        .split(':Values').join(list.map(ucfirst).join(', '));
      break;
    }
    case 'required_with':
    case 'required_with_all':
    case 'required_without':
    case 'required_without_all':
    case 'missing_with':
    case 'missing_with_all':
    case 'present_with':
    case 'present_with_all': {
      const list = params.map((a) => displayOf(a));
      message = message
        .split(':values').join(list.join(' / '))
        .split(':VALUES').join(list.join(' / ').toUpperCase())
        .split(':Values').join(list.map(ucfirst).join(' / '));
      break;
    }
    case 'prohibits':
      message = replaceKeepingCase(message, { other: params.map((a) => displayOf(a)).join(' / ') });
      break;
    case 'between':
      message = message.split(':min').join(p(0)).split(':max').join(p(1));
      break;
    case 'digits_between':
      message = message.split(':min').join(p(0)).split(':max').join(p(1));
      break;
    case 'min':
    case 'min_digits':
      message = message.split(':min').join(p(0));
      break;
    case 'max':
    case 'max_digits':
      message = message.split(':max').join(p(0));
      break;
    case 'size':
      message = message.split(':size').join(p(0));
      break;
    case 'digits':
      message = message.split(':digits').join(p(0));
      break;
    case 'decimal':
      message = message.split(':decimal').join(params[1] !== undefined ? p(0) + '-' + p(1) : p(0));
      break;
    case 'multiple_of':
      message = message.split(':value').join(p(0));
      break;
    case 'date_format':
      message = message.split(':format').join(p(0));
      break;
    case 'encoding':
      message = message.split(':encoding').join(p(0));
      break;
    case 'in':
    case 'not_in':
    case 'starts_with':
    case 'ends_with':
    case 'doesnt_start_with':
    case 'doesnt_end_with':
    case 'mimes':
    case 'mimetypes':
    case 'extensions':
    case 'required_array_keys':
    case 'in_array_keys': {
      const list = params.map((v) => String(v));
      message = message
        .split(':values').join(list.join(', '))
        .split(':VALUES').join(list.join(', ').toUpperCase())
        .split(':Values').join(list.map(ucfirst).join(', '));
      break;
    }
    case 'array_keys': {
      const list = params.map((v) => String(v));
      message = message
        .split(':values').join(list.join(', '))
        .split(':VALUES').join(list.join(', ').toUpperCase())
        .split(':Values').join(list.map(ucfirst).join(', '));
      const value = data && typeof data === 'object' ? data[attribute] : undefined;
      const unexpected = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).filter((k) => !params.includes(k))
        : [];
      message = replaceKeepingCase(message, { unexpected: unexpected.join(', ') });
      break;
    }
    case 'same':
    case 'different':
    case 'in_array':
      message = replaceKeepingCase(message, { other: other() });
      break;
    case 'before':
    case 'before_or_equal':
    case 'after':
    case 'after_or_equal':
    case 'date_equals': {
      // A parameter that is not a date shows the other attribute's name.
      const raw = p(0);
      const isDate = !Number.isNaN(Date.parse(raw));
      message = message.split(':date').join(isDate ? raw : other());
      break;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = valueOf(params[0]);
      message = message.split(':value').join(value === null || value === undefined ? other() : String(value));
      break;
    }
    case 'dimensions': {
      for (const [key, value] of Object.entries(params)) {
        message = message.split(':' + key).join(String(value));
      }
      break;
    }
    default:
      break;
  }
  return message;
}

export default {
  LARAVEL_VALIDATION_MESSAGES,
  defaultValidationMessage,
  renderValidationMessage,
};
