// shellintegration.js — dragging files between the remote panel and Windows
// Explorer, in both directions.
//
// Ported from:
//   vendor/winscp/source/dragext/DragExt.cpp        (the shell extension)
//   vendor/winscp/source/forms/CustomScpExplorer.cpp
//       RemoteFileControlDDDragDetect / DDDragFileName / DDFakeFileInitDrag /
//       DDGetTarget / RemoteFileControlDDEnd / RemoteFileControlDDTargetDrop /
//       DDDownload / AddDelayedDirectoryDeletion / DoDelayedDeletion /
//       DoWarnLackOfTempSpace
//   vendor/winscp/source/windows/GUITools.cpp        (StartCreationDirectoryMonitors…)
//   vendor/winscp/source/windows/WinConfiguration.cpp (DDExtInstalled / IsDDExtRunning)
//
// ---------------------------------------------------------------------------
// WHY this is the temp-directory branch, not the shell-extension one
// ---------------------------------------------------------------------------
// WinSCP has two ways of dragging a remote file into Explorer:
//
//  1. **The shell extension** (`dragext/`, DDFakeFile on). WinSCP drags a
//     hidden, empty, uniquely named directory `scpNNNNN`. Its in-process COM
//     ICopyHook — loaded into *Explorer* — sees the shell about to copy that
//     directory, writes the real drop destination into a shared memory block,
//     and returns IDNO so the shell copy never happens. WinSCP reads the
//     destination back and downloads straight into it. Nothing is ever staged.
//
//  2. **The temp-directory branch** (`FDDExtMapFile == NULL`, i.e. the
//     extension is not installed, is not running, or is one of the Windows 10
//     builds 17134–17762 where it is broken). WinSCP downloads into
//     `%TEMP%\scpNNNNN`, hands *those* files to the shell, and schedules the
//     directory for deletion `DDDeleteDelay` seconds later.
//
// An Electron application cannot be branch 1: an in-process COM shell extension
// has to be a native DLL that Explorer loads into its own address space, and
// there is no Electron surface for that. So this module implements branch 2 —
// which is WinSCP's own code path for exactly this situation, not a substitute
// invented here. `webContents.startDrag` is the drag source; the staged files
// are real files on disk. docs/protocol-gaps.md states what branch 1 did that
// this does not.
//
// One genuine behavioural difference remains, and it is recorded there too:
// WinSCP downloads when the user *drops*; `startDrag` requires the files to
// exist before the drag begins, so this downloads when the drag *starts*. A
// drag the user abandons therefore still transfers. `abort()` cleans up.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { validLocalFileName } = require('./queue');

let electron = null;
try { electron = require('electron'); } catch { /* headless tests */ }

/** DragExt.h — the dummy directory prefix, kept so the names still read the same. */
const FAKE_DIR_PREFIX = 'scp';
const FAKE_DIR_PREFIX_LEN = 3;

/** WinConfiguration.cpp:558 — `FDDDeleteDelay = 120` seconds. */
const DEFAULT_DELETE_DELAY = 120;
/** WinConfiguration.cpp:536 — `FDDExtTimeout = MSecsPerSec` (one second). */
const DEFAULT_EXT_TIMEOUT = 1000;
/** CustomScpExplorer.cpp:8431 — the delayed-deletion timer ticks every 10s. */
const DELETION_TICK = 10000;

class DragError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'DragError';
    this.code = code || 'DRAG';
    if (detail) this.detail = detail;
  }
}

// ===========================================================================
// Names
// ===========================================================================

/**
 * UniqTempDir (GUITools.cpp:903) with identity `scp`: minutes and milliseconds
 * make the five digits, which is why the cleanup mask is `scp?????`.
 */
function uniqDragTempDir(baseDir, opts) {
  const o = opts || {};
  const exists = o.exists || ((p) => fs.existsSync(p));
  const now = o.now || (() => new Date());
  for (let attempt = 0; attempt < 1000; attempt++) {
    const d = now();
    // The original spins on the clock until the name is free. Nudging the
    // millisecond field instead keeps the name inside the `scp?????` mask the
    // cleanup scan matches, which spinning on a stopped clock would not.
    const ms = (d.getMilliseconds() + attempt) % 1000;
    const stamp = String(d.getMinutes()).padStart(2, '0') + String(ms).padStart(3, '0');
    const dir = path.join(baseDir, FAKE_DIR_PREFIX + stamp);
    if (!exists(dir)) return dir;
  }
  throw new DragError('Cannot create temporary directory.', 'CREATE_TEMP_DIR');
}

/**
 * DragExt.cpp:740 — the extension only reacted to a source file whose name
 * starts with `scp`. Kept because the same test decides whether a directory
 * found in the temp area is one of ours.
 */
function isFakeTransferDirectory(name) {
  return String(path.basename(String(name))).slice(0, FAKE_DIR_PREFIX_LEN).toLowerCase() === FAKE_DIR_PREFIX;
}

/**
 * StartCreationDirectoryMonitorsOnEachDrive (GUITools.cpp:710) reads the
 * DDDrives preference: a comma list where an entry beginning with `-` excludes
 * that drive letter and anything else is an extra path to watch.
 */
function parseDDDrives(value) {
  const excluded = [];
  const extra = [];
  for (const raw of String(value || '').split(',')) {
    const s = raw.trim();
    if (!s) continue;
    if (s[0] === '-') {
      const rest = s.slice(1).trim();
      if (rest) excluded.push(rest[0].toUpperCase());
    } else {
      extra.push(s);
    }
  }
  return { excluded, extra };
}

// ===========================================================================
// Drop-effect decisions
// ===========================================================================

// The DROPEFFECT_* bits, as the shell defines them.
const DROPEFFECT = { NONE: 0, COPY: 1, MOVE: 2, LINK: 4 };

/**
 * CustomScpExplorer.cpp:8354. The drag result the control reports is `copy`,
 * `move` or `invalid`; `invalid` happens both when the extension intercepted
 * the drop and when the user let go over somewhere undroppable, and WinSCP
 * cannot tell those apart. Its rule: prefer **copy** unless the last drop
 * effect actually carried the MOVE bit. Preferring copy is a safety decision —
 * guessing "move" wrongly deletes the user's remote file.
 */
function dropEffectOperation(dragResult, lastDropEffect) {
  switch (dragResult) {
    case 'copy': return 'copy';
    case 'move': return 'move';
    case 'invalid':
      return (Number(lastDropEffect) & DROPEFFECT.MOVE) ? 'move' : 'copy';
    default: return null;
  }
}

/**
 * RemoteFileControlDDTargetDrop (CustomScpExplorer.cpp:8554) for a drop that
 * lands back on a remote panel or on a session tab. A MOVE onto the *same*
 * session is a remote move; onto another session it is always a copy, because
 * a cross-server move would have to delete from a server the drag did not
 * originate on.
 */
function remoteDropOperation(lastDropEffect, opts) {
  const o = opts || {};
  const effect = Number(lastDropEffect);
  if (o.ontoSessionTab) {
    if (!o.targetAvailable) return null;
    return (effect === DROPEFFECT.MOVE && o.sameSession) ? 'remoteMove' : 'remoteCopy';
  }
  if (effect === DROPEFFECT.MOVE) return 'remoteMove';
  if (effect === DROPEFFECT.COPY) return 'remoteCopy';
  return null;
}

/**
 * WinSCP's DDTransferConfirmation is a three-state preference (auto/on/off).
 * `off` suppresses the transfer-options dialog for drag and drop only — a drop
 * is a gesture, not a command, and asking every time makes it useless. `auto`
 * means "still asking, and the first time you turn it off we will say so".
 */
function transferConfirmationSuppressed(setting) {
  return normalizeTriState(setting) === 'off';
}

function normalizeTriState(v) {
  if (v === true || v === 'on' || v === 1) return 'on';
  if (v === false || v === 'off' || v === 0) return 'off';
  return 'auto';
}

/**
 * DoWarnLackOfTempSpace (CustomScpExplorer.cpp:7097). The warning fires when
 * the free space on the staging drive is below `size * ratio`; the user can
 * continue anyway, and "never ask again" turns the whole warning off.
 *
 * Returns null when there is nothing to warn about, so the caller does not have
 * to know the rule.
 */
function warnLackOfTempSpace(stagingPath, requiredSize, opts) {
  const o = opts || {};
  if (o.enabled === false) return null;
  if (!(Number(requiredSize) >= 0)) return null;      // -1 means "a directory, size unknown"
  const free = typeof o.freeSpace === 'function' ? o.freeSpace(stagingPath) : o.freeSpace;
  if (free === undefined || free === null) return null;
  // WinConfiguration.cpp:534 — FDDWarnLackOfTempSpaceRatio = 1.1.
  const ratio = Number(o.ratio) > 0 ? Number(o.ratio) : 1.1;
  const requiredWithReserve = Math.floor(Number(requiredSize) * ratio);
  if (Number(free) >= requiredWithReserve) return null;
  return {
    stagingPath,
    freeSpace: Number(free),
    requiredSize: Number(requiredSize),
    requiredWithReserve,
    message:
      'Too little space on temporary drive!\n\nWhen dragging files from a remote directory, files are ' +
      `downloaded first to the temporary directory '${stagingPath}'. There are ${formatBytes(free)} free on the ` +
      `drive. Total size of dragged files is ${formatBytes(requiredSize)}.\n\nNote: the temporary directory can ` +
      'be changed in Preferences.\n\nDo you still want to download the files?',
  };
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x.toFixed(1)} ${units[i]}`;
}

/**
 * DD_TARGET_UNKNOWN / DRAGEXT_TARGET_UNKNOWN2 (TextsWin1.rc:99, 33). WinSCP
 * shows a different explanation depending on whether the shell extension is
 * meant to be doing the work. This port is always in the "no extension"
 * situation, so the message names the temporary-folder mode by default — but
 * the branch is kept, because it is the honest thing to say if the extension
 * ever becomes available.
 */
function targetUnknownMessage(opts) {
  const o = opts || {};
  if (o.extensionInstalled && !o.extensionBroken) {
    return 'WinSCP Material was not able to detect the folder where the dragged file(s) were dropped. ' +
      'Either you did not drop the file(s) on a regular folder (for example Windows File Explorer), or the ' +
      'drag & drop shell extension has not been loaded yet.';
  }
  return 'WinSCP Material was not able to detect the folder where the dragged file(s) were dropped. ' +
    'Files dragged out of the remote panel are staged in a temporary folder and copied from there by ' +
    'Windows, so the drop target must be somewhere Windows itself can copy to.';
}

// ===========================================================================
// Delayed deletion of the staging folder
// ===========================================================================

/**
 * AddDelayedDirectoryDeletion / DoDelayedDeletion (CustomScpExplorer.cpp:8506).
 * The staging directory cannot be removed at the moment the drag ends: Explorer
 * may still be copying out of it. WinSCP therefore queues it with a deadline,
 * retries on a 10-second timer, and keeps retrying until the removal succeeds.
 */
class DelayedDeletion extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.entries = [];                     // { dir, dueAt }
    this.tick = o.tick || DELETION_TICK;
    this.now = o.now || (() => Date.now());
    this.remove = o.remove || ((p) => { fs.rmSync(p, { recursive: true, force: true }); });
    this.exists = o.exists || ((p) => fs.existsSync(p));
    this.timer = null;
  }

  add(dir, secondsDelay) {
    const delay = secondsDelay === undefined ? DEFAULT_DELETE_DELAY : Number(secondsDelay);
    this.entries.push({ dir, dueAt: this.now() + delay * 1000 });
    this._schedule();
    return this.entries.length;
  }

  _schedule() {
    if (this.timer || this.entries.length === 0) return;
    this.timer = setInterval(() => this.run(), this.tick);
    if (this.timer.unref) this.timer.unref();
  }

  /** `force` is the original's `Sender == NULL` — run every pending deletion now. */
  run(force) {
    const now = this.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!force && now < e.dueAt) continue;
      let gone = false;
      try { this.remove(e.dir); gone = !this.exists(e.dir); } catch { gone = false; }
      if (gone) { this.entries.splice(i, 1); this.emit('deleted', e.dir); }
    }
    if (this.entries.length === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
    return this.entries.length;
  }

  /** Shutdown: try everything once, whatever its deadline, then stop the timer. */
  flush() {
    const left = this.run(true);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return left;
  }
}

// ===========================================================================
// Dragging OUT: remote panel -> Explorer
// ===========================================================================

/**
 * One drag gesture. Lifecycle mirrors the original's event order:
 *
 *   begin()            RemoteFileControlDDDragDetect  — make the staging dir
 *   add(file)          RemoteFileControlDDDragFileName — name and size each item
 *   stage()            RemoteFileControlDDTargetDrop's temp branch — download
 *   startDrag(wc)      hand the staged paths to the shell
 *   complete()         AddDelayedDirectoryDeletion
 *   abort()            RemoteFileControlDDEnd's __finally — remove it now
 */
class DragOut {
  /**
   * @param {object} opts
   *   tempRoot   - where staging directories are made (WinConfiguration's temp)
   *   download   - async ({ items, targetDir, move, copyParam }) => void
   *   deletion   - a shared DelayedDeletion
   *   copyParam  - the current transfer settings, for the file-name rules
   */
  constructor(opts) {
    const o = opts || {};
    this.tempRoot = o.tempRoot || path.join(os.tmpdir(), 'winscp-material');
    this.download = o.download || null;
    this.deletion = o.deletion || new DelayedDeletion(o);
    this.copyParam = o.copyParam || { replaceInvalidChars: true, invalidCharsReplacement: '_' };
    this.deleteDelay = o.deleteDelay === undefined ? DEFAULT_DELETE_DELAY : o.deleteDelay;
    this.mkdir = o.mkdir || ((p) => fs.mkdirSync(p, { recursive: true }));
    this.exists = o.exists || ((p) => fs.existsSync(p));
    this.now = o.now;

    this.dir = null;
    this.items = [];
    /** -1 once a directory is included, because its size is not known up front. */
    this.totalSize = 0;
    this.staged = false;
  }

  begin() {
    // The original recreates the list on every drag detect, "sometimes we do
    // not get DDEnd so the list is not released".
    this.items = [];
    this.totalSize = 0;
    this.staged = false;
    this.dir = uniqDragTempDir(this.tempRoot, { exists: this.exists, now: this.now });
    return this.dir;
  }

  /**
   * RemoteFileControlDDDragFileName. The local name goes through the transfer
   * settings' invalid-character replacement, because the remote name may hold
   * characters Windows will not accept — and the file the shell copies out must
   * be the one the user sees named in the drag.
   */
  add(file) {
    if (!this.dir) throw new DragError('begin() must be called before add().', 'DRAG_STATE');
    const f = file || {};
    const remoteName = f.name || f.fileName || '';
    const local = this.copyParam.replaceInvalidChars === false
      ? remoteName
      : validLocalFileName(remoteName, this.copyParam.invalidCharsReplacement);
    // Preserving unusual remote names must not turn the shell payload into a
    // relative or absolute path outside the private staging directory.
    if (!local || local === '.' || local === '..' || /[\\/]/.test(local)) {
      throw new DragError('The dragged name is not a safe local file name.', 'DRAG_UNSAFE_NAME');
    }

    if (this.totalSize >= 0) {
      if (f.isDirectory) this.totalSize = -1;
      else this.totalSize += Number(f.size) || 0;
    }

    const item = {
      remotePath: f.fullName || f.path || remoteName,
      remoteName,
      localName: local,
      localPath: path.join(this.dir, local),
      isDirectory: !!f.isDirectory,
      size: Number(f.size) || 0,
    };
    this.items.push(item);
    return item;
  }

  /** The temp-space warning, evaluated against the drive the staging dir is on. */
  spaceWarning(opts) {
    return warnLackOfTempSpace(this.dir, this.totalSize, opts);
  }

  /**
   * Downloads into the staging directory. `move` maps to WinSCP's `cpDelete`,
   * i.e. the remote copy is removed once the transfer succeeds; `cpTemporary`
   * is implicit because the target is a temp folder.
   */
  async stage(opts) {
    const o = opts || {};
    if (!this.dir) throw new DragError('begin() must be called before stage().', 'DRAG_STATE');
    if (this.items.length === 0) throw new DragError('Nothing was dragged.', 'DRAG_EMPTY');
    if (!this.download) throw new DragError('No download function was provided.', 'DRAG_NO_DOWNLOAD');

    try { this.mkdir(this.dir); }
    catch (e) {
      throw new DragError(
        `Cannot create temporary directory '${this.dir}'. You may change the root directory used to store ` +
        'temporary files in Preferences.', 'CREATE_TEMP_DIR', e.message);
    }

    await this.download({
      items: this.items.slice(),
      targetDir: this.dir,
      move: !!o.move,
      temporary: true,
      copyParam: o.copyParam || this.copyParam,
    });
    this.staged = true;
    return this.items.map((i) => i.localPath);
  }

  /** The paths handed to the shell. Only files that really exist are offered. */
  payload() {
    if (!this.staged) return [];
    return this.items.map((i) => i.localPath).filter((p) => this.exists(p));
  }

  /**
   * Hands the staged files to Electron's drag source. A single file uses
   * `file`, several use `files`; an icon is mandatory for the call to work at
   * all, so a caller that has none gets a clear error rather than a silent
   * no-op drag.
   */
  startDrag(webContents, opts) {
    const o = opts || {};
    const files = this.payload();
    if (files.length === 0) throw new DragError('Nothing was staged to drag.', 'DRAG_EMPTY');
    if (!webContents || typeof webContents.startDrag !== 'function') {
      throw new DragError('No drag source is available.', 'DRAG_NO_SOURCE');
    }
    const icon = o.icon || (electron && electron.nativeImage
      ? electron.nativeImage.createFromPath(o.iconPath || '')
      : null);
    if (!icon || (typeof icon.isEmpty === 'function' && icon.isEmpty())) {
      throw new DragError('A drag icon is required to start a drag.', 'DRAG_NO_ICON');
    }
    const item = files.length === 1 ? { file: files[0], icon } : { files, icon };
    webContents.startDrag(item);
    return files;
  }

  /** The drag ended normally: the shell may still be reading, so queue removal. */
  complete() {
    if (!this.dir) return null;
    const dir = this.dir;
    this.deletion.add(dir, this.deleteDelay);
    this.dir = null;
    this.items = [];
    this.staged = false;
    return dir;
  }

  /** The drag was abandoned or failed: nothing is copying, so remove it now. */
  abort() {
    if (!this.dir) return null;
    const dir = this.dir;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { this.deletion.add(dir, 0); }
    this.dir = null;
    this.items = [];
    this.staged = false;
    return dir;
  }
}

// ===========================================================================
// Dragging IN: Explorer -> remote panel
// ===========================================================================

/**
 * The incoming half. The renderer receives the drop and passes the absolute
 * paths here; everything about *what* the drop means is decided in the main
 * process so the renderer cannot be talked into an upload by a stray event.
 *
 * The classification is what WinSCP's upload path needs: which entries are
 * directories (they recurse), what the whole thing weighs, and which entries
 * simply are not there any more, which is common when the source was a
 * compressed folder or a virtual shell location.
 */
function classifyIncomingDrop(paths, opts) {
  const o = opts || {};
  const stat = o.stat || ((p) => fs.statSync(p));
  const files = [];
  const directories = [];
  const missing = [];
  let totalSize = 0;
  let anyDirectory = false;

  for (const raw of paths || []) {
    const p = String(raw || '');
    if (!p) continue;
    let st;
    try { st = stat(p); } catch { missing.push(p); continue; }
    if (st.isDirectory()) {
      anyDirectory = true;
      directories.push({ path: p, name: path.basename(p), isDirectory: true });
    } else {
      const size = Number(st.size) || 0;
      totalSize += size;
      files.push({ path: p, name: path.basename(p), isDirectory: false, size });
    }
  }

  return {
    files,
    directories,
    missing,
    items: [...directories, ...files],
    // A directory makes the total unknowable without walking it, which is
    // exactly why WinSCP marks it -1 rather than reporting a wrong number.
    totalSize: anyDirectory ? -1 : totalSize,
  };
}

/**
 * What an incoming drop should do. Explorer offers copy and move; a move out of
 * Explorer deletes the local original once the upload succeeds, so — as with
 * the outgoing direction — anything ambiguous resolves to copy.
 *
 * `allowMove` is WinSCP's `DDAllowMove = !DDDisableMove`
 * (CustomScpExplorer.cpp:1150), whose preference defaults to *false* — so a
 * move is allowed unless the user turned it off, and omitting the option here
 * must mean the same rather than quietly downgrading every move. With move
 * disabled a MOVE drop becomes a copy rather than being refused, which is what
 * keeps a mis-modified drag from deleting a local file.
 */
function incomingDropOperation(lastDropEffect, opts) {
  const o = opts || {};
  const effect = Number(lastDropEffect);
  if (effect === DROPEFFECT.NONE) return null;
  if ((effect & DROPEFFECT.MOVE) && o.allowMove !== false) return 'move';
  return 'copy';
}

/**
 * A drop must never be accepted onto a place the session cannot write. The
 * adapter's `caps` is the authority — the same rule the rest of the app follows
 * — so a read-only backend refuses the drop instead of starting an upload that
 * will fail halfway.
 */
function canAcceptDrop(caps, opts) {
  const c = caps || {};
  const o = opts || {};
  if (o.readOnly) return { ok: false, reason: 'The session is read-only.' };
  if (c.upload === false) return { ok: false, reason: 'This protocol cannot upload files.' };
  if (o.hasDirectories && c.mkdir === false) {
    return { ok: false, reason: 'This protocol cannot create directories, so a folder cannot be uploaded.' };
  }
  return { ok: true };
}

// ===========================================================================
// Shell-extension presence (WinConfiguration.cpp:1770-1826)
// ===========================================================================

/**
 * DDExtInstalled / IsDDExtRunning / IsDDExtBroken. There is no shell extension
 * in this port, so `installed` is false and stays false — reported honestly
 * rather than by pretending the query failed. `broken` keeps the original's
 * Windows-build test because the *reason* it exists (builds 17134–17762 load
 * the hook but never call it) is a fact about Windows, not about WinSCP, and
 * the preferences UI explains the temp-folder mode with it.
 */
function dragExtensionStatus(opts) {
  const o = opts || {};
  const build = Number(o.windowsBuild) || windowsBuildNumber();
  return {
    installed: false,
    running: false,
    // WinConfiguration.cpp:1824.
    brokenOnThisWindows: build >= 17134 && build < 17763,
    windowsBuild: build,
    mode: 'temporary-folder',
    extTimeout: o.extTimeout === undefined ? DEFAULT_EXT_TIMEOUT : o.extTimeout,
  };
}

function windowsBuildNumber() {
  if (process.platform !== 'win32') return 0;
  const m = /^\d+\.\d+\.(\d+)/.exec(os.release());
  return m ? Number(m[1]) : 0;
}

module.exports = {
  FAKE_DIR_PREFIX, DROPEFFECT, DEFAULT_DELETE_DELAY, DEFAULT_EXT_TIMEOUT,
  uniqDragTempDir, isFakeTransferDirectory, parseDDDrives,
  dropEffectOperation, remoteDropOperation, transferConfirmationSuppressed, normalizeTriState,
  warnLackOfTempSpace, formatBytes, targetUnknownMessage,
  DelayedDeletion, DragOut,
  classifyIncomingDrop, incomingDropOperation, canAcceptDrop,
  dragExtensionStatus, windowsBuildNumber,
  DragError,
};
