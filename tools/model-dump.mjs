#!/usr/bin/env node
// tools/model-dump.mjs — PHP-backed model dump (the node-side entry point for
// the tests and for tooling; the BUILD answers models through the Track F
// metadata phase, `tools/metadata-phase.php`, in one Laravel boot).
//
// Path B ("zero wait"): read the app's OWN PHP source with php-parser instead
// of booting Laravel inside a PHP process. The complex fields (casts() method,
// traits/softDeletes, relation invocation, #[] attributes) still need the real
// framework, so the PHP oracle answers them — but the ONE field the JS layer
// is responsible for, the DEFAULT table name (`Str::snake(Str::pluralStudly(
// class_basename($fqcn)))`), is computed here with the embedded Doctrine
// English-plural inflector. A model that declares `$table` keeps PHP's value
// (the declared literal): the JS inflector only ever supplies the derived
// default.
//
// Usage: node tools/model-dump.mjs [--recursive] "App\Models\Post" ["App\Models\User" ...]
// Output (stdout): the same JSON array the PHP tool emitted, with the derived
// `table` values recomputed by the JS inflector when the model leaves the
// table name to Laravel's default.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePhp } from './php-runtime.mjs';
import { classFile, parsePhpFile } from './static.mjs';
import { studly, snake } from '../kernel/str.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Doctrine English pluralizer (Laravel's Illuminate\Support\Pluralizer ->
// Doctrine\Inflector), ported verbatim from the vendor sources. Only the
// plural direction is needed: the default Eloquent table name is
// `Str::snake(Str::pluralStudly(class_basename($this)))`.
// ---------------------------------------------------------------------------

// Doctrine Inflectible::getIrregular() — lower-keyed, first-letter-case-aware.
const IRREGULAR_PLURAL = {
  abuse: 'abuses', alga: 'algae', atlas: 'atlases', avalanche: 'avalanches',
  axis: 'axes', axe: 'axes', beef: 'beefs', blouse: 'blouses', brother: 'brothers',
  brownie: 'brownies', cache: 'caches', cafe: 'cafes', canvas: 'canvases',
  cave: 'caves', chateau: 'chateaux', child: 'children', cookie: 'cookies',
  corpus: 'corpuses', cow: 'cows', criterion: 'criteria', curriculum: 'curricula',
  curve: 'curves', demo: 'demos', die: 'dice', domino: 'dominoes', echo: 'echoes',
  emphasis: 'emphases', epoch: 'epochs', foe: 'foes', foot: 'feet', fungus: 'fungi',
  ganglion: 'ganglions', gas: 'gases', genie: 'genies', genus: 'genera',
  goose: 'geese', graffito: 'graffiti', grave: 'graves', hippopotamus: 'hippopotami',
  hoax: 'hoaxes', hoof: 'hoofs', human: 'humans', iris: 'irises', larva: 'larvae',
  leaf: 'leaves', lens: 'lenses', loaf: 'loaves', man: 'men', medium: 'media',
  memorandum: 'memoranda', money: 'monies', mongoose: 'mongooses', motto: 'mottoes',
  move: 'moves', mythos: 'mythoi', neurosis: 'neuroses', niche: 'niches',
  niveau: 'niveaux', nucleus: 'nuclei', numen: 'numina', nursery: 'nurseries',
  oasis: 'oases', occiput: 'occiputs', octopus: 'octopuses', opus: 'opuses',
  ox: 'oxen', passerby: 'passersby', penis: 'penises', person: 'people',
  plateau: 'plateaux', 'runner-up': 'runners-up', safe: 'safes', save: 'saves',
  sex: 'sexes', sieve: 'sieves', soliloquy: 'soliloquies', 'son-in-law': 'sons-in-law',
  stadium: 'stadiums', syllabus: 'syllabi', testis: 'testes', thief: 'thieves',
  tooth: 'teeth', tornado: 'tornadoes', trilby: 'trilbys', turf: 'turfs',
  valve: 'valves', volcano: 'volcanoes', wave: 'waves', zombie: 'zombies',
};

// Doctrine Uninflected::getDefault() + getPlural(), verbatim — each encoded as
// a case-insensitive regex body. A word matching ANY of them is left as-is.
const UNINFLECTED_PLURAL = [
  '\\w+media', 'advice', 'aircraft', 'amoyese', 'art', 'audio', 'baggage',
  'bison', 'borghese', 'bream', 'breeches', 'britches', 'buffalo', 'butter',
  'cantus', 'carp', 'cattle', 'chassis', 'clippers', 'clothing', 'coal', 'cod',
  'coitus', 'compensation', 'congoese', 'contretemps', 'coreopsis', 'corps',
  'cotton', 'data', 'debris', 'deer', 'diabetes', 'djinn', 'education', 'eland',
  'elk', 'emoji', 'equipment', 'evidence', 'faroese', 'feedback', 'fish',
  'flounder', 'flour', 'foochowese', 'food', 'furniture', 'gallows', 'genevese',
  'genoese', 'gilbertese', 'gold', 'headquarters', 'herpes', 'hijinks',
  'homework', 'hottentotese', 'impatience', 'information', 'innings',
  'jackanapes', 'jeans', 'jedi', 'kin', 'kiplingese', 'knowledge', 'kongoese',
  'leather', 'love', 'lucchese', 'luggage', 'mackerel', 'Maltese', 'management',
  'metadata', 'mews', 'money', 'moose', 'mumps', 'music', 'nankingese', 'news',
  'nexus', 'niasese', 'nutrition', 'offspring', 'oil', 'patience', 'pekingese',
  'piedmontese', 'pincers', 'pistoiese', 'plankton', 'pliers', 'pokemon',
  'police', 'polish', 'portuguese', 'proceedings', 'progress', 'rabies', 'rain',
  'research', 'rhinoceros', 'rice', 'salmon', 'sand', 'sarawakese', 'scissors',
  'sea[- ]bass', 'series', 'shavese', 'shears', 'sheep', 'siemens', 'silk',
  'sms', 'soap', 'social media', 'spam', 'species', 'staff', 'sugar', 'swine',
  'talent', 'toothpaste', 'traffic', 'travel', 'trousers', 'trout', 'tuna',
  'us', 'vermontese', 'vinegar', 'weather', 'wenchowese', 'wheat', 'whiting',
  'wildebeest', 'wood', 'wool', 'yengeese',
  // getPlural()'s adds on top of the default list.
  'people', 'trivia', '\\w+ware$', 'media',
];

// Doctrine Inflectible::getPlural() — ordered, first-match-wins transformations.
// {re, to}: `re` is the case-insensitive regex body, `to` the replacement with
// $1/$2 back-refs (Doctrine used \1\2; JS uses $1$2).
const PLURAL_REGULAR = [
  { re: '(s)tatus$', to: '$1tatuses' },
  { re: '(quiz)$', to: '$1zes' },
  { re: '^(ox)$', to: '$1en' },
  { re: '([m|l])ouse$', to: '$1ice' },
  { re: '(matr|vert|ind)(ix|ex)$', to: '$1ices' },
  { re: '(x|ch|ss|sh)$', to: '$1es' },
  { re: '([^aeiouy]|qu)y$', to: '$1ies' },
  { re: '(hive|gulf)$', to: '$1s' },
  { re: '(?:([^f])fe|([lr])f)$', to: '$1$2ves' },
  { re: 'sis$', to: 'ses' },
  { re: '([ti])um$', to: '$1a' },
  { re: '(tax)on$', to: '$1a' },
  { re: '(c)riterion$', to: '$1riteria' },
  { re: '(p)erson$', to: '$1eople' },
  { re: '(m)an$', to: '$1en' },
  { re: '(c)hild$', to: '$1hildren' },
  { re: '(f)oot$', to: '$1eet' },
  { re: '(buffal|her|potat|tomat|volcan)o$', to: '$1oes' },
  { re: '(alumn|bacill|cact|foc|fung|nucle|radi|stimul|syllab|termin|vir)us$', to: '$1i' },
  { re: 'us$', to: 'uses' },
  { re: '(alias)$', to: '$1es' },
  { re: '(analys|ax|cris|test|thes)is$', to: '$1es' },
  { re: 's$', to: 's' },
  { re: '^$', to: '' },
  { re: '$', to: 's' },
];

/** Pluralize an English word exactly like Laravel's Str::plural. */
export function plural(value, count = 2) {
  // Pluralizer::plural(): `is_countable($count)` -> count($count), then
  // `(int) abs($count) === 1` short-circuits (verified against PHP 8.3:
  // Str::plural('post', -1) = 'post', Str::plural('post', 1.5) = 'post',
  // 0 -> 'posts'). `Math.abs(x) === 1` answered 'posts' for 1.5.
  let n = count;
  if (Array.isArray(n)) n = n.length;
  else if (n && typeof n === 'object' && typeof n.length === 'number') n = n.length;
  if (Math.trunc(Math.abs(Number(n))) === 1) return String(value);
  const s = String(value == null ? '' : value);
  // Laravel's own uncountable list (Pluralizer::$uncountable).
  if (['recommended', 'related'].includes(s.toLowerCase())) return s;
  // The last character must be alphanumeric (ASCII or non-ASCII) — otherwise
  // the word is returned as-is (`preg_match(...) == 0`).
  if (!/^.*[A-Za-z0-9\u0080-\uFFFF]$/u.test(s)) return s;
  const inflected = doctrinePluralize(s);
  return matchCase(inflected, s);
}

/** Doctrine RulesetInflector::inflect() over the English plural ruleset. */
function doctrinePluralize(word) {
  if (word === '') return '';
  // 1) uninflected patterns — a single anchored case-insensitive alternation
  // (Doctrine Patterns::matches: `'/^(?:...)$/i'`): the word must match one of
  // the patterns as the ENTIRE string (`us` guards "us", not "user").
  const uninflected = new RegExp('^(?:' + UNINFLECTED_PLURAL.join('|') + ')$', 'i');
  if (uninflected.test(word)) return word;
  // 2) irregular substitutions — lower-keyed, first-letter case preserved.
  const lower = word.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(IRREGULAR_PLURAL, lower)) {
    const to = IRREGULAR_PLURAL[lower];
    if (lower[0] !== word[0]) return to[0].toUpperCase() + to.slice(1); // "Man"->"Men"
    return to;
  }
  // 3) regular transformations — first pattern match wins.
  for (const r of PLURAL_REGULAR) {
    if (new RegExp(r.re, 'i').test(word)) return word.replace(new RegExp(r.re, 'i'), r.to);
  }
  return word;
}

/** Pluralizer::matchCase() — mirror the comparison's casing onto the result. */
function matchCase(value, comparison) {
  const l = comparison.toLowerCase();
  if (l === comparison) return value.toLowerCase();
  const u = comparison.toUpperCase();
  if (u === comparison) return value.toUpperCase();
  if (comparison[0].toUpperCase() + comparison.slice(1) === comparison) {
    return value[0].toUpperCase() + value.slice(1);
  }
  const words = comparison.split(' ');
  const upperWords = words
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  if (upperWords === comparison) {
    return value
      .split(' ')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
  }
  return value;
}

/** Laravel's class_basename(): the segment after the last namespace slash. */
export const classBasename = (fqcn) =>
  String(fqcn || '').replace(/\\+$/, '').split('\\').pop() || '';

/** Eloquent's default table name for a model without `$table`. */
export function defaultTable(fqcn) {
  return snake(plural(studly(classBasename(fqcn))));
}

// ---------------------------------------------------------------------------
// CLI: thin pass-through to the PHP oracle, re-deriving the default table.
// ---------------------------------------------------------------------------
const appDir =
  process.env.LW_APP_ROOT ||
  (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);
const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].replace(/\\/g, '/').endsWith('/tools/model-dump.mjs'));
if (isMain) {
  const appDir =
    process.env.LW_APP_ROOT ||
    (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);
  if (!appDir) {
    process.stderr.write('model-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const recursive = rawArgs[0] === '--recursive';
  const fqcns = recursive ? rawArgs.slice(1) : rawArgs;
  if (!fqcns.length) {
    process.stderr.write('model-dump.mjs: no FQCNs given\n');
    process.exit(1);
  }

  const php = resolvePhp({ requirement: '>=8.1' });
  const raw = execFileSync(
    php.bin,
    [join(__dirname, 'model-dump.php'), ...(recursive ? ['--recursive'] : []), ...fqcns],
    {
      cwd: appDir,
      env: { ...process.env, LW_APP_ROOT: appDir },
    }
  ).toString('utf8');

  const entries = JSON.parse(raw);
  for (const entry of entries) {
    // A model that does not declare `$table` lets Laravel derive it from the
    // class name — the one field the JS layer owns in Path B. Recompute it here
    // so the derived value is proven against the real framework, and the later
    // fully-static tool needs no oracle for it.
    if (entry.model && !declaresTable(entry.fqcn)) {
      entry.table = defaultTable(entry.fqcn);
    }
  }
  process.stdout.write(JSON.stringify(entries) + '\n');
}

/**
 * Does the model's own source file declare a `$table` property (or a #[Table]
 * attribute, which uses the same default when absent)? The PHP oracle already
 * answered the effective `table`; this check only decides whether the JS
 * inflector should supply (and prove) the derived default.
 */
function declaresTable(fqcn) {
  const file = classFile(appDir, fqcn);
  if (!file) return false;
  const parsed = parsePhpFile(file);
  if (parsed.error || !parsed.classes.length) return false;
  const cls = parsed.classes[0];
  const body = (cls.body || []).filter((n) => n);
  for (const node of body) {
    if (node.kind === 'propertystatement' || node.kind === 'property') {
      for (const v of node.properties || [node]) {
        const name = v && v.name && (v.name.name ?? v.name);
        if (name === 'table') return true;
      }
    }
  }
  // #[Table('...')] attribute on the class also declares a table.
  for (const a of cls.attrGroups || []) {
    for (const attr of a.attrs || a.attribs || []) {
      const an = attr.name && (attr.name.name ?? attr.name);
      const short = String(an || '').replace(/^\\+/, '').split('\\').pop();
      if (short === 'Table') return true;
    }
  }
  return false;
}