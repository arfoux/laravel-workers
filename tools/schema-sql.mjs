// tools/schema-sql.mjs — the SQL text of `dist/schema.sql`, from the snapshot.
//
// `tools/schema-compile.php` dumps `dist/schema.json` (every table with its own
// CREATE statement, its columns, its indexes and its foreign keys); the build
// renders the D1 schema from that snapshot and `npx laravel-workers deploy`
// applies the result to D1 (`wrangler d1 execute DB --file=dist/schema.sql`).
//
// Laravel's schema builder writes `->unique()` / `->index()` as SEPARATE
// `CREATE [UNIQUE] INDEX` statements, not as constraints inside the table DDL,
// so a render that reads only `table.sql` applied a database whose unique
// indexes were silently MISSING (#738): `users.email` lost its UNIQUE on every
// deployed D1, and nothing said so — the dump, the READINESS footer and the
// deploy all counted tables only.
//
// Each index entry now carries its own `sql` (added to schema-compile.php). An
// auto-index — the one a UNIQUE or PRIMARY KEY declared INSIDE the table DDL
// creates — has no SQL of its own (`sqlite_master.sql` is NULL for it) and is
// deliberately left out: the table statement already recreates it, and emitting
// it again would abort the apply with `index ... already exists`.
//
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { stripPhpCommentsAndStrings } from './readiness.mjs';

// Tables come first, indexes after: `d1 execute` runs the file statement by
// statement, and an index on a table that does not exist yet is a hard error.

// ---- the migrations a SNAPSHOT cannot replay (#737) ----
// `dist/schema.sql` is a plain `CREATE TABLE` snapshot: it is right for an EMPTY
// database and it cannot add a column to one that already has the table. A
// migration that mutates an existing table (`Schema::table()`, `Schema::drop()`,
// `Schema::rename()`) therefore has no path to an EXISTING deployed D1 through
// this tool — `deploy` skips the schema when the D1 already has tables, and
// `--schema=apply` re-runs the CREATEs, which fails on the first table that
// exists (tools/deploy.mjs says exactly that in its help). The build names the
// files so the operator hears it before the D1 is touched. A FRESH database
// needs nothing extra: the snapshot already carries the final shape.
//
// The snapshot itself cannot answer this — SQLite stores only the resulting
// DDL, so a later ALTER is indistinguishable from the original CREATE. The
// migration FILES are the only place the mutation is visible.
const MUTATING_MIGRATION = /\bSchema::(table|drop|dropIfExists|rename)\s*\(/;

/**
 * Remove every `function down()` body (brace-counted) before matching.
 *
 * A migration's `down()` is where the framework's own defaults drop and rename
 * (`0001_01_01_000000_create_users_table` drops its three tables), and `up()`
 * is the only method a deploy runs — so a mutation that lives only in `down()`
 * cannot leave the deployed D1 behind. Reporting it would bury the real one in
 * noise, which is how an operator learns to skip the list.
 */
function withoutDownBodies(code) {
  let out = '';
  let i = 0;
  for (;;) {
    const at = code.indexOf('function down', i);
    if (at === -1) return out + code.slice(i);
    out += code.slice(i, at);
    const open = code.indexOf('{', at);
    if (open === -1) return out + code.slice(at);
    let depth = 0;
    let k = open;
    for (; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = k + 1;
  }
}

/** The migration filenames that mutate an existing table (sorted, [] if none). */
export function mutatingMigrations(appDir) {
  const dir = join(appDir, 'database', 'migrations');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.php')) continue;
    let source;
    try {
      source = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    // A comment is not a call: `Schema::table` named in a doc block must not
    // report a migration that only creates. The repo already strips PHP
    // comments and strings (tools/readiness.mjs) — reuse it, do not add a
    // second convention.
    const code = withoutDownBodies(stripPhpCommentsAndStrings(source));
    if (MUTATING_MIGRATION.test(code)) out.push(name);
  }
  return out.sort();
}

/** Split the snapshot into the table statements and the index statements. */
export function schemaSqlParts(snapshot) {
  const tablesRaw = snapshot && Array.isArray(snapshot.tables) ? snapshot.tables : [];
  const tables = tablesRaw
    .map((t) => String((t && t.sql) || '').trim().replace(/;+$/, ''))
    .filter(Boolean);
  const indexes = tablesRaw
    .flatMap((t) => (t && Array.isArray(t.indexes) ? t.indexes : []))
    .map((i) => String((i && i.sql) || '').trim().replace(/;+$/, ''))
    .filter(Boolean);
  return { tables, indexes };
}

/** The whole `dist/schema.sql` text plus the counts the build reports. */
export function renderSchemaSql(snapshot, { head = '', blob = '' } = {}) {
  const { tables, indexes } = schemaSqlParts(snapshot);
  const body =
    (tables.length ? tables.join(';\n') + ';\n' : '') +
    (indexes.length
      ? '\n-- indexes (unique/partial): a table statement alone does not carry them\n' +
        indexes.join(';\n') +
        ';\n'
      : '');
  return { sql: head + body + blob, tableCount: tables.length, indexCount: indexes.length };
}

export default { mutatingMigrations, schemaSqlParts, renderSchemaSql };
