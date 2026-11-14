# Changelog
The change-by-change record of laravel-workers (M1–M70 and the A-series audit findings). Current status and construct coverage live in the [README](README.md).
## Unreleased

### A prerendered page answers with and without its trailing slash

`GET /architecture` on a live app answered `307 Location: /architecture/` and then `200`, where PHP
answers `200` directly (`docs/EVIDENCE.md` finding 5). Cloudflare's default `html_handling`
(`auto-trailing-slash`) answers `/about` from `about.html` and `/about/` from
`about/index.html`, so a page that exists only as the folder file redirects the bare URL — and no
`html_handling` mode answers both spellings without a redirect. PHP's matcher trims the trailing
slash, so both are the same route and both are `200` (measured on the shadow oracle, `200/200`).
The build therefore writes every prerendered page under **both** names it is reachable as, through
one rule (`tools/snapshot-paths.mjs`) that the writer, the snapshot drop path (a compiled controller
replaces a snapshot) and the generated route table all ask; a `registry.json` `static` value an
operator names gains its twin automatically, and `tools/tests/snapshot-paths.test.mjs` pins the
cases. Neither name enters `_routes.json`, so the 0-invocation tier is untouched. Measured after
the change: a local `wrangler dev` and the live worker answer `/architecture` **and**
`/architecture/` with `200`, no `Location`, the same 2553 bytes (`/quotas` the same 2470), while
`/` stays `200` and the include list stays at 99. The `writePage` log line now reports bytes on
disk instead of string length — the pages carry multi-byte characters, so it under-reported.

### A path outside `_routes.json` answers the app's own 404 page

`GET /nonexistent-route-for-404` on a live app answered `404` with **no body** where PHP answers
the app's own error view (218 B on the app that measured it — `docs/EVIDENCE.md` finding 2).
`_routes.json` is an include allowlist: the request never reaches the worker, so none of the app's
code runs to answer it, and `kernel/http.mjs` hands an unmatched path back to the assets binding
even when it does. The fix is therefore a build artifact rather than a route — the build now
writes `dist/public/404.html`, rendered by `tools/prerender.php --error 404` through Laravel's
own exception path (the page a request that reaches no route is answered with, not one a route can
capture; the body comes from the CLI output buffer when the response carries none, the rule the
shadow oracle had already measured for its 405/500), with the same URL relativization every
snapshot gets — and both scaffolded `wrangler.jsonc` templates carry
`"not_found_handling": "404-page"` in their `assets` block, the Cloudflare switch that serves the
nearest `404.html` with a 404 status. An app whose config predates the switch gets a DECLARED
finding naming the exact line to add, and an app that ships its own `public/404.html` keeps its
file. Measured after the change: a local `wrangler dev` and the live worker both answer that path
with `404`, 218 B, byte-identical to `dist/public/404.html`, while `/` and `/favicon.ico` stay
`200`. The e2e job now fails unless the artifact exists, the scaffolded switch is present, and the
bytes served for an unknown path match the file. Two limits stay declared: the page is rendered
with a synthetic `GET /` request (a 404 view that prints the request path bakes that path), and
the asset layer has no `Accept` to branch on, so a JSON client receives the HTML page where PHP
answers JSON.

### `route()` reads its parameters the way Laravel does

`route('crud.show', ['post' => $id])` / `redirect()->route(...)` — the associative form, which
is Laravel's normal one — built the URL positionally. The transpiler emits
`rt.route("crud.show", {"post": id})`, one object in the first slot, and the runtime's `genUrl`
walked the URI's slots whatever it was handed, so a compiled app answered
`/crud/%5Bobject%20Object%5D` where PHP answers `/crud/46`. Found on the live app
(`docs/EVIDENCE.md` finding 1: the `POST /crud` redirect, which is how a form-redirect app
broke).

`genUrl` now follows Laravel 13.37 / PHP 8.3, one probe per rule: a map is matched **by name**,
a list positionally; a map key the URI does not consume becomes a query parameter in map order
(null dropped, `true`/`false` as `1`/`0`, a nested array as `f%5Ba%5D=b`); an absent `{x?}`
drops its segment instead of leaving an empty one; a missing required parameter throws the
framework's own `Missing required parameter for [Route: ...] [URI: ...] [Missing parameter: ...]`;
a parameter is `rawurlencode`d, so `%2F` survives a wildcard; the third PHP argument
(`absolute: false`) answers a relative URL. `compiler/tests/rt-url.test.mjs` pins every line of
that table, and the before/after is one call: old runtime `/crud/%5Bobject%20Object%5D`, new
runtime `/crud/46`. A list with more values than the route has parameters is the one shape
**not** mirrored (PHP answers `/crud/1?2`) — a documented gap, not a guess.

### The live app was run, and the run found four defects

Every claim in this repository had been measured on fixtures, the parity corpus or a probe
worker. On 2026-11-14 a real app (`lw-showcase`, 138 routes, live at `lw-showcase.nietzsc.de`
since 2026-11-13) was swept instead: 92 GET URIs against the deployed worker and against a
local PHP 8.3.30 oracle, a full HTTP auth round trip, a D1 write over HTTP, a build from
current `main`, and `deploy --plan --mode 3`. The record, with the commands and their output,
is `docs/EVIDENCE.md`; the defects are **recorded** here - each fix is its own change, and findings
1 and 2 have landed (the two entries above).

| finding | evidence | status |
|---|---|---|
| `route()` with an **associative** params array answers `[object Object]` (`compiler/runtime/rt-from-context.mjs:1155` is positional; the transpiler emits one object) | `POST /crud` -> `302 Location: /crud/%5Bobject%20Object%5D` on the live worker **and** on a fresh `main` build under `wrangler dev`; the flash text and the log line carry the correct id (`Created post 46`, `crud.store {"id":46}`) | **fixed** - `genUrl` matches a map by name and `compiler/tests/rt-url.test.mjs` pins every measured case (this row was `open`: it contradicted `COMPILED.md:860` (✅) with no test covering named params) |
| a path outside `_routes.json`'s 99 includes is answered by the assets layer, so the 404 has no body | live `GET /nonexistent-route-for-404` -> `404`, **0 B** before the change and `404`, **218 B** after it (byte-identical to `dist/public/404.html`); the app's own 404 and PHP answer the same 218 B | **fixed** - the build writes `dist/public/404.html` from the framework's own 404 render and the scaffolded `wrangler.jsonc` carries `assets.not_found_handling: "404-page"`, the switch that serves it (this row was `open`: the platform's null-body 404 came back for every path outside the include list) |
| prerendered `static` routes answer 307 to their trailing slash | live `GET /architecture` -> `307 /architecture/` -> `200`; PHP -> `200` | **fixed** - every prerendered page is written under both spellings it is reachable as (`about.html` + `about/index.html`, `tools/snapshot-paths.mjs`), so local `wrangler dev` and the live worker answer `/architecture` **and** `/architecture/` with `200`, no `Location` (this row was `open`: one file can only serve one spelling without the redirect) |
| `status` is blind to a deploy it did not perform, and nothing records the source SHA | `status` -> `no deploy recorded` for a live app (`lw-state.json` absent); `wrangler deployments list` -> `Source: Unknown (deployment)` | open - report the case / record provenance |

What the same run **did** verify: build exit 0 (85/86 controllers, 131 routes, 33 views
byte-identical, `READINESS: RUNS ON THE EDGE`), `deploy --plan --mode 3` (zero-mutation,
D1 entry resolved), the auth + session + CSRF + D1 round trip over HTTP, a D1 insert over
HTTP, and 45/92 bodies template-identical after normalising only the origin and the CSRF
token. Not verified, and said so there: `deploy --mode 3` end to end, the CPU numbers for
that app, the `scheduled` handler's effect, `action/verdict`.

### The README was a manual, not an entrance

`README.md` was 840 lines: a reader landing on the package page had to scroll past the CLI
reference, the guided-deploy walkthrough, the build phases, the cache rules and the
operability notes before learning what this is and how to try it. It is now 116 lines and
answers, in order: what it is, the three-command path, the counts, a table of every verb, what runs today, what is refused (each with its escape hatch), the honest limits, where to read next. Nothing was cut - the operator
reference moved byte-identical to `docs/DEPLOY.md`, the file map and the 30-second
architecture to `docs/INTERNALS.md`, the port recipes to `docs/PACKAGE-PORTS.md`, and the
developer story (checkout, suite, `gate:ci`, the checks behind each claim, the full doc map)
is a new `docs/DEVELOPING.md` that the README's *Where to read next* table links, so it stays
reachable from the npm page.

| change | why |
|---|---|
| `README.md`: 840 → 116 lines, user-only; the requirements table and the Cloudflare tiers moved to `docs/DEPLOY.md`, the per-construct detail stays in `COMPILED.md`/`MAP.md` and only an 8-row summary remains | measured: `git show c8d590d^:README.md \| wc -l` = 840, `wc -l README.md` = 116; `docs-counts` keeps every remaining number generated |
| `README.md`: the quick start's preview is `deploy --plan --mode 3 --d1-auto`, and the commands row states that plain `--plan` is mode 1 | measured in a real app: `deploy --plan` alone prints `mode 1 (build only)` / `build would run; --plan does not write dist/` / `state lw-state.json untouched` - no worker, no account, no D1; `--mode 3 --d1-auto` adds all of those and the blocker a real run would hit (`wrangler.jsonc has no D1 entry named "nearfind-db" - refusing to create an unbindable database`) |
| `README.md`: the quick start is the three-verb path (`deploy --plan`, `build`, `deploy`), and a `## The commands` table after the pitch lists all nine public verbs with one line each | `bin/laravel-workers.mjs` passes `--strict` to `build.mjs` itself, so `build --strict` in a README asks the user for a flag that is already implied - and the rewrite had left the quick start with Cloudflare-touching verbs only |
| `docs/DEPLOY.md` (new, 361 lines): CLI, guided deploy, zero-touch/CI, build phases + cache, fullstack, `RUNS ON THE EDGE`, Requirements + tiers | the text is the README's own paragraphs, moved verbatim (LF, no reflow) - a pointer, not a rewrite |
| `docs/INTERNALS.md` (new): `What's inside` + `Architecture (30 s)` | same move; the file map is read by contributors, not by a first-time user |
| `docs/PACKAGE-PORTS.md` (+231 lines): the guard/route/middleware recipes and the ai-sdk + Pulse worked examples | same move; the port recipes belong beside the port catalog they reference |
| `docs/DEVELOPING.md` (new): from checkout, the suite, `gate:ci`, the checks behind the claims, the full doc map, "who reads what" | the developer half had been interleaved with the operator half; one page now carries the contributor path and names `PROCESS.md` first |
| `tools/pack-gate.mjs`: `REQUIRED_DOCS` gains `docs/CI.md`, `docs/PACKAGE-PORTS.md`, `docs/DEPLOY.md`, `docs/INTERNALS.md`, `docs/DEVELOPING.md` | the list exists to catch dead links; five README-linked docs had never been on it (verified: all five ship - 223 files in the tarball) |
| `build.mjs:3592` and `tools/ports.mjs:7`: the two stale port pointers -> `docs/PACKAGE-PORTS.md`, "A guard port, in practice" / "Writing your own port" | measured: `git grep` on `origin/main` finds `(see the README section on guard ports)` and `// Port contract (see README)` in exactly those two lines; that heading sat at `README.md:530` and now lives at `docs/PACKAGE-PORTS.md:176` |

### `lw_oauth_state` rows had no expiry

`kernel/packages/socialite.mjs` calls its state row "short-lived" - the cookie is `Max-Age=600` - but the only
`DELETE` in the repo sat inside `consumeState()`, i.e. delete-on-use. A flow whose callback never comes (a bot
hitting the public `GET /auth/{provider}/redirect`, a closed tab) left its row behind for good, so the table grew
with traffic instead of with live flows. `rememberState` now prunes rows older than the cookie's own window on
the way in, and that window is one constant (`STATE_TTL_SECONDS`) shared by the cookie and the prune so the two
cannot drift.

| change | why |
|---|---|
| `kernel/packages/socialite.mjs`: `STATE_TTL_SECONDS = 600`, and `rememberState` deletes rows older than it | measured: `grep -rn "lw_oauth_state"` across the repo (minus `node_modules`/`dist`) showed the only cleanup was delete-on-use - nothing ever removed an abandoned row |
| `tools/tests/packages-socialite-facebook.test.mjs`: a 601s-old row is gone after the next redirect, a live row survives | the prune is a D1 statement on the redirect path, so it is asserted against the fake engine the suite already runs on |
| `docs/D1-SCHEMA.md`: the `lw_oauth_state` note names the pruning window | the prose is hand-written (the generator only owns the DDL regions), so it was the one place claiming the rows are short-lived |

### The four extra Socialite providers were unreachable

`kernel/packages/socialite-providers.mjs` shipped four complete shape-only providers (azure,
keycloak, cognito, okta) with tests and its own fix entries below - but no request could reach
it. Both socialite ports resolved the provider with `resolveProvider` alone, whose table is
Laravel's own set (github/google/facebook); any other name resolved to `null`, so
`/auth/{provider}/redirect` answered 400 however the app set `AZURE_TENANT` / `OKTA_ORG` / ... .
The module's only importer in the whole repo was its own test.

Both ports now try `resolveProvider` and fall back to `resolveProviderExtra`, so the four
enterprise SSO shapes are servable through the same generic routes - no new route, and the core
table's behaviour is unchanged. The env half of a resolution (`<PROVIDER>_CLIENT_ID` /
`_CLIENT_SECRET` / `_REDIRECT_URI` / `_SCOPES` plus the unconfigured guard) had been written in
both resolvers and now lives once as `providerEnv(env, name, { scope })`.

| change | why |
|---|---|
| `ports/packages/laravel-socialite-redirect.mjs`, `...-callback.mjs`: `resolveProvider(...) \|\| resolveProviderExtra(...)` | measured: outside its own test nothing imported `resolveProviderExtra`, so the four shapes could not be reached by any request |
| `kernel/packages/socialite.mjs`: new `providerEnv(...)` export, used by `resolveProvider` | the same four env reads + null guard sat in two files; the merge rule now lives once |
| `tools/tests/packages-socialite-providers.test.mjs`: two route-level tests | drives the real redirect port with `provider=azure` (302 + tenant URL), and 400 for a name in neither table |
| `kernel/packages/socialite.mjs:9`: "signed-by-randomness cookie" -> HttpOnly random nonce, no MAC | `stateCookie()` emits no signature; the D1 row, not the cookie, is the second check |
| `kernel/packages/totp.mjs:39`: "canonical lower-case output" -> upper-case | observed `base32Encode(...)` = `AEBAGBAFAYDQQCIK`, and the suite pins `/^[A-Z2-7]+$/` |
| `kernel/packages/socialite-providers.mjs`: `mapUserExtra` dropped | 0 runtime callers - the ports map the profile through the resolved provider's `mapUser`; the two tests that only exercised this wrapper now drive `resolveProviderExtra(...).mapUser(...)`, and the unknown-name case is already covered by `resolveProviderExtra`'s own null test |

### Two D1 result shapes the ports read wrong: a 500 and a silent zero

Cloudflare D1's `run()` result is `{ success, results, meta: { duration, changes, last_row_id, rows_read, rows_written } }`
— the counts live under `meta`, exactly as this repo's own normaliser reads them (`kernel/db.mjs`). Two ports
read something else, and every test fake invented that field, so the suites stayed green while production
did not:

- `ports/packages/sanctum.mjs` read `reserved.meta?.lastInsertRowid ?? reserved.lastInsertRowid`. Neither name
  exists in D1's result, so the id stayed `undefined` and the follow-up `UPDATE ... WHERE id = ?` bound
  `undefined` — `POST /sanctum/token` answered **500** instead of `201`.
- `ports/packages/permission.mjs` (4 sites) and `ports/packages/tags.mjs` (2) read `res.changes`, which D1 never
  sends: `POST assign-role` always answered `{ assigned: 0 }`, and attaching tags always reported 0 changes.

Both now use the convention the rest of the fleet already used — `res.last_row_id ?? res.meta?.last_row_id`
and `res?.meta?.changes ?? res?.changes ?? 0`. Found by replacing the hand-written SQLite fakes in
`tools/tests/` with one thin adapter over real SQLite, so a fake can no longer accept a field the engine
does not return.

| change | why |
|---|---|
| `ports/packages/permission.mjs` ×4, `ports/packages/tags.mjs` ×2 → `res?.meta?.changes ?? …` | measured against the D1-shaped result: `assigned: 0` where the suite asserts `1` |
| `ports/packages/sanctum.mjs:114` → `reserved.last_row_id ?? reserved.meta?.last_row_id` | the old names made the id `undefined`; the binding error showed up as a 500 from `POST /sanctum/token` |
| `tools/tests/`: 13 inline fakes + the shared 227-line fake → one 126-line adapter over `node:sqlite` | ~1,600 lines of hand-written SQL parsing deleted; the fake now shares the engine production uses |

### The two unread catalogues leave the shipped package

`docs/PACKAGES-RESEARCH.md` (1,052 lines) and `docs/packages-data-export.md` (134) were hand-written
grep snapshots of the port fleet: no generator, no gate, and no reader anywhere in the repo — and the
second one typed its own test count ("17 tests, 17 pass / 0 fail") while the suite had already grown
past it. `docs/` ships in the npm package, so both moved to `docs/archive/` — the convention
`docs/.npmignore` already applies to `AUDIT-*.md` and `SWEEP-FINDINGS.md`, so they stay in git and
out of the tarball.

| change | why |
|---|---|
| `docs/PACKAGES-RESEARCH.md`, `docs/packages-data-export.md` → `docs/archive/` | `npm pack --dry-run`: **220** files at HEAD with both present, **218** after the move with **0** under `docs/archive/` |
| `CHANGELOG.md`: the "125-package verdict matrix" pointer follows the file | a release note pointing at a path that no longer exists is a dead pointer |

No code, no gate, no test touches either file.

### The broadcasting-auth bodies are one rule, and pusher/reverb answer Laravel's error key

`POST /broadcasting/auth` is a single path that three ports answer — `echo` for a Sanctum-token
client, `pusher` and `reverb` for the platform guard — so the refusals were written three times and
had already drifted: `echo` answered with Laravel's error key (`{"message": …}`, the framework's
`AccessDeniedHttpException` rendering) while `pusher`/`reverb` invented `{"error": …}`; the two hub
ports also hand-assembled the `{status, headers, body}` JSON triple that `jsonResponse()` had
replaced everywhere else, and spelled the `401` out instead of calling `unauthorized()`.

The bodies now live once in `kernel/packages/broadcast.mjs` — the module that already signs the token
for all three. The **order** of the guards deliberately stays with each port (echo resolves its
Bearer token before it reads the body; pusher/reverb check the channel first, the way Laravel's own
`PusherBroadcaster::auth()` does), so what is shared is the bodies, not the sequence.

| change | why |
|---|---|
| `kernel/packages/broadcast.mjs`: `readChannelAuthBody()`, `channelAuthRefusal()`, `channelAuthPayload()`, `CHANNEL_AUTH_REQUIRED`, `CHANNEL_AUTH_NOT_PRIVATE` | six response bodies and three body-parses became three calls |
| `ports/packages/echo.mjs`, `pusher.mjs`, `reverb.mjs`: the guards call them; the raw triples are `jsonResponse()`/`unauthorized()` | one spelling of the route's contract cannot go stale in two of three ports |
| `pusher.mjs`: the `/broadcast` trigger route answers through `jsonResponse()` too | same envelope, same file |
| `docs/PACKAGE-PORTS.md`: the `/broadcasting/auth` row names all three ports and the body contract | the `422` is the ports' own guard — Laravel has no such case |
| tests (`packages-echo`, `packages-search-realtime`): the refusal key is asserted, not just the status | the key was the drift |

Behaviour change (disclosed): the `403` and `422` bodies of `pusher` and `reverb` are now
`{"message": …}` — the key `echo` already used and the key Laravel renders for
`AccessDeniedHttpException`. The refusal **text** stays the ports' own; Laravel's exception carries
none.

Evidence: Laravel's `PusherBroadcaster::auth()` (read from the showcase's `vendor/`) denies a
channel it cannot authorize by throwing `AccessDeniedHttpException`, and adds no `422` case — an
empty `channel_name` takes the same deny path. The signed tokens are untouched: the auth suites
still recompute them with `node:crypto` (`createHmac('sha256', secret)`) byte for byte.

### The `uuid` rule is Laravel's own `Str::isUuid`, and `Str::isUuid()` compiles

`kernel/packages/validate.mjs` — the mini-validator the settings and `spatie/laravel-data` DTO ports
ride — declared its parity target as "Laravel / spatie/laravel-data" but answered `uuid` from its own
regex. That regex was version-restricted (`[1-5]` + variant `[89ab]`), while Laravel's rule is
`Str::isUuid($value, $version)` (Str.php:687-717) and its bare form accepts the canonical dashed
shape with **any** hex in the last two groups: a v6/v7 uuid, the nil uuid, the max uuid and a
variant-0 uuid all validate on Laravel and answered 422 here. `kernel/validator.mjs` already carried
the correct rule, so the rule existed twice, in two semantics — the drift class the build comments
label "two copies drift silently".

The rule now lives once, as `isUuid()` in `kernel/str.mjs`, and the compiled `Str::` subset gains it.

| change | why |
|---|---|
| `kernel/str.mjs`: `isUuid(value, version = null)`, exported, in `str` and `STR_METHODS` | one home for the rule; `str.mjs` is a leaf and both validators already import it |
| `kernel/validator.mjs`: `validateUuid` calls it; the local implementation is gone; `phpIntParam()` is PHP's `(int)` cast for the rule parameter | `$version = (int) $parameters[0]` unless it is exactly `max`, so `uuid:nil`, `uuid:all` and `uuid:foo` all mean version 0 — the old code refused them |
| `kernel/packages/validate.mjs`: `UUID_RE` deleted, `isUuid` imported | the drifted copy |
| `tools/static.mjs`: `StrMethod.isUuid` | `Str::isUuid('…')` folds at build time through the same function, not a second one |
| `COMPILED.md`, `tools/constructs.json`: the `Str` subset names `isUuid` | the construct tables are the shipped surface |
| `kernel/tests/validator.test.mjs`, `compiler/tests/rt-str.test.mjs`, `tools/tests/packages-data-export.test.mjs` | the version matrix (`nil`/`all`/`foo`/`0`/`max`/`4`/`15`/bare, dash-less and upper-case spellings) on the runtime, the rule and the port; the port case is new |

The `email` rule in `kernel/packages/validate.mjs` is deliberately **not** egulias: matching Laravel
there needs the lexer `kernel/validator.mjs` already carries, so the four measured differences
(`a@b` and `user@example` — Laravel accepts a dotless domain; `a@-b.co` and an underscore TLD —
Laravel refuses) are now stated in the module header instead of being implied by a bare regex.

Evidence: `Str::isUuid` and `validateUuid` probed on the showcase's `vendor/` Laravel over a 21-case
rule matrix × 7 version spellings — the port moves from 4 differences to **0**, and all five
Laravel-accepted bare forms (v4, v7, `nil`, `max`, variant 0) pass while the dash-less 32-char form
still fails. The `(int)` cast was probed on 19 strings (`'4.7'`→4, `'1e3x'`→1000, `'0x1A'`→0,
`'nil'`→0), all equal.

### Azure's extra provider fetches the profile from Graph, where the endpoint is

`resolveProviderExtra()` shipped Azure's `userUrl` as
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/openid/userinfo`. The login host has no
userinfo endpoint: both candidates (`…/oauth2/v2.0/openid/userinfo`, `…/oauth2/v2.0/userinfo`) answer
**404**, and the tenant-agnostic discovery document
(`https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration`) names
`"userinfo_endpoint": "https://graph.microsoft.com/oidc/userinfo"`, which answers **401** (it wants
the bearer token). So an Azure sign-in could authorize and mint a token, and then `fetchUser()` in
`kernel/packages/oauth.mjs` 404'd. The Graph URL carries no tenant, so it is a constant.

| change | why |
|---|---|
| `kernel/packages/socialite-providers.mjs`: azure's `userPath` is `https://graph.microsoft.com/oidc/userinfo` | the login-host path 404s, so the profile step could never succeed |
| `tools/tests/packages-socialite-providers.test.mjs`: the azure shape asserts Graph, and the test name says "login endpoints" | the old assertion pinned the 404 |

Evidence: `curl` gave 404 for `/oauth2/v2.0/openid/userinfo`, 200 for `/oauth2/v2.0/authorize` and
`/oauth2/v2.0/token`, 401 for `graph.microsoft.com/oidc/userinfo`; the discovery document supplies the
`userinfo_endpoint` value above. The other three extra providers keep their paths, which match their
providers' documented defaults (Okta's default authorization server is `/oauth2/v1/*`, Cognito's
profile path is `/oauth2/userInfo`, Keycloak's is the realm's `/protocol/openid-connect/userinfo`).

### The FCM port reads the project id from the service account, and Discord's thread target reaches the thread

Two notification ports answered something other than what they (and the docs) said they did:

- **FCM.** `FCM_PROJECT_ID` is documented as optional, falling back to the service account's own
  `project_id` (`docs/PACKAGE-PORTS.md`, `docs/ENV-SECRETS.md`, both file headers) — but the port read
  the env var only and answered **500** with a valid service account that carried a `project_id`. The
  PHP package derives it: kreait's `Factory::getProjectId()` (7.x) is "explicit id → Google credentials →
  `GOOGLE_CLOUD_PROJECT` → `$serviceAccount->projectId` → throw", so an app configured the way the docs
  describe works on Laravel and failed on the edge. The derivation now lives in
  `serviceAccountProjectId()` (`kernel/packages/fcm-oauth.mjs`, using the same raw/base64
  auto-detection as the mint) and the port is `FCM_PROJECT_ID || serviceAccountProjectId(...)`.
- **Discord.** A webhook send put the thread target in the JSON body as `thread_id`. Discord reads
  `thread_id` from the **query string** on execute-webhook ("you must provide either `thread_id` in the
  query string params, or `thread_name` in the JSON/form params" — discord-api-docs
  `developers/resources/webhook.mdx`), so the body field was dropped and the message went to the
  webhook's parent channel. The target is now `?thread_id=`, appended after any query the webhook URL
  already carries.
- A dead `const target = ...` binding in the FCM port (assigned, never read) is gone.

| change | why |
|---|---|
| `kernel/packages/fcm-oauth.mjs` exports `serviceAccountProjectId(raw)` | the service-account blob is parsed in one place already; the helper never throws, so the port keeps its own "cannot determine the project id" guard and a malformed blob still fails louder at mint time |
| `ports/packages/fcm-notification.mjs` derives the id from the env var or the service account | parity with kreait's `Factory::getProjectId()`; the 500 now means "no id anywhere", which is the case the docs call an error |
| `ports/packages/discord-notification.mjs` puts the thread target in the query | the only place Discord reads it; a body field is ignored, so the thread was never targeted |

Evidence: `tools/tests/packages-fcm-webpush.test.mjs` replaces the "missing project id is a 500" pin
(which asserted the divergence, with a service account that *had* a project id) with "with no
`FCM_PROJECT_ID` the service account project_id is used", keeps the no-id-anywhere 500, and adds a
`serviceAccountProjectId` unit test (raw, base64, unreadable); `tools/tests/packages-discord-expo-onesignal.test.mjs`
asserts the webhook URL carries `?thread_id=111` and the body does not, plus a case for a webhook URL
that already carries `?wait=true`.

### A resource's `where` requirements match PHP: the group's map rides along, a chain replaces it whole

`Route::resource()` requirements were scanned on a per-call basis and merged per name, which is
neither of the two things PHP does. Measured on a booted Laravel 13.37 app (PHP 8.3.30) by reading
`$route->wheres` off the router:

- `Route::group(['where' => ['album' => '[a-z]+']], fn => Route::resource('albums', C))` carries
  `{"album":"[a-z]+"}` on **all seven** actions (`albums` and `albums/create` included, whose uri has
  no such segment), while the resource's own `->where([...])` overrides the group per name.
- `Route::resource(…)->where(['album' => '[a-z]+', 'x' => '[0-9]+'])->whereNumber('album')` answers
  `{"album":"[0-9]+"}` — the `x` key is **gone**: `PendingResourceRegistration::where()` assigns
  `$this->options['wheres']` (it does not merge) and every helper routes through that same setter.

The scan dropped the group's map (edge served `/albums/9` where PHP answers 404) and merged a chain
per name (inventing `x`, which made the edge refuse paths PHP answers 200). Both directions are fixed
against the measurements above.

| change | why |
|---|---|
| `registerResource` uses `{ ...g.wheres, ...modifiers.wheres }` as each action's map | `RouteGroup::merge()` carries the group's `where` into the options, and `getResourceAction()` copies it onto every action — the group's map is the base, the resource's own wins per name |
| `collectModifiers` gives each `where`/`whereNumber`/`whereIn` chain step a **fresh** target and keeps the **first** seen (`steps` is outermost-first, so that is the last in source order) | the setter replaces the map; a per-name merge invents requirements PHP never had |
| a resource `->where($name, $expression)` that is not a map is reported through `note()` | `PendingResourceRegistration::where()` takes the array only; Laravel throws `array_merge(): Argument #2 must be of type array, string given` on boot (probed on 13.37), so the route cannot be served unconstrained |
| `whereIn($p, $values)` with a value the scan cannot read is recorded as `''` and said out loud via `warn` | `''` is PHP's value for an empty list and makes Symfony refuse the requirement (the build stops); the alternative — an invented expression or a silent drop — serves paths Laravel rejects |

Evidence: `tools/tests/routes-dump.test.mjs` gains "a GROUP where() applies to a resource inside the
group" and "a resource where() chain REPLACES the map" (both run the scanner, whose fixed output is
the PHP measurement above); the pre-existing verb-chain "last call wins" test still passes, so the
verb path was already correct. `npm test` green with the new cases.

### `parent::class` folds to the parent's FQCN instead of dropping the constant

An app constant written `const P = parent::class;` compiled to a **missing** constant: the constant
path returned `null` for `parent::class` (it looked for a constant named `class` on the parent, the
same miss as #700 for `self::class`), so the constant vanished from the dump and every route reading
it failed loud. Probed on PHP 8.3: `class B extends A { const P = parent::class; }` answers `A` — the
parent's FQCN.

| change | why |
|---|---|
| `evalConstantExpr` (`tools/static.mjs`) resolves `parent::class` to `extendsNameOf()` of the enclosing class | `parent::class` is the parent's FQCN, not a constant *of* the parent; the enclosing class is found through the same `nodeFor` lookup `collectConstants()` walks for inherited constants |

Evidence: `tools/tests/class-constants.test.mjs` ("`parent::class` folds to the PARENT FQCN") passes
`App\Base`; before the change it failed.

### A malformed wrangler config is reported, and a commented-out cron line is not a trigger

The build answers one safety question from the operator's wrangler config: "a route pushes a queued
job — does ANYTHING drain `lw_jobs` at the edge?" Two ways the answer was **silently wrong**:

- TOML was scanned with a regex over raw text, so `# crons = ["*/5 * * * *"]` in a **comment** counted
  as a real trigger and made the build skip the queue check — a job that never runs, reported as fine.
  Measured: the old regex over `[triggers]\n# crons = ["*/5 * * * *"]` answers `["*/5 * * * *"]`.
- A config file that failed to parse (or an unreadable one) answered `[]` without a word, so the queue
  BLOCK blamed "no build-time cron trigger" when the real cause was a malformed file.

| change | why |
|---|---|
| `wranglerCronTriggers()`/`jsoncValue` move to `tools/wrangler-crons.mjs`, and `stripTomlComments()` blanks comments (quote-aware) before the table/array regexes run | a commented-out line is not a declaration; the same module pins both readers with tests, and `build.mjs` reuses `jsoncValue` for its binding check instead of keeping a second copy |
| every failure path (unreadable/unparseable file, `crons` that is not an array) calls `warn(message)`, which the build prints as `  ! …` | a broken config must not be reported as a missing trigger — the file is the operator's to fix, and the message names it |

Evidence: `tools/tests/wrangler-crons.test.mjs` (9 tests) pins the commented-out line, a `#` inside a
quoted string, a `crons` outside `[triggers]`, the malformed-JSONC warning, the non-array warning, the
`wrangler.jsonc`-over-`wrangler.toml` precedence and the no-file case.

### A schedule event that can never fire at the edge reaches the verdict

A schedule event the build cannot express as a Cloudflare cron trigger (an empty / `@alias` / 6-field
expression) is still written to `dist/src/schedule.generated.mjs` — it **ships** — but nothing at the
edge can fire it. That was a bare `console.log`, so `renderReadiness` never showed it: an operator read
RUNS ON THE EDGE for an app whose one scheduled job never runs. It is a DECLARED gap and now reaches
the report the way every other shipped-but-gapped decision does.

| change | why |
|---|---|
| the schedule findings (`notTriggerableFindings`, `shiftedTriggerFindings`) move to `tools/schedule-gaps.mjs`; `build.mjs` calls them | the shapes are pinned by `tools/tests/schedule-gaps.test.mjs`, which the inline `note({...})` blocks could not be |
| the non-triggerable event is `area: 'schedule'`, `severity: DECLARED`, naming the reason and the 5-field-expression fix | the event ships (the HTTP face `POST /__lw/cron` runs it), so it is declared, not blocking — and it has to be visible |

Evidence: `tools/tests/schedule-gaps.test.mjs` pins one finding per gap, the verdict flip
(`RUNS ON THE EDGE` → `RUNS WITH DECLARED GAPS`) and the strategy-keyed fix. A real `--strict` build of
a copy of the oracle app whose schedule is `->cron('@daily')` prints
`! inspire: the cron expression is not a 5-field expression` and the verdict
`READINESS: RUNS WITH DECLARED GAPS` under "declared gaps — your decision, and they ship".


### The config gate sees a `Config::` facade read, so a key the dump does not carry is refused

`Config::get('app.name')` compiles to `rt.config("app.name", null)` — the facade emission carries an
explicit null default (`compiler/src/transpiler.mjs:2550`) — and the gate's literal regex required the
call to END after the string, so **every** facade read slipped past `tools/config-gate.mjs` while the
`config()` helper form was caught. An app whose compiled artifact read a group the dump does not carry
shipped a worker that answered `null` where PHP answers the value: the same silent null, through the
other door.

| change | why |
|---|---|
| `LITERAL` accepts the trailing arguments (`rt.config("x")` **and** `rt.config("x", null)`) by requiring the call to continue with `,` or `)` | that is the shape the facade emission has; a read that is not a plain literal (`rt.config("a".slice(0,1))`, `rt.config(rt.concat("services.", v_k))`) is still not one, and the dynamic form still goes through the prefix check |
| the captured key is unescaped (`\"`, `\'`, `\\`) | the reported key has to equal the key the worker looks up, or the gate names a key that does not exist |

Evidence: `rt.config("mail.mailers.smtp.port", null)` — what `Config::get('mail.mailers.smtp.port')`
emits — matched **nothing** against the old regex and matches now (both run over the same inputs, the
helper form and the dynamic form unchanged); `build.mjs` (`configGateMissing`) turns the key into a
`fail` naming the group, so the shipped answer became a build error instead of a silent null.
`tools/tests/config-gate.test.mjs` pins the scan (facade form, escaped key) and the missing-key answer.

### A `--lock` file pins the app's `require-dev` names, so `composer validate` accepts it

`--lock` wrote `'packages-dev': []` — `resolveDependencies()` walked `require` only, and the header
comment called that by design. On a Laravel skeleton (Pint, Pail, PHPUnit live in `require-dev`) that
made `composer validate` exit **2** with `Required (in require-dev) package "..." is not present in the
lock file.` (audit #805, Composer 2.9.0; re-measured here on Composer 2.9.4 / PHP 8.3.30): a lock file this tool writes, rejected by the
ecosystem it is written for.

| change | why |
|---|---|
| `resolveDependencies(appDir, { includeDev: true })` walks the root `require-dev` as well, and the reachability check uses that same root set (`rootRequire`); the flag defaults to **false** | the install path must never walk — let alone install — a dev closure; only the lock wants it |
| `writeComposerLock(appDir, entries, devEntries)` writes the dev closure into `packages-dev` through the same `lockEntry()` mapper as `packages`, and returns the `require-dev` names it still has no entry for | composer reads both lists the same way; the leftovers are what the caller says out loud, because that failure lands later, in the app's own `composer validate` |
| the CLI `--lock` path resolves the dev closure too (`includeDev`, silent) and drops every name already in `packages` | a package can be a production *and* a dev requirement; it must appear once |
| `readLockPackages()` is untouched — it reads `packages` | the lock now *lists* dev packages; the installed tree must still never contain them |

Evidence: a skeleton-shaped app (3 `require` + 3 `require-dev`) resolved **74 production + 28 dev-only**
packages, and the written lock passes `composer validate --no-check-publish` with **exit 0** and no
`not present in the lock file` line (the same probe exited 2 before this change). The CLI flow itself —
`ensureVendorLite(dir, { lock: true })` on a composer.json-only app needing `psr/log` — writes
`packages=1 / packages-dev=1`, keeps `laravel/pint` out of the vendor cache, and validates exit 0.
`tools/tests/composer-lock.test.mjs` pins the writer: the dev set into `packages-dev`, the production set
into `packages`, `content-hash` over the app's `composer.json`, and a `require-dev` name with no entry
returned to the caller and named inside the lock. `npm test` 2079 tests / 0 fail (54 skipped), the three
new writer tests included.

### A malformed path is a 400 before routing, as `ValidatePathEncoding` answers

Cloudflare does **not** reject a malformed percent-escape: `GET /letters/a%FFb` reached the Worker, and
the compiled side answered the app's fallback with **200** where Laravel throws
`Illuminate\Http\Exceptions\MalformedUrlException` and answers **400** (`Ill.`'s
`ValidatePathEncoding::handle()`: `rawurldecode($request->path())` that is not valid UTF-8). It is the
FIRST middleware of the framework's global stack, so it runs **before** the router — measured on
Laravel 13.37, `GET /nope%FF` is a 400 and not the 404 that path would otherwise get — and before the
session/CSRF layer, so the 400 carries no `Set-Cookie`.

| change | why |
|---|---|
| `kernel/http.mjs` runs the check as the first step of `handleHttp()`, before `installValidation()` and the router match | the middleware is first in the global stack; anything later would answer the fallback/404/route first |
| the path is decoded **byte-wise** by PHP's `rawurldecode()` rule — a `%` NOT followed by two hex digits is left literal — and the bytes are validated as UTF-8 (RFC 3629: no overlong form, no surrogate, nothing above U+10FFFF, no truncated sequence) | that is what `mb_check_encoding($decodedPath, 'UTF-8')` answers. A `decodeURIComponent()` + try/catch check is WRONG: it throws on `/letters/%zz`, where PHP leaves the escape literal and answers the route |
| the 400 goes through the same `renderErrorView` hook as the 405 branch (an `errors/400` view when the app ships one — the build compiles error views it finds — else the minimal page), and an `Accept: application/json` request gets Laravel's `Handler::prepareJsonResponse()` body (`JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES`) | the response is the exception handler's, not a bespoke page |
| `tools/static.mjs` reports `validatePathEncoding` from the app's final global stack (`use()`/`prepend()`/`append()`/`remove()`/`replace()`), `tools/config-dump.mjs` writes it as `middleware.validate_path_encoding`, and the guard is skipped when it is `false` | an app that removed the middleware from its own stack routes such a request; without the flag the edge would answer 400 where Laravel answers the route — a divergence introduced by this change | 

Evidence: PHP 8.3 probes on the oracle app (`rawurldecode()` + `mb_check_encoding()`) fixed the table
`%FF`, `%C3`, `%E9`, `%80`, `%C0%AF`, `%ED%A0%80`, `%F5%80%80%80`, `%FE%FF`, `%F0%9F%98`, `%C3%25A9`
malformed vs `%C3%A9`, `%F0%9F%98%80`, `%41%42`, `%2F`, `%zz`, `%`, `%2`, `café`, `%25FF`, `%2541`,
`%25` valid, and `kernel/tests/http.test.mjs` pins every one of them through the real pipeline (plus the
`Set-Cookie`-free 400 and the JSON body); `tools/tests/middleware-transform.test.mjs` pins the stack flag
for the default stack, `remove()` and `use([...])`. The shadow harness (app `fb5`, rebuilt) replays 11
live requests: **6 malformed paths answer 400 on both sides** (documented divergence: the 400 page is a
framework asset — Ignition in debug, Symfony's page in production — and the compiled side answers its
minimal page, the same rule as the 405) and **5 valid paths are byte-identical**, including `/letters/%zz`
and `/letters/%25FF` (the cases where a naive check diverges). The four earlier batteries are unchanged
(`fb2` 21/22 + 1 documented, `fb4` 22/22, `fb5` requirements 11/11, the redirect battery). `npm test`
2072 tests / 0 fail (3 skipped).

### A route's `->where(...)` requirements reach the Worker — and `Route::fallback()` with them

`route:list --json` prints no requirement at all, and the scan read the verb chain without the
`->where()` chain. The compiled router therefore matched `{id}` with the default `[^/]++` where PHP
requires `[0-9]+`: the edge answered **200** for a path Laravel answers 404 — and, in an app that
declares a `Route::fallback()`, it sent the request INTO the constrained route instead of the
fallback. `Route::fallback()` is exactly `{fallbackPlaceholder}` + `where('fallbackPlaceholder',
'.*')`, so the same missing map left the fallback matching a single path segment: `/nope/deep`
answered 404 where PHP answers the fallback (a route the app believed it had).

| change | why |
|---|---|
| `tools/routes-dump.mjs` reads the requirement chain: `->where($param, $expression)`, the array form, `whereNumber`/`whereAlpha`/`whereAlphaNumeric`/`whereUuid`/`whereUlid`/`whereIn`, `Route::where([...])->get(...)` (a `RouteRegistrar` attribute), a group's `where` attribute in both shapes (`Route::group(['where' => ...])`, `->where([...])->group(...)`), and `->where([...])` on a `resource` (whose map `ResourceRegistrar::getResourceAction()` copies into EVERY action, collection routes included) | the scan is the only source for them; it prints each on the entry as `wheres` (the map PHP's `$route->wheres` answers with) |
| `build.mjs` carries the map onto the route table entry — `wheres` only when the route has one, so an unconstrained app's table is byte-unchanged | the edge matches with the same data the kernel needs, and no empty field appears in the generated table |
| `kernel/router.mjs`: `compilePatternBody(pattern, wheres)` uses Symfony's `RouteCompiler` branch for a constrained variable — `getRequirement()` **replaces** the default class entirely (no separator/possessive logic, which is what lets `.*` span segments), `sanitizeRequirement()` drops an anchoring `^`/`$`/`\A`/`\z` (the surrounding pattern already anchors the path), and `transformCapturingGroupsToNonCapturings()` rewrites a requirement's own groups so they cannot shift the path's captures | a requirement is a per-variable regex, not a hint; `Route::fallback()` only reaches every unmatched path because `.*` is honoured verbatim |
| `build.mjs`: every entry's URI regex is compiled at build time (`validateTable(routeTable)`) and a failure stops the build naming the route | the router compiles a pattern on first use, inside the Worker — an expression JS cannot compile used to throw on EVERY request that reached that route (a 500 discovered in production) |
| `kernel/router.mjs`: a requirement carrying a **unicode property** (`\p{L}+`, `[\p{L}\p{N}]+`, `\P{L}+`) compiles the path regex with JS's `u` flag — PHP compiles every path with PCRE's `u`, so `\p{...}` is a property class there, while JS reads `\p` as the literal character `p` without the flag | measured on the shadow harness (app `fb5`): `->where('name', '\p{L}+')` answered the FALLBACK for `/letters/abc` and `/letters/é` where PHP answered the route — the route was silently dead, not a 500 |
| `kernel/router.mjs`: `validateTable()` also refuses a requirement the JS engine ACCEPTS but reads as something else — `\h`/`\H`, `\v`/`\V`, `\R`, `\X`, `\Q...\E`, `\K`, `\Z`/`\G`, a `\A`/`\z` in the middle of the expression, a POSIX class (`[[:alpha:]]`) | each compiles and then matches a DIFFERENT path (`\h` is horizontal whitespace in PCRE and the literal `h` in JS) — the silent wrong answer; the build stops with the route, the requirement and a rewrite hint named |

Evidence: the scan's `wheres` against a live Laravel 13.37 app's own `$route->wheres` — **50/50
(uri, verb) pairs identical** over 26 URIs (after-verb, array, helper, `whereIn` (the dot stays a
metacharacter), a requirement naming a variable the URI does not use, a literal `{p*}`, both group
shapes, registrar-before-verb, overridden per name, resource maps, the fallback's `.*`). The shadow
harness replays 22 live requests against the real app and the compiled worker: **21 byte-identical,
1 documented divergence** (a `POST` to a GET-only path: both sides answer 405 with the same `Allow`
header, PHP renders the framework's error page and the edge the minimal page — `COMPILED.md`); the
fallback answers `/nope`, `/nope/deep`, `/a/b/c`, `/` and `/deep/one/two/three` on both sides.
`tools/tests/routes-dump.test.mjs` pins the map for every shape (including an empty requirement,
which Symfony itself refuses, so the build stops instead of serving an unconstrained route);
`kernel/tests/router.test.mjs` pins the compiled patterns; `npm test` 2072 tests / 0 fail.

### Route::redirect() answers what Laravel answers, and the route finally reaches the Worker

A `Route::redirect()` route was emitted as an inline handler in `routes.generated.mjs` that
substituted the destination's `{param}`s with `encodeURIComponent`, wrote `''` for a parameter the
destination named but the request did not carry, answered `{status, headers: {location}, body: ''}`,
and — the part that made the route invisible in production — was **never added to
`_routes.json`**. Cloudflare therefore answered the path from the static bundle (there is no such
file: a 404) and the emitted handler never ran. Found by diffing a redirect-only app against a real
Laravel 13 app through the shadow harness, byte for byte.

The handler is now `kernel/redirect-route.mjs`, a transcription of
`Illuminate\Routing\RedirectController::__invoke()` + `Symfony\Component\HttpFoundation\RedirectResponse`:

| change | why |
|---|---|
| `kernel/redirect-route.mjs` (new) answers the route table's `kind: 'redirect'` entries; `build.mjs` emits `(ctx) => redirectRouteResponse(ctx.request, ctx.routeParams, dest, status)` | the destination's own path variables are the only ones substituted (`only($destination->getPathVariables())`), a variable the request does not carry leaves its `{name}` in place and raises `UrlGenerationException` (**500**; the old handler wrote `''` — a silently wrong `Location`), and the value goes through `encodeParameter()` (only `%`, `?`, `#`) plus `strtr(rawurlencode($url), $dontEncode)` over the WHOLE url — so `+`, `@`, `:`, `;`, `,`, `=`, `!`, `*`, `|`, `&`, `#`, `%`, `/` stay literal, `(`/`)`/`'`/space stay percent-encoded, and `encodeURIComponent` was wrong on every one of those |
| the status is the recorded one (`redirect($u, $d, 301)` takes its THIRD argument) and a 301 drops the `Cache-Control` the `Response` constructor injected (`RedirectResponse::__construct`: `301 == $status && !array_key_exists('cache-control', $headers)`) — `kernel/http.mjs` now tracks whether IT injected the default, so an app-set header is never removed | byte parity: the framework's 302 carries `cache-control: no-cache, private` and its 301 carries none |
| the Symfony redirect HTML body (`<!DOCTYPE html>…<a href="…">…`), html-escaped, is emitted instead of `''` | the response body was empty where PHP sends the framework's page |
| the request's query string is still NOT forwarded onto the destination | `RedirectController` substitutes only the destination's own variables; a handler that appended `?x=1` answered a different URL |
| `_routes.json` include rules for `kind: 'redirect'` routes, and a variable inside a segment that also holds text (`/enc-suffix-{id}`) now yields the rule `/enc-suffix-*` instead of the literal `/enc-suffix-{id}` (`tools/routes-json.mjs`) | a rule with a literal `{id}` is matched by no request path, so Cloudflare served the route from the static bundle and the Worker never ran; Cloudflare allows one `*`, only as the last character |
| `build.mjs`: the auth-provider models are dumped even when NO controller compiled | an app whose routes are all redirects/ports/snapshots still authenticates; the strict build failed loud on the missing user model |
| `kernel/router.mjs`: the compiled pattern is Symfony's `RouteCompiler::compilePattern()` transcription (text-and-variable segments, the separator inside the optional group, adjacent variables, `{x?}` runs that nest, duplicate-name refusal, the path preparation `rtrim($path, '/') ?: '/'`) | a segment that mixed text and a variable (`/enc-suffix-{id}`, `/a/{id}-{slug}`, `/{id}.json`) used to compile to a LITERAL, so the route answered 404 on every request PHP answers 200 |

Evidence: a redirect-only app (`Route::redirect`, `permanentRedirect`, a `{param}` destination, a
two-parameter swap, a destination with no leading slash, a variable inside a segment) builds
`--strict` and its emitted handlers answer the PHP oracle on all 64 keys. The shadow harness replays
41 live requests against the real app and the compiled worker: **37 byte-identical, 4 documented
divergences** (each one a path no route matches: both sides answer `404`, PHP renders `errors/404`
and the edge answers the platform's 404 body — a path outside `_routes.json` never reaches the
Worker at all). The router grammar was checked against PHP's own `preg_match($route->compile()
->getRegex(), …)` for **1004 patterns × 60 paths**: 302 of the patterns are ones `RouteCompiler`
itself refuses (a duplicate variable name — the kernel throws the same named error), and of the
702 × 60 = 42 120 comparable pairs **42 061 agree**. All 59 differences are the documented
`{param*}` catch-all extension (Symfony 13 dropped it; the kernel keeps it because compiled apps
use it) — drop those patterns and the battery is **41 880/41 880 with zero divergence**. Two
earlier "divergences" turned out to be an artifact of the oracle: raw `preg_match` keeps an
unmatched named group as `''`, while Laravel's matcher does not (`$router->getRoutes()
->match('/.json')` on `/{id?}.{fmt?}` yields `{"fmt":"json"}`, which is what the kernel answers).
`npm test` 2069 tests / 0 fail (3 skipped; `--fast` 2063 / 0 fail),
`node tools/gate.mjs --strict` PASS, `tools/check-syntax.mjs` PASS, `tools/pack-gate.mjs` OK.

### Webhook signatures: the verifiers can see the raw body again

`kernel/http.mjs` built a `Request` with no raw-body accessor, so
`kernel/packages/port-ctx.mjs`'s `rawText()` fell through to `JSON.stringify(json())` — a
re-serialisation of the parsed body. Every port that verifies a provider signature HMACs the bytes
as they arrived, so on the kernel path (the real one) all five compared against a different
message: **a genuinely signed, pretty-printed payload was answered `401`.** Reproduced with a probe
before the fix (`buildRequest` → `normalizePortCtx` → `mollie-webhook`: raw bytes in, re-serialised
bytes out, `401` on a valid `X-Mollie-Signature`), and the same probe answers `200` after it.

| change | why |
|---|---|
| `Request::getContent()` (`kernel/http.mjs`) — the raw body string, Symfony parity; `text()` as the awaited alias a port written against a fetch `Request` reads | the body was held as a string but never exposed; a provider's signature is over the bytes, not over a parse/stringify round-trip |
| `rawText()` precedence: fetch `Request` → `getContent()` → `text()` → `JSON.stringify(json())` | the old `text() && !json()` branch could never fire on the kernel shape (it has `json()` and had no `text()`), so the fallback was the only reachable outcome |

Affected ports (unchanged code, they already call `ctx.request.text()`): `cashier-stripe`,
`cashier-paddle`, `lemonsqueezy`, `mollie-webhook`, `webhook-client`. Covered by
`kernel/tests/http.test.mjs` (raw bytes verbatim for JSON/form, `''` for GET) and
`tools/tests/packages-mollie-webhook.test.mjs` (a real kernel `Request` carrying a pretty-printed,
genuinely signed body → `200`, while a signature over the re-serialised bytes stays `401`).

This also closes the caveat on the Mollie entry below: that fix made the scheme right, but a real
webhook still could not be verified until the raw body was reachable.

### A security decision read from the request, and a credential check that failed open

Four ports took an authorization/identity decision from request data, or skipped the check they
documented. Each is now decided from server-side state, with the failing-before case pinned by a
test:

| port | what the caller controlled | now |
|---|---|---|
| `apple-signin` | the `id_token` in the callback **form body** — `decodeIdToken(idToken \|\| exchange.id_token)` only base64-decodes (no signature check), so a caller holding any valid `code` could post a token naming another `sub` and be signed in as that account | only the token endpoint's `id_token` is decoded — the TLS channel we opened for that very `code`, and where Socialite's own `AppleProvider` reads it (`getUserByToken($response['id_token'])`). A swapped form token is ignored (`tools/tests/packages-apple-signin.test.mjs`) |
| `scout-algolia` | both credential headers: `if (presentedAppId && presentedAppId !== appId)` skipped the check whenever the header was **absent**, so a caller with no credentials proxied to the metered search API on the worker's own key | `X-Algolia-Application-Id`/`X-Algolia-API-Key` are required and compared constant-time (`timingSafeEqual`); absent or mismatched → `403`, no upstream call |
| `maatwebsite-excel` | the table: `GET /export?table=<anything>` ran `SELECT * FROM <that>` (default `users`), and the route had no caller check at all | table comes from `env.EXCEL_EXPORT_TABLE` (deployment decision, default `users`); the route requires an identified caller (`401` otherwise) |
| `multitenancy` | everything: `POST /tenants` created a tenant and `GET|POST /tenants/{key}` returned any tenant's `data_json`, anonymously | `guardUserId` floor — `401` without an identity, before any D1 read/write. Which tenants a caller may see stays an app-side decision: spatie's schema (and this port's) has no tenant↔user link |

Also recorded, not changed here: `auth0` never validates the OAuth `state` it documents, and
`laravel-socialite-callback` accepts a state from the D1 store when the cookie binding fails —
both need a decision on the state store. (`webhook-client` belonged to this list as well, for
signing a re-serialised body on the kernel path rather than the raw bytes; that turned out to be a
kernel-wide gap, fixed by the entry above.)

### Mollie webhook: the signature check matches Mollie's own, and an unsigned webhook is accepted

`ports/packages/mollie-webhook.mjs` required a signature header that classic Mollie webhooks never
send — its own disclosure said so ("the `X-Mollie-Signature` header is not part of the real
protocol") while the code answered `401` whenever the header was absent. A real Cashier Mollie
webhook (`{ "id": "tr_..." }`, no header) could never reach the reverse-reconcile, so the port was
unusable in production and its "strict superset of Cashier" claim was backwards.

Checked against Mollie's own validator (`mollie/mollie-api-php`, `src/Webhooks/SignatureValidator.php`
+ `docs/webhooks.md`), which says the opposite of the old disclosure and pins the scheme:

| | classic webhook (what Cashier registers) | next-gen webhook |
|---|---|---|
| header | none | `X-Mollie-Signature: sha256=<hex>` (prefix optional) |
| digest | — | `hash_hmac('sha256', $payload, $secret)` → **hex** |
| absent header | legacy webhook — proceed | — |

The port followed none of that: it computed **base64** (so even a genuine next-gen signature would
fail) and treated an absent header as an error. Now: `X-Mollie-Signature` present → compare the
**hex** HMAC-SHA256 of the raw body constant-time (`timingSafeEqual` from
`kernel/packages/webhook.mjs` — the local byte/base64 helpers are gone), `401` on mismatch and `401`
when the header is present but no `MOLLIE_WEBHOOK_SECRET` is configured (an unverifiable claim is
not accepted); absent → continue to the reverse-reconcile, which is the control that actually
confirms the payment. `MOLLIE_WEBHOOK_SECRET` is therefore optional; `MOLLIE_API_KEY` stays
required (`500` without it) because the reconcile needs it.

- Covered by `tools/tests/packages-mollie-webhook.test.mjs` (12/12): hex signature accepted, `sha256=`
  prefix accepted, a **base64** signature rejected, absent header reconciles with and without a
  secret, a present signature with no secret is `401`, wrong signature `401` with no fetch/D1 write.

### Privileged seam routes require an authenticated caller

Three mapped routes have no counterpart route in Laravel — their Laravel side is a library or a
driver that app code calls inside a request the app already authenticated. Exposed as public paths
with no caller check, each was a primitive any anonymous request could use:

| route | what an anonymous caller could do |
|---|---|
| `/model/{modelType}/{modelKey}/roles/assign-role` (`permission`) | grant `admin` to any model key — and every read answered "does model X have role Y" for anyone |
| `POST /broadcast` (`pusher`) | trigger events on any channel, including `private-*`, signing with the app's Pusher secret |
| `POST /webhook-server/send` (`webhook-server`) | sign an arbitrary body with the app's webhook secret (a signing oracle) and POST it to any https host |

App code does not go through these URLs: `compiler/package-bindings.mjs` maps a facade straight to
`rt.<primitive>`, and each port exports the function (`triggerEvent`, `signPayload`, the permission
queries) for in-process use. The HTTP route is a seam for a caller *outside* the app, so it now
requires one: `guardUserId(ctx)` — `ctx.user()` (`kernel/http.mjs`) or a `ctx.user_id` a
`middlewarePorts` guard wrote — and answers `401 Unauthenticated.` with no D1 write, no signature
and no outbound `fetch` when the request carries no identity. A caller-supplied `user_id` in the
body is never accepted, and route params stay data.

`webhook-server` also had the canonical headers last: a caller-supplied `headers` block could
replace `webhook-signature` with a value of its choosing, and a receiver verifying the header (not
recomputing the HMAC) would accept an unsigned body. The extras now merge under the three canonical
headers, so the signature always wins.

`docs/PACKAGE-PORTS.md` gains a *seam routes* section stating the rule and listing the ports of the
same shape that do **not** enforce it yet (`/notify/*`, `mailgun-mail`, `postmark-mail`, `ai-sdk`,
`mcp`, `pulse/record`, `bugsnag`, `maatwebsite-excel`, `glide`) so an app that maps them knows to
put a guard in front.

- Covered by `tools/tests/packages-d-spatie.test.mjs` (permission: read, write and spoofed-body all
  `401` with no D1 row), `tools/tests/packages-search-realtime.test.mjs` (broadcast trigger: `401`,
  no Pusher call, no row) and `tools/tests/packages-webhook-server.test.mjs` (`401` with no fetch;
  forged `webhook-signature`/`webhook-timestamp`/`content-type` cannot replace the canonical ones).

### Broadcast channel auth no longer takes the presence user id from the request body

`ports/packages/pusher.mjs` and `ports/packages/reverb.mjs` answered `POST /broadcasting/auth` by reading the
presence user id out of the caller's own payload — `channel_data` (base64 JSON), a field Echo's client does not
send — and signed it with the app secret. Ran against the pre-fix code with an independent probe: an anonymous
request carrying `channel_data={"user_id":999,...}` came back `200` with that id embedded verbatim, authenticated as
nobody. Both ports also signed a **private** channel for a request with no identity at all, so any caller could
obtain a valid subscription token for any `private-*` channel of the app.

Laravel does not read identity from the request: `PusherBroadcaster::validAuthenticationResponse()` hands
`presence_auth()` `$user->getAuthIdentifier()`, and `Broadcaster::auth()` denies a guarded (`private-`/`presence-`)
channel outright when there is no user. Both ports now resolve the id the same way as the rest of the fleet —
`guardUserId(ctx)` (`kernel/packages/port-ctx.mjs`): `ctx.user()` (kernel/http.mjs) or an id a `middlewarePorts`
guard wrote onto `ctx` — sign with that id, and answer `401 Unauthenticated.` on a guarded channel with no
identity. `channel_data.user_id` is never read.

The same helper absorbs the three copies of this rule that already existed (`passport-oauth.mjs`'s
`resolveUserId()`, `fortify-two-factor.mjs`/`fortify-confirmation.mjs`'s `currentUser()`): one accessor, one place
where "the identity is the guard's, not the caller's" is written down.

- Covered by `tools/tests/packages-search-realtime.test.mjs`: byte-parity HMAC with node:crypto for both ports, the
  guard id embedded when the body carries a different one, and `401`/`403`/`422` for no identity / public channel /
  missing fields.

### Fortify two-factor no longer takes the account from the request body

`ports/packages/fortify-two-factor.mjs` resolved the user for **all four** endpoints from `body.email` and
verified nothing, so an unauthenticated request could rotate (and receive) the TOTP secret and recovery codes of
any account that knew the email, then be answered `authenticated: true` at the challenge. Reproduced with the
port's real default export and an independent RFC 6238 oracle: `200` + secret + 8 recovery codes for an arbitrary
email without credentials.

The port now resolves the user the way Fortify does — the platform's guard (`ctx.user()`, kernel/http.mjs) or an id a
`middlewarePorts` guard wrote onto `ctx` — and answers `401 Unauthenticated.` with no state touched when there is
none. `body.email` no longer selects the account; a missing user is a `401`, not a `404` (which also removed an
email-enumeration oracle).

- Covered by `tools/tests/packages-fortify-2fa.test.mjs` (16/16): the RFC 6238 vectors, the four endpoints as the
  authenticated user, no identity → 401 with nothing touched, and a body email that selects nothing for another
  identity.

### Fortify password-confirmation / email-verification no longer trust the body email

`ports/packages/fortify-confirmation.mjs` took the account from the request in three places: `/confirm-password`
checked `body.password` against `body.email`'s hash (a remote password oracle for any account), `/confirm-password/status`
answered for `?email=…` (existence + confirmation-state disclosure), and `/email/verification-notification` minted a
valid signed verification link for any known email (user enumeration + a working link without owning the mailbox).

All three now act on the authenticated user the way Fortify does — `$request->user()` behind `auth` — via the platform's
`ctx.user()` (kernel/http.mjs) or an id a `middlewarePorts` guard wrote onto `ctx`, and answer `401 Unauthenticated.`
with no state touched when there is none. The body email / email query no longer selects the account, which also
removed the existence oracles. `/email/verify/{id}/{hash}` is unchanged: it is a signed URL, reachable without auth
and bound to the account by the signature + sha1-email hash.

- Covered by `tools/tests/packages-fortify-confirmation.test.mjs` (10 tests): both flows as the authenticated user,
  a body email that selects nothing for another identity, and no identity → 401 with nothing stamped or minted.

### `/oauth/authorize` no longer trusts `user_id` from the query string

`ports/packages/passport-oauth.mjs` took the resource owner straight from the request — `?user_id=…`, else the
client's own owner. Nothing verified the caller, so an unauthenticated request minted an authorization code for any
user id and, through a public (secret-less) client plus PKCE, exchanged it at `/oauth/token` for an RS256 access token
whose `sub` was that user. Reproduced with the port's real default export (an in-memory D1 stub and a real RSA
keypair): `302` + a code stored for `user_id=999`, then `200` with `sub: "999"`.

The port now resolves the caller the way the platform already does — `ctx.user()`, the accessor the Worker hands every
port (`kernel/http.mjs`), or an id a `middlewarePorts` guard wrote onto `ctx` — and answers `401 access_denied` with
**no code stored** when there is none. `?user_id=` and the client-owner fallback are gone: Laravel's endpoint sits
behind the `auth` middleware, and so does this one.

Same file: a malformed `Authorization: Basic` header reached `atob()` outside the handlers' `try`, so `/oauth/token`
and `/oauth/refresh` answered a **500** — attacker-triggerable — instead of `401 invalid_client`; the helper now fails
closed.

- Covered by `tools/tests/packages-passport.test.mjs` (20/20): no user → 401 with no code, `?user_id=999` does not
  authorize, a guard that resolves `null` or throws → 401 (never a fallback), the code belongs to the guard user and
  not the client's owner, an identity a `middlewarePorts` guard put on `ctx`, three cases driven through the kernel
  router's own `dispatch()` (kernel Request whose accessors are methods + `ctxExtra.user`), and the malformed-Basic
  variants.

### Middleware ports — a port that runs *around* a handler

`registry.json` gains `middlewarePorts`: a per-route list of port slugs that run
**before** the route's own handler, on the same `ctx`. A port that returns
`null`/`undefined` continues the chain (it can set state and let the handler
render); anything else short-circuits it. This is the seam for the middleware the
transpiler cannot compile — and the fix for `ports/packages/localization.mjs`,
which could not be installed at all: the only documented slot (`ports`) makes it
the route's *controller*, so its normal pass-through `null` reached the router's
"invalid response shape" and answered **500** (observed in production on
`lw-showcase`).

- `build.mjs` parses the slot, annotates the route table entry and emits the
  ports as `MW <slug>` handlers. A declared route with no request-time handler
  behind it (a snapshot, an unhandled route) is refused: the asset bundle answers
  it before the Worker, so the port would never run — a silent no-op.
- `kernel/router.mjs` runs the chain, then — the part that makes the feature real
  — a resolved `ctx.locale` becomes **that request's** `app.locale` (a shallow
  copy of the config dump, never the shared object an isolate reuses), so a
  compiled controller behind the middleware translates `__()`/`app()->getLocale()`
  in the URL's locale.
- Showcase wiring: `GET /localization` (200, default locale), `GET
  /es/localization` (200, `locale=es`, `app_locale=es`) and `GET
  /en/localization` (302 → `/localization` with `HIDE_DEFAULT_LOCALE_IN_URL`).
- Covered by `kernel/tests/router.test.mjs` (continue / short-circuit / declared
  order / unknown slug / per-request `app.locale` on a copy) and
  `tools/tests/packages-wiring.test.mjs` (the built artifact end-to-end, and the
  build refusal above).

### The package-port fleet expands to 50+ handlers

The `ports/packages/` fleet grew from a handful of broadcast/mail ports to a set
that covers the edge surface a real Laravel app reaches for once it needs
notifications, auth, search, security headers or a headless package backend. Each
port answers one route the build maps through `registry.json`, ships as a single
`ports/packages/<slug>.mjs` file an operator copies into `LW_PORTS_DIR`, and reads
its credentials from Worker secrets (never from the registry) — the route→secret
table and the collision pairs live in `docs/PACKAGE-PORTS.md`.

The new ports:

- **Notifications** — `telegram-notification` (`POST /notify/telegram`),
  `discord-notification` (`POST /notify/discord`), `expo-notification`
  (`POST /notify/expo`), `fcm-notification` (`POST /notify/fcm`),
  `webpush-notification` (`POST /notify/webpush`)
  and `onesignal-notification` (`POST /notify/onesignal`). The FCM port signs its
  OAuth JWT through `kernel/packages/fcm-oauth.mjs`, and the Web Push port builds
  its `Content-Encoding: aes128gcm` payloads through `kernel/packages/
  webpush-crypto.mjs`, so neither depends on a Node-only crypto primitive.
- **Auth** — `jwt-auth` (`POST /auth/jwt/login`, `GET /auth/jwt/user`),
  `firebase-php-jwt` (`POST /auth/firebase/verify`) and `auth0`
  (`POST /auth/auth0/callback`).
- **Headless package backends** — `ai-sdk` (`POST /ai/chat`), `mcp`
  (`POST /mcp`), `pulse` (`GET /pulse` + `POST /pulse/record`), `bugsnag`
  (`POST /bugsnag/notify`), `webhook-client` (`POST /webhooks/{name}`),
  `webhook-server` (`POST /webhook-server/send`) and `site-search`
  (`GET /site-search`).
- **Response shaping and security** — `response-cache`, `csp`, `honeypot`
  (`kernel/packages/response-cache.mjs`, `csp.mjs`, `honeypot.mjs`) plus the
  `seotools`/`gtm` kernel packages (`seo.mjs`, `gtm.mjs`) that render meta tags
  and the GTM snippet the way the vendor packages do.
- **Image and navigation surface** — `glide` (`GET /img/{path}`) and the
  `menu`/`navigation`/`html`/`options` kernel packages (`menu.mjs`,
  `navigation.mjs`, `html.mjs`, `options.mjs`) that turn a Laravel menu or
  navigation tree into the markup the compiled views expect.

The **streaming runtime gap is closed too**: `kernel/packages/streaming-runtime.mjs`
dispatches a route whose handler returns a `ReadableStream` body by piping the
stream through the Workers response instead of buffering it, so a streaming
response no longer falls through to the kernel's "unsupported body" path.

The full 125-package verdict matrix — what is ported, what the framework already
covers, and what stays out of scope — is in `docs/archive/PACKAGES-RESEARCH.md`.

## v0.5.0 — the package-port fleet, a package-aware compiler, route() parity fixes, and the mail/build foundations (2026-11-10)

### `route()` answers an absolute URL for a non-GET name on a shared path

A path carrying two names — the idiomatic `Route::get('/login')->name('login')` plus
`Route::post('/login')->name('login.store')` — used to leave `login.store` out of the
runtime `route()` table. The route scan is deduped per path and the builder took only
the first named verb's name, so a compiled Blade view calling `route('login.store')`
fell through to the build-time URL map, whose value is root-relative (the dev origin is
stripped), and emitted `action="/login"` where PHP emits
`action="http://host/login"`.

Found on a real app's login form (the shadow harness flagged the byte divergence;
`GET /login` went from MISMATCH to match, and the canonical fresh-app run stayed
16/16). The table is now built one entry per NAME across all verbs
(`tools/route-map.mjs` + `tools/tests/route-map.test.mjs`), app-free so it runs in the
app-less `test` job.

### The `@vite` directive emits absolute asset URLs, like PHP

`@vite` renders through Laravel's `asset()`, which prefixes the request's scheme +
host **at request time**. The build bakes the tags without a request host, so the
compiled view carried root-relative URLs (`/build/assets/app.js`) where PHP
emitted absolute ones (`http://host/build/assets/app.js`) — every real app's
first render diverged. `rt-from-context.mjs` now absolutizes the captured
`vite.invoke`/`vite.fonts` HTML with the request's origin (already-absolute and
protocol-relative URLs untouched), so the bytes match PHP.

This was masked for a long time: `kernel/tests/login-flow.test.mjs` died earlier
in the same step on `no such table: posts`, so the asset diff was never reached.

### The login-flow fixture provisions the app's own schema

The Breeze login-flow E2E (`kernel/tests/login-flow.test.mjs`) built its sqlite
from four hand-written tables, so the moment its dashboard queried `posts` both
the compiled rung and the PHP oracle (`tools/php-login-flow-oracle.php`) answered
`no such table: posts` and the step compare turned into a 500-vs-Laravel-debug-
page red that named nothing. Both sides now apply the build's `dist/schema.sql`
(`CREATE TABLE|INDEX IF NOT EXISTS`, idempotent because `dist/schema.sql` already
guards some statements itself, e.g. `lw_blobs`) before seeding the oracle user,
so a real app's login-adjacent routes that touch its own tables render on both
rungs. The HTML body compare also replaces each side's own random CSRF token with
a placeholder (the session id/token shape asserts were already there). The test
now passes against a real app for the first time, and the full suite is green.

### The four methods the mailer refuses are refused by the build the same way

`Mail::raw()`, `Mail::html()`, `Mail::queue()` and `Mail::later()` were refused
in two places that told different stories. The build said the kernel "does not
implement" them, and the kernel did implement them — as a hard failure. An
operator who read the build message looked for a missing feature instead of the
real reason. Worse, the kernel's own `raw()`/`html()` handed the callback a
plain object where Laravel hands it an `Illuminate\Mail\Message`, so the
documented idiom (`Mail::raw('Hi', fn ($m) => $m->to('a@b.co')->subject('S'))`)
threw `TypeError: message.to is not a function` — reachable through a
constructor-injected mailer, which the build did not guard.

There is one source now: `ADAPTER_REFUSED` in `kernel/service-adapters.mjs`
holds the four methods, the kernel fails loud on them with the reason (Laravel
builds the message itself; the worker has no queue consumer), and both build
guards — the facade (`Mail::raw(...)`, `Mail::to($u)->queue($m)`) and the
injected service (`$this->mailer->raw(...)`) — refuse the same four with the
same wording. The supported surface (`Mail::to($u)->send($mailable|$payload)`)
is untouched. `kernel/tests/mail.test.mjs` and
`compiler/tests/mail-refusal.test.mjs` lock it: the refused set equals
`ADAPTER_REFUSED.mail` exactly, the supported call still compiles and is
awaited, and the `log` adapter is not caught by the guard.

### A mailable's public property wins over `with()` — Laravel's `buildViewData()` order

`Illuminate\Mail\Mailable::buildViewData()` starts from `$this->viewData` and
then **overwrites** it with the mailable's public properties, so a property named
like a `with()` key wins. The kernel merged them the other way round, so a
mailable that both declares `public $foo` and calls `with(['foo' => ...])`
rendered the wrong value. The order matches the vendor now (verified against
Laravel 13.37 and locked by a test).

### The login-flow oracle test is deterministic under a warm build cache

`kernel/tests/login-flow.test.mjs` asserts on the build's output, and a build
cache hit prints only `build cache: hit ... dist/ is current` — so the test
failed for everyone on the second run in the same checkout. The fixture build
now runs with `LW_NO_BUILD_CACHE=1` (`app-check.yml` already treated
`--no-cache` as mandatory for the same reason): cold and warm runs both pass.

### A Windows checkout kept CRLF and the corpus byte-compare called it a regression

`.gitattributes` pinned `eol=lf` for `*.mjs`, `*.json`, `*.md` and `*.yml` only, and its
byte-exact rule pointed at `compiler/tests/corpus/expected/**` — a directory that has never
existed (the corpus reads `expectations/`). With `core.autocrlf=true` (the Windows default) a
fresh checkout therefore wrote CRLF into `compiler/tests/corpus/cases/*.php` and into the 55
`expectations/*.txt` fixtures that `run-corpus.mjs` compares with `Buffer.compare`, and
`npm run test:corpus` reported **6/55 pass, 49 fail** — "byte mismatch: expected N bytes
longer", one byte per line — on a commit that was green on Linux CI.

The tree is pinned to LF now (`* text=auto eol=lf`, `*.png binary`, and the corpus rule names
the directory that exists), so a clone, a `git worktree` and CI hand the byte-compare the same
bytes. No blob changed: the history is already LF (`git grep -lI $'\r' HEAD` is empty), so this
is a checkout rule, not a renormalisation.

### A redirect-only app failed `--strict` on every route it served

`Route::redirect()` routes are served by the edge itself (the route table's `redirect` kind), so
the build emits a handler for them instead of compiling a controller. The build-time probe still
answers `302` for each, which lands the route in `needsPort` — the *"no handler, write a port"*
list `--strict` fails on — and the build then removes that finding, because it does emit a
handler. That removal sat inside the controller-compile step, whose cleanup is guarded by
`if (emittedCount)`: an app whose routes are **all** redirects has nothing to compile, so it never
ran the removal and failed the coverage check on every route it served
(`UNHANDLED /old: HTTP 302 -> /new`, `UNHANDLED /u/{id}: dynamic segment — needs a port`). The
failure was conditional on unrelated routes — adding one controller route to the same app made it
build clean — so it read as an app problem rather than a build one.

The removal now runs before the coverage verdict is computed, and the redirect routes are no longer
offered to the controller resolver, which printed a `cannot resolve
Illuminate\Routing\RedirectController via composer autoload` line per redirect that looked like a
gap the build had already covered. The route table's comment about the redirected verbs was
corrected too (every verb gets a handler, `OPTIONS`/`QUERY` included — `redirect()` registers with
`any()`; the extra-verb pass skips the route rather than refusing it).

Pinned by `tools/tests/redirect-coverage.test.mjs`: it builds a redirect-only app (a temp copy of
the CI app with `vendor/` symlinked and `routes/web.php` replaced) and asserts `--strict` exits 0
with `controllers 0`, no `UNHANDLED` line, no `RedirectController` resolution — and then reads the
generated `dist/src/routes.generated.mjs` back to pin the handler contract: `redirect()` answers
`302`, `permanentRedirect()` answers `301` (its third argument, not the word "permanent"),
`/u/{id}` → `/users/42/profile` substitutes from the request's route params, every declared verb
answers the same `Location`, and the destination is emitted raw (Laravel never appends the query
string — that assertion's request carries `?x=1&y=2`, so a handler that forwarded it answers
`/new?x=1` and fails). The test needs an app + PHP, so it skips in the `test` job; `tools/oracle-ran.mjs` runs it
in the job that has one and fails on a skip.

### A package installed after a build was not booted — the scratch provider caches follow Composer now

The build keeps `APP_PACKAGES_CACHE`/`APP_SERVICES_CACHE` inside its scratch dir so that a
developer's `bootstrap/cache/*.php` — built against a `composer install` with `require-dev` — cannot
name providers the composer-free vendor tree does not ship. The cost of that was invisible until a
real app hit it: `PackageManifest::getManifest()` rebuilds the compiled manifest **only when the
file is missing** (`PackageManifest.php:101-113`, the services cache is written the same way), so
the provider list every PHP child boots was decided by an artifact of the *first* build in that
scratch dir, not by `vendor/composer/installed.json`.

Measured on a real app: `livewire/livewire` entered `composer/installed.json` on 2026-11-09 while
the scratch `packages.php` stayed frozen at 2026-11-05 — six providers, no Livewire. That machine
built the app green (`coverage: all 96 route(s) handled`), and the identical sources refused 25
views (13 `LW003`) as soon as the manifest came from a boot that had Livewire in the list. The same
app therefore built differently on two machines, with nothing in the output naming the reason.

`tools/scratch-php-cache.mjs` hashes Composer's identity — the same three files
`tools/build-cache.mjs` hashes: `composer/installed.php`, `composer/installed.json`,
`autoload.php` — into a stamp beside the caches, and `childEnv()` drops `packages.php` and
`services.php` whenever the stamp moved, so the next boot rebuilds them from the vendor tree that
is actually installed. Only the files the build owns are touched: an operator who exported
`APP_PACKAGES_CACHE`/`APP_SERVICES_CACHE` keeps their own. Verified on the app above: the next
build printed `scratch provider cache stale (vendor identity changed) - dropped packages.php,
services.php`, booted Livewire, and the build after that (same vendor tree) touched nothing.
`tools/tests/scratch-php-cache.test.mjs` pins the three cases: a package installed after the first
build invalidates, an unchanged tree does not, and a tree that never had a `vendor/` does not churn.

### Livewire's component-only Blade guards are removed, not compiled

A Laravel app with Livewire installed boots
`Features/SupportMorphAwareBladeCompilation`, whose Blade precompiler
(`config('livewire.inject_morph_markers')` and `config('livewire.smart_wire_keys')`, both true by
default) wraps every conditional and loop directive in a *runtime* guard:

```php
<?php if(\Livewire\Mechanisms\ExtendBlade\ExtendBlade::isRenderingLivewireComponent()): ?>
<!--[if BLOCK]><![endif]-->
<?php endif; ?>
```

`ExtendBlade` sets that flag only between `startLivewireRendering()`/`endLivewireRendering()`, i.e.
only while a Livewire **component** renders — and a component is out of scope by design (its edge
entry is a hand-written port). Measured on a real Livewire 4.4.8 app (PHP 8.3.30): at render time
`isRenderingLivewireComponent()` is `false` and `[if BLOCK]` never reaches the HTML body. So the
edge's reference compile is the compile with those flags off, and removing the guards is
byte-for-byte the same thing: the precompiler only *inserts* the constant strings, it never rewrites
the directive beside them (`crud.show`: guarded 1185 bytes → 918, byte-identical to the flag-off
compile). Left in place they made the build fail twice over — `blade2php diverged from Laravel`
(a BLOCK finding, since `blade2php` compiles the view source and knows no Livewire) and `LW003
unknown class/static Livewire\Mechanisms\ExtendBlade\ExtendBlade::isRenderingLivewireComponent`
when the guarded PHP was handed to the transpiler — which skipped 13 views and, with them, the 12
controllers whose views did not compile: 25 findings from a package the app installed, none of them
about the app.

`compiler/src/livewire-markers.mjs` removes them, and only them: the guard pair must wrap one of the
14 payloads the four emitters can produce (one marker and/or one `SupportCompiledWireKeys` call,
marker first), and anything else is left in place so a future Livewire release keeps failing loud
with `LW003` instead of shipping a body that differs from the reference. `build.mjs`'s
`runViewJobs()` normalizes every `*.compiled.json` in the scratch dir right after each
`compile-view.php --batch`, before any reader compares or transpiles it; the build prints which
files it touched. Verified end to end on the app above once it booted Livewire for real:
`Livewire's component-only Blade markers dropped from 13 reference compile(s)` on both waves,
`controllers transpiled: 85/86`, `coverage: all 99 route(s) handled`, exit 0, no `LW003` and no
divergence. `compiler/tests/livewire-markers.test.mjs` pins the six observed payloads, the unknown
payload that must survive, idempotence and the dump-file walk.

### The sweep's P3 batch (#693–#701) — an enum was not a class, two readers were narrower than Laravel, and the build cache called a gutted `dist/` current

The sweep of `compiler/src`, `tools/` and `build.mjs` (playbook G.10) left six P3
findings and three sweep-level INFOs open. Each one is a place where the build
answered something Laravel does not, in the direction that silently ships the
wrong thing.

**An `enum` was not a class to `parsePhpFile` (#701).** `classes` collected
`class`/`interface`/`trait` only, so `constants-dump.mjs` answered `class not
found` for a real enum while `extractController` had already reported its
alias/FQCN — every route reading `State::DEFAULT_NAME` then failed with a reason
that named the wrong cause, and `COMPILED.md`'s enum claim looked false. PHP
oracle (8.3.30, app autoloader): `class_exists('App\Enums\State')` is `true`,
`enum_exists()` is `true`, and `ReflectionClass::getConstants()` hands back
`Active`, `Inactive` (enum **instances**) plus the real `const`. `tools/constants-dump.php`
keeps only `is_scalar($v) || $v === null`, so its JSON is `{"DEFAULT_NAME":"inactive"}` —
exactly what the JS reader now prints, because it reads the `classconst` node and
the cases are never constants.

**`$this->middleware()` was half-read (#699).** `ControllerMiddlewareOptions`
casts both spellings Laravel accepts — `middleware('auth', ['except' => ['index']])`
and the chained `middleware('auth')->except('index')` — and the values may be a
bare string (`(array) $options['only']`) or several (`func_get_args()`). The
reader only saw an array-literal `['except' => [...]]`, so `->except('show')` was
dropped and the guard was attached to **every** method: a middleware the app
excluded, served. Verified on a real app: `/state` → `["web","throttle:9,1"]`,
`/state/show` → `["web","auth"]`, matching PHP. A `$this->middleware()` nested in
an `if`/`foreach`/`try` still cannot be evaluated, and now **speaks** instead of
being skipped (the guard is then missing, which is the dangerous direction).

**Two accessor maps guessed an ambiguous model alias (#698).** The route path and
the emitted `models` map both refuse an ambiguous short name; the accessor and
policy maps kept whichever `Post` came last, so `$p->published` could be compiled
against the wrong model's casts.

**Two readers were narrower than PHP (#700, #694).** `\App\Enums\Status::class`
in a class constant resolved to a constant literally named `class` (none) and was
dropped, so `public const TYPE = Status::class;` went missing and every route
reading it failed loud; `::class` is now the FQCN, `self::class` the declaring
class, and the declaring FQCN is threaded into the fold (`collectConstants`) so
the constant path answers what the config path already did. In `classes.mjs`,
a negative literal (`-1`, `-'5'`) lost the unary sign the controller path folds.

**Three duplicated copies of a rule (#693, #695, #697).** `constantClasses` lacked
the `alias.replace(/^\\/,'')` + `alias.includes('\\')` pair the sibling mappers
have, so `\App\Enums\Status::ACTIVE` became `App\Http\Controllers\\App\Enums\Status`
and a valid route was refused; `hasBinding()` read `wrangler.jsonc`'s
`queues.producers` as if it were `config/queues.php`; and the numeric-
`throttle:n[,m]` rule existed twice in `build.mjs` (the two copies were already
diverging). Each is one definition now — and the merge had left the audit loop
counting a throttled route **twice** (`throttleRoutes++` on both sides of the
lookup), so the operator's `N route(s) use throttle middleware` note doubled;
the duplicate increment is gone (measured: a probe app with one `throttle:5,1`
route now prints `1 route(s)`, and `dist/src/routes.generated.mjs` carries one
throttled entry).

**A deleted registry module read as "`dist/` is current" (#696).** The three
registry modules (`src/models.generated.mjs`, `src/policies.generated.mjs`,
`src/classes.generated.mjs`) are written inside `if (prepared.length)`, so they
cannot join the unconditional artifact list without forcing a rebuild on every
0-controller app. They are checked separately now — a `dist/src` that exists
without them is a cache MISS, not a clean hit.

`tools/tests/class-constants.test.mjs`, `tools/tests/routes-dump.test.mjs` and
`compiler/tests/classes.test.mjs` pin the enum dump, `::class`, both middleware
spellings, the loud nested form and the negative property default, against the
PHP oracle above. Suite: **1265 pass, 0 fail** (50 skipped, the environment-gated ones), measured with
`env -u LW_LARAVEL_APP node tools/run-tests.mjs` — an ambient `LW_LARAVEL_APP` pointing at an app
turns the oracle tests on and leaves **one** app-shape failure: `login-flow`, whose Breeze steps
assume the app the CI `e2e-fresh-laravel` job builds for it (measured 1311 pass / 1 fail / 3 skip —
before the control fix below it was 1310 / 2 / 3).

### The `#647` control isolates the framework, not the app's own `lang/`

The control in `tools/tests/vendor-dir.test.mjs` asserted `translations == {}` for a vendor-less copy
of the app, reading "no framework" as "no translations at all". `tools/config-dump.mjs:171-176` reads
the app's **own** `lang/` (or `resources/lang`) whether or not a vendor exists — that path needs no
framework — so the control failed for any app that ships translations: measured against a copy of
`lw-showcase`, which answers `['en','id']`. The invariant is now the framework's text: without a
reachable vendor, no locale may carry a `validation.required` **sentence** (the framework's
`validation` group lives under `Illuminate\Translation\lang`, and `FileLoader` merges
framework-first / app-last, so the key echoes itself when nothing is loaded). Measured both ways: the
vendor-less copy answers its own `showcase` group in `en` + `id` with no `validation` group (control
passes, 3/3 with the sibling cases), and adding `LW_VENDOR_DIR` makes locale `en` carry the framework
sentence — the predicate flags it, so the assertion still separates the two states.

### The redirect-only coverage test carries the route policy it declares

`tools/tests/redirect-coverage.test.mjs` builds a temp copy of an app with `routes/web.php` replaced
by three redirects, and the copy kept the source app's `registry.json`. A source app that declares a
`static` entry for a route the copy does not have (`lw-showcase`: `"/architecture": "static"`) made
the build prerender it, fail with `static route /architecture returned HTTP 404`, and never reach
the assertion — the test could not run against any app that uses the feature, which is exactly where
the four traps it locks matter. `registry.json` is now excluded with the other non-source artifacts,
and against a real Livewire/Sanctum app the two tests pass (2/2, 5.4 s), pinning the emitted
artifact: `redirect()` answers 302, `permanentRedirect()` answers 301 from its third argument, a
`{param}` in the destination substitutes from the request's route params (`/u/42` →
`/users/42/profile`), every compiled verb answers the same `Location`, and the destination is
emitted raw (never with the request's query string). `kernel/tests/router.test.mjs:96` already pins
the kernel side (`redirect()` → `302` + `location`, empty body).

### The package ports are proven on the router's `ctx`, not a hand-built one

Every `ports/packages/*.mjs` had a unit test that imported the module and called it
with a hand-built ctx, so "green" proved the handler logic in isolation but not
that it answers on what `kernel/router.mjs` actually passes a route port: the
compiled kernel `Request`, whose accessors are METHODS (`method()`, `pathInfo()`,
`header()`, `json()`), plus `ctx.params`/`ctx.method`. A port reading
`ctx.request.url`/`ctx.request.method`/`ctx.body` as *properties* got `undefined`
and silently used its own default — the trap `kernel/packages/port-ctx.mjs`
(`normalizePortCtx`) exists to close.

`tools/tests/packages-wiring.test.mjs` builds a real app (temp copy, `vendor`
symlinked) with a representative subset wired — `spatie-sitemap`, `spatie-settings`
(`{group}`), `activitylog` (`{id}`), `sluggable`, `spatie-data`,
`scout-meilisearch`, `sanctum` (four routes, one module), `fortify-two-factor`
(four routes, one module) — asserts the build is `--strict` green with 16 ports and
no `UNHANDLED`, then imports the emitted `dist/src/ports/*.mjs` and calls each on
the router's own ctx. It pins the dispatch fix directly: the four
`fortify-two-factor` routes reach four different handlers (`User not found` /
`Two-factor is not enabled` / `... for this account` / `No recovery codes`) where
before they all fell through to `enable`. It skips without a Laravel app, like
`redirect-coverage.test.mjs`; `tools/oracle-ran.mjs` turns that skip into a failure
in the oracle job. The README gains the route-port contract (the accessor-is-a-
method trap, `normalizePortCtx`, the `registry.json` `ports` shape).

The same trap was still live in `ports/packages/fortify-confirmation.mjs`: its
default export switched on `ctx.params.action`, which the router never fills (the
four Fortify routes carry no `{action}` segment), so **all four routes answered
`404 Unknown confirmation action ''`** on a real build — the unit test passed
because it hands the module `params: { action: ... }` itself. It now dispatches on
the request path (`/status` matched before its `/user/confirm-password` prefix) and
the wiring test asserts each route reaches its own handler. Three port headers also
documented registry keys the build cannot accept — `slug:action` values and
`:param` patterns; the build uses the value verbatim as the file name
(`export { default } from '../ports/<slug>.mjs'`) and matches the key against
`route:list`, so both forms fail loud. They now show bare slugs and `{param}`.

`registry.example.json` (+ `docs/PACKAGE-PORTS.md` for the secrets and the one
route collision, `/broadcasting/auth` answered by both `pusher` and `reverb`) maps
the whole fleet: 30 slugs → 61 route paths. Verified by building a temp app with
those 61 routes and all 30 ports wired — `--strict` green, `ports 61`, coverage
`all 61 route(s) handled`.

## v0.4.11 — the line-by-line sweep: an honest `Schema::table` deploy path, Laravel's own FormRequest stub, and PHP's config semantics (2026-11-08)

### The `Schema::table` deploy path is honest now

`dist/schema.sql` is a snapshot of `CREATE TABLE` statements — correct for an
empty database, and unable to add a column to one that already has the table.
That made `deploy --schema=apply`, which `README.md` and `docs/CI.md` offered as
the way out of schema drift, the tool's only silent dead end: on a live D1 the
apply re-runs the CREATEs and fails on the first table that exists, and nothing
in the build said so. The deploy code itself was already honest (it skips the
schema when the D1 has tables, refuses `--yes` on drift, and its help text says
the file is CREATE-only) — the docs contradicted it and the build was silent.

The build now reads the migration files (`mutatingMigrations()` in
`tools/schema-sql.mjs`; the SQLite snapshot cannot tell a later `ALTER` from the
original `CREATE`) and lists the ones that mutate an existing table in the
readiness footer as an ADVISORY line — "worth knowing (n)" — with the manual
`npx wrangler d1 execute DB --command "ALTER TABLE ..." --remote` that a live D1
needs. A green build stays green: a fresh D1 gets the final shape from the
snapshot and has nothing to do. A mutation that lives only in `down()` is not
reported (a deploy runs `up()`), so the framework's own default drops do not
bury the real one. `README.md` and `docs/CI.md` now say what the deploy help
always said: `--schema=apply` is CREATE-only.

### Laravel's own FormRequest stub compiles: the hook's parameters are seeded by position

Laravel's `form-request` generator writes `public function withValidator($validator)`
— no type hint — and the hook body's usual second line,
`$validator->after(function ($validator) { ... })`, has none either. An app
written in that shape failed `LW002` at the class compiler, and until the guard
landed the route around it shipped a handler that answered `500`. The parameter
types were never actually unknown: Laravel calls the hook with the validator it
built, and `Validator::after()` calls the callback with itself. Both are seeded
from those signatures (by POSITION, and only for a `FormRequest`'s
`withValidator` and only when the receiver is a validator the compiled body
already knows — a written type still wins, and a plain class with a method of
that name keeps failing loud).

The release fixture's `HookedPostRequest` now uses the UNTYPED stub form, and
the release gate stays **16/16 byte-identical** with it — the `flag=with-validator`
step exercises the callback body, so the seeded type is proven end-to-end, not
just at compile time.

### An empty resource wrapper is not the same as no wrapper

`ResourceResponse::wrapper()` is `get_class($this->resource)::$wrap`, a bare
property read, so `JsonResource::wrap('')` is a wrapper that EXISTS and is
empty — a different thing from `withoutWrapping()` (`null`). The kernel
collapsed the two, so `wrap('')` answered `data` where Laravel answers the empty
key. Probed against Laravel 13.37 through `ResourceResponse::wrap()`:
`wrap('')` alone → `{"id":1}` (the truthiness test in
`haveDefaultWrapperAndDataIsUnwrapped()` treats it as absent), with additional
information → `{"":{"id":1},"meta":{"x":1}}` (the `?? 'data'` fallback only
fires for `null`), and under `$forceWrapping` → `{"":{"id":1}}` (there the test
is `!== null`). PHP's three separate questions — truthiness, `?? 'data'`, and
`!== null` — are now asked separately.

### The release fixture proves the FormRequest lifecycle — and the build stops when a hook cannot compile

`shadow/fixture-app.mjs` (the app `publish.yml` replays before a tag) had no
FormRequest at all, so the hook lifecycle — `prepareForValidation()` →
`authorize()` → `withValidator()` → `after()` → `passedValidation()` — was never
diffed against real PHP on the release path: the P1 regression that made the
hooks never run (`#873`/`#874`) slipped through a fixture whose only validation
was `$request->validate([...])`, which is a `Request` method, not the trait the
lifecycle lives in. The fixture now carries `App\Http\Requests\HookedPostRequest`
(a prepare hook that merges `Str::slug()`, rules, a `withValidator()` and an
`after()` that each refuse a flag, `authorize()` that denies on demand, and a
`passedValidation()` that merges `passed`) plus its controller and a
`POST /hooked-request-demo` route, and `shadow/scenarios/fresh-app.mjs` walks it
in four steps: 200 with both merged values, 422 with each hook's own message,
and 403 for the denial. Measured: **16/16 byte-identical, coverage 100%**.

Replaying that fixture found the second half of the gap. `build.mjs` asserted
"a hook body the class compiler cannot compile fails that class at compile time,
so no route-level guard is needed here" — it was not true. A FormRequest whose
hook the class compiler refuses (Laravel's own `withValidator($validator)`
shape, without the validator type hint) failed *the class*, and the build still
emitted the route's handler: `rt.formRequest()` could not build the instance, so
EVERY request to that route answered `500 {"message":"Server Error"}` while the
build printed "READINESS: RUNS ON THE EDGE — every route is served by a compiled
handler" and exited 0 under `--strict`. The route now reports the class's own
error: it is skipped with that reason, lands in the partial list (so `--strict`
fails: "BUILD FAILED: coverage check failed"), the readiness line says
"DOES NOT RUN ... no handler", and nothing is written to `dist/`. (The untyped
`withValidator($validator)` shape is no longer one of those refusals — its
parameters are seeded from Laravel's own signatures, see above.)

### Audit hygiene: a stale corpus metric, two dead branches, a tautological test, a doc row

Six small residues of the line-by-line sweep, all internal (no request answers
differ): the corpus manifest claimed 54 bytes for `str-trim-case` while its
expectation is 78 — the only stale entry of the 55 (`#863`); `build.mjs` carried a
`ported` flag that was a literal `false` beside a `continue` that already covered
it (`#871`); `session.test.mjs`'s oracle helper took a `requireApp` option no
caller passed and which precedence made inert (`#869`); the kernel test titled
"the lifecycle runs the hooks in Laravel's order" assembled that order itself,
while the real lifecycle order is pinned in
`compiler/tests/formrequest-lifecycle.test.mjs` — it now pins what the kernel
actually owns, that `fails()` runs the `after` callbacks the request registered
(`#868`); two permanent boundaries reached `COMPILED.md` §6, where the other
fail-loud deviations live: a field named like the error bag's own methods
(`#870`), and the `JsonResponse` subset the response object of a compiled
`withResponse()` carries (`#854`); and `docs/PROCESS.md` §2 listed five of the
six files of the `parity-oracle` job — `tools/tests/routes-oracle-parity.test.mjs`
was missing, so the local mirror looked complete while it was one file short
(`#877`; that file stays out of `npm test` on purpose, because it boots the app).

### A ported guard answers `getLastAttempted()`

PHP records the user a credential check resolved to BEFORE it checks the password
(`SessionGuard.php:328`: `$this->lastAttempted = $user = $this->provider->retrieveByCredentials(...)`;
`:438` for `attempt()`, `:475` for `once()`), so `getLastAttempted()` answers even
when the login failed. The ported guard never assigned the field, so every app
that read `Auth::guard('seal')->getLastAttempted()` — to log a failed login, to
rate-limit by account — always got `null` (#861). The guard now records it:
`once()`/`attempt()` store the user they resolved, and `validate()` accepts the
user object from the port as an alternative to `true` (the port is the half that
knows which user the credentials named, and calling `user(ctx)` here would have
poisoned the per-request memo, turning a failed attempt into a logged-in request).
The port contract in `kernel/auth.mjs` says so. `kernel/tests/auth.test.mjs` pins
both paths.

### A resource's `withResponse()` runs, and `jsonOptions()` reaches the encoder

`ResourceResponse::toResponse()` hands the app's hook the response it just built
(`ResourceResponse.php:46-49`; `PaginatedResourceResponse.php:38-41` runs the same
branch) and passes `$this->resource->jsonOptions()` as the fourth argument of
`response()->json(...)` (`:44`). The kernel did neither: `withResponse()` was
never called, so a hook that adds an API header, rewrites the status or wraps the
payload was a silent no-op (#854), and the JSON flags an app asked for were
dropped (#855). The hook now runs last and receives a response carrying the
`JsonResponse` subset an override actually calls (`header()`, `withHeaders()`,
`setStatusCode()`, `getStatusCode()`, `setContent()`, `getContent()`, `getData()`,
`setData()`), whose methods mutate the same fields the worker reads; the flags go
through the kernel's flag-aware encoder, so a flag the port cannot reproduce
fails loud instead of writing a body PHP never would have. The compiler followed:
`JsonResponse $response` is an allowed parameter, `$response->header(...)` and the
seven other methods compile, the base's UNTYPED second parameter is named by
position for `withResponse` only, and anything else stays an `LW002` build error
rather than a runtime `TypeError`. `kernel/tests/resources.test.mjs` and
`compiler/tests/resource-class.test.mjs` pin the hook, the pretty-printed body
(PHP's own `json_encode($payload, 128)`) and the fail-loud flag.

### A date attribute's dirty check compares PHP's canonical spelling, not the column text

Eloquent runs the date branch of `originalIsEquivalent()` BEFORE the primitive cast
branch (`HasAttributes.php:2403-2405`: `isDateAttribute($k) || isDateCastableWithCustomFormat($k)`
→ `fromDateTime($value) === fromDateTime($original)`), so a column read back as
`2024-01-02 03:04` compares EQUAL to the canonical `2024-01-02 03:04:00` a `set()`
stores — PHP answers `isDirty() === false`. The kernel fell through to the primitive
comparison, saw two different strings, and issued a phantom `UPDATE` plus an
`updated_at` bump on every row whose timestamp column carried second-granularity
text (#845). A date attribute now takes Laravel's branch first: both sides go
through `fromDateTime()`, which also reproduces the two sharp edges — an
unparseable original throws `InvalidFormatException`, and a numeric original reads
as a UNIX timestamp. Probed on PHP 8.3 + 13.37 through the real methods;
`kernel/tests/model.test.mjs` pins clean, epoch and throw.

### `firstOrCreate()` retries a lost race instead of answering 500

`Builder::firstOrCreate()` is `createOrFirst()` (`Builder.php:1392-1405`): a unique
`INSERT` that collides means another request won, so it queries `where(...)->first()`
once more and answers that row, rethrowing only when the where does not match it.
The kernel inserted straight through, so the loser of a race on a unique key
answered a 500 (#846). `firstOrCreate()` now retries once when the driver raises a
unique-constraint violation (SQLSTATE 23000 / `SQLITE_CONSTRAINT_UNIQUE`, matched by
`isUniqueConstraintViolation`) and rethrows the original error when the retry finds
nothing; any other error class still propagates untouched. Probed on PHP 8.3 + 13.37:
`createOrFirst(['slug' => 's1', 'title' => 'second'])` against an existing
s1/first row throws, `firstOrCreate(['slug' => 's1'])` answers the existing row.
`kernel/tests/db.test.mjs` pins both branches.

### `timestamp` casts and `asDateTime()` read a numeric string the way Carbon does

Carbon 3's `createFromTimestamp()` is not an integer cast: it splits the input on
every non-digit/non-dot run and ADDS the chunks (`1e400` → `1 + 400` = 401 s,
`1e10` → 11, `-1e10` → -11), formats a float through `number_format($v, 6)` first
(so `INF`/`NAN` leave no digit and answer epoch 0), and hands the result to
`rawCreateFromFormat('U u', …)`, which throws `InvalidFormatException` once the
second count reaches 15 digits (`100000000000000` throws while `99999999999999`
answers that many seconds). The kernel read a numeric string with `Number()` and
truncated, so `applyCast('1e400', 'timestamp')` was `Infinity` where PHP answered
401, and a 15-digit value raised nothing (`#826`). Probed on Carbon 3 + PHP 8.3
through the real `asTimestamp()`/`asDateTime()`; `kernel/tests/model.test.mjs`
pins the values.

### The policy compiler matches the dumped FQCN, not the first class in the file

A PHP file may legally declare several classes, so the file the policy dump names
can open with a class that is NOT the policy. The compiler took the first `class`
node and compiled it, so the abilities silently ran another class's methods; a file
that declares no class by the dumped name compiled nothing and answered through it
(`#835`). The short name from the dump's FQCN now selects the class, and a file
without it fails the build loud. `compiler/tests/policy.test.mjs` covers both.

### `decrement()` names itself in the non-numeric guard

`Query\Builder::decrement()` runs the same `is_numeric($amount)` guard as
`increment()` with its OWN message — `'Non-numeric value passed to decrement
method.'` (`Query/Builder.php:4537-4544`) — while the kernel threw the increment
text for both directions (a comment asserted the messages were shared; a probe on
PHP 8.3 + 13.37 shows `->decrement('votes', 'abc')` saying "decrement method"). The
guard takes the direction now, and `kernel/tests/db.test.mjs` pins both messages.

### `preventRequestForgery(originOnly:, allowSameSite:)` reaches the worker

Laravel's middleware configurator (`Foundation/Configuration/Middleware.php:605-612`)
sets two STATICS on `PreventRequestForgery` — `$originOnly` and `$allowSameSite` —
which the middleware reads in `hasValidOrigin()` (same-site at :151, origin-only at
:155) and `shouldAddXsrfTokenCookie()` (:205). Both config dumps computed them and
wrote `csrf.origin_only` / `csrf.allow_same_site`, and NOTHING in the runtime read
either key: an app that asked for origin-only verification still ran the token check
and still got the `XSRF-TOKEN` cookie. The kernel applies both flags from the dumped
config now, in the same one-shot place PHP's boot does, so
`preventRequestForgery(originOnly: true)` answers PHP's `OriginMismatchException`
(a 500) on a same-site request instead of a 419, and stops adding the XSRF cookie.
`kernel/tests/http.test.mjs` pins the four outcomes (default refusal, `allowSameSite`
`200`, `originOnly` `500` + no cookie, same-origin unaffected) and
`tools/tests/middleware-transform.test.mjs` pins the app's call reaching the state
that the dump serialises.

### The `_method` override reads the form bag, and `url.intended` follows the referer

`Request::getMethod()` (Symfony http-foundation 7.4, `Request.php:1263-1300`) takes
the override from `$this->request` — Symfony's FORM bag, which only a urlencoded or
multipart body fills — with the query as the default:

```php
$method = $this->headers->get('X-HTTP-METHOD-OVERRIDE');
if (! $method && $httpMethodParameterOverride) {
    $method = $this->request->get('_method', $this->query->get('_method', 'POST'));
}
```

The kernel read `_method` from whatever bag it had parsed — for a JSON request that
is the decoded body, not the form bag — so `Accept: application/json` plus
`{"_method": "PUT"}` (an SPA convention) answered PUT and selected a PUT route where
PHP answers POST and runs the POST one. A live PHP 8.3 probe (13.37) pinned the whole
matrix, and the kernel follows it: the form bag wins over the query, the header
counts only when PHP-true (a `0` header falls through), a lowercase value is
upper-cased, `GET` is an ordinary override, and `InputBag::get()`'s
`BadRequestException('Input value "_method" contains a non-scalar value.')` — a 500
Laravel does not map — is raised for `_method[]=PUT` in EITHER bag. (`_method=""`
leaves PHP with an empty method string whose routing outcome the fixture app cannot
serve, so the kernel keeps its POST for that one case; recorded as a known gap.)

`Redirector::guest()` stores the intended URL through `UrlGenerator::previous()`,
which asks the REQUEST's referer first, then `_previous.url` in the session, then
floors at `to('/')` — and a non-GET request is what reaches that path, because a
routed GET intends its own URL (`UrlGenerator::full()`). The kernel asked the session
first and stored nothing at all when both were absent, so `redirect()->intended()`
fell back to its default instead of the root. `kernel/tests/http.test.mjs` pins both
matrices: four guest cases end to end (the intended URL read back out of the
`sessions` row) and the override table.

### The config-key gate asks the runtime's question, exactly

`rt.config(k)` answers only an exact own key of the dump
(`hasOwnProperty(configCtx, k)`), and the build's gate is meant to refuse a
compiled key the edge cannot answer. It accepted any key whose PREFIX was in the
dump, so `rt.config("a.b.c")` passed whenever `a.b` existed — and a nested group
object (`translations` is dumped whole) hid every key under it. The gate compares
the exact dotted key now, the same question the runtime asks, so those ship as a
build error instead of a 500. A key read through a NON-LITERAL call
(`config('app.' . $x)`) still cannot be checked at build time: the runtime answers
the dump's value, the caller's default, or throws
`config: missing key … with no default` — never a silent `null`, which is what the
stale build comment claimed.

### A bracketed file name is `$_FILES`, and `all()` merges the uploads in

PHP registers a FILE name through the same `php_register_variable_ex()` rule as a
field name, so `name="post[image]"` is `$_FILES['post']['image']` and
`$request->file('post.image')` answers the upload. The parser carried its own walk
whose shape came from the NEXT bracket key, so a map name built `files.post = []`
and the part was dropped: `hasFile('post.image')` was false, `allFiles()` was
`{post: []}`, and a valid form failed `required` (422) or the controller read null
and 500'd. The file tree now goes through the same registration as the fields
(`php-bag.mjs`), measured against a live PHP 8.3 server (`php -S` + `curl -F`, the
real rfc1867 parser): `post[image]` → a map, `a[b][c]` → nested maps, `k[0]` → a
list (`json_encode` emits `[..]`), `x[y][]` → a list under `x`.`y`, `0[]` → the
whole bag a list, and a dot or a space in the BASE name becomes `_` (`a.b` →
`$_FILES['a_b']`, a second silent miss the old walk had). 22 lines of bespoke
bookkeeping are gone.

Three neighbours came out of the same probe:

- `hasFile()` is `array_any(array_wrap($this->file($key)), fn ($f) => $f instanceof
  SplFileInfo && $f->getPath() !== '')` (`InteractsWithInput.php:218-236`), so a map
  answers TRUE where its own values are files (`hasFile('post')` = true,
  `hasFile('a.b')` = true) and FALSE where a further map sits in between
  (`hasFile('a')` = false). The kernel called `isValid()` on whatever came back, so
  `hasFile('post')` for a nested name THREW.
- `all()` is `array_replace_recursive($input, $this->allFiles(), $input)` (:87-105):
  the files merge in recursively and a replaced key keeps its original position, so
  `all()['post']` carries the field AND `post[image]` (`{"title":..,"image":..}`).
  The shallow union answered `{title}` only — the upload vanished from `all()`,
  which is what `Model::create($request->all())` reads.
- The file tree was built with `out[key] = ..`, which SETS THE PROTOTYPE for a field
  named `__proto__` (ordinary data in PHP): the upload disappeared from
  `Object.keys()`. The walk goes through `ownSet` now, and `isBag()` only accepts a
  PLAIN object — a `Uint8Array` inside a bag is a leaf, not a container (its keys
  are `0..n-1`, so the list promotion rebuilt an uploaded file's `bytes` as a plain
  Array and dropped the bytes).

`file()`, `hasFile()` and the input union walk with `data_get()`'s PHP-array rule
(a dotted key descends into a list's index too, `k.0`), which the general rung
reserves for JS arrays. `kernel/tests/upload.test.mjs` pins the tree, the
`hasFile` table, the merge and the `__proto__` case on real request bodies.

### `increment()` bumps `updated_at`, and a text column is PHP's `TypeError`

Eloquent's `Builder::increment()`/`decrement()` (:1392-1412) route the statement's
value set through `addUpdatedAtColumn()` (:1448-1479), so `$post->increment('votes')`
and `Post::query()->where(...)->increment('votes')` both move the row's timestamp
in Laravel. The kernel wrote `SET votes = votes + N` alone — the row kept the old
timestamp while PHP moved it — and its own comment claimed Laravel left
`updated_at` untouched. The Eloquent-side builder adds the timestamp now, gated by
`usesTimestamps()`: the CLASS for a query, the RECEIVING instance for
`$post->increment()` (Laravel's `setModel($this)`), so `$post->timestamps = false`
suppresses the bump exactly as it does in PHP. The raw `DB::table()` builder still
never touches it, and `$extra` columns are honoured (`forceFill($extra)` plus the
SET list) instead of being dropped silently.

The in-memory bump is PHP's own `+`: a non-numeric text column is now a
`TypeError: Unsupported operand types: string + int` (the kernel computed `0 + N`
and wrote the row anyway), with the operand-ordered message PHP produces — the
coercion is the kernel's existing `phpNumeric` canon, so the numeric-prefix warning
case (`'5a' + 1` → Laravel's `ErrorException`) still walks its own path.

Probed on PHP 8.3.30 + 13.37 on real SQLite rows: the class gate, the instance
gate, a caller-supplied `updated_at`, `$extra`, the raw builder and the text-column
`TypeError`. `kernel/tests/model.test.mjs` pins all eight on real rows. Known
remainder (documented, not fixed): the amount itself is still coerced with
`Number()` where Laravel's base builder raises
`InvalidArgumentException('Non-numeric value passed to increment method.')` — see
`notes/PLAYBOOK.local.md` #885.

### `mimes:jpeg` accepts a real JPEG (PHP merges the two names)

`ValidatesAttributes::validateMimes()` adds `jpg` AND `jpeg` to the parameter list
as soon as either name appears, because Symfony's `guessExtension()` answers `jpg`
for `image/jpeg` — so `mimes:jpeg` accepts a JPEG in Laravel. The kernel compared
the parameter list as written and rejected every such upload (a 422 for a valid
file), and both the code comment and the test comment claimed PHP behaved the same
way. The kernel now merges the pair exactly like the vendor, the stale comments
are gone, and the test carries a real 1x1 JPEG fixture (fail-before: one test).

### An API resource's `with($request)` receives the request

`ResourceResponse::toResponse()` calls `$this->resource->with($request)`, but the
kernel's `resourcePayload()` invoked the compiled hook with no argument, so every
`with(Request $request)` override ran with `$request === undefined` (a 500 the
moment it read `$request->path()`). The request is passed through now, and the
compiler test whose name claimed it "takes the request" no longer ignores
`$request` inside its own fixture (fail-before: "Cannot read properties of
undefined (reading 'path')").

### PHP's date grammar: a named month resets the clock, `month year` reads, a wall clock is bounded

`phpRelativeTimestamp()` reads the relative shapes PHP's `strtotime()` accepts;
three families were off (every value below probed against PHP 8.3.30 with a frozen
base):

* a named month with no clock anywhere answers midnight — `june` is June 15
  00:00 and `june 5` is June 5 00:00, not today's 14:30:45; `first day of this
  month` keeps the clock, a named month does not;
* a four-digit year reads: `june 2027`, `26 june 2026`, `2027 june`, `feb 29
  2024` (with or without a trailing clock);
* a WEEKDAY or a day word moves the DAY against the fields the REST of the string
  sets: `monday june 5` is June 8, `monday june 2027` is 2027-06-07, `tomorrow
  june 5` is June 6 — while the clock reset stays where the token sits (`3pm sun`
  is Sunday 00:00, `sun 3pm` is 15:00).

The compact digit runs and bare wall clocks are bounded like PHP's: an hour of 24
rolls into tomorrow but 25 does not read; a minute past 59 does not read (`99:99`
used to compute June 19 04:39); a four-digit run that is not a clock is a YEAR
(`1299` is the year 1299); an `YYYYMMDD` run needs a real month (`20261301` is
unreadable) while an impossible day still overflows (`20260230` is 2026-03-02); a
lone military-zone letter is "now read in that zone" (`b` is now-2h, `n` now+1h,
`j` unreadable). Five rows of the pinned table in `kernel/tests/validator.test.mjs`
carried values PHP never answers (`june`, `5 june`, `june 5`, `december`, `first
day of january`, `b`); they carry PHP's values now, and a new test pins the digit
runs through the `before:`/`after:` path.

Known remainder, left as a documented divergence rather than a half-emulation of
PHP's yacc grammar: the order-dependent compositions PHP refuses (`june 5 noon`,
`june 5 3pm`, `5 june 10:30`, `2027 june 5`) still read, and a negative day/year
number (`june -1`) still does not — see `notes/PLAYBOOK.local.md` (#882).

### A FormRequest hook compiles again — and the build stops refusing it

The class compiler compiles a `FormRequest` subclass like any other app class and
the runtime's lifecycle (`rt.formRequest`) calls its hooks in Laravel's order, but
the build handed the runtime NO hook list: the controller META carried `{rules,
messages, attributes}` only. Every hooked request therefore took the rule-only
path — a 200 where the app's `authorize()` denies (403), a 200 where its
`withValidator()` or `after()` rejects (422), and no `passedValidation()` — and a
second, redundant guard refused the ROUTE first with "the class compiler refuses
FormRequest subclasses" (it does not), so the route was never compiled at all.

`build.mjs` puts `hooks` back into the META, and the `validator()` hook stays the
single refusal — owned by the dump (LW003), which is the code that can see the
app's own factory. The constructs shadow fixture replays all four hooked steps
byte-identical (was five unexplained), and `COMPILED.md` no longer claims the
limit.

### The config fold's `switch` compares with PHP's `==`, and a string offset is a BYTE offset

Two fold answers that differed silently from PHP 8.3's:

* `switch` compared with JavaScript's `==` whenever the caller had not handed it
  a comparison function — and nobody did. So `switch ('') { case 0: … }` took the
  `case` and `switch (null) { case 0: … }` did not, where PHP 8 answers the
  opposite for both. The fold now uses the same `looseEq` canon the expression
  path uses for `==` (`kernel/php-loose-eq.mjs`), imported directly so a caller
  cannot forget it;
* a STRING offset ignored PHP's negative-offset form (`'abc'[-1]` is `'c'`, PHP
  7.1+) and indexed UTF-16 code units where PHP indexes BYTES: on `'é'`, PHP's
  `[0]` is the lone byte `"\xC3"`, which no JS string can carry. Negative and
  out-of-range offsets now answer what PHP answers, and a NON-ASCII string offset
  is refused by name instead of answering a different character (or `''`).

### `LW_VENDOR_FETCH_TIMEOUT_MS` must be a number, and says so

Anything but a positive finite number used to reach `AbortSignal.timeout()`,
which throws a `RangeError` that the download's retry loop read as a transport
failure — three attempts, and the message named a "delay", never the variable.
The value is now validated where it is read.

### A config file the builder cannot execute now fails the build

The build-time config fold (`tools/static.mjs` + `tools/config-script.mjs`)
executes each `config/*.php` and dumps what it answered. Two holes let a
**plausible but wrong** config reach the edge instead of a loud one:

* a `break`/`continue` in a config file escaped the statement walker as a thrown
  `Control` object, so `loadConfig()` reported the group as
  `<file>: [object Object]` and **lost every key of it** with no failure — PHP
  booted with the file's values, the compiled worker with Laravel's defaults;
* a construct the walker does **not** model (`static $n`, `try`/`finally`,
  `foreach ($a as &$v)`, `foreach ($rows as [$name, $n])`, an expression
  statement such as `sort($a)`) left the file's own state already diverged from
  PHP's, and only the single key it fed was dropped.

Now: a refusal in the statement path **poisons the file** — `loadConfig()`
returns an `error` naming the file, the line, the construct and the root cause,
the group is not folded at all, and `tools/config-dump.mjs` **exits non-zero**
(`error` used to be destructured and never read, so a config that failed to fold
silently produced a dump). A refusal at **key** level (`'div' => intdiv(7, 2)`)
is unchanged: it stays a named drop in the fold report, because the documented
contract is that the compiled worker answers `null` for that key.

Three value bugs in the same path are fixed with it, each pinned by the PHP 8.3
oracle in `tools/tests/config-eval.test.mjs`:

* `$a[] = v` on a keyed array took `Object.keys().length` as the new key:
  `['a' => 1, 'b' => 2]; $a[] = 3;` wrote key `2` where PHP writes `0`
  (`nextFreeElement` is the highest integer key + 1);
* `unset($a[1])` on a LIST ran `splice()` (re-indexing every later element) and
  left the key in the `__lwOrder` marker, so a later `$a[] =` wrote the wrong key
  and the dump could carry a phantom `"k": null`; PHP leaves a **hole**;
* `$a['k'] ??= $v` with the key absent fell through to the `??` operator canon
  (no such operator) and refused, instead of assigning the value PHP assigns.

### The build-time config fold is pinned by a PHP 8.3 oracle

`tools/php-funcs.mjs` has always claimed "a function that IS implemented must
answer exactly what PHP 8.3 answers (pinned by `tools/tests/config-eval.test.mjs`
against the PHP oracle)" — and that file, plus the `fixtures/config-eval/oracle.php`
its corpus documents, did not exist. The corpus (189 expressions + 32 named
refusals) had no runner, so nothing pinned the fold at all.

`tools/tests/config-eval.test.mjs` now runs both halves:

* **expressions** — every corpus expression is evaluated by real PHP and by the
  fold, and compared on value AND array key order; every listed refusal is
  checked to refuse *with its reason* (a silent `undefined` cannot come back
  unnoticed). Two expressions answer what the EDGE needs rather than what the
  build host's PHP does (`extension_loaded()` is `false` for every name: the
  compiled rung is JavaScript), and those are pinned explicitly in the corpus as
  `edgeAnswers` — a decision, not an accident;
* **statements** — `fixtures/config-eval/app/` is folded and `include`d by PHP,
  then compared **byte for byte** through the kernel's own `phpJsonEncode()`,
  which covers what a single expression cannot: `$a[] =`, `unset()`, key order,
  loops, closures, `break 2`/`continue 2`.

The PHP half SKIPS with its reason when no `php` is on PATH (`LW_PHP` names one),
so `npm test` stays green on a machine without PHP — and `tools/oracle-ran.mjs`
(which fails on a skipped oracle test) now includes this file, so the
`parity-oracle` CI job runs it for real instead of skipping green.

### PHP 8's operator precedence reaches the APP path, and a declaration is inert

The PHP 8 precedence fix for mixed `.`/`+ -`/`<< >>` chains (php-parser 3.7 still
nests the PHP 7 tree, where `.` bound tighter than `+`) was applied on ONE parse
entry — `parsePhpSource()` — while the paths that actually read an app used a raw
`phpParser.parseCode()`: `loadConfig()` (the config fold), a `require`d config
file, `returnExpr()`, the facade/route scans, and both `tools/routes-dump.mjs`
and `tools/schedule-dump.mjs`. A config file writing `$x = 1 . 2 + 3;` therefore
still folded to the integer `15` where PHP 8 answers the string `'15'` — a
silently wrong value in `dist/src/config.generated.mjs`, with no drop and no
error. `tools/static.mjs` now parses through one `phpParse8()` helper, exports
`renestMixedChains()`, and the two dump tools re-associate their own trees.
Pinned against the oracle by four new fixture cases, including `'a' . 1 << 2`
(`'a4'`; the transpiler refuses `<<`/`>>` outright, so the shift form is
fold-only).

A bare DECLARATION in a config file (`function`, `class`, `interface`, `trait`,
`enum`, or a file-level `const`) used to poison the whole group: PHP registers
the name and runs nothing, but the statement walker refused the statement. A
declaration is inert now — `fixtures/config-eval/app/config/declarations.php`
folds byte-identically to what PHP `include`s — while USING what it declares
still fails loud and by name (`refused-app/config/declared_call.php` reports
`lw_call_helper()`), per the poison rule above.

### A signed number in an app config group reaches the edge again

`tools/static.mjs` (`evalConfigExpr()`) never had a `unary` branch, and
php-parser tags a SIGNED literal as `unary`: `-6.8905` is
`unary('-', number('6.8905'))`, never a `number` node. The value therefore
evaluated to `undefined`, and the array entry around it was dropped by the
evaluator's "never give an unknown expression a slot" rule — the **key**
disappeared from `dist/src/config.generated.mjs` with no note, no warning and no
build failure, while every positive neighbour came through.

A real app hit it: `config/needs.php` carries six `'latitude' => -6.8905…`
values (Bandung is south of the equator), all six were missing from the dump, and
the page died on `Invalid LngLat object: (107.5944, NaN)`. The same hole swallowed
`-12` and an explicit `+6.8905`; only a binary spelling (`0 - 6.8905`) survived.

`evalConfigExpr()` now answers `unary` for `-`, `+` and `!`, mirroring
`evalConstantExpr()`, which has always handled them. The new case in
`tools/tests/env-fold.test.mjs` writes a real `config/demo.php` and pins PHP
8.3's own answers (`-6.8905`, `+6.8905` → `6.8905`, `-12`, and the nested
`latitude`/`longitude` pair); it fails without the branch.

### An unverifiable schema state stops the deploy instead of skipping it silently

A D1 that already has tables was skipped under `--yes` whenever no schema hash
was recorded for it, and a CI checkout never records one: `lw-state.json` is
written by an interactive run, which is why `deploy.yml` reads the D1 id from
`wrangler.jsonc` in the first place. The run printed one informational line,
exited 0, and deployed. When the compiled schema had moved on since that
database was created, the green deploy shipped code whose column did not exist —
the first visitor got a 500, `wrangler tail` reported `outcome=ok`, and nothing
in the workflow pointed at the schema. There is no fallback ledger to check
either: nothing writes the `migrations` table, and `dist/schema.sql` is a
CREATE-only snapshot that cannot add a column to a table that already exists.

`resolveSchemaAction()` now answers `fail/unknown-schema` for that case, so a
`--yes` run (and the reusable workflow, which passes it) **stops with exit 2**
and names both explicit ways on: `--skip-schema` when the D1 is current, or
`--schema=apply` to apply the snapshot deliberately. `--plan` reports the same
stop (`would STOP: the schema cannot be verified`), the interactive prompt is
unchanged, and a workflow that relied on the old silent skip adds `schema: skip`
(its `--skip-schema`). The fake-Wrangler integration suite covers both the
refusal (no config, state or deploy touched) and the `--skip-schema` escape.

### `dist/schema.sql` ships the unique indexes, not just the tables

Laravel's schema builder writes `->unique()` and `->index()` as **separate**
`CREATE [UNIQUE] INDEX` statements, never as constraints inside the table DDL.
`build.mjs` rendered `dist/schema.sql` from the snapshot's `table.sql` alone, so
every deployed D1 got the tables and **none of the indexes**: `users.email` lost
its `UNIQUE`, and nothing said so — the dump line, the READINESS footer and the
deploy all counted tables only. A duplicate email inserted through the compiled
worker would have been accepted where PHP's own database refuses it.

`tools/schema-compile.php` now carries each named index's own statement into the
snapshot (`index.sql`; it was already read for the build-time SQLite sandbox),
and the render moved to `tools/schema-sql.mjs` — tables first, then the indexes
(`d1 execute` runs the file statement by statement, so an index before its table
aborts the apply). SQLite's own auto-index for a `UNIQUE`/`PRIMARY KEY` declared
*inside* the table statement has no SQL of its own and is left out; emitting it
again would fail with `index … already exists`. `tools/tests/schema-sql.test.mjs`
pins both the emission and that exclusion. Verified on the 10-table fixture: 8
index statements (2 UNIQUE) now travel with the 10 tables, and applying the file
to a fresh SQLite creates all of them with no error.

### `array_map()` over one array keeps PHP's keys in the config fold

`tools/php-funcs.mjs` folded `array_map($cb, $arr)` to a plain JS list. PHP
**preserves the source keys** when exactly one array is passed — probed on 8.3.30:
`array_map($f, ['k' => 1, 'm' => 2])` is `{"k":2,"m":4}`, `array_map(null, [5 => 'a'])`
is `{"5":"a"}`, and a mixed array keeps both the `0` and the string key in PHP's
order. An associative config array folded through `array_map` therefore reached
the edge **re-keyed** (and `array_map(null, $a)` renumbered a sparse one) with no
drop and no error. It goes through the same `listOrObject()` idiom
`phpArrayFilter()` already used; five corpus expressions pin the value and the
key order against the PHP oracle.

### A shell-shaped `LW_APP_ROOT`/`PHP_BIN` no longer dumps an empty artifact

`tools/config-dump.mjs`, `tools/php-runtime.mjs` and `tools/vendor-lite.mjs`
normalised the Git-Bash/MSYS path form (`/c/Users/me/app`) since #401/#417, but
the other entry points that take `LW_APP_ROOT` read it raw: `join('/c/Users/me/app',
'artisan')` resolves to `<cwd-drive>:\c\Users\...`, `existsSync` says no, and the
dump came out **empty with exit 0**. Probed live before the fix on
`tools/class-dump.mjs` — the same command with the native spelling printed the
full class dump, the POSIX spelling printed `{"classes":{}}` and exited 0.

One shared helper (`tools/native-path.mjs`) now does the mapping for every
consumer — `class-dump`, `constants-dump`, `event-dump` (positional *and* env),
`model-dump`, `policy-dump`, `routes-dump`, `schedule-dump`,
`ascii-map-check`, `facade-count-check`, `validation-messages-check` — and the
three tools that carried their own copy now import it. `/cygdrive/c/...` (MSYS2
with the cygdrive prefix) is folded too, and `PHP_BIN` gets the same treatment in
`check-syntax`, `make-html-entities`, the two oracle checks and the `verify`
command, where a POSIX `PHP_BIN` used to die on `spawnSync ... ENOENT`.
`tools/tests/native-path.test.mjs` pins the mapping and the app-root resolution.

### The pack gate walks the import graph instead of a remembered list

`tools/pack-gate.mjs` asserted that a hand-written 23-entry list was in the
tarball. That list was **not closed under the import graph**: the two entry
points the package actually runs (`build.mjs` and `bin/laravel-workers.mjs`)
reach 61 modules, 38 of them unlisted, so the check could only ever confirm what
somebody had already remembered. A module the build imports but
`package.json.files` excludes would have shipped as a `MODULE_NOT_FOUND` in a
real app — the failure the gate exists to prevent.

The gate now derives what it checks: it walks relative imports and `require_once
__DIR__ . '/x.php'` from the entry points, follows the files those name as
literal `join(pkgDir, …)` paths (the PHP helpers and dump scripts the build
spawns, and `src/worker.mjs`, which it copies), and requires every file it
reaches — **104** of them today, up from 23 checked entries. Two rules keep it
honest: a path anchored on the user's app (`join(appDir, …)`) is not this
package's file, and a path inside an `existsSync()` probe is deliberately
optional (deploy and doctor run their fixtures only when the repo has them).

Evidence of the hole, on one tarball with `"!tools/order-json.mjs"` added to
`files`: the previous gate printed `pack-gate OK: 23 build/CLI modules … shipped`
and exited 0, the new one fails with `tools/order-json.mjs (loaded at runtime)`
— a module `tools/config-dump.mjs` imports and the build spawns.
`tools/tests/pack-gate.test.mjs` pins the walk, its two rules and the paths it
must reach in this repo.

## v0.4.10 — a rendered view fetches its stylesheet from the app, and the brand surfaces go live (2026-11-06)

### A view rendered per request fetches its stylesheet from the app again

A compiled view's captured context kept the origin the build boots it with:
`compile-view.php` runs the app on host `localhost`, so `@vite()` output and the
precomputed `url()` entries landed in `dist/src/contexts/*.mjs` as
`http://localhost/build/...`. Prerendered snapshots already went through
`relativizeSnapshotUrls()`; contexts did not, so every view the worker renders
per request asked the visitor's own machine for its CSS and shipped unstyled.

`relativizeContextJson()` now applies the same rewrite to the serialized
context, and all four writers that emit one — route views, error views, the
manifest clone, and the dependency walk — go through it. Verified on a compiled
app: the worker emits `/build/assets/…` and the page renders styled on the edge.

### Brand — the README badge row states the verdict

The shields snippets were documentation only; the badge row now carries
`verdict | RUNS ON THE EDGE` in the brand's `shore` green, linking the CI
contract. Repo metadata (description, homepage, 16 topics) and the social
preview are set, and the surface list in docs/BRAND.md records where each one
lives.
### Brand — one source for the mark, and the CLI wears it

The mark, palette, voice and surface list now live in **docs/BRAND.md**;
`docs/CI.md` §Brand keeps only the reporter facts and links to it, so a colour
changes in one commit, not five. The pack gate requires the file (a dead link
in the npm page is a bug), and the README points at it from the CI and Docs
sections.

`laravel-workers --help` and `--version` show the mark (Laravel red stem,
Workers orange arrowhead) **only for a human**: a pipe, `NO_COLOR`, or a dumb
terminal gets the plain one-line output, so `--version` stays machine-readable
and byte-stable for scripts. `FORCE_COLOR` overrides either way. The help text
itself is still generated in one place.
### Brand — Verdict wears the project mark, and can post as your app

The reporter now opens every comment and job summary with the laravel-workers
mark (`docs/logo.png`, 20 px) instead of an anonymous green check, so a build
comment in an app repository is recognisably the tool that produced it. The mark
sits after the `<!-- verdict -->` marker, which the sticky lookup matches from
the start of the body — reordering those two lines would silently turn every
update into a new comment.

Posting as **your own GitHub App** is now opt-in rather than absent: `verdict`
takes an optional `token`, `app-check.yml` takes an optional `app-id` and mints
an installation token with `actions/create-github-app-token`, and `docs/CI.md`
carries the five-step recipe (permissions, private key, secret, caller). A fork
pull request never receives the app token — it carries write — so the comment
falls back to `github.token` there. No app configured means no secret and no
install step; the mark is still there.
### Brand — the mark is the Laravel L, its foot ending in an edge arrow

`docs/logo.svg` (+ `.png`) is the project mark, and `docs/banner.svg` /
`docs/social-preview.svg` now carry it next to the wordmark. The palette is the two
brands the tool joins, and nothing else: Laravel `#ff2d20` at the stem (the PHP side),
Cloudflare Workers `#f38020` at the arrowhead (the edge). The hero keeps the warm
radial wash and the red→orange top rule; the gradient runs `#ff2d20 → #ff4f20 → #f38020`,
so the old cyan (`#38bdf8`) is gone. Marks are re-used as transformed groups rather
than redrawn, so the logo and the hero cannot drift.

### CI — Verdict, the reporter for `READINESS`, and the official app workflows
`build --strict` says whether the app compiles; it does not say which routes are
served and which gaps ship. `action/verdict` turns the build log into one sticky
PR comment and the job summary (fork-safe, exit 0, gaps never hidden), and
`docs/CI.md` documents the contract with copy-paste `ci.yml`/`deploy.yml` plus
the optional `app-check.yml`/`app-deploy.yml` reusable workflows. Neither deploy
path runs composer: vendor-lite provisions from `composer.lock`; composer is
kept only where PHPUnit (require-dev) runs. The traps that
break a deploy silently are named there: `--no-cache`, a valid random `APP_KEY`,
`APP_URL` baked at build time, `CACHE_STORE=file` turning the login throttle
fail-open.

### Fix — `+build` metadata hid a prerelease's stability
`stabilityOf('1.0.0-rc1+build')` answered `stable`: the modifier regexes are
end-anchored and the build metadata sits after the tag, so vendor-lite could
accept an RC where Composer's `minimum-stability` refuses it. Composer's
`VersionParser::parseStability` answers RC; the metadata is now stripped before
the modifier is read. Probed: a 19-version matrix (tagged, prerelease, branch,
build metadata) matches Composer after case-normalisation.

### Fix — one "cannot resolve" line per route, not per verb
`Route::redirect()` expands to five compiled verbs, and the controller pass
printed the same `cannot resolve Illuminate\Routing\RedirectController` line
once per verb: one gap read like five. Deduplicated by (route, class). Measured
on a probe app: 5 identical lines -> 1; the readiness block is unchanged (it
still names the route's verb gaps).

### Fix — a changed binding replayed a stale verdict
`wrangler.jsonc` (where the D1/R2/QUEUE bindings the verdict reads live) was not
part of the build cache key: adding a `queues.producers` binding still answered
"cache hit, dist is current" and printed the OLD verdict ("binds no QUEUE
producer"). Measured with `computeBuildCacheKey` on a two-file app: identical
keys before and after the binding. The key now hashes `wrangler.jsonc` and
`wrangler.toml`, with `tools/tests/build-cache.test.mjs` as the regression test.

### Fix — a cache hit hid the verdict from the log
`build` exits early on a cache hit; the early return skipped the `READINESS:`
block, so the log a CI reporter reads carried no verdict at all — a green build
with declared gaps looked like a green build with none. The stamp now stores the
rendered verdict and the hit prints it (older stamps print a one-line hint).
Measured on nearFind: forced build and cache hit now both print
`READINESS: RUNS WITH DECLARED GAPS` with the same gap list.

### Fix — four divergences the second differential sweep found
- `Collection::sortBy()`/`sortByDesc()` on a LIST dropped PHP's keys: PHP
  `collect([3,1])->sortBy(fn ($v) => $v)->all()` is `[1 => 1, 0 => 3]` (a keyed
  array — PHP arrays always carry keys), the edge answered `[1, 3]`. The old
  test pinned the wrong shape; both were corrected against the vendor probe.
- `Collection::nth()` below step 1 threw a bare `Error`; PHP throws
  `InvalidArgumentException` (the class reaches `catch` and the error page).
- `Str::replace()` was a plain split/join: `str_replace()` semantics (array
  search/replace, a short replace list filling `''`, the `$caseSensitive`
  argument) silently produced a no-op — `replace(['a','b'],['x','y'],'ab')`
  answered `ab` where PHP answers `xy`.
- Snapshot rewriting missed JSON-escaped URLs (`json_encode` writes `\/`, so
  `{"u":"http:\/\/localhost\/masuk"}` shipped a localhost link) and origins
  authored in caps; both are relativized now (`\/masuk`, `/masuk`).

Probes: 99 collection expressions + 51 validator cases + 20 JSON-flag sets
against PHP 8.3 and vendor Laravel 13.37 (scripts under the audit workspace).

### Fix — a stale `bootstrap/cache/packages.php` broke the composer-free boot
A developer's `composer install` writes `bootstrap/cache/packages.php` naming
require-dev providers (measured: `Laravel\Boost\BoostServiceProvider`). Building
that app through vendor-lite then died in `PackageManifest` because the named
class was never provisioned — and the message pointed at Laravel, not the stale
file. Every PHP child now keeps its package/services caches in
`<app>/.cache/laravel-workers/php/` (relative paths: Laravel treats only `/` and
`\` as absolute prefixes), so the build neither reads nor writes the app's own
`bootstrap/cache`. Verified: vendor removed + a Composer-written packages.php →
build renders again; the app's file is left untouched.

### Fix — a bare snapshot origin shipped `http://localhost`
`route('home')` renders against the prerender request host, i.e. `http://localhost`
with no path. The rewrite that makes snapshot origins relative required a trailing
slash, so the root URL survived verbatim: on the deployed worker "back to the map"
opened `http://localhost/` (reproduced on nearFind's `/masuk` and `/` snapshots).
The pattern now matches a bare origin at a boundary (`/`, quote, space, tag) and
rewrites it to `/`; paths keep exactly one slash. The pattern moved to
`tools/snapshot-urls.mjs` and is covered by `tools/tests/snapshot-urls.test.mjs`.

## v0.4.9 — guard ports, the nearFind audit's eleven gaps, and the live HTTP context in a view's runtime (2026-11-04)

Compiling a real app's profile page (the nearFind audit) surfaced eleven gaps. The
proof is the same app under the shadow harness: `/masuk` (port) + `/profil` (GET and
PUT, compiled) are now **5/5 byte-identical, 100% coverage** against PHP 8.3.

This is the first release after 0.4.8. The guard-port work (2026-11-03) and the nearFind
audit wave (2026-11-04) both ship here; their notes are kept as the two `###` waves below
because they were written as they landed.

### Fix — every fresh vendor-lite provision died with a ReferenceError (#750)
`tools/vendor-lite.mjs` computed `installedJson` inside `ensureVendorLite`'s scope but wrote it from
`provision()` — a separate function — so the manifest line answered `ReferenceError: installedJson is
not defined`. That is the "no `vendor/`, no `composer install`" path the README advertises (Composer:
"none — vendor-lite provisions deps"): a real app with no `vendor/` (an isolated copy of the nearFind
branch, PHP 8.3.30) answered `BUILD FAILED: vendor provisioning failed: installedJson is not defined`
and `READINESS: DOES NOT RUN`, and `vendor:ensure` could never fill a cold cache. Measured: with the
fix that same app provisions the tree and the build proceeds (routes, config, schema, snapshots).
The suite never saw it because every CI app comes from `composer create-project`, which always leaves a
`vendor/` behind — the new case in `kernel/tests/vendor-lite.test.mjs` drives the cache-MISS path
offline (the package dir is seeded as already extracted, so nothing is downloaded): **1/1 fail before
the fix, 9/9 pass after**.

### Fix — the framework-only allowlist pointed at a doc that does not state it (#749)
The comment above `FRAMEWORK_ONLY` (`tools/tests/routes-oracle-parity.test.mjs`) said
the two rows (`up`, `storage/{path}`) are "named in `docs/AUDIT-REAL-APPS.md`", but that
file mentions neither the list nor the routes — `grep -ri health docs/` answers nothing.
The allowlist and its reasoning live in the test and in `CHANGELOG.md` (0.4.7, "#628 —
the scan is now proven TOTAL"), so the comment points there now. Found while answering
why a real app's `GET /up` is a declared gap: a reader following the old pointer had to
re-derive the answer from the framework source.

### Fix — a view's `session('k')` answered the session STORE, not the value (#736)
The view-mode helper emission was `rt.session("k")`, and `rt.session()` takes no
argument: every `@if (session('status'))` was truthy and `{{ session('status') }}`
printed `Object`. The helper is Laravel's `session()->get('k', $default)` — the view
now compiles to exactly that (the bare `session()` still answers the store).

- **Test.** `compiler/tests/rt-blade.test.mjs`: the emitted shape.

### Feature — `@method` / `method_field()` compiles (#737)
`@method('PUT')` compiles to `method_field('PUT')`; the helper was unknown (LW001), so
any form that spoofed a verb failed the build. It now answers Laravel's exact bytes
(`<input type="hidden" name="_method" value="PUT">`, no `e()` — `Foundation/helpers.php:594`).

- **Test.** `compiler/tests/rt-blade.test.mjs` (bytes, three verbs), `controller.test.mjs` (emission), `ctx-gated-helpers.test.mjs` (the known-helper set).

### Fix — every view with `@error` was uncompilable, then unrenderable (#738)
Two gaps stacked: the compiled `@error` block ends with `unset($__errorArgs, $__bag)`
and the transpiler refused the `unset` STATEMENT (so the view did not compile); and
`$errors` was never shared into the view (so the compiled `$errors->getBag('default')`
would have crashed at render). `unset($a, $b)` now clears a plain variable (`isset()`/
`??` follow PHP; an element/property unset stays refused), and `rt.view()` shares the
session's `ViewErrorBag` exactly like `ShareErrorsFromSession` — new
`kernel/view-error-bag.mjs` (MessageBag + ViewErrorBag, Laravel's read surface).

- **Test.** `kernel/tests/view-error-bag.test.mjs`, `compiler/tests/rt-blade.test.mjs` (the unset cases).

### Fix — a model date lacked `locale()`/`translatedFormat()` (#739)
`$model->created_at->copy()->locale('id')->translatedFormat('j M Y')` — the shape every
Blade date cell uses — died on the compiled side: the model's date value carried
`format()`/`toDateString()` only, and the runtime's Carbon wrapper had its own month
tables. One shared table (`kernel/date-names.mjs`), and both date values now answer
`locale()` (per instance) + `translatedFormat()`. Probed on PHP 8.3:
`20 Okt 2026`, `Selasa, 20 Oktober 2026`, `Sel`, and English without a locale.

- **Test.** `kernel/tests/model.test.mjs`.

### Fix — a zero-argument accessor was not dumped (#740)
`getInitialsAttribute()` with no parameters is a legal Eloquent accessor
(`hasGetMutator()` only checks the name; PHP accepts the extra argument), but the dump
required exactly one parameter, so the compiled model refused the attribute at request
time. The dump accepts 0 or 1.

### Feature — `registry.json` `"config"` declares the app groups the edge carries (#741)
The runtime config dump is a curated set (framework keys), so `config('needs.categories')`
answered `null` on the edge where PHP answered the value — a silent divergence with no
compile error. `registry.json` → `{"config": ["needs"]}` dumps the group tree, and after
compiling the build REFUSES any `config('<key>')` the dump cannot answer (naming the
group to declare). Only public data belongs there; a credential stays a Worker binding.

- **Test.** the nearFind shadow scenario exercises it (`config('needs.categories')` in a
  compiled controller); a missing declaration fails the build with the fix named.

### Fix — a request-state `rules()` was evaluated at build time (false 422) (#742)
`Rule::unique('profiles','username')->ignore($this->user()->id)` was evaluated by the
FormRequest dump with NO request, so the rule string became `unique:profiles,username,NULL,id`
— `id <> NULL` matches the row itself and **rejects a valid update**. The dump now
refuses a `rules()` that reads `$this`/`$request`/`auth()`/`user()`/`request()`: static
rules (plus a controller-side check) compile, anything else is a port.

### Fix — a FormRequest hook was accepted at build time and answered 500 at runtime (#743)
The dump listed `authorize()` (and the other hooks) so the compiled lifecycle would call
them — but the class compiler refuses FormRequest subclasses, so the build shipped a
handler whose first request died with "the class is not compiled". The route is now
refused at build time with that reason: `authorize()` returning `true` is Laravel's
default (drop the boilerplate), a real hook needs a port.

### Fix — `rt.formRequest()` for a rule-only FormRequest (#744)
Three runtime assumptions broke a FormRequest with no hooks: it instantiated the class
(unnecessary — the rules arrive inline), and it called `setValidator()`/`failedValidation()`
on an object that did not have them. A rule-only request now validates the live input and
answers `validated()`; a failure throws the kernel `ValidationException` (302 + flash, or
422 for JSON), not a `TypeError`.

- **Test.** `compiler/tests/rt-request.test.mjs`.

### Fix — `env()` reads a Worker BINDING before the config mapping (#745)
The helper only knew four `APP_*` keys, so a compiled controller reading a deployment
secret (a FormRequest fallback password hash) threw. Bindings are the edge's environment:
`rt.env('NAME')` answers `ctx.app.env`/the Worker env first, then the config mapping, and
refuses a key that is neither (there is no `.env` at the edge).

- **Test.** `compiler/tests/rt-request.test.mjs`.

### Fix — the shadow harness could not compare an app with a guard port, a port secret, or a form (#746)
Five gaps made a real app unprovable: `registry.json` guard ports were never passed to
the compiled handler (an `Auth::extend` app crashed), `scenario.env` had no way to give
the worker its bindings, the ASSETS binding was absent (a port that prerenders a page
answered 405), the PHP oracle ran with the app's dev `.env` (`public/hot` → Vite dev
URLs + Laravel Boost's browser-logger script the worker never emits), and a live form's
40-char CSRF token (plus absolute asset URLs on a prerendered page) made every such page
"mismatch". All five are closed; `LW_DBG` now prints the worker's exception stack and the
kernel's own log instead of a bare 500.

- **Proof.** the nearFind scenario: 5 steps, **5/5 byte-identical, 0 unexplained, coverage 100%**.

### Fix — a ported URI was still transpiled, and the skip read like a gap (#747)
`/masuk` is owned by a port (the app's `seal` guard login is app JS), yet the extra-verb
pass tried its controller anyway and printed `controller /masuk: skipped — $request
(LoginRequest): ... write a port handler for this route` — advice the app had already
followed. A URI a port owns is now skipped entirely: `controllers transpiled: 5/5`, no
skip line, coverage unchanged.

### Fix — a literal-true `authorize()` forced a port (#748)
`FormRequest::authorize()` answers `true`; a class that writes the boilerplate out by
hand changed nothing, but the dump counted it as a hook, so the route was refused at
build time. A body that is only `return true;` (comments ignored) is now the parent's
own answer and needs no declaration; `return false;` or a condition is a real hook and
still refuses the route. The refusal message says exactly that.

- **Test.** `compiler/tests/formrequest-dump.test.mjs` (a boilerplate `authorize()` is
  not a hook; a deny is).

### Wave — the view's own runtime sees the live HTTP context, a blocked dist swap no longer deletes the build, `$this` compiles in a controller, and two refusals name the truth (2026-11-04)

### Feature — `cookie()` compiles and `withCookie()` queues onto the jar (2026-11-04, audit #722)
`cookie('name','value',60)` was `LW001: unknown function cookie` — an app whose controller sets a cookie (`redirect(...)->withCookie(cookie(...))`) could not be built, though the kernel's `CookieJar` and `HttpResponse::withCookie()` already existed. Now the helper compiles to `rt.cookie(...)`, which calls the request's own `CookieJar::make()` (the exact signature: name/value/minutes/path/domain/secure/httpOnly/raw/sameSite), and `redirect()->withCookie(...)` queues the cookie on the jar — the response pipeline already emits the jar as `set-cookie`.

- **The factory form refuses.** `cookie()` with no name answers Laravel's `CookieFactory` (`Foundation/helpers.php:372-381`); there is no container at the edge, so it stays `LW002` rather than shipping an `undefined`.
- **Parity.** Probed against the booted fixture app + PHP 8.3: `cookie('theme','dark',60)` is path `/`, `sameSite` `lax`, `httpOnly` true, expires `now + 3600`; a `minutes = 0` cookie is a SESSION cookie that still carries its value.
- **Test.** `compiler/tests/controller.test.mjs`: the emitted shape (`rt.cookie(...).withCookie(...)`), the factory-form refusal, and a runtime case that queues onto a real `CookieJar` and reads the cookie back.

### Fix — `_old_input` no longer keeps a multi-file field (2026-11-04, audit H1)
A failed validation flashed `$request->all()` (the input UNION the files bag) and deleted only the TOP-LEVEL file keys, so a `foto[]` upload survived in `_old_input` as an array of empty objects. Laravel flashes `Arr::except($request->input(), $dontFlash)` — and `Request::input()` has no file keys at all (the files live in their own bag). The kernel now flashes `request.input()`, so a file field is absent from `_old_input` entirely.

- **Test.** `kernel/tests/validation.test.mjs`: a multipart POST with `foto[]` (two files) that fails validation answers 302 with no `foto` key in `_old_input` (fails against the previous kernel).

### Fix — a resource's `paginationInformation()` hook was never called (2026-11-04, audit R1)
`PaginatedResourceResponse::paginationInformation()` calls the app's own `paginationInformation($request, $paginated, $default)` when the collection defines it (`PaginatedResourceResponse.php:55-62`). The kernel always answered the default `links`/`meta`, so an app overriding the hook silently got the wrong shape. Now the hook wins when it exists.

- **Test.** `kernel/tests/resources.test.mjs`: a collection with the hook answers its own `links`/`meta`.

### Fix — `Collection::when()`/`unless()` answer like `Conditionable` (2026-11-04, audit C1)
The callback received ONE argument and its return was passed through, so a callback that only mutates answered `undefined`. Laravel's `Conditionable::when()` is `$callback($this, $value) ?? $this`. The kernel now passes the condition as the second argument and falls back to the collection.

- **Test.** `kernel/tests/collections.test.mjs`: the condition reaches the callback, and a mutating callback with no return answers the collection.

### Fix — a present `null` no longer skips `unique`/`exists`, and `required_array_keys` accepts a list (2026-11-04, audits V2/V1)
`unique`/`exists` skipped every `null`, so a row with a `NULL` column passed where Laravel queries and fails; the skip now applies only when the field carries a `nullable` rule (a blank STRING still skips). `required_array_keys` refused every JS array, while PHP's `is_array()` accepts a LIST and its keys are the numeric indices (`required_array_keys:0` passes for `[1,2]`).

- **Test.** `kernel/tests/validator.test.mjs`: both cases fail against the previous kernel.

### Fix — a date-comparison parameter reads PHP's relative grammar (2026-11-04, audit #671)
`before:monday`, `after:+3 days`, `before:-18 years`, `before:noon` — the parameter of a date comparison is Carbon's parser (`getDateTimestamp()` → `Carbon::parse()`), and the kernel only read `now`/`today`/`tomorrow`/`yesterday`, `HH:MM`, `@ts` and the absolute shapes. Every other token became timestamp 0, so `before:monday` **rejected every value PHP accepts** — a false rejection of valid input. Measured on PHP 8.3 with a frozen `now`: 25 of 31 probe tokens diverged, and a wider sweep of 81 tokens × 5 rules diverged in **220 of 405** verdict cells.

`phpRelativeTimestamp` now applies PHP's own field setters left to right to `now` (UTC): a weekday (`monday`, `next friday`, `last monday`, `this week`), a month name (`june`, `5 june`, `june 5`), `noon`/`midnight`, `3pm`, offsets (`+3 days`, `-3 months`, `2 weeks ago`, `1 week`), unit words (`next/last day|week|month|year|hour|minute|second`), `first day of january` / `last day of this month`, and the single-letter military zones. The ordering is what makes `noon tomorrow` tomorrow 00:00 ("tomorrow" resets the clock) while `tomorrow noon` is tomorrow 12:00 — both verified against PHP.

- **Parity.** The same sweep is now **0 of 405 cells divergent**; the pre-fix kernel diverged in 220 of them. A word PHP refuses (`tonight`, `new year`, `in 2 days`, `tues`, `thurs`) stays unreadable and compares against 0, exactly as before (a `tues`/`thurs` abbreviation was dropped from the weekday table after PHP refused them).
- **Test.** `kernel/tests/validator.test.mjs`: a clock-independent verdict test (`before:monday`, `before:noon`, `after:-18 years`, …) and `phpRelativeTimestamp` pinned to the PHP epochs from a frozen `now`.

### Feature — `$this` compiles in a transpiled controller (2026-11-04, audit #725)
The controller refused `$this` outright (`LW002`: "a controller's own methods are not compiled: inline the helper"), while the app's own **classes** had compiled every method since M61e — the same shape answering two different things. A real app hit it twice: `ProfileController`'s `update()`, `updatePassword()` and `updateNotifications()` all open with `$this->resolveProfile($request)`.

- **The fix.** The handler now builds the **instance object** the route method and its helpers live on (`const __self = {}`). `extractController` collects the class's non-static methods; `emitController` walks the `$this->name()` calls from the route method to its **closure of reachable helpers** (a helper the route never reaches stays out — compiling it would demand the *other* routes' views and segments, which this handler does not have); each helper is transpiled with the same ctx as the entry, so its own scalar/`Request`/FormRequest parameters, its model type-hints (seeded as model vars) and its views all work. Every method is `async function (rt, ...)` and the call site hands the runtime over — the class registry's contract (`rt-from-context.mjs:824`), so one shape serves both.
- **What still refuses, on purpose.** A `$this` call to a method the class does not declare (the transpiler's own gate); and a controller with a **constructor** once it has a reachable helper — the edge has no container, so the instance would run **half-built**, which is a wrong compile rather than a loud one.
- **A bug the feature would have hidden.** `collect()` hoisted `$this` as a local (`let v_this;`), which shadows the bound instance with `undefined` — the helper call would have died at request time under a green build.
- **Test.** `compiler/tests/controller.test.mjs`: the helper reaches the instance (emitted shape), a `$this` call to an unknown method still fails loud, a constructor with a reachable helper fails loud, and three **runtime** cases drive real handlers — a helper returning a model into a view, a helper taking a **model** parameter (the value must not be `undefined`), and a zero-arg helper. All four fail against the previous controller. Full suite (isolated copy) 1163 tests, 1116 pass, 0 fail.

### Fix — two refusals named the wrong thing (2026-11-04, audit #723)

### Fix — a compiled view called `session()`/`old()`/`@csrf` on a runtime that had no HTTP context (2026-11-04, audit #735)
`rt.view()` renders a compiled view through its OWN `buildRt(entry.context, {...})`, and that call never received `http` — the live context the HTTP kernel hands a controller (`{ request, session, auth, user, route, routeParams, cookieJar, clock, ... }`). So the view's runtime answered every HTTP helper with `session(): no HTTP context (static snapshot / build-time evaluation)`: any page whose Blade called `session('status')`, `old(...)`, `@csrf` or `request()` answered **500** as soon as the route was reachable. Invisible until the same wave taught the compiler that a VIEW may call those helpers at all (audit #726), which is when a real app hit it: `GET /dasbor` (logged in) was a 500 whose body was the framework's "Server Error" page.

- **The fix.** `rt.view()` forwards the captured live context to the sub-runtime (`http: liveHttp`), so a view reads the SAME session/guard/clock/api the controller does. Without an HTTP context (static snapshot, build-time evaluation) it stays `null` and the helpers keep failing loud — no invented state.
- **Proof (nearFind, worker local).** Before: `GET /dasbor` after login → **500**, worker log `[ERROR] ... session(): no HTTP context ...` at `rt.session → rt.csrf_field → dashboard.mjs`. After: `POST /masuk` 302 + seal cookie, `GET /dasbor` **200** (21554 bytes of real dashboard markup) with a CSRF token that is the LIVE session's (reloading the page returns a new one), `POST /keluar` **302** (token accepted, not 419) and `GET /dasbor` back to 302 → `/masuk`.
- **Test.** `compiler/tests/controller.test.mjs` gained three cases: a compiled view reads the live session (`session()`, `old()`, `csrf_token()` byte-exact), `@csrf` inside a view emits the live token, and the no-HTTP-context case still fails loud instead of inventing one. All three fail against the previous `rt-from-context.mjs`.

### Fix — a blocked `commitDist` deleted the previous `dist/` and left the app with no worker (2026-11-04, audit #734)
On Windows a running `wrangler dev` holds a handle on a directory INSIDE `dist/`. The swap refused to keep the old tree: when `rename(dist, dist.old-*)` failed, the fallback **wiped `dist/` in place** and then the landing `rename(dist.building, dist)` failed on the same handle — the app was left with the locked leftovers (a bare `public/`) and **no `dist/src/worker.mjs`**, so the dev server could not even start.

- **The fix.** The wipe-in-place fallback is gone. A blocked move-aside now **refuses**: the previous `dist/` is left untouched and the error names the finished build under `<dist>.building` so neither side is lost. The sibling warning in the early dist clean (`build.mjs`) is also fatal now — stage 1 reuses the same tree, so an undeletable artifact would serve stale bytes for the whole build. Operator contract, same as #720's: **stop the dev server before a build**.
- **Proof.** `dist.old-<ts>` planted non-empty → `commitDist` REFUSED, `dist/src/worker.mjs` byte-identical, `dist.building/src/worker.mjs` intact; after removing the marker the build is green again. Regression test `compiler/tests/dist-swap.test.mjs` forces a real move-aside failure and asserts the refusal, the untouched old build and the intact staging tree.
- **Test.** `compiler/tests/dist-swap.test.mjs` 5/5; full suite (isolated copy) 1157 tests, 1110 pass, 0 fail; corpus 55/55.

### Fix — two refusals named the wrong thing (2026-11-04, audit #723)
A refusal is the product here: the build "never silently degrades" because a refusal stops it and *names what it would take*. Two texts did not hold that up — both hit by an ordinary app.

- **The rule object (`LW002`).** The reason cited a fixed example (`Rule::file()->max(2048)`) whatever the app wrote, and told the operator to *do* what the tool already does: the same rule inside a **FormRequest** is normalized at build time today (the dump reads the rules Laravel itself builds — `tools/formrequest-dump.php` — and a rule object becomes its string form, M62a). The reason now names the actual class (`Illuminate\Validation\Rule`) and the remedy that works: **move the rules into a FormRequest** — an inline `$request->validate([...])` cannot be normalized, because its arguments are runtime values the build never sees.
- **A service class (`LW003`).** `App\Support\Seal\Sealer` (a static `Sealer::durationToMilliseconds()`) was refused as "is not a registered Eloquent model" — true, and useless: the operator is sent looking at models. The reason now says what the class is: no edge surface at all, with the model-dump case named separately.
- **The `$this` refusal** also names its remedy now (a controller's own methods are not compiled → inline the helper or write a port).
- **Test.** `compiler/tests/controller.test.mjs`: the rule-object case asserts the class is named and the FormRequest remedy is stated; a new case asserts a service class is refused *without* being called a model. Measured on the fixture app: the two messages above are what the build prints for `/masuk` and `/profil`.

### Fix — every ternary in `config/*.php` vanished from the build, and a route nullability Laravel never had (2026-11-04, audit #50, #51)

Two findings the line-by-line sweep left `OPEN`, both silent-divergence class, fixed with their proofs.

- **`#50` — a config ternary was dropped without a trace.** The build-time config evaluator (`tools/static.mjs` → `evalConfigExpr`) matched AST kind `ternary`, but php-parser 3.x tags **both** the full ternary (`$a ? $b : $c`) and the elvis (`$a ?: $c`) with kind **`retif`** (`trueExpr` is `null` for the elvis); it never emits `ternary`. So every ternary in an app's `config/*.php` fell through to `undefined`, and the array branch dropped the entry (`val === undefined → continue`) — a `config/foo.php` group whose value was a ternary disappeared entirely, silently, where PHP boots with a value. Measured with the pre-fix module: `config/demo.php` = `['on' => env('APP_DEBUG') ? 'debug' : 'release']` produced `config.demo === undefined` (with `APP_DEBUG=false`). Now `case 'retif'` is handled alongside the kept `ternary` label, the elvis answers the test itself when truthy, and a null/undefined test is the only thing dropped.
- **`#51` — an `allowsNull()` argument splice that Laravel does not have.** `controller.mjs` read a parameter's nullability from `p.type.kind === 'nullabletype'` — a node kind php-parser 3.7.0 never emits (`?int $n` is a `typereference` plus a `nullable: true` flag on the **parameter**), so the value was always `false`: dead code that carried a wrong comment and a wrong test. The vendored Laravel 13.37 is the arbiter: `Routing/ResolvesRouteDependencies::resolveMethodDependencies` has **no** `allowsNull()` branch, and dispatch drops the null route params first (`Route::parametersWithoutNulls()`, used by `ControllerDispatcher`/`CallableDispatcher`), so a parameter with no segment takes its default or the call has too few arguments (PHP 8 `ArgumentCountError` → 500) — a nullable type is **not** given a null. The `nullable` plumbing is removed from `rt.param`, from the emitted call and from both tests, which now state the vendor behaviour. Behaviour-preserving: `nullable` was always `false`, so no compiled output changed value — the landmine (fixing only the field read would have answered a 200 `null` where Laravel answers 500) is gone.
- **Test.** `tools/tests/env-fold.test.mjs` gained a case that parses a **real** `config/*.php` through `loadConfig` (the old case hand-built an AST with the never-emitted kind, so it passed falsely); `compiler/tests/rt-blade.test.mjs` and `compiler/tests/controller.test.mjs` assert the vendor truth. Full suite (isolated copy `lw-fix`) **1165 tests, 1118 pass, 0 fail, 47 skipped**; the new config case fails against `HEAD:tools/static.mjs` (`config.demo === undefined`). Residual, not fixed: config `==`/`!=`/`===`/`!==` (kind `bin`) still fall through to `undefined` — the same silent-drop class, left as a separate low item because a faithful PHP `==` needs the loose-equality rules.

### Fix — a page rendered second in one boot lost its font preloads (2026-11-04)

A real app (nearFind) proved it through the shadow harness: `dist/public/index.html` carried no `<link rel="preload" as="font">` while the live PHP page carried three. `Illuminate\Foundation\Vite` is a container singleton and `fonts()` records every URL it emits in `$preloadedAssets` (`Illuminate/Foundation/Vite.php:1144`), skipping a repeat on the next call — one boot renders every URI (`tools/prerender.php`, Track E), so page 1 kept its preloads and every later page silently lost them (measured: `/masuk` 3, `/` 0). The PHP oracle (`tools/php-shadow-oracle.php`) had the same leak between steps, which made the harness report the compiled worker (correct, one render per request) as the mismatch.

- **Fix.** Both PHP hosts drop the resolved `Vite` singleton per URI/step, so each page renders from a clean instance exactly like a fresh boot.
- **Measured.** `/masuk` and `/` both carry the 3 preloads after the build; the authenticated `/dasbor` step is byte-identical in the harness.

### Fix — `url('/')`/`route('home')` answered a trailing slash (2026-11-04)

Probed against the booted app on PHP 8.3: `url('/')`, `url('')` and `route('home')` are `http://localhost` (no slash) and `url('masuk/')` is `http://localhost/masuk` (`UrlGenerator::to()` trims). The runtime's `genUrl()` answered `origin + '/' + path`, so a root route (stored as `''` in the route map) became `http://localhost/` — every home link in the app diverged from PHP by one byte.

- **Fix.** `joinRoot()` in `compiler/runtime/rt-from-context.mjs` (used by `route()` and `url()`), and the same trimming in `kernel/http.mjs`'s `absoluteUrl()` for redirect `Location` values.
- **Test.** `compiler/tests/rt-url.test.mjs`: root, a named route, a parameterised route, and the trailing-slash cases, pinned to the PHP probe's output.

### Fix — PHP children rendered in the app's dev environment (2026-11-04)

Every PHP child (prerender, compile, dumps) inherited the app's own `.env` (`APP_ENV=local`, `APP_DEBUG=true` on a developer machine), so dev-only middleware rendered into the build: Laravel Boost's `InjectBoost` only runs outside production (`BoostServiceProvider::shouldRun`) and injected its `<script id="browser-logger-active">` into every snapshot (measured: `/masuk` 25,457 bytes versus 18,231 in production).

- **Fix.** `childEnv()` forces `APP_ENV=production` + `APP_DEBUG=false` — a real environment variable wins over `.env` in Laravel, so an operator who exported either keeps their value.

### Feature — `mimes`/`mimetypes` compile for the image formats the edge can sniff (2026-11-04)

The build refused both rules outright (`LW002`/`LW003`: finfo), although `image`/`dimensions` already read the file HEADER in the kernel. A single `mimes` rule sent a whole controller — and with it the controller's GET page — to a port.

- **Rule.** PHP compares what finfo sniffs with `guessExtension()` (Symfony's FIRST extension for the MIME: `image/jpeg` answers `jpg`, never `jpeg`); the edge reads the same header (`kernel/image.mjs`) and answers for the formats that read can name (jpg, jpeg, png, gif, webp, avif, heic, heif). Any other parameter (pdf, svg, docx, bmp) stays loud and is NAMED in the refusal.
- **Parity.** `mimes:jpeg` keeps rejecting a real JPEG (PHP does too), `mimetypes:image/png` matches on the MIME, and a text file fails an image-only list — the verdict comes from the bytes, not the browser's declared type.
- **Test.** `kernel/tests/upload.test.mjs` (accept/reject/mimetypes/loud `mimes:pdf`) and `compiler/tests/controller.test.mjs` (an image-only FormRequest rule compiles; `mimes:png,pdf` refuses and names `pdf`).

### Wave — guard ports: the auth driver the app registers itself, and the `ports/` build cache (2026-11-03)

### Feature — a guard driver the app registers itself is answered by the app's own JS (2026-11-03)
`Auth::extend('seal', fn () => new SealGuard())` is a closure the compiled rung cannot run, so a non-session `auth.guards.*` driver had exactly one honest answer in the edge build: **refuse**. It refused well (the gate named the guard, `READINESS: DOES NOT RUN`, and wrote nothing), but an app whose guard is its own could not ship the guarded route at all. It now can, with the app writing the driver and the rung keeping everything around it.

- **The declaration.** `registry.json` → `{"guards": {"seal": "seal-guard"}}` plus `ports/seal-guard.mjs` exporting `export default { async user(ctx) { ... } }` (optional `validate`/`login`/`logout`/`userById`). The port receives `{ request, guard, driver, config, app }` — the same building blocks the compiled session guard gets. The build resolves the slug against `ports/` (or `LW_PORTS_DIR`), refuses an unknown slug or a port without `user()`, emits `dist/src/guard-ports.generated.mjs` (a static `import` per declaration — never a dynamic module load, which the Workers runtime forbids), copies the port verbatim and threads it into `handleHttp` (`src/worker.mjs`).
- **What stays the rung's.** Only the driver is the app's. `auth:seal` resolves through `Authenticate` (and `shouldUse('seal')` switches the request's default driver, exactly as Laravel's `Authenticate::authenticate()` does), so `auth()->user()`, the `guest` middleware, `Auth::viaRemember` and the 401/redirect answer all remain compiled. `PortedGuard` (`kernel/auth.mjs`) resolves `user()` lazily and **at most once per guard per request** — the middleware, the controller and the view share one port call, and `setRequest()` drops the memo. A port that throws keeps throwing (a failure never degrades into "no user", which would let a guarded route through); a port that answers `null` is a guest.
- **Without a port the build still refuses — and now says how to fix it.** Probed on the fixture app with `'auth.guards.seal' => ['driver' => 'seal']` and no port: exit **1**, `READINESS: DOES NOT RUN`, the message naming `auth.guards.seal (driver 'seal')`, the exact `registry.json` key and the port's contract, and `nothing was written; dist still holds the last build that COMPLETED`. Adding the registry entry and the port: exit **0**, `READINESS: RUNS WITH DECLARED GAPS` listing that one guard as *your decision*, `dist/src/guard-ports.generated.mjs` importing `./ports/seal-guard.mjs`, and the port copied to `dist/src/ports/`.
- **The motivating PHP keeps working.** The fixture provider then got the real thing — `Auth::extend('seal', fn () => new \App\Auth\SealGuard())` with a `SealGuard implements Guard` class — and the build still **passes** (exit 0): a service-provider closure is not a compiled class body, so declaring the port does not force the app to give up its PHP registration for the oracle or for local dev.
- **Test.** `kernel/tests/http.test.mjs` drives the whole thing through the real pipeline (no oracle: the port is app code): `auth:seal` + `x-seal: 7` answers `200` `{"id":7,"name":"sealed-7","defaultGuard":"seal"}` — the default driver really did switch — with the port called exactly once, and the same route without the header answers `401 {"message":"Unauthenticated."}`. `kernel/tests/auth.test.mjs` gained 13 cases for `PortedGuard` (memoization, `id()` via `getAuthIdentifier()`, `validate`, `attempt`, `login`/`logout`/`onceUsingId`, the fail-loud paths) and `tools/tests/guard-ports.test.mjs` 10 for the build side (slug resolution, a `guards` value that is not an object, the missing-`user()` refusal, the generated module). All new files are listed in `package.json`'s `test` script. On the frozen tree: `npm test` (with `PHP_BIN` and `LW_LARAVEL_APP` set, so the oracle tests really run) **1145/1145 pass, 0 fail, 0 skip**, and the CI `parity-oracle` set (`auth`/`cache`/`csrf`/`session`/`ratelimit` vs PHP 8.3.30 + framework 13.37) **56/56 pass, 0 fail, 0 skip** — the session guard's byte parity is unchanged by the `PortedGuard` addition.

### Fix — editing a port file did not invalidate the build cache, so dist served the previous revision's port (2026-11-03, audit #692)
`ports/<slug>.mjs` is copied into the build **verbatim** (route ports and, now, guard ports), but the cache key hashed `app`, `bootstrap`, `config`, `database`, `routes`, `lang`, the views, the lang files and `public` — not `ports/`, and `registry.json` contributes its *mapping*, not the port's bytes. Editing a port therefore answered a **hit** and shipped the old one.
- Proof, measured on the fixture app with the previous `tools/build-cache.mjs` (212 hashed files): the port on disk said `STALE-`, the build printed `build cache: hit (212 input files unchanged ...) — dist/ is current`, and `dist/src/ports/seal-guard.mjs` still said `SEALED-`. With the fix: the same edit gives `miss (213 input files hashed)` and the new bytes land in `dist/`.
- `ports/` is part of the key now (its content, at any depth), `LW_PORTS_DIR` content counts too (`extraDirs`, so an app that keeps its ports outside the app root still invalidates), and `src/guard-ports.generated.mjs` is a REQUIRED cache artifact — a stamp from a build that did not emit it is not reusable.

### Doc
`README.md` (the Auth row + the "if your app needs X" table), `MAP.md` (the Auth row) and `COMPILED.md` (the Auth row) carry the feature and its contract; `node tools/gate.mjs --strict` passes (105/105 doc rows, 116 constructs, README counts match).

### Fix — the audit wave-1 findings (2026-11-03, audit #716, #717, #719, #720)

Four defects the line-by-line audit left `OPEN`, fixed with their proofs.

- **`#717` — the guard-port example taught the wrong `ctx`.** `tools/ports.mjs` showed `ctx.env.SEAL_KEY` / `ctx.models.User.find(ctx.db, id)`; the contract is `ctx.app.*` (`kernel/auth.mjs`, `PortedGuard.portCtx` — `{ request, guard, driver, config, app: { config, db, models, env, session, cookieJar } }`). An operator copying it got `ctx.env` = `undefined` for the very guard being ported. The example is corrected, the contract sentence sits next to it, and `README.md` gained **"A guard port, in practice"** — the two green paths, why `ignore` cannot help (the refusal is config-level), the full `ctx` shape, the port-call semantics (at most once per guard per request, throw keeps throwing, `null` is a guest) and the rule that the port must not hand-roll the provider's token format (implement its `SPEC` + gate its official test vectors, or use its SDK; the sealed-cookie example is linked).
- **`#719` — `config-dump.mjs` lost parts of a list-shaped lang override.** `deepMerge` replaced a whole list whenever both sides were arrays, while the PHP dump it replaces merges `array_replace_recursive` per KEY — and a list's keys are its indices. Measured with the PHP 8.3 oracle: `array_replace_recursive(['a' => ['x','y','z']], ['a' => ['y2']])` is `{"a":["y2","y","z"]}`; the old JS answered `{"a":["y2"]}`, so a framework validation sentence the app did not override vanished from the edge. The merge is per-key at every depth now (arrays and objects alike), and it lives in a side-effect-free `tools/deep-merge.mjs` — `config-dump.mjs` is a script that reads the app on import, so a test that imported it executed the whole dump (and `process.exit(1)`'d the test process when no app root was set: the workspace run reported the file as a failure). `tools/tests/config-dump-merge.test.mjs` pins six cases whose expected values are that oracle output, including the nested `{"deep":{"k":["9","2"],"keep":1}}` and a list merged with an assoc array (`[0=>'x',1=>'y','k'=>1]`). The test is registered in `scripts.test` (the repo uses an explicit file list, not a glob).
- **`#720` — the packaging gate could leave `public/hot` behind in the app it tested.** `pack-smoke.mjs` plants the Vite dev markers to prove they do not survive the build, but removed them only at the end of the one step that runs on success. A failing step left the marker in the app (Laravel then hands out dev-server asset URLs: 404 fonts on the error page), and planting over a running `npm run dev` ate that marker too. Worse, `process.exit()` does not unwind the stack — `try { process.exit() } finally {}` never runs the `finally` — so both the report path and the throw path needed explicit cleanup. The markers are now snapshotted before planting and restored by `cleanup()` (called before the exit code and again in the `finally`), and the step-3b-only `rmSync` is gone. Measured on the fixture: a pre-existing sentinel `public/hot` came back **byte-identical** after a PASS run and after a run that FAILED at the CLI step; the leaked `lw-pack-smoke-*` directories from earlier runs (86 MB, 29 dirs on this machine) are cleaned up by the same path now.
- **`#716` — a trailing backslash run was not doubled when quoting for `cmd.exe`.** `tools/run.mjs` used `arg.replace(/(?=(\\+?)?)\1$/, '$1$1')`, which inserts ONE backslash instead of doubling the run; the CRT rule needs `2n` before a quote. Measured with the fixed and the old helper on this Windows box (child prints its own argv, 11 arguments × 2 positions): the repo version mangled `tail\\` → `tail\" END` (the closing quote swallowed, the next argument glued on) and `tail\\\` → `tail\\`; the fix is **0 mismatch**. The replacement is `arg.replace(/(\\+)$/, (m) => m + m)`.

### Fix — the audit wave-2 finding (2026-11-04, audit #721)

- **`#721` — `event-dump.mjs` honoured an ambient `LW_APP_ROOT` over its own argument.** The port read `process.env.LW_APP_ROOT` first and only fell back to `process.argv[2]`, while the PHP oracle it is compared against reads `$argv[1]` only (`tools/event-dump.php:34`) and `build.mjs` passes the app positionally. `LW_APP_ROOT` is the *documented* way to point the other dump tools (`config-dump`, `routes-dump`, …) at an app — so exporting it silently redirected this dump to a **different app than the caller named**, and the parity test then compared two apps byte for byte. Measured in the isolated copy with `LW_APP_ROOT` pointing at a leftover probe app and `fresh-app` passed as the argument: the port printed the probe app's file paths (`..._sched-probe\app\Events\PostPublished.php`); the parity test failed 2/2. The positional argument wins now (env is the fallback), matching the oracle, and `tools/tests/event-dump.test.mjs` gained a case that points `LW_APP_ROOT` at a non-app directory and asserts the dump still reads the positional app — **3/3 pass with the fix, 3/3 fail without it** (the build itself was never affected: `childEnv()` already sets `LW_APP_ROOT` to the same app it passes positionally).

## v0.4.8 — the route shapes the scanner missed, the validator's failure line, and the whole-build dev marker (2026-11-03)

### Fix — an arrow-function route or group was invisible to the scan (2026-11-03, audit #678–#680)
The scanner recognised exactly one node kind for a callable, `'closure'`. PHP's arrow function parses as `'arrowfunc'` with the expression in `body` instead of a statement block, and every place that pattern-matched on `'closure'` therefore treated an `fn () => ...` route as if the route file had written nothing.

- **`#678` — a `fn () => ...` handler made the route vanish from the edge.** `path` stayed `null` and the action stayed `Closure`, so `build.mjs`'s `isAppRoute()` (which needs `routes/`-prefixed path or a non-Closure action) classified it as a route defined outside `routes/` — the build printed `skipped … route(s) defined outside routes/ (not part of the edge build)` and served 404 where PHP answers 200. Probed on the fixture app: `GET /probe-arrow-str` and `GET /probe-arrow-view` answered `200` (`plain`, `<!DOCTYPE html>`) under PHP 8.3.30 + 13.37 and had **no handler** on the edge; after the fix both are byte-identical.
- **`#679` — a `fn () => ...` GROUP dropped every route inside it, with no note at all.** `Route::prefix('g')->group(fn () => Route::get('/inner', …))` found no closure argument and returned: a three-route file answered two (`a`, `b` — `g/inner` was simply absent), and nothing anywhere named the missing one. After the fix the route is dumped (group prefix and middleware applied) and serves byte-identical.
- **`#680` — `->withMiddleware(fn (Middleware $m) => …)` skipped the app's whole middleware configuration.** Both walkers in `tools/static.mjs` read `body.children`, which an arrow function does not have, so `->use()`/`->remove()`/`->append()`/`->replace()`/`->trimStrings()` were ignored and the edge ran the FRAMEWORK default stack while PHP ran the app's.
  - Proof (`#678`/`#679`): the fixture app with one probe route per shape, both through `shadow/run.mjs` (the real oracle vs the compiled worker). Before: PHP `200` vs the edge with no handler; after: **byte-identical**, coverage 100%.
  - Test: `tools/tests/routes-dump.test.mjs` "an arrow-function handler is a closure route, not a dropped one" and `tools/tests/middleware-transform.test.mjs` "an arrow-function withMiddleware callback is read, not skipped" — both FAIL against the previous `tools/routes-dump.mjs`/`tools/static.mjs` and pass after. One new shared helper pair (`isClosureFn()`, `closureStatements()`) replaces the three kind comparisons.

### Fix — the group `controller`/`namespace` attributes and a resource name with a slash (2026-11-03, audit #687–#689)
A `--strict` build refuses an app whose routes it cannot resolve, and three route shapes Laravel supports resolved to the wrong action string. All three are pinned against `php artisan route:list --json` rather than the source.

- **`#687` — `Route::controller(X::class)->group(…)` answered `index`, not `X@index`.** `Router::prependGroupController()` (`Router.php:664-684`) turns a bare method name into `Group\Controller@method` when the route is registered, and `RouteGroup::merge()` (`:23-25`) unsets the outer controller as soon as an inner group declares one. The dump printed `index`, so the build tried to resolve a CLASS named `index` (`cannot resolve index via composer autoload`) and the whole build failed.
- **`#688` — the group `namespace` attribute (and its nested/absolute rules) was not applied.** `Router::prependGroupNamespace()` (`:653-661`) prefixes a `uses` string that neither starts with a backslash nor already starts with the namespace — and `Router::view()`/`redirect()` register `\Illuminate\Routing\ViewController` WITH that leading backslash, which is what exempts them. `RouteGroup::formatNamespace()` (`:105-114`) concatenates nested namespaces (`App` + `Http\Controllers`) and treats a leading backslash as absolute. Both the `->namespace()` registrar attribute and the `['namespace' => …]` group array are read.
- **`#689` — a resource name containing a slash put the prefix in the WILDCARD.** `ResourceRegistrar::register()` (`:85-92`) sends such a name to `prefixedResource()`, where everything before the last slash is a URI prefix and only the last segment names the resource. `Route::resource('admin/slugs', C)` answered `admin/slugs/{admin/slug}` with the route name `admin/slugs.show` where PHP answers `admin/slugs/{slug}` and `slugs.show` — a wildcard no controller parameter or implicit binding can ever match.
  - Proof: the fixture app, probe routes for every shape (bare method, array action, `'FQCN@method'` string, `['controller' => …]`, nested controllers, arrow-function groups, nested/absolute namespaces, `Route::view` inside a namespace group, a resource under a namespace group, `admin/slugs`, `/lead`, `deep/a/b/nested`): **uri + name + action + middleware identical to `route:list --json`** (9/9 namespace shapes, 9/9 route shapes, 4/4 slash names), and through `shadow/run.mjs` **byte-identical with coverage 100%**.
  - Test: `tools/tests/routes-dump.test.mjs` gained "a controller group resolves bare method actions", "a namespace group prefixes the controller action" and "a resource name containing a slash is a PREFIXED resource, not a wildcard" — all FAIL against the previous `tools/routes-dump.mjs`, 29/29 pass after.

### Fix — the shadow oracle crashed on a scenario with no `user` (2026-11-03, audit #681)
`tools/php-shadow-oracle.php` read `$userInput['id']` unguarded, so a scenario that seeds no user (`user: {}`) died with `ErrorException: Undefined array key "id"` BEFORE the first step and the harness reported a JSON error instead of comparing anything. It now tests `($userInput['id'] ?? null) !== null`, which is what the surrounding `$schema->hasTable('users')` check always meant.


### Fix — `LW_VENDOR_DIR` was a hint, not a resolver, on the tools' own path (2026-11-03, audit #647/#648)
An app with no `vendor/` of its own reaches the framework through `LW_VENDOR_DIR` (the vendor-lite layout). The PHP half already resolved both layouts, and `tools/build-cache.mjs` did too — but two JS tools hard-coded `<app>/vendor` and so silently lost the framework for exactly the app the variable exists for:
- **`tools/config-dump.mjs`** read the framework's translation files (`src/Illuminate/Translation/lang`) from that path, so a vendor-less app got `config.translations` `{}`: every framework validation message fell back to its KEY — `__('auth.failed')` answered `auth.failed` instead of the sentence.
- **`tools/static.mjs` `classFile()`** read `vendor/composer/autoload_psr4.php` from it, so every vendor FQCN (a parent class, a trait) resolved to nothing and the build could not follow a class into the framework.
  - Both now resolve the same two layouts the PHP path (`lw_vendor_autoload_for()`) and the config defaults already accept: `<LW_VENDOR_DIR>/…` and `<LW_VENDOR_DIR>/vendor/…`.
  - Proof: `tools/tests/vendor-dir.test.mjs` runs the real dump and the real `classFile()` against a copy of the app with **no `vendor/`** — three cases: translations resolved through the variable, a control that finds no framework without it, and a vendor FQCN resolved through `classFile()`. Measured: with the previous `config-dump.mjs`/`static.mjs` **2 of 3 FAIL**, after the change 3/3 pass. It skips with its reason when no Laravel app or reachable framework copy exists (the repository's oracle-test convention). It already ran in the `parity-oracle` CI job through `tools/oracle-ran.mjs` — which asserts the run is not all-skipped — but it was missing from `npm test`, so a local run with an app reachable never executed it; it is listed there now.

### Fix — the Vite dev marker was put back too early, so the build compiled in dev mode (2026-11-03, audit #676)
`@vite` and `@fonts` decide dev-vs-build from `public/hot`, and the build set that marker aside only for the prerender (step 3). The COMPILE phase (the error views, every Blade view) and the `public/` copy both run AFTER it, so a developer with a running `npm run dev` got a build whose compiled contexts carried dev-server URLs — and `dist/public/hot` itself shipped into the document root, where any later reader takes it for an app in dev mode.
- The marker now stays aside for the WHOLE build: `restoreHot()` runs as the build's last step **and** again on `process.on('exit')`, so a build that throws still leaves no aside behind (a running dev server keeps its own marker: the rename is skipped when the aside cannot be restored).
- The `public/` copy excludes all three dev markers — `hot`, `hot.edge-build-aside` (the marker while it is held aside) and `fonts-manifest.dev.json` (the dev-side font map): none of them may reach the document root, which IS the Static Assets root at the edge.
  - Proof: `tools/pack-smoke.mjs` gained a permanent step that plants `public/hot` **and** a dev font map BEFORE the build, then asserts (a) no dev marker under `dist/public`, (b) no `:5173` / `__laravel_vite_plugin__` in any `dist/src/**/*.mjs`, (c) `public/hot` is back afterwards. Measured: with the fixed `build.mjs` pack-smoke is 8/8 PASS and the shadow run is 12/12 byte-identical; with the previous `build.mjs` the strict build FAILS — all 10 error views compile in dev mode and the planted dev font map raises `ViteException: Font manifest preload entry [0] for alias [instrument-sans] is missing the [url] key` (with a real dev manifest those contexts instead carry `http://[::1]:5173/__laravel_vite_plugin__/fonts/...`, the symptom this removes).

### Fix — the validator's failure message was wrong five ways, and the comparison line's `:value` with it (2026-11-03, audit #670–#675)
The rendered sentence is what an app shows a user and what a test asserts, so this sweep compared the INTERPOLATED line, not the key: an `ArrayLoader` carrying the framework's own `lang/en/validation.php` under PHP 8.3.30 + 13.37, 22 cases — **13 differed before this change, 0 after**.

- **`#670` — a comparison rule's message was chosen from the DECLARED rules, not from `$numericRules` at failure time.** `Validator::validateAttribute()` resets that list per rule (`Validator.php:764`), `ValidatesAttributes::shouldBeNumeric()` (`:2926-2931`) appends the rule's own name while the VALUE is PHP-numeric, and `FormatsMessages::getAttributeType()` (`:226-238`) reads it first. `{a:1,b:2}` with `gt:b` therefore renders `validation.gt.numeric` — "must be greater than 2" — where the edge rendered `validation.gt.string` ("...greater than 2 characters"). The claim was written into a field nothing read (`numericRulesClaimed`); it now goes through one helper (`_claimsNumeric`) that feeds both readers — the comparison branch and the message type. A numeric-looking STRING counts too (`{a:'1',b:2}` `gte:b`); `min:3` on `'70'` stays `validation.min.string`, because `min` never claims numeric.
- **`#672` — `present` on an absent field said "is required".** `validatePresent()` (`:2038-2041`) is `Arr::has()`, an implicit rule with its own line: `validation.present` = "The a field must be present." The path answered the `required` sentence. (`present_if`/`_unless`/`_with`/`_with_all` were already right.)
- **`#673` — `present_unless`/`missing_unless` left `:value` literal.** Both route to `ReplacesAttributes::replaceMissingUnless()` (`:239-245`, `present_unless` mapped at `:459-462`), which replaces `:other` and `:value` with the display names — `{b:1}` with `present_unless:b,2` reads "unless b is 2", where the edge kept the placeholder. `required_unless`/`prohibited_unless` correctly keep `replaceRequiredUnless()`'s `:values` list.
- **`#674` — `getDisplayableValue()` was not implemented.** `FormatsMessages::getDisplayableValue()` (`:506-529`) answers `empty` for `null`, `true`/`false` for a bool and the PHP string cast otherwise, so `{b:null}` with `present_if:b,null` reads "when b is empty" (the edge interpolated nothing). The `validation.values.{attribute}.{value}` line wins first, as in PHP.
- **`#675` — `gt`/`gte`/`lt`/`lte` put the RAW compared value in `:value`.** `ReplacesAttributes::replaceGt()` (`:587-596`, reused by gte/lt/lte at `:605-636`) substitutes `getSize($attribute, $comparedToValue)` — the number itself for a numeric attribute, `mb_strlen` for a string one, `count()` for an array. `{a:'ab',b:2}` with `gt:b` therefore reads "greater than 1 characters" (the length of `'2'`), and `{a:'ab',b:'abc'}` with `gte:b` reads "or equal to 3 characters"; the edge printed the value itself ("...2 characters", "...abc characters").
- **Documented, not changed (`#671`):** a date comparison PARAMETER (`before:`/`after:`/…) is read through Carbon's parser, of which the kernel covers `now`/`today`/`tomorrow`/`yesterday`, `HH:MM[:SS]`, `@<ts>`, the compact digit runs and the absolute shapes. Probed 27 tokens on 8.3 + 13.37: 23 diverge (`noon`, `2pm`, `monday`, `next monday`, `+1 day`, `1 week ago`, `last week`, `june`, the single-letter military zones…) because the kernel reads an unparsable token as a FIELD name (missing → timestamp 0). Recorded in `COMPILED.md` §3 with the token list; a literal date or a field name is faithful.
  - Proof: `_lv670b.php`/`_lv670.mjs` and `_lv675.php`/`_lv675.mjs` — the same 22 interpolated lines through the real Laravel validator and through the kernel (`_msg.php`/`_msg.mjs` + `_msgcases.json` drive the same list for both); 13 mismatches at HEAD, 0 after.
  - Test: `kernel/tests/validator.test.mjs` gained one 16-case block with the probe's exact sentences (93/93 in the file); the isolated-copy suite stays green.


### Fix — the second `kernel/model.mjs` sweep: timestamps, date writes, `findOrFail` ids and the soft-delete write (2026-11-03, audit #658–#663)
Runs the framework's own methods against the same SQLite row instead of reading the source a second time: an oracle app (`php -r` on PHP 8.3.30 + vendored 13.37, in-memory SQLite through Eloquent) and the kernel answer the same 19 probes, and six of the probe lines disagreed before this change (two residual lines stay different, both documented below). All six fixes are pinned by a new differential block in `kernel/tests/model.test.mjs` (`node:sqlite`, D1-shaped).

- **`#658` — the `timestamp` cast ignored a numeric value and read a date string through `Date.parse`.** `HasAttributes::asTimestamp()` is `asDateTime($value)->getTimestamp()` (`:1652-1655`), and `asDateTime()` takes an `is_numeric()` value as a UNIX TIMESTAMP (`:1591-1594`). The port answered `null` for `'1700000000'` and `'1700000000.5'`, and sent `'2024-1-2 3:4:5'` through `Date.parse` — the host's local zone, a DIFFERENT epoch second than the model's (`1704222244` vs PHP's `1704139445` on a UTC model). It now reuses the strict model parser, so an unreadable value raises `InvalidFormatException` like PHP instead of answering `null`.
- **`#659` — a date attribute written with a value was not normalised.** `setAttribute()` (`:1080-1090`) runs `fromDateTime()` on every date attribute: `empty($value) ? $value : asDateTime($value)->format($this->getDateFormat())` (`:1639-1644`). `$post->created_at = '2024-1-2 3:4:5'` therefore stores `2024-01-02 03:04:05` in PHP, while the edge wrote the app's text to D1 verbatim — and a D1 column that holds a second format is a query that misses. `''`, `'0'`, `null` and `false` keep Laravel's `empty()` short-circuit.
- **`#660` — `findOrFail(array)` compared ids by IDENTITY.** `Model::findOrFail()` (`:655-660`) compares `count($result) === count(array_unique($ids))`, i.e. by VALUE, so a string route parameter (`'1'`) matches an INTEGER primary key; `ids.includes(i)` compared a number against a string and reported **every** id as missing (`Post::findOrFail(['1','2'])` threw `not found: 1, 2` where PHP answers both models).
- **`#661` — a soft delete cleared EVERY pending change.** `runSoftDelete()` syncs only the columns it wrote (`SoftDeletes.php:155`, `syncOriginalAttributes(array_keys($columns))`). Syncing the whole attribute set dropped a pending write silently: `$p->title = 'zzz'; $p->delete(); $p->save();` leaves the column `zzz` in PHP and left it untouched here.
- **`#662` — `restore()` was not `save()`.** `SoftDeletes::restore()` (`:165-188`) clears `deleted_at`, sets `exists = true` and writes through `save()`, so the cleared column and any other dirty attribute go in ONE update. The port ran a raw update and then a full `syncOriginal()`, discarding the pending change.
- **`#663` — `delete()`/`forceDelete()` answered the driver's result.** `Model::delete()` (`:1798`, `:1814-1818`) answers `null` for a never-persisted model and `true` for a successful delete: `$post->delete()` in a JSON response is `true`, not `{"success":true,"meta":{...}}`.
- **Documented, not changed (`#664`–`#666`):** `(float) '1e400'` overflows to `INF` in PHP (whose `json_encode` then FAILS) where JS keeps `Infinity`; `applyCast('', 'timestamp')` fails loud by the `#273` policy while PHP answers `now`; and `restore()` on a never-persisted model raises the `#645` `model update affected 0 rows` instead of PHP's silent `true`.
  - Proof: `_dm.php`/`_dm.mjs` — the same 19 probes (timestamp forms, a normalised write, `findOrFail(['1','2'])` against an INTEGER pk, soft delete + `save()`, `restore()` with a pending title, the `delete()` answers) on a real SQLite `posts` table; before 6 mismatches, after 2, both the documented residuals.
  - Test: `kernel/tests/model.test.mjs` gained six `node:sqlite` tests (28/28 in the file); the isolated-copy suite stays green.

### Fix — a `timestamps = false` model no longer reads its timestamp columns as dates (2026-11-03, audit #644/#646)
Re-sweeping `kernel/model.mjs` line by line against the vendored 13.37 turned up two narrow divergences and one no-op.

- **`#644` — `created_at`/`updated_at` were treated as date attributes unconditionally.** `HasAttributes::getDates()` (`13.37, :1675-1680`) merges the timestamp columns only while `usesTimestamps()` is true, so a `public $timestamps = false` model answers the RAW column: probed on PHP 8.3 + 13.37, `get_debug_type($m->created_at)` = `string` and `$m->toArray()` = `{"created_at":"2024-01-02 03:04:05"}`. The kernel wrapped it in a Carbon / ISO8601 value anyway. `isDateAttribute()` now gates the two columns on `ctor.timestamps !== false`; a SoftDeletes `deleted_at` keeps its date behaviour (the trait declares a `datetime` cast, independent of timestamps).
  - Test: `kernel/tests/model.test.mjs` gained the `timestamps=false` / `timestamps=true` pair (raw string vs Carbon).
- **`#646` — a no-op ternary in `save()`'s insert column list.** `guarded == ['*'] ? Object.keys(attributes) : Object.keys(attributes)` collapsed to `Object.keys(attributes)`.
- **`#645` (documented, unchanged):** `save()` on an existing model raises `model update affected 0 rows` when the UPDATE matches nothing, where Laravel's `performUpdate()` (`Model.php:1521-1546`) returns `true` silently. Kept as a deliberate fail-loud concurrent-delete detector.
  - Verified: `node --check kernel/model.mjs`; `npm test` in the isolated copy **1099 tests / 1056 pass / 0 fail / 43 skipped** (one new test); shadow harness over the fixture app **12/12 byte-identical, coverage 100%**.

### Fix — a `timestamps = false` model no longer reads its timestamp columns as dates (2026-11-03, audit #644/#646)
Re-sweeping `kernel/model.mjs` line by line against the vendored 13.37 turned up two narrow divergences and one no-op.

- **`#644` — `created_at`/`updated_at` were treated as date attributes unconditionally.** `HasAttributes::getDates()` (`13.37, :1675-1680`) merges the timestamp columns only while `usesTimestamps()` is true, so a `public $timestamps = false` model answers the RAW column: probed on PHP 8.3 + 13.37, `get_debug_type($m->created_at)` = `string` and `$m->toArray()` = `{"created_at":"2024-01-02 03:04:05"}`. The kernel wrapped it in a Carbon / ISO8601 value anyway. `isDateAttribute()` now gates the two columns on `ctor.timestamps !== false`; a SoftDeletes `deleted_at` keeps its date behaviour (the trait declares a `datetime` cast, independent of timestamps).
  - Test: `kernel/tests/model.test.mjs` gained the `timestamps=false` / `timestamps=true` pair (raw string vs Carbon).
- **`#646` — a no-op ternary in `save()`'s insert column list.** `guarded == ['*'] ? Object.keys(attributes) : Object.keys(attributes)` collapsed to `Object.keys(attributes)`.
- **`#645` (documented, unchanged):** `save()` on an existing model raises `model update affected 0 rows` when the UPDATE matches nothing, where Laravel's `performUpdate()` (`Model.php:1521-1546`) returns `true` silently. Kept as a deliberate fail-loud concurrent-delete detector.
  - Verified: `node --check kernel/model.mjs`; `npm test` in the isolated copy **1099 tests / 1056 pass / 0 fail / 43 skipped** (one new test); shadow harness over the fixture app **12/12 byte-identical, coverage 100%**.

### Fix — `eachSpread`/`mapSpread` did not run PHP's `$chunk[] = $key` (2026-11-03, audit #640–#643)
`EnumeratesValues.php:292-296` (`eachSpread`) and `:430-437` (`mapSpread`) are the same two lines — `$chunk[] = $key; $callback(...$chunk)` — and the kernel answered something else for every item that is not an array. `toList()` was the only conversion, so a non-array spread as *nothing*: `eachSpread` called the callback **without the spread at all** and `mapSpread(false)` threw where PHP answers.

- **An item that is not an array raises PHP's own `Error` (`#640`, `#641`).** Probed on 8.3: `collect(['ab'])->eachSpread(fn (...$a) => $a)` -> `[] operator not supported for strings`, a `stdClass` item -> `Cannot use object of type stdClass as array`, `0`/`5.5`/`true` -> `Cannot use a scalar value as an array`. The kernel answered `['ab', 0]`, `[1, 0]`, `[5, 0]` — a silent wrong answer, with the callback running. `false`/`null` are the opposite: the append COERCES them to an empty array, so `collect([false])->mapSpread(fn (...$a) => $a)` answers `[[0]]` (NOT an Error, which is what the kernel used to throw).
- **A Collection item keeps the ArrayAccess contract (`#641`).** `$chunk[] = $key` calls `offsetSet(null, $key)`, so the ITEM gains the key and then spreads — probed: `$inner = collect([1]); collect([$inner])->eachSpread(...)` leaves `$inner` as `[1, 0]` and `mapSpread` answers `[[1, 0]]`.
- **An item carrying a STRING key raises the unpack `Error` (`#642`).** A string key spreads as a NAMED argument and the appended key is positional, so PHP refuses before the callback binds: `collect([['a' => 1]])->mapSpread(fn (...$a) => $a)` -> `Cannot use positional argument after named argument during unpacking`, in both methods. The kernel answered `[1, 0]` in `mapSpread` and spread the *values* in `eachSpread`; the check is PHP's own key coercion (a canonical decimal integer key like `'5'` IS `5` and spreads positionally), which is the same `phpArrayKey` the rest of the kernel uses.
- **One documented LIMITATION (`#643`):** an item keyed `PHP_INT_MAX` answers `Cannot add element to the array as the next element is already occupied` in PHP; the kernel holds that key as a string and reports the named-argument Error instead.
  - Proof: a differential probe against PHP 8.3 + vendored 13 runs, per method, an array / `stdClass` / string / int / float / `true` / `false` / `null` / Collection item and the keyed (assoc, mix, trailing-int) shapes — 32 rows, 0 mismatches; plus a HEAD-vs-now run that shows the old answers above.
  - Test: `kernel/tests/collections-methods.test.mjs` gained the `eachSpread()/mapSpread()` block (23 assertions, every expectation probed against the vendored 13). Full suite green in the isolated copy (`npm test`: 1055 pass / 0 fail / 43 skipped).

### Fix — an error view that cannot compile now names the VIEW, not a route (2026-11-03, audit #312/#313)
Closing the last three open audit rows against the source: `#310` (the build-environment database message) had already landed and is changelogged in the vendor-lite entry above; `#312`/`#313` had landed but were never recorded.

- **`#312` — an app that overrides Blade's compilation no longer stops the build at an error view.** A custom compiler that rewrites `@include`/`$__env->make()` into its own helper (BookStack's theming does exactly this) makes blade2php diverge for every view that passes through it. For a **route** view that stays `BLOCK` — shipping a body that differs from Laravel is a silent divergence — but for an **error** view the status-only page is a faithful fallback, so the divergence is `DECLARED` and the view is skipped from the registry (`~ skipping error view <name> (diverged; status-only page will be served)`) instead of failing the whole build.
- **`#313` — every error-view failure now carries a `view`-area finding.** The transpile refusal already pushed one; the two paths that reach `fail()` before it did not, so the READINESS banner showed whatever `BLOCK` finding happened to be pushed earlier — often a **route** — for a failure entirely inside the error view. Both now push `area: 'view'` first: a missing/rejected dump (naming the view and echoing the `view <name>: ...` stderr line) and a dump that carries no `compiled` string.
- Verified: `node --check build.mjs`; the change is severity/message-only (no `dist/` bytes change), so the existing build/shadow byte-parity coverage is unaffected.

### Fix — three audit gates that were assertion-shaped but not enforced (2026-11-02, audit #628–#630)
Found while asking the repo the question "can the audit claim 100% without reading every line?" — in each case the *check* existed and the *enforcement* did not, which is the same silent-pass shape as the two scanner drops above.

- **`tools/routes-dump.mjs` vs the real oracle — the scan is now proven TOTAL, not sampled (#628).** `tools/tests/routes-dump.test.mjs` pins the Router helpers one at a time (27 cases), but nothing compared the scanner's whole route SET with `php artisan route:list --json`. That is how `health: '/up'` — registered by `ApplicationBuilder::withRouting()`, framework code, not a route file — shipped a 404 on the edge where PHP answers 200 (CHANGELOG, "the app's health route is reported, not silently missing"). The new `tools/tests/routes-oracle-parity.test.mjs` runs **both** on the same app and asserts the sets are equal, minus an explicit `FRAMEWORK_ONLY` allowlist (`up`, `storage/{path}`) that is itself checked for staleness — a captured entry fails, so the allowlist cannot become a hiding place.
  - Verified on the fixture app: 71 scan / 74 oracle rows, exactly the 3 framework-only rows the docs name, 0 name mismatches, 0 invented routes. Negative probe: dropping a route from the scan fails with `the scan silently dropped route(s) the oracle knows: GET|HEAD api/photos#, POST api/photos#`.
  - Wired into the `parity-oracle` CI job, which has both `npm install` (the scan imports `php-parser`) and PHP. The `e2e` job was the first attempt and failed for exactly that reason — it consumes the package as a tarball, so `node_modules` is absent and the scan died on `Cannot find package 'php-parser'`. Verified on a genuinely fresh `composer create-project` app: 1 pass, 0 skipped, exit 0.
  - The same change gives `tools/check-syntax.mjs` the PHP half of its own idea: every `tools/**` helper is `php -l`-ed (33 of them), so a build-time helper's parse error fails the gate instead of the build. Skipped with a note when no PHP is on PATH; a deliberately broken helper fails with its `Parse error`.
- **The shadow harness now fails on a coverage floor (#629).** `shadow/run.mjs` computed `coverage` (`(matched - shaped - structural) / steps`) and **printed** it — `process.exit(failed ? 1 : 0)` only looked at unexplained steps. A run that went green because steps were reclassified as `shape`/`json-equivalent`/`diverges` passed as "100% accounted". The exit now also requires `coverage >= LW_SHADOW_MIN_COVERAGE` (default `1`, i.e. byte-identical — what the release gate means).
  - Verified both ways on the fixture app: real run 12/12 byte-identical → exit 0; `LW_SHADOW_MIN_COVERAGE=1.01` → exit 1 with the floor printed. The `fresh-app` scenario declares **zero** `expect: 'diverges'` steps, so the release gate keeps its 100% byte-identical meaning.
- **`tools/facade-count-check.mjs` — the facade census is measured, not asserted (#630).** `tools/constructs.json` carries `meta.facade_total: 47` as a **number in a file**, and `construct-audit.mjs` prints "the facade coverage is 100%" from it: a facade added by a Laravel bump keeps the audit at "47 of 47" while going unclassified. The audit runs in the `test` job, which has no `vendor/` and cannot count the directory; the new check runs where an app exists and compares the file with `vendor/laravel/framework/src/Illuminate/Support/Facades` (one row per `.php` file, `facade_facade` included — the registry's own definition, 47 = 47).
  - Contract matches its siblings (`validation-messages-check`, `ascii-map-check`): SKIP (exit 0) with no app, `--require` (or `LW_FACADE_REQUIRE=1`) makes the no-app case fatal. Wired into the `e2e` job with `--require`.
  - Verified: SKIP → 0, `--require` without an app → 1, with the app → `47 facades, 47 rows, meta.facade_total=47`; a wrong total → 1.

### Fix — three silent-drop sites in the build-time scanners (2026-11-02, audit #606/#607/#608)
Found by sweeping the tool sources against `Illuminate\Routing\Router` and the filesystem helpers: each one turned a construct the scanner could not read into **nothing at all**, which is the class of divergence the scanners exist to prevent (the route or config key simply is not there on the edge, at 404/`undefined` where PHP answers).

- **`tools/routes-dump.mjs` — `Route::resources([...])` / `Route::apiResources([...])` are expanded now, and the un-expandable helpers are refused (#606).** `isVerbStep` only knew the *singular* `resource`/`apiResource`, so a plural batch chain registered **no routes at all** — the URIs were absent from the table and the edge 404'd what PHP answers. `resources()`/`apiResources()` now loop the map and register one `resource($name, $controller, $options)` per entry (the array KEY is the name, the VALUE the controller), reusing the verified singular path so wildcards, names, `only`/`except` and `parameters` behave identically. `Route::singleton()`/`apiSingleton()` — and a `resources()` whose list is dynamic — cannot be expanded yet, so they are **refused**: the scanner pushes a `... is not expanded by the static scanner ...` diagnostic and `build.mjs` turns it into a `BLOCK` (verdict first, nothing written).
  - Proof vs the oracle: a fixture app carrying `Route::resources(['photos' => C], ['only' => ['index','show']])` + `Route::apiResources(['tags' => C], ['except' => ['destroy']])` → `artisan route:list --json` (Laravel 13.37 / PHP 8.3) and `tools/routes-dump.mjs` produce **6 byte-identical rows** (name, method, uri, action). End-to-end: a build over an app with `Route::singleton('profile', …)` printed `BUILD FAILED: Route::singleton() at routes/web.php is not expanded by the static scanner …`, `READINESS: DOES NOT RUN`, and wrote nothing; the same app without it printed `READINESS: RUNS ON THE EDGE` (coverage 8/8, blade2php 13 byte-identical).
  - Tests: `tools/tests/routes-dump.test.mjs` gained the `resources()`/`apiResources()` expansion (a `deepEqual` against the oracle rows), the dynamic-list refusal and the `singleton()` refusal.
- **`tools/static.mjs` — `storage_path()` joins with the platform separator (#607).** The evaluator hardcoded `base + '\\' + tail`; PHP's `join_paths()` uses `DIRECTORY_SEPARATOR`, so on Linux/macOS (where CI runs) the tool answered `…\storage\framework/sessions` where PHP answers `…/storage/framework/sessions`. It is `path.sep` now, byte-identical to `php -r 'echo storage_path("framework/sessions")'` on the host (arg keeps its internal `/`, matching PHP).
- **`tools/static.mjs` — an un-ported `Str::` method fails loud instead of dropping the entry (#608).** The method map carried a handful of `Str::` statics; every other one (`snake`, `studly`, `plural`, `limit`, …) answered `undefined`, and the array/keyed branches **skip** an `undefined` value — so a `config/*.php` using one booted on PHP with a value and shipped on the edge with the key **missing**. The evaluator is a static tool, so it now **throws** with the method name and the remedy rather than silently diverging. `lateLimit` stays `undefined` on purpose (documented): the one method whose result cannot be static is answered as "no value" and the operator declares the key directly.
  - Tests: `tools/tests/static-str.test.mjs` pins the throw for an unknown method, that a mapped method still evaluates, and the platform-separator `storage_path` join.
- Full suite green in the isolated copy (`npm test`: 1042 pass / 0 fail / 43 skipped).

### Fix — `Arr::dot()` keeps a `stdClass` whole, and the route scanner mirrors the registrar (2026-11-02, audit #623–#627)
Four more divergences the sweep pinned against Laravel 13.37 / PHP 8.3, all on paths the suite and the shadow harness exercise:
- **`kernel/collections.mjs` — `Collection::dot()` recursed a `stdClass` (#623).** `Arr::dot()`'s recurse test is `is_array($value)`; `is_array(new stdClass)` is FALSE, so a `__lwObject`-tagged value is a LEAF. The walk used `typeof value === 'object'`, so `collect(['a' => (object) ['b' => 1]])->dot()` answered `['a.b' => 1]` where PHP answers `['a' => ['b' => 1]]`. It now gates on `isArrayLike()` — the helper that already draws exactly this line for `Arr::flatten()`.
  - Proof: `php -r` on the fixture app (`collect(['a' => (object)['b' => 1]])->dot()->all()` = `{"a":{"b":1}}`) vs the kernel before/after; test added in `kernel/tests/collections.test.mjs`.
- **`tools/routes-dump.mjs` — chain methods compared case-sensitively (#624).** PHP method names are case-insensitive, so `->Name('CasedName')` and `->Middleware('auth')` are real calls. The raw-case compares in `collectModifiers` and `registerGroup` silently dropped them: a `->Middleware('auth')` route shipped on the edge with **the guard not applied**. Both now lowercase first (matching the verb dispatch and `mergeRouteAttrs`).
- **`tools/routes-dump.mjs` — a registrar chain is last-write-wins, not additive (#625, #626, #627).** `RouteRegistrar::attribute()` throws on a second set of one key, and the *last* write wins — but the scanner **summed**: `Route::prefix('a')->prefix('b')->group(fn)` mounted `a/b/` where PHP mounts `b/`; `middleware('m1')->middleware('m2')` answered `[m1, m2]` where PHP answers `[m2]`. A repeated literal array key has the same rule (`['prefix'=>'p1','prefix'=>'p2']` mounts `p2/`, not `p1/p2`). `as()` and `name()` are the **same** registrar attribute. `registerGroup` now takes the winning write (the last one in SOURCE — index-corrected for `chainSteps`' outermost-first order, #627). `withoutMiddleware` still accumulates, which is correct: it is a real Router method whose `->middleware()` appends.
  - Proof: `Artisan::route:list --json` on the fixture app for `prefix('a')->prefix('b')->group()`, `name('n1.')->name('n2.')->group()`, `as('s1.')->as('s2.')->group()`, `['prefix'=>'p1','prefix'=>'p2']`, `->Name()` and `->Middleware()` — the scan now matches every row. Full end-to-end diff of `tools/routes-dump.mjs` vs `php artisan route:list --json`: **9/9 app routes identical** (method, uri, action, middleware, name), 0 invented; the 3 framework-registered rows (`storage`×2, `/up`) stay loudly reported through `notes`.
- Full suite green in the isolated copy (`npm test`: 1054 pass / 0 fail / 43 skipped; corpus 55/55; shadow 12/12 byte-identical).

### Verification — the CPU budget is now measured on the platform, and asserted (2026-11-02, audit #434/#443)
`tools/bench.mjs` measures the hot paths on whatever Node machine runs it — a fast regression detector, but not the budget that matters. The budget is workerd's `cpu_ms` (Free: 10 ms), and the only honest source is the runtime itself: `wrangler tail --format json` reports `cpuTime` and `outcome` per request.
- **`tools/cpu-gate.mjs` (new, `npm run gate:cpu`, A70)** deploys a probe worker that runs the **real kernel hot paths** (router / validator / `Str` / `Collection` / PHP json), drives a continuous load, and reads the platform's numbers back through `wrangler tail`. It asserts a page-like load stays `ok` within **p50 ≤ 10 ms / p95 ≤ 50 ms**, *and* that a burn is caught — because a gate that cannot see a violation is worthless.
- **The tail stream is pretty-printed**, not JSONL: the gate splits it by brace matching (string/escape-aware). Newline-splitting parsed nothing and silently reported "no events", which is how the earlier probe nearly looked green on an empty read.
- **Measured (Free, 2026-11-02):** page-like load (5 ops × 50 iterations, 200 requests over 4 connections) → **cpu p50 5 ms / p95 41 ms / max 62 ms**, 57/57 `ok`, wall p95 44 ms. A single 2.5–3 s burn → **`exceededCpu`**, killed at ~2.02–2.31 s CPU (three runs; the 2020 ms kill point, reproduced). A sustained **1.2 s of burn per request, back to back → 25/25 `exceededCpu`**: the rollover bank absorbs modest overruns (bcrypt-class bursts), never multi-second-per-request load.
- **The probe cleans up after itself** (`wrangler delete --name`, verified), and is skippable with `--keep`; `--no-enforcement-check` adapts it to the Paid plan, `--p50/--p95/--requests/--n/--concurrency/--burn-ms/--sustained-ms` tune the load.
- **Deliberately outside `gate:ci`:** it deploys a worker and needs a logged-in Cloudflare account, which CI does not have. Docs: `COMPILED.md` §0 (the empirical section, rewritten) and `MAP.md` §1/A70.

### Fix — two routes differing only in letter case would share one handler (2026-11-02, audit #366)
The build writes one module per route (`dist/src/controllers/<slug>.mjs`) and one port stub per port (`src/ports/<slug>.mjs`), named by `tools/route-slug.mjs`. The slug kept its case, and the collision guard compared the slugs exactly — but the filesystem the build writes to is **case-insensitive** on Windows and macOS, so `/Posts` and `/posts` (two genuinely different Laravel routes) landed on *one* file and whichever handler was written last served both URLs. Silent wrong answer, on the platform most users build from.
- **`tools/route-slug.mjs` — the slug is case-folded.** Lowercasing is lossless here (the name is a build artifact, never a contract) and it makes every collision check case-insensitive *by construction*, in the one place the rule lives.
- **`tools/routes-dump.mjs`** already refused two URIs that compile to the same module; it now sees the case-variant pair too (the scanner is what the build reads the refusal from).
- **`build.mjs`** gained the same check on the route table it actually writes from, so a case-collision the scanner cannot see still stops the build with the remediation (`rename one route`, or `registry.json` for an app that is not yours).
- The view-name guard (`compiler/src/view-name.mjs`) was already case-insensitive (#352); this closes the route/port side of the same class.
- Tests: `tools/tests/routes-dump.test.mjs` pins the refused pair (`/Posts` + `/posts` → `posts.mjs`) and the folded slug (both fail against the unfolded rule).

### Fix — `Str::slug()` dropped every letter past Latin-1 (2026-11-02, audit #294)
Found by probing the kernel against the oracle: a title carrying European, Greek or Cyrillic letters slugged to garbage. `Str::slug('žluťoučký')` answered **`lu-ou-k`** (the `ž`, `ť`, `č`, `ý` were dropped where portable-ascii transliterates them), `Str::slug('Łódź')` was luck, `Œuvre` lost the `Œ`, and `Ελληνικά`/`Привет мир` came out empty.
- **`kernel/str.mjs` carried a hand-written Latin-1 map.** It covered the Latin-1 supplement and part of Latin Extended-A, and the `ascii()` loop ended in "everything else is dropped" - which is what portable-ascii does with a code point it cannot map, but NOT what it does with `ž`, `Ł`, `Œ`, `ß`, `α` or `д`: those have entries in its tables.
- **The table is generated from the framework itself**: `tools/ascii-map.php` reads `voku/portable-ascii`'s own data and writes `kernel/ascii-map.data.mjs`. `Str::ascii()` is `ASCII::to_ascii($value)` for 'en', which is two steps, and both are now modelled exactly: `strtr()` over `charsArrayWithSingleLanguageValues()` (the merged tables, LONGEST key first, table order breaking ties) and `remove_unsupported_chars()` (line breaks become spaces, then everything outside `[\x09\x10\x13\x0A\x0D\x20-\x7E]` is dropped). The per-code-point `to_transliterate()` bank walk is deliberately NOT modelled: `to_ascii()` only calls it for a language with no table, so it never runs for 'en'.
- **`tools/ascii-map-check.mjs` (new) + `tools/gate.mjs`** - the module cannot rot: the check regenerates the table and compares it positionally with the shipped one (the table order is load-bearing). Same skip/`--require` contract as the validation-messages check, so the CI job that owns a Laravel app makes it fatal.
- **Proven against the oracle**: 757-case and 1,940-case fuzz corpora (Latin-1/Ext-A/Ext-B, Greek, Cyrillic, Hebrew, Arabic, Devanagari, Hangul, CJK, kana, compatibility, presentation forms, fullwidth, math alphanumerics, emoji, combining marks, controls, >64-byte strings) - `Str::ascii` and `Str::slug` are **byte-identical to PHP 8.3** on both, 0 differences. The old map differed on **653/757**.
- **`tools/static.mjs` shares the kernel's slug AND `Str::ascii()` instead of keeping its own** (the same audit, second site): the config evaluator carried an NFD + specials porter that REFUSED a letter it could not map, and its own slug pipeline. Delegating both to `kernel/str.mjs` deleted that duplicate and fixed the divergences the shared pipeline exposed: `Str::slug("it's")` answered `it-s` where PHP answers `its`, a leading separator survived (`@@` -> `-at-at` vs `at-at`), a dropped symbol became a separator instead of vanishing (`দT⥐ɧ⁐᥵Ჯ` -> `dtj` vs `dt`). Probed through `loadConfig` over 254 cases (entities, apostrophes, backslashes, `@`, an ASCII-through-BMP fuzz) - **0 differences** to PHP 8.3, where the old pipeline differed on 20.
- **The static evaluator had no `Str::ascii()` at all (audit #451, same sweep):** an absent `Str::` method folds to `undefined` and the config dump then writes it as `null`, so a `config/*.php` carrying `Str::ascii('žluťoučký')` shipped `null` while the runtime answered `zlutoucky`. `StrMethod.ascii` is the kernel's `ascii()` now. Pinned by `tools/tests/static-str.test.mjs` (removing the entry turns the test red) and by a 127-case differential probe that writes the real UTF-8 bytes into `config.php` and feeds the identical bytes to PHP - **0 differences** against `Illuminate\Support\Str` on PHP 8.3.
- Tests: `kernel/tests/str.test.mjs` pins the PHP values (`žluťoučký` → `zlutoucky`, `Łódź` → `lodz`, `Œuvre` → `oeuvre`, `straße` → `strasse`, `Ελληνικά` → `ellinika`, `Привет мир` → `privet-mir`, `İstanbul` → `istanbul`, `ﬀ` → `ff`, and the drop cases `中文`/`°`/`÷`); the runtime suite's mini-dist harness (`compiler/tests/controller.test.mjs`) stages `kernel/ascii-map.data.mjs` alongside `kernel/str.mjs`, so the tests that import the kernel resolve the new table.

### Fix — a method that is not allowed answered 500 where Laravel answers 405 (2026-11-02, audit #446)
Found by probing the deployed worker: `GET /queue-demo` (a POST-only route) answered the app's **500** page, while the PHP oracle (Laravel 13.37, PHP 8.3) answers **405**.
- **`kernel/http.mjs` tied the status to the view.** The branch answered `has405 ? 405 : 500` and dropped the `Allow` header without a view. Laravel's handler never does that: `renderHttpException()` renders the app's `errors/405` view when it exists and `convertExceptionToResponse()` otherwise, and *that* one uses `$e->getStatusCode()` — **405 either way**. Only the BODY follows the view. The old rule ("else 500") came from the Symfony *HTML* renderer failing to find its own asset in the probe app, not from Laravel's contract.
- Now the answer is Laravel's, byte for byte where the edge can be: status **405**, `Allow: <verbs>` (Symfony's `implode(', ', $allow)`, in Laravel's verb order), `cache-control: no-cache, private`; the app's compiled `errors/405` view (or its `errors/4xx` fallback, which `dist/src/error-renderer.mjs` already resolves) when it ships one; for an `expectsJson` request `prepareJsonResponse()`'s body — `{"message": "The <METHOD> method is not supported for route <path>. Supported methods: <verbs>."}` (`AbstractRouteCollection::requestMethodNotAllowed()`, `JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES`); else the edge's minimal HTML page (the framework's own page is an asset the build does not ship).
- **`tools/config-dump.mjs` / `tools/config-dump.php` — the `errors.405_view` flag is gone.** Nothing reads it once the status stops depending on it, and the compiled renderer's own lookup decides the body.
- **Proven with the oracle and the shadow.** PHP oracle (no `errors/405` view): `POST /posts/1` → **405**, `Allow: GET, HEAD, PUT, DELETE`; `Accept: application/json` → 405 + `{"message":"The GET method is not supported for route queue-demo. Supported methods: POST."}` (99 bytes). The compiled fixture answers identically (status, `Allow`, JSON bytes) and the shadow step flipped from `500/500` to `~ 405/405 — diverges (known)` (only the error page's body differs). The fixture app's `vendor/symfony/error-handler/Resources/assets/` was missing `error.css`/`exception.css`/the icons, which made the *oracle's* HTML render crash into a 500 — the vendor tree was repaired before measuring, so the oracle answers what Laravel answers.
- Docs: README's method-handling row, `COMPILED.md` (two places), `.opencode/context.md` (the M40 correction), the shadow scenario's comment, and the tests (`kernel/tests/http.test.mjs`: the 405 answer, the JSON message, the compiled-view render).

### Fix — the PHP serializer dropped array key order (2026-11-02, audit #449)
Found in the same sweep, and it is the **storage half** of #416: every PHP-array-shaped value in the runtime carries its insertion order in the non-enumerable `__lwOrder` marker (`rt.assoc`, `Arr::dot`, `Collection::phpArray`, `phpJsonDecodeOrdered`), and `phpJsonEncode` honours it — but `kernel/php-serialize.mjs` did not. `phpUnserialize` returned a plain object (so `['a' => 1, 3 => 'x']` came back with JS's integer-keys-first order) and `phpSerialize` wrote `Object.keys(value)`, re-ordering on the way out. Both live paths are affected: the `database` session driver's payload (`PhpSessionSerializer::save()`) and the D1 cache store (`DatabaseStore::serialize()` — a Laravel app reading the same rows, or a kernel read of a row Laravel wrote). Byte proof vs PHP 8.3: PHP `unserialize('a:2:{s:1:"a";i:1;i:3;s:1:"x";}')` → `serialize` = the same bytes; the old JS pair answered `a:2:{i:3;s:1:"x";s:1:"a";i:1;}`.
- `kernel/php-serialize.mjs` — `phpUnserialize` tags its associative result with `__lwOrder` (the PHP order it just read); `phpSerialize` writes the keys through the new exported `orderedKeysOf()`, whose one rule is "marker order first, then every key the marker does not know" — so a key written *after* the marker was set still lands at the end (PHP appends on assignment), and a stale marker can never drop or invent a key.
- `kernel/php-json.mjs` — `phpJsonEncode` now uses the same `orderedKeysOf()` instead of reading the raw marker, closing the stale-marker hole there too (both encoders, one rule: previously the serializer had no key could be appended after the marker, only a marker longer than the object).
- `kernel/cache.mjs` — the **KV-backed** store (`createCache({ kv })`) wrote `JSON.stringify` and read `JSON.parse` while the D1 store in the same module had always used `phpSerialize`; it now writes `phpJsonEncode` and reads `phpJsonDecodeOrdered`, so a cached PHP array keeps its order. The reader is a superset of the JSON one, so an entry a previous build wrote still reads (verified).
- `kernel/redis.mjs` — the `j:` payload is the PHP JSON codec now (write *and* read), same reasoning and the same backward-compatible reader.
- Tests: `kernel/tests/redis.test.mjs` and `kernel/tests/cache.test.mjs` each pin the round trip (stored bytes + the re-encoded read + a legacy plain-JSON entry still readable).
- `kernel/tests/php-serialize.test.mjs` — test **D** pins the round trip (`phpSerialize(phpUnserialize($php)) === $php` for the mixed-key shapes, plus the append case); it fails against the old serializer (proven) and passes after.

### Fix — a queued job's arguments lost PHP's key order (2026-11-02, audit #448)
Found while sweeping the open ledger against the source: the queue payload was written with `JSON.stringify` and read back with `JSON.parse` while the rest of the runtime had already moved to the PHP serializer (`phpJsonEncode` / `phpJsonDecodeOrdered`). The one shape that diverges is an argument array whose **string key precedes an integer-like key** — Laravel's `DatabaseQueue::push()` stores `json_encode($arguments)` (`{"a":1,"3":"x"}`) and hands the job `json_decode($payload, true)`, while `JSON.stringify` reorders it to `{"3":"x","a":1}` (JS enumeration order) and `JSON.parse` reads it back in that order. A job that re-encodes a property it was constructed with, keys it, or returns it would answer with the keys in the wrong order — an invisible divergence in any shadow run, because the runner's own jsons are written with the PHP encoder.
- `compiler/runtime/rt-from-context.mjs` — `rt.queuePush()` binds `phpJsonEncode(args || [])`; `rt.queueDrain()` reads the row with `phpJsonDecodeOrdered(..., { text: true })`, which also matches PHP on an **invalid** payload (`json_decode` answers NULL, `JSON.parse` threw) and keeps a row written by real Laravel readable.
- `compiler/tests/queue.test.mjs` — a regression test pins the round trip (`[{a:1, 3:'x'}]` → payload `[{"a":1,"3":"x"}]` → the job receives `{"a":1,"3":"x"}`); it fails against the old `JSON.stringify`/`JSON.parse` pair (proven), passes after.

### Fix — the event-dump oracle test reported a fixture gap as a code failure (2026-11-02, audit #447)
Running the oracle suite against an app that cannot host the container-binding probe (the audit fixture declares no `register(): void` in its provider and ships no `app/Support/AbstractReporter.php` / `ListenerContract.php`) failed the `event-dump` test with `kind: 'external'` where the assertion wants `kind: 'class'` — a report of a *fixture* shortfall dressed as a code defect. The probe installs `$this->app->bind()` into the app's registered provider and writes its own job class, so the app must supply the two type-hinted support types; `installFixtures()` silently returned when the provider lacked `register()`, and never checked the support classes at all.
- `tools/tests/event-dump.test.mjs` — the fixture prerequisites are checked once at module scope (`bindingFixtureSkip()`): a provider without `register(): void`, or missing `app/Support/{AbstractReporter,ListenerContract}.php`, now **SKIPs with the reason naming the file** (the repo's rule for oracle tests), instead of running the probe against a container it never asked anything.
- Proven: a Laravel-skeleton app (the e2e fixture, which has all three) runs **2/2 pass**; the audit fixture **2 skips** with `the app has no app\Support\AbstractReporter.php, app\Support\ListenerContract.php`; the old file against the same app still fails 1 (the false failure, reproduced).

### Fix — a due schedule event was dropped silently when the app binds no queue producer (2026-11-02, audit #436)
Found by driving the deployed worker: the Cron Triggers fired, the schedule events were pushed — and nothing consumed them. The push went to the kernel's **in-memory** queue (the fallback when `env.QUEUE` is absent), which dies with the invocation, while the answer still said `queued: ["posts:prune"]`.
- **`src/worker.mjs` — `runSchedule()` now reports what it delivered.** A due event is delivered through the app's `QUEUE` producer binding (the app runtime that consumes it lives outside this Worker — the edge triggers, it does not run artisan). Without that binding the payload is not queued at all: the answer carries `dropped: [...]`, and the drop reaches the log (`console.warn`, visible in `wrangler tail`). With the binding the shape is unchanged (`queued: [...]`).
- **`build.mjs` — the missing binding is a declared gap**, in the same voice as the storage/cache binding checks: `${n} schedule event(s) fire through ${m} cron trigger(s), but the app binds no QUEUE producer`, with the `{"queues":{"producers":[{"binding":"QUEUE","queue":"<name>"}]}}` fix and the "or drop the app schedule (the triggers then only drain D1 `lw_jobs`)" alternative. The fixture now reports `READINESS: RUNS WITH DECLARED GAPS (1)` instead of silently shipping a schedule that reaches nothing.
- **Probed against the built entry**: no binding → `{"due":["posts:prune"],"queued":[],"dropped":["posts:prune"],"jobs":{"ran":0,"failed":0}}` + one warning; with a `send()` binding → `{"due":["posts:prune"],"queued":["posts:prune"],"dropped":[],...}` and the producer receives `{queue:'laravel-schedule', payload:{name:'posts:prune', expression:'*/5 * * * *', command:'posts:prune', timezone:'UTC'}}`.
- Test: `kernel/tests/worker-entry.test.mjs` (the due event is injected through the built fixture's own `schedule.generated.mjs`, which is restored afterwards, and the handler runs in a child process because the parent's module graph is cached — it FAILS against the old `delivered = true` behaviour). Docs: `COMPILED.md` (the cron-trigger section) and `MAP.md` (the scheduler row).

### Fix — the HTTP cron face fired the schedule but never drained the queue (2026-11-02, audit #437)
Found by driving the deployed worker: `POST /__lw/cron` (the schedule's HTTP face) answered `{"ok":true,"due":[...],"queued":[...]}` with **no drain** — a job row dispatched by that trigger sat in `lw_jobs` until the next real Cron Trigger fired, so the face was not the trigger's equal.
- **`src/worker.mjs`** — the face now mirrors `scheduled()` exactly: `runSchedule()` then `drainQueue()`, answering `{ok, ...due, queued, jobs}` (`jobs` is the drain's `{ran, failed}`). The `404` without `LW_CRON_SECRET` is untouched.
- **Proven live and locally.** On Cloudflare: `POST /__lw/cron` with the secret → 200 `{"ok":true,"due":["posts:prune"],"queued":["posts:prune"],"jobs":{"ran":0,"failed":0}}` (the drain result is in the answer), wrong secret → `404`. Locally: `kernel/tests/worker-entry.test.mjs` seeds a `lw_jobs` row and asserts the face consumes it (`ran + failed === 1`, the `DELETE` issued) — the test fails against the old face.

### Fix — a job the class compiler refused was queued anyway and silently never ran (2026-11-02, audit A96)
Found by driving the built worker on Cloudflare: `POST /queue-demo` answered 200 and wrote a `lw_jobs` row (`attempts: 0`), the `*/1` cron trigger fired — and the row sat there forever. The job class used Laravel's own bus traits (`use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;`), so the class compiler refused the class with LW002, `handle()` never reached `dist/src/classes.generated.mjs`, and the drain's handler map (`src/worker.mjs` `jobHandlers()`, filtered on `methods.handle`) had no entry for it: the cron consumer dropped the row unseen. The build's queue check only asked "is there a cron trigger?", never "did the job compile?".
- **`compiler/src/classes.mjs` — the four Laravel bus traits are allowed.** `Dispatchable`'s static `dispatch*()` is answered at the CALL SITE (`Job::dispatch($x)` → `rt.queuePush(fqcn, [args])`; the emitted handler never calls the trait's own method), `SerializesModels`' hooks exist for PHP's serializer (the edge's payload is the row's JSON), and `Queueable`/`InteractsWithQueue` add instance members only the app's own bodies can reach. A class whose body CALLS one of those members (`$this->release(3)`, `$this->attempts()`, `self::dispatchSync('x')`) is still refused LW002 with the member named — the compiled rung has no such method, so Laravel's re-queue/delete/attempts semantics would not happen (a different behaviour, silently). The scan walks the AST (a `call` on `$this`/`self`/`static`), so a property of the same name, a comment or a string never refuses a class, and a method the class declares itself is not the trait's. A short trait name resolves through the file's own `use` imports; a leading `\` is stripped.
- **`build.mjs` — the queue check refuses a push whose job class did not compile.** The `BLOCK` finding names the route, the job FQCN and the class compiler's own reason for the class, so the deployment stops instead of shipping a route that answers 200 and does nothing.
- **Proven on Cloudflare.** `POST /queue-demo` → 200 `queued`, row `App\Jobs\SendWelcomeNote` / `["queued-from-route"]` / `attempts: 0`, then the `*/1` cron trigger: the row is gone (the drain deletes it only on success) and the D1 blob `jobs/last.txt` holds `queued-from-route` (17 bytes) — the payload reached `$this->note` and `handle()` ran. Rebuilding the same fixture with `Notifies` in the trait list, or with `$this->release(3)` in the body, now fails the build: `BUILD FAILED: the route(s) /queue-demo dispatch a queued job whose class did not compile (App\Jobs\SendWelcomeNote)`.
- Docs: the construct ledger's queue rows (`queue_push`, `job_dispatch`, `listener_queued`, `listener_queue_push`, `facade_queue`) and the COMPILED.md/MAP.md reasoning no longer claim "the job class is not compiled either" (false since M63) or "the edge has no producer for it" (the compiled `Job::dispatch()` is one).
- Tests: `compiler/tests/classes.test.mjs` (+4: the bus traits compile, a member call is refused, the class's own member is not, an unknown trait next to them still is).

### Fix — an unhandled exception answered the platform's `error code: 1101` instead of Laravel's 500 (2026-11-02, audit `#442`)
Found by driving the built worker on Cloudflare with a route that throws `RuntimeException('shadow boom')`, with the tail (`wrangler tail --format json`) showing `outcome: exception` and a stack that ended at the Worker's own `fetch`.
- **`kernel/http.mjs` — `renderException()` ended in `throw error` for every Throwable that was not an `HttpError`.** Laravel's `Handler::render()` never rethrows: `prepareException()` wraps the Throwable in an `HttpException` with status 500, and `prepareResponse()` renders `errors/500` (or `prepareJsonResponse()` for an `expectsJson` request, whose `convertExceptionToArray()` answers the literal `Server Error` outside debug). The rethrow escaped `handleHttp`, and the Worker's `fetch` has no catch of its own, so the platform answered its plain-text `1101` — no app page, no message, `outcome: exception` for every 500.
- **`compiler/src/controller.mjs` — the emitted handler's 500 fallback ignored the `wantsJson` it had already computed.** `X-Requested-With: XMLHttpRequest` or `Accept: application/json` made `expectsJson()` true, which skipped the error view *and* skipped `rt.errorResponse` (the error carried no `.status`), so the handler rethrew. It now answers `prepareJsonResponse()`'s body, byte for byte: `{\n    "message": "Server Error"\n}` (`JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES`).
- **Proven on Cloudflare, before and after.** `/throw-demo` with `Accept: text/html` was already correct (the app's `Server Error` page); with `Accept: application/json` or `X-Requested-With: XMLHttpRequest` it answered `1101` and now answers 500 `{"message":"Server Error"}`. The D1 1.5 MB object cap (`/upload-big-demo`, 1.6 MB) is the same path: it fails loud with the kernel's message and now reaches the client as that 500 (HTML or JSON) instead of `1101`.
- The fail-loud contract is untouched: a render that *itself* fails (the `lwRenderFailed` tag `buildChain`/`handleHttp` set) still rejects the promise.
- Tests: `kernel/tests/http.test.mjs` (the exception branch: the status-only 500, the compiled view when `renderErrorView` is on the ctx, and the `prepareJsonResponse` bytes) and `compiler/tests/controller.test.mjs` (the emitted handler: rethrow only without a view, the view, and the JSON body).

## v0.4.7 — the deployed scheduled handler, PHP-faithful json, and the strict-engine fixes (2026-11-02)

### Fix — the deployed `scheduled` handler had the wrong signature, so a Cron Trigger silently did nothing (2026-11-02)
Found by probing the built entry (`dist/src/worker.mjs`) with the Workers runtime's real call contract, after deciding to drive the schedule with a Cloudflare Cron Trigger.
- **`src/worker.mjs` declared `async scheduled(env, ctx)`; the runtime calls `scheduled(controller, env, ctx)`** — the CONTROLLER is the first argument (it carries `cron`, `type` and `scheduledTime`), exactly as `fetch(request, env, ctx)` puts the request first ([Workers scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)). `build.mjs` copies the file verbatim into `dist/src/worker.mjs`, so at a real Cron Trigger the parameter named `env` was bound to the controller: `runSchedule(controller)` → `makeQueue(controller)` → `controller.QUEUE` undefined → the schedule push fell to the dead **in-memory** queue, and `drainQueue(controller)` → `controller.DB` undefined → returned `{ran: 0, failed: 0}` so the D1 `lw_jobs` table **was never drained**. Every scheduled job and every `Job::dispatch()` was a silent no-op at the edge. The `/__lw/cron` HTTP face worked (there `env` is genuine), and the shadow harness never calls `scheduled()`, so nothing caught it.
- Now `async scheduled(controller, env, ctx)`, and the due test uses `controller.scheduledTime` (the instant the trigger was scheduled for, ms since the epoch) with a `new Date()` fallback — the trigger can arrive late, and `new Date()` tested the arrival moment, not the scheduled one.
- Probed against the built worker: with the runtime's `(controller, env, ctx)` order the handler reads the real env; with the old `(env, ctx)` order it read the real env **zero times** (`reads: []`). Full path with a due event: `scheduledTime` detects the due event and pushes `{queue: 'laravel-schedule', payload: {name, expression, command, timezone}}` onto `env.QUEUE`.
- **Proven in a real `workerd`, not only in Node.** `wrangler dev --test-scheduled` (v3) fires the handler through `/__scheduled?cron=…` with the runtime's own argument order. With a seeded `lw_jobs` row and one job handler registered, the fixed worker **deletes the row** (the drain reached D1: `count = 0`); the old `(env, ctx)` signature leaves it (`count = 1`). Both runs log "Ran scheduled event" — the silent no-op, reproduced end to end.
- Regression test: `kernel/tests/worker-entry.test.mjs` loads the built entry and calls it with the runtime's real argument order, asserting the real env's `DB`/`QUEUE` are read and the drain result is returned (it FAILS against the old signature: `reads: []`; it SKIPs, with a reason, when no built app is present). The `e2e` CI job runs it through `tools/oracle-ran.mjs` after the build, so a skipped run fails the step instead of passing green.

### Fix — an absent route segment for a required parameter answered 200 where Laravel answers 500, and a model-bound parameter with an optional segment answered 404 where Laravel builds a fresh model (2026-11-02)
Found by probing every optional-route-parameter shape through the shadow harness (`shadow/run.mjs` + `tools/php-shadow-oracle.php`) against a scratch app, with PHP 8.3.30 + Laravel 13.37 (the shape `{a?}` **not** last was already faithful — the kernel compiles it REQUIRED, like Symfony — so the leak was the last one).
- **`rt.param` now re-splices an absent parameter the way PHP does.** The route carries no value for the parameter: Laravel's `RouteDependencyResolverTrait::resolveMethodDependencies()` splices the parameter's default, or a null for a parameter that `allowsNull()` — and **nothing at all** for a parameter with no default and no nullability, so PHP 8 throws `ArgumentCountError` ("too few arguments") and Laravel answers 500. The runtime answered `null` there, a **200** where Laravel answers 500. Probed: `/v/{a}/{b?}` with `req(string $a, string $b)` on `/v/A` → PHP 500, compiled 200 `{"route":"req","a":"A","b":null}`; same for a `mixed $b`. Now both answer the framework's 500 page byte for byte.
- **The implicit model binding handles an absent optional segment.** `compiler/src/controller.mjs` emitted `rt.model(<FQCN>).findOrFail(rt.param(...))` unconditionally, so a route like `/posts/{post?}` with `show(Post $post)` ran `findOrFail(null)` and answered **404** where Laravel's container builds a **fresh, empty model** (`transformDependency()` falls through to `make($className)`) and answers 200. The emitted handler now guards the segment (`ctx.params["post"] === undefined ? <absence> : (await rt.model(...).findOrFail(...))`), where `<absence>` is the signature default when the parameter has one and `rt.newModel(<FQCN>)` (new in `compiler/runtime/rt-from-context.mjs`, Laravel's `container->make()`) otherwise. Probed: `/p/{post?}` + `mb(?Post $post)` and `/q/{post?}` + `mb2(Post $post)`, both `/p` and `/q` → PHP 200 `{"isNull":false,"id":null}`, compiled used to answer 404.
- **`Model::get()` answers NULL for a cast-declared key that is not in the attribute array.** Eloquent's `getAttributeFromArray()` is `$this->getAttributes()[$key] ?? null`, so a cast-declared key with no value (`$fresh->id`, `$fresh->getKey()`) is `null` — not `undefined` (the kernel answered undefined through `get()`, and only the JSON encoder hid it: `undefined` in an object is dropped, `NaN` is `null`). `kernel/model.mjs` now normalizes the absent attribute to `null` before the accessor/cast path. This is what makes the fresh model from the bullet above read exactly like Laravel's.
- New tests: `compiler/tests/rt-blade.test.mjs` (an absent parameter: default → null → loud `TypeError`, the PHP rule), `kernel/tests/model.test.mjs` (a fresh model reads a missing cast-declared attribute as `null`), `compiler/tests/controller.test.mjs` (the emitted model-bound guard for an optional segment, and the signature-default branch).
- Verification: the scratch-app probe is **16/17 byte-identical, 0 unexplained** except the one deliberate unmatched-URL class (the platform's 404 where Laravel renders the framework's HTML 404 page — see `kernel/http.mjs`, "no route at all: the platform's 404"); `npm run gate:ci` green (1054 tests, corpus, gate, bench, check-syntax, pack-gate) and the fresh-app shadow run 12/12 byte-identical.

### Fix — the `unique` except id was bound as an integer (so a TEXT primary key was never excluded) and `#337`'s `.env` escapes were still half done (2026-11-02)
Both found by probing the kernel against real Laravel 13.37 + PHP 8.3 over SQLite (`tools/php-unique-exists-oracle.php`, a spy `PresenceVerifier`, and a `Dotenv::createImmutable()` fixture).
- **`kernel/validator.mjs` — `unique` with an `except` id answered the OPPOSITE verdict on a TEXT primary key.** `validateUnique()` ends with `stripslashes($id)`, and PHP's `stripslashes()` answers a **string** even for an int subject (`stripslashes(7)` is `'7'`; a spy verifier reports `'7'` for `unique:users,email,7,id`). The kernel ran the slash-strip only for string ids, so the int 7 reached the query and SQLite's TEXT affinity never compares `'7'` equal to `7` — the excluded row matched and a **valid** input was reported "already taken" (and the mirror case, `unique:u,a,007,id`, agreed only by accident). Now every non-null id goes through `phpStripslashes()`, exactly as the vendor does. Probed: `unique:u,a,7,id` / `\7` / ` 7 ` on a table with `id = '7'` → PHP PASS, kernel now PASS (was FAIL); `007` / `abc` → FAIL on both.
- **`tools/static.mjs` — `dotenvValue()` still mangled four escape forms (`#337` was only half-closed).** It ran `\n`/`\r`/`\t` first and then replaced every **raw** quote with a quote (a no-op), so `"a\"b"` stayed `a\"b` and `\\`, `\$`, `\v`, `\f` were untouched. phpdotenv's `EntryParser` unescapes exactly `\n` `\r` `\t` `\v` `\f` `\"` `\\` `\$` in ONE pass; every other `\x` keeps its backslash — the fold is deliberately LENIENT there and does not abort the file (decided, not overlooked: an app whose `.env` uses an unsupported escape already carries a different value in PHP, so aborting the build would report a divergence the build itself caused). Probed through `Dotenv::createImmutable()`: PHP answers `a"b`, `a\b`, `a$b`, VT, FF, and `a\qb` for `"a\qb"`. All ten fixture values are now byte-identical between PHP and the fold.
- Tests: `tools/tests/env-fold.test.mjs` (the full escape set, one pass), `kernel/tests/validator.test.mjs` (a `unique`-except pin, plus six new rows in the live-oracle matrix and the pinned verdict list).
- Re-verified rather than assumed, and CORRECTED in the ledger: `#67` (`parsePhpQuery` decodes `%XX` byte-wise with a strict hex pair), `#294` (`Str::slug` refuses an unmappable letter instead of emitting a different slug), `#342`/`#350` (both write paths now `exit(1)` on a failed `file_put_contents`), `#346` (`lw_app_psr4_dirs` covers subdirectories), `#337` (see above — its earlier "FIXED" ledger row was a false positive), `#338` (`phpStr` casts `true`→`'1'`, array→`'Array'`), `#375`/`#378` (by-design, safe direction).
- **`#283` CLOSED by probe, not by reading.** Every sub-item is Laravel's: the case-insensitive `null` test also covers non-string ids (`strtolower(null)` is `''`), the bracket regex is unanchored exactly like the vendor's, `FILTER_VALIDATE_INT` is ported, `stripslashes()` runs, and an EMPTY `except` still emits the clause — a spy verifier reports `''` (not `'NULL'`) at `getCount()`, so the `id = ''` row is excluded. Live oracle: `unique:u,a,,id` → a = `'v2'` PASS, a = `'v1'` FAIL; the kernel matches both.

### Fix — the loose-equality backend refused ARRAY items, four keyed methods wrote PHP's key guards to nobody, and PHP's array order was lost through `all()`/`collect()` (2026-11-01)
Found by running the whole `Collection` surface (8 sets × 69 methods, 552 cells) through the real vendor on PHP 8.3.30; the harness is `tools/_api3.php` + `_api3-js.mjs` + `_api3-diff.mjs`.
- **`(bool)` had no array branch.** `phpBool([])` answered `true` (the JS `!0` instinct) where PHP's `(bool) []` is `false`, so `contains()`/`search()`/`filter()` over array items diverged. `phpBool` now honours `Array.isArray(v) ? v.length > 0 : v instanceof Collection ? v.count() > 0`.
- **Two objects were never `==`, and an array was never `==` a scalar.** `looseEq` compared objects by identity (PHP: `(object) ['x' => 1] == (object) ['x' => '1']` is true) and had no array branch at all; the bool branch also sat after the array/object one, so `phpBool` was bypassed. `looseEq` now casts through `(bool)` for array-vs-bool/null, answers `true` for array-vs-`1`, `false` for array-vs-string, and recurses into `phpLooseEquals` for two objects.
- **`phpLooseEquals` only matched arrays by identity.** `unique()`, `duplicates()`, `where()` and `search()` over ARRAY items were wrong: `[[1, 2], [1, '2']]->unique()` kept 2 items where PHP's `array_unique(..., SORT_REGULAR)` keeps 1 (arrays compare recursively with `==`), and `[[1, 2], []]->contains(null)` answered `false` where PHP's `null == []` is `true`. A new `phpArrayLooseEquals` compares the key sets (PHP coerces them) and each value with `looseEq`, order-insensitively.
- **`median()` invented `NaN` where PHP throws.** `Collection::median()` on an even count runs `$middle[0] + $middle[1]` through PHP's `+`, which throws `TypeError: Unsupported operand types: int + string` for a non-numeric pair; the JS form answered `NaN`. The pair now goes through `new Collection([a, b]).sum() / count()` so the same `TypeError` surfaces.
- **`countBy`/`mode`/`keyBy`/`groupBy` accepted an array or object as a key.** PHP reaches `isset($results[$value])`/`array_key_exists($key, ...)`, which throws `TypeError` with a method-specific message (`Cannot access offset of type array in isset or empty`, `... on array`, `array_key_exists(): Argument #1 ($key) must be a valid array offset type`); JS silently keyed on `"[object Object]"`/`"1,2"`. A shared `assertKeyable()` now raises PHP's message per call site.
- **`mapSpread()` silently no-oped on a non-array item.** PHP's `$fn(...$item)` throws `Cannot use a scalar value as an array` / `[] operator not supported for strings` / `Cannot use object of type stdClass as array` / `Unknown named parameter $n`; the port answered `[]`/`undefined`. It now throws the matching `Error`.
- **PHP's array ORDER was lost on the way out of a collection.** A JS object literal — and `Object.keys()` — lists an integer-like key first, so `countBy()` over `[3, 1]` encoded `{"1":…,"3":…}` where PHP answers `{"3":…,"1":…}`, and `new Collection({'k' => 1, 0 => 2})` both reordered the keys AND paired the values with the wrong keys. `phpArray()`/`all()`/`toArray()` now attach the non-enumerable `__lwOrder` marker the encoder already honours, and the constructor reads that marker (and a source Collection's `phpKeys`) so keys and values stay paired. `collect($collection)` also keeps the keys now, matching `Enumerable::getArrayableItems()` → `$items->all()`.
- **`phpNumeric`'s error message** used the JS `typeof` (`object`) where PHP names its own type (`array`, `stdClass`, …); it now uses `phpDebugType`.
- Verification: `npm test` **1026 tests, 986 pass / 0 fail / 40 skip**; `tools/gate.mjs` PASS (docs 105/105, construct-audit 115); shadow **12/12 byte-identical, coverage 100%**; the 552-cell matrix has no kernel-side diff left after separating the harness artifacts (`explode` is absent from the kernel by design, the JS mirror passes raw callbacks instead of PHP operators, and `JSON.stringify` in the harness re-sorts integer keys).
- Four test FIXTURES were unsound and are corrected (not the source): a JS object literal cannot express PHP insertion order, so `shift_keyed`/`splice_keyed`/`add`/`merge_mixed`/`concat_keyed` in `kernel/tests/collections-methods.test.mjs` and `collections-where.test.mjs` now build their expectations with an `assoc()` helper that sets `__lwOrder`, and the expectations are the bytes recorded from PHP (`tools/_ord*.php`).

### Fix — `Collection::min()`/`max()` used a comparison PHP does not have, and the shared `phpCompare()` spaceship was wrong for equal numerics and for a number against a non-numeric string (2026-11-01)
Found by diffing `Collection::min()`/`max()` against the vendor on a 16-set matrix of mixed types; the old loop carried **8 of 48 cells** away from PHP.
- **`min()`/`max()` re-seeded on a NULL in the middle and compared with the wrong operator.** `EnumeratesValues::max()` is `map($callback)->reject(fn ($v) => is_null($v))->reduce(fn ($r, $v) => is_null($r) || $v > $r ? $v : $r)` — the nulls are **removed first**, then the fold uses PHP's `>`/`<`. The JS loop tested `phpCompare(item, best) > 0` and re-seeded whenever `best === null`, so `collect(['', null, false])->min()` answered `false` (PHP: `''`) and `collect(['a', null, 'b'])->max()` answered `null` (PHP: `'b'`). The callback also bypassed `valueOf()`, so a string key was never read.
- **The `phpCompare()` spaceship itself diverged in two directions.** `isNumeric(a) && isNumeric(b) ? (Number(a) < Number(b) ? -1 : 1)` never answers `0`, so `'0.0'` and `'0'` compared "less" forever: `max(['0.0', '0'])` answered `'0'` where PHP keeps the first (`'0.0'`). And `isNumeric(a) !== isNumeric(b) ? (isNumeric(a) ? -1 : 1)` sorting every number BEFORE a non-numeric string is the PHP 7 rule; PHP 8 casts the number to a STRING and compares bytes — **`2 > '10a'`** (probed: `2 <=> '10a'` is 1), so `max(['10a', 2])` is `2`, not `'10a'`, and `min([2, '10a'])` is `'10a'`.
- Fix: `phpCompare` is now the already-verified `phpSortCompare()` (PHP 8's zend/SORT_REGULAR comparison), and `phpLt`/`phpGt`/`phpScalarCompare` give the `<`/`>` operators, including PHP's rule that an **array or object outranks any scalar** (`max([2, [1]])` is the array — probed: `[1] > 2` is true, `2 < [1]` is true). `min`/`max` map through `valueOf`, drop the nulls, then fold with those operators.
- Verification: the min/max matrix is **0 divergences across 16 sets** (was 8 cells); `npm test` **1026 tests, 986 pass / 0 fail**; `kernel/tests/collections.test.mjs` 41/41 with the new regressions (null in the middle, `['10a', 2]`, `[2, '10a']`, `['0.0', '0']`, booleans); shadow **12/12 byte-identical, coverage 100%**, exit 0.
- `sort()`/`sortBy()` were re-verified as well: PHP's `asort()` behaves as `usort(…, fn ($a, $b) => $a <=> $b)` on every probed pair, so the faithful comparator already served them. Two limits stay declared in `COMPILED.md` §6: PHP compares two non-numeric strings **byte-wise** (code-point order) while JS walks UTF-16 units, which disagrees only for a supplementary-plane character against a U+E000–U+FFFF one (`'😀' > '＀'` in PHP, `<` in JS), and PHP's mixed-type comparison is not transitive (so `asort` on a set mixing numbers, non-numeric strings and booleans is algorithm-dependent in PHP itself).
### Fix — a vendor-lite cache could silently boot an application with no package auto-discovery, and prerender could blame the app for the build machine's missing database (2026-11-01)
Found while sweeping ten real applications (BookStack, cachet, monica, akaunting, koel) through the build; the first two broke every one of them.
- **vendor-lite never wrote Laravel's `vendor/composer/installed.json`.** `Illuminate\Foundation\PackageManifest` reads that file (through `COMPOSER_VENDOR_DIR`/`base_path('vendor')`), so with vendor-lite provisioning the manifest came out empty: **every package's `extra.laravel.providers`/`aliases` was invisible** and the build booted a framework with none of the app's service providers registered. Measured on cachet: `bootstrap/cache/packages.php` 23 bytes → **4830 bytes** after the fix; `bootstrap OK, providers=0` → **66** (Spatie settings/data/query-builder/webhook, Cachet core/dashboard/badger, Filament). The build reported a *different* application's error (`SettingsRepositoryFactory::array_key_exists(): null given`), never the cause.
  - Fixes: `tools/vendor-lite.mjs` now emits `installed.json` (`installedJsonOf()`, the same `{packages,dev,dev-package-names}` shape composer writes; `extra` passed through from the lock by `composer-resolve.mjs`), and creates `vendor/composer/` even when the app depends on no `composer/*` package; `tools/_root.php` exports `COMPOSER_VENDOR_DIR` from `LW_VENDOR_DIR` (the single framework touch point: `PackageManifest.php:59`).
  - **Cache entries written before the fix heal in place instead of being reused empty** (the hash covers only `composer.lock`, so an old entry would HIT forever and keep the bug): on a hit, a missing `installed.json` is rebuilt from the entry's own `composer.lock` — no download, works offline — and only an entry that kept no lock is re-provisioned.
  - Tests: `kernel/tests/vendor-lite.test.mjs` pins the manifest shape and the heal-on-hit path (a pre-fix entry on disk ends up with the manifest and an untouched autoloader).
- **`prerender` failures caused by the build machine's missing database were reported as app bugs (BLOCK).** The classifier only knew the D1/`not configured` shapes, so a MySQL/Postgres app whose server is unreachable failed the build with "fix the route" — a condition the build can never satisfy, on apps that work fine once deployed. `tools/readiness.mjs` now owns the predicate (`isBuildEnvDbFailure`, exported and unit-tested): SQLSTATE class 08, `[2002]`/`[2003]`/`[1049]`, "No connection could be made"/"Connection refused", "could not find driver" → **DECLARED**, worded as "the build cannot prerender a route that needs a live connection — give the build a reachable database (sqlite fallback) or declare the binding". A real `no such table` still stays BLOCK with its own migration hint (the regex requires a driver code, so `SQLSTATE[HY000]: General error: 1 no such table` is untouched).
- Verification: `npm test` in the isolated copy **1022 tests, 982 pass / 0 fail** (40 skips are the pre-existing app-gated oracle files); the cachet boot proof above; the heal proven both against a real 142-package cache entry and in a unit test that runs offline.
### Fix — Eloquent's `decimal:N` and `string` casts diverged from PHP on inputs PHP accepts (2026-11-01)
Found while comparing `kernel/model.mjs` against the vendor cast implementations; both were probed against PHP 8.3.30 + Laravel 13.37 with the framework's own `brick/math`, and a 258-row value matrix now reports **0 value divergences**.
- **`decimal:N` rejected what PHP accepts and accepted what PHP rejects.** The cast is `BigDecimal::of((string) $value)->toScale(N, RoundingMode::HalfUp)`, and `Brick\Math\BigNumber`'s parser is not the JS regex instinct: `' 2.5 '/`'2.5 '` (surrounding whitespace) and `'1e3'` all **work** in PHP (`'1e3'` → `'1000.00'`, `'.5e1'` → `'5.00'`, `'1.e3'` → `'1000.00'`, `'-1.5e2'` → `'-150.00'`), while `' 2.5'` **throws** — the old `^\s*…$` form had both directions wrong. The new parser implements the real coefficient/exponent grammar (digits, an optional fraction, an optional exponent), normalises only trailing zeros (stripping leading zeros keeps the scale; stripping trailing ones multiplies by ten), and prints `'-0.001'` to 2 places as `'0.00'` — BigDecimal normalises `-0` away, so the sign never survives an all-zero coefficient. `'1e'`/`'e3'`/`'1_000'`/`'1,5'`/`''` keep throwing, with the same `MathException`/message PHP produces. Rounding on the decimal string (not the binary double) was already correct and is unchanged: `'2.675'` → `'2.68'`, where `toFixed()` says `'2.67'`.
- **`string` cast invented `'a,b'` for an array.** PHP's `(string) [1,2]` is the literal `'Array'` (with an `Array to string conversion` warning) and an object throws `Error: Object of class … could not be converted to string`; JS `String([1,2])` silently joined with commas — a stored/rendered body that differs from PHP's for a same input. `applyCast` now uses PHP's cast, and that cast exists **once**: `phpStringCast` (plus `phpFloatToString`/`formatPhpG` for `precision=14`, e.g. `1e-5` → `'1.0E-5'`) moved from `kernel/validator.mjs` into `kernel/str.mjs`, where the validator and the model both import it instead of carrying two definitions of PHP's coercion.
- Tests: `kernel/tests/model.test.mjs` pins 43 oracle rows for `decimal:N` (accepted values, all four exponent shapes, negative zero, every rejected spelling) and the `string` cast; the shared helper is covered transitively by the validator suite.
- Verification in the isolated copy: `npm test` **1026 tests, 986 pass / 0 fail**, corpus 55/55, `gate.mjs --strict` PASS, shadow 12/12 byte-identical, 0 unexplained.
### Hardening — the perf budget test confirms a failure instead of flaking on a busy host (2026-11-01)
The one unexplained suite result in the audit (`1007 pass / 1 fail`, unreproducible afterwards) was reproduced and fixed.
- `kernel/tests/budget.test.mjs` asserts **wall-clock** budgets (`avg ≤ 2 ms`, `p95 ≤ 5 ms`; the bcrypt `hashed` block `avg ≤ 25 / p95 ≤ 40`) while `node --test` runs that file in parallel with the rest of the suite. With 24 busy processes on 12 cores the bcrypt block measured `p95 92–137 ms` and failed **3 of 3** runs; the earlier flake was the same file on a contended host (the audit's parallel background loops were enough).
- The measurements moved into `measureBudgets()` and the test now confirms a failure with **one re-measurement**: a contended host is transient, a regression is systematic. The budgets are unchanged, both runs must clear them, and a confirmed failure reports both numbers. A retry that passes writes the noise to stderr (`budget: re-measuring after host contention - <first failure>`), so it is visible in the log instead of swallowed.
- Verification: the mechanism was proven with a scratch copy that forces the first measurement to fail (retry → PASS + the note) and one that fails both (FAIL with `confirmed by a second measurement; the first: …`), plus 8 clean suite runs and the sustained-load reproduction above. `npm test` **1018/1018**.
### Fix — the oracle tests no longer depend on a developer's machine (2026-11-01)
`kernel/tests/oracle-app.mjs` shipped a **machine-local absolute path** as the default app root (`C:\Users\HP\AppData\Local\Temp\opencode\lw-fresh-e2e\fresh-app`), duplicated verbatim in `compiler/tests/formrequest-dump.test.mjs` and `tools/tests/event-dump.test.mjs`.
- Effect: whether the PHP oracle parity *ran* or *skipped* depended on a leftover directory on one machine — the author's Windows runs exercised the oracle, every other checkout (and CI, which sets `LW_LARAVEL_APP`) skipped it. Three copies of the path meant three places to drift.
- The resolver now lives in `kernel/tests/oracle-app.mjs` alone: `LW_LARAVEL_APP` wins, otherwise the conventional repo-root `parity-app` / `e2e-app` directories (the ones the CI jobs create), and nothing else. Both other test files import it. Verified: with no app the oracle files skip with the reason (exit 0); with the app reachable the same files run (42/42).
- Found while proving that: the `event-dump` byte-for-byte test compared two dumps that embed absolute file paths, so PHP (which reports `realpath()`) and the port (which echoes the root it was handed) disagreed **only** by the app-root prefix when the app is reached through a symlink or a Windows junction. The comparison now normalizes exactly those two root forms and stays byte-exact for the rest.
### CI — one definition of "verified", and the parity gate can no longer pass on a skipped oracle (2026-11-01)
- **The oracle gate was a trap.** `ci.yml`'s `parity-oracle` job re-checked the run with `grep '# skipped 0'` on the TAP text — the grep decided the step's exit status, so a **failing** oracle run (which also prints `# skipped 0`) passed the step that existed to guard it, and the check was coupled to one Node version's wording. `tools/oracle-ran.mjs` replaces it: it runs the set itself and fails unless `node --test` exits 0 and the parsed summary reports ≥ 1 passing test with 0 failed/skipped/cancelled/todo — an unparseable summary is a failure too, never a silent pass. Verified on all four shapes (app present → 42/42 exit 0; no app → exit 1 with the fix; a failing test → exit 1 `no test passed; 1 test(s) failed`; a skipped test → exit 1 `1 test(s) skipped`).
- **The verify steps were written out three times** (`ci.yml`'s `test` job, `publish.yml`'s `publish` and `publish-gpr`), which is how a release gate drifts behind CI. They are now `npm run gate:ci`: suite, corpus, `tools/gate.mjs --strict`, benchmarks, the shipped sources parsing, and the tarball gate — one definition, run identically by CI and by a release. Deliberately **not** a `workflow_call` reusable workflow: turning the `test` job into a `uses:` job renames its check (`test / …`), which silently breaks branch protection.
- The POSIX-only syntax step (`find … | xargs -n1 node --check`) became `tools/check-syntax.mjs`, so the same check runs on a Windows checkout: `check-syntax PASS: 147 shipped ESM files parse` (negative-tested with a deliberately broken file → exit 1). The GPR publish step also restores `package.json` through a shell `trap`, so the scope rename cannot survive a failed publish.
- Verification: `npm run gate:ci` end-to-end in the isolated copy → exit 0 (docs 105/105, construct-audit 115, corpus 55/55, bench PASS, `pack-gate OK: 21 build/CLI modules + 12 README-linked docs shipped (143 files)`, check-syntax PASS).
### Repo — security/contributing docs, claim qualifiers, pinned dependency (2026-11-01)
- Added the files a project that compiles and deploys other people's applications should have had: `SECURITY.md` (private advisory route, scope: the compiled runtime *and* the build toolchain, with a silent wrong answer treated as a security bug), `CONTRIBUTING.md` (the two rules — no silent wrong answer, every claim carries a check — plus the exact commands and the machine-independence rule this same session had to enforce), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `.github/CODEOWNERS`, issue templates (bug + feature + a security contact link), and `.github/dependabot.yml` (grouped weekly updates; majors of the three byte-relevant deps stay manual because they can change what a build ships).
- The one-line npm description and the README's headline claim now say what is actually true: **measured p95 ≤ 5 ms CPU on the reference machine** (`kernel/tests/budget.test.mjs`, wall-clock, so a slower machine scales it) — the number was stated as a property of the product.
- `blade2php` is pinned to `0.1.3` like its siblings (`bcryptjs`, `php-parser`): a `^` range lets a user's build pick up a converter version this repo has never byte-compared against PHP 8.3.
### Fix — a FormRequest rule whose constraint the string form drops is refused (2026-11-01)
A-series finding #299, from the line-by-line audit of `tools/formrequest-dump.php`.
- A `Rule::unique()`/`Rule::exists()` whose constraint is a **query callback** (`whereIn`, `whereNotIn`, `where(closure)`, `using(...)`) keeps it out of its own string form: `__toString()` writes `formatWheres()`, which maps `$this->wheres` alone, while `whereIn()` and a closure land in `$this->using` (`DatabaseRule::whereIn():168`, `using():218`, `queryCallbacks():230`). Laravel never stringifies such a rule — `ValidationRuleParser::prepareRule():132-137` keeps the object and the validator merges `queryCallbacks()` into the query (`ValidatesAttributes::validateUnique():1122`, `validateExists():1075`) — so the dump's `(string) $rule` normalization validated a **different query**.
- Probed on 13.37 with one matching row (`_probe299.php`): the object FAILS where its own string PASSES, so an `exists` rule was **fail-open** (accepting a value Laravel rejects) and a `unique` rule over-rejected. Both are refused now with `LW003` and a reason that names the class, the dropped shape, and the working path (write the constraint as a where PAIR, which the string does carry — still normalized, with a regression test proving it is not over-refused).
- The same dump now resolves the two table shapes only PHP can: `connection.table` (`parseTable():1191` — the check runs on THAT connection; the app's **own** default connection prefix is dropped instead, which is the same query) and a model FQCN (`:1193-1200` — PHP also takes the model's key as the id column, which the string cannot carry). A refused class now carries **no** rules (the raw rule objects used to leak into the JSON as `{}`).
- `kernel/validator.mjs` gained the runtime half: a rule that reaches the validator in either shape (a rule string written inside a compiled controller — the dump never sees it) stops with a reason instead of querying a table literally named `mysql.users`.
- Verification: `compiler/tests/formrequest-dump.test.mjs` +4 cases against the real app + PHP 8.3 (the callback refusal, the where-PAIR non-refusal, the class-name table, the own-vs-foreign connection prefix) = 11/11; `kernel/tests/validator.test.mjs` +1 = 91/91; `npm test` **1018/1018**; corpus 55/55; shadow **12/12 byte-identical**; `tools/gate.mjs --strict` PASS.
### Hardening — `deploy` refuses a Wrangler older than v4 before it drives it (2026-11-01)
A-series findings #277/#295, from the line-by-line audit of `tools/deploy.mjs`.
- Every Cloudflare step goes through `wranglerCapture()` → `npx wrangler …`, and `npx` prefers a locally or globally installed Wrangler over the pinned devDependency. On a machine with Wrangler **3.114.13** (the version this repo's own fixture matrix carries) a mode 2/3 run therefore drove the v3 CLI with v4-era flags (`d1 list --json`, `[[d1_databases]]`) and died somewhere inside the provision step with an unrelated message. `tools/doctor.mjs` only *warned* (`v4+ expected`), so nothing stopped a real deploy from reaching that state.
- `wranglerVersionProblem()` (`tools/deploy.mjs`) now probes `wrangler --version` and answers a refusal string when the major is below `MIN_WRANGLER_MAJOR` (4). A mode 2/3 run calls it after the local config checks (a broken `wrangler.jsonc` still reports its own error without spawning anything) and **before the first Wrangler call** — no account lookup, no D1 list/create/execute, no deploy — then exits 2 with the version, the reason, and the fix (`npm i -g wrangler@latest` or `npx --package wrangler@4`). `--plan --check`, which also drives Wrangler, records the same line as a blocking plan issue so the rest of the plan is still printed. A probe that cannot run at all (Wrangler absent, non-zero exit) stays silent: the next command reports its own error, and previously working setups are not broken by the gate. `wrangler --version` output with a leading label (`wrangler 4.151.1`) parses the same way.
- Verification: `tools/tests/deploy-integration.test.mjs` gained three cases over the fake Wrangler — an old CLI stops a mode 3 run with the version named and **no** Wrangler call beyond the probe (`FAKE_WRANGLER_VERSION=3.114.13`), a v4 run is unaffected (one probe, normal flow), and `--plan --check` prints the refusal as a blocking issue without mutating (`37/37`). The README's "When the tool refuses" list documents the new exit-2 case.
### Fix — two route URIs that compile to one controller module are refused (2026-10-31)
A-series finding #282, continuing the `build.mjs` / `tools/` audit.
- `slugifyRoute()` (`build.mjs`) turns `/a/b`, `/a-b` and `/{a}-{b}` into the **same** slug, and the build writes `dist/src/controllers/<slug>.mjs` per route. Two such routes wrote one handler over the other, and `routes.generated.mjs` pointed **both** URLs at whichever was written last — a silent wrong serve with no warning anywhere in the build log.
- `tools/routes-dump.mjs` now refuses such a route set: it still prints the JSON table (its stdout stays the `route:list --json` shape) and reports the pair on stderr as a parse issue, and `build.mjs` turns that refusal into a `BUILD FAILED` block naming both URIs, so nothing is written and `dist` keeps the last build that completed.
- The scanner is now spawned with `spawnSync` so its stderr is captured and echoed **and** read (a refused dump exits 0, so stderr was previously the only carrier of the reason, printed but never acted on). A scanner that *crashes* is re-raised in the shape the existing handler expects — the crash path still prints `route export crashed` with the scanner's own output.
- Verification: `tools/tests/routes-dump.test.mjs` gained a refusal case and a no-collision case (6/6; the refusal case **fails** with the guard reverted); an end-to-end build over the fixture app with `/clash/x` + `/clash-x` added printed `BUILD FAILED: the route URIs "clash/x" and "clash-x" both compile to the controller module "clash-x.mjs"` and `READINESS: DOES NOT RUN`; removing the scanner made the crash path print `route export crashed`; shadow harness 12/12 byte-identical at 100% coverage; `npm test` 1008/1008.

### Fix — a route view whose name is also an error view name was written to the wrong module (2026-10-31)
Found in the continuing line-by-line audit of `build.mjs` (A-series finding #281).
- A **route** view's module was written under its RAW name (`dist/src/views/<view>.mjs`) while an **error** view uses the same precomputed shape, `errors.<code>.mjs`. A view named `errors/404` — a legal Laravel name — was written to `views/errors/404.mjs`, a path no controller ever imports (the handler imports `../views/errors/404.mjs`, which is a directory), so a `GET` route rendering that view would answer 500 "view not compiled" where PHP answers 200. Two page views whose names sanitize to the same file (`a/b` vs `a-b`) went through unguarded in this file too, so one silently overwrote the other.
- Every route-view and error-view module name now goes through `viewFileName()` — the same guard the snapshot path already used. A collision that would overwrite a module stops the build with the two view names that clash, and a name with a path separator resolves to the module the controller actually imports.
- Verification: the shadow harness rebuilds and stays **12/12 byte-identical at 100% coverage** with the error-view modules at their usual names (`errors.404.mjs` unchanged — `viewFileName` is identity for them), and the guard was negative-tested (`viewFileName('a/b')` then `viewFileName('a-b')` throws; `errors/404` resolves to `errors-404`). `npm test` 1006/1006.
### Security — a request key named `__proto__` polluted `Object.prototype` (2026-10-30)
Found during the line-by-line parity audit of `kernel/http.mjs` / `kernel/multipart.mjs` (A-series finding #278). Every bag the edge builds out of **client input** — the query string, a urlencoded or multipart form body, the `Cookie:` header, a JSON body, an uploaded file's part name — was written with plain `obj[key] = value`. For a key PHP treats as ordinary data that is a write *through* the prototype chain: `x[__proto__][p]=1` reached `Object.prototype`, and `x[constructor][prototype][polluted]=1` reached it by another road. One unauthenticated request would then change the property every later request in the isolate can see (`{}.polluted`), and the polluted bag itself diverged from `$_GET`/`$_POST` (PHP answers `['x' => ['__proto__' => ['p' => '1']]]`, measured on PHP 8.3).
- **`kernel/own-key.mjs` — the one writer.** `ownSet`/`ownGet`/`ownHas`/`assignOwn`/`copyOwn`/`newOrderedBag`/`orderedKeys`/`orderedSet` write through `Object.defineProperty` and read through `getOwnPropertyDescriptor`, so a hostile key becomes an own property holding data. Every untrusted-key writer now goes through them: `parsePhpQuery`/`undot` (which the query bag, both form bodies and `Request::undot()` share), the cookie jar's `$arr[]` rule, `Arr::set`/`Arr::undot` (`kernel/arr.mjs`), the `Collection` key writers (`kernel/collections.mjs`), the session payload and the mailable view data.
- **The bag rule now lives once — `kernel/php-bag.mjs`.** The PHP variable-registration walk (plain keys, `a[b][c]` nesting, `a[]` append at the next free integer index, duplicate-scalar last-wins, list promotion for `0..n-1`) was inside `kernel/http.mjs`; the multipart parser needs the same rule, so it moved to its own module and `parsePhpQuery` is re-exported from `http.mjs` unchanged (the oracle test and the default export still read it there).
- Fix: **a multipart field name was taken literally (#279).** `Content-Disposition: name="a[b]"` was stored as the key `"a[b]"`, so `$request->input('a.b')` was null and `$request->all()` carried a key PHP does not have — the multipart parser registers through `php_register_variable_ex()` too (`ext/standard/rfc1867.c`). Field names now go through the shared bag (`a[b]=v` -> `{"a":{"b":"v"}}`, `c[]=1&c[]=2` -> `["1","2"]`, verified against the PHP 8.3 SAPI), and the *file* branch (`setFile`) uses own-key reads/writes as well — a file part named `a[__proto__][x]` used to throw `TypeError: Immutable prototype object` while `__proto__[z]` polluted the prototype.
- Verification: `npm test` **1006/1006** (3 new tests: the multipart field-name parity, the multipart hostile-name invariant, and the query-string invariant over the hostile table), the live `parse_str` oracle now compares **38** cases (9 hostile keys added to `MATCH_CASES` — all MATCH, `Object.prototype` pristine after every one), corpus 55/55, shadow harness 12/12 byte-identical at 100% coverage, `gate.mjs --strict` PASS, and `tools/docs-check.mjs` no longer reports the two new kernel modules as undocumented (#280).
### docs/README — the install step was missing (2026-10-30)
The Quick start opened on `npx laravel-workers deploy` with no install line, and the Requirements table called `wrangler` **"operator-installed"** — two tellings of the wrong story about what a first-time visitor has to do. Reported from the outside: *"btw di quick start gaada npm install atau bun install laravel-workers kah"*.
- **Quick start installs the package now.** `npm i -D laravel-workers` (or `bun add -d laravel-workers`) is step one, followed by a note on what the `devDependency` buys that bare `npx` does not: it records the version the app was tested with in `package.json` (an exact version if you want a hard pin), costs no fetch per run, gives `npm run` scripts and CI a binary, and `npx` picks the local install up — where `npx laravel-workers` uninstalled resolves the latest published version on every run. The `npx` one-liners stay: that path is real, and the repo's own e2e job installs a tarball and then runs `npx laravel-workers build` (`ci.yml`).
- **`wrangler` is not a prerequisite.** `tools/deploy.mjs` (`wranglerCapture`) and `tools/doctor.mjs` both reach Cloudflare through `npx wrangler`, so the toolchain provisions it on demand and a `wrangler` already present locally or globally wins instead — "operator-installed; not bundled" implied a manual install step that does not exist. The `doctor` warning text (`npm i -g wrangler or npx`) was already right.
- **`## CLI` states its assumption.** Its commands are the installed-binary form; the section says so rather than leaving the reader to infer it.
### docs/README — the public face (2026-10-30)
The README is the front door, and it was telling the visitor the wrong numbers: **"113 constructs / 43 compile"** and **"corpus 51/51 / 105 docs"** had been typed by hand and were two waves stale (the code is 115 / 45). Nothing checked them — the gate read `MAP.md` and `COMPILED.md`, never the README.
- **The README counts are now generated.** `tools/docs-counts.mjs` derives the construct tally, the facade coverage (47/47), the corpus size and the docs verdict count from `tools/constructs.json`, the corpus manifest and the `MAP.md` coverage index, writes them into `README.md` between `<!-- readme-counts:start -->`/`<!-- readme-counts:end -->`, and **`tools/gate.mjs` runs it with `--check`** — a stale README now fails the gate, the same way a stale COMPILED table already did. No count in this repository is hand-typed any more.
- **Reordered for the first 30 seconds.** The landing text ("what this is / what it is not", the pipeline, the coverage block, a `Contents` line and a "who reads what" line) now comes first, and `Quick start` → `Requirements` → `CLI` → `deploy` come before the internal sections (`Compiles today`, `What's inside`, `Architecture`). Two duplicated blocks were merged (the coverage paragraph, printed twice).
- **The public face has assets.** `docs/banner.svg` (+ rasterised `docs/banner.png`, 1280×280) and `docs/social-preview.svg` (+ `.png`, 1280×640) — the README hero and the GitHub social card. The README links the PNG through an **absolute GitHub URL** because npm does not resolve repository-relative image paths; `docs/banner.png` is a `REQUIRED_DOCS` entry in `tools/pack-gate.mjs`, so a dead hero link fails the pack check. The images are plain SVG with the default font stack — no toolchain lives in the repo (`npx --yes sharp-cli` rasterises once, on demand).
- **`docs/PROCESS.md` §7** records the rule behind all of it: *never hand-type a number the repo can compute; images are absolute; svg is a source, png is the artifact.*
- The hero uses the **`github.com/<owner>/<repo>/raw/...?raw=1`** form, not `raw.githubusercontent.com`: the latter answers **404** for this repository (measured — 404 vs 200 for the same file), which would have left a broken image on both GitHub and npm. jsDelivr and Statically both serve the file (200), but a CDN is an extra dependency for one PNG — `docs/PROCESS.md` §7 records all three forms, the required `@ref`, and why the GitHub URL wins here.
- Repository metadata refreshed: a tighter description and four more topics; the homepage link was **removed** (there is no homepage yet).

## 0.4.6 — line-by-line parity audit + `json_encode` flags (2026-10-30)

Findings #274/#275/#276 (the JSON flag path), reproduced against the oracle and fixed. Suite: `npm test` 1003/1003, corpus 55/55, shadow harness 12/12 byte-identical at 100% coverage, `gate.mjs --strict` + constant audit PASS.
- Fix: **a bare `JSON_*` constant failed the build.** `json_encode($v, JSON_UNESCAPED_SLASHES)` and `collect($x)->toJson(JSON_UNESCAPED_UNICODE)` — ordinary Laravel — died with the build rule `LW002 bare identifier not allowed: JSON_UNESCAPED_UNICODE` (the transpiler only knew the two `ARRAY_FILTER_USE_*` flags), where PHP answers a JSON string. There is now a `JSON_FLAG_CONSTANTS` table (the 14 constants of `php.net/json.constants`, values read off the PHP 8.3 oracle) so the constant folds to its integer; a constant the port does not know still fails the build.
- Fix: **`Collection::toJson($options)` / `JsonResource::toJson($options)` ignored the argument.** `toJson()` took no parameter, so `->toJson(JSON_UNESCAPED_UNICODE)`/`->toJson(JSON_PRETTY_PRINT)`/`->toJson(JSON_FORCE_OBJECT)` wrote the DEFAULT-flag bytes — a silent divergence on a response body. `JsonResource::toJson($options)` also only honoured `JSON_PRETTY_PRINT` and threw for anything else. Both are `json_encode($v, $options)` in Laravel (`Collection.php:1180-1183`, `JsonResource.php:186-189`), so both now go through the shared encoder.
- Fix: **one `json_encode` flag engine, not three.** `rt.json_encode` carried its own copy of the flag logic (HEX flags, pretty printer, force-object, depth) while `kernel/php-json.mjs` had a different one (`JSON_PRETTY_PRINT` only) — two implementations that could drift, and `rt.json_encode` truncated the flags with `| 0` (a bit-32 mask silently dropped `JSON_THROW_ON_ERROR` = 4194304). The engine now lives once in `kernel/php-json.mjs` (`phpJsonEncodeWithFlags`, with the real PHP flag values and the full 32-bit mask) and `rt.json_encode`, `Collection::toJson` and `JsonResource::toJson` all delegate to it; ~170 lines of duplicated helpers were removed. A flag outside the ported subset (NUMERIC_CHECK, PARTIAL_OUTPUT_ON_ERROR, PRESERVE_ZERO_FRACTION, INVALID_UTF8_*) still fails loud rather than diverging silently.

### line-by-line parity audit (2026-10-29)
A full read of the compiler, kernel and tools against the PHP oracle (PHP 8.3 + `laravel/framework` 13.37), with the fixes below. Every item was reproduced against the oracle before and after the change; the suite is `npm test` 1002/1002, corpus 55/55 and the shadow harness 12/12 byte-identical at 100% coverage. The README no longer hard-codes a test count (it drifted on every added test).
- Fix: **a date attribute READS as a Carbon (the `->format()` idiom).** Laravel's date casts answer an `Illuminate\Support\Carbon`, so `$post->created_at->format('d M Y')` — the framework's most common date idiom in a controller or a view — is a string. The kernel answered the stored TEXT, so the compiled `rt.prop($post, 'created_at').format('d/m/Y')` hit a JS `TypeError` ("... is not a function"): a 500 at the edge where PHP answers 200. `date`/`datetime`/`immutable_*`/`custom_datetime` casts and `created_at`/`updated_at`/`deleted_at` (SoftDeletes declares the cast) now read through a Carbon subset (`format` with the app-timezone `date()` letters, `toDateString`, `toDateTimeString`, `timestamp`/`getTimestamp`, `addDays`/`subDays`/`addHours`/`subHours`, `copy`/`clone`, `(string)` = the model's own date format, `json_encode()` = the UTC ISO8601 `Z` form), while the stored attribute, the JSON body (`serializeDate()` keeps the cast's own format), a query binding (`prepareBindings()`) and the dirty check keep the TEXT. An ACCESSOR now receives the RAW attribute value and its result is not cast (Laravel's `transformModelValue()`/`mutateAttribute()` — the kernel passed the CAST value, so `casts=['n'=>'int']` + `getNAttribute($v)` answered `int` where PHP answers the stored `'5'`). Comparisons follow PHP: a Carbon `==` a date string is TRUE (`__toString`) while `===` is FALSE, `>`/`<` against a scalar compare the wall clock, and two Carbons compare their instant. Probed byte-identical against the oracle for `date`, `datetime`, `datetime:d/m/Y`, `date:H:i:s`, `timestamp` and `int`+accessor (read/format/toDateString/toDateTimeString/`(string)`/`json_encode`/nested `json_encode`/`==`/`===`/`>`/`<`/concat/binding round-trip), and the emitted controller body was executed (`{"d":"02\/01\/2024","t":"2024-01-02"}` vs PHP's identical bytes). Regression tests: `kernel/tests/model.test.mjs`. (`diffForHumans`/`isoFormat`/the CarbonImmutable API stay unimplemented — documented in COMPILED.md.) The runtime's `now()`/`today()` stub is the SAME PHP kind (DateTimeInterface), so it is treated as one with the attribute value: `json_encode(now())` is the UTC ISO8601 `Z` string (it used to fail as an "unsupported object" outside the JSON subset) and a stub compares against a model date BY INSTANT (`$post->created_at > now()->subHours(1)`), not by the object-rank rule. Regression test: `compiler/tests/rt-semantics2.test.mjs`. The same value flows through the VALIDATOR: `date`, `before`/`after`/`before_or_equal`/`after_or_equal` and `date_equals` accept a date value (PHP's `validateDate()` answers true for any `DateTimeInterface`, :625-627, and `compareDates()` takes it in its guard, :277-279, reading it through `getDateTimestamp()` -> `Date::parse()`), while `date_format` does NOT (the vendor guard has no such branch) — probed both ways against the oracle. A NUMERIC value now passes `date_format` too (`DateTime::createFromFormat` coerces it and the round trip is loose: `2024` passes `date_format:Y`, probed), and `date_format` no longer throws a JS TypeError on a number, which answered false where PHP answered true. Regression test: `kernel/tests/validator.test.mjs`.
- Fix: **a bare `date` cast kept the time.** `castAttribute()` answers `asDate($value)` for `date`/`immutable_date`, and `asDate()` is `$date->startOfDay()` — so `'d' => 'date'` with `'2024-01-02 03:04:05'` reads as `2024-01-02 00:00:00` and `toArray()` serialises `"2024-01-02T00:00:00.000000Z"` (the kernel answered `2024-01-02 03:04:05` / `"2024-01-02T03:04:05.000000Z"` — a different body, and a different Blade render). The RAW attribute keeps the stored time (`fromDateTime()`), exactly like PHP, and a CUSTOM format (`date:H:i:s`) is not truncated because `getCastType()` maps it to `custom_datetime` and `castAttribute` then takes the `asDateTime()->format()` branch (`03:04:05`). Probed byte-identical for `date`, `immutable_date`, `date:H:i:s`, `datetime` and `datetime:d/m/Y H:i`.
- Fix: **a nested resource that wraps `null` answered the child's array.** `filter()` (ConditionallyLoadsAttributes.php:45-47) replaces a nested resource whose `$this->resource` is `null` with a literal `null` before the payload is encoded, so `'user' => new UserResource(null)` renders `{"user":null}` and the child's `toArray()` never runs. The kernel kept the value: `{"id":1,"user":{"cid":"NONE"},"list":[{"cid":"NONE"},{"cid":2}]}` where PHP answers `{"id":1,"user":null,"list":[null,{"cid":2}]}` (a child that dereferences the null model would throw at the edge where PHP answers `null`). A TOP-LEVEL null resource still runs its own `toArray()` (`{"cid":"NONE"}`), and the branch sits after the `MergeValue` test like the vendor's. Regression test (`kernel/tests/resources.test.mjs`) fails on the old code.
- Fix: **`sum()` answered a coerced number.** `QueryBuilder::sum()` is `return $result ?: 0;` — the driver value comes back verbatim and only a PHP-falsy result (`'0'`, `0`, `''`, `null`) becomes the integer `0`. `min`/`max`/`avg` likewise answer the driver value (`Number()` turned a TEXT column into `NaN`); a JSON body changed with them.
- Fix: **bcrypt cost default.** `Hash::make()`/`needsRehash()` defaulted to cost 10 while `BcryptHasher::$rounds` is 12, so `needsRehash($hash)` claimed the app's own `$2y$12$` digest needed rehashing (on every login).
- Fix: **decryption failures answer `DecryptException`.** A malformed cookie/XSRF payload (bad base64, non-JSON envelope, missing field) threw a raw `SyntaxError`/`TypeError`, which `EncryptCookies`/`PreventRequestForgery` do not catch in PHP — they catch `DecryptException` only. The kernel now throws `DecryptError` (`name: 'DecryptException'`) and those two callers swallow exactly it, so a configuration error is no longer silently read as "cookie absent" / "no token".
- Fix: **cookie value prefix validation and `rawurldecode`.** `$arr[] = $v` uses the highest integer key + 1 (a numeric-looking key with a leading zero is a string key), and PHP's `rawurldecode` requires *two* hex digits (`%1x` stays literal — `parseInt` read it as `0x01`).
- Fix: **`Model` JSON casts.** `json`/`array`/`object`/`collection` are encoded with PHP's `json_encode` bytes (including `json:unicode` → `JSON_UNESCAPED_UNICODE`), decoded with `fromJson` semantics (`''` and malformed JSON read as `null`, `collection` yields a `Collection`), and `originalIsEquivalent` compares through the same decode.
- Fix: **`Collection` key semantics.** `reverse`/`slice`/`take`/`skip`/`unique`/`implode`/`merge`/`chunk`/`groupBy`/`keyBy`/`map`/`filter`/`reject` now keep the PHP keys and coerce group keys like PHP array keys, `where*`/`pluck`/`firstWhere` read through `data_get` (dot paths and model attributes), and the `whereInStrict`/`whereNotIn`/`whereNull`/`whereStrict` shapes exist (differentially verified: 41/41 cases byte-identical to the oracle).
- Fix: **the global input transformers now run.** Laravel's global middleware trims the input (`TrimStrings`) and turns a lone `""` into `null` (`ConvertEmptyStringsToNull`) before the router ever sees it, so `POST name=" Ada "` reached the controller as `" Ada "` instead of `"Ada"` and an empty field stayed `""` (changing `required`/`nullable` answers and every `json_encode($request->all())`). The compiled request now applies the same two passes to the same bags (`TransformsRequest::clean()`: the query always, then the JSON body when the body is JSON, else the body), with PHP's `Str::trim` charlist and the nested `a.b` key prefix. The skip list is the app's own (`TrimStrings::except()` read from `bootstrap/app.php`); a transformer the app removed from its global stack runs neither pass, and a `skipWhen()` callback - a per-request decision the edge cannot see - fails the build with "add a port" instead of guessing. Probed against PHP 8.3 and byte-identical.
- Fix: **a worker without the `ASSETS` binding answers 404 instead of 500.** `src/worker.mjs` called `env.ASSETS.fetch(request)` unconditionally for every unmatched path, so a deployment whose wrangler config omits the assets binding (or whose `public/` is empty) turned every unknown URL into `TypeError: Cannot read properties of undefined (reading 'fetch')`. The generated configs already declare the binding; the worker now degrades to a plain 404 when it is absent.
- Fix: **the transformer knobs follow the vendor configurator.** `bootstrap/app.php` `->trimStrings()`/`->convertEmptyStringsToNull()` are the real methods (`Middleware` 13.37:645-670): Closure entries are per-request `skipWhen()` callbacks (refused with "add a port"), strings are `TrimStrings::except()` keys that ACCUMULATE statically, and a non-Closure in `convertEmptyStringsToNull()` is an app bug. `use()` replaces the whole stack while `prepend`/`append`/`remove` accumulate and `replace()` maps classes (Ml 169-236, 452-476), so the emitted stack is the vendor's, not the source order. The framework's own default stack is never reported as a divergence.
- Fix: **app global middleware the kernel does not run fails loud.** A stack the app changed (`->use()`, `prepend`/`append`/`remove`) that holds anything but the two input transformers - `TrustHosts` rejecting a host, `HandleCors` adding headers, `PreventRequestsDuringMaintenance` answering 503, the app's own class - is written to `middleware.prevented` and every request answers 500 naming the class, instead of serving bytes the real app never would. An unparseable `bootstrap/app.php` is a build refusal too (it used to mean "no middleware": cookies, CSRF and trimming all silently defaulted).
- Fix: **`Request::has()`/`hasAny()`/`filled()`/`file()`.** `has` answers over `all()` (input + query + files, `Arr::has`), `filled`/`isEmptyString` union the query bag, and a file-only field reads as an empty string — not `[object Object]`.
- Fix: **`Collection` mutators keep PHP's keys.** `forget()` is a plain `unset($items[$key])`, so a list keeps a HOLE (`collect([1,2,3])->forget(1)->all()` is `{0:1,2:3}` — `splice` renumbered it), it takes an array of keys and does NOT split a dotted key; `push()`/`put(null)` append after the HIGHEST integer key (`collect(['a'=>1, 5=>'x'])->push('y')` is `{5:'x',6:'y',a:1}`, not key 0), `put($key)` on a new key appends instead of writing a JS property; `pop($count)` answers the popped items in POP order as a list (`pop(2)` was answered like `pop()`); and the constructor coerces a JSON object's keys like PHP's array keys. Probed: 17/17 cases byte-identical to the oracle.
- Fix: **`Collection::groupBy()`'s second argument and its array form.** `groupBy($key, $preserveKeys)` now keeps the source keys inside each group (`{"x":["a","b"],"y":{"2":"c","3":"d"}}`), `groupBy(['a','b'])` groups by the first spec and runs the rest per group (the chained multi-level shape), and a callback that answers several keys files the item into each of them (`{"a":[1,2],"b":[1,2]}`). `keyBy` keeps the LAST item for a duplicate key (`$results[$key] = $item`). Probed byte-identical.
- Fix: **`Request::all($keys)`.** The edge ignored the argument, so `$request->all(['name'])` answered the whole input (an app that validates or creates from a subset saw every field). It now builds the `Arr::only`-shaped subset through `data_get`/`Arr::set` (dot notation, an absent key answers `null`, an empty array means "everything"), and `input()` unions the query bag in PHP's order — the input source's keys first — so `json_encode($request->all())` is byte-identical too.
- Fix: **`JsonResource` key merge.** `array_merge` counts numeric keys separately (a string key no longer shifts the numeric index), and `array_merge_recursive` wrote every numeric key to `"undefined"` (`{"undefined":3}` instead of `[1,2,3]`).
- Fix: **`regex:`/`not_regex:` against PCRE.** The rules only accepted a string (`ValidateRegex` is `is_string($value) || is_numeric($value)`, so `42` passes `/^[0-9]+$/`), compiled the parameter with a bare JS `$` (which is PCRE's `\z`, not its `$` — `/^abc$/` now also matches `"abc\n"`), threw away `D`/`A`/`S` into `new RegExp` (a compile error, hence a wrong FAIL), read `[]a]` as an empty class, and answered FAIL for `not_regex` on a pattern PCRE cannot compile (`preg_match() === false` makes `false < 1` a PASS). `\Z`/`\z`, the `D`/`A` modifiers, a leading class `]`, the `notregex` alias (`validateNotRegex` resolves case-insensitively in PHP) and the numeric cast are now translated. Differential (PHP 8.3 + vendor 13.37, 1107 cases): 225 rows diverged before, 1 after — a non-`/u` pattern inspecting a non-ASCII subject, where PCRE matches bytes and JS matches UTF-16 units (documented in COMPILED.md §6).
- Fix: **`integer`, `date` and `email` against the vendor.** `integer` was `Number.isInteger`/a loose regex; the rule is `filter_var($value, FILTER_VALIDATE_INT)` (plus `integer:strict` → `is_int`), so `true` is an integer, `'02'` is not, and a value outside the 64-bit range fails. `date` was a bare `Date.parse`; the rule is `strtotime()` AND `checkdate(date_parse())`, so `'2026-02-30'` and `'Feb 30 2026'` fail (a JS `Date` rolls the day over) while `'20-02-2026'` and `'2026-02-28 24:00:00'` pass (a JS `Date` refuses them). `email` is egulias' RFCValidation: a UTF-8 local/domain (`ü@ü.de`), a dotless domain, a quoted local part and a bracketed literal all pass, and the ASCII-only regex refused them. Differential (PHP 8.3 + vendor 13.37): 241 cases, 4 diverged before, 0 after.
- Fix: **validation rules.** Non-implicit rules no longer run on an absent/blank attribute (`'   '` + `alpha` passes, `filled` passes when absent, `missing` asks whether the key exists), `alpha*` defaults to Unicode with the `ascii` parameter, `distinct` compares sibling wildcard values, and `declined_if`/`required_if_accepted`/`required_if_declined`/`prohibited_if_accepted`/`prohibited_if_declined`, 4/8-digit `hex_color`, strict `ipv4`/`ipv6` and dot-less `email` domains are implemented (oracle: 56/56 accept/reject and 70/70 messages identical).
- Fix: **`env()` folding in the static parser.** A present-but-empty variable wins over the default (`Env::getOption('')`), `${NAME}` interpolation and `#` comments follow phpdotenv v5.7, the process environment beats the `.env` file, values are coerced like `Env::getOption()` (`true`/`false`/`empty`/`null`), and the lang path is `resources/lang` when it exists (`config-dump` now matches a real boot key for key).
- Fix: **`Gate::denies()` string callbacks and array literals.** `txGate` read `deny` from inside its own temporal dead zone (a `ReferenceError` instead of `Gate::denies()`), an array literal mixing a keyless element with a computed key emitted a bogus `"null"` key or crashed, and an internal compiler error is now reported as `LW999` (internal compiler error, documented in COMPILED.md) instead of hiding behind `LW002`.
- Fix: **build refusal for an uncompiled view route.** A route declared in `registry.views` whose view fails to compile stayed `kind: 'view'` with `controller: undefined`, so `routes.generated.mjs` imported `./controllers/undefined.mjs` and Wrangler could not resolve it; such a route now falls through to `unhandled` with the compile error in the readiness report.
- Fix: **event-dump oracle bindings.** An interface parameter was labelled `external` (`class_exists()` is false for interfaces) and `$binding[0]` indexed an associative array, so a container `impl` never surfaced in the dependency graph.
- Fix: **by-reference parameters and namespace aliases.** `classes.mjs` read `p.byRef` off the AST (php-parser spells it `byref`), so the by-reference refusal was dead; `aliasMapFor` accepted sub-namespace classes (`App\Mail\OrderMail` for `App\OrderMail`).
- Fix: **`Str::after`, `rt.explode`, cache `add()`, temporary-URL comparison.** A missing needle returns the whole subject; `explode` honours a positive/zero/negative limit (and an empty separator throws `ValueError`); `Cache::add()` with a non-null `ttl <= 0` returns false instead of storing for ten years; `verifyTemporaryUrl` compares the HMAC in constant time.
- Fix: **the route scan dropped four Router helpers.** `Route::view()`, `Route::redirect()`, `Route::permanentRedirect()` and `Route::fallback()` register a route with no plain verb, so `tools/routes-dump.mjs` produced no entry for them *and* no note — a `view` route PHP answers 200 became a silent 404 on the edge — while `Route::any()`/`Route::match([...])` produced the invented methods `ANY`/`MATCH` (a finding that read "no GET (MATCH)" for a route that has GET). The scan now maps each helper to what `route:list --json` prints (`view` → GET|HEAD + `Illuminate\Routing\ViewController`; `redirect`/`permanentRedirect` → `Router::$verbs` + `Illuminate\Routing\RedirectController`; `fallback` → GET|HEAD on `{fallbackPlaceholder}`; `any` → `Router::$verbs`; `match` → the uppercased list with HEAD appended when GET is present, `Route::__construct`'s rule; `query` → QUERY) and lists an unreadable verb list as `MATCH` with a note rather than guessing. Verified against the real `Illuminate\Routing\Router` (PHP 8.3.30 + framework 13.37): identical uri/methods/action for all eleven routes. Regression: `tools/tests/routes-dump.test.mjs` (spawns the tool on a temp app; registered in `npm test`).
- Fix: **the app's health route is reported, not silently missing.** `health: '/up'` in `bootstrap/app.php` is registered by `ApplicationBuilder::withRouting()` — framework code, not a route file — so the scan cannot see it and no consumer of the scan ever learned about it: `GET /up` answered 404 on the edge where PHP answers 200. Differential run of the scan against `tools/routes-dump.php` on the fixture app (12 routes vs 9) isolated exactly this route (plus `storage/{path}`, the vendor `FilesystemServiceProvider::serveFiles()` pair the scan already documents as outside its scope). The scan now prints a note naming the URI and the trade (declare the route or a port if the edge needs it).
- Fix: **classmap keys came from a comment.** `tools/vendor-lite.mjs` took the first `/(?:class|interface|trait|enum)\s+(\w+)/` match anywhere in the file, so `vendor/nette/utils/src/SmartObject.php` mapped the name `for` (from the docblock "Strict class for better experience.") and a multi-declaration file mapped only its first class. The FQCNs now come from a comment/string-stripped declaration scan (every declaration, enums included, anonymous classes skipped, namespace-qualified): 87/87 classmap files of the fixture app match PHP's own tokenizer, where the regex form mismatched two.
- Fix: **constant concatenation with a `null`/`false`/`true` literal.** `evalConstantExpr` built the result with `String(l) + String(r)`, so `const X = null . 'x'` answered `'nullx'` where PHP answers `'x'` (`true . 'b'` → `'1b'`, `false . 'b'` → `'b'`); the constant path now uses the same `phpStr` conversion the config path already used (`tools/static.mjs`).
- Fix: **`__DIR__` in `withRouting()`.** `appRouteFiles` joined a path argument to the app root instead of the file's own directory, so `web: __DIR__.'/../routes/web.php'` resolved to a path that does not exist and the scan fell back to the conventional file — a `withRouting()` pointing anywhere else was silently ignored.
- Chore: `kernel/encrypter.mjs` held two stray Latin-1 bytes (0x97) in comments, the only non-UTF-8 file in the repository.
- Fix: **`Collection`'s `where()` operator set is Laravel's verbatim.** `operatorForWhere()`'s `default:` case falls through to a loose `==` (`EnumeratesValues.php:1138-1165`), so an operator the vendor does not enumerate — **including `like`, which no Collections trait implements** — answers rows at the edge instead of throwing a 500; the edge also pattern-matched `like` and refused `<=>`, which the vendor supports. `contains()`/`every()`/`some()` take the `$key $operator $value` form (`contains('price', '>', 100)`, `every('active')` as a `data_get` truthiness test) instead of ignoring the extra arguments and answering "no" for every collection.
- Fix: **`Collection::sum()`/`avg()` are PHP's arithmetic.** The fold is `$result + $item` (a leading-numeric string is a PHP 8 **notice** — so `sum(['5a'])` is a 500 through Laravel's error handler, an `ErrorException` naming both, where the raw-script oracle (no error handler) printed a warning and answered 5 — a non-numeric string or an array throws the same `TypeError: Unsupported operand types: int + string`, and `null`/bool coerce), and `avg()` **skips nulls** instead of dividing by the full length (`avg([1, null])` is 1, not 0.5). `flatten($depth)` honours the depth rung Laravel flattens to (`flatten(1)` on `[[1, [2]], 3]` is `[1, [2], 3]`).
- Fix: **`ResourceResponse`'s 201 needs a Model.** `calculateStatus()` (`ResourceResponse.php:120-124`) is `instanceof Model && wasRecentlyCreated`, so a payload that merely carries the key (an array, a DTO) stays a 200.
- Fix: **the validation messages merge recursively, from the app's fallback locale.** `FileLoader` merges the language paths with `array_replace_recursive` (:134) and `Translator::get()` falls back per key, so a locale file that redefines part of `validation.custom` keeps the fallback's other rules there; `config-dump` now dumps `app.fallback_locale` (the runtime assumed `en`, and a config without the key still defaults to it).
- Fix: **the compiled-body `await` scan skips strings and comments.** `classes.mjs` refused a valid class or resource with `LW002` when a message or a comment merely contained the word `await` (`const msg = 'await pending';`); a real await is still refused.
- Fix: **the cookie HMAC key cache keys on the whole key.** Two app keys that agreed on their length and first eight bytes shared one imported `CryptoKey`, so a cookie signed under one verified under the other.
- New: **`tools/zip.mjs`, a pure-JS ZIP reader.** `vendor-lite` and `php-provision` shelled out to `unzip` with no fallback, so provisioning failed with `spawnSync unzip ENOENT` on a clean Windows box (no Git-Bash/MSYS/7-Zip) while every other tool in the package is pure JavaScript on purpose. The reader handles the shapes those two callers download (STORE/DEFLATE, directories, sizes from the central directory), refuses ZIP64/encryption/other methods (with the system binary as the fallback) and refuses an entry that escapes the destination (`tools/tests/zip.test.mjs`).
- Fix: **`Collection` callbacks receive the PHP keys.** `map`/`each`/`filter`/`reject`/`first`/`sole`/`search` hand the callback the collection's OWN key (`Arr::map`, `Arr::each`), so `->map(fn ($v, $k) => $k)` over `['a' => 1]` answers `'a'` instead of the JS index `0`.
- Fix: **`boolean:strict`.** `ValidatesAttributes::validateBoolean()` (:536-545) narrows its acceptable list to the booleans themselves for the `strict` parameter, so `['x' => '1']` + `boolean:strict` is a failure; the edge ignored the parameter.
- Fix: **the encoder resolves a JSON resource.** `json_encode(new PostResource($post))` printed the wrapper's private fields (`{"kernel":{},"resource":{...}}`) while PHP prints the resource's array; the encoder now calls the kernel's resource resolver when it meets one, and a resource nested inside another resource's array resolves too (a plain/double-encoded resource disagreed byte-for-byte).
- Fix: **a resource's `$request` is a request variable.** `toArray(Request $request)`/`with(Request $request)` may call the allowed request surface (`$request->query()`, `path()`, `header()`, `user()`, …); every such call previously failed loud ("the method call $request->query() is not compiled") and the whole route fell back to a port although the edge serves the call. The shadow fixture now exercises it: `GET /posts/{post}/resource` (a resource nesting two resources, each reading the live request) and `GET /posts/{post}/json` are byte-identical to the oracle.
- Note: the resource base surface the compiled body does NOT answer — `$this->when()`/`whenLoaded()`/`mergeWhen()`, `whenCounted()` — fails loud at build (the route is reported and falls back to a port), so a conditional-field resource is a declared gap rather than a divergence; the kernel's own `when()`/`whenLoaded()`/`whenNotNull()` are covered by the kernel suite against the oracle.
- Note: `QueryBuilder::offset()` without `limit()` compiles to a bare `offset N` in both this kernel and Laravel's `SQLiteGrammar` (which does not override `Grammar::compileOffset`), so the database rejects it identically — no divergence to fix.
- New: **the `Str` surface grew to the PHP-exact set the sample apps use.** `Str::is()` (wildcard `*` with the optional `ignoreCase`, array patterns), `Str::finish()`/`Str::start()` (the trailing/leading run is stripped then added once — no repeated cap), `Str::random()` (the base64-minus `/+=` alphabet) and `Str::isUrl()` (the Symfony UrlValidator 5.0.7 pattern with Laravel's protocol list, verbatim from the vendor; a custom list — `Str::isUrl($v, ['ftp'])` — swaps the protocol alternation) are compiled and oracle-verified. `rt.Str.isUrl` is the validator's too.
- Fix: **the `url` validation rule is `Str::isUrl($value, $parameters)`.** `ValidatesAttributes::validateUrl()` (:2770) accepts every protocol of Laravel's list and honours the rule's own list (`url:ftp,http`); the edge used `new URL()` and answered http/https only, so an `ftp://`/`wss://` URL Laravel accepts was rejected. A scheme-less host is still not a URL.
- New: **the `Arr` surface** — `Arr::get()`/`has()` (dot notation, the literal key wins, `null` key answers the array), `Arr::only()` (order and keys follow `$array`), `Arr::first()`/`last()` (no callback = the first/last value; a closure default runs), `Arr::wrap()` (a PHP array — including a JS object — passes through, a scalar wraps) and `Arr::dot()` (flatten with `$prepend` and `$depth`). `set`/`pull`/`forget`/`where`/`sort*` still refuse loud (by-reference mutation / callbacks).
- Fix: **`Collection::whereInstanceOf('FQCN')`** read a `phpClass` property that no compiled instance ever sets, so the string form always answered an empty collection; it now reads the compiled class marker (`__lwClass`, the string `Post::class` compiles to).
- Fix: **`Collection::containsStrict($callback)`** cast the predicate's answer with JS truthiness; `array_any()` is PHP's bool cast, so `'0'` and `''` are false.
- Fix: **a named argument names its own refusal.** `f(x: 1)` was refused as an "unknown function" when the callee was unknown (the LW001 check ran first); the call site now refuses with the keyword list (`named argument (x: ...) are not compiled`). The compiled rung passes arguments positionally and the build does not know the callee's parameter order, so a named argument still fails loud rather than mis-binding silently.
- Fix: **`Str::random()` drew from `rawByte % 62`.** Laravel base64-encodes `ceil($size / 3) * 3` random bytes and strips `/`, `+`, `=` (`Str.php:1158-1174`), so every character is one uniform 6-bit value; `% 62` is not uniform — 256 = 4×62 + 8, so the first eight buckets carry 5/256 against 4/256 for the other 54. Probed over 1.86M draws: chi-square 11,935 before (max relative deviation 21.6%, the 5:4 ratio) against 78.6 after (61 df — uniform), and the encoder is byte-identical to `Buffer.toString('base64')`.
- Fix: **the `url` rule refused a value with a trailing newline.** Laravel compiles `Str::isUrl` as `preg_match('~...$~ix')` (`Str.php:631-684`); PCRE's `$` without `/D` also matches immediately before a final newline, and the `i` makes the scheme case-insensitive — a bare JS `$` with no `i` answered 422 where Laravel answers 200 for `"http://x.co\n"` and `"HTTP://X.CO"`. The pattern is now built from one source (`URL_SRC` plus a protocol placeholder — it was copied out three times and had drifted) with a `(?=\n?$)` tail and the `iu` flags. The `url` rule also gained coverage through the FormRequest lifecycle rather than a bare `new Validator`. Differential fuzz against PHP 8.3: 4,068 URLs on the default list and 4,074 with custom lists — 0 differences.

- Fix: **the size and comparison rules are `getSize()`/`shouldBeNumeric()`.** `min`/`max`/`size`/`between` are LENGTH rules: only `gt`/`gte`/`lt`/`lte` claim a numeric value (`ValidatesAttributes.php:1321,1368,1415,1462`), and the length is `mb_strlen((string) $value)` — so `min:3` on `'70'` fails (2 characters), `max:3` on the integer `42` passes, `'😀'` counts one code point, and a float casts through PHP's `precision=14` `E+NN` form (so `alpha_dash`/`alpha_num` reject it). The edge flagged every size rule numeric and measured a JS `Number`, so a PHP 422 came back 200. Verified differentially (76 rules × 181 values: 416 → 56 divergences, the rest PHP date-string forms outside the port).
- Fix: **`gt`/`gte`/`lt`/`lte` compare the vendor way.** A numeric parameter compares `getSize()` against the trimmed literal, a parameter naming another FIELD reads that field, a numeric parameter with a missing field is always false, and both-numeric-not-claiming compares the trimmed strings (`ValidatesAttributes::validateGt()`, :1321-1343). The edge compared JS numbers.
- Fix: **`before`/`after`/`*_or_equal`/`date_equals` are `compareDates()`.** Both operands go through the string/numeric guard, Carbon reads the parameter first then the field, and an unreadable value is timestamp 0 (`getDateTimestamp()` is null) — so `before:2026-01-01` on `'abc'` PASSES and `after:2026-01-01` FAILS (`ValidatesAttributes.php:2360-2398`). The edge used a tolerant JS `Date`.
- Fix: **`date` is `strtotime()` AND `checkdate(date_parse())`.** `'0'`, `'0123'`, `'now'`, `'tomorrow'` fail (month/day/year 0), while an out-of-range day rolls like PHP (`'2026-02-30'` → 03-02). `multiple_of` compares with `BigDecimal` (brick/math), not `%` — so `multiple_of:0.1` on `0.3` passes and `1e300` (out of the 64-bit range) fails. `array`/`list`/`json`/`array_keys` follow `is_array()`/`array_is_list()`/`json_validate()`/`array_diff_key()` (a PHP assoc array is `array` but not `list`; the JSON text of `false` is `''` and invalid, of `true`/`0` valid).
- Fix: **`numeric` resolved a function that did not exist.** `is_numeric` is a PHP regex (hex, `Infinity`, a 1e400 literal are NOT numeric); the edge called a missing `isPhpNumeric` (a `ReferenceError`) and accepted `Number()` forms.
- Fix: **two validation-message tests pinned the old behaviour.** `max:3` on `42` and `between:1,3` on `5` were asserted to FAIL; the oracle PASSES both (length 2 and 1), so the tests now use `4242`/`'abcd'` with the vendor's own wording.
- Fix: **zip extraction falls back to `tar` too.** `vendor-lite` and `php-provision` used the pure-JS reader with `unzip` as the only system fallback; a reader refusal (ZIP64, another method) on a clean Windows box now tries bsdtar (`tar -xf`), which ships with Windows 10+ and reads ZIP/ZIP64.
- Fix: **the `in_array` rule is a strict dot-path test.** `validateInArray()` (:1581-1594) matches the parameter as a wildcard against `Arr::dot($data)` with `Str::is` and compares with `in_array(..., true)`, so `in_array:ids.*` reaches the elements and the string `'2'` does NOT match the integer 2, while a bare `in_array:ids` (no `*`) never does (the key holds the whole array). The edge stripped a trailing `.*` and compared with `String()`.
- Fix: **`route:list` reports a resource in the vendor's action order.** `ResourceRegistrar::$resourceDefaults` (:21) is index, create, store, show, edit, update, destroy; the edge emitted store/create and update/destroy/edit swapped.
- Fix: **`===` compares arrays by value and objects by identity.** PHP's `[1,2] === [1,2]` is TRUE (two arrays are identical when they hold the same pairs, in the same order, with identical values), while the compiled `===` used the JS reference compare and answered false for every freshly built array _and_ for `['a'=>1] === ['a'=>1]`. `rt.strictEq` now delegates to the value comparator (`phpIdentical`) for arrays and keeps the identity compare for `(object)` values. With the stdClass marker in place, a PHP array never equals an object (`['a'=>1] == (object)['a'=>1]` is false, `(object)['a'=>1] == (object)['a'=>1]` is true, `===` on two objects is identity), which the tagged-object tag (`tagOf` -> `obj`) now enforces.
- Fix: **a PHP `stdClass` encodes as a JSON object.** `json_encode(new stdClass)` is `{}` while `json_encode([])` is `[]`, and `json_encode((object) [10, 20])` is `{"0":10,"1":20}` — the encoder treated any keyless or list-shaped plain object as a PHP array, so a stdClass became `[]`. The runtime now marks the values that come from the `(object)` cast (`rt.objectCast`), from `json_decode()` with `$assoc = false` (the default) and from the `object` model cast (a non-enumerable `__lwObject`, invisible to `Object.keys`/`JSON.stringify`/the output), and the encoder honours it. Byte-parity is proven against the PHP 8.3 oracle (a new `stdClass` tag in `tools/php-json-oracle.php`).
- Fix: **a stdClass is an object, an assoc array is an array** (the differential sweep the `(object)` marker unblocked). `is_array((object)[])` and `is_object(['a'=>1])` answered true where PHP answers false (and every kernel instance - a Collection, a Model - counted as an array); an empty stdClass was falsy where PHP says an object is always true. `is_array`/`is_object`/`is_countable`/`truthy` now use the array/object predicates.
- Fix: **PHP's conversions of an array and of a stdClass.** `'x' . ['a'=>1]` answered `xObject` where PHP answers `xArray` (with the "Array to string conversion" warning); `'x' . (object)[]`, `strval($stdClass)` and `sprintf('%s', $stdClass)` now raise PHP's `Error("Object of class stdClass could not be converted to string")`; the array functions (`count`, `array_keys`, `array_key_exists`, `implode`, `array_values`, `array_slice`, `array_reverse`, `array_flip`) raise PHP's own `TypeError` when the argument is a stdClass; `array_sum([[1]])` is 0 (an array/null contributes 0, a bool 0/1, a numeric string its number); `implode()` casts each value the way PHP does (a nested array is `Array`, `true` is `1`). The relational operators follow the comparison table (an array is greater than any scalar, an object greater than both).
- Fix: **`(int)`/`(float)` of a boolean in the config evaluator.** `(int) true` is 1 in PHP; `parseInt(true)` was `NaN` -> 0 (same for the float cast).

## v0.4.6 — 2026-10-28

- **New: the deploy CLI — `npx laravel-workers deploy`.** The one manual step (create D1 + paste id + `d1 execute` + `wrangler deploy`) is now a guided command. It prompts at the start — mode **1 = build only** · **2 + D1** · **3 + D1 + deploy**, then the worker name for modes 2/3 — and executes at the end, after the build is green, so a failed compile never creates an orphan D1. Flags make it CI-safe (`--name`, `--mode`, `--d1-auto`, `--d1-id`, `--skip-schema`, `--schema=apply`, `--yes`, `--plan`, `--allow-account-change`); non-interactive input falls back to build-only unless a mode or D1 flag is explicit (in that path a lone `--name` is rejected because build-only does not touch `wrangler.jsonc`). `--dry-run` is rejected with a `--plan` hint.
- **New: per-app deploy state (`tools/lw-state.mjs` → `<app>/lw-state.json`)** — `{account: {id, name, email} (optional, written by the account guard), deployedAt, workerName, workerUrl, d1: {binding, databaseName, databaseId, schemaAppliedAt, schemaHash}}` — written by `deploy`, read by the new `status` and `doctor` commands. Later runs reuse the recorded D1 id and skip the database prompt (interactive runs still ask for mode and, for modes 2/3, the worker name). The file is read strictly: a damaged, unreadable, or future-version file stops `deploy` and makes `status`/`doctor` exit 2 rather than pretending no deployment exists.
- **New: D1 provisioning with a safety guard.** `deploy` mode 2/3 lists the account's D1s, reuses `<worker>-db` when it exists or creates it, injects the `database_id` into `wrangler.jsonc`, and applies `dist/schema.sql` to an empty database. On a populated D1 the shared `resolveSchemaAction()` policy skips as already applied when the recorded hash matches, skips (no hash) or **stops on drift** under `--yes`, prompts interactively, and honors `--skip-schema`/`--schema=apply`. The count is fail-closed. `--d1-id <uuid>` reuses a database by id and resolves its real name from the list; if `wrangler d1 create` succeeds but its output cannot be parsed, `deploy` re-lists by name instead of leaving the new database unrecorded.
- **New: `--plan` preview + `--check`.** A zero-mutation, offline-by-default preview reusing the real resolver: no build, no `dist/`/`wrangler.jsonc`/`lw-state.json` write, no D1 create/apply, no deploy, no prompts. It reports the worker, D1 action/identity, schema action, files and cloud operations; exit 0 when actionable, 2 when a real run would stop. `--check` adds only read-only `d1 list` and table-count calls (scratch files cleaned up). `--dry-run` is rejected with a hint.
- **New: the Cloudflare account guard (`tools/cloud-account.mjs`).** Mode 2/3 resolves the account Wrangler will actually use — the `wrangler.jsonc` `account_id` pin first, then `CLOUDFLARE_ACCOUNT_ID`/`CF_ACCOUNT_ID`, then the sole account `wrangler whoami` reports — and compares its **account id** with the account recorded in `lw-state.json`. The id is the identity: an email alias or an account rename does not trigger a false switch. A mismatch **stops before any D1 list/create/apply or deploy** (exit 2); the ways through are `--allow-account-change` or, on a TTY without `--yes`, an explicit confirmation. An allowed switch clears the stale `workerUrl`/`deployedAt`, records the new account, and refuses to silently reuse a D1 the new account does not own. Several logged-in accounts with no explicit pin also stop (accounts are never guessed), and a set-but-invalid pin fails loud. Wrangler 4's `whoami --json` is used, with the human table as a fallback because Wrangler 3 rejects `--json` (fallback verified against a live read-only `whoami` on 3.114.13; the mismatch behavior itself is covered by the fake-Wrangler tests); an explicit `loggedIn: false` is never an identity, even when stale fields remain. `--plan` prints the recorded account and marks it unchecked; `--plan --check` resolves and compares the account and skips the D1 checks on a mismatch; `doctor --cloud` compares; `status` prints the recorded account. Old state files without the account metadata keep working and gain it on the next successful mode 2/3 run.
- **New: exit-code contract.** `2` = usage/config/state refusal (bad flags, missing `artisan`, invalid JSONC, corrupt state, missing account D1, a Cloudflare account mismatch or ambiguity, drift under `--yes`); `1` = build/Cloudflare/table-count failure; `0` = success. `--plan` uses `0`/`2`, plus `1` when `--check` cannot complete.
- **Live smoke (2026-10-28).** On a stock Laravel 13 app at its first commit, `deploy --mode 2 --d1-auto --yes` created the D1, applied the 9-table schema and wrote state; `deploy --mode 3 --d1-auto --yes` reused it, skipped the matching schema hash and deployed with Wrangler 4.151.1; `status`/`doctor` reported the URL and the worker answered HTTP 200. The local ISP intercepts `*.workers.dev` DNS, so the HTTP probe used the Cloudflare edge IP directly. The disposable worker and D1 were deleted afterward; no live resource remains.
- **New: JSONC-aware `wrangler.jsonc` editing (`tools/jsonc.mjs`).** Replaces regex edits with a dependency-free parser/editor that preserves comments, block comments, trailing commas and a BOM, rejects duplicate keys, targets the exact `name`/placeholder span, and re-parses the result before writing. The config `name` is authoritative; a recorded name rebuilds a deleted config, and an explicit `--name`/answer rewrites both `name` and the placeholder database name.
- **New: `status` and `doctor`.** `status` prints the recorded deploy state; `doctor [--cloud]` preflights node, PHP, vendor, APP_KEY, `wrangler` (reachability + a warning below v4), auth (`--cloud` runs `whoami`) and the deploy state, exiting 2 on failures.
- **CLI audit applied:** a bare `npx laravel-workers` now prints help (it used to run the test suite — the default was `test`); developer tasks (`test*`, `bench`, `check:docs`) are no longer in the shipped bin — they run via `package.json` scripts; `check:docs`'s split personality (docs-check in the bin vs gate in npm) is resolved by keeping only the npm (gate) route; `--version` added. `shadow` stays (referenced by COMPILED.md and `npm run test:shadow`).
- Fix: `doctor`'s PHP probe resolved the wrong path on Windows (double `C:\`); wrangler probing needs `shell:true` on Windows (`.cmd` shims) and the D1 table-count query is passed through a scratch file under `.cache/` because a shell-quoted `--command` splits on spaces.
- Fix: `deploy` now treats `lw-state.json` as durable metadata. A mode-1 run writes nothing; mode 2 preserves the last URL/deploy timestamp when the worker name is unchanged; a different D1 resets the old schema metadata; and `schemaHash` is only changed after a successful schema apply (a skipped apply no longer looks applied).
- Fix: the D1 table-count guard is fail-closed: it asks wrangler for `--json --yes`, checks the exit code, accepts rows or `meta.num_tables`, and stops instead of assuming "0 tables" when the output cannot be parsed.
- Fix: `wrangler d1 execute` now uses a throwaway config bound to the resolved D1 UUID. Wrangler 4 resolves a database name through the app's `wrangler.jsonc`, so the placeholder `database_id` made the pre-injection table count (and `--plan --check`) fail against `REPLACE_WITH_D1_ID`; the real config stays untouched until the schema decision is final, and the temporary config is removed after each call.
- Fix: `doctor --cloud` strips ANSI before reading the account email (it previously printed an escape-code fragment), and a state without `deployedAt` is labeled "recorded ... (not deployed yet)" instead of "deployed".
- Fix: explicit `--d1-id`/`--d1-auto` override a recorded D1. They are mutually exclusive and validated; a requested id that is not on the account is a hard error, not a guessed database name.
- Fix: `--yes` now suppresses every prompt (worker name, mode, database, schema); non-TTY paths still default to mode 1 and never touch Cloudflare unless a mode/D1 flag is explicit.
- Fix: `wrangler.jsonc` updates are conservative: worker names are validated, the config `name` is authoritative unless `--name`/an answer overrides it, and a D1 entry with no `database_id` is a clear error instead of a TypeError. `--name` is rejected in build-only mode instead of being silently ignored; the generated template and auto D1 name agree on `<worker>-db` (both capped at 63 characters), and a placeholder's `database_name` is rewritten when the recorded/selected name differs. Unknown build flags keep their values.
- Fix: a build-cache hit no longer skips a missing `wrangler.jsonc`; the config is ensured before the cache short-circuit, so a cached build leaves `deploy` with the config it needs.
- Fix: an installed tarball now finds `bcryptjs` when npm hoists it to the consumer's top-level `node_modules`; the build resolves the dependency the same way Node does, copies it into `dist/node_modules`, and a packaging smoke (`node tools/pack-smoke.mjs --app <laravel-app>`) built successfully from the installed CLI.
- Fix: `doctor` and `deploy` share `tools/run.mjs`; Windows `.cmd` shims are spawned with `shell:true` in one place. `doctor --cloud` therefore works on Windows, and `APP_KEY` detection ignores comments/empty assignments.
- Tests: `tools/tests/deploy-tools.test.mjs` covers worker/D1 parsing, D1 name safety, table-count parsing, `wrangler.jsonc` injection, state merging, wrong-type rejection, corrupt-state fail-closed behavior, schema decisions and argument quoting across the Windows shell. `tools/tests/jsonc.test.mjs` covers the JSONC parser/editor (comments, block comments, trailing commas, BOM, duplicate keys, placeholder targeting, verification). `tools/tests/deploy-integration.test.mjs` runs 34 black-box cases against fake build/Wrangler executables: zero-mutation `--plan`, `--plan --check` match/drift/missing-id plus the account match/refusal/unreadable cases, D1 create/reuse, placeholder injection, config recreation with a recorded name, schema skip/apply/drift/`--yes`, re-list fallback, corrupt state, exit codes and flag conflicts. `tools/tests/cloud-account.test.mjs` covers `whoami` JSON/table parsing, the Wrangler 3 fallback, account selection and the `account_id`/env precedence rules; `tools/tests/doctor-integration.test.mjs` covers the doctor account comparison (match, mismatch exit 2, Wrangler 3 table, legacy state, multi-account, config-pin precedence, offline). The fake executables and `tools/tests` are excluded from the npm tarball; `LW_BUILD_BIN`/`LW_WRANGLER_BIN` are test-only seams.
- Docs: README now documents `--plan`/`--check`, `--schema=apply`, hash-aware drift behavior, exit codes, JSONC editing, name precedence, the Cloudflare account guard and the cache/config rule; CLI help lists the same flags. MAP.md Track G + G.2 and the readiness row point at guided deploy.
- Suite: `npm test` 890/890 and `bun run test` 890/890; docs gate 105/105 + 113-construct audit. A real build-cache run confirmed a deleted `wrangler.jsonc` is recreated on a cache hit, and an installed-tarball run with the fake-binary env vars confirmed those test seams are inert. A read-only live `wrangler whoami` (repo Wrangler 3.114.13) confirmed the table fallback the account guard parses; no live account-switch exercise was run. The live Cloudflare path (mode 2 + mode 3) passed on 2026-10-28 (see the live-smoke bullet above); other accounts/plans remain operator-dependent.
- **Hardening (pre-release audit).** The CLI now finds the Laravel app root by walking up from both the cwd and the package directory — an npm install lives at `<app>/node_modules/laravel-workers`, so the old one-level-up guess never reached the app — and `build` exits non-zero when no `artisan` is found instead of printing an error and continuing to build the wrong directory. Windows command quoting for `npx` `.cmd` shims now caret-escapes cmd's metacharacters *after* quoting, because `cmd` expands `%VAR%` (and `!VAR!` with delayed expansion) even inside double quotes — a path or name containing `%` could otherwise be substituted. `doctor --strict` upgrades the missing-app-root warning to a failure (exit 2) so CI can treat "not a Laravel app" as fatal, while the default stays a warning. The D1 table-count scratch file is removed after use and the unused `schemaPath` parameter is gone; `resolveSchemaAction` documents the `--yes` "existing tables, no recorded hash" skip. JSONC parsing is depth-bounded and a duplicated `database_id` reports `ambiguous` instead of the misleading `missing-id`; the state tempfile name now includes the pid and a random suffix. The tarball gate also asserts the deploy-CLI modules ship, `kernel/tests` is excluded from the package, and the publish workflow runs the shadow harness first and creates the GitHub release only after `npm publish` (its `needs`) has succeeded.

## v0.4.5 — 2026-10-27

- New: **the frontend build is automatic (bun first, npm fallback)** — a fullstack app (any Blade view calls `@vite()`/`mix()`) whose manifest is missing no longer stops with "run `npm install && npm run build`": the build runs the app's own `package.json` `build` script itself — probing **bun** once at the start of the step, falling back to **npm** automatically when bun is not on `PATH` or its install/build fails — and installs dependencies only when `node_modules` is absent. It still fails loud, naming the exact view, when there is nothing to run (no `package.json`, no `build` script, neither runner on `PATH`) or the frontend build fails; the manifest's absence afterwards is an error, and backend-only apps are untouched (they still log `backend-only (no frontend build needed)`).
- **Performance (Track E): one PHP boot per route/view is gone.** `tools/prerender.php` takes every URI in argv and renders them all in ONE boot; `tools/compile-view.php --batch <jobs.json>` compiles a whole wave per boot — the registry route views + the 10 error views share one, and the controller views run one boot per `@extends`/`@include` dependency depth (a view's deps are only known once its dump exists, so depth = one wave). The transpile step runs in-process (`transpile()` — the same call the CLI makes, same bytes) instead of spawning `node` per view. A failed job prints `view <name>: …` on stderr, leaves that dump unwritten, and the rest of the wave still compiles (batch exits 1; `build.mjs` turns the missing dump into the route's verdict). Verified byte-identical against the pre-batch build on the audited real app (`blogkit`): same 143-file `dist` (only the `builtAt` stamp differs), cold wall time **37.4 s → 19.1 s**; registry-view success/failure paths re-tested end-to-end (a bad view name lands in READINESS as `no handler`, not a raw crash).
- **Feature: vendor-lite resolves a `composer.json`-only app against packagist.org** — the stock `laravel/laravel` skeleton ships no `composer.lock`, so every lockless build stopped dead ("commit a composer.lock"). `tools/composer-resolve.mjs` walks the require graph breadth-first with composer's stability rules — a **per-constraint stability floor** (`@dev` admits a dev build, an `@stable` side still rejects it; exact pins `dev-main` / `1.0.x-dev` / `1.0.0-dev` opt in by their own spelling), fetches Packagist's p2 metadata (`p2~dev` only when a floor allows), and keeps composer's guardrails: runaway resolution or a cycling graph says "commit a composer.lock", syntax it cannot evaluate truthfully skips the gate so the interpreter's real error surfaces instead of a bad guess. The resolved set lands in `vendor/.../resolved.json`, and `node tools/vendor-lite.mjs --lock` turns it into a standard `composer.lock` (content-hash per composer's own recipe — `composer validate` stays green) so the next build never hits packagist.
- Fix: `satisfies()` reads composer's `^0.x` semantics (bump the first **non-zero** component: `^0.2.3` → `>=0.2.3 <0.3.0`, not `<1.0.0`) and the `13.*` / `1.2.*` wildcard branches; `metapackage` entries are requirements-only and skipped instead of failing the fetch loop.
- Dependencies: `blade2php` → `^0.1.3` — raw PHP between component attributes passes through exactly like Laravel (the 0.1.3 release); the lock carries it with its integrity hash.

## v0.4.4 — 2026-10-27

A full audit sweep of both repos, verified against a **real Laravel 11.34.2 project** (`blogkit`: Breeze, Livewire, Sanctum, `Route::resource`, real `composer install`), differential-tested against `artisan route:list` / a booting app as ground truth.

- **Fix (P0): the static route scan now sees what Laravel registers.** Ground truth on the audited app: artisan listed **37 routes, the scan saw 5**, and the build still reported full coverage. `tools/routes-dump.mjs` now follows `require __DIR__.'/x.php'` (15 Breeze routes), expands `Route::resource`/`apiResource` (`only`/`except`/`names`/`parameters`, nested `posts.comments`), accepts the verb at **either** end of a chain (`Route::middleware(...)->get(...)`), reads route files registered by providers (`Route::prefix('api')->group(base_path('routes/api.php'))` — the Laravel 9/10-era shape), decides `if (config(...))`/`if (env(...))` conditions with the same static config the build uses (a route behind a false branch is no longer invented), and reads controller-level `$this->middleware('auth', ['except'=>…])` — without it `POST /posts/{post}/publish` shipped **without `auth`** at the edge. Array-entry keys (`['only' => …]`) were dropped because php-parser stores keys as STRING nodes. Result: **28/28 app routes, 0 invented**; the 9 package-registered routes no source scan can see are disclosed in one scope note on stderr.
- Fix: a `registry.json` that is not valid JSON, and a failing `registry.views` entry, crashed with a raw stack and **no READINESS block** (the C1 class the repo had already fixed elsewhere) — both now go through `fail()`.
- Fix: the `public/` copy is the whole document root now — only `index.php`/`.htaccess`/dotfiles/symlinks stay behind. The old three-name whitelist silently left `images/`, `sitemap.xml`, `manifest.webmanifest` and package assets 404ing at the edge.
- Fix: `corsPathFor` matches Laravel's `Str::is()` (`*` anywhere, not only as a suffix).
- Fix: framework default config (`cors.paths`, `hashing.*`, …) is loaded when the app ships no config file for it (Laravel 11+ skeletons stopped shipping `cors.php`), resolving the framework through `LW_VENDOR_DIR` as well as `vendor/` — an empty `cors.paths` had silently disabled the CORS-route skip.
- Fix: snapshot origin rewriting also covers the app's own `APP_URL`, so a Herd/Valet domain (`myapp.test`) no longer bakes dead links into snapshots.
- Fix: a schedule dump that fails is a BLOCK finding now, not a scrollback line — cron triggers used to vanish silently.
- Fix: `tools/_root.php` auto-`APP_KEY` was dead code (`!putenv('APP_KEY')` is never true: `putenv` without `=` unsets and answers true), so tool runs on a checkout without `.env` died with `MissingAppKeyException`.
- Fix: `tools/compile-view.php` on Laravel ≤ 11 — `Vite::fonts()` (12.x+) threw and the app's exception handler rendered it with **exit 0**, so the build only ever saw "dump missing": guarded with `method_exists`, plus an exception handler that exits 1 with the real cause.
- Fix: transpile failures at the error-view and registry-view sites crashed with a raw `execFileSync` dump (no READINESS block); both now `fail()` carrying the LW error and the standalone command.
- Improvement: `vendor-lite` verifies `dist.shasum` from the lock (the bytes become executed PHP), retries transport failures three times naming the package and URL (`fetch failed` with no URL was measured on a real 80-package lock, dying at package 59), and refuses source-only locks with a pointer to `composer install`. Its 3 tests are wired into `npm test` — they had never run.
- Improvement: the build streams the route scanner's stderr (scope disclosures, parse issues) into its log; the routes log line no longer claims `php artisan route:list`; the route-crash message no longer blames `.env`/DB for what is now a JS scan.
- Improvement: `hasBinding` strips `/* */` comments from `wrangler.jsonc`, not only `//`.
- Port: `kernel/arr.mjs` — `Arr::except()`, the view-data filter Blade itself emits on Laravel 11.0–11.42, with `Arr::forget` semantics (exact key first, then dot paths, copy-on-write so the caller's array never changes). Without it **no view** of an app on those versions transpiled (`LW003`).
- The build passes `installed` (the exact framework version from `composer.lock`) to blade2php — see blade2php 0.1.2: Laravel changed bytes **within** 11.x (v11.43.0).
- Dependencies: `blade2php` pinned to `^0.1.2` (was `latest` — any future release would have changed user builds while CI stayed green on the lock); the lock carries 0.1.2 with its integrity hash.
- Suite: **773/773** (three vendor-lite tests joined), docs gate **105/105**, e2e build green on the audited Laravel 11.34.2 app.

## v0.4.3 — 2026-10-27

- New: **conditional frontend-manifest check** — `build.mjs` pre-scans `resources/views/**` for `@vite()`/`mix()` instead of demanding a manifest from every app. A fullstack app without one fails up front, naming the exact view and the one-time `npm install && npm run build`; a backend-only API app (no view touches the frontend) needs no manifest at all and used to be failed by the old unconditional check.
- New: **build-time DB sandbox** — `tools/schema-compile.php` takes an optional second argument and materialises a throwaway SQLite with the schema it just compiled. `build.mjs` seeds `.cache/laravel-workers/build.sqlite` when the app's own SQLite database is absent or was `touch`ed but never migrated, so a fresh `laravel new` project boots for prerender and reports `RUNS ON THE EDGE` instead of `DOES NOT RUN` (Laravel's session middleware reads `sessions` on every request). Your own database file, when real, is used as-is and never written to; `npx laravel-workers deploy` (mode 2/3) applies `dist/schema.sql` — the one-manual-step D1 flow is now the guided `deploy` command (v0.4.6).
- New: **auto APP_KEY** — `build.mjs` writes `APP_KEY=base64:<32 random bytes>` into `.env` when absent (from `.env.example` when present), so a fresh clone builds with zero manual config. The key persists across rebuilds (the worker encrypts cookies/sessions with it). `schema-compile.php` uses `lw_boot_app()`, which injects a key for standalone runs too.
- New: **auto `wrangler.jsonc`** — when absent, build.mjs scaffolds it with the worker name from the app-dir slug and a `database_id` placeholder. It never creates cloud resources — only the local config file; `npx laravel-workers deploy` (mode 2/3) creates/reuses the D1 database and injects `database_id` into `wrangler.jsonc` automatically (v0.4.6).
- New: **Bun ≥ 1.0** — the full suite passes under `bun run test` (768/768); `engines.bun`, the requirements row, and the package description/keywords follow ("compile to JS bundle, no PHP at edge").
- Docs: README Quick start + zero-touch section rebuilt around "build is self-sufficient, `init` optional"; two new subsections — *Fullstack app vs backend-only API* and *What `RUNS ON THE EDGE` claims (routes, not data)*; CI e2e drops the stale `php artisan key:generate` to actually prove the zero-config path.

## v0.4.2

Bug-fix release for the npm tarball (what a user installs and what `build.mjs` runs against must ship):

- Fix: `compiler/blade.mjs` is now in the tarball's `files` allowlist — no more `Cannot find module …/compiler/blade.mjs` (the e2e tarball build imports it).
- Fix: every `tools/*-dump.mjs` helper plus `tools/static.mjs` and `tools/php-runtime.mjs` are committed and ship in the tarball — no more `Cannot find module …/tools/routes-dump.mjs` (the build spawns them).
- CI: the `Pack dry-run` step is now an asserted tarball gate — it fails loudly if any build-time module is missing, catching this bug class before e2e boots.
- New: `tools/schema-compile.php` compiles migrations directly to D1 SQLite DDL — no pre-migrated database required; driver-agnostic (MySQL/SQLite/PG source apps all target D1 SQLite).

**Status: 0.4.0 prepared, the npm publish waits on a valid npm login.** The compiled rung covers M1-M70 (the construct audit: **114 constructs - 41 compile, 63 fail loud, 10 documented at the build level**; every facade of Laravel 13 has a row, the facade coverage is 47/47): controller transpilation (M10/M17/M22/M23), the kernel layers M11-M22 (M21 `ValidationException::withMessages`, M22 multi-verb URIs), the T0-T10 hardening pass (docs/code parity, strict extra-verb gate, request-call consistency, `rt.cache()`, compiled error views, `hashed` cast + `fillable`, validation display names), M23-M25 (FormRequests, `Cache`/`Hash` facades, class constants, Eloquent writes, `auth.basic`; the general shadow harness + a green CI with the PHP oracle parity running for real) and M28-M30b (the service adapters are wired — `Storage::` on R2 **or the D1 blob store**, mail, queue, and the scheduler as Cloudflare Cron Triggers; a fully-qualified static call resolves to the global class; the shadow harness proves the object store end to end). The 7c Breeze-login E2E is green (1/1). Still open per `COMPILED.md`: the *fluent* facades (`Storage::disk()`, `Mail::to()->send()`, `Queue::push(SomeJob::class)`) need a port (the disk/mailable/job classes are not compiled), and the route-level parity tests (the 11-step web pipeline, the Breeze login flow) run against the local fixture app.
- **M1** View parity — Blade-compiled PHP → dependency-free ESM; `welcome` byte-identical 35,647 B (sha256 `b228c8a2…`); corpus 51/51.
- **M2** Router integration — `routes → router`, code-gen `controllers/middleware`, build `--strict` PASS, `nearfind-edge` live `/` + `/health` 200.
- **M3** D1 layer — schema snapshot (`.cache/schema.json` → `dist/schema.json`), `kernel/db.mjs` query builder, `kernel/model.mjs` Model base, mock-D1 tests 8/8, `nearfind-edge` `/dbcheck` via builder, D1 remote has `config` + `_cf_KV`.
- **M4** Packaging + CI — `package.json` (`laravel-workers@0.3.0`, bin CLI), `.github/workflows/ci.yml`, MIT license, `npm pack --dry-run` clean, tests green.
- **M5** Hash + Encrypter parity (kernel/hash.mjs bcrypt make/check/needsRehash + kernel/encrypter.mjs AES-256-CBC+HMAC WebCrypto, payload iv/value/mac/tag byte-compat, incl. MAC-tamper/wrong-key)..
- **M6** Validation kernel (kernel/validator.mjs, 60+ rules incl. `unique`/`exists` via D1, pipe-safe regex, nullable/sometimes, bail, 26 subtests)
- **M7** Services kernel (kernel/mail,queue,cache,storage,scheduler.mjs, 18 subtests)
- **M8** Final gates (tools/docs-check 105/105 + tools/bench + budget.test p95<=5ms hot)
- **M9** Zero-touch hardening (2026-10-18) — scaffold stubs now follow the controller contract (default export, `{status, headers, body}`, `laravel-workers:stub` marker); `build --strict` fails on unimplemented stubs + missing port files; `LW_CONFIG`/`LW_PORTS_DIR` let registry + ports live outside the repo; `registry.json` optional (defaults + notice); routes defined outside `routes/` are listed as skipped. Verified: stub `501` keeps the worker alive → implement → `200` via local D1; external config+ports E2E; fresh Laravel 13.37 zero-config build PASS. `tools/ports.mjs` + 5 tests → npm test **170/170**.
- **M10** Controller transpilation v1 (2026-10-18) — `GET`/`HEAD` routes with a resolvable controller method are compiled at build time to `dist/src/controllers/*.mjs` (handler `(ctx, env)`): scalar route params, Eloquent chains (`find`/`findOrFail`/`all`/`where*`/`orderBy*`/`limit` + `first`/`get`/`count`/`pluck`/`value`), `view()`/`redirect()`/`abort()`/`compact()`/`response()->json()`, `route()`/`url()` from the frozen name map; model metadata dumped per FQCN; unsupported constructs fail loud (LW001–LW004 with a "write a port" hint). Verified on a fresh Laravel 13.37 app end-to-end: `--strict` build (snapshot `/` + 2 controllers) and `wrangler dev` against local D1 (`/posts` list, `/posts/1` detail, `/posts/999` → 404 via `findOrFail`). npm test **195/195**, corpus 51/51.
- **M11** Session kernel parity (2026-10-18) — `kernel/session.mjs`: PHP `Store` semantics (flash `_flash.new`/`_flash.old` rotation, `_token`, `ageFlashData`, `migrate`/`regenerate`/`invalidate`) behind cookie + D1 handlers; byte-identical cookie payloads vs the PHP 8.3 oracle (deterministic via `freeze_ms`/`render_now`).
- **M12** Rate limiting parity (2026-10-18) — `kernel/ratelimit.mjs`: `RateLimiter` + `ThrottleRequests` incl. named `for()` limiters, middleware `using()` prefix, HeaderBag last-limit-wins, PHP falsy/numeric/int semantics; PHP 8.3 oracle.
- **M13** CSRF parity (2026-10-18) — `kernel/csrf.mjs`: `PreventRequestForgery` token resolution (session / `X-CSRF-TOKEN` / `X-XSRF-TOKEN`), `except()` (SORT_STRING dedupe), `normalizeQueryString` (hex-key parse, ksort, RFC3986), XSRF cookie shape; PHP 8.3 oracle.
- **M14** Auth parity (2026-10-19) — `kernel/auth.mjs`: `SessionGuard` (attempt/attemptWhen/once/validate/login/logout/logoutOtherDevices, `viaRemember`), remember-me recaller + rotation + hmac cookie, `EloquentUserProvider`, `BcryptHasher` (`$2y$`-only, `needsRehash`/`verifyConfiguration`), `AuthManager`, `auth`/`guest` middleware, auth events. `tools/php-auth-oracle.php` + `kernel/tests/auth.test.mjs`: 13 guard runs compared 1:1 (session bytes, DB rows, event stream, Set-Cookie bytes), recaller hostile-payload corpus, hasher ops. npm test **269/269**.
- **M15** Compiled HTTP pipeline (2026-10-19) — `kernel/http.mjs` (`handleHttp`): runs the `web` group in vendor order (`EncryptCookies → AddQueuedCookiesToResponse → StartSession → ShareErrorsFromSession → PreventRequestForgery → throttle → route`) plus `auth`/`guest` route middleware, resolves provider models through `models.generated.mjs`, emits Symfony-shaped `cache-control`/redirect bodies. `tools/php-http-pipeline-oracle.php` + `kernel/tests/http.test.mjs`: an 11-step scenario (anonymous → login → CSRF failure → logout) compared **per step** on status, headers, `Set-Cookie` attributes, body and the raw D1 session payload bytes, plus `parsePhpQuery` vs live PHP `parse_str` (29 cases; the NUL-in-key divergence is pinned fail-closed) and fail-loud guards. npm test **276/276**.
- **M16** Compiled controllers — request + session/auth helpers (2026-10-19) — `Request $request` injection, `session()`/`session('k')`/`old()`/`csrf_token()`/`csrf_field()`/`request()`, `auth()`/`Auth::check|guest|user|id` (guarded by await-injection; the guard resolves the user asynchronously), and a `$request->method()` allowlist (`input`/`all`/`query`/`has`/`string`/`header`/`ip`/`user`/`session`/…). `$request->validate()` and files fail loud (need D1 + a port). npm test **282/282**.
- **M17** POST controller actions (2026-10-19) — the build now transpiles single-method `POST` actions, not just `GET`/`HEAD` (`build.mjs` `methodsOk`); the compiled handler is registered under `METHOD uri` and the router dispatches it. A route that answers several verbs on one uri still needs a port. Verified 1:1 on the fixture app: `POST /submit` (with `Request $request`) → `302`, `location: /posts`; `GET /submit` matches nothing (no handler). npm test **282/282**.
- **M18** D1 cache store + `throttle` middleware (2026-10-19) — `kernel/cache.mjs` gains `DatabaseCacheStore` mirroring `Illuminate\Cache\DatabaseStore` 13.37 (values `serialize()`d via `php-serialize.mjs` with the SQLite/Postgres NUL-byte→base64 rule, expiry as integer second timestamps, `add` = `INSERT OR IGNORE`, `put` = upsert, `forever` = +315360000 s, expired = read-then-delete, `currentTime()` = `Carbon::now()->getTimestamp()`). The `RateLimiter`/`ThrottleRequests` path is now async so it can drive the D1 store (each cache op is a round trip; `await` is a no-op on the sync `ArrayCacheStore`). `tools/php-cache-oracle.php` + `kernel/tests/cache.test.mjs`: put/add/forever/get/has/increment/decrement/forget/touch/flush replayed against the real `Repository` over SQLite, comparing return values **and the raw `cache` rows** 1:1. The build now emits `middleware` into `routes.generated.mjs` — it was previously dropped, which silently downgraded every compiled route to the session-less bare path — and honours numeric `throttle:n[,m]`, failing loud on named limiters and when `cache.driver !== 'database'`. `tools/config-dump.php` now emits `cache.{default,prefix,driver,table,lock_table,serializable_classes}` and `src/worker.mjs` builds the store from the D1 binding. npm test **288/288**.
- **M19** Validation flow — `$request->validate()` / `validateWithBag()` (2026-10-19) — compiled controllers may now call `$request->validate($rules, $messages?, $attributes?)`; the transpiler awaits a live `rt.request().validate(...)` that runs `kernel/validator.mjs` over the request input (D1 binding passed for `unique`/`exists`). A failure throws a new `ValidationException` (`kernel/validation.mjs`, mirroring `Illuminate\Validation\ValidationException`: status 422, `errorBag`, `redirectTo`, the `summarize()` "(and N more error(s))" message) which the compiled controller rethrows so `handleHttp` renders it like `Illuminate\Foundation\Exceptions\Handler` — a 302 back to `url()->previous()` (Referer → flashed previous URL → `/`) with `_old_input` (everything except `Handler::$dontFlash` = `current_password`/`password`/`password_confirmation`) and the `errors` bag flashed in the `Store::prepareErrorBagForSerialization` json shape (`{ bag: { format: ':message', messages } }`), or a 422 `{ message, errors }` body for `expectsJson`. Non-json session serialization (the `ViewErrorBag` `serialize()` path) fails loud. `kernel/tests/validation.test.mjs` (11 tests: exception surface, `installValidation`, and the compiled pipeline redirect/422/valid + fail-loud paths) -> npm test **300/300**.
- **M20** `redirect()->intended()` + controller session rotation (2026-10-19) — `redirect()->intended($default = '/')` compiles to `rt.redirect(rt.session().pull("url.intended", "/"))`, mirroring `Illuminate\Routing\Redirector::intended()` (the `url.intended` key the `auth` middleware writes on a guest redirect; default `/`). Compiled controllers may now call `session()->regenerate()` / `invalidate()` / `regenerateToken()` (and through `$request->session()`); `regenerate`/`invalidate`/`migrate` are awaited against the handler while `regenerateToken()` stays sync, matching `Illuminate\Session\Store`. With `$request->validate()` (M19) and `Auth::attempt` (M16) a stock Breeze-shaped login controller now compiles end-to-end; the only remaining gap is a class-constant default such as `RouteServiceProvider::HOME` (use a string literal or a port) and FormRequests. `compiler/tests/controller.test.mjs` (+3: `intended()` default + arg, session-method await/sync codegen, and a runtime `intended()` pull + regenerate ordering test) -> npm test **303/303**.
- **T4/T7/T8** cache facade + compiled error views (2026-10-19) — `rt.cache()` exposes `get`/`put`/`forget`/`remember`/`has`/`pull` over the D1 `database` store; every `resources/views/errors/{code}.blade.php` is compiled at build time into `dist/src/views/errors.<code>.mjs` + context, wired through `error-renderer.mjs`, and rendered for `abort()`/HTTP errors (`419`/`429`/`500` included) when present. Verified by building the fresh fixture with a `404.blade.php` and rendering `renderErrorView(404, …, { getMessage: () => 'Missing page' })` -> the compiled HTML.
- **T9** `hashed` cast + build-time `fillable` (2026-10-19) — `tools/model-dump.php` now dumps `getFillable()`; `Model#set()` applies `hashed` synchronously (`makeSync`, `$2y$`) with PHP 8.3 `password_get_info` semantics: plaintext hashes, full `$2y$` with cost ≤ rounds passes through, `$2a$`/`$2b$`/truncated `$2y$` re-hash, argon2 or cost > rounds throws `RuntimeException("Could not verify the hashed value's configuration.")`, null stays null, mutators win. Rounds are baked from `hashing.bcrypt.rounds` (default 12); cost 12 measured ~679 ms CPU on Workers (matches Laravel, above the nominal Free 10 ms budget — login/reset paths only). Divergence: models without `$fillable` keep the allow-all fallback (`guarded` semantics not implemented).
- **T10** validation display names (2026-10-19) — `$attributes` exact key, primary wildcard key, wildcard patterns (one dot-free segment per `*`, `preg_quote`-safe for punctuation like `-`/`:`), PHP truthiness (`''`/`'0'`/null fall through), raw name for implicit wildcard fields, and `Str::snake` + `_`→space fallback; custom messages support `field.rule`, `rule`, `field`, and wildcard keys, replace `:attribute`/`:ATTRIBUTE`/`:Attribute`, and resolve size-rule arrays by attribute type (`numeric`/`array`/`string`) with wildcard arrays indexed by rule name; empty custom messages are kept (Laravel's `is_null` check). Pinned to the Laravel 13.37 `FormatsMessages` + PHP 8.3 oracle. npm test **342/342**.
- **M21/M22** `ValidationException::withMessages()` + multi-verb URIs (2026-10-19) — a compiled controller may throw `ValidationException::withMessages([...])` (the same exception class the kernel catches), and a URI may answer several verbs: the primary GET/POST handler plus one extra handler per verb (`login--post.mjs`), keyed `METHOD uri` in the route table.
- **M23** The construct closure (2026-10-19) — FormRequests compile (`rules()`/`messages()`/`attributes()` are dumped at build time, the request is validated before the method body, `validated()` returns the ruled attributes), the `Cache`/`Hash` facades compile, class constants (`RouteServiceProvider::HOME`) are dumped and baked in, Eloquent writes compile (`create`/`fill`/`save`/`delete`/`$model->attr = ...`), `response()` returns a `text/html` response, and the `auth.basic` middleware is honoured (401 + `WWW-Authenticate`). The construct-coverage app builds `--strict` with 10/10 controllers.
- **M24** The shadow harness (2026-10-19) — `shadow/run.mjs` + `tools/php-shadow-oracle.php` boot the real app (PHP 8.3 + sqlite) and the compiled worker and diff status/headers/body byte-wise over a scenario (four verdicts: byte-identical, shape-verified, documented divergence, unexplained). It found six real divergences (the `response()` content-type, the default `Cache-Control`, the model timestamps using the wall clock, the `auth.basic` challenge, the error body, and a missing-credentials request passing) — all fixed. Construct app: 19/21 byte-identical + 1 shape + 1 documented, 0 unexplained; fresh app: 10/10 byte-identical.
- **M25** CI green (2026-10-19) — the PHP oracle parity tests skip (with a reason) when no Laravel app is available, and a new CI job creates a fresh Laravel app and runs the parity for real (auth, cache, csrf, session, rate limiter).
- **M28** The service adapters are wired (2026-10-20) — the worker builds the storage (R2), mail (log/noop/resend) and queue (CF Queues) adapters from the app config and hands them to the handler; the `Storage::` facade compiles to the R2 store (`put`/`get`/`exists`/`delete`) and fails loud without the binding. The fluent `Mail::to()->send()` and `Queue::push(SomeJob::class)` facades still need a port (job/mailable classes are not compiled).
- **M29** The scheduler is wired (2026-10-20) — the build dumps the app’s schedule (`tools/schedule-dump.php`) into `dist/src/schedule.generated.mjs` plus `dist/cron.json` (the Cloudflare Cron Trigger list — Free allows 5 triggers/account); the worker exposes a `scheduled` handler (and `POST /__lw/cron`) that evaluates the due events and queues them for the app runtime — the edge triggers, it does not run artisan. Events whose cron expression Cloudflare cannot express are reported in the build log.
- **M30** The object store is pluggable + the FQCN fix (2026-10-20) — `Storage::` now has two backends: **R2** when the app binds it, else the **D1 blob store** (one row per object in `lw_blobs` — no extra Cloudflare product, no credit card; the build prints which store it picked and fails loud when the app binds neither). The build also emits `dist/schema.sql` (the app's tables + `lw_blobs`) so the D1 schema can be created with `wrangler d1 execute DB --file=dist/schema.sql`. A fully-qualified static call (`\Illuminate\Support\Facades\Storage::put()`, `\App\Models\Post::create()`) now resolves to the global class instead of the controller's namespace, and the `npm run test:shadow` script (or `npx laravel-workers shadow --app <root>`) runs the shadow harness. The shadow harness now proves the store end to end (`POST /storage-demo`: the compiled side writes to the D1 blob store, the real app to the local disk, and both read the object back — **20/22 byte-identical, 0 unexplained**). npm test **369/369**.
- **M31** The packaging gate (2026-10-20) — `tools/pack-smoke.mjs` (`npm run test:pack`) packs the repo, installs the **tarball** into an empty project and runs the *installed* toolchain against a real Laravel app (the CLI build, the compiler import, the shadow harness). The published file set is proven, not assumed; the CI e2e job now installs the tarball instead of the workspace.
- **M32** The `Storage::` facade keeps Laravel's return values (2026-10-20) — read in the vendor: `FilesystemAdapter::put()` answers a **bool**, `delete()` answers a **bool** (`false` when the file was missing) and `get()` **throws** `UnableToReadFile` for a missing file. The compiled store now answers the same (`put` → `true`, `delete` → a bool from the D1 `meta.changes` / the memory Map / an R2 `head()` check, a missing `get` → a loud failure, not `null`). The shadow step exposes the values (`hello-shadow|yes|yes|yes|no`) and both sides are byte-identical.
- **M33** The helper verbs (2026-10-20) — `abort_if()`/`abort_unless()` compile (they answer null unless they abort), `now()`/`today()` follow the **request clock** (the oracle freezes Carbon; the wall clock diverged — a hidden parity bug), and the `Log::` facade compiles to the **platform log** (the Workers console, the padanan for the app log file). The shadow step proves it: `POST /verbs-demo` answers the same date on both sides. npm test **372/372**.
- **M35** The construct audit is generated (`npm run audit:constructs`): 31 constructs probed against the real compiler - 19 compile (and are proven by the shadow harness), 10 fail loud with their code, 2 are build-level (a Blade layout, an `OPTIONS` route). The gate (`npm run gate`) keeps the table and the code in sync. The plan: **M39** the class-bearing calls (`Event::dispatch()`, `Gate`, `Mail::to()->send()`, `Queue::push(SomeJob::class)`, `Storage::disk()` - they need the class compiler), **M40** the build-level constructs (the Blade layouts, `paginate`, the eager relations, the uploads, the `OPTIONS` route).
- **M34** The `new` expression (2026-10-20) — only the **PHP built-in exceptions** compile (`new RuntimeException('boom')` → an error with the same class name and message; the handler answers the same 500 as Laravel). An app class (`new App\Exceptions\Mine`) is **not** compiled: it fails loud with LW002, it never becomes a silent stub. `throw_if()`/`throw_unless()` compile too. The step found two real harness bugs: the oracle let whoops print the debug error page over its JSON (whoops exits → the whole run died), and an uncaught error on the compiled side escaped the harness — both fixed, and the 500 is now a documented divergence. npm test **375/375**.
- **M36** The flash (2026-10-20) — `redirect()->with()`, `->withInput()` and `->withErrors()` compile: the flash goes into the **session** (Laravel reads it on the *next* request), reusing the same error-bag shape as the validation flow. The shadow harness proves it end to end (`POST /flash-demo` → 302 → `GET /flash-target` reads back `saved|Flash me`, byte-identical on both sides). npm test **377/377**.
- **M37** The helper surface (2026-10-20) — `redirect()->away()`, `back()`, `env()`, `data_get()`, `tap()`, `report()`, the `cache()` helper and `session([...])` compile. `env()` is padded by the build-time config dump (there is no `.env` at the edge). The step found **three real bugs**: `config()` never reached a compiled controller (the router's context did not carry it), the D1 cache store wrote an **already-expired** row for a `put()` without a TTL (Laravel: a TTL of 0 means *forever*), and the `cache()` helper's semantics (`cache('k','v')` is a *get* with a default, not a put). npm test **379/379**.
- **M38** The `Str` family (2026-10-20) — `kernel/str.mjs`: 22 string helpers (`slug`, `limit`, `upper`, `lower`, `studly`, `camel`, `snake`, `kebab`, `title`, `contains`, `startsWith`, `endsWith`, `after`, `before`, `length`, `replace`, `replaceFirst`, `replaceLast`, `squish`, `ucfirst`, `ucwords`, `ascii`) — every value is **verified against the real Laravel** (`kernel/tests/str.test.mjs` carries PHP's own answers), and the shadow step proves them end to end. A helper outside the surface fails the build (LW002), it never becomes a silent stub. npm test **380/380**.
- **M42** A relation (or an accessor) read as a **property** (`$post->comments`) used to answer `null` - a wrong answer, silently, which is worse than a 500. Now the **build stops** (LW003): the model dump (`tools/model-dump.php`) also lists the methods the app declares on the model (the relations, the accessors), and the compiler rejects a property read on a model variable. The runtime model shim guards the same names, so a Blade view (which carries no type information) fails loud instead of rendering an empty relation. The construct audit has 32 rows now. npm test **385/385**.
- **M41** The last known gap is closed (2026-10-20) - a method call on a **model** (`$post->comments()`), on a **query builder** (`$q->whereLike()`) or on an **unknown variable** used to compile and answer a 500 at the edge. Now the **build stops**: the relation is LW003, an unknown variable is LW002, and a method call in a Blade view is LW002 too (the error bag is the only object with methods there). The allowed model methods are the ones the compiled model really has (`kernel/model.mjs`), so `fill()`/`get()`/`toJSON()` keep working. The audit table now has **no third state**: every construct either compiles (and is proven) or fails the build. npm test **383/383**.
- **M39a** The **Gate** compiles (2026-10-20) - `Gate::allows()`/`Gate::denies()` used to fail loud (`unknown class/static Illuminate\Support\Facades\Gate::allows`): the policy is a class, so the check never compiled. Now the **policy is compiled at build time**: `tools/policy-dump.php` boots the real app, asks the Gate which policy answers for a model and dumps the abilities with Laravel's own guest rules; `compiler/src/policy.mjs` compiles the ability methods and the `before()` hook into async functions (`dist/src/policies.generated.mjs`). The runtime keeps Laravel's order: the policy `before()` first (a non-null answer wins), then the ability; a guest the policy does not allow is **denied without the method being called**; a missing ability is Laravel's `false`. The global Gate registrations are not compiled and fail loud with their own reason (`Gate::before()`/`after()`, a `Gate::define()` ability, a policy with a `__call()`, `Gate::authorize()`, `Gate::any()`). The shadow harness proves it: the same policy answers the same bytes as the real Laravel, for a signed-in user **and** for a guest. npm test **405/405**.
- **M39b** The class-bearing calls, **bounded** (2026-10-20) - free plan first, a little tolerance for R2. `Storage::disk('<the app's default disk>')` now compiles to the compiled object store (the D1 blob store - no card; R2 when the app binds it), fluent form included, with the same return values as the flat `Storage::` calls. A **named** disk fails loud (LW002): it needs a bucket of its own, and **R2 asks for a credit card** (the free path is the D1 blob store, 1.5 MB per object). `Cache::tags()` fails loud (the D1 `database` store has no tags - in Laravel the same store throws BadMethodCallException when the route runs, so the build refuses the route *earlier*: stricter than Laravel, not a parity), and the build now **fails the build** when a compiled route uses the cache on another driver - the compiled store would read and write a different store (a silent divergence). `Event::dispatch()`, `Mail::to()->send()` and `Queue::push(SomeJob::class)` fail loud with their reason: the listeners / the mailable / the job are classes, and at the edge there is no listener runtime and no queue consumer - a dispatch or a push would be a **silent no-op**. The **file upload** (`$request->file()`) failed loud here too (the edge had no multipart parser yet): it compiles since **M40 part 5**. npm test **412/412**.
- **M40** The build-level constructs, part 1 (2026-10-20) - the **Blade layouts**, the **route-model binding**, the **method handling**, the **paginator** (+ the **pagination links**) and the **PHP casts** compile now. A layout (`@extends` / `@section` / `@yield`) used to be a view-level construct the compiler could not answer (`$__env->…`): the env now carries the sections (Laravel's own order), it is shared with the nested render (the layout is rendered with the env of the view that extends it), and the build compiles the **view closure** (the compiled PHP names the views it uses) so the layout is compiled and imported too. The **route-model binding** (`show(Post $post)`) used to be an unsupported parameter type: the model now comes from the route segment (a missing model is a 404, like Laravel's `ModelNotFoundException`), the binding is checked the way Laravel binds it (by name) and a model that binds on another key fails loud. The **method handling** is Laravel's `AbstractRouteCollection`: an `OPTIONS` request gets the **automatic OPTIONS response** (200, an empty body, the `Allow` header with the verbs the URI accepts) and a method that does not match answers like Laravel (405 with an `errors/405` view, else 500) - the same status Laravel answers. The **CORS** config is not compiled: the build skips the routes under a CORS path (the `Access-Control-*` headers would be missing) and says what to do. The **paginator** (`Post::paginate(10)`) answers Laravel's `LengthAwarePaginator` and its **pagination links** render the framework's `pagination::tailwind` view - compiled at build time (the view name has a `::`, not a legal Windows file name, so the compiled modules use a sanitized name), **byte-identical** to Laravel's markup; the **translations** (`__()`) are dumped at build time (the app's `lang/` + the framework's fallback). The shadow harness proves all of it byte-for-byte - and it found a **silent wrong answer** on the way: `$arr[] = $x` (the PHP array append) compiled to `$arr[null] = $x`; now it appends. What is left in this batch: the **file uploads** (the last item - part 5). npm test **432/432**.
- **M40 (part 5)** The **file upload** compiles (2026-10-20) - the multipart body is parsed at the edge (`kernel/multipart.mjs`: the boundary, the fields, the files, the PHP field names - `photos[]` is an array), and `$request->file('x')` answers Laravel's file object: the **name** (the basename, like Symfony's `File::getName()`), the **extension** (`pathinfo`), the **type the browser declared**, the **size** and `isValid()`. The file is in the validated data (Laravel's `all()` merges the files), the `file` rule works, and the size rules of a file are in **kilobytes** (Laravel's `(string) ($file->getSize() / 1024)`, compared exactly) with Laravel 13's own message ("... must not be greater than 0 kilobytes."). `$file->store()`/`$file->storeAs()` write to the app's **default disk** (the D1 blob store on the free plan, R2 when the app binds it) and answer Laravel's disk-relative path (`trim($path.'/'.$name, '/')`); a **named** disk fails loud (it needs a bucket of its own). What cannot be answered like PHP **fails loud**: the content type of a file (`getMimeType()`, `guessExtension()`) and the `mimes`/`mimetypes`/`image`/`dimensions` rules read the file's **bytes** (finfo) - the edge has only the type the browser declared, so the build stops (LW002/LW003) instead of answering differently. The shadow harness proves the whole path **byte-identical** (the metadata, the store round trip and the 422 of a too-big file). npm test **449/449**.
- **M39c** The **class compiler**: the event listeners compile (2026-10-20) — `Event::dispatch()` used to fail loud because the listeners are classes and at the edge there is no listener runtime (a dispatch that answers nothing is a *silent* no-op). Now the build **compiles the classes**: `tools/event-dump.php` boots the real app and asks Laravel itself which listener answers which event (the explicit `$listen` **and** the auto-discovery of `app/Listeners`), `compiler/src/classes.mjs` compiles the constructor (the promoted properties) and the public methods (through the ordinary transpiler, so `$this` is the instance), and the dispatch calls them **synchronously**, like Laravel (every listener runs, only an answer of `false` stops the chain, and the dispatch answers the array of the responses). The classes ship in `dist/src/classes.generated.mjs`. What still fails loud: a **queued** listener (`ShouldQueue`: Laravel runs it later in a worker; the edge has no consumer), a dispatch of an event **name** (no class, no listener) — and `Queue::push()` / `Mail::to()->send()` stay fail-loud on purpose: a queued job would never run at the edge (the worker has no queue handler) and a mailable renders a Blade view (the compiled rung cannot prove the rendered payload is byte-identical). The **constructor** of a compiled class may have a body (the assignments land on the instance, like `$this->x = ...`). The shadow proves it: the compiled listener writes to the post exactly like Laravel's (`POST /event-demo` — byte-identical). npm test **463/463**.
- **M44** The **service injection of the listeners** (2026-10-21) - a listener whose constructor asks for a **service** used to fail loud ("the edge cannot inject one"). Now the build knows what the constructor wants: `tools/event-dump.php` asks the **real container** (the dump carries each constructor's parameters) and the build compiles the **dependency** - an app service the build compiled (the edge builds it) or a framework service (`kernel/service-adapters.mjs`: the mailer, the logger - the worker hands the live one down, `compiler/runtime/rt-from-context.mjs`). A type written short (`Mailer`) resolves through the file's `use` statements and its namespace; a name several compiled classes share fails loud; the async methods of an injected service are **awaited** in the compiled body (a promise must never leak into the response) and an app service (a compiled class) gets the runtime as its first argument. A service the build does not compile still fails loud, and it names the class. The construct audit: **53 constructs** (33 compile, 17 fail loud, 3 build level).
- **M45** The **reasons** of the two refusals, honest (2026-10-21) - `Queue::push()` and `Cache::tags()` failed loud, but each reason was blunt or misleading. The queue: the job would never run at the edge - the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job. The paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row - the edge has no producer for it). The job class is not compiled either. The cache: the D1 `database` store has no tags - in Laravel this route 500s with `BadMethodCallException("This cache store does not support tagging.")`; the build refuses the route before it ships, which is stricter than Laravel, not a parity. Both refusals hold in the **compiled classes** too, and the class path now carries the fail-loud code like the controller path (two new construct rows, two new class tests). The construct audit: **55 constructs** (33 compile, 19 fail loud, 3 build level).
- **M46** The **reasons**, corrected (2026-10-21) - M45's queue reason claimed a paid product; that is not what the project decided (only **R2** asks for a credit card, CF Queues is free at 10k ops/day). The message now follows the **runtime's own wording** (`rt.queue()` throws the same): the job would never run at the edge - the worker has no queue handler, so nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job; the paths that work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads (a port handler writes the row - the edge has no producer for it). The claim "the edge can push the job" goes too: `rt.queue().push()` throws even with a binding injected. `Cache::tags()`: in Laravel this route 500s with `BadMethodCallException("This cache store does not support tagging.")`; the build refuses the route before it ships - stricter than Laravel, not a parity. The dead code goes too: `QUEUE_ASYNC` and the unreachable `Queue` branch are deleted (nothing could reach them), so no reader believes `Queue::push` compiles. And the **class path carries the fail-loud code** now (like the controller path), so the two class construct rows can name `LW002`.
- **M47** The **audit** + the honesty fixes (2026-10-21) - a deep audit of the compiler, the runtime, the kernel, the build and the proof surface found three silent-wrong-answer bugs and three honesty gaps. The **dispatch** stopped at the first listener that answered; Laravel's `Dispatcher::dispatch()` runs *every* listener, only an answer of `false` stops the chain, and the dispatch answers the array of the responses - a second listener was silently skipped and the return value was wrong. A **circular service dependency** recursed forever (a stack overflow with no cause) - now a named `circular dependency detected [A -> B -> A]`. The **arithmetic** was JavaScript's: a non-numeric string in `+` answered 0 where PHP 8 throws a `TypeError`, a division by zero answered `Infinity` where PHP throws a `DivisionByZeroError`, and the modulo did not truncate. The **construct audit** now checks the *reason* a construct fails loud (19 rows record it) - a construct that fails loud for another reason is drift. **Every test file runs now** (`compiler/tests/rt-str.test.mjs` was not in the explicit `npm test` list, so it never ran). The **tiers** are three levels, not two: free plan (no card), Workers paid plan (a subscription), and a payment method (R2 asks for a card). The **sweep plan** (M48+, one milestone per Laravel page group) is in `COMPILED.md` §8b. npm test **488/488**.
- **M48** The **JSON bytes are PHP's** (2026-10-21) - the audit found the JSON answers were JavaScript's: `response()->json($x)` and `json_encode($x)` used a plain `JSON.stringify`, so the slashes were not escaped and the non-ASCII was not escaped - every JSON response with a URL or a non-ASCII character was a different body than Laravel's. The kernel's PHP-faithful encoder (`kernel/php-json.mjs`) is used now (the response helper, `json_encode()` and the two error bodies). npm test **491/491**.
- **M49** The **registry grows** (2026-10-21) - the sweep is an enumerable number now: every facade of the vendored `Illuminate/Support/Facades` (Laravel 13, **47**) has a row in `tools/constructs.json` and the audit prints the coverage (47/47). The audit also checks the *reason* a construct fails loud. Two more silent no-ops are refused at build time: a **broadcast listener** (`ShouldBroadcast` - the edge has no broadcast driver, so the notification would never be sent) and an **after-commit listener** (`ShouldDispatchAfterCommit` - the edge has no transaction). `Event::dispatchUntil()` fails loud with the halt semantics named, an unmapped facade no longer blames a model (`DB::select()` used to say "is not a registered Eloquent model"), and a **circular service dependency** is caught at build time with Laravel's wording. npm test **493/493**.
- **M51** The **audit's P0s** (2026-10-21) - the parallel audit (the real compiler against PHP 8.3.30) found six constructs that compiled to a DIFFERENT result than Laravel: a **foreach by reference** (the write-back was lost - now it fails loud), the **array spread** (a nested array - now it compiles), **match()** (the int/float distinction was lost - a float literal stays a float now), a **constructor that needs an await** (a JS SyntaxError, so the whole worker failed to import while the build said OK - now it fails loud), a **declared class property** (dropped, so the instance answered null where PHP answers 0 - the declarations compile now) and a **`= null` default** (refused with a wrong reason - it compiles now). npm test **499/499**.
- **M50** The **arithmetic's last PHP 8 gaps** (2026-10-21) - probed against PHP 8.3 itself: array + array is the union (`[1] + [2]` => `[1]`, the left keys win; the compiled side answered 0), and the division/modulo by zero throws the PHP class name (`DivisionByZeroError`) so it survives to the 500. npm test **493/493**.
- **M52** The **elvis operator and ?? evaluate once** (2026-10-21) - the audit found two operators that ran a side effect Laravel never runs: the elvis emitted the test expression twice (`$i=1; $x = $i++ ?: 5` => PHP 2,1, the compiled side 3,2) and `??` evaluated both sides eagerly. Both follow PHP now. npm test **499/499**.
- **M53** The **shadow proves the dispatch runs every listener** (2026-10-21) - the fixture app has two listeners on the same event now, so the answer carries both effects: the shadow proves that every listener ran (38/44 byte-identical, 0 unexplained).
- **M54** The **class path** (2026-10-21) - a listener that uses a **trait**, one that **extends** a class and a class with a **magic accessor** compiled "OK" and were wrong at request time; all three fail loud now, and every class-path refusal carries a **code** like the controller path. npm test **502/502**.
- **M55** A **break inside a loop breaks the loop** (2026-10-21) - the audit found the switch's break label leaking into a nested loop, so a break inside the loop broke the SWITCH (the code after the loop was skipped). PHP: `foreach ([1] as $x) { switch ($x) { case 1: foreach ([7,8] as $y) { if ($y==8) { break; } echo $y; } echo 'A'; break; } echo 'L'; }` => 7AL - the inner break leaves the inner foreach only. Every loop now carries its own label. npm test **503/503**.
- **M56** The **continue in a switch + the increment** (2026-10-21) - a `continue` inside a switch continued the LOOP (PHP leaves the switch), an increment on a property was not a valid JS assignment target (a 500 at request time while the build said OK - it fails loud now) and the increment on a string answered NaN where PHP bumps the last byte ("a" -> "b", "z" -> "aa"). npm test **507/507**.
- **M57** The **mail construct** (2026-10-21) - a mailable is a class, so the build compiles it: the dump takes the app's `Mail` classes, the class compiler emits the class and the kernel's new `Mailable` base carries Laravel's fluent surface (`subject()`, `view()`, `with()`, `from()`, `to()`, `cc()`). `Mail::to($u)->send(new OrderMail())` compiles and the mailer sends the payload Laravel sends: the recipients, the subject and the **rendered view** (the mailable's data goes into the view - the unit tests lock the shape; the byte-for-byte proof against the real app's mail is the next stage). The methods the kernel mailer does not implement (`raw`, `html`, `queue`, `later`) fail loud - a mail that silently lost its `cc` would be a wrong answer. The mailer's pending also had a real bug (the recipients were the setters, so the payload was empty) - fixed. npm test **510/510**.
- **M58** The **mailable's correctness** + the audit's last findings (2026-10-21) - the review found real defects and fixed them: the chained `Mail::to($u)->send($m)` was **not awaited** (a floating promise), Laravel's Mailable has a **field and a method with the same name** (JavaScript shadows one with the other), Laravel **appends** the pending's recipients to the mailable's own, the view data is Laravel's `buildViewData()` (the public properties + the `with()` data), the mailable's `build()` is **protected** (it is compiled now), the payload is built in **one** place, every class-path refusal carries a **code**, and the audit's last three findings (`in_array` over an assoc array, the 2^53 compare, the negative string offset) are fixed. npm test **514/514**.
- **M59** The **mailable's 1:1 details** (2026-10-21) - four Laravel details were wrong and are fixed: the mailable's `from` is a list (the payload's from is flattened like `to`), the **`textView`** is rendered too (the plain-text part), the payload's fallbacks are **type-checked** (a prototype method is not a value), and Laravel keeps the **last** occurrence of a recipient at its own position. The mailable's `build()` is **protected** in Laravel, so a mailable's methods compile now (with a test that compiles a mailable SOURCE); the **negative string offset** (`$s[-1]`) compiles (`rt.strOffset` - PHP counts from the end); and the reason for a **model-typed constructor parameter** says what is true. npm test **516/516**.

- **M60** The **mail payload is proven byte-for-byte** (2026-10-21) - the proof is the shadow: the PHP oracle captures Laravel's `MessageSent` event (the from/to/cc/bcc/replyTo/subject/html/text) and the harness compares those fields with the kernel mailer's outbox - the `POST /mail-demo` step (a mailable + its own view) matches on all 8 fields. Three real gaps were fixed to get there: the dump took the mailables inside the constructor closure, the build did not compile a mailable's view, and the handler did not get the class registry. The shadow: **39/45 byte-identical, 0 unexplained**.

- **M61a** The **validation rules take Laravel's parameters** (2026-10-21) - Laravel parses a rule's parameters with `str_getcsv` (`ValidationRuleParser::parseParameters`), the edge split them with a plain `,`: a **quoted** parameter (the shape Laravel's own `Rule::in(['admin','user'])` normalizes to - `in:"admin","user"`) was compared with its quotes still on, so every valid value was rejected (a 422 where Laravel answers 200). The kernel parses them like PHP now (a quoted field keeps its commas, a doubled quote is one quote, nothing is trimmed - Laravel never trims) - probed against PHP 8.3 itself: 500 random parameter strings, 0 differences.
- **M61b** The **router matches Laravel's route resolution** (2026-10-21) - the optional route parameter was compiled after a mandatory separator, so `/users/{id?}` never matched `/users` (a 404 where Laravel answers 200); Symfony's `RouteCompiler` puts the separator inside the optional group, and the kernel does too now. The path is decoded before the route matches it (Laravel's `UriValidator`), so an encoded slash splits the segments. Probed against the vendored Symfony: 8 URIs x 18 paths, 0 differences.
- **M61c** The **model's `save()` is Laravel's** (2026-10-21) - the compiled save always wrote the row and bumped `updated_at`; Laravel writes only when the model is dirty (`Model::save()` -> `isDirty() ? performUpdate() : true`) and `updateTimestamps()` lives inside the update, so an unchanged save writes nothing. The kernel keeps Eloquent's original snapshot, writes the dirty attributes only and answers a bool.
- **M61d** The **transpiler awaits the async calls** (2026-10-21) - a terminal query on a variable (`$q = Post::where(...); $q->get()`) floated a promise (the value was a Promise, not Laravel's Collection: `count()` answered 0, the foreach ran zero times); the async model methods (`increment`, `load`, ...) floated and took the first argument as the db binding (the counter was never written); `related` does not exist in Laravel's Model and now fails loud (LW003); a call to a class's own method is awaited now.
- **M61e** **Every method of a class compiles** (2026-10-21) - the class compiler dropped a class's own protected/private helper, so the compiled body called a method that does not exist at the edge (a TypeError at request time, a green build). Laravel calls the helper from inside the class, so every method of the class compiles now.
- **M61f** The **Blade runtime answers like Laravel** (2026-10-21) - `@json` dropped Laravel's JSON_HEX_* flags (every `@json` body differed), `@yield`'s default and `@section`'s inline content were not escaped (Laravel escapes both), and `@foreach` over a Collection ran the body once (the runtime's own Collection was not iterable). The new test compiles the PHP that Laravel's own Blade compiler emits.
- **M61g** The **FormRequest dump refuses the hooks the edge does not run** (2026-10-21) - Laravel 13's FormRequest has five more overridable hooks (`withValidator`, `after`, `validator`, `validationData`, `passedValidation`) that the compiled rung silently ignored; the dump refuses each one now with a precise reason (what Laravel does, what the edge does instead, the working path), and each refusal is a row in the construct audit.
- **M61h** The **Str family answers like Laravel** (2026-10-21) - nine helpers were wrong: `title` (the word rule of `mb_convert_case(MB_CASE_TITLE)`), `ucwords` (Laravel's separator pattern), `contains`/`startsWith`/`endsWith` (an empty needle is false), `snake`/`kebab` (`ctype_lower`, not a lowercase guard), `slug` (Laravel's `'@' -> 'at'` dictionary), `limit` (the **display width**, so a CJK glyph is two columns), and `ucfirst`/`camel` (the first CHARACTER, `mb_ucfirst`/`mb_lcfirst`). Probed against the vendored Laravel: 42 strings x 25 helpers + every ASCII character x 12 helpers, 0 differences.
- **M61i** **`where('col', null)` is a where-null clause** (2026-10-21) - the compiled `where` bound a NULL and rendered `col = ?`, which matches no row in SQL, so the edge answered an empty set where Laravel answers the rows. Laravel reads a NULL value as `IS NULL` (`!=`/`<>` -> `IS NOT NULL`) and the kernel does the same now; `IS`/`IS NOT` left the operator list (SQLite has no such operator - Laravel reads them as values).
- **M61j** The **model's clock and its increment are Laravel's** (2026-10-21) - the model's `now()` was an arrow field, so it captured the base class and the request clock was ignored (the timestamps carried the wall clock); it is a static method now, so the compiled model class binds. And `increment()` was a read-modify-write plus a full save (it rewrote every column, bumped `updated_at` and answered the new value) - Laravel writes one atomic statement, leaves the other columns alone and answers the affected-row count.
- **M61k** The **value a controller returns is converted like Laravel** (2026-10-21) - the compiled handler returned the raw value to the kernel, which accepts only `{status, body}`: `return "hello";` was a 500 where Laravel answers 200. Laravel's `Router::toResponse` converts it (a string is the body, an array or an object is JSON, null is an empty 200, a model that was just created is a 201) and the compiled body does that now; a response the controller built itself passes through untouched.
- **M61l** **A model that overrides the route binding fails loud** (2026-10-21) - Laravel binds the model through the model's own `resolveRouteBinding()`, so an app that overrides it can scope the lookup; the compiled binding is a primary-key lookup, so such an app bound a different row at the edge (silently, with a green build). The build stops now (LW003) and names the method.
- **M61m** The **model's casts are PHP's casts** (2026-10-21) - the bool cast answered false for `'false'` (PHP: true), the int/float casts turned a non-numeric id into NaN (PHP takes the leading digits) and kept `1.9` as `1.9`, the decimal cast rounded on the binary double (`'2.675'` -> `'2.67'` where Laravel's BigDecimal says `'2.68'`), and the timestamp cast was NaN for a date string. All four are PHP's now (probed against PHP 8.3).
- **M61n** The **cron matcher answers like the cron library** (2026-10-21) - the day-of-month and the day-of-week were ANDed (cron ORs them when both are restricted: `0 0 1 * 1` fires on the 1st AND on every Monday), the tokens `?`, `L`, `<dow>L` and `<dow>#<n>` were not implemented (an unknown token became the field's minimum, so `0 0 L * *` fired on the 1st), and the month and weekday shared one alias table. Probed against `dragonmantank/cron-expression`.
- **M61o** The **model's JSON dates and its soft delete are Laravel's** (2026-10-21) - the model's JSON carried the raw DB strings where Laravel serialises the timestamps through `Carbon::toJSON()` (`2024-01-01T00:00:00.000000Z`), so every model's JSON body differed; and the soft delete wrote only `deleted_at` where Laravel's `runSoftDelete()` writes `updated_at` too (the restore bumps it as well).
- **M61p** The **controller resolves the uses and the route parameters like PHP** (2026-10-21) - a grouped import (`use App\Models\{Post};`) lost its prefix (so the route Laravel serves was refused), and the implicit binding only accepted the exact parameter name (Laravel also matches the snake_case form: `show(Post $blogPost)` binds on `/posts/{blog_post}`). Both are resolved like PHP now.
- **M61q** The **validator's remaining Laravel semantics** (2026-10-21) - `required` did not treat a whitespace-only string as empty; `in`/`not_in` compared with JS's `String()` instead of PHP's `(string)` cast (and missed Laravel's array branch); the dependent rules compared as strings where Laravel compares strictly (loose only for a bool/null, with the bool/null conversions); the parameter count was never checked (Laravel throws); and the rule name was not trimmed (Laravel trims it). All five are Laravel's now (probed against the real validator).
- **M61r** The **model's created flag and the appended dates** (2026-10-21) - Laravel sets `wasRecentlyCreated` in the insert paths, so a controller returning a model it just saved answers 201; the kernel only set it in `create()`. The appended attributes go through the same date serialisation as the timestamps now.
- **M61s** The **query builder accepts Laravel's operators** (2026-10-21) - `<=>` and `IS`/`IS NOT` are in Laravel's operator list, so the edge refused queries Laravel runs (`where('c','<=>',null)` is `IS NULL` there, `where('c','is',5)` renders `c is ?`). The list is Laravel's now.
- **M61t** The **optional route segment uses Symfony's requirement** (2026-10-21) - the kernel's `[^/]*` could capture an empty optional parameter where Symfony's `[^/]++` refuses the group (`/users/%2F` decodes to `/users//`: the edge answered 200, Laravel answers 404).
- **M61u** The **method override follows Symfony** (2026-10-21) - the edge preferred the `_method` parameter over the `X-HTTP-Method-Override` header (Symfony reads the header first) and accepted any value (Symfony throws for a non-A-Z override, which Laravel answers as a 500).
- **M61v** **A route that instantiates a class that did not compile is stopped** (2026-10-21) - the build compiled a route that sends a mailable the edge cannot compile (Laravel 13's modern API): it only logged a warning and the route shipped, so the edge answered a 500 at request time. The route is stopped now with the class's own reason; the mailable's view is also read in every shape (single or double quotes, `->markdown()`).
- **M61w** The **`filled` message and the blocked classes** (2026-10-21) - a `filled` failure was reported with the `required` rule, so the 422 body carried the wrong sentence (Laravel's `validation.filled`); and the blocked-class map only held the event classes, so a mailable that did not compile could still be instantiated at request time instead of being refused with its reason.
- **M62a** **A rule object is normalized at build time** (2026-10-21) - the FormRequest dump refused every rule object, but Laravel's validator reads the object's string form, so the edge can have the same string (`Rule::in(['admin','user'])` -> `in:"admin","user"`, which the kernel parses exactly like Laravel). The conditional objects (`Rule::requiredIf(true)`, `Rule::when(...)`) stay refused: their string form is the condition evaluated at build time, so the edge would bake the build-time branch into the rule.
- **M62b** The **`unique` rule reads the `NULL` placeholders like Laravel** (2026-10-21) - a normalized rule object writes the absent column and the absent id as the string `NULL`, so the kernel would have queried a column named NULL (Laravel falls back to the attribute's name) and added an `id != 'NULL'` (Laravel means "no exception"). Both are Laravel's now, and M62a's normalization got its regression tests.
- **M62b2** The **`unique` resolver: the wildcard column + the bracketed id** (2026-10-21) - probed against the real Laravel: the column of a wildcard attribute is the last dot segment (Laravel: `id`, the edge: `items.0.id` - a column that does not exist), and a bracketed id (`[id]`) is the field's value in the data (the edge bound the literal string).
- **M62c** The **request's `merge()` and the input union** (2026-10-21) - the kernel's request had no `merge()` (the FormRequest's `prepareForValidation()` needs it: Laravel replaces the value, it is not a deep merge, and the dot notation is honoured), and the input Laravel reads is the input source UNION the query bag - the edge read the source alone, so a query parameter was invisible to the validator.
- **M62d** The **FormRequest's `prepareForValidation()` is compiled** (2026-10-21) - the hook Laravel runs before the validation was refused by the dump, so the app could change the validated input and the edge never saw it. The FormRequest is a compiled class now (the kernel's new `kernel/form-request.mjs` base), the handler runs the hook before the validation, and the shadow proves it (the fixture's hook fills the missing title, so the step now passes the validation on both sides).
- **M62e** The **query builder refuses a bad order direction** (2026-10-21) - `orderBy('title', 'sideways')` answered ASC at the edge (a different row order, silently); Laravel throws, so the edge fails loud now.
- **A57** The **query builder's two Laravel edges** (2026-10-21) - `orderBy()` with a direction that is not asc/desc answered ASC at the edge (Laravel throws), and `sum()` answered null on an empty set where Laravel answers 0.
- **A58** The **hash surface is Laravel's** (2026-10-21) - `Hash::isHashed()` answered true for a `$2a$`/`$2b$` or a truncated digest where Laravel's `password_get_info()` says it is not a hash; and the async `Hash::make()` wrote bcryptjs's `$2a$` prefix where PHP writes `$2y$` (so the edge's own hashes were not recognised).
- **A58b** **A cache TTL of 0 forgets the key** (2026-10-21) - `Cache::put($k, $v, 0)` kept the row for ten years at the edge; Laravel forgets the key (`Repository::put()`). No ttl still means forever.
- **A58c** **The paginator's fragment is Laravel's** (2026-10-21) - Laravel stores the fragment without the '#' and `buildFragment()` adds it; the edge appended it as it was, so `fragment('list')` produced a URL without the '#'.
- **A58d** **The paginator's query string is PHP's** (2026-10-21) - Laravel builds it with `http_build_query(..., PHP_QUERY_RFC3986)` (booleans as 1/0, arrays in the bracket form, nulls skipped); the edge built its own, so the URL bytes differed.
- **A58e** **A Date is bound with the grammar's date format** (2026-10-21) - Laravel binds a DateTimeInterface as `Y-m-d H:i:s`; the edge bound an ISO string, so `where('created_at', $date)` never matched the stored column.
- **A58f** **The multipart delimiter needs its CRLF** (2026-10-21) - PHP's parser looks for CRLF + `--boundary`; the edge looked for the bare bytes, so a file whose content contains the boundary truncated the upload.
- **A58g** **`response()->json($model)` answers the model's JSON** (2026-10-21) - Laravel's Model is JsonSerializable, so json_encode answers its toArray(); the edge threw "unsupported value (Model)" and answered a 500.
- **A58h** **`find([1, 2])` returns the collection** (2026-10-21) - Laravel's find() with an array of ids returns a collection of the found models; the edge bound the array as one value, so the query matched nothing.
- **A67** **A mailable's view is attached per route** (2026-10-21) - the dump attached every mailable's view to every route, so one view that failed to compile skipped every route (the app shipped without routes); now only the views of the mailables a route actually sends are attached.
