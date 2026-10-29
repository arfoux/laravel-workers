// tools/tests/event-dump.test.mjs — the event dump READ the container bindings.
//
// tools/event-dump.mjs is the pure-JS port of tools/event-dump.php (the build
// runs the port: build.mjs calls tools/event-dump.mjs). The port scanned the
// app's providers for `bind()`/`singleton()` to learn which concrete class an
// INTERFACE (or an abstract class) constructor parameter resolves to, and the
// scan was dead twice over:
//
//   1. it parsed the provider with `require.presolve.parserClass`, which is
//      undefined in an ES module - the ReferenceError was swallowed by the
//      surrounding `try { ... } catch { continue; }`, so every provider was
//      skipped in silence;
//   2. the arguments are AST NODES, and `bind(Foo::class, Bar::class)` answers
//      a `staticlookup` node - compared against a string it never matched.
//
// The dump therefore reported kind "abstract" for a parameter the container
// resolves, and the build could not compile the dependency (the edge answered
// "the edge cannot inject one" for a service the app had bound). The PHP oracle
// had the mirror-image hole: `$bindings[$name][0]` indexes an ASSOCIATIVE
// array (`['concrete' => Closure, 'shared' => bool]`), so `impl` was never
// emitted there either, and `class_exists()` alone mislabeled an interface as a
// framework class.
//
// The test needs a real Laravel app (PHP 8.3 + vendor/): LW_LARAVEL_APP, or the
// dev-machine default. Without one it SKIPS with the reason (the repo's
// convention for the oracle tests) - it never fails. The fixture classes are
// written into the app's own `app/` tree (the app autoloads them through its
// PSR-4 prefix) and removed again, like formrequest-dump.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const dumpMjs = path.join(pkgDir, 'tools', 'event-dump.mjs');
const dumpPhp = path.join(pkgDir, 'tools', 'event-dump.php');
const PHP = process.env.PHP_BIN || 'php';

const DEFAULT_APP_ROOT = 'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

function appRoot() {
  const app = process.env.LW_LARAVEL_APP || DEFAULT_APP_ROOT;
  if (!app) return null;
  if (!existsSync(path.join(app, 'vendor', 'autoload.php'))) return null;
  if (!existsSync(path.join(app, 'app'))) return null;
  return app;
}

const APP = appRoot();

function hasPhp() {
  try {
    execFileSync(PHP, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = !APP
  ? 'event-dump.test.mjs: no Laravel app (set LW_LARAVEL_APP to a Laravel 13 app with vendor/) ' +
    '- the event dump test is skipped'
  : false;

// The container binds BOTH shapes: an interface and an abstract class.
const REPORTER = `<?php

namespace App\\Services;

use App\\Support\\AbstractReporter;
use App\\Support\\ListenerContract;

class LwBindingReporter extends AbstractReporter implements ListenerContract
{
    public function report(): string
    {
        return 'ok';
    }

    public function handle($payload)
    {
        return $payload;
    }
}
`;

const JOB = `<?php

namespace App\\Jobs;

use App\\Support\\AbstractReporter;
use App\\Support\\ListenerContract;

class LwBindingProbeJob
{
    public function __construct(
        protected AbstractReporter $reporter,
        protected ListenerContract $contract,
        protected string $tag = 'probe',
    ) {}
}
`;

const REPORTER_FILE = APP ? path.join(APP, 'app', 'Services', 'LwBindingReporter.php') : null;
const JOB_FILE = APP ? path.join(APP, 'app', 'Jobs', 'LwBindingProbeJob.php') : null;
const PROVIDER_FILE = APP ? path.join(APP, 'app', 'Providers', 'AppServiceProvider.php') : null;
let providerBackup = null;

const BINDINGS = [
  '        $this->app->bind(\\App\\Support\\AbstractReporter::class, \\App\\Services\\LwBindingReporter::class);',
  '        $this->app->singleton(\\App\\Support\\ListenerContract::class, \\App\\Services\\LwBindingReporter::class);',
].join('\n');

function installFixtures() {
  if (!APP) return;
  if (!existsSync(REPORTER_FILE)) writeFileSync(REPORTER_FILE, REPORTER);
  if (!existsSync(JOB_FILE)) writeFileSync(JOB_FILE, JOB);
  // The bindings go into the app's REGISTERED provider (Laravel boots it, so
  // the PHP oracle sees them in the container).
  const src = readFileSync(PROVIDER_FILE, 'utf8');
  providerBackup = src;
  const marker = '    public function register(): void';
  const at = src.indexOf(marker);
  if (at === -1) return;
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  writeFileSync(PROVIDER_FILE, src.slice(0, close) + '\n' + BINDINGS + '\n' + src.slice(close));
}

function removeFixtures() {
  if (!APP) return;
  if (REPORTER_FILE) rmSync(REPORTER_FILE, { force: true });
  if (JOB_FILE) rmSync(JOB_FILE, { force: true });
  if (PROVIDER_FILE && providerBackup !== null) writeFileSync(PROVIDER_FILE, providerBackup);
  providerBackup = null;
}

after(removeFixtures);

const runDump = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('event-dump: a bound interface/abstract parameter resolves to its impl', { skip }, () => {
  installFixtures();
  try {
    const out = JSON.parse(runDump(process.execPath, [dumpMjs, APP]));

    const job = out.classes['App\\Jobs\\LwBindingProbeJob'];
    assert.ok(job, 'the dumping build must list the probe job');
    assert.deepEqual(job.ctor, [
      { name: 'reporter', type: 'App\\Support\\AbstractReporter', kind: 'class', impl: 'App\\Services\\LwBindingReporter' },
      { name: 'contract', type: 'App\\Support\\ListenerContract', kind: 'class', impl: 'App\\Services\\LwBindingReporter' },
      { name: 'tag', kind: 'builtin', type: 'string', default: 'probe' },
    ]);

    // The impl is part of the dependency graph: the build compiles it.
    assert.equal(out.classes['App\\Services\\LwBindingReporter']?.kind, 'service');
  } finally {
    removeFixtures();
  }
});

test('event-dump: the port matches the PHP oracle byte for byte', { skip: skip || (hasPhp() ? false : `event-dump.test.mjs: no PHP (${PHP}) - skipped`) }, () => {
  installFixtures();
  try {
    const mjs = runDump(process.execPath, [dumpMjs, APP]);
    const php = runDump(PHP, [dumpPhp, APP]);
    assert.equal(mjs, php);
  } finally {
    removeFixtures();
  }
});
