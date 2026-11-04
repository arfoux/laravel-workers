// tools/tests/guard-ports.test.mjs — the registry `guards` seam.
//
// A guard driver the app registers itself (`Auth::extend('seal', fn)`) is PHP
// app code the compiled rung cannot execute. The build either refuses it (the
// guarded route would answer for an unauthenticated request) or delegates it to
// app-supplied JS — `ports/<slug>.mjs` — and says so. These tests pin the three
// halves of that promise: the registry parse, the build verdict, and the module
// the worker imports (which must actually resolve the port by driver name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluateGuardConfig,
  guardPortEntries,
  guardPortsModuleSource,
  guardProblemMessage,
} from '../ports.mjs';

test('guard ports: the registry map is parsed as driver → port file', () => {
  const { entries, errors } = guardPortEntries({ guards: { seal: 'seal-guard', ldap: 'ldap' } });
  assert.deepEqual(entries, [
    ['seal', 'seal-guard'],
    ['ldap', 'ldap'],
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(guardPortEntries({}).entries, [], 'no "guards" key → no ports');
  assert.deepEqual(guardPortEntries(null).errors, [], 'a missing registry is not an error here');
});

test('guard ports: a "guards" value that is not an object is refused, not iterated', () => {
  // Object.entries('seal') is [['0','s'],['1','e'],...]: iterating a typo would
  // invent a driver named "0" and then fail on a missing `s.mjs`. Refuse it.
  const asString = guardPortEntries({ guards: 'seal' });
  assert.deepEqual(asString.entries, []);
  assert.match(asString.errors[0], /must be an object of driver → port name.*not a string/s);
  const asArray = guardPortEntries({ guards: ['seal'] });
  assert.deepEqual(asArray.entries, []);
  assert.match(asArray.errors[0], /not an array/);
  const asNumber = guardPortEntries({ guards: 7 });
  assert.match(asNumber.errors[0], /not a number/);
  assert.deepEqual(guardPortEntries({ guards: null }).errors, [], 'an explicit null is "no ports"');
});

test('guard ports: a port for the compiled session driver is refused', () => {
  const { entries, errors } = guardPortEntries({ guards: { session: 'x' } });
  assert.deepEqual(entries, [], 'the session driver never becomes a port');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"session" driver/);
});

test('guard ports: an empty name or a path-shaped slug is refused', () => {
  assert.match(guardPortEntries({ guards: { seal: '' } }).errors[0], /driver → port name/);
  assert.match(guardPortEntries({ guards: { '': 'x' } }).errors[0], /driver → port name/);
  assert.match(guardPortEntries({ guards: { seal: '../evil' } }).errors[0], /bare file name/);
  assert.match(guardPortEntries({ guards: { seal: 'a/b' } }).errors[0], /bare file name/);
  assert.deepEqual(guardPortEntries({ guards: { seal: '../evil' } }).entries, []);
});

test('guard ports: an unported non-session driver is a build problem, naming the port', () => {
  const config = {
    'auth.defaults.guard': 'seal',
    'auth.guards.seal': { driver: 'seal' },
    'auth.guards.web': { driver: 'session', provider: 'users' },
  };
  const verdict = evaluateGuardConfig(config, []);
  assert.deepEqual(verdict.problems, [{ key: 'auth.guards.seal', driver: 'seal' }]);
  assert.deepEqual(verdict.notes, []);

  const message = guardProblemMessage(verdict.problems);
  assert.match(message, /auth\.guards\.seal \(driver 'seal'\)/);
  assert.match(message, /registry\.json \{"guards": \{"seal": "<slug>"\}\}/);
  assert.match(message, /guarded route would answer for an unauthenticated request/);
});

test('guard ports: a ported driver is a declared note, not a problem', () => {
  const verdict = evaluateGuardConfig({ 'auth.guards.seal': { driver: 'seal' } }, ['seal']);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.notes.length, 1);
  assert.equal(verdict.notes[0].key, 'auth.guards.seal');
  assert.equal(verdict.notes[0].driver, 'seal');
  assert.match(verdict.notes[0].cause, /app's guard port answers it/);
  assert.match(verdict.notes[0].fix, /shadow\/run\.mjs/);
  assert.deepEqual(verdict.unused, []);
});

test('guard ports: the compiled session driver never needs a port', () => {
  const verdict = evaluateGuardConfig(
    { 'auth.defaults.guard': 'web', 'auth.guards.web': { driver: 'session', provider: 'users' } },
    []
  );
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.notes, []);
  assert.deepEqual(verdict.unused, []);
});

test('guard ports: a port no guard uses is reported (a typo, not a protection)', () => {
  const verdict = evaluateGuardConfig({ 'auth.guards.web': { driver: 'session' } }, ['seal']);
  assert.deepEqual(verdict.unused, ['seal']);
  assert.deepEqual(verdict.problems, []);
});

test('guard ports: the generated module imports each port statically', () => {
  const source = guardPortsModuleSource([
    ['seal', 'seal-guard'],
    ['weird key', 'other'],
  ]);
  assert.match(source, /^\/\/ generated by build\.mjs/m);
  assert.match(source, /import guardPort0 from '\.\/ports\/seal-guard\.mjs';/);
  assert.match(source, /import guardPort1 from '\.\/ports\/other\.mjs';/);
  assert.match(source, /export const guardPorts = \{/);
  assert.match(source, /"seal": guardPort0,/);
  assert.match(source, /"weird key": guardPort1,/);

  const empty = guardPortsModuleSource([]);
  assert.match(empty, /export const guardPorts = \{\n\};/);
  assert.doesNotMatch(empty, /^import /m, 'no drivers → no imports');
});

test('guard ports: the generated module resolves each port by its driver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-guard-ports-'));
  try {
    mkdirSync(join(dir, 'ports'));
    writeFileSync(join(dir, 'ports', 'seal-guard.mjs'), "export default { marker: 'seal' };\n");
    writeFileSync(join(dir, 'ports', 'ldap.mjs'), "export default { marker: 'ldap' };\n");
    writeFileSync(
      join(dir, 'guard-ports.generated.mjs'),
      guardPortsModuleSource([
        ['seal', 'seal-guard'],
        ['ldap', 'ldap'],
      ])
    );

    const mod = await import(pathToFileURL(join(dir, 'guard-ports.generated.mjs')).href);
    assert.equal(mod.guardPorts.seal.marker, 'seal');
    assert.equal(mod.guardPorts.ldap.marker, 'ldap');
    assert.deepEqual(Object.keys(mod.guardPorts), ['seal', 'ldap']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
