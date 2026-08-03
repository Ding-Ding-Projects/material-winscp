// terminal.js — the session orchestrator.
//
// Port of core/Terminal.cpp (TTerminal, 10,449 lines): the object every remote
// file operation in WinSCP actually goes through. `session.js` owns the
// connection, the prompts and the log; this file owns what happens *after* you
// are connected — the operation lifecycle, the directory caches, per-file error
// handling, recursion, and the accounting that tells the user what happened.
//
// The division of labour, so the two files never fork:
//
//   session.js   connects, answers security questions, keeps the log,
//                keeps a flat listing cache for the panels
//   terminal.js  runs operations against `session.adapter`, maintains the
//                WinSCP directory caches (timestamped, sub-directory aware,
//                plus the directory-change cache), and asks the user the
//                operational questions — retry/skip/abort, overwrite, delete
//
// Terminal never caches behind session's back: every invalidation here also
// calls `session.invalidate()` / `session.clearCache()`, so the panel cache and
// the operation cache can never disagree about what a directory contains.
//
// Three things about the translation from C++ are worth stating once:
//
//   * WinSCP's control flow is exceptions plus `do { } while (Retry())`. That
//     survives translation intact — the loops here are the same loops, awaited.
//   * `QueryUser` is a modal VCL dialog. Here it is a promise the renderer
//     answers. A *dismissed* prompt is never read as "yes": see `_answerQuery`.
//   * `TCallbackGuard` exists to stop a GUI callback from re-entering a
//     terminal that is mid-fatal-error. Node has no such re-entrancy, so the
//     guard is not ported; the callbacks are plain emits.
'use strict';

const { EventEmitter } = require('events');

const { FileMask, isEffectiveFileNameMask } = require('./masks');
const { getPartialFileExtLen } = require('./remotefiles');

// ===========================================================================
// Unix path helpers — RemoteFiles.cpp
//
// These are deliberately NOT the adapter's path helpers: WinSCP's remote path
// arithmetic is always POSIX, including when the far side is a local Windows
// directory reached through the local backend, and the trailing-slash rules
// below are load-bearing for the caches (a cached "/a" and "/a/" must be the
// same entry, but "/" must never become "").
// ===========================================================================

/** Adds a trailing slash unless there is one — and never turns "" into "/". */
function includeTrailingSlash(p) {
  const s = String(p === undefined || p === null ? '' : p);
  return (s !== '' && !s.endsWith('/')) ? s + '/' : s;
}

/** Strips a trailing slash, keeping "/" for the root. */
function excludeTrailingSlash(p) {
  const s = String(p === undefined || p === null ? '' : p);
  if (s === '' || s === '/' || !s.endsWith('/')) return s;
  return s.slice(0, -1);
}

/** "/a/b" and "/a/b/" are the same directory. */
function samePath(a, b) {
  return includeTrailingSlash(a) === includeTrailingSlash(b);
}

/** True when `child` is `parent` or lives underneath it. */
function isChildPath(parent, child) {
  // An empty path is invalid, not a root alias. Treating it as a prefix would
  // make a malformed subtree invalidation match every cached directory.
  if (parent === undefined || parent === null || String(parent) === '') return false;
  const p = includeTrailingSlash(parent);
  return includeTrailingSlash(child).slice(0, p.length) === p;
}

/** The containing directory, WITHOUT a trailing slash. "" when there is none. */
function extractFileDir(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  if (i > 0) return s.slice(0, i);
  return i === 0 ? '/' : '';
}

/** The containing directory, WITH its trailing slash. "" when there is none. */
function extractFilePath(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i + 1) : '';
}

function extractFileName(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function isAbsolutePath(p) {
  return String(p || '').startsWith('/');
}

function isRootPath(p) {
  return !p || p === '/';
}

/** "." and ".." are directory entries, not files you can operate on. */
function isRealFile(name) {
  return name !== '.' && name !== '..';
}

/**
 * TTerminal::ExpandFileName. Note the single special case WinSCP implements
 * and the TODO it leaves next to it: ".." resolves one level, but "../.." does
 * not. Reproduced rather than improved, because the directory-change cache is
 * keyed on the result and a "better" answer here silently invalidates keys
 * written by the original.
 */
function expandFileName(path, basePath) {
  let p = excludeTrailingSlash(path);
  if (!isAbsolutePath(p) && basePath) {
    if (p === '..') {
      p = excludeTrailingSlash(extractFilePath(excludeTrailingSlash(basePath)));
    } else {
      p = includeTrailingSlash(basePath) + p;
    }
  }
  return p;
}

/** RemoteFiles.cpp AbsolutePath(Base, Path). */
function absolutePath(base, path) {
  if (!path) return base;
  if (path.startsWith('/')) return excludeTrailingSlash(path);
  return excludeTrailingSlash(includeTrailingSlash(base) + path);
}

// ===========================================================================
// File-name masking — FileMasks.cpp MaskFilePart / MaskFileName
//
// Used by "Move to…" and "Duplicate…" where the target is given as a mask
// ("*.bak", "backup-*.*"), and by the recycle bin, which stamps the time into
// the name so two deletions of the same file do not collide.
// ===========================================================================

/**
 * Apply one mask part (name or extension). `\` escapes the next character,
 * `*` consumes the rest of the part, `?` consumes one character.
 */
function maskFilePart(part, mask) {
  let result = '';
  let restStart = 0;
  let delim = false;
  let masked = false;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === '\\' && !delim) { delim = true; masked = false; continue; }
    if (c === '*' && !delim) {
      result += part.slice(restStart);
      restStart = part.length;
      masked = true;
      continue;
    }
    if (c === '?' && !delim) {
      if (restStart < part.length) { result += part[restStart]; restStart++; }
      masked = true;
      continue;
    }
    result += c;
    restStart++;
    delim = false;
  }
  return { result, masked };
}

/**
 * TFileMasks' MaskFileName. Only a dot that is NOT the first character
 * separates name from extension, so ".bashrc" masked with "*.bak" becomes
 * ".bashrc.bak" and not "..bak".
 */
function maskFileName(fileName, mask) {
  if (!isEffectiveFileNameMask(mask)) return fileName;
  let name = String(fileName);
  const p = mask.lastIndexOf('.');
  if (p >= 0) {
    const p2 = name.lastIndexOf('.');
    let ext = p2 > 0 ? name.slice(p2 + 1) : '';
    ext = maskFilePart(ext, mask.slice(p + 1)).result;
    if (p2 > 0) name = name.slice(0, p2);
    name = maskFilePart(name, mask.slice(0, p)).result;
    if (ext !== '') name += '.' + ext;
    return name;
  }
  return maskFilePart(name, mask).result;
}

/**
 * The `*-yyyymmdd-hhnnss.*` mask TTerminal::RecycleFile stamps onto a name on
 * its way into the bin (Terminal.cpp:4318).
 *
 * The timestamp is not decoration: the bin is a flat directory, so recycling
 * `config` twice would otherwise overwrite the first copy with the second and
 * destroy the very file the bin exists to keep. It lives out here rather than
 * inside the method because `transfer.js` recycles an about-to-be-overwritten
 * file on the upload path and must produce byte-identical names — two
 * independently written stamps would drift the first time one of them was
 * tidied up.
 */
function recycleFileMask(when) {
  const stamp = new Date(when === undefined ? Date.now() : when);
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return `*-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.*`;
}

// ===========================================================================
// Constants — the enums Terminal.cpp switches on
// ===========================================================================

/** TFileOperation. */
const OPERATIONS = Object.freeze({
  none: 'none',
  copy: 'copy',
  move: 'move',
  delete: 'delete',
  setProperties: 'setProperties',
  rename: 'rename',
  customCommand: 'customCommand',
  calculateSize: 'calculateSize',
  remoteMove: 'remoteMove',
  remoteCopy: 'remoteCopy',
  getProperties: 'getProperties',
  calculateChecksum: 'calculateChecksum',
  lock: 'lock',
  unlock: 'unlock',
});

/** TCancelStatus — ordered, because SetCancelAtLeast compares them. */
const CANCEL = Object.freeze({
  continue: 0,
  cancelFile: 1,
  cancel: 2,
  cancelTransfer: 3,
  remoteAbort: 4,
});

/** The answers a query can come back with (the qaXxx set we actually use). */
const ANSWERS = Object.freeze({
  yes: 'yes',
  no: 'no',
  ok: 'ok',
  cancel: 'cancel',
  abort: 'abort',
  retry: 'retry',
  skip: 'skip',
  all: 'all',
  yesToAll: 'yesToAll',
  noToAll: 'noToAll',
  neverAskAgain: 'neverAskAgain',
});

/** TBatchOverwrite, for the batch rename/move confirmations. */
const BATCH = Object.freeze({ no: 'no', all: 'all', none: 'none' });

/** dfXxx — FileSystems.h. */
const DELETE_FLAGS = Object.freeze({
  noRecursive: 0x01,
  alternative: 0x02,
  forceDelete: 0x04,
});

/** csXxx — Terminal.h, for CalculateFilesSize. */
const CALC_FLAGS = Object.freeze({
  ignoreErrors: 0x01,
  stopOnFirstFile: 0x02,
  disallowTemporaryTransferFiles: 0x04,
});

/** folXxx — the file-operation-loop flags. */
const LOOP_FLAGS = Object.freeze({
  none: 0x00,
  allowSkip: 0x01,
  retryOnFatal: 0x02,
});

/** ropXxx — Reopen() parameters. */
const REOPEN_FLAGS = Object.freeze({ noReadDirectory: 0x02 });

const SIDES = Object.freeze({ local: 'local', remote: 'remote' });

// ===========================================================================
// Exception classification — Exceptions.h
//
// WinSCP's whole error strategy is "which base class is this?": EFatal means
// the connection is gone and the operation may be resumed after reconnecting;
// ESkipFile means this one file is out and the loop continues; EAbort means
// the user said stop and nothing more is reported.
// ===========================================================================

class TerminalError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TerminalError';
    if (cause) this.cause = cause;
  }
}

/** EFatal — the session is (or should be treated as) gone. */
class FatalError extends TerminalError {
  constructor(message, cause) {
    super(message, cause);
    this.name = 'FatalError';
    this.fatal = true;
    // DoQueryReopen asks once per fatal error and remembers it, so a fatal
    // error that bubbles through several nested loops does not produce several
    // "reconnect?" dialogs for the same lost connection.
    this.reopenQueried = false;
  }
}

/** ESkipFile — this file is skipped, the operation continues. */
class SkipFileError extends TerminalError {
  constructor(message, cause) {
    super(message, cause);
    this.name = 'SkipFileError';
    this.skipFile = true;
  }
}

/** EAbort — the user cancelled. Never reported as an error to the user. */
class AbortError extends TerminalError {
  constructor(message) {
    super(message || 'Operation cancelled.');
    this.name = 'AbortError';
    this.aborted = true;
  }
}

/** ECommand — a command failed and the user has already been told. */
class CommandFailedError extends TerminalError {
  constructor(message, cause) {
    super(message, cause);
    this.name = 'CommandFailedError';
  }
}

/**
 * Error codes and messages that mean "the connection is gone", so an error
 * raised by ssh2 / basic-ftp / undici is classified the way WinSCP classifies
 * one raised by PuTTY. Anything not on this list is a per-file error and gets
 * retry/skip/abort, which is the safe default: retrying a per-file error costs
 * one round trip, whereas treating a genuine protocol error as fatal tears
 * down a working session.
 */
const FATAL_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTCONN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET',
  'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_CLOSED', 'NOT_CONNECTED',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET',
]);

const FATAL_PATTERN =
  /(connection (?:was |has been )?(?:lost|closed|reset|refused|aborted)|not connected|socket hang ?up|broken pipe|no connection|disconnected)/i;

/** 'fatal' | 'skip' | 'abort' | 'error' */
function classifyException(e) {
  if (!e) return 'error';
  if (e instanceof AbortError || e.aborted === true) return 'abort';
  if (e instanceof SkipFileError || e.skipFile === true) return 'skip';
  if (e instanceof FatalError || e.fatal === true) return 'fatal';
  if (e.code && FATAL_CODES.has(e.code)) return 'fatal';
  if (typeof e.message === 'string' && FATAL_PATTERN.test(e.message)) return 'fatal';
  return 'error';
}

function isFatal(e) { return classifyException(e) === 'fatal'; }

// ===========================================================================
// OperationProgress — FileOperationProgress.cpp
//
// The single object an operation reports through and is cancelled through. The
// counters are the "operation finished" accounting the summary dialog reads.
// ===========================================================================

class OperationStatistics {
  constructor() {
    this.filesUploaded = 0;
    this.filesDownloaded = 0;
    this.filesDeletedLocal = 0;
    this.filesDeletedRemote = 0;
    this.totalUploaded = 0;
    this.totalDownloaded = 0;
  }
}

class OperationProgress {
  constructor(onProgress, onFinished) {
    this._onProgress = onProgress || (() => {});
    this._onFinished = onFinished || (() => {});

    this.operation = OPERATIONS.none;
    this.side = SIDES.remote;
    this.count = 0;
    this.fileName = '';
    this.fullFileName = '';
    this.directory = '';
    this.temp = false;

    this.inProgress = false;
    this.done = false;
    this.suspended = false;
    this.cancel = CANCEL.continue;
    this.skipToAll = false;
    this.batchOverwrite = BATCH.no;

    this.localSize = 0;
    this.transferSize = 0;
    this.transferredSize = 0;
    this.skippedSize = 0;
    this.totalSize = 0;
    this.totalSizeSet = false;
    this.totalTransferred = 0;
    this.totalSkipped = 0;

    this.filesFinished = 0;
    this.filesFinishedSuccessfully = 0;

    this.startTime = 0;
    this.cpsLimit = 0;
    this.statistics = new OperationStatistics();
  }

  /** Transfers are the operations that move bytes; the rest only move names. */
  isTransfer() {
    return this.operation === OPERATIONS.copy || this.operation === OPERATIONS.move;
  }

  start(operation, side, count, options) {
    const o = options || {};
    // DoClear(Batch) — Start() clears the *batch* state as well as the transfer
    // state. Without this a progress object reused for a second operation
    // carries "skip all" (and "overwrite all") into it, and every file of the
    // new operation is silently skipped because of an answer the user gave to
    // a question about different files.
    this.transferSize = 0;      // bypass the ClearTransfer accounting check
    this._clearTransfer();
    this.fileName = '';
    this.fullFileName = '';
    this.skipToAll = false;
    this.batchOverwrite = BATCH.no;
    this.totalTransferred = 0;
    this.totalSkipped = 0;
    this.totalSize = 0;
    this.totalSizeSet = false;
    this.suspended = false;
    this.operation = operation;
    this.side = side || SIDES.remote;
    this.count = Number(count) || 0;
    this.inProgress = true;
    this.done = false;
    this.cancel = CANCEL.continue;
    this.directory = o.directory || '';
    this.temp = !!o.temp;
    this.cpsLimit = Number(o.cpsLimit) || 0;
    this.startTime = o.now === undefined ? Date.now() : o.now;
    this.filesFinished = 0;
    this.filesFinishedSuccessfully = 0;
    if (o.statistics) this.statistics = o.statistics;
    this._progress();
  }

  /**
   * Stop() folds any bytes of a half-finished file into "skipped" before the
   * final progress event, so a cancelled transfer does not report a total that
   * silently omits the file it gave up on.
   */
  stop() {
    this._clearTransfer();
    this.inProgress = false;
    this.done = true;
    this._progress();
  }

  _clearTransfer() {
    if (this.transferSize > 0 && this.transferredSize < this.transferSize) {
      this.totalSkipped += this.transferSize - this.transferredSize;
    }
    this.localSize = 0;
    this.transferSize = 0;
    this.transferredSize = 0;
    this.skippedSize = 0;
  }

  /**
   * TFileOperationProgressType::SetFile. Callers pass a full remote path (the
   * operations need one for the log and the action record), but the progress
   * surface shows a file name — so for the remote side the name is split back
   * out, exactly as the C++ does, rather than showing "/very/long/path" where
   * a file name belongs.
   */
  setFile(fileName, fullFileName) {
    const full = fullFileName === undefined ? fileName : fullFileName;
    this.fullFileName = full;
    this.fileName = this.side === SIDES.remote ? extractFileName(String(full || '')) : fileName;
    this._clearTransfer();
    this._progress();
  }

  /** Cancellation is monotonic for the life of an operation. */
  setCancel(c) { this.setCancelAtLeast(c); }

  /** Never downgrades: a "cancel file" cannot undo a "cancel everything". */
  setCancelAtLeast(c) { if (this.cancel < c) { this.cancel = c; this._progress(); } }

  setSkipToAll() { this.skipToAll = true; }

  setBatchOverwrite(b) { this.batchOverwrite = b; }

  addTotalSize(size) {
    this.totalSize += Number(size) || 0;
    this.totalSizeSet = true;
    this._progress();
  }

  addTransferred(size) {
    const n = Number(size) || 0;
    this.transferredSize += n;
    this.totalTransferred += n;
    this._progress();
  }

  addSkipped(size) { this.totalSkipped += Number(size) || 0; }

  /**
   * Suspend/Resume exist so the clock does not run while a modal question is on
   * screen — otherwise every error dialog makes the reported transfer rate
   * collapse. The elapsed time is shifted by however long we were suspended.
   */
  suspend(now) {
    if (this.suspended) return;
    this.suspended = true;
    this._suspendTime = now === undefined ? Date.now() : now;
    this._progress();
  }

  resume(now) {
    if (!this.suspended) return;
    this.suspended = false;
    const stopped = (now === undefined ? Date.now() : now) - this._suspendTime;
    this.startTime += stopped;
    this._progress();
  }

  /** One file of the operation is done — the per-file accounting. */
  finish(fileName, success) {
    const notCancelled = this.cancel === CANCEL.continue;
    this._onFinished(this.operation, this.side, this.temp, fileName, success, notCancelled);
    this.filesFinished++;
    if (success) this.filesFinishedSuccessfully++;
    this._progress();
  }

  /** Counts a successful unit into the statistics the summary dialog shows. */
  succeeded(count) {
    const n = count === undefined ? 1 : Number(count);
    if (n <= 0) return;
    const s = this.statistics;
    if (this.isTransfer()) {
      const transferred = this.transferredSize - this.skippedSize;
      if (this.side === SIDES.local) {
        s.filesUploaded += n;
        s.totalUploaded += transferred;
      } else {
        s.filesDownloaded += n;
        s.totalDownloaded += transferred;
      }
    } else if (this.operation === OPERATIONS.delete) {
      if (this.side === SIDES.local) s.filesDeletedLocal += n;
      else s.filesDeletedRemote += n;
    }
  }

  /** A snapshot safe to send across IPC. */
  snapshot() {
    return {
      operation: this.operation,
      side: this.side,
      count: this.count,
      fileName: this.fileName,
      fullFileName: this.fullFileName,
      directory: this.directory,
      inProgress: this.inProgress,
      done: this.done,
      suspended: this.suspended,
      cancel: this.cancel,
      skipToAll: this.skipToAll,
      batchOverwrite: this.batchOverwrite,
      transferSize: this.transferSize,
      transferredSize: this.transferredSize,
      totalSize: this.totalSize,
      totalTransferred: this.totalTransferred,
      totalSkipped: this.totalSkipped,
      filesFinished: this.filesFinished,
      filesFinishedSuccessfully: this.filesFinishedSuccessfully,
      startTime: this.startTime,
      statistics: { ...this.statistics },
    };
  }

  _progress() { this._onProgress(this); }
}

// ===========================================================================
// TRemoteDirectoryCache — RemoteFiles.cpp
//
// Timestamped, so RefreshDirectory can ask "is the cached copy newer than what
// the panel is showing?", and sub-directory aware, so moving a tree drops the
// whole subtree rather than one directory of it.
// ===========================================================================

class DirectoryCache {
  constructor() { this._map = new Map(); }

  get isEmpty() { return this._map.size === 0; }
  get size() { return this._map.size; }

  paths() { return [...this._map.keys()]; }

  hasFileList(directory) {
    return this._map.has(excludeTrailingSlash(directory));
  }

  /** True only when a cached copy exists AND is strictly newer than `timestamp`. */
  hasNewerFileList(directory, timestamp) {
    const hit = this._map.get(excludeTrailingSlash(directory));
    return !!hit && hit.timestamp > timestamp;
  }

  /** Returns a COPY — the caller may filter it without poisoning the cache. */
  getFileList(directory) {
    const hit = this._map.get(excludeTrailingSlash(directory));
    if (!hit) return null;
    return { directory: hit.directory, timestamp: hit.timestamp, files: hit.files.slice() };
  }

  addFileList(fileList) {
    const dir = excludeTrailingSlash(fileList.directory);
    this._map.set(dir, {
      directory: dir,
      timestamp: fileList.timestamp || Date.now(),
      files: (fileList.files || []).slice(),
    });
  }

  /** @returns {string[]} the paths actually removed, so callers can mirror it. */
  clearFileList(directory, subDirs) {
    const dir = excludeTrailingSlash(directory);
    const removed = [];
    if (this._map.delete(dir)) removed.push(dir);
    if (subDirs) {
      const prefix = includeTrailingSlash(dir);
      for (const key of [...this._map.keys()]) {
        if (isChildPath(prefix, key)) { this._map.delete(key); removed.push(key); }
      }
    }
    return removed;
  }

  clear() { this._map.clear(); }
}

// ===========================================================================
// TRemoteDirectoryChangesCache — RemoteFiles.cpp
//
// Remembers "from /a, 'cd link' landed in /b" so a symlinked directory can be
// re-entered without another round trip. It is bounded and least-recently-used:
// reading a key re-inserts it, which is how the C++ TStringList Values[] getter
// happens to behave, and the serializer keeps only the newest `maxSize`.
// ===========================================================================

class DirectoryChangesCache {
  constructor(maxSize) {
    this.maxSize = Number(maxSize) || 100;
    this._map = new Map();
  }

  get isEmpty() { return this._map.size === 0; }

  clear() { this._map.clear(); }

  _setValue(name, value) {
    this._map.delete(name);
    this._map.set(name, value);
  }

  _getValue(name) {
    const v = this._map.get(name);
    if (v !== undefined) this._setValue(name, v);
    return v === undefined ? '' : v;
  }

  /** The key a relative change is remembered under: "sourceDir,change". */
  static changeKey(sourceDir, change) {
    if (!change) return null;
    const absolute = isAbsolutePath(change);
    const source = excludeTrailingSlash(sourceDir);
    if (!source && !absolute) return null;
    return absolute ? change : `${source},${change}`;
  }

  /**
   * "//" marks a target directory that is its own answer. It is stored for
   * every change so ClearDirectoryChangeTarget can find entries by target.
   */
  addDirectoryChange(sourceDir, change, targetDir) {
    if (!targetDir) return;
    this._setValue(targetDir, '//');
    if (expandFileName(change, sourceDir) !== targetDir) {
      const key = DirectoryChangesCache.changeKey(sourceDir, change);
      if (key) this._setValue(key, targetDir);
    }
  }

  getDirectoryChange(sourceDir, change) {
    const direct = expandFileName(change, sourceDir);
    if (this._map.has(direct)) {
      const v = this._getValue(direct);
      return v === '//' ? direct : v;
    }
    const key = DirectoryChangesCache.changeKey(sourceDir, change);
    if (!key) return null;
    const dir = this._getValue(key);
    return dir ? dir : null;
  }

  /** Everything remembered *from* this directory is now suspect. */
  clearDirectoryChange(sourceDir) {
    const prefix = `${excludeTrailingSlash(sourceDir)},`;
    for (const name of [...this._map.keys()]) {
      if (name.startsWith(prefix)) this._map.delete(name);
    }
  }

  /**
   * Everything remembered that *lands* in this directory. The extra key lookup
   * is WinSCP's own comment-flagged hack: it also drops the entry for the
   * symlink itself, so deleting a symlink does not leave a cached hop through
   * the name it used to have.
   */
  clearDirectoryChangeTarget(targetDir) {
    const target = excludeTrailingSlash(targetDir) || '/';
    const key = DirectoryChangesCache.changeKey(
      excludeTrailingSlash(extractFilePath(target)), extractFileName(target));
    for (const [name, value] of [...this._map.entries()]) {
      if (isChildPath(target, name) ||
          (value !== '//' && isChildPath(target, String(value))) ||
          (key && name === key)) {
        this._map.delete(name);
      }
    }
  }

  /** "A" + the newest maxSize entries, matching the stored-format version tag. */
  serialize() {
    let entries = [...this._map.entries()];
    if (entries.length > this.maxSize) entries = entries.slice(entries.length - this.maxSize);
    return 'A' + entries.map(([k, v]) => `${k}=${v}`).join('\n');
  }

  deserialize(data) {
    this._map.clear();
    if (!data) return;
    for (const line of String(data).slice(1).split('\n')) {
      if (!line) continue;
      const i = line.indexOf('=');
      if (i > 0) this._map.set(line.slice(0, i), line.slice(i + 1));
    }
  }
}

// ===========================================================================
// TRetryOperationLoop — Terminal.cpp
//
// The per-command loop: on error ask retry / skip / abort, and remember whether
// the command ultimately succeeded. `skipToAll` short-circuits the question for
// the rest of the operation.
//
// Used as:
//   const loop = new RetryLoop(terminal);
//   do { try { … } catch (e) { await loop.error(e, message); } } while (loop.retry());
// ===========================================================================

class RetryLoop {
  constructor(terminal) {
    this._terminal = terminal;
    this._retry = false;
    this._succeeded = true;
  }

  async error(e, message) {
    this._succeeded = false;
    const answer = await this._terminal.commandError(e, message,
      [ANSWERS.retry, ANSWERS.skip, ANSWERS.abort]);
    switch (answer) {
      case ANSWERS.retry: this._retry = true; return;
      case ANSWERS.skip: return;
      case ANSWERS.abort: throw new AbortError();
      default: throw new AbortError();
    }
  }

  retry() {
    const r = this._retry;
    this._retry = false;
    // A retry that is about to happen resets "succeeded": the previous failure
    // must not make a subsequent success look like a failure.
    if (r) this._succeeded = true;
    return r;
  }

  succeeded() { return this._succeeded; }
}

// ===========================================================================
// TRobustOperationLoop — Terminal.cpp
//
// The "reconnect and carry on" loop, used for whole transfers and for directory
// listings. Unlike RetryLoop it never asks about the file; it asks about the
// *session*, and only when the session is actually down.
//
// THE BUDGET IS OPT-IN, AND OPTING IN MAKES IT STRICTER, NOT LOOSER. Read
// TryReopen (Terminal.cpp:538-559) with the brace nesting in mind: BOTH arms —
// the progress-based reset AND the `ContinueReopen(FStart)` call that is the
// budget itself — sit inside `if (FAnyTransfer != NULL)`. A loop built without
// the flag therefore never consults SessionReopenTimeout at all and reconnects
// for as many drops as QueryReopen accepts. Handing it a flag is what imposes
// the ceiling; the reset merely softens it by restarting the window whenever
// bytes actually moved.
//
// WHICH bool the pointer points at is the rest of the design, and JavaScript
// has no `bool *`, so the caller passes a HOLDER OBJECT carrying a
// `fileTransferAny` property:
//
//   * `null` — no budget (every non-FTP transfer; Terminal.cpp:7767, :8348
//     resolve `tfUseFileTransferAny` to NULL for them).
//   * the terminal — budget WITH the reset, because `Terminal::FFileTransferAny`
//     is the flag `DoProgress` raises whenever a byte lands (Terminal.cpp:2277).
//   * a fresh throwaway object — budget with NO reset, because nothing ever
//     raises it. That is CustomReadDirectory's function-local (Terminal.cpp:3760).
// ===========================================================================

/**
 * TTerminal::ContinueReopen (Terminal.cpp:2459-2464), as a free function so
 * that everything with a reconnect budget consults ONE implementation.
 *
 *   return (Configuration->SessionReopenTimeout == 0) ||
 *          (int(double(Now() - Start) * MSecsPerDay) < Configuration->SessionReopenTimeout);
 *
 * ZERO MEANS FOREVER, and it is the shipped default (defaults.js:384). That is
 * not a detail to be tidied away later: at the default configuration this
 * function returns true for every caller no matter how long the outage has
 * run, so a "budget" that only ever behaves correctly with a non-zero
 * preference set has never been exercised the way most users run it.
 *
 * `now` is passed in rather than read from Date.now() because the terminal
 * carries an injectable clock and a start stamped from one clock compared
 * against another is either instantly spent or eternal.
 */
function continueReopen(prefs, start, now) {
  const timeout = Number((((prefs || {}).security) || {}).sessionReopenTimeout) || 0;
  return timeout === 0 || (now - start) < timeout;
}

class RobustLoop {
  constructor(terminal, progress, options) {
    const o = options || {};
    this._terminal = terminal;
    this._progress = progress || null;
    this._retry = false;
    this._canRetry = o.canRetry !== false;
    this._anyTransfer = o.anyTransfer || null;
    // The terminal's own clock, because ContinueReopen subtracts this from
    // `this._now()`. A start stamped from a different clock than the one the
    // comparison uses makes the budget either instantly spent or eternal.
    this._start = this._nowMs();
    // The C++ constructor takes the flag by pointer, saves it, and zeroes it;
    // the destructor puts it back. Without that, a loop entered after some
    // *earlier* operation moved bytes sees a stale "there was a transfer" and
    // restarts the retry budget forever instead of letting it expire.
    if (this._anyTransfer) {
      this._prevTransferAny = !!this._anyTransfer.fileTransferAny;
      this._anyTransfer.fileTransferAny = false;
    }
  }

  _nowMs() {
    return (this._terminal && typeof this._terminal._now === 'function')
      ? this._terminal._now() : Date.now();
  }

  /** Restores the transfer flag the constructor borrowed (the C++ destructor). */
  dispose() {
    if (this._anyTransfer && this._prevTransferAny !== undefined) {
      this._anyTransfer.fileTransferAny = this._prevTransferAny;
      this._prevTransferAny = undefined;
    }
  }

  async tryReopen(e) {
    if (!this._canRetry) { this._retry = false; return false; }
    if (classifyException(e) === 'skip') { this._retry = false; return false; }
    if (this._terminal.active) {
      // The session survived, so this was not a connection problem: retrying
      // the same call against the same open session would just fail again.
      this._terminal.logEvent('Session is open, will not retry transfer');
      this._retry = false;
      return false;
    }
    this._retry = true;
    if (this._anyTransfer) {
      if (this._anyTransfer.fileTransferAny) {
        // Bytes moved since the last attempt, so the budget starts again.
        this._start = this._nowMs();
        // Terminal.cpp:546. The destructor hands the flag back to whatever
        // scope owns it, so a loop that DID see progress has to say so on the
        // way out — otherwise an enclosing loop is told "nothing moved" by an
        // operation that moved bytes, and expires a window it should restart.
        this._prevTransferAny = true;
        this._anyTransfer.fileTransferAny = false;
      } else {
        this._retry = this._terminal.continueReopen(this._start);
        if (!this._retry) this._terminal.logEvent('Retry interval expired, will not retry transfer');
      }
    }
    if (this._retry) {
      this._retry = await this._terminal.queryReopen(e, REOPEN_FLAGS.noReadDirectory, this._progress);
    }
    return this._retry;
  }

  shouldRetry() { return this._retry; }

  retry() { const r = this._retry; this._retry = false; return r; }
}

// ===========================================================================
// Terminal
// ===========================================================================

/** Default answer when a query prompt is dismissed rather than answered. */
function safestAnswer(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return ANSWERS.cancel;
  for (const a of [ANSWERS.cancel, ANSWERS.abort, ANSWERS.no, ANSWERS.skip]) {
    if (answers.includes(a)) return a;
  }
  return answers[answers.length - 1];
}

class Terminal extends EventEmitter {
  /**
   * @param {object} session  a design/main/session.js Session (or anything with
   *                          the same `adapter` / `log` / `config` / `data` /
   *                          `ask` / `invalidate` surface)
   * @param {object} deps     { queryUser, onProgress, onFinished, now }
   */
  constructor(session, deps) {
    super();
    const d = deps || {};
    this.session = session;
    this.config = d.config || (session && session.config) || null;
    this._queryUser = d.queryUser || null;
    this._now = d.now || (() => Date.now());

    /** The current directory's listing — TTerminal::FFiles. */
    this.files = { directory: '', timestamp: 0, files: [] };

    this.cache = new DirectoryCache();
    this.changesCache = new DirectoryChangesCache(
      (this.config && this.config.prefs && this.config.prefs.maxDirectoryChanges) || 100);

    this._currentDirectory = '';
    this._lastDirectoryChange = '';
    this._inTransaction = 0;
    this._suspendTransaction = false;
    this._exceptionOnFail = 0;
    this._readCurrentDirectoryPending = false;
    this._readDirectoryPending = false;
    this._readingCurrentDirectory = false;
    this._opening = 0;
    this._progressStack = [];
    // Let cancellation release prompts owned by an active operation.
    this._pendingOperationQueries = new Set();

    /** AutoReadDirectory — off while a reconnect is in flight. */
    this.autoReadDirectory = d.autoReadDirectory !== false;

    /** Set by transfers; RobustLoop reads it to decide whether to keep trying. */
    this.fileTransferAny = false;

    /** The last completed operation's accounting, for the summary surface. */
    this.lastOperation = null;

    this._onProgressDep = d.onProgress || null;
    this._onFinishedDep = d.onFinished || null;
    // Fatal paths can meet while an adapter is unwinding.  Keep one decision
    // owner per error so nested callers share the same renderer prompt rather
    // than racing two contradictory reconnect questions.
    this._reopenPrompts = new WeakMap();
  }

  // ------------------------------------------------------------- plumbing

  /** TTerminal::Active. */
  get active() {
    const a = this.session && this.session.adapter;
    return !!(a && a.connected);
  }

  get adapter() { return this.session ? this.session.adapter : null; }

  /** The file system, or a fatal error — never a silently-degraded no-op. */
  _fs() {
    const a = this.adapter;
    if (!a || !a.connected) {
      const e = new FatalError('The session is not connected.');
      e.code = 'NOT_CONNECTED';
      throw e;
    }
    return a;
  }

  get prefs() { return (this.config && this.config.prefs) || {}; }

  get sessionData() { return (this.session && this.session.data) || {}; }

  /**
   * TTerminal::GetUserName (Terminal.cpp:2758-2768) — the file system's answer,
   * falling back to the site's when the backend has none. Two callers need it
   * and both were silently reading `undefined` before it existed:
   * TRemoteFile::GetIsInaccessibleDirectory (remotefiles.js), which decides
   * whether a directory can be entered at all, and the resume guard in
   * transfer.js, which refuses to delete-and-recreate a file somebody else owns.
   */
  get userName() {
    const a = this.adapter;
    return (a && a.userName) || this.sessionData.userName || '';
  }

  logEvent(text) {
    if (this.session && this.session.log) this.session.log.add('debug', text);
    this.emit('log', 'debug', text);
  }

  logMessage(kind, text) {
    if (this.session && this.session.log) this.session.log.add(kind, text);
    this.emit('log', kind, text);
  }

  /** TTerminal::DoInformation — a status line, never an error. */
  information(text, phase, additional) {
    this.emit('information', { text, phase: phase === undefined ? -1 : phase, additional: additional || '' });
  }

  // -------------------------------------------------------- capabilities
  /**
   * WinSCP asks `IsCapable[fcXxx]`; we ask the adapter's `caps`. The mapping is
   * explicit so a renamed capability is a compile-time-ish failure here rather
   * than a silently-false answer that greys out a working command.
   */
  isCapable(capability) {
    const a = this.adapter;
    if (!a) return false;
    const c = a.caps || {};
    switch (capability) {
      case 'modeChanging':
      case 'modeChangingUpload': return !!c.rights;
      case 'ownerChanging':
      case 'groupChanging': return !!c.owner;
      case 'resolveSymlink':
      case 'symbolicLink': return !!c.symlink;
      case 'hardLink': return !!c.hardlink;
      case 'anyCommand':
      case 'shellAnyCommand':
      case 'secondaryShell': return !!c.exec;
      case 'resumeSupport': return !!c.resume;
      case 'preservingTimestampUpload':
      case 'preservingTimestampDirs': return !!c.timestamp;
      case 'recycleBin': return !!c.recycleBin;
      case 'calculatingChecksum': return !!c.checksum;
      case 'rename': return c.rename !== false;
      case 'remoteMove': return c.move !== false;
      case 'remoteCopy': return !!c.copyRemote;
      case 'checkingSpaceAvailable': return !!c.spaceInfo;
      case 'nativeDirectoryListing': return true;
      case 'locking': return typeof a.lockFile === 'function' && typeof a.unlockFile === 'function';
      case 'loadingAdditionalProperties': return typeof a.loadFilesProperties === 'function';
      case 'textMode': return c.textMode !== false;
      case 'ignorePermErrors': return !!c.rights;
      case 'removeCtrlZUpload':
      case 'removeBOMUpload': return true;
      // WinSCP's SFTP/SCP/S3 cannot rename onto an existing name; FTP can.
      // No adapter declares it yet, so the conservative answer is "no", which
      // makes DoRenameOrCopyFile delete the target first — WinSCP's own
      // behaviour for every protocol that lacks the capability.
      case 'moveOverExistingFile': return c.moveOverExistingFile === true;
      default: return false;
    }
  }

  /** TTerminal::GetResolvingSymlinks. */
  get resolvingSymlinks() {
    return this.sessionData.resolveSymlinks !== false && this.isCapable('resolveSymlink');
  }

  /** TTerminal::CanRecurseToDirectory — a symlinked directory is not descended
   *  into unless the site says to, or a delete would walk out of the tree. */
  canRecurseToDirectory(file) {
    if (!file) return true;
    return !file.isSymlink || !!this.sessionData.followDirectorySymlinks;
  }

  /** TTerminal::UsableCopyParamAttrs — which transfer options are meaningless
   *  for this protocol, so the dialog can disable rather than lie about them. */
  usableCopyParamAttrs(params) {
    const p = params || {};
    const general = {
      noTransferMode: !this.isCapable('textMode'),
      noRights: !this.isCapable('modeChanging') || !this.isCapable('modeChangingUpload'),
      noPreserveReadOnly: !this.isCapable('modeChanging'),
      noClearArchive: !!p.delete,
      noIgnorePermErrors: !this.isCapable('ignorePermErrors'),
      noRemoveCtrlZ: !this.isCapable('removeCtrlZUpload'),
      noRemoveBOM: !this.isCapable('removeBOMUpload'),
      noPreserveTimeDirs: !this.isCapable('preservingTimestampDirs'),
      noResumeSupport: !this.isCapable('resumeSupport'),
      noEncryptNewFiles: !this.sessionData.encryptFiles,
    };
    return {
      general,
      download: { ...general, noClearArchive: true, noIgnorePermErrors: true, noRights: true, noRemoveCtrlZ: true, noRemoveBOM: true, noEncryptNewFiles: true },
      upload: { ...general, noPreserveReadOnly: true, noPreserveTime: !this.isCapable('preservingTimestampUpload') },
    };
  }

  // ------------------------------------------------------------- queries
  /**
   * TTerminal::QueryUser. `answers` is the set of buttons; the resolved value
   * is one of them. A dismissed prompt resolves to the safest answer present —
   * never to the one that destroys data.
   */
  async queryUser(query) {
    const q = {
      message: query.message || '',
      moreMessages: query.moreMessages || [],
      answers: query.answers || [ANSWERS.ok],
      type: query.type || 'confirmation',
      neverAskAgain: !!query.neverAskAgain,
      error: query.error ? { message: query.error.message, code: query.error.code || '' } : null,
      aliases: query.aliases || {},
    };
    let answer;
    const progress = this.operationProgress;
    if (progress && progress.inProgress) {
      let cancel;
      const cancelled = new Promise((resolve) => { cancel = () => resolve(ANSWERS.cancel); });
      const pending = { cancel };
      this._pendingOperationQueries.add(pending);
      try {
        const prompt = this._queryUser
          ? this._queryUser(q)
          : (this.session && typeof this.session.ask === 'function'
            ? this.session.ask('custom', { kind: 'query', ...q }).then((reply) => reply && reply.answer)
            : undefined);
        answer = await Promise.race([Promise.resolve(prompt), cancelled]);
      } finally {
        this._pendingOperationQueries.delete(pending);
      }
    } else if (this._queryUser) {
      answer = await this._queryUser(q);
    } else if (this.session && typeof this.session.ask === 'function') {
      const reply = await this.session.ask('custom', { kind: 'query', ...q });
      answer = reply && reply.answer;
    }
    return this._answerQuery(q, answer);
  }

  _answerQuery(q, answer) {
    if (typeof answer === 'string' && q.answers.includes(answer)) return answer;
    if (answer === ANSWERS.neverAskAgain && q.neverAskAgain) return answer;
    const safe = safestAnswer(q.answers);
    this.logEvent(`The "${q.message || 'query'}" prompt was dismissed; taking "${safe}".`);
    return safe;
  }

  /** QueryUserException — the same, with the exception's text attached. */
  queryUserException(message, e, answers, options) {
    const o = options || {};
    return this.queryUser({
      message: message || (e ? e.message : ''),
      moreMessages: message && e && e.message && e.message !== message ? [e.message] : [],
      answers,
      type: o.type || 'error',
      neverAskAgain: !!o.neverAskAgain,
      error: e,
      aliases: o.aliases,
    });
  }

  // ------------------------------------------------------ error handling

  /** ExceptionOnFail: while set, errors are thrown instead of shown. */
  setExceptionOnFail(value) {
    if (value) {
      this._exceptionOnFail++;
    } else {
      if (this._exceptionOnFail === 0) throw new TerminalError('ExceptionOnFail is already zero.');
      this._exceptionOnFail--;
    }
  }

  get exceptionOnFail() { return this._exceptionOnFail > 0; }

  /** Run `fn` with exception-on-fail set, restoring it however `fn` ends. */
  async withExceptionOnFail(fn) {
    this.setExceptionOnFail(true);
    try {
      return await fn();
    } finally {
      this.setExceptionOnFail(false);
    }
  }

  /** TTerminal::TerminalError. */
  terminalError(message, cause) { throw new TerminalError(message, cause); }

  /**
   * TTerminal::FatalError. The session is closed BEFORE the error is thrown,
   * because a half-open session answers "connected" to the next command and
   * turns one failure into a cascade of them.
   */
  async fatalError(e, message) {
    if (this.active) {
      this.logMessage('error', 'Attempt to close connection due to fatal exception:');
      if (message) this.logMessage('error', message);
      if (e && e.message) this.logMessage('error', e.message);
      try {
        await this.session.disconnect({ keepOpen: true });
      } catch (closeError) {
        this.logEvent(`Closing the session after a fatal error failed: ${closeError.message}`);
      }
    }
    const fatal = new FatalError(message || (e && e.message) || 'The connection was lost.', e);
    if (e && e.code) fatal.code = e.code;
    throw fatal;
  }

  /**
   * TTerminal::CommandError. The single funnel every command error passes
   * through, and the reason the same failure behaves differently depending on
   * context:
   *   fatal            -> close and rethrow as fatal
   *   user abort       -> rethrow untouched
   *   exceptionOnFail  -> rethrow as a command error for the caller to handle
   *   no answers asked -> report it and continue (the "continue on error" path)
   *   answers asked    -> ask, honouring "skip to all"
   */
  async commandError(e, message, answers) {
    const kind = classifyException(e);
    if (kind === 'fatal') {
      return this.fatalError(e, message);
    }
    if (kind === 'abort') {
      throw e;
    }
    if (this.exceptionOnFail) {
      throw new CommandFailedError(message || (e && e.message) || 'Command failed.', e);
    }
    if (!answers || answers.length === 0) {
      const err = new CommandFailedError(message || (e && e.message) || 'Command failed.', e);
      this.handleExtendedException(err);
      return '';
    }

    const progress = this.operationProgress;
    const canSkip = answers.includes(ANSWERS.skip) && !!progress;
    if (canSkip && progress.skipToAll) return ANSWERS.skip;

    const offered = canSkip ? answers.concat([ANSWERS.all]) : answers.slice();
    let result;
    if (progress) {
      progress.suspend(this._now());
      try {
        result = await this.queryUserException(message, e, offered,
          { aliases: { all: 'Skip all' } });
      } finally {
        progress.resume(this._now());
      }
    } else {
      result = await this.queryUserException(message, e, offered);
    }
    if (result === ANSWERS.all) {
      if (progress) progress.setSkipToAll();
      result = ANSWERS.skip;
    }
    return result;
  }

  /**
   * TTerminal::HandleException — false means "the caller must rethrow". This is
   * the "continue on error" decision: with exception-on-fail set the caller
   * wants the error, otherwise it is logged and swallowed so the next file in
   * the list still gets its turn.
   */
  handleException(e) {
    if (this.exceptionOnFail) return false;
    this.logMessage('error', e && e.message ? e.message : String(e));
    return true;
  }

  handleExtendedException(e) {
    this.logMessage('error', e && e.message ? e.message : String(e));
    this.emit('error-report', e);
  }

  // -------------------------------------------- reconnect during an operation

  /**
   * TTerminal::ContinueReopen — is there any of the reopen budget left?
   *
   * The arithmetic lives in the module-level `continueReopen` below, because
   * the queue asks the same question about the same preference and a second
   * copy of `timeout === 0 || elapsed < timeout` is how "honoured on one path,
   * ignored on the other" gets built a third time.
   */
  continueReopen(start) {
    return continueReopen(this.prefs, start, this._now());
  }

  /**
   * TTerminal::DoQueryReopen — ask once per fatal error, then remember. The
   * timeout answer is Retry, not Abort: an unattended queue must recover from
   * a dropped connection on its own.
   */
  async doQueryReopen(e) {
    if (e && e.reopenQueried) return false;
    if (e && typeof e === 'object') {
      const pending = this._reopenPrompts.get(e);
      if (pending) return pending;
      const decision = (async () => {
        this.logEvent('Connection was lost, asking what to do.');
        const answer = await this.queryUserException('', e, [ANSWERS.retry, ANSWERS.abort], {
          type: 'error',
          aliases: { retry: 'Reconnect' },
        });
        e.reopenQueried = true;
        return answer === ANSWERS.retry;
      })();
      this._reopenPrompts.set(e, decision);
      try { return await decision; } finally { this._reopenPrompts.delete(e); }
    }
    this.logEvent('Connection was lost, asking what to do.');
    const answer = await this.queryUserException('', e, [ANSWERS.retry, ANSWERS.abort], {
      type: 'error',
      aliases: { retry: 'Reconnect' },
    });
    return answer === ANSWERS.retry;
  }

  /**
   * TTerminal::QueryReopen — ask, then keep reconnecting until the session is
   * back or the budget runs out. The progress is suspended throughout so the
   * transfer rate is not computed across the outage.
   */
  async queryReopen(e, params, progress) {
    if (progress) progress.suspend(this._now());
    try {
      // Cancellation may be requested while the reconnect decision is on
      // screen. Do not turn that cancellation into a fresh network attempt.
      if (progress && progress.cancel !== CANCEL.continue) return false;
      let result = await this.doQueryReopen(e);
      if (!result) return false;
      const start = this._now();
      do {
        if (progress && progress.cancel !== CANCEL.continue) return false;
        try {
          await this.reopen(params);
        } catch (reopenError) {
          if (!this.active) {
            result = this.continueReopen(start) && await this.doQueryReopen(reopenError);
          } else {
            throw reopenError;
          }
        }
      } while (!this.active && result);
      return result;
    } finally {
      if (progress) progress.resume(this._now());
    }
  }

  /**
   * TTerminal::Reopen. Everything the reconnect must not disturb is saved and
   * restored: the pending directory reads, the transaction suspension, and
   * exception-on-fail. `ropNoReadDirectory` exists because the file list being
   * operated on references files from the current directory — reloading it
   * mid-operation invalidates the objects the operation is walking.
   */
  async reopen(params) {
    const p = Number(params) || 0;
    const prevReadCurrent = this._readCurrentDirectoryPending;
    const prevReadDir = this._readDirectoryPending;
    const prevAutoRead = this.autoReadDirectory;
    const prevExceptionOnFail = this._exceptionOnFail;
    try {
      this._readCurrentDirectoryPending = false;
      this._readDirectoryPending = false;
      this._suspendTransaction = this._inTransaction > 0;
      this._exceptionOnFail = 0;
      if (p & REOPEN_FLAGS.noReadDirectory) this.autoReadDirectory = false;

      // Only peek: we may not be connected at all, and asking the server where
      // we are is exactly the call that will fail.
      const current = this.peekCurrentDirectory();
      const wanted = current || this.sessionData.remoteDirectory || '';

      await this.session.reconnect();
      if (wanted) {
        this._currentDirectory = wanted;
        if (this.session.state) this.session.state.remotePath = wanted;
      }
    } finally {
      this.autoReadDirectory = prevAutoRead;
      this._readCurrentDirectoryPending = prevReadCurrent;
      this._readDirectoryPending = prevReadDir;
      this._suspendTransaction = false;
      this._exceptionOnFail = prevExceptionOnFail;
    }
  }

  // ------------------------------------------------- file-operation loops

  /**
   * FILE_OPERATION_LOOP: run `fn`, and on failure decide retry / skip / abort
   * according to `flags`. This is the loop every single-file call in WinSCP is
   * wrapped in.
   */
  async fileOperationLoop(fn, options) {
    const o = options || {};
    const flags = o.flags === undefined ? LOOP_FLAGS.allowSkip : o.flags;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        await this.fileOperationLoopEnd(e, o.progress || this.operationProgress, o.message, flags, o.specialRetry);
      }
    }
  }

  /**
   * TTerminal::FileOperationLoopEnd — the classification step. Abort and skip
   * pass straight through (they are already a decision); a fatal error is only
   * offered a reconnect when the caller said the operation can survive one.
   */
  async fileOperationLoopEnd(e, progress, message, flags, specialRetry) {
    const kind = classifyException(e);
    if (kind === 'abort' || kind === 'skip') throw e;
    if (kind === 'fatal') {
      if (!(flags & LOOP_FLAGS.retryOnFatal)) throw e;
      const wrapped = new FatalError(message || e.message, e);
      wrapped.reopenQueried = !!e.reopenQueried;
      if (!await this.queryReopen(wrapped, REOPEN_FLAGS.noReadDirectory, progress)) throw wrapped;
      return false;
    }
    return this.fileOperationLoopQuery(e, progress, message, flags, specialRetry);
  }

  /**
   * TTerminal::FileOperationLoopQuery. Returns true when the user picked the
   * "special retry" (e.g. "Resume"), false for a plain retry, and throws
   * ESkipFile / the original error otherwise. Abort also cancels the operation
   * so the *loop* stops, not just this file.
   */
  async fileOperationLoopQuery(e, progress, message, flags, specialRetry) {
    let result = false;
    this.logMessage('error', e && e.message ? e.message : String(e));

    const allowSkip = !!(flags & LOOP_FLAGS.allowSkip);
    const skipToAllPossible = allowSkip && !!progress;

    let answer;
    if (skipToAllPossible && progress.skipToAll) {
      answer = ANSWERS.skip;
    } else {
      const answers = [ANSWERS.retry, ANSWERS.abort];
      if (allowSkip) answers.push(ANSWERS.skip);
      if (skipToAllPossible) answers.push(ANSWERS.all);
      if (specialRetry) answers.push(ANSWERS.yes);

      if (progress) progress.suspend(this._now());
      try {
        answer = await this.queryUserException(message, e, answers, {
          aliases: { all: 'Skip all', yes: specialRetry || '' },
        });
      } finally {
        if (progress) progress.resume(this._now());
      }

      if (answer === ANSWERS.all) {
        if (progress) progress.setSkipToAll();
        answer = ANSWERS.skip;
      }
      if (answer === ANSWERS.yes) {
        result = true;
        answer = ANSWERS.retry;
      }
    }

    if (answer !== ANSWERS.retry) {
      if (answer === ANSWERS.abort && progress) progress.setCancel(CANCEL.cancel);
      if (allowSkip) throw new SkipFileError(message || (e && e.message), e);
      throw new TerminalError(message || (e && e.message), e);
    }
    return result;
  }

  // ------------------------------------------------------- the caches

  /** TTerminal::ClearCaches — including the session's panel cache. */
  clearCaches() {
    this.cache.clear();
    this.changesCache.clear();
    this.files.timestamp = 0;
    if (this.session && typeof this.session.clearCache === 'function') this.session.clearCache();
  }

  get areCachesEmpty() {
    return this.cache.isEmpty && this.changesCache.isEmpty;
  }

  /** TTerminal::DirectoryModified — the listing for `path` is now a lie. */
  directoryModified(path, subDirs) {
    const dir = path || this.currentDirectorySync;
    const removed = this.cache.clearFileList(dir, subDirs);
    if (this.session && typeof this.session.invalidate === 'function') {
      // Mirror into the session's panel cache. `invalidate` also drops the
      // parent, which is broader than we need and never wrong.
      this.session.invalidate(dir, { subDirs: !!subDirs });
      for (const p of removed) this.session.invalidate(p);
    }
    // The in-hand listing is part of the cache surface: if the directory it
    // describes was just invalidated, it must not be served as fresh.
    if (samePath(this.files.directory, dir) || (subDirs && isChildPath(dir, this.files.directory))) {
      this.files.timestamp = 0;
    }
    this.emit('directory-modified', { path: dir, subDirs: !!subDirs });
  }

  /** TTerminal::DirectoryLoaded. */
  directoryLoaded(fileList) { this.cache.addFileList(fileList); }

  /**
   * TTerminal::FileModified — after a write, work out which directories the
   * write invalidated. Both the file's own directory (if it IS one) and its
   * parent, because a rename changes both listings.
   */
  fileModified(file, fileName, clearDirectoryChange) {
    const data = this.sessionData;
    const caching = data.cacheDirectories !== false || data.cacheDirectoryChanges !== false;
    let directory = '';
    let parentDirectory = '';

    if (caching) {
      if (file && file.directory) {
        if (file.type === 'dir') directory = includeTrailingSlash(file.directory) + file.name;
        parentDirectory = file.directory;
      } else if (fileName) {
        parentDirectory = excludeTrailingSlash(extractFilePath(fileName));
        if (!parentDirectory) parentDirectory = this.currentDirectorySync;
        if (file && file.type === 'dir') {
          directory = includeTrailingSlash(parentDirectory) + extractFileName(file.name || fileName);
        }
      }
    }

    if (data.cacheDirectories !== false) {
      if (directory) this.directoryModified(directory, true);
      if (parentDirectory) this.directoryModified(parentDirectory, false);
    }

    if (data.cacheDirectoryChanges !== false && clearDirectoryChange && directory) {
      this.changesCache.clearDirectoryChange(directory);
      this.changesCache.clearDirectoryChangeTarget(directory);
    }
  }

  // ------------------------------------------------------ current directory

  /** PeekCurrentDirectory — never asks the server. */
  peekCurrentDirectory() {
    if (this.session && this.session.state && this.session.state.remotePath) {
      this._currentDirectory = this.session.state.remotePath;
    }
    return this._currentDirectory;
  }

  /** The last known current directory, without a round trip. */
  get currentDirectorySync() { return this.peekCurrentDirectory(); }

  /** TTerminal::GetCurrentDirectory — reads it from the server when unknown. */
  async currentDirectory() {
    const known = this.peekCurrentDirectory();
    if (known) return known;
    await this.readCurrentDirectory();
    return this._currentDirectory;
  }

  /**
   * TTerminal::ReadCurrentDirectory. The directory-change cache is written
   * here, where both the old and the new directory are known, and the pending
   * "last change" is cleared afterwards so a change we did not initiate (a
   * home-directory jump, say) cannot be mis-attributed to the previous `cd`.
   */
  async readCurrentDirectory() {
    const a = this._fs();
    try {
      this._readCurrentDirectoryPending = false;
      this.logEvent('Getting current directory name.');
      const oldDirectory = this._currentDirectory;

      let current;
      if (typeof a.currentDirectory === 'function') current = await a.currentDirectory();
      else if (typeof a.pwd === 'function') current = await a.pwd();
      else current = this.peekCurrentDirectory() || a.home || '/';
      this._currentDirectory = excludeTrailingSlash(current) || '/';
      if (this.session && this.session.state) this.session.state.remotePath = this._currentDirectory;

      if (this.sessionData.cacheDirectoryChanges !== false) {
        if (this._currentDirectory && this._lastDirectoryChange &&
            this._currentDirectory !== oldDirectory) {
          this.changesCache.addDirectoryChange(oldDirectory, this._lastDirectoryChange, this._currentDirectory);
        }
        this._lastDirectoryChange = '';
      }

      if (oldDirectory !== this._currentDirectory) {
        this.emit('change-directory', this._currentDirectory);
      }
      return this._currentDirectory;
    } catch (e) {
      await this.commandError(e, 'Error getting the name of the current remote directory.');
      return this._currentDirectory;
    }
  }

  /**
   * TTerminal::ChangeDirectory. A cached change is used only once the session
   * is fully open — during startup a stale cache entry could land the user in a
   * directory that no longer exists, with nothing to fall back to.
   */
  async changeDirectory(directory) {
    const a = this._fs();
    try {
      let target = directory;
      let cached = null;
      if (this.active && this.sessionData.cacheDirectoryChanges !== false) {
        cached = this.changesCache.getDirectoryChange(this.peekCurrentDirectory(), directory);
      }
      if (cached) {
        this.logEvent(`Cached directory change via "${directory}" to "${cached}".`);
        target = cached;
        this._currentDirectory = excludeTrailingSlash(cached);
      } else {
        this.logEvent(`Changing directory to "${directory}".`);
        if (typeof a.changeDirectory === 'function') {
          const landed = await a.changeDirectory(directory);
          this._currentDirectory = excludeTrailingSlash(landed || this.absolutePath(directory));
        } else {
          // A stateless protocol has no "cd"; resolving the path IS the change,
          // and it must still fail loudly when the directory does not exist.
          const resolved = a.normalize(this.absolutePath(directory));
          await a.list(resolved);
          this._currentDirectory = excludeTrailingSlash(resolved);
        }
      }
      if (this.session && this.session.state) this.session.state.remotePath = this._currentDirectory;
      this._lastDirectoryChange = directory;
      this.emit('change-directory', this._currentDirectory);
      await this.reactOnCommand('changeDirectory');
      return this._currentDirectory;
    } catch (e) {
      await this.commandError(e, `Error changing directory to "${directory}".`);
      return this._currentDirectory;
    }
  }

  /** TTerminal::HomeDirectory. */
  async homeDirectory() {
    const a = this._fs();
    try {
      this.logEvent('Changing directory to home directory.');
      const home = (typeof a.getHomeDirectory === 'function' ? await a.getHomeDirectory() : a.home) || '/';
      const landed = typeof a.changeDirectory === 'function'
        ? await a.changeDirectory(home)
        : null;
      // Protocols may canonicalize the home path through an alias or symlink.
      this._currentDirectory = excludeTrailingSlash(landed || home) || '/';
      if (this.session && this.session.state) this.session.state.remotePath = this._currentDirectory;
      // Deliberately NOT recorded as a directory change: HomeDirectory does not
      // set FLastDirectoryChange, so the cache is never keyed on "home".
      this._lastDirectoryChange = '';
      this.emit('change-directory', this._currentDirectory);
      await this.reactOnCommand('homeDirectory');
      return this._currentDirectory;
    } catch (e) {
      await this.commandError(e, 'Error changing directory to home directory.');
      return this._currentDirectory;
    }
  }

  /** TTerminal::AbsolutePath. */
  absolutePath(p, local) {
    const a = this.adapter;
    if (a && typeof a.absolutePath === 'function') return a.absolutePath(p, local);
    return absolutePath(this.peekCurrentDirectory() || '/', p);
  }

  // ------------------------------------------------------- transactions

  /** TTerminal::InTransaction — a suspended transaction is not a transaction. */
  inTransaction() { return this._inTransaction > 0 && !this._suspendTransaction; }

  /**
   * BeginTransaction. Inside a transaction the directory is NOT reread after
   * every file; the reads are coalesced and happen once at the end. That is
   * the difference between deleting 500 files with 500 listings and with one.
   */
  beginTransaction() {
    if (this._inTransaction === 0) {
      this._readCurrentDirectoryPending = false;
      this._readDirectoryPending = false;
    }
    this._inTransaction++;
  }

  endTransaction(inform) { return this._doEndTransaction(!!inform); }

  async _doEndTransaction(inform) {
    if (this._inTransaction === 0) this.terminalError("Can't end transaction, not in transaction");
    this._inTransaction--;

    // A connection lost mid-transaction leaves nothing to reread; the pending
    // flags are cleared by the reconnect, not here.
    if (this.active && this._inTransaction === 0) {
      try {
        if (this._readCurrentDirectoryPending) await this.readCurrentDirectory();
        if (this._readDirectoryPending) {
          if (inform) this.information('Opening directory…', -1, this.currentDirectorySync);
          await this.readDirectory(!this._readCurrentDirectoryPending);
        }
      } finally {
        this._readCurrentDirectoryPending = false;
        this._readDirectoryPending = false;
      }
    }
  }

  /** Run `fn` inside a transaction, ending it however `fn` ends. */
  async withTransaction(fn) {
    this.beginTransaction();
    try {
      return await fn();
    } finally {
      await this._doEndTransaction(false);
    }
  }

  /**
   * TTerminal::ReactOnCommand — what a command implies about the panel. A
   * command that changes directory forces a reread; one that only modifies
   * files rereads when the preference says to. Inside a transaction both are
   * deferred to the end.
   */
  async reactOnCommand(command) {
    let changesDirectory = false;
    let modifiesFiles = false;
    switch (command) {
      case 'changeDirectory':
      case 'homeDirectory':
        changesDirectory = true;
        break;
      case 'copyToRemote':
      case 'copyToLocal':
      case 'deleteFile':
      case 'renameFile':
      case 'moveFile':
      case 'copyFile':
      case 'createDirectory':
      case 'changeMode':
      case 'changeGroup':
      case 'changeOwner':
      case 'changeProperties':
      case 'lock':
        modifiesFiles = true;
        break;
      case 'anyCommand':
        changesDirectory = true;
        modifiesFiles = true;
        break;
      default:
        break;
    }

    if (changesDirectory) {
      if (!this.inTransaction()) {
        await this.readCurrentDirectory();
        if (this.autoReadDirectory) await this.readDirectory(false);
      } else {
        this._readCurrentDirectoryPending = true;
        if (this.autoReadDirectory) this._readDirectoryPending = true;
      }
    } else if (modifiesFiles && this.autoReadDirectory && this.prefs.autoReadDirectoryAfterOp !== false) {
      if (!this.inTransaction()) await this.readDirectory(true);
      else this._readDirectoryPending = true;
    }
  }

  // ----------------------------------------------------- reading directories

  /**
   * Give an adapter entry the two fields the rest of this file needs: where it
   * lives and its full path. TRemoteFile carries these as `Directory` and
   * `FullFileName`.
   */
  _decorate(entries, directory) {
    const dir = excludeTrailingSlash(directory) || '/';
    return (entries || []).map((e) => ({
      ...e,
      directory: dir,
      fullFileName: includeTrailingSlash(dir) + e.name,
    }));
  }

  /**
   * TTerminal::CustomReadDirectory — the actual listing, wrapped in the robust
   * loop so a listing that fails because the connection dropped is retried
   * after reconnecting rather than reported as "directory unreadable".
   *
   * The `_opening` guard is WinSCP's: during Open() the whole connection
   * attempt is retried instead, and recursing into a reconnect from here would
   * re-enter Open.
   *
   * The budget flag is a FUNCTION-LOCAL that nothing ever raises, exactly as at
   * Terminal.cpp:3760 ("To match FTP upload/download, we also limit directory
   * listing. For simplicity, we limit it unconditionally, for all protocols for
   * any kind of errors"). So a listing gets the SessionReopenTimeout ceiling
   * with no way to reset it — which is the point, because a listing moves no
   * bytes of its own. Pointing it at the terminal-wide flag instead would let
   * some unrelated transfer's progress hand this loop a fresh window, and a
   * directory that is genuinely unreadable would be re-listed forever.
   */
  async customReadDirectory(fileList) {
    const fileTransferAny = { fileTransferAny: false };
    const loop = new RobustLoop(this, this.operationProgress, { anyTransfer: fileTransferAny });
    try {
      do {
        try {
          const a = this._fs();
          const entries = await a.list(a.normalize(fileList.directory));
          fileList.files = this._decorate(entries, fileList.directory);
          fileList.timestamp = this._now();
        } catch (e) {
          if (this._opening > 0 || !await loop.tryReopen(e)) throw e;
        }
      } while (loop.retry());
    } finally {
      loop.dispose();
    }

    for (const f of fileList.files) this.logEvent(this.remoteFileInfo(f));
    await this.reactOnCommand('listDirectory');
    return fileList;
  }

  /** TTerminal::GetRemoteFileInfo — the one-line log form of an entry. */
  remoteFileInfo(file) {
    return [file.name, file.type, file.size, new Date(file.mtime || 0).toISOString(),
      file.owner, file.group, file.rights].join(';');
  }

  /** TTerminal::ReadDirectory(TRemoteFileList*) — listing with error reporting. */
  async readDirectoryInto(fileList) {
    try {
      return await this.customReadDirectory(fileList);
    } catch (e) {
      await this.commandError(e, `Error listing directory "${fileList.directory}".`);
      return fileList;
    }
  }

  /**
   * TTerminal::ReadDirectory(ReloadOnly, ForceCache) — load the CURRENT
   * directory into `this.files`.
   *
   * The cache branch is subtle and worth keeping: a *reload* deliberately does
   * NOT use the cache (the user asked for fresh data), unless `forceCache` is
   * set, which is what RefreshDirectory uses when the cache already holds
   * something newer than what the panel is showing.
   */
  async readDirectory(reloadOnly, forceCache) {
    const dir = this.peekCurrentDirectory() || '/';
    let loadedFromCache = false;

    if (this.sessionData.cacheDirectories !== false && this.cache.hasFileList(dir)) {
      if (reloadOnly && !forceCache) {
        this.logEvent('Cached directory not reloaded.');
      } else {
        this.emit('start-read-directory');
        const cached = this.cache.getFileList(dir);
        if (cached) {
          this.files = cached;
          loadedFromCache = true;
          this.logEvent('Directory content loaded from cache.');
        } else {
          this.logEvent('Cached Directory content has been removed.');
        }
        this.emit('read-directory', { reloadOnly: !!reloadOnly, fromCache: loadedFromCache });
      }
    }

    if (!loadedFromCache) {
      this.emit('start-read-directory');
      this._readingCurrentDirectory = true;
      this._readDirectoryProgress(0, 0);
      const fileList = { directory: dir, timestamp: 0, files: [] };
      try {
        await this.customReadDirectory(fileList);
      } catch (e) {
        this._readDirectoryProgress(-1, 0);
        this._readingCurrentDirectory = false;
        this.files = fileList;
        this.emit('read-directory', { reloadOnly: !!reloadOnly, fromCache: false });
        await this.commandError(e, `Error listing directory "${dir}".`);
        return this.files;
      }
      this._readDirectoryProgress(-1, 0);
      this._readingCurrentDirectory = false;
      this.files = fileList;
      this.emit('read-directory', { reloadOnly: !!reloadOnly, fromCache: false });
      if (this.active && this.sessionData.cacheDirectories !== false) this.directoryLoaded(fileList);
    }
    return this.files;
  }

  _readDirectoryProgress(progress, resolvedLinks) {
    if (!this._readingCurrentDirectory && progress >= 0) return;
    const state = { progress, resolvedLinks, cancel: false };
    this.emit('read-directory-progress', state);
    return state;
  }

  /** TTerminal::ReloadDirectory — the user pressed Refresh: drop and reread. */
  async reloadDirectory() {
    const dir = this.peekCurrentDirectory();
    if (this.sessionData.cacheDirectories !== false) this.directoryModified(dir, false);
    if (this.sessionData.cacheDirectoryChanges !== false) this.changesCache.clearDirectoryChange(dir);
    await this.readCurrentDirectory();
    this._readCurrentDirectoryPending = false;
    await this.readDirectory(true);
    this._readDirectoryPending = false;
    return this.files;
  }

  /**
   * TTerminal::RefreshDirectory — a cheap refresh: only does anything when the
   * cache genuinely holds something newer than the loaded listing. With caching
   * off it does nothing at all, and says so, rather than silently reloading.
   */
  async refreshDirectory() {
    if (this.sessionData.cacheDirectories === false) {
      this.logEvent('Not refreshing directory, caching is off.');
      return this.files;
    }
    if (!this.files.timestamp || this.cache.hasNewerFileList(this.peekCurrentDirectory(), this.files.timestamp)) {
      await this.readDirectory(true, true);
      this._readDirectoryPending = false;
    }
    return this.files;
  }

  /**
   * TTerminal::DoReadDirectoryListing — list ANY directory (not necessarily
   * the current one), optionally through the cache. Exception-on-fail is set
   * around the read so a failure reaches the caller instead of a dialog: the
   * callers are recursive walks that must decide for themselves.
   */
  async doReadDirectoryListing(directory, useCache) {
    const cacheIt = useCache && this.sessionData.cacheDirectories !== false;
    if (cacheIt) {
      const cached = this.cache.getFileList(directory);
      if (cached) return cached;
    }
    const fileList = { directory: excludeTrailingSlash(directory) || '/', timestamp: 0, files: [] };
    await this.withExceptionOnFail(() => this.readDirectoryInto(fileList));
    if (cacheIt) this.directoryLoaded(fileList);
    return fileList;
  }

  /** TTerminal::CustomReadDirectoryListing — the retriable form. */
  async customReadDirectoryListing(directory, useCache) {
    let fileList = null;
    const loop = new RetryLoop(this);
    do {
      try {
        fileList = await this.doReadDirectoryListing(directory, useCache);
      } catch (e) {
        await loop.error(e, `Error listing directory "${directory}".`);
      }
    } while (loop.retry());
    return fileList;
  }

  /**
   * TTerminal::ReadDirectoryListing(Directory, Mask) — THE layer the file mask
   * belongs at. The listing itself is never filtered (the cache must hold the
   * whole directory, or the next caller with a different mask gets a truncated
   * answer); the copy handed back is.
   */
  async readDirectoryListing(directory, mask) {
    const fileList = await this.customReadDirectoryListing(directory, false);
    if (!fileList) return null;
    if (!mask) return fileList;
    const fm = mask instanceof FileMask ? mask : new FileMask(mask, { root: directory });
    const files = fileList.files.filter((f) =>
      fm.matches(f.name, { isDir: f.type === 'dir', size: f.size, mtime: f.mtime, path: f.fullFileName }));
    return { directory: fileList.directory, timestamp: fileList.timestamp, files };
  }

  /** TTerminal::ReadFile — one entry's attributes. */
  async readFile(fileName) {
    const a = this._fs();
    try {
      this.logEvent(`Listing file "${fileName}".`);
      const st = await a.stat(a.normalize(fileName));
      if (!st) return null;
      const dir = excludeTrailingSlash(extractFilePath(excludeTrailingSlash(fileName))) ||
        this.peekCurrentDirectory() || '/';
      const file = {
        ...st,
        name: st.name || extractFileName(excludeTrailingSlash(fileName)),
        directory: dir,
        fullFileName: excludeTrailingSlash(this.absolutePath(fileName)),
      };
      this.logEvent(this.remoteFileInfo(file));
      return file;
    } catch (e) {
      await this.commandError(e, `Could not retrieve attributes of file "${fileName}".`);
      return null;
    }
  }

  /**
   * TTerminal::TryReadFile — "does it exist?" without a dialog. A failure that
   * killed the session still propagates: not knowing whether a file exists
   * because the connection died is not the same as knowing it does not.
   */
  async tryReadFile(fileName) {
    try {
      return await this.withExceptionOnFail(() => this.readFile(excludeTrailingSlash(fileName)));
    } catch (e) {
      if (this.active) return null;
      throw e;
    }
  }

  async fileExists(fileName) { return !!(await this.tryReadFile(fileName)); }

  async directoryExists(fileName) {
    const f = await this.tryReadFile(fileName);
    return !!f && f.type === 'dir';
  }

  /** TTerminal::ReadSymlink. */
  async readSymlink(symlinkFile) {
    const a = this._fs();
    try {
      this.logEvent(`Reading symlink "${symlinkFile.name}".`);
      const target = symlinkFile.linkTarget || await a.readlink(symlinkFile.fullFileName || symlinkFile.name);
      const resolved = isAbsolutePath(target)
        ? target
        : includeTrailingSlash(symlinkFile.directory || this.peekCurrentDirectory()) + target;
      return await this.readFile(resolved);
    } catch (e) {
      await this.commandError(e, `Error reading symbolic link "${symlinkFile.name}".`);
      return null;
    }
  }

  /**
   * "Is this the same file?" — the comparison the rename/move guards need.
   * Path identity first (the cheap, authoritative answer), then an attribute
   * comparison for the case where the same file is reached by two names.
   */
  isSameFile(a, b) {
    if (!a || !b) return false;
    const pathA = excludeTrailingSlash(a.fullFileName || a.name || '');
    const pathB = excludeTrailingSlash(b.fullFileName || b.name || '');
    if (pathA && pathB && samePath(pathA, pathB)) return true;
    return a.type === b.type &&
      Number(a.size) === Number(b.size) &&
      Number(a.mtime) === Number(b.mtime) &&
      extractFileName(pathA) === extractFileName(pathB);
  }

  static samePath(a, b) { return samePath(a, b); }

  // --------------------------------------------------------- the operation

  /** The progress of the operation currently running, or null. */
  get operationProgress() {
    return this._progressStack.length ? this._progressStack[this._progressStack.length - 1] : null;
  }

  /** Cancel the active foreground operation, if one exists. */
  cancelOperation() {
    const active = this._progressStack.filter((progress) => progress.inProgress);
    if (!active.length) return false;
    // TFileOperationProgressType propagates cancellation to its parent. The
    // stack is the JavaScript equivalent: an inner operation must not finish
    // and leave the enclosing batch advancing through later files.
    for (const progress of active) progress.setCancelAtLeast(CANCEL.cancel);
    for (const pending of this._pendingOperationQueries) pending.cancel();
    return true;
  }

  operationStart(progress, operation, side, count, options) {
    progress.start(operation, side, count, options);
    this._progressStack.push(progress);
    this.emit('operation-start', progress.snapshot());
  }

  operationStop(progress) {
    if (progress.done && !progress.inProgress) return;
    const i = this._progressStack.lastIndexOf(progress);
    if (i >= 0) this._progressStack.splice(i, 1);
    progress.stop();
    this.lastOperation = progress.snapshot();
    this.emit('operation-stop', this.lastOperation);
  }

  operationFinish(progress, fileName, success) { progress.finish(fileName, success); }

  _newProgress() {
    return new OperationProgress(
      (p) => {
        if (p.transferredSize > 0) this.fileTransferAny = true;
        if (this._onProgressDep) this._onProgressDep(p);
        this.emit('progress', p);
      },
      (operation, side, temp, fileName, success, notCancelled) => {
        const rec = { operation, side, temp, fileName, success, notCancelled };
        if (this._onFinishedDep) this._onFinishedDep(rec);
        this.emit('finished', rec);
      });
  }

  /**
   * Accept the several shapes a file list arrives in: bare paths, decorated
   * entries from a listing, or explicit `{ fileName, file }` pairs.
   */
  _normalizeFileList(fileList) {
    return (fileList || []).map((item) => {
      if (typeof item === 'string') return { fileName: item, file: null };
      if (item && typeof item === 'object' && 'fileName' in item && !('type' in item)) {
        return { fileName: item.fileName, file: item.file || null };
      }
      return { fileName: item.fullFileName || item.name || '', file: item };
    });
  }

  /**
   * TTerminal::ProcessFiles — the operation loop.
   *
   * Every behaviour here is deliberate:
   *   * the loop stops the moment the progress is cancelled, mid-list;
   *   * `finish` is recorded for EVERY file, successful or not, in a finally,
   *     so the counts add up even when a callback threw;
   *   * a skipped file is swallowed and the loop continues — unless
   *     exception-on-fail is set, in which case the caller wanted the error;
   *   * remote operations run inside a transaction, so the directory is reread
   *     once at the end instead of once per file.
   */
  async processFiles(fileList, operation, processFile, param, side, options) {
    const o = options || {};
    const items = this._normalizeFileList(fileList);
    const progress = o.progress || this._newProgress();
    const theSide = side || SIDES.remote;
    let result = false;

    this.operationStart(progress, operation, theSide, items.length, o);
    try {
      if (theSide === SIDES.remote) this.beginTransaction();
      try {
        let index = 0;
        while (index < items.length && progress.cancel === CANCEL.continue) {
          const { fileName, file } = items[index];
          let success = false;
          try {
            try {
              await processFile(fileName, file, param, index);
              success = true;
            } finally {
              this.operationFinish(progress, fileName, success);
            }
          } catch (e) {
            if (classifyException(e) === 'skip') {
              if (!this.handleException(e)) throw e;
            } else {
              throw e;
            }
          }
          index++;
        }
      } finally {
        if (theSide === SIDES.remote) await this._doEndTransaction(false);
      }
      if (progress.cancel === CANCEL.continue) result = true;
    } finally {
      this.operationStop(progress);
    }
    return result;
  }

  /**
   * TTerminal::ProcessDirectory — one level of recursion.
   *
   * `.` and `..` are dropped here rather than in the adapters, because a
   * protocol that returns them and one that does not must recurse identically.
   * `ignoreErrors` is how "calculate size" keeps going past an unreadable
   * directory, and it still rethrows when the SESSION died — that is not an
   * error you can ignore.
   */
  async processDirectory(dirName, callback, param, useCache, ignoreErrors) {
    let fileList = null;
    if (ignoreErrors) {
      try {
        fileList = await this.withExceptionOnFail(() => this.customReadDirectoryListing(dirName, useCache));
      } catch (e) {
        if (!this.active) throw e;
      }
    } else {
      fileList = await this.customReadDirectoryListing(dirName, useCache);
    }

    // A null list means the user chose "skip" for the listing itself.
    if (!fileList) return;

    const directory = includeTrailingSlash(dirName);
    for (const file of fileList.files) {
      if (!isRealFile(file.name)) continue;
      await callback(directory + file.name, file, param);
    }
  }

  // ------------------------------------------------------------- delete

  /** TTerminal::IsRecycledFile — already in the bin? Then do not "recycle" it. */
  isRecycledFile(fileName) {
    const bin = this.sessionData.recycleBinPath;
    if (!bin) return false;
    let dir = excludeTrailingSlash(extractFilePath(fileName));
    if (!dir) dir = this.peekCurrentDirectory();
    return samePath(dir, bin);
  }

  /**
   * TTerminal::RecycleFile — a delete that is really a move, stamped with the
   * time so deleting two files of the same name does not lose the first.
   */
  async recycleFile(fileName, file) {
    const name = fileName || (file && file.name) || '';
    if (this.isRecycledFile(name)) return true;

    const bin = this.sessionData.recycleBinPath;
    this.logEvent(`Moving file "${name}" to remote recycle bin '${bin}'.`);
    const mask = recycleFileMask(this._now());

    const result = await this.doMoveFile(name, file, { target: bin, fileMask: mask, dontOverwrite: false });
    const progress = this.operationProgress;
    if (result && progress && progress.operation === OPERATIONS.delete) progress.succeeded();
    return result;
  }

  /**
   * TTerminal::TryStartOperationWithFile — announce the file, and report back
   * whether the operation is still running. Returning false is how a cancelled
   * operation stops without every callback having to check.
   */
  tryStartOperationWithFile(fileName, operation1, operation2) {
    const progress = this.operationProgress;
    if (progress && (progress.operation === operation1 ||
        (operation2 && progress.operation === operation2))) {
      if (progress.cancel !== CANCEL.continue) return false;
      progress.setFile(fileName);
    }
    return true;
  }

  startOperationWithFile(fileName, operation1, operation2) {
    if (!this.tryStartOperationWithFile(fileName, operation1, operation2)) throw new AbortError();
  }

  /**
   * TTerminal::DeleteFile. The recycle decision reads oddly and is exactly
   * right: `dfAlternative` INVERTS the site's preference, so the same shortcut
   * means "delete permanently" for a user who recycles by default and "recycle"
   * for one who does not.
   */
  async deleteFile(fileName, file, params) {
    let name = fileName;
    if (!name && file) name = file.name;
    this.startOperationWithFile(name, OPERATIONS.delete);

    const p = Number(params) || 0;
    const recycle =
      !(p & DELETE_FLAGS.forceDelete) &&
      (!!this.sessionData.deleteToRecycleBin !== !!(p & DELETE_FLAGS.alternative)) &&
      !!this.sessionData.recycleBinPath;

    if (recycle && !this.isRecycledFile(name)) {
      await this.recycleFile(name, file);
    } else {
      await this.doDeleteFile(name, file, p);
    }
  }

  /**
   * TTerminal::DoDeleteFile + DeleteContentsIfDirectory. WinSCP deletes the
   * contents of a directory BEFORE the directory itself, and a symlink to a
   * directory is unlinked rather than walked into — deleting through a symlink
   * would destroy files outside the tree the user selected.
   */
  async doDeleteFile(fileName, file, params) {
    this.logEvent(`Deleting file "${fileName}".`);
    this.fileModified(file, fileName, true);

    const isDir = !!file && file.type === 'dir' && this.canRecurseToDirectory(file);
    if (isDir && !(params & DELETE_FLAGS.noRecursive)) {
      await this.processDirectory(fileName, (n, f) => this.deleteFile(n, f, params), params);
    }
    const removeDirectory = isDir && !file.isSymlink;

    const loop = new RetryLoop(this);
    do {
      try {
        const a = this._fs();
        await a.remove(a.normalize(fileName), { recursive: false, directory: removeDirectory });
        const progress = this.operationProgress;
        if (progress && progress.operation === OPERATIONS.delete) progress.succeeded();
      } catch (e) {
        await loop.error(e, `Error deleting file "${fileName}".`);
      }
    } while (loop.retry());

    await this.reactOnCommand('deleteFile');
  }

  /** TTerminal::DeleteFiles. */
  deleteFiles(filesToDelete, params) {
    return this.processFiles(filesToDelete, OPERATIONS.delete,
      (name, file) => this.deleteFile(name, file, params), params);
  }

  // ------------------------------------------------- rename / move / copy

  /**
   * TTerminal::EnsureNonExistence — refuse to create over an existing name.
   * Only checked when the name has no path AND the loaded listing is the
   * current directory: otherwise the listing in hand says nothing about it, and
   * a guess would be worse than the server's own error.
   */
  ensureNonExistence(fileName) {
    if (extractFileDir(fileName) !== '') return;
    if (!samePath(this.peekCurrentDirectory(), this.files.directory)) return;
    const existing = this.files.files.find((f) => f.name === fileName);
    if (!existing) return;
    throw new CommandFailedError(existing.type === 'dir'
      ? `Cannot create directory "${fileName}" because a directory with that name already exists.`
      : `Cannot create file "${fileName}" because a file with that name already exists.`);
  }

  /**
   * TTerminal::DoRenameOrCopyFile — the shared body of rename, move and
   * server-side copy. In order:
   *
   *   1. same source and target -> nothing to do, and NOT an error;
   *   2. the batch answer ("overwrite all" / "overwrite none") short-circuits;
   *   3. otherwise, if the target exists and confirmations are on, ask —
   *      a directory gets a sterner question than a file, because overwriting
   *      a directory is not recoverable;
   *   4. AFTER the confirmation, refuse to move something into itself;
   *   5. delete an existing target first when the protocol cannot rename over
   *      one, inside a transaction so the two steps read as one.
   */
  async doRenameOrCopyFile(rename, fileName, file, newName, move, dontOverwrite, isBatchOperation) {
    const progress = this.operationProgress;
    const batchOverwrite = isBatchOperation && progress ? progress.batchOverwrite : BATCH.no;
    const absoluteFileName = this.absolutePath(fileName, true);
    const absoluteNewName = this.absolutePath(newName, true);
    let result = true;
    let existenceKnown = false;
    let duplicateFile = null;

    if (samePath(absoluteFileName, absoluteNewName)) {
      this.logEvent(`Target "${absoluteNewName}" is same as source "${absoluteFileName}" - skipping.`);
      result = false;
    } else if (batchOverwrite === BATCH.none) {
      result = !await this.fileExists(absoluteNewName);
      existenceKnown = true;
    } else if (batchOverwrite === BATCH.all) {
      // The user already said yes to everything.
    } else if (this.prefs.confirmOverwriting !== false && !dontOverwrite) {
      duplicateFile = await this.tryReadFile(absoluteNewName);
      existenceKnown = true;
      if (duplicateFile) {
        const isDir = duplicateFile.type === 'dir';
        const answers = [ANSWERS.yes, ANSWERS.no];
        if (progress) answers.push(ANSWERS.cancel);
        if (isBatchOperation) answers.push(ANSWERS.yesToAll, ANSWERS.noToAll);
        const answer = await this.queryUser({
          message: isDir
            ? `Directory "${newName}" already exists. Overwrite it?`
            : `File "${newName}" already exists. Overwrite it?`,
          moreMessages: isDir
            ? ['Overwriting a directory replaces it entirely. Its contents cannot be recovered.']
            : [],
          answers,
          type: isDir ? 'warning' : 'confirmation',
          neverAskAgain: true,
        });
        switch (answer) {
          case ANSWERS.neverAskAgain:
            if (this.config && typeof this.config.setPref === 'function') this.config.setPref('confirmOverwriting', false);
            else if (this.config && this.config.prefs) this.config.prefs.confirmOverwriting = false;
            result = true;
            break;
          case ANSWERS.yes: result = true; break;
          case ANSWERS.no: result = false; break;
          case ANSWERS.yesToAll:
            result = true;
            if (isBatchOperation && progress) progress.setBatchOverwrite(BATCH.all);
            break;
          case ANSWERS.noToAll:
            result = false;
            if (isBatchOperation && progress) progress.setBatchOverwrite(BATCH.none);
            break;
          case ANSWERS.cancel:
            result = false;
            if (progress) progress.setCancel(CANCEL.cancel);
            break;
          default: result = false; break;
        }
      }
    }

    if (!result) return false;

    // Deliberately after the confirmation, so the user has seen which files
    // would be overwritten before being told the target cannot work. The test
    // is "is the source underneath the target?" — moving /home/me/dir onto
    // /home/me would have to destroy the source to create the target.
    if (absoluteFileName.startsWith(includeTrailingSlash(absoluteNewName))) {
      throw new TerminalError(
        `Cannot move or copy "${absoluteFileName}" to "${absoluteNewName}": ` +
        'the target is an ancestor of the source.');
    }

    this.beginTransaction();
    try {
      if (!this.isCapable('moveOverExistingFile') && !dontOverwrite) {
        if (!existenceKnown) duplicateFile = await this.tryReadFile(absoluteNewName);
        if (duplicateFile) await this.doDeleteFile(absoluteNewName, duplicateFile, 0);
      }

      const loop = new RetryLoop(this);
      do {
        try {
          const a = this._fs();
          if (rename) {
            await a.rename(a.normalize(fileName), a.normalize(newName), { overwrite: !dontOverwrite });
          } else {
            if (!this.isCapable('remoteCopy') || typeof a.copyFile !== 'function') {
              const e = new Error(`${a.protocolName} cannot duplicate a file on the server.`);
              e.code = 'NOT_SUPPORTED';
              throw e;
            }
            await a.copyFile(a.normalize(fileName), a.normalize(newName), { overwrite: !dontOverwrite });
          }
        } catch (e) {
          await loop.error(e, rename
            ? `Error ${move ? 'moving' : 'renaming'} file "${fileName}" to "${newName}".`
            : `Error duplicating file "${fileName}" to "${newName}".`);
        }
      } while (loop.retry());
      result = loop.succeeded();
    } finally {
      await this._doEndTransaction(false);
    }
    return result;
  }

  /** TTerminal::DoRenameFile — batch only when the operation IS a batch move. */
  doRenameFile(fileName, file, newName, move, dontOverwrite) {
    const progress = this.operationProgress;
    const isBatchOperation = !!progress && progress.operation === OPERATIONS.remoteMove;
    return this.doRenameOrCopyFile(true, fileName, file, newName, move, dontOverwrite, isBatchOperation);
  }

  /** TTerminal::RenameFile — the in-place rename from the panel. */
  async renameFile(file, newName) {
    if (!file || file.name === newName) return false;
    this.fileModified(file, file.name);
    this.logEvent(`Renaming file "${file.name}" to "${newName}".`);
    const done = await this.doRenameFile(file.fullFileName || file.name, file, newName, false, false);
    if (done) await this.reactOnCommand('renameFile');
    return done;
  }

  /** TTerminal::DoMoveFile — the target name comes from the mask. */
  async doMoveFile(fileName, file, params) {
    this.startOperationWithFile(fileName, OPERATIONS.remoteMove, OPERATIONS.delete);
    const newName = includeTrailingSlash(params.target) +
      maskFileName(extractFileName(fileName), params.fileMask || '');
    this.logEvent(`Moving file "${fileName}" to "${newName}".`);
    this.fileModified(file, fileName);
    const result = await this.doRenameFile(fileName, file, newName, true, !!params.dontOverwrite);
    if (result) await this.reactOnCommand('moveFile');
    return result;
  }

  moveFile(fileName, file, params) { return this.doMoveFile(fileName, file, params); }

  /**
   * TTerminal::MoveFiles. The finally block is the interesting part: if the
   * user moved the directory they are standing in, the session is now sitting
   * in a path that no longer exists, so we walk up to the nearest directory
   * that does. The pre-check is an optimisation — without it every move would
   * cost an existence check on the current directory.
   */
  async moveFiles(fileList, target, fileMask, dontOverwrite) {
    const params = { target, fileMask, dontOverwrite: !!dontOverwrite };
    const items = this._normalizeFileList(fileList);
    let result;
    this.beginTransaction();
    try {
      result = await this.processFiles(items, OPERATIONS.remoteMove,
        (name, file) => this.doMoveFile(name, file, params), params);
    } finally {
      if (this.active) {
        // Only after the move: with encryption the target folders can be read
        // and cached while checking whether the target exists.
        this.directoryModified(target, true);

        const current = this.peekCurrentDirectory();
        let possiblyMoved = false;
        for (const { fileName, file } of items) {
          if (!file || file.type !== 'dir') continue;
          if (current.slice(0, fileName.length) === fileName &&
              (fileName.length === current.length || current[fileName.length] === '/')) {
            possiblyMoved = true;
            break;
          }
        }
        if (possiblyMoved && !await this.fileExists(current)) {
          let nearest = current;
          do {
            nearest = extractFileDir(nearest);
          } while (!isRootPath(nearest) && !await this.fileExists(nearest));
          await this.changeDirectory(nearest || '/');
        }
      }
      await this._doEndTransaction(false);
    }
    return result;
  }

  /** TTerminal::CopyFile — server-side duplicate. */
  async copyFile(fileName, file, params) {
    this.startOperationWithFile(fileName, OPERATIONS.remoteCopy);
    const newName = includeTrailingSlash(params.target) +
      maskFileName(extractFileName(fileName), params.fileMask || '');
    this.logEvent(`Copying file "${fileName}" to "${newName}".`);
    await this.doRenameOrCopyFile(false, fileName, file, newName, false, !!params.dontOverwrite, true);
    await this.reactOnCommand('copyFile');
  }

  /** TTerminal::CopyFiles. Batch reads are coalesced like MoveFiles. */
  async copyFiles(fileList, target, fileMask, dontOverwrite) {
    const params = { target, fileMask, dontOverwrite: !!dontOverwrite };
    this.beginTransaction();
    try {
      return await this.processFiles(fileList, OPERATIONS.remoteCopy,
        (name, file) => this.copyFile(name, file, params), params);
    } finally {
      if (this.active) this.directoryModified(target, true);
      await this._doEndTransaction(false);
    }
  }

  // -------------------------------------------------- create directory/link

  /**
   * TTerminal::CreateDirectory. Properties other than "encrypt" are applied in
   * a second call, and only when the protocol can actually apply them —
   * otherwise the directory is created and the user is told nothing failed,
   * which is what WinSCP does and is right: the directory IS there.
   */
  async createDirectory(dirName, properties) {
    const props = properties || {};
    this.ensureNonExistence(dirName);
    this.fileModified(null, dirName);

    this.logEvent(`Creating directory "${dirName}".`);
    await this.doCreateDirectory(dirName, !!props.encrypt);

    const remaining = { ...props };
    delete remaining.encrypt;
    const hasRemaining = Object.keys(remaining).some((k) => remaining[k] !== undefined && remaining[k] !== null);
    if (hasRemaining && (this.isCapable('modeChanging') || this.isCapable('ownerChanging') || this.isCapable('groupChanging'))) {
      await this.doChangeFileProperties(dirName, null, remaining);
    }
    await this.reactOnCommand('createDirectory');
  }

  async doCreateDirectory(dirName, encrypt) {
    const loop = new RetryLoop(this);
    do {
      try {
        const a = this._fs();
        // recursive:false — "New folder" creates one folder. Silently creating
        // the whole path would hide a typo in the parent.
        await a.mkdir(a.normalize(dirName), { recursive: false, encrypt: !!encrypt });
      } catch (e) {
        await loop.error(e, `Error creating folder "${dirName}".`);
      }
    } while (loop.retry());
  }

  /** TTerminal::CreateLink. */
  async createLink(fileName, pointTo, symbolic) {
    this.ensureNonExistence(fileName);
    if (this.sessionData.cacheDirectories !== false) this.directoryModified(this.peekCurrentDirectory(), false);
    this.logEvent(`Creating link "${fileName}" to "${pointTo}" (symbolic: ${symbolic ? 'Yes' : 'No'}).`);
    await this.doCreateLink(fileName, pointTo, symbolic);
    await this.reactOnCommand('createDirectory');
  }

  async doCreateLink(fileName, pointTo, symbolic) {
    const loop = new RetryLoop(this);
    do {
      try {
        const a = this._fs();
        if (symbolic === false) {
          if (typeof a.hardlink !== 'function' || !this.isCapable('hardLink')) {
            const e = new Error(`${a.protocolName} cannot create hard links.`);
            e.code = 'NOT_SUPPORTED';
            throw e;
          }
          await a.hardlink(a.normalize(pointTo), a.normalize(fileName));
        } else {
          await a.symlink(pointTo, a.normalize(fileName));
        }
      } catch (e) {
        await loop.error(e, `Error creating link "${fileName}".`);
      }
    } while (loop.retry());
  }

  // ------------------------------------------------------------ properties

  /**
   * TTerminal::ChangeFileProperties. `properties` mirrors TRemoteProperties:
   *   { rights, addXToDirectories, owner, group, modification, lastAccess,
   *     recursive }
   * Only the keys present are applied — an absent key means "leave it alone",
   * which is why this is not a plain assignment.
   */
  async changeFileProperties(fileName, file, properties) {
    const props = properties || {};
    let name = fileName;
    if (!name && file) name = file.name;
    this.startOperationWithFile(name, OPERATIONS.setProperties);

    this.logEvent(`Changing properties of "${name}" (${props.recursive ? 'Yes' : 'No'})`);
    if (props.rights !== undefined) this.logEvent(` - mode: "${rightsText(props.rights)}"`);
    if (props.group !== undefined) this.logEvent(` - group: ${props.group}`);
    if (props.owner !== undefined) this.logEvent(` - owner: ${props.owner}`);
    if (props.modification !== undefined) this.logEvent(` - modification: "${new Date(props.modification).toISOString()}"`);
    if (props.lastAccess !== undefined) this.logEvent(` - last access: "${new Date(props.lastAccess).toISOString()}"`);

    this.fileModified(file, name);
    await this.doChangeFileProperties(name, file, props);
    await this.reactOnCommand('changeProperties');
  }

  /**
   * In WinSCP the recursion for "apply to subdirectories" lives inside each
   * file system (SFTPFileSystem::ChangeFileProperties does it). Our adapters
   * are one call per attribute, so the recursion lives here instead — the
   * intent is identical: children first, then the directory itself, and a
   * failure inside the subtree abandons the whole entry.
   */
  async doChangeFileProperties(fileName, file, properties) {
    if (properties.recursive && file && file.type === 'dir' && this.canRecurseToDirectory(file)) {
      await this.processDirectory(fileName,
        (n, f) => this.changeFileProperties(n, f, properties), properties);
    }

    const loop = new RetryLoop(this);
    do {
      try {
        const a = this._fs();
        const p = a.normalize(fileName);
        const isDir = !!file && file.type === 'dir';

        if (properties.rights !== undefined) {
          if (!this.isCapable('modeChanging')) {
            const e = new Error(`${a.protocolName} cannot change permissions.`);
            e.code = 'NOT_SUPPORTED';
            throw e;
          }
          let rights = rightsText(properties.rights);
          // "Set group, others execute for directories" — a directory nobody
          // can enter is worse than useless, so read/write implies execute.
          if (isDir && properties.addXToDirectories) rights = addExecute(rights);
          await a.setRights(p, rights);
        }
        if (properties.owner !== undefined || properties.group !== undefined) {
          if (!this.isCapable('ownerChanging') && !this.isCapable('groupChanging')) {
            const e = new Error(`${a.protocolName} cannot change the owner or group.`);
            e.code = 'NOT_SUPPORTED';
            throw e;
          }
          // Owner and group go together: setting one without knowing the other
          // would clear it, so the file's current value supplies the missing
          // half — exactly what SFTPFileSystem does before SSH_FXP_SETSTAT.
          const owner = properties.owner !== undefined ? properties.owner : (file && file.owner);
          const group = properties.group !== undefined ? properties.group : (file && file.group);
          await a.setOwner(p, owner, group);
        }
        if (properties.modification !== undefined || properties.lastAccess !== undefined) {
          const mtime = properties.modification !== undefined ? properties.modification : (file && file.mtime);
          const atime = properties.lastAccess !== undefined ? properties.lastAccess : mtime;
          await this._setTimes(a, p, mtime, atime);
        }
      } catch (e) {
        await loop.error(e, `Error changing properties of file "${fileName}".`);
      }
    } while (loop.retry());
  }

  /**
   * The adapters disagree about setTimes: most take (path, mtime, atime), the
   * FTP backend takes (path, { mtime }). Dispatch on arity rather than on the
   * protocol name, so a future adapter picking either shape still works.
   */
  _setTimes(adapter, p, mtime, atime) {
    if (typeof adapter.setTimes !== 'function') {
      const e = new Error(`${adapter.protocolName} cannot set timestamps.`);
      e.code = 'NOT_SUPPORTED';
      throw e;
    }
    if (adapter.setTimes.length === 2) return adapter.setTimes(p, { mtime, atime });
    return adapter.setTimes(p, mtime, atime);
  }

  /** TTerminal::ChangeFilesProperties. */
  changeFilesProperties(fileList, properties) {
    return this.processFiles(fileList, OPERATIONS.setProperties,
      (name, file) => this.changeFileProperties(name, file, properties), properties);
  }

  /** TTerminal::LoadFilesProperties — the extra columns some protocols offer. */
  async loadFilesProperties(fileList) {
    const a = this.adapter;
    if (!this.isCapable('loadingAdditionalProperties')) return false;
    const items = this._normalizeFileList(fileList);
    const result = await a.loadFilesProperties(items.map((i) => i.file || i.fileName));
    if (result && this.sessionData.cacheDirectories !== false && items.length &&
        items[0].file && samePath(items[0].file.directory, this.files.directory)) {
      this.directoryLoaded(this.files);
    }
    return !!result;
  }

  // ------------------------------------------------------ calculate size

  /**
   * TTerminal::CalculateFileSize — per entry. The mask is applied HERE, before
   * anything is counted, so "calculate size" and "transfer" agree on which
   * files are in scope; a size that includes files the transfer will skip is a
   * progress bar that never reaches the end.
   */
  async calculateFileSize(fileName, file, params) {
    let name = fileName;
    if (!name && file) name = file.name;

    if (!this.tryStartOperationWithFile(name, OPERATIONS.calculateSize)) {
      params.result = false;
      throw new AbortError();
    }

    // WinSCP is always handed a TRemoteFile here. A caller that only has a
    // path gets one looked up rather than a crash — sizing a file we cannot
    // stat is the one thing we must not silently report as zero.
    if (!file) {
      file = await this.tryReadFile(name);
      if (!file) {
        params.result = false;
        throw new SkipFileError(`Could not retrieve attributes of file "${name}".`);
      }
    }

    if (params.copyParam && !await this.allowRemoteFileTransfer(file, params.copyParam,
      !!(params.params & CALC_FLAGS.disallowTemporaryTransferFiles))) {
      return;
    }

    let collectionIndex = -1;
    if (params.files) {
      collectionIndex = params.files.length;
      params.files.push({ fileName: excludeTrailingSlash(file.fullFileName), file, dir: file.type === 'dir', recursed: true });
    }

    if (file.type === 'dir') {
      if (this.canRecurseToDirectory(file)) {
        if (!params.allowDirs) {
          params.result = false;
        } else if ((params.params & CALC_FLAGS.stopOnFirstFile) && params.stats.files > 0) {
          // Already know it is not empty; recursing further answers nothing.
        } else {
          if (!(params.params & CALC_FLAGS.stopOnFirstFile)) {
            this.logEvent(`Getting size of directory "${name}"`);
          }
          const recursed = await this.doCalculateDirectorySize(file.fullFileName, params);
          if (!recursed && collectionIndex >= 0) params.files[collectionIndex].recursed = false;
        }
      }
      params.stats.directories++;
    } else {
      params.size += Number(file.size) || 0;
      params.stats.files++;
    }

    if (file.isSymlink) params.stats.symLinks++;
  }

  /**
   * TTerminal::DoCalculateDirectorySize. `csIgnoreErrors` makes an unreadable
   * subdirectory a zero rather than a dialog — but only while the session is
   * alive; a lost connection is still reported.
   */
  async doCalculateDirectorySize(fileName, params) {
    let result = false;
    const loop = new RetryLoop(this);
    do {
      try {
        await this.processDirectory(fileName, (n, f) => this.calculateFileSize(n, f, params), params, params.useCache);
        result = true;
      } catch (e) {
        if (!this.active || !(params.params & CALC_FLAGS.ignoreErrors)) {
          await loop.error(e, `Error calculating size of directory "${fileName}".`);
        }
      }
    } while (loop.retry());
    return result;
  }

  /**
   * TTerminal::CalculateFilesSize. Returns the totals AND `result`, which is
   * false when something could not be counted — the caller uses it to decide
   * whether the progress bar can be trusted, and WinSCP shows an indeterminate
   * one when it cannot.
   */
  async calculateFilesSize(fileList, options) {
    const o = options || {};
    const params = {
      params: Number(o.params) || 0,
      copyParam: o.copyParam || null,
      allowDirs: o.allowDirs !== false,
      useCache: !!o.useCache,
      size: 0,
      result: true,
      files: o.collectFiles ? [] : null,
      stats: { files: 0, directories: 0, symLinks: 0 },
    };
    await this.processFiles(fileList, OPERATIONS.calculateSize,
      (name, file) => this.calculateFileSize(name, file, params), params);
    this.logEvent(`Size of ${this._normalizeFileList(fileList).length} remote files/folders calculated as ${params.size}`);
    return {
      size: params.size,
      result: params.result,
      stats: params.stats,
      files: params.files,
    };
  }

  /**
   * TCopyParamType::AllowTransfer, via TTerminal::DoAllowRemoteFileTransfer.
   * Hidden files lose to `excludeHiddenFiles` before the mask is even
   * consulted — an explicit include mask does not resurrect them.
   *
   * Async for the last clause only. `cpNoEmptyDirectories` is the third
   * conjunct of DoAllowRemoteFileTransfer (Terminal.cpp:5806) and cannot be
   * answered from the entry in hand — it is a listing. Without it the size
   * calculation counted directories the copy would then refuse, so a remote
   * count and the transfer that followed it disagreed about how many
   * directories existed. Bytes never diverged, because a directory contributes
   * none; the number that was wrong was `stats.directories` and the collected
   * file list built from it. `transfer.js` `calculateLocalFilesSize` shares the
   * engine's predicate and has always honoured the clause, so until now the
   * two sides of the same option disagreed with each other as well.
   */
  async allowRemoteFileTransfer(file, copyParam, disallowTemporaryTransferFiles) {
    const cp = copyParam || {};
    if (file.hidden && cp.excludeHiddenFiles) return false;
    if (disallowTemporaryTransferFiles && this._isTemporaryTransferFile(file.name)) return false;
    if (cp.includeFileMask) {
      const mask = cp._parsedMask || (cp._parsedMask = new FileMask(cp.includeFileMask, { root: file.directory }));
      if (!mask.matches(file.name, {
        isDir: file.type === 'dir',
        size: file.size,
        mtime: file.mtime,
        path: excludeTrailingSlash(file.fullFileName),
      })) return false;
    }
    if (file.type === 'dir' && cp.excludeEmptyDirectories &&
        await this.isEmptyRemoteDirectory(file, cp, disallowTemporaryTransferFiles)) {
      return false;
    }
    return true;
  }

  /**
   * TTerminal::IsEmptyRemoteDirectory (Terminal.cpp:6432).
   *
   * The original does not walk the tree itself: it runs the ordinary size
   * calculation over the directory with `csStopOnFirstFile` and asks whether
   * it found any FILES. That is why the answer is `Stats.Files == 0` and not
   * "the listing was empty" — directories, and symlinks to directories it will
   * not follow, do not count, and every filter the copy applies (the mask,
   * `excludeHiddenFiles`, `.filepart` when the caller asked) is applied by
   * `calculateFileSize` on the way past.
   *
   * Two details are copied deliberately:
   *
   *   * `excludeEmptyDirectories` is cleared on the inner copy param, exactly
   *     as Terminal.cpp:6438 does and for the reason its comment gives ("to
   *     avoid endless recursion"): the predicate is in the middle of being
   *     asked, and letting `calculateFileSize` re-enter it for every
   *     subdirectory would re-walk the same subtree once per level.
   *   * `csStopOnFirstFile` is what makes this cheap. `calculateFileSize`
   *     stops descending as soon as `stats.files > 0` (Terminal.cpp:4733), so
   *     a directory whose first entry is a file costs one listing.
   *
   * One detail is NOT copied. The original returns `Params.Result && (Stats.Files == 0)`
   * and `Params.Result` is untouched by a listing that failed under
   * `csIgnoreErrors` — so an unreadable directory comes back "empty" there and
   * is dropped from the transfer, along with everything under it. We also
   * require the listing to have succeeded, which is the value
   * `DoCalculateDirectorySize` returns and the original computes and discards
   * (Terminal.cpp:4785/4810). That makes an unreadable directory "not empty",
   * matching what `transfer.js` `isEmptyDirectory` already answers — the whole
   * point of this method is that the count and the copy agree.
   */
  async isEmptyRemoteDirectory(file, copyParam, disallowTemporaryTransferFiles) {
    const params = {
      params: CALC_FLAGS.stopOnFirstFile | CALC_FLAGS.ignoreErrors |
        (disallowTemporaryTransferFiles ? CALC_FLAGS.disallowTemporaryTransferFiles : 0),
      copyParam: { ...(copyParam || {}), excludeEmptyDirectories: false },
      allowDirs: true,
      useCache: false,
      size: 0,
      result: true,
      files: null,
      stats: { files: 0, directories: 0, symLinks: 0 },
    };
    const listed = await this.doCalculateDirectorySize(
      excludeTrailingSlash(file.fullFileName), params);
    return listed && params.result && params.stats.files === 0;
  }

  /**
   * TSFTPFileSystem::TemporaryTransferFile — a partially transferred file is
   * not itself a transferable file. It is `GetPartialFileExtLen() > 0`, not a
   * plain suffix test: a resumed transfer that had to disambiguate writes
   * "report.filepart2", and that is just as temporary as "report.filepart".
   */
  _isTemporaryTransferFile(name) {
    return typeof name === 'string' && getPartialFileExtLen(name) > 0;
  }

  // ------------------------------------------------------------ lock/unlock

  async lockFile(fileName, file) {
    this.startOperationWithFile(fileName, OPERATIONS.lock);
    this.logEvent(`Locking file "${fileName}".`);
    this.fileModified(file, fileName, true);
    await this._doLockFile(fileName, file, true);
    await this.reactOnCommand('lock');
  }

  async unlockFile(fileName, file) {
    this.startOperationWithFile(fileName, OPERATIONS.unlock);
    this.logEvent(`Unlocking file "${fileName}".`);
    this.fileModified(file, fileName, true);
    await this._doLockFile(fileName, file, false);
    await this.reactOnCommand('lock');
  }

  async _doLockFile(fileName, file, lock) {
    const loop = new RetryLoop(this);
    do {
      try {
        const a = this._fs();
        if (!this.isCapable('locking')) {
          const e = new Error(`${a.protocolName} cannot lock files.`);
          e.code = 'NOT_SUPPORTED';
          throw e;
        }
        if (lock) await a.lockFile(a.normalize(fileName), file);
        else await a.unlockFile(a.normalize(fileName), file);
      } catch (e) {
        await loop.error(e, `Error ${lock ? 'locking' : 'unlocking'} file "${fileName}".`);
      }
    } while (loop.retry());
  }

  // ------------------------------------------------------------- transfers
  //
  // The transfer half of Terminal.cpp lives in `transfer.js` — CopyToRemote,
  // CopyToLocal, Source/Sink, the robust loops and the overwrite decision.
  // These three methods are the seam between the two halves; everything they
  // reach is implemented there.

  /**
   * The session's one TransferEngine. It is shared on purpose: "Yes to all"
   * and "Skip all" belong to the operation, and two engines on one session
   * would each ask the user the question the other already answered.
   *
   * The require is lazy because `transfer.js` imports THIS module at load
   * time; a top-level require here would be a cycle that hands one of the two
   * files a half-built copy of the other.
   */
  transferEngine(options) {
    return require('./transfer').transferEngineFor(this, options);
  }

  /** TTerminal::CopyToRemote. */
  copyToRemote(filesToCopy, targetDir, copyParam, params, parallelOperation) {
    return this.transferEngine().copyToRemote(filesToCopy, targetDir, copyParam, params, parallelOperation);
  }

  /** TTerminal::CopyToLocal. */
  copyToLocal(filesToCopy, targetDir, copyParam, params, parallelOperation) {
    return this.transferEngine().copyToLocal(filesToCopy, targetDir, copyParam, params, parallelOperation);
  }

  lockFiles(fileList) {
    return this.withTransaction(() => this.processFiles(fileList, OPERATIONS.lock,
      (name, file) => this.lockFile(name, file)));
  }

  unlockFiles(fileList) {
    return this.withTransaction(() => this.processFiles(fileList, OPERATIONS.unlock,
      (name, file) => this.unlockFile(name, file)));
  }
}

// ------------------------------------------------------------------ helpers

/** Accept 'rwxr-xr-x', { text }, or an octal number. */
function rightsText(rights) {
  if (rights === undefined || rights === null) return '';
  if (typeof rights === 'object') return rights.text || '';
  if (typeof rights === 'number') {
    const chars = 'rwxrwxrwx';
    let out = '';
    for (let i = 0; i < 9; i++) out += (rights & (1 << (8 - i))) ? chars[i] : '-';
    return out;
  }
  return String(rights);
}

/** TRights::AddExecute — read OR write in a group implies execute for it. */
function addExecute(text) {
  const chars = String(text).padEnd(9, '-').split('');
  for (let g = 0; g < 3; g++) {
    const base = g * 3;
    if (chars[base] === 'r' || chars[base + 1] === 'w') chars[base + 2] = 'x';
  }
  return chars.join('');
}

/**
 * The integration point for session.js / ipc.js: one Terminal per Session,
 * created on first use and kept on the session itself. Callers do
 * `terminalFor(session).deleteFiles(...)` instead of building their own, so
 * there is exactly one directory cache and one operation progress per session
 * however many places reach for it.
 *
 * The property is non-enumerable so a session snapshot sent over IPC does not
 * try to serialize the terminal (and its listeners) with it.
 */
function terminalFor(session, deps) {
  if (!session) throw new TerminalError('A terminal needs a session.');
  if (session.__terminal) return session.__terminal;
  const terminal = new Terminal(session, deps);
  Object.defineProperty(session, '__terminal', {
    value: terminal, enumerable: false, configurable: true, writable: true,
  });
  return terminal;
}

module.exports = {
  Terminal,
  terminalFor,
  OperationProgress,
  OperationStatistics,
  DirectoryCache,
  DirectoryChangesCache,
  RetryLoop,
  RobustLoop,
  continueReopen,
  TerminalError,
  FatalError,
  SkipFileError,
  AbortError,
  CommandFailedError,
  classifyException,
  isFatal,
  OPERATIONS,
  CANCEL,
  ANSWERS,
  BATCH,
  DELETE_FLAGS,
  CALC_FLAGS,
  LOOP_FLAGS,
  REOPEN_FLAGS,
  SIDES,
  // path + mask helpers, exported because sync/find/queue need the same rules
  includeTrailingSlash,
  excludeTrailingSlash,
  samePath,
  isChildPath,
  extractFileDir,
  extractFilePath,
  extractFileName,
  isAbsolutePath,
  isRootPath,
  isRealFile,
  expandFileName,
  absolutePath,
  maskFileName,
  maskFilePart,
  recycleFileMask,
  rightsText,
  addExecute,
};
