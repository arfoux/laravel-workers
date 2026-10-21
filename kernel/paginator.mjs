// kernel/paginator.mjs — the LengthAwarePaginator (Illuminate\Pagination)
//
// The compiled side answers the same numbers as the real Laravel: the items,
// the total, the pages, the URLs (the query string) and the URL window (the
// `elements` the pagination view renders). The port is a line-by-line port of
// Illuminate\Pagination\LengthAwarePaginator + Illuminate\Pagination\UrlWindow.
//
// The `links()` (the pagination view) is NOT here: the view is a Blade file
// (the framework's `pagination::tailwind`), and the build compiles it like any
// other view. Until it is compiled, `links()` fails loud — a hand-written
// markup would be a *different* answer, not a faster one.

// PHP's http_build_query($a, '', '&', PHP_QUERY_RFC3986): the unreserved
// characters are A-Za-z0-9-_.~ and everything else is percent-encoded (the
// space is %20, not +).
const phpUrlEncode = (value) =>
  encodeURIComponent(value === null || value === undefined ? '' : String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

// PHP's array_filter() without a callback: the falsy values are dropped
// (null, false, 0, '', and an empty array).
const phpTruthy = (v) => {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
};

const isArrayLike = (v) => Array.isArray(v) || (v !== null && typeof v === 'object');

export class LengthAwarePaginator {
  constructor(items, total, perPage, currentPage, options = {}) {
    const opts = options || {};
    this.__items = Array.isArray(items) ? items.slice() : [];
    this.__total = Number(total) || 0;
    this.__perPage = Number(perPage) || 0;
    this.__lastPage = Math.max(Math.ceil(this.__total / Math.max(this.__perPage, 1)), 1);
    this.__path = opts.path === undefined || opts.path === null ? '/' : String(opts.path);
    // The constructor: rtrim($path, '/') — but '/' stays '/'.
    if (this.__path !== '/') this.__path = this.__path.replace(/\/+$/, '');
    this.__query = opts.query && typeof opts.query === 'object' ? { ...opts.query } : {};
    this.__fragment = opts.fragment ? String(opts.fragment) : '';
    this.__pageName = opts.pageName ? String(opts.pageName) : 'page';
    this.__onEachSide = opts.onEachSide === undefined ? 3 : Number(opts.onEachSide);
    // setCurrentPage(): a valid page number, else 1.
    const p = Number(currentPage);
    this.__currentPage = Number.isInteger(p) && p >= 1 ? p : 1;
  }

  // ---- the data ----------------------------------------------------------
  items() {
    return this.__items.slice();
  }
  getCollection() {
    return this.__items.slice();
  }
  count() {
    return this.__items.length;
  }
  isEmpty() {
    return this.__items.length === 0;
  }
  isNotEmpty() {
    return this.__items.length !== 0;
  }
  total() {
    return this.__total;
  }
  perPage() {
    return this.__perPage;
  }
  currentPage() {
    return this.__currentPage;
  }
  lastPage() {
    return this.__lastPage;
  }
  getPageName() {
    return this.__pageName;
  }
  onEachSide(count) {
    // Laravel has both: the public property `onEachSide` and the setter
    // method `onEachSide($count)`. JS has one name for both.
    if (count === undefined || count === null) return this.__onEachSide;
    this.__onEachSide = Number(count);
    return this;
  }
  firstItem() {
    return this.count() > 0 ? (this.__currentPage - 1) * this.__perPage + 1 : null;
  }
  lastItem() {
    return this.count() > 0 ? this.firstItem() + this.count() - 1 : null;
  }

  // ---- the pages ---------------------------------------------------------
  hasPages() {
    return this.__currentPage !== 1 || this.hasMorePages();
  }
  hasMorePages() {
    return this.__currentPage < this.__lastPage;
  }
  onFirstPage() {
    return this.__currentPage <= 1;
  }
  onLastPage() {
    return this.__currentPage >= this.__lastPage;
  }

  // ---- the URLs ----------------------------------------------------------
  path() {
    return this.__path;
  }
  query() {
    return { ...this.__query };
  }
  fragment(fragment) {
    if (fragment === undefined || fragment === null) return this.__fragment;
    this.__fragment = String(fragment);
    return this;
  }
  appends(key, value) {
    if (key === undefined || key === null) return this;
    if (typeof key === 'object' && !Array.isArray(key)) {
      for (const [k, v] of Object.entries(key)) this.__query[k] = v;
      return this;
    }
    this.__query[key] = value;
    return this;
  }
  withQueryString() {
    // The request's query string (Laravel's queryStringResolver).
    if (this.__requestQuery && typeof this.__requestQuery === 'object') {
      for (const [k, v] of Object.entries(this.__requestQuery)) this.__query[k] = v;
    }
    return this;
  }
  url(page) {
    let p = Number(page);
    if (!(p > 0)) p = 1;
    // array_merge($this->query, [$this->pageName => $page]) — the query's keys
    // come first; the page name overwrites the query's value in place.
    const parameters = { ...this.__query };
    parameters[this.__pageName] = p;
    const query = Object.keys(parameters)
      .filter((k) => parameters[k] !== null && parameters[k] !== undefined)
      .map((k) => `${phpUrlEncode(k)}=${phpUrlEncode(parameters[k])}`)
      .join('&');
    return (
      this.__path +
      (this.__path.includes('?') ? '&' : '?') +
      query +
      // Laravel's buildFragment() (AbstractPaginator.php:290-293):
      // `return $this->fragment ? '#'.$this->fragment : '';` - the caller
      // passes the fragment WITHOUT the '#'.
      (this.__fragment ? '#' + this.__fragment : '')
    );
  }
  previousPageUrl() {
    if (this.__currentPage > 1) return this.url(this.__currentPage - 1);
    return null;
  }
  nextPageUrl() {
    if (this.hasMorePages()) return this.url(this.__currentPage + 1);
    return null;
  }
  getUrlRange(start, end) {
    const from = Number(start);
    const to = Number(end);
    const out = {};
    if (to >= from) {
      for (let page = from; page <= to; page++) out[page] = this.url(page);
    } else {
      // PHP's range() with a descending range.
      for (let page = from; page >= to; page--) out[page] = this.url(page);
    }
    return out;
  }

  // ---- the URL window (the `elements` the pagination view renders) --------
  elements() {
    const w = urlWindow(this);
    return [
      w.first,
      isArrayLike(w.slider) ? '...' : null,
      w.slider,
      isArrayLike(w.last) ? '...' : null,
      w.last,
    ].filter(phpTruthy);
  }
}

// Illuminate\Pagination\UrlWindow — the slider (the "Google style" window).
export function urlWindow(paginator) {
  const onEachSide = paginator.onEachSide();
  if (paginator.lastPage() < onEachSide * 2 + 8) {
    return {
      first: paginator.getUrlRange(1, paginator.lastPage()),
      slider: null,
      last: null,
    };
  }
  const window = onEachSide + 4;
  if (!(paginator.lastPage() > 1)) {
    return { first: null, slider: null, last: null };
  }
  if (paginator.currentPage() <= window) {
    return {
      first: paginator.getUrlRange(1, window + onEachSide),
      slider: null,
      last: paginator.getUrlRange(paginator.lastPage() - 1, paginator.lastPage()),
    };
  }
  if (paginator.currentPage() > paginator.lastPage() - window) {
    return {
      first: paginator.getUrlRange(1, 2),
      slider: null,
      last: paginator.getUrlRange(
        paginator.lastPage() - (window + (onEachSide - 1)),
        paginator.lastPage()
      ),
    };
  }
  return {
    first: paginator.getUrlRange(1, 2),
    slider: paginator.getUrlRange(
      paginator.currentPage() - onEachSide,
      paginator.currentPage() + onEachSide
    ),
    last: paginator.getUrlRange(paginator.lastPage() - 1, paginator.lastPage()),
  };
}

export default { LengthAwarePaginator, urlWindow };
