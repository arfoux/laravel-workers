<?php

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

use Illuminate\Support\Facades\DB;

$escape = static function (string $name): string {
    return str_replace("'", "''", $name);
};

$parseColumns = static function (string $sql): array {
    if (!preg_match('/\((.*)\)/s', $sql, $match)) {
        return [];
    }
    $body = $match[1];
    $parts = [];
    $depth = 0;
    $buf = '';
    for ($i = 0; $i < strlen($body); $i++) {
        $ch = $body[$i];
        if ($ch === '(') {
            $depth++;
            $buf .= $ch;
        } elseif ($ch === ')') {
            $depth--;
            $buf .= $ch;
        } elseif ($ch === ',' && $depth === 0) {
            $parts[] = trim($buf);
            $buf = '';
        } else {
            $buf .= $ch;
        }
    }
    if (trim($buf) !== '') {
        $parts[] = trim($buf);
    }

    $columns = [];
    foreach ($parts as $part) {
        if (preg_match('/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i', $part)) {
            continue;
        }
        if (preg_match('/^"([^"]+)"\s+([A-Za-z]+)/', $part, $m) || preg_match('/^`([^`]+)`\s+([A-Za-z]+)/', $part, $m) || preg_match('/^\[([^\]]+)\]\s+([A-Za-z]+)/', $part, $m) || preg_match('/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+)/', $part, $m)) {
            $columns[] = [
                'cid' => count($columns),
                'name' => $m[1],
                'type' => strtoupper($m[2]),
                'notnull' => (bool) preg_match('/\bNOT\s+NULL\b/i', $part),
                'default' => null,
                'pk' => (bool) preg_match('/\bPRIMARY\s+KEY\b/i', $part),
            ];
        }
    }
    return $columns;
};

$tables = DB::select("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");

$out = ['tables' => []];

foreach ($tables as $table) {
    $name = (string) $table->name;
    $escaped = $escape($name);

    $columns = [];
    try {
        foreach (DB::select("SELECT * FROM pragma_table_info('$escaped')") as $column) {
            $columns[] = [
                'cid' => (int) $column->cid,
                'name' => (string) $column->name,
                'type' => (string) $column->type,
                'notnull' => (bool) $column->notnull,
                'default' => $column->dflt_value,
                'pk' => (bool) $column->pk,
            ];
        }
    } catch (Throwable $e) {
        $columns = $parseColumns((string) $table->sql);
    }
    if (!$columns) {
        $columns = $parseColumns((string) $table->sql);
    }

    $indexes = [];
    try {
        foreach (DB::select("SELECT * FROM pragma_index_list('$escaped')") as $index) {
            $indexName = (string) $index->name;
            $indexColumns = [];
            try {
                foreach (DB::select("SELECT * FROM pragma_index_info('" . $escape($indexName) . "')") as $info) {
                    $indexColumns[] = (string) $info->name;
                }
            } catch (Throwable $e) {
            }
            $indexes[] = [
                'name' => $indexName,
                'unique' => (bool) $index->unique,
                'origin' => (string) ($index->origin ?? ''),
                'partial' => (bool) ($index->partial ?? false),
                'columns' => $indexColumns,
            ];
        }
    } catch (Throwable $e) {
    }

    $foreignKeys = [];
    try {
        foreach (DB::select("SELECT * FROM pragma_foreign_key_list('$escaped')") as $fk) {
            $foreignKeys[] = [
                'id' => (int) $fk->id,
                'seq' => (int) $fk->seq,
                'table' => (string) $fk->table,
                'from' => (string) $fk->from,
                'to' => (string) $fk->to,
                'on_update' => (string) $fk->on_update,
                'on_delete' => (string) $fk->on_delete,
                'match' => (string) $fk->match,
            ];
        }
    } catch (Throwable $e) {
    }

    $out['tables'][] = [
        'name' => $name,
        'sql' => (string) $table->sql,
        'columns' => $columns,
        'indexes' => $indexes,
        'foreign_keys' => $foreignKeys,
    ];
}

$json = json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

if ($json === false) {
    fwrite(STDERR, "schema-dump: JSON encode failed\n");
    exit(1);
}

$outputPath = $argv[1] ?? null;
if ($outputPath !== null) {
    $dir = dirname($outputPath);
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    file_put_contents($outputPath, $json . "\n");
} else {
    echo $json . "\n";
}
