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
invocation** as documented (overshoot = error 1102), 128 MB memory, 50 subrequests/request. Paid
($5/mo) is an *option*, never an assumption.

**Empirically measured** (2026-10-18, probe worker `lw-cpu-bench` deployed on a real Free account;
`cpuTime`/`outcome` read via `wrangler tail`): enforcement is *softer than the docs*. Each isolate
keeps a CPU **rollover bank** (Workers lead engineer, community thread: under-limit requests pay
in, over-limit requests draw down, error only when the bank is empty — and the bank boots padded).
Observed: wall time unlimited (3 s sleep = 2 ms CPU, ok); single requests up to ≈2 s CPU pass; a
single >2 s request is killed at exactly **cpu=2020 ms** (1102 `exceededCpu`); 40 back-to-back
bcrypt requests (≈4 s cumulative CPU over one connection) all passed. Design stance: normal pages
stay ≤10 ms (measured 1–6 ms), the bank is treated as *burst* headroom for rare heavy paths
(login/bcrypt), and a >10 ms CPU path is never put on a per-page hot path.

| Resource | Free limit | Compiled-rung response |
|---|---|---|
| CPU per request | 10 ms (docs) — measured: single request ok to ≈2 s, kill at cpu=2020 ms, wall unlimited | handler measured 1–6 ms → normal pages fit; heavy compute gets a route-level **CPU budget check** (tooling 1.5) |
| password hashing | bcrypt cost 10 ≈ 100 ms CPU (native PHP) | **measured in workerd**: bcryptjs cost6=22 / cost8=43 / cost10=93–104 / cost12=679 ms CPU → all pass on Free; `$2y$`⇄`$2b$` parity **verified both ways** vs PHP 8.3; WASM bcrypt blocked (`WebAssembly.compile` disallowed). Policy: keep bcrypt (bcryptjs) on the login-only path; native PBKDF2 (≤100k iters, measured 22 ms) = strict-10 ms fallback pair |
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
- Multi-verb URIs: a URI compiles its primary GET/POST handler *and* any extra verb
  (separate module, e.g. `login--post.mjs`) — a `GET /login` view snapshot plus a
  `POST /login` controller coexist; PUT/PATCH/DELETE compile the same way. OPTIONS is
  not compiled (the platform answers the CORS preflight) → the build fails loud
- Compiled controller subset: scalar params + `Request`/FormRequest injection, model
  chains (`find`/`findOrFail`/`all`/`where`/`whereIn`/`create`), Eloquent writes
  (`fill`/`save`/`delete`/`forceDelete`/`restore`, `$model->attr = …`), views,
  `session()`/`old()`/`csrf_token()`/`csrf_field()`/`request()`/`auth()`/`Auth::*`,
  `response()`/`response()->json()`, `Cache::*`/`Hash::*` facades, class constants
  (`RouteServiceProvider::HOME`), `ValidationException::withMessages()`.
  Everything else fails loud (never a wrong compile)
- FormRequest: `rules()`/`messages()`/`attributes()` are dumped at build time and
  compiled into the handler — the request is validated *before* the method body and
  `validated()` returns the ruled attributes. `authorize()` must be true and
  `prepareForValidation()` is not supported (build fails loud)
- Out-of-subset class body → per-class build error (never a wrong compile)

### 1.3 Shadow harness (the proof machine)
- Boot the **real app** (PHP 8.3 + sqlite) and the **compiled worker**; diff
  status/headers/body byte-wise over a request matrix (routes × fixtures)
- Runs in CI. New features must shrink the uncovered list, not just add green unit tests
- This makes "compiled 1:1" measurable instead of vibes
- First oracle-backed E2E: `kernel/tests/login-flow.test.mjs` drives the **Breeze login
  flow** (guest redirect → CSRF bootstrap → failed validation → `attempt` → session
  regenerate → `intended` → logout → 422 JSON) through the compiled kernel and diffs it
  against `tools/php-login-flow-oracle.php` (real PHP 8.3 + the fixture app): status,
  header set, `Set-Cookie` names/attrs, session rows and payload, JSON bodies, Symfony
  redirect HTML bytes — all 1:1.
- **The general harness** (`shadow/run.mjs` + `tools/php-shadow-oracle.php`): a scenario
  file lists the request steps; the oracle replays them through the real app (the app's
  own migrations, a dedicated sqlite file, a cookie jar, the CSRF token read back out of
  the session row) and the harness replays the same steps through the compiled worker
  from a *copy of the same database*. It diffs status, the header set and the body
  bytes, and reports four verdicts: **byte-identical**, **shape-verified** (a step may
  declare `shape: "<regex>"` for a body that is random by construction — a bcrypt
  digest; both sides must match the shape), **documented divergence** (a step may
  declare `expect: 'diverges'` with the reason — e.g. Laravel's default error page is
  a framework asset) and **unexplained** (a failure). `npm run test:shadow -- --app <app-root>`.
  Measured on the construct-coverage app: **20/22 byte-identical, 1 shape-verified, 1
  documented divergence, 0 unexplained** (22 steps over all 10 app routes, incl. the
  JSON error path); on the Breeze-shaped fresh app: **10/10 byte-identical, 0
  unexplained**.
- A step may use the cookie jar (`jar: true`) or not (a separate visitor). A
  *snapshot* is a static asset, so its fair comparison is a guest request. The scenario file is picked up by the app's directory name
  (`shadow/scenarios/<app>.mjs`) or passed with `--scenarios`.
- The harness found six real divergences, all fixed: the compiled `response()` had no
  `content-type` (Symfony's `text/html; charset=utf-8`); the compiled responses had no
  default `Cache-Control: no-cache, private`; the compiled model timestamps used the
  wall clock instead of the request clock (so a frozen-clock write carried a different
  `created_at` than the PHP side); the compiled `auth.basic` challenge was
  `Basic realm="Basic"` instead of Symfony's `Basic`; the compiled error body was
  plain text instead of Laravel's HTML error page; and the compiled side answered a
  request without credentials as if it were authenticated.
- The harness also caught three bugs in *itself* (a session leaking between steps, a
  cookie jar sent on every step, and a jar replaced by a step that did not use it) —
  the kind of bug that would have produced false confidence — and one more in the
  compiled side: the route middleware ran in the wrong order (Laravel sorts the
  route middleware by `$middlewarePriority`, where `throttle` runs *before* the
  auth/guest middleware, so the rate limiter still answers when a later
  middleware short-circuits).
- **CI:** the oracle parity needs a real Laravel app, so the `test` job (no app) *skips*
  those tests — the report says "skipped" with the reason, never "green by omission".
  The `parity` job creates a fresh Laravel app, points `LW_LARAVEL_APP` at it and runs
  the oracle parity for real (auth, cache, csrf, session, rate limiter); the two
  route-level parity tests (the 11-step web pipeline and the Breeze login flow) need the
  fixture app's routes and run against it locally.

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
| Request | input/query/post/json/headers/cookies/files (multipart subset)/ip/fullUrl/is/route/validate | dot paths; request cookies are parsed off `Cookie:` and decrypted before StartSession; the `InteractsWithData` accessors (`boolean`/`integer`/`float`/`string`/`filled`/`isNotFilled`/`missing`/`hasAny`/`only`/`except`) are implemented — `string()` models `Stringable` as a plain string (method chains are not transpiled yet); `old()`/`user()`/`session()` hang off session/auth |
| Response | json/make/view/download(stream)/file; redirect→route/away/back/intended; `with/withErrors/withInput`; cookie queue; headers | `back()` needs session; `intended()` compiled (M20) |
| Middleware | groups (`web`/`api`), route params (`throttle:60,1`, `can:`), sorting, terminable | compiled pipeline |
| Route-model binding | implicit/explicit/scoped/nullable | |
| CSRF | token in session, `X-CSRF-TOKEN`/`X-XSRF-TOKEN`, except list, SameSite | full VerifyCsrfToken semantics |
| Signed URLs | `signedRoute`, `temporarySignedRoute`, `hasValidSignature` | HMAC kernel done |
| Cookies | EncryptCookies parity, queued cookies, cookie jar | M5 parity done |
| **Sessions** | cookie driver (stateless encrypted payload) + D1 driver; flash rotation (`_flash.new/old`), `old()` input, error bag (`$errors`), `regenerate`/`invalidate`/`migrate`, lifetime/expiry | **byte-parity goal for the cookie payload** (encrypter + serialize subset in place); `regenerate`/`invalidate`/`regenerateToken` callable from compiled controllers (M20); **documented gap**: view-only GET routes are auto-snapshotted to a static asset the Worker serves *before* the kernel, so they run no session middleware (e.g. a plain `GET /login`) |
| Rate limiting | `throttle` middleware full; `RateLimiter::for()` compiled | D1 `database` store (M18); `increment` is read-then-write (D1 has no interactive transactions) — a race under concurrency, flagged not atomic |
| **Auth** | session guard full API (attempt/login/logout/once/validate/user/id/check/guest), remember-me recaller cookie + rotation, Eloquent + database providers, auth events, `auth`/`guest`/`can`/`password.confirm` middleware, `Auth::viaRemember` | compiles on top of Sessions above; the provider's generated model gets the `Authenticatable` trait applied at kernel boot (`resolveAuthConfig`) |
| Auth flows (Fortify-shaped) | login/register/logout/forgot/reset/verify as **compiled controllers**: validate → attempt → regenerate → intended; reset tokens in D1; mail delivery flagged *adapter* (flow compiles now) | throttling via Rate limiter; validate → attempt → regenerate → intended all compile (M19/M20) |
| Sanctum | personal access tokens (D1), abilities + middleware; SPA cookie mode last | |
| Localization | `__()`, `trans_choice`, `@lang`, locale switch mid-request | rides on 1.1 dumps |

## 3. Validation

- ✅ `Request::validate` / `validateWithBag` (M19): compiled to an awaited kernel-validator
  call (`rt.request().validate(...)`, D1 passed for `unique`/`exists`). Failure → 302 back
  (Referer → flashed previous URL → `/`) with flashed `errors` + `_old_input` (minus
  `Handler::$dontFlash`), or 422 JSON for `expectsJson`; json session serialization only
  (the `ViewErrorBag` `serialize()` path fails loud — the render failure rejects the
  promise, it is never downgraded to a 500 body).
- ✅ `ValidationException::withMessages([...])` (M21): a compiled controller throwing it
  becomes `rt.validationExceptionWithMessages(...)` and rides the same 302/422 path; the
  kernel's `ValidationException` is the same module instance, so `instanceof` holds.
- ✅ `$attributes` display names (T10): `getDisplayableAttribute` parity — exact concrete key,
  primary wildcard key, wildcard patterns (one dot-free segment per `*`, safe for punctuation
  like `-`/`:`), PHP-truthiness fallthrough (`''`/`'0'`/`null`), raw name for implicit
  wildcard fields, and the `Str::snake` + `_`→space fallback. Custom messages support
  `field.rule`, `rule`, `field`, and wildcard keys, replace `:attribute`/`:ATTRIBUTE`/
  `:Attribute`, and resolve size-rule array messages by attribute type
  (`numeric`/`array`/`string`) with wildcard arrays indexed by rule name; an empty custom
  message is kept (Laravel's `is_null` check). Attribute/message translations are unwired.
- `Validator::make` + custom messages are accepted by the runtime entrypoint; the
  display-name/`attributes` path is now wired (see above).
- `FormRequest` lifecycle (authorize, rules, messages, attributes, `prepareForValidation`,
  `passedValidation`, `after`/`withValidator` closures) — not compiled yet; write a port.
- Rule-string matrix + implicit rules; Rule objects compiled via 1.2; nested + wildcards
  (kernel partial already)
- Failure flow parity: redirect back + errors bag + old input ✅ (M19); API path: 422 JSON
  shape parity ✅ (M19)

## 4. Data

- Query builder: unions, subqueries, `whereExists`/`whereColumn`, `when`/`unless`, `chunkById`,
  `cursor`/`lazy`/`lazyById`, JSON path operators (D1 json1), `insertOrIgnore`, `upsert` variants,
  `updateOrInsert`, `increment`/`decrement`, raw expressions; non-sqlite SQL fails loud
- Eloquent: fillable/guarded, all casts (incl. custom cast classes via 1.2), mutators/accessors
  + `Attribute` class, `$appends/$hidden/$visible`, serialization with ISO-8601 date parity,
  collection semantics, global scopes, model events + observers, `sole`/`upsert`/`firstOrNew`/
  `firstOr(create)`/`updateOrCreate`, refresh/touch
  - `fillable` is dumped at build time (`tools/model-dump.php`) and enforced by `fill()`;
    models that declare no `$fillable` keep the historical allow-all fallback (divergence
    from Laravel's `$guarded = ['*']`). `guarded` semantics are not implemented.
  - `hashed` cast (T9): applied at set-time like `HasAttributes::setAttribute`, using
    PHP 8.3 `password_get_info` semantics — a full `$2y$NN$` digest with cost ≤ configured
    rounds passes through; `$2a$`/`$2b$`/truncated `$2y$` are treated as plaintext and
    re-hashed; argon2 or cost > rounds throws
    `RuntimeException("Could not verify the hashed value's configuration.")`; null stays
    null; mutators take priority. `makeSync` emits `$2y$` with rounds baked from
    `hashing.bcrypt.rounds` (default 12). Cost 12 costs ~679 ms CPU on Workers — it matches
    Laravel but exceeds the nominal Free 10 ms budget; keep it on login/reset paths only.
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
- Hash / Encrypter: done (M5); **bcrypt = bcryptjs** (pure JS; WASM blocked by the runtime's
  WASM-compile restriction) — measured cost6=22 / cost8=43 / cost10=93–104 / cost12=679 ms CPU;
  cost tuned per route; `$2y$`/`$2b$` parity verified both ways vs PHP 8.3; native PBKDF2 fallback
  pair (WebCrypto caps iterations at 100k; 600k rejected); argon2 → fail loud / port
- Cache: the `database` store compiles to D1 (`DatabaseCacheStore`, M18 — oracle-verified incl.
  the raw `cache` rows) and backs `throttle`; any other driver fails the build for `throttle`
  routes. Controllers get a narrow facade, `rt.cache()` → `get`/`put`/`forget`/`remember`/
  `has`/`pull` over the same D1 store; other `Cache::*` call sites still fail loud. Queue /
  Mail / Filesystem / Broadcast / Notifications / Scheduler: **call sites and class code
  compile** (jobs, mailables, notifications are classes) — stores/delivery are
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
10. Runtime `WebAssembly.compile()` — codegen disallowed by the embedder (static `.wasm` imports
    only); WASM-native crypto libs (hash-wasm etc.) are out — pure-JS equivalents stand in
    (bcryptjs measured above)

Everything else in Laravel's web surface: **compilable** — this document is the checklist.

## 7. Order of attack (dependency-driven)

1. **Shadow harness (1.3)** — proof machine first
2. **Manifests (1.1) + class compiler (1.2)** — unlocks `$this` / services / container
3. **Sessions + CSRF + auth core (2)** — despite the pain; tamed via cookie + D1 stores
   *(kernel layers shipped and PHP 8.3 oracle-verified — M11 `session.mjs`, M12 `ratelimit.mjs`,
   M13 `csrf.mjs`, M14 `auth.mjs`; **wiring shipped — M15 `kernel/http.mjs`**
   (`EncryptCookies → AddQueuedCookiesToResponse → StartSession → ShareErrorsFromSession →
   PreventRequestForgery → Throttle → route`, plus `auth` / `guest` / `throttle:n,m` route
   middleware), proven by an 11-step oracle scenario (`tools/php-http-pipeline-oracle.php`)
   that compares status, headers, Set-Cookie attributes, bodies and the raw session payload
   bytes per step. `throttle:n,m` now runs on the D1-backed `database` cache store (M18
   `DatabaseCacheStore`, mirrors `Illuminate\Cache\DatabaseStore` 13.37 and is oracle-verified
   incl. the raw `cache` rows); named `throttle:name` needs its `AppServiceProvider` definition
   and fails the build loud, as does `cache.driver !== 'database'`. Error views: every
   `resources/views/errors/{code}.blade.php` is compiled at build time and rendered through
   `renderErrorView` for `abort()`/HTTP errors when present; otherwise 419/429/500 bodies
   remain status-only stubs. Multi-verb routes still need a port — `--strict` fails the build
   when a route advertises an extra non-POST verb that was not compiled.
   `Auth::*` / `auth()` / `session()` / `old()` / `csrf_token()` / `csrf_field()` / `request()`
   and `Request $request` injection in compiled controllers shipped in M16; single-method `POST`
   actions joined the compiled set in M17 (handler registered under `METHOD uri`); and
   `redirect()->intended()` + session `regenerate()`/`invalidate()`/`regenerateToken()` in M20)*
4. **Validation flow (3)** — rides on sessions *(shipped M19: `$request->validate()` /
   `validateWithBag()` compile to an awaited kernel-validator call; failure renders the
   Handler::invalid redirect-back with flashed `errors` + `_old_input` (minus `dontFlash`)
   or the 422 JSON shape. json session serialization only. FormRequests + wildcard/prepare
   lifecycle still a port)*
5. **Eloquent relations + pagination (4)** — kernel is already most of the way
6. **Runtime completeness (1.4)** — continuous, corpus-driven, never "done"
7. **Auth flows + Fortify-shaped controllers (2)** — just compiled controllers once 3/4/5 exist

## 8. Definition of done (per item)

- corpus and/or shadow test vs PHP 8.3 exists and is green
- fits the Free-plan budget (CPU / D1 queries / D1 writes) or is explicitly flagged Paid-tier in `report` and docs
- fail-loud hint exists for the construct's out-of-subset neighbors
- `report` reflects it; `MAP.md` row updated; e2e fixture (fresh-app / sim) exercises it
