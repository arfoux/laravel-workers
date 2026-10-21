#!/usr/bin/env node
// compiler/tests/rt-mail.test.mjs — the mail construct.
//
// A mailable is a class: the build compiles it (the class compiler + the
// kernel's Mailable base) and the mailer sends the payload Laravel sends -
// the recipients, the subject and the rendered view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';
import { createMailer } from '../../kernel/mail.mjs';

function makeRt() {
  const mailer = createMailer({ transport: 'log', from: 'hello@example.com' });
  return {
    rt: buildRt(
      {},
      {
        http: { mail: mailer },
        classes: {
          'App\\Mail\\OrderMail': {
            base: 'mailable',
            ctor: (args, deps) => ({}),
            deps: [],
            methods: {
              build: async function () {
                this.subject('Order shipped');
                this.view('mail.order');
                this.with({ id: 7 });
                return this;
              },
            },
          },
        },
        views: {
          'mail.order': {
            context: {},
            // A compiled view writes into the runtime's output (rt.echo).
            main: (rt) => {
              rt.echo('<p>Order ' + rt.var('id') + '</p>');
            },
          },
        },
      }
    ),
    mailer,
  };
}

test('rt-mail: the mailable renders its view and the mailer sends the payload', async () => {
  const { rt, mailer } = makeRt();
  const mailable = rt.newClass('App\\Mail\\OrderMail', []);
  await rt.mail().to('buyer@example.com').send(mailable);
  assert.equal(mailer.outbox.length, 1);
  const sent = mailer.outbox[0];
  assert.equal(sent.to, 'buyer@example.com');
  assert.equal(sent.subject, 'Order shipped');
  // The view is rendered with the mailable's data (Laravel renders the
  // mailable's view too).
  assert.equal(sent.html, '<p>Order 7</p>');
  // Laravel's message has no text body when the mailable has no text view.
  assert.equal(sent.text, null);
});

test('rt-mail: the recipients are the mailable\'s + the pending\'s (Laravel appends them)', async () => {
  // Laravel's PendingMail::send(): the pending's recipients are APPENDED to the
  // mailable's own (Mailable::setAddress() dedupes by address, the last
  // occurrence wins).
  const { rt, mailer } = makeRt();
  const mailable = rt.newClass('App\\Mail\\OrderMail', []);
  mailable.to('owner@example.com');
  await rt.mail().to('buyer@example.com').send(mailable);
  assert.equal(mailer.outbox.length, 1);
  assert.deepEqual(mailer.outbox[0].to, ['owner@example.com', 'buyer@example.com']);
  assert.equal(mailer.outbox[0].subject, 'Order shipped');
  // The from falls back to the app's mail.from (Laravel: the mailable's own
  // ?? the app's config).
  assert.equal(mailer.outbox[0].from, 'hello@example.com');
});
