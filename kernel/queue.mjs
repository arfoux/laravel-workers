// kernel/queue.mjs — Queue (CF Queues or memory)
export function createQueue({ binding } = {}) {
  if (binding && typeof binding.send === 'function') {
    return {
      async push(queue, payload) {
        const body = { queue, id: Math.random().toString(36).slice(2), payload, attempts: 0 };
        await binding.send(body);
        return body;
      },
      async pop() { return null; }, // CF Queues consumes via queue() handler, not pop
    };
  }
  const store = new Map(); // queue -> array
  return {
    _store: store,
    async push(queue, payload) {
      if (!store.has(queue)) store.set(queue, []);
      const job = { id: 'mem-' + (Math.random().toString(36).slice(2)), payload, attempts: 0 };
      store.get(queue).push(job);
      return job;
    },
    async pop(queue) {
      const arr = store.get(queue);
      if (!arr || arr.length === 0) return null;
      return arr.shift();
    },
  };
}
export default { createQueue };
