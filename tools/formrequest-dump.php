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

// The hooks Laravel runs on a FormRequest and the compiled rung does not.
// Each one changes what the edge would answer, so the dump refuses the class
// the same way it refuses an overridden prepareForValidation(): the reason
// says what Laravel does with the hook, what the edge does instead, and the
// path that works.
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
    'withValidator' =>
        'LW003 withValidator() is overridden - Laravel calls the hook with the validator ' .
        '(Illuminate/Foundation/Http/FormRequest.php:110), which is where the app registers its ' .
        'custom messages and its after() callbacks; the compiled rung validates the dumped rules ' .
        'against the raw input and never runs it (the messages and the extra checks would be missing) - ' .
        'the working path: put the messages in messages() (the dump reads them) and the checks in the ' .
        'controller method (the compiled handler validates first, then runs the body), or write a port handler',
    'after' =>
        'LW003 after() is overridden - Laravel registers the hook on the validator ' .
        '(Illuminate/Foundation/Http/FormRequest.php:114), so the callback runs after the rules pass and ' .
        'can add errors; the compiled rung validates the dumped rules against the raw input and never runs ' .
        'it (a request Laravel rejects would be accepted) - the working path: do the check in the ' .
        'controller method (the compiled handler validates first, then runs the body), or write a port handler',
    'validator' =>
        'LW003 validator() is overridden - Laravel asks the app for the validator instead of building the ' .
        'default one (Illuminate/Foundation/Http/FormRequest.php:104), so the app\'s own validator (its ' .
        'rules, its messages, its factory) would never run; the compiled rung validates the dumped rules ' .
        'against the raw input and never runs it (the edge would answer with the default validator) - ' .
        'the working path: the dumped rules(), messages() and attributes() are the compiled surface - a ' .
        'custom validator needs a port handler',
    'validationData' =>
        'LW003 validationData() is overridden - Laravel validates what the hook returns instead of the ' .
        'whole request (Illuminate/Foundation/Http/FormRequest.php:197 - the default is all()), so the hook ' .
        'chooses the data that is validated; the compiled rung validates the dumped rules against the raw ' .
        'input and never runs it (a different data set would be validated) - the working path: name the ' .
        'fields in rules() (the dump reads them), or write a port handler',
    'passedValidation' =>
        'LW003 passedValidation() is overridden - Laravel runs the hook after the validation passed ' .
        '(Illuminate/Validation/ValidatesWhenResolvedTrait.php:35), so the work that follows a successful ' .
        'validation would never happen; the compiled rung validates the dumped rules against the raw input ' .
        'and never runs it (the side effect is missing) - the working path: do the work in the controller ' .
        'method (the compiled handler validates first, then runs the body), or write a port handler',
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
                $entry['error'] = 'LW003 prepareForValidation() is overridden - Laravel runs the hook before the validation (Illuminate/Validation/ValidatesWhenResolvedTrait.php:19), so the app can change the input that is validated; the compiled rung validates the dumped rules against the raw input and never runs it (the validated input would differ) - the working path: normalize the input in the controller method (the compiled handler validates first, then runs the body), or write a port handler';
                $out[] = $entry;
                continue;
            }
        }

        // The other hooks Laravel runs on the FormRequest: each one changes
        // what the edge would answer, so it is refused the same way.
        foreach ($hooks as $method => $reason) {
            if (!lw_formrequest_hook($rc, $method)) {
                continue;
            }
            $entry['error'] = $reason;
            $out[] = $entry;
            continue 2;
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
                    } elseif (is_string($rule) && in_array(explode(':', $rule)[0], ['mimes', 'mimetypes', 'image', 'dimensions'], true)) {
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
