# laravel-workers

> Run a Laravel app on Cloudflare Workers with **no PHP at request time** — build-time boot → Workers-native artifact. Blade views compile to ESM; anything outside the supported subset **fails the build** and falls back to a hand-written port.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One-liner:** Laravel stays the source of truth for dev; the edge runs compiled JS + D1. No wasm, no PHP boot per request — **Free-plan-safe (10 ms CPU)**.

## Why

PHP-in-Worker (wasm) boots Laravel per request: **measured 1008–2018 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker: `static` (0 invocations) → `snapshot` (prerendered HTML) → `compiled handler` (router → handler → D1, **measured 1–6 ms**) → `port` (escape-hatch hand-written JS). Anything uncovered **fails the build** (`--strict`).

**Status: M8 complete (2026-10-18).**
- **M1** View parity — Blade-compiled PHP → dependency-free ESM; `welcome` byte-identical 35,647 B (sha256 `b228c8a2…`); corpus 46/46.
- **M2** Router integration — `routes → router`, code-gen `controllers/middleware`, build `--strict` PASS, `nearfind-edge` live `/` + `/health` 200.
- **M3** D1 layer — schema snapshot (`.cache/schema.json` → `dist/schema.json`), `kernel/db.mjs` query builder, `kernel/model.mjs` Model base, mock-D1 tests 8/8, `nearfind-edge` `/dbcheck` via builder, D1 remote has `config` + `_cf_KV`.
- **M4** Packaging + CI — `package.json` (`laravel-workers@0.3.0`, bin CLI), `.github/workflows/ci.yml`, MIT license, `npm pack --dry-run` clean, tests green.
- **M5** Hash + Encrypter parity (kernel/hash.mjs bcrypt make/check/needsRehash + kernel/encrypter.mjs AES-256-CBC+HMAC WebCrypto, payload iv/value/mac/tag byte-compat, incl. MAC-tamper/wrong-key)..
- **M6** Validation kernel (kernel/validator.mjs, 60+ rules incl. `unique`/`exists` via D1, pipe-safe regex, nullable/sometimes, bail, 26 subtests)
- **M7** Services kernel (kernel/mail,queue,cache,storage,scheduler.mjs, 18 subtests)
- **M8** Final gates (tools/docs-check 105/105 + tools/bench + budget.test p95<=5ms hot)

## Supported vs unsupported

Compiles today (byte-parity corpus + kernel tests):
- **Blade → PHP** is compiled by the real Laravel Blade compiler at build time; the transpiler consumes the resulting PHP subset: `echo`, `if/elseif/else`, `for`/`while`/`foreach` (incl. `key => value`), PHP comparison/logic semantics (`==`/`!=`/`===`/`!==`/`<`/`>`/`<=`/`>=`, `&&`/`||`/`and`/`or`/`!`), ternary/`?:`, `??`/`??=`, `switch` (loose, fallthrough), `match` (strict), `isset()`/`empty()`, function declarations (defaults, recursion), string interpolation (`"$x"`, `"{$a['k']}"`, escapes), string concat, `e()`, `sprintf`, `str_replace`, `strtolower`/`strtoupper`/`trim`/`strlen`/`substr`/`str_repeat`/`str_pad`/`ucfirst`/`lcfirst`, `str_contains`/`str_starts_with`/`str_ends_with`, `count`/`in_array`/`implode`/`explode`/`number_format`/`nl2br`, `array_keys`/`array_values`/`array_merge`/`array_key_exists`.
- **Kernel**: router (domain rules + `{param}`/`{param?}`/`{param*}`, `X-HTTP-Method-Override`) + response, D1 query builder (where/or + `where(fn)` grouping, join/group/having/distinct, `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime`, `sum`/`avg`/`min`/`max`, `upsert`/`insertGetId`/`truncate`/`increment`/`updateOrInsert`/`chunk`), Model base + relations (`hasMany`/`hasOne`/`belongsTo`, `firstOrCreate`/`updateOrCreate`, `refresh`/`increment`, casts incl. `json`/`decimal:N`, accessors/mutators `getFooAttribute`/`setFooAttribute`, `hidden`/`visible`/`appends`, `softDeletes` with `trashed`/`restore`/`forceDelete`/`withTrashed`/`onlyTrashed`, `findOrFail`/`firstOrFail`), bcrypt hash, AES encrypter, validator (60+ rules, nested dot paths + `items.*.name` wildcards), mail/queue/cache/storage/scheduler adapters.

Fails loud (build error or `LW002`), use a port instead:
- Blade layouts/components that compile to `$__env->…` (`@extends`/`@section`/`@yield`/`@include`).
- Non-view routes: PHP controllers are **not** transpiled — write a `ports/*.mjs` handler.


## What's inside

- `compiler/` — **M1 view compiler**: `bin/transpile.mjs` (php-parser 3.7.0, codes `LW001`–`LW004` fail-loud), `src/transpiler.mjs`, `runtime/rt-from-context.mjs`, `tests/` (corpus 46, parity, smoke).
- `kernel/` — Workers-native runtime: `router.mjs` + `response.mjs` (W3), `db.mjs` + `model.mjs` (M3 D1 builder + Model), `hash.mjs` + `encrypter.mjs` (M5), `validator.mjs` (M6) + `{mail,queue,cache,storage,scheduler}.mjs` (M7), budget gate (M8).
- `tools/` — build-time PHP: `compile-view.php` (S0 dump), `prerender.php`, `verify-s0.php`, `schema-dump.php`, `docs-check.mjs` + `bench.mjs` (M8 gates; `pragma_table_info` fallback, D1 AUTH-safe).
- `build.mjs` — app build pipeline (copies into a Laravel app's build dir; `dist/kernel` layout + `dist/schema.json` snapshot + `routes.generated.mjs` route table with names/domains and a `routeNames` map + `public/_routes.json` for Cloudflare Static Assets).
- `MAP.md` — the map (+105/105 Laravel 13.x docs verdicts, tolerance model, budgets, prior-art policy).

## Requirements

- Laravel 10/11/12/13 app as source of truth (Vite unchanged, sessions/CSRF off by default in this pipeline).
- **Node ≥ 22**, **PHP ≥ 8.3**, `php-parser` (npm) for the compiler, `bcryptjs` for `kernel/hash` (pure JS, no native).
- Cloudflare account for deploy (`wrangler`, D1 binding id `ad5876a0-c5eb-493c-917e-5e8f0e543200` in this repo's test Wrangler).

## Quick start

```bash
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup                 # root + compiler deps

npm test                      # 93/93 — router + db/model + hash + encrypter + validator + services + routes-json + budget
npm run test:corpus           # 46/46 — M1 transpiler corpus
npm run test:hash             # 7/7  — hash + encrypter only

# when your Laravel vendor/ is in the parent checkout:
npx laravel-workers verify    # VERIFY-S0 15/15 (else SKIP)
npx laravel-workers build     # inside an edge checkout (requires Laravel vendor)
```

## CLI

```bash
laravel-workers test            # all kernel tests (93)
laravel-workers test:db          # db/model only
laravel-workers test:hash       # hash + encrypter only
laravel-workers test:validator  # validator only
laravel-workers test:services   # mail/queue/cache/storage/scheduler
laravel-workers test:budget     # budget gate only
laravel-workers test:corpus     # transpiler corpus (46)
laravel-workers bench           # micro-bench (bench.mjs)
laravel-workers check:docs      # docs-check 105/105
laravel-workers build           # node build.mjs --strict (needs Laravel app)
laravel-workers verify          # php tools/verify-s0.php (SKIP when no parent vendor/)

# npm aliases do the same:
npm test                      # kernel
npm run test:corpus
npm run build
npm run verify
# also: npm run bench / npm run check:docs / npm run test:budget / npm run test:services etc.
```

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
- `kernel/tests/{router,db,hash,encrypter,validator,services,budget}.test.mjs` — M5 proves `make`/`check`/`encryptString`/`decryptString` round-trip, tamper, wrong-key, unicode.

## Philosophy

- **Laravel stays Laravel** — this is the toolchain, not app code; no fork of framework.
- **Coverage enforced** — unhandled route = warning; `--strict` = failure. No silent gaps.
- **Free-plan-first** (`10ms` CPU, `50` subrequests, `5M` D1 reads/day) — Paid is headroom, never a fallback.
- **Honest claims** — "approach in progress" until M1–M5 measured; prior-art scan stays clean before any "discovery" claim.

## Roadmap (living)

- **M6** Validation kernel — done (M6).
- **M7** Services kernel — done (M7).
- **M8** Final gates — done: docs-check 105/105 + bench/budget p95 ≤5ms + CI + pack green.

## License

MIT — see [LICENSE](LICENSE). Trademarks belong to their owners.
