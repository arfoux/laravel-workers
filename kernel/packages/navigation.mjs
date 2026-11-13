// kernel/packages/navigation.mjs — JSON navigation tree + breadcrumbs.
// Pure functions, no D1. Complements `menu.mjs`: Menu renders server HTML,
// these helpers build a portable tree a SPA / hydration layer can consume.
//
// Input items are a flat list of `{ id?, label, url?, parent?, active? }`
// (flat list with a `parent` id is what a CMS menu table typically gives you)
// OR an already-nested `{ label, url, children }` array. Both shapes are
// accepted by buildNavigation().
//
//   buildNavigation(items, { currentPath })
//     → [{ id, label, url, children: [...], active }]
//   breadcrumbs(items, currentPath)
//     → [{ id, label, url, active }]  // root → current, active on the last

// Normalise one input item into the canonical node shape.
function toNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id ?? raw.label ?? '',
    label: raw.label ?? '',
    url: raw.url ?? null,
    active: !!raw.active,
    children: [],
  };
}

// Specificity score for a node URL against the current path:
//   0 → no match; 1 → prefix match; 2 → exact match. Longest URL wins ties.
function matchScore(url, currentPath) {
  if (!url || typeof currentPath !== 'string') return 0;
  const norm = (u) => (u.length > 1 && u.endsWith('/') ? u.slice(0, -1) : u);
  const urlN = norm(url);
  const curN = norm(currentPath);
  if (urlN === curN) return 2;
  if (urlN !== '' && urlN !== '/' && curN.startsWith(urlN + '/')) return 1;
  return 0;
}

// Mark the best-matching node (most specific wins; ties broken by the first
// in depth-first order) and every ancestor on the path to it as active.
function markActive(nodes, currentPath) {
  let best = null;
  let bestScore = -1;
  const walk = (list, chain) => {
    for (const node of list) {
      const score = matchScore(node.url, currentPath);
      if (score >= 1 && score >= bestScore) {
        bestScore = score;
        best = chain.concat(node);
      }
      walk(node.children, chain.concat(node));
    }
  };
  walk(nodes, []);
  if (!best) return false;
  for (const node of best) node.active = true;
  return true;
}

export function buildNavigation(items, { currentPath = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  // Already nested? (a node has a `children` array)
  const isNested = list.some((it) => it && Array.isArray(it.children));
  let tree;
  if (isNested) {
    // Normalise recursively — each item carries its own children inline.
    const build = (arr) =>
      (arr || [])
        .map((raw) => {
          const node = toNode(raw);
          if (!node) return null;
          node.children = build(raw.children);
          return node;
        })
        .filter(Boolean);
    tree = build(list);
  } else {
    // Flat list with optional `parent` references — two-pass build.
    const byId = new Map();
    const roots = [];
    for (const raw of list) {
      const node = toNode(raw);
      if (!node) continue;
      byId.set(node.id, node);
    }
    for (const raw of list) {
      const node = byId.get(raw.id ?? raw.label);
      if (!node) continue;
      const parentKey = raw.parent ?? null;
      const parent = parentKey != null ? byId.get(parentKey) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    tree = roots;
  }
  if (currentPath) markActive(tree, currentPath);
  return tree;
}

// Walk the tree and return the chain of nodes from root to the node whose
// URL matches `currentPath`. Empty array when nothing matches.
export function breadcrumbs(items, currentPath) {
  const tree = Array.isArray(items)
    ? items.some((it) => it && Array.isArray(it.children))
      ? buildNavigation(items) // nested — reuse the build path
      : buildNavigation(items)
    : [];
  let trail = [];
  let bestScore = -1;
  const walk = (nodes, chain) => {
    for (const node of nodes) {
      const score = matchScore(node.url, currentPath);
      if (score >= 1 && score >= bestScore) {
        bestScore = score;
        trail = chain.concat(node);
      }
      walk(node.children, chain.concat(node));
    }
  };
  walk(tree, []);
  // Only the last crumb is "current" — mark it, clear any ancestor flags
  // buildNavigation may have set on the way down.
  return trail.map((n, i) => ({
    id: n.id,
    label: n.label,
    url: n.url,
    active: i === trail.length - 1,
  }));
}

export default { buildNavigation, breadcrumbs };
