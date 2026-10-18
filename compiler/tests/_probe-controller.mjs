// temp probe — dump emitted controller code
import fs from 'node:fs';
import { emitController } from '../src/controller.mjs';

const testSrc = fs.readFileSync(new URL('./controller.test.mjs', import.meta.url), 'utf8');
const SAMPLE = testSrc.match(/const SAMPLE = `([\s\S]*?)`;/)[1];

const meta = {
  routeUri: '/posts',
  routeParams: [],
  models: [{ alias: 'Post', fqcn: 'App\\Models\\Post' }],
  views: ['posts.index', 'posts.show'],
};

const r1 = emitController(SAMPLE, 'index', meta);
console.log('== index ==');
console.log(r1.code ?? JSON.stringify(r1.errors, null, 2));
const r2 = emitController(SAMPLE, 'home', { ...meta, routeUri: '/', routeParams: [], views: [] });
console.log('== home ==');
console.log(r2.code ?? JSON.stringify(r2.errors, null, 2));
const r3 = emitController(SAMPLE, 'bounce', { ...meta, routeUri: '/b', routeParams: [], views: [] });
console.log('== bounce ==');
console.log(r3.code ?? JSON.stringify(r3.errors, null, 2));
