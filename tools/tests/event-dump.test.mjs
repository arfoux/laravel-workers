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
// conventional `parity-app` / `e2e-app` directories at the repo root. Without
// one it SKIPS with the reason (the repo's convention for the oracle tests) - it
// never fails. The fixture classes are written into the app's own `app/` tree
// (the app autoloads them through its PSR-4 prefix) and removed again, like
// formrequest-dump.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { oracleAppRoot } from '../../kernel/tests/oracle-app.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const dumpMjs = path.join(pkgDir, 'tools', 'event-dump.mjs');
const dumpPhp = path.join(pkgDir, 'tools', 'event-dump.php');
const PHP = process.env.PHP_BIN || 'php';

// The app the oracle parity runs against (shared resolver, see the header).
const APP = oracleAppRoot();

// The dumps record the app's absolute file paths, and the two runtimes can
// disagree about what that path IS: PHP's realpath() answers the target of a
// symlink or a Windows junction, the port echoes the path it was handed.
// Normalising exactly those roots (nothing else) keeps the byte-for-byte
// comparison strict for the rest of the dump.
function realAppRoot(app) {
  try {
    return realpathSync(app);
  } catch {
    return app;
  }
}
const APP_PATH_FORMS = APP
  ? [...new Set([APP, realAppRoot(APP)])].map((root) => JSON.stringify(root).slice(1, -1))
  : [];
const withoutAppRoot = (s) => APP_PATH_FORMS.reduce((acc, form) => acc.split(form).join('<APP>'), s);

function hasPhp() {
  try {
    execFileSync(PHP, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = false;

// The binding tests install their `$this->app->bind()` calls into the app's
// REGISTERED provider (the PHP oracle boots it, so the container really binds
// them). An app whose provider declares no `register(): void` (a hand-made
// fixture, e.g. the audit app) has nowhere to put them: the tests then SKIP
// with the reason instead of running the probe against an unbound container and
// reporting the port as broken — the repo's rule for oracle tests is "skip with
// a reason, never fail on a missing prerequisite".
function bindingFixtureSkip() {
  if (!APP || !PROVIDER_FILE || !existsSync(PROVIDER_FILE)) {
    return 'event-dump.test.mjs: the app has no app/Providers/AppServiceProvider.php - the binding fixtures are skipped';
  }
  const support = ['AbstractReporter.php', 'ListenerContract.php'].map((f) =>
    path.join(APP, 'app', 'Support', f)
  );
  const missing = support.filter((p) => !existsSync(p));
  if (missing.length) {
    // The probe job type-hints both forms; without the classes the container
    // cannot resolve them and the dump answers `external` for a fixture reason.
    return `event-dump.test.mjs: the app has no ${missing
      .map((p) => path.relative(APP, p))
      .join(', ')} - the container-binding fixtures are skipped`;
  }
  try {
    return readFileSync(PROVIDER_FILE, 'utf8').includes('    public function register(): void')
      ? false
      : `event-dump.test.mjs: ${PROVIDER_FILE} declares no \`register(): void\` - the container-binding fixtures are skipped`;
  } catch {
    return 'event-dump.test.mjs: the app provider could not be read - the binding fixtures are skipped';
  }
}

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

// The reason the oracle tests cannot run here, or `false`. Computed AFTER the
// fixture paths exist (the binding fixtures need the app's provider to declare
// `register()` — see `bindingFixtureSkip` above).
const skipReason = !APP
  ? 'event-dump.test.mjs: no Laravel app (set LW_LARAVEL_APP to a Laravel 13 app with vendor/) ' +
    '- the event dump test is skipped'
  : bindingFixtureSkip();

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
  // `bindingFixtureSkip` (module scope) already turned this into a SKIP: the
  // app's provider has no `register()` for the bindings to go into, and running
  // the probe against an unbound container would report the port as broken for
  // a fixture reason (this really happened against the audit fixture, whose
  // AppServiceProvider declares no `register()`).
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

test('event-dump: a bound interface/abstract parameter resolves to its impl', { skip: skipReason }, () => {
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

test('event-dump: the port matches the PHP oracle byte for byte', { skip: skipReason || (hasPhp() ? false : `event-dump.test.mjs: no PHP (${PHP}) - skipped`) }, () => {
  installFixtures();
  try {
    const mjs = runDump(process.execPath, [dumpMjs, APP]);
    const php = runDump(PHP, [dumpPhp, APP]);
    assert.equal(withoutAppRoot(mjs), withoutAppRoot(php));
  } finally {
    removeFixtures();
  }
});

test('event-dump: the positional app root wins over a stray LW_APP_ROOT', { skip: skipReason }, () => {
  // The PHP oracle reads `$argv[1]` only. The port used to read `LW_APP_ROOT`
  // FIRST, so an ambient `LW_APP_ROOT` (the documented way to point the other
  // dump tools at an app) silently redirected this dump to a different app than
  // the caller named - and the parity test above then compared two different
  // apps byte for byte. Point `LW_APP_ROOT` at a directory that is NOT a Laravel
  // app: with the bug the dump reads the decoy and finds no event, with the fix
  // the positional argument is honoured.
  const decoy = os.tmpdir();
  const out = JSON.parse(
    execFileSync(process.execPath, [dumpMjs, APP], {
      encoding: 'utf8',
      env: { ...process.env, LW_APP_ROOT: decoy },
    })
  );
  const file = String(out.events['App\\Events\\PostPublished']?.file || '').replace(/\\/g, '/');
  assert.ok(
    file.startsWith(APP.replace(/\\/g, '/')),
    `the dump must read the positional app (${APP}), not the LW_APP_ROOT decoy (got ${file || '<no PostPublished event>'})`
  );
});
