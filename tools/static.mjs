// tools/static.mjs — pure-JS replacements for the build-time PHP dump tools.
//
// Path B ("zero wait"): read the app's OWN PHP source with php-parser instead
// of booting Laravel inside a PHP process, so the build needs no composer
// install, no vendor download, no PHP interpreter for these tools. Each
// exported function emits exactly the JSON the PHP tool it replaced did.
//
// Version-sensitivity is contained here: bootstrap/app.php has two shapes
// (Laravel 9/10 vs 11+), and every parser branches on the version detected
// from composer.json. A repo whose version cannot be detected falls back to
// the current PHP boot (the caller decides).

import parser from 'php-parser';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { slug as phpSlug, ascii as phpAscii, str as kernelStr } from '../kernel/str.mjs';
import {
  phpFuncs,
  PHP_CONSTANTS,
  PHP_CONSTANTS_REFUSED,
  PHP_REFUSED,
  phpBool,
  phpTrim,
  phpStr as phpStrShared,
  phpNumberLiteral,
  phpBinaryOp,
  phpUnaryOp,
  phpIntCast,
  phpFloatCast,
  phpStringCast,
  phpArrayCast,
  isPhpArrayValue,
  phpIdentical,
  FoldRefusal,
} from './php-funcs.mjs';
import { makeClosure, runConfigStatements } from './config-script.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

/**
 * Parse PHP source into an AST with the SHARED php-parser instance (3.x).
 * Exported for the dump tools that need the raw tree (event-dump.mjs walks
 * provider files for bind()/singleton()); it replaces the old
 * `require.presolve.parserClass`, which is undefined in ESM.
 */
// PHP 8.0 lowered `.` BELOW `+ - << >>` in the precedence table ("the
// concatenation operator now has a lower precedence than arithmetic"), and
// php-parser 3.7 still nests the PHP 7 tree: `1 . 2 + 3` parses as
// `(1 . 2) + 3`, so the fold answered the integer 15 where PHP 8 answers the
// string '15' — a silent wrong config value, with no drop and no note.
// `compiler/src/transpiler.mjs` re-associates its own expression tree with the
// same PHP 8 rule for the operators it compiles (`. + -`, `txMix()`), so the two
// sides agree wherever both work. The shift operators are fold-only: the
// transpiler refuses `<<`/`>>` outright ("unsupported operator"), which is loud
// and therefore safe; the config fold still has to answer them exactly.
//
// php-parser also gives up the source's parentheses (`(1 . 2) + 3` and
// `1 . (2 + 3)` parse to the SAME tree), so a hand-parenthesised mixed chain is
// grouped by this rule too: the PHP 8 reading of the bare form. PHP only
// accepts the other grouping when the concatenation is itself numeric
// (`('5' . $x) + 1`), which the rule below still answers with PHP's own
// arithmetic (the concat is numeric, so `+` coerces it).
const MIXED_CHAIN_PREC = { '.': 1, '+': 2, '-': 2, '<<': 3, '>>': 3 };

/**
 * Re-associate every unparenthesised `.`/`+`/`-`/`<<`/`>>` chain in a
 * php-parser AST to PHP 8's precedence (`.` loosest, then `+ -`, then
 * `<< >>`). Mutates and returns the tree.
 */
export function renestMixedChains(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.kind === 'bin' && MIXED_CHAIN_PREC[node.type] !== undefined) {
    const parts = [];
    (function flat(n) {
      if (n && n.kind === 'bin' && MIXED_CHAIN_PREC[n.type] !== undefined) {
        flat(n.left);
        parts.push({ op: n.type });
        flat(n.right);
      } else {
        parts.push({ operand: renestMixedChains(n) });
      }
    })(node);
    const vals = [];
    const ops = [];
    const apply = () => {
      const op = ops.pop();
      const b = vals.pop();
      const a = vals.pop();
      // The rebuilt node keeps the original chain's `loc` so a refusal still
      // names the config file and line.
      vals.push({ kind: 'bin', type: op, left: a, right: b, loc: node.loc });
    };
    for (const p of parts) {
      if (p.op) {
        while (ops.length && MIXED_CHAIN_PREC[ops[ops.length - 1]] >= MIXED_CHAIN_PREC[p.op]) apply();
        ops.push(p.op);
      } else {
        vals.push(p.operand);
      }
    }
    while (ops.length) apply();
    return vals[0];
  }
  // `parenthesis` (not emitted by php-parser 3.x, kept for safety) stays opaque
  // to the chain walk above and is only descended into here.
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'parents') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = renestMixedChains(v[i]);
    } else if (v && typeof v === 'object') {
      node[k] = renestMixedChains(v);
    }
  }
  return node;
}

/**
 * The ONE way to parse PHP in this file: the shared php-parser instance, with
 * PHP 8's mixed-chain precedence applied (see renestMixedChains()). Every walk
 * that can reach an expression — the config fold, the facade/route scans,
 * `returnExpr()` — goes through this, so no caller can silently keep php-parser's
 * PHP 7 tree.
 */
function phpParse8(source) {
  return renestMixedChains(phpParser.parseCode(String(source)));
}

export function parsePhpSource(source) {
  return phpParse8(source);
}

/**
 * Detect the Laravel major version of an app from composer.json.
 * @returns {number|null} the major (9..13), or null when undetectable.
 */
export function laravelVersion(appDir) {
  try {
    const composer = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
    const require = composer.require || {};
    const c = require['laravel/framework'] || require['laravel/laravel'] || '';
    const m = String(c).match(/(^|\.)*(\^|~|>=|>)?\s*(\d+)(\.\d+)*/);
    if (m) {
      // `^12` -> 12; `~11.0` -> 11; the FIRST component is the major.
      const major = Number(m[3]);
      if (major >= 1) return major;
    }
  } catch {}
  return null;
}

export const nodeName = (n) => {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name.name === 'string') return n.name.name;
  return '';
};

/**
 * Parse vendor/composer/autoload_psr4.php -> { prefix: [abs dirs..] }.
 * The entries are `'Symfony\\Component\\HttpFoundation\\' => array($vendorDir
 * . '/symfony/http-foundation')` — evaluate the `$vendorDir . '/..'` concat.
 */
function psr4Map(file, vendorDir, appDir) {
  const out = {};
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return out; }
  const ast = phpParse8(src);
  let ret;
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object' || ret) return;
    if (n.kind === 'return') { ret = n.expr; return; }
    for (const k of Object.keys(n)) { if (k === 'parents') continue; walk(n[k]); }
  })(ast);
  const arr = ret && ret.kind === 'array' ? ret : null;
  if (!arr) return out;
  const evalStr = (n) => {
    if (!n) return null;
    if (n.kind === 'string') return n.value;
    if (n.kind === 'concat' || n.kind === 'bin') {
      const l = evalStr(n.left || n.what);
      const r = evalStr(n.right || n.offset);
      if (l === null || r === null) return null;
      return l + r;
    }
    if (n.kind === 'variable') {
      const name = nodeName(n.name);
      if (name === 'vendorDir') return vendorDir;
      if (name === 'baseDir') return appDir;
      return null;
    }
    return null;
  };
  for (const e of (arr.items || [])) {
    if (!e || e.kind !== 'entry' || !e.key) continue;
    const prefix = e.key && e.key.kind === 'string' ? e.key.value : null;
    if (!prefix) continue;
    const val = e.value;
    if (val && val.kind === 'array') {
      const dirs = [];
      for (const d of (val.items || [])) {
        const v = d && d.kind === 'entry' ? d.value : d;
        const s = evalStr(v);
        if (s) dirs.push(s);
      }
      out[prefix] = dirs;
    } else {
      const s = evalStr(val);
      if (s) out[prefix] = [s];
    }
  }
  return out;
}

/**
 * The directories composer maps the `App\` prefix to, as absolute paths, in
 * declaration order. `app/` is the skeleton default; a project may map the
 * prefix elsewhere (`"App\\": "src/"`) or to several dirs (an array).
 * Walkers that used to glob `<appDir>/app` use this so a relocated `App\`
 * keeps its classes discoverable.
 */
export function appPsr4Dirs(appDir) {
  const dirs = [];
  const add = (dir) => {
    if (typeof dir !== 'string' || dir === '') return;
    const abs = resolve(appDir, dir.replace(/[\\/]+$/, ''));
    if (!dirs.includes(abs)) dirs.push(abs);
  };
  try {
    const composer = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
    const map = (composer.autoload && composer.autoload['psr-4']) || {};
    for (const prefix of ['App\\', 'App']) {
      if (!Object.prototype.hasOwnProperty.call(map, prefix)) continue;
      const val = map[prefix];
      if (Array.isArray(val)) val.forEach(add);
      else add(val);
      if (dirs.length) break;
    }
  } catch {
    /* no/unreadable composer.json: fall through to the convention below */
  }
  if (!dirs.length) dirs.push(resolve(appDir, 'app'));
  return dirs;
}

/**
 * Resolve an FQCN to an app source file via composer.json PSR-4 autoload.
 * @returns {string|null} the absolute file path, or null when unmapped
 */
export function classFile(appDir, fqcn) {
  const full = String(fqcn || '').replace(/^\\+/, '');
  if (!full) return null;
  // 1) composer.json mappings (app's own PSR-4) — longest prefix wins.
  const composerPath = join(appDir, 'composer.json');
  let mapping = null;
  try {
    const composer = JSON.parse(readFileSync(composerPath, 'utf8'));
    mapping = composer.autoload || null;
  } catch {}
  const prefixes = (mapping && mapping['psr-4']) || {};
  let best = null;
  for (const [prefix, dirs] of Object.entries(prefixes)) {
    const p = String(prefix).replace(/\\+$/, '') + '\\';
    if (!full.startsWith(p)) continue;
    for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
      const dir = String(d).replace(/[\\/]+$/, '');
      const candidate = join(appDir, dir, full.slice(p.length).replace(/\\/g, '/') + '.php');
      if (best == null || candidate.length > best.length) best = candidate;
    }
  }
  if (best && existsSync(best)) return resolve(best);
  // 2) vendor/composer/autoload_psr4.php (the exact map PHP's autoloader uses).
  // Covers Illuminate\ + Symfony\ + Carbon\ + Psr\... — any vendor namespace.
  // The vendor tree is NOT always `<app>/vendor`: an app with no vendor/ of its
  // own reaches the framework through LW_VENDOR_DIR (vendor-lite's cache, or a
  // vendor mounted elsewhere), and hard-coding `<app>/vendor` here left every
  // vendor FQCN unresolved for those apps (#647). The variable names either the
  // vendor dir itself or a project root holding one — resolve both, the same
  // two layouts the config defaults accept (see the frameworkConfigDir block).
  const vendorDir = [
    process.env.LW_VENDOR_DIR ? resolve(process.env.LW_VENDOR_DIR) : null,
    process.env.LW_VENDOR_DIR ? join(resolve(process.env.LW_VENDOR_DIR), 'vendor') : null,
    join(appDir, 'vendor'),
  ].find((d) => d && existsSync(join(d, 'composer', 'autoload_psr4.php'))) || join(appDir, 'vendor');
  const psr4File = join(vendorDir, 'composer', 'autoload_psr4.php');
  if (existsSync(psr4File)) {
    const map = psr4Map(psr4File, vendorDir, appDir);
    let vbest = null;
    for (const [prefix, dirs] of Object.entries(map)) {
      const p = String(prefix).replace(/\\+$/, '') + '\\';
      if (!full.startsWith(p)) continue;
      for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
        const dir = String(d || '').replace(/[\\/]+$/, '');
        const candidate = join(dir, full.slice(p.length).replace(/\\/g, '/') + '.php');
        if (vbest == null || candidate.length > vbest.length) vbest = candidate;
      }
    }
    if (vbest && existsSync(vbest)) return resolve(vbest);
  }
  // No composer mapping matched — try the conventional App\ -> app/ (and any
  // other dir the composer mapping names) directly.
  if (full.startsWith('App\\')) {
    const rel = full.slice(4).replace(/\\/g, '/') + '.php';
    for (const dir of appPsr4Dirs(appDir)) {
      const fb = join(dir, rel);
      // MUST verify: without this every `App\...` FQCN answered a path, so
      // isAppClass() said true for classes that do not exist and a namespaced
      // global (App\Mail\DateTimeInterface) was treated as an app class.
      if (existsSync(fb)) return resolve(fb);
    }
  }
  return null;
}

/**
 * Parse a PHP file. Returns { namespace, imports, classes, error } — `imports`
 * is short-name -> FQCN from the file-level `use` statements; `classes` holds the
 * class/interface/trait nodes (in source order).
 */
export function parsePhpFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    return { error: 'the class file could not be read: ' + (e.message || e) };
  }
  let ast;
  try {
    ast = renestMixedChains(phpParser.parseCode(source));
  } catch (e) {
    return { error: 'parse error: ' + (e.message || String(e)) };
  }
  if (ast && ast.errors && ast.errors.length) {
    const first = ast.errors[0];
    return { error: 'parse error: ' + (first.msg || first.message || JSON.stringify(first)) };
  }
  let namespace = '';
  const imports = {};
  const classes = [];

  // Separate, non-recursive-into-classes scan for file-level `use` statements.
  // It only descends into usegroup nodes; class/trait/interface bodies are
  // skipped (their `use` statements are closure captures, not imports).
  const findUses = (nodes) => {
    const out = {};
    const stack = [...nodes];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      if (node.kind === 'useitem') {
        const name = nodeName(node.name);
        if (name) {
          const as = node.alias ? nodeName(node.alias) : name.split('\\').pop();
          out[as] = name;
        }
      } else if (node.kind === 'usegroup') {
        stack.push(...(node.items || []));
      } else if (node.kind !== 'class' && node.kind !== 'interface' && node.kind !== 'trait') {
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
          stack.push(node[k]);
        }
      }
    }
    return out;
  };

  // walk() owns class discovery AND recursion; it never delegates its
  // recursion to the use-finder, so no node is visited twice for the same job.
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'namespace') {
      namespace = n.name && typeof n.name === 'object' ? nodeName(n.name) : String(n.name || '');
      Object.assign(imports, findUses(n.children || []));
      for (const c of (n.children || [])) walk(c);
      return;
    }
    if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait') classes.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
      if (k === 'use' || k === 'uses') continue;
      walk(n[k]);
    }
  };
  walk(ast);
  // The program's top-level `use` statements (config files have no namespace).
  if (ast && ast.children) {
    Object.assign(imports, findUses(ast.children));
  }
  return { namespace, imports, classes, source };
}

/** Get the FQCN of the class declared in `parsed` matching `shortOrFqcn`. */
function classFqcn(parsed, clsNode, shortOrFqcn) {
  const ns = parsed.namespace || '';
  const short = shortOrFqcn.split('\\').pop();
  const own = (ns ? ns + '\\' : '') + nodeName(clsNode.name);
  // The caller passes an FQCN; match by short name within the same namespace.
  return own === shortOrFqcn || own.split('\\').pop() === short ? own : null;
}

/**
 * Evaluate a PHP class-constant expression to a scalar, or null (== PHP's
 * "not a scalar" filter). Node kinds follow php-parser 3.x.
 * ctx: { appDir, selfConstants, parsed } — selfConstants is the map of the
 * enclosing class, parsed is the enclosing file's parse result.
 */
export function evalConstantExpr(node, ctx, depth = 0, stack = []) {
  if (depth > 100) return null;
  if (!node) return null;
  const { appDir, parsed } = ctx;
  switch (node.kind) {
    case 'nullkeyword':
    case 'null':
      return null;
    case 'boolean':
      return node.value;
    case 'number':
      // php-parser keeps the RAW literal text, so `Number()` answered 17 for
      // the OCTAL `017` (PHP: 15) and NaN for `1_000` (PHP: 1000) — and a
      // constant's folded value is what a compiled controller reads (#798).
      // `phpNumberLiteral()` is the canon (hex/bin/oct/underscore, and null for
      // an integer outside JSON number safety), the same reader the config fold
      // uses.
      return phpNumberLiteral(node.value);
    case 'string':
      return node.value;
    case 'unary':
      if (node.type === '-' || node.type === '+') {
        const v = evalConstantExpr(node.what, ctx, depth + 1, stack);
        if (typeof v !== 'number') return null;
        return node.type === '-' ? -v : v;
      }
      if (node.type === '!') {
        const v = evalConstantExpr(node.what, ctx, depth + 1, stack);
        // PHP truthiness, not JS: `!'0'` is TRUE (the config path already went
        // through phpBool(), this one still answered JS's `!'0'` = false).
        return v == null ? null : !phpBool(v);
      }
      // `-'5'`, an array literal and every other shape this scalar folder does
      // not know answer null, so `collectConstants()` leaves the constant OUT
      // of the dump and the transpiler refuses the read with LW002 ("class
      // constant X::Y is not available at the edge") - a stopped build, never a
      // wrong value.
      return null;
    case 'bin':
    case 'binary': {
      const l = evalConstantExpr(node.left, ctx, depth + 1, stack);
      if (l === null && !isNullLiteral(node.left)) return null;
      const r = evalConstantExpr(node.right, ctx, depth + 1, stack);
      if (r === null && !isNullLiteral(node.right)) return null;
      const ln = typeof l === 'number';
      const rn = typeof r === 'number';
      switch (node.type) {
        // PHP's `.` casts both operands to string: null -> '', false -> '',
        // true -> '1'. `String(l) + String(r)` answered 'null'/'false'/'true'
        // for `const X = null . 'x'` (a literal null passes the guard above,
        // which only rejects the *unevaluable* null).
        case '.': return phpStr(l) + phpStr(r);
        case '+': return ln && rn ? l + r : null;
        case '-': return ln && rn ? l - r : null;
        case '*': return ln && rn ? l * r : null;
        case '/': return ln && rn && r !== 0 ? l / r : null;
        case '%': return ln && rn && r !== 0 ? l % r : null;
        case '**': return ln && rn ? Math.pow(l, r) : null;
        // PHP's bitwise and shift operators are 64-bit; JS's are 32-bit, so
        // `1 << 40` folded to 256 where PHP answers 1099511627776 (#798). The
        // canon `phpBinaryOp()` (the config fold's own operator table) does
        // them in BigInt and refuses what a 64-bit int cannot hold — a refusal
        // drops the constant (LW002 later) rather than baking a wrong value.
        case '<<':
        case '>>':
        case '&':
        case '|':
        case '^':
          try {
            return phpBinaryOp(node.type, l, r);
          } catch {
            return null;
          }
        default: return null;
      }
    }
    case 'staticlookup': {
      // what: C | selfreference | parentreference | (name)
      // offset: the constant identifier
      const offset = nodeName(node.offset);
      if (!offset) return null;
      const what = node.what;
      if (!what) return null;
      const kind = what.kind;
      const raw = what.raw || what.name || '';
      // self::/static:: — resolve through the enclosing class's map.
      if (kind === 'selfreference' || kind === 'self' || kind === 'static' || raw === 'self' || raw === 'static') {
        const map = ctx.selfConstantsMap || ctx.selfConstants || {};
        return offset in map ? map[offset] : null;
      }
      // A name (possibly FQCN or short): resolve to the target class and
      // evaluate ITS constant.
      if (!raw) return null;
      const target = resolveClassName(raw, what, ctx);
      if (!target) return null;
      const file = classFile(appDir, target);
      if (!file || !existsSync(file)) return null;
      const parsed2 = parsePhpFile(file);
      if (parsed2.error) return null;
      const short = target.split('\\').pop();
      const targetClass = parsed2.classes.find(
        (c) => c.kind === 'class' && c.name && nodeName(c.name) === short
      );
      if (!targetClass) return null;
      const tConstants = collectConstants(appDir, parsed2, targetClass, file);
      return offset in tConstants ? tConstants[offset] : null;
    }
    case 'classconstant':
      return null;
    case 'magic':
      return null;
    case 'array':
      return null;
    default:
      return null;
  }
}

/**
 * The evaluated constants map of a class, following PHP's inheritance
 * (`ReflectionClass::getConstants()`): the class's own constants, its traits
 * (flattened into the class), the interfaces it implements, then the parent
 * chain - each ancestor contributing its own/trait/interface constants.
 * A private constant of an ANCESTOR is NOT part of the child's table (PHP
 * 8.3 verified), while the class's own private ones are.
 * Verified against tools/constants-dump.php: a model answers the inherited
 * `CREATED_AT`/`UPDATED_AT`, `Foo extends Base implements Iface` answers all
 * three, and the PHP tool's scalar filter still drops arrays.
 */
function collectConstants(appDir, parsed, clsNode, file) {
  const sources = [];
  // A PHP file may declare several classes: look in the CURRENT parse first,
  // then fall back to the FQCN -> file lookup.
  const resolveNode = (p, fqcn, seen) => {
    const key = String(fqcn || '');
    const short = key.split('\\').pop();
    const ns = key.includes('\\') ? key.slice(0, key.lastIndexOf('\\')) : null;
    // Same-file lookup ONLY when the namespace matches too - otherwise a
    // parent in another namespace (Model\User -> Foundation\Auth\User) would
    // resolve back to the child itself and the chain would stop there.
    if (short && (ns === null || ns === (p.namespace || ''))) {
      const same = (p.classes || []).find((c) => c && c.name && nodeName(c.name) === short);
      if (same) return { parsed: p, node: same };
    }
    return nodeFor(appDir, fqcn, seen);
  };
  const walkClass = (p, node, allowPrivate, depth, seen) => {
    if (!node || depth > 20) return;
    sources.push({ parsed: p, node, allowPrivate });
    for (const t of traitNamesOf(p, node)) {
      const tgt = resolveNode(p, t, seen);
      if (tgt) walkClass(tgt.parsed, tgt.node, true, depth + 1, seen);
    }
    for (const i of interfaceNamesOf(p, node)) {
      const tgt = resolveNode(p, i, seen);
      if (tgt) walkClass(tgt.parsed, tgt.node, false, depth + 1, seen);
    }
  };
  const seen = new Set();
  walkClass(parsed, clsNode, true, 0, seen);
  // The parent chain (a class, or an interface's own `extends`).
  let p = parsed;
  let node = clsNode;
  for (let depth = 0; depth < 20 && node; depth += 1) {
    const parent = extendsNameOf(p, node);
    if (!parent || seen.has(parent)) break;
    const tgt = resolveNode(p, parent, seen);
    if (!tgt) break;
    seen.add(parent);
    walkClass(tgt.parsed, tgt.node, false, depth + 1, seen);
    p = tgt.parsed;
    node = tgt.node;
  }
  // Merged name set, nearest declaration wins (a child overrides a parent).
  const raw = new Map();
  for (const s of sources) {
    for (const stmt of (s.node.body || [])) {
      if (stmt.kind !== 'classconstant') continue;
      if (!s.allowPrivate && stmt.visibility === 'private') continue;
      for (const c of (stmt.constants || [])) {
        const name = nodeName(c.name);
        if (!name || raw.has(name)) continue;
        raw.set(name, { value: c.value, parsed: s.parsed });
      }
    }
  }
  // Pass 1: literal values, so `self::OTHER` can be resolved in pass 2.
  const selfMap = {};
  for (const [name, rec] of raw) {
    selfMap[name] = evalConstantExpr(rec.value, { appDir, parsed: rec.parsed });
  }
  const out = {};
  for (const [name, rec] of raw) {
    const val = evalConstantExpr(rec.value, {
      appDir, parsed: rec.parsed, selfConstantsMap: selfMap, selfConstants: selfMap,
    });
    if (val === null && !isNullLiteral(rec.value)) continue;
    out[name] = val;
  }
  return out;
}

/** The parsed file + class node for an FQCN (any namespace, app or vendor). */
const nodeFileCache = new Map();
function nodeFor(appDir, fqcn, seen) {
  const key = String(fqcn || '');
  if (!key) return null;
  if (seen && seen.has(key)) return null;
  if (nodeFileCache.has(key)) return nodeFileCache.get(key);
  const file = classFile(appDir, key);
  let result = null;
  if (file && existsSync(file)) {
    const parsed2 = parsePhpFile(file);
    if (!parsed2.error) {
      const short = key.split('\\').pop();
      const node = (parsed2.classes || []).find((c) => c && c.name && nodeName(c.name) === short);
      if (node) result = { parsed: parsed2, node, file };
    }
  }
  nodeFileCache.set(key, result);
  return result;
}

/** The resolved FQCN of a class's `extends` (a class or an interface). */
function extendsNameOf(parsed, node) {
  const e = node.extends;
  if (!e) return null;
  const raw = e.name || e.raw;
  return raw ? resolveClassName(String(raw), e, { parsed }) : null;
}

/** The resolved FQCNs of a class's `use Trait;` statements. */
function traitNamesOf(parsed, node) {
  const out = [];
  for (const stmt of (node.body || [])) {
    if (stmt.kind !== 'traituse') continue;
    for (const t of (stmt.traits || [])) {
      const raw = t.name || t.raw;
      if (raw) out.push(resolveClassName(String(raw), t, { parsed }));
    }
  }
  return out;
}

/** The resolved FQCNs of a class's `implements` interface list. */
function interfaceNamesOf(parsed, node) {
  const out = [];
  for (const i of (node.implements || [])) {
    const raw = i.name || i.raw;
    if (raw) out.push(resolveClassName(String(raw), i, { parsed }));
  }
  return out;
}

function isNullLiteral(node) {
  return node && (node.kind === 'null' || node.kind === 'nullkeyword');
}

function resolveClassName(raw, what, ctx) {
  if (raw.startsWith('\\')) return raw.slice(1);
  if (raw.includes('\\')) return raw;
  const parsed = ctx.parsed;
  if (parsed && parsed.imports && raw in parsed.imports) return parsed.imports[raw];
  if (parsed && parsed.namespace) return parsed.namespace + '\\' + raw;
  return raw;
}

/**
 * All class constants of ONE class node, evaluated. Mirrors the PHP tool:
 * entries are scalars or null; a non-evaluable expression is DROPPED (the PHP
 * tool's `is_scalar` filter) but never guessed.
 */
// ---------------------------------------------------------------------------
// bootstrap/app.php -> the middleware configurator state (Laravel 11+ shape)
// ---------------------------------------------------------------------------

/** Is this an argument list entry with a given name (`except:`)? */
const argByName = (args, name) => {
  for (const a of (args || [])) {
    if (a && a.kind === 'argument' && a.name === name) return a.value || a.expr || a;
  }
  return null;
};

/** One literal string node -> its value (null when the literal is not a string). */
function oneString(node) {
  if (!node) return null;
  if (node.kind === 'string') return node.value;
  if (node.kind === 'stringliteral' && typeof node.value === 'string') return node.value;
  return null;
}
const isArrayNode = (node) => !!node && (node.kind === 'array' || node.kind === 'arrayexpression');
/** The item nodes of an array literal (php-parser's `entry` wrappers unwrapped). */
function arrayItems(node) {
  return (node.items || []).map((e) => (e && e.kind === 'entry' ? e.value : e));
}
/** String array literal -> JS array of strings (a static `except: [...]`). */
function stringArray(node) {
  const v = argValue(node);
  if (!isArrayNode(v)) return null;
  const out = [];
  for (const item of arrayItems(v)) {
    const one = oneString(item);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

/** The name of a class-referencing argument node (`[\X\Y::class]` -> 'X\Y'). */
function classListOf(node) {
  const v = argValue(node);
  if (!isArrayNode(v)) return null;
  const out = [];
  for (const item of arrayItems(v)) {
    const raw = (item && item.what && (item.what.raw || item.what.name)) || '';
    const name = raw.replace(/^\\+/, '');
    if (!name) return null;
    out.push(name);
  }
  return out;
}

/** The method name of a `->method(...)` OR `Class::method(...)` call node. */
export const callMethodName = (n) => {
  if (!n || n.kind !== 'call' || !n.what) return null;
  const w = n.what;
  if (w.kind !== 'propertylookup' && w.kind !== 'staticlookup') return null;
  const off = w.offset;
  return (off && (off.name || off.value)) || null;
};

export const callArgs = (n) => (n && n.arguments && n.arguments.length ? n.arguments : (n && n.args) || []);

export const argValue = (a) => {
  if (!a) return null;
  if (a.kind === 'namedargument') return a.value || a.expr || null;
  if (a.kind === 'argument') return a.value || a.expr || a || null;
  return a;
};

/**
 * A closure OR an arrow function. `php-parser` gives them different kinds
 * (`closure` / `arrowfunc`) and a different body shape, and both are legal
 * everywhere Laravel takes a callback: a route handler
 * (`Route::get('/x', fn () => view('x'))`), a route group
 * (`Route::prefix('x')->group(fn () => ...)`) and the boot callbacks in
 * bootstrap/app.php (`->withMiddleware(fn (Middleware $m) => ...)`). Reading
 * only `closure` silently DROPS every arrow-function route from the edge build
 * (measured on Laravel 13.37: the route answered 404 on the edge where PHP
 * answered 200, and the build reported it as "defined outside routes/").
 */
export const isClosureFn = (v) =>
  !!v && (v.kind === 'closure' || v.kind === 'arrowfunc' || v.kind === 'arrowfunction');

/**
 * The STATEMENT LIST of a closure/arrow-function body. A `function () {...}`
 * has a block (`body.children`); a `fn () => $expr` has the expression itself,
 * so it becomes ONE synthetic expression statement - the shape the statement
 * walkers already consume.
 */
export const closureStatements = (fn) => {
  const body = fn && fn.body;
  if (!body) return null;
  if (Array.isArray(body.children)) return body.children;
  return [{ kind: 'expressionstatement', expression: body }];
};

/**
 * Extract the middleware configurator state from bootstrap/app.php (Laravel
 * 11+ `->withMiddleware(...)` shape). Returns:
 *   { cookiesExcept, csrfExcept, allowSameSite, originOnly, globalMiddleware,
 *     trimConfigured, emptyConfigured, transformers }
 * Unknown/unparseable calls are skipped (the app gets default state), never
 * guessed. For Laravel 9/10 the middleware callbacks live on the Kernel
 * classes; this returns null and the caller uses the defaults.
 */
export function appMiddlewareState(appDir, report = {}) {
  let failure = null;
  const bootFile = join(appDir, 'bootstrap', 'app.php');
  if (!existsSync(bootFile)) {
    // Laravel 9/10 keep the middleware on the Kernel classes instead of
    // bootstrap/app.php `->withMiddleware(...)`; that shape is not read here.
    // The defaults are the honest answer here: an app without a
    // bootstrap/app.php has no `->withMiddleware(...)` state to read.
    return null;
  }
  // An UNREADABLE bootstrap/app.php is not "no middleware" (the app's global
  // stack may replace TrimStrings, drop the CSRF, ...): it is a refusal.
  const parsed = parsePhpFile(bootFile);
  if (parsed.error) {
    failure = 'cannot parse bootstrap/app.php: ' + (parsed.error && parsed.error.message ? parsed.error.message : parsed.error);
    return null;
  }

  const state = {
    cookiesExcept: [],
    csrfExcept: [],
    allowSameSite: false,
    originOnly: false,
    globalMiddleware: [],
    // `TrimStrings::skipWhen()` / `ConvertEmptyStringsToNull::skipWhen()` seen
    // as static calls anywhere in the file (a transformer that skips a request
    // cannot be modelled; the spec says so).
    trimSkipConfigured: false,
    emptySkipConfigured: false,
    trimExcept: [],
    trimExceptUnreadable: false,
    transformers: null,
  };

  // Find `->withMiddleware(closure)`, then each `$x->method(...)` in the
  // closure's block.
  const walker = (n) => {
    if (Array.isArray(n)) { n.forEach(walker); return; }
    if (!n || typeof n !== 'object') return;
    if (callMethodName(n) === 'withMiddleware') {
      const closure = callArgs(n).map(argValue).find(isClosureFn);
      const statements = closureStatements(closure);
      if (statements) {
        for (const st of statements) {
          if (st && st.kind === 'expressionstatement' && st.expression) {
            const verdict = applyConfigCall(st.expression, state);
            if (verdict) {
              failure = verdict;
              return;
            }
            // The transformer CONFIGURATION does not live on the `->withMiddleware()`
            // chain in this walk: `->trimStrings()` / `->convertEmptyStringsToNull()`
            // are handled inside applyConfigCall (see transformerSpec), and the
            // facade calls (`TrimStrings::except()`, `::skipWhen()`) are read
            // from the whole file below.
          }
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
      walker(n[k]);
    }
  };
  const ast = phpParse8(parsed.source);
  walker(ast);
  // The facade calls the app makes anywhere in the file: `TrimStrings::except()`
  // and `::skipWhen()` write STATIC state on the middleware class (vendor
  // TrimStrings.php:90-106), so they do not live in the `->withMiddleware()`
  // chain. `ConvertEmptyStringsToNull::skipWhen()` is the same (vendor :52-55).
  scanTransformerFacades(ast, state);
  if (failure !== null) {
    report.failure = failure;
    return state;
  }
  // The request-input transformer spec: the app's static calls on
  // TrimStrings/ConvertEmptyStringsToNull start it, a `->use()` list fixes the
  // global stack (Illuminate\Foundation\Configuration\Middleware::use()).
  const spec = transformerSpec(ast, state, phpParser);
  if (spec.refusal) report.failure = spec.refusal;
  state.transformers = spec;
  return state;
}

/** Returns a refusal message when the call cannot be read faithfully. */
function applyConfigCall(expr, state) {
  const name = callMethodName(expr);
  if (!name) return null;
  const args = callArgs(expr);
  const named = (n) => {
    for (const a of args) if (a && a.kind === 'namedargument' && a.name === n) return argValue(a);
    return null;
  };
  switch (name) {
    case 'encryptCookies': {
      const list = stringArray(named('except'));
      if (list) state.cookiesExcept = list;
      break;
    }
    case 'validateCsrfTokens':
    case 'preventRequestForgery': {
      const list = stringArray(named('except'));
      if (list) state.csrfExcept = list;
      const oo = named('originOnly');
      if (oo && oo.kind === 'boolean') state.originOnly = oo.value;
      const as = named('allowSameSite');
      if (as && as.kind === 'boolean') state.allowSameSite = as.value;
      break;
    }
    case 'use': {
      // `->use()` REPLACES the global stack (Ml 231-236). Only the fact that the
      // app configured a replacement is recorded here; transformerSpec replays
      // the whole call set against the vendor rules.
      const v = named('middleware') || argValue(args[0]);
      if (classListOf(v) === null) {
        return 'bootstrap/app.php: `->use(middleware: [...])` holds an entry the build cannot read statically - the compiled rung cannot tell which middlewares run; add a port';
      }
      break;
    }
    case 'trimStrings': {
      // Middleware::trimStrings(array $except) (Ml 656-670): Closures become
      // `TrimStrings::skipWhen()` (per-request), strings go to
      // `TrimStrings::except()` (a STATIC list, so calls accumulate).
      const split = splitClosuresAndStrings(argValue(args[0]));
      if (split === null) return REFUSE_TRIM('->trimStrings([...])');
      state.trimSkipConfigured = state.trimSkipConfigured || split.closures > 0;
      state.trimExcept = [...state.trimExcept, ...split.strings];
      break;
    }
    case 'convertEmptyStringsToNull': {
      // Middleware::convertEmptyStringsToNull(array $except) (Ml 645-653): every
      // entry is typed `Closure`; a string there raises a TypeError in PHP, never
      // a key list, so a literal entry is an app bug the build refuses.
      const split = splitClosuresAndStrings(argValue(args[0]));
      if (split === null) return REFUSE_TRIM('->convertEmptyStringsToNull([...])');
      if (split.strings.length) {
        return 'bootstrap/app.php: `->convertEmptyStringsToNull([...])` holds a non-Closure entry (the vendor signature is array<int, Closure>); the compiled rung cannot read it; add a port';
      }
      state.emptySkipConfigured = state.emptySkipConfigured || split.closures > 0;
      break;
    }
    default:
      break;
  }
  return null;
}
const REFUSE_TRIM = (call) =>
  'bootstrap/app.php: `' + call + '` holds an entry the build cannot read statically (a closure skip-when callback) - the compiled rung would trim/convert a different set of fields; add a port';
/**
 * `Middleware::trimStrings()`'s array: Closures (a per-request skip) and string
 * keys (the skip list). Any other node is unreadable -> null.
 */
function splitClosuresAndStrings(arg) {
  const v = argValue(arg);
  if (v === null || v === undefined) return { closures: 0, strings: [] };
  if (!isArrayNode(v)) return null;
  let closures = 0;
  const strings = [];
  for (const item of arrayItems(v)) {
    if (!item) return null;
    if (item.kind === 'closure' || item.kind === 'arrowfunc' || item.kind === 'arrowfunction') { closures += 1; continue; }
    const one = oneString(item);
    if (one === null) return null;
    strings.push(one);
  }
  return { closures, strings };
}

/**
 * The framework's DEFAULT global middleware
 * (Illuminate\Foundation\Configuration\Middleware::getGlobalMiddleware(),
 * Middleware.php:120-141), as the build sees it. Anything here that the compiled
 * rung does not implement is reported (config `middleware.prevented`).
 */
export const FRAMEWORK_GLOBAL_MIDDLEWARE = [
  'Illuminate\\Http\\Middleware\\ValidatePathEncoding',
  'Illuminate\\Foundation\\Http\\Middleware\\InvokeDeferredCallbacks',
  'Illuminate\\Http\\Middleware\\TrustHosts',
  'Illuminate\\Http\\Middleware\\TrustProxies',
  'Illuminate\\Http\\Middleware\\HandleCors',
  'Illuminate\\Foundation\\Http\\Middleware\\PreventRequestsDuringMaintenance',
  'Illuminate\\Http\\Middleware\\ValidatePostSize',
  'Illuminate\\Foundation\\Http\\Middleware\\TrimStrings',
  'Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull',
];
const TRIM_STRINGS = 'Illuminate\\Foundation\\Http\\Middleware\\TrimStrings';
/** `TrimStrings::$except` (vendor TrimStrings.php:16-20). */
export const FRAMEWORK_TRIM_EXCEPT = ['current_password', 'password', 'password_confirmation'];
/**
 * The global middleware kernel/http.mjs reproduces itself: the two input
 * transformers it runs (see buildRequest), the deferred callbacks the app never
 * observes on a request path, and the path validator the edge cannot run (the
 * platform decodes the path before the worker sees it).
 */
export const MW_IMPLEMENTED_BY_KERNEL = new Set([
  'TrimStrings',
  'ConvertEmptyStringsToNull',
  'InvokeDeferredCallbacks',
  'ValidatePathEncoding',
]);
const EMPTY_TO_NULL = 'Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull';
/**
 * `TrimStrings::except([...])` / `TrimStrings::skipWhen(...)` /
 * `ConvertEmptyStringsToNull::skipWhen(...)` anywhere in the file.
 */
function scanTransformerFacades(ast, state) {
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    // `TrimStrings::except(...)` is a CALL whose `what` is a staticlookup
    // (php-parser's shape), not a `staticcall` node.
    if (n.kind === 'call' && n.what && n.what.kind === 'staticlookup') {
      const clsNode = n.what.what;
      const cls = clsNode && (clsNode.raw || clsNode.name);
      const short = cls ? String(cls).replace(/^\\+/, '').split('\\').pop() : null;
      const method = callMethodName(n);
      const args = callArgs(n);
      if (short === 'TrimStrings' || short === 'ConvertEmptyStringsToNull') {
        if (method === 'skipWhen') {
          if (short === 'TrimStrings') state.trimSkipConfigured = true;
          else state.emptySkipConfigured = true;
        } else if (method === 'except' && short === 'TrimStrings') {
          const list = stringArray(args[0]);
          if (list === null) {
            state.trimExceptUnreadable = true;
          } else {
            state.trimExcept = [...state.trimExcept, ...list];
          }
        }
      }
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
}
/** One entry of a middleware list, as an FQCN (null when the literal is not a class name). */
function middlewareName(v) {
  const node = argValue(v);
  if (!node) return null;
  // `\App\Http\Middleware\Foo::class` -> staticlookup{ what: name, offset: 'class' }
  if (node.kind === 'staticlookup') {
    const cls = node.what && (node.what.raw || node.what.name);
    if (!cls) return null;
    return String(cls).replace(/^\\+/, '');
  }
  if (node.kind === 'string') return node.value;
  return null;
}
/** A `->prepend()`/`->append()`/`->remove()` argument as a list (`array|string`). */
function middlewareList(arg) {
  const v = argValue(arg);
  if (v === null || v === undefined) return [];
  const single = middlewareName(v);
  if (single !== null) return [single];
  if (!isArrayNode(v)) return null;
  const out = [];
  for (const item of arrayItems(v)) {
    const one = middlewareName(item);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}
/**
 * Is `expr` a static call on the TrimStrings / ConvertEmptyStringsToNull facade
 * (`TrimStrings::except([...])`, `TrimStrings::skipWhen(fn () => true)`)?
 */
function isTransformerConfigCall(expr, simpleName) {
  if (!expr || expr.kind !== 'staticcall') return false;
  const cls = expr.class && expr.class.kind === 'name' ? String(expr.class.name) : null;
  if (!cls) return false;
  return cls.split('\\').pop() === simpleName;
}
const sameMiddleware = (a, b) => String(a).split('\\').pop() === String(b).split('\\').pop();
/**
 * The compiled request's transform spec, read from the app's own bootstrap.
 *
 * `Illuminate\Foundation\Configuration\Middleware` does NOT edit one stack:
 *   - `use()` sets `$global` (a REPLACEMENT for the default list, Ml 231-236);
 *   - `prepend()`/`append()`/`remove()` accumulate into `$prepends`/`$appends`/
 *     `$removals` (Ml 169-207), applied in getGlobalMiddleware():
 *     `array_merge($prepends, $middleware, $appends)` minus `$removals` (Ml
 *     460-476);
 *   - `replace($search, $replace)` maps classes (Ml 218-224).
 * so the ORDER OF CALLS does not matter and an `->append(...)` after a `->use()`
 * still applies. `trimStrings(array $except)` (Ml 656-670) partitions its array:
 * Closures become `TrimStrings::skipWhen()` (a per-request skip), strings go to
 * `TrimStrings::except()` (STATIC, so several calls accumulate);
 * `convertEmptyStringsToNull()` takes closures only (Ml 645-653).
 *
 * Returns { trim, emptyToNull, trimExcept } or { refusal } - never a guess.
 */
function transformerSpec(ast, state, phpParser) {
  const edits = { global: null, prepends: [], appends: [], removals: [], replacements: {} };
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (callMethodName(n) === 'withMiddleware') {
      const closure = callArgs(n).map(argValue).find(isClosureFn);
      const statements = closureStatements(closure);
      if (statements) {
        for (const st of statements) {
          if (!st || st.kind !== 'expressionstatement' || !st.expression) continue;
          const name = callMethodName(st.expression);
          if (!name) continue;
          const args = callArgs(st.expression).map(argValue);
          if (name !== 'use' && name !== 'prepend' && name !== 'append' && name !== 'remove' && name !== 'replace') continue;
          edits.calls = (edits.calls || []).concat([{ name, args }]);
        }
      }
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
        if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  const calls = edits.calls || [];
  for (const call of calls) {
    if (call.name === 'use') {
      const list = middlewareList(call.args[0]);
      if (list === null) {
        return { refusal: 'bootstrap/app.php: `->use(middleware: [...])` holds an entry the build cannot read statically - the compiled rung cannot tell which input transformers run; add a port' };
      }
      edits.global = list;
    } else if (call.name === 'replace') {
      const search = middlewareName(call.args[0]);
      const replacement = middlewareName(call.args[1]);
      if (search === null || replacement === null) {
        return { refusal: 'bootstrap/app.php: `->replace(...)` names a middleware the build cannot read statically; add a port' };
      }
      edits.replacements[search] = replacement;
    } else {
      const list = middlewareList(call.args[0]);
      if (list === null) {
        return { refusal: 'bootstrap/app.php: `->' + call.name + '(...)` holds a middleware entry the build cannot read statically; add a port' };
      }
      if (call.name === 'prepend') edits.prepends = [...list, ...edits.prepends];
      else if (call.name === 'append') edits.appends = [...edits.appends, ...list];
      else edits.removals = [...edits.removals, ...list];
    }
  }
  // getGlobalMiddleware() order (Ml 452-476): the base list, then
  // array_merge(prepends, base, appends), minus removals, then the replacements
  // map is applied - so removing `TrimStrings` removes the CLASS STACK ENTRY and
  // a `replace()` for a removed class never rescues it.
  const base = edits.global !== null ? edits.global : FRAMEWORK_GLOBAL_MIDDLEWARE;
  const stack = [...edits.prepends, ...base, ...edits.appends]
    .filter((c) => !edits.removals.some((r) => sameMiddleware(r, c)))
    .map((c) => edits.replacements[c] ?? c);
  // Dedupe the way array_unique() does (first occurrence wins).
  const seen = new Set();
  const finalStack = stack.filter((c) => {
    const key = String(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const inStack = (simple) => finalStack.some((c) => String(c).split('\\').pop() === simple);
  // An app that configured a transformer which is then not on the stack simply
  // never runs it; the stack decides, the configuration only adds skips.
  const trimInStack = inStack('TrimStrings');
  const emptyInStack = inStack('ConvertEmptyStringsToNull');
  if (state.trimExceptUnreadable) {
    return { refusal: 'bootstrap/app.php: `TrimStrings::except([...])` holds an entry the build cannot read statically - the compiled rung would trim a different set of fields; add a port' };
  }
  // A skipWhen() callback is a per-request decision the compiled rung cannot
  // make (it never sees the app's closure): refuse, never guess.
  if (trimInStack && state.trimSkipConfigured) {
    return { refusal: 'bootstrap/app.php registers a TrimStrings::skipWhen() callback (or a Closure in ->trimStrings()) - which requests skip the trim is decided at run time and the compiled rung cannot reproduce it; add a port' };
  }
  if (emptyInStack && state.emptySkipConfigured) {
    return { refusal: 'bootstrap/app.php registers a ConvertEmptyStringsToNull::skipWhen() callback - which requests skip the empty-to-null pass is decided at run time and the compiled rung cannot reproduce it; add a port' };
  }
  // Everything else on the final stack that the compiled kernel does not run.
  // The framework's own defaults (TrustHosts, HandleCors, TrustProxies, ...) are
  // not reported: their behaviour is tracked elsewhere and an untouched app must
  // keep building. An app-changed stack is held to it: whatever it puts on the
  // stack beyond the defaults AND beyond the kernel's own set is a divergence.
  const touched = new Set([...edits.prepends, ...edits.appends, ...Object.values(edits.replacements)]);
  const customised = edits.global !== null || calls.length > 0;
  const prevented = customised
    ? finalStack.filter(
        (c) =>
          !MW_IMPLEMENTED_BY_KERNEL.has(String(c).split('\\').pop()) &&
          (edits.global !== null || touched.has(c))
      )
    : [];
  return {
    trim: trimInStack,
    emptyToNull: emptyInStack,
    // The framework's own list (`TrimStrings::$except`) plus the strings the
    // app added (`TrimStrings::except()`, STATIC and accumulating).
    trimExcept: [...FRAMEWORK_TRIM_EXCEPT, ...(state.trimExcept || [])],
    prevented,
  };
}
/**
 * The route file paths bootstrap/app.php registers (`withRouting`). Returns
 * { web, api, commands, health, pages? } with absolute paths; missing files
 * are null. Laravel 9/10 route registration lives elsewhere.
 */
export function appRouteFiles(appDir) {
  const bootFile = join(appDir, 'bootstrap', 'app.php');
  if (!existsSync(bootFile)) return null;
  const parsed = parsePhpFile(bootFile);
  if (parsed.error) return null;
  const out = { web: null, api: null, commands: null, health: null, pages: null };
  const walker = (n) => {
    if (Array.isArray(n)) { n.forEach(walker); return; }
    if (!n || typeof n !== 'object') return;
    if (callMethodName(n) === 'withRouting') {
      for (const a of callArgs(n)) {
        if (!a || a.kind !== 'namedargument' || !a.name || !a.value) continue;
        const raw = concatExpr(a.value);
        if (raw) {
          const p0 = raw.replace(/^['"]|['"]$/g, '');
          // `__DIR__` is the directory of the FILE being parsed (bootstrap/),
          // NOT an opaque path segment: `__DIR__.'/../routes/web.php'` only
          // happened to resolve because `__DIR__/..` cancels itself in resolve().
          // A form such as `__DIR__.'/routes/api.php'` resolved to
          // <app>/__DIR__/routes/api.php and was then declared missing.
          const p = p0.includes('__DIR__')
            ? resolve(dirname(bootFile), p0.replace(/__DIR__[\\/]?/g, ''))
            : p0;
          if (a.name === 'web') out.web = pathOrNull(p, appDir);
          else if (a.name === 'api') out.api = pathOrNull(p, appDir);
          else if (a.name === 'commands') out.commands = pathOrNull(p, appDir);
          else if (a.name === 'health') out.health = p;
          else if (a.name === 'pages') out.pages = pathOrNull(p, appDir);
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
      walker(n[k]);
    }
  };
  walker(phpParse8(parsed.source));
  return out;
}

/** A string literal, or a `__DIR__ . '/x'` concat, as a quoted JS string. */
function concatExpr(node) {
  if (!node) return '';
  if (node.kind === 'string') return `'${node.value}'`;
  if (node.kind === 'bin' && node.type === '.') {
    const l = concatExpr(node.left);
    const r = concatExpr(node.right);
    if (l && r) {
      const ls = l.replace(/^['"]|['"]$/g, '');
      const rs = r.replace(/^['"]|['"]$/g, '');
      return `'${ls}${rs}'`;
    }
  }
  if (node.kind === 'call' && node.what && node.what.kind === 'name') {
    // __DIR__ magic constant
    if (node.what.name === '__DIR__') return '__DIR__';
  }
  if (node.kind === 'magic') return node.value === '__DIR__' ? '__DIR__' : '';
  return '';
}

function abs(appDir, p) {
  const joined = join(appDir, p);
  return existsSync(joined) ? resolve(joined) : joined;
}

/** Already-absolute paths (a resolved `__DIR__`) pass through; relatives resolve against the app. */
function pathOrNull(p, appDir) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(String(p)) ? p : abs(appDir, p);
}

// ---------------------------------------------------------------------------
// config/*.php evaluator -> the runtime config (env folding + helpers)
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into a key/value map. Values already present in process
 * env win (immutable semantics, like Laravel's Dotenv createImmutable).
 */
export function readEnvFile(appDir, extra = {}) {
  const env = { ...extra };
  // Laravel loads the app's .env into an IMMUTABLE repository: a variable that
  // the process environment already defines (passed in as `extra`, the shape
  // Env::getRepository() reads through $_SERVER/$_ENV) is never overwritten by
  // the file. Within the file itself the last line wins.
  const seeded = new Set(Object.keys(extra));
  const p = join(appDir, '.env');
  if (!existsSync(p)) return env;
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return env; }
  const assign = (key, raw) => {
    if (seeded.has(key)) return;
    // vlucas/dotenv v5.7: the value is parsed (quotes/escapes) and THEN the
    // Loader runs Resolver::resolve() against the repository. Only `${NAME}`
    // counts as a variable (Value::getVars() records nothing for a bare `$`,
    // so `A=$B` stays literal), an unresolved reference stays literal
    // (Option::getOrElse($matches[0])), and a SINGLE-quoted value is never
    // interpolated (EntryParser's SINGLE_QUOTED_STATE records no variable).
    const singleQuoted = raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'";
    const value = dotenvValue(raw);
    env[key] = singleQuoted ? value : resolveEnvRefs(value, env);
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    // A `#` outside quotes opens a comment (EntryParser: UNQUOTED -> COMMENT).
    assign(body.slice(0, eq).trim(), stripEnvComment(body.slice(eq + 1)));
  }
  return env;
}

/** Everything from an unquoted `#` on is a comment (EntryParser COMMENT_STATE). */
function stripEnvComment(raw) {
  const s = raw.trim();
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return s.slice(0, i).trim();
  }
  return s;
}

/**
 * dotenv's Resolver::resolve (v5.7): the Loader walks the recorded variable
 * positions right-to-left and applies `/\A\${([a-zA-Z0-9_.]+)}/` at each one -
 * so a `${NAME}` is replaced by the repository's value but a bare `$NAME` (no
 * braces) is left alone, exactly like phpdotenv. An unresolved reference stays
 * as written (`Option::getOrElse($matches[0])`).
 */
function resolveEnvRefs(text, env) {
  if (typeof text !== 'string' || !text.includes('${')) return text;
  return text.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(env, name) && env[name] !== null && env[name] !== undefined
      ? String(env[name])
      : m);
}

/**
 * Env::getOption() (Env.php:252-284) — the coercion Env::get() applies to every
 * repository value, which is always the RAW string the source defined.
 */
export function coerceEnvValue(value) {
  if (typeof value !== 'string') return value;
  switch (value.toLowerCase()) {
    case 'true': case '(true)': return true;
    case 'false': case '(false)': return false;
    case 'empty': case '(empty)': return '';
    case 'null': case '(null)': return null;
    default: break;
  }
  const m = /^(['"])([\s\S]*)\1$/.exec(value);
  return m ? m[2] : value;
}

/** Dotenv Parser::value semantics — the exact typed forms vlucas/dotenv uses. */
function dotenvValue(s) {
  if (s === '') return '';
  const lower = s.toLowerCase();
  // `true` / `(true)` -> bool(true); same for false/null/empty.
  if (lower === 'true' || lower === '(true)') return true;
  if (lower === 'false' || lower === '(false)') return false;
  if (lower === 'null' || lower === '(null)') return null;
  if (lower === 'empty' || lower === '(empty)') return '';
  // Quoted. Only a DOUBLE-quoted value processes backslash escapes like PHP/JSON
  // (vlucas/phpdotenv's EntryParser keeps a single-quoted value verbatim). A
  // single-quoted value is returned with the quotes stripped and nothing else.
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    // phpdotenv's EntryParser DOUBLE_QUOTED_STATE unescapes exactly `\n` `\r`
    // `\t` `\v` `\f` `\"` `\\` `\$`; any OTHER `\x` keeps the backslash. One
    // pass, so `"a\\nb"` is a backslash followed by `n` (probed against
    // vlucas/phpdotenv via Dotenv::createImmutable on PHP 8.3).
    return s
      .slice(1, -1)
      .replace(/\\(.)/g, (m, ch) =>
        ch === 'n' ? '\n'
        : ch === 'r' ? '\r'
        : ch === 't' ? '\t'
        : ch === 'v' ? '\v'
        : ch === 'f' ? '\f'
        : ch === '"' ? '"'
        : ch === '\\' ? '\\'
        : ch === '$' ? '$'
        : m);
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1);
  }
  return s;
}

/** PHP's string cast for a scalar (concat operands) — one canon with the
 * build-time function library (tools/php-funcs.mjs). */
function phpStr(v) {
  return phpStrShared(v);
}

/**
 * The Illuminate\Support\Str surface a config folder may call. Every entry
 * delegates to `kernel/str.mjs` — the SAME implementation the worker runs, which
 * the corpus pins against PHP 8.3 — so a folded value and the runtime value
 * cannot drift (audit #451: this map's private copies, e.g. a `Str::ascii`
 * that was simply absent and answered `undefined`, disagreed with the worker).
 *
 * `Str::random()` is deliberately ABSENT (STR_NONDETERMINISTIC): PHP answers a
 * fresh value on every boot, so folding one would freeze a different value into
 * the dump. An absent method still fails LOUD (audit #608) — never a silent drop.
 */
const StrMethod = {
  slug: (value, sep = '-') => phpSlug(value, sep),
  ascii: (value) => phpAscii(value),
  limit: (value, limit = 100, end = '...', preserveWords = false) =>
    kernelStr.limit(value, limit, end, preserveWords),
  studly: (v) => kernelStr.studly(v),
  camel: (v) => kernelStr.camel(v),
  snake: (v, delimiter = '_') => kernelStr.snake(v, delimiter),
  kebab: (v) => kernelStr.kebab(v),
  title: (v) => kernelStr.title(v),
  contains: (haystack, needles) => kernelStr.contains(haystack, needles),
  startsWith: (haystack, needles) => kernelStr.startsWith(haystack, needles),
  endsWith: (haystack, needles) => kernelStr.endsWith(haystack, needles),
  after: (subject, search) => kernelStr.after(subject, search),
  before: (subject, search) => kernelStr.before(subject, search),
  length: (value) => kernelStr.length(value),
  replace: (search, replace, subject, caseSensitive = true) =>
    kernelStr.replace(search, replace, subject, caseSensitive),
  replaceFirst: (search, replace, subject) => kernelStr.replaceFirst(search, replace, subject),
  replaceLast: (search, replace, subject) => kernelStr.replaceLast(search, replace, subject),
  squish: (value) => kernelStr.squish(value),
  ucfirst: (value) => kernelStr.ucfirst(value),
  ucwords: (value) => kernelStr.ucwords(value),
  upper: (value) => kernelStr.upper(value),
  lower: (value) => kernelStr.lower(value),
  is: (pattern, value, ignoreCase = false) => kernelStr.is(pattern, value, ignoreCase),
  finish: (value, cap) => kernelStr.finish(value, cap),
  start: (value, prefix) => kernelStr.start(value, prefix),
  isUrl: (value, protocols = []) => kernelStr.isUrl(value, protocols),
  trim: (value, chars) => phpTrim(value, chars),
};

/** `Str::` methods that exist in the worker but must NOT be folded by name. */
const STR_NONDETERMINISTIC = new Set([
  'random', 'password', 'uuid', 'orderedUuid', 'ulid', 'createRandomStringsUsing',
]);

/** PHP's boolean cast for a condition (`?:`/`ternary`) and for `(bool)`.
 * PHP is falsy for: false, 0, -0, 0.0, "0", "", null, [] (empty array).
 * JS additionally keeps `'0'` and `[]` truthy, so a bare `!v` would pick the
 * wrong branch — and `(bool) '0'` folded to the wrong VALUE, which is invisible
 * to the build's read gate (audit: the (bool) cast).
 */
function phpTruthy(c) {
  return phpBool(c);
}

/**
 * A drop report: a config value the fold could NOT answer, named by group, file,
 * line and by the SHAPE that stopped it. Before this, the branches below skipped
 * the entry (`val === undefined -> continue`) and the dumped config simply
 * lacked the key while PHP booted with a value — the failure mode the audit
 * found hardest to see (auditor notes #50, #608). `loadConfig()` collects these
 * and `tools/config-dump.mjs` prints them.
 */
function noteDrop(ctx, drop) {
  if (!ctx || typeof ctx.noteDrop !== 'function') return;
  ctx.noteDrop(drop);
}

/** Record "the fold cannot answer this node" with a reason, then answer
 * `undefined` (the evaluator's "not statically evaluable" value).
 *
 * The reason is left on `ctx.lastRefusal` and the OWNER of the value reports it
 * (the array branch knows the entry's key, `loadConfig()` knows the group): a
 * report per dropped KEY is useful, the same refusal once per nesting level is
 * noise. */
function refuse(ctx, node, reason) {
  const line = node && node.loc && node.loc.start ? node.loc.start.line : null;
  const kind = node && node.kind ? node.kind : null;
  if (ctx) ctx.lastRefusal = { reason, kind, line };
  return undefined;
}

/** The refusal currently pending from `refuse()`, or a generic one naming the
 * node kind that stopped the fold. */
function pendingRefusal(ctx, node, fallback) {
  const r = ctx && ctx.lastRefusal;
  if (r) return r;
  return {
    reason: fallback,
    kind: node && node.kind ? node.kind : null,
    line: node && node.loc && node.loc.start ? node.loc.start.line : null,
  };
}

/** A human label for an array entry's key (for the drop report). */
function entryKeyLabel(k) {
  if (!k) return '<auto>';
  if (k.kind === 'string') return `'${k.value}'`;
  if (k.kind === 'number') return String(k.value);
  if (k.kind === 'unary' && k.what && k.what.kind === 'number') {
    return (k.type === '-' ? '-' : '') + String(k.what.value);
  }
  return '<computed>';
}

/**
 * Turn a PHP-level failure (`FoldRefusal`, or the TypeError/ErrorException/
 * ValueError-named errors the kernel raises) into a NAMED drop report. A config
 * file whose expression is a PHP fatal at boot is reported as such — refusing is
 * the honest answer, guessing a value is not.
 */
function refuseFromError(ctx, node, err) {
  if (err instanceof FoldRefusal) return refuse(ctx, node, err.message);
  const cls = err && (err.phpClass || err.name);
  if (cls === 'TypeError' || cls === 'ErrorException' || cls === 'ValueError' || cls === 'DivisionByZeroError' || cls === 'ArithmeticError') {
    return refuse(ctx, node, `PHP ${cls}: ${err.message}`);
  }
  throw err;
}

/** PHP's array-key coercion for an offset READ (a decimal integer string IS the
 * integer, a float truncates, a bool is 0/1, null is ''). */
function phpKeyOf(k) {
  if (typeof k === 'number') return Number.isInteger(k) ? k : Math.trunc(k);
  if (typeof k === 'boolean') return k ? 1 : 0;
  if (k === null || k === undefined) return '';
  const s = String(k);
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

/** PHP's `$array[$key]` READ: a missing key is NULL (plus a warning — Laravel
 * promotes that to ErrorException, so an app reading a missing key does not
 * boot at all; the fold answers PHP's null and keeps folding the entry). */
function readOffset(base, key) {
  if (Array.isArray(base)) {
    const k = phpKeyOf(key);
    if (typeof k === 'number') return k >= 0 && k < base.length ? base[k] : null;
    return null;
  }
  if (base !== null && typeof base === 'object') {
    const s = String(phpKeyOf(key));
    if (Object.prototype.hasOwnProperty.call(base, s)) return base[s];
    return null;
  }
  return null; // PHP 8 answers NULL for an offset on a scalar (with a warning)
}

/** The path of an `include`/`require`, resolved from PATH expressions only.
 *
 * `__DIR__` and `__FILE__` are REFUSED as values (they name the build machine,
 * which the edge does not have), but in an include PATH they mean exactly what
 * PHP means, and the string is consumed by the build — never written into the
 * dump — so `include __DIR__ . '/parts.php'`, the shape an app uses to split a
 * config file, resolves to the sibling file. Literals, `.` concatenation,
 * `__DIR__`/`__FILE__` and `dirname(...)` around them are the modelled shapes;
 * anything else refuses with the reason, which the caller reports.
 */
function resolveIncludePath(node, ctx, depth = 0) {
  if (!node || depth > 20) return undefined;
  if (node.kind === 'string') return node.value;
  if (node.kind === 'magic') {
    if (node.value === '__DIR__') return ctx.file ? dirname(ctx.file) : ctx.appDir;
    if (node.value === '__FILE__') return ctx.file || undefined;
    return refuse(ctx, node, `magic constant ${node.value} is not a path the fold can resolve for an include`);
  }
  if (node.kind === 'bin' && node.type === '.') {
    const l = resolveIncludePath(node.left, ctx, depth + 1);
    const r = resolveIncludePath(node.right, ctx, depth + 1);
    if (l === undefined || r === undefined) return undefined;
    return l + r;
  }
  if (node.kind === 'call' && node.what && node.what.kind === 'name') {
    const args = node.arguments || [];
    if (node.what.name === 'dirname' && args.length > 1) {
      // dirname($p, $levels): the level count is not part of the modelled path
      // shape; resolving without it would answer the wrong directory.
      return refuse(ctx, node, 'dirname() with a level count in an include path is not modelled');
    }
    if ((node.what.name === 'dirname' || node.what.name === 'realpath') && args.length === 1) {
      const inner = resolveIncludePath(args[0], ctx, depth + 1);
      if (inner === undefined) return undefined;
      if (node.what.name === 'dirname') return dirname(inner);
      // realpath() answers false for a path that does not exist; false in a
      // path concatenation is PHP's '' — refuse instead of guessing.
      return existsSync(inner) ? inner : undefined;
    }
  }
  return refuse(ctx, node, `an include path built from a <${node.kind}> expression is not statically resolvable`);
}

/** `include`/`require`: PHP evaluates the file and answers its `return` value.
 * The path is tried relative to the INCLUDING file's folder first (PHP's own
 * rule), then to the app root. A missing `require` is a fatal at boot, a missing
 * `include` a warning — Laravel's error handler turns either into an exception,
 * so both are REFUSED here rather than folded to `false`. */
function includeConfigFile(node, target, ctx) {
  const dir = ctx.file ? dirname(ctx.file) : ctx.appDir;
  const candidates = /^([A-Za-z]:[\\/]|\/)/.test(target) ? [target] : [join(dir, target), join(ctx.appDir, target)];
  const file = candidates.find((p) => existsSync(p));
  if (!file) {
    return refuse(ctx, node, `${node.require ? 'require' : 'include'} of ${target}: the file does not exist`);
  }
  const stack = ctx.includeStack || [];
  if (stack.includes(file)) {
    return node.once ? true : refuse(ctx, node, `${file} includes itself`);
  }
  const parsed = parsePhpFile(file);
  if (parsed.error) return refuse(ctx, node, `${file} does not parse: ${parsed.error}`);
  // PHP runs an included file in the INCLUDING scope: the variables assigned
  // before the include are visible to it, and the ones it assigns stay visible
  // after (that is how a config file splits itself into parts).
  const sub = { ...ctx, file, parsed, includeStack: [...stack, file] };
  const before = sub.lastRefusal;
  let value;
  try {
    value = runConfigStatements(phpParse8(parsed.source), sub);
  } catch (e) {
    return refuseFromError(ctx, node, e);
  }
  if (value === undefined && sub.lastRefusal === before) {
    // No refusal happened and the file has no `return`: PHP's include answers
    // int(1) for a file it executed successfully.
    return 1;
  }
  return value;
}

/** The `$a[] = $v` append marker (an offset with no expression). */
const APPEND = Symbol('append');

/** The ordered `[key, value]` entries of a folded PHP array: a JS list keeps its
 * indices, a keyed array its `__lwOrder` marker (the array LITERAL builder below
 * and the kernel both use that convention). */
function phpEntriesOf(v) {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (v !== null && typeof v === 'object') {
    const order = Array.isArray(v.__lwOrder) ? v.__lwOrder : Object.keys(v);
    return order.map((k) => [k, v[k]]);
  }
  return null;
}

/** A deep copy of a folded value: PHP arrays are VALUE types, so assigning one
 * to another name — or writing through an offset — must not alias. (Scalars and
 * strings are immutable in JS, so only containers are copied.) */
function clonePhpValue(v) {
  if (Array.isArray(v)) return v.map(clonePhpValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clonePhpValue(v[k]);
    if (Array.isArray(v.__lwOrder)) {
      Object.defineProperty(out, '__lwOrder', { value: v.__lwOrder.slice(), enumerable: false });
    }
    // PHP's append counter (`nextFreeElement`) travels with the array: PHP
    // assigns arrays by value, counter included.
    if (Number.isInteger(v.__lwNext)) {
      Object.defineProperty(out, '__lwNext', { value: v.__lwNext, enumerable: false });
    }
    return out;
  }
  return v;
}

/** A read for the WRITE path: like `readOffset()`, but an append marker is not a
 * key and a missing value is `null`. */
function getOffset(container, key) {
  if (key === APPEND) return null;
  return readOffset(container, key);
}

/** PHP's `nextFreeElement` for the keys an array holds NOW: the highest integer
 * key + 1, or 0 when it has none. `$a = ['a' => 1]; $a[] = 2;` is `{a:1, 0:2}`,
 * NOT `{a:1, 1:2}` — the old code used `Object.keys(container).length` as the
 * append key, so `['a'=>1,'b'=>2]` + `[]=` wrote key `2` where PHP writes `0`
 * (audit #775). PHP keeps its counter across `unset()`, which needs a slot on
 * the array; the counter is dropped here deliberately (the same key can be
 * re-used where PHP moves on) — that narrower case is reported by the callers
 * that can see it, and it never overwrites a live key. */
function nextFreeKey(container) {
  let max = -1;
  for (const k of Object.keys(container)) {
    const n = phpKeyOf(k);
    if (typeof n === 'number' && Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** PHP's write into an array, as a value-typed operation: `$a[] = v` appends, an
 * existing key overwrites, and a string key on a LIST converts it to a keyed
 * array that keeps its integer keys (`[0 => 'a']` + `['x' => 1]`). */
function setOffset(container, key, value) {
  if (Array.isArray(container)) {
    const k = key === APPEND ? undefined : phpKeyOf(key);
    if (key === APPEND || (typeof k === 'number' && Number.isInteger(k) && k === container.length)) {
      const out = container.slice();
      out.push(value);
      return out;
    }
    if (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < container.length) {
      const out = container.slice();
      out[k] = value;
      return out;
    }
    const out = {};
    container.forEach((v, i) => { out[String(i)] = v; });
    out[String(k)] = value;
    Object.defineProperty(out, '__lwOrder', { value: Object.keys(out), enumerable: false });
    // A list converted to the keyed form: its integer keys are 0..n-1, so the
    // append counter is `n` unless the new key is higher — and when the list was
    // EMPTY there is no integer key at all, so PHP starts the counter at that
    // key + 1 even when the key is negative (`[]` + `$a[-5] = 'a'` then
    // `$a[] = 'b'` keys b at -4, probed on PHP 8.3).
    const hasInt = container.length > 0;
    Object.defineProperty(out, '__lwNext', {
      value: typeof k === 'number' && Number.isInteger(k)
        ? hasInt ? Math.max(container.length, k + 1) : k + 1
        : container.length,
      enumerable: false,
    });
    return out;
  }
  const out = {};
  for (const k of Object.keys(container)) out[k] = container[k];
  const counter = Number.isInteger(container.__lwNext) ? container.__lwNext : nextFreeKey(container);
  const s = key === APPEND ? String(counter) : String(phpKeyOf(key));
  out[s] = value;
  // The order marker is a SNAPSHOT of PHP's insertion order: a key that the
  // object no longer holds must not stay in it, or the dump writes a phantom
  // `"c": null` (see serializeOrdered / kernel phpJsonEncode).
  const order = (Array.isArray(container.__lwOrder) ? container.__lwOrder.slice() : Object.keys(container)).filter(
    (x) => Object.prototype.hasOwnProperty.call(out, String(x))
  );
  if (!order.some((x) => String(x) === s)) order.push(s);
  Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
  // PHP's nextFreeElement: an append consumes the counter; an explicit integer
  // key raises it to key+1 when that is higher, but an array that had NO integer
  // key yet starts the counter at key+1 (even for a negative key) — both probed
  // on PHP 8.3, see the fixture cases in fixtures/config-eval/app/config/append.php.
  // A string key and unset() leave it alone: `[5=>'x']; unset($a[5]); $a[] = 'y'`
  // keys y at 6, where nextFreeKey()'s max+1 would answer 0.
  const intKey = Number.isInteger(phpKeyOf(s));
  const hadIntKey = Object.keys(container).some((k) => Number.isInteger(phpKeyOf(k)));
  const written = intKey ? (hadIntKey ? Math.max(counter, phpKeyOf(s) + 1) : phpKeyOf(s) + 1) : counter;
  Object.defineProperty(out, '__lwNext', {
    value: key === APPEND ? counter + 1 : written,
    enumerable: false,
  });
  return out;
}

/** `$a['x']['y'] = v` — writes down a key PATH, cloning as it goes. A missing
 * intermediate becomes an empty array, exactly as PHP auto-vivifies it. */
function setPath(container, keys, value) {
  if (keys.length === 0) return setOffset(container, APPEND, value);
  const [head, ...rest] = keys;
  if (rest.length === 0) return setOffset(container, head, value);
  const child = getOffset(container, head);
  const base = child !== null && typeof child === 'object' ? child : [];
  return setOffset(container, head, setPath(base, rest, value));
}

/** The read side of a key path (for `.=` and `??=`). */
function getPath(container, keys) {
  let cur = container;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    const next = getOffset(cur, k);
    if (next === undefined) return null;
    cur = next;
  }
  return cur === undefined ? null : cur;
}

/** `$x op= v` — the operator goes through the SAME canon as a `bin` expression
 * (`phpBinaryOp`), so `$x .= 'a'` and `$a . 'a'` cannot disagree. */
function applyAssignOp(ctx, node, op, current, value) {
  if (current === undefined) {
    const name = node.left && node.left.name ? `$${node.left.name}` : 'the target';
    return refuse(ctx, node, `'${op}=' reads ${name}, which the fold never assigned (PHP warns and the app fails to boot)`);
  }
  try {
    return phpBinaryOp(op, current, value);
  } catch (e) {
    return refuseFromError(ctx, node, e);
  }
}

/** `$a['x'] = v`, `$a[] = v`, `$a['x']['y'] op= v`: resolve the chain to its ROOT
 * variable, clone the root, write the path, store the root back. The root is the
 * only place a value can live (there is no reference in the fold), so this is
 * also the point where PHP's copy-on-write becomes an explicit clone. */
function assignOffset(ctx, node, target, value, op, depth) {
  const chain = [];
  let root = target;
  while (root && root.kind === 'offsetlookup') { chain.unshift(root); root = root.what; }
  if (!root || root.kind !== 'variable') {
    return refuse(ctx, node, 'an offset write whose root is not a variable is not modelled');
  }
  const keys = [];
  for (const link of chain) {
    if (!link.offset) {
      keys.push(APPEND);
      continue;
    }
    const k = evalConfigExpr(link.offset, ctx, depth + 1);
    if (k === undefined) return undefined;
    keys.push(phpKeyOf(k));
  }
  let base = ctx.scope[root.name];
  if (base === undefined || base === null) base = []; // PHP auto-vivifies from null/undefined
  if (typeof base !== 'object') {
    return refuse(ctx, node, `writing an offset on $${root.name} (${typeof base}) is a PHP error`);
  }
  let writeValue = value;
  if (op === '??=') {
    // `$a['k'] ??= $v`: PHP assigns only when the offset is null or ABSENT —
    // absent is the whole point of the operator. The old code fell through to
    // `applyAssignOp('??')` whenever the key was missing, which has no operator
    // canon: a refused `??` dropped the assignment (and, in the statement path,
    // poisoned the file) instead of writing the value PHP writes.
    const current = getPath(base, keys);
    if (current !== null && current !== undefined) return current;
  } else if (op !== '=') {
    const current = getPath(base, keys);
    const applied = applyAssignOp(ctx, node, op.slice(0, -1), current, value);
    if (applied === undefined) return undefined;
    writeValue = applied;
  }
  ctx.scope[root.name] = setPath(clonePhpValue(base), keys, writeValue);
  return writeValue;
}

/** `list($a, $b) = $src` / `['k' => $v] = $src`: positional and keyed forms, with
 * a missing element answering PHP's null. A by-reference element and `...` are
 * refused. */
function assignDestructure(ctx, node, target, value, depth) {
  const items = target.items || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.value) continue; // a skipped slot: `list(, $b)`
    if (item.byRef || item.unpack) {
      return refuse(ctx, node, 'a by-reference or `...` destructuring element is not modelled');
    }
    let key = i;
    if (item.key) {
      const k = evalConfigExpr(item.key, ctx, depth + 1);
      if (k === undefined) return refuse(ctx, node, 'a destructuring key is not statically evaluable');
      key = phpKeyOf(k);
    }
    const v = readOffset(value, key);
    if (item.value.kind === 'variable') {
      ctx.scope[item.value.name] = clonePhpValue(v);
      continue;
    }
    if (item.value.kind === 'offsetlookup') {
      const wrote = evalConfigExpr(item.value, ctx, depth + 1);
      if (wrote === undefined) return undefined;
      continue;
    }
    return refuse(ctx, node, `a destructuring target of kind <${item.value.kind}> is not modelled`);
  }
  return value;
}

/** Evaluate one config expression node (PHP) to a JS value. ctx: { env, appDir }.
 * Additional ctx fields the fold uses: { parsed, file, group, scope, noteDrop }. */
export function evalConfigExpr(node, ctx, depth = 0) {
  if (depth > 50) return undefined;
  if (!node) return undefined;
  const { env = {}, appDir } = ctx;
  // Unwrap argument/entry wrappers.
  if (node.kind === 'argument' || node.kind === 'namedargument') {
    const val = node.value || node.expr || node;
    return evalConfigExpr(val, ctx, depth + 1);
  }

  switch (node.kind) {
    case 'nullkeyword':
    case 'null':
      return null;
    case 'boolean':
      return node.value;
    case 'number': {
      // php-parser keeps the RAW literal ('017', '1_000', '0x1f', '1e3'):
      // `Number(node.value)` answered 17 for the OCTAL 017 (PHP answers 15) and
      // NaN for `1_000`/`1_000.5` — and a NaN dropped the entry from the dumped
      // config with no trace. `phpNumberLiteral()` is the canon (the same rules
      // the array-KEY path has always applied to a literal key).
      const n = phpNumberLiteral(node.value);
      if (n === null) {
        return refuse(ctx, node, `the integer literal ${node.value} is outside JSON number safety`);
      }
      return n;
    }
    // php-parser 3.x wraps a SIGNED literal in a `unary` node: `-6.8905` is
    // `unary('-', number('6.8905'))`, `+6.8905` its `+` twin — never a `number`
    // node. The array-KEY sibling above (`keyExprOf`) has always handled the
    // sign; this VALUE branch did not, so the value evaluated to `undefined`
    // and the entry around it was dropped by the "never give an unknown
    // expression a slot" rule below — the KEY vanished from the dumped config
    // with no note (`'latitude' => -6.8905` was missing from
    // dist/src/config.generated.mjs while its positive neighbour survived, and
    // the app's map died on `Invalid LngLat object: (107.5944, NaN)`).
    // `!` goes through phpTruthy(): PHP's `!'0'` and `![]` are TRUE.
    case 'unary': {
      const v = evalConfigExpr(node.what, ctx, depth + 1);
      if (v === undefined) return undefined;
      // `!` is PHP's (bool) negation through the kernel's canon; `-`/`+`/`~` go
      // through `phpUnaryOp()` so `-'5'` is -5 (the old code required a JS
      // number and DROPPED the entry for `- env('X')` with X='5') and `~` is
      // 64-bit (JS's `~` works on 32 bits).
      if (node.type === '!') return !phpBool(v);
      try {
        return phpUnaryOp(node.type, v);
      } catch (e) {
        return refuseFromError(ctx, node, e);
      }
    }
    case 'string':
      return node.value;
    // ASSIGNMENT. `tools/config-script.mjs` executes a config file's statements,
    // so the fold owns a SCOPE (ctx.scope). PHP arrays are VALUE types —
    // `$b = $a; $b[] = 1;` leaves `$a` untouched — so a variable-to-variable
    // assignment and every write into an array CLONE the container: the fold
    // never lets two names alias one array, which is exactly what a config file's
    // `foreach (...) { $out[$k] = $v; }` loop depends on.
    case 'assign': {
      if (!ctx.scope) {
        return refuse(ctx, node, 'an assignment needs the config-script scope (evalConfigExpr was called without one)');
      }
      const target = node.left;
      const op = node.operator || '=';
      const value = evalConfigExpr(node.right, ctx, depth + 1);
      if (value === undefined) {
        // The right side is not foldable. Record WHY, against whatever names the
        // missing value best: a variable keeps the reason for a LATER read of it;
        // an offset write (`$out[$k] = <refused>`) has no name to read later, so
        // its KEY is reported here — that key is what the config is missing.
        const r = pendingRefusal(ctx, node.right, 'the assigned value is not statically evaluable');
        if (target && target.kind === 'variable') {
          ctx.scopeReasons = ctx.scopeReasons || {};
          ctx.scopeReasons[target.name] = `$${target.name} was assigned <${r.kind || 'expression'}>: ${r.reason}`;
        } else {
          let key = null;
          if (target && target.kind === 'offsetlookup') {
            if (!target.offset) key = '<append>';
            else {
              const k = evalConfigExpr(target.offset, ctx, depth + 1);
              key = k === undefined ? '<key>' : String(phpKeyOf(k));
            }
          }
          if (ctx.noteDrop) {
            ctx.noteDrop({
              group: ctx.group,
              file: ctx.file,
              line: r.line != null ? r.line : node.loc && node.loc.start ? node.loc.start.line : null,
              kind: r.kind,
              key,
              reason: r.reason,
            });
          }
        }
        return undefined;
      }
      if (target && target.kind === 'variable') {
        const name = target.name;
        let next = clonePhpValue(value);
        if (op !== '=') {
          if (op === '??=') {
            const cur = ctx.scope[name];
            if (cur !== undefined && cur !== null) return cur;
          } else {
            const applied = applyAssignOp(ctx, node, op.slice(0, -1), ctx.scope[name], value);
            if (applied === undefined) return undefined;
            next = applied;
          }
        }
        ctx.scope[name] = next;
        if (ctx.scopeReasons) delete ctx.scopeReasons[name];
        return next;
      }
      if (target && target.kind === 'offsetlookup') {
        // The offset keys are resolved by `assignOffset()` as it walks the whole
        // chain (a leaf key is just the last link), so the key is NOT evaluated
        // here: evaluating it twice would double a side effect the fold refuses
        // anyway, and the call signature has no room for a key that would then be
        // re-derived.
        return assignOffset(ctx, node, target, value, op, depth);
      }
      if (target && (target.kind === 'list' || target.kind === 'array')) {
        return assignDestructure(ctx, node, target, value, depth);
      }
      return refuse(ctx, node, `assigning to a <${(target && target.kind) || '?'}> target is not modelled`);
    }
    // A local VARIABLE: `tools/config-script.mjs` executes the file's assignments,
    // so the scope holds every name assigned so far. A name that was never
    // assigned is PHP's NULL **plus an "Undefined variable" warning** — and under
    // Laravel that warning is an ErrorException, i.e. the app does not boot; the
    // fold refuses it by name instead of answering a value PHP never had.
    // `$_ENV` is the .env map (phpdotenv's immutable repository writes $_ENV),
    // the request superglobals are EMPTY arrays under the CLI SAPI that config
    // files are evaluated with, and `$_SERVER`/`$GLOBALS` carry the build host.
    case 'variable': {
      const name = node.name;
      if (name === '_ENV') return { ...env };
      if (name === '_GET' || name === '_POST' || name === '_REQUEST' || name === '_COOKIE' || name === '_FILES' || name === '_SESSION') {
        return [];
      }
      if (name === '_SERVER' || name === 'GLOBALS') {
        return refuse(ctx, node, `the superglobal $${name} carries the build host's state`);
      }
      if (ctx.scope && Object.prototype.hasOwnProperty.call(ctx.scope, name)) {
        const v = ctx.scope[name];
        // A name whose ASSIGNMENT was refused keeps its reason, so the report
        // names `Str::merge()` instead of a vague "never assigned".
        if (v === undefined && ctx.scopeReasons && ctx.scopeReasons[name]) {
          return refuse(ctx, node, ctx.scopeReasons[name]);
        }
        return v;
      }
      return refuse(ctx, node, `the variable $${name} is never assigned in the file the fold executed`);
    }
    case 'closure':
    case 'arrowfunc':
      return makeClosure(node, ctx, depth, evalConfigExpr);
    // `++$i` / `$i++` — folded through the scope, so a loop counter in a config
    // file works. PHP's string increment (`'a'++` is 'b') is refused.
    case 'pre':
    case 'post': {
      const target = node.what;
      if (!target || target.kind !== 'variable') {
        return refuse(ctx, node, `++/-- on a <${(target && target.kind) || '?'}> target is not modelled`);
      }
      const cur = ctx.scope ? ctx.scope[target.name] : undefined;
      if (typeof cur !== 'number') {
        return refuse(ctx, node, `++/-- on $${target.name} (${cur === undefined ? 'unset' : typeof cur}) is not modelled`);
      }
      const next = node.type === '+' ? cur + 1 : cur - 1;
      if (ctx.scope) ctx.scope[target.name] = next;
      return node.kind === 'pre' ? next : cur;
    }
    // PHP's `isset()`: TRUE only when EVERY operand is set and not null. The fold
    // has no "unset" state beyond the scope (a refused operand is not "set"), and
    // an `isset` over a key that is absent from an array IS false — the live shape
    // this exists for.
    case 'isset': {
      return (node.variables || []).every((v) => {
        if (v && v.kind === 'offsetlookup') {
          const base = evalConfigExpr(v.what, ctx, depth + 1);
          const key = evalConfigExpr(v.offset, ctx, depth + 1);
          if (base === undefined || key === undefined) return false;
          const val = readOffset(base, key);
          return val !== null && val !== undefined;
        }
        const val = evalConfigExpr(v, ctx, depth + 1);
        return val !== undefined && val !== null;
      });
    }
    case 'empty': {
      const v = evalConfigExpr(node.expression, ctx, depth + 1);
      return v === undefined ? true : !phpBool(v);
    }
    case 'offsetlookup': {
      const base = evalConfigExpr(node.what, ctx, depth + 1);
      const key = evalConfigExpr(node.offset, ctx, depth + 1);
      if (base === undefined || key === undefined) return undefined;
      // A STRING offset is PHP 8's byte read (`'abc'[1]` is 'b') and a NEGATIVE
      // offset counts from the END (`'abc'[-1]` is 'c'; either end's overflow
      // warns and answers ''). PHP indexes the BYTE buffer, a JS string indexes
      // UTF-16 code units — the two agree only while every character is ASCII
      // (1 byte, 1 code unit). On 'é' PHP's `[0]` is the LONE byte "\xC3", which
      // no JS string can carry, so the fold refuses instead of answering a
      // different character or '' (audit #862).
      if (typeof base === 'string') {
        const k = phpKeyOf(key);
        if (typeof k !== 'number') {
          return refuse(ctx, node, 'a string offset must be an integer (PHP 8 raises TypeError otherwise)');
        }
        if (!/^[\x00-\x7F]*$/.test(base)) {
          return refuse(
            ctx,
            node,
            'a string offset on a NON-ASCII string — PHP indexes BYTES (\'é\'[0] is "\\xC3"), a JS string indexes UTF-16 code units'
          );
        }
        const i = k < 0 ? base.length + k : k;
        return i >= 0 && i < base.length ? base[i] : '';
      }
      return readOffset(base, key);
    }
    // "a{$v}b $x" — every part is cast to string, exactly like `.`.
    case 'encapsed': {
      let out = '';
      for (const part of node.value || []) {
        const v = evalConfigExpr(part.expression || part, ctx, depth + 1);
        if (v === undefined) return undefined;
        if (isPhpArrayValue(v)) {
          return refuse(ctx, node, 'interpolating an array into a string is a PHP warning (an ErrorException under Laravel)');
        }
        out += phpStr(v);
      }
      return out;
    }
    // PHP's `match`: STRICT comparison (===) against each arm's conditions, the
    // first match wins, `default` is the null-cond arm.
    case 'match': {
      const subject = evalConfigExpr(node.cond, ctx, depth + 1);
      if (subject === undefined) return undefined;
      let fallback;
      for (const arm of node.arms || []) {
        if (!arm || arm.kind !== 'matcharm') continue;
        if (arm.conds === null) {
          fallback = arm.body;
          continue;
        }
        for (const cond of arm.conds) {
          const v = evalConfigExpr(cond, ctx, depth + 1);
          if (v === undefined) return undefined;
          if (phpIdentical(subject, v)) return evalConfigExpr(arm.body, ctx, depth + 1);
        }
      }
      if (fallback) return evalConfigExpr(fallback, ctx, depth + 1);
      return refuse(ctx, node, 'the match() had no matching arm and no default (PHP throws UnhandledMatchError)');
    }
    // `@expr` suppresses the warning; the VALUE is the expression's.
    case 'silent':
      return evalConfigExpr(node.expr, ctx, depth + 1);
    case 'include': {
      const target = resolveIncludePath(node.target, ctx);
      if (typeof target !== 'string' || target === '') {
        return refuse(ctx, node, pendingRefusal(ctx, node.target, 'the included path is not a static string').reason);
      }
      return includeConfigFile(node, target, ctx);
    }
    case 'propertylookup':
    case 'nullsafepropertylookup':
      return refuse(ctx, node, `reading '->${(node.offset && node.offset.name) || '?'}' needs an object the fold does not model`);
    case 'new':
      return refuse(ctx, node, 'constructing an object needs the app\'s autoloader, which the fold does not load');
    case 'staticreference':
    case 'selfreference':
    case 'parentreference':
      return refuse(ctx, node, `the class reference '${node.raw || node.kind}' is not resolvable at build time`);
    case 'list':
      return refuse(ctx, node, 'list()/[] destructuring is only handled as an assignment target');
    case 'print': {
      const v = evalConfigExpr(node.expression, ctx, depth + 1);
      return v === undefined ? undefined : 1; // `print` is an expression worth 1 in PHP
    }
    case 'echo':
      return refuse(ctx, node, 'echo writes output during the fold; a config file must only return its array');
    case 'exit':
      return refuse(ctx, node, 'exit/die would end the fold (PHP ends the boot)');
    case 'throw':
      return refuse(ctx, node, 'throw in a config file (the fold does not run the app\'s exception path)');
    case 'yield':
      return refuse(ctx, node, 'yield needs a generator, which the fold does not model');
    case 'clone':
      return refuse(ctx, node, 'clone needs the app\'s object semantics');
    case 'eval':
      return refuse(ctx, node, 'eval() cannot be folded');
    case 'spread':
    case 'variadicplaceholder':
      return refuse(ctx, node, "'...' is not modelled by the fold");
    case 'array': {
      // PHP arrays are ordered maps: JSON encodes as a LIST when the integer
      // keys are 0..n-1 consecutive, else as an OBJECT.
      //
      // The key rule is PHP's own (zend_hash): a DECIMAL integer literal IS the
      // integer ('5' -> 5, '-3' -> -3, 0x10 -> 16, 017 -> 15, 1_000 -> 1000);
      // a decimal integer STRING normalizes the same way; a float key TRUNCATES
      // (1.5 -> 1); and anything else stays a string ('+5', '05', '5.0', ' '
      // '5', an out-of-int-range decimal). A KEYLESS entry takes
      // `nextFreeElement` - the HIGHEST integer key used SO FAR plus one,
      // computed as PHP walks the literal, so `[0 => 'a', 'b', 5 => 'c']` is
      // {0:a, 1:b, 5:c} and `[5 => 'x', 'y']` is {5:x, 6:y}. (The previous code
      // keyed every auto entry after scanning the WHOLE literal for its highest
      // integer key, then used `maxIndex + 1` - `['a', 3 => 'b', 'c']` came out
      // {3:b, 4:a, 5:c} where PHP answers {0:a, 3:b, 4:c}.)
      // A NEGATIVE literal key is parsed as the unary minus around a number, so
      // the key is read from the raw source, not the AST kind.)
      const entries = []; // [key|number, value] in insertion order (key NaN = PHP's next free integer)
      const intOfLiteral = (raw) => {
        const s = String(raw).replace(/_/g, '');
        if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
        if (/^0[bB][01]+$/.test(s)) return parseInt(s.slice(2), 2);
        if (/^0[oO][0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
        if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
        if (/^\d+$/.test(s)) return Number(s);
        return null;
      };
      const asPhpKey = (raw) => {
        if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : raw;
        const s = String(raw);
        // A numeric literal written as a STRING: '5' -> 5, '-3' -> -3, ... but
        // '05'/'+5'/'5.0'/' 5' stay strings (PHP's decimal-int-string rule).
        if (/^-?\d+$/.test(s)) {
          const n = Number(s);
          return Number.isSafeInteger(n) ? n : s;
        }
        return s;
      };
      const keyExprOf = (k) => {
        if (!k) return { value: undefined };
        if (k.kind === 'number') {
          const n = intOfLiteral(k.value);
          if (n !== null) return { value: n };
          const f = Number(String(k.value).replace(/_/g, ''));
          return { value: Number.isFinite(f) ? Math.trunc(f) : String(k.value) };
        }
        if (k.kind === 'string') return { value: asPhpKey(k.value) };
        if (k.kind === 'unary' && (k.type === '-' || k.type === '+')) {
          const inner = k.what || {};
          if (inner.kind === 'number') {
            const n = intOfLiteral(inner.value);
            if (n !== null) return { value: k.type === '-' ? -n : n };
            const f = Number(String(inner.value).replace(/_/g, ''));
            if (Number.isFinite(f)) return { value: Math.trunc(k.type === '-' ? -f : f) };
          }
          return { value: asPhpKey(String(k.type === '-' ? '-' : '') + String(inner.value)) };
        }
        return { value: evalConfigExpr(k, ctx, depth + 1) };
      };
      for (const e of (node.items || [])) {
        if (!e || e.kind !== 'entry') continue;
        if (e.unpack) {
          // PHP 8.1 array spread (`[...$a]`): the operand's entries are MERGED
          // into the literal — integer keys are renumbered from the running
          // nextFreeElement, string keys are kept and a later duplicate wins.
          // The old code pushed the spread ARRAY as one value, so
          // `[0, ...$keys, 3]` folded to `[0, ['a','b'], 3]` where PHP answers
          // `[0,'a','b',3]` (verified: `[0, ...['x'=>1, 5=>2], 3]` is
          // {0:0, x:1, 1:2, 2:3}).
          ctx.lastRefusal = null;
          const src = evalConfigExpr(e.value, ctx, depth + 1);
          const spreadEntries = src === undefined ? null : phpEntriesOf(src);
          if (!spreadEntries) {
            const r = ctx.lastRefusal;
            noteDrop(ctx, {
              group: ctx.group,
              file: ctx.file,
              line: (r && r.line) || (e.value && e.value.loc && e.value.loc.start ? e.value.loc.start.line : null),
              kind: 'spread',
              key: entryKeyLabel(e.key),
              reason: (r && r.reason) || 'the spread operand is not a PHP array (PHP raises a TypeError)',
            });
            continue;
          }
          for (const [k, val] of spreadEntries) {
            // PHP's spread keeps STRING keys and RENUMBERS every integer key:
            // a string key is placed as itself, an integer one takes the
            // running nextFreeElement (the NaN marker the pass below resolves).
            entries.push({ key: /^-?\d+$/.test(String(k)) ? NaN : String(k), val });
          }
          continue;
        }
        const keyKind = e.key ? 'literal' : 'auto';
        let kv;
        if (e.key) {
          const kk = keyExprOf(e.key);
          kv = kk.value;
          if (typeof kv === 'string') kv = asPhpKey(kv);
          else if (typeof kv === 'number') kv = asPhpKey(kv);
          else if (typeof kv === 'boolean') kv = kv ? 1 : 0;
          else if (kv === null || kv === undefined) kv = undefined;
          else kv = undefined;
        }
        ctx.lastRefusal = null;
        const val = evalConfigExpr(e.value, ctx, depth + 1);
        if (val === undefined) {
          // NEVER give an unknown expression a slot — but SAY SO. This is the
          // line that used to make a whole config key vanish from the dumped
          // config without a trace (auditor notes #50 and #608): the entry was
          // skipped silently and PHP booted with a value. `refuse()` recorded
          // the innermost reason; fall back to a generic one.
          const r = ctx.lastRefusal;
          noteDrop(ctx, {
            group: ctx.group,
            file: ctx.file,
            line: (r && r.line) || (e.value && e.value.loc && e.value.loc.start ? e.value.loc.start.line : null),
            kind: (r && r.kind) || (e.value && e.value.kind) || 'entry',
            key: entryKeyLabel(e.key),
            reason: (r && r.reason) || 'the entry value is not statically evaluable',
          });
          continue;
        }
        // `$key === null` is PHP's KEYLESS entry (it becomes nextFreeElement);
        // a computed key the evaluator could not resolve is skipped instead.
        if (keyKind === 'auto') entries.push({ key: NaN, val });
        else if (kv === undefined) {
          noteDrop(ctx, {
            group: ctx.group,
            file: ctx.file,
            line: e.key && e.key.loc && e.key.loc.start ? e.key.loc.start.line : null,
            kind: 'entry-key',
            key: entryKeyLabel(e.key),
            reason: 'the array key is not statically evaluable',
          });
          continue;
        } else entries.push({ key: kv, val });
      }
      // The running `nextFreeElement`: PHP starts it at 0, an APPEND (an entry
      // with no key) consumes it, and an explicit integer key sets it to key+1 —
      // but only to the higher of the two, EXCEPT that an array which has no
      // integer key yet takes key+1 verbatim, so a negative first key moves it
      // down (`[-5 => 'a']` then `[] = 'b'` keys b at -4: P1/P2/P3/P4/P5 in the
      // fixture below are probed PHP 8.3 answers).
      let nextFree = 0;
      let intKeys = 0;
      const placed = [];
      for (const it of entries) {
        const k = Number.isNaN(it.key) ? nextFree : it.key;
        placed.push([String(k), it.val]);
        if (Number.isInteger(k)) {
          nextFree = intKeys === 0 ? k + 1 : Math.max(nextFree, k + 1);
          intKeys += 1;
        }
      }
      // List form iff the string keys are exactly 0..placed.length-1.
      let isList = true;
      const listVals = [];
      for (let i = 0; i < placed.length; i++) {
        if (placed[i][0] !== String(i)) { isList = false; break; }
        listVals.push(placed[i][1]);
      }
      if (isList) return listVals;
      // The keys keep their PHP INSERTION order: a JS object literal cannot
      // (an integer-like key enumerates before every string key), so the order
      // is recorded in the non-enumerable `__lwOrder` marker the kernel's
      // `phpKeys()`/`phpJsonEncode` read back. `['x' => 1, 'b']` used to reach
      // the edge as `{"0":"b","x":1}` where PHP answers `{"x":1,"0":"b"}`.
      const obj = {};
      for (const [k, v] of placed) obj[k] = v;
      Object.defineProperty(obj, '__lwOrder', { value: placed.map(([k]) => k), enumerable: false });
      // PHP's nextFreeElement travels with the array (see setOffset()): it is
      // `nextFree` here, NOT max+1 of the keys (an unset() keeps it).
      Object.defineProperty(obj, '__lwNext', { value: nextFree, enumerable: false });
      return obj;
    }
    case 'bin':
    case 'binary': {
      const type = node.type;
      if (type === '??') {
        const l = evalConfigExpr(node.left, ctx, depth + 1);
        if (l !== undefined && l !== null) return l;
        return evalConfigExpr(node.right, ctx, depth + 1);
      }
      // `&&`/`||` and their `and`/`or` spellings SHORT-CIRCUIT in PHP: when the
      // left operand decides the answer the right one is never evaluated (and a
      // refused/dropped right side must not matter then). `xor` has no
      // short-circuit and falls through to the operator canon.
      if (type === '&&' || type === 'and' || type === '||' || type === 'or') {
        const l = evalConfigExpr(node.left, ctx, depth + 1);
        if (l === undefined) {
          return refuse(ctx, node, `the left operand of '${type}' is not statically evaluable`);
        }
        const lb = phpBool(l);
        if ((type === '&&' || type === 'and') && !lb) return false;
        if ((type === '||' || type === 'or') && lb) return true;
        const r = evalConfigExpr(node.right, ctx, depth + 1);
        if (r === undefined) return undefined;
        return phpBool(r);
      }
      const l = evalConfigExpr(node.left, ctx, depth + 1);
      const r = evalConfigExpr(node.right, ctx, depth + 1);
      // undefined = "not statically evaluable"; null is a REAL PHP null, which
      // casts to '' in a concat — `env('X') . '/y'` with X unset is '/y' in PHP,
      // while the old code dropped the whole entry (undefined).
      if (l === undefined || r === undefined) return undefined;
      if (type === '.' && (isPhpArrayValue(l) || isPhpArrayValue(r))) {
        return refuse(ctx, node, 'concatenating an array is a PHP warning — an ErrorException under Laravel, i.e. the app does not boot');
      }
      if (type === 'instanceof') {
        return refuse(ctx, node, '`instanceof` needs the app\'s class hierarchy, which the fold does not load');
      }
      // Everything else is the operator canon in tools/php-funcs.mjs: `+ - * / %
      // **`, the 64-bit bitwise set, `< <= > >= <=>` (SORT_REGULAR), `== != ===
      // !==`, `xor`, `.`. It throws a FoldRefusal / PHP-named error where PHP
      // itself would fail, and the report names it instead of dropping the key.
      try {
        return phpBinaryOp(type, l, r);
      } catch (e) {
        return refuseFromError(ctx, node, e);
      }
    }
    // php-parser 3.x tags BOTH the full ternary (`$a ? $b : $c`) and the elvis
    // (`$a ?: $c`) with kind `retif` — `trueExpr` is null for the elvis. The old
    // code matched only kind `ternary`, which the parser NEVER emits, so every
    // ternary in a config file fell through to `undefined`: the array branch
    // then dropped the entry (and a whole top-level ternary dropped the group)
    // WITHOUT A TRACE, while PHP boots with a value (auditor note #50). The
    // `ternary` label stays for hand-built ASTs (tools/tests/env-fold.test.mjs).
    case 'ternary':
    case 'retif': {
      const c = evalConfigExpr(node.test, ctx, depth + 1);
      // A condition the evaluator cannot resolve has no knowable branch - drop
      // it (an unresolvable expression is the pre-existing convention).
      if (c === undefined) return undefined;
      // The elvis answers the test ITSELF when truthy, else the else branch;
      // the full ternary picks between its two arms.
      if (phpTruthy(c)) return node.trueExpr ? evalConfigExpr(node.trueExpr, ctx, depth + 1) : c;
      return evalConfigExpr(node.falseExpr, ctx, depth + 1);
    }
    case 'cast': {
      const v = evalConfigExpr(node.expr, ctx, depth + 1);
      // `undefined` is "not statically evaluable" (the entry drops); a REAL PHP
      // null still casts: `(int) env('MISSING')` is 0, `(string) null` is '',
      // `(array) null` is []. The old code answered `undefined` for the null and
      // dropped the whole entry.
      if (v === undefined) return undefined;
      try {
        switch (node.type) {
          case 'bool': return phpBool(v);
          case 'int': return phpIntCast(v);
          case 'float':
          case 'double':
          case 'real': return phpFloatCast(v);
          case 'string': return phpStringCast(v);
          case 'array': return phpArrayCast(v);
          default:
            throw new FoldRefusal(`the (${node.type}) cast is not modelled by the fold`);
        }
      } catch (e) {
        return refuseFromError(ctx, node, e);
      }
    }
    case 'call': {
      // A NAMED argument (`array_filter(array: $a, callback: $f)`) keeps its own
      // order in the AST, so the fold would have to reorder them onto the
      // callee's parameter list — refuse rather than guess (rare in a config).
      if ((node.arguments || []).some((a) => a && a.kind === 'namedargument')) {
        return refuse(ctx, node, 'a named argument (`f(name: $v)`) is not modelled: the fold will not reorder arguments');
      }
      const margs = (node.arguments || []).map((a) => evalConfigExpr(a, ctx, depth + 1));
      const what = node.what || {};
      // An argument the fold could not answer is `undefined` — and `undefined`
      // is exactly what JS substitutes for an OMITTED argument, so a callee's
      // default parameter would swallow the refusal and the call would answer a
      // WRONG value with no report (`str_pad('7', 3, '0', STR_PAD_LEFT)` answered
      // '700', the STR_PAD_RIGHT default). A refusal anywhere in the argument
      // list refuses the whole call; the reason stays on ctx.lastRefusal.
      {
        const bad = margs.findIndex((v) => v === undefined);
        if (bad !== -1) {
          return refuse(
            ctx,
            node,
            `argument #${bad + 1} of ${nodeName(what) || 'the call'} is not statically evaluable, and ` +
              `letting the callee's default parameter stand in for it would change the value`
          );
        }
      }
      // A spread argument (`f(...$args)`) would have to be spliced into the
      // parameter list; passing the array as one argument is a different call.
      if ((node.arguments || []).some((a) => a && a.unpack)) {
        return refuse(ctx, node, 'a spread argument (`f(...$args)`) is not modelled');
      }
      // A call on a VALUE: `$fn(...)`, `(function () { ... })()`, `fn() => 1`.
      // The only callables the fold owns are the closures it built itself.
      if (what.kind === 'variable' || what.kind === 'closure' || what.kind === 'arrowfunc') {
        const callee = evalConfigExpr(what, ctx, depth + 1);
        if (typeof callee !== 'function') {
          return refuse(ctx, node, 'the call target is not a closure the fold built');
        }
        try {
          const out = callee(...margs);
          return out === undefined ? refuse(ctx, node, 'the closure answered no value the fold could resolve') : out;
        } catch (e) {
          return refuseFromError(ctx, node, e);
        }
      }
      // A METHOD call: the receiver is an object the fold does not model (a
      // Collection, a ServiceProvider, a Mailable...). PHP boots with the
      // method's answer, so this is refused BY NAME — the live shape is
      // config/app.php's `ServiceProvider::defaultProviders()->merge([...])->toArray()`.
      if (what.kind === 'propertylookup') {
        const method = (what.offset && (what.offset.name || what.offset.value)) || '?';
        return refuse(ctx, node, `the fold does not model the object a '->${method}()' call is made on`);
      }
      // A static method call: `Str::slug(...)` (what is a staticlookup).
      if (what.kind === 'staticlookup') {
        const rawCls = (what.what && (what.what.name || what.what.raw)) || '';
        const method = (what.offset && (what.offset.name || what.offset.value)) || '';
        // A qualified name (`\Illuminate\Support\Str::slug()`) answers its last
        // segment: the fold has no autoloader, and every Str helper it models is
        // deterministic by name. The old code compared the RAW name to 'Str', so
        // a fully-qualified call slipped past the loud failure into a silent drop.
        const cls = String(rawCls).split('\\').filter(Boolean).pop() || '';
        if (cls === 'Str') {
          if (typeof StrMethod[method] === 'function') return StrMethod[method].apply(null, margs);
          if (STR_NONDETERMINISTIC.has(method)) {
            throw new Error(
              `Str::${method}() answers a FRESH value on every boot, so folding one would freeze a ` +
                `different value into the dumped config (tools/static.mjs) — call it at runtime instead`
            );
          }
          // A `Str::` static this evaluator cannot answer. The old code returned
          // `undefined`, which the array/keyed branches DROP WITHOUT A TRACE
          // (see `val === undefined -> continue`) — a config entry silently
          // missing from the dumped config where PHP boots with a value. That
          // is the class of divergence this tool exists to prevent, so fail
          // loud instead (the build then refuses with the reason). Auditor note
          // #608; the same shape as the absent `Str::ascii` in #451, which was
          // only caught by inspection.
          throw new Error(
            `Str::${method}() is not implemented by the build-time config evaluator ` +
              `(tools/static.mjs); it cannot be evaluated statically, and dropping the ` +
              `value would silently change the booted config — declare the value in ` +
              `config/ directly, or add Str::${method}() to the evaluator`
          );
        }
        if (cls === 'PHPVersion' || cls === 'Arr') {
          return refuse(ctx, node, `${rawCls}::${method}() is not modelled by the config fold`);
        }
        return refuse(ctx, node, `the static call ${rawCls}::${method}() is not modelled by the config fold`);
      }
      const fn = what.name;
      if (typeof fn !== 'string') {
        return refuse(ctx, node, `a <${what.kind}> call target is not a function name the fold knows`);
      }
      switch (fn) {
        case 'env': {
          const key = margs[0];
          if (typeof key !== 'string') {
            return refuse(
              ctx,
              node,
              `env() needs a string key (the fold resolved ${key === null ? 'null' : typeof key})`
            );
          }
          // Env::get() (Env.php:252-284): a key PRESENT in the repository answers
          // its value - Option::fromValue('')->map() keeps the empty string, so
          // `env('X', $default)` does NOT fall back for a defined-but-empty X.
          // Only a missing key reaches getOrCall(value($default)).
          if (Object.prototype.hasOwnProperty.call(env, key)) return coerceEnvValue(env[key]);
          return margs.length > 1 ? margs[1] : null;
        }
        // PHP's storage_path() = realpath(storage) . DIRECTORY_SEPARATOR . $path,
        // and the $path arg keeps its internal '/' — on Windows the base is
        // backslash-separated while the arg stays forward: e.g.
        // `...\storage\framework/sessions`. Join with the PLATFORM separator
        // (`path.sep` == PHP's DIRECTORY_SEPARATOR on the host the tool runs on):
        // a literal `\\` answered `...\storage\framework/sessions` on Linux too,
        // where PHP answers `.../storage/framework/sessions` (audit #607).
        case 'storage_path': {
          const base = String(join(appDir, 'storage'));
          const tail = margs.map((x) => String(x ?? '')).filter(Boolean).join('/');
          return tail ? base + sep + tail : base;
        }
        case 'base_path': {
          const base = String(join(appDir, ...margs.map((x) => String(x ?? ''))).replace(/\\+$/, ''));
          return base;
        }
        case 'public_path': return String(join(appDir, 'public', ...margs.map(String).filter(x => x)));
        case 'app_path': return String(join(appDir, 'app', ...margs.map(String).filter(x => x)));
        case 'config_path': return String(join(appDir, 'config', ...margs.map(String).filter(x => x)));
        case 'database_path': return String(join(appDir, 'database', ...margs.map(String).filter(x => x)));
        // The remaining `*_path()` helpers Laravel 11 ships (and their `*_path()`
        // no-arg form: the base directory itself).
        case 'resource_path': return String(join(appDir, 'resources', ...margs.map(String).filter((x) => x)));
        case 'lang_path': return String(join(appDir, 'lang', ...margs.map(String).filter((x) => x)));
        case 'view_path': return String(join(appDir, 'resources', 'views', ...margs.map(String).filter((x) => x)));
        default:
          break;
      }
      // The PHP function library (tools/php-funcs.mjs): implemented functions
      // answer, NAMED refusals (the clock, the RNG, PCRE, sprintf, the container)
      // refuse with their reason, and an unknown name refuses too — never a
      // silent `undefined` that drops the entry from the dumped config.
      if (PHP_REFUSED.has(fn)) return refuse(ctx, node, `PHP ${fn}(): ${PHP_REFUSED.get(fn)}`);
      const funcs = ctx.funcs || (ctx.funcs = phpFuncs(ctx));
      if (Object.prototype.hasOwnProperty.call(funcs, fn)) {
        try {
          const out = funcs[fn](...margs);
          if (out === undefined) {
            return refuse(ctx, node, `${fn}() could not be answered by the fold for these arguments`);
          }
          return out;
        } catch (e) {
          return refuseFromError(ctx, node, e);
        }
      }
      return refuse(ctx, node, `${fn}() is not implemented by the build-time config fold (tools/php-funcs.mjs)`);
    }
    // A bare constant: php-parser answers a `name` node for `PHP_URL_HOST` (a
    // probe of the parser, not a guess). The constant set is PHP_CONSTANTS — the
    // deterministic, platform-independent values only.
    case 'name': {
      const raw = String(node.name || '').replace(/^\\/, '');
      if (PHP_CONSTANTS.has(raw)) return PHP_CONSTANTS.get(raw);
      if (PHP_CONSTANTS_REFUSED.has(raw)) {
        return refuse(ctx, node, `the constant ${raw}: ${PHP_CONSTANTS_REFUSED.get(raw)}`);
      }
      // A `const NAME = ...;` the SAME config file declared (tools/config-script.mjs
      // records it as it executes the file): PHP reads it back here, so the fold
      // must too. Anything else still refuses by name.
      if (ctx.fileConstants && Object.prototype.hasOwnProperty.call(ctx.fileConstants, raw)) {
        return ctx.fileConstants[raw];
      }
      return refuse(ctx, node, `the constant ${raw} is not defined at build time (the fold has no autoloader)`);
    }
    case 'staticlookup': {
      const offset = (node.offset && (node.offset.name || node.offset.value)) || '';
      const what = node.what;
      const cls = what && (what.name || what.raw || '');
      // `Str::slug('x')` — handled in the `call` branch; the config value of
      // `User::class` is the resolved FQCN.
      if (offset === 'class') {
        // Resolve a short class name through the file's imports (use).
        const parsed = ctx.parsed;
        const full = String(cls).replace(/^\\/, '');
        if (parsed && parsed.imports && full in parsed.imports) {
          return parsed.imports[full].replace(/^\\/, '');
        }
        // An unimported name: return it verbatim (PHP `User::class` in the
        // App namespace resolves to App\... when it's not imported, but the
        // namespace root is App here — keep it simple: literal).
        return full;
      }
      // A class constant used as a VALUE (`PHP_URL_HOST` through a class, or a
      // constant of the app's own code, which the fold cannot reach).
      const raw = String(offset).replace(/^\\/, '');
      if (PHP_CONSTANTS.has(raw)) return PHP_CONSTANTS.get(raw);
      if (PHP_CONSTANTS_REFUSED.has(raw)) {
        return refuse(ctx, node, `the constant ${raw}: ${PHP_CONSTANTS_REFUSED.get(raw)}`);
      }
      return refuse(ctx, node, `the class constant ${cls}::${raw} is not resolvable at build time`);
    }
    // `__LINE__` is deterministic (the literal's own line). `__DIR__`/`__FILE__`
    // are the BUILD MACHINE's paths (PHP answers the host it runs on), so folding
    // them would bake `C:\Users\...` into the dumped config for an edge worker
    // that has no such path — refused with that reason, like PHP_EOL.
    case 'magic': {
      const m = String(node.value || '');
      if (m === '__LINE__') return node.loc && node.loc.start ? node.loc.start.line : null;
      return refuse(ctx, node, `magic constant ${m} names the build machine\'s path, which the edge does not have`);
    }
    default:
      return refuse(ctx, node, `expression kind '${node.kind}' is not modelled by the config fold`);
  }
}

/**
 * A thrown value that is not an `Error` names nothing when stringified —
 * `Control { kind: 'break', level: 1 }` used to reach the build as
 * `<file>: [object Object]`, so the failure said nothing at all (audit #774).
 */
function describeThrown(e) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const shape = e.kind ? `kind=${e.kind}${e.level ? ` level=${e.level}` : ''}` : `keys=${Object.keys(e).join(',') || 'none'}`;
    return `the config fold could not finish this file (${shape})`;
  }
  return String(e);
}

/**
 * Load an app's config/*.php files (evaluated with env folding) into a nested
 * object. Returns { config, error, drops } — `drops` is the named list of config
 * values the fold could not answer (printed by tools/config-dump.mjs).
 */
export function loadConfig(appDir, env = {}, options = {}) {
  const configDir = join(appDir, 'config');
  const out = {};
  const drops = [];
  let error = null;

  // Every value the fold could NOT answer lands here, named by group, file, key,
  // line and reason. `tools/config-dump.mjs` prints the report; the build
  // forwards it. Before this the entry was simply missing from the dumped config
  // and nothing said so (auditor notes #50, #608).
  const noteDrop = (d) => {
    if (drops.length < 500) drops.push(d);
  };

  // Laravel's LoadConfiguration: the FRAMEWORK's config/*.php are the base;
  // the app's config/*.php override the same-named groups; a group only the
  // framework has stays (hashing, cors, view...). Mirrored here: app wins,
  // framework fills the gaps.
  //
  // A config file is PHP, not a literal: it may assign variables, loop, include
  // a sibling file and return the array it built. `runConfigStatements()`
  // (tools/config-script.mjs) executes that shape; the old code walked the AST
  // for the FIRST `return` node and evaluated just its expression, so a computed
  // array came out as whatever that one expression happened to be.
  const evalFile = (file, group) => {
    const parsed = parsePhpFile(file);
    if (parsed.error) {
      if (!error) error = parsed.error;
      return null;
    }
    const ctx = {
      env,
      appDir,
      parsed,
      file,
      group,
      scope: Object.create(null),
      scopeReasons: Object.create(null),
      evalExpr: evalConfigExpr,
      // The statement path reports `{kind, line, reason}` — it does not know the
      // key (the refusal happens inside an array entry). Fill in what the caller
      // has so the report never names `undefined.undefined` (audit #774).
      noteDrop: (d) => noteDrop({ group, file, key: d.key, line: d.line, kind: d.kind, reason: d.reason }),
      poisonRef: { hit: null },
    };
    let v;
    try {
      v = runConfigStatements(phpParse8(parsed.source), ctx);
    } catch (e) {
      if (!error) error = `${file}: ${(e && e.message) || describeThrown(e)}`;
      return null;
    }
    if (ctx.poisonRef.hit) {
      // The file EXECUTED something the fold cannot answer (`try/catch`,
      // `static $n`, `foreach ($a as &$v)`, `sort($a)`, a refused expression
      // statement), so the values it built afterwards are guesses: PHP's state
      // and the fold's state already differ. Dropping the single key would leave
      // a config that LOOKS valid and is wrong on the edge — `tools/config-dump.mjs`
      // reports the file and exits non-zero instead (audit #774-#776).
      const hit = ctx.poisonRef.hit;
      if (!error) error = `${file}${hit.line ? ':' + hit.line : ''}: ${hit.reason}`;
      noteDrop({
        group,
        file,
        line: hit.line,
        kind: hit.kind || 'statement',
        key: '<group>',
        reason: `${hit.reason} — every value this file builds after that line is a guess, so the group is not folded at all`,
      });
      return null;
    }
    if (v === undefined) {
      const r = ctx.lastRefusal;
      noteDrop({
        group,
        file,
        line: r ? r.line : null,
        kind: r ? r.kind : 'return',
        key: '<group>',
        reason: (r && r.reason) || 'the file did not return a value the fold could evaluate',
      });
      return null;
    }
    return v;
  };

  // 1. The framework defaults (base) — but only the groups not in the app.
  //    (Laravel's diffKeys: `$base->diffKeys($files)`.)
  const appGroups = new Set();
  if (existsSync(configDir)) {
    try {
      for (const f of readdirSync(configDir)) {
        if (f.endsWith('.php')) appGroups.add(f.replace(/\.php$/, ''));
      }
    } catch (e) { error = e.message || String(e); }
  }

  // The framework config lives wherever the autoloader put it: a composer
  // checkout (`<app>/vendor/...`) or LW_VENDOR_DIR (vendor-lite's cache, or a
  // vendor dir mounted from elsewhere). Laravel's own LoadConfiguration reads it
  // from __DIR__ — here we resolve both layouts so a vendor-less checkout still
  // gets cors/hashing/view defaults whenever a framework copy is reachable.
  const frameworkConfigDir = [
    process.env.LW_VENDOR_DIR ? join(process.env.LW_VENDOR_DIR, 'laravel', 'framework', 'config') : null,
    process.env.LW_VENDOR_DIR ? join(process.env.LW_VENDOR_DIR, 'vendor', 'laravel', 'framework', 'config') : null,
    join(appDir, 'vendor', 'laravel', 'framework', 'config'),
  ].find((p) => p && existsSync(p)) || null;
  if (frameworkConfigDir) {
    try {
      for (const f of readdirSync(frameworkConfigDir)) {
        const name = f.replace(/\.php$/, '');
        if (!name || appGroups.has(name)) continue;
        const v = evalFile(join(frameworkConfigDir, f), name);
        if (v !== null && v !== undefined) out[name] = v;
      }
    } catch (e) { error = error || e.message || String(e); }
  }

  // 2. The app's config/*.php (win).
  if (existsSync(configDir)) {
    const appFiles = [];
    try {
      for (const f of readdirSync(configDir)) if (f.endsWith('.php')) appFiles.push(f);
    } catch (e) { error = error || e.message || String(e); }
    appFiles.sort();
    for (const f of appFiles) {
      const group = f.replace(/\.php$/, '');
      const v = evalFile(join(configDir, f), group);
      if (v !== null && v !== undefined) out[group] = v;
    }
  }

  return { config: out, error, drops };
}

/** The root `return <expr>` node of a parsed PHP file (config/lang files). */
export function returnExpr(parsed) {
  if (!parsed || !parsed.source) return null;
  let retNode = null;
  const ast = phpParse8(parsed.source);
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || retNode) return;
    if (node.kind === 'return') { retNode = node; return; }
    for (const k of Object.keys(node)) { if (k === 'parents') continue; walk(node[k]); }
  })(ast);
  return retNode && retNode.expr ? retNode.expr : null;
}

/** Dotted-path getter on a nested config object (config('a.b.c')). */
export function configGet(cfg, path, def = undefined) {
  const parts = String(path).split('.');
  let cur = cfg;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return def;
    cur = cur[p];
  }
  return cur === undefined ? def : cur;
}

export function classConstants(appDir, parsed, clsNode) {
  // The whole constant table - own, traits, interfaces, parent chain
  // (collectConstants() above), exactly what ReflectionClass::getConstants()
  // answers for the class.
  return { constants: collectConstants(appDir, parsed, clsNode) };
}

export default { classFile, parsePhpFile, classConstants, evalConstantExpr, laravelVersion, appMiddlewareState, appRouteFiles, readEnvFile, coerceEnvValue, evalConfigExpr, loadConfig, configGet };
