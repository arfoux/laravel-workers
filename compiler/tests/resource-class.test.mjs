// compiler/tests/resource-class.test.mjs — an API resource compiles and the
// runtime answers Laravel's ResourceResponse.
//
// Laravel: a controller answers `new PostResource($post)`, the Router's
// prepareResponse() wraps it in a ResourceResponse, and the body is
// `{"data": {...}, ...with()}` (JsonResource::toArray + the `$wrap` key,
// ResourceResponse.php:31-52). The app's resource declares only toArray() and
// with($request); the rest is inherited from JsonResource, so the compiled
// class must extend the kernel's base and the runtime must hand it the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileClasses } from '../src/classes.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

const OPTIONS = {
  modelAliases: new Set(),
  modelNotCompiled: new Map(),
  modelClassFqcns: {},
  classes: new Set(),
};

const SOURCE = `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class PostResource extends JsonResource
{
    public static $wrap = 'data';

    public function toArray(Request $request): array
    {
        return ['id' => $this->id, 'slug' => 'post-' . $this->id];
    }

    public function with(Request $request): array
    {
        return ['meta' => ['version' => 1]];
    }
}
`;

function compile(source = SOURCE, name = 'PostResource', opts = OPTIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-resource-'));
  const file = join(dir, name + '.php');
  writeFileSync(file, source, 'utf8');
  return compileClasses(
    { events: {}, classes: { ['App\\Http\\Resources\\' + name]: { file, kind: 'resource' } } },
    opts
  );
}

test('resource: the compiled class extends the kernel base and takes the request', async () => {
  const res = compile();
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /base: "resource"/);
  const dir = mkdtempSync(join(tmpdir(), 'lw-resource-mod-'));
  const mod = join(dir, 'classes.generated.mjs');
  writeFileSync(mod, res.code, 'utf8');
  const classes = (await import(pathToFileURL(mod).href)).classes;

  // The request the resource's toArray($request) receives (the runtime reads
  // it from the live HTTP context, exactly like every other request helper).
  const request = { input: () => undefined, all: () => ({}), header: () => null };
  const rt = buildRt({}, { http: { request }, classes });
  const resource = rt.newClass('App\\Http\\Resources\\PostResource', [{ id: 7 }]);
  // The body the app wrote runs against the wrapped model ($this->id).
  const answer = rt.toResponse(resource);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'application/json');
  // Laravel's body: the `data` wrapper (the `$wrap` key) and the with() keys.
  assert.equal(answer.body, '{"data":{"id":7,"slug":"post-7"},"meta":{"version":1}}');
});

test('resource: a body that needs an await fails loud (the response path is synchronous)', () => {
  const res = compile(
    `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class AwaitingResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return ['id' => \\App\\Models\\Post::find(1)->id];
    }
}
`,
    'AwaitingResource',
    // The model is a compiled one, so `Post::find(1)` transpiles to an AWAITED
    // call - the body needs an await, which a resource cannot have.
    { ...OPTIONS, modelAliases: new Set(['App\\Models\\Post']) }
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /needs an await/);
});

test('resource: a service in toArray() still fails loud', () => {
  const res = compile(
    `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
use App\\Services\\Report;
class ServiceResource extends JsonResource
{
    public function toArray(Request $request, Report $report): array
    {
        return ['id' => $this->id];
    }
}
`,
    'ServiceResource'
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /cannot inject a service/);
});
test('resource: toArray($request) may use the request surface', async () => {
  // The request a resource's toArray() receives is the LIVE one (the kernel's
  // JsonResource::resolve($request) -> toArray($request)), so the allowed
  // request surface compiles inside the resource. Before the parameter was
  // registered as a request variable every such call failed loud
  // ("the method call $request->path() is not compiled") and the whole route
  // fell back to a port.
  const res = compile(
    `<?php
namespace App\\Http\\Resources;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class ProbeResource extends JsonResource
{
    public function toArray(Request $request)
    {
        return ['id' => $this->id, 'path' => $request->path(), 'probe' => $request->query('probe')];
    }
}
`,
    'ProbeResource'
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  const dir = mkdtempSync(join(tmpdir(), 'lw-resource-probe-'));
  const mod = join(dir, 'classes.generated.mjs');
  writeFileSync(mod, res.code, 'utf8');
  const classes = (await import(pathToFileURL(mod).href)).classes;
  const request = {
    input: () => undefined,
    all: () => ({}),
    header: () => null,
    path: () => 'posts/1/resource',
    query: (key) => (key === 'probe' ? 'hello' : null),
  };
  const rt = buildRt({}, { http: { request }, classes });
  const resource = rt.newClass('App\\Http\\Resources\\ProbeResource', [{ id: 3 }]);
  assert.equal(
    rt.toResponse(resource).body,
    // PHP escapes `/` as `\/` (the kernel's phpJsonEncode is byte-compatible).
    '{"data":{"id":3,"path":"posts\\/1\\/resource","probe":"hello"}}'
  );
});
