<?php

// Dump ONE app class (its constructor metadata) — build time only.
// Usage: php tools/class-dump.php "App\\Policies\\AbilityGate" [...]
// Output (stdout): {"classes":{"<fqcn>":{"file":"...","kind":"service","ctor":[...]}}}
//
// Why a separate script: `event-dump.php` walks the event/listener graph of the
// app, which is not what a `Gate::define('x', 'Class@method')` callback needs —
// the build only needs that ONE class compiled so the kernel's gate can build
// it. Same ctor shape as event-dump.php (the build reads both the same way).

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require lw_vendor_autoload();

$app = require $root . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Http\Kernel::class);

/** Is this class one the build compiles (an app class, not a framework one)? */
$isAppClass = function (string $fqcn) use ($root): bool {
    try {
        $rc = new ReflectionClass($fqcn);
    } catch (Throwable $e) {
        return false;
    }
    $file = $rc->getFileName();
    if (! $file) return false;
    $file = str_replace('\\', '/', $file);
    $root = str_replace('\\', '/', $root);
    return str_starts_with($file, $root . '/app/');
};

$ctorDump = function (string $fqcn) use ($app, $isAppClass): array {
    $out = [];
    $rc = new ReflectionClass($fqcn);
    $ctor = $rc->getConstructor();
    if (! $ctor) return $out;
    foreach ($ctor->getParameters() as $p) {
        $entry = ['name' => $p->getName()];
        $type = $p->getType();
        if (! $type instanceof ReflectionNamedType) {
            $entry['kind'] = 'untyped';
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
        if (! $isAppClass($name)) {
            $entry['kind'] = 'external';
            $out[] = $entry;
            continue;
        }
        if ($p->isDefaultValueAvailable()) {
            $d = $p->getDefaultValue();
            if (is_scalar($d) || $d === null) $entry['default'] = $d;
        }
        $rc2 = new ReflectionClass($name);
        if ($rc2->isInterface() || $rc2->isAbstract()) {
            $entry['kind'] = 'abstract';
        } else {
            $entry['kind'] = 'class';
        }
        $out[] = $entry;
    }
    return $out;
};

$classes = [];
foreach (array_slice($argv, 1) as $fqcn) {
    $fqcn = ltrim((string) $fqcn, '\\');
    if ($fqcn === '' || ! class_exists($fqcn)) continue;
    $rc = new ReflectionClass($fqcn);
    $file = $rc->getFileName();
    if (! $file) continue;
    $classes[$fqcn] = ['file' => $file, 'kind' => 'service', 'ctor' => $ctorDump($fqcn)];
}

echo json_encode(['classes' => $classes]), "\n";
