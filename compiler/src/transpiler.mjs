// compiler/src/transpiler.mjs
import parser from 'php-parser';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

const BINOPS = {
  '||': '||', 'or': '||',
  '&&': '&&', 'and': '&&',
  '.': '+',
  '==': '===', '!=': '!==', '===': '===', '!==': '!==',
  '<': '<', '>': '>', '<=': '<=', '>=': '>=',
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%',
};

function mkErr(code, message, loc) {
  const e = new Error(message);
  e.lw = { code, message, line: loc?.start?.line ?? 0, column: loc?.start?.column ?? 0, hint: '' };
  return e;
}

function tx(node) {
  if (!node) throw mkErr('LW002', 'missing expression', null);
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return String(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
    case 'nullkeyword':
      return 'null';
    case 'name': {
      // bare identifier as value — not allowed in M1 (no variables/constants)
      throw mkErr('LW002', 'bare identifier not allowed: ' + node.name, node.loc);
    }
    case 'variable': {
      // $x -> x (but M1 welcome has none; support anyway as var)
      return String(node.name).replace(/^\\$/, '');
    }
    case 'bin': {
      if (node.type === '.') return 'rt.concat(' + tx(node.left) + ', ' + tx(node.right) + ')';
      if (node.type === '+') return 'rt.add(' + tx(node.left) + ', ' + tx(node.right) + ')';
      const op = BINOPS[node.type];
      if (!op) throw mkErr('LW002', 'unsupported operator ' + node.type, node.loc);
      return '(' + tx(node.left) + ' ' + op + ' ' + tx(node.right) + ')';
    }
    case 'unary': {
      const t = node.type;
      const op = t === '!' ? '!' : (t === '-' ? '-' : (t === '+' ? '+' : null));
      if (!op) throw mkErr('LW002', 'unsupported unary ' + t, node.loc);
      const expr = node.what || node.expr || node.argument || node.operand;
      return op + tx(expr);
    }
    case 'call':
      return txCall(node);
    case 'array': {
      const items = node.items || [];
      const isAssoc = items.some((it) => it.key != null);
      if (isAssoc) {
        const pairs = items.map((it) => {
          const keyStr = it.key && it.key.kind === 'string' ? JSON.stringify(it.key.value) : (it.key ? tx(it.key) : 'null');
          return keyStr + ': ' + tx(it.value);
        });
        return '{' + pairs.join(', ') + '}';
      }
      return '[' + items.map((it) => tx(it.value)).join(', ') + ']';
    }
    default:
      throw mkErr('LW002', 'unsupported expression kind ' + node.kind, node.loc);
  }
}

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
    const builtins = new Set(['isset', 'empty', 'unset', 'count', 'in_array', 'implode', 'explode', 'sprintf', 'strtolower', 'strtoupper', 'trim']);
    if (whitelisted.has(name) || builtins.has(name)) {
      return 'rt.' + name + '(' + args + ')';
    }
    throw mkErr('LW001', 'unknown function ' + name, node.loc);
  }
  if (what.kind === 'staticlookup') {
    const cls = what.what && what.what.name;
    const meth = what.offset && what.offset.name;
    if (cls === 'Route' && meth === 'has') {
      return 'rt.Route.has(' + args + ')';
    }
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

function walkChildren(children, lines, indent) {
  for (const node of (children || [])) {
    if (node.kind === 'inline') {
      lines.push(indent + 'rt.echo(' + JSON.stringify(node.value) + ');');
    } else if (node.kind === 'echo') {
      for (const expr of (node.expressions || [])) {
        lines.push(indent + 'rt.echo(' + tx(expr) + ');');
      }
    } else if (node.kind === 'if') {
      lines.push(indent + 'if (' + tx(node.test) + ') {');
      walkChildren(node.body && node.body.children ? node.body.children : [], lines, indent + '  ');
      if (node.alternate) {
        if (node.alternate.kind === 'if') {
          lines.push(indent + '} else {');
          walkChildren([node.alternate], lines, indent + '  ');
        } else {
          lines.push(indent + '} else {');
          walkChildren(node.alternate.children || [], lines, indent + '  ');
        }
      }
      lines.push(indent + '}');
    } else if (node.kind === 'block') {
      walkChildren(node.children || [], lines, indent);
    } else if (node.kind === 'expressionstatement') {
      if (node.expression && node.expression.kind === 'assign') {
        lines.push(indent + txAssign(node.expression));
      } else {
        lines.push(indent + tx(node.expression || node) + ';');
      }
    } else if (node.kind === 'return') {
      lines.push(indent + 'return ' + (node.expr ? tx(node.expr) : '') + ';');
    } else {
      throw mkErr('LW002', 'unsupported construct: ' + node.kind, node.loc);
    }
  }
}

function txAssign(node) {
  const left = node.left;
  const right = tx(node.right);
  if (left.kind === 'variable') {
    const v = String(left.name).replace(/^\\$/, '');
    const op = node.operator || '=';
    if (op !== '=') {
      const baseOp = op.slice(0, -1);
      if (baseOp === '.') return 'var ' + v + ' = rt.concat(' + v + ', ' + right + ');';
      if (baseOp === '+') return 'var ' + v + ' = rt.add(' + v + ', ' + right + ');';
      const jsOp = BINOPS[baseOp] || baseOp;
      return 'var ' + v + ' = (' + v + ' ' + jsOp + ' ' + right + ');';
    }
    return 'var ' + v + ' = ' + right + ';';
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
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

  const lines = [];
  lines.push('export default function main(rt) {');
  try {
    walkChildren(ast.children || [], lines, '  ');
  } catch (e) {
    const lw = e.lw || { code: 'LW002', message: e.message, line: 0, column: 0, hint: '' };
    return { code: null, errors: [lw] };
  }
  lines.push('}');

  const code = lines.join('\n') + '\n';
  return { code, errors: [] };
}

export default transpile;
