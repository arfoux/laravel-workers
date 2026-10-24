# Audit: laravel-workers against real Laravel projects

Running log. Every claim is observed, not inferred. Timings were taken while six
audit subagents were also running, so they are upper bounds.

## Fixed during this pass

| # | Finding | Evidence | Fix |
|---|---|---|---|
| F1 | Windows backslashes in message paths (`app\Http\Controllers\X.php`) — reads as an escape in a pasted log | observed on the Laravel 13 skeleton | `relPath()` helper; every message path uses `/` |
| F2 | A local `const rel` inside `writePage` shadowed the new helper | `grep 'const rel = '` | helper renamed `relPath` |
| F3 | Unhandled routes never reached the middleware audit — it walks the route *table*, and an unhandled route has no usable entry, so the operator saw `HTTP 500` instead of the cause | `/admin/dashboard` reported `HTTP 500` while carrying `verified` | per-route middleware findings in the needsPort loop |
| F4 | `coverage check failed (--strict)` named nothing | observed | the message counts the undecided items; READINESS lists each with its fix |
| F5 | The tool offered alternatives without saying what they COST — an option the operator cannot take is not an option | user report | every multi-answer fix lists paths `free → R2 → paid`, and the label states the cost gate |

## Verified working (real Laravel 13.38.0, `github.com/laravel/laravel`)

| Scenario | Verdict printed | Notes |
|---|---|---|
| Stock skeleton (2 routes) | `RUNS ON THE EDGE` | schema footer + next steps correct |
| Dynamic segment + uncompilable controller | `DOES NOT RUN` | per-route cause + fix; the sweep named `exec()` at `app/Http/Controllers/ReportController.php:9` |
| Both routes in `registry.json` `ignore` (with reasons) | `RUNS WITH DECLARED GAPS` | reasons echoed verbatim; the block now also states that an ignored route answers 404 |
| `SESSION_DRIVER=redis` | `DOES NOT RUN` | the fix names the substitution, not just the rejection |
| `verified` / `throttle:api` / `can:` middleware | `DOES NOT RUN` | one finding per middleware, each with its own fix |

Exit codes unchanged (0 pass / 1 fail). `npm test` 765/765; `gate.mjs` PASS.

## Cost gate (new)

Fixes that have more than one honest answer print them cheapest-first, and the
label states what the option demands of the operator:

```
      free plan - works today, no payment method:
        a cron trigger drains the D1 lw_jobs table
      free plan + R2 - works, but R2 requires a credit card on the account:
        an R2 bucket for the real object storage
      Workers Paid - works, but requires upgrading the account to the paid plan:
        Cloudflare Queues with a consumer you write
```

Applied to: `Storage::` with no binding, queue dispatch with no cron trigger, GD
and Imagick in the source sweep. Source of the limits: `COMPILED.md`
§"Free-plan budget".

## Efficiency findings (measured)

`composer install` on the Laravel 13 skeleton: **379 s** (cold Composer cache).
This is what the tool requires to boot the app at build time; see §Vendor below.

**The build boots Laravel from scratch for every PHP helper call.** A bare boot
(`autoload` + `bootstrap/app.php` + `Kernel::class`) measured **2815 / 3064 /
5101 ms** across three runs. `build.mjs` spawns PHP **16 times by static count**,
and more on a real app:

| Call site | Spawns | Note |
|---|---|---|
| `route:list --json` | 1 | |
| `config-dump.php` | 1 | |
| `schedule-dump.php` | 1 | |
| `schema-dump.php` | 1 | |
| `prerender.php` | **1 per route** | a 50-route app = 50 boots |
| `compile-view.php` | **1 per view**, and again per error view | two call sites, lines 621 and 1278 |
| `model-dump.php` | **3+**, and one per transitive round | lines 1004, 1015, 1137 |
| `class-dump.php` | **1 per Gate-callback class** | inside a `for` loop, line 1102 |
| `policy-dump.php`, `event-dump.php`, `formrequest-dump.php`, `constants-dump.php` | 1 each | |

A 40-route / 15-view app therefore pays roughly **60 boots ≈ 3–5 minutes** in
boot cost alone. Proposed fix (not implemented): one long-lived PHP dispatcher
that boots Laravel once and serves the existing helpers over a JSON-lines
protocol on stdin/stdout. That turns N boots into 1 without changing any dump
output. Secondary win: batch the three `model-dump` calls into one.

**Redundant work:** `compile-view.php` compiles the same view twice for the
`/` route (lines 621 and 1278). No caching: the `.cache/laravel-workers/` dumps
are written but never read back to skip a rebuild.

## Vendor (`composer install`) — user complaint

The build requires `vendor/autoload.php` (`build.mjs:110`) and 23 helper scripts
boot the real app. That is inherent to the oracle design (compile against real
PHP behaviour), and an app that already runs locally already has `vendor/`.
The cost only appears on a fresh clone or in CI.

Open question being measured: whether `composer install --no-dev` is enough to
boot the app at build time. If yes, the documented path gets materially faster
for large apps (no PHPUnit/Faker/Pint/Sail download).

## Open findings from the multi-project sweep

_pending — six projects in flight: BookStack, Koel, Monica, Snipe-IT, Cachet, LinkAce._
