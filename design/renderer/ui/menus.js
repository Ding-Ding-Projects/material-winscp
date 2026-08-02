// ui/menus.js — WinSCP's menu bar and file context menus, in Material 3.
//
// The trees below are transcribed item-by-item from ScpCommander.dfm and
// ScpExplorer.dfm, including separator placement, so a user who knows where a
// command lives in WinSCP finds it in the same place here. Every leaf is a
// commands.js action name — the menu never contains a handler of its own, so
// a command's enabled/checked state and its behaviour cannot drift between the
// menu bar, a toolbar button and a context menu.
//
// Rendering goes through ui/contextmenu.js, so roles, keyboard behaviour,
// typeahead and submenu handling are identical to every other menu in the app.

import { h, icon, appearanceTarget, rovingFocus } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { attachMenuButton, SEPARATOR, openMenu } from './contextmenu.js';
import {
  runAction, commandState, actionLabel, getCommand, readPref, ensureStyle,
} from './commands.js';

const S = SEPARATOR;
const A = (action) => ({ action });
/** A submenu whose title is a plain caption (WinSCP's "&Go To" and friends). */
const SUB = (labelKey, items, opts = {}) => ({ labelKey, items, ...opts });
/** A submenu whose title IS an action (clicking the parent runs it). */
const ASUB = (action, items) => ({ action, items });

/* ================================================================== */
/* shared sub-trees                                                    */
/* ================================================================== */

const QUEUE_MENU = SUB('queueTitle', [
  A('QueueEnableAction'), A('QueueGoToAction'), S,
  A('QueueItemQueryAction'), A('QueueItemErrorAction'), A('QueueItemPromptAction'), S,
  A('QueueItemExecuteAction'), A('QueueItemPauseAction'), A('QueueItemResumeAction'),
  A('QueueItemDeleteAction'), A('QueueItemSpeedAction'), S,
  A('QueueItemUpAction'), A('QueueItemDownAction'), S,
  SUB('all', [
    A('QueuePauseAllAction'), A('QueueResumeAllAction'), A('QueueDeleteAllAction'), S,
    A('QueueDeleteAllDoneAction'),
  ]),
]);

const QUEUE_VIEW_MENU = SUB('queueMenu', [
  A('QueueShowAction'), A('QueueHideWhenEmptyAction'), A('QueueHideAction'), S,
  A('QueueToolbarAction'), A('QueueFileListAction'), S,
  A('QueueResetLayoutColumnsAction'), S,
  ASUB('QueueCycleOnceEmptyAction', [
    A('QueueIdleOnceEmptyAction'), A('QueueDisconnectOnceEmptyAction2'),
    A('QueueSuspendOnceEmptyAction2'), A('QueueShutDownOnceEmptyAction2'),
  ]),
  A('QueuePreferencesAction'),
]);

const MARK_MENU = [
  A('SelectOneAction'), A('SelectAction'), A('UnselectAction'), A('SelectAllAction'), S,
  A('InvertSelectionAction'), A('ClearSelectionAction'), A('RestoreSelectionAction'), S,
  A('SelectSameExtAction'), A('UnselectSameExtAction'),
];

const HELP_MENU = [
  A('TableOfContentsAction'), A('TipsAction'), S,
  A('HomepageAction'), A('ForumPageAction'), A('HistoryPageAction'), S,
  A('CheckForUpdatesAction'), S, A('DonatePageAction'), S, A('AboutAction'),
];

const FILE_NAMES_MENU = SUB('name', [
  A('FileListToCommandLineAction'), A('FileListToClipboardAction'),
  A('FullFileListToClipboardAction'), A('FileGenerateUrlAction2'),
]);

const LOCKING_MENU = SUB('lockTab', [A('LockAction'), A('UnlockAction')]);

const ICON_SIZE_MENU = ASUB('ToolbarIconSizeAction', [
  A('ToolbarIconSizeNormalAction'), A('ToolbarIconSizeLargeAction'), A('ToolbarIconSizeVeryLargeAction'),
]);

/* ================================================================== */
/* the Commander menu bar                                              */
/* ================================================================== */

export const COMMANDER_MENUS = [
  {
    id: 'local', labelKey: 'mLocal', items: [
      A('LocalChangePathAction2'), S,
      SUB('mGoTo', [
        A('LocalOpenDirAction'), A('LocalExploreDirectoryAction'), S,
        A('LocalParentDirAction'), A('LocalRootDirAction'), A('LocalHomeDirAction'), A('LocalOtherDirAction'), S,
        A('LocalBackAction'), A('LocalForwardAction'),
      ]),
      A('LocalRefreshAction'), A('LocalAddBookmarkAction2'), A('LocalPathToClipboardAction2'), S,
      SUB('mView', [A('LocalReportAction'), S, A('LocalThumbnailAction')]),
      SUB('mSort', [
        A('LocalSortAscendingAction2'), S,
        A('LocalSortByNameAction2'), A('LocalSortByExtAction2'), A('LocalSortBySizeAction2'),
        A('LocalSortByTypeAction2'), A('LocalSortByChangedAction3'), A('LocalSortByAttrAction2'),
      ]),
      SUB('mColumns', [
        A('ShowHideLocalNameColumnAction2'), A('ShowHideLocalSizeColumnAction2'),
        A('ShowHideLocalTypeColumnAction2'), A('ShowHideLocalChangedColumnAction3'),
        A('ShowHideLocalAttrColumnAction2'), A('ShowHideLocalExtColumnAction2'), S,
        A('AutoSizeLocalColumnsAction'), A('ResetLayoutLocalColumnsAction'),
      ]),
      A('LocalFilterAction'),
    ],
  },
  { id: 'mark', labelKey: 'mMark', items: MARK_MENU },
  {
    id: 'files', labelKey: 'mFiles', items: [
      SUB('newBtn', [A('NewFileAction'), A('NewDirAction'), A('NewLinkAction')]),
      S,
      A('CurrentOpenAction'),
      ASUB('CurrentEditAction', [A('CurrentEditInternalAction'), A('CurrentEditWithAction')]),
      A('CurrentAddEditLinkAction'), S,
      ASUB('RemoteCopyAction', [
        A('RemoteCopyNonQueueAction'), A('RemoteCopyQueueAction'), S, A('RemoteMoveAction'),
      ]),
      A('RemoteCopyToAction'), A('RemoteMoveToAction'),
      A('CurrentDeleteAction'), A('CurrentRenameAction'), S,
      A('CurrentCopyToClipboardAction2'), A('PasteAction3'), S,
      ASUB('CustomCommandsFileAction', null),
      FILE_NAMES_MENU, LOCKING_MENU, S,
      A('CurrentPropertiesAction'), A('CalculateDirectorySizesAction'),
    ],
  },
  {
    id: 'commands', labelKey: 'mCommands', items: [
      A('CompareDirectoriesAction2'), A('SynchronizeAction'), A('FullSynchronizeAction2'),
      A('SynchronizeBrowsingAction2'), A('RemoteFindFilesAction2'),
      QUEUE_MENU, ASUB('CustomCommandsNonFileAction', null), S,
      A('ConsoleAction'), A('PuttyAction'), S,
      A('ClearCachesAction'), S, A('CloseApplicationAction2'),
    ],
  },
  {
    id: 'tabs', labelKey: 'mTabs', items: [
      ASUB('NewTabAction', [A('NewRemoteTabAction'), A('NewLocalTabAction'), S, A('DefaultToNewRemoteTabAction')]),
      A('CloseTabAction'), A('DuplicateTabAction'), A('RenameTabAction'), S,
      A('ColorMenuAction2'), S,
      A('DisconnectSessionAction'), A('ReconnectSessionAction'), A('SaveCurrentSessionAction2'), S,
      A('FileSystemInfoAction'), A('SessionGenerateUrlAction2'), A('ChangePasswordAction'), A('PrivateKeyUploadAction'), S,
      ASUB('OpenedTabsAction', null), ASUB('WorkspacesAction', null), A('SaveWorkspaceAction'), S,
      ASUB('SavedSessionsAction2', null),
    ],
  },
  {
    id: 'options', labelKey: 'mOptions', items: [
      SUB('toolbars', [
        A('CommanderCommandsBandAction'), A('CommanderSessionBandAction2'), A('CommanderPreferencesBandAction'),
        A('CommanderSortBandAction'), A('CommanderUpdatesBandAction'), A('CommanderTransferBandAction'),
        A('CommanderCustomCommandsBandAction'), S,
        A('ToolBar2Action'), S,
        A('LockToolbarsAction'), A('SelectiveToolbarTextAction'), ICON_SIZE_MENU, S,
        A('CustomizeToolbarAction'),
      ]),
      ASUB('CommanderLocalPanelAction', [
        A('CommanderLocalHistoryBandAction2'), A('CommanderLocalNavigationBandAction2'),
        A('CommanderLocalFileBandAction2'), A('CommanderLocalSelectionBandAction2'), S,
        A('LocalTreeAction'), S, A('LocalStatusBarAction2'),
      ]),
      ASUB('CommanderRemotePanelAction', [
        A('CommanderRemoteHistoryBandAction2'), A('CommanderRemoteNavigationBandAction2'),
        A('CommanderRemoteFileBandAction2'), A('CommanderRemoteSelectionBandAction2'), S,
        A('RemoteTreeAction'), S, A('RemoteStatusBarAction2'),
      ]),
      S,
      A('SessionsTabsAction2'), A('CommandLinePanelAction'), A('StatusBarAction'),
      QUEUE_VIEW_MENU, S,
      A('ShowHiddenFilesAction'), A('AutoReadDirectoryAfterOpAction'),
      SUB('sizeFormatPref', [
        A('FormatSizeBytesNoneAction'), A('FormatSizeBytesKilobytesAction'), A('FormatSizeBytesShortAction'),
      ]),
      A('FileColorsPreferencesAction'), S,
      A('PreferencesAction'),
    ],
  },
  {
    id: 'remote', labelKey: 'mRemote', items: [
      A('RemoteChangePathAction2'), S,
      SUB('mGoTo', [
        A('RemoteOpenDirAction'), A('RemoteExploreDirectoryAction'), S,
        A('RemoteParentDirAction'), A('RemoteRootDirAction'), A('RemoteHomeDirAction'), A('RemoteOtherDirAction'), S,
        A('RemoteBackAction'), A('RemoteForwardAction'),
      ]),
      A('RemoteRefreshAction'), A('RemoteAddBookmarkAction2'), A('RemotePathToClipboardAction2'), S,
      SUB('mView', [A('RemoteReportAction'), S, A('RemoteThumbnailAction')]),
      SUB('mSort', [
        A('RemoteSortAscendingAction2'), S,
        A('RemoteSortByNameAction2'), A('RemoteSortByExtAction2'), A('RemoteSortBySizeAction2'),
        A('RemoteSortByTypeAction2'), A('RemoteSortByChangedAction3'), A('RemoteSortByRightsAction2'),
        A('RemoteSortByOwnerAction2'), A('RemoteSortByGroupAction2'),
      ]),
      SUB('mColumns', [
        A('ShowHideRemoteNameColumnAction2'), A('ShowHideRemoteSizeColumnAction2'),
        A('ShowHideRemoteTypeColumnAction2'), A('ShowHideRemoteChangedColumnAction3'),
        A('ShowHideRemoteRightsColumnAction2'), A('ShowHideRemoteOwnerColumnAction2'),
        A('ShowHideRemoteGroupColumnAction2'), A('ShowHideRemoteLinkTargetColumnAction2'),
        A('ShowHideRemoteExtColumnAction2'), S,
        A('AutoSizeRemoteColumnsAction'), A('ResetLayoutRemoteColumnsAction'),
      ]),
      A('RemoteFilterAction'),
    ],
  },
  { id: 'help', labelKey: 'mHelp', items: HELP_MENU },
];

/* ================================================================== */
/* the Explorer menu bar                                               */
/* ================================================================== */

export const EXPLORER_MENUS = [
  {
    id: 'files', labelKey: 'mFiles', items: [
      SUB('newBtn', [A('NewFileAction'), A('NewDirAction'), A('NewLinkAction')]),
      S,
      A('CurrentOpenAction'),
      ASUB('RemoteEditAction2', [A('CurrentEditInternalAction'), A('CurrentEditWithAction')]),
      A('CurrentAddEditLinkAction'), S,
      A('RemoteDeleteAction2'), A('RemoteRenameAction2'), A('RemotePropertiesAction2'),
      A('CalculateDirectorySizesAction'), S,
      ASUB('RemoteCopyAction', [
        A('RemoteCopyNonQueueAction'), A('RemoteCopyQueueAction'), S, A('RemoteMoveAction'),
      ]),
      A('RemoteCopyToAction'), A('RemoteMoveToAction'), S,
      A('CurrentCopyToClipboardAction2'), A('PasteAction3'), S,
      ASUB('CustomCommandsFileAction', null),
      SUB('name', [
        A('FileListToClipboardAction'), A('FullFileListToClipboardAction'), A('FileGenerateUrlAction2'),
      ]),
      LOCKING_MENU, S,
      A('CloseTabAction'), A('CloseApplicationAction2'),
    ],
  },
  {
    id: 'commands', labelKey: 'mCommands', items: [
      A('SynchronizeAction'), A('FullSynchronizeAction2'), A('RemoteFindFilesAction2'),
      QUEUE_MENU, ASUB('CustomCommandsNonFileAction', null), S,
      A('RemoteAddBookmarkAction2'), A('RemotePathToClipboardAction2'), S,
      A('ConsoleAction'), A('PuttyAction'), S, A('ClearCachesAction'),
    ],
  },
  { id: 'mark', labelKey: 'mMark', items: MARK_MENU },
  {
    id: 'tabs', labelKey: 'mTabs', items: [
      A('NewTabAction'), A('CloseTabAction'), A('DuplicateTabAction'), A('RenameTabAction'), S,
      A('ColorMenuAction2'), S,
      A('DisconnectSessionAction'), A('ReconnectSessionAction'), A('SaveCurrentSessionAction2'), S,
      A('FileSystemInfoAction'), A('SessionGenerateUrlAction2'), A('ChangePasswordAction'), A('PrivateKeyUploadAction'), S,
      ASUB('OpenedTabsAction', null), ASUB('WorkspacesAction', null), A('SaveWorkspaceAction'), S,
      ASUB('SavedSessionsAction2', null),
    ],
  },
  {
    id: 'view', labelKey: 'mView', items: [
      SUB('toolbars', [
        A('ExplorerAddressBandAction'), A('ExplorerToolbarBandAction'), A('ExplorerSelectionBandAction'),
        A('ExplorerSessionBandAction2'), A('ExplorerPreferencesBandAction'), A('ExplorerSortBandAction'),
        A('ExplorerUpdatesBandAction'), A('ExplorerTransferBandAction'), A('ExplorerCustomCommandsBandAction'), S,
        A('LockToolbarsAction'), A('SelectiveToolbarTextAction'), ICON_SIZE_MENU, S,
        A('CustomizeToolbarAction'),
      ]),
      A('SessionsTabsAction2'), A('StatusBarAction'), QUEUE_VIEW_MENU,
      A('RemoteTreeAction'), S,
      A('RemoteIconAction'), A('RemoteSmallIconAction'), A('RemoteListAction'),
      A('RemoteReportAction'), A('RemoteThumbnailAction'), S,
      SUB('mGoTo', [
        A('RemoteOpenDirAction'), S,
        A('RemoteParentDirAction'), A('RemoteRootDirAction'), A('RemoteHomeDirAction'), S,
        A('RemoteBackAction'), A('RemoteForwardAction'),
      ]),
      A('RemoteRefreshAction'),
      SUB('mSort', [
        A('RemoteSortAscendingAction2'), S,
        A('RemoteSortByNameAction2'), A('RemoteSortByExtAction2'), A('RemoteSortBySizeAction2'),
        A('RemoteSortByTypeAction2'), A('RemoteSortByChangedAction3'), A('RemoteSortByRightsAction2'),
        A('RemoteSortByOwnerAction2'), A('RemoteSortByGroupAction2'),
      ]),
      SUB('mColumns', [
        A('ShowHideRemoteNameColumnAction2'), A('ShowHideRemoteSizeColumnAction2'),
        A('ShowHideRemoteTypeColumnAction2'), A('ShowHideRemoteChangedColumnAction3'),
        A('ShowHideRemoteRightsColumnAction2'), A('ShowHideRemoteOwnerColumnAction2'),
        A('ShowHideRemoteGroupColumnAction2'), A('ShowHideRemoteLinkTargetColumnAction2'), S,
        A('AutoSizeRemoteColumnsAction'), A('ResetLayoutRemoteColumnsAction'),
      ]),
      A('RemoteFilterAction'),
      A('ShowHiddenFilesAction'), A('AutoReadDirectoryAfterOpAction'),
      SUB('sizeFormatPref', [
        A('FormatSizeBytesNoneAction'), A('FormatSizeBytesKilobytesAction'), A('FormatSizeBytesShortAction'),
      ]),
      A('FileColorsPreferencesAction'), S,
      A('PreferencesAction'),
    ],
  },
  { id: 'help', labelKey: 'mHelp', items: HELP_MENU },
];

/* ================================================================== */
/* tree -> menu items                                                  */
/* ================================================================== */

/**
 * Turn a declarative node into a contextmenu.js item, resolving the command's
 * live label, icon, shortcut, checked state and disabled state. A node that is
 * not visible in this context is dropped, exactly as WinSCP hides an action
 * whose Visible is false.
 */
export function buildMenuItems(nodes, over = {}) {
  const out = [];
  for (const node of nodes || []) {
    if (!node) continue;
    if (node === S || node.separator) { out.push(SEPARATOR); continue; }

    if (node.action) {
      const cmd = getCommand(node.action);
      if (!cmd) continue;
      const state = commandState(node.action, over);
      if (!state.visible) continue;
      const item = {
        label: actionLabel(node.action),
        // No glyph rather than a generic one: an icon in a menu is a hint, and
        // a wrong hint is worse than none.
        icon: cmd.hasIcon ? cmd.icon : null,
        shortcut: cmd.shortcut,
        disabled: !state.enabled,
        description: state.reason || cmd.hint || '',
        onSelect: () => runAction(node.action, over),
      };
      if (state.checked !== undefined) {
        item.checked = state.checked;
        item.radio = cmd.kind === 'radio';
      }
      // A node may declare its own children, or the command may supply them.
      const children = node.items ? buildMenuItems(node.items, over)
        : (cmd.submenu ? cmd.submenu(state.ctx) : null);
      if (children && children.length) item.submenu = children;
      out.push(item);
      continue;
    }

    if (node.items) {
      const children = buildMenuItems(node.items, over);
      if (!children.length) continue;
      out.push({
        label: node.label || t(node.labelKey || 'help'),
        icon: node.icon || null,
        submenu: children,
      });
    }
  }
  return out;
}

/* ================================================================== */
/* the menu bar                                                        */
/* ================================================================== */

const CSS = `
.menubar{display:flex;align-items:center;gap:calc(1px*var(--den,1));flex-wrap:wrap}
.menubar-btn{display:inline-flex;align-items:center;gap:calc(4px*var(--den,1));border:0;background:transparent;
  cursor:pointer;color:var(--md-sys-color-on-surface,var(--onsfc,#1D1B20));border-radius:var(--shape-sm,8px);
  min-height:calc(30px*var(--den,1));padding:0 calc(10px*var(--den,1));font:inherit;
  font-size:var(--type-label-lg,.875rem);white-space:nowrap}
.menubar-btn:hover{background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.06))}
.menubar-btn[aria-expanded="true"]{background:var(--md-sys-color-secondary-container,rgba(11,87,208,.14));
  color:var(--md-sys-color-on-secondary-container,var(--onsec,#0B57D0))}
`;

/**
 * createMenuBar({ interfaceMode(), ctxFor() }) -> { element, sync, destroy }
 *
 * One tab stop, arrow keys between the top-level menus, Alt+letter mnemonics
 * from WinSCP's own accelerators.
 */
export function createMenuBar(opts = {}) {
  ensureStyle('winscp-menus', CSS);
  const root = h('div', { class: 'menubar', role: 'menubar', 'aria-label': t('mFiles') });
  appearanceTarget(root, 'menu-bar', 'Menu bar');

  function menus() {
    const mode = typeof opts.interfaceMode === 'function' ? opts.interfaceMode() : readPref('interface', 'commander');
    return mode === 'explorer' ? EXPLORER_MENUS : COMMANDER_MENUS;
  }

  function over() { return (typeof opts.ctxFor === 'function' ? opts.ctxFor() : {}) || {}; }

  function sync() {
    while (root.firstChild) root.removeChild(root.firstChild);
    for (const menu of menus()) {
      const label = t(menu.labelKey);
      const btn = h('button', {
        type: 'button', class: 'menubar-btn', role: 'menuitem',
        'data-menu': menu.id, 'aria-label': label,
      }, h('span', {}, label));
      appearanceTarget(btn, `menu-${menu.id}`, `Menu: ${label}`);
      attachMenuButton(btn, () => buildMenuItems(menu.items, over()), {
        label, placement: 'bottom-start',
      });
      root.appendChild(btn);
    }
  }

  const roving = rovingFocus(root, '.menubar-btn', { orientation: 'horizontal' });
  const offs = [
    bus.on('i18n:changed', sync),
    bus.on('panel:interfaceChanged', sync),
  ];
  sync();

  return {
    element: root,
    sync,
    /** Open a top-level menu by id — used by the Alt-key handler. */
    open(id) {
      const btn = root.querySelector(`[data-menu="${id}"]`);
      if (btn) btn.click();
    },
    destroy() { offs.forEach((off) => off()); roving.dispose(); root.remove(); },
  };
}

/* ================================================================== */
/* the file context menu                                               */
/* ================================================================== */

/**
 * WinSCP's right-click menu over a file row. It uses the *Focused* variants,
 * because a right-click acts on the row under the cursor even when a different
 * set of rows is selected.
 */
export function fileContextItems(over = {}) {
  const side = over.side;
  const local = side === 'local';
  const nodes = [
    A(local ? 'LocalCopyFocusedAction' : 'RemoteCopyFocusedAction'),
    A(local ? 'LocalCopyFocusedQueueAction' : 'RemoteCopyFocusedQueueAction'),
    A(local ? 'LocalMoveFocusedAction' : 'RemoteMoveFocusedAction'),
    S,
    A('CurrentEditFocusedAction'),
    A('CurrentEditWithFocusedAction'),
    A('CurrentOpenAction'),
    S,
    A(local ? 'LocalLocalCopyFocusedAction' : 'RemoteCopyToFocusedAction'),
    A(local ? 'LocalLocalMoveFocusedAction' : 'RemoteMoveToFocusedAction'),
    A('CurrentDeleteFocusedAction'),
    A('CurrentRenameAction'),
    S,
    A('CurrentCopyToClipboardFocusedAction2'),
    A('PasteAction3'),
    S,
    ASUB('CustomCommandsFileAction', null),
    FILE_NAMES_MENU,
    S,
    A('CurrentAddEditLinkContextAction'),
    A('CalculateDirectorySizesAction'),
    A('CurrentSystemMenuFocusedAction'),
    S,
    A('CurrentPropertiesFocusedAction'),
  ];
  return buildMenuItems(nodes, over);
}

/** The menu for empty space in a panel: navigation and creation, not files. */
export function panelContextItems(over = {}) {
  const local = over.side === 'local';
  const nodes = [
    A(local ? 'LocalRefreshAction' : 'RemoteRefreshAction'),
    A(local ? 'LocalParentDirAction' : 'RemoteParentDirAction'),
    S,
    SUB('newBtn', [
      A(local ? 'LocalNewFileAction' : 'RemoteNewFileAction'),
      A(local ? 'LocalCreateDirAction3' : 'RemoteCreateDirAction3'),
      A(local ? 'LocalAddEditLinkAction3' : 'RemoteAddEditLinkAction3'),
    ]),
    A('PasteAction3'),
    S,
    SUB('mView', local
      ? [A('LocalReportAction'), A('LocalThumbnailAction')]
      : [A('RemoteIconAction'), A('RemoteSmallIconAction'), A('RemoteListAction'), A('RemoteReportAction'), A('RemoteThumbnailAction')]),
    SUB('mSort', local
      ? [A('LocalSortAscendingAction2'), S, A('LocalSortByNameAction2'), A('LocalSortByExtAction2'),
        A('LocalSortBySizeAction2'), A('LocalSortByTypeAction2'), A('LocalSortByChangedAction3'), A('LocalSortByAttrAction2')]
      : [A('RemoteSortAscendingAction2'), S, A('RemoteSortByNameAction2'), A('RemoteSortByExtAction2'),
        A('RemoteSortBySizeAction2'), A('RemoteSortByTypeAction2'), A('RemoteSortByChangedAction3'),
        A('RemoteSortByRightsAction2'), A('RemoteSortByOwnerAction2'), A('RemoteSortByGroupAction2')]),
    S,
    A('ShowHiddenFilesAction'),
    A(local ? 'LocalFilterAction' : 'RemoteFilterAction'),
    A('FileColorsPreferencesAction'),
    S,
    A(local ? 'LocalPathToClipboardAction2' : 'RemotePathToClipboardAction2'),
    A(local ? 'LocalAddBookmarkAction2' : 'RemoteAddBookmarkAction2'),
  ];
  return buildMenuItems(nodes, over);
}

/* ================================================================== */
/* Alt mnemonics                                                       */
/* ================================================================== */

/** WinSCP's own menu accelerators: Alt+L opens Local, Alt+R opens Remote, … */
const MNEMONICS = {
  commander: { l: 'local', m: 'mark', f: 'files', c: 'commands', t: 'tabs', o: 'options', r: 'remote', h: 'help' },
  explorer: { f: 'files', c: 'commands', m: 'mark', t: 'tabs', v: 'view', h: 'help' },
};

/** Wire Alt+letter to the menu bar. Returns a disposer. */
export function installMenuMnemonics(bar, interfaceMode) {
  const onKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const mode = typeof interfaceMode === 'function' ? interfaceMode() : 'commander';
    const id = MNEMONICS[mode] && MNEMONICS[mode][String(e.key).toLowerCase()];
    if (!id) return;
    e.preventDefault();
    bar.open(id);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/** Open a menu tree at a point — used by the panel's own right-click. */
export function openMenuTree(nodes, over, at) {
  const items = buildMenuItems(nodes, over);
  if (!items.length) return null;
  return openMenu({ items, x: at.x, y: at.y, label: at.label || t('menuSearchPh') });
}

export { icon as _icon };
