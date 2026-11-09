// tools/tests/vendor-dir.test.mjs — LW_VENDOR_DIR must be a real resolver, not
// a hint, for EVERY path that reaches into vendor.
//
// An app with no `vendor/` of its own reaches the framework through
// LW_VENDOR_DIR (vendor-lite's cache, or a vendor mounted elsewhere) — the
// layout vendor-lite exists for. Two tools hard-coded `<app>/vendor` and so
// silently lost the framework for exactly that app (#647):
//
//   * tools/config-dump.mjs — the framework's TRANSLATION files
//     (`src/Illuminate/Translation/lang`). Losing them made
//     `config.translations` `{}`, so every framework validation message fell
//     back to the KEY and `__('auth.failed')` answered `auth.failed` instead of
//     the sentence.
//   * tools/static.mjs `classFile()` — `vendor/composer/autoload_psr4.php`.
//     Losing it left every vendor FQCN (a parent class, a trait) unresolved, so
//     the build could not follow a class into the framework.
//
// The config defaults already accepted two layouts
// (tools/static.mjs:1593-1600), and the PHP path shares that resolver
// (`lw_vendor_autoload_for()` in tools/_root.php): `<LW_VENDOR_DIR>/...` and
// `<LW_VENDOR_DIR>/vendor/...`. Both tools must resolve the same two.
//
// The vendor-less app is a temporary tree with everything EXCEPT `vendor/`
// (the fixture holds ~1 GB of dependencies, so they are never copied). When the
// app or a reachable framework copy is missing the tests SKIP with the reason —
// the repo's convention for oracle tests: never fail on a missing prerequisite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleAppRoot } from '../../kernel/tests/oracle-app.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const dumpMjs = path.join(pkgDir, 'tools', 'config-dump.mjs');

const APP = oracleAppRoot();

// The framework's translation dir under a vendor root of either layout: the
// variable may name the vendor directory itself or a project dir holding one.
function frameworkLangUnder(vendorRoot) {
  if (!vendorRoot) return null;
  for (const rel of [
    ['laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang'],
    ['vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang'],
  ]) {
    const dir = path.join(vendorRoot, ...rel);
    if (existsSync(dir)) return { vendorRoot, dir };
  }
  return null;
}

const FOUND =
  frameworkLangUnder(APP && path.join(APP, 'vendor')) ||
  frameworkLangUnder(process.env.LW_VENDOR_DIR);

const skipReason = !APP
  ? 'vendor-dir.test.mjs: no Laravel app (set LW_LARAVEL_APP) - skipped'
  : !FOUND
    ? 'vendor-dir.test.mjs: no framework files reachable (app vendor/ or LW_VENDOR_DIR) - skipped'
    : false;

const runDump = (appDir, env) =>
  JSON.parse(
    execFileSync(process.execPath, [dumpMjs, appDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LW_APP_ROOT: appDir, LW_VENDOR_DIR: '', ...env },
    })
  );

// A copy of the app WITHOUT its vendor/ tree — the app's own sources, config and
// composer.json come along; the ~1 GB of dependencies do not.
function vendorlessApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-novendor-'));
  for (const name of readdirSync(APP)) {
    if (name === 'vendor') continue;
    try {
      cpSync(path.join(APP, name), path.join(dir, name), { recursive: true, force: true });
    } catch {
      /* a locked file in the fixture must not fail the test */
    }
  }
  return dir;
}

test('config-dump: a vendor-less app resolves translations through LW_VENDOR_DIR', { skip: skipReason }, () => {
  const app = vendorlessApp();
  try {
    assert.ok(!existsSync(path.join(app, 'vendor')), 'the fixture must have no vendor/ of its own');
    const dump = runDump(app, { LW_VENDOR_DIR: FOUND.vendorRoot });
    const locales = Object.keys(dump.translations || {});
    // The bug: hard-coding `<app>/vendor` answered `{}` here.
    assert.ok(locales.length > 0, 'translations must not be empty when LW_VENDOR_DIR reaches the framework');
    const withValidation = locales.filter((l) => dump.translations[l]?.validation);
    assert.ok(withValidation.length, `framework validation messages must be present (locales: ${locales.join(', ')})`);
    const first = withValidation[0];
    const required = dump.translations[first].validation.required;
    assert.ok(
      typeof required === 'string' && required.length > 0 && !/^validation\./.test(required),
      `validation.required must be a sentence, not the key (got ${JSON.stringify(required)})`
    );
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('config-dump: with no variable the FRAMEWORK is not reachable (control)', { skip: skipReason }, () => {
  // The control has to isolate the framework, because the app's OWN `lang/`
  // needs no vendor at all: `config-dump.mjs:171-176` reads `<app>/lang` (and
  // `resources/lang`) unconditionally, so an app that ships translations
  // answers its own locales here — and an earlier version of this test
  // asserted `translations == {}`, which made a local `LW_LARAVEL_APP` pointing
  // at such an app (measured: `['en','id']`) fail the control. The invariant
  // that actually separates the two states is the framework's `validation`
  // group: `Illuminate\Translation\lang` lives under the vendor dir, and
  // `FileLoader` merges framework-first / app-last. Without a reachable
  // framework the app's own group survives and `validation.required` is the
  // bare KEY (or absent), never a sentence.
  const app = vendorlessApp();
  try {
    const dump = runDump(app, {});
    const locales = Object.keys(dump.translations || {});
    const withFrameworkMessage = locales.filter((l) => {
      const required = dump.translations[l]?.validation?.required;
      return typeof required === 'string' && required !== 'validation.required';
    });
    assert.deepEqual(
      withFrameworkMessage,
      [],
      `no variable, no reachable framework -> no locale may carry the framework's validation text ` +
        `(locales in the dump: ${locales.join(', ') || 'none'})`
    );
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('classFile: a vendor-less app resolves a vendor FQCN through LW_VENDOR_DIR', { skip: skipReason }, async () => {
  // classFile is pure (no PHP/child process), so it is called in-process. The
  // variable is the only way to reach the framework here.
  const { classFile } = await import('../static.mjs');
  const app = vendorlessApp();
  const prev = process.env.LW_VENDOR_DIR;
  try {
    process.env.LW_VENDOR_DIR = FOUND.vendorRoot;
    const model = classFile(app, 'Illuminate\\Database\\Eloquent\\Model');
    assert.ok(model, 'a framework FQCN must resolve when LW_VENDOR_DIR reaches the framework');
    assert.ok(existsSync(model), `the resolved path must exist (got ${model})`);
    assert.ok(!path.resolve(model).startsWith(path.resolve(app) + path.sep), 'it must come from the vendor tree, not the app');

    // Control: without the variable the same FQCN is unreachable.
    delete process.env.LW_VENDOR_DIR;
    assert.equal(classFile(app, 'Illuminate\\Database\\Eloquent\\Model'), null, 'no variable -> no vendor class');
  } finally {
    if (prev === undefined) delete process.env.LW_VENDOR_DIR;
    else process.env.LW_VENDOR_DIR = prev;
    rmSync(app, { recursive: true, force: true });
  }
});
