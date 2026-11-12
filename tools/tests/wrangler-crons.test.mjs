// tools/tests/wrangler-crons.test.mjs — the operator's declared cron triggers.
//
// `wranglerCronTriggers()` answers exactly one safety question for the build: "a
// route pushes a queued job — does ANYTHING drain `lw_jobs` at the edge?" A
// deployed Worker drains the table from whichever trigger fires, so a push is
// only a silent no-op when NEITHER the app's schedule NOR the wrangler config
// declares one. Two ways that answer used to be WRONG, both silent:
//
//   - TOML was scanned with a regex over raw text, so `# crons = ["*/5 * * * *"]`
//     in a COMMENT counted as a real trigger and made the build skip the queue
//     check — a job that never runs, reported as fine.
//   - A config file that failed to parse (or an unreadable one) answered `[]`
//     without a word, so the queue BLOCK blamed "no build-time cron trigger"
//     when the real cause was a malformed file.
//
// `warn` is the seam that closes the second one; both cases are pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jsoncValue, stripTomlComments, wranglerCronTriggers } from '../../tools/wrangler-crons.mjs';
import { parseJsonc } from '../../tools/jsonc.mjs';

/** Run `wranglerCronTriggers` over a temp app dir holding the given files. */
function read(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-crons-'));
  try {
    mkdirSync(join(dir, 'app'), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const warnings = [];
    const crons = wranglerCronTriggers(dir, (m) => warnings.push(m));
    return { crons, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a real wrangler.jsonc trigger is read, comments and all', () => {
  const r = read({
    'wrangler.jsonc': `{
  // the deployed drain
  "name": "x",
  "triggers": { "crons": ["*/5 * * * *"] },
}\n`,
  });
  assert.deepEqual(r.crons, ['*/5 * * * *']);
  assert.deepEqual(r.warnings, []);
});

test('a COMMENTED-OUT toml crons line is not a trigger (#S46)', () => {
  // The regex the build used read the comment as a declaration, so the
  // queue-drain check was skipped for an app whose only "trigger" was a
  // commented-out line — the job is dispatched and never runs.
  const commented = read({
    'wrangler.toml': `name = "x"

[triggers]
# crons = ["*/5 * * * *"]
`,
  });
  assert.deepEqual(commented.crons, [], 'a commented-out array is not a trigger');

  const real = read({
    'wrangler.toml': `name = "x"

[triggers]
crons = ["*/1 * * * *"]
`,
  });
  assert.deepEqual(real.crons, ['*/1 * * * *'], 'the uncommented line is still read');
});

test('`#` inside a toml string stays part of the value', () => {
  const r = read({
    'wrangler.toml': `[triggers]
crons = ["# not a comment"]
`,
  });
  assert.deepEqual(r.crons, ['# not a comment']);
});

test('a toml crons line outside the [triggers] table is not a trigger', () => {
  const r = read({
    'wrangler.toml': `[vars]
crons = ["*/5 * * * *"]

[triggers]
# crons = ["*/5 * * * *"]
`,
  });
  assert.deepEqual(r.crons, [], 'only the [triggers] table declares triggers');
});

test('a malformed wrangler.jsonc is WARNED about, not silently "no trigger" (#S47)', () => {
  // Answering `[]` quietly made the queue BLOCK name the wrong cause: the
  // operator was told to add a cron trigger while the real problem was a syntax
  // error in the file (which also fails `wrangler deploy`).
  const r = read({ 'wrangler.jsonc': '{ "name": "x", "triggers": { "crons": [ } }' });
  assert.deepEqual(r.crons, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /wrangler\.jsonc does not parse/);
  assert.match(r.warnings[0], /NOT counted/);
});

test('a `triggers.crons` that is not an array is warned about', () => {
  const r = read({ 'wrangler.jsonc': '{ "triggers": { "crons": "*/5 * * * *" } }' });
  assert.deepEqual(r.crons, [], 'a bare string is not the array wrangler expects');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not an array/);
});

test('jsonc wins over toml, and neither file means no triggers and no noise', () => {
  const both = read({
    'wrangler.jsonc': '{ "triggers": { "crons": ["a"] } }',
    'wrangler.toml': '[triggers]\ncrons = ["b"]\n',
  });
  assert.deepEqual(both.crons, ['a'], 'wrangler.jsonc is what `deploy` edits');
  const none = read({});
  assert.deepEqual(none.crons, []);
  assert.deepEqual(none.warnings, []);
});

test('stripTomlComments blanks comments but keeps quotes intact', () => {
  assert.equal(stripTomlComments('a = 1 # b = 2'), 'a = 1 ');
  assert.equal(stripTomlComments('a = "# b"'), 'a = "# b"');
  assert.equal(stripTomlComments("a = '# b' # c"), "a = '# b' ");
});

test('jsoncValue turns the jsonc AST back into plain data', () => {
  // Shared with build.mjs's binding check (d1_databases/r2_buckets/queues), so
  // the AST-to-data step is pinned here rather than in the build.
  assert.deepEqual(jsoncValue(parseJsonc('{ "a": [1, { "b": "c" }], "d": true }')), { a: [1, { b: 'c' }], d: true });
});
