// kernel/gate.mjs — Illuminate\Auth\Access\Gate at the edge.
//
// WHAT THIS COVERS
//   The Gate's whole decision path for the two kinds of ability the edge can
//   answer, in Laravel's order (Illuminate/Auth/Access/Gate.php):
//     raw(): the `before` callbacks -> the ability -> the `after` callbacks
//     (:428-453), and `allows`/`denies`/`check`/`any`/`none`/`authorize` on
//     top of it (:326-355, :364-379, :390-...).
//   An ability is answered by a POLICY METHOD (when the first argument is a
//   model with a policy) or by a GLOBAL definition (Gate::define()).
//
// WHAT THE EDGE CANNOT DO
//   `Gate::define('x', fn ($user) => ...)` registers a CLOSURE. A closure is
//   app code the build cannot compile, so the dump refuses it and the route
//   that calls the ability stays blocked (LW002) - a silent `false` would be a
//   403 where Laravel answers 200. `Gate::define('x', 'Class@method')` (a
//   string callback) IS answerable, and so is a class implementing __invoke.
//   The same rule applies to `before`/`after` callbacks.
//
// GUESTS
//   A guest reaches a callback only when its FIRST parameter is nullable or
//   defaults to null (Gate::parameterAllowsGuests(), :529-533): otherwise
//   Laravel answers false WITHOUT calling it (canBeCalledWithUser(), :463-480).
//   The dump records that per ability, and this module honours it.
//
// The ability result is coerced like Laravel's Response: a truthy value is
// allowed; a `Response`-shaped object carries its own verdict, message and
// status.

/** The 403 Laravel's AuthorizationException renders ("This action is unauthorized."). */
export class AuthorizationError extends Error {
  constructor(message = 'This action is unauthorized.', status = 403, code = null) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = code;
  }
}

/** `Illuminate\Auth\Access\Response`: allowed/denied with a message and a status. */
export class GateResponse {
  constructor(allowed, message = null, code = null) {
    this.allowed = Boolean(allowed);
    this.message = message;
    this.code = code;
  }
  allowed() {
    return this.allowed;
  }
  denied() {
    return !this.allowed;
  }
  /** `Response::authorize()`: a denial throws Laravel's AuthorizationException. */
  authorize() {
    if (this.allowed) return this;
    throw new AuthorizationError(
      this.message || 'This action is unauthorized.',
      Number(this.code) || 403,
      this.code
    );
  }
}

// Laravel's `Arr::wrap($value)`: null stays an empty list, a list stays a list,
// anything else becomes a one-element list.
const wrap = (value) => {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * The Gate.
 *
 * @param {object} opts
 * @param {object} [opts.policies] model FQCN -> { methods: { ability: fn } }
 * @param {object} [opts.abilities] ability -> { fn, guestAllowed, class, method }
 * @param {Array}  [opts.before] the before callbacks (already compiled fns)
 * @param {Array}  [opts.after] the after callbacks
 * @param {() => Promise<object|null>} [opts.user] the current user resolver
 * @param {object} [opts.aliases] model alias/FQCN -> FQCN (the subject's class)
 */
export function createGate(opts = {}) {
  const policies = opts.policies || {};
  const abilities = opts.abilities || {};
  const before = Array.isArray(opts.before) ? opts.before : [];
  const after = Array.isArray(opts.after) ? opts.after : [];
  const resolveUser = typeof opts.user === 'function' ? opts.user : () => null;
  const aliases = opts.aliases || {};

  // The class name of a subject (a model instance, a class name, an alias).
  const subjectClassOf = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return aliases[value] || value;
    if (value.constructor && value.constructor.__lwClass) return String(value.constructor.__lwClass);
    if (value.__lwClass) return String(value.__lwClass);
    if (value.constructor && value.constructor.name) {
      const name = value.constructor.name;
      return aliases[name] || name;
    }
    return null;
  };

  // The policy method for the ability, when the subject has a policy that
  // declares it (Gate::resolveAuthCallback(), :621-645).
  const policyCallback = (ability, args) => {
    if (!args.length) return null;
    const fqcn = subjectClassOf(args[0]);
    if (!fqcn) return null;
    const policy = policies[fqcn];
    if (!policy || !policy.methods) return null;
    const fn = policy.methods[ability];
    if (typeof fn !== 'function') return null;
    return fn;
  };

  // The global definition for the ability (a compiled `Class@method`).
  const globalCallback = (ability) => {
    const def = abilities[ability];
    if (!def) return null;
    return typeof def.fn === 'function' ? def : null;
  };

  /**
   * `Gate::raw($ability, $arguments)` (Gate.php:428-453): before -> the
   * ability -> after. Answers the raw result (a bool or a Response).
   */
  const raw = async (ability, args, user) => {
    let result = null;
    // The before callbacks answer only a non-null result (Gate.php:558-568).
    for (const cb of before) {
      const r = await cb(user, ability, args);
      if (r !== null && r !== undefined) {
        result = r;
        break;
      }
    }
    if (result === null) {
      const callback = policyCallback(ability, args) || (globalCallback(ability) || {}).fn || null;
      if (callback) {
        // A guest reaches the callback only when its first parameter allows it
        // (canBeCalledWithUser(), :463-480).
        const def = globalCallback(ability);
        const guestAllowed = def ? def.guestAllowed !== false : true;
        if (user !== null && user !== undefined) {
          result = await callback(user, ...args);
        } else if (guestAllowed) {
          result = await callback(user, ...args);
        } else {
          result = false;
        }
      } else {
        // No callback at all: Laravel answers false (resolveAuthCallback()'s
        // empty closure, :642-644).
        result = false;
      }
    }
    // The after callbacks see the result and may replace it (Gate.php:570-...).
    for (const cb of after) {
      const r = await cb(user, ability, args, result);
      if (r !== null && r !== undefined) result = r;
    }
    return result;
  };

  // Laravel's `Response::allowed()` for a raw result: a Response answers its
  // own verdict, anything else is cast to bool.
  const allowedOf = (result) =>
    result instanceof GateResponse ? result.allowed : Boolean(result);

  const gate = {
    /** `Gate::allows($ability, $arguments)` (Gate.php:326-329). */
    async allows(ability, args = null) {
      const user = await resolveUser();
      return allowedOf(await raw(String(ability), wrap(args), user));
    },
    /** `Gate::denies($ability, $arguments)` (Gate.php:338-341). */
    async denies(ability, args = null) {
      return !(await gate.allows(ability, args));
    },
    /** `Gate::check($abilities, $arguments)`: ALL of them (Gate.php:350-355). */
    async check(list, args = null) {
      const names = wrap(list);
      if (!names.length) return true; // every() on an empty collection
      for (const ability of names) {
        if (!(await gate.allows(ability, args))) return false;
      }
      return true;
    },
    /** `Gate::any($abilities, $arguments)` (Gate.php:364-367). */
    async any(list, args = null) {
      const names = wrap(list);
      for (const ability of names) {
        if (await gate.allows(ability, args)) return true;
      }
      return false;
    },
    /** `Gate::none($abilities, $arguments)` (Gate.php:376-379). */
    async none(list, args = null) {
      return !(await gate.any(list, args));
    },
    /**
     * `Gate::authorize($ability, $arguments)` (Gate.php:390-...): a denial
     * throws Laravel's AuthorizationException - the 403 the kernel renders
     * with the message "This action is unauthorized.".
     */
    async authorize(ability, args = null) {
      const user = await resolveUser();
      const result = await raw(String(ability), wrap(args), user);
      if (result instanceof GateResponse) {
        result.authorize();
        return result;
      }
      if (!Boolean(result)) throw new AuthorizationError();
      return new GateResponse(true);
    },
    /** The raw result (a bool or a Response), for the callers that need it. */
    async inspect(ability, args = null) {
      const user = await resolveUser();
      return raw(String(ability), wrap(args), user);
    },
  };
  return gate;
}

export default createGate;
