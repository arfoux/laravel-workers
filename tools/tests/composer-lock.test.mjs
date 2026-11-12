// tools/vendor-lite.mjs — the `--lock` writer: the file `composer validate` reads.
//
// `packages-dev` used to be written empty, so `composer validate` exited 2 on
// every Laravel skeleton — "Required (in require-dev) package ... is not present
// in the lock file" (audit #805 / S30). These pin the shape the writer emits now:
// the dev entries land in `packages-dev` with the same mapper as `packages`, and
// a require-dev name with no entry is reported back to the caller (and said out
// loud inside the lock) instead of passing silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeComposerLock, contentHashOf } from '../vendor-lite.mjs';

function app(json) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-composer-lock-'));
  writeFileSync(join(dir, 'composer.json'), JSON.stringify(json, null, 4) + '\n');
  return dir;
}

const entry = (name, version) => ({ name, version, type: 'library', require: {}, autoload: {} });

test('the dev set lands in packages-dev, the production set in packages', () => {
  const json = { require: { 'laravel/framework': '^12.0' }, 'require-dev': { 'laravel/pint': '^1.0' } };
  const dir = app(json);
  try {
    const { devRequires } = writeComposerLock(
      dir,
      [entry('laravel/framework', 'v12.0.0')],
      [entry('laravel/pint', 'v1.0.0')]
    );
    const lock = JSON.parse(readFileSync(join(dir, 'composer.lock'), 'utf8'));
    assert.deepEqual(lock.packages.map((p) => p.name), ['laravel/framework']);
    assert.deepEqual(lock['packages-dev'].map((p) => [p.name, p.version]), [['laravel/pint', 'v1.0.0']]);
    assert.equal(lock['content-hash'], contentHashOf(json));
    assert.deepEqual(devRequires, [], 'a pinned require-dev name is not reported as missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a require-dev name with no entry is reported, and named inside the lock', () => {
  const dir = app({ require: {}, 'require-dev': { 'laravel/pint': '^1.0', 'laravel/pail': '^1.0' } });
  try {
    const { devRequires } = writeComposerLock(dir, [], [entry('laravel/pint', 'v1.0.0')]);
    const lock = JSON.parse(readFileSync(join(dir, 'composer.lock'), 'utf8'));
    assert.deepEqual(devRequires, ['laravel/pail']);
    assert.deepEqual(lock['packages-dev'].map((p) => p.name), ['laravel/pint']);
    assert.ok(
      lock._readme.some((line) => line.includes('laravel/pail')),
      'the unpinned name is said out loud in the lock'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no dev entries the lock keeps the empty list and reports every name', () => {
  const dir = app({ require: {}, 'require-dev': { 'laravel/pint': '^1.0' } });
  try {
    const { devRequires } = writeComposerLock(dir, []);
    const lock = JSON.parse(readFileSync(join(dir, 'composer.lock'), 'utf8'));
    assert.deepEqual(lock['packages-dev'], []);
    assert.deepEqual(devRequires, ['laravel/pint']);
    assert.ok(lock._readme.some((line) => line.includes('laravel/pint')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
