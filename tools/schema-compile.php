<?php

/**
 * schema-compile.php — compile the app's migrations to a D1-ready schema
 * snapshot, WITHOUT requiring the app's database to be migrated first.
 *
 * How it works:
 *   1. boot the app (same as every other dump: reads .env + vendor),
 *   2. point the default connection at an in-memory SQLite database,
 *   3. run every migration against it (Laravel's Schema builder compiles the
 *      SQL with the SQLite grammar — the D1 dialect — no matter what driver
 *      the app is configured for: MySQL, Postgres or SQLite are all read
 *      through the same migration files),
 *   4. dump the resulting schema through the SQLite pragma interface.
 *
 * Output shape is identical to the old schema-dump.php, so `build.mjs` only
 * changes which tool it spawns. The consumer (dist/schema.json + schema.sql)
 * is unchanged.
 */

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

// `lw_boot_app()` resolves the autoloader (own vendor/ or LW_VENDOR_DIR), registers
// the checkout's App\ namespace, and injects a generated APP_KEY when the env has
// none — so a fresh clone with no .env can still boot and compile.
$app = lw_boot_app();

// A console kernel is what knows how to run `artisan migrate`; boot it (it also
// registers the migration repository service that `migrate` depends on).
$console = $app->make(Illuminate\Contracts\Console\Kernel::class);
$console->bootstrap();

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Config;

// ---- point the default connection at a throwaway in-memory SQLite ----
// This has to happen AFTER bootstrap (config is loaded) but BEFORE migrate.
// `:memory:` keeps one PDO alive per connection name inside Laravel, so the
// migrations and the pragma reads below share the same database.
$compileConn = 'lw_compile';
Config::set('database.default', $compileConn);
Config::set("database.connections.$compileConn", [
    'driver'                  => 'sqlite',
    'database'                => ':memory:',
    'prefix'                  => '',
    'foreign_key_constraints' => false,
    // Laravel's migrations table; needed by the migrator. No FKs enforced
    // during the compile — the DDL carries the constraints for D1 instead.
]);
DB::purge($compileConn); // drop any stale resolved connection for this name

// ---- run all migrations against that in-memory SQLite ----
// `--force` skips the confirmation prompt; `--no-interaction` keeps CI/SSH
// clean. Laravel creates the `migrations` repository table itself on first run.
$exit = $console->call('migrate', [
    '--force'          => true,
    '--no-interaction' => true,
]);
if ($exit !== 0) {
    fwrite(STDERR, "schema-compile: `artisan migrate` exited with status {$exit}\n");
    // the migrate output is already on the console; say which migrations were
    // clean, so the operator can fix the raw-SQL ones loudly.
    exit(1);
}

// ---- dump the schema exactly like schema-dump.php ----
// The queries below are SQLite pragma introspection; the connection is the
// in-memory SQLite we just migrated, so the DDL is the D1 dialect.

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
    fwrite(STDERR, "schema-compile: JSON encode failed\n");
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

// ---- optional argv[2]: materialise a build-time SQLite with this schema ----
// The build boots the app to prerender pages, and a Laravel app's own session
// middleware reads its session table on every request — so a fresh skeleton
// with no database file cannot boot at all ("DOES NOT RUN" on the simplest
// possible project). This throwaway sandbox gives prerender what a developer's
// `touch database/database.sqlite && php artisan migrate` gives them: the
// tables, empty. It is NOT the app's database and NOT the deployed D1 — the
// deploy-time `wrangler d1 execute DB --file=dist/schema.sql --remote` (schema
// plus the operator's data) stays manual and unchanged.
$sandboxPath = $argv[2] ?? null;
if ($sandboxPath !== null) {
    $dir = dirname($sandboxPath);
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    if (is_file($sandboxPath)) {
        unlink($sandboxPath);
    }
    $sandbox = new PDO('sqlite:' . $sandboxPath);
    $sandbox->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    foreach ($out['tables'] as $table) {
        $ddl = rtrim(trim((string) ($table['sql'] ?? '')), ';');
        if ($ddl !== '') {
            $sandbox->exec($ddl);
        }
    }
    // Named indexes carry their own DDL; sqlite's auto-indexes have NULL sql and
    // are recreated by the constraints inside the table DDL above.
    foreach (DB::select("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL") as $index) {
        $ddl = rtrim(trim((string) ($index->sql ?? '')), ';');
        if ($ddl !== '') {
            $sandbox->exec($ddl);
        }
    }
}
