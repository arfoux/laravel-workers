// tools/git-sha.mjs — the app's source identity, for provenance.
//
// `status` could not answer "which commit is live" and nothing in `dist/` or
// `lw-state.json` recorded it (docs/EVIDENCE.md finding 4). This module is the
// one place that asks git, so the build, `deploy`, `status` and `doctor` all
// report the same answer.
//
// It never fabricates: outside a git repository, or where git is not installed,
// it answers `null` and the caller says "not recorded" instead of printing a
// SHA it does not have. A dirty tree is reported as dirty — a deploy of a dirty
// tree is not a deploy of that commit, and saying so is the honest answer.

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 10_000;
const SHA = /^[0-9a-f]{7,40}$/i;

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
};

/**
 * `{ sha, dirty }` for the app at `dir`.
 *
 * `sha` is `HEAD`'s full id, or null when `dir` is not a git work tree (or git
 * is missing). `dirty` is true when the work tree has uncommitted changes
 * (untracked files included, which is what `git status --porcelain` reports),
 * null when git answered no status at all.
 */
export function sourceIdentity(dir) {
  const sha = git(dir, ['rev-parse', 'HEAD']);
  if (!sha || !SHA.test(sha)) return { sha: null, dirty: null };
  const status = git(dir, ['status', '--porcelain']);
  return { sha, dirty: status === null ? null : status.length > 0 };
}

/** The short form to print: `1b5710f` (+ `+dirty`), or `not recorded`. */
export function sourceLabel(source) {
  if (!source || !source.sha) return 'not recorded';
  const short = source.sha.slice(0, 7);
  return source.dirty ? `${short} (+uncommitted changes)` : short;
}