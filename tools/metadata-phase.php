<?php

// One-shot metadata phase worker — build time only.
//
// Usage: php tools/metadata-phase.php <plan.json>
// plan.json: {
//   "models":       ["App\\Models\\Post", ...],
//   "formRequests": ["App\\Http\\Requests\\StorePostRequest", ...]
// }
//
// Output (stdout): {
//   "models":       [ model-dump entries ... ],   // recursive relation closure
//   "policy":       { globals, models },          // same shape as policy-dump.php
//   "formRequests": [ formrequest-dump entries ... ],
//   "errors":       [{section, message}, ...]
// }
//
// The whole point is ONE framework boot for model reflection, Gate/policy
// inspection and FormRequest rule evaluation. Each library below is the exact
// function its standalone CLI calls, so the values do not diverge.

require_once __DIR__ . '/_root.php';

define('LW_METADATA_LIB', true);
require_once __DIR__ . '/model-dump.php';
require_once __DIR__ . '/policy-dump.php';
require_once __DIR__ . '/formrequest-dump.php';

$planPath = $argv[1] ?? '';
$plan = $planPath !== '' ? json_decode((string) @file_get_contents($planPath), true) : null;
if (!is_array($plan)) {
    echo json_encode([
        'models' => [],
        'policy' => ['globals' => ['before' => 0, 'after' => 0, 'abilities' => [], 'definitions' => []], 'models' => []],
        'formRequests' => [],
        'errors' => [['section' => 'plan', 'message' => 'cannot read the metadata plan: ' . $planPath]],
    ], JSON_INVALID_UTF8_SUBSTITUTE);
    exit(0);
}

$errors = [];
$models = [];
$policy = ['globals' => ['before' => 0, 'after' => 0, 'abilities' => [], 'definitions' => []], 'models' => []];
$formRequests = [];

try {
    $root = lw_app_root();
    $app = lw_boot_app();

    // The same boot path as the standalone tools: a real request so config,
    // bindings, auth and the Gate are what a request sees. The response body
    // is irrelevant here; discard it instead of mixing HTML into the JSON.
    ob_start();
    $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $request = Illuminate\Http\Request::create('/', 'GET');
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);
    ob_end_clean();

    $app->instance('request', $request);

    $modelFqcns = array_values(array_filter((array) ($plan['models'] ?? []), 'is_string'));
    $formRequestFqcns = array_values(array_filter((array) ($plan['formRequests'] ?? []), 'is_string'));

    try {
        // recursive: true closes the declared-relation graph in this boot.
        $models = lw_dump_models($modelFqcns, true);
    } catch (Throwable $e) {
        $errors[] = ['section' => 'models', 'message' => get_class($e) . ': ' . $e->getMessage()];
    }

    try {
        $policy = lw_dump_policies($modelFqcns);
    } catch (Throwable $e) {
        $errors[] = ['section' => 'policy', 'message' => get_class($e) . ': ' . $e->getMessage()];
    }

    // A policy method may type-hint a model the controller never touched
    // (`update(User $user, Post $post)`). Pull those models into the same
    // recursive dump before the build builds the compiled registry.
    $policyModelFqcns = [];
    foreach ((array) ($policy['models'] ?? []) as $pm) {
        $paramLists = [];
        foreach ((array) ($pm['methods'] ?? []) as $method) {
            $paramLists[] = (array) ($method['params'] ?? []);
        }
        if (!empty($pm['before']['params'])) {
            $paramLists[] = (array) $pm['before']['params'];
        }
        foreach ($paramLists as $params) {
            foreach ($params as $p) {
                $type = $p['type'] ?? null;
                if (is_string($type) && $type !== '' && empty($p['builtin'])) {
                    $policyModelFqcns[$type] = true;
                }
            }
        }
    }
    $known = [];
    foreach ($models as $d) {
        $known[$d['fqcn']] = true;
    }
    $extra = array_values(array_diff(array_keys($policyModelFqcns), array_keys($known)));
    if ($extra) {
        try {
            foreach (lw_dump_models($extra, true) as $d) {
                if (!isset($known[$d['fqcn']])) {
                    $known[$d['fqcn']] = true;
                    $models[] = $d;
                }
            }
        } catch (Throwable $e) {
            $errors[] = ['section' => 'policy-models', 'message' => get_class($e) . ': ' . $e->getMessage()];
        }
    }

    try {
        $formRequests = lw_dump_formrequests($formRequestFqcns);
    } catch (Throwable $e) {
        $errors[] = ['section' => 'formRequests', 'message' => get_class($e) . ': ' . $e->getMessage()];
    }
} catch (Throwable $e) {
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $errors[] = ['section' => 'boot', 'message' => get_class($e) . ': ' . $e->getMessage()];
}

echo json_encode([
    'models' => $models,
    'policy' => $policy,
    'formRequests' => $formRequests,
    'errors' => $errors,
], JSON_INVALID_UTF8_SUBSTITUTE);
