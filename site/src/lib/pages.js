// lib/pages.js — what each route renders.
//
// Article HTML comes straight out of content.js, which site/build.js generated
// from docs/. Nothing here re-authors documentation: the site and the
// repository cannot drift apart because there is only one copy.
//
// Every article ends with SUGGESTED ARTICLES — siblings in its category and the
// next category along — so a reader is never dropped at a dead end.

import { h, clear } from './dom.js';
import { text as T, resolve as R } from './i18n.js';
import { makePredicate } from './regex.js';
import { searchHref } from './router.js';

/** Bilingual label: a prominent primary line and a compact secondary one, so
 *  both languages fit without crowding the layout at narrow widths. */
export function bilingual(key, store, params = []) {
  const s = store.get();
  const r = R(key, store.langOpts(), params);
  if (s.lang === 'en') return h('span', { text: r.en });
  if (s.lang === 'yue') return h('span', { text: r.yue });
  return h('span.bi', null, h('span.bi-primary', { text: r.en }), h('span.bi-secondary', { text: r.yue }));
}

const readingMinutes = (words) => Math.max(1, Math.round(words / 220));

/* ------------------------------------------------------------------ home */

export function renderHome(host, ctx) {
  const { data, store } = ctx;
  const opts = () => store.langOpts();
  const articles = data.categories.reduce((n, c) => n + c.articles.length, 0);

  host.append(h('section.hero', null,
    h('p.hero-eyebrow', { text: data.tagline }),
    h('h1.hero-title', null, bilingual('heroTitle', store)),
    h('p.hero-blurb.prose', null, bilingual('heroBlurb', store)),
    h('div.hero-actions', null,
      h('a.btn.btn-filled', { href: '#/protocols', text: T('browseDocs', opts()) }),
      renderDownload(ctx)),
    h('p.hero-meta', { text: `${T('featureCount', opts(), [articles, data.categories.length])} · `
      + `${T('versionLine', opts(), [data.version, data.versionStatus])} · ${T('built', opts(), [data.built])}` })));

  host.append(h('section.cards', { 'aria-label': T('categories', opts()) },
    data.categories.map((c) => h('a.card', { href: `#${c.id}` },
      h('span.card-icon', { 'aria-hidden': 'true', text: c.icon }),
      h('span.card-title', null,
        h('span.bi-primary', { text: c.label[0] }),
        store.get().lang !== 'en' ? h('span.bi-secondary', { text: c.label[1] }) : null),
      h('span.card-count', { text: T('featureCount', opts(), [c.articles.length, 1]).split('·')[0] }),
      c.summary ? h('span.card-summary', { text: c.summary.slice(0, 140) }) : null))));
}

/**
 * The installer download button.
 *
 * It renders ONLY from a verified release manifest that site/build.js emitted
 * into content.js, and only from an asset whose URL is the immutable
 * `/releases/download/<tag>/<file>` form. With no manifest — which is the state
 * of a build that ran before any release existed — there is no button, and the
 * page says why. Pointing a download button at a guessed URL is worse than
 * having none: the reader clicks it, gets a 404, and concludes the project does
 * not ship.
 */
export function renderDownload({ data, store }) {
  const opts = () => store.langOpts();
  const rel = data.release;
  const asset = rel && rel.installer;
  if (!asset) {
    return h('span.download-absent', null,
      h('span.download-none', null, bilingual('downloadNone', store)),
      h('span.download-why.muted', { text: T('downloadNoneWhy', opts()) }));
  }
  return h('a.btn.btn-filled.btn-download', {
    href: asset.url, rel: 'noopener', download: asset.name,
  },
  h('span.bi-primary', { text: T('downloadFor', opts(), [asset.platform || 'Windows']) }),
  h('span.bi-secondary', { text: T('downloadVersion', opts(), [rel.version || rel.tag, formatBytes(asset.size)]) }));
}

function formatBytes(n) {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
}

/* -------------------------------------------------------------- category */

export function renderCategory(host, ctx, route) {
  const { store } = ctx;
  const opts = () => store.langOpts();
  const c = route.category;
  host.append(h('article.doc', null,
    h('p.doc-eyebrow', { text: `${c.icon} ${store.get().lang === 'yue' ? c.label[1] : c.label[0]}` }),
    h('div.prose', { html: c.html })));
  host.append(h('section.cards.cards-sm', { 'aria-label': T('articles', opts()) },
    c.articles.map((a) => h('a.card', { href: `#${a.id}` },
      h('span.card-title', { text: a.title }),
      h('span.card-count', { text: `${T('words', opts(), [a.words])} · ${T('readingTime', opts(), [readingMinutes(a.words)])}` }),
      a.summary ? h('span.card-summary', { text: a.summary.slice(0, 160) }) : null))));
}

/* --------------------------------------------------------------- article */

export function renderArticle(host, ctx, route) {
  const { data, store } = ctx;
  const opts = () => store.langOpts();
  const a = route.article;
  const c = route.category;

  const toc = a.headings.length
    ? h('nav.toc', { 'aria-label': T('onThisPage', opts()) },
      h('p.toc-title', { text: T('onThisPage', opts()) }),
      h('ul', null, a.headings.map((hd) => h('li', { 'data-level': hd.level },
        h('a', { href: `#${route.path}-${hd.id}`, text: hd.text })))))
    : null;

  host.append(h('div.doc-layout', null,
    h('article.doc', null,
      h('nav.crumbs', { 'aria-label': 'Breadcrumb' },
        h('a', { href: '#/', text: T('home', opts()) }), ' / ',
        h('a', { href: `#${c.id}`, text: store.get().lang === 'yue' ? c.label[1] : c.label[0] })),
      h('p.doc-meta', { text: `${T('words', opts(), [a.words])} · ${T('readingTime', opts(), [readingMinutes(a.words)])}` }),
      h('div.prose', { html: a.html }),
      renderSuggested(ctx, c, a)),
    toc));

  if (route.anchor) {
    const target = host.querySelector(`#${cssId(route.anchor)}`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  void data;
}

const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, ''));

function renderSuggested(ctx, category, article) {
  const { data, store } = ctx;
  const opts = () => store.langOpts();
  const siblings = category.articles.filter((a) => a.id !== article.id).slice(0, 3);
  const at = data.categories.indexOf(category);
  const next = data.categories[(at + 1) % data.categories.length];
  const picks = [...siblings, ...(next.articles[0] ? [next.articles[0]] : [])];
  if (!picks.length) return null;
  return h('section.suggested', { 'aria-label': T('suggested', opts()) },
    h('h2', { text: T('suggested', opts()) }),
    h('ul', null, picks.map((a) => h('li', null,
      h('a', { href: `#${a.id}`, text: a.title }),
      a.summary ? h('span.muted', { text: ` — ${a.summary.slice(0, 90)}` }) : null))));
}

/* ---------------------------------------------------------------- search */

/** Search every article's title, summary, headings and rendered text. Pure,
 *  so a test can prove plain text and regex agree about the same corpus. */
export function searchArticles(data, predicate) {
  if (!predicate.ok) return [];
  const hits = [];
  for (const c of data.categories) {
    for (const a of c.articles) {
      const haystacks = [a.title, a.summary, ...a.headings.map((x) => x.text)];
      const body = String(a.html).replace(/<[^>]+>/g, ' ');
      const where = haystacks.findIndex((s) => predicate.test(s));
      if (where >= 0 || predicate.test(body)) {
        hits.push({ category: c, article: a, in: where >= 0 ? 'title' : 'body' });
      }
    }
    if (predicate.test(c.title)) hits.push({ category: c, article: null, in: 'category' });
  }
  return hits;
}

export function renderSearch(host, ctx, route) {
  const { data, store } = ctx;
  const opts = () => store.langOpts();
  const q = route.q || '';
  const pred = makePredicate({ query: q, mode: 'text' });
  const hits = searchArticles(data, pred);

  host.append(h('section.searchpage', null,
    h('h1', { text: T('search', opts()) }),
    h('p.muted', { text: hits.length
      ? T('searchResults', opts(), [hits.length, JSON.stringify(q)])
      : '' }),
    hits.length
      ? h('ul.hitlist', null, hits.map((hit) => h('li', null,
        h('a', { href: `#${(hit.article || hit.category).id}`, text: (hit.article || hit.category).title }),
        h('span.muted', { text: ` — ${store.get().lang === 'yue' ? hit.category.label[1] : hit.category.label[0]}` }))))
      : h('p.prose', null, bilingual('searchNothing', store, [JSON.stringify(q)]))));
}

/* -------------------------------------------------------------- not found */

export function renderNotFound(host, ctx, route) {
  const { store } = ctx;
  const opts = () => store.langOpts();
  host.append(h('section.notfound', null,
    h('h1', { text: '404' }),
    h('p.prose', { text: T('notFound', opts()) }),
    h('p.mono.muted', { text: route.path }),
    h('p', null, h('a.btn.btn-filled', { href: '#/', text: T('backHome', opts()) })),
    h('p', null, h('a', { href: searchHref(route.path.replace(/^\//, '')), text: T('search', opts()) }))));
}

export function clearHost(host) { clear(host); }
