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
the assets layer. Documented or given a catch-all — a decision, not a silent behaviour.

**3 — P3: `status` is blind to a deploy the tool did not perform.** `node bin/laravel-workers.mjs
status` in `lw-showcase` prints `no deploy recorded for this app yet` while the app is live,
because `lw-state.json` only exists after the tool's own `deploy`. Reasonable, but the output
reads as "not deployed". Consider naming the case (`wrangler.jsonc` exists, no state: "deployed
outside the toolchain?").

**4 — P4: no build/deploy provenance.** Neither `dist/` nor `lw-state.json` carries the app
source SHA or the toolchain version, and `wrangler deployments list` shows `Source: Unknown
(deployment)`. So "which commit is live" is unanswerable — the working tree here is dirty on
top of `e330b2e`.

**5 — P5: prerendered static routes answer 307 before 200.** `GET /architecture` and
`GET /quotas` (the two `static` routes) return `307 Location: /architecture/`, then 200 from
the asset layer; PHP answers 200 directly. Harmless for a browser, visible to `curl` users,
crawlers and any client that does not follow redirects.

**6 — P6 (minor): a missing binding is reported as 500.** `GET /img/a.png` →
`500 {"ok":false,"error":"CF_IMAGE_RESIZING_ZONE is not configured"}`. It fails loud instead
of lying, which is right; `501`/`503` would say "the edge is not configured" rather than "the
worker broke".

**7 — the schedule is compiled, but nothing verifies it.** `dist/cron.json` for this app is
`{"crons": [], "events": []}` (the app declares no schedule on purpose), while
`wrangler.jsonc` declares `crons: ["*/5 * * * *"]`. `wrangler dev` + `POST
/cdn-cgi/local/scheduled` answers 200 but the app has no observable cron side-effect, so the
`scheduled` handler's behaviour is **NOT VERIFIED**.

## NOT VERIFIED (stated, not implied)

- `deploy --mode 3` end-to-end on this machine (production would be replaced; the live bundle
  came from `wrangler deploy` on 2026-11-13).
- The `5 ms CPU p50 / 41 ms p95` numbers for **this** app — they come from the CPU probe, not
  from a measurement of `lw-showcase`.
- The `scheduled` handler's effect (finding 7).
- `action/verdict` on this app (not run in this audit).
- True byte-parity for data-rendering pages: the two databases differ by design, so only
  non-data pages can be compared without a controlled fixture.

## Re-running this

The two scripts this audit used ship in `tools/audit/` so the numbers can be reproduced without
rebuilding them:

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
