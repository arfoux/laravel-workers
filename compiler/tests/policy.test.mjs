// compiler/tests/policy.test.mjs — the policy compiler (M39a).
//
// A policy is a class: the build dumps its metadata (tools/policy-dump.php) and
// compiles the ability methods + the before() hook into async functions
// (dist/src/policies.generated.mjs). These tests drive the compiler with the
// same metadata shape the PHP dump produces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePolicies } from '../src/policy.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-policy-test-'));
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

let fileSeq = 0;
function policyFile(source) {
  const file = path.join(tmp, 'Policy' + ++fileSeq + '.php');
  fs.writeFileSync(file, source);
  return file;
}

// The metadata tools/policy-dump.php produces.
const param = (name, type, extra = {}) => ({
  name,
  type,
  builtin: false,
  allowsNull: false,
  hasDefault: false,
  default: null,
  defaultOk: true,
  variadic: false,
  byRef: false,
  ...extra,
});

const methodMeta = (file, name, params, extra = {}) => ({
  name,
  static: false,
  abstract: false,
  declaringClass: 'App\\Policies\\PostPolicy',
  file,
  guest: false,
  returnType: 'bool',
  returnBuiltin: true,
  returnAllowsNull: false,
  params,
  ...extra,
});

const entryFor = (model, policy, file, methods, extra = {}) => ({
  model,
  policy,
  file,
  error: null,
  hasMagicCall: false,
  before: null,
  methods,
  ...extra,
});

const OPTS = {
  models: new Set(['App\\Models\\Post', 'App\\Models\\User']),
  modelAliases: new Set(['Post', 'App\\Models\\Post', 'User', 'App\\Models\\User']),
  modelClassFqcns: {
    Post: 'App\\Models\\Post',
    'App\\Models\\Post': 'App\\Models\\Post',
    User: 'App\\Models\\User',
    'App\\Models\\User': 'App\\Models\\User',
  },
  modelNotCompiled: new Map([
    ['User', ['posts']],
    ['App\\Models\\User', ['posts']],
  ]),
  userModel: 'App\\Models\\User',
};

// The minimal rt the compiled policy functions use.
const fakeRt = {
  prop: (o, k) => (o == null ? null : o[k]),
  strictEq: (a, b) => a === b,
  strictNe: (a, b) => a !== b,
  not: (v) => !v,
  truthy: (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '' && v !== '0';
    if (Array.isArray(v)) return v.length !== 0;
    if (typeof v === 'object') return Object.keys(v).length !== 0;
    return true;
  },
  is_null: (v) => v === null || v === undefined,
};

async function loadRegistry(code) {
  const file = path.join(tmp, 'registry-' + ++fileSeq + '.mjs');
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href);
  return mod.policies;
}

test('policy: the ability methods compile into async functions', async () => {
  const file = policyFile(`<?php
namespace App\\Policies;

use App\\Models\\Post;
use App\\Models\\User;

class PostPolicy
{
    public function viewAny(?User $user): bool
    {
        return $user !== null;
    }

    public function update(User $user, Post $post): bool
    {
        return $user->id === $post->user_id;
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        viewAny: methodMeta(file, 'viewAny', [param('user', 'App\\Models\\User', { allowsNull: true })], {
          guest: true,
        }),
        update: methodMeta(file, 'update', [
          param('user', 'App\\Models\\User'),
          param('post', 'App\\Models\\Post'),
        ]),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.deepEqual(res.errors, []);
  assert.equal(res.meta['App\\Models\\Post'].compileError, null);
  assert.equal(res.meta['App\\Models\\Post'].methods.viewAny.guest, true);
  assert.equal(res.meta['App\\Models\\Post'].methods.update.guest, false);

  const policies = await loadRegistry(res.code);
  const entry = policies['App\\Models\\Post'];
  assert.equal(entry.policy, 'App\\Policies\\PostPolicy');
  assert.equal(entry.before, null);
  // the owner may update; another user may not.
  assert.equal(await entry.methods.update.fn(fakeRt, { id: 1 }, { user_id: 1 }), true);
  assert.equal(await entry.methods.update.fn(fakeRt, { id: 2 }, { user_id: 1 }), false);
  // the guest rule: the policy decides (the method IS called for viewAny).
  assert.equal(await entry.methods.viewAny.fn(fakeRt, null), false);
  assert.equal(await entry.methods.viewAny.fn(fakeRt, { id: 1 }), true);
});

test('policy: the before() hook compiles and is called first', async () => {
  const file = policyFile(`<?php
namespace App\\Policies;

use App\\Models\\User;

class PostPolicy
{
    public function before(?User $user, string $ability)
    {
        if ($user !== null && $user->id === 1) {
            return true;
        }
        return null;
    }

    public function update(User $user): bool
    {
        return false;
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        update: methodMeta(file, 'update', [param('user', 'App\\Models\\User')]),
      }, {
        before: methodMeta(file, 'before', [
          param('user', 'App\\Models\\User', { allowsNull: true }),
          param('ability', 'string', { builtin: true }),
        ], { guest: true }),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.deepEqual(res.errors, []);
  const policies = await loadRegistry(res.code);
  const entry = policies['App\\Models\\Post'];
  assert.ok(entry.before, 'the before() hook is compiled');
  assert.equal(entry.before.guest, true);
  // the admin: the before() answers true (the ability would answer false).
  assert.equal(await entry.before.fn(fakeRt, { id: 1 }, 'update'), true);
  // another user: the before() answers null -> the ability decides.
  assert.equal(await entry.before.fn(fakeRt, { id: 2 }, 'update'), null);
});

test('policy: a policy that returns an authorization Response does not compile', () => {
  const file = policyFile(`<?php
namespace App\\Policies;

use App\\Models\\User;
use Illuminate\\Auth\\Access\\Response;

class PostPolicy
{
    public function update(User $user): Response
    {
        return Response::deny('nope');
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        update: methodMeta(file, 'update', [param('user', 'App\\Models\\User')], {
          returnType: 'Illuminate\\Auth\\Access\\Response',
          returnBuiltin: false,
        }),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /returns Illuminate\\Auth\\Access\\Response/);
  // the route that checks it stays blocked (the compiler reads the error).
  assert.match(res.meta['App\\Models\\Post'].compileError, /returns Illuminate\\Auth\\Access\\Response/);
});

test('policy: a policy that uses $this does not compile', () => {
  const file = policyFile(`<?php
namespace App\\Policies;

use App\\Models\\User;

class PostPolicy
{
    public function update(User $user): bool
    {
        return $this->helper($user);
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        update: methodMeta(file, 'update', [param('user', 'App\\Models\\User')]),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /\$this/);
  assert.ok(res.meta['App\\Models\\Post'].compileError);
});

test('policy: a static ability method does not compile', () => {
  const file = policyFile(`<?php
namespace App\\Policies;

class PostPolicy
{
    public static function update(): bool
    {
        return true;
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        update: methodMeta(file, 'update', [], { static: true }),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /is static/);
});

test('policy: a relation read inside a policy does not compile (LW003 in the build)', () => {
  const file = policyFile(`<?php
namespace App\\Policies;

use App\\Models\\User;

class PostPolicy
{
    public function update(User $user): bool
    {
        return $user->posts->count() > 0;
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {
        update: methodMeta(file, 'update', [param('user', 'App\\Models\\User')]),
      }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /not compiled/);
});

test('policy: a model without a policy compiles to a registry entry that denies', async () => {
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\User', null, null, {}, { error: 'no policy' }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.deepEqual(res.errors, []);
  const policies = await loadRegistry(res.code);
  const entry = policies['App\\Models\\User'];
  assert.equal(entry.policy, null);
  assert.deepEqual(entry.methods, {});
});

test('policy: a policy with a __call() is flagged (the build cannot know what it answers)', () => {
  const file = policyFile(`<?php
namespace App\\Policies;

class PostPolicy
{
    public function __call($name, $arguments)
    {
        return true;
    }
}
`);
  const dump = {
    globals: { before: 0, after: 0, abilities: [] },
    models: [
      entryFor('App\\Models\\Post', 'App\\Policies\\PostPolicy', file, {}, { hasMagicCall: true }),
    ],
  };
  const res = compilePolicies(dump, OPTS);
  assert.equal(res.meta['App\\Models\\Post'].hasMagicCall, true);
});

test('policy: the global Gate registrations are recorded in the metadata', () => {
  const dump = {
    globals: { before: 1, after: 2, abilities: ['update'] },
    models: [entryFor('App\\Models\\Post', null, null, {}, { error: 'no policy' })],
  };
  const res = compilePolicies(dump, OPTS);
  const meta = res.meta['App\\Models\\Post'];
  assert.equal(meta.globalBefore, 1);
  assert.equal(meta.globalAfter, 2);
  assert.deepEqual(meta.definedAbilities, ['update']);
});
