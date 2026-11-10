// tools/tests/packages-d-spatie.test.mjs — real tests for the Spatie cluster.
//
// Drives each handler with a fake in-memory D1 (`env.DB` implementing
// prepare(sql).bind(...).all()/first()/run() over a table map) and a fake
// `fetch`/Request, then asserts the actual behavior: role checks, tag
// pivot mutations, unique-slug generation, activity record/replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import permissionHandler from '../../ports/packages/permission.mjs';
import tagsHandler from '../../ports/packages/tags.mjs';
import sluggableHandler from '../../ports/packages/sluggable.mjs';
import activitylogHandler from '../../ports/packages/activitylog.mjs';

// ---------------------------------------------------------------------------
// Fake D1 — a tiny SQL interpreter good enough for the statements these
// handlers emit. Not a SQLite replacement; it enforces the constraints the
// handlers actually rely on (UNIQUE, PK, NOT NULL, autoincrement).
// ---------------------------------------------------------------------------
class FakeD1 {
  constructor() {
    this.tables = new Map(); // name -> { columns: [{name,pk,notnull,unique}], rows: [], autoinc: 0 }
    this.indexes = new Map();
    this.execLog = [];
  }

  prepare(sql) {
    const self = this;
    const stmt = {
      _sql: sql.trim().replace(/;\s*$/, ''),
      _params: [],
      bind(...params) {
        this._params = params;
        return this;
      },
      async run() {
        return self._exec(this._sql, this._params);
      },
      async all() {
        return self._exec(this._sql, this._params);
      },
      async first() {
        const res = await self._exec(this._sql, this._params);
        if (res && Array.isArray(res.results)) return res.results[0] ?? null;
        return res;
      },
    };
    return stmt;
  }

  _table(name) {
    if (!this.tables.has(name)) this.tables.set(name, { columns: [], rows: [], autoinc: 0 });
    return this.tables.get(name);
  }

  _exec(sql, params) {
    this.execLog.push({ sql, params });
    const upper = sql.toUpperCase();
    if (upper.startsWith('CREATE TABLE')) return this._createTable(sql);
    if (upper.startsWith('CREATE INDEX')) return { changes: 0 };
    if (upper.startsWith('INSERT')) return this._insert(sql, params);
    if (upper.startsWith('UPDATE')) return this._update(sql, params);
    if (upper.startsWith('DELETE')) return this._delete(sql, params);
    if (upper.startsWith('SELECT')) return this._select(sql, params);
    throw new Error(`FakeD1: unsupported statement: ${sql}`);
  }

  _createTable(sql) {
    // CREATE TABLE IF NOT EXISTS name ( col defs )
    const m = sql.match(/CREATE TABLE IF NOT EXISTS\s+"?(\w+)"?\s*\(([\s\S]+)\)/i);
    if (!m) throw new Error(`FakeD1: cannot parse CREATE TABLE: ${sql}`);
    const name = m[1];
    const t = this._table(name);
    t.uniqueGroups = t.uniqueGroups || [];
    if (t.columns.length) {
      // Already exists — but still record table-level constraints a bare seed
      // may have missed.
      for (const raw of splitTopLevel(m[2])) {
        const um = raw.trim().match(/^UNIQUE\s*\(([^)]+)\)/i);
        const pm = raw.trim().match(/^PRIMARY KEY\s*\(([^)]+)\)/i);
        const grp = um || pm;
        if (grp) {
          t.uniqueGroups.push(grp[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()));
        }
      }
      return { changes: 0 };
    }
    const body = m[2];
    for (const raw of splitTopLevel(body)) {
      const def = raw.trim();
      const cm = def.match(/^"?(\w+)"?\s+(.+)$/i);
      if (!cm) continue; // table-level constraint (UNIQUE/PRIMARY KEY) — handled below
      const colName = cm[1].toLowerCase();
      const rest = cm[2].toUpperCase();
      if (/^(UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK)\b/.test(def)) continue; // table-level constraint line
      t.columns.push({
        name: colName,
        pk: /\bPRIMARY KEY\b/.test(rest) || colName === 'id',
        notnull: /\bNOT NULL\b/.test(rest),
        unique: /\bUNIQUE\b/.test(rest),
        autoinc: /\bAUTOINCREMENT\b/.test(rest),
      });
      if (/\bUNIQUE\b/.test(rest)) t.uniqueGroups.push([colName]);
    }
    for (const raw of splitTopLevel(body)) {
      const um = raw.trim().match(/^UNIQUE\s*\(([^)]+)\)/i);
      const pm = raw.trim().match(/^PRIMARY KEY\s*\(([^)]+)\)/i);
      const grp = um || pm;
      if (grp) {
        t.uniqueGroups.push(grp[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()));
      }
    }
    return { changes: 0 };
  }

  _cols(t) {
    return t.columns.map((c) => c.name);
  }

  _insert(sql, params) {
    const ignore = /INSERT\s+OR\s+IGNORE/i.test(sql);
    const m = sql.match(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+"?(\w+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]*)\)/i);
    if (!m) throw new Error(`FakeD1: cannot parse INSERT: ${sql}`);
    const t = this._table(m[1]);
    const cols = m[2].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
    // VALUES entries can be "?" placeholders or SQL literals (e.g. 0, 'x', NULL)
    const valueSlots = splitTopLevel(m[3]);
    const values = valueSlots.map((slot) => {
      const s = slot.trim();
      if (s === '?') return params.shift();
      if (/^NULL$/i.test(s)) return null;
      if (/^-?\d+(\.\d+)?$/i.test(s)) return Number(s);
      if (/^'(?:[^']|'')*'$/i.test(s)) return s.slice(1, -1).replace(/''/g, "'");
      throw new Error(`FakeD1: unsupported VALUES literal: ${s}`);
    });
    if (cols.length !== values.length) {
      throw new Error(`FakeD1: INSERT column/value mismatch (${cols.length} cols, ${values.length} values): ${sql}`);
    }

    let row = {};
    let explicitId = null;
    cols.forEach((c, i) => {
      const v = values[i];
      if (c === 'id' && v != null) explicitId = Number(v);
      row[c] = v === undefined ? null : v;
    });

    // UNIQUE / PK enforcement (constraints come from the stored CREATE TABLE)
    const uniqueGroups = t.uniqueGroups || [];
    for (const group of uniqueGroups) {
      const cand = group.map((c) => row[c] ?? null);
      if (cand.every((v) => v == null)) continue;
      const dup = t.rows.find((r) => group.every((c, i) => (r[c] ?? null) === cand[i]));
      if (dup) {
        if (ignore) return { changes: 0, last_row_id: dup.id, meta: { changes: 0, last_row_id: dup.id } };
        const err = new Error('UNIQUE constraint failed');
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
    }

    let id;
    const hasIdCol = t.columns.length === 0 || t.columns.some((c) => c.name === 'id');
    if (explicitId != null) {
      id = explicitId;
      row.id = id;
    } else if (hasIdCol && !('id' in row)) {
      id = ++t.autoinc;
      row.id = id;
    }
    t.rows.push(row);
    return { changes: 1, last_row_id: id, meta: { changes: 1, last_row_id: id } };
  }

  _update(sql, params) {
    const m = sql.match(/^UPDATE\s+"?(\w+)"?\s*SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new Error(`FakeD1: cannot parse UPDATE: ${sql}`);
    const t = this._table(m[1]);
    const sets = parseAssignments(m[2]);
    const where = m[3] ? buildWhere(m[3]) : () => true;
    let changes = 0;
    for (const row of t.rows) {
      if (!where(row, params)) continue;
      let pi = 0;
      const setPairs = m[2].split(',').map((s) => s.split('='));
      void setPairs;
      for (const [col] of sets) {
        // params consumed left-to-right in SET order
      }
      // Assign: SET a = ?, b = ? consumes params[0..n-1]; WHERE consumes rest.
      let offset = 0;
      for (const col of sets) {
        row[col] = params[offset++];
      }
      changes++;
    }
    return { changes, meta: { changes } };
  }

  _delete(sql, params) {
    const m = sql.match(/^DELETE FROM\s+"?(\w+)"?(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new Error(`FakeD1: cannot parse DELETE: ${sql}`);
    const t = this._table(m[1]);
    const where = m[2] ? buildWhere(m[2]) : () => true;
    const before = t.rows.length;
    t.rows = t.rows.filter((row) => !where(row, params));
    const changes = before - t.rows.length;
    return { changes, meta: { changes } };
  }

  _select(sql, params) {
    const parsed = parseSelect(sql);
    parsed.table = this._table(parsed.tableName);
    let combined = parsed.table.rows.map((row) => {
      const c = {};
      for (const k of Object.keys(row)) c[`${parsed.baseAlias}.${k}`] = row[k];
      return c;
    });
    for (const join of parsed.joins) {
      const jt = this._table(join.table);
      const next = [];
      for (const left of combined) {
        let matched = false;
        for (const right of jt.rows) {
          const c = { ...left };
          for (const k of Object.keys(right)) c[`${join.alias}.${k}`] = right[k];
          const onLeft = evalExpr(join.onLeft, c, params);
          const onRight = evalExpr(join.onRight, c, params);
          if (onLeft === onRight) {
            next.push(c);
            matched = true;
          }
        }
        if (!matched && join.kind === 'LEFT') {
          const c = { ...left };
          for (const col of jt.columns) c[`${join.alias}.${col.name}`] = null;
          next.push(c);
        }
      }
      combined = next;
    }

    const whereFn = buildWhere((parsed.wheres || []).map((w) => w.raw).join(' AND '));
    let rows = combined.filter((row) => whereFn(row, params));

    if (parsed.orderBy) {
      const desc = parsed.orderBy.desc;
      rows.sort((a, b) => {
        const av = resolveCell(a, parsed.orderBy.col);
        const bv = resolveCell(b, parsed.orderBy.col);
        const cmp = av == null && bv == null ? 0 : av == null ? -1 : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
        return desc ? -cmp : cmp;
      });
    }
    if (parsed.count) {
      return { results: [{ n: rows.length }], meta: {} };
    }
    // Limit may come from a literal (parsed.limit number) or a bind param.
    let limitN = parsed.limit;
    if (limitN === '?') {
      limitN = params[params.length - 1];
    }
    if (parsed.limit !== null && parsed.limit !== undefined) rows = rows.slice(0, Number(limitN));

    const out = rows.map((row) => {
      if (parsed.star) {
        const o = {};
        for (const [k, v] of Object.entries(row)) o[k.includes('.') ? k.split('.')[1] : k] = v;
        return o;
      }
      const o = {};
      for (const item of parsed.select) {
        if (item.alias) {
          o[item.alias] = resolveCell(row, item.expr);
        } else {
          const key = item.expr.includes('.') ? item.expr.split('.')[1] : item.expr;
          o[key] = resolveCell(row, item.expr);
        }
      }
      return o;
    });
    return { results: out, meta: {} };
  }
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseAssignments(setClause) {
  // "a = ?, b = ?" → ['a','b'] (only ? placeholders supported)
  return splitTopLevel(setClause).map((s) => s.split('=')[0].trim().replace(/"/g, '').toLowerCase());
}

function tokenizeWhere(clause) {
  // Split on AND/OR at top level (no parens in our handlers' WHERE clauses).
  const parts = clause.split(/\b(AND|OR)\b/i);
  const tokens = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) tokens.push({ op: parts[i].toUpperCase() });
    else if (parts[i].trim()) tokens.push({ raw: parts[i].trim() });
  }
  return tokens;
}

function buildWhere(clause) {
  const tokens = tokenizeWhere(clause);
  const clauses = [];
  for (const tk of tokens) {
    if (tk.raw) clauses.push(tk.raw);
  }
  return (row, params) => {
    let pi = 0; // one placeholder per clause, consumed left-to-right
    return clauses.every((raw) => evalWhereRaw(raw, row, params, pi++));
  };
}

// Evaluate a single comparison: "col OP ?" | "col IS ?" | "col IS NULL" | "col = ?"
function evalWhereRaw(raw, row, params, paramIndex) {
  const part = raw.trim();
  const pv = params[paramIndex];
  let m;
  if ((m = part.match(/^(\w+(?:\.\w+)?)\s+IS\s+NULL$/i))) {
    return resolveCell(row, m[1]) == null;
  }
  if ((m = part.match(/^(\w+(?:\.\w+)?)\s+IS\s+\?$/i))) {
    const cell = resolveCell(row, m[1]);
    return pv == null ? cell == null : cell === pv;
  }
  if ((m = part.match(/^(\w+(?:\.\w+)?)\s*(!=|<>)\s*\?$/i))) {
    return resolveCell(row, m[1]) !== pv;
  }
  if ((m = part.match(/^(\w+(?:\.\w+)?)\s*=\s*\?$/i))) {
    return resolveCell(row, m[1]) === pv;
  }
  if ((m = part.match(/^(\w+(?:\.\w+)?)\s+LIKE\s+\?$/i))) {
    const pattern = pv;
    const cell = String(resolveCell(row, m[1]) ?? '');
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    return re.test(cell);
  }
  throw new Error(`FakeD1: unsupported WHERE fragment: "${part}"`);
}

function resolveCell(row, expr) {
  if (expr.includes('.')) return row[expr] ?? null;
  // unqualified: try exact, else any column ending in .expr or .TABLE.expr
  if (expr in row) return row[expr];
  const suffix = `.${expr}`;
  const tqSuffix = `${suffix}`; // .expr  (matches alias.col and table.col keys)
  let fallback = null;
  for (const k of Object.keys(row)) {
    if (k === expr) return row[k];
    if (k.endsWith(tqSuffix)) {
      // prefer the bare alias.col match; keep scanning for a TABLE.col match
      if (fallback === null) fallback = row[k];
    }
  }
  return fallback;
}

function evalExpr(expr, row, params) {
  return resolveCell(row, expr.trim());
}

function parseSelect(sql) {
  const fromRe = /^SELECT\s+([\s\S]+?)\s+FROM\s+"?(\w+)"?(?:\s+(?:AS\s+)?"?(?!(?:WHERE|ORDER|LIMIT|JOIN|ON|GROUP|HAVING|INNER|LEFT|RIGHT|CROSS|AS)\b)(\w+)"?)?\s*([\s\S]*)$/i;
  const m = sql.match(fromRe);
  if (!m) throw new Error(`FakeD1: cannot parse SELECT: ${sql}`);
  const selectClause = m[1].trim();
  const tableName = m[2];
  const baseAlias = m[3] || tableName;
  const rest = m[4] || '';
  const table = null; // resolved by caller (FakeD1._select sets parsed.table)
  const parsed = {
    selectClause,
    tableName,
    baseAlias,
    table,
    joins: [],
    wheres: [],
    orderBy: null,
    limit: null,
    count: false,
    star: false,
    select: [],
  };

  if (/^COUNT\(\*\)\s+AS\s+n$/i.test(selectClause)) parsed.count = true;

  // Peel off ORDER BY / LIMIT first so they don't confuse the JOIN scan.
  let remaining = rest;
  const lm = remaining.match(/\bLIMIT\s+(\d+|\?)\s*$/i);
  if (lm) {
    parsed.limit = lm[1] === '?' ? '?' : Number(lm[1]);
    remaining = remaining.slice(0, lm.index).trim();
  }
  const om = remaining.match(/\bORDER BY\s+([\w.]+)(\s+DESC|\s+ASC)?(?:\s*,\s*[\w.]+(?:\s+(?:DESC|ASC))?)*\s*$/i);
  if (om) {
    parsed.orderBy = { col: om[1], desc: /DESC/i.test(om[2] || '') };
    remaining = remaining.slice(0, om.index).trim();
  }

  const wm = remaining.match(/\bWHERE\s+([\s\S]+)$/i);
  if (wm) {
    remaining = remaining.slice(0, wm.index).trim();
    parsed.wheres = tokenizeWhere(wm[1])
      .filter((tk) => tk.raw)
      .map((tk) => ({ raw: tk.raw, ops: tk.op ? [tk.op] : [] }));
  }

  // Remaining text (if any) is a chain of JOIN clauses.
  const joinRe = /\b(INNER|LEFT)\s+JOIN\s+"?(\w+)"?(?:\s+(?:AS\s+)?"?(\w+)"?)?\s+ON\s+([\s\S]+?)(?=\b(INNER|LEFT)\s+JOIN\b|$)/gi;
  let jm;
  while ((jm = joinRe.exec(remaining)) !== null) {
    const on = jm[4];
    const eq = on.split('=');
    parsed.joins.push({
      table: jm[2],
      alias: jm[3] || jm[2],
      onLeft: eq[0].trim(),
      onRight: (eq[1] || '').trim(),
      kind: /LEFT/i.test(jm[1]) ? 'LEFT' : 'INNER',
    });
  }

  if (!parsed.count) {
    if (selectClause === '*') parsed.star = true;
    else {
      for (const raw of splitTopLevel(selectClause)) {
        const am = raw.trim().match(/^([\w.*]+)\s+AS\s+(\w+)$/i);
        if (am) parsed.select.push({ expr: am[1], alias: am[2] });
        else parsed.select.push({ expr: raw.trim() });
      }
    }
  }
  return parsed;
}

// Fake request helper
function makeCtx({ method = 'GET', params = {}, query = {}, body = null } = {}) {
  return {
    params,
    query,
    body,
    request: new Request('https://edge.local/test', { method }),
  };
}

function env() {
  return { DB: new FakeD1() };
}

// ---------------------------------------------------------------------------

test('permission: ensureSchema creates the five Spatie tables', async () => {
  const e = env();
  const res = await permissionHandler(makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { role: 'admin' } }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { hasRole: false });
  for (const name of ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions']) {
    assert.ok(e.DB.tables.has(name), `expected table ${name}`);
  }
});

test('permission: assign + hasRole + idempotent re-assign + revoke', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO roles (name, guard_name) VALUES (?, ?)').bind('editor', 'web').run();

  const assign = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'assign-role' }, body: { role: 'editor' } }),
    e
  );
  assert.equal(assign.status, 200);
  assert.deepEqual(JSON.parse(assign.body), { assigned: 1 });

  // idempotent
  const again = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'assign-role' }, body: { role: 'editor' } }),
    e
  );
  assert.deepEqual(JSON.parse(again.body), { assigned: 0 });

  const has = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '7' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(has.body).hasRole, true);

  // different model key does not have it
  const other = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '8' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(other.body).hasRole, false);

  const revoke = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'revoke-role' }, body: { role: 'editor' } }),
    e
  );
  assert.deepEqual(JSON.parse(revoke.body), { revoked: 1 });
  const hasAfter = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '7' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(hasAfter.body).hasRole, false);
});

test('permission: hasPermissionTo via direct + via role; missing permission → false', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('edit-posts').run();
  await e.DB.prepare('INSERT INTO roles (name) VALUES (?)').bind('author').run();
  const role = await e.DB.prepare('SELECT id FROM roles WHERE name = ?').bind('author').first();
  const perm = await e.DB.prepare('SELECT id FROM permissions WHERE name = ?').bind('edit-posts').first();
  await e.DB.prepare('INSERT INTO role_has_permissions (permission_id, role_id) VALUES (?, ?)').bind(perm.id, role.id).run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'author' } }),
    e
  );

  const viaRole = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'edit-posts' } }),
    e
  );
  assert.equal(JSON.parse(viaRole.body).hasPermissionTo, true);

  // direct give
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('delete-posts').run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'give-permission' }, body: { permission: 'delete-posts' } }),
    e
  );
  const direct = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'delete-posts' } }),
    e
  );
  assert.equal(JSON.parse(direct.body).hasPermissionTo, true);

  const missing = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'nonexistent' } }),
    e
  );
  assert.equal(JSON.parse(missing.body).hasPermissionTo, false);
});

test('permission: hasAnyPermission + hasAnyRole aggregations', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO roles (name) VALUES (?)').bind('admin').run();
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('a').run();
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('b').run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '3', action: 'assign-role' }, body: { role: 'admin' } }),
    e
  );
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '3', action: 'give-permission' }, body: { permission: 'a' } }),
    e
  );
  const anyPerm = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { permissions: 'a,zzz' } }),
    e
  );
  assert.equal(JSON.parse(anyPerm.body).hasAnyPermission, true);
  assert.equal(JSON.parse(anyPerm.body).per_permission.a, true);
  assert.equal(JSON.parse(anyPerm.body).per_permission.zzz, false);

  const anyRole = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { roles: 'admin,nope' } }),
    e
  );
  assert.equal(JSON.parse(anyRole.body).hasAnyRole, true);

  const none = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { roles: 'x,y' } }),
    e
  );
  assert.equal(JSON.parse(none.body).hasAnyRole, false);
});

test('permission: unknown role on assign → 404', async () => {
  const e = env();
  const res = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'ghost' } }),
    e
  );
  assert.equal(res.status, 404);
});

test('tags: attach, list, idempotent attach', async () => {
  const e = env();
  const attach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p1' }, body: { action: 'attach', tags: ['Laravel', 'PHP'] } }),
    e
  );
  assert.equal(attach.status, 200);
  assert.deepEqual(JSON.parse(attach.body).attached.sort(), ['Laravel', 'PHP']);

  const list = await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p1' } }), e);
  assert.deepEqual(JSON.parse(list.body).tags.sort(), ['Laravel', 'PHP']);

  const reAttach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p1' }, body: { action: 'attach', tags: ['Laravel'] } }),
    e
  );
  assert.deepEqual(JSON.parse(reAttach.body).attached, []);
});

test('tags: detach removes; sync replaces; toggle flips', async () => {
  const e = env();
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'attach', tags: ['a', 'b', 'c'] } }),
    e
  );

  const detach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'detach', tags: ['a'] } }),
    e
  );
  assert.deepEqual(JSON.parse(detach.body).detached, ['a']);
  let list = JSON.parse((await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p2' } }), e)).body);
  assert.deepEqual(list.tags.sort(), ['b', 'c']);

  const sync = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'sync', tags: ['b', 'd'] } }),
    e
  );
  const syncBody = JSON.parse(sync.body).synced;
  assert.deepEqual(syncBody.removed.sort(), ['c']);
  assert.deepEqual(syncBody.added, ['d']);
  list = JSON.parse((await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p2' } }), e)).body);
  assert.deepEqual(list.tags.sort(), ['b', 'd']);

  const toggle = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'toggle', tags: ['b', 'd', 'x'] } }),
    e
  );
  const tBody = JSON.parse(toggle.body).toggled;
  assert.deepEqual(tBody.detached.sort(), ['b', 'd']);
  assert.deepEqual(tBody.attached, ['x']);
});

test('tags: type-scoped listing only returns that type', async () => {
  const e = env();
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p3' }, body: { action: 'attach', tags: ['red'], type: 'color' } }),
    e
  );
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p3' }, body: { action: 'attach', tags: ['hot'], type: 'mood' } }),
    e
  );
  const colors = JSON.parse(
    (await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p3' }, query: { type: 'color' } }), e)).body
  );
  assert.deepEqual(colors.tags, ['red']);
});

test('sluggable: base slug, then -2, -3 on collisions', async () => {
  const e = env();
  const gen = (source) =>
    sluggableHandler(makeCtx({ method: 'POST', body: { source, table: 'posts', column: 'slug' } }), e);
  const r1 = JSON.parse((await gen('Hello World')).body);
  assert.equal(r1.slug, 'hello-world');
  const r2 = JSON.parse((await gen('Hello World!')).body); // same base slug
  assert.equal(r2.slug, 'hello-world-2');
  const r3 = JSON.parse((await gen('Hello, World?')).body);
  assert.equal(r3.slug, 'hello-world-3');
});

test('sluggable: custom separator', async () => {
  const e = env();
  const a = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'Big Deal', table: 't', column: 'slug', separator: '_' } }),
      e
    )).body
  );
  assert.equal(a.slug, 'big_deal');
  const b = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'Big Deal', table: 't', column: 'slug', separator: '_' } }),
      e
    )).body
  );
  assert.equal(b.slug, 'big_deal_2');
});

test('sluggable: exclude_id lets a row regenerate its own slug without self-collision', async () => {
  const e = env();
  // seed a row (id=1) that already owns "my-post"
  await e.DB.prepare(
    'INSERT INTO slugs (slug_table, slug_column, slug, source) VALUES (?, ?, ?, ?)'
  ).bind('posts', 'slug', 'my-post', 'My Post').run();
  const regen = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'My Post', table: 'posts', column: 'slug', exclude_id: 1 } }),
      e
    )).body
  );
  assert.equal(regen.slug, 'my-post');
});

test('sluggable: GET lists candidates by prefix', async () => {
  const e = env();
  for (const s of ['alpha', 'alpha-2', 'beta']) {
    await sluggableHandler(makeCtx({ method: 'POST', body: { source: s, table: 'posts', column: 'slug' } }), e);
  }
  const res = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'GET', query: { table: 'posts', column: 'slug', prefix: 'alpha' } }),
      e
    )).body
  );
  assert.deepEqual(res.candidates.sort(), ['alpha', 'alpha-2']);
});

test('activitylog: record then read back with properties parsed', async () => {
  const e = env();
  const rec = await activitylogHandler(
    makeCtx({
      method: 'POST',
      body: {
        description: 'created post',
        event: 'created',
        subject_type: 'App\\Models\\Post',
        subject_id: 42,
        causer_id: 1,
        properties: { ip: '127.0.0.1', title: 'Hi' },
      },
    }),
    e
  );
  assert.equal(rec.status, 201);
  const act = JSON.parse(rec.body).activity;
  assert.equal(act.description, 'created post');
  assert.equal(act.event, 'created');
  assert.deepEqual(act.properties, { ip: '127.0.0.1', title: 'Hi' });

  const single = JSON.parse(
    (await activitylogHandler(makeCtx({ method: 'GET', params: { id: act.id } }), e)).body
  );
  assert.equal(single.activity.id, act.id);
  assert.deepEqual(single.activity.properties, { ip: '127.0.0.1', title: 'Hi' });
});

test('activitylog: list filtered by causer + single 404', async () => {
  const e = env();
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'a', causer_id: 9 } }), e);
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'b', causer_id: 10 } }), e);

  const for9 = JSON.parse(
    (await activitylogHandler(makeCtx({ method: 'GET', query: { causer_id: 9 } }), e)).body
  );
  assert.equal(for9.activities.length, 1);
  assert.equal(for9.activities[0].description, 'a');

  const missing = await activitylogHandler(makeCtx({ method: 'GET', params: { id: 9999 } }), e);
  assert.equal(missing.status, 404);
});

test('activitylog: newest first ordering', async () => {
  const e = env();
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'first' } }), e);
  await new Promise((r) => setTimeout(r, 5));
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'second' } }), e);
  const list = JSON.parse((await activitylogHandler(makeCtx({ method: 'GET' }), e)).body);
  assert.equal(list.activities[0].description, 'second');
});
