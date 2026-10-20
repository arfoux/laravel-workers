<?php

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$app->instance('request', $request);

$out = [];

foreach (array_slice($argv, 1) as $fqcn) {
    $entry = [
        'fqcn' => $fqcn,
        'rules' => [],
        'messages' => [],
        'attributes' => [],
        'authorize' => true,
        'error' => null,
    ];

    try {
        if (!class_exists($fqcn)) {
            $entry['error'] = 'class not found';
            $out[] = $entry;
            continue;
        }
        $rc = new ReflectionClass($fqcn);
        if (!$rc->isSubclassOf(Illuminate\Foundation\Http\FormRequest::class)) {
            $entry['error'] = 'not a FormRequest';
            $out[] = $entry;
            continue;
        }

        if ($rc->hasMethod('prepareForValidation')) {
            $m = $rc->getMethod('prepareForValidation');
            if ($m->getDeclaringClass()->getName() === $fqcn) {
                $entry['error'] = 'prepareForValidation() is overridden - the compiled rung does not run it (the validated input would differ)';
                $out[] = $entry;
                continue;
            }
        }

        // The FormRequest constructor runs validateResolved() — instantiating it
        // with an empty request would throw a ValidationException before we
        // could read the rules. Build the instance without the constructor and
        // call the rule methods directly (they do not depend on request state).
        $fr = $rc->newInstanceWithoutConstructor();

        try {
            $entry['authorize'] = (bool) $fr->authorize();
        } catch (Throwable $e) {
            $entry['error'] = 'authorize() failed: ' . get_class($e) . ': ' . $e->getMessage();
            $out[] = $entry;
            continue;
        }
        if ($entry['authorize'] === false) {
            $entry['error'] = 'authorize() returns false';
            $out[] = $entry;
            continue;
        }

        $entry['rules'] = $fr->rules();
        $entry['messages'] = $fr->messages();
        $entry['attributes'] = $fr->attributes();

        // A rule *object* (`Rule::file()->max(2048)`) is a class: the compiled
        // rung evaluates the string rules only, so the build must stop instead
        // of validating something else.
        $objectRule = null;
        $walk = function ($rules) use (&$walk, &$objectRule) {
            foreach ((array) $rules as $key => $rule) {
                if (is_object($rule)) {
                    $objectRule = is_object($key) ? get_class($key) : get_class($rule);
                    return;
                }
                if (is_array($rule)) {
                    $walk($rule);
                    if ($objectRule !== null) {
                        return;
                    }
                }
            }
        };
        $walk($entry['rules']);
        if ($objectRule !== null) {
            $entry['error'] = 'the rules use a rule object (' . $objectRule . ') - the compiled rung evaluates the string rules only';
        }
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    $out[] = $entry;
}

echo json_encode($out);
