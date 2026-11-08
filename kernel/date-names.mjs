// kernel/date-names.mjs — Carbon's localized month/day names.
//
// One table set shared by every date value the kernel hands out:
//   - `makeDateValue()` in kernel/model.mjs (a model's date attribute)
//   - `makeCarbon()` in compiler/runtime/rt-from-context.mjs (`now()`, dates a
//     controller builds)
// The two used to carry their own copy — and only one had `locale()` /
// `translatedFormat()`, so `$model->created_at->copy()->locale('id')
// ->translatedFormat('j M Y')` died on the compiled side. A locale without a
// table falls back to English, which is what `format()` already answers.
export const TRANSLATED_NAMES = {
  en: {
    months: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    monthsShort: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    days: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    daysShort: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
  },
  id: {
    // Copied from Carbon's own `Lang/id.php` (nesbot/carbon 3.x), the file
    // `translatedFormat()` reads: `months_short[7]` is 'Agt', not 'Agu'.
    // Pinned by kernel/tests/date-names.test.mjs.
    months: ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'],
    monthsShort: ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'],
    days: ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'],
    daysShort: ['Min','Sen','Sel','Rab','Kam','Jum','Sab'],
  },
};
