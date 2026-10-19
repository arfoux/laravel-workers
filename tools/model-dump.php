<?php

// Dump Eloquent model metadata for the edge build — build time only.
// Usage: php tools/model-dump.php "App\Models\Post" ["App\Models\User" ...]
// Output (stdout): JSON array of
//   {fqcn, model, table, primaryKey, fillable, casts, timestamps, softDeletes,
//    hidden, appends, error}
// `model` is false and `error` explains why when the class is not a usable model.
//
// The app is booted through the same HTTP-kernel path as tools/prerender.php so the
// container/config (DB, casts, global scopes) is exactly what a real request sees.

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$out = [];

foreach (array_slice($argv, 1) as $fqcn) {
    $entry = [
        'fqcn' => $fqcn,
        'model' => false,
        'table' => null,
        'primaryKey' => null,
        'fillable' => [],
        'casts' => [],
        'timestamps' => true,
        'softDeletes' => false,
        'hidden' => [],
        'appends' => [],
        'error' => null,
    ];

    try {
        if (!class_exists($fqcn)) {
            $entry['error'] = 'class not found';
            $out[] = $entry;
            continue;
        }
        $rc = new ReflectionClass($fqcn);
        if (!$rc->isSubclassOf(Illuminate\Database\Eloquent\Model::class)) {
            $entry['error'] = 'not an Eloquent model';
            $out[] = $entry;
            continue;
        }
        if ($rc->isAbstract()) {
            $entry['error'] = 'abstract class';
            $out[] = $entry;
            continue;
        }

        /** @var Illuminate\Database\Eloquent\Model $instance */
        $instance = new $fqcn();

        // Normalise casts: Laravel 10/11 may hold cast objects (enums etc.).
        $casts = [];
        foreach ($instance->getCasts() as $column => $cast) {
            $casts[$column] = is_object($cast) ? get_class($cast) : (string) $cast;
        }

        $entry['model'] = true;
        $entry['table'] = $instance->getTable();
        $entry['primaryKey'] = $instance->getKeyName();
        // getFillable() merges the `#[Fillable]` class attribute (Laravel 13.x)
        // with the classic `$fillable` property.
        $entry['fillable'] = array_values($instance->getFillable());
        $entry['casts'] = $casts;
        $entry['timestamps'] = (bool) $instance->usesTimestamps();
        $entry['softDeletes'] = in_array(
            Illuminate\Database\Eloquent\SoftDeletes::class,
            class_uses_recursive($fqcn),
            true
        );
        $entry['hidden'] = array_values($instance->getHidden());
        $entry['appends'] = array_values($instance->getAppends());
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    $out[] = $entry;
}

echo json_encode($out);
