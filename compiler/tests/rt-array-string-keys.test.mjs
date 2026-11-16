#!/usr/bin/env node
// compiler/tests/rt-array-string-keys.test.mjs — P3 regression.
//
// The transpiler emits `$a = []; $a['k3'] = 3; ...` as a JS Array with
// computed property writes (transpiler.mjs txAssignStatement), so `length`
// stays 0 while the three PHP values live as own string-key properties.
// Every PHP-key reader must see them, in key order, without regressing a
// normal list or an ordered assoc literal (rt.assoc / __lwOrder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRt } from '../runtime/rt-from-context.mjs';

// Exactly the shape the emitter produces for the /misc/collection controller.
const writtenArray = () => {
  const a = [];
  a['k3'] = 3;
  a['k1'] = 1;
  a['k2'] = 2;
  return a;
};

const makeRt = () => buildRt({}, { strict: false });

test('rt-array-keys: string-key writes into `[]` are read by every PHP-key helper', () => {
  const rt = makeRt();
  const a = writtenArray();
  assert.deepEqual(rt.array_values(a), [3, 1, 2]);
  assert.equal(rt.count(a), 3);
  assert.equal(rt.empty(a), false);
  assert.deepEqual(rt.array_keys(a), ['k3', 'k1', 'k2']);
  assert.deepEqual(rt.entries(a), [['k3', 3], ['k1', 1], ['k2', 2]]);
  assert.equal(rt.implode(',', a), '3,1,2');
  assert.equal(rt.array_sum(a), 6);
  assert.equal(rt.json_encode(a), '{"k3":3,"k1":1,"k2":2}');
  assert.equal(rt.in_array(1, a), true);
  assert.equal(rt.looseEq(a, { k1: 1, k2: 2, k3: 3 }), true);
  assert.equal(rt.json_encode(rt.array_merge(a, ['x'])), '{"k3":3,"k1":1,"k2":2,"0":"x"}');
});

test('rt-array-keys: collect()->count() sees the same three values', () => {
  const rt = makeRt();
  const c = rt.collect(writtenArray());
  assert.equal(c.count(), 3);
  assert.deepEqual(c.keys().all(), ['k3', 'k1', 'k2']);
  assert.deepEqual(c.all(), { k3: 3, k1: 1, k2: 2 });
});

test('rt-array-keys: plain lists and ordered assoc literals keep their old answers', () => {
  const rt = makeRt();
  const list = [3, 1, 2];
  assert.deepEqual(rt.array_values(list), [3, 1, 2]);
  assert.equal(rt.count(list), 3);
  assert.equal(rt.empty(list), false);
  assert.equal(rt.array_sum(list), 6);
  assert.equal(rt.json_encode(list), '[3,1,2]');
  assert.equal(rt.json_encode(rt.array_merge([1, 2], [3])), '[1,2,3]');

  // A literal that mixes int-like and string keys carries PHP's order in
  // __lwOrder; none of the fixes above may replace it with JS key order.
  const mixed = rt.assoc([['id', 1], ['0', 'z']]);
  assert.deepEqual(rt.array_values(mixed), [1, 'z']);
  assert.deepEqual(rt.entries(mixed), [['id', 1], [0, 'z']]);
  assert.equal(rt.json_encode(mixed), '{"id":1,"0":"z"}');
  assert.equal(rt.collect(mixed).count(), 2);
});

test('rt-array-keys: emitted fixture matches the PHP oracle byte-for-byte', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '../..');
  const fixture = join(here, 'corpus/cases/array-values-string-key-writes.php');
  const expected = readFileSync(join(here, 'corpus/expectations/array-values-string-key-writes.txt'));
  const scratch = mkdtempSync(join(tmpdir(), 'lw-array-keys-'));
  const dump = join(scratch, 'dump.json');
  const out = join(scratch, 'out.mjs');
  writeFileSync(dump, JSON.stringify({ view: 'case', compiled: readFileSync(fixture, 'utf8'), context: {} }));
  execFileSync(process.execPath, [join(repo, 'compiler/bin/transpile.mjs'), dump, '--json', '--out', out],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const mod = await import(pathToFileURL(out).href + '?t=' + Date.now());
  const rt = buildRt({}, { strict: false });
  mod.default(rt);
  assert.deepEqual(Buffer.from(rt.__output, 'utf8'), expected);
});
