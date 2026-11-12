// tools/tests/route-gaps.test.mjs — the pairing between the reason a route was
// not handled (built by `SKIP_REASONS`/`RUNTIME_REASONS`) and the fix it maps to
// (`needsPortFix`).
//
// The two halves used to live apart in build.mjs and were bound by string
// `startsWith` only: editing a produced message dropped the readiness line to
// the generic "write a port" fallback with no test to catch it. Every reason a
// producer can emit must map to a SPECIFIC fix; only an unknown reason may take
// the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_REASONS, RUNTIME_REASONS, needsPortFix } from '../../tools/route-gaps.mjs';

const GENERIC = 'write a port (build --scaffold)';

/** The fix for a produced reason, on a route named `/x`. */
const fixFor = (reason, isRuntimeBindingError) =>
  needsPortFix({ route: '/x', reason }, isRuntimeBindingError);

test('every SKIP_REASONS producer maps to a specific fix', () => {
  const cases = [
    [SKIP_REASONS.autoSnapshotOff(), 'autoSnapshot": false'],
    [SKIP_REASONS.noGet('POST'), 'has no GET to snapshot'],
    [SKIP_REASONS.noGet(''), 'has no GET to snapshot'],
    [SKIP_REASONS.dynamic(), 'dynamic segments'],
    [SKIP_REASONS.controller(), 'did not compile'],
  ];
  for (const [reason, needle] of cases) {
    const fix = fixFor(reason);
    assert.ok(fix.includes(needle), `${JSON.stringify(reason)} -> ${JSON.stringify(fix)} misses ${JSON.stringify(needle)}`);
  }
});

test('every RUNTIME_REASONS producer maps to a specific fix', () => {
  assert.match(fixFor(RUNTIME_REASONS.nonHtml(200, 'application/json')), /not an HTML page/);
  assert.match(fixFor(RUNTIME_REASONS.nonHtml(204, '')), /not an HTML page/);
  // A redirect -> the redirect fix.
  assert.match(fixFor(RUNTIME_REASONS.http(302, ' -> /login')), /redirects/);
  // A 4xx -> the parameter/auth fix.
  assert.match(fixFor(RUNTIME_REASONS.http(403, '')), /parameter or auth/);
  // A 5xx -> the app-bug fix.
  assert.match(fixFor(RUNTIME_REASONS.http(500, ': boom')), /bug the build found for free/);
});

test('a 5xx whose cause is a runtime binding is named as a build-ENVIRONMENT gap', () => {
  const reason = RUNTIME_REASONS.http(500, ': SQLSTATE connection refused');
  const fix = fixFor(reason, () => true);
  assert.match(fix, /build-ENVIRONMENT gap/);
  assert.match(fix, /live D1 connection/);
});

test('a missing-table 5xx appends the migrate hint', () => {
  const fix = fixFor(RUNTIME_REASONS.http(500, ': no such table: users'));
  assert.match(fix, /php artisan migrate/);
});

test('an unrecognized reason takes the generic fallback, and it names the ignore escape', () => {
  const fix = fixFor('something new the producers do not emit');
  assert.ok(fix.startsWith(GENERIC));
  assert.ok(fix.includes('{"ignore": {"/x"'));
});

test('the fix always names the route-scoped ignore escape where one applies', () => {
  assert.ok(fixFor(SKIP_REASONS.dynamic()).includes('{"ignore": {"/x"'));
  assert.ok(fixFor(RUNTIME_REASONS.nonHtml(200, 'text/plain')).includes('{"ignore": {"/x"'));
});
