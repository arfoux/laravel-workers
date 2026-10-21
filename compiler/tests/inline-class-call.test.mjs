// compiler/tests/inline-class-call.test.mjs — the call on an INLINE instance
// of a compiled class (`(new OrderService())->doIt($o)`).
//
// The compiled methods are `async function (rt, ...)` (compiler/src/
// classes.mjs), so the call site must hand the runtime over as its FIRST
// argument and must await the call. Without the runtime the app's first
// argument landed in the `rt` slot: the body then called `rt.model(...)` on
// the app's argument, and the route answered 500 where Laravel answers 200.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileClasses } from '../src/classes.mjs';
import { transpileControllerMethod } from '../src/transpiler.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

// A class file in a temp dir (the compiler reads the app's sources).
function classFile(name, source) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-inline-'));
  const file = join(dir, name + '.php');
  writeFileSync(file, source, 'utf8');
  return file;
}

const SERVICE_SOURCE = `<?php
namespace App\\Services;

class OrderService
{
    public function doIt($order)
    {
        return 'done:' . $order;
    }
}
`;

const MAILABLE_SOURCE = `<?php
namespace App\\Mail;

use Illuminate\\Mail\\Mailable;

class OrderMail extends Mailable
{
    public function build()
    {
        return $this->subject('Hi');
    }
}
`;

// The classes of the app, compiled the way the build compiles them.
function compileApp() {
  const service = classFile('OrderService', SERVICE_SOURCE);
  const mailable = classFile('OrderMail', MAILABLE_SOURCE);
  const out = compileClasses(
    {
      events: {},
      classes: {
        'App\\Services\\OrderService': { file: service, kind: 'service' },
        'App\\Mail\\OrderMail': { file: mailable, kind: 'mailable' },
      },
    },
    { modelClassFqcns: {}, classes: new Set(['App\\Services\\OrderService', 'App\\Mail\\OrderMail']) }
  );
  assert.equal(out.errors.length, 0, 'the classes compile: ' + JSON.stringify(out.errors));
  return out;
}

// The controller body (the way the build transpiles a route's action).
function transpileAction(body, meta) {
  const out = transpileControllerMethod(body, {
    controller: true,
    classes: meta.fqcns,
    classFqcns: meta.aliases,
    classRegistry: meta.registry,
  });
  assert.equal(out.errors.length, 0, 'the action compiles: ' + JSON.stringify(out.errors));
  return out.code;
}

// The body of a PHP method, parsed by the PHP parser the compiler uses.
async function phpBody(source) {
  const parser = (await import('php-parser')).default;
  const phpParser = new parser({ parser: { suppressErrors: true }, ast: { withPositions: true } });
  const ast = phpParser.parseCode('<?php function f() { ' + source + ' }');
  return ast.children[0].body.children;
}

test("the inline call hands the runtime over as the first argument", async () => {
  const compiled = compileApp();
  const meta = {
    fqcns: Object.keys(compiled.meta),
    aliases: { OrderService: 'App\\Services\\OrderService', OrderMail: 'App\\Mail\\OrderMail' },
    registry: Object.fromEntries(
      Object.entries(compiled.meta).map(([fqcn, m]) => [fqcn, { methods: m.methods, base: m.base }])
    ),
  };
  const body = await phpBody('$x = (new OrderService())->doIt($o);');
  const code = transpileAction(body, meta);
  // The runtime is the FIRST argument and the call is awaited: a floating
  // promise would answer "[object Promise]" (or leak into the response).
  assert.match(code, /\(await rt\.newClass\("App\\\\Services\\\\OrderService", \[\]\)\.doIt\(rt, /);
});

test('the inline call on a mailable fluent surface takes only its own arguments', async () => {
  const compiled = compileApp();
  const meta = {
    fqcns: Object.keys(compiled.meta),
    aliases: { OrderService: 'App\\Services\\OrderService', OrderMail: 'App\\Mail\\OrderMail' },
    registry: Object.fromEntries(
      Object.entries(compiled.meta).map(([fqcn, m]) => [fqcn, { methods: m.methods, base: m.base }])
    ),
  };
  // `subject()` is the KERNEL's surface (Illuminate\Mail\Mailable), not a
  // compiled method: it takes only its own arguments.
  const body = await phpBody('$m = (new OrderMail())->subject("Hi");');
  const code = transpileAction(body, meta);
  assert.match(code, /rt\.newClass\("App\\\\Mail\\\\OrderMail", \[\]\)\.subject\("Hi"\)/);
  assert.doesNotMatch(code, /subject\("Hi", rt\)/);
});

test('the inline call on the mailable own method takes the runtime', async () => {
  const compiled = compileApp();
  const meta = {
    fqcns: Object.keys(compiled.meta),
    aliases: { OrderService: 'App\\Services\\OrderService', OrderMail: 'App\\Mail\\OrderMail' },
    registry: Object.fromEntries(
      Object.entries(compiled.meta).map(([fqcn, m]) => [fqcn, { methods: m.methods, base: m.base }])
    ),
  };
  const body = await phpBody('$m = (new OrderMail())->build();');
  const code = transpileAction(body, meta);
  assert.match(code, /\(await rt\.newClass\("App\\\\Mail\\\\OrderMail", \[\]\)\.build\(rt\)\)/);
});

test('the inline call on a method the class does not have fails loud', async () => {
  const compiled = compileApp();
  const meta = {
    fqcns: Object.keys(compiled.meta),
    aliases: { OrderService: 'App\\Services\\OrderService', OrderMail: 'App\\Mail\\OrderMail' },
    registry: Object.fromEntries(
      Object.entries(compiled.meta).map(([fqcn, m]) => [fqcn, { methods: m.methods, base: m.base }])
    ),
  };
  const body = await phpBody('$x = (new OrderService())->nope();');
  const out = transpileControllerMethod(body, {
    controller: true,
    classes: meta.fqcns,
    classFqcns: meta.aliases,
    classRegistry: meta.registry,
  });
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].code, 'LW002');
  // The reason names the class and its compiled methods: the edge cannot
  // call a method the class does not have.
  assert.match(out.errors[0].message, /nope\(\) of the class App\\Services\\OrderService is not compiled/);
});

test('the compiled class runs with the runtime the call site handed over', async () => {
  const compiled = compileApp();
  // The generated module: the very code the build emits (the registry the
  // runtime builds the instances from).
  const file = join(mkdtempSync(join(tmpdir(), 'lw-inline-')), 'classes.generated.mjs');
  writeFileSync(file, compiled.code, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const rt = buildRt(null, { runtime: true, classes: mod.classes, eventListeners: mod.eventListeners });
  // The call site (what the transpiler emits) - the runtime is the first
  // argument, so the method's own argument is the app's `$o`.
  const value = await rt.newClass('App\\Services\\OrderService', []).doIt(rt, 'order-7');
  assert.equal(value, 'done:order-7');
});
