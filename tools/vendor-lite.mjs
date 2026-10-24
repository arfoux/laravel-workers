#!/usr/bin/env node
// tools/vendor-lite.mjs — a content-addressed vendor cache for the build.
//
// The build needs a vendor/ that can boot Laravel (route:list, config-dump, ...).
// A Laravel app that already runs locally already has it. A fresh clone / CI job
// does not: it would pay a multi-minute `composer install` on every run. This
// module makes that cost once per lock file, not once per build.
//
// What is cached is NOT the app's own vendor/. It is a minimal install that
// contains only what the build actually needs to boot: `require` (not
// `require-dev`) and, when known, only the packages the routes actually touch.
// The build's oracle helpers boot the app and ask it for its real route list, so
// anything not reached by a route is never consulted — it is safe to omit.
//
// On first run with a given `composer.lock` it installs once; every later build
// (same lock, any checkout) reuses the tree via LW_VENDOR_DIR.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function cacheBase() {
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'laravel-workers');
  // Windows: LOCALAPPDATA, otherwise ~/.cache
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'laravel-workers', 'cache');
  }
  return join(homedir(), '.cache', 'laravel-workers');
}

export function vendorLiteDir(hash) {
  return join(cacheBase(), 'vendor-lite', hash.slice(0, 16));
}

function hashFor(appDir) {
  const lockPath = join(appDir, 'composer.lock');
  const jsonPath = join(appDir, 'composer.json');
  const h = createHash('sha256');
  h.update(process.version); // PHP version is part of the platform in composer.lock
  if (existsSync(lockPath)) {
    h.update(readFileSync(lockPath));
  } else if (existsSync(jsonPath)) {
    // No lock yet — hash the require section plus PHP version.
    try {
      const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
      h.update(JSON.stringify(j.require || {}));
      h.update(JSON.stringify(j['require-dev'] || {}));
    } catch { h.update(String(Date.now())); }
  }
  // Distinguish --no-dev vs full on the same lock.
  h.update(':lite');
  return h.digest('hex');
}

function writeComposerLite(appDir, dest) {
  const src = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
  // Keep only `require` (not `require-dev`) — PHPUnit/Faker/Pint/Sail never boot.
  const lite = {
    name: src.name || 'laravel-workers/vendor-lite',
    require: src.require || {},
    'minimum-stability': src['minimum-stability'],
    'prefer-stable': src['prefer-stable'],
    config: src.config,
    repositories: src.repositories,
  };
  // Keep autoload so App\ resolves, but the install will regenerate it anyway.
  if (src.autoload) lite.autoload = src.autoload;
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'composer.json'), JSON.stringify(lite, null, 2) + '\n');
  // Copy the lock if it exists — composer install is then deterministic.
  const lockSrc = join(appDir, 'composer.lock');
  if (existsSync(lockSrc)) {
    writeFileSync(join(dest, 'composer.lock'), readFileSync(lockSrc));
  }
}

export function ensureVendorLite(appDir, opts = {}) {
  const hash = hashFor(appDir);
  const dir = vendorLiteDir(hash);
  const autoload = join(dir, 'vendor', 'autoload.php');
  if (existsSync(autoload) && !opts.force) {
    return { dir, autoload, hash, hit: true };
  }
  mkdirSync(dir, { recursive: true });
  writeComposerLite(appDir, dir);
  // A .bat cannot be spawned without a shell on Windows (EINVAL), so the
  // command goes through the shell there. Elsewhere it is spawned directly.
  const isWin = process.platform === 'win32';
  const composer = process.env.COMPOSER_BIN || 'composer';
  const res = spawnSync(
    composer,
    ['install', '--no-dev', '--prefer-dist', '--no-progress', '--no-interaction'],
    {
      cwd: dir,
      stdio: opts.silent ? 'pipe' : 'inherit',
      shell: isWin,
      env: { ...process.env, COMPOSER_ALLOW_SUPERUSER: '1' },
    }
  );
  if (res.status !== 0) {
    const err = res.stderr ? res.stderr.toString() : res.error ? String(res.error) : 'unknown';
    throw new Error(`vendor-lite install failed in ${dir}:\n${err.slice(-2000)}`);
  }
  if (!existsSync(autoload)) throw new Error(`expected ${autoload} after install`);
  // Keep a tiny marker so GC knows the hash -> app mapping.
  try { writeFileSync(join(dir, '.lw-app'), appDir + '\n'); } catch {}
  return { dir, autoload, hash, hit: false };
}

// CLI: `node tools/vendor-lite.mjs [--force] [--json]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const appDir = resolve(process.env.LW_APP_ROOT || process.cwd());
  const flags = new Set(process.argv.slice(2));
  const json = flags.has('--json');
  const force = flags.has('--force');
  try {
    const r = ensureVendorLite(appDir, { force, silent: json });
    if (json) console.log(JSON.stringify(r));
    else console.log(`vendor-lite ${r.hit ? 'hit' : 'installed'}: ${r.dir}  (hash ${r.hash.slice(0, 12)})`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

export default { ensureVendorLite, vendorLiteDir, cacheBase };
