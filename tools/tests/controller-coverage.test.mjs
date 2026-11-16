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
import { BLOCK } from '../readiness.mjs';
import {
  hasBlockingControllerSkips,
  controllerSkipFinding,
  controllerStubEntries,
  dedupeControllerSkips,
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
    severity: BLOCK,
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

test('extra-verb middleware and unparseable-action skips name the cause and survive dedupe', () => {
  const middlewareReason = 'middleware [unhonoured] not transpiled';
  const actionReason = `unparseable controller action ${JSON.stringify('Foo@not-a-method')}`;
  // These are the exact record inputs the two new extra-verb `continue`
  // branches in build.mjs hand to recordControllerSkip().
  const skips = [
    { route: '/login', verb: 'POST', reason: middlewareReason },
    { route: '/login', verb: 'PUT', reason: actionReason },
  ];
  const deduped = dedupeControllerSkips(skips);
  assert.deepEqual(deduped, skips);
  const findings = deduped.map(controllerSkipFinding);
  assert.equal(findings.length, 2);
  assert.match(findings[0].cause, /middleware \[unhonoured\] not transpiled/);
  assert.match(findings[1].cause, /unparseable controller action "Foo@not-a-method"/);
  assert.equal(findings[0].fix, 'write a port for POST /login (build --scaffold), or ignore the route with a reason');
});

test('dedupe keeps one finding per route+verb and appends distinct reasons', () => {
  const deduped = dedupeControllerSkips([
    { route: '/edge', verb: 'POST', reason: 'first' },
    { route: '/edge', verb: 'post', reason: 'second' },
    { route: '/edge', verb: 'POST', reason: 'second' },
  ]);
  assert.deepEqual(deduped, [{ route: '/edge', verb: 'POST', reason: 'first; second' }]);
  assert.equal(controllerSkipFinding(deduped[0]).cause, 'controller could not be compiled: first; second');
});

test('dedupe prefers needsPort and partial reasons over a colliding controller skip', () => {
  assert.deepEqual(
    dedupeControllerSkips(
      [
        { route: '/edge', verb: 'GET', reason: 'controller failed' },
        { route: '/edge', verb: 'POST', reason: 'controller failed too' },
      ],
      {
        needsPort: [{ route: '/edge', reason: 'HTTP 500' }],
        partials: [{ route: '/edge', methods: ['POST'] }],
        mainVerbFor: () => 'GET',
      }
    ),
    []
  );
});

test('dedupe preserves distinct verbs and routes', () => {
  const skips = [
    { route: '/edge', verb: 'POST', reason: 'a' },
    { route: '/edge', verb: 'PATCH', reason: 'b' },
    { route: '/other', verb: 'POST', reason: 'c' },
  ];
  assert.deepEqual(dedupeControllerSkips(skips), skips);
});
