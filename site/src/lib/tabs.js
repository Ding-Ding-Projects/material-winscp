// lib/tabs.js — browser-style tabs for the documentation site.
//
// The site is navigated, not scrolled: each category, article and settings page
// is a tab, and the strip persists per visitor. A reader who opened six
// protocol articles finds those six tabs where they left them.
//
// OVERFLOW IS THE PART THAT USUALLY BREAKS. A strip that lets its last tabs
// slide under the edge of the window has not "run out of room", it has hidden
// them: nothing on screen says a tab exists, so the reader concludes they
// closed it. Everything that does not fit therefore moves into an explicit
// overflow surface with a live count, and the count is the promise that the
// strip is never silently clipped.
//
// PINNING IS FIRST-CLASS: pinned tabs live in their own region, stay visible
// when ordinary tabs overflow, keep an accessible full name in compact form,
// and are excluded from bulk closes by default.

import { h, clear, openPopover, announce, uid } from './dom.js';
import { text as T } from './i18n.js';
import { notify } from './toast.js';
import { makePredicate, invert } from './regex.js';
import { attachRegexBuilder, newSearchState } from './regexbuilder.js';

const HOME = { id: '/', pinned: true, fixed: true };

/** Stored shape: { open: [{id, pinned}], active }. Anything else is discarded
 *  rather than trusted — this comes back from a browser profile that may be
 *  older than the build reading it. */
export function normalizeTabs(raw, { titleFor }) {
  const open = [];
  const seen = new Set();
  const push = (id, pinned) => {
    if (!id || seen.has(id) || !titleFor(id)) return;
    seen.add(id);
    open.push({ id, pinned: Boolean(pinned) });
  };
  push(HOME.id, true);
  if (raw && Array.isArray(raw.open)) for (const t of raw.open) push(t && t.id, t && t.pinned);
  const active = raw && seen.has(raw.active) ? raw.active : HOME.id;
  return { open, active };
}

export function createTabs({ els, store, router, titleFor, layer }) {
  let model = normalizeTabs(store.get().tabs, { titleFor });
  const opts = () => store.langOpts();
  const isHome = (id) => id === HOME.id;

  const persist = () => store.set({ tabs: { open: model.open, active: model.active } });

  /** Open (or focus) a tab for a route. Called by the router on every
   *  navigation, so the strip cannot get out of step with what is displayed. */
  function activate(id) {
    if (!titleFor(id)) return;
    if (!model.open.some((t) => t.id === id)) model.open.push({ id, pinned: false });
    model.active = id;
    persist();
    render();
  }

  function close(id) {
    if (isHome(id)) return false;                 // home is the floor, never closed
    const i = model.open.findIndex((t) => t.id === id);
    if (i < 0) return false;
    model.open.splice(i, 1);
    if (model.active === id) {
      const next = model.open[Math.min(i, model.open.length - 1)] || { id: HOME.id };
      model.active = next.id;
      router.go(next.id);
    }
    persist();
    render();
    return true;
  }

  function setPinned(id, pinned) {
    const t = model.open.find((x) => x.id === id);
    if (!t || isHome(id)) return;
    t.pinned = pinned;
    persist();
    render();
    announce(`${titleFor(id)} ${pinned ? 'pinned' : 'unpinned'}`);
  }

  /** Move within the tab's own region. A pinned tab reordering into the
   *  unpinned run would look like it silently unpinned itself. */
  function move(id, delta) {
    const t = model.open.find((x) => x.id === id);
    if (!t) return;
    const peers = model.open.filter((x) => Boolean(x.pinned) === Boolean(t.pinned));
    const at = peers.indexOf(t);
    const to = at + delta;
    if (to < 0 || to >= peers.length) return;
    const other = peers[to];
    const i = model.open.indexOf(t), j = model.open.indexOf(other);
    model.open[i] = other;
    model.open[j] = t;
    persist();
    render();
    const el = els.strip.querySelector(`[data-tab="${cssEscape(id)}"]`)
      || els.pinned.querySelector(`[data-tab="${cssEscape(id)}"]`);
    if (el) el.focus();
  }

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  /* ------------------------------------------------------------- rendering */

  function tabButton(t) {
    const active = t.id === model.active;
    const title = titleFor(t.id) || t.id;
    const el = h('div.tab', {
      role: 'tab', 'data-tab': t.id, tabindex: active ? '0' : '-1',
      'aria-selected': active ? 'true' : 'false', 'aria-controls': 'main',
      'data-pinned': t.pinned ? '1' : '0', title,
      draggable: 'true',
    },
    h('span.tab-label.ellipsis', { text: t.pinned && !isHome(t.id) ? shortName(title) : title }),
    isHome(t.id) ? null : h('button.tab-close', {
      type: 'button', tabindex: '-1',
      'aria-label': `${T('closeTab', opts())}: ${title}`, text: '✕',
      onclick: (e) => { e.stopPropagation(); close(t.id); },
    }));

    // A pinned tab shows a compact label, so its full name has to reach
    // assistive technology some other way.
    el.setAttribute('aria-label', title);
    el.addEventListener('click', () => router.go(t.id));
    el.addEventListener('keydown', (e) => onKey(e, t));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openTabMenu(el, t); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.dataset.dropTarget = '1'; });
    el.addEventListener('dragleave', () => { delete el.dataset.dropTarget; });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      delete el.dataset.dropTarget;
      const from = e.dataTransfer.getData('text/plain');
      reorderTo(from, t.id);
    });
    return el;
  }

  const shortName = (title) => title.split(/[\s·—]/)[0].slice(0, 10);

  function reorderTo(fromId, toId) {
    if (fromId === toId) return;
    const a = model.open.find((t) => t.id === fromId);
    const b = model.open.find((t) => t.id === toId);
    if (!a || !b || Boolean(a.pinned) !== Boolean(b.pinned)) return;
    model.open.splice(model.open.indexOf(a), 1);
    model.open.splice(model.open.indexOf(b), 0, a);
    persist();
    render();
  }

  /** Roving focus across the strip, per the tablist pattern. */
  function onKey(e, t) {
    const order = model.open.slice().sort((x, y) => Number(Boolean(y.pinned)) - Number(Boolean(x.pinned)));
    const at = order.indexOf(order.find((x) => x.id === t.id));
    const focusAt = (i) => {
      const next = order[(i + order.length) % order.length];
      const el = document.querySelector(`[data-tab="${cssEscape(next.id)}"]`);
      if (el) el.focus();
    };
    // MODIFIED KEYS FIRST. Ctrl+Arrow reorders and plain Arrow moves focus, and
    // a switch on e.key alone matches the plain case for both — the reorder
    // shortcut is then advertised in the context menu and does nothing, which
    // is worse than not offering it.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      move(t.id, e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      setPinned(t.id, !t.pinned);
      return;
    }
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); focusAt(at + 1); break;
      case 'ArrowLeft': e.preventDefault(); focusAt(at - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(order.length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); router.go(t.id); break;
      case 'Delete': e.preventDefault(); close(t.id); break;
      case 'F10': if (e.shiftKey) { e.preventDefault(); openTabMenu(e.currentTarget, t); } break;
      case 'ContextMenu': e.preventDefault(); openTabMenu(e.currentTarget, t); break;
      default: break;
    }
  }

  function render() {
    clear(els.pinned);
    clear(els.strip);
    for (const t of model.open.filter((x) => x.pinned)) els.pinned.append(tabButton(t));
    for (const t of model.open.filter((x) => !x.pinned)) els.strip.append(tabButton(t));
    // Measured SYNCHRONOUSLY, not in requestAnimationFrame. rAF callbacks are
    // not delivered while the page is not producing frames — a backgrounded
    // tab, a hidden pane, a headless check — and a strip that only computes its
    // overflow once a frame is painted silently ships every tab past the right
    // edge in exactly the situations nobody is watching. Reading offsetWidth
    // forces the layout we need anyway, so the cost is one reflow over a
    // handful of elements.
    measureOverflow();
  }

  /**
   * Decide what fits. Measured from the LAID-OUT strip rather than from a
   * character-count guess, because the answer changes with the font, the
   * density, the display scale and the language mode — bilingual labels are
   * the longest, and a guess tuned on English clips them.
   */
  function measureOverflow() {
    const strip = els.strip;
    const kids = [...strip.children];
    for (const el of kids) el.hidden = false;
    const avail = strip.clientWidth;
    const widths = kids.map((el) => el.offsetWidth + 4);

    // THE ACTIVE TAB IS RESERVED FIRST. Filling left-to-right and letting the
    // remainder overflow puts the page you are reading into a menu whenever
    // enough tabs precede it — the strip then shows a run of tabs none of which
    // is the current one, which reads as the app having lost your place.
    const activeAt = kids.findIndex((el) => el.dataset.tab === model.active);
    const keep = new Set();
    let used = 0;
    if (activeAt >= 0) { keep.add(activeAt); used = widths[activeAt]; }
    for (let i = 0; i < kids.length; i++) {
      if (keep.has(i)) continue;
      if (used + widths[i] > avail) continue;
      used += widths[i];
      keep.add(i);
    }

    let hidden = 0;
    for (let i = 0; i < kids.length; i++) {
      kids[i].hidden = !keep.has(i);
      if (kids[i].hidden) hidden++;
    }
    els.overflow.hidden = hidden === 0;
    els.overflowCount.textContent = String(hidden);
    els.overflow.setAttribute('aria-label', T('tabsOverflow', opts()));
  }

  /* --------------------------------------------------------------- menus */

  function openTabMenu(anchor, t) {
    const items = [
      { label: T(t.pinned ? 'unpin' : 'pin', opts()), key: 'Ctrl+P', run: () => setPinned(t.id, !t.pinned), disabled: isHome(t.id) },
      { label: T('moveLeft', opts()), key: 'Ctrl+←', run: () => move(t.id, -1) },
      { label: T('moveRight', opts()), key: 'Ctrl+→', run: () => move(t.id, 1) },
      { label: T('closeTab', opts()), key: 'Del', run: () => close(t.id), disabled: isHome(t.id) },
      { label: T('closeOthers', opts()), run: () => closeMany((x) => x.id !== t.id) },
      { label: T('closeRight', opts()), run: () => closeMany((x, i) => i > model.open.indexOf(t)) },
      { label: T('closeContaining', opts()), run: () => bulkClose(false) },
      { label: T('closeNotContaining', opts()), run: () => bulkClose(true) },
    ];
    openMenu(anchor, items, T('tabs', opts()));
  }

  /**
   * A context menu that shows its own shortcuts. The menu is where a reader
   * finds out what a tab can do; a command whose key is hidden here is a key
   * nobody learns.
   */
  function openMenu(anchor, items, label) {
    const search = h('input.menu-search', { type: 'search', placeholder: T('search', opts()), 'aria-label': `${label} — ${T('search', opts())}` });
    const list = h('div.menu-items', { role: 'menu' });
    const draw = (q) => {
      clear(list);
      const pred = q ? makePredicate({ query: q, mode: 'text' }) : null;
      const shown = items.filter((i) => !pred || !pred.ok || pred.test(i.label));
      if (!shown.length) { list.append(h('p.menu-empty.muted', { text: T('rbNoMatch', opts()) })); return; }
      for (const item of shown) {
        list.append(h('button.menu-item', {
          type: 'button', role: 'menuitem', disabled: item.disabled || undefined,
          onclick: () => { closeMenu(); item.run(); },
          ...(item.key ? { 'aria-keyshortcuts': item.key } : {}),
        },
        h('span.menu-label', { text: item.label }),
        item.key ? h('kbd.menu-key', { text: item.key }) : null));
      }
    };
    search.addEventListener('input', () => draw(search.value));
    const panel = h('div.popover.menu', { role: 'dialog', 'aria-label': label }, search, list);
    draw('');
    const closeMenu = openPopover({ anchor, panel, layer });
  }

  function closeMany(keep) {
    const doomed = model.open.filter((t, i) => !keep(t, i) && !t.pinned && !isHome(t.id));
    for (const t of doomed) close(t.id);
    notify.info(`${doomed.length} tabs closed`);
  }

  /**
   * Close tabs containing text, and its exact inverse.
   *
   * The two actions share ONE predicate object — `invert()` negates the same
   * compiled test — so casing, Unicode and flags cannot drift between them.
   * An empty query is refused rather than treated as "matches everything",
   * and the count is shown before anything closes.
   */
  function bulkClose(inverted) {
    const state = newSearchState();
    const label = T(inverted ? 'closeNotContaining' : 'closeContaining', opts());
    const titleId = `bulk-${inverted ? 'not' : 'in'}`;

    const field = h('input.field', {
      type: 'search', id: `${titleId}-q`, autocomplete: 'off',
      'aria-label': T('search', opts()), placeholder: T('search', opts()),
    });
    const button = h('button.rx-button', {
      type: 'button', 'aria-expanded': 'false', text: '.*', title: T('openRegexBuilder', opts()),
    });
    const preview = h('p.bulk-preview', { role: 'status', 'aria-live': 'polite' });
    const list = h('ul.bulk-list');
    const includePinned = h('input', { type: 'checkbox', id: `${titleId}-pinned` });
    const confirm = h('button.btn.btn-danger', { type: 'button', text: T('closeTab', opts()), disabled: true });

    // Pinned tabs are excluded by default and the checkbox is what makes the
    // exception explicit — "an explicit include-pinned choice previews the
    // protected tabs before any close". Home is never closable at all.
    const closable = () => model.open.filter((t) => !isHome(t.id) && (includePinned.checked || !t.pinned));

    let hits = [];
    const compute = () => {
      const base = makePredicate(state.mode === 'regex'
        ? { pattern: state.pattern || field.value, flags: state.flags, mode: 'regex' }
        : { query: field.value, mode: 'text' });
      // ONE predicate, inverted. The two actions cannot disagree about casing,
      // Unicode or flags because there is only one compiled test between them.
      const pred = inverted ? invert(base) : base;
      clear(list);

      if (!pred.ok) {
        hits = [];
        preview.dataset.kind = 'error';
        preview.textContent = pred.empty ? T('emptyQueryRefused', opts()) : (pred.error || '');
        confirm.disabled = true;
        return;
      }
      hits = closable().filter((t) => pred.test(titleFor(t.id) || t.id));
      const pinnedHeld = model.open.filter((t) => t.pinned && !isHome(t.id)).length;
      preview.dataset.kind = hits.length ? 'ok' : 'none';
      preview.textContent = hits.length
        ? `${pred.describe} — ${T('willClose', opts(), [hits.length, closable().length, ''])}`.replace(/:\s*$/, '')
          + (!includePinned.checked && pinnedHeld ? ` ${T('pinnedExcluded', opts(), [pinnedHeld])}` : '')
        : T('nothingToClose', opts());
      // The preview names every tab, so "42 will close" is reviewable rather
      // than a number to be taken on trust.
      for (const t of hits) list.append(h('li', { text: titleFor(t.id) || t.id }));
      confirm.disabled = hits.length === 0;
    };

    field.addEventListener('input', () => { state.query = field.value; compute(); });
    includePinned.addEventListener('change', compute);

    const panel = h('div.dialog.bulk', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2.dialog-title', { id: titleId, text: label }),
      h('div.search-field', null, h('span.search-icon', { 'aria-hidden': 'true', text: '🔍' }), field, button),
      h('label.bulk-pinned', { for: includePinned.id }, includePinned, h('span', { text: T('includePinned', opts()) })),
      preview,
      list,
      h('div.dialog-actions', null,
        h('button.btn.btn-text', { type: 'button', text: 'Cancel', onclick: () => done(false) }),
        confirm));
    confirm.addEventListener('click', () => done(true));

    const scrim = h('div.scrim', { onclick: (e) => { if (e.target === scrim) done(false); } }, panel);
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.popover.rb')) { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);

    attachRegexBuilder({
      field, button, layer, store, state,
      onChange: compute,
      sampleFor: () => closable().map((t) => titleFor(t.id)).join('\n'),
    });
    compute();
    field.focus();

    function done(go) {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      if (!go || !hits.length) return;
      const names = hits.map((t) => titleFor(t.id) || t.id);
      for (const t of hits) close(t.id);
      notify.info(`${names.length} tabs closed`, names.join(', '));
    }
  }

  /* ------------------------------------------------------- overflow + search */

  els.overflow.addEventListener('click', () => {
    const hiddenTabs = [...els.strip.children].filter((el) => el.hidden)
      .map((el) => model.open.find((t) => t.id === el.dataset.tab)).filter(Boolean);
    openMenu(els.overflow, hiddenTabs.map((t) => ({
      label: titleFor(t.id) || t.id, run: () => router.go(t.id),
    })), T('tabsOverflow', opts()));
  });

  els.tabSearch.addEventListener('click', () => openTabSearch(els.tabSearch, model.open, T('searchTabs', opts())));

  /** The master search: every open tab, pinned state and all. */
  els.tabGroups.addEventListener('click', () => openTabSearch(els.tabGroups, model.open, T('tabs', opts())));

  function openTabSearch(anchor, tabs, label) {
    const state = newSearchState();
    const field = h('input.field', { type: 'search', 'aria-label': label, placeholder: label });
    const button = h('button.rx-button', { type: 'button', 'aria-expanded': 'false', text: '.*', title: T('openRegexBuilder', opts()) });
    const list = h('ul.tabsearch-list', { role: 'listbox', 'aria-label': label });
    const draw = () => {
      clear(list);
      const pred = makePredicate(state.mode === 'regex'
        ? { pattern: state.pattern, flags: state.flags, mode: 'regex' }
        : { query: field.value, mode: 'text' });
      const shown = tabs.filter((t) => !pred.ok || pred.test(titleFor(t.id) || t.id));
      if (!shown.length) { list.append(h('li.muted', { text: T('rbNoMatch', opts()) })); return; }
      for (const t of shown) {
        list.append(h('li', null, h('button.tabsearch-item', {
          type: 'button', role: 'option',
          'aria-selected': t.id === model.active ? 'true' : 'false',
          onclick: () => { router.go(t.id); },
        },
        h('span.ellipsis', { text: titleFor(t.id) || t.id }),
        t.pinned ? h('span.pin-badge', { title: T('pin', opts()), text: '📌' }) : null)));
      }
    };
    field.addEventListener('input', draw);
    const panel = h('div.popover.tabsearch', { role: 'dialog', 'aria-label': label },
      h('div.search-field', null, field, button), list,
      h('div.rb-actions', null,
        h('button.btn.btn-text', { type: 'button', text: T('closeContaining', opts()), onclick: () => bulkClose(false) }),
        h('button.btn.btn-text', { type: 'button', text: T('closeNotContaining', opts()), onclick: () => bulkClose(true) })));
    draw();
    openPopover({ anchor, panel, layer });
    attachRegexBuilder({
      field, button, layer, store, state,
      onChange: draw,
      sampleFor: () => tabs.map((t) => titleFor(t.id)).join('\n'),
    });
  }

  window.addEventListener('resize', measureOverflow);
  // A ResizeObserver catches the width changes a resize event does not: the
  // pinned region growing, a font-size change, a density change. Guarded
  // because it is the one API here that an older browser may not have.
  if (window.ResizeObserver) new ResizeObserver(() => measureOverflow()).observe(els.strip);
  store.subscribe((_, changed) => { if (changed.includes('lang') || changed.includes('density')) render(); });

  return { activate, close, render, model: () => model, measureOverflow };
}
