// tools/registry-json.mjs — merge scaffolded port entries into registry.json.
//
// `build --scaffold` writes stub port files for routes that need a port, then
// adds the matching "ports" mapping (route -> slug) to the registry here, so
// nothing has to be edited by hand. Existing entries are never overwritten.

export function mergePorts(registry, entries) {
  const ports = { ...(registry.ports || {}) };
  const added = [];
  for (const { route, slug } of entries || []) {
    if (Object.prototype.hasOwnProperty.call(ports, route)) continue;
    ports[route] = slug;
    added.push({ route, slug });
  }
  return { registry: { ...registry, ports }, added };
}

export function serializeRegistry(registry) {
  return JSON.stringify(registry, null, 2) + '\n';
}

export default { mergePorts, serializeRegistry };
