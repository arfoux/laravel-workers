// kernel/packages/menu.mjs — server-side menu builder (Spatie Laravel Menu
// parity, simplified). No D1, no I/O: pure construction + HTML serialisation.
//
// Usage:
//   const menu = new Menu()
//     .item('Home', '/', { active: path === '/' })
//     .divider()
//     .item('Profile', '/profile');
//   menu.setActiveFromPath('/profile');       // marks the exact/prefix match
//   const html = menu.toHtml();               // <ul class="menu">…</ul>
//
// Active items get the `active` class (configurable via the constructor).
// `setActiveFromPath` marks an item active when the current path equals the
// item URL exactly, or when the item URL is a real prefix (`/admin` matches
// `/admin/users` but `/ad` never matches `/admin`). Longest URL wins when
// several items qualify, so `/admin/users` beats `/admin`.

// The escape rule is `e()` (kernel/str.mjs); the attribute bag serialiser is
// shared with the html builder (kernel/packages/html.mjs). The menu adds only
// its own markup on top.
import { escapeHtml } from '../str.mjs';
import { serializeAttrs } from './html.mjs';

const DEFAULT_ACTIVE_CLASS = 'active';
const DEFAULT_UL_CLASS = 'menu';

export class Menu {
  constructor({ activeClass = DEFAULT_ACTIVE_CLASS, ulClass = DEFAULT_UL_CLASS } = {}) {
    this.activeClass = activeClass;
    this.ulClass = ulClass;
    this.items = []; // { kind: 'item'|'divider', label?, url?, active? }
  }

  // Add a link item. `opts` may carry `{ active }` or arbitrary extra attrs.
  item(label, url, opts = {}) {
    this.items.push({ kind: 'item', label, url, active: !!opts.active, attrs: opts.attrs || null });
    return this;
  }

  // A non-interactive separator rendered as <li class="divider"></li>.
  divider() {
    this.items.push({ kind: 'divider' });
    return this;
  }

  // Clear the `active` flag, then set it on the best-matching item for `path`.
  // Exact match beats prefix match; among prefixes the longest URL wins.
  setActiveFromPath(path) {
    for (const it of this.items) it.active = false;
    if (typeof path !== 'string' || path === '') return this;
    const norm = (u) => (u.length > 1 && u.endsWith('/') ? u.slice(0, -1) : u);
    const current = norm(path);
    let best = null;
    let bestLen = -1;
    for (const it of this.items) {
      if (it.kind !== 'item' || !it.url) continue;
      const url = norm(it.url);
      if (url === current) {
        it.active = true;
        return this; // exact match — nothing can beat it
      }
      if (current.startsWith(url + '/') && url.length > bestLen) {
        best = it;
        bestLen = url.length;
      }
    }
    if (best) best.active = true;
    return this;
  }

  // Serialise to an HTML string. Returns '' when the menu is empty.
  toHtml() {
    if (this.items.length === 0) return '';
    const parts = [`<ul class="${escapeHtml(this.ulClass)}">`];
    for (const it of this.items) {
      if (it.kind === 'divider') {
        parts.push('<li class="divider"></li>');
        continue;
      }
      const classes = ['menu-item'];
      if (it.active) classes.push(this.activeClass);
      const extra = it.attrs ? serializeAttrs(it.attrs) : '';
      const url = escapeHtml(it.url ?? '#');
      const label = escapeHtml(it.label ?? '');
      parts.push(
        `<li class="${escapeHtml(classes.join(' '))}"><a href="${url}"${extra}>${label}</a></li>`
      );
    }
    parts.push('</ul>');
    return parts.join('');
  }
}

export default Menu;
