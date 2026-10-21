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

    // The three shapes, one pattern each. The name is a LITERAL string (the
    // quote that opens it closes it), so a dynamic name (`->view($name)`)
    // matches nothing.
    //
    //   the fluent call:  ->view('x')  ->textView('x')  ->markdown('x')
    //   the declaration:  public $view = 'x';  public $textView = 'x';
    //   the assignment:   $this->view = 'x';  $this->textView = 'x';
    //
    // The declaration needs the `public` keyword on purpose: a bare
    // `$view = 'x';` is a LOCAL variable, not the mailable's view, and
    // Laravel's Mailable declares the field `public` (a subclass cannot
    // narrow it - PHP refuses the redeclaration).
    $patterns = [
        // The fluent call.
        '/->(?:view|textView|markdown)\(\s*(["\'])([^"\']+)\1/',
        // The PUBLIC property (the declaration).
        '/\bpublic\s+\$(?:view|textView)\s*=\s*(["\'])([^"\']+)\1/',
        // The assignment to the property (`$this->view = 'x';`).
        '/\$this->(?:view|textView)\s*=\s*(["\'])([^"\']+)\1/',
    ];

    // Every match, with the place it was found: the names come out in the
    // order the mailable declares them (the first one wins).
    $found = [];
    $order = 0;
    foreach ($patterns as $pattern) {
        if (!preg_match_all($pattern, $source, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
            continue;
        }
        foreach ($matches as $set) {
            // $set[0] is the whole match (with its offset), $set[2] is the
            // view name (the group that holds it).
            $found[] = ['at' => $set[0][1], 'name' => $set[2][0], 'order' => $order++];
        }
    }
    usort($found, static function (array $a, array $b): int {
        return $a['at'] <=> $b['at'] ?: $a['order'] <=> $b['order'];
    });

    foreach ($found as $match) {
        if (!in_array($match['name'], $views, true)) {
            $views[] = $match['name'];
        }
    }

    return $views;
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
