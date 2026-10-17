# laravel-workers

> Run **any Laravel app** on Cloudflare Workers with **no PHP at request time** — build-time boot → Workers-native artifact.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-laravel--workers-9cf.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One-liner:** Laravel stays the source of truth for dev; the edge runs compiled JS + D1. No wasm, no PHP boot per request — **Free-plan-safe (10 ms CPU)**.

## Why

PHP-in-Worker (wasm) boots Laravel per request: **measured 1008–2018 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker: `static` (0 invocations) → `snapshot` (prerendered HTML) → `compiled handler` (router → middleware → handler → D1, **measured 1–6 ms**) → `port` (escape-hatch hand-written JS). Anything uncovered **fails the build** (`--strict`).

**Status: M7 complete (2026-10-18).**
- **M1** View parity — Blade-compiled PHP → dependency-free ESM; `welcome` byte-identical 35,647 B (sha256 `b228c8a2…`); corpus 41/41.
- **M2** Router integration — `routes → router`, code-gen `controllers/middleware`, build `--strict` PASS, `nearfind-edge` live `/` + `/health` 200.
- **M3** D1 layer — schema snapshot (`.cache/schema.json` → `dist/schema.json`), `kernel/db.mjs` query builder, `kernel/model.mjs` Model base, mock-D1 tests 8/8, `nearfind-edge` `/dbcheck` via builder, D1 remote has `config` + `_cf_KV`.
- **M4** Packaging + CI — `package.json` (`laravel-workers@0.3.0`, bin CLI), `.github/workflows/ci.yml`, MIT license, `npm pack --dry-run` clean, tests green.
- **M5** Hash + Encrypter parity — `kernel/hash.mjs` (bcrypt via `bcryptjs`, `make`/`check`/`needsRehash`), `kernel/encrypter.mjs` (AES-256-CBC + HMAC SHA-256 via WebCrypto, payload `iv`/`value`/`mac`/`tag` byte-compatible with `Illuminate\Encryption\Encrypter` serialize=false), full kernel tests 46/46 incl. MAC-tamper + wrong-key + empty/unicode/long payloads. Full PHP↔JS parity oracle lives in `spikes/encrypter/test.mjs` (requires `php`+`vendor`).

## What's inside

- `compiler/` — **M1 view compiler**: `bin/transpile.mjs` (php-parser 3.7.0, codes `LW001`–`LW004` fail-loud), `src/transpiler.mjs`, `runtime/rt-from-context.mjs`, `tests/` (corpus 41, parity, smoke).
- `kernel/` — Workers-native runtime: `router.mjs` + `response.mjs` (W3), `db.mjs` + `model.mjs` (M3 D1 builder + Model), `hash.mjs` + `encrypter.mjs` (M5 bcrypt + AES-CBC/HMAC, WebCrypto-only).
- `tools/` — build-time PHP: `compile-view.php` (S0 dump), `prerender.php`, `verify-s0.php`, `schema-dump.php` (`pragma_table_info` fallback, D1 AUTH-safe).
- `build.mjs` — app build pipeline (copy into a Laravel app's `edge/`; see `CONTRACT-m3` for `dist/kernel` layout + schema snapshot contract).
- `spikes/encrypter/` — parity oracle (`php-tools.php`, `js-encrypter.mjs`, `test.mjs`, `test-key.b64` throwaway).
- `MAP.md` — the map (+105/105 Laravel 13.x docs verdicts, tolerance model, budgets, prior-art policy), `CONTRACT-m2`…`m5`.

## Requirements

- Laravel 10/11/12/13 app as source of truth (Vite unchanged, sessions/CSRF off by default in this pipeline).
- **Node ≥ 22**, **PHP ≥ 8.3**, `php-parser` (npm) for the compiler, `bcryptjs` for `kernel/hash` (pure JS, no native).
- Cloudflare account for deploy (`wrangler`, D1 binding id `ad5876a0-c5eb-493c-917e-5e8f0e543200` in this repo's test Wrangler).

## Quick start

```bash
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup                 # root + compiler deps

npm test                      # 16/16 — router + db/model + hash + encrypter
npm run test:corpus           # 41/41 — M1 transpiler corpus
npm run test:hash             # 7/7  — hash + encrypter only

# when your Laravel vendor/ is in the parent checkout:
npx laravel-workers verify    # VERIFY-S0 15/15 (else SKIP)
npx laravel-workers build     # inside an edge checkout (requires Laravel vendor)
```

## CLI

```bash
laravel-workers test          # all kernel tests
laravel-workers test:hash     # hash + encrypter only
laravel-workers test:corpus   # transpiler corpus

laravel-workers build         # node build.mjs --strict (needs a Laravel app checkout)
laravel-workers verify        # php tools/verify-s0.php (SKIP when no parent vendor/)
laravel-workers test:db       # db/model only

# npm aliases do the same:
npm test                      # kernel
npm run test:corpus
npm run build
npm run verify
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
  └─ ship.mjs           S6  deploy → Workers + D1
```

## Docs & checks

- `MAP.md` — auto-snapshot semantics, D1 max-queries note, Unknowns-to-verify, and Appendix C (105 docs pages → verdict; no blanks, releases must re-check `laravel/docs@13.x` — W8).
- `compiler/tests/run-corpus.mjs` — oracle; `compiler/tests/parity-m1` + `tools/verify-s0.php` — green in M1.
- `kernel/tests/{router,db,hash,encrypter}.test.mjs` + `spikes/encrypter/test.mjs` — M5 proves `make`/`check`/`encryptString`/`decryptString` round-trip, tamper, wrong-key, unicode.

## Philosophy

- **Laravel stays Laravel** — this is the toolchain, not app code; no fork of framework.
- **Coverage enforced** — unhandled route = warning; `--strict` = failure. No silent gaps.
- **Free-plan-first** (`10ms` CPU, `50` subrequests, `5M` D1 reads/day) — Paid is headroom, never a fallback.
- **Honest claims** — "approach in progress" until M1–M5 measured; formal W0 prior-art scan (2026-10-17, CLEAN, `edge/notes/prior-art-report.md`) must pass before any "discovery" claim.

## Roadmap (living)

- **M6** Validation + FormRequests (kernel `validator`, error flows; fuzz corpus) — **next**, no `nearFind` push.
- **M7** Services (Mail HTTP/Resend padanan, Queue CF Queues, Cache KV/D1, Storage R2, Scheduler cron dispatcher).
- **M8** Parity harness + CPU-budget gates + `docs-index` re-check vs `laravel/docs@13.x` (`W8`) + `npx` packaging + benchmarks (`W9`), then `W10` demo app polish — shipped worker verified `/` + `/health` + `/dbcheck` byte-equal.

## License

MIT — see [LICENSE](LICENSE). Trademarks belong to their owners.
