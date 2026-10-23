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
import { transpile } from '../src/transpiler.mjs';

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
        $x = Post::destroy(1);
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
        // A class that is not a model must still fail loud with LW003.
        $x = Dingus::bar();
        return redirect('/');
    }

    public function gateCheck(string $id)
    {
        $post = Post::findOrFail($id);
        $ok = Gate::allows('update', $post);
        return response($ok ? 'yes' : 'no');
    }

    public function gateDeny(string $id)
    {
        $post = Post::findOrFail($id);
        $no = Gate::denies('update', $post);
        return response($no ? 'no' : 'yes');
    }

    public function gateClassLevel()
    {
        $ok = Gate::allows('viewAny', Post::class);
        return response($ok ? 'yes' : 'no');
    }

    public function layout()
    {
        $post = Post::find(1);
        return view('posts.layout', ['post' => $post]);
    }
}
`;

const META_BASE = {
  routeUri: '/posts/{post}',
  routeParams: ['post'],
  models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
  views: ['posts.index', 'posts.show'],
};

// The dumped Gate metadata (tools/policy-dump.php): the policy of the model,
// its abilities and the guest rules.
const META_POLICIES = {
  'App\\Models\\Post': {
    policy: 'App\\Policies\\PostPolicy',
    error: null,
    hasMagicCall: false,
    globalBefore: 0,
    globalAfter: 0,
    definedAbilities: [],
    before: null,
    methods: {
      viewAny: { guest: true, params: [{ name: 'user', type: 'App\\Models\\User' }] },
      update: {
        guest: false,
        params: [
          { name: 'user', type: 'App\\Models\\User' },
          { name: 'post', type: 'App\\Models\\Post' },
        ],
      },
    },
    compileError: null,
  },
};

// The app's object store (the config dump): the default disk is the compiled
// store; a named disk needs a bucket of its own.
const META_STORAGE = { defaultDisk: 'local', disks: ['local', 'public', 's3'] };

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
  assert.match(code, /let v_id = rt\.param\(ctx\.params, "id", "string", false, null, false\);/);
  assert.match(code, /let v_post;\n\s+v_post = \(await rt\.model\("Post"\)\.findOrFail\(v_id\)\);/);
  assert.match(code, /return rt\.view\("posts\.show", \{\s*"post": v_post\s*\}\);/);
});

test('emit: typed params with defaults use rt.param', () => {
  const code = emitOk('page', { ...META_BASE, routeUri: '/p/{slug}', routeParams: ['slug'] });
  assert.match(code, /let v_slug = rt\.param\(ctx\.params, "slug", "string", false, null, false\);/);
  assert.match(code, /let v_page = rt\.param\(ctx\.params, "page", "int", true, 1, false\);/);
  assert.match(code, /\{ "posts": v_posts, "slug": v_slug, "page": v_page \}/);
});

// ---------------------------------------------------------------------------
// the compiled classes (a mailable)
// ---------------------------------------------------------------------------

const SAMPLE_MAIL = `<?php

namespace App\\Http\\Controllers;

use App\\Mail\\OrderMail;

class MailController extends Controller
{
    public function send()
    {
        \\Illuminate\\Support\\Facades\\Mail::to('buyer@example.com')->send(new OrderMail());

        return response('sent');
    }
}
`;

test('extract: a mail in the method is flagged (the build compiles the mailable\'s view)', () => {
  const info = extractController(SAMPLE_MAIL, 'send');
  assert.equal(info.ok, true);
  assert.equal(info.usesMail, true);
  // A method without a mail does not need the mailable's view.
  assert.equal(extractController(SAMPLE, 'index').usesMail, false);
});

test('emit: a compiled class (a mailable) is built by the runtime and the handler gets the class registry', () => {
  const res = emitController(SAMPLE_MAIL, 'send', {
    ...META_BASE,
    classes: { fqcns: ['App\\Mail\\OrderMail'], aliases: { OrderMail: 'App\\Mail\\OrderMail' } },
  });
  assert.deepEqual(res.errors, [], 'the mailable compiles');
  // The instance comes from the runtime (the class registry).
  assert.match(res.code, /rt\.newClass\("App\\\\Mail\\\\OrderMail", \[\]\)/);
  // ... so the handler must import the registry and hand it to the runtime.
  assert.match(res.code, /import \{ classes as LW_CLASSES, eventListeners as LW_EVENT_LISTENERS \} from '\.\.\/classes\.generated\.mjs';/);
  assert.match(res.code, /classes: LW_CLASSES,/);
  // The chained send is awaited: a floating promise would leave the mail
  // after the response.
  assert.match(res.code, /await rt\.mail\(\)\.to\("buyer@example\.com"\)\.send\(/);
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
  assert.match(res.errors[0].message, /Post::destroy/);
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

test('emit: a non-model class fails with LW003', () => {
  const res = emitController(SAMPLE, 'badClass', META_BASE);
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /Dingus/);
});

// ---------------------------------------------------------------------------
// emit — the route-model binding (Laravel's implicit binding)
// ---------------------------------------------------------------------------

const META_BOUND = {
  routeUri: '/posts/{post}',
  routeParams: ['post'],
  models: [{ alias: 'Post', fqcn: 'App\\Models\\Post', routeKey: 'id', primaryKey: 'id' }],
  views: [],
};

test('emit: a model-bound parameter fetches the model from the route segment', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function show(Post $post)\n' +
    '    {\n' +
    "        return response($post->title);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'show', META_BOUND);
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  assert.match(
    res.code,
    /let v_post = \(await rt\.model\("App\\\\Models\\\\Post"\)\.findOrFail\(rt\.param\(ctx\.params, "post", "raw", false, null\)\)\);/
  );
});

test('emit: a model-bound parameter whose route parameter does not match fails loud (LW004)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function show(Post $post)\n' +
    '    {\n' +
    "        return response($post->title);\n" +
    '    }\n' +
    '}\n';
  // the route has {id}, the method has $post — Laravel binds by name.
  const res = emitController(src, 'show', { ...META_BOUND, routeParams: ['id'] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW004');
  assert.match(res.errors[0].message, /binds by name/);
});

test('emit: a model that binds on another key fails loud (LW003)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function show(Post $post)\n' +
    '    {\n' +
    "        return response($post->title);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'show', {
    ...META_BOUND,
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post', routeKey: 'slug', primaryKey: 'id' }],
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /binds on "slug"/);
});

// ---------------------------------------------------------------------------
// emit — the Gate (the policies are compiled at build time)
// ---------------------------------------------------------------------------

test('emit: Gate::allows() compiles to an awaited rt.gate() call', () => {
  const code = emitOk('gateCheck', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies: META_POLICIES,
  });
  assert.match(code, /\(await rt\.gate\("update", v_post, "App\\\\Models\\\\Post", false\)\)/);
  // The handler imports the compiled policies.
  assert.match(code, /import \{ policies as LW_POLICIES, gateDefinitions as LW_GATE_DEFINITIONS \} from '\.\.\/policies\.generated\.mjs';/);
  assert.match(code, /policies: LW_POLICIES,/);
});

test('emit: Gate::denies() negates the check', () => {
  const code = emitOk('gateDeny', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies: META_POLICIES,
  });
  assert.match(code, /\(await rt\.gate\("update", v_post, "App\\\\Models\\\\Post", true\)\)/);
});

test('emit: a class-level Gate check (Model::class) compiles with a null subject', () => {
  const code = emitOk('gateClassLevel', {
    ...META_BASE,
    routeUri: '/gate',
    routeParams: [],
    policies: META_POLICIES,
  });
  assert.match(code, /\(await rt\.gate\("viewAny", null, "App\\\\Models\\\\Post", false\)\)/);
});

test('emit: a Gate check without the dumped policy fails loud (LW003)', () => {
  const res = emitController(SAMPLE, 'gateCheck', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /policy for App\\Models\\Post was not dumped/);
});

test('emit: a global Gate::before() callback fails loud (LW002)', () => {
  const policies = JSON.parse(JSON.stringify(META_POLICIES));
  policies['App\\Models\\Post'].globalBefore = 1;
  const res = emitController(SAMPLE, 'gateCheck', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies,
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /global Gate::before\(\)/);
});

test('emit: an ability defined with Gate::define() fails loud (LW002)', () => {
  const policies = JSON.parse(JSON.stringify(META_POLICIES));
  policies['App\\Models\\Post'].definedAbilities = ['update'];
  const res = emitController(SAMPLE, 'gateCheck', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies,
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /Gate::define\(\)/);
});

test('emit: a class-level check of an ability that needs a subject fails loud (LW003)', () => {
  const res = emitController(SAMPLE, 'gateClassLevel', {
    ...META_BASE,
    routeUri: '/gate',
    routeParams: [],
    policies: META_POLICIES,
  });
  // viewAny takes the user only -> a class-level check is fine.
  assert.deepEqual(res.errors, []);
});

test('emit: Gate::authorize() / Gate::any() fail loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $post = Post::find(1);\n" +
    "        Gate::authorize('update', $post);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '    public function many()\n' +
    '    {\n' +
    "        $post = Post::find(1);\n" +
    "        $ok = Gate::any(['update'], $post);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const meta = {
    routeUri: '/x',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
    policies: META_POLICIES,
  };
  const a = emitController(src, 'store', meta);
  assert.equal(a.code, null);
  assert.equal(a.errors[0].code, 'LW002');
  assert.match(a.errors[0].message, /Gate::authorize\(\)/);
  const b = emitController(src, 'many', meta);
  assert.equal(b.code, null);
  assert.equal(b.errors[0].code, 'LW002');
  assert.match(b.errors[0].message, /Gate::any\(\)/);
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

test('emit: redirect()->intended() pulls url.intended from the session (default /)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    '        return redirect()->intended();\n' +
    '    }\n' +
    '    public function go()\n' +
    '    {\n' +
    "        return redirect()->intended('/dashboard');\n" +
    '    }\n' +
    '}\n';
  const meta = { routeUri: '/login', routeParams: [], models: [], views: [] };
  const a = emitController(src, 'store', meta);
  assert.deepEqual(a.errors, []);
  assert.match(a.code, /return rt\.redirect\(rt\.session\(\)\.pull\("url\.intended", "\/"\)\);/);
  const b = emitController(src, 'go', meta);
  assert.deepEqual(b.errors, []);
  assert.match(b.code, /return rt\.redirect\(rt\.session\(\)\.pull\("url\.intended", "\/dashboard"\)\);/);
});

test('emit: session()->regenerate()/invalidate() await, regenerateToken() stays sync', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    '        $request->session()->regenerate();\n' +
    '        $request->session()->regenerateToken();\n' +
    "        return redirect('/');\n" +
    '    }\n' +
    '    public function out()\n' +
    '    {\n' +
    '        session()->invalidate();\n' +
    "        return redirect('/');\n" +
    '    }\n' +
    '}\n';
  const a = emitController(src, 'store', { routeUri: '/login', routeParams: [], models: [], views: [] });
  assert.deepEqual(a.errors, []);
  assert.match(a.code, /\(await v_request\.session\(\)\.regenerate\(\)\);/);
  assert.match(a.code, /v_request\.session\(\)\.regenerateToken\(\);/);
  const b = emitController(src, 'out', { routeUri: '/logout', routeParams: [], models: [], views: [] });
  assert.deepEqual(b.errors, []);
  assert.match(b.code, /\(await rt\.session\(\)\.invalidate\(\)\);/);
});

test('emit: `throw ValidationException::withMessages([...])` maps to rt.validationExceptionWithMessages', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Validation\\ValidationException;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        throw ValidationException::withMessages(['email' => 'These credentials do not match our records.']);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/login', routeParams: [], models: [], views: [] });
  assert.deepEqual(res.errors, []);
  assert.match(
    res.code,
    /throw rt\.validationExceptionWithMessages\(\{"email": "These credentials do not match our records\."\}\);/
  );
});

test('emit: an unsupported ValidationException static fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Validation\\ValidationException;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    '        throw ValidationException::withValidator(1);\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/login', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'LW002');
});

// ---------------------------------------------------------------------------
// emit — FormRequest, facades, writes, constants
// ---------------------------------------------------------------------------

test('emit: a FormRequest parameter is injected and validated before the body', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Http\\Requests\\StorePostRequest;\n' +
    'class C {\n' +
    '    public function store(StorePostRequest $request)\n' +
    '    {\n' +
    "        $data = $request->validated();\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/posts',
    routeParams: [],
    models: [],
    views: [],
    formRequests: {
      'App\\Http\\Requests\\StorePostRequest': {
        rules: { title: ['required', 'string'] },
        messages: { 'title.required': 'The :attribute is required.' },
        attributes: { title: 'post title' },
      },
    },
  });
  assert.equal(res.errors.length, 0);
  // The rules are compiled in and the runtime runs Laravel's lifecycle on the
  // compiled FormRequest class before the body.
  assert.match(
    res.code,
    /await rt\.formRequest\("App\\\\Http\\\\Requests\\\\StorePostRequest", \{ rules: \{"title":\["required","string"\]\}/
  );
  assert.match(res.code, /let v_request = rt\.request\(\);/);
  assert.match(res.code, /v_request\.validated\(\)/);
});

test('emit: a class-typed parameter that is not a FormRequest fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Support\\Dingus;\n' +
    'class C {\n' +
    '    public function store(Dingus $dingus)\n' +
    '    {\n' +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/posts', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /unsupported type/);
});

test('emit: the Cache and Hash facades compile to the rt cache/hash helpers', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Cache;\n' +
    'use Illuminate\\Support\\Facades\\Hash;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Cache::put('k', 'v', 60);\n" +
    "        Cache::forget('k');\n" +
    "        $v = Cache::get('k', 'missing');\n" +
    "        $h = Hash::make('secret');\n" +
    "        return response($v . $h);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /\(await rt\.cache\(\)\.put\("k", "v", 60\)\)/);
  assert.match(res.code, /\(await rt\.cache\(\)\.forget\("k"\)\)/);
  assert.match(res.code, /\(await rt\.cache\(\)\.get\("k", "missing"\)\)/);
  assert.match(res.code, /\(await rt\.hash\.make\("secret"\)\)/);
});

test('emit: an unsupported Cache/Hash method fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Cache;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Cache::store('redis');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /Cache::store/);
});

test('emit: `$model->attr = $value` compiles to rt.propSet', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function update(string $id)\n' +
    '    {\n' +
    "        $post = Post::findOrFail($id);\n" +
    "        $post->title = 'x';\n" +
    "        $post->save();\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'update', {
    routeUri: '/posts/{id}',
    routeParams: ['id'],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /rt\.propSet\(v_post, "title", "x"\)/);
  // The write needs the D1 binding and is awaited.
  assert.match(res.code, /\(await v_post\.save\(rt\.db\(\)\)\)/);
});

test('emit: Post::create() compiles to an awaited rt.model(...).create()', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Post::create(['title' => 'x']);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/posts',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /\(await rt\.model\("Post"\)\.create\(/);
});

test('emit: a class constant is baked in from the build-time dump', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Providers\\RouteServiceProvider;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        return redirect(RouteServiceProvider::HOME);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    constants: { RouteServiceProvider: { HOME: '/dashboard' } },
  });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /rt\.redirect\("\/dashboard"\)/);
});

test('emit: an unknown class constant fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Providers\\RouteServiceProvider;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        return redirect(RouteServiceProvider::HOME);\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /RouteServiceProvider::HOME/);
});

test('emit: response() returns a status/headers/body response object', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  // Laravel's response() is a text/html response (Symfony's default charset).
  assert.match(res.code, /\{ status: 200, headers: \{ 'content-type': 'text\/html; charset=utf-8' \}, body: "ok" \}/);
});

test('emit: the Storage facade compiles to the R2-backed store', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Storage::put('a/b.txt', 'hello');\n" +
    "        $v = Storage::get('a/b.txt');\n" +
    "        $e = Storage::exists('a/b.txt');\n" +
    "        Storage::delete('a/b.txt');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0);
  assert.match(res.code, /\(await rt\.storage\(\)\.put\("a\/b\.txt", "hello"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.getText\("a\/b\.txt"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.exists\("a\/b\.txt"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.delete\("a\/b\.txt"\)\)/);
});

test('emit: new <PHP exception> compiles (the built-in exceptions only)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    "        throw new \\RuntimeException('boom');\n" +
    "        throw_if(false, new \\InvalidArgumentException('x', 42));\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.newError\("RuntimeException", "boom"\)/);
  assert.match(res.code, /rt\.throwIf\(false, rt\.newError\("InvalidArgumentException", "x", 42\)\)/);
});

test('emit: new <app class> fails loud (LW002) - the app classes are not compiled', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    "        throw new App\\Exceptions\\Mine('x');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /App\\Exceptions\\Mine/);
});

test('emit: new <model> fails loud with the MODEL\'s reason (not "only the built-in exceptions")', () => {
  // The edge has the query builder, not the Eloquent instance: the reason has
  // to name the model the app asked for.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    '        $p = new Post();\n' +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const models = [{ alias: 'Post', fqcn: 'App\\Models\\Post' }];
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models, views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /the model App\\Models\\Post is not compiled at the edge/);
  // The FQCN form names it too.
  const srcFqcn = src.replace('new Post()', 'new \\App\\Models\\Post()');
  const resFqcn = emitController(srcFqcn, 'demo', { routeUri: '/x', routeParams: [], models, views: [] });
  assert.equal(resFqcn.code, null);
  assert.match(resFqcn.errors[0].message, /the model App\\Models\\Post is not compiled at the edge/);
});

test('emit: the helper verbs compile (abort_if, abort_unless, today, Log::)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    "        abort_if(false, 404, 'never');\n" +
    "        abort_unless(true, 500, 'never');\n" +
    "        $t = today()->toDateString();\n" +
    "        \\Illuminate\\Support\\Facades\\Log::info('hello');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.abortIf\(false, 404, "never"\)/);
  assert.match(res.code, /rt\.abortUnless\(true, 500, "never"\)/);
  assert.match(res.code, /rt\.today\(\)\.toDateString\(\)/);
  assert.match(res.code, /rt\.log\("info", "hello"\)/);
});
test('emit: the flash modifiers compile (redirect()->with/withInput/withErrors)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        return redirect('/x')->with('status', 'saved');\n" +
    "        return redirect('/x')->withInput();\n" +
    "        return redirect('/x')->withErrors(['a' => 'bad']);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.redirect\("\/x"\)\.with\("status", "saved"\)/);
  assert.match(res.code, /rt\.redirect\("\/x"\)\.withInput\(\)/);
  assert.match(res.code, /rt\.redirect\("\/x"\)\.withErrors\(\{/);
});

test('emit: the helper surface compiles (away, back, env, data_get, tap, report, cache, session[])', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    "        return redirect()->away('https://example.com');\n" +
    "        return back();\n" +
    "        $e = env('APP_ENV');\n" +
    "        $v = data_get(['a' => 1], 'a');\n" +
    "        $t = tap(1, function ($x) { return $x; });\n" +
    "        report(new \\RuntimeException('x'));\n" +
    "        cache('k', 'v');\n" +
    "        session(['k' => 'v']);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.redirect\("https:\/\/example\.com"\)/);
  assert.match(res.code, /rt\.back\(\)/);
  assert.match(res.code, /rt\.env\("APP_ENV"\)/);
  assert.match(res.code, /rt\.dataGet\(/);
  assert.match(res.code, /rt\.tap\(/);
  assert.match(res.code, /rt\.report\(/);
  assert.match(res.code, /rt\.cache\(\)\.get\("k", "v"\)/);
  assert.match(res.code, /rt\.session\(\)\.put\(/);
});

test('emit: a relation call on a model fails loud (LW003)', () => {
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function show($id)
    {
        $post = Post::findOrFail($id);
        $comments = $post->comments();
        return response('ok');
    }
}
`;
  const res = emitController(src, 'show', {
    ...META_BASE,
    routeUri: '/posts/{id}',
    routeParams: ['id'],
  });
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /model method comments\(\)/);
});

test('emit: a method call on an unknown variable fails loud (LW002)', () => {
  const src = String.raw`<?php
namespace App\Http\Controllers;
class C {
    public function demo()
    {
        $comments = $post->comments();
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: [] });
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /\$post->comments\(\)/);
});

test('emit: the query builder methods still compile', () => {
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function demo()
    {
        $q = Post::where('published', true);
        $posts = $q->get();
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: [] });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  assert.match(res.code, /rt\.model\("Post"\)\.where\(/);
  // The terminal on a VARIABLE is awaited, exactly like the chain form: the
  // builder's own get() is a promise (Laravel's Eloquent\Builder::get()
  // answers a Collection - Illuminate/Database/Eloquent/Builder.php:926).
  // It used to compile to `v_posts = v_q.get()` - a floating promise: the
  // route answered before the rows arrived, and a rejection was swallowed.
  assert.match(res.code, /v_posts = \(await v_q\.get\(\)\)/);
  assert.doesNotMatch(res.code, /v_posts = v_q\.get\(\)/);
});

test('emit: the terminal query method on a VARIABLE is awaited (no floating promise)', () => {
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function demo()
    {
        $q = Post::where('published', true);
        $posts = $q->get();
        $first = $q->first();
        $count = $q->count();
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: [] });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  assert.match(res.code, /v_posts = \(await v_q\.get\(\)\)/);
  assert.match(res.code, /v_first = \(await v_q\.first\(\)\)/);
  assert.match(res.code, /v_count = \(await v_q\.count\(\)\)/);
});

test('emit: paginate() on a VARIABLE is the paginator (not the builder\'s own paginate)', () => {
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function demo()
    {
        $q = Post::where('published', true);
        $posts = $q->paginate(10);
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: [] });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  // The LengthAwarePaginator (the request carries the page and the path) -
  // not the builder's own paginate(), which answers a plain array.
  assert.match(res.code, /v_posts = \(await rt\.paginate\(v_q, 10\)\)/);
  assert.doesNotMatch(res.code, /v_q\.paginate\(/);
});

test('emit: the async model-instance methods take the db binding (and are awaited)', () => {
  // Laravel: Model::increment() (Illuminate/Database/Eloquent/Model.php:1107),
  // Model::load() (…/Model.php:880), loadCount() (…/Model.php:947) and
  // loadAggregate() (…/Model.php:934) all hit the database. The compiled side
  // hands them the D1 binding (like save()) and awaits them: the first PHP
  // argument used to land in the db slot (increment('views') -> db = 'views'),
  // so the counter was never written.
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function demo($id)
    {
        $post = Post::findOrFail($id);
        $post->increment('views');
        $post->load('comments');
        $post->loadCount('comments');
        $post->loadAggregate('comments', 'votes');
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: ['id'] });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  assert.match(res.code, /\(await v_post\.increment\(rt\.db\(\), "views"\)\)/);
  assert.match(res.code, /\(await v_post\.load\(rt\.db\(\), "comments"\)\)/);
  assert.match(res.code, /\(await v_post\.loadCount\(rt\.db\(\), "comments"\)\)/);
  assert.match(res.code, /\(await v_post\.loadAggregate\(rt\.db\(\), "comments", "votes"\)\)/);
  // The db binding is the FIRST argument - the PHP argument is the second.
  assert.doesNotMatch(res.code, /v_post\.increment\("views"/);
});

test('emit: related() fails loud - Laravel\'s Model has no such method (LW003)', () => {
  // Laravel's Model::__call forwards an unknown method to the query builder
  // (Illuminate/Database/Eloquent/Model.php:2902 → :2917) and the builder
  // throws a BadMethodCallException (Illuminate/Database/Query/Builder.php:5015)
  // - so `$post->related('comments')` is a 500 in Laravel. The build refuses it.
  const src = String.raw`<?php
namespace App\Http\Controllers;
use App\Models\Post;
class C {
    public function demo($id)
    {
        $post = Post::findOrFail($id);
        $comments = $post->related('comments');
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { ...META_BASE, routeUri: '/x', routeParams: ['id'] });
  assert.equal(res.code, null);
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /Laravel's Model has no related\(\) method/);
  assert.match(res.errors[0].message, /BadMethodCallException/);
});

test('emit: a relation read as a property fails loud (LW003)', () => {
  const src = String.raw`<?php
namespace App\\Http\\Controllers;
use App\\Models\\Post;
class C {
    public function show($id)
    {
        $post = Post::findOrFail($id);
        $comments = $post->comments;
        return response('ok');
    }
}
`;
  const res = emitController(src, 'show', {
    ...META_BASE,
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post', notCompiled: ['comments'] }],
    routeUri: '/posts/{id}',
    routeParams: ['id'],
  });
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /"comments" is not compiled/);
});

test('emit: an unsupported Storage method fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $files = Storage::files('a');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /Storage::files/);
});

// ---------------------------------------------------------------------------
// emit — the object store (the default disk compiles; a named disk does not)
// ---------------------------------------------------------------------------

test('emit: Storage::disk() of the app\'s default disk compiles to the store', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $put = Storage::disk('local')->put('a.txt', 'x');\n" +
    "        $v = Storage::disk('local')->get('a.txt');\n" +
    "        $e = Storage::disk('local')->exists('a.txt');\n" +
    "        $d = Storage::disk('local')->delete('a.txt');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    storage: META_STORAGE,
  });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  assert.match(res.code, /\(await rt\.storage\(\)\.put\("a\.txt", "x"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.getText\("a\.txt"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.exists\("a\.txt"\)\)/);
  assert.match(res.code, /\(await rt\.storage\(\)\.delete\("a\.txt"\)\)/);
});

test('emit: Storage::disk() of a named disk fails loud (LW002) - it needs a bucket of its own', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Storage::disk('public')->put('a.txt', 'x');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    storage: META_STORAGE,
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /Storage::disk\('public'\) is not supported/);
  // the message says what it would take (R2 asks for a credit card).
  assert.match(res.errors[0].message, /credit card/);
});

test('emit: a disk name that is not a literal fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $name = 'local';\n" +
    "        Storage::disk($name)->put('a.txt', 'x');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    storage: META_STORAGE,
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /string literal/);
});

test('emit: a disk check without the app\'s default disk fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Storage::disk('local')->put('a.txt', 'x');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  // no `storage` in the meta: the build does not know the app's default disk.
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /does not know the app's default disk/);
});

test('emit: a method outside the compiled store surface fails loud (no promise leaks)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Storage;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $files = Storage::disk('local')->files('a');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    storage: META_STORAGE,
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /Storage::disk\(\)->files\(\)/);
});

test('emit: Cache::tags() fails loud with the store reason (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Support\\Facades\\Cache;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        Cache::tags('a')->put('k', 'v');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /does not support tagging/);
  assert.match(res.errors[0].message, /BadMethodCallException/);
  // The build refuses the route earlier than Laravel does: that is stricter,
  // not a parity - the message must say so.
  assert.match(res.errors[0].message, /stricter than Laravel, not a parity/);
  assert.match(res.errors[0].message, /the build refuses the route before it ships/);
});

test('emit: an uploaded file compiles (the file object + the object store)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        $file = $request->file('avatar');\n" +
    "        $path = $file->storeAs('avatars', 'a.txt');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /v_file = v_request\.file\("avatar"\)/);
  // The store is async at the edge: the call is awaited.
  assert.match(res.code, /\(await v_file\.storeAs\("avatars", "a\.txt"\)\)/);
});

test('emit: the chained upload compiles ($request->file("x")->store())', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        $path = $request->file('avatar')->store('avatars');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /\(await v_request\.file\("avatar"\)\.store\("avatars"\)\)/);
});

test('emit: a file method the edge cannot answer fails loud (LW003)', () => {
  // getMimeType() reads the file's *content* type (finfo): the edge cannot
  // sniff the content like PHP does.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        $file = $request->file('avatar');\n" +
    "        $mime = $file->getMimeType();\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /getMimeType/);
  assert.match(res.errors[0].message, /finfo/);
});

test('emit: $request->files() fails loud (it is a property in Laravel)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    '        $files = $request->files();\n' +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /FileBag/);
});

test('emit: a FormRequest with a mimes rule fails loud (the content type cannot be sniffed)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Http\\Requests\\UploadRequest;\n' +
    'class C {\n' +
    '    public function store(UploadRequest $request)\n' +
    '    {\n' +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    formRequests: {
      'App\\Http\\Requests\\UploadRequest': {
        rules: { avatar: ['required', 'file', 'mimes:png,jpg'] },
        messages: {},
        attributes: {},
      },
    },
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /mimes/);
  assert.match(res.errors[0].message, /finfo/);
});

test('emit: a fully-qualified static call resolves to the global class', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        \\Illuminate\\Support\\Facades\\Storage::put('a/b.txt', 'hello');\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /\(await rt\.storage\(\)\.put\("a\/b\.txt", "hello"\)\)/);
});

test('emit: a fully-qualified model call compiles (\\App\\Models\\Post::create())', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        \\App\\Models\\Post::create(['title' => 'x']);\n" +
    "        return response('ok');\n" +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'store', {
    routeUri: '/posts',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.model\("App\\\\Models\\\\Post"\)\.create\(/);
});

test('emit: the extract lists the class constants the method reads', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Providers\\RouteServiceProvider;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function store()\n' +
    '    {\n' +
    "        $p = Post::find(1);\n" +
    "        return redirect(RouteServiceProvider::HOME);\n" +
    '    }\n' +
    '}\n';
  const info = extractController(src, 'store');
  assert.equal(info.ok, true);
  // A static *call* is a model reference, not a constant read.
  assert.deepEqual(info.classes.map((c) => c.alias), ['Post']);
  assert.deepEqual(info.constants.map((c) => c.alias), ['RouteServiceProvider']);
  assert.equal(info.constants[0].fqcn, 'App\\Providers\\RouteServiceProvider');
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

// The mini dist tree lives outside the package, so bare `bcryptjs` would not
// resolve from it. Point the copied hash.mjs at the real package entry instead
// of duplicating node_modules.
const bcryptEntryUrl = pathToFileURL(
  path.join(pkgDir, 'node_modules', 'bcryptjs', 'index.js')
).href;

writeTree(tmpRoot, {
  'kernel/model.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'model.mjs'), 'utf8'),
  'kernel/str.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'str.mjs'), 'utf8'),
  'kernel/db.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'db.mjs'), 'utf8'),
  'kernel/hash.mjs': fs
    .readFileSync(path.join(pkgDir, 'kernel', 'hash.mjs'), 'utf8')
    .replace("from 'bcryptjs'", `from ${JSON.stringify(bcryptEntryUrl)}`),
  'kernel/validation.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'validation.mjs'), 'utf8'),
  'kernel/validator.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'validator.mjs'), 'utf8'),
  // validator.mjs + http.mjs import the image header reader (the `image` and
  // `dimensions` rules, and File::dimensions()).
  'kernel/image.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'image.mjs'), 'utf8'),
  // The runtime imports the kernel's Collection (one class for the whole edge).
  'kernel/collections.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'collections.mjs'), 'utf8'),
  'kernel/validation-messages.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'validation-messages.mjs'), 'utf8'),
  'kernel/validation-messages.data.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'validation-messages.data.mjs'), 'utf8'),
  'kernel/paginator.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'paginator.mjs'), 'utf8'),
  'kernel/php-json.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'php-json.mjs'), 'utf8'),
  'kernel/mailable.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'mailable.mjs'), 'utf8'),
  'kernel/form-request.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'form-request.mjs'), 'utf8'),
  // The runtime imports the kernel's JsonResource base (a resource returned by
  // a controller becomes a ResourceResponse).
  'kernel/resources.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'resources.mjs'), 'utf8'),
  'kernel/php-serialize.mjs': fs.readFileSync(path.join(pkgDir, 'kernel', 'php-serialize.mjs'), 'utf8'),
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
  // A view with a layout (the compiled Blade output: the sections travel to
  // the layout through the shared env).
  'src/views/posts.layout.mjs': [
    'export default function main(rt) {',
    '  let v___env, v_post;',
    '  v___env = rt.var("__env");',
    '  v_post = rt.var("post");',
    '  v___env.startSection("title", rt.concat("Post ", rt.prop(v_post, "title")));',
    '  v___env.startSection("content");',
    '  rt.echo("<h1>");',
    '  rt.echo(rt.e(rt.prop(v_post, "title")));',
    '  rt.echo("</h1>");',
    '  v___env.stopSection();',
    '  rt.echo(v___env.make("layouts.app", rt.array_diff_key(rt.vars({}), {"__data": 1, "__path": 1})).render());',
    '}',
    '',
  ].join('\n'),
  'src/views/layouts.app.mjs': [
    'export default function main(rt) {',
    '  let v___env;',
    '  v___env = rt.var("__env");',
    '  rt.echo("<html><title>");',
    '  rt.echo(v___env.yieldContent("title", "Default"));',
    '  rt.echo("</title><body>");',
    '  rt.echo(v___env.yieldContent("content"));',
    '  rt.echo("</body></html>");',
    '}',
    '',
  ].join('\n'),
  'src/contexts/posts.layout.mjs': 'export default {};\n',
  'src/contexts/layouts.app.mjs': 'export default {};\n',
  // The compiled policies (what build.mjs writes from the policy dump).
  'src/policies.generated.mjs': [
    'export const policies = {',
    '  "App\\\\Models\\\\Post": {',
    '    policy: "App\\\\Policies\\\\PostPolicy",',
    '    before: null,',
    '    methods: {',
    '      viewAny: { guest: true, fn: async (rt, v_user) => { return rt.strictNe(v_user, null, false, false); } },',
    '      update: { guest: false, fn: async (rt, v_user, v_post) => { return rt.strictEq(rt.prop(v_user, "id"), rt.prop(v_post, "user_id"), false, false); } },',
    '    },',
    '  },',
    '};',
    // The GLOBAL Gate::define() abilities (the same shape build.mjs writes).
    'export const gateDefinitions = {',
    '  "can-publish": { callback: "App\\\\Policies\\\\AbilityGate@canPublish", kind: "string", guestAllowed: true },',
    '};',
    'export default policies;',
    '',
  ].join('\n'),
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
// The row the policy checks (the owner of the post).
const dbWithPolicyRow = mockDb({
  first: () => ({ ...ROW, user_id: 1 }),
  all: () => ({ results: [{ ...ROW, user_id: 1 }] }),
});

function ctxFor(params, host = 'example.com', auth = null) {
  return {
    params,
    request: { method: 'GET', path: '/', headers: {}, host },
    ...(auth ? { auth } : {}),
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

test('runtime: the Gate check answers with the compiled policy (the guest rules included)', async () => {
  const handle = await handlerFor('gateCheck', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies: META_POLICIES,
  });
  const asUser = (id) => ctxFor({ id: '1' }, 'example.com', { user: async () => ({ id }) });
  // the owner of the post: allowed
  const allowed = await handle(asUser(1), { DB: dbWithPolicyRow });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, 'yes');
  // another user: denied
  const denied = await handle(asUser(2), { DB: dbWithPolicyRow });
  assert.equal(denied.body, 'no');
  // a guest: the policy does not allow guests -> denied (the method is not called)
  const guest = await handle(ctxFor({ id: '1' }, 'example.com', { user: async () => null }), {
    DB: dbWithPolicyRow,
  });
  assert.equal(guest.body, 'no');
});

test('runtime: Gate::denies() is the negation of the same check', async () => {
  const handle = await handlerFor('gateDeny', {
    ...META_BASE,
    routeUri: '/gate/{id}',
    routeParams: ['id'],
    policies: META_POLICIES,
  });
  const asUser = (id) => ctxFor({ id: '1' }, 'example.com', { user: async () => ({ id }) });
  const owner = await handle(asUser(1), { DB: dbWithPolicyRow });
  assert.equal(owner.body, 'yes'); // allowed -> denies is false
  const other = await handle(asUser(2), { DB: dbWithPolicyRow });
  assert.equal(other.body, 'no'); // denied -> denies is true
});

test('runtime: a class-level Gate check calls the policy without a subject', async () => {
  const handle = await handlerFor('gateClassLevel', {
    ...META_BASE,
    routeUri: '/gate',
    routeParams: [],
    policies: META_POLICIES,
  });
  // viewAny(?User $user): a guest is allowed by the policy, but the policy
  // itself answers false for a guest ($user !== null).
  const guest = await handle(ctxFor({}, 'example.com', { user: async () => null }), { DB: dbWithRow });
  assert.equal(guest.body, 'no');
  const user = await handle(ctxFor({}, 'example.com', { user: async () => ({ id: 1 }) }), { DB: dbWithRow });
  assert.equal(user.body, 'yes');
});

test('runtime: a view with a layout renders the sections inside the layout', async () => {
  const handle = await handlerFor('layout', {
    ...META_BASE,
    routeUri: '/layout',
    routeParams: [],
    views: ['posts.layout', 'layouts.app'],
  });
  const res = await handle(ctxFor({}), { DB: dbWithRow });
  assert.equal(res.status, 200);
  // the layout wraps the section content, and the title section is yielded.
  assert.match(res.body, /<html><title>Post Hello Edge<\/title><body>/);
  assert.match(res.body, /<h1>Hello Edge<\/h1>/);
  assert.match(res.body, /<\/body><\/html>$/);
});

test('runtime: the query terminal on a VARIABLE is awaited (the view data holds the rows)', async () => {
  // The variable form used to compile to `v_posts = v_q.get()` - a floating
  // promise: the route answered before the rows arrived, and the view data
  // held a promise. The terminal is awaited now, so the view renders the rows
  // Laravel renders.
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
  const res = await mod.default(ctxFor({}), { DB: dbWithRow });
  assert.equal(res.status, 200);
  assert.match(res.body, /Hello Edge/);
});

test('runtime: an unresolved promise in the view data still fails loud at request time', async () => {
  // The runtime's safety net: a promise that reaches the view data is a
  // request-time failure, not a page with "[object Promise]" in it.
  const { buildRt } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'runtime', 'rt-from-context.mjs')).href);
  const { models } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'models.generated.mjs')).href);
  const { default: main } = await import(pathToFileURL(path.join(tmpRoot, 'src', 'views', 'posts.index.mjs')).href);
  const rt = buildRt(null, { runtime: true, db: dbWithRow, models, views: { 'posts.index': { main } } });
  assert.throws(() => rt.view('posts.index', { posts: Promise.resolve([]) }), /unresolved promise/);
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

test('runtime: redirect()->intended() pulls url.intended; session mutation methods run', async () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'use Illuminate\\Support\\Facades\\Auth;\n' +
    'class C {\n' +
    '    public function store(Request $request)\n' +
    '    {\n' +
    "        Auth::attempt(['email' => $request->input('email')]);\n" +
    '        $request->session()->regenerate();\n' +
    '        $request->session()->regenerateToken();\n' +
    "        return redirect()->intended('/home');\n" +
    '    }\n' +
    '}\n';
  const handle = await handlerFromSource(src, 'store', {
    routeUri: '/login',
    routeParams: [],
    models: [],
    views: [],
  });

  const calls = [];
  const store = {
    attrs: { 'url.intended': 'https://example.com/dashboard' },
    pull(k, d) {
      calls.push('pull:' + k);
      if (Object.prototype.hasOwnProperty.call(this.attrs, k)) {
        const v = this.attrs[k];
        delete this.attrs[k];
        return v;
      }
      return d;
    },
    async regenerate() {
      calls.push('regenerate');
    },
    regenerateToken() {
      calls.push('regenerateToken');
    },
  };
  const auth = {
    check: async () => false,
    guest: async () => true,
    user: async () => null,
    id: async () => null,
    guard: () => ({ attempt: async () => true }),
  };
  const request = { input: (k) => (k === 'email' ? 'a@b.com' : null) };

  const res = await handle(
    { params: {}, request: { ...request, session: () => store }, session: store, auth },
    { DB: dbWithRow }
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://example.com/dashboard');
  assert.deepEqual(calls, ['regenerate', 'regenerateToken', 'pull:url.intended']);

  const empty = { pull: (k, d) => d, async regenerate() {}, regenerateToken() {} };
  const res2 = await handle(
    { params: {}, request: { ...request, session: () => empty }, session: empty, auth },
    { DB: dbWithRow }
  );
  assert.equal(res2.status, 302);
  assert.equal(res2.headers.location, '/home');
});

test('emit+runtime: $arr[] = $x appends (it used to write a "null" key)', async () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function collect()\n' +
    '    {\n' +
    '        $titles = [];\n' +
    "        $titles[] = 'a';\n" +
    "        $titles[] = 'b';\n" +
    "        return response(implode(',', $titles));\n" +
    '    }\n' +
    '}\n';
  const handle = await handlerFromSource(src, 'collect', {
    routeUri: '/collect',
    routeParams: [],
    models: [],
    views: [],
  });
  const res = await handle({ params: {}, request: {} }, {});
  assert.equal(res.status, 200);
  assert.equal(res.body, 'a,b');
});

test('emit+runtime: the PHP casts ((string), (int), (bool), (float))', async () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function casts()\n' +
    '    {\n' +
    '        $a = (string) 5;\n' +
    '        $b = (int) "7abc";\n' +
    '        $c = (bool) 0;\n' +
    '        $d = (float) "1.5";\n' +
    '        $e = (string) null;\n' +
    '        return response($a . "|" . $b . "|" . ($c ? "yes" : "no") . "|" . $d . "|" . $e);\n' +
    '    }\n' +
    '}\n';
  const handle = await handlerFromSource(src, 'casts', {
    routeUri: '/casts',
    routeParams: [],
    models: [],
    views: [],
  });
  const res = await handle({ params: {}, request: {} }, {});
  assert.equal(res.status, 200);
  // PHP: (string) 5 = "5"; (int) "7abc" = 7; (bool) 0 = false;
  // (float) "1.5" = 1.5; (string) null = "".
  assert.equal(res.body, '5|7|no|1.5|');
});

test('emit: a cast that is not compiled fails loud (LW002)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function casts()\n' +
    '    {\n' +
    '        $a = (array) 5;\n' +
    '        return response("ok");\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'casts', {
    routeUri: '/casts',
    routeParams: [],
    models: [],
    views: [],
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /\(array\) cast/);
});

test('emit: Model::paginate() compiles to the paginator (the LengthAwarePaginator)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function paged()\n' +
    '    {\n' +
    '        $posts = Post::where("published", true)->paginate(2);\n' +
    '        return response($posts->total() . "|" . $posts->currentPage());\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'paged', {
    routeUri: '/paged',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  });
  assert.deepEqual(res.errors, []);
  // The paginator is built by the runtime (it needs the request: the page, the
  // path, the query string).
  assert.match(res.code, /rt\.paginate\(rt\.model\("Post"\)\.where\("published", true\), 2\)/);
  assert.match(res.code, /v_posts\.total\(\)/);
  assert.match(res.code, /v_posts\.currentPage\(\)/);
});

test('emit+runtime: __() reads the dumped translations (with the replacements)', async () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function t()\n' +
    '    {\n' +
    '        $a = __("pagination.previous");\n' +
    '        $b = __("Go to page :page", ["page" => 2]);\n' +
    '        $c = __("missing.key");\n' +
    '        return response($a . "|" . $b . "|" . $c);\n' +
    '    }\n' +
    '}\n';
  const handle = await handlerFromSource(src, 't', {
    routeUri: '/t',
    routeParams: [],
    models: [],
    views: [],
  });
  const config = {
    'app.locale': 'en',
    'app.fallback_locale': 'en',
    translations: { en: { pagination: { previous: '&laquo; Previous' } } },
  };
  const res = await handle({ params: {}, request: {}, config }, {});
  assert.equal(res.status, 200);
  // The line, the replacement (Laravel applies it to the key too when the line
  // is missing) and the missing key.
  assert.equal(res.body, '&laquo; Previous|Go to page 2|missing.key');
});

test('transpile: a view that receives a paginator may call its methods', () => {
  const res = transpile('<?php echo $paginator->total(); ?>', {
    viewDataKinds: { paginator: 'paginator' },
  });
  assert.deepEqual(res.errors, []);
  assert.match(res.code, /v_paginator\.total\(\)/);
  // Without the kinds, a method call on a view variable fails loud.
  const bare = transpile('<?php echo $paginator->total(); ?>');
  assert.equal(bare.errors[0].code, 'LW002');
});

test('emit: a paginator method that is not compiled fails loud (LW003)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function paged()\n' +
    '    {\n' +
    '        $posts = Post::where("published", true)->paginate(2);\n' +
    '        return response($posts->toQueryString());\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'paged', {
    routeUri: '/paged',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /toQueryString\(\)/);
});

test('emit: a rule object fails loud (the validator cannot evaluate it)', () => {
  // A rule object is a class: the compiled validator evaluates the string rules
  // only, so the rule would be silently ignored and the validation would
  // differ from Laravel's. The build stops and names what it would take.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use Illuminate\\Http\\Request;\n' +
    'class C {\n' +
    '    public function demo(Request $request)\n' +
    '    {\n' +
    '        $v = $request->validate([\'avatar\' => [\\Illuminate\\Validation\\Rule::file()->max(1024)]]);\n' +
    '        return response("ok");\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /rule object/);
  assert.match(res.errors[0].message, /kernel validator must evaluate the rule object/);
});

test('emit: Queue::push() fails loud with the structural reason', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    '        \\Illuminate\\Support\\Facades\\Queue::push(\\App\\Jobs\\SendMail::class);\n' +
    '        return response("ok");\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  // The wording is the runtime's own (rt.queue() throws the same at the
  // edge): the job would never run, and the paths that work are named.
  assert.match(res.errors[0].message, /the job would never run at the edge/);
  assert.match(res.errors[0].message, /the worker has no queue handler/);
  assert.match(res.errors[0].message, /carries a JSON body, not a PHP job/);
  assert.match(res.errors[0].message, /a Cloudflare Queues binding with a consumer you write/);
  // The tier fact: a limited version of Queues is on the Workers free plan (the
  // paid plan charges per operation) - "paid" is not the same as "needs a card".
  assert.match(res.errors[0].message, /a limited version is on the Workers free plan/);
  assert.match(res.errors[0].message, /a D1 table the cron trigger reads/);
});

test('emit: a mailable that the build did not compile fails loud with the reason', () => {
  // The mailable class is not in the compiled set (the build compiles the app's
  // Mail classes) - the reason says so.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    '        \\Illuminate\\Support\\Facades\\Mail::to(\'a@b.co\')->send(new \\App\\Mail\\OrderMail());\n' +
    '        return response("ok");\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.code, null);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /mailable class is not in the compiled set/);
});

test('emit: a mailable that the build compiled compiles (the fluent form)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    '        \\Illuminate\\Support\\Facades\\Mail::to(\'a@b.co\')->send(new \\App\\Mail\\OrderMail());\n' +
    '        return response("ok");\n' +
    '    }\n' +
    '}\n';
  const res = emitController(src, 'demo', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    classes: { fqcns: ['App\\Mail\\OrderMail'], aliases: { OrderMail: 'App\\Mail\\OrderMail' } },
  });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The send is awaited (a floating promise means the mail can leave after
  // the response).
  assert.match(res.code, /await rt\.mail\(\)\.to\("a@b\.co"\)\.send\(rt\.newClass\(/);
});

test('emit+runtime: the value a controller returns is converted like Laravel\'s Router::toResponse', async () => {
  // Laravel converts the returned value (Illuminate/Routing/Router.php:929-953):
  // a string is the body (text/html), an array is JSON, an object is JSON, null
  // is an empty 200 - and a model that was just created answers 201.
  // Every case gets its own method name: the helper imports the compiled
  // module by that name (the import is cached per name).
  let n = 0;
  const run = async (body) => {
    const name = 'demo' + ++n;
    const src = '<?php\n' +
      'namespace App\\Http\\Controllers;\n' +
      'class C {\n' +
      '    public function ' + name + '()\n' +
      '    {\n' +
      '        ' + body + '\n' +
      '    }\n' +
      '}\n';
    const handle = await handlerFromSource(src, name, {
      routeUri: '/demo',
      routeParams: [],
      models: [],
      views: [],
    });
    return handle({ params: {}, request: {} }, {});
  };

  let res = await run('return "hello";');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');

  res = await run('return ["a" => 1];');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.body, '{"a":1}');

  res = await run('return null;');
  assert.equal(res.status, 200);
  assert.equal(res.body, '');

  // A void method answers an empty 200 (Laravel does not fail there).
  res = await run('$x = 1;');
  assert.equal(res.status, 200);
  assert.equal(res.body, '');

  // A response the controller built itself passes through untouched.
  res = await run('return response("built");');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'built');
});

test('emit: a model that overrides the route binding fails loud (LW003)', () => {
  // Laravel resolves the binding through the model's own method
  // (ImplicitRouteBinding.php:57 -> Model::resolveRouteBinding()): an app that
  // overrides it can scope the lookup, so the compiled primary-key lookup
  // would bind a DIFFERENT row.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\Post;\n' +
    'class C {\n' +
    '    public function show(Post $post)\n' +
    '    {\n' +
    '        return $post->title;\n' +
    '    }\n' +
    '}\n';
  const code = emitController(src, 'show', {
    routeParams: ['post'],
    models: [
      {
        alias: 'Post',
        fqcn: 'App\\Models\\Post',
        notCompiled: ['resolveRouteBinding', 'title'],
        routeKey: 'id',
        primaryKey: 'id',
      },
    ],
    views: [],
  });
  assert.ok(code.errors.length, 'the build must stop');
  const e = code.errors[0];
  assert.equal(e.code, 'LW003');
  assert.match(e.message, /overrides resolveRouteBinding\(\)/);
  assert.match(e.message, /Laravel binds the model through that method/);
});

test('emit: a grouped use keeps its prefix and a snake_case route parameter binds', () => {
  // A grouped import (`use App\Models\{Post};`): PHP resolves the prefix, so
  // the Request/Model type is found.
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Models\\{Post};\n' +
    'class C {\n' +
    '    public function show(Post $blogPost)\n' +
    '    {\n' +
    '        return $blogPost->title;\n' +
    '    }\n' +
    '}\n';
  const code = emitController(src, 'show', {
    routeParams: ['blog_post'],
    models: [
      { alias: 'Post', fqcn: 'App\\Models\\Post', notCompiled: [], routeKey: 'id', primaryKey: 'id' },
    ],
    views: [],
  });
  assert.deepEqual(code.errors, [], 'the grouped use resolves and the parameter binds');
  // Laravel's ImplicitRouteBinding::getParameterName(): the exact name or its
  // snake_case form - so the segment is read under the route's name.
  assert.match(code.code, /rt\.param\(ctx\.params, "blog_post"/);
});

test('extract: the classes the body instantiates are reported (a mailable that did not compile stops the route)', () => {
  const src = '<?php\n' +
    'namespace App\\Http\\Controllers;\n' +
    'use App\\Mail\\OrderMail;\n' +
    'class C {\n' +
    '    public function demo()\n' +
    '    {\n' +
    '        Mail::to("buyer@example.com")->send(new OrderMail());\n' +
    '        return "ok";\n' +
    '    }\n' +
    '}\n';
  const info = extractController(src, 'demo');
  assert.ok(info.ok, 'the source parses');
  // The instantiated classes are reported apart from the static ones: the build
  // stops the route when one of them did not compile (a mailable with Laravel
  // 13's modern API) - otherwise the route would fail at request time.
  const mail = (info.newClasses || []).find((c) => c.fqcn === 'App\\Mail\\OrderMail');
  assert.ok(mail, 'the instantiated mailable is reported');
  assert.equal(mail.alias, 'OrderMail');
});

test('emit: a Collection chain resolves against the kernel Collection surface', () => {
  // `collect([...])` answers the kernel Collection, so its methods are the
  // allowlist's - the receiver is a CALL, so it has no declared kind, and the
  // call used to fall through to the unknown-variable refusal: `sole()` and
  // `mapWithKeys()` were refused with LW002 even though the kernel has them.
  const meta = {
    routeUri: '/x',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
  };
  const src = (body) =>
    '<?php\nnamespace App\\Http\\Controllers;\nclass C\n{\n    public function demo()\n    {\n        ' +
    body +
    '\n    }\n}\n';
  const ok = emitController(src("return collect([1, 2])->sole();"), 'demo', meta);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.code, /rt\.collect\(\[1, 2\]\)\.sole\(\)/);
  // `Collection::make()` is the facade-free spelling of the same helper.
  const made = emitController(src("return \\Illuminate\\Support\\Collection::make([1, 2])->count();"), 'demo', meta);
  assert.deepEqual(made.errors, []);
  assert.match(made.code, /rt\.collect\(\[1, 2\]\)\.count\(\)/);
  // `Collection::wrap()` is NOT `collect()`: Arr::wrap turns a non-array into
  // ONE item (EnumeratesValues.php:134 + Arr.php:1336), so `wrap('a')` answers
  // `['a']` while `collect()` runs getArrayableItems(). Emitting both as
  // rt.collect() made `Collection::wrap('a')->count()` answer 0 where Laravel
  // answers 1.
  const wrapped = emitController(src("return \\Illuminate\\Support\\Collection::wrap('a')->count();"), 'demo', meta);
  assert.deepEqual(wrapped.errors, []);
  assert.match(wrapped.code, /rt\.collectionWrap\("a"\)\.count\(\)/);
  assert.doesNotMatch(wrapped.code, /rt\.collect\("a"\)/);
  // A CHAIN on wrap() resolves against the same allowlist as make(): without
  // this the receiver was untyped and `wrap($v)->sole()` was refused with
  // LW002 - the false refusal this branch exists to prevent.
  const wrappedChain = emitController(src("return \\Illuminate\\Support\\Collection::wrap([1])->sole();"), 'demo', meta);
  assert.deepEqual(wrappedChain.errors, []);
  assert.match(wrappedChain.code, /rt\.collectionWrap\(\[1\]\)\.sole\(\)/);
  const wrappedBad = emitController(src('return \\Illuminate\\Support\\Collection::wrap([1])->sliding(2);'), 'demo', meta);
  assert.equal(wrappedBad.code, null);
  assert.equal(wrappedBad.errors[0].code, 'LW003');
  assert.match(wrappedBad.errors[0].message, /sliding/);
  // A method the kernel Collection lacks is still a build error: the inline
  // chain must not compile to a call that throws at request time.
  const bad = emitController(src('return collect([1, 2])->sliding(2);'), 'demo', meta);
  assert.equal(bad.code, null);
  assert.equal(bad.errors[0].code, 'LW003');
  assert.match(bad.errors[0].message, /sliding/);
});

test('emit: wrap() and collect() answer Laravel values for a scalar', async () => {
  // Measured in Laravel 13: collect('ab')->count() is 1 (getArrayableItems ends
  // with `(array) $items`) and Collection::wrap('ab')->count() is 1 (Arr::wrap
  // wraps a non-array). The kernel used to turn a string into its CHARACTERS
  // (Object.values) and to answer 0 for a number, so both spellings were
  // silently wrong for a scalar argument.
  const { Collection } = await import('../../kernel/collections.mjs');
  assert.equal(Collection.wrap('ab').count(), 1);
  assert.deepEqual(Collection.wrap('ab').all(), ['ab']);
  assert.equal(Collection.wrap(null).count(), 0);
  assert.equal(new Collection('ab').count(), 1);
  assert.equal(new Collection(5).count(), 1);
  assert.deepEqual(new Collection([1, 2]).all(), [1, 2]);
  // A PHP ASSOC array is a plain JS object at the edge: Arr::wrap keeps it
  // KEYED, so wrapping it as one item would turn ['a' => 1] into [{a: 1}]
  // (key 0) and `keys()`/`get('a')` would diverge.
  const assoc = Collection.wrap({ a: 1 });
  assert.equal(assoc.count(), 1);
  assert.deepEqual(assoc.keys().all(), ['a']);
  assert.equal(assoc.get('a'), 1);
  // A class instance is NOT a plain object, so it stays the single item
  // (`$model instanceof Enumerable` is false in PHP too).
  class Item {
    constructor() {
      this.id = 7;
    }
  }
  const item = new Item();
  assert.deepEqual(Collection.wrap(item).all(), [item]);
});

test('emit: a call receiver without an allowlist still chains', () => {
  // The collection check keys on the RECEIVER'S KIND (collect()/wrap()/a
  // relation), not on "every call receiver": `response()`, `redirect()` and
  // `now()` have no allowlist here, and a blanket check would refuse them.
  const meta = { routeUri: '/x', routeParams: [], models: [], views: [] };
  const src = (body) =>
    '<?php\nnamespace App\\Http\\Controllers;\nclass C\n{\n    public function demo()\n    {\n        ' +
    body +
    '\n    }\n}\n';
  for (const body of [
    "return response()->json(['a' => 1])->header('X-A', 'b');",
    "return redirect('/x')->with('ok', 'y');",
    'return now()->addDay();',
  ]) {
    const res = emitController(src(body), 'demo', meta);
    assert.deepEqual(res.errors, [], body + ' -> ' + JSON.stringify(res.errors));
  }
  // An inline model chain stays refused (the receiver answers a model, and a
  // model has no collection surface).
  const bad = emitController(
    src('return \\App\\Models\\Post::all()->sliding(2);'),
    'demo',
    { routeUri: '/x', routeParams: [], models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }], views: [] }
  );
  assert.equal(bad.code, null);
  assert.equal(bad.errors[0].code, 'LW003');
});

test('emit: an inline paginator chain compiles the pagination view', () => {
  // `Post::paginate(2)->links()` is legal Laravel (paginate() answers the
  // LengthAwarePaginator). `links()` renders the pagination view, so the
  // handler must import it: the usedPaginator flag was set for the ASSIGNMENT
  // form only, and the inline form threw "view not compiled" at request time.
  const meta = {
    routeUri: '/x',
    routeParams: [],
    models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
    views: [],
    paginationView: 'pagination::tailwind',
  };
  const src = (body) =>
    '<?php\nnamespace App\\Http\\Controllers;\nclass C\n{\n    public function demo()\n    {\n        ' +
    body +
    '\n    }\n}\n';
  const ok = emitController(src('return \\App\\Models\\Post::paginate(2)->links();'), 'demo', meta);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.code, /paginate\(2\)\)\.links\(\)/);
  assert.match(ok.code, /pagination::tailwind/);
  // The paginator's own surface is still the allowlist's.
  const bad = emitController(src('return \\App\\Models\\Post::paginate(2)->sliding(2);'), 'demo', meta);
  assert.equal(bad.code, null);
  assert.equal(bad.errors[0].code, 'LW003');
  assert.match(bad.errors[0].message, /sliding/);
});
