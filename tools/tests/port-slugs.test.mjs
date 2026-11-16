// tools/tests/port-slugs.test.mjs — registry.ports values are output file names.
//
// A port slug reaches dist/src/controllers/<slug>.mjs (a write) and
// dist/src/ports/<slug>.mjs (an import). The guard closes the same class the
// `static` guard closes: no parent segments, no separators that can climb out,
// and a final resolved path that stays under the intended root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafePortSlug, assertContainedPortPath, portImportSpecifier, guardPortsModuleSource } from '../ports.mjs';

test('port-slugs: a legitimate kebab slug resolves inside the intended root', () => {
  assert.equal(assertSafePortSlug('edge-upload--post'), 'edge-upload--post');
  const root = resolve('/app/dist', 'src', 'controllers');
  const out = assertContainedPortPath(root, 'edge-upload--post');
  assert.equal(out, resolve(root, 'edge-upload--post.mjs'));
  assert.equal(relative(root, out).split(sep)[0], 'edge-upload--post.mjs');
});

test('port-slugs: a nested but contained slug keeps its path under the root', () => {
  const root = resolve('/app/dist', 'src', 'ports');
  const out = assertContainedPortPath(root, 'vendor/foo/port');
  assert.equal(out, resolve(root, 'vendor', 'foo', 'port.mjs'));
  assert.equal(relative(root, out).split(sep)[0], 'vendor');
});

const REFUSED_SLUGS = [
  ['../pwned', 'a parent segment'],
  ['a/../../pwned', 'nested parent segments'],
  ['..\\pwned', 'a backslash parent segment'],
  ['C:\\Windows\\Temp\\pwned', 'a drive-letter path'],
  ['C:/Windows/Temp/pwned', 'a drive-letter path with forward slashes'],
  ['\\\\server\\share\\pwned', 'a UNC path'],
  ['//server/share/pwned', 'a UNC path with forward slashes'],
  ['/etc/passwd', 'a POSIX absolute path'],
  ['%2e%2e/pwned', 'a percent-encoded parent segment'],
  ['a/%2E%2E/pwned', 'a case-insensitive percent-encoded parent segment'],
  ['a%5c..%5cpwned', 'a percent-encoded backslash'],
  ['', 'an empty slug'],
  ['.. ', 'a parent segment with a trailing space'],
  ['. ', 'a dot segment with a trailing space'],
  ['vendor/.. /pwned', 'a nested parent segment with a trailing space'],
  ['vendor/foo /port', 'a trailing-space directory segment'],
  ['vendor/foo./port', 'a trailing-dot directory segment'],
  ['index.html:evil', 'a Windows alternate data stream'],
  ['NUL', 'a Windows device name'],
  ['COM1', 'a Windows COM device name'],
  ['vendor/CON.txt', 'a Windows device name with an extension'],
  ['vendor/foo\u2009', 'a segment ending in Unicode thin space'],
  ['foo\u0000bar', 'a control character'],
];

for (const [slug, why] of REFUSED_SLUGS) {
  test(`port-slugs: refuses ${why} (${JSON.stringify(slug)})`, () => {
    assert.throws(() => assertSafePortSlug(slug), /unsafe port slug/);
    // The writers call the contained-path helper, not the bare name check.
    assert.throws(
      () => assertContainedPortPath(resolve('/app/dist', 'src', 'controllers'), slug),
      /unsafe port slug/
    );
  });
}

test('port-slugs: before/after — old join() escaped the root, guard creates no file outside', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'lw-port-slug-'));
  try {
    const root = join(sandbox, 'dist', 'src', 'controllers');
    mkdirSync(root, { recursive: true });
    const outside = join(sandbox, 'dist', 'pwned.mjs');
    // From controllers/ back up to dist/, expressed with forward slashes so
    // the same proof works on Windows.
    const slug = relative(root, outside).split(sep).join('/').replace(/\.mjs$/, '');

    // BEFORE: the original sink's join(dist, 'src', 'controllers', slug + '.mjs')
    // writes a byte outside the controllers root.
    assert.equal(resolve(join(root, slug + '.mjs')), outside);
    writeFileSync(join(root, slug + '.mjs'), 'PWNED-BEFORE');
    assert.equal(existsSync(outside), true, 'the old sink wrote outside the root');
    rmSync(outside);

    // AFTER: the guard throws before mkdir/write, so the escaped target stays
    // absent even though the caller attempts both.
    assert.throws(() => {
      const target = assertContainedPortPath(root, slug);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'PWNED-AFTER');
    }, /unsafe port slug/);
    assert.equal(existsSync(outside), false, 'the guard created a file outside the root');

    // A real accepted slug still writes where it is supposed to.
    const good = assertContainedPortPath(root, 'edge-upload--post');
    writeFileSync(good, 'OK');
    assert.equal(existsSync(join(root, 'edge-upload--post.mjs')), true);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('port-slugs: a symlinked/junctioned ancestor is refused before any write', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'lw-port-link-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'lw-port-link-outside-'));
  try {
    const root = join(sandbox, 'dist', 'src', 'controllers');
    mkdirSync(root, { recursive: true });
    const link = join(root, 'vendor');
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

    // Lexically `vendor/port.mjs` is under controllers/, but the symlink sends
    // the naive write into `outside`. The guard refuses before mkdir/write.
    assert.throws(
      () => {
        const out = assertContainedPortPath(root, 'vendor/port');
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, 'PWNED');
      },
      /symlink or junction/i
    );
    assert.equal(existsSync(join(outside, 'port.mjs')), false, 'the write escaped through the symlink');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('port-slugs: generated imports are quoted and allowlisted', () => {
  assert.equal(
    portImportSpecifier('./controllers/', 'edge-upload--post'),
    JSON.stringify('./controllers/edge-upload--post.mjs')
  );
  assert.equal(
    portImportSpecifier('./ports/', 'vendor/foo/port'),
    JSON.stringify('./ports/vendor/foo/port.mjs')
  );
  // Quotes/semicolons/newlines cannot reach generated JS: the strict module
  // grammar refuses them even though the plain name guard allows them.
  const injection = 'evil";throw new Error("pwned");var x=1';
  assert.throws(() => portImportSpecifier('./controllers/', injection), /unsafe port slug/);
  assert.throws(() => guardPortsModuleSource([['seal', injection]]), /unsafe port slug/);
  assert.match(guardPortsModuleSource([['seal', 'seal-guard']]), /from "\.\/ports\/seal-guard\.mjs";/);
});
