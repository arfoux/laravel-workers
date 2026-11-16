// tools/tests/controller-coverage.test.mjs — a controller the transpiler
// refused must not vanish from the coverage verdict (P7).
//
// build.mjs records every `continue` in its emit loop as
// `{ route, verb, reason }`. Before the fix, `POST /edge/upload` was skipped
// with LW002, no stub was written and --strict still printed "all routes
// handled" and exited 0. These tests pin the decision, the finding and the
// scaffold stub selection without booting a Laravel app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasBlockingControllerSkips,
  controllerSkipFinding,
  controllerStubEntries,
} from '../controller-coverage.mjs';

const slug = (route) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

test('controller skips block the build; no skips do not', () => {
  assert.equal(hasBlockingControllerSkips([]), false);
  assert.equal(
    hasBlockingControllerSkips([{ route: '/edge/upload', verb: 'POST', reason: 'LW002 $request->files' }]),
    true
  );
});

test('a skipped controller becomes a BLOCK finding naming the route and the port escape hatch', () => {
  const finding = controllerSkipFinding({
    route: '/edge/upload',
    verb: 'POST',
    reason: 'LW002 $request->files is not compiled',
  });
  assert.deepEqual(finding, {
    route: '/edge/upload',
    area: 'route',
    severity: 'BLOCK',
    cause: 'controller could not be compiled: LW002 $request->files is not compiled',
    fix: 'write a port for POST /edge/upload (build --scaffold), or ignore the route with a reason',
  });
});

test('scaffold stubs include failed controllers and deduplicate against needsPort', () => {
  const entries = controllerStubEntries(
    [{ route: '/other', reason: 'dynamic segment' }],
    [
      { route: '/edge/upload', verb: 'POST', reason: 'LW002' },
      { route: '/edge/upload', verb: 'POST', reason: 'same route, later skip' },
    ],
    { slugifyRoute: slug }
  );
  assert.deepEqual(entries, [
    { route: '/other', verb: 'GET', slug: 'other' },
    { route: '/edge/upload', verb: 'POST', slug: 'edge-upload' },
  ]);
});

test('an extra verb keeps its --verb suffix so the stub cannot shadow the base route', () => {
  const entries = controllerStubEntries(
    [],
    [{ route: '/posts', verb: 'PATCH', reason: 'the app configures CORS' }],
    { slugifyRoute: slug, extraVerbsFor: (route) => (route === '/posts' ? ['PATCH'] : []) }
  );
  assert.deepEqual(entries, [{ route: '/posts', verb: 'PATCH', slug: 'posts--patch' }]);
});
