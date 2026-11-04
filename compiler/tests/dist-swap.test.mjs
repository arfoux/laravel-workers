// compiler/tests/dist-swap.test.mjs — the build's output is swapped in whole.
//
// The build writes into `<dist>.building` and commits only after its last
// check passed. Two things must hold, and both shipped broken once:
//
//   1. a FAILED build leaves the previous `dist/` byte-identical (an operator
//      must never be able to deploy a half-written artifact), and
//   2. a SUCCESSFUL build replaces it completely - no stale file survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitDist, discardStaging } from '../src/dist-swap.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-swap-'));
  const final = join(dir, 'dist');
  const staging = final + '.building';
  return { dir, final, staging, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const write = (root, name, body) => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', name), body);
};
const files = (root) => readdirSync(join(root, 'src')).sort();

test('dist-swap: a committed build replaces the previous one completely', () => {
  const s = sandbox();
  try {
    write(s.final, 'stale.generated.mjs', 'old');
    write(s.staging, 'classes.generated.mjs', 'new');
    commitDist(s.staging, s.final);
    // The stale artifact is GONE: a file the new build did not emit must not
    // survive (a `dist` mixing two builds is what an operator deploys by
    // accident).
    assert.deepEqual(files(s.final), ['classes.generated.mjs']);
    assert.equal(readFileSync(join(s.final, 'src', 'classes.generated.mjs'), 'utf8'), 'new');
    // The staging directory moved; it is not left behind.
    assert.deepEqual(readdirSync(s.dir), ['dist']);
  } finally {
    s.done();
  }
});

test('dist-swap: a fresh build (no previous dist) lands in place', () => {
  const s = sandbox();
  try {
    write(s.staging, 'models.generated.mjs', 'first');
    commitDist(s.staging, s.final);
    assert.deepEqual(files(s.final), ['models.generated.mjs']);
    assert.deepEqual(readdirSync(s.dir), ['dist']);
  } finally {
    s.done();
  }
});

test('dist-swap: a discarded build leaves the previous dist byte-identical', () => {
  const s = sandbox();
  try {
    write(s.final, 'classes.generated.mjs', 'the last good build');
    write(s.staging, 'classes.generated.mjs', 'half-written');
    write(s.staging, 'policies.generated.mjs', 'half-written');
    discardStaging(s.staging);
    // This is the invariant: the failed build must not touch what is deployed.
    assert.deepEqual(files(s.final), ['classes.generated.mjs']);
    assert.equal(readFileSync(join(s.final, 'src', 'classes.generated.mjs'), 'utf8'), 'the last good build');
    assert.deepEqual(readdirSync(s.dir), ['dist']);
  } finally {
    s.done();
  }
});

test('dist-swap: a failed swap puts the previous dist back', () => {
  const s = sandbox();
  try {
    write(s.final, 'classes.generated.mjs', 'the last good build');
    // `staging === final`: the move-aside succeeds and the landing can never
    // follow (its source was just renamed away). That is the window the restore
    // covers - the worker must not be left without a `dist/`.
    assert.throws(() => commitDist(s.final, s.final), /the previous build was restored/);
    assert.equal(readFileSync(join(s.final, 'src', 'classes.generated.mjs'), 'utf8'), 'the last good build');
    // Nothing is left renamed aside under `dist.old-*`.
    assert.deepEqual(readdirSync(s.dir), ['dist']);
  } finally {
    s.done();
  }
});

test('dist-swap: a locked previous dist is never deleted (#734)', () => {
  const s = sandbox();
  const realNow = Date.now;
  try {
    write(s.final, 'classes.generated.mjs', 'the last good build');
    write(s.staging, 'classes.generated.mjs', 'the new build');
    // Force a genuine move-aside failure: `previous` is the timestamped name
    // commitDist computes, and renaming a directory ONTO a non-empty directory
    // fails (EPERM on Windows, ENOTEMPTY elsewhere) - the same shape as the
    // Windows "a process holds a handle on dist/" case that shipped the bug.
    Date.now = () => 1700000000000;
    const previous = s.final + '.old-1700000000000';
    write(previous, 'leftover.generated.mjs', 'a stale dist.old-* the sweep has not reached yet');
    // The swap must REFUSE instead of wiping `dist/` in place: deleting it is
    // the only way to continue, and the landing rename then fails on the same
    // lock - leaving the app with the locked leftovers and no `worker.mjs`.
    assert.throws(() => commitDist(s.staging, s.final), /left untouched/);
    // Neither side is lost: the old build is byte-identical on disk and the
    // finished build is still there under its staging name.
    assert.equal(readFileSync(join(s.final, 'src', 'classes.generated.mjs'), 'utf8'), 'the last good build');
    assert.equal(readFileSync(join(s.staging, 'src', 'classes.generated.mjs'), 'utf8'), 'the new build');
  } finally {
    Date.now = realNow;
    s.done();
  }
});
