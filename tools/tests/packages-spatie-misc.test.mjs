// tools/tests/packages-spatie-misc.test.mjs — kernel tests for the Spatie
// misc-A cluster: Menu, buildNavigation/breadcrumbs, HtmlElement/html,
// buildOptions/toValidationRule. No D1, no ports — pure serialisation logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Menu } from '../../kernel/packages/menu.mjs';
import { buildNavigation, breadcrumbs } from '../../kernel/packages/navigation.mjs';
import { HtmlElement, html } from '../../kernel/packages/html.mjs';
import { buildOptions, toValidationRule } from '../../kernel/packages/options.mjs';

// ---------------------------------------------------------------------------
// 1. Menu.toHtml — structure, active state, dividers, escaping
// ---------------------------------------------------------------------------

test('menu: empty menu renders empty string', () => {
  assert.equal(new Menu().toHtml(), '');
});

test('menu: renders li/a for each item with the default ul class', () => {
  const out = new Menu()
    .item('Home', '/')
    .item('About', '/about')
    .toHtml();
  assert.match(out, /^<ul class="menu">/);
  assert.match(out, /<li class="menu-item"><a href="\/">Home<\/a><\/li>/);
  assert.match(out, /<li class="menu-item"><a href="\/about">About<\/a><\/li>/);
  assert.match(out, /<\/ul>$/);
});

test('menu: active item gets the `active` class', () => {
  const out = new Menu()
    .item('Home', '/')
    .item('Profile', '/profile', { active: true })
    .toHtml();
  assert.match(out, /<li class="menu-item active"><a href="\/profile">/);
  // The other one is NOT active
  assert.match(out, /<li class="menu-item"><a href="\/">/);
});

test('menu: setActiveFromPath marks the exact match and clears the rest', () => {
  const menu = new Menu().item('Home', '/').item('Profile', '/profile');
  menu.setActiveFromPath('/profile');
  const out = menu.toHtml();
  assert.match(out, /<li class="menu-item active"><a href="\/profile">/);
  assert.match(out, /<li class="menu-item"><a href="\/">/);
});

test('menu: setActiveFromPath supports prefix match on segment boundaries', () => {
  const menu = new Menu()
    .item('Admin', '/admin')
    .item('Admin users', '/admin/users');
  menu.setActiveFromPath('/admin/users/42');
  const out = menu.toHtml();
  // longest URL wins
  assert.match(out, /<li class="menu-item active"><a href="\/admin\/users">/);
  assert.match(out, /<li class="menu-item"><a href="\/admin">/);
});

test('menu: setActiveFromPath does not match partial segments', () => {
  const menu = new Menu().item('Search', '/search');
  menu.setActiveFromPath('/searchx'); // should NOT activate /search
  assert.doesNotMatch(menu.toHtml(), /active/);
});

test('menu: divider renders as a non-link li', () => {
  const out = new Menu().item('A', '/a').divider().item('B', '/b').toHtml();
  assert.match(out, /<li class="divider"><\/li>/);
  assert.doesNotMatch(out, /<li class="menu-item active">/);
});

test('menu: labels and attribute values are HTML-escaped', () => {
  const out = new Menu().item('<b>Me & You</b>', '/x?a=1&b=2').toHtml();
  assert.match(out, /&lt;b&gt;Me &amp; You&lt;\/b&gt;/);
  assert.match(out, /href="\/x\?a=1&amp;b=2"/);
});

// ---------------------------------------------------------------------------
// 2. buildNavigation + breadcrumbs
// ---------------------------------------------------------------------------

const FLAT_ITEMS = [
  { id: 'home', label: 'Home', url: '/' },
  { id: 'admin', label: 'Admin', url: '/admin' },
  { id: 'users', label: 'Users', url: '/admin/users', parent: 'admin' },
  { id: 'roles', label: 'Roles', url: '/admin/roles', parent: 'admin' },
];

test('navigation: flat list with parent refs builds a nested tree', () => {
  const tree = buildNavigation(FLAT_ITEMS);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].id, 'home');
  assert.equal(tree[1].id, 'admin');
  assert.equal(tree[1].children.length, 2);
  assert.deepEqual(
    tree[1].children.map((c) => c.id),
    ['users', 'roles']
  );
  // canonical node shape
  for (const node of tree) {
    assert.ok(Array.isArray(node.children));
    assert.equal(typeof node.active, 'boolean');
  }
});

test('navigation: currentPath marks the matched node and its ancestors active', () => {
  const tree = buildNavigation(FLAT_ITEMS, { currentPath: '/admin/users/42' });
  const admin = tree.find((n) => n.id === 'admin');
  const users = admin.children.find((c) => c.id === 'users');
  assert.equal(admin.active, true);
  assert.equal(users.active, true);
  assert.equal(tree.find((n) => n.id === 'home').active, false);
  assert.equal(admin.children.find((c) => c.id === 'roles').active, false);
});

test('navigation: no currentPath → no node is active', () => {
  const tree = buildNavigation(FLAT_ITEMS);
  const flat = [];
  const walk = (ns) => ns.forEach((n) => { flat.push(n); walk(n.children); });
  walk(tree);
  assert.ok(flat.every((n) => n.active === false));
});

test('breadcrumbs: returns the chain root→current, active only on the last', () => {
  const crumbs = breadcrumbs(FLAT_ITEMS, '/admin/users');
  assert.deepEqual(
    crumbs.map((c) => c.id),
    ['admin', 'users']
  );
  assert.equal(crumbs[0].active, false);
  assert.equal(crumbs[1].active, true);
});

test('breadcrumbs: a top-level match returns a single active crumb', () => {
  const crumbs = breadcrumbs(FLAT_ITEMS, '/');
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0].id, 'home');
  assert.equal(crumbs[0].active, true);
});

test('breadcrumbs: no match returns an empty array', () => {
  assert.deepEqual(breadcrumbs(FLAT_ITEMS, '/nope'), []);
});

// ---------------------------------------------------------------------------
// 3. HtmlElement / html — render, class merging, children, escaping
// ---------------------------------------------------------------------------

test('html: span renders with attrs and text', () => {
  const el = html('span', { class: 'badge' }).text('Hi');
  assert.equal(el.render(), '<span class="badge">Hi</span>');
});

test('html: div nests children and escapes text', () => {
  const out = html('div', { class: 'wrap' })
    .text('a & b < c')
    .append(html('span').text('inner'))
    .render();
  assert.equal(out, '<div class="wrap">a &amp; b &lt; c<span>inner</span></div>');
});

test('html: input is void — no closing tag', () => {
  const out = html('input', { type: 'email', name: 'email' }).class('form-control').render();
  assert.equal(out, '<input type="email" name="email" class="form-control">');
});

test('html: class() merges, does not clobber, and dedupes within a call', () => {
  const el = html('p', { class: 'mb-2' }).class('mb-2', 'text-lg');
  assert.equal(el.render(), '<p class="mb-2 text-lg"></p>');
});

test('html: select + option composition', () => {
  const select = html('select', { name: 'status' });
  for (const [label, value] of [['Draft', 0], ['Live', 1]]) {
    select.append(html('option', { value }).text(label));
  }
  const out = select.render();
  assert.equal(out, '<select name="status"><option value="0">Draft</option><option value="1">Live</option></select>');
});

test('html: a and img render correctly (img is void)', () => {
  assert.equal(html('a', { href: '/x' }).text('go').render(), '<a href="/x">go</a>');
  assert.equal(html('img', { src: '/a.png', alt: 'A' }).render(), '<img src="/a.png" alt="A">');
});

test('html: unsupported tag throws', () => {
  assert.throws(() => html('script'), /unsupported tag/);
});

test('html: HtmlElement is exported and behaves like html()', () => {
  const el = new HtmlElement('button', { type: 'submit' }).text('Send');
  assert.equal(el.tag, 'button');
  assert.equal(el.render(), '<button type="submit">Send</button>');
});

// ---------------------------------------------------------------------------
// 4. buildOptions + toValidationRule
// ---------------------------------------------------------------------------

test('options: forArray of scalars uses the value as its own label', () => {
  const opts = buildOptions({ forArray: ['red', 'green'] });
  assert.deepEqual(opts, [
    { label: 'red', value: 'red' },
    { label: 'green', value: 'green' },
  ]);
});

test('options: nullable prepends a blank entry at the front', () => {
  const opts = buildOptions({ forArray: ['a', 'b'], nullable: true });
  assert.equal(opts[0].label, '');
  assert.equal(opts[0].value, '');
  assert.equal(opts.length, 3);
});

test('options: forEnum maps entries to {label,value}', () => {
  const opts = buildOptions({ forEnum: { Draft: 0, Live: 1 } });
  assert.deepEqual(opts, [
    { label: 'Draft', value: 0 },
    { label: 'Live', value: 1 },
  ]);
});

test('options: sort=label reorders the non-nullable entries only', () => {
  const opts = buildOptions({ forArray: ['c', 'a', 'b'], nullable: true, sort: 'label' });
  assert.deepEqual(opts.map((o) => o.value), ['', 'a', 'b', 'c']);
});

test('toValidationRule: serialises values into an in: rule', () => {
  const opts = buildOptions({ forEnum: { Draft: 0, Live: 1, Archived: 2 } });
  assert.equal(toValidationRule(opts), 'in:0,1,2');
});

test('toValidationRule: includes the nullable blank value when present', () => {
  const opts = buildOptions({ forArray: ['a'], nullable: true });
  // The nullable blank is the empty string — still a legal in: entry.
  assert.equal(toValidationRule(opts), 'in:,a');
});

test('toValidationRule: empty list → empty rule', () => {
  assert.equal(toValidationRule([]), '');
  assert.equal(toValidationRule(buildOptions({})), '');
});
