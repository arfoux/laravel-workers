// tools/tests/_batch2a-faked1.mjs — a compact in-memory D1 fake for the
// batch-2a auth/security cluster tests. Supports exactly the SQL shapes these
// handlers emit: CREATE TABLE IF NOT EXISTS, INSERT (literals + `?`/`?N`
// placeholders), UPDATE .. SET .. WHERE, DELETE .. WHERE, and SELECT
// [cols|*] FROM t [WHERE a=? [AND b=?]] [ORDER BY c DESC] [LIMIT n].
// `.first()` returns the row (or null); `.all()` returns `{ results }`;
// `.run()` returns `{ changes, meta.last_row_id }`. Not a SQLite replacement.

export class FakeD1 {
  constructor() {
    this.tables = new Map();
    this.unique = new Map(); // table -> [ [col,...], ... ]
    this._seq = new Map();
  }

  _rows(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  prepare(sql) {
    const self = this;
    const norm = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    const stmt = {
      _p: [],
      bind(...args) {
        this._p = args.flat();
        return this;
      },
      async run() {
        return self._exec(norm, this._p);
      },
      async all() {
        const rows = await self._exec(norm, this._p);
        return { results: Array.isArray(rows) ? rows : [] };
      },
      async first() {
        const rows = await self._exec(norm, this._p);
        return Array.isArray(rows) && rows.length ? rows[0] : null;
      },
    };
    return stmt;
  }

  // Placeholder resolver shared by a single statement: `?` consumes params
  // sequentially; `?N` reads params[N-1] directly. Handlers never mix the two
  // styles within one statement.
  _resolver(params) {
    return { params, seq: 0 };
  }

  _literal(token, R) {
    const t = String(token).trim();
    let m;
    if ((m = /^\?(\d+)$/.exec(t))) return R.params[Number(m[1]) - 1];
    if (t === '?') return R.params[R.seq++];
    if (/^NULL$/i.test(t)) return null;
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }

  _splitTop(body) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => p.trim());
  }

  _createTable(sql) {
    const m = /CREATE TABLE IF NOT EXISTS "?(\w+)"?\s*\(([\s\S]+)\)/i.exec(sql);
    if (!m) throw new Error('FakeD1: cannot parse CREATE TABLE: ' + sql);
    const name = m[1];
    this._rows(name);
    const groups = [];
    let hasId = false;
    for (const def of this._splitTop(m[2])) {
      const cm = /^"?(\w+)"?\s+/.exec(def);
      if (cm) {
        const col = cm[1].toLowerCase();
        if (col === 'id') hasId = true;
        if (/\bUNIQUE\b/i.test(def)) groups.push([col]);
      }
      const um = /^UNIQUE\s*\(([^)]+)\)/i.exec(def);
      if (um) groups.push(um[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()));
    }
    this.unique.set(name, groups);
    this.idCol = this.idCol || new Map();
    this.idCol.set(name, hasId);
    return { changes: 0 };
  }

  _exec(sql, params) {
    const upper = sql.toUpperCase();
    if (upper.startsWith('CREATE TABLE')) return this._createTable(sql);
    const R = this._resolver(params);

    if (upper.startsWith('INSERT')) return this._insert(sql, R);
    if (upper.startsWith('UPDATE')) return this._update(sql, R);
    if (upper.startsWith('DELETE')) return this._delete(sql, R);
    if (upper.startsWith('SELECT')) return this._select(sql, R);
    throw new Error('FakeD1: unsupported statement: ' + sql);
  }

  _insert(sql, R) {
    const m = /INSERT (?:OR IGNORE )?INTO "?(\w+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
    if (!m) throw new Error('FakeD1: cannot parse INSERT: ' + sql);
    const table = m[1];
    const cols = m[2].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
    const vals = this._splitTop(m[3]);
    const row = {};
    cols.forEach((c, i) => {
      row[c] = i < vals.length ? this._literal(vals[i], R) : null;
    });

    // unique enforcement (best-effort)
    for (const group of this.unique.get(table) || []) {
      const cand = group.map((c) => row[c] ?? null);
      if (cand.every((v) => v == null)) continue;
      if (this._rows(table).some((r) => group.every((c, i) => (r[c] ?? null) === cand[i]))) {
        if (/OR IGNORE/i.test(sql)) return { changes: 0, meta: { changes: 0 } };
        const err = new Error('UNIQUE constraint failed');
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
    }

    // Auto-assign the id when the table has one and the INSERT omitted it.
    const hasIdCol = (this.idCol && this.idCol.get(table)) || cols.includes('id');
    if (row.id == null && hasIdCol) {
      const next = (this._seq.get(table) || 0) + 1;
      this._seq.set(table, next);
      row.id = next;
    } else if (row.id != null) {
      const n = Number(row.id);
      if (Number.isFinite(n)) this._seq.set(table, Math.max(this._seq.get(table) || 0, n));
    }
    this._rows(table).push(row);
    return { changes: 1, meta: { changes: 1, last_row_id: row.id }, last_row_id: row.id };
  }

  _parseWhere(wherePart, R) {
    if (!wherePart) return () => true;
    const clauses = wherePart.split(/\s+AND\s+/i);
    const preds = clauses.map((c) => {
      const mm = /^\s*(\w+)\s*=\s*(.+)\s*$/i.exec(c);
      if (!mm) return () => true;
      const col = mm[1];
      const val = this._literal(mm[2], R);
      return (row) => String(row[col] ?? null) === String(val ?? null);
    });
    return (row) => preds.every((p) => p(row));
  }

  _update(sql, R) {
    const m = /UPDATE "?(\w+)"?\s*SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(sql);
    if (!m) throw new Error('FakeD1: cannot parse UPDATE: ' + sql);
    const rows = this._rows(m[1]);
    const sets = m[2].split(',').map((a) => {
      const eq = a.indexOf('=');
      return { col: a.slice(0, eq).trim(), val: this._literal(a.slice(eq + 1), R) };
    });
    const where = this._parseWhere(m[3], R);
    let changes = 0;
    for (const row of rows) {
      if (!where(row)) continue;
      for (const s of sets) row[s.col] = s.val;
      changes += 1;
    }
    return { changes, meta: { changes } };
  }

  _delete(sql, R) {
    const m = /DELETE FROM "?(\w+)"?(?:\s+WHERE\s+([\s\S]+))?$/i.exec(sql);
    if (!m) throw new Error('FakeD1: cannot parse DELETE: ' + sql);
    const rows = this._rows(m[1]);
    const where = this._parseWhere(m[2], R);
    const kept = rows.filter((r) => !where(r));
    this.tables.set(m[1], kept);
    return { changes: rows.length - kept.length, meta: { changes: rows.length - kept.length } };
  }

  _select(sql, R) {
    const m = /^SELECT\s+(.+?)\s+FROM\s+"?(\w+)"?([\s\S]*)$/i.exec(sql);
    if (!m) throw new Error('FakeD1: cannot parse SELECT: ' + sql);
    const sel = m[1].trim();
    const rows = this._rows(m[2]);
    let tail = m[3] || '';
    let wherePart = null;
    const wi = tail.toUpperCase().indexOf(' WHERE ');
    if (wi !== -1) {
      wherePart = tail.slice(wi + 7);
      tail = tail.slice(0, wi);
    }
    let orderDesc = false;
    let orderCol = null;
    const om = /ORDER BY\s+(\w+)\s*(DESC|ASC)?/i.exec(tail);
    if (om) {
      orderCol = om[1];
      orderDesc = (om[2] || '').toUpperCase() === 'DESC';
    }
    const lm = /LIMIT\s+(\d+)/i.exec(tail);
    const limit = lm ? Number(lm[1]) : null;

    let out = rows.slice();
    if (wherePart) out = out.filter(this._parseWhere(wherePart, R));
    if (orderCol) {
      out.sort((a, b) => {
        const av = a[orderCol];
        const bv = b[orderCol];
        const cmp = av == null && bv == null ? 0 : av == null ? -1 : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
        return orderDesc ? -cmp : cmp;
      });
    }
    if (limit != null) out = out.slice(0, limit);

    if (/^COUNT\(\*\)\s+AS\s+(\w+)$/i.test(sel)) {
      return [{ [sel.match(/^COUNT\(\*\)\s+AS\s+(\w+)$/i)[1]]: out.length }];
    }
    if (sel !== '*') {
      const cols = sel.split(',').map((c) => c.trim());
      out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }
    return out;
  }
}
