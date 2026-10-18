// compiler/src/transpiler.mjs
import parser from 'php-parser';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

// PHP variable names are mangled to JS identifiers so reserved words ($null, $new, ...) are safe.
const vname = (name) => 'v_' + String(name).replace(/^\\$/, '').replace(/[^A-Za-z0-9_]/g, '_');
const fname = (name) => 'fn_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');

function mkErr(code, message, loc) {
  const e = new Error(message);
  e.lw = { code, message, line: loc?.start?.line ?? 0, column: loc?.start?.column ?? 0, hint: '' };
  return e;
}

// A PHP numeric literal is a float iff its source text has '.' or an exponent.
function floatish(node) {
  if (node && node.kind === 'number') {
    return /[.eE]/.test(String(node.value));
  }
  if (node && node.kind === 'unary') {
    return floatish(node.what || node.expr || node.operand);
  }
  return false;
}

function txOffsetKey(node) {
  if (!node) return 'null';
  if (node.kind === 'identifier' || node.kind === 'name') return JSON.stringify(String(node.name));
  if (node.kind === 'string') return JSON.stringify(node.value);
  return tx(node);
}

// ---- PHP 8 precedence fix for mixed '.' / '+' / '-' chains (php-parser = PHP 7) ----
const ADDSUB = new Set(['+', '-', '.']);
function flattenMix(node, out) {
  if (node.kind === 'bin' && ADDSUB.has(node.type)) {
    flattenMix(node.left, out);
    out.push(node.type);
    flattenMix(node.right, out);
  } else {
    out.push(node);
  }
}
function txMix(node) {
  const flat = [];
  flattenMix(node, flat);
  const outStack = [];
  const opStack = [];
  const prec = { '.': 1, '+': 2, '-': 2 };
  const apply = () => {
    const op = opStack.pop();
    const b = outStack.pop();
    const a = outStack.pop();
    const fn = op === '.' ? 'rt.concat' : (op === '+' ? 'rt.add' : 'rt.sub');
    outStack.push(fn + '(' + a + ', ' + b + ')');
  };
  for (const it of flat) {
    if (typeof it === 'string') {
      while (opStack.length && prec[opStack[opStack.length - 1]] >= prec[it]) apply();
      opStack.push(it);
    } else {
      outStack.push(tx(it));
    }
  }
  while (opStack.length) apply();
  return outStack[0];
}

// ---- expression translation ----
function tx(node) {
  if (!node) throw mkErr('LW002', 'missing expression', null);
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return String(Number(node.value));
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
    case 'nullkeyword':
      return 'null';
    case 'name':
      throw mkErr('LW002', 'bare identifier not allowed: ' + node.name, node.loc);
    case 'identifier':
      return JSON.stringify(String(node.name));
    case 'variable':
      return vname(node.name);
    case 'encapsed': {
      const parts = node.parts || node.value || [];
      if (!parts.length) return "''";
      let acc = null;
      for (const p of parts) {
        const piece = p.expression ? tx(p.expression) : JSON.stringify(p.value ?? '');
        acc = acc === null ? piece : 'rt.concat(' + acc + ', ' + piece + ')';
      }
      return acc;
    }
    case 'offsetlookup': {
      return tx(node.what) + '[' + txOffsetKey(node.offset) + ']';
    }
    case 'bin':
      return txBin(node);
    case 'unary': {
      const t = node.type;
      const expr = node.what || node.expr || node.argument || node.operand;
      if (t === '!') return 'rt.not(' + tx(expr) + ')';
      if (t === '-') return '(-' + tx(expr) + ')';
      if (t === '+') return '(+' + tx(expr) + ')';
      throw mkErr('LW002', 'unsupported unary ' + t, node.loc);
    }
    case 'post': {
      const op = node.type === '+' ? '++' : '--';
      return tx(node.what) + op;
    }
    case 'pre': {
      const op = node.type === '+' ? '++' : '--';
      return op + tx(node.what);
    }
    case 'retif': {
      const test = tx(node.test);
      if (!node.trueExpr) return '(rt.truthy(' + test + ') ? ' + test + ' : ' + tx(node.falseExpr) + ')';
      return '(rt.truthy(' + test + ') ? ' + tx(node.trueExpr) + ' : ' + tx(node.falseExpr) + ')';
    }
    case 'match': {
      const arms = (node.arms || []).map((a) => {
        const conds = a.conds && a.conds.length ? '[' + a.conds.map(tx).join(', ') + ']' : 'null';
        return '[' + conds + ', () => (' + tx(a.body) + ')]';
      });
      return 'rt.match(' + tx(node.cond) + ', ' + arms.join(', ') + ')';
    }
    case 'isset': {
      const vars = (node.variables || []).map(tx);
      return 'rt.isset(' + vars.join(', ') + ')';
    }
    case 'empty':
      return 'rt.empty(' + tx(node.expression) + ')';
    case 'assign':
      return txAssignExpr(node);
    case 'array': {
      const items = node.items || [];
      const isAssoc = items.some((it) => it.key != null);
      if (isAssoc) {
        const pairs = items.map((it) => txOffsetKey(it.key) + ': ' + tx(it.value));
        return '{' + pairs.join(', ') + '}';
      }
      return '[' + items.map((it) => tx(it.value)).join(', ') + ']';
    }
    case 'call':
      return txCall(node);
    default:
      throw mkErr('LW002', 'unsupported expression kind ' + node.kind, node.loc);
  }
}

function txBin(node) {
  const t = node.type;
  const L = () => tx(node.left);
  const R = () => tx(node.right);
  // php-parser uses PHP 7 precedence where '.' sits at the same level as '+'/'-'.
  // PHP 8 lowered '.' below '+'/'-'; re-associate mixed chains to match PHP 8 bytes.
  if (t === '.' || t === '+' || t === '-') return txMix(node);
  switch (t) {
    case '??':
      return 'rt.coalesce(' + L() + ', ' + R() + ')';
    case '||':
      return '(' + L() + ' || ' + R() + ')';
    case '&&':
      return '(' + L() + ' && ' + R() + ')';
    case 'or':
      return 'rt.or(() => (' + L() + '), () => (' + R() + '))';
    case 'and':
      return 'rt.and(() => (' + L() + '), () => (' + R() + '))';
    case '==':
      return 'rt.looseEq(' + L() + ', ' + R() + ')';
    case '!=':
      return 'rt.looseNe(' + L() + ', ' + R() + ')';
    case '===':
      return 'rt.strictEq(' + L() + ', ' + R() + ', ' + floatish(node.left) + ', ' + floatish(node.right) + ')';
    case '!==':
      return 'rt.strictNe(' + L() + ', ' + R() + ', ' + floatish(node.left) + ', ' + floatish(node.right) + ')';
    case '<':
      return 'rt.lt(' + L() + ', ' + R() + ')';
    case '>':
      return 'rt.gt(' + L() + ', ' + R() + ')';
    case '<=':
      return 'rt.lte(' + L() + ', ' + R() + ')';
    case '>=':
      return 'rt.gte(' + L() + ', ' + R() + ')';
    case '+':
      return 'rt.add(' + L() + ', ' + R() + ')';
    case '-':
      return 'rt.sub(' + L() + ', ' + R() + ')';
    case '*':
      return 'rt.mul(' + L() + ', ' + R() + ')';
    case '/':
      return 'rt.div(' + L() + ', ' + R() + ')';
    case '%':
      return 'rt.mod(' + L() + ', ' + R() + ')';
    case '**':
      return 'rt.pow(' + L() + ', ' + R() + ')';
    default:
      throw mkErr('LW002', 'unsupported operator ' + t, node.loc);
  }
}

// function table is injected by `transpile` (module-level, per-parse)
let FUNCS = new Set();

function txCall(node) {
  const args = (node.arguments || []).map(tx).join(', ');
  const what = node.what;
  if (what.kind === 'name') {
    const name = what.name;
    if (name === 'app') {
      if ((node.arguments || []).length === 0) return 'rt.app()';
      return 'rt.app(' + args + ')';
    }
    const whitelisted = new Set(['e', 'str_replace', 'config', 'public_path', 'file_exists', 'url', 'route', 'auth']);
    const builtins = new Set([
      'isset', 'empty', 'unset', 'count', 'in_array', 'implode', 'explode',
      'sprintf', 'strtolower', 'strtoupper', 'trim', 'number_format', 'nl2br',
    ]);
    if (whitelisted.has(name) || builtins.has(name)) return 'rt.' + name + '(' + args + ')';
    if (FUNCS.has(name)) return fname(name) + '(' + args + ')';
    throw mkErr('LW001', 'unknown function ' + name, node.loc);
  }
  if (what.kind === 'staticlookup') {
    const cls = what.what && what.what.name;
    const meth = what.offset && what.offset.name;
    if (cls === 'Route' && meth === 'has') return 'rt.Route.has(' + args + ')';
    throw mkErr('LW003', 'unknown class/static ' + cls + '::' + meth, node.loc);
  }
  if (what.kind === 'propertylookup') {
    const obj = tx(what.what);
    const meth = what.offset && what.offset.name;
    if (!meth) throw mkErr('LW002', 'property access without method', node.loc);
    return obj + '.' + meth + '(' + args + ')';
  }
  if (what.kind === 'call') {
    return tx(what) + '(' + args + ')';
  }
  throw mkErr('LW002', 'unsupported call target', node.loc);
}

function txAssignExpr(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  if (left.kind === 'variable') {
    const v = vname(left.name);
    if (op === '=') return '(' + v + ' = ' + right + ')';
    if (op === '??=') return 'rt.coalesceAssign(() => (' + v + '), (x) => { ' + v + ' = x; }, ' + right + ')';
    const base = op.slice(0, -1);
    const helper = { '+': 'rt.add', '-': 'rt.sub', '.': 'rt.concat', '*': 'rt.mul', '/': 'rt.div', '%': 'rt.mod', '**': 'rt.pow' }[base];
    if (helper) return '(' + v + ' = ' + helper + '(' + v + ', ' + right + '))';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'offsetlookup') {
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return '(' + target + ' = ' + right + ')';
    if (op === '??=') return 'rt.coalesceAssign(() => (' + target + '), (x) => { ' + target + ' = x; }, ' + right + ')';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
}

function txAssignStatement(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  if (left.kind === 'variable') {
    const v = vname(left.name);
    if (op === '=') return v + ' = ' + right + ';';
    if (op === '??=') return 'if (' + v + ' === null || ' + v + ' === undefined) { ' + v + ' = ' + right + '; }';
    const base = op.slice(0, -1);
    const helper = { '+': 'rt.add', '-': 'rt.sub', '.': 'rt.concat', '*': 'rt.mul', '/': 'rt.div', '%': 'rt.mod', '**': 'rt.pow' }[base];
    if (helper) return v + ' = ' + helper + '(' + v + ', ' + right + ');';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'offsetlookup') {
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return target + ' = ' + right + ';';
    if (op === '??=') return 'if (' + target + ' === null || ' + target + ' === undefined) { ' + target + ' = ' + right + '; }';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
}

// ---- statement translation ----
function childStatements(node) {
  if (!node) return [];
  if (node.kind === 'block') return node.children || [];
  return [node];
}

function walkChildren(children, lines, indent, ctx) {
  for (const node of (children || [])) {
    walkStatement(node, lines, indent, ctx);
  }
}

function walkStatement(node, lines, indent, ctx) {
  switch (node.kind) {
    case 'inline':
      lines.push(indent + 'rt.echo(' + JSON.stringify(node.value) + ');');
      break;
    case 'echo':
      for (const expr of (node.expressions || [])) lines.push(indent + 'rt.echo(' + tx(expr) + ');');
      break;
    case 'block':
      walkChildren(node.children || [], lines, indent, ctx);
      break;
    case 'expressionstatement':
      if (node.expression && node.expression.kind === 'assign') lines.push(indent + txAssignStatement(node.expression));
      else lines.push(indent + tx(node.expression || node) + ';');
      break;
    case 'if':
      lines.push(indent + 'if (rt.truthy(' + tx(node.test) + ')) {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      if (node.alternate || node.shortForm) {
        const alt = node.alternate;
        if (alt && alt.kind === 'if') {
          lines.push(indent + '} else if (rt.truthy(' + tx(alt.test) + ')) {');
          walkChildren(childStatements(alt.body), lines, indent + '  ', ctx);
          let cur = alt;
          while (cur.alternate) {
            const a = cur.alternate;
            if (a.kind === 'if') {
              lines.push(indent + '} else if (rt.truthy(' + tx(a.test) + ')) {');
              walkChildren(childStatements(a.body), lines, indent + '  ', ctx);
              cur = a;
            } else {
              lines.push(indent + '} else {');
              walkChildren(childStatements(a), lines, indent + '  ', ctx);
              cur = a;
              break;
            }
          }
        } else if (alt && (alt.kind === 'block' || alt.children)) {
          lines.push(indent + '} else {');
          walkChildren(childStatements(alt), lines, indent + '  ', ctx);
        } else if (alt) {
          lines.push(indent + '} else {');
          walkChildren(childStatements(alt), lines, indent + '  ', ctx);
        }
      }
      lines.push(indent + '}');
      break;
    case 'while':
      lines.push(indent + 'while (rt.truthy(' + tx(node.test) + ')) {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '}');
      break;
    case 'do':
      lines.push(indent + 'do {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '} while (rt.truthy(' + tx(node.test) + '));');
      break;
    case 'for': {
      const ctx2 = ctx || {};
      const init = (node.init || []).map(tx).join(', ');
      const test = (node.test || []).length ? 'rt.truthy(' + tx(node.test[0]) + ')' : 'true';
      const incr = (node.increment || []).map(tx).join(', ');
      lines.push(indent + 'for (' + init + '; ' + test + '; ' + incr + ') {');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx2);
      lines.push(indent + '}');
      break;
    }
    case 'foreach': {
      const tmp = '__e' + (walkStatement._n = (walkStatement._n || 0) + 1);
      lines.push(indent + 'for (const ' + tmp + ' of rt.entries(' + tx(node.source) + ')) {');
      if (node.key) lines.push(indent + '  ' + tx(node.key) + ' = ' + tmp + '[0];');
      lines.push(indent + '  ' + tx(node.value) + ' = ' + tmp + '[1];');
      walkChildren(childStatements(node.body), lines, indent + '  ', ctx);
      lines.push(indent + '}');
      break;
    }
    case 'switch': {
      const label = '__sw' + (walkStatement._sw = (walkStatement._sw || 0) + 1);
      const cases = childStatements(node.body);
      lines.push(indent + label + ': {');
      lines.push(indent + '  const ' + label + '_v = ' + tx(node.test) + ';');
      const realCases = cases.filter((c) => c.kind === 'case' && c.test);
      const defaults = cases.filter((c) => c.kind === 'case' && !c.test);
      lines.push(indent + '  let ' + label + '_run = false;');
      lines.push(indent + '  let ' + label + '_hit = false;');
      for (const c of realCases) {
        lines.push(indent + '  if (rt.looseEq(' + label + '_v, ' + tx(c.test) + ')) ' + label + '_hit = true;');
      }
      const inner = { ...(ctx || {}), breakLabel: label };
      for (const c of cases) {
        if (c.kind !== 'case') continue;
        const cond = c.test ? 'rt.looseEq(' + label + '_v, ' + tx(c.test) + ')' : ('!' + label + '_hit');
        lines.push(indent + '  if (' + label + '_run || ' + cond + ') {');
        lines.push(indent + '    ' + label + '_run = true;');
        walkChildren(childStatements(c.body), lines, indent + '    ', inner);
        lines.push(indent + '  }');
      }
      lines.push(indent + '}');
      break;
    }
    case 'break':
      if (ctx && ctx.breakLabel) lines.push(indent + 'break ' + ctx.breakLabel + ';');
      else lines.push(indent + 'break;');
      break;
    case 'continue':
      lines.push(indent + 'continue;');
      break;
    case 'return':
      lines.push(indent + 'return ' + (node.expr ? tx(node.expr) : '') + ';');
      break;
    case 'function': {
      const nm = fname(node.name && node.name.name ? node.name.name : node.name);
      const params = (node.arguments || []).map((p) => {
        const pn = vname(p.name && p.name.name ? p.name.name : p.name);
        return p.value ? pn + ' = ' + tx(p.value) : pn;
      });
      lines.push(indent + 'function ' + nm + '(' + params.join(', ') + ') {');
      walkChildren(childStatements(node.body), lines, indent + '  ', {});
      lines.push(indent + '}');
      break;
    }
    case 'nop':
      break;
    default:
      throw mkErr('LW002', 'unsupported construct: ' + node.kind, node.loc);
  }
}

// ---- pre-scan: collect user functions and variables ----
function collect(node, funcs, vars) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collect(n, funcs, vars); return; }
  if (node.kind === 'function' && node.name) {
    const nm = node.name.name || node.name;
    if (nm) funcs.add(String(nm));
  }
  if (node.kind === 'variable' && node.name) vars.add(vname(node.name));
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    collect(node[k], funcs, vars);
  }
}

export function transpile(compiledSource) {
  let ast;
  try {
    ast = phpParser.parseCode(compiledSource);
  } catch (e) {
    return { code: null, errors: [{ code: 'LW004', message: 'parse error: ' + (e.message || e), line: 0, column: 0, hint: '' }] };
  }
  if (ast.errors && ast.errors.length) {
    const errors = ast.errors.map((er) => ({
      code: 'LW004',
      message: String(er.msg || er.message || er),
      line: er.loc?.start?.line ?? 0,
      column: er.loc?.start?.column ?? 0,
      hint: '',
    }));
    return { code: null, errors };
  }

  const funcs = new Set();
  const vars = new Set();
  collect(ast.children || [], funcs, vars);
  FUNCS = funcs;

  const lines = [];
  lines.push('export default function main(rt) {');
  if (vars.size) lines.push('  let ' + Array.from(vars).join(', ') + ';');
  try {
    walkChildren(ast.children || [], lines, '  ', {});
  } catch (e) {
    const lw = e.lw || { code: 'LW002', message: e.message, line: 0, column: 0, hint: '' };
    return { code: null, errors: [lw] };
  }
  lines.push('}');

  const code = lines.join('\n') + '\n';
  return { code, errors: [] };
}

export default transpile;
