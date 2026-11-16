#!/usr/bin/env node
// Verdict — the edge readiness bot.
//
// Reads the log of `npx laravel-workers build --no-cache` and publishes ONE
// sticky pull-request comment plus the job summary. The comment opens with the
// READINESS verdict — never a bare "success" — then the parsed facts only.
// Raw build-log text (attacker-controlled) is never published.
//
// Configuration is environment-only, so this single file works both as a
// composite action (action/verdict/action.yml) and as a plain
// `node .github/scripts/verdict.mjs` inside an app repo:
//
//   INPUT_LOG       must be "edge-build.log" in the workspace (default)
//   INPUT_COMMENT   "false" disables the PR comment   (default on)
//   GH_TOKEN        token used for the comment        (github.token)
//   PR_NUMBER       pull request number               (empty on push)
//   IS_FORK         "true" skips the comment          (read-only token)
//   GITHUB_REPOSITORY, GITHUB_SHA
//
// Exit code is always 0: this reports the build, it never replaces its verdict.

import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKER = '<!-- verdict -->';

// The reporter carries the project's own mark, so a build comment in an APP
// repository is recognisably laravel-workers rather than an anonymous green
// check. The marker must stay the first line: the sticky lookup matches
// `body.startsWith(MARKER)`.
const MARK = 'https://github.com/arfoux/laravel-workers/raw/main/docs/logo.png?raw=1';
const BRAND = `<img src="${MARK}" width="20" height="20" alt="laravel-workers" align="top"> **laravel-workers**`;

const LOG_NAME = 'edge-build.log';

// INPUT_LOG/argv used to be an arbitrary path: a workflow (or a crafted PR
// workflow file) could point it at any file the runner could read and have the
// contents posted into the PR. Only the conventional log basename INSIDE the
// workspace is accepted; the requested value is never used as a path.
const requested = String(process.env.INPUT_LOG || process.argv[2] || LOG_NAME).trim();
if (requested !== LOG_NAME && requested !== './' + LOG_NAME) {
  process.stderr.write(
    `verdict: INPUT_LOG must be "${LOG_NAME}" in the workspace; ignoring the supplied path\n`
  );
}
const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const logPath = join(workspace, LOG_NAME);
let log = '';
try {
  const st = lstatSync(logPath);
  // A checked-in symlink must not turn the allow-listed name into a read of
  // an arbitrary file, and an unbounded log must not exhaust the runner.
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
  if (st.size > 1024 * 1024) throw new Error('log exceeds 1 MiB');
  log = readFileSync(logPath, 'utf8');
} catch (err) {
  process.stderr.write(
    `verdict: cannot read ${LOG_NAME} (${err && err.message ? err.message : err}); reporting no READINESS block\n`
  );
}

// The build prints READINESS as its last block; everything after it (schema
// guidance, route notes) belongs to the verdict, so no end marker is needed.
const at = log.search(/^READINESS:/m);
const block = at >= 0 ? log.slice(at).trimEnd() : '';
const VALID_VERDICTS = new Set(['RUNS ON THE EDGE', 'RUNS WITH DECLARED GAPS', 'DOES NOT RUN']);
const parsedVerdict = block ? (block.match(/^READINESS: (.+)$/m) || [, 'UNKNOWN'])[1] : 'BUILD FAILED';
// The verdict text itself is log data: only the three contract values are
// publishable, never an attacker-chosen markdown payload.
const verdict = VALID_VERDICTS.has(parsedVerdict) ? parsedVerdict : (block ? 'UNKNOWN' : 'BUILD FAILED');

const first = (re, s) => {
  const m = re.exec(s || '');
  return m ? m[1] : null;
};

const gapsRaw = first(/declared gaps[^\n]*\((\d+)\)/i, block);
const gaps = gapsRaw === null ? null : Number(gapsRaw);
// Route coverage is printed before the READINESS block, so it comes from the
// whole log, not the verdict slice. Every published value below is a parsed
// number or one of the whitelisted verdict strings — raw log text is NEVER
// copied into a comment or a job summary (it is attacker-controlled build
// output and can contain markdown, links, or leaked secrets).
const routes = first(/coverage: all (\d+) route\(s\) handled/, log);
const tables = first(/schema: \S+ \((\d+) table\(s\)\)/, block);
const sha = process.env.GITHUB_SHA || '';
const commit = /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const facts = [];
if (routes !== null) facts.push(`**${routes}/${routes} routes** handled`);
if (tables !== null) facts.push(`**${plural(tables, 'table', 'tables')}** in \`dist/schema.sql\``);
if (commit) facts.push(`commit \`${commit}\``);

const lines = [MARKER, BRAND + ' · edge gate', '', `### Verdict: ${verdict}`, ''];

if (!block) {
  lines.push('The edge build produced no READINESS block, so nothing was verified.');
} else {
  if (gaps !== null && gaps > 0) {
    lines.push(`**${plural(gaps, 'declared gap', 'declared gaps')}** — the app answers it; it ships as-is.`);
  } else if (/^RUNS/.test(verdict)) {
    lines.push('No declared gaps: every route is compiled, snapshotted or ported.');
  } else {
    lines.push('Verdict printed without a gap summary. See the build log in the CI run.');
  }
}
if (facts.length) lines.push('', facts.join(' · '));
const repoEnv = process.env.GITHUB_REPOSITORY || '';
const repoLabel = /^[\w.-]+\/[\w.-]+$/.test(repoEnv) ? repoEnv : 'this repo';
lines.push('', `<sub>Verdict · edge gate for \`${repoLabel}\`</sub>`);

const body = lines.join('\n') + '\n';
process.stdout.write(body);

// The job summary gets the same body.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}

// ---- the sticky comment ----------------------------------------------------
const wantComment = (process.env.INPUT_COMMENT ?? 'true') !== 'false';
const prRaw = (process.env.PR_NUMBER || '').trim();
const pr = /^\d+$/.test(prRaw) ? prRaw : '';
const repoRaw = process.env.GITHUB_REPOSITORY || '';
const repo = /^[\w.-]+\/[\w.-]+$/.test(repoRaw) ? repoRaw : '';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const fork = (process.env.IS_FORK || '') === 'true';

async function comment() {
  if (!wantComment) return 'comment disabled';
  if (!pr) return 'not a pull request';
  if (fork) return 'fork: read-only token, comment skipped';
  if (!repo || !token) return 'no repo/token, comment skipped';

  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'laravel-workers-verdict',
  };

  let id = null;
  for (let page = 1; page <= 5 && id === null; page += 1) {
    const res = await fetch(`${api}/issues/${pr}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`list comments: ${res.status} ${await res.text()}`);
    const items = await res.json();
    const hit = items.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (hit) id = hit.id;
    if (items.length < 100) break;
  }

  const res = id
    ? await fetch(`${api}/issues/comments/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
    : await fetch(`${api}/issues/${pr}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });

  if (!res.ok) throw new Error(`write comment: ${res.status} ${await res.text()}`);
  return id ? 'comment updated' : 'comment created';
}

comment()
  .then((result) => console.log(`verdict: ${result}`))
  .catch((err) => console.warn(`verdict: comment failed (build result unchanged): ${err.message}`));
