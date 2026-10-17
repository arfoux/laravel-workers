# laravel-workers

> Run a Laravel app on Cloudflare Workers with **no PHP at request time** — build-time boot → Workers-native artifact.

**Status: M2 complete.** Router integration live � build --strict PASS, ROUTER INTEGRATION PASS, CPU BUDGET PASS, wrangler dev smoke / and /health 200, /dbcheck 200 on remote D1.

## What's inside
- `compiler/` — M1 view compiler (Blade-compiled PHP → dependency-free ESM). `bin/transpile.mjs`, `src/transpiler.mjs`, `runtime/rt-from-context.mjs`, `tests/`.
- `kernel/` — W3 router + response kernel (compiled-handler tier).
- `tools/` — build-time PHP tools (`compile-view.php` S0 dump, `prerender.php` reference, `verify-s0.php`).
- `spikes/` — de-risking spikes (encrypter parity, etc.).
- `notes/` — research & scan reports, S0 contract.
- `MAP.md` — full coverage map (105/105 Laravel docs, tolerance model).

## Requirements
- A Laravel app (10.x/11.x/12.x/13.x) as the source of truth.
- Node ≥22, PHP ≥8.3, `php-parser` (npm) for the compiler.
- Cloudflare account for deploy.

## Quick start
1. Point `tools/compile-view.php` at your Laravel app (set `$root`).
2. `php tools/compile-view.php welcome .cache/welcome.compiled.json`
3. `node compiler/bin/transpile.mjs .cache/welcome.compiled.json --json --out .cache/welcome.view.mjs`
4. `node compiler/tests/parity-m1.mjs` — must print `PARITY: PASS`.
5. `php tools/verify-s0.php` — must print `VERIFY-S0: PASS (15/15)`.
6. `node compiler/tests/run-corpus.mjs` — must print `CORPUS: 41/41 pass`.

## Philosophy
- Laravel stays Laravel; this is the toolchain, not app code.
- Coverage enforced (`--strict`): unhandled route = build failure.
- Free-plan-first (10ms CPU budget); Paid is headroom, never a dependency.
- Honest claims: "approach in progress" until M1–M2 land.

## License
TBD (MIT/Apache suggested).

