// tools/controller-coverage.mjs — the coverage decision for controllers the
// transpiler refused to emit.
//
// A `continue` in build.mjs's emit loop used to leave no trace: the route was
// absent from the Worker, yet `--strict` printed "all routes handled" and
// exited 0 (P7). The build now records every skip as
// `{ route, verb, reason }` and asks this module how that changes the verdict,
// the finding and the `--scaffold` stubs. Kept separate from build.mjs so the
// decision can be pinned by a fast unit test instead of a 4-minute app build.

export const hasBlockingControllerSkips = (failedControllers) => failedControllers.length > 0;
export const controllerSkipFinding = ({ route, verb, reason }) => ({
  route,
  area: 'route',
  severity: 'BLOCK',
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
