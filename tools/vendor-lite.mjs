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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDependencies } from './composer-resolve.mjs';
import { extractZip as extractZipJs } from './zip.mjs';
import parser from 'php-parser';
import { nodeName } from './static.mjs';
import { toNativePath as normaliseShellPath } from './native-path.mjs';

/** Same options as tools/static.mjs — positions are irrelevant here, docblocks are dropped. */
const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A shell-supplied path ("/c/Users/...") normalised to a real Windows drive
// path AND made absolute: this module uses the result as a cache key, so the
// same app reached by two spellings has to land on one key (audit #401/#417).
const toNativePath = (p) => resolve(normaliseShellPath(p));

export function cacheBase() {
  // `XDG_CACHE_HOME` arrives from the shell like any other path: `/c/Users/x`
  // from Git-Bash would otherwise create the cache under `<drive>:\c\Users\x`
  // (audit #803).
  if (process.env.XDG_CACHE_HOME) return join(normaliseShellPath(process.env.XDG_CACHE_HOME), 'laravel-workers');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'laravel-workers', 'cache');
  }
  return join(homedir(), '.cache', 'laravel-workers');
}

export function vendorLiteDir(hash) {
  return join(cacheBase(), 'vendor-lite', hash.slice(0, 16));
}

export function hashFor(appDir) {
  const lockPath = join(appDir, 'composer.lock');
  const jsonPath = join(appDir, 'composer.json');
  const h = createHash('sha256');
  h.update(process.version);
  // #315: the cache entry's generated autoloader hard-codes the app's own
  // namespace roots (`buildAutoloadPhp(entries, appDir, dir)`) and `lw_boot_app`
  // points COMPOSER_VENDOR_DIR at that entry. Two apps with an identical set of
  // composer files but different locations therefore MUST NOT share an entry —
  // without the path in the key, a moved/renamed app reused the old entry and
  // booted with an autoloader rooted at the OLD directory (the #303/#315
  // failure: `trans_key()` undefined, wrong app silently served). The path is
  // normalised so the key is stable regardless of how the caller spelled it.
  h.update(':' + String(toNativePath(appDir)).replace(/\\/g, '/'));
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
      // `provision()` skips metapackages by `type` (they declare requirements
      // and ship no files, so the lock carries no dist for them). Reading the
      // lock without this field made that skip unreachable and refused the
      // build with "no dist archive" for a package that was never fetchable.
      type: String(p.type || ''),
      url: (p.dist && p.dist.url) || null,
      shasum: (p.dist && p.dist.shasum) || null,
      source: (p.source && p.source.url) || null,
      reference: (p.dist && p.dist.reference) || (p.source && p.source.reference) || null,
      autoload: p.autoload || {},
      // Laravel's package auto-discovery lives in `extra.laravel` (providers,
      // aliases, dont-discover) — see installedJsonOf().
      extra: p.extra || {},
      pkgdir: join('vendor', vendor, pkg),
    });
  }
  return out;
}

// A composer repository may declare a dist URL as a template and Composer fills
// the package's own fields in at install time, so the lock keeps the template
// verbatim (ssddanbrown/htmldiff in a real Laravel app's lock carries
// `.../archive/%prettyVersion%.zip`). Fetching it verbatim asks the host for a
// file literally named `%prettyVersion%.zip`: codeberg answers 502 and the
// build dies on a network-looking error instead of naming the cause.
// `%prettyVersion%` is the lock's `version` as stored — verified against
// codeberg/gitea: `archive/v2.0.0.zip` answers 200 while the stripped
// `archive/2.0.0.zip` answers 404, so the tag form is not normalised here.
// Only the placeholders the lock states outright are filled; a template this
// installer cannot fill is refused WITH the URL, so the operator switches
// strategy (composer install) instead of chasing a 4xx through three retries.
function fillDistUrl(e) {
  const url = String(e.url || '');
  if (!url.includes('%')) return e.url;
  let out = url;
  if (out.includes('%package%')) out = out.replaceAll('%package%', e.name);
  if (out.includes('%prettyVersion%')) out = out.replaceAll('%prettyVersion%', e.version);
  if (e.reference && out.includes('%reference%')) out = out.replaceAll('%reference%', e.reference);
  const left = out.match(/%[A-Za-z][A-Za-z0-9]*%/);
  if (left) {
    throw new Error(
      `${e.name}: the dist URL uses the placeholder ${left[0]}, which this installer does not fill (${url}) — ` +
        'run `composer install` for this project, or commit a lock whose dist URL is concrete'
    );
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

export function extractPackageZip(zipPath, destDir) {
  // The archive is unpacked into a temp dir and then MOVED into place in one
  // step, because `provision()` resumes on `existsSync(pkgDir)`: an existing
  // package directory means "installed". A copy that died halfway (a locked
  // file on Windows, a full disk) used to leave that directory behind, so every
  // later build SKIPPED the package and the half-extracted tree stayed cached
  // forever (#752). The staging dir is a sibling of `destDir` on the same
  // volume, so the rename is the atomic one, and it is the only mutation of
  // `destDir` — `mkdirSync(destDir)` up front used to create the very directory
  // the resume check trusts.
  const parent = dirname(destDir);
  mkdirSync(parent, { recursive: true });
  const staging = `${destDir}.lw-part-${process.pid}`;
  rmSync(staging, { recursive: true, force: true }); // a crashed earlier run
  const tmp = mkdtempSync(join(tmpdir(), 'lw-vendor-zip-'));
  // The built-in reader runs first: a clean Windows box has no `unzip`, and
  // provisioning a vendor tree must not depend on one. The system binary is the
  // fallback for archives the reader refuses (ZIP64, another method); when both
  // fail the error names the reader's own reason (and whether `unzip` exists).
  try {
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
    // The package root is the single top-level DIRECTORY every packagist and
    // GitHub dist zip has. Anything else is refused by name instead of guessed:
    // the old code took `top[0]` blindly, so a zip with two roots shipped only
    // the first (silently incomplete) and a zip of bare files threw a
    // confusing readdir error on a file path.
    const top = readdirSync(tmp, { withFileTypes: true });
    const dirs = top.filter((e) => e.isDirectory());
    let srcDir = tmp;
    if (dirs.length === 1 && top.length === 1) {
      srcDir = join(tmp, dirs[0].name);
    } else if (dirs.length !== 0) {
      throw new Error(
        `the package zip has ${top.length} top-level entries (${top.map((e) => e.name).join(', ')}) — ` +
          'expected exactly one root directory (a packagist/GitHub dist archive)'
      );
    }
    for (const e of readdirSync(srcDir, { withFileTypes: true })) {
      const s = join(srcDir, e.name);
      const d = join(staging, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); }
    }
    // An archive whose single root directory is EMPTY (a dist zip whose only
    // entry is the directory itself) leaves the copy loop with nothing to
    // create, and the swap below would then throw ENOENT on a missing staging
    // source - naming the temp path instead of the package. An empty package is
    // still an installed package (the old code pre-created `destDir`), so the
    // staging directory exists before the swap (#820).
    mkdirSync(staging, { recursive: true });
    // A `destDir` can only be here if it was left by an OLDER release (this
    // function never leaves one behind now) or by a caller that is redoing an
    // entry: remove it, then swap. `renameSync` refuses an existing target on
    // Windows, and the resume check in `provision()` trusts the name.
    rmSync(destDir, { recursive: true, force: true });
    renameSync(staging, destDir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function downloadFile(url, out, expectSha, label) {
  // Real failures observed: HTTP 403/429 rate limits from api.github.com,
  // transient transport errors after ~60 zipballs ("fetch failed" with NO url
  // in the message), and bytes that do not match the lock. Name the package,
  // retry the recoverable ones, verify when the lock carries a shasum — the
  // code below becomes executed PHP, so a mismatched payload must never load.
  const attempts = 3;
  // An explicit abort budget per attempt (#751). undici's own body/headers
  // timeout is 300 s, but it belongs to the runtime: naming it here means a
  // stalled connection aborts as `AbortError` and the retry loop below runs,
  // instead of the fetch hanging on however the host is configured. A large
  // package (tens of MB) over a slow link still fits: the budget is per
  // attempt, not for all three.
  // #879: a value the variable cannot mean must fail HERE, named. Anything but
  // a positive finite number used to reach AbortSignal.timeout(), which throws
  // a RangeError; the retry loop below then read it as a transport failure —
  // three attempts, and the message named a "delay" instead of the variable.
  const rawTimeout = process.env.LW_VENDOR_FETCH_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined || rawTimeout === '' ? 300_000 : Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `LW_VENDOR_FETCH_TIMEOUT_MS must be a positive number of milliseconds (got ${JSON.stringify(rawTimeout)}) — ` +
        'it is handed to AbortSignal.timeout(); unset it to use the default 300000'
    );
  }
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'laravel-workers/vendor-lite' },
        signal: AbortSignal.timeout(timeoutMs),
      });
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
      // The abort from the `signal` above arrives as a DOMException (directly or
      // as `cause`); name it as a timeout so the operator reads a duration, not
      // "The operation was aborted".
      const timedOut = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
      const why = timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : e.cause?.code || e.message;
      lastErr = new Error(`${label || 'package'}: ${why} fetching ${url}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 700 * i));
  }
  throw new Error(`vendor fetch failed after ${attempts} attempt(s): ${lastErr ? lastErr.message : url}`);
}

function phpStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * Every class-like FQCN declared in a PHP file, in declaration order.
 *
 * The classmap keys must be what Composer's ClassMapGenerator generates, and
 * that is the ONLY thing this function exists for. A bare
 * `/(?:class|interface|trait|enum)\s+(\w+)/` over the raw source is not that:
 * it matches inside comments and strings, it never qualifies the name with the
 * namespace, and it answers only the FIRST declaration. Verified against real
 * vendor code — vendor/nette/utils/src/SmartObject.php answered `for` (from the
 * docblock "Strict class for better experience.") and
 * src/Utils/ReflectionMethod.php answered `name` ("...the original class
 * name."), so neither real class was in the generated classmap; both escaped
 * only because their package's psr-4 prefix also covers them. The tokenizer is
 * php-parser, already a dependency, and the walk mirrors tools/static.mjs
 * parsePhpFile() (namespace in force + no descent into class bodies).
 */
const CLASS_NODE_KINDS = new Set(['class', 'interface', 'trait', 'enum']);
export function classNames(filePath) {
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return [];
  let ast;
  try {
    ast = phpParser.parseCode(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  if (ast && ast.errors && ast.errors.length) return [];
  const out = [];
  const walk = (n, ns) => {
    if (Array.isArray(n)) { for (const c of n) walk(c, ns); return; }
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'namespace') {
      const name = n.name && typeof n.name === 'object' ? nodeName(n.name) : String(n.name || '');
      for (const c of (n.children || [])) walk(c, name);
      return;
    }
    if (CLASS_NODE_KINDS.has(n.kind)) {
      const name = n.name && typeof n.name === 'object' ? nodeName(n.name) : n.name;
      if (name) out.push((ns ? ns + '\\' : '') + name); // `new class` is anonymous: no name, skipped
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
      if (k === 'use' || k === 'uses') continue;
      walk(n[k], ns);
    }
  };
  walk(ast, '');
  return out;
}

/**
 * The one piece of composer-generated metadata Laravel itself reads.
 *
 * `Illuminate\Foundation\PackageManifest` loads
 * `Env::get('COMPOSER_VENDOR_DIR') ?: base_path('vendor')` + `/composer/installed.json`
 * and builds `bootstrap/cache/packages.php` from every package's `extra.laravel`
 * (providers, aliases, `dont-discover`). Composer writes that file at install
 * time; vendor-lite never runs composer, so it has to write it itself — without
 * it EVERY auto-discovered package provider stays unregistered and the build
 * boots a different application than `php artisan` does. Measured on the pilot
 * apps: 5 (BookStack) to 37 (akaunting) providers per app; cachet's own fatal
 * (`Call to undefined function`/`array_key_exists(): ... null given` inside
 * spatie/laravel-settings, reached from cachethq/core) comes from exactly this.
 */
export function installedJsonOf(entries) {
  return {
    packages: entries.map((e) => ({
      name: e.name,
      version: String(e.version || ''),
      type: e.type || 'library',
      extra: e.extra || {},
    })),
    dev: false,
    'dev-package-names': [],
  };
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
                for (const fq of classNames(p)) classmap.push({ fq, file: p });
              }
            }
          }
          continue;
        }
        for (const fq of classNames(full)) classmap.push({ fq, file: full });
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
      for (const fq of classNames(full)) classmap.push({ fq, file: full });
    }
  }
  if (appAl['files']) {
    for (const f of appAl['files']) files.push(join(appDir, String(f)));
  }
  const lines = [];
  // Composer's ClassLoader walks a class name from its LAST namespace separator
  // backwards, so the LONGEST matching prefix wins. The generated autoloader
  // below scans this list front to back and takes the first prefix that matches
  // (#800): with nested prefixes (`Foo\` and `Foo\Bar\`) and a file under both
  // directories, an unsorted list loads the file Composer would not — the dump
  // would then be built from a class `php artisan` never loads. Sorting by
  // descending prefix length reproduces Composer's precedence; the sort is
  // stable, so equal-length prefixes keep their declaration order (only one of
  // them can match any given class anyway).
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
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
// non-ASCII escaped) — so the hash matches the composer.json it was written
// from and `composer validate` does not call the lock stale.
//
// It is NOT a drop-in Composer lock: the PACKAGE SET vendor-lite INSTALLS is the
// production closure (`resolveDependencies()` walks `require`) and that is what
// `packages` carries. `packages-dev` is filled by the `--lock` path, which
// resolves the dev closure too (`includeDev`) and drops every name already in
// `packages` — that is what makes `composer validate` pass on a Laravel skeleton.
// Before that, `packages-dev: []` made it exit 2 with `Required (in require-dev)
// package "..." is not present in the lock file.` (probed against Composer
// 2.9.0 / PHP 8.3.30, audit #805). Nothing dev is ever INSTALLED:
// `readLockPackages()` reads `packages` only. The written `_readme`, the CLI
// notice and `docs/PLAN-VENDOR.md` §E say so.

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

export function writeComposerLock(appDir, entries, devEntries = []) {
  const root = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
  // The require-dev names this lock carries NO ENTRY for — empty in the normal
  // case, because the `--lock` path resolves the dev closure too and hands it in
  // `devEntries` (audit #805: `packages-dev: []` made `composer validate` fail
  // with "Required (in require-dev) package ... is not present in the lock file"
  // on every Laravel skeleton). Whatever is left over is RETURNED and said out
  // loud, because that failure lands later, in the app's own `composer validate`.
  const devRequires = Object.keys(root['require-dev'] || {});
  const pinnedDev = new Set(devEntries.map((e) => e.name));
  const unpinned = devRequires.filter((n) => !pinnedDev.has(n));
  const stabilityFlags = {};
  for (const [n, c] of Object.entries({ ...(root.require || {}), ...(root['require-dev'] || {}) })) {
    const m = String(c).match(/@(stable|dev|alpha|beta|RC)$/i);
    if (m) stabilityFlags[n] = STABILITY_FLAG_RANK[m[1].toLowerCase()] ?? 1;
  }
  // One mapper for both lists: composer reads `packages` and `packages-dev`
  // entries the same way, and a dev entry that drifted in shape would be a lock
  // composer rejects.
  const lockEntry = (e) => ({
    name: e.name,
    version: e.version,
    ...(e.source ? { source: { type: 'git', url: e.source, reference: e.reference || '' } } : {}),
    ...(e.url ? { dist: { type: 'zip', url: e.url, reference: e.reference || '', shasum: e.shasum || '' } } : {}),
    require: e.require || {},
    type: e.type || 'library',
    autoload: e.autoload || {},
    ...(e.replace && Object.keys(e.replace).length ? { replace: e.replace } : {}),
    ...(e.provide && Object.keys(e.provide).length ? { provide: e.provide } : {}),
  });
  const doc = {
    _readme: [
      'Generated by laravel-workers vendor-lite --lock from a composer.json-only resolution.',
      'Pins the PACKAGE SET VENDOR-LITE INSTALLS (production requires) so builds are reproducible with no composer involved.',
      ...(devEntries.length
        ? [
            `It also pins ${devEntries.length} require-dev package(s) in 'packages-dev' — resolved from composer.json, never installed by vendor-lite (readLockPackages() reads 'packages' only).`,
          ]
        : []),
      ...(unpinned.length
        ? [
            `It carries no require-dev entry for (${unpinned.join(', ')}): vendor-lite never installs them.`,
            '`composer validate` will therefore report them as missing from this lock — run `composer update` if Composer should own the file.',
          ]
        : []),
      'Regenerate with `composer update` if you would rather composer own this file.',
    ],
    'content-hash': contentHashOf(root),
    packages: entries.map(lockEntry),
    'packages-dev': devEntries.map(lockEntry),
    'stability-flags': stabilityFlags,
    'prefer-stable': root['prefer-stable'] === true,
    'prefer-lowest': false,
    platform: (root.config && root.config.platform) || [],
    'platform-dev': [],
    'plugin-api-version': '2.6.0',
  };
  writeFileSync(join(appDir, 'composer.lock'), JSON.stringify(doc, null, 4) + '\n');
  return { devRequires: unpinned };
}

export async function ensureVendorLite(appDir, opts = {}) {
  appDir = toNativePath(appDir);
  const hash = hashFor(appDir);
  const dir = vendorLiteDir(hash);
  const autoload = join(dir, 'vendor', 'autoload.php');
  const installedJson = join(dir, 'vendor', 'composer', 'installed.json');
  const stampPath = join(dir, '.lw-app');
  if (existsSync(autoload) && !opts.force) {
    // #315: the entry's generated autoloader is rooted at the app dir it was
    // built for. The hash above now includes the path, so a foreign entry can
    // only appear through a copied cache dir or a hash collision — but verify
    // the written stamp anyway, and refuse a mismatch instead of booting a
    // different application's autoloader.
    let stampOwnsApp = true;
    if (existsSync(stampPath)) {
      try { stampOwnsApp = readFileSync(stampPath, 'utf8').trim() === appDir; } catch { stampOwnsApp = false; }
    }
    if (!stampOwnsApp) {
      if (!opts.silent) console.log(`vendor-lite: ${dir} belongs to another app path — re-provisioning for ${appDir}`);
      return provision(appDir, dir, autoload, hash, opts);
    }
    if (!existsSync(stampPath)) { try { writeFileSync(stampPath, appDir + '\n'); } catch {} }
    // A cache entry written before `installed.json` existed (or by an older
    // generator) would otherwise hit forever and keep Laravel's package
    // auto-discovery empty — the failure class of #303/#315: the build silently
    // boots a different application. Self-HEAL from the entry's own artifacts
    // (the provisioning path copies `composer.json`/`composer.lock` in) rather
    // than treating the hit as a miss: a miss would re-download every package
    // from packagist, which is impossible offline and pointless here. Only when
    // the entry kept neither file do we fall through to a real re-provision.
    if (!existsSync(installedJson)) {
      if (existsSync(join(dir, 'composer.lock'))) {
        mkdirSync(join(dir, 'vendor', 'composer'), { recursive: true });
        writeFileSync(installedJson, JSON.stringify(installedJsonOf(readLockPackages(dir)), null, 4) + '\n');
      } else {
        if (!opts.silent) console.log(`vendor-lite: ${dir} predates installed.json and kept no composer.lock — re-provisioning`);
        return provision(appDir, dir, autoload, hash, opts);
      }
    }
    return { dir, autoload, hash, hit: true };
  }
  return provision(appDir, dir, autoload, hash, opts);
}

async function provision(appDir, dir, autoload, hash, opts) {
  const hasLock = existsSync(join(appDir, 'composer.lock'));
  // The manifest path `ensureVendorLite` computes for its self-heal branch is
  // scoped to THAT function; provisioning needs its own (writing the manifest it
  // never declared used to answer `ReferenceError: installedJson is not
  // defined`, so every cache miss - the no-vendor/ build - died).
  const installedJson = join(dir, 'vendor', 'composer', 'installed.json');
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
        `${e.name || e.pkg}: no dist archive${e.source ? ` (source-only package: ${e.source})` : ''} — vendor-lite only fetches dist zips; commit a composer.lock or fall back to composer install for this project`
      );
    }
    const zip = join(tmpdir(), `lw-vendor-${process.pid}-${Date.now()}-${e.pkg}.zip`);
    await downloadFile(fillDistUrl(e), zip, e.shasum, e.pkg);
    // The zip leaves nothing behind even when the extraction throws: a failed
    // extraction used to keep a multi-MB archive in the system temp dir.
    try {
      extractPackageZip(zip, pkgDir);
    } finally {
      rmSync(zip, { force: true });
    }
  }
  // `vendor/` exists only once a package was extracted, and a lock whose every
  // package is virtual (a metapackage, skipped above) extracts none — the
  // generated autoloader still belongs there, so the directories come first.
  // `vendor/composer/` is where composer's own metadata lands; `lw_boot_app()`
  // points COMPOSER_VENDOR_DIR at the same directory. installed.json is not
  // optional, and the directory only exists when the app happens to depend on a
  // composer/* package — create it either way.
  mkdirSync(join(dir, 'vendor', 'composer'), { recursive: true });
  writeFileSync(autoload, buildAutoloadPhp(entries, appDir, dir));
  writeFileSync(installedJson, JSON.stringify(installedJsonOf(entries), null, 4) + '\n');
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
      // Resolve the DEV closure too (audit #805): `composer validate` checks the
      // root `require-dev` names against `packages-dev`, and a lock with an empty
      // dev list failed on every Laravel skeleton (pint, pail, sail…). Only the
      // LOCK carries them — `readLockPackages()` reads `packages`, so nothing dev
      // is ever installed. `silent` keeps the resolver's platform/conflict notes
      // from printing a second time.
      const rootJson = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
      const devNames = Object.keys(rootJson['require-dev'] || {});
      const devEntries = devNames.length
        ? (await resolveDependencies(appDir, { ...opts, includeDev: true, silent: true })).filter(
            (e) => !entries.some((p) => p.name === e.name)
          )
        : [];
      const { devRequires } = writeComposerLock(appDir, entries, devEntries);
      if (!opts.silent) {
        console.log(`vendor-lite --lock: wrote composer.lock with ${entries.length} package(s) — commit it to pin this build`);
        if (devRequires.length) {
          console.log(
            `  note: no require-dev entry was resolved for (${devRequires.join(', ')}). ` +
              '`composer validate` will report those as missing from this lock; run `composer update` if Composer should own it'
          );
        }
      }
    }
  }
  return { dir, autoload, hash, hit: false, lockPackages: hasLock ? null : entries };
}

// CLI: `node tools/vendor-lite.mjs [--force] [--json] [--lock]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Normalise BEFORE resolve(): `resolve('/c/Users/app')` on Windows turns a
  // Git-Bash path into `<drive>:\c\Users\app`, which no later normalisation can
  // recognise — the CLI then reports "neither composer.lock nor composer.json"
  // for an app that is right there (audit #803).
  const appDir = toNativePath(process.env.LW_APP_ROOT || process.cwd());
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
