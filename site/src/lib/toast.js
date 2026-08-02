// lib/toast.js — non-blocking corner notifications, plus the history that
// makes a dismissed one still reviewable.
//
// The rule: anything that only INFORMS is a toast. A modal is reserved for a
// decision the visitor must make before anything else can happen, and this
// site has exactly one of those (a bulk tab close), so it is the only place
// with a dialog.
//
// Errors and warnings do not auto-dismiss. A toast that vanishes before the
// reader looked up has not told them anything, and the one category where that
// matters most is the category most likely to appear while they are looking
// somewhere else.

import { h, clear, uid } from './dom.js';

const TIMEOUT = { info: 5000, success: 4000, progress: 0, warning: 0, error: 0 };
const ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔', progress: '⏳' };

const history = [];
const listeners = new Set();

export function notificationHistory() { return history.slice(); }
export function onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * Show a toast. `actions` are [{ label, onClick, href }] — retry, undo, open,
 * view details. Returns a handle so a progress toast can be updated in place
 * rather than stacking six copies of itself.
 */
export function toast({ kind = 'info', title, body, actions = [], timeout } = {}) {
  const assertive = kind === 'error' || kind === 'warning';
  const region = document.getElementById(assertive ? 'toasts-assertive' : 'toasts');
  const id = uid('toast');

  const entry = { id, kind, title, body, at: new Date().toISOString() };
  history.unshift(entry);
  if (history.length > 200) history.length = 200;
  for (const fn of listeners) fn(entry);

  if (!region) return { close() {}, update() {} };

  const bodyEl = h('p.toast-body', { text: body || '' });
  const el = h('div.toast', {
    'data-kind': kind, role: assertive ? 'alert' : 'status',
    'aria-live': assertive ? 'assertive' : 'polite',
  },
  h('span.toast-icon', { 'aria-hidden': 'true', text: ICON[kind] || 'ℹ️' }),
  h('div.toast-text', null,
    title ? h('p.toast-title', { text: title }) : null,
    body ? bodyEl : null,
    actions.length
      ? h('div.toast-actions', null, actions.map((a) => (a.href
        ? h('a.toast-action', { href: a.href, text: a.label, target: a.external ? '_blank' : null,
          rel: a.external ? 'noopener noreferrer' : null })
        : h('button.toast-action', { type: 'button', text: a.label, onclick: () => { a.onClick?.(); close(); } }))))
      : null),
  h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', text: '✕', onclick: () => close() }));

  region.append(el);

  const ms = timeout ?? TIMEOUT[kind] ?? 5000;
  let timer = ms ? window.setTimeout(() => close(), ms) : null;
  // A toast the pointer is resting on is a toast being read. Freeze it.
  el.addEventListener('pointerenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('focusin', () => { if (timer) { clearTimeout(timer); timer = null; } });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    el.dataset.closing = '1';
    window.setTimeout(() => el.remove(), 180);
  }
  return {
    close,
    update(next) {
      if (next.body !== undefined) bodyEl.textContent = next.body;
      if (next.kind) el.dataset.kind = next.kind;
    },
  };
}

export const notify = {
  info: (title, body, actions) => toast({ kind: 'info', title, body, actions }),
  success: (title, body, actions) => toast({ kind: 'success', title, body, actions }),
  warning: (title, body, actions) => toast({ kind: 'warning', title, body, actions }),
  error: (title, body, actions) => toast({ kind: 'error', title, body, actions }),
};

/**
 * The one modal on the site: a decision that must be made before anything
 * continues. Everything else is a toast, on purpose.
 *
 * Returns a promise for `true`/`false`. Escape and the backdrop both mean
 * "no" — a destructive confirmation whose only exit is the destructive button
 * is not a confirmation.
 */
export function confirmDialog({ title, body, detail, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = uid('dlg-title');
    const panel = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2.dialog-title', { id: titleId, text: title }),
      h('p.dialog-body', { text: body }),
      detail ? h('pre.dialog-detail', { text: detail }) : null,
      h('div.dialog-actions', null,
        h('button.btn.btn-text', { type: 'button', text: cancelLabel, onclick: () => done(false) }),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-filled'}`, { type: 'button', text: confirmLabel, onclick: () => done(true) })));
    const scrim = h('div.scrim', { onclick: (e) => { if (e.target === scrim) done(false); } }, panel);

    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    panel.querySelector('button').focus();

    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      if (previous && previous.focus) previous.focus();
      resolve(value);
    }
  });
}

/** The notification centre: dismissed toasts stay reviewable. */
export function renderNotificationCentre(host) {
  clear(host);
  if (!history.length) {
    host.append(h('p.muted', { text: 'No notifications yet.' }));
    return;
  }
  host.append(h('ul.notice-list', null, history.map((n) => h('li.notice', { 'data-kind': n.kind },
    h('span.notice-icon', { 'aria-hidden': 'true', text: ICON[n.kind] || 'ℹ️' }),
    h('div', null,
      h('p.notice-title', { text: n.title || n.kind }),
      n.body ? h('p.notice-body', { text: n.body }) : null,
      h('p.notice-time', { text: n.at }))))));
}
