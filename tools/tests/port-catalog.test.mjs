// tools/port-catalog.mjs reads the D1 tables and the env vars out of the two
// trees' own string literals, and the documents it generates are gated
// (`tools/gate.mjs` check 6). What it replaced was a hand grep, which also
// counted a `CREATE TABLE` sketched in a module's header comment — that is how
// `docs/D1-SCHEMA.md` claimed 42 tables while the code ran 48, and attributed
// `lw_webhook_events` to three ports that only insert into it.
//
// These tests pin the two halves that decide what the documents say: which
// literals are statements, and how many distinct shapes one table name has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogOrder, statementsIn, summaryTable, tables } from '../port-catalog.mjs';

test('port-catalog: comments are prose, every kind of literal is code', () => {
  const src = [
    '// ports/packages/example.mjs — the edge seam.',
    '//',
    '//   CREATE TABLE IF NOT EXISTS users (',
    '//     id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '//     email TEXT NOT NULL',
    '//   );',
    'export async function port(ctx, env) {',
    '  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS roles (',
    '    id INTEGER PRIMARY KEY AUTOINCREMENT',
    '  )`).run();',
    '  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS roles_name_idx ON roles (name)`).run();',
    '  const re = /CREATE TABLE IF NOT EXISTS nope/;',
    '  await env.DB.prepare("CREATE TABLE IF NOT EXISTS quoted (id INTEGER)").run();',
    '  return re.test(String(quoted));',
    '}',
  ].join('\n');
  // The comment sketch is what the old grep counted; a regex literal is not SQL;
  // a plain string IS - `prepare('INSERT INTO ...')` is how half the ports hold
  // their SQL, so only comments are dropped.
  assert.deepEqual(
    statementsIn(src).map((s) => [s.kind, s.name]),
    [
      ['table', 'roles'],
      ['index', 'roles_name_idx'],
      ['table', 'quoted'],
    ]
  );
});

test('port-catalog: a quote inside a regex does not desync the lexer', () => {
  const src = [
    'const quote = /["\']/;',
    '//   CREATE TABLE IF NOT EXISTS ghost (id INTEGER)',
    'await env.DB.prepare(`CREATE TABLE IF NOT EXISTS quotes (',
    "  id INTEGER PRIMARY KEY,",
    "  body TEXT NOT NULL DEFAULT ('x')",
    ')`).run();',
  ].join('\n');
  const found = statementsIn(src);
  assert.deepEqual(
    found.map((s) => s.name),
    ['quotes']
  );
  assert.match(found[0].text, /DEFAULT \('x'\)/);
});

// The shape of a module, as `scanTrees()` builds it - enough for `tables()`.
const mod = (slug, text) => ({
  tree: { dir: 'ports/packages', label: '' },
  slug,
  statements: [{ kind: 'table', name: /CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/.exec(text)[1], text }],
  env: [],
});

test('port-catalog: one name, two identical statements is ONE variant', () => {
  const body = 'CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY\n)';
  const same = [mod('sanctum', body), mod('jwt-auth', 'CREATE TABLE IF NOT EXISTS users (\n    id INTEGER PRIMARY KEY\n  )')];
  const rows = summaryTable(same, ['users']).split('\n').slice(2);
  assert.match(rows[0], /^\| 1 \| `users` \| `jwt-auth`, `sanctum` \| — \|$/, 'indentation-only difference is one variant');

  const differing = [mod('sanctum', body), mod('socialite', 'CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  provider TEXT\n)')];
  const rows2 = summaryTable(differing, ['users']).split('\n').slice(2);
  assert.match(rows2[0], /^\| 1 \| `users` \(2 variants\) \|/, 'a real column difference is two');
});

test('port-catalog: the summary follows the catalog, not the alphabet', () => {
  const mods = [mod('zebra', 'CREATE TABLE IF NOT EXISTS zebra (id INTEGER)'), mod('alpha', 'CREATE TABLE IF NOT EXISTS alpha (id INTEGER)')];
  const rows = summaryTable(mods, ['zebra', 'alpha']).split('\n').slice(2);
  assert.match(rows[0], /^\| 1 \| `zebra` /);
  assert.match(rows[1], /^\| 2 \| `alpha` /);

  // The order comes from the document's own `### N. \`table\`` headings; a name
  // the code does not create is dropped, and a table nobody described lands at
  // the end rather than silently replacing one.
  const doc = '## Catalog\n\n### 1. `zebra`\ndescription\n\n### 2. `alpha`\ndescription\n\n### 3. `ghost`\ndescription\n';
  assert.deepEqual(catalogOrder(doc, mods), ['zebra', 'alpha']);
  assert.deepEqual(catalogOrder(doc, [...mods, mod('mango', 'CREATE TABLE IF NOT EXISTS mango (id INTEGER)')]), ['zebra', 'alpha', 'mango']);
});
