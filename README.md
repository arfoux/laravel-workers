# laravel-workers

> A build-time toolchain: Laravel app in, Cloudflare Workers artifact out. Blade views, routes and the D1/read paths it can verify against PHP 8.3 are compiled to dependency-free JS at build time. What it cannot verify **fails the build** — no silently-wrong output ships.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**What it is, plainly.** A toolchain with three parts: a `compiler` (Blade → PHP → JS, byte-parity against PHP 8.3), a Workers-native `kernel` (router, D1 query builder, models, validation, services), and `build.mjs` (pipeline → `dist/kernel` + `_routes.json` + schema snapshot). Laravel stays the source of truth in dev; the edge runs compiled JS + D1, **Free-plan-safe (measured 1–6 ms)**. It is **not** a Laravel runtime and **not** PHP-in-Worker: controllers are not transpiled — those go in `ports/*.mjs`.

## Why

PHP-in-Worker (wasm) boots Laravel per request: **measured 1008–2018 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker: `static` (0 invocations) → `snapshot` (prerendered HTML) → `compiled handler` (router → handler → D1, **measured 1–6 ms**) → `port` (escape-hatch hand-written JS). Anything uncovered **fails the build** (`--strict`).

**Status: M10 complete — 0.3.1 released 2026-10-18. Compiled-rung kernel layers M11–M14 landed on `main` (2026-10-18/19); the compiled HTTP pipeline (M15), controller request/session/auth helpers (M16), POST actions (M17), the D1-backed `database` cache store + numeric `throttle` (M18), the validation flow (`$request->validate()` → redirect-back / 422 JSON, M19) and the compiled `redirect()->intended()` + session `regenerate()`/`invalidate()`/`regenerateToken()` controller methods (M20) shipped. Next per `COMPILED.md`: the 7c E2E Breeze-login diff against the PHP 8.3 oracle.**
- **M1** View parity — Blade-compiled PHP → dependency-free ESM; `welcome` byte-identical 35,647 B (sha256 `b228c8a2…`); corpus 51/51.
- **M2** Router integration — `routes → router`, code-gen `controllers/middleware`, build `--strict` PASS, `nearfind-edge` live `/` + `/health` 200.
- **M3** D1 layer — schema snapshot (`.cache/schema.json` → `dist/schema.json`), `kernel/db.mjs` query builder, `kernel/model.mjs` Model base, mock-D1 tests 8/8, `nearfind-edge` `/dbcheck` via builder, D1 remote has `config` + `_cf_KV`.
- **M4** Packaging + CI — `package.json` (`laravel-workers@0.3.0`, bin CLI), `.github/workflows/ci.yml`, MIT license, `npm pack --dry-run` clean, tests green.
- **M5** Hash + Encrypter parity (kernel/hash.mjs bcrypt make/check/needsRehash + kernel/encrypter.mjs AES-256-CBC+HMAC WebCrypto, payload iv/value/mac/tag byte-compat, incl. MAC-tamper/wrong-key)..
- **M6** Validation kernel (kernel/validator.mjs, 60+ rules incl. `unique`/`exists` via D1, pipe-safe regex, nullable/sometimes, bail, 26 subtests)
- **M7** Services kernel (kernel/mail,queue,cache,storage,scheduler.mjs, 18 subtests)
- **M8** Final gates (tools/docs-check 105/105 + tools/bench + budget.test p95<=5ms hot)
- **M9** Zero-touch hardening (2026-10-18) — scaffold stubs now follow the controller contract (default export, `{status, headers, body}`, `laravel-workers:stub` marker); `build --strict` fails on unimplemented stubs + missing port files; `LW_CONFIG`/`LW_PORTS_DIR` let registry + ports live outside the repo; `registry.json` optional (defaults + notice); routes defined outside `routes/` are listed as skipped. Verified: stub `501` keeps the worker alive → implement → `200` via local D1; external config+ports E2E; fresh Laravel 13.37 zero-config build PASS. `tools/ports.mjs` + 5 tests → npm test **170/170**.
- **M10** Controller transpilation v1 (2026-10-18) — `GET`/`HEAD` routes with a resolvable controller method are compiled at build time to `dist/src/controllers/*.mjs` (handler `(ctx, env)`): scalar route params, Eloquent chains (`find`/`findOrFail`/`all`/`where*`/`orderBy*`/`limit` + `first`/`get`/`count`/`pluck`/`value`), `view()`/`redirect()`/`abort()`/`compact()`/`response()->json()`, `route()`/`url()` from the frozen name map; model metadata dumped per FQCN; unsupported constructs fail loud (LW001–LW004 with a "write a port" hint). Verified on a fresh Laravel 13.37 app end-to-end: `--strict` build (snapshot `/` + 2 controllers) and `wrangler dev` against local D1 (`/posts` list, `/posts/1` detail, `/posts/999` → 404 via `findOrFail`). npm test **195/195**, corpus 51/51.
- **M11** Session kernel parity (2026-10-18) — `kernel/session.mjs`: PHP `Store` semantics (flash `_flash.new`/`_flash.old` rotation, `_token`, `ageFlashData`, `migrate`/`regenerate`/`invalidate`) behind cookie + D1 handlers; byte-identical cookie payloads vs the PHP 8.3 oracle (deterministic via `freeze_ms`/`render_now`).
- **M12** Rate limiting parity (2026-10-18) — `kernel/ratelimit.mjs`: `RateLimiter` + `ThrottleRequests` incl. named `for()` limiters, middleware `using()` prefix, HeaderBag last-limit-wins, PHP falsy/numeric/int semantics; PHP 8.3 oracle.
- **M13** CSRF parity (2026-10-18) — `kernel/csrf.mjs`: `PreventRequestForgery` token resolution (session / `X-CSRF-TOKEN` / `X-XSRF-TOKEN`), `except()` (SORT_STRING dedupe), `normalizeQueryString` (hex-key parse, ksort, RFC3986), XSRF cookie shape; PHP 8.3 oracle.
- **M14** Auth parity (2026-10-19) — `kernel/auth.mjs`: `SessionGuard` (attempt/attemptWhen/once/validate/login/logout/logoutOtherDevices, `viaRemember`), remember-me recaller + rotation + hmac cookie, `EloquentUserProvider`, `BcryptHasher` (`$2y$`-only, `needsRehash`/`verifyConfiguration`), `AuthManager`, `auth`/`guest` middleware, auth events. `tools/php-auth-oracle.php` + `kernel/tests/auth.test.mjs`: 13 guard runs compared 1:1 (session bytes, DB rows, event stream, Set-Cookie bytes), recaller hostile-payload corpus, hasher ops. npm test **269/269**.
- **M15** Compiled HTTP pipeline (2026-10-19) — `kernel/http.mjs` (`handleHttp`): runs the `web` group in vendor order (`EncryptCookies → AddQueuedCookiesToResponse → StartSession → ShareErrorsFromSession → PreventRequestForgery → throttle → route`) plus `auth`/`guest` route middleware, resolves provider models through `models.generated.mjs`, emits Symfony-shaped `cache-control`/redirect bodies. `tools/php-http-pipeline-oracle.php` + `kernel/tests/http.test.mjs`: an 11-step scenario (anonymous → login → CSRF failure → logout) compared **per step** on status, headers, `Set-Cookie` attributes, body and the raw D1 session payload bytes, plus `parsePhpQuery` vs live PHP `parse_str` (29 cases; the NUL-in-key divergence is pinned fail-closed) and fail-loud guards. npm test **276/276**.
- **M16** Compiled controllers — request + session/auth helpers (2026-10-19) — `Request $request` injection, `session()`/`session('k')`/`old()`/`csrf_token()`/`csrf_field()`/`request()`, `auth()`/`Auth::check|guest|user|id` (guarded by await-injection; the guard resolves the user asynchronously), and a `$request->method()` allowlist (`input`/`all`/`query`/`has`/`string`/`header`/`ip`/`user`/`session`/…). `$request->validate()` and files fail loud (need D1 + a port). npm test **282/282**.
- **M17** POST controller actions (2026-10-19) — the build now transpiles single-method `POST` actions, not just `GET`/`HEAD` (`build.mjs` `methodsOk`); the compiled handler is registered under `METHOD uri` and the router dispatches it. A route that answers several verbs on one uri still needs a port. Verified 1:1 on the fixture app: `POST /submit` (with `Request $request`) → `302`, `location: /posts`; `GET /submit` matches nothing (no handler). npm test **282/282**.
- **M18** D1 cache store + `throttle` middleware (2026-10-19) — `kernel/cache.mjs` gains `DatabaseCacheStore` mirroring `Illuminate\Cache\DatabaseStore` 13.37 (values `serialize()`d via `php-serialize.mjs` with the SQLite/Postgres NUL-byte→base64 rule, expiry as integer second timestamps, `add` = `INSERT OR IGNORE`, `put` = upsert, `forever` = +315360000 s, expired = read-then-delete, `currentTime()` = `Carbon::now()->getTimestamp()`). The `RateLimiter`/`ThrottleRequests` path is now async so it can drive the D1 store (each cache op is a round trip; `await` is a no-op on the sync `ArrayCacheStore`). `tools/php-cache-oracle.php` + `kernel/tests/cache.test.mjs`: put/add/forever/get/has/increment/decrement/forget/touch/flush replayed against the real `Repository` over SQLite, comparing return values **and the raw `cache` rows** 1:1. The build now emits `middleware` into `routes.generated.mjs` — it was previously dropped, which silently downgraded every compiled route to the session-less bare path — and honours numeric `throttle:n[,m]`, failing loud on named limiters and when `cache.driver !== 'database'`. `tools/config-dump.php` now emits `cache.{default,prefix,driver,table,lock_table,serializable_classes}` and `src/worker.mjs` builds the store from the D1 binding. npm test **288/288**.
- **M19** Validation flow — `$request->validate()` / `validateWithBag()` (2026-10-19) — compiled controllers may now call `$request->validate($rules, $messages?, $attributes?)`; the transpiler awaits a live `rt.request().validate(...)` that runs `kernel/validator.mjs` over the request input (D1 binding passed for `unique`/`exists`). A failure throws a new `ValidationException` (`kernel/validation.mjs`, mirroring `Illuminate\Validation\ValidationException`: status 422, `errorBag`, `redirectTo`, the `summarize()` "(and N more error(s))" message) which the compiled controller rethrows so `handleHttp` renders it like `Illuminate\Foundation\Exceptions\Handler` — a 302 back to `url()->previous()` (Referer → flashed previous URL → `/`) with `_old_input` (everything except `Handler::$dontFlash` = `current_password`/`password`/`password_confirmation`) and the `errors` bag flashed in the `Store::prepareErrorBagForSerialization` json shape (`{ bag: { format: ':message', messages } }`), or a 422 `{ message, errors }` body for `expectsJson`. Non-json session serialization (the `ViewErrorBag` `serialize()` path) fails loud. `kernel/tests/validation.test.mjs` (11 tests: exception surface, `installValidation`, and the compiled pipeline redirect/422/valid + fail-loud paths) -> npm test **300/300**.
- **M20** `redirect()->intended()` + controller session rotation (2026-10-19) — `redirect()->intended($default = '/')` compiles to `rt.redirect(rt.session().pull("url.intended", "/"))`, mirroring `Illuminate\Routing\Redirector::intended()` (the `url.intended` key the `auth` middleware writes on a guest redirect; default `/`). Compiled controllers may now call `session()->regenerate()` / `invalidate()` / `regenerateToken()` (and through `$request->session()`); `regenerate`/`invalidate`/`migrate` are awaited against the handler while `regenerateToken()` stays sync, matching `Illuminate\Session\Store`. With `$request->validate()` (M19) and `Auth::attempt` (M16) a stock Breeze-shaped login controller now compiles end-to-end; the only remaining gap is a class-constant default such as `RouteServiceProvider::HOME` (use a string literal or a port) and FormRequests. `compiler/tests/controller.test.mjs` (+3: `intended()` default + arg, session-method await/sync codegen, and a runtime `intended()` pull + regenerate ordering test) -> npm test **303/303**.

## Supported vs unsupported

Compiles today (byte-parity corpus + kernel tests):
- **Blade → PHP** is compiled by the real Laravel Blade compiler at build time; the transpiler consumes the resulting PHP subset: `echo`, `if/elseif/else`, `for`/`while`/`foreach` (incl. `key => value`), PHP comparison/logic semantics (`==`/`!=`/`===`/`!==`/`<`/`>`/`<=`/`>=`, `&&`/`||`/`and`/`or`/`!`), ternary/`?:`, `??`/`??=`, `switch` (loose, fallthrough), `match` (strict), `isset()`/`empty()`, function declarations (defaults, recursion), string interpolation (`"$x"`, `"{$a['k']}"`, escapes), string concat, `e()`, `sprintf`, `str_replace`, `strtolower`/`strtoupper`/`trim`/`strlen`/`substr`/`str_repeat`/`str_pad`/`ucfirst`/`lcfirst`, `str_contains`/`str_starts_with`/`str_ends_with`, `count`/`in_array`/`implode`/`explode`/`number_format`/`nl2br`, `array_keys`/`array_values`/`array_merge`/`array_key_exists`, `ltrim`/`rtrim`/`ucwords`/`strrev`/`strpos`/`strrpos`/`substr_count`/`strip_tags`/`htmlspecialchars`, `is_null`/`is_bool`/`is_int`/`is_float`/`is_string`/`is_array`/`is_object`/`is_numeric`, `abs`/`round`/`floor`/`ceil`/`intval`/`floatval`/`max`/`min`, `json_encode`/`json_decode`, `array_sum`/`array_slice`/`array_reverse`/`array_unique`/`array_count_values`/`array_flip`/`array_filter`/`array_map` (named-function callbacks).
- **Kernel**: router (domain rules + `{param}`/`{param?}`/`{param*}`, `X-HTTP-Method-Override`) + response, D1 query builder (where/or + `where(fn)` grouping, join/group/having/distinct, `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime`, `sum`/`avg`/`min`/`max`, `upsert`/`insertGetId`/`truncate`/`increment`/`updateOrInsert`/`chunk`, D1-safe param binding: boolean→1/0, Date→ISO, undefined→NULL), Model base + relations (`hasMany`/`hasOne`/`belongsTo`, `create`/`firstOrCreate`/`updateOrCreate` honouring `fillable` + mutators + casts, `refresh`/`increment`, casts incl. `json`/`decimal:N`, accessors/mutators `getFooAttribute`/`setFooAttribute`, `hidden`/`visible`/`appends`, `softDeletes` with `trashed`/`restore`/`forceDelete`/`withTrashed`/`onlyTrashed`, `findOrFail`/`firstOrFail`, declared relations with `with()` eager loading + `withCount()` counters + `withSum()`/`withAvg()`/`withMin()`/`withMax()` aggregate attributes + `whereHas()`/`whereDoesntHave()`/`has(rel,'>=',n)` correlated `EXISTS`/`COUNT`, `related()`/`load()` lazy loading, local scopes via `query(db).scope('name')`), bcrypt hash incl. `Hash::isHashed()`, AES encrypter, validator (70+ rules, nested dot paths + `items.*.name` wildcards, `exclude*`/`missing*`/`present*` conditionals), mail/queue/cache/storage/scheduler adapters.

Fails loud (build error or `LW002`), use a port instead:
- Blade layouts/components that compile to `$__env->…` (`@extends`/`@section`/`@yield`/`@include`).
- Controller code outside the compiled subset: only single-method `GET`/`HEAD`/`POST` actions with a resolvable class method are transpiled (a route that answers several verbs on one uri still needs a port; uploaded files fail loud). `Request $request` injection plus `session()`/`old()`/`csrf_token()`/`csrf_field()`/`request()`/`auth()`/`Auth::*` and `$request->validate()`/`validateWithBag()` are supported at runtime (`auth`/`guest` route middleware is honoured by `handleHttp`; numeric `throttle:n[,m]` runs on the D1-backed `database` cache store, and the build fails loud on named limiters — `throttle:name` needs its `AppServiceProvider` definition — and when `cache.driver !== 'database'`). A failed `validate()` renders like Laravel: 302 back with flashed `errors` + `_old_input`, or 422 JSON for `expectsJson` (json session serialization; the `ViewErrorBag` `serialize()` path fails loud). Route-model binding parameters, `paginate`, Eloquent relations, `$this`, and unknown constructs fail loud — write a `ports/*.mjs` handler.


## What's inside

- `compiler/` — **M1 view compiler** + **M10 controller compiler**: `bin/transpile.mjs` (php-parser 3.7.0, codes `LW001`–`LW004` fail-loud), `bin/controller.mjs`, `src/transpiler.mjs`, `src/controller.mjs`, `runtime/rt-from-context.mjs`, `tests/` (corpus 51, parity, smoke, controller).
- `kernel/` — Workers-native runtime: `router.mjs` + `response.mjs` (W3), `db.mjs` + `model.mjs` (M3 D1 builder + Model), `hash.mjs` + `encrypter.mjs` (M5), `validator.mjs` (M6) + `{mail,queue,cache,storage,scheduler}.mjs` (M7), `session.mjs` + `csrf.mjs` + `ratelimit.mjs` + `auth.mjs` (M11–M14 compiled-rung layers, PHP-8.3-oracle-verified), `cache.mjs` `DatabaseCacheStore` (M18, D1-backed `database` cache for `throttle`), `validation.mjs` `ValidationException` + session error-bag shape (M19, drives `handleHttp`'s redirect-back/422), `http.mjs` (M15 compiled HTTP pipeline), budget gate (M8).
- `tools/` — build-time PHP: `compile-view.php` (S0 dump), `prerender.php`, `model-dump.php` (M10 Eloquent metadata), `verify-s0.php`, `schema-dump.php`, `docs-check.mjs` + `bench.mjs` (M8 gates; `pragma_table_info` fallback, D1 AUTH-safe).
- `build.mjs` — app build pipeline (copies into a Laravel app's build dir; `dist/kernel` layout + `dist/schema.json` snapshot + `routes.generated.mjs` route table with names/domains and a `routeNames` map + `public/_routes.json` for Cloudflare Static Assets).
- `MAP.md` — the map (+105/105 Laravel 13.x docs verdicts, tolerance model, budgets, prior-art policy).

## Requirements

Versions actually tested (byte-parity corpus + CI + live deploy):

| Component | Tested with | Requirement |
| --- | --- | --- |
| Laravel | `13.37.0` (nearFind, app-breeze), `11.34.2` (blogkit) | 10–13 as source of truth |
| PHP — build time only | `8.3.30` (ZTS x64, Windows) | **≥ 8.3**; parity oracle is 8.3 (other minors untested) |
| Composer | `2.9.4` | 2.x, for the app's own `composer install` |
| Node | `22.18.0` | **≥ 22** (`engines`) |
| npm | `10.9.3` | ≥ 10 |
| Cloudflare Workers | `wrangler` `4.151.1` | 4.x; `compatibility_date` `2026-08-01` (live corpus) / `2026-10-01` (`init` template) |

- Laravel app as source of truth (Vite unchanged, sessions/CSRF off by default in this pipeline).
- `php-parser@3.7.0` (npm) for the compiler, `bcryptjs@2.4.3` for `kernel/hash` (pure JS, no native).
- Cloudflare account for deploy (D1 binding id `ad5876a0-c5eb-493c-917e-5e8f0e543200` in this repo's test Wrangler). **Free plan safe — measured 1–6 ms CPU.**

## Quick start

```bash
# 1) As an npm package in a real Laravel app (recommended):
cd my-laravel-app             # artisan + vendor + public/build there
npm i laravel-workers
npx laravel-workers init             # writes registry.json + wrangler.jsonc, updates .gitignore
composer install; npm run build
npx laravel-workers build --strict   # dist/ (cwd-based, no edge/ required); --scaffold for port stubs
# local preview/deploy: npx wrangler deploy

# 2) From checkout (tests / legacy edge layout):
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup                 # root + compiler deps

npm test                      # 170/170 - router + db/model + sqlite + hash + encrypter + validator + services + routes-json + registry-json + ports + budget
npm run test:corpus           # 51/51 — M1 transpiler corpus
npm run test:hash             # 7/7  — hash + encrypter only

# verify/build against the parent Laravel checkout (legacy edge/ also works):
npx laravel-workers verify    # VERIFY-S0 15/15 (else SKIP)
npx laravel-workers build     # --strict build; reads registry.json / edge/registry.json from app cwd
```

## CLI

```bash
laravel-workers test            # all kernel tests (170)
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

# npm aliases do the same:
npm test                      # kernel
npm run test:corpus
npm run build
npm run verify
# also: npm run bench / npm run check:docs / npm run test:budget / npm run test:services etc.
```

## Zero-touch / CI (Workers Builds)

Keep the repo pure Laravel — config and ports can live outside it:

- `LW_CONFIG=../edge-config/registry.json` — registry path override (relative to the app root; a set-but-missing file **fails the build**).
- `LW_PORTS_DIR=../edge-ports` — port directory override, checked before `src/ports`, `ports/`, `edge/src/ports` (a set-but-missing dir **fails the build**).
- `registry.json` is **optional**: without it the build uses defaults (`autoSnapshot` on, no ports/ignore). Unhandled routes still fail `--strict`, and a registered port without a matching file fails the build.
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
  "d1_databases": [ { "binding": "DB", "database_name": "my-app", "database_id": "<wrangler d1 create id>" } ],
  "observability": { "enabled": true } }
JSONC
composer install --no-interaction
cp .env.example .env && php artisan key:generate
php artisan migrate --force
npm run build
npx -y laravel-workers@0.3.0 build --strict
# deploy command: npx wrangler deploy
```

The build image must provide PHP ≥ 8.3 + Composer (build time only).

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
