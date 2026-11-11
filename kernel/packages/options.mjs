// kernel/packages/options.mjs — <select> option builder + validation glue.
// No D1. Mirrors Spatie's enum/array option helpers closely enough to drive
// both the HTML side (via `html.mjs`) and Laravel's `in:` validation rule.
//
//   buildOptions({ forArray: ['a', 'b'] })                       → [{label:'a',value:'a'}, …]
//   buildOptions({ forEnum: { Draft: 0, Live: 1 } })              → [{label:'Draft',value:0}, …]
//   buildOptions({ forArray: [...], nullable: true })             → [{label:'', value:''}, …]
//   toValidationRule(buildOptions({ forEnum: {...} }))            → 'in:0,1'

// Normalise one entry into { label, value }. Arrays of scalars use the value
// as its own label; arrays of {label,value} pass through; objects become
// label=key, value=value.
function normalise(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    // A single {label, value} pair
    if ('label' in entry || 'value' in entry) {
      return { label: String(entry.label ?? entry.value ?? ''), value: entry.value ?? '' };
    }
    return null;
  }
  return { label: String(entry), value: entry };
}

export function buildOptions({
  forArray = null,
  forEnum = null,
  nullable = false,
  nullableLabel = '',
  nullableValue = '',
  sort = null, // 'label' | 'value' | (a,b)=>number | null
} = {}) {
  const out = [];
  if (nullable) {
    out.push({ label: nullableLabel, value: nullableValue });
  }

  let source = null;
  if (Array.isArray(forArray)) {
    source = forArray.map(normalise).filter(Boolean);
  } else if (forEnum && typeof forEnum === 'object') {
    source = Object.entries(forEnum).map(([label, value]) => ({ label, value }));
  }

  if (source) {
    if (typeof sort === 'function') {
      source.sort(sort);
    } else if (sort === 'label') {
      source.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    } else if (sort === 'value') {
      source.sort((a, b) => (a.value > b.value ? 1 : a.value < b.value ? -1 : 0));
    }
    out.push(...source);
  }
  return out;
}

// Serialise options to a Laravel `in:` rule string. Empty list → ''.
// Non-scalar values are coerced with String(); null/undefined are skipped.
export function toValidationRule(options) {
  if (!Array.isArray(options)) return '';
  const values = options
    .map((o) => (o && typeof o === 'object' ? o.value : o))
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v));
  if (values.length === 0) return '';
  return `in:${values.join(',')}`;
}

export default { buildOptions, toValidationRule };
