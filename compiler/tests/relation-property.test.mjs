// compiler/tests/relation-property.test.mjs — a relation read as a PROPERTY.
//
// Laravel: `$post->comments` goes through Model::getRelationValue(), which
// answers the cached relation and otherwise runs the relation's query
// (Model.php:425-435). `$comment->post` is the inverse. The compiled rung used
// to refuse the read (LW003, "the compiled rung has no relations") - safe, but
// a parity gap. Now the read compiles to the awaited runtime load and the
// kernel answers the same shape Eloquent does:
//
//   hasMany   -> an Eloquent Collection (HasMany::getResults(), :433-440)
//   belongsTo -> one model (or null)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitController } from '../src/controller.mjs';

const RELATIONS = {
  Post: [{ name: 'comments', type: 'hasMany', related: 'App\\Models\\Comment', foreignKey: 'post_id' }],
  Comment: [{ name: 'post', type: 'belongsTo', related: 'App\\Models\\Post', foreignKey: 'post_id' }],
};

function meta(models) {
  return {
    params: [],
    classes: [],
    constants: [],
    views: [],
    models,
    storage: { defaultDisk: 'local', disks: ['local'] },
  };
}

function source(body) {
  return `<?php
namespace App\\Http\\Controllers;
class C
{
    public function demo()
    {
        ${body}
    }
}
`;
}

test('relation-property: a hasMany read compiles to the awaited load and is a Collection', () => {
  const res = emitController(
    source(`$post = \\App\\Models\\Post::find(1);
        $comments = $post->comments;
        return $comments->count();`),
    'demo',
    meta([{ alias: 'Post', fqcn: 'App\\Models\\Post', notCompiled: ['comments'], relations: RELATIONS.Post }])
  );
  assert.deepEqual(res.errors, []);
  assert.match(res.code, /await rt\.modelRelation\(v_post, "comments"\)/);
  // The Collection surface is reachable: `count()` is a plain call (the kernel
  // Collection has it), not a refusal.
  assert.match(res.code, /v_comments\.count\(\)/);
});

test('relation-property: a belongsTo read compiles and stays a single model', () => {
  const res = emitController(
    source(`$comment = \\App\\Models\\Comment::find(1);
        $post = $comment->post;
        return $post->title;`),
    'demo',
    meta([
      { alias: 'Comment', fqcn: 'App\\Models\\Comment', notCompiled: ['post'], relations: RELATIONS.Comment },
    ])
  );
  assert.deepEqual(res.errors, []);
  assert.match(res.code, /await rt\.modelRelation\(v_comment, "post"\)/);
  assert.match(res.code, /rt\.prop\(v_post, "title"\)/);
});

test('relation-property: a method the dump does NOT declare still fails loud', () => {
  // The dump knows the model declares `comments` but the build has no relation
  // entry for it (an unsupported shape): the compiled read would answer null -
  // a silently wrong answer - so the build stops instead.
  const res = emitController(
    source(`$post = \\App\\Models\\Post::find(1);
        return $post->comments;`),
    'demo',
    meta([{ alias: 'Post', fqcn: 'App\\Models\\Post', notCompiled: ['comments'], relations: [] }])
  );
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'LW003');
  assert.match(res.errors[0].message, /comments/);
});
