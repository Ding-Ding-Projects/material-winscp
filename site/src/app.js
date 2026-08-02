// app.js — the documentation site's client application.
//
// This file, and the modules under lib/, are what the repository's homepage
// field promised and never had: index.html referenced app.js and app.css, and
// neither had ever been committed, so every path under the published URL —
// including the root — served a page that fetched two 404s and rendered
// nothing. `--verify` named the missing files only after it stopped crashing
// on them.
//
// Loaded as an ES MODULE with relative imports. That matters for exactly the
// reason the site was broken: a relative import resolves against this module's
// own URL, so it carries whatever base prefix the deployment has without the
// build having to substitute anything into it. Only the three top-level
// references in index.html carry {{BASE}}, and the verifier checks those.
//
// content.js is a classic script and runs first; module scripts are deferred,
// so window.SITE_DATA is always populated by the time this executes.

import { $, h, clear, announce, flashTarget } from './lib/dom.js';
import { createStore, DEFAULTS } from './lib/store.js';
import { startTheme, nextTheme } from './lib/theme.js';
import { text as T } from './lib/i18n.js';
import { buildIndex, createRouter, resolve as resolveRoute, searchHref } from './lib/router.js';
import { createTabs } from './lib/tabs.js';
import { attachRegexBuilder, newSearchState } from './lib/regexbuilder.js';
import { notify } from './lib/toast.js';
import { maybeShowDimSum } from './lib/dimsum.js';
import { renderHome, renderCategory, renderArticle, renderSearch, renderNotFound } from './lib/pages.js';
import { renderSettings } from './lib/settings.js';

const data = window.SITE_DATA;

function boot() {
  const main = $('#main');
  if (!data) {
    // The one failure this page cannot route around: without content.js there
    // is nothing to render. Say so in words rather than showing a blank page,
    // because a blank page is indistinguishable from a site that is broken in
    // some subtler way.
    main.append(h('section.notfound', null,
      h('h1', { text: 'Content did not load' }),
      h('p.prose', { text: 'content.js is missing or did not execute, so this page has no articles to show. '
        + 'Run `node site/build.js --verify`, which reports exactly which referenced file is absent.' })));
    return;
  }

  let storageBackend = null;
  try { storageBackend = window.localStorage; } catch { storageBackend = null; }
  const store = createStore(storageBackend);
  startTheme(store);

  const index = buildIndex(data);
  const layer = $('#popovers');

  const titleFor = (id) => {
    if (id === '/') return T('home', store.langOpts());
    if (id === '/settings') return T('settings', store.langOpts());
    if (id === '/search') return T('search', store.langOpts());
    const a = index.articles.get(id);
    if (a) return a.title;
    const c = index.categories.get(id);
    if (c) return store.get().lang === 'yue' ? c.label[1] : c.label[0];
    return null;
  };

  /* ------------------------------------------------------------ the router */

  const router = createRouter(window, (hash) => render(hash));
  const tabs = createTabs({
    els: {
      pinned: $('#strip-pinned'), strip: $('#strip'),
      overflow: $('#tab-overflow'), overflowCount: $('#tab-overflow-count'),
      tabSearch: $('#tab-search-open'), tabGroups: $('#tab-groups-open'),
    },
    store, router, titleFor, layer,
  });

  const ctx = { data, store, layer, index, router, tabs };

  function render(hash) {
    const route = resolveRoute(hash, index);
    clear(main);
    main.dataset.route = route.kind;

    switch (route.kind) {
      case 'home': renderHome(main, ctx); break;
      case 'settings': renderSettings(main, ctx); break;
      case 'search': renderSearch(main, ctx, route); break;
      case 'category': renderCategory(main, ctx, route); break;
      case 'article': renderArticle(main, ctx, route); break;
      default: renderNotFound(main, ctx, route); break;
    }

    document.title = route.kind === 'home'
      ? `${data.title} — documentation`
      : `${titleFor(routeId(route)) || 'Not found'} — ${data.title}`;
    tabs.activate(routeId(route));
    // Route changes must reach assistive technology: the URL changed, the
    // content changed, and nothing moved focus. Announcing the new page is
    // what makes a hash router usable without sight.
    announce(document.title);
    main.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: store.get().reduceMotion ? 'auto' : 'smooth' });
  }

  const routeId = (route) => {
    if (route.kind === 'article') return route.article.id;
    if (route.kind === 'category') return route.category.id;
    if (route.kind === 'settings') return '/settings';
    if (route.kind === 'search') return '/search';
    return '/';
  };

  /* ------------------------------------------------- the global search bar */

  const searchInput = $('#global-search');
  const searchState = newSearchState();
  attachRegexBuilder({
    field: searchInput,
    button: $('.rx-button[data-rx-for="global-search"]'),
    layer, store, state: searchState,
    onChange: () => {},
    sampleFor: () => [...index.articles.values()].map((a) => a.title).join('\n'),
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    router.go(searchHref(searchInput.value));
  });

  /* ---------------------------------------------------------- top bar bits */

  // THE SKIP LINK IS NOT A ROUTE. `href="#main"` is the standard markup and it
  // is also, on a hash-routed page, a navigation to the route "/main" — which
  // resolves to nothing and renders the 404. So it is intercepted: focus moves
  // to <main> (which is tabindex="-1" precisely so it can receive focus) and
  // the hash is left alone. The href stays in the markup because it is what
  // makes the control a link at all, and what it does with JavaScript disabled.
  const skip = $('.skip-link');
  if (skip) {
    skip.addEventListener('click', (e) => {
      e.preventDefault();
      main.focus();
      main.scrollIntoView({ block: 'start', behavior: store.get().reduceMotion ? 'auto' : 'smooth' });
    });
  }

  $('#toggle-theme').addEventListener('click', () => {
    const next = nextTheme(store.get());
    store.set({ theme: next });
    announce(T(next === 'dark' ? 'themeDark' : 'themeLight', store.langOpts()));
  });
  $('#open-settings').addEventListener('click', () => router.go('#/settings'));

  /* ---------------------------------------------------- keyboard shortcuts */

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); router.go('#/settings'); }
  });

  /* ------------------------------------------------------------ the footer */

  const foot = $('#foot-version');
  const setFoot = () => {
    foot.textContent = `${data.title} · ${T('versionLine', store.langOpts(), [data.version, data.versionStatus])}`
      + ` · ${T('built', store.langOpts(), [data.built])}`;
  };
  setFoot();
  store.subscribe(setFoot);

  const brandVersion = $('#brand-version');
  if (brandVersion) brandVersion.textContent = `v${data.version}`;

  router.start();

  // Non-blocking, after the page is already usable. A surprise that delays the
  // first paint is not a surprise, it is a loading screen.
  window.setTimeout(() => maybeShowDimSum({ slot: $('#dimsum-slot'), data, store }), 900);

  if (store.persistenceBroken) {
    notify.warning('Settings cannot be stored',
      'This browser refused local storage, so appearance and language choices will not survive a reload.');
  }

  // Expose exactly what a console debugging session needs, and nothing that
  // another script could use to drive the page.
  window.__site = { store, router, index, DEFAULTS, flashTarget };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
