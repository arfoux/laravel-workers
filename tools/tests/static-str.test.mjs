// The build-time config evaluator (`tools/static.mjs`) answers `Str::slug()` /
// `Str::ascii()` with the KERNEL's portable-ascii tables, so a config file and
// the runtime cannot drift (audit #294 / #451: `Str::ascii` used to be absent
// from the evaluator's method map and folded to `undefined`, which the config
// dump wrote as `null` while the runtime answered the real value).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { evalConfigExpr, parsePhpFile, returnExpr } from '../static.mjs';

const ev = (expr) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-static-str-'));
  const file = join(dir, 'config.php');
  writeFileSync(file, '<?php\nreturn ' + expr + ';\n', 'utf8');
  const parsed = parsePhpFile(file);
  try {
    return evalConfigExpr(returnExpr(parsed), { env: {}, appDir: dir, parsed });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('static: Str::slug folds like PHP 8.3 (the probed values)', () => {
  assert.equal(ev("Str::slug('žluťoučký')"), 'zlutoucky');
  assert.equal(ev("Str::slug('Łódź')"), 'lodz');
  assert.equal(ev("Str::slug('Ελληνικά')"), 'ellinika');
  assert.equal(ev("Str::slug('@@')"), 'at-at');
  assert.equal(ev("Str::slug('中文x')"), 'x');
  assert.equal(ev("Str::slug('A  &  B')"), 'a-b');
  assert.equal(ev("Str::slug('A  &  B', '_')"), 'a_b');
  assert.equal(ev("Str::slug(\"it's\")"), 'its');
});

test('static: Str::ascii is the kernel table, not a missing method', () => {
  assert.equal(ev("Str::ascii('žluťoučký')"), 'zlutoucky');
  assert.equal(ev("Str::ascii('Łódź')"), 'Lodz');
  assert.equal(ev("Str::ascii('Ελληνικά')"), 'Ellinika');
  assert.equal(ev("Str::ascii('ff')"), 'ff');
  assert.equal(ev("Str::ascii('中文')"), '');
  assert.equal(ev("Str::ascii('İstanbul')"), 'Istanbul');
});

test('static: an un-ported Str:: method fails loud instead of dropping the entry (audit #608)', () => {
  // Before: `Str::<unknown>()` answered `undefined`, which the array branch
  // DROPPED — the config key silently vanished where PHP boots with a value.
  assert.throws(() => ev("Str::notAMethod('x')"), /not implemented by the build-time config evaluator/);
  // A MAPPED method still evaluates (no over-broad throw).
  assert.equal(ev("Str::slug('Hello World')"), 'hello-world');
});

test('static: storage_path joins with the platform separator (audit #607)', () => {
  // PHP's storage_path() = realpath(storage) . DIRECTORY_SEPARATOR . $path; the
  // tool used a literal `\\`, so on POSIX it answered
  // `...\storage\framework/sessions` where PHP answers `.../storage/framework/…`.
  const dir = mkdtempSync(join(tmpdir(), 'lw-static-path-'));
  const file = join(dir, 'config.php');
  writeFileSync(file, '<?php\nreturn [\n  storage_path(),\n  storage_path("framework/sessions"),\n];\n', 'utf8');
  const parsed = parsePhpFile(file);
  let out;
  try {
    out = evalConfigExpr(returnExpr(parsed), { env: {}, appDir: dir, parsed });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(out[0], join(dir, 'storage'));
  assert.equal(out[1], join(dir, 'storage') + sep + 'framework/sessions');
  // The path argument keeps its forward slash (PHP does not rewrite it).
  assert.ok(out[1].endsWith('framework/sessions'));
});
