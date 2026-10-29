#!/usr/bin/env node
// shadow/fixture-app.mjs — write the Breeze-shaped fixture app the shadow
// harness replays.
//
// WHY THIS EXISTS: `shadow/scenarios/fresh-app.mjs` walks the login flow, the
// auth-guarded dashboard and the post list/detail, and its fixtures INSERT into
// a `posts` table. A vanilla `composer create-project laravel/laravel` app has
// none of that — one route (`/`), no `posts` table — so the release gate in
// `.github/workflows/publish.yml` could never pass: the harness would diff
// "route not found" against the compiled worker and the tag would never
// publish. This script turns a fresh skeleton into the app the scenario needs.
//
// Usage:
//   node shadow/fixture-app.mjs <app-dir>
//
// It only writes files (idempotent, overwrites). Run it AFTER
// `composer create-project` and BEFORE `php artisan migrate --force` (the
// migration it adds is what creates the `posts` table the fixtures insert into).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const appDir = process.argv[2] || process.env.LW_APP_ROOT;
if (!appDir) {
  console.error('shadow/fixture-app.mjs: pass the app directory (node shadow/fixture-app.mjs <app-dir>)');
  process.exit(2);
}
// Accept the shell's native form on each platform: a Git-Bash/MSYS `/c/Users/...`
// path is not a Windows path (resolve would make it `C:\c\Users\...`).
let arg = String(appDir);
if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(arg)) {
  arg = `${arg[1].toUpperCase()}:${arg.slice(2)}`;
}
const root = resolve(arg);
if (!existsSync(join(root, 'artisan'))) {
  console.error(`shadow/fixture-app.mjs: ${root} is not a Laravel app (no artisan)`);
  process.exit(2);
}

// The files below are the fixture app verbatim: the app the shadow harness is
// developed against (routes/web.php, the two controllers, the auth controller,
// the Post model, the posts migration and the three views).
const FILES = {
  'routes/web.php': `<?php

use App\\Http\\Controllers\\Auth\\LoginController;
use App\\Http\\Controllers\\DashboardController;
use App\\Http\\Controllers\\PostController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::get('/posts', [PostController::class, 'index'])->name('posts.index');
Route::get('/posts/{post}', [PostController::class, 'show'])->name('posts.show');
// The API surface: a resource that NESTS other resources (the encoder path),
// and json_encode() of a resource (no ResourceResponse wrapper).
Route::get('/posts/{post}/resource', [PostController::class, 'resource'])->name('posts.resource');
Route::get('/posts/{post}/json', [PostController::class, 'json'])->name('posts.json');

Route::get('/login', [LoginController::class, 'create'])->name('login');
Route::post('/login', [LoginController::class, 'store'])->middleware(['guest', 'throttle:5,1']);
Route::post('/logout', [LoginController::class, 'destroy'])->middleware('auth')->name('logout');

Route::get('/dashboard', [DashboardController::class, 'index'])->middleware('auth')->name('dashboard');
`,

  'app/Http/Controllers/Auth/LoginController.php': `<?php

namespace App\\Http\\Controllers\\Auth;

use App\\Http\\Controllers\\Controller;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Auth;
use Illuminate\\Validation\\ValidationException;

class LoginController extends Controller
{
    public function create()
    {
        return view('auth.login');
    }

    public function store(Request $request)
    {
        $credentials = $request->validate([
            'email' => ['required', 'string', 'email'],
            'password' => ['required', 'string'],
        ]);

        if (! Auth::attempt($credentials, $request->boolean('remember'))) {
            throw ValidationException::withMessages([
                'email' => 'These credentials do not match our records.',
            ]);
        }

        $request->session()->regenerate();

        return redirect()->intended('/dashboard');
    }

    public function destroy(Request $request)
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect('/');
    }
}
`,

  'app/Http/Controllers/DashboardController.php': `<?php

namespace App\\Http\\Controllers;

use Illuminate\\Support\\Facades\\Auth;

class DashboardController extends Controller
{
    public function index()
    {
        return response()->json(['user' => Auth::id()]);
    }
}
`,

  'app/Http/Controllers/PostController.php': `<?php

namespace App\\Http\\Controllers;

use App\\Http\\Resources\\PostResource;
use App\\Http\\Resources\\SlimPostResource;
use App\\Models\\Post;

class PostController extends Controller
{
    public function index()
    {
        $posts = Post::where('published', true)->orderByDesc('created_at')->get();

        return view('posts.index', compact('posts'));
    }

    public function show(string $id)
    {
        $post = Post::findOrFail($id);

        return view('posts.show', ['post' => $post]);
    }
    public function resource(string $id)
    {
        $post = Post::findOrFail($id);
        return new PostResource($post);
    }
    public function json(string $id)
    {
        $post = Post::findOrFail($id);
        return response()->json(new SlimPostResource($post));
    }
}
`,

  'app/Http/Resources/PostResource.php': `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class PostResource extends JsonResource
{
    public function toArray(Request $request)
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'path' => $request->path(),
            'nested' => new SlimPostResource($this->resource),
            'items' => [new SlimPostResource($this->resource), new SlimPostResource($this->resource)],
            'query' => $request->query('probe'),
        ];
    }
}
`,
  'app/Http/Resources/SlimPostResource.php': `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class SlimPostResource extends JsonResource
{
    public function toArray(Request $request)
    {
        return ['id' => $this->id, 'probe' => $request->query('probe')];
    }
}
`,
  'app/Models/Post.php': `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Post extends Model
{
    protected $fillable = ['title', 'body', 'published'];

    protected $casts = [
        'published' => 'bool',
    ];
}
`,

  'database/migrations/2026_10_18_000001_create_posts_table.php': `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->text('body');
            $table->boolean('published')->default(false);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('posts');
    }
};
`,

  'resources/views/auth/login.blade.php': `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Log in</title></head>
<body>
<form method="POST" action="/login">
    <input type="email" name="email" value="">
    <input type="password" name="password">
    <button type="submit">Log in</button>
</form>
</body>
</html>
`,

  'resources/views/posts/index.blade.php': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Posts</title>
</head>
<body>
    <h1>Posts</h1>
    <ul>
        @foreach ($posts as $post)
            <li><a href="/posts/{{ $post->id }}">{{ $post->title }}</a></li>
        @endforeach
    </ul>
</body>
</html>
`,

  'resources/views/posts/show.blade.php': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>{{ $post->title }}</title>
</head>
<body>
    <h1>{{ $post->title }}</h1>
    <div>{{ $post->body }}</div>
</body>
</html>
`,

  // The skeleton's welcome view needs Vite (`@vite(...)` throws without a built
  // manifest), and the shadow step runs no `npm run build`. The fixture app
  // ships a view with no asset dependency instead.
  'resources/views/welcome.blade.php': `<!DOCTYPE html>
<html>
<head><title>{{ config('app.name', 'Laravel') }}</title></head>
<body><h1>{{ $pageTitle ?? 'Welcome' }}</h1></body>
</html>
`,
};

for (const [rel, body] of Object.entries(FILES)) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
}
console.log(`shadow/fixture-app.mjs: wrote ${Object.keys(FILES).length} files into ${root}`);
