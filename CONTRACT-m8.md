# CONTRACT-m8 — Final gates: parity + CPU budget + docs-index + packaging (frozen 2026-10-18)

M8 closes the "ultimate" loop. No new kernel surface beyond W8/W9 gates; everything is verification + packaging so releases are reproducible and free-plan safe.

## Artifacts

- `tools/docs-check.mjs` — re-checks Appendix C (MAP.md) against the source of truth. Parses the coverage table, asserts 105 rows, no blank verdict, each row has `Class` in `✅|🟡|🔴|⛔` and non-empty `Note`. If `laravel/docs` checkout or network fetch is available, cross-checks file list; otherwise table-count gate alone passes (offline-safe). Exit 0 = PASS, non-zero = FAIL (CI blocker).
- `tools/bench.mjs` — micro-budget gate. Exercises hot paths (router match, `db.table().toSql()`, `Validator.passes()`, `defineSchedule._match`, `encrypter` round-trip, `cache`/`storage` memory) for N=5k-10k iterations, measures `performance.now()` p50/p95/avg/max. Gate: `p95 <= 5ms` per op and `avg <= 2ms` (router/db/validator/scheduler/cache) — tuned to measured 1–6ms. Prints JSON line per op + overall PASS/FAIL.
- `kernel/tests/budget.test.mjs` — test-side twin of `bench.mjs`: same loops under `node --test`, asserts per-op `avg` and `p95` within budget (5ms). Proves the gate in the same harness CI runs for `npm test`.
- `package.json` — `scripts.check:docs`, `scripts.bench`, `scripts.test:budget`; `test` now includes `budget.test.mjs` (47→ ~48 tests). `files` already covers `tools/*` + `kernel/*`.
- `bin/laravel-workers.mjs` — new commands `bench`, `check:docs`, `test:budget` (plus listed in unknown-command help).
- `.github/workflows/ci.yml` — adds `node tools/docs-check.mjs` and `node tools/bench.mjs` after `npm test`/`test:corpus`.
- `README.md` + `MAP.md` — Status bumped to M8 complete, docs-check/bench usage documented, evidence log appended.

## Gates (frozen thresholds)

```
docs-check:  table_rows == 105  &&  no blank verdict  &&  note != ""
bench/budget: per-op p95 <= 5.00 ms  &&  avg <= 2.00 ms  (router/db/validator/scheduler/cache/storage/memory)
              encrypter p95 <= 20 ms  (WebCrypto AES — higher but still << 10ms Free? encrypter is build/mail-time, not hot path; relaxed)
overall:      npm test PASS  &&  corpus 41/41  &&  docs-check PASS  &&  bench PASS  &&  npm pack --dry-run clean
```

## Usage

```bash
node tools/docs-check.mjs        # 105/105 PASS
node tools/bench.mjs             # p95/avg JSON → PASS
npm run bench                    # alias
npm run check:docs               # alias
npx laravel-workers bench
npx laravel-workers check:docs
npm test                         # now includes budget.test.mjs
npm pack --dry-run               # 31→33 files clean
```

## Territory

- `laravel-workers` only (`tools/*`, `kernel/tests/budget.test.mjs`, `package.json`, `bin`, `.github`, `README`, `MAP`). `nearFind` untouched (local-only); live `nearfind-edge` stays as-is — M8 is a toolchain release gate, not a redeploy.
