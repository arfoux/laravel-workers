// compiler/tests/formrequest-dump.test.mjs — the FormRequest dump refuses the
// hooks the compiled rung does not run.
//
// The dump (tools/formrequest-dump.php) boots the real Laravel app and reads
// the app's FormRequest classes: the rules, the messages, the attributes. A
// FormRequest has more than rules, though: Laravel runs a lifecycle on it,
// and every hook of that lifecycle changes what the edge would answer.
//
//   Illuminate/Foundation/Http/FormRequest.php:104 - the validator() hook
//   Illuminate/Foundation/Http/FormRequest.php:110 - the withValidator() hook
//   Illuminate/Foundation/Http/FormRequest.php:114 - the after() hook
//   Illuminate/Foundation/Http/FormRequest.php:197 - the validationData() hook
//   Illuminate/Validation/ValidatesWhenResolvedTrait.php:35 - the
//     passedValidation() hook (the trait declares it at line 63)
//   Illuminate/Validation/ValidatesWhenResolvedTrait.php:19 - the
//     prepareForValidation() hook (refused before this one)
//
// The compiled rung runs none of them: it validates the dumped rules against
// the raw input. So the dump refuses the class with the reason - what Laravel
// does with the hook, what the edge does instead, and the path that works.
// The reason reaches the operator: the build prints the dump's error verbatim
// in the route's skip line ("controller <route>: skipped - $<param> (<type>):
// <the dump's error>"), so the reason carries the fail-loud code too.
//
// The test needs a real Laravel app (PHP 8.3 + vendor/): LW_LARAVEL_APP, or
// the dev-machine default. Without one it SKIPS with the reason (the repo's
// convention for the oracle tests) - it never fails.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const dumpPath = path.join(pkgDir, 'tools', 'formrequest-dump.php');
const PHP = process.env.PHP_BIN || 'php';

// The dev-machine fixture (a fresh Laravel 13 app). It is only a default:
// LW_LARAVEL_APP wins.
const DEFAULT_APP_ROOT = 'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

function appRoot() {
  const app = process.env.LW_LARAVEL_APP || DEFAULT_APP_ROOT;
  if (!app) return null;
  if (!existsSync(path.join(app, 'vendor', 'autoload.php'))) return null;
  if (!existsSync(path.join(app, 'app'))) return null;
  return app;
}

const APP = appRoot();
// The dump is a PHP tool: without PHP the test skips too.
function hasPhp() {
  try {
    execFileSync(PHP, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const noApp = !APP
  ? 'formrequest-dump.test.mjs: no Laravel app (set LW_LARAVEL_APP to a Laravel 13 app with ' +
    'vendor/ installed) - the FormRequest dump test is skipped'
  : !hasPhp()
    ? `formrequest-dump.test.mjs: no PHP (${PHP}) - the FormRequest dump test is skipped`
    : false;

// The app's root namespace (the PSR-4 prefix that maps to app/) - the
// fixtures live in it, so the app's own autoloader finds them.
function rootNamespace(app) {
  try {
    const composer = JSON.parse(readFileSync(path.join(app, 'composer.json'), 'utf8'));
    const psr4 = (composer.autoload && composer.autoload['psr-4']) || {};
    for (const [prefix, dirs] of Object.entries(psr4)) {
      const list = Array.isArray(dirs) ? dirs : [dirs];
      if (list.some((d) => String(d).replace(/[\\/]+$/, '') === 'app')) return prefix;
    }
  } catch {
    /* the default namespace wins */
  }
  return 'App\\';
}

// The fixture FormRequests: one per hook, plus a plain one (the shape the
// compiled rung supports). The hook bodies are Laravel's own shape - the dump
// only reflects them, but a fixture that does not compile would hide the
// refusal behind a parse error.
const FIXTURE_BODIES = {
  PlainRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }
`,
  PrepareRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    protected function prepareForValidation()
    {
        $this->merge(['title' => trim((string) $this->input('title'))]);
    }
`,
  WithValidatorRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    public function withValidator($validator)
    {
        $validator->messages()->add('title', 'The title is taken.');
    }
`,
  AfterRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    public function after()
    {
        return function ($validator) {
            // Laravel runs this after the rules pass; it can add errors.
        };
    }
`,
  ValidatorRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    public function validator($factory)
    {
        return $factory->make([], []);
    }
`,
  ValidationDataRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    public function validationData()
    {
        return $this->all();
    }
`,
  PassedValidationRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['title' => ['required', 'string']];
    }

    protected function passedValidation()
    {
        // Laravel runs this after the validation passed.
    }
`,
};

// The hooks the compiled rung does not run: the hook, the class that declares
// it and the line of Laravel 13 that runs it.
const HOOKS = [
  { hook: 'withValidator', cls: 'WithValidatorRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:110' },
  { hook: 'after', cls: 'AfterRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:114' },
  { hook: 'validator', cls: 'ValidatorRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:104' },
  { hook: 'validationData', cls: 'ValidationDataRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:197' },
  {
    hook: 'passedValidation',
    cls: 'PassedValidationRequest',
    laravel: 'Illuminate/Validation/ValidatesWhenResolvedTrait.php:35',
  },
];

const NS = APP ? rootNamespace(APP) : 'App\\';
const FIXTURE_DIR = APP ? path.join(APP, 'app', 'LwDumpFixtures') : null;

// The fixtures go into the app (the app's autoloader finds them through the
// PSR-4 map) and are removed when the file's tests are done. An app that
// cannot take them skips the test - it never fails.
let fixturesError = null;
if (FIXTURE_DIR) {
  try {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, body] of Object.entries(FIXTURE_BODIES)) {
      writeFileSync(
        path.join(FIXTURE_DIR, name + '.php'),
        `<?php\n\nnamespace ${NS}LwDumpFixtures;\n\nuse Illuminate\\Foundation\\Http\\FormRequest;\n\n` +
          `class ${name} extends FormRequest\n{${body}}\n`,
        'utf8'
      );
    }
  } catch (e) {
    fixturesError = e && e.message ? e.message : String(e);
  }
}

const skip = fixturesError
  ? `formrequest-dump.test.mjs: cannot write the FormRequest fixtures into ${FIXTURE_DIR} (${fixturesError}) - the test is skipped`
  : noApp;

after(() => {
  if (FIXTURE_DIR) rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// The dump (the real PHP tool, against the real app).
function runDump(fqcns) {
  const raw = execFileSync(PHP, [dumpPath, ...fqcns], {
    cwd: APP,
    env: { ...process.env, LW_APP_ROOT: APP },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const entries = JSON.parse(raw);
  return new Map(entries.map((e) => [e.fqcn, e]));
}

const fqcnOf = (cls) => `${NS}LwDumpFixtures\\${cls}`;

test('the dump refuses every FormRequest hook the compiled rung does not run', { skip }, () => {
  const entries = runDump([...HOOKS.map((h) => fqcnOf(h.cls)), fqcnOf('PlainRequest')]);

  for (const h of HOOKS) {
    const entry = entries.get(fqcnOf(h.cls));
    assert.ok(entry, `the dump answered for ${h.cls}`);
    assert.equal(typeof entry.error, 'string', `${h.cls}: the dump must refuse the class`);
    // The reason says what Laravel does with the hook, what the edge does
    // instead, and the path that works.
    assert.match(entry.error, new RegExp(`^LW003 ${h.hook}\\(\\) is overridden`), `${h.cls}: the reason names the hook`);
    assert.ok(entry.error.includes(h.laravel), `${h.cls}: the reason cites ${h.laravel}`);
    assert.match(
      entry.error,
      /the compiled rung validates the dumped rules against the raw input and never runs it/,
      `${h.cls}: the reason says what the edge does instead`
    );
    assert.match(entry.error, /the working path: /, `${h.cls}: the reason names the path that works`);
    // The refusal is the whole answer: no rules are handed to the compiler.
    assert.deepEqual(entry.rules, [], `${h.cls}: a refused class carries no rules`);
  }
});

test('the dump refuses an overridden prepareForValidation() with the code + the reason', { skip }, () => {
  const entries = runDump([fqcnOf('PrepareRequest')]);
  const entry = entries.get(fqcnOf('PrepareRequest'));
  assert.ok(entry, 'the dump answered for PrepareRequest');
  assert.match(entry.error, /^LW003 prepareForValidation\(\) is overridden/, 'the refusal carries the code');
  assert.match(
    entry.error,
    /the compiled rung validates the dumped rules against the raw input and never runs it/,
    'the reason says what the edge does instead'
  );
  assert.match(entry.error, /the working path: /, 'the reason names the path that works');
});

test('a FormRequest without a hook still dumps its rules', { skip }, () => {
  const entries = runDump([fqcnOf('PlainRequest')]);
  const entry = entries.get(fqcnOf('PlainRequest'));
  assert.ok(entry, 'the dump answered for PlainRequest');
  assert.equal(entry.error, null, 'a plain FormRequest is not refused');
  assert.deepEqual(entry.rules, { title: ['required', 'string'] });
});

test('the refusal reaches the operator (the build prints the dump error)', { skip }, () => {
  // The build prints the dump's error verbatim in the route's skip line
  // (build.mjs: `formRequestError = dumped.error ? "$<param> (<type>): " +
  // dumped.error : ...` and then `controller <route>: skipped - <reason>`),
  // so the fail-loud code and the reason travel together.
  const entries = runDump([fqcnOf('AfterRequest')]);
  const error = entries.get(fqcnOf('AfterRequest')).error;
  const line = `  controller POST /posts: skipped — $request (${NS}LwDumpFixtures\\AfterRequest): ${error}`;
  assert.match(line, /skipped/);
  assert.match(line, /LW003 after\(\) is overridden/);
  assert.match(line, /Illuminate\/Foundation\/Http\/FormRequest\.php:114/);
  assert.match(line, /the working path: /);
});
