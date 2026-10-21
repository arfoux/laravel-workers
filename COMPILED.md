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
| Object storage | R2 free: 10 GB-month, 1M Class A, 10M Class B, free egress — but R2 asks for a payment method | the `Storage::` facade uses **R2 when the app binds it**, else the **D1 blob store** (one row per object in `lw_blobs`; 500 MB/db, 2 MB/row → 1.5 MB per object with headroom). A blob write = 1 D1 row write, a blob read = 1 row read (100k writes/day, 5M reads/day). The build names the store it picked and fails loud when the app binds neither R2 nor D1 |
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
  documented divergence, 0 unexplained** (22 steps over all 11 app routes, incl. the
  JSON error path and the object store — the compiled side writes to the D1 blob
  store, the real app to the local disk, and both read the object back); on the
  Breeze-shaped fresh app: **10/10 byte-identical, 0
  unexplained**.
- The oracle is hardened against a step that explodes (M34): nothing but its JSON
  may reach stdout (`display_errors=0` + an output buffer), it runs with
  `app.debug=false` (whoops prints the debug error page and exits, which would
  destroy the result), and a step whose error page fails still gets a response
  instead of losing the run. The harness mirrors the worker exactly: an
  uncaught error is not caught there either, so the platform answers the 500.
- A step may use the cookie jar (`jar: true`) or not (a separate visitor). A
  *snapshot* is a static asset, so its fair comparison is a guest request. The scenario file is picked up by the app's directory name
  (`shadow/scenarios/<app>.mjs`) or passed with `--scenarios`.
- A step may declare `expectBody` (a string the body must contain). It guards the
  *vacuous* match: if both sides are broken the same way (a route that does not
  exist answers 404 on both), the bodies agree and the step would pass without
  proving anything.
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

- The **packaging gate** (`tools/pack-smoke.mjs`, `npm run test:pack`): it packs the
  repo, installs the tarball into an empty project and runs the *installed*
  toolchain against a real Laravel app (the CLI build, the compiler import, the
  shadow harness). The published file set is proven, not assumed - a file missing
  from `package.json#files` or an undeclared dependency fails the gate. The CI
  e2e job installs the tarball (not the workspace) for the same reason.
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
- Filesystem: `Storage::` (`put`/`get`/`exists`/`delete`) compiles to the object store — the
  facade keeps Laravel's return values (`put` → `true`, `delete` → a bool that is `false`
  when the object was missing, `get` → the contents and a **throw** for a missing file, like
  `FilesystemAdapter::get`) — **R2**
  when the app binds it, else the **D1 blob store** (one row per object in `lw_blobs`, created
  lazily, 1.5 MB per object). The build prints the store it picked and fails loud when the app
  binds neither R2 nor D1 (no silent in-memory writes); `Storage::disk()` and the fluent
  facades still need a port (the disk/mailable/job classes are not compiled)
- The helper verbs (M33): `abort_if()`/`abort_unless()` compile to the runtime helpers
  (they answer null unless they abort), `now()`/`today()` follow the **request clock**
  (the oracle freezes Carbon; the wall clock would diverge) and the `Log::` facade
  compiles to the platform log (the Workers console - the padanan for the app log file)
- The `new` expression (M34): only the **PHP built-in exceptions** compile (`new
  RuntimeException('boom')` -> an error with the same class name and message; the
  handler answers the same 500 as Laravel). An app class (`new App\Exceptions\Mine`)
  is not compiled - it fails loud with LW002, it never becomes a silent stub. The
  same goes for `throw_if()`/`throw_unless()` (they throw the given error)
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
10. **The app's timezone** — the compiled rung answers the dates in **UTC** (the Workers' timezone): the model's
    `created_at`/`updated_at`, the date casts, the validator's `today`/`tomorrow` and the Carbon stub. Laravel uses
    `config('app.timezone')` — an app that sets a non-UTC timezone gets different dates at the edge (a documented
    divergence, planned in §8b / M70).

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

## 8b. The sweep plan — every Laravel 13 page to a verdict (M47+)

The sweep is **measured, not guessed**: Appendix C (MAP.md) holds one verdict for each of the
**105 pages** of the Laravel 13.x docs — 15 ✅ (it fits), 46 🟡 (it fits with a documented
trade), 26 ⛔ (N/A at the edge), 13 planned (🟡 ph2 / ph3) and 5 🔴 (a padanan is required). A
page without a verdict is a gap, and the docs gate fails on a gap (`tools/docs-check.mjs`).

The milestones below close the sweep. Each one is a commit of its own (code + test + docs) and
each one answers **apa** (the parity) → **kenapa** (the Laravel semantics, probed against the
real framework) → **bukti** (the numbers) → **yang tetap fail loud** (the constructs that must
stay refused, with the reason).

| # | Milestone | The pages | What lands | The proof | What stays fail loud | Effort | Risk |
|---|---|---|---|---|---|---|---|
| M47 | the audit + the honesty fixes | — (cross-cutting) | the dispatch is Laravel's, a circular service dependency is named, the arithmetic is PHP 8's, the construct audit checks the *reason* (not only the verdict), every test file actually runs | the unit tests + the construct audit (55 constructs) | — | done | — |
| ~~M48~~ → **M57–M60, done** | the mail construct (the payload is proven byte-for-byte) | mail, notifications | the mailable class compiles (its Blade view + the data), the kernel renders the payload, the mail leaves the edge | the shadow: the Laravel `MessageSent` payload vs the kernel outbox, byte for byte | `Mail::raw()`, `Mail::queue()`, the `cc`/`bcc` variants (not implemented) | large | high |
| M61 | the A36 audit's findings (the six surfaces the audit swept) | — (cross-cutting) | the validator's parameters (**M61a** done), the router's route resolution, the model's `save()`, the transpiler's promise leaks, the Blade runtime (`@json`/`@yield`/`@section`/`@foreach`) and the FormRequest dump's hook refusals | the unit tests + the probes against PHP 8.3 / Symfony (the route regexes, the CSV parameters) | the constructs that stay refused: the rule objects (until M62), the conditional/DB rules, the model's `fill()` without a `$fillable` (Laravel throws) | medium | medium |
| M62 | the validation: the rule objects + the FormRequest hooks | validation, requests | the `Rule::` objects are normalized at build time (Laravel's own `getRules()`), the three FormRequest hooks run (`prepareForValidation` → `withValidator` → `passedValidation`), the prepared input is merged into the request bag | the shadow: the 422 body byte for byte (the rule message included) | a rule that carries a closure (`Rule::unique()->where(fn …)`, `Rule::forEach`) — a closure cannot run at the edge | large | high |
| M63 | the queue | queues, scheduling | the job class compiles, the producer writes the row, the D1 + cron consumer path, the build checks `triggers.crons` (a queue with no cron = the job never runs) | the shadow: the pushed payload (Laravel `Queue::fake()` vs the D1 row) | the async *execution* (a documented divergence: the job runs later, not during the request) | large | high |
| M64 | the Eloquent relations + the accessors | eloquent-relationships, eloquent-mutators | the relations compile (the eager loading is the defense against the N+1), the accessors + the mutators | the shadow: the JSON body byte for byte | the lazy relations (a collection that grows in memory) | large | high |
| M65 | the Gate's global registrations | authorization (ph2) | `Gate::define()`, `before()`, `after()`, `any()`, `none()`, `authorize()` (the 403 shape) | the shadow: the allowed/denied answers + the 403 | the policy classes the app writes by hand (the compiled policy wins) | medium | medium |
| M66 | the API resources | eloquent-resources | `JsonResource` + `ResourceCollection` compile (the wrapping, `whenLoaded`, the pagination meta) | the shadow: the JSON body byte for byte | the `with()`/`additional` meta | medium | medium |
| M67 | the collections | collections | the Laravel Collections API (the higher-order messages, the `conditionable`/`tappable` traits) | the unit tests against the real `Collection` | the lazy collections (PHP memory does not exist at the edge) | medium | medium |
| M68 | the integrations (ph3) | passport, sanctum, socialite, cashier-paddle, billing, mcp, ai-sdk, pulse | each page gets its verdict + the port that answers it (or the explicit refusal) | the docs gate (a page without a verdict is a gap) | the parts that need a PHP process (the socialite callback) | medium | low |
| M69 | the hard pages (🔴) | broadcasting, images, processes, redis, reverb | each page gets its padanan (SSE/polling for the broadcasting, the D1 blob store for the images) or the explicit refusal | the docs gate + the construct audit | the parts that need a long-lived connection | medium | low |
| M70 | the app timezone | localization, helpers, eloquent | the app's `app.timezone` reaches the edge: the model's timestamps, the date casts, the validator's `today`/`tomorrow` and the Carbon stub answer in the app's timezone — **today the compiled rung answers in UTC** (a documented divergence, the code says so) | the shadow: a route that renders a date, against the real app's timezone | the `Carbon` methods the stub does not implement (`diffForHumans`, `isoFormat`, the `CarbonImmutable` API) | medium | medium |

**M61a (done, 2026-10-21)** - the kernel parses a rule's parameters with Laravel's own `str_getcsv`
(`ValidationRuleParser::parseParameters`): a **quoted** parameter (the shape `Rule::in(['admin','user'])` normalizes to -
`in:"admin","user"`) was compared with its quotes still on, so every valid value was rejected, and the dependent rules
trimmed the parameters where Laravel never trims. M62's rule objects depend on this.

**The rule of the sweep**: a page's trade (🟡) is only closed when the construct behind it
**compiles and is proven** — never by writing a nicer sentence. A construct that cannot be
answered like PHP at the edge **stays fail loud**, with the reason the operator needs (what
Laravel does, what the edge does instead, and what the working path is: a port handler, a
product, or a documented divergence).

## 9. The construct audit and the plan (generated)

Every construct an app can meet is listed in `tools/constructs.json` and probed against
the **real compiler** by `tools/construct-audit.mjs` (`npm run audit:constructs`). The
table below is generated: `check:docs` fails when it drifts from the code, so it cannot
rot. The invariant: a construct is either **compiled and proven** by the shadow harness,
or it **fails the build** - there is no third state (no silent degradation).

<!-- construct-audit:start -->

| Construct | The build | Note | Batch |
|---|---|---|---|
| `now()` | ✅ compiles | Carbon; the compiled side follows the **request clock** (M33) - the wall clock diverged. | M33 |
| `today()` | ✅ compiles | Carbon at midnight (UTC); the request clock again. | M33 |
| `abort_if()` | ✅ compiles | Answers null unless it aborts; the status + the message are Laravel's. | M33 |
| `abort_unless()` | ✅ compiles | The mirror of abort_if. | M33 |
| `Log::info()` | ✅ compiles | The platform log (the Workers console) is the padanan for the app log file. | M33 |
| `new RuntimeException()` | ✅ compiles | The **built-in** exceptions only; the class name + the message are kept, so the 500 matches. | M34 |
| `throw_if()` | ✅ compiles | Throws the given error when the condition says so. | M34 |
| `redirect()->with()` | ✅ compiles | Flashes into the session for the next request; the proof is the session payload + the Location. | M36 |
| `redirect()->withInput()` | ✅ compiles | Flashes `_old_input` (everything except the `dontFlash` fields). | M36 |
| `redirect()->withErrors()` | ✅ compiles | Flashes the error bag in the `ViewErrorBag` shape (the M19 validation flow writes the same shape). | M36 |
| `redirect()->away()` | ✅ compiles | An absolute external URL (the compiled redirect keeps it absolute). | M37 |
| `back()` | ✅ compiles | The Referer, or the session's `url.previous`, or `/`. | M37 |
| `Str::slug()` | ✅ compiles | The PHP-exact subset (slug/limit/upper/lower/studly/camel/snake/kebab/title/contains/startsWith/endsWith/after/before/length/replace*/squish/ucfirst/ucwords/ascii) - every value is verified against the real Laravel. | M38 |
| `env()` | ✅ compiles | The build-time config dump is the padanan (the edge has no .env); only the app.* keys are mapped. | M37 |
| `data_get()` | ✅ compiles | Dot/array access on an array or an object (the `*` wildcard is not ported). | M37 |
| `tap()` | ✅ compiles | Passes the value through a closure (the closure support exists). | M37 |
| `report()` | ✅ compiles | Reports an exception to the platform log (it does not answer it). | M37 |
| `cache()` (the helper) | ✅ compiles | The helper form of the `Cache` facade (the facade compiles). | M37 |
| `session([...])` (the array form) | ✅ compiles | The array form writes many keys: `session()->put([...])`. | M37 |
| `Event::dispatch()` (an event object) | ✅ compiles | The listener is a class, so the build compiles it (the event classes + the listeners, dist/src/classes.generated.mjs). The dispatch is synchronous, like Laravel's. | M39c |
| `Event::dispatch()` (an event name) | ⛔ fails loud (`LW002`) | An event *name* has no class: the edge cannot know which listener answers, so the dispatch would be a silent no-op - dispatch the event object instead. | M39c |
| `Gate::allows()` | ✅ compiles | The policy is compiled at build time: the abilities, the guest rules, the before() hook. | M39 |
| `Gate::allows()` (the class-level check) | ✅ compiles | Laravel shifts the class name away before the ability is called. | M39 |
| `Gate::authorize()` | ⛔ fails loud (`LW002`) | It throws an AuthorizationException (a 403) - the edge has no such error view yet. | M39 |
| `Gate::any()` | ⛔ fails loud (`LW002`) | Only `allows()` and `denies()` compile. | M39 |
| `Gate::define()` | ⛔ fails loud (`LW002`) | A closure is not compiled - the global Gate registrations stay a port. | M39 |
| `Gate::before()` | ⛔ fails loud (`LW002`) | The global Gate callbacks are not compiled (the policies are). | M39 |
| `Mail::to()->send()` | ✅ compiles | A mailable is a class: the build compiles it (the dump takes the app's Mail classes, the class compiler emits the class and the kernel's Mailable base carries Laravel's fluent surface) and the mailer sends the payload Laravel sends - the recipients, the subject and the rendered view (the mailable's data goes into the view). The byte-for-byte proof is the shadow: the PHP oracle captures Laravel's `MessageSent` event (the from/to/cc/bcc/replyTo/subject/html/text) and the harness compares those fields with the kernel mailer's outbox - all 8 fields are identical, the log line is not compared. The methods the kernel mailer does not implement (raw, html, queue, later) fail loud. | M60 |
| `Queue::push()` | ⛔ fails loud (`LW002`) | The job would never run at the edge: the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job. The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row - the edge has no producer for it). The job class is not compiled either: the class compiler compiles the events, the listeners and the injected services - a job is none of them. In Laravel the job is queued (or run inline by the sync driver) and the route answers 200. | M39 |
| `Storage::disk()` (the default disk) | ✅ compiles | The default disk is the compiled object store (the D1 blob store, or R2 when bound). | M39 |
| `Storage::disk()` (a named disk) | ⛔ fails loud (`LW002`) | A named disk needs a bucket of its own (R2 asks for a credit card); the compiled rung has one store. | M39 |
| `Cache::tags()` | ⛔ fails loud (`LW002`) | The compiled cache store is the D1 `database` store, which has no tags: in Laravel this route 500s with BadMethodCallException("This cache store does not support tagging."); the build refuses the route before it ships (stricter than Laravel, not a parity), and a taggable store (redis/memcached) is not compiled. | M39 |
| Blade `@extends` (a layout) | ✅ compiles | The sections travel to the layout (the shadow harness proves the bytes). | M40 |
| `Model::paginate()` | ✅ compiles | The LengthAwarePaginator (the items, the total, the pages, the URLs) + the pagination links (the framework's `pagination::tailwind` view is compiled at build time). | M40 |
| The translation helper (`__()`) | ✅ compiles | The strings are dumped at build time (the app's lang/ files + the framework's fallback); the place-holders are replaced like Laravel does. | M40 |
| A PHP cast (`(string) $x`) | ✅ compiles | The scalar casts with PHP's own semantics: (string), (int), (bool), (float). | M40 |
| Route-model binding (a typed param) | ✅ compiles | The model comes from the route segment (Laravel's implicit binding); a missing model is a 404. | M40 |
| Eloquent relations (`$post->comments()`) | ⛔ fails loud (`LW003`) | A relation is not compiled: the build stops (LW003). The compiled way to read a relation is the eager-loaded subset (`with()`). | M41 |
| File upload (`$request->file()`) | ✅ compiles | The multipart body is parsed at the edge: the file object carries the metadata (the name, the type the browser declared, the size) and the store (the app's default disk). Byte-proven by the shadow harness. | M40 |
| The upload is stored (`$file->storeAs()`) | ✅ compiles | The object store (the D1 blob store on the free plan, R2 with a bucket of its own): the path is the disk-relative one Laravel returns (trim($path.'/'.$name, '/')). | M40 |
| The upload is stored under a random name (`$file->store()`) | ✅ compiles | The name is a random hash (Str::random(40)) + the extension; the extension comes from the type the browser declared (Laravel sniffs the content with finfo). | M40 |
| The content type of the upload (`$file->getMimeType()`) | ⛔ fails loud (`LW003`) | The content type is read from the file's bytes (finfo): the edge cannot sniff the content like PHP does, so the build stops (LW003). | M40 |
| A `mimes` rule on an upload | ⛔ fails loud (`LW002`) | The `mimes` rule compares the extension the content sniffs (finfo): the edge has only the type the browser declared, so the build stops (LW002) instead of answering differently. | M40 |
| The files bag as a method (`$request->files()`) | ⛔ fails loud (`LW002`) | In Laravel `$request->files` is a property (Symfony's FileBag), not a method: the build stops (LW002) and points at `$request->file()` / `$request->allFiles()`. | M40 |
| An `OPTIONS` route | — documented (build level) | The compiled side answers Laravel's automatic OPTIONS response (200 + the Allow header - byte-proven); a CORS config makes the build skip the route. | M40 |
| A relation read as a property (`$post->comments`) | ⛔ fails loud (`LW003`) | A relation (or an accessor) read as a property is not compiled: the build stops (LW003). It used to answer null - a wrong answer, silently. | M42 |
| A rule object (`Rule::file()->max()`) | ⛔ fails loud (`LW002`) | A rule object is a class: the compiled validator evaluates the string rules only, so the rule would be silently ignored and the validation would differ. The build stops and names what it would take: the kernel validator must evaluate the rule object, the FormRequest must be compiled and its prepared input merged into the validated data. | M43 |
| A rule object in a FormRequest | — documented (build level) | The FormRequest dump reads the rules Laravel itself builds: a rule object is found there and the build stops ("the rules use a rule object (Illuminate\Validation\Rules\File) - the compiled rung evaluates the string rules only"). The dump's reason reaches the operator - it is not swallowed by a generic message anymore. | M43 |
| `prepareForValidation()` (overridden) | — documented (build level) | The FormRequest dump sees the overridden hook: "prepareForValidation() is overridden - the compiled rung does not run it (the validated input would differ)". The build stops and the reason reaches the operator. | M43 |
| A listener that injects a service | ⛔ fails loud (`LW002`) | A service the build does not compile: the edge has no container and no file for it, so the constructor dependency is a build error (the build names the class). A service the build DOES compile is injected (the edge builds it) and a framework service is adapted (the worker hands the live one down). | M43 |
| A queued listener (`ShouldQueue`) | ⛔ fails loud (`LW002`) | Laravel pushes a queued listener to the queue (it runs later); the edge has no queue consumer, so running it inline would be a different behaviour. The build stops and the route that dispatches the event names the reason. | M43 |
| A listener that injects an app service the build compiles | ✅ compiles | The edge builds the service itself: the build compiles it (the class + the services it injects) and the runtime hands it to the listener. The dependency is recorded in the compiled class, so the edge never guesses. | M44 |
| A listener that injects a framework service (the mailer) | ✅ compiles | The edge has no container: the worker hands the live service down (the mailer) and the compiled listener gets it. Its async methods are awaited in the compiled body (a promise must never leak into the response). | M44 |
| A listener that pushes to the queue | ⛔ fails loud (`LW002`) | The refusal holds in a compiled class too: the job would never run at the edge (the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job). | M45 |
| A listener that uses a tagged cache | ⛔ fails loud (`LW002`) | The D1 `database` store has no tags: in Laravel this route 500s with BadMethodCallException("This cache store does not support tagging."); the build refuses the route before it ships (stricter than Laravel, not a parity). | M45 |
| A broadcast listener (`ShouldBroadcast`) | ⛔ fails loud (`LW002`) | Laravel broadcasts the event to the channels after the response (the broadcast itself is queued). The edge has no broadcast driver, so the notification would never be sent - a silent no-op, so the build stops and the route that dispatches the event names the reason. | M49 |
| A listener dispatched after the commit (`ShouldDispatchAfterCommit`) | ⛔ fails loud (`LW002`) | Laravel defers the listener until the database transaction is committed. The edge has no transaction, so the timing would differ - the build stops and the route that dispatches the event names the reason. | M49 |
| `Event::dispatchUntil()` (the halt variant) | ⛔ fails loud (`LW002`) | Laravel's dispatchUntil() stops the chain at the first non-null answer and returns it. The compiled dispatch runs EVERY listener and answers the array of the responses, so the compiled rung cannot answer Laravel's value here - it fails loud with the halt semantics named. | M49 |
| The `App` facade | ⛔ fails loud (`LW002`) | The App facade is not compiled at the edge (Laravel 13 lists 142 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Artisan` facade | ⛔ fails loud (`LW002`) | The Artisan facade is not compiled at the edge (Laravel 13 lists 18 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Auth` facade | ✅ compiles | The Auth facade has a compiled surface (Laravel 13 lists 58 methods; the probe uses a method that compiles). | M49 |
| The `Blade` facade | ⛔ fails loud (`LW002`) | The Blade facade is not compiled at the edge (Laravel 13 lists 43 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Broadcast` facade | ⛔ fails loud (`LW002`) | The Broadcast facade is not compiled at the edge (Laravel 13 lists 30 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Bus` facade | ⛔ fails loud (`LW002`) | The Bus facade is not compiled at the edge (Laravel 13 lists 48 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Cache` facade | ✅ compiles | The Cache facade has a compiled surface (Laravel 13 lists 65 methods; the probe uses a method that compiles). | M49 |
| The `Cloud` facade | ⛔ fails loud (`LW002`) | The Cloud facade is not compiled at the edge (Laravel 13 lists 8 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Concurrency` facade | ⛔ fails loud (`LW002`) | The Concurrency facade is not compiled at the edge (Laravel 13 lists 14 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Config` facade | ⛔ fails loud (`LW002`) | The Config facade is not compiled at the edge (Laravel 13 lists 17 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Context` facade | ⛔ fails loud (`LW002`) | The Context facade is not compiled at the edge (Laravel 13 lists 43 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Cookie` facade | ⛔ fails loud (`LW002`) | The Cookie facade is not compiled at the edge (Laravel 13 lists 15 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Crypt` facade | ⛔ fails loud (`LW002`) | The Crypt facade is not compiled at the edge (Laravel 13 lists 11 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `DB` facade | ⛔ fails loud (`LW002`) | The DB facade is not compiled at the edge (Laravel 13 lists 113 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Date` facade | ⛔ fails loud (`LW002`) | The Date facade is not compiled at the edge (Laravel 13 lists 95 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Event` facade | ⛔ fails loud (`LW002`) | The Event facade is not compiled at the edge (Laravel 13 lists 33 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Exceptions` facade | ⛔ fails loud (`LW002`) | The Exceptions facade is not compiled at the edge (Laravel 13 lists 34 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Facade` facade | ⛔ fails loud (`LW002`) | The Facade facade is not compiled at the edge (Laravel 13 lists 0 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `File` facade | ⛔ fails loud (`LW002`) | The File facade is not compiled at the edge (Laravel 13 lists 53 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Gate` facade | ⛔ fails loud (`LW002`) | The Gate facade is not compiled at the edge (Laravel 13 lists 26 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Hash` facade | ✅ compiles | The Hash facade has a compiled surface (Laravel 13 lists 15 methods; the probe uses a method that compiles). | M49 |
| The `Http` facade | ⛔ fails loud (`LW002`) | The Http facade is not compiled at the edge (Laravel 13 lists 99 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Image` facade | ⛔ fails loud (`LW002`) | The Image facade is not compiled at the edge (Laravel 13 lists 15 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Lang` facade | ⛔ fails loud (`LW002`) | The Lang facade is not compiled at the edge (Laravel 13 lists 30 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Log` facade | ✅ compiles | The Log facade has a compiled surface (Laravel 13 lists 31 methods; the probe uses a method that compiles). | M49 |
| The `Mail` facade | ✅ compiles | The Mail facade is compiled: the kernel's mailer implements Laravel's PendingMail (to/cc/bcc/replyTo + send()), so the fluent form compiles. The shadow proves the payload against the real app (the `MessageSent` fields vs the kernel outbox - all 8 fields identical). The methods it does not implement (raw, html, queue, later) fail loud - a mail that silently lost its cc would be a wrong answer. | M60 |
| The `MaintenanceMode` facade | ⛔ fails loud (`LW002`) | The MaintenanceMode facade is not compiled at the edge (Laravel 13 lists 7 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Notification` facade | ⛔ fails loud (`LW002`) | The Notification facade is not compiled at the edge (Laravel 13 lists 34 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `ParallelTesting` facade | ⛔ fails loud (`LW002`) | The ParallelTesting facade is not compiled at the edge (Laravel 13 lists 16 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Password` facade | ⛔ fails loud (`LW002`) | The Password facade is not compiled at the edge (Laravel 13 lists 11 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Pipeline` facade | ⛔ fails loud (`LW002`) | The Pipeline facade is not compiled at the edge (Laravel 13 lists 15 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Process` facade | ⛔ fails loud (`LW002`) | The Process facade is not compiled at the edge (Laravel 13 lists 39 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Queue` facade | ⛔ fails loud (`LW002`) | The Queue facade is not compiled at the edge (Laravel 13 lists 85 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `RateLimiter` facade | ⛔ fails loud (`LW002`) | The RateLimiter facade is not compiled at the edge (Laravel 13 lists 18 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Redirect` facade | ⛔ fails loud (`LW002`) | The Redirect facade is not compiled at the edge (Laravel 13 lists 19 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Redis` facade | ⛔ fails loud (`LW002`) | The Redis facade is not compiled at the edge (Laravel 13 lists 302 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Request` facade | ⛔ fails loud (`LW002`) | The Request facade is not compiled at the edge (Laravel 13 lists 192 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Response` facade | ⛔ fails loud (`LW002`) | The Response facade is not compiled at the edge (Laravel 13 lists 21 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Route` facade | ⛔ fails loud (`LW002`) | The Route facade is not compiled at the edge (Laravel 13 lists 101 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Schedule` facade | ⛔ fails loud (`LW002`) | The Schedule facade is not compiled at the edge (Laravel 13 lists 84 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Schema` facade | ⛔ fails loud (`LW002`) | The Schema facade is not compiled at the edge (Laravel 13 lists 52 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Session` facade | ⛔ fails loud (`LW002`) | The Session facade is not compiled at the edge (Laravel 13 lists 70 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Storage` facade | ✅ compiles | The Storage facade has a compiled surface (Laravel 13 lists 84 methods; the probe uses a method that compiles). | M49 |
| The `URL` facade | ⛔ fails loud (`LW002`) | The URL facade is not compiled at the edge (Laravel 13 lists 46 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Validator` facade | ⛔ fails loud (`LW002`) | The Validator facade is not compiled at the edge (Laravel 13 lists 15 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `View` facade | ⛔ fails loud (`LW002`) | The View facade is not compiled at the edge (Laravel 13 lists 79 methods): the build refuses it with that reason - a port handler answers it. | M49 |
| The `Vite` facade | ⛔ fails loud (`LW002`) | The Vite facade is not compiled at the edge (Laravel 13 lists 32 methods): the build refuses it with that reason - a port handler answers it. | M49 |

**105 constructs: 40 compile, 62 fail loud, 3 documented at the build level.** Every one of them is either compiled *and* proven by the shadow harness, or it fails the build — there is no third state. The Laravel 13 facades: **47 of 47 classified (6 compile, 41 fail loud) — the facade coverage is 100%** (every facade of the vendored Illuminate/Support/Facades must have a row).

<!-- construct-audit:end -->

### The plan (batches, in order)

- **M36 - the flash (done).** `redirect()->with()`, `->withInput()`, `->withErrors()`. The
  padanan is the session: the flash lives there for the next request. The proof is the
  session payload + the `Location` header, byte-wise against the real app. Effort:
  small (the kernel already writes the error bag for the validation flow). Risk: low.
- **M37 - the helper surface (done).** `redirect()->away()`, `back()`, `Str::*`, `env()`,
  `data_get()`, `tap()`, `report()`, the `cache()` helper, `session([...])`. Each one
  needs its PHP-parity rule (the `Str` family is the big one: slug/limit/upper/lower/
  head/studly/...). Effort: medium. Risk: medium - the parity rules are exactly where
  the divergences hide.
- **M39 - the class-bearing calls (the Gate, the default disk and the listeners
  are done).**
  `Gate::allows()`/`denies()` compile (M39a: the policy is compiled at build time),
  `Storage::disk('<the default disk>')` compiles to the compiled object store
  (M39b) and the **event listeners** compile (M39c: the build compiles the class
  and the edge dispatches it). What is left needs the **class compiler** for the
  mailables and the jobs: `Mail::to()->send()` (the mailable compiles since M57) — plus the constructs that need a
  product, a store or a consumer the edge does not have: a **named disk** (its
  own bucket — R2 asks for a credit card), `Cache::tags()` (a taggable store) and
  `Queue::push(SomeJob::class)` (the job would never run at the edge: the
  worker has no queue handler, and the job class is not compiled either).
  They stay ports and the build
  keeps failing loud, deliberately, each with its own reason (LW002).
  Effort: large (a class compiler is a milestone of its own). Risk: high.
- **M40 - the build-level constructs (the layouts, the route-model binding, the
  method handling, the paginator and the translations are done).** The **Blade
  layouts** compile now (`@extends`/`@section`/`@yield`: the sections travel to
  the layout, the build compiles the view closure, and the shadow harness proves
  the bytes), the **route-model binding** compiles (`show(Post $post)` fetches
  the model from the segment; a missing model is a 404), the **method handling**
  is Laravel's (an `OPTIONS` request gets the automatic OPTIONS response — 200,
  an empty body, the `Allow` header; a method that does not match answers 405
  with an `errors/405` view, else 500), the **paginator** compiles
  (`Post::paginate(10)` → the LengthAwarePaginator) **with its pagination
  links** (the framework's `pagination::tailwind` view is compiled at build
  time — the same markup as Laravel) and the **translation helper** (`__()`)
  compiles (the strings are dumped at build time). What is left: the **file
  uploads** (the edge has no multipart parser yet — the build tells the
  operator to enable R2 or to remove the upload). Effort: large; the uploads
  need the multipart parsing at the edge.

## 8. Definition of done (per item)
- **M40 - the build-level constructs, part 1 (done).** Four of the five are
  closed, all proven by the shadow harness (the same bytes as the real
  Laravel):
  - **The Blade layouts** (`@extends` / `@section` / `@yield`): a layout used
    to compile to `$__env->…` — a view-level construct the compiler could not
    answer. Now the env carries the **sections** (the same
    `Illuminate\View\Concerns\ManagesLayouts` order: `startSection()` captures
    the output, `stopSection()` keeps it, `yieldContent()` hands it to the
    layout), the env is **shared** with the nested render (the layout is
    rendered with the env of the view that extends it) and the build compiles
    the **view closure** (the compiled PHP names the views it uses, so the
    layout is compiled and imported too). The `get_defined_vars()` /
    `array_diff_key()` pair (the data the layout receives) compiles to the
    runtime equivalents, and a view's output is `ltrim`ed like
    `PhpEngine::evaluatePath()` does.
  - **The route-model binding** (`show(Post $post)`): the parameter used to be
    an unsupported type (LW002 — the route needs a port). Now the model comes
    from the route segment (`findOrFail` — a missing model is a 404, like
    Laravel's `ModelNotFoundException`), the binding is checked the way
    Laravel binds it (**by name**: a route parameter that does not match the
    method's parameter fails the build, LW004) and a model that binds on
    another key (`getRouteKeyName()`) fails loud (LW003) instead of binding the
    wrong column.
  - **The method handling** (the `OPTIONS` route and the method that is not
    allowed): the compiled side used to answer the platform's 404 for both.
    Now it is Laravel's `AbstractRouteCollection`:
    - an **`OPTIONS`** request gets the **automatic OPTIONS response** — 200,
      an empty body and the `Allow` header with the verbs the URI accepts
      (`implode(',', …)`, in Laravel's verb order). The shadow harness proves
      the bytes.
    - any **other** method that does not match raises
      `MethodNotAllowedHttpException`: the app answers **405** when it has an
      `errors/405` view (the build dumps the flag) and the framework's error
      renderer answers **500** without one — the compiled side answers the
      same status (the error page itself is a Laravel framework asset).
    - the **CORS** config (`config/cors.php`) is *not* compiled: the build
      **skips** the routes under a CORS path (the `Access-Control-*` headers
      would be missing, and a browser's CORS would break) and says what to do.
  - **The paginator** (`Post::paginate(10)`): the query builder had no
    pagination and the construct failed loud (LW003). Now the compiled side
    answers Laravel's `LengthAwarePaginator` (`kernel/paginator.mjs`, a
    line-by-line port of `Illuminate\Pagination\LengthAwarePaginator` +
    `UrlWindow`): the items, the total, the pages, the first/last item, the
    previous/next URLs, the URL window (`elements()`) and the query string.
    Laravel's own rules are kept: the page comes from the request (`?page=N`,
    a valid integer >= 1), the path from the request's URL, the per page 15 by
    default. The shadow harness proves it: the same total, the same pages, the
    same items and the same URLs as the real Laravel (the first page and the
    second one).
    A **bug the shadow found**: `$arr[] = $x` (the PHP array append) compiled
    to `$arr[null] = $x` — a *silent* wrong answer (the array stayed empty).
    Now it compiles to `rt.arrayPush()` and an array read without an offset
    fails loud.
  - **The pagination links** (`$paginator->links()`): the links are the
    framework's `pagination::tailwind` view — a Blade file, so the build
    compiles it like any other view (the view name has a `::`, which is not a
    legal Windows file name → the compiled modules use a sanitized name, the
    views map keeps the real one). A view carries no type information, so the
    build tells the compiler what the view receives (the *data kinds*: the
    `paginator` and the `elements`) and the transpiler allows the paginator's
    methods there (a method outside the port's surface still fails loud).
    The **translations** (`__()`) are dumped at build time (the app's `lang/`
    files + the framework's fallback, the app's win) and the place-holders are
    replaced like Laravel does (also on the key, when the line is missing).
    The shadow proves it: the pagination markup is **byte-identical** to the
    real Laravel's.
  - **The PHP casts** (`(string) $x`, `(int) $x`, `(bool) $x`, `(float) $x`):
    they failed the build (LW002 — "unsupported expression kind cast"). Now
    they compile with PHP's own semantics (`rt.str` / `rt.intval` /
    `rt.truthy` / `rt.floatval`); the other casts (`(array)`, `(object)`) still
    fail loud.
  What is left in this batch: the **file uploads** (the edge has no multipart
  parser yet — the build tells the operator to enable R2 or to remove the
  upload).

- **M39b - the class-bearing calls, bounded (done).** The Gate (M39a) and the
  **default disk** now compile; the rest fail loud with their own reason, and
  the build *validates* the two places where the compiled side would read or
  write the **wrong store**:
  - `Storage::disk('<the app\'s default disk>')` compiles to the compiled
    object store (the D1 blob store, or R2 when the app binds it) — the same
    store as the flat `Storage::put()/get()/exists()/delete()`, with the same
    return values. The fluent form (`->put()`, `->get()`, `->exists()`,
    `->delete()`) compiles too; a method outside that surface fails loud (a
    promise must never leak into a response).
  - A **named** disk (`Storage::disk('public')`) fails loud (LW002): it would
    need a bucket of its own — R2 asks for a **credit card** (the free path is
    the D1 blob store: 1.5 MB per object, no card). A disk name that is not a
    literal fails loud too (the build cannot resolve it).
  - `Cache::tags()` fails loud: the compiled cache store is the D1 `database`
    store, which has no tags. In Laravel this route 500s with
    `BadMethodCallException("This cache store does not support tagging.")`; the
    build refuses the route before it ships — stricter than Laravel, not a
    parity. A taggable store (redis/memcached) is not compiled.
  - The build now **fails the build** when a compiled route uses the cache and
    the app's cache store is not `database`: the compiled store would read and
    write a different store — a silent divergence.
  - `Event::dispatch(new X(...))` **compiles** (M39c: the build compiles the
    listener class and the edge dispatches it, synchronously, like Laravel). The
    event **name** form (`Event::dispatch('post.created')`) fails loud: without
    a class the edge cannot know which listener answers.
  - `Mail::to()->send()` **compiles** (M57): a mailable is a class, so the build
    compiles it (the dump takes the app's `Mail` classes, the class compiler
    emits the class and the kernel's `Mailable` base carries Laravel's fluent
    surface — `subject()`, `view()`, `with()`, `from()`, `to()`, `cc()`) and the
    mailer sends the payload Laravel sends: the recipients, the subject and
    the rendered view (the mailable's data goes into the view). The methods the
    kernel mailer does not implement (`raw`, `html`, `queue`, `later`) fail
    loud — a mail that silently lost its `cc` would be a wrong answer.
  - `Queue::push(SomeJob::class)` fails loud for a different reason: the job
    would never run at the edge — the worker has no queue handler, so nothing
    consumes the queue binding, and the binding carries a JSON body, not a PHP
    job (the runtime throws the same). The paths that work: a Cloudflare
    Queues binding with a consumer you write, or a D1 table the cron
    trigger reads (a port handler writes the row — the edge has no producer for
    it). The job class is not compiled either.
  - The **file upload** (`$request->file()`) fails loud with the instructions:
    the edge has no multipart parser, so the upload needs an object store
    (R2 — credit card; the free path is the D1 blob store) or the upload has to
    be removed/disabled in that route. The build prints the `wrangler.jsonc`
    snippet next to the skipped route.
  Effort: medium. Risk: low — the compiled store is the one the build already
  proves; the rest is a message (and a validation) that keeps a divergence from
  reaching the edge.

- **M39a - the Gate (done).** `Gate::allows()` / `Gate::denies()` compiled into
  `unknown class/static Illuminate\Support\Facades\Gate::allows` - the policy
  is a class, so the check never compiled and the route needed a port. Now the
  **policy is compiled at build time**: `tools/policy-dump.php` boots the real
  app, asks the Gate which policy answers for a model (the guessed, the
  registered or the subclass one) and dumps the abilities, their parameters and
  Laravel's own guest rules (`parameterAllowsGuests()`); `compiler/src/policy.mjs`
  compiles the ability methods and the `before()` hook into async functions
  (`dist/src/policies.generated.mjs`) and the runtime answers the check with
  Laravel's order: the policy `before()` first (a non-null answer wins), then
  the ability, and a guest the policy does not allow is **denied without the
  method being called**. A missing ability is Laravel's `false`, not an error.
  The global Gate registrations are not compiled and fail loud with their own
  reason: `Gate::before()`/`Gate::after()` (LW002), a `Gate::define()` ability
  (LW002), a policy with a `__call()` (LW002 - the build cannot know what it
  would answer), a policy that did not compile (LW003), a `Gate::authorize()`
  (LW002 - it throws a 403) and `Gate::any()`/`Gate::none()` (LW002). The proof
  is the shadow harness: the same policy answers the same bytes as the real
  Laravel, for a signed-in user and for a guest. Effort: medium. Risk: medium -
  the guest rules and the `before()` order are where the divergences hide, so
  both are mirrored from the framework, not guessed.

- **M41 - the method-call gate (done).** A method call on a model, on a query
  builder or on an unknown variable compiled and answered a 500 at the edge
  (a relation, an upload). The build stops instead: LW003 for a model or a
  query, LW002 for an unknown variable and for a view. The allowed model
  methods are the ones the compiled model really has (kernel/model.mjs), so
  `fill()`, `get()` and `toJSON()` keep working. Effort: small. Risk: low -
  the gate is a list, not a guess.

- **M42 - the relation as a property (done).** A relation (or an accessor) read
  as a property (`$post->comments`) compiled and answered `null` - a wrong
  answer, silently (worse than a 500: the route answers 200 with an empty
  relation). The model dump now lists the methods the app declares on the
  model (the relations, the accessors) and the compiler rejects a property
  read on a model variable (LW003). The runtime model shim guards the same
  names, because a Blade view carries no type information - there the
  request fails loud instead of rendering an empty relation. Effort: small.
  Risk: low - the list comes from the app itself (the reflection), not a
  guess.

- corpus and/or shadow test vs PHP 8.3 exists and is green
- fits the Free-plan budget (CPU / D1 queries / D1 writes) or is explicitly flagged Paid-tier in `report` and docs
- fail-loud hint exists for the construct's out-of-subset neighbors
- `report` reflects it; `MAP.md` row updated; e2e fixture (fresh-app / sim) exercises it
