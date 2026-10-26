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

The composer-free vendor installer (`tools/vendor-lite.mjs`) fetches the lock-resolved
dist zips and writes a self-contained autoloader; **no `composer install` is required**.
See the Vendor section below.

**The build boots Laravel from scratch for every PHP helper call.** A bare boot
(`autoload` + `bootstrap/app.php` + `Kernel::class`) measured **2815 / 3064 /
5101 ms** across three runs. `build.mjs` spawns PHP **16 times by static count**,
and more on a real app:

| Call site | Spawns | Note |
|---|---|---|
| `route:list --json` | 1 | |
| `config-dump.php` | 1 | |
| `schedule-dump.php` | 1 | |
| `schema-compile.php` | 1 | |
| `prerender.php` | **1 batch** (was 1 per route) | every URI — static entries + snapshots — renders in ONE boot (`--batch`-style argv) |
| `compile-view.php` | **1 batch per wave** (was 1 per view) | route views + error views share one boot; the controller views run one boot per dependency-depth wave, since a view's `@extends`/`@include` deps are only known once its dump exists |
| `model-dump.php` | **3+**, and one per transitive round | still per-instance |
| `class-dump.php` | **1 per Gate-callback class** | inside a `for` loop; still per-instance |
| `policy-dump.php`, `event-dump.php`, `formrequest-dump.php`, `constants-dump.php` | 1 each | |

A 40-route / 15-view app used to pay roughly **60 boots ≈ 3–5 minutes** in boot
cost alone. **Track E (implemented)** batches the two biggest: `prerender.php`
renders every URI in one boot, and `compile-view.php --batch` compiles a whole
wave of views per boot. Still per-instance: `model-dump.php` and
`class-dump.php`. Proposed (not implemented): one long-lived PHP dispatcher
that boots Laravel once and serves every helper over a JSON-lines protocol on
stdin/stdout — turns the remaining N boots into 1 without changing any dump
output. Secondary win: batch the three `model-dump` calls into one.

**Redundant work:** inside a batch, one view name shared by two jobs compiles
once (dedup by dump path). A warm rebuild reads the `.cache/laravel-workers/`
dumps back only when the compiled module is also present — a half-written cache
recompiles rather than trusting a stale dump.

## Vendor (`composer install`) — user complaint

The build requires a `vendor/autoload.php` that can boot the app, and 23 helper
scripts boot the real app. That is inherent to the oracle design (compile against real
PHP behaviour), and an app that already runs locally already has `vendor/`.
The cost only appears on a fresh clone or in CI. It is now **zero**: the build
auto-provisions a composer-free vendor tree via `tools/vendor-lite.mjs`
(`npx laravel-workers vendor:ensure` warms the content-addressed cache) - it reads
`composer.lock`, fetches each dist zip straight from its URL, extracts it, and writes
a self-contained PSR-4/classmap/files autoloader. **No `composer install` at all.**

## Open findings from the multi-project sweep

_pending — six projects in flight: BookStack, Koel, Monica, Snipe-IT, Cachet, LinkAce._
