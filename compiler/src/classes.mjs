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
import { SERVICE_ADAPTERS, REFUSED_SERVICES } from '../../kernel/service-adapters.mjs';

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
  // The namespace of the file and its imports (`use`): a type written short
  // (`Mailer`) resolves through them (PHP's own resolution).
  let namespace = '';
  const imports = new Map();
  const collectUses = (children) => {
    for (const n of children || []) {
      if (n.kind === 'usegroup') {
        for (const item of n.items || []) {
          const full = nodeName(item.name);
          if (!full) continue;
          const alias = item.alias ? nodeName(item.alias) : full.split('\\').pop();
          imports.set(alias, full);
        }
      } else if (n.kind === 'use') {
        const full = nodeName(n.name);
        if (!full) continue;
        imports.set(full.split('\\').pop(), full);
      }
    }
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
      classes.push(node);
    }
    if (node.kind === 'namespace') {
      namespace = nodeName(node.name);
      collectUses(node.children);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      walk(node[key]);
    }
  };
  walk(ast);
  collectUses(ast.children);
  return { classes, namespace, imports };
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
  const deps = [];
  if (!ctor) return { js: '(args, deps) => ({})', deps };
  const params = ctor.arguments || [];
  // The edge instantiates a listener (and the services it needs) with no
  // arguments: a class-typed parameter is a dependency the build has to
  // resolve (an app service it compiles, a framework service it adapts) and a
  // builtin one needs a default. An EVENT class is different — the caller
  // builds it with its own arguments (the dispatch site), so its parameters
  // stay positional.
  //
  // It used to compile: the property stayed undefined and the request died at
  // runtime (a 500 the build said nothing about).
  const isEvent = opts.eventClasses.has(fqcn) || (opts.eventKinds && opts.eventKinds.has(fqcn));
  const depOf = new Map();
  if (!isEvent) {
    const ctorInfo = opts.ctorInfo instanceof Map ? opts.ctorInfo.get(fqcn) : null;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (!p || !p.name) continue;
      const name = nodeName(p.name);
      const dumped = (ctorInfo || []).find((d) => d && d.name === name) || null;
      const r = resolveCtorDep(fqcn, name, typeNameOf(p && p.type), dumped, opts);
      if (r.error) return { error: r.error };
      if (r.dep) {
        depOf.set(i, r.dep);
        deps.push(r.dep);
        continue;
      }
      // A plain value: the edge has none.
      if (!p.value) {
        const who = opts.listeners && opts.listeners.has(fqcn) ? 'a listener' : 'the class';
        return {
          error:
            'the constructor of ' + fqcn + ' needs $' + name + ' — the edge instantiates ' + who + ' without ' +
            'arguments (Laravel resolves it through the container)',
        };
      }
    }
  }
  const body = (ctor.body && ctor.body.children) || [];
  const hasBody = body.some((s) => s && s.kind !== 'comment' && s.kind !== 'nop');
  // The parameters the body sees: the injected services and the plain values.
  const bindings = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p || !p.name) continue;
    const name = typeof p.name === 'string' ? p.name : p.name.name;
    if (!name) continue;
    const dep = depOf.get(i);
    if (dep) {
      bindings.push('    let ' + vname(name) + ' = deps[' + JSON.stringify(name) + '];');
      continue;
    }
    let fallback = 'undefined';
    if (p.value !== undefined && p.value !== null) {
      const lit = literalOf(p.value);
      if (!lit) {
        return { error: 'the promoted property $' + name + ' of ' + fqcn + ' has a default the compiled rung cannot inline' };
      }
      fallback = lit.js;
    }
    bindings.push('    let ' + vname(name) + ' = args[' + i + '] === undefined ? ' + fallback + ' : args[' + i + '];');
  }
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p || !p.name) continue;
    const visibility = p.visibility || p.flags || null;
    if (!visibility) continue; // a plain parameter: not a property
    const name = typeof p.name === 'string' ? p.name : p.name.name;
    if (!name) continue;
    const dep = depOf.get(i);
    if (dep) {
      // The injected service: the edge hands it over.
      props.push('      ' + JSON.stringify(name) + ': deps[' + JSON.stringify(name) + ']');
      continue;
    }
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
  if (!hasBody) return { js: '(args, deps) => (' + promoted + ')', deps };

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
    return {
      error: 'the constructor of ' + fqcn + ' did not compile: ' + emitted.errors[0].message,
      code: emitted.errors[0].code,
    };
  }
  const bodyCode = String(emitted.code || '')
    .split('\n')
    .map((l) => (l ? '    ' + l : l))
    .join('\n');
  return {
    js:
      'function (args, deps) {\n' +
      '    const __self = ' + promoted + ';\n' +
      (bindings.length ? bindings.join('\n') + '\n' : '') +
      bodyCode + '\n' +
      '    return __self;\n' +
      '  }',
    deps,
  };
}

// The dependency of a constructor parameter: what the edge provides for it.
// A plain value (the caller), an app service (the edge builds it), a
// framework service (the edge adapter of it) — or a build error when the
// edge cannot provide it.
function resolveCtorDep(fqcn, name, type, dumped, opts) {
  // The type of the parameter (a leading backslash is PHP's own syntax:
  // `\Illuminate\Contracts\Mail\Mailer` is the same class).
  const depTypeRaw = dumped ? dumped.impl || dumped.type : type;
  let depType = depTypeRaw ? String(depTypeRaw).replace(/^\\/, '') : depTypeRaw;
  // A type written short (`Mailer`) resolves through the file's imports (the
  // `use` statement) and then through the namespace of the file (PHP's own
  // resolution).
  if (!dumped && depType && !depType.includes('\\')) {
    const imports = opts.imports instanceof Map ? opts.imports : new Map();
    const viaImport = imports.get(depType);
    if (viaImport) {
      depType = viaImport;
    } else if (opts.namespace) {
      const inNamespace = opts.namespace + '\\' + depType;
      const compiled = opts.classes instanceof Set ? opts.classes : new Set();
      if (compiled.has(inNamespace)) depType = inNamespace;
    }
  }
  const kind = dumped
    ? dumped.kind
    : depType
      ? BUILTIN_TYPES.has(depType.toLowerCase())
        ? 'builtin'
        : SERVICE_ADAPTERS[depType] || REFUSED_SERVICES[depType]
          ? 'external'
          : 'class'
      : 'untyped';
  if (kind === 'builtin') return { dep: null };
  if (kind === 'untyped') {
    return {
      error:
        'the constructor of ' + fqcn + ' has the untyped parameter $' + name + ' — Laravel resolves it by name ' +
        'through the container; the edge cannot',
    };
  }
  if (kind === 'abstract') {
    return {
      error:
        'the constructor of ' + fqcn + ' asks for ' + depType + ' — it is an interface without a concrete binding ' +
        'in the container; the edge cannot build it',
    };
  }
  if (kind === 'external') {
    const adapter = SERVICE_ADAPTERS[depType];
    if (!adapter) {
      const why = REFUSED_SERVICES[depType];
      if (why) {
        return { error: 'the constructor of ' + fqcn + ' asks for ' + depType + ' — ' + why };
      }
      return {
        error:
          'the constructor of ' + fqcn + ' asks for ' + depType + ' — the edge has no adapter for this framework ' +
          'service (only the mailer, the logger and the queue have one)',
      };
    }
    return { dep: { param: name, kind: 'adapter', type: depType, adapter } };
  }
  // A class of the app: the edge builds it (the build compiled it).
  const compiled = opts.classes instanceof Set ? opts.classes : new Set();
  const resolved = opts.classShortNames instanceof Map ? opts.classShortNames.get(depType) : undefined;
  let target = null;
  if (depType.includes('\\')) {
    // The full class name: the build must have compiled it.
    if (compiled.has(depType)) target = depType;
  } else if (resolved === null) {
    // Several compiled classes have that short name: the edge cannot tell
    // them apart.
    return {
      error:
        'the constructor of ' + fqcn + ' asks for ' + depType + ' — several compiled classes have that name; ' +
        'the edge cannot tell them apart (write the full class name)',
    };
  } else if (resolved) {
    target = resolved;
  }
  if (!target) {
    return {
      error:
        'the constructor of ' + fqcn + ' asks for ' + depType + ' — the build does not compile it (it is not a ' +
        'class of the app the dump reached)',
    };
  }
  return { dep: { param: name, kind: 'class', type: target } };
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
    // The type of the parameter (a leading backslash is PHP's own syntax:
    // `\App\Events\PostPublished` is the same class).
    const ptype = p.type ? String(p.type).replace(/^\\/, '') : null;
    const isEventType =
      ptype &&
      (opts.eventClasses.has(ptype) ||
        opts.eventShortNames.has(ptype) ||
        (opts.eventKinds && opts.eventKinds.has(ptype)));
    if (ptype && !isEventType) {
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
    // The injected services of the constructor (`$this->mailer`): their async
    // methods are awaited.
    injectedDeps: opts.injectedDeps instanceof Map ? opts.injectedDeps : new Map(),
  });
  if (emitted.errors.length) {
    return {
      error: 'the method ' + fqcn + '::' + name + '() did not compile: ' + emitted.errors[0].message,
      code: emitted.errors[0].code,
    };
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
    // The listeners (the classes the EDGE instantiates when it dispatches).
    listeners: new Set(Object.values(events).flatMap((info) => info.listeners || [])),
    // The constructor metadata of the dump (the container's own resolution):
    // it tells the build what each parameter of a constructor is.
    ctorInfo: opts.ctorInfo instanceof Map ? opts.ctorInfo : new Map(),
    // The classes the dump marks as events: the caller builds them (their
    // constructor's parameters are positional).
    eventKinds: opts.eventKinds instanceof Set ? opts.eventKinds : new Set(),
    // The namespace of the class file + its imports (`use`): a type written
    // short (`Mailer`) resolves through them (PHP's own resolution).
    namespace: opts.namespace || '',
    imports: opts.imports instanceof Map ? opts.imports : new Map(),
    // The short name of each compiled class (`Mailer` -> `App\Services\Mailer`):
    // a source that writes the short name resolves through it. An ambiguous
    // short name is null (the build stops instead of guessing).
    classShortNames: opts.classShortNames instanceof Map ? opts.classShortNames : new Map(),
  };

  // The constructor metadata of the dump, per class.
  const ctorInfo = new Map();
  for (const [fqcn, info] of Object.entries(classMap)) {
    if (Array.isArray(info.ctor)) ctorInfo.set(fqcn, info.ctor);
  }
  options.ctorInfo = ctorInfo;
  // The short names of the compiled classes (the source writes `Mailer`).
  const classShortNames = new Map();
  for (const fqcn of options.classes) {
    const alias = shortName(fqcn);
    if (classShortNames.has(alias)) classShortNames.set(alias, null);
    else classShortNames.set(alias, fqcn);
  }
  options.classShortNames = classShortNames;
  // The event classes (the dump knows their kind: the caller builds them).
  const eventKinds = new Set();
  for (const [fqcn, info] of Object.entries(classMap)) {
    if (info && info.kind === 'event') eventKinds.add(fqcn);
  }
  options.eventKinds = eventKinds;

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
    // The namespace + the imports of the file (a type written short resolves
    // through them).
    options.namespace = parsed.namespace || '';
    options.imports = parsed.imports instanceof Map ? parsed.imports : new Map();
    const ctor = compileConstructor(fqcn, classNode, options);
    if (ctor.error) {
      errors.push({ class: fqcn, message: ctor.error, code: ctor.code });
      continue;
    }
    // The injected services (the framework ones and the app ones): their
    // methods are async in the compiled world, so the calls must be awaited
    // in the compiled body (a promise must never leak into the response).
    const injectedDeps = new Map();
    for (const d of ctor.deps || []) {
      if (d && (d.kind === 'adapter' || d.kind === 'class')) injectedDeps.set(d.param, d);
    }
    options.injectedDeps = injectedDeps;
    const methods = {};
    let failed = null;
    let failedCode = null;
    for (const m of classMembers(classNode)) {
      if (!m || m.kind !== 'method') continue;
      if (m.visibility && m.visibility !== 'public') continue;
      const methodName = nodeName(m.name);
      if (methodName === '__construct') continue;
      const r = compileMethod(fqcn, m, options);
      if (r.error) {
        failed = r.error;
        failedCode = r.code;
        break;
      }
      methods[methodName] = { js: r.js, params: r.params };
    }
    if (failed) {
      errors.push({ class: fqcn, message: failed, code: failedCode });
      continue;
    }
    meta[fqcn] = { file: info.file, methods: Object.keys(methods) };
    entries.push({ fqcn, ctor: ctor.js, methods, deps: ctor.deps || [] });
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
    // The dependencies of the constructor: the edge hands them over (an app
    // service it builds, a framework service it adapts).
    lines.push('    deps: ' + JSON.stringify(e.deps || []) + ',');
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
