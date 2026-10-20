// kernel/tests/validation-messages.test.mjs — Laravel's validation messages.
//
// The texts come from Laravel's own lang/en/validation.php (the framework's
// copy is generated into kernel/validation-messages.data.mjs) and the
// placeholders are replaced the way Illuminate\Validation\ReplacesAttributes
// does. The app's own published file wins (the build dumps it with the
// translations) — Laravel's translator order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '../validator.mjs';
import { LARAVEL_VALIDATION_MESSAGES, defaultValidationMessage, renderValidationMessage } from '../validation-messages.mjs';

test('messages: the framework copy is Laravel 13\'s own wording', () => {
  assert.equal(LARAVEL_VALIDATION_MESSAGES.required, 'The :attribute field is required.');
  assert.equal(LARAVEL_VALIDATION_MESSAGES.file, 'The :attribute field must be a file.');
  assert.equal(LARAVEL_VALIDATION_MESSAGES.email, 'The :attribute field must be a valid email address.');
  assert.equal(LARAVEL_VALIDATION_MESSAGES.max.string, 'The :attribute field must not be greater than :max characters.');
  assert.equal(LARAVEL_VALIDATION_MESSAGES.max.file, 'The :attribute field must not be greater than :max kilobytes.');
  assert.equal(LARAVEL_VALIDATION_MESSAGES.max.array, 'The :attribute field must not have more than :max items.');
  assert.equal(
    LARAVEL_VALIDATION_MESSAGES.between.file,
    'The :attribute field must be between :min and :max kilobytes.'
  );
});

test('messages: the default message of a rule is Laravel\'s (per attribute type)', async () => {
  const v = new Validator({ title: 'abcdef' }, { title: 'max:3' });
  assert.equal(await v.fails(), true);
  assert.deepEqual(v.errors().title, ['The title field must not be greater than 3 characters.']);

  // The attribute's type picks the message: a plain `max` is a string rule
  // (Laravel's getAttributeType(): only the numeric rules make it 'numeric').
  const numeric = new Validator({ age: 42 }, { age: 'max:3' }, {}, { attributes: { age: 'Age' } });
  await numeric.fails();
  assert.deepEqual(numeric.errors().age, ['The Age field must not be greater than 3 characters.']);

  // ... and a numeric rule makes the attribute numeric.
  const numericRule = new Validator({ age: 42 }, { age: 'integer|max:3' }, {}, { attributes: { age: 'Age' } });
  await numericRule.fails();
  assert.deepEqual(numericRule.errors().age, ['The Age field must not be greater than 3.']);
});

test('messages: the app\'s own file wins (the build dumps it with the translations)', async () => {
  const appMessages = {
    required: 'The :attribute is obligatory.',
    max: { string: 'The :attribute is too long (max :max).' },
  };
  const v = new Validator({ title: '' }, { title: 'required' }, {}, { defaultMessages: appMessages });
  await v.fails();
  assert.deepEqual(v.errors().title, ['The title is obligatory.']);

  const sized = new Validator({ title: 'abcdef' }, { title: 'max:3' }, {}, { defaultMessages: appMessages });
  await sized.fails();
  assert.deepEqual(sized.errors().title, ['The title is too long (max 3).']);
});

test('messages: the placeholders are replaced like Laravel does', async () => {
  // required_if: the other attribute's name + its value.
  let v = new Validator({ role: 'admin', name: '' }, { name: 'required_if:role,admin' });
  await v.fails();
  assert.deepEqual(v.errors().name, ['The name field is required when role is admin.']);

  // in: the values, comma separated.
  v = new Validator({ status: 'x' }, { status: 'in:a,b' });
  await v.fails();
  assert.deepEqual(v.errors().status, ['The selected status is invalid.']);

  // same: the other attribute's display name.
  v = new Validator({ a: 'x', b: 'y' }, { a: 'same:b' });
  await v.fails();
  assert.deepEqual(v.errors().a, ['The a field must match b.']);

  // between: both bounds.
  v = new Validator({ n: 5 }, { n: 'between:1,3' });
  await v.fails();
  assert.deepEqual(v.errors().n, ['The n field must be between 1 and 3 characters.']);

  // digits / decimal / date_format.
  v = new Validator({ code: 'ab' }, { code: 'digits:4' });
  await v.fails();
  assert.deepEqual(v.errors().code, ['The code field must be 4 digits.']);

  v = new Validator({ price: '1.234' }, { price: 'decimal:2' });
  await v.fails();
  assert.deepEqual(v.errors().price, ['The price field must have 2 decimal places.']);

  // date_format: an impossible date is not a date (Laravel's createFromFormat).
  v = new Validator({ day: '2026-13-01' }, { day: 'date_format:Y-m-d' });
  await v.fails();
  assert.deepEqual(v.errors().day, ['The day field must match the format Y-m-d.']);

  v = new Validator({ day: '2026-02-30' }, { day: 'date_format:Y-m-d' });
  await v.fails();
  assert.deepEqual(v.errors().day, ['The day field must match the format Y-m-d.']);

  v = new Validator({ day: '2026-01-31' }, { day: 'date_format:Y-m-d' });
  assert.equal(await v.passes(), true);
});

test('messages: a custom message keeps the placeholders of the rule', async () => {
  const v = new Validator({ title: 'abcdef' }, { title: 'max:3' }, { 'title.max': 'Too long (:max)!' });
  await v.fails();
  assert.deepEqual(v.errors().title, ['Too long (3)!']);
});

test('messages: a rule without a message answers the translator key (Laravel does the same)', async () => {
  // `bail` and the other modifiers have no message of their own; a rule the
  // table does not know answers `validation.<rule>` — the translator returns
  // the key itself.
  assert.equal(defaultValidationMessage(LARAVEL_VALIDATION_MESSAGES, 'max', 'file'),
    'The :attribute field must not be greater than :max kilobytes.');
  assert.equal(defaultValidationMessage({}, 'max', 'file'), null);
  assert.equal(
    renderValidationMessage('validation.max', { attribute: 'title', display: 'title', rule: 'max', params: [] }),
    'validation.max'
  );
});
