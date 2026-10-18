// edge/kernel/tests/router.test.mjs
import assert from 'node:assert/strict';
import { normalizeTable, routeKey, match, dispatch } from '../router.mjs';
import { html, json, redirect, notFound, text } from '../response.mjs';

const routes = [
  { uri: 'up', name: null, methods: ['GET', 'HEAD'], domain: null },
  { uri: '/', name: null, methods: ['GET', 'HEAD'], domain: null },
  { uri: 'dbcheck', name: null, methods: ['GET', 'HEAD'], domain: null },
  { uri: 'storage/{path}', name: 'storage.local', methods: ['GET', 'HEAD'], domain: null },
  { uri: 'storage/{path}', name: 'storage.local.upload', methods: ['PUT'], domain: null },
];

const table = normalizeTable(routes);

// basic: 5 routes normalized with leading slashes
assert.equal(table.length, 5);
assert.equal(table[0].uri, '/up');
assert.equal(table[3].uri, '/storage/{path}');

// routeKey
assert.equal(routeKey(table[0]), 'GET /up');

// HEAD matched by GET route
let m = match(table, { method: 'HEAD', path: '/up' });
assert.ok(m, 'HEAD /up should match');
assert.equal(m.route.name, null);

// trailing slash normalization
m = match(table, { method: 'GET', path: '/up/' });
assert.ok(m, 'trailing slash should normalize');
assert.equal(m.route.uri, '/up');

// query string stripped
m = match(table, { method: 'GET', path: '/dbcheck?foo=bar' });
assert.ok(m);
assert.equal(m.route.uri, '/dbcheck');

// param capture + decodeURIComponent
m = match(table, { method: 'GET', path: '/storage/hello%20world.txt' });
assert.ok(m);
assert.equal(m.params.path, 'hello world.txt');

// method distinction: PUT vs GET on same uri
m = match(table, { method: 'PUT', path: '/storage/x' });
assert.ok(m);
assert.equal(m.route.name, 'storage.local.upload');
m = match(table, { method: 'GET', path: '/storage/x' });
assert.ok(m);
assert.equal(m.route.name, 'storage.local');

// unknown path -> null
assert.equal(match(table, { method: 'GET', path: '/nope' }), null);

// unknown method -> null (DELETE not registered)
assert.equal(match(table, { method: 'DELETE', path: '/up' }), null);

// specificity / param: storage/{path} captures one segment only
m = match(table, { method: 'GET', path: '/storage/a/b' });
// {path} is one segment, so /storage/a/b should NOT match (b extra)
assert.equal(m, null, 'multi-segment should not match single {path}');

// dispatch: missing handler -> null
const handlers = {};
assert.equal(await dispatch({ method: 'GET', path: '/up' }, table, handlers), null);

// dispatch: with handler returns response
handlers['GET /up'] = (ctx) => html('hi ' + (ctx.params.x || ''), 200);
const r = await dispatch({ method: 'GET', path: '/up' }, table, handlers);
assert.deepEqual(r, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: 'hi ' });

// dispatch: unknown path -> null
assert.equal(await dispatch({ method: 'GET', path: '/nope' }, table, handlers), null);

// duplicate method+uri -> later wins
const dupTable = normalizeTable([
  { uri: '/x', name: 'first', methods: ['GET'], domain: null },
  { uri: '/x', name: 'second', methods: ['GET'], domain: null },
]);
assert.equal(dupTable.length, 1);
assert.equal(dupTable[0].name, 'second');

// root path
m = match(table, { method: 'GET', path: '/' });
assert.ok(m);
assert.equal(m.route.uri, '/');

// response helpers
assert.deepEqual(html('a'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: 'a' });
assert.deepEqual(json({ b: 1 }), { status: 200, headers: { 'content-type': 'application/json' }, body: '{"b":1}' });
assert.deepEqual(redirect('/x'), { status: 302, headers: { location: '/x' }, body: '' });
assert.deepEqual(notFound(), { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not Found' });
assert.deepEqual(text('t', 201), { status: 201, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 't' });

// header names lowercased by dispatch
handlers['GET /dbcheck'] = () => ({ status: 200, headers: { 'X-Foo': 'bar' }, body: 'ok' });
const r2 = await dispatch({ method: 'GET', path: '/dbcheck' }, table, handlers);
assert.equal(r2.headers['x-foo'], 'bar');

// wildcard {path*} captures multiple segments
const wtable = normalizeTable([{ uri: '/files/{path*}', name: 'files', methods: ['GET'], domain: null }]);
m = match(wtable, { method: 'GET', path: '/files/a/b/c.txt' });
assert.ok(m, 'wildcard should match multi-segment');
assert.equal(m.params.path, 'a/b/c.txt');

// wildcard must be the last segment
assert.throws(
  () => match(normalizeTable([{ uri: '/{a*}/x', name: null, methods: ['GET'], domain: null }]), { method: 'GET', path: '/a/x' }),
  /must be the last segment/,
);

// domain enforcement + domain param capture
const dtable = normalizeTable([
  { uri: '/', name: 'root', methods: ['GET'], domain: null },
  { uri: '/admin', name: 'admin', methods: ['GET'], domain: 'admin.example.com' },
  { uri: '/tenant', name: 'tenant', methods: ['GET'], domain: '{sub}.example.com' },
]);
m = match(dtable, { method: 'GET', path: '/admin', host: 'admin.example.com' });
assert.ok(m);
assert.equal(m.route.name, 'admin');
assert.equal(match(dtable, { method: 'GET', path: '/admin', host: 'www.example.com' }), null, 'wrong host must not match');
assert.equal(match(dtable, { method: 'GET', path: '/admin' }), null, 'missing host must not match domain route');
m = match(dtable, { method: 'GET', path: '/tenant', host: 'acme.example.com' });
assert.ok(m);
assert.equal(m.params.sub, 'acme');
m = match(dtable, { method: 'GET', path: '/admin', host: 'admin.example.com:8787' });
assert.ok(m, 'port must be stripped from host');

// method override (POST + header -> PUT)
const mtable = normalizeTable([{ uri: '/things/1', name: 'update', methods: ['PUT'], domain: null }]);
m = match(mtable, { method: 'POST', path: '/things/1', headers: { 'x-http-method-override': 'PUT' } });
assert.ok(m, 'POST + override header should match PUT route');
assert.equal(m.route.name, 'update');
assert.equal(match(mtable, { method: 'DELETE', path: '/things/1', headers: { 'x-http-method-override': 'PUT' } }), null, 'override ignored for non-POST');
m = match(mtable, { method: 'GET', path: '/things/1', methodOverride: 'PUT' });
assert.ok(m, 'explicit methodOverride should work');

// dispatch exposes effective method after override
handlers['PUT /things/1'] = (ctx) => text(ctx.request.method);
const r3 = await dispatch({ method: 'POST', path: '/things/1', headers: { 'x-http-method-override': 'PUT' } }, mtable, handlers);
assert.ok(r3);
assert.equal(r3.body, 'PUT');

console.log('ROUTER TESTS: PASS');
