# laravel-workers

> A build-time toolchain: Laravel app in, Cloudflare Workers artifact out. Blade views, routes and the D1/read paths it can verify against PHP 8.3 are compiled to dependency-free JS at build time. What it cannot verify **fails the build** — no silently-wrong output ships.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**What it is.** A toolchain with three parts:

- `compiler/` — Blade → PHP → JS transpiler (byte-parity corpus + PHP 8.3 oracle).
- `kernel/` — Workers-native runtime: router, D1 query builder, models, sessions, auth, validation, cache, mail, queue, scheduler.
- `build.mjs` — pipeline → `dist/` artifact ready for `wrangler deploy`.

Laravel stays the source of truth in dev; the edge runs compiled JS + D1. It is **not** a Laravel runtime and **not** PHP-in-Worker (WASM). Controllers ARE transpiled (a documented subset; anything outside it fails the build and needs a `ports/*.mjs` handler). **Free-plan-safe** (budget p95 ≤ 5 ms, measured by `kernel/tests/budget.test.mjs`).

---

## Why

PHP-in-Worker (WASM) boots Laravel per request: **~1000–2000 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker:

```
static      → 0 invocations (Cloudflare Static Assets)
snapshot    → prerendered HTML for clean GET routes
compiled    → router → controller → D1 (p95 ≤ 5 ms, see budget gate)
port        → escape-hatch hand-written JS for unsupported constructs
```

Anything uncovered **fails the build** (`--strict`). No silently-wrong output ships.

**Construct coverage:** 114 constructs audited — 41 compile, 63 fail loud, 10 documented at the build level. Façade coverage 47/47 (every `Illuminate\Support\Facades\*` has a verdict). The change-by-change record is in **[CHANGELOG.md](CHANGELOG.md)**; the full map in **[MAP.md](MAP.md)**.

---

## Compiles today

| Area | What's supported | Proof |
|---|---|---|
| **Blade** | `@extends`/`@section`/`@yield`, `@if`/`@elseif`/`@else`, `@foreach`/`@for`/`@while`, `@switch`/`@match`, ternary / `?:` / `??` / `??=`, `isset`/`empty`, string interpolation, `e()`, `__()` translations (dumped at build), PHP casts | corpus 51/51 + PHP 8.3 oracle |
| **Router** | `{param}` / `{param?}` / `{param*}`, domain rules, `X-HTTP-Method-Override`, automatic `OPTIONS` | `kernel/tests/router.test.mjs` |
| **Controllers** | `GET`/`POST`/`PUT`/`PATCH`/`DELETE` with resolvable class methods; `Request`/FormRequest injection; `session()`/`old()`/`csrf_token()`/`csrf_field()`; `auth()`/`Auth::*`; `$request->validate()`/`validateWithBag()`; `response()`/`response()->json()`; `Cache`/`Hash` facades; class constants; `redirect()->intended()` + session rotation; Eloquent writes (`create`/`fill`/`save`/`delete`/`$model->attr = …`) | PHP 8.3 oracle (M15) |
| **Eloquent** | `find`/`findOrFail`/`all`/`where*`/`orderBy*`/`limit` + `first`/`get`/`count`/`pluck`/`value`; `hasMany`/`hasOne`/`belongsTo`; `create`/`updateOrCreate`/`firstOrCreate`; `fillable` + mutators + casts (`json`, `decimal:N`, `hashed`); `refresh`/`increment`; soft deletes; relations read as properties | `kernel/tests/db.test.mjs` + SQLite integration |
| **Auth** | `SessionGuard` (attempt/login/logout/remember/recaller), `EloquentUserProvider`, `BcryptHasher` (`$2y$` parity), remember-me rotation, `auth`/`guest` middleware, `auth.basic` | 13 guard runs byte-parity vs PHP 8.3 oracle (M14) |
| **Session + CSRF** | Flash data + rotation, `migrate`/`regenerate`/`invalidate`, token plumbing, `PreventRequestForgery` | PHP 8.3 oracle (M11/M13) |
| **Rate limiting** | `ThrottleRequests` over the D1-backed `database` cache store | PHP 8.3 oracle (M12/M18) |
| **Validation** | 60+ rules incl. `unique`/`exists` via D1, pipe-safe regex, `nullable`/`sometimes`/`bail`, wildcard display names, Laravel 13 messages | `kernel/tests/validator.test.mjs` |
| **D1 query builder** | `where*`/`where(fn)`, `join`/`group`/`having`/`distinct`, `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime`, `sum`/`avg`/`min`/`max`, `upsert`/`insertGetId`/`truncate`/`increment`/`updateOrInsert`/`chunk`, D1-safe param binding (bool→1/0, Date→ISO, undefined→NULL) | `kernel/tests/sqlite-integration.test.mjs` |
| **Cache** | `DatabaseCacheStore` (D1-backed `database` cache), KV cache-aside, `Cache` façade (`get`/`put`/`add`/`remember`/`increment`/`decrement`/…), `forget`/`flush` | PHP 8.3 oracle (M18) |
| **Storage** | `Storage::put()`/`get()`/`exists()`/`delete()` and `Storage::disk('<default>')` → D1 blob store (no card) or R2 (when bound); uploads `$file->store()` | M30/M39b/M40-part5 |
| **File upload** | multipart parsed at the edge, `$request->file()` answers the file object, the `file` rule, size rules in KB | M40-part5 |
| **Gate / policy** | `Gate::allows()`/`denies()` — the policy compiled at build time (`tools/policy-dump.php` → `dist/src/policies.generated.mjs`), the `before()` hook honoured | M39a |
| **Event dispatch** | `Event::dispatch(new X())` — listeners compiled, run synchronously, every listener, `false` stops, the array answer | M39c/M47/M53 |
| **Paginator** | `paginate(10)` → `LengthAwarePaginator` (items/total/pages/URL window); `$paginator->links()` renders `pagination::tailwind` byte-identical to Laravel | M40 |
| **Mail** | `Mail::to()->send()` compiles the mailable class; mailer built from `mail.default` → log/noop/resend | M28/M57 |
| **Queue | Scheduler** | `Queue::push()` fails loud (worker has no queue consumer); the schedule dumps to `dist/cron.json` + `schedule.generated.mjs`, the `scheduled` handler evaluates due events | M28/M29 |
| **Method handling** | auto `OPTIONS` (200, `Allow` header); unmatched method → 405 with `errors/405` view else 500 | M40 |
| **Route-model binding** | `show(Post $post)` — model from the route segment, 404 on miss | M40 |

### Fails loud (use a port instead)

| Construct | Why | Escape hatch |
|---|---|---|
| Blade `<x-…>` components | compile to `$__env->…` — only the layouts compile | hand-written `ports/*.mjs` |
| Controller code outside the subset | transpiler fails the build (LW001–LW004) | a `ports/` handler |
| `Queue::push(SomeJob::class)` | the job would never run at the edge — no queue handler, the binding carries JSON not a PHP job | CF Queues binding + a consumer you write; or a D1 table a cron reads |
| named `Storage::disk('x')` | needs its own bucket; R2 asks for a credit card | bind R2 explicitly, or use the default disk |
| `Cache::tags()` | the D1 `database` store has no tags | drop tags |
| CORS config | the `Access-Control-*` headers would be missing | declare the routes in `registry.json` `ignore` |

---

## What's inside

```
compiler/                 transpile Blade→PHP→JS (build time)
  src/transpiler.mjs       PHP-subset → dependency-free ESM (LW001–LW004)
  src/controller.mjs       controller methods → JS handlers
  src/policy.mjs           Gate/policy compiler (M39a)
  runtime/rt-from-context.mjs, rt*.mjs   the VM: concat, sprintf, DateTime, …
  tests/                   corpus 51 + parity + smoke + controller + policy + source-syntax

kernel/                   Workers-native runtime (request time, 0 PHP)
  http.mjs                 the compiled HTTP pipeline (M15)
  router.mjs  db.mjs  model.mjs  sqlite.mjs
  session.mjs csrf.mjs auth.mjs ratelimit.mjs hash.mjs encrypter.mjs
  validator.mjs validation.mjs php-serialize.mjs php-json.mjs
  cache.mjs storage.mjs mail.mjs queue.mjs scheduler.mjs paginator.mjs
  tests/                   502/502 (see npm run test:all)

tools/                    build-time PHP + JS helpers (boot the real app)
  schema-compile.php       migrations → in-memory SQLite → D1 DDL (driver-agnostic)
  compile-view.php  model-dump.php  constants-dump.php  formrequest-dump.php
  policy-dump.php  event-dump.php  class-dump.php  schedule-dump.php
  routes-dump.mjs  config-dump.mjs  constants-dump.mjs  (pure JS re-implementations)
  _root.php  init.mjs  vendor-lite.mjs  php-provision.mjs  php-runtime.mjs
  verify-s0.php  pack-smoke.mjs  docs-check.mjs  bench.mjs  constructs.json

shadow/                   M24 proof machine: real Laravel app (PHP 8.3) vs the
                          compiled worker, byte-wise diff of status/headers/body

build.mjs                 the pipeline: routes → controllers → views → schema →
                          config → prerender → readiness gate → dist/
```

---

## Requirements

| Component | Tested with | Requirement |
|---|---|---|
| Laravel (source of truth) | `13.37.0` (nearFind), `11.34.2` (blogkit) | **≥ 10** |
| PHP — build time only | `8.3.30` (ZTS x64, Windows) | **≥ 8.3**; parity oracle is 8.3.30 |
| Composer | none | not needed — vendor-lite provisions deps; app's own `vendor/` works too |
| Node | `22.18.0` | **≥ 22** (`engines`) |
| npm | `10.9.3` | ≥ 10 |
| Cloudflare Workers | `wrangler` `4.151.1` | 4.x; `compatibility_date` `2026-10-01` |
| PHP extensions (build only) | `pdo_sqlite`, `sqlite3` | for `tools/schema-compile.php` |

### The Cloudflare tiers we target (in order)

1. **Free plan first** — Workers (10 ms CPU/req, 50 subrequests), D1 (100k writes/day, 5M reads/day), KV, the D1 blob store (`lw_blobs` — 1.5 MB/object, **no credit card**) as the default object store. The 1008–2018 ms CPU of PHP-in-Worker fails this budget; the compiled rung is p95 ≤ 5 ms.
2. **R2 when the app really needs it** — a **named** disk, an object > 1.5 MB, or many objects. R2's free tier (10 GB-month, 1M Class A, 10M Class B) is generous, **but R2 asks for a payment method** — so the build never turns it on by itself: it prints the `wrangler.jsonc` snippet and the operator decides.
3. **The paid plan, only when the free path cannot do it** — Dynamic Workers and the full Queues (billed per op) are the only paid-only features. The toolchain stays free-plan-shaped by default; no construct is blocked *because* the free plan is too small — the build fails loud only when the edge genuinely cannot answer like PHP.

**Three levels, not two** (checked against the Cloudflare docs 2026-10-21): free plan (no card, no subscription) · Workers paid plan (a subscription) · a payment method (a card) — **R2 is the only product that needs a card**.

---

## Quick start

```bash
# in a real Laravel app (vendor + public/build there):
cd my-laravel-app
npx laravel-workers build --strict   # dist/ — vendor + APP_KEY + schema + wrangler.jsonc all automatic

# the ONE manual step (cloud provisioning the build refuses to do):
npx wrangler d1 create my-laravel-app
#   paste the returned database_id into wrangler.jsonc (the build wrote a placeholder)
npx wrangler d1 execute DB --file=dist/schema.sql --remote
npx wrangler deploy

# optional scaffold (idempotent; the build does it anyway):
npx laravel-workers init
```

From checkout (developing the toolchain, tests):

```bash
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup               # root + compiler deps
npm test                    # 502 kernel + corpus/parity/oracle
npm run test:corpus         # 51/51 — M1 transpiler corpus
npm run test:sqlite         # real in-memory SQLite integration
npx laravel-workers verify  # VERIFY-S0 15/15 (else SKIP — needs parent vendor/)
```

---

## CLI

```bash
laravel-workers init            # scaffold registry.json + wrangler.jsonc (idempotent)
laravel-workers build           # --strict (needs Laravel app root); --scaffold generates port stubs
laravel-workers verify          # php tools/verify-s0.php (SKIP when no parent vendor/)
laravel-workers shadow --app <root>   # compare real PHP app (oracle) vs compiled worker, byte-diff

# npm aliases:
npm test                # 768/768 tests
npm run test:corpus     # 51/51 transpiler corpus
npm run test:hash       # hash + encrypter only
npm run test:sqlite     # in-memory SQLite integration
npm run bench           # micro-bench p95 budget
npm run check:docs      # 105/105 docs verdicts
npm run audit:constructs # facade coverage audit
```

---

## Zero-touch / CI (Workers Builds)

Works on any Laravel ≥ 10 project — a fresh clone or an app you've been running for years. Every PHP helper boots the real Laravel app through `vendor/autoload.php` — **that is the one thing that cannot be skipped**. Everything else is automatic.

| Requirement | Old way | Now |
|---|---|---|
| PHP vendor files | `composer install` (~379 s cold) | **vendor-lite** — reads `composer.lock`, fetches dist zips from packagist, writes its own autoloader. Content-addressed cache (pays once per lock). No composer binary. |
| Database schema | `touch database/database.sqlite && php artisan migrate --force` | **`tools/schema-compile.php`** — boots app, migrates in-memory SQLite, dumps via pragma. No DB file. Driver-agnostic (MySQL/Postgres/SQLite source → same D1 DDL output). |
| `APP_KEY` | `php artisan key:generate` | **Automatic** — `build.mjs` writes `base64:<32 bytes>` into `.env` if absent. Stable across rebuilds (the worker encrypts cookies with it). `tools/_root.php` also auto-injects it for standalone tool runs. |

`registry.json` and `wrangler.jsonc` are **optional** — the build uses sensible defaults and auto-writes `wrangler.jsonc` when absent (worker name from the app-dir slug; `database_id` is a placeholder). So even the scaffolding happens at build time.

### The one manual step

The build **never provisions cloud resources**. Obtaining the D1 `database_id` requires a live call to Cloudflare:

```bash
npx wrangler d1 create my-app    # paste the returned id into wrangler.jsonc
npx wrangler d1 execute DB --file=dist/schema.sql --remote
npx wrangler deploy
```

**One honest caveat:** if `composer.json` has `"autoload-files"` pointing outside the vendor tree, vendor-lite detects this and tells you to `composer install --no-dev` — it cannot satisfy those entries from packagist.

---

## Architecture (30 s)

```
Laravel app (dev truth)
  └─ tools/*.php          S0   dump routes / compiled Blade / schema / config (PHP boots here ONLY)
  └─ tools/*.mjs          S1   transpile Blade→JS, routes→router, schema→schema.json + controllers
  └─ bundler              S2   kernel + generated → worker ESM
  └─ golden tests         S3   Laravel render vs compiled render byte-identical
  └─ --strict gate        S4   uncovered route → fail
  └─ prerender            S5   clean GET → static snapshot (0-invocation tier)
  └─ wrangler deploy      S6   deploy → Workers + D1
```

PHP boots **only at S0** (build time). The edge (S1–S6) is pure JS.

---

## Docs & checks

- `MAP.md` — full construct coverage map, 105 docs verdicts, D1 limits, unknown-to-verify list.
- `tools/constructs.json` — every `Illuminate\Support\Facades\*` (Laravel 13, 47 rows) with a verdict.
- `npm run check:docs` — 105/105. `npm run audit:constructs` — facade coverage.
- `kernel/tests/budget.test.mjs` — p95 ≤ 5 ms hot, ≤ 30 ms for the encrypter.

---

## Philosophy

- **Laravel stays Laravel** — this is the toolchain, not a framework fork.
- **Coverage enforced** — unhandled route = warning; `--strict` = failure. No silent gaps.
- **Free-plan-first** — paid is headroom, never a fallback; the build says exactly what the app needs.
- **Honest claims** — no "approach in progress" before M1 was measured; prior-art scan clean.

---

## License

MIT — see [LICENSE](LICENSE). Trademarks belong to their owners.
