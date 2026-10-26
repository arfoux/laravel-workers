// Lockless composer resolution (vendor-lite) — the contract that replaces
// composer.lock for apps that commit none. Every case here is observable
// behaviour: picks, conflicts, platform filtering, stability floors. The
// packagist stub answers in-process — no network in this suite.
//
// Ground truth for parity claims: composer's documented rules (caret-0 ranges,
// branch normalization to a 9999999 ceiling, minimum-stability floors,
// @suffix escalation, prefer-stable as a same-tuple tie-break).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { contentHashOf } from '../../tools/vendor-lite.mjs';
import { resolveDependencies, stabilityOf, isPlatformKey } from '../../tools/composer-resolve.mjs';

// ── fixtures ──────────────────────────────────────────────────────────────

/** app dir with a composer.json; resolution reads it from disk like the real build. */
function app(composer) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-resolve-'));
  writeFileSync(join(dir, 'composer.json'), JSON.stringify(composer, null, 2));
  return dir;
}

/** packagist p2 stub: catalog[name] = { releases, dev? } → fetch(url) style. */
function stub(catalog) {
  return async (url) => {
    const m = url.match(/p2\/([^~]+)(~dev)?\.json$/);
    if (!m) throw new Error(`resolver asked an unexpected URL: ${url}`);
    const name = m[1];
    const dev = !!m[2];
    const entry = catalog[name];
    if (!entry) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    const versions = dev && entry.dev ? entry.dev : entry.releases;
    return { status: 200, ok: true, json: async () => ({ packages: { [name]: versions } }), text: async () => '' };
  };
}

const rel = (version, extra = {}) => ({ version, ...extra });
const dev = (version, extra = {}) => ({ version, ...extra });

const PLATFORM = { php: '8.3.30', intSize: 8, exts: new Set(['json', 'mbstring', 'openssl']) };

const run = (composer, catalog, opts = {}) =>
  resolveDependencies(app(composer), { fetch: stub(catalog), platform: opts.platform ?? PLATFORM, ...opts });

const pick = (entries, name) => entries.find((e) => e.name === name);

// ── platform-key classification (never fetchable, never installed) ────────

test('platform keys are php/ext only — the packages stay normal', () => {
  assert.equal(isPlatformKey('php'), true);
  assert.equal(isPlatformKey('ext-json'), true);
  assert.equal(isPlatformKey('lib-curl'), true);
  assert.equal(isPlatformKey('composer-plugin-api'), true);
  for (const p of ['phpunit/phpunit', 'composer/semver', 'guzzlehttp/guzzle', 'nesbot/carbon', 'extjson']) {
    assert.equal(isPlatformKey(p), false, p);
  }
});

test('stabilityOf classifies tagged, prerelease, and branch versions', () => {
  const table = {
    '1.0.0': 'stable', 'v1.2.3': 'stable', '1.0.0-rc1': 'rc', '1.0.0-RC2': 'rc',
    '1.0.0-beta2': 'beta', '1.0.0-alpha.1': 'alpha', '1.0.0a1': 'alpha',
    '1.0.0-dev': 'dev', 'dev-main': 'dev', 'dev-master': 'dev', '13.x-dev': 'dev',
    '1.0.x-dev': 'dev',
  };
  for (const [v, want] of Object.entries(table)) assert.equal(stabilityOf(v), want, v);
});

// ── version selection ─────────────────────────────────────────────────────

test('picks the highest satisfying release and carries install metadata', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.0', php: '^8.3', 'ext-mbstring': '*' } }, // root platform keys: fetched never
    { 'acme/lib': { releases: [rel('1.9.0'), rel('2.1.0'), rel('1.9.1'), rel('1.2.0')] } },
  );
  const e = pick(entries, 'acme/lib');
  assert.equal(e.version, '1.9.1');
  assert.equal(e.type, 'library');
  assert.ok('pkgdir' in e && 'require' in e && 'url' in e && 'autoload' in e);
});

test('transitive requirements intersect with root — the surviving version satisfies both', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.0', 'acme/other': '^1.0' } },
    {
      'acme/lib': { releases: [rel('1.9.0'), rel('1.4.0'), rel('1.2.0')] },
      'acme/other': { releases: [rel('1.0.0', { require: { 'acme/lib': '<1.5.0' } })] },
    },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.4.0');
  assert.ok(pick(entries, 'acme/other'));
  assert.equal(pick(entries, 'acme/lib').require['acme/lib'], undefined); // package does not require itself
});

test('a full require chain resolves to every link', async () => {
  const entries = await run(
    { require: { 'acme/a': '^1.0' } },
    {
      'acme/a': { releases: [rel('1.0.0', { require: { 'acme/b': '^1.0' } })] },
      'acme/b': { releases: [rel('1.2.0', { require: { 'acme/c': '^1.0' } })] },
      'acme/c': { releases: [rel('1.0.0')] },
    },
  );
  assert.deepEqual(entries.map((e) => e.name), ['acme/a', 'acme/b', 'acme/c']);
});

test('conflict names both constraints and the requirer', async () => {
  await assert.rejects(
    run(
      { require: { 'acme/lib': '^2.0', 'acme/other': '^1.0' } },
      {
        'acme/lib': { releases: [rel('2.0.0'), rel('1.9.0'), rel('1.4.0')] },
        'acme/other': { releases: [rel('1.0.0', { require: { 'acme/lib': '<1.5.0' } })] },
      },
    ),
    (err) => {
      assert.match(err.message, /acme\/lib/);
      assert.match(err.message, /\^2\.0/);
      assert.match(err.message, /<1\.5\.0/);
      assert.match(err.message, /acme\/other 1\.0\.0/);
      assert.match(err.message, /commit a composer\.lock/);
      return true;
    },
  );
});

test('conflict when every release is platform-incompatible says what each needed', async () => {
  await assert.rejects(
    run(
      { require: { 'acme/tool': '^2.0' } },
      {
        'acme/tool': {
          releases: [
            rel('2.0.0', { require: { 'ext-curl': '*' } }),
            rel('2.1.0', { require: { php: '^8.4' } }),
          ],
        },
      },
    ),
    (err) => {
      assert.match(err.message, /platform-filtered: 2 release\(s\)/);
      assert.match(err.message, /2\.0\.0 needs ext-curl/);
      assert.match(err.message, /2\.1\.0 needs php \^8\.4/);
      assert.match(err.message, /PHP 8\.3\.30/);
      return true;
    },
  );
});

test('platform-incompatible releases drop out; a compatible one still wins', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.0' } },
    {
      'acme/lib': {
        releases: [
          rel('1.9.0', { require: { 'ext-curl': '*' } }), // filtered
          rel('1.8.0', { require: { 'php': '^7.4' } }),   // filtered (we are 8.3)
          rel('1.7.0'),                                    // wins
        ],
      },
    },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.7.0');
});

test('default floor is stable: dev releases need an explicit @dev', async () => {
  const catalog = { 'acme/lib': { releases: [rel('1.0.0')], dev: [dev('2.0.x-dev')] } };

  // dev hidden by default → ^2.0 has no stable survivor
  await assert.rejects(run({ require: { 'acme/lib': '^2.0' } }, catalog), /no version of acme\/lib/);

  // @dev on the constraint lifts the floor for this package only
  const entries = await run({ require: { 'acme/lib': '^2.0@dev' } }, catalog);
  assert.equal(pick(entries, 'acme/lib').version, '2.0.x-dev');
});

test('exact -dev tag pin: "1.0.0-dev" matches only that tag, never a neighbor', async () => {
  // The normalized tuple (1.0.0) would otherwise let neighbor tags drift in;
  // an exact version-string constraint must pin the tag itself.
  const entries = await run(
    { require: { 'acme/lib': '1.0.0-dev' } },
    { 'acme/lib': { releases: [rel('1.0.0'), rel('1.0.5')], dev: [dev('1.0.0-dev'), dev('1.0.6-dev')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.0.0-dev');

  // A different dev tag must not satisfy the pin.
  await assert.rejects(
    run({ require: { 'acme/lib': '1.0.7-dev' } }, { 'acme/lib': { releases: [rel('1.0.0')], dev: [dev('1.0.0-dev')] } }),
    /no version of acme\/lib/,
  );
});

test('root minimum-stability dev lets branches into range resolution', async () => {
  const entries = await run(
    { 'minimum-stability': 'dev', require: { 'acme/lib': '^2.0' } },
    { 'acme/lib': { releases: [rel('1.0.0')], dev: [dev('2.0.x-dev')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '2.0.x-dev');
});

test('composer caret-0 semantics: ^0.2 means <0.3, not <1.0', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^0.2' } },
    { 'acme/lib': { releases: [rel('0.9.0'), rel('0.2.9'), rel('0.1.0')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '0.2.9');

  await assert.rejects(
    run({ require: { 'acme/lib': '^0.2' } }, { 'acme/lib': { releases: [rel('0.9.0')] } }),
    /no version of acme\/lib/,
  );
});

test('wildcard range 1.0.* stops below 1.1', async () => {
  const entries = await run(
    { require: { 'acme/lib': '1.0.*' } },
    { 'acme/lib': { releases: [rel('1.1.0'), rel('1.0.5')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.0.5');
});

test('prefer-stable: same tuple ranks the stable release over its RC', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.5@rc' } },
    { 'acme/lib': { releases: [rel('1.5.0-rc2'), rel('1.5.0')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.5.0');
});

// ── branches: composer parity on dev versions ─────────────────────────────

test('dev-main admits only its own name — a range never silently claims it', async () => {
  const catalog = { 'acme/lib': { releases: [rel('1.0.0')], dev: [dev('dev-main')] } };

  const entries = await run({ require: { 'acme/lib': 'dev-main' } }, catalog);
  assert.equal(pick(entries, 'acme/lib').version, 'dev-main');

  await assert.rejects(run({ require: { 'acme/lib': '^1.0@dev' } }, catalog), /no version of acme\/lib/);
});

test('composer branch normalization: 1.0.x-dev satisfies ^1.0@dev', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.0@dev' } },
    { 'acme/lib': { releases: [rel('1.0.5')], dev: [dev('1.0.x-dev')] } },
  );
  // 1.0.x-dev normalizes to 1.0.9999999 (composer's branch ceiling) — above 1.0.5.
  assert.equal(pick(entries, 'acme/lib').version, '1.0.x-dev');
});

test('dev constraint spelled dev-1.0.x matches version 1.0.x-dev', async () => {
  const entries = await run(
    { require: { 'acme/lib': 'dev-1.0.x' } },
    { 'acme/lib': { releases: [rel('1.0.5')], dev: [dev('1.0.x-dev')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '1.0.x-dev');
});

// ── graph hygiene ─────────────────────────────────────────────────────────

test('require-dev is never installed', async () => {
  const entries = await run(
    { require: { 'acme/lib': '^1.0' }, 'require-dev': { 'acme/tool': '^1.0' } },
    {
      'acme/lib': { releases: [rel('1.0.0')] },
      'acme/tool': { releases: [rel('1.0.0')] },
    },
  );
  assert.deepEqual(entries.map((e) => e.name), ['acme/lib']);
});

test('replace suppresses the replaced package from the result', async () => {
  const entries = await run(
    { require: { 'acme/full': '^1.0', 'acme/gone': '^1.0' } },
    {
      'acme/full': { releases: [rel('1.0.0', { replace: { 'acme/gone': '*' } })] },
      'acme/gone': { releases: [rel('1.0.0')], }, // reachable on its own — suppression must still win
    },
  );
  assert.ok(pick(entries, 'acme/full'));
  assert.equal(pick(entries, 'acme/gone'), undefined);
});

test('root require * takes the highest stable', async () => {
  const entries = await run(
    { require: { 'acme/lib': '*' } },
    { 'acme/lib': { releases: [rel('0.1.0'), rel('3.0.0'), rel('2.5.0')] } },
  );
  assert.equal(pick(entries, 'acme/lib').version, '3.0.0');
});

// ── refusals: loud, actionable, never a silent wrong answer ───────────────

test('non-packagist repositories are refused up front', async () => {
  await assert.rejects(
    run(
      { repositories: [{ type: 'vcs', url: 'https://example.com/x.git' }], require: { 'acme/lib': '^1.0' } },
      {},
    ),
    /custom repository/,
  );
  await assert.rejects(
    run(
      { repositories: { 'packagist.org': false }, require: { 'acme/lib': '^1.0' } },
      {},
    ),
    /disables packagist\.org/,
  );
});

test('constraints vendor-lite cannot evaluate truthfully throw instead of guessing', async () => {
  await assert.rejects(
    run({ require: { 'acme/lib': 'not-a-version' } }, { 'acme/lib': { releases: [rel('1.0.0')] } }),
    /cannot evaluate/,
  );
});

test('unknown package on packagist (404) names it and points at composer.lock', async () => {
  await assert.rejects(
    run({ require: { 'acme/nothere': '^1.0' } }, {}),
    /nothere: not found on packagist\.org/,
  );
});

// ── content hash (the composer.lock parity gate) ──────────────────────────

test('contentHashOf ksorts the top level — root key order never moves the hash', () => {
  const req = { 'b/c': '^1.0', 'a/a': '^2.0' }; // nested order kept identical: composer ksorts only the root
  const a = { name: 'x/y', require: { ...req }, config: { 'sort-packages': true } };
  const b = { config: { 'sort-packages': true }, require: { ...req }, name: 'x/y' };
  assert.equal(contentHashOf(a), contentHashOf(b));
  // ...any semantic change still moves it:
  const c = JSON.parse(JSON.stringify(a));
  c.require['b/c'] = '^1.1';
  assert.notEqual(contentHashOf(a), contentHashOf(c));
});
