// tools/readiness.mjs — the build's verdict, in one place.
//
// A failed build used to say WHAT stopped it and nothing else: the operator had
// to read the log bottom-up to answer "can my app run at the edge at all, and
// what exactly do I change?". Every check already knows its own finding; this
// module collects them into one answer and one action list.
//
// The three verdicts are the product's contract (docs/READINESS.md):
//   RUNS ON THE EDGE          every route is served; nothing declared away
//   RUNS WITH DECLARED GAPS   every route is decided; some are `ignore`d or ported
//   DOES NOT RUN              something the edge cannot serve, undeclared
//
// Exit codes stay 0/1: the verdict is text, not a new signal.

export const VERDICT = {
  RUNS: 'RUNS ON THE EDGE',
  GAPS: 'RUNS WITH DECLARED GAPS',
  NO: 'DOES NOT RUN',
};

// severity:
//   'block'    the build cannot produce a correct worker
//   'declared' the operator decided this away (an `ignore` entry, a port); it ships
//   'advisory' worth knowing, does not change the verdict (the source sweep)
export const BLOCK = 'block';
export const DECLARED = 'declared';
export const ADVISORY = 'advisory';

// The deployment tiers, cheapest first. Every fix that has more than one honest
// answer lists them in THIS order: the free path is the one the project is built
// around (COMPILED.md §"Free-plan budget"), and a fix the operator cannot afford
// is not a fix. R2 sits between the two because it is free to use but asks for a
// payment method; Workers Paid is the last resort, never the first suggestion.
// The label is printed verbatim in front of the option, so it must carry the
// COST GATE, not just the name: an option the operator cannot take is not an
// option, and finding that out after reading three paragraphs is worse than
// being told on the first line.
export const TIER = {
  FREE: { id: 'free', label: 'free plan - works today, no payment method' },
  R2: { id: 'r2', label: 'free plan + R2 - works, but R2 requires a credit card on the account' },
  PAID: { id: 'paid', label: 'Workers Paid - works, but requires upgrading the account to the paid plan' },
};
const TIER_ORDER = { free: 0, r2: 1, paid: 2 };
const TIER_BY_ID = { free: 'FREE', r2: 'R2', paid: 'PAID' };
const TierFor = (id) => TIER_BY_ID[id] || 'FREE';

export function verdictOf(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.some((f) => f && f.severity === BLOCK)) return VERDICT.NO;
  if (list.some((f) => f && f.severity === DECLARED)) return VERDICT.GAPS;
  return VERDICT.RUNS;
}

const AREA_ORDER = ['config', 'binding', 'middleware', 'queue', 'class', 'route', 'registry', 'sweep'];
const AREA_LABEL = {
  config: 'runtime config',
  binding: 'bindings',
  middleware: 'middleware',
  queue: 'queued work',
  class: 'classes',
  route: 'routes',
  registry: 'registry.json',
  sweep: 'app source',
};

function byArea(findings) {
  const out = new Map();
  for (const f of findings) {
    const area = AREA_LABEL[f.area] ? f.area : 'route';
    if (!out.has(area)) out.set(area, []);
    out.get(area).push(f);
  }
  return [...out.entries()].sort((a, b) => AREA_ORDER.indexOf(a[0]) - AREA_ORDER.indexOf(b[0]));
}

function block(lines, title, findings) {
  if (!findings.length) return;
  lines.push(`  ${title} (${findings.length}):`);
  for (const f of findings) {
    lines.push(`    ${f.route ? f.route + '  ' : ''}${f.cause}`);
    if (f.fix) lines.push(`      -> ${f.fix}`);
    // A finding with several honest answers lists them cheapest-first, so the
    // free path is read before the paid one.
    for (const p of (f.paths || []).slice().sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])) {
      lines.push(`      ${TIER[TierFor(p.tier)].label}:`);
      lines.push(`        ${p.what}`);
    }
  }
}

// The block printed after the last build line (success) or after BUILD FAILED.
// Deliberately plain: no colour, no box drawing - it lands in CI logs, and a
// log is read by a human and grepped by a machine.
export function renderReadiness(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const verdict = verdictOf(list);
  const lines = ['', `READINESS: ${verdict}`];

  const blocking = list.filter((f) => f.severity === BLOCK);
  const declared = list.filter((f) => f.severity === DECLARED);
  const advisory = list.filter((f) => f.severity === ADVISORY);

  if (!list.length) {
    lines.push('  every route is served by a compiled handler, a snapshot or a port;');
    lines.push('  no route is ignored, and no binding is missing.');
    return lines.join('\n');
  }

  if (blocking.length) block(lines, 'the edge cannot serve this', blocking);
  if (declared.length) {
    block(lines, 'declared gaps — your decision, and they ship', declared);
    if (declared.some((f) => f.route)) {
      lines.push('    what an ignored route does at the edge: the request reaches no handler and the');
      lines.push('    platform answers 404. Laravel itself still serves it everywhere else.');
    }
  }
  if (advisory.length) block(lines, 'worth knowing', advisory);

  if (verdict === VERDICT.NO && opts.dist) {
    lines.push(`  nothing was written; ${opts.dist} still holds the last build that COMPLETED.`);
  }
  return lines.join('\n');
}

// --- the app-source sweep -------------------------------------------------
// The build compiles controllers, models, requests, policies and views. A
// construct PHP has and the sandbox does not (a process, eval, GD) fails at
// REQUEST time if it sits on a path the compiler never reached - so the sweep
// names it early. It is ADVISORY: the compiler is the authority on what
// compiles, and a false positive here must never fail a green build.
//
// Comments and string literals are stripped first: `// exec(` is not a call.
const UNSERVEABLE = [
  {
    re: /\b(exec|shell_exec|system|passthru|proc_open|popen)\s*\(/g,
    what: 'process spawning',
    fix: 'the edge has no OS process - call an HTTP service from a port, or move the work to a cron-triggered job',
    paths: [
      { tier: 'free', what: 'a port that calls an HTTP service, driven by a cron trigger (5 triggers/account on free)' },
      { tier: 'paid', what: 'Cloudflare Containers, only if the work genuinely needs a real process' },
    ],
  },
  {
    re: /\bpcntl_\w+\s*\(/g,
    what: 'pcntl (signals / process control)',
    fix: 'no OS process control at the edge - remove the call, or move the route behind a port',
  },
  {
    re: /\beval\s*\(/g,
    what: 'eval()',
    fix: 'code that does not exist at build time cannot be compiled - generate it at build time instead',
  },
  {
    re: /\b(imagecreate\w*|imagepng|imagejpeg|imagewebp|imagettftext)\s*\(/g,
    what: 'GD image functions',
    fix: 'no GD at the edge - resize at build time, or use Cloudflare Images from a port',
    paths: [
      { tier: 'free', what: 'generate the derivative image at BUILD time and ship it as a static asset' },
      { tier: 'paid', what: 'Cloudflare Images from a port, if the size is only known at request time' },
    ],
  },
  {
    re: /\bnew\s+\\?Imagick\b/g,
    what: 'Imagick',
    fix: 'no Imagick at the edge - see the `images` row in docs/READINESS.md',
    paths: [{ tier: 'free', what: 'generate the derivative at BUILD time; ship it as a static asset' }],
  },
  {
    re: /\bcurl_(init|exec)\s*\(/g,
    what: 'the curl extension',
    fix: 'use the Http facade (it compiles to fetch), not raw curl',
  },
];

export function stripPhpCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const s = String(source);
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && n !== '[') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += ' '; // a literal is not code: keep the offsets, drop the text
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// files: [{ file, source }] with `file` relative to the app root.
export function sweepAppSources(files) {
  const findings = [];
  for (const { file, source } of files || []) {
    const code = stripPhpCommentsAndStrings(source);
    for (const { re, what, fix, paths } of UNSERVEABLE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const line = code.slice(0, m.index).split('\n').length;
        findings.push({
          route: null,
          area: 'sweep',
          severity: ADVISORY,
          cause: `${what} at ${file}:${line} (${(m[1] || m[0]).trim()})`,
          fix,
          paths,
        });
      }
    }
  }
  return findings;
}

export default {
  VERDICT,
  BLOCK,
  DECLARED,
  ADVISORY,
  TIER,
  verdictOf,
  renderReadiness,
  sweepAppSources,
  stripPhpCommentsAndStrings,
};
