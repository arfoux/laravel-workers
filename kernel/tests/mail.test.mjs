#!/usr/bin/env node
// kernel/tests/mail.test.mjs — the kernel mailer's edge boundary.
//
// The edge sends what Laravel sends for a compiled mailable, and it REFUSES what
// it cannot send faithfully: Laravel's `Mail::raw()`/`Mail::html()` build the
// message themselves, and `Mail::queue()`/`Mail::later()` need a queue consumer
// the Worker does not have. Both fail loud here AND the build refuses the call
// before the code runs (compiler/src/transpiler.mjs + ADAPTER_REFUSED), so no
// route can send a mail that lost its body or a mail that never leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../mail.mjs';
import { Mailable } from '../mailable.mjs';
import { ADAPTER_ASYNC, ADAPTER_REFUSED } from '../service-adapters.mjs';

test('Mail::raw()/Mail::html() fail loud instead of sending half a message', () => {
  const mail = createMailer({ transport: 'log', from: 'app@example.com' });
  for (const method of ['raw', 'html']) {
    assert.throws(
      () => mail[method]('x', () => {}),
      new RegExp('Mail::' + method + '\\(\\) is not supported at the edge'),
      method + ' must refuse the call'
    );
  }
  assert.equal(mail.outbox.length, 0, 'nothing may reach the outbox');
});

test('Mail::queue()/Mail::later() fail loud — the Worker has no queue consumer', () => {
  const mail = createMailer({ transport: 'log' });
  for (const call of [
    () => mail.queue({}),
    () => mail.later(1, {}),
    () => mail.to('a@example.com').queue({}),
  ]) {
    assert.throws(call, /the Worker has no queue consumer|no queue consumer/);
  }
  assert.equal(mail.outbox.length, 0, 'nothing may reach the outbox');
});

test('the supported path still sends: Mail::to($u)->send(payload)', async () => {
  const mail = createMailer({ transport: 'log', from: 'app@example.com' });
  const res = await mail.to('u@example.com').send({ subject: 'S', html: '<b>x</b>' });
  assert.deepEqual(res, { id: 'log-1' });
  assert.deepEqual(mail.outbox[0], {
    from: 'app@example.com',
    to: 'u@example.com',
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'S',
    html: '<b>x</b>',
    text: null,
  });
});

test('buildViewData(): a public property beats with() data (Laravel parity)', async () => {
  class ProbeMail extends Mailable {}
  const mailable = new ProbeMail();
  mailable.foo = 'public-prop';
  mailable.view('mail.tpl');
  mailable.with({ foo: 'with-data' });
  const seen = [];
  await mailable.__lwMail({
    view: (name, data) => {
      seen.push({ name, foo: data.foo });
      return { body: 'x' };
    },
  });
  assert.equal(seen.length, 1, 'the view must render once');
  assert.equal(
    seen[0].foo,
    'public-prop',
    "Illuminate\\Mail\\Mailable::buildViewData() overwrites $this->viewData with the public properties"
  );
});

test('ADAPTER_ASYNC and ADAPTER_REFUSED agree with the kernel mailer', () => {
  const mail = createMailer({ transport: 'log' });
  for (const method of ADAPTER_ASYNC.mail) {
    assert.equal(typeof mail[method], 'function', method + ' must exist on the mailer');
  }
  for (const method of ADAPTER_REFUSED.mail) {
    assert.equal(typeof mail[method], 'function', method + ' must exist so it can fail loud');
    assert.ok(!ADAPTER_ASYNC.mail.has(method), method + ' cannot be awaited AND refused');
  }
});
