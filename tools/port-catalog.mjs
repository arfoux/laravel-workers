// tools/port-catalog.mjs — the generated port catalogs (docs/D1-SCHEMA.md, docs/ENV-SECRETS.md).
//
// Two documents in `docs/` describe what the package ports and the kernel
// packages do to a database and to `env`: which D1 tables they create (and with
// what SQL) and which `env.<NAME>` reads they make. Both were written by hand by
// grepping the two trees — which is why both rot: `docs/D1-SCHEMA.md` claims
// "every CREATE TABLE ... collected 2026-11-11" and was already missing five
// tables a day later. A hand copy of something the code can compute is the
// drift #697 describes.
//
// A raw grep is not enough either, and that is the subtle part: most modules
// sketch their schema in a header comment
//
//   // D1 schema (this cluster owns the table):
//   //   CREATE TABLE IF NOT EXISTS lw_settings (
//   //     ...
//   //   );
//
// next to the real `env.DB.prepare(\`CREATE TABLE ...\`)`. Counting the grep
// counts every sketch twice and a table that is only DOCUMENTED as created. So
// this tool lexes each module: a statement is a statement when it is inside a
// string or template literal, and an env name is a read when it appears in code
// (including inside a template's `${...}`), not in a comment.
//
//   node tools/port-catalog.mjs            # the generated markdown (stdout)
//   node tools/port-catalog.mjs --write    # write the generated regions into the docs
//   node tools/port-catalog.mjs --check    # the gate: fail when a doc no longer matches the code
//
// Only the regions between `<!-- port-catalog:... -->` markers are generated.
// Everything outside them is hand-written and stays that way: the per-table
// description, the caveats, the "must be set before a deploy" judgement for a
// secret. The check proves the hand-written parts still point at something real —
// every catalogued table exists in the code with a byte-matching SQL block, and
// no curated env row names a variable the code never reads.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The two trees the catalogs are about. `label` is how a module of that tree is
// spelled in the docs (`kernel ` + backticked slug for the kernel package).
const TREES = [
  { dir: 'ports/packages', label: '' },
  { dir: 'kernel/packages', label: 'kernel ' },
];

const D1_DOC = join(ROOT, 'docs', 'D1-SCHEMA.md');
const ENV_DOC = join(ROOT, 'docs', 'ENV-SECRETS.md');

const marker = (name, kind) => `<!-- port-catalog:${name}:${kind} -->`;

/**
 * `\``, `'` or `"` can open a regex literal, a division or a string: after one
 * of these a `/` opens a regex, after a value it divides. Only the regex call
 * matters here — a regex that carries a quote (`/"/g`) would otherwise be read
 * as the start of a string and swallow the rest of the module.
 */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * Classify every character of a module: 0 = code, 1 = comment, 2 = inside a
 * string/template literal. Template `${...}` returns to code, so `env.KEY` in an
 * interpolated template still counts as a read. Also returns the literal spans,
 * which is where a real `CREATE TABLE` lives.
 */
function lex(source) {
  const kinds = new Uint8Array(source.length);
  const literals = [];
  const stack = []; // 'tpl' frames and the brace depth of a `${...}` inside one
  let state = 'code';
  let quote = '';
  let start = 0;
  let prev = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        kinds[i] = 1;
        i++;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        kinds[i] = 1;
        i++;
        continue;
      }
      if (c === '/' && BEFORE_REGEX.has(prev)) {
        state = 'regex';
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = 'lit';
        quote = c;
        start = i;
      } else if (c === '{' && stack.length && stack[stack.length - 1].kind === 'brace') {
        stack[stack.length - 1].depth++;
      } else if (c === '}' && stack.length && stack[stack.length - 1].kind === 'brace') {
        if (stack[stack.length - 1].depth > 0) stack[stack.length - 1].depth--;
        else {
          stack.pop(); // back into the template literal
          state = 'lit';
          quote = '`';
        }
      } else if (c === '$' && d === '{' && stack.length && stack[stack.length - 1].kind === 'tpl') {
        stack.push({ kind: 'brace', depth: 0 });
        kinds[i] = 0;
        kinds[i + 1] = 0;
        i += 2;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    if (state === 'line') {
      kinds[i] = 1;
      if (c === '\n') state = 'code';
      i++;
      continue;
    }
    if (state === 'block') {
      kinds[i] = 1;
      if (c === '*' && d === '/') {
        kinds[i + 1] = 1;
        i += 2;
        state = 'code';
        continue;
      }
      i++;
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') i += 2;
      else if (c === '/') {
        state = 'code';
        i++;
      } else if (c === '\n') state = 'code'; // not a regex after all
      else i++;
      continue;
    }
    // state === 'lit'
    if (c === '\\') {
      kinds[i] = 2;
      if (i + 1 < source.length) kinds[i + 1] = 2;
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && d === '{') {
      literals.push({ from: start, to: i, quote });
      stack.push({ kind: 'tpl' });
      state = 'code';
      i += 2;
      continue;
    }
    kinds[i] = 2;
    if (c === quote) {
      literals.push({ from: start, to: i + 1, quote });
      state = 'code';
      prev = quote;
    }
    i++;
  }
  return { kinds, literals };
}

/**
 * Every `CREATE TABLE` / `CREATE INDEX` statement that is real code, in source
 * order — exported so `tools/tests/port-catalog.test.mjs` can pin the case that
 * started this tool: a `CREATE TABLE` sketched in a header comment is prose.
 */
export function statementsIn(source) {
  const { literals } = lex(source);
  const found = [];
  for (const span of literals) {
    const body = source.slice(span.from, span.to);
    const hits = [...body.matchAll(/CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
    hits.forEach((m, index) => {
      // A literal may hold more than one statement (a table and its index): each
      // one runs up to the next CREATE, the last to the closing delimiter.
      const next = index + 1 < hits.length ? hits[index + 1].index : body.length - 1;
      const text = body.slice(m.index, next).trim();
      if (text) found.push({ kind: m[1] === 'TABLE' ? 'table' : 'index', name: m[2], text });
    });
  }
  return found;
}

/** `env.NAME` and `env['NAME']` reads that are real code, in source order. */
function envReadsIn(source) {
  const { kinds } = lex(source);
  const names = [];
  const code = (index) => kinds[index] === 0;
  for (const m of source.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (code(m.index)) names.push(m[1]);
  for (const m of source.matchAll(/\benv\[\s*['"]([^'"]+)['"]\s*\]/g)) if (code(m.index)) names.push(m[1]);
  return names;
}

/** The modules of both trees with what each one creates and reads. */
export function scanTrees() {
  const modules = [];
  for (const tree of TREES) {
    for (const file of readdirSync(join(ROOT, tree.dir)).filter((f) => f.endsWith('.mjs')).sort()) {
      const source = readFileSync(join(ROOT, tree.dir, file), 'utf8');
      modules.push({
        tree,
        slug: file.replace(/\.mjs$/, ''),
        statements: statementsIn(source),
        env: envReadsIn(source),
      });
    }
  }
  return modules;
}

/** A kernel module is spelled `kernel \`slug\``, a port just \`slug\`.` */
const spellModule = (tree, slug) => `${tree.label}\`${slug}\``;

/**
 * The tables the code creates: name -> the module(s) that create it, its own
 * statement, and the index statements attributed to it (`... ON <table>`).
 */
export function tables(modules) {
  const byName = new Map();
  for (const mod of modules) {
    for (const stmt of mod.statements) {
      if (stmt.kind !== 'table') continue;
      if (!byName.has(stmt.name)) byName.set(stmt.name, { name: stmt.name, modules: new Set(), creators: [], table: null, indexes: [] });
      const entry = byName.get(stmt.name);
      entry.modules.add(spellModule(mod.tree, mod.slug));
      entry.creators.push(stmt.text);
      if (entry.table === null) entry.table = stmt.text;
    }
  }
  // An index belongs to the table it names after ON.
  for (const mod of modules) {
    for (const stmt of mod.statements) {
      if (stmt.kind !== 'index') continue;
      const on = /\bON\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(stmt.text);
      const entry = on && byName.get(on[1]);
      if (entry) entry.indexes.push({ name: stmt.name, text: stmt.text });
    }
  }
  return byName;
}

/**
 * How many DIFFERENT statements create this table. 1 is the normal case; 2 or
 * more means two ports provision the same name differently, which is a caveat
 * (the catalog can only quote one of them) and not something to smooth over.
 */
const variantCount = (entry) => new Set(entry.creators.map((sql) => normalise(sql))).size;

/** Every env name read by the two trees: name -> the module(s) reading it. */
export function envNames(modules) {
  const byName = new Map();
  for (const mod of modules) {
    for (const name of mod.env) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(spellModule(mod.tree, mod.slug));
    }
  }
  return byName;
}

const tableCount = (modules) => modules.reduce((n, m) => n + m.statements.filter((s) => s.kind === 'table').length, 0);
const indexCount = (modules) => modules.reduce((n, m) => n + m.statements.filter((s) => s.kind === 'index').length, 0);

/** The `**Totals**` block of docs/D1-SCHEMA.md. */
export function totalsBlock(modules) {
  return [
    '**Totals**',
    `- \`CREATE TABLE IF NOT EXISTS\` statements the code runs: **${tableCount(modules)}**`,
    `- Distinct table names: **${tables(modules).size}**`,
    `- Explicit indexes (\`CREATE INDEX IF NOT EXISTS\`): **${indexCount(modules)}**`,
  ].join('\n');
}

/**
 * The tables in the order the catalog describes them. The Summary is generated
 * from this order rather than sorted, because the catalog's order is the
 * author's (the activitylog/ai-sdk cluster first, the paddle trio last) and
 * re-sorting 40 prose sections to satisfy a table of contents is churn a reader
 * would have to re-read. A table the catalog does not describe is appended
 * sorted at the end — the check fails on it, so it is visible, not silently
 * ordered away.
 */
export function catalogOrder(doc, modules) {
  const described = catalogSections(doc).map((section) => section.name);
  const names = new Set(tables(modules).keys());
  const order = described.filter((name) => names.has(name));
  const missing = [...names].filter((name) => !order.includes(name)).sort();
  return [...order, ...missing];
}

/** The `## Summary` table of docs/D1-SCHEMA.md. */
export function summaryTable(modules, order) {
  const t = tables(modules);
  const lines = ['| # | Table | Port(s) | Explicit indexes |', '|---|-------|---------|------------------|'];
  order.forEach((name, i) => {
    const entry = t.get(name);
    const indexes = entry.indexes.map((idx) => `\`${idx.name}\``).join(', ') || '—';
    const variants = variantCount(entry);
    const label = variants > 1 ? `\`${name}\` (${variants} variants)` : `\`${name}\``;
    lines.push(`| ${i + 1} | ${label} | ${[...entry.modules].sort().join(', ')} | ${indexes} |`);
  });
  return lines.join('\n');
}

/** The `**Counts**` block of docs/ENV-SECRETS.md. */
export function countsBlock(modules) {
  const names = envNames(modules);
  const ports = [...names.values()].filter((mods) => [...mods].some((m) => !m.startsWith('kernel '))).length;
  return [
    '**Generated from both trees** — the curated tables further down carry the operator-facing judgement: which variable a deploy cannot run without.',
    `- env names read by the two trees: **${names.size}**`,
    `- read by a port in \`ports/packages\`: **${ports}**`,
  ].join('\n');
}

/** The complete env inventory table of docs/ENV-SECRETS.md. */
export function inventoryTable(modules) {
  const names = envNames(modules);
  // The column is the whole `env.` surface, which is not only secrets: `env.DB`
  // is the D1 binding and `env.fetchImpl` is the ports' fetch injection seam.
  const lines = ['| `env.` name | Read by |', '|-------------|---------|'];
  for (const name of [...names.keys()].sort()) {
    lines.push(`| \`${name}\` | ${[...names.get(name)].sort().join(', ')} |`);
  }
  return lines.join('\n');
}

// ── the docs ─────────────────────────────────────────────────────────────────

/** Replace the region between two markers, or fail loudly when they are absent. */
function splice(text, name, body) {
  const open = marker(name, 'start');
  const start = text.indexOf(open);
  const end = text.indexOf(marker(name, 'end'));
  if (start === -1 || end === -1) {
    console.error(`port-catalog FAIL: the document has no ${open} / ${marker(name, 'end')} markers`);
    process.exit(1);
  }
  return text.slice(0, start + open.length) + '\n\n' + body + '\n\n' + text.slice(end);
}

function currentRegion(text, name) {
  const open = marker(name, 'start');
  const start = text.indexOf(open);
  const end = text.indexOf(marker(name, 'end'));
  return start === -1 || end === -1 ? null : text.slice(start + open.length, end).trim();
}

// ── the parts the generated regions cannot express ───────────────────────────

/**
 * Whitespace-insensitive SQL comparison: the doc normalises indentation, and it
 * writes the trailing `;` that a template literal does not carry.
 */
const normalise = (sql) =>
  sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n')
    .replace(/;\s*$/, '');

/**
 * The `## Catalog` sections of docs/D1-SCHEMA.md: each `### N. \`table\`` heading
 * carries a hand-written description of what the table holds, and a generated
 * ```sql block. The heading NUMBERS are the section's own position in the
 * document, so they are checked too — the Summary is rendered in this same
 * order, which is how row N and section N stay the same table.
 */
function catalogSections(doc) {
  const heading = /^###\s+(\d+)\.\s+`([A-Za-z_][A-Za-z0-9_]*)`([^\n]*)$/gm;
  const hits = [...doc.matchAll(heading)];
  return hits.map((m, i) => {
    const from = m.index;
    const nextSection = i + 1 < hits.length ? hits[i + 1].index : -1;
    const nextHeader = doc.indexOf('\n## ', from);
    const candidates = [nextSection, nextHeader].filter((x) => x !== -1);
    const to = candidates.length ? Math.min(...candidates) : doc.length;
    const body = doc.slice(from, to);
    const sql = /```sql\n([\s\S]*?)```/.exec(body);
    return {
      name: m[2],
      number: Number(m[1]),
      tail: m[3],
      from,
      to,
      sqlFrom: sql ? from + sql.index : null,
      sqlTo: sql ? from + sql.index + sql[0].length : null,
    };
  });
}

/** The SQL quoted for a table: its own statement, then the indexes it names. */
const sqlFor = (entry) => [entry.table, ...entry.indexes.map((idx) => idx.text)].join('\n');

/**
 * Rewrite the Catalog: every section's ```sql block is the code's own text, and
 * the heading number is the table's row in the generated Summary. A table the
 * code creates but the catalog does not describe is NOT invented here — the
 * check reports it and a human writes the description, because that line is the
 * one part of the section that is not a grep.
 */
function rewriteCatalog(doc, modules) {
  const t = tables(modules);
  const order = catalogSections(doc).map((section) => section.name);
  let out = doc;
  for (const section of catalogSections(doc).reverse()) {
    const entry = t.get(section.name);
    if (!entry || variantCount(entry) > 1) continue;
    const block = '```sql\n' + sqlFor(entry) + '\n```';
    if (section.sqlFrom === null) {
      out = out.slice(0, section.to) + block + '\n\n' + out.slice(section.to);
    } else {
      out = out.slice(0, section.sqlFrom) + block + out.slice(section.sqlTo);
    }
  }
  return out.replace(/^###\s+(\d+)\.\s+(`[A-Za-z_][A-Za-z0-9_]*`)[^\n]*$/gm, (full, _num, quoted) => {
    const name = quoted.slice(1, -1);
    const row = order.indexOf(name);
    if (row === -1) return full;
    const entry = t.get(name);
    const variants = entry ? variantCount(entry) : 1;
    return `### ${row + 1}. ${quoted}${variants > 1 ? ` (${variants} variants)` : ''}`;
  });
}

/**
 * What the generated SQL cannot express: a section the code's table set does not
 * contain, a section missing from the catalog, a drifted SQL block, and a
 * heading that no longer agrees with the code (its number, its variant count).
 *
 * A table two ports create differently (`users`, `webhook_calls`) is documented
 * variant by variant and hand-labelled, so `--write` leaves those blocks alone;
 * what is checked is that every block some section quotes is a statement the
 * code actually runs — a stale column list cannot survive that.
 */
function checkCatalogSection(doc, modules, fail) {
  const t = tables(modules);
  const sections = catalogSections(doc);
  const seen = new Set();
  for (const section of sections) {
    const entry = t.get(section.name);
    seen.add(section.name);
    if (!entry) {
      fail(`docs/D1-SCHEMA.md: the \`${section.name}\` section names a table the code does not create`);
      continue;
    }
    const variants = variantCount(entry);
    if (variants > 1) {
      const blocks = [...doc.slice(section.from, section.to).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
      if (!blocks.length) fail(`docs/D1-SCHEMA.md: the \`${section.name}\` section has no SQL block`);
      const known = new Set(entry.creators.map(normalise));
      for (const block of blocks) {
        if (!known.has(normalise(block))) {
          fail(`docs/D1-SCHEMA.md: a SQL block quoted for \`${section.name}\` is not one of the statements the code runs`);
        }
      }
    } else {
      const sql = section.sqlFrom === null ? '' : doc.slice(section.sqlFrom, section.sqlTo);
      if (!sql.trim()) {
        fail(`docs/D1-SCHEMA.md: the \`${section.name}\` section has no SQL block`);
        continue;
      }
      if (normalise(sql.replace(/```sql|```/g, '')) !== normalise(sqlFor(entry))) {
        fail(`docs/D1-SCHEMA.md: the SQL quoted for \`${section.name}\` drifts from the code - run: node tools/port-catalog.mjs --write`);
      }
    }
    const expected = variants > 1 ? ` (${variants} variants)` : '';
    if (section.tail !== expected) {
      fail(`docs/D1-SCHEMA.md: the \`${section.name}\` heading says "${section.tail}", the code's own count is "${expected}" - run: node tools/port-catalog.mjs --write`);
    }
    const row = sections.indexOf(section) + 1;
    if (section.number !== row) {
      fail(`docs/D1-SCHEMA.md: the \`${section.name}\` section is numbered ${section.number}, its position is ${row}`);
    }
  }
  for (const name of t.keys()) {
    if (!seen.has(name)) fail(`docs/D1-SCHEMA.md: no catalog section for \`${name}\`, which the code creates`);
  }
}

/**
 * docs/ENV-SECRETS.md's curated tables are hand-written: which variable is
 * required, what format it takes. What the check proves is that every `NAME`
 * they mention is something the code reads — the way a curated row rots is by
 * outliving the read it documents.
 */
function checkCuratedEnvRows(doc, modules, fail) {
  const names = envNames(modules);
  const curated = doc.slice(0, doc.indexOf(marker('counts', 'start')));
  for (const m of curated.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (!names.has(m[1])) fail(`docs/ENV-SECRETS.md: the curated row \`${m[1]}\` names an env var neither tree reads`);
  }
}

// ── entry point ──────────────────────────────────────────────────────────────
// Guarded: importing this module (a test, a probe) must not print a catalog or
// exit the process.

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const modules = scanTrees();

  let failures = 0;
  const fail = (message) => {
    failures++;
    console.error(`port-catalog FAIL: ${message}`);
  };

  // The Summary is rendered in the catalog's own section order, so it has to be
  // read from the document rather than derived from the code alone.
  const order = catalogOrder(readFileSync(D1_DOC, 'utf8'), modules);
  const REGIONS = [
    [D1_DOC, [['totals', () => totalsBlock(modules)], ['summary', () => summaryTable(modules, order)]]],
    [ENV_DOC, [['counts', () => countsBlock(modules)], ['inventory', () => inventoryTable(modules)]]],
  ];

  if (write) {
    for (const [docPath, regions] of REGIONS) {
      let doc = readFileSync(docPath, 'utf8');
      for (const [name, render] of regions) doc = splice(doc, name, render(modules));
      if (docPath === D1_DOC) doc = rewriteCatalog(doc, modules);
      writeFileSync(docPath, doc);
    }
    console.log('docs/D1-SCHEMA.md and docs/ENV-SECRETS.md: the generated regions are written');
    return;
  }

  if (check) {
    for (const [docPath, regions] of REGIONS) {
      const doc = readFileSync(docPath, 'utf8');
      for (const [name, render] of regions) {
        const current = currentRegion(doc, name);
        const rel = docPath.slice(ROOT.length + 1).replace(/\\/g, '/');
        if (current === null) fail(`${rel}: no ${marker(name, 'start')} region`);
        else if (current !== render(modules).trim()) fail(`${rel}: the ${name} region is stale - run: node tools/port-catalog.mjs --write`);
      }
    }
    checkCatalogSection(readFileSync(D1_DOC, 'utf8'), modules, fail);
    checkCuratedEnvRows(readFileSync(ENV_DOC, 'utf8'), modules, fail);
    if (failures) process.exitCode = 1;
    else {
      console.log(
        `port-catalog PASS: ${tables(modules).size} D1 tables (${tableCount(modules)} statements, ${indexCount(modules)} indexes) and ${envNames(modules).size} env names - both documents match the code`
      );
    }
    return;
  }

  console.log(totalsBlock(modules) + '\n\n' + summaryTable(modules));
  console.log('\n---\n');
  console.log(countsBlock(modules) + '\n\n' + inventoryTable(modules));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
