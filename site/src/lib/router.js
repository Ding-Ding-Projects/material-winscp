// lib/router.js — the hash router.
//
// Hash routing, not History API, for one concrete reason: the site is served
// from GitHub Pages under a path prefix, and Pages has no rewrite rule. A
// History-API route like /material-winscp/protocols/sftp is a request for a
// file that does not exist, and Pages answers 404 — the exact failure this
// whole site was broken by. `#/protocols/sftp` is always a request for
// index.html, whatever the prefix is.
//
// THE AMBIGUOUS-ANCHOR PROBLEM. The builder turns a markdown link with a
// fragment into `#/category/article-anchor` (site/build.js route()), which is
// indistinguishable by shape from an article whose slug happens to contain a
// hyphen — and every slug here does. So resolution is not a parse, it is a
// LOOKUP: match the longest known id, and treat whatever is left as the
// in-page anchor. That needs the content model, which is why resolve() takes
// an index and parse() alone does not decide anything.

/** Split a location hash into its raw parts. Pure string work — no lookup. */
export function parse(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [pathAndQuery] = [raw];
  const qi = pathAndQuery.indexOf('?');
  const path = qi >= 0 ? pathAndQuery.slice(0, qi) : pathAndQuery;
  const queryString = qi >= 0 ? pathAndQuery.slice(qi + 1) : '';
  const query = {};
  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    try { query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch { query[k] = v; }
  }
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

/**
 * Turn a hash into a route against the real content.
 *
 * `index` is `{ categories: Map<id, category>, articles: Map<id, article> }`.
 * Returns one of:
 *   { kind:'home' } { kind:'settings' } { kind:'search', q }
 *   { kind:'category', category, anchor }
 *   { kind:'article', category, article, anchor }
 *   { kind:'notfound', path }
 */
export function resolve(hash, index) {
  const { path, query } = parse(hash);

  if (path === '/' || path === '') return { kind: 'home', path: '/', query };
  if (path === '/settings') return { kind: 'settings', path, query };
  if (path === '/search') return { kind: 'search', q: query.q || '', path, query };
  if (path === '/tabs') return { kind: 'tabs', path, query };

  // Longest known id wins; the remainder (minus its joining hyphen) is the
  // in-page anchor. "/protocols/sftp-known-hosts" is the article
  // "/protocols/sftp-known-hosts" if one exists, and otherwise the article
  // "/protocols/sftp" scrolled to #known-hosts.
  const tryIds = (map, kind) => {
    let candidate = path;
    while (candidate.length) {
      if (map.has(candidate)) {
        const rest = path.slice(candidate.length);
        return { id: candidate, anchor: rest.replace(/^-/, '') || '', kind };
      }
      const cut = candidate.lastIndexOf('-');
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
    }
    return null;
  };

  const art = tryIds(index.articles, 'article');
  if (art) {
    const article = index.articles.get(art.id);
    return {
      kind: 'article', path, query, anchor: art.anchor,
      article, category: index.categories.get(`/${article.id.split('/')[1]}`),
    };
  }
  const cat = tryIds(index.categories, 'category');
  if (cat) {
    return { kind: 'category', path, query, anchor: cat.anchor, category: index.categories.get(cat.id) };
  }
  return { kind: 'notfound', path, query };
}

/** Build an index of the generated content. Kept here so the router owns the
 *  only place ids are keyed, and a typo cannot make half the links dead. */
export function buildIndex(data) {
  const categories = new Map();
  const articles = new Map();
  for (const c of data.categories || []) {
    categories.set(c.id, c);
    for (const a of c.articles || []) articles.set(a.id, a);
  }
  return { categories, articles };
}

/** `#/search?q=…` with the query encoded once, correctly. */
export function searchHref(q) { return `#/search?q=${encodeURIComponent(q)}`; }

/**
 * A tiny observer over `hashchange`. `start()` fires once immediately so the
 * first paint is a route render and not a special case — the commonest source
 * of "works when I click, blank when I reload".
 */
export function createRouter(win, onRoute) {
  const handler = () => onRoute(win.location.hash);
  return {
    start() { win.addEventListener('hashchange', handler); handler(); },
    stop() { win.removeEventListener('hashchange', handler); },
    go(hash) {
      const next = hash.startsWith('#') ? hash : `#${hash}`;
      if (win.location.hash === next) handler();     // re-render an identical route
      else win.location.hash = next;
    },
  };
}
