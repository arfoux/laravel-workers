// kernel/model.mjs — Model base
import { table as tableBuilder } from './db.mjs';

function applyCast(value, cast) {
  if (value == null) return value;
  switch (String(cast).toLowerCase()) {
    case 'int':
    case 'integer':
      return Number(value);
    case 'float':
    case 'double':
    case 'real':
      return Number(value);
    case 'bool':
    case 'boolean':
      return value === true || value === 1 || value === '1' || value === 'true';
    case 'string':
      return String(value);
    case 'json':
      return typeof value === 'string' ? JSON.parse(value) : value;
    default:
      return value;
  }
}

export class Model {
  static table = null;
  static primaryKey = 'id';
  static fillable = [];
  static casts = {};
  static timestamps = true;

  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this.exists = this.attributes[this.constructor.primaryKey] != null;
  }

  get(key) {
    const cast = this.constructor.casts[key];
    return cast ? applyCast(this.attributes[key], cast) : this.attributes[key];
  }

  set(key, value) {
    this.attributes[key] = value;
    return this;
  }

  fill(attributes = {}) {
    const fillable = this.constructor.fillable;
    for (const key of Object.keys(attributes || {})) {
      if (!fillable.length || fillable.includes(key)) this.attributes[key] = attributes[key];
    }
    return this;
  }

  toJSON() {
    const out = { ...this.attributes };
    for (const key of Object.keys(this.constructor.casts)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = this.get(key);
    }
    return out;
  }

  static query(db) {
    const builder = tableBuilder(db, this.table);
    builder.model = this;
    return builder;
  }

  static all(db) {
    return this.query(db).get();
  }

  static find(db, id) {
    return this.query(db).where(this.primaryKey, id).first();
  }

  static async create(db, attributes = {}) {
    const instance = new this(attributes);
    await instance.save(db);
    return instance;
  }

  async save(db) {
    const ctor = this.constructor;
    const now = new Date().toISOString();
    const data = {};
    const fillable = ctor.fillable.length ? ctor.fillable : Object.keys(this.attributes);
    for (const key of fillable) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, key)) data[key] = this.attributes[key];
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
      const { changes } = await ctor.query(db).where(pk, id).update(data);
      if (changes === 0) throw new Error('model update affected 0 rows');
    } else {
      const { lastInsertRowid } = await ctor.query(db).insert(data);
      if (lastInsertRowid != null) this.attributes[ctor.primaryKey] = lastInsertRowid;
      this.exists = true;
    }
    return this;
  }

  async delete(db) {
    if (!this.exists) return { changes: 0 };
    const ctor = this.constructor;
    const pk = ctor.primaryKey;
    const res = await ctor.query(db).where(pk, this.attributes[pk]).delete();
    this.exists = false;
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
    const fresh = await this.constructor.query(db).where(pk, this.attributes[pk]).first();
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
