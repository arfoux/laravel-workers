// kernel/tests/resources.test.mjs - the API resources, verified against the
// real Laravel 13 (the oracle: the fixture app's vendor, PHP 8.3). The
// expected bodies below are PHP's, not ours: every one of them was probed
// against `Illuminate\Http\Resources\Json` (JsonResource.php,
// ResourceCollection.php, ResourceResponse.php, PaginatedResourceResponse.php,
// ConditionallyLoadsAttributes.php) and the comment above the assertion names
// the file:line the probe pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JsonResource,
  ResourceCollection,
  resourcePayload,
  resourceResponse,
  setResourceResolver,
} from '../resources.mjs';
import { Model } from '../model.mjs';
import { LengthAwarePaginator } from '../paginator.mjs';

// The app's own resource: `toArray()` is the app's, the base never merges
// Laravel's defaults over it (JsonResource.php:170-178).
class UserResource extends JsonResource {
  toArray() {
    return { id: this.id, name: this.name };
  }
}

function user(id, name) {
  return new Model({ id, name });
}

test('the resource wraps its data in `data` (the default wrapper)', () => {
  // JsonResource.php:52 (`public static $wrap = 'data'`) and
  // ResourceResponse.php:60-73 (the wrap) - a probe: the body of
  // `new UserResource($user)` is `{"data":{"id":1,"name":"Ada"}}`.
  const resource = new UserResource(user(1, 'Ada'));
  assert.equal(resourceResponse(resource).body, '{"data":{"id":1,"name":"Ada"}}');
  assert.equal(resourceResponse(resource).status, 200);
  assert.equal(resourceResponse(resource).headers['content-type'], 'application/json');

  // JsonResource.php:306-309 (`withoutWrapping()`) - a probe: the body is
  // the bare object.
  JsonResource.withoutWrapping();
  assert.equal(resourceResponse(resource).body, '{"id":1,"name":"Ada"}');
  JsonResource.flushState();
  assert.equal(resourceResponse(resource).body, '{"data":{"id":1,"name":"Ada"}}');

  // JsonResource.php:296-299 (`wrap($value)`) - a probe: the body is
  // `{"payload":{"id":2,"name":"Bob"}}`.
  JsonResource.setWrap('payload');
  assert.equal(resourceResponse(new UserResource(user(2, 'Bob'))).body, '{"payload":{"id":2,"name":"Bob"}}');
  JsonResource.flushState();

  // ResourceResponse.php:79-89: the data that already carries the wrapper
  // key is NOT wrapped again - a probe: `{"data":"inner","id":1}`.
  class DataKeyResource extends JsonResource {
    toArray() {
      return { data: 'inner', id: 1 };
    }
  }
  assert.equal(resourceResponse(new DataKeyResource(user(1, 'Ada'))).body, '{"data":"inner","id":1}');
});

test('the resource resolves its own data (the app\'s toArray wins)', () => {
  const model = user(1, 'Ada');
  const resource = new UserResource(model);

  // JsonResource.php:170-178 (`toArray()`), :117-133 (`resolve()`) and
  // :312-315 (`jsonSerialize()`) - a probe: the three answer the app's array.
  assert.deepEqual(resource.toArray(), { id: 1, name: 'Ada' });
  assert.deepEqual(resource.resolve(), { id: 1, name: 'Ada' });
  assert.deepEqual(resource.jsonSerialize(), { id: 1, name: 'Ada' });

  // JsonResource.php:186-196 (`toJson()`): the JSON of the RESOLVED data -
  // the `data` wrapper is the RESPONSE's job, not the resource's. A probe:
  // `{"id":1,"name":"Ada"}`.
  assert.equal(resource.toJson(), '{"id":1,"name":"Ada"}');

  // The resource's own data: the wrapped model (JsonResource.php:34) and the
  // property proxy (DelegatesToResource.php:120-123) - a probe:
  // `$resource->resource` is the model and `$resource->id` is its attribute.
  assert.equal(resource.resource, model);
  assert.equal(resource.id, 1);
  assert.equal(resource.name, 'Ada');

  // The app's `toArray()` wins: the base never merges the model's own
  // attributes over it (JsonResource.php:170-178) - a probe: the body is
  // `{"data":{"id":1}}`, the model's `name` is NOT there.
  class IdOnlyResource extends JsonResource {
    toArray() {
      return { id: this.id };
    }
  }
  assert.equal(resourceResponse(new IdOnlyResource(model)).body, '{"data":{"id":1}}');

  // JsonResource.php:170-178: a null resource answers an empty array - a
  // probe: the body is `{"data":[]}`.
  assert.equal(resourceResponse(new JsonResource(null)).body, '{"data":[]}');
  assert.deepEqual(new JsonResource(null).toArray(), []);
});

test('the conditional attributes answer like Laravel (the missing ones vanish)', () => {
  // ConditionallyLoadsAttributes.php:272-293 (`whenLoaded()`): the key
  // appears ONLY when the relation is loaded. The edge's "loaded" is what the
  // model reports (`Model::relationLoaded()`).
  class LoadedResource extends JsonResource {
    toArray() {
      return {
        posts: this.whenLoaded('posts'),
        posts_mapped: this.whenLoaded('posts', (posts) => posts.map((post) => post.id)),
        posts_default: this.whenLoaded('posts', null, 'fallback'),
        missing: this.whenLoaded('nope'),
        missing_default: this.whenLoaded('nope', null, 'fallback'),
        nulls: this.whenLoaded('empty'),
      };
    }
  }
  const withPosts = user(7, 'Ada');
  withPosts.setRelation('posts', [{ id: 10 }, { id: 11 }]);
  withPosts.setRelation('empty', null);
  // A probe: the body is
  // `{"data":{"posts":[{"id":10},{"id":11}],"posts_mapped":[10,11],"posts_default":[{"id":10},{"id":11}],"missing_default":"fallback","nulls":null}}`
  // - the relation that is not loaded takes NO key when `whenLoaded()` got one
  // or two arguments, the loaded-but-null one takes a null
  // (ConditionallyLoadsAttributes.php:284-285), and a THREE-argument call
  // keeps the key with its default (func_num_args() - :272-282).
  assert.equal(
    resourceResponse(new LoadedResource(withPosts)).body,
    '{"data":{"posts":[{"id":10},{"id":11}],"posts_mapped":[10,11],"posts_default":[{"id":10},{"id":11}],"missing_default":"fallback","nulls":null}}'
  );
  // The relation that is not loaded: a one/two-argument `whenLoaded()` takes
  // NO key, and the THREE-argument calls keep their default - a probe: the
  // body is `{"data":{"posts_default":"fallback","missing_default":"fallback"}}`.
  const withoutPosts = user(8, 'Bob');
  assert.equal(
    resourceResponse(new LoadedResource(withoutPosts)).body,
    '{"data":{"posts_default":"fallback","missing_default":"fallback"}}'
  );
});

test('when / whenNotNull / mergeWhen answer like Laravel', () => {
  // ConditionallyLoadsAttributes.php:126-133 (`when()`), :243-250
  // (`whenNotNull()`) and :168-177 (`mergeWhen()`) - a probe: the body is
  // `{"data":{"not_null":"here","null_default":"dflt","when_true":"yes","when_false_default":"alt","merged":{"data":{"x":1}}}}`
  // - the false condition takes NO key, and a merge that landed on a STRING
  // key is not merged (ConditionallyLoadsAttributes.php:44-47): Laravel's
  // json_encode answers the object's property.
  class CondResource extends JsonResource {
    toArray() {
      return {
        not_null: this.whenNotNull('here'),
        null_value: this.whenNotNull(null),
        null_default: this.whenNotNull(null, 'dflt'),
        when_true: this.when(true, 'yes'),
        when_false: this.when(false, 'no'),
        when_false_default: this.when(false, 'no', 'alt'),
        merged: this.mergeWhen(true, { x: 1 }),
        merged_false: this.mergeWhen(false, { x: 1 }),
      };
    }
  }
  assert.equal(
    resourceResponse(new CondResource(user(1, 'Ada'))).body,
    '{"data":{"not_null":"here","null_default":"dflt","when_true":"yes","when_false_default":"alt","merged":{"data":{"x":1}}}}'
  );

  // A merge on a NUMERIC key is folded into the parent array
  // (ConditionallyLoadsAttributes.php:44-47 and :60-79) - a probe: the
  // resolved array is `{"id":1,"extra":"value"}` (the merge's own key is gone).
  // PHP builds that array as `['id' => 1, 0 => MergeValue]`; the compiled
  // rung builds the same shape with the numeric key spelled out.
  const merged = new CondResource(user(1, 'Ada'));
  // The compiled shape of `[$this->mergeWhen(...)]`: a JS list, so the order
  // is PHP's own.
  assert.deepEqual(merged.filter([merged.mergeWhen(true, { extra: 'value' })]), { extra: 'value' });
  // A mixed literal keeps PHP's order through the `rt.assoc` marker: PHP's
  // `['a' => 1, 0 => MergeValue, 'b' => 2]` answers
  // `{"a":1,"extra":"value","b":2}` (a probe).
  const mixed = { a: 1, 0: merged.mergeWhen(true, { extra: 'value' }), b: 2 };
  Object.defineProperty(mixed, '__lwOrder', { value: ['a', '0', 'b'], enumerable: false });
  assert.deepEqual(merged.filter(mixed), { a: 1, extra: 'value', b: 2 });
});

test('the additional keys are at the TOP level (not inside `data`)', () => {
  // JsonResource.php:224-231 (`additional()`) and ResourceResponse.php:60-73
  // (the wrap) - a probe: the body is `{"data":{"id":1,"name":"Ada"},"meta":{"x":1}}`.
  const resource = new UserResource(user(1, 'Ada'));
  resource.additional({ meta: { x: 1 } });
  assert.equal(resourceResponse(resource).body, '{"data":{"id":1,"name":"Ada"},"meta":{"x":1}}');

  // ResourceResponse.php:95-103: with the wrapping off the additional keys
  // still need a home, so the data is wrapped under `data` - a probe: the
  // body is `{"data":{"id":1,"name":"Ada"},"meta":{"x":1}}`.
  JsonResource.withoutWrapping();
  const bare = new UserResource(user(1, 'Ada'));
  bare.additional({ meta: { x: 1 } });
  assert.equal(resourceResponse(bare).body, '{"data":{"id":1,"name":"Ada"},"meta":{"x":1}}');
  JsonResource.flushState();
});

test('a resource collection answers `data` with the items', () => {
  // JsonResource.php:90-104 (`collection()`) and ResourceCollection.php:104-112
  // (`toArray()`) - a probe: the body is
  // `{"data":[{"id":1,"name":"Ada"},{"id":2,"name":"Bob"}]}`.
  const collection = UserResource.collection([user(1, 'Ada'), user(2, 'Bob')]);
  assert.equal(
    resourceResponse(collection).body,
    '{"data":[{"id":1,"name":"Ada"},{"id":2,"name":"Bob"}]}'
  );
  // ResourceCollection.php:88-91 (`count()`) - a probe: 2.
  assert.equal(collection.count(), 2);
  // The collection's own data (ResourceCollection.php:104-112) - a probe: the
  // two resolved items.
  assert.deepEqual(collection.toArray(), [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Bob' },
  ]);
  // An empty collection - a probe: the body is `{"data":[]}`.
  assert.equal(resourceResponse(UserResource.collection([])).body, '{"data":[]}');
});

test('a paginated collection answers the links and the meta', () => {
  // PaginatedResourceResponse.php:16-30 (the response),
  // :48-80 (`paginationInformation()`) and LengthAwarePaginator.php:206-223
  // (`toArray()`) - a probe: the body is
  // `{"data":[...],"links":{...},"meta":{...}}` with the meta carrying
  // `current_page`, `from`, `last_page`, `links`, `path`, `per_page`, `to`
  // and `total`.
  const paginator = new LengthAwarePaginator(
    [user(1, 'Ada'), user(2, 'Bob')],
    5,
    2,
    2,
    { path: 'https://example.test/api/users' }
  );
  const body = resourceResponse(UserResource.collection(paginator)).body;
  assert.equal(
    body,
    '{"data":[{"id":1,"name":"Ada"},{"id":2,"name":"Bob"}],' +
      '"links":{"first":"https:\\/\\/example.test\\/api\\/users?page=1",' +
      '"last":"https:\\/\\/example.test\\/api\\/users?page=3",' +
      '"prev":"https:\\/\\/example.test\\/api\\/users?page=1",' +
      '"next":"https:\\/\\/example.test\\/api\\/users?page=3"},' +
      '"meta":{"current_page":2,"from":3,"last_page":3,' +
      '"links":[{"url":"https:\\/\\/example.test\\/api\\/users?page=1","label":"&laquo; Previous","page":1,"active":false},' +
      '{"url":"https:\\/\\/example.test\\/api\\/users?page=1","label":"1","page":1,"active":false},' +
      '{"url":"https:\\/\\/example.test\\/api\\/users?page=2","label":"2","page":2,"active":true},' +
      '{"url":"https:\\/\\/example.test\\/api\\/users?page=3","label":"3","page":3,"active":false},' +
      '{"url":"https:\\/\\/example.test\\/api\\/users?page=3","label":"Next &raquo;","page":3,"active":false}],' +
      '"path":"https:\\/\\/example.test\\/api\\/users","per_page":2,"to":4,"total":5}}'
  );
  // The meta of the paginator (PaginatedResourceResponse.php:86-97): the
  // pagination numbers, without the URLs (they are the `links`).
  const payload = resourcePayload(UserResource.collection(paginator));
  assert.equal(payload.meta.current_page, 2);
  assert.equal(payload.meta.per_page, 2);
  assert.equal(payload.meta.total, 5);
  assert.equal(payload.meta.last_page, 3);
  assert.equal(payload.links.next, 'https://example.test/api/users?page=3');
});

test('a collection finds the resource class it collects (the class-name convention)', () => {
  // CollectsResources.php:59-88 (`collects()`): a `UserCollection` collects
  // `User` or `UserResource` - a probe: the body is `{"data":[{"id":1}]}`.
  class UserCollection extends ResourceCollection {}
  setResourceResolver((name) => (name === 'UserResource' ? UserResource : null));
  try {
    assert.equal(
      resourceResponse(new UserCollection([user(1, 'Ada')])).body,
      '{"data":[{"id":1,"name":"Ada"}]}'
    );
  } finally {
    setResourceResolver(null);
  }
});
