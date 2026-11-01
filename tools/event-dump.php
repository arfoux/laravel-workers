<?php
require_once __DIR__ . '/_root.php';
// tools/event-dump.php — the app's event listeners (build time).
//
// The listeners are classes: at the edge there is no listener runtime, so a
// dispatch that answers nothing would be a *silent* no-op. The build compiles
// the listeners (and the event classes) instead — this dump tells it which
// class listens to which event.
//
//   php tools/event-dump.php <app_root>
//
// The output (stdout):
//   {"events":{"App\\Events\\PostPublished":{"file":"...","listeners":["App\\Listeners\\MarkPostNotified"]}},
//    "classes":{"App\\Events\\PostPublished":{"file":"...","kind":"event","ctor":[{"name":"postId","kind":"builtin","type":"int"}]}, ...},
//    "mailViews":["mail.order"],
//    "mailViewsByClass":{"App\\Mail\\OrderMail":["mail.order"]},
//    "mailableClasses":["App\\Mail\\OrderMail"]}
//
// The `mailableClasses` are EVERY app mailable (app/Mail) - the ones with a
// view and the ones without (a mailable with only a subject is legal), so the
// build can tell a mailable it knows from one it never saw. The `mailViews`
// (the flat list - the compile queue) and the `mailViewsByClass` (the views
// PER mailable) are the views those mailables render: the build compiles them
// (a mailable's view is not reached from a route).
//
// The `ctor` of a class is its constructor's parameters: the kind of each one
// tells the build how to provide it at the edge (a plain value, an injected
// service, a framework service the edge has an adapter for, or a dependency
// the edge cannot resolve — it fails loud).
//
// The map comes from Laravel's own resolution (EventServiceProvider::getEvents():
// the explicit `$listen` + the auto-discovery), so the compiled listeners are
// exactly the ones the real app would call.
$appRoot = $argv[1] ?? '';
if ($appRoot === '' || !is_dir($appRoot)) {
    fwrite(STDERR, "usage: php tools/event-dump.php <app_root>\n");
    exit(2);
}

require lw_vendor_autoload_for($appRoot);
$app = lw_boot_app($appRoot);
require_once __DIR__ . '/mailable-views.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$events = [];
$classes = [];

// The classes the edge can build: the app's own classes (not the vendor's).
// A class outside the app root (a framework class) has no file the build can
// compile — the edge adapter of that service is used instead. An INTERFACE (or
// a trait) is an app class too: `class_exists()` alone answers false for it and
// would mislabel the parameter as a framework class, while the container may
// bind it to a concrete class the edge DOES build.
$appRootReal = realpath($appRoot);
$isAppClass = function (string $fqcn) use ($appRootReal): bool {
    if ($fqcn === '') return false;
    if (!class_exists($fqcn) && !interface_exists($fqcn) && !trait_exists($fqcn)) return false;
    try {
        $rc = new ReflectionClass($fqcn);
    } catch (Throwable $e) {
        return false;
    }
    $file = $rc->getFileName();
    if (!$file) return false;
    $real = realpath($file);
    if (!$real) return false;
    if (!str_starts_with($real, $appRootReal . DIRECTORY_SEPARATOR)) return false;
    if (str_contains($real, DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR)) return false;
    return true;
};


// The constructor of a class: the parameters the edge has to provide. A
// parameter with a class type is a dependency (the build resolves it); a
// builtin one is a plain value; an untyped one Laravel resolves by name
// (through the container) — the edge cannot.
$ctorDump = function (string $fqcn) use ($app, $isAppClass): array {
    try {
        $rc = new ReflectionClass($fqcn);
    } catch (Throwable $e) {
        return [];
    }
    $ctor = $rc->getConstructor();
    $out = [];

    if (!$ctor) return $out;
    foreach ($ctor->getParameters() as $p) {
        $entry = ['name' => $p->getName()];
        $type = $p->getType();
        if (!$type instanceof ReflectionNamedType) {
            // No type (or a union): Laravel resolves it by the parameter's
            // name (the container). The dump resolves it the same way, so the
            // build knows what the edge would have to provide.
            $entry['kind'] = 'untyped';
            try {
                $resolved = $app->make($p->getName());
                $entry['kind'] = 'external';
                $entry['type'] = get_class($resolved);
            } catch (Throwable $e) {
                if ($p->isDefaultValueAvailable()) {
                    $d = $p->getDefaultValue();
                    if (is_scalar($d) || $d === null) {
                        $entry['kind'] = 'builtin';
                        $entry['type'] = 'mixed';
                        $entry['default'] = $d;
                    }
                }
            }
            $out[] = $entry;
            continue;
        }
        if ($type->isBuiltin()) {
            $entry['kind'] = 'builtin';
            $entry['type'] = $type->getName();
            if ($p->isDefaultValueAvailable()) {
                $d = $p->getDefaultValue();
                if (is_scalar($d) || $d === null) $entry['default'] = $d;
            }
            $out[] = $entry;
            continue;
        }
        $name = ltrim($type->getName(), '\\');
        $entry['type'] = $name;
        if (!$isAppClass($name)) {
            // A framework class: the edge has an adapter for it (or not).
            $entry['kind'] = 'external';
            $out[] = $entry;
            continue;
        }
        // A parameter with a DEFAULT is what the container falls back to when
        // it cannot resolve the class (Container::resolveClass() catches the
        // BindingResolutionException and answers `getDefaultValue()`), so the
        // default travels with the dump - the edge answers the same.
        if ($p->isDefaultValueAvailable()) {
            $d = $p->getDefaultValue();
            if (is_scalar($d) || $d === null) $entry['default'] = $d;
        }
        $rc2 = new ReflectionClass($name);
        if ($rc2->isInterface() || $rc2->isAbstract()) {
            // An interface (or an abstract class): the container binds it to a
            // concrete class. `Container::bind()` stores the binding as
            // `['concrete' => Closure, 'shared' => bool]`, and the Closure is
            // `getClosure()`'s wrapper whose STATIC VARIABLE holds the concrete
            // written by the call — so the class string is recoverable without
            // instantiating anything (`$binding[0]` never existed: the array is
            // associative, which is why this branch used to answer nothing).
            $bindings = method_exists($app, 'getBindings') ? $app->getBindings() : [];
            $binding = $bindings[$name] ?? null;
            $concrete = null;
            if (is_array($binding) && array_key_exists('concrete', $binding)) {
                $raw = $binding['concrete'];
                if (is_string($raw)) {
                    $concrete = ltrim($raw, '\\');
                } elseif ($raw instanceof Closure) {
                    try {
                        $vars = (new ReflectionFunction($raw))->getStaticVariables();
                        if (isset($vars['concrete']) && is_string($vars['concrete'])) {
                            $concrete = ltrim($vars['concrete'], '\\');
                        }
                    } catch (Throwable $e) {
                        $concrete = null;
                    }
                }
            }
            if ($concrete && class_exists($concrete) && $isAppClass($concrete)) {
                $entry['kind'] = 'class';
                $entry['impl'] = $concrete;
            } else {
                $entry['kind'] = 'abstract';
            }
            $out[] = $entry;
            continue;
        }
        $entry['kind'] = 'class';
        $out[] = $entry;
    }
    return $out;
};

// The classes the build compiles: the events, the listeners and the services
// they depend on (the dependency graph).
$addClass = function (string $fqcn, string $kind = 'service') use (&$classes, &$addClass, $ctorDump, $isAppClass): void {
    if ($fqcn === '' || isset($classes[$fqcn])) return;
    if (!$isAppClass($fqcn)) return;
    try {
        $rc = new ReflectionClass($fqcn);
    } catch (Throwable $e) {
        return;
    }
    $file = $rc->getFileName();
    if (!$file) return;
    // `parent` is the resolved parent FQCN (PHP's own resolution for the
    // shortest path): the class compiler distinguishes a plain resource
    // (JsonResource) from a collection resource (ResourceCollection) with it.
    $parent = $rc->getParentClass();
    $classes[$fqcn] = [
        'file' => $file,
        'kind' => $kind,
        'parent' => $parent ? $parent->getName() : null,
        'ctor' => $ctorDump($fqcn),
    ];
    // The dependencies: the edge builds them too.
    foreach ($classes[$fqcn]['ctor'] as $p) {
        if (($p['kind'] ?? '') !== 'class') continue;
        $addClass($p['impl'] ?? $p['type'], 'service');
    }
};

// The app classes the build compiles: mailables, Jobs, API Resources and
// FormRequests. Each is discovered through composer's own `App\` mapping
// (lw_app_psr4_dirs) rather than a hard-coded `app/` - a project that maps
// `App\` to `src/` keeps its classes in `src/Jobs`, `src/Mail`, ... and a
// flat `app/` glob would find none of them (the class would stay uncompiled
// and `Mail::to()->send(new OrderMail())` would refuse the build).
// The JOBS: `Job::dispatch()` writes a row and the cron consumer runs the
// class's handle() - the class must be compiled for that to exist. A job is a
// plain class with a handle(), so the same class compiler covers it.
$appSrcDirs = lw_app_psr4_dirs($appRoot);
$appClasses = function (string $sub, string $ns) use ($appSrcDirs): array {
    $out = [];
    foreach ($appSrcDirs as $srcDir) {
        $dir = rtrim($srcDir, '/\\') . '/' . $sub;
        if (!is_dir($dir)) continue;
        foreach (glob($dir . '/*.php') ?: [] as $file) {
            $name = basename($file, '.php');
            // Two dirs declaring the same basename: the first `App\` mapping
            // wins, the same order composer's psr-4 lookup uses.
            if (!isset($out[$name])) {
                $out[$name] = ['fqcn' => $ns . '\\' . $name, 'file' => $file];
            }
        }
    }
    return array_values($out);
};

foreach ($appClasses('Jobs', 'App\\Jobs') as $c) {
    if (!class_exists($c['fqcn'])) continue;
    $addClass($c['fqcn'], 'job');
}

// The API RESOURCES: `return new PostResource($post)` from a controller.
// Laravel's Router wraps the value in a ResourceResponse (the `data` key, the
// resource's `with`/`additional`), and the app's class declares only
// `toArray()` - the rest is inherited from
// Illuminate\Http\Resources\Json\JsonResource, which the kernel provides.
foreach ($appClasses('Http/Resources', 'App\\Http\\Resources') as $c) {
    if (!class_exists($c['fqcn'])) continue;
    $addClass($c['fqcn'], 'resource');
}

// The FormRequests: the build compiles them too, so the hooks Laravel runs on
// them (prepareForValidation) are compiled and run.
foreach ($appClasses('Http/Requests', 'App\\Http\\Requests') as $c) {
    if (!class_exists($c['fqcn'])) continue;
    $addClass($c['fqcn'], 'formRequest');
}

$mailViews = [];
$mailViewsByClass = [];
$mailableClasses = [];
foreach ($appClasses('Mail', 'App\\Mail') as $c) {
    $fqcn = $c['fqcn'];
    if (!class_exists($fqcn)) continue;
    $addClass($fqcn, 'mailable');
    // EVERY app mailable: the build must be able to tell a mailable it knows
    // from one it never saw. A mailable with no view at all (only a subject)
    // is legal - it is not an unknown one.
    $mailableClasses[] = $fqcn;
    // The view a mailable renders: the FLUENT call (`->view('x')`,
    // `->textView('x')`, Laravel 13's modern API `->markdown('x')`) AND the
    // PUBLIC property (`public $view = 'x';`, `$this->view = 'x';`).
    // Laravel's Mailable carries the view in both shapes (the field
    // Illuminate/Mail/Mailable.php:110,117 and the fluent setters :915,930)
    // and the compiled kernel honours both (kernel/mailable.mjs: the payload
    // reads the fluent value first and falls back to the PUBLIC field), so a
    // mailable written in the property form COMPILES - but if the build does
    // not learn its view, the view is never compiled and the mail dies at
    // request time (a 500 where Laravel sends the mail). The name can be in
    // single OR double quotes, and a DYNAMIC name (`->view($name)`) is no
    // name at all (the build cannot know which view to compile).
    $views = lw_mailable_views((string) file_get_contents($c['file']));
    if ($views) {
        // Per mailable: only the route that SENDS a mailable needs its view.
        $mailViewsByClass[$fqcn] = $views;
        foreach ($views as $v) {
            $mailViews[] = $v;
        }
    }
}
$mailViews = array_values(array_unique($mailViews));

// The provider instances: the app keeps them in `serviceProviders` (the
// public API gives the names only).
$providers = [];
$ref = new ReflectionObject($app);
if ($ref->hasProperty('serviceProviders')) {
    $prop = $ref->getProperty('serviceProviders');
    $prop->setAccessible(true);
    $loaded = $prop->getValue($app);
    if (is_array($loaded)) $providers = array_values($loaded);
}
foreach ($providers as $provider) {
    if (!is_object($provider)) continue;
    if (!($provider instanceof Illuminate\Foundation\Support\Providers\EventServiceProvider)) continue;
    // Laravel's own resolution: the explicit `$listen` + the auto-discovery.
    $map = method_exists($provider, 'getEvents') ? $provider->getEvents() : [];
    if (!is_array($map)) continue;
    foreach ($map as $event => $listeners) {
        $eventClass = ltrim((string) $event, '\\');
        if ($eventClass === '' || !class_exists($eventClass)) continue;
        $addClass($eventClass, 'event');
        foreach ((array) $listeners as $listener) {
            if (!is_string($listener)) continue;
            // The discovery gives `Class@method`; the explicit `$listen` gives
            // the class name.
            $listenerClass = ltrim(explode('@', $listener)[0], '\\');
            if (!class_exists($listenerClass)) continue;
            $addClass($listenerClass, 'listener');
            $events[$eventClass]['listeners'][] = $listenerClass;
            // A queued listener (ShouldQueue): Laravel pushes it to the queue
            // (it runs later); the edge has no consumer, so it must not run it
            // inline - the compiled rung fails loud on it.
            $implements = class_implements($listenerClass);
            if (is_array($implements) && in_array('Illuminate\\Contracts\\Queue\\ShouldQueue', $implements, true)) {
                $events[$eventClass]['queued'][] = $listenerClass;
            }
            // The broadcast listeners (ShouldBroadcast / ShouldBroadcastNow):
            // Laravel broadcasts the event to the channels after the response
            // (the broadcast is queued); the edge has no broadcast driver, so
            // the notification would never be sent - the compiled rung must
            // refuse it, not run it silently.
            foreach (['Illuminate\\Contracts\\Broadcasting\\ShouldBroadcast', 'Illuminate\\Contracts\\Broadcasting\\ShouldBroadcastNow'] as $broadcastIface) {
                if (is_array($implements) && in_array($broadcastIface, $implements, true)) {
                    $events[$eventClass]['broadcast'][] = $listenerClass;
                    break;
                }
            }
            // The after-commit listeners (ShouldDispatchAfterCommit /
            // ShouldHandleEventsAfterCommit): Laravel defers them until the
            // database transaction is committed; the edge has no transaction,
            // so the timing would differ - the compiled rung refuses it.
            foreach (['Illuminate\\Contracts\\Events\\ShouldDispatchAfterCommit', 'Illuminate\\Contracts\\Events\\ShouldHandleEventsAfterCommit'] as $afterCommitIface) {
                if (is_array($implements) && in_array($afterCommitIface, $implements, true)) {
                    $events[$eventClass]['afterCommit'][] = $listenerClass;
                    break;
                }
            }
        }
    }
}

// The file of every event class (the listeners are in the map above).
foreach (array_keys($events) as $eventClass) {
    if (!isset($classes[$eventClass])) continue;
    $events[$eventClass]['file'] = $classes[$eventClass]['file'];
}

$out = [
    'events' => $events,
    'classes' => $classes,
    'mailViews' => $mailViews,
    // The views PER mailable (only the route that sends a mailable needs
    // them - the flat list above is the compile queue).
    'mailViewsByClass' => $mailViewsByClass,
    // EVERY app mailable (the ones with a view and the ones without): the
    // build tells a mailable it knows from one it never saw.
    'mailableClasses' => $mailableClasses,
];

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
