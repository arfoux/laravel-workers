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
          // The property form (`public $view = 'mail.property';` with the empty
          // constructor `make:mail` scaffolds): the declared fields are on the
          // instance, so the payload finds the view.
          'App\\Mail\\PropertyMail': {
            base: 'mailable',
            ctor: (args, deps) => {
              const __self = {};
              Object.assign(__self, { "view": "mail.property", "subject": "Property subject" });
              return __self;
            },
            deps: [],
            methods: {},
          },
          // Declares the Mailable surface (`public $view`) AND calls the fluent
          // setters: PHP keeps the property and the method apart, JS cannot.
          'App\\Mail\\BothMail': {
            base: 'mailable',
            ctor: (args, deps) => {
              const __self = {};
              Object.assign(__self, { "__view": "mail.declared", "__subject": "Declared subject" });
              return __self;
            },
            deps: [],
            methods: {
              build: async function () {
                this.subject('Fluent subject');
                this.view('mail.order');
                this.with({ id: 7 });
                return this;
              },
            },
          },
          // A mailable with no view at all.
          'App\\Mail\\NoViewMail': {
            base: 'mailable',
            ctor: (args, deps) => ({}),
            deps: [],
            methods: {},
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
          'mail.property': {
            context: {},
            main: (rt) => {
              rt.echo('<p>Property</p>');
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

test('rt-mail: a mailable with no view fails loud (Laravel: "Invalid view.")', async () => {
  // Probed with the vendored Laravel 13: `(new NoViewMail())->render()` throws
  // `InvalidArgumentException: Invalid view.` (Mailable::buildView() answers
  // null, Mailer::render(null) refuses). The edge used to send a mail with a
  // null body - a silent 200 where Laravel answers 500.
  const { rt } = makeRt();
  const mailable = rt.newClass('App\\Mail\\NoViewMail', []);
  await assert.rejects(() => rt.mail().to('buyer@example.com').send(mailable), /Invalid view\./);
});

test('rt-mail: the property form carries the view (a public field, no build())', async () => {
  // `public $view = 'mail.property';` - the class compiler carries the declared
  // public property, so the payload renders it (a mailable scaffolded by
  // `make:mail` has an EMPTY constructor: the property must survive that too).
  const { rt, mailer } = makeRt();
  const mailable = rt.newClass('App\\Mail\\PropertyMail', []);
  await rt.mail().to('buyer@example.com').send(mailable);
  assert.equal(mailer.outbox.length, 1);
  assert.equal(mailer.outbox[0].subject, 'Property subject');
  assert.equal(mailer.outbox[0].html, '<p>Property</p>');
});

test('rt-mail: a mailable may declare $view AND call view() (PHP keeps them apart)', async () => {
  // PHP has separate namespaces for a property and a method, so a mailable
  // that declares `public $view` may still call `$this->view('x')`. JS has one
  // namespace: an own `view` property would shadow Mailable.prototype.view()
  // and the fluent call would throw "view is not a function" (probed). The
  // declared surface lands in the kernel's private fields instead.
  const { rt, mailer } = makeRt();
  const mailable = rt.newClass('App\\Mail\\BothMail', []);
  await rt.mail().to('buyer@example.com').send(mailable);
  assert.equal(mailer.outbox.length, 1);
  // The fluent setter ran and the mail is not empty.
  assert.equal(mailer.outbox[0].subject, 'Fluent subject');
  assert.equal(mailer.outbox[0].html, '<p>Order 7</p>');
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
