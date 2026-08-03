// ui/tabs.js — browser-style tabs: overflow, reordering, pinning, grouping,
// four tab-discovery searches and the two bulk-close actions.
//
// The tab strip is the app's primary navigation. Content is separated into
// discrete pages reached from a persistent strip, not one long scrolling
// surface.
//
// What "complete" means here, and what this file actually implements:
//   * an overflow surface — tabs are NEVER silently clipped; anything that
//     does not fit is listed in the More menu, which shows the same labels,
//     group membership and pinned state
//   * drag reordering inside the strip, into and out of groups, and between
//     groups; keyboard equivalents on Ctrl+Shift+Arrow
//   * pinning into a stable dedicated region that stays visible when ordinary
//     tabs overflow, keeps an accessible full name in its compact form, and is
//     excluded from bulk closes unless the user explicitly includes them
//   * groups with name, colour, icon, order, collapse and removal, each with
//     its own tab search and its own appearance editor
//   * all four searches — current strip, inside a group, group names, and a
//     master search over every tab in every window/strip/group the app owns —
//     each with its OWN anchored regex builder, never a shared one
//   * "Close tabs containing text" and its inverse, built from ONE predicate so
//     flags, casing, Unicode and scope cannot drift between them
//   * ARIA: role=tablist / tab / tabpanel, roving focus, live aria-controls
//
// Order, pins, groups, group order and collapsed state persist through config.

import {
  h, icon, uid, clear, appearanceTarget, rovingFocus, announce, openModal,
  anchorTo, layer, focusMemory, trapFocus, clamp,
} from '../dom.js';
import { t, bindText } from '../i18n.js';
import { store, persistCurrent, bus } from '../state.js';
import { openMenu, registerContextMenu, SEPARATOR } from './contextmenu.js';
import { createSearchBar, filterBy } from './searchbar.js';
import { makePredicate } from './regexbuilder.js';
import { colorSwatchButton } from './colorpicker.js';
import { notify } from './notifications.js';
import { readPref } from './commands.js';

/* ================================================================== */
/* model                                                               */
/* ================================================================== */

const GROUP_COLORS = ['#0B57D0', '#146C2E', '#6750A4', '#A33B12', '#725572', '#575E71', '#B3261E', '#00696E'];

/** All strips in this window, plus any registered external tab sources. */
const strips = new Map();                // stripId -> strip controller
const externalSources = new Set();       // fn() => [{ windowId, stripId, tabs:[…] }]

/**
 * Register a source of tabs living outside this renderer (another window).
 * The master search folds these in so "every tab the app owns" is honest.
 */
export function registerTabSource(fn) {
  externalSources.add(fn);
  return () => externalSources.delete(fn);
}

function persistTabs() {
  const all = { order: [], pinned: [], groups: [], groupOrder: [], collapsed: [], appearance: store.get('tabs.appearance') || {} };
  for (const strip of strips.values()) {
    all.order.push(...strip.tabs.map((tb) => ({ stripId: strip.id, id: tb.id, title: tb.title, groupId: tb.groupId, key: tb.key })));
    all.pinned.push(...strip.tabs.filter((tb) => tb.pinned).map((tb) => tb.key || tb.id));
    all.groups.push(...strip.groups.map((g) => ({ ...g, stripId: strip.id })));
    all.groupOrder.push(...strip.groupOrder.map((gid) => ({ stripId: strip.id, gid })));
    all.collapsed.push(...strip.groups.filter((g) => g.collapsed).map((g) => g.id));
  }
  store.set('tabs', { ...(store.get('tabs') || {}), ...all });
  persistCurrent('tabs');
}

function savedGroupsFor(stripId) {
  const saved = store.get('tabs.groups') || [];
  return saved.filter((g) => !g.stripId || g.stripId === stripId).map((g) => ({ ...g }));
}
function savedGroupOrderFor(stripId) {
  const saved = store.get('tabs.groupOrder') || [];
  return saved.filter((g) => !g.stripId || g.stripId === stripId).map((g) => g.gid || g);
}

/* ================================================================== */
/* strip                                                               */
/* ================================================================== */

/**
 * createTabStrip(opts) -> strip controller
 *
 * opts:
 *   container   element the strip is rendered into (required)
 *   panelHost   element the tab panels live in (required)
 *   id          strip id (default 'main')
 *   windowId    label used by the master search (default 'Main window')
 *   onNewTab()  invoked by the + button; should call strip.openTab(...)
 *   renderPanel(tab, panelEl)  called once per tab to fill its panel
 *
 * Controller:
 *   openTab(spec) closeTab(id) activateTab(id) renameTab(id, title)
 *   pinTab(id, bool) setTabGroup(id, groupId) moveTab(id, index)
 *   createGroup(spec) renameGroup(id, name) setGroupColor(id, hex)
 *   collapseGroup(id, bool) removeGroup(id) moveGroup(id, index)
 *   tabs groups groupOrder activeId
 *   openStripSearch() openGroupSearch(gid) openGroupNameSearch() openMasterSearch()
 *   bulkClose({ containing:bool })
 */
/**
 * Which tabs a bulk close would actually close — the ONE decision behind both
 * "Close tabs containing text" and its inverse, and behind their preview.
 *
 * It lives out here, as a pure function over plain objects, for a reason the
 * test suite makes obvious: a reference model written beside the tests only
 * ever tests itself. Everything a bulk close can get wrong is decided here —
 * which direction the predicate runs, whether pinned tabs are protected,
 * whether an empty query or a broken pattern closes anything — so a mutation
 * to any of it fails a test that drives this exact function.
 *
 *   pool         the tabs in scope, in strip order
 *   predicate    a makePredicate() result ({ ok, test, error })
 *   query        the raw query; empty means "close nothing"
 *   containing   true for "containing", false for the inverse
 *   includePinned  the user's explicit opt-in
 *
 * Returns { ok, reason, matches, victims, excludedPins, dirty } where `victims`
 * is what would close and `matches` is what the query picked up before pinned
 * tabs were protected — the preview shows the first and warns with the second.
 */
export function bulkCloseSelection({ pool = [], predicate, query = '', containing = true, includePinned = false } = {}) {
  const empty = { matches: [], victims: [], excludedPins: 0, dirty: [] };
  if (!String(query || '').length) return { ok: false, reason: 'empty', ...empty };
  if (!predicate || !predicate.ok) {
    return { ok: false, reason: 'invalid', error: predicate && predicate.error, ...empty };
  }
  // ONE predicate, negated once — the two directions cannot drift apart in
  // flags, casing, Unicode handling or scope, and together they partition the
  // pool exactly.
  const matches = pool.filter((tb) => (containing ? predicate.test(tb.title) : !predicate.test(tb.title)));
  const excludedPins = matches.filter((tb) => tb.pinned).length;
  const victims = includePinned ? matches : matches.filter((tb) => !tb.pinned);
  return { ok: true, reason: '', matches, victims, excludedPins, dirty: victims.filter((tb) => tb.dirty) };
}

export function createTabStrip(opts = {}) {
  const id = opts.id || 'main';
  const windowId = opts.windowId || 'Main window';
  const container = opts.container;
  const panelHost = opts.panelHost;
  if (!container || !panelHost) throw new Error('createTabStrip needs container and panelHost');

  const strip = {
    id, windowId,
    tabs: [],
    groups: savedGroupsFor(id),
    groupOrder: savedGroupOrderFor(id),
    activeId: null,
  };

  /* ---------------- DOM skeleton ---------------- */

  const pinnedRegion = h('div', { class: 'tabstrip-pinned', role: 'presentation' });
  const pinnedSep = h('div', { class: 'tabstrip-sep', role: 'separator', 'aria-orientation': 'vertical', hidden: true });
  const scroller = h('div', { class: 'tabstrip-scroll', role: 'presentation' });

  const overflowBtn = h('button', {
    type: 'button', class: 'icon-btn tabstrip-btn', 'aria-haspopup': 'menu',
    onclick: () => openOverflow(),
  }, icon('expand_more', 18), h('span', { class: 'tabstrip-badge', hidden: true }));
  const searchBtn = h('button', {
    type: 'button', class: 'icon-btn tabstrip-btn', 'aria-haspopup': 'dialog',
    onclick: () => openSearchHub(searchBtn),
  }, icon('manage_search', 17));
  const groupsBtn = h('button', {
    type: 'button', class: 'icon-btn tabstrip-btn', 'aria-haspopup': 'dialog',
    onclick: () => openGroupManager(groupsBtn),
  }, icon('topic', 17));
  const newBtn = h('button', {
    type: 'button', class: 'icon-btn tabstrip-btn',
    onclick: () => opts.onNewTab?.(strip),
  }, icon('add', 18));

  bindText(overflowBtn, 'overflowTabs', { attr: 'aria-label' });
  bindText(overflowBtn, 'overflowTabs', { attr: 'title' });
  bindText(searchBtn, 'searchTabs', { attr: 'aria-label' });
  bindText(searchBtn, 'searchTabs', { attr: 'title' });
  bindText(groupsBtn, 'manageGroups', { attr: 'aria-label' });
  bindText(groupsBtn, 'manageGroups', { attr: 'title' });
  bindText(newBtn, 'newTab', { attr: 'aria-label' });
  bindText(newBtn, 'newTab', { attr: 'title' });

  const root = h('div', {
    class: 'tabstrip', role: 'tablist', 'aria-orientation': 'horizontal',
    'data-strip': id,
  }, pinnedRegion, pinnedSep, scroller,
  h('div', { class: 'tabstrip-tools' }, overflowBtn, searchBtn, groupsBtn, newBtn));

  bindText(root, 'openedTabs', { attr: 'aria-label' });
  const truncationEnabled = readPref('tabs.truncateTitles', true) !== false
    && readPref('window.sessionTabCaptionTruncation', true) !== false;
  root.classList.toggle('tabs-no-title-truncation', !truncationEnabled);
  appearanceTarget(root, `tab-strip-${id}`, 'Session tab strip');
  container.appendChild(root);

  const roving = rovingFocus(root, '[role="tab"]', { orientation: 'horizontal', loop: true });
  const offPrefs = bus.on('prefs:changed', (event) => {
    const path = event && (event.path || event.key);
    if (path === 'tabs.truncateTitles' || path === 'window.sessionTabCaptionTruncation') {
      const enabled = readPref('tabs.truncateTitles', true) !== false
        && readPref('window.sessionTabCaptionTruncation', true) !== false;
      root.classList.toggle('tabs-no-title-truncation', !enabled);
    }
  });

  /* ---------------- helpers ---------------- */

  const byId = (tid) => strip.tabs.find((tb) => tb.id === tid);
  const groupById = (gid) => strip.groups.find((g) => g.id === gid);
  const ungrouped = () => strip.tabs.filter((tb) => !tb.pinned && !tb.groupId);
  const pinned = () => strip.tabs.filter((tb) => tb.pinned);
  const groupTabs = (gid) => strip.tabs.filter((tb) => !tb.pinned && tb.groupId === gid);

  function normalizeGroupOrder() {
    const ids = strip.groups.map((g) => g.id);
    strip.groupOrder = strip.groupOrder.filter((gid) => ids.includes(gid));
    for (const gid of ids) if (!strip.groupOrder.includes(gid)) strip.groupOrder.push(gid);
  }

  /* ---------------- panels ---------------- */

  function panelFor(tab) {
    if (tab.panel && tab.panel.isConnected) return tab.panel;
    const panel = h('div', {
      class: 'tabpanel', role: 'tabpanel', id: tab.panelId,
      'aria-labelledby': tab.tabId, tabindex: '0', hidden: true,
    });
    appearanceTarget(panel, `tab-panel-${tab.key || tab.id}`, `Panel: ${tab.title}`);
    panelHost.appendChild(panel);
    tab.panel = panel;
    try { opts.renderPanel?.(tab, panel); } catch (err) { console.error('[tabs] renderPanel failed', err); }
    return panel;
  }

  /* ---------------- rendering ---------------- */

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(); });
  }

  function tabButton(tab, compact) {
    const el = h('div', {
      class: `tab${tab.id === strip.activeId ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}${tab.dirty ? ' is-dirty' : ''}`,
      role: 'tab', id: tab.tabId, tabindex: tab.id === strip.activeId ? '0' : '-1',
      'aria-selected': String(tab.id === strip.activeId),
      'aria-controls': tab.panelId,
      draggable: 'true',
      'data-tab-id': tab.id,
      title: tab.tooltip || tab.title,
    });
    if (tab.groupId) {
      const g = groupById(tab.groupId);
      if (g) {
        el.style.setProperty('--tab-group-color', g.color);
        el.classList.add('in-group');
        el.setAttribute('aria-describedby', g.headId);
      }
    }
    el.appendChild(h('span', { class: 'tab-dot', style: { background: tab.color || 'var(--p)' } }));
    if (tab.pinned) el.appendChild(icon('push_pin', 13));
    if (!compact) {
      el.appendChild(h('span', { class: 'tab-label' }, tab.title));
      if (tab.dirty) el.appendChild(h('span', { class: 'tab-dirty-dot', 'aria-label': t('unsavedChanges'), title: t('unsavedChanges') }));
      const close = h('button', {
        type: 'button', class: 'tab-close icon-btn', tabindex: '-1',
        'aria-label': `${t('closeTab')}: ${tab.title}`, title: t('closeTab'),
        onclick: (e) => { e.stopPropagation(); closeTab(tab.id); },
      }, icon('close', 13));
      el.appendChild(close);
    } else {
      // A pinned, icon-only tab still carries its full accessible name.
      el.setAttribute('aria-label', tab.title);
    }

    el.addEventListener('click', () => activateTab(tab.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tab.id); }
      else if (e.key === 'Delete' || (e.key === 'w' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); closeTab(tab.id); }
      else if (e.ctrlKey && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); nudge(tab.id, 1); }
      else if (e.ctrlKey && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); nudge(tab.id, -1); }
    });
    wireDrag(el, tab);
    appearanceTarget(el, `tab-${tab.key || tab.id}`, `Tab: ${tab.title}`);
    registerContextMenu(el, () => tabMenu(tab));
    return el;
  }

  function groupHeader(group) {
    const count = groupTabs(group.id).length;
    const el = h('button', {
      type: 'button', class: `tab-group-head${group.collapsed ? ' is-collapsed' : ''}`,
      id: group.headId, 'data-group-id': group.id,
      'aria-expanded': String(!group.collapsed),
      'aria-label': `${group.name} — ${count} ${count === 1 ? 'tab' : 'tabs'}`,
      style: {
        '--group-color': group.color,
        background: `color-mix(in srgb, ${group.color} 18%, transparent)`,
        color: 'var(--onsfc)',
        borderColor: group.color,
      },
      draggable: 'true',
      onclick: () => collapseGroup(group.id, !group.collapsed),
    },
    icon(group.icon || 'label', 14),
    h('span', { class: 'tab-group-name' }, group.name),
    h('span', { class: 'tab-group-count' }, String(count)),
    icon(group.collapsed ? 'chevron_right' : 'expand_more', 14));
    appearanceTarget(el, `tab-group-${group.id}`, `Tab group: ${group.name}`);
    registerContextMenu(el, () => groupMenu(group));
    wireGroupDrag(el, group);
    return el;
  }

  function doRender() {
    normalizeGroupOrder();
    clear(pinnedRegion);
    clear(scroller);

    const pins = pinned();
    pinnedSep.hidden = pins.length === 0;
    for (const tb of pins) pinnedRegion.appendChild(tabButton(tb, true));

    // Grouped tabs come first in group order, then ungrouped, matching the
    // approved mockup's strip layout.
    for (const gid of strip.groupOrder) {
      const g = groupById(gid);
      if (!g) continue;
      const members = groupTabs(gid);
      if (!members.length && !g.keepEmpty) continue;
      const wrap = h('div', { class: 'tab-group', 'data-group-id': gid, style: { '--group-color': g.color } });
      wrap.appendChild(groupHeader(g));
      if (!g.collapsed) for (const tb of members) wrap.appendChild(tabButton(tb, false));
      scroller.appendChild(wrap);
    }
    for (const tb of ungrouped()) scroller.appendChild(tabButton(tb, false));

    // Panels
    for (const tb of strip.tabs) {
      const panel = panelFor(tb);
      panel.hidden = tb.id !== strip.activeId;
    }

    updateOverflowBadge();
    roving.sync(root.querySelector('[role="tab"][aria-selected="true"]'));
  }

  function updateOverflowBadge() {
    // A tab is "overflowed" when its right edge is beyond the scroller's
    // visible box. It is never silently clipped: the badge shows how many are
    // out of view and the More menu lists them.
    requestAnimationFrame(() => {
      const sr = scroller.getBoundingClientRect();
      let hidden = 0;
      for (const el of scroller.querySelectorAll('[role="tab"]')) {
        const r = el.getBoundingClientRect();
        if (r.right > sr.right + 1 || r.left < sr.left - 1) hidden += 1;
      }
      const badge = overflowBtn.querySelector('.tabstrip-badge');
      badge.hidden = hidden === 0;
      badge.textContent = String(hidden);
      overflowBtn.classList.toggle('has-overflow', hidden > 0);
      overflowBtn.setAttribute('aria-label', hidden
        ? `${t('overflowTabs')} (${hidden})`
        : t('overflowTabs'));
    });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateOverflowBadge).observe(scroller);

  /* ---------------- tab lifecycle ---------------- */

  function openTab(spec = {}) {
    const tid = spec.id || uid('tab');
    const tab = {
      id: tid,
      key: spec.key || tid,                       // stable across restarts
      title: spec.title || t('newTab'),
      tooltip: spec.tooltip || '',
      icon: spec.icon || 'dns',
      color: spec.color || '',
      groupId: spec.groupId || null,
      pinned: !!spec.pinned,
      dirty: !!spec.dirty,
      data: spec.data || {},
      tabId: `tabbtn-${tid}`,
      panelId: `tabpanel-${tid}`,
      panel: null,
    };
    // Restore pinned state and group membership from the saved layout.
    const savedPins = store.get('tabs.pinned') || [];
    if (savedPins.includes(tab.key)) tab.pinned = true;
    const savedOrder = store.get('tabs.order') || [];
    const savedEntry = savedOrder.find((o) => o.key === tab.key && (!o.stripId || o.stripId === id));
    if (savedEntry?.groupId && groupById(savedEntry.groupId)) tab.groupId = savedEntry.groupId;

    strip.tabs.push(tab);
    if (spec.activate !== false) strip.activeId = tab.id;
    render();
    persistTabs();
    bus.emit('tabs:opened', { stripId: id, tab });
    return tab.id;
  }

  function closeTab(tid, opts2 = {}) {
    const tab = byId(tid);
    if (!tab) return false;
    if (tab.dirty && !opts2.force) {
      // Unsaved work is a decision, so this is one of the few real modals.
      openModal({
        title: t('unsavedChanges'),
        content: h('p', {}, t('unsavedBody', tab.title)),
        actions: [
          { label: t('cancel'), kind: 'text' },
          { label: t('discard'), kind: 'danger', onSelect: () => { closeTab(tid, { force: true }); } },
        ],
      });
      return false;
    }
    const idx = strip.tabs.indexOf(tab);
    strip.tabs.splice(idx, 1);
    tab.panel?.remove();
    if (strip.activeId === tid) {
      const next = strip.tabs[Math.min(idx, strip.tabs.length - 1)];
      strip.activeId = next ? next.id : null;
    }
    render();
    persistTabs();
    bus.emit('tabs:closed', { stripId: id, tabId: tid, title: tab.title });
    if (!opts2.silent) notify.info(t('tabClosed', tab.title), '', {
      actions: [{ label: t('newTab'), onSelect: () => opts.onNewTab?.(strip) }],
    });
    return true;
  }

  function activateTab(tid) {
    if (strip.activeId === tid) return;
    if (!byId(tid)) return;
    strip.activeId = tid;
    render();
    const tab = byId(tid);
    announce(`${tab.title} — ${t('openedTabs')}`);
    bus.emit('tabs:activated', { stripId: id, tabId: tid, tab });
  }

  function renameTab(tid, title) {
    const tab = byId(tid);
    if (!tab || !title) return;
    tab.title = title;
    render();
    persistTabs();
  }

  function setDirty(tid, dirty) {
    const tab = byId(tid);
    if (!tab) return;
    tab.dirty = !!dirty;
    render();
  }

  function pinTab(tid, value) {
    const tab = byId(tid);
    if (!tab) return;
    tab.pinned = value === undefined ? !tab.pinned : !!value;
    if (tab.pinned) tab.groupId = null;   // a pinned tab lives in the pinned region
    render();
    persistTabs();
    announce(tab.pinned ? `${tab.title} ${t('pinTab')}` : `${tab.title} ${t('unpinTab')}`);
  }

  function moveTab(tid, index) {
    const tab = byId(tid);
    if (!tab) return;
    const cur = strip.tabs.indexOf(tab);
    strip.tabs.splice(cur, 1);
    strip.tabs.splice(clamp(index, 0, strip.tabs.length), 0, tab);
    render();
    persistTabs();
  }

  function nudge(tid, delta) {
    const tab = byId(tid);
    if (!tab) return;
    const cur = strip.tabs.indexOf(tab);
    moveTab(tid, cur + delta);
    announce(`${tab.title} moved.`);
    requestAnimationFrame(() => root.querySelector(`[data-tab-id="${tid}"]`)?.focus());
  }

  function setTabGroup(tid, gid) {
    const tab = byId(tid);
    if (!tab) return;
    tab.groupId = gid || null;
    if (gid) tab.pinned = false;
    render();
    persistTabs();
    const g = gid ? groupById(gid) : null;
    announce(g ? `${tab.title} → ${g.name}` : `${tab.title} — ${t('removeFromGroup')}`);
  }

  /* ---------------- groups ---------------- */

  function createGroup(spec = {}) {
    const gid = spec.id || uid('grp');
    const group = {
      id: gid,
      name: spec.name || `${t('newGroup')}`.replace('…', ''),
      color: spec.color || GROUP_COLORS[strip.groups.length % GROUP_COLORS.length],
      icon: spec.icon || 'label',
      collapsed: !!spec.collapsed,
      keepEmpty: !!spec.keepEmpty,
      headId: `grouphead-${gid}`,
    };
    strip.groups.push(group);
    strip.groupOrder.push(gid);
    render();
    persistTabs();
    bus.emit('tabs:groupCreated', { stripId: id, group });
    return gid;
  }

  function renameGroup(gid, name) {
    const g = groupById(gid);
    if (!g || !name) return;
    g.name = name;
    render();
    persistTabs();
  }
  function setGroupColor(gid, hex) {
    const g = groupById(gid);
    if (!g) return;
    g.color = hex;
    render();
    persistTabs();
  }
  function setGroupIcon(gid, iconName) {
    const g = groupById(gid);
    if (!g) return;
    g.icon = iconName;
    render();
    persistTabs();
  }
  function collapseGroup(gid, value) {
    const g = groupById(gid);
    if (!g) return;
    g.collapsed = value === undefined ? !g.collapsed : !!value;
    render();
    persistTabs();
    announce(g.collapsed ? `${g.name} ${t('collapseGroup')}` : `${g.name} ${t('expandGroup')}`);
  }
  /** Remove the group, keeping its tabs (they become ungrouped). */
  function removeGroup(gid) {
    const g = groupById(gid);
    if (!g) return;
    for (const tb of groupTabs(gid)) tb.groupId = null;
    strip.groups = strip.groups.filter((x) => x.id !== gid);
    strip.groupOrder = strip.groupOrder.filter((x) => x !== gid);
    render();
    persistTabs();
  }
  function moveGroup(gid, index) {
    const cur = strip.groupOrder.indexOf(gid);
    if (cur < 0) return;
    strip.groupOrder.splice(cur, 1);
    strip.groupOrder.splice(clamp(index, 0, strip.groupOrder.length), 0, gid);
    render();
    persistTabs();
  }
  function pinGroup(gid) {
    for (const tb of groupTabs(gid)) { tb.pinned = true; tb.groupId = null; }
    render();
    persistTabs();
  }

  /* ---------------- drag and drop ---------------- */

  let dragTabId = null;
  let dragGroupId = null;

  function wireDrag(el, tab) {
    el.addEventListener('dragstart', (e) => {
      dragTabId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.title);
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => { dragTabId = null; el.classList.remove('is-dragging'); root.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); });
    el.addEventListener('dragover', (e) => {
      if (!dragTabId || dragTabId === tab.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-before', 'drop-after');
      if (!dragTabId || dragTabId === tab.id) return;
      const moving = byId(dragTabId);
      if (!moving) return;
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      // Dropping onto a tab adopts that tab's group and pinned region.
      moving.groupId = tab.groupId;
      moving.pinned = tab.pinned;
      const from = strip.tabs.indexOf(moving);
      strip.tabs.splice(from, 1);
      let to = strip.tabs.indexOf(tab);
      if (!before) to += 1;
      strip.tabs.splice(clamp(to, 0, strip.tabs.length), 0, moving);
      render();
      persistTabs();
      announce(`${moving.title} moved${tab.groupId ? ` into ${groupById(tab.groupId)?.name}` : ''}.`);
    });
  }

  function wireGroupDrag(el, group) {
    el.addEventListener('dragstart', (e) => {
      dragGroupId = group.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', group.name);
    });
    el.addEventListener('dragend', () => { dragGroupId = null; });
    el.addEventListener('dragover', (e) => {
      if (!dragTabId && !dragGroupId) return;
      e.preventDefault();
      el.classList.add('drop-into');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-into');
      if (dragTabId) { setTabGroup(dragTabId, group.id); return; }
      if (dragGroupId && dragGroupId !== group.id) {
        moveGroup(dragGroupId, strip.groupOrder.indexOf(group.id));
      }
    });
  }

  // Dropping on empty strip space un-groups the tab.
  scroller.addEventListener('dragover', (e) => { if (dragTabId) e.preventDefault(); });
  scroller.addEventListener('drop', (e) => {
    if (!dragTabId) return;
    if (e.target.closest('[role="tab"],.tab-group-head')) return;
    e.preventDefault();
    setTabGroup(dragTabId, null);
  });
  pinnedRegion.addEventListener('dragover', (e) => { if (dragTabId) e.preventDefault(); });
  pinnedRegion.addEventListener('drop', (e) => {
    if (!dragTabId) return;
    e.preventDefault();
    pinTab(dragTabId, true);
  });

  /* ---------------- menus ---------------- */

  function tabMenu(tab) {
    const groups = strip.groups;
    return [
      { labelKey: 'newTab', icon: 'add', onSelect: () => opts.onNewTab?.(strip) },
      { labelKey: 'duplicateTab', icon: 'content_copy', onSelect: () => openTab({ ...tab, id: undefined, key: undefined, title: `${tab.title} (2)` }) },
      { labelKey: 'renameTab', icon: 'edit', onSelect: () => promptRename(tab) },
      SEPARATOR,
      { labelKey: tab.pinned ? 'unpinTab' : 'pinTab', icon: 'push_pin', onSelect: () => pinTab(tab.id) },
      {
        labelKey: 'addToGroup', icon: 'topic',
        submenu: [
          ...groups.map((g) => ({
            label: g.name, icon: 'label', checked: tab.groupId === g.id, radio: true,
            onSelect: () => setTabGroup(tab.id, g.id),
          })),
          groups.length ? SEPARATOR : null,
          { labelKey: 'newGroup', icon: 'add', onSelect: () => promptNewGroup([tab.id]) },
          tab.groupId ? { labelKey: 'removeFromGroup', icon: 'remove', onSelect: () => setTabGroup(tab.id, null) } : null,
        ].filter(Boolean),
      },
      SEPARATOR,
      { labelKey: 'closeTab', icon: 'close', shortcut: 'Ctrl+W', onSelect: () => closeTab(tab.id) },
      {
        labelKey: 'closeOthers', icon: 'close',
        onSelect: () => {
          const victims = strip.tabs.filter((x) => x.id !== tab.id && !x.pinned);
          confirmBulkClose(victims, t('closeOthers'), makePredicate({ query: '', mode: 'text' }), false);
        },
      },
      {
        labelKey: 'closeRight', icon: 'chevron_right',
        onSelect: () => {
          const from = strip.tabs.indexOf(tab);
          const victims = strip.tabs.slice(from + 1).filter((x) => !x.pinned);
          confirmBulkClose(victims, t('closeRight'), makePredicate({ query: '', mode: 'text' }), false);
        },
      },
      SEPARATOR,
      { labelKey: 'closeContaining', icon: 'filter', onSelect: () => bulkClose({ containing: true }) },
      { labelKey: 'closeNotContaining', icon: 'filter', onSelect: () => bulkClose({ containing: false }) },
      SEPARATOR,
      { labelKey: 'searchThisStrip', icon: 'search', onSelect: () => openStripSearch(searchBtn) },
      { labelKey: 'masterTabSearch', icon: 'manage_search', onSelect: () => openMasterSearch(searchBtn) },
    ];
  }

  function groupMenu(group) {
    return [
      { labelKey: 'renameGroup', icon: 'edit', onSelect: () => promptRenameGroup(group) },
      { labelKey: 'groupColor', icon: 'palette', onSelect: () => promptGroupColor(group) },
      {
        label: `${t('edit')} — ${t('label') === 'label' ? 'icon' : t('label')}`, icon: 'label',
        submenu: ['label', 'topic', 'folder', 'star', 'bookmark', 'dns', 'cloud', 'key', 'terminal'].map((n) => ({
          label: n, icon: n, checked: group.icon === n, radio: true,
          onSelect: () => setGroupIcon(group.id, n),
        })),
      },
      { labelKey: group.collapsed ? 'expandGroup' : 'collapseGroup', icon: group.collapsed ? 'expand_more' : 'chevron_right', onSelect: () => collapseGroup(group.id) },
      SEPARATOR,
      { labelKey: 'pinTab', icon: 'push_pin', label: `${t('pinTab')} — ${group.name}`, onSelect: () => pinGroup(group.id) },
      { labelKey: 'searchInGroup', icon: 'search', onSelect: () => openGroupSearch(group.id, root.querySelector(`[data-group-id="${group.id}"] .tab-group-head`) || searchBtn) },
      SEPARATOR,
      { labelKey: 'ungroup', icon: 'remove', onSelect: () => removeGroup(group.id) },
      {
        label: `${t('closeTabsBtn', groupTabs(group.id).length)}`, icon: 'close', danger: true,
        onSelect: () => confirmBulkClose(groupTabs(group.id), group.name, makePredicate({ query: '', mode: 'text' }), false),
      },
      SEPARATOR,
      { labelKey: 'editGroupAppearance', icon: 'palette', onSelect: () => bus.emit('appearance:open', { key: `tab-group-${group.id}`, element: root.querySelector(`[data-group-id="${group.id}"] .tab-group-head`), label: `Tab group: ${group.name}` }) },
    ];
  }

  // The strip's own menu is for empty strip space only. Without this guard a
  // right-click on a tab would collect the tab's menu AND the strip's, and the
  // user would see "New tab" and every search entry listed twice.
  registerContextMenu(root, (ctx) => (ctx.target?.closest?.('[role="tab"], .tab-group-head') ? [] : [
    { labelKey: 'newTab', icon: 'add', onSelect: () => opts.onNewTab?.(strip) },
    { labelKey: 'newGroup', icon: 'topic', onSelect: () => promptNewGroup([]) },
    SEPARATOR,
    { labelKey: 'searchThisStrip', icon: 'search', onSelect: () => openStripSearch(searchBtn) },
    { labelKey: 'searchGroupNames', icon: 'topic', onSelect: () => openGroupNameSearch(searchBtn) },
    { labelKey: 'masterTabSearch', icon: 'manage_search', onSelect: () => openMasterSearch(searchBtn) },
    SEPARATOR,
    { labelKey: 'closeContaining', icon: 'filter', onSelect: () => bulkClose({ containing: true }) },
    { labelKey: 'closeNotContaining', icon: 'filter', onSelect: () => bulkClose({ containing: false }) },
  ]));

  /* ---------------- prompts ---------------- */

  function promptRename(tab) {
    const input = h('input', { type: 'text', class: 'field-input', value: tab.title, 'aria-label': t('newName') });
    input.value = tab.title;
    openModal({
      title: t('renameTab'),
      content: h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('newName')), input),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('ok'), kind: 'filled', onSelect: () => renameTab(tab.id, input.value.trim() || tab.title) },
      ],
    });
  }

  function promptRenameGroup(group) {
    const input = h('input', { type: 'text', class: 'field-input', 'aria-label': t('groupName') });
    input.value = group.name;
    openModal({
      title: t('renameGroup'),
      content: h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('groupName')), input),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('ok'), kind: 'filled', onSelect: () => renameGroup(group.id, input.value.trim() || group.name) },
      ],
    });
  }

  function promptGroupColor(group) {
    const swatch = colorSwatchButton({
      value: group.color, label: t('groupColor'), alpha: false,
      onChange: (hex) => setGroupColor(group.id, hex),
    });
    openModal({
      title: `${t('groupColor')} — ${group.name}`,
      content: h('div', { class: 'row' },
        h('span', {}, t('groupColor')),
        swatch.element,
        h('div', { class: 'swatch-row' }, ...GROUP_COLORS.map((c) => h('button', {
          type: 'button', class: 'cp-swatch', style: { background: c }, 'aria-label': c, title: c,
          onclick: () => { swatch.setValue(c); setGroupColor(group.id, c); },
        })))),
      actions: [{ label: t('close'), kind: 'filled' }],
    });
  }

  function promptNewGroup(tabIds) {
    const nameInput = h('input', { type: 'text', class: 'field-input', 'aria-label': t('groupName') });
    nameInput.value = t('newGroup').replace('…', '');
    let chosen = GROUP_COLORS[strip.groups.length % GROUP_COLORS.length];
    const swatch = colorSwatchButton({ value: chosen, label: t('groupColor'), alpha: false, onChange: (hex) => { chosen = hex; } });
    openModal({
      title: t('newGroup'),
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('groupName')), nameInput),
        h('div', { class: 'row' }, h('span', {}, t('groupColor')), swatch.element)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('ok'), kind: 'filled',
          onSelect: () => {
            const gid = createGroup({ name: nameInput.value.trim() || 'Group', color: chosen });
            for (const tid of tabIds) setTabGroup(tid, gid);
          },
        },
      ],
    });
  }

  /* ---------------- overflow ---------------- */

  function openOverflow() {
    const sr = scroller.getBoundingClientRect();
    const items = [];
    for (const tb of strip.tabs) {
      const el = root.querySelector(`[data-tab-id="${tb.id}"]`);
      const off = el ? (() => { const r = el.getBoundingClientRect(); return r.right > sr.right + 1 || r.left < sr.left - 1; })() : true;
      const g = tb.groupId ? groupById(tb.groupId) : null;
      items.push({
        label: `${tb.pinned ? '📌 ' : ''}${tb.title}${g ? ` — ${g.name}` : ''}`,
        icon: tb.pinned ? 'push_pin' : (g ? 'label' : 'dns'),
        checked: tb.id === strip.activeId,
        radio: true,
        description: off ? 'Currently scrolled out of view' : '',
        onSelect: () => { activateTab(tb.id); root.querySelector(`[data-tab-id="${tb.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); },
      });
    }
    if (!items.length) items.push({ label: t('notifEmpty'), disabled: true });
    openMenu({ items: [...items, SEPARATOR, { labelKey: 'searchTabs', icon: 'search', onSelect: () => openSearchHub(searchBtn) }], anchor: overflowBtn, placement: 'bottom-end', label: t('overflowTabs') });
  }

  /* ---------------- the four searches ---------------- */

  function tabRow(entry, onPick) {
    const bits = [entry.windowId, entry.stripId, entry.groupName, entry.pinned ? t('pinTab') : null].filter(Boolean);
    return h('button', {
      type: 'button', class: 'ts-row',
      onclick: () => onPick(entry),
    },
    icon(entry.pinned ? 'push_pin' : entry.groupName ? 'label' : 'dns', 16),
    h('div', { class: 'ts-row-main' },
      h('div', { class: 'ts-row-title' }, entry.title),
      h('div', { class: 'ts-row-meta' }, bits.join(' · '))),
    entry.active ? icon('check', 16) : null);
  }

  /**
   * The shared shell for all four searches. Each call creates its OWN search
   * bar — and therefore its own anchored regex builder — so no two searches
   * ever share hidden state.
   */
  function searchPopover({ anchor, titleKey, searchId, placeholderKey, rows, onPick, extra }) {
    const restore = focusMemory();
    const listEl = h('div', { class: 'ts-list', role: 'listbox', 'aria-label': t(titleKey) });
    const countEl = h('div', { class: 'ts-count', role: 'status' });

    const bar = createSearchBar({
      id: searchId,
      labelKey: titleKey,
      placeholderKey,
      persist: false,
      appearanceKey: `search-${searchId}`,
      appearanceLabel: t(titleKey),
      sampleProvider: () => rows().map((r) => r.title).join('\n'),
      onChange: paint,
    });

    function paint() {
      const all = rows();
      const list = bar.isActive ? filterBy(all, bar.predicate, (r) => [r.title, r.groupName || '', r.stripId, r.windowId]) : all;
      clear(listEl);
      countEl.textContent = `${list.length} / ${all.length}`;
      if (!list.length) {
        listEl.appendChild(h('div', { class: 'ts-empty' }, t('noTabsMatched')));
        return;
      }
      for (const entry of list) listEl.appendChild(tabRow(entry, (e) => { onPick(e); close(); }));
    }

    const root2 = h('div', {
      class: 'ts surface-3', role: 'dialog', 'aria-modal': 'false',
      'aria-label': t(titleKey), tabindex: '-1',
    },
    h('header', { class: 'ts-head' }, icon('manage_search', 18), h('span', {}, t(titleKey)), countEl,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: () => close() }, icon('close', 16))),
    h('div', { class: 'ts-searchrow' }, bar.element),
    extra || null,
    listEl);

    appearanceTarget(root2, `tab-search-${searchId}`, t(titleKey));
    layer('menu').appendChild(root2);
    const anchoring = anchorTo(root2, anchor, { placement: 'bottom-end', gap: 8, onDetach: () => close() });
    const untrap = trapFocus(root2);

    root2.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' && e.target === bar.input) { e.preventDefault(); listEl.querySelector('.ts-row')?.focus(); }
    });
    function onDoc(e) { if (!root2.contains(e.target) && !anchor.contains(e.target)) close(); }
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', onDoc, true);
      untrap();
      anchoring.dispose();
      bar.destroy();
      root2.remove();
      restore();
    }

    paint();
    requestAnimationFrame(() => bar.focus());
    return { close, repaint: paint };
  }

  function entriesForStrip(s) {
    return s.tabs.map((tb) => ({
      windowId: s.windowId, stripId: s.id, id: tb.id, title: tb.title,
      pinned: tb.pinned, groupId: tb.groupId,
      groupName: tb.groupId ? (s.groups.find((g) => g.id === tb.groupId)?.name || '') : '',
      collapsed: tb.groupId ? !!s.groups.find((g) => g.id === tb.groupId)?.collapsed : false,
      active: s.activeId === tb.id,
      strip: s,
    }));
  }

  /** (a) the current strip */
  function openStripSearch(anchor = searchBtn) {
    return searchPopover({
      anchor, titleKey: 'searchThisStrip', searchId: `tabs-strip-${id}`, placeholderKey: 'tabSearchPh',
      rows: () => entriesForStrip(strip),
      onPick: (e) => revealEntry(e),
    });
  }

  /** (b) inside one group */
  function openGroupSearch(gid, anchor = searchBtn) {
    const g = groupById(gid);
    if (!g) return null;
    return searchPopover({
      anchor, titleKey: 'searchInGroup', searchId: `tabs-group-${id}-${gid}`, placeholderKey: 'tabSearchPh',
      rows: () => entriesForStrip(strip).filter((e) => e.groupId === gid),
      onPick: (e) => revealEntry(e),
      extra: h('div', { class: 'ts-scope' }, `${t('groupsTitle')}: ${g.name}`),
    });
  }

  /** (c) groups by their visible names and labels */
  function openGroupNameSearch(anchor = searchBtn) {
    const restore = focusMemory();
    const listEl = h('div', { class: 'ts-list', role: 'listbox', 'aria-label': t('searchGroupNames') });
    const countEl = h('div', { class: 'ts-count', role: 'status' });
    const bar = createSearchBar({
      id: `tabs-groupnames-${id}`, labelKey: 'searchGroupNames', placeholderKey: 'groupSearchPh',
      persist: false, appearanceKey: `search-tabs-groupnames-${id}`, appearanceLabel: t('searchGroupNames'),
      sampleProvider: () => strip.groups.map((g) => g.name).join('\n'),
      onChange: paint,
    });
    function paint() {
      const all = strip.groups.map((g) => ({ ...g, count: groupTabs(g.id).length }));
      const list = bar.isActive ? filterBy(all, bar.predicate, (g) => [g.name]) : all;
      clear(listEl);
      countEl.textContent = `${list.length} / ${all.length}`;
      if (!list.length) { listEl.appendChild(h('div', { class: 'ts-empty' }, t('noTabsMatched'))); return; }
      for (const g of list) {
        listEl.appendChild(h('button', {
          type: 'button', class: 'ts-row',
          onclick: () => {
            collapseGroup(g.id, false);
            const first = groupTabs(g.id)[0];
            if (first) activateTab(first.id);
            close();
            requestAnimationFrame(() => root.querySelector(`[data-group-id="${g.id}"] .tab-group-head`)?.focus());
          },
        },
        h('span', { class: 'ts-dot', style: { background: g.color } }),
        h('div', { class: 'ts-row-main' },
          h('div', { class: 'ts-row-title' }, g.name),
          h('div', { class: 'ts-row-meta' }, `${g.count} ${g.count === 1 ? 'tab' : 'tabs'}${g.collapsed ? ` · ${t('collapseGroup')}` : ''}`)),
        h('span', { class: 'ts-row-actions' },
          h('button', {
            type: 'button', class: 'icon-btn', 'aria-label': t('searchInGroup'), title: t('searchInGroup'),
            onclick: (e) => { e.stopPropagation(); close(); openGroupSearch(g.id, anchor); },
          }, icon('search', 15)))));
      }
    }
    const root2 = h('div', { class: 'ts surface-3', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('searchGroupNames'), tabindex: '-1' },
      h('header', { class: 'ts-head' }, icon('topic', 18), h('span', {}, t('searchGroupNames')), countEl,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => close() }, icon('close', 16))),
      h('div', { class: 'ts-searchrow' }, bar.element),
      listEl);
    appearanceTarget(root2, `tab-search-groups-${id}`, t('searchGroupNames'));
    layer('menu').appendChild(root2);
    const anchoring = anchorTo(root2, anchor, { placement: 'bottom-end', gap: 8, onDetach: () => close() });
    const untrap = trapFocus(root2);
    root2.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    function onDoc(e) { if (!root2.contains(e.target) && !anchor.contains(e.target)) close(); }
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', onDoc, true);
      untrap(); anchoring.dispose(); bar.destroy(); root2.remove(); restore();
    }
    paint();
    requestAnimationFrame(() => bar.focus());
    return { close };
  }

  /** (d) master search — every tab, every window, every strip, every group */
  function openMasterSearch(anchor = searchBtn) {
    return searchPopover({
      anchor, titleKey: 'masterTabSearch', searchId: 'tabs-master', placeholderKey: 'tabSearchPh',
      rows: () => allTabEntries(),
      onPick: (e) => revealEntry(e),
      extra: h('div', { class: 'ts-scope' }, t('searchAllTabs')),
    });
  }

  /**
   * Reveal a result. A tab inside a COLLAPSED group is revealed without
   * destroying that collapsed preference: the group expands, the tab is
   * activated and focused, and the preference is restored afterwards unless
   * the user interacts with the group.
   */
  function revealEntry(entry) {
    const target = strips.get(entry.stripId) || strip;
    if (target !== strip) {
      if (entry.external) { bus.emit('tabs:revealExternal', entry); return; }
      target.activateTab(entry.id);
      return;
    }
    const g = entry.groupId ? groupById(entry.groupId) : null;
    if (g?.collapsed) {
      // Expand to reveal, but remember that collapsed was the user's choice:
      // it is restored as soon as they move on to a tab outside this group,
      // so revealing a search result never silently discards the preference.
      g.collapsed = false;
      g.tempExpanded = true;
      render();
      const off = bus.on('tabs:activated', ({ stripId, tab }) => {
        if (stripId !== id) return;
        if (tab && tab.groupId === g.id) return;
        if (!g.tempExpanded) { off(); return; }
        g.tempExpanded = false;
        g.collapsed = true;
        render();
        off();
      });
    }
    activateTab(entry.id);
    requestAnimationFrame(() => {
      const el = root.querySelector(`[data-tab-id="${entry.id}"]`);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el?.focus();
    });
  }

  /** Every tab this app owns, in this window and any registered source. */
  function allTabEntries() {
    const out = [];
    for (const s of strips.values()) out.push(...entriesForStrip(s));
    for (const fn of externalSources) {
      try {
        for (const src of fn() || []) {
          for (const tb of src.tabs || []) {
            out.push({
              windowId: src.windowId || 'Other window', stripId: src.stripId || 'strip',
              id: tb.id, title: tb.title, pinned: !!tb.pinned, groupId: tb.groupId || null,
              groupName: tb.groupName || '', active: !!tb.active, external: true, source: src,
            });
          }
        }
      } catch (err) { console.error('[tabs] external source failed', err); }
    }
    return out;
  }

  /** A hub listing all four searches, opened from the strip's search button. */
  function openSearchHub(anchor) {
    openMenu({
      anchor, placement: 'bottom-end', label: t('searchTabs'),
      items: [
        { labelKey: 'searchThisStrip', icon: 'search', onSelect: () => openStripSearch(anchor) },
        {
          labelKey: 'searchInGroup', icon: 'label',
          disabled: strip.groups.length === 0,
          submenu: strip.groups.map((g) => ({ label: g.name, icon: 'label', onSelect: () => openGroupSearch(g.id, anchor) })),
        },
        { labelKey: 'searchGroupNames', icon: 'topic', onSelect: () => openGroupNameSearch(anchor) },
        { labelKey: 'masterTabSearch', icon: 'manage_search', onSelect: () => openMasterSearch(anchor) },
        SEPARATOR,
        { labelKey: 'closeContaining', icon: 'filter', onSelect: () => bulkClose({ containing: true }) },
        { labelKey: 'closeNotContaining', icon: 'filter', onSelect: () => bulkClose({ containing: false }) },
      ],
    });
  }

  /* ---------------- bulk close ---------------- */

  /**
   * "Close tabs containing text" and "Close tabs NOT containing text".
   *
   * Both directions use the SAME predicate object, negated once — so match
   * mode, flags, casing, Unicode handling and scope cannot drift apart. The
   * match is against the tab's visible label only; page contents and hidden
   * data are never inspected.
   *
   * It never runs on an empty query or an invalid pattern, always previews the
   * affected tabs with the match mode and count, and excludes pinned tabs
   * unless the user explicitly includes them (which re-previews first).
   */
  function bulkClose({ containing = true } = {}) {
    let includePinned = false;
    let scope = 'strip';                 // strip | group | all
    let scopeGroupId = strip.groups[0]?.id || null;

    const previewList = h('div', { class: 'bc-list', role: 'list' });
    const summary = h('div', { class: 'bc-summary', role: 'status', 'aria-live': 'polite' });
    const warn = h('div', { class: 'bc-warn', hidden: true });
    let confirmBtn = null;
    let victims = [];

    const bar = createSearchBar({
      id: `tabs-bulkclose-${id}`,
      labelKey: containing ? 'closeContaining' : 'closeNotContaining',
      placeholderKey: 'tabSearchPh',
      persist: false,
      appearanceKey: `search-tabs-bulkclose-${id}`,
      appearanceLabel: t(containing ? 'closeContaining' : 'closeNotContaining'),
      sampleProvider: () => candidates().map((tb) => tb.title).join('\n'),
      onChange: recompute,
    });

    const pinnedToggle = h('input', { type: 'checkbox', id: uid('bc-pin') });
    pinnedToggle.addEventListener('change', () => { includePinned = pinnedToggle.checked; recompute(); });

    const scopeSel = h('select', { class: 'field-input', 'aria-label': t('matchMode') });
    scopeSel.appendChild(h('option', { value: 'strip' }, t('searchThisStrip')));
    for (const g of strip.groups) scopeSel.appendChild(h('option', { value: `group:${g.id}` }, `${t('searchInGroup')}: ${g.name}`));
    scopeSel.appendChild(h('option', { value: 'all' }, t('searchAllTabs')));
    scopeSel.addEventListener('change', () => {
      const v = scopeSel.value;
      if (v === 'strip') { scope = 'strip'; }
      else if (v === 'all') { scope = 'all'; }
      else { scope = 'group'; scopeGroupId = v.split(':')[1]; }
      recompute();
    });

    function candidates() {
      if (scope === 'group') return groupTabs(scopeGroupId);
      if (scope === 'all') return strips.size > 1 ? Array.from(strips.values()).flatMap((s) => s.tabs) : strip.tabs;
      return strip.tabs;
    }

    function recompute() {
      const st = bar.state;
      const query = st.mode === 'regex' ? st.pattern : st.query;
      clear(previewList);
      warn.hidden = true;
      victims = [];

      if (!query) {
        summary.textContent = t('emptyQueryNoClose');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = t('closeTabsBtn', 0); }
        return;
      }
      const predicate = bar.predicate;
      if (!predicate.ok) {
        warn.hidden = false;
        warn.textContent = t('invalidPattern', predicate.error);
        summary.textContent = '';
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = t('closeTabsBtn', 0); }
        return;
      }

      const decision = bulkCloseSelection({
        pool: candidates(), predicate, query, containing, includePinned,
      });
      const { excludedPins } = decision;
      victims = decision.victims;

      const modeLabel = st.mode === 'regex' ? `${t('regexMode')} ${predicate.describe}` : `${t('plainText')} "${query}"`;
      summary.textContent = `${t('matchMode')}: ${modeLabel} — ${t('matchesTabs', victims.length)}`;
      if (!includePinned && excludedPins) {
        warn.hidden = false;
        warn.textContent = t('pinnedExcluded', excludedPins);
      }
      for (const tb of victims) {
        const g = tb.groupId ? groupById(tb.groupId) : null;
        previewList.appendChild(h('div', { class: 'bc-item', role: 'listitem' },
          icon(tb.pinned ? 'push_pin' : 'dns', 15),
          h('span', { class: 'bc-item-title' }, tb.title),
          g ? h('span', { class: 'bc-item-meta' }, g.name) : null,
          tb.dirty ? h('span', { class: 'bc-item-warn' }, t('unsavedChanges')) : null));
      }
      if (!victims.length) previewList.appendChild(h('div', { class: 'ts-empty' }, t('noTabsMatched')));
      if (confirmBtn) {
        confirmBtn.disabled = victims.length === 0;
        confirmBtn.textContent = t('closeTabsBtn', victims.length);
      }
    }

    openModal({
      title: t(containing ? 'closeContaining' : 'closeNotContaining'),
      width: 620,
      content: h('div', { class: 'bc stack' },
        h('div', { class: 'bc-row' }, bar.element),
        h('div', { class: 'bc-row' },
          h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, t('matchMode')), scopeSel),
          h('label', { class: 'check' }, pinnedToggle, h('span', {}, t('includePinned')))),
        summary, warn,
        h('div', { class: 'bc-preview-title' }, t('preview')),
        previewList),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('closeTabsBtn', 0), kind: 'danger',
          ref: (btn) => { confirmBtn = btn; btn.disabled = true; recompute(); },
          onSelect: () => {
            const kept = [];
            let closedCount = 0;
            for (const tb of victims.slice()) {
              if (tb.dirty) { kept.push(tb); continue; }   // unsaved-work protection stands
              if (closeTab(tb.id, { force: true, silent: true })) closedCount += 1;
              else kept.push(tb);
            }
            if (kept.length) {
              notify.warning(t('unsavedTabWarn', kept.length),
                kept.map((tb) => tb.title).join(', '));
            }
            notify.success(t('closeTabsBtn', closedCount), summary.textContent);
          },
        },
      ],
      onClose: () => bar.destroy(),
    });
    recompute();
  }

  /** Preview + confirm for the fixed-set closes (others / to the right / group). */
  function confirmBulkClose(list, scopeLabel, predicate, includePinned) {
    const victims = includePinned ? list : list.filter((tb) => !tb.pinned);
    const excluded = list.length - victims.length;
    if (!victims.length) { notify.info(t('noTabsMatched'), scopeLabel); return; }
    openModal({
      title: scopeLabel,
      content: h('div', { class: 'stack' },
        h('div', { class: 'bc-summary' }, t('matchesTabs', victims.length)),
        excluded ? h('div', { class: 'bc-warn' }, t('pinnedExcluded', excluded)) : null,
        h('div', { class: 'bc-list', role: 'list' }, ...victims.map((tb) => h('div', { class: 'bc-item', role: 'listitem' },
          icon('dns', 15), h('span', { class: 'bc-item-title' }, tb.title),
          tb.dirty ? h('span', { class: 'bc-item-warn' }, t('unsavedChanges')) : null)))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('closeTabsBtn', victims.length), kind: 'danger',
          onSelect: () => {
            const kept = [];
            for (const tb of victims) {
              if (tb.dirty) { kept.push(tb); continue; }
              closeTab(tb.id, { force: true, silent: true });
            }
            if (kept.length) notify.warning(t('unsavedTabWarn', kept.length), kept.map((tb) => tb.title).join(', '));
          },
        },
      ],
    });
  }

  /* ---------------- group manager ---------------- */

  function openGroupManager(anchor) {
    const restore = focusMemory();
    const listEl = h('div', { class: 'ts-list', role: 'list' });
    const bar = createSearchBar({
      id: `tabs-groupmgr-${id}`, labelKey: 'groupsTitle', placeholderKey: 'groupSearchPh',
      persist: false, appearanceKey: `search-tabs-groupmgr-${id}`, appearanceLabel: t('groupsTitle'),
      sampleProvider: () => strip.groups.map((g) => g.name).join('\n'),
      onChange: paint,
    });
    function paint() {
      const all = strip.groupOrder.map((gid) => groupById(gid)).filter(Boolean);
      const list = bar.isActive ? filterBy(all, bar.predicate, (g) => [g.name]) : all;
      clear(listEl);
      if (!list.length) { listEl.appendChild(h('div', { class: 'ts-empty' }, t('noTabsMatched'))); return; }
      list.forEach((g) => {
        const idx = strip.groupOrder.indexOf(g.id);
        listEl.appendChild(h('div', { class: 'ts-row is-static', role: 'listitem' },
          h('span', { class: 'ts-dot', style: { background: g.color } }),
          h('div', { class: 'ts-row-main' },
            h('div', { class: 'ts-row-title' }, g.name),
            h('div', { class: 'ts-row-meta' }, `${groupTabs(g.id).length} tabs`)),
          h('span', { class: 'ts-row-actions' },
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('up'), title: t('up'), onclick: () => { moveGroup(g.id, idx - 1); paint(); } }, icon('arrow_upward', 15)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('down'), title: t('down'), onclick: () => { moveGroup(g.id, idx + 1); paint(); } }, icon('arrow_downward', 15)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('renameGroup'), title: t('renameGroup'), onclick: () => promptRenameGroup(g) }, icon('edit', 15)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('groupColor'), title: t('groupColor'), onclick: () => promptGroupColor(g) }, icon('palette', 15)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': g.collapsed ? t('expandGroup') : t('collapseGroup'), title: g.collapsed ? t('expandGroup') : t('collapseGroup'), onclick: () => { collapseGroup(g.id); paint(); } }, icon(g.collapsed ? 'expand_more' : 'chevron_right', 15)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('ungroup'), title: t('ungroup'), onclick: () => { removeGroup(g.id); paint(); } }, icon('delete', 15)))));
      });
    }
    const root2 = h('div', { class: 'ts surface-3', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('groupsTitle'), tabindex: '-1' },
      h('header', { class: 'ts-head' }, icon('topic', 18), h('span', {}, t('groupsTitle')),
        h('button', { type: 'button', class: 'btn-text', onclick: () => promptNewGroup([]) }, icon('add', 15), t('newGroup')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => close() }, icon('close', 16))),
      h('div', { class: 'ts-searchrow' }, bar.element),
      listEl);
    appearanceTarget(root2, `tab-groupmgr-${id}`, t('groupsTitle'));
    layer('menu').appendChild(root2);
    const anchoring = anchorTo(root2, anchor, { placement: 'bottom-end', gap: 8, onDetach: () => close() });
    const untrap = trapFocus(root2);
    root2.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    function onDoc(e) { if (!root2.contains(e.target) && !anchor.contains(e.target)) close(); }
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', onDoc, true);
      untrap(); anchoring.dispose(); bar.destroy(); root2.remove(); restore();
    }
    paint();
    const off = bus.on('tabs:groupCreated', paint);
    requestAnimationFrame(() => bar.focus());
    return { close: () => { off(); close(); } };
  }

  /* ---------------- keyboard shortcuts ---------------- */

  function onGlobalKey(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const list = strip.tabs;
      if (!list.length) return;
      const cur = list.findIndex((tb) => tb.id === strip.activeId);
      const next = (cur + (e.shiftKey ? -1 : 1) + list.length) % list.length;
      activateTab(list[next].id);
    } else if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
      const n = Number(e.key);
      const list = strip.tabs;
      const target = n === 9 ? list[list.length - 1] : list[n - 1];
      if (target) { e.preventDefault(); activateTab(target.id); }
    } else if (e.key.toLowerCase() === 'w' && !e.shiftKey) {
      if (strip.activeId) { e.preventDefault(); closeTab(strip.activeId); }
    } else if (e.key.toLowerCase() === 't' && !e.shiftKey) {
      e.preventDefault(); opts.onNewTab?.(strip);
    } else if (e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault(); openMasterSearch(searchBtn);
    }
  }
  window.addEventListener('keydown', onGlobalKey);

  /* ---------------- controller ---------------- */

  Object.assign(strip, {
    element: root, panelHost,
    openTab, closeTab, activateTab, renameTab, setDirty, pinTab, moveTab, setTabGroup,
    createGroup, renameGroup, setGroupColor, setGroupIcon, collapseGroup, removeGroup, moveGroup, pinGroup,
    openStripSearch, openGroupSearch, openGroupNameSearch, openMasterSearch, openSearchHub,
    openGroupManager, bulkClose, render,
    getTab: byId, getGroup: groupById, getPanel: (tid) => byId(tid)?.panel || null,
    entries: () => entriesForStrip(strip),
    destroy() {
      window.removeEventListener('keydown', onGlobalKey);
      offPrefs();
      roving.dispose();
      strips.delete(id);
      root.remove();
    },
  });

  strips.set(id, strip);
  render();
  return strip;
}

/** The strip registry, so later modules can reach the main strip. */
export function getStrip(stripId = 'main') { return strips.get(stripId); }
export function allStrips() { return Array.from(strips.values()); }
export { GROUP_COLORS };
