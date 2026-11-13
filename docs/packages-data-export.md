# Cluster E — DATA & EXPORT (port snippets)

Four packages ported to the Cloudflare Workers/D1 edge. Each handler is a single
ESM default export `handle(ctx, env)`; shared primitives are reused, not
duplicated. Integration: add the route in `registry.json` under
`{"ports": {"/<route>": "<slug>"}}` (slugs below).

---

## 1. spatie/laravel-data v4.23.1 — DTO hydrate + validate

**Verdict: port.** The two halves (`::validateAndCreate`/`::from`) are pure
data work the edge does natively — string-rule validation + hydrate into a
class instance. No PHP reflection / typed-property magic is required for the
subset we port.

- **Path:** `ports/packages/spatie-data.mjs` (slug `spatie-data`)
- **Shared primitive:** `kernel/packages/validate.mjs` (subset: `required`,
  `email`, `integer`, `min:N`, `max:N`, `boolean`, `array`, `uuid`; Laravel error
  bag + `validated()` shape + `hydrate()`).
- **What runs on the edge:** `POST /data` → validate body → on failure `422`
  `{ message, errors: { field: [..] } }`; on success hydrate a `UserData` DTO,
  `toJson()`, and persist a copy to D1 `lw_dtos`, return `200 { data: {...} }`.
- **Substitution:** PHP typed DTO + reflection → plain JS class with declared
  fields + `rules()` + `toJson()`. The rule *vocabulary* is a documented subset,
  not the full Laravel/Spatie rule set (custom `Rule` objects / nested `data`
  types are out of scope — those are the honest limit).
- **Free-tier bounds:** one D1 `INSERT` per valid request (100k rows/day is the
  cap, not the limit here); CPU cost is the string-rule loop, well under the
  10ms p50. No subrequests.
- **Schema (header of the handler):** `lw_dtos(id, name, email UNIQUE, age,
  raw_json, created_at)`; `ensureSchema(env)` runs `CREATE TABLE IF NOT EXISTS`.

---

## 2. spatie/laravel-settings v3.10.1 — grouped settings on D1

**Verdict: port.** Settings are key/value JSON per group; reads/writes map
directly to a D1 table.

- **Path:** `ports/packages/spatie-settings.mjs` (slug `spatie-settings`)
- **What runs on the edge:** `GET /settings/{group}` returns
  `{ group, settings: { key: parsedJson, ... } }` (missing group → `{}`);
  `PUT /settings/{group}` upserts each key (`ON CONFLICT(group,key) DO UPDATE`),
  returns `{ group, updated: [keys] }`.
- **Substitution:** Spatie's `Settings` Eloquent repository (one row per group,
  diffed `save()`) → one row per `(group, key)` in `lw_settings`, upserted.
  Discovery of Settings classes / type-casting per property is not ported —
  the caller owns the key names; values are arbitrary JSON.
- **Free-tier bounds:** `GET` = one indexed `SELECT`; `PUT` = N upserts (N =
  keys in the payload). Under the 50-subrequest/req cap. `group` is quoted in
  SQL (`"group"`) because it is a keyword.
- **Schema:** `lw_settings(id, "group", key, json, updated_at, UNIQUE(group,key))`.

---

## 3. maatwebsite/excel v4.0.6 — CSV export (CSV = 1:1; XLSX = refuse)

**Verdict: port for CSV, refuse for XLSX.** CSV export is a text transformation
the edge does natively. XLSX needs a ZIP+XML spreadsheet writer
(PhpSpreadsheet) — there is no 1:1 JS equivalent bundled here, so we **refuse**
XLSX explicitly rather than mislabel a CSV as `.xlsx`.

- **Path:** `ports/packages/maatwebsite-excel.mjs` (slug `maatwebsite-excel`)
- **What runs on the edge:** `GET /export?format=csv` streams a CSV body
  (`text/csv; charset=utf-8`, `content-disposition: attachment`) built with RFC
  4180 quoting (quotes doubled, CRLF rows). Header = union of row keys,
  first-seen order. Requires an identified caller (`guardUserId`, `401`
  otherwise): the response is unbounded app data.
- **Refusal:** `format=xlsx` (or any non-CSV) → `406` with an explanatory
  error. No silent downgrade.
- **Substitution:** `FromArray`/`FromQuery` + PhpSpreadsheet → a pure
  `csvFromRows(rows, columns)` builder over D1 rows. Real streaming (chunked
  writes) is the production shape; we return one body string, which is fine at
  the row counts the free tier allows.
- **Free-tier bounds:** one `SELECT *` (bounded by 100k rows/day); CPU is the
  string build — the p95 50ms cap is the practical row-count ceiling, not the
  query.
- **Schema:** reads the table named by `env.EXCEL_EXPORT_TABLE` (default
  `users(id, name, email)`, created by `ensureSchema`). The table is NOT taken
  from the request — a `?table=` selector would let any caller dump any table in
  the database.

---

## 4. laravel/socialite v5.31.0 — OAuth redirect + callback

**Verdict: port.** Building the authorize URL, verifying `state`, swapping the
code, and fetching the profile are all `fetch` + string work the edge does
natively (no PHP session/Guard needed for the OAuth handshake).

- **Paths / slugs:**
  - redirect: `ports/packages/laravel-socialite-redirect.mjs` (`laravel-socialite-redirect`)
  - callback: `ports/packages/laravel-socialite-callback.mjs` (`laravel-socialite-callback`)
- **Shared primitives:** `kernel/packages/oauth.mjs` (`authorizeUrl`,
  `verifyState`, `exchangeCode`, `fetchUser`) + `kernel/packages/socialite.mjs`
  (`resolveProvider` from env, `randomState`, state cookie, `rememberState`/
  `consumeState` in D1) + `kernel/packages/token.mjs` (mints a Sanctum-parity
  bearer on login).
- **What runs on the edge:**
  - `GET /auth/{provider}/redirect` → resolve provider from env, mint state,
    store it (cookie **and** `lw_oauth_state` row), `302` to `authorizeUrl`.
  - `GET /auth/{provider}/callback?code&state` → `verifyState` (cookie OR D1
    row, constant-time) → `exchangeCode` → `fetchUser` (mapUser) → upsert user
    in D1 → mint + persist a bearer token → `200 { user, access_token }`.
    Bad/missing state → `401` **before** any provider HTTP call.
- **Substitution:** PHP session-carried `state` → `oauth_state` HttpOnly cookie
  **plus** a one-time `lw_oauth_state` D1 row (defense in depth; the callback
  accepts either). Provider config = code-side shape (auth/token/user URLs,
  `mapUser`) + env-side credentials (`<PROVIDER>_CLIENT_ID/_CLIENT_SECRET/
  _REDIRECT_URI/_SCOPES`), so secrets never land in the repo. `fetchImpl` is
  injectable for tests.
- **Free-tier bounds:** redirect = 1 D1 write, 0 subrequests. callback = 2
  provider subrequests (token + user-info) + 2–3 D1 writes. Comfortably under
  the 50-subrequest cap; the two outbound calls count against the subrequest
  budget on hot paths.
- **Schema:** `users(provider, provider_id UNIQUE pair, name, email, avatar)`,
  `personal_access_tokens(...)`, `lw_oauth_state(state PRIMARY KEY)`.

---

### Test coverage

`tools/tests/packages-data-export.test.mjs` — run it with
`node --test tools/tests/packages-data-export.test.mjs`; the runner prints the
count, and this file does not restate it (an earlier revision did: it said
*17 tests, 17 pass / 0 fail* while the suite had already grown past that —
README.md: *never hand-type a number this repo can compute*). Uses a fake in-memory
D1 (`prepare().bind().all()/first()/run()` over a Map, incl. upsert) and a fake
`fetch` that captures requests. Covers: validate pass/fail/absent-field rules,
data 200+persist & 422 error bag, settings PUT/GET/upsert/unknown-group, CSV
RFC4180 quoting + export + XLSX 406, and Socialite redirect (302+cookie+D1
state), callback happy path (verifies state, swaps code, upserts user, mints
token), forged-state 401, and D1-state fallback without a cookie.
