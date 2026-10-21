// compiler/src/transpiler.mjs
import parser from 'php-parser';
import { STR_METHODS } from '../../kernel/str.mjs';
import { ADAPTER_ASYNC } from '../../kernel/service-adapters.mjs';

const phpParser = new parser({ parser: { extractDoc: false }, ast: { withPositions: true } });

// PHP variable names are mangled to JS identifiers so reserved words ($null, $new, ...) are safe.
const vname = (name) => 'v_' + String(name).replace(/^\\$/, '').replace(/[^A-Za-z0-9_]/g, '_');
const fname = (name) => 'fn_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');
// The global helpers whose runtime name differs from the Laravel one.
const RENAME_FUNCS = new Map([
  ['abort_if', 'abortIf'],
  ['abort_unless', 'abortUnless'],
  ['data_get', 'dataGet'],
  ['throw_if', 'throwIf'],
  ['throw_unless', 'throwUnless'],
]);
// The PHP built-in exceptions: the only classes a compiled controller may
// instantiate. An app class (`new App\\Exceptions\\Mine`) is not compiled
// - it fails loud, it never becomes a silent stub.
const NEW_CLASSES = new Set([
  'Exception',
  'Error',
  'ErrorException',
  'RuntimeException',
  'LogicException',
  'InvalidArgumentException',
  'OutOfRangeException',
  'OutOfBoundsException',
  'LengthException',
  'DomainException',
  'RangeException',
  'OverflowException',
  'UnderflowException',
  'UnexpectedValueException',
  'TypeError',
  'ValueError',
  'ArithmeticError',
  'DivisionByZeroError',
  'ArgumentCountError',
  'AssertionError',
  'UnhandledMatchError',
  'JsonException',
]);
// The Log facade levels that compile (the padanan is the platform log).
const LOG_LEVELS = new Set(['info', 'warning', 'error', 'debug', 'notice']);
// The Mail facade methods that compile (the padanan is the mailer: log/noop/resend).
// The methods that deliver are async at the edge — the compiled code awaits them.
const MAIL_SYNC = new Set(['to', 'cc', 'bcc']);
const MAIL_ASYNC = new Set(['send', 'sendNow', 'raw', 'html', 'queue', 'later']);
function mkErr(code, message, loc, hint) {
  const e = new Error(message);
  e.lw = { code, message, line: loc?.start?.line ?? 0, column: loc?.start?.column ?? 0, hint: hint || '' };
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
    case 'number': {
      // The int/float distinction matters (PHP's `===` and `match`): 1 and 1.0
      // are different values, so a float literal must stay a float literal.
      const raw = String(node.value);
      return /[.eE]/.test(raw) ? raw : String(Number(raw));
    }
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
      if (node.name === 'this' && CTX) {
        // Inside a compiled class method, `$this` is the instance (the method
        // is a plain function, so `this` is the object it is called on). A
        // constructor compiles into a factory, so it names its own object.
        if (CTX.classMethod) return CTX.thisVar || 'this';
        throw mkErr('LW002', '$this is not supported in transpiled controllers — ' + PORT_HINT, node.loc, PORT_HINT);
      }
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
      // `$arr[]` (a read without an offset) is a PHP warning + null; the
      // compiled side must not read a "null" key.
      if (!node.offset) {
        throw mkErr('LW002', 'an array read without an offset ($arr[]) is not compiled', node.loc, PORT_HINT);
      }
      return tx(node.what) + '[' + txOffsetKey(node.offset) + ']';
    }
    case 'staticlookup': {
      // `SomeClass::CONSTANT` — a class constant read (e.g. RouteServiceProvider::HOME).
      // The value is dumped at build time (tools/constants-dump.php) and baked into
      // the handler, so the edge never has to know the class.
      const cls = node.what && node.what.name;
      const name = node.offset && node.offset.name;
      if (typeof cls !== 'string' || typeof name !== 'string') {
        throw mkErr('LW002', 'unsupported class constant access', node.loc);
      }
      // `Model::class` — the class name as a string. Only a model the build knows
      // can be named at the edge (the Gate check uses it as its subject).
      if (name === 'class') {
        const alias = String(cls).replace(/^\\/, '');
        const fqcn = CTX && CTX.modelClassFqcns ? CTX.modelClassFqcns.get(alias) : null;
        if (!fqcn) {
          throw mkErr(
            'LW002',
            'the class name ' + alias + '::class is not available at the edge — only a registered Eloquent model can be named — ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        return JSON.stringify(fqcn);
      }
      const constants = CTX && CTX.constants ? CTX.constants : null;
      const value = constants ? constants[cls] : null;
      if (value && Object.prototype.hasOwnProperty.call(value, name)) {
        return JSON.stringify(value[name]);
      }
      throw mkErr(
        'LW002',
        'class constant ' + cls + '::' + name + ' is not available at the edge — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    case 'propertylookup': {
      const name = node.offset && node.offset.name;
      if (typeof name !== 'string') {
        throw mkErr('LW002', 'unsupported property access', node.loc);
      }
      if (CTX && node.what && node.what.kind === 'call') {
        const _m = requestMethodOfCall(node.what);
        if (_m && REQUEST_NO_CHAIN.has(_m)) {
          throw mkErr('LW002', '$request->' + _m + '() result cannot be chained - ' + PORT_HINT, node.loc, PORT_HINT);
        }
      }
      // A relation / an accessor read as a property ($post->comments). It
      // used to answer null - a wrong answer, silently. The build stops.
      if (CTX && CTX.modelVars && node.what && node.what.kind === 'variable') {
        const mv = vname(node.what.name);
        const kind = CTX.modelVars.get(mv);
        if (kind === 'model' || kind === 'list') {
          const alias = CTX.modelAlias ? CTX.modelAlias.get(mv) : null;
          const names = alias && CTX.modelNotCompiled ? CTX.modelNotCompiled.get(alias) : null;
          if (names && names.includes(name)) {
            throw mkErr(
              'LW003',
              'the model attribute "' + name + '" is not compiled (a relation or an accessor?) - the compiled rung has no relations; ' + PORT_HINT,
              node.loc,
              PORT_HINT
            );
          }
        }
      }
      return 'rt.prop(' + tx(node.what) + ', ' + JSON.stringify(name) + ')';
    }
    case 'nullsafeproperty':
      throw mkErr('LW002', 'nullsafe property access (?->) is not supported', node.loc);
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
      // The elvis operator (`$a ?: $b`): the test is evaluated ONCE (PHP
      // evaluates it once - emitting it twice would run a side effect twice).
      if (!node.trueExpr) {
        // The elvis operator (`$a ?: $b`): the test is evaluated ONCE (PHP
        // evaluates it once - emitting it twice would run a side effect
        // twice), and the else branch runs only when the test is falsy (PHP
        // is lazy here too).
        return 'rt.elvis(() => (' + tx(node.test) + '), () => (' + tx(node.falseExpr) + '))';
      }
      const test = tx(node.test);
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
      // The spread (`[...$a, ...$b]`): the values of the array, in order (the
      // keys are dropped - PHP's spread builds a list).
      const spread = items.filter((it) => it.unpack);
      if (spread.length) {
        if (items.some((it) => it.key != null)) {
          throw mkErr('LW002', 'an array literal with a spread and a key is not compiled (PHP drops the keys of the spread parts)', node.loc);
        }
        return '[' + items.map((it) => (it.unpack ? '...rt.spread(' + tx(it.value) + ')' : tx(it.value))).join(', ') + ']';
      }
      const isAssoc = items.some((it) => it.key != null);
      if (isAssoc) {
        const pairs = items.map((it) => txOffsetKey(it.key) + ': ' + tx(it.value));
        return '{' + pairs.join(', ') + '}';
      }
      return '[' + items.map((it) => tx(it.value)).join(', ') + ']';
    }
    case 'new':
      // `new SomeException('msg')` - the PHP built-in exceptions only. The
      // class name is resolved by PHP already (an unqualified name falls
      // back to the global namespace), so it is matched as written.
      if (!node.what || node.what.kind !== 'name') {
        throw mkErr(
          'LW002',
          'new <expression> is not supported - only the PHP built-in exceptions compile; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      const cls = String(node.what.name).replace(/^\\/, '');
      const ctorArgs = (node.arguments || []).map(tx).join(', ');
      // The app classes the build compiled (the event classes and their
      // listeners): `new PostPublished($id)` -> the compiled constructor.
      if (CTX && CTX.classFqcns) {
        const fqcn = CTX.classFqcns.get(cls) || (CTX.classes && CTX.classes.has(cls) ? cls : null);
        if (fqcn) {
          return 'rt.newClass(' + JSON.stringify(fqcn) + (ctorArgs ? ', [' + ctorArgs + ']' : ', []') + ')';
        }
      }
      if (cls.includes('\\')) {
        // A mailable (the app's Mail namespace): it renders its own Blade
        // view, so the compiled rung could not prove the payload. The build
        // stops with that reason, not with "the class is unknown".
        if (/\\Mail\\/.test(cls)) {
          throw mkErr(
            'LW002',
            'new ' + cls + '() is not supported — ' + MAILABLE_REASON + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        throw mkErr(
          'LW002',
          'new ' + cls + '() is not supported - the app classes are not compiled (the class compiler compiles the ' +
            'event classes and their listeners); ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      if (!NEW_CLASSES.has(cls)) {
        throw mkErr(
          'LW002',
          'new ' + cls + '() is not supported - only the PHP built-in exceptions compile (' +
            [...NEW_CLASSES].join(', ') + '); ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return 'rt.newError(' + JSON.stringify(cls) + (ctorArgs ? ', ' + ctorArgs : '') + ')';
    case 'call':
      return txCall(node);
    case 'closure':
      return txClosure(node);
    case 'arrowfunc':
      return txArrowFunc(node);
    case 'cast': {
      // `(string) $x`, `(int) $x`, `(bool) $x`, `(float) $x` — the PHP casts.
      const type = String(node.type || '').toLowerCase();
      const value = node.expr ? tx(node.expr) : 'null';
      if (type === 'string') return 'rt.str(' + value + ')';
      if (type === 'int' || type === 'integer') return 'rt.intval(' + value + ')';
      if (type === 'bool' || type === 'boolean') return 'rt.truthy(' + value + ')';
      if (type === 'float' || type === 'double' || type === 'real') {
        return 'rt.floatval(' + value + ')';
      }
      throw mkErr(
        'LW002',
        'the (' + type + ') cast is not compiled (string, int, bool and float are) - ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
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
      // PHP's `??` short-circuits: the right side runs only when the left is
      // null. The native JS `??` does the same (and the left side is
      // evaluated once).
      return '(' + L() + ' ?? ' + R() + ')';
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

// The variables the compiled code sets itself (PHP's get_defined_vars()): the
// data the view/controller was given is not in here — only the locals.
let LOCAL_VARS = [];

// ---- controller transpilation state (injected by `transpileControllerMethod`) ----
// CTX is null when compiling Blade views; set to {models, views} when compiling a
// controller method body. It enables: model query chains, redirect()/response()->json(),
// view()/abort()/compact(), and await-based async codegen for D1 queries.
let CTX = null;
let CLOSURE_DEPTH = 0;
// The kinds of the view data: a Blade view carries no type information, so the
// build tells the compiler what the view receives ({ paginator: 'paginator' }
// for the pagination view).
let VIEW_DATA_KINDS = null;

// Static model calls that START a chain (return a query builder, no await).
const MODEL_STATIC_START = new Set(['where', 'whereIn']);
// Static model calls that are terminal (return a Promise, must be awaited).
// `create` writes a row (Eloquent::create) — it needs the D1 binding.
const MODEL_STATIC_TERMINAL = new Set(['find', 'findOrFail', 'all', 'create', 'paginate']);
// Chainable builder methods (kernel db.mjs API). Keep in sync with kernel/db.mjs.
const MODEL_CHAIN_BUILDER = new Set([
  'where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
  'orderBy', 'orderByDesc', 'latest', 'oldest', 'limit', 'offset', 'select',
]);
// Terminal builder methods (return a Promise).
const MODEL_CHAIN_TERMINAL = new Set(['first', 'firstOrFail', 'get', 'count', 'pluck', 'value', 'paginate']);
// The paginator's surface (kernel/paginator.mjs - the LengthAwarePaginator).
// `links()` renders the pagination view (the compiled `pagination::tailwind`).
const PAGINATOR_METHODS = new Set([
  'items', 'getCollection', 'count', 'isEmpty', 'isNotEmpty', 'total', 'perPage',
  'currentPage', 'lastPage', 'getPageName', 'onEachSide', 'firstItem', 'lastItem',
  'hasPages', 'hasMorePages', 'onFirstPage', 'onLastPage', 'path', 'query',
  'fragment', 'appends', 'withQueryString', 'url', 'previousPageUrl',
  'nextPageUrl', 'getUrlRange', 'elements', 'links',
]);
// The methods of the compiled model instance (kernel/model.mjs) - keep in
// sync. A method that is not here (a relation, for example) is not compiled:
// the build stops instead of answering a 500 at the edge.
const MODEL_INSTANCE_METHODS = new Set([
  'get', 'set', 'fill', 'forceFill', 'toJSON', 'trashed', 'increment',
  'save', 'delete', 'forceDelete', 'restore', 'refresh',
  'related', 'load', 'loadCount', 'loadAggregate',
  'setRelation', 'getRelation', 'relationLoaded',
]);

const PORT_HINT = 'write a port handler for this route (build --scaffold) instead';

// ---------------------------------------------------------------------------
// HTTP helpers available inside a compiled controller (7b)
// ---------------------------------------------------------------------------
// `session()`, `old()`, `csrf_token()`, `csrf_field()`, `request()` map straight
// onto rt.* (which reads the live session/request handed down by the kernel).
// `auth()` / `Auth::*` need the request context too and the guard resolves the
// user asynchronously (Timebox), so in controller mode those calls are awaited.
const HTTP_HELPERS = new Set(['session', 'old', 'csrf_token', 'csrf_field', 'request', 'cache']);
// Recaller/guard methods that return a promise at the edge.
const AUTH_ASYNC = new Set(['check', 'guest', 'user', 'id', 'attempt', 'once', 'login', 'logout']);
const AUTH_FACADE_RE = /^rt\.auth\((?:[^()]*)\)(?:\.guard\((?:[^()]*)\))?$/;
// Cache facade methods that hit the D1-backed store (async at the edge).
// The Cache facade methods that hit the D1-backed store (async at the edge).
// `putMany` is not in the list: the store's putMany has another signature
// than the Repository's, so it would write the wrong thing - it fails loud.
const CACHE_ASYNC = new Set([
  'get', 'has', 'put', 'add', 'forever', 'forget', 'remember', 'pull',
  'increment', 'decrement', 'touch', 'flush', 'many',
]);
// Hash facade methods (bcrypt).
const HASH_FACADE = new Set(['make', 'check', 'needsRehash', 'isHashed']);
// The Storage facade: the compiled store's surface (the same methods, the same
// return values as Laravel's FilesystemAdapter).
const STORAGE_ASYNC = { put: 'put', get: 'getText', exists: 'exists', delete: 'delete' };
// `Storage::disk('x')` compiles to the store itself — the fluent form.
const STORAGE_FACADE_RE = /^rt\.storage\(\)$/;
// The fluent mail form: `Mail::to($u)->send($m)` compiles to
// `rt.mail().to($u).send($m)` — the send is async at the edge.
const MAIL_FACADE_RE = /^rt\.mail\(\)/;
// Eloquent instance writes — they need the D1 binding and are async.
const INSTANCE_DB_METHODS = new Set(['save', 'delete', 'forceDelete', 'restore', 'push', 'refresh']);
// Session store mutation methods that touch the handler and are therefore async
// on the compiled Store (kernel/session.mjs). regenerateToken() stays sync.
const SESSION_STORE_RE = /(?:^|\.)session\(\)$/;
const SESSION_ASYNC = new Set(['regenerate', 'invalidate', 'migrate']);

// $request->method() allowlist (sync unless listed in REQUEST_ASYNC). Anything
// else fails loud at build time so the route falls back to a port instead of
// silently returning wrong data at the edge.
const REQUEST_CALL = new Set([
  'input', 'all', 'query', 'post', 'has', 'hasAny', 'filled', 'isNotFilled', 'missing',
  'only', 'except', 'string', 'str', 'integer', 'float', 'boolean', 'isMethod', 'method',
  'path', 'url', 'fullUrl', 'ajax', 'pjax', 'expectsJson', 'wantsJson', 'acceptsAnyContentType',
  'prefetch', 'header', 'headers', 'hasHeader', 'bearerToken', 'cookie', 'hasCookie', 'ip',
  'userAgent', 'route', 'session', 'json',
  // The upload: the file object of a multipart body.
  'file', 'hasFile', 'allFiles',
]);
const REQUEST_ASYNC = new Set(['user']);
// Request methods whose result is a primitive/Stringable value that must NOT be
// chained (Laravel's Stringable chains are not modelled by the compiled rung).
const REQUEST_NO_CHAIN = new Set(['input','all','query','post','has','hasAny','filled','isNotFilled','missing','only','except','string','str','integer','float','boolean','isMethod','method','path','url','fullUrl','ajax','pjax','expectsJson','wantsJson','acceptsAnyContentType','prefetch','header','headers','hasHeader','bearerToken','cookie','hasCookie','ip','userAgent','json','hasFile','allFiles']);
const REQUEST_DENY = new Set([
  // `$request->files` is a *property* in Laravel (Symfony's FileBag), not a
  // method: the compiled side has no FileBag, so it fails loud.
  'files',
]);
// The methods of an uploaded file the compiled rung has. The file object is
// what `$request->file('x')` returns (the kernel's Illuminate\Http\UploadedFile).
const FILE_METHODS = new Set([
  'getClientOriginalName', 'getClientOriginalExtension', 'getClientMimeType',
  'getSize', 'isValid', 'store', 'storeAs',
]);
// The file methods that write to the object store (async at the edge).
const FILE_ASYNC = new Set(['store', 'storeAs']);
// The validation rules that read the file's *content* type (finfo): the edge
// has only the type the browser declared, so the verdict would differ from
// PHP's. The build stops instead of answering differently at the edge.
const CONTENT_MIME_RULES = new Set(['mimes', 'mimetypes', 'image', 'dimensions']);

// The content-mime rule in an inline rule set (`$request->validate(['a' =>
// 'mimes:png'])`), or null when there is none. The rules are literals in the
// source, so the build sees them.
function contentMimeRuleInAst(node) {
  let found = null;
  const scan = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) scan(x);
      return;
    }
    if (n.kind === 'string' && typeof n.value === 'string') {
      for (const token of n.value.split('|')) {
        const name = String(token).split(':')[0].trim();
        if (CONTENT_MIME_RULES.has(name)) {
          found = name;
          return;
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      scan(n[key]);
    }
  };
  scan(node);
  return found;
}

function requestMethodOfCall(callNode) {
  if (!callNode || callNode.kind !== 'call') return null;
  const w = callNode.what;
  if (!w || w.kind !== 'propertylookup') return null;
  const inner = w.what;
  if (!inner || inner.kind !== 'variable') return null;
  if (!CTX || !CTX.requestVars || !CTX.requestVars.has(vname(inner.name))) return null;
  return (typeof w.offset?.name === 'string') ? w.offset.name : null;
}

// The kind of an uploaded-file expression: `$request->file('x')` is a file,
// `$request->allFiles()` is a map of them.
function fileExprKind(node) {
  const m = requestMethodOfCall(node);
  if (m === 'file') return 'file';
  if (m === 'allFiles') return 'files';
  return null;
}

// A method call on an uploaded file: only the compiled surface is allowed and
// the ones that write to the object store are awaited.
const FILE_METHOD_REASONS = {
  storePublicly: 'it needs the public disk (the edge has one object store - the app\'s default disk)',
  move: 'it moves the file on a filesystem (the edge has no filesystem)',
  get: 'it returns the file\'s bytes (a JS string would re-encode them)',
  getMimeType: 'it reads the file\'s content type (finfo)',
  guessExtension: 'it reads the file\'s content type (finfo)',
  extension: 'it reads the file\'s content type (finfo)',
  hashName: 'it reads the file\'s content type (finfo)',
};
function txFileMethod(obj, meth, args, node) {
  if (!FILE_METHODS.has(meth)) {
    const reason = FILE_METHOD_REASONS[meth];
    throw mkErr(
      'LW003',
      'the uploaded file method ->' + meth + '() is not compiled' + (reason ? ' — ' + reason : '') +
        ' — allowed: ' + [...FILE_METHODS].join(', ') + '; ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const expr = obj + '.' + meth + '(' + args + ')';
  return FILE_ASYNC.has(meth) ? txAwait(expr, node, 'the uploaded file->' + meth + '()') : expr;
}

function txRequestCall(node, args) {
  const what = node.what;
  if (!what || what.kind !== 'propertylookup') return null;
  const inner = what.what;
  if (!inner || inner.kind !== 'variable') return null;
  if (!CTX || !CTX.requestVars || !CTX.requestVars.has(vname(inner.name))) return null;
  const meth = what.offset && what.offset.name;
  if (typeof meth !== 'string') {
    throw mkErr('LW002', 'unsupported $request property access', node.loc, PORT_HINT);
  }
  if (REQUEST_DENY.has(meth)) {
    // `$request->files` is Symfony's FileBag (a property, not a method): the
    // compiled side has no FileBag. The upload itself is compiled: the file
    // comes from `$request->file('x')`.
    throw mkErr(
      'LW002',
      '$request->' + meth + '() is not compiled — in Laravel it is a property (Symfony\'s FileBag), not a method: ' +
        'use $request->file(\'x\') (the uploaded file) or $request->allFiles() (every file); ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  // $request->validate($rules, $messages?, $attributes?) — runs kernel/validator
  // over the request input; a failure throws ValidationException, which the HTTP
  // kernel renders as redirect-back + flashed errors/old input (or 422 JSON).
  if (meth === 'validate' || meth === 'validateWithBag') {
    // A rule that reads the file's *content* type (finfo) cannot be answered
    // like PHP at the edge (the edge has only the type the browser declared),
    // so the build stops and names the rule.
    const mimeRule = contentMimeRuleInAst(node.arguments && node.arguments[0]);
    if (mimeRule) {
      throw mkErr(
        'LW002',
        'the ' + mimeRule + ' validation rule is not compiled — it reads the file\'s *content* type (finfo) and the edge ' +
          'cannot sniff the content like PHP does: use the file rule with max (the size in kilobytes) instead, or check ' +
          'the extension in the controller; ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    const expr = vname(inner.name) + '.' + meth + '(' + args + ')';
    return txAwait(expr, node, '$request->' + meth + '()');
  }
  // FormRequest::validated() — the input restricted to the ruled attributes.
  // The kernel request keeps the validator's validated data (the same value
  // FormRequest::validated() returns); the rules are dumped at build time.
  if (meth === 'validated' || meth === 'safe') {
    const fr = CTX && CTX.formRequests ? CTX.formRequests.get(vname(inner.name)) : null;
    if (!fr) {
      throw mkErr(
        'LW002',
        '$request->' + meth + '() is only available on a FormRequest parameter — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    if (meth === 'safe') {
      throw mkErr('LW002', 'FormRequest::safe() is not supported — ' + PORT_HINT, node.loc, PORT_HINT);
    }
    return vname(inner.name) + '.validated()';
  }
  if (!REQUEST_CALL.has(meth)) {
    throw mkErr(
      'LW002',
      'unsupported $request->' + meth + '() — allowed: ' + [...REQUEST_CALL].join(', ') + '; ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const expr = vname(inner.name) + '.' + meth + '(' + args + ')';
  return REQUEST_ASYNC.has(meth) ? txAwait(expr, node, '$request->' + meth + '()') : expr;
}

function txAwait(expr, node, label = 'database query') {
  if (CLOSURE_DEPTH > 0) {
    throw mkErr('LW002', label + ' inside a closure is not supported — move the query outside the closure', node.loc, PORT_HINT);
  }
  return '(await ' + expr + ')';
}

// The FQCN of a model class as it is written in the source ('Post' ->
// 'App\Models\Post'): the build knows both keys.
function modelFqcnOf(root) {
  if (!CTX || !CTX.modelClassFqcns) return null;
  const key = String(root).replace(/^\\/, '');
  return CTX.modelClassFqcns.get(key) || null;
}

// Detects a model query chain starting at a model class static call.
// Returns { root, segments } or null. segments[0] is the static call; the rest are ->method() calls.
function modelChain(node) {
  if (!CTX || !CTX.models) return null;
  const segs = [];
  let root = null;
  let cur = node;
  while (cur && cur.kind === 'call') {
    const what = cur.what;
    if (!what) return null;
    if (what.kind === 'propertylookup') {
      const name = what.offset && what.offset.name;
      if (typeof name !== 'string') return null;
      segs.unshift({ name, node: cur });
      cur = what.what;
    } else if (what.kind === 'staticlookup') {
      // The leading backslash of a fully-qualified name is stripped (PHP has
      // already resolved it — the namespace must not be prefixed again).
      const cls = what.what && what.what.name ? String(what.what.name).replace(/^\\/, '') : null;
      const name = what.offset && what.offset.name;
      if (typeof cls !== 'string' || typeof name !== 'string') return null;
      if (!CTX.models.has(cls)) return null;
      segs.unshift({ name, node: cur });
      root = cls;
      break;
    } else {
      return null;
    }
  }
  if (!root) return null;
  return { root, segments: segs };
}

function txModelChain(chain, node) {
  const { root, segments } = chain;
  const first = segments[0];
  const firstArgs = (first.node.arguments || []).map(tx).join(', ');
  const clsLit = JSON.stringify(root);
  let expr;
  if (MODEL_STATIC_START.has(first.name)) {
    expr = 'rt.model(' + clsLit + ').' + first.name + '(' + firstArgs + ')';
  } else if (MODEL_STATIC_TERMINAL.has(first.name)) {
    if (segments.length > 1) {
      throw mkErr('LW003', root + '::' + first.name + '() cannot be chained — ' + PORT_HINT, node.loc, PORT_HINT);
    }
    expr = txAwait('rt.model(' + clsLit + ').' + first.name + '(' + firstArgs + ')', first.node);
  } else {
    throw mkErr('LW003', 'unsupported static call ' + root + '::' + first.name + '() — only find, findOrFail, all, where, whereIn, create transpile at the edge', node.loc, PORT_HINT);
  }
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const at = (seg.node.arguments || []).map(tx).join(', ');
    if (MODEL_CHAIN_BUILDER.has(seg.name)) {
      expr += '.' + seg.name + '(' + at + ')';
    } else if (MODEL_CHAIN_TERMINAL.has(seg.name)) {
      if (i !== segments.length - 1) {
        throw mkErr('LW003', 'cannot chain past ->' + seg.name + '() — ' + PORT_HINT, seg.node.loc, PORT_HINT);
      }
      if (seg.name === 'paginate') {
        // The paginator needs the request (the page, the path, the query).
        expr = txAwait('rt.paginate(' + expr + ', ' + at + ')', seg.node);
      } else {
        expr = txAwait(expr + '.' + seg.name + '(' + at + ')', seg.node);
      }
    } else {
      throw mkErr('LW003', 'unsupported query method ->' + seg.name + '() — ' + PORT_HINT, seg.node.loc, PORT_HINT);
    }
  }
  return expr;
}

// redirect(...), redirect()->route(...), redirect()->to(...), response()->json(...)
function txRedirectChain(node) {
  const what = node.what;
  if (!what) return null;
  if (what.kind === 'name' && what.name === 'redirect') {
    const argNodes = node.arguments || [];
    if (argNodes.length === 0) {
      throw mkErr('LW002', "redirect() with no target is not supported — use redirect('/path') or redirect()->route('name')", node.loc, PORT_HINT);
    }
    if (argNodes.length > 2) throw mkErr('LW002', 'redirect() supports at most 2 arguments', node.loc, PORT_HINT);
    return 'rt.redirect(' + argNodes.map(tx).join(', ') + ')';
  }
  if (what.kind === 'propertylookup') {
    const inner = what.what;
    const m = what.offset && what.offset.name;
    if (!inner || inner.kind !== 'call' || !inner.what || inner.what.kind !== 'name') return null;
    const base = inner.what.name;
    const innerArgs = inner.arguments || [];
    if (base === 'redirect') {
      // The flash modifiers: redirect('/x')->with('k','v')->withInput()->withErrors(...)
      // The runtime applies the flash to the session (Laravel's flash lives
      // there for the next request) and returns the same redirect.
      if (m === 'with' || m === 'withInput' || m === 'withErrors') {
        const a = node.arguments || [];
        if (m === 'with' && a.length === 0) {
          throw mkErr(
            'LW002',
            'redirect()->with() needs a key (or an array of key/value pairs)',
            node.loc,
            PORT_HINT
          );
        }
        return (
          'rt.redirect(' + innerArgs.map(tx).join(', ') + ').' + m + '(' + a.map(tx).join(', ') + ')'
        );
      }
      if (innerArgs.length !== 0) throw mkErr('LW002', 'unsupported redirect(...) usage', node.loc, PORT_HINT);
      if (m === 'away') {
        const a = node.arguments || [];
        if (a.length !== 1) {
          throw mkErr('LW002', 'redirect()->away() needs one URL', node.loc, PORT_HINT);
        }
        return 'rt.redirect(' + a.map(tx).join(', ') + ')';
      }
      if (m === 'route') {
        const a = node.arguments || [];
        if (!a.length) throw mkErr('LW002', 'redirect()->route() needs a route name', node.loc, PORT_HINT);
        if (a[0].kind !== 'string') throw mkErr('LW002', 'redirect()->route() name must be a string literal', node.loc, PORT_HINT);
        return 'rt.redirect(rt.route(' + a.map(tx).join(', ') + '))';
      }
      if (m === 'to') {
        const a = node.arguments || [];
        if (!a.length) throw mkErr('LW002', 'redirect()->to() needs a location', node.loc, PORT_HINT);
        return 'rt.redirect(' + a.map(tx).join(', ') + ')';
      }
      // Redirector::intended($default = '/') -> pull('url.intended', $default).
      if (m === 'intended') {
        const a = node.arguments || [];
        if (a.length > 1) throw mkErr('LW002', 'redirect()->intended() supports at most 1 argument', node.loc, PORT_HINT);
        const def = a.length ? tx(a[0]) : '"/"';
        return 'rt.redirect(rt.session().pull("url.intended", ' + def + '))';
      }
      throw mkErr('LW002', 'unsupported redirect()->' + m + '() — ' + PORT_HINT, node.loc, PORT_HINT);
    }
    if (base === 'cache') {
      // cache()->put(...) - the same async D1 surface as the Cache facade.
      if (!CACHE_ASYNC.has(m)) {
        throw mkErr(
          'LW002',
          'Cache::' + m + '() is not supported - allowed: ' + [...CACHE_ASYNC].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      const cacheArgs = (node.arguments || []).map(tx).join(', ');
      return txAwait('rt.cache().' + m + '(' + cacheArgs + ')', node, 'Cache::' + m + '()');
    }
    if (base === 'response') {
      if (innerArgs.length !== 0) throw mkErr('LW002', 'unsupported response(...) usage', node.loc, PORT_HINT);
      if (m === 'json') {
        const a = node.arguments || [];
        if (a.length < 1 || a.length > 2) throw mkErr('LW002', 'response()->json() needs 1-2 arguments', node.loc, PORT_HINT);
        return 'rt.json(' + a.map(tx).join(', ') + ')';
      }
      throw mkErr('LW002', 'unsupported response()->' + m + '() — ' + PORT_HINT, node.loc, PORT_HINT);
    }
  }
  return null;
}

// A mailable renders its own Blade view. The compiled rung would have to
// compile the mailable, render that view and produce the very same payload —
// and the shadow harness would have to compare the mail payload byte for byte
// (it cannot today: the log format differs). So the payload could not be
// proven, and the build stops with that reason.
const MAILABLE_REASON =
  'a mailable renders its own Blade view: the compiled rung would have to compile the mailable, render that view ' +
  'and produce the very same payload, and the shadow harness would have to compare the mail payload byte for byte ' +
  '(it cannot today - the log format differs), so the payload could not be proven - ';

// The Queue facade: the call is refused, so the compiled route cannot push
// at all. The wording is the runtime's own (compiler/runtime/rt-from-context.mjs
// throws the same when a route reaches rt.queue()): the job would never run
// at the edge - the worker has no queue handler, nothing consumes the queue
// binding, and the binding carries a JSON body, not a PHP job.
const queueRefusal = (m) =>
  'Queue::' + m + '() is not supported — the job would never run at the edge: the worker has no queue handler, so ' +
  'nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job. The paths that work: a ' +
  'Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid ' +
  'plan charges per operation), or a D1 table the cron trigger reads (a port handler ' +
  'writes the row — the edge has no producer for it) — ' + PORT_HINT;
// The facades whose work the edge cannot do with the same result. The message
// says WHY (the structural reason), not "unknown class".
const UNSUPPORTED_FACADES = {
  Event: (m) =>
    'Event::' + m + '() is not supported — the compiled rung dispatches the event objects it compiled (the listeners ' +
    'are compiled too); a registration like this has no compiled counterpart, so it would be a silent no-op — ' + PORT_HINT,
  'Illuminate\\Support\\Facades\\Event': (m) =>
    'Event::' + m + '() is not supported — the compiled rung dispatches the event objects it compiled (the listeners ' +
    'are compiled too); a registration like this has no compiled counterpart, so it would be a silent no-op — ' + PORT_HINT,
  Mail: (m) => 'Mail::' + m + '() is not supported — ' + MAILABLE_REASON + PORT_HINT,
  'Illuminate\\Support\\Facades\\Mail': (m) => 'Mail::' + m + '() is not supported — ' + MAILABLE_REASON + PORT_HINT,
  Queue: (m) => queueRefusal(m),
  'Illuminate\\Support\\Facades\\Queue': (m) => queueRefusal(m),
};

// The Gate checks the compiled rung answers: Gate::allows() / Gate::denies().
// The ability must be a literal and the subject must be a model (or Model::class).
const GATE_CALLS = new Set(['allows', 'denies']);

function txGate(node, meth) {
  const argNodes = node.arguments || [];
  if (!GATE_CALLS.has(meth)) {
    if (meth === 'authorize') {
      throw mkErr(
        'LW002',
        'Gate::authorize() is not supported — it throws an AuthorizationException (a 403); use Gate::allows() and abort(403) — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    if (meth === 'any' || meth === 'none') {
      throw mkErr(
        'LW002',
        'Gate::' + meth + '() is not supported — allowed: allows, denies — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    if (meth === 'define' || meth === 'before' || meth === 'after' || meth === 'policy' || meth === 'resource') {
      throw mkErr(
        'LW002',
        'Gate::' + meth + '() is not supported — the global Gate registrations are not compiled (the policies are) — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    throw mkErr(
      'LW002',
      'Gate::' + meth + '() is not supported — allowed: allows, denies — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (argNodes.length !== 2) {
    throw mkErr(
      'LW002',
      'Gate::' + meth + '() takes an ability and a subject — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const abilityNode = argNodes[0];
  if (!abilityNode || abilityNode.kind !== 'string') {
    throw mkErr(
      'LW002',
      'the Gate ability must be a string literal so it can be compiled — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const ability = String(abilityNode.value);
  if (ability.indexOf('-') !== -1) {
    throw mkErr(
      'LW002',
      'the Gate ability "' + ability + '" is not supported — Laravel camelizes a dashed ability (Str::camel); use the camel name — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  // The subject: a model instance (a variable that holds one) or Model::class.
  const subjectNode = argNodes[1];
  let subjectExpr = null;
  let subjectFqcn = null;
  if (subjectNode && subjectNode.kind === 'variable') {
    const v = vname(subjectNode.name);
    const kind = CTX && CTX.modelVars ? CTX.modelVars.get(v) : null;
    if (kind !== 'model') {
      throw mkErr(
        'LW002',
        'the Gate subject must be a model — $' + subjectNode.name + ' does not hold one — ' + PORT_HINT,
        subjectNode.loc,
        PORT_HINT
      );
    }
    subjectFqcn = CTX && CTX.modelVarFqcns ? CTX.modelVarFqcns.get(v) : null;
    if (!subjectFqcn) {
      throw mkErr(
        'LW002',
        'the model of the Gate subject ($' + subjectNode.name + ') is not known at build time — ' + PORT_HINT,
        subjectNode.loc,
        PORT_HINT
      );
    }
    subjectExpr = v;
  } else if (
    subjectNode &&
    subjectNode.kind === 'staticlookup' &&
    subjectNode.offset &&
    subjectNode.offset.name === 'class'
  ) {
    const alias = String((subjectNode.what && subjectNode.what.name) || '').replace(/^\\/, '');
    subjectFqcn = CTX && CTX.modelClassFqcns ? CTX.modelClassFqcns.get(alias) : null;
    if (!subjectFqcn) {
      throw mkErr(
        'LW002',
        'the Gate subject ' + alias + '::class is not a registered Eloquent model — ' + PORT_HINT,
        subjectNode.loc,
        PORT_HINT
      );
    }
  } else {
    throw mkErr(
      'LW002',
      'the Gate subject must be a model or Model::class — ' + PORT_HINT,
      subjectNode ? subjectNode.loc : node.loc,
      PORT_HINT
    );
  }
  // The policy metadata (the build dumped it: the policy, its abilities, the
  // guest rules, the global Gate callbacks).
  const policies = CTX && CTX.policies ? CTX.policies : new Map();
  const pol = policies.get(subjectFqcn);
  if (!pol) {
    throw mkErr(
      'LW003',
      'the policy for ' + subjectFqcn + ' was not dumped at build time — the Gate check cannot be answered at the edge — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (pol.compileError) {
    throw mkErr(
      'LW003',
      'the policy for ' + subjectFqcn + ' did not compile: ' + pol.compileError + ' — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (pol.error && pol.error !== 'no policy') {
    throw mkErr(
      'LW003',
      'the policy for ' + subjectFqcn + ' could not be read (' + pol.error + ') — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (pol.globalBefore) {
    throw mkErr(
      'LW002',
      'the app registers a global Gate::before() callback — the compiled rung cannot run it — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (pol.globalAfter) {
    throw mkErr(
      'LW002',
      'the app registers a global Gate::after() callback — the compiled rung cannot run it — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if ((pol.definedAbilities || []).indexOf(ability) !== -1) {
    throw mkErr(
      'LW002',
      'the ability "' + ability + '" is defined with Gate::define() — the compiled rung compiles the policy methods only — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  if (pol.hasMagicCall) {
    throw mkErr(
      'LW002',
      'the policy ' + (pol.policy || subjectFqcn) + ' has a __call() — the compiled rung cannot know which ability it answers — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  const m = (pol.methods || {})[ability];
  if (m && subjectExpr === null && (m.params || []).length > 1) {
    throw mkErr(
      'LW003',
      'the ability "' + ability + '" needs a subject — a class-level check (' + subjectFqcn + '::class) cannot call it — ' + PORT_HINT,
      node.loc,
      PORT_HINT
    );
  }
  CTX.usedGate = true;
  const deny = meth === 'denies';
  const args =
    JSON.stringify(ability) +
    ', ' +
    (subjectExpr === null ? 'null' : subjectExpr) +
    ', ' +
    JSON.stringify(subjectFqcn) +
    ', ' +
    (deny ? 'true' : 'false');
  return txAwait('rt.gate(' + args + ')', node, 'Gate::' + meth + '()');
}

function txCall(node) {
  const what = node.what;
  // A facade that needs a class the build cannot compile fails loud with its
  // own reason — before the arguments are translated (an argument may be a
  // class name the edge does not know).
  if (what && what.kind === 'staticlookup' && CTX && CTX.controller) {
    const cls0 = what.what && what.what.name ? String(what.what.name).replace(/^\\/, '') : '';
    const meth0 = what.offset && what.offset.name;
    // The event dispatch: the compiled listeners (the classes the build
    // compiled). Laravel dispatches synchronously, so the edge does too.
    if (
      (cls0 === 'Event' || cls0 === 'Illuminate\\Support\\Facades\\Event') &&
      meth0 === 'dispatchUntil'
    ) {
      // Laravel's dispatchUntil() is the halt variant: it stops at the first
      // non-null answer and returns it. The compiled dispatch runs EVERY
      // listener and answers the array of the responses, so the compiled rung
      // cannot answer Laravel's value here.
      throw mkErr(
        'LW002',
        'Event::dispatchUntil() is not supported — it stops the chain at the first non-null answer and returns it ' +
          '(the halt semantics); the compiled dispatch runs every listener and answers the array of the responses, so ' +
          'it cannot answer Laravel\'s value — ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    if (
      (cls0 === 'Event' || cls0 === 'Illuminate\\Support\\Facades\\Event') &&
      meth0 === 'dispatch'
    ) {
      const args = node.arguments || [];
      if (args.length !== 1) {
        throw mkErr(
          'LW002',
          'Event::dispatch() takes the event only (the payload and the halt flag are not compiled) — ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      const arg = args[0];
      const eventClass =
        arg && (arg.kind === 'new' || arg.kind === 'call') && arg.what && arg.what.kind === 'name'
          ? String(arg.what.name).replace(/^\\/, '')
          : null;
      const fqcn =
        eventClass && CTX.classFqcns
          ? CTX.classFqcns.get(eventClass) || (CTX.classes && CTX.classes.has(eventClass) ? eventClass : null)
          : null;
      // The event (or one of its listeners) did not compile: the build knows
      // WHY (the listener is queued, the listener injects a service, ...). The
      // dispatch would be a silent no-op, so the build stops and names it.
      const blockedKey = eventClass ? CTX.classFqcns.get(eventClass) || eventClass : null;
      const blockedWhy = blockedKey ? CTX.classBlocked.get(blockedKey) : null;
      if (blockedWhy) {
        throw mkErr(
          'LW002',
          'Event::dispatch() cannot compile the event ' + eventClass + ' — ' + blockedWhy + ' — ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      if (!fqcn) {
        throw mkErr(
          'LW002',
          'Event::dispatch() needs an instance of a compiled event class — the edge dispatches the compiled listeners, so a ' +
            'dispatch of an event the build did not compile would be a silent no-op — ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      CTX.usedEvents = true;
      return txAwait('rt.event.dispatch(' + tx(arg) + ')', node, 'Event::dispatch()');
    }
    const tailor = UNSUPPORTED_FACADES[cls0];
    if (tailor && typeof meth0 === 'string') {
      throw mkErr('LW002', tailor(meth0), node.loc, PORT_HINT);
    }
  }
  const args = (node.arguments || []).map(tx).join(', ');
  if (CTX) {
    const redir = txRedirectChain(node);
    if (redir) return redir;
    const chain = modelChain(node);
    if (chain) return txModelChain(chain, node);
    const reqCall = txRequestCall(node, args);
    if (reqCall) return reqCall;
  }
  if (what.kind === 'name') {
    const name = what.name;
    if (name === 'response') {
      // Illuminate\Routing\ResponseFactory::make() — a text/html response by
      // default (the compiled kernel serves the body as-is).
      const a = node.arguments || [];
      const headers = "{ 'content-type': 'text/html; charset=utf-8' }";
      if (a.length === 0) return '{ status: 200, headers: ' + headers + ', body: "" }';
      if (a.length === 1) return '{ status: 200, headers: ' + headers + ', body: ' + tx(a[0]) + ' }';
      if (a.length === 2) {
        return '{ status: ' + tx(a[1]) + ', headers: ' + headers + ', body: ' + tx(a[0]) + ' }';
      }
      return (
        '{ status: ' + tx(a[1]) + ', headers: Object.assign(' + headers + ', ' + tx(a[2]) + '), body: ' + tx(a[0]) + ' }'
      );
    }
    if (name === 'app') {
      if ((node.arguments || []).length === 0) return 'rt.app()';
      return 'rt.app(' + args + ')';
    }
    if (name === '__') {
      // The translation helper: __($key, $replace = []). The strings are
      // dumped at build time (the app's lang/ + the framework's fallback), so
      // the key must be a literal. It is used in a view too (the pagination
      // view), so it is handled outside the controller-only block.
      const a = node.arguments || [];
      if (a.length > 2) throw mkErr('LW002', '__() takes at most 2 arguments', node.loc, PORT_HINT);
      if (!a.length || a[0].kind !== 'string') {
        throw mkErr(
          'LW002',
          '__() needs a literal key at the edge (the translations are dumped at build time)',
          node.loc,
          PORT_HINT
        );
      }
      return 'rt.__(' + args + ')';
    }
    const argNodes = node.arguments || [];
    const cbRef = (n) => (n && n.kind === 'string' && FUNCS.has(n.value) ? fname(n.value) : null);
    if (name === 'array_map') {
      const cb = cbRef(argNodes[0]);
      if (!cb) throw mkErr('LW001', 'array_map requires a named function callback', node.loc);
      return 'rt.array_map(' + cb + ', ' + tx(argNodes[1]) + ')';
    }
    if (name === 'array_filter') {
      const cb = cbRef(argNodes[1]);
      if (argNodes.length > 1 && !cb) throw mkErr('LW001', 'array_filter callback must be a named function', node.loc);
      return 'rt.array_filter(' + tx(argNodes[0]) + (cb ? ', ' + cb : '') + ')';
    }
    if (CTX && CTX.controller && HTTP_HELPERS.has(name)) {
      const a = node.arguments || [];
      if (name === 'session') {
        if (a.length === 0) return 'rt.session()';
        if (a.length > 2) throw mkErr('LW002', 'session() supports at most 2 arguments', node.loc, PORT_HINT);
        if (a[0].kind === 'array') {
  // Laravel's session([...]) writes many keys: session()->put([...]).
  return 'rt.session().put(' + a.map(tx).join(', ') + ')';
        }
        return 'rt.session().get(' + a.map(tx).join(', ') + ')';
      }
      if (name === 'cache') {
        const a = node.arguments || [];
        if (a.length === 0) return 'rt.cache()';
        if (a[0].kind === 'closure' || a[0].kind === 'arrowfunc') {
          throw mkErr(
            'LW002',
            'cache($callback, $key) is not supported - use Cache::remember($callback, $key)',
            node.loc,
            PORT_HINT
          );
        }
        if (a[0].kind === 'array') {
          throw mkErr(
            'LW002',
            'cache([...]) is not supported - use cache()->put($key, $value)',
            node.loc,
            PORT_HINT
          );
        }
        // cache('k') / cache('k', $default) - a GET (the second argument is the
        // default, NOT a value to store).
        return txAwait('rt.cache().get(' + a.map(tx).join(', ') + ')', node, 'cache()');
      }
      if (name === 'env') {
        const a = node.arguments || [];
        if (a.length !== 1 || a[0].kind !== 'string') {
          throw mkErr(
            'LW002',
            'env() needs a literal key at the edge (the build-time config dump is the padanan)',
            node.loc,
            PORT_HINT
          );
        }
        return 'rt.env(' + args + ')';
      }
      if (name === 'old') {
        if (a.length === 0 || a.length > 2) throw mkErr('LW002', 'old() needs 1-2 arguments', node.loc, PORT_HINT);
        return 'rt.old(' + args + ')';
      }
      if (name === 'csrf_token' || name === 'csrf_field') {
        if (a.length) throw mkErr('LW002', name + '() takes no arguments', node.loc, PORT_HINT);
        return 'rt.' + name + '()';
      }
      if (name === 'request') {
        if (a.length) throw mkErr('LW002', 'request(...) with arguments is not supported', node.loc, PORT_HINT);
        return 'rt.request()';
      }
    }
    if (CTX) {
      if (name === 'view') {
        const vn = argNodes[0];
        if (!vn || vn.kind !== 'string') {
          throw mkErr('LW002', 'view() name must be a string literal so it can be compiled at build time', node.loc, PORT_HINT);
        }
        if (CTX.views && !CTX.views.has(vn.value)) {
          throw mkErr('LW002', 'view "' + vn.value + '" was not compiled for this controller — ' + PORT_HINT, node.loc, PORT_HINT);
        }
        return 'rt.view(' + args + ')';
      }
      if (name === 'abort') return 'rt.abort(' + args + ')';
      if (name === 'compact') {
        const keys = [];
        for (const a of argNodes) {
          if (a.kind !== 'string') throw mkErr('LW001', 'compact() requires string literal variable names', node.loc, PORT_HINT);
          keys.push(a.value);
        }
        return '{ ' + keys.map((k) => JSON.stringify(k) + ': ' + vname(k)).join(', ') + ' }';
      }
    }
    const whitelisted = new Set(['e', 'str_replace', 'config', 'public_path', 'file_exists', 'url', 'route', 'auth']);
    const builtins = new Set([
      'isset', 'empty', 'unset', 'count', 'in_array', 'implode', 'explode',
      'sprintf', 'strtolower', 'strtoupper', 'trim', 'number_format', 'nl2br',
      'strlen', 'substr', 'str_repeat', 'str_contains', 'str_starts_with', 'str_ends_with',
      'ucfirst', 'lcfirst', 'str_pad', 'array_key_exists', 'array_keys', 'array_values', 'array_merge',
      'array_diff_key',
      'ltrim', 'rtrim', 'ucwords', 'strrev', 'strpos', 'strrpos', 'substr_count', 'strip_tags', 'htmlspecialchars',
      'is_null', 'is_bool', 'is_boolean', 'is_int', 'is_integer', 'is_long', 'is_float', 'is_double', 'is_real',
      'is_string', 'is_array', 'is_object', 'is_numeric', 'is_callable', 'is_countable',
      'abs', 'round', 'floor', 'ceil', 'intval', 'floatval', 'max', 'min',
      'json_encode', 'json_decode', 'optional',
      'array_sum', 'array_slice', 'array_reverse', 'array_unique', 'array_count_values', 'array_flip',
      'now',
      'today',
      'back',
      'tap',
      'report',
      'env',
      'collect',
    ]);
    // get_defined_vars() — the variables the compiled code sees (the data it
    // was given + the locals it set itself). A layout is rendered with them.
    if (name === 'get_defined_vars') {
      if (node.arguments && node.arguments.length) {
        throw mkErr('LW002', 'get_defined_vars() takes no arguments', node.loc, PORT_HINT);
      }
      const locals = LOCAL_VARS.map((v) => JSON.stringify(String(v).replace(/^v_/, '')) + ': ' + v).join(', ');
      return 'rt.vars({' + locals + '})';
    }
    if (whitelisted.has(name) || builtins.has(name)) return 'rt.' + name + '(' + args + ')';
    if (RENAME_FUNCS.has(name)) return 'rt.' + RENAME_FUNCS.get(name) + '(' + args + ')';
    if (FUNCS.has(name)) return fname(name) + '(' + args + ')';
    throw mkErr('LW001', 'unknown function ' + name, node.loc);
  }
  if (what.kind === 'staticlookup') {
    // A fully-qualified static call keeps its leading backslash in the AST
    // (`\Illuminate\Support\Facades\Cache::get()`) — strip it before matching.
    const cls = what.what && what.what.name ? String(what.what.name).replace(/^\\/, '') : undefined;
    const meth = what.offset && what.offset.name;
    if (cls === 'Route' && meth === 'has') return 'rt.Route.has(' + args + ')';
    if (cls === 'ValidationException' || cls === 'Illuminate\\Validation\\ValidationException') {
      if (meth !== 'withMessages') {
        throw mkErr(
          'LW002',
          'ValidationException::' + meth + '() is not supported — only withMessages(); ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return 'rt.validationExceptionWithMessages(' + args + ')';
    }
    // Illuminate\Support\Facades\Log — the platform log (the Workers console).
    if ((cls === 'Log' || cls === 'Illuminate\\Support\\Facades\\Log') && CTX && CTX.controller) {
      if (!LOG_LEVELS.has(meth)) {
        throw mkErr(
          'LW002',
          'Log::' + meth + '() is not supported — allowed: ' + [...LOG_LEVELS].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return 'rt.log(' + JSON.stringify(meth) + (args ? ', ' + args : '') + ')';
    }
    // Illuminate\Support\Facades\Mail — the mailer (log/noop/resend). The
    // fluent form (Mail::to($u)->send($m)) compiles too: the pending's send
    // is async at the edge, so the compiled code awaits it.
    if ((cls === 'Mail' || cls === 'Illuminate\\Support\\Facades\\Mail') && CTX && CTX.controller) {
      if (MAIL_SYNC.has(meth)) {
        return 'rt.mail().' + meth + '(' + args + ')';
      }
      if (MAIL_ASYNC.has(meth)) {
        return txAwait('rt.mail().' + meth + '(' + args + ')', node, 'Mail::' + meth + '()');
      }
      throw mkErr(
        'LW002',
        'Mail::' + meth + '() is not supported — allowed: ' +
          [...MAIL_SYNC, ...MAIL_ASYNC].join(', ') + '; ' + PORT_HINT,
        node.loc,
        PORT_HINT
      );
    }
    // Illuminate\Support\Str - the string helpers (the PHP-exact subset).
    if ((cls === 'Str' || cls === 'Illuminate\\Support\\Str') && CTX && CTX.controller) {
      if (!STR_METHODS.has(meth)) {
        throw mkErr(
          'LW002',
          'Str::' + meth + '() is not supported - allowed: ' + [...STR_METHODS].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return 'rt.Str.' + meth + '(' + args + ')';
    }
    // Illuminate\Support\Facades\Cache — the D1-backed `database` cache store.
    if ((cls === 'Cache' || cls === 'Illuminate\\Support\\Facades\\Cache') && CTX && CTX.controller) {
      if (meth === 'tags') {
        throw mkErr(
          'LW002',
          'Cache::tags() is not supported — the compiled cache store is the D1 `database` store, which has no tags: ' +
            'in Laravel this route 500s with BadMethodCallException("This cache store does not support tagging."); ' +
            'the build refuses the route before it ships (stricter than Laravel, not a parity), and a taggable ' +
            'store (redis/memcached) is not compiled — ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      if (!CACHE_ASYNC.has(meth)) {
        throw mkErr(
          'LW002',
          'Cache::' + meth + '() is not supported — allowed: ' + [...CACHE_ASYNC].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait('rt.cache().' + meth + '(' + args + ')', node, 'Cache::' + meth + '()');
    }
    // Illuminate\Support\Facades\Storage — the R2-backed store (the padanan for
    // the app's default disk). The flat static calls and the fluent disk form
    // of the DEFAULT disk compile; a named disk needs a bucket of its own and
    // fails loud.
    if ((cls === 'Storage' || cls === 'Illuminate\\Support\\Facades\\Storage') && CTX && CTX.controller) {
      if (meth === 'disk') {
        const diskArgs = node.arguments || [];
        if (diskArgs.length !== 1 || !diskArgs[0] || diskArgs[0].kind !== 'string') {
          throw mkErr(
            'LW002',
            'the disk name must be a string literal so the build can check it (the compiled rung has one object store: the app\'s default disk) — ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        const name = String(diskArgs[0].value);
        const storage = CTX.storage || {};
        const def = storage.defaultDisk;
        if (!def) {
          throw mkErr(
            'LW002',
            'the build does not know the app\'s default disk (config/filesystems.php) — the compiled rung has ONE object store, so the disk name cannot be resolved — ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        if (name !== def) {
          const known = Array.isArray(storage.disks) ? storage.disks : [];
          if (known.length && known.indexOf(name) === -1) {
            throw mkErr(
              'LW002',
              'the disk \'' + name + '\' is not configured (the app\'s disks are: ' + known.join(', ') + ') — ' + PORT_HINT,
              node.loc,
              PORT_HINT
            );
          }
          const where = known.length
            ? "the app's disks are: " + known.join(', ') + " (the default is '" + def + "')"
            : "the app's default disk is '" + def + "'";
          throw mkErr(
            'LW002',
            'Storage::disk(\'' + name + '\') is not supported — the compiled rung has ONE object store (the padanan for the app\'s default disk); a named disk needs a bucket of its own (R2 asks for a credit card) — ' +
              where + ' — ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        return 'rt.storage()';
      }
      if (!STORAGE_ASYNC[meth]) {
        throw mkErr(
          'LW002',
          'Storage::' + meth + '() is not supported — allowed: ' + Object.keys(STORAGE_ASYNC).join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait('rt.storage().' + STORAGE_ASYNC[meth] + '(' + args + ')', node, 'Storage::' + meth + '()');
    }
    // Illuminate\Support\Facades\Hash — bcrypt, with the app's configured rounds.
    if ((cls === 'Hash' || cls === 'Illuminate\\Support\\Facades\\Hash') && CTX && CTX.controller) {
      if (!HASH_FACADE.has(meth)) {
        throw mkErr(
          'LW002',
          'Hash::' + meth + '() is not supported — allowed: ' + [...HASH_FACADE].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      if (meth === 'isHashed') return 'rt.hash.isHashed(' + args + ')';
      return txAwait('rt.hash.' + meth + '(' + args + ')', node, 'Hash::' + meth + '()');
    }
    if ((cls === 'Auth' || cls === 'Illuminate\\Support\\Facades\\Auth') && CTX && CTX.controller) {
      if (!AUTH_ASYNC.has(meth)) {
        throw mkErr(
          'LW002',
          'Auth::' + meth + '() is not supported — allowed: ' + [...AUTH_ASYNC].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait('rt.auth().' + meth + '(' + args + ')', node, 'Auth::' + meth + '()');
    }
    // Illuminate\\Support\\Facades\\Gate — the policy check (the policies are
    // compiled at build time; the global Gate callbacks are not).
    if ((cls === 'Gate' || cls === 'Illuminate\\Support\\Facades\\Gate') && CTX && CTX.controller) {
      return txGate(node, meth);
    }
    // The facades whose work is a class the build cannot compile: the message
    // says why (the listeners / the mailable / the job), not "unknown class".
    throw mkErr('LW003', 'unknown class/static ' + cls + '::' + meth, node.loc);
  }
  if (what.kind === 'propertylookup') {
    const obj = tx(what.what);
    if (CTX && what.what && what.what.kind === 'call') {
      const _m = requestMethodOfCall(what.what);
      if (_m && REQUEST_NO_CHAIN.has(_m)) {
        throw mkErr('LW002', '$request->' + _m + '() result cannot be chained - ' + PORT_HINT, node.loc, PORT_HINT);
      }
    }
    const meth = what.offset && what.offset.name;
    if (!meth) throw mkErr('LW002', 'property access without method', node.loc);
    // The service the constructor injected (`$this->mailer->send(...)`): its
    // methods are async in the compiled world, so the call is awaited (a
    // promise must never leak into the response — the mail would never be
    // sent, and a rejection would be swallowed).
    if (CTX && CTX.injectedDeps instanceof Map && CTX.injectedDeps.size) {
      const inner = what.what;
      const prop =
        inner && inner.kind === 'propertylookup' && inner.what && inner.what.kind === 'variable' && inner.what.name === 'this'
          ? inner.offset && inner.offset.name
          : null;
      const dep = prop ? CTX.injectedDeps.get(prop) : null;
      const isAsync = dep
        ? dep.kind === 'class' || (dep.adapter && ADAPTER_ASYNC[dep.adapter] && ADAPTER_ASYNC[dep.adapter].has(meth))
        : false;
      if (isAsync) {
        // A compiled class takes the runtime as its first argument (the
        // compiled methods are `async function (rt, ...)`); a framework
        // service takes only its own arguments.
        const callArgs = dep.kind === 'class' ? (args ? 'rt, ' + args : 'rt') : args;
        return txAwait(obj + '.' + meth + '(' + callArgs + ')', node, '$this->' + prop + '->' + meth + '()');
      }
    }
    if (!meth) throw mkErr('LW002', 'property access without method', node.loc);
    // The uploaded file: `$request->file('x')->store('avatars')` (the chained
    // form) and `$file->store('avatars')` (the variable holds a file). The
    // methods that write to the object store are awaited.
    if (CTX && CTX.controller) {
      const chainedFile = what.what.kind === 'call' && requestMethodOfCall(what.what) === 'file';
      const varFile = what.what.kind === 'variable' && CTX.fileVars && CTX.fileVars.has(vname(what.what.name));
      if (chainedFile || varFile) return txFileMethod(obj, meth, args, node);
    }
    // `Storage::disk('x')->put(...)` — the fluent disk form. The compiled store
    // has the same surface (and the same return values) as the flat facade
    // calls; a method outside it fails loud (a promise must never leak into a
    // response).
    if (CTX && CTX.controller && STORAGE_FACADE_RE.test(obj)) {
      if (!STORAGE_ASYNC[meth]) {
        throw mkErr(
          'LW002',
          'Storage::disk()->' + meth + '() is not supported — allowed: ' + Object.keys(STORAGE_ASYNC).join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait(obj + '.' + STORAGE_ASYNC[meth] + '(' + args + ')', node, 'Storage::disk()->' + meth + '()');
    }
    // `Mail::to($u)->send($m)` — the fluent form. The send is async at the
    // edge, so the compiled code awaits it (a promise must never leak).
    if (CTX && CTX.controller && MAIL_FACADE_RE.test(obj)) {
      if (!MAIL_ASYNC.has(meth)) {
        throw mkErr(
          'LW002',
          'the pending mail method ' + meth + '() is not supported — allowed: ' + [...MAIL_ASYNC].join(', ') + '; ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
      return txAwait(obj + '.' + meth + '(' + args + ')', node, 'Mail::' + meth + '()');
    }
    // Eloquent instance writes ($model->save(), ->delete(), ...) need the D1
    // binding and are async at the edge.
    if (CTX && CTX.controller && INSTANCE_DB_METHODS.has(meth)) {
      return txAwait(obj + '.' + meth + '(rt.db()' + (args ? ', ' + args : '') + ')', node, 'model->' + meth + '()');
    }
    const expr = obj + '.' + meth + '(' + args + ')';
    // auth()->user() / auth()->guard()->attempt() resolve the user async (Timebox).
    if (CTX && CTX.controller && AUTH_FACADE_RE.test(obj) && AUTH_ASYNC.has(meth)) {
      return txAwait(expr, node, 'an authenticated call');
    }
    // session()->regenerate()/invalidate()/migrate() touch the handler (async).
    if (CTX && CTX.controller && SESSION_STORE_RE.test(obj) && SESSION_ASYNC.has(meth)) {
      return txAwait(expr, node, 'session()->' + meth + '()');
    }
    // A method call on a variable the compiled rung does not know. It used to
    // compile and answer a 500 at the edge (a silent gap); the build stops.
    if (what.what && what.what.kind === 'variable') {
      const v = vname(what.what.name);
      const phpVar = String(what.what.name || '').replace(/^v_/, '');
      const inController = !!(CTX && CTX.controller);
      if (!inController) {
        // A view: the ViewErrorBag and the paginator (the pagination view)
        // are the only objects with methods there.
        const viewKind = VIEW_DATA_KINDS ? VIEW_DATA_KINDS.get(phpVar) : null;
        if (viewKind === 'paginator' && PAGINATOR_METHODS.has(meth)) {
          return expr;
        }
        if (phpVar !== 'errors' && !phpVar.startsWith('__')) {
          throw mkErr(
            'LW002',
            'the method call $' + phpVar + '->' + meth + '() is not compiled in a view (the error bag is the only one with methods) - ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
        return expr;
      }
      const kind = CTX.modelVars ? CTX.modelVars.get(v) : null;
      if (kind === 'builder') {
        if (!MODEL_CHAIN_BUILDER.has(meth) && !MODEL_CHAIN_TERMINAL.has(meth)) {
          throw mkErr(
            'LW003',
            'the query method ->' + meth + '() is not supported - ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
      } else if (kind === 'model') {
        if (!MODEL_INSTANCE_METHODS.has(meth)) {
          throw mkErr(
            'LW003',
            'the model method ' + meth + '() is not compiled (an Eloquent relation?) - the compiled rung has the instance writes only (save, delete, ...); ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
      } else if (kind === 'paginator') {
        if (!PAGINATOR_METHODS.has(meth)) {
          throw mkErr(
            'LW003',
            'the paginator method ->' + meth + '() is not compiled (links() needs the pagination view) - ' + PORT_HINT,
            node.loc,
            PORT_HINT
          );
        }
      } else if (kind === 'list' || kind === 'scalar') {
        throw mkErr(
          'LW003',
          'the method ->' + meth + '() on a query result is not compiled (a collection method?) - ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      } else {
        throw mkErr(
          'LW002',
          'the method call $' + phpVar + '->' + meth + '() is not compiled - ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
    }
    return expr;
  }
  if (what.kind === 'variable') {
    return tx(what) + '(' + args + ')';
  }
  if (what.kind === 'closure' || what.kind === 'arrowfunc') {
    return tx(what) + '(' + args + ')';
  }
  if (what.kind === 'call') {
    return tx(what) + '(' + args + ')';
  }
  throw mkErr('LW002', 'unsupported call target', node.loc);
}

function getUseInfo(u){
  if(!u) return null;
  // direct variable with byref flag (php-parser read_byref sets byref:true on variable)
  if(u.kind==='variable') return { name: u.name, byref: !!u.byref };
  // wrapped byref node? (some versions)
  if(u.byref && u.what && u.what.kind==='variable') return { name: u.what.name, byref: true };
  // fallback for reference kind
  if(u.kind==='byref' && u.what) return { name: u.what.name || u.what, byref: true };
  return null;
}

function txClosure(node){
  const params=(node.arguments||[]).map(p=>{
    const pn=vname(p.name && p.name.name ? p.name.name : p.name);
    return p.value ? pn+' = '+tx(p.value) : pn;
  });
  const uses=node.uses||[];
  const byVal=[];
  const byRef=[];
  for(const u of uses){
    const info=getUseInfo(u);
    if(!info) continue;
    if(info.byref) byRef.push(info.name);
    else byVal.push(info.name);
  }
  // build body JS: need to render block children via inline walk? reuse tx for statements by emitting JS function body string
  // Instead generate JS code for body by simulating walkChildren into string buffer via helper emitClosureBody
  const bodyCode=emitClosureBody(node.body, byVal, byRef, node.arguments||[]);
  const fn='function('+params.join(', ')+'){'+bodyCode+'}';
  if(byVal.length===0){
    return '('+fn+')';
  }
  const caps=byVal.map(n=>vname(n));
  const capParams=byVal.map(n=>'__cap_'+n);
  const lets=byVal.map((n,i)=>'let '+caps[i]+'='+capParams[i]+';').join('');
  const fnWithLets='function('+params.join(', ')+'){'+lets+bodyCode+'}';
  return '(('+capParams.join(', ')+')=>('+fnWithLets+'))('+caps.join(', ')+')';
}

function emitClosureBody(body, byVal, byRef, params){
  if(!body) return '';
  if(body.kind==='block'){
    const paramSet=new Set((params||[]).map(p=> String(p.name && p.name.name ? p.name.name : p.name)));
    const byValSet=new Set(byVal||[]);
    const byRefSet=new Set(byRef||[]);
    const scan=(n, set)=>{
      if(!n||typeof n!=='object') return;
      if(Array.isArray(n)){ for(const x of n) scan(x,set); return; }
      if(n.kind==='closure' || n.kind==='arrowfunc') return;
      if(n.kind==='variable' && n.name) set.add(String(n.name));
      for(const k of Object.keys(n)){ if(k==='loc') continue; scan(n[k], set); }
    };
    const all=new Set();
    scan(body, all);
    const locals=[...all].filter(n=> !paramSet.has(n) && !byValSet.has(n) && !byRefSet.has(n));
    const lines=[];
    if(locals.length) lines.push('let '+locals.map(vname).join(', ')+';');
    CLOSURE_DEPTH++;
    try{
      walkChildren(body.children||[], lines, '', {});
    }finally{
      CLOSURE_DEPTH--;
    }
    return lines.join(' ');
  }
  CLOSURE_DEPTH++;
  try {
    return 'return '+tx(body)+';';
  } finally {
    CLOSURE_DEPTH--;
  }
}

function txArrowFunc(node){
  const params=(node.arguments||[]).map(p=>{
    const pn=vname(p.name && p.name.name ? p.name.name : p.name);
    return p.value ? pn+' = '+tx(p.value) : pn;
  });
  CLOSURE_DEPTH++;
  let expr;
  try {
    expr=tx(node.body);
  } finally {
    CLOSURE_DEPTH--;
  }
  if(params.length===1) return '('+params[0]+'=>('+expr+'))';
  return '(('+params.join(', ')+')=>('+expr+'))';
}


// The kind of a model expression:
//   builder - Post::where(...)          (the query builder)
//   model   - Post::find(...)/first()   (a model instance)
//   list    - Post::all()/get()         (a list of models)
//   scalar  - count()/pluck()/value()   (a value)
function modelExprKind(node) {
  if (!CTX || !CTX.models) return null;
  const chain = modelChain(node);
  if (!chain) return null;
  const first = chain.segments[0].name;
  const last = chain.segments[chain.segments.length - 1].name;
  if (first === 'all') return 'list';
  if (first === 'paginate') return 'paginator';
  if (MODEL_STATIC_START.has(first)) {
    if (chain.segments.length > 1 && MODEL_CHAIN_TERMINAL.has(last)) {
      if (last === 'get') return 'list';
      if (last === 'count' || last === 'pluck' || last === 'value') return 'scalar';
      if (last === 'paginate') return 'paginator';
      return 'model';
    }
    return 'builder';
  }
  return 'model';
}

function txAssignExpr(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  // A model assignment: the variable holds a model (or a query builder).
  // An uploaded file: the variable holds a file (`$file = $request->file('x')`).
  if (left.kind === 'variable' && CTX && CTX.fileVars) {
    const fileKind = fileExprKind(node.right);
    if (fileKind) CTX.fileVars.set(vname(left.name), fileKind);
  }
  if (left.kind === 'variable' && CTX && CTX.modelVars) {
    const kind = modelExprKind(node.right);
    if (kind) {
      CTX.modelVars.set(vname(left.name), kind);
      // The paginator: the handler renders the pagination view (the compiled
      // `pagination::tailwind`).
      if (kind === 'paginator') CTX.usedPaginator = true;
      const chain = modelChain(node.right);
      if (chain && chain.root) {
        CTX.modelAlias.set(vname(left.name), chain.root);
        CTX.modelVarFqcns.set(vname(left.name), modelFqcnOf(chain.root));
      }
    }
  }
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
    // `$arr[] = $x` — the PHP append (the next free integer key). It used to
    // compile to `$arr[null] = $x` — a *silent* wrong answer.
    if (!left.offset) {
      if (op !== '=') {
        throw mkErr('LW002', 'unsupported assignment operator ' + op + ' on an array append', node.loc, PORT_HINT);
      }
      return '(rt.arrayPush(' + tx(left.what) + ', ' + right + '))';
    }
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return '(' + target + ' = ' + right + ')';
    if (op === '??=') return 'rt.coalesceAssign(() => (' + target + '), (x) => { ' + target + ' = x; }, ' + right + ')';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'propertylookup') {
    // PHP `$model->attribute = $value` — Eloquent::setAttribute (casts included).
    const name = left.offset && left.offset.name;
    if (typeof name !== 'string') throw mkErr('LW002', 'unsupported property assignment', node.loc);
    if (op !== '=') throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
    return '(rt.propSet(' + tx(left.what) + ', ' + JSON.stringify(name) + ', ' + right + '))';
  }
  throw mkErr('LW002', 'unsupported assignment target', node.loc);
}

function txAssignStatement(node) {
  const op = node.operator || '=';
  const left = node.left;
  const right = tx(node.right);
  // A model assignment: the variable holds a model (or a query builder).
  // An uploaded file: the variable holds a file (`$file = $request->file('x')`).
  if (left.kind === 'variable' && CTX && CTX.fileVars) {
    const fileKind = fileExprKind(node.right);
    if (fileKind) CTX.fileVars.set(vname(left.name), fileKind);
  }
  if (left.kind === 'variable' && CTX && CTX.modelVars) {
    const kind = modelExprKind(node.right);
    if (kind) {
      CTX.modelVars.set(vname(left.name), kind);
      // The paginator: the handler renders the pagination view (the compiled
      // `pagination::tailwind`).
      if (kind === 'paginator') CTX.usedPaginator = true;
      const chain = modelChain(node.right);
      if (chain && chain.root) {
        CTX.modelAlias.set(vname(left.name), chain.root);
        CTX.modelVarFqcns.set(vname(left.name), modelFqcnOf(chain.root));
      }
    }
  }
  if (left.kind === 'variable' && op === '=') {
    const v = vname(left.name);
    if (!LOCAL_VARS.includes(v)) LOCAL_VARS.push(v);
  }
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
    // `$arr[] = $x` — the PHP append (the next free integer key).
    if (!left.offset) {
      if (op !== '=') {
        throw mkErr('LW002', 'unsupported assignment operator ' + op + ' on an array append', node.loc, PORT_HINT);
      }
      return 'rt.arrayPush(' + tx(left.what) + ', ' + right + ');';
    }
    const target = tx(left.what) + '[' + txOffsetKey(left.offset) + ']';
    if (op === '=') return target + ' = ' + right + ';';
    if (op === '??=') return 'if (' + target + ' === null || ' + target + ' === undefined) { ' + target + ' = ' + right + '; }';
    throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
  }
  if (left.kind === 'propertylookup') {
    // PHP `$model->attribute = $value` — Eloquent::setAttribute (casts included).
    const name = left.offset && left.offset.name;
    if (typeof name !== 'string') throw mkErr('LW002', 'unsupported property assignment', node.loc);
    if (op !== '=') throw mkErr('LW002', 'unsupported assignment operator ' + op, node.loc);
    return 'rt.propSet(' + tx(left.what) + ', ' + JSON.stringify(name) + ', ' + right + ');';
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
      // An uploaded file in a loop (`foreach ($request->file('photos') as $f)`):
      // the loop variable holds a file, so its methods are gated like the ones
      // of a `$file = $request->file('x')` variable.
      if (CTX && CTX.fileVars && node.value && node.value.kind === 'variable' && node.source) {
        let srcKind = fileExprKind(node.source);
        // The source may be a variable that holds the files
        // (`$files = $request->file('photos'); foreach ($files as $f)`).
        if (!srcKind && node.source.kind === 'variable') {
          srcKind = CTX.fileVars.get(vname(node.source.name)) || null;
        }
        if (srcKind) CTX.fileVars.set(vname(node.value.name), srcKind);
      }
      // A by-reference foreach (`foreach ($a as &$v)`): PHP writes the
      // changes back into the source array - a by-value loop would lose them
      // and the compiled side would answer a different array.
      if (node.value && node.value.byref) {
        throw mkErr(
          'LW002',
          'a foreach by reference (foreach ($a as &$v)) is not compiled — PHP writes the changes back into the source ' +
            'array, so a by-value loop would answer a different result — ' + PORT_HINT,
          node.loc,
          PORT_HINT
        );
      }
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
    case 'throw':
      lines.push(indent + 'throw ' + tx(node.what || node.expr) + ';');
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
  if (node.kind === 'call' && node.what && node.what.kind === 'name' && node.what.name === 'compact') {
    // compact('post') reads $post — count it as a variable so it is declared/hoisted.
    for (const a of node.arguments || []) {
      if (a && a.kind === 'string') vars.add(vname(a.value));
    }
  }
  if (node.kind === 'closure' || node.kind === 'arrowfunc') {
    // do not hoist closure locals/params/uses to top-level; collect only variables outside closure scope
    // Still recurse into uses (they refer to outer vars, so collect them as outer vars if they are by-ref? Actually uses are outer vars)
    // For correctness, collect uses variables as outer vars, but not params or body locals
    const uses=node.uses||[];
    for(const u of uses){ if(u && u.kind==='variable' && u.name) vars.add(vname(u.name)); else if(u && u.what && u.what.name) vars.add(vname(u.what.name)); }
    // do not recurse into arguments or body (scoped)
    for(const k of Object.keys(node)){
      if(k==='loc'||k==='arguments'||k==='body'||k==='uses') continue;
      collect(node[k], funcs, vars);
    }
    return;
  }
  if (node.kind === 'variable' && node.name) vars.add(vname(node.name));
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    collect(node[k], funcs, vars);
  }
}

export function transpile(compiledSource, opts = {}) {
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
  LOCAL_VARS = [];
  // The kinds of the view data (the build knows them: the pagination view
  // receives a paginator).
  VIEW_DATA_KINDS = opts.viewDataKinds
    ? new Map(Object.entries(opts.viewDataKinds))
    : null;

  const lines = [];
  lines.push('export default function main(rt) {');
  if (vars.size) {
    lines.push('  let ' + Array.from(vars).join(', ') + ';');
    // Runtime view data injection: v_x = rt.var('x'). For static snapshots the rt has
    // no data → rt.var returns undefined → identical semantics to the pre-data era.
    for (const v of vars) {
      lines.push('  ' + v + ' = rt.var(' + JSON.stringify(String(v).replace(/^v_/, '')) + ');');
    }
  }
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

// ---- controller method transpilation (used by compiler/src/controller.mjs) ----
// Returns { code, errors }; code is the JS body of an async request handler
// (no wrapper function — the caller generates the handler skeleton).
export function transpileControllerMethod(bodyChildren, opts = {}) {
  const funcs = new Set();
  const vars = new Set();
  collect(bodyChildren || [], funcs, vars);
  FUNCS = funcs;
  LOCAL_VARS = [];
  CTX = {
    models: opts.models || new Set(),
    views: opts.views || new Set(),
    controller: true,
    requestVars: opts.requestVars || new Set(),
    // The variables that hold a model (or a query builder): a method call on
    // them is gated, so the build stops instead of answering a 500 at the edge.
    modelVars: new Map(),
    // The variables that hold an uploaded file (`$request->file('x')`): the
    // file methods are gated the same way.
    fileVars: new Map(),
    // The app classes the build compiled (the event classes + the listeners):
    // `new X(...)` and the event dispatch.
    classes: opts.classes instanceof Set ? opts.classes : new Set(opts.classes || []),
    // The alias of each compiled class (the FQCN): `new PostPublished($id)`.
    classFqcns: opts.classFqcns instanceof Map ? opts.classFqcns : new Map(Object.entries(opts.classFqcns || {})),
    // The services the constructor injected (`$this->mailer`): their async
    // methods are awaited in the compiled body.
    injectedDeps: opts.injectedDeps instanceof Map ? opts.injectedDeps : new Map(),
    // The event classes that did NOT compile, with the reason (the listener is
    // queued, the listener injects a service, ...): a dispatch of one of them
    // would be a silent no-op, so the build stops and names the reason.
    classBlocked: opts.classBlocked instanceof Map ? opts.classBlocked : new Map(Object.entries(opts.classBlocked || {})),
    // Inside a compiled class method, `$this` is the instance.
    classMethod: !!opts.classMethod,
    // The name `$this` compiles to (a constructor builds its own object).
    thisVar: opts.thisVar || null,
    // The model alias of each model variable (var -> alias/fqcn).
    modelAlias: new Map(),
    // The FQCN of each model variable (var -> FQCN): the Gate check needs it
    // to find the policy of the subject.
    modelVarFqcns: new Map(),
    // The model classes the build knows: alias -> FQCN (and FQCN -> FQCN).
    modelClassFqcns: new Map(Object.entries(opts.modelClassFqcns || {})),
    // The dumped policies: FQCN -> { policy, methods, before, globalBefore, ... }
    policies: new Map(Object.entries(opts.policies || {})),
    // The app's object store: the default disk's name + the configured disks
    // (the Storage facade: only the default disk compiles).
    storage: opts.storage || {},
    // The model methods the app declares (alias -> [names]): a relation or an
    // accessor read as a property is not compiled.
    modelNotCompiled: opts.modelNotCompiled || new Map(),
    // class constants dumped at build time: { FQCN: { NAME: value } }
    constants: opts.constants || {},
    // FormRequest rules per request variable: Map<varName, { rules, messages, attributes }>
    formRequests: opts.formRequests || new Map(),
    // Did this method use the Gate? (the handler then imports the policies)
    usedGate: false,
    // Did this method use a paginator? (the handler then imports the
    // pagination view).
    usedPaginator: false,
    // Did this method dispatch an event? (the handler then imports the
    // compiled classes).
    usedEvents: false,
  };
  // The seeded model variables (a policy parameter: the user, the subject).
  for (const seed of opts.modelVarSeeds || []) {
    if (!seed || !seed.var) continue;
    CTX.modelVars.set(seed.var, seed.kind || 'model');
    if (seed.alias) CTX.modelAlias.set(seed.var, seed.alias);
    if (seed.fqcn) CTX.modelVarFqcns.set(seed.var, seed.fqcn);
  }
  CLOSURE_DEPTH = 0;
  const indent = opts.indent || '';
  const paramVars = opts.paramVars || new Set();
  const declared = Array.from(vars).filter((v) => !paramVars.has(v));
  const lines = [];
  if (declared.length) lines.push(indent + 'let ' + declared.join(', ') + ';');
  let usedGate = false;
  let usedPaginator = false;
  let usedEvents = false;
  try {
    walkChildren(bodyChildren || [], lines, indent, {});
    usedGate = !!CTX.usedGate;
    usedPaginator = !!CTX.usedPaginator;
    usedEvents = !!CTX.usedEvents;
  } catch (e) {
    const lw = e.lw || { code: 'LW002', message: e.message, line: 0, column: 0, hint: '' };
    return { code: null, errors: [lw] };
  } finally {
    CTX = null;
    CLOSURE_DEPTH = 0;
  }
  return { code: lines.join('\n'), errors: [], usedGate, usedPaginator, usedEvents };
}

export default transpile;

export { REQUEST_CALL, REQUEST_NO_CHAIN, REQUEST_ASYNC, REQUEST_DENY };