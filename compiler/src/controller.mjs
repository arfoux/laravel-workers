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
import { transpileControllerMethod } from './transpiler.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const PORT_HINT = 'write a port handler for this route (build --scaffold) instead';

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
  'Hash',
  'Illuminate\\Support\\Facades\\Hash',
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
      for (const item of n.items || []) {
        const full = nodeName(item.name);
        if (!full) continue;
        const alias = item.alias ? nodeName(item.alias) : full.split('\\').pop();
        uses[alias] = full;
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
function scanBody(node, classes, views, constants) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) scanBody(n, classes, views, constants);
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
    }
    if (what && what.kind === 'name' && what.name === 'view') {
      const a0 = (node.arguments || [])[0];
      if (a0 && a0.kind === 'string') views.add(String(a0.value));
    }
  } else if (node.kind === 'staticlookup') {
    // A class *constant* read (e.g. RouteServiceProvider::HOME) — the value is
    // dumped at build time. (A static call is handled by the `call` branch.)
    const alias = node.what && node.what.name;
    if (typeof alias === 'string' && constants) constants.add(alias);
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    if (k === 'what' && skipTarget) continue;
    scanBody(node[k], classes, views, constants);
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
  scanBody(method.body, classSet, viewSet, constantSet);

  const classes = [...classSet]
    .filter((alias) => !NON_MODEL_STATICS.has(alias))
    .map((alias) => ({ alias, fqcn: uses[alias] || (nsName ? nsName + '\\' + alias : alias) }));
  classes.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

  // Classes read for a *constant* (e.g. RouteServiceProvider::HOME).
  const constantClasses = [...constantSet]
    .filter((alias) => !NON_MODEL_STATICS.has(alias))
    .map((alias) => ({ alias, fqcn: uses[alias] || (nsName ? nsName + '\\' + alias : alias) }))
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

  return {
    ok: true,
    fqcn,
    namespace: nsName,
    className,
    method: methodName,
    uses,
    params,
    classes,
    constants: constantClasses,
    views: [...viewSet].sort(),
    methodNode: method,
  };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const vname = (name) => 'v_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');

export function emitController(source, methodName, meta = {}) {
  const info = extractController(source, methodName);
  if (!info.ok) return { code: null, errors: info.errors };

  const errors = [];
  // FormRequest classes (verified at build time by tools/formrequest-dump.php)
  // are injected like a Request; every other class type fails loud.
  const formRequestMap = meta.formRequests && typeof meta.formRequests === 'object' ? meta.formRequests : {};
  const params = info.params.map((p) => {
    if (p.inject === 'request') return p;
    if (p.typeFqcn && formRequestMap[p.typeFqcn]) {
      return { ...p, inject: 'request', typeOk: true };
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

  const modelAliases = new Set((meta.models || []).map((m) => m.alias));
  for (const c of info.classes) {
    if (!modelAliases.has(c.alias)) {
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
    formRequests.set(vname(p.name), dumped);
  }

  if (errors.length) return { code: null, errors };

  const paramVars = new Set(params.map((p) => vname(p.name)));
  const requestVars = new Set(params.filter((p) => p.inject === 'request').map((p) => vname(p.name)));
  const emitted = transpileControllerMethod((info.methodNode.body && info.methodNode.body.children) || [], {
    models: modelAliases,
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
  info.views.forEach((v, i) => {
    importLines.push(`import V${i} from '../views/${v}.mjs';`);
    importLines.push(`import VC${i} from '../contexts/${v}.mjs';`);
    viewEntries.push(`  ${JSON.stringify(v)}: { main: V${i}, context: VC${i} }`);
  });

  let seg = 0;
  const paramLines = params.map((p) => {
    if (p.inject === 'request') {
      // Request $request — handed down by the HTTP kernel through the handler ctx.
      return `    let ${vname(p.name)} = rt.request();`;
    }
    const segName = seg < routeParams.length ? routeParams[seg] : p.name;
    seg++;
    const def = p.hasDefault ? JSON.stringify(p.default === undefined ? null : p.default) : 'null';
    return (
      `    let ${vname(p.name)} = rt.param(ctx.params, ${JSON.stringify(segName)}, ` +
      `${JSON.stringify(p.type)}, ${p.hasDefault ? 'true' : 'false'}, ${def});`
    );
  });

  // A FormRequest validates *before* the controller method runs (the container
  // resolves the FormRequest, which validates and authorizes it). The compiled
  // handler does the same: validate first, then run the method body.
  const formRequestLines = [];
  for (const p of params) {
    if (p.inject !== 'request') continue;
    if (!p.typeFqcn || p.typeFqcn === REQUEST_FQCN) continue;
    const dumped = formRequestMap[p.typeFqcn];
    if (!dumped) continue;
    formRequestLines.push(
      `    await rt.request().validate(${JSON.stringify(dumped.rules || {})}, ` +
        `${JSON.stringify(dumped.messages || {})}, ${JSON.stringify(dumped.attributes || {})});`
    );
  }

  const lines = [];
  lines.push(`// generated by laravel-workers — ${info.fqcn}@${methodName} (do not edit)`);
  lines.push("import { buildRt } from '../runtime/rt-from-context.mjs';");
  for (const l of importLines) lines.push(l);
  lines.push("import { models as LW_MODELS, routeMap as LW_ROUTE_MAP } from '../models.generated.mjs';");
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
  if (emitted.code) lines.push(emitted.code);
  lines.push('    throw new Error(' + JSON.stringify('controller ' + info.fqcn + '@' + methodName + ' returned no response') + ');');
  lines.push('  } catch (e) {');
  lines.push('    if (e && e.lwKernel) throw e;');
  lines.push('    if (e && e.status) {');
  lines.push('      const rendered = (ctx && typeof ctx.renderErrorView === "function")');
  lines.push('        ? ctx.renderErrorView(e.status, ctx.request, ctx, e)');
  lines.push('        : null;');
  lines.push('      if (rendered != null) {');
  lines.push('        return { status: Number(e.status) || 500, headers: { "content-type": "text/html; charset=utf-8" }, body: String(rendered) };');
  lines.push('      }');
  lines.push('      return rt.errorResponse(e);');
  lines.push('    }');
  lines.push('    throw e;');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  return { code: lines.join('\n'), errors: [] };
}

export default { extractController, emitController };
