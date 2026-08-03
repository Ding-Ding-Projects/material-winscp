// ui/notifications.js — corner toasts and the notification centre.
//
// The rule this implements: anything that only INFORMS is a non-blocking toast
// in a screen corner. Modal dialogs are reserved for decisions the user must
// make before continuing, and this module never opens one.
//
//   notify.info / success / progress / warning / error
//
// Behaviour
//   * bottom-right corner, stacking without overlap, newest nearest the corner
//   * info/success/progress auto-dismiss on the configured timeout
//   * warnings and errors PERSIST until dismissed — a failure never vanishes
//     while the user is looking away
//   * title + body + optional actions and links
//   * announced to assistive technology (polite for info, assertive for error)
//   * every toast, dismissed or not, is kept in the notification centre
//
// Toasts pause their timer on hover and on keyboard focus, so a toast can
// always be read and its action can always be reached.

import { h, icon, layer, uid, announce, trapFocus, focusMemory, anchorTo, appearanceTarget } from '../dom.js';
import { t, bindText } from '../i18n.js';
import { store, bus, persistCurrent } from '../state.js';
import { createSearchBar, filterBy, noMatchMessage } from './searchbar.js';

const KIND_META = {
  info: { icon: 'info', role: 'status', assertive: false, persist: false },
  success: { icon: 'check_circle', role: 'status', assertive: false, persist: false },
  progress: { icon: 'pending', role: 'status', assertive: false, persist: false },
  warning: { icon: 'warning', role: 'alert', assertive: true, persist: true },
  error: { icon: 'error', role: 'alert', assertive: true, persist: true },
};

const history = [];              // newest first
const live = new Map();          // id -> toast record
const listeners = new Set();
let stackEl = null;
let historyHydrated = false;

function centreLimit() {
  const n = Number(store.get('notifications.centreLimit'));
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, Math.floor(n))) : 200;
}
function defaultDuration() { return Math.max(2, Number(store.get('notifications.durationSec')) || 6) * 1000; }
function reducedMotion() {
  return !!store.get('theme.reduceMotion')
    || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function boundedProgress(value) {
  if (value === true) return true;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function normalizedProgress(value) {
  return value == null ? null : boundedProgress(value);
}

/**
 * Keep only reviewable data in the persisted notification history. Action
 * callbacks are executable renderer state and must never cross a config write
 * or be revived after a reload.
 */
export function serializeNotification(record) {
  if (!record || typeof record !== 'object' || !String(record.id || '')) return null;
  const snapshot = {
    id: String(record.id),
    kind: KIND_META[record.kind] ? record.kind : 'info',
    title: String(record.title || ''),
    body: String(record.body || ''),
    at: Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now(),
    read: record.read === true,
    dismissed: record.dismissed === true,
  };
  if (record.progress != null) {
    const progress = boundedProgress(record.progress);
    if (progress != null) snapshot.progress = progress;
  }
  return snapshot;
}

/** Restore a safe, action-free history row from the stored preference. */
export function restoreNotification(snapshot) {
  const restored = serializeNotification(snapshot);
  return restored ? { ...restored, actions: [] } : null;
}

function hydrateHistory() {
  if (historyHydrated) return;
  historyHydrated = true;
  const saved = store.get('notifications.history');
  if (!Array.isArray(saved)) return;
  for (const snapshot of saved) {
    const restored = restoreNotification(snapshot);
    if (restored) history.push(restored);
  }
  if (history.length > centreLimit()) history.length = centreLimit();
}

function persistHistory() {
  store.set('notifications.history', history.map(serializeNotification).filter(Boolean));
  persistCurrent('notifications');
}

function stack() {
  if (stackEl && stackEl.isConnected) return stackEl;
  stackEl = h('div', {
    class: 'toast-stack', id: 'toast-stack',
    'aria-label': 'Notifications', role: 'region',
  });
  appearanceTarget(stackEl, 'toast-stack', 'Notification toasts');
  layer('toast').appendChild(stackEl);
  return stackEl;
}

function keepLatestToastVisible() {
  if (!stackEl) return;
  const distanceFromEnd = stackEl.scrollHeight - stackEl.scrollTop - stackEl.clientHeight;
  if (distanceFromEnd <= 48) stackEl.scrollTop = stackEl.scrollHeight;
}

function emitChange() {
  hydrateHistory();
  const unread = history.filter((n) => !n.read).length;
  bus.emit('notifications:changed', { unread, total: history.length });
  for (const fn of Array.from(listeners)) { try { fn({ unread, total: history.length, history }); } catch (err) { console.error(err); } }
}

/** subscribe(fn) — the title bar badge and the centre both use this. */
export function subscribeNotifications(fn) {
  hydrateHistory();
  listeners.add(fn);
  fn({ unread: history.filter((n) => !n.read).length, total: history.length, history });
  return () => listeners.delete(fn);
}

export function notificationHistory() { hydrateHistory(); return history.slice(); }
export function unreadCount() { hydrateHistory(); return history.filter((n) => !n.read).length; }
export function markAllRead() {
  hydrateHistory();
  history.forEach((n) => { n.read = true; });
  persistHistory();
  emitChange();
}
export function clearHistory() {
  hydrateHistory();
  history.length = 0;
  persistHistory();
  emitChange();
}

/* ------------------------------------------------------------------ */
/* toasts                                                              */
/* ------------------------------------------------------------------ */

/**
 * show(opts) -> handle
 *
 * opts:
 *   kind      info | success | progress | warning | error
 *   title     string (or titleKey for an i18n key)
 *   body      string (or bodyKey)
 *   actions   [{ label, onSelect, href }]  — links open through window.api
 *   duration  ms; 0 or Infinity keeps it until dismissed
 *   progress  0..1 for a determinate bar, or true for indeterminate
 *   id        reuse an id to UPDATE an existing toast in place
 */
export function show(opts = {}) {
  hydrateHistory();
  const kind = KIND_META[opts.kind] ? opts.kind : 'info';
  const meta = KIND_META[kind];
  const id = opts.id || uid('toast');

  const record = {
    id, kind,
    title: opts.titleKey ? t(opts.titleKey, ...(opts.titleParams || [])) : (opts.title || ''),
    body: opts.bodyKey ? t(opts.bodyKey, ...(opts.bodyParams || [])) : (opts.body || ''),
    actions: opts.actions || [],
    at: Date.now(),
    read: false,
    dismissed: false,
    progress: normalizedProgress(opts.progress),
  };

  const existing = live.get(id);
  if (existing) {
    existing.update(record);
    return existing.handle;
  }

  const bar = record.progress != null
    ? h('div', {
      class: `toast-progress${record.progress === true ? ' is-indeterminate' : ''}`,
      role: 'progressbar',
      'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': record.progress === true ? null : String(Math.round(record.progress * 100)),
    }, h('div', { class: 'toast-progress-fill' }))
    : null;

  const titleEl = h('div', { class: 'toast-title' }, record.title);
  const bodyEl = h('div', { class: 'toast-body' }, record.body);
  const actionsEl = h('div', { class: 'toast-actions' });

  const closeBtn = h('button', {
    type: 'button', class: 'icon-btn toast-close',
    'aria-label': t('close'), title: t('close'),
    onclick: () => dismiss('user'),
  }, icon('close', 16));

  const el = h('div', {
    class: `toast is-${kind}${reducedMotion() ? ' no-motion' : ''}`,
    role: meta.role, 'aria-live': meta.assertive ? 'assertive' : 'polite',
    'data-toast-id': id, tabindex: '0',
  },
  h('span', { class: 'toast-icon' }, icon(meta.icon, 20)),
  h('div', { class: 'toast-main' }, titleEl, record.body ? bodyEl : null, actionsEl, bar),
  closeBtn);

  appearanceTarget(el, `toast-${kind}`, `${kind[0].toUpperCase()}${kind.slice(1)} notification`);

  function renderActions(list) {
    actionsEl.textContent = '';
    for (const a of list || []) {
      const btn = h('button', {
        type: 'button', class: 'toast-action',
        onclick: (e) => {
          e.stopPropagation();
          try { a.onSelect?.(); } catch (err) { console.error('[toast] action failed', err); }
          if (a.dismiss !== false) dismiss('action');
        },
      }, a.label);
      actionsEl.appendChild(btn);
    }
  }
  renderActions(record.actions);

  /* timers — paused while hovered or focused, so a toast is always readable */
  const persist = opts.duration === 0 || opts.duration === Infinity || meta.persist;
  const total = opts.duration && Number.isFinite(opts.duration) ? opts.duration : defaultDuration();
  let remaining = total;
  let timer = 0;
  let startedAt = 0;

  function resume() {
    if (persist || record.dismissed) return;
    startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => dismiss('timeout'), remaining);
  }
  function pause() {
    if (persist || !startedAt) return;
    clearTimeout(timer);
    remaining = Math.max(600, remaining - (Date.now() - startedAt));
    startedAt = 0;
  }
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss('user'); }
  });

  function dismiss(reason) {
    if (record.dismissed) return;
    record.dismissed = true;
    clearTimeout(timer);
    live.delete(id);
    persistHistory();
    el.classList.add('is-leaving');
    const finish = () => { el.remove(); bus.emit('notifications:dismissed', { id, reason }); };
    if (reducedMotion()) finish();
    else setTimeout(finish, 180);
  }

  function update(next) {
    Object.assign(record, next);
    record.progress = normalizedProgress(record.progress);
    titleEl.textContent = record.title;
    bodyEl.textContent = record.body;
    if (record.body && !bodyEl.isConnected) el.querySelector('.toast-main').insertBefore(bodyEl, actionsEl);
    renderActions(record.actions);
    if (bar && record.progress != null && record.progress !== true) {
      bar.classList.remove('is-indeterminate');
      bar.setAttribute('aria-valuenow', String(Math.round(record.progress * 100)));
      bar.querySelector('.toast-progress-fill').style.width = `${Math.round(record.progress * 100)}%`;
    }
    remaining = total;
    persistHistory();
    resume();
  }

  if (bar && record.progress != null && record.progress !== true) {
    bar.querySelector('.toast-progress-fill').style.width = `${Math.round(record.progress * 100)}%`;
  }

  stack().appendChild(el);
  keepLatestToastVisible();
  resume();

  history.unshift(record);
  if (history.length > centreLimit()) history.length = centreLimit();
  persistHistory();
  emitChange();

  announce(`${record.title}${record.body ? `. ${record.body}` : ''}`, meta.assertive);

  const handle = { id, dismiss, update, element: el, get record() { return { ...record }; } };
  live.set(id, { handle, update, dismiss, record });
  return handle;
}

export const notify = {
  info: (title, body, opts) => show({ kind: 'info', title, body, ...opts }),
  success: (title, body, opts) => show({ kind: 'success', title, body, ...opts }),
  progress: (title, body, opts) => show({ kind: 'progress', title, body, duration: 0, ...opts }),
  warning: (title, body, opts) => show({ kind: 'warning', title, body, ...opts }),
  error: (title, body, opts) => show({ kind: 'error', title, body, ...opts }),
  show,
  dismiss(id) { live.get(id)?.dismiss('api'); },
  dismissAll() { for (const rec of Array.from(live.values())) rec.dismiss('api'); },
};

/* ------------------------------------------------------------------ */
/* notification centre                                                 */
/* ------------------------------------------------------------------ */

let centre = null;

/**
 * The centre keeps every notification reviewable after it is dismissed, with
 * the app's standard search bar (and therefore the regex builder) over it.
 */
export function openNotificationCentre(anchorEl) {
  hydrateHistory();
  if (centre) { centre.close(); return null; }
  const restoreFocus = focusMemory();

  const listEl = h('div', { class: 'nc-list', role: 'list' });
  const emptyEl = h('div', { class: 'nc-empty' });

  const search = createSearchBar({
    id: 'notification-centre',
    labelKey: 'search',
    placeholderKey: 'search',
    compact: true,
    appearanceKey: 'search-notification-centre',
    appearanceLabel: 'Notification centre search',
    sampleProvider: () => history.slice(0, 40).map((n) => `${n.title} ${n.body}`).join('\n'),
    onChange: render,
  });

  function render() {
    const predicate = search.predicate;
    const rows = search.isActive
      ? filterBy(history, predicate, (n) => [n.title, n.body, n.kind])
      : history.slice();
    listEl.textContent = '';
    emptyEl.textContent = '';
    if (!rows.length) {
      emptyEl.appendChild(h('div', {}, history.length
        ? noMatchMessage(predicate, 'the notification history')
        : t('notifEmpty')));
      return;
    }
    for (const n of rows) {
      const meta = KIND_META[n.kind] || KIND_META.info;
      listEl.appendChild(h('div', { class: `nc-item is-${n.kind}${n.read ? '' : ' is-unread'}`, role: 'listitem' },
        h('span', { class: 'nc-icon' }, icon(meta.icon, 18)),
        h('div', { class: 'nc-main' },
          h('div', { class: 'nc-title' }, n.title),
          n.body ? h('div', { class: 'nc-body' }, n.body) : null,
          h('div', { class: 'nc-time' }, new Date(n.at).toLocaleString())),
        h('div', { class: 'nc-actions' }, ...(n.actions || []).map((a) => h('button', {
          type: 'button', class: 'toast-action',
          onclick: () => { try { a.onSelect?.(); } catch (err) { console.error(err); } },
        }, a.label)))));
    }
  }

  const root = h('div', {
    class: 'nc surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-label': t('notifCenter'), tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('notifications', 18),
    h('span', { class: 'nc-head-title' }, t('notifCenter')),
    h('button', { type: 'button', class: 'btn-text', onclick: () => { clearHistory(); render(); } }, t('notifClear')),
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: () => close(),
    }, icon('close', 18))),
  h('div', { class: 'nc-searchrow' }, search.element),
  listEl, emptyEl);

  appearanceTarget(root, 'notification-centre', 'Notification centre');
  layer('menu').appendChild(root);
  const anchoring = anchorEl
    ? anchorTo(root, anchorEl, { placement: 'bottom-end', gap: 8, onDetach: () => close() })
    : null;
  if (!anchoring) { root.style.position = 'fixed'; root.style.right = '16px'; root.style.top = '56px'; }
  const untrap = trapFocus(root);

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  function onDocPointer(e) {
    if (root.contains(e.target)) return;
    if (anchorEl?.contains(e.target)) return;
    close();
  }
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);

  function close() {
    document.removeEventListener('pointerdown', onDocPointer, true);
    untrap();
    anchoring?.dispose();
    search.destroy();
    root.remove();
    centre = null;
    restoreFocus();
  }

  render();
  markAllRead();
  centre = { close, element: root };
  requestAnimationFrame(() => root.focus());
  return centre;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

let started = false;

/** Bridge internal failures onto toasts, so nothing fails silently. */
export function startNotifications() {
  if (started) return;
  started = true;

  bus.on('config:saveFailed', ({ error }) => {
    notify.error('Settings were not saved', `The change is applied to this window but could not be written to the configuration file: ${error}`);
  });
  bus.on('config:loadFailed', ({ error }) => {
    notify.warning('Settings could not be read', `Defaults are in use for this session. The stored configuration was not changed. Reason: ${error}`);
  });

  window.addEventListener('error', (e) => {
    if (!e?.message) return;
    notify.error('Something went wrong', `${e.message}${e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason?.message || String(e?.reason || 'unknown');
    notify.error('An operation failed', reason);
  });

  // Keep the toast stack's corner in sync with the preference.
  store.subscribe('notifications.position', (pos) => {
    stack().dataset.position = pos || 'bottom-right';
  });
}

export { bindText };
