# Developing laravel-workers

For anyone working *on* the toolchain (or reading it closely) — and for an AI agent that has to
reason about this repo without guessing. If you only want to *use* it, the
[README](../README.md) and [docs/DEPLOY.md](DEPLOY.md) are the whole story.

## From checkout

```bash
git clone https://github.com/arfoux/laravel-workers && cd laravel-workers
npm run setup        # root + compiler deps
npm test             # kernel + compiler + parity harnesses
npm run test:corpus  # the M1 transpiler corpus (byte-identical expectations)
npm run test:sqlite  # real in-memory SQLite integration
npm run gate:ci      # the CI mirror: suite + corpus + docs gate + bench + syntax + pack-gate
```

A checkout is not an app: `npx laravel-workers verify` runs the container checks and reports
`SKIP` unless the parent directory holds a Laravel app with a `vendor/`.

## The checks behind the claims

- `npm run check:docs` — the gate: the coverage index, the construct audit ([COMPILED.md](../COMPILED.md)), the README counts, and the two generated port catalogs (`docs/D1-SCHEMA.md`, `docs/ENV-SECRETS.md`). **Hand-typed numbers are bugs** — every count in the README is generated from the code by `tools/docs-counts.mjs`, and a number the repo can compute outside the generated block fails the gate.
- `npm run bench` — the local micro-bench (a Node proxy for CPU: a fast regression detector).
- `npm run gate:cpu` — the platform's own numbers: deploys a probe worker running the real kernel hot paths, reads `cpuTime`/`outcome` back through `wrangler tail`, asserts a page-like load fits the Free budget **and** that a burn is caught, then deletes the worker. Outside `gate:ci` (it needs a logged-in wrangler).
- `kernel/tests/budget.test.mjs` — wall-clock p95 ≤ 5 ms per hot operation, ≤ 30 ms for the encrypter (no D1/KV in the loop).
- `tools/constructs.json` — every `Illuminate\Support\Facades\*` (Laravel 13) with a verdict.
- `tools/pack-gate.mjs` — what the published tarball actually carries, and that no file the README links is missing from it.

## Where the truth lives

| Question | File |
|---|---|
| what compiles, what refuses, per construct | [COMPILED.md](../COMPILED.md) |
| the app → edge map, D1 limits, the to-verify list | [MAP.md](../MAP.md) |
| every CLI flag, the guided deploy, the tiers, exit codes, the build pipeline | [DEPLOY.md](DEPLOY.md) |
| the file map + the 30-second architecture | [INTERNALS.md](INTERNALS.md) |
| guard / route / middleware ports, the 47-slug package fleet | [PACKAGE-PORTS.md](PACKAGE-PORTS.md) |
| vendor-lite provisioning and the measured boot costs | [PLAN-VENDOR.md](PLAN-VENDOR.md) |
| what the verdict badge means (the app-facing CI contract) | [CI.md](CI.md) |
| how this repo works: branch → PR → green → tag, and the parity rules | [PROCESS.md](PROCESS.md) |
| the readiness verdict, evidence first | [READINESS.md](READINESS.md) |
| the mark's geometry, palette and voice | [BRAND.md](BRAND.md) |
| what changed, when | [CHANGELOG.md](../CHANGELOG.md) |

## Who reads what

- **Evaluating it?** [README](../README.md) → [COMPILED.md](../COMPILED.md).
- **Adopting it?** [README](../README.md) → [DEPLOY.md](DEPLOY.md) → [PACKAGE-PORTS.md](PACKAGE-PORTS.md) when a route needs a port.
- **Working on it?** [INTERNALS.md](INTERNALS.md) + [PROCESS.md](PROCESS.md) (the operating contract: branch → PR → report → tag, the hard/soft rule table, the parity rules).
- **An AI agent?** [PROCESS.md §0](PROCESS.md), [MAP.md](../MAP.md), [COMPILED.md](../COMPILED.md) — and never hand-type a number this repo can compute.

## License

MIT — see [LICENSE](../LICENSE). Trademarks belong to their owners.
