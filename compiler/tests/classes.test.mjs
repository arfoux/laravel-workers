// compiler/tests/classes.test.mjs — the class compiler (the event listeners).
//
// The listeners are classes: at the edge there is no listener runtime, so the
// build compiles them (the constructor, the public methods) and the dispatch
// calls them (Laravel dispatches synchronously).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileClasses } from '../src/classes.mjs';
import { emitController } from '../src/controller.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

// A class file in a temp dir (the compiler reads the app's sources).
function classFile(name, source) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-classes-'));
  const file = join(dir, name + '.php');
  writeFileSync(file, source, 'utf8');
  return file;
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
  assert.match(res.errors[0].message, /instantiates a listener without arguments/);
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
