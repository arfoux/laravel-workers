<?php
// tools/php-unique-exists-oracle.php — the real Laravel validator over SQLite.
//
// Regenerates the expected answers of the differential test
// "unique/exists read Laravel's extra where pairs, id exception and array value"
// (kernel/tests/validator.test.mjs). It builds the exact schema/rows that test
// builds, runs Illuminate\Validation\Factory with a DatabasePresenceVerifier,
// and prints one PASS/FAIL line per case - that is where the expected values in
// the test come from.
//
// Protocol: JSON on stdin, JSON on stdout.
//   { "cases": [ {"data": {...}, "rules": {...}}, ... ] }
//     -> { "results": ["PASS"|"FAIL", ...], "error": "<class>: <message>"? }
//
// Run: php tools/php-unique-exists-oracle.php < cases.json   (needs SQLite PDO)
//
// The Laravel app that supplies the autoloader comes from the `app_root` input
// field, or LW_LARAVEL_APP / LW_VENDOR_DIR when it is not given.
require_once __DIR__ . '/_root.php';

use Illuminate\Database\Capsule\Manager as Capsule;
use Illuminate\Translation\ArrayLoader;
use Illuminate\Translation\Translator;
use Illuminate\Validation\DatabasePresenceVerifier;
use Illuminate\Validation\Factory;

$input = json_decode((string) stream_get_contents(STDIN), true);
if (!is_array($input) || !isset($input['cases'])) {
    fwrite(STDERR, "expected {\"cases\": [...]} on stdin\n");
    exit(2);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);
if (!is_string($appRoot) || !is_file($appRoot . '/bootstrap/app.php') || !lw_has_vendor($appRoot)) {
    fwrite(STDERR, "php-unique-exists-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (a Laravel app root with an autoloader - set LW_VENDOR_DIR to reuse one)\n");
    exit(2);
}

require lw_vendor_autoload_for($appRoot);

$capsule = new Capsule;
$capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:']);
$capsule->setAsGlobal();
$capsule->bootEloquent();

// The schema and rows kernel/tests/validator.test.mjs creates.
$db = $capsule->getConnection();
$db->statement('create table t (id integer primary key, a text null, tenant integer null, deleted_at text null)');
$db->statement("insert into t (id, a, tenant, deleted_at) values
  (1,'dup@x',1,NULL),
  (2,'other@x',1,'2024-01-01'),
  (3,'dup@x',2,NULL),
  (4,NULL,2,NULL)");
$db->statement('create table u (id text primary key, a text null)');
$db->statement("insert into u (id, a) values
  ('Null','v1'),
  ('','v2'),
  ('a\"b\\c','v3'),
  ('7','v4'),
  ('x','v5')");

$factory = new Factory(new Translator(new ArrayLoader, 'en'));
$factory->setPresenceVerifier(new DatabasePresenceVerifier($capsule->getDatabaseManager()));

$results = [];
foreach ($input['cases'] as $case) {
    try {
        $validator = $factory->make($case['data'], $case['rules']);
        $results[] = $validator->passes() ? 'PASS' : 'FAIL';
    } catch (Throwable $e) {
        $results[] = 'ERROR ' . get_class($e) . ': ' . $e->getMessage();
    }
}

echo json_encode(['results' => $results], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";