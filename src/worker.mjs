// src/worker.mjs — compiled Worker entry point
//   fetch -> kernel/http.mjs (EncryptCookies -> StartSession -> CSRF -> route middleware)
//        -> kernel/router.mjs handler -> cookies/session persisted back onto the response.
//
// Everything the compiled rung does not support fails loud inside handleHttp; this
// file only adapts the Workers Request/Response boundary.
import { normalizeTable } from '../kernel/router.mjs';
import { handleHttp } from '../kernel/http.mjs';
import { createDatabaseCache } from '../kernel/cache.mjs';
import { createMailer } from '../kernel/mail.mjs';
import { createStorage } from '../kernel/storage.mjs';
import { createQueue } from '../kernel/queue.mjs';
import { timingSafeEqual } from '../kernel/encrypter.mjs';
import { dueEvents } from '../kernel/scheduler.mjs';
import { routeTable, handlers, builtAt } from './routes.generated.mjs';
import { guardPorts } from './guard-ports.generated.mjs';
import { events as scheduleEvents } from './schedule.generated.mjs';
import config from './config.generated.mjs';
import { models } from './models.generated.mjs';
import { classes as LW_CLASSES } from './classes.generated.mjs';
import { renderErrorView } from './error-renderer.mjs';
import { buildRt } from './runtime/rt-from-context.mjs';

const table = normalizeTable(routeTable);

// Every method the router may dispatch. Anything else falls through to assets.
const DISPATCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// The `database` cache driver compiled to D1 backs `throttle:n,m` and the Cache
// facade. Only built when the app's default cache store IS `database`; any other
// driver leaves it null, and a `throttle` route then fails loud inside handleHttp.
function makeCache(env) {
  if (!env || !env.DB || config['cache.driver'] !== 'database') return null;
  return createDatabaseCache({ db: env.DB, config });
}

// The Storage padanan: the app's local disk is object storage at the edge (there
// is no local filesystem). R2 when the app binds it, else the D1 blob store (one
// row per object in `lw_blobs` - no extra Cloudflare product, no card). With
// neither, `Storage::` fails loud inside the handler instead of writing into a
// per-isolate memory map.
function makeStorage(env) {
  if (!env) return null;
  if (env.R2) return createStorage({ r2: env.R2, secret: config['app.key'] });
  if (env.DB) return createStorage({ d1: env.DB, secret: config['app.key'] });
  return null;
}

// The log padanan: the platform log (the Workers console). The app's log
// file has no place at the edge.
function makeLogger() {
  return (level, message, context) => {
    const line = '[' + String(level) + '] ' + String(message);
    if (context !== undefined && context !== null) console.log(line, JSON.stringify(context));
    else console.log(line);
    return null;
  };
}
// The mailer: `log` (default, no network), `noop` or `resend`.
function makeMail(env) {
  return createMailer({
    transport: config['mail.driver'] || 'log',
    from: config['mail.from.address'] || undefined,
    key: env && env.RESEND_API_KEY,
    fetchImpl: env && typeof env.fetch === 'function' ? env.fetch.bind(env) : undefined,
  });
}

// The queue: a CF Queues binding when the app has one, else the in-memory
// fallback (a port can push either way).
function makeQueue(env) {
  return createQueue({ binding: env && env.QUEUE ? env.QUEUE : null });
}

function toResponse(res, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  for (const cookie of res.setCookie || []) headers.append('set-cookie', cookie);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

// The Cloudflare Cron Trigger: the app's dumped schedule fires here, and every
// due event is queued for the app runtime that still exists (the edge triggers,
// it does not run artisan).
async function runSchedule(env, now = new Date()) {
  // Laravel copies `config('app.timezone')` onto EVERY scheduled event, so an
  // event the dump left without a timezone still means wall-clock in that zone.
  // Falling back to UTC here (the old behaviour) made an app whose schedule has
  // no explicit timezone fire at the WRONG local time - and with the UTC trigger
  // conversion in the build, never at all.
  const due = dueEvents(scheduleEvents, now, config['app.timezone'] || undefined);
  if (due.length === 0) return { due: [], queued: [], dropped: [] };
  const queue = makeQueue(env);
  // The due event is queued for the app runtime that still exists (the edge
  // triggers, it does not run artisan) - and the app reaches that runtime
  // through the `QUEUE` binding. The kernel's fallback without one is an
  // IN-MEMORY queue that dies with the invocation, so the payload is dropped
  // and the schedule silently never reaches anything. That is exactly the
  // silent no-op the build's queue gate exists to prevent, so it is named
  // here (the answer of `/__lw/cron` carries `dropped`, and the log carries the
  // event names for `wrangler tail`).
  const delivered = queue.hasBinding !== false;
  const names = due.map((e) => e.name);
  if (!delivered) {
    console.warn(
      '[laravel-workers] the schedule event(s) ' +
        names.join(', ') +
        ' fired, but the app binds no QUEUE producer - the payload was written to the in-memory queue and is discarded when this invocation ends (the schedule does not reach the app runtime). Bind it: {"queues":{"producers":[{"binding":"QUEUE","queue":"<name>"}]}}.'
    );
  }
  const queued = [];
  if (delivered) {
    for (const ev of due) {
      const job = {
        name: ev.name,
        expression: ev.expression,
        command: ev.command,
        timezone: ev.timezone || null,
      };
      await queue.push('laravel-schedule', job);
      queued.push(job.name);
    }
  }
  return { due: names, queued, dropped: delivered ? [] : names };
}

// The queue consumer (COMPILED.md M63): `Job::dispatch()` writes a row into
// `lw_jobs`, and the CRON TRIGGER drains it here. A Worker has no long-lived
// worker process, so a cron trigger is the only way a queued job ever runs -
// the build refuses a push when the worker has none.
function jobHandlers() {
  const out = {};
  for (const [fqcn, entry] of Object.entries(LW_CLASSES || {})) {
    if (!entry || !entry.methods || typeof entry.methods.handle !== 'function') continue;
    // The instance is built through `rt.newClass()` - the SAME path a compiled
    // `new OrderJob()` takes: the constructor's injected services are resolved
    // (an adapter the worker hands down, or another compiled class), the
    // kernel base is attached (`base`), and the compiled methods are bound to
    // the instance so `$this->...` inside handle() reaches the constructor's
    // properties. Hand-rolling the ctor here passed an EMPTY dependency map and
    // an undefined `$this` target - a job whose constructor injects a service
    // (or whose handle() touches $this) died at drain time, and the row was
    // dropped after 3 attempts (the work silently never happened).
    out[fqcn] = { build: async (rt, args) => rt.newClass(fqcn, args) };
  }
  return out;
}

async function drainQueue(env, limit = 10) {
  const db = env && env.DB ? env.DB : null;
  if (!db) return { ran: 0, failed: 0 };
  const handlersByJob = jobHandlers();
  if (!Object.keys(handlersByJob).length) return { ran: 0, failed: 0 };
  // The drain runs OUTSIDE a request, so there is no request/session to hand
  // down - but the compiled classes (the job's own dependencies) and the
  // service adapters are the same ones a request gets. Without them
  // `rt.newClass()` cannot resolve a job's injected service and a
  // `Mail::`/`Log::`/`dispatch()` inside handle() fails.
  const rt = buildRt(null, {
    strict: false,
    runtime: true,
    db,
    models,
    classes: LW_CLASSES,
    http: {
      config,
      cache: makeCache(env),
      storage: makeStorage(env),
      log: makeLogger(),
      mail: makeMail(env),
      queue: makeQueue(env),
    },
  });
  return rt.queueDrain(db, handlersByJob, limit);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The cron trigger also has an HTTP face (`POST /__lw/cron`), so an app
    // (or a wrangler dev session) can fire the schedule by hand. A Worker URL
    // is reachable by anyone, so this face stays CLOSED unless `LW_CRON_SECRET`
    // is set: the caller must then present the same value in `X-LW-Cron`.
    // Without the secret the path answers 404, so the endpoint is
    // indistinguishable from a non-existent route (no unauthenticated trigger).
    // The face mirrors the TRIGGER exactly: the schedule fires AND the queued
    // jobs drain. A hand-fired cron that skipped the drain would leave the
    // `lw_jobs` rows to the next scheduled trigger - the same silent gap the
    // trigger's own drain exists to close.
    if (url.pathname === '/__lw/cron' && request.method === 'POST') {
      const secret = env && env.LW_CRON_SECRET;
      const provided = request.headers.get('x-lw-cron') || '';
      if (!secret || !timingSafeEqual(provided, secret)) {
        return new Response('Not Found', { status: 404 });
      }
      const out = await runSchedule(env, new Date());
      const jobs = await drainQueue(env);
      return Response.json({ ok: true, ...out, jobs });
    }

    if (DISPATCH_METHODS.has(request.method)) {
      // A multipart body is binary: the bytes as they are (a text body would
      // mangle them).
      const isMultipart = (request.headers.get('content-type') || '')
        .toLowerCase()
        .includes('multipart/form-data');
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? ''
          : isMultipart
            ? new Uint8Array(await request.arrayBuffer())
            : await request.text();
      const db = env && env.DB ? env.DB : null;
      const res = await handleHttp(
        {
          method: request.method,
          url: request.url,
          // Multiple headers of the same name arrive comma-joined, like PHP's
          // $_SERVER. `set-cookie` never appears on requests, so this is lossless.
          headers: Object.fromEntries(request.headers),
          body,
        },
        {
          table,
          handlers,
          config,
          env,
          db,
          cache: makeCache(env),
          storage: makeStorage(env),
          log: makeLogger(),
          mail: makeMail(env),
          queue: makeQueue(env),
          models,
          // registry.json → "guards": a driver the app implements in JS
          // (Auth::extend) is answered by that port, so `auth:seal` and
          // `auth()->user()` keep working instead of diverging.
          guardPorts,
          renderErrorView,
        }
      );
      if (res) return toResponse(res, request.method);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'laravel-workers', builtAt });
    }

    // The static bundle (`assets.directory = ./dist/public`). A deployment
    // whose wrangler config omits the binding would throw on `undefined.fetch`
    // and turn every unmatched path into a 500; a 404 is the honest answer.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
  },

  // The Cloudflare Cron Trigger entry point (`scheduled`): the schedule fires
  // AND the queued jobs are drained (the only consumer a Worker has).
  //
  // The runtime calls `scheduled(controller, env, ctx)` - the CONTROLLER is the
  // first argument (it carries `cron`, `type` and `scheduledTime`), exactly as
  // `fetch(request, env, ctx)` puts the request first. Declaring `(env, ctx)`
  // therefore bound the CONTROLLER to `env`: every `env.DB` / `env.QUEUE` read
  // answered undefined, so the queue drain silently did nothing (`{ran: 0}`)
  // and the schedule push fell back to the in-memory queue. Probed against the
  // runtime contract: with `(controller, env, ctx)` the real env is read; with
  // `(env, ctx)` it is read ZERO times.
  async scheduled(controller, env, ctx) {
    // `controller.scheduledTime` is the instant the trigger was scheduled for in
    // ms since the epoch; the due test must use it (the trigger can arrive late,
    // and `new Date()` would test the arrival moment instead).
    const when = new Date(
      controller && typeof controller.scheduledTime === 'number' ? controller.scheduledTime : Date.now()
    );
    const out = await runSchedule(env, when);
    const jobs = await drainQueue(env);
    return { ok: true, ...out, jobs };
  },
};
