import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-enum v3.x — an enum class with `toArray`, `values`,
// `names`, `from`, `tryFrom`, `random`. In Laravel the package backs a class of
// constants (`class UserStatus extends Enum { const ACTIVE = 'active'; ... }`)
// and exposes static helpers; here each enum is a registered definition with
// the same surface, plus a small HTTP seam to drive it.
//
// Substitution + disclosure (structural, 1:1 intent):
//   - PHP class constants -> a plain `{ NAME: value }` map handed to
//     `defineEnum(name, constants)`.
//   - `from(value)` throws PHP's native `ValueError` (as a JS Error carrying
//     `phpException: 'ValueError'`); `tryFrom(value)` returns `null` instead.
//     Disclosure: no real PHP `ValueError` object — only its name + message.
//   - No D1: this is pure in-memory logic (no persistence to port).
//
// Route wiring: registry.json → "ports": {
//   "/enums":               "spatie-enum", // GET index of enum classes
//   "/enums/{class}":       "spatie-enum", // GET toArray/values/names
//   "/enums/{class}/random":    "spatie-enum",
//   "/enums/{class}/from":      "spatie-enum", // POST {value}
//   "/enums/{class}/tryFrom":   "spatie-enum", // POST {value}
// }

// Factory: build an enum API over a `{ NAME: value }` constants map.
export function defineEnum(name, constants) {
  const entries = Object.entries(constants); // [[NAME, value], ...]

  const api = {
    name,
    // NAME => value (Laravel-enum `toArray()` / `getArray()`)
    toArray: () => Object.fromEntries(entries),
    // [value, ...] (`values()` / `getValues()`)
    values: () => entries.map(([, v]) => v),
    // [NAME, ...] (`names()` / `getNames()`)
    names: () => entries.map(([n]) => n),
    // value -> NAME
    getKey: (value) => (entries.find(([, v]) => v === value) || [null])[0],
    isValid: (value) => entries.some(([, v]) => v === value),
    isValidName: (name2) => entries.some(([n]) => n === name2),
    // from(value): instance or throws ValueError (native PHP backed-enum semantics)
    from: (value) => {
      const e = entries.find(([, v]) => v === value);
      if (!e) {
        const err = new Error(
          `'${value}' is not a valid backing value for enum ${name}`
        );
        err.phpException = 'ValueError';
        throw err;
      }
      return { class: name, name: e[0], value: e[1] };
    },
    // fromName(NAME): instance or throws ValueError
    fromName: (name2) => {
      const e = entries.find(([n]) => n === name2);
      if (!e) {
        const err = new Error(`'${name2}' is not a valid name for enum ${name}`);
        err.phpException = 'ValueError';
        throw err;
      }
      return { class: name, name: e[0], value: e[1] };
    },
    // tryFrom(value): instance or null (never throws)
    tryFrom: (value) => {
      try { return api.from(value); } catch { return null; }
    },
    // random(): a random instance (Laravel-enum `random()`)
    random: () => {
      const e = entries[Math.floor(Math.random() * entries.length)];
      return { class: name, name: e[0], value: e[1] };
    },
  };
  return api;
}

// Demo registry — the "enum classes" this port serves.
export const ENUM_REGISTRY = {
  UserStatus: defineEnum('UserStatus', {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    BANNED: 'banned',
  }),
  OrderStatus: defineEnum('OrderStatus', {
    PENDING: 'pending',
    PAID: 'paid',
    SHIPPED: 'shipped',
    CANCELLED: 'cancelled',
  }),
};

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function asInstanceOrError(result) {
  return result;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';
  const url = new URL(ctx.request ? ctx.request.url : 'http://x/' + (ctx.url || ''));
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const segs = url.pathname.split('/').filter(Boolean);
  const enumClass = (ctx.params && ctx.params.enumClass) != null ? ctx.params.enumClass : segs[1];
  const action = (ctx.params && ctx.params.action) != null ? ctx.params.action : segs[2]; // 'from' | 'tryFrom' | 'random'

  try {
    // GET /enums — index
    if (!enumClass) {
      if (method === 'GET') {
        return json(200, {
          enums: Object.keys(ENUM_REGISTRY),
          note: 'GET /enums/{class} for toArray/values/names; POST /enums/{class}/from|tryFrom {value}; GET /enums/{class}/random',
        });
      }
      return json(405, { error: 'method not allowed' });
    }

    const def = ENUM_REGISTRY[enumClass];
    if (!def) return json(404, { error: `unknown enum class '${enumClass}'` });

    // GET /enums/{class} — toArray + values + names
    if (!action && method === 'GET') {
      return json(200, {
        class: enumClass,
        toArray: def.toArray(),
        values: def.values(),
        names: def.names(),
      });
    }

    // GET /enums/{class}/random
    if (action === 'random' && method === 'GET') {
      return json(200, asInstanceOrError(def.random()));
    }

    // POST /enums/{class}/from {value}
    if (action === 'from' && method === 'POST') {
      try {
        const instance = def.from(body.value);
        return json(200, instance);
      } catch (err) {
        return json(422, {
          phpException: err.phpException || 'ValueError',
          message: String(err.message),
        });
      }
    }

    // POST /enums/{class}/tryFrom {value}
    if (action === 'tryFrom' && method === 'POST') {
      const instance = def.tryFrom(body.value);
      return json(200, { value: body.value ?? null, result: instance });
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}