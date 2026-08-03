// ui/contextmenu.js — the M3 menu system used for every menu in the app.
//
// One implementation serves context menus, dropdown menus, the tab overflow
// surface and toolbar menus, so keyboard behaviour and roles are identical
// everywhere: role="menu" / "menuitem" / "menuitemcheckbox" / "menuitemradio",
// arrow-key navigation, Home/End, typeahead, Escape to close, Right/Left for
// submenus, and focus returned to whatever opened it.
//
// Menu contributions
//   registerContextMenu(el, provider)  — items for a specific element/subtree
//   addMenuContributor(fn)             — items appended to EVERY menu
//
// The "Edit appearance…" entry is added by a global contributor (registered by
// ui/appearance.js) for any element carrying data-ap, so no module wires it up
// by hand. Shift+right-click opens that editor directly.

import { h, icon, layer, anchorTo, focusMemory, uid, clamp, closestAppearanceTarget } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { getCommand, normalizeShortcut as normalizeCommandShortcut } from './commands.js';

const providers = new WeakMap();          // element -> provider(ctx) => items[]
const contributors = new Set();           // fn(ctx) => items[]
let openStack = [];                       // innermost menu last

/** Items for a specific element (and its descendants, via closest lookup). */
export function registerContextMenu(el, provider) {
  providers.set(el, provider);
  el.dataset.hasMenu = '1';
  return () => { providers.delete(el); delete el.dataset.hasMenu; };
}

/** Items appended to every menu. Used for "Edit appearance…". */
export function addMenuContributor(fn) {
  contributors.add(fn);
  return () => contributors.delete(fn);
}

export const SEPARATOR = { separator: true };

const MAC_PLATFORMS = /(?:darwin|mac|macos|osx)/i;
const WIN_PLATFORMS = /(?:win32|windows|win)/i;

/**
 * The action registry stores WinSCP's names (Ctrl+Left, Num +, ...), while a
 * menu is a user-facing surface. Keep that conversion here so an action
 * descriptor and a hand-written provider cannot disagree about what the user
 * should press. `platform` is injectable for deterministic tests.
 */
export function menuPlatform(platform) {
  if (platform) return String(platform).toLowerCase();
  const reported = typeof navigator !== 'undefined'
    ? (navigator.userAgentData?.platform || navigator.platform || '')
    : '';
  if (reported) {
    if (MAC_PLATFORMS.test(reported)) return 'darwin';
    if (WIN_PLATFORMS.test(reported)) return 'win32';
    return reported.toLowerCase();
  }
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  return 'win32';
}

function actionName(item) {
  const value = item?.action ?? item?.actionId ?? item?.command;
  if (typeof value === 'string') return value;
  if (value && typeof value.name === 'string') return value.name;
  return '';
}

/** Resolve the raw shortcut without applying display-specific notation. */
export function shortcutForAction(item) {
  const explicit = item?.shortcut;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit).trim();
  const name = actionName(item);
  if (!name) return '';
  try { return getCommand(name)?.shortcut || ''; }
  catch { return ''; }
}

function shortcutTokens(raw) {
  const canonical = normalizeCommandShortcut(raw);
  if (!canonical) return [];
  const tokens = [];
  let rest = canonical;
  for (;;) {
    const modifier = rest.match(/^(Ctrl|Alt|Shift|Meta)\+/);
    if (!modifier) break;
    tokens.push(modifier[1]);
    rest = rest.slice(modifier[0].length);
  }
  if (rest) tokens.push(rest);
  return tokens;
}

function displayKey(key) {
  return {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Escape: 'Esc', Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn',
    Enter: '↵', Backspace: '⌫',
  }[key] || key;
}

function displayModifier(modifier, platform) {
  if (!MAC_PLATFORMS.test(platform)) return modifier;
  return {
    Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘',
  }[modifier] || modifier;
}

/** The visible, platform-native-looking tokens for one menu shortcut. */
export function shortcutPartsForMenu(item, options = {}) {
  const raw = shortcutForAction(item);
  if (!raw) return [];
  const platform = menuPlatform(options.platform);
  const tokens = shortcutTokens(raw);
  return tokens.map((token, index) =>
    index < tokens.length - 1
      ? displayModifier(token, platform)
      : displayKey(token));
}

/** A compact text form used by tests, telemetry and non-DOM menu consumers. */
export function shortcutForMenu(item, options = {}) {
  return shortcutPartsForMenu(item, options).join('+');
}

/** ARIA's spelling uses key names rather than the glyphs shown to sighted users. */
export function ariaShortcutForMenu(item) {
  const raw = shortcutForAction(item);
  return raw ? normalizeCommandShortcut(raw) : '';
}

/** Normalize one descriptor while leaving its behaviour and state untouched. */
export function normalizeMenuItem(item, options = {}) {
  const parts = shortcutPartsForMenu(item, options);
  return {
    ...item,
    shortcut: parts.join('+'),
    shortcutParts: parts,
    ariaKeyShortcuts: ariaShortcutForMenu(item),
  };
}

/** Close every open menu. */
export function closeAllMenus() {
  while (openStack.length) openStack.pop().dispose(true);
}

function normalize(items, options = {}) {
  return (items || []).filter(Boolean).map((it) => {
    if (it === SEPARATOR || it.separator) return { separator: true };
    const normalized = normalizeMenuItem(it, options);
    return {
      id: it.id || uid('mi'),
      label: it.labelKey ? t(it.labelKey) : (it.label ?? ''),
      description: it.description || '',
      icon: it.icon || null,
      shortcut: normalized.shortcut,
      shortcutParts: normalized.shortcutParts,
      ariaKeyShortcuts: normalized.ariaKeyShortcuts || null,
      checked: it.checked,
      radio: !!it.radio,
      disabled: !!it.disabled,
      danger: !!it.danger,
      submenu: it.submenu || null,
      onSelect: it.onSelect || null,
      keepOpen: !!it.keepOpen,
      raw: it,
    };
  });
}

/** Collapse runs of separators and drop leading/trailing ones. */
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (it.separator) {
      if (!out.length || out[out.length - 1].separator) continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * openMenu(opts) — the single entry point.
 *
 * opts:
 *   items      array of item descriptors (required, may be a function)
 *   anchor     element to attach to, OR
 *   x, y       viewport coordinates (right-click position)
 *   placement  passed to anchorTo when anchoring
 *   label      accessible name for the menu
 *   onClose()
 *   parent     internal: the parent menu handle for submenus
 */
export function openMenu(opts = {}) {
  const isSub = !!opts.parent;
  if (!isSub) closeAllMenus();

  const restoreFocus = isSub ? null : focusMemory();
  const items = tidy(normalize(typeof opts.items === 'function' ? opts.items() : opts.items, opts));
  if (!items.length) { if (!isSub) restoreFocus?.(); return null; }

  const root = h('div', {
    class: 'menu surface-2', role: 'menu', tabindex: '-1',
    'aria-label': opts.label || t('menuSearchPh'),
  });
  // A long bilingual label plus a shortcut must remain usable on a narrow
  // window. The component stylesheet supplies the normal 220–420px range;
  // these caps only make the range viewport-safe.
  root.style.minWidth = 'min(220px, calc(100vw - 12px))';
  root.style.maxWidth = 'min(420px, calc(100vw - 12px))';

  let subHandle = null;
  let typeahead = '';
  let typeaheadTimer = 0;

  const rows = [];
  for (const it of items) {
    if (it.separator) {
      root.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const role = it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : (it.submenu ? 'menuitem' : 'menuitem');
    const row = h('div', {
      class: `menu-item${it.disabled ? ' is-disabled' : ''}${it.danger ? ' is-danger' : ''}`,
      role, tabindex: '-1',
      'aria-disabled': it.disabled ? 'true' : null,
      'aria-haspopup': it.submenu ? 'menu' : null,
      'aria-expanded': it.submenu ? 'false' : null,
      'aria-keyshortcuts': it.ariaKeyShortcuts || null,
      'data-id': it.id,
      title: it.description || null,
    },
    h('span', { class: 'menu-lead' },
      it.checked !== undefined
        ? (it.checked ? icon('check', 16) : h('span', { class: 'menu-lead-blank' }))
        : it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-lead-blank' })),
    h('span', { class: 'menu-label' }, it.label),
    it.shortcut ? h('span', { class: 'menu-shortcut', 'aria-label': it.ariaKeyShortcuts || it.shortcut }, ...kbdParts(it.shortcutParts || it.shortcut)) : null,
    it.submenu ? icon('chevron_right', 16) : null);

    if (it.checked !== undefined) row.setAttribute('aria-checked', String(!!it.checked));

    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); activate(it, row); });
    row.addEventListener('mouseenter', () => {
      focusRow(row);
      if (it.submenu) openSubmenu(it, row);
      else closeSubmenu();
    });
    rows.push({ it, row });
    root.appendChild(row);
  }

  layer('menu').appendChild(root);

  let anchoring = null;
  if (opts.anchor) {
    anchoring = anchorTo(root, opts.anchor, { placement: opts.placement || 'bottom-start', gap: 4, onDetach: () => dispose() });
  } else {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // Cap the height BEFORE measuring, or a long menu is clamped against a
    // height it will never have and runs off the bottom of the window.
    root.style.maxHeight = `${Math.max(1, vh - 12)}px`;
    const r = root.getBoundingClientRect();
    const left = clamp(opts.x ?? 0, 6, Math.max(6, vw - r.width - 6));
    const top = clamp(opts.y ?? 0, 6, Math.max(6, vh - r.height - 6));
    root.style.position = 'fixed';
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function focusRow(row) {
    rows.forEach((r) => r.row.classList.toggle('is-active', r.row === row));
    row.focus();
  }

  function enabledRows() { return rows.filter((r) => !r.it.disabled); }

  function move(delta) {
    const list = enabledRows();
    if (!list.length) return;
    const cur = list.findIndex((r) => r.row === document.activeElement);
    let next = cur < 0 ? (delta > 0 ? 0 : list.length - 1) : cur + delta;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    focusRow(list[next].row);
  }

  function closeSubmenu() {
    if (subHandle) { subHandle.dispose(true); subHandle = null; }
    rows.forEach((r) => { if (r.it.submenu) r.row.setAttribute('aria-expanded', 'false'); });
  }

  function openSubmenu(it, row) {
    if (subHandle && subHandle.ownerId === it.id) return;
    closeSubmenu();
    row.setAttribute('aria-expanded', 'true');
    subHandle = openMenu({
      items: it.submenu, anchor: row, placement: 'right-start',
      label: it.label, parent: handle, platform: opts.platform,
    });
    if (subHandle) subHandle.ownerId = it.id;
  }

  function activate(it, row) {
    if (it.disabled) return;
    if (it.submenu) { openSubmenu(it, row); subHandle?.focusFirst(); return; }
    const keep = it.keepOpen;
    try { it.onSelect?.(it.raw); } catch (err) { console.error('[menu] item handler failed', err); }
    bus.emit('menu:selected', { id: it.id, label: it.label });
    if (!keep) closeAllMenus();
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); const l = enabledRows(); if (l.length) focusRow(l[0].row); }
    else if (e.key === 'End') { e.preventDefault(); const l = enabledRows(); if (l.length) focusRow(l[l.length - 1].row); }
    else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (isSub) { opts.parent.focusOwner(opts.parentRowId); dispose(); }
      else closeAllMenus();
    } else if (e.key === 'ArrowRight') {
      const entry = rows.find((r) => r.row === document.activeElement);
      if (entry?.it.submenu) { e.preventDefault(); openSubmenu(entry.it, entry.row); subHandle?.focusFirst(); }
    } else if (e.key === 'ArrowLeft') {
      if (isSub) { e.preventDefault(); dispose(); opts.parent.focusOwner(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      const entry = rows.find((r) => r.row === document.activeElement);
      if (entry) { e.preventDefault(); activate(entry.it, entry.row); }
    } else if (e.key === 'Tab') {
      e.preventDefault(); closeAllMenus();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      clearTimeout(typeaheadTimer);
      typeahead += e.key.toLowerCase();
      typeaheadTimer = setTimeout(() => { typeahead = ''; }, 700);
      const hit = enabledRows().find((r) => r.it.label.toLowerCase().startsWith(typeahead));
      if (hit) { e.preventDefault(); focusRow(hit.row); }
    }
  }
  root.addEventListener('keydown', onKey);

  function onDocPointer(e) {
    if (root.contains(e.target)) return;
    if (subHandle?.element.contains(e.target)) return;
    if (opts.anchor?.contains(e.target)) return;
    if (isSub) return;                                   // parent handles it
    closeAllMenus();
  }
  if (!isSub) setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);

  let disposed = false;
  function dispose(silent) {
    if (disposed) return;
    disposed = true;
    closeSubmenu();
    clearTimeout(typeaheadTimer);
    document.removeEventListener('pointerdown', onDocPointer, true);
    root.removeEventListener('keydown', onKey);
    anchoring?.dispose();
    root.remove();
    const idx = openStack.indexOf(handle);
    if (idx >= 0) openStack.splice(idx, 1);
    if (!silent) opts.onClose?.();
    if (!isSub && !silent) restoreFocus?.();
    else if (!isSub) restoreFocus?.();
  }

  const handle = {
    element: root,
    dispose,
    focusFirst() { const l = enabledRows(); if (l.length) focusRow(l[0].row); },
    focusOwner() { root.focus(); },
    get items() { return items; },
  };
  openStack.push(handle);
  if (!isSub) requestAnimationFrame(() => handle.focusFirst());
  return handle;
}

function kbdParts(shortcut) {
  const parts = Array.isArray(shortcut) ? shortcut : String(shortcut).split('+');
  return parts.map((part, i, arr) => [
    h('kbd', {}, part.trim()),
    i < arr.length - 1 ? h('span', { class: 'kbd-plus' }, '+') : null,
  ]).flat().filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* the global context-menu handler                                     */
/* ------------------------------------------------------------------ */

function collectItems(ctx) {
  const items = [];
  let node = ctx.target;
  const seen = new Set();
  while (node && node !== document) {
    const provider = providers.get(node);
    if (provider && !seen.has(provider)) {
      seen.add(provider);
      try {
        const got = provider({ ...ctx, element: node });
        if (got && got.length) { if (items.length) items.push(SEPARATOR); items.push(...got); }
      } catch (err) { console.error('[menu] provider failed', err); }
    }
    node = node.parentNode;
  }
  for (const fn of contributors) {
    try {
      const got = fn(ctx);
      if (got && got.length) { if (items.length) items.push(SEPARATOR); items.push(...got); }
    } catch (err) { console.error('[menu] contributor failed', err); }
  }
  return items;
}

let installed = false;

/**
 * Install the document-level handlers. Called once by app.js.
 *
 *   right-click            -> the element's menu, with "Edit appearance…"
 *   Shift+right-click      -> the appearance editor for that element directly
 *   Shift+F10 / ContextMenu key -> the same menu from the keyboard
 */
export function installContextMenus() {
  if (installed) return;
  installed = true;

  document.addEventListener('contextmenu', (e) => {
    // A text field keeps the native menu so the OS clipboard entries survive,
    // unless the field itself registered a provider.
    const editable = e.target.closest('input,textarea,[contenteditable="true"]');
    const apTarget = closestAppearanceTarget(e.target);

    if (e.shiftKey && apTarget) {
      e.preventDefault();
      bus.emit('appearance:open', { key: apTarget.dataset.ap, element: apTarget, label: apTarget.dataset.apLabel });
      return;
    }
    if (editable && !editable.dataset.hasMenu && !editable.closest('[data-has-menu]')) return;

    const ctx = { target: e.target, x: e.clientX, y: e.clientY, event: e, appearanceTarget: apTarget };
    const items = collectItems(ctx);
    if (!items.length) return;
    e.preventDefault();
    openMenu({ items, x: e.clientX, y: e.clientY, label: 'Context menu' });
  });

  document.addEventListener('keydown', (e) => {
    const isMenuKey = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
    if (!isMenuKey) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    const r = el.getBoundingClientRect();
    const apTarget = closestAppearanceTarget(el);
    const ctx = { target: el, x: r.left + 8, y: r.bottom, event: e, appearanceTarget: apTarget, keyboard: true };
    const items = collectItems(ctx);
    if (!items.length) return;
    e.preventDefault();
    openMenu({ items, anchor: el, placement: 'bottom-start', label: 'Context menu' });
  });

  // Escape anywhere closes menus; a window blur does too.
  window.addEventListener('blur', () => closeAllMenus());
}

/**
 * A dropdown attached to a button. The button gets the right ARIA wiring so a
 * screen reader announces it as a menu button.
 */
export function attachMenuButton(button, itemsFn, opts = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  let open = null;
  const toggle = (e) => {
    e?.preventDefault();
    if (open) { open.dispose(); open = null; return; }
    open = openMenu({
      items: itemsFn, anchor: button, placement: opts.placement || 'bottom-start',
      label: opts.label || button.getAttribute('aria-label') || button.textContent,
      onClose: () => { open = null; button.setAttribute('aria-expanded', 'false'); },
    });
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  button.addEventListener('click', toggle);
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { toggle(e); }
  });
  return { toggle, close: () => { open?.dispose(); open = null; } };
}
