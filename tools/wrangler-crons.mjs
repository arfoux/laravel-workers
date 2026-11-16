// tools/wrangler-crons.mjs — the cron triggers an operator declared directly in
// `wrangler.jsonc`/`wrangler.toml` (`triggers.crons`).
//
// WHY THIS IS ITS OWN MODULE. The build answers one safety question with it: "a
// route pushes a queued job — does ANYTHING drain `lw_jobs` at the edge?" A
// deployed Worker drains the table from whichever trigger fires, so a push is
// only a silent no-op when NEITHER the app's own schedule NOR the operator's
// wrangler config declares a trigger. Getting that answer wrong is a BLOCK
// verdict with the wrong cause, so both readers below are pinned by
// tools/tests/wrangler-crons.test.mjs.
//
// Two ways the answer used to be wrong, both silent:
//   - TOML was scanned with a regex, so a `# crons = ["*/5 * * * *"]` line in a
//     COMMENT counted as a real trigger and skipped the queue check.
//   - A config file that failed to parse answered `[]` without a word, so the
//     queue BLOCK blamed a missing cron trigger when the file was malformed.
// `warn` is how the caller hears about the second one; every caller passes one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

// The jsonc AST turned back into plain data (the shape `tools/jsonc.mjs` parses
// into is source-aware, not JSON-shaped). Shared with `build.mjs`, which reads
// the same file for its D1/R2 binding check.
export function jsoncValue(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'object') {
    // A key spelled `__proto__` is DATA, not an instruction: assigning it on a
    // normal `{}` changes that object's prototype, so a wrangler.jsonc entry
    // `{"__proto__": {"triggers": {"crons": ["* * * * *"]}}}` would fabricate
    // `cfg.triggers.crons` and suppress the build's queue BLOCK. A null
    // prototype makes every key an ordinary own property.
    const out = Object.create(null);
    for (const entry of node.entries || []) out[entry.key] = jsoncValue(entry.value);
    return out;
  }
  if (node.type === 'array') return (node.items || []).map(jsoncValue);
  return node.value === undefined ? null : node.value;
}

// Blank out `#` comments so the table/array regexes below cannot read a
// commented-out line as a declaration. Quotes are tracked so a `#` INSIDE a
// string stays part of the value (`crons = ["# not a comment"]`), and a
// backslash-escaped quote does not end the string (`"a\"#b"`).
export function stripTomlComments(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      let escaped = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (quote === '"' && escaped) {
            out += ch;
            escaped = false; // the escaped character is data, not a delimiter
            continue;
          }
          if (ch === '\\' && quote === '"') escaped = true;
          else if (ch === quote) quote = null;
          out += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === '#') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

// Same length as the input, but every character INSIDE a quoted string is a
// space (the quotes themselves stay). Structural regexes run on this masked
// text so a `[triggers]` table name or `crons = [...]` written inside a string
// cannot be mistaken for a declaration; the offsets still index the original.
export function maskTomlStrings(text) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(text)) {
    if (quote) {
      if (quote === '"' && escaped) {
        out += ' ';
        escaped = false;
      } else if (ch === '\\' && quote === '"') {
        out += ' ';
        escaped = true;
      } else if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * The `triggers.crons` entries an operator declared in the app's wrangler
 * config: `wrangler.jsonc` first (it is what `deploy` edits), then
 * `wrangler.toml`. Returns a `string[]` — empty when neither file declares one.
 *
 * A file that cannot be read, parsed, or understood calls `warn(message)`:
 * answering `[]` quietly would make the caller's verdict ("no build-time cron
 * trigger") name a cause that is not the real one.
 */
export function wranglerCronTriggers(appRoot, warn = () => {}) {
  const jsoncPath = join(appRoot, 'wrangler.jsonc');
  if (existsSync(jsoncPath)) {
    let text = null;
    try {
      text = readFileSync(jsoncPath, 'utf8');
    } catch (err) {
      warn(`wrangler.jsonc is unreadable (${err && err.message ? err.message : err}) — cron triggers declared in it are NOT counted`);
    }
    if (text != null) {
      try {
        const cfg = jsoncValue(parseJsonc(text));
        // Own properties only: even a null-prototype object can be shadowed by
        // an inherited key if a caller ever passes a plain object here.
        const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
        const triggers = hasOwn(cfg, 'triggers') ? cfg.triggers : null;
        const crons = hasOwn(triggers, 'crons') ? triggers.crons : undefined;
        if (Array.isArray(crons)) return crons.filter(Boolean).map(String);
        if (crons !== undefined) {
          warn('wrangler.jsonc declares `triggers.crons` but it is not an array — the cron triggers are NOT counted');
        }
      } catch (err) {
        warn(
          `wrangler.jsonc does not parse (${err && err.message ? err.message : err}) — cron triggers declared in it are ` +
            'NOT counted; fix the file (a syntax error here also fails `wrangler deploy`)'
        );
      }
    }
  }

  const tomlPath = join(appRoot, 'wrangler.toml');
  if (!existsSync(tomlPath)) return [];
  let text = null;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch (err) {
    warn(`wrangler.toml is unreadable (${err && err.message ? err.message : err}) — cron triggers declared in it are NOT counted`);
    return [];
  }
  const clean = stripTomlComments(text);
  const structural = maskTomlStrings(clean);
  // `[triggers]` table -> the `crons = [ ... ]` array inside it (the array may
  // span lines; TOML has no trailing-comma rule to worry about here). Both
  // regexes read the MASKED text, so a table/array spelled inside a string is
  // not mistaken for a declaration; offsets still slice the original values.
  const table = /\[triggers\]([\s\S]*?)(?:\n\s*\[|$)/.exec(structural);
  if (!table) return [];
  const bodyStart = table.index + '[triggers]'.length;
  const tableBody = clean.slice(bodyStart, bodyStart + table[1].length);
  const tableMask = structural.slice(bodyStart, bodyStart + table[1].length);
  const crons = /(?:^|\n)\s*crons\s*=\s*\[([^\]]*)\]/.exec(tableMask);
  if (!crons) {
    if (/(?:^|\n)\s*crons\s*=/.test(tableMask)) {
      warn('wrangler.toml has a `[triggers]` table whose `crons` is not an array literal — the cron triggers are NOT counted');
    }
    return [];
  }
  const arrStart = crons.index + crons[0].indexOf('[') + 1;
  const arrBody = tableBody.slice(arrStart, arrStart + crons[1].length);
  const arrMask = tableMask.slice(arrStart, arrStart + crons[1].length);
  // Split on masked commas so a comma INSIDE a quoted expression stays in it.
  const parts = [];
  let from = 0;
  for (let i = 0; i < arrMask.length; i += 1) {
    if (arrMask[i] === ',') {
      parts.push(arrBody.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(arrBody.slice(from));
  return parts
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}
