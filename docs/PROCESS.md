# Process — how a change reaches `main`, and how a release reaches npm

This is the operating contract for this repository. It exists because the pipeline is
**tag-driven and parity-gated**: a mistake in the order of operations costs a remote tag
delete or a broken `latest` on npm. Follow it so you never have to re-derive the rules.

Companion truth: [`COMPILED.md`](../COMPILED.md) (construct coverage + declared gaps),
[`CHANGELOG.md`](../CHANGELOG.md) (release notes), [`MAP.md`](../MAP.md) (the map),
[`README.md`](../README.md) (status).

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
  exists and must be deleted on the remote before retagging. Therefore: **never tag a commit
  whose CI has not gone green.**

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
git checkout -b <topic>          # never work straight on main
# ... edit, stage EXPLICIT paths, commit ...
git push -u origin <topic>
gh pr create --base main --head <topic>
# wait for the checks; merge only when they are green
gh pr merge <n> --rebase --delete-branch
git checkout main && git pull --ff-only
```

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
| Status, quickstart, construct counts | `README.md` |
| This operating contract | `docs/PROCESS.md` |
