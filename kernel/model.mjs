// kernel/model.mjs — Model base
import { table as tableBuilder } from './db.mjs';
import { isHashedDigest, makeSync, verifyConfiguration } from './hash.mjs';

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

function applyCast(value, cast) {
  if (value == null) return value;
  const spec = String(cast).toLowerCase();
  if (JSON_CASTS.has(spec)) return typeof value === 'string' ? JSON.parse(value) : value;
  if (spec.startsWith('decimal:')) {
    const places = Number(spec.slice('decimal:'.length)) || 0;
    return Number(value).toFixed(places);
  }
  if (spec === 'int' || spec === 'integer' || spec === 'timestamp') return Number(value);
  if (spec === 'float' || spec === 'double' || spec === 'real') return Number(value);
  if (spec === 'bool' || spec === 'boolean') return value === true || value === 1 || value === '1' || value === 'true';
  if (spec === 'string') return String(value);
  // date/datetime/immutable_* and unknown casts pass through (strings in D1).
  return value;
}

// Laravel's `freshTimestampString()` - the app date format (`Y-m-d H:i:s`)
// in the app timezone (UTC on the compiled rung).
export function phpDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
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
  static table = null;
  static primaryKey = 'id';
  static fillable = [];
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
  static clock = null;
  static now = () => phpDateString(this.clock ? new Date(this.clock() * 1000) : new Date());
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
    this._dirty = new Set();
    this.exists = this.attributes[this.constructor.primaryKey] != null;
  }

  get(key) {
    if (this.constructor.notCompiled && this.constructor.notCompiled.includes(key)) {
      throw new Error(
        'the model attribute "' + key + '" is not compiled (a relation or an accessor) - ' +
          'write a port handler for this route'
      );
    }
    let value = this.attributes[key];
    const cast = this.constructor.casts[key];
    if (cast != null) value = applyCast(value, cast);
    const accessor = 'get' + studly(key) + 'Attribute';
    if (typeof this[accessor] === 'function') value = this[accessor](value);
    return value;
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

  fill(attributes = {}) {
    const fillable = this.constructor.fillable;
    for (const key of Object.keys(attributes || {})) {
      if (!fillable.length || fillable.includes(key)) this.set(key, attributes[key]);
    }
    return this;
  }

  // Eloquent's forceFill: mass-assign ignoring the fillable guard.
  forceFill(attributes = {}) {
    for (const key of Object.keys(attributes || {})) this.set(key, attributes[key]);
    return this;
  }

  toJSON() {
    const ctor = this.constructor;
    const hidden = ctor.hidden || [];
    const visible = ctor.visible || [];
    const out = {};
    for (const key of Object.keys(this.attributes)) {
      if (hidden.includes(key)) continue;
      if (visible.length && !visible.includes(key)) continue;
      out[key] = this.get(key);
    }
    for (const key of ctor.appends || []) out[key] = this.get(key);
    for (const key of Object.keys(this._relations || {})) {
      const rel = this._relations[key];
      if (Array.isArray(rel)) out[key] = rel.map((r) => (r && r.toJSON ? r.toJSON() : r));
      else out[key] = rel && rel.toJSON ? rel.toJSON() : rel;
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
    return this.query(db).where(this.primaryKey, id).first();
  }

  static async findOrFail(db, id) {
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

  async save(db) {
    const ctor = this.constructor;
    const now = this.constructor.now();
    const data = {};
    // Eloquent persists the model's dirty attribute set. The compiled rung
    // keeps its fillable-when-declared baseline for unmodified models and
    // additionally persists every attribute touched through set()/forceFill()
    // (e.g. remember_token written by the auth guard, which is not fillable).
    const columns = ctor.fillable.length ? [...ctor.fillable] : Object.keys(this.attributes);
    for (const key of this._dirty) {
      if (!columns.includes(key)) columns.push(key);
    }
    for (const key of columns) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, key)) data[key] = this._storeValue(key);
    }
    // Instance-level `timestamps = false` (Eloquent `$user->timestamps = false`)
    // suppresses updated_at/created_at writes for this save only.
    const useTimestamps = this.timestamps === false ? false : ctor.timestamps;
    if (useTimestamps) {
      if (!this.exists) data.created_at = data.created_at ?? now;
      data.updated_at = now;
      this.attributes.created_at = data.created_at ?? this.attributes.created_at;
      this.attributes.updated_at = data.updated_at;
    }

    if (this.exists) {
      const pk = ctor.primaryKey;
      const id = this.attributes[pk];
      const { changes } = await ctor.withTrashed(db).where(pk, id).update(data);
      if (changes === 0) throw new Error('model update affected 0 rows');
    } else {
      const { lastInsertRowid } = await ctor.withTrashed(db).insert(data);
      if (lastInsertRowid != null) this.attributes[ctor.primaryKey] = lastInsertRowid;
      this.exists = true;
    }
    this._dirty.clear();
    return this;
  }

  async delete(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    const pk = ctor.primaryKey;
    if (ctor.softDeletes) {
      const now = this.constructor.now();
      const res = await ctor.withTrashed(db).where(pk, this.attributes[pk]).update({ [ctor.deletedAtColumn]: now });
      this.attributes[ctor.deletedAtColumn] = now;
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
    const res = await ctor.withTrashed(db).where(ctor.primaryKey, this.attributes[ctor.primaryKey]).update({ [ctor.deletedAtColumn]: null });
    this.attributes[ctor.deletedAtColumn] = null;
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
    }
    return this;
  }

  async increment(db, column, amount = 1) {
    const next = (Number(this.attributes[column]) || 0) + amount;
    this.attributes[column] = next;
    await this.save(db);
    return next;
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
    for (const r of rows) r.setRelation(name, type === 'hasOne' ? null : []);
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
    r.setRelation(name, type === 'hasOne' ? (list[0] || null) : list);
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
      const count = Array.isArray(value) ? value.length : (value == null ? 0 : 1);
      if (r._relations) delete r._relations[name];
      r.attributes[name + '_count'] = count;
      r.setRelation(name + '_count', count);
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
    }
  }
}

export default { Model, applyCast };
