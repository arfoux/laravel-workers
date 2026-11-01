// kernel/tests/worker-entry.test.mjs — the Worker entry's Cloudflare contract.
//
// The deployed entry is `dist/src/worker.mjs` (build.mjs copies `src/worker.mjs`
// verbatim). The Workers runtime calls its handlers as
//
//   fetch(request, env, ctx)        -> the REQUEST is the first argument
//   scheduled(controller, env, ctx) -> the CONTROLLER is the first argument
//
// (https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/:
// `controller.cron`, `controller.type`, `controller.scheduledTime`).
//
// The `scheduled` handler once declared `(env, ctx)`, so at a real Cron Trigger
// the CONTROLLER was bound to `env`: `env.DB` and `env.QUEUE` were undefined, the
// queue drain answered `{ran: 0, failed: 0}` without touching D1, and the
// schedule push fell to the dead in-memory queue. The shadow harness and the
// suite never called `scheduled()`, so nothing caught it. This test calls the
// built entry with the runtime's real argument order and asserts the handler
// reads the REAL environment.
//
// Needs a built app (the same fixture the oracle tests use):
//
//   LW_LARAVEL_APP=/path/to/app   (with `dist/src/worker.mjs`)
//
// Without one it SKIPS with a reason — it is not green by omission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function builtAppRoot() {
  const candidates = [];
  if (process.env.LW_LARAVEL_APP) candidates.push(process.env.LW_LARAVEL_APP);
  for (const dir of ['parity-app', 'e2e-app']) candidates.push(path.join(repoRoot, dir));
  for (const root of candidates) {
    if (root && existsSync(path.join(root, 'dist', 'src', 'worker.mjs'))) return root;
  }
  return null;
}

const appRoot = builtAppRoot();

test(
  'worker entry: `scheduled(controller, env, ctx)` uses the real env (Cron Triggers)',
  { skip: appRoot ? false : 'no built app (set LW_LARAVEL_APP to an app with dist/src/worker.mjs)' },
  async () => {
    const worker = (await import(pathToFileURL(path.join(appRoot, 'dist', 'src', 'worker.mjs')).href)).default;

    // The runtime's contract has three parameters: controller, env, ctx.
    assert.ok(
      worker.scheduled.length >= 3,
      'scheduled(controller, env, ctx) must declare the controller first, not `(env, ctx)`'
    );

    // An instrumented environment: every property the handler reads is recorded,
    // and a D1 stub counts the statements it is asked to run.
    const reads = [];
    let prepared = 0;
    const d1 = {
      prepare() {
        prepared += 1;
        return { bind: () => ({ all: async () => ({ results: [] }), run: async () => ({}), first: async () => null }) };
      },
      exec: async () => ({}),
      batch: async () => [],
    };
    const env = new Proxy(
      { DB: d1, QUEUE: { send: async () => ({}) }, LW_CRON_SECRET: 'sekret', ASSETS: { fetch: async () => new Response('') } },
      {
        get(target, prop) {
          reads.push(String(prop));
          return target[prop];
        },
      }
    );

    // Exactly what the runtime passes: the CONTROLLER first.
    const controller = { cron: '* * * * *', type: 'scheduled', scheduledTime: Date.now() };
    const ctx = { waitUntil() {} };

    const out = await worker.scheduled(controller, env, ctx);

    assert.ok(reads.includes('DB'), 'the handler must read env.DB (the D1 binding); reads were: ' + JSON.stringify(reads));
    assert.equal(out.ok, true);
    assert.ok(out.jobs && typeof out.jobs.ran === 'number', 'scheduled() must return the drain result');

    // The schedule push consults the queue binding ONLY when an event is due; a
    // fixture with no due event returns before `makeQueue`, so the QUEUE read is
    // asserted only when the app actually ships a schedule.
    const schedPath = path.join(appRoot, 'dist', 'src', 'schedule.generated.mjs');
    if (existsSync(schedPath)) {
      const { events } = await import(pathToFileURL(schedPath).href);
      if (Array.isArray(events) && events.length > 0) {
        assert.ok(
          reads.includes('QUEUE'),
          'a due schedule event must read env.QUEUE; reads were: ' + JSON.stringify(reads)
        );
      }
    }

    // When the app declares job classes, the drain reaches D1. With none it is a
    // no-op, but the binding was still consulted (asserted above).
    const classesPath = path.join(appRoot, 'dist', 'src', 'classes.generated.mjs');
    if (existsSync(classesPath)) {
      const { classes } = await import(pathToFileURL(classesPath).href);
      const hasJobs = Object.values(classes || {}).some((c) => c && c.methods && typeof c.methods.handle === 'function');
      if (hasJobs) {
        assert.ok(prepared > 0, 'a drain with job classes must query D1 (the `lw_jobs` table)');
      }
    }
  }
);
