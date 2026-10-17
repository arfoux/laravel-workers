# CONTRACT-m1 — frozen interfaces (view parity)

Frozen 2026-10-17 by orchestrator. Agents implement EXACTLY this. Changes require a new revision header; no improvisation.

**Goal.** `welcome` renders on the edge with **byte-identical** output to Laravel's own render:
- ref: `php edge/tools/prerender.php /` → JSON `.body`
- got: transpiled view module executed with `rt` built from the S0 context
- parity = strict byte equality. No normalization of any kind.

**Pipeline.**
1. `php edge/tools/compile-view.php welcome edge/.cache/welcome.compiled.json` → `{view, path, compiled, context}`
2. `node edge/compiler/bin/transpile.mjs edge/.cache/welcome.compiled.json --json --out edge/.cache/welcome.view.mjs`
3. rt = built from `context`; run `main(rt)`; collect `rt.echo` output; byte-compare (parity harness owned by orchestrator: `edge/compiler/tests/parity-m1.mjs`).

**Module API (frozen).** `edge/compiler/runtime/rt-from-context.mjs` exports `buildRt(context, opts)` — `opts = { strict?: boolean }` → returns `rt`; `rt.__warnings` is a `string[]`. Parity harness imports the emitted module from `edge/.cache/welcome.view.mjs`.

## Emitted module shape (v0)

- Dependency-free ESM. Exactly one export: `export default function main(rt) { ... }`
- No imports, no globals. All output through `rt.echo(value)`.
- `rt.echo(v)` = PHP echo semantics: null → `''`, true → `'1'`, false → `''`, number → `String(n)`, string → as-is. Never escapes.
- `$x` → plain JS local (`let`). PHP sigils never appear in emitted JS.
- Template mode: text outside PHP tags → `rt.echo("<exact bytes>")`; `<?= expr ?>` → `rt.echo(expr)`.
- Fail-loud: unwhitelisted call/static, unsupported AST node, or parse failure = compile error (codes below). Never emit silently-wrong code. Never `console.log` in emitted code.

## rt whitelist (M1 — exact)

| PHP (as written in compiled views) | JS runtime (rt) |
|---|---|
| `e($v)` | `rt.e($v)` — must equal PHP `htmlspecialchars((string)$v, ENT_QUOTES \| ENT_SUBSTITUTE, 'UTF-8')`, double_encode = true |
| `str_replace($a,$b,$s)` | `rt.str_replace(a,b,s)` — string args only in M1 |
| `config($k[,$d])` | `rt.config(k,d)` ← `context.config[k]`; missing key + no default → throw |
| `app()` | `rt.app()` → `{ version(), getLocale() }` ← `context.app` |
| `app('X')` | `rt.app('X')` service shim; M1: only `'Illuminate\Foundation\Vite'` |
| `app('…Vite')([entries…])` | callable shim → returns `context.vite.invoke` |
| `app('…Vite')->fonts()` | → `context.vite.fonts` |
| `public_path($p)` | `rt.public_path(p)` → `p` (identity; `context.files` keys are public_path-relative) |
| `file_exists($p)` | `rt.file_exists(p)` → `context.files[p]`; unknown path → throw |
| `Route::has($n)` | `rt.Route.has(n)` → `n` ∈ `context.route_names` |
| `auth()` | `rt.auth()` → `{ guard() → { check() → bool } }` ← `context.auth.check` |
| `url($p)` / `route($n, …)` | `rt.url(p)` / `rt.route(n, …)` ← `context.urls`; uncaptured arg → throw |

Whitelisted builtins (flat on rt): `isset`, `empty`, `unset`, `count`, `in_array`, `implode`, `explode`, `sprintf` (subset `%s %d %u`), `strtolower`, `strtoupper`, `trim`.

## Error codes

`LW001` unknown function · `LW002` unsupported construct · `LW003` unknown class/static · `LW004` parse error.
Payload per error: `{code, message, line, column, hint}`. CLI prints JSON array to stderr, exit 1. Partial output must never be written to `--out` (temp + rename).

## CLI

`node bin/transpile.mjs <input> [--json] [--template] [--out <file>]`
- `.php` file = pure PHP. `--template` = the `.php` contains mixed HTML/PHP. With `--json` = S0 dump (uses `.compiled`, implies `--template`).
- No `--out` → JS to stdout.

## Context (enriched shape — produced by A5)

```json
{
  "app": { "version": "13.37.0", "locale": "en" },
  "config": { "app.name": "nearFind", "app.locale": "en" },
  "vite": { "fonts": "<captured string>", "invoke": "<captured string>" },
  "files": { "build/manifest.json": true, "build/fonts-manifest.json": true, "hot": false },
  "auth": { "check": false },
  "routes": [ { "uri": "...", "name": null, "methods": ["GET"], "domain": null } ],
  "route_names": ["storage.local", "storage.local.upload"],
  "urls": { "<arg>": "<captured url or {error}>" },
  "app_version": "13.37.0",
  "vfs": { "build/manifest.json": true, "build/fonts-manifest.json": true, "hot": false }
}
```

- `rt-from-context.mjs` accepts BOTH enriched and legacy shapes (`app_version`, `vfs` compat).
- Fallback rule: missing enriched keys are allowed only with a recorded `rt.__warnings.push("<reason>")`. Behavior: `vite` → `''`; `auth` → `{check:false}`; `urls`/`route` → throw when actually called.
- Parity harness runs with `rt.strict = true` → every fallback becomes a throw.

## Corpus policy

Expected outputs are generated ONLY by executing real PHP (`php` + Laravel autoload where needed). Never from our JS. Byte-exact files, LF endings, UTF-8 no BOM.

## Territories (strict — do not cross)

| Agent | Owns |
|---|---|
| A2 | `edge/compiler/{package.json, bin/**, src/**, runtime/**, tests/smoke.mjs}` |
| A4 | `edge/compiler/tests/corpus/**`, `edge/compiler/tests/run-corpus.mjs` |
| A5 | `edge/tools/compile-view.php`, `edge/tools/verify-s0.php`, `edge/notes/**` |
| orchestrator | `edge/compiler/tests/parity-m1.mjs`, `edge/MAP.md`, everything else |

No git commands. No deploys. No edits outside your territory. Scratch: `C:\Users\HP\AppData\Local\Temp\opencode`.
