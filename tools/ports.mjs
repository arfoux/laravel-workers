// tools/ports.mjs — port-file helpers shared by the build:
//   buildStubSource() — `--scaffold` stub generator (must match the controller
//     re-export contract: a DEFAULT export returning { status, headers, body })
//   findStubPorts()   — stub detector: the build flags scaffold stubs so a
//     "green" build never silently ships a 501 handler.
//
// Port contract (see README):
//   export default async function handle(ctx, env) { ... }
//   return { status: 200, headers: {...}, body: 'string' }

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_MARKER = 'laravel-workers:stub';

export function buildStubSource(route) {
  const lines = [
    `// Port for GET ${route} — ${STUB_MARKER}`,
    '// TODO: implement against env.DB (or another binding) and return { status, headers, body }.',
  ];
  if (route.includes('{')) {
    lines.push('// NOTE: dynamic segments ARE matched by the worker router — read them from ctx.params.');
  }
  lines.push(
    'export default async function handle(ctx, env) {',
    '  return {',
    '    status: 501,',
    "    headers: { 'content-type': 'application/json' },",
    `    body: JSON.stringify({ error: 'not implemented', route: ${JSON.stringify(route)} }),`,
    '  };',
    '}',
    ''
  );
  return lines.join('\n');
}

export function findStubPorts(dir) {
  if (!dir || !existsSync(dir)) return [];
  const stubs = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (text.includes(STUB_MARKER)) stubs.push(name);
  }
  return stubs.sort();
}
