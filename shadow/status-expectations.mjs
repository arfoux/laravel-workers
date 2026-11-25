// shadow/status-expectations.mjs — pure status-expectation rules for the
// shadow harness. No I/O and no import from run.mjs, so the harness and its
// tests read the same definitions.
//
// `expectStatus` is the legacy spelling: BOTH sides must answer that status.
// `expectPhpStatus` / `expectJsStatus` name each side separately, which is what
// makes a documented divergence (e.g. PHP 200, worker 422) provable. Either
// spelling validates a divergence; a lone new field is enforced but does NOT
// count as validated.

function declared(value) {
  return value !== undefined;
}

// Returns { ok, phpOk, jsOk, validated } for the statuses a step actually
// answered. With no declared field `ok` is true (an unvalidated step behaves
// exactly as it did before these fields existed).
export function statusExpectations(step, phpStatus, jsStatus) {
  const s = step && typeof step === 'object' ? step : {};
  const legacy = declared(s.expectStatus);
  const hasPhp = declared(s.expectPhpStatus);
  const hasJs = declared(s.expectJsStatus);
  // Enforce every declared expectation; never silently drop one because a
  // different spelling is also present.
  const phpOk =
    (!legacy || phpStatus === s.expectStatus) &&
    (!hasPhp || phpStatus === s.expectPhpStatus);
  const jsOk =
    (!legacy || jsStatus === s.expectStatus) &&
    (!hasJs || jsStatus === s.expectJsStatus);
  return {
    ok: phpOk && jsOk,
    phpOk,
    jsOk,
    validated: legacy || (hasPhp && hasJs),
  };
}

// A divergence is a result the harness explicitly marked as a known one.
// `validated` counts those with the legacy status or BOTH per-side fields.
export function divergenceStatusCoverage(results) {
  let validated = 0;
  let total = 0;
  for (const r of Array.isArray(results) ? results : []) {
    if (typeof r?.verdict !== 'string' || !r.verdict.startsWith('diverges')) continue;
    total++;
    if (statusExpectations(r, r.phpStatus, r.jsStatus).validated) validated++;
  }
  return { validated, total, ratio: total === 0 ? 0 : validated / total };
}

// The two non-byte verdicts share the same expectation gates as the byte-match
// branch. Keeping them here makes the rules testable without booting the app:
// a `shape` step proves the body's SHAPE, not that its declared status/header/
// mail expectations were ignored; a known divergence proves the statuses and
// headers, and must still honour body/mail expectations. `statusOk` is
// deliberately absent from the divergence gate — a divergence means the two
// sides answer different statuses.
export function verdictGates(g) {
  const x = g && typeof g === 'object' ? g : {};
  const headerDiff = Array.isArray(x.headerDiff) ? x.headerDiff : [];
  return {
    shapeVerified:
      x.shapeOk === true &&
      x.statusOk === true &&
      headerDiff.length === 0 &&
      x.expectBodyOk === true &&
      x.expectStatusOk === true &&
      x.expectHeaderOk === true &&
      x.expectMailsOk === true,
    knownDivergence:
      x.expected === 'diverges' &&
      x.expectStatusOk === true &&
      x.expectHeaderOk === true &&
      x.expectBodyOk === true &&
      x.expectMailsOk === true,
  };
}
