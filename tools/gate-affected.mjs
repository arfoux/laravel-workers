#!/usr/bin/env node
// tools/gate-affected.mjs — run the invariant gates on the tests affected by a
// change, instead of always paying for the whole suite.
//
// This is a *selector*, not a new gate. Whatever it runs is the same corpus,
// docs, bench, syntax and pack checks gate:fast runs; only the `node --test`
// file list is narrowed. The narrowing is deliberately biased to false
// positives: a source file with no discoverable test forces the FULL suite, so
// an unrecognised import style cannot quietly make a change unverified.
//
// Zero dependencies: Node built-ins only. The selection algorithm is exported
// as pure helpers (selectTests / needsFullSuite / buildTestGraph) so the unit
// tests never shell out.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIRS = ['compiler/tests', 'kernel/tests', 'tools/tests'];
// The route-scan oracle is its own CI job (it needs a Laravel app). It stays in
// the graph for dependency mapping, but is never handed to `node --test` here —
// tools/run-tests.mjs excludes it from the default suite for the same reason.
const ORACLE_TEST = 'tools/tests/routes-oracle-parity.test.mjs';

// ---------------------------------------------------------------------------
// Pure path/import helpers
// ---------------------------------------------------------------------------

export const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

// `db.test.mjs` and `db.mjs` share the stem `db`. Dropping both suffixes is
// what makes a source change select its same-named test even when the test
// does not import it directly (fixture-driven tests often do not).
export function stemOf(p) {
  const base = norm(p).split('/').pop() ?? '';
  return base.replace(/\.(?:mjs|js|cjs|test\.mjs|test\.js)$/i, '').replace(/\.test$/i, '');
}

// Blank line/block comments and template literals before looking for
// specifiers. Fixtures in these tests contain *sample* imports inside template
// strings (see tools/tests/pack-gate.test.mjs); treating those as real edges
// would produce bogus, non-existent closure entries.
function maskNonCode(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { out += '  '; i++; state = 'line'; continue; }
      if (c === '/' && n === '*') { out += '  '; i++; state = 'block'; continue; }
      if (c === '`') { out += ' '; state = 'template'; continue; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += c; state = 'code'; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out += '  '; i++; state = 'code'; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    // template
    if (c === '\\') { out += '  '; i++; continue; }
    if (c === '`') { out += ' '; state = 'code'; continue; }
    out += c === '\n' ? c : ' ';
  }
  return out;
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

// Only relative specifiers are ours to follow. `node:` and bare specifiers
// (npm packages) are deliberately skipped: they are not changed by this repo.
export function extractSpecifiers(src) {
  const code = maskNonCode(src);
  const found = new Set();
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) found.add(spec);
    }
  }
  return [...found];
}

function resolveLocal(spec, fromRel, root) {
  const abs = spec.startsWith('/')
    ? resolve(root, `.${spec}`)
    : resolve(root, dirname(fromRel), spec);
  const rel = norm(relative(root, abs));
  try { if (statSync(abs).isFile()) return rel; } catch { /* fall through */ }
  // Extensionless relative specifiers are not valid ESM, but be forgiving in
  // case a test reaches a module through a bundler-style path.
  for (const suffix of ['.mjs', '.js', '/index.mjs', '/index.js']) {
    const candidate = `${abs}${suffix}`;
    if (existsSync(candidate)) return norm(relative(root, candidate));
  }
  return null;
}

/** transitive local-file closure for one entry file (includes the entry). */
function closureOf(entryRel, root) {
  const seen = new Set();
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(?:mjs|js|cjs)$/.test(rel)) continue;
    let src;
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const spec of extractSpecifiers(src)) {
      const next = resolveLocal(spec, rel, root);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function walkTests(dir, root, out = []) {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = norm(`${dir}/${e.name}`);
    if (e.isDirectory()) walkTests(rel, root, out);
    else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(rel);
  }
  return out;
}

/** Map<test path, Set<transitive local closure>>. */
export function buildTestGraph(root = ROOT) {
  const graph = new Map();
  for (const dir of TEST_DIRS) {
    for (const test of walkTests(dir, root)) graph.set(test, closureOf(test, root));
  }
  return graph;
}

/**
 * Pure selection: a test runs when a changed file is in its transitive
 * closure, IS the test, or matches its basename stem.
 * @returns {string[]} sorted repo-relative test paths.
 */
export function selectTests(changedFiles, testGraph) {
  const changed = [...new Set(changedFiles.map(norm))];
  const changedStems = new Set(changed.map(stemOf));
  const selected = new Set();
  for (const [test, closure] of testGraph) {
    if (changed.some((f) => f === test || closure.has(f))) { selected.add(test); continue; }
    const stem = stemOf(test);
    if (stem && changedStems.has(stem)) selected.add(test);
  }
  return [...selected].sort();
}

const SOURCE_DIRS = /^(?:compiler|kernel|src|tools|shadow)\//;
const TEST_DIR = /^(?:compiler|kernel|tools)\/tests\//;

/** True only for code whose change MUST be covered by at least one test. */
export function isSourceFile(file) {
  const p = norm(file);
  if (TEST_DIR.test(p)) return false; // test-only changes select themselves
  if (p === 'build.mjs' || p.startsWith('bin/')) return true;
  if (!/\.(?:mjs|js|cjs)$/.test(p)) return false; // docs, JSON fixtures, workflows
  return SOURCE_DIRS.test(p);
}

/**
 * Pure conservative fallback. Returns the untested source paths that force the
 * FULL suite; an empty array means the narrowed selection is safe. An empty
 * change set is a fallback with an explanatory pseudo-path (never zero tests).
 */
export function needsFullSuite(changedFiles, selectedTests, testGraph = new Map()) {
  if (!changedFiles.length) return ['<no changed files>'];
  const covered = new Set();
  for (const test of selectedTests) {
    covered.add(norm(test));
    for (const file of testGraph.get(test) ?? []) covered.add(norm(file));
  }
  const selectedStems = new Set(selectedTests.map(stemOf));
  const untested = [];
  for (const raw of changedFiles) {
    const file = norm(raw);
    if (!isSourceFile(file)) continue;
    if (covered.has(file) || selectedStems.has(stemOf(file))) continue;
    untested.push(file);
  }
  return untested;
}

// ---------------------------------------------------------------------------
// Changed-file discovery (the only part that touches git)
// ---------------------------------------------------------------------------

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: `git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || 'unknown error').trim()}` };
  }
  return { ok: true, files: (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map(norm) };
}

function detectChanges(argv, env) {
  if (argv.full) return { ok: true, mode: 'forced-full', files: [], skipped: true };
  const to = argv.to ?? 'HEAD';
  if (to.toUpperCase() === 'WORKTREE') {
    const base = argv.from ?? 'HEAD';
    const tracked = git(['diff', '--name-only', base]);
    if (!tracked.ok) return { ...tracked, mode: 'push' };
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    if (!untracked.ok) return { ...untracked, mode: 'push' };
    return { ok: true, mode: 'push', files: [...new Set([...tracked.files, ...untracked.files])] };
  }
  if (argv.from) {
    const r = git(['diff', '--name-only', argv.from, to]);
    return { ...r, mode: 'push' };
  }
  if (env.GITHUB_BASE_REF) {
    const r = git(['diff', '--name-only', `origin/${env.GITHUB_BASE_REF}...HEAD`]);
    return { ...r, mode: 'pr' };
  }
  const r = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
  return { ...r, mode: 'push' };
}

function parseArgs(args) {
  const out = { full: false, print: false, coverage: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--full') out.full = true;
    else if (a === '--print') out.print = true;
    else if (a === '--coverage') out.coverage = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--from' || a === '--to') {
      if (!args[i + 1]) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = args[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `usage: node tools/gate-affected.mjs [options]

  --from <ref>   compare from this ref (default: auto-detected)
  --to <ref>     compare to this ref, or WORKTREE for uncommitted changes
  --full         force the full suite
  --coverage     add --experimental-test-coverage to the test run
  --print        print the selection and exit without running anything
  --help         show this help

With no --from/--to: GITHUB_BASE_REF selects a PR diff, otherwise the push
HEAD diff is used. Any failure, empty change set or untested source file falls
back to the full suite.`;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function run(cmd, args, viaShell) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: viaShell, // npm is a .cmd shim on Windows; node is invoked directly
  });
  if (r.error) { console.error(`gate-affected: ${cmd} could not start: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

const INVARIANT_GATES = [
  ['npm', ['run', 'test:corpus']],
  ['node', ['tools/gate.mjs', '--strict']],
  ['node', ['tools/bench.mjs']],
  ['node', ['tools/check-syntax.mjs']],
  ['node', ['tools/pack-gate.mjs']],
];

function execute(full, selected, coverage) {
  const runnable = selected.filter((f) => f !== ORACLE_TEST);
  let status = 0;
  if (full) {
    status = coverage
      ? run('npm', ['run', 'test:coverage'], true)
      : run('npm', ['test'], true);
  } else if (coverage) {
    // Mirror `npm run test:coverage`: budget.test.mjs asserts wall-clock p95
    // budgets and would measure the instrument under coverage. The nightly
    // full gate still runs it un-instrumented.
    const covered = runnable.filter((f) => stemOf(f) !== 'budget');
    status = covered.length
      ? run(process.execPath, ['--test', '--experimental-test-coverage', ...covered], false)
      : run('npm', ['run', 'test:coverage'], true);
  } else {
    status = runnable.length
      ? run(process.execPath, ['--test', ...runnable], false)
      : run('npm', ['test'], true);
  }
  if (status !== 0) return status;
  for (const [cmd, args] of INVARIANT_GATES) {
    status = run(cmd, args, cmd === 'npm');
    if (status !== 0) return status;
  }
  return 0;
}

export function main() {
  let argv;
  try { argv = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`gate-affected: ${err.message}\n${USAGE}`); return 2; }
  if (argv.help) { console.log(USAGE); return 0; }

  const graph = buildTestGraph(ROOT);
  const allTests = [...graph.keys()].sort();
  const detect = detectChanges(argv, process.env);

  let mode = detect.mode;
  let selected = [];
  let why = [];
  if (argv.full) {
    mode = 'forced-full';
    selected = allTests;
    why.push('--full requested');
  } else if (!detect.ok) {
    mode = 'fallback';
    selected = allTests;
    why.push(detect.reason);
  } else if (!detect.skipped) {
    const changed = detect.files;
    selected = selectTests(changed, graph);
    const untested = needsFullSuite(changed, selected, graph);
    if (untested.length) {
      mode = 'fallback';
      selected = allTests;
      why.push(`untested source path(s) with no selecting test: ${untested.join(', ')}`);
    } else if (!selected.length) {
      mode = 'full';
      selected = allTests;
      why.push(`no test selects the changed file(s): ${changed.join(', ')}`);
    }
  }

  if (why.length) console.log(`gate-affected: ${why.join('; ')}`);
  const changedCount = detect.ok && !detect.skipped ? detect.files.length : 0;
  console.log(`gate-affected: ${selected.length} test file(s) selected from ${changedCount} changed file(s); mode=${mode}`);
  if (argv.print) {
    for (const f of selected) console.log(`  ${f}`);
    return 0;
  }
  return execute(mode !== 'pr' && mode !== 'push', selected, argv.coverage);
}

// Run only when invoked as a script; importing the helpers must be side-effect
// free so the unit tests can exercise the algorithm without spawning anything.
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    process.exitCode = main();
  }
} catch {
  // A missing/aliased argv[1] means this file was imported, not executed.
}
