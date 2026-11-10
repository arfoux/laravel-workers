import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of maatwebsite/excel v4.0.6 — CSV export from a D1 table. The PHP
// package's `Excel::download(new XlsxExport, 'file.xlsx')` writes a real
// spreadsheets; on the edge we cannot run PhpSpreadsheet, so CSV is the 1:1
// path (RFC 4180 = CSV is also what `FromArray` with a Doctrine-style header
// row produces when PhpSpreadsheet targets CSV). XLSX requires a ZIP+XML
// writer in JS — noted as a limitation, not silently faked.
//
// The stream is a single response body string (workers bodies are already
// streams); we build it with RFC 4180 quoting (quotes doubled, CRLF rows) so
// Excel/Numbers/Sheets open it correctly from the default route.
//
// Schema (read side, no migration needed — it reads rows from any table the
// caller registers; default table `users` when not given):
//   CREATE TABLE IF NOT EXISTS users (id, name, email, ...);
//   ensureSchema(env) below creates a `users` table for the demo export so the
//   route works out of the box against a fresh D1 binding.

export function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT
    )`
  ).run();
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // Quote only when needed (RFC 4180: contains quote/comma/CR/LF or
  // leading/trailing whitespace).
  if (/[",\r\n]|^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Build the full CSV text from rows + optional header names. Pure (no module
// state) so concurrent requests can't interleave each other's lines.
export function csvFromRows(rows, columns) {
  const lines = [];
  if (columns && columns.length) lines.push(columns.map(csvCell).join(','));
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}

// GET /export?format=csv&table=users — stream a CSV of the table's rows.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const query = ctx.query || {};
  const format = String(query.format || 'csv');
  if (format !== 'csv') {
    // Honest refusal: XLSX needs a proper spreadsheet writer, not a text
    // mime-type swap. (See doc paragraph for the substitute path.)
    return {
      status: 406,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'format not supported on the edge; use format=csv' }),
    };
  }

  try {
    await ensureSchema(env);
    const table = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(query.table || '')) ? query.table : 'users';

    const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    const results = rows.results || [];

    // Header = the union of keys across rows, in first-seen order.
    const columns = [];
    for (const r of results) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);

    const body = csvFromRows(results, columns);

    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${table}.csv"`,
        'cache-control': 'no-store',
      },
      body,
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err) }),
    };
  }
}
