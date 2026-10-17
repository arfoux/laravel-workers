// Port of GET /dbcheck (routes/web.php:10) — same response shape as the Laravel version.
export async function handle(request, env) {
  try {
    const tables = await env.DB.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM config').first();
    return Response.json(
      {
        driver: 'd1-binding',
        tables: tables.results,
        config_rows: row ? row.n : null,
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (err) {
    return Response.json({ error: String((err && err.message) || err) }, { status: 500 });
  }
}
