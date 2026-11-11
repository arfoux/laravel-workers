// tools/tests/port-manifest.test.mjs — PORT_MANIFEST (tools/port-manifest.mjs) is
// the single route catalog for the package-port fleet. This test pins the two
// properties a manifest must never lose:
//
//   1. every slug in the manifest resolves to a real file under
//      `ports/packages/` (a manifest entry pointing at a port file that does not
//      exist would crash the build's import long after the manifest looked fine);
//   2. every route in `registry.example.json` (the reference mapping the docs
//      tell users to copy) is covered by the manifest — a registry key with no
//      manifest entry is a port the fleet documents but nobody can serve.
//
// The manifest is the single source of truth for the ROUTES; the registry is the
// single source of truth for what the example app actually maps. The two must
// agree. (Secrets/D1 are informational here — they come from the port files
// themselves, not from the registry, so there is nothing to compare them against.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PORT_MANIFEST, validateManifest, missingRegistryRoutes, missingManifestFiles, REGISTRY_EXAMPLE_PATH } from '../port-manifest.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadRegistryRoutes() {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, REGISTRY_EXAMPLE_PATH), 'utf8'));
  return raw.ports || {};
}

// A manifest is well-formed: structure, `file` shape, methods/d1/secrets types.
test('the manifest is structurally valid', () => {
  assert.equal(validateManifest().ok, true, validateManifest().problems.join('\n'));
});

// Every slug the manifest names (route ports and non-route ports alike) must
// resolve to an existing file under `ports/packages/`.
test('every manifest route points at an existing port file', () => {
  const missing = missingManifestFiles(repoRoot);
  assert.deepEqual(missing, [], missing.map((m) => `${m.route} -> ${m.file}`).join('\n'));

  const routeSlugs = new Set(Object.values(PORT_MANIFEST).map((e) => e.slug));
  for (const slug of routeSlugs) {
    const file = resolve(repoRoot, 'ports', 'packages', `${slug}.mjs`);
    assert.equal(existsSync(file), true, `manifest references ports/packages/${slug}.mjs but it does not exist`);
  }
});

// The registry key -> slug mapping and the manifest must agree: every route the
// registry maps is present in the manifest, and its manifest slug must NOT
// contradict the registry's slug.
test('every registry.example.json route is in the manifest', () => {
  const registry = loadRegistryRoutes();
  const missing = missingRegistryRoutes(registry);
  assert.deepEqual(missing, [], missing.map((m) => `/${m.path} -> ${m.slug} is not in PORT_MANIFEST`).join('\n'));

  const slugConflicts = Object.entries(registry)
    .filter(([route]) => route in PORT_MANIFEST)
    .filter(([route, slug]) => PORT_MANIFEST[route].slug !== slug)
    .map(([route, slug]) => `${route}: registry -> ${slug}, manifest -> ${PORT_MANIFEST[route].slug}`);
  assert.deepEqual(slugConflicts, [], slugConflicts.join('\n'));
});

// Manifest entries have a `methods` array (never empty for a route port) and
// their `file` matches the port file for `slug`.
test('each route entry declares methods and the slug file', () => {
  for (const [route, entry] of Object.entries(PORT_MANIFEST)) {
    if (entry.methods.length === 0) continue; // non-route ports carry [] methods
    assert.ok(Array.isArray(entry.methods) && entry.methods.length > 0, `${route}: methods must be non-empty`);
    assert.match(entry.file, /^ports\/packages\/[a-z0-9-]+\.mjs$/, `${route}: file shape`);
    assert.equal(entry.file, `ports/packages/${entry.slug}.mjs`, `${route}: file must match slug`);
  }
});
