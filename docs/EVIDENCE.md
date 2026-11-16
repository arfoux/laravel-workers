# Evidence — what was actually exercised

Not a roadmap and not a promise list: this page records **what was run, against what, on
which day, with which output** — and what could not be run. A claim is `VERIFIED` only when
the command, its output and the artifact are all here. `PARTIAL` names the part that is
missing. `NOT VERIFIED` is not a swear word; a guess presented as a run is.

Audit date: **2026-11-14**. Machine: Windows 10.0.26100 · Node `22.18.0` · PHP `8.3.30` (ZTS
x64, the parity oracle version) · wrangler `4.157.0`.

## The app this was measured on

`lw-showcase`, a real Laravel 13 app (138 routes, 85 GET), working tree at `e330b2e` **with
uncommitted edits** — so the source that produced the deployed bundle is **not** recorded
anywhere (finding 4). Deployment proof, not memory:

```
$ npx wrangler deployments list
Created: 2026-11-13T01:31:51.201Z  Author: <the maintainer>  Version: 1fa734bc-3738-4456-afb8-6af2732d4506
Created: 2026-11-13T01:30:03.896Z  …                            e6d56fa4-46b5-43b8-88bd-0e0aa99e5798
Created: 2026-11-13T01:23:10.759Z  …                            e96a5f30-191d-42bd-bcbc-8b48a89b2220
```

```
$ curl -sS -D - https://lw-showcase.nietzsc.de/
HTTP/1.1 200 OK · server: cloudflare · content-type: text/html; charset=utf-8
Set-Cookie: XSRF-TOKEN=…; path=/; samesite=lax
Set-Cookie: laravel-session=…; path=/; httponly; samesite=lax
sha256  fdacbf9989db999b65180332ed2f2cc9d9e018a010eed25968a960ed5245e272   2861 B
```

## Build and deploy, by the toolchain (not by hand)

```
$ node bin/laravel-workers.mjs build            # in lw-showcase, current main
build_exit=0
• controllers transpiled: 85/86
• blade2php: 33 view(s) compiled byte-identical to Laravel (13)
• coverage: all 131 route(s) handled — static 2, snapshots 0, ports 56, controllers 73, extra-verb controllers 12, ignored 0
• _routes.json: 131 include patterns exceed Cloudflare's 100-rule combined cap -> merged sibling prefixes down to 99
• READINESS: RUNS ON THE EDGE
```

```
$ node bin/laravel-workers.mjs deploy --plan --mode 3 --d1-auto      # zero-mutation
  worker   lw-showcase · d1 lw-showcase-db — create-or-reuse · target "lw-showcase-db" entry found
  schema   not checked (current dist/schema.sql; --plan does not rebuild)
  cloud    d1 list; d1 create if missing; wrangler deploy
Plan OK — no changes made.
```

`deploy --mode 3` itself was **not** run by this audit (it would redeploy production; the
live bundle predates this session and was shipped by `wrangler deploy`, see finding 3).

## Run against the live worker

### Auth + session + CSRF + D1, over HTTP

```
$ curl -c j -b j https://lw-showcase.nietzsc.de/login                          → 200, _token (40 chars)
$ curl -c j -b j -X POST -d _token=… -d email=demo@example.test -d password=secret /login
HTTP/1.1 302 Found · Location: https://lw-showcase.nietzsc.de/crud · Set-Cookie: laravel-session=…
$ curl -b j /dashboard      → 200 (1823 B) · page carries "Dashboard" ×2 and demo@example.test
$ curl -b j /auth/me        → {"id":1,"email":"demo@example.test","check":true,"guest":false}
$ curl -b j -X POST /logout → 302 · Location: https://lw-showcase.nietzsc.de
$ curl -b j /dashboard      → 302 (guest again)
$ curl -b j -X POST -d email=… -d password=… /login   (no _token) → 419
```

One round trip therefore exercises: the encrypted session cookie (`laravel-session` carries
a MAC), CSRF (token accepted, absent token → 419), `BcryptHasher` over a `$2y$04$` hash,
`EloquentUserProvider` over **D1**, session rotation, `auth`/`guest` middleware and
`redirect()->intended()`.

### A write

`POST /crud` (authenticated, token from `GET /crud/create`) inserted `posts` id 10 in D1
(`select id,title,user_id … → 10, "audit write 2026-11-14", 1`) and answered `302`. The row
and the two rows the sweep triggered on `GET /data/writes` were deleted afterwards; the
`posts` count is back to its pre-audit value of 5.

### Parity sweep — 92 URIs, live worker vs local PHP

Both sides were swept with the same script: every GET URI in `route:list --json` plus five
parameterised probes, redirects left unfollowed.

| | live worker | PHP oracle |
|---|---|---|
| 200 | 57 | 66 |
| 302 | 10 | 8 |
| 307 | 2 | 0 |
| 400 | 2 | 0 |
| 401 | 2 | 1 |
| 403 | 2 | 2 |
| 404 | 11 | 9 |
| 405 | 1 | 1 |
| 422 | 2 | 0 |
| 500 | 3 | 5 |

Raw byte equality is the wrong first metric here: `url()`/`asset()` embed the origin, so
every absolute link differs by construction (`https://lw-showcase.nietzsc.de` vs
`http://127.0.0.1:8300`), and CSRF tokens differ per session. After normalising **the origin
and the token value only**:

| verdict | count | what it means |
|---|---|---|
| template-identical | **45** | same HTML modulo origin + CSRF token |
| content-diff | 30 | data (D1 has 5 posts; the local sqlite is empty), `APP_DEBUG` stack page, or a port with no PHP counterpart answering where PHP's closure answers `''` |
| status-diff | 17 | listed in the findings below; most are ports deliberately answering where the PHP closure cannot |

The `405` claim in `README.md` ("405 with the app's error view") holds: `GET /webhooks/stripe`
is 405 on both sides and byte-identical after normalisation.

## Findings

**1 — P1: `route()`/`redirect()->route()` with an associative params array emits
`[object Object]`.** `compiler/runtime/rt-from-context.mjs:1155` builds the URL with
positional slots (`args[i++]`), while the transpiler emits `rt.route("crud.show", {"post": id})`
— one object in `args[0]`. Repro, on the **live** worker and on a fresh `main` build under
`wrangler dev`:

```
$ curl -b j -X POST -d _token=… -d title=… /crud
HTTP/1.1 302 Found
Location: https://lw-showcase.nietzsc.de/crud/%5Bobject%20Object%5D     # PHP: /crud/{new id}
```

The id itself is correct — the flash says `Created post 46` and the log line says
`crud.store {"id":46}` — so `rt.prop()` is fine and only URL generation is wrong.
`COMPILED.md:860` lists `Redirect::route -> rt.redirect(rt.route(...))` as ✅ compiles, and no
test covers named params (`grep -rn "route('.*', *\[" tools/tests kernel/tests` → nothing).
Impact: the idiom is Laravel's normal one, so a compiled app cannot redirect to a created
resource.

**Fixed.** `genUrl` reads a map by name now: the same call answered
`http://localhost/crud/%5Bobject%20Object%5D` before the change (the exact string the live
worker's `Location` header carried) and answers `http://localhost/crud/46` after it.

The rule table — one PHP 8.3 probe per line: map by name, list positional, leftover keys →
query in map order, `{x?}` absent drops its segment, missing required → the framework's own
exception, `rawurlencode` with `%2F` restored, `absolute: false` → a relative URL — is the
comment above `genUrl` in `compiler/runtime/rt-from-context.mjs`, and
`compiler/tests/rt-url.test.mjs` pins every line of it. One PHP shape is deliberately **not**
mirrored: a list with more values than the route has parameters
(`route('crud.show', [1, 2])` answers `/crud/1?2` on PHP; the extras drop here) — the compiler
never emits it and the mechanism behind `?2` was not pinned down, so it is a documented gap
rather than a guess.

**2 — P2: a path that is not in `_routes.json` never reaches the worker, so the 404 has no
body.** `GET /nonexistent-route-for-404` on the live worker → `404`, **0 B**. The app's own
404 (`GET /errors/404`) → `404`, 218 B, and PHP answers 218 B for the same unknown path. The
131 include patterns are merged down to Cloudflare's 100-rule cap
(`dist/public/_routes.json`, 99 include, 1 exclude), so anything outside them is answered by
the assets layer.

**Fixed.** The 404 body is a build artifact now: `build.mjs` writes `dist/public/404.html` from
`tools/prerender.php --error 404` — Laravel's own exception path, so no route of the app can
capture the request the page is rendered for, and the body comes from the CLI output buffer when
the response carries none (the rule `tools/php-shadow-oracle.php` had already measured for its
own 405/500) — with the same URL relativization every snapshot gets. The scaffolded
`wrangler.jsonc` carries `assets.not_found_handling: "404-page"`, the Cloudflare switch that serves
the nearest `404.html` with a 404 status, and an app whose config predates it gets a DECLARED
finding naming the exact line to add. Measured after the change: a local `wrangler dev` and the
live worker both answer `GET /nonexistent-route-for-404` with `404`, 218 B, `text/html`,
byte-identical to `dist/public/404.html` — and that file is byte-identical to what PHP renders for
the same unknown path. The e2e job asserts the artifact, the scaffolded switch, and the served
bytes (`cmp` against `dist/public/404.html` under `wrangler dev`). Declared rather than fixed: the
page renders with a synthetic `GET /` request, so a 404 view that prints the request path bakes
that path, and the ASSETS layer has no `Accept` to branch on, so a JSON client receives the HTML
page where PHP answers JSON.

**3 — P3: `status` is blind to a deploy the tool did not perform.** `node bin/laravel-workers.mjs
status` in `lw-showcase` prints `no deploy recorded for this app yet` while the app is live,
because `lw-state.json` only exists after the tool's own `deploy`. Reasonable, but the output
reads as "not deployed". Consider naming the case (`wrangler.jsonc` exists, no state: "deployed
outside the toolchain?").

**4 — P4: no build/deploy provenance.** Neither `dist/` nor `lw-state.json` carries the app
source SHA or the toolchain version, and `wrangler deployments list` shows `Source: Unknown
(deployment)`. So "which commit is live" is unanswerable — the working tree here is dirty on
top of `e330b2e`.

**Fixed.** Three surfaces answer it now, and each says so when it does not know. The **build**
writes `dist/build-info.json` — `{ toolVersion, builtAt, source: { sha, dirty } }` — from
`tools/git-sha.mjs`, which answers `null` outside a git work tree instead of inventing a commit
(measured on this app: `e330b2e`, `dirty: true`, which is exactly this tree). **`deploy`** records
the same identity in `lw-state.json` (`sourceSha`, `sourceDirty`, `toolVersion`) plus the
`versionId` wrangler prints, and tags the Worker Version with the short SHA — measured on the live
app: `Tag: e330b2e6cfd0`, `Message: e330b2e (+uncommitted changes) · laravel-workers 0.5.0`. The
`Source:` line still reads `Unknown (version_upload)`: that column describes HOW the version was
uploaded, not what it contains, so the **tag** is what carries the answer. **`status`** tells the
three cases apart — nothing recorded, no record but a `wrangler.jsonc`/`dist/` (the case this
finding found mislabelled), and a recorded deploy with `commit :` and `version :` lines. On the
live app it printed "this toolchain recorded no deploy for this app … dist/ was built from
e330b2e (+uncommitted changes) … deployed outside laravel-workers … not known from here: the live
worker, its URL, and its D1" where it used to say "no deploy recorded for this app yet".

`/health` deliberately still reports `builtAt` only: the app's commit is not a public fact, so it
is recorded in the artifact and in the deploy state rather than announced by a public endpoint.

**5 — P5: prerendered static routes answer 307 before 200.** `GET /architecture` and
`GET /quotas` (the two `static` routes) return `307 Location: /architecture/`, then 200 from
the asset layer; PHP answers 200 directly. Harmless for a browser, visible to `curl` users,
crawlers and any client that does not follow redirects.

**Fixed.** A prerendered page is written under **both** names it is reachable as —
`architecture.html` and `architecture/index.html` — because the ASSETS layer answers `/about`
from the flat file and `/about/` from the folder one, and one file can only serve one of them
without a redirect; PHP trims the trailing slash, so it answers 200 for both (measured: the
shadow oracle, `200/200` on `/architecture` and on `/architecture/`). The rule lives once, in
`tools/snapshot-paths.mjs`, and `build.mjs`'s writer, its drop path (a compiled controller
replaces a snapshot) and the generated route table all ask it. Measured after the change, on a
local `wrangler dev` and on the live worker: `/architecture` and `/architecture/` both answer
`200` with no `Location`, the same 2553 bytes (`/quotas`, `/quotas/`: 2470), while `/` stays `200`
and a path outside `_routes.json` still answers the app's 404 page. The proof is the status and
the served bytes against the FILE, not the body against PHP's raw render: a snapshot's URLs are
relativized at build time (`tools/snapshot-urls.mjs`), so PHP's own render carries
`http://localhost` where the file carries `/` — the normalisation this document's 92-URI sweep
already records. The invocation tier is untouched: both names are plain assets, and
`_routes.json` still carries 99 include + 1 exclude.

**6 — P6 (minor): a missing binding is reported as 500.** `GET /img/a.png` →
`500 {"ok":false,"error":"CF_IMAGE_RESIZING_ZONE is not configured"}`. It fails loud instead
of lying, which is right; `501`/`503` would say "the edge is not configured" rather than "the
worker broke".

**Reviewed 2026-11-14 — kept.** "`500` plus a named env var" is the repo-wide rule for a
missing binding, not a `glide` accident: 13 response sites in 12 `ports/packages/` files
(`apple-signin`, `cashier-paddle`, `cashier-stripe`, `dompdf` ×2, `firebase-php-jwt`,
`glide`, `lemonsqueezy`, `midtrans-webhook`, `mollie-webhook`, `webhook-client`,
`webhook-server`, `xendit-webhook`), plus the `throw` path in `auth0`, `echo`,
`fortify-confirmation` and `jwt-auth`. The `501` in `tools/ports.mjs:28` marks a *stub
handler* — a different meaning. Changing `glide` alone would leave twelve sites drifted
silently, so a `503` here is a one-rule-wide decision (all 13 sites and the tests that pin
them), not a sweep edit.

**7 — the schedule is compiled, but nothing verifies it.** `dist/cron.json` for this app is
`{"crons": [], "events": []}` (the app declares no schedule on purpose), while
`wrangler.jsonc` declares `crons: ["*/5 * * * *"]`. `wrangler dev` + `POST
/cdn-cgi/local/scheduled` answers 200 but the app has no observable cron side-effect, so the
`scheduled` handler's behaviour is **NOT VERIFIED**.

## Verified: the guided deploy end-to-end (2026-11-14)

`laravel-workers deploy --mode 3 --yes --skip-schema` ran to completion on this Windows
machine against `lw-showcase` (75.6 s): account detection, `wrangler d1 list`, the D1
binding check, build, `wrangler deploy`, then `lw-state.json` — `toolVersion 0.5.0`,
`sourceSha e330b2e`, `versionId cea8269b-7e94-46ee-8813-42eba9b7642e`, `databaseId
6870bddd-8549-4c3e-b423-ebe6f5b3ad9a` — and the binding step printed
`wrangler.jsonc: already points at "6870bddd-…" — left as-is` rather than resolving a
name. Two defects surfaced by that run and were fixed the same day: the Windows `npx`
invocation (the executable was quoted into a `Cannot find module …npm-prefix.js`
failure; PR #178) and the name-based D1 selection that created an empty database in
place of the bound one (PR #179).

The schema hash is deliberately absent from that state: the schema was applied with
`wrangler d1 execute DB --remote --file=dist/schema.sql` before the run, so `deploy`
recorded no hash for it. `dist/schema.sql` is not idempotent (25 `CREATE TABLE`, one
`IF NOT EXISTS`), so the honest state is "tables exist, no recorded hash": a later
`--yes` run without `--skip-schema` stops on `unknown-schema`, which is the documented
way to state intent.

## Verified: the four published fixes on the live app (2026-11-16)

Everything below used the **published package** (`npx --yes laravel-workers@0.5.1`), not a
checkout of this repo. `lw-showcase` is an app with uncommitted local edits
(`e330b2e +uncommitted changes`); no app source was changed for this verification.

### Build and local fixture

```bash
cd C:/Users/HP/Documents/vscode/lw-showcase
npx --yes laravel-workers@0.5.1 build --strict
```

Key lines: `_routes.json: 131 include patterns exceed Cloudflare's 100-rule combined cap ->
merged sibling prefixes down to 99`; `-> dist/public/_routes.json (99 include, 1 exclude)`;
`-> dist/public/404.html (218 bytes, the app's own 404 page)`; `coverage: all 131 route(s)
handled — static 2, snapshots 0, ports 56, controllers 73, extra-verb controllers 12, ignored
0`; `blade2php: 33 view(s) compiled byte-identical to Laravel (13)`; `READINESS: RUNS ON THE
EDGE`.

Local D1 was seeded with the **binding name**, not the UUID (the UUID is `database_id`):

```bash
npx wrangler d1 execute DB --local --file=dist/schema.sql     # 47 commands executed successfully
npx wrangler d1 execute DB --local --file=.cache/seed.sql     # 29 commands executed successfully
npx wrangler d1 execute DB --local --command 'select (select count(*) from posts) as posts,(select count(*) from users) as users' --json
# [{"posts":3,"users":1}]
```

On `npx wrangler dev --port 8787` (local service, bindings `DB`, `QUEUE`, `ASSETS`,
`LOCALES`), the pages answered `/`, `/crud`, `/up`, `/login` = 200, `/architecture` and
`/architecture/` = 200/2553 B with no `Location`, `/nonexistent-route-for-404` = 404/218 B
and a body byte-identical to `dist/public/404.html`.

### P1 — named route params, full HTTP round trip

A cookie-jar probe (fetch, `redirect: 'manual'`, CSRF token from each form) ran on local and
live. The create token must be taken from `/crud/create` **after** login, because login
regenerates the session (a pre-login token yields `419`):

```
GET  /login              200   token=...
POST /login              302   -> /crud
GET  /crud/create        200   token=...
POST /crud               302   -> /crud/4        # was /crud/%5Bobject%20Object%5D
GET  /crud/4             200   carries-title=true
GET  /auth/me            200   {"id":1,"email":"demo@example.test","check":true,"guest":false}
POST /logout             302   -> (no Location)
GET  /dashboard (after)  302   -> /login
```

The probe is a throwaway in `%TEMP%/lw-live-probe.mjs`, not a permanent test: its assertion is
the observable redirect target; the rest is printed evidence. The row it wrote was deleted
afterwards (`posts` back to 3).

### Deploy (mode 3, published package)

```bash
npx --yes laravel-workers@0.5.1 deploy --plan --mode 3
```

Preview: `mode 3 (build + database + deploy)`; worker `lw-showcase`; `d1 lw-showcase-db
(6870bddd-...) — reuse`; `target "lw-showcase-db" already has database_id 6870bddd-...`;
`schema not checked`; `Plan OK — no changes made.`

The first real attempt failed before deploying because a running `wrangler dev` held a handle
on `dist/`: `commitDist: cannot move ...\dist aside ... The previous ...\dist was left
untouched` and `deploy: build failed (exit 1) — nothing was deployed`. After stopping the dev
service and removing the leftover `dist.building/`:

```bash
npx --yes laravel-workers@0.5.1 deploy --name lw-showcase --mode 3 --skip-schema --yes
```

`→ wrangler.jsonc: already points at "6870bddd-..." — left as-is` (the D1 fix); `→ schema
skipped (--skip-schema)` (the D1 holds tables with no recorded schema hash — the documented
way to say "keep the data"); `✔ deployed → https://lw-showcase.ahmadfarosy.workers.dev ·
e330b2e (+uncommitted changes)` (104.2 s). `--skip-schema` was used deliberately: it keeps
the D1 data, which was then restored from the app's own fixture:

```bash
npx wrangler d1 execute DB --remote --file=.cache/seed.sql   # 29 queries, 76 rows written
# posts 3, users 1
```

### Live verification after the deploy

`curl` to `https://lw-showcase.nietzsc.de` (custom domain, in front of the same Worker):

| path | status | bytes | note |
|---|---|---|---|
| `/` | 200 | 2433 | data rendered (D1 restored) |
| `/crud` | 200 | 2133 | data rendered |
| `/up` | 200 | 46 | |
| `/architecture`, `/architecture/` | 200 | 2553 | **no `Location`** — P3 fixed |
| `/nonexistent-route-for-404` | 404 | 218 | **P2 fixed** |

`GET /nonexistent-route-for-404` body read with Node and compared via `fs.readFileSync` to
`dist/public/404.html`: **218 B vs 218 B, byte-identical** (the ASSETS layer serves the app's
own error view).

Provenance (P4), local state and Cloudflare agree:

```
npx --yes laravel-workers@0.5.1 status
deployed: 2026-11-16T14:33:08.582Z
commit  : e330b2e (+uncommitted changes)
version : 852b0faa-94e7-427e-9962-95ac6d5a2ab6
d1      : lw-showcase-db (6870bddd-8549-4c3e-b423-ebe6f5b3ad9a)

npx wrangler versions list --name lw-showcase
Created:     2026-11-16T14:32:58.270Z
Tag:         e330b2e6cfd0
Message:     e330b2e (+uncommitted changes) · laravel-workers 0.5.1
```

### Other CLI / artifact claims on this app (same run)

```
npx --yes laravel-workers@0.5.1 --version   -> laravel-workers 0.5.1
npx --yes laravel-workers@0.5.1 verify      -> VERIFY-S0: SKIP (no S0 dump; run a build with a views map first)
npx --yes laravel-workers@0.5.1 doctor      -> all ✓: node v22.18.0, app root, PHP 8.3.30, vendor,
                                              APP_KEY, wrangler 4.157.0, deploy state (this app, 2026-11-16)
```

`dist/src/worker.mjs` is 13311 bytes with **0** `WebAssembly`/`wasm` references; its only `php`
token is a comment explaining comma-joined request headers. `dist/build-info.json` carries
`toolVersion 0.5.1`, `builtAt 2026-11-16T14:32:21.587Z`, source sha `e330b2e…`, `dirty: true`;
`dist/public/_routes.json` has 99 include + 1 exclude. A claim-by-claim map is in
`docs/CLAIM-COVERAGE.md`; the Cloudflare Workers CPU benchmark is out of scope by decision,
and the README's 5 ms / 41 ms numbers remain probe-only.

### Verdict on the four findings

| finding | fixed in | verified here |
|---|---|---|
| P1 named `route()` params → `[object Object]` | 0.5.1 | local **and** live HTTP: 302 `/crud/4` |
| P2 empty 404 body | 0.5.1 | local **and** live: 404/218 B == `dist/public/404.html` |
| P3 static route 307 | 0.5.1 | local **and** live: 200/200, no `Location` |
| P4 deploy provenance | 0.5.1 | `status` commit+version; Worker `Tag`/`Message` |

Still NOT VERIFIED: the `scheduled` effect (`dist/cron.json` is empty for this app),
`action/verdict`, and CPU numbers for this app. The D1 row written by the probe was deleted;
`posts` = 3 after cleanup. No app source file was edited for this verification.

## PHP-vs-worker shadow replay of every app GET route (2026-11-16)

`tools/audit/make-showcase-scenario.mjs` reads the app's own `php artisan route:list --json`
(138 routes, 85 GET; the cached `.cache/routes.json` in the app was stale) and generates
`shadow/scenarios/lw-showcase.mjs`: 91 unique GET URIs (optional-segment variants expanded)
plus 9 auth/write steps = 100 steps. Genuine PHP↔worker differences are annotated in the
scenario with `expect: 'diverges'`, `expectStatus` and `why`; none was deleted to make the
report green.

```
cd C:/Users/HP/Documents/vscode/laravel-workers
LW_SHADOW_MIN_COVERAGE=0 node shadow/run.mjs --app "C:/Users/HP/Documents/vscode/lw-showcase" --scenarios shadow/scenarios/lw-showcase.mjs
EXIT=0
shadow: 71/100 byte-identical, 0 shape-verified, 0 json-equivalent,
        29 documented divergence(s), 0 unexplained — byte-identical step coverage 71% (accounted 100%)
```

With the default floor the same run exits 1 with `below the floor 100%` — honest, because
29 steps are not byte-identical. The initial run failed in the PHP oracle at `POST /login`:
a jar-less GET ran before the bootstrap step, leaving a session row without `$lastToken`, so
`@token` resolution threw. Moving the bootstrap GET to step 1 fixed the harness ordering (not
the product). `/routing/intended` needed the bootstrapped jar and `/ports/request` needed a
pinned `User-Agent: Symfony` to remove two order/header artefacts.

| URI(s) | PHP / worker | Recorded reason |
|---|---|---|
| `/analytics`, `/site-search` | 200 / 422 | PHP closure is empty; compiled port requires config / `q` |
| `/architecture`, `/architecture/`, `/quotas`, `/quotas/` | 200 / 200 | snapshot relativises internal URLs, PHP renders absolute |
| `/auth/jwt/user` | 200 / 401 | PHP empty closure vs JWT port `Unauthenticated.` |
| `/d/`, `/d/x`, `/nonexistent-route-for-404` | 404 / 404 | Laravel HTML 404 view vs 218-byte `dist/public/404.html` |
| `/en/localization`, `/es/localization`, `/localization` | 200 / 200 | PHP empty closure vs localization port JSON |
| `/horizon/metrics` | 200 / 200 | PHP empty closure vs per-queue metrics JSON |
| `/img/x` | 200 / 500 | compiled image port, `CF_IMAGE_RESIZING_ZONE` unbound |
| `/middleware/custom` | 200 / 200 | compiled port adds fields + CORS/`x-showcase-middleware` headers |
| `/misc/collection` | 200 / 200 | JS array with string keys → `array_values()` returns `[]` (PHP `[3,1,2]`) |
| `/misc/http` | 500 / 200 | CLI oracle's outbound HTTP fails; compiled port answers `unconfigured` |
| `/ports/ai`, `/ports/realtime` | 200 / 200 | PHP JSON stub vs compiled SSE stream |
| `/ports/blob` | 200 / 200 | compiled port appends `signed_url` |
| `/ports/dbcheck` | 200 / 200 | earlier `/horizon/metrics` step created D1 tables PHP never creates |
| `/ports/passport/authorize` | 200 / 400 | PHP stub vs compiled `invalid_client` |
| `/ports/pulse`, `/pulse` | 200 / 200 | different JSON schema (PHP `samples`/`avg_ms` vs compiled `summary`) |
| `/ports/socialite/authorize`, `/ports/socialite/callback` | 200 / 302, 200 / 400 | PHP stub vs signed-provider redirect / state verification |
| `/routing` | 200 / 200 | compiled `Route::has('routing.named')` returns `false`, `route()` resolves |
| `/tenants/acme` | 200 / 500 | compiled tenants port throws `column index out of range` |

The reasons are recorded per step in the scenario; the three that look like product defects
(`/misc/collection`, `/routing`, `/tenants/acme`) are **not** root-caused or fixed here.

## Mutating flows on a local 0.5.1 worker (2026-11-16)

An isolated probe (`npx wrangler dev --port 8789 --ip 127.0.0.1` in `lw-showcase`, service
`lw-write-probe-wrangler`, binding `DB`) drove 45 + 10 requests against the published-0.5.1
`dist/`. Scratch scripts/logs are under `%TEMP%/lw-write-probe/`; no repository file, live
Worker or remote D1 was touched. `GET /up` → 200 `{"status":"up","runtime":"cloudflare-workers"}`.

| flow | observed |
|---|---|
| `POST /crud` no title, HTML / JSON | 302 `/crud/create` / **422** `The post title is required for a post.` |
| `POST /crud` valid, `PUT`/`PATCH /crud/5`, `DELETE /crud/5` | 302 `/crud/5`, 302 `/crud/5`, 302 `/crud` + `GET /crud/5` → 404 (soft delete) |
| `POST /data/create` valid / invalid | 201 `{"id":6,…}` / 422 |
| `POST /forms/store`, `/forms/bag`, `/forms/formrequest` | 200/422 with Laravel's field messages; bag validates root keys |
| `POST /edge/storage`, `/crud-demo/facade` | 200: D1 blob put/list/sign/delete + cache forget/delete |
| `POST /ports/blob`, `PUT /ports/blob`, `POST /edge/upload` | 405 — see the verb investigation below |
| `POST /jobs/dispatch`, `/ports/queue-push` | 200/202 with `lw_jobs` rows; no local cron drain (wrangler does not fire scheduled workers in dev) |
| `POST /ports/pulse/record`, `GET /ports/pulse` | 201 entry, 200 summary with `top_routes` |
| `POST /events/publish`, `/mail/send` | 200 with two subscriber responses / log-transport mailable |
| `POST /api/echo` without / with CSRF token | 419 / 200 `{"json_ok":true}` |
| `POST /register` with guest jar + token | 302 `/dashboard`, `GET /dashboard` 200, `POST /logout` 302 |

Cleanup by exact ID/marker left local D1 unchanged: `users 1→1, posts 4→4, sessions 9→9,
lw_jobs 0→0, lw_blobs 1→1, activity_log 1→1, pulse_samples 1→1`; the probe-created
`pulse_entries` table was dropped, and final `probe_*` counts were all 0. The dev service was
stopped afterwards (`curl /up` → `000`, port free).

## P7 — a declared POST route was silently dropped by the published build (2026-11-16)

`lw-showcase` declares both `GET` and `POST /edge/upload` (`routes/web.php:194-195`; app route
list: `POST | edge/upload | edge.upload | App\Http\Controllers\EdgeController@upload`). The
published-0.5.1 artifact contains only the form verb:

```
# app repo, built with npx --yes laravel-workers@0.5.1 build --strict
grep -n '"uri": "/edge/upload"\|"POST /edge/upload"' dist/src/routes.generated.mjs
1006:    "uri": "/edge/upload",
1007:    "name": "edge.upload.form",
2372:  "GET /edge/upload": handler59,
2373:  "HEAD /edge/upload": handler59,
# no "POST /edge/upload" handler; routeNames still contains "edge.upload": "/edge/upload"
```

`lw-build.log:173-174` shows the mechanism and that the build still succeeded:
`LW002 $request->files is not compiled … ; controller /edge/upload: skipped — LW002 …` and
`• controllers transpiled: 85/86`. The successful 0.5.1 build (`docs/EVIDENCE.md:37`) reports
`build_exit=0` and `coverage: all 131 route(s) handled`. The refusal is intentional
(`compiler/src/transpiler.mjs:322-325`), but `build.mjs:3411-3413` logs and continues: no port
stub and no failing status for that route. Consequence on the local 0.5.1 worker:
`POST /edge/upload` → **405**, while Laravel's PHP route answers it. This contradicts
`README.md:24` ("Anything the compiler cannot handle fails the build — nothing silently wrong
ships") and `README.md:54,82`.

`PUT`/`POST /ports/blob` → 405 is **not** a defect: `routes/web.php:266` declares GET only and
compiled `dist/src/routes.generated.mjs:1414-1427` registers `GET`/`HEAD`; the 405 is correct parity.

## Critical follow-ups found while proving 0.5.1 (2026-11-16, phase B)

These are **new** findings from a line-by-line critical review and full-app shadow replay, not regressions
of P1–P4. None was changed in the working tree; each needs its own decision/PR. P7 above is a fourth,
directly observed counterexample to the "nothing silently wrong ships" claim.


### A. `route()` query values may contain a raw `/` (concrete, verified)

`rawUrlEncode()` in `compiler/runtime/rt-from-context.mjs:1182-1187` ends with
`.replace(/%2F/gi, '/')` (correct for a wildcard *segment*), and `queryFrom()` at `:1197` reuses that
same encoder for query keys and values. Laravel/RFC3986 keeps `%2F` in the query:

```
# tool repo
node --input-type=module -e "import {buildRt} from './compiler/runtime/rt-from-context.mjs'; const rt=buildRt({urls:{}},{strict:false,runtime:true,origin:'http://localhost',routeMap:{'crud.show':'crud/{post}'}}); console.log(rt.route('crud.show',{post:1,q:'a/b'}));"
http://localhost/crud/1?q=a/b
php -r "echo http_build_query(['q'=>'a/b'], '', '&', PHP_QUERY_RFC3986), PHP_EOL;"
q=a%2Fb

# app repo, Laravel 13.37 bootstrap probe
$url->route('crud.show', ['post'=>1, 'q'=>'a/b']) -> http://localhost/crud/1?q=a%2Fb
```

`@`, `?`, `&` and `%` already match (`%40`, `%3F`, `%26`, `%25`); only `/` differs.
`compiler/tests/rt-url.test.mjs:66-74` covers spaces, booleans and nesting, but not `/`, so the
suite stays green. Fix is one separate encoder for the query part; risk of changing the shared
encoder is breaking wildcard segments.

### B. Prerender asset-name collision (concrete mechanism, occurrence [INFERENCE])

`tools/snapshot-paths.mjs:45-46` maps `/index` → `index.html` and `/404` → `404.html` while the root
route also maps to `index.html` and the edge error page is written as `404.html` (`build.mjs:4055`).
`build.mjs:1120-1124` writes every reported name unconditionally; there is no cross-route guard.

```
node -e "import('./tools/snapshot-paths.mjs').then(m=>{ for (const u of ['/','/index','/404']) console.log(u, JSON.stringify(m.snapshotFiles(u))); })"
/ ["index.html"]
/index ["index.html","index/index.html"]
/404 ["404.html","404/index.html"]
```

[INFERENCE] An app that declares `/index` or `/404` as a prerendered route silently serves one
page's bytes under the other's name. `tools/tests/snapshot-paths.test.mjs:37-44` checks uniqueness
only within one call. `lw-showcase` has neither route, so the live deploy is unaffected.

### C. Checked and sufficient

The 404 artifact writer (`build.mjs:1044-1054,4037-4055`), and the provenance chain
(`tools/git-sha.mjs:18-51` → `dist/build-info.json` → `tools/deploy.mjs:779-799,1589-1593`) have no
concrete defect in this review. [INFERENCE] `tools/git-sha.mjs:16` rejects 64-char SHA-256 git IDs,
which would omit the Worker tag/message; no SHA-256 repository was probed.

### D. Three documented shadow divergences root-caused (2026-11-16)

All three remain annotated `expect: 'diverges'`; the replay totals do not change.

1. **`/misc/collection` — genuine toolchain defect, silent data loss.** PHP writes string keys into a
   `[]` then calls `array_values()` → `[3,1,2]`. The transpiler emits `[]` for the keyless literal
   (`compiler/src/transpiler.mjs:514`) and a computed property write (`:3475-3476`), so the value stays
   a JS array with zero indices; `rt.array_values` at `compiler/runtime/rt-from-context.mjs:1322`
   takes `.slice()` and returns `[]`. Blast radius probed: `implode`, `array_sum`, `json_encode`,
   `count`, `collect()->count()` all see the empty list while `array_keys`/`foreach` still work.
   Fix: make index-based helpers honour non-index own keys (also `count`, `empty`, `array_merge`,
   `kernel/php-json.mjs:187-195`), risking insertion-order/marker-property regressions; regression
   test must cross emitter + runtime (`compiler/tests/corpus/cases/array-values-string-key-writes.php`).
2. **`/routing` — genuine toolchain defect, moderate severity.** `rt.Route.has()` reads
   `ctx.route_names` (`compiler/runtime/rt-from-context.mjs:106-115,349-350`), but compiled
   controllers call `buildRt(null, { routeMap: … })` (`lw-showcase/dist/src/controllers/routing.mjs:9,16`),
   so `has()` is always false while `route()` resolves via `opts.routeMap` (`:1110,1214-1216,1266-1277`).
   `dist/src/routes.generated.mjs:2122-2134` exports the correct map but nothing imports it. Zero tests
   cover `rt.Route.has`. Minimal fix: fall back to `Object.keys(opts.routeMap)` before the empty-array
   guard (138 keys, symmetric difference zero); risk: warning disappears, so strict mode should keep a
   guard when neither source exists. The app fixture `lw-showcase-gaps.mjs:32` hard-codes `has_named:false`
   and must be updated in the same change.
3. **`/tenants/acme` — shadow harness defect, not the compiled port or real D1.** The app and compiled
   port are byte-identical (SHA-256 `a7060aef…`); the port binds `?1` with `.bind('acme')`, but
   `shadow/run.mjs:122` passes numbered params positionally to `node:sqlite`, which throws "column
   index out of range". The toolchain's own `tools/tests/_fake-d1.mjs:47-61` already uses the correct
   keyed object `{1: v}`. Reproduction: `?1 + positional` throws, `?1 + {1:'acme'}` returns the row;
   harness → 500, FakeD1-style binding → 404 "tenant not found". Nine app ports use `?N`, so fix the
   harness binding in all three methods; do not rewrite app SQL. After the fix the step becomes a
   documented 200-vs-404 divergence, so `expectStatus`/`why` need updating.

Advisory fix strategies for P5/P6/P7 (no code change approved) are recorded in the agent handoff and
in the Indonesian final report: P5 split the query encoder, P6 add a `claimedPageFiles` guard in
`writePage` (`build.mjs:1120-1124`), P7 add `failedControllers` to `blocked` at `build.mjs:3411-3426,4095`.

### E. Build-time path traversal through `registry.json` names (Medium, path reproduced)

Operator-supplied names are used as relative file names without containment checks. Only
leading/trailing slashes are stripped (`tools/snapshot-paths.mjs:23,34,44`); `build.mjs:310-311`
takes `registry.static`/`registry.ports` verbatim, and writes at `:1120-1124` (snapshots/static)
and `:2167-2171` (port controllers) use `join(dist, 'public', file)` / `join(dist, 'src', 'controllers', slug + '.mjs')`.

```
node --input-type=module -e "import {snapshotFiles} from './tools/snapshot-paths.mjs'; import {resolve} from 'node:path'; const f=snapshotFiles('/', '../../../../tmp/lw-pwned'); console.log(JSON.stringify(f)); console.log(resolve('/app/dist.building','public',f[0])); console.log(resolve('/app/dist.building','src','controllers','../../../lw-pwned.mjs'));"
["../../../../tmp/lw-pwned"]
C:\tmp\lw-pwned
C:\app\lw-pwned.mjs
```

Both targets escape `dist.building`. Precondition: control of `registry.json` (app source / PR),
not remote HTTP input; impact is arbitrary file creation/overwrite within the build user's reach,
including CI checkout files. Fix advice: reject `..` segments and absolute paths at ingestion, or
verify `resolve(out).startsWith(resolve(dist) + sep)` immediately before every write — for port
slugs validate before the early write at `:2167-2171`, not only at the later existence check
`:3653-3654`. The security critic found no concrete command injection, D1 SQL injection, eval-like
request path, cookie/CSRF issue or stored secret in the reviewed scope; `src/worker.mjs:200-205`
correctly fail-closes the cron face when `LW_CRON_SECRET` is unset.

## Live residual GET sweep (2026-11-16) — honest limits

An independent read-only sweep of 87 GET URIs (85 GET-capable app routes plus `/d`,
`/routing/optional`, `/routing/wild`, minus the side-effecting `/data/writes`) found no 307/308,
no empty bodies and no wrong content types; all 10 redirects were 302. It did find real limits:

```
# direct re-probe against the deployed app, 3 sequential requests each
GET /auth/hash    → 200 once (JSON 79 B), 503 twice (4660 B HTML "Worker exceeded resource limits")
GET /data/index   → 503 twice, 200 once (JSON 211 B)
GET /health       → 200 three times, 75 B {"ok":true,"worker":"laravel-workers","builtAt":"2026-11-16T14:32:21.587Z"}
```

The sweep measured 10/10 503 for `/auth/hash` and 5/10 for `/data/index` with `cf-ray` headers;
`DashboardController.php:30-36` runs five bcrypt operations on the first route. This is **not**
a Cloudflare CPU benchmark (excluded by user decision) but an observed production failure on two
app routes: do not claim that every route of the app is healthy on the deployed Worker.

Other residual facts: `/img/test` returns a handled 500 JSON (`CF_IMAGE_RESIZING_ZONE is not
configured`, 63 B); `/d` and `/d/test` return the 218-byte static 404 because `routes/web.php:75`
restricts that route to `{account}.lw.test`; `/errors/500` and `/errors/404` are intentional demo
statuses. `/health` is a Worker-only route (`dist/src/worker.mjs:255-257`) absent from the app's
route list and compiled `routeTable`; `_routes.json` includes it. `architecture`/`quotas` are not
in `_routes.json` because they are static assets served by ASSETS, and both still answer 200.


## Unclaimed surface and documentation drift (2026-11-16)

The 34-row matrix covers README claims. A read-only critic sweep of `COMPILED.md`, `MAP.md`,
`docs/DEPLOY.md`, `docs/CI.md`, `docs/PACKAGE-PORTS.md`, `CHANGELOG.md` and `package.json` found
**15 concrete claims outside that matrix**: 6 evidenced only by named tests, 2 already evidenced
here, 2 **NOT VERIFIED** and 5 further test-only items. The two highest-risk unproven items are:

- `docs/PACKAGE-PORTS.md:93-117` says authenticated callers are required for seam routes but
  explicitly lists currently **ungated** routes (`/notify/*`, mailgun/postmark/slack/twilio,
  `/ai/chat`, `/mcp`, `/pulse/record`, `/bugsnag/notify`, `/img/{path}`) that can spend app
  credentials or write state anonymously.
- `action/verdict` (sticky PR comment, job summary, fork-safe, always exit 0) is documented at
  `docs/CI.md:12,53,139-145` but explicitly disclaimed at `CHANGELOG.md:172-173` and
  `MAP.md:425`. This is a CI contract users copy — treat as NOT VERIFIED.

The same sweep found **8 confirmed documentation drifts** (static evidence, no edits made):

|Stale side|Current side|Our check|
|---|---|---|
|`COMPILED.md:292-293` "FormRequest ... not compiled yet; write a port"; `MAP.md:179`|compiled lifecycle `rt-from-context.mjs:453-531`, `kernel/form-request.mjs:4-20,62-96`, `COMPILED.md:127-130,826-828`|`grep -n "not compiled yet; write a port" COMPILED.md MAP.md` → `COMPILED.md:293`|
|`MAP.md:218` "no Log module; `Log::` facade not mapped → port"|`facade_log` is `expect: ok, status: done` (`tools/constructs.json:1190-1194`); `COMPILED.md:862,889`; `MAP.md:511` already says it compiles|our read → `MAP.md:218` vs `MAP.md:205`|
|`MAP.md:510` "dates in UTC"|M70 done, `app.timezone` + `Intl` in `rt-from-context.mjs:2500-2608`, `COMPILED.md:638`|our read → `MAP.md:510`|
|`MAP.md:443,445` corpus 51/51|55 cases in `compiler/tests/corpus/cases.json`, `README.md:40`|our node check → `cases:55`, stale at `MAP.md:443`|
|`MAP.md:444` 30 port handlers; `docs/PACKAGE-PORTS.md:283-284` 47 slugs → 81 paths|63 `ports/packages/*.mjs`, 47 slugs → **80** registry paths, and some handlers are not in `registry.example.json`|our node check → `files:63, registryRoutes:80`, stale at `MAP.md:444`, `docs/PACKAGE-PORTS.md:284`|
|`MAP.md:227,435` retired `ship` command|CLI has `deploy`, not `ship` (`bin/laravel-workers.mjs:80-100,215`)|our node check → `cli_ship:false`, stale at `MAP.md:227,435`|
|4 root-relative links in `docs/DEPLOY.md` and `docs/PACKAGE-PORTS.md`|targets do not resolve from `docs/`|our node check → all 4 `exists:false`|
|`docs/DEPLOY.md` validation-messages / ascii-map checks in `gate.mjs` are SKIP without `LW_APP_ROOT`/`--require`; `publish-gpr` (`.github/workflows/publish.yml:116-144`) has no tag/version check that `publish.yml:101-107` has|CI e2e steps make the two checks fatal; the GPR release path can ship a mismatched tag|`npm run gate:ci` output shows both SKIPs; workflow lines read directly|

Lower-confidence `[INFERENCE]`: `CHANGELOG.md:2` says M1–M70 while `MAP.md:415-423` records
M71–M77 and `COMPILED.md:639` has an M71 row; the changelog body has no M71+ headings, so this
may be intentional scoping. No code or docs were changed in this pass.

Test-quality critic (8 representative files) found: a known PHP divergence enshrined as a passing
assertion (`compiler/tests/rt-url.test.mjs:124,128`), retry backoff never exercised
(`compiler/tests/queue.test.mjs:71,125-132`), negative TTL instead of a clock advance
(`kernel/tests/storage.test.mjs:120`), environment-skipped PHP parity (`kernel/tests/auth.test.mjs:135,195,259,805`),
source-text regex assertions (`tools/tests/packages-streaming-runtime.test.mjs:148-149`,
`tools/tests/wrangler-crons.test.mjs:103-104`), and a near-tautological uniqueness assertion
(`tools/tests/snapshot-paths.test.mjs:38-44`). These weaken the T2 evidence tier; they do not
invalidate the T1/T3/T4 evidence for P1–P4.

## P7 fix on local main (2026-11-16, unreleased)

Published 0.5.1 still has the P7 defect. The fix below exists only on local `main` after 0.5.1;
no tarball or deploy was produced from it.

Code: `build.mjs` now calls `recordControllerSkip(route, verb, reason)` on all seven emit-loop
`continue` branches and on the emit-failure `catch`; `failedControllers` feeds `blocked`, a BLOCK
finding (`controllerSkipFinding`), the `CONTROLLER FAILED` log and `--scaffold` stub selection.
`tools/controller-coverage.mjs` holds the decision, pinned by `tools/tests/controller-coverage.test.mjs`
(10/10) and `kernel/tests/ports.test.mjs` (6/6), including the verb in the generated stub comment.

Commands and observed output in a scratch copy of `lw-showcase`
(`C:/Users/HP/AppData/Local/Temp/lw-p7-scratch`, `--no-cache`):

```text
$ node C:/Users/HP/Documents/vscode/laravel-workers/build.mjs --strict --no-cache
CONTROLLER FAILED POST /edge/upload: LW002 $request->files is not compiled ...
BUILD FAILED: coverage check failed (--strict) — 1 finding(s)
READINESS: DOES NOT RUN
BUILD_EXIT=1

$ node C:/Users/HP/Documents/vscode/laravel-workers/build.mjs --scaffold --no-cache
CONTROLLER FAILED POST /edge/upload: LW002 $request->files is not compiled ...
scaffolded ports\edge-upload--post.mjs (laravel-workers:stub — build --strict fails until implemented)
registry.json: "ports" += "/edge/upload": "edge-upload--post"
READINESS: RUNS ON THE EDGE
BUILD_EXIT=0

$ read ports/edge-upload--post.mjs:1
// Port for POST /edge/upload — laravel-workers:stub
```

The scaffold run was repeated after removing the scratch port registration; exit 0 and the
`POST` stub comment were reproduced. A subsequent `--scaffold` run on the same scratch app exits 1
because the stub is now a registered port — expected: stubs are blocked until implemented.

## NOT VERIFIED (stated, not implied)

- ~~`deploy --mode 3` end-to-end on this machine~~ — **verified 2026-11-14**, see
  "Verified: the guided deploy end-to-end" above.
- The `5 ms CPU p50 / 41 ms p95` numbers for **this** app — they come from the CPU probe, not
  from a measurement of `lw-showcase`.
- The `scheduled` handler's effect (finding 7).
- `action/verdict` on this app (not run in this audit).
- True byte-parity for data-rendering pages: the two databases differ by design, so only
  non-data pages can be compared without a controlled fixture.

## Re-running this

The two scripts this audit used live in `tools/audit/` in a git checkout (they are excluded from
the npm tarball), so the numbers can be reproduced from source without rebuilding them:

```bash
# the app's own route list, then both sides
php artisan route:list --json > /tmp/routes.json
node tools/audit/sweep.mjs --routes /tmp/routes.json --base https://lw-showcase.nietzsc.de --out .audit/live \
  --extras /nonexistent-route-for-404,/api/posts,/api/posts/1
php artisan serve --host=127.0.0.1 --port=8300          # in the app; APP_DEBUG=false for error pages
node tools/audit/sweep.mjs --routes /tmp/routes.json --base http://127.0.0.1:8300 --out .audit/oracle \
  --extras /nonexistent-route-for-404,/api/posts,/api/posts/1
node tools/audit/compare.mjs --live .audit/live --php .audit/oracle \
  --origin A=https://lw-showcase.nietzsc.de --origin B=http://127.0.0.1:8300
```

Two cautions for the next run: a GET sweep **writes** on this app (`/data/writes` inserts a
row), so either exclude it from the routes file or expect the `posts` count to move; and the
local PHP server needs `APP_DEBUG=false` if error pages are to be compared.

## Final integrated audit (2026-11-16, unreleased)

Published `npx --yes laravel-workers@0.5.1` (npm gitHead `7c73223e…`) is authoritative for shipped
behaviour. Every fix labelled **fixed on main after 0.5.1, not yet published** below is local
working-tree state on `main` (HEAD `daef205`), absent from the published `0.5.1` artifact
(verified by PublishedVsMain against npm gitHead `7c73223e…`); the local Git tag `v0.5.1` points
at a different commit and is not used as evidence. Cloudflare Workers CPU benchmarks remain
**excluded by user decision**; `npm run bench` is a Node proxy and is never workerd CPU evidence.

### Commands run in this pass (AuditDocsRows)

```text
$ cd C:/Users/HP/Documents/vscode/laravel-workers && npm run check:docs
> laravel-workers@0.5.1 check:docs
> node tools/gate.mjs

docs-check PASS: 105/105 rows, format valid, 48 modules, 6 fail-loud codes
docs-check PASS: integrations: 8/8 pages carry a verdict + a port
coverage: 105/105
construct-audit PASS: 118 constructs (54 compile, 57 fail loud, 7 documented at the build level), the COMPILED.md table matches the code
docs-counts PASS: README counts match the code (118 constructs, 47/47 facades, corpus 55, 105 docs)
validation-messages: SKIP - the module was NOT audited (set LW_APP_ROOT to a Laravel app); pass --require to make this fatal
ascii-map: SKIP - the module was NOT audited (set LW_APP_ROOT to a Laravel app); pass --require to make this fatal
port-catalog PASS: 48 D1 tables (55 statements, 6 indexes) and 112 env names - both documents match the code
gate PASS: the docs and the construct audit match the code
```

Stale-phrase grep (compound command; exact subcommands and observed output):

```text
$ grep -c 'verdict@v1' docs/CI.md .github/workflows/app-check.yml .github/workflows/app-deploy.yml
docs/CI.md:0
.github/workflows/app-check.yml:0
.github/workflows/app-deploy.yml:0

$ grep -n 'two scripts this audit used' docs/EVIDENCE.md
738:The two scripts this audit used live in `tools/audit/` in a git checkout (they are excluded from

$ grep -n 'not compiled yet; write a port' COMPILED.md MAP.md
(no matches)
```

`docs/EVIDENCE.md:738-739` was already correct — tools/audit lives in a git checkout and is
excluded from the npm tarball — so **no edit was made** to that sentence. Historical `51/51`
mentions remain only in this file's drift record (`:670`) and the dated M1 note (`MAP.md:316`).

Local-fix spot checks in this pass (source reads/greps, not executions):

```text
$ git status --short && git branch --show-current && git log -1 --oneline
→ 44 unstaged, 15 untracked, 0 staged; branch main; HEAD daef205 fix(build): fail strict and scaffold skipped controllers (P7)

$ grep -n -E 'recordControllerSkip|hasBlockingControllerSkips|CONTROLLER FAILED' build.mjs tools/controller-coverage.mjs | head -20
→ build.mjs:44 (import), :1207 (definition), :3191/:3198/:3244/:3307/:3329/:3369/:3379/:3506 (call sites),
  :4188 blocked includes hasBlockingControllerSkips(failedControllers), :4196 CONTROLLER FAILED log,
  tools/controller-coverage.mjs:11 hasBlockingControllerSkips

$ grep -n -E 'phpEncode|queryFrom|routeMap|phpKeys' compiler/runtime/rt-from-context.mjs | head -20
→ :112-120 routeMap fallback for Route::has(), :1194-1208 phpEncode/queryFrom split, :1303-1417 phpKeys reads

$ grep -n 'findSnapshotCollisions\|assertNoSnapshotCollisions' tools/snapshot-paths.mjs build.mjs
→ tools/snapshot-paths.mjs:69,103; build.mjs:46,1288 (guard called before first write)

$ read shadow/scenarios/lw-showcase.mjs:60-105
→ /misc/collection (line 68) and /routing (line 87) divergence annotations removed;
  /tenants/acme (line 103) reason now PHP 200 vs worker 404 "tenant not found"
```

### Evidence attributed to named agent reports (not re-run in this pass)

- **P7** scratch build and scaffold (`docs/EVIDENCE.md` "P7 fix on local main"): `CONTROLLER FAILED POST /edge/upload`, `BUILD FAILED: coverage check failed (--strict) — 1 finding(s)`, `BUILD_EXIT=1`; scaffold wrote `ports/edge-upload--post.mjs` plus the registry entry, `BUILD_EXIT=0`. [Report: P7BranchReview — static source review; that agent explicitly did not execute tests.]
- **Shadow `?N` binding**: focused replay `NODE_NO_WARNINGS=1 LW_SHADOW_MIN_COVERAGE=0 node shadow/run.mjs --app "../lw-showcase" --scenarios "shadow/scenarios/tenant-probe.mjs"` → `0/1 byte-identical, ... 1 documented divergence(s), 0 unexplained`, PHP 200 vs worker 404 `tenant not found`. [Report: ShadowHarnessFix]
- **Verify**: `php -l tools/verify-s0.php` → `No syntax errors detected`; `node --test tools/tests/verify-fix.test.mjs` → `# tests 10 / # pass 10 / # fail 0`. [Report: VerifyFix]
- **CLI/deploy**: `node --test tools/tests/deploy-integration.test.mjs tools/tests/doctor-strict.test.mjs tools/tests/cli-help.test.mjs` → `# pass 48`, `# fail 0`. [Report: DeployCliFix]
- **CI/release**: Python YAML parse OK for `publish.yml`, `ci.yml`, `app-check.yml`, `app-deploy.yml`; local grep `verdict@v1` → 0; the **published `v0.5.1` tag still contains stale `@v1`** (verified live raw GitHub). [Report: CiReleaseFix; provenance cross-check: PublishedVsMain]
- **Security**: `node --test` focused suite → `# tests 99 / # pass 96 / # fail 0 / # skipped 3`; canary build → 0 canary matches in the build log and 0 in `dist/`. [Report: SecurityFix]
- **Artifacts**: `node tools/pack-gate.mjs` → `pack-gate OK: 118 runtime files ... (213 files in the tarball; local links checked in 17 Markdown files)`; `node --test tools/tests/pack-gate.test.mjs` → 4/4. [Report: ArtifactFix]
- **Docs drift**: `npm run check:docs` → the same PASS output re-run above. [Report: DocsDriftFix]
- **P6**: `node --test tools/tests/snapshot-paths.test.mjs` → `# tests 10 / # pass 10 / # fail 0`. [Report: SnapshotCollisionFix]
- **P3/P4/P5**: `node --test compiler/tests/rt-url.test.mjs compiler/tests/rt-array-string-keys.test.mjs` → 17/17; semantics suites 21/21; `node compiler/tests/run-corpus.mjs` → 55/55. [Report: RuntimeParityFix] The stale app fixture `lw-showcase-gaps.mjs:32` was not edited (user-owned app repo).
- **Cross-repo, not `laravel-workers` claims**: stateless-seal `npm test` → 23 files / 113 tests pass [StatelessSealFix]; blade2php `npm test` → 240/240 [Blade2PhpCoreFix]; nearFind `php artisan test` → 67/67 [NearFindSafeFix].
- **Prior art / legal**: last formal scan recorded CLEAN (2026-10-17); no fresh scan was run in this audit [ShowcaseClaims / Philosophy]. The trademark sentence is a legal notice, not a testable technical claim.

## Latest integrated verification (2026-11-17, unreleased)

All results below are **fixed on main after 0.5.1, not yet published**. The published npm artifact
`npx --yes laravel-workers@0.5.1` (`gitHead 7c73223e…`) remains authoritative for shipped behaviour.

### Strict and scaffold P7 proof

```text
$ cd C:/Users/HP/AppData/Local/Temp/lw-p7-scratch
$ LW_ALLOW_SECRET_CONFIG_KEYS=mail.mailers.smtp.password node C:/Users/HP/Documents/vscode/laravel-workers/build.mjs --strict --no-cache
CONTROLLER FAILED POST /edge/upload: LW002 $request->files is not compiled ...
BUILD FAILED: coverage check failed (--strict) — 1 finding(s)

$ LW_ALLOW_SECRET_CONFIG_KEYS=mail.mailers.smtp.password node .../build.mjs --scaffold --no-cache
BUILD_EXIT=0
scaffolded ports\edge-upload--post.mjs
registry: "/edge/upload": "edge-upload--post"
controllers transpiled: 85/86
```

The scaffold stub answers 501 with `{ error: 'not implemented', route: '/edge/upload' }`; it is a
visible placeholder, not a compiled `files` implementation. No scratch-only port registration
existed before the scaffold run.

### Full shadow replay

```text
$ LW_SHADOW_MIN_COVERAGE=0 node shadow/run.mjs --app "C:/Users/HP/Documents/vscode/lw-showcase" --scenarios shadow/scenarios/lw-showcase.mjs
+ 200/200 GET /misc/collection — match
+ 200/200 GET /routing — match
73/100 byte-identical, 0 shape-verified, 0 json-equivalent, 27 documented divergence(s), 0 unexplained
exit 0
```

These two matched routes were the concrete root causes recorded earlier for `/misc/collection`
(string-key array writes) and `/routing` (`Route::has()` with `buildRt(null, {routeMap})`). This
replay is stronger than the older 71/100, 29-divergence measurement in the same fixture.

### Null-coalescing parity

Found during nearFind edge verification: PHP `$category['label'] ?? ''` returns `''` for a null
base, while the old emitted JS `v_category["label"] ?? ""` threw
`TypeError: Cannot read properties of null (reading 'label')`. `compiler/src/transpiler.mjs` now
emits optional chaining only for the left-hand side of `??`; plain reads remain strict.

```text
$ node --test compiler/tests/null-coalesce-offset.test.mjs
# tests 7 / # pass 7 / # fail 0

$ npm test
1..2253 / # tests 2253 / # pass 2199 / # fail 0 / # skipped 54

$ npm run check:docs
docs-check PASS: 105/105 rows ... gate PASS

$ npm run test:corpus
=== CORPUS: 55/55 pass, 0 fail ===
```

### Integrated gate before this documentation edit

```text
$ npm run gate:ci
PASS, 121.36 s, 2246 tests / 2192 pass / 0 fail / 54 skipped
corpus 55/55, docs 105/105, pack-gate 214 files

$ npm run check:docs && node tools/pack-gate.mjs && git diff --check
docs-check PASS 105/105, construct-audit PASS 118, docs-counts PASS,
port-catalog PASS, pack-gate OK 214 files
```

The remaining CRLF-to-LF warning for `kernel/scheduler.mjs` is a Git normalization notice, not a
test failure. Published `0.5.1` still contains older `verdict@v1` wording; that drift is not
silently backported to the published artifact.

### `lw-showcase` full toolchain sweep (2026-11-17)

The app fixture now resolves the sibling local tool checkout through `scripts/local-tool.mjs`
instead of its stale `0.4.9` tarball. Every command below was re-run from the app root after the
sweep agent finished. These are local-tool results, **not** published `0.5.1` behaviour.

```text
$ npm run build:edge
READINESS: RUNS ON THE EDGE
  every route is served by a compiled handler, a snapshot or a port;
  no route is ignored, and no binding is missing.

$ npm run shadow
shadow: 96/96 byte-identical, 0 shape-verified, 0 json-equivalent,
        0 documented divergence(s), 0 unexplained — byte-identical step coverage 100%

$ npm run shadow:gaps
shadow: 0/10 byte-identical, 10 documented divergence(s), 0 unexplained — accounted 100%

$ npm run shadow:full
shadow: 104/119 byte-identical, 15 documented divergence(s), 0 unexplained — accounted 100%

$ npm run smoke
208 asserted ok, 0 failed, 0 without an expectation

$ npm run sweep
sweep coverage (declared routes/methods)
  total 230 / byte-step 5 / divergence 8 / excluded 123 / gate-or-gaps 94
  stepped 107/230 (46.5%)
deploy surface
  main=./dist/src/worker.mjs  d1=lw-showcase-db  crons=*/5 * * * *
  controllers=128 file(s) for 86 controller route(s); ports=56
  build-info toolVersion=0.5.1  _routes.json include=99 exclude=1
sweep coverage OK — every route/method is stepped or explicitly excluded; deploy artifacts agree.

$ npm run cpu -- --iters 5
worst route: GET /auth/hash 1109.00 ms cpu
p95 route:   GET /middleware/guest 16.00 ms cpu
routes registering at all (>= the 1 ms timer): 32/137
```

`shadow:gaps` and `shadow:full` intentionally contain documented divergences, hence the 0% and
87% byte-identical floors; any *unexplained* mismatch would still exit non-zero. The regular
`shadow` gate remains at 100%. The CPU numbers are `process.cpuUsage()` coarse timers in Node,
never workerd CPU; Cloudflare CPU benchmarks remain excluded by user decision.

Explicit exclusions in the 230-route inventory are reasoned, not hidden: P6 snapshot collision
cannot occur because this app declares no snapshots and no `/index` or `/404` prerender route;
P5 `%2F` query encoding has no app call site; the app declares no schedule; 123 route/method
entries are status/body-mismatched port seams with concrete recorded reasons. The P7 route now
uses `count($request->allFiles())` and takes part in the 100% byte-identical gate.
