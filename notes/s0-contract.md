# S0 context contract — `welcome` (enriched shape)

Verified by `php edge/tools/verify-s0.php` (15/15 PASS, 2026-10-17). Recomputed independently from a fresh Laravel boot (HTTP kernel + `Request::create('/', 'GET')`). Source dump: `edge/.cache/welcome.compiled.json`.

## Enriched keys

| Key | PHP type | Value (captured) | Semantics |
|---|---|---|---|
| `app.version` | string | `13.37.0` | `app()->version()` — Laravel framework version baked at build time. |
| `app.locale` | string | `en` | `app()->getLocale()` — resolved locale for the build request. |
| `config.app.name` | string | `nearFind` | `config('app.name')`. |
| `config.app.locale` | string | `en` | `config('app.locale')`. |
| `vite.fonts` | string | 2917 B, sha1 prefix `9299070071cd` (first 120 chars: `<link rel="preload" as="font" href="http://[::1]:5173/__laravel_vite_plugin__/fo…`) | `app('Illuminate\Foundation\Vite')->fonts()` captured via `ob_start` on a FRESH Vite instance (avoids preloadedAssets dedup pollution). |
| `vite.invoke` | string | 215 B, sha1 prefix `3f736a38505d` (first 120 chars: `<script type="module" src="http://[::1]:5173/@vite/client"></script><link rel="s…`) | `app('Illuminate\Foundation\Vite')(['resources/css/app.css','resources/js/app.js'])` on the same fresh instance. |
| `files.build/manifest.json` | bool | `true` | `file_exists(public_path('build/manifest.json'))`. |
| `files.build/fonts-manifest.json` | bool | `true` | `file_exists(public_path('build/fonts-manifest.json'))`. |
| `files.hot` | bool | `true` | `file_exists(public_path('hot'))` (dev server present at build time). |
| `auth.check` | bool | `false` | `auth()->guard()->check()` wrapped in try/catch (no HTTP session → false). |
| `routes` | array[5] | see below | `route:list` dump: `{uri, name, methods, domain}` per route. |
| `route_names` | string[] | `["storage.local","storage.local.upload"]` | Named routes only. |
| `urls` | object | `{"/dashboard":"http://localhost/dashboard", "login":{"error":"Route [login] not defined."}, "register":{"error":"Route [register] not defined."}}` | Every `url(...)`/`route(...)` call site in compiled PHP segments, eval'd against the build request root. Uncaptured names store `{"error": "<msg>"}`. |
| `app_version` (legacy) | string | `13.37.0` | Alias of `app.version` (compat). |
| `vfs` (legacy) | object | `{"build/manifest.json":true,"build/fonts-manifest.json":true,"hot":true}` | Alias of `files` (compat). |

## routes[] entries

| uri | name | methods | domain |
|---|---|---|---|
| `up` | null | GET, HEAD | null |
| `/` | null | GET, HEAD | null |
| `dbcheck` | null | GET, HEAD | null |
| `storage/{path}` | `storage.local` | GET, HEAD | null |
| `storage/{path}` | `storage.local.upload` | PUT | null |

## Fallback rules (runtime, `rt-from-context.mjs`, strict mode)
- `vite.fonts`/`vite.invoke` missing → `''` (recorded warning) unless `strict:true` → throw.
- `auth.check` missing → `{check:false}` (recorded warning) unless strict → throw.
- `urls`/`route_names` missing → throw when called (no silent fallback; uncaptured name → throw).
- `Route::has(n)` ← `route_names` (missing → throw).
- `url(p)`/`route(n, …)` ← `urls` (uncaptured → throw).

## Compiled field registry
- sha256: `131e83f6232dd177d2f0a9115c5035f2a4cb3b3076a84b4c75fe5f4f49e96654`
- bytes: `72561`
- created: `2026-10-17T17:31:58Z`
- stored in: `edge/notes/welcome.compiled.sha256.txt` (format: `<sha>  <bytes>  created=<iso>`).

## Verification
- `php edge/tools/verify-s0.php` → `VERIFY-S0: PASS (15/15 checks)` + `OK compiled sha256 matches registry`, exit 0.
- Idempotent: rerun twice → same result (verified).
- `edge/notes/s0-verify.txt` written on pass.
