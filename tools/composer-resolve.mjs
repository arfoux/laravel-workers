// tools/composer-resolve.mjs — composer.json -> exact package set, WITHOUT composer.
//
// vendor-lite provisions the build's PHP dependencies from composer.lock. A repo
// that never committed one (the stock laravel/laravel skeleton, teams that
// gitignore it) has no such list — and the only tool that normally produces one
// is composer, which this toolchain exists to not need.
//
// So resolve it from the same public data composer itself reads: Packagist's p2
// API (https://repo.packagist.org/p2/<vendor>/<pkg>.json) lists every release
// with its dist zip, shasum, require map and autoload rules. For each package we
// collect every constraint placed on it (root require + transitive requires),
// eliminate candidates that this machine cannot run (php/ext platform reqs of
// the interpreter the build resolved), and take the highest version satisfying
// all of them — the same objective as `composer update` on a fresh clone, kept
// honest by failing loudly instead of guessing:
//
//   - custom repositories (path/vcs/private composer) are refused by name;
//   - an empty intersection fails naming BOTH sides of the conflict and who
//     required them, never a silent near-miss;
//   - minimum-stability is a floor (per-constraint too, via `@dev` suffix);
//   - a constraint syntax we cannot evaluate is an error, not a skip;
//   - resolution must converge (fixed-point iteration with a step cap).
//
// Known limits, stated once: replace/provide handling is basic (a provider is
// installed instead of the covered package, without checking the provided
// VERSION against the constraint); a mid-run re-pick can briefly orphan a
// package (pruned at output, with a net that fails loud if that orphan was
// suppressing something still required). Both paths tell you to commit a lock.
//
// Output entries have the exact shape readLockPackages() produces from a lock,
// so everything downstream (download, shasum verify, autoloader) is unchanged.

import { spawnSync } from 'node:child_process';
import { resolvePhp, satisfies } from './php-runtime.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGIST = 'https://repo.packagist.org/p2';
const STAB_RANK = { dev: 0, alpha: 1, beta: 2, rc: 3, stable: 4 };
const MAX_STEPS = 5000;

/** Platform requirements are checked against the machine, never installed. */
export function isPlatformKey(name) {
  return /^(?:php(?:$|-)|hhvm$|ext-|lib-|composer-(?:plugin|runtime)-api$)/.test(name);
}

/** Stability of a release string: 1.0.0=stable, 1.0.0-rc1=rc, 13.x-dev=dev. */
export function stabilityOf(version) {
  const v = String(version).toLowerCase();
  if (v.startsWith('dev-') || /[-.]dev(?:[.-]?\d+)?$/.test(v)) return 'dev';
  let m = v.match(/[-.](?:alpha|beta|rc)(?:[.-]?\d+)?$/);
  if (m) return m[0].includes('alpha') ? 'alpha' : m[0].includes('beta') ? 'beta' : 'rc';
  m = v.match(/(\d)(a|b|rc)(\d+)$/); // 1.0.0a1 / 1.0.0b2 / 1.0.0rc3
  if (m) return m[2] === 'rc' ? 'rc' : m[2] === 'a' ? 'alpha' : 'beta';
  return 'stable';
}

function tuple(version) {
  const s = String(version).replace(/^v/i, '');
  // Composer normalizes branch builds with a 9999999 ceiling so they sort
  // inside their range: 1.0.x-dev / 1.0-dev -> 1.0.<ceiling>, 2.x-dev ->
  // <ceiling>.<ceiling>.<ceiling>. Mirroring that keeps ^1.0 able to see
  // 1.0.x-dev the way composer does.
  let m = s.match(/^(\d+)\.(\d+)(?:\.x)?-dev$/);
  if (m) return [Number(m[1]), Number(m[2]), 9999999];
  m = s.match(/^(\d+)\.x-dev$/);
  if (m) return [Number(m[1]), 9999999, 9999999];
  m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** dev-main <-> dev-main, dev-1.0.x <-> 1.0.x-dev: same branch, two spellings. */
function branchKey(s) {
  let k = String(s).replace(/^v/i, '').toLowerCase();
  if (k.startsWith('dev-')) k = k.slice(4);
  if (k.endsWith('-dev')) k = k.slice(0, -4);
  return k;
}

function cmpTuple(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Refuse anything vendor-lite cannot resolve truthfully. */
function assertPackagistOnly(repositories) {
  const describe = (v) =>
    typeof v === 'string' ? v
    : v && typeof v === 'object' ? `${v.type || 'package'}${v.url ? ` (${v.url})` : ''}`
    : String(v);
  const bail = (what) => {
    throw new Error(
      `composer.json defines ${what} — with no composer.lock, vendor-lite can only resolve packages from packagist.org.\n` +
        '  -> commit a composer.lock (generate it once, anywhere) and this build stays composer-free forever'
    );
  };
  if (!repositories) return;
  if (!Array.isArray(repositories)) {
    for (const [k, v] of Object.entries(repositories)) {
      if (k === 'packagist.org' && v === false) bail('a repositories block that disables packagist.org');
      if (k === 'packagist.org') continue;
      bail(`a custom repository "${k}" of type ${describe(v)}`);
    }
    return;
  }
  for (const r of repositories) {
    if (r && typeof r === 'object' && 'packagist.org' in r) {
      if (r['packagist.org'] === false) bail('a repositories block that disables packagist.org');
      continue;
    }
    if (r && r.type === 'composer' && String(r.url || '').includes('repo.packagist.org')) continue;
    bail(`a custom repository of type ${describe(r)}`);
  }
}

/**
 * What this machine can actually run — probed from ONE interpreter, the same
 * one the build resolved for the app (opts.phpBin), so an app requiring ^8.4
 * filters candidates against the 8.4 the build will boot, not PATH's 8.3.
 * Returns php:null when nothing can be probed: platform gates then turn off
 * (same philosophy as php-runtime's satisfies(): never invent a block).
 */
export function detectPlatform(phpBin, requirement = null) {
  const off = { php: null, exts: new Set(), intSize: null };
  let bin = phpBin || null;
  if (!bin) {
    try { bin = resolvePhp({ requirement }).bin; } catch { return off; }
  }
  try {
    const r = spawnSync(
      bin,
      ['-r', 'echo json_encode(["v"=>PHP_VERSION,"e"=>array_map("strtolower",get_loaded_extensions()),"i"=>PHP_INT_SIZE]);'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }
    );
    if (r.status !== 0 || !r.stdout) return off;
    const o = JSON.parse(r.stdout);
    return { php: o.v, exts: new Set(o.e || []), intSize: o.i };
  } catch {
    return off;
  }
}

/** Keys in `requireMap` this platform FAILS, or null when every one passes. */
function platformFailures(requireMap, platform) {
  if (!requireMap) return null;
  const bad = [];
  for (const [k, c] of Object.entries(requireMap)) {
    if (!isPlatformKey(k)) continue;
    if (k === 'php') {
      if (platform.php && satisfies(platform.php, String(c)) === false) bad.push(`${k} ${c}`);
      continue;
    }
    if (k === 'php-64bit') {
      if (platform.php && platform.intSize !== 8) bad.push(k);
      continue;
    }
    if (k.startsWith('ext-')) {
      if (platform.php && k.slice(4).toLowerCase() !== 'json' && !platform.exts.has(k.slice(4).toLowerCase())) bad.push(k);
      continue;
    }
    if (k === 'hhvm') {
      if (platform.php) bad.push(k); // running on PHP: an hhvm-only package can never work here
      continue;
    }
    // lib-*, composer-*-api, unknown platform keys: cannot be verified from
    // here — skip the gate and let a real boot failure surface the truth.
  }
  return bad.length ? bad : null;
}

/** Packagist p2 metadata, in-process cached per (name, wantDev) variant. */
function makeMeta(fetchImpl, cache) {
  return async function meta(name, wantDev) {
    const key = `${name}|${wantDev ? 'dev' : 'rel'}`;
    if (cache.has(key)) return cache.get(key);
    const url = `${PACKAGIST}/${name}${wantDev ? '~dev' : ''}.json`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'user-agent': 'laravel-workers/vendor-lite' } });
    } catch (e) {
      throw new Error(`${name}: cannot reach packagist.org (${e.cause?.code || e.message}) — retry when the network is back`);
    }
    if (res.status === 404) {
      throw new Error(
        `${name}: not found on packagist.org (404 from ${url}) — private or renamed package?\n` +
          '  -> with no composer.lock, vendor-lite resolves only packagist.org packages; commit a composer.lock to cover the rest'
      );
    }
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} fetching ${url} — try again shortly`);
    const data = await res.json();
    const list = (data.packages && data.packages[name]) || [];
    cache.set(key, list);
    return list;
  };
}

/** Split `dev-main`-style constraints (exact branch refs) from range constraints. */
function isDevConstraint(constraint) {
  return /^dev-/i.test(constraint);
}

/**
 * Pick the highest version of `name` satisfying ALL constraints recorded for it.
 * Throws a conflict report naming both sides when nothing survives.
 */
async function pickVersion(name, constraints, platform, meta) {
  // The lowest floor among this package's constraints decides which metadata
  // file can even hold a candidate (p2 vs p2~dev).
  const floor = Math.min(...constraints.map((c) => c.floor));
  const wantDev = floor < STAB_RANK.stable;
  const versions = await meta(name, wantDev);

  const eligible = [];
  const platformKilled = [];
  for (const v of versions) {
    const stab = stabilityOf(v.version);
    if (STAB_RANK[stab] < floor) continue;
    const t = tuple(v.version);
    const isBranch = !t; // tuple-less (dev-main, dev-master): exact name only
    const needs = platformFailures(v.require, platform);
    if (needs) { platformKilled.push(`${v.version} needs ${needs.join(', ')}`); continue; }
    eligible.push({ v, t, stab, isBranch });
  }

  const survivors = [];
  for (const cand of eligible) {
    let ok = true;
    for (const { constraint, floor: cFloor } of constraints) {
      // Stability applies per constraint: an @stable side rejects a dev build
      // even when another side of the graph allows dev.
      if (STAB_RANK[cand.stab] < cFloor) { ok = false; break; }
      if (constraint === '*') continue;
      // Exact pin beats every other reading — "1.0.0-dev" pins that tag.
      if (String(cand.v.version).replace(/^v/i, '').toLowerCase() === constraint.replace(/^v/i, '').toLowerCase()) continue;
      const devSide = isDevConstraint(constraint) || stabilityOf(constraint) === 'dev';
      if (cand.isBranch || devSide) {
        // A dev name or pin matches only its own spelling (dev-main, 1.0.0-dev,
        // dev-1.0.x == 1.0.x-dev) — never a range read.
        const a = String(cand.v.version).toLowerCase().replace(/^v/, '');
        const b = constraint.toLowerCase().replace(/^v/, '');
        if (a === b || (b.startsWith('dev-') && branchKey(a) === branchKey(b))) continue;
        ok = false;
        break;
      }
      const r = satisfies(cand.t.join('.'), constraint);
      if (r === null) {
        throw new Error(
          `${name}: constraint "${constraint}" uses syntax vendor-lite cannot evaluate truthfully.\n` +
            '  -> commit a composer.lock so this build never has to guess a version'
        );
      }
      if (!r) { ok = false; break; }
    }
    if (ok) survivors.push(cand);
  }

  if (!survivors.length) {
    const shown = eligible.slice(0, 6).map((c) => c.v.version).join(', ');
    const reqLines = constraints.map((c) => `      ${c.constraint.padEnd(20)} <- ${c.by}`).join('\n');
    const plat = platformKilled.length
      ? `\n    (platform-filtered: ${platformKilled.length} release(s) fail this platform${platform.php ? ` — probing PHP ${platform.php}` : ''}; e.g. ${platformKilled.slice(-3).join('; ')})`
      : '';
    const avail = shown
      ? `highest releases still eligible: ${shown}${plat}`
      : `every release was excluded${plat || ` (packagist lists ${versions.length})`}`;
    throw new Error(
      `no version of ${name} satisfies every requirement:\n${reqLines}\n    ${avail}\n` +
        '    -> relax one of the constraints above, or commit a composer.lock (generated once) to pin what works'
    );
  }

  survivors.sort((a, b) => cmpTuple(b.t || [0, 0, 0], a.t || [0, 0, 0]) || STAB_RANK[b.stab] - STAB_RANK[a.stab]);
  const chosen = survivors[0];
  return {
    name,
    vendor: name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : 'vendor',
    pkg: name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name,
    version: String(chosen.v.version),
    url: (chosen.v.dist && chosen.v.dist.url) || null,
    shasum: (chosen.v.dist && chosen.v.dist.shasum) || null,
    reference: (chosen.v.dist && chosen.v.dist.reference) || null,
    source: (chosen.v.source && chosen.v.source.url) || null,
    autoload: chosen.v.autoload || {},
    require: chosen.v.require || {},
    replace: chosen.v.replace || {},
    provide: chosen.v.provide || {},
    type: chosen.v.type || 'library',
    pkgdir: `vendor/${name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : 'vendor'}/${name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name}`,
  };
}

/**
 * Resolve the app's non-dev dependencies from composer.json.
 *
 * @param {string} appDir  directory holding composer.json
 * @param {object} opts
 * @param {string} [opts.phpBin]      interpreter the build resolved (platform probe)
 * @param {{php:?string,exts:Set,intSize:?number}} [opts.platform]  injected for tests
 * @param {typeof fetch} [opts.fetch] injected for tests
 * @returns {Promise<Array>} entries in readLockPackages() shape
 */
export async function resolveDependencies(appDir, opts = {}) {
  const jsonPath = join(appDir, 'composer.json');
  if (!existsSync(jsonPath)) {
    throw new Error(`vendor-lite: neither composer.lock nor composer.json exists in ${appDir} — nothing to resolve`);
  }
  let root;
  try {
    root = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`composer.json in ${appDir} is not valid JSON: ${e.message}`);
  }
  assertPackagistOnly(root.repositories);

  const platform = opts.platform || detectPlatform(opts.phpBin, (root.require && root.require.php) || null);
  if (!(platform.exts instanceof Set)) platform = { ...platform, exts: new Set(platform.exts || []) };
  const rootFloor = STAB_RANK[root['minimum-stability'] || 'stable'] ?? STAB_RANK.stable;
  const meta = makeMeta(opts.fetch || ((u, o) => fetch(u, o)), new Map());

  // Constraints per package, who placed them, and the selection state.
  const constraints = new Map(); // name -> [{constraint, by, byPkg}]
  const selected = new Map();    // name -> entry
  const supplied = new Map();    // covered name -> provider name (replace/provide)
  const queue = [];

  for (const [n, c] of Object.entries(root.require || {})) {
    if (isPlatformKey(n)) continue; // root php/ext are the build's resolvePhp job
    queue.push([n, String(c), 'composer.json (root require)', null]);
  }

  let steps = 0;
  while (queue.length) {
    if (++steps > MAX_STEPS) {
      throw new Error(
        `dependency resolution did not converge after ${MAX_STEPS} steps — the constraint graph is cycling.\n` +
          '  -> commit a composer.lock to make this build deterministic'
      );
    }
    const [name, rawConstraint, by, byPkg] = queue.shift();

    let constraint = rawConstraint;
    let cFloor = rootFloor;
    const at = rawConstraint.match(/^(.+?)@(stable|dev|alpha|beta|rc)$/i);
    if (at) {
      constraint = at[1];
      cFloor = STAB_RANK[at[2].toLowerCase()] ?? rootFloor; // suffix overrides the root default
    } else if (!/[~^<>*|\s]/.test(constraint) && stabilityOf(constraint) === 'dev') {
      cFloor = STAB_RANK.dev; // exact dev pin (dev-main, 1.0.0-dev) opts in explicitly
    }

    const list = constraints.get(name) || [];
    list.push({ constraint, by, byPkg, floor: cFloor });
    constraints.set(name, list);

    if (supplied.has(name)) continue; // an installed package already replaces/provides it

    const existing = selected.get(name);
    if (existing) {
      // Still fits every constraint placed so far? Keep it (no re-resolve).
      const stillFits = list.every(({ constraint: c2, floor: cFloor2 }) => {
        // A newly placed stability floor can evict a dev build on its own.
        if (STAB_RANK[stabilityOf(existing.version)] < cFloor2) return false;
        if (c2 === '*') return true;
        if (isDevConstraint(c2) || !existing._t) {
          return branchKey(existing.version) === branchKey(c2);
        }
        const r = satisfies(existing._t.join('.'), c2);
        if (r === null) {
          throw new Error(
            `${name}: constraint "${c2}" (from ${by}) uses syntax vendor-lite cannot evaluate truthfully.\n` +
              '  -> commit a composer.lock so this build never has to guess a version'
          );
        }
        return r;
      });
      if (stillFits) continue;
    }

    const picked = await pickVersion(name, list, platform, meta);

    if (existing && existing.version === picked.version) continue; // same pick: its outgoing edges stay valid

    if (existing) {
      // Version changed: the OLD version's requirements belong to a package we
      // no longer install — withdraw them before re-queueing the new ones.
      // Withholding constraints only loosens other packages, which can never
      // invalidate a selection (it can only widen what fits).
      for (const [pn, plist] of constraints) {
        if (pn === name) continue;
        const kept = plist.filter((c) => c.byPkg !== name);
        if (kept.length !== plist.length) constraints.set(pn, kept);
      }
      // If the previous version provided/replaced something, that claim dies with it.
      for (const [covered, provider] of [...supplied]) {
        if (provider === name) supplied.delete(covered);
      }
    }

    picked._t = tuple(picked.version); // normalized form for the next stillFits
    selected.set(name, picked);

    // Retro-suppress packages this one replaces/provides (basic: no provided
    // version check — stated in the header). A package selected earlier is
    // removed; its outgoing constraints are withdrawn like a re-pick's.
    for (const covered of Object.keys({ ...picked.replace, ...picked.provide })) {
      if (covered === name || supplied.has(covered)) continue;
      supplied.set(covered, name);
      const loser = selected.get(covered);
      if (loser) {
        selected.delete(covered);
        for (const [pn, plist] of constraints) {
          if (pn === covered) continue;
          const kept = plist.filter((c) => c.byPkg !== covered);
          if (kept.length !== plist.length) constraints.set(pn, kept);
        }
      }
    }

    for (const [rn, rc] of Object.entries(picked.require || {})) {
      if (isPlatformKey(rn)) continue;
      queue.push([rn, String(rc), `${name} ${picked.version}`, name]);
    }
  }

  // Reachability from the root requires: a mid-run re-pick can orphan a
  // package (its only requirer changed version). Orphans are dropped — but
  // only AFTER verifying that nothing reachable depends on an orphan's
  // provide/replace suppression, which would leave a hole.
  const rootNames = Object.keys(root.require || {}).filter((n) => !isPlatformKey(n));
  const reachable = new Set();
  const stack = rootNames.filter((n) => selected.has(n));
  while (stack.length) {
    const n = stack.pop();
    if (reachable.has(n)) continue;
    reachable.add(n);
    const e = selected.get(n);
    for (const rn of Object.keys(e.require || {})) {
      if (!isPlatformKey(rn) && selected.has(rn)) stack.push(rn);
    }
  }
  const prov = new Map();
  for (const n of reachable) {
    const e = selected.get(n);
    for (const covered of Object.keys({ ...e.replace, ...e.provide })) prov.set(covered, n);
  }
  const checkCoverage = (reqName, requirer) => {
    if (reachable.has(reqName) || prov.has(reqName)) return;
    throw new Error(
      `${requirer} requires ${reqName}, which resolution dropped while restructuring the graph.\n` +
        '  -> this only happens with replace/provide-heavy graphs mid-resolution; commit a composer.lock to pin the set'
    );
  };
  for (const rn of rootNames) if (!selected.has(rn)) checkCoverage(rn, 'composer.json (root require)');
  for (const n of reachable) {
    for (const rn of Object.keys(selected.get(n).require || {})) {
      if (isPlatformKey(rn)) continue;
      checkCoverage(rn, `${n} ${selected.get(n).version}`);
    }
  }

  return [...reachable].sort().map((n) => {
    const e = selected.get(n);
    delete e._t;
    return e;
  });
}

export default { resolveDependencies, detectPlatform, stabilityOf, isPlatformKey };
