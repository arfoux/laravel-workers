// compiler/src/precompute.mjs — build-time response fixtures for marked methods.
//
// A controller method carrying `@lw-precompute <app-relative path>` in its
// docblock is answered at the edge by a literal produced by the PHP oracle at
// build time. This module owns the marker parsing, the fixture shape and the
// stale check; build.mjs owns the PHP process and the failure. Nothing here
// runs in the worker.

import parser from 'php-parser';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// A SEPARATE parser instance: the shared one in tools/static.mjs deliberately
// drops docblocks, and changing it would alter every other dump's memory use.
const docParser = new parser({
  parser: { extractDoc: true, suppressErrors: true },
  ast: { withPositions: true },
});

const MARKER = /@lw-precompute\s+([^\s*]+)/;

function findMethod(nodes, methodName) {
  for (const node of nodes || []) {
    if (!node) continue;
    if (node.kind === 'method' && node.name && node.name.name === methodName) return node;
    if (node.kind === 'namespace' || node.kind === 'class' || node.kind === 'program') {
      const found = findMethod(node.children || node.body || [], methodName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The `@lw-precompute <path>` directive on `methodName`, or null when the
 * method has no marker. Only a docblock that immediately precedes the method
 * counts — a marker elsewhere in the file must never capture a route.
 */
export function precomputeDirective(source, methodName) {
  const ast = docParser.parseCode(String(source));
  if ((ast.errors || []).length) {
    throw new Error(`cannot parse controller for @lw-precompute: ${ast.errors[0].message || 'parse error'}`);
  }
  const method = findMethod(ast.children, methodName);
  if (!method || !method.loc) return null;
  const comments = (ast.comments || []).filter(
    (c) => c.kind === 'commentblock' && c.loc && c.offset < method.loc.start.offset
  );
  // The closest preceding block comment is the method's docblock; allow one
  // blank line between it and `function`, but no intervening declaration.
  const comment = comments[comments.length - 1];
  if (!comment || method.loc.start.line - comment.loc.end.line > 2) return null;
  const match = MARKER.exec(comment.value || '');
  return match ? { path: match[1], line: comment.loc.start.line } : null;
}

/** App-relative fixture path, resolved without allowing escape from the app. */
export function resolveFixturePath(appDir, rawPath) {
  const p = String(rawPath || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error(`@lw-precompute fixture path must be app-relative, got ${JSON.stringify(rawPath)}`);
  }
  const abs = resolve(appDir, p);
  const rel = relative(appDir, abs).split(sep).join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`@lw-precompute fixture path escapes the app: ${JSON.stringify(rawPath)}`);
  }
  return abs;
}

/** Shared shape check for a fixture and a fresh oracle answer. */
export function assertResponseShape(value, label) {
  const bad = !value || typeof value !== 'object' || Array.isArray(value) ||
    !Number.isInteger(value.status) ||
    !value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) ||
    typeof value.body !== 'string' ||
    !Object.prototype.hasOwnProperty.call(value, 'json');
  if (bad) throw new Error(`${label} must be {"status":int,"headers":{...},"body":string,"json":...}`);
  return value;
}

/** Read and shape-check a checked-in fixture. */
export function readFixture(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read @lw-precompute fixture ${path}: ${e.message}`);
  }
  const bad = !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !Number.isInteger(parsed.status) ||
    !parsed.headers || typeof parsed.headers !== 'object' || Array.isArray(parsed.headers) ||
    typeof parsed.body !== 'string' ||
    !Object.prototype.hasOwnProperty.call(parsed, 'json');
  if (bad) {
    throw new Error(
      `@lw-precompute fixture ${path} must be {"status":int,"headers":{...},"body":string,"json":...}`
    );
  }
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/**
 * Stale check: the fixture and the fresh PHP oracle answer must be the SAME
 * response. Called on every real build, so a controller edit that changes its
 * JSON — or a hand-edited fixture — fails the build instead of baking a lie.
 */
export function assertFixtureFresh(fixture, oracle) {
  const a = JSON.stringify(canonical(fixture));
  const b = JSON.stringify(canonical(oracle));
  if (a !== b) {
    throw new Error(
      '@lw-precompute fixture is stale: the PHP oracle answered differently.\n' +
        `  fixture: ${a}\n  php:     ${b}\n` +
        '  regenerate the fixture by running the controller with the PHP oracle, then rebuild'
    );
  }
}

export default { precomputeDirective, resolveFixturePath, assertResponseShape, readFixture, assertFixtureFresh };
