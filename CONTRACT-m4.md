# CONTRACT-m4 — Packaging + CI (frozen 2026-10-18)

M4 makes `laravel-workers` a self-contained public toolchain repo:
npm-packable CLI surface, CI workflow, updated docs, license. No Laravel
app code, no PHP request-time behavior, no D1 writes.

## Artifacts

- `package.json` — public package `laravel-workers@0.3.0`, `type: module`,
  bin `laravel-workers` → `bin/laravel-workers.mjs`.
- `bin/laravel-workers.mjs` — zero-dep CLI: `test`, `test:corpus`, `build`, `verify`.
- `.github/workflows/ci.yml` — Node + PHP CI: install, kernel tests, corpus,
  transpiler smoke.
- `README.md` — status M3/M4, quick start, CLI usage, CI badge.
- `LICENSE` — MIT.

## CLI contract (frozen)

- `laravel-workers test` — `node --test kernel/tests compiler/tests` (Node built-in runner).
- `laravel-workers test:corpus` — `node compiler/tests/run-corpus.mjs`.
- `laravel-workers build` — `node build.mjs --strict` (requires a Laravel app checkout).
- `laravel-workers verify` — `php tools/verify-s0.php` when vendor exists; else skip with notice.

## CI contract (frozen)

- Node 22, PHP 8.3, no D1, no deploy secrets.
- Steps: checkout, setup-node, setup-php, `npm install`, `npm --prefix compiler install`,
  `node --test kernel/tests`, `npm run test:corpus`, `node kernel/tests/db.test.mjs`.
- Green on `main`; no flaky network calls.

## Territory

- `laravel-workers/` only. `nearFind/` stays local-only (no push).
- No app-specific registry/ship/wrangler/tests in the public repo.
