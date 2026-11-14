// tools/ports.mjs — port-file helpers shared by the build:
//   buildStubSource() — `--scaffold` stub generator (must match the controller
//     re-export contract: a DEFAULT export returning { status, headers, body })
//   findStubPorts()   — stub detector: the build flags scaffold stubs so a
//     "green" build never silently ships a 501 handler.
//
// Port contract (see README):
//   export default async function handle(ctx, env) { ... }
//   return { status: 200, headers: {...}, body: 'string' }

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_BANNER } from './generated.mjs';

export const STUB_MARKER = 'laravel-workers:stub';

export function buildStubSource(route) {
  const lines = [
    `// Port for GET ${route} — ${STUB_MARKER}`,
    '// TODO: implement against env.DB (or another binding) and return { status, headers, body }.',
  ];
  if (route.includes('{')) {
    lines.push('// NOTE: dynamic segments ARE matched by the worker router — read them from ctx.params.');
  }
  lines.push(
    'export default async function handle(ctx, env) {',
    '  return {',
    '    status: 501,',
    "    headers: { 'content-type': 'application/json' },",
    `    body: JSON.stringify({ error: 'not implemented', route: ${JSON.stringify(route)} }),`,
    '  };',
    '}',
    ''
  );
  return lines.join('\n');
}

export function findStubPorts(dir) {
  if (!dir || !existsSync(dir)) return [];
  const stubs = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (text.includes(STUB_MARKER)) stubs.push(name);
  }
  return stubs.sort();
}

// ---------------------------------------------------------------------------
// Guard ports — registry.json → "guards": { "<driver>": "<slug>" }.
//
// `Auth::extend('seal', fn)` is PHP app code: the compiled rung cannot execute
// that closure, and it must not pretend to. The app supplies the JS the guard
// resolves through instead (`ports/<slug>.mjs`), exactly the way a route port
// answers a route the compiler cannot cover.
//
//   // ports/seal-guard.mjs
//   export default {
//     async user(ctx) {
//       const id = await readSealedCookie(ctx.request, ctx.app.env.SEAL_KEY);
//       return id === null ? null : ctx.app.models.User.find(ctx.app.db, id);
//     },
//   }
//
// `ctx` is `{ request, guard, driver, config, app: { config, db, models, env,
// session, cookieJar } }` (kernel/auth.mjs, `PortedGuard.portCtx`) - the app's
// bindings live under `ctx.app.*`, never at the top level.
//
// The driver is the registry KEY, the same string `Auth::extend()` registered.
// ---------------------------------------------------------------------------

/** Bare file name (the slug is emitted as an import of `./ports/<slug>.mjs`). */
const GUARD_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse/validate the registry's `guards` map.
 * @returns {{ entries: Array<[string, string]>, errors: string[] }} entries are
 *   `[driver, slug]` in declaration order; errors are operator-facing sentences
 *   (the build fails loud on them rather than emitting a broken dist).
 */
export function guardPortEntries(registry) {
  const entries = [];
  const errors = [];
  const raw = registry ? registry.guards : undefined;
  // A shape the parser would otherwise *iterate* wrongly: Object.entries('seal')
  // is [['0','s'],['1','e'],...], which would turn a typo into a port for a
  // driver named "0" and then die on a missing file — refuse it here instead.
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return {
      entries,
      errors: [
        'registry.json "guards" must be an object of driver → port name ' +
          '({"guards": {"seal": "seal-guard"}}), not ' +
          (Array.isArray(raw) ? 'an array' : 'a ' + typeof raw) +
          '.'
      ],
    };
  }
  for (const [rawDriver, rawSlug] of Object.entries(raw || {})) {
    const driver = String(rawDriver);
    const slug = String(rawSlug);
    if (driver === 'session') {
      errors.push(
        'registry.json "guards" declares a port for the "session" driver, which the compiled rung already implements — ' +
          'a guard port is only for a driver the APP registers (Auth::extend). Remove that entry.'
      );
      continue;
    }
    if (!driver || !slug) {
      errors.push(
        'registry.json "guards" entries are driver → port name: say which driver the port answers, and in which file — ' +
          '{"guards": {"seal": "seal-guard"}} means the driver `seal` is answered by ports/seal-guard.mjs'
      );
      continue;
    }
    if (!GUARD_SLUG_RE.test(slug)) {
      errors.push(
        `registry.json "guards": the port name '${slug}' is not a bare file name — use letters, digits, dot, dash or ` +
          `underscore (it is emitted as an import of ports/${slug}.mjs)`
      );
      continue;
    }
    entries.push([driver, slug]);
  }
  return { entries, errors };
}

/**
 * The auth guards of the compiled config that the session driver cannot answer,
 * split by whether the app ported their driver.
 * @param {object} runtimeConfig the dotted compiled config (`auth.guards.*.driver`)
 * @param {Iterable<string>} portedDrivers drivers declared in registry.json `guards`
 * @returns {{
 *   problems: Array<{key: string, driver: string}>,
 *   notes: Array<{driver: string, key: string, cause: string, fix: string}>,
 *   unused: string[],
 * }}
 */
export function evaluateGuardConfig(runtimeConfig, portedDrivers) {
  const ported = new Set(portedDrivers || []);
  const declared = Object.entries(runtimeConfig || {})
    .filter(
      ([key, value]) =>
        key.startsWith('auth.guards.') && value && value.driver && String(value.driver) !== 'session'
    )
    .map(([key, value]) => ({ key, driver: String(value.driver) }));

  const problems = declared.filter((guard) => !ported.has(guard.driver));
  const notes = declared
    .filter((guard) => ported.has(guard.driver))
    .map((guard) => ({
      key: guard.key,
      driver: guard.driver,
      cause:
        `the guard ${guard.key} uses driver '${guard.driver}' — the compiled rung does not implement it, the app's guard ` +
        `port answers it (registry.json "guards", Auth::extend parity)`,
      fix:
        'the port runs wherever this guard resolves (the `auth` middleware, `auth()->user()` in a compiled controller or ' +
        'view), so it must read only what the Worker has. It is app code, not a compiled port: cover it in the shadow ' +
        'scenarios (`shadow/run.mjs`) so the PHP guard and the JS port are compared byte-for-byte.',
    }));
  const unused = [...ported].filter((driver) => !declared.some((guard) => guard.driver === driver));
  return { problems, notes, unused };
}

/**
 * The build's refusal message for a non-session driver the app did not port.
 * Names the first offender's own driver so the fix is copy-pasteable.
 */
export function guardProblemMessage(problems) {
  const first = problems[0];
  return (
    `guard(s) with a non-session driver: ` +
    problems.map((guard) => `${guard.key} (driver '${guard.driver}')`).join(', ') +
    ` (only the session guard is ported). A driver the app registers itself (Auth::extend) is PHP the compiled rung ` +
    `cannot run — port it: ${guardPortHint(first.driver)}. Until then the compiled rung would diverge silently: ` +
    `\`auth:${first.driver}\` would not authenticate, so a guarded route would answer for an unauthenticated request`
  );
}

/** `{"guards": {"seal": "<slug>"}}` + `ports/<slug>.mjs`, said once. */
export function guardPortHint(driver) {
  return (
    `registry.json {"guards": {"${driver}": "<slug>"}} and ports/<slug>.mjs exporting ` +
    '`export default { async user(ctx) { … } }`'
  );
}

/**
 * `dist/src/guard-ports.generated.mjs` — the worker's static import table.
 * Static, because a Worker bundle cannot import a module the bundler never saw;
 * empty (`export const guardPorts = {}`) when the app ports no driver.
 * @param {Array<[string, string]>} entries `[driver, slug]` pairs, in order.
 */
export function guardPortsModuleSource(entries) {
  const list = entries || [];
  const lines = [
    GENERATED_BANNER,
    '// registry.json → "guards": app-supplied guard drivers (Auth::extend parity).',
    '',
  ];
  list.forEach(([, slug], i) => lines.push(`import guardPort${i} from './ports/${slug}.mjs';`));
  if (list.length) lines.push('');
  lines.push('export const guardPorts = {');
  list.forEach(([driver], i) => lines.push(`  ${JSON.stringify(driver)}: guardPort${i},`));
  lines.push('};', '');
  return lines.join('\n');
}
