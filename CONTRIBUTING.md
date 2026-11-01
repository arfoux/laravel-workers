# Contributing

Thanks for helping. This is a compiler for a live framework, so the bar is
correctness first: everything here is written to be either **byte-identical to
PHP** or **loudly refused at build time**. Nothing in between ships.

## The two rules

1. **No silent wrong answer.** If a construct cannot be compiled faithfully,
   the build must fail with a stable code (`LW001`, `LW002`, … — the list and
   the operator-facing text live in `COMPILED.md` §9). Suppressing a warning,
   special-casing an input, or emitting a plausible fallback is a regression,
   not a fix.
2. **Every claim carries a check.** Parity claims point at the test that proves
   them (`kernel/tests/*.test.mjs`, the corpus, the shadow harness). A claim
   with no check gets deleted or gets one.

## Setup

```bash
npm run setup              # root deps + compiler/ deps (PHP parser)
```

PHP 8.3 is only needed for the oracle parity tests: put `php` on `PATH`, or set
`PHP_BIN` to the binary. Those tests need a real Laravel app (11+ / 13.x) with
`vendor/` installed:

```bash
export LW_LARAVEL_APP=/path/to/laravel-app        # or a parity-app/ directory
```

Without an app they **skip** with the reason printed — they never fail, and CI
runs them for real in the `parity-oracle` job.

## Before you open a pull request

```bash
npm test                   # the suite (the oracle files run when LW_LARAVEL_APP resolves)
npm run test:corpus        # byte-exact compiler corpus
node tools/gate.mjs --strict   # docs gate: coverage index, format, code⇄MAP
node tools/bench.mjs       # micro-benchmarks
node tools/pack-gate.mjs   # the tarball ships every module the build loads
```

`npm test` is wall-clock-gated in `kernel/tests/budget.test.mjs` (~5 ms p95 hot
path). It confirms a failure with one re-measurement so a busy machine does not
flake, but a real slowdown still fails: if you make the hot path slower, say so
in the pull request.

If you changed anything that reaches the compiled output:

```bash
npm run test:shadow -- --app /path/to/app --scenarios shadow/scenarios/fresh-app.mjs --build
```

and update the docs that describe it (`MAP.md`, `COMPILED.md`, `CHANGELOG.md`).
The docs gate fails on a stale coverage row, an undocumented module, or an
undocumented `LW0xx` code, so run it before pushing.

## What a good change looks like

- **Surgical**: the smallest diff that fixes the actual problem. No drive-by
  refactors, no “while I am here” abstractions, no new dependency unless the
  standard library genuinely cannot do it.
- **Faithful**: cite the Laravel source (`vendor/laravel/framework/src/...`) in
  the comment when the behaviour is subtle — the file:line that the kernel
  mirrors. That citation is how the next reader verifies it without re-deriving.
- **Tested at the behaviour, not the wiring**: a test that asserts a mocked call
  was made, a constant was copied, or a string appears in the source is noise.
  Assert the observable result, the boundary, the error, the precedence.
- **Machine-independent**: tests carry no absolute paths, no timing tighter than
  the budget file, and no dependency on a developer's checkout. A fixture app is
  resolved through `LW_LARAVEL_APP` (see `kernel/tests/oracle-app.mjs`).
- **Documented for the operator**: when a refusal is added or its wording
  changes, the error text is part of the change — it is what the user reads at
  build time.

## Commits and releases

- Conventional-ish prefixes are used in the log: `feat:`, `fix:`, `perf:`,
  `docs:`, `test:`, `build:` — keep the subject factual and short.
- `CHANGELOG.md` is written per release under `## vX.Y.Z`; the `publish`
  workflow extracts that section for the GitHub release, so a missing section
  means an empty release.
- Releases are cut from a tag: `npm version patch` (which writes
  `package.json`, commits and tags), then `git push --follow-tags`.

## Reporting a bug

Use the issue template. “It does not work” is not actionable; the template asks
for the version, the smallest input, and the observed vs expected output — with
those, most reports can be reproduced in one command.
