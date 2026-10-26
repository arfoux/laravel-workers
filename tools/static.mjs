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
import { join, resolve } from 'node:path';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

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
    return resolve(fb);
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
        case '.': return String(l) + String(r);
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

/** The evaluated constants map of a class (used for `OtherClass::CONST`). */
function collectConstants(appDir, parsed, clsNode, file) {
  const selfConstants = {};
  let ctx0 = { appDir, parsed, parsedCache: {} };
  for (const stmt of (clsNode.body || [])) {
    if (stmt.kind !== 'classconstant') continue;
    for (const c of stmt.constants || []) {
      const name = nodeName(c.name);
      if (!name) continue;
      selfConstants[name] = evalConstantExpr(c.value, { ...ctx0, selfConstantsMap: {} });
    }
  }
  const out = {};
  for (const stmt of (clsNode.body || [])) {
    if (stmt.kind !== 'classconstant') continue;
    for (const c of stmt.constants || []) {
      const name = nodeName(c.name);
      if (!name) continue;
      const val = evalConstantExpr(c.value, { ...ctx0, selfConstantsMap: selfConstants });
      if (val === null && !(c.value && (c.value.kind === 'nullkeyword' || c.value.kind === 'null'))) continue;
      out[name] = val;
    }
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

/** String array literal -> JS array of strings (a static `except: [...]`). */
function stringArray(node) {
  if (!node || node.kind !== 'array') return null;
  const out = [];
  for (const e of (node.items || [])) {
    if (!e || e.kind !== 'entry') return null;
    const v = e.value;
    if (!v || v.kind !== 'string') return null;
    out.push(v.value);
  }
  return out;
}

/** The name of a class-referencing argument node (`[\X\Y::class]` -> 'X\Y'). */
function classListOf(node) {
  if (!node || node.kind !== 'array') return null;
  const out = [];
  for (const e of (node.items || [])) {
    if (!e || e.kind !== 'entry') return null;
    const v = e.value;
    if (!v || v.kind !== 'staticlookup') return null;
    const raw = (v.what && (v.what.raw || v.what.name)) || '';
    out.push(raw.replace(/^\\/, ''));
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
 *   { cookiesExcept, csrfExcept, allowSameSite, originOnly, globalMiddleware }
 * Unknown/unparseable calls are skipped (the app gets default state), never
 * guessed. For Laravel 9/10 the middleware callbacks live on the Kernel
 * classes; this returns null and the caller uses the defaults.
 */
export function appMiddlewareState(appDir) {
  const bootFile = join(appDir, 'bootstrap', 'app.php');
  if (!existsSync(bootFile)) return null;
  const parsed = parsePhpFile(bootFile);
  if (parsed.error) return null;

  const state = {
    cookiesExcept: [],
    csrfExcept: [],
    allowSameSite: false,
    originOnly: false,
    globalMiddleware: [],
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
            applyConfigCall(st.expression, state);
          }
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw') continue;
      walker(n[k]);
    }
  };
  walker(phpParser.parseCode(parsed.source));
  return state;
}

function applyConfigCall(expr, state) {
  const name = callMethodName(expr);
  if (!name) return;
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
      const v = named('middleware') || argValue(args[0]);
      const list = classListOf(v);
      if (list) state.globalMiddleware = list;
      break;
    }
    default:
      break;
  }
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
          const p = raw.replace(/^['"]|['"]$/g, '');
          if (a.name === 'web') out.web = abs(appDir, p);
          else if (a.name === 'api') out.api = abs(appDir, p);
          else if (a.name === 'commands') out.commands = abs(appDir, p);
          else if (a.name === 'health') out.health = p;
          else if (a.name === 'pages') out.pages = abs(appDir, p);
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

// ---------------------------------------------------------------------------
// config/*.php evaluator -> the runtime config (env folding + helpers)
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into a key/value map. Values already present in process
 * env win (immutable semantics, like Laravel's Dotenv createImmutable).
 */
export function readEnvFile(appDir, extra = {}) {
  const env = { ...extra };
  const p = join(appDir, '.env');
  if (!existsSync(p)) return env;
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return env; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('export ')) {
      if (line.startsWith('export ')) {
        const body = line.slice(7).trim();
        const eq = body.indexOf('=');
        if (eq <= 0) continue;
        env[body.slice(0, eq).trim()] = dotenvValue(body.slice(eq + 1).trim());
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    env[key] = dotenvValue(line.slice(eq + 1).trim());
  }
  return env;
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
  // Quoted (optionally with backslash escapes like PHP/JSON double quotes).
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/"/g, '"');
  }
  return s;
}

/** The Illuminate\Support\Str helpers the config files use — the pure ones. */
const StrMethod = {
  slug: (value, sep = '-') => String(value)
    .toLowerCase()
    .replace(/&[a-z]+;/g, (e) => ({ '&': 'and' })[e] || '')
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
        if (l === undefined || l === null || r === undefined || r === null) return undefined;
        return String(l) + String(r);
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
      if (c) return evalConfigExpr(node.trueExpr, ctx, depth + 1);
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
        case 'int': return parseInt(v, 10) || 0;
        case 'float': return parseFloat(v) || 0;
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
          // Process.env wins (Dotenv immutable semantics), then .env, then default.
          if (Object.prototype.hasOwnProperty.call(env, key)) return env[key] === '' ? (margs.length > 1 ? margs[1] : null) : env[key];
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
  const selfConstants = {};
  for (const stmt of (clsNode.body || [])) {
    if (stmt.kind !== 'classconstant') continue;
    for (const c of stmt.constants || []) {
      const name = nodeName(c.name);
      if (!name) continue;
      selfConstants[name] = evalConstantExpr(c.value, { appDir, parsed });
    }
  }
  // Resolve `self::X` references (possibly chained) with the full map known.
  const resolved = {};
  for (const stmt of (clsNode.body || [])) {
    if (stmt.kind !== 'classconstant') continue;
    for (const c of stmt.constants || []) {
      const name = nodeName(c.name);
      if (!name) continue;
      const ctx = { appDir, parsed, selfConstantsMap: selfConstants, selfConstants, selfName: name };
      const val = evalConstantExpr(c.value, ctx);
      if (val === null && !(c.value && (c.value.kind === 'nullkeyword' || c.value.kind === 'null'))) continue;
      resolved[name] = val;
    }
  }
  return { constants: resolved };
}

export default { classFile, parsePhpFile, classConstants, evalConstantExpr, laravelVersion, appMiddlewareState, appRouteFiles, readEnvFile, evalConfigExpr, loadConfig, configGet };
