import { test } from 'node:test';
import assert from 'node:assert/strict';
import { table, DB, QueryBuilder } from '../db.mjs';
import { Model } from '../model.mjs';
import { check, makeSync } from '../hash.mjs';

// PHP 8.3 / Laravel 13.37 oracle values (fresh-app vendor, 2026-10-19).
const HASH10 = '$2y$10$cyT1llBUHIVeZFxw/hKj0eIeqIJNsMI0SUhpbh6K5FWh7NxcNqnf.';
const HASH12 = '$2y$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH14 = '$2y$14$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH12_A = '$2a$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const SHORT_2Y = '$2y$10$abcdefghijklmnopqrstuv';
const ARGON = '$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$abc';

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
  assert.deepEqual(calls[0].params, ['Ada', 1]); // boolean bound as 1 (D1/SQLite cannot bind JS booleans)
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

// A users table with a frozen clock: the model timestamps are stubbed, so the
// write carries a known timestamp (the oracle value: 1700000000 ->
// '2023-11-14 22:13:20').
function usersFixture() {
  const state = {
    users: [
      {
        id: 1,
        name: 'Ada',
        email: 'ada@example.com',
        created_at: '2024-01-01 00:00:00',
        updated_at: '2024-01-01 00:00:00',
      },
    ],
  };
  const calls = [];
  const db = mockDb({
    all: () => ({ results: state.users.map((u) => ({ ...u })) }),
    run: (sql, params) => {
      calls.push({ sql, params });
      const row = state.users.find((u) => u.id === params[params.length - 1]);
      if (row && /^UPDATE/.test(sql)) {
        const set = sql.slice(sql.indexOf('SET') + 4, sql.indexOf('WHERE'));
        [...set.matchAll(/"([^"]+)"/g)].forEach((m, i) => {
          row[m[1]] = params[i];
        });
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  return { state, calls, db };
}

class SaveUser extends Model {
  static table = 'users';
  static fillable = ['name', 'email'];
}
SaveUser.now = () => '2023-11-14 22:13:20';

test('Model save() on an unchanged model writes nothing and returns true', async () => {
  // Eloquent's `save()` only writes when the model is dirty (`Model.php:1425`).
  const { state, calls, db } = usersFixture();
  const found = await SaveUser.find(db, 1);
  assert.equal(await found.save(db), true);
  assert.equal(calls.length, 0, 'an unchanged model issues no UPDATE');
  assert.equal(state.users[0].updated_at, '2024-01-01 00:00:00', 'updated_at is not bumped');
});

test('Model save() with an unchanged attribute is not dirty', async () => {
  // "Dirty" means "differs from the original" - setting the value the
  // attribute already has is not a change (`HasAttributes.php:2341`).
  const { state, calls, db } = usersFixture();
  const found = await SaveUser.find(db, 1);
  found.set('name', 'Ada');
  assert.equal(found.isDirty(), false);
  assert.equal(await found.save(db), true);
  assert.equal(calls.length, 0, 'an unchanged model issues no UPDATE');
  assert.equal(state.users[0].updated_at, '2024-01-01 00:00:00', 'updated_at is not bumped');
});

test('Model save() on a changed model updates the row and bumps updated_at', async () => {
  const { state, calls, db } = usersFixture();
  const found = await SaveUser.find(db, 1);
  found.set('name', 'Grace');
  assert.equal(found.isDirty(), true);
  assert.equal(await found.save(db), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, 'UPDATE "users" SET "name" = ?, "updated_at" = ? WHERE "id" = ?');
  assert.deepEqual(calls[0].params, ['Grace', '2023-11-14 22:13:20', 1]);
  assert.equal(state.users[0].name, 'Grace');
  assert.equal(state.users[0].updated_at, '2023-11-14 22:13:20');
});

test('Model save() on a new model inserts both timestamps and returns true', async () => {
  const calls = [];
  const db = mockDb({
    run: (sql, params) => {
      calls.push({ sql, params });
      return { success: true, meta: { changes: 1, last_row_id: 7 } };
    },
  });
  const user = new SaveUser();
  user.fill({ name: 'Grace', email: 'grace@example.com' });
  assert.equal(await user.save(db), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, 'INSERT INTO "users" ("name", "email", "created_at", "updated_at") VALUES (?, ?, ?, ?)');
  assert.deepEqual(calls[0].params, ['Grace', 'grace@example.com', '2023-11-14 22:13:20', '2023-11-14 22:13:20']);
  assert.equal(user.get('id'), 7);
});

test('DB.table alias works', () => {
  assert.equal(typeof DB.table, 'function');
  assert.ok(new QueryBuilder(mockDb(), 'x') instanceof QueryBuilder);
});

test('orWhere / orWhereIn / orWhereNull render flat OR', () => {
  const b = table(mockDb(), 't')
    .where('a', 1)
    .orWhere('b', 2)
    .orWhereIn('c', [3, 4])
    .orWhereNull('d');
  const { sql, params } = b.toSql();
  assert.equal(sql, 'SELECT * FROM "t" WHERE "a" = ? OR "b" = ? OR "c" IN (?, ?) OR "d" IS NULL');
  assert.deepEqual(params, [1, 2, 3, 4]);
});

test('whereGroup nests with parentheses', () => {
  const { sql, params } = table(mockDb(), 't')
    .where('a', 1)
    .orWhereGroup((q) => q.where('x', 10).where('y', 20))
    .toSql();
  assert.equal(sql, 'SELECT * FROM "t" WHERE "a" = ? OR ("x" = ? AND "y" = ?)');
  assert.deepEqual(params, [1, 10, 20]);
});

test('whereBetween / whereNotBetween / whereNotIn / whereLike / whereColumn', () => {
  const a = table(mockDb(), 't').whereBetween('age', [18, 30]).toSql();
  assert.equal(a.sql, 'SELECT * FROM "t" WHERE "age" BETWEEN ? AND ?');
  assert.deepEqual(a.params, [18, 30]);

  const b = table(mockDb(), 't').whereNotBetween('age', [18, 30]).toSql();
  assert.equal(b.sql, 'SELECT * FROM "t" WHERE "age" NOT BETWEEN ? AND ?');

  const c = table(mockDb(), 't').whereNotIn('id', [1, 2]).toSql();
  assert.equal(c.sql, 'SELECT * FROM "t" WHERE "id" NOT IN (?, ?)');
  assert.deepEqual(c.params, [1, 2]);

  const d = table(mockDb(), 't').whereLike('name', 'A%').toSql();
  assert.equal(d.sql, 'SELECT * FROM "t" WHERE "name" LIKE ?');
  assert.deepEqual(d.params, ['A%']);

  const e = table(mockDb(), 't').whereColumn('a', '>', 'b').toSql();
  assert.equal(e.sql, 'SELECT * FROM "t" WHERE "a" > "b"');
  assert.deepEqual(e.params, []);
});

test('whereRaw binds and keeps order', () => {
  const { sql, params } = table(mockDb(), 't').where('a', 1).whereRaw('LOWER("x") = ?', ['y']).toSql();
  assert.equal(sql, 'SELECT * FROM "t" WHERE "a" = ? AND LOWER("x") = ?');
  assert.deepEqual(params, [1, 'y']);
});

test('join / leftJoin render ON clause', () => {
  const { sql } = table(mockDb(), 'posts')
    .select('posts.id', 'users.name')
    .join('users', 'users.id', '=', 'posts.user_id')
    .leftJoin('tags', 'tags.post_id', '=', 'posts.id')
    .toSql();
  assert.equal(sql, 'SELECT "posts"."id", "users"."name" FROM "posts" INNER JOIN "users" ON "users"."id" = "posts"."user_id" LEFT JOIN "tags" ON "tags"."post_id" = "posts"."id"');
});

test('selectRaw / groupBy / having / distinct', () => {
  const { sql, params } = table(mockDb(), 'orders')
    .selectRaw('customer_id, COUNT(*) AS n', [])
    .groupBy('customer_id')
    .having('n', '>', 5)
    .distinct()
    .toSql();
  assert.equal(sql, 'SELECT DISTINCT customer_id, COUNT(*) AS n FROM "orders" GROUP BY "customer_id" HAVING "n" > ?');
  assert.deepEqual(params, [5]);
});

test('selectRaw params precede where params', () => {
  const { sql, params } = table(mockDb(), 't').selectRaw('COALESCE(?, "x") AS v', ['d']).where('a', 1).toSql();
  assert.equal(sql, 'SELECT COALESCE(?, "x") AS v FROM "t" WHERE "a" = ?');
  assert.deepEqual(params, ['d', 1]);
});

test('orderByDesc / latest / oldest', () => {
  assert.equal(table(mockDb(), 't').orderByDesc('id').toSql().sql, 'SELECT * FROM "t" ORDER BY "id" DESC');
  assert.equal(table(mockDb(), 't').latest().toSql().sql, 'SELECT * FROM "t" ORDER BY "created_at" DESC');
  assert.equal(table(mockDb(), 't').oldest('id').toSql().sql, 'SELECT * FROM "t" ORDER BY "id" ASC');
});

test('exists / value / pluck', async () => {
  const db = mockDb({
    first: (sql) => (/SELECT 1 AS "e"/.test(sql) ? { e: 1 } : { id: 7 }),
    all: () => ({ results: [{ id: 1 }, { id: 2 }] }),
  });
  assert.equal(await table(db, 't').where('a', 1).exists(), true);
  assert.equal(await table(db, 't').value('id'), 7);
  assert.deepEqual(await table(db, 't').pluck('id'), [1, 2]);
});

class RelModel extends Model {
  static table = 'users';
  static fillable = ['name', 'role', 'score'];
}
class Owner extends Model {
  static table = 'owners';
  static fillable = ['name'];
}
class Pet extends Model {
  static table = 'pets';
  static fillable = ['owner_id', 'name'];
}

test('Model relations: hasMany / hasOne / belongsTo (default FK)', async () => {
  const db = mockDb({
    all: (sql, params) => {
      if (/FROM "pets"/.test(sql)) {
        return { results: params[0] === 1 ? [{ id: 10, owner_id: 1, name: 'Rex' }, { id: 11, owner_id: 1, name: 'Mia' }] : [] };
      }
      if (/FROM "owners"/.test(sql)) return { results: [{ id: 1, name: 'Ada' }] };
      return { results: [] };
    },
  });
  const owner = new Owner({ id: 1, name: 'Ada' });
  const pets = await owner.hasMany(db, Pet, 'owner_id');
  assert.equal(pets.length, 2);
  assert.ok(pets[0] instanceof Pet);
  assert.equal(pets[0].get('name'), 'Rex');

  const one = await owner.hasOne(db, Pet, 'owner_id');
  assert.ok(one instanceof Pet);

  const pet = new Pet({ id: 10, owner_id: 1 });
  const back = await pet.belongsTo(db, Owner);
  assert.ok(back instanceof Owner);
  assert.equal(back.get('name'), 'Ada');
});

test('Model firstOrCreate / updateOrCreate', async () => {
  const state = { rows: [{ id: 1, name: 'Ada', role: 'admin' }] };
  const db = mockDb({
    all: (sql, params) => ({ results: state.rows.filter((r) => r.name === params[0]) }),
    run: (sql, params) => {
      if (/^INSERT/.test(sql)) {
        const row = { id: state.rows.length + 1, name: params[0], role: params[1] };
        state.rows.push(row);
        return { success: true, meta: { changes: 1, last_row_id: row.id } };
      }
      if (/^UPDATE/.test(sql)) {
        const r = state.rows.find((x) => x.id === params[params.length - 1]);
        if (r) r.role = params[0];
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
  });

  const existing = await RelModel.firstOrCreate(db, { name: 'Ada' }, { role: 'admin' });
  assert.equal(existing.get('id'), 1);
  assert.equal(existing.get('role'), 'admin');

  const created = await RelModel.firstOrCreate(db, { name: 'Zed' }, { role: 'user' });
  assert.equal(created.exists, true);
  assert.equal(created.get('name'), 'Zed');

  const updated = await RelModel.updateOrCreate(db, { name: 'Ada' }, { role: 'root' });
  assert.equal(updated.get('role'), 'root');
});

test('Model refresh / increment', async () => {
  const db = mockDb({
    all: () => ({ results: [{ id: 1, name: 'Fresh', score: 5 }] }),
    run: () => ({ success: true, meta: { changes: 1 } }),
  });
  const m = new RelModel({ id: 1, name: 'Stale', score: 4 });
  await m.refresh(db);
  assert.equal(m.get('name'), 'Fresh');
  // Laravel's increment() answers the affected-row count (not the new value)
  // and writes ONE atomic statement - it does not touch updated_at.
  const changed = await m.increment(db, 'score', 2);
  assert.equal(changed, 1);
  assert.equal(m.get('score'), 7);
});

test('where(fn) nests a group (Laravel closure grouping)', () => {
  const { sql, params } = table(mockDb(), 'posts')
    .where('active', true)
    .where((q) => q.where('a', 1).orWhere('b', 2))
    .orWhere((q) => q.where('c', 3))
    .toSql();
  assert.equal(sql, 'SELECT * FROM "posts" WHERE "active" = ? AND ("a" = ? OR "b" = ?) OR ("c" = ?)');
  assert.deepEqual(params, [true, 1, 2, 3]);
});

test('whereDate / whereYear / whereMonth / whereDay / whereTime', () => {
  assert.equal(
    table(mockDb(), 't').whereDate('created_at', '2026-01-02').toSql().sql,
    'SELECT * FROM "t" WHERE date("created_at") = CAST(? AS TEXT)'
  );
  assert.equal(
    table(mockDb(), 't').whereYear('created_at', '>', 2025).toSql().sql,
    'SELECT * FROM "t" WHERE strftime(\'%Y\', "created_at") > CAST(? AS TEXT)'
  );
  assert.equal(
    table(mockDb(), 't').whereMonth('created_at', 3).toSql().sql,
    'SELECT * FROM "t" WHERE strftime(\'%m\', "created_at") = CAST(? AS TEXT)'
  );
  assert.equal(
    table(mockDb(), 't').whereDay('created_at', 9).toSql().sql,
    'SELECT * FROM "t" WHERE strftime(\'%d\', "created_at") = CAST(? AS TEXT)'
  );
  assert.equal(
    table(mockDb(), 't').whereTime('created_at', '12:00:00').toSql().sql,
    'SELECT * FROM "t" WHERE time("created_at") = CAST(? AS TEXT)'
  );
});

test('aggregates sum/avg/min/max read the aggregate column', async () => {
  const db = mockDb({ first: () => ({ aggregate: 12.5 }) });
  assert.equal(await table(db, 't').sum('amount'), 12.5);
  assert.equal(await table(db, 't').avg('amount'), 12.5);
  assert.equal(await table(db, 't').min('amount'), 12.5);
  assert.equal(await table(db, 't').max('amount'), 12.5);
  const nullDb = mockDb({ first: () => ({ aggregate: null }) });
  assert.equal(await table(nullDb, 't').sum('amount'), null);
});

test('upsert builds ON CONFLICT DO UPDATE / DO NOTHING', async () => {
  const calls = [];
  const db = mockDb({ run: (sql, params) => { calls.push({ sql, params }); return { success: true, meta: { changes: 2 } }; } });
  const r = await table(db, 'users').upsert([{ id: 1, name: 'A' }, { id: 2, name: 'B' }], ['id'], ['name']);
  assert.equal(r.changes, 2);
  assert.equal(calls[0].sql, 'INSERT INTO "users" ("id", "name") VALUES (?, ?), (?, ?) ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name"');
  assert.deepEqual(calls[0].params, [1, 'A', 2, 'B']);
  await table(db, 'users').upsert({ id: 1, name: 'A' }, 'id', []);
  assert.equal(calls[1].sql, 'INSERT INTO "users" ("id", "name") VALUES (?, ?) ON CONFLICT ("id") DO NOTHING');
});

test('insertGetId / truncate / increment / decrement', async () => {
  const calls = [];
  const db = mockDb({ run: (sql, params) => { calls.push({ sql, params }); return { success: true, meta: { changes: 1, last_row_id: 9 } }; } });
  assert.equal(await table(db, 't').insertGetId({ name: 'A' }), 9);
  assert.match(calls[0].sql, /^INSERT INTO "t"/);
  const tr = await table(db, 't').truncate();
  assert.equal(tr.success, true);
  assert.equal(calls[1].sql, 'DELETE FROM "t"');
  await table(db, 't').where('id', 3).increment('views', 2);
  assert.equal(calls[2].sql, 'UPDATE "t" SET "views" = "views" + ? WHERE "id" = ?');
  assert.deepEqual(calls[2].params, [2, 3]);
  await table(db, 't').where('id', 3).decrement('views', 2);
  assert.deepEqual(calls[3].params, [-2, 3]);
});

test('updateOrInsert updates when found, inserts otherwise', async () => {
  const calls = [];
  let found = { id: 1, name: 'A' };
  const db = mockDb({
    all: () => (found ? { results: [{ ...found }] } : { results: [] }),
    run: (sql, params) => { calls.push({ sql, params }); return { success: true, meta: { changes: 1, last_row_id: 5 } }; },
  });
  const upd = await table(db, 't').updateOrInsert({ id: 1 }, { name: 'B' });
  assert.equal(upd.changes, 1);
  assert.match(calls[0].sql, /^UPDATE "t" SET "name" = \? WHERE "id" = \?$/);
  assert.deepEqual(calls[0].params, ['B', 1]);

  found = null;
  await table(db, 't').updateOrInsert({ id: 2 }, { name: 'C' });
  assert.match(calls[1].sql, /^INSERT INTO "t" \("id", "name"\) VALUES \(\?, \?\)$/);
  assert.deepEqual(calls[1].params, [2, 'C']);
});

test('chunk paginates until exhausted', async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const db = mockDb({
    all: (sql, params) => {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { results: rows.slice(offset, offset + limit) };
    },
  });
  const seen = [];
  await table(db, 't').chunk(2, (batch, page) => { seen.push([page, batch.length]); });
  assert.deepEqual(seen, [[1, 2], [2, 1]]);
});

class CastModel extends Model {
  static table = 'items';
  static fillable = ['name', 'meta', 'price', 'secret', 'first_name'];
  static casts = { meta: 'json', price: 'decimal:2', secret: 'int' };
  static hidden = ['secret'];
  static appends = ['label'];
  getLabelAttribute() { return (this.attributes.name || '') + '!'; }
  getFirstNameAttribute(value) { return String(value || '').toUpperCase(); }
  setFirstNameAttribute(value) { return String(value).trim(); }
}

class SoftModel extends Model {
  static table = 'notes';
  static fillable = ['title'];
  static softDeletes = true;
}

test('Model casts, accessors/mutators, hidden/visible/appends', () => {
  const m = new CastModel({ id: 1, name: 'Ada', meta: '{"a":1}', price: '3.5', secret: 7, first_name: 'ada' });
  assert.deepEqual(m.get('meta'), { a: 1 });
  assert.equal(m.get('price'), '3.50');
  assert.equal(m.get('secret'), 7);
  assert.equal(m.get('first_name'), 'ADA');
  m.set('first_name', '  grace ');
  assert.equal(m.attributes.first_name, 'grace');
  const json = m.toJSON();
  assert.equal(Object.prototype.hasOwnProperty.call(json, 'secret'), false);
  assert.equal(json.label, 'Ada!');
  assert.deepEqual(json.meta, { a: 1 });
  assert.equal(json.price, '3.50');
});

class HashedModel extends Model {
  static table = 'users';
  static fillable = ['name', 'password'];
  static casts = { password: 'hashed' };
  static hashRounds = 12;
}

class HashedLowCostModel extends Model {
  static table = 'users';
  static fillable = ['password'];
  static casts = { password: 'hashed' };
  static hashRounds = 4;
}

test('Model fillable blocks non-fillable mass assignment', () => {
  const m = new HashedModel();
  m.fill({ name: 'Ada', password: null, is_admin: true });
  assert.equal(m.attributes.name, 'Ada');
  assert.equal(Object.prototype.hasOwnProperty.call(m.attributes, 'password'), true);
  assert.equal(m.attributes.password, null);
  assert.equal(Object.prototype.hasOwnProperty.call(m.attributes, 'is_admin'), false);
  // forceFill bypasses the guard (Eloquent parity).
  m.forceFill({ is_admin: true });
  assert.equal(m.attributes.is_admin, true);
});

test('Model hashed cast hashes plaintext at set-time with $2y$', async () => {
  const m = new HashedLowCostModel();
  m.set('password', 'secret');
  assert.equal(m.attributes.password.slice(0, 7), '$2y$04$');
  assert.equal(m.attributes.password.length, 60);
  assert.equal(await check('secret', m.attributes.password), true);
  assert.equal(await check('wrong', m.attributes.password), false);

  // fill()/create() go through set(), so the cast applies there too.
  const filled = new HashedLowCostModel();
  filled.fill({ password: 'hunter2' });
  assert.equal(filled.attributes.password.slice(0, 7), '$2y$04$');
  assert.equal(await check('hunter2', filled.attributes.password), true);
});

test('Model hashed cast passes through valid bcrypt cost <= rounds', async () => {
  const m = new HashedModel();
  m.set('password', HASH10);
  assert.equal(m.attributes.password, HASH10);
  m.set('password', HASH12);
  assert.equal(m.attributes.password, HASH12);
});

test('Model hashed cast rejects cost > rounds with RuntimeException', () => {
  const m = new HashedModel();
  assert.throws(
    () => m.set('password', HASH14),
    (err) =>
      err.name === 'RuntimeException' &&
      err.phpClass === 'RuntimeException' &&
      err.message === "Could not verify the hashed value's configuration."
  );
});

test('Model hashed cast re-hashes $2a$/$2b$/truncated $2y$ like PHP 8.3', async () => {
  // PHP's password_get_info() reports algo=null for these, so Laravel's
  // Hash::isHashed() is false and the cast hashes the digest string itself.
  const m = new HashedLowCostModel();
  m.set('password', HASH12_A);
  assert.notEqual(m.attributes.password, HASH12_A);
  assert.equal(m.attributes.password.slice(0, 7), '$2y$04$');
  assert.equal(await check(HASH12_A, m.attributes.password), true);

  m.set('password', SHORT_2Y);
  assert.notEqual(m.attributes.password, SHORT_2Y);
  assert.equal(await check(SHORT_2Y, m.attributes.password), true);
});

test('Model hashed cast rejects argon2 (bcrypt-only verifier)', () => {
  const m = new HashedModel();
  assert.throws(
    () => m.set('password', ARGON),
    /Could not verify the hashed value's configuration\./
  );
});

test('Model hashed cast null/empty behavior and mutator priority', async () => {
  const m = new HashedModel();
  m.set('password', null);
  assert.equal(m.attributes.password, null);
  m.set('password', undefined);
  assert.equal(m.attributes.password, null);
  m.set('password', '');
  assert.equal(m.attributes.password.slice(0, 7), '$2y$12$');
  assert.equal(await check('', m.attributes.password), true);

  class MutatorModel extends Model {
    static table = 'users';
    static fillable = ['password'];
    static casts = { password: 'hashed' };
    static hashRounds = 12;
    setPasswordAttribute(value) {
      return 'mutated:' + value;
    }
  }
  const mm = new MutatorModel();
  mm.set('password', 'secret');
  assert.equal(mm.attributes.password, 'mutated:secret');
});

test('Model constructor bypasses casts (DB hydration parity)', () => {
  // Documented divergence: Eloquent's constructor uses setRawAttributes(), so
  // rows loaded from D1 must not be re-hashed. fill()/create()/update() apply casts.
  const m = new HashedModel({ password: 'plain' });
  assert.equal(m.attributes.password, 'plain');
  assert.notEqual(m.attributes.password.slice(0, 7), '$2y$12$');
});

test('makeSync is deterministic in shape and model uses configured rounds', async () => {
  const a = makeSync('x', { rounds: 4 });
  const b = makeSync('x', { rounds: 4 });
  assert.equal(a.slice(0, 7), '$2y$04$');
  assert.equal(b.slice(0, 7), '$2y$04$');
  assert.notEqual(a, b);
  const m = new HashedLowCostModel();
  m.set('password', 'x');
  assert.equal(m.attributes.password.slice(0, 7), '$2y$04$');
});


test('Model json cast is stored as a string', async () => {
  const calls = [];
  const db = mockDb({ run: (sql, params) => { calls.push({ sql, params }); return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });
  await CastModel.create(db, { name: 'A', meta: { a: 1 } });
  assert.equal(calls[0].sql.startsWith('INSERT INTO "items"'), true);
  assert.notEqual(calls[0].params.indexOf('{"a":1}'), -1);
});

test('Model softDeletes: query filters, delete stamps, restore clears, forceDelete removes', async () => {
  const calls = [];
  const db = mockDb({
    all: () => ({ results: [] }),
    run: (sql, params) => { calls.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
  });
  assert.equal(SoftModel.query(db).toSql().sql, 'SELECT * FROM "notes" WHERE "deleted_at" IS NULL');
  assert.equal(SoftModel.withTrashed(db).toSql().sql, 'SELECT * FROM "notes"');
  assert.equal(SoftModel.onlyTrashed(db).toSql().sql, 'SELECT * FROM "notes" WHERE "deleted_at" IS NOT NULL');

  const m = new SoftModel({ id: 1, title: 'A' });
  assert.equal(m.trashed(), false);
  await m.delete(db);
  assert.equal(m.trashed(), true);
  // Laravel's runSoftDelete() (SoftDeletes.php:141-152) writes deleted_at AND
  // updated_at - the row's timestamp is the delete time.
  assert.match(calls[0].sql, /"deleted_at" = \?/);
  assert.match(calls[0].sql, /"updated_at" = \?/);
  await m.restore(db);
  assert.equal(m.trashed(), false);
  // The restore writes through save(): deleted_at = null and a fresh
  // updated_at.
  assert.equal(calls[1].params[0], null);
  assert.equal(calls[1].params[calls[1].params.length - 1], 1);
  await m.forceDelete(db);
  assert.equal(calls[2].sql, 'DELETE FROM "notes" WHERE "id" = ?');
  assert.equal(m.exists, false);
});

test('Model findOrFail / firstOrFail', async () => {
  const hit = mockDb({ all: () => ({ results: [{ id: 1, name: 'A' }] }) });
  const miss = mockDb({ all: () => ({ results: [] }) });
  assert.equal((await RelModel.findOrFail(hit, 1)).get('id'), 1);
  await assert.rejects(() => RelModel.findOrFail(miss, 9), /not found/);
  assert.equal((await RelModel.firstOrFail(hit)).get('id'), 1);
  await assert.rejects(() => RelModel.firstOrFail(miss), /not found/);
});

// Table-aware mock: routes `all`/`first` to a store keyed by table name.
function tableDb(store) {
  return {
    prepare(sql) {
      const pick = () => {
        for (const name of Object.keys(store)) if (sql.includes('"' + name + '"')) return store[name];
        return [];
      };
      return {
        params: [],
        bind(...p) {
          this.params = p;
          return this;
        },
        async all() { return { results: pick() }; },
        async first() { return pick()[0] || null; },
        async run() { return { success: true, meta: { changes: 1, last_row_id: 1 } }; },
      };
    },
  };
}

test('Model with() eager-loads declared hasMany relations', async () => {
  class Comment extends Model {}
  Comment.table = 'comments';
  class Post extends Model {}
  Post.table = 'posts';
  Post.relations = { comments: { type: 'hasMany', model: Comment } };
  const db = tableDb({
    posts: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }],
    comments: [{ id: 10, post_id: 1, body: 'x' }, { id: 11, post_id: 1, body: 'y' }, { id: 12, post_id: 2, body: 'z' }],
  });
  const posts = await Post.query(db).with('comments').get();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].getRelation('comments').map((c) => c.get('body')), ['x', 'y']);
  assert.deepEqual(posts[1].getRelation('comments').map((c) => c.get('body')), ['z']);
  assert.deepEqual(posts[0].toJSON().comments.map((c) => c.id), [10, 11]);
});

test('Model with() eager-loads belongsTo via default foreign key', async () => {
  class Author extends Model {}
  Author.table = 'authors';
  class Book extends Model {}
  Book.table = 'books';
  Book.relations = { author: { type: 'belongsTo', model: Author } };
  const db = tableDb({
    books: [{ id: 1, author_id: 7 }, { id: 2, author_id: 8 }, { id: 3, author_id: 9 }],
    authors: [{ id: 7, name: 'Ada' }, { id: 8, name: 'Bob' }],
  });
  const books = await Book.query(db).with('author').get();
  assert.equal(books[0].getRelation('author').get('name'), 'Ada');
  assert.equal(books[1].getRelation('author').get('name'), 'Bob');
  assert.equal(books[2].getRelation('author'), null);
});

test('Model with() eager-loads hasOne as a single row', async () => {
  class Profile extends Model {}
  Profile.table = 'profiles';
  class User extends Model {}
  User.table = 'users';
  User.relations = { profile: { type: 'hasOne', model: Profile } };
  const db = tableDb({
    users: [{ id: 1 }, { id: 2 }],
    profiles: [{ id: 5, user_id: 1, bio: 'hi' }],
  });
  const users = await User.query(db).with('profile').get();
  assert.equal(users[0].getRelation('profile').get('bio'), 'hi');
  assert.equal(users[1].getRelation('profile'), null);
});

test('Model related()/load() resolve declared relations lazily', async () => {
  class Comment extends Model {}
  Comment.table = 'comments';
  class Post extends Model {}
  Post.table = 'posts';
  Post.relations = { comments: { type: 'hasMany', model: Comment } };
  const db = tableDb({ posts: [{ id: 1 }], comments: [{ id: 10, post_id: 1 }] });
  const p = new Post({ id: 1 });
  assert.equal(p.relationLoaded('comments'), false);
  const rel = await p.related(db, 'comments');
  assert.deepEqual(rel.map((c) => c.get('id')), [10]);
  assert.equal(p.relationLoaded('comments'), true);
  await assert.rejects(() => p.related(db, 'nope'), /unknown relation/);
  const p2 = new Post({ id: 1 });
  await p2.load(db, 'comments');
  assert.equal(p2.relationLoaded('comments'), true);
});

test('Model with() rejects unknown relations', async () => {
  class Thing extends Model {}
  Thing.table = 'things';
  const db = tableDb({ things: [{ id: 1 }] });
  await assert.rejects(() => Thing.query(db).with('nope').get(), /unknown relation/);
});

test('Model query().scope() runs local scopes', async () => {
  class PostScope extends Model {}
  PostScope.table = 'posts';
  PostScope.prototype.scopePublished = (q) => q.where('published', 1);
  const db = tableDb({ posts: [] });
  const { sql, params } = PostScope.query(db).scope('published').toSql();
  assert.match(sql, /"published" = \?/);
  assert.deepEqual(params, [1]);
  assert.throws(() => PostScope.query(db).scope('nope'), /unknown scope/);
});

test('whereExists with correlated column equality', () => {
  const { sql, params } = table(mockDb(), 'users')
    .whereExists((q) => q.from('posts').selectRaw('1').whereColumn('posts.user_id', 'users.id'))
    .toSql();
  assert.match(sql, /where exists/i);
  assert.match(sql, /select 1 from "posts"/i);
  assert.match(sql, /"posts"\."user_id" = "users"\."id"/);
  assert.equal(params.length, 0);
});

test('whereNotExists with numeric bound merges params', () => {
  const { sql, params } = table(mockDb(), 'users')
    .where('active', 1)
    .whereNotExists((q) => q.from('posts').where('posts.user_id', 99))
    .toSql();
  assert.match(sql, /not exists/i);
  assert.deepEqual(params, [1, 99]);
});

test('orWhereExists variant renders OR EXISTS', () => {
  const { sql, params } = table(mockDb(), 'users')
    .where('a', 1)
    .orWhereExists((q) => q.from('posts').where('x', 2))
    .toSql();
  assert.match(sql, / or exists /i);
  assert.deepEqual(params, [1, 2]);
});

test('whereExists throws on non-function argument', () => {
  assert.throws(() => table(mockDb(), 't').whereExists('nope'), /expects a function/);
  assert.throws(() => table(mockDb(), 't').whereNotExists(null), /expects a function/);
});

test('union of two simple selects concatenates sql and params', () => {
  const q1 = table(mockDb(), 'users').select('id').where('active', 1);
  const q2 = table(mockDb(), 'admins').select('id').where('role', 'admin');
  const { sql, params } = q1.union(q2).toSql();
  assert.match(sql, /union/i);
  assert.match(sql, /\(SELECT "id" FROM "users"/);
  assert.match(sql, /\(SELECT "id" FROM "admins"/);
  assert.deepEqual(params, [1, 'admin']);
});

test('unionAll variant uses UNION ALL and supports chaining', () => {
  const q1 = table(mockDb(), 'a').select('id').where('x', 1);
  const q2 = table(mockDb(), 'b').select('id').where('y', 2);
  const q3 = table(mockDb(), 'c').select('id').where('z', 3);
  const { sql, params } = q1.unionAll(q2).union(q3).toSql();
  assert.match(sql, /union all/i);
  assert.match(sql, /union/i);
  assert.deepEqual(params, [1, 2, 3]);
});

test('union throws on non-QueryBuilder', () => {
  assert.throws(() => table(mockDb(), 't').union('nope'), /expects a QueryBuilder/);
  assert.throws(() => table(mockDb(), 't').unionAll(123), /expects a QueryBuilder/);
});

test('the model shim fails loud on a relation attribute (a relation is not compiled)', () => {
  class M extends Model {}
  M.notCompiled = ['comments'];
  const m = new M({ id: 1, title: 'x' });
  assert.throws(() => m.get('comments'), /not compiled/);
  assert.equal(m.get('title'), 'x');
});

test('where(col, null) is a where-null clause (Laravel: IS NULL, never `= NULL`)', () => {
  // Laravel's where() (Query/Builder.php:988-991): a NULL value is not a
  // comparison - `col = NULL` matches no row - it is `IS NULL`, and '!=' /
  // '<>' make it `IS NOT NULL`.
  let sql = null;
  const db = mockDb({ all: (s) => { sql = s; return { results: [] }; } });
  table(db, 'posts').where('deleted_at', null).get();
  assert.match(sql, /"deleted_at" IS NULL/);
  sql = null;
  table(db, 'posts').where('deleted_at', '=', null).get();
  assert.match(sql, /"deleted_at" IS NULL/);
  sql = null;
  table(db, 'posts').where('deleted_at', '!=', null).get();
  assert.match(sql, /"deleted_at" IS NOT NULL/);
  sql = null;
  table(db, 'posts').where('deleted_at', '<>', null).get();
  assert.match(sql, /"deleted_at" IS NOT NULL/);
  // An operator that cannot compare with NULL is an illegal combination
  // (Laravel's invalidOperatorAndValue: a NULL value with an operator outside
  // ['=', '<=>', '<>', '!=']).
  assert.throws(
    () => table(db, 'posts').where('deleted_at', '>', null),
    /Illegal operator and value combination/,
  );
  // '<=>' is one of Laravel's operators: with a NULL value it is IS NULL.
  sql = null;
  table(db, 'posts').where('deleted_at', '<=>', null).get();
  assert.match(sql, /"deleted_at" IS NULL/);
  // 'IS'/'IS NOT' are operators too (Laravel's $operators): with a value they
  // render `col IS ?` (SQLite supports it), with NULL they are an illegal
  // combination.
  sql = null;
  table(db, 'posts').where('deleted_at', 'IS', 5).get();
  assert.match(sql, /"deleted_at" IS \?/);
  assert.throws(
    () => table(db, 'posts').where('deleted_at', 'IS', null),
    /Illegal operator and value combination/,
  );
});

test('the model casts are PHP\'s casts (probed against PHP 8.3)', () => {
  // PHP's casts, probed:
  //   (bool) 'false' = true, '0' = false, '' = false, '0.0' = true
  //   (int) '12abc' = 12, 'abc' = 0, '1.9' = 1, '1e3' = 1000
  //   the decimal cast: BigDecimal::of($v)->toScale(2, HALF_UP) - the rounding
  //   happens on the DECIMAL string ('2.675' -> '2.68', where toFixed() says
  //   '2.67')
  class M extends Model {}
  M.casts = { b: 'bool', i: 'int', f: 'float', d: 'decimal:2', t: 'timestamp' };
  const m = new M({ b: 'false', i: '12abc', f: '1.9', d: '2.675', t: '2026-01-02 03:04:05' });
  assert.equal(m.get('b'), true);
  assert.equal(m.get('i'), 12);
  assert.equal(m.get('f'), 1.9);
  assert.equal(m.get('d'), '2.68');
  assert.equal(m.get('t'), 1767323045);
  const m2 = new M({ b: '0', i: 'abc', d: '-2.675' });
  assert.equal(m2.get('b'), false);
  assert.equal(m2.get('i'), 0);
  assert.equal(m2.get('d'), '-2.68');
  const m3 = new M({ b: '0.0', i: '1e3', d: '1.005' });
  assert.equal(m3.get('b'), true);
  assert.equal(m3.get('i'), 1000);
  assert.equal(m3.get('d'), '1.01');
});

test('the model JSON serialises the date attributes like Carbon (ISO-8601)', () => {
  // Laravel serialises the timestamps (and the date casts) through
  // Carbon::toJSON() -> '2024-01-01T00:00:00.000000Z' (the model's JSON is
  // what a response carries).
  class M extends Model {}
  M.casts = { published_at: 'datetime' };
  const m = new M({
    id: 1,
    title: 'A',
    created_at: '2024-01-01 00:00:00',
    updated_at: '2024-01-02 03:04:05',
    published_at: '2024-01-03 00:00:00',
  });
  const json = m.toJSON();
  assert.equal(json.created_at, '2024-01-01T00:00:00.000000Z');
  assert.equal(json.updated_at, '2024-01-02T03:04:05.000000Z');
  assert.equal(json.published_at, '2024-01-03T00:00:00.000000Z');
  assert.equal(json.title, 'A');
});

test('the model flags a fresh insert (Laravel\'s wasRecentlyCreated)', async () => {
  // Laravel sets $wasRecentlyCreated in the insert paths (performInsert /
  // insertAndSetId), so a controller that returns a model it just saved
  // answers 201 (Router::toResponse).
  const db = mockDb({ run: () => ({ success: true, meta: { changes: 1, last_row_id: 7 } }) });
  const fresh = new RelModel({ title: 'A' });
  assert.equal(fresh.wasRecentlyCreated, false);
  await fresh.save(db);
  assert.equal(fresh.wasRecentlyCreated, true);
  const existing = new RelModel({ id: 1, title: 'A' });
  await existing.save(db);
  assert.equal(existing.wasRecentlyCreated, false, 'an update is not a fresh insert');
});
