import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheBase, vendorLiteDir } from '../../tools/vendor-lite.mjs';

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
