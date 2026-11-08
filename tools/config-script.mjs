// tools/config-script.mjs — the BUILD-TIME statement executor for the PHP files
// a Laravel app's `config/` (and `lang/`) folders are allowed to contain.
//
// Why this exists (audit): `tools/static.mjs` evaluated only the FIRST
// `return <expression>` it could find in the file, so a config file that
// computed its array in a loop, through a variable, or through a closure was
// folded to whatever that single expression happened to be - and an
// un-evaluable array entry was dropped from the dumped config with NO trace,
// while PHP booted with a value. Two live shapes this covers:
//
//   $keys = ['a', 'b'];
//   foreach ($keys as $k) { $out[$k] = env('X_' . $k); }
//   return $out;
//
//   return array_filter(include __DIR__ . '/parts.php', fn ($v) => $v !== null);
//
// Rules kept from the rest of the evaluator:
//   * deterministic only — a construct whose value depends on the boot HOST or
//     the CLOCK is REFUSED loudly (never folded to a wrong constant);
//   * everything the executor cannot model is reported by name (group + key +
//     shape) through `ctx.noteDrop`, never silently skipped;
//   * one canon: the binary/unary operators and the PHP function library come
//     from `tools/php-funcs.mjs` via `ctx`, so the statement path and the
//     expression path cannot disagree.
//
// This module deliberately imports nothing from `static.mjs` (the evaluator is
// passed in as `ctx.evalExpr`): the two files would otherwise form an import
// cycle, and Node resolves cycles by handing one side a half-built namespace.

// `switch` compares with PHP's loose `==` (PHP 8's switch uses `==`), so the
// fold uses the SAME canon the expression path uses for `==`
// (`tools/php-funcs.mjs` imports it from the same module). It is imported
// directly rather than reached through `ctx` because a caller that forgets to
// pass it would silently fall back to JavaScript's `==` — which answers the
// WRONG branch and reports no drop (audit #878).
import { looseEq } from '../kernel/php-loose-eq.mjs';
import { phpBool } from './php-funcs.mjs';

/** A runaway `while (true)` in a config file hangs PHP's boot too, but it must
 * not hang the BUILD: after this many executed statements the fold refuses with
 * the file and the line. */
const MAX_STEPS = 200000;

class Control {
  constructor(kind, level = 1) {
    this.kind = kind; // 'break' | 'continue' | 'return'
    this.level = level;
  }
}

const ctrl = (node) => {
  const c = new Control(node.kind === 'return' ? 'return' : node.kind, Number(node.level && node.level.value) || 1);
  c.line = node.loc && node.loc.start ? node.loc.start.line : null;
  return c;
};

/**
 * Execute a parsed `program`/`block` statement list.
 * ctx: {
 *   evalExpr(node, ctx, depth)  — tools/static.mjs `evalConfigExpr`
 *   binOp(type, l, r)           — PHP binary operator semantics (one canon)
 *   unaryOp(type, v)            — PHP unary operator semantics (one canon)
 *   noteDrop(drop)              — report a value the fold could not answer
 *   env, appDir, parsed, file   — file context
 * }
 * Returns the value of the file's `return` (undefined when it did not return).
 */
export function runConfigStatements(ast, ctx) {
  // One shared slot for the whole FILE (closures inherit the reference through
  // `makeClosure`'s Object.assign), so a refusal inside a nested function still
  // marks the file unanswerable.
  if (!ctx.poisonRef) ctx.poisonRef = { hit: null };
  // A shared counter of the drops the fold has REPORTED (an assignment whose
  // right side refuses names its key; `tools/static.mjs` calls `ctx.noteDrop`
  // directly for that). `poisonIfUnreported()` uses it to tell "the value was
  // dropped and named" from "the value vanished with no trace at all" — only the
  // second is a reason to distrust the whole file. The counter lives on an
  // OBJECT because `makeClosure` copies the context with `Object.assign`: a
  // plain number would be frozen at the copy, the reference is shared.
  if (!ctx.dropRef) ctx.dropRef = { count: 0 };
  if (typeof ctx.noteDrop === 'function' && !ctx.noteDrop.__lwCounted) {
    const raw = ctx.noteDrop;
    const counted = (d) => {
      ctx.dropRef.count++;
      return raw(d);
    };
    counted.__lwCounted = true;
    ctx.noteDrop = counted;
  }
  const st = { scope: ctx.scope || Object.create(null), value: undefined, steps: 0, ctx };
  try {
    execStmts(ast.children || [], st, 0);
  } catch (e) {
    if (e instanceof Control) {
      if (e.kind === 'return') return st.value;
      // A leftover break/continue means an enclosing construct did not consume
      // it (before the handlers returned Controls instead of throwing, EVERY
      // `break` in a config file escaped like this and the group was lost with
      // `<file>: [object Object]` — audit #774). Name it for the next reader.
      throw new Error(
        `config fold: '${e.kind}'${e.level > 1 ? ' ' + e.level : ''} escaped the statement it belongs to (line ` +
          `${(e.line && e.line) || '?'}); the loop or switch that should catch it is not modelled`
      );
    }
    throw e;
  }
  return st.value;
}

function note(ctx, drop) {
  if (typeof ctx.noteDrop === 'function') ctx.noteDrop(drop);
}

/**
 * A refusal inside the STATEMENT path is not a lost key, it is a lost FILE.
 *
 * A refused ARRAY ENTRY (`'x' => time()`) drops one key and leaves every other
 * value correct - that is the documented contract, reported by
 * `tools/config-dump.mjs` on stderr. A refused STATEMENT is different: PHP's
 * `sort($a)` sorts IN PLACE, `foreach ($a as &$v)` writes back, `static $n`
 * persists across calls, `try/catch` runs a body - the fold answers `undefined`
 * for all of them and then keeps EXECUTING with the state PHP never had, so
 * every value the file computes afterwards can be wrong while looking valid
 * (audit #774: a single `break` threw `Control` out of the file; #776:
 * `sort()`/`ksort()`/`$s++`/`$s[0] = 'z'` folded to the unmutated array/string
 * with no drop report at all).
 *
 * `poisonRef.hit` makes the file unanswerable: `loadConfig()` reports it as an
 * error and skips the group instead of folding a plausible-but-wrong config.
 */
function poison(ctx, kind, line, reason) {
  const ref = ctx && ctx.poisonRef;
  if (ref && !ref.hit) ref.hit = { kind, line: line == null ? null : line, reason };
  return undefined;
}

/**
 * `poison()` only when the refused value was NOT already reported as a dropped
 * key. An assignment whose right side refuses (`$config['x'] = intdiv(7, 2);`)
 * NAMES that key and leaves the rest of the file sound — poisoning there would
 * fail the build for every single unimplemented builtin, which is the documented
 * "drop the key, keep the dump" contract. What is not sound is a value that
 * disappeared with NO trace (an expression statement, a `for` header, an
 * `unset()` key): the file's state after it already differs from PHP's.
 */
function poisonIfUnreported(ctx, dropCountBefore, node, context, fallbackReason) {
  if (ctx.dropRef && ctx.dropRef.count !== dropCountBefore) return;
  const r = ctx.lastRefusal;
  // The innermost reason names the ROOT cause (`PHP time(): ...`); `context`
  // names why that root cause makes the FILE unusable (`the unset() offset ...`).
  // Both belong in the message: one is the fix, the other is the risk.
  poison(
    ctx,
    node && node.kind,
    (r && r.line) || (node && node.loc && node.loc.start ? node.loc.start.line : null),
    r && r.reason ? `${context} — ${r.reason}` : fallbackReason
  );
}

function refuse(ctx, node, reason) {
  note(ctx, {
    kind: node && node.kind,
    line: node && node.loc && node.loc.start ? node.loc.start.line : null,
    reason,
  });
  poison(ctx, node && node.kind, node && node.loc && node.loc.start ? node.loc.start.line : null, reason);
  return undefined;
}

/** One statement. Returns a Control when it transfers, else null. */
function execStmt(node, st, depth) {
  const ctx = st.ctx;
  if (!node) return null;
  if (++st.steps > MAX_STEPS) {
    throw new Error(
      `config fold: more than ${MAX_STEPS} statements executed in ${ctx.file || 'a config file'} — ` +
        'the file looks like an unbounded loop; a boot-time value computed that way cannot be folded'
    );
  }
  switch (node.kind) {
    case 'noop':
    case 'declare':
      return execStmts(node.children || [], st, depth + 1);
    case 'block':
      return execStmts(node.children || [], st, depth + 1);
    case 'expressionstatement': {
      const before = ctx.dropRef ? ctx.dropRef.count : 0;
      const v = st.ctx.evalExpr(node.expression, ctx, depth + 1);
      // Nothing consumes this value, so a refusal here is INVISIBLE: no key is
      // dropped, no drop report is written, and the scope keeps whatever the
      // statement was supposed to change (`sort($a)`, `$s++`, `$x = time()`).
      // That is the state-divergence class `poison()` above documents. When the
      // evaluation DID report a drop (`$config['x'] = intdiv(7, 2)`) it is a key
      // drop like any other and the file stays usable.
      if (v === undefined) {
        poisonIfUnreported(
          ctx,
          before,
          node.expression,
          'an expression statement whose value nothing consumes',
          'the statement evaluated to a value the fold cannot answer, so the file’s state after it is unknown'
        );
      }
      return null;
    }
    case 'if': {
      const c = st.ctx.evalExpr(node.test, ctx, depth + 1);
      if (c === undefined) {
        return refuse(ctx, node, 'if() tested an expression the fold cannot evaluate');
      }
      if (phpBool(c)) return execStmt(node.body, st, depth + 1);
      if (node.alternate) return execStmt(node.alternate, st, depth + 1);
      return null;
    }
    case 'while': {
      for (;;) {
        const c = st.ctx.evalExpr(node.test, ctx, depth + 1);
        if (c === undefined) return refuse(ctx, node, 'while() tested an expression the fold cannot evaluate');
        if (!phpBool(c)) break;
        const r = execStmt(node.body, st, depth + 1);
        if (r) {
          if (r.kind === 'return') throw r;
          if (r.kind === 'break' && r.level <= 1) break;
          if (r.kind === 'continue' && r.level <= 1) continue;
          r.level -= 1;
          return r;
        }
      }
      return null;
    }
    case 'do': {
      for (;;) {
        const r = execStmt(node.body, st, depth + 1);
        if (r) {
          if (r.kind === 'return') throw r;
          if (r.kind === 'break' && r.level <= 1) break;
          if (r.kind === 'continue' && r.level <= 1) { /* fall through to the test */ }
          else { r.level -= 1; return r; }
        }
        const c = st.ctx.evalExpr(node.test, ctx, depth + 1);
        if (c === undefined) return refuse(ctx, node, 'do/while() tested an expression the fold cannot evaluate');
        if (!phpBool(c)) break;
      }
      return null;
    }
    case 'for': {
      for (const init of node.init || []) {
        const before = ctx.dropRef ? ctx.dropRef.count : 0;
        const v = st.ctx.evalExpr(init, ctx, depth + 1);
        if (v === undefined) {
          poisonIfUnreported(ctx, before, init, 'a for() INIT expression', 'a for() INIT expression is not answerable, so the loop variable is unknown');
        }
      }
      for (;;) {
        // PHP's `for` takes a LIST of comma-separated expressions and runs the
        // body when the LAST one is true (`for (; 0, $i < 3; $i++)` loops three
        // times). The old code ANDed every test, so a leading `0` stopped the
        // loop before the body ever ran.
        let open = true;
        for (const test of node.test || []) {
          const c = st.ctx.evalExpr(test, ctx, depth + 1);
          if (c === undefined) return refuse(ctx, node, 'for() tested an expression the fold cannot evaluate');
          open = phpBool(c);
        }
        if (!open) break;
        const r = execStmt(node.body, st, depth + 1);
        if (r) {
          if (r.kind === 'return') throw r;
          if (r.kind === 'break' && r.level <= 1) break;
          if (r.kind === 'continue' && r.level <= 1) { /* run the increment */ }
          else { r.level -= 1; return r; }
        }
        for (const inc of node.increment || []) {
          const before = ctx.dropRef ? ctx.dropRef.count : 0;
          const iv = st.ctx.evalExpr(inc, ctx, depth + 1);
          if (iv === undefined) {
            poisonIfUnreported(ctx, before, inc, 'a for() INCREMENT', 'a for() INCREMENT is not answerable, so the loop counter is unknown');
          }
        }
      }
      return null;
    }
    case 'foreach': {
      const src = st.ctx.evalExpr(node.source, ctx, depth + 1);
      if (src === undefined) return refuse(ctx, node, 'foreach() source is not statically evaluable');
      if (node.value && node.value.byref) {
        return refuse(ctx, node, 'foreach by reference ($v) — the fold has no reference semantics');
      }
      if (node.value && node.value.kind !== 'variable') {
        // `foreach ($pairs as [$name, $num])` — the destructor used to be read as
        // `.name`, which is undefined: the loop wrote scope[undefined] and every
        // later read of $name/$num dropped the key it fed (a config key could
        // vanish while PHP had a value; audit #776).
        return refuse(
          ctx,
          node,
          'foreach with a list()/[..] destructuring pattern is not modelled by the fold — assign $key => $row and read $row[...] instead'
        );
      }
      const entries = phpForeachEntries(src);
      if (!entries) return refuse(ctx, node, `foreach() over a ${typeName(src)} — not a PHP array/object the fold models`);
      // PHP walks the array by VALUE at the start of the loop (a copy for an
      // array source), so mutating the source inside the body cannot change the
      // iteration - `entries` is already a snapshot.
      for (const [k, v] of entries) {
        const keyName = node.key ? node.key.name : null;
        if (keyName) st.scope[keyName] = k;
        st.scope[node.value.name] = v;
        const r = execStmt(node.body, st, depth + 1);
        if (r) {
          if (r.kind === 'return') throw r;
          if (r.kind === 'break' && r.level <= 1) break;
          if (r.kind === 'continue' && r.level <= 1) continue;
          r.level -= 1;
          return r;
        }
      }
      return null;
    }
    case 'switch': {
      const subject = st.ctx.evalExpr(node.test, ctx, depth + 1);
      if (subject === undefined) return refuse(ctx, node, 'switch() tested an expression the fold cannot evaluate');
      const cases = ((node.body && node.body.children) || []).filter((c) => c && c.kind === 'case');
      // PHP compares the subject against the cases IN ORDER and jumps to the
      // first match; with no match it jumps to the `default`, wherever it sits,
      // and falls through from THERE. The old loop executed a `default` placed
      // before the matching case (it ran the default's body and stopped), so
      // `switch ($x) { default: return 'd'; case 2: return 'two'; }` answered
      // 'd' where PHP answers 'two' (verified against PHP 8.3).
      const matches = (c, v) => looseEq(subject, v);
      let start = -1;
      let fallback = -1;
      for (let i = 0; i < cases.length && start < 0; i++) {
        const c = cases[i];
        if (c.test === null || c.test === undefined) {
          if (fallback < 0) fallback = i; // `default` is a JUMP TARGET, not a match
          continue;
        }
        for (const t of Array.isArray(c.test) ? c.test : [c.test]) {
          const v = st.ctx.evalExpr(t, ctx, depth + 1);
          if (v === undefined) return refuse(ctx, c, 'case value is not statically evaluable');
          if (matches(c, v)) {
            start = i;
            break;
          }
        }
      }
      if (start < 0) start = fallback;
      if (start < 0) return null;
      for (let i = start; i < cases.length; i++) {
        const r = execStmts((cases[i].body && cases[i].body.children) || [], st, depth + 1);
        if (r) {
          if (r.kind === 'return') throw r;
          if (r.kind === 'break' && r.level <= 1) return null;
          if (r.kind === 'continue' && r.level <= 1) return null;
          r.level -= 1;
          return r;
        }
      }
      return null;
    }
    case 'break':
    case 'continue':
      // RETURNED, not thrown: the loop/switch handlers consume it
      // (`r.kind === 'break' && r.level <= 1`). Throwing escaped every
      // enclosing loop frame - no handler wraps its body in try/catch - so a
      // single `break` in a config file's loop aborted the whole FILE with
      // `Control { kind: 'break', level: 1 }` and `loadConfig` reported the
      // group as `error: <file>: [object Object]`, losing every key of it
      // (audit #774).
      return ctrl(node);
    case 'return':
      st.value = node.expr ? st.ctx.evalExpr(node.expr, ctx, depth + 1) : null;
      // `return` DOES throw: it must unwind past every loop and reach the
      // function/file boundary (`runConfigStatements`, `makeClosure`).
      throw ctrl(node);
    case 'unset': {
      for (const v of node.variables || []) {
        if (v.kind === 'variable') delete st.scope[v.name];
        else if (v.kind === 'offsetlookup' && v.what && v.what.kind === 'variable') {
          const arr = st.scope[v.what.name];
          const dropBefore = ctx.dropRef ? ctx.dropRef.count : 0;
          const key = st.ctx.evalExpr(v.offset, ctx, depth + 1);
          if (key === undefined) {
            poisonIfUnreported(
              ctx,
              dropBefore,
              v.offset || v,
              'the unset() offset key',
              'the unset() offset is not statically evaluable, so the array keeps a key PHP removed'
            );
          } else if (Array.isArray(arr)) {
            // PHP leaves a HOLE: `[1,2,3]` minus key 1 is `{0:1, 2:3}`, not a
            // re-indexed list (the old `splice` shifted every later element, so
            // `$a[] =` afterwards wrote the wrong key as well). The value stops
            // being a list, so it becomes the keyed form with the remaining
            // insertion order - and the append counter a list carries is its
            // length (see static.mjs setOffset()).
            const out = {};
            arr.forEach((x, i) => { out[String(i)] = x; });
            delete out[String(key)];
            Object.defineProperty(out, '__lwOrder', { value: Object.keys(out), enumerable: false });
            Object.defineProperty(out, '__lwNext', { value: arr.length, enumerable: false });
            st.scope[v.what.name] = out;
          } else if (arr && typeof arr === 'object') {
            // PHP's nextFreeElement is `max(integer key) + 1` at every point in
            // the array's life, and unset() is the ONE operation that can leave
            // it above that ("[5=>'x']; unset($a[5]); $a[] = 'y'" keys y at 6).
            // So fix the counter BEFORE the delete, when the container does not
            // carry one yet (a value built by a fold function - array_merge(),
            // array_slice() - has no marker): afterwards it is preserved.
            if (!Number.isInteger(arr.__lwNext)) {
              let max = -1;
              for (const k of Object.keys(arr)) {
                const n = Number(String(k));
                if (String(n) === String(k) && Number.isInteger(n) && n > max) max = n;
              }
              Object.defineProperty(arr, '__lwNext', { value: max + 1, enumerable: false });
            }
            delete arr[String(key)];
            // Keep the order marker a snapshot of the LIVE keys: a key left in it
            // after the delete would reach the dump as a phantom `"k": null`.
            const order = arr.__lwOrder;
            if (Array.isArray(order)) {
              const i = order.findIndex((x) => String(x) === String(key));
              if (i >= 0) order.splice(i, 1);
            }
          }
        }
      }
      return null;
    }
    case 'usegroup':
      // `use Foo\Bar;` in a config file only matters for `::class` resolution,
      // which reads the file's imports (`parsePhpFile`), not the scope.
      return null;
    case 'function':
    case 'class':
    case 'interface':
    case 'trait':
    case 'enum':
      // A DECLARATION is inert where it stands: PHP registers the name and runs
      // nothing, so `config/app.php` may declare a helper class or function and
      // still return its array. Refusing here poisoned a whole group over a
      // statement that cannot change a single value (probed: `class A {}` +
      // `return ['x' => 1]` folded to an empty group, where PHP answers x=1).
      // Using one is still refused loudly at the USE site: a call to a name the
      // fold does not implement names the function, and `Class::method()` needs
      // the app's classes, which the fold does not load.
      return null;
    case 'constantstatement': {
      // `const NAME = <expr>;` at the top level of a config file defines a
      // runtime constant: inert by itself, but the NAME has to answer when the
      // file reads it (`return ['limit' => LW_LIMIT];`). Recorded per file and
      // read back in `evalConfigExpr()`'s `name` case. A value the fold cannot
      // evaluate is simply NOT recorded - the read then refuses by name, which
      // is the pre-existing contract for an unknown constant.
      const map = ctx.fileConstants || (ctx.fileConstants = {});
      for (const decl of node.constants || []) {
        const name = decl.name && (decl.name.name || decl.name);
        if (typeof name !== 'string') continue;
        const v = st.ctx.evalExpr(decl.value, ctx, depth + 1);
        if (v !== undefined) map[name] = v;
      }
      return null;
    }
    default:
      return refuse(ctx, node, `statement '${node.kind}' is not modelled by the build-time config fold`);
  }
}

function execStmts(list, st, depth) {
  for (const node of list) {
    const r = execStmt(node, st, depth);
    if (r) return r;
  }
  return null;
}

/** PHP's `foreach` source rules: an array walks its own entries; an object
 * walks its PUBLIC properties (a plain object/Collection here). `null` and
 * scalars are not iterable (PHP warns and skips the body). */
function phpForeachEntries(src) {
  if (Array.isArray(src)) return src.map((v, i) => [i, v]);
  if (src && typeof src === 'object' && src.__lwOrder) {
    return src.__lwOrder.map((k) => [/^-?\d+$/.test(k) ? Number(k) : k, src[k]]);
  }
  if (src && typeof src === 'object') {
    // PHP iterates an object's PUBLIC properties — INCLUDING a `_`-prefixed
    // one. The filter is for the fold's OWN markers (`__lwOrder`,
    // `__lwObject`, ... — every internal key carries the `__lw` prefix) and
    // nothing else; dropping every `_`-prefixed key silently lost data PHP
    // would have iterated (audit #881: the fold's `(object)`/`json_decode`
    // object shapes are refused before this point, so no reachable config
    // file hit it — the guard is still narrowed so a future shape cannot).
    return Object.keys(src).filter((k) => !k.startsWith('__lw')).map((k) => [k, src[k]]);
  }
  if (src === null || src === undefined) return [];
  return null;
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * A closure/arrow-function node becomes a real JS function so the PHP function
 * library's higher-order entries (`array_filter`, `array_map`, `usort`) and any
 * direct `$fn(...)` call site can use it.
 *
 * PHP captures the enclosing scope BY VALUE at creation time: a `closure` only
 * sees the names in its `use (...)` list, an `arrowfunc` sees everything in
 * scope. A by-reference capture (`use (&$x)`) is refused — the fold has no
 * reference semantics, and guessing would fold a value PHP only writes later.
 */
export function makeClosure(node, ctx, depth, evalExpr, makeStmtFn) {
  const byref = (node.uses || []).some((u) => u.byref && u.kind === 'variable');
  if (byref) {
    return () => refuse(ctx, node, 'closure capture by reference (`use (&$x)`) is not modelled by the fold');
  }
  const params = (node.arguments || []).map((a) => (a && a.name && typeof a.name === 'string' ? a.name : String(a && a.name && a.name.name)));
  const captured = Object.create(null);
  if (node.kind === 'closure') {
    for (const u of node.uses || []) captured[u.name] = ctx.scope[u.name];
  } else {
    for (const k of Object.keys(ctx.scope)) captured[k] = ctx.scope[k];
  }
  const defaults = (node.arguments || []).map((a) => (a && a.default ? evalExpr(a.default, ctx, depth + 1) : undefined));
  const variadic = (node.arguments || []).findIndex((a) => a && a.variadic);
  return function lwClosure(...args) {
    const inner = Object.assign(Object.create(null), captured);
    const cctx = Object.assign({}, ctx, { scope: inner });
    params.forEach((p, i) => {
      inner[p] = args[i] === undefined ? defaults[i] : args[i];
    });
    if (variadic >= 0) {
      inner[params[variadic]] = args.slice(variadic);
    }
    if (node.kind === 'arrowfunc') return evalExpr(node.body, cctx, depth + 1);
    const st = { scope: inner, value: undefined, steps: 0, ctx: cctx };
    try {
      execStmts((node.body && node.body.children) || [], st, 0);
    } catch (e) {
      if (e instanceof Control && e.kind === 'return') return st.value;
      throw e;
    }
    return null;
  };
}

export default { runConfigStatements, makeClosure };
