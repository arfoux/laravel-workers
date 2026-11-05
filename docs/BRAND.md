# Brand

The brand is **one idea, carried unchanged** across every surface: a Laravel app
compiles to a Cloudflare Worker, so the mark is Laravel's **L** whose foot ends
in an **edge arrow** — the PHP side hands off to the edge.

This file is the single source. `docs/CI.md` §Brand keeps only the facts that
belong to the reporter; a colour, a size or a voice rule lives **here** and is
linked, never copied.

## The mark

`docs/logo.svg` (PNG: `docs/logo.png`, 512×512).

| | |
|---|---|
| shape | one path, no stroke: `M132 68h140v240h96l100 64-100 64H132z` — stem 140 wide (x 132→272), foot to x 468, arrowhead 100 units each side of y 372 |
| gradient | `userSpaceOnUse`, `(146,80)` → `(432,372)`: `#ff2d20` at 0 · `#ff4f20` at 0.55 · `#f38020` at 1 |
| background | none, and never one: the mark reads on light and on dark |
| accessibility | `role="img"` + `<title>`, never a live-text logo |
| never | text inside the mark, a stroke, a recolour, a shadow, a rotation |

**Secondary mark**: `docs/verdict.svg` — monoline hexagon with a check, 96×96,
`currentColor`, no gradient, no text inside. For a standalone badge or favicon,
not for the header.

## Palette

| token | hex | where |
|---|---|---|
| `laravel` | `#FF2D20` | the mark's stem — the PHP side |
| `workers` | `#F38020` | the mark's arrowhead — the Cloudflare edge |
| `ink` | `#0E1412` | text and the social card's ground |
| `paper` | `#F5F2EA` | light ground |
| `shore` | `#1FA37C` | a clean run (RUNS WITH A NO-GAPS REPORT) |
| `signal` | `#E0A126` | declared gaps — they ship, and they are named |
| `block` | `#D14343` | refusal (BUILD FAILED, a byte-parity break) |

Two brands in the mark and nothing between them: red is the source, orange is
the edge. `shore`/`signal`/`block` are status, never decoration.

## Type and spacing

No webfont is bundled and none is required; every surface uses the system sans
stack. Sizes are the ones actually shipped: mark 512, banner 1280×280, social
card 1280×640, the reporter's inline mark 20 px (top-aligned with the first
line, so the mark sits on the text baseline block, not above it).

## Voice

English, terse, factual, first thing first.

- Verdict first — `RUNS ON THE EDGE`, `RUNS WITH DECLARED GAPS`, `BUILD FAILED` —
  then the numbers, then the full report folded away.
- Gaps are never hidden: say how many, and say that they ship.
- Never "all checks passed" without saying **what** was checked.
- Every number is generated from the code that knows it (`docs/PROCESS.md` §0);
  hand-typed numbers are a docs bug, not a style choice.

## Where the brand appears

| surface | file / mechanism | notes |
|---|---|---|
| README hero | `docs/banner.png` | 1280×280, the first thing on the npm page |
| GitHub social preview | `docs/social-preview.png` | uploaded by hand in Settings — the one non-automatic step |
| repo About | description, homepage, topics | words only; no asset |
| the reporter | `docs/logo.png` at 20 px | first line of every Verdict comment and job summary |
| badge | `docs/verdict.svg` / shields snippet | `docs/CI.md` §Badge |
| CLI | `bin/laravel-workers.mjs` | the mark above `--help`, and on `--version` **when stdout is a TTY** |
| docs | this file | the source the rest point at |

The CLI shows the mark only to a human: piped, `NO_COLOR`, or a dumb terminal
gets the plain one-line version, so `laravel-workers --version` stays
machine-readable and byte-stable for scripts. `FORCE_COLOR` overrides the TTY
check in either direction.

## Using it in your own project

The reporter ships as an action — use it instead of copying the script, so the
mark and every fix arrive without you re-copying a file:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write

- name: Verdict — report
  if: always()
  uses: arfoux/laravel-workers/action/verdict@<40-char commit sha>
  env:
    GITHUB_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
  with:
    log: edge-build.log
```

Pin the **commit**, not a branch: the reporter cannot change under you between
runs, and a bump is a deliberate commit. (A moving `v1` alias is planned once
the surface stops moving; until then the commit is the stable pin.) An example
of this in a real app is nearFind's `.github/workflows/ci.yml`, which replaced a
byte-identical vendored copy with the pinned action.

If you want the badge:

```markdown
![verdict](https://img.shields.io/badge/verdict-RUNS%20ON%20THE%20EDGE-1FA37C)
```

## Do not

- **Do not add a runtime response header** (`x-powered-by`, a `server` string) to
  the compiled Worker for branding. The shadow harness diffs the compiled
  worker's bytes against the PHP oracle; an extra header is a parity break for a
  cosmetic gain. The brand lives in the build output, not in the response.
- Do not fork the palette or add a third brand colour.
- Do not copy this file's facts into another doc; link it.
