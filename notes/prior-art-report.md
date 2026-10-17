# W0 — Prior-art report: Laravel → Workers, compile-time, no PHP at request time

**Date:** 2026-10-17 · **Method:** bounded `gh search repos` / `gh search code`, npm registry search, web search. Stars/dates observed 2026-10-17.

## Loud verdict

**No end-to-end equivalent found. The "compile-time Laravel → Workers-native artifact, no PHP at request time, byte-parity-tested" combination is CLEAN as of 2026-10-17.**
Every Laravel-on-Workers alternative found executes PHP per request (WASM); every static exporter is static-only; every PHP→JS transpiler is generic, framework-blind, or dead. Caveats at bottom.

## Answers

**(1) Does anyone transpile compiled Blade PHP → JS and byte-parity test against Laravel renders? — No.**
No repo/package found that (a) takes Blade-compiled PHP, (b) emits JS render modules, (c) byte-compares against real Laravel output. Code searches for `compiled blade`, `blade transpile`, `byte-identical laravel` returned nothing relevant. Closest: `stacksjs/stx` (Blade-*like* syntax → JS, no Laravel/PHP semantics), generic `php2js` tools, and WASM projects that *run* PHP instead of transpiling it.

**(2) Is the end-to-end compile-time claim still clean? — Yes, with phrasing discipline.**
Laravel fully running on Workers exists (workersphp production demo, togishima, laraworker), but all are **PHP-at-request-time (WASM)** — a different class (cold ≈1s CPU; Free-plan budget risk). Static capture (`spatie/laravel-export` + Pages guides) covers tier-1 only: no dynamic endpoints, no compile step. Generic PHP→JS transpilers exist but none are Laravel-aware and none ship a parity harness; several are dead/unfinished. Nothing was found combining build-time boot + tiered static/snapshot/compiled/ports + coverage enforcement + D1 kernel + byte parity + Free-plan budget. No relevant new project found newer than Aug 2026.

**(3) Worth crediting / linking in README:** workersphp (core + laravel-bridge + pdo-cfd1 + seanmorris/php-wasm), togishima/laravel-edge, kieranbrown/laraworker, cloudflare/php-worker-hello-world (+ babel-preset-php), spatie/laravel-export, uniter/phptojs, glayzzle/php-parser, renoki-co/l1, TanDuy03/cloudflare-d1-database, stacksjs/stx, ulanguage.org. Details below.

## Findings table

| Name | URL | Date / stars (2026-10-17) | What it does | Overlap | Gap |
|---|---|---|---|---|---|
| workersphp/core (+ laravel-bridge, pdo-cfd1) | github.com/workersphp/core · workersphp.dev | Aug 2026 · 2★ core, 0★ bridge; npm 15–23 dl/mo | PHP 8.5 WASM resident in isolate; prod Laravel demo with D1/KV/R2/Queues/DO drivers; build-time Blade+OPcache bake (inside wasm) | Full Laravel-on-Workers stack, D1, drivers, one-command deploy | PHP interpreter runs at request time (cold ≈1s CPU); wasm, not transpile; no byte-parity tests vs Laravel |
| togishima/laravel-edge | github.com/togishima/laravel-edge | Jul 2026 · 2★ (one-day repo) | Unmodified Laravel 13 via custom static php-wasm build + PDO cfd1; warm ≈70 ms, cold 1–5 s; SQL allow-list | Same goal space; proves PHP-on-Workers is possible | Same wasm class; request-time PHP; no compiler, no parity, no tiers |
| kieranbrown/laraworker | github.com/kieranbrown/laraworker | Feb–May 2026 · 2–3★; **abandoned on Packagist** | `composer require`, artisan commands; php-cgi-wasm; app.tar.gz unpacked to MEMFS per request; Laravel 12 | Laravel+Workers packaging workflow | Request-time PHP; abandoned; free-tier 3 MB claim unverified; no parity |
| cloudflare/php-worker-hello-world | github.com/cloudflare/php-worker-hello-world | 129★ · created 2020, last push Apr 2026 (stale) | Official demo: PHP→JS via `babel-preset-php` (unmaintained) | Historical ancestor of PHP→JS-on-Workers | Hello-world only; no framework/router/views/DB; no parity; abandoned direction |
| spatie/laravel-export | github.com/spatie/laravel-export | 676★ · active (Aug 2026) | Crawls a Laravel app, writes static HTML bundle (deploy to Pages) | Static tier sourced from real Laravel renders | Static only; no dynamic endpoints; no Workers model; no compile; no parity harness |
| uniter/phptojs | github.com/uniter/phptojs | 41★ · active-ish (Jul 2026) | Generic PHP→JS transpiler; **no Laravel code in repo** (verified via code search) | Transpiler core concepts; possible reference | Not framework-aware; no Blade; no parity harness; outputs a runtime bridge, not edge modules |
| glayzzle/php-parser | github.com/glayzzle/php-parser | 564★ · active (Oct 2026) | NodeJS PHP parser: AST/tokens | Candidate building block for our W1 | Parser only — compiler, whitelist, parity are ours to build |
| glayzzle/php-transpiler | github.com/glayzzle/php-transpiler | 22★ · dead (2017) | AST→JS transpiler API | Earliest PHP→JS attempt on php-parser | Dead; not Laravel/Blade-aware; no tests against PHP output |
| xxdavid/php2js | github.com/xxdavid/php2js | 5★ · 2025 | Self-described "unfinished and abandoned" PHP→JS | — | Unusable |
| aftermarketpl/aftermarketpl-php2js | github.com/aftermarketpl/aftermarketpl-php2js | 1★ · dead (2019) | "Quick and dirty" PHP→JS converter (cited in MAP §0b) | — | Dead; not Laravel-aware |
| dan-da/php2js | github.com/dan-da/php2js | 23★ · Sep 2025 | Automates PHP→JS translation (generic) | Generic transpiler | Not Laravel/Blade-aware; no parity |
| rmunate/PHP2JS | github.com/rmunate/PHP2JS | 203★ · active | Laravel package that passes PHP **values** to external JS files (Blade @php2js) — name collision only | Preempts README confusion | Not a compiler |
| stacksjs/stx + bun-plugin-stx | github.com/stacksjs/stx | 20★ · very active (pushed today) | "Blade-like syntax" UI templating language/engine for Bun | Closest thing to "Blade syntax → JS" | Not Laravel Blade, no PHP semantics, no Laravel renders, no parity |
| renoki-co/l1 | github.com/renoki-co/l1 | 164★ · Feb 2026 | Cloudflare bindings (KV/R2/Queues/D1-adjacent) for a PHP/Laravel app | Cloudflare services from Laravel | PHP still runs on a normal server; not an edge artifact |
| TanDuy03/cloudflare-d1-database | github.com/TanDuy03/cloudflare-d1-database | 28★ · Sep 2026 | Laravel DB driver talking to D1 (REST / Worker) | D1-backed Laravel | PHP runs off-edge; no compile/parity |
| ulanguage.org | ulanguage.org | 2026 site · no repo metrics | PHP→C/native compiler; claims 98.7% of 943 real files transpile cleanly | Transpiler ambition/coverage reporting | Targets C/native, not Workers/JS; no Laravel layer; no byte-parity vs Laravel |

## Notes / caveats

- `arfoux/laravel-workers` (created 2026-10-17, 0★) is **our own repo** — it appears in GitHub search results; it is not prior art.
- workersphp is the strongest incumbent: production Laravel 13.25 demo, real drivers — but it *interprets PHP at request time*, which is exactly the wall we route around (MAP §0b, §A).
- Laravel's own serverless answer is Laravel Cloud (managed PHP containers — not Workers, still PHP at request time). Octane/wasm runtimes keep the same property.
- Negative-result caveat: bounded top-N searches + heuristic code search. Re-run W0 before any public "first/discovery" wording (MAP §0b claim policy requires M1–M2 + clean scan).
- No git commands used; no files touched outside `edge/notes/**`.

## Verdict (5 lines)

1. **No end-to-end equivalent exists**: nobody compiles Laravel to a Workers-native artifact with no PHP at request time, tiers, coverage, and D1 kernel together.
2. **No Blade-compiled-PHP → JS transpiler with byte-parity tests exists** — the M1 artifact shape is, as far as all searches show, unclaimed.
3. All Laravel-on-Workers attempts (workersphp, togishima, laraworker) run **PHP per request via WASM** — different class, Free-plan CPU risk, and none parity-tests against Laravel.
4. Static exporters and generic php2js tools cover only fragments; none are Laravel-aware or byte-parity-tested.
5. **Claim status: CLEAN (2026-10-17)** — keep "an approach in progress" phrasing until M1–M2 land; re-run this scan before claiming novelty in public.
