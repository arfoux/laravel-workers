#!/usr/bin/env node
// tools/pack-smoke.mjs — the packaging gate.
//
// What a consumer gets is the *tarball*, not this repo: `npm i laravel-workers`
// unpacks the published files and installs the dependencies. Nothing in the
// repo proves that the published set is complete (a file missing from
// `package.json#files`, a dependency not declared, a path assumption) - until a
// consumer hits it.
//
// This script is that proof: it packs the repo, installs the tarball into an
// empty project and then runs the *installed* toolchain against a real Laravel
// app: the CLI build, the compiler import (php-parser must resolve) and the
// shadow harness. It is the same path a user walks.
//
//   node tools/pack-smoke.mjs --app <laravel-app-root>
//   LW_LARAVEL_APP=<laravel-app-root> node tools/pack-smoke.mjs
//
// Without an app there is nothing to build: it skips with a reason (the same
// convention as the PHP oracle tests).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const appRoot = resolve(arg('--app') || process.env.LW_LARAVEL_APP || '');

if (!appRoot || !existsSync(join(appRoot, 'artisan'))) {
  console.log('pack-smoke SKIP: no Laravel app (pass --app <root> or set LW_LARAVEL_APP)');
  process.exit(0);
}
if (!existsSync(join(appRoot, 'vendor', 'autoload.php'))) {
  console.log(`pack-smoke SKIP: ${appRoot} has no vendor/ (run composer install first)`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'lw-pack-smoke-'));
const results = [];

function step(label, fn) {
  process.stdout.write(`\n• ${label}\n`);
  try {
    fn();
    results.push({ label, ok: true });
    console.log('  ok');
  } catch (e) {
    const text = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    results.push({ label, ok: false });
    console.log('  FAILED');
    console.log(text.split('\n').slice(-25).join('\n'));
  }
}

try {
  // 1. the tarball
  let tgz = null;
  step('npm pack (the published file set)', () => {
    execSync(`npm pack --pack-destination "${work}"`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const tgzName = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tgzName) throw new Error('no tarball was produced');
    tgz = join(work, tgzName);
    console.log('  ' + tgzName);
  });
  if (!tgz) throw new Error('packing failed');

  // 2. a consumer install
  step('npm i <tarball> into an empty project', () => {
    execSync('npm init -y', { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`npm i "${tgz}" --no-audit --no-fund`, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const pkg = join(work, 'node_modules', 'laravel-workers');
    if (!existsSync(pkg)) throw new Error('the package did not land in node_modules');
    for (const dep of ['php-parser', 'bcryptjs']) {
      if (!existsSync(join(work, 'node_modules', dep))) throw new Error(`the dependency ${dep} is missing`);
    }
  });
  const pkg = join(work, 'node_modules', 'laravel-workers');

  // 3. the installed CLI builds the app (the real thing a user does)
  step('the installed CLI: laravel-workers build --strict', () => {
    const out = execFileSync(process.execPath, [join(pkg, 'bin', 'laravel-workers.mjs'), 'build', '--strict'], {
      cwd: appRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.split('\n').find((l) => l.includes('controllers transpiled')) || '';
    console.log('  ' + line.trim());
  });

  // 4. the compiler import (php-parser must resolve from the consumer install)
  step('the installed compiler imports (php-parser resolves)', () => {
    const url = pathToFileURL(join(pkg, 'compiler', 'src', 'transpiler.mjs')).href;
    execFileSync(process.execPath, ['-e', `import('${url}').then(()=>0).catch(e=>{console.error(e.message);process.exit(1)})`], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  // 5. the shadow harness, when the package ships a scenario for this app
  const scenario = join(pkg, 'shadow', 'scenarios', `${appRoot.split(/[\\/]/).pop()}.mjs`);
  if (existsSync(scenario)) {
    step('the installed shadow harness runs', () => {
      const out = execFileSync(process.execPath, [join(pkg, 'shadow', 'run.mjs'), '--app', appRoot], {
        cwd: work,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line = out.split('\n').filter((l) => l.startsWith('shadow:')).pop() || '';
      console.log('  ' + line.trim());
    });
  } else {
    console.log(`\n• the shadow harness: skipped (the package ships no scenario for "${appRoot.split(/[\\/]/).pop()}")`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== pack-smoke ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);
  console.log(failed.length ? 'pack-smoke FAILED' : 'pack-smoke PASSED (the published tarball works)');
  process.exit(failed.length ? 1 : 0);
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
}
