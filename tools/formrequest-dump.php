<?php

require_once __DIR__ . '/_root.php';

function lw_dump_formrequests(array $fqcns): array
{
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

// The body of a reflected method, comments stripped (null when the source is
// not readable). Used to recognise a hook that is Laravel's own default written
// out by hand.
$methodBody = static function (ReflectionMethod $m): ?string {
    $file = $m->getFileName();
    if (!$file || !is_readable($file)) {
        return null;
    }
    $src = implode('', array_slice(file($file), $m->getStartLine() - 1, $m->getEndLine() - $m->getStartLine() + 1));
    $open = strpos($src, '{');
    $close = strrpos($src, '}');
    if ($open === false || $close === false || $close < $open) {
        return null;
    }
    $body = substr($src, $open + 1, $close - $open - 1);
    $body = preg_replace('~/\*.*?\*/~s', '', $body);
    $body = preg_replace('~//[^
]*~', '', $body);
    return preg_replace('/\s+/', '', (string) $body);
};

// Is the hook the app's own? The framework declares validationData() and the
// trait's passedValidation() in Illuminate/Foundation/Http/FormRequest itself
// (a trait method belongs to the class that uses it), so a method declared
// anywhere else is the app's hook - an app base class counts too: Laravel
// would run that hook.
//
// One exception: `authorize() { return true; }` is exactly what the parent
// answers (FormRequest::authorize() returns true), so a declaration that only
// returns the literal changes nothing. Refusing it would force every app that
// wrote the boilerplate out by hand to delete it (and the scaffolder's
// `return false;` variant is a real deny - it stays a hook).
$isHook = static function (ReflectionClass $rc, string $method) use ($methodBody): bool {
    if (!$rc->hasMethod($method)) {
        return false;
    }
    $m = $rc->getMethod($method);
    if ($m->getDeclaringClass()->getName() === Illuminate\Foundation\Http\FormRequest::class) {
        return false;
    }
    if ($method === 'authorize' && $methodBody($m) === 'returntrue;') {
        return false;
    }
    return true;
};

    foreach ($fqcns as $fqcn) {
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
            if ($isHook($rc, $method)) {
                $entry['hooks'][] = $method;
            }
        }

        // The app's OWN validator (the `validator()` hook): Laravel asks the
        // app for the validator instead of building the default one
        // (Illuminate/Foundation/Http/FormRequest.php:104), so the app's
        // factory (its extensions, its custom rules) is what validates. The
        // edge has ONE validator factory (the kernel's), so this one stays
        // refused - the other hooks are the edge's.
        if ($isHook($rc, 'validator')) {
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

        // `rules()` may read the REQUEST (the common
        // `Rule::unique(...)->ignore($this->user()->id)`): evaluating it here,
        // with no request, bakes the build-time value into the rule string
        // (`ignore(NULL)` then matches the row itself and rejects a valid
        // update, silently). Refuse instead — the edge cannot evaluate it.
        $rm = $rc->getMethod('rules');
        $rulesSrc = implode('', array_slice(
            file($rc->getFileName()),
            $rm->getStartLine() - 1,
            $rm->getEndLine() - $rm->getStartLine() + 1
        ));
        if (preg_match('/\$this->|\$request\b|\bauth\(|\buser\(|\brequest\(/', $rulesSrc)) {
            $entry['error'] =
                'rules() reads request state — the build would evaluate it with NO request (a ' .
                'unique()->ignore($this->user()->id) becomes ignore(NULL) and rejects the row itself). ' .
                'Use static rules, check in the controller, or write a port handler for this route';
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
                    // A `Unique`/`Exists` object that carries query CALLBACKS
                    // (`whereIn`, `whereNotIn`, `where(closure)`, `using(...)`)
                    // keeps them OUT of its string form: `__toString()` writes
                    // only the where PAIRS (`Unique.php:66-75`,
                    // `Exists.php:17-24` -> `DatabaseRule::formatWheres()`,
                    // which maps `$this->wheres` alone), while `whereIn()` and a
                    // closure route into `$this->using[]`
                    // (`DatabaseRule::whereIn():168`, `using():218`) and
                    // `queryCallbacks()` answers exactly that list (:230).
                    // Laravel never stringifies such a rule: the parser keeps
                    // the OBJECT (`ValidationRuleParser::prepareRule():132-137`
                    // special-cases `$rule->queryCallbacks()`) and the validator
                    // merges the callbacks into the query
                    // (`ValidatesAttributes::validateUnique():1122-1124`,
                    // `validateExists():1075-1077`). Probed on 13.37: the object
                    // answers the OPPOSITE of its own string form, so the edge
                    // would validate a different query - an `exists` rule that
                    // Laravel fails would PASS here.
                    if (method_exists($rule, 'queryCallbacks') && $rule->queryCallbacks()) {
                        $refused = $cls . ' - the rule carries query callbacks (whereIn, whereNotIn, where(closure) or using()): its string form DROPS them while Laravel keeps the object and merges them into the query, so the edge would run a different query (an exists rule would PASS where Laravel fails) - the working path: write the constraint as a where pair (->where(\'column\', $value)), which the string form does carry';
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
            // A `unique`/`exists` TABLE that only PHP can resolve
            // (`ValidatesAttributes::parseTable():1189-1202`):
            //
            //  - `connection.table` (:1191 - the table is split on the first
            //    dot): the presence verifier then runs on THAT connection. The
            //    compiled app queries ONE database, so a prefix that is not the
            //    app's own default connection is refused; the default
            //    connection's own prefix is the same query, so it is dropped.
            //  - a model FQCN (`unique:App\Models\User,email`, :1193-1200):
            //    PHP swaps in the model's table AND the model's key as the id
            //    column (`getUniqueIds()` prefers it over the rule's own id
            //    parameter), neither of which the rule string can carry -
            //    refused, because the edge would query a table named after the
            //    class.
            //
            // The parameters are read exactly like Laravel reads them
            // (`ValidationRuleParser::parseParameters():320` -
            // `str_getcsv($parameter, escape: '\\')`), so a quoted where pair
            // (`tenant,"2"`) is one field here too. Only the FIRST field is
            // ever rewritten; the rest of the parameter string is kept byte for
            // byte.
            $defaultConnection = config('database.default');
            $tableError = null;
            $fixTable = function (string $rule) use ($defaultConnection, &$tableError) {
                $colon = strpos($rule, ':');
                if ($colon === false) {
                    return $rule;
                }
                $name = substr($rule, 0, $colon);
                if ($name !== 'unique' && $name !== 'exists') {
                    return $rule;
                }
                $rest = substr($rule, $colon + 1);
                $quoted = false;
                $len = strlen($rest);
                $cut = $len;
                for ($i = 0; $i < $len; $i++) {
                    $ch = $rest[$i];
                    if ($ch === '"') {
                        if ($quoted && $i + 1 < $len && $rest[$i + 1] === '"') {
                            $i++;
                            continue;
                        }
                        $quoted = !$quoted;
                    } elseif ($ch === ',' && !$quoted) {
                        $cut = $i;
                        break;
                    }
                }
                $rawField = substr($rest, 0, $cut);
                $rawTail = substr($rest, $cut);
                $field = str_getcsv($rawField, ',', '"', '\\')[0] ?? $rawField;
                if (!is_string($field) || $field === '') {
                    return $rule;
                }
                if (str_contains($field, '\\')) {
                    $tableError = $name . ' table "' . $field . '" is a class name - PHP resolves it through parseTable() (the model\'s table plus the model\'s key as the id column, ValidatesAttributes.php:1193-1200) and the rule string cannot carry that - the working path: name the table itself (' . $name . ':users,email)';
                    return null;
                }
                if (!str_contains($field, '.')) {
                    return $rule;
                }
                [$connection, $table] = explode('.', $field, 2);
                if (str_contains($table, '.')) {
                    $tableError = $name . ' table "' . $field . '" is schema-qualified - the compiled app queries one database with no attached schema (PHP would run "select count(*) from ' . $table . '") - the working path: name the table alone';
                    return null;
                }
                if ($defaultConnection === null || $connection !== $defaultConnection) {
                    $tableError = $name . ' table "' . $field . '" names the connection "' . $connection . '" - PHP runs that check on THAT connection (parseTable(), ValidatesAttributes.php:1191) and the compiled app queries one database (' . ($defaultConnection === null ? 'none is configured' : 'the "' . $defaultConnection . '" connection') . ') - the working path: name the table alone (' . $name . ':' . $table . ') when the rows live in the app\'s own database';
                    return null;
                }
                return $name . ':' . $table . $rawTail;
            };
            $walkTables = function ($rules) use (&$walkTables, $fixTable) {
                $out = [];
                foreach ((array) $rules as $key => $rule) {
                    if (is_array($rule)) {
                        $sub = $walkTables($rule);
                        if ($sub === null) {
                            return null;
                        }
                        $out[$key] = $sub;
                    } elseif (is_string($rule)) {
                        $fixed = $fixTable($rule);
                        if ($fixed === null) {
                            return null;
                        }
                        $out[$key] = $fixed;
                    } else {
                        $out[$key] = $rule;
                    }
                }
                return $out;
            };
            $normalized = $walkTables($normalized);
            if ($tableError !== null) {
                $entry['error'] = 'LW003 the rules use a unique/exists table the compiled rung cannot resolve: ' . $tableError;
            } else {
                // `mimes`/`mimetypes` read the file's CONTENT type (finfo). The
                // edge sniffs the image HEADER instead (kernel/image.mjs), so the
                // rule compiles for the image formats that read can name and is
                // refused for anything else - the compiler applies the same list
                // (compiler/src/transpiler.mjs), so the two can never disagree.
                $mimeExt = ['png', 'jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'gif', 'webp', 'avif', 'heic', 'heif'];
                $mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif'];
                $mimeError = null;
                $walkNames = function ($rules) use (&$walkNames, &$mimeError, $mimeExt, $mimeTypes) {
                    foreach ((array) $rules as $rule) {
                        if (is_array($rule)) {
                            $walkNames($rule);
                            if ($mimeError !== null) {
                                return;
                            }
                        } elseif (is_string($rule)) {
                            $parts = explode(':', $rule, 2);
                            $name = $parts[0];
                            if (! in_array($name, ['mimes', 'mimetypes'], true)) {
                                continue;
                            }
                            $allowed = $name === 'mimetypes' ? $mimeTypes : $mimeExt;
                            $params = isset($parts[1]) ? array_values(array_filter(array_map('trim', explode(',', $parts[1])), 'strlen')) : [];
                            foreach ($params as $param) {
                                if (! in_array(strtolower($param), $allowed, true)) {
                                    $mimeError = 'LW003 the rules use the ' . $name . ' rule with "' . $param
                                        . '": it reads the file\'s *content* type (finfo) and the edge sniffs image HEADERS only - '
                                        . implode(', ', $allowed) . ' can be answered';

                                    return;
                                }
                            }
                        }
                    }
                };
                $walkNames($normalized);
                if ($mimeError !== null) {
                    $entry['error'] = $mimeError;
                } else {
                    $entry['rules'] = $normalized;
                }
            }
        }
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    // A refused class carries no rules: the raw `rules()` output holds the rule
    // OBJECTS (which json_encode writes as `{}`), and handing those to the
    // compiler would be exactly the fail-open shape the refusal exists for.
    // The build reads the error and skips the route, so the rules are dead
    // weight either way - dropping them keeps the dump honest.
    if ($entry['error'] !== null) {
        $entry['rules'] = [];
    }

    $out[] = $entry;
    }

    return $out;
}

if (!defined('LW_METADATA_LIB')) {
    $bootError = null;
    try {
        $root = lw_app_root();
        $app = lw_boot_app();

        $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
        $request = Illuminate\Http\Request::create('/', 'GET');
        $response = $kernel->handle($request);
        $kernel->terminate($request, $response);

        $app->instance('request', $request);
    } catch (Throwable $e) {
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        $bootError = get_class($e) . ': ' . $e->getMessage();
    }

    $fqcns = array_slice($argv, 1);
    $entries = $fqcns
        ? lw_dump_formrequests($fqcns)
        : [];

    if ($bootError !== null) {
        foreach ($entries as &$entry) {
            if ($entry['error'] === null) {
                $entry['error'] = 'boot: ' . $bootError;
            }
        }
        unset($entry);
    }

    echo json_encode($entries, JSON_INVALID_UTF8_SUBSTITUTE);
}
