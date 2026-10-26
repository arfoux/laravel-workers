#!/usr/bin/env node
// tools/event-dump.mjs — pure-JS replacement for tools/event-dump.php.
// Usage: node tools/event-dump.mjs [<app_root>]   (or LW_APP_ROOT)
// Output (stdout) mirrors the PHP oracle's JSON: { events, classes, mailViews,
//   mailViewsByClass, mailableClasses }.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import parser from 'php-parser';
import {
  classFile, parsePhpFile, nodeName, callMethodName, callArgs, argValue, readEnvFile,
} from './static.mjs';

let appDir = process.env.LW_APP_ROOT || '';
if (!appDir && process.argv.length > 2 && process.argv[2] && existsSync(process.argv[2])) appDir = process.argv[2];
if (!appDir) appDir = existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : '';
if (!appDir) { process.stderr.write('event-dump.mjs: cannot find app root\n'); process.exit(1); }

const BUILTINS = new Set(['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'true', 'false']);
const normalize = (p) => p.replace(/\\/g, '/');
const appRootReal = normalize(appDir).replace(/\/+$/, '');
const isAppClass = (fqcn) => {
  if (typeof fqcn !== 'string' || !fqcn) return false;
  const f = classFile(appDir, fqcn);
  if (!f) return false;
  const nf = normalize(f);
  return nf.startsWith(appRootReal + '/') && !nf.includes('/vendor/');
};

const parseCache = new Map();
const parsedOf = (file) => {
  if (!parseCache.has(file)) parseCache.set(file, parsePhpFile(file));
  return parseCache.get(file);
};

const resolveName = (t, parsed) => {
  // t may be a string or an AST node (name / staticlookup `X::class`).
  if (t && typeof t === 'object') {
    if (t.kind === 'staticlookup' && ((t.offset && t.offset.name) === 'class' || (t.offset && t.offset.name) === 'class')) {
      t = t.what && (t.what.name || t.what.raw || nodeName(t.what));
    } else if (t.kind === 'name' || t.kind === 'typename') {
      t = t.name;
    } else if (t.kind === 'classconstant' && t.what) {
      t = t.what.name || nodeName(t.what);
    } else if (t.kind === 'reference' || t.kind === 'samenode') {
      t = t.name;
    } else {
      return typeof t === 'string' ? t : null;
    }
  }
  t = String(t || '').replace(/^\\+/, '');
  if (!t) return null;
  if (parsed && parsed.imports && t in parsed.imports) return parsed.imports[t].replace(/^\\+/, '');
  if (parsed && parsed.namespace && !t.includes('\\')) return parsed.namespace + '\\' + t;
  return t;
};
const fullName = (parsed, c) => ((parsed && parsed.namespace ? parsed.namespace + '\\' : '') + (c && c.name ? nodeName(c.name) : ''));
const findCls = (parsed, fqcn) => (parsed && !parsed.error ? ((parsed.classes || []).find((c) => fullName(parsed, c) === fqcn) || null) : null);

const scalarDefault = (node) => {
  if (!node) return undefined;
  switch (node.kind) {
    case 'string': return node.value;
    case 'number': {
      const n = Number(node.value);
      return Number.isNaN(n) ? node.value : n;
    }
    case 'boolean': return node.value;
    case 'nullkeyword': return null; // PHP: is_scalar($d) || $d === null  -> records null
    default: return undefined;
  }
};

// Fluent builder value extraction needs raw literals (argValue may not keep
// scalar-only). Guard uniformly for event/class dump purposes.
const strLit = (n) => {
  if (n && n.kind === 'string') return n.value;
  if (typeof n === 'string') return n;
  if (n && n.kind === 'number') return n.value;
  return null;
};

// The container-stub bindings: app providers' bind()/singleton().
let bindingsGlobal = null;
const appBindings = () => {
  if (bindingsGlobal) return bindingsGlobal;
  bindingsGlobal = {};
  const provDir = join(appDir, 'app', 'Providers');
  let files = [];
  try { files = readdirSync(provDir).filter(f => f.endsWith('.php')).map(f => join(provDir, f)); } catch { files = []; }
  for (const file of files) {
    const parsed = parsedOf(file);
    if (parsed.error || !parsed.source) continue;
    let ast;
    try { ast = new (require.presolve.parserClass)({ parser: { extractDoc: false }, ast: { withPositions: false } }).parseCode(parsed.source); } catch { continue; }
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const m = callMethodName(n);
      if (n.kind === 'call' && (m === 'bind' || m === 'singleton')) {
        const args = callArgs(n).map(argValue);
        const abs = args[0], impl = args[1];
        if (abs && typeof abs === 'string') {
          const absC = abs.replace(/^\\+/, '');
          if (impl && typeof impl === 'string') bindingsGlobal[absC] = impl.replace(/^\\+/, '');
          else bindingsGlobal[absC] = absC;
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw' || k === 'parent') continue;
        walk(n[k]);
      }
    };
    walk(ast);
  }
  return bindingsGlobal;
};

const ctorDump = (fqcn) => {
  const f = classFile(appDir, fqcn);
  if (!f) return [];
  const parsed = parsedOf(f);
  if (parsed.error) return [];
  const cls = findCls(parsed, fqcn);
  if (!cls) return [];
  let ctor = null;
  let ctorParsed = parsed;
  let curCls = cls;
  let curFqcn = fqcn;
  let curPar = parsed;
  // Walk the extends chain (PHP getConstructor returns the ancestor ctor).
  const walkChain = (startCls, startPar, startFqcn) => {
    let c = startCls, p = startPar, cf = startFqcn;
    for (let depth = 0; depth < 20 && c; depth++) {
      const m = (c.body || []).find((mm) => mm && mm.kind === 'method' && mm.name && nodeName(mm.name) === '__construct');
      if (m) return { ctor: m, parsed: p };
      const parent = c.extends ? resolveName(c.extends, p) : null;
      if (!parent) return { ctor: null, parsed: p };
      const pf = classFile(appDir, parent);
      if (!pf) return { ctor: null, parsed: p };
      p = parsedOf(pf);
      c = findCls(p, parent);
      cf = parent;
    }
    return { ctor: null, parsed: startPar };
  };
  const found = walkChain(curCls, curPar, curFqcn);
  ctor = found.ctor; ctorParsed = found.parsed;
  if (!ctor) return [];
  const out = [];
  const bindings = appBindings();
  for (const param of (ctor.arguments || [])) {
    const name = param.name && nodeName(param.name);
    if (!name) continue;
    const entry = { name };
    const isBuiltin = param.type && (param.type.kind === 'typereference' && BUILTINS.has(param.type.name || param.type.raw));
    if (isBuiltin) {
      entry.kind = 'builtin';
      entry.type = param.type.name || param.type.raw;
      const v = scalarDefault(param.value, ctorParsed);
      if (v !== undefined) entry.default = v;
      out.push(entry);
      continue;
    }
    const tname = param.type ? resolveName(param.type, ctorParsed) : null;
    if (!tname) {
      // untyped: the container resolves by name -> a class when one exists.
      entry.kind = 'untyped';
      if (classFile(appDir, name)) { entry.kind = 'external'; entry.type = name; }
      else if (param.value) {
        const v = scalarDefault(param.value, ctorParsed);
        if (v !== undefined) { entry.kind = 'builtin'; entry.type = 'mixed'; entry.default = v; }
      }
      out.push(entry);
      continue;
    }
    if (BUILTINS.has(tname)) { entry.kind = 'builtin'; entry.type = tname; const v = scalarDefault(param.value, ctorParsed); if (v !== undefined) entry.default = v; out.push(entry); continue; }
    entry.type = tname;
    if (!isAppClass(tname)) { entry.kind = 'external'; out.push(entry); continue; }
    const v = scalarDefault(param.value, ctorParsed);
    if (v !== undefined) entry.default = v;
    const rf = classFile(appDir, tname);
    if (!rf) { entry.kind = 'class'; out.push(entry); continue; }
    const rp = parsedOf(rf);
    const rc = findCls(rp, tname);
    if (rc && (rc.kind === 'interface' || rc.isAbstract)) {
      const impl = bindings[tname] || null;
      if (impl && impl !== tname && isAppClass(impl)) { entry.kind = 'class'; entry.impl = impl; }
      else entry.kind = 'abstract';
      out.push(entry);
      continue;
    }
    entry.kind = 'class';
    out.push(entry);
  }
  return out;
};

// The mailable view names, mirroring lw_mailable_views().
const mailableViews = (source) => {
  const views = [];
  if (!source) return views;
  const patterns = [
    /->(?:view|textView|markdown)\(\s*(["'])([^"']+)\1/,
    /\bpublic\s+\$(?:view|textView)\s*=\s*(["'])([^"']+)\1/,
    /\$this->(?:view|textView)\s*=\s*(["'])([^"']+)\1/,
  ];
  const found = [];
  let order = 0;
  for (const pattern of patterns) {
    let m;
    const re = new RegExp(pattern.source, 'g');
    while ((m = re.exec(source)) !== null) found.push({ at: m.index, name: m[2], order: order++ });
  }
  found.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  for (const m of found) if (!views.includes(m.name)) views.push(m.name);
  return views;
};

const classes = {};
const addClass = (fqcn, kind = 'service') => {
  if (!fqcn || classes[fqcn]) return;
  if (!isAppClass(fqcn)) return;
  const f = classFile(appDir, fqcn);
  if (!f) return;
  classes[fqcn] = { file: f, kind, ctor: ctorDump(fqcn) };
  for (const p of (classes[fqcn].ctor || [])) {
    if ((p.kind || '') !== 'class') continue;
    addClass(p.impl || p.type, 'service');
  }
};

const listPhp = (dir) => {
  try { return readdirSync(dir).filter((x) => x.endsWith('.php')).map((x) => join(dir, x)); } catch { return []; }
};
const listPhpByDir = listPhp; 

const events = {};
const eventsFinal = events;
const classesFinal = () => classes;
const mailViewsFinal = [];
const mailViewsByClassFinal = {};
const mailableClassesFinal = [];

for (const f of listPhpByDir(join(appDir, 'app/Jobs'))) addClass('App\\Jobs\\' + f.split(/[\\/]/).pop().replace(/\.php$/, ''), 'job');
for (const f of listPhpByDir(join(appDir, 'app/Http/Resources'))) addClass('App\\Http\\Resources\\' + f.split(/[\\/]/).pop().replace(/\.php$/, ''), 'resource');
for (const f of listPhpByDir(join(appDir, 'app/Http/Requests'))) addClass('App\\Http\\Requests\\' + f.split(/[\\/]/).pop().replace(/\.php$/, ''), 'formRequest');
for (const f of listPhpByDir(join(appDir, 'app/Mail'))) {
  const fqcn = 'App\\Mail\\' + f.split(/[\\/]/).pop().replace(/\.php$/, '');
  addClass(fqcn, 'mailable');
  mailableClassesFinal.push(fqcn);
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch {}
  const views = mailableViews(src);
  if (views.length) {
    mailViewsByClassFinal[fqcn] = views;
    for (const v of views) mailViewsFinal.push(v);
  }
}

// The app's event/listener map (static): explicit $listen + auto-discovery.
// The listeners' flags (queued/broadcast/afterCommit) via contract match.
const flagsOf = (src) => ({
  queued: /ShouldQueue/.test(src || ''),
  broadcast: /ShouldBroadcast/.test(src || ''),
  afterCommit: /ShouldDispatchAfterCommit/.test(src || ''),
});

const addListenerEnv = (evName, listener, srcFile) => {
  let src = '';
  if (srcFile) { try { src = readFileSync(srcFile, 'utf8'); } catch {} }
  eventsFinal[evName] = eventsFinal[evName] || { listeners: [] };
  if (!eventsFinal[evName].listeners.includes(listener)) eventsFinal[evName].listeners.push(listener);
  const flags = flagsOf(src);
  for (const k of ['queued', 'broadcast', 'afterCommit']) {
    if (flags[k]) {
      const bucket = (eventsFinal[evName][k] = eventsFinal[evName][k] || []);
      if (!bucket.includes(listener)) bucket.push(listener);
    }
  }
};

// 1) explicit `$listen` map in app/Providers/EventServiceProvider.php
const esp = join(appDir, 'app/Providers/EventServiceProvider.php');
if (existsSync(esp)) {
  const parsed = parsedOf(esp);
  if (!parsed.error) {
    const cls = parsed.classes.find((c) => fullName(parsed, c) === 'App\\Providers\\EventServiceProvider');
    if (cls) {
      const listenProp = (cls.body || []).find((m) => m && m.kind === 'propertystatement'
        && (m.properties || []).some((p) => p && p.name && nodeName(p.name) === 'listen'));
      const listenVal = listenProp && (listenProp.properties || []).find((p) => p && p.name && nodeName(p.name) === 'listen');
      if (listenVal && listenVal.value && listenVal.value.kind === 'array') {
        for (const e of (listenVal.value.items || [])) {
          if (!e || e.kind !== 'entry' || !e.key) continue;
          const evName = resolveName(e.key, parsed);
          if (!evName) continue;
          const arrVal = e.value;
          if (arrVal && arrVal.kind === 'array') {
            for (const it of (arrVal.items || [])) {
              const vNode = it && it.kind === 'entry' ? it.value : it;
              const l = resolveName(vNode, parsed);
              if (!l) continue;
              addListenerEnv(evName, l, classFile(appDir, l));
            }
          } else if (arrVal && (arrVal.kind === 'name' || arrVal.kind === 'staticlookup')) {
            const l = resolveName(arrVal, parsed);
            if (l) addListenerEnv(evName, l, classFile(appDir, l));
          }
        }
      }
    }
  }
}

// 2) auto-discovery: App\Listeners classes with a handle(Event $e) method.
for (const f of listPhpByDir(join(appDir, 'app/Listeners'))) {
  const fqcn = 'App\\Listeners\\' + f.split(/[\\/]/).pop().replace(/\.php$/, '');
  if (!classFile(appDir, fqcn)) continue;
  const parsed = parsedOf(f);
  if (parsed.error) continue;
  const cls = parsed.classes.find((c) => fullName(parsed, c) === fqcn);
  if (!cls) continue;
  const handle = (cls.body || []).find((m) => m && m.kind === 'method' && m.name && nodeName(m.name) === 'handle');
  if (!handle) continue;
  const first = (handle.arguments || [])[0];
  const evName = first && first.type ? resolveName(first.type, parsed) : null;
  if (!evName) continue;
  addListenerEnv(evName, fqcn, f);
}

// 3) register events + listeners as app classes (mirrors $addClass).
const evFiles = {};
for (let evName of Object.keys(eventsFinal)) {
  evName = evName.replace(/^\\+/, '');
  addClass(evName, 'event');
  const f = classFile(appDir, evName);
  if (f) evFiles[evName] = f;
  for (const l of (eventsFinal[evName].listeners || [])) {
    addClass(l, 'listener');
  }
}

// The file of every event class (the listeners are in the map above).
for (const [evName, ev] of Object.entries(eventsFinal)) {
  if (evFiles[evName] && (classes[evName] || {}).file) eventsFinal[evName] = { ...ev, file: classes[evName].file };
}

const out = {
  events: Object.keys(eventsFinal).length ? eventsFinal : [],
  classes: Object.keys(classes).length ? classes : [],
  mailViews: Array.from(new Set(mailViewsFinal)),
  mailViewsByClass: Object.keys(mailViewsByClassFinal).length ? mailViewsByClassFinal : [],
  mailableClasses: mailableClassesFinal,
};
process.stdout.write(JSON.stringify(out) + '\n');


