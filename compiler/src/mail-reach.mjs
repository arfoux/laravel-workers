// compiler/src/mail-reach.mjs — the class graph a route reaches.
//
// A route does not only render its OWN views: a mailable renders ITS view,
// and at request time the mailable renders it through the ROUTE's runtime
// (kernel/mailable.mjs: the mailable's __lwMail() calls the runtime's
// view()). So the view of every mailable a route can REACH must be in that
// route's compiled view map - otherwise the request answers 500 ("view not
// compiled") where Laravel answers 200 and sends the mail.
//
// "Reach" is the class graph, and the build knows it exactly:
//   - the route's own `new X()` sites,
//   - a class's constructor dependencies (the runtime builds them: the exact
//     edge - a service a listener injects is ALWAYS built),
//   - a class's `new X()` sites (the compiler resolved them to their FQCN),
//   - the listeners of an event class (the runtime dispatches to them).
//
// The graph is walked with a visited set: a listener can dispatch an event
// whose listener dispatches back.
//
// The walk is deliberately over-approximating on the METHOD-CONDITIONAL edge
// (a class's `new` sites): over-attaching a view is harmless (the route
// imports a view it may not render), while under-attaching one is a
// request-time 500 where Laravel answers 200.

// The classes a route instantiates, resolved the way the COMPILER resolved
// them: the build's alias map (a short name -> the FQCN of the compiled
// class; an ambiguous short name is absent) and the set of compiled FQCNs (the
// FQCN-written form). The same rule the transpiler applies
// (compiler/src/transpiler.mjs: the `new` case), so the graph and the
// compiled code agree on WHICH class the route instantiates.
//
// `newClasses` is the extract's list: { alias, fqcn } per `new` site, the
// alias being the name as written (a leading backslash stripped).
// `classesMeta` is the build's compiled-class metadata: { fqcns, aliases }.
export function resolveNewSites(newClasses, classesMeta) {
  const fqcns = new Set(classesMeta && classesMeta.fqcns ? classesMeta.fqcns : []);
  const aliases = (classesMeta && classesMeta.aliases) || {};
  const out = [];
  for (const entry of newClasses || []) {
    const alias = String(entry.alias || '').replace(/^\\/, '');
    if (!alias) continue;
    // The short name of a compiled class (the alias map), else the class
    // itself (the FQCN-written form). A name the compiler could not resolve
    // (an unknown class) resolves to nothing here: the route was stopped.
    const fqcn = aliases[alias] || (fqcns.has(alias) ? alias : null);
    if (fqcn && !out.includes(fqcn)) out.push(fqcn);
  }
  return out;
}

// The classes a route reaches, from the route's own `new` sites.
// `ctx` carries the class graph:
//   classMeta    - the compiled classes: { FQCN: { instantiated: [FQCN] } }
//   dumpClasses  - the dumped classes: { FQCN: { kind, ctor: [...] } }
//   events       - the dumped events: { FQCN: { listeners: [FQCN] } }
export function reachableClasses(newClasses, classesMeta, ctx) {
  const seeds = resolveNewSites(newClasses, classesMeta);
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const fqcn = queue.shift();
    if (!fqcn || reached.has(fqcn)) continue;
    reached.add(fqcn);
    for (const next of classEdges(fqcn, ctx)) {
      if (next && !reached.has(next)) queue.push(next);
    }
  }
  return { reached, seeds };
}

// The classes one class reaches: its constructor dependencies, the classes it
// instantiates, and (for an event class) its listeners.
function classEdges(fqcn, ctx) {
  const edges = [];
  // The constructor dependencies (the runtime builds them: rt.newClass for
  // every class-typed dependency - the exact edge). The dump records the
  // dependency's class (and the concrete binding of an interface).
  const dumped = (ctx.dumpClasses && ctx.dumpClasses[fqcn]) || null;
  for (const p of (dumped && dumped.ctor) || []) {
    if (!p || p.kind !== 'class') continue;
    edges.push(p.impl || p.type);
  }
  // The classes the class instantiates (`new X()` in its methods).
  const meta = (ctx.classMeta && ctx.classMeta[fqcn]) || null;
  for (const inst of (meta && meta.instantiated) || []) edges.push(inst);
  // The listeners of an event class (the runtime dispatches the event to them).
  const event = (ctx.events && ctx.events[fqcn]) || null;
  for (const listener of (event && event.listeners) || []) edges.push(listener);
  return edges;
}

// The mailables among the reached classes: the app's mailable classes (the
// dump records their kind). Each mailable's views must be in the route's view
// map.
export function reachedMailables(reached, dumpClasses) {
  const mailables = [];
  for (const fqcn of reached) {
    const info = (dumpClasses && dumpClasses[fqcn]) || null;
    if (info && info.kind === 'mailable' && !mailables.includes(fqcn)) mailables.push(fqcn);
  }
  return mailables;
}

export default { resolveNewSites, reachableClasses, reachedMailables };
