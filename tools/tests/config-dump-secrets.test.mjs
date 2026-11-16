// tools/tests/config-dump-secrets.test.mjs — credential keys never ship silently.
//
// config-dump's JSON becomes dist/src/config.generated.mjs, i.e. part of the
// published Worker. A declared app config group used to be able to carry
// mail.password / seal.keys into it with only an advisory comment in the build.
// The dump now fails closed unless the exact dotted key is named in
// LW_ALLOW_SECRET_CONFIG_KEYS (build.mjs passes the two keys the compiled rung
// structurally reads: app.key and auth.hash_key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dumpMjs = resolve(here, '..', 'config-dump.mjs');
const REQUIRED = 'app.key,auth.hash_key';

function appWithCredentialGroups() {
  const app = mkdtempSync(join(tmpdir(), 'lw-cfg-secret-'));
  mkdirSync(join(app, 'config'), { recursive: true });
  writeFileSync(join(app, 'artisan'), '');
  writeFileSync(join(app, 'config', 'app.php'), '<?php return ["key" => "base64:AAAA"];');
  writeFileSync(join(app, 'config', 'mail.php'), '<?php return ["password" => "hunter2"];');
  writeFileSync(join(app, 'config', 'seal.php'), '<?php return ["keys" => ["k1" => "secret-value"]];');
  return app;
}

function run(app, { allow, groups = ['mail', 'seal'] } = {}) {
  return spawnSync(process.execPath, [dumpMjs, ...groups], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LW_APP_ROOT: app,
      LW_VENDOR_DIR: '',
      LW_ALLOW_SECRET_CONFIG_KEYS: allow === undefined ? REQUIRED : allow,
    },
  });
}

test('credential-like keys from a declared group fail the dump', () => {
  const app = appWithCredentialGroups();
  try {
    const r = run(app);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /mail\.password/);
    assert.match(r.stderr, /seal\.keys/);
    assert.match(r.stderr, /LW_ALLOW_SECRET_CONFIG_KEYS/);
    assert.equal(r.stdout, ''); // no partial config can be compiled from this
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('an exact allow-list ships the key and its value unchanged', () => {
  const app = appWithCredentialGroups();
  try {
    const r = run(app, { allow: `${REQUIRED},mail.password,seal.keys,seal.keys.k1` });
    assert.equal(r.status, 0, r.stderr);
    const dump = JSON.parse(r.stdout);
    assert.equal(dump['mail.password'], 'hunter2');
    assert.equal(dump['seal.keys.k1'], 'secret-value');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('a group name or wildcard is not an allow-list', () => {
  const app = appWithCredentialGroups();
  try {
    for (const allow of [REQUIRED + ',mail', REQUIRED + ',mail.*', REQUIRED + ',*']) {
      const r = run(app, { allow });
      assert.equal(r.status, 1, `allow=${allow}: ${r.stderr}`);
      assert.match(r.stderr, /mail\.password/);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('translation strings that merely contain "password" are not credentials', () => {
  const app = appWithCredentialGroups();
  try {
    mkdirSync(join(app, 'lang', 'en'), { recursive: true });
    writeFileSync(
      join(app, 'lang', 'en', 'validation.php'),
      '<?php return ["password" => "The password field is required."];'
    );
    const r = run(app, { groups: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)['translations']['en']['validation']['password'], 'The password field is required.');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
