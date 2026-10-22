// compiler/tests/model-accessor.test.mjs — an Eloquent accessor compiles.
//
// Laravel: `$post->headline` goes through HasAttributes::getAttributeValue ->
// transformModelValue, which calls the app's own `getHeadlineAttribute($value)`
// with the raw attribute (HasAttributes.php:527-560). The compiled rung used to
// refuse the read; now the build compiles the accessor body and attaches it to
// the generated model class, and the kernel's Model::get() calls it with the
// runtime (the compiled body reads `rt.prop(this, ...)`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileOneMethod } from '../src/classes.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

const SOURCE = `<?php
namespace App\\Models;
class Post
{
    public function getHeadlineAttribute($value): string
    {
        return strtoupper($this->title) . ' / ' . strlen((string) $this->body);
    }
}
`;

test('model-accessor: the body compiles to a SYNCHRONOUS function (rt, value)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-accessor-'));
  const file = join(dir, 'Post.php');
  writeFileSync(file, SOURCE, 'utf8');
  const res = compileOneMethod('App\\Models\\Post', file, 'getHeadlineAttribute', {});
  assert.equal(res.error, undefined, res.error);
  // The kernel calls it on the synchronous read path: an `async` body would put
  // a Promise in the attribute.
  assert.match(res.js, /^function \(rt, v_value\)/);
  assert.doesNotMatch(res.js, /\basync\b/);
});

test('model-accessor: the compiled accessor answers what Laravel answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-accessor-'));
  const file = join(dir, 'Post.php');
  writeFileSync(file, SOURCE, 'utf8');
  const res = compileOneMethod('App\\Models\\Post', file, 'getHeadlineAttribute', {});
  assert.equal(res.error, undefined, res.error);

  const { Model } = await import('../../kernel/model.mjs');
  class Post extends Model {}
  Post.table = 'posts';
  Post.prototype.getHeadlineAttribute = (0, eval)('(' + res.js + ')');

  const rt = buildRt({}, { http: {} });
  const post = new Post({ id: 1, title: 'Hello Edge', body: 'First body' });
  // Probed with the vendored Laravel 13: `$post->headline` answers
  // "HELLO EDGE / 10" for that row.
  assert.equal(post.get('headline'), 'HELLO EDGE / 10');
});

test('model-accessor: a body the edge cannot run fails loud (never a null value)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-accessor-'));
  const file = join(dir, 'Post.php');
  writeFileSync(
    file,
    `<?php
namespace App\\Models;
class Post
{
    public function getHeadlineAttribute($value): string
    {
        return (string) \\App\\Models\\Post::find(1)->title;
    }
}
`,
    'utf8'
  );
  const res = compileOneMethod('App\\Models\\Post', file, 'getHeadlineAttribute', {
    models: new Set(['App\\Models\\Post']),
    modelClassFqcns: { Post: 'App\\Models\\Post', 'App\\Models\\Post': 'App\\Models\\Post' },
  });
  // A query in an accessor cannot compile (the read path is synchronous and
  // the kernel has no way to await here), so the build refuses it - the read
  // never answers a Promise or null at request time.
  assert.ok(res.error, 'expected a refusal');
  assert.match(res.error, /getHeadlineAttribute/);
});
