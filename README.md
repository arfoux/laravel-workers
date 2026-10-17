# edge/ — compile the Laravel app into a Workers-native artifact

> Full design map — padanan Laravel → Workers, tolerance model (soft/hard), limits, agent workstreams: **[MAP.md](MAP.md)**

The Laravel app in this repo stays the source of truth. `edge/build.mjs` compiles it
into an artifact whose **request path is 100% static — nothing boots**:

1. **Boot happens at build time.** The real Laravel app runs on the build machine:
   it renders pages (`tools/prerender.php`) and exports its route table
   (`php artisan route:list --json`).
2. **Static pages** are prerendered to HTML (see `registry.json` → `static`).
3. **Dynamic endpoints** are small JS "ports" (`registry.json` → `ports`,
   `src/ports/*.mjs`) that talk straight to the D1 binding — no framework, no boot.
4. The build reports (and with `--strict`, fails on) any app route that is not
   consciously handled.

## How routes are handled (tiers)

1. **ports** — live JS handlers, highest priority. A port always wins over a snapshot.
2. **static** — manual page map in `registry.json`, rendered by Laravel at build time.
3. **snapshot** — automatic (`autoSnapshot`, default true): every remaining clean GET
   route (no `{params}`, HTTP 2xx `text/html` at build time) is rendered by Laravel and
   written as a static page, so **new pages appear at the edge URL on the next deploy**.
4. **ignore** — consciously skipped, with a reason: `"ignore": { "/x": "reason" }`.

Anything that can't be snapshotted (params, redirects/errors, non-GET, non-HTML) is
reported as UNHANDLED and can be scaffolded into a port stub.

## Commands

    node edge/build.mjs               # compile -> edge/dist
    node edge/build.mjs --scaffold    # + generate port stubs for unhandled routes
    node edge/build.mjs --strict      # CI mode: fail instead of warn on unhandled routes
    node edge/ship.mjs                # build + deploy in one command
    cd edge && node ../node_modules/wrangler/bin/wrangler.js deploy   # deploy only

## Keeping the app developable

Laravel development stays normal (`php artisan serve`, add routes/views as usual).
The build is conditional on whatever `route:list` reports at that moment:

- a new clean GET page lands at the edge automatically (build + deploy),
- anything that can't be snapshotted is listed as UNHANDLED — never silently lost,
- `--scaffold` drops a stub port (+ the exact registry.json line to add),
- routes you consciously postpone go into `registry.json` → `"ignore": { "/x": "reason" }`,
- `--strict` makes any unhandled route fail the build, so CI stays honest.

## Adding a live endpoint (port)

1. Add the route in the Laravel app (`routes/web.php`).
2. Create `src/ports/<name>.mjs` exporting `handle(request, env)`.
3. Map the route in `registry.json` under `"ports"` and rebuild.

## Adding a static page

Nothing to do — clean GET pages are snapshotted automatically. Use the `static`
map only when you want a fixed file target (e.g. `/` → `index.html`).
