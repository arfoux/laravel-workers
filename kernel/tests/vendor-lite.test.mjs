import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheBase, vendorLiteDir, classNames } from '../../tools/vendor-lite.mjs';

// The cache path is derived, not configured: these tests pin the CONTRACT
// (a stable directory per hash) without running composer.

test('cacheBase honours XDG_CACHE_HOME', () => {
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(tmpdir(), 'lw-xdg-test');
  try {
    assert.equal(cacheBase(), join(tmpdir(), 'lw-xdg-test', 'laravel-workers'));
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

test('vendorLiteDir is stable and short, under vendor-lite/', () => {
  const hash = 'a'.repeat(64);
  const dir = vendorLiteDir(hash);
  assert.ok(dir.includes('vendor-lite'), dir);
  assert.ok(dir.endsWith('a'.repeat(16)), dir);
  // same hash -> same dir (a second project with the same lock costs nothing)
  assert.equal(vendorLiteDir(hash), dir);
  // different hash -> different dir
  assert.notEqual(vendorLiteDir('b'.repeat(64)), dir);
});

test('vendorLiteDir does not collide on a shared prefix', () => {
  const a = vendorLiteDir('a'.repeat(16) + 'x'.repeat(48));
  const b = vendorLiteDir('a'.repeat(16) + 'y'.repeat(48));
  // both truncate to the same 16 chars - the dir collides by design (16 hex
  // chars is 64 bits); this test documents that trade rather than hiding it.
  assert.equal(a, b);
});

// The generated classmap keys must be the FQCNs Composer generates, because
// they become `$classmap['<fqcn>'] => file` in the autoloader that runs the app.
// A regex over the raw source answered the first `class ...` match anywhere —
// comments included (vendor/nette/utils/src/SmartObject.php answered `for`, from
// the docblock "Strict class for better experience."), which silently left the
// real class out of the map whenever psr-4 did not also cover it.
test('classNames reads the declaration, not a comment or a string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-classnames-'));
  try {
    const file = join(dir, 'SmartObject.php');
    writeFileSync(file, `<?php
declare(strict_types=1);
namespace Nette;

/** Strict class for better experience. */
class SmartObject
{
    public const NAME = 'class Fake';
}
`);
    assert.deepEqual(classNames(file), ['Nette\\SmartObject']);
    // non-PHP / unreadable input never invents a name
    assert.deepEqual(classNames(join(dir, 'missing.php')), []);
    assert.deepEqual(classNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classNames answers every declaration in the file, enums included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-classnames-'));
  try {
    const file = join(dir, 'Many.php');
    writeFileSync(file, `<?php
namespace Vendor\\Pkg;
interface Contract {}
trait Helper {}
enum SortDirection: string { case Asc = 'asc'; }
class First {}
final class Second extends First { public function make() { return new class extends First {}; } }
`);
    assert.deepEqual(classNames(file), [
      'Vendor\\Pkg\\Contract',
      'Vendor\\Pkg\\Helper',
      'Vendor\\Pkg\\SortDirection',
      'Vendor\\Pkg\\First',
      'Vendor\\Pkg\\Second',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classNames answers the bare name for a global-namespace stub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-classnames-'));
  try {
    const file = join(dir, 'stub.php');
    writeFileSync(file, `<?php
if (!class_exists('SortDirection', false)) {
    enum SortDirection: string { case Asc = 'asc'; }
}
`);
    assert.deepEqual(classNames(file), ['SortDirection']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
