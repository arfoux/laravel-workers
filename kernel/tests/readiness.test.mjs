import { test } from 'node:test';
import assert from 'node:assert/strict';
import readiness from '../../tools/readiness.mjs';

const { VERDICT, renderReadiness, sweepAppSources, stripPhpCommentsAndStrings, verdictOf } = readiness;

// --- verdict classification ---
test('verdictOf gives RUNS when no findings', () => {
  assert.equal(verdictOf([]), VERDICT.RUNS);
});

test('verdictOf gives GAPS when only declared findings', () => {
  assert.equal(
    verdictOf([{ route: '/x', area: 'route', severity: 'declared', cause: 'ignored', fix: null }]),
    VERDICT.GAPS
  );
});

test('verdictOf gives NO when any blocking finding exists', () => {
  assert.equal(
    verdictOf([
      { route: null, area: 'config', severity: 'block', cause: 'bad config', fix: 'fix it' },
      { route: '/x', area: 'route', severity: 'declared', cause: 'ignored', fix: null },
    ]),
    VERDICT.NO
  );
});

test('advisory findings never change the verdict to NO', () => {
  assert.equal(
    verdictOf([
      { route: null, area: 'sweep', severity: 'advisory', cause: 'exec() in comments', fix: null },
    ]),
    VERDICT.RUNS
  );
  assert.equal(
    verdictOf([
      { route: null, area: 'sweep', severity: 'advisory', cause: 'exec()', fix: null },
      { route: '/x', area: 'route', severity: 'declared', cause: 'ignored', fix: null },
    ]),
    VERDICT.GAPS
  );
});

// --- renderReadiness ---
test('renderReadiness prints RUNS ON THE EDGE when no findings', () => {
  const out = renderReadiness([]);
  assert.match(out, /RUNS ON THE EDGE/);
  assert.match(out, /every route is served/i);
});

test('renderReadiness shows fixes for blocking findings', () => {
  const findings = [
    { route: '/dbcheck', area: 'route', severity: 'block', cause: 'a controller serves it — compiled, not snapshotted', fix: 'write a port for /dbcheck (build --scaffold), or declare "ignore" in registry.json' },
    { route: null, area: 'config', severity: 'block', cause: 'session.driver is redis', fix: 'set SESSION_DRIVER=database' },
  ];
  const out = renderReadiness(findings);
  assert.match(out, /DOES NOT RUN/);
  assert.match(out, /\/dbcheck/);
  assert.match(out, /session\.driver is redis/);
  assert.match(out, /write a port for \/dbcheck/);
  assert.match(out, /SESSION_DRIVER=database/);
});

test('renderReadiness groups by severity and mentions declared gaps separately', () => {
  const findings = [
    { route: '/x', area: 'route', severity: 'declared', cause: 'ignored (no reason)', fix: 'add a reason in registry.json' },
    { route: null, area: 'sweep', severity: 'advisory', cause: 'eval() at app/Utils.php:12', fix: 'generate code at build time instead' },
  ];
  const out = renderReadiness(findings);
  assert.match(out, /your decision, and they ship/);
  assert.match(out, /worth knowing/);
});

// --- stripPhpCommentsAndStrings ---
test('stripPhpCommentsAndStrings removes line comments', () => {
  assert.equal(stripPhpCommentsAndStrings('// hello\nexec("x")'), '\nexec( )');
});

test('stripPhpCommentsAndStrings removes block comments', () => {
  assert.equal(stripPhpCommentsAndStrings('/* exec */\nfoo()'), '\nfoo()');
});

test('stripPhpCommentsAndStrings drops string literals', () => {
  const src = 'foo("exec(")';
  const out = stripPhpCommentsAndStrings(src);
  assert.ok(!out.includes('exec('));
  assert.ok(out.includes('foo('));
});

test('stripPhpCommentsAndStrings drops single-quoted strings', () => {
  const src = "foo('exec(')";
  const out = stripPhpCommentsAndStrings(src);
  assert.ok(!out.includes('exec('));
});

test('stripPhpCommentsAndStrings keeps code outside comments and strings', () => {
  const src = `<?php
/* comment with exec() */
$x = "another exec()";
// not-exec();
exec("real");
`;
  const files = [{ file: 'a.php', source: src }];
  const findings = sweepAppSources(files);
  // should find exactly one exec() call
  assert.equal(findings.length, 1);
  assert.match(findings[0].cause, /exec/);
});

// --- deployment tiers ------------------------------------------------------
test('tier paths are printed cheapest-first regardless of input order', () => {
  const out = renderReadiness([
    {
      route: '/orders',
      area: 'queue',
      severity: 'block',
      cause: 'dispatches a queued job, but the worker has no cron trigger',
      fix: 'a Worker has no long-lived consumer',
      paths: [
        { tier: 'paid', what: 'PAIDOPTION' },
        { tier: 'free', what: 'FREEOPTION' },
        { tier: 'r2', what: 'R2OPTION' },
      ],
    },
  ]);
  const at = (needle) => out.indexOf(needle);
  assert.ok(at('FREEOPTION') < at('R2OPTION'), 'the free path must be read before the R2 path');
  assert.ok(at('R2OPTION') < at('PAIDOPTION'), 'the R2 path must be read before the paid path');
});

test('an option that costs money states the cost gate, not just its name', () => {
  const out = renderReadiness([
    {
      route: null,
      area: 'binding',
      severity: 'block',
      cause: 'Storage:: with no object store',
      fix: 'bind one',
      paths: [
        { tier: 'r2', what: 'an R2 bucket' },
        { tier: 'paid', what: 'Cloudflare Queues' },
      ],
    },
  ]);
  assert.match(out, /credit card/i, 'the R2 line must say it needs a credit card');
  assert.match(out, /paid plan/i, 'the paid line must say it needs the paid plan');
});

test('declared gaps say what an ignored route does at the edge', () => {
  const out = renderReadiness([
    { route: '/x', area: 'route', severity: 'declared', cause: 'ignored', fix: 'reason recorded' },
  ]);
  assert.match(out, /404/, 'an ignored route must be documented as answering 404');
});
