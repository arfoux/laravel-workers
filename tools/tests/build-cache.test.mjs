// The build cache key is the only thing standing between a changed binding and
// a replayed (stale) readiness verdict: wrangler.jsonc carries the D1/R2/QUEUE
// bindings the verdict reads, so it is an input like .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildCacheKey } from '../build-cache.mjs';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a wrangler config change invalidates the build cache', () => {
  const app = mkdtempSync(join(tmpdir(), 'lw-cache-'));
  try {
    writeFileSync(join(app, 'wrangler.jsonc'), '{"name":"a"}\n');
    const args = { appDir: app, pkgDir, php: { version: '8.3.30' }, flags: {}, env: {} };
    const first = computeBuildCacheKey(args);
    assert.equal(computeBuildCacheKey(args).key, first.key, 'an unchanged tree must hit');
    writeFileSync(
      join(app, 'wrangler.jsonc'),
      '{"name":"a","queues":{"producers":[{"queue":"q","binding":"QUEUE"}]}}\n'
    );
    assert.notEqual(
      computeBuildCacheKey(args).key,
      first.key,
      'a binding lives in wrangler.jsonc - a changed binding must rebuild, not replay the verdict'
    );
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
