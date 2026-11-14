# What is inside, and the 30-second architecture

The file map and the build pipeline, as a contributor sees them. Moved out of
[`README.md`](../README.md) so the README can stay short.

## What's inside

```
compiler/                 transpile Blade→PHP→JS (build time)
  src/transpiler.mjs       PHP-subset → dependency-free ESM (LW001–LW004)
  src/controller.mjs       controller methods → JS handlers
  src/policy.mjs           Gate/policy compiler (M39a)
  runtime/rt-from-context.mjs, rt*.mjs   the VM: concat, sprintf, DateTime, …
  tests/                   corpus + parity + smoke + controller + policy + source-syntax

kernel/                   Workers-native runtime (request time, 0 PHP)
  http.mjs                 the compiled HTTP pipeline (M15)
  router.mjs  db.mjs  model.mjs  sqlite.mjs
  session.mjs csrf.mjs auth.mjs ratelimit.mjs hash.mjs encrypter.mjs
  validator.mjs validation.mjs php-serialize.mjs php-json.mjs
  cache.mjs storage.mjs mail.mjs queue.mjs scheduler.mjs paginator.mjs
  tests/                   the suite across kernel + compiler + tools (see npm test)

tools/                    build-time PHP + JS helpers (boot the real app)
  schema-compile.php       migrations → in-memory SQLite → D1 DDL (driver-agnostic)
  compile-view.php         phase worker: view batches, recursive `make()` closure
  model-dump.php  constants-dump.php  formrequest-dump.php  policy-dump.php
  metadata-phase.php       ONE boot: recursive models + policies + FormRequests
  event-dump.php  class-dump.php  schedule-dump.php
  routes-dump.mjs  config-dump.mjs  constants-dump.mjs  (pure JS re-implementations)
  build-cache.mjs          SHA-256 content key for the unchanged-input fast path
  deploy.mjs  lw-state.mjs  status.mjs  doctor.mjs  run.mjs   the guided deploy CLI + per-app state
  jsonc.mjs  cloud-account.mjs   JSONC span edits + Cloudflare account selection
  _root.php  init.mjs  vendor-lite.mjs  php-provision.mjs  php-runtime.mjs
  tests/                   deploy/doctor/jsonc/cloud-account suites (excluded from the tarball)
  verify-s0.php  pack-smoke.mjs  docs-check.mjs  bench.mjs  constructs.json

shadow/                   M24 proof machine: real Laravel app (PHP 8.3) vs the
                          compiled worker, byte-wise diff of status/headers/body

build.mjs                 phase-scoped workers — ONE Laravel boot per phase that
                          has work (schema → prerender → route/error views →
                          metadata → controller views) + the unchanged-input
                          build cache → readiness gate → dist/
```

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
                               + the edge 404 page (the framework's own 404 render →
                               public/404.html, served by `assets.not_found_handling`)
  └─ wrangler deploy      S6   deploy → Workers + D1
```

PHP boots **only at S0** (build time). The edge (S1–S6) is pure JS.

---


