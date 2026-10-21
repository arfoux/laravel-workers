// Real-SQL end-to-end checks: run the kernel query builder + Model layer against
// an in-memory SQLite (`node:sqlite`, Node >= 22) through a small D1-shaped
// adapter. This is the closest local stand-in for Cloudflare D1 and it verifies
// the generated SQL actually executes (joins, EXISTS subqueries, whereIn, soft
// deletes) instead of only string-matching it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { table } from '../db.mjs';
import { Model } from '../model.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: the suite still runs, these tests skip.
}
const skip = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

// Minimal D1-shaped wrapper: prepare().bind().all()/first()/run().
function d1(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) {
          params = p;
          return this;
        },
        async all() {
          const st = sqlite.prepare(sql);
          const rows = params.length ? st.all(...params) : st.all();
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
        async run() {
          const st = sqlite.prepare(sql);
          const info = params.length ? st.run(...params) : st.run();
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
    },
  };
}

class Comment extends Model {}
Comment.table = 'comments';
class Post extends Model {}
Post.table = 'posts';
Post.softDeletes = true;
Post.relations = { comments: { type: 'hasMany', model: Comment } };
Post.prototype.scopePublished = (q) => q.where('published', 1);
class Author extends Model {}
Author.table = 'authors';
class Book extends Model {}
Book.table = 'books';
Book.relations = { author: { type: 'belongsTo', model: Author } };
class Invoice extends Model {}
Invoice.table = 'invoices';
Invoice.fillable = ['amount', 'meta', 'paid', 'secret'];
Invoice.casts = { meta: 'json', amount: 'decimal:2', paid: 'boolean' };
Invoice.hidden = ['secret'];
Invoice.appends = ['label'];
Invoice.prototype.getLabelAttribute = function () {
  return 'inv-' + this.get('amount');
};
Invoice.prototype.setSecretAttribute = function (value) {
  return String(value).toUpperCase();
};

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, published INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER, body TEXT, votes INTEGER, deleted_at TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_id INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, amount TEXT, meta TEXT, paid INTEGER, secret TEXT, created_at TEXT, updated_at TEXT);
  `);
  sqlite.exec(`
    INSERT INTO posts (id, title, published, created_at) VALUES
      (1, 'a', 1, '2024-01-02 03:04:05'),
      (2, 'b', 0, '2024-02-03 04:05:06'),
      (3, 'c', 1, '2024-02-04 05:06:07');
    INSERT INTO posts (id, title, published, created_at, deleted_at) VALUES (4, 'd', 1, '2024-02-05 06:07:08', '2020-01-01 00:00:00');
    INSERT INTO comments (id, post_id, body, votes) VALUES (10, 1, 'x', 5), (11, 1, 'y', 3), (12, 2, 'z', 1);
    INSERT INTO authors (id, name) VALUES (7, 'Ada'), (8, 'Bob');
    INSERT INTO books (id, title, author_id) VALUES (1, 'b1', 7), (2, 'b2', 8), (3, 'b3', NULL);
    INSERT INTO invoices (id, amount, meta, paid, secret, created_at, updated_at)
      VALUES (1, '10.5', '{"a":1}', 1, 'x', '2024-01-01 00:00:00', '2024-01-01 00:00:00');
  `);
  return d1(sqlite);
}

const ids = (rows) => rows.map((r) => r.get('id'));

test('sqlite: eager loading runs real batch whereIn', { skip }, async () => {
  const db = fixture();
  const posts = await Post.query(db).orderBy('id').with('comments').get();
  assert.deepEqual(ids(posts), [1, 2, 3]);
  assert.deepEqual(posts[0].getRelation('comments').map((c) => c.get('body')), ['x', 'y']);
  assert.deepEqual(posts[1].getRelation('comments').map((c) => c.get('body')), ['z']);
  assert.deepEqual(posts[2].getRelation('comments'), []);
});

test('sqlite: belongsTo eager loading', { skip }, async () => {
  const db = fixture();
  const books = await Book.query(db).orderBy('id').with('author').get();
  assert.equal(books[0].getRelation('author').get('name'), 'Ada');
  assert.equal(books[1].getRelation('author').get('name'), 'Bob');
  assert.equal(books[2].getRelation('author'), null);
});

test('sqlite: whereHas / whereDoesntHave run correlated EXISTS', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(ids(await Post.query(db).orderBy('id').whereHas('comments').get()), [1, 2]);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').whereDoesntHave('comments').get()), [3]);
  assert.deepEqual(
    ids(await Post.query(db).orderBy('id').whereHas('comments', (q) => q.where('body', 'x')).get()),
    [1]
  );
  assert.deepEqual(ids(await Book.query(db).orderBy('id').whereHas('author').get()), [1, 2]);
  assert.deepEqual(ids(await Book.query(db).orderBy('id').doesntHave('author').get()), [3]);
});

test('sqlite: withCount exposes comments_count', { skip }, async () => {
  const db = fixture();
  const posts = await Post.query(db).orderBy('id').withCount('comments').get();
  assert.deepEqual(posts.map((p) => p.get('comments_count')), [2, 1, 0]);
  assert.deepEqual(posts.map((p) => p.toJSON().comments_count), [2, 1, 0]);
  const one = await Post.query(db).where('id', 1).withCount('comments').first();
  assert.equal(one.get('comments_count'), 2);
});

test('sqlite: soft deletes filter, withTrashed, restore, forceDelete', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(ids(await Post.query(db).orderBy('id').get()), [1, 2, 3]);
  assert.deepEqual(ids(await Post.withTrashed(db).orderBy('id').get()), [1, 2, 3, 4]);
  assert.deepEqual(ids(await Post.onlyTrashed(db).get()), [4]);
  const trashed = await Post.withTrashed(db).where('id', 4).first();
  await trashed.restore(db);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').get()), [1, 2, 3, 4]);
  await trashed.forceDelete(db);
  assert.deepEqual(ids(await Post.withTrashed(db).orderBy('id').get()), [1, 2, 3]);
});

test('sqlite: local scopes compose with real SQL', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(ids(await Post.query(db).orderBy('id').scope('published').get()), [1, 3]);
});

test('sqlite: Model.create/find/save/delete round-trip', { skip }, async () => {
  const db = fixture();
  const created = await Post.create(db, { title: 'new', published: 1 });
  assert.equal(created.get('id'), 5);
  const found = await Post.find(db, 5);
  assert.equal(found.get('title'), 'new');
  found.set('title', 'edited');
  await found.save(db);
  assert.equal((await Post.find(db, 5)).get('title'), 'edited');
  await found.delete(db);
  assert.equal(await Post.find(db, 5), null);
  assert.equal((await Post.withTrashed(db).where('id', 5).first()).get('title'), 'edited');
});

test('sqlite: builder joins + aggregates execute', { skip }, async () => {
  const db = fixture();
  const rows = await table(db, 'books')
    .join('authors', 'authors.id', '=', 'books.author_id')
    .where('authors.name', 'Ada')
    .get();
  assert.deepEqual(rows.map((r) => r.title), ['b1']);
  const agg = await table(db, 'comments').sum('id');
  assert.equal(Number(agg), 33);
});

test('sqlite: where(fn) grouping, whereIn/between/like/column/notIn', { skip }, async () => {
  const db = fixture();
  const grouped = await table(db, 'posts')
    .where((q) => q.where('published', 1).orWhere('id', 2))
    .whereNotIn('id', [3])
    .orderBy('id')
    .get();
  assert.deepEqual(grouped.map((r) => r.id), [1, 2, 4]);
  const ranged = await table(db, 'posts').whereBetween('id', [2, 3]).orderBy('id').get();
  assert.deepEqual(ranged.map((r) => r.id), [2, 3]);
  const liked = await table(db, 'posts').whereLike('title', 'b%').get();
  assert.deepEqual(liked.map((r) => r.id), [2]);
  const cols = await table(db, 'books').whereColumn('id', '<', 'author_id').orderBy('id').get();
  assert.deepEqual(cols.map((r) => r.id), [1, 2]);
});

test('sqlite: whereDate/whereYear/whereMonth/whereDay execute', { skip }, async () => {
  const db = fixture();
  const rid = async (b) => (await b.get()).map((r) => r.id);
  assert.deepEqual(await rid(table(db, 'posts').whereDate('created_at', '2024-02-03')), [2]);
  assert.deepEqual(await rid(table(db, 'posts').whereYear('created_at', 2024).orderBy('id')), [1, 2, 3, 4]);
  assert.deepEqual(await rid(table(db, 'posts').whereMonth('created_at', 2)), [2, 3, 4]);
  assert.deepEqual(await rid(table(db, 'posts').whereDay('created_at', 4)), [3]);
  assert.deepEqual(await rid(table(db, 'posts').whereDay('created_at', '05')), [4]);
  assert.deepEqual(await rid(table(db, 'posts').whereTime('created_at', '03:04:05')), [1]);
});

test('sqlite: aggregates, groupBy/having, distinct', { skip }, async () => {
  const db = fixture();
  const b = table(db, 'comments');
  assert.equal(Number(await b.clone().count()), 3);
  assert.equal(Number(await b.clone().avg('id')), 11);
  assert.equal(Number(await b.clone().min('id')), 10);
  assert.equal(Number(await b.clone().max('id')), 12);
  const grouped = await table(db, 'comments')
    .selectRaw('post_id, COUNT(*) AS c')
    .groupBy('post_id')
    .havingRaw('COUNT(*) > ?', [1])
    .get();
  assert.deepEqual(grouped.map((r) => [r.post_id, Number(r.c)]), [[1, 2]]);
  const distinct = await table(db, 'comments').select('post_id').distinct().orderBy('post_id').get();
  assert.deepEqual(distinct.map((r) => r.post_id), [1, 2]);
});

test('sqlite: upsert (DO UPDATE / DO NOTHING), insertGetId', { skip }, async () => {
  const db = fixture();
  await table(db, 'settings').upsert([{ key: 'a', value: '1' }], 'key', ['value']);
  assert.equal((await table(db, 'settings').where('key', 'a').value('value')), '1');
  await table(db, 'settings').upsert([{ key: 'a', value: '2' }, { key: 'b', value: '9' }], 'key', ['value']);
  assert.equal((await table(db, 'settings').where('key', 'a').value('value')), '2');
  assert.equal((await table(db, 'settings').where('key', 'b').value('value')), '9');
  await table(db, 'settings').upsert([{ key: 'a', value: '3' }], 'key');
  assert.equal((await table(db, 'settings').where('key', 'a').value('value')), '2');
  const id = await table(db, 'books').insertGetId({ title: 'b4', author_id: 7 });
  assert.equal(Number(id), 4);
});

test('sqlite: increment/decrement, updateOrInsert, truncate', { skip }, async () => {
  const db = fixture();
  await table(db, 'posts').where('id', 1).increment('published');
  assert.equal(Number(await table(db, 'posts').where('id', 1).value('published')), 2);
  await table(db, 'posts').where('id', 1).decrement('published', 2);
  assert.equal(Number(await table(db, 'posts').where('id', 1).value('published')), 0);
  await table(db, 'posts').updateOrInsert({ id: 3 }, { title: 'c3' });
  assert.equal(await table(db, 'posts').where('id', 3).value('title'), 'c3');
  await table(db, 'posts').updateOrInsert({ id: 99 }, { title: 'new' });
  assert.equal(await table(db, 'posts').where('id', 99).value('title'), 'new');
  await table(db, 'comments').truncate();
  assert.equal(Number(await table(db, 'comments').count()), 0);
});

test('sqlite: chunk pages and paginate shape', { skip }, async () => {
  const db = fixture();
  const pages = [];
  await table(db, 'comments').orderBy('id').chunk(2, (rows, page) => {
    pages.push([page, rows.map((r) => r.id)]);
  });
  assert.deepEqual(pages, [[1, [10, 11]], [2, [12]]]);
  const paginated = await table(db, 'comments').orderBy('id').paginate(2, 2);
  assert.equal(paginated.total, 3);
  assert.equal(paginated.per_page, 2);
  assert.equal(paginated.current_page, 2);
  assert.equal(paginated.last_page, 2);
  assert.deepEqual(paginated.data.map((r) => r.id), [12]);
});

test('sqlite: pluck/value/exists/first', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(await table(db, 'comments').orderBy('id').pluck('body'), ['x', 'y', 'z']);
  assert.equal(await table(db, 'comments').orderBy('id').value('body'), 'x');
  assert.equal(await table(db, 'comments').where('body', 'zzz').exists(), false);
  assert.equal(await table(db, 'comments').where('body', 'z').exists(), true);
  assert.equal((await table(db, 'comments').where('body', 'zzz').first()), null);
});

test('sqlite: has(relation, operator, count) uses correlated COUNT', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(ids(await Post.query(db).orderBy('id').has('comments', '>=', 2).get()), [1]);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').has('comments', '>=', 1).get()), [1, 2]);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').has('comments', '=', 0).get()), [3]);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').has('comments', '>', 0, (q) => q.where('votes', '>=', 3)).get()), [1]);
  assert.deepEqual(ids(await Post.query(db).orderBy('id').whereHasCount('comments', '<', 2).get()), [2, 3]);
  assert.throws(() => Post.query(db).has('comments', 'LIKE', 1), /unsupported has\(\) operator/);
  assert.throws(() => Post.query(db).has('nope'), /unknown relation/);
});

test('sqlite: withSum/withAvg/withMin/withMax expose aggregate attributes', { skip }, async () => {
  const db = fixture();
  const posts = await Post.query(db).orderBy('id').withSum('comments', 'votes').get();
  assert.deepEqual(posts.map((p) => p.get('comments_sum_votes')), [8, 1, null]);
  assert.deepEqual(posts.map((p) => p.toJSON().comments_sum_votes), [8, 1, null]);
  const avgs = await Post.query(db).orderBy('id').withAvg('comments', 'votes').get();
  assert.deepEqual(avgs.map((p) => p.get('comments_avg_votes')), [4, 1, null]);
  const mins = await Post.query(db).orderBy('id').withMin('comments', 'votes').get();
  assert.deepEqual(mins.map((p) => p.get('comments_min_votes')), [3, 1, null]);
  const maxes = await Post.query(db).orderBy('id').withMax('comments', 'votes').get();
  assert.deepEqual(maxes.map((p) => p.get('comments_max_votes')), [5, 1, null]);
  assert.throws(() => Post.query(db).withSum('comments'), /needs a column/);
  assert.throws(() => Post.query(db).withSum('nope', 'votes'), /unknown relation/);
});

test('sqlite: Model casts (json/decimal/boolean) + accessor/appends/hidden on real rows', { skip }, async () => {
  const db = fixture();
  const inv = await Invoice.find(db, 1);
  assert.equal(inv.get('amount'), '10.50');
  assert.deepEqual(inv.get('meta'), { a: 1 });
  assert.equal(inv.get('paid'), true);
  assert.equal(inv.get('secret'), 'x');
  const json = inv.toJSON();
  assert.equal(json.secret, undefined);
  assert.equal(json.label, 'inv-10.50');
  assert.equal(json.paid, true);
  assert.deepEqual(json.meta, { a: 1 });
});

test('sqlite: Model set/save round-trips mutators and casts through SQL', { skip }, async () => {
  const db = fixture();
  const inv = await Invoice.find(db, 1);
  inv.set('secret', 'abc'); // mutator upper-cases
  inv.set('meta', { b: 2 }); // json cast encoded on save
  inv.set('paid', false); // boolean cast -> 0, not a JS boolean
  await inv.save(db);
  const raw = await table(db, 'invoices').where('id', 1).first();
  assert.equal(raw.secret, 'ABC');
  assert.equal(raw.meta, '{"b":2}');
  assert.equal(Number(raw.paid), 0);
  assert.ok(raw.updated_at);
  assert.equal((await Invoice.find(db, 1)).get('paid'), false);
});

test('sqlite: builder binds booleans/Dates/undefined to D1-safe values', { skip }, async () => {
  const db = fixture();
  assert.deepEqual(
    (await table(db, 'posts').where('published', true).orderBy('id').get()).map((r) => r.id),
    [1, 3, 4]
  );
  await table(db, 'posts').where('id', 1).update({ published: false });
  assert.equal(Number(await table(db, 'posts').where('id', 1).value('published')), 0);
  await table(db, 'posts').where('id', 1).update({ updated_at: new Date('2024-05-06T07:08:09.000Z') });
  assert.equal(await table(db, 'posts').where('id', 1).value('updated_at'), '2024-05-06T07:08:09.000Z');
  assert.equal(Number(await table(db, 'posts').where('title', undefined).count()), 0);
  await table(db, 'invoices').insert({ id: 2, amount: '1', meta: null, paid: true, secret: null });
  assert.equal(Number(await table(db, 'invoices').where('id', 2).value('paid')), 1);
});

test('sqlite: firstOrCreate/updateOrCreate/increment/refresh/findOrFail on real rows', { skip }, async () => {
  const db = fixture();
  const created = await Invoice.firstOrCreate(db, { secret: 'seed' }, { amount: '3' });
  assert.equal(created.get('secret'), 'SEED');
  assert.equal(Number(await Invoice.query(db).count()), 2);
  const again = await Invoice.firstOrCreate(db, { secret: 'SEED' }, { amount: '99' });
  assert.equal(again.get('id'), created.get('id'));
  assert.equal(again.get('amount'), '3.00');
  const updated = await Invoice.updateOrCreate(db, { id: created.get('id') }, { amount: '7' });
  assert.equal(updated.get('amount'), '7.00');
  assert.equal(await table(db, 'invoices').where('id', created.get('id')).value('amount'), '7');

  const post = await Post.find(db, 2);
  assert.equal(Number(post.get('published')), 0);
  // Laravel's increment() answers the affected-row count (the atomic
  // statement touched one row), not the new value.
  assert.equal(await post.increment(db, 'published', 2), 1);
  assert.equal(Number(await table(db, 'posts').where('id', 2).value('published')), 2);
  await table(db, 'posts').where('id', 2).update({ published: 9 });
  await post.refresh(db);
  assert.equal(Number(post.get('published')), 9);

  await assert.rejects(() => Post.findOrFail(db, 999), /Post not found: 999/);
});

test('sqlite: withCount on belongsTo, loadAggregate on one model', { skip }, async () => {
  const db = fixture();
  const books = await Book.query(db).orderBy('id').withCount('author').get();
  assert.deepEqual(books.map((b) => b.get('author_count')), [1, 1, 0]);
  const post = await Post.withTrashed(db).where('id', 1).withSum('comments', 'votes').first();
  assert.equal(post.get('comments_sum_votes'), 8);
  const loaded = await post.loadAggregate(db, ['comments', 'avg', 'votes']);
  assert.equal(loaded.get('comments_avg_votes'), 4);
  await assert.rejects(() => post.loadAggregate(db, ['comments', 'median', 'votes']), /unknown aggregate/);
});
