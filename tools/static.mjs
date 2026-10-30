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
import { join, dirname, resolve } from 'node:path';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

/**
 * Parse PHP source into an AST with the SHARED php-parser instance (3.x).
 * Exported for the dump tools that need the raw tree (event-dump.mjs walks
 * provider files for bind()/singleton()); it replaces the old
 * `require.presolve.parserClass`, which is undefined in ESM.
 */
export function parsePhpSource(source) {
  return phpParser.parseCode(String(source));
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
  const ast = phpParser.parseCode(src);
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
  const vendorDir = join(appDir, 'vendor');
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
  // No composer mapping matched — try the conventional App\ -> app/ directly.
  if (full.startsWith('App\\')) {
    const fb = join(appDir, 'app', full.slice(4).replace(/\\/g, '/') + '.php');
    // MUST verify: without this every `App\...` FQCN answered a path, so
    // isAppClass() said true for classes that do not exist and a namespaced
    // global (App\Mail\DateTimeInterface) was treated as an app class.
    if (existsSync(fb)) return resolve(fb);
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
    ast = phpParser.parseCode(source);
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
      return Number(node.value);
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
        return v == null ? null : !v;
      }
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
        case '<<': return ln && rn ? l << r : null;
        case '>>': return ln && rn ? l >> r : null;
        case '&': return ln && rn ? l & r : null;
        case '|': return ln && rn ? l | r : null;
        case '^': return ln && rn ? l ^ r : null;
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
      const closure = callArgs(n)
        .map(argValue)
        .find((v) => v && v.kind === 'closure');
      if (closure && closure.body && closure.body.children) {
        for (const st of closure.body.children) {
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
  const ast = phpParser.parseCode(parsed.source);
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
      const closure = callArgs(n).map(argValue).find((v) => v && v.kind === 'closure');
      if (closure && closure.body && closure.body.children) {
        for (const st of closure.body.children) {
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
  walker(phpParser.parseCode(parsed.source));
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
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/"/g, '"');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1);
  }
  return s;
}

/** PHP's string cast for a scalar (concat operands). */
function phpStr(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'object') return 'Object';
  return String(v);
}

/** The Illuminate\Support\Str helpers the config files use — the pure ones. */
const StrMethod = {
  // `Str::slug()` (Str.php slug() + ascii()): the transliteration table keeps
  // the LETTERS of an HTML entity and drops the '&' and ';' — verified against
  // PHP 8.3 + Laravel 13.37: 'A &amp; B' -> 'a-amp-b', 'A & B' -> 'a-b',
  // 'A&nbsp;B' -> 'anbspb', 'A &amp;amp; B' -> 'a-ampamp-b'. Dropping the whole
  // entity (the old `/&[a-z]+;/ -> ''` with a dead `{'&': 'and'}` map) answered
  // 'a-b' where PHP answers 'a-amp-b'.
  // Known limitation: a non-ASCII letter is REMOVED here where PHP's ascii()
  // transliterates it ('Ünïcode' -> PHP 'unicode', this -> 'ncode') — a JS
  // build has no portable-ascii table.
  slug: (value, sep = '-') => String(value)
    .toLowerCase()
    .replace(/&[a-z]+;/g, (e) => e.slice(1, -1))
    .replace(/[&;]/g, '')
    .replace(/[^a-z0-9-]+/g, sep)
    .split(sep + sep).join(sep)
    .replace(new RegExp(sep + '$'), ''),
  lower: (s) => String(s).toLowerCase(),
  upper: (s) => String(s).toUpperCase(),
  ucfirst: (s) => { const t = String(s); return t.charAt(0).toUpperCase() + t.slice(1); },
  trim: (s) => String(s).trim(),
  replace: (search, replace, subject) => String(subject).split(search).join(replace),
  lateLimit: () => undefined,
};
StrMethod.lower = StrMethod.lower;
/** PHP's boolean cast for a condition (used by `?:` / `ternary`).
 * PHP is falsy for: false, 0, -0, 0.0, "0", "", null, [] (empty array).
 * JS additionally keeps `'0'` and `[]` truthy, so a bare `if (c)` would pick
 * the wrong branch for those two — e.g. `env('X') ? a : b` with X='0'.
 */
function phpTruthy(c) {
  if (Array.isArray(c)) return c.length > 0;
  if (c === '0') return false;
  return !!c;
}

/** Evaluate one config expression node (PHP) to a JS value. ctx: { env, appDir }. */
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
    case 'number':
      return Number(node.value);
    case 'string':
      return node.value;
    case 'array': {
      // PHP arrays are ordered maps: JSON encodes as a LIST when the integer
      // keys are 0..n-1 consecutive, else as an OBJECT. Collect into an
      // ordered Map first, then decide the emitted form.
      const entries = []; // [key, value] insertion order, key may be null (auto list)
      let maxIndex = -1;
      let autoCount = 0;
      const autoKeyBudget = new Set();
      for (const e of (node.items || [])) {
        if (!e || e.kind !== 'entry') continue;
        let kv;
        if (e.key) {
          if (e.key.kind === 'string') kv = e.key.value;
          else if (e.key.kind === 'number') kv = Number(e.key.value);
          else kv = evalConfigExpr(e.key, ctx, depth + 1);
        }
        const val = evalConfigExpr(e.value, ctx, depth + 1);
        if (val === undefined) continue; // never give an unknown expression a slot
        if (kv === undefined || kv === null) {
          // A list item: PHP assigns the next integer key (from the max key).
          entries.push({ key: null, val });
          ++autoCount;
        } else {
          entries.push({ key: kv, val });
          if (typeof kv === 'number' && Number.isInteger(kv)) maxIndex = Math.max(maxIndex, kv);
        }
      }
      // Auto keys: PHP uses index of next integer (max+1). Simulate.
      const placed = [];
      const used = new Set();
      for (const it of entries) {
        if (it.key === null) {
          let i = 0;
          while (used.has(i) || (typeof i === 'number' && i <= maxIndex && false)) i++;
          i = maxIndex + 1;
          placed.push([String(i), it.val]);
          used.add(i);
          maxIndex = i;
        } else {
          placed.push([String(it.key), it.val]);
          if (typeof it.key === 'number') used.add(it.key);
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
      const obj = {};
      for (const [k, v] of placed) obj[k] = v;
      return obj;
    }
    case 'bin':
    case 'binary': {
      if (node.type === '??') {
        const l = evalConfigExpr(node.left, ctx, depth + 1);
        if (l !== undefined && l !== null) return l;
        return evalConfigExpr(node.right, ctx, depth + 1);
      }
      if (node.type === '.') {
        const l = evalConfigExpr(node.left, ctx, depth + 1);
        const r = evalConfigExpr(node.right, ctx, depth + 1);
        // undefined = "not statically evaluable"; null is a REAL PHP null,
        // which casts to '' in a concat — `env('X') . '/y'` with X unset is
        // '/y' in PHP, while the old code dropped the whole entry (undefined).
        if (l === undefined || r === undefined) return undefined;
        return phpStr(l) + phpStr(r);
      }
      if (['+', '-', '*', '/', '%', '**'].includes(node.type)) {
        const l = evalConfigExpr(node.left, ctx, depth + 1);
        const r = evalConfigExpr(node.right, ctx, depth + 1);
        if (typeof l !== 'number' || typeof r !== 'number') return undefined;
        switch (node.type) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return r === 0 ? undefined : l / r;
          case '%': return r === 0 ? undefined : l % r;
          case '**': return Math.pow(l, r);
          default: return undefined;
        }
      }
      return undefined;
    }
    case 'ternary': {
      const c = evalConfigExpr(node.test, ctx, depth + 1);
      if (phpTruthy(c)) return evalConfigExpr(node.trueExpr, ctx, depth + 1);
      return evalConfigExpr(node.falseExpr, ctx, depth + 1);
    }
    case 'cast': {
      const v = evalConfigExpr(node.expr, ctx, depth + 1);
      if (v === undefined || v === null) {
        if (node.type === 'array') return [];
        return undefined;
      }
      switch (node.type) {
        case 'bool': return !!v;
        case 'int': {
          // PHP's (int) cast: a bool is 1/0 (parseInt(true) was NaN -> 0), a
          // number truncates toward zero, and a string reads its leading
          // integer ('12.9' -> 12, '0x1A' -> 0, 'abc' -> 0).
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'number') return Math.trunc(v) || 0;
          const n = parseInt(String(v), 10);
          return Number.isNaN(n) ? 0 : n;
        }
        case 'float': {
          if (typeof v === 'boolean') return v ? 1 : 0;
          const f = parseFloat(v);
          return Number.isNaN(f) ? 0 : f;
        }
        case 'string': return String(v);
        case 'array': return Array.isArray(v) ? v : [];
        default: return undefined;
      }
    }
    case 'call': {
      const fn = node.what && node.what.name;
      const margs = (node.arguments || []).map((a) => evalConfigExpr(a, ctx, depth + 1));
      // A static method call: `Str::slug(...)` etc. (what is staticlookup).
      if (node.what && node.what.kind === 'staticlookup') {
        const cls = node.what.what && (node.what.what.name || '');
        const method = (node.what.offset && node.what.offset.name) || '';
        if (cls === 'Str' && typeof StrMethod[method] === 'function') {
          return StrMethod[method].apply(null, margs);
        }
        return undefined;
      }
      switch (fn) {
        case 'env': {
          const key = margs[0];
          if (typeof key !== 'string') return undefined;
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
        // `...\storage\framework/sessions`. Replicate byte-for-byte.
        case 'storage_path': {
          const base = String(join(appDir, 'storage'));
          const tail = margs.map((x) => String(x ?? '')).filter(Boolean).join('/');
          return tail ? base + '\\' + tail : base;
        }
        case 'base_path': {
          const base = String(join(appDir, ...margs.map((x) => String(x ?? ''))).replace(/\\+$/, ''));
          return base;
        }
        case 'public_path': return String(join(appDir, 'public', ...margs.map(String).filter(x => x)));
        case 'app_path': return String(join(appDir, 'app', ...margs.map(String).filter(x => x)));
        case 'config_path': return String(join(appDir, 'config', ...margs.map(String).filter(x => x)));
        case 'database_path': return String(join(appDir, 'database', ...margs.map(String).filter(x => x)));
        default:
          return undefined;
      }
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
        const full = cls.replace(/^\\/, '');
        if (parsed && parsed.imports && full in parsed.imports) {
          return parsed.imports[full].replace(/^\\/, '');
        }
        // An unimported name: return it verbatim (PHP `User::class` in the
        // App namespace resolves to App\... when it's not imported, but the
        // namespace root is App here — keep it simple: literal).
        return full;
      }
      return undefined;
    }
    case 'magic':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Load an app's config/*.php files (evaluated with env folding) into a nested
 * object. Returns { config, error }.
 */
export function loadConfig(appDir, env = {}) {
  const configDir = join(appDir, 'config');
  const out = {};
  let error = null;

  // Laravel's LoadConfiguration: the FRAMEWORK's config/*.php are the base;
  // the app's config/*.php override the same-named groups; a group only the
  // framework has stays (hashing, cors, view...). Mirrored here: app wins,
  // framework fills the gaps.
  const evalFile = (file) => {
    const parsed = parsePhpFile(file);
    if (parsed.error) { if (!error) error = parsed.error; return null; }
    let retNode = null;
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'return') { retNode || (retNode = node); return; }
      for (const k of Object.keys(node)) { if (k === 'parents') continue; walk(node[k]); }
    })(phpParser.parseCode(parsed.source));
    if (!retNode) return null;
    const v = evalConfigExpr(retNode.expr, { env, appDir, parsed });
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
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
        const v = evalFile(join(frameworkConfigDir, f));
        const parsed = parsePhpFile(join(frameworkConfigDir, f));
        if (!parsed.error && v) out[name] = v;
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
      const v = evalFile(join(configDir, f));
      if (v) out[group] = v;
    }
  }

  return { config: out, error };
}

/** The root `return <expr>` node of a parsed PHP file (config/lang files). */
export function returnExpr(parsed) {
  if (!parsed || !parsed.source) return null;
  let retNode = null;
  const ast = phpParser.parseCode(parsed.source);
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
