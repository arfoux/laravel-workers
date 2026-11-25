// tools/tests/shadow-status-expectations.test.mjs — the status proof rules used
// by the shadow harness. A documented divergence is only proven when its status
// is pinned on BOTH sides: the legacy `expectStatus`, or the pair
// `expectPhpStatus` + `expectJsStatus`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusExpectations,
  divergenceStatusCoverage,
  verdictGates,
} from '../../shadow/status-expectations.mjs';

const divergence = (extra) => ({
  label: 'a documented divergence',
  phpStatus: 200,
  jsStatus: 422,
  verdict: 'diverges (known)',
  ...extra,
});

test('status: a complete per-side pair matching both answers is validated', () => {
  const r = statusExpectations({ expectPhpStatus: 200, expectJsStatus: 422 }, 200, 422);
  assert.deepEqual(r, { ok: true, phpOk: true, jsOk: true, validated: true });
});

test('status: one side mismatching fails that side but stays validated', () => {
  const r = statusExpectations({ expectPhpStatus: 200, expectJsStatus: 422 }, 200, 500);
  assert.deepEqual(r, { ok: false, phpOk: true, jsOk: false, validated: true });
});

test('status: a step without any field keeps the old permissive behaviour', () => {
  const r = statusExpectations({}, 200, 422);
  assert.deepEqual(r, { ok: true, phpOk: true, jsOk: true, validated: false });
  // A lone new field is enforced, but does not make the divergence validated.
  assert.deepEqual(
    statusExpectations({ expectPhpStatus: 200 }, 200, 422),
    { ok: true, phpOk: true, jsOk: true, validated: false }
  );
  assert.deepEqual(
    statusExpectations({ expectJsStatus: 422 }, 200, 500),
    { ok: false, phpOk: true, jsOk: false, validated: false }
  );
});

test('status: the legacy expectStatus still pins both sides', () => {
  assert.deepEqual(
    statusExpectations({ expectStatus: 404 }, 404, 404),
    { ok: true, phpOk: true, jsOk: true, validated: true }
  );
  assert.deepEqual(
    statusExpectations({ expectStatus: 404 }, 404, 200),
    { ok: false, phpOk: true, jsOk: false, validated: true }
  );
});

test('divergence coverage: 0 of 2 validated', () => {
  const c = divergenceStatusCoverage([
    divergence({ why: 'bare divergence' }),
    // A lone per-side field is enforced but is not a validated divergence.
    divergence({ expectJsStatus: 422, jsStatus: 500 }),
  ]);
  assert.deepEqual(c, { validated: 0, total: 2, ratio: 0 });
});

test('divergence coverage: all validated, mixing both spellings', () => {
  const c = divergenceStatusCoverage([
    divergence({ expectPhpStatus: 200, expectJsStatus: 422 }),
    divergence({ expectStatus: 200, phpStatus: 200, jsStatus: 200 }),
  ]);
  assert.deepEqual(c, { validated: 2, total: 2, ratio: 1 });
});

test('divergence coverage: zero divergences is a zero ratio, not a pass', () => {
  assert.deepEqual(divergenceStatusCoverage([]), { validated: 0, total: 0, ratio: 0 });
  assert.deepEqual(
    divergenceStatusCoverage([{ label: 'matched step', verdict: 'match', phpStatus: 200, jsStatus: 200 }]),
    { validated: 0, total: 0, ratio: 0 }
  );
});

const gatesFor = (extra = {}) => ({
  expected: 'match',
  shapeOk: true,
  statusOk: true,
  headerDiff: [],
  expectBodyOk: true,
  expectStatusOk: true,
  expectHeaderOk: true,
  expectMailsOk: true,
  ...extra,
});

test('shape verdict requires declared status, header and mail expectations', () => {
  assert.equal(verdictGates(gatesFor()).shapeVerified, true);
  assert.equal(verdictGates(gatesFor({ expectStatusOk: false })).shapeVerified, false);
  assert.equal(verdictGates(gatesFor({ expectHeaderOk: false })).shapeVerified, false);
  assert.equal(verdictGates(gatesFor({ expectMailsOk: false })).shapeVerified, false);
  assert.equal(
    verdictGates(gatesFor({ headerDiff: [{ name: 'allow', php: 'GET', js: '' }] })).shapeVerified,
    false
  );
  assert.equal(verdictGates(gatesFor({ shapeOk: false })).shapeVerified, false);
});

test('divergence verdict requires body/mail expectations, never statusOk', () => {
  const d = gatesFor({ expected: 'diverges', statusOk: false });
  assert.equal(verdictGates(d).knownDivergence, true);
  assert.equal(verdictGates(d).shapeVerified, false);
  for (const field of ['expectStatusOk', 'expectHeaderOk', 'expectBodyOk', 'expectMailsOk']) {
    assert.equal(
      verdictGates({ ...d, [field]: false }).knownDivergence,
      false,
      `${field} must gate a known divergence`
    );
  }
  assert.equal(verdictGates(gatesFor()).knownDivergence, false);
});
