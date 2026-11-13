// compiler/tests/_helpers.mjs — the stubs the compiler suites copied verbatim.
//
// The tests sweep found 35 helper bodies that were byte-identical across two
// or more suites (52 redundant copies, 439 lines). `compile` was one of them:
// both the increment/continue and the silent-wrong-construct suites compile
// the same throwaway controller to compare against PHP 8.3.

import { emitController } from '../src/controller.mjs';

// Wrap `body` in a minimal controller and emit it, so the test can compare the
// running rung against what PHP 8.3 answers for the same snippet.
export function compile(body) {
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n    public function demo()\n    {\n' +
    body +
    '\n        return response("ok");\n    }\n}\n';
  return emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
}
