// tools/make-html-entities.mjs — regenerate kernel/html-entities.mjs
//
// Laravel's RateLimiter::cleanRateLimiterKey() runs
//
//     preg_replace('/&([a-z])[a-z]+;/i', '$1', htmlentities($key))
//
// htmlentities() with no arguments uses PHP 8.1+ defaults:
// flags ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401 and default_charset (UTF-8).
// We bake the exact translation table so kernel/ratelimit.mjs can reproduce the
// byte-for-byte result without a PHP runtime on the edge.
//
// The generator cross-checks every table entry against htmlentities($char) and
// fails loudly on any mismatch, so a PHP default change can never silently
// desync the baked table.
//
// Usage: node tools/make-html-entities.mjs [--check]
//   --check  verify the file on disk is up to date; exit 1 when stale.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'kernel', 'html-entities.mjs');

const PHP = process.env.PHP_BIN || 'php';

const phpCode = `
$table = get_html_translation_table(HTML_ENTITIES, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, 'UTF-8');
if (count($table) < 200) {
    fwrite(STDERR, "translation table unexpectedly small: " . count($table) . " entries\\n");
    exit(1);
}
$out = [];
foreach ($table as $char => $entity) {
    if ($entity === $char) {
        continue;
    }
    // cross-check: htmlentities() with defaults must produce exactly $entity
    $actual = htmlentities($char);
    if ($actual !== $entity) {
        fwrite(STDERR, "mismatch for U+" . strtoupper(dechex(mb_ord($char, 'UTF-8'))) . ": table=$entity htmlentities=$actual\\n");
        exit(1);
    }
    $out[$char] = $entity;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
`;

const run = spawnSync(PHP, ['-r', phpCode], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (run.error) {
  console.error(`failed to run ${PHP}: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`php exited with code ${run.status}\n${run.stderr}`);
  process.exit(1);
}

/** @type {Record<string, string>} */
const table = JSON.parse(run.stdout);
const chars = Object.keys(table).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));

const lines = [];
lines.push('// kernel/html-entities.mjs — GENERATED FILE, do not edit by hand.');
lines.push('// Regenerate with: node tools/make-html-entities.mjs');
lines.push('//');
lines.push('// PHP 8.3 get_html_translation_table(HTML_ENTITIES, ENT_QUOTES |');
lines.push('// ENT_SUBSTITUTE | ENT_HTML401, "UTF-8") — the exact table htmlentities()');
lines.push('// applies with PHP 8.1+ default arguments (used by RateLimiter::');
lines.push('// cleanRateLimiterKey()). Each entry was cross-checked against');
lines.push('// htmlentities($char) at generation time.');
lines.push('');
lines.push('export const HTML_ENTITY_TABLE_SIZE = ' + chars.length + ';');
lines.push('');
lines.push('export const HTML_ENTITIES = Object.freeze({');
for (const ch of chars) {
  lines.push('  ' + JSON.stringify(ch) + ': ' + JSON.stringify(table[ch]) + ',');
}
lines.push('});');
lines.push('');
lines.push('export default HTML_ENTITIES;');
lines.push('');

const content = lines.join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`${OUT} missing — run: node tools/make-html-entities.mjs`);
    process.exit(1);
  }
  if (current !== content) {
    console.error(`${OUT} is stale — run: node tools/make-html-entities.mjs`);
    process.exit(1);
  }
  console.log(`kernel/html-entities.mjs up to date (${chars.length} entries)`);
  process.exit(0);
}

writeFileSync(OUT, content, 'utf8');
console.log(`wrote kernel/html-entities.mjs (${chars.length} entries, ${Buffer.byteLength(content)} bytes)`);
