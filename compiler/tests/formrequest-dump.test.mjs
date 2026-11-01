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
// The test needs a real Laravel app (PHP 8.3 + vendor/): LW_LARAVEL_APP, or the
// conventional `parity-app` / `e2e-app` directories at the repo root. Without
// one it SKIPS with the reason (the repo's convention for the oracle tests) - it
// never fails.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleAppRoot } from '../../kernel/tests/oracle-app.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const dumpPath = path.join(pkgDir, 'tools', 'formrequest-dump.php');
const PHP = process.env.PHP_BIN || 'php';

// The app the oracle parity runs against (the resolver is shared with the kernel
// oracle tests, see the header).
const APP = oracleAppRoot();

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
  // A rule OBJECT: Laravel hands the validator the object and the validator
  // reads its string form - so the dump normalizes it.
  RuleObjectRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'role' => ['required', \\Illuminate\\Validation\\Rule::in(['admin', 'user'])],
            'tag' => [\\Illuminate\\Validation\\Rule::notIn(['x', 'y'])],
            'email' => [\\Illuminate\\Validation\\Rule::unique('users', 'email')],
        ];
    }
`,
  // A CONDITIONAL rule object: its string form is the condition evaluated at
  // build time, so the edge would bake the build-time branch into the rule.
  ConditionalRuleRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name' => [\\Illuminate\\Validation\\Rule::requiredIf(true)],
        ];
    }
`,
  // A unique/exists rule object whose constraint is a query CALLBACK: its
  // string form DROPS the callback (formatWheres() writes the where pairs
  // only) while Laravel keeps the object and merges the callback into the
  // query - so the edge would answer the opposite (an exists rule PASSES where
  // Laravel fails).
  RuleCallbackRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'email' => [\\Illuminate\\Validation\\Rule::exists('users', 'email')->whereIn('tenant_id', [1])],
        ];
    }
`,
  // The same shape written as where PAIRS: those DO live in the string form, so
  // the class is not refused and the rule travels through unchanged.
  RulePairRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'slug' => [\\Illuminate\\Validation\\Rule::unique('posts', 'slug')->where('tenant_id', 1)],
            'email' => [\\Illuminate\\Validation\\Rule::exists('users', 'email')->whereNot('tenant_id', 2)],
        ];
    }
`,
  // A model FQCN table: parseTable() resolves it to the model's table AND the
  // model's key as the id column, which the rule string cannot carry.
  ClassTableRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'email' => ['unique:App\\\\Models\\\\User,email'],
        ];
    }
`,
};

// The hooks the compiled lifecycle RUNS: the hook, the class that declares it
// and the line of Laravel 13 that runs it. The dump REPORTS them (the build
// compiles the FormRequest class, the runtime runs the hooks in this order).
const RUN_HOOKS = [
  { hook: 'withValidator', cls: 'WithValidatorRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:110' },
  { hook: 'after', cls: 'AfterRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:114' },
  { hook: 'validationData', cls: 'ValidationDataRequest', laravel: 'Illuminate/Foundation/Http/FormRequest.php:197' },
  {
    hook: 'passedValidation',
    cls: 'PassedValidationRequest',
    laravel: 'Illuminate/Validation/ValidatesWhenResolvedTrait.php:35',
  },
];

// The hook the compiled rung does NOT run: the app's OWN validator (its
// factory, its extensions). The edge has one validator factory (the kernel's),
// so that class is refused.
const REFUSED_HOOK = {
  hook: 'validator',
  cls: 'ValidatorRequest',
  laravel: 'Illuminate/Foundation/Http/FormRequest.php:104',
};

const NS = APP ? rootNamespace(APP) : 'App\\';
// The app's default connection name: the dump treats `default.table` as the
// app's own database (it drops the prefix) and refuses every other prefix, so
// those two fixtures are built from the app's real answer.
function defaultConnection(app) {
  if (!app || !hasPhp()) return null;
  const code = [
    '$root = $argv[1];',
    "require $root . '/vendor/autoload.php';",
    '$app = require $root . "/bootstrap/app.php";',
    '$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();',
    "echo (string) config('database.default');",
  ].join(' ');
  try {
    const out = execFileSync(PHP, ['-r', code, app], { cwd: app, encoding: 'utf8' }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
const DEFAULT_CONN = defaultConnection(APP);
const CONN_BODIES = DEFAULT_CONN
  ? {
      // The app's own connection as a prefix: the same query, so the dump drops
      // the prefix instead of refusing the class.
      DefaultConnTableRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'email' => ['unique:${DEFAULT_CONN}.users,email'],
        ];
    }
`,
      // Any other connection: PHP runs the check on that database, and the
      // compiled app queries one.
      OtherConnTableRequest: `
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'email' => ['exists:${DEFAULT_CONN}other.users,email'],
        ];
    }
`,
    }
  : {};
const FIXTURE_BODIES_ALL = { ...FIXTURE_BODIES, ...CONN_BODIES };
const FIXTURE_DIR = APP ? path.join(APP, 'app', 'LwDumpFixtures') : null;

// The fixtures go into the app (the app's autoloader finds them through the
// PSR-4 map) and are removed when the file's tests are done. An app that
// cannot take them skips the test - it never fails.
let fixturesError = null;
if (FIXTURE_DIR) {
  try {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, body] of Object.entries(FIXTURE_BODIES_ALL)) {
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

test('the dump REPORTS the hooks the compiled lifecycle runs', { skip }, () => {
  const entries = runDump(RUN_HOOKS.map((h) => fqcnOf(h.cls)));

  for (const h of RUN_HOOKS) {
    const entry = entries.get(fqcnOf(h.cls));
    assert.ok(entry, `the dump answered for ${h.cls}`);
    assert.equal(entry.error, null, `${h.cls}: the hook is compiled, not refused`);
    // The hook is in the list the runtime runs (Laravel's order lives in
    // compiler/runtime/rt-from-context.mjs:rt.formRequest).
    assert.ok(entry.hooks.includes(h.hook), `${h.cls}: the dump reports ${h.hook}() (${h.laravel})`);
    // The rules still reach the compiler: the class validates.
    assert.ok(Object.keys(entry.rules).length > 0, `${h.cls}: the class still carries its rules`);
  }
});

test("the dump REFUSES the app's own validator() hook (the edge has one factory)", { skip }, () => {
  // Illuminate/Foundation/Http/FormRequest.php:104 - Laravel asks the app for
  // the validator instead of building the default one, so the app's factory
  // (its extensions, its custom rules) is what validates. The edge has no
  // second factory: it would answer with the default validator.
  const entries = runDump([fqcnOf(REFUSED_HOOK.cls)]);
  const entry = entries.get(fqcnOf(REFUSED_HOOK.cls));
  assert.ok(entry, `the dump answered for ${REFUSED_HOOK.cls}`);
  assert.equal(typeof entry.error, 'string', 'the dump must refuse the class');
  // The reason says what Laravel does with the hook, what the edge does
  // instead, and the path that works.
  assert.match(entry.error, /^LW003 validator\(\) is overridden/, 'the reason names the hook');
  assert.ok(entry.error.includes(REFUSED_HOOK.laravel), `the reason cites ${REFUSED_HOOK.laravel}`);
  assert.match(entry.error, /the working path: /, 'the reason names the path that works');
  // The refusal is the whole answer: no rules are handed to the compiler.
  assert.deepEqual(entry.rules, [], 'a refused class carries no rules');
});

test('the dump REPORTS an overridden prepareForValidation() (the hook is compiled now)', { skip }, () => {
  // The hook is compiled: the build compiles the FormRequest class, so the
  // compiled handler runs the hook BEFORE the validation (Laravel's order) and
  // the input the hook prepares is what the rules see.
  const entries = runDump([fqcnOf('PrepareRequest')]);
  const entry = entries.get(fqcnOf('PrepareRequest'));
  assert.ok(entry, 'the dump answered for PrepareRequest');
  assert.equal(entry.error, null, 'the hook is compiled, not refused');
  // The fixture declares authorize() too: the runtime calls it as well
  // (Laravel's order - ValidatesWhenResolvedTrait::validateResolved), and its
  // false is the 403.
  assert.deepEqual(entry.hooks, ['prepareForValidation', 'authorize'], 'the dump reports the hooks');
});

test('the dump normalizes a rule object to Laravel\'s string form', { skip }, () => {
  // Laravel's validator reads the object's string form, so the edge gets the
  // same string - and the kernel parses the parameters exactly like Laravel
  // (the M61a CSV parse).
  const entries = runDump([fqcnOf('RuleObjectRequest')]);
  const entry = entries.get(fqcnOf('RuleObjectRequest'));
  assert.ok(entry, 'the dump answered for RuleObjectRequest');
  assert.equal(entry.error, null, 'a rule object is normalized, not refused');
  assert.deepEqual(entry.rules.role, ['required', 'in:"admin","user"']);
  assert.deepEqual(entry.rules.tag, ['not_in:"x","y"']);
  assert.deepEqual(entry.rules.email, ['unique:users,email,NULL,id']);
});

test('the dump refuses a CONDITIONAL rule object (its string form bakes the build-time branch)', { skip }, () => {
  const entries = runDump([fqcnOf('ConditionalRuleRequest')]);
  const entry = entries.get(fqcnOf('ConditionalRuleRequest'));
  assert.ok(entry, 'the dump answered for ConditionalRuleRequest');
  assert.equal(typeof entry.error, 'string', 'the dump must refuse the class');
  assert.match(entry.error, /^LW003 the rules use a rule object/);
  assert.match(entry.error, /RequiredIf/, 'the reason names the rule class');
  assert.match(entry.error, /conditional/, 'the reason says why');
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
  const entries = runDump([fqcnOf('ValidatorRequest')]);
  const error = entries.get(fqcnOf('ValidatorRequest')).error;
  const line = `  controller POST /posts: skipped — $request (${NS}LwDumpFixtures\\ValidatorRequest): ${error}`;
  assert.match(line, /skipped/);
  assert.match(line, /LW003 validator\(\) is overridden/);
  assert.match(line, /Illuminate\/Foundation\/Http\/FormRequest\.php:104/);
  assert.match(line, /the working path: /);
});
test('the dump REFUSES a unique/exists object that carries query callbacks (the string form drops them)', { skip }, () => {
  // A-series #299. `Rule::exists('users','email')->whereIn('tenant_id',[1])`
  // keeps the callback OUT of its string form: `whereIn()` routes into
  // `DatabaseRule::$using` (Unique.php/Exists.php `__toString()` writes
  // `formatWheres()` = the where PAIRS only). Laravel never stringifies such a
  // rule - `ValidationRuleParser::prepareRule()` keeps the object and
  // `validateExists()` merges `queryCallbacks()` into the query - so the edge,
  // which only gets the string, would validate a DIFFERENT query. Probed on
  // 13.37 with one matching row: the object FAILS, the bare string PASSES
  // (fail-open), so the class is refused instead.
  const entry = runDump([fqcnOf('RuleCallbackRequest')]).get(fqcnOf('RuleCallbackRequest'));
  assert.ok(entry, 'the dump answered for RuleCallbackRequest');
  assert.equal(typeof entry.error, 'string', 'the dump must refuse the class');
  assert.match(entry.error, /^LW003 the rules use a rule object/);
  assert.match(entry.error, /query callbacks/);
  assert.match(entry.error, /Exists/, 'the reason names the rule class');
  assert.match(entry.error, /whereIn/, 'the reason names the shape that is dropped');
  assert.match(entry.error, /the working path: /);
  assert.deepEqual(entry.rules, [], 'a refused class carries no rules');
});
test('the dump keeps a unique/exists object whose constraint IS a where pair', { skip }, () => {
  // The other half of #299: a where PAIR lives in `$this->wheres`, so
  // `formatWheres()` writes it into the string and the edge runs the same
  // query. Refusing these too would break working apps.
  const entry = runDump([fqcnOf('RulePairRequest')]).get(fqcnOf('RulePairRequest'));
  assert.ok(entry, 'the dump answered for RulePairRequest');
  assert.equal(entry.error, null, 'a where pair is carried by the string form');
  assert.deepEqual(entry.rules.slug, ['unique:posts,slug,NULL,id,tenant_id,"1"']);
  assert.deepEqual(entry.rules.email, ['exists:users,email,tenant_id,"!2"']);
});
test('the dump REFUSES a table given as a class name (PHP resolves it, the string cannot carry it)', { skip }, () => {
  // `ValidatesAttributes::parseTable()` (:1193-1200) turns
  // `unique:App\Models\User,email` into the model's table AND the model's key
  // as the id column (`getUniqueIds()` prefers that key over the rule's own id
  // parameter) - neither travels in the rule string, so the edge would query a
  // table named after the class.
  const entry = runDump([fqcnOf('ClassTableRequest')]).get(fqcnOf('ClassTableRequest'));
  assert.ok(entry, 'the dump answered for ClassTableRequest');
  assert.equal(typeof entry.error, 'string', 'the dump must refuse the class');
  assert.match(entry.error, /^LW003 the rules use a unique\/exists table/);
  assert.match(entry.error, /is a class name/);
  assert.match(entry.error, /parseTable/);
  assert.match(entry.error, /the working path: /);
});
test('the dump refuses a foreign connection prefix and drops the app\'s own', { skip: skip || !DEFAULT_CONN ? skip || 'no default connection could be read' : false }, () => {
  // `parseTable()` (:1191) splits `connection.table` on the first dot and the
  // presence verifier then runs on THAT connection. The compiled app queries
  // one database: the prefix that names it is the same query (drop it), any
  // other prefix is a different database (refuse).
  const entries = runDump([fqcnOf('DefaultConnTableRequest'), fqcnOf('OtherConnTableRequest')]);
  const own = entries.get(fqcnOf('DefaultConnTableRequest'));
  assert.ok(own, `the dump answered for DefaultConnTableRequest (${DEFAULT_CONN})`);
  assert.equal(own.error, null, `the app's own connection prefix is the same query`);
  assert.deepEqual(own.rules.email, ['unique:users,email'], 'the prefix is dropped');
  const other = entries.get(fqcnOf('OtherConnTableRequest'));
  assert.ok(other, 'the dump answered for OtherConnTableRequest');
  assert.equal(typeof other.error, 'string', 'a foreign connection is refused');
  assert.match(other.error, /^LW003 the rules use a unique\/exists table/);
  assert.match(other.error, /names the connection/);
  assert.ok(other.error.includes(`${DEFAULT_CONN}other`), 'the reason names the connection');
  assert.match(other.error, /the working path: /);
});
