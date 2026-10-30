# laravel-workers

> Compile your Laravel app to a tiny JS bundle that runs on Cloudflare Workers.
> No PHP at the edge. No WASM. No cold-start drama.

[![ci](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/arfoux/laravel-workers/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/laravel-workers.svg)](https://www.npmjs.com/package/laravel-workers) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![laravel-workers — compile Laravel to Cloudflare Workers](https://raw.githubusercontent.com/arfoux/laravel-workers/main/docs/banner.png)

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

---

<!-- readme-counts:start -->
```
constructs   45 compile · 63 fail loud · 7 documented   (115 audited)
facades      47/47 classified (100%)
blade corpus 55/55 byte-identical vs PHP 8.3
docs         105/105 pages with a verdict
```
<!-- readme-counts:end -->

**Contents:** [Why](#why) · [Quick start](#quick-start) · [Requirements](#requirements) · [CLI](#cli) · [deploy](#deploy--the-guided-path-simple--advanced) · [Zero-touch / CI](#zero-touch--ci-workers-builds) · [Compiles today](#compiles-today) · [What's inside](#whats-inside) · [Architecture](#architecture-30-s) · [Docs & checks](#docs--checks) · [Philosophy](#philosophy) · [License](#license)

**Who reads what:** *evaluating it?* → [Why](#why) + [Compiles today](#compiles-today). *adopting it?* → [Quick start](#quick-start) → [CLI](#cli) → [deploy](#deploy--the-guided-path-simple--advanced). *working on it?* → [Architecture (#architecture-30-s)] + [What's inside](#whats-inside) + [docs/PROCESS.md](docs/PROCESS.md). *an AI agent?* → [docs/PROCESS.md §0](docs/PROCESS.md), [MAP.md](MAP.md), [COMPILED.md](COMPILED.md) — and never hand-type a number this repo can compute.


## Why

PHP-in-Worker (WASM) boots Laravel per request: **~1000–2000 ms CPU** → 503 on Free. `laravel-workers` moves all boot to **build time** and ships a tiered Worker:

```
static      → 0 invocations (Cloudflare Static Assets)
snapshot    → prerendered HTML for clean GET routes
compiled    → router → controller → D1 (p95 ≤ 5 ms, see budget gate)
port        → escape-hatch hand-written JS for unsupported constructs
```

Anything uncovered **fails the build** (`--strict`). No silently-wrong output ships.

The change-by-change record is in **[CHANGELOG.md](CHANGELOG.md)**; the full map in **[MAP.md](MAP.md)**; the operating contract (branch → PR → green → tag, and the parity rules) in **[docs/PROCESS.md](docs/PROCESS.md)**.

---


## Quick start

```bash
# in a real Laravel app (vendor + public/build there):
cd my-laravel-app

# the guided path — prompts for mode/name, then does build (+ D1 + deploy) for you:
npx laravel-workers deploy
#   build only  |  + database (create/reuse <worker>-db, apply schema)  |  + deploy

# preview the cloud actions first (no build, no writes, no prompts):
npx laravel-workers deploy --plan --mode 3 --d1-auto
npx laravel-workers deploy --plan --mode 3 --d1-auto --check   # + read-only account/D1 checks

# or compile only (no cloud, identical to before):
npx laravel-workers build --strict    # dist/ — vendor + APP_KEY + schema + wrangler.jsonc all automatic

# declare routes / ports when a route needs a handler:
npx laravel-workers init              # scaffold registry.json + wrangler.jsonc (idempotent)

# inspect state and environment:
npx laravel-workers status            # what's deployed, which D1, which account, when
npx laravel-workers doctor --cloud    # preflight: php, vendor, wrangler, account, deploy state
```

From checkout (developing the toolchain, tests):

```bash
git clone https://github.com/arfoux/laravel-workers
cd laravel-workers
npm run setup               # root + compiler deps
npm test                    # the suite — kernel + compiler + parity harnesses
npm run test:corpus         # the M1 transpiler corpus
npm run test:sqlite         # real in-memory SQLite integration
npx laravel-workers verify  # VERIFY-S0 15/15 (else SKIP — needs parent vendor/)
```

---


## Requirements

| Component | Tested with | Requirement |
|---|---|---|
| Laravel (source of truth) | `13.37.0` (nearFind), `11.34.2` (blogkit) | **≥ 10** |
| PHP — build time only | `8.3.30` (ZTS x64, Windows) | **≥ 8.3**; parity oracle is 8.3.30 |
| Composer | none | not needed — vendor-lite provisions deps; app's own `vendor/` works too |
| Node | `22.18.0` | **≥ 22** (`engines`) |
| Bun | `1.4.0` | **≥ 1.0** (the full test suite passes — `bun run test`) |
| npm | `10.9.3` | ≥ 10 |
| Cloudflare Workers | `wrangler` 4.151.1 (fixture app; live mode 2/3 smoke on a stock Laravel 13 app, HTTP 200) / 3.114.13 (repo) | **wrangler 4.x** (operator-installed; not bundled); `compatibility_date` `2026-10-01` |
| PHP extensions (build only) | `pdo_sqlite`, `sqlite3` | for `tools/schema-compile.php` |

### The Cloudflare tiers we target (in order)

1. **Free plan first** — Workers (10 ms CPU/req, 50 subrequests), D1 (100k writes/day, 5M reads/day), KV, the D1 blob store (`lw_blobs` — 1.5 MB/object, **no credit card**) as the default object store. The 1008–2018 ms CPU of PHP-in-Worker fails this budget; the compiled rung is p95 ≤ 5 ms.
2. **R2 when the app really needs it** — a **named** disk, an object > 1.5 MB, or many objects. R2's free tier (10 GB-month, 1M Class A, 10M Class B) is generous, **but R2 asks for a payment method** — so the build never turns it on by itself: it prints the `wrangler.jsonc` snippet and the operator decides.
3. **The paid plan, only when the free path cannot do it** — Dynamic Workers and the full Queues (billed per op) are the only paid-only features. The toolchain stays free-plan-shaped by default; no construct is blocked *because* the free plan is too small — the build fails loud only when the edge genuinely cannot answer like PHP.

**Three levels, not two** (checked against the Cloudflare docs 2026-10-21): free plan (no card, no subscription) · Workers paid plan (a subscription) · a payment method (a card) — **R2 is the only product that needs a card**.

---


## CLI

```bash
laravel-workers build            # --strict (needs Laravel app root); --scaffold generates port stubs
laravel-workers deploy           # interactive: build, then D1 (+ deploy) on request
laravel-workers deploy --plan --mode 3 --d1-auto   # preview; changes nothing
laravel-workers init             # scaffold registry.json + wrangler.jsonc (idempotent)
laravel-workers status           # the recorded deploy state (lw-state.json)
laravel-workers doctor [--cloud] # preflight: php, vendor, wrangler, deploy state
laravel-workers shadow --app <root> # proof harness: real PHP app vs the compiled worker
laravel-workers verify           # php tools/verify-s0.php (SKIP when no parent vendor/)
laravel-workers vendor:ensure    # provision a composer-free vendor tree (CI prewarm)
laravel-workers php:ensure       # resolve or provision the PHP interpreter (CI prewarm)

# developer tasks run through the package.json scripts (not the CLI):
npm test                # the suite
npm run test:corpus     # the transpiler corpus
npm run test:hash       # hash + encrypter only
npm run test:sqlite     # in-memory SQLite integration
npm run test:shadow     # the shadow harness (real PHP app vs compiled worker)
npm run bench           # micro-bench p95 budget
npm run check:docs      # the docs gate
npm run audit:constructs # facade coverage audit

# flags / non-interactive (CI):
laravel-workers deploy --name my-worker --mode 3 --d1-auto    # full deploy, no prompts
laravel-workers deploy --d1-id <uuid> --skip-schema           # reuse a D1, keep its data
laravel-workers build --strict                               # compile only
```

---


## deploy — the guided path (simple → advanced)

`npx laravel-workers deploy` runs build → (D1) → (deploy) for you, asking only what it cannot decide. Every prompt has a default; pressing Enter accepts it. Non-interactive shells (CI, pipes, `--yes`) get the defaults and skip every prompt.

### Level 0 — preview with `--plan` (changes nothing)

```bash
npx laravel-workers deploy --plan --mode 3 --d1-auto
npx laravel-workers deploy --plan --mode 3 --d1-auto --check   # + read-only account/D1 checks
```

`--plan` uses the same resolver and safety decisions as a real run, but it is **zero-mutation and offline by default**: no build, no `dist/` write, no `wrangler.jsonc` or `lw-state.json` edit, no D1 create/apply, no deploy, and no prompts. It prints the worker name, the account a real run would target (the recorded id offline, verified against `wrangler whoami` with `--check`), the D1 action and identity (the name when the resolver can determine it; the UUID when `--check` or recorded state provides it), the schema action, the state/config files a real run would change, and the cloud operations it would perform.

`--check` adds only read-only Cloudflare calls (`d1 list` and a temporary table-count query that is cleaned up) so it can confirm reuse, a missing UUID, or a schema-hash match/drift. It never creates a database or applies SQL.

- Exit `0` — the plan is actionable.
- Exit `2` — a real run would stop (bad flags/config/state, missing D1 id, schema drift under `--yes`, …).
- Exit `1` — `--check` could not complete its read-only lookup.

The schema line describes the existing `dist/schema.sql`; because `--plan` does not build, a missing one is called out and an existing one is explicitly marked **not checked** against the current source. Run a real build first when the preview must reflect a source change. `--dry-run` is not a synonym: it is rejected with a `--plan` hint. `--plan` without `--mode` uses the non-interactive default (mode 1, unless a D1 flag implies mode 2).

### Level 1 — the simplest route (deploy on the first run)

```bash
npx laravel-workers deploy
```
Prompts, in order, all before the build starts:

```
What should I do?
  [1] build only
  [2] build + database
  [3] build + database + deploy
Choice [1] ▸ 3
Worker name [my-laravel-app] ▸          # modes 2/3 only; Enter = config name → recorded → app-dir slug
Database:
  [A] auto (create/reuse <worker>-db)
  [B] list existing
  [C] paste database_id
Choice [A] ▸ A
```

What happens:
1. **Mode** — `1` = compile only (identical to `build`), `2` adds D1, `3` adds the Cloudflare deploy. Mode 1 never asks for a worker name or D1.
2. **Worker name** (mode 2/3 only) — the `wrangler.jsonc` `name` is authoritative. Without one, the recorded `lw-state.json` name is used, then the app-dir slug (`my-laravel-app`). Typing another name (or `--name`) overrides it and rewrites the config `name`.
3. **Database** (mode 2/3 only) — `A` auto: sees whether `<worker>-db` already exists on your account; reuses it, otherwise creates it. `B` lists your D1s to pick one. `C` takes a `database_id` you paste.

The build then runs with `--strict`. Only after it exits 0 does the tool provision the D1 (mode 2/3), apply `dist/schema.sql` unless the guard says stop, and deploy (mode 3). It verifies that `wrangler.jsonc` has a bindable D1 entry before creating a database, so a config mistake cannot leave an orphan. When a recorded worker name is used to rebuild a deleted config, the scaffolded D1 entry is renamed to `<worker>-db` together with its id. A failed build touches nothing on Cloudflare — no orphan D1, no half-deploy.

`wrangler.jsonc` is treated as JSONC, not plain JSON: comments, block comments, trailing commas and a BOM survive. Only the `name` and D1 `database_id`/placeholder values are replaced; the whole file is parsed again after the edit, and a duplicate/ambiguous field stops the run instead of guessing. No regex rewrite.

### Level 2 — the second deploy (state makes it short)

`deploy` writes `<app>/lw-state.json` on success — the worker name, the deployed URL, and the D1 id it used. The next run reads it, so the database prompt disappears; the worker name still comes from `wrangler.jsonc` when present, otherwise from the recorded state. Mode 1 (build only) never writes this file; `--d1-id`/`--d1-auto` override the recorded D1. If you keep the file in the app, add `lw-state.json` to `.gitignore` unless you want the worker URL and D1 id in source control.

State is read strictly. A damaged, unreadable, or future-version `lw-state.json` stops `deploy` before any prompt or Cloudflare call; `status` and `doctor` report the file and exit 2 rather than pretending the app has no deployment. Fix the file or remove it deliberately.

```
What should I do?
  [1] build only
  [2] build + database
  [3] build + database + deploy
Choice [1] ▸ 3
Worker name [my-app] ▸                  # Enter = the recorded worker
→ D1 "my-app-db" ready                  # no prompt: the recorded D1 is reused
```

### Level 3 — the database already has tables (the safety prompt)

When the D1 already has tables, `deploy` will **not** apply the schema silently. If the table count cannot be read, it stops rather than guessing that the database is empty:

```
"my-app-db" already has 9 table(s). Apply schema anyway? [y/N] ▸
```
- `Enter` / `n` → schema skipped, data untouched.
- `y` → apply `dist/schema.sql` anyway.
- A database with **0 tables** gets the schema automatically.
- If tables exist and the current `dist/schema.sql` hash equals the hash recorded for this D1, the schema is skipped as **already applied** — no prompt.
- With `--yes`, tables plus **no recorded hash** → skip (never apply silently). Tables plus a **changed** hash (schema drift) → **stop with exit 2** and ask for `--skip-schema` (keep the data) or `--schema=apply` (apply the change deliberately).
- `--skip-schema` always skips. `--schema=apply` always applies, even with tables; the two flags conflict.
- A failed table-count query stops the run (exit 1) instead of assuming the D1 is empty.

`dist/schema.sql` is generated `CREATE TABLE` DDL, not an idempotent migration: applying it to a database where those tables already exist can fail with `table "x" already exists`. The guard prevents silent re-application, not a data wipe.

### Level 4 — reuse one specific database, keep its data

```bash
npx laravel-workers deploy --mode 2 --d1-id <uuid> --skip-schema
```
Uses the database with that id (its real name is resolved from your D1 list, so versioning/guards hit the actual database), never applies the schema if you say so. Combined with no TTY and `--mode 3`, this is the CI path:

```bash
npx laravel-workers deploy --name my-worker --mode 3 --d1-auto   # full deploy, no prompts
npx laravel-workers deploy --mode 3 --d1-id <uuid> --yes        # same D1, automated
```

### The Cloudflare account guard (mode 2/3)

`lw-state.json` records the Cloudflare **account id** a deployment used (the account name/email are display metadata). Before any D1 or deploy call, mode 2/3 resolves the account Wrangler will actually use — the `wrangler.jsonc` `account_id` pin first, then `CLOUDFLARE_ACCOUNT_ID` (or `CF_ACCOUNT_ID`), then the account `wrangler whoami` reports — and compares it with the recorded id. A mismatch refuses the run (wrapped here; one line in practice):

```
Cloudflare account changed: "Old one" (aaaa…) → "New one" (bbbb…).
Refusing to touch D1 or deploy with a different account.
Re-run with --allow-account-change to switch, or remove lw-state.json to start fresh.
```

- The **id is the identity** — the same account renamed, or reached through a different email alias, does not switch; a different account id always stops.
- Switching is explicit: `--allow-account-change`, or `y` at the confirmation prompt on an interactive terminal. `--yes` and non-interactive runs never confirm; they always refuse.
- An allowed switch clears the stale `workerUrl`/`deployedAt` (that URL belongs to the old account) and refuses to silently reuse a recorded D1 the new account does not own; pick the new D1 with `--d1-auto`/`--d1-id`, or run a mode-2 database-only pass first.
- Wrangler logged in to several accounts without a pin stops as well (accounts are never guessed); pin one via `account_id` or the env.
- Old state files without the account metadata keep working; the next successful mode 2/3 run records it.
- `--plan` prints the recorded account marked "not checked offline"; `--plan --check` resolves and compares, and skips the D1 checks on a mismatch; `doctor --cloud` performs the same comparison; `status` shows the recorded account.

### Flag reference

| Flag | Effect |
|---|---|
| `--name <worker>` | set the worker name (modes 2/3; no prompt) |
| `--mode 1\|2\|3` | force the mode (no prompt) |
| `--deploy` | shorthand for `--mode 3` |
| `--db` | shorthand for `--mode 2` |
| `--d1-auto` | auto create/reuse `<worker>-db` (capped to D1's 63-char limit; overrides recorded D1; no prompt) |
| `--d1-id <uuid>` | use a specific existing D1 by id (overrides recorded D1; mutually exclusive with `--d1-auto`) |
| `--skip-schema` | never apply `dist/schema.sql`; conflicts with `--schema=apply` |
| `--schema=apply` | force-apply `dist/schema.sql`, even when the D1 has tables |
| `--plan` | preview only: no build/writes/cloud mutation; exit 0 if actionable, 2 if a real run would stop |
| `--check` | with `--plan`: add read-only account verification and `d1 list` / table-count calls |
| `--allow-account-change` | allow continuing on a different Cloudflare account than `lw-state.json` records (clears the stale URL/deploy time; D1 must resolve in the new account) |
| `--yes` / `-y` | accept all defaults, never prompt (CI); schema drift and an unconfirmed account change still stop |
| any other `--flag` | forwarded to `build` (e.g. `--no-cache`) |

### When nothing prompts

- `--yes` → every missing choice takes its default. A D1 with tables and no recorded hash is skipped; if the recorded hash shows drift, the run **stops** instead of re-applying.
- Non-TTY with neither `--mode` nor `--d1-*` → defaults to **mode 1 (build only)**, never touching Cloudflare.
- `--name` alone is not a cloud mode: without `--mode 2|3` or a D1 flag it falls into mode 1 and is **rejected**, because build-only does not touch `wrangler.jsonc`.
- A D1 flag without `--mode` on a non-TTY (or with `--yes`) implies **mode 2** — database only, no deploy.
- Mode 2/3 on a non-TTY with no D1 flag → reuses the recorded D1, otherwise behaves like `--d1-auto`.
- `--plan` never prompts: missing mode uses mode 1 (D1 flag → mode 2), and the worker name is the resolved default.

### When the tool refuses

- `deploy` not run from a Laravel app root (no `artisan`) → fails before prompting.
- `lw-state.json` is unreadable/invalid or has a future `schemaVersion` → `deploy` stops; `status`/`doctor` report it and exit 2.
- `--mode` outside 1/2/3 → `invalid mode`.
- `--mode` together with `--deploy`/`--db` → `use either --mode or --deploy/--db, not both`.
- `--name` with mode 1 → fails; build-only never changes `wrangler.jsonc`.
- `--d1-id`/`--d1-auto`, `--skip-schema` or `--schema=apply` with mode 1 → fails instead of ignoring the flag.
- `--name` outside 1–63 lowercase letters/digits/hyphens → `worker name must be ...`.
- `--d1-id` together with `--d1-auto` → `use either --d1-id or --d1-auto, not both`.
- `--skip-schema` together with `--schema=apply` → `use either --skip-schema or --schema=apply, not both`.
- `--schema` other than `apply` → `only "apply" is supported`.
- `--check` without `--plan` → `--check is only valid with --plan`.
- `--dry-run` → rejected with a `--plan` hint.
- `--d1-id` that is not a UUID → `invalid D1 database_id ... (expected a UUID)`; a UUID that is not on the account → `D1 database_id "..." was not found on this account`.
- Mode 2/3 with a `wrangler.jsonc` that has no bindable D1 entry (no `d1_databases` array, a placeholder without a `database_name`, or no entry for the resolved name) → fails before creating a database.
- `wrangler.jsonc` is not valid JSONC, has a duplicate/ambiguous `name` or D1 entry, or an invalid `name` → stops before writing; the file is left untouched.
- A database table count cannot be read → stops instead of assuming empty.
- `--yes` with schema drift on a populated D1 → stops; choose `--skip-schema` or `--schema=apply`.
- `[C] paste database_id` with an empty id → `a database_id is required for [C]`.
- `[B] list existing` with no databases on the account → `no D1 databases on the account — use [A] auto`.
- `[B]` with an out-of-range pick → `invalid pick`.
- Wrangler resolves a different Cloudflare account than `lw-state.json` records → stops **before any D1 or deploy call** (exit 2); switch explicitly with `--allow-account-change` or a TTY `y` (`--yes`/non-TTY never confirm).
- `wrangler whoami` shows several accounts and nothing pins one (`account_id` or the env) → stops; accounts are never guessed.
- A set `account_id` or `CLOUDFLARE_ACCOUNT_ID` is not a 32-hex account id → stops.
- `wrangler whoami` fails or Wrangler is logged out → the account cannot be verified: a real run exits 1, `--plan --check` exits 1.
- Build fails → `build failed (exit N) — nothing was deployed`.
- `wrangler d1 create` or `wrangler deploy` fails → its output is shown and the tool stops.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success; for `--plan`, no blocking issue found |
| `1` | operational failure: build, `wrangler d1 create/execute/deploy`, unreadable table count, an unreadable `wrangler whoami`, or `--plan --check` could not complete |
| `2` | usage/config/state refusal: bad flags, missing `artisan`, invalid JSONC, corrupt `lw-state.json`, missing account D1, a Cloudflare account mismatch/ambiguity, schema drift under `--yes`; for `--plan`, a real run would stop |

After a successful run, `npx laravel-workers status` shows what happened (the recorded account included). Before you commit to a deploy, `npx laravel-workers doctor --cloud` preflights the environment (PHP, vendor, wrangler login) and compares the current Cloudflare account with the recorded one.

---


## Zero-touch / CI (Workers Builds)

For a fully unattended cloud run, use `deploy --mode 3` with an explicit name and D1 flag; the build itself remains zero-touch.

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
- **Deploy config is restored**: `wrangler.jsonc` is deploy input, not a dist artifact. If it is missing, the build scaffolds it even on a cache hit, so a later `deploy` does not fail after a successful cached build.
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

### The one manual step is now `npx laravel-workers deploy`

`npx laravel-workers deploy` runs the whole path — build, then (on request) D1 provisioning and the Cloudflare deploy:

```bash
npx laravel-workers deploy
#   mode 2:  creates or reuses <worker>-db and applies dist/schema.sql
#            when the D1 is empty; populated D1s are skipped, prompted, or refused on drift
#   mode 3:  + runs `wrangler deploy` and records the URL in lw-state.json
```

Use `deploy --plan --mode 3 --d1-auto` to see what the resolver can determine (worker/name, D1 action/identity), the schema decision, and the files a real run would touch before any of that happens. Add `--check` for read-only D1 verification.

The old three-command dance is still there, decomposed — `build` for compiling, the flags for CI (`--mode 3 --d1-auto --name x`), and `doctor --cloud` for the auth preflight (a separate command; `deploy` does not call it).

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

It is a claim about **routes, not data**: every route has a compiled handler, a snapshot or a port; nothing is ignored; no binding is missing. It does **not** claim your database is populated — `deploy` mode 2/3 provisions the D1 and applies `dist/schema.sql` to an empty database; with tables present it skips, prompts, or refuses on schema drift, but the rows are whoever wrote them.

To render pages the build boots your app, and a Laravel app reads its own `sessions` table on every request — which used to make a fresh `laravel new` project report `DOES NOT RUN` for no reason at all. So when your own `database/database.sqlite` is absent, the build gives the app a throwaway SQLite (`.cache/laravel-workers/build.sqlite`, your schema applied, **empty**) for the duration of the build. It is not your database and not the cloud D1. Your existing database file, when present, is used as-is.

The honest consequence: a page that reads rows the build has never seen prerenders as it looks **with an empty table**. Run it against real data after the schema apply, or decide such a route explicitly (`registry.json` → `ports`/`static`/`ignore`).

---


## Compiles today

| Area | What's supported | Proof |
|---|---|---|
| **Blade** | `@extends`/`@section`/`@yield`, `@if`/`@elseif`/`@else`, `@foreach`/`@for`/`@while`, `@switch`/`@match`, ternary / `?:` / `??` / `??=`, `isset`/`empty`, string interpolation, `e()`, `__()` translations (dumped at build), PHP casts | the Blade corpus + the PHP 8.3 oracle |
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
  └─ wrangler deploy      S6   deploy → Workers + D1
```

PHP boots **only at S0** (build time). The edge (S1–S6) is pure JS.

---


## Docs & checks

- `MAP.md` — the construct coverage map, D1 limits, the unknown-to-verify list.
- `tools/constructs.json` — every `Illuminate\Support\Facades\*` (Laravel 13) with a verdict.
- `npm run check:docs` — the gate: the coverage index, the construct audit (COMPILED.md), and this README's counts (both generated — a hand-typed number here is a bug).
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
