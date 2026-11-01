#!/usr/bin/env node
// tools/check-syntax.mjs — `node --check` over every shipped ESM file.
//
// CI ran this as
//   find build.mjs kernel compiler/src compiler/runtime bin tools shadow src \
//     -name '*.mjs' -print0 | xargs -0 -n1 node --check
// which is POSIX-only: the same check cannot be run on a Windows checkout, and
// the release workflow could drift from CI. This is the identical check in one
// portable place, so `npm run gate:ci` (and therefore CI and the release) has a
// single definition of "the shipped sources parse".
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['build.mjs', 'kernel', 'compiler/src', 'compiler/runtime', 'bin', 'tools', 'shadow', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist']);

function collect(target, out = []) {
  const info = statSync(target, { throwIfNoEntry: false });
  if (!info) return out;
  if (info.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) collect(path.join(target, entry.name), out);
      } else if (entry.name.endsWith('.mjs')) {
        out.push(path.join(target, entry.name));
      }
    }
  } else if (target.endsWith('.mjs')) {
    out.push(target);
  }
  return out;
}

// Blank out comments so a header comment quoting an import line cannot fail the
// gate. A tiny state machine (code / line comment / block comment / string) is
// enough for this repo's sources and avoids a parser dependency in a gate.
function stripComments(src) {
  let out = '';
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i++;
      } else if (c === '/' && n === '*') {
        mode = 'block';
        i++;
      } else if (c === '"' || c === "'" || c === '`') {
        mode = 'string';
        quote = c;
        out += c;
      } else {
        out += c;
      }
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i++;
      }
      continue;
    }
    // inside a string: keep it verbatim, honour the escape, stop at the quote.
    // A TEMPLATE literal is blanked instead: the code generators write whole
    // module sources (import lines included) inside them, and those are not
    // this file's imports.
    if (quote === '`') {
      if (c === '\\') {
        i++;
      } else if (c === '`') {
        mode = 'code';
      }
      continue;
    }
    out += c;
    if (c === '\\') {
      out += n ?? '';
      i++;
    } else if (c === quote) {
      mode = 'code';
    }
  }
  return out;
}

const files = ENTRIES.flatMap((entry) => collect(path.join(repoRoot, entry))).sort();
const failures = [];

// A second pass resolves the RELATIVE specifiers of each file. `node --check`
// only parses: a missing module (the class of break this gate exists to catch -
// a working tree that imports a file which was never added) parses cleanly and
// only explodes at import time. Only `./x.mjs` / `./x.json` targets are
// checked: a bare specifier is node_modules' business and a comment quoting an
// import must not fail the gate.
const SPEC_RE = /(?:^|[^\w$.])(?:import|export)\s*(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
function unresolvedSpecifiers(file) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const specs = [];
  for (const re of [SPEC_RE, DYN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  // A module that imports a build-GENERATED module (`./routes.generated.mjs`
  // et al.) is the `src/worker.mjs` template: its siblings are emitted into
  // `dist/` by the build, so they legitimately do not exist in the checkout.
  if (specs.some((s) => s.startsWith('.') && s.endsWith('.generated.mjs'))) return [];
  const missing = [];
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    if (!/\.(mjs|json)$/.test(spec)) continue;
    if (!existsSync(path.resolve(dir, spec))) missing.push(spec);
  }
  return missing;
}

for (const file of files) {
  const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (run.status !== 0) {
    failures.push(`${path.relative(repoRoot, file)}\n${(run.stderr || '').trim()}`);
    continue;
  }
  const missing = unresolvedSpecifiers(file);
  if (missing.length) {
    failures.push(
      `${path.relative(repoRoot, file)}\n  import does not resolve: ${[...new Set(missing)].join(', ')}`
    );
  }
}

if (failures.length) {
  console.error(`check-syntax FAIL: ${failures.length} of ${files.length} files do not parse/resolve`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  `check-syntax PASS: ${files.length} shipped ESM files parse and their relative imports resolve`
);
