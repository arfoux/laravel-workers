// tools/tests/packages-d-spatie.test.mjs — real tests for the Spatie cluster.
//
// Drives each handler against real SQLite through the shared
// `tools/tests/_fake-d1.mjs`, then asserts the actual behavior: role checks,
// tag pivot mutations, unique-slug generation, activity record/replay. The
// ports own their DDL (`ensureSchema`), so UNIQUE / ON CONFLICT / LIKE /
// ORDER BY / LIMIT semantics come from the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import permissionHandler, { ensureSchema as ensurePermissionSchema } from '../../ports/packages/permission.mjs';
import tagsHandler from '../../ports/packages/tags.mjs';
import sluggableHandler, { ensureSchema as ensureSluggableSchema } from '../../ports/packages/sluggable.mjs';
import activitylogHandler from '../../ports/packages/activitylog.mjs';
import { FakeD1 } from './_fake-d1.mjs';

// ---------------------------------------------------------------------------
// Fake request helper. `user_id` is what a `middlewarePorts` guard writes onto
// ctx for an authenticated caller (kernel/packages/port-ctx.mjs guardUserId);
// every permission route requires it.
function makeCtx({ method = 'GET', params = {}, query = {}, body = null, user_id = 1 } = {}) {
  return {
    params,
    query,
    body,
    user_id,
    request: new Request('https://edge.local/test', { method }),
  };
}

function env() {
  return { DB: new FakeD1() };
}

// ---------------------------------------------------------------------------

test('permission: ensureSchema creates the five Spatie tables', async () => {
  const e = env();
  const res = await permissionHandler(makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { role: 'admin' } }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { hasRole: false });
  for (const name of ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions']) {
    assert.ok(e.DB.tables.has(name), `expected table ${name}`);
  }
});

test('permission: assign + hasRole + idempotent re-assign + revoke', async () => {
  const e = env();
  await ensurePermissionSchema(e); // the port's own DDL, applied before the direct seed
  await e.DB.prepare('INSERT INTO roles (name, guard_name) VALUES (?, ?)').bind('editor', 'web').run();

  const assign = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'assign-role' }, body: { role: 'editor' } }),
    e
  );
  assert.equal(assign.status, 200);
  assert.deepEqual(JSON.parse(assign.body), { assigned: 1 });

  // idempotent
  const again = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'assign-role' }, body: { role: 'editor' } }),
    e
  );
  assert.deepEqual(JSON.parse(again.body), { assigned: 0 });

  const has = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '7' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(has.body).hasRole, true);

  // different model key does not have it
  const other = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '8' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(other.body).hasRole, false);

  const revoke = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '7', action: 'revoke-role' }, body: { role: 'editor' } }),
    e
  );
  assert.deepEqual(JSON.parse(revoke.body), { revoked: 1 });
  const hasAfter = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '7' }, query: { role: 'editor' } }),
    e
  );
  assert.equal(JSON.parse(hasAfter.body).hasRole, false);
});

test('permission: hasPermissionTo via direct + via role; missing permission → false', async () => {
  const e = env();
  await ensurePermissionSchema(e);
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('edit-posts').run();
  await e.DB.prepare('INSERT INTO roles (name) VALUES (?)').bind('author').run();
  const role = await e.DB.prepare('SELECT id FROM roles WHERE name = ?').bind('author').first();
  const perm = await e.DB.prepare('SELECT id FROM permissions WHERE name = ?').bind('edit-posts').first();
  await e.DB.prepare('INSERT INTO role_has_permissions (permission_id, role_id) VALUES (?, ?)').bind(perm.id, role.id).run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'author' } }),
    e
  );

  const viaRole = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'edit-posts' } }),
    e
  );
  assert.equal(JSON.parse(viaRole.body).hasPermissionTo, true);

  // direct give
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('delete-posts').run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'give-permission' }, body: { permission: 'delete-posts' } }),
    e
  );
  const direct = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'delete-posts' } }),
    e
  );
  assert.equal(JSON.parse(direct.body).hasPermissionTo, true);

  const missing = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '1' }, query: { permission: 'nonexistent' } }),
    e
  );
  assert.equal(JSON.parse(missing.body).hasPermissionTo, false);
});

test('permission: hasAnyPermission + hasAnyRole aggregations', async () => {
  const e = env();
  await ensurePermissionSchema(e);
  await e.DB.prepare('INSERT INTO roles (name) VALUES (?)').bind('admin').run();
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('a').run();
  await e.DB.prepare('INSERT INTO permissions (name) VALUES (?)').bind('b').run();
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '3', action: 'assign-role' }, body: { role: 'admin' } }),
    e
  );
  await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '3', action: 'give-permission' }, body: { permission: 'a' } }),
    e
  );
  const anyPerm = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { permissions: 'a,zzz' } }),
    e
  );
  assert.equal(JSON.parse(anyPerm.body).hasAnyPermission, true);
  assert.equal(JSON.parse(anyPerm.body).per_permission.a, true);
  assert.equal(JSON.parse(anyPerm.body).per_permission.zzz, false);

  const anyRole = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { roles: 'admin,nope' } }),
    e
  );
  assert.equal(JSON.parse(anyRole.body).hasAnyRole, true);

  const none = await permissionHandler(
    makeCtx({ method: 'GET', params: { modelKey: '3' }, query: { roles: 'x,y' } }),
    e
  );
  assert.equal(JSON.parse(none.body).hasAnyRole, false);
});

test('permission: unknown role on assign → 404', async () => {
  const e = env();
  const res = await permissionHandler(
    makeCtx({ method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'ghost' } }),
    e
  );
  assert.equal(res.status, 404);
});

test('permission: no identity → 401 on read AND write, no D1 write', async () => {
  const e = env();
  const read = await permissionHandler(
    makeCtx({ user_id: null, params: { modelKey: '1' }, query: { role: 'admin' } }),
    e
  );
  assert.equal(read.status, 401);
  const write = await permissionHandler(
    makeCtx({ user_id: null, method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'admin' } }),
    e
  );
  assert.equal(write.status, 401);
  // an authenticated caller cannot be impersonated through the body either:
  // the identity is the guard's, and the route params stay data
  const spoof = await permissionHandler(
    makeCtx({ user_id: null, method: 'POST', params: { modelKey: '1', action: 'assign-role' }, body: { role: 'admin', user_id: 9 } }),
    e
  );
  assert.equal(spoof.status, 401);
});

test('tags: attach, list, idempotent attach', async () => {
  const e = env();
  const attach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p1' }, body: { action: 'attach', tags: ['Laravel', 'PHP'] } }),
    e
  );
  assert.equal(attach.status, 200);
  assert.deepEqual(JSON.parse(attach.body).attached.sort(), ['Laravel', 'PHP']);

  const list = await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p1' } }), e);
  assert.deepEqual(JSON.parse(list.body).tags.sort(), ['Laravel', 'PHP']);

  const reAttach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p1' }, body: { action: 'attach', tags: ['Laravel'] } }),
    e
  );
  assert.deepEqual(JSON.parse(reAttach.body).attached, []);
});

test('tags: detach removes; sync replaces; toggle flips', async () => {
  const e = env();
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'attach', tags: ['a', 'b', 'c'] } }),
    e
  );

  const detach = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'detach', tags: ['a'] } }),
    e
  );
  assert.deepEqual(JSON.parse(detach.body).detached, ['a']);
  let list = JSON.parse((await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p2' } }), e)).body);
  assert.deepEqual(list.tags.sort(), ['b', 'c']);

  const sync = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'sync', tags: ['b', 'd'] } }),
    e
  );
  const syncBody = JSON.parse(sync.body).synced;
  assert.deepEqual(syncBody.removed.sort(), ['c']);
  assert.deepEqual(syncBody.added, ['d']);
  list = JSON.parse((await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p2' } }), e)).body);
  assert.deepEqual(list.tags.sort(), ['b', 'd']);

  const toggle = await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p2' }, body: { action: 'toggle', tags: ['b', 'd', 'x'] } }),
    e
  );
  const tBody = JSON.parse(toggle.body).toggled;
  assert.deepEqual(tBody.detached.sort(), ['b', 'd']);
  assert.deepEqual(tBody.attached, ['x']);
});

test('tags: type-scoped listing only returns that type', async () => {
  const e = env();
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p3' }, body: { action: 'attach', tags: ['red'], type: 'color' } }),
    e
  );
  await tagsHandler(
    makeCtx({ method: 'POST', params: { modelKey: 'p3' }, body: { action: 'attach', tags: ['hot'], type: 'mood' } }),
    e
  );
  const colors = JSON.parse(
    (await tagsHandler(makeCtx({ method: 'GET', params: { modelKey: 'p3' }, query: { type: 'color' } }), e)).body
  );
  assert.deepEqual(colors.tags, ['red']);
});

test('sluggable: base slug, then -2, -3 on collisions', async () => {
  const e = env();
  const gen = (source) =>
    sluggableHandler(makeCtx({ method: 'POST', body: { source, table: 'posts', column: 'slug' } }), e);
  const r1 = JSON.parse((await gen('Hello World')).body);
  assert.equal(r1.slug, 'hello-world');
  const r2 = JSON.parse((await gen('Hello World!')).body); // same base slug
  assert.equal(r2.slug, 'hello-world-2');
  const r3 = JSON.parse((await gen('Hello, World?')).body);
  assert.equal(r3.slug, 'hello-world-3');
});

test('sluggable: custom separator', async () => {
  const e = env();
  const a = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'Big Deal', table: 't', column: 'slug', separator: '_' } }),
      e
    )).body
  );
  assert.equal(a.slug, 'big_deal');
  const b = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'Big Deal', table: 't', column: 'slug', separator: '_' } }),
      e
    )).body
  );
  assert.equal(b.slug, 'big_deal_2');
});

test('sluggable: exclude_id lets a row regenerate its own slug without self-collision', async () => {
  const e = env();
  await ensureSluggableSchema(e);
  // seed a row (id=1) that already owns "my-post"
  await e.DB.prepare(
    'INSERT INTO slugs (slug_table, slug_column, slug, source) VALUES (?, ?, ?, ?)'
  ).bind('posts', 'slug', 'my-post', 'My Post').run();
  const regen = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'POST', body: { source: 'My Post', table: 'posts', column: 'slug', exclude_id: 1 } }),
      e
    )).body
  );
  assert.equal(regen.slug, 'my-post');
});

test('sluggable: GET lists candidates by prefix', async () => {
  const e = env();
  for (const s of ['alpha', 'alpha-2', 'beta']) {
    await sluggableHandler(makeCtx({ method: 'POST', body: { source: s, table: 'posts', column: 'slug' } }), e);
  }
  const res = JSON.parse(
    (await sluggableHandler(
      makeCtx({ method: 'GET', query: { table: 'posts', column: 'slug', prefix: 'alpha' } }),
      e
    )).body
  );
  assert.deepEqual(res.candidates.sort(), ['alpha', 'alpha-2']);
});

test('activitylog: record then read back with properties parsed', async () => {
  const e = env();
  const rec = await activitylogHandler(
    makeCtx({
      method: 'POST',
      body: {
        description: 'created post',
        event: 'created',
        subject_type: 'App\\Models\\Post',
        subject_id: 42,
        causer_id: 1,
        properties: { ip: '127.0.0.1', title: 'Hi' },
      },
    }),
    e
  );
  assert.equal(rec.status, 201);
  const act = JSON.parse(rec.body).activity;
  assert.equal(act.description, 'created post');
  assert.equal(act.event, 'created');
  assert.deepEqual(act.properties, { ip: '127.0.0.1', title: 'Hi' });

  const single = JSON.parse(
    (await activitylogHandler(makeCtx({ method: 'GET', params: { id: act.id } }), e)).body
  );
  assert.equal(single.activity.id, act.id);
  assert.deepEqual(single.activity.properties, { ip: '127.0.0.1', title: 'Hi' });
});

test('activitylog: list filtered by causer + single 404', async () => {
  const e = env();
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'a', causer_id: 9 } }), e);
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'b', causer_id: 10 } }), e);

  const for9 = JSON.parse(
    (await activitylogHandler(makeCtx({ method: 'GET', query: { causer_id: 9 } }), e)).body
  );
  assert.equal(for9.activities.length, 1);
  assert.equal(for9.activities[0].description, 'a');

  const missing = await activitylogHandler(makeCtx({ method: 'GET', params: { id: 9999 } }), e);
  assert.equal(missing.status, 404);
});

test('activitylog: newest first ordering', async () => {
  const e = env();
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'first' } }), e);
  await new Promise((r) => setTimeout(r, 5));
  await activitylogHandler(makeCtx({ method: 'POST', body: { description: 'second' } }), e);
  const list = JSON.parse((await activitylogHandler(makeCtx({ method: 'GET' }), e)).body);
  assert.equal(list.activities[0].description, 'second');
});
