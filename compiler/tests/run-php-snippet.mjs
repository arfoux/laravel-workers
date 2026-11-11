// compiler/tests/run-php-snippet.mjs — run a PHP snippet through the transpiler
// AND the JS runtime, then hand back what it echoed.
//
// Why a snippet runner instead of asserting on the emitted TEXT: a test like
// `assert.match(res.code, /break __sw\d+;/)` passes as long as that string is
// somewhere in the output, whatever the code then does — it fails on a rename
// and passes on a wrong answer (audit #894/#895). Here the snippet compiles,
// RUNS against the real runtime, and the assertion compares the output with
// what PHP 8.3 prints.
//
// Deliberately NOT a `*.test.mjs` file: it is a helper the test files import,
// and `tools/run-tests.mjs` discovers `*.test.mjs` only — as a test file it
// would be run as a suite of its own.
import { transpile } from '../src/transpiler.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

/**
 * Compile and run a PHP snippet; returns the snippet's output buffer (what PHP
 * would have echoed). Throws with `.lw` set to the compiler errors when the
 * snippet does not compile.
 */
export function runPhpSnippet(src) {
  const { code, errors } = transpile(src);
  if (errors && errors.length) {
    const err = new Error('transpile failed: ' + JSON.stringify(errors));
    err.lw = errors;
    throw err;
  }
  // The emitted module is `export default function main(rt) { ... }`; strip the
  // wrapper and run the body with the real runtime, so `echo` lands in
  // `rt.__output` exactly as the compiled rung produces it.
  const body = String(code)
    .replace(/^export default function main\(rt\)\s*\{\n?/, '')
    .replace(/\n\}\s*$/, '');
  const rt = buildRt({}, { strict: false });
  new Function('rt', body)(rt);
  return rt.__output;
}
