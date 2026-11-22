// tools/tests/port-ctx.test.mjs — the two gaps the package unit tests missed.
//
// Ports are exercised in unit tests with hand-built ctx objects (`ctx.body` a
// URLSearchParams, `ctx.user` a plain `{id}`), but the compiled Worker hands
// them a kernel Request whose accessors are METHODS and an Eloquent user whose
// id is behind getAuthIdentifier(). These tests pin both translations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';
import { readChannelAuthBody } from '../../kernel/packages/broadcast.mjs';

test('port-ctx: a form-urlencoded kernel body reaches the port as ctx.body', () => {
  const raw = 'socket_id=1.1&channel_name=private-demo';
  const ctx = normalizePortCtx({
    method: 'POST',
    params: {},
    request: {
      method: () => 'POST',
      pathInfo: () => '/broadcasting/auth',
      header: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/x-www-form-urlencoded' : null),
      json: () => null,
      post: () => ({ socket_id: '1.1', channel_name: 'private-demo' }),
      getContent: () => raw,
    },
  });
  assert.deepEqual(readChannelAuthBody(ctx), {
    socketId: '1.1',
    channelName: 'private-demo',
  });
  // A JSON body still wins when the kernel exposes one.
  const jsonCtx = normalizePortCtx({
    request: { method: () => 'POST', pathInfo: () => '/x', header: () => null, json: () => ({ a: 1 }), post: () => ({ a: 2 }) },
  });
  assert.deepEqual(jsonCtx.body, { a: 1 });
});

test('guard-user: getAuthIdentifier is the guard identity; caller fields never are', async () => {
  assert.equal(await guardUserId({ user: async () => ({ getAuthIdentifier: () => 7 }) }), 7);
  assert.equal(await guardUserId({ user: { id: 9 } }), 9);
  assert.equal(await guardUserId({ user_id: 3, body: { user_id: 999 }, query: { user_id: 999 } }), 3);
  assert.equal(await guardUserId({ body: { user_id: 999 }, query: { user_id: 999 } }), null);
});
