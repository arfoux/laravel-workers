// kernel/tests/date-names.test.mjs — the localized names match Carbon's own tables.
//
// `kernel/date-names.mjs` is the one table set behind `translatedFormat()` on
// both rungs (a model's date attribute and `now()`/dates a controller builds).
// Name tables are pure data copied from Carbon, so the failure mode is not a
// crash but a WRONG WORD in a rendered page — and the wrong word is invisible
// unless something pins it: `monthsShort[7]` said 'Agu' while Carbon's
// `Lang/id.php` says 'Agt', so every `translatedFormat('M')` in August rendered
// a month abbreviation Laravel itself never produces (#762).
//
// The expected arrays below are Carbon 3.x, `src/Carbon/Lang/{en,id}.php`, read
// with `php -r '$a = include "…/Lang/id.php"; echo json_encode($a);'` (PHP 8.3):
//   id.months_short -> Jan Feb Mar Apr Mei Jun Jul Agt Sep Okt Nov Des
//   id.weekdays     -> Minggu Senin Selasa Rabu Kamis Jumat Sabtu
// A wrong LENGTH shifts every later name by one, which no spot check catches, so
// the lengths are asserted with the contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSLATED_NAMES } from '../date-names.mjs';

test('the `id` table is Carbon\'s `Lang/id.php`, name for name', () => {
  const id = TRANSLATED_NAMES.id;
  assert.deepEqual(id.months, [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ]);
  assert.deepEqual(id.monthsShort, [
    'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des',
  ]);
  assert.deepEqual(id.days, ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']);
  assert.deepEqual(id.daysShort, ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']);
  // The one that shipped wrong, named on its own so a rewrite cannot "fix" the
  // length while putting the old word back.
  assert.equal(id.monthsShort[7], 'Agt');
  assert.equal(id.months[7], 'Agustus');
});

test('the `en` table is Carbon\'s `Lang/en.php`, name for name', () => {
  const en = TRANSLATED_NAMES.en;
  assert.deepEqual(en.months, [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
  ]);
  assert.deepEqual(en.monthsShort, [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]);
  assert.deepEqual(en.days, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  assert.deepEqual(en.daysShort, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
});

test('every locale carries all four tables at Carbon\'s lengths', () => {
  for (const [locale, t] of Object.entries(TRANSLATED_NAMES)) {
    assert.equal(t.months.length, 12, `${locale}: months`);
    assert.equal(t.monthsShort.length, 12, `${locale}: monthsShort`);
    assert.equal(t.days.length, 7, `${locale}: days`);
    assert.equal(t.daysShort.length, 7, `${locale}: daysShort`);
  }
});
