// tools/tests/verify-fix.test.mjs
// Regression coverage for the verify command fixes:
//   1. verify boots through the shared resolvePhp (versioned interpreters work)
//   2. a missing compiled-hash registry is a FAIL, never silently bootstrapped
//   3. --pin-sha / LW_VERIFY_PIN_SHA=1 is the only write path to the app tree
//
// The PHP-level tests build a tiny fake Laravel app in a temp dir: just enough
// surface for tools/verify-s0.php to boot and recompute its 15 checks. No real
// Laravel dependency is needed, so they run in any checkout that has PHP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpCandidates, probePhp, resolvePhp } from '../php-runtime.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifyPhp = join(pkgDir, 'tools', 'verify-s0.php');
const cli = join(pkgDir, 'bin', 'laravel-workers.mjs');

const PHP = process.env.PHP_BIN || 'php';
const phpOk = spawnSync(PHP, ['-r', 'echo PHP_VERSION;'], { stdio: 'ignore' }).status === 0;
const phpSkip = phpOk ? false : 'no PHP interpreter on PATH (set PHP_BIN)';

const COMPILED = "<?php echo url('/foo'); ?>";
const REGISTRY = 'edge/notes/welcome.compiled.sha256.txt';
const REPORT = 'edge/notes/s0-verify.txt';

// Context that matches exactly what the stubbed app below recomputes, so a
// registry failure is isolated from field mismatches.
const context = {
  app: { version: '11.0.0', locale: 'en' },
  config: { 'app.name': 'Demo', 'app.locale': 'en' },
  vite: { fonts: '', invoke: '' },
  files: { 'build/manifest.json': false, 'build/fonts-manifest.json': false, hot: false },
  auth: { check: false },
  routes: [],
  route_names: [],
  urls: { '/foo': 'https://example.test/foo' },
  app_version: '11.0.0',
  vfs: { 'build/manifest.json': false, 'build/fonts-manifest.json': false, hot: false },
};

// Minimal autoloader: only the classes/functions verify-s0.php touches.
const AUTOLOAD = String.raw`<?php
namespace Illuminate\Contracts\Http {
  interface Kernel { public function handle($request); public function terminate($request, $response); }
}
namespace Illuminate\Http {
  class Request { public static function create($uri, $method) { return new self(); } }
}
namespace Illuminate\Foundation {
  class Vite { public function __invoke($args = null) { return ''; } }
}
namespace {
  class FakeRouter { public function getRoutes() { return []; } }
  class FakeKernel implements \Illuminate\Contracts\Http\Kernel {
    public function handle($request) { return 'ok'; }
    public function terminate($request, $response) {}
  }
  class FakeApp {
    public function make($abstract) {
      if ($abstract === \Illuminate\Contracts\Http\Kernel::class) return new FakeKernel();
      if ($abstract === 'router') return new FakeRouter();
      if ($abstract === \Illuminate\Foundation\Vite::class) return new \Illuminate\Foundation\Vite();
      return null;
    }
    public function version() { return '11.0.0'; }
    public function getLocale() { return 'en'; }
    public function forgetInstance($abstract) {}
  }
  function config($key) { return $key === 'app.name' ? 'Demo' : 'en'; }
  function public_path($file) { return '/nonexistent/' . $file; }
  function url($path) { return 'https://example.test' . $path; }
  function auth() { return new class { public function guard() { return new class { public function check() { return false; } }; } }; }
}
`;

function makeApp({ withDump = true } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'lw-verify-fix-'));
  mkdirSync(join(app, 'bootstrap'), { recursive: true });
  mkdirSync(join(app, 'vendor'), { recursive: true });
  mkdirSync(join(app, 'edge', '.cache'), { recursive: true });
  writeFileSync(join(app, 'artisan'), "#!/usr/bin/env php\n");
  writeFileSync(join(app, 'composer.json'), JSON.stringify({ require: { php: '^8.3' } }));
  writeFileSync(join(app, 'vendor', 'autoload.php'), AUTOLOAD);
  writeFileSync(join(app, 'bootstrap', 'app.php'), "<?php\nreturn new \\FakeApp();\n");
  if (withDump) {
    writeFileSync(join(app, 'edge', '.cache', 'welcome.compiled.json'),
      JSON.stringify({ compiled: COMPILED, context }));
  }
  return app;
}

function runVerify(app, args = [], extraEnv = {}) {
  const env = { ...process.env, LW_APP_ROOT: app };
  delete env.LW_VERIFY_PIN_SHA;
  Object.assign(env, extraEnv);
  return spawnSync(PHP, [verifyPhp, ...args], { cwd: app, env, encoding: 'utf8' });
}

function runCli(app, args = [], extraEnv = {}) {
  const env = { ...process.env };
  delete env.PHP_BIN;
  delete env.LW_VERIFY_PIN_SHA;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cli, 'verify', ...args], { cwd: app, env, encoding: 'utf8' });
}

test('versioned resolution: resolvePhp picks php8.3 when php is unusable', () => {
  const probe = (bin) => (bin === 'php' ? null : bin === 'php8.2' ? '8.2.10' : '8.3.30');
  const list = () => [{ bin: 'php8.2', source: 'PATH' }, { bin: 'php8.3', source: 'PATH' }];
  assert.deepEqual(resolvePhp({ requirement: '^8.3', explicit: '', probe, list }), {
    bin: 'php8.3', version: '8.3.30', source: 'PATH',
  });
  assert.throws(
    () => resolvePhp({ requirement: '^8.3', explicit: '', probe, list: () => [{ bin: 'php8.2', source: 'PATH' }] }),
    /no installed PHP can boot this app/
  );
});

test('CLI verify routes through the shared resolver and forwards flags', () => {
  const src = readFileSync(cli, 'utf8');
  const branch = src.slice(
    src.indexOf("} else if (cmd === 'verify') {"),
    src.indexOf("} else if (cmd === 'deploy') {")
  );
  assert.match(branch, /resolvePhp\(\{ requirement: phpRequirement \}\)/);
  assert.match(branch, /run\(phpBin, \[verifyPath, \.\.\.process\.argv\.slice\(3\)\]/);
  assert.doesNotMatch(branch, /process\.env\.PHP_BIN \|\| 'php'/);
});

test('missing sha registry fails even when every field check passes', phpSkip, () => {
  const app = makeApp();
  try {
    const r = runVerify(app);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /VERIFY-S0: FAIL \(15\/16 checks\)/);
    assert.match(r.stdout, /compiled sha256 registry missing/);
    assert.equal(existsSync(join(app, REGISTRY)), false, 'must not auto-create the baseline');
    assert.equal(existsSync(join(app, REPORT)), false, 'must not write a report on a normal run');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--pin-sha pins a baseline, then a changed dump fails the registry', phpSkip, () => {
  const app = makeApp();
  try {
    const pinned = runVerify(app, ['--pin-sha']);
    assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
    assert.match(pinned.stdout, /PINNED sha registry/);
    assert.match(pinned.stdout, /VERIFY-S0: PASS \(16\/16 checks\)/);

    const expected = createHash('sha256').update(COMPILED).digest('hex') +
      '  ' + Buffer.byteLength(COMPILED) + ' bytes';
    assert.equal(readFileSync(join(app, REGISTRY), 'utf8').trim(), expected);
    assert.equal(existsSync(join(app, REPORT)), false, 'report write was removed');

    const dumpPath = join(app, 'edge', '.cache', 'welcome.compiled.json');
    writeFileSync(dumpPath, JSON.stringify({ compiled: COMPILED + '<!--tamper-->', context }));
    const after = runVerify(app);
    assert.equal(after.status, 1, after.stdout + after.stderr);
    assert.match(after.stdout, /compiled sha256 mismatch/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('LW_VERIFY_PIN_SHA=1 opts in to the same baseline write', phpSkip, () => {
  const app = makeApp();
  try {
    const r = runVerify(app, [], { LW_VERIFY_PIN_SHA: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PINNED sha registry/);
    assert.equal(existsSync(join(app, REGISTRY)), true);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('absent dump still SKIPs with exit 0', phpSkip, () => {
  const app = makeApp({ withDump: false });
  try {
    const r = runVerify(app);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /VERIFY-S0: SKIP/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('CLI still SKIPs when no Laravel vendor is present', () => {
  const empty = mkdtempSync(join(tmpdir(), 'lw-verify-skip-'));
  try {
    const r = runCli(empty);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /VERIFY-S0: SKIP/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('CLI boots via an installed interpreter when php is not on PATH', phpSkip, () => {
  const installed = phpCandidates().find((c) => isAbsolute(c.bin) && probePhp(c.bin));
  if (!installed) return; // no non-PATH interpreter on this machine
  const app = makeApp();
  try {
    assert.equal(runVerify(app, ['--pin-sha']).status, 0);
    const r = runCli(app, [], { PATH: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /VERIFY-S0: PASS/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--json still enforces the registry gate, with stdout kept to one JSON value', phpSkip, () => {
  const app = makeApp();
  try {
    const r = runVerify(app, ['--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /compiled sha256 registry missing/);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout must be exactly one JSON line');
    const json = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(json).sort(), [
      'app', 'app_version', 'auth', 'config', 'files',
      'route_names', 'routes', 'urls', 'vfs', 'vite',
    ]);
    assert.equal(json.app.version, '11.0.0');
    assert.equal(json.urls['/foo'], 'https://example.test/foo');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--json enforces the FIELD checks too, not just the sha registry', phpSkip, () => {
  const app = makeApp();
  try {
    mkdirSync(join(app, 'edge', 'notes'), { recursive: true });
    const dumpPath = join(app, 'edge', '.cache', 'welcome.compiled.json');
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    dump.context.app.version = 'DRIFT';
    writeFileSync(dumpPath, JSON.stringify(dump));
    // Pin the current (drifted) compiled hash so the registry gate passes and
    // ONLY a field mismatch can fail the run.
    const sha = createHash('sha256').update(COMPILED).digest('hex');
    writeFileSync(join(app, REGISTRY), `${sha}  ${Buffer.byteLength(COMPILED)} bytes\n`);

    const r = runVerify(app, ['--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL\s+app\.version/);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout must stay one JSON value');
    assert.equal(JSON.parse(r.stdout).app.version, '11.0.0', 'stdout still carries the recomputed truth');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--json --pin-sha pins a baseline and keeps the same stdout shape', phpSkip, () => {
  const app = makeApp();
  try {
    const r = runVerify(app, ['--json', '--pin-sha']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /PINNED sha registry/);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout must be exactly one JSON line');
    assert.equal(JSON.parse(r.stdout).app.version, '11.0.0');
    assert.equal(existsSync(join(app, REGISTRY)), true);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
