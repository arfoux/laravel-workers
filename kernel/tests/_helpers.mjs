// kernel/tests/_helpers.mjs — the stubs several kernel suites copied verbatim.
//
// The tests sweep found 35 helper bodies that were byte-identical across two
// or more suites (52 redundant copies, 439 lines). These four were identical
// everywhere they appeared; folding them here means the next fix lands once.
// Helpers that only LOOK shared (`normRow`, `normCookies`, `decodePayload`,
// `runOracle`) close over file-local state or differ per file and stay in
// their suite.

// The D1 binding the kernel handlers expect, over a real better-sqlite3
// handle: `prepare().bind().all()/first()/run()`, with the D1 result shapes.
export function d1(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) {
          params = p;
          return this;
        },
        async all() {
          const st = sqlite.prepare(sql);
          const rows = params.length ? st.all(...params) : st.all();
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
        async run() {
          const st = sqlite.prepare(sql);
          const info = params.length ? st.run(...params) : st.run();
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
    },
  };
}

// The byte-comparison tag for the `php-json` / `php-serialize` oracles: PHP's
// type name for a value, so `1` and `1.0` are not conflated.
export function tag(v) {
  if (v === null) return { t: 'n' };
  if (typeof v === 'boolean') return { t: 'b', v };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { t: 'd', v: 'NAN' };
    if (v === Infinity) return { t: 'd', v: 'INF' };
    if (v === -Infinity) return { t: 'd', v: '-INF' };
    if (Object.is(v, -0)) return { t: 'd', v: '-0' };
    if (Number.isInteger(v) && Number.isSafeInteger(v)) return { t: 'i', v: String(v) };
    return { t: 'd', v: String(v) };
  }
  if (typeof v === 'string') return { t: 's', v };
  if (Array.isArray(v)) return { t: 'a', v: v.map(tag) };
  return { t: 'a', v: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tag(x)])) };
}

// Split a raw Set-Cookie header into name/value/attrs, keeping attribute ORDER
// (parity) and normalising only the Max-Age value, which is time-dependent.
export function parseSetCookie(raw) {
  const parts = String(raw).split('; ');
  const first = parts[0];
  const eq = first.indexOf('=');
  const name = decodeURIComponent(first.slice(0, eq));
  const value = decodeURIComponent(first.slice(eq + 1));
  const attrs = parts.slice(1).map((a) => (a.toLowerCase().startsWith('max-age=') ? 'max-age=*' : a));
  return { name, value, attrs };
}

// Drop the headers whose value is never stable (`date`, `set-cookie`) so a
// header snapshot can be compared, lower-casing the survivor names.
export function normHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (key === 'date' || key === 'set-cookie') continue;
    out[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}
