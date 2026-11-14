#!/usr/bin/env node
// tools/pack-gate.mjs — assert the published tarball ships every file the build
// and the deploy CLI load at runtime.
//
// WHY: the user installs the tarball, not the repo. A module `build.mjs` (or the
// CLI) requires but that `package.json.files` excludes only surfaces far too
// late — after `npm i` in a real app, as a MODULE_NOT_FOUND in the middle of a
// build. This gate fails the CI job instead.
//
// Why not `npm pack --dry-run | grep "npm notice .* <file>$"`: that depends on
// the human-readable notice layout (npm 10 vs 11, spacing, `--json` vs not) and
// on the pack output landing on stdout. `npm pack --dry-run --json` is the
// documented machine-readable form, so the list is parsed, not grepped, and a
// missing `files[]` field fails loudly instead of passing quietly.
//
// Usage: node tools/pack-gate.mjs [--app <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The two files the installed package RUNS: the build, and the guided CLI. Every
// module they load is discovered by walking the import graph from here, so
// adding an import to `build.mjs` moves it into the gate automatically — a
// hand-written list can only ever check what someone remembered to list, and
// this gate exists to catch the module somebody FORGOT (audit #804: the old
// 23-entry list was not closed under the graph — 38 of the 61 modules the build
// reaches were unlisted).
export const ENTRY = ['build.mjs', 'bin/laravel-workers.mjs'];

// Shipped although no import or literal path in ENTRY reaches them: the release
// workflow runs this one against a freshly generated app. Spelled out rather
// than derived, because "reachable from build.mjs" is exactly what cannot see it.
export const UNREACHABLE = ['shadow/fixture-app.mjs'];

// Files the published README links to. A dead link in the npm page is a
// documentation bug the same way a missing module is a build bug.
//
// The three dated audit records that used to sit here
// (`AUDIT-2026-10-27.md`, `AUDIT-REAL-APPS.md`, `SWEEP-FINDINGS.md`) moved to
// `docs/archive/`, and the published tarball no longer carries them: the README
// never linked them, so requiring them here demanded a file no reader could
// reach, and `docs/.npmignore` (`archive/`) narrows the `docs` entry in
// package.json `files` (`npm pack --dry-run` lists zero `docs/archive` paths).
// This list is about links that must not rot.
export const REQUIRED_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'MAP.md',
  'COMPILED.md',
  'docs/PROCESS.md',
  'docs/banner.png',
  'docs/PLAN-VENDOR.md',
  'docs/READINESS.md',
  'docs/BRAND.md',
  // Linked by the README but absent from this list until 2026-11-14: the CI
  // badge points at `docs/CI.md`, the port recipes point at
  // `docs/PACKAGE-PORTS.md`, and the operator reference lives in
  // `docs/DEPLOY.md` / `docs/INTERNALS.md`. All four ship (`files: docs`,
  // `docs/.npmignore` excludes only `archive/`), so a dead link here would be
  // the one thing this list exists to catch.
  'docs/CI.md',
  'docs/PACKAGE-PORTS.md',
  'docs/DEPLOY.md',
  'docs/INTERNALS.md',
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// `from './x.mjs'`, `await import('./x.mjs')`, `require('./x')` — relative
// specifiers only: a bare specifier (`node:fs`, `php-parser`) is resolved from
// node_modules and is not this package's file to ship.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.[^'"]*)['"]/g;
// `join(pkgDir, 'tools', 'prerender.php')` — a file the build RUNS or COPIES by
// path, so no import edge points at it. The FIRST argument is the anchor and is
// dropped; it has to be one of the package's own roots, because
// `join(appDir, '.gitignore')` names a file in the USER's app and is not this
// package's to ship. Every segment after the anchor must be a literal: a
// variable could be anything, and guessing would put a file in the requirement
// that may not be there.
const PACKAGE_ANCHORS = new Set(['pkgDir', 'pkgRoot', 'ROOT', 'repoRoot', 'here', '__dirname']);
const PATH_CALL = /\b(?:join|resolve)\(\s*([^()]*?)\s*\)/g;
const WHOLE_LITERAL = /^['"]([^'"]*)['"]$/;
// An existence PROBE makes the file optional on purpose (deploy and doctor run
// their test hooks only when the repo's fixtures are there), so it is not a
// requirement — `existsSync(join(pkgDir, 'tools', 'tests', 'fixtures', 'x.mjs'))`.
const PROBE_GUARD = /(?:existsSync|statSync|lstatSync)\(\s*$/;
// The PHP side of the same edge: `require_once __DIR__ . '/model-dump.php'`. The
// build runs `tools/metadata-phase.php`, which pulls in four more helpers this
// way — a `files` entry that dropped one of them breaks the build the same as a
// missing module does.
const PHP_REQUIRE = /(?:require|include)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*['"]([^'"]+)['"]/g;

const toPosix = (p) => p.split(sep).join('/');

function firstExisting(root, candidate) {
  for (const [withExt, ext] of [[candidate, ''], [candidate, '.mjs'], [candidate, '.js'], [candidate, '.php']]) {
    const abs = join(root, withExt + ext);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue; // not this one
    }
    const rel = toPosix(relative(root, abs));
    // A path that climbs out of the package is not a file the tarball could
    // carry, however the specifier was written.
    return rel.startsWith('..') ? null : rel;
  }
  return null;
}

/**
 * Every file under `root` the entry points need at run time: the modules reached
 * by walking relative imports from `entries`, plus the files those modules name
 * as literal `join(...)` paths (the build spawns a PHP helper or copies a worker
 * that way, and a MODULE_NOT_FOUND / ENOENT in a published tarball is the same
 * failure either way). Sorted, repo-relative, deduplicated.
 */
export function runtimeFiles(root, entries = ENTRY) {
  const modules = new Set();
  const assets = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = toPosix(queue.shift());
    if (modules.has(rel)) continue;
    let source;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // named by an entry/list but absent: packFiles() reports it
    }
    modules.add(rel);
    const base = dirname(join(root, rel));
    for (const m of source.matchAll(RELATIVE_IMPORT)) {
      const abs = resolve(base, m[1]);
      const found = firstExisting(root, toPosix(relative(root, abs)));
      if (found) queue.push(found);
    }
    for (const m of source.matchAll(PHP_REQUIRE)) {
      const abs = resolve(base, m[1].replace(/^[/\\]/, ''));
      const found = firstExisting(root, toPosix(relative(root, abs)));
      if (found) queue.push(found);
    }
    for (const call of source.matchAll(PATH_CALL)) {
      const args = call[1]
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== '');
      if (!PACKAGE_ANCHORS.has(args[0])) continue;
      if (PROBE_GUARD.test(source.slice(Math.max(0, call.index - 24), call.index))) continue;
      const literals = args.slice(1).map((s) => (s.match(WHOLE_LITERAL) || [])[1]);
      if (!literals.length || literals.some((l) => l === undefined)) continue;
      const found = firstExisting(root, literals.join('/'));
      // A spawned script is walked like any other module: a tool that the build
      // runs by path imports helpers of its own, and those are just as missing
      // from `files` if the directory is ever trimmed.
      if (found) {
        assets.add(found);
        queue.push(found);
      }
    }
  }
  return [...new Set([...modules, ...assets])].sort();
}

function packFiles(cwd) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // `shell: true` on Windows: npm is a .cmd shim and Node refuses to spawn it
  // directly (EINVAL). The arguments are constants, so the shell adds no
  // injection surface.
  const out = execFileSync(bin, ['pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`npm pack --dry-run --json did not print JSON (${err.message}); first 200 bytes: ${out.slice(0, 200)}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = entry && Array.isArray(entry.files) ? entry.files : null;
  if (!files) {
    throw new Error('npm pack --dry-run --json printed no `files[]` — the pack format changed, the gate cannot judge the tarball');
  }
  return new Set(files.map((f) => (typeof f === 'string' ? f : f.path)));
}

// The gate is also imported (its walker and lists are used by
// tools/tests/pack-gate.test.mjs), so the checks below run only when this file
// is the process's entry point — an import must not spawn `npm pack`.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url)) || toPosix(argv1).endsWith('/tools/pack-gate.mjs');
})();

if (isMain) {
  const appArgIndex = process.argv.indexOf('--app');
  const cwd = appArgIndex !== -1 ? resolve(process.argv[appArgIndex + 1]) : repoRoot;
  if (!existsSync(join(cwd, 'package.json'))) {
    console.error(`pack-gate: ${cwd} has no package.json`);
    process.exit(2);
  }

  const shipped = packFiles(cwd);
  const modules = runtimeFiles(repoRoot);
  const required = [...modules, ...UNREACHABLE].sort();
  const missing = required.filter((f) => !shipped.has(f));
  const missingDocs = REQUIRED_DOCS.filter((f) => !shipped.has(f));
  if (missing.length || missingDocs.length) {
    console.error('pack-gate FAILED: the tarball does not ship:');
    for (const f of missing) console.error(`  - ${f} (loaded at runtime)`);
    for (const f of missingDocs) console.error(`  - ${f} (linked from README)`);
    console.error('Add them to package.json "files" (or drop the require / the link).');
    process.exit(1);
  }

  console.log(
    `pack-gate OK: ${modules.length} runtime files reached from ${ENTRY.join(' + ')} ` +
      `(+${UNREACHABLE.length} explicit) + ${REQUIRED_DOCS.length} README-linked docs shipped ` +
      `(${shipped.size} files in the tarball)`,
  );
}
