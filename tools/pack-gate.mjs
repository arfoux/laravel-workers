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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every module the build (build.mjs), the dumps and the guided deploy CLI load
// from the installed package. Keep this list in one place: the CI job and the
// e2e job both mean the same thing by "shipped".
export const REQUIRED = [
  'build.mjs',
  'compiler/blade.mjs',
  'tools/routes-dump.mjs',
  'tools/config-dump.mjs',
  'tools/schedule-dump.mjs',
  'tools/event-dump.mjs',
  'tools/class-dump.mjs',
  'tools/constants-dump.mjs',
  'tools/model-dump.mjs',
  'tools/policy-dump.mjs',
  'tools/static.mjs',
  'tools/inflect.mjs',
  'tools/php-runtime.mjs',
  'tools/deploy.mjs',
  'tools/lw-state.mjs',
  'tools/status.mjs',
  'tools/doctor.mjs',
  'tools/run.mjs',
  'tools/jsonc.mjs',
  'tools/cloud-account.mjs',
  'shadow/fixture-app.mjs',
];

// Files the published README links to. A dead link in the npm page is a
// documentation bug the same way a missing module is a build bug.
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
  'docs/AUDIT-2026-10-27.md',
  'docs/AUDIT-REAL-APPS.md',
  'docs/SWEEP-FINDINGS.md',
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

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

const appArgIndex = process.argv.indexOf('--app');
const cwd = appArgIndex !== -1 ? resolve(process.argv[appArgIndex + 1]) : repoRoot;
if (!existsSync(join(cwd, 'package.json'))) {
  console.error(`pack-gate: ${cwd} has no package.json`);
  process.exit(2);
}

const shipped = packFiles(cwd);
const missing = REQUIRED.filter((f) => !shipped.has(f));
const missingDocs = REQUIRED_DOCS.filter((f) => !shipped.has(f));
if (missing.length || missingDocs.length) {
  console.error('pack-gate FAILED: the tarball does not ship:');
  for (const f of missing) console.error(`  - ${f} (module loaded at runtime)`);
  for (const f of missingDocs) console.error(`  - ${f} (linked from README)`);
  console.error('Add them to package.json "files" (or drop the require / the link).');
  process.exit(1);
}

console.log(
  `pack-gate OK: ${REQUIRED.length} build/CLI modules + ${REQUIRED_DOCS.length} README-linked docs shipped (${shipped.size} files in the tarball)`,
);
