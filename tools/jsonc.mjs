#!/usr/bin/env node
// tools/jsonc.mjs — a small, dependency-free JSONC reader/editor.
//
// `wrangler.jsonc` is JSON with comments and trailing commas. A regex edit can
// hit the wrong entry in a multi-database config (or destroy a comment), so
// deploy uses this module to (a) validate the whole file and (b) replace only
// the source span of the value it means to change. Formatting and comments are
// preserved; the result is parsed again before it is written.
//
// Supported: // line comments, /* block comments */, trailing commas, the
// standard JSON value types. Not supported: single-quoted strings, unquoted
// keys, NaN/Infinity — wrangler.jsonc does not use them.

export class JsoncError extends Error {
  constructor(message, source = '', index = 0) {
    const { line, column } = locationOf(String(source), index);
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'JsoncError';
    this.index = index;
    this.line = line;
    this.column = column;
  }
}

function locationOf(source, index) {
  const stop = Math.max(0, Math.min(index, source.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < stop; i++) {
    if (source[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// A config file this deep is not a real wrangler.jsonc; refusing it keeps a
// pathological document from exhausting the call stack in parseValue().
const MAX_DEPTH = 512;

/**
 * Parse JSONC and return a source-aware AST.
 *
 * Node shapes:
 *   { type: 'object', start, end, entries: [{ key, keyStart, keyEnd, value }] }
 *   { type: 'array',  start, end, items: [node] }
 *   { type: 'string'|'number'|'boolean'|'null', start, end, value }
 *
 * The root object is returned (not a wrapper), so callers can inspect spans.
 */
export function parseJsonc(text) {
  const source = String(text ?? '');
  let i = 0;
  let depth = 0;
  const n = source.length;

  if (source.charCodeAt(0) === 0xfeff) i = 1; // tolerate a UTF-8 BOM

  const fail = (message, at = i) => {
    throw new JsoncError(message, source, at);
  };

  function skipTrivia() {
    while (i < n) {
      const c = source[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++;
        continue;
      }
      if (c === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        const start = i;
        i += 2;
        const end = source.indexOf('*/', i);
        if (end < 0) fail('unterminated block comment', start);
        i = end + 2;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const start = i;
    if (source[i] !== '"') fail('expected a string', i);
    i++;
    while (i < n) {
      const c = source[i];
      if (c === '"') {
        i++;
        const raw = source.slice(start, i);
        let value;
        try {
          value = JSON.parse(raw);
        } catch (e) {
          fail(`invalid string literal (${e.message})`, start);
        }
        return { type: 'string', start, end: i, value };
      }
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n' || c === '\r') fail('unterminated string literal', start);
      i++;
    }
    return fail('unterminated string literal', start);
  }

  function parseLiteral(word, type, value) {
    const start = i;
    if (!source.startsWith(word, i)) fail(`expected ${type}`, start);
    i += word.length;
    return { type, start, end: i, value };
  }

  function parseNumber() {
    const start = i;
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(source);
    if (!match) fail('expected a number', start);
    i += match[0].length;
    return { type: 'number', start, end: i, value: Number(match[0]) };
  }

  function parseValue() {
    skipTrivia();
    const c = source[i];
    if (c === '{' || c === '[') {
      if (depth >= MAX_DEPTH) fail('nesting is too deep', i);
      depth++;
      try {
        return c === '{' ? parseObject() : parseArray();
      } finally {
        depth--;
      }
    }
    if (c === '"') return parseString();
    if (c === 't') return parseLiteral('true', 'boolean', true);
    if (c === 'f') return parseLiteral('false', 'boolean', false);
    if (c === 'n') return parseLiteral('null', 'null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    return fail(c === undefined ? 'unexpected end of file' : `unexpected character ${JSON.stringify(c)}`, i);
  }

  function parseObject() {
    const start = i;
    i++; // {
    const entries = [];
    skipTrivia();
    if (source[i] === '}') {
      i++;
      return { type: 'object', start, end: i, entries };
    }
    for (;;) {
      skipTrivia();
      if (source[i] !== '"') fail('expected a quoted property name', i);
      const keyNode = parseString();
      skipTrivia();
      if (source[i] !== ':') fail('expected ":" after a property name', i);
      i++;
      const value = parseValue();
      entries.push({
        key: keyNode.value,
        keyStart: keyNode.start,
        keyEnd: keyNode.end,
        value,
      });
      skipTrivia();
      if (source[i] === ',') {
        i++;
        skipTrivia();
        if (source[i] === '}') {
          i++;
          break;
        }
        continue;
      }
      if (source[i] === '}') {
        i++;
        break;
      }
      fail('expected "," or "}" in an object', i);
    }
    return { type: 'object', start, end: i, entries };
  }

  function parseArray() {
    const start = i;
    i++; // [
    const items = [];
    skipTrivia();
    if (source[i] === ']') {
      i++;
      return { type: 'array', start, end: i, items };
    }
    for (;;) {
      items.push(parseValue());
      skipTrivia();
      if (source[i] === ',') {
        i++;
        skipTrivia();
        if (source[i] === ']') {
          i++;
          break;
        }
        continue;
      }
      if (source[i] === ']') {
        i++;
        break;
      }
      fail('expected "," or "]" in an array', i);
    }
    return { type: 'array', start, end: i, items };
  }

  const root = parseValue();
  skipTrivia();
  if (i !== n) fail('unexpected trailing content', i);
  return root;
}

function properties(node, key) {
  if (!node || node.type !== 'object') return [];
  return node.entries.filter((entry) => entry.key === key);
}

function oneProperty(node, key) {
  const list = properties(node, key);
  return { entry: list[0] || null, value: list[0]?.value || null, count: list.length };
}

function stringValue(node) {
  return node && node.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

function walkValues(node, visit) {
  if (!node) return;
  if (node.type === 'object') {
    for (const entry of node.entries) walkValues(entry.value, visit);
  } else if (node.type === 'array') {
    for (const item of node.items) walkValues(item, visit);
  } else {
    visit(node);
  }
}

function countPlaceholders(node) {
  let count = 0;
  walkValues(node, (value) => {
    if (value.type === 'string' && value.value === 'REPLACE_WITH_D1_ID') count++;
  });
  return count;
}

function applyEdits(text, edits) {
  let next = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  }
  return next;
}

/**
 * Inspect the top-level `name` field without changing anything.
 * status: ok | missing | duplicate | invalid | not-object
 */
export function inspectWranglerName(text) {
  const root = parseJsonc(text);
  if (root.type !== 'object') return { status: 'not-object', root };
  const list = properties(root, 'name');
  if (list.length === 0) return { status: 'missing', root };
  if (list.length > 1) return { status: 'duplicate', root };
  const value = stringValue(list[0].value);
  if (value === null) return { status: 'invalid', root };
  return { status: 'ok', name: value, node: list[0].value, root };
}

/**
 * Inspect the top-level `account_id` field without changing anything.
 * status: ok | missing | duplicate | invalid | not-object
 */
export function inspectWranglerAccount(text) {
  const root = parseJsonc(text);
  if (root.type !== 'object') return { status: 'not-object', root };
  const list = properties(root, 'account_id');
  if (list.length === 0) return { status: 'missing', root };
  if (list.length > 1) return { status: 'duplicate', root };
  const value = stringValue(list[0].value);
  if (value === null) return { status: 'invalid', root };
  return { status: 'ok', id: value, node: list[0].value, root };
}

/**
 * Replace the top-level `name` value. Returns
 * { text, status, changed } with status: set | already | missing | duplicate |
 * invalid | not-object | invalid-result.
 */
export function setWranglerName(text, workerName) {
  const info = inspectWranglerName(text);
  if (info.status !== 'ok') return { text, status: info.status, changed: false };
  if (info.name === workerName) return { text, status: 'already', changed: false };

  const next = applyEdits(text, [{
    start: info.node.start,
    end: info.node.end,
    replacement: JSON.stringify(workerName),
  }]);
  const check = inspectWranglerName(next);
  if (check.status !== 'ok' || check.name !== workerName) {
    return { text, status: 'invalid-result', changed: false };
  }
  return { text: next, status: 'set', changed: true };
}

/**
 * Locate the D1 entry a deploy would edit.
 *
 * A placeholder entry (database_id === "REPLACE_WITH_D1_ID") wins; otherwise
 * the unique entry whose database_name equals databaseRef. Duplicate names,
 * duplicate keys, and placeholders outside the selected database_id are
 * refused rather than guessed.
 *
 * status: placeholder | ok | no-d1 | invalid-d1 | no-entry | missing-id |
 *         missing-name | ambiguous | placeholder-outside | invalid-root
 */
export function inspectD1Target(text, databaseRef) {
  const root = parseJsonc(text);
  if (root.type !== 'object') return { status: 'invalid-root', root };

  const d1 = properties(root, 'd1_databases');
  if (d1.length === 0) return { status: 'no-d1', root };
  if (d1.length > 1) return { status: 'ambiguous', root };
  if (d1[0].value.type !== 'array') return { status: 'invalid-d1', root };
  const entries = d1[0].value.items;
  if (entries.some((entry) => entry.type !== 'object')) return { status: 'invalid-d1', root };

  const allPlaceholders = countPlaceholders(root);
  const placeholderEntries = [];
  let insidePlaceholders = 0;
  for (const entry of entries) {
    let count = 0;
    walkValues(entry, (value) => {
      if (value.type === 'string' && value.value === 'REPLACE_WITH_D1_ID') count++;
    });
    if (count > 0) placeholderEntries.push({ entry, count });
    insidePlaceholders += count;
  }

  if (allPlaceholders > insidePlaceholders) return { status: 'placeholder-outside', root };
  if (placeholderEntries.length > 1 || placeholderEntries.some((item) => item.count > 1)) {
    return { status: 'ambiguous', root };
  }

  if (placeholderEntries.length === 1) {
    const entry = placeholderEntries[0].entry;
    const name = oneProperty(entry, 'database_name');
    if (name.count > 1) return { status: 'ambiguous', root };
    if (name.count !== 1 || !stringValue(name.value) || stringValue(name.value) === '') {
      return { status: 'missing-name', root };
    }
    const id = oneProperty(entry, 'database_id');
    if (id.count > 1) return { status: 'ambiguous', root };
    if (id.count !== 1 || stringValue(id.value) !== 'REPLACE_WITH_D1_ID') {
      return { status: 'placeholder-outside', root };
    }
    return {
      status: 'placeholder',
      root,
      entry,
      nameNode: name.value,
      idNode: id.value,
      name: stringValue(name.value),
    };
  }

  const matches = [];
  for (const entry of entries) {
    const name = oneProperty(entry, 'database_name');
    if (name.count > 1) return { status: 'ambiguous', root };
    if (name.count === 1 && stringValue(name.value) === databaseRef) {
      matches.push({ entry, name });
    }
  }
  if (matches.length > 1) return { status: 'ambiguous', root };
  if (matches.length === 0) return { status: 'no-entry', root };

  const { entry, name } = matches[0];
  const id = oneProperty(entry, 'database_id');
  if (id.count > 1) return { status: 'ambiguous', root };
  if (id.count !== 1 || stringValue(id.value) === null) {
    return { status: 'missing-id', root };
  }
  return {
    status: 'ok',
    root,
    entry,
    nameNode: name.value,
    idNode: id.value,
    name: stringValue(name.value),
    id: stringValue(id.value),
  };
}

/**
 * Update the D1 id (and the placeholder's database_name when needed).
 * Returns { text, status, changed } with the same statuses as inspectD1Target
 * plus set | updated | already | invalid-result. Malformed JSONC throws.
 */
export function updateWranglerD1Id(text, databaseRef, databaseId) {
  const info = inspectD1Target(text, databaseRef);

  if (info.status === 'placeholder') {
    const edits = [{
      start: info.idNode.start,
      end: info.idNode.end,
      replacement: JSON.stringify(databaseId),
    }];
    if (info.name !== databaseRef) {
      edits.push({
        start: info.nameNode.start,
        end: info.nameNode.end,
        replacement: JSON.stringify(databaseRef),
      });
    }
    const next = applyEdits(text, edits);
    const check = inspectD1Target(next, databaseRef);
    if (check.status !== 'ok' || check.id !== databaseId || check.name !== databaseRef) {
      return { text, status: 'invalid-result', changed: false };
    }
    return { text: next, status: 'set', changed: true };
  }

  if (info.status !== 'ok') return { text, status: info.status, changed: false };
  if (info.id === databaseId) return { text, status: 'already', changed: false };

  const next = applyEdits(text, [{
    start: info.idNode.start,
    end: info.idNode.end,
    replacement: JSON.stringify(databaseId),
  }]);
  const check = inspectD1Target(next, databaseRef);
  if (check.status !== 'ok' || check.id !== databaseId) {
    return { text, status: 'invalid-result', changed: false };
  }
  return { text: next, status: 'updated', changed: true };
}
