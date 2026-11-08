// tools/native-path.mjs — the shell path -> native path step every dump tool
// shares (audit #401/#417, #803).
//
// The failure this pins was silent: the SAME command with `LW_APP_ROOT=/c/...`
// instead of `C:/...` produced an EMPTY dump and **exit 0**, so a build could
// compile nothing at all without a single word on stderr. The pure mapping is
// what the tools depend on, so it is pinned here rather than only through the
// tools' own output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { toNativePath, resolveAppRoot } = await import('../native-path.mjs');

const WIN = process.platform === 'win32';

test('toNativePath maps the Git-Bash drive form onto a native one', { skip: !WIN }, () => {
  assert.equal(toNativePath('/c/Users/HP/app'), 'C:/Users/HP/app');
  assert.equal(toNativePath('/d/app'), 'D:/app');
  // `/c` alone is a drive, not a directory named c.
  assert.equal(toNativePath('/c'), 'C:/');
  // MSYS2 with the cygdrive prefix spells the same path differently.
  assert.equal(toNativePath('/cygdrive/c/Users/HP/app'), 'C:/Users/HP/app');
  // Trailing slash survives the rewrite (the callers strip it themselves).
  assert.equal(toNativePath('/c/app/'), 'C:/app/');
});

test('toNativePath leaves everything that is already native alone', { skip: !WIN }, () => {
  assert.equal(toNativePath('C:\\Users\\HP\\app'), 'C:\\Users\\HP\\app');
  assert.equal(toNativePath('C:/Users/HP/app'), 'C:/Users/HP/app');
  // A relative path and a POSIX path that is not a drive are NOT rewritten:
  // guessing would silently point a tool at the wrong directory.
  assert.equal(toNativePath('app/sub'), 'app/sub');
  assert.equal(toNativePath('/usr/local/share'), '/usr/local/share');
  assert.equal(toNativePath(''), '');
  assert.equal(toNativePath(undefined), undefined);
  assert.equal(toNativePath(null), null);
});

test('resolveAppRoot normalises the argument it is handed', { skip: !WIN }, () => {
  assert.equal(resolveAppRoot('/c/Users/HP/app'), 'C:/Users/HP/app');
});

test('resolveAppRoot: LW_APP_ROOT wins and is normalised; the cwd is the fallback', { skip: !WIN }, () => {
  const prevEnv = process.env.LW_APP_ROOT;
  const prevCwd = process.cwd();
  const app = mkdtempSync(join(tmpdir(), 'lw-native-path-app-'));
  const plain = mkdtempSync(join(tmpdir(), 'lw-native-path-plain-'));
  try {
    process.env.LW_APP_ROOT = '/c/Users/HP/app';
    process.chdir(plain);
    // The env var is an instruction, not a hint: it wins even from a foreign cwd.
    assert.equal(resolveAppRoot(), 'C:/Users/HP/app');

    // An empty value is not a path (and not a decision): fall through to the cwd.
    process.env.LW_APP_ROOT = '';
    assert.equal(resolveAppRoot(), null, 'a cwd without artisan is not an app root');

    writeFileSync(join(app, 'artisan'), '#!/usr/bin/env php\n');
    process.chdir(app);
    assert.equal(resolveAppRoot(), process.cwd());
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.LW_APP_ROOT;
    else process.env.LW_APP_ROOT = prevEnv;
    rmSync(app, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});
