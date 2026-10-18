import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePorts, serializeRegistry } from '../../tools/registry-json.mjs';

test('mergePorts adds missing ports and keeps existing mappings', () => {
  const before = { autoSnapshot: true, ports: { '/existing': 'existing' } };
  const { registry, added } = mergePorts(before, [
    { route: '/dbcheck', slug: 'dbcheck' },
    { route: '/existing', slug: 'renamed' },
  ]);
  assert.deepEqual(added, [{ route: '/dbcheck', slug: 'dbcheck' }]);
  assert.deepEqual(registry.ports, { '/existing': 'existing', '/dbcheck': 'dbcheck' });
  assert.equal(before.ports['/dbcheck'], undefined, 'input registry is not mutated');
});

test('mergePorts tolerates a missing ports section', () => {
  const { registry, added } = mergePorts({}, [{ route: '/x', slug: 'x' }]);
  assert.deepEqual(added, [{ route: '/x', slug: 'x' }]);
  assert.deepEqual(registry.ports, { '/x': 'x' });
  assert.equal(registry.autoSnapshot, undefined);
});

test('serializeRegistry round-trips and ends with a newline', () => {
  const reg = { autoSnapshot: true, ports: { '/dbcheck': 'dbcheck' } };
  const text = serializeRegistry(reg);
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(text), reg);
});
