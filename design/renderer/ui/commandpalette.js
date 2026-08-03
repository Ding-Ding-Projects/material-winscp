// ui/commandpalette.js — the keyboard route to commands and settings.
//
// The command registry is the source of truth for actions. This surface takes
// a live snapshot of that registry when it opens, then adds every page and
// control declared by the Preferences schema as a destination. Selecting a
// setting delegates to the real Preferences surface; the palette never keeps
// a second setting value or pretends that a read-only option is editable here.

import { h, icon, clear, layer, focusMemory, announce, appearanceTarget, trapFocus } from '../dom.js';
import { defineStrings, subscribe as subscribeI18n, t, tPair } from '../i18n.js';
import { store, persistCurrent, bus } from '../state.js';
import { listCommands, runCommand, registerCommand, registerTitlebarAction } from '../app.js';
import { createSearchBar } from './searchbar.js';
import { ensureStyle } from './commands.js';
import {
  PAGES, orderedPages, flattenControls, localized, bothOf, describeValue,
  isPending, renderControl,
} from './dialogs/prefpages.js';
import { openPreferences, readPref, writePref, maskField } from './dialogs/preferences.js';

defineStrings({
  cpOpen: ['Command palette', '指令面板'],
  cpTitle: ['Command palette', '指令面板'],
  cpSearch: ['Search commands and settings', '搜尋指令同設定'],
  cpSearchPh: ['Search commands, settings or destinations…', '搜尋指令、設定或者目的地…'],
  cpCommands: ['Commands', '指令'],
  cpSettings: ['Settings and destinations', '設定同目的地'],
  cpDestination: ['Open in Preferences', '喺偏好設定開啟'],
  cpUnavailable: ['Unavailable in this build', '呢個版本未提供'],
  cpProtected: ['Protected value', '受保護值'],
  cpCard: ['Bounded card', '有限卡片'],
  cpFull: ['Full window', '全視窗'],
  cpClose: ['Close command palette', '關閉指令面板'],
  cpNoMatches: ['Nothing matches that search.', '冇嘢符合呢個搜尋。'],
  cpCount: ['{0} result(s)', '{0} 個結果'],
  cpHint: ['↑↓ choose · Enter run · Esc close', '↑↓ 揀 · Enter 執行 · Esc 關閉'],
});

const STYLE = `
.cmdp-backdrop { position: fixed; inset: 0; z-index: 450; display: flex; align-items: flex-start;
  justify-content: center; padding: clamp(12px, 8vh, 72px) 12px 12px;
  background: color-mix(in srgb, var(--scrim, #000) 32%, transparent); }
.cmdp-backdrop.is-full { align-items: stretch; padding: 12px; }
.cmdp-surface { width: min(780px, calc(100vw - 24px)); max-height: min(720px, calc(100vh - 84px));
  display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--outline-var);
  border-radius: var(--shape-xl, 28px); background: var(--surface, var(--c-lowest));
  color: var(--ons, var(--on-surface)); box-shadow: var(--e3, 0 12px 32px #0003); }
.cmdp-surface.is-full { width: 100%; max-height: none; height: auto; border-radius: var(--shape-lg, 16px); }
.cmdp-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 8px; }
.cmdp-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--type-title-lg, 1.35rem); font-weight: 500; }
.cmdp-size, .cmdp-close { flex: 0 0 auto; }
.cmdp-search { padding: 0 18px 10px; }
.cmdp-search .sb { min-width: 0; }
.cmdp-status { min-height: 24px; padding: 0 18px 6px; color: var(--onsv, #666); font-size: var(--type-label-md, .82rem); }
.cmdp-list { min-height: 120px; flex: 1 1 auto; overflow-y: auto; padding: 0 8px 10px; }
.cmdp-group { margin: 8px 10px 4px; color: var(--onsv, #666); font-size: var(--type-label-sm, .75rem); font-weight: 600; }
.cmdp-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; min-height: 56px; padding: 9px 10px;
  border: 0; border-radius: var(--shape-md, 12px); background: transparent; color: inherit; text-align: start; cursor: pointer; }
.cmdp-row.is-setting { cursor: default; }
.cmdp-row:hover, .cmdp-row.is-active { background: color-mix(in srgb, var(--p, #0b57d0) 12%, transparent); }
.cmdp-row:focus-visible { outline: 2px solid var(--p, #0b57d0); outline-offset: -2px; }
.cmdp-row[aria-disabled="true"] { opacity: .62; }
.cmdp-icon { flex: 0 0 20px; color: var(--onsv, #666); padding-top: 2px; }
.cmdp-main { flex: 1 1 auto; min-width: 0; }
.cmdp-label { display: block; overflow-wrap: anywhere; font-size: var(--type-body-md, .92rem); }
.cmdp-detail { display: block; margin-top: 2px; color: var(--onsv, #666); font-size: var(--type-label-sm, .76rem); overflow-wrap: anywhere; }
.cmdp-value { flex: 0 1 24ch; min-width: 0; color: var(--onsv, #666); font-family: var(--mono, monospace); font-size: var(--type-label-md, .82rem);
  text-align: end; overflow-wrap: anywhere; }
.cmdp-inline-control { flex: 0 1 min(30ch, 46%); min-width: 10ch; min-height: 30px; display: inline-flex; align-items: center; justify-content: flex-end; }
.cmdp-inline-control .field-input { min-width: 0; width: min(30ch, 100%); }
.cmdp-inline-control .pref-check { min-height: 30px; }
.cmdp-inline-control .pref-check-label { display: none; }
.cmdp-inline-control .pref-inline, .cmdp-inline-control .slider-wrap { max-width: 100%; min-width: 0; }
.cmdp-inline-control .slider-wrap { display: inline-flex; align-items: center; gap: 6px; }
.cmdp-inline-control .slider-value { min-width: 4ch; text-align: end; }
.cmdp-shortcut { flex: 0 0 auto; color: var(--onsv, #666); font-family: var(--mono, monospace); font-size: var(--type-label-sm, .76rem); }
.cmdp-empty { padding: 24px 12px; color: var(--onsv, #666); text-align: center; }
.cmdp-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 8px 18px 12px; border-top: 1px solid var(--outline-var); color: var(--onsv, #666); font-size: var(--type-label-sm, .76rem); }
@media (max-width: 560px) {
  .cmdp-backdrop { padding: 8px; }
  .cmdp-backdrop.is-full { padding: 8px; }
  .cmdp-surface { width: 100%; max-height: calc(100vh - 16px); border-radius: var(--shape-lg, 16px); }
  .cmdp-row { flex-wrap: wrap; }
  .cmdp-inline-control { flex: 1 1 100%; justify-content: flex-start; padding-inline-start: 30px; }
  .cmdp-value { flex-basis: 14ch; }
}
`;

let openHandle = null;

function pairForCommand(command) {
  if (command.labelKey) return tPair(command.labelKey);
  const label = String(command.label || command.id || '');
  return { en: label, yue: label };
}

function safeRead(read, key) {
  try { return read(key); } catch { return undefined; }
}

const INLINE_CONTROL_TYPES = new Set(['check', 'number', 'path', 'select', 'slider', 'text']);

/** Primitive, durable controls can safely share the Preferences renderer in this row. */
export function canInlinePreference(control) {
  return !!control && INLINE_CONTROL_TYPES.has(control.type)
    && !control.secret && !control.actionId && !control.danger && !isPending(control.key);
}

/** The palette must not steal keys from a nested editor or a clearing search. */
export function shouldHandlePaletteKey({ key, inRegexBuilder = false, inInlineControl = false, inPaletteButton = false, searchHasValue = false } = {}) {
  if (inRegexBuilder) return false;
  if (inPaletteButton && key !== 'Escape') return false;
  if (inInlineControl && key !== 'Escape') return false;
  if (key === 'Escape' && searchHasValue) return false;
  return true;
}

function writeInlinePreference(control, value) {
  const label = `Changed ${control.label?.en || control.key} to ${describeValue(control, value, 'en')}`;
  return Promise.all([control.key, ...(control.alsoKeys || [])]
    .map((key) => writePref(key, value, label)));
}

function inlineNodeFor(entry) {
  if (!canInlinePreference(entry.control)) return null;
  const rendered = renderControl(entry.control, {
    read: readPref,
    write: (control, value) => writeInlinePreference(control, value)
      .catch((err) => {
        console.warn('[command-palette] inline preference failed:', err);
        announce(`${localized(control.label)} could not be saved: ${err?.message || err}`, true);
      }),
    custom: { mask: (control, input) => maskField(input) },
  });
  const node = rendered.querySelector?.('.pref-check, .pref-inline, .slider-wrap, select, input, textarea');
  if (!node) return null;
  node.classList.add('cmdp-inline-control');
  const focusables = node.matches?.('input,select,textarea,button')
    ? [node] : Array.from(node.querySelectorAll?.('input,select,textarea,button') || []);
  for (const control of focusables) {
    control.setAttribute('aria-label', localized(entry.control.label));
    if (['number', 'path', 'text'].includes(entry.control.type)
      && control.tagName === 'INPUT' && control.type !== 'range') {
      control.dataset.cmdpCommitOnClose = entry.control.key;
      control.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        control.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }
  return node;
}

/** Build setting/page destinations without touching the DOM. */
export function preferenceDestinations(read = readPref) {
  const pages = orderedPages(PAGES);
  const pageEntries = pages.map((page) => ({
    type: 'destination',
    id: `preference-page:${page.id}`,
    label: page.title,
    pageId: page.id,
    fields: [...bothOf(page.title), page.id, ...((page.sections || []).flatMap((s) => bothOf(s.title)))],
    detail: () => localized(page.title),
    run: () => openPreferences({ pageId: page.id }),
  }));

  const seen = new Set();
  const settingEntries = flattenControls(PAGES).flatMap((entry) => {
    const key = entry.control.key;
    if (!key) return [];
    const identity = `${entry.pageId}:${key}`;
    if (seen.has(identity)) return [];
    seen.add(identity);

    const control = entry.control;
    const secret = !!control.secret;
    const stored = secret ? undefined : safeRead(read, key);
    const value = secret
      ? t('cpProtected')
      : (control.type === 'action' ? '' : describeValue(control, stored));
    const fields = [
      ...bothOf(control.label), ...bothOf(control.hint),
      ...bothOf(entry.pageTitle), ...bothOf(entry.sectionTitle), key,
      ...(control.options || []).flatMap((o) => bothOf(o.label)),
    ];
    if (!secret) {
      fields.push(describeValue(control, stored, 'en'), describeValue(control, stored, 'yue'));
    }
    return [{
      type: 'setting',
      id: `preference:${entry.pageId}:${key}`,
      label: control.label,
      pageId: entry.pageId,
      key,
      fields: fields.filter(Boolean),
      value,
      pending: isPending(key),
      control,
      inline: canInlinePreference(control),
      detail: () => `${localized(entry.pageTitle)} › ${localized(entry.sectionTitle)}`,
      run: () => openPreferences({ pageId: entry.pageId, controlKey: key }),
    }];
  });
  return [...pageEntries, ...settingEntries];
}

/** Build the complete palette inventory from the live shell registries. */
export function paletteEntries(commands = listCommands(), settings = preferenceDestinations()) {
  const commandEntries = commands.map((command) => {
    const pair = pairForCommand(command);
    return {
      type: 'command',
      id: `command:${command.id}`,
      commandId: command.id,
      label: pair,
      fields: [...bothOf(pair), command.id, command.actionName || '', command.category || '', command.shortcut || ''],
      shortcut: command.shortcut || '',
      icon: command.icon || 'play_arrow',
      detail: () => command.category || t('cpCommands'),
      run: () => runCommand(command.id),
    };
  });
  return [...commandEntries, ...settings];
}

function entryLabel(entry) { return localized(entry.label); }

function entryMatches(entry, predicate, active) {
  if (!active) return true;
  if (!predicate?.ok) return false;
  return entry.fields.some((field) => predicate.test(String(field)));
}

/** Pure filtering seam used by the renderer and by the search regression tests. */
export function filterPaletteEntries(entries, predicate, active = true) {
  return entries.filter((entry) => entryMatches(entry, predicate, active));
}

/** The first result is the only stable keyboard target after a new query. */
export function firstPaletteIndex(resultCount) {
  return resultCount > 0 ? 0 : -1;
}

/** The deferred initial focus must not run after the palette has closed. */
export function shouldFocusPalette(isClosed) { return !isClosed; }

function entryIcon(entry) {
  if (entry.type === 'setting') return entry.pending ? 'lock' : 'settings';
  if (entry.type === 'destination') return 'folder_open';
  return entry.icon || 'play_arrow';
}

function runWithAnnounce(entry) {
  const label = entryLabel(entry);
  if (entry.type === 'setting') announce(`${label} — ${t('cpDestination')}`);
  return entry.run();
}

function renderSizeLabel(size) { return size === 'full' ? t('cpFull') : t('cpCard'); }

export function openCommandPalette() {
  if (openHandle) { openHandle.focus(); return openHandle; }
  ensureStyle('winscp-command-palette', STYLE);

  const restore = focusMemory();
  let size = store.get('commandPalette.size') === 'full' ? 'full' : 'card';
  let closed = false;
  let focusFrame = null;
  let activeIndex = 0;
  let entries = paletteEntries();
  let results = entries;
  const titleId = `cmdp-title-${Date.now().toString(36)}`;
  const listId = `cmdp-list-${Date.now().toString(36)}`;

  const sizeBtn = h('button', {
    type: 'button', class: 'btn-text cmdp-size', 'aria-pressed': String(size === 'full'),
    onclick: () => setSize(size === 'full' ? 'card' : 'full'),
  });
  const closeBtn = h('button', {
    type: 'button', class: 'icon-btn cmdp-close', onclick: () => close(),
  }, icon('close', 18));
  closeBtn.setAttribute('aria-label', t('cpClose'));
  closeBtn.title = t('cpClose');

  const count = h('span', { 'aria-live': 'polite' });
  const list = h('div', { class: 'cmdp-list', id: listId, role: 'list', tabindex: '-1', 'aria-label': t('cpTitle') });
  const footer = h('div', { class: 'cmdp-foot' }, h('span', {}, t('cpHint')), h('span', {}, 'JavaScript RegExp · local only'));
  const search = createSearchBar({
    id: 'command-palette', labelKey: 'cpSearch', placeholderKey: 'cpSearchPh',
    appearanceKey: 'command-palette-search', appearanceLabel: 'Command palette search',
    sampleProvider: () => entries.flatMap((e) => e.fields).join('\n'),
    // A query creates a new result set; keeping the old numeric index can
    // silently select a different command (or clamp to the last match).
    onChange: () => { activeIndex = firstPaletteIndex(results.length); render(); },
    onSubmit: () => selectActive(),
  });
  search.input.setAttribute('aria-controls', listId);

  const root = h('section', { class: 'cmdp-surface surface-3', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'cmdp-head' },
      h('span', { class: 'cmdp-icon' }, icon('manage_search', 20)),
      h('h2', { class: 'cmdp-title', id: titleId }, t('cpTitle')),
      sizeBtn,
      closeBtn),
    h('div', { class: 'cmdp-search' }, search.element),
    h('div', { class: 'cmdp-status' }, count),
    list,
    footer);
  const backdrop = h('div', { class: 'cmdp-backdrop', role: 'presentation' }, root);
  appearanceTarget(root, 'command-palette', 'Command palette');
  layer('popover').appendChild(backdrop);

  function setSize(next) {
    size = next === 'full' ? 'full' : 'card';
    store.set('commandPalette.size', size);
    persistCurrent('commandPalette');
    root.classList.toggle('is-full', size === 'full');
    backdrop.classList.toggle('is-full', size === 'full');
    sizeBtn.textContent = renderSizeLabel(size === 'full' ? 'card' : 'full');
    sizeBtn.setAttribute('aria-label', renderSizeLabel(size === 'full' ? 'card' : 'full'));
    sizeBtn.setAttribute('aria-pressed', String(size === 'full'));
  }

  function close() {
    if (!openHandle) return;
    const active = document.activeElement;
    if (active?.matches?.('[data-cmdp-commit-on-close]')) {
      const key = active.dataset.cmdpCommitOnClose;
      const stored = readPref(key);
      if (String(active.value ?? '') !== String(stored ?? '')) {
        active.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    closed = true;
    if (focusFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(focusFrame);
      focusFrame = null;
    }
    document.removeEventListener('keydown', onKey, true);
    offI18n?.();
    offCommands?.();
    offPrefs?.();
    untrap?.();
    search.destroy();
    backdrop.remove();
    openHandle = null;
    restore();
  }

  function currentIndex() {
    return results.length ? Math.max(0, Math.min(activeIndex, results.length - 1)) : -1;
  }

  function selectActive() {
    const entry = results[currentIndex()];
    if (!entry) return;
    close();
    Promise.resolve(runWithAnnounce(entry)).catch((err) => console.warn('[command-palette] selection failed:', err));
  }

  function move(delta) {
    if (!results.length) return;
    activeIndex = (currentIndex() + delta + results.length) % results.length;
    paintActive();
  }

  function paintActive() {
    const index = currentIndex();
    for (const [i, row] of Array.from(list.querySelectorAll('.cmdp-row')).entries()) {
      const active = i === index;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-current', active ? 'true' : 'false');
    }
    if (index >= 0) {
      const row = list.querySelector(`[data-cmdp-index="${index}"]`);
      search.input.setAttribute('aria-activedescendant', row?.id || '');
      row?.scrollIntoView({ block: 'nearest' });
    } else search.input.removeAttribute('aria-activedescendant');
  }

  function captureListFocus() {
    const active = document.activeElement;
    const row = active?.closest?.('.cmdp-row');
    if (!row || !list.contains(row)) return null;
    if (active === row) return { id: row.dataset.cmdpEntryId || '', index: -1 };
    const controls = Array.from(row.querySelectorAll('input, select, textarea, button'));
    const index = controls.indexOf(active);
    if (index < 0) return null;
    return {
      id: row.dataset.cmdpEntryId || '', index,
      start: active.selectionStart, end: active.selectionEnd,
    };
  }

  function restoreListFocus(mark) {
    if (!mark) return;
    const escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(mark.id) : String(mark.id).replace(/["\\]/g, '\\$&');
    const row = list.querySelector(`[data-cmdp-entry-id="${escaped}"]`);
    if (!row) return;
    const controls = Array.from(row.querySelectorAll('input, select, textarea, button'));
    const target = mark.index < 0 ? row : controls[mark.index];
    if (!target) return;
    target.focus({ preventScroll: true });
    if (mark.start != null && 'setSelectionRange' in target) {
      try { target.setSelectionRange(mark.start, mark.end ?? mark.start); } catch { /* not a text field */ }
    }
  }

  function render() {
    const focusMark = captureListFocus();
    entries = paletteEntries();
    results = filterPaletteEntries(entries, search.predicate, search.isActive);
    activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, results.length - 1)));
    clear(list);
    count.textContent = t('cpCount', results.length);
    if (!results.length) {
      list.appendChild(h('p', { class: 'cmdp-empty' }, t('cpNoMatches')));
      paintActive();
      return;
    }
    let group = '';
    results.forEach((entry, index) => {
      const nextGroup = entry.type === 'command' ? t('cpCommands') : t('cpSettings');
      if (nextGroup !== group) {
        group = nextGroup;
        list.appendChild(h('div', { class: 'cmdp-group', role: 'presentation' }, group));
      }
      const rowId = `cmdp-row-${index}`;
      const detail = entry.detail();
      const inline = entry.type === 'setting' ? inlineNodeFor(entry) : null;
      const row = h(inline ? 'div' : 'button', {
        type: inline ? undefined : 'button', id: rowId, 'data-cmdp-index': String(index),
        role: inline ? 'group' : undefined,
        tabindex: inline ? '0' : undefined,
        'aria-current': String(index === currentIndex()),
        'aria-label': `${entryLabel(entry)} — ${detail}`,
        'data-cmdp-entry-id': entry.id,
        'data-cmdp-key': entry.key || undefined,
        'data-cmdp-inline': inline ? 'true' : 'false',
        class: `cmdp-row${inline ? ' is-setting' : ''}`,
        // Pending preferences are still reachable destinations.  The real
        // Preferences surface explains why the control is unavailable; marking
        // the palette row disabled would make keyboard activation impossible
        // and contradict the palette's job of finding every setting.
        'data-cmdp-status': entry.pending ? 'unavailable' : 'available',
        onclick: (e) => {
          if (inline && e.target.closest?.('.cmdp-inline-control')) return;
          activeIndex = index; selectActive();
        },
        onfocusin: () => { activeIndex = index; paintActive(); },
        onmouseenter: () => { activeIndex = index; paintActive(); },
      },
      h('span', { class: 'cmdp-icon' }, icon(entryIcon(entry), 18)),
      h('span', { class: 'cmdp-main' },
        h('span', { class: 'cmdp-label' }, entryLabel(entry)),
        h('span', { class: 'cmdp-detail' }, entry.type === 'setting' ? `${detail} · ${entry.pending ? t('cpUnavailable') : t('cpDestination')}` : detail)),
      !inline && entry.value ? h('span', { class: 'cmdp-value', title: entry.value }, entry.value) : null,
      inline,
      entry.shortcut ? h('kbd', { class: 'cmdp-shortcut' }, entry.shortcut) : null);
      list.appendChild(h('div', { class: 'cmdp-item', role: 'listitem' }, row));
    });
    paintActive();
    restoreListFocus(focusMark);
  }

  function onKey(e) {
    if (!shouldHandlePaletteKey({
      key: e.key,
      inRegexBuilder: !!e.target?.closest?.('.rb-popover'),
      inInlineControl: !!e.target?.closest?.('.cmdp-inline-control'),
      inPaletteButton: !!e.target?.closest?.('.cmdp-size, .cmdp-close, .cmdp-search button'),
      searchHasValue: e.target === search.input && !!search.input.value,
    })) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Home' && results.length) { e.preventDefault(); activeIndex = 0; paintActive(); return; }
    if (e.key === 'End' && results.length) { e.preventDefault(); activeIndex = results.length - 1; paintActive(); return; }
    if (e.key === 'Enter' && e.target !== search.input) { e.preventDefault(); selectActive(); }
  }

  const offI18n = subscribeI18n(() => {
    sizeBtn.textContent = renderSizeLabel(size === 'full' ? 'card' : 'full');
    closeBtn.setAttribute('aria-label', t('cpClose'));
    closeBtn.title = t('cpClose');
    list.setAttribute('aria-label', t('cpTitle'));
    render();
  });
  const offCommands = bus.on('shell:commandRegistered', render);
  const offPrefs = bus.on('prefs:changed', render);

  const untrap = trapFocus(root);
  setSize(size);
  document.addEventListener('keydown', onKey, true);
  render();
  focusFrame = requestAnimationFrame(() => {
    focusFrame = null;
    if (shouldFocusPalette(closed)) search.focus();
  });

  openHandle = {
    element: root,
    close,
    focus: () => search.focus(),
    get size() { return size; },
    get results() { return results.slice(); },
  };
  return openHandle;
}

registerCommand({
  id: 'app.commandPalette', labelKey: 'cpOpen', icon: 'manage_search', shortcut: 'Ctrl+Shift+P',
  run: () => openCommandPalette(),
});
registerTitlebarAction({ id: 'command-palette', labelKey: 'cpOpen', icon: 'manage_search', order: 15, onSelect: openCommandPalette });

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openCommandPalette();
    }
  }, true);
}
