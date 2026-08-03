// explorershell.js — the non-visual half of forms/CustomScpExplorer.cpp
// (12,609 lines of C++, the largest single unit in the WinSCP tree) plus the
// synchronized-browsing logic its subclass forms/ScpCommander.cpp adds.
//
// The *form* is UI and lives in design/renderer/ui/panels.js. Everything below
// is what the form actually spends its lines on: orchestration. Which side is
// "current" and what is selected on it; whether a command may run right now;
// what parameters a copy is assembled from; whether a drop is a copy or a move;
// what the queue will accept; what happens when a tab or the window closes;
// how the two panels stay in step; and — most importantly — every confirmation
// and every refusal, because CustomScpExplorer.cpp is where nearly all of them
// live.
//
// Ported here, function by function:
//   GetSide / GetOtherSide / IsSideLocalBrowser / HasDirView / DirViewEnabled
//   GetEnableFocusedOperation / GetEnableSelectedOperation
//   CustomDirView::AnyFileSelected / OperateOnFocusedFile / CustomCreateFileList
//   CopyParamDialog + GetDoNotShowCopyDialogDefault + HandleDoNotShowCopyDialogAgain
//   ClearOperationSelection / ClearTransferSourceSelection / AddQueueItem
//   ExecuteCopyMoveFileOperation / ExecuteDeleteFileOperation / ExecuteFileOperation
//   ExecuteFileOperationCommand / ExecuteCopyOperationCommand / HandleErrorList
//   DeleteFiles / LockFiles / SetProperties gating / CreateDirectory
//   NeedSecondarySessionForRemoteCopy / RemoteTransferDialog / RemoteTransferFiles
//   CommandSessionFallback / EnsureCommandSessionFallback / CanCalculateChecksum
//   CustomCommandRemoteAllowed / CustomCommandState / AdHocCustomCommandValidate
//   CanAddEditLink / LinkFocused / CanPasteFromClipBoard / PasteFromClipBoard
//   SelectedAllFilesInDirView / DraggingAllFilesFromDirView
//   RemoteFileContolDDChooseEffect / DDGetTarget / RemoteFileControlDDEnd
//   RemoteFileControlDragDropFileOperation / DoWarnLackOfTempSpace
//   DefaultQueueOperation / AllowQueueOperation (with QueueController.cpp)
//   CanCloseQueue / CloseTab / DisconnectSession / CanCloseSession
//   FormCloseQuery / NeedSession / SessionTabSwitched / RenameTab / DuplicateTab
//   TransferPresetAutoSelect / GetTransferPresetAutoSelectData
//   RemoteExecuteForceText / ExecuteFileNormalize / TemporaryFileCopyParam
//   GetTempLocalName / EditNew / ExecuteFile / DoDirViewExecFile
//   SynchronizeAllowSelectedOnly / GetSynchronizeOptions / DoFullSynchronizeDirectories
//   ScpCommander: SynchronizeBrowsingLocal / SynchronizeBrowsingRemote / SynchronizeBrowsing
//
// Design notes that matter for anyone extending this:
//
//   * Main has no windows. Every confirmation WinSCP shows with MessageDialog
//     is asked here through the injected `ask` channel and genuinely awaited —
//     a refusal stops the operation exactly where the original stopped it. The
//     default `ask` THROWS rather than silently answering, because a port that
//     quietly proceeds where WinSCP asked is a data-loss bug and a port that
//     quietly cancels is a mystery bug.
//
//   * The heavy lifting (transferring, deleting, listing) belongs to
//     terminal.js / queue.js / the adapters. This module decides *whether* and
//     *with what*, then calls them through the injected `ops` facade.
//
//   * Where WinSCP's behaviour is a Win32 fact with no meaning here (the drag
//     shell extension's shared-memory handshake, HWND focus stealing, the
//     TBX docking) the INTENT is implemented and the substitution is named in
//     a comment. The drag-out half already lives in shellintegration.js and is
//     reused rather than re-derived.
'use strict';

const nodePath = require('path');
const nodeFs = require('fs');

const guitools = require('./guitools');
const customcmd = require('./customcmd');
const shellintegration = require('./shellintegration');
const { Terminal } = require('./terminal');

// ---------------------------------------------------------------------------
// Enumerations — the C++ ones, spelled out
// ---------------------------------------------------------------------------

/** TOperationSide. `current` and `other` resolve against the focused panel. */
const SIDES = { local: 'local', remote: 'remote', current: 'current', other: 'other' };

/** TFileOperation, minus the ones that never reach this layer. */
const OPERATIONS = {
  none: 'none',
  copy: 'copy',
  move: 'move',
  delete: 'delete',
  setProperties: 'setProperties',
  customCommand: 'customCommand',
  rename: 'rename',
  remoteMove: 'remoteMove',
  remoteCopy: 'remoteCopy',
  lock: 'lock',
  unlock: 'unlock',
};

/** TTransferDirection / TTransferType. */
const DIRECTIONS = { toRemote: 'toRemote', toLocal: 'toLocal' };
const TRANSFER_TYPES = { copy: 'copy', move: 'move' };

/** TExecuteFileBy. */
const EXECUTE_FILE_BY = {
  defaultEditor: 'defaultEditor',
  internalEditor: 'internalEditor',
  externalEditor: 'externalEditor',
  shell: 'shell',
};

/** TCustomCommandListType — which menu is asking about the command. */
const COMMAND_LIST_TYPE = { all: 'all', file: 'file', nonFile: 'nonFile', both: 'both' };

/** CustomCommandState's tri-state result. -1 hides the item, 0 greys it. */
const COMMAND_STATE = { hidden: -1, disabled: 0, enabled: 1 };

/** TQueueOperation (QueueController.h) — the ones a user can invoke. */
const QUEUE_OPERATIONS = {
  none: 'none',
  preferences: 'preferences',
  goTo: 'goTo',
  onceEmpty: 'onceEmpty',
  itemUserAction: 'itemUserAction',
  itemQuery: 'itemQuery',
  itemError: 'itemError',
  itemPrompt: 'itemPrompt',
  itemExecute: 'itemExecute',
  itemDelete: 'itemDelete',
  itemUp: 'itemUp',
  itemDown: 'itemDown',
  itemPause: 'itemPause',
  itemResume: 'itemResume',
  itemSpeed: 'itemSpeed',
  pauseAll: 'pauseAll',
  resumeAll: 'resumeAll',
  deleteAllDone: 'deleteAllDone',
  deleteAll: 'deleteAll',
};

/** The queue-item states this module reasons about (queue.js STATES). */
const QUEUE_ITEM_STATES = {
  pending: 'pending',
  active: 'active',
  paused: 'paused',
  query: 'query',
  prompt: 'prompt',
  error: 'error',
  done: 'done',
  cancelled: 'cancelled',
};

/** TSelectMode (NortonLikeListView.pas). */
const SELECT_MODES = { all: 'all', none: 'none', invert: 'invert' };

/** Options passed into the copy dialog (co* in CustomScpExplorer.h). */
const COPY_OPTIONS = {
  temp: 'temp',
  disableQueue: 'disableQueue',
  doNotShowAgain: 'doNotShowAgain',
  shortCutHint: 'shortCutHint',
  allFiles: 'allFiles',
};

/** Flags for ExecuteCopyOperationCommand (coc* in CustomScpExplorer.h). */
const COPY_COMMAND_FLAGS = {
  shortCutHint: 'shortCutHint',
  queue: 'queue',
  nonQueue: 'nonQueue',
};

/** TDirectRemoteCopy — how much the remote-copy dialog may offer. */
const DIRECT_REMOTE_COPY = {
  disallow: 'disallow',
  allow: 'allow',
  confirmCommandSession: 'confirmCommandSession',
  confirmCommandSessionDirs: 'confirmCommandSessionDirs',
};

/** TAutoSwitch, for the tri-state DDTransferConfirmation and Param.Queue. */
const AUTO_SWITCH = { on: 'on', off: 'off', auto: 'auto' };

// ---------------------------------------------------------------------------
// Errors — WinSCP raises these and the UI shows the text verbatim
// ---------------------------------------------------------------------------

/** EAbort. WinSCP uses it as "the user said no"; it is never an error report. */
class AbortError extends Error {
  constructor(message) {
    super(message || 'Operation cancelled.');
    this.name = 'AbortError';
    this.aborted = true;
  }
}

/** NotSupported() — the operation is impossible on this protocol, full stop. */
class NotSupportedError extends Error {
  constructor(message) {
    super(message || 'The operation is not supported.');
    this.name = 'NotSupportedError';
    this.code = 'NOT_SUPPORTED';
  }
}

/**
 * Raised by the default `ask` channel. It is deliberately loud: an unwired
 * confirmation must never look like a silent yes or a silent no.
 */
class ConfirmationUnavailableError extends Error {
  constructor(request) {
    super('No confirmation channel is wired, so "' +
      String((request && request.name) || 'this operation') +
      '" cannot ask the user and will not proceed.');
    this.name = 'ConfirmationUnavailableError';
    this.request = request;
  }
}

// ---------------------------------------------------------------------------
// Message text — the strings from resource/TextsWin1.rc, verbatim
// ---------------------------------------------------------------------------

const TEXTS = {
  confirmDeleteFile: (name) => `Are you sure you want to delete file '${name}'?`,
  confirmDeleteFiles: (n) => `Are you sure you want to delete ${n} selected files?`,
  confirmRecycleFile: (name) => `Are you sure you want to move file '${name}' to recycle bin?`,
  confirmRecycleFiles: (n) => `Are you sure you want to move ${n} selected files to recycle bin?`,
  pendingQueueItems:
    'There are still some background transfers in queue. Do you want to disconnect anyway?\n \n' +
    "Warning: Pressing 'OK' will terminate all transfers immediately.",
  performOnCommandSession: (protocol) =>
    'Do you want to open a separate shell session?\n\n' +
    `Current ${protocol} session does not support command you request. A separate shell session may be ` +
    'opened to process the command.\n \nNote: The server must provide Unix-like shell and the shell must ' +
    `use same path syntax as current ${protocol} session.`,
  closeSession: (name) => `Terminate session '${name}' and close application?`,
  closeSessionWorkspace: (name) =>
    `Terminate session '${name}' and close application without saving a workspace?`,
  closeSessions: 'Terminate all sessions and close application?',
  closeSessionsWorkspace: 'Terminate all sessions and close application without saving a workspace?',
  closeWorkspace: 'Close application without saving a workspace?',
  autoWorkspace: (name) => `Workspace '${name}' will be automatically saved.`,
  autoWorkspaceEnable: "Press 'No' to enable automatic saving of the workspace.",
  pendingEditors:
    'There are some opened files. Please close them before exiting application.\n \n' +
    'Beware: If you ignore this message, opened files may remain in temporary directory.',
  syncDirBrowseCreate: (path) =>
    `Do you want to try to create directory '${path}'?\n\nCannot open corresponding directory in the opposite panel.`,
  syncDirBrowseError:
    'Cannot open corresponding directory in the opposite panel. Directory browsing synchronisation failed. ' +
    'It has been turned off.',
  compareNoDifferences: 'No differences found.',
  ddTransferConfirmOff:
    'Transfer confirmation turned off\n\nYou have opted not to see the Transfer options dialog the next ' +
    'time. Click here to undo.',
  customCommandImpossible: (command) =>
    `Custom command '${command}' cannot be executed right now. You may need to select files for the ` +
    'command or open a session first.',
  unsafeSession:
    'Use potentially unsafe session settings?\nThe provided session URL contains potentially unsafe ' +
    'settings. Proceed only if you trust its source.',
  copyParamAutoSelected: (name) => `Transfer settings preset '${name}' was automatically selected.`,
  copyParamDefaultCustom: (name) => `Returned back to transfer settings preset '${name}'.`,
  copyParamDefaultNorm: 'Returned back to default transfer settings.',
  copyParamRule: (info) => `Autoselection rule:\n${info}`,
  tooManyWatchDirectories: (max) =>
    `More than ${max} directories and subdirectories found. Watching for changes in large number of ` +
    'directories can significantly degrade performance of the computer.\n \n' +
    `Do you want to scan for another up to ${max} directories?`,
  errorListCount: (n) => `${n} error(s) occurred during last operation. Do you want to see it/them?`,
  errorListNumber: (i, n, message) => `Error ${i} of ${n}:\n${message}`,
  alreadyEditedExternally: (name) =>
    `The file '${name}' is already opened in external editor (application) or is being uploaded.`,
  createFileError: (name) => `Can't create file '${name}'.`,
  synchronizeComplete: 'Synchronization was completed.',
  newFolder: 'New folder',
  newFile: 'New file',
  nothingSelected: 'No files are selected.',
  noSession: 'There is no open session.',
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const ANY_MASK = '*.*';

/**
 * DelimitFileNameMask (core/FileMasks.cpp:120). A file name used as a *mask*
 * has to have its wildcard characters escaped, or renaming "a?b.txt" would
 * silently become a pattern that matches other files.
 */
function delimitFileNameMask(mask) {
  let out = '';
  for (const ch of String(mask == null ? '' : mask)) {
    if (ch === '\\' || ch === '*' || ch === '?') out += '\\';
    out += ch;
  }
  return out;
}

function unixIncludeTrailingSlash(p) {
  const s = String(p == null ? '' : p);
  if (!s) return '/';
  return s.endsWith('/') ? s : `${s}/`;
}

function unixExcludeTrailingSlash(p) {
  const s = String(p == null ? '' : p);
  if (s.length > 1 && s.endsWith('/')) return s.replace(/\/+$/, '') || '/';
  return s;
}

function unixExtractFileName(p) {
  const s = unixExcludeTrailingSlash(String(p == null ? '' : p));
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function unixExtractFilePath(p) {
  const s = String(p == null ? '' : p);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i + 1);
}

function includeTrailingBackslash(p) {
  const s = String(p == null ? '' : p);
  if (!s) return s;
  return /[\\/]$/.test(s) ? s : `${s}\\`;
}

function excludeTrailingBackslash(p) {
  const s = String(p == null ? '' : p);
  if (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) return s.replace(/[\\/]+$/, '');
  return s;
}

/** Case-insensitive local path comparison — SamePaths(). */
function sameLocalPath(a, b) {
  return excludeTrailingBackslash(String(a || '')).replace(/\//g, '\\').toLowerCase()
    === excludeTrailingBackslash(String(b || '')).replace(/\//g, '\\').toLowerCase();
}

/** UnixSamePath() — remote paths are case sensitive. */
function sameUnixPath(a, b) {
  return unixExcludeTrailingSlash(String(a || '')) === unixExcludeTrailingSlash(String(b || ''));
}

/**
 * ExtractCommonPath / UnixExtractCommonPath. Returns '' when the paths share
 * no root at all, which is what makes synchronized browsing give up instead of
 * inventing a mapping.
 */
function extractCommonPath(paths, unix) {
  const list = (paths || []).map((p) => String(p || ''));
  if (!list.length) return '';
  const sep = unix ? '/' : '\\';
  const split = (p) => (unix ? p : p.replace(/\//g, '\\')).split(sep);
  const first = split(list[0]);
  let common = first.length;
  for (const p of list.slice(1)) {
    const parts = split(p);
    let i = 0;
    const cmp = unix ? ((a, b) => a === b) : ((a, b) => a.toLowerCase() === b.toLowerCase());
    while (i < common && i < parts.length && cmp(first[i], parts[i])) i++;
    common = i;
  }
  if (common <= 0) return '';
  const joined = first.slice(0, common).join(sep);
  if (!joined) return unix ? '/' : '';
  return joined;
}

/** WinSCP's isTransferOperation: only copy and move move bytes. */
function isTransferOperation(operation) {
  return operation === OPERATIONS.copy || operation === OPERATIONS.move;
}

function normalizeTriState(v) {
  return shellintegration.normalizeTriState(v);
}

/**
 * `IsCapable[fc...]` for a session facade. A real Terminal answers for itself;
 * a bare capability object is answered through Terminal's own mapping table so
 * there is exactly one place that decides what a capability means.
 */
function isCapable(session, capability) {
  if (!session) return false;
  if (typeof session.isCapable === 'function') return !!session.isCapable(capability);
  return Terminal.prototype.isCapable.call({ adapter: { caps: session.caps || {} } }, capability);
}

/**
 * TFileCustomCommand::IsSessionCommand (core/FileMasks.cpp:1439) — does the
 * command expand anything that can only come FROM a session?
 *
 *   IsSiteCommand      !@ (host)  !S (session name)  !E (…)
 *   IsPasswordCommand  !p
 *   plus               !U (user)  !# (port)  !N (name)  !/ (remote directory)
 *
 * customcmd.isSiteCommand is a different predicate — it means "has patterns but
 * touches no files" — so it answers `false` for a FILE command that also uses
 * session patterns, which is exactly the case CustomCommandState must disable.
 */
const SESSION_PATTERN_CHARS = ['@', 'S', 'E', 'p', 'U', '#', 'N', '/'];

function isSessionCommand(command, options) {
  return SESSION_PATTERN_CHARS.some((ch) => customcmd.findPattern(command, ch, options));
}

/**
 * TInteractiveCustomCommand::Complete(cmd, false) — the pass that removes the
 * interactive patterns before the file patterns are counted. A prompt's text
 * can contain a bare `!`, and without this pass a command like
 * `echo "!?Really!?y!"` would be mistaken for a file command.
 */
function stripInteractivePatterns(command, local) {
  let tokens;
  try {
    tokens = customcmd.tokenize(command, { local: !!local });
  } catch {
    // An unterminated pattern is a broken command; the caller's validate() is
    // what reports it. For the purpose of "is this a file command" treat the
    // text as-is rather than throwing out of a predicate.
    return String(command == null ? '' : command);
  }
  let out = '';
  for (const t of tokens) {
    if (t.kind === customcmd.PROMPT) {
      out += customcmd.parsePromptPattern(t.text).default;
    } else if (t.kind === customcmd.EXEC) {
      // TCustomCommand::Execute's base implementation yields nothing.
      out += '';
    } else {
      out += t.text;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PanelState — "what is selected, and what does that mean"
// ---------------------------------------------------------------------------

function normalizeEntry(e) {
  const raw = e || {};
  const name = String(raw.name == null ? '' : raw.name);
  const isParentDirectory = name === '..';
  return {
    name,
    isParentDirectory,
    isDirectory: isParentDirectory || raw.isDirectory === true || raw.type === 'dir',
    isSymLink: raw.isSymLink === true || raw.isSymlink === true || raw.type === 'link',
    linkTo: String(raw.linkTo || raw.target || ''),
    size: Number(raw.size) || 0,
    modification: raw.modification === undefined ? raw.modified : raw.modification,
    rights: raw.rights,
    owner: raw.owner,
    group: raw.group,
    data: raw,
  };
}

/**
 * One panel, as the orchestration layer needs to see it: a path, a list, a
 * selection, a focused item, and whether it has the keyboard focus. This is
 * TCustomDirView's *model*, not its view — the parts CustomScpExplorer.cpp
 * actually consults.
 */
class PanelState {
  constructor(spec) {
    const s = spec || {};
    this.side = s.side === SIDES.local ? SIDES.local : SIDES.remote;
    // In the commander interface the left panel is the local browser; in a
    // local-local workspace BOTH panels are. `local` is therefore its own flag
    // rather than being derived from the side.
    this.local = s.local === undefined ? this.side === SIDES.local : !!s.local;
    this.path = String(s.path || '');
    this.entries = (s.entries || []).map(normalizeEntry);
    // CanChangeSelection (CustomDirView.pas:2515) refuses the parent entry, so
    // '..' can never BE selected — dropping it here rather than only filtering
    // it out later means no caller can hand us a selection that would ask the
    // server to delete the directory above.
    this.selectedNames = new Set([...(s.selected || s.selectedNames || [])]
      .filter((n) => String(n) !== '..'));
    this.focusedName = s.focusedName === undefined || s.focusedName === null ? null : String(s.focusedName);
    this.hasFocus = !!s.hasFocus;
    // GetForegroundWindow() in AnyFileSelected. There is no window here, so the
    // caller states whether the app is frontmost; it defaults to true because
    // a headless caller is by definition the one driving.
    this.foreground = s.foreground !== false;
    this.enabled = s.enabled !== false;
    this.mask = String(s.mask || '');
    this._savedSelection = null;
    this._savedNames = null;
  }

  /** Everything except '..' — WinSCP's FilesCount. */
  get files() { return this.entries.filter((e) => !e.isParentDirectory); }
  get filesCount() { return this.files.length; }

  entryByName(name) {
    if (name === null || name === undefined) return null;
    const n = String(name);
    return this.entries.find((e) => e.name === n) || null;
  }

  itemFocused() { return this.entryByName(this.focusedName); }

  /** TUnixDirView::ItemIsFile — '..' is not a file, everything else is. */
  itemIsFile(entry) { return !!entry && !entry.isParentDirectory; }
  itemIsDirectory(entry) { return !!entry && entry.isDirectory; }

  /** The selection, with '..' excluded — it can never enter it (CanChangeSelection). */
  get selection() {
    return this.entries.filter((e) => !e.isParentDirectory && this.selectedNames.has(e.name));
  }

  get selCount() { return this.selection.length; }

  /** FFilesSelected — selected entries that are not directories. */
  get filesSelected() { return this.selection.filter((e) => !e.isDirectory).length; }

  fullPathOf(entry) {
    if (!entry) return '';
    if (this.local) return nodePath.win32.join(this.path || '', entry.name);
    return unixIncludeTrailingSlash(this.path) + entry.name;
  }

  /**
   * TCustomDirView::AnyFileSelected (CustomDirView.pas:2483) — reproduced
   * exactly, including the clause everyone misreads: when nothing is selected
   * the FOCUSED item counts, but only if this panel has the focus AND the
   * window is frontmost. That is what stops a toolbar button acting on an item
   * the user cannot see is highlighted.
   */
  anyFileSelected(onlyFocused, filesOnly, focusedFileOnlyWhenFocused) {
    if (onlyFocused
        || (this.selCount === 0
            && (!focusedFileOnlyWhenFocused || (this.hasFocus && this.foreground)))) {
      const item = this.itemFocused();
      return !!item && this.itemIsFile(item) && (!filesOnly || !this.itemIsDirectory(item));
    }
    if (filesOnly) return this.filesSelected > 0;
    return this.selCount > 0;
  }

  /** TCustomDirView::OperateOnFocusedFile (CustomDirView.pas:2314). */
  operateOnFocusedFile(focused, onlyFocused) {
    const item = this.itemFocused();
    if (!item) return false;
    return (focused && !this.selectedNames.has(item.name)) || this.selCount === 0 || !!onlyFocused;
  }

  /**
   * TCustomDirView::CustomCreateFileList. Returns entries, not strings, because
   * every caller here needs both the name and the object behind it — WinSCP
   * carries the TRemoteFile in TStrings::Objects for the same reason.
   */
  createFileList(options) {
    const o = options || {};
    const fullPath = o.fullPath === undefined ? this.local : !!o.fullPath;
    const out = [];
    const add = (entry) => {
      if (!entry) return;
      out.push({
        name: entry.name,
        path: fullPath ? this.fullPathOf(entry) : entry.name,
        fullPath: this.fullPathOf(entry),
        entry,
      });
    };
    if (this.operateOnFocusedFile(!!o.focused, !!o.onlyFocused)) {
      add(this.itemFocused());
    } else {
      for (const e of this.selection) add(e);
    }
    return out;
  }

  /** CreateFocusedFileList — always exactly the focused item. */
  createFocusedFileList(fullPath) {
    return this.createFileList({ onlyFocused: true, fullPath });
  }

  /** SelectedAllFilesInDirView — SelCount == FilesCount. */
  selectedAllFiles() {
    return this.filesCount > 0 && this.selCount === this.filesCount;
  }

  // -- selection bookkeeping -------------------------------------------------
  // WinSCP saves the selection before a destructive operation so it can put it
  // back afterwards; a failed operation *discards* the saved copy instead, so
  // the user is not left with a stale highlight over files that no longer
  // exist. Both halves are ported because the asymmetry is the point.

  saveSelection() { this._savedSelection = new Set(this.selectedNames); return this; }
  saveSelectedNames() { this._savedNames = [...this.selectedNames]; return this; }
  discardSavedSelection() { this._savedSelection = null; return this; }

  restoreSelection() {
    if (this._savedSelection) {
      const present = new Set(this.entries.map((e) => e.name));
      this.selectedNames = new Set([...this._savedSelection].filter((n) => present.has(n)));
      this._savedSelection = null;
    }
    return this;
  }

  restoreSelectedNames() {
    if (this._savedNames) {
      const present = new Set(this.files.map((e) => e.name));
      this.selectedNames = new Set(this._savedNames.filter((n) => present.has(n)));
    }
    return this;
  }

  selectAll(mode) {
    for (const e of this.entries) {
      if (e.isParentDirectory) continue;         // CanChangeSelection refuses it
      if (mode === SELECT_MODES.all) this.selectedNames.add(e.name);
      else if (mode === SELECT_MODES.none) this.selectedNames.delete(e.name);
      else if (mode === SELECT_MODES.invert) {
        if (this.selectedNames.has(e.name)) this.selectedNames.delete(e.name);
        else this.selectedNames.add(e.name);
      }
    }
    return this;
  }

  selectFiles(predicate, select) {
    let changed = 0;
    for (const e of this.entries) {
      if (e.isParentDirectory) continue;
      if (!predicate(e)) continue;
      const was = this.selectedNames.has(e.name);
      if (select && !was) { this.selectedNames.add(e.name); changed++; }
      else if (!select && was) { this.selectedNames.delete(e.name); changed++; }
    }
    return changed;
  }

  /** The extension of a name, by the side's own rules. '.bashrc' is all extension. */
  extensionOf(name) {
    const n = String(name || '');
    if (this.local) {
      const ext = nodePath.win32.extname(n);
      return ext;
    }
    return guitools.unixExtractFileExt ? guitools.unixExtractFileExt(n) : (n.includes('.') ? n.slice(n.lastIndexOf('.')) : '');
  }

  /**
   * SelectSameExt (CustomScpExplorer.cpp:9366). A file with no extension gets
   * the mask "*." so "same extension" means "also has none" rather than "*",
   * which would select everything.
   */
  selectSameExt(select) {
    const item = this.itemFocused();
    if (!item) return { mask: null, changed: 0 };
    let ext = this.extensionOf(item.name);
    if (!ext) ext = '.';
    const mask = `*${ext}`;
    const suffix = ext === '.' ? '' : ext;
    const changed = this.selectFiles(
      (e) => !e.isDirectory && (suffix ? e.name.toLowerCase().endsWith(suffix.toLowerCase())
        : !this.extensionOf(e.name)),
      select);
    return { mask, changed };
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The default confirmation channel. It throws, on purpose — see the header.
 */
function defaultAsk(request) {
  throw new ConfirmationUnavailableError(request);
}

/**
 * ExplorerShell — everything CustomScpExplorer.cpp does that is not drawing.
 *
 * Dependencies (all optional; each has a safe default so the class can be
 * constructed and tested headlessly):
 *
 *   config       WinConfiguration-like: `.prefs`, `.currentCopyParam`,
 *                `.copyParamList`, `.copyParamCurrent`, `.autoSelectPreset()`
 *   ask          async (request) => answer. Answers: 'ok' | 'cancel' | 'yes' |
 *                'no' | 'ignore' | 'neverAskAgain'.
 *   note         (note) => void — the non-blocking corner notes (PostNote).
 *   panels       (side) => PanelState | null
 *   session      () => the active session facade, or null
 *   sessions     () => every managed session facade
 *   setActiveSession (session) => void
 *   queue        the transfer queue (queue.js TransferQueue) or a facade
 *   ops          the doing half: copyToRemote / copyToLocal / deleteFiles /
 *                deleteLocalFiles / moveFiles / copyFiles / lockFiles /
 *                unlockFiles / setProperties / createDirectory /
 *                loadFilesProperties / calculateChecksum / connect
 *   copyDialog   async (request) => { ok, targetDirectory, copyParam, doNotShowAgain }
 *   editors      { canAddFile(...) } — the open-editor registry
 *   clipboard    { text(), files() }
 */
/** Pure target policy shared by IPC and the headless drag/drop simulator. */
function resolveDropTarget(spec) {
  const s = spec || {};
  if (s.ontoQueueView) {
    const directory = String(s.defaultDownloadTarget || '').trim();
    if (!directory) return { ok: false, forceQueue: false, counterName: 'DownloadsDragDropQueueTargetUnknown' };
    return { ok: true, directory, forceQueue: true, counterName: 'DownloadsDragDropQueue' };
  }
  const fakeFileTarget = String(s.fakeFileDropTarget || '').trim();
  if (fakeFileTarget) return {
    ok: true, directory: excludeTrailingBackslash(nodePath.win32.dirname(fakeFileTarget)),
    forceQueue: false, counterName: 'DownloadsDragDropFakeFile',
  };
  const externalDirectory = String(s.externalDropDirectory || '').trim();
  if (externalDirectory) return {
    ok: true, directory: excludeTrailingBackslash(externalDirectory),
    forceQueue: false, counterName: 'DownloadsDragDropExternalExt',
  };
  return { ok: false, forceQueue: false, counterName: 'DownloadsDragDropExternalExtTargetUnknown' };
}

class ExplorerShell {
  constructor(deps) {
    const d = deps || {};
    this.config = d.config || null;
    this.ask = d.ask || defaultAsk;
    this.note = d.note || (() => {});
    this._panels = d.panels || (() => null);
    this._session = d.session || (() => null);
    this._sessions = d.sessions || (() => []);
    this._setActiveSession = d.setActiveSession || (() => {});
    this.queue = d.queue || null;
    this.ops = d.ops || {};
    this.copyDialog = d.copyDialog || null;
    this.editors = d.editors || null;
    this.clipboard = d.clipboard || null;
    this.now = d.now || (() => new Date());

    /** FCurrentSide — which panel a `current` side resolves to. */
    this.currentSide = d.currentSide === SIDES.local ? SIDES.local : SIDES.remote;
    /** Whether both panels are local (the commander's local-local workspace). */
    this.localBrowserMode = !!d.localBrowserMode;
    /** Whether a second, local panel exists at all (commander vs explorer). */
    this.supportsLocalBrowser = d.supportsLocalBrowser !== false;

    /** FCopyParamAutoSelected / FCopyParamDefault — TransferPresetAutoSelect state. */
    this.copyParamAutoSelected = '';
    this.copyParamDefault = d.copyParamDefault || '';
    /** FAllowTransferPresetAutoSelect — suppressed while browsing is synchronized. */
    this.allowTransferPresetAutoSelect = d.allowTransferPresetAutoSelect !== false;
    /** FSynchronisingBrowse — re-entrancy guard for synchronized browsing. */
    this.synchronisingBrowse = false;
    /** The synchronized-browsing toggle itself. */
    this.synchronizeBrowsing = !!d.synchronizeBrowsing;
    /** FPrevPath[2] — the path each panel was showing before the last change. */
    this.prevPath = { local: '', remote: '' };
    /** FLastCustomCommand. */
    this.lastCustomCommand = d.lastCustomCommand || null;
    /** FForceExecution — "Open" was chosen explicitly, so do not re-resolve. */
    this.forceExecution = false;
  }

  // ======================================================================
  // configuration access
  // ======================================================================

  get prefs() { return (this.config && this.config.prefs) || {}; }

  pref(name, fallback) {
    const p = this.prefs;
    return Object.prototype.hasOwnProperty.call(p, name) && p[name] !== undefined ? p[name] : fallback;
  }

  setPref(name, value, label) {
    if (this.config && typeof this.config.config === 'object' && this.config.config
        && typeof this.config.config.setPref === 'function') {
      this.config.config.setPref(name, value, label);
    } else if (this.config && typeof this.config.setPref === 'function') {
      this.config.setPref(name, value, label);
    }
    if (this.config && this.config.prefs) this.config.prefs[name] = value;
    return value;
  }

  /** GUIConfiguration->CurrentCopyParam. */
  currentCopyParam() {
    if (this.config && typeof this.config.currentCopyParam === 'object') {
      return { ...this.config.currentCopyParam };
    }
    if (this.config && typeof this.config.currentCopyParam === 'function') {
      return { ...this.config.currentCopyParam() };
    }
    return { ...(this.pref('copyParam', {}) || {}) };
  }

  // ======================================================================
  // sides and panels
  // ======================================================================

  /** TCustomScpExplorerForm::GetSide. */
  getSide(side) {
    if (side === undefined || side === null || side === SIDES.current) return this.currentSide;
    if (side === SIDES.other) return this.currentSide === SIDES.local ? SIDES.remote : SIDES.local;
    return side === SIDES.local ? SIDES.local : SIDES.remote;
  }

  /**
   * GetOtherSide. WinSCP *aborts* when asked for the other side of something
   * that is neither local nor "other" — there is no third panel to fall back
   * to, and guessing would act on the wrong files.
   */
  getOtherSide(side) {
    const resolved = this.getSide(side);
    if (resolved === SIDES.local) return SIDES.remote;
    if (resolved === SIDES.remote) return SIDES.local;
    throw new AbortError('There is no opposite panel for this side.');
  }

  /** IsSideLocalBrowser — is this side showing the local file system? */
  isSideLocalBrowser(side) {
    if (this.localBrowserMode) return true;
    const resolved = this.getSide(side);
    if (resolved === SIDES.local) return true;
    const panel = this._panels(resolved);
    return !!(panel && panel.local);
  }

  /** GetHasDirView — the explorer interface has no local panel at all. */
  hasDirView(side) {
    const resolved = this.getSide(side);
    if (resolved === SIDES.local && !this.supportsLocalBrowser) return false;
    return !!this._panels(resolved);
  }

  panel(side) { return this._panels(this.getSide(side)); }

  /** DirViewEnabled — a remote panel with no session is dead. */
  dirViewEnabled(side) {
    const resolved = this.getSide(side);
    if (this.isSideLocalBrowser(resolved)) return this.hasDirView(resolved);
    return this.hasAvailableTerminal();
  }

  session() { return this._session(); }

  /** HasAvailableTerminal — a session object exists AND it is usable. */
  hasAvailableTerminal() {
    const s = this.session();
    return !!s && s.active !== false && !s.localBrowser;
  }

  requireSession() {
    const s = this.session();
    if (!s) throw new NotSupportedError(TEXTS.noSession);
    return s;
  }

  capable(capability) { return isCapable(this.session(), capability); }

  /**
   * fcBackgroundTransfers (Terminal.cpp:2335) is not a protocol property at
   * all — it is `!IsEncryptingFiles()`. A queued transfer runs on a second
   * connection, and a second connection would have to re-derive the file
   * encryption, so WinSCP simply refuses the queue while encryption is on.
   */
  canBackgroundTransfer(session) {
    const s = session === undefined ? this.session() : session;
    if (!s) return false;
    if (s.backgroundTransfers === false) return false;
    return !s.encryptingFiles;
  }

  /**
   * fcNewerOnlyUpload. True for SFTP and FTP, false for SCP, S3 and WebDAV
   * (SftpFileSystem.cpp:2101, FtpFileSystem.cpp:1945, ScpFileSystem.cpp:442,
   * S3FileSystem.cpp:1245, WebDAVFileSystem.cpp:652).
   *
   * No adapter here declares it yet, so the protocol table below stands in.
   * An adapter that sets `caps.newerOnlyUpload` wins over it — the table is a
   * bridge, not a second source of truth.
   */
  canNewerOnlyUpload(session) {
    const s = session === undefined ? this.session() : session;
    if (!s) return false;
    const caps = s.caps || {};
    if (typeof caps.newerOnlyUpload === 'boolean') return caps.newerOnlyUpload;
    const protocol = String(s.protocol || '').toLowerCase();
    return protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps';
  }

  /**
   * fcTimestampChanging — can the protocol set a REMOTE file's timestamp after
   * the fact? That is a different question from fcPreservingTimestampUpload
   * (can an upload carry the source timestamp), and the two disagree on most
   * protocols: SCP preserves on upload but cannot change afterwards
   * (ScpFileSystem.cpp:443), and so do FTP (FtpFileSystem.cpp:1986), S3
   * (S3FileSystem.cpp:1246) and WebDAV (WebDAVFileSystem.cpp:653). Only SFTP
   * answers true (SftpFileSystem.cpp:2102).
   *
   * The synchronize dialog's "Timestamp" mode needs THIS one — offering it on
   * SCP would let the user start a synchronization whose only possible action
   * the protocol cannot perform. Terminal.isCapable has no mapping for it and
   * no adapter declares it, so the protocol table stands in until one does; an
   * adapter that sets `caps.timestampChanging` wins over it.
   */
  canChangeTimestamp(session) {
    const s = session === undefined ? this.session() : session;
    if (!s) return false;
    const caps = s.caps || {};
    if (typeof caps.timestampChanging === 'boolean') return caps.timestampChanging;
    return String(s.protocol || '').toLowerCase() === 'sftp';
  }

  /**
   * fcMoveToQueue — can a transfer that is already running in the foreground
   * be pushed into the background? SCP cannot (ScpFileSystem.cpp:448), because
   * it has no way to resume mid-stream.
   */
  canMoveToQueue(session) {
    const s = session === undefined ? this.session() : session;
    if (!s) return false;
    const caps = s.caps || {};
    if (typeof caps.moveToQueue === 'boolean') return caps.moveToQueue;
    return !!caps.resume;
  }

  /** GetEnableFocusedOperation — is the focused item a legal target? */
  enableFocusedOperation(side, filesOnly) {
    const panel = this.panel(side);
    if (!panel) return false;
    return panel.anyFileSelected(true, !!filesOnly, true);
  }

  /** GetEnableSelectedOperation — is there a selection (or a usable focus)? */
  enableSelectedOperation(side, filesOnly) {
    const panel = this.panel(side);
    if (!panel) return false;
    return panel.anyFileSelected(false, !!filesOnly, true);
  }

  /**
   * The file list an operation runs on, resolved the way ExecuteFileOperation
   * resolves it: full paths on the local side, bare names on the remote one
   * (because the remote list is relative to the panel's current directory).
   */
  createFileList(side, options) {
    const resolved = this.getSide(side);
    const panel = this.panel(resolved);
    if (!panel) return [];
    const o = options || {};
    return panel.createFileList({
      focused: !!o.onFocused,
      onlyFocused: !!o.onlyFocused,
      fullPath: o.fullPath === undefined ? this.isSideLocalBrowser(resolved) : !!o.fullPath,
    });
  }

  /**
   * ClearOperationSelection / ClearTransferSourceSelection. After a transfer is
   * pushed to the queue the source selection is dropped — the files are no
   * longer "pending an action" and leaving them highlighted invites the user to
   * queue them twice.
   */
  clearOperationSelection(side) {
    const panel = this.panel(side);
    if (panel) panel.selectAll(SELECT_MODES.none);
    return this;
  }

  clearTransferSourceSelection(direction) {
    return this.clearOperationSelection(direction === DIRECTIONS.toRemote ? SIDES.local : SIDES.remote);
  }

  // ======================================================================
  // confirmations
  // ======================================================================

  /**
   * One place asks. Every confirmation in this module goes through here so the
   * IPC layer has exactly one shape to render and one shape to answer.
   */
  async confirm(request) {
    const req = {
      kind: 'confirmation',
      buttons: ['ok', 'cancel'],
      neverAskAgain: false,
      ...request,
    };
    const answer = await this.ask(req);
    return String(answer == null ? 'cancel' : answer);
  }

  // ======================================================================
  // transfer parameter assembly — CopyParamDialog and friends
  // ======================================================================

  /**
   * GetDoNotShowCopyDialogDefault. Only drag and drop pre-ticks the box, and
   * only while the tri-state is still `auto` — once the user has made the
   * choice explicitly, WinSCP stops nudging.
   */
  getDoNotShowCopyDialogDefault(dragDrop) {
    return !!dragDrop && normalizeTriState(this.pref('dDTransferConfirmation', 'auto')) === AUTO_SWITCH.auto;
  }

  /**
   * HandleDoNotShowCopyDialogAgain. The `else` branch is the interesting half:
   * explicitly UNticking the box while the setting is `auto` promotes it to
   * `on`, so the dialog keeps appearing instead of drifting back to "maybe".
   */
  handleDoNotShowCopyDialogAgain(dragDrop, doNotShowAgain) {
    if (doNotShowAgain) {
      if (dragDrop) {
        if (normalizeTriState(this.pref('dDTransferConfirmation', 'auto')) === AUTO_SWITCH.auto) {
          // PopupTrayBalloon with an undo link. There is no tray here; the note
          // carries the same undo action so the user can still take it back.
          this.note({
            kind: 'information',
            name: 'ddTransferConfirmOff',
            message: TEXTS.ddTransferConfirmOff,
            undo: () => this.setPref('dDTransferConfirmation', AUTO_SWITCH.on,
              'Re-enabled the drag-and-drop transfer confirmation'),
          });
        }
        this.setPref('dDTransferConfirmation', AUTO_SWITCH.off,
          'Turned off the drag-and-drop transfer confirmation');
      } else {
        this.setPref('confirmTransferring', false, 'Turned off the transfer confirmation');
      }
    } else if (dragDrop && normalizeTriState(this.pref('dDTransferConfirmation', 'auto')) === AUTO_SWITCH.auto) {
      this.setPref('dDTransferConfirmation', AUTO_SWITCH.on,
        'Kept the drag-and-drop transfer confirmation');
    }
    return this;
  }

  /**
   * CopyParamDialog (CustomScpExplorer.cpp:1298).
   *
   * Assembles everything the transfer-options dialog needs, shows it when the
   * caller asked for confirmation and the preference allows it, and then makes
   * the one decision that surprises people: when the resulting copy parameters
   * say "queue", the operation is handed to the queue and the *foreground*
   * transfer is refused — `proceed` comes back false even though the user
   * pressed OK. That is not an error, and the caller must not treat it as one.
   *
   * Returns { proceed, queued, targetDirectory, copyParam, params }.
   */
  async copyParamDialog(spec) {
    const s = spec || {};
    const direction = s.direction;
    const type = s.type || TRANSFER_TYPES.copy;
    const temp = !!s.temp;
    const dragDrop = !!s.dragDrop;
    const files = s.files || [];
    const session = this.requireSession();

    let targetDirectory = String(s.targetDirectory || '');
    let copyParam = { ...(s.copyParam || this.currentCopyParam()) };

    // Known before the dialog: a move deletes the source once it lands.
    const params = { delete: type === TRANSFER_TYPES.move };
    const toTemp = temp && direction === DIRECTIONS.toLocal;

    let proceed = true;

    if (s.confirm !== false && this.pref('confirmTransferring', true) !== false) {
      // "Newer only" cannot mean anything when the target is a scratch folder,
      // and an upload cannot use it unless the protocol can compare timestamps.
      const disableNewerOnly =
        (!this.canNewerOnlyUpload(session) && direction === DIRECTIONS.toRemote) || toTemp;

      const options = { ...(s.options || {}) };
      if (toTemp) options[COPY_OPTIONS.temp] = true;
      // fcBackgroundTransfers: the "transfer in background" checkbox is
      // disabled when the queue genuinely cannot take the transfer.
      if (!this.canBackgroundTransfer(session)) options[COPY_OPTIONS.disableQueue] = true;
      options[COPY_OPTIONS.doNotShowAgain] = true;

      const usable = typeof session.usableCopyParamAttrs === 'function'
        ? session.usableCopyParamAttrs(params)
        : { general: {}, upload: {}, download: {} };
      const copyParamAttrs = {
        ...(direction === DIRECTIONS.toRemote ? usable.upload : usable.download),
        ...(disableNewerOnly ? { noNewerOnly: true } : {}),
      };

      const request = {
        toRemote: direction === DIRECTIONS.toRemote,
        move: type === TRANSFER_TYPES.move,
        files,
        targetDirectory,
        copyParam,
        options,
        copyParamAttrs,
        outputOptions: { doNotShowAgain: this.getDoNotShowCopyDialogDefault(dragDrop) },
        sessionData: session.sessionData || null,
      };

      if (!this.copyDialog) {
        // Same reasoning as the default `ask`: an unwired dialog must not read
        // as "the user cancelled". Transfers would then simply stop happening
        // and nothing would say why.
        throw new ConfirmationUnavailableError({ name: 'copyParamDialog' });
      }
      const result = await this.copyDialog(request);

      proceed = !!(result && result.ok);
      if (proceed) {
        if (result.targetDirectory !== undefined) targetDirectory = String(result.targetDirectory);
        if (result.copyParam) copyParam = { ...copyParam, ...result.copyParam };
        this.handleDoNotShowCopyDialogAgain(dragDrop, !!result.doNotShowAgain);
      }
    }

    // The queue branch. A temporary download (editing a remote file) is never
    // queued, because the caller is about to open the file it is waiting for.
    let queued = false;
    if (proceed && copyParam.queue && !toTemp && this.canBackgroundTransfer(session)) {
      if (copyParam.queueNoConfirmation) params.noConfirmation = true;
      await this.addQueueItem({ direction, files, targetDirectory, copyParam, params });
      this.clearTransferSourceSelection(direction);
      queued = true;
      proceed = false;
    }

    return { proceed, queued, targetDirectory, copyParam, params };
  }

  /**
   * AddQueueItem. The include/exclude mask is rooted differently for each
   * direction — the roots are what makes a relative mask like `/sub/*.txt`
   * mean the same thing on both ends.
   */
  async addQueueItem(spec) {
    const s = spec || {};
    if (!this.queue || typeof this.queue.add !== 'function') {
      throw new NotSupportedError('There is no transfer queue to add to.');
    }
    const session = this.session();
    const files = (s.files || []).map((f) => (typeof f === 'string' ? f : (f.path || f.name)));
    const copyParam = { ...(s.copyParam || {}) };
    copyParam.includeFileMaskRoots = s.direction === DIRECTIONS.toRemote
      ? { source: files, target: s.targetDirectory }
      : { source: s.targetDirectory, target: files };

    const item = await this.queue.add({
      sessionId: session ? session.id : undefined,
      direction: s.direction === DIRECTIONS.toRemote ? 'upload' : 'download',
      files,
      target: s.targetDirectory,
      copyParam,
      params: s.params || {},
      parallel: !!copyParam.queueParallel,
    });
    return item;
  }

  /**
   * ExecuteCopyOperationCommand (CustomScpExplorer.cpp:3164) — the flag
   * assembly behind Copy (F5) and its queue variants. `cocShortCutHint` is
   * dropped outside the commander interface with explorer-style shortcuts,
   * because the hint names a key that is not bound there.
   */
  copyOperationParams(side, flags) {
    const set = new Set(flags || []);
    const iface = String(this.pref('interface', 'commander'));
    const explorerShortcuts = !!((this.pref('scpCommander', {}) || {}).explorerKeyboardShortcuts);
    if (iface !== 'commander' || explorerShortcuts) set.delete(COPY_COMMAND_FLAGS.shortCutHint);

    const panel = this.panel(side);
    const options = {};
    if (set.has(COPY_COMMAND_FLAGS.shortCutHint)) options[COPY_OPTIONS.shortCutHint] = true;
    if (panel && panel.selectedAllFiles()) options[COPY_OPTIONS.allFiles] = true;

    const param = { options };
    if (set.has(COPY_COMMAND_FLAGS.queue)) param.queue = AUTO_SWITCH.on;
    else if (set.has(COPY_COMMAND_FLAGS.nonQueue)) param.queue = AUTO_SWITCH.off;
    return param;
  }

  /**
   * ExecuteCopyMoveFileOperation (CustomScpExplorer.cpp:2796) — the entry
   * point behind F5/F6 and every drop.
   */
  async executeCopyMoveFileOperation(operation, side, files, noConfirmation, param) {
    if (this.localBrowserMode) {
      throw new NotSupportedError('A local-to-local copy does not go through the remote transfer path.');
    }
    const resolved = this.getSide(side);
    const direction = resolved === SIDES.local ? DIRECTIONS.toRemote : DIRECTIONS.toLocal;
    const type = operation === OPERATIONS.copy ? TRANSFER_TYPES.copy : TRANSFER_TYPES.move;
    const p = param || {};

    const copyParam = this.currentCopyParam();
    // Param.Queue is a tri-state: `auto` keeps whatever the preset said, so a
    // preset that queues by default is not silently overridden by the caller.
    const queueSwitch = normalizeTriState(p.queue === undefined ? AUTO_SWITCH.auto : p.queue);
    if (queueSwitch === AUTO_SWITCH.on) copyParam.queue = true;
    else if (queueSwitch === AUTO_SWITCH.off) copyParam.queue = false;

    const decision = await this.copyParamDialog({
      direction,
      type,
      temp: !!p.temp,
      files,
      targetDirectory: p.targetDirectory,
      copyParam,
      confirm: !noConfirmation,
      dragDrop: !!p.dragDrop,
      options: p.options,
    });

    if (!decision.proceed) {
      // Queued counts as "the user said yes" for the caller's usage counters,
      // even though no foreground transfer happens.
      return { ok: decision.queued, queued: decision.queued, ...decision };
    }

    const panel = this.panel(resolved);
    if (panel) { panel.saveSelection(); panel.saveSelectedNames(); }
    let selectionRestored = false;

    const params = { ...decision.params };
    if (operation === OPERATIONS.move) params.delete = true;
    if (p.temp) params.temporary = true;

    try {
      if (resolved === SIDES.local) {
        await this._call('copyToRemote', files, decision.targetDirectory, decision.copyParam, params);
        if (operation === OPERATIONS.move && panel) { panel.restoreSelection(); selectionRestored = true; }
      } else {
        try {
          await this._call('copyToLocal', files, decision.targetDirectory, decision.copyParam, params);
        } finally {
          // WinSCP restores the selection in a __finally for a move, because the
          // source directory is reloaded whether or not the transfer finished.
          if (operation === OPERATIONS.move && panel) { panel.restoreSelection(); selectionRestored = true; }
        }
      }
    } finally {
      if (!selectionRestored && panel) panel.discardSavedSelection();
    }

    return { ok: true, queued: false, ...decision };
  }

  /**
   * ExecuteDeleteFileOperation (CustomScpExplorer.cpp:2945).
   *
   * The recycle decision is the part that must not be simplified: the
   * alternative flag INVERTS the site's preference, so the same key means
   * "delete permanently" for a user who recycles by default and "recycle" for
   * one who does not. And a file that is already in the recycle bin is deleted
   * outright — recycling it again would just move it inside the bin.
   */
  deleteDecision(side, files, alternative) {
    const resolved = this.getSide(side);
    const list = files || [];
    const local = this.isSideLocalBrowser(resolved);
    const alt = !!alternative;
    let recycle;
    if (local) {
      recycle = !!this.pref('deleteToRecycleBin', true) !== alt;
    } else {
      const session = this.session();
      const data = (session && session.sessionData) || {};
      const first = list.length ? (typeof list[0] === 'string' ? list[0] : (list[0].path || list[0].name)) : '';
      const alreadyRecycled = !!(session && typeof session.isRecycledFile === 'function'
        && session.isRecycledFile(first));
      recycle = (!!data.deleteToRecycleBin !== alt) && !!data.recycleBinPath && !alreadyRecycled;
    }

    const confirmPref = recycle ? 'confirmRecycling' : 'confirmDeleting';
    const needConfirmation = this.pref(confirmPref, true) !== false;

    let query = '';
    if (needConfirmation) {
      if (list.length === 1) {
        const raw = typeof list[0] === 'string' ? list[0] : (list[0].path || list[0].name);
        const name = local ? nodePath.win32.basename(String(raw)) : unixExtractFileName(String(raw));
        query = recycle ? TEXTS.confirmRecycleFile(name) : TEXTS.confirmDeleteFile(name);
      } else {
        query = recycle ? TEXTS.confirmRecycleFiles(list.length) : TEXTS.confirmDeleteFiles(list.length);
      }
    }

    return { recycle, alternative: alt, local, confirmPref, needConfirmation, query };
  }

  async executeDeleteFileOperation(side, files, alternative) {
    const list = files || [];
    if (!list.length) throw new AbortError(TEXTS.nothingSelected);
    const decision = this.deleteDecision(side, list, alternative);

    let proceed = !decision.needConfirmation;
    if (!proceed) {
      const answer = await this.confirm({
        name: 'deleteFiles',
        kind: 'confirmation',
        message: decision.query,
        buttons: ['ok', 'cancel'],
        neverAskAgain: true,
        imageName: 'Delete file',
        helpKeyword: 'delete_file',
      });
      if (answer === 'neverAskAgain') {
        proceed = true;
        this.setPref(decision.confirmPref, false,
          decision.recycle ? 'Turned off the recycle confirmation' : 'Turned off the delete confirmation');
      } else {
        proceed = answer === 'ok' || answer === 'yes';
      }
    }

    if (!proceed) return { ok: false, ...decision };
    await this.deleteFiles(side, list, decision.alternative);
    return { ok: true, ...decision };
  }

  /**
   * DeleteFiles (CustomScpExplorer.cpp:4368). The selection is saved first and
   * only *restored* on success; a failure discards it so the panel does not
   * highlight names that are gone.
   */
  async deleteFiles(side, files, alternative) {
    const resolved = this.getSide(side);
    const panel = this.panel(resolved);
    if (panel) { panel.saveSelection(); panel.saveSelectedNames(); }
    const params = { alternative: !!alternative };
    try {
      if (this.isSideLocalBrowser(resolved)) {
        await this._call('deleteLocalFiles', files, params);
      } else {
        await this._call('deleteFiles', files, params);
      }
    } catch (e) {
      if (panel) panel.discardSavedSelection();
      throw e;
    }
    if (panel) panel.restoreSelection();
    return true;
  }

  /** LockFiles (CustomScpExplorer.cpp:4486) — same save/restore contract. */
  async lockFiles(files, lock) {
    if (this.localBrowserMode) throw new NotSupportedError('Local files cannot be locked.');
    const panel = this.panel(SIDES.remote);
    if (panel) { panel.saveSelection(); panel.saveSelectedNames(); }
    try {
      await this._call(lock ? 'lockFiles' : 'unlockFiles', files);
    } catch (e) {
      if (panel) panel.discardSavedSelection();
      throw e;
    }
    if (panel) panel.restoreSelection();
    return true;
  }

  /**
   * ExecuteFileOperation (CustomScpExplorer.cpp:3017) — the switchboard. Every
   * refusal in it is preserved: a remote-only operation asked for on the local
   * side raises rather than quietly doing something else.
   */
  async executeFileOperation(operation, side, files, noConfirmation, param) {
    const resolved = this.getSide(side);

    if (isTransferOperation(operation)) {
      return this.executeCopyMoveFileOperation(operation, resolved, files, noConfirmation, param);
    }

    if (operation === OPERATIONS.rename) {
      const panel = this.panel(resolved);
      const item = panel && panel.itemFocused();
      if (!item) throw new AbortError('There is no focused file to rename.');
      return { ok: true, editCaption: item.name };
    }

    if (operation === OPERATIONS.delete) {
      return this.executeDeleteFileOperation(resolved, files, param);
    }

    if (operation === OPERATIONS.setProperties) {
      const panel = this.panel(resolved);
      if (panel) panel.saveSelectedNames();
      // SetProperties in CustomScpExplorer.cpp deliberately dispatches local
      // files to the local view (where the OS properties menu owns the UI),
      // while remote files go through the protocol properties dialog. Passing
      // the resolved side through here is important in local-local workspaces;
      // hard-coding the remote panel silently edits the wrong selection.
      const context = this.setPropertiesContext(resolved, files, param);
      const method = context.local ? 'setLocalProperties' : 'setProperties';
      const ok = await this._call(method, resolved, files, context);
      return { ok: ok !== false };
    }

    if (operation === OPERATIONS.customCommand) {
      if (!param) throw new AbortError('No custom command was given.');
      const panel = this.panel(SIDES.remote);
      if (panel) panel.saveSelectedNames();
      await this._call('customCommand', files, param);
      return { ok: true };
    }

    if (operation === OPERATIONS.remoteMove || operation === OPERATIONS.remoteCopy) {
      if (this.isSideLocalBrowser(resolved)) {
        throw new NotSupportedError('A server-side copy or move needs a remote panel.');
      }
      return this.remoteTransferFiles(files, noConfirmation, operation === OPERATIONS.remoteMove, param);
    }

    if (operation === OPERATIONS.lock || operation === OPERATIONS.unlock) {
      if (this.isSideLocalBrowser(resolved)) {
        throw new NotSupportedError('Only remote files can be locked.');
      }
      await this.lockFiles(files, operation === OPERATIONS.lock);
      return { ok: true };
    }

    throw new NotSupportedError(`Unknown file operation "${operation}".`);
  }

  /**
   * The non-visual half of SetProperties (CustomScpExplorer.cpp:4853).
   *
   * The dialog itself remains a renderer concern, but the form decides which
   * fields and auxiliary lists it may offer from the live terminal caps. The
   * bounded token collection mirrors WinSCP's first-100-directory-entry rule
   * and supplements it with selected entries when the directory is larger.
   */
  setPropertiesContext(side, files, param) {
    const resolved = this.getSide(side);
    const local = this.isSideLocalBrowser(resolved);
    if (local) return { ...(param || {}), local: true, side: resolved };

    const session = this.session();
    const caps = (session && session.caps) || {};
    const capable = (name) => this.capable(name);
    const entries = (this.panel(resolved) && this.panel(resolved).entries) || [];
    const selected = Array.isArray(files) ? files : [];
    const source = entries.slice(0, 100);
    const seen = new Set(source.map((e) => String(e.name || '')));
    for (const e of selected) {
      const name = String((e && (e.name || e.path)) || '');
      if (name && !seen.has(name)) { source.push(e); seen.add(name); }
    }
    const values = (field) => [...new Set(source.map((e) => e && e[field]).filter((v) => v !== undefined && v !== null && v !== ''))];
    return {
      ...(param || {}),
      local: false,
      side: resolved,
      capabilities: {
        mode: capable('modeChanging'),
        acl: capable('aclChangingFiles') && !selected.some((e) => e && (e.isDirectory || e.type === 'dir')),
        owner: capable('ownerChanging'),
        group: capable('groupChanging'),
        userGroupById: capable('groupOwnerChangingByID'),
        tags: capable('tags'),
      },
      users: capable('ownerChanging') ? values('owner') : [],
      groups: capable('groupChanging') ? values('group') : [],
      checksum: this.canCalculateChecksum(),
      // Keep this observable for adapters that need to distinguish a missing
      // capability from an empty list; `caps` is intentionally not mutated.
      declaredCapabilities: { ...caps },
    };
  }

  /**
   * The overload that resolves the file list itself (CustomScpExplorer.cpp:3106),
   * including the reload of extended properties afterwards — without it the
   * panel keeps showing the rights the user just changed away from.
   */
  async executeFileOperationOnSelection(operation, side, onFocused, noConfirmation, param) {
    const resolved = this.getSide(side);
    const files = this.createFileList(resolved, { onFocused });
    const reloadProperties =
      !this.isSideLocalBrowser(resolved)
      && operation === OPERATIONS.setProperties
      && this.hasAvailableTerminal()
      && this.capable('loadingAdditionalProperties');

    const result = await this.executeFileOperation(operation, resolved, files, noConfirmation, param);

    if (result && result.ok && reloadProperties) {
      const panel = this.panel(resolved);
      const names = new Set(files.map((f) => f.name));
      const still = panel ? panel.entries.filter((e) => names.has(e.name)) : [];
      if (still.length) await this._call('loadFilesProperties', still);
    }
    return result;
  }

  /**
   * ExecuteCopyMoveFileOperation's "move to background" branch
   * (CustomScpExplorer.cpp:2900-2920). When the user presses "Transfer in
   * background" mid-transfer, WinSCP aborts the foreground operation and
   * re-queues what is left — and the bookkeeping is precise:
   *
   *   - files already finished go into TransferSkipList, so the queue does not
   *     transfer them a second time;
   *   - the LAST entry is pulled out into TransferResumeFile instead, because
   *     that one was interrupted part-way and must be resumed, not skipped.
   *
   * Getting this wrong either re-sends completed files or silently truncates
   * the one that was in flight, so it is kept literal.
   */
  moveTransferToQueuePlan(spec) {
    const s = spec || {};
    const resumeList = [...(s.transferResumeList || [])];
    const copyParam = { ...(s.copyParam || {}) };
    const params = { ...(s.params || {}) };
    if (copyParam.queueNoConfirmation) params.noConfirmation = true;

    if (resumeList.length > 0) {
      copyParam.transferResumeFile = resumeList[resumeList.length - 1];
      resumeList.pop();
    }
    copyParam.transferSkipList = resumeList;

    return {
      direction: s.direction,
      files: s.files || [],
      targetDirectory: s.targetDirectory,
      copyParam,
      params,
    };
  }

  /**
   * DeleteFiles' equivalent (CustomScpExplorer.cpp:4441). A delete has no
   * partial state, so instead of a resume list the already-deleted names are
   * simply removed from the list handed to the queue. Comparison is
   * case-sensitive for remote files and insensitive for local ones — the same
   * `DeletedFiles->CaseSensitive = Remote` line in the original.
   */
  moveDeleteToQueuePlan(spec) {
    const s = spec || {};
    const remote = s.remote !== false;
    const deleted = new Set((s.deletedFiles || []).map((f) => (remote ? String(f) : String(f).toLowerCase())));
    const remaining = (s.files || []).filter((f) => {
      const key = typeof f === 'string' ? f : (f.path || f.name);
      return !deleted.has(remote ? String(key) : String(key).toLowerCase());
    });
    return { remote, files: remaining, params: { ...(s.params || {}) } };
  }

  /**
   * HandleErrorList (CustomScpExplorer.cpp:3188). WinSCP does not dump every
   * error at once: it asks whether the user wants to see them, then pages
   * through with Prev/Next. Reproduced as a description the UI can render, so
   * the paging behaviour survives.
   */
  errorListPrompt(errors) {
    const list = errors || [];
    if (!list.length) return null;
    return {
      name: 'errorList',
      kind: 'error',
      message: TEXTS.errorListCount(list.length),
      buttons: ['ok', 'cancel'],
      pages: list.map((e, i) => ({
        index: i,
        message: TEXTS.errorListNumber(i + 1, list.length,
          typeof e === 'string' ? e : (e && e.message) || String(e)),
        moreMessages: (e && e.moreMessages) || [],
        buttons: [
          ...(i > 0 ? ['yes'] : []),                  // aliased to "Prev"
          ...(i < list.length - 1 ? ['no'] : []),     // aliased to "Next"
          'ok',
        ],
        aliases: { yes: 'Prev', no: 'Next' },
      })),
    };
  }

  // ======================================================================
  // remote (server-side) copy and move
  // ======================================================================

  /**
   * NeedSecondarySessionForRemoteCopy (CustomScpExplorer.cpp:4521). A protocol
   * with no server-side copy always needs the fallback; a protocol that copies
   * through a secondary shell needs it for DIRECTORIES, because `cp` of a tree
   * is not the same operation as duplicating one object.
   */
  needSecondarySessionForRemoteCopy(files) {
    const session = this.requireSession();
    const copyDirsOnSecondarySession = isCapable(session, 'secondaryShell');
    const anyDirectory = (files || []).some((f) => (f && f.entry ? f.entry.isDirectory : !!(f && f.isDirectory)));
    return !isCapable(session, 'remoteCopy') || (copyDirsOnSecondarySession && anyDirectory);
  }

  /**
   * RemoteTransferDialog (CustomScpExplorer.cpp:4529) — assembles what the
   * remote copy/move dialog needs, including how much direct copying it may
   * offer. A single file pre-fills its own name as the mask, DELIMITED, so a
   * name containing `*` or `?` is copied rather than pattern-matched.
   */
  remoteTransferRequest(spec) {
    const s = spec || {};
    if (this.localBrowserMode) {
      throw new NotSupportedError('A server-side transfer needs a remote session.');
    }
    const session = this.requireSession();
    const files = s.files || [];
    let target = String(s.target || '');

    let targetConfirmed = false;
    if (!s.session || s.session === session) {
      if (s.dropTargetPath) { target = String(s.dropTargetPath); targetConfirmed = true; }
      else if (!target) {
        const panel = this.panel(SIDES.remote);
        target = panel ? panel.path : '';
      }
    } else {
      target = String(s.targetSessionPath || '');
    }
    target = unixIncludeTrailingSlash(target);

    const fileMask = files.length === 1
      ? delimitFileNameMask(unixExtractFileName(typeof files[0] === 'string' ? files[0] : (files[0].path || files[0].name)))
      : ANY_MASK;

    const directCopy = isCapable(session, 'remoteCopy') || isCapable(session, 'secondaryShell');

    let allowDirectCopy;
    if (session.commandSessionOpened || !this.needSecondarySessionForRemoteCopy(files)) {
      allowDirectCopy = DIRECT_REMOTE_COPY.allow;
    } else if (isCapable(session, 'secondaryShell')) {
      allowDirectCopy = isCapable(session, 'remoteCopy')
        ? DIRECT_REMOTE_COPY.confirmCommandSessionDirs
        : DIRECT_REMOTE_COPY.confirmCommandSession;
    } else {
      allowDirectCopy = DIRECT_REMOTE_COPY.disallow;
    }

    // Only sessions that are actually usable and are not local browsers can be
    // a copy target — offering a disconnected tab would fail at the last step.
    const targets = this._sessions()
      .filter((x) => x && x.active !== false && !x.localBrowser)
      .map((x) => ({ session: x, name: x.name, path: (x.state && x.state.remotePath) || x.currentDirectory || '' }));

    return {
      multi: files.length > 1,
      move: !!s.move,
      target,
      targetConfirmed,
      fileMask,
      directCopy,
      allowDirectCopy,
      sessions: targets,
    };
  }

  /**
   * RemoteTransferFiles (CustomScpExplorer.cpp:4637).
   *
   * The branch that matters: when a copy cannot be done on the server at all,
   * WinSCP downloads to a temporary folder and uploads to the destination. It
   * is slow and it is honest — it is also why `remoteCopy` never silently does
   * nothing on a protocol that lacks it.
   */
  async remoteTransferFiles(files, noConfirmation, move, targetSession) {
    const request = this.remoteTransferRequest({ files, move, session: targetSession });
    let plan = { ok: true, target: request.target, fileMask: request.fileMask, directCopy: request.directCopy, session: targetSession || this.session() };

    if (!noConfirmation) {
      if (!this.ops.remoteTransferDialog) {
        throw new NotSupportedError('No remote copy/move dialog is wired.');
      }
      const answered = await this.ops.remoteTransferDialog(request);
      if (!answered || answered.ok === false) return { ok: false };
      plan = { ok: true, ...plan, ...answered };
    }

    if (!move && !plan.directCopy) {
      // The temporary-folder route. Reported to the caller rather than run here,
      // because it is a download followed by an upload and both belong to ops.
      const copyParam = this.temporaryFileCopyParam(false);
      const temp = this.temporaryDirectoryForRemoteFiles(
        (this.session() && this.session().currentDirectory) || '/', { simple: true });
      let uploadedNames = [];
      try {
        await this._call('copyToLocal', files, temp.dir, copyParam, { noConfirmation: true, temporary: true });

        // ProcessLocalDirectory(TempDir, MakeLocalFileList) with
        // IncludeDirs = true and Recursive = false: the CONTENTS of the scratch
        // folder go up, not the folder itself. Uploading `temp.dir` as one
        // entry would land the copy inside a directory named after the scratch
        // folder — or, with the single-file mask applied, a DIRECTORY named
        // after the file the user asked to copy.
        uploadedNames = this._temporaryDirectoryEntries(temp.dir);

        // "if (TemporaryFilesList->Count > 0)" — a download that produced
        // nothing must not turn into an upload of nothing.
        if (uploadedNames.length) {
          const uploaded = { ...this.currentCopyParam(), fileMask: plan.fileMask };
          if (plan.session) this._setActiveSession(plan.session);
          await this._call('copyToRemote', uploadedNames, plan.target, uploaded, { temporary: true });
        }
      } finally {
        if (temp.rootDir && this.ops.removeTree) await this.ops.removeTree(excludeTrailingBackslash(temp.rootDir));
      }
      return {
        ok: true,
        viaTemporaryDirectory: true,
        target: plan.target,
        files: uploadedNames.map((f) => f.path),
      };
    }

    const panel = this.panel(SIDES.remote);
    if (panel) { panel.saveSelection(); panel.saveSelectedNames(); }
    try {
      if (move) {
        await this._call('moveFiles', files, plan.target, plan.fileMask);
      } else {
        // A direct copy through a secondary shell needs that shell to exist.
        // CommandSessionFallback() is allowed to refuse, and when it does the
        // copy simply does not happen — WinSCP does not fall back to the slow
        // route here, and neither do we.
        const needsSecondary = this.needSecondarySessionForRemoteCopy(files);
        const session = this.requireSession();
        if (!needsSecondary || session.commandSessionOpened || await this.commandSessionFallback()) {
          await this._call('copyFiles', files, plan.target, plan.fileMask);
        } else {
          if (panel) panel.discardSavedSelection();
          return { ok: false, refused: 'commandSession' };
        }
      }
    } catch (e) {
      if (panel) panel.discardSavedSelection();
      throw e;
    }
    if (panel) panel.restoreSelection();
    return { ok: true, viaTemporaryDirectory: false, target: plan.target };
  }

  // ======================================================================
  // the command (secondary shell) session
  // ======================================================================

  /** CommandSessionFallback — open the secondary shell, report whether it came up. */
  async commandSessionFallback() {
    const session = this.requireSession();
    if (!this.ops.openCommandSession) return false;
    const ok = await this.ops.openCommandSession(session);
    return ok !== false;
  }

  /**
   * EnsureCommandSessionFallback (CustomScpExplorer.cpp:7225).
   *
   * Three outcomes, all of them ported:
   *   - the protocol can already do it, or the shell is already open: yes.
   *   - the protocol has no secondary shell at all: NotSupported(). This is a
   *     REFUSAL, not a prompt — there is nothing the user could agree to.
   *   - otherwise: ask, remember "never ask again", and only then open it.
   */
  async ensureCommandSessionFallback(capability) {
    const session = this.requireSession();
    if (isCapable(session, capability) || session.commandSessionOpened) return true;

    if (!isCapable(session, 'secondaryShell')) {
      throw new NotSupportedError(
        `${(session.protocol || 'This protocol').toString().toUpperCase()} cannot do this, and it has no shell session to fall back on.`);
    }

    let ok;
    if (this.pref('confirmCommandSession', true) === false) {
      ok = true;
    } else {
      const protocolName = String(session.protocolName || session.protocol || 'current').toUpperCase();
      const answer = await this.confirm({
        name: 'commandSession',
        kind: 'confirmation',
        message: TEXTS.performOnCommandSession(protocolName),
        buttons: ['ok', 'cancel'],
        neverAskAgain: true,
        helpKeyword: 'perform_on_command_session',
      });
      if (answer === 'neverAskAgain') {
        this.setPref('confirmCommandSession', false, 'Turned off the shell-session confirmation');
        ok = true;
      } else {
        ok = answer === 'ok' || answer === 'yes';
      }
    }

    if (!ok) return false;
    return this.commandSessionFallback();
  }

  /**
   * CanCalculateChecksum (CustomScpExplorer.cpp:4846). The encryption clause
   * is the subtle one: a checksum computed by a shell command is a checksum of
   * the CIPHERTEXT, which would not match anything the user could compare it
   * to, so WinSCP refuses rather than returning a number that means nothing.
   */
  canCalculateChecksum() {
    const session = this.session();
    if (!session) return false;
    if (isCapable(session, 'calculatingChecksum')) return true;
    return isCapable(session, 'secondaryShell') && !session.encryptingFiles;
  }

  // ======================================================================
  // custom commands
  // ======================================================================

  /** CustomCommandRemoteAllowed — a remote command needs a shell, of either kind. */
  customCommandRemoteAllowed() {
    if (!this.hasAvailableTerminal()) return false;
    return this.capable('secondaryShell') || this.capable('shellAnyCommand');
  }

  /**
   * CustomCommandState (CustomScpExplorer.cpp:1970). Returns -1 hidden,
   * 0 disabled, 1 enabled — the tri-state is what lets a file command vanish
   * from the non-file menu instead of sitting there greyed out forever.
   *
   * The "diff"-style case is the one worth reading twice: a local command that
   * uses `!^!` (the other side's file) is enabled only when BOTH panels have a
   * selection, and each panel is asked with focusedFileOnlyWhenFocused set for
   * itself — because only one panel can have the focus, and requiring the
   * focus on both would make the command permanently impossible.
   */
  customCommandState(command, onFocused, listType) {
    const cmd = command || {};
    const params = cmd.params || {};
    const local = !!params.local;
    const type = listType || COMMAND_LIST_TYPE.all;
    const text = stripInteractivePatterns(cmd.command || '', local);
    const fileCommand = customcmd.isFileCommand(text, { local, interactive: false });

    if (!local) {
      const allowedState = this.customCommandRemoteAllowed() ? COMMAND_STATE.enabled : COMMAND_STATE.disabled;
      if (!fileCommand) {
        // A command that touches no files can run any time — but it has no
        // business in the file menu, so it is hidden there rather than shown.
        return (type === COMMAND_LIST_TYPE.all || type === COMMAND_LIST_TYPE.nonFile)
          ? allowedState : COMMAND_STATE.hidden;
      }
      if (type === COMMAND_LIST_TYPE.all
          || (type === COMMAND_LIST_TYPE.file && !this.isSideLocalBrowser(this.currentSide))) {
        const panel = this.panel(this.currentSide);
        return (panel && panel.anyFileSelected(!!onFocused, false, true)) ? allowedState : COMMAND_STATE.disabled;
      }
      return COMMAND_STATE.hidden;
    }

    let result;
    if (!fileCommand) {
      result = (type === COMMAND_LIST_TYPE.all || type === COMMAND_LIST_TYPE.nonFile)
        ? COMMAND_STATE.enabled : COMMAND_STATE.hidden;
    } else if (customcmd.findPattern(text, '^', { local: true, interactive: false })) {
      if (type === COMMAND_LIST_TYPE.all || type === COMMAND_LIST_TYPE.file) {
        const localPanel = this.hasDirView(SIDES.local) ? this.panel(SIDES.local) : null;
        const remotePanel = this.panel(SIDES.remote);
        const localOk = !!localPanel && !this.isSideLocalBrowser(SIDES.remote)
          && localPanel.anyFileSelected(false, false, this.currentSide === SIDES.local);
        const remoteOk = !!remotePanel
          && remotePanel.anyFileSelected(false, false, this.currentSide === SIDES.remote);
        result = (localOk && remoteOk) ? COMMAND_STATE.enabled : COMMAND_STATE.disabled;
      } else if (type === COMMAND_LIST_TYPE.both) {
        result = COMMAND_STATE.enabled;
      } else {
        result = COMMAND_STATE.hidden;
      }
    } else if (type === COMMAND_LIST_TYPE.all
        || (type === COMMAND_LIST_TYPE.file
            && (!this.isSideLocalBrowser(this.currentSide) || !params.remoteFiles))) {
      const panel = this.panel(this.currentSide);
      result = (panel && panel.anyFileSelected(!!onFocused, false, true))
        ? COMMAND_STATE.enabled : COMMAND_STATE.disabled;
    } else {
      result = COMMAND_STATE.hidden;
    }

    // A local command that expands session patterns (!@, !U, !S…) still needs a
    // session to expand them FROM.
    if (result > 0 && isSessionCommand(text, { local: true, interactive: false })
        && !this.hasAvailableTerminal()) {
      result = COMMAND_STATE.disabled;
    }
    return result;
  }

  /** AdHocCustomCommandValidate — refuses the command instead of running it wrong. */
  adHocCustomCommandValidate(command, onFocused) {
    if (this.customCommandState(command, onFocused, COMMAND_LIST_TYPE.all) <= 0) {
      throw new AbortError(TEXTS.customCommandImpossible((command && command.command) || ''));
    }
    return true;
  }

  /** GetLastCustomCommand — the command plus its state, or null when there is none. */
  getLastCustomCommand(onFocused) {
    const c = this.lastCustomCommand;
    if (!c || !c.command) return null;
    return { command: c, state: this.customCommandState(c, onFocused, COMMAND_LIST_TYPE.all) };
  }

  // ======================================================================
  // links, clipboard, selection commands
  // ======================================================================

  /**
   * CanAddEditLink (CustomScpExplorer.cpp:7375). The `resolvingSymlinks`
   * clause is not redundant: with symlink resolution off, the panel shows the
   * link itself and editing "where it points" would be meaningless.
   */
  canAddEditLink(side) {
    if (this.isSideLocalBrowser(side)) return true;
    if (!this.hasAvailableTerminal()) return false;
    const session = this.session();
    const resolving = (session.sessionData || {}).resolveSymlinks !== false && isCapable(session, 'resolveSymlink');
    return resolving && isCapable(session, 'symbolicLink');
  }

  /** LinkFocused — is the focused remote item an editable link right now? */
  linkFocused() {
    if (this.isSideLocalBrowser(this.currentSide)) return false;
    const panel = this.panel(SIDES.remote);
    const item = panel && panel.itemFocused();
    if (!item || !item.isSymLink) return false;
    const session = this.session();
    return !!session && (session.sessionData || {}).resolveSymlinks !== false;
  }

  /** CanPasteToDirViewFromClipBoard — the panel itself can take shell files. */
  canPasteToDirViewFromClipBoard() {
    if (!this.dirViewEnabled(SIDES.current)) return false;
    const files = this.clipboard && typeof this.clipboard.files === 'function' ? this.clipboard.files() : [];
    return !!(files && files.length);
  }

  /**
   * CanPasteFromClipBoard (CustomScpExplorer.cpp:9263). WinSCP accepts three
   * different clipboard payloads here, and the order matters: shell files, then
   * a session URL (which opens a session even with no panel), then plain text
   * treated as a path (which needs a live panel).
   */
  canPasteFromClipBoard() {
    if (this.canPasteToDirViewFromClipBoard()) return true;
    const text = this.clipboard && typeof this.clipboard.text === 'function' ? String(this.clipboard.text() || '') : '';
    const trimmed = text.trim();
    if (!trimmed || trimmed.includes('\n')) return false;
    if (this._isSessionUrl(trimmed)) return true;
    return this.dirViewEnabled(SIDES.current);
  }

  _isSessionUrl(text) {
    return /^(sftp|scp|ftps?|ftpes|https?|dav|davs|s3):\/\//i.test(String(text || ''));
  }

  /**
   * PasteFromClipBoard (CustomScpExplorer.cpp:9291) as a plan, because each
   * branch belongs to a different subsystem. The unsafe-URL confirmation is
   * kept here where the refusal lives: a URL carrying settings that weaken
   * host-key or certificate checking is not opened without a yes.
   */
  async pasteFromClipBoardPlan(options) {
    const o = options || {};
    const ourFiles = o.ourFiles || (this.clipboard && typeof this.clipboard.ourFiles === 'function'
      ? this.clipboard.ourFiles() : null);
    if (ourFiles && ourFiles.files && ourFiles.files.length) {
      if (!this.canPasteToDirViewFromClipBoard() && !this.dirViewEnabled(SIDES.current)) {
        return { action: 'none' };
      }
      return {
        action: 'remoteCopy',
        files: ourFiles.files,
        fromSession: ourFiles.session || null,
        toSession: this.session(),
      };
    }
    if (this.canPasteToDirViewFromClipBoard()) {
      return { action: 'pasteFiles', files: this.clipboard.files() };
    }
    const text = this.clipboard && typeof this.clipboard.text === 'function'
      ? String(this.clipboard.text() || '').trim() : '';
    if (!text) return { action: 'none' };
    if (this._isSessionUrl(text)) {
      if (o.unsafeSettings) {
        const answer = await this.confirm({
          name: 'unsafeSession',
          kind: 'confirmation',
          message: TEXTS.unsafeSession,
          buttons: ['ok', 'cancel'],
        });
        if (answer !== 'ok' && answer !== 'yes') throw new AbortError();
      }
      return { action: 'newSession', url: text };
    }
    return { action: 'changePath', path: text };
  }

  // ======================================================================
  // drag and drop
  // ======================================================================

  /** SelectedAllFilesInDirView. */
  selectedAllFilesInDirView(side) {
    const panel = this.panel(side);
    return !!panel && panel.selectedAllFiles();
  }

  /**
   * DraggingAllFilesFromDirView — used to set coAllFiles, which is what lets
   * the transfer dialog say "all files in the directory" instead of listing
   * two hundred names.
   */
  draggingAllFilesFromDirView(side, files, dropSourceSide) {
    if (!this.hasDirView(side)) return false;
    if (dropSourceSide !== undefined && dropSourceSide !== this.getSide(side)) return false;
    const panel = this.panel(side);
    return !!panel && (files || []).length === panel.filesCount;
  }

  /**
   * RemoteFileContolDDChooseEffect (CustomScpExplorer.cpp:9109) — what a drag
   * INSIDE the remote panel defaults to.
   *
   * Two refusals live here. Dropping on the panel's free space (no target
   * directory) is refused outright, because "move these files to where they
   * already are" is not an operation. And with Ctrl held the effect becomes
   * copy or NOTHING — never a silent move, since the whole point of Ctrl is
   * that the user asked for a copy.
   */
  chooseDropEffect(spec) {
    const s = spec || {};
    const DROPEFFECT = shellintegration.DROPEFFECT;
    let effect = Number(s.effect) || DROPEFFECT.NONE;
    if (effect === DROPEFFECT.NONE) return effect;
    if (!s.fromRemotePanel) return effect;

    if (s.ontoDirView && s.fromDirView && !s.dropTarget) return DROPEFFECT.NONE;
    // A drop back onto the directory being displayed is a self-drop, not a
    // meaningful move. Refuse it before effect negotiation can turn it into a
    // server-side rename/copy; child directories remain valid targets.
    if (s.ontoDirView && s.fromDirView && s.dropTarget
        && sameUnixPath(s.dropTarget, this.panel(SIDES.remote)?.path)) {
      return DROPEFFECT.NONE;
    }

    if (effect !== DROPEFFECT.COPY) return effect;

    const moveCapable = this.capable('remoteMove');
    // WinSCP's comment: "currently we support copying always (at least via
    // temporary directory)". The temporary-directory route is implemented in
    // remoteTransferFiles, so this stays true here too.
    const copyCapable = true;
    if (!moveCapable && !copyCapable) return DROPEFFECT.NONE;

    if (!s.ctrl) return moveCapable ? DROPEFFECT.MOVE : DROPEFFECT.COPY;
    return copyCapable ? DROPEFFECT.COPY : DROPEFFECT.NONE;
  }

  /**
   * DDGetTarget (CustomScpExplorer.cpp:8449). A drop on the queue view is a
   * download to the default target that is FORCED into the background — the
   * user dropped it on the queue, so the queue is where it goes.
   */
  ddGetTarget(spec) {
    return resolveDropTarget(spec);
  }

  /**
   * RemoteFileControlDDEnd's decision half. drInvalid does NOT mean failure —
   * on older Windows a real move arrives as invalid, so WinSCP falls back to
   * the last reported drop effect and, failing that, prefers COPY because a
   * wrongly-guessed move deletes the source.
   */
  dropResultOperation(dragResult, lastDropEffect) {
    return shellintegration.dropEffectOperation(dragResult, lastDropEffect);
  }

  /**
   * DoWarnLackOfTempSpace (CustomScpExplorer.cpp:7098). Returns true when the
   * download may continue. The rule itself already lives in shellintegration;
   * what is added here is the actual asking and the "never warn again".
   */
  async warnLackOfTempSpace(path, requiredSpace, options) {
    const o = options || {};
    const warning = shellintegration.warnLackOfTempSpace(path, requiredSpace, {
      enabled: this.pref('dDWarnLackOfTempSpace', true) !== false,
      ratio: Number(this.pref('dDWarnLackOfTempSpaceRatio', 1.1)) || 1.1,
      freeSpace: o.freeSpace,
    });
    if (!warning) return true;
    const answer = await this.confirm({
      name: 'lackOfTempSpace',
      kind: 'warning',
      message: warning.message,
      buttons: ['yes', 'no'],
      neverAskAgain: true,
      helpKeyword: 'dd_warn_lack_of_temp_space',
    });
    if (answer === 'neverAskAgain') {
      this.setPref('dDWarnLackOfTempSpace', false, 'Turned off the temporary-space warning');
      return true;
    }
    return answer === 'yes';
  }

  /**
   * RemoteFileControlDragDropFileOperation (CustomScpExplorer.cpp:9038) — the
   * upload half of a drop onto the remote panel. `dragDrop` suppresses the
   * confirmation only when the preference says `off`; a paste is never treated
   * as a drag, so it keeps its confirmation.
   */
  async dragDropFileOperation(spec) {
    const s = spec || {};
    const DROPEFFECT = shellintegration.DROPEFFECT;
    const effect = Number(s.effect);
    // DDEnd normally resolves drInvalid before reaching this method, but a
    // renderer or embedder can call the operation entry point directly.  Do
    // not turn drNone, drCancel, or an unknown shell value into a COPY: that
    // would upload files after the shell explicitly refused the drop.
    if (effect !== DROPEFFECT.COPY && effect !== DROPEFFECT.MOVE) {
      return { ok: false, reason: 'invalidDropEffect' };
    }
    const operation = effect === DROPEFFECT.MOVE ? OPERATIONS.move : OPERATIONS.copy;
    const files = s.files || [];
    if (!files.length) return { ok: false };

    const param = {
      targetDirectory: s.targetPath,
      temp: false,
      dragDrop: s.dragDrop !== false,
      options: {},
    };
    if (this.draggingAllFilesFromDirView(SIDES.local, files, s.dropSourceSide)) {
      param.options[COPY_OPTIONS.allFiles] = true;
    }
    if (s.forceQueue) param.queue = AUTO_SWITCH.on;

    const noConfirmation = param.dragDrop
      ? shellintegration.transferConfirmationSuppressed(this.pref('dDTransferConfirmation', 'auto'))
      : false;

    return this.executeFileOperation(operation, SIDES.local, files, noConfirmation, param);
  }

  // ======================================================================
  // queue
  // ======================================================================

  _queueItems() {
    if (!this.queue) return [];
    if (typeof this.queue.list === 'function') return this.queue.list() || [];
    return this.queue.items || [];
  }

  /** IsAnythingQueued — anything not finished counts. */
  isAnythingQueued() {
    return this._queueItems().some((i) => i && i.state !== QUEUE_ITEM_STATES.done
      && i.state !== QUEUE_ITEM_STATES.cancelled);
  }

  /** GetQueueEnabled. */
  queueEnabled() {
    return !!(this.queue && this.queue.enabled !== false);
  }

  toggleQueueEnabled() {
    if (!this.queue) return false;
    const next = !this.queueEnabled();
    if (typeof this.queue.setEnabled === 'function') this.queue.setEnabled(next);
    else this.queue.enabled = next;
    return next;
  }

  /** TQueueController::DefaultOperation — what a double-click on an item does. */
  defaultQueueOperation(focusedItem) {
    const item = focusedItem || null;
    if (!item) return QUEUE_OPERATIONS.none;
    switch (item.state) {
      case QUEUE_ITEM_STATES.pending: return QUEUE_OPERATIONS.itemExecute;
      case QUEUE_ITEM_STATES.query: return QUEUE_OPERATIONS.itemQuery;
      case QUEUE_ITEM_STATES.error: return QUEUE_OPERATIONS.itemError;
      case QUEUE_ITEM_STATES.prompt: return QUEUE_OPERATIONS.itemPrompt;
      case QUEUE_ITEM_STATES.active: return QUEUE_OPERATIONS.itemPause;
      case QUEUE_ITEM_STATES.paused: return QUEUE_OPERATIONS.itemResume;
      default: return QUEUE_OPERATIONS.none;
    }
  }

  /**
   * AllowQueueOperation (CustomScpExplorer.cpp:8796) plus
   * TQueueController::AllowOperation (QueueController.cpp:76). Every one of
   * these is a real precondition — "move up" is refused when the item above is
   * not itself pending, because reordering across an active transfer would put
   * a pending item ahead of one already running.
   */
  allowQueueOperation(operation, context) {
    const c = context || {};
    const items = this._queueItems();
    const focused = c.item || null;
    const index = focused ? items.findIndex((i) => i && focused && i.id === focused.id) : -1;

    switch (operation) {
      case QUEUE_OPERATIONS.preferences:
        return true;
      case QUEUE_OPERATIONS.goTo:
        return !!c.queueViewVisible && !!c.queueViewEnabled;
      case QUEUE_OPERATIONS.onceEmpty:
        return this.isAnythingQueued();
      case QUEUE_OPERATIONS.itemUserAction:
        return !!focused && [QUEUE_ITEM_STATES.query, QUEUE_ITEM_STATES.error, QUEUE_ITEM_STATES.prompt]
          .includes(focused.state);
      case QUEUE_OPERATIONS.itemQuery:
        return !!focused && focused.state === QUEUE_ITEM_STATES.query;
      case QUEUE_OPERATIONS.itemError:
        return !!focused && focused.state === QUEUE_ITEM_STATES.error;
      case QUEUE_OPERATIONS.itemPrompt:
        return !!focused && focused.state === QUEUE_ITEM_STATES.prompt;
      case QUEUE_OPERATIONS.itemDelete:
        return !!focused;
      case QUEUE_OPERATIONS.itemExecute:
        return !!focused && focused.state === QUEUE_ITEM_STATES.pending;
      case QUEUE_OPERATIONS.itemUp:
        return !!focused && focused.state === QUEUE_ITEM_STATES.pending
          && index > 0 && !!items[index - 1] && items[index - 1].state === QUEUE_ITEM_STATES.pending;
      case QUEUE_OPERATIONS.itemDown:
        return !!focused && focused.state === QUEUE_ITEM_STATES.pending
          && index >= 0 && index < items.length - 1;
      case QUEUE_OPERATIONS.itemPause:
        return !!focused && focused.state === QUEUE_ITEM_STATES.active;
      case QUEUE_OPERATIONS.itemResume:
        return !!focused && focused.state === QUEUE_ITEM_STATES.paused;
      case QUEUE_OPERATIONS.itemSpeed:
        return !!focused && focused.state !== QUEUE_ITEM_STATES.done
          && isTransferOperation(focused.operation || OPERATIONS.copy);
      case QUEUE_OPERATIONS.pauseAll:
        return items.some((i) => i && i.state === QUEUE_ITEM_STATES.active);
      case QUEUE_OPERATIONS.resumeAll:
        return items.some((i) => i && i.state === QUEUE_ITEM_STATES.paused);
      case QUEUE_OPERATIONS.deleteAllDone:
        return items.some((i) => i && i.state === QUEUE_ITEM_STATES.done);
      case QUEUE_OPERATIONS.deleteAll:
        return items.length > 0;
      default:
        return false;
    }
  }

  /**
   * CanCloseQueue (CustomScpExplorer.cpp:5454). The warning is explicit that
   * OK terminates the transfers immediately — this is the last chance, and the
   * port keeps it as a blocking decision rather than a toast.
   */
  async canCloseQueue() {
    if (!this.isAnythingQueued()) return true;
    const answer = await this.confirm({
      name: 'pendingQueueItems',
      kind: 'warning',
      message: TEXTS.pendingQueueItems,
      buttons: ['ok', 'cancel'],
    });
    return answer === 'ok' || answer === 'yes';
  }

  // ======================================================================
  // session and tab lifecycle
  // ======================================================================

  /** CloseTab — refuses while transfers are queued unless the user insists. */
  async closeTab() {
    // The close-tab IPC action is the production path, so enforce the same
    // local-browser floor as the command-state predicate. Without this check
    // the last workspace tab could disappear even though the UI says it is
    // disabled.
    if (!this.canCloseSession(this.session())) return false;
    if (!(await this.canCloseQueue())) return false;
    if (this.ops.closeSession) await this.ops.closeSession(this.session());
    return true;
  }

  /** DisconnectSession — same gate, different destination. */
  async disconnectSession() {
    if (!(await this.canCloseQueue())) return false;
    if (this.ops.disconnectSession) await this.ops.disconnectSession(this.session());
    return true;
  }

  /**
   * CanCloseSession (CustomScpExplorer.cpp:7680). The implicit local-local
   * browser is the app's floor: closing the last one would leave no window
   * content at all, so it is refused while it is the only tab.
   */
  canCloseSession(session) {
    const s = session || this.session();
    if (!s) return false;
    if (!s.localBrowser) return true;
    return this._sessions().length > 1;
  }

  /**
   * FormCloseQuery (CustomScpExplorer.cpp:5561) — the whole close decision.
   *
   * The confirmation appears when there is at least one live session, or when
   * there are several tabs and no workspace will be saved for them. Answering
   * "No" (only offered when auto-save is off) SAVES a workspace instead of
   * closing, which is why the answer set changes with the setting.
   */
  async formCloseQuery(options) {
    const o = options || {};
    if (o.busy) return { canClose: false, reason: 'busy' };

    const sessions = this._sessions();
    const activeSessions = sessions.filter((s) => s && s.active).length;
    const autoSave = !!((this.pref('window', {}) || {}).autoSaveWorkspace);
    const confirmClosing = this.pref('confirmClosingSession', true) !== false;

    let canClose = true;
    let saveWorkspace = false;

    if (((activeSessions > 0) || (sessions.length > 1 && !autoSave)) && confirmClosing) {
      const current = this.session();
      let message;
      if (activeSessions === 1 && current && current.active) {
        message = autoSave
          ? TEXTS.closeSession(this._sessionName(current))
          : TEXTS.closeSessionWorkspace(this._sessionName(current));
      } else if (activeSessions > 0) {
        message = autoSave ? TEXTS.closeSessions : TEXTS.closeSessionsWorkspace;
      } else {
        message = TEXTS.closeWorkspace;
      }

      const note = autoSave
        ? TEXTS.autoWorkspace(o.workspaceName || (this.pref('window', {}) || {}).autoWorkspace || '')
        : TEXTS.autoWorkspaceEnable;
      const buttons = autoSave ? ['ok', 'cancel'] : ['yes', 'no', 'cancel'];

      const answer = await this.confirm({
        name: 'closeSession',
        kind: 'confirmation',
        message: `${message}\n\n${note}`,
        buttons,
        neverAskAgain: true,
        helpKeyword: 'close_session_workspace',
      });

      if (answer === 'neverAskAgain') {
        this.setPref('confirmClosingSession', false, 'Turned off the close confirmation');
        canClose = true;
      } else if (answer === 'no') {
        // "No" means "enable the workspace and save it", not "do not close".
        saveWorkspace = true;
        canClose = this.ops.saveWorkspace ? (await this.ops.saveWorkspace(true)) !== false : true;
      } else {
        canClose = answer === 'ok' || answer === 'yes';
      }
    }

    if (canClose && this.hasAvailableTerminal()) {
      canClose = await this.canCloseQueue();
    }

    if (canClose) {
      // Open editors block the close, and "Ignore" warns that the temporary
      // copies stay behind — WinSCP says so rather than deleting them silently.
      const editorsBusy = !!o.editorsOpen;
      if (editorsBusy) {
        const answer = await this.confirm({
          name: 'pendingEditors',
          kind: 'warning',
          message: TEXTS.pendingEditors,
          buttons: ['ignore', 'cancel'],
        });
        canClose = answer === 'ignore';
      }
    }

    return { canClose, saveWorkspace };
  }

  _sessionName(session) {
    if (!session) return '';
    return String((session.sessionData && session.sessionData.sessionName) || session.name || '');
  }

  /**
   * SessionTabSwitched (CustomScpExplorer.cpp:7685). Clicking the "+" tab is
   * not a switch: it opens a new session and leaves the previous tab active
   * until that succeeds.
   */
  sessionTabSwitched(tab) {
    const session = tab && tab.session ? tab.session : null;
    if (!session) return { switched: false, newTab: true };
    this._setActiveSession(session);
    return { switched: true, newTab: false, session };
  }

  /**
   * NeedSession (CustomScpExplorer.cpp:7514). Reproduced as a decision, since
   * terminating the application is main.js's to do. The condition is exact,
   * including the "do not terminate while merely starting up with no login
   * dialog" clause — otherwise the app would exit before the user could act.
   */
  needSession(startup) {
    const showLogin = this.pref('showLoginWhenNoSession', true) !== false;
    const keepOpen = !!((this.pref('window', {}) || {}).keepOpenWhenNoSession);
    const session = this.session();
    const terminate =
      (showLogin || !startup)
      && !keepOpen
      && (!session || (!session.active && !session.permanent));
    return { showLogin, reloadSessions: !startup, terminate };
  }

  /**
   * RenameTab (CustomScpExplorer.cpp:5435). TSessionData::ValidateName refuses
   * a slash, because site names are hierarchical and a slash would silently
   * move the site into a folder.
   */
  renameTab(name, currentName) {
    const next = String(name == null ? '' : name);
    if (next === String(currentName == null ? '' : currentName)) return { changed: false, name: next };
    if (next.includes('/')) {
      throw new AbortError(`The name "${next}" cannot include a slash.`);
    }
    if (!next.trim()) {
      throw new AbortError('The tab name cannot be empty.');
    }
    return { changed: true, name: next };
  }

  /**
   * DuplicateTab (CustomScpExplorer.cpp:5412). The duplicate inherits the
   * disconnected flags deliberately: duplicating a disconnected tab must not
   * silently dial out.
   */
  duplicateTabPlan() {
    const session = this.session();
    if (!session) throw new AbortError(TEXTS.noSession);
    return {
      data: { ...(session.sessionData || {}) },
      localBrowser: !!session.localBrowser,
      disconnected: !!session.disconnected,
      permanent: !!session.permanent,
      disconnectedTemporarily: !!session.disconnectedTemporarily,
    };
  }

  // ======================================================================
  // transfer preset auto-selection
  // ======================================================================

  /** GetTransferPresetAutoSelectData. */
  transferPresetAutoSelectData() {
    const session = this.session();
    if (!session) return null;
    const data = session.sessionData || {};
    const panel = this.panel(SIDES.remote);
    return {
      hostName: String(data.hostName || ''),
      userName: String(data.userName || ''),
      remoteDirectory: panel ? panel.path : String(session.currentDirectory || ''),
      localDirectory: (this.panel(SIDES.local) && this.panel(SIDES.local).path) || '',
    };
  }

  /**
   * TransferPresetAutoSelect (CustomScpExplorer.cpp:9776).
   *
   * The subtle rule is the "same preset as last time" branch: re-selecting the
   * preset that is already auto-selected does NOTHING, which is what preserves
   * a preset the user picked by hand while browsing inside the same rule's
   * territory. Only a change of rule overwrites the user's choice.
   */
  transferPresetAutoSelect() {
    if (!this.allowTransferPresetAutoSelect) return { changed: false, reason: 'suppressed' };
    const session = this.session();
    // Terminal can be null while the local directory changes implicitly (the
    // login dialog is open and the folder it pointed at was deleted).
    if (!session) return { changed: false, reason: 'noSession' };
    if (!this.config) return { changed: false, reason: 'noConfig' };

    const data = this.transferPresetAutoSelectData();
    const list = this.config.copyParamList;
    const index = list && typeof list.find === 'function' ? list.find(data) : -1;
    const before = this.config.copyParamCurrent;

    if (index < 0) {
      this.copyParamAutoSelected = '';
      this.config.copyParamCurrent = this.copyParamDefault;
    } else {
      const name = list.names[index];
      if (name !== this.copyParamAutoSelected) {
        this.copyParamAutoSelected = name;
        this.config.copyParamCurrent = name;
      }
    }

    const after = this.config.copyParamCurrent;
    if (after === before) return { changed: false, name: after, index };

    const fmt = index < 0
      ? (this.config.copyParamIndex < 0 ? TEXTS.copyParamDefaultNorm : TEXTS.copyParamDefaultCustom(after))
      : TEXTS.copyParamAutoSelected(after);
    let message = fmt;
    if (index >= 0) {
      const rule = list.get(index) && list.get(index).rule;
      if (rule && typeof rule.infoStr === 'function') {
        message += `\n\n${TEXTS.copyParamRule(rule.infoStr('\n'))}`;
      }
    }

    // CopyParamAutoSelectNotice decides whether this interrupts (a modal note
    // with a "Configure" button) or merely informs (a corner note). Both are
    // non-blocking here; the difference is preserved as `prominent`.
    const prominent = this.pref('copyParamAutoSelectNotice', true) !== false;
    this.note({
      kind: 'information',
      name: 'transferPresetAutoSelected',
      message,
      prominent,
      neverAskAgain: prominent,
      preset: after,
    });

    return { changed: true, name: after, index, message, prominent };
  }

  // ======================================================================
  // file editing and execution
  // ======================================================================

  /**
   * RemoteExecuteForceText (CustomScpExplorer.cpp:3374). An editor gets the
   * file in text mode so line endings are the user's; "Open" hands it to the
   * shell untouched, because a binary opened in text mode is a corrupted file.
   */
  remoteExecuteForceText(executeFileBy, externalEditor) {
    if (executeFileBy === EXECUTE_FILE_BY.internalEditor) return true;
    if (executeFileBy === EXECUTE_FILE_BY.externalEditor) {
      return !!(externalEditor && externalEditor.externalEditorText);
    }
    return false;
  }

  /**
   * ExecuteFileNormalize (CustomScpExplorer.cpp:3691). `defaultEditor` is not
   * an editor, it is "look it up" — and the lookup can resolve to the shell.
   */
  executeFileNormalize(spec) {
    const s = spec || {};
    let executeFileBy = s.executeFileBy;
    let externalEditor = s.externalEditor || null;
    if (executeFileBy !== EXECUTE_FILE_BY.defaultEditor) return { executeFileBy, externalEditor };

    const editor = this.config && typeof this.config.defaultEditorForFile === 'function'
      ? this.config.defaultEditorForFile(s.fileName, !!s.local, s.maskParams)
      : null;
    const kind = editor && editor.data ? editor.data.editor : (editor && editor.editor);
    if (!editor || kind === 'internal') {
      executeFileBy = EXECUTE_FILE_BY.internalEditor;
      externalEditor = null;
    } else if (kind === 'open') {
      executeFileBy = EXECUTE_FILE_BY.shell;
      externalEditor = null;
    } else {
      executeFileBy = EXECUTE_FILE_BY.externalEditor;
      externalEditor = editor.data || editor;
    }
    return { executeFileBy, externalEditor };
  }

  /**
   * TemporaryFileCopyParam (CustomScpExplorer.cpp:3893). Every option that
   * would alter the file on the way to the editor is turned OFF: no case
   * change, no rights, no read-only flag, no include mask, no newer-only, no
   * rename mask. Anything left on would mean the file the user edits is not
   * the file that gets uploaded back.
   */
  temporaryFileCopyParam(forceText) {
    const copyParam = this.currentCopyParam();
    copyParam.fileNameCase = 'noChange';
    copyParam.preserveRights = false;
    copyParam.preserveReadOnly = false;
    copyParam.replaceInvalidChars = true;
    copyParam.includeFileMask = '';
    copyParam.newerOnly = false;
    copyParam.fileMask = '';
    if (forceText) copyParam.transferMode = 'ascii';
    return copyParam;
  }

  /** TemporaryDirectoryForRemoteFiles — the policy already lives in guitools. */
  temporaryDirectoryForRemoteFiles(remoteDirectory, options) {
    const o = options || {};
    const session = this.session();
    return guitools.temporaryDirectoryForRemoteFiles(remoteDirectory, this.prefs, {
      simple: !!o.simple,
      sessionName: this._sessionName(session),
      mkdir: o.mkdir,
      env: o.env,
    });
  }

  /** GetTempLocalName — the local name a remote file lands under. */
  getTempLocalName(remotePath, copyParam) {
    const name = unixExtractFileName(String(remotePath || ''));
    if (this.ops.changeFileName) return this.ops.changeFileName(copyParam, name, SIDES.remote, false);
    return name;
  }

  /** EditorCheckNotModified — only meaningful when a timestamp was recorded. */
  editorCheckNotModified(data) {
    if (this.pref('editorCheckNotModified', true) === false) return false;
    return !!(data && data.sourceTimestamp);
  }

  /**
   * ExecuteFile's guard (CustomScpExplorer.cpp:3722). Opening a file that is
   * already open elsewhere is REFUSED, not silently duplicated — two editors
   * over one temporary copy means whichever saves last wins and the other
   * user's work is gone.
   */
  canOpenForEdit(remoteDirectory, originalFileName) {
    if (!this.editors || typeof this.editors.canAddFile !== 'function') {
      return { ok: true, token: null };
    }
    const session = this.session();
    const result = this.editors.canAddFile(remoteDirectory, originalFileName, this._sessionName(session));
    if (result && result.ok !== false) return { ok: true, ...result };
    if (result && result.token) return { ok: false, focusExisting: true, token: result.token };
    throw new AbortError(TEXTS.alreadyEditedExternally(originalFileName));
  }

  /**
   * DoDirViewExecFile (CustomScpExplorer.cpp:5923) — what a double-click does.
   * `forceExecution` (the explicit "Open" command) bypasses the preference, so
   * "Open" always opens even when double-click is configured to copy.
   */
  resolveDoubleClick(side, entry) {
    const resolved = this.getSide(side);
    const isDirectory = !!(entry && entry.isDirectory);
    if (this.forceExecution) return isDirectory ? 'changeDir' : 'open';

    const session = this.isSideLocalBrowser(resolved) ? null : this.session();
    if (isDirectory) return 'changeDir';

    // TWinConfiguration::ResolveDoubleClickAction (WinConfiguration.cpp:3054).
    // Before the preference is even consulted: on a session that is NOT
    // resolving symlinks, the panel cannot tell a directory symlink from a
    // file, so a double-click has to mean "go in" — opening it in an editor
    // would download a directory. The same holds while file encryption is on,
    // where the "file" the panel shows is not the file on disk. A user who
    // genuinely wants the configured action sets AlwaysRespectDoubleClickAction.
    if (session
        && !this._sessionResolvingSymlinks(session)
        && !session.encryptingFiles
        && !this.pref('alwaysRespectDoubleClickAction', false)) {
      return 'changeDir';
    }

    const panelPrefs = this.pref('panel', {}) || {};
    const action = String(panelPrefs.doubleClickAction || this.pref('doubleClickAction', 'edit'));
    if (action === 'copy') {
      // A copy needs somewhere to copy to; with no session there is nowhere.
      if (!this.localBrowserMode && !this.hasAvailableTerminal()) return 'none';
      return 'copy';
    }
    if (action === 'open') {
      // rdcaOpen is acted on only for a REMOTE file (DoDirViewExecFile:5978):
      // the remote copy has to be downloaded first before the shell can be
      // handed anything. On the local side WinSCP leaves AllowExec true and
      // the dir view shell-executes the file itself — the same outcome, so
      // 'open' is the honest answer rather than 'edit'.
      if (!session) return 'open';
      return this.pref('disableOpenEdit', false) ? 'none' : 'open';
    }
    if (session && this.pref('disableOpenEdit', false)) return 'none';
    return 'edit';
  }

  /** TTerminal::GetResolvingSymlinks, for a session facade or a live Terminal. */
  _sessionResolvingSymlinks(session) {
    const s = session || this.session();
    if (!s) return false;
    if (typeof s.resolvingSymlinks === 'boolean') return s.resolvingSymlinks;
    return (s.sessionData || {}).resolveSymlinks !== false && isCapable(s, 'resolveSymlink');
  }

  /**
   * The double-click's confirmation flag. CopyOnDoubleClickConfirmation is
   * inverted into `noConfirmation`, exactly as the C++ passes it.
   */
  doubleClickCopyNoConfirmation() {
    return this.pref('copyOnDoubleClickConfirmation', true) === false;
  }

  // ======================================================================
  // synchronize
  // ======================================================================

  /**
   * SynchronizeAllowSelectedOnly (CustomScpExplorer.cpp:6245). "Selected files
   * only" is offered when EITHER panel has a selection — synchronization is
   * two-sided, so a selection on one side is enough to constrain it.
   */
  synchronizeAllowSelectedOnly() {
    const remote = this.panel(SIDES.remote);
    const local = this.hasDirView(SIDES.local) ? this.panel(SIDES.local) : null;
    return !!((remote && remote.selCount > 0) || (local && local.selCount > 0));
  }

  /**
   * GetSynchronizeOptions (CustomScpExplorer.cpp:6258). The filter is the union
   * of both panels' selections, case-insensitively and allowing duplicates —
   * a name selected on both sides must not cancel itself out.
   */
  getSynchronizeOptions(params) {
    const p = params || {};
    if (!p.selectedOnly || !this.synchronizeAllowSelectedOnly()) return { filter: null };
    const names = [];
    const remote = this.panel(SIDES.remote);
    const local = this.hasDirView(SIDES.local) ? this.panel(SIDES.local) : null;
    if (remote && remote.selCount > 0) {
      for (const f of remote.createFileList({ fullPath: false })) names.push(f.name);
    }
    if (local && local.selCount > 0) {
      for (const f of local.createFileList({ fullPath: false })) names.push(f.name);
    }
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { filter: names };
  }

  /**
   * DoFullSynchronizeDirectories' option assembly (CustomScpExplorer.cpp:6666).
   * Each disabled option is a capability the protocol genuinely lacks, so the
   * dialog greys it rather than offering something that would fail later.
   */
  fullSynchronizeOptions() {
    const localLocal = this.localBrowserMode;
    return {
      disableTimestamp: localLocal || !this.canChangeTimestamp(),
      disableByChecksum: !localLocal && !this.canCalculateChecksum(),
      allowSelectedOnly: this.synchronizeAllowSelectedOnly(),
      localLocal,
    };
  }

  /**
   * The refusal that gates a checksum-based synchronization: `spByChecksum`
   * needs a checksum capability, and on a protocol that has neither checksum
   * nor shell it is impossible. EnsureCommandSessionFallback either opens the
   * shell, is refused by the user, or raises NotSupported.
   */
  async ensureSynchronizeCapabilities(params) {
    const p = params || {};
    if (!p.byChecksum) return true;
    return this.ensureCommandSessionFallback('calculatingChecksum');
  }

  /** The "no differences" report — an information dialog, never silence. */
  noDifferencesNote() {
    return { kind: 'information', name: 'compareNoDifferences', message: TEXTS.compareNoDifferences };
  }

  /**
   * DoSynchronizeTooManyDirectories (CustomScpExplorer.cpp:6144). Keep-up-to-date
   * watches directories, and watching thousands is a real performance problem,
   * so WinSCP asks before doubling the budget — and aborts when refused.
   */
  async tooManyWatchDirectories(maxDirectories) {
    const configured = Number(this.pref('maxWatchDirectories', 500)) || 500;
    if (maxDirectories < configured) return configured;
    const answer = await this.confirm({
      name: 'tooManyWatchDirectories',
      kind: 'confirmation',
      message: TEXTS.tooManyWatchDirectories(maxDirectories),
      buttons: ['yes', 'no'],
      neverAskAgain: true,
      helpKeyword: 'too_many_watch_directories',
    });
    if (answer === 'yes' || answer === 'neverAskAgain') {
      const next = maxDirectories * 2;
      if (answer === 'neverAskAgain') {
        this.setPref('maxWatchDirectories', next, 'Raised the watched-directory limit');
      }
      return next;
    }
    throw new AbortError('Watching was stopped because too many directories were found.');
  }

  /** The synchronization summary, when the preference asks for one. */
  synchronizeSummary(statistics, elapsed, collectElapsed) {
    if (this.pref('synchronizeSummary', true) === false) return null;
    const s = statistics || {};
    const lines = [TEXTS.synchronizeComplete];
    if (s.filesUploaded > 0) lines.push(`Files uploaded: ${s.filesUploaded} (${s.totalUploaded || 0})`);
    if (s.filesDownloaded > 0) lines.push(`Files downloaded: ${s.filesDownloaded} (${s.totalDownloaded || 0})`);
    if (s.filesDeletedLocal > 0) lines.push(`Local files deleted: ${s.filesDeletedLocal}`);
    if (s.filesDeletedRemote > 0) lines.push(`Remote files deleted: ${s.filesDeletedRemote}`);
    lines.push(`Comparison time: ${collectElapsed || 0}`);
    lines.push(`Synchronization time: ${elapsed || 0}`);
    return { kind: 'information', name: 'synchronizeSummary', message: lines.join('\n'), neverAskAgain: true };
  }

  // ======================================================================
  // synchronized browsing (ScpCommander.cpp:1369-1610)
  // ======================================================================

  /**
   * SynchronizeBrowsingLocal — the local panel moved, so work out where the
   * remote panel should go. It walks UP from the previous pair to their common
   * ancestor and then applies the remainder; when the walk runs off the remote
   * root there is no mapping and it ABORTS rather than guessing.
   */
  synchronizeBrowsingLocal(prevLocalPath, newLocalPath, remotePath) {
    // TUnixDirView::GetPath returns the remote directory WITH a trailing slash
    // (UnixDirView.cpp:735) while the local one does not. The whole walk below
    // depends on that asymmetry: the "cannot go higher" test is written as
    // "this path no longer has a trailing slash", which is only ever true at
    // the root once the value is normalized this way.
    let prev = includeTrailingBackslash(String(prevLocalPath || ''));
    const nextBare = excludeTrailingBackslash(String(newLocalPath || ''));
    const next = includeTrailingBackslash(nextBare);
    let common = extractCommonPath([prev, next], false);
    if (!common) throw new AbortError(TEXTS.syncDirBrowseError);
    common = includeTrailingBackslash(common);

    let target = unixIncludeTrailingSlash(String(remotePath || ''));
    while (!sameLocalPath(prev, common)) {
      if (target === unixExcludeTrailingSlash(target)) throw new AbortError(TEXTS.syncDirBrowseError);
      target = unixExtractFilePath(unixExcludeTrailingSlash(target));
      const parent = includeTrailingBackslash(nodePath.win32.dirname(excludeTrailingBackslash(prev)));
      // Not in the C++, which relies on the remote side running out first. A
      // drive root with no common ancestor would otherwise spin forever here.
      if (sameLocalPath(parent, prev)) throw new AbortError(TEXTS.syncDirBrowseError);
      prev = parent;
    }

    const remainder = nextBare.slice(prev.length);
    return unixIncludeTrailingSlash(target) + remainder.replace(/\\/g, '/');
  }

  /**
   * SynchronizeBrowsingRemote — the mirror image, remote drives local. The
   * result keeps its trailing backslash because the remote path it is derived
   * from keeps its trailing slash; TDirView::SetPath strips it on assignment,
   * exactly as in the original.
   */
  synchronizeBrowsingRemote(prevRemotePath, newRemotePath, localPath) {
    let prev = unixIncludeTrailingSlash(String(prevRemotePath || ''));
    const next = unixIncludeTrailingSlash(String(newRemotePath || ''));
    let common = extractCommonPath([prev, next], true);
    if (!common) throw new AbortError(TEXTS.syncDirBrowseError);
    common = unixIncludeTrailingSlash(common);

    let target = excludeTrailingBackslash(String(localPath || ''));
    while (!sameUnixPath(prev, common)) {
      const parent = excludeTrailingBackslash(nodePath.win32.dirname(target));
      if (parent === target) throw new AbortError(TEXTS.syncDirBrowseError);
      target = parent;
      const up = unixExtractFilePath(unixExcludeTrailingSlash(prev));
      if (up === prev || !up) throw new AbortError(TEXTS.syncDirBrowseError);
      prev = up;
    }

    const remainder = next.slice(prev.length);
    return includeTrailingBackslash(target) + remainder.replace(/\//g, '\\');
  }

  /**
   * SynchronizeBrowsing (ScpCommander.cpp:1494) — the whole gesture, including
   * both fallbacks.
   *
   * When the opposite directory does not exist, WinSCP offers to CREATE it;
   * declining turns synchronized browsing OFF rather than leaving it silently
   * broken. When no mapping exists at all it also turns off and says so. Both
   * are refusals with a visible consequence, which is why they are kept.
   *
   * Preset auto-selection is suppressed for the duration, because the panel is
   * being moved by the app rather than by the user.
   */
  async applySynchronizeBrowsing(spec) {
    const s = spec || {};
    const side = this.getSide(s.side);
    const prev = String(s.prevPath || this.prevPath[side] || '');
    const current = String(s.newPath || '');
    this.prevPath[side] = current;

    if (this.synchronisingBrowse || !this.synchronizeBrowsing) return { applied: false };
    if (!prev || prev === current) return { applied: false };
    if (this.localBrowserMode) return { applied: false, reason: 'localBrowser' };

    const allowRestore = this.allowTransferPresetAutoSelect;
    this.allowTransferPresetAutoSelect = false;
    this.synchronisingBrowse = true;
    try {
      const otherSide = side === SIDES.local ? SIDES.remote : SIDES.local;
      const otherPanel = this.panel(otherSide);
      const otherPath = otherPanel ? otherPanel.path : '';

      let target;
      try {
        target = side === SIDES.local
          ? this.synchronizeBrowsingLocal(prev, current, otherPath)
          : this.synchronizeBrowsingRemote(prev, current, otherPath);
      } catch (e) {
        // EAbort means "we do not know how to map this" — there is no fallback.
        this.synchronizeBrowsing = false;
        this.note({ kind: 'information', name: 'syncDirBrowseError', message: TEXTS.syncDirBrowseError });
        return { applied: false, disabled: true, error: e };
      }

      let exists = true;
      if (this.ops.directoryExists) {
        exists = await this.ops.directoryExists(otherSide, target) !== false;
      }

      if (!exists) {
        const answer = await this.confirm({
          name: 'syncDirBrowseCreate',
          kind: 'confirmation',
          message: TEXTS.syncDirBrowseCreate(target),
          buttons: ['yes', 'no'],
          helpKeyword: 'sync_dir_browse_error',
        });
        if (answer !== 'yes') {
          this.synchronizeBrowsing = false;
          return { applied: false, disabled: true, target };
        }
        if (this.ops.createDirectory) await this.ops.createDirectory(otherSide, target);
      }

      if (this.ops.changePath) await this.ops.changePath(otherSide, target);
      this.prevPath[otherSide] = target;
      return { applied: true, side: otherSide, target };
    } finally {
      this.synchronisingBrowse = false;
      this.allowTransferPresetAutoSelect = allowRestore;
    }
  }

  // ======================================================================
  // "can this command run right now" — the predicates the UI asks for
  // ======================================================================

  /**
   * One call the renderer can ask instead of reimplementing WinSCP's rules.
   * Returns { visible, enabled, reason } for the predicates that genuinely
   * live in CustomScpExplorer.cpp. Anything not listed here is not this
   * module's business and the caller is told so plainly.
   */
  commandState(name, context) {
    const c = context || {};
    const side = this.getSide(c.side);
    const yes = (extra) => ({ visible: true, enabled: true, reason: null, ...(extra || {}) });
    const no = (reason, extra) => ({ visible: true, enabled: false, reason, ...(extra || {}) });

    switch (name) {
      case 'selectedOperation':
        return this.enableSelectedOperation(side, c.filesOnly)
          ? yes() : no(TEXTS.nothingSelected);
      case 'focusedOperation':
        return this.enableFocusedOperation(side, c.filesOnly)
          ? yes() : no(TEXTS.nothingSelected);
      case 'panelEnabled':
        return this.dirViewEnabled(side) ? yes() : no(TEXTS.noSession);

      case 'copy':
      case 'move':
        if (this.localBrowserMode) return no('Both panels are local; use the local copy instead.');
        if (!this.hasAvailableTerminal()) return no(TEXTS.noSession);
        return this.enableSelectedOperation(side, false) ? yes() : no(TEXTS.nothingSelected);

      case 'delete':
        if (!this.dirViewEnabled(side)) return no(TEXTS.noSession);
        return this.enableSelectedOperation(side, false) ? yes() : no(TEXTS.nothingSelected);

      case 'remoteCopy':
      case 'remoteMove': {
        if (this.isSideLocalBrowser(side)) return { visible: false, enabled: false, reason: 'Remote panel only.' };
        if (!this.hasAvailableTerminal()) return no(TEXTS.noSession);
        if (name === 'remoteMove' && !this.capable('remoteMove')) {
          return no('This protocol cannot move files on the server.');
        }
        return this.enableSelectedOperation(side, false) ? yes() : no(TEXTS.nothingSelected);
      }

      case 'lock':
      case 'unlock': {
        if (this.isSideLocalBrowser(side)) return { visible: false, enabled: false, reason: 'Remote panel only.' };
        if (!this.capable('locking')) {
          return { visible: false, enabled: false, reason: 'This protocol has no file locking.' };
        }
        return this.enableSelectedOperation(side, false) ? yes() : no(TEXTS.nothingSelected);
      }

      case 'properties':
        if (!this.dirViewEnabled(side)) return no(TEXTS.noSession);
        return this.enableSelectedOperation(side, false) ? yes() : no(TEXTS.nothingSelected);

      case 'checksum':
        if (!this.hasAvailableTerminal()) return no(TEXTS.noSession);
        if (!this.canCalculateChecksum()) {
          return no('This protocol cannot compute checksums, and there is no shell session to do it with.');
        }
        return this.enableSelectedOperation(side, true) ? yes() : no(TEXTS.nothingSelected);

      case 'addLink':
      case 'editLink': {
        if (!this.canAddEditLink(side)) return no('This protocol cannot create symbolic links.');
        if (name === 'editLink' && !this.linkFocused()) return no('The focused item is not a link.');
        return yes();
      }

      case 'console':
        if (!this.hasAvailableTerminal()) return no(TEXTS.noSession);
        return (this.capable('anyCommand') || this.capable('secondaryShell'))
          ? yes() : no('This protocol cannot run remote commands.');

      case 'customCommandRemote':
        return this.customCommandRemoteAllowed()
          ? yes() : no('Remote custom commands need a shell session.');

      case 'paste':
        return this.canPasteFromClipBoard() ? yes() : no('There is nothing usable on the clipboard.');

      case 'synchronizeSelectedOnly':
        return this.synchronizeAllowSelectedOnly() ? yes() : no(TEXTS.nothingSelected);

      case 'queueEnabled':
        return yes({ checked: this.queueEnabled() });

      case 'closeSession':
        return this.canCloseSession(c.session) ? yes() : no('The last local browser cannot be closed.');

      default:
        return { visible: false, enabled: false, reason: `"${name}" is not a CustomScpExplorer predicate.` };
    }
  }

  // ======================================================================
  // internals
  // ======================================================================

  /**
   * The scratch folder's direct children, as file-list entries. Injectable so a
   * test can drive it without touching the disk; the default is the real read,
   * because the folder genuinely exists by the time this runs.
   */
  _temporaryDirectoryEntries(dir) {
    let list = typeof this.ops.listLocalDirectory === 'function'
      ? this.ops.listLocalDirectory(dir) : null;
    if (!Array.isArray(list)) list = nodeFs.readdirSync(dir);
    return list.map((e) => {
      const name = typeof e === 'string' ? e : String((e && e.name) || '');
      return { name, path: nodePath.win32.join(dir, name) };
    }).filter((e) => !!e.name);
  }

  async _call(name, ...args) {
    const fn = this.ops[name];
    if (typeof fn !== 'function') {
      throw new NotSupportedError(`The "${name}" operation is not wired into the explorer shell.`);
    }
    return fn.apply(this.ops, args);
  }
}

module.exports = {
  ExplorerShell,
  PanelState,
  resolveDropTarget,

  // errors
  AbortError,
  NotSupportedError,
  ConfirmationUnavailableError,

  // enums
  SIDES,
  OPERATIONS,
  DIRECTIONS,
  TRANSFER_TYPES,
  EXECUTE_FILE_BY,
  COMMAND_LIST_TYPE,
  COMMAND_STATE,
  QUEUE_OPERATIONS,
  QUEUE_ITEM_STATES,
  SELECT_MODES,
  COPY_OPTIONS,
  COPY_COMMAND_FLAGS,
  DIRECT_REMOTE_COPY,
  AUTO_SWITCH,
  ANY_MASK,
  TEXTS,

  // pure helpers, exported because the IPC layer and the tests need the same rules
  delimitFileNameMask,
  extractCommonPath,
  isTransferOperation,
  isCapable,
  isSessionCommand,
  stripInteractivePatterns,
  sameLocalPath,
  sameUnixPath,
  unixIncludeTrailingSlash,
  unixExcludeTrailingSlash,
  unixExtractFileName,
  unixExtractFilePath,
  includeTrailingBackslash,
  excludeTrailingBackslash,
};
