// tools/tests/order-json.test.mjs — PHP insertion order survives the build-time
// JSON boundary (#416).
//
// config-dump.mjs writes the runtime config as JSON and build.mjs reads it
// back; a plain JSON.stringify drops the non-enumerable `__lwOrder` marker, so
// a `config/*.php` shaped `[-1 => 'm', 'n']` reached the edge misordered. This
// proves `serializeOrdered`/`deserializeOrdered`/`configModuleSource` carry the
// marker end to end, and that the kernel's phpJsonEncode then re-emits PHP's
// order (not JS enumeration order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serializeOrdered, deserializeOrdered, configModuleSource } from '../../tools/order-json.mjs';
import { phpJsonEncode } from '../../kernel/php-json.mjs';

/** A PHP-assoc-shaped object: integer-like keys, PHP insertion order. */
function phpAssoc(pairs) {
  const o = {};
  for (const [k, v] of pairs) o[String(k)] = v;
  Object.defineProperty(o, '__lwOrder', { value: pairs.map(([k]) => String(k)), enumerable: false });
  return o;
}

test('serialize -> deserialize keeps values, types and PHP order', () => {
  const dump = {
    'app.name': 'Demo',
    'app.debug': false,
    'session.lifetime': 120,
    cfg: phpAssoc([[-1, 'm'], ['n', null]]),
    nested: { a: phpAssoc([[5, 'five'], [0, 'zero']]) },
  };
  const back = deserializeOrdered(serializeOrdered(dump));
  assert.equal(phpJsonEncode(back), phpJsonEncode(dump));
  // The order marker is non-enumerable, exactly as config values expect.
  assert.deepEqual(back.cfg.__lwOrder, ['-1', 'n']);
  assert.deepEqual(Object.keys(back.cfg), ['-1', 'n']);
});

test('a plain JS JSON.stringify would LOSE the order (the bug this fixes)', () => {
  // PHP order 'b',0; JS enumerates the non-negative integer key 0 FIRST.
  const obj = phpAssoc([['b', 1], [0, 2]]);
  const plain = JSON.parse(JSON.stringify(obj));
  assert.equal(plain.__lwOrder, undefined);
  assert.notEqual(phpJsonEncode(plain), phpJsonEncode(obj));
});

test('configModuleSource re-attaches the marker when the module loads', async () => {
  const value = {
    'filesystems.disks': phpAssoc([['zeta', 'a'], ['alpha', 'b']]),
    'app.key': 'base64:AAAA',
  };
  const p = join(tmpdir(), `lw-order-json-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(p, configModuleSource(value));
  try {
    const mod = await import(pathToFileURL(p).href);
    assert.equal(phpJsonEncode(mod.default), phpJsonEncode(value));
    assert.deepEqual(mod.default['filesystems.disks'].__lwOrder, ['zeta', 'alpha']);
  } finally {
    unlinkSync(p);
  }
});

test('a config value that legitimately contains the transport key survives', () => {
  const dump = { evil: { '__lw$o': 'not-a-wrapper', v: 1 }, ok: 2 };
  const back = deserializeOrdered(serializeOrdered(dump));
  assert.deepEqual(back.evil, { '__lw$o': 'not-a-wrapper', v: 1 });
  assert.equal(back.ok, 2);
});
