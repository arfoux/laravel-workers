<?php

// Cache parity oracle — build/test time only.
//
// Runs a tagged op sequence against Laravel's real Illuminate\Cache\DatabaseStore
// (13.37) on SQLite, and dumps { results, rows } so kernel/tests/cache.test.mjs can
// diff it 1:1 against DatabaseCacheStore on a D1-shaped wrapper.
//
// STDIN  JSON: { app_root, prefix, now, ops: [ {op, ...}, ... ] }
// STDOUT JSON: { results: [...tagged...], rows: [{key,value,expiration}...] }
//
// Values are tagged ({t:"int"|"float"|"str"|"bool"|"null"|"array", v:...}) so PHP
// int/float/string distinctions survive JSON.

$in = json_decode(stream_get_contents(STDIN), true);
$root = $in['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);
if (!is_string($root) || $root === '' || !is_file(rtrim($root, "/\\") . '/vendor/autoload.php')) {
    fwrite(STDERR, "php-cache-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (vendor/autoload.php required)\n");
    exit(2);
}

require $root . '/vendor/autoload.php';

use Carbon\Carbon;
use Illuminate\Cache\DatabaseStore;
use Illuminate\Cache\Repository;
use Illuminate\Database\Capsule\Manager as Capsule;

/** tagged JSON value -> PHP value */
function lw_decode($v)
{
    if ($v === null) {
        return null;
    }
    switch ($v['t']) {
        case 'int':
            return (int) $v['v'];
        case 'float':
            return (float) $v['v'];
        case 'str':
            return (string) $v['v'];
        case 'bool':
            return (bool) $v['v'];
        case 'null':
            return null;
        case 'array':
            $out = [];
            foreach ($v['v'] as $k => $item) {
                $out[$k] = lw_decode($item);
            }
            return $out;
        default:
            throw new RuntimeException('unknown tag ' . $v['t']);
    }
}

/** PHP value -> tagged JSON value */
function lw_encode($value)
{
    if ($value === null) {
        return ['t' => 'null'];
    }
    if (is_bool($value)) {
        return ['t' => 'bool', 'v' => $value];
    }
    if (is_int($value)) {
        return ['t' => 'int', 'v' => $value];
    }
    if (is_float($value)) {
        return ['t' => 'float', 'v' => $value];
    }
    if (is_string($value)) {
        return ['t' => 'str', 'v' => $value];
    }
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $item) {
            $out[$k] = lw_encode($item);
        }
        return ['t' => 'array', 'v' => $out === [] ? [] : $out];
    }
    throw new RuntimeException('unsupported return type ' . gettype($value));
}

$prefix = $in['prefix'] ?? '';
$now = (int) ($in['now'] ?? time());
$ops = $in['ops'] ?? [];

Carbon::setTestNow(Carbon::createFromTimestamp($now));

$capsule = new Capsule();
$capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:']);
$capsule->setAsGlobal();
$capsule->bootEloquent();
$connection = $capsule->getConnection();

$schema = $connection->getSchemaBuilder();
$schema->create('cache', function ($t) {
    $t->string('key')->primary();
    $t->mediumText('value');
    $t->bigInteger('expiration')->index();
});
$schema->create('cache_locks', function ($t) {
    $t->string('key')->primary();
    $t->string('owner');
    $t->bigInteger('expiration')->index();
});

$store = new DatabaseStore($connection, 'cache', $prefix, 'cache_locks', [2, 100], 86400, false);
$repo = new Repository($store);

$results = [];
foreach ($ops as $op) {
    switch ($op['op']) {
        case 'put':
            $results[] = lw_encode($repo->put($op['key'], lw_decode($op['value']), $op['seconds']));
            break;
        case 'add':
            $results[] = lw_encode($repo->add($op['key'], lw_decode($op['value']), $op['seconds']));
            break;
        case 'forever':
            $results[] = lw_encode($repo->forever($op['key'], lw_decode($op['value'])));
            break;
        case 'get':
            $results[] = lw_encode($repo->get($op['key'], array_key_exists('default', $op) ? lw_decode($op['default']) : null));
            break;
        case 'has':
            $results[] = lw_encode($repo->has($op['key']));
            break;
        case 'increment':
            $results[] = lw_encode($repo->increment($op['key'], $op['amount'] ?? 1));
            break;
        case 'decrement':
            $results[] = lw_encode($repo->decrement($op['key'], $op['amount'] ?? 1));
            break;
        case 'forget':
            $results[] = lw_encode($repo->forget($op['key']));
            break;
        case 'touch':
            $results[] = lw_encode($store->touch($op['key'], $op['seconds']));
            break;
        case 'flush':
            $results[] = lw_encode($repo->flush());
            break;
        case 'advance':
            $now += (int) $op['seconds'];
            Carbon::setTestNow(Carbon::createFromTimestamp($now));
            $results[] = lw_encode($now);
            break;
        case 'rows':
            $rows = $connection->table('cache')->orderBy('key')->get();
            $results[] = lw_encode(array_map(function ($r) {
                return ['key' => $r->key, 'value' => $r->value, 'expiration' => (int) $r->expiration];
            }, $rows->all()));
            break;
        default:
            throw new RuntimeException('unknown op ' . $op['op']);
    }
}

$rows = $connection->table('cache')->orderBy('key')->get()->map(function ($r) {
    return ['key' => $r->key, 'value' => $r->value, 'expiration' => (int) $r->expiration];
})->all();

echo json_encode(['results' => $results, 'rows' => $rows], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
