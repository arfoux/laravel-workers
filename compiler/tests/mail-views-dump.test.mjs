#!/usr/bin/env node
// compiler/tests/mail-views-dump.test.mjs — the views a mailable renders are
// learned from the mailable's own source.
//
// A mailable renders a Blade view. That view is NOT reached from a route (the
// route sends the mail; the mailer renders the view), so the BUILD has to
// learn the view's name from the mailable's source and compile it - a mailable
// that renders a view the build does not know about compiles and then dies at
// request time (a 500 where Laravel sends the mail).
//
// Laravel's Mailable carries the view in TWO shapes (Laravel 13, the
// framework's own source):
//
//   Illuminate/Mail/Mailable.php:930 - the fluent call `->view('mail.order')`
//   Illuminate/Mail/Mailable.php:915 - the fluent call `->markdown('emails.order')`
//   Illuminate/Mail/Mailable.php:110 - the PUBLIC property `public $view;`
//   Illuminate/Mail/Mailable.php:117 - the PUBLIC property `public $textView;`
//
// and the app writes that property in either way:
//
//   public $view = 'mail.order';      // the declaration
//   $this->view = 'mail.order';       // the assignment (the constructor)
//
// The compiled kernel honours BOTH (kernel/mailable.mjs: the payload reads the
// fluent value first and falls back to the PUBLIC field), so a mailable in the
// property form COMPILES - but if the build never learns its view, the view is
// never compiled and the mail dies at request time.
//
// The tool (tools/mailable-views.php) is the whole extractor: it takes a
// mailable's source and answers the view names. The test needs PHP (the tool
// is a PHP file); without PHP it SKIPS with the reason - it never fails. No
// Laravel app is needed: the extractor reads the source, not the framework.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const toolPath = path.join(pkgDir, 'tools', 'mailable-views.php');
const PHP = process.env.PHP_BIN || 'php';

// The tool is a PHP file: without PHP the test skips too.
function hasPhp() {
  try {
    execFileSync(PHP, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = hasPhp()
  ? false
  : `mail-views-dump.test.mjs: no PHP (${PHP}) - the mailable views test is skipped`;

// The views a mailable's source declares.
function views(source) {
  const out = execFileSync(PHP, [toolPath], { input: source, encoding: 'utf8' });
  return JSON.parse(out);
}

test('mail-views: the fluent form - the view, the text view and the markdown view are learned', { skip }, () => {
  const source = `<?php

namespace App\\Mail;

use Illuminate\\Mail\\Mailable;

class OrderMail extends Mailable
{
    public function build()
    {
        return $this->subject('Order shipped')
            ->view('mail.order')
            ->textView('mail.text')
            ->markdown('emails.order');
    }
}
`;
  assert.deepEqual(views(source), ['mail.order', 'mail.text', 'emails.order']);
});

test('mail-views: the fluent form - the name can be in double quotes', { skip }, () => {
  const source = `<?php
return $this->view("mail.order")->textView("mail.text")->markdown("emails.order");
`;
  assert.deepEqual(views(source), ['mail.order', 'mail.text', 'emails.order']);
});

test('mail-views: the property form - the declared public property is learned', { skip }, () => {
  // The kernel reads the PUBLIC field (kernel/mailable.mjs), so a mailable
  // that declares its view that way renders it at the edge too.
  const source = `<?php

class OrderMail extends Mailable
{
    public $view = 'mail.order';
    public $textView = 'mail.text';
}
`;
  assert.deepEqual(views(source), ['mail.order', 'mail.text']);
});

test('mail-views: the property form - the assignment to the property is learned', { skip }, () => {
  const source = `<?php

class OrderMail extends Mailable
{
    public function __construct()
    {
        $this->view = 'mail.order';
        $this->textView = 'mail.text';
    }
}
`;
  assert.deepEqual(views(source), ['mail.order', 'mail.text']);
});

test('mail-views: a DYNAMIC name learns no view (the build cannot know which view to compile)', { skip }, () => {
  const source = `<?php
$name = 'mail.order';
return $this->view($name)->textView($name)->markdown($name);
`;
  assert.deepEqual(views(source), []);
});

test('mail-views: a mailable with no view learns no view (only a subject is legal)', { skip }, () => {
  const source = `<?php

class Ping extends Mailable
{
    public function build()
    {
        return $this->subject('Ping');
    }
}
`;
  assert.deepEqual(views(source), []);
});

test('mail-views: the same view is learned once', { skip }, () => {
  const source = `<?php

class OrderMail extends Mailable
{
    public $view = 'mail.order';

    public function build()
    {
        return $this->view('mail.order')->textView('mail.order');
    }
}
`;
  assert.deepEqual(views(source), ['mail.order']);
});

test('mail-views: the names come in the order the mailable declares them', { skip }, () => {
  const source = `<?php

class OrderMail extends Mailable
{
    public $view = 'mail.order';

    public function build()
    {
        return $this->textView('mail.text');
    }
}
`;
  assert.deepEqual(views(source), ['mail.order', 'mail.text']);
});

test('mail-views: the tool reads a file too (the CLI it documents)', { skip }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lw-mail-views-'));
  const file = path.join(dir, 'OrderMail.php');
  try {
    writeFileSync(
      file,
      `<?php\nclass OrderMail extends Mailable\n{\n    public $view = 'mail.order';\n}\n`,
      'utf8'
    );
    const out = execFileSync(PHP, [toolPath, file], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), ['mail.order']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
