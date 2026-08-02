// ui/dialogs/locationprofiles.js — forms/LocationProfiles.dfm.
//
// A location profile is a bookmark for BOTH panels at once: a local directory
// and a remote directory, opened together. The dialog has the two sheets the
// .dfm declares (this site's profiles, and the shared ones), each a one-level
// tree of folders — "more than one level of folders is not supported" is the
// original's own assertion, and this port keeps that rule rather than inventing
// a deeper structure the storage cannot describe.
//
// Every button in the .dfm does its job: Add…, Remove, Rename, Move To…, Up,
// Down, and Shortcut… on the shared sheet. Selecting a profile fills both
// directory boxes; typing in the boxes selects the matching profile
// (FindProfile), so the dialog always shows whether what is on screen is a
// saved profile or an ad-hoc pair of paths.

import { h, uid, clear, appearanceTarget, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import {
  makeTranslator, ops, createSheets, readPref, writePrefs, readHistory, pushHistory,
} from './rights.js';
// Imported for its registrations, not for a symbol: it registers the bookmarks
// dialog this one switches to and the shortcut-capture dialog both reuse. The
// two forms are a pair in WinSCP and each offers a button to the other.
import './opendirectory.js';

const STRINGS = {
  lpTitle: ['Location profiles', '位置設定檔'],
  lpSiteSheet: ['Site location profiles', '站點位置設定檔'],
  lpSharedSheet: ['Shared location profiles', '共用位置設定檔'],
  lpLocal: ['Local directory', '本機目錄'],
  lpRemote: ['Remote directory', '遠端目錄'],
  lpAdd: ['Add…', '加…'],
  lpRemove: ['Remove', '移除'],
  lpRename: ['Rename', '改名'],
  lpMoveTo: ['Move To…', '移去…'],
  lpUp: ['Up', '上'],
  lpDown: ['Down', '落'],
  lpShortcut: ['Shortcut…', '快捷鍵…'],
  lpBrowse: ['Browse…', '瀏覽…'],
  lpBookmarks: ['Bookmarks…', '書籤…'],
  lpSearch: ['Search profiles', '搵設定檔'],
  lpEmpty: ['No profiles yet. Fill in a directory above and press Add.', '未有設定檔。喺上面填個目錄然後撳「加」。'],
  lpNoSession: ['Site profiles belong to a session; this panel has none open.', '站點設定檔跟住工作階段，呢個面板未開任何一個。'],
  lpNameTitle: ['Profile name', '設定檔名'],
  lpNameLabel: ['Name', '名'],
  lpFolderLabel: ['Folder (optional)', '資料夾（可以唔填）'],
  lpNameRequired: ['A profile needs a name.', '設定檔要有個名。'],
  lpNameTaken: ['"{0}" already exists in this folder.', '「{0}」喺呢個資料夾已經有咗。'],
  lpAdded: ['Profile "{0}" saved.', '設定檔「{0}」儲存咗。'],
  lpRemoved: ['Profile "{0}" removed.', '設定檔「{0}」移除咗。'],
  lpRenamed: ['Renamed to "{0}".', '改名做「{0}」。'],
  lpMoved: ['Moved to "{0}".', '移咗去「{0}」。'],
  lpMoveTitle: ['Move profile', '移動設定檔'],
  lpMoveBody: ['Choose the folder "{0}" should live in. Leave it empty for the top level.', '揀「{0}」應該擺喺邊個資料夾。留空就擺喺最上層。'],
  lpDirRequired: ['At least one of the two directories is needed.', '兩個目錄至少要有一個。'],
  lpOpened: ['Opened "{0}".', '開咗「{0}」。'],
  lpShortcutSet: ['{0} now opens "{1}".', '{0} 而家會開「{1}」。'],
  lpTopLevel: ['(top level)', '（最上層）'],
};

const tx = makeTranslator(STRINGS);

const SHARED_PATH = 'locationProfiles';
const SITE_PATH = 'locationProfilesBySite';

/** One stored profile: a name, an optional one-level folder, and both paths. */
function normalizeProfile(p) {
  return {
    name: String(p.name || ''),
    node: String(p.node || ''),
    local: String(p.local || ''),
    remote: String(p.remote || ''),
    shortCut: String(p.shortCut || ''),
  };
}

export async function readProfiles(sessionKey) {
  const shared = await readPref(SHARED_PATH, []);
  const bySite = (await readPref(SITE_PATH, {})) || {};
  const site = sessionKey && Array.isArray(bySite[sessionKey]) ? bySite[sessionKey] : [];
  return {
    shared: (Array.isArray(shared) ? shared : []).map(normalizeProfile),
    site: site.map(normalizeProfile),
  };
}

async function writeProfiles(which, list, sessionKey, label) {
  if (which === 'shared') return writePrefs({ [SHARED_PATH]: list }, label);
  return writePrefs({ [SITE_PATH]: { [sessionKey]: list } }, label);
}

/**
 * props:
 *   side, sessionKey, sessionId
 *   localDirectory, remoteDirectory
 *   onOpen({ local, remote })
 */
registerDialog('locationprofiles', ({ props, close }) => {
  const sessionKey = props.sessionKey || props.sessionName || props.sessionId || '';
  let profiles = { shared: [], site: [] };

  const localId = uid('lplocal');
  const remoteId = uid('lpremote');

  const localInput = h('input', {
    type: 'text', class: 'field-input', id: localId, autocomplete: 'off', spellcheck: 'false',
    list: `${localId}-history`, style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => { findProfile(); update(); },
  });
  const remoteInput = h('input', {
    type: 'text', class: 'field-input', id: remoteId, autocomplete: 'off', spellcheck: 'false',
    list: `${remoteId}-history`, style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => { findProfile(); update(); },
  });
  localInput.value = props.localDirectory || '';
  remoteInput.value = props.remoteDirectory || '';

  const localHistory = h('datalist', { id: `${localId}-history` });
  const remoteHistory = h('datalist', { id: `${remoteId}-history` });

  // Wide enough for "Remote directory" in every mode, so the label never wraps
  // into two lines beside a single-line field.
  const labelStyle = { width: 'calc(17ch * var(--uiscale))', flex: '0 0 auto' };
  const localLabel = h('label', { class: 'field-label', for: localId, style: labelStyle });
  const remoteLabel = h('label', { class: 'field-label', for: remoteId, style: labelStyle });
  bindRender(localLabel, () => { localLabel.textContent = tx('lpLocal'); });
  bindRender(remoteLabel, () => { remoteLabel.textContent = tx('lpRemote'); });

  const browseButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: async () => {
      try {
        const picked = await ops.app.pickPath({ directory: true, defaultPath: localInput.value, title: tx('lpLocal') });
        const chosen = Array.isArray(picked) ? picked[0] : picked;
        if (chosen) { localInput.value = String(chosen); findProfile(); update(); }
      } catch (err) { notify.warning(tx('lpBrowse'), err.message); }
    },
  });
  bindRender(browseButton, () => { browseButton.textContent = tx('lpBrowse'); });

  /* ---------------- a profile tree ---------------- */

  function profileSheet(which) {
    let selected = null;                 // { kind:'profile'|'folder', name, node }
    const collapsed = new Set();

    const search = createSearchBar({
      id: `locprofiles-${which}`,
      persist: false,
      compact: true,
      labelKey: 'search',
      placeholder: tx('lpSearch'),
      sampleProvider: () => list().map((p) => `${p.node} ${p.name} ${p.local} ${p.remote}`).join('\n'),
      onChange: () => paint(),
    });

    const tree = h('div', {
      role: 'tree', tabindex: '0',
      'aria-label': tx(which === 'site' ? 'lpSiteSheet' : 'lpSharedSheet'),
      style: {
        border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-sm)',
        background: 'var(--c-lowest)', padding: '4px',
        minHeight: 'calc(170px * var(--uiscale))', maxHeight: 'calc(300px * var(--uiscale))',
        overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px',
      },
    });
    const note = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)' } });

    function list() { return profiles[which]; }

    function visible() {
      const all = list();
      if (!search.isActive) return all;
      return filterBy(all, search.predicate, (p) => [p.name, p.node, p.local, p.remote]);
    }

    function folders() {
      return Array.from(new Set(list().map((p) => p.node).filter(Boolean))).sort();
    }

    function button(labelKey, onclick) {
      const btn = h('button', { type: 'button', class: 'btn-text', onclick });
      bindRender(btn, () => { btn.textContent = tx(labelKey); });
      return btn;
    }

    const addButton = button('lpAdd', () => addProfile());
    const removeButton = button('lpRemove', () => removeProfile());
    const renameButton = button('lpRename', () => renameProfile());
    const moveButton = button('lpMoveTo', () => moveProfile());
    const upButton = button('lpUp', () => moveWithin(-1));
    const downButton = button('lpDown', () => moveWithin(1));
    const shortcutButton = which === 'shared' ? button('lpShortcut', () => assignShortcut()) : null;

    function rowFor(profile) {
      const isSelected = selected && selected.kind === 'profile' && selected.name === profile.name && selected.node === profile.node;
      const row = h('div', {
        role: 'treeitem', 'aria-selected': String(!!isSelected), tabindex: '-1',
        style: {
          display: 'flex', alignItems: 'center', gap: '8px',
          minHeight: 'calc(30px * var(--den))', padding: `0 calc(8px * var(--den)) 0 calc(${profile.node ? 26 : 8}px * var(--den))`,
          borderRadius: 'var(--shape-xs)',
          background: isSelected ? 'var(--secc)' : 'transparent',
          color: isSelected ? 'var(--onsecc)' : 'var(--onsfc)',
          fontSize: 'var(--type-body-sm)', cursor: 'default',
        },
        onclick: () => row.__select(),
        ondblclick: () => { fill(profile); accept(); },
      },
      h('span', { class: 'ellipsis', style: { flex: '0 1 auto', fontWeight: '600' }, title: profile.name }, profile.name),
      h('span', { class: 'ellipsis muted mono', style: { flex: '1 1 auto', fontSize: 'var(--type-label-sm)' }, title: `${profile.local} · ${profile.remote}` },
        [profile.local, profile.remote].filter(Boolean).join('  ·  ')),
      profile.shortCut ? h('kbd', {}, profile.shortCut) : null);
      // Selecting is separate from activating, so arrowing through the tree can
      // move the selection without also firing the click handler's side effects.
      row.__select = () => { selected = { kind: 'profile', name: profile.name, node: profile.node }; fill(profile); paint(); };
      return row;
    }

    function paint() {
      clear(tree);
      const items = visible();
      if (!items.length) {
        tree.appendChild(h('div', { class: 'muted', style: { padding: 'calc(10px * var(--den))' } },
          search.isActive ? noMatchMessage(search.predicate, tx('lpTitle')) : tx('lpEmpty')));
        paintButtons();
        return;
      }
      const top = items.filter((p) => !p.node);
      const grouped = new Map();
      for (const p of items) {
        if (!p.node) continue;
        if (!grouped.has(p.node)) grouped.set(p.node, []);
        grouped.get(p.node).push(p);
      }
      for (const [node, children] of grouped) {
        const isCollapsed = collapsed.has(node);
        const isSelected = selected && selected.kind === 'folder' && selected.node === node;
        const header = h('div', {
          role: 'treeitem', 'aria-expanded': String(!isCollapsed), 'aria-selected': String(!!isSelected), tabindex: '-1',
          style: {
            display: 'flex', alignItems: 'center', gap: '6px',
            minHeight: 'calc(30px * var(--den))', padding: '0 calc(8px * var(--den))',
            borderRadius: 'var(--shape-xs)', fontWeight: '700',
            background: isSelected ? 'var(--secc)' : 'transparent',
            color: isSelected ? 'var(--onsecc)' : 'var(--onsv)',
            fontSize: 'var(--type-label-md)', cursor: 'default',
          },
          onclick: () => {
            selected = { kind: 'folder', node };
            if (isCollapsed) collapsed.delete(node); else collapsed.add(node);
            paint();
          },
        }, h('span', {}, isCollapsed ? '▸' : '▾'), h('span', { class: 'ellipsis' }, node),
        h('span', { class: 'muted' }, `(${children.length})`));
        // Arrowing onto a folder selects it; collapsing is Left/Right or a
        // click, never a side effect of moving through the list.
        header.__select = () => { selected = { kind: 'folder', node }; paint(); };
        header.__setExpanded = (open) => {
          if (open) collapsed.delete(node); else collapsed.add(node);
          selected = { kind: 'folder', node };
          paint();
        };
        tree.appendChild(header);
        if (!isCollapsed) for (const child of children) tree.appendChild(rowFor(child));
      }
      for (const p of top) tree.appendChild(rowFor(p));
      note.textContent = '';
      paintButtons();
    }

    function paintButtons() {
      const hasProfile = !!(selected && selected.kind === 'profile');
      const local = localInput.value.trim();
      const remote = remoteInput.value.trim();
      addButton.disabled = !local && !remote;
      removeButton.disabled = !selected;
      renameButton.disabled = !selected;
      moveButton.disabled = !hasProfile;
      if (shortcutButton) shortcutButton.disabled = !hasProfile;
      const siblings = hasProfile ? list().filter((p) => p.node === selected.node) : [];
      const at = hasProfile ? siblings.findIndex((p) => p.name === selected.name) : -1;
      upButton.disabled = !hasProfile || at <= 0;
      downButton.disabled = !hasProfile || at < 0 || at >= siblings.length - 1;
    }

    function find(sel) {
      if (!sel || sel.kind !== 'profile') return -1;
      return list().findIndex((p) => p.name === sel.name && p.node === sel.node);
    }

    function fill(profile) {
      localInput.value = profile.local || '';
      remoteInput.value = profile.remote || '';
      update();
    }

    async function save(label) {
      await writeProfiles(which, list(), sessionKey, label);
    }

    function addProfile() {
      const local = localInput.value.trim();
      const remote = remoteInput.value.trim();
      if (!local && !remote) { notify.warning(tx('lpTitle'), tx('lpDirRequired')); return; }
      const defaultName = (props.side === 'local' && local) || !remote ? local : remote;
      openNameDialog({
        title: tx('lpNameTitle'),
        name: defaultName,
        node: selected ? selected.node : '',
        folders: folders(),
        onOk: async (name, node) => {
          const existing = list().find((p) => p.name === name && p.node === node);
          if (existing) {
            // The C++ overwrites the matching profile rather than duplicating it.
            existing.local = local;
            existing.remote = remote;
          } else {
            list().push(normalizeProfile({ name, node, local, remote }));
          }
          selected = { kind: 'profile', name, node };
          await save(`Saved the location profile ${name}`);
          paint();
          notify.success(tx('lpAdded', name));
          announce(tx('lpAdded', name));
        },
      });
    }

    async function removeProfile() {
      if (!selected) return;
      if (selected.kind === 'folder') {
        // Removing a folder frees its profiles to the top level rather than
        // deleting work the user never asked to lose.
        for (const p of list()) if (p.node === selected.node) p.node = '';
        selected = null;
        await save('Removed a location-profile folder');
        paint();
        return;
      }
      const at = find(selected);
      if (at < 0) return;
      const [gone] = list().splice(at, 1);
      selected = null;
      await save(`Removed the location profile ${gone.name}`);
      paint();
      notify.info(tx('lpRemoved', gone.name));
    }

    function renameProfile() {
      if (!selected) return;
      if (selected.kind === 'folder') {
        openNameDialog({
          title: tx('lpNameTitle'), name: selected.node, node: '', folders: [], hideFolder: true,
          onOk: async (name) => {
            for (const p of list()) if (p.node === selected.node) p.node = name;
            selected = { kind: 'folder', node: name };
            await save('Renamed a location-profile folder');
            paint();
            notify.success(tx('lpRenamed', name));
          },
        });
        return;
      }
      const at = find(selected);
      if (at < 0) return;
      const profile = list()[at];
      openNameDialog({
        title: tx('lpNameTitle'), name: profile.name, node: profile.node, folders: folders(),
        onOk: async (name, node) => {
          if (list().some((p, i) => i !== at && p.name === name && p.node === node)) {
            notify.warning(tx('lpNameTitle'), tx('lpNameTaken', name));
            return;
          }
          profile.name = name;
          profile.node = node;
          selected = { kind: 'profile', name, node };
          await save(`Renamed the location profile to ${name}`);
          paint();
          notify.success(tx('lpRenamed', name));
        },
      });
    }

    function moveProfile() {
      const at = find(selected);
      if (at < 0) return;
      const profile = list()[at];
      openNameDialog({
        title: tx('lpMoveTitle'),
        body: tx('lpMoveBody', profile.name),
        name: profile.name,
        node: profile.node,
        folders: folders(),
        hideName: true,
        onOk: async (_name, node) => {
          profile.node = node;
          selected = { kind: 'profile', name: profile.name, node };
          await save(`Moved the location profile ${profile.name}`);
          paint();
          notify.success(tx('lpMoved', node || tx('lpTopLevel')));
        },
      });
    }

    async function moveWithin(delta) {
      const at = find(selected);
      if (at < 0) return;
      const all = list();
      const profile = all[at];
      const siblingIndexes = all.map((p, i) => (p.node === profile.node ? i : -1)).filter((i) => i >= 0);
      const pos = siblingIndexes.indexOf(at);
      const target = siblingIndexes[pos + delta];
      if (target === undefined) return;
      all[at] = all[target];
      all[target] = profile;
      await save('Reordered the location profiles');
      paint();
    }

    function assignShortcut() {
      const at = find(selected);
      if (at < 0) return;
      const profile = list()[at];
      const taken = {};
      for (const p of list()) if (p.shortCut) taken[p.shortCut] = p.name;
      openDialog('bookmark-shortcut', {
        name: profile.name,
        path: profile.name,
        current: profile.shortCut,
        taken,
        onAssign: async (combo) => {
          for (const p of list()) if (p.shortCut === combo && p !== profile) p.shortCut = '';
          profile.shortCut = combo;
          await save('Changed a location-profile shortcut');
          paint();
          if (combo) notify.success(tx('lpShortcutSet', combo, profile.name));
        },
      });
    }

    tree.addEventListener('keydown', (e) => {
      const rows = Array.from(tree.querySelectorAll('[role="treeitem"]'));
      if (!rows.length) return;
      const active = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
      if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, active + 1)]?.__select?.(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, active - 1)]?.__select?.(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); rows[active]?.__setExpanded?.(true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); rows[active]?.__setExpanded?.(false); }
      else if (e.key === 'Delete') { e.preventDefault(); removeProfile(); }
      else if (e.key === 'F2') { e.preventDefault(); renameProfile(); }
      else if (e.key === 'Enter' && selected && selected.kind === 'profile') { e.preventDefault(); accept(); }
    });

    const element = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(8px * var(--den))' } },
      h('div', { class: 'row' }, search.element),
      tree,
      note,
      h('div', { class: 'row' }, addButton, removeButton, renameButton, moveButton, upButton, downButton, shortcutButton));
    appearanceTarget(element, `locprofiles-sheet-${which}`, `Location profiles: ${which}`);

    return {
      element,
      paint,
      paintButtons,
      selectMatching(local, remote) {
        const hit = list().find((p) => p.local === local && p.remote === remote);
        selected = hit ? { kind: 'profile', name: hit.name, node: hit.node } : null;
        paint();
      },
    };
  }

  const siteSheet = profileSheet('site');
  const sharedSheet = profileSheet('shared');

  const sheets = createSheets([
    {
      id: 'site',
      label: tx('lpSiteSheet'),
      content: sessionKey ? siteSheet.element : h('p', { class: 'prose muted' }, tx('lpNoSession')),
    },
    { id: 'shared', label: tx('lpSharedSheet'), content: sharedSheet.element },
  ], { id: 'locationprofiles', label: tx('lpTitle') });
  if (!sessionKey) sheets.setVisible('site', false);

  const bookmarksButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      writePrefs({ useLocationProfiles: false }, 'Switched to bookmarks');
      close();
      openDialog('opendirectory', {
        side: props.side,
        directory: props.side === 'local' ? localInput.value : remoteInput.value,
        localDirectory: localInput.value,
        remoteDirectory: remoteInput.value,
        sessionKey,
        sessionId: props.sessionId,
        onOpen: (path) => props.onOpen?.(props.side === 'local'
          ? { local: path, remote: remoteInput.value }
          : { local: localInput.value, remote: path }),
      });
    },
  });
  bindRender(bookmarksButton, () => { bookmarksButton.textContent = tx('lpBookmarks'); });

  const content = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, localLabel, localInput, browseButton),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, remoteLabel, remoteInput),
    localHistory, remoteHistory,
    sheets.element,
    h('div', { class: 'row' }, bookmarksButton));
  appearanceTarget(content, 'locationprofiles-dialog', 'Location profiles dialog');

  let okButton = null;

  function update() {
    if (okButton) okButton.disabled = !localInput.value.trim() && !remoteInput.value.trim();
    siteSheet.paintButtons();
    sharedSheet.paintButtons();
  }

  function findProfile() {
    const local = localInput.value.trim();
    const remote = remoteInput.value.trim();
    siteSheet.selectMatching(local, remote);
    sharedSheet.selectMatching(local, remote);
  }

  function accept() {
    const local = localInput.value.trim();
    const remote = remoteInput.value.trim();
    if (!local && !remote) { notify.warning(tx('lpTitle'), tx('lpDirRequired')); return; }
    if (local) pushHistory('localDirectory', local);
    if (remote) pushHistory('remoteDirectory', remote);
    props.onOpen?.({ local, remote });
    announce(tx('lpOpened', [local, remote].filter(Boolean).join(' · ')));
    close();
  }

  readProfiles(sessionKey).then((loaded) => {
    profiles = loaded;
    siteSheet.paint();
    sharedSheet.paint();
    findProfile();
    update();
  });

  readHistory('localDirectory').then((list) => {
    localHistory.replaceChildren(...list.map((value) => h('option', { value })));
  });
  readHistory('remoteDirectory').then((list) => {
    remoteHistory.replaceChildren(...list.map((value) => h('option', { value })));
  });

  update();

  return {
    title: tx('lpTitle'),
    width: 660,
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
/* the name / folder prompt (TBookmarkNameDialog)                      */
/* ================================================================== */

registerDialog('profile-name', ({ props, close }) => {
  const nameId = uid('pn');
  const folderId = uid('pf');
  const nameInput = h('input', { type: 'text', class: 'field-input', id: nameId, autocomplete: 'off' });
  const folderInput = h('input', {
    type: 'text', class: 'field-input', id: folderId, autocomplete: 'off',
    list: `${folderId}-list`,
  });
  nameInput.value = props.name || '';
  folderInput.value = props.node || '';
  const folderList = h('datalist', { id: `${folderId}-list` },
    ...(props.folders || []).map((f) => h('option', { value: f })));

  const nameRow = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: nameId }, tx('lpNameLabel')), nameInput);
  const folderRow = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: folderId }, tx('lpFolderLabel')), folderInput, folderList);
  nameRow.hidden = !!props.hideName;
  folderRow.hidden = !!props.hideFolder;

  return {
    title: props.title,
    width: 460,
    content: h('div', { class: 'stack' },
      props.body ? h('p', { class: 'prose' }, props.body) : null,
      nameRow, folderRow),
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        onSelect: () => {
          const name = nameInput.value.trim();
          if (!name && !props.hideName) { notify.warning(props.title, tx('lpNameRequired')); return true; }
          props.onOk(name, folderInput.value.trim());
          close();
          return true;
        },
      },
    ],
  };
});

function openNameDialog(props) { return openDialog('profile-name', props); }

/** Open the location-profiles dialog. */
export function openLocationProfiles(props) { return openDialog('locationprofiles', props); }
