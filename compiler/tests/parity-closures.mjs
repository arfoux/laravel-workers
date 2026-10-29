#!/usr/bin/env node
// compiler/tests/parity-closures.mjs — closure/arrow parity harness (transpiler pipeline)
import { transpile } from '../src/transpiler.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

let total=0, passed=0, failed=0;

function isEqual(a,b){
  if(Object.is(a,b)) return true;
  if(a!==null && b!==null && typeof a==='object' && typeof b==='object'){
    try{ return JSON.stringify(a)===JSON.stringify(b); } catch{ return false; }
  }
  return false;
}
function ok(name){ total++; passed++; console.log(`ok ${total} - ${name}`); }
function notOk(name,g,exp,extra){
  total++; failed++;
  console.log(`not ok ${total} - ${name}`);
  console.log(`  ---`);
  console.log(`    expected: ${JSON.stringify(exp)}`);
  console.log(`    got:      ${JSON.stringify(g)}`);
  if(extra) console.log(`    note: ${extra}`);
  console.log(`  ...`);
}
function check(name, got, expected){
  if(isEqual(got,expected)) ok(name); else notOk(name,got,expected);
}

function runPhp(phpSrc){
  const {code, errors}=transpile(phpSrc);
  if(errors && errors.length){
    const e=new Error('transpile failed: '+JSON.stringify(errors));
    e.lw=errors;
    throw e;
  }
  // strip outer export wrapper to get body
  const inner=code.replace(/^export default function main\(rt\)\s*\{\n?/,'').replace(/\n\}\n?$/,'');
  const fn=new Function('rt', inner);
  const rt=buildRt({}, {strict:false});
  fn(rt);
  return rt.__output;
}
function runPhpSafe(src){
  try{ return {out: runPhp(src), err:null}; } catch(e){ return {out:null, err:e}; }
}

// 1 closure by-value snapshot (mutating outer after creation doesn't affect)
{
  const src="<?php\n$x=10;\n$fn=function() use($x){ return $x; };\n$x=20;\necho $fn();\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure use($x) by-value snapshot 10 not 20', String(err), '10');
  else check('closure use($x) by-value snapshot 10 not 20', out, '10');
}
// 2 closure by-value with param
{
  const src="<?php\n$x=5;\n$fn=function($y) use($x){ return $x+$y; };\necho $fn(10);\n$x=100;\necho \",\";\necho $fn(10);\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure by-value with param snapshot', String(err), '15,15');
  else check('closure by-value with param snapshot', out, '15,15');
}
// 3 closure by-value multiple captures
{
  const src="<?php\n$a=1;\n$b=2;\n$fn=function() use($a,$b){ return $a+$b; };\n$a=10;\n$b=20;\necho $fn();\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure by-value multiple use($a,$b)', String(err), '3');
  else check('closure by-value multiple use($a,$b)', out, '3');
}
// 4 closure by-value inner mutation does not affect outer
{
  const src="<?php\n$x=10;\n$fn=function() use($x){ $x++; return $x; };\n$r=$fn();\necho $r;\necho \",\";\necho $x;\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure by-value inner ++ not affect outer', String(err), '11,10');
  else check('closure by-value inner ++ not affect outer', out, '11,10');
}
// 5 by-ref shared binding — outer change visible (optional todo)
{
  const src="<?php\n$x=10;\n$fn=function() use(&$x){ return $x; };\n$x=20;\necho $fn();\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure use(&$x) by-ref shared binding', 'ERR:'+String(err), '20');
  else check('closure use(&$x) by-ref shared binding', out, '20');
}
// 6 by-ref mutation inside affects outer
{
  const src="<?php\n$x=10;\n$fn=function() use(&$x){ $x++; return $x; };\necho $fn();\necho \",\";\necho $x;\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure use(&$x) inner ++ affects outer', 'ERR:'+String(err), '11,11');
  else check('closure use(&$x) inner ++ affects outer', out, '11,11');
}
// 7 arrow func single param
{
  const src="<?php\n$f=fn($x)=> $x*2;\necho $f(21);\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('arrow fn($x)=>$x*2', String(err), '42');
  else check('arrow fn($x)=>$x*2', out, '42');
}
// 8 arrow func two params
{
  const src="<?php\n$f=fn($a,$b)=> $a+$b;\necho $f(3,4);\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('arrow fn($a,$b)=>$a+$b', String(err), '7');
  else check('arrow fn($a,$b)=>$a+$b', out, '7');
}
// 9 arrow zero? - arrow with expression returning literal
{
  const src="<?php\n$f=fn()=> 99;\necho $f();\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('arrow fn()=>99', String(err), '99');
  else check('arrow fn()=>99', out, '99');
}
// 10 closure passed to collect()->filter
{
  const src="<?php\n$arr=[1,2,3,4];\n$res=collect($arr)->filter(function($v){ return $v % 2 == 0; })->toArray();\necho json_encode($res);\n";
  const {out,err}=runPhpSafe(src);
  // filter() PRESERVES the PHP keys: json_encode(collect([1,2,3,4])->filter(even)->toArray())
  // is {"1":2,"3":4} in real PHP (a probe against the vendored framework).
  if(err) notOk('closure via collect()->filter', String(err), '{"1":2,"3":4}');
  else check('closure via collect()->filter', out, '{"1":2,"3":4}');
}
// 11 closure passed to collect()->map
{
  const src="<?php\n$arr=[1,2,3];\n$res=collect($arr)->map(function($v){ return $v*2; })->toArray();\necho json_encode($res);\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure via collect()->map', String(err), '[2,4,6]');
  else check('closure via collect()->map', out, '[2,4,6]');
}
// 12 arrow passed to collect()->filter
{
  const src="<?php\n$arr=[1,2,3,4];\necho json_encode(collect($arr)->filter(fn($v)=> $v % 2 == 0)->toArray());\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('arrow via collect()->filter', String(err), '{"1":2,"3":4}');
  else check('arrow via collect()->filter', out, '{"1":2,"3":4}');
}
// 13 arrow passed to collect()->map
{
  const src="<?php\n$arr=[1,2,3];\necho json_encode(collect($arr)->map(fn($v)=> $v*2)->toArray());\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('arrow via collect()->map', String(err), '[2,4,6]');
  else check('arrow via collect()->map', out, '[2,4,6]');
}
// 14 closure direct call variable invocation
{
  const src="<?php\n$f=function($x){ return $x*3; };\necho $f(7);\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('closure direct call $f(7)', String(err), '21');
  else check('closure direct call $f(7)', out, '21');
}
// 15 basic S1 still pass (now) via rt directly — mirrors parity-now
{
  const FIXED_MS=Date.UTC(2024,1,29,15,4,5);
  const OrigDate=globalThis.Date;
  class FrozenDate extends OrigDate { constructor(...a){ if(a.length===0) super(FIXED_MS); else super(...a);} static now(){return FIXED_MS;} static UTC(...a){return OrigDate.UTC(...a);} static parse(s){return OrigDate.parse(s);} }
  globalThis.Date=FrozenDate;
  const rt=buildRt({}, {strict:false});
  const got=rt.now().format('Y-m-d H:i:s');
  globalThis.Date=OrigDate;
  check('S1 still pass: now format', got, '2024-02-29 15:04:05');
}
// 16 basic S2 still pass: collect chain via transpiler
{
  const src="<?php\necho json_encode(collect([1,2,3,4])->filter(function($v){ return $v>1; })->map(function($v){ return $v*2; })->toArray());\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('S2 chain filter->map', String(err), '{"1":4,"2":6,"3":8}');
  else check('S2 chain filter->map', out, '{"1":4,"2":6,"3":8}');
}
// 17 extra: collect()->count() as a direct chain - the $c = collect(); $c->count()
// form is controller context: a view refuses method calls on vars (LW002 by design)
{
  const src="<?php\necho collect([1,2,3])->count();\n";
  const {out,err}=runPhpSafe(src);
  if(err) notOk('collect count via php', String(err), '3');
  else check('collect count via php', out, '3');
}

console.log(`1..${total}`);
console.log(`# passed ${passed}/${total}`);
if(failed){ console.log(`# FAIL ${failed} failed`); process.exit(1); } else { console.log(`# PASS`); }
