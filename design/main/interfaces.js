// interfaces.js — the two interface modes: Commander and Explorer.
//
// Ported from forms/ScpCommander.cpp (TScpCommanderForm) and
// forms/ScpExplorer.cpp (TScpExplorerForm), both of which derive from
// TCustomScpExplorerForm. Everything shared lives in the base class and is
// already ported elsewhere (panels.js, commands.js, menus.js, toolbars.js);
// this module carries only what the two SUBCLASSES do differently, which is a
// great deal more than a different arrangement of the same widgets.
//
// WHY THIS IS A MAIN-PROCESS MODULE AND NOT A RENDERER ONE
// -------------------------------------------------------
// Almost none of it is drawing. It is: which actions are legal in which mode,
// which keyboard shortcut a given action carries in which mode, where a
// download goes when the user did not say, what "synchronize browsing" does to
// the opposite panel and what it REFUSES to do, how the splitter fraction
// survives a maximise/restore, and what a workspace is. All of that is pure
// decision logic with real edge cases, and it is testable headlessly. The
// renderer consumes it; nothing here touches a DOM node.
//
// THE ONE THING TO UNDERSTAND FIRST: osOther
// ------------------------------------------
// WinSCP has three sides — osLocal, osRemote, osCurrent — and then declares
// `const TOperationSide osOther = osRemote` (CustomScpExplorer.h:66). In
// Commander the "remote" side is the OPPOSITE PANEL, which is only actually
// remote when a session is connected; with no session it is a second LOCAL
// panel (local-local browsing). Every place below that says `remote` means
// "the opposite panel", and `isSideLocalBrowser()` is the question that decides
// whether that panel talks to a server or to the local disk.
'use strict';

const C = require('./common');
const RF = require('./remotefiles');
const SD = require('./sessiondata');
const W = require('./winconfig');

// ---------------------------------------------------------------------------
// Modes and sides
// ---------------------------------------------------------------------------

/** TInterface (GUIConfiguration.h:10). */
const COMMANDER = 'commander';
const EXPLORER = 'explorer';
const INTERFACES = [COMMANDER, EXPLORER];

/** TOperationSide (CopyParam.h:11) plus the osOther alias. */
const LOCAL = 'local';
const REMOTE = 'remote';
const CURRENT = 'current';
/** osOther === osRemote. It is the opposite panel, not necessarily a server. */
const OTHER = REMOTE;

function isInterface(mode) { return mode === COMMANDER || mode === EXPLORER; }

/** Fail loudly rather than silently treating an unknown mode as Commander. */
function checkInterface(mode) {
  if (!isInterface(mode)) throw new TypeError(`unknown interface mode: ${String(mode)}`);
  return mode;
}

/** TCustomScpExplorerForm::GetSide — osCurrent resolves to the focused panel. */
function getSide(side, currentSide) {
  if (side === CURRENT || side === undefined || side === null) {
    return currentSide === REMOTE ? REMOTE : LOCAL;
  }
  if (side !== LOCAL && side !== REMOTE) throw new TypeError(`unknown side: ${String(side)}`);
  return side;
}

/** TCustomScpExplorerForm::GetOtherSide / ReverseOperationSide. */
function getOtherSide(side, currentSide) {
  return getSide(side, currentSide) === LOCAL ? REMOTE : LOCAL;
}

// ---------------------------------------------------------------------------
// Which commands exist in which mode
// ---------------------------------------------------------------------------

/**
 * TActionFlag (CustomScpExplorer.h:58). Every action in NonVisual.dfm carries
 * this bitmask in its Tag, and the two forms use it as a filter: Explorer
 * refuses anything without afExplorer, Commander anything without afCommander.
 * That single test is why "which commands exist" differs between the modes —
 * there is no second list anywhere.
 */
const AF_LOCAL = 1;
const AF_REMOTE = 2;
const AF_EXPLORER = 4;
const AF_COMMANDER = 8;

function actionFlags(tag) {
  const t = Number(tag) | 0;
  return {
    local: (t & AF_LOCAL) !== 0,
    remote: (t & AF_REMOTE) !== 0,
    explorer: (t & AF_EXPLORER) !== 0,
    commander: (t & AF_COMMANDER) !== 0,
  };
}

/** TActionAllowed (CustomScpExplorer.h:57). */
const AA_SHORTCUT = 'shortcut';
const AA_UPDATE = 'update';
const AA_EXECUTE = 'execute';

/**
 * Explorer hides this one during its update pass (ScpExplorer.cpp:184). Its tag
 * is 11 (local|remote|commander), so the flag test would already exclude it —
 * the explicit Visible=false exists so the menu entry disappears rather than
 * merely greying out. Both effects are reported here.
 */
const EXPLORER_HIDDEN_ACTIONS = ['FileListToCommandLineAction'];

/**
 * TCustomScpExplorerForm::AllowedAction plus each subclass's override.
 *
 * `action` needs only `{ name, tag }`. `state` carries the runtime facts the
 * base class consults: `busy` (NonVisualDataModule->Busy) and, for a shortcut,
 * whether the action is currently enabled — WinSCP calls Action->Update()
 * first precisely so a disabled local<->remote action does not swallow F5 in
 * local-local mode.
 *
 * Returns { allowed, visible, reason } so a caller can tell "greyed out"
 * from "does not exist in this mode" — the difference matters to the user.
 */
function allowedAction(mode, action, allowed, state) {
  checkInterface(mode);
  const s = state || {};
  const flags = actionFlags(action && action.tag);
  const name = action && action.name;
  const phase = allowed || AA_EXECUTE;

  let visible = true;
  let reason = '';
  if (mode === EXPLORER && EXPLORER_HIDDEN_ACTIONS.includes(name)) {
    visible = false;
    reason = 'hidden in the Explorer interface';
  }

  // The base class: an update pass is always allowed (it is what computes
  // Enabled in the first place); anything else is refused while busy.
  let base;
  if (phase === AA_UPDATE) {
    base = true;
  } else {
    base = !s.busy;
    if (base && phase === AA_SHORTCUT) base = s.actionEnabled !== false;
  }
  if (!base) {
    return { allowed: false, visible, reason: reason || (s.busy ? 'the application is busy' : 'the action is disabled') };
  }

  if (mode === EXPLORER) {
    if (!flags.explorer) return { allowed: false, visible: false, reason: 'not available in the Explorer interface' };
    // A shortcut only fires for an action designed for the remote panel:
    // Explorer has no local panel to aim a local action at.
    if (phase === AA_SHORTCUT && !flags.remote) {
      return { allowed: false, visible, reason: 'the shortcut applies to the remote panel only' };
    }
    return { allowed: visible, visible, reason };
  }

  if (!flags.commander) return { allowed: false, visible: false, reason: 'not available in the Commander interface' };
  if (phase === AA_SHORTCUT) {
    const side = getSide(CURRENT, s.currentSide);
    const ok = (flags.local && side === LOCAL) || (flags.remote && side === REMOTE);
    if (!ok) return { allowed: false, visible, reason: `the shortcut does not apply to the ${side} panel` };
  }
  return { allowed: true, visible, reason };
}

/**
 * Partition a NonVisual action list by mode. `actions` is the extracted table
 * (design/renderer/actions.js), of which only `name` and `tag` are read.
 */
function commandsFor(mode, actions) {
  checkInterface(mode);
  const wanted = mode === EXPLORER ? 'explorer' : 'commander';
  const out = [];
  for (const action of actions || []) {
    if (actionFlags(action.tag)[wanted]) out.push(action);
  }
  return out;
}

/** The actions one mode has and the other does not, both ways. */
function commandDifference(actions) {
  const commanderOnly = [];
  const explorerOnly = [];
  const both = [];
  const neither = [];
  for (const action of actions || []) {
    const f = actionFlags(action.tag);
    if (f.commander && f.explorer) both.push(action.name);
    else if (f.commander) commanderOnly.push(action.name);
    else if (f.explorer) explorerOnly.push(action.name);
    else neither.push(action.name);
  }
  return { commanderOnly, explorerOnly, both, neither };
}

// ---------------------------------------------------------------------------
// Keyboard shortcut sets
// ---------------------------------------------------------------------------
//
// TNonVisualDataModule::ExplorerShortcuts and ::CommanderShortcuts
// (NonVisual.cpp:877 and :914) rebind the SAME actions to different keys when
// the interface changes, then CloneShortcuts (NonVisual.cpp:982) copies each
// primary onto every alias of it. The sets are genuinely different keyboards:
// Explorer is Windows-Explorer-like (Ctrl+D new folder, Del delete), Commander
// is Norton-like (F7 new folder, F8 delete) unless the user asks for the
// Explorer keys inside Commander.

/** Set by ExplorerShortcuts. Anything absent keeps its NonVisual.dfm value. */
function explorerShortcutSet() {
  return {
    primary: {
      // Directory
      CurrentCreateDirAction: 'Ctrl+D',
      // File operation
      CurrentRenameAction: 'F2',
      CurrentEditAction: 'Ctrl+E',
      CurrentAddEditLinkAction: 'Ctrl+Alt+L',
      CurrentEditInternalAction: '',
      CurrentEditInternalFocusedAction: '',
      // Focused operation
      RemoteCopyAction: 'Ctrl+T',
      RemoteMoveAction: 'Ctrl+M',
      CurrentDeleteFocusedAction: 'Del',
      CurrentPropertiesFocusedAction: 'Alt+Enter',
      RemoteMoveToFocusedAction: 'Ctrl+Alt+M',
      // Remote directory
      RemoteOpenDirAction: 'Ctrl+O',
      RemoteRefreshAction: 'F5',
      RemoteHomeDirAction: 'Ctrl+H',
      RemotePathToClipboardAction2: 'Ctrl+Shift+P',
      // Selected operation
      CurrentDeleteAlternativeAction: 'Shift+Del',
      RemoteMoveToAction: 'Ctrl+Alt+M',
      // Commands
      NewFileAction: 'Ctrl+Shift+E',
      RemoteFindFilesAction2: 'F3',
      NewTabAction: 'Ctrl+N',
      CloseApplicationAction2: 'Alt+F4',
    },
    secondary: {},
  };
}

/**
 * Set by CommanderShortcuts. `explorerKeyboardShortcuts` is the Commander
 * preference "use Explorer-like keyboard shortcuts"; it moves five bindings,
 * and notably moves Ctrl+F4 from sort-by-extension to close-tab, which is the
 * only place in the whole table where turning the option on GIVES a key to a
 * different action rather than merely changing one.
 */
function commanderShortcutSet(options) {
  const explorerKeys = !!(options && options.explorerKeyboardShortcuts);
  const ctrlF4 = 'Ctrl+F4';
  const sortByExt = explorerKeys ? '' : ctrlF4;
  return {
    primary: {
      // Directory
      CurrentCreateDirAction: 'F7',
      // File operation
      CurrentRenameAction: 'F2',
      CurrentEditAction: 'F4',
      CurrentAddEditLinkAction: 'Alt+F6',
      CurrentEditInternalAction: 'Ctrl+Alt+F4',
      CurrentEditInternalFocusedAction: 'Ctrl+Alt+F4',
      // Focused operation
      RemoteCopyAction: explorerKeys ? 'Ctrl+K' : 'F5',
      RemoteMoveAction: 'F6',
      CurrentDeleteFocusedAction: 'F8',
      CurrentPropertiesFocusedAction: 'F9',
      RemoteMoveToFocusedAction: 'Shift+F6',
      RemoteCopyToFocusedAction: 'Shift+F5',
      // Remote directory
      RemoteOpenDirAction: 'Ctrl+O',
      RemoteRefreshAction: explorerKeys ? 'F5' : 'Ctrl+R',
      RemoteHomeDirAction: 'Ctrl+H',
      RemotePathToClipboardAction2: 'Ctrl+]',
      // Local directory
      LocalPathToClipboardAction2: 'Ctrl+[',
      // Selected operation
      CurrentDeleteAlternativeAction: 'Shift+F8',
      RemoteMoveToAction: 'Shift+F6',
      RemoteCopyToAction: 'Shift+F5',
      // Selection
      SelectOneAction: 'Ins',
      // Commands
      NewFileAction: 'Shift+F4',
      RemoteFindFilesAction2: explorerKeys ? 'F3' : 'Alt+F7',
      NewTabAction: 'Ctrl+T',
      CloseApplicationAction2: 'F10',
      // Sort — the three move together, and give up Ctrl+F4 to CloseTab when
      // the Explorer keyboard is chosen.
      LocalSortByExtAction2: sortByExt,
      RemoteSortByExtAction2: sortByExt,
      CurrentSortByExtAction: sortByExt,
    },
    secondary: {
      CurrentDeleteAction: ['Del'],
      CurrentDeleteAlternativeAction: ['Shift+Del'],
      // Legacy binding kept so muscle memory from old builds still works.
      NewFileAction: ['Ctrl+Shift+F4'],
      CloseTabAction: explorerKeys ? [ctrlF4] : [],
    },
  };
}

/**
 * TNonVisualDataModule::CloneShortcuts — every alias action mirrors its
 * primary. Written as pairs rather than assignments so the direction is
 * obvious: `[alias, source]`.
 */
const SHORTCUT_CLONES = [
  ['NewDirAction', 'CurrentCreateDirAction'],
  ['CurrentAddEditLinkContextAction', 'CurrentAddEditLinkAction'],
  ['LocalAddEditLinkAction3', 'CurrentAddEditLinkAction'],
  ['RemoteAddEditLinkAction3', 'CurrentAddEditLinkAction'],
  ['RemoteNewFileAction', 'NewFileAction'],
  ['LocalNewFileAction', 'NewFileAction'],
  ['LocalOpenDirAction', 'RemoteOpenDirAction'],
  ['LocalRefreshAction', 'RemoteRefreshAction'],
  ['LocalHomeDirAction', 'RemoteHomeDirAction'],
  ['CurrentDeleteAction', 'CurrentDeleteFocusedAction'],
  ['CurrentPropertiesAction', 'CurrentPropertiesFocusedAction'],
  ['LocalCopyAction', 'RemoteCopyAction'],
  ['LocalLocalCopyAction', 'RemoteCopyAction'],
  ['LocalOtherCopyAction', 'RemoteCopyAction'],
  ['LocalRenameAction2', 'CurrentRenameAction'],
  ['LocalEditAction2', 'CurrentEditAction'],
  ['LocalMoveAction', 'RemoteMoveAction'],
  ['LocalLocalMoveAction', 'LocalMoveAction'],
  ['LocalOtherMoveAction', 'LocalMoveAction'],
  ['LocalCreateDirAction3', 'CurrentCreateDirAction'],
  ['LocalDeleteAction2', 'CurrentDeleteAction'],
  ['LocalPropertiesAction2', 'CurrentPropertiesAction'],
  ['LocalCopyFocusedAction', 'LocalCopyAction'],
  ['LocalMoveFocusedAction', 'LocalMoveAction'],
  ['LocalLocalCopyFocusedAction', 'LocalCopyAction'],
  ['LocalLocalMoveFocusedAction', 'LocalMoveAction'],
  ['RemoteRenameAction2', 'CurrentRenameAction'],
  ['RemoteEditAction2', 'CurrentEditAction'],
  ['RemoteCreateDirAction3', 'CurrentCreateDirAction'],
  ['RemoteDeleteAction2', 'CurrentDeleteAction'],
  ['RemotePropertiesAction2', 'CurrentPropertiesAction'],
  ['RemoteCopyFocusedAction', 'RemoteCopyAction'],
  ['RemoteMoveFocusedAction', 'RemoteMoveAction'],
  ['LocalSelectAction2', 'SelectAction'],
  ['LocalUnselectAction2', 'UnselectAction'],
  ['LocalSelectAllAction2', 'SelectAllAction'],
  ['RemoteSelectAction2', 'SelectAction'],
  ['RemoteUnselectAction2', 'UnselectAction'],
  ['RemoteSelectAllAction2', 'SelectAllAction'],
];

/**
 * The complete shortcut table for a mode.
 *
 * `defaults` is the shortcut each action carries in NonVisual.dfm (the actions
 * the interface never touches keep theirs — SelectAction, CloseTabAction's
 * primary, and the whole View/Session category). The clone pass runs LAST,
 * exactly as in the C++, so an alias always ends up on the value its primary
 * has AFTER the interface rebound it.
 */
function shortcutsFor(mode, options) {
  checkInterface(mode);
  const opts = options || {};
  const set = mode === EXPLORER ? explorerShortcutSet() : commanderShortcutSet(opts);
  const primary = Object.assign({}, opts.defaults || {}, set.primary);
  const secondary = {};
  for (const [name, list] of Object.entries((opts.defaultsSecondary) || {})) secondary[name] = list.slice();
  for (const [name, list] of Object.entries(set.secondary)) secondary[name] = list.slice();

  for (const [alias, source] of SHORTCUT_CLONES) {
    if (Object.prototype.hasOwnProperty.call(primary, source)) primary[alias] = primary[source];
  }

  // Swapped panels swap the two "go to the other panel's path box" keys, so
  // Alt+F1 always means "the left panel" whichever panel that is.
  if (mode === COMMANDER && opts.swappedPanels) {
    const l = primary.LocalChangePathAction2;
    primary.LocalChangePathAction2 = primary.RemoteChangePathAction2;
    primary.RemoteChangePathAction2 = l;
  }

  return {
    primary,
    secondary,
    // ExplorerShortcuts ends by collapsing the New Tab split button; Commander
    // leaves it a split button because it can open a local tab too.
    newTabDropdownCombo: mode === COMMANDER,
  };
}

/** Every combination bound in a mode, and the ones bound twice. */
function shortcutConflicts(table) {
  const seen = new Map();
  for (const [name, key] of Object.entries(table.primary || {})) {
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(name);
  }
  for (const [name, list] of Object.entries(table.secondary || {})) {
    for (const key of list || []) {
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(name);
    }
  }
  const conflicts = [];
  for (const [key, names] of seen) if (names.length > 1) conflicts.push({ key, actions: names });
  return conflicts;
}

// ---------------------------------------------------------------------------
// Panel arrangement
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::Panel / ::IsLocalBrowserMode / ::UpdateControls, and the
 * Explorer's plain absence of a local panel.
 *
 * The two surprising rules, both real:
 *
 *  1. Right-to-left layout INVERTS SwappedPanels (Panel(), ScpCommander.cpp:921)
 *     so that "left" keeps meaning the same panel visually.
 *  2. The opposite panel is a SECOND LOCAL PANEL whenever no session is active
 *     (UpdateControls, ScpCommander.cpp:1047) — Commander is never a one-panel
 *     window, it becomes a local file manager instead.
 */
function panelArrangement(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) {
    return {
      mode: EXPLORER,
      panels: [REMOTE],
      hasLocalPanel: false,
      localBrowserMode: false,
      leftPanel: null,
      rightPanel: null,
      swapped: false,
      // fcRemoteTree — the one tree Explorer has, on the left of the file list.
      treePlacement: 'left',
      menuCaptions: { local: null, remote: '&Remote' },
    };
  }

  const hasSession = !!s.hasSession;
  let swapped = !!s.swappedPanels;
  if (s.rightToLeft) swapped = !swapped;
  const leftPanel = swapped ? REMOTE : LOCAL;
  const rightPanel = swapped ? LOCAL : REMOTE;
  const localOnLeft = leftPanel === LOCAL;

  return {
    mode: COMMANDER,
    panels: [LOCAL, REMOTE],
    hasLocalPanel: true,
    // OtherLocalDirView->Visible = !HasTerminal.
    localBrowserMode: !hasSession,
    leftPanel,
    rightPanel,
    swapped,
    treePlacement: s.treeOnLeft ? 'left' : 'top',
    // UpdateControls (ScpCommander.cpp:1139): with a session the menus are
    // named Local/Remote; with none they are named by position, because both
    // panels are local and "Remote" would be a lie.
    menuCaptions: hasSession
      ? { local: '&Local', remote: '&Remote' }
      : { local: localOnLeft ? '&Left' : '&Right', remote: localOnLeft ? '&Right' : '&Left' },
  };
}

/** TScpCommanderForm::IsSideLocalBrowser — is this panel showing local disk? */
function isSideLocalBrowser(mode, side, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) return false;              // Explorer has no local panel at all
  if (getSide(side, s.currentSide) === LOCAL) return true;
  return !s.hasSession;                              // the opposite panel is local while disconnected
}

/** TScpCommanderForm::GetHasDirView — Explorer has no osLocal view. */
function hasDirView(mode, side, state) {
  checkInterface(mode);
  if (mode === COMMANDER) return true;
  return getSide(side, (state || {}).currentSide) === REMOTE;
}

/**
 * TScpCommanderForm::DirViewEnabled. In Commander a local panel is always
 * usable; the opposite panel is usable when it is local, or when a session is
 * available. Explorer's single panel needs a session, full stop.
 */
function dirViewEnabled(mode, side, state) {
  checkInterface(mode);
  const s = state || {};
  if (isSideLocalBrowser(mode, side, s)) return true;
  return !!s.hasAvailableSession;
}

/** TScpCommanderForm::SupportedSession / TScpExplorerForm::SupportedSession. */
function supportedSession(mode, data) {
  checkInterface(mode);
  if (mode === COMMANDER) return true;
  // Explorer cannot show two local directories, so a local-local site is not
  // openable there. Opening a whole workspace of them yields no session at all,
  // which DoOpenFolderOrWorkspace explicitly tolerates.
  return !SD.isLocalBrowser(data || {});
}

/**
 * TScpCommanderForm::GetReplacementForLastSession. Closing the last tab in
 * Commander does not close the window; it leaves a local-local browser behind.
 * Explorer has nothing to replace it with and returns none.
 */
function replacementForLastSession(mode) {
  checkInterface(mode);
  return mode === COMMANDER ? { kind: 'localBrowser' } : null;
}

/**
 * TScpCommanderForm::NewTab. Ctrl reverses the configured default, so one
 * button opens both kinds of tab; Explorer has only remote tabs.
 */
function newTabSide(mode, options) {
  checkInterface(mode);
  const o = options || {};
  if (mode === EXPLORER) return REMOTE;
  if (o.side === LOCAL || o.side === REMOTE) return o.side;
  let remote = !!o.defaultToNewRemoteTab;
  if (o.ctrlPressed && o.allowReverse !== false) remote = !remote;
  return remote ? REMOTE : LOCAL;
}

// ---------------------------------------------------------------------------
// The splitter and the panel widths
// ---------------------------------------------------------------------------

/**
 * The Commander splitter, ported from SetLeftPanelWidth / GetLeftPanelWidth /
 * SplitterMoved / SplitterCanResize / SplitterDblClick / SysResizing / Resize.
 *
 * WinSCP stores the split as a FRACTION, not a pixel width, and keeps a second
 * copy of it (FLastLeftPanelWidth) that only a deliberate drag updates. That
 * second copy is what makes the layout survive a window resize: Resize() writes
 * FLastLeftPanelWidth back over whatever rounding the layout pass produced, so
 * repeated resizes cannot walk the divider across the window.
 *
 * Maximise/restore is handled separately (FNormalPanelsWidth): the width the
 * panels had before maximising is remembered so restoring puts the divider back
 * at the same fraction OF THE OLD WIDTH rather than of the maximised width.
 */
class PanelSplitter {
  constructor(options) {
    const o = options || {};
    this.leftPanelWidth = typeof o.leftPanelWidth === 'number' ? o.leftPanelWidth : 0.5;
    this.lastLeftPanelWidth = this.leftPanelWidth;
    this.normalPanelsWidth = -1;
    this.splitterWidth = typeof o.splitterWidth === 'number' ? o.splitterWidth : 4;
    this.minPanelWidth = typeof o.minPanelWidth === 'number' ? o.minPanelWidth : 100;
  }

  /** SetLeftPanelWidth: returns the pixel width the left panel should take. */
  setLeftPanelWidth(value, totalWidth) {
    this.leftPanelWidth = value;
    return Math.trunc(value * totalWidth);
  }

  /** SplitterMoved: a deliberate drag, so the remembered fraction moves too. */
  splitterMoved(leftWidthPx, totalWidth) {
    if (!totalWidth) return this.leftPanelWidth;
    this.leftPanelWidth = leftWidthPx / totalWidth;
    this.lastLeftPanelWidth = this.leftPanelWidth;
    return this.leftPanelWidth;
  }

  /**
   * SplitterCanResize. Dragging past the other panel's minimum width would, in
   * the VCL, silently WIDEN THE WINDOW instead of stopping. WinSCP clamps
   * instead, and so do we — the divider stops, the window does not grow.
   */
  canResize(newSize, clientWidth, otherMinWidth) {
    const min = typeof otherMinWidth === 'number' ? otherMinWidth : this.minPanelWidth;
    if (clientWidth - newSize - this.splitterWidth < min) {
      return clientWidth - min - this.splitterWidth;
    }
    return newSize;
  }

  /** SplitterDblClick: an even split, and it is remembered as deliberate. */
  splitterDblClick() {
    this.leftPanelWidth = 0.5;
    this.lastLeftPanelWidth = 0.5;
    return 0.5;
  }

  /**
   * Resize(): re-apply the last deliberate fraction. Returns the pixel width.
   */
  resize(totalWidth) {
    return this.setLeftPanelWidth(this.lastLeftPanelWidth, totalWidth);
  }

  /**
   * SysResizing. `cmd` is 'maximize' | 'restore' | 'default'; `maximized` is
   * the window state BEFORE the command, matching WindowState in the C++.
   * Returns the left panel's pixel width when one must be applied, else null.
   */
  sysResizing(cmd, state) {
    const s = state || {};
    if (cmd === 'maximize' || (cmd === 'default' && !s.maximized)) {
      this.normalPanelsWidth = s.totalWidth;
      return null;
    }
    if (cmd === 'restore' || (cmd === 'default' && s.maximized)) {
      if (this.normalPanelsWidth >= 0) {
        const width = Math.trunc(this.leftPanelWidth * this.normalPanelsWidth);
        this.normalPanelsWidth = -1;
        return width;
      }
    }
    return null;
  }
}

/**
 * TScpCommanderForm::PanelSplitterDblClick — double-clicking a panel's tree
 * splitter does NOT collapse the tree (that is the Explorer behaviour, below).
 * It makes the two trees the same size, and if the other panel has no tree
 * showing it SHOWS it at this one's size. `which` is 'local' or 'remote'.
 */
function panelTreeSplitterDblClick(which, state) {
  const s = state || {};
  const dim = s.treeOnLeft ? 'width' : 'height';
  const self = which === LOCAL ? s.local : s.remote;
  const other = which === LOCAL ? s.remote : s.local;
  if (!self) throw new TypeError(`no ${which} tree state given`);
  if (other && other.visible) {
    return { target: which === LOCAL ? LOCAL : REMOTE, dimension: dim, value: other[dim], show: false };
  }
  return {
    target: which === LOCAL ? REMOTE : LOCAL,
    dimension: dim,
    value: self[dim],
    show: true,
  };
}

/**
 * TScpExplorerForm::RemotePanelSplitterDblClick — Explorer's tree splitter
 * hides the tree instead. Different gesture, same double click.
 */
function explorerTreeSplitterDblClick() {
  return { component: 'fcRemoteTree', visible: false };
}

// ---------------------------------------------------------------------------
// Components and toolbar bands
// ---------------------------------------------------------------------------

/**
 * The fc* component ids (NonVisual.h:22-71) and what each mode maps them to.
 * `null` means the mode has no such component — asking for its visibility
 * returns false (GetComponentVisible) rather than throwing.
 */
const SHARED_COMPONENTS = {
  fcRemotePopup: 'RemoteFilePopup',
  fcQueueView: 'QueuePanel',
  fcQueueToolbar: 'QueueDock',
  fcRemoteTree: 'RemoteDrivePanel',
  fcSessionsTabs: 'SessionsPageControl',
  fcQueueFileList: 'QueueFileList',
};

const COMMANDER_COMPONENTS = Object.assign({}, SHARED_COMPONENTS, {
  fcToolBar2: 'Toolbar2Toolbar',
  fcStatusBar: 'StatusBar',
  fcLocalStatusBar: 'LocalStatusBar',
  fcRemoteStatusBar: 'RemoteStatusBar',
  fcCommandLinePanel: 'CommandLineToolbar',
  fcLocalTree: 'LocalDriveView',
  fcSessionToolbar: 'SessionToolbar2',
  fcCustomCommandsBand: 'CustomCommandsToolbar',
  fcColorMenu: 'ColorMenuItem',
  fcTransferDropDown: 'TransferDropDown',
  fcTransferList: 'TransferList',
  fcTransferLabel: 'TransferLabel',
  fcLocalPopup: 'LocalFilePopup',
  fcRemotePathComboBox: 'RemotePathComboBox',
  fcMenu: 'MenuToolbar',

  fcCommanderMenuBand: 'MenuToolbar',
  fcCommanderSessionBand: 'SessionToolbar2',
  fcCommanderPreferencesBand: 'PreferencesToolbar',
  fcCommanderSortBand: 'SortToolbar',
  fcCommanderCommandsBand: 'CommandsToolbar',
  fcCommanderUpdatesBand: 'UpdatesToolbar',
  fcCommanderTransferBand: 'TransferToolbar',
  fcCommanderCustomCommandsBand: 'CustomCommandsToolbar',
  fcCommanderLocalHistoryBand: 'LocalHistoryToolbar',
  fcCommanderLocalNavigationBand: 'LocalNavigationToolbar',
  fcCommanderLocalFileBand: 'LocalFileToolbar',
  fcCommanderLocalSelectionBand: 'LocalSelectionToolbar',
  fcCommanderRemoteHistoryBand: 'RemoteHistoryToolbar',
  fcCommanderRemoteNavigationBand: 'RemoteNavigationToolbar',
  fcCommanderRemoteFileBand: 'RemoteFileToolbar',
  fcCommanderRemoteSelectionBand: 'RemoteSelectionToolbar',
});

const EXPLORER_COMPONENTS = Object.assign({}, SHARED_COMPONENTS, {
  // Explorer has ONE status bar and it does double duty: the session status
  // bar and the file status bar are the same control (CustomScpExplorer.cpp
  // :5875 maps fcStatusBar to RemoteStatusBar).
  fcStatusBar: 'RemoteStatusBar',
  fcSessionToolbar: 'SessionToolbar2',
  fcCustomCommandsBand: 'CustomCommandsToolbar',
  fcColorMenu: 'ColorMenuItem',
  fcTransferDropDown: 'TransferDropDown',
  fcTransferList: 'TransferList',
  fcTransferLabel: 'TransferLabel',
  fcRemotePathComboBox: 'UnixPathComboBox',
  fcMenu: 'MenuToolbar',

  fcExplorerMenuBand: 'MenuToolbar',
  fcExplorerAddressBand: 'AddressToolbar',
  fcExplorerToolbarBand: 'ButtonsToolbar',
  fcExplorerSelectionBand: 'SelectionToolbar',
  fcExplorerSessionBand: 'SessionToolbar2',
  fcExplorerPreferencesBand: 'PreferencesToolbar',
  fcExplorerSortBand: 'SortToolbar',
  fcExplorerUpdatesBand: 'UpdatesToolbar',
  fcExplorerTransferBand: 'TransferToolbar',
  fcExplorerCustomCommandsBand: 'CustomCommandsToolbar',
});

function componentsFor(mode) {
  checkInterface(mode);
  return mode === EXPLORER ? EXPLORER_COMPONENTS : COMMANDER_COMPONENTS;
}

/** TCustomScpExplorerForm::GetComponent — null where the mode has none. */
function componentOf(mode, component) {
  const map = componentsFor(mode);
  return Object.prototype.hasOwnProperty.call(map, component) ? map[component] : null;
}

/**
 * TCustomScpExplorerForm::IsComponentPossible. The updates band is the only
 * conditional one: a Store build must not offer its own updater.
 */
function isComponentPossible(mode, component, state) {
  if (componentOf(mode, component) === null) return false;
  if (component === 'fcExplorerUpdatesBand' || component === 'fcCommanderUpdatesBand') {
    return !((state || {}).uwp);
  }
  return true;
}

/**
 * The toolbar bands each mode owns, in the order WinSCP lists them in its
 * default layout string, with the captions from the two .dfm files. `dock` is
 * where the band lives; Commander is the only mode with per-panel docks.
 */
const COMMANDER_BANDS = [
  { key: 'Queue', caption: 'Queue', dock: '', component: 'QueueToolbar' },
  { key: 'Menu', caption: 'Menu', dock: 'TopDock', component: 'MenuToolbar' },
  { key: 'Preferences', caption: 'Preferences', dock: 'TopDock', component: 'PreferencesToolbar' },
  { key: 'Session', caption: 'Sessions and Tabs', dock: 'TopDock', component: 'SessionToolbar2' },
  { key: 'Sort', caption: 'Sort', dock: 'TopDock', component: 'SortToolbar' },
  { key: 'Commands', caption: 'Commands', dock: 'TopDock', component: 'CommandsToolbar' },
  { key: 'Updates', caption: 'Updates', dock: 'TopDock', component: 'UpdatesToolbar' },
  { key: 'Transfer', caption: 'Transfer Settings', dock: 'TopDock', component: 'TransferToolbar' },
  { key: 'CustomCommands', caption: 'Custom Commands', dock: 'TopDock', component: 'CustomCommandsToolbar' },
  { key: 'RemoteHistory', caption: 'Remote History', dock: 'RemoteTopDock', component: 'RemoteHistoryToolbar' },
  { key: 'RemoteNavigation', caption: 'Remote Navigation', dock: 'RemoteTopDock', component: 'RemoteNavigationToolbar' },
  { key: 'RemotePath', caption: 'Remote Path', dock: 'RemoteTopDock', component: 'RemotePathToolbar' },
  { key: 'RemoteFile', caption: 'Remote Files', dock: 'RemoteTopDock', component: 'RemoteFileToolbar' },
  { key: 'RemoteSelection', caption: 'Remote Selection', dock: 'RemoteTopDock', component: 'RemoteSelectionToolbar' },
  { key: 'LocalHistory', caption: 'Local History', dock: 'LocalTopDock', component: 'LocalHistoryToolbar' },
  { key: 'LocalNavigation', caption: 'Local Navigation', dock: 'LocalTopDock', component: 'LocalNavigationToolbar' },
  { key: 'LocalPath', caption: 'Local Path', dock: 'LocalTopDock', component: 'LocalPathToolbar' },
  { key: 'LocalFile', caption: 'Local Files', dock: 'LocalTopDock', component: 'LocalFileToolbar' },
  { key: 'LocalSelection', caption: 'Local Selection', dock: 'LocalTopDock', component: 'LocalSelectionToolbar' },
  { key: 'Toolbar2', caption: 'Hot Keys', dock: 'BottomDock', component: 'Toolbar2Toolbar' },
  { key: 'CommandLine', caption: 'Command Line', dock: 'BottomDock', component: 'CommandLineToolbar' },
];

const EXPLORER_BANDS = [
  { key: 'Queue', caption: 'Queue', dock: '', component: 'QueueToolbar' },
  { key: 'Menu', caption: 'Menu', dock: 'TopDock', component: 'MenuToolbar' },
  { key: 'Buttons', caption: 'Commands', dock: 'TopDock', component: 'ButtonsToolbar' },
  { key: 'Selection', caption: 'Selection', dock: 'TopDock', component: 'SelectionToolbar' },
  { key: 'Session', caption: 'Sessions and Tabs', dock: 'TopDock', component: 'SessionToolbar2' },
  { key: 'Preferences', caption: 'Preferences', dock: 'TopDock', component: 'PreferencesToolbar' },
  { key: 'Sort', caption: 'Sort', dock: 'TopDock', component: 'SortToolbar' },
  { key: 'Address', caption: 'Address', dock: 'TopDock', component: 'AddressToolbar' },
  { key: 'Updates', caption: 'Updates', dock: 'TopDock', component: 'UpdatesToolbar' },
  { key: 'Transfer', caption: 'Transfer Settings', dock: 'TopDock', component: 'TransferToolbar' },
  { key: 'CustomCommands', caption: 'Custom Commands', dock: 'TopDock', component: 'CustomCommandsToolbar' },
];

function bandsFor(mode) {
  checkInterface(mode);
  return (mode === EXPLORER ? EXPLORER_BANDS : COMMANDER_BANDS).map((b) => Object.assign({}, b));
}

// ---------------------------------------------------------------------------
// Toolbar layout persistence
// ---------------------------------------------------------------------------
//
// The layout is one comma-text string of `Key=Value` pairs. Key is the toolbar
// component name with the "Toolbar" suffix stripped (UserInterface.cpp:460);
// value is `visible:dockedTo:dockRow+dockPos` and, for a floating band, a
// further `:lastDock:XxY` (TB2Dock.pas:5074). A dockedTo of "+" means floating.

const FLOATING_DOCK = '+';
const PIXELS_PER_INCH_KEY = 'PixelsPerInch';

/** GetToolbarKey — MenuToolbar -> Menu. */
function toolbarKey(componentName) {
  return C.removeSuffix(String(componentName || ''), 'Toolbar', true);
}

/**
 * TCustomScpExplorerForm::GetToolbarItemName — an item is named after its
 * action (minus "Action"), or after itself minus "SubmenuItem"/"Item".
 */
function toolbarItemName(item) {
  const it = item || {};
  if (it.action) return C.removeSuffix(String(it.action), 'Action', true);
  let name = String(it.name || '');
  name = C.removeSuffix(name, 'SubmenuItem', true);
  name = C.removeSuffix(name, 'Item', true);
  return name;
}

function parseInt10(text, fallback) {
  const n = parseInt(String(text), 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Read one band's position value. The Pascal reader consumes the string one
 * delimiter at a time (CutToChar), so a truncated value simply leaves the
 * remaining fields at their defaults rather than failing — reproduced here,
 * because a layout string written by an older build is exactly that.
 */
function parseBandPosition(value) {
  let rest = String(value == null ? '' : value);
  const take = (delim) => {
    const at = rest.indexOf(delim);
    if (at < 0) { const all = rest; rest = ''; return all; }
    const head = rest.slice(0, at);
    rest = rest.slice(at + 1);
    return head;
  };
  const visibleText = take(':');
  const dockedTo = take(':');
  const dockRowText = take('+');
  const dockPosText = take(':');
  const band = {
    visible: parseInt10(visibleText, 0) !== 0,
    dockedTo: dockedTo === FLOATING_DOCK ? '' : dockedTo,
    floating: dockedTo === FLOATING_DOCK,
    dockRow: parseInt10(dockRowText, 0),
    dockPos: parseInt10(dockPosText, 0),
  };
  if (band.floating) {
    band.lastDock = take(':');
    const pos = take(':');
    const x = pos.indexOf('x');
    band.floatingX = parseInt10(x < 0 ? pos : pos.slice(0, x), 0);
    band.floatingY = parseInt10(x < 0 ? '' : pos.slice(x + 1), 0);
  }
  return band;
}

/** Write one band's position value, in TBCustomSavePositions' exact order. */
function formatBandPosition(band) {
  const b = band || {};
  const dockedTo = b.floating ? FLOATING_DOCK : (b.dockedTo || '');
  let out = `${b.visible ? 1 : 0}:${dockedTo}:${b.dockRow | 0}+${b.dockPos | 0}`;
  if (b.floating) {
    out += `:${b.lastDock || ''}:${b.floatingX | 0}x${b.floatingY | 0}`;
  }
  return out;
}

/**
 * Parse a stored ToolbarsLayout string. Unknown keys are preserved in `extra`
 * rather than dropped: WinSCP's reader ignores what it does not know, and a
 * layout written by a newer build must survive a round trip through this one.
 */
function parseToolbarsLayout(text) {
  const bands = new Map();
  const extra = new Map();
  let pixelsPerInch = 0;
  for (const entry of W.commaTextToList(String(text || ''))) {
    const at = entry.indexOf('=');
    if (at < 0) continue;
    const key = entry.slice(0, at);
    const value = entry.slice(at + 1);
    if (key === PIXELS_PER_INCH_KEY) { pixelsPerInch = parseInt10(value, 0); continue; }
    if (key.includes('_')) { extra.set(key, value); continue; }
    bands.set(key, parseBandPosition(value));
  }
  return { bands, pixelsPerInch, extra };
}

/** GetToolbarsLayoutStr — insertion order is the component order. */
function formatToolbarsLayout(layout) {
  const l = layout || {};
  const items = [];
  const bands = l.bands instanceof Map ? l.bands : new Map(Object.entries(l.bands || {}));
  for (const [key, band] of bands) items.push(`${key}=${formatBandPosition(band)}`);
  const extra = l.extra instanceof Map ? l.extra : new Map(Object.entries(l.extra || {}));
  for (const [key, value] of extra) items.push(`${key}=${value}`);
  items.push(`${PIXELS_PER_INCH_KEY}=${l.pixelsPerInch || 96}`);
  return W.listToCommaText(items);
}

/**
 * ToolbarsButtons records only the buttons the user HID, because every button
 * ships visible. LoadToolbarsLayoutStr reads `Toolbar=Item:0,Item:0;Toolbar=...`
 * — semicolons between toolbars, commas between items, colon before the flag.
 */
function parseToolbarsButtons(text) {
  const out = new Map();
  for (const chunk of String(text || '').split(';')) {
    if (!chunk) continue;
    const at = chunk.indexOf('=');
    if (at < 0) continue;
    const toolbar = chunk.slice(0, at).trim();
    const items = new Map();
    for (const itemChunk of chunk.slice(at + 1).split(',')) {
      if (!itemChunk) continue;
      const colon = itemChunk.indexOf(':');
      const name = (colon < 0 ? itemChunk : itemChunk.slice(0, colon)).trim();
      const visible = colon < 0 ? false : parseInt10(itemChunk.slice(colon + 1), 0) !== 0;
      if (name) items.set(name, visible);
    }
    if (items.size) out.set(toolbar, items);
  }
  return out;
}

/** GetToolbarsButtonsStr — hidden buttons only, and never the queue toolbar. */
function formatToolbarsButtons(map) {
  const source = map instanceof Map ? map : new Map(Object.entries(map || {}));
  const parts = [];
  for (const [toolbar, itemsRaw] of source) {
    if (toolbar === 'Queue') continue;                 // Toolbar != QueueToolbar
    const items = itemsRaw instanceof Map ? itemsRaw : new Map(Object.entries(itemsRaw || {}));
    const hidden = [];
    for (const [name, visible] of items) if (!visible) hidden.push(`${name}:0`);
    if (hidden.length) parts.push(`${toolbar}=${hidden.join(',')}`);
  }
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Layout persistence: what each mode restores and stores
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::RestorePanelParams. The tree's size is stored in the
 * dimension the tree is currently aligned to, so a user who flips "tree on the
 * left" does not get a tree the height of the old width.
 */
function restorePanelParams(panelConfig, options) {
  const p = panelConfig || {};
  const treeOnLeft = !!(options || {}).treeOnLeft;
  return {
    dirViewParams: p.dirViewParams || '',
    viewStyle: p.viewStyle || 'report',
    statusBarVisible: p.statusBar !== false,
    treeVisible: !!p.driveView,
    treeAlign: treeOnLeft ? 'left' : 'top',
    treeSize: treeOnLeft ? (p.driveViewWidth || 100) : (p.driveViewHeight || 100),
    // "just to make sure" (ScpCommander.cpp:193): the extension column is never
    // restored visible, whatever a stored layout claims.
    extColumnVisible: false,
    lastPath: p.lastPath || '',
  };
}

/** TScpCommanderForm::StorePanelParams — the mirror image. */
function storePanelParams(panel, options) {
  const p = panel || {};
  const treeOnLeft = !!(options || {}).treeOnLeft;
  const out = {
    dirViewParams: p.dirViewParams || '',
    viewStyle: p.viewStyle || 'report',
    statusBar: p.statusBarVisible !== false,
    driveView: !!p.treeVisible,
  };
  if (treeOnLeft) out.driveViewWidth = p.treeSize | 0;
  else out.driveViewHeight = p.treeSize | 0;
  return out;
}

/**
 * TScpCommanderForm::RestoreParams / TScpExplorerForm::RestoreParams.
 * Returns the view state each mode asks its configuration for — the shapes
 * differ because the modes remember genuinely different things.
 */
function restoreParams(mode, prefs, options) {
  checkInterface(mode);
  const o = options || {};
  if (mode === EXPLORER) {
    const e = (prefs && prefs.scpExplorer) || {};
    return {
      mode: EXPLORER,
      windowParams: e.windowParams || '',
      dirViewParams: e.dirViewParams || '',
      extColumnVisible: false,
      viewStyle: e.viewStyle || 'icon',
      toolbarsLayout: e.toolbarsLayout || '',
      toolbarsButtons: e.toolbarsButtons || '',
      // A Store build hides its own updater band, whatever the layout says.
      updatesBandVisible: !o.uwp,
      sessionsTabs: e.sessionsTabs !== false,
      statusBar: e.statusBar !== false,
      treeVisible: e.driveView !== false,
      treeWidth: e.driveViewWidth || 180,
      showFullAddress: e.showFullAddress !== false,
      lastLocalTargetDirectory: e.lastLocalTargetDirectory || '',
    };
  }

  const c = (prefs && prefs.scpCommander) || {};
  const treeOnLeft = !!c.treeOnLeft;
  return {
    mode: COMMANDER,
    windowParams: c.windowParams || '',
    leftPanelWidth: typeof c.localPanelWidth === 'number' ? c.localPanelWidth : 0.5,
    toolbarsLayout: c.toolbarsLayout || '',
    toolbarsButtons: c.toolbarsButtons || '',
    updatesBandVisible: !o.uwp,
    sessionsTabs: c.sessionsTabs !== false,
    statusBar: c.statusBar !== false,
    currentPanel: c.currentPanel === REMOTE ? REMOTE : LOCAL,
    swappedPanels: !!c.swappedPanels,
    treeOnLeft,
    nortonLikeMode: c.nortonLikeMode || 'keyboard',
    explorerKeyboardShortcuts: !!c.explorerKeyboardShortcuts,
    systemContextMenu: !!c.systemContextMenu,
    preserveLocalDirectory: !!c.preserveLocalDirectory,
    localPanel: restorePanelParams(c.localPanel, { treeOnLeft }),
    remotePanel: restorePanelParams(c.remotePanel, { treeOnLeft }),
    otherLocalPanel: {
      dirViewParams: c.otherLocalPanelDirViewParams || '',
      viewStyle: c.otherLocalPanelViewStyle || 'report',
      extColumnVisible: false,
      lastPath: c.otherLocalPanelLastPath || '',
    },
    panelsRestored: true,
  };
}

/**
 * TScpCommanderForm::StoreParams / TScpExplorerForm::StoreParams. Returns the
 * patch to merge into preferences.
 *
 * Commander stores TWO extra things Explorer has no concept of: which panel was
 * focused, and the last path of each local panel — which is what makes the
 * window reopen where the user left it even with no session.
 */
function storeParams(mode, view) {
  checkInterface(mode);
  const v = view || {};
  if (mode === EXPLORER) {
    return {
      scpExplorer: {
        toolbarsLayout: v.toolbarsLayout || '',
        toolbarsButtons: v.toolbarsButtons || '',
        sessionsTabs: v.sessionsTabs !== false,
        statusBar: v.statusBar !== false,
        windowParams: v.windowParams || '',
        dirViewParams: v.dirViewParams || '',
        viewStyle: v.viewStyle || 'icon',
        driveView: v.treeVisible !== false,
        driveViewWidth: v.treeWidth | 0,
      },
    };
  }

  const treeOnLeft = !!v.treeOnLeft;
  return {
    scpCommander: Object.assign({
      toolbarsLayout: v.toolbarsLayout || '',
      toolbarsButtons: v.toolbarsButtons || '',
      localPanelWidth: typeof v.leftPanelWidth === 'number' ? v.leftPanelWidth : 0.5,
      sessionsTabs: v.sessionsTabs !== false,
      statusBar: v.statusBar !== false,
      currentPanel: v.currentPanel === REMOTE ? REMOTE : LOCAL,
      windowParams: v.windowParams || '',
      otherLocalPanelDirViewParams: (v.otherLocalPanel || {}).dirViewParams || '',
      otherLocalPanelViewStyle: (v.otherLocalPanel || {}).viewStyle || 'report',
      otherLocalPanelLastPath: (v.otherLocalPanel || {}).lastPath || '',
    }, {
      localPanel: Object.assign(
        storePanelParams(v.localPanel, { treeOnLeft }),
        { lastPath: (v.localPanel || {}).lastPath || '' },
      ),
      remotePanel: storePanelParams(v.remotePanel, { treeOnLeft }),
    }),
  };
}

/** TScpCommanderForm::ResetLayoutColumns / TScpExplorerForm::ResetLayoutColumns. */
function defaultDirViewParams(mode, side, state) {
  checkInterface(mode);
  if (mode === EXPLORER) return W.SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT;
  return isSideLocalBrowser(mode, side, state)
    ? W.SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT
    : W.SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT;   // == the Commander remote default
}

// ---------------------------------------------------------------------------
// The address bar
// ---------------------------------------------------------------------------

/**
 * Explorer's address bar is a real address bar: one editable box holding the
 * whole remote path, which the user types into.
 *
 * The behaviour worth porting exactly is the FAILURE path. When the typed path
 * cannot be opened, WinSCP does not silently revert: it remembers the text
 * (FFailedAddress), aborts the accept, and then — as the toolbar loop ends —
 * re-enters the address bar with the failed text selected, so the user can fix
 * a typo instead of retyping the path (UnixPathComboBoxBeginEdit /
 * AddressToolbarEndModal / UnixPathComboBoxAcceptText).
 */
class ExplorerAddressBar {
  constructor(options) {
    const o = options || {};
    this.showFullAddress = o.showFullAddress !== false;
    this.failedAddress = '';
  }

  /**
   * RemotePathComboBoxText. With no session there is no address at all; with
   * "show full address" off, the box shows only the deepest path segment,
   * which is why it reads the LAST entry of the drop-down rather than the path.
   */
  text(state) {
    const s = state || {};
    if (!s.hasSession) return '';
    if (this.showFullAddress) return RF.unixExcludeTrailingBackslash(s.path || '');
    const items = s.items || remotePathComboItems(s.path || '');
    if (!items.length) return '';
    return items[items.length - 1].caption;
  }

  /** UnixPathComboBoxBeginEdit — a failed address comes back, pre-selected. */
  beginEdit(state) {
    if (this.failedAddress) {
      const text = this.failedAddress;
      this.failedAddress = '';
      return { text, selectAll: true };
    }
    return { text: this.text(state), selectAll: false };
  }

  /**
   * UnixPathComboBoxAcceptText. `tryOpen(path)` reports whether the directory
   * opened. Returns { accepted, text, aborted } — `aborted` is WinSCP's Abort(),
   * which leaves the box in edit mode rather than committing bad text.
   */
  acceptText(newText, state, tryOpen) {
    const s = state || {};
    if ((s.path || '') === newText) return { accepted: true, text: newText, aborted: false };
    if (!tryOpen(newText)) {
      this.failedAddress = newText;
      return { accepted: false, text: newText, aborted: true };
    }
    return { accepted: true, text: this.text(Object.assign({}, s, { path: newText })), aborted: false };
  }

  /** AddressToolbarEndModal — a failure re-opens the address bar. */
  endModal() {
    return { reenter: this.failedAddress !== '' };
  }
}

/**
 * The remote path drop-down: the path broken into cumulative segments, root
 * first. Used by both modes (Explorer's address box, Commander's remote path
 * combo), which is why it lives here rather than in either.
 */
function remotePathComboItems(path) {
  const full = RF.unixExcludeTrailingBackslash(String(path || ''));
  if (!full) return [];
  const items = [{ caption: '/', path: '/' }];
  let current = '';
  for (const part of full.split('/')) {
    if (!part) continue;
    current = `${current}/${part}`;
    items.push({ caption: part, path: current });
  }
  return items;
}

/**
 * Commander has NO address bar. It has two path combo boxes that list PLACES —
 * two special folders and then every valid drive — because in a two-panel file
 * manager the common move is "switch this panel to another drive", not "type a
 * path" (LocalPathComboUpdateDrives, ScpCommander.cpp:2204).
 *
 * FLocalSpecialPaths is asserted to be constant across refreshes in the C++,
 * so the count is returned here rather than recomputed by callers.
 */
const LOCAL_SPECIAL_FOLDERS = 2;

function localPathComboItems(places) {
  const p = places || {};
  const items = [
    { caption: 'My documents', path: p.personalFolder || '', special: true },
    { caption: 'Desktop', path: p.desktopFolder || '', special: true },
  ];
  for (const drive of p.drives || []) {
    if (drive.valid === false) continue;
    // A real drive letter gets an accelerator so Alt+C jumps to C:.
    const caption = drive.realDrive === false ? (drive.prettyName || drive.key) : `&${drive.prettyName || drive.key}`;
    items.push({ caption, path: drive.rootPath || drive.key, special: false, drive: drive.key });
  }
  return { items, specialCount: LOCAL_SPECIAL_FOLDERS };
}

/**
 * LocalPathComboUpdate — select the first entry whose path is a prefix of the
 * panel's path. WinSCP compares only the first `entry.length` characters, so
 * "C:\" matches "C:\Users\..." without any path walking.
 */
function localPathComboIndexFor(path, items) {
  const target = String(path || '');
  for (let index = 0; index < items.length; index++) {
    const entry = String(items[index].path || '');
    if (entry && C.samePaths(entry, target.slice(0, entry.length))) return index;
  }
  return -1;                                     // "what to do if not?" — WinSCP leaves it alone
}

/**
 * DoLocalPathComboBoxItemClick. The special-folder entries open a path; a drive
 * entry executes the drive, which restores that drive's last-visited directory.
 *
 * The local-browser exception is deliberate and easy to miss: when the OTHER
 * panel is asked for a drive the CURRENT panel is already on, it opens the
 * current panel's directory instead of the drive root — so "show me the same
 * place on the other side" is one click.
 */
function localPathComboItemClick(index, state) {
  const s = state || {};
  const items = s.items || [];
  if (index < 0 || index >= items.length) {
    throw new RangeError(`path combo index ${index} out of range`);
  }
  const entry = items[index];
  const specialCount = typeof s.specialCount === 'number' ? s.specialCount : LOCAL_SPECIAL_FOLDERS;
  if (index < specialCount) return { kind: 'path', path: entry.path };

  // Both sides of the comparison go through the same drive-key extraction in
  // the C++ (DriveInfo->GetDriveKey); comparing a stored key like "C" against
  // a path-derived "C:" would silently never match.
  const entryDrive = C.extractFileDrive(entry.path || '');
  const currentDrive = C.extractFileDrive(s.currentPanelPath || '');
  if (s.localBrowserMode && s.isOtherPanel && entryDrive && C.samePaths(currentDrive, entryDrive)) {
    return { kind: 'path', path: s.currentPanelPath };
  }
  return { kind: 'drive', drive: entry.drive || entryDrive };
}

/**
 * TScpCommanderForm::ChangePath focuses that side's path combo;
 * TScpExplorerForm::ChangePath is DebugFail() — the command does not exist
 * there, and reporting it as unavailable is the honest port of a hard failure.
 */
function changePath(mode, side, state) {
  checkInterface(mode);
  if (mode === EXPLORER) {
    return { ok: false, reason: 'the Explorer interface has no per-panel path box; use the address bar' };
  }
  const resolved = getSide(side, (state || {}).currentSide);
  return { ok: true, focus: resolved === LOCAL ? 'LocalPathComboBox' : 'RemotePathComboBox' };
}

/**
 * TScpCommanderForm::GoToAddress opens the directory dialog for the current
 * side; TScpExplorerForm::GoToAddress enters the address toolbar instead.
 */
function goToAddress(mode, state) {
  checkInterface(mode);
  if (mode === EXPLORER) return { kind: 'focusAddressBar' };
  return { kind: 'openDirectoryDialog', side: getSide(CURRENT, (state || {}).currentSide) };
}

// ---------------------------------------------------------------------------
// The command line (Commander only)
// ---------------------------------------------------------------------------

/**
 * Commander's bottom band is a command line, and it is TWO histories in one
 * box: shell commands typed against the local panel go to "LocalCommands",
 * commands typed against a remote panel go to "Commands"
 * (SaveCommandLine/CommandLinePopulate, ScpCommander.cpp:1911).
 *
 * Switching sides therefore CLEARS the box's list (SideEnter) so the wrong
 * history is never offered — a local `dir` must not be suggested at a shell
 * prompt on a Unix server.
 */
class CommandLine {
  constructor() {
    this.populated = false;
    this.text = '';
  }

  static historyKey(sideIsLocal) { return sideIsLocal ? 'LocalCommands' : 'Commands'; }

  /** SideEnter — a change of side between local and remote invalidates the list. */
  sideEnter(wasLocal, nowLocal) {
    if (wasLocal !== nowLocal) {
      this.populated = false;
      return { clear: true };
    }
    return { clear: false };
  }

  /** CommandLinePopulate. */
  populate(sideIsLocal, histories) {
    if (this.populated) return null;
    const list = ((histories || {})[CommandLine.historyKey(sideIsLocal)] || []).slice();
    this.populated = true;
    return list;
  }

  /** SaveCommandLine — only a populated box has anything worth writing back. */
  save(sideIsLocal, items) {
    if (!this.populated) return null;
    return { key: CommandLine.historyKey(sideIsLocal), items: (items || []).slice() };
  }

  /**
   * ExecuteCommandLine. The refusals matter: nothing runs while busy or on an
   * empty command, and a REMOTE command additionally needs the server to allow
   * arbitrary commands and a command session to be available.
   */
  execute(command, state) {
    const s = state || {};
    const text = String(command == null ? this.text : command);
    if (s.busy) return { ok: false, reason: 'the application is busy' };
    if (!text) return { ok: false, reason: 'no command entered' };
    if (s.sideIsLocal) return { ok: true, kind: 'shell', command: text };
    if (!s.allowedAnyCommand) return { ok: false, reason: 'the server does not allow arbitrary commands' };
    if (!s.commandSessionAvailable) return { ok: false, reason: 'no command session is available' };
    return { ok: true, kind: 'console', command: text };
  }

  /**
   * CommandLineComboEditWndProc — the three keys the box handles itself.
   * Escape clears and returns focus to the panel; Tab commits the text and
   * returns focus; Enter commits, returns focus and runs, and RE-ENTERS the
   * box if the run was refused so the command is not lost behind a dialog.
   */
  key(name, editText, state) {
    if (name === 'Escape') return { text: '', exitToolbar: true, handled: true };
    if (name === 'Tab') return { text: editText, exitToolbar: true, handled: true };
    if (name === 'Enter') {
      const result = this.execute(editText, state);
      return {
        text: result.ok ? '' : editText,
        exitToolbar: true,
        handled: true,
        run: result,
        reenter: !result.ok,
      };
    }
    return { handled: false };
  }
}

/**
 * UpdateControls: the prompt is "Command >" on a local panel and "Command $" on
 * a remote one, and the box is disabled entirely when neither is possible.
 */
function commandLinePrompt(state) {
  const s = state || {};
  const local = !!s.sideIsLocal;
  return {
    caption: `Command ${local ? '>' : '$'}`,
    enabled: local || !!s.canConsole,
  };
}

/**
 * PanelExportStore with pedCommandLine: exporting a file list "to the command
 * line" appends the names to whatever is already typed, and shows the band.
 */
function appendToCommandLine(current, names) {
  let buffer = '';
  for (const name of names || []) buffer += `${name} `;
  return { showCommandLineBand: true, text: `${current || ''}${buffer}` };
}

// ---------------------------------------------------------------------------
// Double-click behaviour
// ---------------------------------------------------------------------------

/**
 * DoDirViewExecFile (CustomScpExplorer.cpp:5925) plus the two modes' framing.
 *
 * The resolution itself is shared (winconfig.resolveDoubleClickAction), but
 * what "copy" MEANS is not: in Explorer it is a download to the last local
 * target directory, in Commander it is a transfer to the other panel, and in
 * Commander's local-local mode it is a plain local file copy. Same double
 * click, three different operations.
 *
 * The refusals are real too: "open" and "edit" on a remote file are declined
 * outright when the administrator disabled opening/editing (DisableOpenEdit),
 * and the double click then falls through to the view's own handling.
 */
function doubleClickAction(mode, context) {
  checkInterface(mode);
  const ctx = context || {};
  const side = getSide(ctx.side, ctx.currentSide);
  const sideIsLocal = isSideLocalBrowser(mode, side, ctx);
  const remote = !sideIsLocal;

  let action;
  if (ctx.forceExecution) {
    // The explicit "Open" command bypasses the preference entirely.
    action = ctx.isDirectory ? 'changeDir' : 'open';
  } else {
    action = W.resolveDoubleClickAction({
      isDirectory: ctx.isDirectory,
      hasSession: remote && !!ctx.hasSession,
      resolvingSymlinks: ctx.resolvingSymlinks,
      encryptingFiles: ctx.encryptingFiles,
      alwaysRespectDoubleClickAction: ctx.alwaysRespectDoubleClickAction,
      doubleClickAction: ctx.doubleClickAction,
    });
  }

  if (action === 'copy') {
    if (mode === COMMANDER && ctx.localBrowserMode) {
      return {
        action,
        operation: 'localLocalCopy',
        side,
        confirm: !!ctx.copyOnDoubleClickConfirmation,
        allowExec: false,
      };
    }
    if (!ctx.hasAvailableSession) {
      // ExecuteFileOperation is simply not called; the double click does
      // nothing rather than erroring.
      return { action, operation: null, side, allowExec: false, reason: 'no session is available' };
    }
    return {
      action,
      operation: 'transfer',
      side,
      confirm: !!ctx.copyOnDoubleClickConfirmation,
      allowExec: false,
    };
  }

  if (action === 'edit') {
    if (remote && ctx.disableOpenEdit) {
      return { action, operation: null, side, allowExec: true, reason: 'opening and editing files is disabled' };
    }
    return { action, operation: 'edit', side, allowExec: false };
  }

  if (action === 'open') {
    if (ctx.isDirectory) return { action, operation: null, side, allowExec: true };
    if (!remote) {
      // A local file is opened by the shell through the view itself.
      return { action, operation: null, side, allowExec: true };
    }
    if (ctx.disableOpenEdit) {
      return { action, operation: null, side, allowExec: true, reason: 'opening and editing files is disabled' };
    }
    return { action, operation: 'shellOpen', side: REMOTE, allowExec: false };
  }

  return { action, operation: null, side, allowExec: true };
}

/**
 * TScpCommanderForm::LocalDirViewExecFile — a Windows shortcut that resolves to
 * an existing DIRECTORY is executed (i.e. navigated into) regardless of the
 * double-click preference. Without this a .lnk to a folder would be "edited".
 */
function localExecFile(item, resolve) {
  const it = item || {};
  const ext = String(it.ext || C.extractFileExt(it.name || '')).replace(/^\./, '').toUpperCase();
  if (ext === 'LNK') {
    const target = resolve ? resolve(it.fullName || it.name) : null;
    if (target && target.isDirectory) return { allowExec: true, followsShortcut: true, target: target.path };
  }
  return { allowExec: null, followsShortcut: false };   // null: fall through to doubleClickAction
}

/**
 * DirViewContextPopupDefaultItem — which context-menu entry is BOLD. Commander
 * bolds a different Copy entry in local-local mode, because the command that
 * runs is a different command (DoLocalDirViewContextPopup, ScpCommander.cpp
 * :2548; DirViewContextPopup for the remote side, CustomScpExplorer.cpp:2751).
 */
function contextMenuDefaultItems(mode, context) {
  checkInterface(mode);
  const ctx = context || {};
  const side = getSide(ctx.side, ctx.currentSide);
  const resolved = ctx.forceExecution
    ? (ctx.isDirectory ? 'changeDir' : 'open')
    : W.resolveDoubleClickAction({
      isDirectory: ctx.isDirectory,
      hasSession: !isSideLocalBrowser(mode, side, ctx) && !!ctx.hasSession,
      resolvingSymlinks: ctx.resolvingSymlinks,
      encryptingFiles: ctx.encryptingFiles,
      alwaysRespectDoubleClickAction: ctx.alwaysRespectDoubleClickAction,
      doubleClickAction: ctx.doubleClickAction,
    });

  const bold = (name, ...actions) => ({ item: name, default: actions.includes(resolved) });

  if (mode === EXPLORER || !isSideLocalBrowser(mode, side, ctx)) {
    return {
      resolved,
      items: [
        bold('RemoteOpenMenuItem', 'changeDir', 'open'),
        bold('RemoteEditMenuItem', 'edit'),
        bold('RemoteCopyMenuItem', 'copy'),
      ],
    };
  }

  return {
    resolved,
    items: [
      bold('LocalOpenMenuItem', 'open', 'changeDir'),
      bold('LocalEditMenuItem', 'edit'),
      bold(ctx.localBrowserMode ? 'LocalLocalCopyMenuItem' : 'LocalCopyMenuItem', 'copy'),
    ],
  };
}

/**
 * TScpCommanderForm::DoLocalDirViewContextPopup — the local panel offers
 * WinSCP's own menu unless the user asked for the system shell menu, and
 * Shift-invoking it forces the system menu for one popup (DisplaySystemContextMenu).
 */
function localContextMenuKind(state) {
  const s = state || {};
  return (s.systemContextMenu || s.forceSystemContextMenu) ? 'system' : 'application';
}

// ---------------------------------------------------------------------------
// The copy/move commands each mode offers
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::UpdateControls' action re-binding (ScpCommander.cpp:1084).
 * The SAME toolbar buttons and menu entries point at different actions
 * depending on the mode and the focused side. This is the table.
 */
function copyCommandBindings(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) {
    return {
      currentCopyVisible: true,
      currentCopy: 'RemoteCopyAction',
      currentMove: 'RemoteMoveAction',
      currentCopyTo: 'RemoteCopyToAction',
      currentMoveTo: 'RemoteMoveToAction',
      localCopy: null,
      localMove: null,
      remoteCopy: 'RemoteCopyAction',
      remoteMove: 'RemoteMoveAction',
    };
  }

  const side = getSide(CURRENT, s.currentSide);
  if (s.localBrowserMode) {
    // With two local panels there is nothing to "download", so the plain Copy
    // entry disappears entirely rather than sitting there disabled.
    const copy = side === LOCAL ? 'LocalLocalCopyAction' : 'LocalOtherCopyAction';
    const move = side === LOCAL ? 'LocalLocalMoveAction' : 'LocalOtherMoveAction';
    return {
      currentCopyVisible: false,
      currentCopy: null,
      currentMove: null,
      currentCopyTo: copy,
      currentMoveTo: move,
      localCopy: 'LocalLocalCopyAction',
      localMove: 'LocalLocalMoveAction',
      remoteCopy: 'LocalOtherCopyAction',
      remoteMove: 'LocalOtherMoveAction',
      toolbarCopy: copy,
      toolbarMove: move,
    };
  }

  const localSide = isSideLocalBrowser(mode, side, s);
  const currentCopy = localSide ? 'LocalCopyAction' : 'RemoteCopyAction';
  const currentMove = localSide ? 'LocalMoveAction' : 'RemoteMoveAction';
  return {
    currentCopyVisible: true,
    currentCopy,
    currentMove,
    currentCopyTo: 'RemoteCopyToAction',
    currentMoveTo: 'RemoteMoveToAction',
    currentCopyNonQueue: localSide ? 'LocalCopyNonQueueAction' : 'RemoteCopyNonQueueAction',
    currentCopyQueue: localSide ? 'LocalCopyQueueAction' : 'RemoteCopyQueueAction',
    localCopy: 'LocalCopyAction',
    localMove: 'LocalMoveAction',
    remoteCopy: 'RemoteCopyAction',
    remoteMove: 'RemoteMoveAction',
    toolbarCopy: currentCopy,
    toolbarMove: currentMove,
  };
}

/**
 * ConfigurationChanged's panel swap (ScpCommander.cpp:818). Swapping panels is
 * not only a layout change: the two menu buttons trade places, two shortcuts
 * trade actions, two captions and hints trade, and two icons trade — otherwise
 * the "left panel" menu would sit on the right.
 */
function panelSwapEffects() {
  return {
    menuOrder: ['RemoteMenuButton', 'LocalMenuButton'],
    swapShortcuts: [['LocalChangePathAction2', 'RemoteChangePathAction2']],
    swapCaptions: [['CommanderLocalPanelAction', 'CommanderRemotePanelAction']],
    swapHints: [['CommanderLocalPanelAction', 'CommanderRemotePanelAction']],
    swapImages: [
      ['LocalLocalCopyAction', 'LocalOtherCopyAction'],
      ['LocalLocalMoveAction', 'LocalOtherMoveAction'],
    ],
  };
}

// ---------------------------------------------------------------------------
// Default download target and the transfer dialog's pre-filled directory
// ---------------------------------------------------------------------------

/**
 * DefaultDownloadTargetDirectory. This is the single clearest behavioural
 * difference between the modes: Commander downloads INTO THE PANEL YOU ARE
 * LOOKING AT; Explorer, having no local panel, downloads into wherever you
 * downloaded last, falling back to Documents if that directory is gone.
 */
function defaultDownloadTargetDirectory(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === COMMANDER) return C.includeTrailingBackslash(s.localPanelPath || '');
  const last = s.lastLocalTargetDirectory || '';
  const exists = typeof s.directoryExists === 'function' ? s.directoryExists(last) : !!last;
  return exists && last ? last : (s.personalFolder || '');
}

/**
 * CopyParamDialog's pre-fill and CopyParamDialogAfter's write-back.
 * Only Explorer remembers the target, because only Explorer has to.
 */
function copyParamTargetDirectory(mode, request, state) {
  checkInterface(mode);
  const r = request || {};
  const s = state || {};
  if (r.targetDirectory) return { targetDirectory: r.targetDirectory, remember: false };
  if (r.temp) return { targetDirectory: '', remember: false };   // drag & drop supplies its own
  if (r.direction === 'toLocal') {
    return { targetDirectory: defaultDownloadTargetDirectory(mode, s), remember: mode === EXPLORER };
  }
  return { targetDirectory: RF.unixIncludeTrailingBackslash(s.remotePanelPath || ''), remember: false };
}

function copyParamDialogAfter(mode, result) {
  checkInterface(mode);
  const r = result || {};
  if (mode === EXPLORER && r.direction === 'toLocal' && !r.temp) {
    return { scpExplorer: { lastLocalTargetDirectory: r.targetDirectory || '' } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compare and synchronize (Commander has both; Explorer has one of them)
// ---------------------------------------------------------------------------

const CC_TIME = 'time';
const CC_SIZE = 'size';

/** ReduceDateTimePrecision (BaseUtils.pas:205). Times are epoch milliseconds. */
function reducePrecision(timeMs, precision) {
  if (precision === 'none') return 0;
  if (precision === 'millisecond' || !precision) return timeMs;
  const date = new Date(timeMs);
  if (precision === 'day') { date.setHours(0, 0, 0, 0); return date.getTime(); }
  if (precision === 'minute') { date.setSeconds(0, 0); return date.getTime(); }
  if (precision === 'second') { date.setMilliseconds(0); return date.getTime(); }
  throw new TypeError(`unknown timestamp precision: ${String(precision)}`);
}

const PRECISION_ORDER = ['none', 'day', 'minute', 'second', 'millisecond'];

/**
 * TCustomDirView.ProcessChangedFiles (CustomDirView.pas:2912) — the comparison
 * behind "Compare directories".
 *
 * Three edge cases that a naive port gets wrong:
 *  - Directories are NEVER marked; only files are compared.
 *  - A missing counterpart counts as changed only when `existingOnly` is false.
 *  - When both sides only know the time to the second, the OTHER side gets an
 *    extra millisecond before the comparison, so two files a rounding error
 *    apart are not both reported as newer than each other.
 */
function compareFiles(items, mirror, options) {
  const o = options || {};
  const criterias = new Set(o.criterias || []);
  const existingOnly = !!o.existingOnly;
  const byName = new Map();
  for (const item of mirror || []) byName.set(String(item.name), item);

  const changed = [];
  for (const item of items || []) {
    if (item.isDirectory) { changed.push(false); continue; }
    const other = byName.get(String(item.name));
    if (!other) { changed.push(!existingOnly); continue; }

    let isChanged = false;
    let sameTime = true;
    if (criterias.has(CC_TIME)) {
      let precision = item.precision || 'millisecond';
      const otherPrecision = other.precision || 'millisecond';
      if (PRECISION_ORDER.indexOf(otherPrecision) < PRECISION_ORDER.indexOf(precision)) {
        precision = otherPrecision;
      }
      let time = item.modified || 0;
      let otherTime = other.modified || 0;
      if (precision !== 'millisecond') {
        time = reducePrecision(time, precision);
        otherTime = reducePrecision(otherTime, precision);
      }
      sameTime = time === otherTime;
      if (precision === 'second') otherTime += 1001;
      isChanged = time > otherTime;
    }
    if (!isChanged && sameTime && criterias.has(CC_SIZE)) {
      isChanged = (item.size || 0) !== (other.size || 0);
    }
    changed.push(isChanged);
  }
  return changed;
}

/**
 * TScpCommanderForm::CompareDirectories. Both panels are compared against each
 * other, and when NEITHER ends up with a selection the user is told so — an
 * empty selection would otherwise look like the command did nothing.
 *
 * Explorer refuses: TCustomScpExplorerForm::CompareDirectories is DebugFail(),
 * because there is no second panel to compare with.
 */
function compareDirectories(mode, state) {
  checkInterface(mode);
  if (mode === EXPLORER) {
    return { ok: false, reason: 'the Explorer interface has only one panel; there is nothing to compare' };
  }
  const s = state || {};
  const criterias = s.criterias || [];
  const left = compareFiles(s.localFiles || [], s.otherFiles || [], { criterias });
  const right = compareFiles(s.otherFiles || [], s.localFiles || [], { criterias });
  const leftSelected = (s.localFiles || []).filter((_, i) => left[i]).map((f) => f.name);
  const rightSelected = (s.otherFiles || []).filter((_, i) => right[i]).map((f) => f.name);
  const noDifferences = leftSelected.length + rightSelected.length === 0;
  return {
    ok: true,
    leftSelected,
    rightSelected,
    noDifferences,
    message: noDifferences ? 'No differences found.' : '',
  };
}

/**
 * SynchronizeDirectories ("keep remote directory up to date").
 * Commander uses the two panels and REFUSES in local-local mode — the feature
 * synchronizes a local directory with a remote one, and there is no remote one.
 * Explorer uses the last local target directory as the local end.
 */
function synchronizeDirectories(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === COMMANDER) {
    if (s.localBrowserMode) {
      return { ok: false, reason: 'both panels are local; keeping a directory up to date needs a remote directory' };
    }
    return { ok: true, localDirectory: s.localPanelPath || '', remoteDirectory: s.remotePanelPath || '', remember: false };
  }
  return {
    ok: true,
    localDirectory: s.lastLocalTargetDirectory || '',
    remoteDirectory: s.remotePanelPath || '',
    remember: true,
  };
}

/**
 * FullSynchronizeDirectories. The default DIRECTION differs, and that is the
 * whole point: in Commander the direction follows the focused panel (you
 * synchronize away from where you are standing) unless the user pinned a
 * direction; in Explorer there is no panel to read, so the last used mode is
 * always the default and is always saved.
 */
function fullSynchronizeDirectories(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === COMMANDER) {
    const auto = typeof s.synchronizeModeAuto === 'number' ? s.synchronizeModeAuto : -1;
    const saveMode = !(auto < 0);
    const currentSide = getSide(CURRENT, s.currentSide);
    return {
      ok: true,
      directory1: s.localPanelPath || '',
      directory2: s.otherPanelPath || '',
      mode: saveMode ? auto : (currentSide === LOCAL ? SYNC_MODE_REMOTE : SYNC_MODE_LOCAL),
      saveMode,
      remember: false,
    };
  }
  return {
    ok: true,
    directory1: s.lastLocalTargetDirectory || '',
    directory2: s.remotePanelPath || '',
    mode: typeof s.synchronizeMode === 'number' ? s.synchronizeMode : SYNC_MODE_REMOTE,
    saveMode: true,
    remember: true,
  };
}

/** TSynchronizeMode, in TSynchronizeParams' declaration order. */
const SYNC_MODE_LOCAL = 0;
const SYNC_MODE_REMOTE = 1;
const SYNC_MODE_BOTH = 2;

// ---------------------------------------------------------------------------
// Synchronized browsing ("keep the other panel's directory in step")
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::SynchronizeBrowsingLocal — the local panel moved, so work
 * out where the remote panel should go.
 *
 * The algorithm is a relative-path walk, not a string swap. It finds the common
 * ancestor of the OLD and NEW local paths, walks the remote path up by the same
 * number of levels, then appends whatever the local path gained. That is what
 * lets "up two, down three" on one side follow on the other.
 *
 * It ABORTS (a hard refusal, not an error to retry) when the remote path runs
 * out of levels to climb, or when the two local paths share no ancestor at all
 * — e.g. after switching drives. WinSCP has no fallback for that and neither
 * does this: guessing a remote directory would be worse than declining.
 */
function synchronizeBrowsingLocal(context) {
  const ctx = context || {};
  const newLocal = String(ctx.localPath || '');
  let prevPath = String(ctx.prevPath || '');
  const common = RF.extractCommonPath([
    C.includeTrailingBackslash(prevPath),
    C.includeTrailingBackslash(newLocal),
  ]);
  if (!common.ok) return { ok: false, reason: 'abort', message: NO_COMMON_PATH };

  prevPath = C.includeTrailingBackslash(prevPath);
  const commonPath = C.includeTrailingBackslash(common.path);
  // RemoteDirView->Path always carries its trailing slash in the VCL, and the
  // root test below depends on it: '/' is the ONE path that is unchanged by
  // stripping a trailing slash, which is exactly how WinSCP detects "there is
  // nowhere further up to go".
  let newPath = RF.unixIncludeTrailingBackslash(String(ctx.remotePath || ''));
  let guard = 0;
  while (!C.samePaths(prevPath, commonPath)) {
    if (newPath === RF.unixExcludeTrailingBackslash(newPath)) {
      return { ok: false, reason: 'abort', message: REMOTE_AT_ROOT };
    }
    newPath = RF.unixExtractFilePath(RF.unixExcludeTrailingBackslash(newPath));
    prevPath = C.extractFilePath(C.excludeTrailingBackslash(prevPath));
    if (++guard > 512 || prevPath === '') return { ok: false, reason: 'abort', message: NO_COMMON_PATH };
  }

  const tail = newLocal.slice(prevPath.length);
  return {
    ok: true,
    side: REMOTE,
    path: RF.unixIncludeTrailingBackslash(newPath) + C.toUnixPath(tail),
  };
}

/**
 * TScpCommanderForm::SynchronizeBrowsingRemote — the mirror image, with one
 * extra step: the remote segments are run through the transfer rules' filename
 * mapping before being used as LOCAL directory names, because a remote name may
 * be illegal locally (ChangeFilePath, ScpCommander.cpp:1335). `changeFileName`
 * is injected; the identity default is correct when no rule is configured.
 */
function synchronizeBrowsingRemote(context) {
  const ctx = context || {};
  const newRemote = String(ctx.remotePath || '');
  let prevPath = String(ctx.prevPath || '');
  const common = RF.unixExtractCommonPath([
    RF.unixIncludeTrailingBackslash(prevPath),
    RF.unixIncludeTrailingBackslash(newRemote),
  ]);
  if (!common.ok) return { ok: false, reason: 'abort', message: NO_COMMON_PATH };

  prevPath = RF.unixIncludeTrailingBackslash(prevPath);
  const commonPath = RF.unixIncludeTrailingBackslash(common.path);
  let newPath = C.excludeTrailingBackslash(String(ctx.localPath || ''));
  let guard = 0;
  while (!RF.unixSamePath(prevPath, commonPath)) {
    const up = C.excludeTrailingBackslash(C.extractFileDir(newPath));
    if (up === newPath) return { ok: false, reason: 'abort', message: LOCAL_AT_ROOT };
    newPath = up;
    prevPath = RF.unixExtractFilePath(RF.unixExcludeTrailingBackslash(prevPath));
    if (++guard > 512 || prevPath === '') return { ok: false, reason: 'abort', message: NO_COMMON_PATH };
  }

  const tail = newRemote.slice(prevPath.length);
  const changeFileName = ctx.changeFileName || ((name) => name);
  return {
    ok: true,
    side: LOCAL,
    path: C.includeTrailingBackslash(newPath) + changeFilePath(tail, REMOTE, changeFileName),
  };
}

const NO_COMMON_PATH = 'the two directories share no common parent';
const REMOTE_AT_ROOT = 'the remote directory is already at the root';
const LOCAL_AT_ROOT = 'the local directory is already at the root';

/**
 * TScpCommanderForm::ChangeFilePath — map every segment of a path through the
 * transfer filename rules and flip the separator. Note WinSCP's own quirk,
 * reproduced here: the LAST segment is always mapped as if it were a local
 * name (`osLocal` is hard-coded at ScpCommander.cpp:1350) even when the rest
 * of the path was mapped for the other side.
 */
function changeFilePath(path, side, changeFileName) {
  const sep = side === LOCAL ? '\\' : '/';
  const outSep = side === LOCAL ? '/' : '\\';
  let rest = String(path || '');
  let result = '';
  while (rest !== '') {
    const at = rest.indexOf(sep);
    if (at >= 0) {
      result += changeFileName(rest.slice(0, at), side) + outSep;
      rest = rest.slice(at + 1);
    } else {
      result += changeFileName(rest, LOCAL);
      rest = '';
    }
  }
  return result;
}

/**
 * The synchronized-browsing driver (TScpCommanderForm::SynchronizeBrowsing,
 * ScpCommander.cpp:1494) with its full refusal ladder:
 *
 *   - it never fires while it is already firing (a mirrored change must not
 *     bounce back), nor on the first load of a panel (no previous path yet),
 *     nor when the path did not really change;
 *   - it is impossible in local-local mode, and asserts so in the C++;
 *   - when the mapping ABORTS it turns itself off and says so;
 *   - when the mapped directory does not EXIST it asks whether to create it;
 *     answering no turns synchronized browsing off rather than leaving the
 *     panels silently out of step;
 *   - when the creation then fails it reports the failure AND turns off.
 */
class SynchronizedBrowsing {
  constructor(options) {
    const o = options || {};
    this.enabled = !!o.enabled;
    this.synchronising = false;
    this.constructed = o.constructed !== false;
    // FPrevPath[2], indexed the same way the C++ does: [remote, local].
    this.prevPath = { [LOCAL]: '', [REMOTE]: '' };
  }

  /**
   * TSynchronizedBrowsingGuard — every command that deliberately moves BOTH
   * panels (open bookmark, home directory, focus a remote path, the open
   * directory dialog) turns synchronized browsing off for its duration so the
   * second move does not trigger a third.
   */
  guard(fn) {
    const was = this.enabled;
    this.enabled = false;
    try {
      return fn();
    } finally {
      this.enabled = was;
    }
  }

  /** Record a panel's new path and hand back what it was. */
  recordPath(side, path) {
    const key = getSide(side, LOCAL);
    const prev = this.constructed ? this.prevPath[key] : '';
    this.prevPath[key] = String(path || '');
    return prev;
  }

  /** Would a change on this side do anything at all? */
  shouldFollow(side, path, prevPath) {
    return this.enabled && !this.synchronising && !!prevPath && prevPath !== String(path || '');
  }

  /** Compute the target without applying it. */
  map(side, context) {
    return getSide(side, LOCAL) === LOCAL
      ? synchronizeBrowsingLocal(context)
      : synchronizeBrowsingRemote(context);
  }

  /**
   * The whole decision for one path change. `effects` supplies the world:
   *   exists(side, path)          -> bool
   *   confirmCreate(path)         -> bool   (the "create directory?" question)
   *   create(side, path)          -> void   (may throw)
   *   setPath(side, path)         -> void   (may throw)
   *   report(message)             -> void   (the turned-off notice)
   * Returns a record of what happened, so a caller (or a test) can assert it.
   */
  follow(side, context, effects) {
    const e = effects || {};
    const prev = this.recordPath(side, getSide(side, LOCAL) === LOCAL ? context.localPath : context.remotePath);
    if (!this.shouldFollow(side, getSide(side, LOCAL) === LOCAL ? context.localPath : context.remotePath, prev)) {
      return { followed: false, reason: 'no change to follow' };
    }
    if (context.localBrowserMode) {
      // Both panels are local; there is no opposite side to synchronize with.
      this.enabled = false;
      return { followed: false, reason: 'both panels are local', turnedOff: true };
    }

    this.synchronising = true;
    try {
      const target = this.map(side, Object.assign({}, context, { prevPath: prev }));
      if (!target.ok) {
        this.enabled = false;
        if (e.report) e.report(SYNC_DIR_BROWSE_ERROR);
        return { followed: false, reason: target.message, turnedOff: true, aborted: true };
      }

      const missing = e.exists ? !e.exists(target.side, target.path) : false;
      if (missing) {
        const create = e.confirmCreate ? e.confirmCreate(target.path) : false;
        if (!create) {
          this.enabled = false;
          return { followed: false, reason: 'the user declined to create the directory', turnedOff: true, target };
        }
        try {
          if (e.create) e.create(target.side, target.path);
        } catch (error) {
          this.enabled = false;
          if (e.report) e.report(SYNC_DIR_BROWSE_ERROR);
          return { followed: false, reason: String(error && error.message || error), turnedOff: true, target, error };
        }
      }

      try {
        if (e.setPath) e.setPath(target.side, target.path);
      } catch (error) {
        this.enabled = false;
        if (e.report) e.report(SYNC_DIR_BROWSE_ERROR);
        return { followed: false, reason: String(error && error.message || error), turnedOff: true, target, error };
      }
      this.prevPath[target.side] = target.path;
      return { followed: true, target, created: missing };
    } finally {
      this.synchronising = false;
    }
  }

  /**
   * TScpCommanderForm::HistoryGo. Back/forward moves BOTH panels when
   * synchronized browsing is on and the other panel has that much history —
   * and only then, because moving one panel two steps and the other zero would
   * leave them permanently mismatched.
   */
  historyGo(side, index, state) {
    const s = state || {};
    const other = getOtherSide(side, s.currentSide);
    // Both comparisons are strictly-less-than in the C++ (ScpCommander.cpp:2501).
    // The backward one looks off by one — going back one step with exactly one
    // step of history available does NOT mirror — but that is what WinSCP does,
    // and the conservative direction (leave the other panel alone) is the safe
    // one, so it is reproduced rather than "corrected".
    const otherHas = index < 0 ? (-index < (s.otherBackCount || 0)) : (index < (s.otherForwardCount || 0));
    if (this.enabled && otherHas) {
      return { sides: [getSide(side, s.currentSide), other], guarded: true };
    }
    return { sides: [getSide(side, s.currentSide)], guarded: false };
  }

  /**
   * TScpCommanderForm::HomeDirectory. "Home" moves both panels when
   * synchronized browsing is on — the guard prevents the first move from
   * dragging the second one somewhere else first.
   */
  homeDirectory(side, state) {
    const resolved = getSide(side, (state || {}).currentSide);
    if (this.enabled) return { sides: [resolved, getOtherSide(resolved)], guarded: true };
    return { sides: [resolved], guarded: false };
  }
}

const SYNC_DIR_BROWSE_ERROR =
  'Cannot open corresponding directory in the opposite panel. ' +
  'Directory browsing synchronisation failed. It has been turned off.';

/** SYNC_DIR_BROWSE_CREATE2 — the confirmation, with the path filled in. */
function syncDirBrowseCreateMessage(path) {
  return `Do you want to try to create directory '${path}'?\n\n` +
    'Cannot open corresponding directory in the opposite panel.';
}

// ---------------------------------------------------------------------------
// Session state carried per tab
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::UpdateSessionData — what the Commander writes back into a
 * session's state so a tab reopens where it was. Setting BOTH local
 * directories is what marks a session as a local browser; the C++ asserts the
 * two agree, and so do we, because a half-set pair would produce a session that
 * claims to be local-local and is not.
 */
function updateSessionData(mode, data, state) {
  checkInterface(mode);
  const s = state || {};
  const out = Object.assign({}, data || {});
  out.remoteDirectory = s.remotePath || out.remoteDirectory || '';
  if (mode === EXPLORER) return out;

  out.localDirectory = s.localPath || '';
  if (s.localBrowserMode) out.otherLocalDirectory = s.otherLocalPath || '';
  else out.otherLocalDirectory = '';
  out.synchronizeBrowsing = !!s.synchronizeBrowsing;
  if (SD.isLocalBrowser(out) !== !!s.localBrowserMode) {
    throw new Error('local browser state and the stored directories disagree');
  }
  return out;
}

/**
 * TScpCommanderForm::RestoreSessionLocalDirView + SessionChanged. Whether a new
 * session moves the local panel at all is a preference — "preserve local
 * directory" keeps the panel where the user put it, EXCEPT for the very first
 * session of the run and except for a local-local session, whose directories
 * are the whole point of it.
 */
function shouldRestoreLocalDirectory(state) {
  const s = state || {};
  if (!s.localDirectory) return false;
  return !!s.firstTerminal || !s.preserveLocalDirectory || !!s.localBrowser;
}

/**
 * SessionChanged's panel-state restore. WinSCP restores the SELECTION and
 * scroll position of the local panel only when the panel is actually going to
 * move with the session; otherwise restoring a selection from another
 * directory would highlight the wrong files.
 */
function shouldRestorePanelState(state) {
  const s = state || {};
  return !!s.preservePanelState && (!s.preserveLocalDirectory || !!s.localBrowser);
}

/**
 * TScpCommanderForm::GetLocalBrowserSessionTitle. A local-local tab with no
 * name is titled by its two directories, shortened.
 */
function localBrowserSessionTitle(session, state) {
  const s = state || {};
  const data = (session && session.sessionData) || {};
  if (SD.hasSessionName(data)) return SD.sessionName(data);
  const shorten = s.shorten || ((p) => C.extractFileName(C.excludeTrailingBackslash(String(p || ''))) || String(p || ''));
  return `${shorten(s.path1 || '')}${SD.TITLE_SEPARATOR}${shorten(s.path2 || '')}`;
}

/**
 * TCustomScpExplorerForm::GetSessionPath — the directory a tab is showing on a
 * given side. The osOther case is the one that matters: for a local-local tab
 * it is the SECOND LOCAL directory, not a remote one, which is what lets a
 * local-local tab produce a hint and a title at all.
 */
function sessionPath(session, side) {
  const s = session || {};
  const data = s.stateData || s.sessionData || {};
  if (getSide(side, LOCAL) === LOCAL) return data.localDirectory || '';
  return s.localBrowser ? (data.otherLocalDirectory || '') : (data.remoteDirectory || '');
}

/**
 * TScpCommanderForm::GetTabHintDetails. The hint lists both panels, in visual
 * order — and WinSCP deliberately does NOT apply the right-to-left inversion
 * here (ScpCommander.cpp:2912), on the grounds that a right-to-left reader
 * expects the right-hand panel first because that is where they start reading.
 */
function tabHintDetails(mode, session, state) {
  checkInterface(mode);
  const s = state || {};
  const sess = session || {};
  const lines = [];
  if (mode === EXPLORER) {
    if (s.sessionDetails) lines.push(s.sessionDetails);
    lines.push(sess.active ? (s.remotePath || '') : 'Not connected.');
    return lines.join('\n');
  }
  if (!sess.localBrowser && s.sessionDetails) lines.push(s.sessionDetails);
  if (!sess.localBrowser && !sess.active) {
    lines.push('Not connected.');
  } else if (s.swappedPanels) {
    lines.push(s.otherPath || '', s.localPath || '');
  } else {
    lines.push(s.localPath || '', s.otherPath || '');
  }
  return lines.join('\n');
}

/**
 * TScpCommanderForm::PathForCaption. On a local panel the window title shows
 * the LOCAL path, but only while the tab shown is the tab whose title is being
 * written — during a session switch the two disagree and WinSCP prints nothing
 * rather than a path from the wrong session.
 */
function pathForCaption(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER || !isSideLocalBrowser(mode, CURRENT, s)) {
    // The base class prints nothing without a session — there is no current
    // directory to name, and a stale one from the previous tab would be a lie.
    if (!s.hasSession) return '';
    if (s.pathInCaption === 'full') return s.remotePath || '';
    if (s.pathInCaption === 'short') {
      return C.extractFileName(RF.unixExcludeTrailingBackslash(s.remotePath || '')) || (s.remotePath || '');
    }
    return '';
  }
  if (!s.sessionIsActiveSession) return '';
  const path = s.localPath || '';
  if (s.pathInCaption === 'full') return path;
  if (s.pathInCaption === 'short') {
    return C.extractFileName(C.excludeTrailingBackslash(path)) || path;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
//
// A workspace is the whole window written down: every open tab, the site or
// ad-hoc session behind it, the directory each panel was showing, whether
// synchronized browsing was on, and the tab colour. It is stored as ordinary
// stored sites inside a folder, each named by its index in hex so the order
// survives (TStoredSessionList::SaveWorkspaceData, SessionData.cpp:5861).
//
// A member is stored as a LINK when the site it came from still exists — so
// editing the site later changes the workspace too — and as a full copy when it
// does not, so an ad-hoc session is not lost.

/**
 * TSessionData::IsInFolderOrWorkspace — a stored site belongs to a folder or a
 * workspace when its name starts with that folder's name plus a slash. Note
 * this is the PER-SITE test; sessiondata.js's `isInFolder` asks the same
 * question of a whole list, which is a different question.
 */
function sessionIsInFolder(data, name) {
  if (!name) return false;
  const prefix = RF.unixIncludeTrailingBackslash(String(name));
  return String((data || {}).name || '').toLowerCase().startsWith(prefix.toLowerCase());
}

/** TCustomScpExplorerForm::WorkspaceName. */
function workspaceName(state) {
  const s = state || {};
  return C.defaultStr(s.lastWorkspace, C.defaultStr(s.autoWorkspace, 'My Workspace'));
}

/**
 * TTerminalManager::SaveWorkspace + TCustomScpExplorerForm::DoCollectWorkspace.
 * `sessions` is every open tab in order, each with `stateData` (the tab's own
 * copy of its session data) and `active`.
 */
function collectWorkspace(stored, sessions, options) {
  const o = options || {};
  const list = [];
  (sessions || []).forEach((session, index) => {
    const data = SD.saveWorkspaceData(stored || [], session.stateData || {}, index);
    if (session.active && o.updateCredentials) o.updateCredentials(data, session);
    list.push(data);
  });
  return list;
}

/**
 * TCustomScpExplorerForm::SaveWorkspace's password decision, which is subtler
 * than "ask the user".
 *
 * A workspace member stored as a LINK carries no password (the site owns it),
 * so only non-linked members matter. If none of them has a password there is
 * nothing to decide. If they all sign in anonymously, or a master password is
 * protecting the store, saving passwords is not "not recommended" and it is
 * offered pre-ticked. Otherwise it is pre-ticked only when every password
 * belongs to a session that CAME FROM a workspace already — i.e. the user
 * already agreed to store it once.
 */
function workspacePasswordDecision(dataList, sessions, state) {
  const s = state || {};
  let anyNonStoredSessionWithPassword = false;
  let anyNonStoredNonWorkspaceSessionWithPassword = false;
  let allNonStoredSessionsAnonymous = true;

  (dataList || []).forEach((data, index) => {
    if (data.link) return;
    if (s.hasAnySessionPassword ? s.hasAnySessionPassword(data) : !!data.password) {
      anyNonStoredSessionWithPassword = true;
      const session = (sessions || [])[index];
      if (!(session && session.sessionData && session.sessionData.isWorkspace)) {
        anyNonStoredNonWorkspaceSessionWithPassword = true;
      }
    }
    if (String(data.userName || '').toLowerCase() !== SD.ANONYMOUS_USER_NAME.toLowerCase()) {
      allNonStoredSessionsAnonymous = false;
    }
  });

  const notRecommended = !s.useMasterPassword && !allNonStoredSessionsAnonymous;
  if (s.disablePasswordStoring || !anyNonStoredSessionWithPassword) {
    return { askUser: false, savePasswords: false, notRecommended };
  }
  return {
    askUser: true,
    savePasswords: !anyNonStoredNonWorkspaceSessionWithPassword || !notRecommended,
    notRecommended,
  };
}

/**
 * TCustomScpExplorerForm::DoSaveWorkspace + TStoredSessionList::NewWorkspace.
 * Saving a workspace REPLACES it: everything already in that folder is removed
 * first, so a tab the user closed does not come back.
 */
function saveWorkspace(stored, name, dataList, options) {
  const o = options || {};
  const list = (dataList || []).map((d) => SD.cloneSessionData(d));
  if (!o.savePasswords) {
    for (const data of list) {
      // A link's password lives on the site it points at, so clearing it here
      // would clear nothing and hide that the site still has one.
      if (!data.link) {
        data.password = '';
        data.newPassword = '';
        data.tunnelPassword = '';
        data.proxyPassword = '';
        data.encryptKey = '';
      }
    }
  }

  const kept = [];
  const removed = [];
  for (const session of stored || []) {
    if (sessionIsInFolder(session, name)) removed.push(session.name);
    else kept.push(session);
  }
  for (const data of list) {
    const copy = SD.cloneSessionData(data);
    copy.name = SD.composePath(name, data.name);
    copy.modified = true;
    kept.push(copy);
  }
  return { sessions: kept, removed, lastWorkspace: name };
}

/**
 * TStoredSessionList::DoGetFolderOrWorkspace — the restore side.
 *
 * Three rules that are easy to lose:
 *  - a link is followed to the real site, and the WORKSPACE's own state
 *    (directories, colour) is then copied over it, so the tab reopens where it
 *    was rather than at the site's default directory;
 *  - a pre-5.6.4 workspace has no state at all, and must not overwrite the
 *    site's defaults with empty strings — hence the hasStateData test;
 *  - a member that was an ad-hoc session reopens WITHOUT a name, so the
 *    generated internal name ("0001") never becomes user-visible.
 */
function getFolderOrWorkspace(stored, name, options) {
  const o = options || {};
  const out = [];
  for (const raw of stored || []) {
    if (!sessionIsInFolder(raw, name)) continue;
    const resolved = SD.resolveWorkspaceData(stored || [], raw);
    if (!resolved || !SD.canOpen(resolved) || resolved.link) continue;

    const data = SD.cloneSessionData(resolved);
    if (raw.link && resolved !== raw && SD.hasStateData(raw)) {
      SD.copyStateData(data, raw);
    }
    if (raw.nameOverride) data.name = raw.nameOverride;
    else if (!raw.link && raw.isWorkspace) data.name = '';
    // IsWorkspace is one of TSessionData's META_PROPERTIES (SessionData.cpp:549)
    // and Assign copies it, so the restored data KEEPS the flag for a member
    // stored as a full copy and loses it for one stored as a link (because the
    // link resolves to the real site, which is not a workspace entry). Two later
    // decisions read it: TTerminalManager::NewSessions makes a workspace session
    // Permanent, and SaveWorkspace pre-ticks "save passwords" only when every
    // password already came from a workspace. Blanking it here would quietly
    // change both.
    if (o.supportedSession && !o.supportedSession(data)) continue;
    out.push(data);
  }
  return out;
}

/** TStoredSessionList::GetFolderOrWorkspaceList — just the names. */
function folderOrWorkspaceList(stored, name) {
  return getFolderOrWorkspace(stored, name).map((data) => SD.sessionName(data));
}

/**
 * TCustomScpExplorerForm::DoOpenFolderOrWorkspace. The max-sessions ceiling is
 * a REFUSAL, not a truncation: WinSCP opens nothing at all rather than an
 * arbitrary prefix of the workspace.
 *
 * Everything in a workspace is opened "permanent" — a session that fails to
 * connect stays as a tab so the workspace is not silently thinned out. A single
 * session opened from a FOLDER is the exception, guessed by set size exactly as
 * the C++ does (TerminalManager.cpp:337), because a one-site folder is
 * indistinguishable from a plain site here.
 */
function openFolderOrWorkspace(stored, name, options) {
  const o = options || {};
  const mode = o.mode ? checkInterface(o.mode) : COMMANDER;
  const all = getFolderOrWorkspace(stored, name);
  const usable = all.filter((data) => supportedSession(mode, data));
  if (o.checkMaxSessions && typeof o.maxSessions === 'number' && all.length > o.maxSessions) {
    return {
      ok: false,
      reason: `the workspace has ${all.length} sessions and the limit is ${o.maxSessions}`,
      sessions: [],
    };
  }
  const sessions = usable.map((data, index) => ({
    data,
    // Per session, exactly as NewSessions computes it (TerminalManager.cpp:337):
    // a member stored as a full copy carries IsWorkspace and is permanent on its
    // own; a member stored as a link only becomes permanent because the set has
    // more than one entry.
    permanent: !!data.isWorkspace || all.length > 1,
    // WorkspaceConnectAll staggers the reconnects so a 12-tab workspace does
    // not open twelve sockets in the same instant.
    connect: index === 0 ? o.connectFirstTerminal !== false : !!o.workspaceConnectAll,
    connectDelayMs: index === 0 ? 0 : (o.workspaceConnectAll ? 3000 : 0),
  }));
  const first = sessions[0] || null;
  if (first && o.connectFirstTerminal === false) {
    first.disconnected = true;
    first.disconnectedTemporarily = true;
  }
  return {
    ok: true,
    sessions,
    // "FirstSession can be null, if none of the workspace sites exist anymore
    // or if all workspace sessions are not supported by the interface."
    activeSession: first,
    skipped: all.length - usable.length,
  };
}

/**
 * TCustomScpExplorerForm::FormClose's auto-save. An EMPTY window saves nothing
 * — otherwise closing after the last tab was closed would wipe the workspace
 * the user spent the session building.
 */
function autoSaveWorkspaceOnClose(state) {
  const s = state || {};
  if (!s.autoSaveWorkspace) return { save: false, reason: 'auto-save is off' };
  if (!s.hasSession) return { save: false, reason: 'no session is open' };
  const name = workspaceName(s);
  return {
    save: true,
    name,
    savePasswords: !s.disablePasswordStoring && !!s.autoSaveWorkspacePasswords,
    explicit: false,
    lastStoredSession: name,
  };
}

/**
 * The close-query decision (CustomScpExplorer.cpp:5580). With auto-save on, the
 * window closes without asking and simply records the workspace; without it,
 * more than one session or any active session earns a confirmation, and the
 * user may choose to save a workspace on the way out.
 */
function closeQuery(state) {
  const s = state || {};
  const sessions = s.sessionCount || 0;
  const active = s.activeSessionCount || 0;
  if (s.autoSaveWorkspace) {
    return { confirm: false, note: `The workspace '${workspaceName(s)}' will be saved.` };
  }
  if (active > 0 || sessions > 1) {
    return { confirm: true, offerSaveWorkspace: sessions > 1, activeSessions: active };
  }
  return { confirm: false };
}

// ---------------------------------------------------------------------------
// Session startup
// ---------------------------------------------------------------------------

/**
 * DoShow / NeedSession. Commander ALWAYS has a session: with nothing to open it
 * creates a local browser, which is why it can show two panels before any
 * connection exists. Explorer waits for one.
 *
 * The initially focused panel is the one the user left focused, unless the
 * opposite panel is not usable — focusing a disabled view is what the C++
 * comment at ScpCommander.cpp:378 spends a paragraph avoiding.
 */
function initialFocus(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) {
    return s.otherPanelEnabled ? { side: REMOTE } : { side: null };
  }
  if (s.currentPanel === LOCAL || !s.otherPanelEnabled) return { side: LOCAL };
  return { side: REMOTE };
}

function needSession(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (s.hasSession) return { create: null };
  if (mode === COMMANDER) return { create: 'localBrowser' };
  return { create: null, showLogin: true };
}

/**
 * DoLocalDefaultDirectory (ScpCommander.cpp:716). The fallback ladder for a
 * local panel with nowhere to go: the remembered path, then the user's home —
 * except that a home directory on a NETWORK drive is skipped in favour of any
 * valid local path, because a disconnected network home would hang the panel —
 * and finally the application's own directory.
 */
function localDefaultDirectory(state) {
  const s = state || {};
  const steps = [];
  if (s.lastPath) {
    steps.push({ kind: 'lastPath', path: s.lastPath });
  }
  if (s.homeDriveType === 'remote') {
    steps.push({ kind: 'anyValidPath', reason: 'the home directory is on a network drive' });
  } else {
    steps.push({ kind: 'home', path: s.homeDirectory || '' });
  }
  steps.push({ kind: 'applicationDirectory', path: s.applicationDirectory || '' });
  return steps;
}

// ---------------------------------------------------------------------------
// Status bars
// ---------------------------------------------------------------------------

/**
 * Commander has three status bars — one per panel plus the session one — and
 * DoUpdateFileStatusBar (ScpCommander.cpp:2121) refuses updates from a HIDDEN
 * panel, because in local-local mode the hidden remote view keeps reporting and
 * would otherwise overwrite the visible panel's counts.
 *
 * Explorer has one status bar doing both jobs, so a file-count update competes
 * with a transient note and only wins when there is no note to cancel.
 */
function statusBarsFor(mode) {
  checkInterface(mode);
  if (mode === EXPLORER) {
    return { session: 'RemoteStatusBar', panels: { remote: 'RemoteStatusBar' }, shared: true };
  }
  return {
    session: 'StatusBar',
    panels: { local: 'LocalStatusBar', remote: 'RemoteStatusBar' },
    shared: false,
  };
}

function shouldUpdateFileStatusBar(mode, state) {
  const s = state || {};
  if (checkInterface(mode) === COMMANDER) return { update: !!s.panelVisible, target: 'panel' };
  return { update: true, target: 'session', cancelNoteFirst: true };
}

// ---------------------------------------------------------------------------
// Local-local copy (Commander only)
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::LocalLocalCopy (ScpCommander.cpp:2762) — copying between
 * two LOCAL panels is not a transfer at all; it is a shell file operation with
 * a target built from a file mask.
 *
 * The refusals: the operation only proceeds when confirmed (or explicitly
 * unconfirmed by the caller), and "confirm overwriting" off is passed straight
 * through to the file operation rather than being re-implemented here.
 */
function localLocalCopy(operation, state) {
  const s = state || {};
  if (operation !== 'copy' && operation !== 'move') {
    throw new TypeError(`local-local ${String(operation)} is not a file operation`);
  }
  const sources = (s.sources || []).map(String);
  const destinationDir = s.destinationDir || '';
  const mask = s.fileMask || C.ANY_MASK;
  const targets = sources.map((source) => {
    const name = C.extractFileName(source);
    return C.combinePaths(destinationDir, s.maskFileName ? s.maskFileName(name, mask) : name);
  });
  const reloads = [destinationDir];
  if (operation === 'move') {
    const sourceDir = s.sourceDir || '';
    if (sourceDir && !C.samePaths(sourceDir, destinationDir)) reloads.push(sourceDir);
  }
  return {
    operation,
    sources,
    targets,
    multipleFiles: sources.length > 1,
    noConfirmation: !s.confirmOverwriting,
    clearSelection: true,
    reloadDirectories: reloads,
    counter: operation === 'move' ? 'LocalLocalMovesCommand' : 'LocalLocalCopiesCommand',
  };
}

// ---------------------------------------------------------------------------
// Drag & drop targets (Commander's internal download shortcut)
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::InternalDDDownload. Dropping remote files on the local
 * panel downloads them without going through the shell, but ONLY when the drop
 * target is a directory: a drop onto a file (a ZIP, an EXE) belongs to that
 * file's own drop handler, and stealing it would break the association.
 */
function internalDropTarget(state) {
  const s = state || {};
  if (s.control === 'LocalDriveView') {
    return { ok: true, directory: s.nodePath || '' };
  }
  if (s.control !== 'LocalDirView') {
    return { ok: false, reason: 'the drop target is not a local file control' };
  }
  if (!s.dropTarget) return { ok: true, directory: s.defaultDownloadTargetDirectory || '' };
  if (!s.dropTargetIsDirectory) {
    return { ok: false, reason: 'the drop target is a file with its own drop handler' };
  }
  return { ok: true, directory: s.dropTargetFullName || '' };
}

// ---------------------------------------------------------------------------
// Directory creation for synchronized browsing
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::CreateRemoteDirectory / ::CreateLocalDirectory. Both
 * recurse to the parent first, so "create it" after a failed synchronized
 * browse really does create the whole missing branch and not just the leaf,
 * which would fail again on the very next level.
 *
 * Returned outermost-first, which is the order they must actually be created.
 */
function missingDirectoryChain(path, side, exists) {
  const unix = getSide(side, REMOTE) === REMOTE;
  const parentOf = unix
    ? (p) => RF.unixExcludeTrailingBackslash(RF.unixExtractFileDir(p))
    : (p) => C.excludeTrailingBackslash(C.extractFileDir(p));
  const isRoot = unix ? (p) => RF.isUnixRootPath(p) || p === '' : (p) => !p || C.extractFileDir(p) === p;

  const chain = [];
  let current = unix ? RF.unixExcludeTrailingBackslash(String(path || '')) : C.excludeTrailingBackslash(String(path || ''));
  let guard = 0;
  while (current && !isRoot(current) && ++guard < 512) {
    if (exists && exists(current)) break;
    chain.unshift(current);
    const parent = parentOf(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Bookmarks and the open-directory dialog
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::DoOpenDirectoryDialog. Commander offers LOCATION
 * PROFILES — a saved pair of directories, one per panel — instead of the plain
 * one-directory dialog, but only when a session exists (the profiles dialog
 * cannot run without one). The plain dialog runs inside the synchronized
 * browsing guard so opening a directory does not drag the other panel.
 *
 * The `do…while` in the C++ exists because the profiles dialog contains the
 * "use location profiles" checkbox itself: turning it off reopens as the plain
 * dialog, in browse mode, so the user is not thrown back to the panel.
 */
function openDirectoryDialog(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) return { kind: 'openDirectory', side: REMOTE, guarded: false };
  if (s.useLocationProfiles && s.hasAvailableSession && !s.localBrowserMode) {
    return { kind: 'locationProfiles', mode: s.dialogMode || 'open', reopenAs: 'browse' };
  }
  return {
    kind: 'openDirectory',
    side: getSide(s.side, s.currentSide),
    guarded: true,
    reopenAs: 'browse',
  };
}

/**
 * TScpCommanderForm::OpenBookmark / ::DoOpenBookmark. A Commander bookmark is
 * a PAIR of directories, and the two are opened independently on purpose: the
 * C++ puts the remote open in a __finally so that a bad LOCAL path still opens
 * the remote one and only then reports the error. Half a bookmark is better
 * than none.
 */
function openBookmark(mode, bookmark, state) {
  checkInterface(mode);
  const b = bookmark || {};
  const s = state || {};
  if (mode === EXPLORER || !s.useLocationProfiles || s.localBrowserMode) {
    // The base class opens only the side the bookmark was invoked from.
    const side = getSide(s.side, s.currentSide);
    const path = side === LOCAL ? b.local : b.remote;
    return { handled: false, steps: path ? [{ side, path, expandEnvironment: side === LOCAL }] : [] };
  }
  const steps = [];
  if (b.local) steps.push({ side: LOCAL, path: b.local, expandEnvironment: true, reportErrorAfter: true });
  if (b.remote) steps.push({ side: REMOTE, path: b.remote, expandEnvironment: false, always: true });
  return { handled: true, guarded: true, steps };
}

/**
 * TScpCommanderForm::ExploreFile — after a search result is revealed, the
 * focused panel follows the file, PREFERRING the remote panel when both
 * matched (a Find result is far more often the remote one).
 */
function exploreFileFocus(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) return { reveal: [REMOTE], currentPanel: REMOTE };
  if (s.localBrowserMode) {
    return { reveal: [LOCAL], currentPanel: LOCAL, reason: 'both panels are local' };
  }
  const reveal = [REMOTE, LOCAL];
  if (s.remoteSelected) return { reveal, currentPanel: REMOTE };
  if (s.localSelected) return { reveal, currentPanel: LOCAL };
  return { reveal, currentPanel: null };
}

// ---------------------------------------------------------------------------
// Local symbolic links (Commander only)
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::AddEditLink's LOCAL branch. On Windows there is no
 * symlink dialog in the Unix sense; a "link" is a .lnk shell shortcut, and the
 * differences are all refusals:
 *
 *  - EDIT only applies to a file that really is a .lnk, and only when the
 *    command was "edit", not "add";
 *  - a .lnk whose target cannot be resolved is an ERROR, not an empty form —
 *    silently offering a blank target would overwrite a working shortcut;
 *  - the parent-directory entry is never used as a link target;
 *  - a bare name is completed against the panel's directory and given the .lnk
 *    extension, so the user is not asked to type either.
 *
 * Editing is destructive-then-recreate (DeleteFileChecked + CreateFileShortCut),
 * which is why `replaces` is reported rather than implied.
 */
function localAddEditLink(add, state) {
  const s = state || {};
  const focused = s.focused || null;
  const ext = focused ? String(focused.ext || C.extractFileExt(focused.name || '')).replace(/^\./, '').toUpperCase() : '';
  const edit = !add && !!focused && ext === 'LNK';

  let fileName = '';
  let pointTo = '';
  if (edit) {
    fileName = focused.fullName || focused.name || '';
    pointTo = s.resolveShortcut ? (s.resolveShortcut(fileName) || '') : '';
    if (!pointTo) {
      return { ok: false, edit, reason: `Cannot resolve shortcut '${fileName}'.` };
    }
  } else if (focused && !focused.isParentDirectory) {
    pointTo = focused.name || '';
  }
  return { ok: true, edit, fileName, pointTo, symbolicLink: true, replaces: edit ? fileName : '' };
}

/** The completion AddEditLink performs after the dialog returns. */
function completeLocalLink(fileName, pointTo, panelPath) {
  const complete = (value) => {
    const v = String(value || '');
    if (!v) return v;
    // An absolute path (a drive or a UNC root) is left alone; anything else is
    // taken as relative to the panel.
    if (C.extractFileDrive(v) !== '' || v.startsWith('\\')) return v;
    return C.includeTrailingBackslash(String(panelPath || '')) + v;
  };
  let name = complete(fileName);
  if (name && C.extractFileExt(name) === '') name += '.lnk';
  return { fileName: name, pointTo: complete(pointTo) };
}

// ---------------------------------------------------------------------------
// Clipboard, focus targets and the hot-key band
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::CopyFilesToClipboard / ::PasteFromClipBoard. On a local
 * panel these are the SHELL clipboard operations, so copying in WinSCP and
 * pasting in Explorer works; on a remote panel they are the base class's
 * remote-file clipboard.
 */
function clipboardCopy(mode, side, state) {
  checkInterface(mode);
  return isSideLocalBrowser(mode, side, state || {}) ? { kind: 'shellClipboard', side: getSide(side, (state || {}).currentSide) }
    : { kind: 'remoteClipboard', side: REMOTE };
}

function clipboardPaste(mode, state) {
  const s = state || {};
  checkInterface(mode);
  if (s.clipboardHasOurFiles && isSideLocalBrowser(mode, CURRENT, s)) {
    if (!s.canPasteToDirView) {
      return { kind: null, reason: 'the panel cannot accept a paste' };
    }
    return { kind: 'downloadFromClipboard', target: s.currentPath || '', confirm: !!s.confirmTransferring };
  }
  return { kind: 'shellPaste' };
}

/**
 * GoToCommandLine / GoToTree. Both SHOW the component first — the shortcut is
 * how a user discovers a hidden band, so refusing because it is hidden would
 * make the shortcut do nothing.
 */
function goToCommandLine(mode) {
  checkInterface(mode);
  if (mode === EXPLORER) {
    return { ok: false, reason: 'the Explorer interface has no command line' };
  }
  return { ok: true, show: 'fcCommandLinePanel', focus: 'CommandLineCombo', onlyIfEnabled: true };
}

function goToTree(mode, state) {
  checkInterface(mode);
  const side = getSide(CURRENT, (state || {}).currentSide);
  if (mode === COMMANDER && side === LOCAL) {
    return { show: 'fcLocalTree', focus: 'LocalDriveView' };
  }
  return { show: 'fcRemoteTree', focus: 'RemoteDriveView' };
}

/** ExitToolbar — Escape/Tab out of a toolbar returns to the focused panel. */
function exitToolbar(mode, state) {
  checkInterface(mode);
  if (mode === EXPLORER) return { focusPanel: REMOTE };
  return { focusPanel: getSide(CURRENT, (state || {}).currentSide) };
}

/** ExploreLocalDirectory — open a local panel's folder in the shell. */
function exploreLocalDirectory(mode, side, state) {
  checkInterface(mode);
  if (!isSideLocalBrowser(mode, side, state || {})) {
    return { ok: false, reason: 'that panel is not showing a local directory' };
  }
  return { ok: true, path: (state || {}).path || '' };
}

/**
 * TScpCommanderForm::UpdateToolbar2ItemCaption. The "Hot Keys" band is a
 * teaching aid: each button is captioned with its own shortcut followed by the
 * command, hotkey ampersand and trailing ellipsis removed.
 */
function hotKeyCaption(item) {
  const it = item || {};
  const caption = C.stripEllipsis(stripHotkey(String(it.caption || '')));
  // Faithful to the C++: ShortCutToText(0) is empty, so an unbound item is
  // captioned with a leading space rather than being special-cased.
  return `${String(it.shortcut || '')} ${caption}`;
}

/** VCL StripHotkey: "&&" is a literal ampersand, a lone "&" marks the key. */
function stripHotkey(text) {
  const s = String(text || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      if (s[i + 1] === '&') { out += '&'; i++; }
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * EligibleForImageDisplayMode — the hot-key band always shows its captions,
 * so it opts out of the global "icons only / selective text" setting.
 */
function eligibleForImageDisplayMode(mode, item) {
  checkInterface(mode);
  if (mode !== COMMANDER) return true;
  return (item || {}).toolbar !== 'Toolbar2Toolbar';
}

// ---------------------------------------------------------------------------
// Focus, control order and drag-related reloads
// ---------------------------------------------------------------------------

/**
 * TScpCommanderForm::RestoreFocus. Disconnecting disables the remote panel
 * while it holds the focus; WinSCP walks a fallback ladder rather than leaving
 * the window with nothing focused, which Windows and the VCL disagree about.
 */
function restoreFocus(control, state) {
  const s = state || {};
  if (control === 'LocalDirView' || control === 'LocalDriveView') return control;
  if (control === 'RemoteDirView' || control === 'OtherLocalDirView') {
    return s.otherDirViewCanFocus ? 'OtherDirView' : 'LocalDirView';
  }
  if (control === 'RemoteDriveView' || control === 'OtherLocalDriveView') {
    if (s.otherDriveViewCanFocus) return 'OtherDriveView';
    if (s.localDriveViewCanFocus) return 'LocalDriveView';
    // Switching to a disconnected session with the local tree hidden.
    return 'LocalDirView';
  }
  return null;
}

/**
 * FixControlsPlacement's ordering. Layout in the VCL is order-sensitive, and
 * the two modes stack their parts differently — notably, Commander's queue and
 * status bar sit below BOTH panels while Explorer's queue sits inside the
 * remote panel (ScpExplorer.cpp:49 reparents it).
 */
function controlOrder(mode) {
  checkInterface(mode);
  if (mode === EXPLORER) {
    return {
      vertical: ['RemoteDirPanel', 'QueueSplitter', 'QueuePanel', 'BottomDock', 'RemoteStatusBar'],
      horizontal: ['RemoteDrivePanel', 'RemotePanelSplitter', 'RemoteDirPanel'],
      queueParent: 'RemotePanel',
    };
  }
  return {
    vertical: ['BottomDock', 'QueueSeparatorPanel', 'QueueSplitter', 'QueuePanel', 'StatusBar'],
    localPanel: ['LocalTopDock', 'LocalPathLabel', 'LocalDriveView', 'LocalPanelSplitter',
      'LocalDirView', 'LocalBottomDock', 'LocalStatusBar'],
    remotePanel: ['RemoteTopDock', 'RemotePathLabel', 'RemoteDrivePanel', 'RemotePanelSplitter',
      'RemoteDirPanel', 'RemoteBottomDock', 'RemoteStatusBar'],
    queueParent: 'Form',
  };
}

/**
 * TScpCommanderForm::FileOperationProgress' heuristic: a finished TRANSFER
 * whose drag-and-drop target was a local control means files just landed in
 * the local panel, so it is reloaded. It is a heuristic in the original too —
 * the comment says so — and reproducing it matters because without it a
 * drag-download leaves the panel showing the old contents.
 */
function shouldReloadAfterOperation(state) {
  const s = state || {};
  return !s.inProgress && !!s.progressShown && !!s.dropTargetIsLocal && !!s.isTransfer;
}

/** PanelOperation — a drag out of the local panel counts as a panel operation. */
function isPanelOperation(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (s.dropSourceControl === 'RemoteDirView' || s.dropSourceControl === 'OtherLocalDirView') return true;
  return mode === COMMANDER && s.dropSourceControl === 'LocalDirView';
}

/**
 * GetNewTabActionImageIndex / GetNewTabHintDetails. The New Tab button shows
 * the kind of tab it will actually open, and says how to get the other kind.
 */
function newTabPresentation(mode, state) {
  checkInterface(mode);
  const s = state || {};
  if (mode === EXPLORER) {
    return {
      icon: 'NewTabAction',
      hint: 'Click to open new session in new remote tab.\nHold down Shift Key to open new session in new window.',
    };
  }
  if (s.defaultToNewRemoteTab) {
    return {
      icon: 'NewTabAction',
      hint: 'Click to open new session in new remote tab.\nHold down Shift Key to open new session in new window.'
        + '\nHold down Ctrl key to open new local tab.',
    };
  }
  return {
    icon: 'NewLocalTabAction',
    hint: 'Click to open new local tab.\nHold down Ctrl key to open new remote tab.',
  };
}

module.exports = {
  // modes and sides
  COMMANDER, EXPLORER, INTERFACES, LOCAL, REMOTE, CURRENT, OTHER,
  isInterface, getSide, getOtherSide,

  // action gating
  AF_LOCAL, AF_REMOTE, AF_EXPLORER, AF_COMMANDER,
  AA_SHORTCUT, AA_UPDATE, AA_EXECUTE, EXPLORER_HIDDEN_ACTIONS,
  actionFlags, allowedAction, commandsFor, commandDifference,

  // shortcuts
  explorerShortcutSet, commanderShortcutSet, SHORTCUT_CLONES,
  shortcutsFor, shortcutConflicts,

  // panels
  panelArrangement, isSideLocalBrowser, hasDirView, dirViewEnabled,
  supportedSession, replacementForLastSession, newTabSide,

  // splitter
  PanelSplitter, panelTreeSplitterDblClick, explorerTreeSplitterDblClick,

  // components and bands
  COMMANDER_COMPONENTS, EXPLORER_COMPONENTS, COMMANDER_BANDS, EXPLORER_BANDS,
  componentsFor, componentOf, isComponentPossible, bandsFor,

  // layout persistence
  toolbarKey, toolbarItemName,
  parseToolbarsLayout, formatToolbarsLayout, parseBandPosition, formatBandPosition,
  parseToolbarsButtons, formatToolbarsButtons,
  restorePanelParams, storePanelParams, restoreParams, storeParams, defaultDirViewParams,

  // address bar and path boxes
  ExplorerAddressBar, remotePathComboItems, LOCAL_SPECIAL_FOLDERS,
  localPathComboItems, localPathComboIndexFor, localPathComboItemClick,
  changePath, goToAddress,

  // command line
  CommandLine, commandLinePrompt, appendToCommandLine,

  // double click and context menus
  doubleClickAction, localExecFile, contextMenuDefaultItems, localContextMenuKind,

  // copy/move bindings and panel swapping
  copyCommandBindings, panelSwapEffects,

  // transfer targets
  defaultDownloadTargetDirectory, copyParamTargetDirectory, copyParamDialogAfter,

  // compare and synchronize
  CC_TIME, CC_SIZE, reducePrecision, compareFiles, compareDirectories,
  synchronizeDirectories, fullSynchronizeDirectories,
  SYNC_MODE_LOCAL, SYNC_MODE_REMOTE, SYNC_MODE_BOTH,

  // synchronized browsing
  SynchronizedBrowsing, synchronizeBrowsingLocal, synchronizeBrowsingRemote,
  changeFilePath, syncDirBrowseCreateMessage, SYNC_DIR_BROWSE_ERROR,

  // session state
  updateSessionData, shouldRestoreLocalDirectory, shouldRestorePanelState,
  localBrowserSessionTitle, sessionPath, tabHintDetails, pathForCaption,

  // workspaces
  workspaceName, collectWorkspace, workspacePasswordDecision, saveWorkspace,
  getFolderOrWorkspace, folderOrWorkspaceList, openFolderOrWorkspace,
  autoSaveWorkspaceOnClose, closeQuery,

  // startup
  initialFocus, needSession, localDefaultDirectory,

  // status bars
  statusBarsFor, shouldUpdateFileStatusBar,

  // local-local copy and drag & drop
  localLocalCopy, internalDropTarget,
  shouldReloadAfterOperation, isPanelOperation,

  // directory creation, bookmarks, links, clipboard and focus
  missingDirectoryChain, openDirectoryDialog, openBookmark, exploreFileFocus,
  localAddEditLink, completeLocalLink,
  clipboardCopy, clipboardPaste, goToCommandLine, goToTree, exitToolbar,
  exploreLocalDirectory, hotKeyCaption, eligibleForImageDisplayMode,
  restoreFocus, controlOrder, newTabPresentation, stripHotkey,
};
