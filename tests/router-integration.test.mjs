import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const genUrl = pathToFileURL(path.resolve(root, 'edge/dist/src/routes.generated.mjs')).href;
const routerUrl = pathToFileURL(path.resolve(root, 'edge/kernel/router.mjs')).href;

const { routeTable, handlers } = await import(genUrl);
const { normalizeTable, dispatch } = await import(routerUrl);

const table = normalizeTable(routeTable);

const env = {
  DB: {
    prepare(sql) {
      if (sql.includes('sqlite_master')) {
        return { all: async () => ({ results: [{ name: '_cf_KV' }, { name: 'config' }] }) };
      }
      return { first: async () => ({ n: 0 }) };
    },
  },
};

const db = await dispatch({ method: 'GET', path: '/dbcheck' }, table, handlers, env);
assert.ok(db, 'dbcheck should match');
assert.equal(db.status, 200);
const dbJson = JSON.parse(db.body);
assert.equal(dbJson.driver, 'd1-binding');
assert.ok(Array.isArray(dbJson.tables));
assert.equal(typeof dbJson.config_rows, 'number');

const home = await dispatch({ method: 'GET', path: '/' }, table, handlers, env);
assert.ok(home, 'home should match');
assert.equal(home.status, 200);
assert.match(home.body, /<title>nearFind<\/title>/);

assert.equal(await dispatch({ method: 'GET', path: '/nope' }, table, handlers, env), null);

console.log('router-integration: PASS');
