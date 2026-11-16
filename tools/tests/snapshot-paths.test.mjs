// tools/tests/snapshot-paths.test.mjs — the names a prerendered page is written under.
//
// The rule decides which files exist on the edge, so these are the cases that put a
// page at a URL: the root, a route, a nested route, an operator-named `static` entry
// in both spellings, and a non-HTML file (which gets no twin - there is no
// `/feed/` spelling of an XML feed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  snapshotFiles,
  findSnapshotCollisions,
  assertNoSnapshotCollisions,
  assertSafeStaticName,
  assertContainedSnapshotPath,
} from '../snapshot-paths.mjs';

test('snapshot-paths: the root is one file', () => {
  assert.deepEqual(snapshotFiles('/'), ['index.html']);
  assert.deepEqual(snapshotFiles(''), ['index.html']);
  assert.deepEqual(snapshotFiles(undefined), ['index.html']);
});

test('snapshot-paths: a route is written for both spellings it is reachable as', () => {
  assert.deepEqual(snapshotFiles('/about'), ['about.html', 'about/index.html']);
  assert.deepEqual(snapshotFiles('about'), ['about.html', 'about/index.html']);
  // Laravel trims the trailing slash, so `/about/` IS `/about`: one page, one set.
  assert.deepEqual(snapshotFiles('/about/'), ['about.html', 'about/index.html']);
  assert.deepEqual(snapshotFiles('/lab/kitchen'), ['lab/kitchen.html', 'lab/kitchen/index.html']);
});

test('snapshot-paths: an operator-named static entry keeps their name and gains its twin', () => {
  assert.deepEqual(snapshotFiles('/docs/guide', 'docs/guide/index.html'), ['docs/guide.html', 'docs/guide/index.html']);
  assert.deepEqual(snapshotFiles('/docs/guide', 'docs/guide.html'), ['docs/guide.html', 'docs/guide/index.html']);
  // A leading "/" is an absolute path, not a spelling of a relative name.
  assert.throws(() => snapshotFiles('/docs/guide', '/docs/guide.html'), /absolute paths are not allowed/);
  assert.deepEqual(snapshotFiles('/', 'index.html'), ['index.html']);
});

test('snapshot-paths: a non-HTML file is written exactly as named, with no folder twin', () => {
  assert.deepEqual(snapshotFiles('/feed', 'feed.xml'), ['feed.xml']);
  assert.deepEqual(snapshotFiles('/robots', 'robots.txt'), ['robots.txt']);
});

test('snapshot-paths: every name is relative, unique and non-empty', () => {
  const sets = [snapshotFiles('/'), snapshotFiles('/a/b'), snapshotFiles('/x', 'x/y.html'), snapshotFiles('/', 'index.html')];
  for (const files of sets) {
    assert.equal(new Set(files).size, files.length, `duplicate name in ${files.join(', ')}`);
    for (const file of files) {
      assert.ok(file.length > 0 && !file.startsWith('/') && !file.includes('//'), `bad name ${file}`);
    }
  }
});

test('snapshot-paths: two distinct routes claiming one output file are reported with both claimants', () => {
  const claims = [
    { route: '/a', files: snapshotFiles('/a', 'shared.html'), label: 'static route /a' },
    { route: '/b', files: snapshotFiles('/b', 'shared.html'), label: 'static route /b' },
  ];
  const collisions = findSnapshotCollisions(claims);
  assert.deepEqual(collisions.map((c) => c.file).sort(), ['shared.html', 'shared/index.html']);
  for (const collision of collisions) {
    assert.deepEqual(collision.claimants, ['static route /a', 'static route /b']);
  }
});

test('snapshot-paths: /index and /404 collide with the reserved root and edge 404 writers', () => {
  const collisions = findSnapshotCollisions([
    { route: '/', files: snapshotFiles('/'), label: 'snapshot /' },
    { route: '/index', files: snapshotFiles('/index'), label: 'snapshot /index' },
    { route: '/404', files: snapshotFiles('/404'), label: 'snapshot /404' },
  ]);
  assert.deepEqual(collisions.map((c) => c.file), ['index.html', '404.html']);
  const root = collisions.find((c) => c.file === 'index.html');
  assert.ok(root.claimants.includes('snapshot /index'));
  assert.ok(root.claimants.some((c) => /root route/.test(c)));
  const notFound = collisions.find((c) => c.file === '404.html');
  assert.deepEqual(notFound.claimants, ['snapshot /404', 'the edge 404 page writer']);
});

test('snapshot-paths: an operator-named 404.html is refused too', () => {
  const collisions = findSnapshotCollisions([
    { route: '/oops', files: snapshotFiles('/oops', '404.html'), label: 'static route /oops' },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, '404.html');
  assert.deepEqual(collisions[0].claimants, ['static route /oops', 'the edge 404 page writer']);
});

test('snapshot-paths: the guard throws a message naming both claimants and the file', () => {
  const claims = [
    { route: '/', files: snapshotFiles('/'), label: 'static route /' },
    { route: '/index', files: snapshotFiles('/index'), label: 'static route /index' },
  ];
  assert.throws(
    () => assertNoSnapshotCollisions(claims),
    (err) => {
      assert.match(err.message, /prerender output-file collision/);
      assert.match(err.message, /public\/index\.html/);
      assert.match(err.message, /static route \/index/);
      assert.match(err.message, /root route \(\/\)/);
      return true;
    }
  );
});

test('snapshot-paths: the guard leaves one writer per file alone', () => {
  const claims = [
    { route: '/', files: snapshotFiles('/') },
    { route: '/', files: snapshotFiles('/', 'index.html') },
    { route: '/about', files: snapshotFiles('/about') },
    { route: '/about/', files: snapshotFiles('/about/'), label: 'snapshot /about/' },
    { route: '/docs/guide', files: snapshotFiles('/docs/guide', 'docs/guide/index.html') },
    { route: '/feed', files: snapshotFiles('/feed', 'feed.xml') },
  ];
  assert.deepEqual(findSnapshotCollisions(claims), []);
  assert.doesNotThrow(() => assertNoSnapshotCollisions(claims));
});

// --- S146h: operator-supplied output names cannot escape dist/public -------

test('snapshot-paths: a legitimate nested output name is accepted unchanged', () => {
  assert.deepEqual(snapshotFiles('/v/x', 'vendor/foo/x.js'), ['vendor/foo/x.js']);
  assert.doesNotThrow(() => assertSafeStaticName('vendor/foo/x.js'));
  assert.deepEqual(snapshotFiles('/docs/guide', 'docs/guide/index.html'), [
    'docs/guide.html',
    'docs/guide/index.html',
  ]);
});

const REFUSED_NAMES = [
  ['../escape.html', 'a parent segment'],
  ['a/../../escape.html', 'nested parent segments'],
  ['..\\escape.html', 'a backslash parent segment'],
  ['C:\\Windows\\Temp\\evil.html', 'a drive-letter path'],
  ['C:/Windows/Temp/evil.html', 'a drive-letter path with forward slashes'],
  ['\\\\server\\share\\evil.html', 'a UNC path'],
  ['//server/share/evil.html', 'a UNC path with forward slashes'],
  ['/etc/passwd', 'a POSIX absolute path'],
  ['%2e%2e/escape.html', 'a percent-encoded parent segment'],
  ['a/%2E%2E/escape.html', 'a case-insensitive percent-encoded parent segment'],
  ['a%5c..%5cescape.html', 'a percent-encoded backslash'],
  ['.. ', 'a parent segment with a trailing space'],
  ['. ', 'a dot segment with a trailing space'],
  ['vendor/.. /escape.html', 'a nested parent segment with a trailing space'],
  ['vendor/foo /x.js', 'a trailing-space directory segment'],
  ['vendor/foo./x.js', 'a trailing-dot directory segment'],
  ['index.html:evil', 'a Windows alternate data stream'],
  ['NUL', 'a Windows device name'],
  ['COM1', 'a Windows COM device name'],
  ['vendor/CON.txt', 'a Windows device name with an extension'],
  ['vendor/foo\u2009', 'a segment ending in Unicode thin space'],
  ['foo\u0000bar', 'a control character'],
];

for (const [name, why] of REFUSED_NAMES) {
  test(`snapshot-paths: refuses ${why} (${JSON.stringify(name)})`, () => {
    assert.throws(() => assertSafeStaticName(name), /unsafe snapshot output name/);
    // snapshotFiles() is the gateway every caller uses; it must refuse too.
    assert.throws(() => snapshotFiles('/x', name), /unsafe snapshot output name/);
  });
}

test('snapshot-paths: the containment backstop keeps writes inside dist/public', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'lw-s146h-'));
  try {
    const pub = join(sandbox, 'dist', 'public');
    mkdirSync(pub, { recursive: true });
    const outside = join(sandbox, 'dist', 'pwned.html');

    // The legitimate writer path resolves under the root and writes there.
    const out = assertContainedSnapshotPath(pub, 'vendor/foo/x.js');
    assert.equal(relative(pub, out).split(sep)[0], 'vendor');
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, 'ok');
    assert.ok(existsSync(out));
    assert.equal(existsSync(outside), false);

    // A future bypass of assertSafeStaticName() still cannot write a byte
    // outside the root: the check runs before mkdir/write, so the escaped
    // target must remain absent after every attempt.
    const absoluteOutside = resolve(sep, 'lw-s146h-pwned.html');
    for (const file of ['../pwned.html', 'a/../../pwned.html', absoluteOutside]) {
      assert.throws(() => {
        const target = assertContainedSnapshotPath(pub, file);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, 'PWNED');
      }, /resolves outside dist\/public/);
      assert.equal(existsSync(outside), false, `${file} escaped to ${outside}`);
      assert.equal(existsSync(absoluteOutside), false, `${file} escaped to ${absoluteOutside}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('snapshot-paths: a symlinked/junctioned ancestor is refused before any write', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'lw-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'lw-symlink-outside-'));
  try {
    const pub = join(sandbox, 'dist', 'public');
    mkdirSync(pub, { recursive: true });
    const link = join(pub, 'vendor');
    try {
      try {
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        symlinkSync(outside, link, 'dir');
      }
    } catch (err) {
      t.skip(`this platform cannot create a directory symlink/junction (${err.code || err.message})`);
      return;
    }

    // Lexically `vendor/x.js` is under dist/public, but the symlink sends the
    // naive write into `outside`. The guard refuses before mkdir/write.
    assert.throws(
      () => {
        const out = assertContainedSnapshotPath(pub, 'vendor/x.js');
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, 'PWNED');
      },
      /symlink or junction/i
    );
    assert.equal(existsSync(join(outside, 'x.js')), false, 'the write escaped through the symlink');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
