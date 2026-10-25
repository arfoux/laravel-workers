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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
      const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
      h.update(JSON.stringify(j.require || {}));
      h.update(JSON.stringify(j['require-dev'] || {}));
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
      url: (p.dist && p.dist.url) || (p.source && p.source.url) || null,
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
  const r = run('unzip', ['-o', zipPath, '-d', tmp], {});
  if (r.status !== 0) throw new Error('unzip failed: ' + (r.stderr ? r.stderr.toString() : r.error));
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

async function downloadFile(url, out) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`vendor fetch failed: ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
}

function phpStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function fqcnOf(filePath) {
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return null;
  const src = readFileSync(filePath, 'utf8');
  const m = src.match(/(?:class|interface|trait)\s+([A-Za-z0-9_]+)/);
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
        // Skip directories (classmap entries may list a folder); only process actual files.
        if (existsSync(full) && statSync(full).isDirectory()) continue;
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
  for (const p of psr4) lines.push(`    ${phpStr(p.prefix)} => ${phpStr(p.dir)},`);
  const psr4Src = lines.length ? 'array(\n' + lines.join('\n') + '\n    )' : 'array()';
  const clLines = classmap.map(c => `    ${phpStr(c.fq)} => ${phpStr(c.file)},`);
  const classmapSrc = clLines.length ? 'array(\n' + clLines.join('\n') + '\n    )' : 'array()';
  const fileLines = files.map(f => `    ${phpStr(f)},`);
  const filesSrc = fileLines.length ? 'array(\n' + fileLines.join('\n') + '\n    )' : 'array()';
  return `<?php
// Generated by laravel-workers vendor-lite (composer-free installer). Do not edit.

$psr4 = ${psr4Src};
$classmap = ${classmapSrc};
$files = ${filesSrc};

spl_autoload_register(function ($class) use (&$psr4, &$classmap, &$files) {
    if (isset($classmap[$class])) { require_once $classmap[$class]; return true; }
    foreach ($psr4 as $prefix => $dir) {
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

export async function ensureVendorLite(appDir, opts = {}) {
  const hash = hashFor(appDir);
  const dir = vendorLiteDir(hash);
  const autoload = join(dir, 'vendor', 'autoload.php');
  if (existsSync(autoload) && !opts.force) {
    return { dir, autoload, hash, hit: true };
  }
  mkdirSync(dir, { recursive: true });
  writeComposerLite(appDir, dir);
  const entries = readLockPackages(appDir);
  const destRoot = dir; // <dir>/vendor/<vendor>/<pkg> lives directly under dir
  for (const e of entries) {
    if (!e.url) throw new Error(`vendor-lite: no dist url for ${e.name}`);
    const pkgDir = join(destRoot, e.pkgdir);
    if (existsSync(pkgDir)) continue; // already extracted: resume without re-downloading
    const zip = join(tmpdir(), `lw-vendor-${process.pid}-${Date.now()}-${e.pkg}.zip`);
    await downloadFile(e.url, zip);
    extractZip(zip, pkgDir);
    rmSync(zip, { force: true });
  }
  writeFileSync(autoload, buildAutoloadPhp(entries, appDir, dir));
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
    const r = await ensureVendorLite(appDir, { force, silent: json });
    if (json) console.log(JSON.stringify(r));
    else console.log(`vendor-lite ${r.hit ? 'hit' : 'installed'}: ${r.dir}  (hash ${r.hash.slice(0, 12)})`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

export default { ensureVendorLite, vendorLiteDir, cacheBase };
