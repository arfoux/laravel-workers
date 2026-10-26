# Build & infra audit — laravel-workers
> **Historical snapshot** - the first audit (before the M23-M42 milestones).
> Several entries below have since been closed; the live state is
> `COMPILED.md` §9 + `node tools/construct-audit.mjs --check` (the generated
> table) + `tools/constructs.json`. Read this file as the backlog, not as
> the current state.

Scope: `build.mjs` (S0–S6), `tools/*.php`, `tools/*.mjs`, `package.json`, `.github/workflows/ci.yml`, `bin/laravel-workers.mjs`, `src/worker.mjs`, `src/ports/*`.

## 1. `build.mjs` pipeline

| Stage | Status | Note | Suggestion (file:line) |
|---|---|---|---|
| 0 sanity (registry, vendor, manifest) | OK | fail loud | — |
| 1 routes via `php artisan route:list --json` | OK | normalised, sorted, method map | also capture route **names** into the table (currently `name: null`) — `build.mjs:60` |
| 2 `prerender.php` boot per route | OK | build-time boot only | O(routes) process spawns — cache by route if slow |
| 3a manual static pages | OK | `registry.static` | — |
| 3b auto-snapshot GET HTML | OK | dynamic `{…}` → needs port | — |
| 3c compile views | OK | view → PHP → JS + context | **only views**; controllers are ports (§4) |
| 3d schema snapshot → `dist/schema.json` | OK | PRAGMA + SQL fallback | wire consumers to import it (no example) |
| 4 copy `build/`, `favicon.ico`, `robots.txt` | OK | skips missing with `!` log | add `_headers`/`_routes.json` emission |
| 5 worker + ports + kernel + runtime | OK | — | — |
| 5 route table `kind: ignore/port/view/snapshot/unhandled` | OK | — | — |
| 6 coverage report + `--strict` fail | OK | blocked on needsPort/partial/unknown | — |
| 7 `--scaffold` port stubs | OK | — | — |

### Gaps
- **No `_routes.json` / asset routing hints** emitted for CF Pages/Workers assets. `src/worker.mjs` calls `env.ASSETS.fetch(request)` as fallback, which works, but a `_routes.json` would cut worker invocations for static. `build.mjs:232`.
- **No integrity/versioning** of emitted assets, no cache-control headers, no `etag`.
- **Snapshot URL rewriting is localhost-only** (`originRe`). A prod `APP_URL` origin in the rendered HTML is not relativised. `build.mjs:88`.
- **Route names dropped** — `routeTable` sets `name: null` even though `route:list --json` provides them. `route('name')` at edge relies on captured `urls`, but names would help. `build.mjs:229`.
- **No emit of a deploy manifest** (wrangler.toml / bindings doc). `ship.mjs` referenced in MAP/README is **not in the repo** — the deploy step is aspirational. (verify: `git ls-files` has no `ship.mjs`.)

## 2. `tools/*`

| Tool | Status | Note | Suggestion |
|---|---|---|---|
| `prerender.php` | OK | boots app, JSON out | usage comment says `edge/tools/...` (host layout) while shipped flat |
| `compile-view.php` | OK | real Blade compiler + context capture | uses `eval()` behind `$evalGate` conservative regex — keep, but document trust boundary |
| `schema-compile.php` | OK | `pragma_table_info` + SQL-parse fallback, D1-auth-safe; driver-agnostic (MySQL/PG/SQLite source → D1 SQLite output) | — |
| `verify-s0.php` | OK | 15/15 gate | — |
| `docs-check.mjs` | OK | 105/105 gate, offline-safe | does not cross-check `laravel/docs@13.x` live (comment says "if reachable" but no code) — `docs-check.mjs:3` |
| `bench.mjs` | OK | hot p95 ≤5ms, encrypter ≤30ms | memory-only ops (no D1/KV) |

## 3. Packaging & CI

| Item | Status | Note | Suggestion |
|---|---|---|---|
| `package.json` files = bin+build.mjs+compiler/{bin,src,runtime}+kernel+tools | OK | 33 files, `compiler/tests` excluded | — |
| deps `bcryptjs`, `php-parser` | OK | both pinned | `php-parser` pinned 3.7.0 — good |
| `bin/laravel-workers.mjs` | OK | 11 subcommands | `build` hardcodes `--strict`; no arg passthrough |
| `.github/workflows/ci.yml` | OK | Node 22 + tests + corpus + docs-check + bench | add `npm pack --dry-run` + `node --check` on shipped mjs — `ci.yml:20` |
| LICENSE MIT | OK | — | — |

### Gaps
- CI never validates `build.mjs` syntax (no `node --check build.mjs`), so a syntax slip in the (untested) pipeline ships. `ci.yml:20`.
- No npm-publish guard (dry-run pack) in CI.
- `tools/*.php` header usage comments still reference the host `edge/tools/...` layout — harmless but inconsistent with the flat shipped layout. `prerender.php:4`, `compile-view.php:2`.

## 4. The worker/ports model (important)

`src/worker.mjs` dispatches only method ∈ {GET, HEAD, PUT, POST}. **DELETE/PATCH/OPTIONS are not dispatched** — the code checks those four explicitly and otherwise falls through to assets. A `PATCH`/`DELETE` route (common in REST) never reaches its handler. `src/worker.mjs:9`.

Also, `src/worker.mjs` is a *minimal example* (not in npm `files`): it hardcodes `worker: 'nearfind-edge'` in `/health` — a host-specific string shipped on GitHub. `src/worker.mjs:22`.

## 5. Prioritized suggestions (top 6)

1. **Dispatch all methods** (add DELETE/PATCH/OPTIONS) — otherwise REST apps are broken. `src/worker.mjs:9`.
2. **Emit `_routes.json`** so static/snapshot assets skip the Worker (quota + latency). `build.mjs:232`.
3. **CI: `node --check` every shipped `.mjs` + `npm pack --dry-run`.** `ci.yml:20`.
4. **Relativise prod origin** in snapshots, not just localhost. `build.mjs:88`.
5. **Carry route names** into `routeTable`. `build.mjs:229`.
6. **Add `ship.mjs`** (referenced but absent) or remove the reference from README/MAP.

## 8. Verdict

Build pipeline is sound and fail-loud for its scope. Blocking correctness bugs: **worker misses DELETE/PATCH/OPTIONS** and **no `_routes.json`**. `ship.mjs` is referenced but does not exist.

> Note on `edge/`: the `edge/` paths in README/MAP/tools are the **documented host layout** (this package is extracted into a Laravel app's `edge/` dir), not a leak. They are intentional and consistent with `build.mjs`'s `root = dirname(edgeDir)`.

## 10. Closed in this sweep (2026-10-18)

- `src/worker.mjs` now dispatches **all** methods (GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS) and the `/health` payload no longer hardcodes a host worker name.
- `ship.mjs` references removed from MAP/README — S6 is now documented as `wrangler deploy` after build.
- CI hardened: `node --check` over shipped ESM + `npm pack --dry-run` added to `.github/workflows/ci.yml`.
- README got an honest **Supported vs unsupported** section; "any Laravel app" and "router → middleware → handler" claims corrected.

Still open: `_routes.json` emission, prod-origin relativisation in snapshots, route names in `routeTable`.
