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

test('classes: a constructor with a body fails loud', () => {
  const file = classFile('WithBody', `<?php
namespace App\\Events;
class WithBody
{
    public function __construct(public int $id)
    {
        $this->id = $id + 1;
    }
}
`);
  const res = compileClasses(
    { events: {}, classes: { 'App\\Events\\WithBody': { file } } },
    OPTIONS
  );
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /constructor property promotion only/);
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
  const answer = await rt.event.dispatch(event);
  assert.equal(answer, null);
});

test('classes: the runtime fails loud on an event without a compiled class', async () => {
  const rt = buildRt({}, { http: {}, classes: {}, eventListeners: {} });
  await assert.rejects(() => rt.event.dispatch({ postId: 1 }), /not an instance of a compiled event class/);
});
