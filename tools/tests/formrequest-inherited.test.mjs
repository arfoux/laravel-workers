// tools/tests/formrequest-inherited.test.mjs — the FormRequest dump must read
// `rules()` from the file that DECLARES it. A child class inherits the method,
// so ReflectionClass::getFileName() (the child file) and
// ReflectionMethod::getFileName() (the parent file) are different files.
//
// No Laravel app is needed: define('LW_METADATA_LIB') skips the CLI boot block
// at tools/formrequest-dump.php:426 and a tiny stub of
// Illuminate\Foundation\Http\FormRequest is enough for the reflection path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PHP = process.env.PHP_BIN || 'php';
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dumpPath = join(pkgDir, 'tools', 'formrequest-dump.php');
const phpOk = spawnSync(PHP, ['-r', 'echo PHP_VERSION;'], { stdio: 'ignore' }).status === 0;
const phpSkip = phpOk ? false : `no PHP interpreter (${PHP})`;

const REQUEST_STATE_CASES = [
  {
    label: 'existing $this->user()',
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . $this->user()->id]];",
  },
  {
    label: '$this -> user ()',
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . $this -> user ()->id]];",
  },
  {
    label: "app('request')",
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . app('request')]];",
  },
  {
    label: 'app("request")',
    refuse: true,
    line: `        return ['email' => ['unique:users,email,' . app("request")]];`,
  },
  {
    label: 'user (',
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . user ('id')]];",
  },
  {
    label: 'auth (',
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . auth ('id')]];",
  },
  {
    label: 'request (',
    refuse: true,
    line: "        return ['email' => ['unique:users,email,' . request ('id')]];",
  },
  {
    label: "app('config') is ordinary static code",
    refuse: false,
    line: "        return ['email' => ['unique:users,email,' . app('config')]];",
  },
];

test('formrequest dump refuses inherited rules() that read request state', { skip: phpSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-formrequest-inherited-'));
  try {
    const stub = join(dir, 'stub.php');
    const parent = join(dir, 'parent.php');
    const child = join(dir, 'child.php');
    const driver = join(dir, 'run.php');
    const pad = Array.from({ length: 40 }, (_, i) => `    // pad ${i + 1}`).join('\n');

    writeFileSync(
      stub,
      [
        '<?php',
        'namespace Illuminate\\Foundation\\Http {',
        '  class FormRequest {',
        '    public function authorize(): bool { return true; }',
        '    public function rules(): array { return []; }',
        '    public function messages(): array { return []; }',
        '    public function attributes(): array { return []; }',
        '    public function user() { return (object) ["id" => 7]; }',
        '  }',
        '}',
        'namespace {',
        "  function config($key, $default = null) { return 'default'; }",
        "  function app($key = null) { return '1'; }",
        "  function user($key = null) { return '1'; }",
        "  function auth($key = null) { return '1'; }",
        "  function request($key = null) { return '1'; }",
        '}',
        '',
      ].join('\n')
    );
    // The child declares no method: its file has only a handful of lines,
    // while the parent's start line is past line 40. Reading the child file
    // with the parent's line numbers can never see the request-state idiom.
    writeFileSync(
      child,
      [
        '<?php',
        'namespace LwTest;',
        "require __DIR__ . '/parent.php';",
        'class ChildRequest extends BaseRequest {}',
        '',
      ].join('\n')
    );
    writeFileSync(
      driver,
      [
        '<?php',
        "define('LW_METADATA_LIB', true);",
        'require $argv[1];',
        'require $argv[2];',
        'require $argv[3];',
        "echo json_encode(lw_dump_formrequests(['LwTest\\\\ChildRequest']));",
        '',
      ].join('\n')
    );

    for (const { label, refuse, line } of REQUEST_STATE_CASES) {
      writeFileSync(
        parent,
        [
          '<?php',
          'namespace LwTest;',
          'use Illuminate\\Foundation\\Http\\FormRequest;',
          'class BaseRequest extends FormRequest {',
          pad,
          '    public function rules(): array {',
          line,
          '    }',
          '}',
          '',
        ].join('\n')
      );
      const raw = execFileSync(PHP, [driver, stub, dumpPath, child], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      const [entry] = JSON.parse(raw);
      assert.equal(entry.fqcn, 'LwTest\\ChildRequest', label);
      if (refuse) {
        assert.match(entry.error ?? '', /^rules\(\) reads request state/, `${label} must be refused`);
        assert.deepEqual(entry.rules, [], `${label}: a refused class carries no baked rules`);
      } else {
        assert.equal(entry.error, null, `${label} must not be refused`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
