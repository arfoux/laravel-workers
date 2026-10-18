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
  const next = await m.increment(db, 'score', 2);
  assert.equal(next, 7);
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
  assert.match(calls[0].sql, /^UPDATE "notes" SET "deleted_at" = \? WHERE "id" = \?$/);
  await m.restore(db);
  assert.equal(m.trashed(), false);
  assert.deepEqual(calls[1].params, [null, 1]);
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
