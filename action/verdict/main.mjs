#!/usr/bin/env node
// Verdict — the edge readiness bot.
//
// Reads the log of `npx laravel-workers build --no-cache` and publishes ONE
// sticky pull-request comment plus the job summary. The comment opens with the
// READINESS verdict — never a bare "success" — then the parsed facts, then the
// full report folded away.
//
// Configuration is environment-only, so this single file works both as a
// composite action (action/verdict/action.yml) and as a plain
// `node .github/scripts/verdict.mjs` inside an app repo:
//
//   INPUT_LOG       build log path                    (default edge-build.log)
//   INPUT_COMMENT   "false" disables the PR comment   (default on)
//   GH_TOKEN        token used for the comment        (github.token)
//   PR_NUMBER       pull request number               (empty on push)
//   IS_FORK         "true" skips the comment          (read-only token)
//   GITHUB_REPOSITORY, GITHUB_SHA
//
// Exit code is always 0: this reports the build, it never replaces its verdict.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const MARKER = '<!-- verdict -->';

// The reporter carries the project's own mark, so a build comment in an APP
// repository is recognisably laravel-workers rather than an anonymous green
// check. The PNG is the rgba mark from this repo's `main`: comments render
// markdown images from any host, and the mark has no background rect, so it
// reads on the light and the dark comment theme alike. The marker must stay the
// first line — the sticky lookup matches `body.startsWith(MARKER)`.
const MARK = 'https://github.com/arfoux/laravel-workers/raw/main/docs/logo.png?raw=1';
const BRAND = `<img src="${MARK}" width="20" height="20" alt="laravel-workers" align="top"> **laravel-workers**`;

const logPath = process.env.INPUT_LOG || process.argv[2] || 'edge-build.log';
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';

// The build prints READINESS as its last block; everything after it (schema
// guidance, route notes) belongs to the verdict, so no end marker is needed.
const at = log.search(/^READINESS:/m);
const block = at >= 0 ? log.slice(at).trimEnd() : '';
const verdict = block ? (block.match(/^READINESS: (.+)$/m) || [, 'UNKNOWN'])[1] : 'BUILD FAILED';

const first = (re, s) => {
  const m = re.exec(s || '');
  return m ? m[1] : null;
};

const gapsRaw = first(/declared gaps[^\n]*\((\d+)\)/i, block);
const gaps = gapsRaw === null ? null : Number(gapsRaw);
// Route coverage is printed before the READINESS block, so it comes from the
// whole log, not the verdict slice.
const routes = first(/coverage: all (\d+) route\(s\) handled/, log);
const tables = first(/schema: \S+ \((\d+) table\(s\)\)/, block);
const commit = (process.env.GITHUB_SHA || '').slice(0, 7);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const facts = [];
if (routes !== null) facts.push(`**${routes}/${routes} routes** handled`);
if (tables !== null) facts.push(`**${plural(tables, 'table', 'tables')}** in \`dist/schema.sql\``);
if (commit) facts.push(`commit \`${commit}\``);

const lines = [MARKER, BRAND + ' · edge gate', '', `### Verdict: ${verdict}`, ''];

if (!block) {
  lines.push(
    'The edge build produced no READINESS block, so nothing was verified.',
    '',
    '<details><summary>Last lines of the build log</summary>',
    '',
    '```text',
    log.trimEnd().split('\n').slice(-40).join('\n') || '(empty log)',
    '```',
    '</details>'
  );
} else {
  if (gaps !== null && gaps > 0) {
    lines.push(`**${plural(gaps, 'declared gap', 'declared gaps')}** — the app answers it; it ships as-is.`);
  } else if (/^RUNS/.test(verdict)) {
    lines.push('No declared gaps: every route is compiled, snapshotted or ported.');
  } else {
    lines.push('Verdict printed without a gap summary — read the report below.');
  }
  if (facts.length) lines.push('', facts.join(' · '));
  lines.push('', '<details><summary>Readiness report</summary>', '', '```text', block, '```', '</details>');
}

lines.push('', `<sub>Verdict · edge gate for \`${process.env.GITHUB_REPOSITORY || 'this repo'}\`</sub>`);

const body = lines.join('\n') + '\n';
process.stdout.write(body);

// The job summary gets the same body.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}

// ---- the sticky comment ----------------------------------------------------
const wantComment = (process.env.INPUT_COMMENT ?? 'true') !== 'false';
const pr = (process.env.PR_NUMBER || '').trim();
const repo = process.env.GITHUB_REPOSITORY || '';
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
