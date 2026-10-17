// Port of GET /dbcheck (routes/web.php:10) — same response shape as the Laravel version.
export default async function handle(ctx, env) {
  try {
    const tables = await env.DB.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM config').first();
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        driver: 'd1-binding',
        tables: tables.results,
        config_rows: row ? row.n : null,
      }),
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err) }),
    };
  }
}
