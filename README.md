# laravel-workers

> Compile your Laravel app to a tiny JS bundle that runs on Cloudflare Workers.
> No PHP at the edge. No WASM. No cold-start drama.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

**What makes this different.**

Most edge-Laravel projects still run PHP somewhere — Octane, WASM, or a separate PHP host. That means PHP cold starts (~1000–2000 ms CPU), WASM bootstrapping, or a permanently warm PHP server to call.

`laravel-workers` takes the opposite approach: **compile at build time, run pure JS at the edge.**

```
Laravel app (your dev machine)
  └─ laravel-workers build
       ↓ Blade → PHP → JS  (real Laravel compiler, byte-parity verified)
       ↓ routes + models + config → generated JS modules
  → dist/  (a small ESM bundle)
       ↓ wrangler deploy
  Cloudflare Workers  (V8 isolates — the same runtime as every other Worker)
```

The edge is just a Worker. It boots in **microseconds** (V8 isolates, no PHP, no WASM), runs your Blade views, queries D1, manages sessions — all in ~**5 ms CPU** (p95, measured by `kernel/tests/budget.test.mjs`).

What this is **not:** a Laravel runtime, or PHP-in-Worker. Your Laravel app is the source of truth in development; the edge runs compiled output that was verified byte-identical against PHP 8.3 during the build. Any construct the compiler cannot handle **fails the build** — no silently wrong answer ships.

**Construct coverage:** 114 audited — 41 compile, 63 fail loud with specific reasons, 10 documented at the build level. Every Laravel 13 façade has a row in `tools/constructs.json`.

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
  tests/                   526/526 (see npm test)

tools/                    build-time PHP + JS helpers (boot the real app)
  schema-compile.php       migrations → in-memory SQLite → D1 DDL (driver-agnostic)
  compile-view.php         phase worker: view batches, recursive `make()` closure
  model-dump.php  constants-dump.php  formrequest-dump.php  policy-dump.php
  metadata-phase.php       ONE boot: recursive models + policies + FormRequests
  event-dump.php  class-dump.php  schedule-dump.php
  routes-dump.mjs  config-dump.mjs  constants-dump.mjs  (pure JS re-implementations)
  build-cache.mjs          SHA-256 content key for the unchanged-input fast path
  _root.php  init.mjs  vendor-lite.mjs  php-provision.mjs  php-runtime.mjs
  verify-s0.php  pack-smoke.mjs  docs-check.mjs  bench.mjs  constructs.json

shadow/                   M24 proof machine: real Laravel app (PHP 8.3) vs the
                          compiled worker, byte-wise diff of status/headers/body

build.mjs                 phase-scoped workers — ONE Laravel boot per phase that
                          has work (schema → prerender → route/error views →
                          metadata → controller views) + the unchanged-input
                          build cache → readiness gate → dist/
```

---

## Requirements

| Component | Tested with | Requirement |
|---|---|---|
| Laravel (source of truth) | `13.37.0` (nearFind), `11.34.2` (blogkit) | **≥ 10** |
| PHP — build time only | `8.3.30` (ZTS x64, Windows) | **≥ 8.3**; parity oracle is 8.3.30 |
| Composer | none | not needed — vendor-lite provisions deps; app's own `vendor/` works too |
| Node | `22.18.0` | **≥ 22** (`engines`) |
| Bun | `1.4.0` | **≥ 1.0** (full test suite passes — `bun run test` → 800/800) |
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
npm test                    # 800/800 — kernel + compiler + parity harnesses
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
npm test                # 800/800 tests
npm run test:corpus     # 51/51 transpiler corpus
npm run test:hash       # hash + encrypter only
npm run test:sqlite     # in-memory SQLite integration
npm run bench           # micro-bench p95 budget
npm run check:docs      # 105/105 docs verdicts
npm run audit:constructs # facade coverage audit
```

---

## Zero-touch / CI (Workers Builds)

Works on any Laravel ≥ 10 project — a fresh clone or an app you've been running for years. Every **PHP phase worker** boots the real Laravel app through `vendor/autoload.php` — the one thing only a cache hit can skip (see the *build phases* below). Everything else is automatic.

| Requirement | Old way | Now |
|---|---|---|
| PHP vendor files | `composer install` (~379 s cold) | **vendor-lite** — reads `composer.lock`, fetches dist zips from packagist, writes its own autoloader. Content-addressed cache (pays once per lock). No composer binary. |
| Database schema | `touch database/database.sqlite && php artisan migrate --force` | **`tools/schema-compile.php`** — boots app, migrates in-memory SQLite, dumps via pragma. Your `database/` is never touched: when the app has no database file, the build seeds a throwaway SQLite in `.cache/` (schema applied, empty) so it can boot for prerender. Driver-agnostic (MySQL/Postgres/SQLite source → same D1 DDL output). |
| `APP_KEY` | `php artisan key:generate` | **Automatic** — `build.mjs` writes `base64:<32 bytes>` into `.env` if absent. Stable across rebuilds (the worker encrypts cookies with it). `tools/_root.php` also auto-injects it for standalone tool runs. |

`registry.json` and `wrangler.jsonc` are **optional** — the build uses sensible defaults and auto-writes `wrangler.jsonc` when absent (worker name from the app-dir slug; `database_id` is a placeholder). So even the scaffolding happens at build time.

### Build phases: one Laravel boot per phase (measured)

A full build runs every PHP-live step as a phase-scoped worker. Each phase boots
Laravel **at most once** — not at all when its job list is empty — and processes
each closure inside that same boot (view `make()` dependency closure, model
relation closure, policy models). Route export, config, schedule, events, class
metadata, constants and controller extraction never call PHP:

| Phase | Worker | Laravel boots | When |
|---|---|---|---|
| schema | `tools/schema-compile.php` | 1 | always |
| snapshots | `tools/prerender.php` | 0–1 | when prerender URIs exist |
| render: route + error views | `tools/compile-view.php` (`--batch`, recursive) | 1 | always (10 framework error views always queue) |
| metadata | `tools/metadata-phase.php` | 0–1 | when models / FormRequests exist |
| render: controller views | `tools/compile-view.php` (`--batch`, recursive) | 0–1 | when controllers exist |

**Measured, not estimated:** instrumenting every PHP process a `--no-cache`
build spawns (`PHP_INI_SCAN_DIR` + `auto_prepend_file` logger) on the 43-route
fixture recorded **exactly 5 Laravel boots** — schema → snapshots →
route/error views → metadata → controller views — plus one `php -r` version
probe from `resolvePhp` (a process, no app boot). The pre-Track-F typical was
5–11+ boots by static trace; a boot measured 2.8–5.1 s cold in
`docs/PLAN-VENDOR.md`.

### Build cache: unchanged inputs → 0 Laravel boots

Before any live work, `build.mjs` (`tools/build-cache.mjs`) hashes its inputs by
**content**, not mtime — 199 files / ~3.0 MB on the fixture app: app sources
(`app/`, `bootstrap/`, `config/`, `database/`, `routes/`, `lang/`,
`resources/views`, `resources/lang`, `public/`), Composer identity files + the
installed autoloader, build-tool sources (`tools/`, `compiler/`, `kernel/`,
`bin/`, `src/`), Vite/Tailwind/PostCSS configs + manifests, `.env`, the PHP
version, CLI flags and the curated `LW_*` env keys.

- **Hit** = the stamp at `<app>/.cache/laravel-workers/build-cache.json` carries
  the same key **and** `dist/` still contains the files every build emits
  (`src/worker.mjs`, `src/routes.generated.mjs`, `src/config.generated.mjs`,
  `schema.json`, `public/_routes.json`). A deleted or half-written dist is a
  miss, never a stale worker. Measured: **≈1.3 s** vs **≈35 s** full on the same
  machine (0 Laravel boots, 1 PHP version probe).
- **Not hashed** — identified by cheaper files instead: `vendor/` bytes
  (`composer.lock` + `vendor/composer/installed.php` + the autoloader are
  hashed), `node_modules/` (`package.json` + lock), `storage/`, `tests/`,
  `.cache/`, `dist/`.
- **Write-through**: `--no-cache` / `LW_NO_BUILD_CACHE=1` skips only the hit
  check; a successful forced build still refreshes the stamp. Reason: a forced
  build mutates hashed inputs itself (the prerender boots write sessions
  through the app's sqlite cache table, inside hashed `database/`) — without
  the write-through, the build right after a forced one paid an unexplained
  full rebuild.
- **Escape hatch for the unmodelled**: the cache models input *content*; it
  cannot see out-of-band `storage/` edits or vendor sources changed without a
  lock change — the same `--no-cache` is the answer. Stated plainly: a data-only
  change to the sqlite file under `database/` invalidates correctly; anything
  the key does not hash does not invalidate.

### The one manual step

The build **never provisions cloud resources**. Obtaining the D1 `database_id` requires a live call to Cloudflare:

```bash
npx wrangler d1 create my-app    # paste the returned id into wrangler.jsonc
npx wrangler d1 execute DB --file=dist/schema.sql --remote
npx wrangler deploy
```

**One honest caveat:** if `composer.json` has `"autoload-files"` pointing outside the vendor tree, vendor-lite detects this and tells you to `composer install --no-dev` — it cannot satisfy those entries from packagist.

### Fullstack app vs backend-only API

Laravel is two halves and the build treats them as two halves. Which one you have decides whether the frontend needs building at all:

| Your app | Needs `public/build/`? | What the build does |
|---|---|---|
| **Fullstack** — any Blade view calls `@vite()`/`mix()` (a stock `laravel new` is one: `welcome.blade.php`) | **Yes** — the compiled HTML embeds the hashed asset URLs read from `public/build/manifest.json` | builds the frontend itself: your own `package.json`'s `build` script, run with **bun** (installed first if `node_modules` is absent) and **npm as the automatic fallback**, then verifies the manifest |
| **Backend-only** — no view touches the frontend (a JSON API) | **No** — nothing reads it | logs `backend-only (no frontend build needed)` and proceeds |

`build.mjs` pre-scans `resources/views/**` before compiling — it decides upfront, not after shipping `<script src>` tags that point at files nobody built. When there is nothing it *can* run — no `package.json`, no `build` script, neither `bun` nor `npm` on `PATH`, or the frontend build itself fails — it stops with the exact view named and the exact command that failed.

`laravel-workers` compiles the **backend**; **Vite** builds the **frontend** — and the build runs that step for you, in your app directory, with your own toolchain. **Bun is tried first** (it is an engine of this toolchain); **npm takes over automatically** when bun is not on `PATH` or its install/build fails. Dependencies are installed only when `node_modules` is absent, so an existing tree is never touched; a fresh install is the only network this step takes. The result (`public/build`) is copied to `dist/public`, where Workers Static Assets serves it **from the same origin as the worker**. There is no second port in production: the `artisan :8000` + `vite :5173` pair exists only under `composer run dev`.

### What `RUNS ON THE EDGE` claims (and what it does not)

It is a claim about **routes, not data**: every route has a compiled handler, a snapshot or a port; nothing is ignored; no binding is missing. It does **not** claim your database exists — you apply `dist/schema.sql` to the remote D1 yourself, once, **before the first deploy** (see *The one manual step*).

To render pages the build boots your app, and a Laravel app reads its own `sessions` table on every request — which used to make a fresh `laravel new` project report `DOES NOT RUN` for no reason at all. So when your own `database/database.sqlite` is absent, the build gives the app a throwaway SQLite (`.cache/laravel-workers/build.sqlite`, your schema applied, **empty**) for the duration of the build. It is not your database and not the cloud D1. Your existing database file, when present, is used as-is.

The honest consequence: a page that reads rows the build has never seen prerenders as it looks **with an empty table**. Run it against real data after `d1 execute`, or decide such a route explicitly (`registry.json` → `ports`/`static`/`ignore`).

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
