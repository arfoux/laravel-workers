// tools/config-gate.mjs — which config keys the COMPILED artifact reads.
//
// The dump carries the framework keys plus the groups registry.json declares, as
// a FLAT map of dotted paths, and `rt.config(k)` answers only an exact own key
// (`compiler/runtime/rt-from-context.mjs` — `hasOwnProperty`, then the caller's
// default, then a loud throw). The build gate asks the same question of the
// emitted code, so a `config('x.y')` the dump cannot answer fails the build
// instead of shipping a worker that answers null (a wrong value) or throws 500.
//
// Lives in its own module rather than inline in build.mjs so it can be tested
// without running a whole build — `tools/tests/config-gate.test.mjs`.
//
// What the gate CANNOT see, and stays a runtime throw either way: a fully
// dynamic key (`config($k)` compiles to `rt.config(v_k)`), where neither the key
// nor a prefix is a literal.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `rt.config("app.name")` — the literal form.
const LITERAL = /rt\.config\((["'])([^"']+)\1\)/g;
// `rt.config(rt.concat("app.", v_k))` — what `config('app.' . $k)` compiles to.
// Only the PREFIX is knowable at build time; the rest of the key exists at
// request time, so the dump must carry at least one key under it.
const DYNAMIC = /rt\.config\(rt\.concat\((["'])([^"']+)\1/g;

/**
 * Every `rt.config(...)` read under `root`: the literal keys, and the literal
 * prefixes of the keys built at request time.
 *
 * @returns {{literal: Set<string>, dynamicPrefix: Set<string>}}
 */
export function scanConfigReads(root) {
  const literal = new Set();
  const dynamicPrefix = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(LITERAL)) literal.add(m[2]);
        for (const m of text.matchAll(DYNAMIC)) dynamicPrefix.add(m[2]);
      }
    }
  };
  walk(root);
  return { literal, dynamicPrefix };
}

/**
 * The reads the dump cannot answer: literal keys it does not carry, and dynamic
 * prefixes with no key of the dump under them (every value of such a read throws
 * `config: missing key ... with no default` — a 500 where PHP answers the value,
 * or null for a key the app never set).
 *
 * @returns {{missing: string[], uncovered: string[]}} sorted key / prefix lists
 */
export function configGateMissing(reads, dump) {
  const missing = [...reads.literal]
    .filter((key) => !Object.prototype.hasOwnProperty.call(dump, key))
    .sort();
  const dumpKeys = Object.keys(dump);
  const uncovered = [...reads.dynamicPrefix]
    .filter((prefix) => !dumpKeys.some((key) => key.startsWith(prefix)))
    .sort();
  return { missing, uncovered };
}
