// tools/tests/scratch-php-cache.test.mjs — S21: the provider list must follow
// `vendor/composer/installed.json`, not a frozen scratch artifact.
//
// Laravel's `PackageManifest::getManifest()` only rebuilds `packages.php` when the
// file is MISSING, so a package installed after the first build in a scratch dir
// would keep being ignored - the same app then builds green on one machine and red
// on a clean clone. The stamp is what makes the scratch caches follow the vendor
// tree; these tests pin the three cases that matter (identity moved, identity
// holds, and nothing to compare against).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VENDOR_IDENTITY_FILES, syncScratchPhpCache, vendorIdentityStamp } from '../scratch-php-cache.mjs';

/** A throwaway app: `<dir>/vendor/composer/installed.json` + a scratch php dir. */
function makeApp() {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-scratch-php-'));
  const phpCacheDir = join(appDir, '.cache', 'laravel-workers', 'php');
  mkdirSync(join(appDir, 'vendor', 'composer'), { recursive: true });
  mkdirSync(phpCacheDir, { recursive: true });
  const installed = (packages) =>
    writeFileSync(
      join(appDir, 'vendor', 'composer', 'installed.json'),
      JSON.stringify({ packages: packages.map((name) => ({ name })) })
    );
  installed(['laravel/framework']);
  writeFileSync(join(phpCacheDir, 'packages.php'), '<?php return [];');
  writeFileSync(join(phpCacheDir, 'services.php'), '<?php return [];');
  return { appDir, phpCacheDir, installed };
}

test('a package installed after the first build invalidates the scratch caches', () => {
  const { appDir, phpCacheDir, installed } = makeApp();
  try {
    // First build: nothing recorded yet, so the caches are dropped once and the
    // stamp written.
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), {
      invalidated: true,
      removed: ['packages.php', 'services.php'],
    });

    // Second build, same vendor tree: the caches survive, so the boot does not
    // pay a rebuild for nothing.
    writeFileSync(join(phpCacheDir, 'packages.php'), '<?php return [];');
    writeFileSync(join(phpCacheDir, 'services.php'), '<?php return [];');
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), { invalidated: false, removed: [] });
    assert.ok(existsSync(join(phpCacheDir, 'packages.php')));
    assert.ok(existsSync(join(phpCacheDir, 'services.php')));

    // `composer require livewire/livewire`: the frozen provider list is exactly
    // the bug - it must not survive.
    installed(['laravel/framework', 'livewire/livewire']);
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), {
      invalidated: true,
      removed: ['packages.php', 'services.php'],
    });
    assert.ok(!existsSync(join(phpCacheDir, 'packages.php')));

    // And now that Laravel rebuilt them from the new tree, they hold again.
    writeFileSync(join(phpCacheDir, 'packages.php'), '<?php return [];');
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), { invalidated: false, removed: [] });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('a LW_VENDOR_DIR tree is hashed where it actually lives', () => {
  const { appDir, phpCacheDir, installed } = makeApp();
  const vendorLite = join(appDir, 'vendor-lite');
  try {
    mkdirSync(join(vendorLite, 'composer'), { recursive: true });
    writeFileSync(join(vendorLite, 'composer', 'installed.json'), JSON.stringify({ packages: [{ name: 'laravel/framework' }] }));
    const before = vendorIdentityStamp({ appDir, vendorDir: vendorLite });
    // The app's own vendor/ must not matter when the build was pointed elsewhere.
    installed(['laravel/framework', 'something-else/only-in-app-vendor']);
    assert.equal(vendorIdentityStamp({ appDir, vendorDir: vendorLite }), before);

    syncScratchPhpCache({ appDir, vendorDir: vendorLite, phpCacheDir });
    writeFileSync(join(phpCacheDir, 'packages.php'), '<?php return [];');
    writeFileSync(join(vendorLite, 'composer', 'installed.json'), JSON.stringify({ packages: [{ name: 'laravel/framework' }, { name: 'new/pkg' }] }));
    assert.equal(syncScratchPhpCache({ appDir, vendorDir: vendorLite, phpCacheDir }).removed.length, 1);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('an app with no vendor tree is stable (no churn, no throw)', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'lw-scratch-php-'));
  const phpCacheDir = join(appDir, '.cache', 'laravel-workers', 'php');
  try {
    mkdirSync(phpCacheDir, { recursive: true });
    assert.equal(VENDOR_IDENTITY_FILES.length, 3);
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), { invalidated: true, removed: [] });
    // A missing vendor/ hashes to a constant: the next build is a no-op, and a
    // vendor tree that then appears is not.
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), { invalidated: false, removed: [] });
    assert.equal(
      vendorIdentityStamp({ appDir }),
      vendorIdentityStamp({ appDir }),
      'the stamp must be deterministic for an unchanged tree'
    );
    mkdirSync(join(appDir, 'vendor', 'composer'), { recursive: true });
    writeFileSync(join(appDir, 'vendor', 'composer', 'installed.json'), JSON.stringify({ packages: [] }));
    assert.deepEqual(syncScratchPhpCache({ appDir, phpCacheDir }), { invalidated: true, removed: [] });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});
