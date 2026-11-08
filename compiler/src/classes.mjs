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
import { transpileControllerMethod, VALIDATOR_TYPES, RESOURCE_REQUEST_TYPES, JSON_RESPONSE_TYPES } from './transpiler.mjs';
import { SERVICE_ADAPTERS, REFUSED_SERVICES } from '../../kernel/service-adapters.mjs';
// The number-literal canon (`017` is OCTAL, `1_000` ignores the underscore).
import { phpNumberLiteral } from '../../tools/php-funcs.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

// The Laravel BUS traits a job (and a queued listener) uses:
// `use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;`.
// Their members are NOT compiled, and the emitted code never needs them:
//   * `Dispatchable::dispatch*()` is answered at the CALL SITE - the transpiler
//     turns `Job::dispatch($x)` into `rt.queuePush(fqcn, [args])`, so the class
//     itself never carries the static method (`queue-demo.mjs`);
//   * `SerializesModels`' two hooks (`__serialize`/`__unserialize`) exist to
//     carry the payload through PHP's own serializer - the edge's payload is
//     JSON (the row's `payload` column);
//   * `Queueable`/`InteractsWithQueue` add instance members the app may call
//     INSIDE its own bodies (`release()`, `delete()`, `attempts()`, `onQueue()`,
//     ...). Those ARE meaningful, so a class whose own body calls one is
//     refused below: the compiled rung has no such method, and Laravel's
//     re-queue/delete/attempts semantics would not happen.
const BUS_TRAITS = new Map([
  ['Illuminate\\Foundation\\Bus\\Dispatchable', 'Dispatchable'],
  ['Illuminate\\Bus\\Queueable', 'Queueable'],
  ['Illuminate\\Queue\\InteractsWithQueue', 'InteractsWithQueue'],
  ['Illuminate\\Queue\\SerializesModels', 'SerializesModels'],
]);
// The member names the four traits add (vendor 13.37). The static ones of
// Dispatchable are listed too: the compiled rung has no such method, so a call
// from the class's own body (`self::dispatchSync()`) would throw at the edge.
const BUS_TRAIT_MEMBERS = new Set([
  // Foundation\Bus\Dispatchable
  'dispatch',
  'dispatchIf',
  'dispatchUnless',
  'dispatchSync',
  'dispatchAfterResponse',
  'withChain',
  'newPendingDispatch',
  // Bus\Queueable
  'onConnection',
  'onQueue',
  'onGroup',
  'withDeduplicator',
  'allOnConnection',
  'allOnQueue',
  'delay',
  'withoutDelay',
  'afterCommit',
  'beforeCommit',
  'through',
  'chain',
  'prependToChain',
  'appendToChain',
  'serializeJob',
  'dispatchNextJobInChain',
  'invokeChainCatchCallbacks',
  // Queue\InteractsWithQueue
  'attempts',
  'delete',
  'fail',
  'release',
  'setJob',
  // Queue\SerializesModels
  '__serialize',
  '__unserialize',
  'getPropertyValue',
]);

/**
 * The member names a class's OWN method bodies call on `$this` / `self` /
 * `static` (`$this->release(3)`, `self::dispatchSync('x')`). The AST is walked
 * (not a text scan), so a comment or a string that merely mentions the name
 * does not count, and a property of the same name (`$this->delay = 3`) is not
 * a call. A dynamic access (`$this->$name`) is not collected either - it is not
 * the trait's member.
 */
function memberCallsOnSelf(classNode) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    // A member CALL only: `$this->release(3)` is a call whose `what` is a
    // propertylookup on `$this`; `self::dispatchSync('x')` is a call whose
    // `what` is a staticlookup on self/static. A property READ/WRITE
    // (`$this->delay = 3`) is NOT a member call and is not collected - the
    // trait's member is the method, and a class may well have a property of
    // the same name.
    const what = (n.kind === 'call' || n.kind === 'staticcall') && n.what ? n.what : null;
    if (what) {
      const offset = what.offset || {};
      const receiver = what.what || {};
      const isMemberCall =
        (what.kind === 'propertylookup' && receiver.kind === 'variable' && receiver.name === 'this') ||
        (what.kind === 'staticlookup' &&
          (receiver.kind === 'selfreference' || receiver.kind === 'staticreference'));
      if (isMemberCall && offset.kind === 'identifier' && offset.name) out.add(offset.name);
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      visit(n[key]);
    }
  };
  for (const m of classMembers(classNode)) {
    if (m && m.kind === 'method' && m.body) visit(m.body);
  }
  return out;
}

/**
 * The compiled code with its STRING literals and comments blanked out, so a
 * scan for a KEYWORD (`await`) cannot be answered by a message or a comment
 * that merely mentions the word: `const msg = 'await';` in a constructor body
 * used to refuse the whole class with LW002, and a `// await the mailer`
 * comment in a resource did too. A single left-to-right pass: `'`, `"` and the
 * backtick open a literal (a backslash escapes the next character), `//` opens
 * a line comment and `/*` a block one; everything else is code. It only
 * NARROWS what a scan sees, and the emitted code is the transpiler's own
 * machine-shaped output (no `${...}`-nested literals).
 */
function codeWithoutNoise(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Does this compiled body NEED an await (an `await` that is CODE, not text)? */
function needsAwait(code) {
  return /\bawait\b/.test(codeWithoutNoise(String(code || '')));
}

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
    case 'number': {
      // php-parser keeps the RAW text. `0777` is 511 in PHP, but emitted
      // verbatim it is a LEGACY OCTAL literal - a SyntaxError in an ES module,
      // so `classes.generated.mjs` could not even be imported (the build said
      // nothing). `phpNumberLiteral()` is PHP's own reader (`017` is octal,
      // `1_000` ignores the underscore); a value outside JSON number safety
      // stays "cannot inline" (the caller fails loud with LW002).
      const n = phpNumberLiteral(node.value);
      return n === null ? null : { js: String(n) };
    }
    case 'string': return { js: JSON.stringify(node.value) };
    case 'array': {
      const items = (node.items || []).filter((i) => i && i.kind !== 'comment');
      if (!items.length) return { js: '[]' };
      return null;
    }
    default: return null;
  }
}

// The PUBLIC fields of Illuminate\Mail\Mailable (the kernel's private fields,
// kernel/mailable.mjs): a mailable's declared property of one of these names
// goes into the private field, never onto the plain name.
const MAILABLE_FIELDS = new Set([
  'subject',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'view',
  'textView',
  'viewData',
  'html',
  'text',
]);

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
        if (prop.type) {
          // PHP does not initialise a TYPED property: `public int $sent;`
          // stays uninitialized and READING it throws (php.net/manual/en/
          // language.oop5.properties.php - a typed property "must not be
          // accessed before initialization"). The compiled rung has no
          // uninitialized state, so it would answer null and `$sent + 1`
          // would render 1 where Laravel answers 500.
          return {
            error:
              'the typed property $' + pname + ' of ' + fqcn + ' has no default - PHP leaves it uninitialized and ' +
              'reading it throws "Typed property ' + fqcn + '::$' + pname + ' must not be accessed before ' +
              'initialization"; the compiled rung cannot model uninitialized state',
            code: 'LW002',
          };
        }
        // An UNTYPED property with no default IS null in PHP (`public $view;`
        // is `$view = null`), so the compiled field is null too: `json_encode`
        // keeps the key and the mailer's `!view` test sees the same falsy value.
        declared.push({ name: pname, js: 'null' });
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
  // PHP keeps a property and a method in SEPARATE namespaces, so a mailable may
  // declare `public $view` AND call `$this->view('x')`. JavaScript has one
  // namespace: an own `view` property would shadow `Mailable.prototype.view()`
  // and the fluent call would throw "view is not a function". The kernel keeps
  // its values in private fields (`__view`, `__subject`, ...) and its payload
  // reads them FIRST, so a mailable's declared surface lands there.
  const declaredJs = declared.length
    ? 'Object.assign(__self, { ' +
      declared
        .map((d) => {
          const key = opts.mailable && MAILABLE_FIELDS.has(d.name) ? '__' + d.name : d.name;
          return JSON.stringify(key) + ': ' + d.js;
        })
        .join(', ') +
      ' });\n'
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
  // breaks the whole worker at import time. The build refuses it instead. The
  // scan skips strings and comments: a body that only SAYS "await" is fine.
  if (needsAwait(bodyCode)) {
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
      byRef: !!(p && (p.byref ?? p.byRef)),
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
    // A RESOURCE's withResponse() takes the response the runtime built
    // (Laravel's own signature: `withResponse(Request $request, JsonResponse
    // $response)` - JsonResource.php:251), so the compiled body may use the
    // response surface (the method-call gate in the transpiler checks it).
    const isJsonResponseType = resolvedType && JSON_RESPONSE_TYPES.has(resolvedType);
    if (ptype && !isEventType && !isValidatorType && !isResourceRequest && !isJsonResponseType) {
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
  // Laravel's OWN FormRequest stub writes the hook UNTYPED -
  // `public function withValidator($validator)` - because an override may drop
  // the base's type hint (PHP's contravariance), and a probe of the vendored
  // 13.37 `FormRequest::withValidator()` shows the same `Validator $validator`.
  // Laravel calls the hook with the validator IT built, so the first parameter
  // IS the kernel's validator: the type is seeded by POSITION (only for this
  // hook, only when the app left it untyped) - the same idea as
  // `withResponse`'s `$response` below. Without it the hook body's
  // `$validator->after(...)` had no type and the whole class failed LW002.
  if (
    opts.formRequest &&
    name === 'withValidator' &&
    params.length &&
    !paramTypes.has(vname(params[0].name))
  ) {
    paramTypes.set(vname(params[0].name), 'Illuminate\\Validation\\Validator');
  }
  // A RESOURCE's toArray(Request $request)/with(Request $request) takes the live
  // request: the parameters typed as one are request variables for the compiled
  // body (the same set the controller compiler builds).
  const resourceRequestVars = new Set();
  if (opts.resource) {
    for (const [v, t] of paramTypes) {
      if (RESOURCE_REQUEST_TYPES.has(t)) resourceRequestVars.add(v);
    }
  }
  // `withResponse(Request $request, JsonResponse $response)` is the base's
  // signature, but it declares `$response` UNTYPED there - an app override
  // that keeps the untyped second parameter is legal PHP and still receives
  // the response. The parameter is named here by POSITION (only for
  // `withResponse`, so no other method's argument is granted the surface).
  const jsonResponseVars = new Map();
  if (opts.resource && name === 'withResponse') {
    for (const p of params) {
      const t = paramTypes.get(vname(p.name));
      if (t && JSON_RESPONSE_TYPES.has(t)) jsonResponseVars.set(vname(p.name), t);
    }
    if (!jsonResponseVars.size && params.length > 1) {
      jsonResponseVars.set(vname(params[1].name), 'Illuminate\\Http\\JsonResponse');
    }
  }
  const emitted = transpileControllerMethod((methodNode.body && methodNode.body.children) || [], {
    models: opts.modelAliases,
    modelNotCompiled: opts.modelNotCompiled,
    modelClassFqcns: opts.modelClassFqcns,
    views: new Set(),
    indent: '    ',
    paramVars,
    // A RESOURCE's toArray(Request $request)/with(Request $request) receives the
    // request the runtime resolved with: register it as a request variable so the
    // compiled body may use the allowed request surface. Without it
    // `$request->input(...)` inside a resource failed loud ("the method call
    // $request->path() is not compiled") and the whole route fell back to a port,
    // although the edge serves the call.
    requestVars: resourceRequestVars,
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
    paramTypes: new Map([...paramTypes, ...jsonResponseVars]),
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
  const syncMethod = !!opts.resource || !!opts.sync;
  if (syncMethod && needsAwait(emitted.code)) {
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
  // PHP resolves an unqualified name to a DIRECT child of the file's namespace
  // (`App\OrderMail` in `namespace App;`) — never to a sub-namespace class
  // (`App\Mail\OrderMail`). Accepting a sub-namespace class here would make the
  // compiled module instantiate a class the PHP source cannot even name.
  if (namespace) {
    for (const fqcn of compiled) {
      if (!fqcn.startsWith(namespace + '\\')) continue;
      const alias = shortName(fqcn);
      if (fqcn !== namespace + '\\' + alias) continue;
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

function isResourceCollection(info) {
  return !!(info && (info.parent === 'Illuminate\\Http\\Resources\\Json\\ResourceCollection' ||
    info.parentFqcn === 'Illuminate\\Http\\Resources\\Json\\ResourceCollection'));
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
              ? (isResourceCollection(info) ? 'resourceCollection' : 'resource')
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
          'the edge\'s queue path runs a JOB class (app/Jobs) through the cron drain, and a queued listener is not ' +
          'compiled as one, so the compiled rung does not run it inline',
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
      // The trait names as WRITTEN (a short `Queueable` or a full FQCN): a
      // short name resolves through the file's own `use` imports (PHP's own
      // resolution - `use Illuminate\Bus\Queueable;`).
      const written = traitUses.flatMap((m) => (m.traits || []).map((u) => nodeName(u) || (u && u.name) || '?'));
      const resolved = written.map((raw) => {
        // A leading backslash (`use \Illuminate\Bus\Queueable;`) is the same
        // class: PHP's own resolution strips it.
        const name = raw.startsWith('\\') ? raw.slice(1) : raw;
        if (name.includes('\\')) return name;
        const imported = parsed.imports && parsed.imports.get(name);
        return (imported && imported.replace(/^\\/, '')) || name;
      });
      const unknown = written.filter((_, i) => !BUS_TRAITS.has(resolved[i]));
      if (unknown.length) {
        errors.push({
          class: fqcn,
          message:
            'the class ' + fqcn + ' uses a trait (' + unknown.join(', ') +
            ') — the trait members are not compiled, so the class would miss its methods at the edge',
          code: 'LW002',
        });
        continue;
      }
      // The Laravel bus traits are allowed (their members are answered by the
      // call site / are meaningless at the edge - see BUS_TRAITS), but a body
      // that CALLS one of their members is refused: the compiled rung has no
      // such method, so `$this->release(10)` would throw at drain time where
      // Laravel re-queues the job.
      const ownMethods = new Set(
        classMembers(classNode)
          .filter((m) => m && m.kind === 'method')
          .map((m) => nodeName(m.name))
      );
      const called = [...memberCallsOnSelf(classNode)].filter(
        (n) => BUS_TRAIT_MEMBERS.has(n) && !ownMethods.has(n)
      );
      if (called.length) {
        errors.push({
          class: fqcn,
          message:
            'the class ' + fqcn + ' uses ' + written.join(', ') + ' and its own body calls ' +
            called.map((n) => n + '()').join(', ') +
            ' — the trait members are not compiled (the edge answers `Job::dispatch()` at the call site, and PHP\'s ' +
            'serializer is not used), so the call would throw at run time where Laravel answers the trait\'s own behaviour',
          code: 'LW002',
        });
        continue;
      }
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
    // The app class extends ResourceCollection (`PostCollection extends
    // ResourceCollection {}`): the kernel base is the COLLECTION (the items are
    // mapped through `$collects`), not the plain JsonResource - `rt.newClass`
    // reads the base to choose what to instantiate.
    const isCollectionResource = isResource && parentFqcn === 'Illuminate\\Http\\Resources\\Json\\ResourceCollection';
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
      base: isMailable ? 'mailable' : isFormRequest ? 'formRequest' : isResource ? (isCollectionResource ? 'resourceCollection' : 'resource') : null,
    };
    entries.push({
      fqcn,
      ctor: ctor.js,
      methods,
      deps: ctor.deps || [],
      // The kernel base the compiled class extends: a mailable's fluent
      // surface, a FormRequest's request surface, a JsonResource's wrapping.
      base: isMailable ? 'mailable' : isFormRequest ? 'formRequest' : isResource ? (isCollectionResource ? 'resourceCollection' : 'resource') : null,
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
    // A depth-first walk with three colours (white/gray/black): a cycle is
    // found when a GRAY node is reached again, and the current path holds the
    // whole cycle. #363: the old walk RETURNED EARLY on the first cycle, which
    // left the DFS path un-popped, so a later root produced a phantom
    // self-cycle (`[B, B]`) and the same cycle was reported twice. Colours keep
    // every frame's pop/unwind intact, so each real cycle is found exactly once.
    const state = new Map(); // fqcn -> 'gray' | 'black'
    const stack = [];
    const cycles = [];
    const seenCycle = new Set();
    const visit = (fqcn) => {
      if (state.get(fqcn) === 'black') return;
      const at = stack.indexOf(fqcn);
      if (at >= 0) {
        const cycle = stack.slice(at).concat(fqcn);
        const key = [...new Set(cycle)].sort().join('|');
        if (!seenCycle.has(key)) { seenCycle.add(key); cycles.push(cycle); }
        return;
      }
      stack.push(fqcn);
      state.set(fqcn, 'gray');
      for (const dep of depsOf.get(fqcn) || []) {
        if (!depsOf.has(dep)) continue;
        visit(dep);
      }
      stack.pop();
      state.set(fqcn, 'black');
    };
    for (const e of entries) visit(e.fqcn);
    // #363: report EVERY member of EVERY cycle (the old code broke after the
    // first and left the other members in the registry, so a class the runtime
    // could never build still shipped). Each cycle member is named on its own
    // `errors[]` row so build.mjs marks every one of them blocked.
    const cycleMembers = new Set();
    for (const cycle of cycles) {
      for (const m of cycle) cycleMembers.add(m);
      for (const member of [...new Set(cycle)]) {
        errors.push({
          class: member,
          message: 'Circular dependency detected [' + cycle.join(', ') + '] — the edge would build the services forever',
          code: 'LW002',
        });
      }
    }
    if (cycleMembers.size) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (cycleMembers.has(entries[i].fqcn)) entries.splice(i, 1);
      }
      for (const fqcn of Object.keys(meta)) {
        if (cycleMembers.has(fqcn)) delete meta[fqcn];
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
  lines.push('export const eventListeners = ' + JSON.stringify(listeners, null, 2) + ';');
  lines.push('');
  lines.push('export default classes;');
  lines.push('');
  return lines.join('\n');
}

/**
 * Compile ONE method of a PHP class file (an Eloquent accessor, for instance).
 *
 * The models are not "compiled classes" (the registry is for events, listeners,
 * services and mailables), but an accessor's BODY is app code the edge must run:
 * `getFullNameAttribute($value)` is called by the kernel's Model::get() when the
 * attribute is read. So its body goes through the same method compiler.
 *
 * @param {string} fqcn the class the method belongs to (for the messages)
 * @param {string} file the PHP file
 * @param {string} methodName the method to compile
 * @param {object} opts the same options compileClasses takes
 * @returns {{ js?: string, params?: string[], error?: string, code?: string }}
 */
export function compileOneMethod(fqcn, file, methodName, opts = {}) {
  const parsed = parseClassFile(file);
  if (parsed.error) return { error: parsed.error, code: 'LW002' };
  const classNode = (parsed.classes || []).find((c) => nodeName(c.name) === shortName(fqcn));
  if (!classNode) return { error: 'the class ' + fqcn + ' was not found in ' + file, code: 'LW002' };
  const method = classMembers(classNode).find(
    (m) => m && m.kind === 'method' && nodeName(m.name) === methodName
  );
  if (!method) return { error: 'the method ' + fqcn + '::' + methodName + '() was not found', code: 'LW002' };
  return compileMethod(fqcn, method, {
    models: opts.models instanceof Set ? opts.models : new Set(),
    modelNotCompiled: opts.modelNotCompiled instanceof Map ? opts.modelNotCompiled : new Map(),
    modelClassFqcns: opts.modelClassFqcns || {},
    modelRelations: opts.modelRelations instanceof Map ? opts.modelRelations : new Map(),
    constants: opts.constants || {},
    classes: opts.classes instanceof Set ? opts.classes : new Set(),
    classFqcns: opts.classFqcns instanceof Map ? opts.classFqcns : new Map(),
    imports: parsed.imports,
    // The model's own surface: an accessor reads `$this->attributes`, calls its
    // own helpers, and the model's methods are not compiled - a helper call is
    // a build error (it does not exist at the edge).
    classMethods: new Set(),
    thisVar: 'this',
    // An accessor is called by the kernel's Model::get() on the synchronous
    // read path, so its body must not await (a Promise would be the value).
    sync: true,
  });
}

export default { compileClasses, compileOneMethod };
