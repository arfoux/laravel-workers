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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  console.log(`pack-smoke SKIP: ${appRoot} has no vendor/ (run 'npx laravel-workers vendor:ensure' first)`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'lw-pack-smoke-'));
const results = [];

// The markers this gate plants belong to the APP, not to the gate: a run that
// dies before step 3b must not leave `public/hot` behind - a stale marker makes
// Laravel hand out dev-server asset URLs (404 fonts on the error page), and
// planting over a running `npm run dev` would also have eaten its marker.
// Snapshot the app's own bytes first and put them back in `finally`, whatever
// happened, instead of relying on the one step that removes them on success.
const hotPath = join(appRoot, 'public', 'hot');
const fontsDevPath = join(appRoot, 'public', 'fonts-manifest.dev.json');
const plantedMarkers = new Map([
  [hotPath, existsSync(hotPath) ? readFileSync(hotPath) : null],
  [fontsDevPath, existsSync(fontsDevPath) ? readFileSync(fontsDevPath) : null],
]);

function unplantMarkers() {
  for (const [path, bytes] of plantedMarkers) {
    try {
      if (bytes === null) rmSync(path, { force: true });
      else writeFileSync(path, bytes);
    } catch {
      /* best effort on Windows */
    }
  }
}

// `process.exit()` does NOT unwind the stack (`try { process.exit() } finally
// {}` never runs the finally), so the report path must clean up explicitly;
// the `finally` below only covers a throw that escapes the steps.
function cleanup() {
  unplantMarkers();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
}

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

  // 3a. the Vite dev markers a running `npm run dev` leaves behind. Planted
  //     BEFORE the build on purpose: `public/hot` decides dev-vs-build for
  //     `@vite`, so a build that does not set it aside bakes the dev-server
  //     fonts/asset URLs into the compiled contexts (measured: 10 error view
  //     contexts carried `http://[::1]:5173/__laravel_vite_plugin__/fonts/...`)
  //     and copies the marker into the document root.
  step('the Vite dev markers are planted before the build', () => {
    writeFileSync(hotPath, 'http://localhost:5173\n');
    const buildFonts = join(appRoot, 'public', 'build', 'fonts-manifest.json');
    if (existsSync(buildFonts)) {
      copyFileSync(buildFonts, fontsDevPath);
    }
  });

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

  // 3b. and they must not survive it: `hot` is set aside for the WHOLE build
  //     (the compile phase reads `@vite` long after the prerender) and restored
  //     at the end, while neither it nor the dev font map is copied into the
  //     document root. What a consumer sees when this breaks is a 404 on the
  //     marker and an error page that pulls its fonts from a localhost that is
  //     not there.
  step('the Vite dev markers stay out of dist/ (and public/hot comes back)', () => {
    const shipped = ['hot', 'hot.edge-build-aside', 'fonts-manifest.dev.json'].filter((name) =>
      existsSync(join(appRoot, 'dist', 'public', name))
    );
    if (shipped.length) throw new Error(`dist/public shipped a dev marker: ${shipped.join(', ')}`);
    if (!existsSync(join(appRoot, 'public', 'hot'))) throw new Error('the build did not put public/hot back');
    const baked = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.mjs$/.test(ent.name)) {
          const src = readFileSync(p, 'utf8');
          if (src.includes(':5173') || src.includes('__laravel_vite_plugin__')) baked.push(p.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(appRoot, 'dist', 'src'));
    if (baked.length) throw new Error(`a dev URL was baked into the compiled output: ${baked.join(', ')}`);
    console.log('  no dev marker in dist/public, no dev URL in dist/src, public/hot restored');
  });

  // 3c. the 404 body. `_routes.json` is an include allowlist, so a path outside it is
  //     answered by the ASSETS layer and never reaches the worker — the app's own 404
  //     page has to BE an asset for that answer to have a body
  //     (`assets.not_found_handling: "404-page"` serves the nearest 404.html). Measured
  //     on a live app without it: `GET /nonexistent-route-for-404` -> 404, 0 B, while
  //     PHP answers the app's own page (docs/EVIDENCE.md finding 2).
  step('the edge 404 page ships as an asset', () => {
    const page = join(appRoot, 'dist', 'public', '404.html');
    if (!existsSync(page)) {
      throw new Error('dist/public/404.html is missing — a path outside _routes.json answers an empty 404');
    }
    const html = readFileSync(page, 'utf8');
    if (!/<!DOCTYPE\s+html/i.test(html)) throw new Error(`dist/public/404.html is not an HTML document (${html.length} bytes)`);
    console.log(`  dist/public/404.html ships (${Buffer.byteLength(html)} bytes)`);
  });

  // 4. the cron gate on the BUILT worker. `POST /__lw/cron` is the schedule's
  //    HTTP face (src/worker.mjs:163-177); the dist only exists after step 3,
  //    so this cannot be a unit test - `src/worker.mjs` imports
  //    `*.generated.mjs`, which does not exist in the repo. Without
  //    `LW_CRON_SECRET` the path must stay indistinguishable from a missing
  //    route, and the secret must actually open it (not a blanket 404).
  step('the built worker: /__lw/cron is closed without the secret', () => {
    const worker = join(appRoot, 'dist', 'src', 'worker.mjs');
    if (!existsSync(worker)) throw new Error(`no built worker at ${worker}`);
    const script = `
const mod = await import(${JSON.stringify(pathToFileURL(worker).href)});
const handler = mod.default || mod;
const post = (headers, env) =>
  handler.fetch(new Request('https://edge.test/__lw/cron', { method: 'POST', headers }), env || {}, {});
const bare = await post({});
if (bare.status !== 404) { console.error('no secret: ' + bare.status + ' (want 404)'); process.exit(1); }
const wrong = await post({ 'x-lw-cron': 'nope' }, { LW_CRON_SECRET: 'sekret' });
if (wrong.status !== 404) { console.error('wrong secret: ' + wrong.status + ' (want 404)'); process.exit(1); }
let opened = 'threw';
try {
  opened = String((await post({ 'x-lw-cron': 'sekret' }, { LW_CRON_SECRET: 'sekret' })).status);
} catch (e) {
  opened = 'threw (' + e.message + ')';
}
// The schedule itself needs the D1 binding, absent here: any answer but 404
// proves the gate opened (a 404 would mean it never does).
if (opened === '404') { console.error('right secret: the gate never opens'); process.exit(1); }
console.log('  no secret 404, wrong secret 404, right secret -> ' + opened);
`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: appRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.trim());
  });

  // 5. the compiler import (php-parser must resolve from the consumer install)
  step('the installed compiler imports (php-parser resolves)', () => {
    const url = pathToFileURL(join(pkg, 'compiler', 'src', 'transpiler.mjs')).href;
    execFileSync(process.execPath, ['-e', `import('${url}').then(()=>0).catch(e=>{console.error(e.message);process.exit(1)})`], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  // 6. the shadow harness, when the package ships a scenario for this app
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
  cleanup();
  process.exit(failed.length ? 1 : 0);
} finally {
  cleanup();
}
