import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const doctor = join(dirname(here), 'doctor.mjs');

test('doctor: missing prerequisites are WARNs by default and FAIL under --strict', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An app root so the pre-existing app-root check does not be the reason
  // --strict fails; PHP, vendor/ and wrangler are all missing on purpose.
  writeFileSync(join(dir, 'artisan'), '', 'utf8');

  const env = { ...process.env };
  delete env.LW_VENDOR_DIR;
  env.PHP_BIN = join(dir, 'no-such-php');
  env.LW_WRANGLER_BIN = join(dir, 'no-such-wrangler');

  const run = (args) => spawnSync(process.execPath, [doctor, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  const loose = run([]);
  assert.equal(loose.status, 0, loose.stdout);
  for (const name of ['php', 'vendor', 'wrangler']) {
    assert.match(loose.stdout, new RegExp(`⚠\\s+${name}\\s`));
  }

  const strict = run(['--strict']);
  assert.equal(strict.status, 2, strict.stdout);
  for (const name of ['php', 'vendor', 'wrangler']) {
    assert.match(strict.stdout, new RegExp(`✗\\s+${name}\\s[^\\n]*\\(--strict\\)`));
  }
  // Advisory rows stay WARNs even under --strict: the build generates APP_KEY
  // and never deploying is a valid state for a preflight.
  assert.match(strict.stdout, /⚠\s+APP_KEY\s/);
  assert.match(strict.stdout, /⚠\s+deploy state\s/);
});
