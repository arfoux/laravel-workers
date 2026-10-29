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

  // The kernel hands the runtime in first (a compiled accessor is
  // `function (rt, value)`: its body reads `rt.prop(this, ...)`).
  getFullNameAttribute(rt, value) {
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

  // Laravel's hasMany answers an Illuminate\\Database\\Eloquent\\Collection
  // (HasMany::getResults(), :433-440) - so ->count(), ->pluck() and ->isEmpty()
  // are the app's normal calls. The kernel answers the same Collection.
  assert.equal(typeof comments.count, 'function', 'hasMany answers a Collection');
  assert.deepEqual(
    comments.all().map((c) => c.get('body')),
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

// ---- mass assignment (audit row A42, P0) ----------------------------------
//
// Probed against the vendored Laravel 13:
//   - a model that declares NEITHER `$fillable` nor `$guarded` has Laravel's
//     default `$guarded = ['*']`, so `fill(['name' => 'a'])` throws
//     MassAssignmentException: "Add [name] to fillable property to allow mass
//     assignment on [OpenModel]."
//   - `$fillable = ['name']` accepts `name` and DROPS `admin`;
//   - `$guarded = ['secret']` accepts everything else and drops `secret`.
// The edge used to allow EVERY key when `$fillable` was empty - the opposite
// answer, and the dangerous one.

test('mass assignment follows $fillable/$guarded, and an unguarded model throws', () => {
  class Open extends Model {
    static table = 'open';
    static primaryKey = 'id';
  }
  const open = new Open({});
  assert.throws(
    () => open.fill({ name: 'a' }),
    /Add \[name\] to fillable property to allow mass assignment on \[Open\]\./
  );

  class Filled extends Model {
    static table = 'filled';
    static primaryKey = 'id';
    static fillable = ['name'];
  }
  const filled = new Filled({});
  filled.fill({ name: 'a', admin: 1 });
  assert.deepEqual(filled.attributes, { name: 'a' });

  class Guarded extends Model {
    static table = 'guarded';
    static primaryKey = 'id';
    static guarded = ['secret'];
  }
  const guarded = new Guarded({});
  guarded.fill({ name: 'a', secret: 'x' });
  assert.deepEqual(guarded.attributes, { name: 'a' });
});


// ---- the app timezone (M70) ----------------------------------------------
//
// Laravel sets PHP's default timezone from config('app.timezone'), so
// `freshTimestampString()` writes the LOCAL wall clock (HasAttributes::
// freshTimestampString()) and Carbon::toJSON() converts it BACK to UTC before
// appending `Z` (Carbon/Converter.php:442-455). Probed with PHP 8.3 at
// Asia/Jakarta: the instant 2025-10-23T00:00:00Z writes `2025-10-23 07:00:00`
// and serialises as `2025-10-23T00:00:00.000000Z`.
test('a model timestamp is written and serialised in the app timezone', async () => {
  const { phpDateString, isoDateString, setModelTimezone } = await import('../model.mjs');
  const instant = new Date(Date.UTC(2025, 9, 23, 0, 0, 0));
  try {
    setModelTimezone('UTC');
    assert.equal(phpDateString(instant), '2025-10-23 00:00:00');
    assert.equal(isoDateString('2025-10-23 00:00:00'), '2025-10-23T00:00:00.000000Z');

    setModelTimezone('Asia/Jakarta');
    assert.equal(phpDateString(instant), '2025-10-23 07:00:00');
    // The stored local wall clock converts BACK to UTC for the JSON form.
    assert.equal(isoDateString('2025-10-23 07:00:00'), '2025-10-23T00:00:00.000000Z');
  } finally {
    setModelTimezone('UTC');
  }
});

// ---- GuardsAttributes' dot/underscore rule (A42) --------------------------
//
// isFillable() (:213-224) refuses a key carrying a dot and a key starting with
// `_` when no `$fillable` list is declared - Laravel's defence against a
// nested/relation path and a framework-reserved column.
test('a dotted or underscore key is never mass-assignable', () => {
  class GuardedModel extends Model {
    static table = 'guarded_model';
    static primaryKey = 'id';
    static guarded = ['secret'];
  }
  const m = new GuardedModel({});
  m.fill({ name: 'a', _token: 't', 'a.b': 1, secret: 'x' });
  assert.deepEqual(m.attributes, { name: 'a' });
});


// ---- a hasMany relation is a Collection (A75) -----------------------------
//
// HasMany::getResults() answers an Eloquent Collection
// (Illuminate/Database/Eloquent/Relations/HasMany.php:433-440), so
// `$post->comments->count()` / `->pluck()` / `->isEmpty()` work. The edge used
// a plain array, where those methods do not exist. And the JSON must embed the
// related models' ARRAYS - `Collection#toJSON()` answers a JSON STRING, which
// would land in the body as "[{...}]".
test('a loaded hasMany answers a Collection and serialises as an array', async () => {
  const { Collection } = await import('../collections.mjs');
  class RelComment extends Model {
    static table = 'rel_comments';
    static primaryKey = 'id';
  }
  class RelPost extends Model {
    static table = 'rel_posts';
    static primaryKey = 'id';
  }
  RelPost.relations = {
    comments: { type: 'hasMany', model: RelComment, foreignKey: 'post_id', localKey: 'id' },
  };
  const post = new RelPost({ id: 7 });
  post.setRelation('comments', new Collection([new RelComment({ id: 1, body: 'first' })]));
  const rel = post.get('comments');
  assert.ok(rel instanceof Collection, 'a hasMany relation is a Collection');
  assert.equal(rel.count(), 1);
  assert.deepEqual(rel.pluck('body').all(), ['first']);
  assert.equal(rel.isEmpty(), false);
  // The serialised form is the ARRAY of the related arrays, not a JSON string.
  assert.deepEqual(post.toJSON().comments, [{ id: 1, body: 'first' }]);
  assert.equal(typeof post.toJSON().comments, 'object');
});

// ---- response()->json($model) (A83) --------------------------------------
//
// PHP's json_encode() honours JsonSerializable::jsonSerialize(), and a Model
// implements it through toArray() (Model.php:2270-2290). Probed with the
// vendored Laravel 13:
//   response()->json($model)      -> {"id":1,"name":"a"}
//   response()->json($collection) -> [{"id":1,"name":"a"},{"id":2,"name":"b"}]
// The compiled rung passed the raw object to the encoder, which threw
// "unsupported value (Function)" - a 500 where Laravel answers the model.
test('response()->json() serialises a model and a collection', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const { Collection } = await import('../collections.mjs');
  class JsonPost extends Model {
    static table = 'json_posts';
    static primaryKey = 'id';
    static fillable = ['id', 'name'];
  }
  const rt = buildRt(null, { strict: false });
  const a = new JsonPost({ id: 1, name: 'a' });
  const b = new JsonPost({ id: 2, name: 'b' });
  assert.equal(String(rt.json(a).body), '{"id":1,"name":"a"}');
  assert.equal(
    String(rt.json(new Collection([a, b])).body),
    '[{"id":1,"name":"a"},{"id":2,"name":"b"}]'
  );
  assert.equal(String(rt.json([a]).body), '[{"id":1,"name":"a"}]');
  // Symfony's JsonResponse ctor: `$data ??= new \ArrayObject()` (line 47), so
  // an explicit null answers "{}" - and `json()` with no argument answers the
  // `$data = []` default, "[]".
  assert.equal(String(rt.json(null).body), '{}');
  assert.equal(String(rt.json().body), '[]');
  assert.equal(rt.json({}, 201).status, 201);
});

test('a date cast with a custom format serialises in that format', () => {
  // `date:Y-m-d` / `datetime:d/m/Y H:i` are date casts WITH a format
  // (HasAttributes::isCustomDateTimeCast), so the attribute is a date and the
  // model writes the app's format - the old isDateAttribute() compared the whole
  // string and left the stored text alone (`d` stayed '2025-10-23 07:00:00').
  const { Model, formatCustomDate, castDateSpec } = model;
  class P extends Model {
    static casts = { d: 'date:Y-m-d', dt: 'datetime:d/m/Y H:i', plain: 'datetime' };
  }
  const p = new P({ id: 1, d: '2025-10-23 07:00:00', dt: '2025-10-23 07:30:00', plain: '2025-10-23 07:00:00' });
  const json = p.toJSON();
  assert.equal(json.d, '2025-10-23');
  assert.equal(json.dt, '23/10/2025 07:30');
  // A bare date cast keeps the ISO-form rule (Carbon::toJSON -> UTC + Z).
  assert.match(json.plain, /^2025-10-23T\d{2}:00:00\.000000Z$/);
  assert.deepEqual(castDateSpec('immutable_date:Y'), { base: 'immutable_date', format: 'Y' });
  assert.equal(castDateSpec('json'), null);
  // The PHP date() letters the common formats use.
  assert.equal(formatCustomDate('2025-01-05 09:05:07', 'jS F Y, H:i:s'), '5th January 2025, 09:05:07');
  assert.equal(formatCustomDate('2025-10-23 07:30:00', 'D, d M y'), 'Thu, 23 Oct 25');
  assert.equal(formatCustomDate('2025-10-23 07:30:00', 'N t Y'), '4 31 2025');
  // An escaped letter is literal.
  assert.equal(formatCustomDate('2025-10-23 07:30:00', '\\Y=Y'), 'Y=2025');
});
