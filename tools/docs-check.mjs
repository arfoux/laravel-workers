#!/usr/bin/env node
// tools/docs-check.mjs — Coverage gate (C-block) + format + code⇄MAP checks
// Offline-safe. --strict turns warnings into failures.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAP = join(ROOT, 'MAP.md');
const COMPILED = join(ROOT, 'COMPILED.md');
const STRICT = process.argv.includes('--strict');
const GLYPHS = ['\u2705', '\u{1F7E1}', '\u{1F534}', '\u26D4'];
const VALID = new Set(GLYPHS);

function fail(msg) { console.error('docs-check FAIL: ' + msg); process.exit(1); }
function warn(msg) { console.warn('docs-check WARN: ' + msg); if (STRICT) { console.error('docs-check FAIL (--strict): ' + msg); process.exit(1); } }
function ok(msg) { console.log('docs-check PASS: ' + msg); }

let text;
try { text = readFileSync(MAP, 'utf8'); } catch (e) { fail('cannot read MAP.md: ' + e.message); }
const compiledText = (() => { try { return readFileSync(COMPILED, 'utf8'); } catch { return ''; } })();

// --- C-block (Coverage index) ---
const idx = text.indexOf('## C. Coverage index');
if (idx === -1) fail('Coverage index section not found');
const tallyIdx = text.indexOf('**Tally', idx);
const block = tallyIdx !== -1 ? text.slice(idx, tallyIdx) : text.slice(idx);
const lines = block.split('\n');
const rows = lines.filter(l => /^\| [a-z0-9][a-z0-9-]*\s*\|/.test(l) && !l.includes('Docs page'));

const EXPECTED = 105;
if (rows.length !== EXPECTED) fail(`coverage rows ${rows.length} != ${EXPECTED}`);

const seen = new Set();
for (const r of rows) {
  const parts = r.split('|').map(s => s.trim());
  // parts: ['', page, klass, note, '']
  if (parts.length !== 5) fail(`bad column count (${parts.length}) in row: ${r}`);
  const page = parts[1];
  const klass = parts[2];
  const note = parts[3];
  if (!page) fail('blank Docs page in row: ' + r);
  if (seen.has(page)) fail('duplicate page ' + page);
  seen.add(page);
  if (!note) fail('blank Note for ' + page);
  const glyphsInKlass = GLYPHS.filter(g => klass.includes(g));
  if (glyphsInKlass.length !== 1) fail(`Class must contain exactly one verdict glyph (got ${glyphsInKlass.length}) for ${page}: "${klass}"`);
  if (GLYPHS.some(g => note.includes(g))) fail(`Note must not contain verdict glyphs for ${page}`);
}

// --- Section F (Platform services) soft check ---
const fStart = text.indexOf('### F. Platform services');
const fEnd = text.indexOf('### G.', fStart);
if (fStart !== -1) {
  const fBlock = (fEnd !== -1 ? text.slice(fStart, fEnd) : text.slice(fStart)).split('\n');
  const fRows = fBlock.filter(l => /^\| [A-Za-z]/.test(l) && !l.includes('---') && !l.includes('Laravel |'));
  for (const r of fRows) {
    const parts = r.split('|').map(s => s.trim());
    if (parts.length < 6) { warn(`Section F row has ${parts.length} columns (expected 6): ${r.slice(0, 80)}`); continue; }
    const cls = parts[3];
    const hasVerdict = GLYPHS.some(g => cls.includes(g)) || cls.includes('\u2705/\u{1F7E1}');
    if (!hasVerdict) warn(`Section F row missing verdict in Class col: ${parts[1]}`);
  }
}

// --- code⇄MAP: modules ---
const kernelDir = join(ROOT, 'kernel');
const modules = readdirSync(kernelDir)
  .filter(f => extname(f) === '.mjs' && !f.endsWith('.test.mjs'))
  .map(f => basename(f, '.mjs'));
const missingModules = modules.filter(m => !text.includes(m) && !compiledText.includes(m));
if (missingModules.length) warn(`kernel modules not mentioned in MAP/COMPILED: ${missingModules.join(', ')}`);

// --- code⇄MAP: fail-loud codes ---
const codeFiles = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
    else if (/\.(mjs|js)$/.test(e.name)) codeFiles.push(p);
  }
}
for (const d of ['kernel', 'compiler/src', 'compiler/runtime', 'src']) { try { walk(join(ROOT, d)); } catch {} }
const codes = new Set();
for (const f of codeFiles) {
  const c = readFileSync(f, 'utf8');
  for (const m of c.matchAll(/\bLW\d{3}\b/g)) codes.add(m[0]);
}
const missingCodes = [...codes].filter(c => !text.includes(c) && !compiledText.includes(c));
if (missingCodes.length) warn(`fail-loud codes not documented in MAP/COMPILED: ${missingCodes.join(', ')}`);

// --- MAP→code: unverified runtime rows (soft) ---
const OPS_META = new Set(['ai','artisan','boost','console-tests','contributions','documentation','dusk','homestead','horizon','license','mix','mocking','mongodb','octane','packages','pint','processes','prompts','readme','releases','sail','valet','vite','installation','deployment','frontend','migrations','testing','structure','lifecycle','configuration','contracts','http-client','routing','csrf','urls','pagination','rate-limiting','database-testing','broadcasting','images','redis','reverb','realtime','processes']);
const SELF_MARKED = /unverified|no code|padanan|ops|meta|local|tooling|no module|NOT wired|NOT ported|subset|shim/i;
const SYN = { 'http-client':'fetch', 'eloquent-factories':'factory', 'blade':'blade', 'urls':'url', 'requests':'request', 'responses':'response', 'views':'view', 'logging':'log', 'mail':'mail', 'queues':'queue', 'scheduling':'schedul', 'filesystem':'storage', 'events':'event', 'facades':'facade', 'errors':'error', 'validation':'validat', 'authentication':'auth', 'authorization':'author', 'controllers':'controller', 'middleware':'middleware', 'cache':'cache', 'session':'session', 'hashing':'hash', 'csrf':'csrf', 'routing':'router', 'configuration':'config', 'contracts':'contract', 'deployment':'deploy', 'frontend':'frontend', 'installation':'install', 'lifecycle':'lifecycle', 'migrations':'migrat', 'structure':'structure', 'testing':'test', 'vite':'vite', 'urls':'url', 'pagination':'paginate', 'rate-limiting':'ratelimit', 'database-testing':'db', 'notifications':'notif', 'passwords':'password', 'verification':'verif', 'search':'search', 'scout':'scout', 'pennant':'pennant', 'ai-sdk':'ai', 'billing':'billing', 'filesystem':'storage', 'fortify':'fortify', 'head':'head', 'mcp':'mcp', 'passport':'passport', 'precognition':'precog', 'pulse':'pulse', 'sanctum':'sanctum', 'socialite':'social', 'starter-kits':'starter', 'concurrency':'Promise', 'eloquent-mutators':'accessor', 'context':'context', 'providers':'provider', 'helpers':'helper', 'collections':'collection', 'strings':'string', 'queries':'quer', 'database':'db', 'encryption':'encrypt', 'eloquent':'eloquent', 'localization':'local', 'i18n':'i18n', 'ai':'ai', 'artisan':'artisan', 'boost':'boost' };
const unverified = [];
for (const r of rows) {
  const parts = r.split('|').map(s => s.trim());
  const page = parts[1];
  const klass = parts[2];
  const note = parts[3];
  if (OPS_META.has(page)) continue;
  if (klass.includes('\u26D4')) continue;
  if (SELF_MARKED.test(note)) continue;
  const needle = (SYN[page] || page).toLowerCase();
  const inCode = codeFiles.some(f => readFileSync(f, 'utf8').toLowerCase().includes(needle));
  if (!inCode) unverified.push(page);
}
if (unverified.length) warn(`MAP rows with no code hit (verify or mark \u26D4/ops): ${unverified.join(', ')}`);

// --- the integrations (COMPILED.md 8b M68) -------------------------------
// Every Laravel integration page must answer three things: what the edge can
// do, what it refuses (with a reason), and the PORT that carries the
// difference. A row missing any of them - or a page that disappeared - is a
// gap, not a note.
const INTEGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'integrations.json');
let integrations = null;
try {
  integrations = JSON.parse(readFileSync(INTEGRATIONS, 'utf8'));
} catch (e) {
  fail('cannot read tools/integrations.json: ' + e.message);
}
const PAGES = [
  'passport', 'sanctum', 'socialite', 'cashier-paddle',
  'billing', 'mcp', 'ai-sdk', 'pulse',
];
const seenIntegrations = new Set();
for (const row of integrations.pages || []) {
  const id = row && row.id;
  if (!id) fail('an integration row has no id');
  if (!PAGES.includes(id)) fail('unknown integration page: ' + id);
  if (seenIntegrations.has(id)) fail('duplicate integration page: ' + id);
  seenIntegrations.add(id);
  if (row.verdict !== 'port' && row.verdict !== 'refuse') {
    fail('integration ' + id + ' must carry a verdict ("port" or "refuse"), got ' + JSON.stringify(row.verdict));
  }
  if (!row.edge || !String(row.edge).trim()) fail('integration ' + id + ' does not say what the edge CAN do');
  if (!row.refusal || !String(row.refusal).trim()) fail('integration ' + id + ' does not say what is refused');
  if (!row.port || !String(row.port).trim()) fail('integration ' + id + ' has no port');
  if (!(row.docs && seen.has(row.docs))) fail('integration ' + id + ' has no MAP.md page named ' + JSON.stringify(row.docs));
}
const missingIntegrations = PAGES.filter((p) => !seenIntegrations.has(p));
if (missingIntegrations.length) fail('integration pages with no verdict: ' + missingIntegrations.join(', '));
ok(`${rows.length}/${EXPECTED} rows, format valid, ${modules.length} modules, ${codes.size} fail-loud codes`);
ok(`integrations: ${seenIntegrations.size}/${PAGES.length} pages carry a verdict + a port`);
console.log('coverage: ' + rows.length + '/' + EXPECTED);
if (missingModules.length || missingCodes.length || unverified.length) {
  console.log('modules-missing: ' + missingModules.length + ' | codes-missing: ' + missingCodes.length + ' | rows-unverified: ' + unverified.length);
}
