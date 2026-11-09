// compiler/tests/livewire-markers.test.mjs — the Livewire 4 guard stripper.
//
// The payload strings below are copied verbatim from a real compile: PHP 8.3.30,
// livewire/livewire 4.4.8, `php tools/compile-view.php crud.show out.json /crud/1`
// on an app whose package manifest lists `Livewire\LivewireServiceProvider`
// (`config/livewire.php:211,224` = both marker flags on). The guard pair plus the
// six payloads are the complete surface the four emitters in
// `SupportMorphAwareBladeCompilation.php` can produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LIVEWIRE_GUARD_CLOSE,
  LIVEWIRE_GUARD_OPEN,
  normalizeViewDumpFiles,
  stripLivewireRenderGuards,
} from '../src/livewire-markers.mjs';

const guard = (payload) => LIVEWIRE_GUARD_OPEN + payload + LIVEWIRE_GUARD_CLOSE;

const BLOCK = '<!--[if BLOCK]><![endif]-->';
const ENDBLOCK = '<!--[if ENDBLOCK]><![endif]-->';
const wire = (name) =>
  `<?php \\Livewire\\Features\\SupportCompiledWireKeys\\SupportCompiledWireKeys::${name}(); ?>`;

// The six payloads observed in the real dump, in the order they appear there.
const REAL_PAYLOADS = [
  BLOCK,
  ENDBLOCK,
  BLOCK + wire('openLoop'),
  wire('startLoopIteration'),
  wire('endLoop'),
  ENDBLOCK + wire('closeLoop'),
];

// Two guards around a directive, exactly as `@if` inside a `@foreach` compiles.
const PLAIN = '<?php if($status): ?><p class="flash">ok</p><?php endif; ?>';
const GUARDED =
  guard(BLOCK + wire('openLoop')) +
  '<?php $__currentLoopData = $posts; ?>' +
  guard(wire('startLoopIteration')) +
  PLAIN +
  guard(wire('endLoop'));

test('every payload the Livewire precompiler emits is removed with its guard', () => {
  for (const payload of REAL_PAYLOADS) {
    const { compiled, guards } = stripLivewireRenderGuards(guard(payload));
    assert.equal(compiled, '', `payload not removed: ${JSON.stringify(payload)}`);
    assert.equal(guards, 1);
  }
});

test('removing the guards leaves the directive bytes untouched', () => {
  const { compiled, guards } = stripLivewireRenderGuards(GUARDED);
  assert.equal(
    compiled,
    '<?php $__currentLoopData = $posts; ?>' + PLAIN,
    'the guarded compile must reduce to the same bytes a flag-off compile produces'
  );
  assert.equal(guards, 3);
  // What actually broke the build: the guarded bytes still name the class.
  assert.doesNotMatch(compiled, /isRenderingLivewireComponent|SupportCompiledWireKeys/);
});

test('an unknown payload is left in place (fail loud, not a silent strip)', () => {
  const unknown = guard('<!--[if SOMETHING-NEW]><![endif]-->');
  const { compiled, guards } = stripLivewireRenderGuards('x' + unknown + 'y');
  assert.equal(compiled, 'x' + unknown + 'y');
  assert.equal(guards, 0);
});

test('an empty guard is left in place (no payload means no known marker)', () => {
  const { compiled, guards } = stripLivewireRenderGuards(guard(''));
  assert.equal(compiled, guard(''));
  assert.equal(guards, 0);
});

test('guard-free PHP is returned unchanged', () => {
  for (const source of ['', 'plain text', PLAIN, '<?php echo 1; ?>']) {
    const { compiled, guards } = stripLivewireRenderGuards(source);
    assert.equal(compiled, source);
    assert.equal(guards, 0);
  }
  assert.deepEqual(stripLivewireRenderGuards(null), { compiled: null, guards: 0 });
});

test('adjacent and repeated guards are all removed', () => {
  const source = guard(BLOCK) + guard(BLOCK) + PLAIN + guard(ENDBLOCK);
  const { compiled, guards } = stripLivewireRenderGuards(source);
  assert.equal(compiled, PLAIN);
  assert.equal(guards, 3);
  // Idempotent: a second pass has nothing left to do.
  assert.deepEqual(stripLivewireRenderGuards(compiled), { compiled: PLAIN, guards: 0 });
});

test('normalizeViewDumpFiles rewrites only the dumps that carry guards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-livewire-markers-'));
  try {
    const guarded = join(dir, 'crud.show.compiled.json');
    const clean = join(dir, 'home.compiled.json');
    const skipped = join(dir, 'view-manifest.json');
    const broken = join(dir, 'broken.compiled.json');
    writeFileSync(
      guarded,
      JSON.stringify({ view: 'crud.show', path: '/app/views/crud/show.blade.php', compiled: GUARDED, context: { url: '/' } })
    );
    writeFileSync(clean, JSON.stringify({ view: 'home', compiled: PLAIN }));
    writeFileSync(skipped, JSON.stringify({ views: ['home'] }));
    writeFileSync(broken, '{not json');

    const res = normalizeViewDumpFiles(dir);
    assert.deepEqual(res, { files: 1, guards: 3 });

    const rewritten = JSON.parse(readFileSync(guarded, 'utf8'));
    assert.equal(rewritten.compiled, '<?php $__currentLoopData = $posts; ?>' + PLAIN);
    // The rest of the dump survives the rewrite untouched.
    assert.equal(rewritten.view, 'crud.show');
    assert.equal(rewritten.path, '/app/views/crud/show.blade.php');
    assert.deepEqual(rewritten.context, { url: '/' });
    // A dump without guards is not rewritten at all (same bytes on disk).
    assert.equal(readFileSync(clean, 'utf8'), JSON.stringify({ view: 'home', compiled: PLAIN }));
    assert.equal(readFileSync(skipped, 'utf8'), JSON.stringify({ views: ['home'] }));
    assert.equal(readFileSync(broken, 'utf8'), '{not json');

    // A second run is a no-op.
    assert.deepEqual(normalizeViewDumpFiles(dir), { files: 0, guards: 0 });
    assert.deepEqual(normalizeViewDumpFiles(join(dir, 'nope')), { files: 0, guards: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
