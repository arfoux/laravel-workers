# laravel-workers

> A build-time toolchain: Laravel app in, Cloudflare Workers artifact out. Blade views, routes and the D1/read paths it can verify against PHP 8.3 are compiled to dependency-free JS at build time. What it cannot verify **fails the build** — no silently-wrong output ships.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**What it is, plainly.** A toolchain with three parts: a `compiler` (Blade → PHP → JS, byte-parity against PHP 8.3), a Workers-native `kernel` (router, D1 query builder, models, validation, services), and `build.mjs` (pipeline → `dist/kernel` + `_routes.json` + schema snapshot). Laravel stays the source of truth in dev; the edge runs compiled JS + D1, **Free-plan-safe (measured 1–6 ms)**. It is **not** a Laravel runtime and **not** PHP-in-Worker: controllers ARE transpiled (a documented subset; anything outside it fails the build and needs a `ports/*.mjs` handler).mjs`.

## Why

PHP-in-Worker (wasm) boots Laravel per request: **measured 1008–2018 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker: `static` (0 invocations) → `snapshot` (prerendered HTML) → `compiled handler` (router → handler → D1, **measured 1–6 ms**) → `port` (escape-hatch hand-written JS). Anything uncovered **fails the build** (`--strict`).

**Status: 0.4.0 prepared, the npm publish waits on a valid npm login.** The compiled rung covers M1–M70 (construct audit: **114 constructs — 41 compile, 63 fail loud, 10 documented at the build level**; facade coverage 47/47). The change-by-change record (each M/A step, what it did and what it found) is in **[CHANGELOG.md](CHANGELOG.md)**.

---
## Supported vs unsupported

Compiles today (byte-parity corpus + kernel tests):
- **Blade → PHP** is compiled by the real Laravel Blade compiler at build time; the transpiler consumes the resulting PHP subset: `echo`, `if/elseif/else`, `for`/`while`/`foreach` (incl. `key => value`), PHP comparison/logic semantics (`==`/`!=`/`===`/`!==`/`<`/`>`/`<=`/`>=`, `&&`/`||`/`and`/`or`/`!`), ternary/`?:`, `??`/`??=`, `switch` (loose, fallthrough), `match` (strict), `isset()`/`empty()`, function declarations (defaults, recursion), string interpolation (`"$x"`, `"{$a['k']}"`, escapes), string concat, `e()`, `sprintf`, `str_replace`, `strtolower`/`strtoupper`/`trim`/`strlen`/`substr`/`str_repeat`/`str_pad`/`ucfirst`/`lcfirst`, `str_contains`/`str_starts_with`/`str_ends_with`, `count`/`in_array`/`implode`/`explode`/`number_format`/`nl2br`, `array_keys`/`array_values`/`array_merge`/`array_key_exists`, `ltrim`/`rtrim`/`ucwords`/`strrev`/`strpos`/`strrpos`/`substr_count`/`strip_tags`/`htmlspecialchars`, `is_null`/`is_bool`/`is_int`/`is_float`/`is_string`/`is_array`/`is_object`/`is_numeric`, `abs`/`round`/`floor`/`ceil`/`intval`/`floatval`/`max`/`min`, `json_encode`/`json_decode`, `array_sum`/`array_slice`/`array_reverse`/`array_unique`/`array_count_values`/`array_flip`/`array_filter`/`array_map` (named-function callbacks).
- **Kernel**: router (domain rules + `{param}`/`{param?}`/`{param*}`, `X-HTTP-Method-Override`) + response, D1 query builder (where/or + `where(fn)` grouping, join/group/having/distinct, `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime`, `sum`/`avg`/`min`/`max`, `upsert`/`insertGetId`/`truncate`/`increment`/`updateOrInsert`/`chunk`, D1-safe param binding: boolean→1/0, Date→ISO, undefined→NULL), Model base + relations (`hasMany`/`hasOne`/`belongsTo`, `create`/`firstOrCreate`/`updateOrCreate` honouring `fillable` + mutators + casts, `refresh`/`increment`, casts incl. `json`/`decimal:N`, accessors/mutators `getFooAttribute`/`setFooAttribute`, `hidden`/`visible`/`appends`, `softDeletes` with `trashed`/`restore`/`forceDelete`/`withTrashed`/`onlyTrashed`, `findOrFail`/`firstOrFail`, declared relations with `with()` eager loading + `withCount()` counters + `withSum()`/`withAvg()`/`withMin()`/`withMax()` aggregate attributes + `whereHas()`/`whereDoesntHave()`/`has(rel,'>=',n)` correlated `EXISTS`/`COUNT`, `related()`/`load()` lazy loading, local scopes via `query(db).scope('name')`), bcrypt hash incl. `Hash::isHashed()`, AES encrypter, validator (70+ rules, nested dot paths + `items.*.name` wildcards, `exclude*`/`missing*`/`present*` conditionals), mail/queue/cache/storage/scheduler adapters.
- **The Gate (M39a)**: `Gate::allows()`/`Gate::denies()` compile — the **policy** is compiled at build time (`tools/policy-dump.php` → `compiler/src/policy.mjs` → `dist/src/policies.generated.mjs`): the ability methods and the `before()` hook become async functions, and the runtime keeps Laravel's rules (the `before()` answer wins, a guest the policy does not allow is denied without the call, a missing ability is `false`).
- **The object store (M30/M39b)**: `Storage::put()/get()/exists()/delete()` and `Storage::disk('<the app\'s default disk>')` compile to the compiled store — the D1 blob store (no Cloudflare product, no card) or R2 when the app binds it.
- **The file upload (M40 part 5)**: a `multipart/form-data` body is parsed at the edge and `$request->file('x')` answers Laravel's file object (the name, the extension, the type the browser declared, the size, `isValid()`); the file is in the validated data, the `file` rule works and the size rules of a file are in **kilobytes**; `$file->store()`/`$file->storeAs()` write to the app's **default disk** and answer the disk-relative path. The content type of a file (`getMimeType()`) and the `mimes`/`mimetypes`/`image`/`dimensions` rules read the file's **bytes** (finfo) — the edge cannot sniff the content like PHP, so they fail loud (LW002/LW003).
- **The event dispatch (M39c)**: `Event::dispatch(new X(...))` compiles — the **listeners** are classes, so the build compiles them (`tools/event-dump.php` → `compiler/src/classes.mjs` → `dist/src/classes.generated.mjs`: the constructor with the promoted properties + the public methods) and the dispatch calls them **synchronously**, like Laravel (every listener runs, only an answer of `false` stops the chain, and the dispatch answers the array of the responses).
- **The Blade layouts (M40)**: `@extends` / `@section` / `@yield` compile — the sections travel to the layout (the env is shared with the nested render) and the build compiles the view closure (the layout is imported too).
- **The route-model binding (M40)**: `show(Post $post)` compiles — the model comes from the route segment (a missing model is a 404, like Laravel's `ModelNotFoundException`).
- **The method handling (M40)**: an `OPTIONS` request gets Laravel's **automatic OPTIONS response** (200, an empty body, the `Allow` header with the verbs the URI accepts) and a method that does not match answers like Laravel (405 with an `errors/405` view, else 500). A **CORS** config is not compiled: the build skips the routes under a CORS path (the `Access-Control-*` headers would be missing).
- **The paginator (M40)**: `Post::paginate(10)` compiles to Laravel's `LengthAwarePaginator` — the items, the total, the pages, the first/last item, the previous/next URLs and the URL window (`elements()`); the page comes from the request (`?page=N`). The **pagination links** (`$paginator->links()`) render the framework's `pagination::tailwind` view — compiled at build time, **byte-identical** to Laravel's markup. The **translations** (`__()`) are dumped at build time (the app's `lang/` + the framework's fallback).
- **The PHP casts (M40)**: `(string)`, `(int)`, `(bool)` and `(float)` compile with PHP's own semantics; the other casts fail loud.

Fails loud (build error or `LW002`), use a port instead:
- Blade **components** (`<x-...>`) that compile to `$__env->…` (the layouts compile — M40).
- Controller code outside the compiled subset: an action with a resolvable class method is transpiled for `GET`/`POST`/`PUT`/`PATCH`/`DELETE` (one handler per verb; the automatic `OPTIONS` response is Laravel's — M40; the uploaded files compile — M40 part 5). `Request`/FormRequest injection, `session()`/`old()`/`csrf_token()`/`csrf_field()`/`request()`/`auth()`/`Auth::*`, `$request->validate()`/`validateWithBag()`, `response()`/`response()->json()`, the `Cache`/`Hash` facades, class constants (`RouteServiceProvider::HOME`), `redirect()->intended()` + session rotation, and the Eloquent writes (`create`/`fill`/`save`/`delete`/`$model->attr = ...`) are supported at runtime `Request $request` injection plus `session()`/`old()`/`csrf_token()`/`csrf_field()`/`request()`/`auth()`/`Auth::*` and `$request->validate()`/`validateWithBag()` are supported at runtime (`auth`/`guest` route middleware is honoured by `handleHttp`; numeric `throttle:n[,m]` runs on the D1-backed `database` cache store, and the build fails loud on named limiters — `throttle:name` needs its `AppServiceProvider` definition — and when `cache.driver !== 'database'`). A failed `validate()` renders like Laravel: 302 back with flashed `errors` + `_old_input`, or 422 JSON for `expectsJson` (json session serialization; the `ViewErrorBag` `serialize()` path fails loud). Eloquent relations, `$this`, a FormRequest whose rules cannot be dumped, and unknown constructs fail loud — write a `ports/*.mjs` handler.
- The class-bearing calls: `Mail::to()->send()` (the mailable is a class), `Queue::push(SomeJob::class)` (the job would never run at the edge — the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job; the paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads — a port handler writes the row, the edge has no producer for it; the job class is not compiled either), a **named** `Storage::disk()` (it needs a bucket of its own: R2 asks for a credit card; the free path is the D1 blob store), `Cache::tags()` (the D1 `database` store has no tags — in Laravel this route 500s with `BadMethodCallException("This cache store does not support tagging.")`, so the build refuses the route before it ships: stricter than Laravel, not a parity) and the Gate forms that are not a policy check — `Gate::authorize()` (it throws a 403), `Gate::any()`/`none()`, `Gate::define()`/`before()`/`after()` (the global Gate registrations) — all fail loud with their own reason (LW002). The **content type of an uploaded file** (`$file->getMimeType()`) and the `mimes`/`mimetypes`/`image`/`dimensions` **rules** fail loud too (LW002/LW003): they read the file's bytes (finfo), and the edge cannot sniff the content like PHP — the upload itself compiles (M40 part 5). The **event dispatch of an event *name*** (`Event::dispatch('post.created')`) fails loud too: without a class the edge cannot know which listener answers.


## What's inside

- `compiler/` — **M1 view compiler** + **M10 controller compiler**: `bin/transpile.mjs` (php-parser 3.7.0, codes `LW001`–`LW004` fail-loud), `bin/controller.mjs`, `src/transpiler.mjs`, `src/controller.mjs`, `src/policy.mjs` (M39a: the policy compiler), `runtime/rt-from-context.mjs`, `tests/` (corpus 51, parity, smoke, controller, policy).
- `kernel/` — Workers-native runtime: `router.mjs` + `response.mjs` (W3), `db.mjs` + `model.mjs` (M3 D1 builder + Model), `hash.mjs` + `encrypter.mjs` (M5), `validator.mjs` (M6) + `{mail,queue,cache,storage,scheduler}.mjs` (M7), `session.mjs` + `csrf.mjs` + `ratelimit.mjs` + `auth.mjs` (M11–M14 compiled-rung layers, PHP-8.3-oracle-verified), `cache.mjs` `DatabaseCacheStore` (M18, D1-backed `database` cache for `throttle`), `validation.mjs` `ValidationException` + session error-bag shape (M19, drives `handleHttp`'s redirect-back/422), `http.mjs` (M15 compiled HTTP pipeline), budget gate (M8).
- `tools/` — build-time PHP: `compile-view.php` (S0 dump), `prerender.php`, `model-dump.php` (M10 Eloquent metadata), `constants-dump.php` + `formrequest-dump.php` (M23 class constants + FormRequest rules), `policy-dump.php` (M39a: the Gate/policy metadata — the abilities, the guest rules, the global Gate callbacks), `php-shadow-oracle.php` (the M24 shadow harness oracle), `verify-s0.php`, `schema-compile.php`, `docs-check.mjs` + `bench.mjs` (M8 gates; `pragma_table_info` fallback, D1 AUTH-safe), `pack-smoke.mjs` (M31: packs the repo, installs the tarball into an empty project and builds a real app with it - the published file set is proven, not assumed), `constructs.json` + `construct-audit.mjs` (the **construct audit**: every construct an app can meet is probed against the real compiler; the table in `COMPILED.md` is generated from it and `check:docs` fails when it drifts - the docs cannot lie about what compiles).
- `shadow/` — the proof machine (M24): `run.mjs` replays a scenario against the real app (PHP oracle) and the compiled worker and diffs status/headers/body byte-wise; `scenarios/<app>.mjs` is the per-app corpus. `npm run test:shadow -- --app <app-root>` or `laravel-workers shadow --app <app-root>`.
- `build.mjs` — app build pipeline (copies into a Laravel app's build dir; `dist/kernel` layout + `dist/schema.json` snapshot + `dist/schema.sql` (the same schema as SQL, for `wrangler d1 execute`) + `routes.generated.mjs` route table with names/domains and a `routeNames` map + `public/_routes.json` for Cloudflare Static Assets).
- `MAP.md` — the map (+105/105 Laravel 13.x docs verdicts, tolerance model, budgets, prior-art policy).

## Requirements

Versions actually tested (byte-parity corpus + CI + live deploy):

| Component | Tested with | Requirement |
| --- | --- | --- |
| Laravel | `13.37.0` (nearFind, app-breeze), `11.34.2` (blogkit) | 10–13 as source of truth |
| PHP — build time only | `8.3.30` (ZTS x64, Windows) | **≥ 8.3**; parity oracle is 8.3 (other minors untested) |
| Composer | none needed | vendor is provisioned automatically via composer-free vendor-lite (no `composer install`), or the app's own `vendor/` when present |
| Node | `22.18.0` | **≥ 22** (`engines`) |
| npm | `10.9.3` | ≥ 10 |
| Cloudflare Workers | `wrangler` `4.151.1` | 4.x; `compatibility_date` `2026-08-01` (live corpus) / `2026-10-01` (`init` template) |

- Laravel app as source of truth (Vite unchanged, sessions/CSRF off by default in this pipeline).
- `php-parser@3.7.0` (npm) for the compiler, `bcryptjs@2.4.3` for `kernel/hash` (pure JS, no native).
- Cloudflare account for deploy (D1 binding id `ad5876a0-c5eb-493c-917e-5e8f0e543200` in this repo's test Wrangler). **Free plan safe — measured 1–6 ms CPU.**

### The Cloudflare tiers we target (in order)

1. **Free plan first** — the D1 blob store (`lw_blobs`, 1,5 MB per object, no extra product, **no credit card**) is the default object store; the Workers free limits (10 ms CPU/req, 50 subrequests, 100k D1 writes/day, 5M reads/day) are the budget the kernel is measured against.
2. **R2 when the app really needs it** — a **named** disk (its own bucket), an object above 1,5 MB, or many objects. R2's free tier (10 GB-month, 1M Class A, 10M Class B, free egress) is generous, but **R2 asks for a payment method** — so the build never turns it on by itself: it prints the `wrangler.jsonc` snippet and the operator decides.
3. **The paid plan, only when the free path really cannot do it** — if an app needs more than the free quotas (or a paid-only Cloudflare feature), that is a *deliberate operator decision*: the toolchain stays free-plan-shaped by default, says exactly what the app needs, and the operator opts into the paid plan. Nothing in the compiler assumes a paid plan, and no construct is blocked *because* the free plan is too small — the build only fails loud when the edge genuinely cannot answer like PHP.

**Three levels, not two — "paid" is not the same as "needs a credit card"** (the Cloudflare docs, checked 2026-10-21; the pages were last updated 2026-04-21):
- the **free plan** (no card, no subscription): Workers, D1, KV, the D1 blob store, a *limited* version of Queues (10,000 operations/day included, 128 KB per message, 24 h retention on the free plan) and Durable Objects (100k requests + 100k row writes per day);
- the **Workers paid plan** (a subscription): Dynamic Workers (only on the paid plan) and the full Queues (billed per operation);
- a **payment method** (a credit card): R2 — even its free tier asks for one. That is the only product in the list that needs a card.

## Quick start

```bash
# 1) As an npm package in a real Laravel app (recommended):
cd my-laravel-app             # artisan + vendor + public/build there
npm i laravel-workers
npx laravel-workers init             # writes registry.json + wrangler.jsonc, updates .gitignore
# no composer install needed - the build provisions the app's PHP vendor itself (composer-free vendor-lite)
npx laravel-workers build --strict   # dist/ (cwd-based, no edge/ required); --scaffold for port stubs
# local preview/deploy: npx wrangler deploy

# 2) From checkout (tests / legacy edge layout):
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup                 # root + compiler deps

npm test                      # 359/359 - router + db/model + sqlite + hash + encrypter + validator + services + routes-json + registry-json + ports + budget + the PHP oracle parity - router + db/model + sqlite + hash + encrypter + validator + services + routes-json + registry-json + ports + budget
npm run test:corpus           # 51/51 — M1 transpiler corpus
npm run test:hash             # 7/7  — hash + encrypter only

# verify/build against the parent Laravel checkout (legacy edge/ also works):
npx laravel-workers verify    # VERIFY-S0 15/15 (else SKIP)
npx laravel-workers build     # --strict build; reads registry.json / edge/registry.json from app cwd
```

## CLI

```bash
laravel-workers test            # all kernel tests (380)
laravel-workers test:db          # db/model only
laravel-workers test:sqlite      # real in-memory SQLite integration (node:sqlite)
laravel-workers test:hash       # hash + encrypter only
laravel-workers test:validator  # validator only
laravel-workers test:services   # mail/queue/cache/storage/scheduler
laravel-workers test:budget     # budget gate only
laravel-workers test:corpus     # transpiler corpus (51)
laravel-workers bench           # micro-bench (bench.mjs)
laravel-workers check:docs      # docs-check 105/105
laravel-workers init            # scaffold registry.json + wrangler.jsonc (needs Laravel app root)
laravel-workers build           # --strict (needs Laravel app); --scaffold generates + registers port stubs
laravel-workers verify          # php tools/verify-s0.php (SKIP when no parent vendor/)
laravel-workers shadow          # the shadow harness: the real app (PHP oracle) vs the compiled worker

# npm aliases do the same:
npm test                      # kernel
npm run test:corpus
npm run build
npm run verify
# also: npm run bench / npm run check:docs / npm run test:budget / npm run test:services / npm run test:pack / npm run audit:constructs etc.
```

## Zero-touch / CI (Workers Builds)

Keep the repo pure Laravel — config and ports can live outside it:

- `LW_CONFIG=../edge-config/registry.json` — registry path override (relative to the app root; a set-but-missing file **fails the build**).
- `LW_PORTS_DIR=../edge-ports` — port directory override, checked before `src/ports`, `ports/`, `edge/src/ports` (a set-but-missing dir **fails the build**).
- `registry.json` is **optional**: without it the build uses defaults (`autoSnapshot` on, no ports/ignore). Unhandled routes still fail `--strict`, and a registered port without a matching file fails the build. Static entries must prerender clean; a static entry that reads a D1 binding the build cannot reach fails the build — a D1 app needs a local sqlite fallback for the build (config/database.php).
- `--scaffold` stubs carry a `laravel-workers:stub` marker and return `501`; `build --strict` keeps failing until every stub is implemented.
- Building while `wrangler dev` is running is safe: if the OS locks `dist/`, the build wipes its contents (keeping the dir shells) and the dev server hot-reloads the fresh output.

Workers Builds (Dashboard → Workers → connect the GitHub repo) — config is injected in the build command, nothing is committed:

```bash
touch database/database.sqlite
cat > registry.json <<'JSON'
{ "autoSnapshot": true, "ports": {} }
JSON
cat > wrangler.jsonc <<'JSONC'
{ "name": "my-app", "main": "./dist/src/worker.mjs", "compatibility_date": "2026-10-01",
  "assets": { "directory": "./dist/public", "binding": "ASSETS" },
  "d1_databases": [ { "binding": "DB", "database_name": "my-app", "database_id": "<the id from: npx wrangler d1 create my-app>" } ],
  "observability": { "enabled": true } }
JSONC
cp .env.example .env && php artisan key:generate
php artisan migrate --force
npm run build
npx -y laravel-workers@0.4.0 build --strict
# the D1 schema: the app's tables (+ lw_blobs when the app uses Storage::)
npx wrangler d1 execute DB --file=dist/schema.sql --remote
# deploy command: npx wrangler deploy
```

The build image must provide PHP >= 8.3 (Composer is NOT needed anymore - the build provisions vendor itself via composer-free vendor-lite).

## Architecture (30 s)

```
Laravel app (dev truth)
  └─ edge/tools/*.php   S0  dump routes / Blade-compiled HTML+context / schema / config (PHP boots here ONLY)
  └─ edge/build.mjs     S1  transpile Blade→JS, routes→router, schema→schema.json + generated controllers
  └─ bundler            S2  kernel + generated → worker ESM
  └─ golden tests       S3  Laravel render vs compiled render byte-equal
  └─ --strict gate      S4  uncovered route → fail
  └─ prerender          S5  clean GET → static snapshot (0-invocation tier)
  └─ wrangler deploy    S6  deploy → Workers + D1
```

## Docs & checks

- `MAP.md` — auto-snapshot semantics, D1 max-queries note, Unknowns-to-verify, and Appendix C (105 docs pages → verdict; no blanks, releases must re-check `laravel/docs@13.x` — W8).
- `compiler/tests/run-corpus.mjs` — oracle; `compiler/tests/parity-m1` + `tools/verify-s0.php` — green in M1.
- `kernel/tests/{router,db,hash,encrypter,validator,services,routes-json,registry-json,ports,budget}.test.mjs` — M5 proves `make`/`check`/`encryptString`/`decryptString` round-trip, tamper, wrong-key, unicode.

## Philosophy

- **Laravel stays Laravel** — this is the toolchain, not app code; no fork of framework.
- **Coverage enforced** — unhandled route = warning; `--strict` = failure. No silent gaps.
- **Free-plan-first** (`10ms` CPU, `50` subrequests, `5M` D1 reads/day) — Paid is headroom, never a fallback.
- **Honest claims** — "approach in progress" until M1–M5 measured; prior-art scan stays clean before any "discovery" claim.

## Roadmap (living)

- **M6** Validation kernel — done (M6).
- **M7** Services kernel — done (M7).
- **M8** Final gates — done: docs-check 105/105 + bench/budget p95 ≤5ms + CI + pack green.
- **M9** Zero-touch hardening — done: stubs fail loud, `LW_CONFIG`/`LW_PORTS_DIR`, optional registry, fresh-Laravel e2e job in CI (strict build → dist asserts → `wrangler dev` runtime smoke).

## License

MIT — see [LICENSE](LICENSE). Trademarks belong to their owners.
