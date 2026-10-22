// compiler/src/policy.mjs — the policy compiler (build time).
//
// A Laravel policy is a class: `App\Policies\PostPolicy` with the ability
// methods (`viewAny`, `create`, `update`, ...) and an optional `before()` hook.
// The compiled rung compiles the policy methods into plain async functions and
// ships them in `dist/src/policies.generated.mjs`; the Gate check at request
// time calls them with Laravel's own rules (the guest rules, the before() hook,
// the missing-ability denial).
//
// The metadata comes from tools/policy-dump.php (the real Gate of the booted
// app): which policy answers for a model, which abilities it has, whether a
// guest may call them, and whether the app registers global Gate callbacks.
//
// Anything the compiled rung cannot answer exactly fails loud here — the
// policy is not compiled, and the routes that check it stay blocked.
import parser from 'php-parser';
import { readFileSync } from 'node:fs';
import { transpileControllerMethod } from './transpiler.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const vname = (name) => 'v_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');
const shortName = (fqcn) => String(fqcn).split('\\').pop();

const nodeName = (n) => {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name.name === 'string') return n.name.name;
  return '';
};

const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

// ---------------------------------------------------------------------------
// the AST of the policy file
// ---------------------------------------------------------------------------

function parsePolicyFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    return { error: 'the policy file could not be read: ' + (e.message || e) };
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
  let classNode = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!classNode && node.kind === 'class') {
      classNode = node;
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      walk(node[k]);
    }
  };
  walk(ast.children || []);
  if (!classNode) return { error: 'the policy file has no class' };
  return { classNode };
}

function findMethod(classNode, name) {
  for (const n of classNode.body || []) {
    if (n.kind === 'method' && nodeName(n.name) === name) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// one policy method
// ---------------------------------------------------------------------------

// The parameters of a policy method: the user, then (for an ability) the
// subject; for `before()`: the user, the ability, then the subject.
function planParams(entry, methodMeta, isBefore, opts) {
  const params = methodMeta.params || [];
  const seeds = [];
  params.forEach((p, i) => {
    const isUser = i === 0;
    const isSubject = isBefore ? i >= 2 : i === 1;
    if (isSubject) {
      const fqcn =
        p.type && !p.builtin && opts.models.has(p.type) ? p.type : entry.model;
      seeds.push({ var: vname(p.name), kind: 'model', alias: shortName(fqcn), fqcn });
      return;
    }
    if (!isUser) return;
    // the user: its declared type when it is a model the build knows, else the
    // app's auth provider model (an untyped `$user` is still that user).
    let fqcn = null;
    if (p.type && !p.builtin && opts.models.has(p.type)) fqcn = p.type;
    else if (!p.type && opts.userModel && opts.models.has(opts.userModel)) fqcn = opts.userModel;
    if (fqcn) seeds.push({ var: vname(p.name), kind: 'model', alias: shortName(fqcn), fqcn });
  });
  return seeds;
}

function compileMethod(entry, methodMeta, isBefore, opts, classNode) {
  const name = methodMeta.name;
  const label = (entry.policy || 'the policy') + '::' + name + '()';
  if (methodMeta.static) {
    return { error: 'the policy method ' + label + ' is static — Laravel calls the policy as an instance method' };
  }
  if (methodMeta.abstract) {
    return { error: 'the policy method ' + label + ' is abstract' };
  }
  if (methodMeta.file && entry.file && normPath(methodMeta.file) !== normPath(entry.file)) {
    return {
      error:
        'the policy method ' + label + ' is declared in ' + methodMeta.file + ' (a trait or a base class) — the compiled rung compiles the policy file only',
    };
  }
  if (methodMeta.returnType && !methodMeta.returnBuiltin && methodMeta.returnType !== 'mixed') {
    return {
      error:
        'the policy method ' + label + ' returns ' + methodMeta.returnType + ' — the compiled rung compiles the boolean policies only (an authorization Response carries a message the edge does not render)',
    };
  }
  const params = methodMeta.params || [];
  if (isBefore && params.length > 3) {
    return { error: 'the policy before() may take the user, the ability and one subject — ' + params.length + ' parameters are declared' };
  }
  if (!isBefore && params.length > 2) {
    return {
      error:
        'the policy method ' + label + ' may take the user and one subject — Laravel hands the policy the Gate arguments',
    };
  }
  for (const p of params) {
    if (p.variadic) {
      return { error: 'the policy method ' + label + ' has a variadic parameter — the compiled rung does not compile variadics' };
    }
    if (p.byRef) {
      return { error: 'the policy method ' + label + ' has a by-reference parameter' };
    }
  }
  const methodNode = findMethod(classNode, name);
  if (!methodNode) {
    return { error: 'the policy method ' + label + ' is not in the policy file' };
  }
  const seeds = planParams(entry, methodMeta, isBefore, opts);
  const paramVars = new Set(params.map((p) => vname(p.name)));
  const emitted = transpileControllerMethod((methodNode.body && methodNode.body.children) || [], {
    models: opts.modelAliases,
    modelNotCompiled: opts.modelNotCompiled,
    modelClassFqcns: opts.modelClassFqcns,
    views: new Set(),
    indent: '',
    paramVars,
    requestVars: new Set(),
    // The class constants the app declares (`Post::PUBLISHED`): dumped at
    // build time, so a policy body that reads one compiles instead of
    // stopping on an unavailable constant.
    constants: opts.constants || {},
    formRequests: new Map(),
    modelVarSeeds: seeds,
  });
  if (emitted.errors.length) {
    return { error: 'the policy method ' + label + ' did not compile: ' + emitted.errors[0].message };
  }
  return {
    fn: emitted.code,
    params: params.map((p) => vname(p.name)),
    body: emitted.code,
  };
}

// ---------------------------------------------------------------------------
// the whole registry
// ---------------------------------------------------------------------------

export function compilePolicies(dump, opts = {}) {
  const globals = (dump && dump.globals) || { before: 0, after: 0, abilities: [] };
  const models = (dump && dump.models) || [];
  const modelSet = opts.models instanceof Set ? opts.models : new Set(opts.models || []);
  const modelClassFqcns = opts.modelClassFqcns || {};
  // The class names the policy body may use (the aliases the app writes +
  // the FQCNs): a model chain inside a policy (`Post::where(...)`) resolves
  // against them.
  const modelAliases =
    opts.modelAliases instanceof Set ? opts.modelAliases : new Set(Object.keys(modelClassFqcns));
  const options = {
    models: modelSet,
    modelSet,
    modelAliases,
    modelNotCompiled: opts.modelNotCompiled || new Map(),
    modelClassFqcns,
    userModel: opts.userModel || null,
    // The dumped class constants, by alias and by FQCN.
    constants: opts.constants || {},
  };

  const meta = {};
  const entries = [];
  const errors = [];
  // The GLOBAL Gate::define() abilities, under a reserved key: a subject-less
  // `Gate::allows('x')` resolves here (the policy map is per model).
  meta.__global__ = {
    definitions: (globals && globals.definitions) || {},
    definedAbilities: Array.isArray(globals.abilities) ? globals.abilities : [],
    globalBefore: Number(globals.before) || 0,
    globalAfter: Number(globals.after) || 0,
  };

  for (const entry of models) {
    const modelMeta = {
      policy: entry.policy || null,
      error: entry.error || null,
      hasMagicCall: !!entry.hasMagicCall,
      globalBefore: Number(globals.before) || 0,
      globalAfter: Number(globals.after) || 0,
      definedAbilities: Array.isArray(globals.abilities) ? globals.abilities : [],
      before: null,
      methods: {},
      compileError: null,
    };
    meta[entry.model] = modelMeta;

    if (entry.error && entry.error !== 'no policy') {
      // The policy could not be resolved (an exception, a missing class): the
      // Gate check cannot be answered -> the route stays blocked.
      errors.push({ model: entry.model, message: 'the policy for ' + entry.model + ' could not be read: ' + entry.error });
      entries.push({ model: entry.model, policy: null, before: null, methods: {} });
      continue;
    }
    if (!entry.policy) {
      // No policy: Laravel denies every ability (the build fails loud on a
      // global Gate::define() that would answer instead).
      entries.push({ model: entry.model, policy: null, before: null, methods: {} });
      continue;
    }

    const parsed = parsePolicyFile(entry.file);
    if (parsed.error) {
      modelMeta.compileError = parsed.error;
      errors.push({ model: entry.model, message: parsed.error });
      entries.push({ model: entry.model, policy: entry.policy, before: null, methods: {} });
      continue;
    }

    const compiled = { before: null, methods: {} };
    let failed = null;

    if (entry.before) {
      const r = compileMethod(entry, entry.before, true, options, parsed.classNode);
      if (r.error) failed = r.error;
      else {
        compiled.before = { guest: !!entry.before.guest, fn: r.fn, params: r.params };
        modelMeta.before = { guest: !!entry.before.guest, params: (entry.before.params || []).length };
      }
    }

    if (!failed) {
      for (const [name, methodMeta] of Object.entries(entry.methods || {})) {
        const r = compileMethod(entry, methodMeta, false, options, parsed.classNode);
        if (r.error) {
          failed = r.error;
          break;
        }
        compiled.methods[name] = { guest: !!methodMeta.guest, fn: r.fn, params: r.params };
        modelMeta.methods[name] = {
          guest: !!methodMeta.guest,
          params: (methodMeta.params || []).map((p) => ({ name: p.name, type: p.type })),
        };
      }
    }

    if (failed) {
      modelMeta.compileError = failed;
      errors.push({ model: entry.model, message: failed });
      entries.push({ model: entry.model, policy: entry.policy, before: null, methods: {} });
      continue;
    }

    entries.push({ model: entry.model, policy: entry.policy, before: compiled.before, methods: compiled.methods });
  }

  return { code: emitRegistry(entries), errors, meta };
}

// The generated module: the compiled policies, keyed by the model FQCN.
function emitRegistry(entries) {
  const lines = [];
  lines.push('// generated by laravel-workers — the compiled policies (do not edit)');
  lines.push('// The Gate checks the edge answers: the abilities, the guest rules, before().');
  lines.push('');
  lines.push('export const policies = {');
  for (const e of entries) {
    lines.push('  ' + JSON.stringify(e.model) + ': {');
    lines.push('    policy: ' + JSON.stringify(e.policy) + ',');
    if (e.before) {
      lines.push('    before: {');
      lines.push('      guest: ' + (e.before.guest ? 'true' : 'false') + ',');
      lines.push('      fn: async (' + ['rt'].concat(e.before.params).join(', ') + ') => {');
      for (const l of String(e.before.fn || '').split('\n')) lines.push(l ? '        ' + l : l);
      lines.push('      },');
      lines.push('    },');
    } else {
      lines.push('    before: null,');
    }
    lines.push('    methods: {');
    for (const [name, m] of Object.entries(e.methods)) {
      lines.push('      ' + JSON.stringify(name) + ': {');
      lines.push('        guest: ' + (m.guest ? 'true' : 'false') + ',');
      lines.push('        fn: async (' + ['rt'].concat(m.params).join(', ') + ') => {');
      for (const l of String(m.fn || '').split('\n')) lines.push(l ? '          ' + l : l);
      lines.push('        },');
      lines.push('      },');
    }
    lines.push('    },');
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('export default policies;');
  lines.push('');
  return lines.join('\n');
}

export default { compilePolicies };
