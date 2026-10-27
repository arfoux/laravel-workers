<?php

// Dump the Gate/policy metadata for the edge build — build time only.
// Usage: php tools/policy-dump.php "App\Models\Post" ["App\Models\User" ...]
// Output (stdout): JSON
//   { "globals": { "before": 0, "after": 0, "abilities": [] },
//     "models": [ { model, policy, file, error, hasMagicCall, before, methods } ] }
//
// The app is booted through the same HTTP-kernel path as tools/model-dump.php, so
// the Gate the build sees is the Gate a real request sees (the policies that
// are registered, the global before/after callbacks, the Gate::define abilities).
//
// The guest rules are Laravel's own (Illuminate\Auth\Access\Gate):
//   parameterAllowsGuests(): (hasType && allowsNull) || (default available && default null)
//   methodAllowsGuests():    the first parameter allows guests
// The compiled rung mirrors them exactly — a guest that the policy does not
// allow is denied, not called.
//
// The function is also used by tools/metadata-phase.php, which boots the app
// once and asks for models + policies + FormRequests in one PHP process.

require_once __DIR__ . '/_root.php';

function lw_dump_policies(array $fqcns): array
{
    $app = app();

    $readProp = function ($object, string $name) {
        $rc = new ReflectionClass($object);
        if (! $rc->hasProperty($name)) {
            return null;
        }
        $prop = $rc->getProperty($name);
        $prop->setAccessible(true);

        return $prop->getValue($object);
    };

    // Illuminate\Auth\Access\Gate::parameterAllowsGuests()
    $parameterAllowsGuests = function (ReflectionParameter $parameter): bool {
        if ($parameter->hasType() && $parameter->allowsNull()) {
            return true;
        }
        if (! $parameter->isDefaultValueAvailable()) {
            return false;
        }
        try {
            return is_null($parameter->getDefaultValue());
        } catch (Throwable $e) {
            return false;
        }
    };

    // Illuminate\Auth\Access\Gate::methodAllowsGuests()
    $methodAllowsGuests = function (ReflectionMethod $method) use ($parameterAllowsGuests): bool {
        $parameters = $method->getParameters();
        if (! count($parameters)) {
            return false;
        }

        return $parameterAllowsGuests($parameters[0]);
    };

    $paramMeta = function (ReflectionParameter $p): array {
        $type = $p->getType();
        $tname = null;
        $builtin = false;
        $allowsNull = false;
        if ($type instanceof ReflectionNamedType) {
            $tname = $type->getName();
            $builtin = $type->isBuiltin();
            $allowsNull = $type->allowsNull();
        } elseif ($type !== null) {
            $tname = 'complex'; // a union / an intersection type
        }
        $hasDefault = $p->isDefaultValueAvailable();
        $default = null;
        $defaultOk = true;
        if ($hasDefault) {
            try {
                $d = $p->getDefaultValue();
                if (is_object($d) || is_array($d)) {
                    $defaultOk = false;
                } else {
                    $default = $d;
                }
            } catch (Throwable $e) {
                $defaultOk = false;
            }
        }

        return [
            'name' => $p->getName(),
            'type' => $tname,
            'builtin' => $builtin,
            'allowsNull' => $allowsNull,
            'hasDefault' => $hasDefault,
            'default' => $default,
            'defaultOk' => $defaultOk,
            'variadic' => $p->isVariadic(),
            'byRef' => $p->isPassedByReference(),
        ];
    };

    $methodMeta = function (ReflectionMethod $m) use ($paramMeta, $methodAllowsGuests): array {
        $rt = $m->getReturnType();
        $returnType = null;
        $returnBuiltin = false;
        $returnAllowsNull = false;
        if ($rt instanceof ReflectionNamedType) {
            $returnType = $rt->getName();
            $returnBuiltin = $rt->isBuiltin();
            $returnAllowsNull = $rt->allowsNull();
        } elseif ($rt !== null) {
            $returnType = 'complex';
        }

        return [
            'name' => $m->getName(),
            'static' => $m->isStatic(),
            'abstract' => $m->isAbstract(),
            'declaringClass' => $m->getDeclaringClass()->getName(),
            'file' => $m->getFileName() ?: null,
            'guest' => $methodAllowsGuests($m),
            'returnType' => $returnType,
            'returnBuiltin' => $returnBuiltin,
            'returnAllowsNull' => $returnAllowsNull,
            'params' => array_map($paramMeta, $m->getParameters()),
        ];
    };

    $gate = $app->make(Illuminate\Contracts\Auth\Access\Gate::class);

    $beforeCallbacks = $readProp($gate, 'beforeCallbacks');
    $afterCallbacks = $readProp($gate, 'afterCallbacks');
    $abilities = $readProp($gate, 'abilities');

    // The STRING callbacks Gate::define('x', 'Class@method') registers: those can
    // be compiled (a class the build knows), unlike a closure.
    $stringCallbacks = $readProp($gate, 'stringCallbacks');
    $stringCallbacks = is_array($stringCallbacks) ? $stringCallbacks : [];

    // For a string callback, the guest rule is the METHOD's first parameter
    // (Gate::methodAllowsGuests(), :489-... -> parameterAllowsGuests(), :529-533).
    $guestAllowedFor = function (string $target): bool {
        $parts = explode('@', $target, 2);
        $class = $parts[0];
        $method = $parts[1] ?? '__invoke';
        if (! class_exists($class)) return false;
        try {
            $m = new ReflectionMethod($class, $method);
        } catch (Throwable $e) {
            return false;
        }
        $params = $m->getParameters();
        if (! $params) return true;
        $p = $params[0];
        return ($p->hasType() && $p->allowsNull()) || ($p->isDefaultValueAvailable() && $p->getDefaultValue() === null);
    };

    $globalAbilities = [];
    if (is_array($abilities)) {
        foreach ($abilities as $name => $callback) {
            $target = $stringCallbacks[$name] ?? null;
            $globalAbilities[(string) $name] = [
                // A string callback ('Class@method') can be compiled; a closure
                // cannot (app code the build cannot take) - the build refuses it.
                'callback' => $target !== null ? (string) $target : null,
                'kind' => $target !== null ? 'string' : 'closure',
                'guestAllowed' => $target !== null ? $guestAllowedFor((string) $target) : true,
            ];
        }
    }

    $globals = [
        // Gate::before() / Gate::after() callbacks — they run for EVERY ability.
        // Both are closures: the edge cannot run them, so a count > 0 blocks the
        // route that checks the Gate.
        'before' => is_array($beforeCallbacks) ? count($beforeCallbacks) : 0,
        'after' => is_array($afterCallbacks) ? count($afterCallbacks) : 0,
        // Gate::define() abilities: the name + whether it is compilable.
        'abilities' => is_array($abilities) ? array_values(array_map('strval', array_keys($abilities))) : [],
        'definitions' => $globalAbilities,
    ];

    $models = [];

    foreach ($fqcns as $fqcn) {
        $entry = [
            'model' => $fqcn,
            'policy' => null,
            'file' => null,
            'error' => null,
            'hasMagicCall' => false,
            'before' => null,
            'methods' => [],
        ];

        try {
            if (! class_exists($fqcn)) {
                $entry['error'] = 'class not found';
                $models[] = $entry;
                continue;
            }
            $policy = $gate->getPolicyFor($fqcn);
            if ($policy === null) {
                // No policy for this model: Laravel denies every ability (unless a
                // global Gate::define() answers it - the build fails loud on that).
                $entry['error'] = 'no policy';
                $models[] = $entry;
                continue;
            }
            $rc = new ReflectionClass($policy);
            $entry['policy'] = $rc->getName();
            $entry['file'] = $rc->getFileName() ?: null;
            // A policy with __call() answers abilities that are not declared:
            // is_callable() is true for everything, so the build cannot know what
            // the policy would answer - it fails loud instead.
            $entry['hasMagicCall'] = $rc->hasMethod('__call');

            foreach ($rc->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
                $name = $m->getName();
                if (strpos($name, '__') === 0) {
                    continue; // the magic methods are not abilities
                }
                if ($name === 'before') {
                    $entry['before'] = $methodMeta($m);
                    continue;
                }
                $entry['methods'][$name] = $methodMeta($m);
            }
        } catch (Throwable $e) {
            $entry['error'] = get_class($e) . ': ' . $e->getMessage();
        }

        $models[] = $entry;
    }

    return ['globals' => $globals, 'models' => $models];
}

if (!defined('LW_METADATA_LIB')) {
    $root = lw_app_root();
    $app = lw_boot_app();

    $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $request = Illuminate\Http\Request::create('/', 'GET');
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);

    echo json_encode(lw_dump_policies(array_slice($argv, 1)));
}
