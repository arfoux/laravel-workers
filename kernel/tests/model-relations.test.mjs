// kernel/tests/model-relations.test.mjs — declared relations, loaded-relation
// override, loud unknown-relation reads, and accessor precedence.
//
// What the edge CAN do (and Laravel does):
//   - `static relations = { comments: { type: 'hasMany', model: Comment,
//     foreignKey: 'post_id', localKey: 'id' } }` (kernel/model.mjs:199-201).
//     NOTE: `model` is the related CLASS, not a string — loadRelation() reads
//     `rel.model` and calls `Related.query(db)` (kernel/model.mjs:754-756).
//   - `related(db, name)` lazily loads the relation ONCE and answers the rows;
//     a relation already present in `_relations` is returned as-is, with no
//     query (Eloquent's getRelationValue() cache, HasAttributes.php:425-435).
//   - `setRelation(name, value)` is the eager-load/override hatch
//     (Model::setRelation, Model.php:2214); the loaded value is serialised by
//     toJSON() (the JS `toArray()` equivalent, Model.php:attributesToArray /
//     relationsToArray) and an UNLOADED relation is absent from it.
//   - Reading a DECLARED but unloaded relation through get() stops loudly and
//     names the fix (`related(db, …)` / `with(…)`) instead of answering
//     undefined.
//   - Reading an attribute that is neither a column, a cast, an accessor nor a
//     declared relation stops loudly with the kernel's existing wording
//     (kernel/model.mjs:292).
//   - `getFullNameAttribute()` answers `$user->full_name`: an accessor wins for
//     a key that is not a column. Eloquent's transformModelValue() consults the
//     get-mutator BEFORE the column/cast branch (HasAttributes.php:527-560),
//     so a real column would be passed through the accessor as `$value`.
//
// What it CANNOT do: there is no lazy DB handle on the model, so a declared
// relation is never loaded implicitly by `get()` — the read must go through
// `related(db, name)` or be eagerly loaded with `with()`.
//
// Deterministic: the D1 handle is a stub; no PHP runs here.

import test from 'node:test';
import assert from 'node:assert/strict';
import model from '../model.mjs';

const { Model } = model;

// A stub of the tiny slice of the query builder loadRelation() touches:
// `Related.query(db).whereIn(fk, ids).get()`. `counter.queries` is the proof
// that a loaded relation is not re-fetched.
function makeQueryStub(rows, counter) {
  return function query() {
    return {
      whereIn() {
        return this;
      },
      async get() {
        counter.queries++;
        return rows;
      },
    };
  };
}

class Post extends Model {
  static table = 'posts';
  static primaryKey = 'id';
  static relations = {
    comments: { type: 'hasMany', model: null, foreignKey: 'post_id', localKey: 'id' },
  };
}

class Comment extends Model {
  static table = 'comments';
  static primaryKey = 'id';
}

Post.relations.comments.model = Comment;

class User extends Model {
  static table = 'users';
  static primaryKey = 'id';

  getFullNameAttribute(value) {
    if (value == null) return 'Anonymous';
    return value + ' (accessor)';
  }
}

test('related() answers the hasMany rows filtered by the foreign key', async () => {
  const counter = { queries: 0 };
  const rows = [
    new Comment({ id: 1, post_id: 7, body: 'first' }),
    new Comment({ id: 2, post_id: 7, body: 'second' }),
    new Comment({ id: 3, post_id: 8, body: 'other post' }),
  ];
  Comment.query = makeQueryStub(rows, counter);

  const post = new Post({ id: 7 });
  const comments = await post.related({}, 'comments');

  // Laravel's hasMany answers an Illuminate\Database\Eloquent\Collection
  // (HasMany extends HasOneOrMany; getResults() -> Collection). The kernel's
  // relation value is a plain array of models.
  assert.ok(Array.isArray(comments), 'hasMany answers a collection (array of models)');
  assert.deepEqual(
    comments.map((c) => c.get('body')),
    ['first', 'second']
  );
  assert.equal(counter.queries, 1);
  assert.ok(post.relationLoaded('comments'));
});

test('a loaded relation is returned without another query', async () => {
  const counter = { queries: 0 };
  Comment.query = makeQueryStub([new Comment({ id: 9, post_id: 7 })], counter);
  const post = new Post({ id: 7 });
  const override = [new Comment({ id: 9, post_id: 7, body: 'cached' })];
  post.setRelation('comments', override);

  const got = await post.related({}, 'comments');

  assert.equal(got, override, 'related() answers the already-loaded value verbatim');
  assert.equal(counter.queries, 0, 'no query was issued for a loaded relation');
});

test('toArray() serialises a loaded relation and omits an unloaded one', () => {
  const post = new Post({ id: 7, title: 'hello' });
  assert.equal(Object.prototype.hasOwnProperty.call(post.toArray(), 'comments'), false);

  post.setRelation('comments', [new Comment({ id: 1, post_id: 7, body: 'first' })]);
  assert.deepEqual(post.toArray().comments, [{ id: 1, post_id: 7, body: 'first' }]);
});

test('reading a declared but unloaded relation fails loud', () => {
  const post = new Post({ id: 7 });
  assert.throws(
    () => post.get('comments'),
    /the relation "comments" is not loaded - use related\(db, "comments"\) or with\("comments"\)/
  );

  // After eager loading, the same read answers the loaded value.
  const loaded = [new Comment({ id: 1, post_id: 7 })];
  post.setRelation('comments', loaded);
  assert.equal(post.get('comments'), loaded);
});

test('an unknown key answers null, an uncompiled declared key fails loud', () => {
  // Eloquent's getAttribute() answers NULL for a key that is neither an
  // attribute, a cast, an accessor nor a relation (HasAttributes.php:415-445).
  const post = new Post({ id: 7 });
  assert.equal(post.get('nope'), null);

  // A key the DUMP declared but could not compile (an accessor whose body is
  // app code the edge cannot run) must not answer a silent null - it stops
  // with the dump's own reason.
  class Guarded extends Model {
    static table = 'guarded';
    static primaryKey = 'id';
    static notCompiled = ['full_name'];
  }
  const guarded = new Guarded({ id: 1 });
  assert.throws(
    () => guarded.get('full_name'),
    /the model attribute "full_name" is not compiled \(a relation or an accessor\)/
  );
});

test('an accessor answers a non-column attribute', () => {
  const user = new User({ id: 1 });
  assert.equal(user.get('full_name'), 'Anonymous');
});

test('an accessor receives the real column value', () => {
  // transformModelValue() runs the accessor even for a real column
  // (HasAttributes.php:527-560) — the accessor sees $value and may keep it.
  const user = new User({ id: 1, full_name: 'Ada' });
  assert.equal(user.get('full_name'), 'Ada (accessor)');
});
