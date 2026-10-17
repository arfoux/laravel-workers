// kernel/db.mjs — D1 query builder
// SQL is generated with bound parameters; identifiers are quoted.

const ALLOWED_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT']);

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export class QueryBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = String(table);
    this.columns = ['*'];
    this.wheres = [];
    this.order = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.model = null;
  }

  select(...columns) {
    this.columns = columns.length ? columns.map((c) => String(c)) : ['*'];
    return this;
  }

  where(column, operatorOrValue, value) {
    let operator = '=';
    let val = operatorOrValue;
    if (value !== undefined) {
      operator = String(operatorOrValue).toUpperCase();
      val = value;
      if (!ALLOWED_OPS.has(operator)) throw new Error('unsupported where operator: ' + operator);
    }
    this.wheres.push({ type: 'basic', column: String(column), operator, value: val });
    return this;
  }

  whereIn(column, values) {
    if (!Array.isArray(values)) throw new Error('whereIn expects an array');
    this.wheres.push({ type: 'in', column: String(column), values: [...values] });
    return this;
  }

  whereNull(column) {
    this.wheres.push({ type: 'null', column: String(column) });
    return this;
  }

  whereNotNull(column) {
    this.wheres.push({ type: 'notNull', column: String(column) });
    return this;
  }

  orderBy(column, direction = 'asc') {
    const dir = String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    this.order.push({ column: String(column), direction: dir });
    return this;
  }

  limit(n) {
    this.limitValue = Number(n);
    return this;
  }

  offset(n) {
    this.offsetValue = Number(n);
    return this;
  }

  asModel(model) {
    this.model = model;
    return this;
  }

  clone() {
    const c = new QueryBuilder(this.db, this.table);
    c.columns = [...this.columns];
    c.wheres = this.wheres.map((w) => ({ ...w, values: w.values ? [...w.values] : w.values }));
    c.order = this.order.map((o) => ({ ...o }));
    c.limitValue = this.limitValue;
    c.offsetValue = this.offsetValue;
    c.model = this.model;
    return c;
  }

  _whereSql(params) {
    if (!this.wheres.length) return '';
    const parts = this.wheres.map((w) => {
      if (w.type === 'basic') {
        params.push(w.value);
        return `${quoteIdent(w.column)} ${w.operator} ?`;
      }
      if (w.type === 'in') {
        if (!w.values.length) return '1 = 0';
        for (const v of w.values) params.push(v);
        return `${quoteIdent(w.column)} IN (${w.values.map(() => '?').join(', ')})`;
      }
      if (w.type === 'null') return `${quoteIdent(w.column)} IS NULL`;
      if (w.type === 'notNull') return `${quoteIdent(w.column)} IS NOT NULL`;
      throw new Error('unknown where type: ' + w.type);
    });
    return ' WHERE ' + parts.join(' AND ');
  }

  toSql() {
    const params = [];
    const cols = this.columns.map((c) => (c === '*' ? '*' : quoteIdent(c))).join(', ');
    let sql = `SELECT ${cols} FROM ${quoteIdent(this.table)}`;
    sql += this._whereSql(params);
    if (this.order.length) {
      sql += ' ORDER BY ' + this.order.map((o) => `${quoteIdent(o.column)} ${o.direction}`).join(', ');
    }
    if (this.limitValue != null) sql += ' LIMIT ?';
    if (this.offsetValue != null) sql += ' OFFSET ?';
    if (this.limitValue != null) params.push(this.limitValue);
    if (this.offsetValue != null) params.push(this.offsetValue);
    return { sql, params };
  }

  _prepare(sql, params) {
    const stmt = this.db.prepare(sql);
    return params.length ? stmt.bind(...params) : stmt;
  }

  async get() {
    const { sql, params } = this.toSql();
    const stmt = this._prepare(sql, params);
    const res = await stmt.all();
    const rows = (res && Array.isArray(res.results)) ? res.results : [];
    if (this.model) return rows.map((row) => new this.model(row));
    return rows;
  }

  async first() {
    const rows = await this.clone().limit(1).get();
    return rows.length ? rows[0] : null;
  }

  async count(column = '*') {
    const params = [];
    let sql = `SELECT COUNT(${column === '*' ? '*' : quoteIdent(column)}) AS "aggregate" FROM ${quoteIdent(this.table)}`;
    sql += this._whereSql(params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.first();
    const row = res || {};
    return Number(row.aggregate ?? row['COUNT(*)'] ?? 0);
  }

  async insert(data) {
    if (!isPlainObject(data) || !Object.keys(data).length) throw new Error('insert expects a non-empty object');
    const columns = Object.keys(data);
    const sql = `INSERT INTO ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const stmt = this._prepare(sql, Object.values(data));
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, lastInsertRowid: res?.meta?.last_row_id ?? null, meta: res?.meta ?? {} };
  }

  async update(data) {
    if (!isPlainObject(data) || !Object.keys(data).length) throw new Error('update expects a non-empty object');
    const columns = Object.keys(data);
    const params = Object.values(data);
    let sql = `UPDATE ${quoteIdent(this.table)} SET ${columns.map((c) => `${quoteIdent(c)} = ?`).join(', ')}`;
    sql += this._whereSql(params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async delete() {
    const params = [];
    let sql = `DELETE FROM ${quoteIdent(this.table)}`;
    sql += this._whereSql(params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async paginate(perPage = 15, page = 1) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(perPage) || 15);
    const total = await this.count();
    const data = await this.clone().limit(size).offset((p - 1) * size).get();
    return {
      data,
      total,
      per_page: size,
      current_page: p,
      last_page: Math.max(1, Math.ceil(total / size)),
    };
  }
}

export function table(db, name) {
  return new QueryBuilder(db, name);
}

export const DB = { table };
export default { QueryBuilder, table, DB };
