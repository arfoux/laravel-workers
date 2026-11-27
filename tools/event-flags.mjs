// tools/event-flags.mjs — contract flags for an event/listener PHP source.
//
// The event dump needs to know whether a listener implements Laravel's
// ShouldQueue / ShouldBroadcast / Should...AfterCommit contracts. A raw
// substring test also sees a licence comment or a string as an implementation,
// and misses the alias `ShouldHandleEventsAfterCommit`. Match only names in an
// `implements` clause, after PHP comments and string literals are stripped.

const CONTRACTS = {
  queued: ['ShouldQueue'],
  broadcast: ['ShouldBroadcast'],
  afterCommit: ['ShouldDispatchAfterCommit', 'ShouldHandleEventsAfterCommit'],
};

// Blank comments, quoted strings and heredoc/nowdoc bodies with spaces.
// Newlines are kept so token boundaries (and line-start heredoc labels) stay
// where they were in the original source.
function stripPhpLiterals(src) {
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\r\n]/g, ' ');
  while (i < src.length) {
    const pair = src.slice(i, i + 2);
    if (pair === '/*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close === -1 ? src.length : close + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (pair === '//' || src[i] === '#') {
      let stop = i;
      while (stop < src.length && src[stop] !== '\n' && src[stop] !== '\r') stop++;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    const heredoc = /^<<<[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\r?\n/.exec(src.slice(i));
    if (heredoc) {
      const body = i + heredoc[0].length;
      const label = heredoc[2];
      const close = new RegExp('^[ \\t]*' + label + '\\b', 'm').exec(src.slice(body));
      const stop = close ? body + close.index + close[0].length : src.length;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      let stop = i + 1;
      while (stop < src.length) {
        if (src[stop] === '\\') { stop += 2; continue; }
        if (src[stop] === quote) { stop++; break; }
        stop++;
      }
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export function flagsOf(src) {
  const clean = stripPhpLiterals(typeof src === 'string' ? src : '');
  // A comma-separated implements list belongs to one class: cut each clause at
  // `{` or `;` so a class body (and its method calls) cannot contribute names.
  // Contract names after `implements` and after a comma are both in the clause.
  const clauses = clean.split(/\bimplements\b/).slice(1).map((part) => part.split(/[{;]/)[0]);
  const area = clauses.join(' ');
  const flags = { queued: false, broadcast: false, afterCommit: false };
  for (const [flag, names] of Object.entries(CONTRACTS)) {
    flags[flag] = names.some((name) => new RegExp('\\b' + name + '\\b').test(area));
  }
  return flags;
}
