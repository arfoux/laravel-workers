// Regression: a snapshot's root URL is bare (`http://localhost`, no path), and
// it used to survive the rewrite because the pattern required a trailing slash.
// Deployed that way, "back to the map" opened http://localhost/ on the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relativizeSnapshotUrls } from '../snapshot-urls.mjs';

const app = 'https://nearfind.example.workers.dev';

test('bare localhost root becomes /', () => {
  const { html, fixed } = relativizeSnapshotUrls('<a href="http://localhost">x</a>');
  assert.equal(html, '<a href="/">x</a>');
  assert.equal(fixed, 1);
});

test('localhost root with a path keeps exactly one slash', () => {
  assert.equal(relativizeSnapshotUrls('<a href="http://localhost/masuk">x</a>').html, '<a href="/masuk">x</a>');
  assert.equal(relativizeSnapshotUrls('<a href="http://localhost:8000/masuk">x</a>').html, '<a href="/masuk">x</a>');
  assert.equal(relativizeSnapshotUrls('<a href="https://127.0.0.1:8000/profil">x</a>').html, '<a href="/profil">x</a>');
});

test('the app origin is relativized too, bare and with a path', () => {
  assert.equal(relativizeSnapshotUrls(`<a href="${app}">x</a>`, app).html, '<a href="/">x</a>');
  assert.equal(relativizeSnapshotUrls(`<a href="${app}/masuk">x</a>`, app).html, '<a href="/masuk">x</a>');
});

test('protocol-relative and quoted forms', () => {
  assert.equal(relativizeSnapshotUrls("url('//localhost')").html, "url('/')");
  assert.equal(relativizeSnapshotUrls('<link href=http://localhost>').html, '<link href=/>');
});

test('external origins are untouched', () => {
  const html = '<a href="https://laravel.com/docs">x</a><img src="https://fonts.example/a.woff2">';
  const res = relativizeSnapshotUrls(html, app);
  assert.equal(res.html, html);
  assert.equal(res.fixed, 0);
});

test('a bare origin only matches at a boundary, not a prefix', () => {
  const html = '<p>http://localhostfoo</p>';
  assert.equal(relativizeSnapshotUrls(html).html, html);
});

test('JSON-escaped slashes (json_encode wants \\/) are relativized too', () => {
  // json_encode()/Js::from() write `http:\/\/localhost\/masuk`; the plain
  // pattern never saw it, so the blob shipped a localhost URL.
  const html = '{"u":"http:\\/\\/localhost\\/masuk"}';
  assert.equal(relativizeSnapshotUrls(html).html, '{"u":"\\/masuk"}');
  assert.equal(relativizeSnapshotUrls('"http:\\/\\/localhost"').html, '"\\/"');
});

test('an origin authored in caps still resolves to the same host', () => {
  assert.equal(relativizeSnapshotUrls('HTTP://LOCALHOST/x').html, '/x');
  assert.equal(relativizeSnapshotUrls('<a href="HTTP://localhost">x</a>').html, '<a href="/">x</a>');
});
