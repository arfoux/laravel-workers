// tools/tests/middleware-transform.test.mjs — the compiled request's input
// transformers, against the vendor rules they reproduce.
//
// Two halves, both proven here:
//   1. `appMiddlewareState()` reads the app's bootstrap/app.php exactly the way
//      `Illuminate\Foundation\Configuration\Middleware` applies it: `use()`
//      REPLACES the global stack (Ml 231-236), `prepend()`/`append()`/`remove()`
//      accumulate (Ml 169-207, applied in getGlobalMiddleware() Ml 460-476),
//      `replace()` maps classes (Ml 218-224), `->trimStrings()` splits Closures
//      (skipWhen) from strings (`TrimStrings::except()`, a STATIC list) and
//      `->convertEmptyStringsToNull()` takes Closures only (Ml 645-670).
//   2. `buildRequest()` runs TrimStrings then ConvertEmptyStringsToNull over the
//      query bag and the body bag (`TransformsRequest::clean()`, builder :30-39),
//      with `Str::trim()`'s Unicode character set and `Str::is()` key matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appMiddlewareState } from '../static.mjs';
import { buildRequest, handleHttp, phpTrim } from '../../kernel/http.mjs';

function scaffold(bootstrapSource) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-mw-'));
  mkdirSync(join(dir, 'bootstrap'), { recursive: true });
  writeFileSync(join(dir, 'bootstrap', 'app.php'), bootstrapSource);
  return dir;
}

const withMiddleware = (body) => `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php')
    ->withMiddleware(function (Middleware $middleware) {
${body}
    })
    ->create();
`;

function spec(body) {
  const dir = scaffold(withMiddleware(body));
  try {
    const report = {};
    const state = appMiddlewareState(dir, report);
    assert.equal(report.failure, undefined, 'no refusal expected');
    return state.transformers;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('transformers: the framework default stack runs both passes and reports nothing', () => {
  const t = spec('');
  assert.equal(t.trim, true);
  assert.equal(t.emptyToNull, true);
  assert.deepEqual(t.trimExcept, ['current_password', 'password', 'password_confirmation']);
  assert.deepEqual(t.prevented, [], 'the framework stack itself is not a divergence');
});

test('transformers: ->remove(TrimStrings::class) turns the trim pass off', () => {
  const t = spec("$middleware->remove(\\Illuminate\\Foundation\\Http\\Middleware\\TrimStrings::class);");
  assert.equal(t.trim, false);
  assert.equal(t.emptyToNull, true);
  // Removing a framework default is an app change: the rest of the stack is
  // still the framework's own and stays unreported.
  assert.deepEqual(t.prevented, []);
});

test('transformers: ->use() replaces the stack (bootstraps must list both)', () => {
  const kept = spec(`$middleware->use([
        \\Illuminate\\Foundation\\Http\\Middleware\\TrimStrings::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull::class,
    ]);`);
  assert.equal(kept.trim, true);
  assert.equal(kept.emptyToNull, true);
  const dropped = spec(`$middleware->use([
        \\Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize::class,
    ]);`);
  assert.equal(dropped.trim, false);
  assert.equal(dropped.emptyToNull, false);
});

test('transformers: ->append([A, B]) reaches the stack (array argument)', () => {
  const t = spec(`$middleware->append([
        \\App\\Http\\Middleware\\Audit::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\TrimStrings::class,
    ]);`);
  assert.equal(t.trim, true, 'a transformer appended onto the default stack runs');
  assert.deepEqual(t.prevented, ['App\\Http\\Middleware\\Audit'], 'the app class is named');
});

test('transformers: ->replace() swaps the class the stack runs', () => {
  const t = spec(`$middleware->replace(
        \\Illuminate\\Foundation\\Http\\Middleware\\TrimStrings::class,
        \\App\\Http\\Middleware\\MyTrim::class
    );`);
  assert.equal(t.trim, false, 'the replacement is not the framework transformer');
  assert.deepEqual(t.prevented, ['App\\Http\\Middleware\\MyTrim']);
});

test('transformers: ->trimStrings() strings add to the skip list; Closures refuse', () => {
  const added = spec(`$middleware->trimStrings(['card_number', 'otp']);`);
  assert.deepEqual(added.trimExcept, [
    'current_password',
    'password',
    'password_confirmation',
    'card_number',
    'otp',
  ]);
  const dir = scaffold(withMiddleware(`$middleware->trimStrings([fn ($r) => $r->is('api/*')]);`));
  try {
    const report = {};
    const state = appMiddlewareState(dir, report);
    assert.match(String(report.failure), /skipWhen/);
    // The parts read before the refusal survive.
    assert.deepEqual(state.cookiesExcept, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transformers: ->convertEmptyStringsToNull() with a string entry refuses', () => {
  const dir = scaffold(withMiddleware(`$middleware->convertEmptyStringsToNull(['a']);`));
  try {
    const report = {};
    appMiddlewareState(dir, report);
    assert.match(String(report.failure), /array<int, Closure>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transformers: TrimStrings::except() called on the facade adds to the skip list', () => {
  const dir = scaffold(`<?php
use Illuminate\\Foundation\\Http\\Middleware\\TrimStrings;
TrimStrings::except(['iban']);
${withMiddleware('').replace('<?php\n', '')}`);
  try {
    const state = appMiddlewareState(dir);
    assert.deepEqual(state.transformers.trimExcept, [
      'current_password',
      'password',
      'password_confirmation',
      'iban',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phpTrim: Str::trim default charlist (not JS String.prototype.trim)', () => {
  // The default set is " \n\r\t\x0B\0" plus INVISIBLE_CHARACTERS (Str.php:33).
  assert.equal(phpTrim('  Ada\u00a0'), 'Ada', 'NBSP is an invisible character');
  assert.equal(phpTrim('\u3000x\u000b'), 'x', 'U+3000 ideographic space, \v');
  assert.equal(phpTrim('\tx\u000c'), 'x', '\f is whitespace');
  assert.equal(phpTrim(' \u200bx\u200b '), 'x', 'zero-width space is invisible');
  assert.equal(phpTrim(''), '');
  assert.equal(phpTrim(' \u115Fx\u1160'), 'x', 'Hangul fillers are invisible characters');
});

const TRANSFORMERS = {
  trim: true,
  emptyToNull: true,
  trimExcept: ['current_password', 'password', 'password_confirmation'],
};
const form = (body, transformers = TRANSFORMERS) =>
  buildRequest(
    {
      method: 'POST',
      url: 'http://app.test/form?q=%20hi%20&peer%5Bname%5D=%20pad%20',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
    { transformers }
  );

test('buildRequest: trims and converts the body bag and the query bag', () => {
  const r = form('name=%20Ada%20&password=%20p%20&blank=%20%20&empty=&nest%5Ba%5D=%20v%20');
  // Values verified against PHP 8.3 + framework 13.37.
  assert.equal(r.input('name'), 'Ada');
  assert.equal(r.input('password'), ' p ', 'the skip list keeps the password untouched');
  assert.equal(r.input('blank'), null, 'a whitespace-only field trims to "" then becomes null');
  assert.equal(r.input('empty'), null);
  assert.equal(r.input('nest.a'), 'v', 'a nested key trims through its dotted path');
  assert.equal(r.query('q'), 'hi');
  assert.equal(r.query('peer.name'), 'pad');
});

test('buildRequest: a JSON body transforms too, a bare query string is left alone', () => {
  const r = buildRequest(
    {
      method: 'POST',
      url: 'http://app.test/json',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: '  y  ', b: '', password: ' z ', n: 1 }),
    },
    { transformers: TRANSFORMERS }
  );
  assert.equal(r.input('a'), 'y');
  assert.equal(r.input('b'), null);
  assert.equal(r.input('password'), ' z ');
  assert.equal(r.input('n'), 1, 'a non-string value is left alone');
});

test('buildRequest: a stack without the transformers leaves the input verbatim', () => {
  const r = form('a=%20v%20&e=', { trim: false, emptyToNull: false, trimExcept: [] });
  assert.equal(r.input('a'), ' v ');
  assert.equal(r.input('e'), '');
});

test('handleHttp: global middleware the kernel does not run fails loud', async () => {
  await assert.rejects(
    () =>
      handleHttp(
        { method: 'GET', url: 'http://app.test/', headers: { host: 'app.test' } },
        {
          config: {
            'app.key': 'base64:' + Buffer.alloc(32, 1).toString('base64'),
            'middleware.prevented': ['Illuminate\\Http\\Middleware\\TrustHosts'],
          },
          table: [],
          handlers: {},
        }
      ),
    (err) => {
      assert.match(err.message, /TrustHosts/);
      assert.match(err.message, /does not run it/);
      assert.equal(err.status, 500);
      return true;
    }
  );
});
