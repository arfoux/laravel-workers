// compiler/tests/classes.test.mjs — the class compiler (the event listeners).
//
// The listeners are classes: at the edge there is no listener runtime, so
// the build compiles them (the constructor, the methods) and the dispatch
// calls them (Laravel dispatches synchronously).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileClasses } from '../src/classes.mjs';
import { emitController } from '../src/controller.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';
import { createMailer } from '../../kernel/mail.mjs';

// A class file in a temp dir (the compiler reads the app's sources).
function classFile(name, source) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-classes-'));
  const file = join(dir, name + '.php');
  writeFileSync(file, source, 'utf8');
  return file;
}

// The compiled registry as a module (the build writes it to
// dist/src/classes.generated.mjs): the test imports it, so the runtime runs
// the very code the build emits.
async function compiledModule(code) {
  const file = join(mkdtempSync(join(tmpdir(), 'lw-classes-')), 'classes.generated.mjs');
  writeFileSync(file, code, 'utf8');
  return import(pathToFileURL(file).href);
}

const EVENT_SOURCE = `<?php
namespace App\\Events;

class PostPublished
{
    public function __construct(public int $postId, public string $title = 'x')
    {
    }
}
`;

const LISTENER_SOURCE = `<?php
namespace App\\Listeners;

use App\\Events\\PostPublished;

class MarkPostNotified
{
    public function handle(PostPublished $event): void
    {
        $this->seen = $event->postId;
    }
}
`;

const OPTIONS = {
  modelAliases: new Set(),
  modelNotCompiled: new Map(),
  modelClassFqcns: {},
  classes: new Set(['App\\Events\\PostPublished', 'App\\Listeners\\MarkPostNotified']),
};

test('classes: the constructor compiles (the promoted properties)', () => {
  const file = classFile('PostPublished', EVENT_SOURCE);
  const res = compileClasses(
    {
      events: { 'App\\Events\\PostPublished': { file, listeners: [] } },
      classes: { 'App\\Events\\PostPublished': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /"postId": \(args\[0\]/);
  assert.match(res.code, /"title": \(args\[1\] === undefined \? "x" : args\[1\]\)/);
});

test('classes: a method compiles (and `$this` is the instance)', () => {
  const file = classFile('MarkPostNotified', LISTENER_SOURCE);
  const res = compileClasses(
    {
      events: { 'App\\Events\\PostPublished': { file: classFile('PostPublished', EVENT_SOURCE), listeners: ['App\\Listeners\\MarkPostNotified'] } },
      classes: { 'App\\Listeners\\MarkPostNotified': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /"handle": async function \(rt, v_event\)/);
  assert.match(res.code, /rt\.propSet\(this, "seen"/);
});

test('classes: a constructor with a body compiles (the assignments land on the object)', () => {
  const file = classFile('WithBody', `<?php
namespace App\\Events;
class WithBody
{
    public function __construct(public int $id)
    {
        $this->doubled = $this->id * 2;
    }
}
`);
  const res = compileClasses(
    { events: {}, classes: { 'App\\Events\\WithBody': { file, kind: 'event' } } },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /ctor: function \(args, deps\)/);
  assert.match(res.code, /const __self = \{/);
  assert.match(res.code, /rt\.propSet\(__self, "doubled"/);
  assert.match(res.code, /return __self;/);
});

test('classes: a listener that takes a service fails loud', () => {
  const file = classFile('WithService', `<?php
namespace App\\Listeners;
class WithService
{
    public function handle(\\App\\Events\\PostPublished $event, \\Illuminate\\Log\\Logger $log): void
    {
    }
}
`);
  const res = compileClasses(
    { events: {}, classes: { 'App\\Listeners\\WithService': { file } } },
    OPTIONS
  );
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /cannot inject a service/);
});

test('classes: a listener that injects a service the build does not compile fails loud', () => {
  // The service is not in the dump: the edge cannot build it, so the build
  // stops and names it. It used to compile - the property stayed undefined and
  // the request died at runtime (a 500 the build said nothing about).
  const file = classFile('WithService', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
use App\\Services\\Mailer;
class WithService
{
    public function __construct(private Mailer $mailer)
    {
    }
    public function handle(PostPublished $event): void
    {
        $this->mailer->send($event);
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\WithService'],
        },
      },
      classes: { 'App\\Listeners\\WithService': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /Mailer/);
  // The class is not compiled: the dispatch would be a silent no-op.
  assert.equal(Object.keys(res.meta).length, 0);
});

test('classes: a listener that calls its own private helper compiles the helper (the compiled body must not call a method that does not exist)', async () => {
  // The helper is the CLASS's own method (Laravel calls it from inside the
  // class), so the edge has to carry it - nothing else does. A helper that is
  // not compiled is a method that does not exist at the edge: the compiled
  // handle() would call it and die with a TypeError at request time, while
  // the build is green.
  const eventFile = classFile('PostPublished', EVENT_SOURCE);
  const file = classFile('MarkPostNotified', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class MarkPostNotified
{
    public function handle(PostPublished $event): string
    {
        return $this->format($event);
    }
    private function format(PostPublished $event): string
    {
        return 'post-' . $event->postId;
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': { file: eventFile, listeners: ['App\\Listeners\\MarkPostNotified'] },
      },
      classes: {
        'App\\Events\\PostPublished': { file: eventFile, kind: 'event' },
        'App\\Listeners\\MarkPostNotified': { file },
      },
    },
    { ...OPTIONS, classes: new Set(['App\\Events\\PostPublished', 'App\\Listeners\\MarkPostNotified']) }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The private helper is compiled (the registry carries it).
  assert.match(res.code, /"format":/);
  // The compiled handle() calls it.
  assert.match(res.code, /this\.format\(/);
  // The dispatch answers Laravel's value: the helper ran and its answer came
  // back (a promise that leaked in would answer {}).
  const mod = await compiledModule(res.code);
  const rt = buildRt({}, { http: {}, classes: mod.classes, eventListeners: mod.eventListeners });
  const event = rt.newClass('App\\Events\\PostPublished', [7]);
  const answer = await rt.event.dispatch(event);
  assert.deepEqual(answer, ['post-7']);
});

test('classes: a listener that injects a MODEL fails loud with the model\'s reason (a service is another thing)', () => {
  // Laravel's container BUILDS a model (Illuminate\Container\Container:
  // `build()` - a concrete class is instantiable), so the reason must not
  // claim that Laravel cannot resolve it: the edge cannot PROVIDE one (the
  // class is instantiated with no arguments). A service the build does not
  // compile is a different thing - it gets the service's reason.
  const file = classFile('WithModel', `<?php
namespace App\\Listeners;
use App\\Models\\Post;
class WithModel
{
    public function __construct(private Post $post)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    { events: {}, classes: { 'App\\Listeners\\WithModel': { file } } },
    { ...OPTIONS, modelClassFqcns: { Post: 'App\\Models\\Post' } }
  );
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /asks for the model App\\Models\\Post/);
  assert.equal(res.errors[0].code, 'LW002');

  const serviceFile = classFile('WithService', `<?php
namespace App\\Listeners;
use App\\Services\\Mailer;
class WithService
{
    public function __construct(private Mailer $mailer)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
    }
}
`);
  const serviceRes = compileClasses(
    { events: {}, classes: { 'App\\Listeners\\WithService': { file: serviceFile } } },
    { ...OPTIONS, modelClassFqcns: { Post: 'App\\Models\\Post' } }
  );
  assert.equal(serviceRes.errors.length, 1);
  // The service is not a model: the reason must say so.
  assert.match(serviceRes.errors[0].message, /asks for App\\Services\\Mailer/);
  assert.doesNotMatch(serviceRes.errors[0].message, /the model/);
});
test('classes: a listener that injects a compiled service compiles (the edge builds it)', () => {
  const serviceFile = classFile('Mailer', `<?php
namespace App\\Services;
class Mailer
{
    public function send(string $to): void
    {
    }
}
`);
  const file = classFile('WithService', `<?php
namespace App\\Listeners;
use App\\Services\\Mailer;
class WithService
{
    public function __construct(private Mailer $mailer)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\WithService'],
        },
      },
      classes: {
        'App\\Listeners\\WithService': { file },
        'App\\Services\\Mailer': { file: serviceFile },
      },
    },
    {
      ...OPTIONS,
      classes: new Set(['App\\Events\\PostPublished', 'App\\Listeners\\WithService', 'App\\Services\\Mailer']),
    }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The dependency is recorded: the edge builds the service and hands it over.
  assert.match(res.code, /"param":"mailer"/);
  assert.match(res.code, /"kind":"class"/);
  assert.match(res.code, /"type":"App\\\\Services\\\\Mailer"/);
  assert.match(res.code, /deps\["mailer"\]/);
});
test('classes: a listener that injects a framework service compiles (the edge adapter of it)', () => {
  const file = classFile('WithMailer', `<?php
namespace App\\Listeners;
class WithMailer
{
    public function __construct(private \\Illuminate\\Contracts\\Mail\\Mailer $mailer)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\WithMailer'],
        },
      },
      classes: { 'App\\Listeners\\WithMailer': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The mailer is adapted: the edge hands the live one over.
  assert.match(res.code, /"adapter":"mail"/);
  assert.match(res.code, /"type":"Illuminate\\\\Contracts\\\\Mail\\\\Mailer"/);
});

test('classes: a listener whose constructor needs an argument fails loud', () => {
  const file = classFile('NeedsArg', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class NeedsArg
{
    public function __construct(int $tries)
    {
    }
    public function handle(PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\NeedsArg'],
        },
      },
      classes: { 'App\\Listeners\\NeedsArg': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1);
  // Laravel's container cannot resolve a scalar without a default either: it
  // throws a BindingResolutionException - so the reason must not claim that
  // Laravel resolves it.
  assert.match(res.errors[0].message, /BindingResolutionException/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: the event dispatch compiles (and the handler imports the classes)', () => {
  const src = `<?php
namespace App\\Http\\Controllers;
use App\\Events\\PostPublished;
class C {
    public function demo()
    {
        \\Illuminate\\Support\\Facades\\Event::dispatch(new PostPublished(2));
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', {
    routeUri: '/x',
    routeParams: [],
    models: [],
    views: [],
    classes: {
      fqcns: ['App\\Events\\PostPublished'],
      aliases: { PostPublished: 'App\\Events\\PostPublished' },
    },
  });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.event\.dispatch\(rt\.newClass\("App\\\\Events\\\\PostPublished", \[2\]\)\)/);
  assert.match(res.code, /import \{ classes as LW_CLASSES, eventListeners as LW_EVENT_LISTENERS \}/);
  assert.match(res.code, /eventListeners: LW_EVENT_LISTENERS,/);
});

test('classes: a dispatch of an event *name* fails loud (no class, no listener)', () => {
  const src = `<?php
namespace App\\Http\\Controllers;
class C {
    public function demo()
    {
        \\Illuminate\\Support\\Facades\\Event::dispatch('post.created');
        return response('ok');
    }
}
`;
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /compiled event class/);
});

test('classes: a queued listener (ShouldQueue) is not compiled', () => {
  // Laravel pushes a queued listener to the queue (it runs later); the edge has
  // no consumer, so running it inline would be a different behaviour.
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: 'x.php',
          listeners: ['App\\Listeners\\Queued'],
          queued: ['App\\Listeners\\Queued'],
        },
      },
      classes: { 'App\\Listeners\\Queued': { file: 'x.php' } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /ShouldQueue/);
  assert.equal(Object.keys(res.meta).length, 0);
});

test('classes: the runtime dispatches to the compiled listener (Laravel: synchronous)', async () => {
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Events\\PostPublished': {
        ctor: (args) => ({ postId: args[0] }),
        methods: {},
      },
      'App\\Listeners\\MarkPostNotified': {
        ctor: () => ({}),
        methods: {
          handle: async function (rt2, event) {
            this.seen = event.postId;
            return null;
          },
        },
      },
    },
    eventListeners: {
      'App\\Events\\PostPublished': ['App\\Listeners\\MarkPostNotified'],
    },
  });
  const event = rt.newClass('App\\Events\\PostPublished', [7]);
  assert.equal(event.postId, 7);
  // Laravel's Dispatcher::dispatch() returns the ARRAY of the responses (one
  // per listener, a listener that returns nothing answers null).
  const answer = await rt.event.dispatch(event);
  assert.deepEqual(answer, [null]);
});

test('classes: the dispatch runs every listener (Laravel: only a false answer stops the chain)', async () => {
  // Laravel: dispatch() runs EVERY listener; only dispatchUntil() (the halt
  // flag) stops at the first non-null answer; a listener that answers false
  // breaks the chain and its answer is discarded.
  const seen = [];
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Events\\PostPublished': { ctor: (args) => ({ postId: args[0] }), methods: {} },
      'App\\Listeners\\First': {
        ctor: () => ({}),
        methods: { handle: async function () { seen.push('first'); return 'an answer'; } },
      },
      'App\\Listeners\\Second': {
        ctor: () => ({}),
        methods: { handle: async function () { seen.push('second'); return null; } },
      },
      'App\\Listeners\\Third': {
        ctor: () => ({}),
        methods: { handle: async function () { seen.push('third'); return null; } },
      },
    },
    eventListeners: {
      'App\\Events\\PostPublished': ['App\\Listeners\\First', 'App\\Listeners\\Second', 'App\\Listeners\\Third'],
    },
  });
  const event = rt.newClass('App\\Events\\PostPublished', [1]);
  const answer = await rt.event.dispatch(event);
  // The first listener answers - the second and the third still run.
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.deepEqual(answer, ['an answer', null, null]);
});

test('classes: a listener that answers false stops the chain (Laravel)', async () => {
  const seen = [];
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Events\\PostPublished': { ctor: (args) => ({ postId: args[0] }), methods: {} },
      'App\\Listeners\\Stops': {
        ctor: () => ({}),
        methods: { handle: async function () { seen.push('stops'); return false; } },
      },
      'App\\Listeners\\Never': {
        ctor: () => ({}),
        methods: { handle: async function () { seen.push('never'); return null; } },
      },
    },
    eventListeners: {
      'App\\Events\\PostPublished': ['App\\Listeners\\Stops', 'App\\Listeners\\Never'],
    },
  });
  const event = rt.newClass('App\\Events\\PostPublished', [1]);
  const answer = await rt.event.dispatch(event);
  // The false answer stops the chain and is discarded (Laravel breaks before
  // pushing it).
  assert.deepEqual(seen, ['stops']);
  assert.deepEqual(answer, []);
});

test('classes: a circular service dependency fails loud at build time (Laravel names the cycle)', () => {
  // The build knows the whole graph (each compiled class records its deps),
  // so the cycle is named at build time - the runtime guard is the safety
  // net, not the first line of defence.
  const a = classFile('A', `<?php
namespace App\\Services;
use App\\Services\\B;
class A
{
    public function __construct(private B $b)
    {
    }
}
`);
  const b = classFile('B', `<?php
namespace App\\Services;
use App\\Services\\A;
class B
{
    public function __construct(private A $a)
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {},
      classes: { 'App\\Services\\A': { file: a }, 'App\\Services\\B': { file: b } },
    },
    { ...OPTIONS, classes: new Set(['App\\Services\\A', 'App\\Services\\B']) }
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /Circular dependency detected \[App\\Services\\A, App\\Services\\B, App\\Services\\A\]/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: the runtime names a circular service dependency (Laravel: circular dependency detected)', async () => {
  // A service that needs a service that needs it back: the edge would recurse
  // forever (a stack overflow with no cause). Laravel names the cycle.
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Services\\A': { ctor: () => ({}), methods: {}, deps: [{ param: 'b', kind: 'class', type: 'App\\Services\\B' }] },
      'App\\Services\\B': { ctor: () => ({}), methods: {}, deps: [{ param: 'a', kind: 'class', type: 'App\\Services\\A' }] },
    },
  });
  assert.throws(
    () => rt.newClass('App\\Services\\A', []),
    /circular dependency detected \[App\\Services\\A -> App\\Services\\B -> App\\Services\\A\]/
  );
});

test('classes: the runtime fails loud on an event without a compiled class', async () => {
  const rt = buildRt({}, { http: {}, classes: {}, eventListeners: {} });
  await assert.rejects(() => rt.event.dispatch({ postId: 1 }), /not an instance of a compiled event class/);
});


test('classes: the runtime hands the live service over (the mailer)', () => {
  // The edge has no container: the worker hands the live service down and the
  // compiled listener gets it.
  const mailer = { send: async () => ({ id: 'x' }) };
  const rt = buildRt({}, {
    http: { mail: mailer },
    classes: {
      'App\\Listeners\\WithMailer': {
        ctor: (args, deps) => ({ mailer: deps.mailer }),
        deps: [{ param: 'mailer', kind: 'adapter', type: 'Illuminate\\Contracts\\Mail\\Mailer', adapter: 'mail' }],
        methods: {},
      },
    },
  });
  const obj = rt.newClass('App\\Listeners\\WithMailer', []);
  assert.equal(obj.mailer, mailer);
});
test('classes: the runtime fails loud when the worker hands down no service', () => {
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Listeners\\WithMailer': {
        ctor: (args, deps) => ({ mailer: deps.mailer }),
        deps: [{ param: 'mailer', kind: 'adapter', type: 'Illuminate\\Contracts\\Mail\\Mailer', adapter: 'mail' }],
        methods: {},
      },
    },
  });
  assert.throws(() => rt.newClass('App\\Listeners\\WithMailer', []), /is not available at the edge/);
});
test('classes: the runtime builds the app service the listener injects', () => {
  const rt = buildRt({}, {
    http: {},
    classes: {
      'App\\Services\\Mailer': { ctor: () => ({ sent: [] }), deps: [], methods: {} },
      'App\\Listeners\\WithService': {
        ctor: (args, deps) => ({ mailer: deps.mailer }),
        deps: [{ param: 'mailer', kind: 'class', type: 'App\\Services\\Mailer' }],
        methods: {},
      },
    },
  });
  const obj = rt.newClass('App\\Listeners\\WithService', []);
  assert.ok(Array.isArray(obj.mailer.sent));
});
test('classes: the queue fails loud at the edge (nothing consumes the binding)', () => {
  const rt = buildRt({}, { http: { queue: { push: async () => ({}) } } });
  assert.throws(() => rt.queue().push('App\\Jobs\\SendInvoice', []), /would never run at the edge/);
});

test('classes: the injected mailer is awaited in the compiled body (a promise must not leak)', () => {
  const file = classFile('WithMailer', `<?php
namespace App\\Listeners;
class WithMailer
{
    public function __construct(private \\Illuminate\\Contracts\\Mail\\Mailer $mailer)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
        $this->mailer->send($event);
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\WithMailer'],
        },
      },
      classes: { 'App\\Listeners\\WithMailer': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /await rt\.prop\(this, "mailer"\)\.send\(/);
});

test('classes: a mailable with a PROTECTED build() compiles (every method of the class is the mailable\'s own)', () => {
  // The class compiler compiles EVERY method of the class (the protected and
  // the private ones too). Laravel's Mailable carries the surface (the
  // subject(), the view(), the with() - Illuminate\Mail\Mailable:36) and the
  // kernel's base carries it at the edge, so the app's own methods are the
  // mailable's own: a mailable with a protected build() has one - without it
  // the payload would be empty.
  const file = classFile('OrderMail', `<?php
namespace App\\Mail;
class OrderMail
{
    public $order;
    protected function build(): self
    {
        $this->subject('Order shipped');
        $this->view('mail.order');
        $this->with(['id' => 7]);
        return $this;
    }
    protected function formatOrder(): string
    {
        return 'order';
    }
}
`);
  const res = compileClasses(
    {
      events: {},
      classes: { 'App\\Mail\\OrderMail': { file, kind: 'mailable' } },
    },
    { ...OPTIONS, classes: new Set(['App\\Mail\\OrderMail']) }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The protected build() and the protected helper are compiled.
  assert.match(res.code, /"build":/);
  assert.match(res.code, /"formatOrder":/);
});

test('classes: a mailable that calls its own PRIVATE helper compiles the helper (the helper is the mailable\'s own)', async () => {
  // Laravel's Mailable carries the surface (Illuminate\Mail\Mailable:
  // `subject()`, `view()`, `with()`), and the kernel's base carries it at the
  // edge (kernel/mailable.mjs). The app's own methods are the mailable's own:
  // build() and the helpers build() calls. A helper that is not compiled is
  // a method that does not exist at the edge: the compiled build() would call
  // it and die with a TypeError at request time, while the build is green.
  const file = classFile('OrderMail', `<?php
namespace App\\Mail;
class OrderMail
{
    protected function build(): self
    {
        $this->subject('Order ' . $this->formatOrder());
        return $this;
    }
    private function formatOrder(): string
    {
        return 'shipped';
    }
}
`);
  const res = compileClasses(
    {
      events: {},
      classes: { 'App\\Mail\\OrderMail': { file, kind: 'mailable' } },
    },
    { ...OPTIONS, classes: new Set(['App\\Mail\\OrderMail']) }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The private helper is compiled (the registry carries it).
  assert.match(res.code, /"formatOrder":/);
  // The compiled build() calls it.
  assert.match(res.code, /this\.formatOrder\(/);
  // The compiled mailable runs: the mail that goes out carries the helper's
  // value (Laravel: the subject is the one build() set).
  const mod = await compiledModule(res.code);
  const mailer = createMailer({ transport: 'log', from: 'hello@example.com' });
  const rt = buildRt({}, { http: { mail: mailer }, classes: mod.classes, eventListeners: mod.eventListeners });
  const mail = rt.newClass('App\\Mail\\OrderMail', []);
  await rt.mail().to('buyer@example.com').send(mail);
  assert.equal(mailer.outbox[0].subject, 'Order shipped');
});

test('classes: every class-path refusal carries a code', () => {
  // The invariant: every fail-loud carries a code (the controller path always
  // did; the class path must agree).
  const cases = [
    {
      file: classFile('Queued', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class Queued implements \\Illuminate\\Contracts\\Queue\\ShouldQueue
{
    public function handle(PostPublished $event): void
    {
    }
}
`),
      listener: 'App\\Listeners\\Queued',
      queued: true,
    },
    {
      file: classFile('Broken', `<?php
namespace App\\Listeners;
class Broken
{
    public function handle(
}
`),
      listener: 'App\\Listeners\\Broken',
    },
  ];
  for (const c of cases) {
    const res = compileClasses(
      {
        events: {
          'App\\Events\\PostPublished': {
            file: classFile('PostPublished', EVENT_SOURCE),
            listeners: [c.listener],
            queued: c.queued ? [c.listener] : [],
          },
        },
        classes: { [c.listener]: { file: c.file } },
      },
      OPTIONS
    );
    assert.ok(res.errors.length >= 1, 'the construct must fail loud');
    for (const e of res.errors) {
      assert.ok(e.code, 'every class-path refusal carries a code: ' + JSON.stringify(e));
    }
  }
});

test('classes: a mailable compiles (the Mailable base + the payload)', () => {
  // The mailable extends Laravel's Mailable: the compiled class gets the
  // kernel's base (the fluent surface + the payload the mailer sends).
  const file = classFile('OrderMail', `<?php
namespace App\\Mail;
class OrderMail
{
    public function build(): self
    {
        $this->subject('Order shipped');
        $this->view('mail.order');
        $this->with(['id' => 7]);
        return $this;
    }
}
`);
  const res = compileClasses(
    {
      events: {},
      classes: { 'App\\Mail\\OrderMail': { file, kind: 'mailable' } },
    },
    { ...OPTIONS, classes: new Set(['App\\Mail\\OrderMail']) }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The registry says the class has the mailable base.
  assert.match(res.code, /base: "mailable"/);
  // The fluent setters and the payload method are the base's.
  assert.match(res.code, /"build":/);
});

test('classes: a listener that uses a trait fails loud (the trait members are not compiled)', () => {
  const file = classFile('UsesTrait', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
trait Notifies
{
    public function notify(PostPublished $event): void
    {
    }
}
class UsesTrait
{
    use Notifies;
    public function handle(PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\UsesTrait'],
        },
      },
      classes: { 'App\\Listeners\\UsesTrait': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /uses a trait/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: a listener that extends another class fails loud (the inherited methods are not compiled)', () => {
  const file = classFile('ChildListener', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class Base
{
    public function handle(PostPublished $event): void
    {
    }
}
class ChildListener extends Base
{
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\ChildListener'],
        },
      },
      classes: { 'App\\Listeners\\ChildListener': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /extends/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: a magic accessor fails loud (a property read would answer null)', () => {
  const file = classFile('Magic', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class Magic
{
    public function __get($name)
    {
        return 'computed';
    }
    public function handle(PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\Magic'],
        },
      },
      classes: { 'App\\Listeners\\Magic': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /magic method __get/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: a constructor that needs an await fails loud (the ctor is sync at the edge)', () => {
  // The runtime calls `entry.ctor(args, deps)` without awaiting it, so an
  // `await` in the constructor body would be a SyntaxError in the generated
  // module - the whole worker would fail to import while the build said OK.
  const file = classFile('Querying', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
use App\\Models\\Post;
class Querying
{
    public function __construct()
    {
        $this->post = Post::find(1);
    }
    public function handle(PostPublished $event): void
    {
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\Querying'],
        },
      },
      classes: { 'App\\Listeners\\Querying': { file } },
    },
    {
      ...OPTIONS,
      modelAliases: new Set(['Post']),
      modelClassFqcns: { Post: 'App\\Models\\Post' },
      classes: new Set(['App\\Events\\PostPublished', 'App\\Listeners\\Querying']),
    }
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /needs an await/);
  assert.equal(res.errors[0].code, 'LW002');
});

test('classes: a declared property keeps its default (the instance carries it)', () => {
  // PHP: `public int $sent = 0;` - the instance starts at 0. A dropped
  // property would answer null (and `null + 1` is 1 - a counter that starts
  // at the wrong value).
  const file = classFile('Counter', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
class Counter
{
    public int $sent = 0;
    public function handle(PostPublished $event): void
    {
        $this->sent = $this->sent + 1;
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\Counter'],
        },
      },
      classes: { 'App\\Listeners\\Counter': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /"sent": 0/);
});

test('classes: the injected app service is awaited in the compiled body (the runtime is passed)', () => {
  const serviceFile = classFile('Mailer', `<?php
namespace App\\Services;
class Mailer
{
    public function send($event): void
    {
    }
}
`);
  const file = classFile('WithService', `<?php
namespace App\\Listeners;
use App\\Services\\Mailer;
class WithService
{
    public function __construct(private Mailer $mailer)
    {
    }
    public function handle(\\App\\Events\\PostPublished $event): void
    {
        $this->mailer->send($event);
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\WithService'],
        },
      },
      classes: {
        'App\\Listeners\\WithService': { file },
        'App\\Services\\Mailer': { file: serviceFile },
      },
    },
    {
      ...OPTIONS,
      classes: new Set(['App\\Events\\PostPublished', 'App\\Listeners\\WithService', 'App\\Services\\Mailer']),
    }
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The compiled methods take the runtime as their first argument, so the
  // call passes it; and the call is awaited (a rejection must not be
  // swallowed).
  assert.match(res.code, /await rt\.prop\(this, "mailer"\)\.send\(rt, /);
});
test('classes: a listener that pushes to the queue fails loud (the call is refused, nothing would run it)', () => {
  // The refusal holds in a listener too: the compiled class would push the
  // job and nothing would ever run it (a silent no-op).
  const file = classFile('PushesJob', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
use Illuminate\\Support\\Facades\\Queue;
class PushesJob
{
    public function handle(PostPublished $event): void
    {
        Queue::push(\\App\\Jobs\\SendMail::class);
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\PushesJob'],
        },
      },
      classes: { 'App\\Listeners\\PushesJob': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /Queue::push\(\) is not supported/);
  assert.match(res.errors[0].message, /the job would never run at the edge/);
  assert.match(res.errors[0].message, /the worker has no queue handler/);
  // The class path carries the fail-loud code like the controller path.
  assert.equal(res.errors[0].code, 'LW002');
});
test('classes: a listener that uses a tagged cache fails loud (the store has no tags)', () => {
  const file = classFile('TagsCache', `<?php
namespace App\\Listeners;
use App\\Events\\PostPublished;
use Illuminate\\Support\\Facades\\Cache;
class TagsCache
{
    public function handle(PostPublished $event): void
    {
        Cache::tags('a')->put('k', 'v');
    }
}
`);
  const res = compileClasses(
    {
      events: {
        'App\\Events\\PostPublished': {
          file: classFile('PostPublished', EVENT_SOURCE),
          listeners: ['App\\Listeners\\TagsCache'],
        },
      },
      classes: { 'App\\Listeners\\TagsCache': { file } },
    },
    OPTIONS
  );
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.match(res.errors[0].message, /Cache::tags\(\) is not supported/);
  assert.match(res.errors[0].message, /BadMethodCallException/);
});
