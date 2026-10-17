#!/usr/bin/env node
// edge/ship.mjs — build + deploy in one command.
// Usage: node edge/ship.mjs [--strict] [--scaffold]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const edgeDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(edgeDir);
const passthrough = process.argv.slice(2);

console.log('== 1/2 build ==');
execFileSync(process.execPath, [join(edgeDir, 'build.mjs'), ...passthrough], {
  cwd: root,
  stdio: 'inherit',
});

const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
if (!existsSync(wrangler)) {
  console.error('wrangler not found — run `npm install` in the repo root first.');
  process.exit(1);
}

console.log('== 2/2 deploy ==');
execFileSync(process.execPath, [wrangler, 'deploy'], { cwd: edgeDir, stdio: 'inherit' });
console.log('ship: build + deploy done.');
