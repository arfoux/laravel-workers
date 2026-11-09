#!/usr/bin/env node
// tools/constants-dump.mjs — pure-JS replacement for tools/constants-dump.php
//
// Usage: node tools/constants-dump.mjs "App\\Services\\Status" ...
// Output (stdout): JSON array of {fqcn, constants: {NAME: value}, error}
//
// Drop-in replacement: build.mjs can call this instead of
//   execFileSync(PHP, ['tools/constants-dump.php', ...fqcn])
// No PHP interpreter needed; no composer install; no vendor download.
// Output shape is bit-exact with the PHP tool it replaces.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppRoot } from './native-path.mjs';
import { classFile, parsePhpFile, classConstants } from './static.mjs';

const nodeName = (n) => {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name.name === 'string') return n.name.name;
  return '';
};

const appDir = resolveAppRoot();

if (!appDir) {
  process.stderr.write('constants-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
  process.exit(1);
}

const fqcns = process.argv.slice(2);
const out = [];

for (const fqcn of fqcns) {
  const entry = { fqcn, constants: [], error: null };
  const file = classFile(appDir, fqcn);
  if (!file || !existsSync(file)) {
    entry.error = 'class not found';
    out.push(entry);
    continue;
  }
  const parsed = parsePhpFile(file);
  if (parsed.error) {
    entry.error = parsed.error;
    out.push(entry);
    continue;
  }
  const short = fqcn.split('\\').pop();
  const ns = fqcn.includes('\\') ? fqcn.slice(0, fqcn.lastIndexOf('\\')) : '';
  const clsNode = parsed.classes.find(
    // `enum` is a class-like declaration: PHP's `class_exists()` is true for it
    // and `ReflectionClass::getConstants()` hands back its cases, so a file that
    // declares one must be found here (#701). The cases themselves are enum
    // INSTANCES - non-scalar, so PHP's dump drops them (`is_scalar() || null`)
    // and this one reads only the `classconst` nodes, which is the same set.
    (c) => (c.kind === 'class' || c.kind === 'enum') && c.name && nodeName(c.name) === short && (parsed.namespace || '') === ns
  );
  if (!clsNode) {
    // PHP's class_exists() is false for an interface/trait too, so the oracle
    // answers 'class not found' for those - match it.
    entry.error = 'class not found';
    out.push(entry);
    continue;
  }
  const r = classConstants(appDir, parsed, clsNode);
  const c = r.constants || {};
  // PHP's json_encode() prints an empty `$entry['constants']` as `[]` (it is a
  // PHP array), and a populated one as an object - keep the byte shape.
  entry.constants = Object.keys(c).length ? c : [];
  out.push(entry);
}

process.stdout.write(JSON.stringify(out, null, 0) + '\n');