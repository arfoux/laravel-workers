// kernel/tests/redirect-route.test.mjs — direct coverage of Route::redirect() /
// Route::permanentRedirect(): Laravel's URL building plus Symfony's response.
// The expected locations below are the framework's encodeParameter() +
// rawurlencode() + strtr() result, not a re-pinning of the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redirectRouteResponse } from '../redirect-route.mjs';

const request = { schemeAndHttpHost: () => 'https://example.test' };

test('redirect-route encodes a space as %20 (PHP rawurlencode, not encodeURIComponent)', () => {
  const res = redirectRouteResponse(request, { slug: 'a b' }, '/go/{slug}', 302);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/go/a%20b');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(res.body, /<meta http-equiv="refresh" content="0;url='\/go\/a%20b'" \/>/);
  assert.match(res.body, /Redirecting to <a href="\/go\/a%20b">\/go\/a%20b<\/a>\./);
});

test('redirect-route leaves + literal and double-escapes a supplied %', () => {
  // encodeParameter escapes '%' before the whole URL is rawurlencoded, so a
  // caller-supplied %2F survives as the literal characters "%2F".
  assert.equal(
    redirectRouteResponse(request, { slug: 'a+b' }, '/go/{slug}', 302).headers.location,
    '/go/a+b'
  );
  assert.equal(
    redirectRouteResponse(request, { slug: 'a%2Fb' }, '/go/{slug}', 302).headers.location,
    '/go/a%252Fb'
  );
});

test('redirect-route substitutes only destination variables (no query append)', () => {
  const res = redirectRouteResponse(request, { id: 7, extra: 'zzz' }, '/target/{id}', 302);
  assert.equal(res.headers.location, '/target/7');
  assert.equal(res.headers.location.includes('extra'), false);
});

test('redirect-route throws a 500 UrlGenerationException for a missing parameter', () => {
  assert.throws(
    () => redirectRouteResponse(request, {}, '/go/{slug}', 302),
    (err) => {
      assert.equal(err.name, 'UrlGenerationException');
      assert.equal(err.status, 500);
      assert.match(err.message, /Missing required parameter/);
      assert.match(err.message, /\[URI: \/go\/\{slug\}\]/);
      assert.match(err.message, /\[Missing parameter: slug\]/);
      return true;
    }
  );
});

test('redirect-route fills an optional placeholder and strips an unfilled one', () => {
  assert.equal(
    redirectRouteResponse(request, { slug: 'v' }, '/go/{slug?}', 301).headers.location,
    '/go/v'
  );
  assert.equal(redirectRouteResponse(request, {}, '/go/{slug?}', 301).headers.location, '/go');
});

test('redirect-route 301 carries no cache-control header; status falls back to 302', () => {
  for (const [status, expected] of [
    [301, 301],
    [302, 302],
    [303, 303],
    [0, 302],
    [undefined, 302],
  ]) {
    const res = redirectRouteResponse(request, {}, '/x', status);
    assert.equal(res.status, expected, `status ${status}`);
    assert.deepEqual(Object.keys(res.headers).sort(), ['content-type', 'location']);
    assert.equal(Object.prototype.hasOwnProperty.call(res.headers, 'cache-control'), false);
  }
});

test('redirect-route builds a relative URL (the request root is stripped)', () => {
  // toRoute(..., false): a destination without a leading slash loses it again.
  assert.equal(
    redirectRouteResponse(request, { slug: 'x y' }, 'go/{slug}', 302).headers.location,
    'go/x%20y'
  );
});
