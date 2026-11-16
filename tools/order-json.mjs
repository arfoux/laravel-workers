// tools/order-json.mjs — transport a PHP array's INSERTION ORDER across the
// build-time JSON boundary (#416).
//
// `static.mjs` records a dumped config value's PHP key order in the
// non-enumerable `__lwOrder` marker, and the kernel's `phpJsonEncode()` reads
// it back. But a plain `JSON.stringify()` DROPS non-enumerable properties, so
// the order was lost the moment `config-dump.mjs` wrote its output: a
// `config/*.php` with a non-monotonic integer key (`[-1 => 'm', 'n']`) reached
// the edge as `{"0":"n","-1":"m"}` where PHP answers `{"-1":"m","0":"n"}`.
//
// This module carries the marker explicitly in the JSON text and rebuilds it,
// so the order survives:  config-dump -> serializeOrdered -> build ->
// deserializeOrdered -> config.generated.mjs.
import { GENERATED_BANNER } from './generated.mjs';

const RESERVED = '__lw$o';
// A config key named `__proto__` is not data in a JS object literal or in an
// assignment to `{}`: it changes the prototype. Reject the three prototype
// names at every boundary so neither the JSON transport nor the generated
// module can carry one into the worker's config.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKeys(value, path = 'config') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeKeys(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      throw new Error(`order-json: reserved key "${key}" at ${path}.${key} cannot be emitted to config.generated.mjs`);
    }
    assertSafeKeys(value[key], `${path}.${key}`);
  }
}

/** JSON text of `value` with every `__lwOrder` marker carried explicitly. */
export function serializeOrdered(value) {
  assertSafeKeys(value);
  const enc = (v) => {
    if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      const body = keys.map((k) => JSON.stringify(k) + ':' + enc(v[k])).join(',');
      const hasMarker = Array.isArray(v.__lwOrder) && Object.prototype.hasOwnProperty.call(v, '__lwOrder');
      const hasReserved = Object.prototype.hasOwnProperty.call(v, RESERVED);
      if (hasMarker || hasReserved) {
        const order = (hasMarker ? v.__lwOrder.map(String) : keys.map(String)).filter((k) =>
          Object.prototype.hasOwnProperty.call(v, k)
        );
        return '{"' + RESERVED + '":' + JSON.stringify(order) + ',"v":{' + body + '}}';
      }
      return '{' + body + '}';
    }
    return JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v);
  };
  return enc(value);
}

/** Inverse of `serializeOrdered`: rebuilds the objects and re-attaches the
 *  non-enumerable `__lwOrder` marker so the kernel reads PHP's order again. */
export function deserializeOrdered(text) {
  const parsed = JSON.parse(text);
  assertSafeKeys(parsed);
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v[RESERVED]) && v.v !== null && typeof v.v === 'object') {
        const inner = dec(v.v);
        // Null prototype: even if a reserved key slips through a future
        // transport, assigning it is data and cannot change the prototype.
        const obj = Object.create(null);
        for (const k of Object.keys(inner)) obj[k] = inner[k];
        Object.defineProperty(obj, '__lwOrder', {
          value: v[RESERVED].map(String),
          enumerable: false,
        });
        return obj;
      }
      const o = Object.create(null);
      for (const k of Object.keys(v)) o[k] = dec(v[k]);
      return o;
    }
    return v;
  };
  return dec(parsed);
}

/** The source of `dist/src/config.generated.mjs`: a JS module whose default
 *  export is `value`, with every `__lwOrder` re-attached at load time (a JS
 *  object literal cannot carry a non-enumerable property, so the marker is
 *  re-applied through a tiny `__ow()` helper). */
export function configModuleSource(value) {
  assertSafeKeys(value);
  const emit = (v) => {
    if (Array.isArray(v)) return '[' + v.map(emit).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      const lit = '{' + keys.map((k) => JSON.stringify(k) + ':' + emit(v[k])).join(',') + '}';
      const order = Object.prototype.hasOwnProperty.call(v, '__lwOrder') ? v.__lwOrder : null;
      return Array.isArray(order) ? '__ow(' + lit + ', ' + JSON.stringify(order.map(String)) + ')' : lit;
    }
    return JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v);
  };
  return (
    GENERATED_BANNER + '\n' +
    'const __ow = (o, k) => Object.defineProperty(o, "__lwOrder", { value: k, enumerable: false });\n' +
    'void __ow;\n' +
    'export default ' + emit(value) + ';\n'
  );
}

export default { serializeOrdered, deserializeOrdered, configModuleSource };
