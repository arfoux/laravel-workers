<?php

// tools/mailable-views.php — the views a mailable renders (build time).
//
// A mailable renders a Blade view. That view is NOT reached from a route (the
// route sends the mail; the mailer renders the view), so the BUILD has to
// learn the view's name from the mailable's own source - otherwise the view
// is never compiled and the request dies with "view not compiled" where
// Laravel sends the mail.
//
// Laravel's Mailable carries the view in TWO shapes (Laravel 13, the
// framework's own source):
//
//   Illuminate/Mail/Mailable.php:930 - the fluent call `->view('mail.order')`
//   Illuminate/Mail/Mailable.php:915 - the fluent call `->markdown('emails.order')`
//   Illuminate/Mail/Mailable.php:110 - the PUBLIC property `public $view;`
//   Illuminate/Mail/Mailable.php:117 - the PUBLIC property `public $textView;`
//
// and the app's own mailable writes that property in either way:
//
//   public $view = 'mail.order';      // the declaration
//   $this->view = 'mail.order';       // the assignment (the constructor)
//
// The compiled kernel honours BOTH (kernel/mailable.mjs: the payload reads the
// fluent value first and falls back to the PUBLIC field), so a mailable
// written in the property form COMPILES - but if the build never learns its
// view, the view is never compiled and the mail dies at request time.
//
// A DYNAMIC name (`->view($name)`) is not a literal view name: the build
// cannot know which view to compile, so it yields no name.
//
//   php tools/mailable-views.php <file>   # the JSON array of the view names
//   php tools/mailable-views.php           # the same, the source on stdin
//
// The function is the tool: tools/event-dump.php requires it and calls it for
// every app mailable.

/**
 * The view names a mailable renders.
 *
 * @param  string  $source  the mailable's own PHP source
 * @return array<int, string>  the names, de-duplicated, in first-seen order
 */
function lw_mailable_views(string $source): array
{
    $views = [];
    if ($source === '') {
        return $views;
    }

    // The source is TOKENIZED, never regex-scanned: `token_get_all()` already
    // knows that a `->view('x')` inside a `//` comment or inside a string
    // literal is NOT a call, which a bare regex cannot. A commented-out
    // mailable (`// ->view('mail.ghost')`) used to register `mail.ghost` as a
    // real view, and the build then refused the route that renders it ("the
    // view ... did not compile") - a FALSE fail-loud, not a real gap. A view
    // name spelled inside a string (`$doc = "->view('ghost')"`) leaked the
    // same way.
    //
    //   the fluent call:  ->view('x')  ->textView('x')  ->markdown('x')
    //   the declaration:  public $view = 'x';  public $textView = 'x';
    //   the assignment:   $this->view = 'x';  $this->textView = 'x';
    //
    // The declaration keeps the `public` keyword on purpose: a bare
    // `$view = 'x';` is a LOCAL variable, not the mailable's view, and
    // Laravel's Mailable declares the field `public` (a subclass cannot
    // narrow it - PHP refuses the redeclaration).
    $tokens = [];
    foreach (token_get_all($source) as $token) {
        if (is_array($token)) {
            // Comments and whitespace carry no code. A string literal stays
            // ONE token (quotes and all) - nothing can be matched inside it.
            if ($token[0] === T_COMMENT || $token[0] === T_DOC_COMMENT || $token[0] === T_WHITESPACE) {
                continue;
            }
            $tokens[] = ['id' => $token[0], 'text' => (string) $token[1]];
        } else {
            $tokens[] = ['id' => null, 'text' => (string) $token];
        }
    }

    $count = count($tokens);
    for ($i = 0; $i < $count; $i++) {
        $id = $tokens[$i]['id'];
        $name = null;

        if (($id === T_OBJECT_OPERATOR || $id === T_NULLSAFE_OBJECT_OPERATOR)
            && isset($tokens[$i + 3])
            && $tokens[$i + 1]['id'] === T_STRING
            && ($tokens[$i + 1]['text'] === 'view' || $tokens[$i + 1]['text'] === 'textView' || $tokens[$i + 1]['text'] === 'markdown')
            && $tokens[$i + 2]['text'] === '(') {
            // The fluent call: `->view(` then a literal argument.
            $name = lw_mailable_literal($tokens[$i + 3]);
        } elseif ($id === T_PUBLIC) {
            // The declaration: `public [type] $view = 'x';`. The `public` is
            // the discriminator - a bare `$view = 'x';` is a local variable.
            for ($j = $i + 1; $j < $count && $j <= $i + 4; $j++) {
                if ($tokens[$j]['id'] === T_VARIABLE) {
                    if (($tokens[$j]['text'] === '$view' || $tokens[$j]['text'] === '$textView')
                        && isset($tokens[$j + 2]) && $tokens[$j + 1]['text'] === '=') {
                        $name = lw_mailable_literal($tokens[$j + 2]);
                    }
                    break;
                }
            }
        } elseif ($id === T_VARIABLE && $tokens[$i]['text'] === '$this'
            && isset($tokens[$i + 4])
            && $tokens[$i + 1]['id'] === T_OBJECT_OPERATOR
            && $tokens[$i + 2]['id'] === T_STRING
            && ($tokens[$i + 2]['text'] === 'view' || $tokens[$i + 2]['text'] === 'textView')
            && $tokens[$i + 3]['text'] === '=') {
            // The assignment: `$this->view = 'x';` (the constructor).
            $name = lw_mailable_literal($tokens[$i + 4]);
        }

        if ($name !== null && !in_array($name, $views, true)) {
            $views[] = $name;
        }
    }

    return $views;
}

/**
 * The view name a literal token holds, or null when the token is not a plain
 * (non-interpolated) string literal - `->view($x)` and `->view("a{$b}")` are
 * dynamic, and the build cannot know which view to compile.
 *
 * @param  array{id: mixed, text: string}|null  $token
 */
function lw_mailable_literal(?array $token): ?string
{
    if ($token === null || $token['id'] !== T_CONSTANT_ENCAPSED_STRING) {
        return null;
    }
    $raw = $token['text'];
    $len = strlen($raw);
    if ($len < 2) {
        return null;
    }
    $quote = $raw[0];
    if (($quote !== "'" && $quote !== '"') || $raw[$len - 1] !== $quote) {
        return null;
    }
    $inner = substr($raw, 1, -1);
    if ($inner === '') {
        return null;
    }
    // Undo the two escapes a view name can carry. A view name is a dotted
    // path; the exotic double-quote escapes (`\n`, `\x41`, `\u{..}`) are not
    // expanded - they cannot appear in a real name, and expanding them would
    // only make the two mirrors harder to keep in step.
    return str_replace(['\\\\', '\\' . $quote], ['\\', $quote], $inner);
}

// The CLI: the tool prints the names of a source (the operator and the test
// use it). A library use (tools/event-dump.php) does not run it.
if (PHP_SAPI === 'cli'
    && isset($argv[0])
    && (realpath($argv[0]) === realpath(__FILE__) || basename((string) $argv[0]) === basename(__FILE__))) {
    $file = $argv[1] ?? '';
    if ($file === '' || $file === '-') {
        $source = (string) stream_get_contents(STDIN);
    } elseif (is_file($file)) {
        $source = (string) file_get_contents($file);
    } else {
        fwrite(STDERR, "usage: php tools/mailable-views.php <file>\n");
        exit(2);
    }

    echo json_encode(lw_mailable_views($source), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
    exit(0);
}
