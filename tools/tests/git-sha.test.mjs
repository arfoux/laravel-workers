// tools/tests/git-sha.test.mjs — the source identity provenance is built on.
//
// The rule that matters: it never invents a commit. Outside a work tree (or with
// git absent) the answer is null and every surface says "not recorded", because a
// fabricated SHA in `lw-state.json` would be worse than no answer at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceIdentity, sourceLabel } from '../git-sha.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test('git-sha: a work tree reports HEAD, and uncommitted work is flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-git-sha-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'lw@example.test');
    git(dir, 'config', 'user.name', 'lw');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'first');
    const head = git(dir, 'rev-parse', 'HEAD');

    const clean = sourceIdentity(dir);
    assert.deepEqual(clean, { sha: head, dirty: false });
    assert.equal(sourceLabel(clean), head.slice(0, 7));

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const dirty = sourceIdentity(dir);
    assert.equal(dirty.sha, head);
    assert.equal(dirty.dirty, true);
    assert.match(sourceLabel(dirty), /\+uncommitted changes\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git-sha: outside a repository it answers null instead of inventing a commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-git-none-'));
  try {
    assert.deepEqual(sourceIdentity(dir), { sha: null, dirty: null });
    assert.equal(sourceLabel(sourceIdentity(dir)), 'not recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});