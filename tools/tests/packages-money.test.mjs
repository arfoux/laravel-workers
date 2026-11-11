// tools/tests/packages-money.test.mjs — akaunting/laravel-money port.
//
// Pure value-object + formatter tests (no D1, no network):
//   - formatMoney renders IDR whole amounts as `Rp 1.000` and fractional ones
//     as `Rp 1.234,5` (locale separators, trimmed decimals),
//   - parseMoney is the inverse (round-trip),
//   - the default `handle` port returns Laravel-shaped 422 on bad input and a
//     200 `{ formatted }` payload on success,
//   - conversion is driven by an INJECTED rate (per-call or env.MONEY_RATES),
//   - the currency symbol table exposes IDR/USD/EUR/GBP/SGD/MYR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import money, { formatMoney, parseMoney, convertMoney, roundMoney, Money, CURRENCIES, MoneyError } from '../../kernel/packages/money.mjs';

const okCtx = (query = {}, body = {}) => ({ body, query, params: {} });

// ---- currency symbol table -------------------------------------------------

test('symbols: table exposes IDR, USD, EUR, GBP, SGD, MYR with symbol + decimals', () => {
  for (const code of ['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'MYR']) {
    assert.ok(CURRENCIES[code], `missing ${code}`);
    assert.ok(typeof CURRENCIES[code].symbol === 'string' && CURRENCIES[code].symbol.length > 0);
    assert.ok(Number.isInteger(CURRENCIES[code].decimals));
  }
  assert.equal(CURRENCIES.IDR.symbol, 'Rp');
  assert.equal(CURRENCIES.IDR.decimals, 0);
  assert.equal(CURRENCIES.USD.symbol, '$');
});

// ---- formatMoney -----------------------------------------------------------

test('format: 1000 IDR -> "Rp 1.000" (whole amount, no decimals)', () => {
  assert.equal(formatMoney(1000, 'IDR'), 'Rp 1.000');
});

test('format: 1234.5 IDR -> "Rp 1.234,5" (id-ID grouping, trimmed fraction)', () => {
  assert.equal(formatMoney(1234.5, 'IDR'), 'Rp 1.234,5');
});

test('format: large IDR amount groups with dots, trims trailing zero', () => {
  assert.equal(formatMoney(1234567, 'IDR'), 'Rp 1.234.567');
  assert.equal(formatMoney(1234567.5, 'IDR'), 'Rp 1.234.567,5');
});

test('format: a 2-decimal currency always shows its decimals', () => {
  // Default locale is id-ID, so separators are `'.'` (thousands) / `','` (decimal).
  assert.equal(formatMoney(1000, 'USD'), '$1.000,00');
  assert.equal(formatMoney(1234.5, 'EUR'), '€1.234,50');
});

test('format: en-US locale overrides the id-ID separators', () => {
  assert.equal(formatMoney(1234.5, 'IDR', 'en-US'), 'Rp 1,234.5');
});

test('format: numeric strings are coerced', () => {
  assert.equal(formatMoney('1000', 'IDR'), 'Rp 1.000');
});

test('format: non-finite value throws MoneyError', () => {
  assert.throws(() => formatMoney('abc', 'IDR'), MoneyError);
});

// ---- parseMoney ------------------------------------------------------------

test('parse: "Rp 1.000" -> 1000 and round-trips format', () => {
  assert.equal(parseMoney('Rp 1.000'), 1000);
  assert.equal(parseMoney(formatMoney(1000, 'IDR')), 1000);
});

test('parse: fractional round-trip preserves the value', () => {
  assert.equal(parseMoney(formatMoney(1234.5, 'IDR')), 1234.5);
  assert.equal(parseMoney('Rp 1.234,5'), 1234.5);
});

test('parse: large fractional round-trip', () => {
  assert.equal(parseMoney(formatMoney(1234567.89, 'IDR')), 1234567.89);
});

test('parse: handles a 2-decimal currency string', () => {
  assert.equal(parseMoney('$1,234.50', 'en-US'), 1234.5);
  assert.equal(parseMoney(formatMoney(1234.5, 'USD', 'en-US'), 'en-US'), 1234.5);
});

test('parse: garbage throws MoneyError', () => {
  assert.throws(() => parseMoney('Rp '), MoneyError);
  assert.throws(() => parseMoney('Rp notanumber'), MoneyError);
});

// ---- roundMoney ------------------------------------------------------------

test('round: IDR rounds to whole units, USD to 2 decimals', () => {
  assert.equal(roundMoney(1000.4, 'IDR'), 1000);
  assert.equal(roundMoney(1000.6, 'IDR'), 1001);
  assert.equal(roundMoney(1000.567, 'USD'), 1000.57);
});

// ---- conversion ------------------------------------------------------------

test('convert: applies an injected rate', () => {
  assert.equal(convertMoney(100, 'USD', 'IDR', 16000), 1_600_000);
});

test('convert: rejects a non-positive or missing rate', () => {
  assert.throws(() => convertMoney(100, 'USD', 'IDR', 0), MoneyError);
  assert.throws(() => convertMoney(100, 'USD', 'IDR', undefined), MoneyError);
});

// ---- Money value object ----------------------------------------------------

test('money value object: formats and freezes', () => {
  const m = new Money(1000, 'IDR');
  assert.equal(m.currency, 'IDR');
  assert.equal(m.amount, 1000);
  assert.equal(m.format(), 'Rp 1.000');
  assert.throws(() => {
    m.amount = 5;
  }, TypeError);
});

test('money value object: unknown currency throws', () => {
  assert.throws(() => new Money(1000, 'XYZ'), MoneyError);
});

// ---- default handle port ---------------------------------------------------

test('port: format returns 200 with the formatted string', async () => {
  const res = await money(okCtx({ value: 1000, currency: 'IDR' }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    op: 'format',
    currency: 'IDR',
    locale: 'id-ID',
    amount: 1000,
    formatted: 'Rp 1.000',
  });
});

test('port: fractional format', async () => {
  const res = await money(okCtx({ value: 1234.5, currency: 'IDR' }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).formatted, 'Rp 1.234,5');
});

test('port: missing currency is a 422', async () => {
  const res = await money(okCtx({ value: 1000 }));
  assert.equal(res.status, 422);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.errors.currency);
});

test('port: unknown currency is a 422', async () => {
  const res = await money(okCtx({ value: 1000, currency: 'XYZ' }));
  assert.equal(res.status, 422);
});

test('port: missing value is a 422', async () => {
  const res = await money(okCtx({ currency: 'IDR' }));
  assert.equal(res.status, 422);
  assert.ok(JSON.parse(res.body).errors.value);
});

test('port: non-numeric value is a 422', async () => {
  const res = await money(okCtx({ value: 'abc', currency: 'IDR' }));
  assert.equal(res.status, 422);
});

test('port: op=parse parses a formatted string', async () => {
  const res = await money(okCtx({ op: 'parse', value: 'Rp 1.234,5' }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).amount, 1234.5);
});

test('port: op=convert uses an injected env.MONEY_RATES table', async () => {
  const env = { MONEY_RATES: { USD: { IDR: 16000 } } };
  const res = await money(okCtx({ op: 'convert', value: 100, currency: 'USD', to: 'IDR' }), env);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.amount, 1_600_000);
  assert.equal(body.formatted, 'Rp 1.600.000');
});

test('port: op=convert can take an explicit rate from the query', async () => {
  const res = await money(okCtx({ op: 'convert', value: 100, currency: 'USD', to: 'IDR', rate: 15000 }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).amount, 1_500_000);
});

test('port: op=convert without a rate is a 422', async () => {
  const res = await money(okCtx({ op: 'convert', value: 100, currency: 'USD', to: 'IDR' }));
  assert.equal(res.status, 422);
});

test('port: params can ride in the body (POST-friendly)', async () => {
  const res = await money(okCtx({}, { value: 1000, currency: 'IDR' }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).formatted, 'Rp 1.000');
});