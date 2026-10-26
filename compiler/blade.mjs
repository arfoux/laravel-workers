// compiler/blade.mjs — the seam where the PHP runtime's Blade compiler is
// replaced by the pure-JS `blade2php` compiler.
//
// Build time only. This is NOT a transpiler: it produces the SAME PHP bytes
// `Illuminate\View\Compilers\BladeCompiler::compileString()` would, so the rest
// of the pipeline (transpile.mjs PHP→JS) is untouched. PHP runtime disappears
// from the Blade step; PHP as an intermediate representation stays — which is
// all the transpiler consumes.
//
// The seam intentionally keeps the exact `compile-view.php` contract:
//   input:  view source (.blade.php text)
//   output: { compiled, directives } — `compiled` is the PHP the transpiler
//   expects, `directives` is diagnostic surface for tooling.
//
// The app context (config, routes, vite, urls) that compile-view.php captured
// by booting Laravel is NOT produced here — that is Phase 0's job. Until Phase 0,
// the caller still gets that context the old way; this module replaces only the
// Blade step.

import { compile, BladeCompileError } from 'blade2php';

/**
 * Compile Blade to the exact Laravel PHP bytes without a PHP interpreter.
 *
 * @param {string} source the .blade.php source
 * @param {object} [options]
 * @param {string} [options.laravel]    major: '10' | '11' | '12' | '13' (default 13)
 * @param {string} [options.app]        a Laravel app root, for static component
 *                                      resolution — same seam as the build appRoot
 * @param {boolean} [options.strict]    unknown directives fail loud (default off,
 *                                      matching Laravel's pass-through)
 * @param {string} [options.path]       used in error messages
 * @returns {{ compiled: string, directives: number }}
 * @throws {BladeCompileError}
 */
export function compileView(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('compileView(source) expects a string of Blade source');
  }
  const compiled = compile(source, options);

  return {
    compiled,
    // Count of directives actually expanded — a cheap fingerprint for tooling.
    directives: (compiled.match(/\B@\w+/g) || []).length,
  };
}

export { BladeCompileError };
export default compileView;
