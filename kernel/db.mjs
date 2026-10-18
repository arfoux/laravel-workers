// kernel/db.mjs — D1 query builder
// SQL is generated with bound parameters; identifiers are quoted.
// Raw fragments (selectRaw/whereRaw/havingRaw) accept explicit bindings — the
// caller owns their safety (documented trust boundary).

const ALLOWED_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT']);
const ALLOWED_JOIN_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=']);

function quoteIdent(name) {
  // Supports `table.column` dot notation → `"table"."column"`.
  return String(name)
    .split('.')
    .map((part) => '"' + part.replace(/"/g, '""') + '"')
    .join('.');
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Normalize the (column, operatorOrValue, value) trio used by where-like APIs.
function normalizeOp(operatorOrValue, value) {
  let operator = '=';
  let val = operatorOrValue;
  if (value !== undefined) {
    operator = String(operatorOrValue).toUpperCase();
    val = value;
    if (!ALLOWED_OPS.has(operator)) throw new Error('unsupported operator: ' + operator);
  }
  return { operator, val };
}

export class QueryBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = String(table);
    this.columns = ['*'];
    this.wheres = [];
    this.joins = [];
    this.groups = [];
    this.havings = [];
    this.order = [];
    this.distinctValue = false;
    this.limitValue = null;
    this.offsetValue = null;
    this.model = null;
  }

  select(...columns) {
    this.columns = columns.length ? columns.map((c) => String(c)) : ['*'];
    this._hasSelect = true;
    return this;
  }

  selectRaw(sql, params = []) {
    if (!this._hasSelect && this.columns.length === 1 && this.columns[0] === '*') this.columns = [];
    this.columns.push({ raw: String(sql), params: [...params] });
    this._hasSelect = true;
    return this;
  }

  distinct() {
    this.distinctValue = true;
    return this;
  }

  where(column, operatorOrValue, value) {
    // where(fn) → nested group, mirroring Laravel's closure grouping.
    if (typeof column === 'function') return this.whereGroup(column, 'and');
    return this._whereBasic('and', column, operatorOrValue, value);
  }
  orWhere(column, operatorOrValue, value) {
    if (typeof column === 'function') return this.whereGroup(column, 'or');
    return this._whereBasic('or', column, operatorOrValue, value);
  }
  _whereBasic(boolean, column, operatorOrValue, value) {
    let operator = '=';
    let val = operatorOrValue;
    if (value !== undefined) {
      operator = String(operatorOrValue).toUpperCase();
      val = value;
      if (!ALLOWED_OPS.has(operator)) throw new Error('unsupported where operator: ' + operator);
    }
    this.wheres.push({ type: 'basic', boolean, column: String(column), operator, value: val });
    return this;
  }

  whereIn(column, values) {
    return this._whereIn('and', column, values);
  }
  orWhereIn(column, values) {
    return this._whereIn('or', column, values);
  }
  whereNotIn(column, values) {
    return this._whereNotIn('and', column, values);
  }
  orWhereNotIn(column, values) {
    return this._whereNotIn('or', column, values);
  }
  _whereIn(boolean, column, values) {
    if (!Array.isArray(values)) throw new Error('whereIn expects an array');
    this.wheres.push({ type: 'in', boolean, column: String(column), values: [...values] });
    return this;
  }
  _whereNotIn(boolean, column, values) {
    if (!Array.isArray(values)) throw new Error('whereNotIn expects an array');
    this.wheres.push({ type: 'notIn', boolean, column: String(column), values: [...values] });
    return this;
  }

  whereNull(column) {
    return this._whereNull('and', 'null', column);
  }
  orWhereNull(column) {
    return this._whereNull('or', 'null', column);
  }
  whereNotNull(column) {
    return this._whereNull('and', 'notNull', column);
  }
  orWhereNotNull(column) {
    return this._whereNull('or', 'notNull', column);
  }
  _whereNull(boolean, type, column) {
    this.wheres.push({ type, boolean, column: String(column) });
    return this;
  }

  whereLike(column, value) {
    return this._whereBasic('and', column, 'LIKE', value);
  }
  whereNotLike(column, value) {
    return this._whereBasic('and', column, 'NOT LIKE', value);
  }

  // Date-part filters. SQLite has no YEAR()/MONTH(); use date()/strftime().
  whereDate(column, operatorOrValue, value) {
    return this._whereDatePart('and', (c) => `date(${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  orWhereDate(column, operatorOrValue, value) {
    return this._whereDatePart('or', (c) => `date(${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  whereYear(column, operatorOrValue, value) {
    return this._whereDatePart('and', (c) => `strftime('%Y', ${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  whereMonth(column, operatorOrValue, value) {
    return this._whereDatePart('and', (c) => `strftime('%m', ${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  whereDay(column, operatorOrValue, value) {
    return this._whereDatePart('and', (c) => `strftime('%d', ${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  whereTime(column, operatorOrValue, value) {
    return this._whereDatePart('and', (c) => `time(${quoteIdent(c)})`, column, operatorOrValue, value);
  }
  _whereDatePart(boolean, fn, column, operatorOrValue, value) {
    const { operator, val } = normalizeOp(operatorOrValue, value);
    this.wheres.push({ type: 'raw', boolean, sql: `${fn(column)} ${operator} ?`, params: [val] });
    return this;
  }

  whereBetween(column, [min, max]) {
    this.wheres.push({ type: 'between', boolean: 'and', column: String(column), min, max });
    return this;
  }
  whereNotBetween(column, [min, max]) {
    this.wheres.push({ type: 'notBetween', boolean: 'and', column: String(column), min, max });
    return this;
  }

  whereColumn(first, operator = '=', second) {
    if (second === undefined) { second = operator; operator = '='; }
    const op = String(operator).toUpperCase();
    if (!ALLOWED_JOIN_OPS.has(op)) throw new Error('unsupported whereColumn operator: ' + op);
    this.wheres.push({ type: 'column', boolean: 'and', first: String(first), operator: op, second: String(second) });
    return this;
  }

  whereRaw(sql, params = []) {
    this.wheres.push({ type: 'raw', boolean: 'and', sql: String(sql), params: [...params] });
    return this;
  }
  orWhereRaw(sql, params = []) {
    this.wheres.push({ type: 'raw', boolean: 'or', sql: String(sql), params: [...params] });
    return this;
  }

  whereGroup(cb, boolean = 'and') {
    const sub = new QueryBuilder(this.db, this.table);
    cb(sub);
    this.wheres.push({ type: 'group', boolean, wheres: sub.wheres });
    return this;
  }
  orWhereGroup(cb) {
    return this.whereGroup(cb, 'or');
  }

  join(table, first, operator, second) {
    return this._join('INNER', table, first, operator, second);
  }
  innerJoin(table, first, operator, second) {
    return this._join('INNER', table, first, operator, second);
  }
  leftJoin(table, first, operator, second) {
    return this._join('LEFT', table, first, operator, second);
  }
  rightJoin(table, first, operator, second) {
    return this._join('RIGHT', table, first, operator, second);
  }
  _join(kind, table, first, operator, second) {
    const op = String(operator).toUpperCase();
    if (!ALLOWED_JOIN_OPS.has(op)) throw new Error('unsupported join operator: ' + op);
    this.joins.push({ kind, table: String(table), first: String(first), operator: op, second: String(second) });
    return this;
  }

  groupBy(...columns) {
    for (const c of columns) {
      if (Array.isArray(c)) this.groups.push(...c.map(String));
      else this.groups.push(String(c));
    }
    return this;
  }

  having(column, operatorOrValue, value) {
    let operator = '=';
    let val = operatorOrValue;
    if (value !== undefined) {
      operator = String(operatorOrValue).toUpperCase();
      val = value;
      if (!ALLOWED_OPS.has(operator)) throw new Error('unsupported having operator: ' + operator);
    }
    this.havings.push({ type: 'basic', boolean: 'and', column: String(column), operator, value: val });
    return this;
  }
  havingRaw(sql, params = []) {
    this.havings.push({ type: 'raw', boolean: 'and', sql: String(sql), params: [...params] });
    return this;
  }

  orderBy(column, direction = 'asc') {
    const dir = String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    this.order.push({ column: String(column), direction: dir });
    return this;
  }
  orderByDesc(column) { return this.orderBy(column, 'desc'); }
  latest(column = 'created_at') { return this.orderByDesc(column); }
  oldest(column = 'created_at') { return this.orderBy(column, 'asc'); }

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
    c.columns = this.columns.map((col) => (isPlainObject(col) ? { raw: col.raw, params: [...col.params] } : col));
    c.wheres = cloneWheres(this.wheres);
    c.joins = this.joins.map((j) => ({ ...j }));
    c.groups = [...this.groups];
    c.havings = cloneWheres(this.havings);
    c.order = this.order.map((o) => ({ ...o }));
    c.distinctValue = this.distinctValue;
    c.limitValue = this.limitValue;
    c.offsetValue = this.offsetValue;
    c.model = this.model;
    return c;
  }

  _whereSql(params) {
    return renderClauses(this.wheres, params);
  }

  _havingSql(params) {
    return renderClauses(this.havings, params, 'HAVING');
  }

  _joinSql() {
    if (!this.joins.length) return '';
    return this.joins
      .map((j) => ` ${j.kind} JOIN ${quoteIdent(j.table)} ON ${quoteIdent(j.first)} ${j.operator} ${quoteIdent(j.second)}`)
      .join('');
  }

  _columnsSql(params) {
    const cols = [];
    for (const c of this.columns) {
      if (isPlainObject(c)) {
        for (const p of c.params) params.push(p);
        cols.push(c.raw);
      } else if (c === '*') {
        cols.push('*');
      } else {
        cols.push(quoteIdent(c));
      }
    }
    return cols.join(', ');
  }

  _groupSql() {
    if (!this.groups.length) return '';
    return ' GROUP BY ' + this.groups.map(quoteIdent).join(', ');
  }

  _tailSql(params) {
    let sql = '';
    if (this.order.length) {
      sql += ' ORDER BY ' + this.order.map((o) => `${quoteIdent(o.column)} ${o.direction}`).join(', ');
    }
    if (this.limitValue != null) sql += ' LIMIT ?';
    if (this.offsetValue != null) sql += ' OFFSET ?';
    if (this.limitValue != null) params.push(this.limitValue);
    if (this.offsetValue != null) params.push(this.offsetValue);
    return sql;
  }

  toSql() {
    const params = [];
    const cols = this._columnsSql(params);
    let sql = `SELECT ${this.distinctValue ? 'DISTINCT ' : ''}${cols} FROM ${quoteIdent(this.table)}`;
    sql += this._joinSql();
    sql += renderClauses(this.wheres, params);
    sql += this._groupSql();
    sql += renderClauses(this.havings, params, 'HAVING');
    sql += this._tailSql(params);
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
    const agg = column === '*' ? '*' : quoteIdent(column);
    let sql = `SELECT COUNT(${agg}) AS "aggregate" FROM ${quoteIdent(this.table)}`;
    sql += this._joinSql();
    sql += renderClauses(this.wheres, params);
    sql += this._groupSql();
    sql += renderClauses(this.havings, params, 'HAVING');
    const stmt = this._prepare(sql, params);
    const res = await stmt.first();
    const row = res || {};
    return Number(row.aggregate ?? row['COUNT(*)'] ?? 0);
  }

  async _aggregate(fn, column) {
    const params = [];
    const agg = column === undefined || column === '*' ? '*' : quoteIdent(column);
    let sql = `SELECT ${fn}(${agg}) AS "aggregate" FROM ${quoteIdent(this.table)}`;
    sql += this._joinSql();
    sql += renderClauses(this.wheres, params);
    sql += this._groupSql();
    sql += renderClauses(this.havings, params, 'HAVING');
    const stmt = this._prepare(sql, params);
    const res = await stmt.first();
    const row = res || {};
    return row.aggregate == null ? null : Number(row.aggregate);
  }

  async sum(column) { return this._aggregate('SUM', column); }
  async avg(column) { return this._aggregate('AVG', column); }
  async min(column) { return this._aggregate('MIN', column); }
  async max(column) { return this._aggregate('MAX', column); }

  async exists() {
    const params = [];
    let sql = `SELECT 1 AS "e" FROM ${quoteIdent(this.table)}`;
    sql += this._joinSql();
    sql += renderClauses(this.wheres, params);
    sql += this._groupSql();
    sql += renderClauses(this.havings, params, 'HAVING');
    sql += ' LIMIT 1';
    const stmt = this._prepare(sql, params);
    const res = await stmt.first();
    return !!res;
  }

  async value(column) {
    const b = this.clone().select(String(column));
    const { sql, params } = b.limit(1).toSql();
    const stmt = this._prepare(sql, params);
    const row = await stmt.first();
    if (!row) return null;
    if (this.model && typeof row.get === 'function') return row.get(column);
    return row[column];
  }

  async pluck(column) {
    const rows = await this.clone().select(String(column)).get();
    return rows.map((r) => (this.model && typeof r.get === 'function' ? r.get(column) : r[column]));
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
    sql += renderClauses(this.wheres, params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async delete() {
    const params = [];
    let sql = `DELETE FROM ${quoteIdent(this.table)}`;
    sql += renderClauses(this.wheres, params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async truncate() {
    const stmt = this.db.prepare(`DELETE FROM ${quoteIdent(this.table)}`);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async insertGetId(data) {
    const res = await this.insert(data);
    return res.lastInsertRowid;
  }

  // SQLite/D1 upsert: multi-row INSERT ... ON CONFLICT (unique) DO UPDATE|NOTHING.
  async upsert(rows, uniqueBy, updateColumns) {
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) throw new Error('upsert expects at least one row');
    const columns = Object.keys(list[0]);
    const unique = Array.isArray(uniqueBy) ? uniqueBy.map(String) : [String(uniqueBy)];
    const update = (updateColumns == null ? [] : (Array.isArray(updateColumns) ? updateColumns : [updateColumns]))
      .map(String)
      .filter((c) => !unique.includes(c));
    const params = [];
    const tuples = list.map((row) => '(' + columns.map((c) => { params.push(row[c] ?? null); return '?'; }).join(', ') + ')');
    let sql = `INSERT INTO ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`;
    sql += ` ON CONFLICT (${unique.map(quoteIdent).join(', ')}) `;
    if (update.length) sql += `DO UPDATE SET ${update.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ')}`;
    else sql += 'DO NOTHING';
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async increment(column, amount = 1) {
    const params = [Number(amount)];
    let sql = `UPDATE ${quoteIdent(this.table)} SET ${quoteIdent(column)} = ${quoteIdent(column)} + ?`;
    sql += renderClauses(this.wheres, params);
    const stmt = this._prepare(sql, params);
    const res = await stmt.run();
    return { success: !!(res && res.success), changes: res?.meta?.changes ?? 0, meta: res?.meta ?? {} };
  }

  async decrement(column, amount = 1) {
    return this.increment(column, -Number(amount));
  }

  async updateOrInsert(where, values) {
    const q = new QueryBuilder(this.db, this.table);
    for (const [k, v] of Object.entries(where || {})) q.where(k, v);
    const existing = await q.clone().first();
    if (existing) return q.update(values);
    return this.insert({ ...(where || {}), ...(values || {}) });
  }

  async chunk(size, cb) {
    const n = Math.max(1, Number(size) || 1);
    for (let page = 1; ; page++) {
      const rows = await this.clone().limit(n).offset((page - 1) * n).get();
      if (!rows.length) return;
      const stop = await cb(rows, page);
      if (rows.length < n || stop === false) return;
    }
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

function cloneWheres(wheres) {
  return wheres.map((w) => {
    const copy = { ...w };
    if (w.values) copy.values = [...w.values];
    if (w.params) copy.params = [...w.params];
    if (w.wheres) copy.wheres = cloneWheres(w.wheres);
    return copy;
  });
}

// Render a list of where-like clauses with AND/OR booleans. Flat list → the
// first clause has no connector, the rest are prefixed by their boolean.
function renderClauses(clauses, params, keyword = 'WHERE') {
  if (!clauses.length) return '';
  const parts = clauses.map((w) => {
    let chunk;
    if (w.type === 'basic') {
      params.push(w.value);
      chunk = `${quoteIdent(w.column)} ${w.operator} ?`;
    } else if (w.type === 'in') {
      if (!w.values.length) chunk = '1 = 0';
      else {
        for (const v of w.values) params.push(v);
        chunk = `${quoteIdent(w.column)} IN (${w.values.map(() => '?').join(', ')})`;
      }
    } else if (w.type === 'notIn') {
      if (!w.values.length) chunk = '1 = 1';
      else {
        for (const v of w.values) params.push(v);
        chunk = `${quoteIdent(w.column)} NOT IN (${w.values.map(() => '?').join(', ')})`;
      }
    } else if (w.type === 'null') {
      chunk = `${quoteIdent(w.column)} IS NULL`;
    } else if (w.type === 'notNull') {
      chunk = `${quoteIdent(w.column)} IS NOT NULL`;
    } else if (w.type === 'between') {
      params.push(w.min, w.max);
      chunk = `${quoteIdent(w.column)} BETWEEN ? AND ?`;
    } else if (w.type === 'notBetween') {
      params.push(w.min, w.max);
      chunk = `${quoteIdent(w.column)} NOT BETWEEN ? AND ?`;
    } else if (w.type === 'column') {
      chunk = `${quoteIdent(w.first)} ${w.operator} ${quoteIdent(w.second)}`;
    } else if (w.type === 'raw') {
      for (const p of w.params) params.push(p);
      chunk = w.sql;
    } else if (w.type === 'group') {
      const inner = renderClauses(w.wheres, params);
      chunk = '(' + inner.replace(/^ (WHERE|HAVING) /, '').replace(/^ (AND|OR) /, '') + ')';
    } else {
      throw new Error('unknown where type: ' + w.type);
    }
    return { boolean: w.boolean || 'and', chunk };
  });
  let sql = '';
  parts.forEach((p, i) => {
    if (i === 0) sql += p.chunk;
    else sql += ' ' + p.boolean.toUpperCase() + ' ' + p.chunk;
  });
  return ' ' + keyword + ' ' + sql;
}

export function table(db, name) {
  return new QueryBuilder(db, name);
}

export const DB = { table };
export default { QueryBuilder, table, DB };
