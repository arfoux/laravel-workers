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
    const out = {};
    for (const entry of node.entries || []) out[entry.key] = jsoncValue(entry.value);
    return out;
  }
  if (node.type === 'array') return (node.items || []).map(jsoncValue);
  return node.value === undefined ? null : node.value;
}

// Blank out `#` comments so the table/array regexes below cannot read a
// commented-out line as a declaration. Quotes are tracked so a `#` INSIDE a
// string stays part of the value (`crons = ["# not a comment"]`).
export function stripTomlComments(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
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
        const crons = cfg && cfg.triggers && cfg.triggers.crons;
        if (Array.isArray(crons)) return crons.filter(Boolean).map(String);
        if (cfg && cfg.triggers && cfg.triggers.crons !== undefined) {
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
  // `[triggers]` table -> the `crons = [ ... ]` array inside it (the array may
  // span lines; TOML has no trailing-comma rule to worry about here).
  const table = /\[triggers\]([\s\S]*?)(?:\n\s*\[|$)/.exec(clean);
  if (!table) return [];
  const crons = /(?:^|\n)\s*crons\s*=\s*\[([^\]]*)\]/.exec(table[1]);
  if (!crons) {
    if (/(?:^|\n)\s*crons\s*=/.test(table[1])) {
      warn('wrangler.toml has a `[triggers]` table whose `crons` is not an array literal — the cron triggers are NOT counted');
    }
    return [];
  }
  return crons[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}
