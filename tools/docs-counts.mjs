#!/usr/bin/env node
// tools/docs-counts.mjs — the README counts, generated from the code that knows.
//
// The README is what a visitor reads first, so its numbers are the ones that
// rot fastest: "113 constructs" and "43 compile" were typed by hand and were
// already two waves stale. This script derives every count from the source of
// truth (`tools/constructs.json`, the corpus manifest, the MAP coverage index)
// and writes it into README.md between the markers — the same idea as
// `tools/construct-audit.mjs` writes the COMPILED.md table.
//
//   node tools/docs-counts.mjs            # print the block
//   node tools/docs-counts.mjs --write    # rewrite the marked block in README.md
//   node tools/docs-counts.mjs --check    # the gate: fail when README is stale
//
// The block is deliberately a fenced code block so it renders identically on
// GitHub and npm.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const START = '<!-- readme-counts:start -->';
const END = '<!-- readme-counts:end -->';

const data = JSON.parse(readFileSync(join(ROOT, 'tools', 'constructs.json'), 'utf8'));
const constructs = data.constructs || [];
const counts = {
  total: constructs.length,
  ok: constructs.filter((c) => c.expect === 'ok').length,
  fail: constructs.filter((c) => c.expect === 'fail').length,
  build: constructs.filter((c) => c.expect == null).length,
  facades: constructs.filter((c) => String(c.id).startsWith('facade_')).length,
  facadeTotal: data.meta && Number(data.meta.facade_total) || 0,
};
counts.facadePct = counts.facadeTotal ? Math.round((counts.facades / counts.facadeTotal) * 100) : 0;

const corpus = JSON.parse(readFileSync(join(ROOT, 'compiler', 'tests', 'corpus', 'cases.json'), 'utf8'));
counts.corpus = Array.isArray(corpus) ? corpus.length : Object.keys(corpus).length;

// The MAP coverage index: the same row count tools/docs-check.mjs enforces.
const map = readFileSync(join(ROOT, 'MAP.md'), 'utf8');
const idx = map.indexOf('## C. Coverage index');
if (idx === -1) { console.error('docs-counts FAIL: MAP.md has no coverage index'); process.exit(1); }
const tally = map.indexOf('**Tally', idx);
const block = (tally !== -1 ? map.slice(idx, tally) : map.slice(idx)).split('\n');
counts.docs = block.filter((l) => /^\| [a-z0-9][a-z0-9-]*\s*\|/.test(l) && !l.includes('Docs page')).length;

const blockText = [
  '```',
  `constructs   ${counts.ok} compile · ${counts.fail} fail loud · ${counts.build} documented   (${counts.total} audited)`,
  `facades      ${counts.facades}/${counts.facadeTotal} classified (${counts.facadePct}%)`,
  `blade corpus ${counts.corpus}/${counts.corpus} byte-identical vs PHP 8.3`,
  `docs         ${counts.docs}/${counts.docs} pages with a verdict`,
  '```',
].join('\n');

const README = join(ROOT, 'README.md');

if (process.argv.includes('--write')) {
  const md = readFileSync(README, 'utf8');
  const s = md.indexOf(START);
  const e = md.indexOf(END);
  if (s === -1 || e === -1) {
    console.error('docs-counts: README.md has no readme-counts markers');
    process.exit(1);
  }
  writeFileSync(README, md.slice(0, s + START.length) + '\n' + blockText + '\n' + md.slice(e));
  console.log(`README.md: the counts block is written (${counts.total} constructs, corpus ${counts.corpus})`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const md = readFileSync(README, 'utf8');
  const s = md.indexOf(START);
  const e = md.indexOf(END);
  if (s === -1 || e === -1) {
    console.error('docs-counts FAIL: README.md has no readme-counts markers');
    process.exit(1);
  }
  const current = md.slice(s + START.length, e).trim();
  if (current !== blockText.trim()) {
    console.error('docs-counts FAIL: the README counts are stale - run: node tools/docs-counts.mjs --write');
    process.exit(1);
  }
  // The block is the ONLY place a count may appear: a number typed into the
  // prose is a count no gate reaches, which is exactly how "113 constructs" and
  // "corpus 51/51" survived two waves. Refuse the claim shapes the block owns.
  const outside = md.slice(0, s) + md.slice(e);
  const HAND_TYPED = /\b(?:[0-9]{2,}\+? (?:rules|constructs|docs|views|routes|tests|cases|facades|pages|checks|scenarios|modules))\b|\b[0-9]+\/[0-9]+ (?:rules|byte-identical|docs|verdicts|guard)\b|\bcorpus [0-9]+/gi;
  const hits = [...outside.matchAll(HAND_TYPED)].map((m) => m[0]);
  if (hits.length) {
    console.error(
      `docs-counts FAIL: hand-typed count(s) outside the generated block: ${[...new Set(hits)].join(', ')}\n` +
        '  A count the repo can compute belongs in the block (or the claim needs rephrasing).'
    );
    process.exit(1);
  }
  console.log(`docs-counts PASS: README counts match the code (${counts.total} constructs, ${counts.facades}/${counts.facadeTotal} facades, corpus ${counts.corpus}, ${counts.docs} docs)`);
  process.exit(0);
}

console.log(blockText);
