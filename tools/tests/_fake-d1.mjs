// One fake D1 for the whole suite: a thin adapter over **real SQLite**.
//
// Why this and not a hand-rolled row engine: the tests in this directory used to
// carry 13 separately written `FakeD1` classes (~1,400 lines of regex SQL
// parsing) plus this file's older 227-line version. Every one of them was an
// approximation of SQLite, so a statement the approximation accepted could still
// be rejected by real D1 - the production engine is SQLite, and so is
// `node:sqlite`, which Node 22 ships (and Bun implements). Binding `?`/`?N`,
// `ON CONFLICT`, `JOIN`, `LIKE`, `GROUP BY`, `ORDER BY`, `LIMIT/OFFSET`,
// `last_row_id`, `changes`, `UNIQUE` constraints and multi-statement `exec()`
// then come from the engine instead of from each test file's guesses.
//
// Shapes follow D1: `run()` -> `{ success, results, meta: { changes, last_row_id } }`,
// `all()` -> `{ success, results, meta }`, `first()` -> the row or `null`.
// `db.tables` is a read/seed facade over the real database, for the suites that
// assert on stored rows instead of going through SQL.
//
// Fail-loud by construction: SQL the engine rejects throws with the SQL text.

import { DatabaseSync } from 'node:sqlite';

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export class FakeD1 {
  // `schema` is the DDL the port's migration would have applied (usually the
  // package's exported SCHEMA constant). Tests pass it so the fake starts from
  // the same tables production has; nothing is inferred.
  constructor({ schema } = {}) {
    this.db = new DatabaseSync(':memory:');
    if (schema) this.db.exec(String(schema));
  }

  prepare(sql) {
    const db = this.db;
    const text = String(sql).trim().replace(/;$/, '');
    const stmt = {
      _params: [],
      bind(...args) {
        this._params = args.flat();
        return this;
      },
      _run(kind) {
        const prepared = db.prepare(text);
        const params = stmt._params;
        // `?N` placeholders: SQLite numbers them, and node:sqlite only accepts
        // numbered parameters through a keyed object (`{1: v}`), not
        // positionally. Raw D1 takes them positionally, which is how the ports
        // bind (`params[N-1]` is the value for `?N`), so the mapping here is
        // 1:1 on the index.
        const numbered = /\?\d/.test(text);
        // JS has one number type; SQLite does not. workerd binds an integral JS
        // number as an INTEGER (so a TEXT-affinity column stores '3', not
        // '3.0'), while node:sqlite binds every JS number as REAL. Coerce the
        // integral ones to BigInt to keep D1's observed storage.
        const fix = (v) => (typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : v);
        const bound = numbered
          ? Object.fromEntries(params.map((v, i) => [String(i + 1), fix(v)]))
          : params.map(fix);
        const call = (fn) => (numbered ? fn.call(prepared, bound) : fn.apply(prepared, bound));
        if (kind === 'run') {
          const r = call(prepared.run);
          // Exactly D1's `run()` result: `meta.last_row_id` / `meta.changes`,
          // nothing at the top level. A consumer reading `res.changes` is
          // reading a field production never sends.
          return {
            success: true,
            results: [],
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 },
          };
        }
        const rows = call(kind === 'first' ? prepared.get : prepared.all);
        if (kind === 'first') return rows === undefined ? null : rows;
        return { success: true, results: rows, meta: { changes: 0, last_row_id: 0, duration: 0 } };
      },
      async run() {
        return stmt._run('run');
      },
      async all() {
        return stmt._run('all');
      },
      async first() {
        return stmt._run('first');
      },
    };
    return stmt;
  }

  // D1's `batch` runs the statements in one transaction and returns one result
  // per statement, in order.
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  // Multi-statement DDL / setup, exactly like the D1 `exec` calls the ports make.
  async exec(sql) {
    this.db.exec(String(sql));
    return { success: true, results: [], meta: { changes: 0, last_row_id: 0, duration: 0 } };
  }

  close() {
    this.db.close();
  }

  // ---- inspection facade (tests only) --------------------------------
  get tables() {
    const self = this;
    return {
      has(name) {
        return !!self.db.prepare('SELECT 1 AS x FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
      },
      keys() {
        return self.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
      },
      get(name) {
        if (!this.has(name)) return undefined;
        return self.db.prepare(`SELECT * FROM ${q(name)}`).all();
      },
      // Seed rows without going through the port's own SQL (used by a few suites
      // to plant a row the handler must then find). Missing tables are created
      // from the first row's keys.
      set(name, rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!this.has(name)) {
          const cols = Object.keys(list[0] || {});
          if (!cols.length) return this;
          self.db.exec(`CREATE TABLE ${q(name)} (${cols.map((c) => `${q(c)} TEXT`).join(', ')})`);
        }
        self.db.prepare(`DELETE FROM ${q(name)}`).run();
        for (const row of list) {
          const cols = Object.keys(row);
          if (!cols.length) continue;
          self.db
            .prepare(`INSERT INTO ${q(name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
        }
        return this;
      },
    };
  }
}

export default FakeD1;
