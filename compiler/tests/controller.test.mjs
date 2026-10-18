// compiler/tests/controller.test.mjs — controller transpilation: extract, emit, runtime.
//
// Runtime tests build a tiny dist-like tree in the OS temp dir (controllers +
// runtime + kernel + generated models/views), import the emitted handler and drive
// it with a mock D1 binding shaped like the real one (prepare/bind/all/first/run).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { extractController, emitController } from '../src/controller.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');

const SAMPLE = `<?php

namespace App\\Http\\Controllers;

use App\\Models\\Post;

class PostController extends Controller
{
    public function index()
    {
        $posts = Post::where('published', true)->orderByDesc('created_at')->limit(10)->get();
        return view('posts.index', compact('posts'));
    }

    public function show(string $id)
    {
        $post = Post::findOrFail($id);
        if ($post === null) {
            abort(404);
        }
        return view('posts.show', ['post' => $post]);
    }

    public function go(string $id)
    {
        $post = Post::findOrFail($id);
        return redirect()->route('posts.show', $post);
    }

    public function home()
    {
        return redirect('/');
    }

    public function bounce()
    {
        abort(404, 'gone');
    }

    public function api(string $id)
    {
        $post = Post::findOrFail($id);
        return response()->json(['title' => $post->title]);
    }

    public function link()
    {
        $u = url('/about');
        return redirect($u);
    }

    public function page(string $slug, int $page = 1)
    {
        $posts = Post::where('published', true)->get();
        return view('posts.index', compact('posts', 'slug', 'page'));
    }

    public function badStatic()
    {
        $x = Post::create(['title' => 'nope']);
        return view('posts.index');
    }

    public function badThis()
    {
        return $this->helper();
    }

    public function badClosure()
    {
        $ids = collect([1, 2])->map(fn($i) => Post::find($i));
        return view('posts.index', compact('ids'));
    }

    public function badClass()
    {
        $x = Log::info('hi');
        return redirect('/');
    }
}
`;

const META_BASE = {
  routeUri: '/posts/{post}',
  routeParams: ['post'],
  models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
  views: ['posts.index', 'posts.show'],
};

function emitOk(method, meta = META_BASE) {
  const res = emitController(SAMPLE, method, meta);
  assert.deepEqual(res.errors, [], `expected ${method} to transpile cleanly`);
  assert.ok(typeof res.code === 'string' && res.code.length > 0);
  return res.code;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

test('extractController resolves fqcn, params, model classes and views', () => {
  const info = extractController(SAMPLE, 'show');
  assert.equal(info.ok, true);
  assert.equal(info.fqcn, 'App\\Http\\Controllers\\PostController');
  assert.deepEqual(info.params.map((p) => p.name), ['id']);
  assert.equal(info.params[0].type, 'string');
  assert.equal(info.params[0].typeOk, true);
  assert.deepEqual(info.classes, [{ alias: 'Post', fqcn: 'App\\Models\\Post' }]);
  assert.deepEqual(info.views, ['posts.show']);
});

test('extractController collects types, defaults and compact views', () => {
  const info = extractController(SAMPLE, 'page');
  assert.deepEqual(info.params.map((p) => [p.name, p.type, p.hasDefault, p.default]), [
    ['slug', 'string', false, null],
    ['page', 'int', true, 1],
  ]);
  assert.deepEqual(info.views, ['posts.index']);
});

test('extractController reports a missing method', () => {
  const info = extractController(SAMPLE, 'nope');
  assert.equal(info.ok, false);
  assert.equal(info.errors[0].code, 'LW004');
});

test('extractController rejects a syntax error (LW004)', () => {
  const info = extractController('<?php class {', 'x');
  assert.equal(info.ok, false);
  assert.equal(info.errors[0].code, 'LW004');
});

// ---------------------------------------------------------------------------
// emit — codegen
// ---------------------------------------------------------------------------

test('emit: model chains, view(), compact() and params', () => {
  const code = emitOk('index');
  assert.match(code, /let v_posts;\n\s+v_posts = \(await rt\.model\("Post"\)\.where\("published", true\)\.orderByDesc\("created_at"\)\.limit\(10\)\.get\(\)\);/);
  assert.match(code, /rt\.view\("posts\.index", \{ "posts": v_posts \}\)/);
  assert.match(code, /import V0 from '\.\.\/views\/posts\.index\.mjs';/);
  assert.match(code, /import \{ models as LW_MODELS, routeMap as LW_ROUTE_MAP \} from '\.\.\/models\.generated\.mjs';/);
});

test('emit: findOrFail is awaited and params come from route segments', () => {
  const code = emitOk('show', { ...META_BASE, routeUri: '/posts/{id}', routeParams: ['id'] });
  assert.match(code, /let v_id = rt\.param\(ctx\.params, "id", "string", false, null\);/);
  assert.match(code, /let v_post;\n\s+v_post = \(await rt\.model\("Post"\)\.findOrFail\(v_id\)\);/);
  assert.match(code, /return rt\.view\("posts\.show", \{\s*"post": v_post\s*\}\);/);
});

test('emit: typed params with defaults use rt.param', () => {
  const code = emitOk('page', { ...META_BASE, routeUri: '/p/{slug}', routeParams: ['slug'] });
  assert.match(code, /let v_slug = rt\.param\(ctx\.params, "slug", "string", false, null\);/);
  assert.match(code, /let v_page = rt\.param\(ctx\.params, "page", "int", true, 1\);/);
  assert.match(code, /\{ "posts": v_posts, "slug": v_slug, "page": v_page \}/);
});

test('emit: redirects, json and url()', () => {
  const go = emitOk('go');
  assert.match(go, /return rt\.redirect\(rt\.route\("posts\.show", v_post\)\);/);
  const home = emitOk('home', { ...META_BASE, routeUri: '/', routeParams: [], views: [] });
  assert.match(home, /return rt\.redirect\("\/"\);/);
  const api = emitOk('api');
  assert.match(api, /return rt\.json\(\{\s*"title": rt\.prop\(v_post, "title"\)\s*\}\)/);
  const link = emitOk('link', { ...META_BASE, routeUri: '/about', routeParams: [], views: [] });
  assert.match(link, /v_u = rt\.url\("\/about"\);\n\s+return rt\.redirect\(v_u\);/);
});

test('emit: abort() maps to rt.abort', () => {
  const code = emitOk('bounce', { ...META_BASE, routeUri: '/bounce', routeParams: [], views: [] });
  assert.match(code, /rt\.abort\(404, "gone"\)/);
});

// ---------------------------------------------------------------------------
// emit — fail-loud gates
// ---------------------------------------------------------------------------

test('emit: unknown model static fails with LW003', () => {
  const res = emitController(SAMPLE, 'badStatic', META_BASE);
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /Post::create/);
});

test('emit: $this fails with LW002', () => {
  const res = emitController(SAMPLE, 'badThis', META_BASE);
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /\$this/);
});

test('emit: a database query inside a closure fails with LW002', () => {
  const res = emitController(SAMPLE, 'badClosure', META_BASE);
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /closure/);
});

test('emit: a non-model class (Log) fails with LW003', () => {
  const res = emitController(SAMPLE, 'badClass', META_BASE);
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /App\\Http\\Controllers\\Log|Log/);
});

test('emit: Request $request is injected (other services still fail loud)', () => {
  const src = `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Http\\Request;
class C {
    public function store(Request $request)
    {
        return redirect('/');
    }
}
`;
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /let v_request = rt\.request\(\);/);
  assert.match(res.code, /http: ctx/);
});

test('emit: Request $request does not consume a route segment', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function update(Request $request, string $id)\n' +
    '    {\n' +
    "        return response()->json(['id' => $id, 'email' => $request->input('email')]);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'update', { routeUri: '/x/{id}', routeParams: ['id'], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /let v_request = rt\.request\(\);/);
  assert.match(res.code, /let v_id = rt\.param\(ctx\.params, "id"/);
  assert.match(res.code, /v_request\.input\(["']email["']\)/);
});

test('emit: an aliased service type named Request is not injected', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Support\\Dingus as Request;\n' +
    'class C {\n' +
    '    public function store(Request $dingus)\n    {\n        return redirect(\'/\');\n    }\n}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /unsupported type/);
});

test('emit: $request->validate() compiles to an awaited rt request.validate() call', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        $validated = $request->validate(['email' => 'required|email']);\n" +
    "        return redirect('/');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /v_validated = \(await v_request\.validate\(/);
  assert.match(res.code, /"email"/);
});

test('emit: $request->validateWithBag() compiles to request.validateWithBag()', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        $request->validateWithBag('login', ['email' => 'required']);\n" +
    "        return redirect('/');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /v_request\.validateWithBag\(/);
});

test('emit: session()/old()/csrf_token()/csrf_field()/auth() map to the rt HTTP helpers', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Auth;\n' +
    'class C {\n' +
    '    public function form()\n' +
    '    {\n' +
    "        $email = old('email');\n" +
    '        $token = csrf_token();\n' +
    '        $field = csrf_field();\n' +
    "        $name = session('name');\n" +
    '        $flag = auth()->check();\n' +
    '        $uid = Auth::id();\n' +
    "        return response()->json(compact('email', 'token', 'field', 'name', 'flag', 'uid'));\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'form', { routeUri: '/form', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /rt\.old\(["']email["']\)/);
  assert.match(res.code, /rt\.csrf_token\(\)/);
  assert.match(res.code, /rt\.csrf_field\(\)/);
  assert.match(res.code, /rt\.session\(\)\.get\(["']name["']\)/);
  assert.match(res.code, /\(await rt\.auth\(\)\.check\(\)\)/);
  assert.match(res.code, /\(await rt\.auth\(\)\.id\(\)\)/);
});

// ---------------------------------------------------------------------------
// runtime — a mini dist tree + mock D1
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-controller-test-'));
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

writeTree(tmpRoot, {
  'kernel/model.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'model.mjs'), 'utf8'),
  'kernel/db.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'db.mjs'), 'utf8'),
  'src/runtime/rt-from-context.mjs': fs.readFileSync(
    path.join(pkgDir, 'compiler', 'runtime', 'rt-from-context.mjs'),
    'utf8'
  ),
  'src/models.generated.mjs': [
    "import { Model } from '../kernel/model.mjs';",
    '',
    'export class M_App_Models_Post extends Model {}',
    'M_App_Models_Post.table = "posts";',
    'M_App_Models_Post.primaryKey = "id";',
    'M_App_Models_Post.casts = { "id": "int" };',
    'M_App_Models_Post.timestamps = true;',
    'M_App_Models_Post.softDeletes = false;',
    '',
    'export const models = { "Post": M_App_Models_Post, "App\\\\Models\\\\Post": M_App_Models_Post };',
    'export const routeMap = { "posts.show": "posts/{post}", "posts.index": "posts" };',
    '',
  ].join('\n'),
  'src/views/posts.show.mjs': [
    'export default function main(rt) {',
    "  const post = rt.var('post');",
    "  rt.echo('<h1>' + rt.prop(post, 'title') + '</h1>');",
    '}',
    '',
  ].join('\n'),
  // Mimics the real compiled Blade @foreach output (the $__env bookkeeping the
  // transpiler emits for Laravel loops), so the runtime loop env is exercised.
  'src/views/posts.index.mjs': [
    'export default function main(rt) {',
    '  let v___currentLoopData, v_posts, v___env, v_post, v_loop;',
    '  v___currentLoopData = rt.var("__currentLoopData");',
    '  v_posts = rt.var("posts");',
    '  v___env = rt.var("__env");',
    '  v_post = rt.var("post");',
    '  v_loop = rt.var("loop");',
    '  rt.echo("<ul>");',
    '  v___currentLoopData = v_posts;',
    '  v___env.addLoop(v___currentLoopData);',
    '  for (const __e1 of rt.entries(v___currentLoopData)) {',
    '    v_post = __e1[1];',
    '    v___env.incrementLoopIndices();',
    '    v_loop = v___env.getLastLoop();',
    '    rt.echo("<li>" + rt.e(rt.prop(v_loop, "iteration")) + ":");',
    '    rt.echo(rt.e(rt.prop(v_post, "title")));',
    '    rt.echo(" first=" + rt.e(rt.prop(v_loop, "first")) + " last=" + rt.e(rt.prop(v_loop, "last")) + " count=" + rt.e(rt.prop(v_loop, "count")));',
    '    rt.echo("</li>");',
    '  }',
    '  v___env.popLoop();',
    '  rt.echo("</ul>");',
    '}',
    '',
  ].join('\n'),
  'src/contexts/posts.show.mjs': 'export default {};\n',
  'src/contexts/posts.index.mjs': 'export default {};\n',
});

const ROW = { id: 1, title: 'Hello Edge', published: 1 };

function mockDb(responses = {}) {
  return {
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...p) {
          this.params = p;
          return this;
        },
        async all() {
          return responses.all ? responses.all(sql, this.params) : { results: [] };
        },
        async first() {
          return responses.first ? responses.first(sql, this.params) : null;
        },
        async run() {
          return responses.run ? responses.run(sql, this.params) : { success: true, meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return stmt;
    },
  };
}

const dbWithRow = mockDb({
  first: () => ({ ...ROW }),
  all: () => ({ results: [{ ...ROW }] }),
});
const dbEmpty = mockDb({ first: () => null, all: () => ({ results: [] }) });

function ctxFor(params, host = 'example.com') {
  return {
    params,
    request: { method: 'GET', path: '/', headers: {}, host },
  };
}

async function handlerFor(method, meta = META_BASE) {
  const code = emitOk(method, meta);
  const file = path.join(tmpRoot, 'src', 'controllers', method + '.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href);
  return mod.default;
}

test('runtime: show renders the compiled view with the model from D1', async () => {
  const handle = await handlerFor('show', { ...META_BASE, routeUri: '/posts/{id}', routeParams: ['id'] });
  const res = await handle(ctxFor({ id: '1' }), { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(res.body, /<h1>Hello Edge<\/h1>/);
});

test('runtime: findOrFail miss becomes a 404 response', async () => {
  const handle = await handlerFor('show', { ...META_BASE, routeUri: '/posts/{id}', routeParams: ['id'] });
  const res = await handle(ctxFor({ id: '99' }), { DB: dbEmpty });
  assert.equal(res.status, 404);
  assert.match(res.body, /not found/);
});

test('runtime: index queries with a chain and renders the list view', async () => {
  const handle = await handlerFor('index', { ...META_BASE, routeUri: '/posts', routeParams: [] });
  const res = await handle(ctxFor({}), { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.match(res.body, /<li>1:Hello Edge first=1 last=1 count=1<\/li>/);

  const resEmpty = await handle(ctxFor({}), { DB: dbEmpty });
  assert.equal(resEmpty.status, 200);
  assert.match(resEmpty.body, /^<ul><\/ul>$/);
});

test('runtime: redirect()->route(name, $model) builds an absolute URL from host + route map', async () => {
  const handle = await handlerFor('go');
  const res = await handle(ctxFor({ post: '1' }), { DB: dbWithRow });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://example.com/posts/1');
});

test('runtime: redirect("/") and url()', async () => {
  const home = await handlerFor('home', { ...META_BASE, routeUri: '/', routeParams: [], views: [] });
  const resHome = await home(ctxFor({}), { DB: dbWithRow });
  assert.equal(resHome.status, 302);
  assert.equal(resHome.headers.location, '/');

  const link = await handlerFor('link', { ...META_BASE, routeUri: '/about', routeParams: [], views: [] });
  const resLink = await link(ctxFor({}), { DB: dbWithRow });
  assert.equal(resLink.status, 302);
  assert.equal(resLink.headers.location, 'https://example.com/about');
});

test('runtime: abort(404, message) becomes a 404 error response', async () => {
  const handle = await handlerFor('bounce', { ...META_BASE, routeUri: '/bounce', routeParams: [], views: [] });
  const res = await handle(ctxFor({}), { DB: dbWithRow });
  assert.equal(res.status, 404);
  assert.equal(res.body, 'gone');
});

test('runtime: response()->json() serialises model attributes', async () => {
  const handle = await handlerFor('api', { ...META_BASE, routeUri: '/api/posts/{id}', routeParams: ['id'] });
  const res = await handle(ctxFor({ id: '1' }), { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), { title: 'Hello Edge' });
});

test('runtime: typed default params apply when the segment is absent', async () => {
  const handle = await handlerFor('page', { ...META_BASE, routeUri: '/p/{slug}', routeParams: ['slug'] });
  const res = await handle(ctxFor({ slug: 'news' }), { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.match(res.body, /count=1/);
});

test('runtime: unresolved promise in view data fails loud at request time', async () => {
  const src = `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Post;
class C {
    public function late()
    {
        $q = Post::where('published', true);
        $posts = $q->get();
        return view('posts.index', ['posts' => $posts]);
    }
}
`;
  const code = emitController(src, 'late', { ...META_BASE, routeUri: '/late', routeParams: [] });
  assert.deepEqual(code.errors, []);
  const file = path.join(tmpRoot, 'src', 'controllers', 'late.mjs');
  fs.writeFileSync(file, code.code);
  const mod = await import(pathToFileURL(file).href + '?v=late');
  await assert.rejects(() => mod.default(ctxFor({}), { DB: dbWithRow }), /unresolved promise/);
});

test('runtime: missing D1 binding fails loud', async () => {
  const handle = await handlerFor('show', { ...META_BASE, routeUri: '/posts/{id}', routeParams: ['id'] });
  await assert.rejects(() => handle(ctxFor({ id: '1' }), {}), /no database binding|env\.DB/);
});

test('runtime: rt.prop reads model attributes with casts', async () => {
  const { buildRt } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'runtime', 'rt-from-context.mjs')).href);
  const { models } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'models.generated.mjs')).href);
  const M = models.Post;
  const rt = buildRt(null, { runtime: true, db: dbWithRow, models });
  const instance = await M.find(dbWithRow, '1');
  assert.equal(instance.get('id'), 1);
  assert.equal(rt.prop(instance, 'title'), 'Hello Edge');
  assert.equal(rt.prop(instance, 'missing'), null);
  assert.equal(rt.prop(null, 'title'), null);
});

async function handlerFromSource(src, method, meta) {
  const code = emitController(src, method, meta);
  assert.deepEqual(code.errors, [], 'expected a clean emit for ' + method);
  const file = path.join(tmpRoot, 'src', 'controllers', method + '-http.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code.code);
  const mod = await import(pathToFileURL(file).href + '?v=' + method);
  return mod.default;
}

test('runtime: session()/old()/csrf_token()/csrf_field()/auth()/request() read the live HTTP ctx', async () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'use Illuminate\\Support\\Facades\\Auth;\n' +
    'class C {\n' +
    '    public function form(Request $request, string $id)\n' +
    '    {\n' +
    "        $email = old('email');\n" +
    '        $token = csrf_token();\n' +
    '        $field = csrf_field();\n' +
    "        $name = session('name');\n" +
    '        $uid = Auth::id();\n' +
    "        $in = $request->input('email');\n" +
    "        return response()->json(compact('email', 'token', 'field', 'name', 'uid', 'in', 'id'));\n" +
    '    }\n' +
    '}\n';
  const handle = await handlerFromSource(src, 'form', {
    routeUri: '/form/{id}',
    routeParams: ['id'],
    models: [],
    views: [],
  });

  const TOKEN = 'A'.repeat(40);
  const store = {
    _old: { email: 'old@example.com' },
    getOldInput(k, d) {
      return Object.prototype.hasOwnProperty.call(this._old, k) ? this._old[k] : d;
    },
    get(k, d) {
      return k === 'name' ? 'Farosy' : d;
    },
    token() {
      return TOKEN;
    },
  };
  const auth = {
    check: async () => true,
    guest: async () => false,
    user: async () => ({ id: 7 }),
    id: async () => 7,
    guard: () => ({}),
  };
  const request = { input: (k) => (k === 'email' ? 'new@example.com' : null) };

  const res = await handle({ params: { id: '42' }, request, session: store, auth }, { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    email: 'old@example.com',
    token: TOKEN,
    field: '<input type="hidden" name="_token" value="' + TOKEN + '" autocomplete="off">',
    name: 'Farosy',
    uid: 7,
    in: 'new@example.com',
    id: '42',
  });
});

test('runtime: session()/request() fail loud without an HTTP ctx (static evaluation)', async () => {
  const { buildRt } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'runtime', 'rt-from-context.mjs')).href);
  const rt = buildRt(null, { runtime: true });
  assert.throws(() => rt.session(), /no HTTP context/);
  assert.throws(() => rt.request(), /no HTTP context/);
  assert.throws(() => rt.old('email'), /no HTTP context/);
});
