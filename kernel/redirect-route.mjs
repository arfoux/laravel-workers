// kernel/redirect-route.mjs — Route::redirect() / Route::permanentRedirect().
//
// A redirect route is not a controller on the edge: the route table records the
// destination and the status, and this module answers the response. It is a
// transcription of the two PHP classes that answer it:
//
//   Illuminate\Routing\RedirectController::__invoke()  — builds the target URL
//   Symfony\Component\HttpFoundation\RedirectResponse  — the status, the
//                                                        headers and the HTML body
//
// Byte parity is the whole point, and the framework's URL building is not
// `encodeURIComponent`:
//
//   * the destination's OWN path variables are the only ones substituted (a
//     parameter the destination does not name is NOT appended as a query string:
//     RedirectController passes `only($destination->getPathVariables())`);
//   * a missing variable leaves its `{name}` in place and throws
//     UrlGenerationException (the app answers 500);
//   * every value goes through encodeParameter() — only `%`, `?` and `#` are
//     escaped there — and then the WHOLE url through
//     `strtr(rawurlencode($uri), $dontEncode)`, so `+`, `@`, `:`, `;`, `,`, `=`,
//     `!`, `*`, `|`, `?`, `&`, `#`, `%` and `/` end up literal while `(`, `)`,
//     `'`, `~`-as-byte and a space stay percent-encoded;
//   * the generated URL is RELATIVE (`toRoute(..., $absolute = false)`): the
//     root is stripped back off, and a destination that does not start with `/`
//     loses the leading `/` again (RedirectController's own `Str::after`).
//
// The response body and the content type are Symfony's (`setTargetUrl()`), and
// a 301 carries NO cache-control header (RedirectResponse removes the default).

import { HttpError, symfonyRedirectBody } from './http.mjs';

// Symfony's RedirectResponse::$dontEncode (RouteUrlGenerator::$dontEncode).
// strtr() is a single pass with the longest key winning, so one regex
// alternation is equivalent.
const DONT_ENCODE = {
  '%2F': '/',
  '%40': '@',
  '%3A': ':',
  '%3B': ';',
  '%2C': ',',
  '%3D': '=',
  '%2B': '+',
  '%21': '!',
  '%2A': '*',
  '%7C': '|',
  '%3F': '?',
  '%26': '&',
  '%23': '#',
  '%25': '%',
};

const DONT_ENCODE_RE = new RegExp(Object.keys(DONT_ENCODE).join('|'), 'g');

// PHP's rawurlencode(): RFC 3986 unreserved is ALPHA / DIGIT / `-` / `.` / `_` /
// `~`. encodeURIComponent() leaves five more characters alone — `!`, `*`, `'`,
// `(` and `)` — and PHP encodes those.
function phpRawurlencode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// PHP's strtr($s, $table): one pass, no re-scan of a replacement.
function strtr(value, table, re) {
  return String(value).replace(re, (m) => table[m]);
}

// PHP's trim($s, '/') — every leading and trailing slash goes.
function trimSlashes(value) {
  return String(value).replace(/^\/+|\/+$/g, '');
}

// RouteUrlGenerator::encodeParameter(): only `%`, `?` and `#` are escaped (the
// rest of the value is encoded later, for the whole URL).
function encodeParameter(value) {
  return String(value).replace(/[%?#]/g, (c) => ({ '%': '%25', '?': '%3F', '#': '%23' })[c]);
}

// Symfony's RouteCompiler::tokenize() name handling: `{name}` and `{name?}`,
// with `?` trimmed off both ends, in the order the pattern declares them.
function pathVariables(destination) {
  const out = [];
  for (const m of String(destination).matchAll(/\{([^{}]*)\}/g)) {
    const name = m[1].replace(/^\?+|\?+$/g, '');
    if (name === '') continue;
    if (out.includes(name)) {
      // Symfony's RouteCompiler refuses a pattern that names a variable twice
      // (LogicException at compile time). A bootable app never gets here.
      throw new HttpError(
        `Route pattern "${destination}" cannot reference variable name "${name}" more than once.`,
        500
      );
    }
    out.push(name);
  }
  return out;
}

// Laravel's UrlGenerationException — the app answers 500, and the framework's
// own message names the route and the missing parameter.
class UrlGenerationException extends HttpError {
  constructor(uri, missing) {
    super(
      `Missing required parameter for [Route: laravel_route_redirect_destination] [URI: ${uri}] ` +
        `[Missing parameter: ${missing}].`,
      500
    );
    this.name = 'UrlGenerationException';
  }
}

// RouteUrlGenerator::replaceRouteParameters() + replaceNamedParameters() +
// the trailing `/\{.*?\?\}/` strip, for the named (associative) parameters
// RedirectController hands over.
function replaceRouteParameters(path, parameters) {
  const out = String(path).replace(/\{(.*?)(\?)?\}/g, (full, name) => {
    const has = Object.prototype.hasOwnProperty.call(parameters, name);
    const value = has ? parameters[name] : undefined;
    // isset($parameters[$name]) is false for null, and Laravel 13 also leaves an
    // EMPTY string unsubstituted (it is consumed either way).
    if (has && value !== null && value !== undefined && value !== '') {
      delete parameters[name];
      return encodeParameter(value);
    }
    if (has) delete parameters[name];
    return full;
  });
  return trimSlashes(out.replace(/\{.*?\?\}/g, ''));
}

/**
 * The response for a redirect route.
 *
 * @param {object} request   the kernel request (for the scheme + host)
 * @param {object} params    the matched route's parameters
 * @param {string} destination the recorded destination (a path template)
 * @param {number} status    the recorded status (302, or 301 for permanentRedirect)
 */
export function redirectRouteResponse(request, params, destination, status) {
  const source = params && typeof params === 'object' ? params : {};
  const dest = String(destination);

  // RedirectController: `$parameters->only($route->getCompiled()->getPathVariables())`
  const only = {};
  for (const name of pathVariables(dest)) {
    if (Object.prototype.hasOwnProperty.call(source, name)) only[name] = source[name];
  }

  const path = replaceRouteParameters(dest, only);

  // UrlGenerator::format($root, $path): the request root, then the path.
  const root = String(request.schemeAndHttpHost());
  const formatted = trimSlashes(root + '/' + trimSlashes(path));

  // RouteUrlGenerator::to(): a `{...}` left in the URL is a missing parameter.
  const leftover = formatted.match(/\{(.*?)\}/);
  if (leftover) throw new UrlGenerationException(dest, leftover[1]);

  const encoded = strtr(phpRawurlencode(formatted), DONT_ENCODE, DONT_ENCODE_RE);

  // `! $absolute`: strip the root, then `'/'.ltrim($uri, '/')`.
  let uri = '/' + String(encoded).replace(/^(?:\/\/|[^/?])+/, '').replace(/^\/+/, '');

  // RedirectController: `if (! str_starts_with($destination, '/') && str_starts_with($url, '/'))`
  // the URL is used after the URL's first slash.
  if (!dest.startsWith('/') && uri.startsWith('/')) uri = uri.slice(uri.indexOf('/') + 1);

  return {
    status: Number(status) || 302,
    headers: {
      location: uri,
      'content-type': 'text/html; charset=utf-8',
    },
    body: symfonyRedirectBody(uri),
  };
}

export default { redirectRouteResponse };
