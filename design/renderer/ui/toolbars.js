// ui/toolbars.js — every toolbar band WinSCP has, rebuilt in Material 3.
//
// The bands and their contents are transcribed from ScpCommander.dfm and
// ScpExplorer.dfm, so a band here holds exactly the buttons the original band
// holds, in the original order. Each button is a commands.js action — there is
// no second implementation anywhere in this file.
//
// Bands are:
//   * toggleable    — the View → Toolbars menu drives isBandVisible/toggleBand
//   * lockable      — window.lockToolbars freezes drag-reordering
//   * selective     — window.selectiveToolbarText shows text on the buttons a
//                     band marks as primary, icons only on the rest
//   * three sizes   — window.toolbarIconSize: normal | large | veryLarge
//   * customizable  — openCustomizer() edits band visibility and per-band
//                     button visibility, persisted per interface style
//
// Anything a band cannot render as a plain button (the path combo box, the
// transfer-settings dropdown, the command-line prompt) is declared as a widget
// and supplied by the host through `widgets`.

import { h, icon, uid, appearanceTarget, announce, oneLine, rovingFocus } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { attachMenuButton, registerContextMenu, SEPARATOR } from './contextmenu.js';
import { notify } from './notifications.js';
import {
  runAction, commandState, actionLabel, getCommand, readPref, writePref, ensureStyle,
} from './commands.js';

const SEP = { separator: true };

/* ================================================================== */
/* the band table                                                      */
/* ================================================================== */
// `primary: true` on an item means "show its text when selective text labels
// are on" — WinSCP's own choice of which buttons carry a caption.

const A = (name, primary, extra) => ({ action: name, primary: !!primary, ...(extra || {}) });
const W = (widget) => ({ widget });
/** A split button: the action runs on click, the chevron opens the choices. */
const ASPLIT = (name, primary, submenu, extra) => ({ action: name, primary: !!primary, submenu, ...(extra || {}) });

export const BANDS = {
  /* ---- shared between both interfaces ---- */
  menu: {
    id: 'menu', labelKey: 'mFiles', iface: 'both', kind: 'menu', order: 0,
    label: 'Menu',
  },
  hotkeys: {
    id: 'hotkeys', label: 'Hot Keys', iface: 'commander', order: 90, defaultVisible: false,
    items: [
      A('CurrentRenameAction', true), A('CurrentEditAction', true), A('RemoteCopyAction', true),
      A('RemoteMoveAction', true), A('CurrentCreateDirAction', true), A('CurrentDeleteAction', true),
      A('CurrentPropertiesAction', true), A('CloseApplicationAction2', true),
    ],
  },
  session: {
    id: 'session', label: 'Sessions and Tabs', iface: 'both', order: 20,
    items: [
      A('NewTabAction', true), A('SaveCurrentSessionAction2'), SEP,
      A('DuplicateTabAction'), A('CloseTabAction'), SEP, A('SavedSessionsAction2', true),
    ],
  },
  preferences: {
    id: 'preferences', label: 'Preferences', iface: 'both', order: 30,
    items: [
      A('PreferencesAction', true), SEP,
      // Explorer's Preferences band also carries the view-style cycle and the
      // tree toggle; Commander puts those on each panel's own bands instead.
      ASPLIT('RemoteCycleStyleAction', false, [
        'RemoteIconAction', 'RemoteSmallIconAction', 'RemoteListAction',
        'RemoteReportAction', 'RemoteThumbnailAction',
      ], { iface: 'explorer' }),
      A('QueueToggleShowAction', true),
      A('RemoteTreeAction', false, { iface: 'explorer' }),
    ],
  },
  sort: {
    id: 'sort', label: 'Sort', iface: 'both', order: 40, defaultVisible: false,
    items: [
      A('CurrentSortAscendingAction'), SEP, A('CurrentSortByNameAction'), A('CurrentSortByExtAction'),
      A('CurrentSortBySizeAction'), A('CurrentSortByTypeAction2'), A('CurrentSortByChangedAction2'),
      A('CurrentSortByRightsAction'), A('CurrentSortByOwnerAction'), A('CurrentSortByGroupAction'),
    ],
  },
  updates: {
    id: 'updates', label: 'Updates', iface: 'both', order: 60, defaultVisible: false,
    items: [A('CheckForUpdatesAction', true)],
  },
  transfer: {
    id: 'transfer', label: 'Transfer Settings', iface: 'both', order: 70,
    items: [W('transferPreset')],
  },
  customCommands: {
    id: 'customCommands', label: 'Custom Commands', iface: 'both', order: 80, defaultVisible: false,
    items: [A('CustomCommandsFileAction', true), A('CustomCommandsNonFileAction'), A('CustomCommandsEnterAction')],
  },

  /* ---- commander only ---- */
  commands: {
    id: 'commands', label: 'Commands', iface: 'commander', order: 10,
    items: [
      A('CompareDirectoriesAction2', true), A('SynchronizeAction'), A('FullSynchronizeAction2', true), SEP,
      A('ConsoleAction'), A('PuttyAction'), SEP, A('SynchronizeBrowsingAction2'),
    ],
  },
  localHistory: {
    id: 'localHistory', label: 'Local History', iface: 'commander', side: 'local', order: 0,
    items: [A('LocalBackAction'), A('LocalForwardAction')],
  },
  localNavigation: {
    id: 'localNavigation', label: 'Local Navigation', iface: 'commander', side: 'local', order: 1,
    items: [
      A('LocalParentDirAction'), A('LocalRootDirAction'), A('LocalHomeDirAction'), A('LocalRefreshAction'),
      SEP, A('LocalTreeAction'),
      ASPLIT('LocalReportAction', false, ['LocalReportAction', 'LocalThumbnailAction']),
    ],
  },
  localPath: {
    id: 'localPath', label: 'Local Path', iface: 'commander', side: 'local', order: 2, alwaysVisible: true,
    items: [W('path'), A('LocalOpenDirAction'), A('LocalFilterAction')],
  },
  localFile: {
    id: 'localFile', label: 'Local Files', iface: 'commander', side: 'local', order: 3,
    items: [
      A('LocalCopyAction', true), SEP, A('LocalEditAction2'), A('LocalDeleteAction2'),
      A('LocalRenameAction2'), A('LocalPropertiesAction2'), SEP, A('LocalCreateDirAction3'), A('LocalNewFileAction'),
    ],
  },
  localSelection: {
    id: 'localSelection', label: 'Local Selection', iface: 'commander', side: 'local', order: 4, defaultVisible: false,
    items: [A('LocalSelectAction2'), A('LocalUnselectAction2'), A('LocalSelectAllAction2')],
  },
  remoteHistory: {
    id: 'remoteHistory', label: 'Remote History', iface: 'commander', side: 'remote', order: 0,
    items: [A('RemoteBackAction'), A('RemoteForwardAction')],
  },
  remoteNavigation: {
    id: 'remoteNavigation', label: 'Remote Navigation', iface: 'commander', side: 'remote', order: 1,
    items: [
      A('RemoteParentDirAction'), A('RemoteRootDirAction'), A('RemoteHomeDirAction'), A('RemoteRefreshAction'),
      SEP, A('RemoteFindFilesAction2'), SEP, A('RemoteTreeAction'),
      ASPLIT('RemoteReportAction', false, [
        'RemoteIconAction', 'RemoteSmallIconAction', 'RemoteListAction',
        'RemoteReportAction', 'RemoteThumbnailAction',
      ]),
    ],
  },
  remotePath: {
    id: 'remotePath', label: 'Remote Path', iface: 'commander', side: 'remote', order: 2, alwaysVisible: true,
    items: [W('path'), A('RemoteOpenDirAction'), A('RemoteFilterAction')],
  },
  remoteFile: {
    id: 'remoteFile', label: 'Remote Files', iface: 'commander', side: 'remote', order: 3,
    items: [
      A('RemoteCopyAction', true), SEP, A('RemoteEditAction2'), A('RemoteDeleteAction2'),
      A('RemoteRenameAction2'), A('RemotePropertiesAction2'), SEP, A('RemoteCreateDirAction3'), A('RemoteNewFileAction'),
    ],
  },
  remoteSelection: {
    id: 'remoteSelection', label: 'Remote Selection', iface: 'commander', side: 'remote', order: 4, defaultVisible: false,
    items: [A('RemoteSelectAction2'), A('RemoteUnselectAction2'), A('RemoteSelectAllAction2')],
  },

  /* ---- explorer only ---- */
  address: {
    id: 'address', label: 'Address', iface: 'explorer', order: 5, alwaysVisible: true,
    items: [W('path'), A('RemoteOpenDirAction'), A('RemoteFilterAction')],
  },
  buttons: {
    id: 'buttons', label: 'Commands', iface: 'explorer', order: 10,
    items: [
      A('RemoteBackAction'), A('RemoteForwardAction'), SEP,
      A('RemoteParentDirAction'), A('RemoteRootDirAction'), A('RemoteHomeDirAction'), A('RemoteRefreshAction'), SEP,
      A('RemoteFindFilesAction2'), SEP, A('RemoteCopyAction', true), SEP,
      A('RemoteEditAction2'), A('CurrentOpenAction'), A('RemoteDeleteAction2'),
      A('RemotePropertiesAction2'), A('RemoteRenameAction2'), SEP,
      A('RemoteCreateDirAction3'), A('ConsoleAction'), A('PuttyAction'), SEP,
      A('SynchronizeAction'), A('FullSynchronizeAction2'),
    ],
  },
  selection: {
    id: 'selection', label: 'Selection', iface: 'explorer', order: 15,
    items: [
      A('SelectAction'), A('UnselectAction'), SEP,
      A('SelectAllAction'), A('InvertSelectionAction'), A('ClearSelectionAction'), A('RestoreSelectionAction'),
    ],
  },
};

/** Bands that belong to one interface style, in dock order. */
export function bandsFor(iface, side) {
  return Object.values(BANDS)
    .filter((b) => (b.iface === 'both' || b.iface === iface))
    .filter((b) => (side ? b.side === side : !b.side))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/* ================================================================== */
/* styles                                                             */
/* ================================================================== */

const MODULE_CSS = `
.tbdock{display:flex;flex-wrap:wrap;align-items:stretch;gap:calc(4px*var(--den,1));
  padding:calc(2px*var(--den,1)) calc(4px*var(--den,1));background:var(--md-sys-color-surface-container-low,var(--sfc1,transparent));
  border-bottom:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)))}
.tbdock[data-empty="1"]{display:none}
.tbband{display:flex;align-items:center;gap:calc(1px*var(--den,1));border-radius:var(--shape-sm,8px);
  padding:calc(2px*var(--den,1));min-height:calc(30px*var(--den,1))}
.tbband.is-dragging{opacity:.55}
.tbband.is-droptarget{outline:2px dashed var(--md-sys-color-primary,var(--pri,#0B57D0));outline-offset:-2px}
.tbband-grip{display:flex;align-items:center;color:var(--md-sys-color-outline,var(--out,#79747E));cursor:grab;
  padding-inline:calc(1px*var(--den,1))}
.tbdock[data-locked="1"] .tbband-grip{display:none}
.tbbtn{display:inline-flex;align-items:center;gap:calc(5px*var(--den,1));border:0;background:transparent;cursor:pointer;
  color:var(--md-sys-color-on-surface,var(--onsfc,#1D1B20));border-radius:var(--shape-sm,8px);
  min-height:calc(30px*var(--den,1));padding:0 calc(7px*var(--den,1));font:inherit;font-size:var(--type-label-md,.8125rem);
  white-space:nowrap;max-width:calc(240px*var(--uiscale,1))}
.tbbtn:hover:not(:disabled){background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.06))}
.tbbtn[aria-pressed="true"],.tbbtn.is-on{background:var(--md-sys-color-secondary-container,rgba(11,87,208,.14));
  color:var(--md-sys-color-on-secondary-container,var(--onsec,#0B57D0))}
.tbbtn:disabled{opacity:.38;cursor:default}
.tbbtn-label{overflow:hidden;text-overflow:ellipsis}
.tbsep{width:1px;align-self:stretch;margin:calc(4px*var(--den,1)) calc(3px*var(--den,1));
  background:var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)))}
.tbwidget{display:flex;align-items:center;gap:calc(4px*var(--den,1));flex:1 1 200px;min-width:calc(120px*var(--den,1))}
.tbcust-list{display:flex;flex-direction:column;gap:calc(4px*var(--den,1));max-height:340px;overflow:auto}
.tbcust-row{display:flex;align-items:center;gap:calc(8px*var(--den,1))}
`;

/* ================================================================== */
/* the toolbar controller                                              */
/* ================================================================== */

const ICON_PX = { normal: 17, large: 21, veryLarge: 26 };

/**
 * createToolbars({ workspace }) — one controller for the whole window. It owns
 * band visibility, the icon size, the lock and the customizer, and hands out
 * docks that render themselves from that state.
 */
export function createToolbars(opts = {}) {
  ensureStyle('winscp-toolbars', MODULE_CSS);
  const docks = new Set();
  const workspace = opts.workspace || null;

  function iface() {
    return (workspace && workspace.interfaceMode()) || readPref('interface', 'commander');
  }

  function visKey() { return `${iface() === 'explorer' ? 'scpExplorer' : 'scpCommander'}.bands`; }

  function bandVisibility() {
    const saved = readPref(visKey(), null);
    return saved && typeof saved === 'object' ? saved : {};
  }

  function isBandVisible(id) {
    const band = BANDS[id];
    if (!band) return false;
    if (band.alwaysVisible) return true;
    const saved = bandVisibility();
    if (Object.prototype.hasOwnProperty.call(saved, id)) return !!saved[id];
    return band.defaultVisible !== false;
  }

  function setBandVisible(id, on) {
    const band = BANDS[id];
    if (!band || band.alwaysVisible) return false;
    const next = { ...bandVisibility(), [id]: !!on };
    writePref(visKey(), next, `Changed the ${band.label} toolbar`);
    announce(`${band.label}: ${on ? t('on') : t('off')}`);
    syncAll();
    return true;
  }

  function toggleBand(id) { return setBandVisible(id, !isBandVisible(id)); }

  function buttonVisibility(bandId) {
    const saved = readPref(`${visKey()}Buttons`, null);
    return (saved && saved[bandId]) || {};
  }

  function setButtonVisible(bandId, action, on) {
    const all = readPref(`${visKey()}Buttons`, null) || {};
    const next = { ...all, [bandId]: { ...(all[bandId] || {}), [action]: !!on } };
    writePref(`${visKey()}Buttons`, next, `Changed the ${BANDS[bandId]?.label || bandId} toolbar buttons`);
    syncAll();
  }

  function iconSize() { return ICON_PX[readPref('window.toolbarIconSize', 'normal')] || ICON_PX.normal; }
  function selectiveText() { return readPref('window.selectiveToolbarText', true) !== false; }
  function locked() { return readPref('window.lockToolbars', false) === true; }

  function syncAll() { for (const d of docks) d.sync(); }

  /* ---- the customizer ---- */
  async function openCustomizer() {
    const { openModal } = await import('../dom.js');
    const list = h('div', { class: 'tbcust-list' });
    const all = [...bandsFor(iface()), ...bandsFor(iface(), 'local'), ...bandsFor(iface(), 'remote')];
    for (const band of all) {
      const box = h('input', { type: 'checkbox', class: 'check' });
      box.checked = isBandVisible(band.id);
      box.disabled = !!band.alwaysVisible;
      box.addEventListener('change', () => setBandVisible(band.id, box.checked));
      const buttons = h('div', { class: 'tbcust-list', style: { paddingInlineStart: '22px' } });
      for (const item of band.items || []) {
        if (item.separator || item.widget) continue;
        const bbox = h('input', { type: 'checkbox', class: 'check' });
        const vis = buttonVisibility(band.id);
        bbox.checked = vis[item.action] !== false;
        bbox.addEventListener('change', () => setButtonVisible(band.id, item.action, bbox.checked));
        buttons.appendChild(h('label', { class: 'tbcust-row' }, bbox,
          h('span', { class: 'ellipsis' }, actionLabel(item.action))));
      }
      list.appendChild(h('details', {},
        h('summary', {}, h('label', { class: 'tbcust-row' }, box, h('span', {}, band.label))),
        buttons));
    }
    openModal({
      title: t('toolbars'),
      width: 560,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose muted' }, 'Turn a band on or off, and choose which of its buttons appear. Changes apply immediately and are kept per interface style.'),
        list),
      actions: [
        {
          label: t('reset'), kind: 'text',
          onSelect: () => {
            writePref(visKey(), {}, 'Reset the toolbar layout');
            writePref(`${visKey()}Buttons`, {}, 'Reset the toolbar buttons');
            syncAll();
          },
        },
        { label: t('close'), kind: 'filled', autofocus: true },
      ],
    });
  }

  const controller = {
    isBandVisible, setBandVisible, toggleBand, openCustomizer,
    iconSize, selectiveText, locked, syncAll,
    bands: BANDS,
    /** Create a dock for a place in the layout. */
    createDock(dockOpts = {}) {
      const dock = createDock({ ...dockOpts, controller, iface });
      docks.add(dock);
      const origDestroy = dock.destroy;
      dock.destroy = () => { docks.delete(dock); origDestroy(); };
      return dock;
    },
    destroy() { for (const d of Array.from(docks)) d.destroy(); },
  };

  // Anything that changes a command's enabled/checked state repaints the docks.
  const offs = [
    bus.on('prefs:changed', syncAll),
    bus.on('panel:selectionChanged', syncAll),
    bus.on('panel:pathChanged', syncAll),
    bus.on('panel:activeSideChanged', syncAll),
    bus.on('session:opened', syncAll),
    bus.on('i18n:changed', syncAll),
  ];
  const baseDestroy = controller.destroy;
  controller.destroy = () => { offs.forEach((off) => off()); baseDestroy(); };

  return controller;
}

/* ================================================================== */
/* one dock                                                            */
/* ================================================================== */

/**
 * createDock({ controller, side, widgets, ctxFor }) -> { element, sync, destroy }
 *
 * `side` limits the dock to that panel's bands (Commander's per-panel docks).
 * `widgets` maps a widget name to a factory returning a Node.
 * `ctxFor()` supplies the command context (which panel this dock belongs to).
 */
function createDock(opts = {}) {
  const { controller } = opts;
  const root = h('div', { class: 'tbdock', role: 'toolbar', 'aria-label': opts.label || t('toolbars') });
  appearanceTarget(root, `toolbar-dock-${opts.id || opts.side || 'main'}`, `Toolbar dock: ${opts.label || opts.side || 'main'}`);
  const widgetCache = new Map();
  let order = null;

  function orderKey() {
    return `${opts.side ? `${opts.side}Dock` : 'mainDock'}Order`;
  }

  function bandOrder() {
    if (order) return order;
    const saved = readPref(`${controller.locked ? '' : ''}scpCommander.${orderKey()}`, null);
    order = Array.isArray(saved) ? saved : null;
    return order;
  }

  function sortedBands() {
    const list = bandsFor(opts.iface(), opts.side);
    const saved = bandOrder();
    if (!saved) return list;
    const index = new Map(saved.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => (index.has(a.id) ? index.get(a.id) : 999) - (index.has(b.id) ? index.get(b.id) : 999));
  }

  function ctx() {
    const base = typeof opts.ctxFor === 'function' ? opts.ctxFor() : {};
    return opts.side ? { side: opts.side, ...base } : base;
  }

  function buildButton(item, band) {
    const cmd = getCommand(item.action);
    if (!cmd) return null;
    const over = ctx();
    const state = commandState(item.action, over);
    if (!state.visible) return null;
    const label = actionLabel(item.action);
    const showText = controller.selectiveText() && item.primary;
    const btn = h('button', {
      type: 'button',
      class: `tbbtn${state.checked ? ' is-on' : ''}`,
      'data-action': item.action,
      title: state.reason || cmd.hint || label,
      'aria-label': label,
      'aria-keyshortcuts': cmd.shortcut || null,
    }, icon(cmd.icon, controller.iconSize()),
    showText ? h('span', { class: 'tbbtn-label' }, label) : null);
    appearanceTarget(btn, `toolbar-btn-${item.action}`, `Toolbar button: ${label}`);
    if (state.checked !== undefined) btn.setAttribute('aria-pressed', String(!!state.checked));
    btn.disabled = !state.enabled;
    // A band item may name its own choices (the view-style split buttons), and
    // a command may declare a submenu of its own (New Tab, Saved Sessions).
    const declared = Array.isArray(item.submenu)
      ? () => item.submenu.map((n) => {
        const st = commandState(n, ctx());
        return {
          label: actionLabel(n),
          icon: getCommand(n)?.icon,
          checked: st.checked,
          radio: getCommand(n)?.kind === 'radio',
          disabled: !st.enabled,
          onSelect: () => runAction(n, ctx()),
        };
      })
      : null;
    if (declared) {
      btn.appendChild(icon('arrow_drop_down', 12));
      attachMenuButton(btn, declared, { label, placement: 'bottom-start' });
    } else if (cmd.submenu) {
      attachMenuButton(btn, () => {
        const items = cmd.submenu(state.ctx) || [];
        return items.length ? items : [{ label, onSelect: () => runAction(item.action, over) }];
      }, { label, placement: 'bottom-start' });
    } else {
      btn.addEventListener('click', () => runAction(item.action, ctx()));
    }
    // A disabled button still explains itself: WinSCP greys a command out, and
    // the reason is the difference between "broken" and "not applicable here".
    if (!state.enabled && state.reason) btn.title = state.reason;
    return btn;
  }

  function buildBand(band) {
    const el = h('div', {
      class: 'tbband', 'data-band': band.id, role: 'group', 'aria-label': band.label,
      draggable: controller.locked() ? null : 'true',
    });
    appearanceTarget(el, `toolbar-band-${band.id}`, `Toolbar: ${band.label}`);
    if (!controller.locked()) {
      el.appendChild(h('span', { class: 'tbband-grip', 'aria-hidden': 'true' }, icon('drag_indicator', 13)));
      el.addEventListener('dragstart', (e) => {
        el.classList.add('is-dragging');
        try { e.dataTransfer.setData('application/x-winscp-band', band.id); } catch { /* refused */ }
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-winscp-band')) return;
        e.preventDefault();
        el.classList.add('is-droptarget');
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-droptarget'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-droptarget');
        const moved = e.dataTransfer.getData('application/x-winscp-band');
        if (!moved || moved === band.id) return;
        const ids = sortedBands().map((b) => b.id).filter((id) => id !== moved);
        ids.splice(ids.indexOf(band.id), 0, moved);
        order = ids;
        writePref(`scpCommander.${orderKey()}`, ids, 'Reordered the toolbars');
        sync();
      });
    }

    const vis = controller.isBandVisible(band.id);
    if (!vis) return null;

    if (band.kind === 'menu' && typeof opts.menuFactory === 'function') {
      el.appendChild(opts.menuFactory());
      return el;
    }

    const hidden = (readPref(`${opts.iface() === 'explorer' ? 'scpExplorer' : 'scpCommander'}.bandsButtons`, null) || {})[band.id] || {};
    let lastWasSep = true;
    for (const item of band.items || []) {
      if (item.separator) {
        if (!lastWasSep) { el.appendChild(h('span', { class: 'tbsep', role: 'separator' })); lastWasSep = true; }
        continue;
      }
      if (item.widget) {
        const factory = opts.widgets && opts.widgets[item.widget];
        if (!factory) continue;
        let node = widgetCache.get(item.widget);
        if (!node) { node = factory(); widgetCache.set(item.widget, node); }
        el.appendChild(h('span', { class: 'tbwidget' }, node));
        lastWasSep = false;
        continue;
      }
      if (hidden[item.action] === false) continue;
      if (item.iface && item.iface !== opts.iface()) continue;
      const btn = buildButton(item, band);
      if (btn) { el.appendChild(btn); lastWasSep = false; }
    }
    while (el.lastChild && el.lastChild.classList && el.lastChild.classList.contains('tbsep')) el.removeChild(el.lastChild);
    return el;
  }

  function sync() {
    // Widgets are cached and re-parented rather than rebuilt, so a path the
    // user is halfway through typing survives a repaint.
    for (const node of widgetCache.values()) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    while (root.firstChild) root.removeChild(root.firstChild);
    root.dataset.locked = controller.locked() ? '1' : '0';
    let any = false;
    for (const band of sortedBands()) {
      const el = buildBand(band);
      if (el) { root.appendChild(el); any = true; }
    }
    root.dataset.empty = any ? '0' : '1';
  }

  registerContextMenu(root, (menuCtx) => {
    // The dock's own menu must not duplicate a band's or a button's menu.
    if (menuCtx.target !== root && menuCtx.target.closest('.tbbtn')) return [];
    const items = [];
    for (const band of bandsFor(opts.iface(), opts.side)) {
      items.push({
        label: band.label, checked: controller.isBandVisible(band.id),
        disabled: !!band.alwaysVisible, keepOpen: true,
        onSelect: () => controller.toggleBand(band.id),
      });
    }
    items.push(SEPARATOR,
      { label: actionLabel('LockToolbarsAction'), checked: controller.locked(), onSelect: () => runAction('LockToolbarsAction') },
      { label: actionLabel('SelectiveToolbarTextAction'), checked: controller.selectiveText(), onSelect: () => runAction('SelectiveToolbarTextAction') },
      {
        label: actionLabel('ToolbarIconSizeAction'),
        submenu: ['ToolbarIconSizeNormalAction', 'ToolbarIconSizeLargeAction', 'ToolbarIconSizeVeryLargeAction'].map((n) => ({
          label: actionLabel(n), radio: true, checked: commandState(n).checked, onSelect: () => runAction(n),
        })),
      },
      SEPARATOR,
      { label: actionLabel('CustomizeToolbarAction'), icon: 'tune', onSelect: () => controller.openCustomizer() });
    return items;
  });

  const roving = rovingFocus(root, '.tbbtn', { orientation: 'horizontal' });
  sync();

  return {
    element: root,
    sync,
    destroy() { roving.dispose(); root.remove(); },
  };
}

/** A small helper the panel uses for its own "not available" explanation. */
export function explainDisabled(actionName, over) {
  const st = commandState(actionName, over || {});
  if (st.reason) { notify.warning(actionLabel(actionName), st.reason); return true; }
  return false;
}

export { oneLine as _oneLine, uid as _uid };
