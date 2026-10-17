# laravel-workers

Run a normal Laravel app on Cloudflare Workers — no PHP at request time.

Laravel stays the source of truth for development. At build time the app boots PHP once and compiles into a Workers-native artifact: static assets, prerendered snapshots, and JavaScript handlers backed by D1. At request time the Worker runs pure JS inside the Free-plan CPU budget.

> Status: **pre-M1** — in development. The pipeline skeleton (tiers, coverage, one-command ship) is proven on a real Laravel app; the view/controller compiler is the next milestone. Nothing here claims to be finished.

## Approach

- **Build-time boot** — Laravel's own compiler dumps routes, compiled Blade, schema, config.
- **Tiered serving** — static → snapshot → compiled handler → hand-written port (escape hatch).
- **Coverage is enforced** — any unhandled route fails a `--strict` build. No silent gaps.
- **Parity tests** — compiled output is byte-compared against Laravel's own renders.

## Coverage map

`MAP.md` classifies every page of the official Laravel 13.x docs (105/105 — zero blanks):
29 ✅ fits · 46 🟡 soft (documented trade) · 5 🔴 hard (each with a defined alternative) · 25 ⛔ N/A at the edge.

## Roadmap

- [x] Edge pipeline skeleton: tiers, coverage, deploy (proven on a real app)
- [ ] **M1 — view parity:** Blade → JS compiler, byte-identical renders
- [ ] **M2 — compiled routes/controllers** + D1 endpoints
- [ ] sessions / CSRF / auth · services (mail, queue, cache, storage) · parity suite · packaging

Prior art exists in fragments (php-wasm bridges, static exporters, generic PHP→JS transpilers); the bet here is the end-to-end combination with parity tests. Not affiliated with Laravel or Cloudflare.
