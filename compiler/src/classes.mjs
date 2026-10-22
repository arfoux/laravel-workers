// compiler/src/classes.mjs — the class compiler (build time).
//
// An event listener (and the event class it receives) is a PHP class: at the
// edge there is no listener runtime, so a dispatch that answers nothing would
// be a *silent* no-op. The compiled rung compiles the classes instead: the
// constructor (the promoted properties), the methods (their bodies through the
// ordinary transpiler - every method of the class, the protected and the
// private ones too) and the event -> listener map.
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
import { transpileControllerMethod, VALIDATOR_TYPES, RESOURCE_REQUEST_TYPES } from './transpiler.mjs';
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
    case 'nullkeyword':
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
  const params = ctor ? ctor.arguments || [] : [];
  // The declared properties (`public int $sent = 0;`): the instance carries
  // them, like PHP does. A property without a default stays undefined (PHP
  // leaves it uninitialized - reading it is an error there too).
  // The injected services of this constructor (param -> dep): their async
  // methods are awaited in the compiled body (a floating promise means the
  // effect never happens - the mail is never sent).
  const ctorDeps = new Map();
  const declared = [];
  for (const member of classMembers(classNode)) {
    if (!member) continue;
    // A property statement (`public int $sent = 0;`) holds the properties.
    const list = member.kind === 'propertystatement' ? member.properties || [] : [member];
    for (const prop of list) {
      if (!prop || prop.kind !== 'property') continue;
      const pname = nodeName(prop.name);
      if (!pname) continue;
      if (prop.value === undefined || prop.value === null) {
        declared.push({ name: pname, js: 'undefined' });
        continue;
      }
      const lit = literalOf(prop.value);
      if (!lit) {
        return {
          error: 'the property $' + pname + ' of ' + fqcn + ' has a default the compiled rung cannot inline',
          code: 'LW002',
        };
      }
      declared.push({ name: pname, js: lit.js });
    }
  }
  const declaredJs = declared.length
    ? 'Object.assign(__self, { ' + declared.map((d) => JSON.stringify(d.name) + ': ' + d.js).join(', ') + ' });\n'
    : '';
  if (!ctor) {
    return {
      js: '(args, deps) => {\n    const __self = {};\n    ' + declaredJs + '    return __self;\n  }',
      deps,
    };
  }
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
  // The parameter indexes the container answers with the DEFAULT VALUE.
  const fallbackOf = new Map();
  if (!isEvent) {
    const ctorInfo = opts.ctorInfo instanceof Map ? opts.ctorInfo.get(fqcn) : null;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (!p || !p.name) continue;
      const name = nodeName(p.name);
      const dumped = (ctorInfo || []).find((d) => d && d.name === name) || null;
      const r = resolveCtorDep(fqcn, name, typeNameOf(p && p.type), dumped, opts);
      if (r.error) return { error: r.error, code: r.code };
      if (r.dep) {
        depOf.set(i, r.dep);
        deps.push(r.dep);
        ctorDeps.set(r.dep.param, r.dep);
        continue;
      }
      // The container's fallback: a class-typed parameter with a default that
      // the container cannot resolve answers the DEFAULT (Container::
      // resolveClass()). The value is a PHP literal, so the parameter binds
      // like any other literal default.
      if (r.fallback) {
        fallbackOf.set(i, r.fallback.value);
        continue;
      }
      // A plain value: the edge has none.
      if (!p.value) {
        const who = opts.listeners && opts.listeners.has(fqcn) ? 'a listener' : 'the class';
        // Laravel's container cannot resolve a scalar without a default
        // either: it throws a BindingResolutionException ("Unresolvable
        // dependency resolving [$x] in class ..."), so the reason must not
        // claim that Laravel resolves it.
        const builtin = p.type && BUILTIN_TYPES.has(String(typeNameOf(p.type)).toLowerCase());
        return {
          error: builtin
            ? 'the constructor of ' + fqcn + ' needs $' + name + ' and it has no default — Laravel cannot build it either ' +
              '(the container throws a BindingResolutionException: "Unresolvable dependency resolving [$' + name + '] in class ...")'
            : 'the constructor of ' + fqcn + ' needs $' + name + ' — the edge instantiates ' + who + ' without ' +
              'arguments (Laravel resolves it through the container)',
          code: 'LW002',
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
    if (fallbackOf.has(i)) {
      fallback = phpLiteralJs(fallbackOf.get(i));
    } else if (p.value !== undefined && p.value !== null) {
      const lit = literalOf(p.value);
      if (!lit) {
        return { error: 'the promoted property $' + name + ' of ' + fqcn + ' has a default the compiled rung cannot inline', code: 'LW002' };
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
    if (fallbackOf.has(i)) {
      fallback = phpLiteralJs(fallbackOf.get(i));
    } else if (p.value !== undefined && p.value !== null) {
      const lit = literalOf(p.value);
      if (!lit) {
        return { error: 'the promoted property $' + name + ' of ' + fqcn + ' has a default the compiled rung cannot inline', code: 'LW002' };
      }
      fallback = lit.js;
    }
    props.push('      ' + JSON.stringify(name) + ': (args[' + i + '] === undefined ? ' + fallback + ' : args[' + i + '])');
  }
  const promoted = props.length ? '{\n' + props.join(',\n') + ',\n    }' : '{}';
  // A constructor with an EMPTY body (`public function __construct() {}` - what
  // `php artisan make:mail` scaffolds) still carries the class's declared
  // properties: PHP assigns them before the body runs, so `public $view =
  // 'mail.order';` is there whether the body is empty or not. The arrow form
  // only holds the PROMOTED properties, so it dropped the declared ones and the
  // mailable sent a null view at request time.
  if (!hasBody) {
    if (!declared.length) return { js: '(args, deps) => (' + promoted + ')', deps };
    return {
      js:
        '(args, deps) => {\n    const __self = ' +
        promoted +
        ';\n    ' +
        declaredJs +
        '    return __self;\n  }',
      deps,
    };
  }

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
    // The alias of each compiled class (`OrderMail` -> `App\Mail\OrderMail`):
    // `new OrderMail()` resolves through it, the way PHP resolves a name
    // through the file's own `use` statements.
    classFqcns: opts.classFqcns instanceof Map ? opts.classFqcns : new Map(),
    classMethod: true,
    // The class's own methods: a method call on $this (or on a variable that
    // holds the instance) is one of them.
    classMethods: opts.classMethods instanceof Set ? opts.classMethods : new Set(),
    // A mailable: the fluent surface of Laravel's Mailable.
    mailable: !!opts.mailable,
    // The constructor builds its own object.
    thisVar: '__self',
    // The services the constructor injected (`$this->mailer`): their async
    // methods are awaited in the compiled body (a floating promise means the
    // effect never happens).
    injectedDeps: ctorDeps,
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
  // The constructor is SYNCHRONOUS at the edge (the runtime calls
  // `entry.ctor(args, deps)` without awaiting it), so a body that needs an
  // await would emit `await` inside a non-async function - a SyntaxError that
  // breaks the whole worker at import time. The build refuses it instead.
  if (/\bawait\b/.test(bodyCode)) {
    return {
      error:
        'the constructor of ' + fqcn + ' needs an await — the constructor is synchronous at the edge, so an awaited ' +
        'call in it would break the worker (move the query or the call into the method)',
      code: 'LW002',
    };
  }
  return {
    js:
      'function (args, deps) {\n' +
      '    const __self = ' + promoted + ';\n' +
      (declaredJs ? '    ' + declaredJs : '') +
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
// A scalar PHP value from the dump as a JS literal.
function phpLiteralJs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

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
  // Container::resolveClass() catches the BindingResolutionException and falls
  // back to the parameter's DEFAULT VALUE (Illuminate\Container\Container
  // :1150-1170), so a class-typed parameter that carries a default never
  // reaches the edge as an error - Laravel uses the default.
  const hasDefault = dumped && Object.prototype.hasOwnProperty.call(dumped, 'default');
  const defaultValue = hasDefault ? dumped.default : undefined;
  if (kind === 'abstract') {
    if (hasDefault) return { dep: null, fallback: { param: name, value: defaultValue } };
    return {
      error:
        'the constructor of ' + fqcn + ' asks for ' + depType + ' — it is an interface without a concrete binding ' +
        'in the container; the edge cannot build it',
    };
  }
  if (kind === 'external') {
    const adapter = SERVICE_ADAPTERS[depType];
    if (!adapter && hasDefault) {
      // An unbound framework service with a default: Laravel's container falls
      // back to the default too.
      return { dep: null, fallback: { param: name, value: defaultValue } };
    }
    if (!adapter) {
      const why = REFUSED_SERVICES[depType];
      if (why) {
        return { error: 'the constructor of ' + fqcn + ' asks for ' + depType + ' — ' + why, code: 'LW002' };
      }
      return {
        error:
          'the constructor of ' + fqcn + ' asks for ' + depType + ' — the edge has no adapter for this framework ' +
          'service (only the mailer, the logger and the queue have one)',
        code: 'LW002',
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
    // A model-typed parameter: the model IS compiled, but the edge cannot
    // provide it - the class is instantiated with no arguments (the caller
    // builds the event, not the service).
    const isModel = Boolean(
      opts.modelClassFqcns &&
      Object.values(opts.modelClassFqcns).some((f) => f === depType)
    );
    return {
      error: isModel
        ? 'the constructor of ' + fqcn + ' asks for the model ' + depType + ' — a model cannot be provided at the ' +
          'edge (the class is instantiated with no arguments)'
        : 'the constructor of ' + fqcn + ' asks for ' + depType + ' — the build does not compile it (it is not a ' +
          'class of the app the dump reached)',
      code: 'LW002',
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
    return { error: 'the method ' + fqcn + '::' + name + '() is static — the compiled classes are instances', code: 'LW002' };
  }
  if (methodNode.abstract) {
    return { error: 'the method ' + fqcn + '::' + name + '() is abstract', code: 'LW002' };
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
    if (p.variadic) return { error: 'the method ' + fqcn + '::' + name + '() has a variadic parameter', code: 'LW002' };
    if (p.byRef) return { error: 'the method ' + fqcn + '::' + name + '() has a by-reference parameter', code: 'LW002' };
    // The type of the parameter (a leading backslash is PHP's own syntax:
    // `\App\Events\PostPublished` is the same class).
    const ptype = p.type ? String(p.type).replace(/^\\/, '') : null;
    const isEventType =
      ptype &&
      (opts.eventClasses.has(ptype) ||
        opts.eventShortNames.has(ptype) ||
        (opts.eventKinds && opts.eventKinds.has(ptype)));
    // The VALIDATOR a FormRequest hook takes (`withValidator(Validator
    // $validator)` - Illuminate/Foundation/Http/FormRequest.php:110). The edge
    // has no container to inject it (Laravel calls the hook with the
    // validator IT built), but the compiled lifecycle hands the kernel's
    // validator to the hook - so the type is allowed and the compiled body
    // may call the validator's surface.
    const resolvedType = ptype
      ? (opts.imports instanceof Map && opts.imports.get(ptype)) || ptype
      : null;
    const isValidatorType = resolvedType && VALIDATOR_TYPES.has(resolvedType);
    // A RESOURCE's toArray()/with() take the Request - Laravel's own signature
    // (JsonResource::toArray($request)). The runtime hands the request in, so
    // the compiled class may take it too (only there: any other class would be
    // asking for a service the edge cannot inject).
    const isResourceRequest =
      !!opts.resource && resolvedType && RESOURCE_REQUEST_TYPES.has(resolvedType);
    if (ptype && !isEventType && !isValidatorType && !isResourceRequest) {
      return {
        error:
          'the method ' + fqcn + '::' + name + '() takes a ' + p.type + ' — the edge cannot inject a service ' +
          '(the compiled classes take the event and the plain values only)',
      };
    }
  }
  const paramVars = new Set(params.map((p) => vname(p.name)));
  // The type of each parameter (the variable -> the FQCN of the type). The
  // FormRequest hooks take the validator (`withValidator(Validator
  // $validator)` - Illuminate/Foundation/Http/FormRequest.php:110), so the
  // compiled body must know the variable holds the kernel's validator.
  const paramTypes = new Map();
  for (const p of params) {
    // The type as the file writes it: the file's own `use` statements resolve
    // it (the class compiler's options carry them).
    const written = p.type ? String(p.type).replace(/^\\/, '') : null;
    if (!written) continue;
    const resolved =
      (opts.imports instanceof Map && opts.imports.get(written)) || written;
    paramTypes.set(vname(p.name), resolved);
  }
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
    // The alias of each compiled class (`OrderMail` -> `App\Mail\OrderMail`):
    // `new OrderMail()` resolves through it, the way PHP resolves a name
    // through the file's own `use` statements (the file's imports are the
    // authority here - see the alias map below).
    classFqcns: opts.classFqcns instanceof Map ? opts.classFqcns : new Map(),
    classMethod: true,
    // The class's own methods (a method call on $this).
    classMethods: opts.classMethods instanceof Set ? opts.classMethods : new Set(),
    // A mailable: the fluent surface of Laravel's Mailable.
    mailable: !!opts.mailable,
    // A FormRequest: the request surface of the kernel's base.
    formRequest: !!opts.formRequest,
    // A resource: its toArray()/with() take the request.
    resource: !!opts.resource,
    // The type of each parameter (the variable -> the FQCN of the type): the
    // FormRequest hooks take the validator, so the compiled body must know it.
    paramTypes,
    // The file's own `use` statements (the alias -> the FQCN): a type written
    // short (`Validator`) resolves through them.
    imports: opts.imports instanceof Map ? opts.imports : new Map(),
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
  // A RESOURCE's toArray()/with() are called by the kernel's base
  // (JsonResource::resolve -> toArray($request)) on the SYNCHRONOUS response
  // path, so an `async` body would hand a Promise to the payload. A resource
  // body that needs an await is refused instead of leaking one.
  const syncMethod = !!opts.resource;
  if (syncMethod && /\bawait\b/.test(String(emitted.code || ''))) {
    return {
      error:
        'the method ' + fqcn + '::' + name + '() needs an await — a resource shapes the response ' +
        'synchronously, so the compiled body cannot wait for a promise (move the call out of the resource)',
      code: 'LW002',
    };
  }
  return {
    js:
      (syncMethod ? 'function (' : 'async function (') + args.join(', ') + ') {\n' +
      String(emitted.code || '')
        .split('\n')
        .map((l) => (l ? '      ' + l : l))
        .join('\n') +
      '\n    }',
    params: params.map((p) => vname(p.name)),
    // The app classes this method instantiates (`new X()`), resolved to their
    // FQCN (the same name the compiled body instantiates).
    instantiated: emitted.instantiated || [],
  };
}

// ---------------------------------------------------------------------------
// the whole registry
// ---------------------------------------------------------------------------

// The alias of each class a file can instantiate (`new OrderMail()`), resolved
// the way PHP resolves a name in that file:
//   1. the file's own `use` statements (`use App\Mail\OrderMail;`),
//   2. the file's own namespace (`App\Mail\OrderMail` in App\Mail),
//   3. the global namespace (`OrderMail`).
// Only a class the build COMPILED resolves: the edge builds the compiled
// classes, so a name that is not among them cannot be instantiated. An
// ambiguous short name (two compiled classes share it) does NOT resolve - the
// edge cannot tell them apart, so the transpiler refuses it.
//
// The FQCN-written form (`new \App\Mail\OrderMail()`) resolves through the
// transpiler itself (it matches the compiled FQCN set), so it needs no entry
// here.
function aliasMapFor(options) {
  const map = new Map();
  const compiled = options.classes instanceof Set ? options.classes : new Set();
  const namespace = options.namespace || '';
  // The file's own `use` statements: the authority for a short name.
  for (const [alias, fqcn] of options.imports || []) {
    if (!alias || !fqcn) continue;
    // Only a compiled class: an import of a class the build did not compile
    // (a model, a framework class) must NOT resolve - the edge cannot build
    // it.
    if (!compiled.has(fqcn)) continue;
    map.set(alias, fqcn);
  }
  // The file's own namespace: a class of the same namespace, written short.
  if (namespace) {
    for (const fqcn of compiled) {
      if (!fqcn.startsWith(namespace + '\\')) continue;
      const alias = shortName(fqcn);
      // An explicit `use` wins over the namespace (PHP's own rule).
      if (map.has(alias)) continue;
      map.set(alias, fqcn);
    }
  }
  // The global namespace: a compiled class outside every namespace, written
  // short. An ambiguous short name does not resolve.
  const global = new Map();
  for (const fqcn of compiled) {
    if (fqcn.includes('\\')) continue;
    if (global.has(fqcn)) global.set(fqcn, null);
    else global.set(fqcn, fqcn);
  }
  for (const [alias, fqcn] of global) {
    if (!fqcn || map.has(alias)) continue;
    map.set(alias, fqcn);
  }
  return map;
}

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

  // The registry of the classes (FQCN -> { methods, base }): a call on an
  // INLINE instance (`(new OrderService())->doIt($o)`) must know the
  // receiver's own methods - they take the runtime as their first argument -
  // and the receiver's base (a mailable's fluent surface takes only its own
  // arguments). The pre-pass parses every class file ONCE (the parse is
  // cached) so the registry is complete before any class is compiled.
  const parseCache = new Map();
  const parseCached = (file) => {
    if (!parseCache.has(file)) parseCache.set(file, parseClassFile(file));
    return parseCache.get(file);
  };
  const registry = new Map();
  for (const [fqcn, info] of Object.entries(classMap)) {
    const parsed = parseCached(info.file);
    if (parsed.error) continue;
    const classNode = parsed.classes.find((c) => nodeName(c.name) === shortName(fqcn));
    if (!classNode) continue;
    registry.set(fqcn, {
      methods: classMembers(classNode)
        .filter((m) => m && m.kind === 'method' && !m.isStatic)
        .map((m) => nodeName(m.name))
        .filter(Boolean),
      base:
        info.kind === 'mailable'
          ? 'mailable'
          : info.kind === 'formRequest'
            ? 'formRequest'
            : info.kind === 'resource'
              ? 'resource'
              : null,
    });
  }
  options.classRegistry = registry;

  // The queued listeners (ShouldQueue): Laravel pushes them to the queue (they
  // run later, in a worker); the edge has no consumer, so running them inline
  // would be a different behaviour — they are not compiled.
  const queued = new Set();
  const broadcast = new Set();
  const afterCommit = new Set();
  for (const info of Object.values(events)) {
    for (const q of info.queued || []) queued.add(q);
    for (const b of info.broadcast || []) broadcast.add(b);
    for (const a of info.afterCommit || []) afterCommit.add(a);
  }

  for (const [fqcn, info] of Object.entries(classMap)) {
    if (queued.has(fqcn)) {
      errors.push({
        class: fqcn,
        message:
          'the listener ' + fqcn + ' is queued (ShouldQueue) — Laravel pushes it to the queue and it runs later; ' +
          'the edge has no queue consumer, so the compiled rung does not run it inline',
        code: 'LW002',
      });
      continue;
    }
    // The broadcast listeners (ShouldBroadcast / ShouldBroadcastNow): Laravel
    // broadcasts the event to the channels after the response (the broadcast
    // itself is queued); the edge has no broadcast driver, so the
    // notification would never be sent - that is a silent no-op, so the
    // compiled rung refuses it.
    if (broadcast.has(fqcn)) {
      errors.push({
        class: fqcn,
        message:
          'the listener ' + fqcn + ' is a broadcast listener (ShouldBroadcast) — Laravel broadcasts the event ' +
          'after the response; the edge has no broadcast driver, so the notification would never be sent',
        code: 'LW002',
      });
      continue;
    }
    // The after-commit listeners (ShouldDispatchAfterCommit): Laravel defers
    // them until the transaction is committed; the edge has no transaction,
    // so the timing would differ - the compiled rung refuses it.
    if (afterCommit.has(fqcn)) {
      errors.push({
        class: fqcn,
        message:
          'the listener ' + fqcn + ' is dispatched after the commit (ShouldDispatchAfterCommit) — Laravel defers it ' +
          'until the transaction is committed; the edge has no transaction, so the timing would differ',
        code: 'LW002',
      });
      continue;
    }
    const parsed = parseCached(info.file);
    if (parsed.error) {
      errors.push({ class: fqcn, message: parsed.error, code: 'LW004' });
      continue;
    }
    const short = shortName(fqcn);
    const classNode = parsed.classes.find((c) => nodeName(c.name) === short);
    if (!classNode) {
      errors.push({ class: fqcn, message: 'the class ' + fqcn + ' is not in ' + info.file, code: 'LW002' });
      continue;
    }
    // The traits and the parent class: their members are not compiled, so a
    // listener that uses a trait would compile "OK" and have no handle() at
    // request time (a 500 where Laravel answers 200).
    // A trait use is a statement in the class body (`use Notifies;`).
    const traitUses = classMembers(classNode).filter((m) => m && m.kind === 'traituse');
    if (traitUses.length) {
      const names = traitUses
        .map((m) => (m.uses || []).map((u) => nodeName(u.trait) || (u.trait && u.trait.name) || '?').join(', '))
        .join(', ');
      errors.push({
        class: fqcn,
        message:
          'the class ' + fqcn + ' uses a trait (' + names +
          ') — the trait members are not compiled, so the class would miss its methods at the edge',
        code: 'LW002',
      });
      continue;
    }
    // A mailable extends Laravel's Mailable: the compiled class extends the
    // kernel's base (the fluent surface + the payload).
    const isMailable = info.kind === 'mailable';
    // A FormRequest extends LARAVEL's FormRequest: the compiled class extends
    // the kernel's base (the request surface the hooks use). A FormRequest that
    // extends its OWN base class is still refused - the inherited methods are
    // not compiled, so the class would miss them at the edge.
    const parentName = classNode.extends
      ? String(nodeName(classNode.extends) || '').replace(/^\\/, '')
      : '';
    const parentFqcn =
      (parsed.imports instanceof Map && parsed.imports.get(parentName)) || parentName;
    const isFormRequest =
      info.kind === 'formRequest' && parentFqcn === 'Illuminate\\Foundation\\Http\\FormRequest';
    // A resource extends Laravel's JsonResource (the kernel's base carries
    // `toArray()`, the wrapping, the `with`/`additional`): the app declares only
    // `toArray()`, so the inherited surface must come from the base.
    const isResource =
      info.kind === 'resource' &&
      (parentFqcn === 'Illuminate\\Http\\Resources\\Json\\JsonResource' ||
        parentFqcn === 'Illuminate\\Http\\Resources\\Json\\ResourceCollection');
    if (classNode.extends && !isMailable && !isFormRequest && !isResource) {
      errors.push({
        class: fqcn,
        message:
          'the class ' + fqcn + ' extends ' + (nodeName(classNode.extends) || 'another class') +
          ' — the inherited methods are not compiled, so the class would miss them at the edge',
        code: 'LW002',
      });
      continue;
    }
    // The magic accessors (`__get`, `__set`, `__call`, `__toString`): PHP
    // calls them, so a property read would answer null where Laravel answers
    // the computed value.
    const magic = classMembers(classNode).find(
      (m) => m && m.kind === 'method' && ['__get', '__set', '__call', '__callStatic', '__toString', '__isset'].includes(nodeName(m.name))
    );
    if (magic) {
      errors.push({
        class: fqcn,
        message:
          'the class ' + fqcn + ' defines the magic method ' + nodeName(magic.name) +
          '() — the magic accessors are not compiled, so a property read would answer null where Laravel answers the computed value',
        code: 'LW002',
      });
      continue;
    }
    // The namespace + the imports of the file (a type written short resolves
    // through them).
    options.namespace = parsed.namespace || '';
    options.imports = parsed.imports instanceof Map ? parsed.imports : new Map();
    // The alias of each class this file can instantiate (`new OrderMail()`),
    // resolved the way PHP resolves a name in this file: the file's own `use`
    // statements first, then the file's own namespace, then the global
    // namespace. Only a class the build COMPILED resolves - anything else
    // stays unresolved, and the transpiler refuses it (the class is not
    // compiled, so the edge cannot build it).
    options.classFqcns = aliasMapFor(options);
    // The class's own methods (a method call on $this is one of them) and the
    // mailable flag (the fluent surface of Laravel's Mailable).
    options.classMethods = new Set(
      classMembers(classNode)
        .filter((m) => m && m.kind === 'method' && !m.isStatic)
        .map((m) => nodeName(m.name))
        .filter(Boolean)
    );
    options.mailable = info.kind === 'mailable';
    // A FormRequest: the request surface of the kernel's base (the hooks).
    options.formRequest = info.kind === 'formRequest';
    options.resource = info.kind === 'resource';
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
    // The app classes this class instantiates (`new X()`), resolved to their
    // FQCN: the build needs the class graph (a route that reaches a class that
    // sends a mailable needs that mailable's view; a class that instantiates a
    // class that did NOT compile must fail too).
    const instantiated = new Set();
    let failed = null;
    let failedCode = null;
    for (const m of classMembers(classNode)) {
      if (!m || m.kind !== 'method') continue;
      // EVERY method of the class is compiled - the protected and the private
      // ones too. A helper the class calls on itself ($this->helper()) is the
      // CLASS's own method: Laravel calls it from inside the class, and the
      // edge provides only Laravel's surface (the kernel's Mailable base -
      // Illuminate\Mail\Mailable: `subject()`, `view()`, `with()`), never the
      // class's own methods. So a helper that is dropped is a helper that does
      // not exist at the edge: the compiled body would call it and die with a
      // TypeError at request time, while the build is green.
      const methodName = nodeName(m.name);
      if (methodName === '__construct') continue;
      const r = compileMethod(fqcn, m, options);
      if (r.error) {
        failed = r.error;
        failedCode = r.code;
        break;
      }
      methods[methodName] = { js: r.js, params: r.params };
      for (const inst of r.instantiated || []) instantiated.add(inst);
    }
    if (failed) {
      errors.push({ class: fqcn, message: failed, code: failedCode });
      continue;
    }
    meta[fqcn] = {
      file: info.file,
      methods: Object.keys(methods),
      instantiated: [...instantiated],
      // The kernel's base the class extends (a mailable's fluent surface, a
      // FormRequest's request surface) - a call on an inline instance needs
      // to know it (the base's methods take only their own arguments).
      base: isMailable ? 'mailable' : isFormRequest ? 'formRequest' : isResource ? 'resource' : null,
    };
    entries.push({
      fqcn,
      ctor: ctor.js,
      methods,
      deps: ctor.deps || [],
      // The kernel base the compiled class extends: a mailable's fluent
      // surface, a FormRequest's request surface, a JsonResource's wrapping.
      base: isMailable ? 'mailable' : isFormRequest ? 'formRequest' : isResource ? 'resource' : null,
    });
  }

  // A class that instantiates a class that did NOT compile fails too: the
  // edge builds the instance at request time and the class is not in the
  // registry ("the class X is not compiled"), so the request would die with a
  // 500 where Laravel answers 200. The class is refused HERE, with the
  // reason of the class it needs, so the routes that reach it are stopped
  // (the build's blocking machinery) instead of failing at request time.
  {
    const failedBy = new Map(errors.map((e) => [e.class, e.message]));
    // The classes that instantiate a failed class fail as well - and so on
    // (a class that needs a class that needs a failed class). The loop
    // repeats until nothing changes.
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of entries.slice()) {
        if (failedBy.has(e.fqcn)) continue;
        const clsMeta = meta[e.fqcn] || {};
        for (const inst of clsMeta.instantiated || []) {
          if (!failedBy.has(inst)) continue;
          const why = failedBy.get(inst);
          failedBy.set(
            e.fqcn,
            'the class ' + e.fqcn + ' instantiates ' + inst + ', which did not compile: ' + why
          );
          errors.push({
            class: e.fqcn,
            message: failedBy.get(e.fqcn),
            code: 'LW002',
          });
          changed = true;
          break;
        }
      }
    }
    if (failedBy.size) {
      // The classes that failed are not in the registry: the runtime cannot
      // build them, so the routes that reach them are stopped.
      for (let i = entries.length - 1; i >= 0; i--) {
        if (failedBy.has(entries[i].fqcn)) entries.splice(i, 1);
      }
      for (const fqcn of Object.keys(meta)) {
        if (failedBy.has(fqcn)) delete meta[fqcn];
      }
    }
  }

  // The circular service dependencies (A needs B that needs A): the edge
  // would build them forever (a stack overflow with no cause), and Laravel
  // names the cycle at build time - so the build does too.
  {
    const depsOf = new Map(entries.map((e) => [e.fqcn, (e.deps || []).filter((d) => d && d.kind === 'class').map((d) => d.type)]));
    const stack = [];
    const done = new Set();
    const visit = (fqcn) => {
      if (done.has(fqcn)) return null;
      const at = stack.indexOf(fqcn);
      if (at >= 0) return stack.slice(at).concat(fqcn);
      stack.push(fqcn);
      for (const dep of depsOf.get(fqcn) || []) {
        if (!depsOf.has(dep)) continue;
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
      stack.pop();
      done.add(fqcn);
      return null;
    };
    for (const e of entries) {
      const cycle = visit(e.fqcn);
      if (cycle) {
        errors.push({
          class: cycle[0],
          message: 'Circular dependency detected [' + cycle.join(', ') + '] — the edge would build the services forever',
          code: 'LW002',
        });
        break;
      }
    }
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
    if (e.base) lines.push('    base: ' + JSON.stringify(e.base) + ',');
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
