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

  constructor(attributes = {}) {
    this.attributes = { ...attributes };
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

export default { Model, applyCast };
