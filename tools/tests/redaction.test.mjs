// tools/tests/redaction.test.mjs — third-party error text must not leak
// credentials into a terminal, CI log or verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../deploy.mjs';

test('secret-shaped assignments are redacted', () => {
  const input = [
    'CLOUDFLARE_API_TOKEN=cf-canary-123456',
    'DB_PASSWORD: hunter2secret',
    '"api_key": "sk-canary-abcdef"',
    "'private-key' = pk-canary-1234",
    'Authorization: Bearer abcdef1234567890',
  ].join('\n');
  const out = redactSecrets(input);
  assert.doesNotMatch(out, /cf-canary|hunter2|sk-canary|pk-canary|abcdef1234567890/);
  assert.match(out, /CLOUDFLARE_API_TOKEN=\[REDACTED\]/);
  assert.match(out, /DB_PASSWORD: \[REDACTED\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('exact values of secret env vars are redacted anywhere in the text', () => {
  const key = 'LW_TEST_CANARY_TOKEN';
  const before = process.env[key];
  process.env[key] = 'CANARY-VALUE-9876543210';
  try {
    const out = redactSecrets('wrangler failed: token=CANARY-VALUE-9876543210 (account 42)');
    assert.doesNotMatch(out, /CANARY-VALUE-9876543210/);
    assert.match(out, /account 42/); // diagnostics stay useful
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test('ordinary error text is left alone', () => {
  const msg = 'view home: compile FAILED — syntax error on line 12, key:generate hint';
  assert.equal(redactSecrets(msg), msg);
});
