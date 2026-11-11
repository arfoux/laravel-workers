// tools/config-gate.mjs — the config keys the compiled artifact reads vs the dump.
//
// The gate that shipped first asked only about LITERAL `rt.config("x.y")` and
// declared a dynamic read "not checkable here" — true for the key, false for the
// PREFIX: under a prefix the dump carries no key for, `config('app.' . $k)`
// throws for EVERY value of $k, which is the 500 the literal check exists to
// prevent. These pin the scan and both verdicts (S25), including the exact-own-key
// contract that the runtime (`rt-from-context.mjs`) and the gate share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanConfigReads, configGateMissing } from '../config-gate.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'lw-config-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const reads = (literal = [], dynamicPrefix = []) => ({
  literal: new Set(literal),
  dynamicPrefix: new Set(dynamicPrefix),
});

test('the scan collects literal keys and dynamic prefixes, .mjs files only', () => {
  const root = fixture({
    'src/a.mjs': 'const a = rt.config("app.name");\nconst b = rt.config(\'cache.default\');\n',
    'src/nested/b.mjs': 'const c = rt.config(rt.concat("services.", v_k));\n',
    // Neither of these is compiled JS the worker runs: not scanned.
    'src/c.json': 'rt.config("from.json")',
    'src/d.mjs.txt': 'rt.config("from.txt")',
  });
  try {
    const found = scanConfigReads(root);
    assert.deepEqual([...found.literal].sort(), ['app.name', 'cache.default']);
    // The dynamic form must NOT also register as a literal key.
    assert.deepEqual([...found.dynamicPrefix], ['services.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a literal key the dump lacks is reported; one it carries is not', () => {
  const dump = { 'app.name': 'x', 'app.debug': false };
  assert.deepEqual(configGateMissing(reads(['app.name', 'app.missing', 'other.key']), dump), {
    missing: ['app.missing', 'other.key'],
    uncovered: [],
  });
});

test('the dump answers an exact own key only: reading the bare prefix is a miss', () => {
  // `rt.config("app")` answers null in Laravel and throws here: the dump is flat.
  assert.deepEqual(configGateMissing(reads(['app']), { 'app.name': 'x' }).missing, ['app']);
});

test('a dump key named like an Object member is still a miss', () => {
  // The check must be hasOwnProperty, not `key in dump` / `dump[key]`.
  assert.deepEqual(configGateMissing(reads(['toString', 'hasOwnProperty']), {}).missing, [
    'hasOwnProperty',
    'toString',
  ]);
});

test('a dynamic prefix is a miss only when no dump key lives under it', () => {
  const dump = { 'app.name': 'x', 'services.stripe.key': 'k' };
  const { uncovered } = configGateMissing(reads([], ['app.', 'services.', 'services.stripe.', 'absent.']), dump);
  assert.deepEqual(uncovered, ['absent.']);
});

test('a fully dynamic key (a variable, no literal prefix) is out of the gate\'s reach', () => {
  // `config($k)` compiles to `rt.config(v_k)`: neither key nor prefix is a
  // literal, so the scan sees nothing and the gate stays silent - a documented
  // limit, not a pass.
  const root = fixture({ 'src/a.mjs': 'const v = rt.config(v_k);\n' });
  try {
    const found = scanConfigReads(root);
    assert.equal(found.literal.size, 0);
    assert.equal(found.dynamicPrefix.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
