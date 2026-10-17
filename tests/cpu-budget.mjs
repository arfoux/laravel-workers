import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const controllerUrl = pathToFileURL(path.resolve(root, 'edge/dist/src/controllers/home.mjs')).href;
const contextUrl = pathToFileURL(path.resolve(root, 'edge/dist/src/contexts/welcome.mjs')).href;
const runtimeUrl = pathToFileURL(path.resolve(root, 'edge/dist/src/runtime/rt-from-context.mjs')).href;

const { default: handle } = await import(controllerUrl);
// warm up
for (let i = 0; i < 5; i++) handle({}, {});

const times = [];
for (let i = 0; i < 100; i++) {
  const t0 = performance.now();
  const res = handle({}, {});
  const t1 = performance.now();
  times.push(t1 - t0);
  assert.equal(res.status, 200);
}

times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.5)];
const p95 = times[Math.floor(times.length * 0.95)];
const max = times[times.length - 1];

console.log(`cpu-budget: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`);

assert.ok(p95 <= 8, `p95 ${p95}ms > 8ms`);
assert.ok(max <= 10, `max ${max}ms > 10ms`);
console.log('cpu-budget: PASS');
