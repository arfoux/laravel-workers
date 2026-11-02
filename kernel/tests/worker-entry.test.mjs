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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
        const done = { all: async () => ({ results: [] }), run: async () => ({}), first: async () => null };
        // The kernel reaches `db.prepare(sql).run()` without binding first
        // (`ensureQueueTable`), so the statement itself has to answer: the
        // returned object binds to ITSELF, not to a fresh one.
        return { ...done, bind: () => ({ ...done }) };
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

test(
  'worker entry: `POST /__lw/cron` is the trigger\'s equal — it drains the queue',
  { skip: appRoot ? false : 'no built app (set LW_LARAVEL_APP to an app with dist/src/worker.mjs)' },
  async () => {
    const worker = (await import(pathToFileURL(path.join(appRoot, 'dist', 'src', 'worker.mjs')).href)).default;

    // The fixture's compiled job class: the drain resolves the row's FQCN
    // through this map, so an app with one is the interesting case.
    const classesPath = path.join(appRoot, 'dist', 'src', 'classes.generated.mjs');
    let jobFqcn = null;
    if (existsSync(classesPath)) {
      const { classes } = await import(pathToFileURL(classesPath).href);
      jobFqcn =
        Object.keys(classes || {}).find(
          (k) => classes[k] && classes[k].methods && typeof classes[k].methods.handle === 'function'
        ) || null;
    }
    const seeded = jobFqcn ? [{ id: 7, job: jobFqcn, payload: '["on-cron-face"]', attempts: 0 }] : [];
    const statements = [];

    // A D1 stub whose `lw_jobs` SELECT answers the seeded row, so the drain has
    // something real to consume.
    const d1 = {
      prepare: (sql) => {
        const isQueueSelect = /^SELECT "id", "job", "payload", "attempts" FROM "lw_jobs"/.test(sql);
        const done = {
          all: async () => (isQueueSelect ? { results: seeded } : { results: [] }),
          run: async () => {
            statements.push(sql);
            return {};
          },
          first: async () => null,
        };
        return { ...done, bind: () => ({ ...done }) };
      },
      exec: async () => ({}),
      batch: async () => [],
    };
    const env = { DB: d1, QUEUE: { send: async () => ({}) }, LW_CRON_SECRET: 'sekret' };
    const ctx = { waitUntil() {} };

    // Without the secret the face is indistinguishable from a missing route.
    const closed = await worker.fetch(
      new Request('https://edge.test/__lw/cron', { method: 'POST' }),
      env,
      ctx
    );
    assert.equal(closed.status, 404, 'the cron face must stay closed without LW_CRON_SECRET');

    // With the secret the face fires the schedule AND drains the queue - a hand
    // fired cron that left the `lw_jobs` rows behind would be the same silent
    // gap the trigger's own drain exists to close (`scheduled`).
    const out = await worker.fetch(
      new Request('https://edge.test/__lw/cron', {
        method: 'POST',
        headers: { 'x-lw-cron': 'sekret' },
      }),
      env,
      ctx
    );
    assert.equal(out.status, 200);
    const body = await out.json();
    assert.equal(body.ok, true);
    assert.ok(
      body.jobs && typeof body.jobs.ran === 'number' && typeof body.jobs.failed === 'number',
      'POST /__lw/cron must return the drain result (the trigger returns the same shape)'
    );

    // The seeded row is CONSUMED (ran or failed - never left behind): the old
    // face never reached the drain at all, so the row sat in `lw_jobs` until a
    // real Cron Trigger fired.
    if (seeded.length) {
      assert.equal(body.jobs.ran + body.jobs.failed, 1, 'the cron face must consume the queued row');
      assert.ok(
        statements.some((s) => /^DELETE FROM "lw_jobs" WHERE "id" = \?$/.test(s)),
        'a consumed row must leave `lw_jobs`'
      );
    }
  }
);

// The schedule push and the app's `QUEUE` producer binding. A due event is
// delivered by `env.QUEUE.push()` - the app runtime that consumes it lives
// outside this Worker - and the kernel's fallback without a binding is an
// IN-MEMORY queue that is discarded when the invocation ends. The payload then
// vanishes, and the old answer (`queued: ["posts:prune"]`) claimed delivery
// that never happened: the silent no-op the build's queue gate exists to
// prevent. The due event is injected through the built artifact's own
// `schedule.generated.mjs` (the file the worker imports), which is restored
// afterwards, and the handler runs in a CHILD process: the parent already
// imported the worker, so its module graph (and that file) is cached here.
test(
  'worker entry: a due event with no QUEUE binding is reported as dropped, not queued',
  { skip: appRoot ? false : 'no built app (set LW_LARAVEL_APP to an app with dist/src/worker.mjs)' },
  () => {
    const schedPath = path.join(appRoot, 'dist', 'src', 'schedule.generated.mjs');
    const original = existsSync(schedPath) ? readFileSync(schedPath, 'utf8') : null;
    const workerUrl = pathToFileURL(path.join(appRoot, 'dist', 'src', 'worker.mjs')).href;
    const probe = `
      const worker = (await import(${JSON.stringify(workerUrl)})).default;
      const d1 = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({}), first: async () => null }), all: async () => ({ results: [] }), run: async () => ({}), first: async () => null }), exec: async () => ({}), batch: async () => [] };
      const controller = { cron: '* * * * *', type: 'scheduled', scheduledTime: Date.UTC(2026, 10, 2, 3, 0, 0) };
      const warns = [];
      const real = console.warn;
      console.warn = (...a) => { warns.push(a.join(' ')); };
      const noBind = await worker.scheduled(controller, { DB: d1 }, { waitUntil() {} });
      const sent = [];
      const bind = await worker.scheduled(controller, { DB: d1, QUEUE: { send: async (b) => { sent.push(b); } } }, { waitUntil() {} });
      console.warn = real;
      console.log(JSON.stringify({ noBind, bind, sent: sent.map((b) => b && b.payload && b.payload.name), warned: warns.length }));
    `;
    try {
      writeFileSync(
        schedPath,
        '// generated by build.mjs — do not edit\n' +
          'export const events = [{"name":"probe:due","expression":"* * * * *","command":"probe:due","timezone":"UTC","cron_triggerable":true}];\n' +
          'export default { events };\n'
      );
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
      const r = JSON.parse(out.trim().split('\n').pop());
      assert.deepEqual(r.noBind.due, ['probe:due'], 'the injected event must be due at the pinned instant');
      assert.deepEqual(r.noBind.queued, [], 'nothing is delivered without the QUEUE binding');
      assert.deepEqual(r.noBind.dropped, ['probe:due'], 'the dropped event must be named on the answer');
      assert.equal(r.warned, 1, 'the drop must reach the log (wrangler tail)');
      assert.deepEqual(r.bind.queued, ['probe:due'], 'with the binding the event is delivered');
      assert.deepEqual(r.bind.dropped, []);
      assert.deepEqual(r.sent, ['probe:due'], 'the QUEUE producer receives the event payload');
    } finally {
      if (original !== null) writeFileSync(schedPath, original);
    }
  }
);
