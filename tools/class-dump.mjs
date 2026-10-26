#!/usr/bin/env node
// tools/class-dump.mjs — pure-JS replacement for tools/class-dump.php.
// Usage: node tools/class-dump.mjs "App\Policies\X" [...]
// Output (stdout): {"classes":{"<fqcn>":{"file":"...","kind":"service","ctor":[...]}}}
// Ctor entries: {name, kind: untyped|builtin|external|abstract|class, type?, default?}
// Mirrors the PHP oracle's Reflection-based classification exactly.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { classFile, parsePhpFile, evalConstantExpr, nodeName } from './static.mjs';

const appDir = process.env.LW_APP_ROOT || (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);
if (!appDir) { process.stderr.write('class-dump.mjs: cannot find app root\n'); process.exit(1); }

const BUILTINS = new Set(['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'true', 'false']);

const normalize = (p) => p.replace(/\\/g, '/');
const appPrefix = normalize(appDir) + '/app/';

/** Resolve a parameter type node to {fqcn, builtin} or null. */
const typeInfo = (type, parsed) => {
  if (!type) return null;
  if (type.kind === 'typereference') {
    const t = type.name || type.raw;
    return BUILTINS.has(t) ? { builtin: true, name: t } : null;
  }
  if (type.kind === 'name') {
    let t = type.name || '';
    t = String(t).replace(/^\\+/, '');
    if (!t) return null;
    if (BUILTINS.has(t)) return { builtin: true, name: t };
    // Resolve via file imports, then namespace, then as-is.
    if (parsed && parsed.imports && t in parsed.imports) t = parsed.imports[t].replace(/^\\+/, '');
    else if (parsed && parsed.namespace && !t.includes('\\')) t = parsed.namespace + '\\' + t;
    return { builtin: false, name: t };
  }
  return null;
};

/** Is the FQCN an app class per the PHP oracle's check (file under $root/app/)? */
const isAppClass = (fqcn) => {
  if (typeof fqcn !== 'string' || !fqcn) return false;
  const f = classFile(appDir, fqcn);
  if (!f) return false;
  const nf = normalize(f);
  return nf.startsWith(appPrefix);
};

/** Evaluate an AST default node to a scalar/null JS value, or undefined. */
const scalarDefault = (node, ctx) => {
  if (!node) return undefined;
  const v = evalConstantExpr(node, ctx);
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return undefined;
};

const parseCache = new Map();
const parsedOf = (file) => {
  if (!parseCache.has(file)) parseCache.set(file, parsePhpFile(file));
  return parseCache.get(file);
};

/** Resolve a `use`-aware name node (param type, extends target) to an FQCN. */
const resolveFqcn = (node, parsed) => {
  if (!node || !parsed) return null;
  let t = typeof node === 'string' ? node : (node.name || '');
  t = String(t).replace(/^\\+/, '');
  if (!t) return null;
  if (parsed.imports && t in parsed.imports) return parsed.imports[t].replace(/^\\+/, '');
  if (parsed.namespace && !t.includes('\\')) return parsed.namespace + '\\' + t;
  return t;
};
const fullName = (parsed, c) => ((parsed && parsed.namespace ? parsed.namespace + '\\' : '') + (c && c.name ? nodeName(c.name) : ''));
const findCls = (parsed, fqcn) => (parsed && !parsed.error ? (parsed.classes || []).find((c) => fullName(parsed, c) === fqcn) || null : null);

/** Find the AST `__construct` node for a class, walking its `extends` chain. */
const findCtor = (fqcn, depth = 0) => {
  if (depth > 20) return { ctor: null, parsed: null };
  const f = classFile(appDir, fqcn);
  if (!f) return { ctor: null, parsed: null };
  const parsed = parsedOf(f);
  const cls = findCls(parsed, fqcn);
  if (!cls) return { ctor: null, parsed };
  const ctor = (cls.body || []).find((m) => m && m.kind === 'method' && m.name && nodeName(m.name) === '__construct');
  if (ctor) return { ctor, parsed };
  if (parsed.error) return { ctor: null, parsed };
  const parent = cls.extends ? resolveFqcn(cls.extends, parsed) : null;
  if (!parent) return { ctor: null, parsed };
  return findCtor(parent, depth + 1);
};

/** ctor entry list for one FQCN, mirroring $ctorDump(). */
const ctorDump = (fqcn) => {
  const { ctor, parsed } = findCtor(fqcn);
  if (!ctor || !parsed) return [];
  const out = [];
  const ctx = { appDir, parsed, selfConstants: {} };
  for (const p of (ctor.arguments || [])) {
    const name = p.name && nodeName(p.name);
    if (!name) continue;
    const ti = typeInfo(p.type, parsed);
    const entry = { name };
    if (!ti) {
      entry.kind = 'untyped';
      out.push(entry);
      continue;
    }
    if (ti.builtin) {
      entry.kind = 'builtin';
      entry.type = ti.name;
      if (p.value) {
        const d = scalarDefault(p.value, ctx);
        if (d !== undefined) entry.default = d;
      }
      out.push(entry);
      continue;
    }
    entry.type = ti.name;
    if (!isAppClass(ti.name)) {
      entry.kind = 'external';
      out.push(entry);
      continue;
    }
    if (p.value) {
      const d = scalarDefault(p.value, ctx);
      if (d !== undefined) entry.default = d;
    }
    const clsFile = classFile(appDir, ti.name);
    const cp = clsFile ? parsedOf(clsFile) : null;
    const cnode = cp && !cp.error ? (cp.classes || []).find((c) => fullName(cp, c) === ti.name || (c.name && nodeName(c.name)) === ti.name.split('\\').pop()) : null;
    if (cnode && (cnode.isAbstract || cnode.kind === 'interface')) entry.kind = 'abstract';
    else entry.kind = 'class';
    out.push(entry);
  }
  return out;
};

const classes = {};
for (let i = 2; i < process.argv.length; i++) {
  const fqcn = String(process.argv[i]).replace(/^\\+/, '');
  if (!fqcn) continue;
  const f = classFile(appDir, fqcn);
  if (!f) continue;
  classes[fqcn] = { file: f, kind: 'service', ctor: ctorDump(fqcn) };
}
process.stdout.write(JSON.stringify({ classes }) + '\n');
