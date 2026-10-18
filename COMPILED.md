# The compiled rung — full map and boundary (full mentok)

> Scope: **the compiled rung only** — everything that can run as compile-time-generated
> JavaScript on the fast path (measured 1–6 ms handler cost). **Sessions, auth, and CSRF are
> in scope here** (they compile onto cookie + D1 stores; nothing about them needs an adapter).
> Out of scope by decision: KV/R2/Queues/DO/Email **adapters** and the container/PHP-fidelity
> rung — later. Companions: `README.md` (what ships today), `MAP.md` (Laravel docs coverage).

## 0. Rules of the rung

- **Core stores** allowed here: **D1** (sqlite), **encrypted cookies** (AES-256-CBC+HMAC parity,
  M5), WebCrypto hashing. KV / R2 / Queues / DO / Email are *adapters* — code compiles now,
  bindings land later (flagged, never silent).
- **Oracle rule**: every construct ships with a byte-parity test vs real PHP 8.3 (corpus and/or
  shadow harness). No test → no claim → no README row.
- **Fail loud**: outside the compiled subset = build error with a "write a port" hint.
  Silent divergence is the only real failure.
- **PHP pin**: oracle = PHP 8.3.30. 8.4/8.5 behavior differences are declared, not guessed.
- **Per-request model**: fresh execution per request (same shape as php-fpm). An isolate may be
  reused, but compiled code must not *depend* on it.

### Free-plan budget (constraint — free plan first)

Everything in this document must run on **Workers Free**: 100k requests/day, **10 ms CPU per
invocation** (overshoot = error 1102), 128 MB memory, 50 subrequests/request. Paid ($5/mo) is an
*option*, never an assumption.

| Resource | Free limit | Compiled-rung response |
|---|---|---|
| CPU per request | 10 ms | handler measured 1–6 ms → normal pages fit; heavy compute gets a route-level **CPU budget check** (tooling 1.5) |
| password hashing | bcrypt cost 10 ≈ 50–100 ms CPU | does **not** fit Free. Policy: benchmark cost ≤6 in workerd first; else PBKDF2 custom-hasher pair (PHP + compiled, app opt-in); else Paid |
| D1 queries / invocation | 50 | eager-load flattening is the defense; `report` flags routes trending over budget |
| D1 rows written | 100k/day (hard-enforced since 2026-09-01) | cookie session driver = **zero** session writes; throttle only sensitive routes (Fortify-style), never blanket |
| D1 rows read | 5M/day (hard-enforced) | indexed lookups only; no full scans on hot paths |
| D1 storage | 5 GB/account, 500 MB/db | fine for small/medium apps |
| Durable Objects (SQLite) | free: 100k req + 100k row writes/day | locks / atomic counters can stay free-tier |
| Queues, Containers | **Paid only** | adapters + PHP rung are Paid-later tiers by definition; the compiled rung never depends on them |
| Requests | 100k/day (error 1027) | static assets don't count |

## 1. Enablers (land first — everything else rides on these)

### 1.1 Build-time manifests (boot the real app at build)
- `config` → frozen dump → `config.generated.mjs`
- **Container graph** → dumped-container (Symfony pattern): `getBindings()` + reflection of
  constructors → static instantiation plans + FQCN registry; `make($string)` → registry lookup
- Providers → `services.php` / `packages.php` (already produced by Composer)
- Events → listener map (sync listeners compiled via 1.2)
- Middleware groups + priority → ordered pipeline dump
- Translations → per-locale dumps; plurals via `Intl.PluralRules` (parity-checked)
- Schedule → cron manifest (delivery is adapter-later; manifest now)
- Morph map / casts inventory / pivot tables → extends `tools/model-dump.php`

### 1.2 Class compiler (controllers → general classes)
- Compile **any reachable class** from compiled roots (routes, listeners, jobs, middleware):
  services, actions, form requests, rules, mailables, notifications
- Support: `$this`, constructors (resolved via 1.1), typed/readonly props, static calls inside
  the compiled universe, traits/inheritance/interfaces/enums, union/nullable types, defaults,
  spread/variadics, closures, generators
- Output: one module per class + `classes.generated.mjs` registry (`new $x` / `make($x)`)
- Out-of-subset class body → per-class build error (never a wrong compile)

### 1.3 Shadow harness (the proof machine)
- Boot the **real app** (PHP 8.3 + sqlite) and the **compiled worker**; diff
  status/headers/body byte-wise over a request matrix (routes × fixtures)
- Runs in CI. New features must shrink the uncovered list, not just add green unit tests
- This makes "compiled 1:1" measurable instead of vibes

### 1.4 Runtime completeness (corpus-driven, continuous)
- Arrays (ordered maps) — done; references → cells; int64 → BigInt discipline + overflow fail-loud
- Loose-compare tables, string coercion, float→string formatting (corpus grows)
- `preg_*`: PCRE→JS translation layer; exotic constructs fail loud per pattern
- `mb_*`/`Intl`, `json_*`, HTML helpers, `url`/`parse_str`/`http_build_query`, `ctype`, `filter_var`
- `ob_*` output buffering, header/status semantics
- Generators / fibers-lite: JS iterators / async mapping with declared edges

### 1.5 Tooling
- `laravel-workers report`: reachability graph, compiled %, fail-loud list per class/route
- `laravel-workers ports:scaffold <route>`: emit a stub port from the extracted controller
- `laravel-workers shadow`: run the 1.3 harness locally

## 2. HTTP surface

| Area | Full target | Notes |
|---|---|---|
| Request | input/query/post/json/headers/cookies/files (multipart subset)/ip/fullUrl/is/route/validate | dot paths; `old()`/`user()`/`session()` hang off session/auth |
| Response | json/make/view/download(stream)/file; redirect→route/away/back/intended; `with/withErrors/withInput`; cookie queue; headers | `back()`/`intended()` need session |
| Middleware | groups (`web`/`api`), route params (`throttle:60,1`, `can:`), sorting, terminable | compiled pipeline |
| Route-model binding | implicit/explicit/scoped/nullable | |
| CSRF | token in session, `X-CSRF-TOKEN`/`X-XSRF-TOKEN`, except list, SameSite | full VerifyCsrfToken semantics |
| Signed URLs | `signedRoute`, `temporarySignedRoute`, `hasValidSignature` | HMAC kernel done |
| Cookies | EncryptCookies parity, queued cookies, cookie jar | M5 parity done |
| **Sessions** | cookie driver (stateless encrypted payload) + D1 driver; flash rotation (`_flash.new/old`), `old()` input, error bag (`$errors`), `regenerate`/`invalidate`/`migrate`, lifetime/expiry | **byte-parity goal for the cookie payload** (encrypter + serialize subset in place) |
| Rate limiting | `throttle` middleware full; `RateLimiter::for()` compiled | D1 store (core), atomic single-statement updates |
| **Auth** | session guard full API (attempt/login/logout/once/validate/user/id/check/guest), remember-me recaller cookie + rotation, Eloquent + database providers, auth events, `auth`/`guest`/`can`/`password.confirm` middleware, `Auth::viaRemember` | compiles on top of Sessions above |
| Auth flows (Fortify-shaped) | login/register/logout/forgot/reset/verify as **compiled controllers**: validate → attempt → regenerate → intended; reset tokens in D1; mail delivery flagged *adapter* (flow compiles now) | throttling via Rate limiter |
| Sanctum | personal access tokens (D1), abilities + middleware; SPA cookie mode last | |
| Localization | `__()`, `trans_choice`, `@lang`, locale switch mid-request | rides on 1.1 dumps |

## 3. Validation

- `Request::validate`, `Validator::make`, full `FormRequest` lifecycle: authorize, rules,
  messages, attributes, `prepareForValidation`, `passedValidation`, `after`/`withValidator`
  closures (compiled via 1.2)
- Rule-string matrix + implicit rules; Rule objects compiled via 1.2; nested + wildcards
  (kernel partial already)
- Failure flow parity: redirect back + errors bag + old input (needs 2. Sessions);
  API path: 422 JSON shape parity

## 4. Data

- Query builder: unions, subqueries, `whereExists`/`whereColumn`, `when`/`unless`, `chunkById`,
  `cursor`/`lazy`/`lazyById`, JSON path operators (D1 json1), `insertOrIgnore`, `upsert` variants,
  `updateOrInsert`, `increment`/`decrement`, raw expressions; non-sqlite SQL fails loud
- Eloquent: fillable/guarded, all casts (incl. custom cast classes via 1.2), mutators/accessors
  + `Attribute` class, `$appends/$hidden/$visible`, serialization with ISO-8601 date parity,
  collection semantics, global scopes, model events + observers, `sole`/`upsert`/`firstOrNew`/
  `firstOr(create)`/`updateOrCreate`, refresh/touch
- Relations (full matrix): hasMany/hasOne/belongsTo + **belongsToMany** (attach/detach/sync/
  toggle/updateExistingPivot/custom pivot/`withPivot`), hasManyThrough, morphTo/morphMany/
  morphToMany (morph map), withDefault, inverse; eager (`with('a.b')`, constrained closures,
  `withCount/Sum/Avg/Min/Max/Exists`), `whereHas` family, `load`/`loadMissing`, lazy loading
- Pagination: length-aware/simple/cursor; **compile Laravel's own pagination Blade views**
  from vendor → `links()` markup parity
- Migrations: run at build vs sqlite → schema snapshot + generated D1 migration SQL;
  zero runtime migrations
- Seeders/factories: build-time (real Faker PHP) → SQL dump; runtime `factory()` fails loud
- Transactions: `DB::transaction` → D1 batch atomicity; interactive begin/commit fails loud
  (declared); savepoints unsupported
- Raw SQL: sqlite dialect; `DB::statement` allowed; other dialects fail loud

## 5. Services on the compiled rung

- Events: sync dispatch (listeners via 1.2), subscribers, wildcard, model events;
  queued listeners flagged *adapter*
- Hash / Encrypter: done (M5); **bcrypt CPU policy** per the Free-plan budget (cost-tuned or
  PBKDF2-pair; argon2 → fail loud / port)
- Cache / Queue / Mail / Filesystem / Broadcast / Notifications / Scheduler: **call sites and
  class code compile** (jobs, mailables, notifications are classes) — stores/delivery are
  adapter-pending, flagged in `report`, never a silent no-op
- HTTP client (`Http::get`): fetch mapping, retries/timeouts; streaming declares limits

## 6. The full mentok — compiled-rung boundary (permanent)

1. `eval` / runtime `include` of new code — unknown at build cannot compile *(escape: container)*
2. Native ext / syscalls / proc / raw sockets / threads / pcntl — no OS in sandbox *(escape: container)*
3. PCRE exotic constructs (recursion, `\K`, possessive quantifiers…) — translate-or-fail per
   pattern *(escape: rewrite regex / port)*
4. String-eval'd names outside the compiled universe (`make($runtimeString)` for an unknown
   class) — registry covers the compiled universe; outside → fail loud *(escape: add class / port)*
5. Precise `__destruct` / `register_shutdown_function` ordering, true streaming `flush()` —
   approximated by design, declared *(escape: container)*
6. Fibers full suspend/resume — mapped to async/await partially, declared
7. PHP 8.4/8.5-specific behavior — pinned to 8.3 oracle
8. float→string / int64 residue beyond declared tolerance — corpus grows, residue declared
9. `extract()` / variable-variables at arbitrary depth — compiled where analyzable, else fail loud

Everything else in Laravel's web surface: **compilable** — this document is the checklist.

## 7. Order of attack (dependency-driven)

1. **Shadow harness (1.3)** — proof machine first
2. **Manifests (1.1) + class compiler (1.2)** — unlocks `$this` / services / container
3. **Sessions + CSRF + auth core (2)** — despite the pain; tamed via cookie + D1 stores
4. **Validation flow (3)** — rides on sessions
5. **Eloquent relations + pagination (4)** — kernel is already most of the way
6. **Runtime completeness (1.4)** — continuous, corpus-driven, never "done"
7. **Auth flows + Fortify-shaped controllers (2)** — just compiled controllers once 3/4/5 exist

## 8. Definition of done (per item)

- corpus and/or shadow test vs PHP 8.3 exists and is green
- fits the Free-plan budget (CPU / D1 queries / D1 writes) or is explicitly flagged Paid-tier in `report` and docs
- fail-loud hint exists for the construct's out-of-subset neighbors
- `report` reflects it; `MAP.md` row updated; e2e fixture (fresh-app / sim) exercises it
