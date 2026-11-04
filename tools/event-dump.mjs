#!/usr/bin/env node
// tools/event-dump.mjs — pure-JS replacement for tools/event-dump.php.
// Usage: node tools/event-dump.mjs [<app_root>]   (or LW_APP_ROOT)
// Output (stdout) mirrors the PHP oracle's JSON: { events, classes, mailViews,
//   mailViewsByClass, mailableClasses }.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  classFile, parsePhpFile, parsePhpSource, nodeName, callMethodName, callArgs, argValue, readEnvFile, appPsr4Dirs,
} from './static.mjs';

// The positional app root wins over `LW_APP_ROOT`: the PHP oracle reads
// `$argv[1]` only, and the build passes the app positionally too — an ambient
// `LW_APP_ROOT` (the documented way to point the *other* dump tools at an app)
// must not silently redirect this dump to a different app than the caller named.
let appDir =
  process.argv.length > 2 && process.argv[2] && existsSync(process.argv[2])
    ? process.argv[2]
    : process.env.LW_APP_ROOT || '';
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
  let s = String(t || '');
  // A leading '\' (or php-parser's resolution='fqn') means the GLOBAL
  // namespace: PHP resolves it there, so the file's namespace/imports must
  // not touch it (`\DateTimeInterface` is NOT App\Mail\DateTimeInterface).
  const qualified = s.startsWith('\\') || (t && typeof t === 'object' && t.resolution === 'fqn');
  t = s.replace(/^\\+/, '');
  if (!t) return null;
  if (qualified) return t;
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
  // Providers live under the composer `App\` mapping (`app/Providers` in the
  // skeleton, `src/Providers` when the app remaps the prefix).
  const provFiles = [];
  for (const srcDir of appPsr4Dirs(appDir)) {
    const provDir = join(srcDir, 'Providers');
    try {
      for (const f of readdirSync(provDir)) if (f.endsWith('.php')) provFiles.push(join(provDir, f));
    } catch { /* no Providers dir under this mapping */ }
  }
  const files = provFiles;
  for (const file of files) {
    const parsed = parsedOf(file);
    if (parsed.error || !parsed.source) continue;
    let ast;
    try { ast = parsePhpSource(parsed.source); } catch { continue; }
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const m = callMethodName(n);
      if (n.kind === 'call' && (m === 'bind' || m === 'singleton')) {
        // `bind(Foo::class, Bar::class)` (or a string literal): the arguments
        // are AST NODES, so `Foo::class` must be resolved to its FQCN through
        // the file's imports (resolveName) - comparing the node to a string
        // never matched and the binding was silently dropped.
        const args = callArgs(n).map((a) => resolveName(argValue(a), parsed));
        const abs = args[0], impl = args[1];
        if (abs) bindingsGlobal[abs] = impl || abs;
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

const isNullType = (t) => {
  if (!t) return false;
  if (t.kind === 'typereference') return (t.name || t.raw) === 'null';
  if (t.kind === 'name') return (t.name || '') === 'null';
  return false;
};

/**
 * PHP's Reflection only keeps a ReflectionUnionType for a REAL union: `X|null`
 * (and `?X`) collapse to a nullable ReflectionNamedType, while `string|int`,
 * `int|string|null` and `A|B` stay unions - and the oracle answers 'untyped'
 * for those. Returns the single named type node, or null when the declaration
 * is a real union/intersection (or absent). Verified against PHP 8.3.
 */
const collapseType = (type) => {
  if (!type) return null;
  if (type.kind === 'uniontype') {
    const members = (type.types || []).filter(Boolean).filter((m) => !isNullType(m));
    return members.length === 1 ? collapseType(members[0]) : null;
  }
  if (type.kind === 'nullabletype') return collapseType(type.type || null);
  if (type.kind === 'intersectiontype') return null;
  return type;
};

// The resolved parent FQCN of a class (`extends` through the file's own
// `use` map) - null when the class is in the same file without a parent, when
// the parent is not an app class, or when the source cannot be read.
const parentFqcn = (fqcn) => {
  const f = classFile(appDir, fqcn);
  if (!f) return null;
  const parsed = parsedOf(f);
  const cls = findCls(parsed, fqcn);
  if (!cls || !cls.extends) return null;
  return resolveName(cls.extends, parsed) || null;
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
    const named = collapseType(param.type); // null = real union / absent
    const isBuiltin = named && named.kind === 'typereference' && BUILTINS.has(named.name || named.raw);
    if (isBuiltin) {
      entry.kind = 'builtin';
      entry.type = named.name || named.raw;
      const v = scalarDefault(param.value, ctorParsed);
      if (v !== undefined) entry.default = v;
      out.push(entry);
      continue;
    }
    const tname = named ? resolveName(named, ctorParsed) : null;
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

// The mailable view names, mirroring lw_mailable_views(). The PHP tool is
// the oracle; this mirror must answer the SAME names for the same source.
//
// The source is scanned, never regexed: a `->view('x')` inside a `//`
// comment or inside a string literal is NOT a call, and a pattern scan
// cannot know that. `phpTokens()` is the subset of PHP's lexer this needs:
// comments and whitespace vanish, a string literal stays ONE token (quotes
// and all), `->` is one token and `$var` / `public` / an identifier are
// their own tokens - the same three shapes the PHP tool walks.
const phpTokens = (src) => {
  const toks = [];
  const n = src.length;
  const identStart = (c) => /[A-Za-z_\u0080-\uffff]/.test(c);
  const ident = (c) => /[A-Za-z0-9_\u0080-\uffff]/.test(c);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i += 1; continue; }
    // `#` opens a line comment - except `#[`, which is PHP 8's T_ATTRIBUTE:
    // the attribute's own tokens are CODE (a string inside it is a string).
    if (c === '#' && src[i + 1] !== '[') { i += 1; while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    // Heredoc / nowdoc: the body is opaque to PHP's lexer (T_ENCAPSED_AND_
    // WHITESPACE between T_START_HEREDOC and T_END_HEREDOC), so it must be
    // opaque here too - a `->view('x')` written inside one is not a call.
    if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      const head = /^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\r?\n/.exec(src.slice(i));
      if (head) {
        const label = head[1] || head[2] || head[3];
        const close = new RegExp('^(?:' + label + ')\\b');
        let j = i + head[0].length;
        while (j < n) {
          const nl = src.indexOf('\n', j);
          const lineEnd = nl < 0 ? n : nl;
          if (close.test(src.slice(j, lineEnd).replace(/^\s+/, ''))) { j = lineEnd; break; }
          if (nl < 0) { j = n; break; }
          j = nl + 1;
        }
        toks.push({ id: 'STRING', text: src.slice(i, j) });
        i = j; continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let interp = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (c === '"' && d === '$' && j + 1 < n && (identStart(src[j + 1]) || src[j + 1] === '{')) interp = true;
        if (d === c) break;
        j += 1;
      }
      const end = Math.min(j + 1, n);
      // An interpolated double-quoted string is not a literal name: PHP's
      // lexer splits it too, and the PHP tool's T_CONSTANT_ENCAPSED_STRING
      // check rejects it.
      toks.push({ id: interp ? 'INTERP' : 'STRING', text: src.slice(i, end) });
      i = end; continue;
    }
    if (c === '-' && src[i + 1] === '>') { toks.push({ id: 'OBJECT_OPERATOR', text: '->' }); i += 2; continue; }
    if (c === '?' && src[i + 1] === '-' && src[i + 2] === '>') { toks.push({ id: 'NULLSAFE_OBJECT_OPERATOR', text: '?->' }); i += 3; continue; }
    if (c === '$') {
      let j = i + 1;
      while (j < n && ident(src[j])) j += 1;
      toks.push({ id: 'VARIABLE', text: src.slice(i, j) });
      i = j; continue;
    }
    if (identStart(c)) {
      let j = i;
      while (j < n && ident(src[j])) j += 1;
      const w = src.slice(i, j);
      toks.push({ id: w === 'public' ? 'PUBLIC' : 'METHOD', text: w });
      i = j; continue;
    }
    toks.push({ id: null, text: c });
    i += 1;
  }
  return toks;
};

// The view name a literal token holds, or null when the token is not a plain
// (non-interpolated) string literal. Mirrors lw_mailable_literal().
const mailableLiteral = (t) => {
  if (!t || t.id !== 'STRING') return null;
  const raw = t.text;
  const q = raw[0];
  if ((q !== '"' && q !== "'") || raw.length < 2 || raw[raw.length - 1] !== q) return null;
  const inner = raw.slice(1, -1);
  if (!inner) return null;
  return inner.split('\\\\').join('\\').split('\\' + q).join(q);
};

const mailableViews = (source) => {
  const views = [];
  if (!source) return views;
  const toks = phpTokens(source);
  const has = (k, ...names) => toks[k] && toks[k].id === 'METHOD' && names.includes(toks[k].text);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    let name = null;
    if ((t.id === 'OBJECT_OPERATOR' || t.id === 'NULLSAFE_OBJECT_OPERATOR')
      && has(i + 1, 'view', 'textView', 'markdown')
      && toks[i + 2] && toks[i + 2].text === '(') {
      // The fluent call: `->view(` then a literal argument.
      name = mailableLiteral(toks[i + 3]);
    } else if (t.id === 'PUBLIC') {
      // The declaration: `public [type] $view = 'x';`.
      for (let j = i + 1; j <= i + 4 && j < toks.length; j += 1) {
        if (toks[j].id === 'VARIABLE') {
          if ((toks[j].text === '$view' || toks[j].text === '$textView')
            && toks[j + 1] && toks[j + 1].text === '=') {
            name = mailableLiteral(toks[j + 2]);
          }
          break;
        }
      }
    } else if (t.id === 'VARIABLE' && t.text === '$this'
      && toks[i + 1] && toks[i + 1].id === 'OBJECT_OPERATOR'
      && has(i + 2, 'view', 'textView') && toks[i + 3] && toks[i + 3].text === '=') {
      // The assignment: `$this->view = 'x';` (the constructor).
      name = mailableLiteral(toks[i + 4]);
    }
    if (name !== null && !views.includes(name)) views.push(name);
  }
  return views;
};

const classes = {};
const addClass = (fqcn, kind = 'service') => {
  if (!fqcn || classes[fqcn]) return;
  if (!isAppClass(fqcn)) return;
  const f = classFile(appDir, fqcn);
  if (!f) return;
  // `parent` is the resolved parent FQCN: the class compiler distinguishes a
  // plain resource (JsonResource) from a collection resource
  // (ResourceCollection) with it.
  classes[fqcn] = { file: f, kind, parent: parentFqcn(fqcn), ctor: ctorDump(fqcn) };
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

// The app classes the build compiles, discovered under the composer `App\`
// mapping (see appPsr4Dirs) rather than a hard-coded `app/`: a project that
// maps the prefix to `src/` keeps these in `src/Jobs`, `src/Mail`, ...
const appClassFiles = (sub) => {
  const out = [];
  for (const srcDir of appPsr4Dirs(appDir)) {
    out.push(...listPhpByDir(join(srcDir, sub)));
  }
  return out;
};
const shortName = (f) => f.split(/[\\/]/).pop().replace(/\.php$/, '');
const dedupeByShortName = (files) => {
  const seen = new Map();
  for (const f of files) if (!seen.has(shortName(f))) seen.set(shortName(f), f);
  return [...seen.values()];
};

for (const f of dedupeByShortName(appClassFiles('Jobs'))) addClass('App\\Jobs\\' + shortName(f), 'job');
for (const f of dedupeByShortName(appClassFiles('Http/Resources'))) addClass('App\\Http\\Resources\\' + shortName(f), 'resource');
for (const f of dedupeByShortName(appClassFiles('Http/Requests'))) addClass('App\\Http\\Requests\\' + shortName(f), 'formRequest');
for (const f of dedupeByShortName(appClassFiles('Mail'))) {
  const fqcn = 'App\\Mail\\' + shortName(f);
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

// 1) explicit `$listen` map in the app's EventServiceProvider (under the
// composer `App\` mapping: `app/Providers` or `src/Providers`).
const esp = appPsr4Dirs(appDir)
  .map((srcDir) => join(srcDir, 'Providers', 'EventServiceProvider.php'))
  .find((p) => existsSync(p)) || null;
if (esp) {
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
for (const f of dedupeByShortName(appClassFiles('Listeners'))) {
  const fqcn = 'App\\Listeners\\' + shortName(f);
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


