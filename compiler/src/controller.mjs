// compiler/src/controller.mjs — controller extraction + transpilation (build time).
//
// A controller route can become an async edge handler when the method body stays
// inside the supported subset (see README "controller transpilation"). Everything
// else fails loud here at build time and the route stays in the "needs a port"
// list — the build never silently degrades.
//
// Two phases (also exposed through compiler/bin/controller.mjs):
//   extractController(source, method) -> what the build needs to resolve
//     (params, model classes, view names) before it can emit code;
//   emitController(source, method, meta) -> the final handler module source.
import parser from 'php-parser';
import { snake } from '../../kernel/str.mjs';
import { transpileControllerMethod } from './transpiler.mjs';
import { viewFileName } from './view-name.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const PORT_HINT = 'write a port handler for this route (build --scaffold) instead';

// The validation rules that read the file's *content* type (finfo): the edge
// has only the type the browser declared, so the verdict would differ from
// PHP's. The build stops instead of answering differently at the edge.
const CONTENT_MIME_RULES = new Set(['mimes', 'mimetypes']);

// A rule *object* (`Rule::file()->max(2048)`, `File::types([...])`) is a
// class: the compiled validator evaluates the string rules only, so the rule
// would be silently ignored and the validation would differ from Laravel's.
// The build stops and names what it would take to compile it.
const RULE_OBJECT_REASON =
  'a rule object (Rule::file()->max(2048)) is a class — the compiled validator evaluates the string rules only, so ' +
  'the rule would be silently ignored and the validation would differ from Laravel\'s. To compile it: the kernel ' +
  'validator must evaluate the rule object, the FormRequest must be compiled and its prepared input merged into ' +
  'the validated data - ';

// Is this class a validation rule (the factory or a rule object)?
function isValidationRuleClass(fqcn) {
  const f = String(fqcn || '').replace(/^\\/, '');
  return f === 'Illuminate\\Validation\\Rule' || f.startsWith('Illuminate\\Validation\\Rules\\');
}

// The name of a content-mime rule in a dumped rule set ('mimes:png' ->
// 'mimes'), or null when the rule set has none.
function contentMimeRuleOf(rules) {
  const list = Array.isArray(rules) ? rules : [rules];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    for (const token of raw.split('|')) {
      const name = String(token).split(':')[0].trim();
      if (CONTENT_MIME_RULES.has(name)) return name;
    }
  }
  return null;
}

// The facades of Laravel 13 (the vendored Illuminate/Support/Facades directory). A
// facade outside the compiled surface is not an Eloquent model: the reason must
// name the facade, or the operator chases the wrong thing.
const FACADE_NAMES = new Set([
  'App',
  'Artisan',
  'Auth',
  'Blade',
  'Broadcast',
  'Bus',
  'Cache',
  'Cloud',
  'Concurrency',
  'Config',
  'Context',
  'Cookie',
  'Crypt',
  'DB',
  'Date',
  'Event',
  'Exceptions',
  'Facade',
  'File',
  'Gate',
  'Hash',
  'Http',
  'Image',
  'Lang',
  'Log',
  'Mail',
  'MaintenanceMode',
  'Notification',
  'ParallelTesting',
  'Password',
  'Pipeline',
  'Process',
  'Queue',
  'RateLimiter',
  'Redirect',
  'Redis',
  'Request',
  'Response',
  'Route',
  'Schedule',
  'Schema',
  'Session',
  'Storage',
  'URL',
  'Validator',
  'View',
  'Vite',
]);

// A facade class (Laravel 13's Illuminate/Support/Facades) — the class name
// is the facade's short name.
function facadeName(fqcn) {
  const short = String(fqcn).split('\\').pop();
  return FACADE_NAMES.has(short) ? short : null;
}
function isFacadeClass(fqcn) {
  return facadeName(fqcn) !== null;
}

const TYPE_MAP = {
  string: 'string',
  int: 'int',
  integer: 'int',
  float: 'float',
  double: 'float',
  bool: 'bool',
  boolean: 'bool',
  mixed: 'raw',
};

// Static classes that are allowed even though they are not Eloquent models.
const NON_MODEL_STATICS = new Set([
  'Route',
  'self',
  'static',
  'parent',
  'Auth',
  'Illuminate\\Support\\Facades\\Auth',
  'ValidationException',
  'Illuminate\\Validation\\ValidationException',
  'Cache',
  'Illuminate\\Support\\Facades\\Cache',
  'Storage',
  'Illuminate\\Support\\Facades\\Storage',
  'Log',
  'Illuminate\\Support\\Facades\\Log',
  'Str',
  'Illuminate\\Support\\Str',
  'Hash',
  'Illuminate\\Support\\Facades\\Hash',
  'Gate',
  'Illuminate\\Support\\Facades\\Gate',
  'Event',
  'Illuminate\\Support\\Facades\\Event',
  'Mail',
  'Illuminate\\Support\\Facades\\Mail',
  'Queue',
  'Illuminate\\Support\\Facades\\Queue',
]);

function lwErr(code, message, loc, hint) {
  return {
    code,
    message,
    line: loc?.start?.line ?? 0,
    column: loc?.start?.column ?? 0,
    hint: hint || '',
  };
}

function parseSource(source) {
  let ast;
  try {
    ast = phpParser.parseCode(source);
  } catch (e) {
    return { error: lwErr('LW004', 'parse error: ' + (e.message || String(e)), null) };
  }
  if (ast && ast.errors && ast.errors.length) {
    const first = ast.errors[0];
    return { error: lwErr('LW004', 'parse error: ' + (first.msg || first.message || JSON.stringify(first)), first.loc) };
  }
  return { ast };
}

const nodeName = (n) => {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name.name === 'string') return n.name.name;
  return '';
};

// Program -> namespaces (files without a namespace get a virtual '' namespace).
function collectNamespaces(ast) {
  const out = [];
  for (const node of (ast && ast.children) || []) {
    if (node.kind === 'namespace') {
      out.push({ name: nodeName(node.name), children: node.children || [] });
    } else {
      out.push({ name: '', children: [node] });
    }
  }
  return out;
}

function findClass(ast) {
  for (const ns of collectNamespaces(ast)) {
    for (const node of ns.children) {
      if (node.kind === 'class') return { nsName: ns.name, classNode: node, children: ns.children };
    }
  }
  return null;
}

function collectUses(children) {
  const uses = {};
  for (const n of children) {
    if (n.kind === 'usegroup') {
      // A grouped import (`use App\Models\{Post, Comment};`): php-parser puts
      // the group prefix on the usegroup node and the UNQUALIFIED name on each
      // item - PHP resolves the prefix, so the compiler does too.
      const prefix = nodeName(n.name);
      for (const item of n.items || []) {
        const full = nodeName(item.name);
        if (!full) continue;
        const alias = item.alias ? nodeName(item.alias) : full.split('\\').pop();
        uses[alias] = prefix ? prefix + '\\' + full : full;
      }
    } else if (n.kind === 'use') {
      const full = nodeName(n.name);
      if (!full) continue;
      uses[full.split('\\').pop()] = full;
    }
  }
  return uses;
}

function typeName(t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (t.kind === 'nullabletype') return typeName(t.what);
  if (t.kind === 'uniontype') return null; // unions are rejected (fail loud)
  if (t.kind === 'intersectiontype') return null;
  const n = t.name !== undefined ? t.name : null;
  if (typeof n === 'string') return n;
  if (n && typeof n.name === 'string') return n.name;
  if (typeof t.value === 'string') return t.value;
  return null;
}

function literalOf(node) {
  if (!node) return { ok: false };
  if (node.kind === 'number') return { ok: true, value: Number(node.value) };
  if (node.kind === 'string') return { ok: true, value: String(node.value) };
  if (node.kind === 'boolean') return { ok: true, value: !!node.value };
  if (node.kind === 'nullkeyword' || node.kind === 'null') return { ok: true, value: null };
  if (node.kind === 'unary' && (node.type === '-' || node.type === '+')) {
    const inner = literalOf(node.what || node.expr || node.operand);
    if (inner.ok && typeof inner.value === 'number') {
      return { ok: true, value: node.type === '-' ? -inner.value : inner.value };
    }
  }
  return { ok: false };
}

// The only class type a compiled controller can be handed is the HTTP Request;
// anything else is a service and must ride through a port.
const REQUEST_FQCN = 'Illuminate\\Http\\Request';

// Resolve a type hint name the way PHP would in this file (use aliases first,
// then the controller's own namespace).
function resolveTypeFqcn(tn, uses, nsName) {
  if (!tn) return null;
  if (uses && Object.prototype.hasOwnProperty.call(uses, tn)) return uses[tn];
  if (tn.indexOf('\\') !== -1) return tn.replace(/^\\/, '');
  return nsName ? nsName + '\\' + tn : tn;
}

function analyzeParams(method, uses = null, nsName = null) {
  const params = [];
  for (const p of method.arguments || []) {
    const entry = {
      name: nodeName(p.name),
      type: 'raw',
      typeOk: true,
      typeHint: null,
      inject: null,
      hasDefault: p.value != null,
      default: null,
      defaultOk: true,
      variadic: !!p.variadic,
      byRef: !!p.byref,
      // `?int $n` accepts null; a bare `int $n` throws PHP 8's TypeError.
      nullable: !!(p.type && p.type.kind === 'nullabletype'),
    };
    const tn = typeName(p.type);
    if (p.type) {
      const lowered = tn == null ? null : tn.toLowerCase();
      if (lowered && TYPE_MAP[lowered]) {
        entry.type = TYPE_MAP[lowered];
        entry.typeHint = tn;
      } else if (resolveTypeFqcn(tn, uses, nsName) === REQUEST_FQCN) {
        // Request $request — injected from the HTTP context, not a route segment.
        entry.inject = 'request';
        entry.typeHint = tn;
        entry.typeFqcn = REQUEST_FQCN;
        entry.typeOk = true;
      } else {
        // Any other class type (a FormRequest, a service, ...). The build dumps
        // the candidate classes at build time; a FormRequest is injected, every
        // other service type fails loud.
        entry.typeOk = false;
        entry.typeHint = tn || 'complex (union/intersection)';
        entry.typeFqcn = tn ? resolveTypeFqcn(tn, uses, nsName) : null;
      }
    }
    if (entry.hasDefault) {
      const dv = literalOf(p.value);
      if (dv.ok) entry.default = dv.value;
      else entry.defaultOk = false;
    }
    params.push(entry);
  }
  return params;
}

// Walk the method body for static class references and literal view() names.
function scanBody(node, classes, views, constants, newClasses) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) scanBody(n, classes, views, constants, newClasses);
    return;
  }
  // A call whose target is a static lookup (`Post::where(...)`) — the class is a
  // model/facade reference, not a constant read, so the target is not revisited.
  let skipTarget = false;
  if (node.kind === 'call') {
    const what = node.what;
    if (what && what.kind === 'staticlookup') {
      const alias = what.what && what.what.name;
      if (typeof alias === 'string') classes.add(alias);
      skipTarget = true;
      // The Gate check names its subject: `Gate::allows('update', Post::class)`.
      // That subject is a model the build must dump (its policy lives there).
      const meth = what.offset && what.offset.name;
      const cls = String(alias || '').replace(/^\\/, '');
      if (
        (meth === 'allows' || meth === 'denies') &&
        (cls === 'Gate' || cls === 'Illuminate\\Support\\Facades\\Gate')
      ) {
        const subject = (node.arguments || [])[1];
        if (
          subject &&
          subject.kind === 'staticlookup' &&
          subject.offset &&
          subject.offset.name === 'class'
        ) {
          const subjectAlias = subject.what && subject.what.name;
          if (typeof subjectAlias === 'string') classes.add(subjectAlias);
        }
      }
    }
    if (what && what.kind === 'name' && what.name === 'view') {
      const a0 = (node.arguments || [])[0];
      if (a0 && a0.kind === 'string') views.add(String(a0.value));
    }
  } else if (node.kind === 'new') {
    // `new OrderMail()` - the class the body instantiates. The build needs it:
    // a class that does not compile (a mailable with Laravel 13's modern API)
    // makes the route fail at request time.
    const what = node.what;
    const alias = what && typeof what.name === 'string' ? what.name : null;
    if (alias && newClasses) newClasses.add(alias);
  } else if (node.kind === 'staticlookup') {
    // `Model::class` — the class name as a string. It is not a constant read;
    // the compiler resolves it (the Gate subject) or fails loud.
    if (node.offset && node.offset.name === 'class') return;
    // A class *constant* read (e.g. RouteServiceProvider::HOME) — the value is
    // dumped at build time. (A static call is handled by the `call` branch.)
    const alias = node.what && node.what.name;
    if (typeof alias === 'string' && constants) constants.add(alias);
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    if (k === 'what' && skipTarget) continue;
    scanBody(node[k], classes, views, constants, newClasses);
  }
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

export function extractController(source, methodName) {
  const parsed = parseSource(source);
  if (parsed.error) return { ok: false, errors: [parsed.error] };
  const found = findClass(parsed.ast);
  if (!found) return { ok: false, errors: [lwErr('LW004', 'no class found in controller file', null, PORT_HINT)] };

  const { nsName, classNode, children } = found;
  const className = nodeName(classNode.name);
  if (!className) return { ok: false, errors: [lwErr('LW004', 'controller class has no name', classNode.loc, PORT_HINT)] };
  const fqcn = nsName ? nsName + '\\' + className : className;

  const uses = collectUses(children);
  const method = (classNode.body || []).find((n) => n.kind === 'method' && nodeName(n.name) === methodName);
  if (!method) {
    return { ok: false, errors: [lwErr('LW004', `method ${methodName}() not found in ${fqcn}`, classNode.loc, PORT_HINT)] };
  }

  const params = analyzeParams(method, uses, nsName);
  const classSet = new Set();
  const viewSet = new Set();
  const constantSet = new Set();
  const newClassSet = new Set();
  scanBody(method.body, classSet, viewSet, constantSet, newClassSet);

  const classes = [...classSet]
    .filter((alias) => !NON_MODEL_STATICS.has(alias.replace(/^\\/, '')))
    .map((rawAlias) => {
      // A fully-qualified static call (`\App\Models\Post::find()`) is already
      // resolved by PHP — the controller's namespace must not be prefixed.
      const alias = String(rawAlias).replace(/^\\/, '');
      const fqcn = uses[alias] || (alias.includes('\\') ? alias : nsName ? nsName + '\\' + alias : alias);
      return { alias, fqcn };
    });
  classes.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

  // The classes the body instantiates (`new OrderMail()`): the build stops
  // the route when one of them does not compile.
  const newClasses = [...newClassSet]
    .map((rawAlias) => {
      const alias = String(rawAlias).replace(/^\\/, '');
      const fqcn = uses[alias] || (alias.includes('\\') ? alias : nsName ? nsName + '\\' + alias : alias);
      return { alias, fqcn };
    })
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

  // Classes read for a *constant* (e.g. RouteServiceProvider::HOME).
  const constantClasses = [...constantSet]
    .filter((alias) => !NON_MODEL_STATICS.has(alias))
    .map((alias) => ({ alias, fqcn: uses[alias] || (nsName ? nsName + '\\' + alias : alias) }))
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

  // The kinds of the data the views receive: a Blade view carries no type
  // information, so the build tells the compiler (the pagination view receives
  // a paginator: `$paginator->links()`).
  const paginatorVars = new Set();
  const viewDataKinds = {};
  collectViewDataKinds(method.body, paginatorVars, viewDataKinds);

  return {
    ok: true,
    fqcn,
    namespace: nsName,
    className,
    method: methodName,
    uses,
    params,
    classes,
    newClasses,
    constants: constantClasses,
    views: [...viewSet].sort(),
    // A paginator in the method (Model::paginate()): the handler then renders
    // the pagination view (the compiled `pagination::tailwind`).
    usesPaginator: bodyHasCall(method.body, 'paginate'),
    // A mail in the method (`Mail::to($u)->send($mailable)`): the handler then
    // renders the mailable's view (a mailable's view is not reached from a
    // route, so the build compiles it and hands it to the runtime).
    usesMail: bodyHasMail(method.body),
    viewDataKinds,
    methodNode: method,
  };
}

// Does the body send a mail? (`Mail::to($u)->send($mailable)`) — a static call
// on the Mail facade (the FQCN or the alias).
function bodyHasMail(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    for (const n of node) if (bodyHasMail(n)) return true;
    return false;
  }
  if (node.kind === 'staticlookup') {
    const w = node.what;
    const name = String((w && typeof w === 'object' ? w.name : w) || '').replace(/^\\/, '');
    if (name === 'Mail' || name.endsWith('\\Mail')) return true;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    if (bodyHasMail(node[k])) return true;
  }
  return false;
}

// Does the body call the named method? (`Post::paginate()`, `$q->paginate()`)
function bodyHasCall(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    for (const n of node) if (bodyHasCall(n, name)) return true;
    return false;
  }
  if (node.kind === 'call') {
    const w = node.what;
    if (w && (w.kind === 'propertylookup' || w.kind === 'staticlookup')) {
      if (w.offset && w.offset.name === name) return true;
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    if (bodyHasCall(node[k], name)) return true;
  }
  return false;
}

// The kinds of the data each view receives: the variables that hold a
// paginator (the method calls `paginate()`), by view name.
function collectViewDataKinds(node, paginatorVars, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectViewDataKinds(n, paginatorVars, out);
    return;
  }
  if (node.kind === 'assign' && node.left && node.left.kind === 'variable') {
    const name = String(node.left.name || '');
    if (name && isPaginateCall(node.right)) paginatorVars.add(name);
  }
  if (node.kind === 'call' && node.what && node.what.kind === 'name' && node.what.name === 'view') {
    const args = node.arguments || [];
    const viewName = args[0] && args[0].kind === 'string' ? args[0].value : null;
    const data = args[1];
    if (viewName && data && data.kind === 'array') {
      const kinds = {};
      for (const it of data.items || []) {
        if (!it.key || it.key.kind !== 'string') continue;
        const value = it.value;
        if (value && value.kind === 'variable' && paginatorVars.has(String(value.name || ''))) {
          kinds[it.key.value] = 'paginator';
        }
      }
      if (Object.keys(kinds).length) out[viewName] = kinds;
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    collectViewDataKinds(node[k], paginatorVars, out);
  }
}

// Is the expression a `paginate()` call? (`Post::paginate()`, `$q->paginate()`)
function isPaginateCall(node) {
  if (!node || node.kind !== 'call') return false;
  const w = node.what;
  if (!w) return false;
  if (w.kind === 'propertylookup' || w.kind === 'staticlookup') {
    return !!(w.offset && w.offset.name === 'paginate');
  }
  return false;
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const vname = (name) => 'v_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');

// The methods Laravel resolves a route-model binding through (an app that
// overrides one of them binds a different row than the compiled lookup).
const BINDING_METHODS = [
  'resolveRouteBinding',
  'resolveChildRouteBinding',
  'resolveSoftDeletableRouteBinding',
  'resolveSoftDeletableChildRouteBinding',
];

export function emitController(source, methodName, meta = {}) {
  const info = extractController(source, methodName);
  if (!info.ok) return { code: null, errors: info.errors };

  const errors = [];
  // FormRequest classes (verified at build time by tools/formrequest-dump.php)
  // are injected like a Request; every other class type fails loud.
  const formRequestMap = meta.formRequests && typeof meta.formRequests === 'object' ? meta.formRequests : {};
  // The model-bound parameters (Laravel's implicit route-model binding):
  // `show(Post $post)` — the model comes from the route segment, not from the
  // raw string.
  const modelByFqcn = new Map();
  for (const m of meta.models || []) if (m.fqcn) modelByFqcn.set(m.fqcn, m);
  const params = info.params.map((p) => {
    if (p.inject === 'request') return p;
    if (p.typeFqcn && formRequestMap[p.typeFqcn]) {
      return { ...p, inject: 'request', typeOk: true };
    }
    if (p.typeFqcn && modelByFqcn.has(p.typeFqcn)) {
      return { ...p, typeOk: true, modelBound: modelByFqcn.get(p.typeFqcn) };
    }
    return p;
  });
  const routeParams = (Array.isArray(meta.routeParams) ? meta.routeParams : []).map((s) =>
    String(s).replace(/[?*]$/, '')
  );

  let segIndex = 0;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p.variadic) errors.push(lwErr('LW002', `parameter $${p.name} is variadic — ` + PORT_HINT, null, PORT_HINT));
    if (p.byRef) errors.push(lwErr('LW002', `parameter $${p.name} is by-reference — ` + PORT_HINT, null, PORT_HINT));
    if (!p.typeOk) {
      errors.push(
        lwErr(
          'LW002',
          `parameter $${p.name} has unsupported type "${p.typeHint}" — only scalar parameters (string/int/float/bool) and Illuminate\\Http\\Request are supported here; ` +
            'other services need a port — ' +
            PORT_HINT,
          null,
          PORT_HINT
        )
      );
    }
    if (p.inject) {
      // Injected params are never filled from the URL, so they do not consume a
      // route segment and cannot carry a default.
      if (p.hasDefault) {
        errors.push(
          lwErr('LW002', `injected parameter $${p.name} cannot have a default value — ` + PORT_HINT, null, PORT_HINT)
        );
      }
      continue;
    }
    if (p.modelBound) {
      // Laravel's implicit binding binds by NAME: the route parameter must
      // carry the same name as the method's parameter - or its snake_case form
      // (ImplicitRouteBinding::getParameterName(): the exact name, else
      // Str::snake($name) - 'blogPost' matches the route's 'blog_post').
      let routeParamName = routeParams.includes(p.name) ? p.name : null;
      if (!routeParamName) {
        const wanted = snake(p.name);
        for (const r of routeParams) {
          if (snake(r) === wanted) { routeParamName = r; break; }
        }
      }
      p.routeParamName = routeParamName;
      if (!routeParamName) {
        errors.push(
          lwErr(
            'LW004',
            `the model-bound parameter $${p.name} has no matching route parameter (the route has: ${
              routeParams.join(', ') || 'none'
            }) — Laravel's implicit binding binds by name (or its snake_case form) — ` + PORT_HINT,
            null,
            PORT_HINT
          )
        );
      }
      // Laravel resolves the binding through the MODEL's own method
      // (`resolveRouteBinding`, ImplicitRouteBinding.php:57): an app that
      // overrides it can scope the lookup (a tenant, a soft delete), so the
      // compiled primary-key lookup would bind a DIFFERENT row.
      const overridden = (p.modelBound.notCompiled || []).filter((m) =>
        BINDING_METHODS.includes(m)
      );
      if (overridden.length) {
        errors.push(
          lwErr(
            'LW003',
            `the model ${p.modelBound.fqcn} overrides ${overridden[0]}() — Laravel binds the model through that method (the app can scope the lookup), the compiled binding fetches the model by its key — ` +
              PORT_HINT,
            null,
            PORT_HINT
          )
        );
      }
      const key = p.modelBound.routeKey || 'id';
      const primary = p.modelBound.primaryKey || 'id';
      if (key !== primary) {
        errors.push(
          lwErr(
            'LW003',
            `the model ${p.modelBound.fqcn} binds on "${key}" (not on its key "${primary}") — the compiled binding fetches the model by its key — ` +
              PORT_HINT,
            null,
            PORT_HINT
          )
        );
      }
    }
    if (!p.defaultOk) {
      errors.push(lwErr('LW002', `parameter $${p.name} has a non-literal default value — ` + PORT_HINT, null, PORT_HINT));
    }
    if (segIndex >= routeParams.length && !p.hasDefault) {
      errors.push(
        lwErr(
          'LW002',
          `parameter $${p.name} has no matching route segment and no default — Laravel would fail at request time; ` +
            PORT_HINT,
          null,
          PORT_HINT
        )
      );
    }
    segIndex++;
  }

  // A model may be called by its alias (`Post::find()`) or fully qualified
  // (`\App\Models\Post::find()`); the runtime map knows both keys.
  const modelAliases = new Set();
  // alias -> FQCN (and FQCN -> FQCN): the compiler needs the FQCN to find the
  // policy of a Gate subject and to resolve `Model::class`.
  const modelClassFqcns = {};
  // The model methods the app declares (the relations, the accessors): a
  // read of one is not compiled (it used to answer null - silently wrong).
  const modelNotCompiled = new Map();
  for (const m of meta.models || []) {
    modelAliases.add(m.alias);
    if (m.fqcn) {
      modelAliases.add(m.fqcn);
      modelClassFqcns[m.alias] = m.fqcn;
      modelClassFqcns[m.fqcn] = m.fqcn;
    }
    if (Array.isArray(m.notCompiled) && m.notCompiled.length) {
      modelNotCompiled.set(m.alias, m.notCompiled);
      if (m.fqcn) modelNotCompiled.set(m.fqcn, m.notCompiled);
    }
  }
  for (const c of info.classes) {
    // A rule object (`Rule::file()->max(2048)`) is a class: the compiled
    // validator evaluates the string rules only, so the rule would be silently
    // ignored and the validation would differ. The build stops and says what
    // it would take to compile it.
    if (isValidationRuleClass(c.fqcn)) {
      errors.push(lwErr('LW002', RULE_OBJECT_REASON + PORT_HINT, null, PORT_HINT));
      continue;
    }
    // A JOB class (`App\Jobs\X`): `X::dispatch()` is a queue push, not a
    // model query - the transpiler compiles it (rt.queuePush).
    const isJobClass =
      meta.classes && Array.isArray(meta.classes.jobs) && meta.classes.jobs.includes(c.fqcn);
    if (!modelAliases.has(c.alias) && !isJobClass) {
      if (isFacadeClass(c.fqcn)) {
        errors.push(
          lwErr(
            'LW002',
            `the ${facadeName(c.fqcn)} facade is not compiled at the edge — the compiled rung has no ${facadeName(c.fqcn)} ` +
              `surface; write a port handler for this route — ` + PORT_HINT,
            null,
            PORT_HINT
          )
        );
        continue;
      }
      errors.push(
        lwErr(
          'LW003',
          `${c.fqcn} is not a registered Eloquent model for this route — only Eloquent models (find/findOrFail/all/where/whereIn/create) and Route::has transpile; ` +
            PORT_HINT,
          null,
          PORT_HINT
        )
      );
    }
  }

  // A FormRequest parameter must have a dumped rule set, otherwise the route
  // would validate nothing at the edge (Laravel validates before the method).
  const formRequests = new Map();
  for (const p of params) {
    if (p.inject !== 'request') continue;
    if (!p.typeFqcn || p.typeFqcn === REQUEST_FQCN) continue;
    const dumped = formRequestMap[p.typeFqcn];
    if (!dumped) {
      errors.push(
        lwErr(
          'LW003',
          `${p.typeFqcn} is not a registered FormRequest — its rules could not be dumped; ` + PORT_HINT,
          null,
          PORT_HINT
        )
      );
      continue;
    }
    // The dumped rules: a rule that reads the file's *content* type (finfo)
    // cannot be answered like PHP at the edge (the edge has only the type the
    // browser declared), so the build stops and names the rule.
    for (const [field, rules] of Object.entries(dumped.rules || {})) {
      const name = contentMimeRuleOf(rules);
      if (!name) continue;
      errors.push(
        lwErr(
          'LW002',
          `the ${name} validation rule on "${field}" is not compiled — it reads the file's *content* type (finfo) and ` +
            `the edge cannot sniff the content like PHP does: use the file rule with max (the size in kilobytes) ` +
            `instead, or check the extension in the controller; ` + PORT_HINT,
          null,
          PORT_HINT
        )
      );
    }
    formRequests.set(vname(p.name), dumped);
  }

  if (errors.length) return { code: null, errors };

  const paramVars = new Set(params.map((p) => vname(p.name)));
  const requestVars = new Set(params.filter((p) => p.inject === 'request').map((p) => vname(p.name)));
  const emitted = transpileControllerMethod((info.methodNode.body && info.methodNode.body.children) || [], {
    models: modelAliases,
    modelNotCompiled,
    modelClassFqcns,
    // The dumped policies (the Gate check reads them: the abilities, the guest
    // rules, the global Gate callbacks).
    policies: meta.policies && typeof meta.policies === 'object' ? meta.policies : {},
    // The compiled classes (the event classes + their listeners): `new X(...)`
    // and the event dispatch.
    classes: (meta.classes && meta.classes.fqcns) || [],
    // The job classes: `Job::dispatch()` is a queue push, not a static call.
    jobs: (meta.classes && meta.classes.jobs) || [],
    classFqcns: (meta.classes && meta.classes.aliases) || {},
    // The event classes that did not compile, with the reason: a dispatch of
    // one of them would be a silent no-op, so the build stops and names it.
    classBlocked: (meta.classes && meta.classes.blocked) || {},
    // The compiled classes' own methods (FQCN -> { methods, base }): a call
    // on an inline instance (`(new OrderService())->doIt($o)`) must hand the
    // runtime over as the first argument.
    classRegistry: (meta.classes && meta.classes.registry) || {},
    // The app's object store (the default disk's name + the configured disks):
    // only the default disk compiles.
    storage: meta.storage && typeof meta.storage === 'object' ? meta.storage : {},
    // The model-bound parameters are models: a relation read on one must fail
    // loud (it used to answer null - a wrong answer, silently).
    modelVarSeeds: params
      .filter((p) => p.modelBound)
      .map((p) => ({ var: vname(p.name), kind: 'model', alias: p.modelBound.fqcn, fqcn: p.modelBound.fqcn })),
    views: new Set(info.views),
    indent: '    ',
    paramVars,
    requestVars,
    constants: meta.constants && typeof meta.constants === 'object' ? meta.constants : {},
    formRequests,
  });
  if (emitted.errors.length) return { code: null, errors: emitted.errors };

  const importLines = [];
  const viewEntries = [];
  // The views the handler imports: the ones the method renders + the ones
  // they depend on (a layout: `@extends('layouts.app')`) + the pagination view
  // (when the method uses a paginator: `$paginator->links()` renders it).
  const viewNames = [...(Array.isArray(meta.views) && meta.views.length ? meta.views : info.views)];
  if (emitted.usedPaginator && meta.paginationView && !viewNames.includes(meta.paginationView)) {
    viewNames.push(meta.paginationView);
  }
  viewNames.forEach((v, i) => {
    importLines.push(`import V${i} from '../views/${viewFileName(v)}.mjs';`);
    importLines.push(`import VC${i} from '../contexts/${viewFileName(v)}.mjs';`);
    viewEntries.push(`  ${JSON.stringify(v)}: { main: V${i}, context: VC${i} }`);
  });

  let seg = 0;
  const paramLines = params.map((p) => {
    if (p.inject === 'request') {
      // Request $request — handed down by the HTTP kernel through the handler ctx.
      return `    let ${vname(p.name)} = rt.request();`;
    }
    if (p.modelBound) {
      // The implicit route-model binding: the segment is the model's key, and
      // a missing model is a 404 (Laravel's ModelNotFoundException).
      seg++;
      return (
        `    let ${vname(p.name)} = (await rt.model(${JSON.stringify(p.modelBound.fqcn)}).findOrFail(` +
        `rt.param(ctx.params, ${JSON.stringify(p.routeParamName || p.name)}, "raw", false, null)));`
      );
    }
    const segName = seg < routeParams.length ? routeParams[seg] : p.name;
    seg++;
    const def = p.hasDefault ? JSON.stringify(p.default === undefined ? null : p.default) : 'null';
    // `?int $n` accepts null; a bare `int $n` throws (PHP 8's TypeError), so
    // the runtime needs the nullability to answer what Laravel answers.
    const nullable = !!p.nullable;
    return (
      `    let ${vname(p.name)} = rt.param(ctx.params, ${JSON.stringify(segName)}, ` +
      `${JSON.stringify(p.type)}, ${p.hasDefault ? 'true' : 'false'}, ${def}, ${nullable ? 'true' : 'false'});`
    );
  });

  // A FormRequest validates *before* the controller method runs (the container
  // resolves the FormRequest, which validates and authorizes it). The compiled
  // handler does the same: the runtime runs Laravel's lifecycle
  // (ValidatesWhenResolvedTrait::validateResolved ->
  // FormRequest::getValidatorInstance) and the method body runs after it.
  const formRequestLines = [];
  // The FormRequest's hooks need the compiled class: the handler imports the
  // classes module (the class registry) and hands it to the runtime.
  let usesFormRequestClass = false;
  for (const p of params) {
    if (p.inject !== 'request') continue;
    if (!p.typeFqcn || p.typeFqcn === REQUEST_FQCN) continue;
    const dumped = formRequestMap[p.typeFqcn];
    if (!dumped) continue;
    // The whole lifecycle runs on the compiled class's hooks, in Laravel's
    // order: prepareForValidation -> authorize (the 403) -> the validator over
    // validationData() -> withValidator -> after -> the rules (the 422) ->
    // passedValidation. The hooks are the class's own methods, so the instance
    // is always built.
    usesFormRequestClass = true;
    formRequestLines.push(
      `    const v_validatedData = await rt.formRequest(${JSON.stringify(p.typeFqcn)}, {` +
        ` rules: ${JSON.stringify(dumped.rules || {})},` +
        ` messages: ${JSON.stringify(dumped.messages || {})},` +
        ` attributes: ${JSON.stringify(dumped.attributes || {})},` +
        ` hooks: ${JSON.stringify(Array.isArray(dumped.hooks) ? dumped.hooks : [])} });`
    );
    // `$request->validated()` reads the data the rules passed
    // (Illuminate\Http\Request::validated via the FormRequest): the kernel's
    // request keeps it in `_validatedData` (kernel/validation.mjs:95).
    formRequestLines.push(`    rt.request()._validatedData = v_validatedData;`);
  }

  const lines = [];
  lines.push(`// generated by laravel-workers — ${info.fqcn}@${methodName} (do not edit)`);
  lines.push("import { buildRt } from '../runtime/rt-from-context.mjs';");
  for (const l of importLines) lines.push(l);
  lines.push("import { models as LW_MODELS, routeMap as LW_ROUTE_MAP } from '../models.generated.mjs';");
  // The Gate check reads the compiled policies (the abilities, the guest rules).
  if (emitted.usedGate) {
    lines.push(
      "import { policies as LW_POLICIES, gateDefinitions as LW_GATE_DEFINITIONS } from '../policies.generated.mjs';"
    );
  }
  // The compiled classes (the listeners, the services, the mailables): the
  // runtime builds the instances.
  if (emitted.usedEvents || emitted.usedClasses || usesFormRequestClass) {
    lines.push(
      "import { classes as LW_CLASSES, eventListeners as LW_EVENT_LISTENERS } from '../classes.generated.mjs';"
    );
  }
  lines.push('');
  lines.push('const VIEWS = {');
  for (const e of viewEntries) lines.push(e + ',');
  lines.push('};');
  lines.push('');
  lines.push('export default async function handle(ctx, env) {');
  lines.push('  const rt = buildRt(null, {');
  lines.push('    strict: true,');
  lines.push('    runtime: true,');
  lines.push('    db: env && env.DB ? env.DB : null,');
  lines.push('    models: LW_MODELS,');
  lines.push('    views: VIEWS,');
  if (emitted.usedGate) {
    lines.push('    policies: LW_POLICIES,');
    lines.push('    gateDefinitions: LW_GATE_DEFINITIONS,');
  }
  if (emitted.usedEvents || emitted.usedClasses || usesFormRequestClass) {
    lines.push('    classes: LW_CLASSES,');
  }
  if (emitted.usedEvents) {
    lines.push('    eventListeners: LW_EVENT_LISTENERS,');
  }
  lines.push("    origin: (function () { var r = ctx && ctx.request; if (!r) return null; var h = (typeof r.host === 'function') ? r.host() : r.host; if (!h) return null; if (typeof r.schemeAndHttpHost === 'function') return r.schemeAndHttpHost(); var s = (typeof r.scheme === 'function') ? r.scheme() : 'https'; return s + '://' + h; })(),");
  lines.push('    routeMap: LW_ROUTE_MAP,');
  // The app's bcrypt rounds (hashing.bcrypt.rounds) — Hash::make() parity.
  const hashRounds = Number(meta.hashRounds);
  lines.push('    hashRounds: ' + (Number.isFinite(hashRounds) ? hashRounds : 12) + ',');
  lines.push('    // Live HTTP wiring from the compiled kernel: session()/old()/csrf_*()/auth().');
  lines.push('    http: ctx,');
  lines.push('  });');
  lines.push('  try {');
  for (const l of paramLines) lines.push(l);
  for (const l of formRequestLines) lines.push(l);
  // The body runs in its own function: the value it returns is converted the
  // way Laravel's Router::toResponse converts it (a string is the body, an
  // array is JSON, null is an empty 200). A method that returns nothing
  // answers an empty 200 - Laravel does not fail there.
  lines.push('    const __lwResult = await (async () => {');
  if (emitted.code) lines.push(emitted.code);
  lines.push('    })();');
  lines.push('    return rt.toResponse(__lwResult);');
  lines.push('  } catch (e) {');
  lines.push('    if (e && e.lwKernel) throw e;');
  // An expectsJson request gets Laravel's JSON body (Handler::prepareJsonResponse),
  // NOT the HTML error page - the kernel's renderer makes the same choice. It is
  // computed ONCE, before the status branch: the 500 fallback below needs it too
  // (a `const` inside the branch would be a TDZ error there).
  lines.push('    const wantsJson = !!(ctx && ctx.request && typeof ctx.request.expectsJson === "function" && ctx.request.expectsJson());');
  lines.push('    if (e && e.status) {');
  lines.push('      const rendered = (!wantsJson && ctx && typeof ctx.renderErrorView === "function")');
  lines.push('        ? ctx.renderErrorView(e.status, ctx.request, ctx, e)');
  lines.push('        : null;');
  lines.push('      if (rendered != null) {');
  lines.push('        return { status: Number(e.status) || 500, headers: { "content-type": "text/html; charset=utf-8" }, body: String(rendered) };');
  lines.push('      }');
  lines.push('      return rt.errorResponse(e);');
  lines.push('    }');
  // An error WITHOUT a status is a 500 in Laravel (the exception handler
  // renders `errors::500`). The compiled rung renders the same page instead of
  // rethrowing into the platform's plain-text fallback.
  lines.push('    const rendered500 = (!wantsJson && ctx && typeof ctx.renderErrorView === "function")');
  lines.push('      ? ctx.renderErrorView(500, ctx.request, ctx, e)');
  lines.push('      : null;');
  lines.push('    if (rendered500 != null) {');
  lines.push('      return { status: 500, headers: { "content-type": "text/html; charset=utf-8" }, body: String(rendered500) };');
  lines.push('    }');
  lines.push('    throw e;');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  return { code: lines.join('\n'), errors: [], usedQueue: !!emitted.usedQueue };
}

export default { extractController, emitController };
