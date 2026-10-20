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
//    "classes":{"App\\Events\\PostPublished":{"file":"..."}, ...}}
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

$addClass = function (string $fqcn) use (&$classes): void {
    if ($fqcn === '' || isset($classes[$fqcn])) return;
    if (!class_exists($fqcn)) return;
    try {
        $rc = new ReflectionClass($fqcn);
    } catch (Throwable $e) {
        return;
    }
    $file = $rc->getFileName();
    if (!$file) return;
    $classes[$fqcn] = ['file' => $file];
};

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
        $addClass($eventClass);
        foreach ((array) $listeners as $listener) {
            if (!is_string($listener)) continue;
            // The discovery gives `Class@method`; the explicit `$listen` gives
            // the class name.
            $listenerClass = ltrim(explode('@', $listener)[0], '\\');
            if (!class_exists($listenerClass)) continue;
            $addClass($listenerClass);
            $events[$eventClass]['listeners'][] = $listenerClass;
            // A queued listener (ShouldQueue): Laravel pushes it to the queue
            // (it runs later); the edge has no consumer, so it must not run it
            // inline - the compiled rung fails loud on it.
            $implements = class_implements($listenerClass);
            if (is_array($implements) && in_array('Illuminate\\Contracts\\Queue\\ShouldQueue', $implements, true)) {
                $events[$eventClass]['queued'][] = $listenerClass;
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
];

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
