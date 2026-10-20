// compiler/src/classes.mjs — the class compiler (build time).
//
// An event listener (and the event class it receives) is a PHP class: at the
// edge there is no listener runtime, so a dispatch that answers nothing would
// be a *silent* no-op. The compiled rung compiles the classes instead: the
// constructor (the promoted properties), the public methods (their bodies
// through the ordinary transpiler) and the event -> listener map.
//
// The metadata comes from tools/event-dump.php (Laravel's own resolution: the
// explicit `$listen` + the auto-discovery), so the compiled listeners are
// exactly the ones the real app would call.
//
// The generated module (dist/src/classes.generated.mjs) exports:
//   classes        { FQCN: { ctor: (args) => object, methods: { name: async fn } } }
//   eventListeners { FQCN: [listenerFQCN] }
//
// Anything the compiled rung cannot answer exactly fails loud here: the class
// is not compiled and the routes that use it stay blocked.
import parser from 'php-parser';
import { readFileSync } from 'node:fs';
import { transpileControllerMethod } from './transpiler.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const vname = (name) => 'v_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');
const shortName = (fqcn) => String(fqcn).split('\\').pop();
const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
// The name of an AST node (a string or a `{ name }` object).
const nodeName = (n) => {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name.name === 'string') return n.name.name;
  return '';
};

// ---------------------------------------------------------------------------
// the AST of the class file
// ---------------------------------------------------------------------------

function parseClassFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    return { error: 'the class file could not be read: ' + (e.message || e) };
  }
  let ast;
  try {
    ast = phpParser.parseCode(source);
  } catch (e) {
    return { error: 'parse error: ' + (e.message || String(e)) };
  }
  if (ast && ast.errors && ast.errors.length) {
    const first = ast.errors[0];
    return { error: 'parse error: ' + (first.msg || first.message || JSON.stringify(first)) };
  }
  const classes = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
      classes.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      walk(node[key]);
    }
  };
  walk(ast);
  return { classes };
}

function classMembers(classNode) {
  const body = classNode && classNode.body;
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return Array.isArray(body.children) ? body.children : [];
}

function findMethod(classNode, name) {
  for (const m of classMembers(classNode)) {
    if (m && m.kind === 'method' && nodeName(m.name) === name) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the constructor (the promoted properties)
// ---------------------------------------------------------------------------

// A PHP literal the compiled constructor can inline (the default value of a
// promoted property).
function literalOf(node) {
  if (!node) return null;
  switch (node.kind) {
    case 'null': return { js: 'null' };
    case 'boolean': return { js: node.value ? 'true' : 'false' };
    case 'number': return { js: String(node.value) };
    case 'string': return { js: JSON.stringify(node.value) };
    case 'array': {
      const items = (node.items || []).filter((i) => i && i.kind !== 'comment');
      if (!items.length) return { js: '[]' };
      return null;
    }
    default: return null;
  }
}

function compileConstructor(fqcn, classNode, opts) {
  const ctor = findMethod(classNode, '__construct');
  const props = [];
  if (!ctor) return { js: '(args) => ({})' };
  const params = ctor.arguments || [];
  const body = (ctor.body && ctor.body.children) || [];
  const hasBody = body.some((s) => s && s.kind !== 'comment' && s.kind !== 'nop');
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p || !p.name) continue;
    const visibility = p.visibility || p.flags || null;
    if (!visibility) continue; // a plain parameter: not a property
    const name = typeof p.name === 'string' ? p.name : p.name.name;
    if (!name) continue;
    let fallback = 'undefined';
    if (p.value !== undefined && p.value !== null) {
      const lit = literalOf(p.value);
      if (!lit) {
        return { error: 'the promoted property $' + name + ' of ' + fqcn + ' has a default the compiled rung cannot inline' };
      }
      fallback = lit.js;
    }
    props.push('      ' + JSON.stringify(name) + ': (args[' + i + '] === undefined ? ' + fallback + ' : args[' + i + '])');
  }
  const promoted = props.length ? '{\n' + props.join(',\n') + ',\n    }' : '{}';
  if (!hasBody) return { js: '(args) => (' + promoted + ')' };

  // A constructor with a body: the body compiles like a method (the promoted
  // properties and the assignments land on the same object).
  const emitted = transpileControllerMethod(body, {
    models: opts.modelAliases,
    modelNotCompiled: opts.modelNotCompiled,
    modelClassFqcns: opts.modelClassFqcns,
    views: new Set(),
    indent: '    ',
    paramVars: new Set(params.map((p) => vname(nodeName(p.name)))),
    requestVars: new Set(),
    constants: opts.constants || {},
    formRequests: new Map(),
    modelVarSeeds: [],
    classes: opts.classes,
    classMethod: true,
    // The constructor builds its own object.
    thisVar: '__self',
  });
  if (emitted.errors.length) {
    return { error: 'the constructor of ' + fqcn + ' did not compile: ' + emitted.errors[0].message };
  }
  const bodyCode = String(emitted.code || '')
    .split('\n')
    .map((l) => (l ? '    ' + l : l))
    .join('\n');
  return {
    js:
      'function (args) {\n' +
      '    const __self = ' + promoted + ';\n' +
      bodyCode + '\n' +
      '    return __self;\n' +
      '  }',
  };
}

// ---------------------------------------------------------------------------
// the methods
// ---------------------------------------------------------------------------

// The PHP built-in types (a parameter with one of them is not a service).
const BUILTIN_TYPES = new Set([
  'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'array', 'object',
  'mixed', 'void', 'callable', 'iterable', 'null', 'false', 'true', 'self', 'static', 'never',
]);

// The type of a parameter (the AST gives an object: { kind, name }).
function typeNameOf(typeNode) {
  if (!typeNode) return null;
  if (typeof typeNode === 'string') return typeNode;
  if (typeof typeNode.name === 'string') return typeNode.name;
  return null;
}

function compileMethod(fqcn, methodNode, opts) {
  const name = nodeName(methodNode.name);
  if (methodNode.isStatic) {
    return { error: 'the method ' + fqcn + '::' + name + '() is static — the compiled classes are instances' };
  }
  if (methodNode.abstract) {
    return { error: 'the method ' + fqcn + '::' + name + '() is abstract' };
  }
  const params = (methodNode.arguments || []).map((p) => {
    const type = typeNameOf(p && p.type);
    return {
      name: nodeName(p && p.name),
      type: type && !BUILTIN_TYPES.has(type.toLowerCase()) ? type : null,
      variadic: !!(p && p.variadic),
      byRef: !!(p && p.byRef),
    };
  });
  for (const p of params) {
    if (p.variadic) return { error: 'the method ' + fqcn + '::' + name + '() has a variadic parameter' };
    if (p.byRef) return { error: 'the method ' + fqcn + '::' + name + '() has a by-reference parameter' };
    if (p.type && !opts.eventClasses.has(p.type) && !opts.eventShortNames.has(p.type)) {
      return {
        error:
          'the method ' + fqcn + '::' + name + '() takes a ' + p.type + ' — the edge cannot inject a service ' +
          '(the compiled classes take the event and the plain values only)',
      };
    }
  }
  const paramVars = new Set(params.map((p) => vname(p.name)));
  const emitted = transpileControllerMethod((methodNode.body && methodNode.body.children) || [], {
    models: opts.modelAliases,
    modelNotCompiled: opts.modelNotCompiled,
    modelClassFqcns: opts.modelClassFqcns,
    views: new Set(),
    indent: '    ',
    paramVars,
    requestVars: new Set(),
    constants: opts.constants || {},
    formRequests: new Map(),
    modelVarSeeds: [],
    // The classes the build compiled: `new X(...)` and the event dispatch.
    classes: opts.classes,
    classMethod: true,
  });
  if (emitted.errors.length) {
    return { error: 'the method ' + fqcn + '::' + name + '() did not compile: ' + emitted.errors[0].message };
  }
  const args = ['rt'].concat(params.map((p) => vname(p.name)));
  return {
    js:
      'async function (' + args.join(', ') + ') {\n' +
      String(emitted.code || '')
        .split('\n')
        .map((l) => (l ? '      ' + l : l))
        .join('\n') +
      '\n    }',
    params: params.map((p) => vname(p.name)),
  };
}

// ---------------------------------------------------------------------------
// the whole registry
// ---------------------------------------------------------------------------

export function compileClasses(dump, opts = {}) {
  const events = (dump && dump.events) || {};
  const classMap = (dump && dump.classes) || {};
  const options = {
    // The class names the class body may use (the aliases the app writes +
    // the FQCNs): a model chain inside a listener (`Post::where(...)`)
    // resolves against them.
    modelAliases:
      opts.modelAliases instanceof Set ? opts.modelAliases : new Set(Object.keys(opts.modelClassFqcns || {})),
    modelNotCompiled: opts.modelNotCompiled || new Map(),
    modelClassFqcns: opts.modelClassFqcns || {},
    constants: opts.constants || {},
    classes: opts.classes instanceof Set ? opts.classes : new Set(opts.classes || []),
    eventClasses: new Set(Object.keys(events)),
    // The short name of the event classes (the source writes `PostPublished`).
    eventShortNames: new Set(Object.keys(events).map((fqcn) => shortName(fqcn))),
  };

  const meta = {};
  const entries = [];
  const errors = [];

  // The queued listeners (ShouldQueue): Laravel pushes them to the queue (they
  // run later, in a worker); the edge has no consumer, so running them inline
  // would be a different behaviour — they are not compiled.
  const queued = new Set();
  for (const info of Object.values(events)) {
    for (const q of info.queued || []) queued.add(q);
  }

  for (const [fqcn, info] of Object.entries(classMap)) {
    if (queued.has(fqcn)) {
      errors.push({
        class: fqcn,
        message:
          'the listener ' + fqcn + ' is queued (ShouldQueue) — Laravel pushes it to the queue and it runs later; ' +
          'the edge has no queue consumer, so the compiled rung does not run it inline',
      });
      continue;
    }
    const parsed = parseClassFile(info.file);
    if (parsed.error) {
      errors.push({ class: fqcn, message: parsed.error });
      continue;
    }
    const short = shortName(fqcn);
    const classNode = parsed.classes.find((c) => nodeName(c.name) === short);
    if (!classNode) {
      errors.push({ class: fqcn, message: 'the class ' + fqcn + ' is not in ' + info.file });
      continue;
    }
    const ctor = compileConstructor(fqcn, classNode, options);
    if (ctor.error) {
      errors.push({ class: fqcn, message: ctor.error });
      continue;
    }
    const methods = {};
    let failed = null;
    for (const m of classMembers(classNode)) {
      if (!m || m.kind !== 'method') continue;
      if (m.visibility && m.visibility !== 'public') continue;
      const methodName = nodeName(m.name);
      if (methodName === '__construct') continue;
      const r = compileMethod(fqcn, m, options);
      if (r.error) {
        failed = r.error;
        break;
      }
      methods[methodName] = { js: r.js, params: r.params };
    }
    if (failed) {
      errors.push({ class: fqcn, message: failed });
      continue;
    }
    meta[fqcn] = { file: info.file, methods: Object.keys(methods) };
    entries.push({ fqcn, ctor: ctor.js, methods });
  }

  // The event -> listener map (only the events whose classes compiled).
  const listeners = {};
  for (const [event, info] of Object.entries(events)) {
    if (!meta[event]) continue;
    const list = (info.listeners || []).filter((l) => meta[l]);
    if (!list.length) continue;
    listeners[event] = list;
  }

  return { code: emitRegistry(entries, listeners), errors, meta };
}

// The generated module: the compiled classes + the event -> listener map.
function emitRegistry(entries, listeners) {
  const lines = [];
  lines.push('// generated by laravel-workers — the compiled classes (do not edit)');
  lines.push('// The event listeners: at the edge there is no listener runtime, so the');
  lines.push('// classes are compiled and the dispatch calls them (Laravel: synchronous).');
  lines.push('');
  lines.push('export const classes = {');
  for (const e of entries) {
    lines.push('  ' + JSON.stringify(e.fqcn) + ': {');
    lines.push('    ctor: ' + e.ctor + ',');
    lines.push('    methods: {');
    for (const [name, m] of Object.entries(e.methods)) {
      lines.push('      ' + JSON.stringify(name) + ': ' + m.js + ',');
    }
    lines.push('    },');
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('export const eventListeners = ' + JSON.stringify(listeners, null, 2).split('\n').join('\n') + ';');
  lines.push('');
  lines.push('export default classes;');
  lines.push('');
  return lines.join('\n');
}

export default { compileClasses };
