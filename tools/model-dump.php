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

require lw_vendor_autoload();

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
        // The methods the app declares on the model (the relations, the
        // custom methods) + the accessor attribute names. The compiled rung
        // has none of them: reading one must stop the build, not answer null.
        'notCompiled' => [],
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
        // The route-model binding key (Laravel's implicit binding): the model's
        // getRouteKeyName() ('id' by default, 'slug' when the app overrides it).
        $entry['routeKey'] = $instance->getRouteKeyName();
        // getFillable() merges the `#[Fillable]` class attribute (Laravel 13.x)
        // with the classic `$fillable` property.
        $entry['fillable'] = array_values($instance->getFillable());
        // The `$guarded` list (GuardsAttributes::getGuarded()): Laravel's
        // DEFAULT is ['*'] - a model that declares neither $fillable nor
        // $guarded refuses every mass assignment (MassAssignmentException).
        // The edge needs the list to answer the same, not to allow everything.
        $entry['guarded'] = array_values($instance->getGuarded());
        $entry['casts'] = $casts;
        $entry['timestamps'] = (bool) $instance->usesTimestamps();
        $entry['softDeletes'] = in_array(
            Illuminate\Database\Eloquent\SoftDeletes::class,
            class_uses_recursive($fqcn),
            true
        );
        $entry['hidden'] = array_values($instance->getHidden());
        $entry['appends'] = array_values($instance->getAppends());

    // The methods the model declares itself (the relations + the custom
    // methods) and the accessor attribute names (getFooAttribute -> foo).
    // The compiled model has none of them, so the build must know them.
    $notCompiled = [];
    foreach ($rc->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
        if ($m->getDeclaringClass()->getName() !== $fqcn) {
            continue; // inherited from Eloquent: the compiled rung has it
        }
        $mname = $m->getName();
        if (preg_match('/^get(.+)Attribute$/', $mname, $mm)) {
            $notCompiled[] = lcfirst($mm[1]); // an accessor: not compiled
            continue;
        }
        $notCompiled[] = $mname;
    }
    $entry['notCompiled'] = array_values(array_unique($notCompiled));

    // The ACCESSORS (`public function getFullNameAttribute($value)`): the app's
    // own method, so the compiled rung has to carry it - Eloquent calls it
    // whenever the attribute is read (HasAttributes::getAttributeValue ->
    // transformModelValue). The build compiles the body and attaches it to the
    // generated model class; the dump names it and its file.
    $accessors = [];
    foreach ($rc->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
        if ($m->getDeclaringClass()->getName() !== $fqcn || $m->isStatic()) {
            continue;
        }
        if (!preg_match('/^get(.+)Attribute$/', $m->getName(), $mm)) {
            continue;
        }
        if ($m->getNumberOfParameters() !== 1) {
            // Eloquent's accessor takes exactly the value; anything else is a
            // different method that happens to share the name.
            continue;
        }
        $accessors[] = [
            'name' => lcfirst($mm[1]),
            'method' => $m->getName(),
            'file' => $rc->getFileName(),
        ];
    }
    $entry['accessors'] = $accessors;

    // The RELATIONS the model declares (`public function comments(): HasMany`).
    // Eloquent loads one lazily when it is read as a property
    // (Model::getRelationValue()), so the edge must know the relation's shape
    // at BUILD time: the compiled read becomes a query. A relation is
    // recognised by its declared RETURN TYPE (a Relation subclass) and its
    // keys come from the relation object's own getters - calling the method on
    // a fresh instance touches no database.
    $relations = [];
    foreach ($rc->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
        if ($m->isStatic() || $m->getDeclaringClass()->getName() !== $fqcn) {
            continue;
        }
        $returnType = $m->getReturnType();
        if (!$returnType instanceof ReflectionNamedType || $returnType->isBuiltin()) {
            continue;
        }
        $typeName = $returnType->getName();
        if (!class_exists($typeName) || !is_subclass_of($typeName, 'Illuminate\\Database\\Eloquent\\Relations\\Relation')) {
            continue;
        }
        // Only the shapes the kernel's loader answers: hasMany and belongsTo.
        // A morph / hasOne / through relation is LEFT OUT on purpose - reading
        // it stays a build error instead of answering the wrong shape.
        $kind = null;
        if (is_a($typeName, 'Illuminate\\Database\\Eloquent\\Relations\\HasMany', true)) {
            $kind = 'hasMany';
        } elseif (is_a($typeName, 'Illuminate\\Database\\Eloquent\\Relations\\BelongsTo', true)) {
            $kind = 'belongsTo';
        }
        if ($kind === null) {
            continue;
        }
        try {
            $relation = $m->invoke($instance);
        } catch (Throwable $e) {
            // The relation needs state the build does not have: leave it out
            // (the read keeps failing loud).
            continue;
        }
        $rel = [
            'name' => $m->getName(),
            'type' => $kind,
            'related' => get_class($relation->getRelated()),
            'foreignKey' => $relation->getForeignKeyName(),
        ];
        if ($kind === 'belongsTo') {
            $rel['ownerKey'] = $relation->getOwnerKeyName();
        } else {
            $rel['localKey'] = $relation->getLocalKeyName();
        }
        $relations[] = $rel;
    }
    $entry['relations'] = $relations;
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    $out[] = $entry;
}

echo json_encode($out);
