// kernel/model.mjs — Model base
import { table as tableBuilder } from './db.mjs';

const JSON_CASTS = new Set(['json', 'array', 'object', 'collection']);

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
  static hidden = [];
  static visible = [];
  static appends = [];
  static timestamps = true;
  static softDeletes = false;
  static deletedAtColumn = 'deleted_at';
  // Declared relations, used by `with()` / `related()` (Laravel's `$with`):
  //   static relations = { comments: { type: 'hasMany', model: Comment } };
  static relations = {};

  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this._relations = {};
    this.exists = this.attributes[this.constructor.primaryKey] != null;
  }

  get(key) {
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
      if (cast != null && JSON_CASTS.has(String(cast).toLowerCase())) {
        next = value == null ? null : JSON.stringify(value);
      }
    }
    this.attributes[key] = next;
    return this;
  }

  fill(attributes = {}) {
    const fillable = this.constructor.fillable;
    for (const key of Object.keys(attributes || {})) {
      if (!fillable.length || fillable.includes(key)) this.set(key, attributes[key]);
    }
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
    builder.whereHas = (name, cb) => addHas(builder, db, this, name, cb, false);
    builder.has = (name, cb) => addHas(builder, db, this, name, cb, false);
    builder.whereDoesntHave = (name, cb) => addHas(builder, db, this, name, cb, true);
    builder.doesntHave = (name, cb) => addHas(builder, db, this, name, cb, true);
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
      return rows;
    };
    builder.first = async (...args) => {
      const row = await baseFirst(...args);
      if (row) {
        await eagerLoad(db, this, [row], builder.eagerLoads);
        await loadCounts(db, this, [row], builder.countLoads);
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
    const instance = new this(attributes);
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
    const now = new Date().toISOString();
    const data = {};
    const fillable = ctor.fillable.length ? ctor.fillable : Object.keys(this.attributes);
    for (const key of fillable) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, key)) data[key] = this._storeValue(key);
    }
    if (ctor.timestamps) {
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
    return this;
  }

  async delete(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    const pk = ctor.primaryKey;
    if (ctor.softDeletes) {
      const now = new Date().toISOString();
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

export default { Model, applyCast };
