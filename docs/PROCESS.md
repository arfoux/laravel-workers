# Process — how a change reaches `main`, and how a release reaches npm

This is the operating contract for this repository. It exists because the pipeline is
**tag-driven and parity-gated**: a mistake in the order of operations costs a remote tag
delete or a broken `latest` on npm. Follow it so you never have to re-derive the rules.

Companion truth: [`COMPILED.md`](../COMPILED.md) (construct coverage + declared gaps),
[`CHANGELOG.md`](../CHANGELOG.md) (release notes), [`MAP.md`](../MAP.md) (the map),
[`README.md`](../README.md) (status).

## 0. How to read this document

Nothing here is a law for its own sake; each rule is either a **hard constraint** of this
repository's pipeline or a **default** you may override with a reason.

- **Hard** — violating it breaks a real thing (a broken release, a red CI, a dead npm link).
  Every "must"/"never" that is marked *hard* is backed by a concrete failure we hit; if you
  think it does not apply, re-read the *why* before overriding.
- **Default** — a convention (branch names, how many commits, `--rebase`, `gh` vs the web UI).
  Take it when you have no reason not to; deviate freely when you do, and say why in the PR.

If a rule here ever turns out to be wrong, **fix the rule** (and its *why*) in the same change.
A process doc that lies is worse than none.

| guidance | kind | why |
|---|---|---|
| publish is a tag, `tag == version` | hard | `publish.yml` asserts it; a mismatch aborts the release |
| don't tag until the commit is verified | hard | a tag is near-irreversible (remote delete needed to retag) |
| mirror the CI set before pushing | hard | CI is the gate; a red push to `main` blocks everything downstream |
| commit every referenced-but-untracked file | hard | `npm test` names the file → CI fails on the checkout |
| an "identical to PHP" claim needs an oracle probe | hard | the whole product is byte parity; a guess ships a divergence |
| work on a branch, land via a PR | default | a trivial one-line docs fix may go straight to `main` |
| few thematic commits | default | fewer chances to forget a file; two is the usual shape |
| `gh pr merge --rebase` | default | keeps this repo's history linear; squash is fine if you prefer |
| explicit `git add <path>` | default | `-A` is fine in a clean tree; it is a hazard only in a dirty one |

## 1. The release contract

- **A release is a tag, not a version edit.** `.github/workflows/publish.yml` listens on
  `push: tags: v*`. Editing `package.json` by hand (or with `npm version --no-git-tag-version`)
  publishes **nothing**.
- The `publish` job asserts `v<package.json.version> == $GITHUB_REF_NAME`. A tag that does not
  name the version in `package.json` fails the release with *"retag the release commit"*.
- **The shadow harness is the release gate.** `publish`, `publish-gpr` and `release` all
  `needs: shadow` — a real Laravel app (PHP 8.3 + the PHP oracle) is replayed against the
  compiled worker and diffed byte-wise. A parity regression blocks the release outright.
- **A tag is close to irreversible.** If a bad tag is pushed, `publish` aborts but the tag
  exists and must be deleted on the remote before retagging. Therefore: **do not tag a commit
  you have not verified** — CI green on the pushed SHA, or (for a docs-only change with no CI
  signal) the local set in §2. *[hard]*

### Release recipe

```sh
# 1. land the change on main via a green PR (section 3)
# 2a. if package.json does NOT yet carry the target version:
npm version patch            # or minor/major — writes package.json, commits, creates the v* tag
git push && git push --follow-tags
# 2b. if package.json ALREADY carries the version (and is untagged):
git tag -a v0.4.6 -m "v0.4.6 — <summary>"
git push origin v0.4.6       # the tag push is what triggers publish.yml
```

Prefer `npm version <level>` when you are free to choose the level — it keeps
`package.json`, the commit and the tag in one act. Use 2b only when the version is already
in the tree (the common case after an "unreleased work in progress" wave).

## 2. The verification set — mirror CI locally before you push

CI runs on every push and every pull request (`.github/workflows/ci.yml`). A docs/tooling
change still has to clear the same jobs. Reproduce them (the PHP-oracle ones need a Laravel app
in a scratch directory, not this repository):

| CI job | local command |
|---|---|
| `test` | `npm test` → `npm run test:corpus` → `node tools/gate.mjs --strict` → `npm run bench` → syntax check → `node tools/pack-gate.mjs` |
| `parity-oracle` | `LW_LARAVEL_APP=<app> node --test kernel/tests/{auth,cache,csrf,session,ratelimit}.test.mjs` |
| `e2e-fresh-laravel` | `npm pack` then install the tarball into a fresh app and `npx laravel-workers build`; `node tools/pack-smoke.mjs --app <app>` |
| `shadow` (release only) | `node shadow/run.mjs --app <app> --scenarios shadow/scenarios/fresh-app.mjs --build` |

Facts worth knowing:
- `npm test` skips the oracle tests when there is no Laravel app; the `parity-oracle` job exists
  precisely so they run for real, and it re-checks `# skipped 0` so a silent skip fails the job.
- `tools/pack-smoke.mjs` **skips** without an app — that skip is expected locally, not a failure.
- `node --check` over every shipped module catches the syntax error a test would miss.

**Run the set once, on the commit you are about to push.** "It passed on my dirty tree" is not
the same as "it passes on the commit": uncommitted sibling edits can make the working tree green
while the commit (with a missing file, or without a co-dependent edit) is red.

## 3. Change flow — branch → PR → green → merge → tag

```sh
git checkout -b <topic>          # default: work on a branch
# ... edit, stage EXPLICIT paths, commit ...
git push -u origin <topic>
gh pr create --base main --head <topic>
# wait for the checks; merge only when they are green
gh pr merge <n> --rebase --delete-branch
git checkout main && git pull --ff-only
```

A branch + PR is the **default**, not a rule: a one-line docs typo may go straight to `main`
(CI runs on `push` too, so the check still happens — just after `main` moves). Use a branch
whenever the change could be wrong in a way worth seeing before `main` moves; that is the whole
point of the PR.

Why a PR and not "push to main, then tag":
- `ci.yml` also triggers on `pull_request`, so the PR gives you a green signal **before** `main`
  moves and **before** a tag exists.
- Pushing straight to `main` and tagging immediately means a red job is discovered *after* the
  tag is public.
- `--rebase` keeps `main` linear (this repository's history is linear) without collapsing your
  logical commits into one squash.

## 4. Commit hygiene

- **Stage explicit paths**, not `git add -A`. In a big working tree, `-A` sweeps in scratch files.
- **A referenced-but-untracked file is the classic breakage.** If `package.json`'s `test` script
  names a test file, that file **must** be committed in the same change — otherwise CI fails at
  `npm test` on the checkout, even though it passed locally where the untracked file existed.
- Prefer **few, thematic commits** over many micro-commits when a large tree accumulates: the real
  risk is a forgotten file, and fewer commits mean fewer chances to forget one. Two is usually
  right: one "code + tests" commit and one "docs" commit.
- Update the docs **in the same change**: `CHANGELOG.md` (the release note), `COMPILED.md`
  (coverage / declared gaps) and `README.md`/`MAP.md` when a construct's verdict moves. The
  `gate` (`tools/docs-check.mjs` + `tools/construct-audit.mjs`) fails if the map and the code
  disagree.
- CRLF→LF warnings on Windows are expected and harmless — git normalises on commit.

## 5. Parity discipline — "identical to PHP" needs a probe

This repository's whole value is *byte parity with Laravel*. That makes a careless claim worse
than a missing feature.

- **A parity claim requires an oracle probe** (PHP 8.3 + `laravel/framework` 13.37), not a code
  reading. If you only read the code, say **"reviewed"**, never **"equal"**.
- Where a real difference exists but is a representation gap (JS has one number type; JS strings
  are UTF-16 where PHP strings are bytes; PCRE without `/u` is byte-mode), **document it in
  `COMPILED.md` §6** and move on — do not silently "fix" it in a way that breaks the common case.
- Reproduce **before** and **after**: run the failing case, apply the fix, run it again. Where a
  regression is plausible, keep the failing-before/passing-after test.
- Beware the justified-sounding-but-wrong ledger entry. This repository's audit caught itself
  writing *"Laravel always emits LIMIT for an offset"* (false — `Grammar::compileOffset` emits a
  bare `offset N`, and SQLite rejects it identically) and *"urldecode is equal to PHP"* (false —
  PHP is byte-wise, the edge decodes `%XX` as UTF-8). Both were caught by probing, not reading.

## 6. Where the truth lives

| question | file |
|---|---|
| Does construct X compile, fail loud, or is it a declared gap? | `COMPILED.md` (§ the audit table) |
| What changed, and in which release? | `CHANGELOG.md` |
| Module ↔ coverage map, fail-loud codes | `MAP.md` (checked by `tools/docs-check.mjs`) |
| Status, quickstart, construct counts | `README.md` (counts checked by `tools/docs-counts.mjs`) |
| This operating contract | `docs/PROCESS.md` |

## 7. The public face — numbers are generated, images are absolute

- **Never hand-type a number the repo can compute.** The construct counts, the facade coverage,
  the corpus size and the docs verdict count are written into `README.md` between
  `<!-- readme-counts:start -->` / `<!-- readme-counts:end -->` by `node tools/docs-counts.mjs --write`
  and **the gate fails when they drift** (`tools/gate.mjs` runs it with `--check`). The same idea
  writes the `COMPILED.md` table (`tools/construct-audit.mjs`). A hand-typed count rots silently —
  the README said "113 constructs / corpus 51" for two waves after the code moved on.
- **Images use an absolute `raw.githubusercontent.com` URL.** npm renders the README but does not
  resolve repository-relative image paths, so `![...](docs/banner.png)` shows on GitHub and breaks
  on npmjs.com; `![...](https://raw.githubusercontent.com/<owner>/<repo>/main/docs/banner.png)`
  works on both.
- **Inline `<svg>` is stripped** by GitHub's markdown sanitiser; a *linked* `.svg` renders, but the
  safe hero is a PNG. Ship the `.svg` source and the rasterised `.png` together
  (`docs/banner.svg` → `docs/banner.png`), and keep both in the tarball.
- **Rasterise once, on demand** — there is no image toolchain in the repo and there must not be:
  `npx --yes sharp-cli -i docs/banner.svg -o docs/banner.png`, then commit both files. The
  published README image is a shipped artifact, so `tools/pack-gate.mjs` lists `docs/banner.png`
  among the README-linked files.
- `docs/social-preview.png` (1280×640) is the GitHub social card; it is uploaded in
  **Settings → Social preview** (no API for it) and regenerated the same way.

