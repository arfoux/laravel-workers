import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectD1Target,
  inspectWranglerAccount,
  inspectWranglerName,
  JsoncError,
  parseJsonc,
  setWranglerName,
  updateWranglerD1Id,
} from '../jsonc.mjs';

const DB_ID = '9e355138-3a4c-4f5d-9b6e-2a1f0c7d8e9a';
const OTHER_ID = '11111111-2222-3333-4444-555555555555';

test('JSONC accepts comments, trailing commas, BOM and nested values', () => {
  const text = '\ufeff{\n'
    + '  // a line comment\n'
    + '  "name": "my-app",\n'
    + '  "d1_databases": [\n'
    + '    { "binding": "DB", "database_name": "my-app-db", "database_id": "REPLACE_WITH_D1_ID" },\n'
    + '  ],\n'
    + '  /* block comment */\n'
    + '  "observability": { "enabled": true },\n'
    + '}\n';
  const root = parseJsonc(text);
  assert.equal(root.type, 'object');
  assert.equal(root.entries.find((e) => e.key === 'name').value.value, 'my-app');
  assert.equal(inspectWranglerName(text).status, 'ok');
  assert.equal(inspectD1Target(text, 'my-app-db').status, 'placeholder');
});

test('JSONC rejects malformed input with a useful line and column', () => {
  assert.throws(
    () => parseJsonc('{\n  "name": "x",\n  "d1_databases": [ }\n}'),
    (error) => error instanceof JsoncError
      && /line 3/.test(error.message)
      && /column/.test(error.message),
  );
  assert.throws(() => parseJsonc('{\n  /* unterminated\n'), /unterminated block comment/);
  assert.throws(() => parseJsonc('{ "name": "x" } trailing'), /trailing content/);
  assert.throws(() => parseJsonc('{ "name": "x",, }'), /expected/);
});

test('setWranglerName changes only the name value and keeps comments', () => {
  const text = '{\n  // keep me\n  "name": "old-app",\n  "d1_databases": [\n'
    + '    { "database_name": "old-app-db", "database_id": "REPLACE_WITH_D1_ID" },\n'
    + '  ],\n}\n';
  const result = setWranglerName(text, 'new-app');
  assert.equal(result.status, 'set');
  assert.match(result.text, /\/\/ keep me/);
  assert.match(result.text, /"name": "new-app"/);
  assert.match(result.text, /"database_name": "old-app-db"/);
  assert.equal(setWranglerName(result.text, 'new-app').status, 'already');
});

test('name inspection refuses duplicates and non-strings', () => {
  assert.equal(inspectWranglerName('{ "name": "a", "name": "b" }').status, 'duplicate');
  assert.equal(inspectWranglerName('{ "name": 7 }').status, 'invalid');
  assert.equal(inspectWranglerName('{ "main": "x" }').status, 'missing');
  assert.equal(inspectWranglerName('[]').status, 'not-object');
});

test('account_id inspection reads only the top-level field', () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(inspectWranglerAccount(`{\n  // account_id: "fake"\n  "account_id": "${id}",\n}`).id, id);
  assert.equal(inspectWranglerAccount('{ "name": "x" }').status, 'missing');
  assert.equal(inspectWranglerAccount('{ "account_id": "a", "account_id": "b" }').status, 'duplicate');
  assert.equal(inspectWranglerAccount('{ "account_id": 7 }').status, 'invalid');
  assert.equal(inspectWranglerAccount('[]').status, 'not-object');
  assert.equal(inspectWranglerAccount('{ "env": { "account_id": "nested" } }').status, 'missing');
});

test('D1 injection picks the entry by name in a multi-entry config', () => {
  const text = `{
  // first database must not move
  "d1_databases": [
    { "binding": "OLD", "database_name": "old-db", "database_id": "${OTHER_ID}" },
    { "binding": "DB", "database_name": "app-db", "database_id": "${OTHER_ID}" },
  ],
}`;
  const result = updateWranglerD1Id(text, 'app-db', DB_ID);
  assert.equal(result.status, 'updated');
  assert.equal(inspectD1Target(result.text, 'old-db').id, OTHER_ID);
  assert.equal(inspectD1Target(result.text, 'app-db').id, DB_ID);
  assert.match(result.text, /first database must not move/);
});

test('placeholder injection rewrites its database_name and id, not the first entry', () => {
  const text = `{
  "d1_databases": [
    { "binding": "OTHER", "database_name": "other-db", "database_id": "${OTHER_ID}" },
    { "binding": "DB", "database_name": "generated-db", "database_id": "REPLACE_WITH_D1_ID" },
  ],
}`;
  const result = updateWranglerD1Id(text, 'renamed-db', DB_ID);
  assert.equal(result.status, 'set');
  assert.equal(inspectD1Target(result.text, 'other-db').id, OTHER_ID);
  const renamed = inspectD1Target(result.text, 'renamed-db');
  assert.equal(renamed.status, 'ok');
  assert.equal(renamed.id, DB_ID);
  assert.doesNotMatch(result.text, /REPLACE_WITH_D1_ID/);
});

test('placeholder without a name, outside d1, or duplicated is refused', () => {
  const noName = '{ "d1_databases": [ { "binding": "DB", "database_id": "REPLACE_WITH_D1_ID" } ] }';
  assert.equal(inspectD1Target(noName, 'app-db').status, 'missing-name');
  assert.equal(updateWranglerD1Id(noName, 'app-db', DB_ID).status, 'missing-name');

  const outside = '{ "note": "REPLACE_WITH_D1_ID", "d1_databases": [ { "database_name": "app-db", "database_id": "x" } ] }';
  assert.equal(inspectD1Target(outside, 'app-db').status, 'placeholder-outside');

  const ambiguous = '{ "d1_databases": [ { "database_name": "a", "database_id": "REPLACE_WITH_D1_ID" }, { "database_name": "b", "database_id": "REPLACE_WITH_D1_ID" } ] }';
  assert.equal(inspectD1Target(ambiguous, 'a').status, 'ambiguous');
});

test('D1 target inspection distinguishes missing arrays, entries, and ids', () => {
  assert.equal(inspectD1Target('{ "name": "x" }', 'app-db').status, 'no-d1');
  assert.equal(inspectD1Target('{ "d1_databases": {} }', 'app-db').status, 'invalid-d1');
  assert.equal(inspectD1Target('{ "d1_databases": [] }', 'app-db').status, 'no-entry');
  assert.equal(
    inspectD1Target('{ "d1_databases": [ { "database_name": "app-db" } ] }', 'app-db').status,
    'missing-id',
  );
  assert.equal(
    inspectD1Target('{ "d1_databases": [ { "database_name": "app-db", "database_id": 7 } ] }', 'app-db').status,
    'missing-id',
  );
});

test('comments that look like fields do not become D1 entries', () => {
  const text = `{
  // "d1_databases": [ { "database_name": "fake", "database_id": "REPLACE_WITH_D1_ID" } ]
  "d1_databases": [
    { "database_name": "real-db", "database_id": "${DB_ID}" },
  ],
}`;
  assert.equal(inspectD1Target(text, 'real-db').status, 'ok');
  assert.equal(inspectD1Target(text, 'fake').status, 'no-entry');
});
