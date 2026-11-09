// tools/tests/class-constants.test.mjs — the class-constant FOLD (`evalConstantExpr`
// through `classConstants()`), the table `build.mjs` bakes into a compiled class
// and the transpiler reads for `Foo::BAR`.
//
// Audit #755: the `!` branch used JS truthiness (`!v`), so `const X = !'0';` folded
// to `false` while PHP answers `true` — and the folded value is what a compiled
// controller sees. The config path (evalConfigExpr) already went through phpBool();
// this scalar folder is a second implementation of PHP's `(bool)`.
//
// PHP 8.3 oracle (the vendor runtime):
//   php -r "var_dump(!'0', !'', !0, !'0.0', !'x', !null);"
//     -> bool(true) bool(true) bool(true) bool(false) bool(false) bool(true)
//   php -r "class F { const NEG = -'5'; const ARR = [1]; } var_dump(F::NEG, F::ARR);"
//     -> int(-5) array(1) { [0]=> int(1) }   (both OUT of the fold: see below)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classConstants, parsePhpFile } from '../../tools/static.mjs';

/** Write `App\Foo` with the given body and fold its constants. */
function foldConstants(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-const-'));
  try {
    mkdirSync(join(dir, 'app'), { recursive: true });
    const file = join(dir, 'app', 'Foo.php');
    writeFileSync(file, '<?php\nnamespace App;\nclass Foo {\n' + body + '\n}\n');
    const parsed = parsePhpFile(file);
    assert.equal(parsed.error, undefined, parsed.error);
    return classConstants(dir, parsed, parsed.classes[0]).constants;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a class constant folds `!` with PHP truthiness (`!\'0\'` is true)', () => {
  const c = foldConstants(
    [
      "  const ZERO_STR = !'0';",
      "  const EMPTY_STR = !'';",
      '  const ZERO_INT = !0;',
      "  const STR_ZERO_FLOAT = !'0.0';",
      "  const NONEMPTY = !'x';",
      '  const NEG_CONST = -12;',
    ].join('\n')
  );
  assert.equal(c.ZERO_STR, true, "php -r \"var_dump(!'0');\" -> bool(true)");
  assert.equal(c.EMPTY_STR, true);
  assert.equal(c.ZERO_INT, true);
  assert.equal(c.STR_ZERO_FLOAT, false, "'0.0' is a truthy string in PHP");
  assert.equal(c.NONEMPTY, false);

});

test('a constant the scalar folder cannot answer stays OUT of the dump (LW002 later, never a wrong value)', () => {
  const c = foldConstants(["  const NEG = -'5';", '  const ARR = [1];', "  const OK = 'v';"].join('\n'));
  assert.equal(c.OK, 'v');
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'NEG'), false, "PHP: -'5' is int(-5)");
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'ARR'), false);
});

test('`self::OTHER` and a signed literal fold like PHP', () => {
  const c = foldConstants(['  const BASE = 20;', '  const PLUS = 22;', '  const HOME = self::BASE . self::PLUS;', '  const NEG = -12;'].join('\n'));
  assert.equal(c.HOME, '2022', 'PHP concatenates the two ints as strings');
  assert.equal(c.NEG, -12);
});

// Audit #798: the NUMBER LITERAL reader and the bitwise/shift operators. PHP
// oracle (php 8.3.30):
//   class F { const OCT = 017; const UNDER = 1_000; const HEX = 0x1F;
//             const BIN = 0b1011; const SHIFT = 1 << 40; const MASK = 0xFF & 0x0F;
//             const XOR = 5 ^ 3; const OR = 8 | 4; const DOWN = 1024 >> 3; }
//   -> 15, 1000, 31, 11, 1099511627776, 15, 6, 12, 128
// `Number(node.value)` answered 17 for `017`, NaN for `1_000`, and JS's 32-bit
// `<<` answered 256 for `1 << 40` - all three baked into a compiled class.
test('numeric literals fold as PHP reads them, and the bitwise ops are 64-bit', () => {
  const c = foldConstants(
    [
      '  const OCT = 017;',
      '  const UNDER = 1_000;',
      '  const HEX = 0x1F;',
      '  const BIN = 0b1011;',
      '  const SHIFT = 1 << 40;',
      '  const MASK = 0xFF & 0x0F;',
      '  const XOR = 5 ^ 3;',
      '  const OR = 8 | 4;',
      '  const DOWN = 1024 >> 3;',
    ].join('\n')
  );
  assert.equal(c.OCT, 15, 'PHP reads 017 as OCTAL');
  assert.equal(c.UNDER, 1000, 'PHP 7.4+ ignores underscores inside a literal');
  assert.equal(c.HEX, 31);
  assert.equal(c.BIN, 11);
  assert.equal(c.SHIFT, 1099511627776, 'JS `<<` is 32-bit and answered 256');
  assert.equal(c.MASK, 15);
  assert.equal(c.XOR, 6);
  assert.equal(c.OR, 12);
  assert.equal(c.DOWN, 128);
});

test('a bitwise or literal shape the fold refuses is dropped, never rounded', () => {
  const c = foldConstants(
    ["  const TOO_FAR = 1 << 64;", '  const UNSAFE = 1 << 62;', '  const HUGE = 99999999999999999999;', "  const OK = 'v';"].join('\n')
  );
  assert.equal(c.OK, 'v');
  // PHP answers 0 for `1 << 64`, 4611686018427387904 for `1 << 62` and a FLOAT
  // for the oversized literal. None of the three is a JS number this fold can
  // hold exactly, so each constant stays OUT (LW002 later) - a stopped build,
  // never a wrong value.
  for (const k of ['TOO_FAR', 'UNSAFE', 'HUGE']) {
    assert.equal(Object.prototype.hasOwnProperty.call(c, k), false, k + ' must stay out of the dump');
  }
});

// Audit #701: `enum` was not a recognized declaration kind in `parsePhpFile`
// (`classes` held class/interface/trait only), so `constants-dump.mjs` answered
// `class not found` for a real enum and every route reading one failed its build
// with a false reason — while `extractController` reported the alias/FQCN fine.
// PHP oracle (php 8.3.30 + the app's vendor autoloader) for the enum below:
//   class_exists('App\Enums\State') -> true, enum_exists() -> true
//   (new ReflectionClass('App\Enums\State'))->getConstants()
//     -> ['Active' => enum(App\Enums\State::Active),
//         'Inactive' => enum(App\Enums\State::Inactive),
//         'DEFAULT_NAME' => 'inactive']
// `tools/constants-dump.php` keeps only `is_scalar($value) || $value === null`,
// so its JSON is {"DEFAULT_NAME":"inactive"} — the cases (enum INSTANCES) are not
// constants this dump carries, and the JS reader sees exactly the `classconst`
// node, which is the same set.
test('an enum is class-like: its constants are found, its cases are not constants (#701)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-enum-'));
  try {
    mkdirSync(join(dir, 'app', 'Enums'), { recursive: true });
    const file = join(dir, 'app', 'Enums', 'State.php');
    writeFileSync(
      file,
      `<?php
namespace App\\Enums;

enum State: string
{
    case Active = 'active';
    case Inactive = 'inactive';
    const DEFAULT_NAME = 'inactive';
}
`
    );
    const parsed = parsePhpFile(file);
    assert.equal(parsed.error, undefined, parsed.error);
    assert.equal(parsed.classes.length, 1, 'the enum must be discovered');
    assert.equal(parsed.classes[0].kind, 'enum');
    const c = classConstants(dir, parsed, parsed.classes[0]).constants;
    assert.deepEqual(c, { DEFAULT_NAME: 'inactive' }, 'the cases are enum instances, never scalars');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`X::class` folds to the FQCN string in the constant path too (#700)', () => {
  // The config path (`evalConfigExpr`) already answered `::class`; the constant
  // path looked for a constant literally named `class`, found none and dropped
  // the entry — so `public const TYPE = Status::class;` went missing from the
  // dump and every route reading it failed loud.
  const c = foldConstants(['  const TYPE = \\App\\Support\\Thing::class;', '  const SELF_TYPE = self::class;'].join('\n'));
  assert.equal(c.TYPE, 'App\\Support\\Thing');
  assert.equal(c.SELF_TYPE, 'App\\Foo', 'self::class is the declaring class');
});
