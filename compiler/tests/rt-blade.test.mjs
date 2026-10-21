#!/usr/bin/env node
// compiler/tests/rt-blade.test.mjs — the Blade runtime answers what Laravel answers.
//
// The A36 audit found four divergences between the Blade emulation and Laravel
// 13: the `@json` body lost Laravel's HEX flags and its depth, the `@yield`
// default and the inline `@section` content were not escaped, and a `@foreach`
// over a Collection ran the body ONCE with the whole array.
//
// The PHP in this file is what Laravel 13's Blade compiler writes for a
// template (the vendored Illuminate\View\Compilers\BladeCompiler); the runtime
// is fed the TRANSPILED form of it - the same calls the compiled worker makes.
// The expectations come from Laravel 13's own source and from PHP 8.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';
import { transpile } from '../src/transpiler.mjs';

// The compiled Blade of a template: `transpile()` it (the compiler the build
// uses) and run it against the runtime.
function runView(php, data) {
  const { code, errors } = transpile(php, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const inner = code.replace(/^export default function main\(rt\)\s*\{\n?/, '').replace(/\n\}\n?$/, '');
  const main = new Function('rt', inner);
  const rt = buildRt({}, { strict: false, data: data || {} });
  main(rt);
  return rt.__output;
}

// The compiled Blade of `@foreach ($collection as $item) ... @endforeach` with
// the loop bookkeeping (Illuminate\View\Compilers\Concerns\CompilesLoops:105).
const FOREACH_PHP =
  '<?php $__currentLoopData = $collection; $__env->addLoop($__currentLoopData); ' +
  'foreach($__currentLoopData as $item): $__env->incrementLoopIndices(); $loop = $__env->getLastLoop(); ?>' +
  '<?php echo e($item["t"]); ?>:<?php echo e($loop->iteration); ?>/<?php echo e($loop->count); ?>' +
  ':<?php echo e($loop->last ? "last" : "more"); ?> ' +
  '<?php endforeach; $__env->popLoop(); $loop = $__env->getLastLoop(); ?>';

test('rt-blade: @json writes the HEX flags Laravel compiles (the escaped body)', () => {
  // Illuminate\View\Compilers\Concerns\CompilesJson:12 - `@json($x)` compiles to
  // `json_encode($x, JSON_HEX_TAG|JSON_HEX_APOS|JSON_HEX_AMP|JSON_HEX_QUOT, 512)`
  // (CompilesJson:28). PHP: json_encode(['a' => '<b> & \'c\' "d"'], 15, 512)
  //   => {"a":"\u003Cb\u003E \u0026 \u0027c\u0027 \u0022d\u0022"}
  const out = runView('<?php echo json_encode($rows, 15, 512) ?>', { rows: { a: '<b> & \'c\' "d"' } });
  assert.equal(out, '{"a":"\\u003Cb\\u003E \\u0026 \\u0027c\\u0027 \\u0022d\\u0022"}');
  // The key is escaped too (PHP: json_encode(['k<v' => 1], 15, 512) => {"k\u003Cv":1}).
  const keyed = runView('<?php echo json_encode($rows, 15, 512) ?>', { rows: { 'k<v': 1 } });
  assert.equal(keyed, '{"k\\u003Cv":1}');
  // The slashes stay escaped (PHP's json_encode escapes them by default).
  const url = runView('<?php echo json_encode($rows, 15, 512) ?>', {
    rows: { url: 'https://a.test/x?y=1&z=2' },
  });
  assert.equal(url, '{"url":"https:\\/\\/a.test\\/x?y=1\\u0026z=2"}');
});

test('rt-blade: @json returns false past the depth (PHP: Maximum stack depth exceeded)', () => {
  const rt = buildRt({}, { strict: false });
  // PHP: json_encode([[1]], 0, 1) => false ; json_encode([[1]], 0, 2) => "[[1]]"
  assert.equal(rt.json_encode([[1]], 0, 1), false);
  assert.equal(rt.json_encode([[1]], 0, 2), '[[1]]');
  // A scalar is no level (PHP: json_encode('x', 0, 0) => "x").
  assert.equal(rt.json_encode('x', 0, 0), '"x"');
  // An empty array is one level (PHP: json_encode([], 0, 0) => false).
  assert.equal(rt.json_encode([], 0, 0), false);
  // The default depth is PHP's (512) and the default flags are PHP's (none).
  assert.equal(rt.json_encode({ a: '<b>' }), '{"a":"<b>"}');
  assert.equal(rt.json_encode({ a: '<b>' }, 0, 512), '{"a":"<b>"}');
});

test('rt-blade: a json_encode() flag that is not ported fails loud', () => {
  const rt = buildRt({}, { strict: false });
  // PHP: json_encode($x, JSON_UNESCAPED_UNICODE) writes the raw UTF-8. The edge
  // would write a different body, so it refuses instead of answering.
  assert.throws(() => rt.json_encode({ a: 'é' }, 256, 512), /not supported at the edge/);
  // The HEX flags are the ported ones (15 = TAG|AMP|APOS|QUOT).
  assert.equal(rt.json_encode({ a: '<' }, 15, 512), '{"a":"\\u003C"}');
});

test('rt-blade: @yield escapes the default (Laravel escapes it too)', () => {
  // Illuminate\View\Concerns\ManagesLayouts:157 - yieldContent() escapes the
  // default: e($default) (htmlspecialchars with ENT_QUOTES -
  // Illuminate\Support\helpers:138).
  // PHP: e('<b>Default & "x"</b>') => &lt;b&gt;Default &amp; &quot;x&quot;&lt;/b&gt;
  const out = runView("<?php echo $__env->yieldContent('title', $default); ?>", {
    default: '<b>Default & "x"</b>',
  });
  assert.equal(out, '&lt;b&gt;Default &amp; &quot;x&quot;&lt;/b&gt;');
  // A section that exists wins over the (escaped) default.
  const withSection = runView(
    "<?php $__env->startSection('title', $content); ?><?php echo $__env->yieldContent('title', $default); ?>",
    { content: 'Kept', default: '<b>Default</b>' }
  );
  assert.equal(withSection, 'Kept');
});

test('rt-blade: @section escapes the inline content (the block form stays raw)', () => {
  // Illuminate\View\Concerns\ManagesLayouts:53 - startSection() escapes the
  // inline content: e($content).
  // PHP: e('<b>Hi & "x"</b>') => &lt;b&gt;Hi &amp; &quot;x&quot;&lt;/b&gt;
  const out = runView(
    "<?php $__env->startSection('side', $content); ?><?php echo $__env->yieldContent('side'); ?>",
    { content: '<b>Hi & "x"</b>' }
  );
  assert.equal(out, '&lt;b&gt;Hi &amp; &quot;x&quot;&lt;/b&gt;');
  // The BLOCK form (@section ... @endsection) is raw on both sides
  // (ManagesLayouts:118 - stopSection() keeps the captured output).
  const block = runView(
    "<?php $__env->startSection('side'); ?><?php echo '<b>raw</b>'; ?>" +
      "<?php $__env->stopSection(); ?><?php echo $__env->yieldContent('side'); ?>"
  );
  assert.equal(block, '<b>raw</b>');
});

test('rt-blade: @foreach over a Collection runs the body once per item', () => {
  // Illuminate\Collections\Collection::getIterator() - the iteration yields the
  // ITEMS (not the fields of the wrapper), and count($collection) is the number
  // of the items (Illuminate\View\Concerns\ManagesLoops:25 - the loop's count).
  const rt = buildRt({}, { strict: false });
  // The Collection of the CONTROLLER's rt (a view renders with its own rt).
  const collection = rt.collect([{ t: 'a' }, { t: 'b' }, { t: 'c' }]);
  assert.equal(runView(FOREACH_PHP, { collection }), 'a:1/3:more b:2/3:more c:3/3:last ');
});

test('rt-blade: a Collection spreads its items (the paginator is untouched)', () => {
  const rt = buildRt({}, { strict: false });
  // PHP: [...collect([1,2,3])] => [1,2,3]
  assert.deepEqual(rt.spread(rt.collect([1, 2, 3])), [1, 2, 3]);
  // A PHP array with an "items" key is NOT a Collection: it stays an array.
  assert.deepEqual(rt.spread({ items: [1, 2] }), [[1, 2]]);
});
