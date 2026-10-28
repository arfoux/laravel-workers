# Readiness Guide — Can Your Laravel App Run on Cloudflare Workers?

This guide maps every Laravel 13.x documentation page to a clear verdict:

| Verdict | Meaning |
|---|---|
| **RUNS ON THE EDGE** | The feature works as-is on Cloudflare Workers. No changes needed. |
| **RUNS WITH DECLARED GAPS** | Works with some adaptations (config changes, trade-offs documented). |
| **NEEDS PADANAN (PORT)** | Requires a port handler — custom code that calls external services or uses non-compiled patterns. |
| **NOT APPLICABLE AT EDGE** | Local-only tooling, dev utilities, or meta pages — not part of the deployed app. |

## Full Coverage Table (105 pages)

| Docs Page | Verdict | What It Means for Your App |
|---|---|---|
| ai | NOT APPLICABLE AT EDGE | dev tooling (Boost/AI guidelines) |
| ai-sdk | RUNS WITH DECLARED GAPS | HTTP + streaming via fetch fits |
| artisan | NOT APPLICABLE AT EDGE | local-only; edge CLI equivalents |
| authentication | RUNS WITH DECLARED GAPS | kernel SessionGuard oracle-verified (M14); wired M15–M20 (auth.test 4/4, login-flow E2E) |
| authorization | RUNS WITH DECLARED GAPS | the Gate facade compiles: `Gate::allows()`/`denies()` answer from the compiled policy (the guest rules included); `authorize()`/`any()`/`define()`/`before()` fail loud |
| billing | RUNS WITH DECLARED GAPS | Cashier via fetch; webhooks = HMAC routes (padanan) |
| blade | RUNS WITH DECLARED GAPS | views compile (echo/if/loops/expr); the **layouts** compile too (M40: the sections travel to the layout — `@extends`/`@section`/`@yield`); the Blade components (`<x-...>`) stay a port |
| boost | NOT APPLICABLE AT EDGE | dev tooling only |
| broadcasting | NEEDS PADANAN (PORT) | SSE/polling padanan; WS via DO/external |
| cache | RUNS WITH DECLARED GAPS | the `Cache` facade + the `cache()` helper compile to the D1 `database` store; the tags need a taggable store (LW002 — the D1 store has none, Laravel throws there too); a non-`database` driver fails the build (it would read and write a different store) |
| cashier-paddle | RUNS WITH DECLARED GAPS | same as billing (padanan) |
| collections | RUNS WITH DECLARED GAPS | kernel shim subset; fail loud per method |
| concurrency | RUNS WITH DECLARED GAPS | Promise.all; 6-conn limit → batch |
| configuration | RUNS ON THE EDGE | frozen at build + secrets |
| console-tests | NOT APPLICABLE AT EDGE | local; edge = parity harness |
| container | RUNS WITH DECLARED GAPS | compile-time DI subset |
| context | RUNS WITH DECLARED GAPS | request-scoped shim |
| contracts | RUNS ON THE EDGE | type-erased; two-sided custom drivers |
| contributions | NOT APPLICABLE AT EDGE | meta |
| controllers | RUNS WITH DECLARED GAPS | M10/M17/M22/M23/M28: GET/POST/PUT/PATCH/DELETE actions compiled (one handler per verb); \->validate() + flash (M19); edirect()->intended() + session regen/invalidate (M20); FormRequests, Cache/Hash/Storage facades, class constants and Eloquent writes compile (M23/M28); the **route-model binding** compiles (M40: `show(Post $post)` fetches the model from the segment); pagination + Eloquent relations still a port; fail-loud LW002 (unsupported construct) / LW003; REQUEST_CALL synced to kernel (#2: date removed, str added) |
| csrf | RUNS ON THE EDGE | session token; @csrf/@method |
| database | RUNS WITH DECLARED GAPS | D1 builder: where/or/join/group/having |
| database-testing | RUNS WITH DECLARED GAPS | sqlite↔D1 parity harness |
| deployment | RUNS ON THE EDGE | manual `wrangler deploy` is the established path; guided `npx laravel-workers deploy` (preview with `--plan`, then build + D1 + schema + assets) passed a live mode 2/3 smoke on a stock Laravel 13 app with Wrangler 4.151.1 (HTTP 200); an account guard compares the account id `wrangler whoami` resolves (config pin → env → sole account) with the one recorded in `lw-state.json` and refuses a mismatch or an ambiguous multi-account login before any D1/deploy call (fake-binary tests + a read-only live `whoami`) |
| documentation | NOT APPLICABLE AT EDGE | meta (TOC page) |
| dusk | NOT APPLICABLE AT EDGE | local browser tests |
| eloquent | RUNS WITH DECLARED GAPS | schema-driven ORM subset |
| eloquent-collections | RUNS WITH DECLARED GAPS | collections shim |
| eloquent-factories | RUNS WITH DECLARED GAPS | local dev tooling; no runtime code (unverified) |
| eloquent-mutators | RUNS WITH DECLARED GAPS | compiled accessors/casts; build-time `fillable` dump; `hashed` cast |
| eloquent-relationships | RUNS WITH DECLARED GAPS | lazy + eager subset |
| eloquent-resources | RUNS WITH DECLARED GAPS | compiled toJSON subset |
| eloquent-serialization | RUNS WITH DECLARED GAPS | toArray/toJson subset |
| encryption | RUNS WITH DECLARED GAPS | AES-CBC+HMAC WebCrypto; serialize subset |
| envoy | NOT APPLICABLE AT EDGE | local (SSH deploys) |
| errors | RUNS WITH DECLARED GAPS | build-time compiled error views when present; status-only stubs otherwise; `new <PHP exception>` + `throw_if`/`throw_unless` compile (M34) |
| events | RUNS WITH DECLARED GAPS | `Event::dispatch(new X(...))` compiles (M39c: the build compiles the event classes + their listeners — `dist/src/classes.generated.mjs` — and the dispatch calls them synchronously, like Laravel); a dispatch of an event *name* fails loud (no class, no listener); a **queued** listener fails loud (the edge has no queue consumer) → port; a listener that injects a **service** compiles (M44: the edge builds the app services the build compiled and adapts the framework services — `kernel/service-adapters.mjs`: the mailer, the logger — the worker hands the live one down); a service the build does not compile fails loud (the edge has no container and no file for it) |
| facades | RUNS WITH DECLARED GAPS | kernel shims; the `Cache`/`Hash`/`Storage` facades compile (M23/M28/M30); the `Gate` facade compiles (M39a: the policy is compiled at build time); mail/queue/notification/password still unmapped → port |
| filesystem | RUNS WITH DECLARED GAPS | wired (M28/M30): `Storage::` → R2 when bound, else the D1 blob store (`lw_blobs`); the **default disk** compiles (`Storage::disk('local')` is that same store — M39b), a named disk needs a bucket of its own (LW002: R2 asks for a credit card); `file_exists`/`public_path` stay build-only (no local FS); the **upload** compiles (M40 part 5): the multipart body is parsed at the edge, the file object + `store()`/`storeAs()` answer Laravel's values (the `file` rule and the size rules in kilobytes work), the content type of a file (finfo) fails loud. **Tiers**: free plan first (D1 blob store, 1,5 MB/objek, tanpa kartu) → R2 kalau app butuh (disk bernama / objek besar; R2 minta kartu kredit) → **paid plan hanya kalau free path memang tak cukup** (keputusan operator; tak ada construct yang diblokir *karena* free plan kecil — build hanya berhenti kalau edge tak bisa menjawab seperti PHP) |
| folio | NOT APPLICABLE AT EDGE | NOT ported (0 code); Laravel Folio page routing unsupported |
| fortify | RUNS WITH DECLARED GAPS | compile routes/actions, or manual auth (padanan) |
| frontend | RUNS ON THE EDGE | Vite unchanged; proven |
| hashing | RUNS WITH DECLARED GAPS | PBKDF2 both-sides; bcrypt runs on free (bcryptjs, verdict safe); argon (N/A at edge); PHP 8.3 `password_get_info` parity + `hashed` cast |
| head | RUNS WITH DECLARED GAPS | metadata pkg; view-time render |
| helpers | RUNS WITH DECLARED GAPS | kernel shim subset incl. html-entities, php-json, php-serialize; `abort_if`/`abort_unless`/`now`/`today` compile (M33) |
| homestead | NOT APPLICABLE AT EDGE | local VM |
| horizon | NOT APPLICABLE AT EDGE | Redis dashboard; padanan CF dashboard |
| http-client | RUNS ON THE EDGE | fetch (already HTTP) |
| http-tests | NOT APPLICABLE AT EDGE | local; parity harness covers |
| images | NEEDS PADANAN (PORT) | no GD/Imagick → CF Images or build-time |
| installation | RUNS ON THE EDGE | toolchain (§7) |
| license | NOT APPLICABLE AT EDGE | meta |
| lifecycle | RUNS ON THE EDGE | §3 execution model |
| localization | RUNS WITH DECLARED GAPS | frozen JSON; pluralization subset; **the compiled rung answers the dates in UTC** (the Workers' timezone) while Laravel uses `config('app.timezone')` — an app with a non-UTC timezone gets different dates at the edge (a documented divergence; the plan: M57) |
| logging | RUNS WITH DECLARED GAPS | the `Log::` facade compiles (M33) → the platform log (the Workers console); no Log module (a local file sink) |
| mail | RUNS WITH DECLARED GAPS | **wired** (M28): the worker builds the mailer from the app config (`mail.default` -> log/noop/resend) and hands it to the handler; the fluent `Mail::to()->send()` **compiles** (M57: the mailable is a class, the build compiles it and the kernel's `Mailable` base carries Laravel's fluent surface) → port; padanan = HTTP provider (SMTP impossible, hard) |
| mcp | RUNS WITH DECLARED GAPS | HTTP/SSE servers compile; stdio (N/A at edge) (padanan) |
| middleware | RUNS WITH DECLARED GAPS | compiled pipeline wired (throttle + guest/auth stages); aliases auth.session/precognitive/can* fail loud |
| migrations | RUNS ON THE EDGE | ops-time; remote via wrangler/SQL |
| mix | NOT APPLICABLE AT EDGE | legacy; Vite is the path |
| mocking | NOT APPLICABLE AT EDGE | local; harness mocks fetch |
| mongodb | NOT APPLICABLE AT EDGE | D1 = SQLite only; explicit out-of-scope |
| notifications | RUNS WITH DECLARED GAPS | no module; needs mail+queue+sse padanan (mail/db channels; broadcast → SSE) |
| octane | NOT APPLICABLE AT EDGE | server runner irrelevant at edge |
| packages | NOT APPLICABLE AT EDGE | meta (this repo becomes one) |
| pagination | RUNS ON THE EDGE | kernel paginator |
| passport | RUNS WITH DECLARED GAPS | OAuth endpoints compile; JWT WebCrypto (padanan) |
| passwords | RUNS WITH DECLARED GAPS | tokens + mail; signed URLs (signed URLs ok; token+mail wiring pending) |
| pennant | RUNS WITH DECLARED GAPS | D1/KV store driver (padanan) |
| pint | NOT APPLICABLE AT EDGE | local style tool |
| precognition | RUNS WITH DECLARED GAPS | validation kernel + headers |
| processes | NEEDS PADANAN (PORT) | no process spawning → off-edge padanan |
| prompts | NOT APPLICABLE AT EDGE | CLI-only |
| providers | RUNS WITH DECLARED GAPS | compile-time registration subset |
| pulse | RUNS WITH DECLARED GAPS | D1-backed; or CF analytics padanan |
| queries | RUNS WITH DECLARED GAPS | builder: where/or/join/group/having/distinct |
| queues | RUNS WITH DECLARED GAPS | **wired** (M28): the worker hands the queue adapter to the handler (a port can push); the `Queue::push(SomeJob::class)` facade fails loud — the job would never run at the edge: the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job (the runtime throws the same). The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row — the edge has no producer for it). The job class is not compiled either → port; CF Queues (a limited version on the Workers free plan; the paid plan charges per operation) / D1 queue padanan |
| rate-limiting | RUNS WITH DECLARED GAPS | D1 counters (KV driver pending); throttle build-gated |
| readme | NOT APPLICABLE AT EDGE | meta |
| redis | NEEDS PADANAN (PORT) | KV/D1 drivers; Upstash REST optional |
| releases | NOT APPLICABLE AT EDGE | meta; pin 13.x policy |
| requests | RUNS WITH DECLARED GAPS | kernel request subset |
| responses | RUNS WITH DECLARED GAPS | kernel responses + SSE |
| reverb | NEEDS PADANAN (PORT) | WS server → DO/external/SSE padanan |
| routing | RUNS ON THE EDGE | compiled router |
| sail | NOT APPLICABLE AT EDGE | local Docker |
| sanctum | RUNS WITH DECLARED GAPS | tokens; SPA via sessions (padanan) |
| scheduling | RUNS WITH DECLARED GAPS | **wired** (M29): the build dumps the app schedule into `dist/src/schedule.generated.mjs` + `dist/cron.json` (the Cloudflare trigger list); the worker's `scheduled` handler queues the due events for the app runtime (the edge triggers, it does not run artisan) |
| scout | RUNS WITH DECLARED GAPS | engines via HTTP; D1 FTS fallback (padanan) |
| search | RUNS WITH DECLARED GAPS | FTS5; vector → CF Vectorize padanan |
| seeding | RUNS WITH DECLARED GAPS | local dev tooling; no runtime code (unverified) |
| session | RUNS WITH DECLARED GAPS | D1 store; write budget soft; driver kv/encrypt pending |
| socialite | RUNS WITH DECLARED GAPS | fetch-based OAuth (padanan) |
| starter-kits | RUNS WITH DECLARED GAPS | kit = app code; covered with auth + blade (padanan) |
| strings | RUNS WITH DECLARED GAPS | Str shim subset; fail loud |
| structure | RUNS ON THE EDGE | §7 source of truth |
| telescope | NOT APPLICABLE AT EDGE | local debugger |
| testing | RUNS ON THE EDGE | local PHPUnit + edge parity harness |
| upgrade | NOT APPLICABLE AT EDGE | meta; upgrade = recompile + parity |
| urls | RUNS ON THE EDGE | url/route/asset; signed URLs |
| valet | NOT APPLICABLE AT EDGE | local env |
| validation | RUNS WITH DECLARED GAPS | 60+ rules; `$request->validate()` → redirect-back / 422 JSON (M19); unique/exists via D1; `$attributes` display names + wildcard custom messages (T10); a **FormRequest** compiles its `rules()`/`messages()`/`attributes()` and its `prepareForValidation()` hook (the compiled class extends the kernel's `kernel/form-request.mjs`, the request surface the hook uses); the messages are **Laravel 13's own** (`kernel/validation-messages.mjs` + the generated `kernel/validation-messages.data.mjs` — the app's published `lang/` file wins, the build dumps it); a **rule object** (`Rule::file()->max()`) and a FormRequest that overrides `prepareForValidation()` fail loud (the compiled rung evaluates the string rules only); the rule parameters are parsed like Laravel (CSV - `in:"a","b"` works, nothing is trimmed) (M61a) |
| verification | RUNS WITH DECLARED GAPS | signed URLs + mail (signed URLs ok; mail wiring pending) |
| views | RUNS WITH DECLARED GAPS | compiled view handlers (echo/if/concat subset) |
| vite | RUNS ON THE EDGE | manifest shims; proven today |

## How to Use This Guide

1. **Check your app's features against the table above.** If every feature you use falls under RUNS ON THE EDGE or RUNS WITH DECLARED GAPS, your app is likely ready.
2. **For NEEDS PADANAN items**, you'll need to write port handlers (JavaScript functions) that call external APIs or handle non-compiled constructs.
3. **For NOT APPLICABLE items**, ignore them — they're dev tools or documentation pages that don't affect deployment.
4. **Run `npx laravel-workers build --strict`** to get a verdict for your own app. The build names every route that needs a decision, and every construct in `app/` the edge cannot carry.

## Build Output Verdicts

After running the build, you'll see one of three verdicts:

- **RUNS ON THE EDGE**: All routes are handled. Your app is ready to deploy.
- **RUNS WITH DECLARED GAPS**: Some routes are ignored or use ports. The build succeeded but those routes won't work until you implement the ports or remove the routes.
- **DOES NOT RUN**: The build failed. The output lists exactly what needs to change, with specific fix instructions for each issue.

*The table is derived from `MAP.md` §C, which `tools/docs-check.mjs` holds at exactly 105 rows: a page cannot be dropped without a replacement. This file is the reader-facing view of that table.*