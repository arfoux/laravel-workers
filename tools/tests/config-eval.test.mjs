// tools/tests/config-eval.test.mjs — the build-time config fold against PHP 8.3.
//
// tools/static.mjs + tools/php-funcs.mjs fold `config/*.php` at BUILD time, and
// the compiled worker boots with whatever they answered. So a folded value that
// differs from PHP's — by value, by key, or by KEY ORDER — is a live divergence
// on the edge, and `tools/php-funcs.mjs`'s header promises this file as the
// pin (rule 1: "A function that IS implemented must answer exactly what PHP 8.3
// answers (pinned by tools/tests/config-eval.test.mjs against the PHP oracle)",
// rule 2: "A function that is NOT implemented ... is REFUSED BY NAME").
//
// Two halves, both from fixtures/config-eval/:
//   * the EXPRESSION corpus (cases.json, oracle.php): 231 expressions evaluated
//     by real PHP and by the fold, compared on value AND array key order, plus
//     the `refused` map that pins the fold's refusals by reason — a refusal that
//     is not listed fails, so "answering undefined silently" (the bug class that
//     made config values vanish) cannot come back unnoticed.
//   * the STATEMENT app (app/, oracle-app.php): whole config files, folded by
//     `loadConfig()` and `include`d by PHP, compared BYTE FOR BYTE — this is
//     what covers `$a[] =`, `unset()`, reordering, loops and closures, none of
//     which a single expression can express.
//
// The PHP oracle half SKIPS (with its reason) when no `php` binary is on PATH or
// named by LW_PHP — the repo's CI test job has no PHP; the parity-oracle job
// does. The fold-only expectations below always run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePhpSource, evalConfigExpr, loadConfig } from '../static.mjs';
import { phpFuncs } from '../php-funcs.mjs';
import { phpJsonEncode } from '../../kernel/php-json.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config-eval');
const CASES = JSON.parse(readFileSync(join(FIX, 'cases.json'), 'utf8'));

/** The oracle's PHP: LW_PHP first (CI names the binary it installed), then PATH. */
function findPhp() {
  const bin = process.env.LW_PHP || 'php';
  const probe = spawnSync(bin, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' });
  return probe.status === 0 ? { bin, version: probe.stdout.trim() } : null;
}

const PHP = findPhp();
const noPhp = PHP ? false : 'no PHP binary on PATH (set LW_PHP=/path/to/php to run the oracle half)';

/** Fold one corpus expression the way `static.mjs` folds a config file's value. */
function foldExpr(expr) {
  const ctx = {
    env: {},
    appDir: process.cwd(),
    file: null,
    scope: Object.create(null),
    funcs: null,
    evalExpr: null,
  };
  ctx.funcs = phpFuncs(ctx);
  ctx.evalExpr = (node, c = ctx, d = 0) => evalConfigExpr(node, c, d);
  let ast;
  try {
    ast = parsePhpSource('<?php return ' + expr + ';');
  } catch (e) {
    return { kind: 'parse-error', error: String(e && e.message) };
  }
  const st = ast.children && ast.children[0];
  if (!st || st.kind !== 'return') return { kind: 'parse-error', error: 'no return node' };
  ctx.lastRefusal = null;
  let value;
  try {
    value = evalConfigExpr(st.expr, ctx, 0);
  } catch (e) {
    return { kind: 'threw', error: String((e && e.message) || e), name: e && e.name };
  }
  if (value === undefined) {
    const r = ctx.lastRefusal;
    return { kind: 'refused', reason: (r && r.reason) || null };
  }
  return { kind: 'value', value };
}

/** PHP's array key order as the fold records it: the `__lwOrder` marker, read
 *  depth-first (a JS object cannot enumerate `{"b":1,"0":2}` in PHP's order). */
function orderWalk(v, prefix = '', out = []) {
  if (Array.isArray(v)) {
    out.push(prefix + '[' + v.map((_, i) => i).join(',') + ']');
    v.forEach((x, i) => orderWalk(x, prefix + '.' + i, out));
    return out;
  }
  if (v !== null && typeof v === 'object') {
    const order = (Array.isArray(v.__lwOrder) ? v.__lwOrder : Object.keys(v)).map(String);
    out.push(prefix + '[' + order.join(',') + ']');
    for (const k of order) orderWalk(v[k], prefix + '.' + k, out);
  }
  return out;
}

const canon = (v) => (v === undefined ? '<undefined>' : JSON.stringify(v));

test('every expression the corpus lists as refused is refused WITH a reason', () => {
  const silent = [];
  for (const [expr, reason] of Object.entries(CASES.refused)) {
    const got = foldExpr(expr);
    if (got.kind !== 'refused') {
      silent.push(`${expr}: expected a refusal (${reason}), got ${got.kind}:${canon(got.value)}`);
    } else if (!got.reason || !String(got.reason).startsWith(reason)) {
      silent.push(`${expr}: refused with the wrong reason\n      want: ${reason}\n      got:  ${got.reason}`);
    }
  }
  assert.deepEqual(silent, [], `the fold answered (or mis-reported) a refused expression:\n  ${silent.join('\n  ')}`);
  // A refusal with NO reason is the silent-undefined bug class: the key would
  // vanish from the dump with nothing naming it.
  const reasonless = CASES.expressions.filter((e) => {
    const g = foldExpr(e);
    return g.kind === 'refused' && !g.reason && !(e in CASES.refused);
  });
  assert.deepEqual(reasonless, [], 'these expressions were refused without a reason and are not in the refused map');
});

test('the fold answers PHP 8.3 exactly, value and key order', { skip: noPhp }, () => {
  const oracle = spawnSync(PHP.bin, [join(FIX, 'oracle.php'), join(FIX, 'cases.json')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(oracle.status, 0, `oracle.php failed (${PHP.bin} ${PHP.version}): ${oracle.stderr}`);
  const php = JSON.parse(oracle.stdout);
  const diffs = [];
  let same = 0;
  for (const expr of CASES.expressions) {
    const mine = foldExpr(expr);
    const theirs = php[expr];
    // 1) A documented EDGE ANSWER: the fold is supposed to answer something other
    //    than the build host's PHP (the compiled rung is JavaScript). The corpus
    //    pins the value, so a change here is a decision, not an accident.
    const edge = CASES.edgeAnswers[expr];
    if (edge) {
      if (mine.kind !== 'value' || canon(mine.value) !== canon(edge.value)) {
        diffs.push(`${expr}: edge answer is ${canon(edge.value)} (${edge.why}), fold answered ${mine.kind}:${canon(mine.value)}`);
      } else same++;
      continue;
    }
    // 2) A documented REFUSAL: declining is the honest answer, and the reason
    //    must be the documented one (test 1 pins that; here it is just "matched").
    if (expr in CASES.refused) {
      if (mine.kind !== 'refused') diffs.push(`${expr}: must be refused (${CASES.refused[expr]}), fold answered ${canon(mine.value)}`);
      else same++;
      continue;
    }
    if (theirs.kind === 'threw') {
      // PHP itself refuses the expression (a TypeError, a ValueError, a missing
      // argument): the fold must decline too, never answer a value PHP never had.
      if (mine.kind !== 'refused') diffs.push(`${expr}: php threw ${theirs.class}, fold answered ${canon(mine.value)}`);
      else same++;
      continue;
    }
    if (mine.kind !== 'value') {
      diffs.push(`${expr}: php=${theirs.json} fold=${mine.kind}${mine.reason ? ' — ' + mine.reason : ''}`);
      continue;
    }
    const valueSame = canon(mine.value) === canon(JSON.parse(theirs.json));
    const orderSame = orderWalk(mine.value).join('|') === theirs.order;
    if (valueSame && orderSame) same++;
    else if (!valueSame) diffs.push(`${expr}: php=${theirs.json} fold=${canon(mine.value)}`);
    else diffs.push(`${expr}: key ORDER — php=${theirs.order} fold=${orderWalk(mine.value).join('|')}`);
  }
  assert.deepEqual(diffs, [], `the fold diverges from PHP 8.3 on ${diffs.length} expression(s):\n  ${diffs.join('\n  ')}`);
  assert.ok(same >= CASES.expressions.length, `${same} of ${CASES.expressions.length} expressions matched`);
});

test('a whole config directory folds to the bytes PHP includes', { skip: noPhp }, () => {
  const app = join(FIX, 'app');
  const folded = loadConfig(app, {});
  assert.equal(folded.error, null, 'the fixture app must fold without a file-level error');
  assert.deepEqual(folded.drops, [], 'the fixture app uses only constructs the fold models');
  const theirs = spawnSync(PHP.bin, [join(FIX, 'oracle-app.php'), app], { encoding: 'utf8' });
  assert.equal(theirs.status, 0, `oracle-app.php failed: ${theirs.stderr}`);
  // `phpJsonEncode` is the kernel's own encoder (the one the worker writes with),
  // so this is the wire format against PHP's default json_encode, byte for byte —
  // which also pins every key's ORDER and the append/unset/hole semantics.
  assert.equal(phpJsonEncode(folded.config), theirs.stdout);
});

test('`$a[] =` and `unset()` answer PHP’s keys and PHP’s order without PHP', () => {
  const { config } = loadConfig(join(FIX, 'app'), {});
  // Verified against PHP 8.3 by the byte-for-byte test above; pinned here too so
  // a machine without PHP still catches a regression in the append counter or in
  // the order marker.
  assert.equal(phpJsonEncode(config.append.append_assoc), '{"a":1,"0":2}');
  assert.equal(phpJsonEncode(config.append.unset_then_append), '{"a":1,"b":2,"0":4}');
  assert.equal(phpJsonEncode(config.append.hole_then_append), '{"0":1,"2":3,"3":9}');
  assert.equal(phpJsonEncode(config.append.numeric_then_append), '{"5":"five","6":"six"}');
  assert.equal(phpJsonEncode(config.append.assoc_then_append), '{"x":1,"y":2,"z":3,"0":4}');
  // PHP's append counter, which `max(integer key) + 1` gets wrong the moment an
  // unset() removed the highest key, a fold function built the array, or the
  // array had no integer key yet (probed PHP 8.3 answers; the byte-for-byte
  // test above re-checks every one of them against the real interpreter).
  assert.equal(phpJsonEncode(config.append.counter_high_unset), '{"6":"y"}');
  assert.equal(phpJsonEncode(config.append.counter_mid_unset), '{"0":1,"1":2,"3":"z"}');
  assert.equal(phpJsonEncode(config.append.counter_after_merge), '{"0":1,"2":3}');
  assert.equal(phpJsonEncode(config.append.counter_explicit_lower), '{"10":"x","3":"y","11":"z"}');
  assert.equal(phpJsonEncode(config.append.counter_negative_literal), '{"-5":"neg","-4":"zero"}');
  assert.equal(phpJsonEncode(config.append.counter_empty_negative), '{"-5":"a","-4":"b"}');
  assert.equal(phpJsonEncode(config.append.counter_string_then_negative), '{"x":1,"-5":"y","-4":"z"}');
  assert.equal(phpJsonEncode(config.append.counter_list_then_negative), '{"0":"x","-3":"n","1":"z"}');
  // php-parser nests PHP 7's `.` precedence; the fold (and the transpiler, via
  // its own txMix()) must answer PHP 8's tree: `1 . (2 + 3)` = '15'.
  assert.equal(phpJsonEncode(config.append.precedence_concat_plus), '"15"');
  assert.equal(phpJsonEncode(config.append.precedence_concat_var_plus), '"x3"');
  // `<< >>` bind tighter than `.` in PHP 8 as well (a fold-only form: the
  // transpiler refuses the shift operators outright).
  assert.equal(phpJsonEncode(config.append.precedence_concat_shift_left), '"a4"');
  assert.equal(phpJsonEncode(config.append.precedence_shift_concat_right), '"4a"');
});

test('a declaration is inert and a `const` is readable; a CALL is a loud poison', () => {
  // The declaration half: no error, no drop, the file's own values.
  const dir = mkdtempSync(join(tmpdir(), 'lw-config-eval-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'declarations.php'),
    readFileSync(join(FIX, 'app', 'config', 'declarations.php'))
  );
  try {
    const out = loadConfig(dir, {});
    assert.equal(out.error, null, 'a declaration must not fail the whole file');
    assert.deepEqual(out.drops, [], 'an inert declaration must not report a drop');
    assert.deepEqual(out.config.declarations, { limit: 10, name: 'laravel-workers', sum: 15 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The call half: the fold does not implement the app's own functions, so an
  // expression statement that calls one leaves the file's state unknown - the
  // file is poisoned LOUDLY (named in the error), never folded as a guess.
  const dir2 = mkdtempSync(join(tmpdir(), 'lw-config-eval-'));
  mkdirSync(join(dir2, 'config'), { recursive: true });
  writeFileSync(join(dir2, 'config', 'declared_call.php'), readFileSync(join(FIX, 'refused-app', 'config', 'declared_call.php')));
  try {
    const out = loadConfig(dir2, {});
    assert.match(String(out.error), /lw_call_helper\(\)/, 'the call must be named in the file-level error');
    assert.equal(out.config.declared_call, undefined, 'the group must not be folded');
    assert.ok(
      out.drops.some((d) => d.key === '<group>' && d.group === 'declared_call'),
      'the whole-group drop entry must be present'
    );
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('a config file the fold cannot execute is an ERROR, not a silently wrong group', () => {
  const files = {
    'destructure.php': /list\(\)\/\[\.\.\] destructuring/,
    'byref.php': /foreach by reference/,
    'static_var.php': /statement 'static'/,
    'try_finally.php': /statement 'try'/,
    'expr_statement.php': /not a PHP function the fold models|sort\(\)/,
    'unset_key.php': /unset\(\) offset key/,
  };
  for (const [file, reason] of Object.entries(files)) {
    const dir = mkdtempSync(join(tmpdir(), 'lw-config-eval-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', file), readFileSync(join(FIX, 'refused-app', 'config', file)));
    const out = loadConfig(dir, {});
    try {
      assert.ok(out.error, `${file}: loadConfig must report an error (a plausible-but-wrong config is worse than none)`);
      assert.match(out.error, new RegExp(file.replace('.', '\\.')), `${file}: the error must name the file`);
      assert.match(out.error, reason, `${file}: the error must name the reason`);
      // The group is NOT folded at all, and the drop report says so with the
      // whole-group entry (key `<group>`), which config-dump prints as such.
      const group = file.replace('.php', '');
      assert.equal(out.config[group], undefined, `${file}: the group must be absent from the folded config`);
      assert.ok(
        out.drops.some((d) => d.key === '<group>' && d.group === group),
        `${file}: the drop report must carry the whole-group entry`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a KEY-level refusal drops that key and does not fail the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-config-eval-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'key_drop.php'), readFileSync(join(FIX, 'refused-app', 'config', 'key_drop.php')));
  try {
    const out = loadConfig(dir, {});
    // An unimplemented builtin is a dropped key with a named reason — the
    // documented contract ("the compiled worker answers null for these keys").
    assert.equal(out.error, null, 'a key-level refusal must not fail the whole dump');
    assert.deepEqual(out.config.key_drop, { kept: 'yes' });
    const drop = out.drops.find((d) => String(d.key).includes('div'));
    assert.ok(drop, 'the dropped key must be named in the report');
    assert.equal(drop.group, 'key_drop');
    assert.match(String(drop.reason), /intdiv\(\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
