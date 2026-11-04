// tools/tests/config-dump-merge.test.mjs — the lang merge is PHP's
// array_replace_recursive, per KEY (#719).
//
// `config-dump.mjs` merges the framework's translation group with the app's
// (`translations[locale][group] = deepMerge(framework, app)`), and the PHP dump
// it replaces merges with `array_replace_recursive` (config-dump.php:92-95).
// For a list-array the KEYS are the indices, so a shorter app list REPLACES the
// entries it names and leaves the rest standing — it does not drop them:
//
//   php -r "echo json_encode(array_replace_recursive(
//     ['a' => ['x','y','z']], ['a' => ['y2']]));"
//   -> {"a":["y2","y","z"]}
//   php -r "echo json_encode(array_replace_recursive(
//     ['deep' => ['k' => ['1','2'], 'keep' => 1]], ['deep' => ['k' => ['9']]]));"
//   -> {"deep":{"k":["9","2"],"keep":1}}
//
// The old `deepMerge` took the `else` branch whenever BOTH sides were arrays and
// replaced the whole list (`{"a":["y2"]}`), so a framework validation sentence
// the app did not override disappeared from the edge. These cases are the PHP
// output above, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../../tools/deep-merge.mjs';

test('a shorter list overrides per index, it does not drop the tail', () => {
  assert.deepEqual(deepMerge({ a: ['x', 'y', 'z'] }, { a: ['y2'] }), { a: ['y2', 'y', 'z'] });
  assert.deepEqual(deepMerge({ a: ['x', 'y', 'z'] }, { a: ['y2', 'z2'] }), { a: ['y2', 'z2', 'z'] });
});

test('a nested list merges per index at every depth (PHP: ["9","2"])', () => {
  assert.deepEqual(deepMerge({ deep: { k: ['1', '2'], keep: 1 } }, { deep: { k: ['9'] } }), {
    deep: { k: ['9', '2'], keep: 1 },
  });
});

test('a longer app list extends the framework list (array_replace_recursive appends)', () => {
  // php: array_replace_recursive(['a'=>['x']], ['a'=>['p','q']]) -> ["p","q"]
  assert.deepEqual(deepMerge({ a: ['x'] }, { a: ['p', 'q'] }), { a: ['p', 'q'] });
});

test('an assoc group still merges key by key and keeps untouched keys', () => {
  const framework = { required: 'The :attribute field is required.', size: { numeric: 'n', file: 'f' } };
  const app = { required: 'Wajib diisi.', size: { file: 'berkas' } };
  assert.deepEqual(deepMerge(framework, app), {
    required: 'Wajib diisi.',
    size: { numeric: 'n', file: 'berkas' },
  });
});

test('a scalar replaces an array and vice versa (PHP: b wins outright)', () => {
  assert.deepEqual(deepMerge({ a: ['x', 'y'] }, { a: 'flat' }), { a: 'flat' });
  assert.deepEqual(deepMerge({ a: 'flat' }, { a: ['x', 'y'] }), { a: ['x', 'y'] });
});

test('a list merged with an assoc array keeps both (PHP: 0,1 then k)', () => {
  // php: array_replace_recursive(['x','y'], ['k'=>1]) -> [0=>'x',1=>'y','k'=>1]
  const merged = deepMerge({ a: ['x', 'y'] }, { a: { k: 1 } }).a;
  assert.deepEqual([...merged], ['x', 'y']);
  assert.equal(merged.k, 1);
});

test('the merge does not mutate either input', () => {
  const a = { list: ['x', 'y'], obj: { k: 1 } };
  const b = { list: ['p'], obj: { j: 2 } };
  deepMerge(a, b);
  assert.deepEqual(a, { list: ['x', 'y'], obj: { k: 1 } });
  assert.deepEqual(b, { list: ['p'], obj: { j: 2 } });
});
