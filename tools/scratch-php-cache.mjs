// tools/scratch-php-cache.mjs — keep the build's scratch PHP caches honest.
//
// Laravel rebuilds the compiled package manifest ONLY when the file is missing:
// `PackageManifest::getManifest()` is
//
//   if (! is_null($this->manifest)) {
//       return $this->manifest;
//   }
//   if (! is_file($this->manifestPath)) {
//       $this->build();
//   }
//   return $this->manifest = is_file($this->manifestPath) ?
//       $this->files->getRequire($this->manifestPath) : [];
//
// (`vendor/laravel/framework/src/Illuminate/Foundation/PackageManifest.php:101-113` —
// re-read against framework 13.37; the `?: $this->build()` one-liner this
// comment used to quote is not the shape the vendor tree carries any longer)
// and the compiled services cache is written the same way. The build keeps both
// inside its scratch dir (`APP_PACKAGES_CACHE`/`APP_SERVICES_CACHE`, build.mjs
// `childEnv()`) so that a developer's `bootstrap/cache/*.php` cannot poison the
// boot - which means the provider list every PHP child boots is decided by an
// artifact of the FIRST build in that scratch dir, not by
// `vendor/composer/installed.json`.
//
// That makes the same app build differently on two machines: install a package
// after a build and the old provider list keeps booting (the new provider's
// bindings, route files, Blade directives and compiler hooks are all silently
// absent), while a clean clone of the same sources builds with them.
//
// Measured on a real app: `livewire/livewire` entered `composer/installed.json`
// on 2026-11-09 while the scratch `packages.php` stayed frozen at 2026-11-05 - six
// providers, no Livewire. The app built green on that machine (`coverage: all 96
// route(s)`), and the identical sources refused 25 views (13 `LW003`) as soon as
// the manifest came from a manifest built with Livewire in the list.
//
// The fix is the smallest one that cannot be stale: hash Composer's identity
// files (the same three `tools/build-cache.mjs` hashes) into a stamp beside the
// caches, and drop `packages.php`/`services.php` whenever the stamp moved, so the
// next boot rebuilds them from the vendor tree that is actually installed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Composer's identity for a vendor tree - not the whole tree's bytes. */
export const VENDOR_IDENTITY_FILES = ['composer/installed.php', 'composer/installed.json', 'autoload.php'];

/** The scratch files dropped when the identity moves, and the stamp recording it. */
const SCRATCH_FILES = ['packages.php', 'services.php'];
const STAMP_FILE = 'vendor-identity.stamp';

/**
 * The vendor roots to look in, in order: an explicit `LW_VENDOR_DIR` (which may
 * itself be a vendor dir or a directory holding one), else the app's `vendor/`.
 */
function vendorRoots(appDir, vendorDir) {
  return vendorDir ? [vendorDir, join(vendorDir, 'vendor')] : [join(appDir, 'vendor')];
}

/**
 * A stamp over every identity file we can see. A missing `vendor/` hashes to a
 * constant, so a tree that never had one does not invalidate on every build; one
 * that appears (or changes) does.
 */
export function vendorIdentityStamp({ appDir, vendorDir = null }) {
  const h = createHash('sha256');
  for (const root of vendorRoots(appDir, vendorDir)) {
    for (const file of VENDOR_IDENTITY_FILES) {
      const abs = join(root, file);
      h.update(relative(appDir, abs).split('\\').join('/'))
        .update('\0')
        .update(existsSync(abs) ? readFileSync(abs) : 'missing')
        .update('\0');
    }
  }
  return h.digest('hex');
}

/**
 * Drop the scratch PHP caches when the vendor identity they were built from has
 * moved on.
 *
 * @returns {{ invalidated: boolean, removed: string[] }} whether the caches were
 *   dropped, and which ones existed to be dropped.
 */
export function syncScratchPhpCache({ appDir, vendorDir = null, phpCacheDir }) {
  const stamp = vendorIdentityStamp({ appDir, vendorDir });
  const stampPath = join(phpCacheDir, STAMP_FILE);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp) {
    return { invalidated: false, removed: [] };
  }
  const removed = [];
  for (const name of SCRATCH_FILES) {
    const file = join(phpCacheDir, name);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed.push(name);
  }
  writeFileSync(stampPath, stamp);
  return { invalidated: true, removed };
}
