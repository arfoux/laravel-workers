# Plan: stop making `composer install` a prerequisite

## 1. First, the claim needs correcting

"Setiap proyek harus `composer install` dulu" is **not true for the normal case**.

The build needs `vendor/autoload.php` to exist (`build.mjs:110`), and 23 helpers
boot the real app. But:

| Situation | Is `composer install` needed? |
|---|---|
| A Laravel app you already run locally (`php artisan serve` works) | **No.** `vendor/` is already there. `npx laravel-workers build` needs nothing. |
| A fresh `git clone` | Yes — the clone has no `vendor/` (it is gitignored) |
| CI | Yes — unless the vendor is cached between runs |

Observed in this session: I cloned `laravel/laravel`, paid 379 s once, and then
every one of the ~12 subsequent builds needed no Composer at all. The
prerequisite is **once per checkout**, not once per build.

So the real complaint is narrower and fixable: *the first build in a fresh
checkout or CI job is slow, and the tool does not explain why or offer a cheaper
route.*

## 2. The cost is really in the boots, not the install

Measured on the Laravel 13 skeleton (while six audit agents were also running,
so these are upper bounds):

| Thing | Measured |
|---|---|
| `composer install` (cold Composer cache) | **379 s** |
| One bare Laravel boot (`autoload` + `bootstrap/app.php` + `Kernel`) | **2815 / 3064 / 5101 ms** |
| PHP spawns in `build.mjs` | **16 by static count**; `prerender` is 1 per route, `compile-view` 1 per view, `class-dump` 1 per class |

A 40-route / 15-view app pays roughly **60 boots ≈ 3–5 minutes** — every single
build, not just the first. That is the number worth attacking, and it makes the
vendor question mostly disappear: pay the install once, then have fast builds.

## 3. Options, cheapest first

### A. Explain it (no code risk, do first)

`vendor/ not found — run composer install` is true and actionable but omits the
two things that remove the sting:
- that this is **once per checkout**, and an app that already runs locally
  already has `vendor/`;
- the **fastest** command for a build-only checkout.

Proposed message:

```
vendor/ not found — the build boots your app, so it needs its dependencies.
  one-time per checkout:  composer install --no-dev
  (an app you already run locally already has vendor/ — nothing to do)
  see docs/VENDOR.md for the CI cache recipe
```

Cost: minutes. Risk: none.

### B. `composer install --no-dev`

The build needs the app to boot, not to run tests. `laravel/laravel` dev-requires
PHPUnit, Faker, Pint, Sail, Collision, Mockery, Pail — none of which the boot
touches.

Needs one measurement before it becomes the documented default: does the build
still succeed on `--no-dev`? Some apps register dev-only providers. If it works,
this is the single biggest constant-factor win available, and it costs nothing.

Status: **measuring**.

### C. Reuse a `vendor/` you already have — `LW_VENDOR_DIR`

CI almost always has a cached vendor; monorepos have a sibling app with the same
lock file. Let the operator point at it:

```
LW_VENDOR_DIR=/path/to/cached/vendor npx laravel-workers build
```

Implementation: `tools/_root.php` already resolves the app root through
`LW_APP_ROOT`. Add the same pattern for the vendor path, and have `build.mjs`
pass it through. The Composer autoloader is relocatable (`__DIR__`-relative), so
a copied or hardlinked tree works.

Cost: small. Risk: low. Win: removes the install entirely for CI with a warm
cache.

### D. One long-lived PHP dispatcher (the real fix for "lama banget")

Replace the 16+ `execFileSync(PHP, …)` calls with **one** PHP process that boots
Laravel once and serves the existing helpers over a JSON-lines protocol on
stdin/stdout:

```
{"cmd":"route:list"}          -> the same JSON route:list emits
{"cmd":"config"}              -> the same config-dump JSON
{"cmd":"model","fqcns":[…]}   -> the same model-dump JSON
{"cmd":"prerender","route":…} -> the same prerender JSON
```

Every `tools/*.php` becomes a handler in one dispatcher file that reuses the same
bootstrap. The helpers keep their output byte-for-byte, so no oracle test
changes.

Expected effect: N boots → 1. For the 40-route app above, ~3–5 minutes of boot
cost collapses to ~3–5 seconds. This is the change that answers the actual
complaint.

Cost: medium — one new file plus rewiring 16 call sites; the risk is behavioural
drift between the one-shot helpers and the dispatcher, which the existing
oracle/shadow tests will catch. Sequence it after A–C so the low-risk wins land
first.

Secondary wins while in there:
- batch the three `model-dump.php` calls (lines 1004, 1015, 1137) into one;
- `compile-view.php` runs twice for `/` (lines 621 and 1278) — call once;
- the `.cache/laravel-workers/` dumps are written but never read back; make them
  a real cache keyed on source mtime + `composer.lock` so an unchanged app
  re-builds in seconds.

### E. A content-addressed `vendor/` cache

Keep the installed tree under
`<cache>/laravel-workers/vendor/<sha256(composer.lock + php version)>` and reuse
it across projects and builds.

Win: the second project with the same lock file costs nothing. Cost: medium —
invalidation, disk usage, and Composer's path-repositories (which do embed
absolute paths). Only worth building if A–D leave a real gap.

### F. Rejected: ship a bundled framework

Bundling `laravel/framework` inside laravel-workers would break the one
guarantee the project is built on. The whole design is *compile against the
app's real framework version* (COMPILED.md §"PHP pin": oracle = PHP 8.3.30,
byte-parity tests). A bundled framework of a different version would silently
change behaviour — and the app's own packages (Sanctum, Inertia, …) are needed to
boot regardless. **Reject.**

### G. Rejected as a default: a `--no-boot` mode

Parse `routes/*.php` with `php-parser` and skip Laravel entirely. It would work
with zero vendor — but route groups, middleware aliases and provider-registered
routes are runtime facts, so a partial parse would diverge *silently*. This repo's
stated invariant is "silent divergence is the only real failure"
(COMPILED.md §0). **Reject as a default.** If ever built, it must be an explicit
`--approximate` mode that prints `READINESS: UNVERIFIED` and refuses to claim
parity.

## 4. Recommended order

| Step | Change | Cost | Answers |
|---|---|---|---|
| 1 | **A** — the message | minutes | "why does it want Composer at all?" |
| 2 | **B** — `--no-dev`, if it holds | one measurement | "the install is slow" |
| 3 | **C** — `LW_VENDOR_DIR` | small | "CI should not re-install" |
| 4 | **D** — one PHP dispatcher | medium | **"the build is slow"** — the actual complaint |
| 5 | **E** — vendor cache | medium | only if 1–4 leave a gap |

Steps 1–3 remove the *prerequisite*; step 4 removes the *slowness*. `laravel-workers`
will still need a `vendor/` to exist — that is what "boot the real app" means, and
it is the source of the byte-parity guarantee. What changes is that it becomes
one cheap, explained, cacheable step instead of a silent multi-minute tax.

## 5. Open evidence

- `composer install --no-dev` timing and whether the build succeeds on it — **measuring**.
- Real-project confirmation that a warm-CI `vendor/` reuse works — needs the
  multi-project sweep results.
