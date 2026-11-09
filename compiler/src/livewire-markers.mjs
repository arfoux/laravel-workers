// compiler/src/livewire-markers.mjs — Livewire 4's component-only Blade guards.
//
// WHY THIS FILE EXISTS
// A Laravel app with Livewire installed boots Livewire's
// `Features/SupportMorphAwareBladeCompilation`, which registers a Blade
// *precompiler* (default: `config('livewire.inject_morph_markers') = true` and
// `config('livewire.smart_wire_keys') = true`, `config/livewire.php:211,224` in
// livewire 4.4.8). It walks every conditional/loop directive and wraps morph
// markers — and the `SupportCompiledWireKeys` loop calls — in a *runtime* guard:
//
//   <?php if(\Livewire\Mechanisms\ExtendBlade\ExtendBlade::isRenderingLivewireComponent()): ?>
//   <!--[if BLOCK]><![endif]-->
//   <?php endif; ?>
//
// THAT GUARD IS NEVER TRUE HERE. `ExtendBlade` sets its flag only between
// `startLivewireRendering()`/`endLivewireRendering()`, i.e. only while a Livewire
// COMPONENT renders. This build serves route views and error views, and a Livewire
// component is out of scope by design (`MAP.md`: "Livewire ... hard"; its edge
// entry is a hand-written port, see `compiler/src/controller.mjs` — a component
// class is refused with a hint to port it). Measured on a real Livewire 4.4.8 app
// (PHP 8.3.30) whose Blade compile carries exactly these guards: at render time
// `isRenderingLivewireComponent()` is `false`, and `[if BLOCK]` never reaches the
// HTML body.
//
// SO THE EDGE'S REFERENCE COMPILE IS THE GUARD-FREE COMPILE, and removing the
// guards is byte-for-byte the same view compiled with those two flags off: the
// precompiler only *inserts* the constant strings below, it never rewrites the
// directive next to them. Left in place, the guards make the build fail on an app
// that some other machine built successfully — the compile depends on whether the
// app's scratch package manifest happens to list Livewire:
//   - `blade2php diverged from Laravel for <view> at byte <n>` (a BLOCK finding,
//     because `blade2php` compiles the view source and knows no Livewire), and
//   - `LW003 unknown class/static
//     Livewire\Mechanisms\ExtendBlade\ExtendBlade::isRenderingLivewireComponent`
//     when the transpiler is handed the guarded PHP, which skips the view — and
//     every controller whose view did not compile with it (13 views + 12
//     controllers, 25 findings, measured on `lw-showcase`).
//
// The removal is deliberately STRICT: only the exact guard pair wrapping an exact,
// whitelisted payload (one marker and/or one loop call — the four emitters in
// `SupportMorphAwareBladeCompilation.php` never emit anything else, and never in
// another order) is removed. Any other payload is left in place, so a future
// Livewire release or an app that hooks Blade itself keeps failing loud instead of
// shipping a body that differs from the reference.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The runtime guard Livewire wraps its markers in. */
export const LIVEWIRE_GUARD_OPEN =
  '<?php if(\\Livewire\\Mechanisms\\ExtendBlade\\ExtendBlade::isRenderingLivewireComponent()): ?>';
/** The guard's closing tag. */
export const LIVEWIRE_GUARD_CLOSE = '<?php endif; ?>';

const BLOCK = '<!--[if BLOCK]><![endif]-->';
const ENDBLOCK = '<!--[if ENDBLOCK]><![endif]-->';

const wireCall = (name) =>
  `<?php \\Livewire\\Features\\SupportCompiledWireKeys\\SupportCompiledWireKeys::${name}(); ?>`;

/**
 * Every payload the precompiler can put inside the guard: at most one marker
 * (prefix) and at most one loop call, marker first.
 *
 * `prefixOpeningDirective` → `BLOCK` [+ `openLoop()`]
 * `suffixClosingDirective` → [`endLoop()`] prefix, `ENDBLOCK` [+ `closeLoop()`] suffix
 * `suffixLoopEmptyDirective` → [`endLoop()`] prefix, [`closeLoop()`] suffix
 * `compileEarlyLoopExitDirective` → `ENDBLOCK`
 */
const PAYLOADS = [];
for (const marker of ['', BLOCK, ENDBLOCK]) {
  for (const call of ['', 'openLoop', 'startLoopIteration', 'endLoop', 'closeLoop']) {
    if (!marker && !call) continue;
    PAYLOADS.push(marker + (call ? wireCall(call) : ''));
  }
}

/**
 * Remove Livewire's component-only Blade guards from compiled view PHP.
 *
 * @param {string} compiled the PHP `Illuminate\View\Compilers\BladeCompiler` produced
 * @returns {{ compiled: string, guards: number }} the guard-free PHP and how many
 *   guards were removed (0 when the app has no Livewire, or none of them matched —
 *   an unmatched one is left alone on purpose).
 */
export function stripLivewireRenderGuards(compiled) {
  if (typeof compiled !== 'string' || !compiled.includes('isRenderingLivewireComponent')) {
    return { compiled, guards: 0 };
  }
  let out = compiled;
  let guards = 0;
  for (const payload of PAYLOADS) {
    const needle = LIVEWIRE_GUARD_OPEN + payload + LIVEWIRE_GUARD_CLOSE;
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at)) {
      out = out.slice(0, at) + out.slice(at + needle.length);
      guards++;
    }
  }
  return { compiled: out, guards };
}

/**
 * Normalize the compiled-PHP dumps a `compile-view.php --batch` run left in
 * `dir` (`*.compiled.json`), in place, before anything reads them.
 *
 * Only the `compiled` field is touched, and only when a guard was actually
 * removed, so a dump from an app without Livewire is byte-identical afterwards.
 *
 * @param {string} dir the build's cache dir
 * @returns {{ files: number, guards: number }} files rewritten, guards removed
 */
export function normalizeViewDumpFiles(dir) {
  if (!existsSync(dir)) return { files: 0, guards: 0 };
  let files = 0;
  let guards = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.compiled.json')) continue;
    const file = join(dir, entry);
    let dump;
    try {
      dump = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // not ours to repair: the reader reports the unreadable dump
    }
    const stripped = stripLivewireRenderGuards(dump?.compiled);
    if (!stripped.guards) continue;
    dump.compiled = stripped.compiled;
    writeFileSync(file, JSON.stringify(dump));
    files++;
    guards += stripped.guards;
  }
  return { files, guards };
}
