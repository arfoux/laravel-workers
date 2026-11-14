# Deploy & operator reference

The commands, the guided deploy, the CI plumbing and the build internals. This is the text
[`README.md`](../README.md) used to carry; the README now stays the entrance and links here.

## CLI

With the package installed (otherwise prefix every command with `npx `):
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
npm run test:fast       # the same discovery, minus the file measured to dominate
                        # the suite (`schedule-utc.test.mjs`) — the pre-push loop
npm run test:corpus     # the transpiler corpus
npm run test:hash       # hash + encrypter only
npm run test:sqlite     # in-memory SQLite integration
npm run test:shadow     # the shadow harness (real PHP app vs compiled worker);
                        # its "coverage" counts SCENARIO STEPS, not code lines
npm run test:coverage   # node --experimental-test-coverage: the CODE coverage report
npm run bench           # micro-bench p95 budget
npm run check:docs      # the docs gate
npm run gate:cpu        # the CPU gate: measures the real kernel hot paths on Cloudflare
                        # (deploys a probe worker, reads cpuTime/outcome via wrangler tail,
                        # asserts them, deletes the worker — needs a logged-in wrangler)
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
- With `--yes`, tables plus **no recorded hash** → **stop with exit 2**: a CI checkout records no hash (`lw-state.json` is written by an interactive run), so the state cannot be verified and the run refuses to ship code against a schema it cannot check. Pass `--skip-schema` (these tables are current) or `--schema=apply` to go on deliberately. Tables plus a **changed** hash (schema drift) → the same **stop with exit 2**.
- `--skip-schema` always skips. `--schema=apply` always applies, even with tables; the two flags conflict.
- A failed table-count query stops the run (exit 1) instead of assuming the D1 is empty.

`dist/schema.sql` is generated `CREATE TABLE` DDL plus the `CREATE [UNIQUE] INDEX` statements Laravel declares separately (`->unique()` / `->index()`), not an idempotent migration: applying it to a database where those tables already exist can fail with `table "x" already exists`. The guard prevents silent re-application, not a data wipe.

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

- `--yes` → every missing choice takes its default. A D1 with tables and **no recorded hash** stops the run (exit 2) — the schema cannot be verified, so `--skip-schema` (these tables are current) or `--schema=apply` is how you say which state you mean; if the recorded hash shows drift, the run stops the same way.
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
- `--yes` with schema drift on a populated D1 → stops; choose `--skip-schema` (the D1 is current) or `--schema=apply` (re-run the snapshot deliberately — it is **CREATE-only**: it fails on a table that already exists and cannot add a column, so a `Schema::table` migration on a live D1 is applied by hand with `npx wrangler d1 execute DB --command "ALTER TABLE ..." --remote`).
- `[C] paste database_id` with an empty id → `a database_id is required for [C]`.
- `[B] list existing` with no databases on the account → `no D1 databases on the account — use [A] auto`.
- `[B]` with an out-of-range pick → `invalid pick`.
- Wrangler resolves a different Cloudflare account than `lw-state.json` records → stops **before any D1 or deploy call** (exit 2); switch explicitly with `--allow-account-change` or a TTY `y` (`--yes`/non-TTY never confirm).
- `npx wrangler --version` answers **v3 or older** → a mode 2/3 run stops before the first Wrangler call (`wrangler 3.x is too old — laravel-workers drives Wrangler v4+`), and `--plan --check` records the same line as a blocking issue; install a v4+ Wrangler or run through `npx --package wrangler@4`.
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
| PHP vendor files | `composer install` (~379 s cold) | **vendor-lite** — reads `composer.lock`, fetches dist zips from packagist, writes its own autoloader and Laravel's `vendor/composer/installed.json` (so package auto-discovery still finds providers/aliases). Content-addressed cache (pays once per lock; entries that predate the manifest are healed in place, never re-downloaded). No composer binary. |
| Database schema | `touch database/database.sqlite && php artisan migrate --force` | **`tools/schema-compile.php`** — boots app, migrates in-memory SQLite, dumps via pragma. Your `database/` is never touched: when the app has no database file, the build seeds a throwaway SQLite in `.cache/` (schema applied, empty) so it can boot for prerender. Driver-agnostic (MySQL/Postgres/SQLite source → same D1 DDL output). |
| `APP_KEY` | `php artisan key:generate` | **Automatic** — `build.mjs` writes `base64:<32 bytes>` into `.env` if absent. Stable across rebuilds (the worker encrypts cookies with it). `tools/_root.php` also auto-injects it for standalone tool runs. |

`registry.json` and `wrangler.jsonc` are **optional** — the build uses sensible defaults and auto-writes `wrangler.jsonc` when absent (worker name from the app-dir slug; `database_id` is a placeholder). So even the scaffolding happens at build time.

That scaffolded `assets` block also carries `"not_found_handling": "404-page"`: the build writes
`dist/public/404.html` (the app's own 404 page, rendered through Laravel's exception path), and
that switch is what makes the ASSETS layer serve it for a path outside `_routes.json` instead of
Cloudflare's null-body 404. An app whose config predates it gets a DECLARED finding naming the
exact line to add, and an app that ships its own `public/404.html` keeps its file — see
`COMPILED.md` §6 item 20 and `docs/EVIDENCE.md` finding 2.

A prerendered page ships under both spellings it is reachable as (`about.html` and
`about/index.html`): Cloudflare's default `html_handling` serves the flat file for `/about` and the
folder file for `/about/`, which is the pair PHP answers `200` for — one file alone would make one
of the two a `307` (`tools/snapshot-paths.mjs` is the rule; the `registry.json` `static` value an
operator names gains its twin automatically).

### CI: the verdict people read, and the merge pipeline

If the app lives on GitHub, `build --strict` alone answers "did it compile"; it does
not tell a reviewer **which routes are actually served and which gaps ship**. The
official CI surface closes that:

- **[docs/CI.md](docs/CI.md)** — the contract: three layers (tool decides, reporter
  posts, pipeline schedules), the copy-paste `ci.yml`/`deploy.yml`, token scopes,
  and the traps that break a deploy silently (`--no-cache`, a valid random `APP_KEY`,
  `APP_URL` baked at build, `CACHE_STORE=file` disabling the login throttle).
- **`action/verdict`** — reads the build log, posts one sticky PR comment
  (`### Verdict: RUNS WITH DECLARED GAPS`) plus the job summary. Fork-safe, always
  exit 0, never hides a gap. The mark, palette and voice it carries are defined
  once in **[docs/BRAND.md](docs/BRAND.md)**, together with how to pin the action
  in your own repo instead of copying the script.
- **`app-check.yml` / `app-deploy.yml`** — optional reusable workflows for apps that
  match the defaults. The documented pattern is the contract; these are convenience.

`doctor` stays the local preflight check; Verdict is the reporter.

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

It is a claim about **routes, not data**: every route has a compiled handler, a snapshot or a port; nothing is ignored; no binding is missing. It does **not** claim your database is populated — `deploy` mode 2/3 provisions the D1 and applies `dist/schema.sql` to an empty database; with tables present it refuses unless a recorded hash proves the schema already applied (or you say which state you mean), and it refuses on schema drift, but the rows are whoever wrote them.

To render pages the build boots your app, and a Laravel app reads its own `sessions` table on every request — which used to make a fresh `laravel new` project report `DOES NOT RUN` for no reason at all. So when your own `database/database.sqlite` is absent, the build gives the app a throwaway SQLite (`.cache/laravel-workers/build.sqlite`, your schema applied, **empty**) for the duration of the build. It is not your database and not the cloud D1. Your existing database file, when present, is used as-is.

The honest consequence: a page that reads rows the build has never seen prerenders as it looks **with an empty table**. Run it against real data after the schema apply, or decide such a route explicitly (`registry.json` → `ports`/`static`/`ignore`).

---


