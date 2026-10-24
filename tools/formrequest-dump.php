<?php

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

$app = lw_boot_app();

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$app->instance('request', $request);

$out = [];

// The hooks Laravel runs on a FormRequest that the compiled rung does NOT
// run. The others (prepareForValidation, authorize, validationData,
// withValidator, after, passedValidation) ARE compiled: the build compiles
// the FormRequest class and the compiled lifecycle runs them in Laravel's
// order (ValidatesWhenResolvedTrait::validateResolved ->
// FormRequest::getValidatorInstance).
//
// Laravel 13 (the framework's own source):
//   Illuminate/Foundation/Http/FormRequest.php:104 - the validator() hook
//   Illuminate/Foundation/Http/FormRequest.php:110 - the withValidator() hook
//   Illuminate/Foundation/Http/FormRequest.php:114 - the after() hook
//   Illuminate/Foundation/Http/FormRequest.php:197 - the validationData() hook
//   Illuminate/Validation/ValidatesWhenResolvedTrait.php:35 - the
//     passedValidation() hook (the trait declares it at line 63)
//
// The fail-loud code travels inside the reason: the build prints the dump's
// error verbatim (the route's skip line), so the operator reads the code
// there - LW003, the code the compiler uses when the compiled rung would
// answer something else than Laravel.
$hooks = [
    'validator' =>
        'LW003 validator() is overridden - Laravel asks the app for the validator instead of building the ' .
        'default one (Illuminate/Foundation/Http/FormRequest.php:104), so the app\'s own validator (its ' .
        'factory, its extensions) is what validates; the edge has ONE validator factory (the kernel\'s), ' .
        'so the app\'s factory would never run (the edge would answer with the default validator) - ' .
        'the working path: the dumped rules(), messages() and attributes() are the compiled surface - a ' .
        'custom validator needs a port handler',
];

// Is the hook the app's own? The framework declares validationData() and the
// trait's passedValidation() in Illuminate/Foundation/Http/FormRequest itself
// (a trait method belongs to the class that uses it), so a method declared
// anywhere else is the app's hook - an app base class counts too: Laravel
// would run that hook.
function lw_formrequest_hook(ReflectionClass $rc, string $method): bool
{
    if (!$rc->hasMethod($method)) {
        return false;
    }

    return $rc->getMethod($method)->getDeclaringClass()->getName()
        !== Illuminate\Foundation\Http\FormRequest::class;
}

foreach (array_slice($argv, 1) as $fqcn) {
    $entry = [
        'fqcn' => $fqcn,
        'rules' => [],
        'messages' => [],
        'attributes' => [],
        'authorize' => true,
        'hooks' => [],
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

        // The hooks the app declares. The build compiles the FormRequest
        // class, so the compiled handler runs the hooks in Laravel's order
        // (ValidatesWhenResolvedTrait::validateResolved ->
        // FormRequest::getValidatorInstance) and the input the hook prepares
        // is what the rules see.
        //
        //   prepareForValidation() - the input it prepares is validated
        //   authorize()            - the 403 it raises
        //   validationData()       - the data the rules see
        //   withValidator()        - the validator it registers on
        //   after()                - the callback it returns
        //   passedValidation()     - the work after the rules passed
        //
        // The dump reports them; the compiled lifecycle runs them.
        $entry['hooks'] = [];
        foreach (['prepareForValidation', 'authorize', 'validationData', 'withValidator', 'after', 'passedValidation'] as $method) {
            if (lw_formrequest_hook($rc, $method)) {
                $entry['hooks'][] = $method;
            }
        }

        // The app's OWN validator (the `validator()` hook): Laravel asks the
        // app for the validator instead of building the default one
        // (Illuminate/Foundation/Http/FormRequest.php:104), so the app's
        // factory (its extensions, its custom rules) is what validates. The
        // edge has ONE validator factory (the kernel's), so this one stays
        // refused - the other hooks are the edge's.
        if (lw_formrequest_hook($rc, 'validator')) {
            $entry['error'] = $hooks['validator'];
            $out[] = $entry;
            continue;
        }

        // The FormRequest constructor runs validateResolved() — instantiating it
        // with an empty request would throw a ValidationException before we
        // could read the rules. Build the instance without the constructor and
        // call the rule methods directly (they do not depend on request state).
        $fr = $rc->newInstanceWithoutConstructor();

        // `authorize()` is NOT called here: it decides PER REQUEST (it reads
        // the user - "$this->user()->isAdmin()"), and the dump has no request.
        // Laravel raises the 403 at request time
        // (ValidatesWhenResolvedTrait::validateResolved -> failedAuthorization),
        // so the compiled lifecycle calls the hook and answers the 403 - the
        // build must not decide it.
        $entry['authorize'] = null;

        $entry['rules'] = $fr->rules();
        $entry['messages'] = $fr->messages();
        $entry['attributes'] = $fr->attributes();

        // A rule OBJECT (`Rule::in(['a','b'])`, `Rule::file()->max(2048)`) is
        // normalized at build time: Laravel hands the validator the object and
        // the validator reads its string form - so the edge gets the same
        // string (the kernel parses the parameters exactly like Laravel).
        //
        // The CONDITIONAL rules (the `*If` family, `Rule::when()`) are refused:
        // their string form is the CONDITION evaluated at build time
        // (`RequiredIf::__toString()` returns 'required' or ''), so the edge
        // would bake the build-time branch into the rule.
        $refused = null;
        $conditional = [
            'Illuminate\\Validation\\Rules\\RequiredIf',
            'Illuminate\\Validation\\Rules\\RequiredUnless',
            'Illuminate\\Validation\\Rules\\RequiredIfAccepted',
            'Illuminate\\Validation\\Rules\\RequiredIfDeclined',
            'Illuminate\\Validation\\Rules\\ProhibitedIf',
            'Illuminate\\Validation\\Rules\\ProhibitedUnless',
            'Illuminate\\Validation\\Rules\\ProhibitedIfAccepted',
            'Illuminate\\Validation\\Rules\\ProhibitedIfDeclined',
            'Illuminate\\Validation\\Rules\\ExcludeIf',
            'Illuminate\\Validation\\Rules\\ExcludeUnless',
            'Illuminate\\Validation\\Rules\\MissingIf',
            'Illuminate\\Validation\\Rules\\MissingUnless',
            'Illuminate\\Validation\\Rules\\PresentIf',
            'Illuminate\\Validation\\Rules\\PresentUnless',
            'Illuminate\\Validation\\Rules\\AcceptedIf',
            'Illuminate\\Validation\\Rules\\DeclinedIf',
            'Illuminate\\Validation\\ConditionalRules',
        ];
        $normalize = function ($rules) use (&$normalize, &$refused, $conditional) {
            $out = [];
            foreach ((array) $rules as $key => $rule) {
                if (is_string($rule) || is_int($rule) || is_float($rule)) {
                    $out[$key] = (string) $rule;
                    continue;
                }
                if (is_object($rule)) {
                    $cls = get_class($rule);
                    if (in_array($cls, $conditional, true)) {
                        $refused = $cls . ' - the rule is conditional: its string form is the condition evaluated at build time, so the edge would bake the build-time branch into the rule';
                        return null;
                    }
                    if (!method_exists($rule, '__toString')) {
                        $refused = $cls . ' - the rule object has no string form (Laravel evaluates the object itself)';
                        return null;
                    }
                    $out[$key] = (string) $rule;
                    continue;
                }
                if (is_array($rule)) {
                    $sub = $normalize($rule);
                    if ($sub === null) {
                        return null;
                    }
                    $out[$key] = $sub;
                    continue;
                }
                $out[$key] = $rule;
            }
            return $out;
        };
        $normalized = $normalize($entry['rules']);
        if ($refused !== null) {
            $entry['error'] = 'LW003 the rules use a rule object the compiled rung cannot evaluate: ' . $refused;
        } else {
            // The rules that read the file's CONTENT type (finfo): the edge
            // cannot sniff the content like PHP does - the build stops.
            $mimeRule = null;
            $walkNames = function ($rules) use (&$walkNames, &$mimeRule) {
                foreach ((array) $rules as $rule) {
                    if (is_array($rule)) {
                        $walkNames($rule);
                    } elseif (is_string($rule) && in_array(explode(':', $rule)[0], ['mimes', 'mimetypes'], true)) {
                        $mimeRule = explode(':', $rule)[0];
                        return;
                    }
                }
            };
            $walkNames($normalized);
            if ($mimeRule !== null) {
                $entry['error'] = 'LW003 the rules use the ' . $mimeRule
                    . ' rule: it reads the file\'s *content* type (finfo) and the edge cannot sniff the content like PHP does';
            } else {
                $entry['rules'] = $normalized;
            }
        }
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    $out[] = $entry;
}

echo json_encode($out);
