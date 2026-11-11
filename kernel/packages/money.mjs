// kernel/packages/money.mjs — akaunting/laravel-money port.
//
// A small money VALUE-OBJECT + formatter covering the slice of
// `akaunting/laravel-money` an edge runtime actually needs:
//   1. `formatMoney(value, currency, locale?)` — locale-aware grouping +
//      decimal separators, honouring each currency's minor-unit count
//      (pembulatan) and, for whole-unit currencies (IDR), showing a trimmed
//      fractional part only when the amount actually carries one
//      (`1000` -> `Rp 1.000`, `1234.5` -> `Rp 1.234,5`).
//   2. `parseMoney(str, locale?)` — inverse of the above, locale-aware.
//   3. `convertMoney(value, from, to, rate)` — explicit exchange-rate
//      conversion. No real-time FX feed is bundled; the rate is INJECTED
//      (per-call `rate`, or an `env.MONEY_RATES` map the handler consults).
//   4. A tiny `Money` value-object wrapper (immutable amount + currency).
//
// Currency symbol table is deliberately small (IDR, USD, EUR, GBP, SGD, MYR)
// to match the task; unknown codes raise a 422 `MoneyError`.
//
// Errors are `MoneyError` carrying a `status` (422 for bad input) so the
// default `handle` port maps them straight to a Laravel-shaped 422 JSON body
// without a special-case ladder.

import { normalizePortCtx } from './port-ctx.mjs';

// --- currency table --------------------------------------------------------

export const CURRENCIES = {
  IDR: { symbol: 'Rp', decimals: 0, gap: true },
  USD: { symbol: '$', decimals: 2, gap: false },
  EUR: { symbol: '€', decimals: 2, gap: false },
  GBP: { symbol: '£', decimals: 2, gap: false },
  SGD: { symbol: 'S$', decimals: 2, gap: false },
  MYR: { symbol: 'RM', decimals: 2, gap: true },
};

/** A money-specific input error. `status` is 422 for caller-correctable input. */
export class MoneyError extends Error {
  constructor(message, { status = 422, field = 'value' } = {}) {
    super(message);
    this.name = 'MoneyError';
    this.status = status;
    this.field = field;
  }
}

function resolveCurrencyCode(currency, field = 'currency') {
  if (currency === undefined || currency === null || String(currency).trim() === '') {
    throw new MoneyError('A currency is required.', { field });
  }
  const code = String(currency).trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(CURRENCIES, code)) {
    throw new MoneyError(`Unknown currency "${code}".`, { field });
  }
  return code;
}

// --- separators ------------------------------------------------------------

// The decimal separator a locale uses (derived, never hard-coded per locale).
function decimalSeparator(locale = 'id-ID') {
  const sample = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 2 }).format(1.1);
  const sep = sample.replace(/1/g, '').charAt(0);
  return sep === ',' || sep === '.' ? sep : '.';
}

function thousandsSeparator(locale = 'id-ID') {
  return decimalSeparator(locale) === ',' ? '.' : ',';
}

// --- format ----------------------------------------------------------------

// Locale-aware, per-currency formatting. Currencies with minor units (USD,
// EUR, ...) always render their decimals; whole-unit currencies (IDR) render a
// trimmed fractional part ONLY when the amount has one, so `1000` -> `Rp
// 1.000` and `1234.5` -> `Rp 1.234,5` (no trailing `,0`).
export function formatMoney(value, currency, locale = 'id-ID') {
  const code = resolveCurrencyCode(currency);
  const spec = CURRENCIES[code];
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new MoneyError('The value must be a finite number.', { field: 'value' });
  }
  const minFrac = spec.decimals > 0 ? spec.decimals : 0;
  const maxFrac = spec.decimals > 0 ? spec.decimals : 2;
  const nf = new Intl.NumberFormat(locale, {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  });
  const grouped = nf.format(num);
  return spec.gap ? `${spec.symbol} ${grouped}` : `${spec.symbol}${grouped}`;
}

// Round to a currency's minor units (pembulatan). `1000.567` IDR -> `1000.57`
// is not meaningful (IDR has 0 decimals) so it rounds to the nearest whole.
export function roundMoney(value, currency) {
  const code = resolveCurrencyCode(currency);
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new MoneyError('The value must be a finite number.', { field: 'value' });
  }
  const factor = 10 ** CURRENCIES[code].decimals;
  return Math.round(num * factor) / factor;
}

// --- parse -----------------------------------------------------------------

// Parse a formatted money string back to a number, using `locale` to decide
// which separator is the decimal point (the default `id-ID` matches
// `formatMoney`). Unknown whole-unit symbols / currency codes are stripped.
export function parseMoney(str, locale = 'id-ID') {
  if (str === undefined || str === null || String(str).trim() === '') {
    throw new MoneyError('A money string is required.', { field: 'value' });
  }
  let s = String(str).trim();
  // Strip a leading and/or trailing symbol or bare code (e.g. `Rp`, `S$`, `IDR`).
  for (const code of Object.keys(CURRENCIES)) {
    const candidates = [CURRENCIES[code].symbol, code];
    for (const sym of candidates) {
      if (s.startsWith(sym)) s = s.slice(sym.length).trim();
      if (s.endsWith(sym)) s = s.slice(0, s.length - sym.length).trim();
    }
  }
  s = s.replace(/\s/g, '');
  if (!s) throw new MoneyError('Nothing numeric to parse.', { field: 'value' });
  const dec = decimalSeparator(locale);
  const thou = thousandsSeparator(locale);
  s = s.split(thou).join('');
  s = dec === '.' ? s : s.split(dec).join('.');
  const num = Number(s);
  if (!Number.isFinite(num)) {
    throw new MoneyError(`Cannot parse "${str}" as a money amount.`, { field: 'value' });
  }
  return num;
}

// --- conversion ------------------------------------------------------------

// Explicit-rate conversion. The rate is INJECTED — never fetched — so an edge
// deployment supplies it per call or via an `env.MONEY_RATES` lookup table.
export function convertMoney(value, from, to, rate) {
  const fromCode = resolveCurrencyCode(from, 'from');
  const toCode = resolveCurrencyCode(to, 'to');
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    throw new MoneyError('A positive exchange rate is required for conversion.', { field: 'rate' });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new MoneyError('The value must be a finite number.', { field: 'value' });
  }
  return num * r;
}

// --- value object ----------------------------------------------------------

/** A minimal immutable money value-object: `{ amount, currency }` + format. */
export class Money {
  constructor(amount, currency) {
    this.currency = resolveCurrencyCode(currency);
    const num = Number(amount);
    if (!Number.isFinite(num)) {
      throw new MoneyError('The amount must be a finite number.', { field: 'amount' });
    }
    this.amount = num;
    Object.freeze(this);
  }
  format(locale = 'id-ID') {
    return formatMoney(this.amount, this.currency, locale);
  }
  round() {
    return roundMoney(this.amount, this.currency);
  }
  convertTo(to, rate) {
    return convertMoney(this.amount, this.currency, to, rate);
  }
}

// --- port handler ----------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (status, payload) => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(payload),
});
const ok = (payload) => json(200, payload);
const invalid = (message, errors = {}) => json(422, { ok: false, message, errors });

// Read a param from query then body.
function pick(ctx, key) {
  if (ctx.query && ctx.query[key] !== undefined) return ctx.query[key];
  if (ctx.body && ctx.body[key] !== undefined) return ctx.body[key];
  return undefined;
}

export default async function handle(ctx, env = {}) {
  ctx = normalizePortCtx(ctx);
  const read = (k) => pick(ctx, k);
  const locale = read('locale') || 'id-ID';

  try {
    const op = String(read('op') || read('action') || 'format').toLowerCase();

    // parse: string -> number (currency optional, used only to strip symbols).
    if (op === 'parse') {
      const str = read('value') !== undefined ? read('value') : read('str');
      const amount = parseMoney(str, locale);
      return ok({ ok: true, op, amount });
    }

    // format / convert both require a currency.
    const currency = read('currency');
    if (currency === undefined || currency === null || String(currency).trim() === '') {
      return invalid('The currency field is required.', {
        currency: ['The currency field is required.'],
      });
    }
    const code = resolveCurrencyCode(currency);

    const value = read('value') !== undefined ? read('value') : read('amount');
    if (value === undefined || value === null || value === '') {
      return invalid('The value field is required.', { value: ['The value field is required.'] });
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return invalid('The value must be a finite number.', {
        value: ['The value must be a finite number.'],
      });
    }

    if (op === 'convert') {
      const to = read('to');
      if (!to) {
        return invalid('The to field is required for conversion.', {
          to: ['The to field is required for conversion.'],
        });
      }
      let rate = read('rate');
      if (rate === undefined && env.MONEY_RATES) {
        rate = (env.MONEY_RATES[code] || {})[resolveCurrencyCode(to, 'to')];
      }
      const converted = convertMoney(num, code, to, rate);
      return ok({
        ok: true,
        op,
        from: code,
        to: resolveCurrencyCode(to, 'to'),
        amount: converted,
        formatted: formatMoney(converted, to, locale),
      });
    }

    // default: format
    return ok({
      ok: true,
      op: 'format',
      currency: code,
      locale,
      amount: num,
      formatted: formatMoney(num, code, locale),
    });
  } catch (err) {
    if (err instanceof MoneyError) {
      return invalid(err.message, { [err.field]: [err.message] });
    }
    throw err;
  }
}