# CONTRACT-m2 — router integration (frozen 2026-10-18)

Orchestrator-owned. M2 wires the W3 router into the Worker request path and turns
Laravel routes into compiled controllers / JSON ports. M1 (view parity) and W3 (router
kernel) are already green; M2 does not reopen them.

## Goal

Every non-ignored Laravel route either:

1. is served as a prerendered snapshot by the asset layer (0 Worker invocations), or
2. is dispatched by `edge/kernel/router.mjs` to a compiled controller / JSON port.

No PHP boots at request time. No route is silently unhandled (`--strict` fails the build).

## Pipeline

1. `php artisan route:list --json` → route table (existing build step 1).
2. For each `view` route: `php edge/tools/compile-view.php <view> <out> [uri]` → S0 dump.
3. `node edge/compiler/bin/transpile.mjs <dump> --json --out <view.mjs>` → compiled view module.
4. Build wraps the view module in a controller and generates the route registry.
5. `node edge/build.mjs` copies controllers/contexts/runtime and writes `dist/src/routes.generated.mjs`.
6. Worker calls `normalizeTable(routeTable)` once, then `dispatch(req, table, handlers)`.

## Artifacts (frozen)

### `route-table.json` (build-time, also embedded in `routes.generated.mjs`)

```json
[
  {
    "uri": "/",
    "name": null,
    "methods": ["GET", "HEAD"],
    "domain": null,
    "kind": "view",
    "view": "welcome",
    "controller": "home"
  }
]
```

- `kind`: `"view" | "port" | "snapshot" | "ignore"`.
- `view`: Blade view name (only for `kind: "view"`).
- `controller`: slug under `dist/src/controllers/` (for `view` and `port`).
- `port`: port slug from `registry.json` (for `kind: "port"`).
- `snapshot`: file under `dist/public/` (for `kind: "snapshot"`).
- `reason`: required string for `kind: "ignore"`.

### Generated modules

- `dist/src/routes.generated.mjs`
  - exports `routeTable` (raw array above) and `handlers` (`{ "GET /": fn, ... }`).
  - only `view` and `port` routes have handlers.
- `dist/src/controllers/<slug>.mjs`
  - ESM, default export `async function handle(ctx, env)` returning the W3 response shape
    `{ status: number, headers: object, body: string }`.
- `dist/src/views/<name>.mjs`
  - M1 compiled view module (`export default function main(rt)`).
- `dist/src/contexts/<name>.mjs`
  - `export default { ... }` — the S0 context object (no JSON import assertions).
- `dist/src/kernel/{router,response}.mjs` — copied from `edge/kernel/`.
- `dist/src/runtime/rt-from-context.mjs` — copied from `edge/compiler/runtime/`.

### Controller shapes

**View controller**

```js
import main from '../views/welcome.mjs';
import context from '../contexts/welcome.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';
import { html } from '../kernel/response.mjs';

export default function handle(ctx, env) {
  const rt = buildRt(context.default, { strict: true });
  main(rt);
  return html(rt.__output);
}
```

**Port controller (migrated)**

```js
import { json } from '../kernel/response.mjs';

export default async function handle(ctx, env) {
  // use ctx.request, ctx.params, env
  return json({ ... }, 200);
}
```

- Ports no longer return Web `Response`; they return the W3 shape and use `edge/kernel/response.mjs`.
- `src/ports/dbcheck.mjs` is migrated to this shape in M2.

## Worker contract (`dist/src/worker.mjs`)

```js
import { normalizeTable, dispatch } from './kernel/router.mjs';
import { routeTable, handlers } from './routes.generated.mjs';

const table = normalizeTable(routeTable);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const req = {
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
    };

    const res = dispatch(req, table, handlers);
    if (res) {
      // HEAD keeps headers but drops the body (Laravel parity).
      const body = request.method === 'HEAD' ? null : res.body;
      return new Response(body, { status: res.status, headers: res.headers });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'nearfind-edge', builtAt: ... });
    }

    return env.ASSETS.fetch(request);
  },
};
```

- `dispatch === null` → asset fallback (snapshots/static) or 404 from assets.
- Unexpected handler throws are caught by the Worker runtime and surfaced as 500; build-time parity tests must prevent them.

## Build contract (`edge/build.mjs`)

- New registry key: `"views": { "/": "welcome" }`.
- For every non-ignored route, exactly one of:
  - `snapshot` (clean GET, HTML, autoSnapshot),
  - `view` (explicit or derivable Blade view),
  - `port` (JSON/dynamic endpoint),
  - `ignore` (with reason).
- `--strict` fails if any route is unclassified or unknown.
- Build runs compile-view + transpile for each `view` route.
- `compile-view.php` gains an optional third argument `[uri]` (default `/`); the HTTP request is created with that URI so `url()` / `route()` resolve against the real route.
- Build copies `edge/kernel`, `edge/compiler/runtime`, generated controllers/views/contexts.

## Tests

### W3 (unchanged)

`edge/kernel/tests/router.test.mjs` — 5 routes + edge cases. Must stay green.

### M2 integration

`edge/tests/router-integration.test.mjs` (Node, no deps):

- loads the generated `routeTable` + `handlers`;
- `dispatch({ method: 'GET', path: '/dbcheck' }, table, handlers)` returns a response;
- parses the body as JSON and asserts `driver === 'd1-binding'`, `tables` is an array, `config_rows` is a number;
- `dispatch({ method: 'GET', path: '/' }, table, handlers)` returns HTML containing `<title>nearFind</title>`;
- `dispatch({ method: 'GET', path: '/nope' }, table, handlers) === null`;
- uses a mocked `env.DB` for unit runs; real D1 binding is verified via `wrangler dev` smoke.

### CPU budget

`edge/tests/cpu-budget.mjs`:

- runs the `/` controller (or compiled view `main(rt)`) 100 times;
- measures `performance.now()` around the synchronous render only;
- reports p50 / p95 / max;
- fails if p95 > 8 ms (Free plan 10 ms CPU with 2 ms headroom) or max > 10 ms.

Port handlers are excluded from the synthetic CPU gate because their cost is D1 I/O; their synchronous portion must be < 1 ms.

### Parity

- M1 parity remains the HTML gate: compiled `/` output === `php edge/tools/prerender.php /`.
- M2 adds route-level parity for any new view route using the same harness with a per-route ref.

## Error codes (additions)

- `LW005` — route has no classified handler (`--strict` failure).
- `LW006` — CPU budget exceeded.
- `LW007` — route table / handler mismatch (missing or duplicate handler key).

## Territory

- `edge/build.mjs`, `edge/src/worker.mjs` template, `edge/tools/compile-view.php`, `edge/src/ports/*`, `edge/tests/*`: M2 implementation.
- `edge/kernel/*`, `edge/compiler/*`: read-only (already frozen).
- `edge/notes/*`: contract + verification artifacts only.

## Acceptance (M2 done)

1. `node edge/build.mjs --strict` passes with 0 unhandled routes.
2. `node edge/tests/router-integration.test.mjs` passes (mocked D1).
3. `node edge/tests/cpu-budget.mjs` passes (p95 ≤ 8 ms).
4. `wrangler dev` smoke: `/`, `/dbcheck`, `/health` return 200; `/dbcheck` JSON matches D1.
5. M1 parity still green (35647 B, sha256 `b228c8a2…`).
6. No PHP process runs on any request path.
