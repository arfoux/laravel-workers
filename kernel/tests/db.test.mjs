import { test } from 'node:test';
import assert from 'node:assert/strict';
import { table, DB, QueryBuilder } from '../db.mjs';
import { Model } from '../model.mjs';

function mockDb(responses = {}) {
  return {
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...p) {
          this.params = p;
          return this;
        },
        async all() {
          return (responses.all ? responses.all(sql, this.params) : { results: [] });
        },
        async first() {
          return (responses.first ? responses.first(sql, this.params) : null);
        },
        async run() {
          return (responses.run ? responses.run(sql, this.params) : { success: true, meta: { changes: 1, last_row_id: 2 } });
        },
      };
      return stmt;
    },
  };
}

test('QueryBuilder toSql quotes identifiers and binds values', () => {
  const db = mockDb();
  const b = table(db, 'users')
    .select('id', 'name')
    .where('active', true)
    .where('age', '>', 18)
    .whereIn('role', ['admin', 'user'])
    .whereNull('deleted_at')
    .orderBy('id', 'desc')
    .limit(10)
    .offset(5);
  const { sql, params } = b.toSql();
  assert.equal(sql, 'SELECT "id", "name" FROM "users" WHERE "active" = ? AND "age" > ? AND "role" IN (?, ?) AND "deleted_at" IS NULL ORDER BY "id" DESC LIMIT ? OFFSET ?');
  assert.deepEqual(params, [true, 18, 'admin', 'user', 10, 5]);
});

test('QueryBuilder get maps mock rows', async () => {
  const db = mockDb({
    all: (sql) => ({ results: [{ id: 1, name: 'Ada' }] }),
  });
  const rows = await table(db, 'users').where('id', 1).get();
  assert.deepEqual(rows, [{ id: 1, name: 'Ada' }]);
});

test('QueryBuilder first returns null when empty', async () => {
  const db = mockDb({ all: () => ({ results: [] }) });
  const row = await table(db, 'users').first();
  assert.equal(row, null);
});

test('QueryBuilder count reads aggregate', async () => {
  const db = mockDb({ first: () => ({ aggregate: 7 }) });
  const n = await table(db, 'users').where('active', true).count();
  assert.equal(n, 7);
});

test('QueryBuilder insert/update/delete return metadata', async () => {
  const calls = [];
  const db = mockDb({
    run: (sql, params) => {
      calls.push({ sql, params });
      return { success: true, meta: { changes: 1, last_row_id: 42 } };
    },
  });
  const inserted = await table(db, 'users').insert({ name: 'Ada', active: true });
  assert.equal(inserted.lastInsertRowid, 42);

  const updated = await table(db, 'users').where('id', 42).update({ name: 'Grace' });
  assert.equal(updated.changes, 1);

  const deleted = await table(db, 'users').where('id', 42).delete();
  assert.equal(deleted.changes, 1);

  assert.match(calls[0].sql, /^INSERT INTO "users"/);
  assert.deepEqual(calls[0].params, ['Ada', true]);
  assert.match(calls[1].sql, /^UPDATE "users" SET "name" = \? WHERE "id" = \?$/);
  assert.deepEqual(calls[1].params, ['Grace', 42]);
  assert.match(calls[2].sql, /^DELETE FROM "users" WHERE "id" = \?$/);
  assert.deepEqual(calls[2].params, [42]);
});

test('QueryBuilder paginate', async () => {
  let paginateAllCalls = 0;
  const db = mockDb({
    first: (sql) => (/COUNT\(/.test(sql) ? { aggregate: 5 } : null),
    all: () => {
      paginateAllCalls++;
      return paginateAllCalls === 1 ? { results: [{ id: 3 }, { id: 4 }] } : { results: [] };
    },
  });
  const page = await table(db, 'users').orderBy('id').paginate(2, 2);
  assert.equal(page.total, 5);
  assert.equal(page.current_page, 2);
  assert.equal(page.last_page, 3);
  assert.deepEqual(page.data, [{ id: 3 }, { id: 4 }]);
});

test('Model base CRUD', async () => {
  class User extends Model {
    static table = 'users';
    static fillable = ['name', 'email'];
    static casts = { id: 'int' };
  }

  const state = { users: [{ id: 1, name: 'Ada', email: 'ada@example.com' }] };
  const db = mockDb({
    all: (sql) => ({ results: [...state.users] }),
    first: (sql, params) => {
      if (/COUNT\(/.test(sql)) return { aggregate: state.users.length };
      const id = params[0];
      return state.users.find((u) => u.id === id) || null;
    },
    run: (sql, params) => {
      if (/^INSERT/.test(sql)) {
        const row = { id: 2, name: params[0], email: params[1] };
        state.users.push(row);
        return { success: true, meta: { changes: 1, last_row_id: 2 } };
      }
      if (/^UPDATE/.test(sql)) {
        const user = state.users.find((u) => u.id === params[params.length - 1]);
        if (user) user.name = params[0];
        return { success: true, meta: { changes: 1 } };
      }
      if (/^DELETE/.test(sql)) {
        state.users = state.users.filter((u) => u.id !== params[0]);
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
  });

  const created = await User.create(db, { name: 'Grace', email: 'grace@example.com' });
  assert.equal(created.exists, true);
  assert.equal(created.get('id'), 2);

  const found = await User.find(db, 1);
  assert.ok(found instanceof User);
  assert.equal(found.get('name'), 'Ada');

  found.set('name', 'Ada Lovelace');
  await found.save(db);
  assert.equal(state.users.find((u) => u.id === 1).name, 'Ada Lovelace');

  const all = await User.all(db);
  assert.equal(all.length, 2);

  await found.delete(db);
  assert.equal(state.users.some((u) => u.id === 1), false);
});

test('DB.table alias works', () => {
  assert.equal(typeof DB.table, 'function');
  assert.ok(new QueryBuilder(mockDb(), 'x') instanceof QueryBuilder);
});
