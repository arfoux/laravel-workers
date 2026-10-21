#!/usr/bin/env node
// compiler/tests/mail-reach.test.mjs — the class graph a route reaches (the
// mailables' views).
//
// A route does not only render its OWN views: at request time a mailable
// renders ITS view through the ROUTE's runtime (the mailable's __lwMail()
// calls the runtime's view()), so the view of every mailable the route can
// REACH must be in that route's compiled view map - otherwise the request
// answers 500 ("view not compiled") where Laravel answers 200 and sends the
// mail.
//
// "Reach" is the class graph, and the build knows it exactly:
//   - the route's own `new X()` sites (resolved the way the COMPILER
//     resolved them: the build's alias map, not a namespace guess),
//   - a class's constructor dependencies (the runtime builds them),
//   - a class's own `new X()` sites (the compiler resolved them to the FQCN),
//   - the listeners of an event class (the runtime dispatches to them).
// The walk is transitive and it terminates (a listener can dispatch an event
// whose listener dispatches back).
//
// These tests are the CLOSURE over that graph: the route's own `new` sites
// resolve like the compiler's, a mailable is reached directly, through an
// event and through a constructor dependency, and only the app's MAILABLES
// are reported as mailables.
//
// No PHP and no Laravel app: the module is pure - the fixtures are the
// build's own metadata (the alias map, the compiled classes, the dump).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveNewSites, reachableClasses, reachedMailables } from '../src/mail-reach.mjs';

const testsDir = fileURLToPath(new URL('.', import.meta.url));
const MODULE_URL = pathToFileURL(join(testsDir, '..', 'src', 'mail-reach.mjs')).href;

// The app the fixtures describe: a route that ships an order, the event it
// dispatches, the listener of that event and the mailables they send.
const ORDER_MAIL = 'App\\Mail\\OrderMail';
const RECEIPT_MAIL = 'App\\Mail\\ReceiptMail';
const SUBJECT_ONLY_MAIL = 'App\\Mail\\SubjectOnlyMail';
const ORDER_SHIPPED = 'App\\Events\\OrderShipped';
const ORDER_REFUNDED = 'App\\Events\\OrderRefunded';
const NOTIFY = 'App\\Listeners\\NotifyShipped';
const CHECKOUT = 'App\\Services\\Checkout';
const BILLING = 'App\\Services\\Billing';
const GATEWAY = 'App\\Services\\StripeGateway';

// The walk must not loop forever, and a SYNCHRONOUS infinite loop cannot be
// interrupted from this process (the deadline never fires - the event loop is
// blocked), so the cycle is walked in a CHILD process: the child is killed
// when the deadline passes and the test fails with the reason.
function walkInChild(input, deadlineMs) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-mail-reach-'));
  const probe = join(dir, 'probe.mjs');
  const result = join(dir, 'reached.json');
  writeFileSync(
    probe,
    [
      "import { writeFileSync } from 'node:fs';",
      'import { reachableClasses } from ' + JSON.stringify(MODULE_URL) + ';',
      'const input = JSON.parse(process.argv[2]);',
      'const { reached } = reachableClasses(input.newClasses, input.meta, input.ctx);',
      'writeFileSync(' + JSON.stringify(result) + ", JSON.stringify([...reached]), 'utf8');",
    ].join('\n'),
    'utf8'
  );
  const res = spawnSync(process.execPath, [probe, JSON.stringify(input)], {
    encoding: 'utf8',
    timeout: deadlineMs,
  });
  let reached = [];
  let failure = null;
  if (res.error && res.error.code === 'ETIMEDOUT') {
    failure = 'the walk did not answer within ' + deadlineMs + 'ms (it looped forever)';
  } else if (res.status !== 0) {
    failure = 'the walk failed: ' + String(res.stderr || '').trim();
  } else {
    reached = JSON.parse(readFileSync(result, 'utf8'));
  }
  rmSync(dir, { recursive: true, force: true });
  return { reached, failure };
}

test('mail-reach: the route\'s `new` resolves the way the COMPILER resolves it (the build\'s alias map)', () => {
  const meta = {
    fqcns: [ORDER_MAIL, ORDER_SHIPPED],
    aliases: { OrderMail: ORDER_MAIL, OrderShipped: ORDER_SHIPPED },
  };
  // The extract guesses the FQCN from the file's namespace; the compiler
  // resolves the short name through the build's alias map, and the graph must
  // follow the compiler (the two must agree on WHICH class is instantiated).
  const guessed = 'App\\Http\\Controllers\\OrderMail';
  assert.deepEqual(resolveNewSites([{ alias: 'OrderMail', fqcn: guessed }], meta), [ORDER_MAIL]);
  // The FQCN-written form: the class itself.
  assert.deepEqual(resolveNewSites([{ alias: '\\' + ORDER_MAIL, fqcn: ORDER_MAIL }], meta), [ORDER_MAIL]);
  // The same class written twice (short and FQCN) is one class.
  assert.deepEqual(
    resolveNewSites([{ alias: 'OrderMail', fqcn: guessed }, { alias: ORDER_MAIL, fqcn: ORDER_MAIL }], meta),
    [ORDER_MAIL]
  );
});

test('mail-reach: a `new` the compiler could not resolve reaches nothing (the route was stopped at build time)', () => {
  const meta = {
    fqcns: [ORDER_MAIL],
    aliases: { OrderMail: ORDER_MAIL },
  };
  // A class the build did not compile: the route that instantiates it was
  // stopped, so the graph knows nothing about it.
  assert.deepEqual(resolveNewSites([{ alias: 'Missing', fqcn: 'App\\Missing' }], meta), []);
  // An ambiguous short name is absent from the alias map (the compiler cannot
  // tell the two classes apart) - it resolves to nothing either.
  assert.deepEqual(resolveNewSites([{ alias: 'Ambiguous', fqcn: 'App\\Ambiguous' }], meta), []);
});

test('mail-reach: the route reaches a mailable DIRECTLY (its own `new`)', () => {
  const newClasses = [{ alias: 'OrderMail', fqcn: ORDER_MAIL }];
  const meta = { fqcns: [ORDER_MAIL], aliases: { OrderMail: ORDER_MAIL } };
  const ctx = {
    classMeta: { [ORDER_MAIL]: { instantiated: [] } },
    dumpClasses: { [ORDER_MAIL]: { kind: 'mailable', ctor: [] } },
    events: {},
  };
  const { reached, seeds } = reachableClasses(newClasses, meta, ctx);
  assert.deepEqual(seeds, [ORDER_MAIL], 'the route\'s own `new` is the seed');
  assert.deepEqual([...reached], [ORDER_MAIL], 'the mailable is reached');
  assert.deepEqual(reachedMailables(reached, ctx.dumpClasses), [ORDER_MAIL]);
});

test('mail-reach: the route reaches a mailable THROUGH AN EVENT (the event, its listener, the mailable the listener sends)', () => {
  const newClasses = [{ alias: 'OrderShipped', fqcn: ORDER_SHIPPED }];
  const meta = { fqcns: [ORDER_SHIPPED], aliases: { OrderShipped: ORDER_SHIPPED } };
  const ctx = {
    // The listener's own `new` (the compiler resolved it to the FQCN).
    classMeta: { [NOTIFY]: { instantiated: [ORDER_MAIL] } },
    dumpClasses: {
      [ORDER_SHIPPED]: { kind: 'event', ctor: [] },
      [NOTIFY]: { kind: 'listener', ctor: [] },
      [ORDER_MAIL]: { kind: 'mailable', ctor: [] },
    },
    events: { [ORDER_SHIPPED]: { listeners: [NOTIFY] } },
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.ok(reached.has(ORDER_SHIPPED), 'the event the route dispatches is reached');
  assert.ok(reached.has(NOTIFY), 'the listener of that event is reached');
  assert.ok(reached.has(ORDER_MAIL), 'the mailable the listener sends is reached');
  assert.deepEqual(reachedMailables(reached, ctx.dumpClasses), [ORDER_MAIL]);
});

test('mail-reach: a constructor dependency is an edge (the runtime builds it)', () => {
  const newClasses = [{ alias: 'Checkout', fqcn: CHECKOUT }];
  const meta = { fqcns: [CHECKOUT], aliases: { Checkout: CHECKOUT } };
  const ctx = {
    classMeta: {},
    dumpClasses: {
      [CHECKOUT]: {
        kind: 'service',
        ctor: [
          // A class of the app: the runtime builds it.
          { name: 'billing', kind: 'class', type: BILLING },
          // An interface: the container binds it to a concrete class, and THAT
          // is the class the runtime builds.
          { name: 'gateway', kind: 'class', type: 'App\\Contracts\\Gateway', impl: GATEWAY },
          // A framework service: the edge adapts it, it is not a class of the app.
          { name: 'mailer', kind: 'external', type: 'Illuminate\\Mail\\Mailer' },
        ],
      },
    },
    events: {},
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.ok(reached.has(BILLING), 'the class-typed dependency is reached');
  assert.ok(reached.has(GATEWAY), 'the concrete binding of the interface is reached');
  assert.ok(!reached.has('App\\Contracts\\Gateway'), 'the interface itself is not the class the runtime builds');
  assert.ok(!reached.has('Illuminate\\Mail\\Mailer'), 'a framework service is not a class of the app');
});

test('mail-reach: the walk is transitive (a service reaches the service it builds, which reaches the mailable)', () => {
  const newClasses = [{ alias: 'Checkout', fqcn: CHECKOUT }];
  const meta = { fqcns: [CHECKOUT, BILLING], aliases: { Checkout: CHECKOUT } };
  const ctx = {
    // The service the checkout builds; that service news the mailable.
    classMeta: { [BILLING]: { instantiated: [RECEIPT_MAIL] } },
    dumpClasses: {
      [CHECKOUT]: { kind: 'service', ctor: [{ name: 'billing', kind: 'class', type: BILLING }] },
      [BILLING]: { kind: 'service', ctor: [] },
      [RECEIPT_MAIL]: { kind: 'mailable', ctor: [] },
    },
    events: {},
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.deepEqual([...reached].sort(), [BILLING, CHECKOUT, RECEIPT_MAIL].sort());
  assert.deepEqual(reachedMailables(reached, ctx.dumpClasses), [RECEIPT_MAIL]);
});

test('mail-reach: the walk terminates on a cycle (a listener dispatches an event whose listener dispatches back)', () => {
  const input = {
    newClasses: [{ alias: 'OrderShipped', fqcn: ORDER_SHIPPED }],
    meta: { fqcns: [ORDER_SHIPPED, ORDER_REFUNDED], aliases: { OrderShipped: ORDER_SHIPPED } },
    ctx: {
      classMeta: {},
      dumpClasses: {
        [ORDER_SHIPPED]: { kind: 'event', ctor: [] },
        [ORDER_REFUNDED]: { kind: 'event', ctor: [] },
      },
      events: {
        [ORDER_SHIPPED]: { listeners: [ORDER_REFUNDED] },
        [ORDER_REFUNDED]: { listeners: [ORDER_SHIPPED] },
      },
    },
  };
  const out = walkInChild(input, 5000);
  assert.equal(out.failure, null, out.failure || 'the walk answered');
  assert.deepEqual(out.reached.sort(), [ORDER_REFUNDED, ORDER_SHIPPED].sort());
});

test('mail-reach: a class reachable by two paths is reached once', () => {
  const newClasses = [
    { alias: 'Checkout', fqcn: CHECKOUT },
    { alias: 'Billing', fqcn: BILLING },
  ];
  const meta = { fqcns: [CHECKOUT, BILLING], aliases: { Checkout: CHECKOUT, Billing: BILLING } };
  const ctx = {
    // Both services send the SAME mailable.
    classMeta: {
      [CHECKOUT]: { instantiated: [RECEIPT_MAIL] },
      [BILLING]: { instantiated: [RECEIPT_MAIL] },
    },
    dumpClasses: {
      [CHECKOUT]: { kind: 'service', ctor: [] },
      [BILLING]: { kind: 'service', ctor: [] },
      [RECEIPT_MAIL]: { kind: 'mailable', ctor: [] },
    },
    events: {},
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.equal(reached.size, 3, 'the two services and the one mailable');
  assert.deepEqual(reachedMailables(reached, ctx.dumpClasses), [RECEIPT_MAIL], 'the mailable is reported once');
});

test('mail-reach: only the app\'s MAILABLES are mailables (an event or a listener is not one)', () => {
  const newClasses = [{ alias: 'OrderShipped', fqcn: ORDER_SHIPPED }];
  const meta = { fqcns: [ORDER_SHIPPED], aliases: { OrderShipped: ORDER_SHIPPED } };
  const ctx = {
    // The listener news a mailable and a class the dump does not know.
    classMeta: { [NOTIFY]: { instantiated: [ORDER_MAIL, 'App\\Services\\Unknown'] } },
    dumpClasses: {
      [ORDER_SHIPPED]: { kind: 'event', ctor: [] },
      [NOTIFY]: { kind: 'listener', ctor: [] },
      [ORDER_MAIL]: { kind: 'mailable', ctor: [] },
    },
    events: { [ORDER_SHIPPED]: { listeners: [NOTIFY] } },
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.ok(reached.has(NOTIFY), 'the listener is reached');
  assert.ok(reached.has('App\\Services\\Unknown'), 'the class the listener news is reached');
  assert.deepEqual(
    reachedMailables(reached, ctx.dumpClasses),
    [ORDER_MAIL],
    'the event, the listener and the unknown class are not mailables'
  );
});

test('mail-reach: a mailable with NO view is still a mailable (the dump lists every app mailable)', () => {
  const newClasses = [{ alias: 'SubjectOnlyMail', fqcn: SUBJECT_ONLY_MAIL }];
  const meta = { fqcns: [SUBJECT_ONLY_MAIL], aliases: { SubjectOnlyMail: SUBJECT_ONLY_MAIL } };
  // A mailable that renders no view (only a subject) is legal, and the dump
  // lists it like every other app mailable - the build must know it exists.
  const ctx = {
    classMeta: {},
    dumpClasses: { [SUBJECT_ONLY_MAIL]: { kind: 'mailable' } },
    events: {},
  };
  const { reached } = reachableClasses(newClasses, meta, ctx);
  assert.deepEqual(reachedMailables(reached, ctx.dumpClasses), [SUBJECT_ONLY_MAIL]);
});
