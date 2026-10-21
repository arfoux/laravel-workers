<?php
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
//    "classes":{"App\\Events\\PostPublished":{"file":"...","kind":"event","ctor":[{"name":"postId","kind":"builtin","type":"int"}]}, ...}}
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

require $appRoot . '/vendor/autoload.php';
$app = require $appRoot . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$events = [];
$classes = [];

// The classes the edge can build: the app's own classes (not the vendor's).
// A class outside the app root (a framework class) has no file the build can
// compile — the edge adapter of that service is used instead.
$appRootReal = realpath($appRoot);
$isAppClass = function (string $fqcn) use ($appRootReal): bool {
    if ($fqcn === '' || !class_exists($fqcn)) return false;
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
        $rc2 = new ReflectionClass($name);
        if ($rc2->isInterface() || $rc2->isAbstract()) {
            // An interface: the container binds it to a concrete class.
            $bindings = method_exists($app, 'getBindings') ? $app->getBindings() : [];
            $binding = $bindings[$name] ?? null;
            $concrete = is_array($binding) && is_string($binding[0] ?? null) ? ltrim($binding[0], '\\') : null;
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
    $classes[$fqcn] = ['file' => $file, 'kind' => $kind, 'ctor' => $ctorDump($fqcn)];
    // The dependencies: the edge builds them too.
    foreach ($classes[$fqcn]['ctor'] as $p) {
        if (($p['kind'] ?? '') !== 'class') continue;
        $addClass($p['impl'] ?? $p['type'], 'service');
    }
};

// The mailables (app/Mail): the classes the build compiles, so the
// `Mail::to($u)->send(new OrderMail())` call can be compiled (the mailable
// renders its own view). The dump also carries the VIEW the mailable renders
// (the build compiles that view too - a mailable's view is not reached from
// a route).
$mailViews = [];
foreach (glob($appRoot . '/app/Mail/*.php') ?: [] as $mailFile) {
    $fqcn = 'App\\Mail\\' . basename($mailFile, '.php');
    if (!class_exists($fqcn)) continue;
    $addClass($fqcn, 'mailable');
    $source = (string) file_get_contents($mailFile);
    if (preg_match_all("/->view\(\s*'([^']+)'/", $source, $m)) {
        foreach ($m[1] as $viewName) $mailViews[] = $viewName;
    }
    if (preg_match_all("/->textView\(\s*'([^']+)'/", $source, $m2)) {
        foreach ($m2[1] as $viewName) $mailViews[] = $viewName;
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
];

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
