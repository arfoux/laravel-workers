// kernel/model.mjs — Model base
import { table as tableBuilder } from './db.mjs';
import { isHashedDigest, makeSync, verifyConfiguration } from './hash.mjs';
import { Collection } from './collections.mjs';

const JSON_CASTS = new Set(['json', 'array', 'object', 'collection']);

// Eloquent `castAttributeAsHashedString()`: plaintext is hashed with Hash::make()
// at set-time; an already-hashed value is passed through only when it matches the
// configured hasher (bcrypt cost <= rounds), otherwise Laravel throws
// RuntimeException("Could not verify the hashed value's configuration.").
// `isHashedDigest` mirrors HashManager::isHashed() on PHP 8.3 exactly: only a
// full `$2y$` digest (or an argon2 digest) counts as already hashed.
function castAttributeAsHashedString(value, rounds) {
  if (value === null || value === undefined) return null;
  if (!isHashedDigest(value)) return makeSync(value, { rounds });
  if (!verifyConfiguration(value, { rounds })) {
    const err = new Error("Could not verify the hashed value's configuration.");
    err.name = 'RuntimeException';
    err.phpClass = 'RuntimeException';
    throw err;
  }
  return value;
}

// PHP's (bool): false for null, false, 0, 0.0, '' and '0' - every other
// value is true ('false' is TRUE in PHP, and so is a non-empty array).
function phpBoolCast(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// PHP's (int): the leading integer part ('12abc' -> 12, 'abc' -> 0, 1.9 -> 1).
function phpIntCast(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (Array.isArray(value)) return value.length ? 1 : 0;
  const m = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
  if (!m) return 0;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// PHP's (float): the leading number ('12abc' -> 12.0).
function phpFloatCast(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.length ? 1 : 0;
  const m = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
  if (!m) return 0;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : 0;
}

// Laravel's decimal cast: BigDecimal::of((string) $value)->toScale($decimals,
// RoundingMode::HalfUp) - the rounding happens on the DECIMAL string, not on
// the binary double ('2.675' -> '2.68', where toFixed() says '2.67').
function phpDecimalCast(value, places) {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(value));
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    const err = new Error('Unable to cast value to a decimal.');
    err.phpClass = 'MathException';
    throw err;
  }
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] || '0';
  const frac = (m[3] || '').padEnd(places + 1, '0');
  const roundUp = Number(frac[places] || '0') >= 5;
  const scaled = BigInt(int + frac.slice(0, places)) + (roundUp ? 1n : 0n);
  const digits = scaled.toString().padStart(places + 1, '0');
  const intPart = digits.slice(0, digits.length - places) || '0';
  return sign + intPart + (places ? '.' + digits.slice(digits.length - places) : '');
}

// Laravel's `asTimestamp()`: the date's Unix timestamp (the model's date
// format is 'Y-m-d H:i:s' in UTC).
function phpTimestampCast(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Math.trunc(value);
  const str = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// Laravel's Carbon::toJSON() (Carbon/Converter.php:442-455): `toISOString()`
// CONVERTS TO UTC first, then appends `Z`. The model stores the wall clock in
// the APP's timezone (`phpDateString`), so a Jakarta `2025-10-23 07:00:00`
// serialises as `2025-10-23T00:00:00.000000Z` - not `...T07:00:00Z`.
export function isoDateString(value, tz = modelTimezone.value) {
  if (value == null) return value;
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return value;
  const ms = wallClockToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], tz);
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000000Z`
  );
}

// The attributes Laravel treats as dates: the timestamps + the date casts
// (HasAttributes::getDates()).
function isDateAttribute(ctor, key) {
  if (key === 'created_at' || key === 'updated_at') return true;
  const cast = ctor.casts && ctor.casts[key];
  if (cast == null) return false;
  const spec = String(cast).toLowerCase();
  return spec === 'date' || spec === 'datetime' || spec === 'immutable_date' || spec === 'immutable_datetime';
}

function applyCast(value, cast) {
  if (value == null) return value;
  const spec = String(cast).toLowerCase();
  if (JSON_CASTS.has(spec)) return typeof value === 'string' ? JSON.parse(value) : value;
  if (spec.startsWith('decimal:')) {
    const places = Number(spec.slice('decimal:'.length)) || 0;
    return phpDecimalCast(value, places);
  }
  if (spec === 'int' || spec === 'integer') return phpIntCast(value);
  if (spec === 'timestamp') return phpTimestampCast(value);
  if (spec === 'float' || spec === 'double' || spec === 'real') return phpFloatCast(value);
  if (spec === 'bool' || spec === 'boolean') return phpBoolCast(value);
  if (spec === 'string') return String(value);
  // date/datetime/immutable_* and unknown casts pass through (strings in D1).
  return value;
}

// PHP's `is_numeric()`: a number, or a string that reads as one. Laravel's
// `originalIsEquivalent()` ends on this test (the values compare by their
// numeric reading, not by their PHP type).
function phpIsNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

// Laravel's json-cast branch of `originalIsEquivalent()`:
// `$this->fromJson($attribute) === $this->fromJson($original)` - the decoded
// values must match (the decoded arrays compare key for key, in order).
function jsonEquivalent(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

// The app's timezone (config('app.timezone')): Laravel sets PHP's default from
// it, so every model timestamp is written and rendered in it. The runtime
// stamps this next to the clock (`Model.timezone = ctx['app.timezone']`); the
// default is Laravel's own default.
const modelTimezone = { value: 'UTC' };
export function setModelTimezone(tz) {
  modelTimezone.value = tz ? String(tz) : 'UTC';
}
export function modelTimezoneName() {
  return modelTimezone.value;
}

const tzFormatters = new Map();
function zonePartsIn(d, tz) {
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT') {
    return {
      Y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      H: d.getUTCHours(), i: d.getUTCMinutes(), s: d.getUTCSeconds(),
    };
  }
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    tzFormatters.set(tz, f);
  }
  const parts = {};
  for (const part of f.formatToParts(d)) if (part.type !== 'literal') parts[part.type] = part.value;
  return {
    Y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    H: Number(parts.hour) % 24, i: Number(parts.minute), s: Number(parts.second),
  };
}

/** The UTC instant (ms) of a wall-clock time in `tz`. */
function wallClockToUtcMs(Y, m, d, H, i, sec, tz) {
  let guess = Date.UTC(Y, m - 1, d, H, i, sec);
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT') return guess;
  // The zone's offset at the guessed instant, applied once (a second pass
  // settles a DST boundary).
  for (let pass = 0; pass < 2; pass++) {
    const p = zonePartsIn(new Date(guess), tz);
    const asUtc = Date.UTC(p.Y, p.m - 1, p.d, p.H, p.i, p.s);
    const offset = asUtc - guess;
    if (offset === 0) break;
    const next = Date.UTC(Y, m - 1, d, H, i, sec) - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

// Laravel's `freshTimestampString()` (Model.php:1729-1732 ->
// HasAttributes::freshTimestampString()): `format('Y-m-d H:i:s')` in the APP's
// timezone - not UTC (an Asia/Jakarta app writes 07:00 for 00:00Z).
export function phpDateString(d, tz = modelTimezone.value) {
  const p = (n) => String(n).padStart(2, '0');
  const z = zonePartsIn(d, tz);
  return (
    `${z.Y}-${p(z.m)}-${p(z.d)} ` +
    `${p(z.H)}:${p(z.i)}:${p(z.s)}`
  );
}

// Accessors/mutators follow Laravel's naming: getFooBarAttribute / setFooBarAttribute.
function studly(key) {
  return String(key)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export class Model {
  // The marker the JSON encoder looks for: a Model is JsonSerializable
  // (Laravel's json_encode($model) answers the model's toArray()). The marker
  // travels on the class, so a subclass inherits it.
  static __lwModel = true;
  static table = null;
  static primaryKey = 'id';
  static fillable = [];
  // Laravel's own default (GuardsAttributes::$guarded = ['*']): a model that
  // declares NEITHER $fillable nor $guarded refuses every mass assignment.
  static guarded = ['*'];
  static casts = {};
  // bcrypt rounds used by the `hashed` cast (build bakes config
  // hashing.bcrypt.rounds; Laravel's BcryptHasher default is 12).
  static hashRounds = 12;
  static hidden = [];
  static visible = [];
  static appends = [];
  static timestamps = true;
  static softDeletes = false;
  static deletedAtColumn = 'deleted_at';
  // The clock the model timestamps use. The kernel injects the request clock
  // (a frozen clock in the parity tests) so a write carries the same
  // `created_at`/`updated_at` as the PHP side.
  // Laravel's `$wasRecentlyCreated` (Model.php:143): the model was created by
  // this instance, so a controller that returns it answers 201.
  wasRecentlyCreated = false;
  static clock = null;
  // A static METHOD, not an arrow field: an arrow would capture the base
  // class, so the clock the kernel injects on the compiled model class (a
  // subclass) was ignored and the timestamps carried the wall clock.
  static now() {
    return phpDateString(this.clock ? new Date(this.clock() * 1000) : new Date());
  }
  // Declared relations, used by `with()` / `related()` (Laravel's `$with`):
  //   static relations = { comments: { type: 'hasMany', model: Comment } };
  static relations = {};
  // The methods the app declares on the model (the relations, the accessors).
  // The compiled rung has none of them: reading one fails loud (the view
  // path has no type info, so only the runtime can catch it there).
  static notCompiled = [];

  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this._relations = {};
    // The attributes touched through set()/fill()/forceFill(). The insert
    // path persists them (an attribute that is not fillable, e.g. the
    // remember_token the auth guard writes). The dirty CHECK is `getDirty()`
    // below - the comparison with the original.
    this._dirty = new Set();
    this.exists = this.attributes[this.constructor.primaryKey] != null;
    // Eloquent's `$original`: the attribute snapshot the dirty check compares
    // against. A model that carries its key is a row that is already in the
    // database (the compiled rung's `exists` flag), so its attributes ARE the
    // original ones - Eloquent hydrates a row with `newFromBuilder()`
    // (`Model.php:811`) -> `setRawAttributes($attributes, true)`
    // (`HasAttributes.php:2103`), which syncs the original. A model without a
    // key is new: Eloquent's constructor calls `syncOriginal()` BEFORE
    // `fill()` (`Model.php:331`), so every attribute it carries is dirty.
    this._original = this.exists ? { ...this.attributes } : {};
  }

  // Eloquent's `getDirty()` (HasAttributes.php:2341): the attributes that
  // differ from the model's original. This is what "dirty" means in Eloquent:
  // an attribute that was set to the value it already had is NOT dirty.
  getDirty() {
    const dirty = [];
    for (const key of Object.keys(this.attributes)) {
      if (!this.originalIsEquivalent(key)) dirty.push(key);
    }
    return dirty;
  }

  // Eloquent's `isDirty()` (HasAttributes.php:2262): has the model (or the
  // given attribute) changed since the last sync?
  isDirty(attribute) {
    const dirty = this.getDirty();
    if (attribute === undefined) return dirty.length > 0;
    return dirty.includes(attribute);
  }

  // Eloquent's `originalIsEquivalent()` (HasAttributes.php:2390): is the
  // current value of the attribute the same as the original one?
  originalIsEquivalent(key) {
    if (!Object.prototype.hasOwnProperty.call(this._original, key)) return false;
    const attribute = this.attributes[key];
    const original = this._original[key];
    if (attribute === original) return true;
    if (attribute == null) return false;
    const cast = this.constructor.casts[key];
    if (cast != null) {
      const spec = String(cast).toLowerCase();
      // The json-ish casts compare the decoded values.
      if (JSON_CASTS.has(spec)) return jsonEquivalent(attribute, original);
      // The float casts compare with an epsilon.
      if (spec === 'float' || spec === 'double' || spec === 'real') {
        return Math.abs(applyCast(attribute, cast) - applyCast(original, cast)) < Number.EPSILON * 4;
      }
      // The primitive casts compare the cast values ('5' and 5 are the same
      // 'int'). The `hashed` cast hashes at set-time and stores the digest
      // raw (`HasAttributes.php:1133`), so the digests compare as they are: a
      // re-hash of the same password is a different value and stays dirty.
      if (spec !== 'hashed') return applyCast(attribute, cast) === applyCast(original, cast);
    }
    // Laravel's last resort: two numeric values that read the same.
    return phpIsNumeric(attribute) && phpIsNumeric(original) && String(attribute) === String(original);
  }

  // Eloquent's `syncOriginal()` (HasAttributes.php:2206): the current
  // attributes become the new original (the baseline of the dirty check).
  syncOriginal() {
    this._original = { ...this.attributes };
    return this;
  }

  // Eloquent's `syncOriginalAttributes()` (HasAttributes.php:2230): the given
  // attributes become part of the original.
  syncOriginalAttributes(attributes) {
    for (const key of [].concat(attributes)) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, key)) this._original[key] = this.attributes[key];
    }
    return this;
  }

  get(key) {
    const ctor = this.constructor;
    if (ctor.notCompiled && ctor.notCompiled.includes(key)) {
      throw new Error(
        'the model attribute "' + key + '" is not compiled (a relation or an accessor) - ' +
          'write a port handler for this route'
      );
    }
    // Eloquent's getAttribute() (HasAttributes.php:415-445) resolves in this
    // order: an attribute or a cast (through getAttributeValue), a method of
    // the same name, then a RELATION (getRelationValue). An accessor is part
    // of the attribute path (transformModelValue runs it first, :527-560).
    const accessor = 'get' + studly(key) + 'Attribute';
    const hasAccessor = typeof this[accessor] === 'function';
    const hasAttribute = Object.prototype.hasOwnProperty.call(this.attributes, key);
    const hasCast = ctor.casts && Object.prototype.hasOwnProperty.call(ctor.casts, key);
    if (hasAttribute || hasCast || hasAccessor) {
      let value = this.attributes[key];
      const cast = ctor.casts ? ctor.casts[key] : null;
      if (cast != null) value = applyCast(value, cast);
      if (hasAccessor) value = this[accessor](value);
      return value;
    }
    // A declared relation: Eloquent's getRelationValue() answers the CACHED
    // relation and otherwise hits the database (:425-435). The kernel has no
    // ambient `db`, so an unloaded relation cannot load itself - it stops
    // loudly and names the two supported paths instead of answering null.
    if (ctor.relations && Object.prototype.hasOwnProperty.call(ctor.relations, key)) {
      if (!this.relationLoaded(key)) {
        throw new Error(
          'the relation "' + key + '" is not loaded - use related(db, "' + key + '") or with("' + key + '")'
        );
      }
      return this.getRelation(key);
    }
    // Anything else: Laravel's getAttribute() answers NULL
    // (HasAttributes.php:415-445 - getRelationValue() returns null when the
    // key is not a relation). The dump-declared uncompiled keys were already
    // rejected above, so a silent null here is the app's own null, not a
    // hidden construct.
    return null;
  }

  set(key, value) {
    const mutator = 'set' + studly(key) + 'Attribute';
    let next = value;
    if (typeof this[mutator] === 'function') {
      next = this[mutator](value);
    } else {
      const cast = this.constructor.casts[key];
      if (cast != null) {
        const spec = String(cast).toLowerCase();
        if (spec === 'hashed') {
          next = castAttributeAsHashedString(value, this.constructor.hashRounds);
        } else if (JSON_CASTS.has(spec)) {
          next = value == null ? null : JSON.stringify(value);
        }
      }
    }
    this.attributes[key] = next;
    this._dirty.add(key);
    return this;
  }

  /**
   * `Model::isFillable($key)` (GuardsAttributes::isFillable(), :96-135): a
   * `$fillable` list wins; otherwise `$guarded = ['*']` refuses everything and
   * an empty `$guarded` allows everything.
   */
  static isFillableKey(key) {
    // GuardsAttributes::isFillable() (:213-224), verbatim:
    //   1. the `$fillable` list wins (a listed key is fillable);
    //   2. a guarded key is not;
    //   3. otherwise (no `$fillable` declared) a key is fillable only when it
    //      carries no dot and does not start with `_` - Laravel's defence
    //      against a nested/relation path and a framework-reserved column.
    const fillable = this.fillable || [];
    if (fillable.includes(key)) return true;
    if (Model.isGuardedKey(this, key)) return false;
    return (
      fillable.length === 0 && !String(key).includes('.') && !String(key).startsWith('_')
    );
  }

  /**
   * `GuardsAttributes::isGuarded($key)` (:230-235): a case-insensitive match
   * against `$guarded`, or `$guarded = ['*']` guarding everything.
   */
  static isGuardedKey(ctor, key) {
    const guarded = ctor.guarded;
    if (guarded === undefined || guarded === null) return false;
    if (guarded.length === 1 && guarded[0] === '*') return true;
    return guarded.some((g) => String(g).toLowerCase() === String(key).toLowerCase());
  }

  /** `GuardsAttributes::totallyGuarded()` (:243-246). */
  static totallyGuarded(ctor) {
    return (ctor.fillable || []).length === 0 && Model.isGuardedKey(ctor, '*');
  }

  /**
   * `Model::fill($attributes)` (Model.php:327-345 -> fillableFromArray +
   * setAttribute): a key that is not fillable THROWS MassAssignmentException
   * when the model guards everything (`$guarded = ['*']`, the default for a
   * model that declares neither list) - Laravel's own message. Otherwise the
   * unfillable key is silently DROPPED (`fillableFromArray` filters it).
   */
  fill(attributes = {}) {
    const ctor = this.constructor;
    // Model::fill() (Model.php:327-350): the fillable keys are set; when the
    // model is TOTALLY guarded (`$guarded = ['*']`, the default for a model
    // that declares neither list) any other key throws MassAssignmentException
    // - Laravel's own message. With a `$fillable`/`$guarded` list the rest are
    // silently dropped (fillableFromArray()).
    const totallyGuarded = Model.totallyGuarded(ctor);
    for (const key of Object.keys(attributes || {})) {
      if (ctor.isFillableKey(key)) {
        this.set(key, attributes[key]);
      } else if (totallyGuarded) {
        throw new Error(
          'Add [' + key + '] to fillable property to allow mass assignment on [' +
            (ctor.name || 'the model') + '].'
        );
      }
    }
    return this;
  }

  // Eloquent's forceFill: mass-assign ignoring the fillable guard.
  forceFill(attributes = {}) {
    for (const key of Object.keys(attributes || {})) this.set(key, attributes[key]);
    return this;
  }

  /**
   * `Model::toArray()` (Model.php:2225-2240): the attributes plus the LOADED
   * relations. The edge answers the same shape `toJSON()` encodes (the dates
   * already serialised), because a JS caller has no Carbon to format.
   */
  toArray() {
    return this.toJSON();
  }

  toJSON() {
    const ctor = this.constructor;
    const hidden = ctor.hidden || [];
    const visible = ctor.visible || [];
    const out = {};
    for (const key of Object.keys(this.attributes)) {
      if (hidden.includes(key)) continue;
      if (visible.length && !visible.includes(key)) continue;
      const value = this.get(key);
      // Laravel serialises the date attributes through Carbon::toJSON().
      out[key] = isDateAttribute(ctor, key) ? isoDateString(value) : value;
    }
    for (const key of ctor.appends || []) {
      // Laravel's attributesToArray() runs the appended attributes through
      // mutateAttributeForArray() too - the date serialisation included.
      const value = this.get(key);
      out[key] = isDateAttribute(ctor, key) ? isoDateString(value) : value;
    }
    for (const key of Object.keys(this._relations || {})) {
      const rel = this._relations[key];
      // A relation is serialised as an ARRAY of the related models' arrays.
      // `Collection#toJSON()` answers a JSON STRING (Laravel's toJson()), so it
      // must not be used here - the body would embed "[{...}]" as a string.
      const one = (r) =>
        r instanceof Model ? r.toJSON() : r && typeof r.toArray === 'function' ? r.toArray() : r;
      if (rel instanceof Collection) out[key] = rel.all().map(one);
      else if (Array.isArray(rel)) out[key] = rel.map(one);
      else out[key] = one(rel);
    }
    return out;
  }

  // ---- soft deletes ----
  trashed() {
    const ctor = this.constructor;
    return this.attributes[ctor.deletedAtColumn] != null;
  }

  static _newQuery(db) {
    const builder = tableBuilder(db, this.table);
    builder.model = this;
    // Eager-loading + local-scope support on the returned builder.
    builder.eagerLoads = [];
    builder.countLoads = [];
    builder.aggregateLoads = [];
    const baseGet = builder.get.bind(builder);
    const baseFirst = builder.first.bind(builder);
    builder.with = (...names) => {
      for (const n of names.flat()) builder.eagerLoads.push(n);
      return builder;
    };
    builder.withCount = (...names) => {
      for (const n of names.flat()) builder.countLoads.push(n);
      return builder;
    };
    builder.withSum = (name, column) => addAggregate(builder, this, name, 'sum', column);
    builder.withAvg = (name, column) => addAggregate(builder, this, name, 'avg', column);
    builder.withMin = (name, column) => addAggregate(builder, this, name, 'min', column);
    builder.withMax = (name, column) => addAggregate(builder, this, name, 'max', column);
    builder.whereHas = (name, cb) => addHas(builder, db, this, name, cb, false);
    builder.whereHasCount = (name, operator, count, cb) => addHasCount(builder, db, this, name, operator, count, cb, false);
    builder.whereDoesntHave = (name, cb) => addHas(builder, db, this, name, cb, true);
    builder.doesntHave = (name, cb) => addHas(builder, db, this, name, cb, true);
    // Laravel `has($rel, $operator = '>=', $count = 1, $callback = null)`.
    builder.has = (name, ...rest) => {
      const spec = parseHasArgs(rest);
      if (spec) return addHasCount(builder, db, this, name, spec.operator, spec.count, spec.cb, false);
      return addHas(builder, db, this, name, typeof rest[0] === 'function' ? rest[0] : undefined, false);
    };
    builder.scope = (name, ...args) => {
      const fn = this.prototype['scope' + studly(name)];
      if (typeof fn !== 'function') throw new Error('unknown scope "' + name + '" on ' + this.name);
      fn.call(null, builder, ...args);
      return builder;
    };
    builder.get = async (...args) => {
      const rows = await baseGet(...args);
      await eagerLoad(db, this, rows, builder.eagerLoads);
      await loadCounts(db, this, rows, builder.countLoads);
      await loadAggregates(db, this, rows, builder.aggregateLoads);
      return rows;
    };
    builder.first = async (...args) => {
      const row = await baseFirst(...args);
      if (row) {
        await eagerLoad(db, this, [row], builder.eagerLoads);
        await loadCounts(db, this, [row], builder.countLoads);
        await loadAggregates(db, this, [row], builder.aggregateLoads);
      }
      return row;
    };
    return builder;
  }

  static query(db) {
    const builder = this._newQuery(db);
    if (this.softDeletes) builder.whereNull(this.deletedAtColumn);
    return builder;
  }

  static withTrashed(db) {
    return this._newQuery(db);
  }

  static onlyTrashed(db) {
    return this._newQuery(db).whereNotNull(this.deletedAtColumn);
  }

  static all(db) {
    return this.query(db).get();
  }

  static find(db, id) {
    // Laravel's find() (Eloquent/Builder.php:607-616): an array of ids
    // returns a COLLECTION of the found models (findMany) - the edge bound the
    // array as ONE value (a broken query that matched nothing).
    if (Array.isArray(id)) {
      return this.query(db).whereIn(this.primaryKey, id).get();
    }
    return this.query(db).where(this.primaryKey, id).first();
  }

  static async findOrFail(db, id) {
    if (Array.isArray(id)) {
      const found = await this.find(db, id);
      // Every id must exist (Laravel names the missing ones).
      const ids = (found || []).map((m) => m.get(this.primaryKey));
      const missing = id.filter((i) => !ids.includes(i));
      if (missing.length) throw new Error(this.name + ' not found: ' + missing.join(', '));
      return found;
    }
    const found = await this.find(db, id);
    if (!found) throw new Error(this.name + ' not found: ' + id);
    return found;
  }

  static async firstOrFail(db) {
    const found = await this.query(db).first();
    if (!found) throw new Error(this.name + ' not found');
    return found;
  }

  static async create(db, attributes = {}) {
    const instance = new this();
    instance.fill(attributes);
    await instance.save(db);
    return instance;
  }

  _storeValue(key) {
    const value = this.attributes[key];
    const cast = this.constructor.casts[key];
    if (value != null && cast != null && JSON_CASTS.has(String(cast).toLowerCase())) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    return value;
  }

  // Eloquent's `save()` (`Model.php:1407`): the row is only written when the
  // model is dirty (`Model.php:1425`) and the answer is a bool - `false` only
  // when a `saving` event cancels the write. The compiled rung has no model
  // events, so the only way the write fails is the write itself.
  async save(db) {
    const ctor = this.constructor;
    const now = this.constructor.now();
    // Instance-level `timestamps = false` (Eloquent `$user->timestamps = false`)
    // suppresses updated_at/created_at writes for this save only.
    const useTimestamps = this.timestamps === false ? false : ctor.timestamps;

    if (!this.exists) {
      // ---- performInsert (`Model.php:1607`) ----
      const data = {};
      // Eloquent persists the model's dirty attribute set. The compiled rung
      // keeps its fillable-when-declared baseline for unmodified models and
      // additionally persists every attribute touched through set()/forceFill()
      // (e.g. remember_token written by the auth guard, which is not fillable).
      const columns = ctor.fillable.length
        ? [...ctor.fillable]
        : Array.isArray(ctor.guarded) && ctor.guarded.length === 1 && ctor.guarded[0] === '*'
          ? Object.keys(this.attributes)
          : Object.keys(this.attributes);
      for (const key of this._dirty) {
        if (!columns.includes(key)) columns.push(key);
      }
      for (const key of columns) {
        if (Object.prototype.hasOwnProperty.call(this.attributes, key)) data[key] = this._storeValue(key);
      }
      if (useTimestamps) {
        data.created_at = data.created_at ?? now;
        data.updated_at = now;
        this.attributes.created_at = data.created_at;
        this.attributes.updated_at = data.updated_at;
      }
      const { lastInsertRowid } = await ctor.withTrashed(db).insert(data);
      if (lastInsertRowid != null) this.attributes[ctor.primaryKey] = lastInsertRowid;
      this.exists = true;
      // Laravel sets the flag in the insert paths (performInsert /
      // insertAndSetId, Model.php:1649/1700), so `new Post; $post->save();` is
      // a 201 too.
      this.wasRecentlyCreated = true;
      this._dirty.clear();
      // Eloquent's `finishSave()` syncs the original after a successful write
      // (`Model.php:1512`), so the model is clean again.
      this.syncOriginal();
      return true;
    }

    // ---- performUpdate (`Model.php:1521`) ----
    // An unchanged model is not written at all: Eloquent asks `isDirty()`
    // before it touches the row (`Model.php:1425`), and `updateTimestamps()`
    // lives INSIDE `performUpdate()` (`Model.php:1534`) - so `updated_at` is
    // not bumped either.
    if (!this.isDirty()) return true;

    // `updateTimestamps()` (`Concerns/HasTimestamps.php:87`) bumps `updated_at`
    // first (unless the attribute was set by hand), so the timestamp is part
    // of the dirty set the UPDATE writes.
    if (useTimestamps && !this.isDirty('updated_at')) this.attributes.updated_at = now;

    // Eloquent writes the dirty attributes only (`getDirtyForUpdate()`,
    // `HasAttributes.php:2359`).
    const data = {};
    for (const key of this.getDirty()) {
      data[key] = this._storeValue(key);
    }

    const pk = ctor.primaryKey;
    const id = this.attributes[pk];
    const { changes } = await ctor.withTrashed(db).where(pk, id).update(data);
    if (changes === 0) throw new Error('model update affected 0 rows');
    this._dirty.clear();
    this.syncOriginal();
    return true;
  }

  async delete(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    const pk = ctor.primaryKey;
    if (ctor.softDeletes) {
      const now = this.constructor.now();
      // Laravel's runSoftDelete() (SoftDeletes.php:141-152) writes the
      // deleted_at column AND updated_at (when the model has timestamps).
      const data = { [ctor.deletedAtColumn]: now };
      if (ctor.timestamps && this.timestamps !== false) {
        data.updated_at = now;
        this.attributes.updated_at = now;
      }
      const res = await ctor.withTrashed(db).where(pk, this.attributes[pk]).update(data);
      this.attributes[ctor.deletedAtColumn] = now;
      // Eloquent's `runSoftDelete()` syncs the original after the write
      // (`SoftDeletes.php:155`), so the model is clean again.
      this.syncOriginal();
      return res;
    }
    const res = await ctor.withTrashed(db).where(pk, this.attributes[pk]).delete();
    this.exists = false;
    return res;
  }

  async forceDelete(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    const res = await ctor.withTrashed(db).where(ctor.primaryKey, this.attributes[ctor.primaryKey]).delete();
    this.exists = false;
    return res;
  }

  async restore(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    if (!ctor.softDeletes) return { changes: 0 };
    // Laravel's restore() (SoftDeletes.php:159-167) writes through save(), so
    // the timestamp is bumped too.
    const data = { [ctor.deletedAtColumn]: null };
    if (ctor.timestamps && this.timestamps !== false) {
      data.updated_at = this.constructor.now();
      this.attributes.updated_at = data.updated_at;
    }
    const res = await ctor.withTrashed(db).where(ctor.primaryKey, this.attributes[ctor.primaryKey]).update(data);
    this.attributes[ctor.deletedAtColumn] = null;
    // Eloquent's `restore()` writes through `save()` (`SoftDeletes.php:165`),
    // so the original is synced and the model is clean again.
    this.syncOriginal();
    return res;
  }

  // ---- declared relations: eager (`with`) + lazy (`related`) ----
  setRelation(name, value) {
    this._relations = this._relations || {};
    this._relations[name] = value;
    return this;
  }

  getRelation(name) {
    return this._relations ? this._relations[name] : undefined;
  }

  relationLoaded(name) {
    return !!(this._relations && Object.prototype.hasOwnProperty.call(this._relations, name));
  }

  async related(db, name) {
    const rel = (this.constructor.relations || {})[name];
    if (!rel) throw new Error('unknown relation "' + name + '" on ' + this.constructor.name);
    // Eloquent's getRelationValue() (HasAttributes.php:425-435): a relation
    // that is ALREADY loaded answers from the cache - no query.
    if (this.relationLoaded(name)) return this.getRelation(name);
    await loadRelation(db, this.constructor, [this], name, rel);
    return this.getRelation(name);
  }

  async load(db, ...names) {
    await eagerLoad(db, this.constructor, [this], names.flat());
    return this;
  }

  async loadCount(db, ...names) {
    await loadCounts(db, this.constructor, [this], names.flat());
    return this;
  }

  // `loadAggregate(db, ['comments', 'sum', 'votes'])` or `loadAggregate(db, {name, fn, column})`.
  async loadAggregate(db, ...specs) {
    const args =
      specs.length === 1 && Array.isArray(specs[0]) && typeof specs[0][0] === 'string' ? [specs[0]] : specs;
    const list = args.map((s) => {
      const [name, fn, column] = Array.isArray(s) ? s : [s.name, s.fn, s.column];
      return { name, fn, column: String(column), alias: name + '_' + fn + '_' + column };
    });
    for (const spec of list) {
      if (!AGG_FN[spec.fn]) throw new Error('unknown aggregate: ' + spec.fn);
    }
    await loadAggregates(db, this.constructor, [this], list);
    return this;
  }

  // ---- relations (explicit `db`, like the rest of the kernel) ----
  hasMany(db, Related, foreignKey, localKey) {
    const lk = localKey || this.constructor.primaryKey;
    return Related.query(db).where(foreignKey, this.attributes[lk]).get();
  }

  hasOne(db, Related, foreignKey, localKey) {
    const lk = localKey || this.constructor.primaryKey;
    return Related.query(db).where(foreignKey, this.attributes[lk]).first();
  }

  belongsTo(db, Related, foreignKey, ownerKey) {
    const ok = ownerKey || Related.primaryKey;
    const fk = foreignKey || defaultForeignKey(Related);
    return Related.query(db).where(ok, this.attributes[fk]).first();
  }

  async refresh(db) {
    const pk = this.constructor.primaryKey;
    const fresh = await this.constructor.withTrashed(db).where(pk, this.attributes[pk]).first();
    if (fresh) {
      this.attributes = { ...fresh.attributes };
      this.exists = true;
      // Eloquent's `refresh()` re-reads the row and syncs the original
      // (`Model.php:2196`), so the model is clean again.
      this.syncOriginal();
    }
    return this;
  }

  async increment(db, column, amount = 1) {
    const ctor = this.constructor;
    // Laravel's incrementOrDecrement() (Model.php:1134-1163): the in-memory
    // attribute is bumped and ONE atomic statement writes it
    // (`set counter = counter + N`) - the row's other columns, and
    // updated_at, are NOT touched (the old save() rewrote the whole row and
    // bumped the timestamp). The answer is the affected-row count, not the
    // new value.
    const next = (Number(this.attributes[column]) || 0) + amount;
    this.attributes[column] = next;
    let res;
    if (!this.exists) {
      // Laravel: a model that does not exist increments the whole table
      // (`newQueryWithoutRelationships()->increment(...)`).
      res = await ctor.query(db).increment(column, amount);
    } else {
      const pk = ctor.primaryKey;
      res = await ctor.withTrashed(db).where(pk, this.attributes[pk]).increment(column, amount);
    }
    this.syncOriginalAttributes([column]);
    return res && typeof res.changes === 'number' ? res.changes : 0;
  }

  static async firstOrCreate(db, where = {}, extra = {}) {
    const found = await applyWhere(this.query(db), where).first();
    if (found) return found;
    return this.create(db, { ...where, ...extra });
  }

  static async updateOrCreate(db, where = {}, values = {}) {
    const found = await applyWhere(this.query(db), where).first();
    if (found) {
      found.fill(values);
      await found.save(db);
      return found;
    }
    return this.create(db, { ...where, ...values });
  }
}

function defaultForeignKey(Related) {
  const short = Related.name.replace(/Model$/, '');
  return short.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() + '_id';
}

function applyWhere(builder, where) {
  for (const key of Object.keys(where || {})) builder.where(key, where[key]);
  return builder;
}

// Eager-load declared relations for a batch of already-fetched rows.
async function eagerLoad(db, ModelClass, rows, names) {
  if (!rows || !rows.length || !names || !names.length) return;
  const declared = ModelClass.relations || {};
  await Promise.all(names.map((name) => {
    const rel = declared[name];
    if (!rel) throw new Error('unknown relation "' + name + '" on ' + ModelClass.name);
    return loadRelation(db, ModelClass, rows, name, rel);
  }));
}

async function loadRelation(db, ModelClass, rows, name, rel) {
  const Related = rel.model;
  const type = rel.type || 'hasMany';
  const idsOf = (get) => [...new Set(rows.map(get).filter((v) => v != null))];

  if (type === 'belongsTo') {
    const ownerKey = rel.ownerKey || Related.primaryKey;
    const fk = rel.foreignKey || defaultForeignKey(Related);
    const ids = idsOf((r) => r.get(fk));
    if (!ids.length) {
      for (const r of rows) r.setRelation(name, null);
      return;
    }
    const owners = await Related.query(db).whereIn(ownerKey, ids).get();
    const byKey = new Map(owners.map((o) => [String(o.get(ownerKey)), o]));
    for (const r of rows) r.setRelation(name, byKey.get(String(r.get(fk))) || null);
    return;
  }

  const lk = rel.localKey || ModelClass.primaryKey;
  const fk = rel.foreignKey || defaultForeignKey(ModelClass);
  const ids = idsOf((r) => r.get(lk));
  if (!ids.length) {
    for (const r of rows) r.setRelation(name, type === 'hasOne' ? null : new Collection([]));
    return;
  }
  const children = await Related.query(db).whereIn(fk, ids).get();
  const grouped = new Map();
  for (const c of children) {
    const key = String(c.get(fk));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(c);
  }
  for (const r of rows) {
    const list = grouped.get(String(r.get(lk))) || [];
    // Eloquent's HasMany::getResults() answers a COLLECTION
    // (HasMany.php:433-440), not a plain array: `$post->comments->count()`,
    // `->pluck()`, `->isEmpty()` are the app's normal calls.
    r.setRelation(name, type === 'hasOne' ? list[0] || null : new Collection(list));
  }
}

// `comments_count` style counters (Laravel's `withCount()`).
async function loadCounts(db, ModelClass, rows, names) {
  if (!rows || !rows.length || !names || !names.length) return;
  for (const name of names) {
    const rel = (ModelClass.relations || {})[name];
    if (!rel) throw new Error('unknown relation "' + name + '" on ' + ModelClass.name);
    await loadRelation(db, ModelClass, rows, name, rel);
    for (const r of rows) {
      const value = r.getRelation(name);
      // A hasMany answers a Collection now (Eloquent's HasMany::getResults()),
      // a belongsTo a model or null: count the Collection, never treat it as
      // one row.
      const count =
        value == null
          ? 0
          : Array.isArray(value)
            ? value.length
            : typeof value.count === 'function'
              ? value.count()
              : 1;
      if (r._relations) delete r._relations[name];
      r.attributes[name + '_count'] = count;
      r.setRelation(name + '_count', count);
      // Eloquent reads the count as a column of the row, so it is part of the
      // original (`Collection.php:141` syncs the aggregate attributes) - the
      // model stays clean.
      r.syncOriginalAttributes([name + '_count']);
    }
  }
}

const qident = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// Extract the WHERE body of a generated SELECT so it can be inlined into a
// correlated EXISTS subquery.
function whereClauseOf(sql) {
  const i = sql.indexOf(' WHERE ');
  if (i === -1) return '';
  let rest = sql.slice(i + 7);
  for (const kw of [' GROUP BY ', ' ORDER BY ', ' LIMIT ', ' OFFSET ']) {
    const j = rest.indexOf(kw);
    if (j !== -1) rest = rest.slice(0, j);
  }
  return rest;
}

// `whereHas` / `whereDoesntHave` / `has` / `doesntHave` -> correlated EXISTS.
function addHas(builder, db, ModelClass, name, cb, negated) {
  const rel = (ModelClass.relations || {})[name];
  if (!rel) throw new Error('unknown relation "' + name + '" on ' + ModelClass.name);
  const Related = rel.model;
  const exists = (from, clause, params) =>
    builder.whereRaw(
      (negated ? 'NOT ' : '') + 'EXISTS (SELECT 1 FROM ' + qident(from) + ' WHERE ' + clause + ')',
      params
    );

  if (rel.type === 'belongsTo') {
    const ownerKey = rel.ownerKey || Related.primaryKey;
    const fk = rel.foreignKey || defaultForeignKey(Related);
    const link = qident(Related.table) + '.' + qident(ownerKey) + ' = ' + qident(ModelClass.table) + '.' + qident(fk);
    if (typeof cb === 'function') {
      const child = Related.query(db);
      cb(child);
      const sub = child.toSql();
      const extra = whereClauseOf(sub.sql);
      return exists(Related.table, link + (extra ? ' AND ' + extra : ''), sub.params);
    }
    return exists(Related.table, link, []);
  }

  const lk = rel.localKey || ModelClass.primaryKey;
  const fk = rel.foreignKey || defaultForeignKey(ModelClass);
  const link = qident(Related.table) + '.' + qident(fk) + ' = ' + qident(ModelClass.table) + '.' + qident(lk);
  if (typeof cb === 'function') {
    const child = Related.query(db);
    cb(child);
    const sub = child.toSql();
    const extra = whereClauseOf(sub.sql);
    return exists(Related.table, link + (extra ? ' AND ' + extra : ''), sub.params);
  }
  return exists(Related.table, link, []);
}

// Shared relation metadata for correlated subqueries (`has()` counts, aggregates).
function relationSpec(ModelClass, name) {
  const rel = (ModelClass.relations || {})[name];
  if (!rel) throw new Error('unknown relation "' + name + '" on ' + ModelClass.name);
  const Related = rel.model;
  if (rel.type === 'belongsTo') {
    const ownerKey = rel.ownerKey || Related.primaryKey;
    const fk = rel.foreignKey || defaultForeignKey(Related);
    return {
      rel,
      Related,
      parentRef: fk,
      relatedRef: ownerKey,
      single: true,
      link: qident(Related.table) + '.' + qident(ownerKey) + ' = ' + qident(ModelClass.table) + '.' + qident(fk),
    };
  }
  if (rel.type !== 'hasMany' && rel.type !== 'hasOne') {
    throw new Error('unsupported relation type "' + rel.type + '" for ' + name);
  }
  const lk = rel.localKey || ModelClass.primaryKey;
  const fk = rel.foreignKey || defaultForeignKey(ModelClass);
  return {
    rel,
    Related,
    parentRef: lk,
    relatedRef: fk,
    single: rel.type === 'hasOne',
    link: qident(Related.table) + '.' + qident(fk) + ' = ' + qident(ModelClass.table) + '.' + qident(lk),
  };
}

// Constraints from a relation callback, inlined into the correlated subquery.
function childConstraints(db, Related, cb) {
  if (typeof cb !== 'function') return { extra: '', params: [] };
  const child = Related.query(db);
  cb(child);
  const sub = child.toSql();
  return { extra: whereClauseOf(sub.sql), params: sub.params };
}

const HAS_OPS = new Set(['=', '!=', '<>', '>', '>=', '<', '<=']);

// Laravel `has($rel, $operator, $count, $callback)` argument forms.
function parseHasArgs(rest) {
  const args = rest.flat();
  if (!args.length || typeof args[0] === 'function') return null;
  const hasOperator = args.length >= 2;
  const operator = hasOperator ? String(args[0]) : '>=';
  const count = hasOperator ? args[1] : args[0];
  if (!HAS_OPS.has(operator)) throw new Error('unsupported has() operator: ' + operator);
  const cb = args.find((a) => typeof a === 'function');
  return { operator, count: Number(count), cb };
}

// `has($rel, '>=', 2)` -> `(SELECT COUNT(*) FROM related WHERE fk = pk) >= 2`.
function addHasCount(builder, db, ModelClass, name, operator, count, cb, negated) {
  if (!HAS_OPS.has(String(operator))) throw new Error('unsupported has() operator: ' + operator);
  const spec = relationSpec(ModelClass, name);
  const { extra, params } = childConstraints(db, spec.Related, cb);
  const sql =
    (negated ? 'NOT ' : '') +
    '(SELECT COUNT(*) FROM ' + qident(spec.Related.table) + ' WHERE ' + spec.link + (extra ? ' AND ' + extra : '') + ') ' +
    String(operator) +
    ' ?';
  return builder.whereRaw(sql, [...params, Number(count)]);
}

const AGG_FN = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' };

// `withSum('comments', 'votes')` -> `comments_sum_votes` attribute (Laravel naming).
function addAggregate(builder, ModelClass, name, fn, column) {
  if (!AGG_FN[fn]) throw new Error('unknown aggregate: ' + fn);
  if (column == null) throw new Error('with' + fn[0].toUpperCase() + fn.slice(1) + '() needs a column');
  relationSpec(ModelClass, name);
  builder.aggregateLoads.push({
    name,
    fn,
    column: String(column),
    alias: name + '_' + fn + '_' + column,
  });
  return builder;
}

// Compute aggregate attributes with one query per relation (no N+1 per row).
async function loadAggregates(db, ModelClass, rows, specs) {
  if (!rows || !rows.length || !specs || !specs.length) return;
  for (const spec of specs) {
    const { Related, parentRef, relatedRef } = relationSpec(ModelClass, spec.name);
    const keys = [...new Set(rows.map((r) => r.get(parentRef)).filter((v) => v != null).map(String))];
    const buckets = new Map();
    if (keys.length) {
      const related = await Related.query(db).whereIn(relatedRef, keys).get();
      for (const row of related) {
        const key = String(row.get(relatedRef));
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row.get(spec.column));
      }
    }
    for (const r of rows) {
      const list = buckets.get(String(r.get(parentRef))) || [];
      const nums = list.map((v) => Number(v)).filter((v) => !Number.isNaN(v));
      let value = null;
      if (list.length) {
        const total = nums.reduce((a, b) => a + b, 0);
        if (spec.fn === 'sum') value = total;
        else if (spec.fn === 'avg') value = total / nums.length;
        else if (spec.fn === 'min') value = Math.min(...nums);
        else value = Math.max(...nums);
      }
      r.attributes[spec.alias] = value;
      // Eloquent reads the aggregate as a column of the row, so it is part of
      // the original (`Collection.php:141` syncs the aggregate attributes) -
      // the model stays clean.
      r.syncOriginalAttributes([spec.alias]);
    }
  }
}

export default { Model, applyCast };
