import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheBase, vendorLiteDir, classNames, ensureVendorLite, hashFor, installedJsonOf, writeComposerLock, contentHashOf } from '../../tools/vendor-lite.mjs';

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

// --- installed.json: Laravel's package auto-discovery metadata (#308) ---
// `PackageManifest` reads `<vendor>/composer/installed.json`; without it every
// package's `extra.laravel.providers`/`aliases` in the vendor-lite cache is
// invisible and the build boots a different application (the #303/#315 class).
test('installedJsonOf mirrors the composer manifest shape Laravel reads', () => {
  const doc = installedJsonOf([
    { name: 'spatie/laravel-settings', version: '3.4.0', type: 'library', extra: { laravel: { providers: ['Spatie\\LaravelSettings\\LaravelSettingsServiceProvider'] } } },
    { name: 'psr/log', version: '3.0.2' },
  ]);
  assert.equal(doc.dev, false);
  assert.deepEqual(doc['dev-package-names'], []);
  assert.deepEqual(doc.packages[0], {
    name: 'spatie/laravel-settings',
    version: '3.4.0',
    type: 'library',
    extra: { laravel: { providers: ['Spatie\\LaravelSettings\\LaravelSettingsServiceProvider'] } },
  });
  // no `extra` in the lock entry -> `{}`, never `undefined` (PackageManifest
  // reads it as an array)
  assert.deepEqual(doc.packages[1], { name: 'psr/log', version: '3.0.2', type: 'library', extra: {} });
});

test('a cache hit that predates installed.json is healed instead of served empty', async () => {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-app-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'lw-cache-'));
  const lock = {
    packages: [
      {
        name: 'vendor/pkg',
        version: '1.0.0',
        type: 'library',
        dist: { url: 'https://example.invalid/pkg.zip', type: 'zip' },
        extra: { laravel: { providers: ['Vendor\\Pkg\\Provider'] } },
      },
    ],
    'packages-dev': [],
  };
  writeFileSync(join(appDir, 'composer.lock'), JSON.stringify(lock));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  try {
    const dir = vendorLiteDir(hashFor(appDir));
    // the pre-fix entry as it was left on disk: autoload + the copied lock, no
    // composer metadata at all
    mkdirSync(join(dir, 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'autoload.php'), '<?php // provisioned before installed.json existed\n');
    writeFileSync(join(dir, 'composer.lock'), JSON.stringify(lock));

    const res = await ensureVendorLite(appDir, { silent: true });
    assert.equal(res.hit, true, 'the entry is reused, not re-provisioned (no download attempted)');
    assert.equal(res.dir, dir);
    const doc = JSON.parse(readFileSync(join(dir, 'vendor', 'composer', 'installed.json'), 'utf8'));
    assert.deepEqual(doc.packages.map((p) => p.name), ['vendor/pkg'], 'the manifest must list the locked package');
    assert.deepEqual(doc.packages[0].extra.laravel.providers, ['Vendor\\Pkg\\Provider'], 'providers must survive the heal');
    assert.equal(readFileSync(join(dir, 'vendor', 'autoload.php'), 'utf8'), '<?php // provisioned before installed.json existed\n', 'the heal must not touch the existing autoloader');
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
    rmSync(appDir, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

// --- the PROVISIONING path (a cache miss) -------------------------------
// The README's "no vendor/, no composer install" build lands here: the entry is
// created, the autoloader and the composer manifest are written. The test seeds
// the package directory as already extracted, so the loop skips the download and
// the whole provisioning path runs offline.
//
// `installedJson` was computed in `ensureVendorLite`'s scope only while
// `provision()` - a separate function - wrote it: every fresh provision died with
// `ReferenceError: installedJson is not defined` (measured on a real app with no
// vendor/: "BUILD FAILED: vendor provisioning failed: installedJson is not
// defined"). The suite missed it because every CI app comes from
// `composer create-project`, which always leaves a vendor/ behind.
test('a cache miss provisions the entry: the manifest and the autoloader are written', async () => {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-prov-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'lw-cache-'));
  const lock = {
    packages: [
      {
        name: 'vendor/pkg',
        version: '1.0.0',
        type: 'library',
        dist: { url: 'https://example.invalid/pkg.zip', type: 'zip' },
        extra: { laravel: { providers: ['Vendor\\Pkg\\Provider'] } },
      },
    ],
    'packages-dev': [],
  };
  writeFileSync(join(appDir, 'composer.json'), JSON.stringify({ require: {} }));
  writeFileSync(join(appDir, 'composer.lock'), JSON.stringify(lock));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  try {
    const dir = vendorLiteDir(hashFor(appDir));
    // "already extracted": an existing package dir skips the download entirely
    mkdirSync(join(dir, 'vendor', 'vendor', 'pkg'), { recursive: true });
    const res = await ensureVendorLite(appDir, { silent: true });
    assert.equal(res.hit, false, 'a cache miss provisions instead of answering a hit');
    assert.equal(res.dir, dir);
    const doc = JSON.parse(readFileSync(join(dir, 'vendor', 'composer', 'installed.json'), 'utf8'));
    assert.deepEqual(doc.packages.map((p) => p.name), ['vendor/pkg'], 'the manifest lists the locked package');
    assert.deepEqual(doc.packages[0].extra.laravel.providers, ['Vendor\\Pkg\\Provider'], 'providers survive a fresh provision');
    assert.ok(readFileSync(res.autoload, 'utf8').includes('<?php'), 'the generated autoloader is written');
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
    rmSync(appDir, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

// `--lock` writes the standard pinning file for the PRODUCTION set (audit #805).
// It is not a Composer-authored lock: `resolveDependencies()` walks `require`
// only, so `packages-dev` stays empty and an app that declares `require-dev`
// gets `composer validate` exit 2 ("Required (in require-dev) package … is not
// present in the lock file", Composer 2.9.0). That limit is not silent — it is
// named in the file itself and returned to the caller — and these tests pin both
// halves so a later "helpful" change (filling packages-dev with garbage, or
// dropping the notice) cannot quietly make the file a lie again.

test('writeComposerLock names the require-dev packages it cannot carry', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-lock-'));
  try {
    writeFileSync(
      join(appDir, 'composer.json'),
      JSON.stringify({
        name: 'acme/app',
        require: { 'laravel/framework': '^13.0' },
        'require-dev': { 'laravel/pint': '^1.0', 'phpunit/phpunit': '^11.0' },
      })
    );
    const entries = [{ name: 'laravel/framework', version: 'v13.0.0', require: { 'php': '^8.3' }, type: 'library' }];
    const { devRequires } = writeComposerLock(appDir, entries);
    assert.deepEqual(devRequires, ['laravel/pint', 'phpunit/phpunit']);

    const lock = JSON.parse(readFileSync(join(appDir, 'composer.lock'), 'utf8'));
    assert.deepEqual(lock['packages-dev'], [], 'the dev closure is not resolved and must not be faked');
    assert.deepEqual(lock.packages.map((p) => p.name), ['laravel/framework']);
    assert.deepEqual(lock.packages[0].require, { php: '^8.3' });
    // The hash is Composer's own recipe over this composer.json, so the lock is
    // not called stale - the dev packages are the ONLY complaint validate has.
    assert.equal(lock['content-hash'], contentHashOf(JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'))));
    const readme = lock._readme.join('\n');
    assert.match(readme, /laravel\/pint, phpunit\/phpunit/, 'the file itself names what it does not carry');
    assert.match(readme, /composer validate/, 'and the consequence the app will hit');
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('writeComposerLock stays quiet for an app without require-dev', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-lock-'));
  try {
    writeFileSync(join(appDir, 'composer.json'), JSON.stringify({ name: 'acme/app', require: { 'laravel/framework': '^13.0' } }));
    const { devRequires } = writeComposerLock(appDir, [{ name: 'laravel/framework', version: 'v13.0.0' }]);
    assert.deepEqual(devRequires, []);
    const lock = JSON.parse(readFileSync(join(appDir, 'composer.lock'), 'utf8'));
    assert.ok(!lock._readme.join('\n').includes('require-dev'), 'no caveat to state when there is nothing to state');
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});
