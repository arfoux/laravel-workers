# Laravel → Cloudflare Workers — The Map

**Repo:** `laravel-workers` (name decided — GitHub/npm checked; see §10)
**Status:** v1.1 — living doc. Basis: **measured evidence + verified platform limits**, not theory.
**Coverage guarantee:** Appendix C maps **all 105 pages** of the official Laravel 13.x docs to a verdict — a page without a verdict is a gap, and gaps are build-blocking. See §5.
**What this is:** a build-time toolchain — `compiler` (Blade → PHP → JS, byte-parity vs PHP 8.3) + Workers-native `kernel` + `build.mjs` pipeline. Not a Laravel runtime, not PHP-in-Worker. Controllers are transpiled (a documented subset — M10/M17/M22/M23); anything outside it fails the build and needs a `ports/*.mjs` handler.
**Scope:** how a Laravel app runs natively on Workers — Laravel stays the source of truth for dev; the edge artifact is compiled (static assets + JS handlers + D1). No PHP at request time.

> **This is the "padanan" map.** Every Laravel feature is classified:
> ✅ **Fits** — direct equivalent, runs within budget.
> 🟡 **Soft tolerance** — works with a documented trade-off (the trade is part of the contract).
> 🔴 **Hard** — platform wall → needs a defined *padanan* (alternative) or the escape hatch (hand-written port). Never silent: anything uncovered fails the build.
> ⛔ **N/A at edge** — local-only tooling or meta page (with reason).

Why not the existing path (PHP-in-Worker via wasm): boots PHP per request; **measured 1.0–2.5s CPU** cold boot vs **10ms** Free CPU budget → 503s. Only principled fix: move all boot to build time. (See §A.)

---

## 0b. Prior art & what is actually new

Checked Oct 2026. Prior art is **fragmented** — no end-to-end equivalent found so far.

| Prior art | What it does | Gap vs us |
|---|---|---|
| `workersphp/laravel-bridge`, `php-wasm` | Runs PHP itself in the Worker (WASM) | PHP boots per request → measured 1.0–2.5s CPU → broken on Free |
| `togishima/laravel-edge` (2026, 2★) | "Plain Laravel on Cloudflare Workers" via custom php-wasm build + D1 | Same wasm-boot class; validates the space; tiny/early |
| `spatie/laravel-export` (+ GitHub Pages guides) | Crawls Laravel, dumps static HTML | Static only; no dynamic endpoints, no Workers model, no tiers/coverage |
| `uniter/phptojs`, `glayzzle/php-transpiler`, `aftermarketpl-php2js`, ... | Generic PHP→JS transpilers | Not Laravel-aware; no router/view/DB/kernel layer, no parity harness |
| `cloudflare/php-worker-hello-world` | Cloudflare's own demo: PHP→JS via `babel-preset-php` | Hello-world only; abandoned direction; no framework support |
| `ulanguage.org` | PHP→C/WASM compiler (~93% coverage claim) | WASM/lib route, not a Workers-native JS toolchain |

**What's actually new (claim candidate):** the *end-to-end combination* — Laravel as source of truth → build-time boot → Workers-native artifact with **no PHP at request time**: tiered static/snapshot/compiled/ports + coverage enforcement + D1-backed kernel + parity tests + free-plan budget engineering.

**Claim policy:** "discovery" language only after M1–M2 land (view parity + compiled handlers) *and* the formal prior-art scan (W0) stays clean. Formal W0 scan (2026-10-17): **CLEAN** —; re-run before any public claim. Until then: "an approach in progress", backed by measurements.

---

## 1. The real limits we operate within

**Measured by us** (not assumed):

| Fact | Value | Source |
|---|---|---|
| Laravel-wasm worker burst | 12/18 OK, CPU **1008–2018 ms** | probe |
| Native JS handler (ports) | **1–6 ms** CPU, 26/26 OK | probe |
| Static asset response | **0 worker invocations** | verified behaviorally |
| Static page latency | ~0.83s incl. network wall | smoke |

**Platform limits** (official docs, verified):

| Resource | Free | Paid ($5/mo) |
|---|---|---|
| Requests | 100k/day | unlimited |
| CPU / request | **10 ms** | 30s default (up to 5min) |
| Subrequests / request | 50 | 10,000 |
| Worker size / startup | 64 MiB / 1s | 64 MiB / 1s |
| Cron triggers / account | 5 | 250 |
| D1 rows read | 5M/day | 25B/mo incl. |
| D1 rows written | 100k/day | 50M/mo incl. |
| D1 storage | 5GB total (500MB/db) | 10GB/db |
| KV | 100k reads + 1k writes/day, 1GB | unlimited reads/writes |
| Queues | 10k ops/day (retention 24h) | 1M ops/mo incl. |

**Green budget target:** typical handler ≤ 5ms CPU (measured 1–6ms). Everything above budget is a design smell, not a wall to push through per request.

---

## 2. Tolerance model — soft vs hard

This is the core lens for the whole map. Limitations are **not all equal**:

**🔴 Hard (the wall).** Platform-enforced; cannot be negotiated at that layer. The architecture must route around it, or we owe a defined *padanan*.
Examples: 10ms CPU/req (Free) · no raw sockets · no filesystem · 1s startup · ≤50 subrequests/req · no long-lived process.

**🟡 Soft tolerance.** Negotiable — absorbed by trade-off, degradation, or an alternative implementation. The trade-off is *documented, not hidden*.
Examples: eventual consistency (KV) · async-by-queue instead of synchronous · PBKDF2 instead of bcrypt (slower-hash trade) · polling instead of WebSockets · static-first to protect quotas · batched writes.

**Rules**
1. Every feature lands in ✅ / 🟡 / 🔴 / ⛔ with its trade documented.
2. 🔴 never means "impossible" — it means *padanan required* (queue, cron, R2, Durable Object, batched SQL, or escape-hatch port).
3. Escape hatch always exists: **ports** (hand-written edge-native JS) guarantee a route can ship even if the compiler can't cover it yet.
4. Coverage is enforced: unhandled route → build warning; `--strict` → build fails. No silent gaps.

---

## 3. Execution model

**Request path (best → fallback), unchanged from today's pipeline:**

| Tier | Runs | Worker invocations | Budget |
|---|---|---|---|
| 1. Static / snapshot | CF asset layer | **0** | always Free |
| 2. Compiled handler | Worker: compiled JS (router → middleware → handler → D1) | 1 | 1–6ms measured |
| 3. Port (escape hatch) | Worker: hand-written JS | 1 | same |
| — unhandled | build flag / `--strict` fail | — | — |

- **Auto-snapshot:** any clean GET route that returns HTML at build time is rendered by real Laravel and written as a static page — appears at the edge on next deploy, zero config (`autoSnapshot`).
- **Build path (PHP allowed here only):** dump route table → compile views → schema snapshot → freeze config → prerender/snapshots → parity tests → bundle → deploy (`wrangler deploy`).

---

## 4. Compiler pipeline

| Stage | What | Where | Tool |
|---|---|---|---|
| S0 | Dump routes / compiled Blade / schema / config / lang | build (PHP boots) | `edge/tools/*.php` |
| S1 | Transpile: Blade→JS, PHP-subset→JS, routes→router, schema→models | build (Node) | `edge/tools/*.mjs` |
| S2 | Bundle: kernel + generated modules → worker ESM | build | edge bundler |
| S3 | Parity tests: Laravel output vs compiled output | build/CI | golden tests |
| S4 | Coverage + `--strict` gate | build | `build.mjs` |
| S5 | Assets: snapshots + `public/` copy | build | `build.mjs` |
| S6 | Deploy | Cloudflare | `wrangler deploy` after build |

The **single transpiler** (PHP-subset→JS) serves the compiled Blade views *and* compiled controllers today, plus generated model metadata. Routes outside the compiled subset (relations, pagination, multi-verb actions, custom middleware) still ship as hand-written `ports/*.mjs`.

**Build invocation:** `build.mjs` is **cwd-based** when installed as `laravel-workers` npm package — `registry.json` (or `laravel-workers.json`) in the Laravel app root (npm mode: `appDir !== pkgDir`, `dist/` in app); legacy `edge/registry.json` fallback when developing from checkout.

---

## 5. Feature map (the padanan table)

**Coverage guarantee — how "100%" is enforced:**
1. **Docs index** — Appendix C maps every page of the official Laravel 13.x docs (105 pages) to a verdict. No blanks allowed; new docs pages must get a verdict before a release. Re-check is scripted against the `laravel/docs@13.x` file list (W8).
2. **Language contract** — §6b: anything outside the supported PHP subset is a **compile error**, never a silent mistranslation.
3. **Route coverage** — `--strict` fails the build on any unhandled route (already enforced today).
The escape hatch stays: **ports**.

### A. Routing & HTTP

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Basic routes, params | Compiled router (pattern match) | ✅ | from `route:list` dump | F |
| Named routes, `route()`, `url()` | Frozen name map | ✅ | | F |
| Route groups / middleware | Compiled pipeline | ✅ | `handleHttp` runs web group + `auth`/`guest`/`throttle`; 11-step oracle parity (M15) | F |
| Redirects | `Response` redirect | ✅ | `redirect()`/`->to`/`->route` + `->intended()` (M20, pulls `url.intended`); `back()` needs session | F |
| Signed URLs | HMAC in kernel | ✅ | same key derivation | F |
| Route model binding | Compiled lookup | 🟡 | id-first subset initially | F |
| Custom middleware | Compiled like controllers | ✅ | | F |
| Throttle middleware | Counter in D1/KV | ✅ | numeric `throttle:n[,m]` wired in `handleHttp` over the D1-backed `database` cache store (M18); named `throttle:name` needs its `AppServiceProvider` definition → build fails loud | F |
| CSRF | Token in session store | ✅ | kernel PreventRequestForgery wired in `handleHttp` + end-to-end oracle parity (M15) | F |
| Cookie encryption | Laravel Encrypter parity (AES-CBC + HMAC) via WebCrypto | ✅ | EncryptCookies wired in `handleHttp`; round-trip + prefix parity in `cookies.test.mjs` | F |

### B. Views

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Echo, `@if/@foreach/@include/@extends/@section...` | Compiled JS render fns | ✅ | | F |
| `@vite` / `@fonts` | Runtime shim reading build manifest | ✅ | **already proven in snapshots** | F |
| `@php` blocks | Restricted subset | 🟡 | else build error (no silent) | F |
| Blade components (`x-...`, slots) | Phase 2 | 🟡 | padanan now: inline partial | F |
| Custom directives | Registered renderers | 🟡 | later | F |

### C. App code

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Controllers / closures | PHP-subset → JS | ✅ | multi-verb controllers compiled (GET/POST/PUT/PATCH/DELETE, one handler per verb): scalar params + `Request $request` injection, model chains + views, `session()`/`old()`/`csrf_token()`/`csrf_field()`/`request()`/`auth()`/`Auth::*`, `response()`/`response()->json()`, `Cache::*`/`Hash::*` facades, class constants (`RouteServiceProvider::HOME`, dumped at build time), Eloquent writes (`create`/`fill`/`save`/`delete`, `$model->attr = …`); fail loud elsewhere | F |
| Service classes / helpers | PHP-subset → JS | ✅ | | F |
| Form Requests | Compile rules + authorize | ✅ | `rules()`/`messages()`/`attributes()` are dumped at build time (`tools/formrequest-dump.php`) and compiled into the handler: the request is validated before the method body (like the container resolving the FormRequest), and `validated()` returns the ruled attributes. `authorize()` must return true, `prepareForValidation()` is not supported → build fails loud. A class-typed parameter that is not a FormRequest is a service → build fails loud | F |
| Validation | Rule subset in kernel; `unique`/`exists` via D1 | 🟡 | `$request->validate()`/`validateWithBag()` compile to an awaited kernel-validator call; a failure renders like Laravel — 302 back (Referer → previous URL → `/`) with flashed `errors` + `_old_input` (minus `dontFlash`), or 422 JSON for `expectsJson`. `$attributes` display names (exact/wildcard/PHP-truthiness/raw-implicit/`Str::snake` fallback) and `:attribute` custom-message replacement are wired; json session serialization only (the ViewErrorBag php-serialization path fails loud) (M19/T10) | F |
| Events / Listeners | Synchronous compiled | ✅ | queued listeners → queue | F |
| Exceptions / error pages | Kernel map → static error pages | 🟡 | `resources/views/errors/{code}.blade.php` compile at build time and render for `abort()`/HTTP errors when present; otherwise status-only stubs | F |

### D. Data

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Migrations | PHP-side, applied to remote D1 (SQL export / wrangler) | ✅ | ops-time, not request-time | F |
| Seeders / factories | Local + SQL import | ✅ | | F |
| Eloquent CRUD | Generated model metadata + D1 | 🟡 | subset: find/findOrFail/all/where/whereIn/orderBy/limit + writes (`create`, `fill`, `save`, `delete`, `forceDelete`, `restore`, `$model->attr = …`); the write path needs the D1 binding (`rt.db()`) | F |
| Relationships | includes / eager subset | 🟡 | belongsTo, hasMany first | F |
| Casts / accessors | Compiled | 🟡 | | F |
| Query builder subset | Kernel builder → SQL | 🟡 | | F |
| Raw SQL | Pass-through to D1 | ✅ | | F |
| Transactions | D1 atomic `batch()` | 🟡 | interactive tx unsupported (platform) → padanan: single-request batch | F |
| Pagination | Length-aware paginator | ✅ | | F |
| Search | D1 (SQL LIKE / FTS5); vector → CF Vectorize padanan | ✅ | | F |

### E. State & security

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Sessions | D1-backed store + encrypted cookie | ✅ | kernel Store + cookie/D1 handlers, oracle byte-parity (M11); wired in `handleHttp`, payload bytes compared per step (M15); `regenerate()`/`invalidate()`/`regenerateToken()` wired from compiled controllers (M20) | F |
| Auth (guard, login/logout, remember) | Kernel + D1 users | ✅ | kernel SessionGuard, EloquentUserProvider, BcryptHasher, `auth`/`guest` middleware oracle-verified (M14); wired in the compiled pipeline + end-to-end parity (M15); the `auth.basic` middleware is honoured (Basic header → `guard->attempt()`, 401 + `WWW-Authenticate: Basic realm="Basic"` on failure) | F |
| Password hashing | bcrypt via bcryptjs (`$2y$` parity) | ✅ | kernel BcryptHasher make/check/needsRehash/verifyConfiguration (M5); free-plan CPU banked (measured); the `Hash` facade compiles to it (`Hash::make`/`check`/`needsRehash`/`isHashed`) with the app's `hashing.bcrypt.rounds` | F |
| Rate limiting | D1 counters (`cache` table) | ✅ | kernel RateLimiter + ThrottleRequests oracle-verified (M12); runs on the D1 `database` cache store (M18). `increment` is read-then-write — D1 has no interactive transactions | F |

### F. Platform services

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Mail | HTTP providers (Resend etc.) via `fetch` | 🟡 | kernel/mail.mjs exists (log/noop/resend); **wired** (M28) — the worker builds the mailer from the app config (`mail.default` → log/noop/resend) and hands it to the handler; the fluent `Mail::to()->send()` **compiles** (M57: a mailable is a class - the build compiles it and the kernel's `Mailable` base carries Laravel's fluent surface; the mailer sends the recipients, the subject and the rendered view) → the methods the kernel mailer does not implement (`raw`, `html`, `queue`, `later`) fail loud (padanan = HTTP provider; SMTP impossible, hard) | F |
| Queues / Jobs | Cloudflare Queues (a limited version on the Workers free plan; the paid plan charges per operation - 10,000 operations/day included on the free plan) or D1 queue | 🟡 | **wired** (M28) — the worker hands the queue adapter to the handler (a port can push); the `Queue::push(SomeJob::class)` facade fails loud — the job would never run at the edge: the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job (the runtime throws the same). The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row — the edge has no producer for it). The job class is not compiled either → port | F |
| Scheduler | Cron Triggers → one dispatcher reads schedule | 🟡 | **wired** (M29): the build dumps the app schedule (cron expression + command) into `dist/src/schedule.generated.mjs` + `dist/cron.json` (the Cloudflare trigger list); the worker's `scheduled` handler queues the due events for the app runtime (the edge triggers, it does not run artisan) | F |
| Cache | D1 `database` store (Laravel parity) + KV cache-aside | ✅/🟡 | `DatabaseCacheStore` mirrors `Illuminate\Cache\DatabaseStore` 13.37, oracle-verified incl. raw rows (M18); KV stays for build-time/simple caching (eventual consistency trade); the `Cache` facade compiles to it (`get`/`has`/`put`/`add`/`forever`/`forget`/`remember`/`pull`/`increment`/`decrement`/`touch`/`flush`) | F |
| Storage / filesystem | Uploads → R2 *or* the D1 blob store; `file_exists`/`public_path` → build-time snapshot | 🟡 | no local FS (hard) → object storage is the padanan; **wired** (M28): the `Storage::` facade compiles to the store (`put`/`get`/`exists`/`delete`) and the worker hands the adapter to the handler; **M30**: R2 when the app binds it, else the **D1 blob store** (one row per object in `lw_blobs` — no extra Cloudflare product, no card); with neither binding the build fails loud and names the missing one (no silent in-memory writes). **Shadow-verified**: the compiled side writes to the D1 blob store and reads it back byte-identically to the real app on the local disk. **M40 part 5**: the **upload** compiles — the multipart body is parsed at the edge, `$request->file()` answers Laravel's file object, `$file->store()`/`storeAs()` write to the app's default disk (the same store) and answer the disk-relative path; the `file` rule and the size rules (in kilobytes) work; the content type of a file (finfo) fails loud | F |
| HTTP client | `fetch` | ✅ | no raw sockets (hard); 6 concurrent conns → batch/queue | F |
| Logging | Console + optional external sink via fetch | 🟡 | no Log module; `Log::` facade not mapped → port; console + fetch sinks only | F |
| Realtime / WebSockets | Polling / SSE; Durable Objects beyond | 🔴 | wall: no long-lived conn → padanan: polling/SSE first | F* / $ |
| i18n | Lang frozen to JSON; pluralization subset | 🟡 | Lang frozen to JSON; pluralization subset (see `localization`) | F |

### G. Frontend / DX

| Laravel | Edge equivalent | Class | Notes / padanan | Plan |
|---|---|---|---|---|
| Vite build | Unchanged | ✅ | already working | F |
| Artisan | Local only; edge CLI (`build`/`ship`) | ✅ | | F |
| PHPUnit | Local unchanged; parity suite added | ✅ | | F |
| Livewire / Inertia / Filament | Out of v1; Inertia feasible (JSON port) phase 3; Livewire hard | 🔴* | documented, not promised | later |
| Telescope / Horizon / Debugbar | Local-only tools | ⛔ | N/A at edge | F |

**Free vs Paid summary:** everything above runs on **Free with documented trades**; Paid buys headroom (30s CPU, bcrypt, 25B rows/mo, 10k subrequests, DO) — never a dependency for the demo path.

---

## 6. Runtime kernel (edge JS)

`config` (frozen) · `router` · `request`/`response` · `view` · `db`/D1 · `orm` (model subset) · `session` · `csrf` · `auth` · `hash` · `encrypter` · `validation` · `mail` · `queue` · `cache` · `storage` · `scheduler` · helpers (`e`, `url`, `route`, `asset`) · error pages.
All Laravel facades map to one kernel module — ports already use this pattern (e.g. `driver: 'd1-binding'`).

---

## 6b. PHP subset contract (language-level guarantee)

Policy: the compiler **never silently mistranslates**. Anything outside the supported set = build error with an error code + a suggested pattern.

**Supported (compile):** classes (single inheritance, `implements`), typed properties/params/returns, visibility, static members, consts, enums, closures + arrow fns (with `use` capture), arrays (list/assoc), full control flow (`if/elseif/else`, `switch`, `match`, `for/foreach/while/do`), `try/catch/finally`, `throw`, null-safe `?->`, `??`, spread/variadics, string interpolation, ternary, namespaces/`use` resolution (compile-time), traits (flatten, ph2), first-class callables (ph2).

**Soft (documented trade):** generators → eager arrays (memory trade) · magic methods → limited shim (app models use the native ORM instead) · Carbon → date shim subset · interfaces/abstract → type-erased with compile-time checks.

**Unsupported (error code + alternative):** `eval` · variable variables `$$x` · dynamic `new $class()` · dynamic includes · reference semantics (`&`) · runtime reflection-heavy code · process execution · raw streams.

**Alternative offered per error:** a rewrite pattern, or **port the route** — the guaranteed escape hatch.

---

## 7. What stays PHP

- Local dev: `php artisan serve`, `artisan test`, migrations, seeders, tinker.
- Build-time: dumps, prerender, parity harness (PHP boots here — never at request time).
- **The app remains a normal Laravel app.** Edge is a *deploy target*, not a fork. New Laravel features flow to the edge via build → coverage report → deploy.

---

## 8. Workstreams (agent-ready)

| # | Workstream | Inputs \| Outputs | Depends |
|---|---|---|---|
| W0 | Prior-art scan + claims guard (keep "discovery" honest) | landscape → report | — |
| W1 | PHP-subset transpiler (expr/stmt coverage + error codes) | PHP files → JS ESM | — |
| W2 | Blade compiler (directives, layouts, includes; components later) | compiled Blade PHP → JS render fns | W1 |
| W3 | Router + middleware kernel + route dump | route table JSON → dispatcher | — |
| W4 | D1 layer (schema snapshot, builder, models, pagination) | schema JSON → ORM | — |
| W5 | Session + CSRF + Auth + Hash + Encrypter (two-sided parity: new PHP drivers + JS) | kernel modules + PHP drivers | W4 |
| W6 | Validation + FormRequests + error flows | kernel module | W5 |
| W7 | Services: Mail / Queue / Cache / Storage / Scheduler | kernel modules | — |
| W8 | Parity harness + CPU-budget tests + CI (incl. docs-index re-check vs `laravel/docs@13.x`) | golden tests, thresholds | interfaces first |
| W9 | Docs / benchmarks / packaging (`npx` CLI) | docs, bench suite | — |
| W10 | Demo app (nearFind) features + polish | shipped worker | W2/W5 |

**Artifact contracts** (stable JSON): `route-table.json`, `views.json` (compiled), `schema.json`, `config.json`. Interfaces first → agents work in parallel without collisions.

**10 workstreams ≠ 10 agents.** Fan-out happens *inside* workstreams once an artifact contract freezes (after M1): W2 splits by directive group, W4 into builder + ORM + pagination, W5 into session/CSRF · auth · hash/encrypter. Expect ~20–30 agent slots across the program, ~4–6 truly parallel at a time — beyond that it's file collisions and review lag, not speed.

---

## 9. Unknowns to verify when first used (not blockers)

| Item | Why | When |
|---|---|---|
| D1 max queries / invocation | budget design assumes ≤ handful anyway | W4 |
| Durable Objects on Free | affects realtime padanan choice | W7 |
| R2 free tier numbers / the D1 blob-store limits | uploads sizing | W7 |
| Asset-request billing | assumed not billed (0-invocation behavior verified) | ops |
| PHP parser choice (npm `php-parser` vs own tokenizer) | transpiler core quality | W1 spike |

---

## 10. Open decisions

1. ~~Name~~ → **decided: `laravel-workers`** (GitHub/npm checked 2026-10; nearest collision is a Docker tool, 28★/2019). ~~Repo strategy~~ → **decided: standalone repo.** Development incubates in `edge/` until M1–M2 (first parity proof), then extracts to the standalone repo. PRs to `ntanduy/cloudflare-d1-database` / `workersphp/laravel-bridge` become optional cross-links later, not the home.
2. **Paid fallback stance:** keep Free-first default (recommended) with Paid as headroom.
3. **Demo feature shortlist** (drives W10): deferred by user — decide near the end (demo is projected last); nothing blocked meanwhile.

---

## A. Measured evidence log

- Laravel-wasm worker (workersphp bridge): burst 12/18 OK, CPU 1008–2018ms → Free-unusable.
- Prototype worker: 26/26 OK, CPU 1–6ms; static served with 0 invocations.
- Pipeline shipped: static + snapshot + ports + coverage + one-command ship; `/dbcheck` D1 port live; `/` snapshot byte-verified (title/spacing/Vite tags).
- Compiled-Blade dump works today (`edge/tools/compile-view.php` → JSON with context: config, routes, vfs) — first compiler artifact.
- **M1-alpha parity PASS (2026-10-17):** transpiled `welcome` (compiled Blade → JS) rendered via `rt` = `php prerender.php /` output **byte-identical** — 35,647 B, sha256 `b228c8a2…` equal on both sides (strict rt, no warnings). Transpiler: php-parser 3.7.0, fail-loud LW001–LW004. Context: enriched S0 (app/config/vite/files/auth/routes/route_names/urls + legacy).
- **M1 complete (2026-10-18):** smoke PASS, corpus ALL PASS (41/41), verify-s0 PASS (15/15). Transpiler fixes: `node.expr`->`expression`, null/nullkeyword, boolean, elseif chains, var redecl, compound assign, `.`->rt.concat, `+`->rt.add, rt.e PHP cast, rt.sprintf %%, rt.str_replace empty needle, float formatting.
- **M1-transpiler widened (2026-10-18):** PHP-subset now covers `for`/`while`/`foreach` (incl. `key => value`), comparison (`==`/`!=`/`===`/`!==`/relational) + logic (`&&`/`||`/`and`/`or`/`!`), ternary/`?:`, `??`/`??=`, `switch` (loose fallthrough), `match` (strict), `isset()`/`empty()`, function declarations (defaults, recursion), full string interpolation. php-parser is PHP 7, so mixed `.`/`+`/`-` chains are re-associated to PHP 8 precedence. Verified against a **PHP 8.3 oracle** (`php case.php` → `expectations/*.txt`); the 25 former-UNSUP cases flipped to SUP, corpus now **41/41 SUP byte-exact**; five more SUP cases (strlen/substr, str_contains/starts/ends, str_repeat/str_pad, ucfirst/lcfirst, array_keys/values/merge/key_exists) bring it to **46/46**.
- **M1 runtime helpers widened (2026-10-18):** `rt-from-context.mjs` + `src/transpiler.mjs` add `ltrim`/`rtrim`/`ucwords`/`strrev`/`strpos`/`strrpos`/`substr_count`/`strip_tags`/`htmlspecialchars`, `is_*` predicates, `abs`/`round`/`floor`/`ceil`/`intval`/`floatval`/`max`/`min`, `json_encode`/`json_decode`, and `array_sum`/`array_slice`/`array_reverse`/`array_unique`/`array_count_values`/`array_flip`/`array_filter`/`array_map` (callbacks resolved from named functions). Five new PHP-oracle cases -> corpus **51/51 byte-exact**.
- **M2 complete (2026-10-18):** router integration live — build --strict PASS (2 routes), routes.generated.mjs + controllers, W3 router in worker, ROUTER INTEGRATION PASS, CPU BUDGET PASS (p95 <= 0.04 ms), W3 tests PASS, parity/corpus/verify-s0 green.
- **M3 complete (2026-10-18):** D1 layer shipped - schema snapshot (`.cache/schema.json` -> `dist/schema.json`), `kernel/db.mjs` query builder, `kernel/model.mjs` Model base, mock-D1 tests PASS (8/8), build `--strict` PASS, `nearfind-edge` redeployed, `/dbcheck` live via builder.
- **M4 complete (2026-10-18):** packaging + CI shipped - `package.json` (`laravel-workers@0.3.0`, bin CLI), `bin/laravel-workers.mjs`, `.github/workflows/ci.yml`, README status M4, MIT license; kernel tests PASS (9/9), corpus PASS (41/41), `npm pack --dry-run` clean.
- **M5 complete (2026-10-18):** Hash + Encrypter parity — `kernel/hash.mjs` (`make`/`check`/`needsRehash`, `bcryptjs`) + `kernel/encrypter.mjs` (AES-256-CBC+HMAC, WebCrypto, `encryptString`/`decryptString` byte-compat), kernel tests PASS (16/16 incl. MAC-tamper/wrong-key/unicode+long), CI green.
- **M6 complete (2026-10-18):** Validation kernel — `kernel/validator.mjs` (22 rules, pipe-safe regex, nullable/sometimes, same/confirmed, validated()), tests 12/12.
- **M7 complete (2026-10-18):** Services kernel — `kernel/mail.mjs` (log/noop/resend), `kernel/queue.mjs` (memory + CF Queues), `kernel/cache.mjs` (memory+TTL + KV), `kernel/storage.mjs` (memory + R2), `kernel/scheduler.mjs` (UTC cron), tests 18/18.
- **M8 complete (2026-10-18):** Final gates - tools/docs-check.mjs 105/105 + tools/bench.mjs + kernel/tests/budget.test.mjs (p95 <=5ms hot, <=30ms encrypter), npm test 47/47 + corpus 41/41 + pack 34 files green, CI now runs docs-check + bench.
- **M9 complete (2026-10-18):** Zero-touch hardening — scaffold stubs fixed to the controller contract (default export + `{status, headers, body}`) with a `laravel-workers:stub` marker; `build --strict` now fails on unimplemented stubs and on registered ports whose files are missing; `LW_CONFIG` / `LW_PORTS_DIR` move registry + ports outside the repo (set-but-missing fails loud); `registry.json` is optional (defaults + notice); routes defined outside `routes/` are listed as skipped. `tools/ports.mjs` + `kernel/tests/ports.test.mjs` (5 tests) -> npm test **170/170**. E2E: scaffold stub returns 501 with the worker alive, implemented port returns 200 via local D1; external config+ports build; fresh Laravel 13.37 zero-config build PASS. CI gains an e2e job: fresh Laravel -> zero-config strict build -> dist asserts -> `wrangler dev` runtime smoke (`/health` + `/` = 200).
- **Model relations (2026-10-18):** `kernel/model.mjs` gains `hasMany`/`hasOne`/`belongsTo` (default foreign key = related model snake_case + `_id`), `firstOrCreate`/`updateOrCreate`, `refresh`, `increment`. `kernel/tests/db.test.mjs` +3 subtests -> npm test **73/73**.
- **Router hardening (2026-10-18):** `kernel/router.mjs` now enforces `domain` rules (incl. `{sub}.example.com` param capture, port stripping), supports catch-all `{param*}`, and honours `X-HTTP-Method-Override` / `methodOverride` (POST only) with `ctx.request.method` reflecting the effective verb. `kernel/tests/router.test.mjs` extended (wildcard, domain, override).
- **Route metadata (2026-10-18; middleware added M18):** `build.mjs` no longer hardcodes `name: null, domain: null`; it now carries `name`/`domain`/**`middleware`** per route (from `php artisan route:list --json`) into `routeTable` and emits a `routeNames` map in `dist/src/routes.generated.mjs`. (Pre-M18 the emitted entry dropped `middleware`, so `kernel/http.mjs` treated every compiled route as not-in-the-`web`-group and took the bare, session-less path; the audit that was supposed to catch bad route middleware was dead for the same reason.) `src/worker.mjs` passes `host` so domain rules actually match at request time.
- **Query builder widening (2026-10-18):** `kernel/db.mjs` gains Laravel-style `where(fn)`/`orWhere(fn)` nested grouping, `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime` (SQLite `date()`/`strftime()`/`time()`), `sum`/`avg`/`min`/`max`, `upsert` (`ON CONFLICT … DO UPDATE|NOTHING`), `insertGetId`, `truncate`, `increment`/`decrement`, `updateOrInsert`, `chunk`, and `implode` now folds assoc values. `kernel/tests/db.test.mjs` +7 subtests -> npm test **80/80**.
- **Static-assets routing (2026-10-18):** new `tools/routes-json.mjs` (`routeToPatterns`, `buildRoutesJson`) emits `dist/public/_routes.json` so only dynamic (view/port) routes invoke the Worker and `/build/*` is excluded; `build.mjs` writes it after the route table. New `kernel/tests/routes-json.test.mjs` (3 subtests) -> npm test **87/87**.
- **Validator wildcards (2026-10-18):** `kernel/validator.mjs` now resolves nested dot paths (`user.name`) and expands wildcard keys (`items.*.name`) into concrete paths, with missing leaves still validated (`items.2.name`), `validated()` re-nesting dotted fields, and conditional/`same`/`gt`-style rules reading nested "other" fields. +6 subtests -> npm test **93/93**.
- **Model widening (2026-10-18):** `kernel/model.mjs` adds casts (`json`/`array`/`object`/`collection`, `decimal:N`, `timestamp`, scalar/temporal), accessors/mutators (`getFooAttribute`/`setFooAttribute`), `hidden`/`visible`/`appends` in `toJSON`, json casts encoded on save, soft deletes (`query` filters, `trashed`, `withTrashed`/`onlyTrashed`, `delete` stamps, `restore`, `forceDelete`), and `findOrFail`/`firstOrFail`. +4 subtests -> npm test **84/84**.
- **Validator widening (2026-10-18):** `kernel/validator.mjs` adds `exclude`/`exclude_if`/`exclude_unless`/`exclude_with`/`exclude_without` (dropped from `validated()`), `missing*`, `present_if`/`present_unless`/`present_with(_all)`, and value rules `doesnt_start_with`/`doesnt_end_with`/`list`/`required_array_keys`/`array_keys`/`in_array`/`decimal`/`timezone`. +6 tests -> npm test **100/100**.
- **Model eager loading (2026-10-18):** `kernel/model.mjs` adds declared relations (`static relations`), `query(db).with('name')` batch eager loading (hasMany/hasOne/belongsTo, default foreign keys), `related()`/`load()` lazy loading, `setRelation`/`getRelation`/`relationLoaded`, relations included in `toJSON()`, and local scopes via `query(db).scope('name')` -> `scopeName(builder)`. Unknown relations/scopes fail loud. +6 subtests -> npm test **106/106**.
- **Eager loading + EXISTS + real-SQL tests (2026-10-18):** `kernel/model.mjs` adds `query(db).withCount('comments')` (exposes `comments_count`), `whereHas()`/`whereDoesntHave()`/`has()`/`doesntHave()` as correlated `EXISTS` subqueries (relation callback constraints inlined), and `instance.loadCount()`. New `kernel/tests/sqlite-integration.test.mjs` (8 tests) runs the builder + Model layer against **in-memory SQLite** (`node:sqlite`, Node >= 22, D1-shaped `prepare/bind/all/first/run` adapter) so joins, `EXISTS`, `whereIn`, soft deletes and `create/save/delete` are verified on real SQL, not string-matched. -> npm test **114/114**.
- **D1-safe binding + Model.create fill (2026-10-18):** `kernel/db.mjs` normalizes every bound param (`boolean` -> `1`/`0`, `Date` -> ISO string, `undefined` -> `null`) because D1/SQLite reject JS booleans ("Provided value cannot be bound"); `kernel/model.mjs` `Model.create()` now goes through `fill()` so mutators, `fillable` and json casts apply on insert (previously stored raw values). `kernel/tests/sqlite-integration.test.mjs` +4 (22 total) -> npm test **128/128**.
- **Relation aggregates + `has()` counts (2026-10-18):** `kernel/model.mjs` adds `withSum()`/`withAvg()`/`withMin()`/`withMax()` (`comments_sum_votes` naming, one query per relation, `null` when no rows), `has(rel, '>=', n)` / `whereHasCount()` as correlated `(SELECT COUNT(*) …) op ?` subqueries (callback constraints inlined), and `instance.loadAggregate()`. Unknown relations/columns/operators fail loud. `kernel/tests/sqlite-integration.test.mjs` +3 (18 total) -> npm test **124/124**.
- **Date-part filter fix + wider real-SQL suite (2026-10-18):** `kernel/db.mjs` `whereDate`/`whereYear`/`whereMonth`/`whereDay`/`whereTime` now compare against `CAST(? AS TEXT)` with zero-padded bounds (`%m`/`%d` are padded), so numeric/string bounds actually match TEXT date columns — previously `whereMonth('created_at', 2)` returned **no rows** (real bug the SQLite suite caught). `kernel/tests/sqlite-integration.test.mjs` extended to 15 tests covering `where(fn)` grouping, `whereIn`/`between`/`like`/`column`/`notIn`, date parts, aggregates + `groupBy`/`having`/`distinct`, `upsert` (DO UPDATE / DO NOTHING), `insertGetId`, `increment`/`decrement`, `updateOrInsert`, `truncate`, `chunk`, `paginate`, `pluck`/`value`/`exists` on real SQL. -> npm test **121/121**.
- **Hash widening (2026-10-18):** `kernel/hash.mjs` adds `Hash::isHashed()` (bcrypt `$2a/$2b/$2y$` + argon2 digests), so callers don't double-hash. +1 subtest -> npm test **94/94**.
- **M40 - the build-level constructs, part 1 (2026-10-20):** the **route-model binding** compiles (`show(Post $post)` — the model comes from the route segment, `findOrFail` -> a 404 like Laravel's `ModelNotFoundException`; the binding is checked the way Laravel binds it, **by name** (LW004), and a model that binds on another key (`getRouteKeyName()`) fails loud (LW003)). The **method handling** is Laravel's `AbstractRouteCollection`: an `OPTIONS` request gets the **automatic OPTIONS response** (200, an empty body, the `Allow` header with the verbs the URI accepts, in Laravel's verb order) and a method that does not match answers 405 (when the app has an `errors/405` view) or 500 (the framework's error renderer) — the build dumps the `errors.405_view` flag so the compiled side answers the same status. The **CORS** config is *not* compiled: the build skips the routes under a CORS path (the `Access-Control-*` headers would be missing) and says what to do. `kernel/router.mjs` gains `allowedMethods()`; `tools/php-shadow-oracle.php` prints its JSON behind a marker (the error renderer writes to the output stream) and the shadow harness can now assert a step's **status** and **headers** (`expectStatus` / `expectHeader`) — a documented divergence is now *provable*. The shadow fixture: 30/35 byte-identical, 1 shape-verified, 4 documented, 0 unexplained.
- **M40 - the paginator (2026-10-20):** `Post::paginate(10)` compiles to Laravel's `LengthAwarePaginator` — new `kernel/paginator.mjs` (a line-by-line port of `Illuminate\Pagination\LengthAwarePaginator` + `UrlWindow`: the items, the total, the pages, the first/last item, the previous/next URLs, the URL window `elements()`, the RFC3986 query string). Laravel's own rules are kept: the page comes from the request (`?page=N`, a valid integer >= 1), the path from the request's URL, the per page 15 by default. The transpiler knows the `paginator` kind (a method outside the port's surface fails loud, LW003). **A silent wrong answer found by the shadow**: `$arr[] = $x` (the PHP array append) compiled to `$arr[null] = $x` — the array stayed empty; now it compiles to `rt.arrayPush()` and an array read without an offset fails loud. `kernel/tests/paginator.test.mjs` (5 cases) + a budget row; the shadow proves the first page and the second one byte-identical (32/37, 0 unexplained).
- **M40 - the pagination links + the translations (2026-10-20):** `$paginator->links()` renders the framework's `pagination::tailwind` view — the build compiles it like any other view (the name has a `::`, not a legal Windows file name → `compiler/src/view-name.mjs` sanitizes the compiled module names; the views map keeps the real name). A view carries no type information, so the build tells the compiler the *data kinds* it receives (`{ paginator: 'paginator', elements: 'array' }`) and the transpiler allows the paginator's methods there (a method outside the port's surface still fails loud). The **translations** (`__()`) are dumped at build time (`tools/config-dump.php`: the app's `lang/` files + the framework's fallback, the app's win) and the place-holders are replaced like Laravel does (also on the key, when the line is missing). The shadow proves the pagination markup **byte-identical** to Laravel's (33/38, 0 unexplained).
- **M40 - the file upload, part 5 (2026-10-20):** the **upload** compiles. The multipart body is parsed at the edge (`kernel/multipart.mjs`: the boundary, the plain fields, the files, the PHP field names — `photos[]` is an array, `photos[0]` an index), and `$request->file('x')` answers Laravel's file object: the name (the basename, like Symfony's `File::getName()`), the extension (`pathinfo(originalName, EXTENSION)`), the type the browser declared, the size in bytes, `isValid()`. The file is part of the validated data (Laravel's `all()` merges the files, the body wins on a conflict) and is **not** flashed back into the form (Laravel's `removeFilesFromInput`). The `file` rule works, and the size rules of a file are in **kilobytes** (Laravel's `(string) ($file->getSize() / 1024)`, compared exactly like `BigNumber`) with Laravel 13's own message. `$file->store()`/`$file->storeAs()` write to the app's **default disk** (the D1 blob store on the free plan — the binary object is base64-encoded in the row; R2 keeps the raw bytes) and answer Laravel's disk-relative path (`trim($path.'/'.$name, '/')`); a **named** disk fails loud (it needs a bucket of its own). What cannot be answered like PHP **fails loud**: the content type of a file (`getMimeType()`, `guessExtension()`) and the `mimes`/`mimetypes`/`image`/`dimensions` rules read the file's **bytes** (finfo) — the edge has only the type the browser declared, so the build stops (LW002 for the rules — inline and in a FormRequest — LW003 for the method) instead of answering differently. The shadow proves the whole path **byte-identical** (the metadata, the store round trip, the 422 of a too-big file, the multi-file field and the free path's 1.5 MB limit): 38/44 byte-identical, 1 shape-verified, 5 documented, 0 unexplained. npm test **455/455**.
- **M41 - the validation messages are Laravel 13's own (2026-10-21):** the kernel's default messages were Laravel 10 style ("The title must not be greater than 3.") while Laravel 13 writes "The title field must not be greater than 3 characters." — only the `required` path was proven by the shadow, so the gap was invisible. `kernel/validation-messages.data.mjs` is now **generated** from the framework's own `lang/en/validation.php` (`tools/validation-messages.php`) and `kernel/validation-messages.mjs` replaces the placeholders the way Laravel does (`Illuminate\Validation\ReplacesAttributes`: `:max`, `:min`, `:size`, `:values`, `:other`, `:value`, `:date`, `:input`); the app's published `lang/` file wins (the build dumps it with the translations). Two rules were silently wrong and are now Laravel's: `decimal:2` was a *minimum* (so "1.234" passed) and `date_format` only checked the shape ("2026-13-01" passed). The shadow proves the message byte-identical.
- **M39c - the class compiler (2026-10-21):** the **event listeners** compile. `Event::dispatch()` used to fail loud: the listeners are classes and at the edge there is no listener runtime — a dispatch that answers nothing is a *silent* no-op. Now the build **compiles the classes**: `tools/event-dump.php` boots the real app and asks **Laravel itself** which listener answers which event (`EventServiceProvider::getEvents()`: the explicit `$listen` + the auto-discovery of `app/Listeners`), `compiler/src/classes.mjs` compiles the constructor (the promoted properties; a constructor with a body fails loud) and the public methods (through the ordinary transpiler, so `$this` is the instance), and the runtime calls them **synchronously** (Laravel's `Dispatcher::dispatch()`: every listener runs, only an answer of `false` stops the chain, and the dispatch answers the array of the responses). The classes ship in `dist/src/classes.generated.mjs`. Still fail-loud on purpose: a dispatch of an event **name** (no class, no listener), a listener that takes a **service** the build does not compile (M44: the edge builds the app services and adapts the framework ones), a **queued** listener, `Queue::push()` (the job would never run at the edge — the worker has no queue handler, and the job class is not compiled either) and `Mail::to()->send()` (a mailable renders a Blade view). The shadow proves it: the compiled listener writes to the post exactly like Laravel's (`POST /event-demo` — byte-identical). npm test **463/463**.
- **M44 - the service injection of the listeners (2026-10-21):** a listener whose constructor asks for a **service** used to fail loud ("the edge cannot inject one"). Now the build knows what the constructor wants: `tools/event-dump.php` asks the **real container** (the dump carries each constructor's parameters) and the build compiles the **dependency** — an app service the build compiled (the edge builds it) or a framework service (`kernel/service-adapters.mjs`: the mailer, the logger — the worker hands the live one down, `compiler/runtime/rt-from-context.mjs`). The type of a parameter written short (`Mailer`) resolves through the file's `use` statements and its namespace (PHP's own resolution); a name that several compiled classes share fails loud (the edge cannot tell them apart). The async methods of an injected service are **awaited** in the compiled body (a promise must never leak into the response — the mail would never be sent); an app service (a compiled class) gets the runtime as its first argument (the compiled methods are `async function (rt, ...)`). A service the build does not compile still fails loud, and it names the class. The construct audit: **53 constructs** (33 compile, 17 fail loud, 3 build level). npm test **477/477**.
- **M45 - the honest reasons of the two refusals (2026-10-21):** `Queue::push()` and `Cache::tags()` already failed loud, but the **reason** each gave was blunt or misleading. The queue: the job would never run at the edge — the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job. The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row — the edge has no producer for it). The job class is not compiled either. The cache: the D1 `database` store has no tags — in Laravel the same store throws `BadMethodCallException("This cache store does not support tagging.")` when the route runs, so that route answers 500 there; the build refuses the route **earlier** — stricter than Laravel, not a parity. Both refusals hold in the **compiled classes** too, and the class path now carries the fail-loud code like the controller path (two new construct rows, two new class tests). The construct audit: **55 constructs** (33 compile, 19 fail loud, 3 build level). npm test **479/479**.
- **M46 - alasan yang jujur tanpa klaim kartu kredit + kode fail-loud di jalur class (2026-10-21):** alasan M45 untuk `Queue::push()` mengclaim produk berbayar - itu bukan keputusan proyek (cuma **R2** yang minta kartu kredit; CF Queues = 10k ops/day, free). Sekarang pesannya mengikuti **wording runtime-nya sendiri** (`rt.queue()` melempar pesan yang sama): job-nya tak pernah jalan di edge (worker tak punya queue handler; binding bawa body JSON, bukan job PHP) — jalur yang jalan: CF Queues binding + consumer yang lu tulis, atau tabel D1 yang dibaca cron trigger (row-nya ditulis port handler; edge tak punya produser). Klaim "kartu kredit" dan klaim "the edge can push the job" dicabut. `Cache::tags()`: di Laravel route ini 500 dengan `BadMethodCallException("This cache store does not support tagging.")`; build menolak route **sebelum dikirim** ⇒ lebih ketat dari Laravel, bukan parity. **Kode mati dicabut**: `QUEUE_ASYNC` + branch `Queue` yang tak terjangkau (`UNSUPPORTED_FACADES` menolak lebih dulu) dihapus ⇒ tak ada lagi jalur compile untuk `Queue::push()`. **Kode fail-loud ikut di jalur class**: the class compiler menyimpan `code`, jadi 2 baris audit class bisa memakai `code: "LW002"` seperti jalur controller. The construct audit: **55 constructs** (33 compile, 19 fail loud, 3 build level). npm test **479/479**.
- **M47 - the audit + the honesty fixes (2026-10-21):** a deep audit of the compiler, the runtime, the kernel, the build and the proof surface found three silent-wrong-answer bugs and three honesty gaps. **The dispatch** stopped at the first listener that answered — Laravel's `Dispatcher::dispatch()` runs *every* listener, only an answer of `false` stops the chain, and the dispatch answers the array of the responses; a second listener was silently skipped and the return value was wrong. **A circular service dependency** recursed forever (a stack overflow with no cause) — now a named `circular dependency detected [A -> B -> A]`. **The arithmetic** was JavaScript's: a non-numeric string in `+` answered 0 where PHP 8 throws a `TypeError`, a division by zero answered `Infinity` where PHP throws a `DivisionByZeroError`, and the modulo did not truncate (`7.5 % 2` = 1.5, PHP: 1). The **construct audit** now checks the *reason* a construct fails loud (19 rows record it), not only the verdict — a construct that fails loud for another reason is drift. **Every test file runs now**: `compiler/tests/rt-str.test.mjs` was not in the `npm test` list (the list is explicit), so it never ran. The **tiers** are three levels, not two: free plan (no card), Workers paid plan (a subscription: Dynamic Workers are paid-plan only, the full Queues bills per operation), and a payment method (R2 — the only product here that asks for a card). The sweep plan (M48+) is in `COMPILED.md` §8b. npm test **488/488**.
- **M48 - the JSON bytes are PHP's (2026-10-21):** the audit found the JSON answers were JavaScript's, not PHP's: `response()->json($x)` and `json_encode($x)` used a plain `JSON.stringify`, so the slashes were not escaped (`"a/b"` vs PHP's `"a\/b"`) and the non-ASCII was not escaped (`"héllo"` vs PHP's `"h\u00e9llo"`, the surrogate pairs too). Every JSON response with a URL or a non-ASCII character was a different body than Laravel's — the silent class. The kernel's PHP-faithful encoder (`kernel/php-json.mjs`) is used now (the response helper, `json_encode()` and the two error bodies: the 422 validation JSON + the 419 CSRF JSON). The shadow stays green (38/44 byte-identical, 0 unexplained). npm test **491/491**.
- **M49 - the registry grows: the facades + the listeners that must not run (2026-10-21):** the sweep is now an **enumerable** number, not an opinion: every facade of the vendored `Illuminate/Support/Facades` (Laravel 13, **47**) has a row in `tools/constructs.json` and the audit prints the coverage (47/47 = 100%; 5 compile, 42 fail loud with their own reason). The audit also **checks the reason** (19+ rows record it), so a construct that fails loud for another reason is drift. Two more classes of silent no-op are now refused at build time: a **broadcast listener** (`ShouldBroadcast`/`ShouldBroadcastNow` — Laravel broadcasts the event after the response; the edge has no broadcast driver, so the notification would never be sent) and an **after-commit listener** (`ShouldDispatchAfterCommit`/`ShouldHandleEventsAfterCommit` — Laravel defers it until the transaction commits; the edge has no transaction). `tools/event-dump.php` detects them (the real `class_implements`) and `compiler/src/classes.mjs` refuses them with that reason. `Event::dispatchUntil()` (the halt variant: it stops at the first non-null answer) fails loud with the halt semantics named. And an **unmapped facade** no longer blames a model: `DB::select()` used to fail with "is not a registered Eloquent model"; now the reason names the facade ("the DB facade is not compiled at the edge — write a port handler"). The **circular service dependency** is now caught at build time (the class compiler walks the dep graph) with Laravel's own wording ("Circular dependency detected [A, B, A]"); the runtime guard is the safety net. npm test **493/493**.
- **M51 - the audit's P0s: the silent-wrong constructs (2026-10-21):** the parallel audit (read-only, the real compiler against PHP 8.3.30) found six constructs that compiled to a DIFFERENT result than Laravel. **A foreach by reference** (`foreach ($a as &$v)`) compiled by-value, so PHP's write-back into the source array was lost ([9,9,9] vs [1,2,3]) — now it **fails loud** (LW002: PHP writes the changes back, a by-value loop would answer a different result). **The array spread** (`[...$a, ...$b]`) became a nested array ([[1,2],[3]] vs [1,2,3]) — now it compiles (`rt.spread()`: the values, the keys dropped, like PHP). **match() lost the int/float distinction**, so `match(1) { 1.0 => 'A', default => 'B' }` took the wrong arm (PHP: B) — a float literal now stays a float literal. **A constructor that needs an await** produced a JS SyntaxError, so the generated module did not parse and EVERY route 500s while the build said OK — the constructor is synchronous at the edge, so the build now **fails loud** (LW002). **A declared class property** (`public int $sent = 0;`) was dropped, so the instance answered null where PHP answers 0 (a counter that starts at the wrong value) — the declarations compile now. And **a `= null` default** was refused with a wrong reason (the parser emits `nullkeyword`, the class compiler looked for `null`) — a `?string $x = null` signature blocked the whole class; it compiles now. The constructor's injected services are awaited too (a floating promise meant the mail never left). npm test **499/499**.
- **M50 - the arithmetic's last PHP 8 gaps (2026-10-21):** probed against PHP 8.3 itself: array + array is the **union** (`[1] + [2]` => `[1]`, the left keys win - the compiled side answered 0), and the division/modulo by zero now throws the PHP class name (`DivisionByZeroError`) so it survives to the 500. An array + a scalar stays a TypeError with PHP's message. npm test **493/493**.
- **M52 - the elvis operator and ?? evaluate once (2026-10-21):** the audit found two operators that ran a side effect Laravel never runs: the elvis (`$a ?: $b`) emitted the test expression **twice** (`$i=1; $x = $i++ ?: 5` => PHP 2,1, the compiled side 3,2) - the test is evaluated once now (`rt.elvis`, and the else branch stays lazy), and `??` evaluated both sides eagerly (the right-hand side ran even when the left side was set) - the native JS `??` has PHP's short-circuit. npm test **499/499**.
- **M53 - the shadow proves the dispatch runs EVERY listener (2026-10-21):** the M47 fix (the dispatch is Laravel's: every listener runs, only an answer of `false` stops the chain) had no executable check - the shadow's event-demo step had one listener, and a listener that answers nothing never breaks the chain. The fixture app now has **two** listeners on the same event (the first writes the body and answers, the second writes the title), so the answer carries both and the shadow proves that every listener ran: 38/44 byte-identical, 0 unexplained.
- **M54 - the class path: the traits, the inheritance, the magic accessors (2026-10-21):** the audit found three more classes that compiled "OK" and were wrong at request time. A listener that **uses a trait** compiled without the trait's members (the dispatch then throws "has no handle() method" - a 500 where Laravel answers 200) - it fails loud now. A listener that **extends** a class lost the inherited methods - fails loud. A class with a **magic accessor** (`__get`, `__set`, `__call`, `__toString`, `__isset`) answered null where Laravel answers the computed value - fails loud. Every class-path refusal now carries a **code** (the controller path always did; the invariant says they must agree), and the reason for a constructor parameter without a default no longer claims that Laravel resolves it: a scalar cannot be autowired either (Laravel throws a BindingResolutionException: "Unresolvable dependency resolving [$x] in class ..."). npm test **502/502**.
- **M55 - a break inside a loop breaks the loop (2026-10-21):** the audit found the switch's break label leaking into a nested loop, so a break inside the loop broke the SWITCH (the code after the loop was skipped). PHP: `foreach ([1] as $x) { switch ($x) { case 1: foreach ([7,8] as $y) { if ($y==8) { break; } echo $y; } echo 'A'; break; } echo 'L'; }` => 7AL - the inner break leaves the inner foreach only. Every loop now carries its own label, so the break binds to the innermost loop or switch, like PHP. npm test **503/503**.
- **M56 - the continue in a switch + the increment (2026-10-21):** two more constructs whose compiled form differed from Laravel's. A **continue inside a switch** compiled to a bare JS `continue`, so it continued the LOOP (PHP 8 leaves the switch - it is a warning and behaves like a break): `foreach ([1,2] as $x) { switch ($x) { case 1: continue; default: echo 'D'; } echo 'K'; }` => PHP KDK, the compiled side DK. It is a break of the switch now. An **increment on a property** (`$post->views++`) compiled to `rt.prop(post, 'views')++` - not a valid JS assignment target, so the route 500s at request time while the build says OK; it fails loud now. And the **increment on a string** answered NaN where PHP bumps the last byte ("a" -> "b", "z" -> "aa", "19" -> 20) - the statement form uses PHP's increment now (and a decrement on a non-numeric string has no effect, like PHP 8). npm test **507/507**.
- **M57 - the mail construct (2026-10-21):** a mailable is a class, so the build compiles it: `tools/event-dump.php` dumps the app's `Mail` classes, `compiler/src/classes.mjs` emits the class and the new `kernel/mailable.mjs` carries Laravel's fluent surface (`subject()`, `view()`, `with()`, `from()`, `to()`, `cc()`) plus the payload (`__lwMail()` - the recipients, the subject, the rendered view). `Mail::to($u)->send(new OrderMail())` compiles and the mailer sends Laravel's payload (the mailable's data goes into the view - the unit tests lock the shape; the byte-for-byte proof against the real app's mail is the next stage). The methods the kernel mailer does not implement (`raw`, `html`, `queue`, `later`) fail loud - a mail that silently lost its `cc` would be a wrong answer. The kernel's pending had a real bug (the recipients were the setters, so the payload came out empty) - fixed. npm test **510/510**.
- **M58 - the mailable's correctness + the audit's last findings (2026-10-21):** the review of M57 found real defects, all fixed. The **chained** facade form (`Mail::to($u)->send($m)`) was **not awaited** - a floating promise (the mail could leave after the response, and a rejection was swallowed). Laravel's Mailable has a **field and a method with the same name** (`public $subject` + `subject()`) - JavaScript shadows one with the other, so the base keeps its values in private fields and reads the public field as the fallback. Laravel's **PendingMail::send() APPENDS** the pending's recipients to the mailable's own (deduped by address, the last wins) - the compiled side merged them the other way round. The **view data** is Laravel's `buildViewData()`: the mailable's PUBLIC properties merged with the `with()` data (the `with()` data alone was a silent wrong body). The mailable's `build()` is **protected** in Laravel - it is compiled now. The **payload** is built in ONE place (the pending, the facade's send and the raw/html share it) and shaped like Laravel's message. Every **class-path refusal carries a code** now (the queued/broadcast/after-commit/parse/not-in ones did not) and the build prints it. And the audit's **last three findings**: `in_array` over a PHP assoc array (it walked a JS array, so it was always false), the numeric-string compare **beyond 2^53** (JS rounds, so two different int64s answered "equal") and the **negative string offset** (`$s[-1]` - PHP returns the last character; the compiled side answered nothing) - all fixed and probed. npm test **514/514**.

## B. Current state

| Component | State |
|---|---|
| `edge/` pipeline (static/snapshot/ports/coverage/ship) | ✅ shipped on `nearfind-edge` |
| View-compile spike (S0 dump) | ✅ first artifact produced |
| Repo name | `laravel-workers` (decided; GitHub/npm checked) |
| Repo strategy | standalone; extract from `edge/` at M1–M2 |
| Compiled rung (kernel layers M11–M22) | ✅ session/csrf/ratelimit/auth/hash/encrypter/validator/cache/validation — PHP-8.3-oracle verified |
| Controller transpilation (M10/M17/M22/M23) | ✅ GET/POST/PUT/PATCH/DELETE, one handler per verb; FormRequests, `Cache`/`Hash` facades, class constants, Eloquent writes, `auth.basic`; anything outside the subset fails the build |
| Shadow harness (M24) | ✅ the real app (PHP 8.3 + sqlite) vs the compiled worker, byte-wise diff of status/headers/body; construct app 17/19 byte-identical (2 documented divergences), fresh app 9/10 (1), 0 unexplained |
| CI (M25) | ✅ `test` + `parity` (the PHP oracle parity runs for real against a fresh app) + `e2e` (fresh Laravel, zero config) |
| Test counts | npm test 359/359 · corpus 51/51 · docs-check 105/105 |
| W1–W10 (M1–M8) | ✅ **M1–M8 complete**: view parity (51/51) · router+DB (+model relations) · packaging+CI · hash+encrypter · validator · services · final gates (128/128 + 105/105 + bench p95<=5ms) |
| This map | v1.1 (this file) |

---

## C. Coverage index — every Laravel 13.x docs page × verdict

Source: `laravel/docs@13.x` file listing, 105 pages, checked 2026-10. Legend: ✅ fits · 🟡 soft (trade documented) · 🔴 hard → padanan required · ⛔ N/A at edge (local-only/meta) · ph2/ph3 = planned phase.
**Rule: no page may be removed from this table; new pages must be added before release (scripted re-check in W8).**

| Docs page | Class | Note |
|---|---|---|
| ai | ⛔ | dev tooling (Boost/AI guidelines) |
| ai-sdk | 🟡 ph3 | HTTP + streaming via fetch fits |
| artisan | ⛔ | local-only; edge CLI equivalents |
| authentication | 🟡 | kernel SessionGuard oracle-verified (M14); wired M15–M20 (auth.test 4/4, login-flow E2E) |
| authorization | 🟡 ph2 | the Gate facade compiles: `Gate::allows()`/`denies()` answer from the compiled policy (the guest rules included); `authorize()`/`any()`/`define()`/`before()` fail loud |
| billing | 🟡 ph3 | Cashier via fetch; webhooks = HMAC routes (padanan) |
| blade | 🟡 | views compile (echo/if/loops/expr); the **layouts** compile too (M40: the sections travel to the layout — `@extends`/`@section`/`@yield`); the Blade components (`<x-...>`) stay a port |
| boost | ⛔ | dev tooling only |
| broadcasting | 🔴 | SSE/polling padanan; WS via DO/external |
| cache | 🟡 | the `Cache` facade + the `cache()` helper compile to the D1 `database` store; the tags need a taggable store (LW002 — the D1 store has none, Laravel throws there too); a non-`database` driver fails the build (it would read and write a different store) |
| cashier-paddle | 🟡 ph3 | same as billing (padanan) |
| collections | 🟡 | kernel shim subset; fail loud per method |
| concurrency | 🟡 | Promise.all; 6-conn limit → batch |
| configuration | ✅ | frozen at build + secrets |
| console-tests | ⛔ | local; edge = parity harness |
| container | 🟡 | compile-time DI subset |
| context | 🟡 | request-scoped shim |
| contracts | ✅ | type-erased; two-sided custom drivers |
| contributions | ⛔ | meta |
| controllers | 🟡 | M10/M17/M22/M23/M28: GET/POST/PUT/PATCH/DELETE actions compiled (one handler per verb); \->validate() + flash (M19); edirect()->intended() + session regen/invalidate (M20); FormRequests, Cache/Hash/Storage facades, class constants and Eloquent writes compile (M23/M28); the **route-model binding** compiles (M40: `show(Post $post)` fetches the model from the segment); pagination + Eloquent relations still a port; fail-loud LW002 (unsupported construct) / LW003; REQUEST_CALL synced to kernel (#2: date removed, str added) |
| csrf | ✅ | session token; @csrf/@method |
| database | 🟡 | D1 builder: where/or/join/group/having |
| database-testing | 🟡 | sqlite↔D1 parity harness |
| deployment | ✅ | build → `wrangler deploy` (D1 + assets) |
| documentation | ⛔ | meta (TOC page) |
| dusk | ⛔ | local browser tests |
| eloquent | 🟡 | schema-driven ORM subset |
| eloquent-collections | 🟡 | collections shim |
| eloquent-factories | 🟡 | local dev tooling; no runtime code (unverified) |
| eloquent-mutators | 🟡 | compiled accessors/casts; build-time `fillable` dump; `hashed` cast |
| eloquent-relationships | 🟡 | lazy + eager subset |
| eloquent-resources | 🟡 | compiled toJSON subset |
| eloquent-serialization | 🟡 | toArray/toJson subset |
| encryption | 🟡 | AES-CBC+HMAC WebCrypto; serialize subset |
| envoy | ⛔ | local (SSH deploys) |
| errors | 🟡 | build-time compiled error views when present; status-only stubs otherwise; `new <PHP exception>` + `throw_if`/`throw_unless` compile (M34) |
| events | 🟡 | `Event::dispatch(new X(...))` compiles (M39c: the build compiles the event classes + their listeners — `dist/src/classes.generated.mjs` — and the dispatch calls them synchronously, like Laravel); a dispatch of an event *name* fails loud (no class, no listener); a **queued** listener fails loud (the edge has no queue consumer) → port; a listener that injects a **service** compiles (M44: the edge builds the app services the build compiled and adapts the framework services — `kernel/service-adapters.mjs`: the mailer, the logger — the worker hands the live one down); a service the build does not compile fails loud (the edge has no container and no file for it) |
| facades | 🟡 | kernel shims; the `Cache`/`Hash`/`Storage` facades compile (M23/M28/M30); the `Gate` facade compiles (M39a: the policy is compiled at build time); mail/queue/notification/password still unmapped → port |
| filesystem | 🟡 | wired (M28/M30): `Storage::` → R2 when bound, else the D1 blob store (`lw_blobs`); the **default disk** compiles (`Storage::disk('local')` is that same store — M39b), a named disk needs a bucket of its own (LW002: R2 asks for a credit card); `file_exists`/`public_path` stay build-only (no local FS); the **upload** compiles (M40 part 5): the multipart body is parsed at the edge, the file object + `store()`/`storeAs()` answer Laravel's values (the `file` rule and the size rules in kilobytes work), the content type of a file (finfo) fails loud. **Tiers**: free plan first (D1 blob store, 1,5 MB/objek, tanpa kartu) → R2 kalau app butuh (disk bernama / objek besar; R2 minta kartu kredit) → **paid plan hanya kalau free path memang tak cukup** (keputusan operator; tak ada construct yang diblokir *karena* free plan kecil — build hanya berhenti kalau edge tak bisa menjawab seperti PHP) |
| folio | ⛔ | NOT ported (0 code); Laravel Folio page routing unsupported |
| fortify | 🟡 ph2 | compile routes/actions, or manual auth (padanan) |
| frontend | ✅ | Vite unchanged; proven |
| hashing | 🟡 | PBKDF2 both-sides; bcrypt runs on free (bcryptjs, verdict safe); argon (N/A at edge); PHP 8.3 `password_get_info` parity + `hashed` cast |
| head | 🟡 ph2 | metadata pkg; view-time render |
| helpers | 🟡 | kernel shim subset incl. html-entities, php-json, php-serialize; `abort_if`/`abort_unless`/`now`/`today` compile (M33) |
| homestead | ⛔ | local VM |
| horizon | ⛔ | Redis dashboard; padanan CF dashboard |
| http-client | ✅ | fetch (already HTTP) |
| http-tests | ⛔ | local; parity harness covers |
| images | 🔴 | no GD/Imagick → CF Images or build-time |
| installation | ✅ | toolchain (§7) |
| license | ⛔ | meta |
| lifecycle | ✅ | §3 execution model |
| localization | 🟡 | frozen JSON; pluralization subset; **the compiled rung answers the dates in UTC** (the Workers' timezone) while Laravel uses `config('app.timezone')` — an app with a non-UTC timezone gets different dates at the edge (a documented divergence; the plan: M57) |
| logging | 🟡 | the `Log::` facade compiles (M33) → the platform log (the Workers console); no Log module (a local file sink) |
| mail | 🟡 | **wired** (M28): the worker builds the mailer from the app config (`mail.default` -> log/noop/resend) and hands it to the handler; the fluent `Mail::to()->send()` **compiles** (M57: the mailable is a class, the build compiles it and the kernel's `Mailable` base carries Laravel's fluent surface) → port; padanan = HTTP provider (SMTP impossible, hard) |
| mcp | 🟡 ph3 | HTTP/SSE servers compile; stdio (N/A at edge) (padanan) |
| middleware | 🟡 | compiled pipeline wired (throttle + guest/auth stages); aliases auth.session/precognitive/can* fail loud |
| migrations | ✅ | ops-time; remote via wrangler/SQL |
| mix | ⛔ | legacy; Vite is the path |
| mocking | ⛔ | local; harness mocks fetch |
| mongodb | ⛔ | D1 = SQLite only; explicit out-of-scope |
| notifications | 🟡 | no module; needs mail+queue+sse padanan (mail/db channels; broadcast → SSE) |
| octane | ⛔ | server runner irrelevant at edge |
| packages | ⛔ | meta (this repo becomes one) |
| pagination | ✅ | kernel paginator |
| passport | 🟡 ph3 | OAuth endpoints compile; JWT WebCrypto (padanan) |
| passwords | 🟡 | tokens + mail; signed URLs (signed URLs ok; token+mail wiring pending) |
| pennant | 🟡 | D1/KV store driver (padanan) |
| pint | ⛔ | local style tool |
| precognition | 🟡 ph2 | validation kernel + headers |
| processes | 🔴 | no process spawning → off-edge padanan |
| prompts | ⛔ | CLI-only |
| providers | 🟡 | compile-time registration subset |
| pulse | 🟡 ph3 | D1-backed; or CF analytics padanan |
| queries | 🟡 | builder: where/or/join/group/having/distinct |
| queues | 🟡 | **wired** (M28): the worker hands the queue adapter to the handler (a port can push); the `Queue::push(SomeJob::class)` facade fails loud — the job would never run at the edge: the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job (the runtime throws the same). The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row — the edge has no producer for it). The job class is not compiled either → port; CF Queues (a limited version on the Workers free plan; the paid plan charges per operation) / D1 queue padanan |
| rate-limiting | 🟡 | D1 counters (KV driver pending); throttle build-gated |
| readme | ⛔ | meta |
| redis | 🔴 | KV/D1 drivers; Upstash REST optional |
| releases | ⛔ | meta; pin 13.x policy |
| requests | 🟡 | kernel request subset |
| responses | 🟡 | kernel responses + SSE |
| reverb | 🔴 | WS server → DO/external/SSE padanan |
| routing | ✅ | compiled router |
| sail | ⛔ | local Docker |
| sanctum | 🟡 ph2 | tokens; SPA via sessions (padanan) |
| scheduling | 🟡 | **wired** (M29): the build dumps the app schedule into `dist/src/schedule.generated.mjs` + `dist/cron.json` (the Cloudflare trigger list); the worker's `scheduled` handler queues the due events for the app runtime (the edge triggers, it does not run artisan) |
| scout | 🟡 | engines via HTTP; D1 FTS fallback (padanan) |
| search | 🟡 | FTS5; vector → CF Vectorize padanan |
| seeding | 🟡 | local dev tooling; no runtime code (unverified) |
| session | 🟡 | D1 store; write budget soft; driver kv/encrypt pending |
| socialite | 🟡 ph3 | fetch-based OAuth (padanan) |
| starter-kits | 🟡 ph2 | kit = app code; covered with auth + blade (padanan) |
| strings | 🟡 | Str shim subset; fail loud |
| structure | ✅ | §7 source of truth |
| telescope | ⛔ | local debugger |
| testing | ✅ | local PHPUnit + edge parity harness |
| upgrade | ⛔ | meta; upgrade = recompile + parity |
| urls | ✅ | url/route/asset; signed URLs |
| valet | ⛔ | local env |
| validation | 🟡 | 60+ rules; `$request->validate()` → redirect-back / 422 JSON (M19); unique/exists via D1; `$attributes` display names + wildcard custom messages (T10); the messages are **Laravel 13's own** (`kernel/validation-messages.mjs` + the generated `kernel/validation-messages.data.mjs` — the app's published `lang/` file wins, the build dumps it); a **rule object** (`Rule::file()->max()`) and a FormRequest that overrides `prepareForValidation()` fail loud (the compiled rung evaluates the string rules only) |
| verification | 🟡 | signed URLs + mail (signed URLs ok; mail wiring pending) |
| views | 🟡 | compiled view handlers (echo/if/concat subset) |
| vite | ✅ | manifest shims; proven today |

**Tally: 105/105 pages have a verdict — 15 ✅ · 59 🟡 · 5 🔴 (each with padanan) · 26 ⛔ (local-only/meta). Zero blanks.** (reclassified 2026-10: 11 ✅→🟡 subset/overclaim + 1 ✅→⛔ not ported; stale notes synced)

*Keep this doc tight. Update the tables; don't grow prose.*
