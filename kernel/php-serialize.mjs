// kernel/php-serialize.mjs — PHP serialize()/unserialize() subset.
//
// Byte-compatible with PHP 8.3 (serialize_precision=-1) for the session
// payload subset: null, bool, int, float, string (UTF-8 byte length), and
// arrays with int/string keys. Anything else — objects (O:), references
// (r:/R:), custom serializables (C:), bigints, class instances — throws:
// the compiled rung never guesses, it either matches PHP byte-for-byte or
// fails loud.
//
// Known normalization (documented, tested): PHP distinguishes float(1.0)
// (`d:1;`) from int(1) (`i:1;`); JavaScript numbers do not. Decoding `d:1;`
// yields the number 1, which re-encodes as `i:1;`. Integral doubles are
// never produced by Laravel's session payloads; everything else round-trips
// byte-for-byte.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class PhpSerializeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhpSerializeError';
  }
}

const INT_KEY_RE = /^(?:0|-?[1-9][0-9]*)$/;
const SAFE = Number.MAX_SAFE_INTEGER;

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---- encode ---------------------------------------------------------------

export function phpFloat(v, e = 'E') {
  if (Object.is(v, -0)) return '-0';
  if (v === 0) return '0';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const [mant, ePart] = abs.toExponential().split('e');
  const exp = parseInt(ePart, 10);
  if (exp >= 17 || exp <= -5) {
    // Scientific: PHP always prints a fraction digit in the mantissa (1.0E+17)
    const m = mant.includes('.') ? mant : mant + '.0';
    return `${sign}${m}${e}${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`;
  }
  const digits = mant.replace('.', '');
  if (exp >= 0) {
    if (digits.length <= exp + 1) return sign + digits + '0'.repeat(exp + 1 - digits.length);
    return sign + digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  }
  return sign + '0.' + '0'.repeat(-exp - 1) + digits;
}

function writeValue(value, out) {
  if (value === null) {
    out.push('N;');
    return;
  }
  if (value === undefined) {
    throw new PhpSerializeError('undefined is not a PHP value');
  }
  const t = typeof value;
  if (t === 'boolean') {
    out.push(value ? 'b:1;' : 'b:0;');
    return;
  }
  if (t === 'number') {
    if (Number.isNaN(value)) {
      out.push('d:NAN;');
      return;
    }
    if (value === Infinity) {
      out.push('d:INF;');
      return;
    }
    if (value === -Infinity) {
      out.push('d:-INF;');
      return;
    }
    if (Object.is(value, -0)) {
      out.push('d:-0;');
      return;
    }
    if (Number.isSafeInteger(value)) {
      out.push('i:', String(value), ';');
      return;
    }
    out.push('d:', phpFloat(value), ';');
    return;
  }
  if (t === 'string') {
    out.push('s:', String(encoder.encode(value).length), ':"', value, '";');
    return;
  }
  if (t === 'bigint') {
    throw new PhpSerializeError('bigint is not supported (PHP int64 out of JS safe range)');
  }
  if (Array.isArray(value)) {
    out.push('a:', String(value.length), ':{');
    for (let i = 0; i < value.length; i++) {
      out.push('i:', String(i), ';');
      writeValue(value[i], out);
    }
    out.push('}');
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    out.push('a:', String(keys.length), ':{');
    for (const key of keys) {
      if (INT_KEY_RE.test(key)) {
        const n = Number(key);
        if (Number.isSafeInteger(n)) {
          out.push('i:', String(n), ';');
          writeValue(value[key], out);
          continue;
        }
      }
      out.push('s:', String(encoder.encode(key).length), ':"', key, '";');
      writeValue(value[key], out);
    }
    out.push('}');
    return;
  }
  const name = value?.constructor?.name || t;
  throw new PhpSerializeError(`unsupported value (${name}) — PHP objects/references are outside the subset`);
}

export function phpSerialize(value) {
  const out = [];
  writeValue(value, out);
  return out.join('');
}

// ---- decode ---------------------------------------------------------------

function readUntil(bytes, state, stop) {
  let i = state.pos;
  while (i < bytes.length && bytes[i] !== stop) i++;
  if (i >= bytes.length) throw new PhpSerializeError('unterminated value');
  const text = String.fromCharCode(...bytes.subarray(state.pos, i));
  state.pos = i + 1;
  return text;
}

function readValue(bytes, state) {
  if (state.pos >= bytes.length) throw new PhpSerializeError('unexpected end of input');
  const type = String.fromCharCode(bytes[state.pos]);
  state.pos++;
  if (type === 'N') {
    expect(bytes, state, 0x3b /* ; */);
    return null;
  }
  if (type === 'b') {
    expect(bytes, state, 0x3a /* : */);
    const c = bytes[state.pos];
    state.pos++;
    expect(bytes, state, 0x3b);
    if (c === 0x31) return true;
    if (c === 0x30) return false;
    throw new PhpSerializeError('invalid bool byte');
  }
  if (type === 'i') {
    expect(bytes, state, 0x3a);
    const text = readUntil(bytes, state, 0x3b);
    if (!/^-?\d+$/.test(text)) throw new PhpSerializeError(`invalid int: ${text}`);
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw new PhpSerializeError(`int out of JS safe range: ${text}`);
    return n;
  }
  if (type === 'd') {
    expect(bytes, state, 0x3a);
    const text = readUntil(bytes, state, 0x3b);
    if (text === 'NAN') return NaN;
    if (text === 'INF') return Infinity;
    if (text === '-INF') return -Infinity;
    const n = Number(text);
    if (Number.isNaN(n) && text !== 'NAN') throw new PhpSerializeError(`invalid float: ${text}`);
    return n;
  }
  if (type === 's') {
    expect(bytes, state, 0x3a);
    const lenText = readUntil(bytes, state, 0x3a);
    if (!/^\d+$/.test(lenText)) throw new PhpSerializeError(`invalid string length: ${lenText}`);
    const len = Number(lenText);
    expect(bytes, state, 0x22 /* " */);
    if (state.pos + len > bytes.length) throw new PhpSerializeError('string length exceeds input');
    const slice = bytes.subarray(state.pos, state.pos + len);
    state.pos += len;
    expect(bytes, state, 0x22);
    expect(bytes, state, 0x3b);
    return decoder.decode(slice);
  }
  if (type === 'a') {
    expect(bytes, state, 0x3a);
    const countText = readUntil(bytes, state, 0x3a);
    if (!/^\d+$/.test(countText)) throw new PhpSerializeError(`invalid array count: ${countText}`);
    const count = Number(countText);
    expect(bytes, state, 0x7b /* { */);
    const pairs = [];
    let listLike = true;
    for (let i = 0; i < count; i++) {
      const key = readValue(bytes, state);
      const value = readValue(bytes, state);
      if (!(typeof key === 'number' && Number.isSafeInteger(key)) && typeof key !== 'string') {
        throw new PhpSerializeError('array key is not int/string');
      }
      if (key !== i) listLike = false;
      pairs.push([key, value]);
    }
    expect(bytes, state, 0x7d /* } */);
    if (listLike) return pairs.map(([, v]) => v);
    const obj = {};
    for (const [key, value] of pairs) {
      obj[typeof key === 'number' ? String(key) : key] = value;
    }
    return obj;
  }
  if (type === 'O') throw new PhpSerializeError('PHP object (O:) is outside the subset');
  if (type === 'C') throw new PhpSerializeError('PHP custom serializable (C:) is outside the subset');
  if (type === 'r' || type === 'R') throw new PhpSerializeError('PHP references (r:/R:) are outside the subset');
  if (type === 'S') throw new PhpSerializeError('PHP escaped string (S:) is outside the subset');
  throw new PhpSerializeError(`unknown type marker: ${type}`);
}

function expect(bytes, state, byte) {
  if (bytes[state.pos] !== byte) {
    throw new PhpSerializeError(`expected byte 0x${byte.toString(16)} at ${state.pos}`);
  }
  state.pos++;
}

export function phpUnserialize(input) {
  if (typeof input !== 'string') throw new PhpSerializeError('input must be a string');
  const bytes = encoder.encode(input);
  const state = { pos: 0 };
  const value = readValue(bytes, state);
  if (state.pos !== bytes.length) {
    throw new PhpSerializeError(`trailing bytes after value at ${state.pos}/${bytes.length}`);
  }
  return value;
}
