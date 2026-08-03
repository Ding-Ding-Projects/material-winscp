// ui/dialogs/opendirectory.js — forms/OpenDirectory.dfm.
//
// "Open directory / Bookmark…": a path box with the panel's own history, and
// the two bookmark sheets — the ones belonging to this site, and the shared
// ones that follow the user everywhere. Both sheets do what the .dfm's buttons
// say: Add, Remove, Up, Down, and (shared only) Shortcut…
//
// The rules are TOpenDirectoryDialog's:
//   * a bookmark is per side — the same bookmark carries a local path and a
//     remote path, and the sheet shows the side the panel is on,
//   * Add is disabled while the current path is already bookmarked,
//   * selecting a bookmark fills the path box, double-clicking accepts it,
//   * the site sheet exists only when there is a session,
//   * which sheet was last used is remembered (UseSharedBookmarks).
//
// Every list here carries its own search bar with the regex builder anchored
// to it, because a bookmark list is exactly the kind of collection that grows
// past what anyone can scan.

import { h, uid, appearanceTarget, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import {
  makeTranslator, ops, createSheets, createListBox,
  readPref, writePrefs, readHistory, pushHistory,
} from './rights.js';

const STRINGS = {
  odBrowseCaption: ['Open directory', '開目錄'],
  odBookmarkCaption: ['Manage bookmarks', '管理書籤'],
  odOpenLabel: ['Open directory', '開目錄'],
  odSiteSheet: ['Site bookmarks', '站點書籤'],
  odSharedSheet: ['Shared bookmarks', '共用書籤'],
  odAdd: ['Add', '加'],
  odRemove: ['Remove', '移除'],
  odUp: ['Up', '上'],
  odDown: ['Down', '落'],
  odShortcut: ['Shortcut…', '快捷鍵…'],
  odBrowse: ['Browse…', '瀏覽…'],
  odProfiles: ['Location profiles…', '位置設定檔…'],
  odSearch: ['Search bookmarks', '搵書籤'],
  odEmpty: ['No bookmarks yet. Add the path above to start one.', '未有書籤。將上面條路徑加入去就得。'],
  odNoSession: ['Site bookmarks belong to a session; this panel has none open.', '站點書籤跟住工作階段，呢個面板未開任何一個。'],
  odAdded: ['"{0}" added to bookmarks.', '「{0}」加咗入書籤。'],
  odRemoved: ['"{0}" removed from bookmarks.', '「{0}」由書籤度移走咗。'],
  odShortcutTitle: ['Bookmark shortcut', '書籤快捷鍵'],
  odShortcutBody: ['Press the key combination to assign to "{0}".', '撳你想俾「{0}」用嘅組合鍵。'],
  odShortcutNone: ['No shortcut', '冇快捷鍵'],
  odShortcutSet: ['{0} now opens "{1}".', '{0} 而家會開「{1}」。'],
  odShortcutTaken: ['{0} is already used by "{1}".', '{0} 俾「{1}」用咗。'],
  odPathRequired: ['Type or choose a directory first.', '要先打或者揀個目錄。'],
  odLocalBrowseUnavailable: ['This build cannot open a folder picker from here.', '呢個版本喺呢度開唔到資料夾揀選器。'],
};

const tx = makeTranslator(STRINGS);

const SHARED_KEY = '__shared__';

/** The stored shape, defaulted so a first run has something to write into. */
function emptyBookmarks() { return { local: [], remote: [], shortCuts: {} }; }

async function readBookmarks(key) {
  const all = (await readPref('bookmarks', {})) || {};
  const found = all[key];
  if (!found || typeof found !== 'object') return emptyBookmarks();
  return {
    local: Array.isArray(found.local) ? found.local.slice() : [],
    remote: Array.isArray(found.remote) ? found.remote.slice() : [],
    shortCuts: found.shortCuts && typeof found.shortCuts === 'object' ? { ...found.shortCuts } : {},
  };
}

async function writeBookmarks(key, value, label) {
  return writePrefs({ bookmarks: { [key]: value } }, label);
}

/** A keyboard combination as WinSCP writes one: 'Ctrl+Shift+F3'. */
export function describeShortcut(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

/**
 * props:
 *   side           'local' | 'remote'
 *   directory      the panel's current directory
 *   directories    recent directories for the combo (defaults to the history)
 *   sessionId, sessionKey, sessionName
 *   mode           'browse' (default) | 'addBookmark'
 *   allowSwitch    offer the Location-profiles button
 *   onOpen(path)
 */
registerDialog('opendirectory', ({ props, close }) => {
  const side = props.side === 'local' ? 'local' : 'remote';
  const sessionKey = props.sessionKey || props.sessionName || props.sessionId || '';
  const mode = props.mode === 'addBookmark' ? 'addBookmark' : 'browse';
  const historyKey = side === 'local' ? 'localDirectory' : 'remoteDirectory';

  const pathId = uid('od');
  const pathInput = h('input', {
    type: 'text', class: 'field-input', id: pathId, autocomplete: 'off', spellcheck: 'false',
    list: `${pathId}-history`,
    style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => update(),
  });
  pathInput.value = props.directory || '';
  const historyList = h('datalist', { id: `${pathId}-history` });

  const pathLabel = h('label', { class: 'field-label', for: pathId, style: { width: 'calc(13ch * var(--uiscale))' } });
  bindRender(pathLabel, () => { pathLabel.textContent = tx('odOpenLabel'); });

  const browseButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: async () => {
      try {
        // app:pickPath resolves an array of paths, or null when cancelled.
        const picked = await ops.app.pickPath({ directory: true, defaultPath: pathInput.value, title: tx('odOpenLabel') });
        const chosen = Array.isArray(picked) ? picked[0] : picked;
        if (chosen) { pathInput.value = String(chosen); update(); }
      } catch (err) {
        notify.warning(tx('odBrowse'), err.message || tx('odLocalBrowseUnavailable'));
      }
    },
  });
  bindRender(browseButton, () => { browseButton.textContent = tx('odBrowse'); });
  browseButton.hidden = side !== 'local';

  /* ---------------- one bookmark sheet ---------------- */

  function bookmarkSheet({ id, key, canShortcut }) {
    let data = emptyBookmarks();
    const search = createSearchBar({
      id: `opendir-${id}`,
      persist: false,
      compact: true,
      labelKey: 'search',
      placeholder: tx('odSearch'),
      sampleProvider: () => data[side].map((b) => `${b.name || ''} ${b.path}`).join('\n'),
      onChange: () => paint(),
    });

    const list = createListBox({
      label: tx(id === 'site' ? 'odSiteSheet' : 'odSharedSheet'),
      emptyText: tx('odEmpty'),
      onSelect: (item) => {
        if (item) { pathInput.value = item.path; update(); }
        paintButtons();
      },
      onActivate: (item) => { if (item) { pathInput.value = item.path; accept(); } },
      onDelete: () => removeSelected(),
    });

    const addButton = button('odAdd', () => addCurrent());
    const removeButton = button('odRemove', () => removeSelected());
    const upButton = button('odUp', () => move(-1));
    const downButton = button('odDown', () => move(1));
    const shortcutButton = canShortcut ? button('odShortcut', () => assignShortcut()) : null;

    function button(labelKey, onclick) {
      const btn = h('button', { type: 'button', class: 'btn-text', onclick });
      bindRender(btn, () => { btn.textContent = tx(labelKey); });
      return btn;
    }

    const note = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)' } });

    function visibleItems() {
      const items = data[side].map((b) => ({
        path: b.path,
        label: shortcutOf(b.path) ? `${b.name || b.path} (${shortcutOf(b.path)})` : (b.name || b.path),
        title: b.path,
        icon: 'bookmark',
      }));
      if (!search.isActive) return items;
      return filterBy(items, search.predicate, (i) => [i.label, i.path]);
    }

    function shortcutOf(path) {
      const entries = Object.entries(data.shortCuts || {});
      const hit = entries.find(([, value]) => value === path);
      return hit ? hit[0] : '';
    }

    function paint() {
      const items = visibleItems();
      const selectedPath = list.selected?.path || '';
      list.setItems(items, false);
      list.index = selectedPath ? items.findIndex((item) => item.path === selectedPath) : -1;
      note.textContent = search.isActive && !items.length
        ? noMatchMessage(search.predicate, tx(id === 'site' ? 'odSiteSheet' : 'odSharedSheet'))
        : '';
      paintButtons();
    }

    function paintButtons() {
      const selectedPath = list.selected?.path || '';
      const index = data[side].findIndex((bookmark) => bookmark.path === selectedPath);
      const current = pathInput.value.trim();
      addButton.disabled = !current || data[side].some((b) => b.path === current);
      removeButton.disabled = index < 0;
      upButton.disabled = index <= 0;
      downButton.disabled = index < 0 || index >= data[side].length - 1;
      if (shortcutButton) shortcutButton.disabled = index < 0;
    }

    async function addCurrent() {
      const path = pathInput.value.trim();
      if (!path || data[side].some((b) => b.path === path)) return;
      const before = snapshot();
      const selectedPath = list.selected?.path || '';
      const index = data[side].findIndex((bookmark) => bookmark.path === selectedPath);
      const entry = { path, name: path };
      if (index >= 0) data[side].splice(index, 0, entry);
      else data[side].push(entry);
      if (!await save(`Added a ${side} bookmark for ${path}`)) { restore(before); return; }
      paint();
      notify.success(t('bookmarkAdded', path));
      announce(t('bookmarkAdded', path));
    }

    async function removeSelected() {
      const item = list.selected;
      if (!item) return;
      const at = data[side].findIndex((b) => b.path === item.path);
      if (at < 0) return;
      const before = snapshot();
      data[side].splice(at, 1);
      for (const [combo, target] of Object.entries(data.shortCuts || {})) {
        if (target === item.path) delete data.shortCuts[combo];
      }
      if (!await save(`Removed a ${side} bookmark for ${item.path}`)) { restore(before); return; }
      paint();
      notify.info(tx('odRemoved', item.path));
    }

    async function move(delta) {
      const item = list.selected;
      if (!item) return;
      const at = data[side].findIndex((b) => b.path === item.path);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= data[side].length) return;
      const before = snapshot();
      const [moved] = data[side].splice(at, 1);
      data[side].splice(to, 0, moved);
      if (!await save('Reordered the bookmarks')) { restore(before); return; }
      paint();
    }

    function assignShortcut() {
      const item = list.selected;
      if (!item) return;
      openShortcutDialog({
        name: item.label,
        path: item.path,
        current: shortcutOf(item.path),
        taken: data.shortCuts || {},
        onAssign: async (combo) => {
          const before = snapshot();
          for (const [existing, target] of Object.entries(data.shortCuts || {})) {
            if (target === item.path) delete data.shortCuts[existing];
          }
          if (combo) data.shortCuts[combo] = item.path;
          if (!await save('Changed a bookmark shortcut')) { restore(before); return false; }
          paint();
          if (combo) notify.success(tx('odShortcutSet', combo, item.label));
          return true;
        },
      });
    }

    async function save(label) {
      return writeBookmarks(key, data, label);
    }

    function snapshot() {
      return {
        local: data.local.slice(),
        remote: data.remote.slice(),
        shortCuts: { ...data.shortCuts },
      };
    }

    function restore(before) {
      data = before;
      paint();
    }

    async function load() {
      data = await readBookmarks(key);
      paint();
    }
    load();

    const element = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(8px * var(--den))' } },
      h('div', { class: 'row' }, search.element),
      list.element,
      note,
      h('div', { class: 'row' }, addButton, removeButton, upButton, downButton, shortcutButton));
    appearanceTarget(element, `opendir-sheet-${id}`, `Bookmark sheet: ${id}`);

    return { element, paintButtons, reload: load };
  }

  const siteSheet = sessionKey ? bookmarkSheet({ id: 'site', key: sessionKey, canShortcut: false }) : null;
  const sharedSheet = bookmarkSheet({ id: 'shared', key: SHARED_KEY, canShortcut: true });

  const sheets = createSheets([
    {
      id: 'site',
      label: tx('odSiteSheet'),
      content: siteSheet ? siteSheet.element : h('p', { class: 'prose muted' }, tx('odNoSession')),
    },
    { id: 'shared', label: tx('odSharedSheet'), content: sharedSheet.element },
  ], {
    id: 'opendirectory',
    label: tx('odBookmarkCaption'),
    onSelect: (id) => { writePrefs({ integration: { useSharedBookmarks: id === 'shared' } }, 'Remembered the bookmark sheet'); },
  });
  if (!sessionKey) sheets.setVisible('site', false);

  const profilesButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      writePrefs({ useLocationProfiles: true }, 'Switched to location profiles');
      close();
      openDialog('locationprofiles', {
        side,
        localDirectory: side === 'local' ? pathInput.value : props.localDirectory || '',
        remoteDirectory: side === 'remote' ? pathInput.value : props.remoteDirectory || '',
        sessionKey,
        sessionId: props.sessionId,
        onOpen: props.onOpen,
      });
    },
  });
  bindRender(profilesButton, () => { profilesButton.textContent = tx('odProfiles'); });
  profilesButton.hidden = props.allowSwitch === false;

  const content = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathLabel, pathInput, browseButton),
    historyList,
    sheets.element,
    h('div', { class: 'row' }, profilesButton));
  appearanceTarget(content, 'opendirectory-dialog', 'Open directory dialog');

  let okButton = null;

  function update() {
    if (okButton) okButton.disabled = !pathInput.value.trim();
    siteSheet?.paintButtons();
    sharedSheet.paintButtons();
  }

  function accept() {
    const path = pathInput.value.trim();
    if (!path) { notify.warning(tx('odBrowseCaption'), tx('odPathRequired')); return; }
    pushHistory(historyKey, path);
    props.onOpen?.(path);
    close();
  }

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); accept(); }
  });

  // The recent-directory list is the panel's own history, not an invention.
  const provided = Array.isArray(props.directories) ? props.directories : null;
  (provided ? Promise.resolve(provided) : readHistory(historyKey)).then((list) => {
    historyList.replaceChildren(...list.map((value) => h('option', { value })));
  });

  readPref('integration.useSharedBookmarks', false).then((shared) => {
    if (shared || !sessionKey) sheets.select('shared');
    else sheets.select('site');
    if (mode === 'addBookmark') {
      // odAddBookmark opens straight onto the sheet with the path already added.
      const sheet = (shared || !sessionKey) ? sharedSheet : siteSheet;
      sheet?.reload();
    }
  });

  update();

  return {
    title: mode === 'addBookmark' ? tx('odBookmarkCaption') : tx('odBrowseCaption'),
    width: 620,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; update(); },
        onSelect: () => { accept(); return true; },
      },
    ],
  };
});

/* ================================================================== */
/* the shortcut capture                                                */
/* ================================================================== */

registerDialog('bookmark-shortcut', ({ props, close }) => {
  let combo = props.current || '';
  const display = h('div', {
    class: 'mono', tabindex: '0', role: 'textbox', 'aria-readonly': 'true',
    style: {
      minHeight: 'calc(48px * var(--den))', display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '2px dashed var(--outline)', borderRadius: 'var(--shape-md)',
      fontSize: 'var(--type-title-md)', letterSpacing: '.02em',
    },
  }, combo || tx('odShortcutNone'));

  display.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { combo = ''; display.textContent = tx('odShortcutNone'); return; }
    const next = describeShortcut(e);
    if (!next) return;
    const owner = props.taken && props.taken[next];
    if (owner && owner !== props.path) {
      notify.warning(tx('odShortcutTitle'), tx('odShortcutTaken', next, owner));
      return;
    }
    combo = next;
    display.textContent = combo;
  });

  setTimeout(() => display.focus(), 0);

  return {
    title: tx('odShortcutTitle'),
    width: 420,
    content: h('div', { class: 'stack' },
      h('p', { class: 'prose' }, tx('odShortcutBody', props.name || '')),
      display),
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('remove'), kind: 'text',
        onSelect: () => {
          Promise.resolve(props.onAssign('')).then((ok) => { if (ok !== false) close('action'); });
          return true;
        },
      },
      {
        label: t('ok'), kind: 'filled',
        onSelect: () => {
          Promise.resolve(props.onAssign(combo)).then((ok) => { if (ok !== false) close('action'); });
          return true;
        },
      },
    ],
  };
});

function openShortcutDialog(props) { return openDialog('bookmark-shortcut', props); }

/** Open the directory / bookmark dialog. */
export function openDirectoryDialog(props) { return openDialog('opendirectory', props); }
