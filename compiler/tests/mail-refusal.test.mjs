#!/usr/bin/env node
// compiler/tests/mail-refusal.test.mjs — the Mail boundary, one boundary.
//
// The kernel's mailer refuses `raw`/`html`/`queue`/`later` at the edge
// (kernel/mail.mjs; `ADAPTER_REFUSED` in kernel/service-adapters.mjs) and the
// build refuses the SAME four methods before the code runs — for the facade
// (`Mail::raw(...)`, `Mail::to($u)->queue($m)`) and for a constructor-injected
// service (`$this->mailer->raw(...)`) alike. The guards must agree: the facade
// guard once said the kernel "does not implement" raw/html/queue/later, while
// the kernel did implement them as a hard failure — the operator who read that
// message looked in the wrong place. Both guards now answer with ONE wording
// (`mailRefusedWhy`), and the refused set has ONE source (`ADAPTER_REFUSED`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transpileControllerMethod } from '../src/transpiler.mjs';
import { ADAPTER_ASYNC, ADAPTER_REFUSED } from '../../kernel/service-adapters.mjs';

const MAILER = new Map([['mailer', { param: 'mailer', adapter: 'mail', kind: 'adapter' }]]);
const LOG = new Map([['logger', { param: 'logger', adapter: 'log', kind: 'adapter' }]]);
const WHY = 'Laravel builds that message itself';

const parser = (await import('php-parser')).default;
const phpParser = new parser({ parser: { suppressErrors: true }, ast: { withPositions: true } });
// The body of a PHP method, the way the build hands it to the transpiler.
const phpBody = (source) => phpParser.parseCode('<?php function f() { ' + source + ' }').children[0].body.children;
const compile = (source, opts) => transpileControllerMethod(phpBody(source), { controller: true, ...opts });

function refusalOf(source, opts) {
  const out = compile(source, opts);
  assert.equal(out.errors.length, 1, 'expected exactly one refusal for ' + source);
  assert.equal(out.code, null, 'a refused method compiles to no code');
  return out.errors[0];
}

test('the facade refuses exactly the methods the kernel refuses', () => {
  for (const meth of ADAPTER_REFUSED.mail) {
    const e = refusalOf('Mail::' + meth + '($m);');
    assert.equal(e.code, 'LW002');
    assert.match(e.message, new RegExp('Mail::' + meth + '\\(\\) is not supported'));
    assert.match(e.message, new RegExp(WHY));
    assert.doesNotMatch(e.message, /not implemented/, 'the kernel refuses these on purpose, it does not lack them');
  }
});

test('the fluent facade chain refuses them too (the pending guard)', () => {
  for (const meth of ['queue', 'later']) {
    const e = refusalOf('Mail::to($u)->' + meth + '($m);');
    assert.equal(e.code, 'LW002');
    assert.match(e.message, new RegExp('pending mail method ' + meth + '\\(\\) is not supported'));
    assert.match(e.message, new RegExp(WHY));
  }
});

test('an injected mailer refuses them with the same wording', () => {
  for (const meth of ADAPTER_REFUSED.mail) {
    const e = refusalOf('$this->mailer->' + meth + '($m);', { injectedDeps: MAILER, classMethod: true });
    assert.equal(e.code, 'LW002');
    assert.match(e.message, new RegExp('\\$this->mailer->' + meth + '\\(\\) is not supported'));
    assert.match(e.message, new RegExp(WHY), 'the two guards must tell ONE story');
  }
});

test('the supported surface still compiles (and is awaited)', () => {
  const send = compile('Mail::to($u)->send($m);');
  assert.deepEqual(send.errors, []);
  assert.match(send.code, /\(await rt\.mail\(\)\.to\([^)]*\)\.send\([^)]*\)\)/);

  const injected = compile('$this->mailer->send($m);', { injectedDeps: MAILER, classMethod: true });
  assert.deepEqual(injected.errors, []);
  assert.match(injected.code, /await rt\.prop\(this, "mailer"\)\.send\(/);
});

test('a refused method is refused only for its own adapter', () => {
  // The `log` adapter has no refused method: the guard must not fire for it.
  const out = compile('$this->logger->info("x");', { injectedDeps: LOG, classMethod: true });
  assert.deepEqual(out.errors, []);
  assert.match(out.code, /\.info\("x"\)/);
  // and the awaited set and the refused set never overlap.
  for (const meth of ADAPTER_ASYNC.mail) {
    assert.ok(!ADAPTER_REFUSED.mail.has(meth), meth + ' cannot be awaited AND refused');
  }
});
