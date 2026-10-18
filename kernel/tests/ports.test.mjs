import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_MARKER, buildStubSource, findStubPorts } from '../../tools/ports.mjs';

test('buildStubSource emits a default-export handler (controller re-export contract)', () => {
  const src = buildStubSource('/dbcheck');
  assert.ok(src.includes('export default async function handle(ctx, env)'));
  assert.ok(src.includes(STUB_MARKER));
  assert.equal(src.includes('export async function handle'), false, 'must not use a named export');
});

test('the generated stub runs and returns the { status, headers, body } contract', async () => {
  const src = buildStubSource('/posts/{post}');
  const mod = await import('data:text/javascript,' + encodeURIComponent(src));
  const res = await mod.default({ params: { post: '1' }, request: { method: 'GET', path: '/posts/1' } }, {});
  assert.equal(res.status, 501);
  assert.equal(typeof res.body, 'string');
  assert.deepEqual(res.headers, { 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(res.body), { error: 'not implemented', route: '/posts/{post}' });
});

test('buildStubSource points dynamic routes at ctx.params (and only those)', () => {
  assert.ok(buildStubSource('/posts/{post}').includes('ctx.params'));
  assert.equal(buildStubSource('/plain').includes('ctx.params'), false);
});

test('findStubPorts flags only .mjs files carrying the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-ports-'));
  try {
    writeFileSync(join(dir, 'stub.mjs'), buildStubSource('/a'));
    writeFileSync(
      join(dir, 'real.mjs'),
      'export default async function handle() { return { status: 200, headers: {}, body: "ok" }; }\n'
    );
    writeFileSync(join(dir, 'notes.txt'), STUB_MARKER);
    assert.deepEqual(findStubPorts(dir), ['stub.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findStubPorts tolerates a missing directory', () => {
  assert.deepEqual(findStubPorts(join(tmpdir(), 'lw-missing-' + process.pid)), []);
});
