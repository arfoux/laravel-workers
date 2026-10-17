# CONTRACT-m3 — D1 layer (frozen 2026-10-18)

M3 adds the database kernel: schema snapshot at build time + a parameterized
query builder (and a small Model base) over the D1 binding. No PHP at request
time; SQL is generated and bound, never string-interpolated from user data.

## Artifacts

- `edge/kernel/db.mjs` — `DB.table(name)` query builder + helpers.
- `edge/kernel/model.mjs` — `Model` base (fillable, casts, timestamps, find/all/create/save/delete).
- `edge/tools/schema-dump.php` — emits `schema.json` (tables/columns/indexes/FKs).
- `edge/.cache/schema.json` / `dist/schema.json` — build-time schema snapshot.
- `edge/tests/db.test.mjs` — mock-D1 unit tests.

## Query builder API (frozen)

- `db(db, table)` / `DB.table(table)` returns a builder.
- chainable: `select(...cols)`, `where(col, opOrValue, value?)`, `whereIn(col, values)`,
  `whereNull(col)`, `orderBy(col, dir='asc')`, `limit(n)`, `offset(n)`.
- terminal: `toSql()` -> `{ sql, params }`, `get()`, `first()`, `count(col='*')`,
  `insert(data)`, `update(data)`, `delete()`, `paginate(perPage=15, page=1)`.
- Identifiers are quoted; values are bound (`?`). Operators are whitelisted.

## Model API (frozen)

- `class X extends Model { static table; static fillable=[]; static casts={}; static timestamps=true; }`
- `X.query(db)`, `X.all(db)`, `X.find(db, id)`, `X.create(db, attrs)`.
- instance: `fill(attrs)`, `save(db)`, `delete(db)`, `toJSON()`.

## Build contract

- Build runs `schema-dump.php` to `.cache/schema.json` and copies it to `dist/schema.json`.
- `--strict` still fails on unhandled routes; schema dump failure fails the build.

## Territory

- `edge/kernel/{db,model}.mjs`, `edge/tools/schema-dump.php`, `edge/tests/db.test.mjs`: M3.
- `edge/build.mjs`: add schema dump + copy; standardize kernel copy to `dist/kernel`.
- `edge/src/worker.mjs`: import kernel from `../kernel/...`.
- `edge/src/ports/*` and generated controllers: import kernel from `../../kernel/...`.
- `edge/kernel/{router,response}.mjs`: read-only (already frozen).
