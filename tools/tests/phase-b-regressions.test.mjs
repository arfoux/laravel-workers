// tools/tests/phase-b-regressions.test.mjs — parent-verified Fase B regressions.
//
// Every assertion here is a current-tree repro that was observed before the fix
// landed. The file is auto-discovered by tools/run-tests.mjs; it needs no
// package.json entry. PHP-dependent probes are skipped cleanly when PHP is not
// installed (the rest of the suite uses the same convention).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import parser from 'php-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (args, env = {}) =>
  spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const php = process.env.PHP_BIN || 'php';
const hasPhp = () =>
  spawnSync(php, ['-v'], { encoding: 'utf8' }).status === 0;

/** Minimal D1 fake: records SQL + bindings, never executes them. Ports that only
 *  prepare/bind/run/all/first can be exercised without a SQLite driver. */
function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async run() {
          calls.push({ sql, args: stmt.args });
          return { last_row_id: 1, meta: { last_row_id: 1 } };
        },
        async all() {
          calls.push({ sql, args: stmt.args });
          return { results: [] };
        },
        async first() {
          calls.push({ sql, args: stmt.args });
          return null;
        },
      };
      return stmt;
    },
  };
}

/** Fold a class-body's constants through the real static reader. */
function foldConstants(body) {
  const dir = temp('lw-phase-b-const-');
  try {
    mkdirSync(join(dir, 'app'));
    const file = join(dir, 'app', 'Foo.php');
    writeFileSync(file, '<?php\nnamespace App;\nclass Foo {\n' + body.join('\n') + '\n}\n');
    const { classConstants, parsePhpFile } = awaitImportStatic();
    const parsed = parsePhpFile(file);
    assert.equal(parsed.error, undefined, parsed.error);
    return classConstants(dir, parsed, parsed.classes[0]).constants;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Synchronous import kept in a helper so foldConstants stays sync.
let _static = null;
function awaitImportStatic() {
  if (!_static) throw new Error('static module not loaded');
  return _static;
}

test('build: a bad LW_VENDOR_DIR fails loudly, not with a TDZ ReferenceError', () => {
  const r = run(['build.mjs'], { LW_VENDOR_DIR: 'C:/does-not-exist-lw-probe' });
  const out = r.stdout + r.stderr;
  assert.match(out, /BUILD FAILED/);
  assert.doesNotMatch(out, /ReferenceError: Cannot access 'fail' before initialization/);
});

test('build: middleware ports are applied to EVERY route sharing the URI', async () => {
  let mod;
  try {
    mod = await import('../middleware-ports.mjs');
  } catch (err) {
    assert.fail('tools/middleware-ports.mjs must export applyMiddlewarePorts: ' + err.message);
  }
  const table = [
    { uri: '/login', methods: ['GET'], kind: 'view' },
    { uri: '/login', methods: ['POST'], kind: 'controller' },
  ];
  mod.applyMiddlewarePorts(table, { '/login': ['locale'] }, () => false, (msg) => {
    throw new Error(msg);
  });
  assert.deepEqual(table.map((e) => e.middlewarePorts), [['locale'], ['locale']]);
});

test('navigation: the first depth-first node wins a tie on URL specificity', async () => {
  const { buildNavigation } = await import('../../kernel/packages/navigation.mjs');
  const items = [
    { label: 'A', url: '/a' },
    { label: 'B', url: '/x', children: [] },
    { label: 'C', url: '/x', children: [] },
  ];
  const tree = buildNavigation(items, { currentPath: '/x' });
  assert.equal(tree.find((n) => n.label === 'B').active, true);
  assert.equal(tree.find((n) => n.label === 'C').active, false);
});

test('mailcoach: store/fake reach the provider request body', async () => {
  const { sendMail } = await import('../../kernel/packages/mailcoach-mailer.mjs');
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const env = { fetch: fetchImpl, fetchImpl };
  const res = await sendMail(
    { to: 'a@b.test', html: '<p>hi</p>', token: 't', baseUrl: 'mailcoach.test', store: false, fake: true },
    env
  );
  assert.equal(res.status, 200);
  assert.equal(sent.store, false);
  assert.equal(sent.fake, true);
});

test('jsonc: a D1 UUID comparison is case-insensitive', async () => {
  const { updateWranglerD1Id, inspectD1Target } = await import('../jsonc.mjs');
  const uuid = 'AAAAAAAA-1234-5678-9ABC-DEF012345678';
  const text = JSON.stringify({
    name: 'app',
    d1_databases: [{ binding: 'DB', database_name: 'old-name', database_id: uuid }],
  });
  assert.equal(inspectD1Target(text, 'live-name').status, 'no-entry');
  const res = updateWranglerD1Id(text, 'live-name', uuid.toLowerCase());
  assert.equal(res.status, 'already');
});

test('php JSON oracle: INF floats emit a number the JS mirror can read', { skip: !hasPhp() }, () => {
  const r = spawnSync(php, ['tools/php-json-decode-oracle.php'], {
    cwd: ROOT,
    input: Buffer.from('{"cases":["MThlNDAw"]}'),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\bnum\(\)\b/);
  assert.match(r.stdout, /num\(Infinity\)/);
});

test('event dump: a license/string comment does not fake ShouldQueue', async () => {
  const { flagsOf } = await import('../event-flags.mjs').catch(() => ({}));
  if (typeof flagsOf !== 'function') {
    assert.fail('tools/event-flags.mjs must export flagsOf() for the regression probe');
  }
  assert.deepEqual(
    flagsOf('<?php // ShouldQueue in a comment\n$note = "ShouldBroadcast"; class L {}'),
    { queued: false, broadcast: false, afterCommit: false }
  );
  assert.deepEqual(
    flagsOf(
      '<?php class L implements \\Illuminate\\Contracts\\Queue\\ShouldQueue, ' +
        '\\Illuminate\\Contracts\\Events\\ShouldHandleEventsAfterCommit {}'
    ),
    { queued: true, broadcast: false, afterCommit: true }
  );
});

test('event-dump test: after() never deletes a pre-existing app fixture', () => {
  const app = temp('lw-event-dump-app-');
  try {
    mkdirSync(join(app, 'vendor'), { recursive: true });
    mkdirSync(join(app, 'app', 'Support'), { recursive: true });
    mkdirSync(join(app, 'app', 'Providers'), { recursive: true });
    mkdirSync(join(app, 'app', 'Services'), { recursive: true });
    writeFileSync(join(app, 'vendor', 'autoload.php'), '<?php\n');
    for (const name of ['AbstractReporter.php', 'ListenerContract.php']) {
      writeFileSync(join(app, 'app', 'Support', name), '<?php\n');
    }
    writeFileSync(
      join(app, 'app', 'Providers', 'AppServiceProvider.php'),
      '<?php\nclass AppServiceProvider { public function boot() {} }\n'
    );
    const sentinel = join(app, 'app', 'Services', 'LwBindingReporter.php');
    writeFileSync(sentinel, '<?php // pre-existing sentinel\n');
    const r = run(['tools/tests/event-dump.test.mjs'], {
      LW_LARAVEL_APP: app,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(sentinel), true, 'a pre-existing app file must survive the test');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('static constants: -"5" folds to int(-5) like PHP', () => {
  const c = foldConstants(["  const NEG = -'5';", "  const OK = 'v';"]);
  assert.equal(c.NEG, -5);
  assert.equal(c.OK, 'v');
});

test('static constants: PHP 64-bit shift/overflow cases fold, never get dropped', () => {
  const c = foldConstants([
    '  const TOO_FAR = 1 << 64;',
    '  const UNSAFE = 1 << 62;',
    '  const HUGE = 99999999999999999999;',
    "  const OK = 'v';",
  ]);
  assert.equal(c.TOO_FAR, 0);
  assert.equal(c.UNSAFE, 4611686018427387904);
  assert.equal(c.HUGE, 1.0e20);
  assert.equal(c.OK, 'v');
});

test('SPA cookie: a 204 response has no body', async () => {
  const handle = (await import('../../ports/packages/sanctum-spa-cookie.mjs')).default;
  const req = new Request('http://x/sanctum/csrf-cookie', { method: 'GET' });
  const res = await handle(
    { method: 'GET', url: 'http://x/sanctum/csrf-cookie', request: req, headers: req.headers },
    { SPA_COOKIE_SECRET: '0123456789abcdef0123456789abcdef' }
  );
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
});

test('translatable: an injected locale is refused or bound, never concatenated', async () => {
  const handle = (await import('../../ports/packages/spatie-translatable.mjs')).default;
  const db = fakeDb();
  const locale = "en') OR 1=1 OR json_extract(title,'$.en";
  const url = 'http://x/translatable-search?locale=' + encodeURIComponent(locale) + '&q=lar';
  const res = await handle({ method: 'GET', url, request: { method: 'GET', url } }, { DB: db });
  if (res.status === 400) return;
  const sql = db.calls.map((c) => c.sql).join('\n');
  assert.doesNotMatch(sql, /OR 1=1/);
  assert.ok(db.calls.some((c) => c.args && c.args.some((a) => String(a).includes('$.en'))));
  assert.equal(res.status, 200);
});

test('webhook ports: client and server use different D1 tables', async () => {
  const client = await import('../../ports/packages/webhook-client.mjs');
  const server = await import('../../ports/packages/webhook-server.mjs');
  const db = fakeDb();
  await client.ensureSchema({ DB: db });
  await server.ensureSchema({ DB: db });
  const sql = db.calls.map((c) => c.sql).join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS webhook_calls/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS webhook_server_calls/);
});

test('honeypot: an empty or negative MIN_DELTA_MS falls back to 1000ms', async () => {
  const handle = (await import('../../ports/packages/honeypot-middleware.mjs')).default;
  const body = { _hp_time: (Date.now() - 10).toString(36) };
  for (const value of ['', '-1']) {
    const res = await handle(
      { method: 'POST', body, request: new Request('http://x/', { method: 'POST' }) },
      { HONEYPOT_MIN_DELTA_MS: value }
    );
    assert.equal(res.status, 403, 'env=' + JSON.stringify(value));
  }
});

test('ai-sdk: max_rounds <= 0 is a 422, never a 200 with empty content', async () => {
  const handle = (await import('../../ports/packages/ai-sdk.mjs')).default;
  for (const maxRounds of [0, -2]) {
    const res = await handle(
      {
        user_id: 1,
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          options: { max_rounds: maxRounds },
        },
        request: new Request('http://x/ai', { method: 'POST' }),
      },
      { OPENAI_API_KEY: 'k' }
    );
    assert.equal(res.status, 422, 'max_rounds=' + maxRounds);
  }
});

test('firebase JWT: a missing or string exp claim is rejected', async () => {
  const mod = await import('../../ports/packages/firebase-php-jwt.mjs');
  if (typeof mod.claimsOk !== 'function') {
    assert.fail('firebase-php-jwt.mjs must export claimsOk() for the regression probe');
  }
  const base = {
    iss: 'https://securetoken.google.com/proj',
    aud: 'proj',
    sub: 'u1',
  };
  assert.equal(typeof mod.claimsOk({ ...base }, 'proj'), 'string');
  assert.equal(typeof mod.claimsOk({ ...base, exp: '1' }, 'proj'), 'string');
  assert.equal(mod.claimsOk({ ...base, exp: Math.floor(Date.now() / 1000) + 60 }, 'proj'), null);
});

test('activitylog: invalid limits are rejected and filters run before LIMIT', async () => {
  const handle = (await import('../../ports/packages/activitylog.mjs')).default;
  for (const limit of ['-1', '1.5', '0']) {
    const db = fakeDb();
    const res = await handle(
      { method: 'GET', url: 'http://x/activity?limit=' + limit, request: { method: 'GET', url: 'http://x/activity?limit=' + limit } },
      { DB: db }
    );
    assert.equal(res.status, 400, 'limit=' + limit);
  }
  const db = fakeDb();
  const url = 'http://x/activity?event=keep&subject_type=Post&log_name=default&limit=2';
  await handle({ method: 'GET', url, request: { method: 'GET', url } }, { DB: db });
  const select = db.calls.find((c) => c.sql.startsWith('SELECT') && c.sql.includes('LIMIT'));
  assert.ok(select, 'a SELECT with LIMIT must be issued');
  const where = select.sql.slice(0, select.sql.indexOf('LIMIT'));
  assert.match(where, /event = \?/);
  assert.match(where, /subject_type = \?/);
  assert.match(where, /log_name = \?/);
});

test('dompdf: an upstream error is not returned as base64 binary', async () => {
  const handle = (await import('../../ports/packages/dompdf.mjs')).default;
  const env = {
    PDF_API_KEY: 'k',
    fetch: async () =>
      new Response(JSON.stringify({ error: 'upstream down' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
  };
  const res = await handle(
    { body: { html: '<p>x</p>' }, user_id: 1, request: new Request('http://x/pdf', { method: 'POST' }) },
    env
  );
  assert.equal(res.status, 502);
  assert.equal(res.headers['content-transfer-encoding'], undefined);
  assert.doesNotMatch(String(res.body), /^(eyJ|JVBERi)/);
});

test('php loose equality: only decimal numeric strings count as numeric', async () => {
  const { isNumericForLooseEq } = await import('../../kernel/php-loose-eq.mjs');
  for (const s of ['0x10', '0b10', 'Infinity']) {
    assert.equal(isNumericForLooseEq(s), false, s);
  }
  for (const s of ['1e2', ' 1', '+1.5', '.5']) {
    assert.equal(isNumericForLooseEq(s), true, s);
  }
});

test('arr.only() preserves an own __proto__ key', async () => {
  const { arr } = await import('../../kernel/arr.mjs');
  const { parsePhpQuery } = await import('../../kernel/php-bag.mjs');
  const q = parsePhpQuery('__proto__=x&a=1');
  const out = arr.only(q, ['__proto__', 'a']);
  assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
  assert.equal(out.__proto__, 'x');
});

test('JSON_FORCE_OBJECT keeps PHP insertion order', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { strict: false });
  const v = rt.assoc([['a', 1], ['0', 2]]);
  assert.equal(rt.json_encode(v, 16), '{"a":1,"0":2}');
});

test('unserialize() preserves an own __proto__ key', async () => {
  const { phpUnserialize, phpSerialize } = await import('../../kernel/php-serialize.mjs');
  const s = 'a:2:{s:9:"__proto__";s:1:"x";s:1:"a";s:1:"1";}';
  const v = phpUnserialize(s);
  assert.equal(Object.prototype.hasOwnProperty.call(v, '__proto__'), true);
  assert.equal(Object.keys(v).includes('__proto__'), true);
  assert.match(phpSerialize(v), /__proto__/);
});

test('filled(): Laravel blank() uses PHP trim and treats empty arrays as blank', async () => {
  const { buildRequest } = await import('../../kernel/http.mjs');
  const make = (v) =>
    buildRequest(
      {
        method: 'POST',
        url: 'http://x/',
        body: JSON.stringify({ v }),
        headers: { 'content-type': 'application/json' },
      },
      { transformers: { trim: false, emptyToNull: false } }
    );
  for (const v of ['\f', '\u{00A0}', '\u{200B}']) {
    assert.equal(make(v).filled('v'), true, 'PHP trim leaves this value non-empty');
  }
  for (const v of ['\v', '\0', []]) {
    assert.equal(make(v).filled('v'), false, JSON.stringify(v));
  }
  assert.equal(make(false).filled('v'), true);
});

test('runtime: truthy uses PHP key count for arrays with string keys', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  const a = [];
  a.x = 1;
  assert.equal(rt.truthy(a), true);
  assert.equal(rt.truthy([]), false);
});

test('runtime: phpNumStr follows PHP precision-14 formatting', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  const cases = [
    [1e14, '1.0E+14'],
    [1e17, '1.0E+17'],
    [1e-5, '1.0E-5'],
    [1 / 3, '0.33333333333333'],
    [1.2345678901234567, '1.2345678901235'],
  ];
  for (const [v, want] of cases) {
    rt.__output = '';
    rt.echo(v);
    assert.equal(rt.__output, want, String(v));
  }
});

test('runtime: byte helpers use PHP string casts for booleans', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  assert.equal(rt.strlen(true), 1);
  assert.equal(rt.substr(true, 0, 1), '1');
  assert.equal(rt.str_repeat(true, 2), '11');
  assert.equal(rt.str_pad(true, 3, '-'), '1--');
});

test('runtime: array_keys/array_merge use PHP canonical integer keys', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  const ordered = rt.assoc([['01', 1], ['-1', 2], ['0', 3]]);
  assert.deepEqual(rt.array_keys(ordered), ['01', -1, 0]);
  assert.deepEqual(rt.array_merge(rt.assoc([['-1', 'a'], ['01', 'b']])), { 0: 'a', '01': 'b' });
});

test('runtime: count() rejects scalars instead of returning 0', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  for (const v of ['abc', 42, true]) {
    assert.throws(() => rt.count(v), TypeError, JSON.stringify(v));
  }
});

test('runtime: array_slice honors negative lengths', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  assert.deepEqual(rt.array_slice([1, 2, 3], 0, -1), [1, 2]);
  assert.deepEqual(rt.array_slice([1, 2, 3], -2, -1), [2]);
});

test('runtime: array_reverse preserves string keys', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  const out = rt.array_reverse({ a: 1, b: 2 });
  assert.equal(Array.isArray(out), false);
  assert.equal(out.b, 2);
  assert.equal(out.a, 1);
});

test('runtime: Carbon mutators mutate the receiver and return it', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt({}, { http: {} });
  const n = rt.now();
  const before = n.toDateTimeString();
  assert.equal(n.subHours(1), n);
  assert.notEqual(n.toDateTimeString(), before);
});

test('classes: colliding property names get distinct internal keys', () => {
  const p = new parser({ parser: { suppressErrors: true }, ast: { withPositions: true } });
  const cls = p.parseCode(
    '<?php class C { public $foo = 1; public $__foo = 2; public function show() { return $this->foo + $this->__foo; } }'
  ).children[0];
  const { classPropertyKeys } = awaitImportClasses();
  const keys = [...classPropertyKeys(cls, {})];
  assert.equal(new Set(keys.map(([, internal]) => internal)).size, keys.length);
});
let _classes = null;
function awaitImportClasses() {
  if (!_classes) throw new Error('classes module not loaded');
  return _classes;
}

test('classes: union-typed parameters are refused or enforced, never ignored', async () => {
  const dir = temp('lw-phase-b-union-');
  try {
    const file = join(dir, 'UnionProbe.php');
    writeFileSync(
      file,
      '<?php\nnamespace App;\nclass UnionProbe { public function run(string|int $x) { return $x; } }\n'
    );
    const { compileClasses } = await import('../../compiler/src/classes.mjs');
    const res = compileClasses(
      { classes: { 'App\\UnionProbe': { file, kind: 'plain' } }, events: {} },
      { classes: ['App\\UnionProbe'] }
    );
    assert.ok(Array.isArray(res.errors), 'compileClasses must answer with an errors array');
    assert.ok(res.errors.length > 0 || /instanceof|\|\//.test(res.code || ''), 'union type must not be ignored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mailable: compiled methods are not view data', async () => {
  const { Mailable } = await import('../../kernel/mailable.mjs');
  const mod = await import('../../kernel/mailable.mjs');
  if (typeof mod.publicProperties !== 'function') {
    assert.fail('kernel/mailable.mjs must export publicProperties() for the regression probe');
  }
  const m = new Mailable();
  m.greeting = function () { return 'method'; };
  m.with({ greeting: 'from-with' });
  const out = mod.publicProperties(m);
  assert.equal(out.greeting, 'from-with');
  assert.equal(typeof out.build, 'undefined');
});

test('controller: a write-only typed property is not a read', async () => {
  const { emitController } = await import('../../compiler/src/controller.mjs');
  const src = '<?php class C { private string $p; public function show(){ $this->p="x"; return "ok"; } }';
  const res = emitController(src, 'show', {});
  assert.deepEqual(res.errors, []);
});

test('controller: isset/empty/?? on a typed property are optional reads', async () => {
  const { emitController } = await import('../../compiler/src/controller.mjs');
  for (const body of [
    'return isset($this->p) ? 1 : 0;',
    'return $this->p ?? "default";',
  ]) {
    const src = '<?php class C { private string $p; public function show(){ ' + body + ' } }';
    const res = emitController(src, 'show', {});
    assert.deepEqual(res.errors, [], body);
  }
});

test('controller: $this?->helper() marks the helper reachable', async () => {
  const { emitController } = await import('../../compiler/src/controller.mjs');
  const src =
    '<?php class C { public function helper($n){ return "H".$n; } ' +
    'public function show(){ return $this?->helper("x"); } }';
  const res = emitController(src, 'show', {});
  assert.deepEqual(res.errors, []);
  assert.match(res.code || '', /helper/);
  assert.doesNotMatch(res.code || '', /const __self = \{ \}/);
});

test('gate: a two-arg global ability resolves to Gate::define() definitions', async () => {
  const { emitController } = await import('../../compiler/src/controller.mjs');
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Post;\n' +
    'class C { public function show(Post $post) { return Gate::allows("publishPost", $post); } }';
  const meta = {
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    routeUri: '/gate/{post}',
    routeParams: ['post'],
    classes: { fqcns: ['App\\Support\\GateCallbacks'] },
    policies: {
      'App\\Models\\Post': { error: null, hasMagicCall: false, globalBefore: 0, globalAfter: 0, definedAbilities: [], methods: {} },
      __global__: {
        error: null,
        hasMagicCall: false,
        globalBefore: 0,
        globalAfter: 0,
        definedAbilities: ['publishPost'],
        definitions: { publishPost: { kind: 'string', callback: 'App\\Support\\GateCallbacks@publish' } },
        methods: {},
      },
    },
  };
  const res = emitController(src, 'show', meta);
  assert.deepEqual(res.errors, []);
  assert.match(res.code || '', /gateGlobal/);
});

test('gate: denies() negates the AWAITED global verdict', async () => {
  const { emitController } = await import('../../compiler/src/controller.mjs');
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Post;\n' +
    'class C { public function show(Post $post) { return Gate::denies("publishPost", $post); } }';
  const meta = {
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    routeUri: '/gate/{post}',
    routeParams: ['post'],
    classes: { fqcns: ['App\\Support\\GateCallbacks'] },
    policies: {
      'App\\Models\\Post': { error: null, hasMagicCall: false, globalBefore: 0, globalAfter: 0, definedAbilities: [], methods: {} },
      __global__: {
        error: null,
        hasMagicCall: false,
        globalBefore: 0,
        globalAfter: 0,
        definedAbilities: ['publishPost'],
        definitions: { publishPost: { kind: 'string', callback: 'App\\Support\\GateCallbacks@publish' } },
        methods: {},
      },
    },
  };
  const res = emitController(src, 'show', meta);
  assert.deepEqual(res.errors, []);
  assert.match(res.code || '', /await !\(await rt\.gateGlobal/);
});

test('mail pending: cc/bcc/replyTo/subject are accepted fluent calls', async () => {
  const { transpileControllerMethod } = await import('../../compiler/src/transpiler.mjs');
  const body = new parser({ parser: { suppressErrors: true }, ast: { withPositions: true } })
    .parseCode('<?php function f() { Mail::to($u)->cc($c)->bcc($b)->replyTo($r)->subject("s")->send($m); }')
    .children[0].body.children;
  const res = transpileControllerMethod(body, { controller: true });
  assert.deepEqual(res.errors, []);
  assert.match(res.code || '', /rt\.mail\(\)\.to\(/);
});

test('CLI: developer test scripts redirect with exit 2', () => {
  for (const cmd of ['test:shadow', 'test:pack', 'test:str']) {
    const r = run(['bin/laravel-workers.mjs', cmd]);
    assert.equal(r.status, 2, cmd + ': ' + r.stderr);
  }
});

test('CLI: a null meta file and a directory --file fail with a message, not a TypeError', () => {
  const dir = temp('lw-phase-b-cli-');
  try {
    const input = join(dir, 'in.php');
    writeFileSync(input, '<?php class C { public function show() { return 1; } }');
    const meta = join(dir, 'null-meta.json');
    writeFileSync(meta, 'null');
    const r = run([
      'compiler/bin/controller.mjs', 'emit',
      '--file', input, '--method', 'show',
      '--meta', meta, '--out', join(dir, 'out.mjs'),
    ]);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr + r.stdout, /TypeError: Cannot read properties of null/);
    const r2 = run(['compiler/bin/controller.mjs', 'extract', '--file', dir, '--method', 'show']);
    assert.notEqual(r2.status, 0);
    assert.doesNotMatch(r2.stderr + r2.stdout, /EISDIR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --out without a value is refused; a missing parent dir is created', () => {
  const dir = temp('lw-phase-b-out-');
  try {
    const input = join(dir, 'in.php');
    writeFileSync(input, '<?php echo "ok";');
    const bare = run(['compiler/bin/transpile.mjs', input, '--out']);
    assert.equal(bare.status, 2, bare.stderr);
    const nested = join(dir, 'deep', 'nested', 'out.mjs');
    const r = run(['compiler/bin/transpile.mjs', input, '--out', nested]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(nested), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Load the two sync-import helpers once, after the module table is available.
_static = await import('../static.mjs');
_classes = await import('../../compiler/src/classes.mjs');
