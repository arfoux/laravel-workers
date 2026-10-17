# laravel-workers

> Run a Laravel app on Cloudflare Workers with **no PHP at request time** — build-time boot → Workers-native artifact.

**Status: M4 complete.** M1 view parity (byte-identical), M2 router integration live, M3 D1 layer (schema snapshot + query builder + model base), M4 packaging/CI. `nearfind-edge` deployed: `/` 200 (35,647 B), `/health` 200, `/dbcheck` 200 via D1 builder.

## What's inside
- `compiler/` — M1 view compiler (Blade-compiled PHP → dependency-free ESM). `bin/transpile.mjs`, `src/transpiler.mjs`, `runtime/rt-from-context.mjs`, `tests/`.
- `kernel/` — W3 router + response kernel; M3 `db.mjs` query builder + `model.mjs` Model base.
- `tools/` — build-time PHP tools (`compile-view.php` S0 dump, `prerender.php` reference, `verify-s0.php`, `schema-dump.php`).
- `bin/laravel-workers.mjs` — zero-dep CLI.
- `build.mjs` — app build pipeline (copy into a Laravel app's `edge/`).
- `MAP.md` — full coverage map (105/105 Laravel docs, tolerance model).
- `CONTRACT-m2.md`, `CONTRACT-m3.md`, `CONTRACT-m4.md` — milestone contracts.

## Requirements
- A Laravel app (10.x/11.x/12.x/13.x) as the source of truth.
- Node ≥ 22, PHP ≥ 8.3, `php-parser` (npm) for the compiler.
- Cloudflare account for deploy.

## Quick start
```bash
npm run setup                 # install root + compiler deps
npm test                      # kernel tests (router + db/model)
npm run test:db               # M3 query builder / model tests
npm run test:corpus           # M1 transpiler corpus
laravel-workers verify         # S0 verify when a Laravel vendor/ exists
```

## CLI
```bash
laravel-workers test
laravel-workers test:db
laravel-workers test:corpus
laravel-workers build          # inside a Laravel app edge checkout
laravel-workers verify
```

## CI
Green on `main` via GitHub Actions: Node 22, `npm install`, `npm --prefix compiler install`, kernel tests, db/model tests, transpiler corpus. No D1, no deploy secrets.

## Philosophy
- Laravel stays Laravel; this is the toolchain, not app code.
- Coverage enforced (`--strict`): unhandled route = build failure.
- Free-plan-first (10ms CPU budget); Paid is headroom, never a dependency.
- Honest claims: M1–M4 measured; discovery language only after public claim.

## License
MIT — see `LICENSE`.
