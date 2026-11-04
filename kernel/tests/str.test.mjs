// kernel/tests/str.test.mjs - the Str family, verified against the real
// Laravel (the oracle: the fixture app's vendor, PHP 8.3). The expected values
// below are PHP's, not ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { str, ascii } from '../str.mjs';

test('Str: the values match PHP 8.3 / Laravel 13.37', () => {
  // slug
  assert.equal(str.slug('Hello World'), 'hello-world');
  assert.equal(str.slug('H\u00e9llo W\u00f6rld'), 'hello-world');
  assert.equal(str.slug('A  B--c'), 'a-b-c');
  // limit
  assert.equal(str.limit('Hello World', 5), 'Hello...');
  assert.equal(str.limit('Hello', 10), 'Hello');
  assert.equal(str.limit('Hello World', 5, '...'), 'Hello...');
  // upper / lower
  assert.equal(str.upper('hello'), 'HELLO');
  assert.equal(str.lower('HELLO'), 'hello');
  // studly / camel / snake / kebab / title
  assert.equal(str.studly('hello_world'), 'HelloWorld');
  assert.equal(str.camel('hello_world'), 'helloWorld');
  assert.equal(str.snake('HelloWorld'), 'hello_world');
  assert.equal(str.kebab('HelloWorld'), 'hello-world');
  assert.equal(str.title('hello world'), 'Hello World');
  // contains / startsWith / endsWith (case sensitive)
  assert.equal(str.contains('Hello World', 'world'), false);
  assert.equal(str.contains('Hello World', 'World'), true);
  assert.equal(str.startsWith('Hello World', 'Hello'), true);
  assert.equal(str.endsWith('Hello World', 'World'), true);
  // after / before / length
  assert.equal(str.after('Hello World', 'Hello '), 'World');
  assert.equal(str.before('Hello World', ' World'), 'Hello');
  assert.equal(str.length('Hello World'), 11);
  // replace / replaceFirst / replaceLast
  assert.equal(str.replace('World', 'Edge', 'Hello World'), 'Hello Edge');
  // str_replace() semantics (probed on PHP 8.3): arrays, a short replace list
  // fills the rest with '', a non-array replace pairs with every search, and
  // the 4th argument is case-insensitive mode.
  assert.equal(str.replace(['a', 'b'], ['x', 'y'], 'ab'), 'xy');
  assert.equal(str.replace(['a', 'b'], ['x'], 'ab'), 'x');
  assert.equal(str.replace(['a', 'b'], 'x', 'ab'), 'xx');
  assert.equal(str.replace('Ab', 'x', 'aB ab', false), 'x x');
  assert.equal(str.replace('', 'x', 'ab'), 'ab');
  assert.equal(str.replaceFirst('Hello World', 'World', 'Edge'), 'Edge');
  assert.equal(str.replaceLast('Hello World', 'l', 'L'), 'L');
  // squish / ucfirst / ucwords / ascii
  assert.equal(str.squish('  Hello   World  '), 'Hello World');
  assert.equal(str.ucfirst('hello world'), 'Hello world');
  assert.equal(str.ucwords('hello world'), 'Hello World');
  assert.equal(str.ascii('H\u00e9llo W\u00f6rld'), 'Hello World');
});

test('Str: the family answers like Laravel 13.37 (the probed values)', () => {
  // title: mb_convert_case(MB_CASE_TITLE) - a word is a run of CASED letters;
  // a case-ignorable character does not end it ('a.b' -> 'A.b'), any other
  // character does ('a1b2' -> 'A1B2').
  assert.equal(str.title('hello-world'), 'Hello-World');
  assert.equal(str.title('HELLO WORLD'), 'Hello World');
  assert.equal(str.title('a1b2'), 'A1B2');
  assert.equal(str.title('hello.world'), 'Hello.world');
  assert.equal(str.title("o'brien"), "O'brien");
  assert.equal(str.title('\u00fcn\u00efcode stra\u00dfe'), '\u00dcn\u00efcode Stra\u00dfe');
  assert.equal(str.title('\u01c6ungla'), '\u01c5ungla');
  assert.equal(str.title('\u00df'), 'Ss');
  // ucwords: only a LOWERCASE letter right after a separator is uppercased.
  assert.equal(str.ucwords('foo_bar'), 'Foo_bar');
  assert.equal(str.ucwords('\u00e9cole'), '\u00c9cole');
  assert.equal(str.ucwords('HELLO WORLD'), 'HELLO WORLD');
  assert.equal(str.ucwords('hello-world'), 'Hello-world');
  // snake / kebab: ctype_lower is true only for a lowercase ASCII string.
  assert.equal(str.snake('hello world'), 'hello_world');
  assert.equal(str.snake('HELLO WORLD'), 'h_e_l_l_o_w_o_r_l_d');
  assert.equal(str.snake('hello-world'), 'hello-world');
  assert.equal(str.kebab('HelloWorld'), 'hello-world');
  // slug: Laravel's dictionary ('@' -> 'at').
  assert.equal(str.slug('a@b'), 'a-at-b');
  assert.equal(str.slug('a@b c'), 'a-at-b-c');
  // contains / startsWith / endsWith: an empty needle is false.
  assert.equal(str.contains('hello', ''), false);
  assert.equal(str.startsWith('hello', ''), false);
  assert.equal(str.endsWith('hello', ''), false);
  // limit: the limit is a DISPLAY width (a CJK glyph is two columns).
  assert.equal(str.limit('\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8', 10), '\u65e5\u672c\u8a9e\u30c6\u30ad...');
  assert.equal(str.limit('\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8', 4), '\u65e5\u672c...');
  // ucfirst / camel: mb_ucfirst / mb_lcfirst (the first CHARACTER).
  assert.equal(str.ucfirst('\u01c6ungla'), '\u01c5ungla');
  assert.equal(str.ucfirst('\u00df'), 'Ss');
  assert.equal(str.camel('\u00e9t\u00e9'), '\u00e9t\u00e9');
  assert.equal(str.camel('\u00df'), 'ss');
});

test('Str: is/finish/start/random match PHP 8.3 / Laravel 13.37', () => {
  // Str::is — wildcard, full-string, array patterns, ignoreCase (Laravel 11+).
  assert.equal(str.is('foo/*', 'foo/bar'), true);
  assert.equal(str.is('foo/*', 'foo/bar/baz'), true);
  assert.equal(str.is('foo/*', 'foo'), false);
  assert.equal(str.is(['a*', 'b*'], 'bar'), true);
  assert.equal(str.is('FOO/*', 'foo/bar'), false);
  assert.equal(str.is('FOO/*', 'foo/bar', true), true);
  assert.equal(str.is('*', 'anything'), true);
  assert.equal(str.is('foo.bar', 'fooXbar'), false);
  // Str::finish / Str::start — no repeated cap, strip the run then add one.
  assert.equal(str.finish('abbc', 'c'), 'abbc');
  assert.equal(str.finish('ab', 'bc'), 'abbc');
  assert.equal(str.finish('abbcbc', 'bc'), 'abbc');
  assert.equal(str.finish('abcbbc', 'bc'), 'abcbbc');
  assert.equal(str.finish('abc', ''), 'abc');
  assert.equal(str.start('abbc', 'a'), 'abbc');
  assert.equal(str.start('bc', 'ab'), 'abbc');
  assert.equal(str.start('aabbc', 'a'), 'abbc');
  assert.equal(str.start('abc', ''), 'abc');
  // Str::random — the alphabet (base64 minus '/' '+' '=') and the length.
  assert.equal(str.random(40).length, 40);
  assert.match(str.random(40), /^[A-Za-z0-9]{40}$/);
  assert.equal(str.random(0), '');
});

// The transliteration is portable-ascii's own table (kernel/ascii-map.data.mjs,
// generated by tools/ascii-map.php). The hand-written Latin-1 map it replaced
// dropped everything past Latin-1, so a European or Greek title slugged to
// garbage: `Str::slug('zluťoučký')` lost the z, t, c and y. These are the PHP
// 8.3 values (Str::ascii / Str::slug on the fixture app).
test('Str::ascii / Str::slug: the portable-ascii transliteration', () => {
  assert.equal(str.ascii('Ünïcode'), 'Unicode');
  assert.equal(str.ascii('žluťoučký'), 'zlutoucky');
  assert.equal(str.ascii('Łódź'), 'Lodz');
  assert.equal(str.ascii('Œuvre'), 'OEuvre');
  assert.equal(str.ascii('straße'), 'strasse');
  assert.equal(str.ascii('Æther'), 'AEther');
  assert.equal(str.ascii('Þór'), 'THor');
  assert.equal(str.ascii('Ĳsselmeer'), 'IJsselmeer');
  assert.equal(str.ascii('Ελληνικά'), 'Ellinika');
  assert.equal(str.ascii('Привет мир'), 'Privet mir');
  assert.equal(str.ascii('İstanbul'), 'Istanbul');
  assert.equal(str.ascii('ﬀ'), 'ff');
  // A code point the table does not name is dropped, not guessed.
  assert.equal(str.ascii('中文'), '');
  assert.equal(str.ascii('°'), '');
  assert.equal(str.ascii('÷'), '');
  // remove_unsupported_chars: the line breaks become spaces first.
  assert.equal(str.ascii('a\tb'), 'a b');
  assert.equal(str.ascii('\r\n'), ' ');
  assert.equal(str.ascii('\u00a0'), ' ');
  // The same values through slug(), which runs its title through ascii().
  assert.equal(str.slug('žluťoučký'), 'zlutoucky');
  assert.equal(str.slug('Łódź'), 'lodz');
  assert.equal(str.slug('Œuvre'), 'oeuvre');
  assert.equal(str.slug('straße'), 'strasse');
  assert.equal(str.slug('Æther'), 'aether');
  assert.equal(str.slug('Þór'), 'thor');
  assert.equal(str.slug('Ελληνικά'), 'ellinika');
  assert.equal(str.slug('Привет мир'), 'privet-mir');
  assert.equal(str.slug('中文'), '');
  assert.equal(str.slug('a\tb'), 'a-b');
});
