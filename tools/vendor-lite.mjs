#!/usr/bin/env node
// tools/vendor-lite.mjs — a content-addressed, composer-free vendor cache for the build.
//
// The build needs a vendor/ that can boot Laravel (route:list, config-dump, ...).
// A Laravel app that already runs locally already has it. A fresh clone / CI job
// does not: it would pay a multi-minute `composer install` on every run. This
// module makes that cost once per lock file, not once per build — and now without
// ever invoking composer: it reads composer.lock, fetches each needed package's
// dist zip straight from its URL, extracts it, and writes a small self-contained
// PSR-4/classmap/files autoloader. No composer, no composer-generated metadata.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDependencies } from './composer-resolve.mjs';
import { extractZip as extractZipJs } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// MSYS2/Git Bash passes POSIX-style paths ("/c/Users/...") that Node's fs APIs
// on Windows resolve as "<cwd-drive>:\c\Users\..." — normalize them to real
// Windows drive paths before any fs call touches them.
function toNativePath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string') return p;
  let s = p.replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])(?:\/|$)/);
  if (m) s = `${m[1].toUpperCase()}:/${s.slice(3)}`;
  return resolve(s);
}

export function cacheBase() {
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'laravel-workers');
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
  h.update(process.version);
  if (existsSync(lockPath)) {
    h.update(readFileSync(lockPath));
  } else if (existsSync(jsonPath)) {
    try {
      // Lockless hash input = everything that steers resolution: require,
      // stability flags, repositories. (require-dev is never provisioned, so
      // it cannot change the set — no refetch on unrelated edits.)
      const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
      h.update(JSON.stringify(j.require || {}));
      h.update(
        JSON.stringify({
          minimumStability: j['minimum-stability'] || 'stable',
          preferStable: j['prefer-stable'] ?? null,
          repositories: j.repositories || null,
        })
      );
    } catch { h.update(String(Date.now())); }
  }
  h.update(':lite');
  return h.digest('hex');
}

function writeComposerLite(appDir, dest) {
  const src = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
  const lite = {
    name: src.name || 'laravel-workers/vendor-lite',
    require: src.require || {},
    'minimum-stability': src['minimum-stability'],
    'prefer-stable': src['prefer-stable'],
    config: src.config,
    repositories: src.repositories,
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'composer.json'), JSON.stringify(lite, null, 2) + '\n');
  const lockSrc = join(appDir, 'composer.lock');
  if (existsSync(lockSrc)) writeFileSync(join(dest, 'composer.lock'), readFileSync(lockSrc));
}

function readLockPackages(appDir) {
  const lock = JSON.parse(readFileSync(join(appDir, 'composer.lock'), 'utf8'));
  const list = Array.isArray(lock.packages) ? lock.packages : [];
  const out = [];
  for (const p of list) {
    const name = String(p.name || '');
    const idx = name.lastIndexOf('/');
    const vendor = idx >= 0 ? name.slice(0, idx) : 'vendor';
    const pkg = idx >= 0 ? name.slice(idx + 1) : name;
    out.push({
      name,
      vendor,
      pkg,
      version: String(p.version || ''),
      url: (p.dist && p.dist.url) || null,
      shasum: (p.dist && p.dist.shasum) || null,
      source: (p.source && p.source.url) || null,
      autoload: p.autoload || {},
      pkgdir: join('vendor', vendor, pkg),
    });
  }
  return out;
}

function run(cmd, args, extra) {
  return spawnSync(cmd, args, { stdio: 'pipe', ...(extra || {}) });
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); }
  }
}

function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'lw-vendor-zip-'));
  // The built-in reader runs first: a clean Windows box has no `unzip`, and
  // provisioning a vendor tree must not depend on one. The system binary is the
  // fallback for archives the reader refuses (ZIP64, another method); when both
  // fail the error names the reader's own reason (and whether `unzip` exists).
  try {
    extractZipJs(zipPath, tmp);
  } catch (e) {
    // Fallback chain: `unzip` (POSIX), then `tar` — bsdtar ships on a clean
    // Windows 10+ box and reads ZIP (incl. ZIP64), so a reader refusal never
    // strands vendor provisioning on a machine without `unzip`.
    const fails = [];
    let ok = false;
    for (const [cmd, args] of [
      ['unzip', ['-o', zipPath, '-d', tmp]],
      ['tar', ['-xf', zipPath, '-C', tmp]],
    ]) {
      const r = run(cmd, args, {});
      if (!r.error && r.status === 0) { ok = true; break; }
      fails.push(r.error ? `${cmd} (${r.error.code})` : `${cmd}: ${String(r.stderr || '').trim().slice(0, 200)}`);
    }
    if (!ok) {
      throw new Error(
        'the package zip could not be extracted: ' + e.message +
          ' (no system extractor worked: ' + fails.join('; ') + ')'
      );
    }
  }
  const top = readdirSync(tmp);
  const srcDir = join(tmp, top[0]);
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, e.name);
    const d = join(destDir, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); }
  }
  rmSync(tmp, { recursive: true, force: true });
}

async function downloadFile(url, out, expectSha, label) {
  // Real failures observed: HTTP 403/429 rate limits from api.github.com,
  // transient transport errors after ~60 zipballs ("fetch failed" with NO url
  // in the message), and bytes that do not match the lock. Name the package,
  // retry the recoverable ones, verify when the lock carries a shasum — the
  // code below becomes executed PHP, so a mismatched payload must never load.
  const attempts = 3;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'laravel-workers/vendor-lite' } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (expectSha) {
          const want = String(expectSha).toLowerCase();
          const got = /^[0-9a-f]{40}$/.test(want)
            ? createHash('sha1').update(buf).digest('hex')
            : createHash('sha256').update(buf).digest('hex');
          if (got !== want) {
            throw new Error(
              `${label || 'package'}: checksum mismatch for ${url} (lock says ${want}, got ${got}) — refusing the bytes`
            );
          }
        }
        writeFileSync(out, buf);
        return;
      }
      lastErr = new Error(`${label || 'package'}: HTTP ${res.status} fetching ${url}`);
      if (res.status !== 429 && res.status < 500) break; // 404/403 will not heal
    } catch (e) {
      if (String(e.message).includes('checksum mismatch')) { lastErr = e; break; } // never retry a bad payload
      lastErr = new Error(`${label || 'package'}: ${e.cause?.code || e.message} fetching ${url}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 700 * i));
  }
  throw new Error(`vendor fetch failed after ${attempts} attempt(s): ${lastErr ? lastErr.message : url}`);
}

function phpStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function fqcnOf(filePath) {
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return null;
  const src = readFileSync(filePath, 'utf8');
  // Match class, interface, trait, or enum (PHP 8.1+ enums like SortDirection)
  const m = src.match(/(?:class|interface|trait|enum)\s+([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function buildAutoloadPhp(entries, appDir, rootDir) {
  // Merge vendor package autoload entries + the app's own autoload (paths resolve against appDir,
  // NOT against rootDir — the app has no source under the vendor-lite cache).
  const appJson = existsSync(join(appDir, 'composer.json')) ? JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8')) : {};
  const appAl = appJson.autoload || {};
  const psr4 = [];
  const classmap = [];
  const files = [];
  for (const e of entries) {
    const al = e.autoload || {};
    if (al['psr-4']) {
      for (const [prefix, dirs] of Object.entries(al['psr-4'])) {
        const list = Array.isArray(dirs) ? dirs : [dirs];
        for (const d of list) psr4.push({ prefix, dir: join(rootDir, e.pkgdir, String(d)) });
      }
    }
    if (al['classmap']) {
      for (const f of al['classmap']) {
        const full = join(rootDir, e.pkgdir, String(f));
        // Classmap entries may list a folder (e.g. symfony/polyfill-php86's
        // Resources/stubs holding the global SortDirection enum) — walk it for
        // *.php instead of skipping, else those classes never autoload.
        if (existsSync(full) && statSync(full).isDirectory()) {
          const stack = [full];
          while (stack.length) {
            const cur = stack.pop();
            for (const ent of readdirSync(cur, { withFileTypes: true })) {
              const p = join(cur, ent.name);
              if (ent.isDirectory()) stack.push(p);
              else if (ent.isFile() && p.endsWith('.php')) {
                const fq = fqcnOf(p);
                if (fq) classmap.push({ fq, file: p });
              }
            }
          }
          continue;
        }
        const fq = fqcnOf(full);
        if (fq) classmap.push({ fq, file: full });
      }
    }
    if (al['files']) {
      for (const f of al['files']) files.push(join(rootDir, e.pkgdir, String(f)));
    }
  }
  // App-own entries: resolve paths relative to appDir, skip App\ (registered by lw_boot_app).
  if (appAl['psr-4']) {
    for (const [prefix, dirs] of Object.entries(appAl['psr-4'])) {
      if (prefix === 'App\\' || prefix === 'App') continue;
      const list = Array.isArray(dirs) ? dirs : [dirs];
      for (const d of list) psr4.push({ prefix, dir: join(appDir, String(d)) });
    }
  }
  if (appAl['classmap']) {
    for (const f of appAl['classmap']) {
      const full = join(appDir, String(f));
      const fq = fqcnOf(full);
      if (fq) classmap.push({ fq, file: full });
    }
  }
  if (appAl['files']) {
    for (const f of appAl['files']) files.push(join(appDir, String(f)));
  }
  const lines = [];
  // NOTE: emit as a LIST of [prefix, dir] pairs — multiple dirs can share one
  // prefix (e.g. laravel/framework's Illuminate\Support\) and a PHP hash would
  // silently collapse them to the last entry.
  for (const p of psr4) lines.push(`    array(${phpStr(p.prefix)}, ${phpStr(p.dir)}),`);
  const psr4Src = lines.length ? 'array(\n' + lines.join('\n') + '\n    )' : 'array()';
  const clLines = classmap.map(c => `    ${phpStr(c.fq)} => ${phpStr(c.file)},`);
  const classmapSrc = clLines.length ? 'array(\n' + clLines.join('\n') + '\n    )' : 'array()';
  const fileLines = files.map(f => `    ${phpStr(f)},`);
  const filesSrc = fileLines.length ? 'array(\n' + fileLines.join('\n') + '\n    )' : 'array()';
  return `<?php
// Generated by laravel-workers vendor-lite (composer-free installer). Do not edit.

// Compat: the namespaced Pdo\\Mysql class only exists on PHP >= 8.4. Framework
// configs (laravel/framework 13) reference it unguarded; alias the legacy PDO
// constants so apps can boot on PHP 8.3.
if (PHP_VERSION_ID < 80400 && !class_exists('Pdo\\\\Mysql', false)) {
    // 8.4 moved the MySQL driver constants into a namespaced Pdo\\Mysql class
    // and renamed MYSQL_ATTR_SSL_CA -> ATTR_SSL_CA. Framework 13 configs
    // reference the new names unguarded; provide a stub on PHP 8.3.
    eval('namespace Pdo; class Mysql { const ATTR_SSL_CA = 1009; }'); // 1009 = legacy PDO::MYSQL_ATTR_SSL_CA
}

$psr4 = ${psr4Src};
$classmap = ${classmapSrc};
$files = ${filesSrc};

spl_autoload_register(function ($class) use (&$psr4, &$classmap, &$files) {
    if (isset($classmap[$class])) { require_once $classmap[$class]; return true; }
    foreach ($psr4 as $pair) { $prefix = $pair[0]; $dir = $pair[1];
        $len = strlen($prefix);
        if (strncmp($class, $prefix, $len) !== 0) { continue; }
        $rest = substr($class, $len);
        if ($rest !== '' && $rest[0] === chr(92)) { $rest = substr($rest, 1); }
        if ($rest === '') { continue; }
        $file = $dir . '/' . str_replace(chr(92), '/', $rest) . '.php';
        if (is_file($file)) { require $file; return true; }
    }
    return false;
});
foreach ($files as $f) { if (is_file($f)) { require_once $f; } }
return true;
`;
}

// --- composer.lock writer (`--lock`) -------------------------------------
// Turns a resolved-from-json set into the standard pinning file, so the next
// build reads a lock like any other composer project and CI stops hitting
// packagist. content-hash follows composer's own recipe — md5 of a ksorted
// subset of composer.json encoded with php json_encode semantics (slashes and
// non-ASCII escaped) — so `composer validate` stays green for teams that do
// run composer.

const STABILITY_FLAG_RANK = { dev: 1, alpha: 2, beta: 3, rc: 4, stable: 0 };

export function contentHashOf(root) {
  const relevant = {};
  for (const k of ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide', 'minimum-stability', 'prefer-stable', 'repositories', 'extra']) {
    if (k in root) relevant[k] = root[k];
  }
  if (root.config && root.config.platform) relevant.config = { platform: root.config.platform };
  const sorted = {};
  for (const k of Object.keys(relevant).sort()) sorted[k] = relevant[k];
  const phpJson = JSON.stringify(sorted)
    .replace(/[^\x20-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/\//g, '\\/');
  return createHash('md5').update(phpJson).digest('hex');
}

export function writeComposerLock(appDir, entries) {
  const root = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
  const stabilityFlags = {};
  for (const [n, c] of Object.entries({ ...(root.require || {}), ...(root['require-dev'] || {}) })) {
    const m = String(c).match(/@(stable|dev|alpha|beta|RC)$/i);
    if (m) stabilityFlags[n] = STABILITY_FLAG_RANK[m[1].toLowerCase()] ?? 1;
  }
  const doc = {
    _readme: [
      'Generated by laravel-workers vendor-lite --lock from a composer.json-only resolution.',
      'Pins the package set so builds are reproducible with no composer involved.',
      'Regenerate with `composer update` if you would rather composer own this file.',
    ],
    'content-hash': contentHashOf(root),
    packages: entries.map((e) => ({
      name: e.name,
      version: e.version,
      ...(e.source ? { source: { type: 'git', url: e.source, reference: e.reference || '' } } : {}),
      ...(e.url ? { dist: { type: 'zip', url: e.url, reference: e.reference || '', shasum: e.shasum || '' } } : {}),
      require: e.require || {},
      type: e.type || 'library',
      autoload: e.autoload || {},
      ...(e.replace && Object.keys(e.replace).length ? { replace: e.replace } : {}),
      ...(e.provide && Object.keys(e.provide).length ? { provide: e.provide } : {}),
    })),
    'packages-dev': [],
    'stability-flags': stabilityFlags,
    'prefer-stable': root['prefer-stable'] === true,
    'prefer-lowest': false,
    platform: (root.config && root.config.platform) || [],
    'platform-dev': [],
    'plugin-api-version': '2.6.0',
  };
  writeFileSync(join(appDir, 'composer.lock'), JSON.stringify(doc, null, 4) + '\n');
}

export async function ensureVendorLite(appDir, opts = {}) {
  appDir = toNativePath(appDir);
  const hash = hashFor(appDir);
  const dir = vendorLiteDir(hash);
  const autoload = join(dir, 'vendor', 'autoload.php');
  if (existsSync(autoload) && !opts.force) {
    return { dir, autoload, hash, hit: true };
  }
  const hasLock = existsSync(join(appDir, 'composer.lock'));
  if (!hasLock && !existsSync(join(appDir, 'composer.json'))) {
    throw new Error(`vendor-lite: ${appDir} contains neither composer.lock nor composer.json — nothing to install`);
  }
  mkdirSync(dir, { recursive: true });
  writeComposerLite(appDir, dir);
  // With a lock: read it verbatim (pinned set). Without one — the stock
  // laravel/laravel skeleton ships no lock — resolve composer.json against
  // packagist.org right here; same entry shape, same download path below.
  const entries = hasLock ? readLockPackages(appDir) : await resolveDependencies(appDir, opts);
  const destRoot = dir; // <dir>/vendor/<vendor>/<pkg> lives directly under dir
  for (const e of entries) {
    if (e.type === 'metapackage') continue; // virtual: declares requirements, ships no files
    const pkgDir = join(destRoot, e.pkgdir);
    if (existsSync(pkgDir)) continue; // already extracted: resume without re-downloading
    if (!e.url) {
      throw new Error(
        `${e.pkg}: no dist archive${e.source ? ` (source-only package: ${e.source})` : ''} — vendor-lite only fetches dist zips; commit a composer.lock or fall back to composer install for this project`
      );
    }
    const zip = join(tmpdir(), `lw-vendor-${process.pid}-${Date.now()}-${e.pkg}.zip`);
    await downloadFile(e.url, zip, e.shasum, e.pkg);
    extractZip(zip, pkgDir);
    rmSync(zip, { force: true });
  }
  writeFileSync(autoload, buildAutoloadPhp(entries, appDir, dir));
  try { writeFileSync(join(dir, '.lw-app'), appDir + '\n'); } catch {}
  if (!hasLock) {
    // Evidence of the resolved set — also re-read for `vendor-lite --lock`.
    writeFileSync(
      join(dir, 'resolved.json'),
      JSON.stringify(
        {
          note: 'resolved from composer.json by vendor-lite (no composer.lock was present at build time)',
          resolvedAt: new Date().toISOString(),
          packages: entries.map((e) => ({ name: e.name, version: e.version, type: e.type })),
        },
        null,
        2
      ) + '\n'
    );
    if (opts.lock) {
      writeComposerLock(appDir, entries);
      if (!opts.silent) console.log(`vendor-lite --lock: wrote composer.lock with ${entries.length} package(s) — commit it to pin this build`);
    }
  }
  return { dir, autoload, hash, hit: false, lockPackages: hasLock ? null : entries };
}

// CLI: `node tools/vendor-lite.mjs [--force] [--json] [--lock]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const appDir = resolve(process.env.LW_APP_ROOT || process.cwd());
  const flags = new Set(process.argv.slice(2));
  const json = flags.has('--json');
  const force = flags.has('--force');
  try {
    const r = await ensureVendorLite(appDir, { force, silent: json, lock: flags.has('--lock') });
    if (json) console.log(JSON.stringify(r));
    else console.log(`vendor-lite ${r.hit ? 'hit' : 'installed'}: ${r.dir}  (hash ${r.hash.slice(0, 12)})`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

export default { ensureVendorLite, vendorLiteDir, cacheBase };
