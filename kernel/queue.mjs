// kernel/queue.mjs — Queue (CF Queues or memory)
export function createQueue({ binding } = {}) {
  if (binding && typeof binding.send === 'function') {
    return {
      async push(queue, payload, opts = {}) {
        const o = opts || {};
        const delayMs = o.delayMs || 0;
        const tries = o.tries !== undefined ? o.tries : 3;
        const backoffMs = o.backoffMs !== undefined ? o.backoffMs : 0;
        const body = {
          queue,
          id: Math.random().toString(36).slice(2),
          payload,
          attempts: 0,
          availableAt: Date.now() + delayMs,
          tries,
          backoffMs,
          delaySeconds: Math.ceil(delayMs / 1000),
        };
        await binding.send(body);
        return body;
      },
      async pop() { return null; }, // CF Queues consumes via queue() handler, not pop
      async fail() { return null; },
      async failed() { return []; },
      async retryFailed() { return []; },
    };
  }
  const store = new Map(); // queue -> array
  function arr(q) { if (!store.has(q)) store.set(q, []); return store.get(q); }
  function failedArr(q) { const k = q + ':failed'; if (!store.has(k)) store.set(k, []); return store.get(k); }
  return {
    _store: store,
    async push(queue, payload, opts = {}) {
      const o = opts || {};
      const delayMs = o.delayMs || 0;
      const tries = o.tries !== undefined ? o.tries : 3;
      const backoffMs = o.backoffMs !== undefined ? o.backoffMs : 0;
      const job = {
        id: 'mem-' + (Math.random().toString(36).slice(2)),
        queue,
        payload,
        attempts: 0,
        availableAt: Date.now() + delayMs,
        tries,
        backoffMs,
      };
      arr(queue).push(job);
      return job;
    },
    async pop(queue) {
      const a = store.get(queue);
      if (!a || a.length === 0) return null;
      const now = Date.now();
      const idx = a.findIndex(j => (j.availableAt || 0) <= now);
      if (idx === -1) return null;
      return a.splice(idx, 1)[0];
    },
    async fail(...args) {
      let queue, job;
      if (args.length === 1) { job = args[0]; queue = job.queue; }
      else { queue = args[0]; job = args[1]; }
      if (!job) return null;
      job.attempts = (job.attempts || 0) + 1;
      const tries = job.tries !== undefined ? job.tries : 3;
      if (job.attempts < tries) {
        let delay = 0;
        if (Array.isArray(job.backoffMs)) delay = job.backoffMs[job.attempts - 1];
        else delay = job.backoffMs || 0;
        if (delay === undefined) delay = 0;
        job.availableAt = Date.now() + delay;
        arr(queue).push(job);
        return job;
      }
      failedArr(queue).push(job);
      return job;
    },
    async failed(queue) {
      return [...(store.get(queue + ':failed') || [])];
    },
    async retryFailed(queue) {
      const f = store.get(queue + ':failed') || [];
      const moved = [...f];
      f.length = 0;
      for (const job of moved) {
        job.attempts = 0;
        job.availableAt = Date.now();
        arr(queue).push(job);
      }
      return moved;
    },
  };
}
export default { createQueue };
