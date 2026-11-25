// compiler/tests/precompute.test.mjs — focused regression for @lw-precompute.
// No PHP boot, no app, no build: marker parsing, stale detection and the
// emitted literal handler are all deterministic and isolated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  precomputeDirective,
  resolveFixturePath,
  assertResponseShape,
  assertFixtureFresh,
} from '../src/precompute.mjs';
import { emitController } from '../src/controller.mjs';

const APP = 'C:/tmp/lw-precompute-test-app';
const FIXTURE_PATH = 'app/Http/Controllers/auth-hash.fixture.json';

const SOURCE = `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Support\\Facades\\Hash;
class DashboardController extends Controller
{
    /** not the marker */
    public function me() { return response()->json(['ok' => true]); }

    /**
     * @lw-precompute app/Http/Controllers/auth-hash.fixture.json
     */
    public function hash()
    {
        $digest = Hash::make('password');
        return response()->json(['check' => Hash::check('password', $digest)]);
    }

    /**
     * @lw-precompute app/Http/Controllers/auth-hash.fixture.json
     */
    public function needsArg(string $x)
    {
        return response()->json(['x' => $x]);
    }
}`;

const FIXTURE = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"check":true}',
  json: { check: true },
};

test('marker is attached only to the method it precedes', () => {
  const directive = precomputeDirective(SOURCE, 'hash');
  assert.equal(directive.path, FIXTURE_PATH);
  assert.equal(typeof directive.line, 'number');
  assert.equal(precomputeDirective(SOURCE, 'me'), null);
  assert.throws(() => resolveFixturePath(APP, '../outside.json'), /escapes the app/);
  assert.throws(() => resolveFixturePath(APP, 'C:/outside.json'), /app-relative/);
});

test('stale fixture fails; header order does not', () => {
  const reordered = { ...FIXTURE, headers: { 'content-type': 'application/json' } };
  assert.doesNotThrow(() => assertFixtureFresh(FIXTURE, reordered));
  assertResponseShape(FIXTURE, 'fixture');
  const stale = { ...FIXTURE, json: { check: false }, body: '{"check":false}' };
  assert.throws(() => assertFixtureFresh(FIXTURE, stale), /fixture is stale/);
});

test('precomputed handler returns the fixture bytes and contains no bcrypt', async () => {
  const result = emitController(SOURCE, 'hash', {
    precomputed: { ...FIXTURE, fixture: FIXTURE_PATH },
  });
  assert.deepEqual(result.errors, []);
  assert.doesNotMatch(result.code, /rt\.hash|bcrypt|Hash::/);
  const url = 'data:text/javascript;base64,' + Buffer.from(result.code).toString('base64');
  const { default: handle } = await import(url);
  const response = await handle({}, {});
  assert.equal(response.status, 200);
  assert.equal(response.body, FIXTURE.body);
  assert.equal(response.headers['content-type'], 'application/json');
});

test('precompute refuses a method that needs arguments', () => {
  const result = emitController(SOURCE, 'needsArg', { precomputed: FIXTURE });
  assert.equal(result.code, null);
  assert.match(result.errors[0].message, /zero-argument controller method/);
});
