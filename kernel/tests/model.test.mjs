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
import { makeDateValue } from '../model.mjs';

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

test('a bare `date` cast answers midnight; a custom format is NOT truncated', () => {
  // Oracle (PHP 8.3 + framework 13.37), `$m->d = $m->dh = $m->dt = $m->dtf =
  // '2024-01-02 03:04:05'`:
  //   (string) $m->d  => '2024-01-02 00:00:00'        (asDate -> startOfDay)
  //   getAttributes() => '2024-01-02 03:04:05' (the RAW attribute keeps the
  //                      time `fromDateTime()` wrote)
  //   $m->toArray()   => {"d":"2024-01-02T00:00:00.000000Z","dh":"03:04:05",
  //                       "dt":"2024-01-02T03:04:05.000000Z","dtf":"02\/01\/2024 03:04"}
  // `date:H:i:s` is a CUSTOM cast: `getCastType()` answers `custom_datetime`,
  // so `castAttribute` takes the `asDateTime()->format()` branch and the time
  // is NOT dropped.
  class Dated extends Model {
    static casts = { d: 'date', dh: 'date:H:i:s', dt: 'datetime', dtf: 'datetime:d/m/Y H:i' };
    static timestamps = false;
  }
  const m = new Dated();
  for (const k of ['d', 'dh', 'dt', 'dtf']) m.set(k, '2024-01-02 03:04:05');
  // The READ answers a Carbon value, so `(string)` is the model's date format
  // (probed: `(string) $m->dh` = '2024-01-02 03:04:05', not the cast format).
  assert.equal(String(m.get('d')), '2024-01-02 00:00:00');
  assert.equal(String(m.get('dh')), '2024-01-02 03:04:05');
  assert.equal(String(m.get('dt')), '2024-01-02 03:04:05');
  assert.equal(String(m.get('dtf')), '2024-01-02 03:04:05');
  assert.equal(m.attributes.d, '2024-01-02 03:04:05');
  assert.deepEqual(m.toJSON(), {
    d: '2024-01-02T00:00:00.000000Z',
    dh: '03:04:05',
    dt: '2024-01-02T03:04:05.000000Z',
    dtf: '02/01/2024 03:04',
  });
  // A date-only value stays a midnight date.
  const m2 = new Dated();
  m2.set('d', '2024-01-02');
  assert.equal(String(m2.get('d')), '2024-01-02 00:00:00');
  assert.equal(m2.get('d').format('d/m/Y'), '02/01/2024');
});

test('a date attribute READS as a Carbon: format/toDateString/(string)/json_encode', () => {
  // Oracle (PHP 8.3 + framework 13.37), `casts=['d'=>'datetime']`,
  // `$m->d = '2024-01-02 03:04:05'`:
  //   get_debug_type($m->d)     => Illuminate\Support\Carbon
  //   $m->d->format('d/m/Y')    => '02/01/2024'      (the app timezone)
  //   (string) $m->d            => '2024-01-02 03:04:05' (the model date format)
  //   json_encode($m->d)        => '"2024-01-02T03:04:05.000000Z"'
  //   $m->d == '2024-01-02 03:04:05' => true  (Carbon __toString); `===` false
  // The kernel used to answer the raw STRING, so `$post->created_at->format()`
  // (the framework's most common date idiom in a controller and a view) was a
  // JS TypeError - a 500 at the edge where Laravel answers 200.
  class Carbon extends Model {
    static casts = { d: 'datetime', day: 'date', custom: 'datetime:d/m/Y', n: 'int' };
    static timestamps = false;
    // Laravel's transformModelValue(): the accessor receives the RAW value.
    getNAttribute(rt, value) {
      return typeof value + ':' + value;
    }
  }
  const m = new Carbon();
  m.set('d', '2024-01-02 03:04:05');
  m.set('day', '2024-01-02 03:04:05');
  m.set('custom', '2024-01-02 03:04:05');
  m.set('n', '5');
  const d = m.get('d');
  assert.equal(d.format('d/m/Y'), '02/01/2024');
  assert.equal(d.format('g:i A'), '3:04 AM');
  assert.equal(String(d), '2024-01-02 03:04:05');
  assert.equal(d.toDateString(), '2024-01-02');
  assert.equal(d.toDateTimeString(), '2024-01-02 03:04:05');
  assert.equal(d.getTimestamp(), 1704164645);
  assert.equal(d.addDays(2).format('Y-m-d H:i'), '2024-01-04 03:04');
  assert.equal(d.subHours(3).format('H:i'), '00:04');
  // The `date` cast truncates on READ (asDate -> startOfDay).
  assert.equal(m.get('day').format('d/m/Y'), '02/01/2024');
  assert.equal(String(m.get('day')), '2024-01-02 00:00:00');
  // A custom-format cast still READS as the model's own date format; the format
  // is applied by serializeDate() on the JSON body.
  assert.equal(String(m.get('custom')), '2024-01-02 03:04:05');
  // An accessor wins and gets the RAW (uncast) value.
  assert.equal(m.get('n'), 'string:5');
  // Writing a read value back stores its TEXT.
  const m2 = new Carbon();
  m2.set('d', d);
  assert.equal(m2.attributes.d, '2024-01-02 03:04:05');
  // The JSON body keeps the Laravel shape (Carbon::toJSON, the cast's format).
  assert.deepEqual(m.toJSON(), {
    d: '2024-01-02T03:04:05.000000Z',
    day: '2024-01-02T00:00:00.000000Z',
    custom: '02/01/2024',
    n: 'string:5',
  });
  // A null date stays null.
  const m3 = new Carbon();
  m3.set('d', null);
  assert.equal(m3.get('d'), null);
  assert.equal(JSON.stringify(m3.get('d')), 'null');
});

test('a timestamps=false model does NOT read created_at as a date (#644)', () => {
  // Oracle (PHP 8.3 + 13.37), `setRawAttributes(['created_at' => '2024-01-02
  // 03:04:05'])`:
  //   `public $timestamps = false` -> get_debug_type($m->created_at) = 'string',
  //     $m->toArray() = {"created_at":"2024-01-02 03:04:05"}
  // because getDates() is [] while usesTimestamps() is false
  // (HasAttributes.php:1675-1680). A timestamps=true model still answers a
  // Carbon, so reading created_at on one is unchanged.
  class NoTs extends Model {
    static table = 'x';
    static timestamps = false;
  }
  class WithTs extends Model {
    static table = 'x';
  }
  const off = new NoTs({ created_at: '2024-01-02 03:04:05' });
  assert.equal(off.get('created_at'), '2024-01-02 03:04:05');
  assert.deepEqual(off.toJSON(), { created_at: '2024-01-02 03:04:05' });
  const on = new WithTs({ created_at: '2024-01-02 03:04:05' });
  assert.equal(typeof on.get('created_at'), 'object');
  assert.equal(String(on.get('created_at')), '2024-01-02 03:04:05');
});

test('a Carbon value is compared, concatenated and json_encoded like PHP', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const { phpJsonEncode } = await import('../php-json.mjs');
  const rt = buildRt(null, { strict: false });
  class Post extends Model {
    static casts = { d: 'datetime' };
    static timestamps = false;
  }
  const m = new Post();
  m.set('d', '2024-01-02 03:04:05');
  const d = m.get('d');
  // `==` with the date string is TRUE (__toString), `===` is FALSE.
  assert.equal(rt.looseEq(d, '2024-01-02 03:04:05'), true);
  assert.equal(rt.looseEq(d, '2024-01-02 03:04:06'), false);
  assert.equal(rt.strictEq(d, '2024-01-02 03:04:05'), false);
  // A comparison against a plain date string goes through the TEXT (PHP probed:
  // `$m->d > '2024-01-01 00:00:00'` and `$m->d < '2024-01-03 00:00:00'` are both
  // TRUE), so a longer/shorter string is compared as the app's wall clock.
  assert.equal(rt.gt(d, '2024-01-01 00:00:00'), true);
  assert.equal(rt.lt(d, '2024-01-03 00:00:00'), true);
  const other = new Post();
  other.set('d', '2024-01-02 04:04:05');
  assert.equal(rt.gt(other.get('d'), d), true);
  assert.equal(rt.gt(d, other.get('d')), false);
  // Concatenation and strval use the model's date format.
  assert.equal('x' + d.toString(), 'x2024-01-02 03:04:05');
  // json_encode() of the value itself, and nested in an array.
  assert.equal(phpJsonEncode(d), '"2024-01-02T03:04:05.000000Z"');
  assert.equal(phpJsonEncode({ x: d }), '{"x":"2024-01-02T03:04:05.000000Z"}');
  // A query binding unwraps to the stored text (not "[object Object]").
  const { table } = await import('../db.mjs');
  const seen = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          seen.push(params);
          return this;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true, meta: {} };
        },
        async first() {
          return null;
        },
      };
    },
  };
  await table(db, 'posts').where('d', d).get();
  assert.equal(seen[0][0], '2024-01-02 03:04:05');
});

// --- cast grammar: `decimal:N` and `string` (driven by the PHP oracle) ---
// The `decimal` cast is `BigDecimal::of((string) $value)->toScale(N, HalfUp)`.
// Brick\Math's parser is NOT the JS regex instinct: surrounding whitespace is
// rejected, an exponent is accepted, and the rounding happens on the decimal
// string ('2.675' -> '2.68', where toFixed() says '2.67'). Probed against PHP
// 8.3.30 + Laravel 13.37 with the framework's own brick/math; the [value,
// places, expected] rows below are the oracle's answers, and the rows whose
// expected value is null are the ones PHP throws NumberFormatException for.
test('decimal cast follows Brick\\Math grammar and half-up rounding', () => {
  const { applyCast } = model;
  const cases = [
    ['2.675', 2, '2.68'],
    ['2.5', 2, '2.50'],
    ['1', 2, '1.00'],
    ['0.005', 2, '0.01'],
    ['-2.675', 2, '-2.68'],
    ['5', 2, '5.00'],
    ['+2.5', 2, '2.50'],
    ['.5', 2, '0.50'],
    ['00.5', 2, '0.50'],
    ['2.6750', 2, '2.68'],
    ['9223372036854775808.5', 2, '9223372036854775808.50'],
    ['1e3', 2, '1000.00'],
    ['1E3', 2, '1000.00'],
    ['1e-3', 2, '0.00'],
    ['1e+3', 2, '1000.00'],
    ['.5e1', 2, '5.00'],
    ['1.e3', 2, '1000.00'],
    ['1.5e2', 2, '150.00'],
    ['-1.5e2', 2, '-150.00'],
    ['1e10', 2, '10000000000.00'],
    ['1e-10', 2, '0.00'],
    ['9.995', 2, '10.00'],
    ['9.994', 2, '9.99'],
    ['0.999', 2, '1.00'],
    ['-9.995', 2, '-10.00'],
    ['-0.001', 2, '0.00'],
    ['-0.000', 2, '0.00'],
    ['0.000', 2, '0.00'],
    ['1', 0, '1'],
    ['2.5', 0, '3'],
    ['2.5', 3, '2.500'],
    ['2.5', 6, '2.500000'],
    // PHP throws on all of these (NumberFormatException -> MathException):
    [' 2.5', 2, null],
    ['2.5 ', 2, null],
    [' 2.5 ', 2, null],
    ['\t2.5', 2, null],
    ['1e', 2, null],
    ['e3', 2, null],
    ['1_000', 2, null],
    ['1,5', 2, null],
    ['', 2, null],
    ['abc', 2, null],
    ['1.2.3', 2, null],
    ['.', 2, null],
  ];
  for (const [value, places, expected] of cases) {
    if (expected === null) {
      assert.throws(
        () => applyCast(value, 'decimal:' + places),
        (e) => e.phpClass === 'MathException' && e.message === 'Unable to cast value to a decimal.',
        `decimal:${places} of ${JSON.stringify(value)} must throw like PHP`
      );
    } else {
      assert.equal(applyCast(value, 'decimal:' + places), expected, `decimal:${places} of ${JSON.stringify(value)}`);
    }
  }
});

test("string cast is PHP's (string): array -> 'Array', floats via precision=14", () => {
  const { applyCast } = model;
  assert.equal(applyCast('x', 'string'), 'x');
  assert.equal(applyCast(5, 'string'), '5');
  assert.equal(applyCast(2.5, 'string'), '2.5');
  // not 'a,b' (Array.prototype.toString) - PHP's own array-to-string conversion
  assert.equal(applyCast([1, 2], 'string'), 'Array');
  assert.equal(applyCast(1e-5, 'string'), '1.0E-5');
});

test('a json/collection cast decodes with PHP key order (json_decode, not JSON.parse)', async () => {
  const { Model } = model;
  const { phpJsonEncode } = await import('../php-json.mjs');
  class CastPost extends Model {
    static casts = { meta: 'array', rows: 'collection' };
  }
  const raw = '{"b":1,"2":"x","a":2}';
  const p = new CastPost();
  p.attributes.meta = raw;
  p.attributes.rows = raw;
  // PHP: json_encode(json_decode($raw, true)) => {"b":1,"2":"x","a":2};
  // JSON.parse alone gave {"2":"x","a":2,"b":1} - a different response body.
  assert.equal(phpJsonEncode(p.get('meta')), raw);
  assert.equal(p.get('rows').toJson(), raw);
  // An invalid document is NULL (PHP's answer), never a thrown SyntaxError.
  const bad = new CastPost();
  bad.attributes.meta = 'nope';
  assert.equal(bad.get('meta'), null);
});

test('a json cast compares the DECODED arrays with PHP\'s === (isDirty)', () => {
  const { Model } = model;
  class DirtyJson extends Model {
    static casts = { meta: 'array', o: 'object' };
  }
  // A row that already exists (its key is present) with `raw` as the stored
  // text, then the attribute set through the cast. Every expectation below is
  // a probe against PHP 8.3 + framework 13.37 running the real
  // `originalIsEquivalent()` (`setRawAttributes($attrs, true)` + a set + a
  // read of `isDirty($key)`).
  const dirty = (key, raw, set) => {
    const m = new DirtyJson({ id: 1, [key]: raw });
    m.set(key, set);
    return m.isDirty(key);
  };
  // `originalIsEquivalent()` calls `fromJson()` WITHOUT `$asObject`, so the
  // `object` cast decodes to an assoc array too - no stdClass identity compare:
  // the same values are NOT dirty.
  assert.equal(dirty('o', '{"a":1}', { a: 1 }), false);
  // PHP's `===` on arrays is order-SENSITIVE: a reordered document is dirty.
  assert.equal(dirty('meta', '{"a":1,"b":2}', { b: 2, a: 1 }), true);
  assert.equal(dirty('meta', '{"a":1,"b":2}', { a: 1, b: 2 }), false);
  // `{}` and `[]` are both the empty PHP array (probed: not dirty). A
  // JSON.stringify compare saw two different containers and wrote an UPDATE.
  assert.equal(dirty('meta', '{}', []), false);
  // PHP coerces a canonical decimal key to the int, so `{"0":"x"}` IS `["x"]`;
  // a leading zero is not a canonical integer, so `{"01":"x"}` is keyed and
  // dirty against a list.
  assert.equal(dirty('meta', '{"0":"x"}', ['x']), false);
  assert.equal(dirty('meta', '{"01":"x"}', ['x']), true);
  // Values compare with `===`: no coercion across types.
  assert.equal(dirty('meta', '{"a":"1"}', { a: 1 }), true);
  assert.equal(dirty('meta', '{"a":true}', { a: 1 }), true);
  // `''` and `'null'` decode to null (fromJson), but a raw '' against a SET
  // null is dirty: `is_null($attribute)` answers false before the cast branch.
  assert.equal(dirty('meta', '', null), true);
  assert.equal(dirty('meta', 'null', null), true);
  assert.equal(dirty('meta', null, null), false);
});

test('a fresh model reads a missing attribute as NULL, like Laravel\'s container->make', () => {
  const { Model } = model;
  class FreshPost extends Model {
    static casts = { id: 'int', published: 'bool' };
  }
  // Laravel's getAttributeFromArray() is `$this->getAttributes()[$key] ?? null`,
  // so a cast-declared key with no attribute answers NULL (not undefined), and
  // phpIntCast(null) stays null (castAttribute() short-circuits a null primitive
  // cast). This is the object the compiled rung hands a route parameter whose
  // OPTIONAL segment is absent: `/p/{post?}` + `mb(?Post $post)` on `/p`
  // answers 200 `{"isNull":false,"id":null}` (probed on Laravel 13.37).
  const m = new FreshPost();
  assert.equal(m.get('id'), null);
  assert.equal(m.get('published'), null);
  // A key with no column at all still answers null (Eloquent's getAttribute).
  assert.equal(m.get('bogus'), null);
  // And the row-loading path is unchanged: a present attribute still casts.
  const row = new FreshPost({ id: '7', published: 1 });
  assert.equal(row.get('id'), 7);
  assert.equal(row.get('published'), true);
});

test('a date that PHP cannot read fails loud instead of answering the raw text (#273)', () => {
  // HasAttributes::asDateTime() (:1576-1622) NEVER answers a string: it either
  // builds a Carbon or raises `Carbon\Exceptions\InvalidFormatException`. It
  // first tries `createFromFormat(getDateFormat(), $v)` ('Y-m-d H:i:s', or the
  // `Y-m-d` fast path at :1605) and then `Date::parse($v)`, which reaches
  // Carbon's RELATIVE parser. Every expectation below is a probe against PHP
  // 8.3 + framework 13.37 in the Asia/Jakarta timezone, run through the real
  // method; the TZ is pinned here so the wall clock is the same.
  const read = (raw) => {
    try {
      return makeDateValue(raw, 'Asia/Jakarta').format('Y-m-d H:i:s');
    } catch (e) {
      assert.equal(e.name, 'InvalidFormatException', `${raw} should raise InvalidFormatException`);
      assert.match(e.message, /^Could not parse '/);
      return 'THROW';
    }
  };
  // The shape a database actually returns.
  assert.equal(read('2024-01-02 03:04:05'), '2024-01-02 03:04:05');
  assert.equal(read('2024-01-02'), '2024-01-02 00:00:00');
  // The components are 1-2 digits and the seconds part is optional.
  assert.equal(read('2024-1-2 3:4:5'), '2024-01-02 03:04:05');
  assert.equal(read('2024-01-02 03:04'), '2024-01-02 03:04:00');
  // Day/month/hour/minute/second ROLL over exactly like PHP's parser.
  assert.equal(read('2024-02-30'), '2024-03-01 00:00:00');
  assert.equal(read('2024-01-00'), '2023-12-31 00:00:00');
  assert.equal(read('2024-12-32'), '2025-01-01 00:00:00');
  assert.equal(read('2024-13-45'), '2025-02-14 00:00:00');
  assert.equal(read('2024-01-02 25:00:00'), '2024-01-03 01:00:00');
  assert.equal(read('2024-01-02 03:60:00'), '2024-01-02 04:00:00');
  // `is_numeric()` is a UNIX timestamp, NOT a year (asDateTime :1591-1594).
  assert.equal(read('1700000000'), '2023-11-15 05:13:20');
  assert.equal(read('20240202'), '1970-08-23 13:16:42');
  // NOT ported: a US date and an offset suffix need Carbon's relative parser,
  // which depends on the clock and the app's locale. Failing loud beats
  // answering a different wall clock in silence.
  assert.equal(read('02/01/2024'), 'THROW');
  assert.equal(read('2024-01-02T03:04:05Z'), 'THROW');
  assert.equal(read('next monday'), 'THROW');
  assert.equal(read('garbage'), 'THROW');
  // The kernel used to answer this raw text, so `.format()` was a TypeError.
  assert.equal(read('12-31-2024'), 'THROW');
});

// --- Eloquent parity on a REAL SQLite row (differential vs PHP 8.3 + 13.37) ---
//
// Every expectation below is a probe of the same table through Laravel itself
// (in-memory SQLite, the framework's own query builder), so the port is pinned
// to the framework's behaviour instead of to a second reading of the source.
// The harness is D1-shaped exactly like sqlite-integration.test.mjs.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node: the block below is skipped.
}
const sqliteSkip = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

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
          return { results: (params.length ? st.all(...params) : st.all()).map((r) => ({ ...r })) };
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

class DiffPost extends Model {
  static table = 'posts';
  static fillable = ['title'];
  static casts = { meta: 'object', t: 'timestamp' };
  static softDeletes = true;
}

function diffFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, meta TEXT, t TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO posts (id, title) VALUES (1, 'a'), (2, 'b'), (3, 'c');
  `);
  return { sqlite, db: d1(sqlite) };
}

test('sqlite: the timestamp cast is numeric-aware and timezone-stable', { skip: sqliteSkip }, async () => {
  const applyCast = model.applyCast;
  const { setModelTimezone } = await import('../model.mjs');
  // PHP: asTimestamp() -> asDateTime('1700000000') is a UNIX TIMESTAMP; the old
  // port answered null and read '2024-1-2 3:4:5' through JS Date.parse.
  try {
    setModelTimezone('Asia/Jakarta');
    assert.equal(applyCast('1700000000', 'timestamp'), 1700000000);
    assert.equal(applyCast('1700000000.5', 'timestamp'), 1700000000);
    assert.equal(applyCast('2024-01-02 03:04:05', 'timestamp'), 1704139445);
    assert.equal(applyCast('2024-1-2 3:4:5', 'timestamp'), 1704139445);
    assert.throws(() => applyCast('garbage', 'timestamp'), (e) => e.name === 'InvalidFormatException');
  } finally {
    setModelTimezone('UTC');
  }
});

test('sqlite: a date attribute write is normalised through fromDateTime', { skip: sqliteSkip }, async () => {
  const { setModelTimezone } = await import('../model.mjs');
  try {
    setModelTimezone('UTC');
    const m = new DiffPost();
    m.set('created_at', '2024-1-2 3:4:5');
    assert.equal(m.attributes.created_at, '2024-01-02 03:04:05');
    const n = new DiffPost();
    n.set('created_at', '');
    assert.equal(n.attributes.created_at, '');
    const o = new DiffPost();
    o.set('created_at', null);
    assert.equal(o.attributes.created_at, null);
  } finally {
    setModelTimezone('UTC');
  }
});

test('sqlite: findOrFail(array) matches ids by value, like findOrFail does', { skip: sqliteSkip }, async () => {
  const { db } = diffFixture();
  // PHP (real SQLite row) answers both models for ['1','2']: the count compare
  // is not identity-based, so a string route parameter matches an INTEGER key.
  const rows = await DiffPost.findOrFail(db, ['1', '2']);
  assert.equal(rows.length, 2);
  await assert.rejects(() => DiffPost.findOrFail(db, ['1', '99']), /not found: 99/);
});

test('sqlite: a soft delete keeps a pending change dirty, and save() writes it', { skip: sqliteSkip }, async () => {
  const { sqlite, db } = diffFixture();
  const post = await DiffPost.find(db, 1);
  post.set('title', 'zzz');
  await post.delete(db);
  // runSoftDelete() syncs ONLY the columns it wrote (SoftDeletes.php:155).
  assert.equal(post.isDirty('title'), true);
  assert.equal(post.isDirty('deleted_at'), false);
  await post.save(db);
  // `$this->save()` after a soft delete updates the trashed row itself.
  const row = sqlite.prepare('SELECT title, deleted_at FROM posts WHERE id = 1').get();
  assert.equal(row.title, 'zzz');
  assert.notEqual(row.deleted_at, null);
});

test('sqlite: delete()/forceDelete() answer true, and NULL for a new model', { skip: sqliteSkip }, async () => {
  const { db } = diffFixture();
  assert.equal(await (await DiffPost.find(db, 2)).delete(db), true);
  assert.equal(await new DiffPost().delete(db), null);
  assert.equal(await new DiffPost().forceDelete(db), null);
});

test('sqlite: restore() persists through save(), like the trait does', { skip: sqliteSkip }, async () => {
  const { sqlite, db } = diffFixture();
  const post = await DiffPost.find(db, 3);
  await post.delete(db);
  post.set('title', 'restored-title');
  assert.equal(await post.restore(db), true);
  const row = sqlite.prepare('SELECT title, deleted_at FROM posts WHERE id = 3').get();
  assert.equal(row.title, 'restored-title');
  assert.equal(row.deleted_at, null);
});

test('a model date value answers Carbon\'s locale()/translatedFormat() (probed on PHP 8.3)', () => {
  // `$profile->created_at->copy()->locale('id')->translatedFormat('j M Y')` is
  // the shape every Blade date cell uses. The model's date value used to carry
  // only format()/toDateString(), so `->locale()` was `undefined is not a
  // function` inside the compiled view while PHP answered the Indonesian form.
  //
  // php -r "echo Carbon::parse('2026-10-20 08:00:00')->locale('id')
  //   ->translatedFormat('j M Y');"           -> 20 Okt 2026
  // translatedFormat('l, j F Y')              -> Selasa, 20 Oktober 2026
  // translatedFormat('D')                     -> Sel
  // translatedFormat('j M Y')  (no locale)    -> 20 Oct 2026
  const d = makeDateValue('2026-10-20 08:00:00', 'Asia/Jakarta');
  assert.equal(d.copy().locale('id').translatedFormat('j M Y'), '20 Okt 2026');
  assert.equal(d.copy().locale('id').translatedFormat('l, j F Y'), 'Selasa, 20 Oktober 2026');
  assert.equal(d.copy().locale('id').translatedFormat('D'), 'Sel');
  assert.equal(d.copy().translatedFormat('j M Y'), '20 Oct 2026');
  // locale() is per instance: the model's own value is still English.
  assert.equal(d.translatedFormat('j M Y'), '20 Oct 2026');
});
