# CONTRACT-w3 — router & response kernel (frozen 2026-10-17)

Runtime-side router for the compiled-handler tier. Pure ESM, zero deps. Node ≥22 / Workers-compatible (only web-standard globals).

## Input: route table (same shape as the S0 dump's `context.routes`)

route = `{ uri: string, name: string|null, methods: string[], domain: string|null }`

- `uri` may lack the leading slash ("up", "dbcheck") → normalize to "/up", "/dbcheck"; "storage/{path}" → "/storage/{path}"; "/" stays "/".

## Matching semantics (target: Laravel-observed)

- Method: case-insensitive; a route listing GET also answers HEAD (Laravel auto-adds HEAD).
- Path: strip query string; normalize trailing slashes (except root); decode `{param}` values with decodeURIComponent.
- `{param}` = one segment; support `{param?}` only as the final optional segment (else throw).
- Duplicate method+uri: later registration wins (Laravel override).
- Specificity: determine via experiment (standalone vendored Router) — registration order vs static-first; implement what Laravel actually does; if not observable, fall back to registration order and mark "contract-defined" in comments.
- No match → `null`.

## API (`edge/kernel/router.mjs`)

- `normalizeTable(routes) -> table` — validates + dedupes (later wins); frozen internal table.
- `routeKey(route) -> string` — `"<METHOD> <normalizedUri>"` using the first method.
- `match(table, { method, path }) -> { route, params } | null`
- `dispatch(req, table, handlers) -> { status, headers, body } | null`
  - `req = { method, path, headers? }`
  - `handlers = { [routeKey]: (ctx) => response }`, `ctx = { params, request }`; handler must return `{ status:number, headers:object, body:string }` (validate; throw otherwise).
  - No route OR no handler → `null` (caller falls back to snapshots/static).
- Malformed table entries → throw Error with a clear message (fail loud).

## Response helpers (`edge/kernel/response.mjs`)

- `html(body, status=200)`, `json(value, status=200)`, `redirect(location, status=302)`, `notFound()`, `text(body, status=200)`
- Plain objects; header names lowercase; `body` ALWAYS string.

## Tests (`edge/kernel/tests/router.test.mjs`)

Plain node, no deps, runnable from the repo root. Must cover the 5 real nearFind routes + the edge cases listed in the task. Precedence findings documented with the experiment command.

## Territory

`edge/kernel/**` only. No git, no deploys, read-only elsewhere.
