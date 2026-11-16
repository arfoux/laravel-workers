// tools/controller-coverage.mjs — the coverage decision for controllers the
// transpiler refused to emit.
//
// A `continue` in build.mjs's emit loop used to leave no trace: the route was
// absent from the Worker, yet `--strict` printed "all routes handled" and
// exited 0 (P7). The build now records every skip as
// `{ route, verb, reason }` and asks this module how that changes the verdict,
// the finding and the `--scaffold` stubs. Kept separate from build.mjs so the
// decision can be pinned by a fast unit test instead of a 4-minute app build.

import { BLOCK } from './readiness.mjs';

export const hasBlockingControllerSkips = (failedControllers) => failedControllers.length > 0;
export const controllerSkipFinding = ({ route, verb, reason }) => ({
  route,
  area: 'route',
  severity: BLOCK,
  cause: `controller could not be compiled: ${reason}`,
  fix: `write a port for ${verb} ${route} (build --scaffold), or ignore the route with a reason`,
});

export const controllerStubEntries = (needsPort, failedControllers, { slugifyRoute, extraVerbsFor = () => [] }) => {
  const byRoute = new Map();
  for (const { route } of needsPort) byRoute.set(route, { route, verb: 'GET', slug: slugifyRoute(route) });
  for (const { route, verb } of failedControllers) {
    // An extra verb gets the same `--verb` suffix the normal emit path uses,
    // so the stub cannot collide with the base route's handler.
    const slug = extraVerbsFor(route).includes(verb)
      ? `${slugifyRoute(route)}--${String(verb).toLowerCase()}`
      : slugifyRoute(route);
    if (!byRoute.has(route)) byRoute.set(route, { route, verb: String(verb).toUpperCase(), slug });
  }
  return [...byRoute.values()];
};
const skipKey = (route, verb) => `${String(verb).toUpperCase()} ${route}`;

// One finding per route+verb. `needsPort` and `partials` already produce a
// BLOCK finding that names the route (and the partial names the verb), so a
// controller skip for the SAME route+verb must not produce a second row that
// contradicts it. Two controller skips for the same route+verb collapse into
// the first record, with any distinct later reasons appended.
export const dedupeControllerSkips = (
  failedControllers,
  { needsPort = [], partials = [], mainVerbFor = () => 'GET' } = {}
) => {
  const alreadyReported = new Set();
  for (const n of needsPort) {
    const verb = mainVerbFor(n.route);
    if (verb) alreadyReported.add(skipKey(n.route, verb));
  }
  for (const p of partials) {
    for (const verb of p.methods || []) alreadyReported.add(skipKey(p.route, verb));
  }

  const result = [];
  const byKey = new Map();
  for (const f of failedControllers) {
    const verb = String(f.verb || 'GET').toUpperCase();
    const key = skipKey(f.route, verb);
    if (alreadyReported.has(key)) continue;
    const prior = byKey.get(key);
    if (prior) {
      if (!prior.reasons.includes(f.reason)) {
        prior.reasons.push(f.reason);
        prior.skip.reason = prior.reasons.join('; ');
      }
      continue;
    }
    const skip = { ...f, verb };
    byKey.set(key, { skip, reasons: [f.reason] });
    result.push(skip);
  }
  return result;
};
