// transfer.js — the transfer half of core/Terminal.cpp.
//
// `terminal.js` deliberately stopped short of transfers and said so in its own
// header: it owns the operation lifecycle, the caches, delete/rename/move and
// the retry/skip/abort machinery, and it left CopyToRemote / CopyToLocal /
// Source / Sink / TParallelOperation out. This file is that missing half.
//
// What lives here, and why it is not in queue.js:
//
//   * **The overwrite decision.** ConfirmFileOverwrite, EffectiveBatchOverwrite
//     and CheckRemoteFile are the code that decides whether a file is
//     obliterated, resumed, appended to, renamed or left alone. Getting the
//     precedence wrong destroys data silently, so it is ported as one unit,
//     with the same ordering the C++ has, and tested combination by
//     combination.
//   * **The robust loops.** SourceRobust/SinkRobust retry ONE FILE after a
//     reconnect instead of restarting the whole operation, and they refuse to
//     retry when the session is still open — because a failure that did not
//     kill the session was not a connection problem and would fail again.
//   * **The recursion and the collection.** DirectorySource, SinkFile,
//     CreateTargetDirectory, TCollectedFileList and TParallelOperation.
//
// What does NOT live here: moving bytes. `queue.js` already does that, with
// its throttle, its pause gates, its text converter and its chunked parallel
// reader. This module never opens a stream; it hands a fully resolved plan to
// an injected `copyBytes` and lets the queue execute it. That is the whole
// anti-fork rule: **one byte mover, one decision maker.**
//
// The translation notes that matter:
//
//   * WinSCP's "local side" is the Windows file system reached through Win32
//     calls. Here both sides are Adapters (`protocols/local.js` is the local
//     one), so "local" means *the side the operation calls osLocal*, and every
//     Win32-only step (FileSetAttr, SetFileTime, faArchive) is expressed
//     through the adapter's `setRights` / `setTimes` or recorded as a gap.
//   * `TSearchRecSmart` becomes a plain handle object produced by `openFile()`.
//   * WinSCP's `qaXxx` bitmask becomes the string answers `terminal.js`
//     already uses, so one query surface serves both files.
'use strict';

const {
  MODIFICATION_FMT,
  reduceDateTimePrecision,
  lessDateTimePrecision,
  trimVmsVersion,
  getPartialFileExtLen,
  PARTIAL_EXT,
  sameUserName,
  ownerName,
} = require('./remotefiles');
// `common.js` is the port of core/Common.cpp and owns ValidLocalFileName and
// the two replacement sentinels. It is imported whole because this module both
// re-exports that function and needs the sentinels themselves.
const C = require('./common');
const { compareFileTime, formatSize } = C;
const { FileMask } = require('./masks');
const {
  ANSWERS, CANCEL, OPERATIONS, SIDES, DELETE_FLAGS, CALC_FLAGS,
  SkipFileError, AbortError, TerminalError,
  classifyException, RobustLoop,
  includeTrailingSlash, excludeTrailingSlash, extractFileName, extractFilePath,
  samePath, maskFileName, recycleFileMask,
} = require('./terminal');

// ===========================================================================
// Constants — Terminal.h and FileOperationProgress.h
// ===========================================================================

/** cpXxx — the copy parameters passed alongside a TCopyParamType. */
const COPY_FLAGS = Object.freeze({
  delete: 0x01,           // move, not copy: remove the source afterwards
  temporary: 0x04,        // the target is a temp directory (edit/open)
  noConfirmation: 0x08,   // never ask about an existing target
  append: 0x20,
  resume: 0x40,
  noRecurse: 0x80,        // one level only — the parallel transfer's mode
});

/** tfXxx — the per-call transfer flags. */
const TRANSFER_FLAGS = Object.freeze({
  firstLevel: 0x01,       // this entry was named by the user, so the file mask applies
  newDirectory: 0x02,     // the target directory was created by us, so nothing can exist in it
  autoResume: 0x04,       // set by a retry: resume without asking
  preCreateDir: 0x08,     // create the directory before its contents (SFTP/WebDAV/S3), not after (FTP)
  useFileTransferAny: 0x10,
});

/**
 * Does a transfer against this remote adapter carry `tfUseFileTransferAny`,
 * i.e. a reconnect budget? See `TransferEngine.limitedTransferReconnects` for
 * why setting the flag TIGHTENS rather than loosens.
 *
 * WinSCP sets it in exactly two places — TFTPFileSystem::CopyToLocal and
 * ::CopyToRemote (FtpFileSystem.cpp:1585, :1682) — so FTP and FTPS get the
 * ceiling and every other protocol keeps reconnecting indefinitely. An adapter
 * may state it outright with `caps.limitTransferReconnects`.
 *
 * Free-standing because both transfer paths need it: the foreground engine
 * through its own method, and the queue, whose upstream counterpart reaches
 * this decision by calling TTerminal::CopyToRemote (Queue.cpp:2324) rather
 * than by owning a second retry policy.
 */
function limitsTransferReconnects(adapter) {
  if (!adapter) return false;
  if (adapter.caps && adapter.caps.limitTransferReconnects !== undefined) {
    return !!adapter.caps.limitTransferReconnects;
  }
  // Exact names, not `includes('ftp')`: that substring is also in SFTP, the
  // one protocol WinSCP deliberately leaves unlimited.
  const p = String(adapter.protocolName || '').toLowerCase();
  return p === 'ftp' || p === 'ftps';
}

/**
 * TBatchOverwrite. The three `terminal.js` already had ('no', 'all', 'none')
 * are the same strings, so a progress object shared between the two files
 * never disagrees about what its `batchOverwrite` means.
 */
const BATCH_OVERWRITE = Object.freeze({
  no: 'no',                           // boNo — ask
  all: 'all',                         // boAll — overwrite everything
  none: 'none',                       // boNone — overwrite nothing
  older: 'older',                     // boOlder — overwrite only when the source is newer
  alternateResume: 'alternateResume', // boAlternateResume — resume rather than append
  append: 'append',                   // boAppend
  resume: 'resume',                   // boResume
});

/**
 * How deep `isEmptyDirectory` will descend before it gives up and answers
 * "not empty".
 *
 * WinSCP has no such bound, and does not need one on the remote side: every
 * descent there goes through `CanRecurseToDirectory` (Terminal.cpp:9018), so
 * the only way a remote tree can be infinite — a symlink pointing at one of
 * its own ancestors — is refused before the first extra level. The LOCAL side
 * has no such guard in the original (`DirectorySource`, Terminal.cpp:7852,
 * recurses on `SearchRec.IsDirectory()` alone) and this port keeps it that
 * way, because `directorySource` here recurses just as unconditionally and the
 * predicate must agree with the copy it is predicting. On a POSIX host
 * `/a/link -> /a` therefore produces `/a/link/link/link/…` for as long as
 * anyone is willing to list it.
 *
 * 128 is far past any real tree — Windows' own MAX_PATH cannot express a
 * hundred nested names — and the answer at the bound is the same conservative
 * one an unreadable directory gets: not empty. Guessing "empty" would drop the
 * directory and everything under it from the transfer in silence.
 */
const MAX_EMPTY_DIRECTORY_DEPTH = 128;

/** TSFTPOverwriteMode — what the byte mover is actually told to do. */
const OVERWRITE_MODE = Object.freeze({
  overwrite: 'overwrite',
  append: 'append',
  resume: 'resume',
});

/**
 * The buttons the overwrite question offers, in WinSCP's own vocabulary.
 * `all` is "Yes to newer", `ignore` is "Rename", `retry` is "Append".
 */
const OVERWRITE_ANSWERS = Object.freeze([
  ANSWERS.yes, ANSWERS.no, ANSWERS.cancel,
  ANSWERS.yesToAll, ANSWERS.noToAll, ANSWERS.all,
  'ignore', ANSWERS.retry, ANSWERS.skip,
]);

/** TQueueFileState. */
const QUEUE_FILE_STATE = Object.freeze({ queued: 0, processed: 1 });

/** Characters Windows refuses in a file name — LocalInvalidChars. */
const LOCAL_INVALID_CHARS = '/\\:*?"<>|';

const TOKEN_PREFIX = '%';

/**
 * TCopyParamType::FTokenizibleChars — `LocalInvalidChars + TokenPrefix`.
 *
 * The token prefix has to be in the set or the codec is not reversible: a
 * name that already contains "%3A" must have its own '%' encoded ("%253A")
 * so the way back can tell the user's literal text from our escape. Space
 * and dot are deliberately NOT in it — they are only encoded when they are
 * the LAST character, which ValidLocalFileName handles separately, so
 * putting them here would make RestoreChars decode a mid-name "%20" that
 * the user typed themselves.
 */
const TOKENIZIBLE_CHARS = `${LOCAL_INVALID_CHARS}${TOKEN_PREFIX}`;

/**
 * `InvalidCharsReplacement` is a `wchar_t` in the original, and its two
 * sentinels are `wchar_t(false)` and `wchar_t(true)` — U+0000 and U+0001, not
 * printable characters. That distinction is the whole point: a user who types
 * '%' as their replacement character gets a literal '%' substituted, they do
 * NOT silently switch the name codec into reversible token mode. This module
 * used its own '%' sentinel for a while, which meant the same C++ function was
 * ported twice with incompatible signals; `common.js` carries the faithful one
 * and is now the only implementation (see `validLocalFileName` below).
 */
const TOKEN_REPLACEMENT = C.TOKEN_REPLACEMENT;
const NO_REPLACEMENT = C.NO_REPLACEMENT;

// ===========================================================================
// TCopyParamType helpers
//
// These are the ones the transfer path needs. `queue.js` has its own copies of
// two of them; the ones here are the fuller ports (the file mask at the first
// level, and the reserved-name / token encoding that ValidLocalFileName does),
// which is why the transfer path uses these and not the queue's.
// ===========================================================================

/**
 * ::IsReservedName and ::ValidLocalFileName both live in core/Common.cpp, and
 * `common.js` is this repository's port of that file. They were transcribed a
 * second time here, which is exactly the fork this reconciliation exists to
 * remove: the two copies disagreed about the TokenReplacement sentinel ('%'
 * versus U+0001), about whether a trailing space is encoded outside token mode
 * (the C++ encodes it in BOTH modes) and about whether a reserved device name
 * is defused outside token mode (it is). `common.js` matches the original on
 * all three, so it is the surviving implementation and these are aliases —
 * kept because the whole transfer path and its tests import them from here.
 */
const isReservedName = C.isReservedName;

/**
 * ::ValidLocalFileName, with THIS module's defaults for the two character sets:
 * `TokenizibleChars` is `LocalInvalidChars + TokenPrefix`, which is what
 * TCopyParamType passes and what makes the %XX codec reversible.
 */
function validLocalFileName(fileName, replacement, tokenizibleChars, invalidChars) {
  return C.validLocalFileName(
    fileName === undefined || fileName === null ? '' : fileName,
    replacement === undefined || replacement === null || replacement === '' ? '_' : replacement,
    tokenizibleChars === undefined ? TOKENIZIBLE_CHARS : tokenizibleChars,
    invalidChars === undefined ? LOCAL_INVALID_CHARS : invalidChars);
}

/** TCopyParamType::RestoreChars — the inverse, applied on the way up. */
function restoreChars(fileName, replacement, tokenizibleChars) {
  const rep = replacement === undefined || replacement === null || replacement === '' ? '_' : replacement;
  if (rep !== TOKEN_REPLACEMENT) return String(fileName === undefined || fileName === null ? '' : fileName);
  const tokenizible = tokenizibleChars === undefined ? TOKENIZIBLE_CHARS : tokenizibleChars;

  let s = String(fileName === undefined || fileName === null ? '' : fileName);
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf(TOKEN_PREFIX, i);
    if (at < 0) break;
    const hex = s.substr(at + 1, 2);
    if (hex.length < 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) { i = at + 1; continue; }
    const code = parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    const endsHere = at + 3 === s.length;
    if (code !== 0 && ch !== '/' &&
        (tokenizible.includes(ch) ||
         ((ch === ' ' || (ch === '.' && at > 0)) && endsHere))) {
      s = s.slice(0, at) + ch + s.slice(at + 3);
      i = at + 1;
    } else if (code === 0 && (endsHere || s[at + 3] === '.') &&
               isReservedName(s.slice(0, at) + s.slice(at + 3))) {
      s = s.slice(0, at) + s.slice(at + 3);
      i = at;
    } else {
      i = at + 1;
    }
  }
  return s;
}

/**
 * TCopyParamType::ChangeFileName, through TTerminal::ChangeFileName.
 *
 * The order is load-bearing: the file mask renames FIRST and only at the first
 * level (a mask like `*.bak` must not be applied to every file inside a
 * directory the user selected), then the case conversion, and only then the
 * per-side character rules.
 *
 * `side` is the side the name is going TO — osRemote means it is being made
 * into a local name, so the invalid characters are replaced there.
 */
function changeFileName(copyParam, fileName, side, firstLevel, sessionData) {
  const cp = copyParam || {};
  let name = String(fileName === undefined || fileName === null ? '' : fileName);
  if (sessionData && sessionData.trimVMSVersions) name = trimVmsVersion(name);
  if (firstLevel && cp.fileMask) name = maskFileName(name, cp.fileMask);
  switch (cp.fileNameCase) {
    case 'upper': name = name.toUpperCase(); break;
    case 'lower': name = name.toLowerCase(); break;
    case 'firstUpper':
      name = name.slice(0, 1).toUpperCase() + name.slice(1).toLowerCase();
      break;
    case 'lowerShort':
      // ncLowerCaseShort: an all-caps 8.3 name is a DOS name, so lower-case it.
      if (name.length <= 12 && (name.indexOf('.') < 0 || name.indexOf('.') <= 8) &&
          name === name.toUpperCase()) {
        name = name.toLowerCase();
      }
      break;
    default: break;
  }
  if (side === SIDES.remote) {
    // Coming down from the server: the name has to survive a Windows path.
    if (cp.replaceInvalidChars === false) return name;
    return validLocalFileName(name, cp.invalidCharsReplacement);
  }
  // Going up: undo whatever the download encoded.
  return restoreChars(name, cp.invalidCharsReplacement);
}

/** TCopyParamType::AllowResume. */
function allowResume(copyParam, size, fileName) {
  const cp = copyParam || {};
  const ext = cp.partialFileExt === undefined ? PARTIAL_EXT : cp.partialFileExt;
  if (String(fileName || '').length + String(ext).length > 255) return false;
  switch (cp.resumeSupport) {
    case 'on': return true;
    case 'off': return false;
    case 'smart': return Number(size) >= Number(cp.resumeThreshold || 0);
    default: return false;
  }
}

/** TCopyParamType::UseAsciiTransfer. */
function useAsciiTransfer(copyParam, fileName, side, maskParams) {
  const cp = copyParam || {};
  switch (cp.transferMode) {
    case 'binary': return false;
    case 'text': return true;
    case 'automatic': {
      const mask = cp._asciiMask instanceof FileMask
        ? cp._asciiMask
        : new FileMask(cp.asciiFileMask || '');
      // Cached on the copy param: the mask is re-consulted for every file of a
      // recursive transfer, and re-parsing it each time is measurable.
      if (!(cp._asciiMask instanceof FileMask)) {
        Object.defineProperty(cp, '_asciiMask', { value: mask, enumerable: false, configurable: true, writable: true });
      }
      return mask.matches(fileName, {
        isDir: false,
        size: (maskParams || {}).size,
        mtime: (maskParams || {}).modification,
        path: (maskParams || {}).path,
        local: side === SIDES.local,
      });
    }
    default: return false;
  }
}

/** TCopyParamType::RemoteFileRights. */
function remoteFileRights(copyParam, isDirectory) {
  const cp = copyParam || {};
  const text = String(cp.rights || 'rw-r--r--').padEnd(9, '-');
  if (!isDirectory || cp.addXToDirectories === false) return text;
  const chars = text.split('');
  for (let g = 0; g < 3; g++) {
    const base = g * 3;
    if (chars[base] === 'r' || chars[base + 1] === 'w') chars[base + 2] = 'x';
  }
  return chars.join('');
}

/**
 * TCopyParamType::LocalFileAttrs — the only local attribute WinSCP derives
 * from remote rights is read-only, and only when `preserveReadOnly` is set.
 */
function localFileReadOnly(copyParam, rights) {
  const cp = copyParam || {};
  if (cp.preserveReadOnly === false) return false;
  const text = typeof rights === 'string' ? rights : (rights && rights.text) || '';
  // rrUserWrite is index 1 of 'rwxrwxrwx'.
  return text.length >= 2 && text[1] !== 'w';
}

/** TCopyParamType::ResumeTransfer — "resume THIS one file", set by the queue. */
function resumeTransfer(copyParam, fileName) {
  const cp = copyParam || {};
  return !!cp.transferResumeFile && cp.transferResumeFile === fileName;
}

/**
 * TCopyParamType::SkipTransfer. Deliberately does not filter directories: a
 * path enters the skip list when a transfer of it *starts*, so a directory has
 * to be recursed into and each file checked individually.
 */
function skipTransfer(copyParam, fileName, isDirectory) {
  const cp = copyParam || {};
  if (isDirectory) return false;
  const list = cp.transferSkipList;
  if (!list || !list.length) return false;
  return list.indexOf(fileName) >= 0;
}

// ===========================================================================
// TFileOperationProgressType members the transfer path needs
//
// `terminal.js` ported the progress object but not these three, because
// nothing but a transfer uses them. They are free functions rather than
// methods so the progress object stays the one `terminal.js` owns — two
// classes called OperationProgress would be worse than a slightly odd call.
// ===========================================================================

/**
 * RollbackTransfer. Called when a file is about to be attempted AGAIN after a
 * reconnect: everything this attempt counted has to come back out of the
 * totals, or a file retried three times reports three times its own size and
 * the progress bar sails past 100%.
 */
function rollbackTransfer(progress) {
  progress.transferredSize -= progress.skippedSize;
  progress.totalTransferred -= progress.transferredSize;
  progress.totalSkipped -= progress.skippedSize;
  progress.skippedSize = 0;
  progress.transferredSize = 0;
  progress.transferSize = 0;
  progress.localSize = 0;
}

/**
 * AddResumed. Bytes that were ALREADY on the far side count as transferred (so
 * the bar reflects the whole file) and as skipped (so the throughput figure
 * does not claim we moved them just now).
 */
function addResumed(progress, size) {
  const n = Number(size) || 0;
  if (n <= 0) return;
  progress.addSkipped(n);
  progress.skippedSize += n;
  progress.addTransferred(n);
}

/** SetAsciiTransfer — a plain flag, kept here so both files agree on the name. */
function setAsciiTransfer(progress, ascii) {
  progress.asciiTransfer = !!ascii;
}

/** TCopyParamType::AllowAnyTransfer — is there any filtering at all? */
function allowAnyTransfer(copyParam) {
  const cp = copyParam || {};
  return !cp.includeFileMask &&
    !cp.excludeHiddenFiles &&
    !cp.excludeEmptyDirectories &&
    (!cp.transferSkipList || !cp.transferSkipList.length) &&
    !cp.transferResumeFile;
}

// ===========================================================================
// TOverwriteFileParams
// ===========================================================================

/**
 * The four numbers and two precisions the overwrite question is answered from.
 * The precisions are not decoration: `boOlder` compares the two timestamps
 * after reducing BOTH to the coarser of the two, because an FTP listing that
 * only says "Jul 14 09:31" cannot be compared second-by-second against a local
 * file without deciding to re-copy everything, every time.
 */
class OverwriteFileParams {
  constructor(o) {
    const p = o || {};
    this.sourceSize = Number(p.sourceSize) || 0;
    this.sourceTimestamp = Number(p.sourceTimestamp) || 0;
    this.sourcePrecision = p.sourcePrecision === undefined ? MODIFICATION_FMT.FULL : p.sourcePrecision;
    this.destSize = Number(p.destSize) || 0;
    this.destTimestamp = Number(p.destTimestamp) || 0;
    this.destPrecision = p.destPrecision === undefined ? MODIFICATION_FMT.FULL : p.destPrecision;
  }
}

// ===========================================================================
// TCollectedFileList
// ===========================================================================

/**
 * The flat list a size calculation collects, which a parallel transfer then
 * consumes. `recursed` is false when the enumeration could NOT descend into a
 * directory — the entry is kept so the failure is reproduced (and reported)
 * when the transfer reaches it, instead of the subtree silently vanishing.
 */
class CollectedFileList {
  constructor() { this._list = []; }

  add(fileName, object, dir) {
    this._list.push({
      fileName, object: object || null, dir: !!dir, recursed: true, state: QUEUE_FILE_STATE.queued,
    });
    return this._list.length - 1;
  }

  didNotRecurse(index) { if (this._list[index]) this._list[index].recursed = false; }

  delete(index) { this._list.splice(index, 1); }

  count() { return this._list.length; }

  getFileName(index) { return this._list[index].fileName; }

  getObject(index) { return this._list[index].object; }

  isDir(index) { return this._list[index].dir; }

  isRecursed(index) { return this._list[index].recursed; }

  getState(index) { return this._list[index].state; }

  setState(index, state) { this._list[index].state = state; }

  /** Build from `terminal.calculateFilesSize({ collectFiles: true }).files`. */
  static fromCollected(files) {
    const list = new CollectedFileList();
    for (const f of files || []) {
      const i = list.add(f.fileName, f.file || null, !!f.dir);
      if (f.recursed === false) list.didNotRecurse(i);
    }
    return list;
  }
}

// ===========================================================================
// TParallelOperation
// ===========================================================================

/**
 * The shared cursor several connections walk one collected file list with.
 *
 * The three rules that make it correct rather than merely concurrent:
 *
 *  1. A file inside a directory is not handed out until that directory has
 *     been *created* on the far side. `getNext` answers 0 ("nothing yet, ask
 *     again") rather than handing out a file whose parent does not exist.
 *  2. When a directory fails, every entry underneath it is removed from the
 *     list — otherwise every one of them fails separately with the same error.
 *  3. `done()` for a parallel *file* transfer merges the parts in order under
 *     a single-holder flag, so two connections finishing at once cannot both
 *     start merging.
 */
class ParallelOperation {
  constructor(side) {
    if (side !== SIDES.local && side !== SIDES.remote) {
      throw new TerminalError(`A parallel operation is either local or remote, not "${side}".`);
    }
    this.side = side;
    this.copyParam = null;
    this.params = 0;
    this.targetDir = '';
    this.mainName = '';
    this.version = 0;
    this._fileLists = null;      // [{ rootPath, files: CollectedFileList }]
    this._listIndex = 0;
    this._index = 0;
    this._clients = 0;
    this._probablyEmpty = false;
    this._directories = new Map();  // sourcePath -> { oppositePath, exists }
    this._mainProgress = null;
    // Parallel transfer of ONE file, split into parts.
    this.isParallelFileTransfer = false;
    this._parallelFileSize = -1;
    this._parallelFileOffset = 0;
    this._parallelFileCount = 0;
    this._parallelFileOffsets = [];
    this._parallelFileDones = [];
    this._parallelFileMerging = false;
    this._parallelFileMerged = 0;
    this._parallelFileTargetName = '';
    /** Configuration->QueueTransfersLimit — how many parts one file is cut into. */
    this.transfersLimit = 2;
  }

  /**
   * @param {Array} fileLists  [{ rootPath, files: CollectedFileList }]
   * @param {number} parallelFileSize  >= 0 turns on split-one-file mode
   */
  init(fileLists, targetDir, copyParam, params, mainProgress, mainName, parallelFileSize, transfersLimit) {
    if (this._fileLists) throw new TerminalError('This parallel operation is already initialized.');
    this._fileLists = fileLists;
    this.targetDir = targetDir;
    this.copyParam = copyParam;
    this.params = Number(params) || 0;
    this._mainProgress = mainProgress || null;
    this.mainName = mainName || '';
    this._listIndex = 0;
    this._index = 0;
    this.isParallelFileTransfer = Number(parallelFileSize) >= 0;
    this._parallelFileSize = Number(parallelFileSize);
    this._parallelFileOffset = 0;
    this._parallelFileCount = 0;
    this._parallelFileOffsets = [];
    this._parallelFileDones = [];
    this._parallelFileMerging = false;
    this._parallelFileMerged = 0;
    this._parallelFileTargetName = '';
    if (transfersLimit) this.transfersLimit = Math.max(1, Number(transfersLimit) || 1);
  }

  get isInitialized() { return this._mainProgress !== null; }

  /**
   * Is there any point starting another connection? "Probably" is honest: the
   * answer is a snapshot, and a connection that arrives to find the list empty
   * simply gets -1 from `getNext`.
   */
  shouldAddClient() {
    if (!this.isInitialized) return false;
    return !this._probablyEmpty && this._mainProgress.cancel < CANCEL.cancel;
  }

  addClient() { this._clients += 1; }

  removeClient() { this._clients -= 1; }

  get clients() { return this._clients; }

  /** WaitFor: block until every client has left. */
  async waitFor(sleep) {
    if (!this._fileLists) return;
    const wait = sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    while (this._clients > 0) {
      // Propagate the total progress the parallel connections incremented.
      // A caller with a lighter progress object simply has nothing to emit.
      if (this._mainProgress && typeof this._mainProgress._progress === 'function') {
        this._mainProgress._progress();
      }
      await wait(200);
    }
    this._probablyEmpty = true;
  }

  getFileList(index) {
    const entry = this._fileLists && this._fileLists[index];
    return entry ? entry.files : null;
  }

  getRootPath(index) {
    const entry = this._fileLists && this._fileLists[index];
    return entry ? entry.rootPath : '';
  }

  /** CheckEnd — advance to the next list when this one is exhausted. */
  _checkEnd(files) {
    const done = this._index >= files.count();
    if (done) {
      this._listIndex += 1;
      this._index = 0;
    }
    return done;
  }

  /**
   * GetOnlyFile — is this whole operation exactly one plain file? That is the
   * precondition for splitting a single file across connections.
   */
  static getOnlyFile(fileLists) {
    if (!fileLists || fileLists.length !== 1) return null;
    const files = fileLists[0].files;
    if (!files || files.count() !== 1 || files.isDir(0)) return null;
    return { fileName: files.getFileName(0), object: files.getObject(0) };
  }

  /** The prefix every part of a split file is written under. */
  static getPartPrefix(fileName) {
    return `${fileName}${PARTIAL_EXT}.`;
  }

  /**
   * GetNext. Returns:
   *    1  `out` was filled in — go and transfer it
   *    0  nothing available *yet* (a parent directory is still being created)
   *   -1  the list is exhausted
   */
  getNext(out, changeName) {
    let result = 1;
    let files = null;
    do {
      if (this._fileLists && this._fileLists.length > this._listIndex) {
        files = this.getFileList(this._listIndex);
        // The list can be empty when everything in it was excluded by a mask.
        if (this._checkEnd(files)) files = null;
      } else {
        files = null;
        result = -1;
      }
    } while (result === 1 && files === null);

    if (files !== null) {
      const rootPath = this.getRootPath(this._listIndex);
      out.fileName = files.getFileName(this._index);
      out.object = files.getObject(this._index);
      out.dir = files.isDir(this._index);
      out.recursed = files.isRecursed(this._index);
      out.customCopyParam = null;
      out.targetDir = '';

      // The local side may be a Windows path with backslashes, so its parent
      // is extracted with the separator-agnostic helper rather than the unix one.
      const dirPath = this.side === SIDES.local
        ? extractFileDirLocal(excludeTrailingSlash(out.fileName))
        : excludeTrailingSlash(extractFilePath(out.fileName));
      const firstLevel = samePath(dirPath, excludeTrailingSlash(rootPath));

      if (firstLevel) {
        out.targetDir = this.targetDir;
      } else {
        const data = this._directories.get(dirPath);
        if (!data) {
          throw new TerminalError(`Parent path "${dirPath}" is not known to the parallel operation.`);
        }
        if (!data.exists) {
          result = 0;    // wait for the parent directory to be created
        } else {
          out.targetDir = data.oppositePath;
        }
      }

      if (out.targetDir) {
        let onlyFileName = '';
        if (out.dir || this.isParallelFileTransfer) {
          onlyFileName = extractFileNameFor(this.side, excludeTrailingSlash(out.fileName));
          onlyFileName = changeName
            ? changeName(onlyFileName, this.side, firstLevel)
            : changeFileName(this.copyParam, onlyFileName, this.side, firstLevel);
        }

        if (out.dir) {
          // UniversalCombinePaths: the TARGET of an osLocal operation is the
          // remote (unix) side, and vice versa.
          const sep = this.side === SIDES.local ? '/' : '\\';
          const base = String(out.targetDir);
          const oppositePath = /[/\\]$/.test(base)
            ? base + onlyFileName
            : base + sep + onlyFileName;
          this._directories.set(excludeTrailingSlash(out.fileName), { oppositePath, exists: false });
        }

        let processed = true;
        if (this.isParallelFileTransfer) {
          processed = this._nextFilePart(out, onlyFileName);
        }

        if (processed) {
          // UpdateFileList depends on this exact shape: every entry before
          // `_index` has been handed out, one by one, in order.
          files.setState(this._index, QUEUE_FILE_STATE.processed);
          this._index += 1;
          this._checkEnd(files);
        }
      }
    }

    this._probablyEmpty = !this._fileLists || this._fileLists.length === this._listIndex;
    return result;
  }

  /**
   * The split-one-file branch of GetNext. Each call carves the next part off
   * the file; the last part is left open-ended, and a would-be final part
   * smaller than a tenth of a full one is folded into its predecessor rather
   * than opening a connection to move a few kilobytes.
   */
  _nextFilePart(out, onlyFileName) {
    const custom = { ...this.copyParam };
    custom.partOffset = this._parallelFileOffset;
    const remaining = this._parallelFileSize - custom.partOffset;
    const limit = Math.max(1, Number(this.transfersLimit) || 1);
    custom.partSize = Math.floor(this._parallelFileSize / limit);

    if (!this._parallelFileTargetName) this._parallelFileTargetName = onlyFileName;

    const index = this._parallelFileCount;
    const partFileName = ParallelOperation.getPartPrefix(onlyFileName) + String(index);
    this._parallelFileCount += 1;
    this._parallelFileOffsets.push(custom.partOffset);
    this._parallelFileDones.push(false);
    // DelimitFileNameMask: the part name is a LITERAL target name, so any '*'
    // or '?' the user's file name happens to contain must not be read as a
    // wildcard by MaskFileName.
    custom.fileMask = delimitFileNameMask(partFileName);

    let processed = true;
    if (custom.partSize >= remaining || (remaining - custom.partSize) < custom.partSize / 10) {
      custom.partSize = -1;                       // until the end of the file
      this._parallelFileOffset = this._parallelFileSize;
    } else {
      processed = false;                          // the same file yields another part
      this._parallelFileOffset += custom.partSize;
    }
    out.customCopyParam = custom;
    out.partIndex = index;
    return processed;
  }

  /**
   * Done. For a directory this records that it now exists (unblocking its
   * children) or, on failure, removes the whole subtree from the list. For a
   * part of a split file it merges the parts that are ready, in order.
   */
  async done(fileName, dir, success, targetDir, copyParam, mergeOps, transferredSize) {
    if (dir) {
      const key = excludeTrailingSlash(fileName);
      const data = this._directories.get(key);
      if (!data) return;
      if (success) {
        data.exists = true;
        return;
      }
      this._directories.delete(key);
      if (!this._fileLists || this._fileLists.length <= this._listIndex) return;
      const withSlash = includeTrailingSlash(key);
      const files = this.getFileList(this._listIndex);
      let i = 0;
      while (i < files.count()) {
        if (String(files.getFileName(i)).startsWith(withSlash)) {
          files.delete(i);
          this.version += 1;         // force the queue's file-list view to refresh
          if (i < this._index) this._index -= 1;
        } else {
          i += 1;
        }
      }
      return;
    }

    if (!this.isParallelFileTransfer) return;
    let ok = success;
    try {
      if (success) {
        const at = this._parallelFileOffsets.indexOf(copyParam.partOffset);
        if (at < 0) return;

        // INCONSISTENT_SIZE. A bounded part that moved a different number of
        // bytes than it was asked for is NOT a part of this file, and merging
        // it produces a plausible-looking file with a hole in it that nothing
        // downstream can detect. The original refuses here, and so do we —
        // before the part is marked done, so no later part merges past it.
        const partSize = copyParam.partSize === undefined ? -1 : copyParam.partSize;
        if (partSize >= 0 && transferredSize !== undefined && Number(transferredSize) !== partSize) {
          const partName = ParallelOperation.getPartPrefix(
            includeTrailingSlash(targetDir) + this._parallelFileTargetName) + String(at);
          ok = false;
          throw new TerminalError(
            `Transferred size of "${partName}" is ${transferredSize}, but ${partSize} was expected. ` +
            'The parts cannot be merged into a correct file.');
        }

        this._parallelFileDones[at] = true;
        if (this._parallelFileMerging) return;

        this._parallelFileMerging = true;
        try {
          const targetName = includeTrailingSlash(targetDir) + this._parallelFileTargetName;
          const targetPartial = targetName + PARTIAL_EXT;
          const onlyName = extractFileName(excludeTrailingSlash(fileName));
          for (;;) {
            if (this._parallelFileMerged >= this._parallelFileCount ||
                !this._parallelFileDones[this._parallelFileMerged]) break;
            const index = this._parallelFileMerged;
            const partName = ParallelOperation.getPartPrefix(
              includeTrailingSlash(targetDir) + onlyName) + String(index);
            if (index === 0) {
              await mergeOps.renameForce(partName, targetPartial);
            } else {
              await mergeOps.append(partName, targetPartial);
              await mergeOps.remove(partName);
            }
            this._parallelFileMerged += 1;
          }
          if (this._parallelFileMerged === this._parallelFileCount &&
              this._parallelFileOffset === this._parallelFileSize) {
            await mergeOps.renameForce(targetPartial, targetName);
          }
        } catch (e) {
          ok = false;
          throw e;
        } finally {
          this._parallelFileMerging = false;
        }
      }
    } finally {
      // One failed part means the file is unusable: cancel the whole operation
      // rather than leaving a plausible-looking file with a hole in it.
      if (!ok && this._mainProgress) this._mainProgress.setCancelAtLeast(CANCEL.cancel);
    }
  }
}

/** ::DelimitFileNameMask — escape every wildcard so the name stays literal. */
function delimitFileNameMask(name) {
  return String(name).replace(/[*?[\\]/g, (c) => `\\${c}`);
}

/** The directory of a local (Windows-shaped) path, without its trailing slash. */
function extractFileDirLocal(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '';
  return i === 0 ? s.slice(0, 1) : s.slice(0, i);
}

/**
 * The last component of a LOCAL path.
 *
 * `extractFileName` in terminal.js splits on '/' only, deliberately: WinSCP's
 * remote path arithmetic is always POSIX and making it separator-agnostic would
 * corrupt a remote name that legitimately contains a backslash. A local
 * Windows path is the opposite case, and using the POSIX version on one returns
 * the WHOLE path as the "file name" — which then gets joined onto the target
 * directory, so `C:\work\a.bin` uploads to `/uploads/C:\work\a.bin`. That is a
 * silent wrong-destination bug, not a crash, which is why it needs its own
 * helper rather than a shared one that tries to be clever.
 */
function extractFileNameLocal(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? s : s.slice(i + 1);
}

/** The base name on whichever side the path belongs to. */
function extractFileNameFor(side, p) {
  return side === SIDES.local ? extractFileNameLocal(p) : extractFileName(p);
}

// ===========================================================================
// The session action record
// ===========================================================================

/**
 * TUploadSessionAction / TDownloadSessionAction, reduced to what the XML
 * actions log in `logging.js` can record. `restart()` exists so a retried file
 * does not appear twice, and `rollback()` records the failure that a
 * *reconnect* did not recover from — a distinction the log would otherwise
 * lose.
 */
class TransferAction {
  constructor(actionsLog, direction) {
    this.log = actionsLog || null;
    this.direction = direction;
    this.valid = true;
    this.cancelled = false;
    this.committed = false;
    this.source = '';
    this.destination = '';
    this.size = undefined;
    this.error = null;
  }

  fileName(name) { this.source = name; return this; }

  destinationPath(name) { this.destination = name; return this; }

  setSize(n) { this.size = n; return this; }

  /** The entry turned out to be a directory: nothing to record. */
  cancel() { this.cancelled = true; this.valid = false; }

  restart() {
    this.cancelled = false;
    this.committed = false;
    this.valid = true;
    this.error = null;
  }

  rollback(e) {
    this.error = e || new Error('The transfer failed.');
    this._commit({ ok: false, message: this.error.message });
  }

  commit() { this._commit({ ok: true }); }

  _commit(result) {
    if (this.committed || this.cancelled || !this.valid || !this.log) return;
    this.committed = true;
    this.log.transfer(this.direction, this.source, this.destination, this.size, result);
  }
}

// ===========================================================================
// A host and a progress for callers that have no Terminal
//
// `queue.js` transfers between two adapters without ever building a Terminal:
// it has the adapters, it has a way to ask the user, and that is all the
// overwrite decision actually needs. These two small classes are that surface,
// so the queue calls the same `confirmFileOverwrite` the session path does
// instead of keeping a second, divergent copy of the rules.
// ===========================================================================

/** The slice of Terminal that the overwrite decision reads. */
class StandaloneHost {
  constructor(o) {
    const d = o || {};
    this._adapter = d.adapter || null;
    this._prefs = d.prefs || {};
    this._queryUser = d.queryUser || (async () => ANSWERS.cancel);
    this._logEvent = d.logEvent || (() => {});
    this._promptName = d.promptName || (async () => '');
    this.sessionData = d.sessionData || {};
    this.session = {
      name: d.name || '',
      ask: async (kind, request) => {
        const value = await this._promptName(request && request.value);
        return value ? { value } : null;
      },
    };
    this.config = {
      prefs: this._prefs,
      setPref: d.setPref || ((key, value) => { this._prefs[key] = value; }),
    };
  }

  get adapter() { return this._adapter; }

  get prefs() { return this._prefs; }

  get active() { return !!(this._adapter && this._adapter.connected); }

  logEvent(text) { this._logEvent(text); }

  logMessage(kind, text) { this._logEvent(text); }

  /** Only the capabilities the decision path asks about. */
  isCapable(capability) {
    const c = (this._adapter && this._adapter.caps) || {};
    switch (capability) {
      case 'rename': return c.rename !== false;
      case 'resumeSupport': return !!c.resume;
      case 'textMode': return c.textMode !== false;
      case 'modeChangingUpload': return !!c.rights;
      case 'preservingTimestampUpload':
      case 'preservingTimestampDirs': return !!c.timestamp;
      default: return false;
    }
  }

  queryUser(query) { return this._queryUser(query); }
}

/**
 * The slice of TFileOperationProgressType the overwrite decision reads and
 * writes. `batchOverwrite` is the important field: it is where "Yes to all"
 * lives, which is why it belongs to the operation and not to one file.
 */
class SimpleProgress {
  constructor(side) {
    this.side = side === SIDES.local ? SIDES.local : SIDES.remote;
    this.batchOverwrite = BATCH_OVERWRITE.no;
    this.cancel = CANCEL.continue;
    this.asciiTransfer = false;
    this.localSize = 0;
    this.transferSize = 0;
    this.transferredSize = 0;
    this.skippedSize = 0;
    this.totalTransferred = 0;
    this.totalSkipped = 0;
  }

  suspend() { /* nothing to pause: the queue owns its own clock */ }

  resume() { /* as above */ }

  setBatchOverwrite(b) { this.batchOverwrite = b; }

  setCancel(c) { this.cancel = c; }

  setCancelAtLeast(c) { if (this.cancel < c) this.cancel = c; }

  addSkipped(n) { this.totalSkipped += Number(n) || 0; }

  addTransferred(n) {
    const v = Number(n) || 0;
    this.transferredSize += v;
    this.totalTransferred += v;
  }
}

// ===========================================================================
// TransferEngine
// ===========================================================================

/**
 * The host this engine runs against is a `design/main/terminal.js` Terminal —
 * it supplies the queries, the capabilities, the reconnect loop, the caches
 * and the operation progress. Everything protocol-specific goes through the
 * Adapter contract.
 *
 * options:
 *   localAdapter   the Adapter standing in for WinSCP's "local" side
 *   copyBytes      REQUIRED. `async ({...plan}) => bytesWritten`. queue.js
 *                  supplies its own, which is why this module never opens a
 *                  stream: one byte mover, one decision maker.
 *   fileSystem     overrides the default Source/Sink implementation
 *   actionsLog     a logging.js ActionsLog, or null
 *   sleep          injectable timer, so the parallel wait is testable
 */
class TransferEngine {
  constructor(terminal, options = {}) {
    if (!terminal) throw new TerminalError('A transfer engine needs a terminal.');
    this.terminal = terminal;
    this.local = options.localAdapter || null;
    this.copyBytes = options.copyBytes || null;
    this.actionsLog = options.actionsLog ||
      (terminal.session && terminal.session.actionsLog) || null;
    this.sleep = options.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    this.fileSystem = options.fileSystem || new AdapterFileSystem(this);
    this._lastProgressLogged = 0;
    this.destFileName = '';
    this.multipleDestinationFiles = false;
  }

  get remote() { return this.terminal.adapter; }

  get prefs() { return this.terminal.prefs || {}; }

  /** The queue block of the preferences — where the parallel settings live. */
  get queuePrefs() { return this.prefs.queue || {}; }

  logEvent(text) { this.terminal.logEvent(text); }

  /**
   * The adapter for a side. `osLocal` is the machine WinSCP runs on; here it
   * is whichever adapter the caller nominated as local, which for a
   * local-to-remote transfer is `protocols/local.js`.
   */
  adapterFor(side) {
    const a = side === SIDES.local ? this.local : this.remote;
    if (!a) throw new TerminalError(`No ${side} file system is available for this transfer.`);
    return a;
  }

  // ---------------------------------------------------- overwrite decision

  /**
   * fcNewerOnlyUpload. WinSCP answers true for SFTP and FTP and false for SCP,
   * WebDAV and S3, and the reason is not arbitrary: "only newer" compares the
   * source timestamp against the TARGET's, so it needs a target timestamp that
   * means what it says. S3 and WebDAV assign `Last-Modified` themselves (it is
   * the upload time, so every file always looks older) and SCP only ever sees
   * an `ls` line. Offering the option there would silently re-upload
   * everything, or silently upload nothing.
   *
   * `terminal.isCapable` has no case for this one, so it is answered here from
   * the same facts rather than by adding a case to a file this module does not
   * own. An adapter may state it outright with `caps.newerOnlyUpload`.
   */
  newerOnlyUploadCapable() {
    const a = this.remote;
    if (!a) return false;
    if (a.caps && a.caps.newerOnlyUpload !== undefined) return !!a.caps.newerOnlyUpload;
    const p = String(a.protocolName || '').toLowerCase();
    return !(p.includes('scp') || p.includes('webdav') || p.includes('s3'));
  }

  /**
   * fcParallelTransfers — several files over several connections. Every
   * protocol here can do it except SCP, whose recursion is driven by the
   * server rather than by us, so it cannot be handed one entry at a time
   * (WinSCP's own comment: "does not implement cpNoRecurse").
   */
  parallelTransfersCapable() {
    const a = this.remote;
    if (!a) return false;
    if (a.caps && a.caps.parallelTransfers !== undefined) return !!a.caps.parallelTransfers;
    return !String(a.protocolName || '').toLowerCase().includes('scp');
  }

  /**
   * tfUseFileTransferAny — does a transfer over this protocol get a RECONNECT
   * BUDGET?
   *
   * The flag reads backwards until you check the braces. Both arms that consult
   * a budget live inside `if (FAnyTransfer != NULL)` (Terminal.cpp:538-559), so
   * WITHOUT the flag TRobustOperationLoop never calls ContinueReopen at all and
   * keeps reconnecting for as long as QueryReopen says yes. Setting it is what
   * IMPOSES the SessionReopenTimeout ceiling and the "Retry interval expired,
   * will not retry transfer" giving-up; the progress-based reset only softens
   * that, by restarting the window whenever bytes actually moved.
   *
   * WinSCP sets it in exactly two places — TFTPFileSystem::CopyToLocal and
   * ::CopyToRemote (FtpFileSystem.cpp:1585, :1682) — the FTP back end's own
   * transfer entry points, and nowhere else. Not its listings, not its deletes,
   * and not any other protocol: an SFTP transfer that keeps dropping is retried
   * indefinitely. FTP is singled out because of its second connection: a data
   * transfer that stalls drags the control connection down with it, so an FTP
   * transfer can fail-and-reconnect in a tight loop while moving nothing at
   * all, which is precisely what the ceiling stops.
   *
   * An adapter may state it outright with `caps.limitTransferReconnects`.
   *
   * The test itself is the module-level `limitsTransferReconnects` below, so
   * that queue.js — WinSCP's queue item calls TTerminal::CopyToRemote
   * (Queue.cpp:2324) and therefore lands in this same decision — asks the
   * question the same way instead of guessing at "ftp".
   */
  limitedTransferReconnects() {
    return limitsTransferReconnects(this.remote);
  }

  /** Configuration->ConfirmOverwriting. */
  get confirmOverwriting() { return this.prefs.confirmOverwriting !== false; }

  setConfirmOverwriting(value) {
    if (this.terminal.config && typeof this.terminal.config.setPref === 'function') {
      this.terminal.config.setPref('confirmOverwriting', !!value);
    } else if (this.terminal.config && this.terminal.config.prefs) {
      this.terminal.config.prefs.confirmOverwriting = !!value;
    }
  }

  /** Configuration->ConfirmResume. */
  get confirmResume() { return this.prefs.confirmResume !== false; }

  setConfirmResume(value) {
    if (this.terminal.config && typeof this.terminal.config.setPref === 'function') {
      this.terminal.config.setPref('confirmResume', !!value);
    } else if (this.terminal.config && this.terminal.config.prefs) {
      this.terminal.config.prefs.confirmResume = !!value;
    }
  }

  /**
   * TTerminal::EffectiveBatchOverwrite — THE precedence, in the original's
   * order. Read it top to bottom; every rung beats everything below it.
   *
   *   1. `cpResume` (or "resume this one file") wins over everything. It is
   *      only offered when `special` is set, because the *decision* needs to
   *      know that resume is on the table while the *fallback* must not.
   *   2. `cpAppend`.
   *   3. "Transfer only new files": once newerOnly is on there is no way to
   *      change the batch mode, so the question is never asked at all.
   *   4. "Do not confirm" or the global confirmation switch being off: the
   *      answer is unconditional overwrite, and again no question.
   *   5. Otherwise: whatever the user already answered "to all" with.
   *
   * `special === false` is the fallback pass. It strips the three modes that
   * only make sense for a resumable transfer, so a batch answer of "resume"
   * cannot leak into a file that cannot be resumed.
   */
  effectiveBatchOverwrite(sourceFullFileName, copyParam, params, progress, special) {
    const cp = copyParam || {};
    const p = Number(params) || 0;
    const partOffset = cp.partOffset === undefined ? -1 : cp.partOffset;

    if (special &&
        ((p & COPY_FLAGS.resume) || resumeTransfer(cp, sourceFullFileName)) &&
        partOffset < 0) {
      return BATCH_OVERWRITE.resume;
    }
    if (p & COPY_FLAGS.append) return BATCH_OVERWRITE.append;
    if (cp.newerOnly &&
        ((progress.side === SIDES.local && this.newerOnlyUploadCapable()) ||
         progress.side !== SIDES.local) &&
        partOffset < 0) {
      return BATCH_OVERWRITE.older;
    }
    if ((p & COPY_FLAGS.noConfirmation) || !this.confirmOverwriting) {
      return BATCH_OVERWRITE.all;
    }
    let result = progress.batchOverwrite || BATCH_OVERWRITE.no;
    if (!special && (result === BATCH_OVERWRITE.older ||
        result === BATCH_OVERWRITE.alternateResume ||
        result === BATCH_OVERWRITE.resume)) {
      result = BATCH_OVERWRITE.no;
    }
    return result;
  }

  /**
   * TTerminal::CheckRemoteFile — "do we need to look at the target at all?"
   *
   * False means the target is going to be overwritten unconditionally, so the
   * existence probe (a round trip per file) is skipped. Anything else means we
   * must know what is there before we touch it.
   */
  checkRemoteFile(fileName, copyParam, params, progress) {
    return this.effectiveBatchOverwrite(fileName, copyParam, params, progress, true) !== BATCH_OVERWRITE.all;
  }

  /**
   * TTerminal::ConfirmFileOverwrite.
   *
   * Returns one of the query answers. The mapping the callers depend on:
   *   yes    overwrite
   *   no     skip this file
   *   cancel abort the operation
   *   retry  append or resume — the caller decides which
   *   skip   "alternate resume": resume rather than append
   *   ignore rename, the caller prompts for the new name
   *
   * Two subtleties that are easy to lose in translation:
   *
   *   * The batch mode is computed with `special = true`, and if that mode is
   *     not *applicable* to this file (an "older" decision with no file
   *     information, or a resume with nothing to resume) it is recomputed with
   *     `special = false`. That second pass is what stops a stale "resume all"
   *     from silently skipping a file it cannot resume.
   *   * A cancel that arrived from a *parallel* connection short-circuits the
   *     question. Without it every connection puts its own dialog on screen
   *     after the user has already said stop.
   */
  async confirmFileOverwrite(sourceFullFileName, targetFileName, fileParams, answers,
    side, copyParam, params, progress, message) {
    let result = ANSWERS.cancel;
    const canAlternateResume = !!fileParams &&
      fileParams.destSize < fileParams.sourceSize &&
      !progress.asciiTransfer;

    let batch = this.effectiveBatchOverwrite(sourceFullFileName, copyParam, params, progress, true);
    let applicable = true;
    switch (batch) {
      case BATCH_OVERWRITE.older: applicable = !!fileParams; break;
      case BATCH_OVERWRITE.alternateResume:
      case BATCH_OVERWRITE.resume: applicable = canAlternateResume; break;
      default: break;
    }
    if (!applicable) {
      batch = this.effectiveBatchOverwrite(sourceFullFileName, copyParam, params, progress, false);
    }

    if (batch !== BATCH_OVERWRITE.no) {
      this.logEvent(`Batch operation mode [${batch}] is effective`);
    } else if (progress.cancel > CANCEL.continue) {
      this.logEvent('Transfer cancelled in parallel operation');
      return ANSWERS.cancel;
    } else {
      let text = message;
      if (!text) {
        text = side === SIDES.local
          ? `Local file "${targetFileName}" already exists. Overwrite it?`
          : `Remote file "${targetFileName}" already exists. Overwrite it?`;
      }
      const more = [];
      if (fileParams) {
        more.push(`Source: ${formatSize(fileParams.sourceSize)}, ` +
          `${describeTimestamp(fileParams.sourceTimestamp, fileParams.sourcePrecision)}`);
        more.push(`Target: ${formatSize(fileParams.destSize)}, ` +
          `${describeTimestamp(fileParams.destTimestamp, fileParams.destPrecision)}`);
      }

      progress.suspend();
      try {
        result = await this.terminal.queryUser({
          message: text,
          moreMessages: more,
          answers,
          type: 'confirmation',
          neverAskAgain: true,
          helpKeyword: 'overwrite',
          aliases: {
            all: 'Yes to newer', ignore: 'Rename', retry: 'Append',
            yesToAll: 'Yes to all', noToAll: 'No to all',
          },
        });
      } finally {
        progress.resume();
      }

      switch (result) {
        case ANSWERS.neverAskAgain:
          this.setConfirmOverwriting(false);
          result = ANSWERS.yes;
          break;
        case ANSWERS.yesToAll: batch = BATCH_OVERWRITE.all; break;
        case ANSWERS.all: batch = BATCH_OVERWRITE.older; break;
        case ANSWERS.noToAll: batch = BATCH_OVERWRITE.none; break;
        default: break;
      }

      // If the user did not pick a batch mode, keep the current one. We can
      // reach here even when a batch mode WAS already selected, because it
      // could not be applied to this file.
      if (batch !== BATCH_OVERWRITE.no) progress.setBatchOverwrite(batch);
    }

    if (batch !== BATCH_OVERWRITE.no) {
      switch (batch) {
        case BATCH_OVERWRITE.all:
          this.logEvent('Overwriting all files');
          result = ANSWERS.yes;
          break;
        case BATCH_OVERWRITE.none:
          this.logEvent('Not overwriting any file');
          result = ANSWERS.no;
          break;
        case BATCH_OVERWRITE.older:
          if (!fileParams) {
            this.logEvent('Not overwriting due to lack of file information');
            result = ANSWERS.no;
          } else {
            const precision = lessDateTimePrecision(fileParams.sourcePrecision, fileParams.destPrecision);
            const src = reduceDateTimePrecision(fileParams.sourceTimestamp, precision);
            const dst = reduceDateTimePrecision(fileParams.destTimestamp, precision);
            result = compareFileTime(src, dst) > 0 ? ANSWERS.yes : ANSWERS.no;
            this.logEvent(`Source file timestamp is [${new Date(src).toISOString()}], ` +
              `destination timestamp is [${new Date(dst).toISOString()}], ` +
              `will${result === ANSWERS.yes ? '' : ' not'} overwrite`);
          }
          break;
        case BATCH_OVERWRITE.alternateResume:
          this.logEvent('Alternate resume mode');
          result = ANSWERS.skip;      // "ugh", says the original, and it is right
          break;
        case BATCH_OVERWRITE.append:
          this.logEvent('Appending file');
          result = ANSWERS.retry;
          break;
        case BATCH_OVERWRITE.resume:
          this.logEvent('Resuming file transfer');
          result = ANSWERS.retry;
          break;
        default: break;
      }
    }

    return result;
  }

  /**
   * The file-system-level wrapper every backend implements around
   * ConfirmFileOverwrite (ported from TSFTPFileSystem::SFTPConfirmOverwrite,
   * which is the richest of them).
   *
   * Resolves to `{ mode, targetFileName }`, or throws: `SkipFileError` when
   * the user said no, `AbortError` when they cancelled.
   *
   * `canAppend` is what a protocol can actually do. WebDAV and S3 replace a
   * whole resource on every write, so they pass false and the Append button
   * never appears — offering it there would produce a file that looks
   * appended and is not.
   */
  async confirmOverwrite(sourceFullFileName, targetFileName, copyParam, params, progress, fileParams, options = {}) {
    const canAppend = options.canAppend !== false;
    const side = options.side === undefined ? reverseSide(progress.side) : options.side;

    const answers = [ANSWERS.yes, ANSWERS.no, ANSWERS.cancel,
      ANSWERS.yesToAll, ANSWERS.noToAll, ANSWERS.all, 'ignore'];
    if (canAppend) answers.push(ANSWERS.retry);

    let answer = await this.confirmFileOverwrite(
      sourceFullFileName, targetFileName, fileParams, answers, side,
      copyParam, params, progress, options.message);

    let mode = OVERWRITE_MODE.overwrite;
    let name = targetFileName;

    if (canAppend && (answer === ANSWERS.retry || answer === ANSWERS.skip)) {
      const canAlternateResume = !!fileParams &&
        fileParams.destSize < fileParams.sourceSize && !progress.asciiTransfer;
      const batch = this.effectiveBatchOverwrite(sourceFullFileName, copyParam, params, progress, true);
      if (batch === BATCH_OVERWRITE.append) {
        mode = OVERWRITE_MODE.append;
      } else if (canAlternateResume &&
          (batch === BATCH_OVERWRITE.resume || batch === BATCH_OVERWRITE.alternateResume)) {
        mode = OVERWRITE_MODE.resume;
      } else if (!canAlternateResume) {
        // There is nothing to resume — the target is not shorter than the
        // source — so append is the only thing "retry" can mean.
        mode = OVERWRITE_MODE.append;
      } else if (typeof options.resolveAppendOrResume === 'function') {
        // A caller whose dialog already offered Append and Resume as separate
        // buttons answers here instead of being asked a second time. WinSCP's
        // own dialog has one "Append" button and asks the follow-up; the queue
        // surface has both, and asking again would be a question with a
        // foregone answer.
        const chosen = await options.resolveAppendOrResume();
        mode = chosen === OVERWRITE_MODE.resume ? OVERWRITE_MODE.resume : OVERWRITE_MODE.append;
      } else {
        progress.suspend();
        let second;
        try {
          second = await this.terminal.queryUser({
            message: `The target for "${sourceFullFileName}" already exists and is shorter than the source. ` +
              'Append the source to it, or resume the interrupted transfer?',
            answers: [ANSWERS.yes, ANSWERS.no, ANSWERS.noToAll, ANSWERS.cancel],
            type: 'confirmation',
            aliases: { yes: 'Append', no: 'Resume', noToAll: 'Resume all' },
            helpKeyword: 'append_or_resume',
          });
        } finally {
          progress.resume();
        }
        switch (second) {
          case ANSWERS.yes: mode = OVERWRITE_MODE.append; break;
          case ANSWERS.no: mode = OVERWRITE_MODE.resume; break;
          case ANSWERS.noToAll:
            mode = OVERWRITE_MODE.resume;
            progress.setBatchOverwrite(BATCH_OVERWRITE.alternateResume);
            break;
          default:
            progress.setCancelAtLeast(CANCEL.cancel);
            throw new AbortError();
        }
      }
    } else if (answer === 'ignore') {
      const newName = await this.promptForName(name);
      if (!newName) {
        progress.setCancelAtLeast(CANCEL.cancel);
        throw new AbortError();
      }
      name = newName;
      mode = OVERWRITE_MODE.overwrite;
    } else {
      mode = OVERWRITE_MODE.overwrite;
      if (answer === ANSWERS.cancel) {
        progress.setCancelAtLeast(CANCEL.cancel);
        throw new AbortError();
      }
      if (answer === ANSWERS.no) throw new SkipFileError(`The file "${name}" was not overwritten.`);
    }

    return { mode, targetFileName: name, answer };
  }

  /** The rename prompt behind the "Rename" button. */
  async promptForName(currentName) {
    const t = this.terminal;
    if (t.session && typeof t.session.ask === 'function') {
      const reply = await t.session.ask('custom', {
        kind: 'prompt', promptKind: 'fileName',
        title: 'Rename', prompt: 'New name:', value: currentName,
      });
      if (!reply) return '';
      const value = typeof reply === 'string' ? reply : (reply.value || (reply.values || [])[0] || '');
      return value || '';
    }
    return '';
  }

  /**
   * TSFTPFileSystem::SFTPConfirmResume — the question asked when a `.filepart`
   * from an earlier attempt is found.
   *
   * The partial-bigger-than-source branch is the important one: a leftover
   * part LONGER than the file we are now sending is not a resumable transfer
   * of this file, it is somebody else's file. WinSCP warns and starts over
   * rather than splicing.
   */
  async confirmResumeTransfer(destFileName, partialBiggerThanSource, progress) {
    if (partialBiggerThanSource) {
      progress.suspend();
      let answer;
      try {
        answer = await this.terminal.queryUser({
          message: `The partially transferred file "${destFileName}" is larger than the file being ` +
            'transferred. It is probably left over from a different transfer and cannot be resumed; ' +
            'it will be deleted and the transfer restarted.',
          answers: [ANSWERS.ok, ANSWERS.abort],
          type: 'warning',
          helpKeyword: 'partial_bigger_than_source',
        });
      } finally {
        progress.resume();
      }
      if (answer === ANSWERS.abort) {
        progress.setCancelAtLeast(CANCEL.cancel);
        throw new AbortError();
      }
      return false;
    }

    if (!this.confirmResume) return true;

    progress.suspend();
    let answer;
    try {
      answer = await this.terminal.queryUser({
        message: `A partially transferred file "${destFileName}" was found. Resume the transfer?`,
        answers: [ANSWERS.yes, ANSWERS.no, ANSWERS.cancel],
        type: 'confirmation',
        neverAskAgain: true,
        helpKeyword: 'resume_transfer',
      });
    } finally {
      progress.resume();
    }
    switch (answer) {
      case ANSWERS.neverAskAgain:
        this.setConfirmResume(false);
        return true;
      case ANSWERS.yes: return true;
      case ANSWERS.no: return false;
      default:
        progress.setCancelAtLeast(CANCEL.cancel);
        throw new AbortError();
    }
  }

  // ------------------------------------------------------- transfer mode

  /** TTerminal::UseAsciiTransfer. */
  useAsciiTransfer(baseFileName, side, copyParam, maskParams) {
    if (!this.terminal.isCapable('textMode')) return false;
    const cp = copyParam || {};
    if ((cp.partSize === undefined ? -1 : cp.partSize) >= 0) return false;
    return useAsciiTransfer(cp, baseFileName, side, maskParams);
  }

  /** TTerminal::SelectTransferMode. */
  selectTransferMode(baseFileName, side, copyParam, maskParams, progress) {
    const ascii = this.useAsciiTransfer(baseFileName, side, copyParam, maskParams);
    setAsciiTransfer(progress, ascii);
    this.logEvent(`${ascii ? 'Ascii' : 'Binary'} transfer mode selected.`);
    return ascii;
  }

  /** TTerminal::GetBaseFileName. */
  baseFileName(fileName) {
    return this.terminal.sessionData.trimVMSVersions ? trimVmsVersion(fileName) : fileName;
  }

  /** TTerminal::ChangeFileName. */
  changeFileName(copyParam, fileName, side, firstLevel) {
    return changeFileName(copyParam, this.baseFileName(fileName), side, firstLevel);
  }

  // --------------------------------------------------------- file handles

  /**
   * TTerminal::OpenLocalFile, in adapter terms. It is a stat, not an open:
   * nothing here needs a handle, and holding one open across a query would
   * lock the file for the length of a modal dialog.
   */
  async openFile(side, fileName) {
    const a = this.adapterFor(side);
    const st = await this.terminal.fileOperationLoop(
      () => a.stat(a.normalize(fileName)),
      { message: `File "${fileName}" does not exist.` });
    return {
      fileName,
      size: st.type === 'dir' ? 0 : Number(st.size) || 0,
      modification: Number(st.mtime) || 0,
      modificationFmt: st.modificationFmt === undefined ? MODIFICATION_FMT.FULL : st.modificationFmt,
      lastAccess: Number(st.atime === undefined ? st.mtime : st.atime) || 0,
      directory: st.type === 'dir',
      readOnly: !!st.readOnly,
      hidden: !!st.hidden,
      archive: st.archive !== false,   // Windows sets the archive bit on write
      rights: st.rights || '',
      stat: st,
    };
  }

  /**
   * TTerminal::AllowLocalFileTransfer. The mask, the hidden-file rule, the
   * temporary `.filepart` rule, the empty-directory rule and the skip list, in
   * that order — and the skip list adds the file's size to the "skipped"
   * counter rather than pretending it was never there.
   */
  async allowLocalFileTransfer(fileName, handle, copyParam, progress) {
    const cp = copyParam || {};
    if (!allowAnyTransfer(cp)) {
      if (!await this.doAllowFileTransfer(fileName, handle, cp, SIDES.local, false)) {
        this.logEvent(`File "${fileName}" excluded from transfer`);
        return false;
      }
      if (skipTransfer(cp, fileName, handle.directory)) {
        progress.addSkipped(handle.size);
        return false;
      }
    }
    this.logFileDetails(fileName, handle.modification, handle.size);
    return true;
  }

  /**
   * DoAllowLocalFileTransfer / DoAllowRemoteFileTransfer, unified.
   *
   * Async purely because of the last clause. `cpNoEmptyDirectories` cannot be
   * answered from the entry in hand — it means "does anything transferable
   * live under here?", which is a listing — and the original puts it here
   * rather than at each call site so that *every* caller agrees: the copy, the
   * size calculation and the collection all ask one predicate. A size that
   * counts a directory the copy will then refuse is a progress total that
   * never arrives.
   */
  async doAllowFileTransfer(fileName, info, copyParam, side, disallowTemporaryTransferFiles) {
    const cp = copyParam || {};
    if (info.hidden && cp.excludeHiddenFiles) return false;
    if (disallowTemporaryTransferFiles &&
        getPartialFileExtLen(extractFileName(excludeTrailingSlash(fileName))) > 0) {
      return false;
    }
    if (cp.includeFileMask) {
      const mask = cp._includeMask instanceof FileMask
        ? cp._includeMask
        : new FileMask(cp.includeFileMask);
      if (!(cp._includeMask instanceof FileMask)) {
        Object.defineProperty(cp, '_includeMask', { value: mask, enumerable: false, configurable: true, writable: true });
      }
      if (!mask.matches(this.baseFileName(fileName), {
        isDir: !!info.directory,
        size: info.size,
        mtime: info.modification,
        path: excludeTrailingSlash(fileName),
        local: side === SIDES.local,
      })) return false;
    }
    // The cpNoEmptyDirectories clause, which the port used to advertise in
    // `allowAnyTransfer` and then never apply anywhere.
    if (info.directory && cp.excludeEmptyDirectories &&
        await this.isEmptyDirectory(side, fileName, cp, disallowTemporaryTransferFiles)) {
      return false;
    }
    return true;
  }

  /**
   * TTerminal::IsEmptyLocalDirectory / TTerminal::IsEmptyRemoteDirectory.
   *
   * "Empty" is not "the listing came back with nothing". A directory holding
   * only files the include mask rejects, only hidden files while
   * `excludeHiddenFiles` is on, only half-finished `.filepart` leftovers, or
   * only other empty directories is empty as far as THIS transfer is
   * concerned — so it recurses, and it re-asks the very predicate that is in
   * the middle of asking it.
   *
   * Three details are deliberate rather than incidental:
   *
   *   * The descent clears `excludeEmptyDirectories` — Terminal.cpp:6438 does
   *     the same and says why ("to avoid endless recursion"). A child
   *     directory's own emptiness is settled by the explicit recursive call
   *     below; letting the predicate re-enter here as well would re-walk the
   *     same subtree once per level.
   *   * The two sides disagree about `.filepart` leftovers, and the original
   *     is where the disagreement comes from: IsEmptyLocalDirectory asks the
   *     child predicate with `DisallowTemporaryTransferFiles` hard-coded true
   *     (Terminal.cpp:6199), while IsEmptyRemoteDirectory passes the caller's
   *     flag through (Terminal.cpp:6441). So a LOCAL folder holding nothing
   *     but `report.filepart` counts as empty and a remote one does not,
   *     unless the caller already asked for temporaries to be disallowed.
   *     That is copied rather than tidied up: quietly hardening one side would
   *     make this port skip a directory WinSCP uploads.
   *   * It stops at the first thing that counts — `csStopOnFirstFile` — so a
   *     directory whose first entry is a file costs one listing, not a walk.
   *
   * A listing that fails answers "not empty". Refusing to copy a directory
   * because we could not look inside it would drop it from the transfer in
   * silence, which is worse than creating one empty directory too many.
   *
   * The REMOTE descent is gated on `CanRecurseToDirectory` (Terminal.cpp:9018:
   * `!File->IsSymLink || FSessionData->FollowDirectorySymlinks`), because
   * that is where the remote walk this predicate is predicting stops too:
   * `CalculateFileSize` counts a symlinked directory it will not follow in
   * `Stats->Directories` and never opens it (Terminal.cpp:4727-4755), and
   * `sink` here refuses it outright. Counting the files under a symlink we
   * will not follow made a directory whose only content was such a link look
   * non-empty; the copy then created it and skipped the link, leaving on disk
   * exactly the empty directory `excludeEmptyDirectories` exists to prevent.
   * SFTP makes this the common case rather than an exotic one —
   * `protocols/sftp.js:1311` resolves an `S_IFLNK` to `type:'dir'` while
   * keeping `isSymlink`, so every session with `resolveSymlinks` on can hit it.
   *
   * The LOCAL descent deliberately has no such gate: `DirectorySource`
   * (Terminal.cpp:7852) and `directorySource` here both recurse into any
   * directory, symlink or not, so the predicate must too or it would report a
   * directory as empty and then watch the copy fill it. See
   * `MAX_EMPTY_DIRECTORY_DEPTH` for what stops that being unbounded.
   */
  async isEmptyDirectory(side, dirName, copyParam, disallowTemporaryTransferFiles, depth = 0) {
    const a = this.adapterFor(side);
    const dir = excludeTrailingSlash(dirName);
    const inner = { ...(copyParam || {}), excludeEmptyDirectories: false };
    const childDisallowsTemporary = side === SIDES.local ? true : !!disallowTemporaryTransferFiles;
    let listing;
    try {
      listing = await a.list(a.normalize(dir));
    } catch {
      return false;
    }
    for (const child of listing) {
      if (child.name === '.' || child.name === '..') continue;
      // The adapter's own join, so a Windows local path stays a Windows path.
      const childName = a.join(dir, child.name);
      const isDir = child.type === 'dir';
      const allowed = await this.doAllowFileTransfer(childName, {
        hidden: !!child.hidden,
        directory: isDir,
        size: child.size,
        modification: child.mtime,
      }, inner, side, childDisallowsTemporary);
      if (!allowed) continue;
      if (!isDir) return false;
      // CanRecurseToDirectory — remote only, see the note above.
      if (side === SIDES.remote && !this.terminal.canRecurseToDirectory(child)) continue;
      if (depth >= MAX_EMPTY_DIRECTORY_DEPTH) {
        this.logEvent(`Not descending past ${MAX_EMPTY_DIRECTORY_DEPTH} levels under ` +
          `"${childName}" to decide emptiness; treating it as not empty.`);
        return false;
      }
      if (!await this.isEmptyDirectory(side, childName, copyParam,
        disallowTemporaryTransferFiles, depth + 1)) {
        return false;
      }
    }
    return true;
  }

  logFileDetails(fileName, modification, size) {
    this.logEvent(`File: "${fileName}" [${modification ? new Date(modification).toISOString() : 'unknown'}] [${size}]`);
  }

  logFileDone(progress, fileName, action) {
    if (action) action.destinationPath(fileName);
    this.logEvent(`Transfer done: "${progress.fullFileName || progress.fileName}" => "${fileName}" ` +
      `[${progress.transferredSize}]`);
  }

  logTotalTransferDetails(targetDir, copyParam, progress, parallel, fileLists) {
    const targetSide = progress.side === SIDES.local ? 'remote' : 'local';
    let s = `Copying ${progress.count} files/directories to ${targetSide} directory "${targetDir}"`;
    if (parallel && fileLists) {
      let count = 0;
      for (const l of fileLists) count += l.files.count();
      s += ` - in parallel, with ${count} total files`;
    }
    if (progress.totalSizeSet) s += ` - total size: ${formatSize(progress.totalSize)}`;
    this.logEvent(s);
  }

  logTotalTransferDone(progress) {
    this.logEvent(`Copying finished: ${progress.filesFinishedSuccessfully}/${progress.count} succeeded, ` +
      `${progress.totalTransferred} bytes transferred, ${progress.totalSkipped} skipped`);
  }

  // ------------------------------------------------------- the robust loops

  /**
   * TTerminal::SourceRobust — the upload's reconnect loop.
   *
   * The point is that a dropped connection retries THIS FILE, not the whole
   * operation. Three details make that safe:
   *
   *   * The retry is refused outright when the session is still open. That is
   *     `RobustLoop.tryReopen`'s first check and it is the difference between
   *     "the network blinked" and "the server said permission denied" — the
   *     second would fail identically forever.
   *   * On a retry the operation's byte counter is rolled back, so the file is
   *     not counted twice.
   *   * `cpNoConfirmation` is forced on and `tfAutoResume` is set, so the
   *     second attempt neither re-asks a question the user already answered
   *     nor refuses to resume a file it created itself. `tfNewDirectory` is
   *     cleared for the same reason: after a reconnect the directory is no
   *     longer new, and a partial file may well be sitting in it.
   */
  async sourceRobust(fileName, handle, targetDir, copyParam, params, progress, flags) {
    const action = new TransferAction(this.actionsLog, 'upload');
    const loop = new RobustLoop(this.terminal, progress, {
      canRetry: true,
      // Terminal.cpp:7767 — `FLAGSET(Flags, tfUseFileTransferAny) ?
      // &FFileTransferAny : NULL`. Handing the loop the terminal is what turns
      // the reconnect BUDGET ON, with the terminal's progress flag as its
      // reset; `null` leaves the loop reconnecting without a ceiling.
      anyTransfer: (flags & TRANSFER_FLAGS.useFileTransferAny) ? this.terminal : null,
    });
    let p = Number(params) || 0;
    let f = Number(flags) || 0;
    try {
      do {
        const state = { childError: false };
        try {
          await this.source(fileName, handle, targetDir, copyParam, p, progress, f, action, state);
          action.commit();
        } catch (e) {
          if (!await loop.tryReopen(e)) {
            if (!state.childError) action.rollback(e);
            throw e;
          }
        }
        if (loop.shouldRetry()) {
          rollbackTransfer(progress);
          action.restart();
          p |= COPY_FLAGS.noConfirmation;
          f &= ~TRANSFER_FLAGS.newDirectory;
          f |= TRANSFER_FLAGS.autoResume;
        }
      } while (loop.retry());
    } finally {
      loop.dispose();
    }
  }

  /**
   * TTerminal::SinkRobust — the download's reconnect loop.
   *
   * It carries one extra piece of state the upload does not need: `sunk`. If
   * the connection dies while DELETING the source of a move, the download must
   * NOT be retried on the next round — the remote file may already be gone,
   * and re-downloading would overwrite the only copy that now exists, locally,
   * with nothing.
   */
  async sinkRobust(fileName, file, targetDir, copyParam, params, progress, flags) {
    const action = new TransferAction(this.actionsLog, 'download');
    const loop = new RobustLoop(this.terminal, progress, {
      canRetry: true,
      // Terminal.cpp:8348 — the download's half of the same choice.
      anyTransfer: (flags & TRANSFER_FLAGS.useFileTransferAny) ? this.terminal : null,
    });
    let p = Number(params) || 0;
    let f = Number(flags) || 0;
    let sunk = false;
    try {
      do {
        try {
          if (!sunk) {
            await this.sink(fileName, file, targetDir, copyParam, p, progress, f, action);
            sunk = true;
            action.commit();
          }
          if (p & COPY_FLAGS.delete) {
            // The directory should already be empty; a recursive delete here
            // would remove files that were skipped or newly created while we
            // were downloading.
            await this.terminal.deleteFile(fileName, file, DELETE_FLAGS.noRecursive);
          }
        } catch (e) {
          if (!await loop.tryReopen(e)) {
            if (!sunk) action.rollback(e);
            throw e;
          }
        }
        if (loop.shouldRetry()) {
          rollbackTransfer(progress);
          action.restart();
          if (!file || file.type !== 'dir') {
            p |= COPY_FLAGS.noConfirmation;
            f |= TRANSFER_FLAGS.autoResume;
          }
        }
      } while (loop.retry());
    } finally {
      loop.dispose();
    }
  }

  // ------------------------------------------------------------- upload

  /**
   * TTerminal::CreateTargetDirectory. Returns true when it actually created
   * one, which is what tells DirectorySource to set `tfNewDirectory` — and
   * that in turn is what lets the files inside skip their existence probe.
   *
   * Permissions are only applied when the protocol can change them on upload.
   * WinSCP explicitly excludes FTP here: most FTP servers refuse SITE CHMOD,
   * so trying produces an error for every directory of a recursive upload.
   */
  async createTargetDirectory(directoryPath, isDirectory, copyParam) {
    const doCreate = !await this.terminal.directoryExists(directoryPath);
    if (doCreate) {
      const properties = {};
      if (copyParam.preserveRights && this.terminal.isCapable('modeChangingUpload')) {
        properties.rights = remoteFileRights(copyParam, isDirectory);
      }
      properties.encrypt = !!copyParam.encryptNewFiles;
      await this.terminal.createDirectory(directoryPath, properties);
    }
    return doCreate;
  }

  /**
   * TTerminal::DirectorySource.
   *
   * `preCreateDir` splits the protocols in two. SFTP, WebDAV and S3 create the
   * directory first; FTP creates it *after* its contents, because FileZilla's
   * upload already implicitly creates it and creating it twice fails. If any
   * file was uploaded, `postCreateDir` is cleared and the second attempt is
   * skipped entirely.
   */
  async directorySource(directoryName, targetDir, destDirectoryName, handle, copyParam, params, progress, flags) {
    await this.transferOnDirectory(targetDir, copyParam, params);

    const destFullName = includeTrailingSlash(targetDir) + destDirectoryName;
    progress.setFile(directoryName);

    let postCreateDir = !(flags & TRANSFER_FLAGS.preCreateDir);
    let f = Number(flags) || 0;
    if (!postCreateDir) {
      if (await this.createTargetDirectory(destFullName, true, copyParam)) {
        f |= TRANSFER_FLAGS.newDirectory;
      }
    }

    const doRecurse = !(params & COPY_FLAGS.noRecurse);
    if (doRecurse) {
      const a = this.adapterFor(SIDES.local);
      const listing = await a.list(a.normalize(excludeTrailingSlash(directoryName)));
      for (const child of listing) {
        if (progress.cancel !== CANCEL.continue) break;
        if (child.name === '.' || child.name === '..') continue;
        const childName = includeTrailingSlash(directoryName) + child.name;
        try {
          // No trailing slash on the target: FTP cannot set permissions on a
          // path that has one, and CreateTargetDirectory must not see one.
          const childTarget = includeTrailingSlash(destFullName);
          await this.sourceRobust(childName, null, childTarget, copyParam, params, progress,
            f & ~(TRANSFER_FLAGS.firstLevel | TRANSFER_FLAGS.autoResume));
          postCreateDir = false;
        } catch (e) {
          if (classifyException(e) !== 'skip') throw e;
          if (!this.terminal.handleException(e)) throw e;
        }
      }
    }

    if (postCreateDir) {
      await this.createTargetDirectory(destFullName, true, copyParam);
    }

    if (doRecurse && progress.cancel === CANCEL.continue) {
      if (this.terminal.isCapable('preservingTimestampDirs') &&
          copyParam.preserveTime && copyParam.preserveTimeDirs) {
        await this.terminal.changeFileProperties(destFullName, null, {
          modification: handle.modification,
          lastAccess: handle.lastAccess,
        });
      }
      if (params & COPY_FLAGS.delete) {
        const a = this.adapterFor(SIDES.local);
        await a.remove(a.normalize(excludeTrailingSlash(directoryName)), { directory: true });
      } else if (copyParam.clearArchive && handle.archive) {
        // Windows-only: no adapter exposes the archive bit for a directory.
        this.logEvent(`Cannot clear the archive attribute of "${directoryName}": ` +
          'no file-system attribute API is available here.');
      }
    }
  }

  /** TTerminal::UpdateSource — what happens to the source once it is up. */
  async updateSource(handle, copyParam, params) {
    if (params & COPY_FLAGS.delete) {
      if (!handle.directory) {
        this.logEvent(`Deleting successfully uploaded source file "${handle.fileName}".`);
        const a = this.adapterFor(SIDES.local);
        await this.terminal.fileOperationLoop(
          () => a.remove(a.normalize(handle.fileName), { directory: false }),
          { message: `Error deleting file "${handle.fileName}".` });
      }
    } else if (copyParam.clearArchive && handle.archive && !handle.directory) {
      this.logEvent(`Cannot clear the archive attribute of "${handle.fileName}": ` +
        'no file-system attribute API is available here.');
    }
  }

  /**
   * TTerminal::Source — one entry of an upload.
   *
   * Note the order: the transfer is refused before any BYTE is read (the only
   * thing that happens first is the stat the refusal itself needs — WinSCP has
   * the same information from the enumeration's TSearchRec, which is why it can
   * check before calling OpenLocalFile), the directory branch cancels the
   * action record (a directory is not an upload), and `updateSource` runs after
   * everything, including after a directory, so a move deletes the emptied
   * directory too.
   */
  async source(fileName, searchRec, targetDir, copyParam, params, progress, flags, action, state) {
    const st = state || {};
    if (action) action.fileName(fileName);
    progress.setFile(fileName, fileName);

    const handle = searchRec || await this.openFile(SIDES.local, fileName);

    if (!await this.allowLocalFileTransfer(fileName, handle, copyParam, progress)) {
      throw new SkipFileError(`File "${fileName}" excluded from transfer`);
    }

    const destFileName = this.changeFileName(
      copyParam, extractFileNameLocal(excludeTrailingSlash(fileName)),
      SIDES.local, !!(flags & TRANSFER_FLAGS.firstLevel));

    if (handle.directory) {
      if (action) action.cancel();
      // Anything that fails below belongs to a CHILD's own action record, so
      // the robust loop must not roll this one back on top of it.
      st.childError = true;
      await this.directorySource(includeTrailingSlash(fileName), targetDir, destFileName,
        handle, copyParam, params, progress, flags);
    } else {
      this.logEvent(`Copying "${fileName}" to remote directory started.`);
      progress.localSize = handle.size;
      // Suppose the same amount of data to transfer as to read. Not true in
      // text mode, where the converted size is only known as it is produced.
      progress.transferSize = handle.size;

      if (this.terminal.isCapable('textMode')) {
        this.selectTransferMode(this.baseFileName(handle.fileName), SIDES.local, copyParam,
          { size: handle.size, modification: handle.modification, path: handle.fileName }, progress);
      }

      const result = await this.fileSystem.source({
        engine: this, handle, targetDir, destFileName, copyParam, params, progress, flags, action, state: st,
      });
      const finalName = (result && result.destFileName) || destFileName;
      this.logFileDone(progress, includeTrailingSlash(targetDir) + finalName, action);
      progress.succeeded();
    }

    await this.updateSource(handle, copyParam, params);
  }

  /** TTerminal::DoCopyToRemote — the per-entry loop of an upload. */
  async doCopyToRemote(filesToCopy, targetDir, copyParam, params, progress, flags) {
    await this.transferOnDirectory(targetDir, copyParam, params);

    const absoluteTargetDir = this.terminal.absolutePath(targetDir, false);
    const fullTargetDir = includeTrailingSlash(absoluteTargetDir);
    let index = 0;
    while (index < filesToCopy.length && progress.cancel === CANCEL.continue) {
      let success = false;
      const item = filesToCopy[index];
      const fileName = typeof item === 'string' ? item : item.fileName;
      const searchRec = typeof item === 'string' ? null : (item.handle || null);
      try {
        try {
          if (this.terminal.sessionData.cacheDirectories !== false) {
            this.terminal.directoryModified(absoluteTargetDir, false);
            const a = this.adapterFor(SIDES.local);
            let isDir = false;
            try { isDir = (await a.stat(a.normalize(fileName))).type === 'dir'; } catch { isDir = false; }
            if (isDir) {
              this.terminal.directoryModified(
                fullTargetDir + extractFileNameLocal(excludeTrailingSlash(fileName)), true);
            }
          }
          await this.sourceRobust(fileName, searchRec, fullTargetDir, copyParam, params, progress,
            flags | TRANSFER_FLAGS.firstLevel);
          success = true;
        } catch (e) {
          if (classifyException(e) !== 'skip') throw e;
          if (!this.terminal.handleException(e)) throw e;
        }
      } finally {
        progress.finish(fileName, success);
      }
      index++;
    }
  }

  /**
   * TTerminal::CopyToRemote — the entry point.
   *
   * The size is calculated up front when parallel transfers are possible or
   * the copy parameters ask for it, because a parallel transfer needs the flat
   * file list the calculation produces and the progress bar needs the total.
   * `ClearArchive` disables parallelism: it is a per-file attribute change
   * that has to happen on the connection that uploaded the file.
   */
  async copyToRemote(filesToCopy, targetDir, copyParam, params, parallelOperation) {
    const cp = { ...copyParam };
    const p = Number(params) || 0;
    const progress = this.terminal._newProgress();
    let result = false;

    const canParallel = this.canParallel(cp, p, parallelOperation) && !cp.clearArchive;
    let fileLists = canParallel ? [] : null;
    let size = 0;
    let calculatedSize = false;

    if (cp.size >= 0 && !canParallel) {
      size = cp.size;
      calculatedSize = true;
    } else {
      const calculated = await this.calculateLocalFilesSize(filesToCopy, cp,
        canParallel || cp.calculateSize !== false, fileLists);
      size = calculated.size;
      calculatedSize = calculated.result;
    }

    this._lastProgressLogged = Date.now();
    this.terminal.operationStart(progress,
      (p & COPY_FLAGS.delete) ? OPERATIONS.move : OPERATIONS.copy, SIDES.local,
      filesToCopy.length,
      { directory: targetDir, temp: !!(p & COPY_FLAGS.temporary), cpsLimit: cp.cpsLimit });

    try {
      if (calculatedSize) progress.addTotalSize(size);
      this.terminal.beginTransaction();
      try {
        const parallel = canParallel && calculatedSize;
        this.logTotalTransferDetails(targetDir, cp, progress, parallel, fileLists);
        if (parallel) {
          parallelOperation.init(fileLists, targetDir, cp, p, progress,
            (this.terminal.session && this.terminal.session.name) || '', -1,
            this.queuePrefs.transfersLimit);
          await this.copyParallel(parallelOperation, progress);
        } else {
          await this.doCopyToRemote(normalizeCopyList(filesToCopy), targetDir, cp, p, progress, this.transferFlags());
        }
        this.logTotalTransferDone(progress);
      } finally {
        if (this.terminal.active) await this.terminal.reactOnCommand('copyToRemote');
        await this.terminal.endTransaction();
      }
      if (progress.cancel === CANCEL.continue) result = true;
    } catch (e) {
      await this.terminal.commandError(e, 'Error transferring file(s) to the remote directory.');
    } finally {
      this.terminal.operationStop(progress);
    }
    return result;
  }

  // ----------------------------------------------------------- download

  /**
   * TTerminal::UpdateTargetAttrs. The only attribute that crosses is
   * read-only, and it is only ever ADDED — WinSCP never clears an attribute
   * the local file already had.
   */
  async updateTargetAttrs(destFullName, file, copyParam) {
    if (!localFileReadOnly(copyParam, file && file.rights)) return;
    const a = this.adapterFor(SIDES.local);
    if (!a.caps || !a.caps.rights) {
      this.logEvent(`Cannot mark "${destFullName}" read-only: the local file system exposes no attribute API here.`);
      return;
    }
    await this.terminal.fileOperationLoop(async () => {
      // WinSCP ORs the new attributes into the existing ones and never clears
      // one the file already had, so the write bits are removed from whatever
      // is there rather than a fixed mode being stamped over it.
      const current = await statOrNull(a, destFullName);
      const text = String((current && current.rights) || 'rw-r--r--').padEnd(9, '-');
      const chars = text.split('');
      for (const i of [1, 4, 7]) chars[i] = '-';
      await a.setRights(a.normalize(destFullName), chars.join(''));
    }, { message: `Can't set attributes of file "${destFullName}".` });
  }

  /**
   * TTerminal::UpdateTargetTime. A timestamp we do not have is logged and
   * skipped, and a failure to set one is logged and ignored — losing a
   * modification time must never fail a transfer that moved every byte.
   */
  async updateTargetTime(destFullName, modification, modificationFmt) {
    if (modificationFmt === MODIFICATION_FMT.NONE || !modification) {
      this.logEvent('Timestamp not known');
      return;
    }
    this.logEvent(`Preserving timestamp [${new Date(modification).toISOString()}]`);
    const a = this.adapterFor(SIDES.local);
    if (!a.caps || !a.caps.timestamp) {
      this.logEvent('Preserving timestamp failed, ignoring: the target file system cannot set one.');
      return;
    }
    try {
      await a.setTimes(a.normalize(destFullName), { mtime: modification, atime: modification });
    } catch (e) {
      this.logEvent(`Preserving timestamp failed, ignoring: ${e.message}`);
    }
  }

  /**
   * TTerminal::Sink — one entry of a download.
   *
   * The two refusals here are the ones that protect the local disk: a target
   * that exists and is NOT a directory when we are about to recurse into it,
   * and a target that IS a directory when we are about to write a file over
   * it. Both are reported rather than blundered into.
   */
  async sink(fileName, file, targetDir, copyParam, params, progress, flags, action) {
    if (action) action.fileName(fileName);
    if (!file) throw new TerminalError(`No file information for "${fileName}".`);

    if (!await this.doAllowFileTransfer(fileName, {
      hidden: file.hidden, directory: file.type === 'dir',
      size: file.size, modification: file.mtime,
    }, copyParam, SIDES.remote, false)) {
      this.logEvent(`File "${fileName}" excluded from transfer`);
      throw new SkipFileError(`File "${fileName}" excluded from transfer`);
    }

    if (skipTransfer(copyParam, fileName, file.type === 'dir')) {
      progress.addSkipped(file.size);
      throw new SkipFileError(`File "${fileName}" is on the skip list.`);
    }

    this.logFileDetails(fileName, file.mtime, file.size);
    progress.setFile(fileName);

    const onlyFileName = extractFileName(excludeTrailingSlash(fileName));
    const destFileName = this.changeFileName(copyParam, onlyFileName, SIDES.remote,
      !!(flags & TRANSFER_FLAGS.firstLevel));
    const local = this.adapterFor(SIDES.local);
    const destFullName = local.join(targetDir, destFileName);

    if (file.type === 'dir') {
      if (action) action.cancel();
      if (!this.terminal.canRecurseToDirectory(file)) {
        this.logEvent(`Skipping symlink to directory "${fileName}".`);
        return;
      }

      const existing = await statOrNull(local, destFullName);
      if (existing && existing.type !== 'dir') {
        throw new TerminalError(`"${destFullName}" is not a directory.`);
      }
      await this.terminal.fileOperationLoop(
        () => local.mkdir(local.normalize(destFullName), { recursive: true }),
        { message: `Error creating folder "${destFullName}".` });

      if (!(params & COPY_FLAGS.noRecurse)) {
        const sinkParams = { skipped: false };
        const childTarget = includeTrailingSlash(destFullName);
        const childFlags = flags & ~(TRANSFER_FLAGS.firstLevel | TRANSFER_FLAGS.autoResume);
        await this.terminal.processDirectory(fileName, async (childName, childFile) => {
          await this.sinkFile(childName, childFile, childTarget, copyParam, params, progress, childFlags, sinkParams);
        }, sinkParams);

        if (this.fileSystem.directorySunk) {
          await this.fileSystem.directorySunk(destFullName, file, copyParam);
        }

        // Do not delete the directory when some of its files were skipped, and
        // report it as skipped so no ANCESTOR is deleted either.
        if ((params & COPY_FLAGS.delete) && sinkParams.skipped) {
          throw new SkipFileError(`Directory "${fileName}" still has files in it.`);
        }
      }
      return;
    }

    this.logEvent(`Copying "${fileName}" to local directory started.`);

    const maskParams = { size: file.size, modification: file.mtime, path: fileName };
    this.selectTransferMode(this.baseFileName(fileName), SIDES.remote, copyParam, maskParams, progress);

    const partSize = copyParam.partSize === undefined ? -1 : copyParam.partSize;
    const partOffset = copyParam.partOffset === undefined ? -1 : copyParam.partOffset;
    const transferSize = partSize >= 0 ? partSize : (file.size - Math.max(0, partOffset));
    progress.localSize = transferSize;
    progress.transferSize = transferSize;

    const existing = await statOrNull(local, destFullName);
    if (existing && existing.type === 'dir') {
      throw new TerminalError(`"${destFullName}" is not a file.`);
    }

    const result = await this.fileSystem.sink({
      engine: this, fileName, file, targetDir, destFileName,
      existing, copyParam, params, progress, flags, action,
    });
    const finalName = (result && result.destFileName) || destFileName;
    this.logFileDone(progress, local.join(targetDir, finalName), action);
    progress.succeeded();
  }

  /**
   * TTerminal::SinkFile — the per-child callback of a recursive download. A
   * skipped child marks the parent, and a cancel raised while handling the
   * skip aborts rather than continuing through the rest of the directory.
   */
  async sinkFile(fileName, file, targetDir, copyParam, params, progress, flags, sinkParams) {
    try {
      await this.sinkRobust(fileName, file, targetDir, copyParam, params, progress, flags);
    } catch (e) {
      if (classifyException(e) !== 'skip') throw e;
      sinkParams.skipped = true;
      if (!this.terminal.handleException(e)) throw e;
      if (progress.cancel !== CANCEL.continue) throw new AbortError();
    }
  }

  /** TTerminal::DoCopyToLocal — the per-entry loop of a download. */
  async doCopyToLocal(filesToCopy, targetDir, copyParam, params, progress, flags) {
    const fullTargetDir = includeTrailingSlash(targetDir);
    let index = 0;
    while (index < filesToCopy.length && progress.cancel === CANCEL.continue) {
      let success = false;
      const item = filesToCopy[index];
      const fileName = typeof item === 'string' ? item : item.fileName;
      let file = typeof item === 'string' ? null : (item.file || null);
      try {
        try {
          const absolute = this.terminal.absolutePath(fileName, false);
          if (!file) file = await this.terminal.readFile(absolute);
          await this.sinkRobust(absolute, file, fullTargetDir, copyParam, params, progress,
            flags | TRANSFER_FLAGS.firstLevel);
          success = true;
        } catch (e) {
          if (classifyException(e) !== 'skip') throw e;
          if (!this.terminal.handleException(e)) throw e;
        }
      } finally {
        progress.finish(fileName, success);
      }
      index++;
    }
  }

  /**
   * TTerminal::CheckParallelFileTransfer — the pre-flight for splitting ONE
   * file across connections.
   *
   * It refuses on every count that would make the split wrong: more than one
   * file, a directory, a symlink (untested in the original and left alone
   * here), a file below the threshold, and text mode (where the byte offsets
   * on the two sides do not correspond). When the target already exists it
   * asks the overwrite question ONCE, here, and cancels the whole operation on
   * "no" — because the parts are transferred by connections that must not each
   * ask again.
   */
  async checkParallelFileTransfer(targetDir, fileLists, copyParam, params, progress) {
    const out = { fileName: '', size: -1 };
    const threshold = Number(this.queuePrefs.parallelTransferThreshold) || 0;
    if (threshold <= 0) return out;
    if (!(this.remote && this.remote.caps && this.remote.caps.resume)) return out;

    const only = ParallelOperation.getOnlyFile(fileLists);
    if (!only) return out;
    const file = only.object;
    if (!file || file.isSymlink) return out;
    if (Number(file.size) < threshold) return out;

    const maskParams = { size: file.size, modification: file.mtime, path: only.fileName };
    if (this.useAsciiTransfer(this.baseFileName(only.fileName), SIDES.remote, copyParam, maskParams)) {
      return out;
    }

    out.fileName = only.fileName;
    out.size = Number(file.size);

    const targetFileName = this.changeFileName(copyParam,
      extractFileName(excludeTrailingSlash(only.fileName)), SIDES.remote, true);
    const local = this.adapterFor(SIDES.local);
    const destFullName = local.join(targetDir, targetFileName);
    const existing = await statOrNull(local, destFullName);
    if (!existing) return out;

    progress.suspend();
    try {
      const fileParams = new OverwriteFileParams({
        sourceSize: out.size,
        sourceTimestamp: file.mtime,
        sourcePrecision: file.modificationFmt,
        destSize: existing.size,
        destTimestamp: existing.mtime,
      });
      const answer = await this.confirmFileOverwrite(only.fileName, targetFileName, fileParams,
        [ANSWERS.yes, ANSWERS.no, ANSWERS.cancel], SIDES.remote, copyParam, params, progress);
      if (answer === ANSWERS.cancel || answer === ANSWERS.no) {
        progress.setCancelAtLeast(CANCEL.cancel);
      }
    } finally {
      progress.resume();
    }
    return out;
  }

  /** TTerminal::CopyToLocal. */
  async copyToLocal(filesToCopy, targetDir, copyParam, params, parallelOperation) {
    const cp = { ...copyParam };
    const p = Number(params) || 0;
    const progress = this.terminal._newProgress();
    let result = false;
    let effectiveParams = p;

    this.destFileName = '';
    this.multipleDestinationFiles = false;

    this.terminal.beginTransaction();
    try {
      const canParallel = this.canParallel(cp, p, parallelOperation);
      const fileLists = canParallel ? [] : null;
      let totalSize = 0;
      let totalSizeKnown = false;

      if (cp.size >= 0 && !canParallel) {
        totalSize = cp.size;
        totalSizeKnown = true;
      } else {
        const calculated = await this.terminal.withExceptionOnFail(() =>
          this.terminal.calculateFilesSize(filesToCopy, {
            params: CALC_FLAGS.ignoreErrors,
            copyParam: cp,
            allowDirs: canParallel || cp.calculateSize !== false,
            collectFiles: !!fileLists,
          })).catch((e) => {
          if (!this.terminal.active) throw e;
          return { size: 0, result: false, files: null };
        });
        totalSize = calculated.size;
        totalSizeKnown = calculated.result;
        if (fileLists && calculated.files) {
          // The root is what "first level" is measured against, and it is the
          // directory the user picked the files OUT of — not the current
          // directory, which a background transfer may have moved on from
          // since. Getting it wrong makes every entry look nested and the
          // parallel cursor look for a parent directory that was never
          // recorded.
          const first = normalizeCopyList(filesToCopy)[0];
          const rootPath = first
            ? excludeTrailingSlash(extractFilePath(
              this.terminal.absolutePath(excludeTrailingSlash(first.fileName), false)))
            : this.terminal.peekCurrentDirectory();
          fileLists.push({
            rootPath: rootPath || this.terminal.peekCurrentDirectory(),
            files: CollectedFileList.fromCollected(calculated.files),
          });
        }
      }

      this._lastProgressLogged = Date.now();
      this.terminal.operationStart(progress,
        (p & COPY_FLAGS.delete) ? OPERATIONS.move : OPERATIONS.copy, SIDES.remote,
        filesToCopy.length,
        { directory: targetDir, temp: !!(p & COPY_FLAGS.temporary), cpsLimit: cp.cpsLimit });

      try {
        if (totalSizeKnown) progress.addTotalSize(totalSize);
        try {
          const parallel = canParallel && totalSizeKnown;
          this.logTotalTransferDetails(targetDir, cp, progress, parallel, fileLists);
          if (parallel) {
            const check = await this.checkParallelFileTransfer(targetDir, fileLists, cp, effectiveParams, progress);
            if (progress.cancel === CANCEL.continue) {
              if (check.size >= 0) {
                // The one overwrite question has been asked already; the
                // connections carrying the parts must not ask it again.
                effectiveParams |= COPY_FLAGS.noConfirmation;
              }
              parallelOperation.init(fileLists, targetDir, cp, effectiveParams, progress,
                (this.terminal.session && this.terminal.session.name) || '', check.size,
                this.queuePrefs.transfersLimit);
              await this.copyParallel(parallelOperation, progress);
            }
          } else {
            await this.doCopyToLocal(normalizeCopyList(filesToCopy), targetDir, cp, effectiveParams,
              progress, this.downloadFlags());
          }
          this.logTotalTransferDone(progress);
        } finally {
          if (this.terminal.active) await this.terminal.reactOnCommand('copyToLocal');
        }
        if (progress.cancel === CANCEL.continue) result = true;
      } catch (e) {
        await this.terminal.commandError(e, 'Error transferring file(s) to the local directory.');
      } finally {
        this.terminal.operationStop(progress);
      }
    } finally {
      // Ending the transaction rereads the directory when the session survived.
      await this.terminal.endTransaction();
    }
    return result;
  }

  // ----------------------------------------------------------- parallel

  /**
   * TTerminal::CanParallel. Two refusals, and both are about ordering: a MOVE
   * has to delete the source after every file of a directory is done, and
   * preserving directory timestamps has to stamp the directory after its
   * contents — neither survives being spread over connections that finish in
   * an arbitrary order.
   */
  canParallel(copyParam, params, parallelOperation) {
    return !!parallelOperation && this.parallelAllowed(copyParam, params);
  }

  /**
   * The same refusals WITHOUT the cursor guard — the question a caller can ask
   * BEFORE it has a TParallelOperation in hand.
   *
   * CanParallel's first term is `ParallelOperation != NULL`, and in WinSCP that
   * is never a real predicate: it is only ever called from inside CopyToRemote
   * and CopyToLocal (Terminal.cpp:7606, :8162), where the cursor is whatever
   * the caller passed. Every foreground caller passes NULL and only the queue
   * ever constructs one (Queue.cpp:2182). So a standalone "may this session go
   * parallel?" query that forwarded NULL would answer `false` every time and
   * describe nothing about the session it was asked about — a constant dressed
   * up as a decision. This answers the part a caller can actually act on: the
   * protocol's fcParallelTransfers capability, and the two orderings a split
   * would break (a MOVE deletes the source directory only after every file
   * under it is done, and preserving directory timestamps stamps a directory
   * only after its contents).
   */
  parallelAllowed(copyParam, params) {
    return this.parallelTransfersCapable() &&
      !(params & COPY_FLAGS.delete) &&
      !(copyParam.preserveTime && copyParam.preserveTimeDirs);
  }

  /**
   * TTerminal::CopyToParallel — take the next entry off the shared cursor and
   * transfer it on THIS connection.
   *
   * Returns the same tri-state `getNext` does. The `done()` call in the
   * finally is what unblocks the children of a directory, and it must run
   * however the transfer ended — a directory that failed and never reported
   * would deadlock every connection waiting on it.
   */
  async copyToParallel(parallelOperation, progress) {
    const out = {};
    const got = parallelOperation.getNext(out, (name, side, firstLevel) =>
      this.changeFileName(parallelOperation.copyParam, name, side, firstLevel));
    if (got <= 0) return got;

    const copyParam = out.customCopyParam || parallelOperation.copyParam;
    let params = parallelOperation.params;
    // The enumeration ALREADY listed this directory's contents, and every one
    // of them is its own entry in the list — so transfer the directory alone.
    // When the enumeration could NOT descend, the flag is left off so the
    // transfer recurses now, typically only to surface the same error.
    if (out.dir && out.recursed) params |= COPY_FLAGS.noRecurse;

    const before = progress.filesFinishedSuccessfully;
    let success = false;
    // `setFile` clears the per-file counters, so after ONE entry this is what
    // this part actually moved — which is what `done()` checks the part size
    // against before it merges anything.
    let transferred;
    try {
      const entry = { fileName: out.fileName, file: out.object, handle: null };
      if (parallelOperation.side === SIDES.local) {
        await this.doCopyToRemote([entry], out.targetDir, copyParam, params, progress, this.transferFlags());
      } else {
        await this.doCopyToLocal([entry], out.targetDir, copyParam, params, progress, this.downloadFlags());
      }
      success = progress.filesFinishedSuccessfully > before;
      transferred = progress.transferredSize;
    } finally {
      await parallelOperation.done(out.fileName, out.dir, success, out.targetDir, copyParam,
        this.mergeOps(), transferred);
    }
    return got;
  }

  /**
   * The three local-file operations merging the parts of a split download
   * needs. Kept as an object so a test can watch them, and so the merge itself
   * stays free of adapter details.
   */
  mergeOps() {
    const a = this.adapterFor(SIDES.local);
    return {
      renameForce: async (from, to) => {
        try { await a.remove(a.normalize(to), { directory: false }); } catch { /* not there */ }
        await a.rename(a.normalize(from), a.normalize(to));
      },
      append: async (from, to) => {
        const stat = await a.stat(a.normalize(to));
        const rs = await a.createReadStream(a.normalize(from));
        const ws = await a.createWriteStream(a.normalize(to), {
          start: stat.size, append: true, flags: 'r+',
        });
        await new Promise((resolve, reject) => {
          rs.on('error', reject);
          ws.on('error', reject);
          ws.on('close', resolve);
          ws.on('finish', resolve);
          rs.pipe(ws);
        });
      },
      remove: (p) => a.remove(a.normalize(p), { directory: false }),
    };
  }

  /**
   * TTerminal::CopyParallel — this connection's loop. A `0` from `getNext`
   * means "a parent directory is still being created": sleep briefly and ask
   * again rather than spinning.
   */
  async copyParallel(parallelOperation, progress) {
    parallelOperation.addClient();
    try {
      let cont = true;
      do {
        const got = await this.copyToParallel(parallelOperation, progress);
        if (got < 0) cont = false;
        else if (got === 0) await this.sleep(100);
      } while (cont && progress.cancel === CANCEL.continue);
    } finally {
      parallelOperation.removeClient();
      progress.done = true;
      await parallelOperation.waitFor(this.sleep);
    }
  }

  // -------------------------------------------------------------- helpers

  /**
   * The flags each protocol's CopyToRemote passes down.
   *
   * WinSCP's SFTP, WebDAV and S3 back ends set `tfPreCreateDir` and its FTP
   * back end does not, because FileZilla's own upload creates the target
   * directory as a side effect of writing the first file into it — so creating
   * it beforehand would fail. `basic-ftp` does no such thing, and neither does
   * any other adapter here, so the pre-create branch is the right one for all
   * of them. An adapter that genuinely creates directories implicitly can say
   * so with `caps.postCreateDir` and get WinSCP's FTP branch instead.
   *
   * `tfUseFileTransferAny` rides along here because WinSCP adds it at the same
   * seam — TFTPFileSystem::CopyToRemote (FtpFileSystem.cpp:1682) is one call
   * that passes both this back end's flags down to DoCopyToRemote.
   */
  transferFlags() {
    const a = this.remote;
    let flags = (a && a.caps && a.caps.postCreateDir) ? 0 : TRANSFER_FLAGS.preCreateDir;
    if (this.limitedTransferReconnects()) flags |= TRANSFER_FLAGS.useFileTransferAny;
    return flags;
  }

  /**
   * The same for a download. There is no directory-ordering question going this
   * way, so `tfUseFileTransferAny` is the only flag in play, and WinSCP's
   * TFTPFileSystem::CopyToLocal (FtpFileSystem.cpp:1584-1585) passes exactly
   * that one while every other back end's CopyToLocal passes nothing.
   */
  downloadFlags() {
    return this.limitedTransferReconnects() ? TRANSFER_FLAGS.useFileTransferAny : 0;
  }

  /** TFileSystemIntf::TransferOnDirectory — S3 creates the bucket here. */
  async transferOnDirectory(targetDir, copyParam, params) {
    if (this.fileSystem && typeof this.fileSystem.transferOnDirectory === 'function') {
      await this.fileSystem.transferOnDirectory(targetDir, copyParam, params);
    }
  }

  /**
   * TTerminal::CalculateLocalFilesSize. Unlike the remote one this never
   * raises a dialog: a file that cannot be sized is dropped from the total,
   * `result` goes false, and the progress bar becomes indeterminate — which is
   * exactly what the original does.
   */
  async calculateLocalFilesSize(fileList, copyParam, allowDirs, fileLists) {
    const a = this.adapterFor(SIDES.local);
    const items = normalizeCopyList(fileList);
    let size = 0;
    let ok = true;
    const collected = fileLists ? new CollectedFileList() : null;

    const walk = async (fileName, info, list) => {
      if (copyParam && !await this.doAllowFileTransfer(fileName, info, copyParam, SIDES.local, false)) return;
      let index = -1;
      if (list) index = list.add(fileName, null, !!info.directory);
      if (!info.directory) {
        size += Number(info.size) || 0;
        return;
      }
      if (!allowDirs) { ok = false; return; }
      try {
        const listing = await a.list(a.normalize(excludeTrailingSlash(fileName)));
        for (const child of listing) {
          if (child.name === '.' || child.name === '..') continue;
          await walk(includeTrailingSlash(fileName) + child.name, {
            size: child.size, modification: child.mtime,
            directory: child.type === 'dir', hidden: child.hidden,
          }, list);
        }
      } catch {
        if (index >= 0 && list) list.didNotRecurse(index);
        ok = false;
      }
    };

    for (const item of items) {
      try {
        const st = await a.stat(a.normalize(item.fileName));
        await walk(item.fileName, {
          size: st.size, modification: st.mtime,
          directory: st.type === 'dir', hidden: st.hidden,
        }, collected);
      } catch {
        ok = false;
      }
    }

    if (fileLists && collected) {
      fileLists.push({
        rootPath: items.length ? extractFileDirLocal(items[0].fileName) : '',
        files: collected,
      });
    }
    this.logEvent(`Size of ${items.length} local files/folders calculated as ${size}`);
    return { size, result: ok, files: collected };
  }
}

// ===========================================================================
// AdapterFileSystem — the default Source/Sink
// ===========================================================================

/**
 * What each protocol's `TFileSystem::Source` / `::Sink` does, minus the wire
 * protocol: work out whether this file may be resumed, find out what is on the
 * far side, ask the overwrite question, decide the mode and the write offsets,
 * hand the resulting plan to `engine.copyBytes`, and then preserve the
 * metadata.
 *
 * It opens no stream itself. `copyBytes` is the injected byte mover and is
 * REQUIRED — `queue.js` supplies its own, which is the whole reason this
 * module and the queue do not fork.
 *
 * The plan a byte mover is handed:
 *
 *   sourceAdapter, targetAdapter   the two Adapters
 *   sourcePath, targetPath         targetPath may be a `.filepart` name
 *   finalPath                      where targetPath will be renamed to
 *   size                           bytes expected to be read
 *   readFrom                       source offset to start at
 *   readTo                         inclusive source offset to stop at, or
 *                                  undefined for "to the end of the file"
 *   writeAt                        target offset to write at
 *   append                         true when writing into an existing file
 *   text                           ASCII mode: rewrite line endings
 *   overwriteMode                  overwrite | append | resume
 *   copyParam, params, progress    the operation's own objects
 *   onBytes(n)                     progress callback
 */
class AdapterFileSystem {
  constructor(engine) { this.engine = engine; }

  /**
   * A cancel can arrive after overwrite/resume decisions but before the byte
   * mover is entered. Honour that boundary here so a late click cannot start
   * another write after the operation has already been cancelled.
   */
  _throwIfCancelled(progress) {
    if (progress && progress.cancel !== CANCEL.continue) throw new AbortError();
  }

  _copyBytes(plan) {
    const fn = this.engine.copyBytes;
    if (typeof fn !== 'function') {
      throw new TerminalError(
        'This transfer engine has no byte mover. Construct it with { copyBytes } ' +
        '— design/main/queue.js supplies one.');
    }
    return fn(plan);
  }

  /** TSFTPFileSystem::Source, generalized over the Adapter contract. */
  async source(ctx) {
    const { engine, handle, targetDir, copyParam, params, progress, flags, action } = ctx;
    const dst = engine.adapterFor(SIDES.remote);
    const src = engine.adapterFor(SIDES.local);
    let destFileName = ctx.destFileName;
    let destFullName = dst.join(targetDir, destFileName);

    const partialExt = copyParam.partialFileExt === undefined ? PARTIAL_EXT : copyParam.partialFileExt;
    let resumeAllowed =
      !progress.asciiTransfer &&
      allowResume(copyParam, progress.localSize, destFileName) &&
      engine.terminal.isCapable('rename') &&
      !!(dst.caps && dst.caps.resume) &&
      !engine.terminal.sessionData.encryptFiles;

    let overwriteMode = OVERWRITE_MODE.overwrite;
    let resuming = false;
    let destFileExists = false;
    let destPartialFullName = '';
    let existing = null;
    let resumeOffset = 0;

    const fileParams = new OverwriteFileParams({
      sourceSize: progress.localSize,
      sourceTimestamp: handle.modification,
      sourcePrecision: handle.modificationFmt,
    });

    if (resumeAllowed) {
      destPartialFullName = destFullName + partialExt;

      // A directory WE created a moment ago cannot contain either the target
      // or a leftover part, so both probes are skipped.
      if (!(flags & TRANSFER_FLAGS.newDirectory)) {
        engine.logEvent('Checking existence of file.');
        existing = await statOrNull(dst, destFullName);
        destFileExists = !!existing;
        if (destFileExists) {
          fileParams.destSize = Number(existing.size) || 0;
          fileParams.destTimestamp = Number(existing.mtime) || 0;
          if (existing.modificationFmt !== undefined) fileParams.destPrecision = existing.modificationFmt;
          // SftpFileSystem.cpp:4674-4700. The chain lives in
          // `resumeRefusalReason` because the queue's own delete-and-rename has
          // to reach the identical verdict; see the comment on that function.
          const refusal = resumeRefusalReason(existing, engine.terminal.userName);
          if (refusal) {
            resumeAllowed = false;
            engine.logEvent(refusal);
          }
        }

        if (resumeAllowed) {
          engine.logEvent('Checking existence of partially transferred file.');
          const part = await statOrNull(dst, destPartialFullName);
          if (part) {
            resumeOffset = Number(part.size) || 0;
            const partialBigger = resumeOffset > progress.localSize;
            if (!(params & COPY_FLAGS.noConfirmation) &&
                !(params & COPY_FLAGS.resume) &&
                !resumeTransfer(copyParam, handle.fileName)) {
              resuming = await engine.confirmResumeTransfer(destFileName, partialBigger, progress);
            } else {
              resuming = !partialBigger;
            }
            if (!resuming) {
              await dst.remove(dst.normalize(destPartialFullName), { directory: false });
              resumeOffset = 0;
            } else {
              engine.logEvent('Resuming file transfer.');
            }
          } else if (destFileExists) {
            const confirmed = await engine.confirmOverwrite(
              handle.fileName, destFileName, copyParam, params, progress, fileParams,
              { canAppend: canAppendTo(engine, dst, progress) });
            overwriteMode = confirmed.mode;
            if (confirmed.targetFileName !== destFileName) {
              destFileName = confirmed.targetFileName;
              destFullName = dst.join(targetDir, destFileName);
              destPartialFullName = destFullName + partialExt;
              existing = await statOrNull(dst, destFullName);
              destFileExists = !!existing;
            }
          }
        }
      }
    } else {
      // Not resumable, but we still have to find out whether anything is there
      // — and "whether we have to" is two questions, not one. WinSCP asks for
      // the target with SSH_FXF_EXCL when EITHER the overwrite is going to be
      // confirmed OR the site preserves overwritten files
      // (SftpFileSystem.cpp:5132-5136), and the comment above that line says
      // exactly why: "when we want to preserve overwritten files, we need to
      // find out that they exist first... even if overwrite confirmation is
      // disabled." Probing only when a question is coming would make the
      // recycle bin do nothing at all for the many users who turned
      // confirmations off — the queue ships with them off by default.
      const confirming = engine.checkRemoteFile(handle.fileName, copyParam, params, progress);
      const sd = engine.terminal.sessionData || {};
      const preserving = !!(sd.overwrittenToRecycleBin && sd.recycleBinPath);
      if (confirming || preserving) {
        existing = await statOrNull(dst, destFullName);
        destFileExists = !!existing;
      }
      if (destFileExists && confirming) {
        fileParams.destSize = Number(existing.size) || 0;
        fileParams.destTimestamp = Number(existing.mtime) || 0;
        if (existing.modificationFmt !== undefined) fileParams.destPrecision = existing.modificationFmt;
        const confirmed = await engine.confirmOverwrite(
          handle.fileName, destFileName, copyParam, params, progress, fileParams,
          { canAppend: canAppendTo(engine, dst, progress) });
        overwriteMode = confirmed.mode;
        if (confirmed.targetFileName !== destFileName) {
          destFileName = confirmed.targetFileName;
          destFullName = dst.join(targetDir, destFileName);
          existing = await statOrNull(dst, destFullName);
          destFileExists = !!existing;
        }
      }
    }

    const doResume = resumeAllowed && overwriteMode === OVERWRITE_MODE.overwrite;
    const writePath = doResume ? destPartialFullName : destFullName;
    if (action) action.destinationPath(destFullName).setSize(progress.localSize);

    // SFTPOpenRemote's recycle (SftpFileSystem.cpp:5226-5270), for the write
    // that goes straight at the real name. The resumable path writes to a
    // `.filepart` and does not touch the target until the rename below, so it
    // recycles there instead; here the very next thing to happen is a
    // truncating open, and after that the file the user asked to preserve is
    // unrecoverable. Only an omOverwrite qualifies (5133): append and resume
    // extend the existing file rather than replacing it, so there is nothing
    // being overwritten to preserve.
    let recycledRights;
    if (!doResume && destFileExists && overwriteMode === OVERWRITE_MODE.overwrite) {
      const r = await recycleOverwritten(dst, destFullName, existing,
        engine.terminal.sessionData, (t) => engine.logEvent(t));
      if (r.recycled) {
        recycledRights = r.rights;
        destFileExists = false;
        existing = null;
      }
    }

    let readFrom = 0;
    let writeAt = 0;
    let append = false;
    if (doResume && resuming) {
      readFrom = resumeOffset;
      writeAt = resumeOffset;
      append = true;
    } else if (overwriteMode === OVERWRITE_MODE.append) {
      readFrom = 0;
      writeAt = Number((existing && existing.size) || 0);
      append = true;
    } else if (overwriteMode === OVERWRITE_MODE.resume) {
      readFrom = Number((existing && existing.size) || 0);
      writeAt = readFrom;
      append = true;
      addResumed(progress, readFrom);
      if (readFrom >= progress.localSize) {
        // Already complete. Nothing to move, and definitely nothing to truncate.
        return { destFileName };
      }
    }

    this._throwIfCancelled(progress);
    await this._copyBytes({
      side: SIDES.local,
      sourceAdapter: src,
      targetAdapter: dst,
      sourcePath: handle.fileName,
      targetPath: writePath,
      finalPath: destFullName,
      size: progress.localSize,
      readFrom,
      writeAt,
      append,
      text: !!progress.asciiTransfer,
      overwriteMode,
      copyParam,
      params,
      progress,
      onBytes: (n) => progress.addTransferred(n),
    });

    if (doResume) {
      // Only now that every byte is there does the real name appear.
      if (destFileExists) {
        // SftpFileSystem.cpp:4939-4958 — the SECOND recycle site. The rename
        // below cannot land on top of an existing name, so something has to go
        // first, and the site's preference decides whether that is a move into
        // the bin or a delete. `tolerateFailure: false` because the fallback
        // here is destructive: if the recycle quietly failed we would carry on
        // and remove the file anyway, which is precisely the outcome the
        // setting exists to prevent. WinSCP raises DELETE_ON_RESUME_ERROR.
        const r = await recycleOverwritten(dst, destFullName, existing,
          engine.terminal.sessionData, (t) => engine.logEvent(t), { tolerateFailure: false });
        if (r.recycled) recycledRights = r.rights;
        else try { await dst.remove(dst.normalize(destFullName), { directory: false }); } catch { /* raced */ }
      }
      await dst.rename(dst.normalize(writePath), dst.normalize(destFullName));
    }

    if (copyParam.preserveRights && engine.terminal.isCapable('modeChangingUpload')) {
      await tolerate(copyParam, () =>
        dst.setRights(dst.normalize(destFullName), remoteFileRights(copyParam, false)));
    } else if (recycledRights && dst.caps && dst.caps.rights) {
      // PreserveExistingRights (SftpFileSystem.cpp:4804, 4818-4827). The name
      // survives the recycle, so its permissions should too — otherwise
      // switching the safety net on quietly re-modes every file it protects to
      // whatever the server's umask happens to produce.
      await tolerate(copyParam, () => dst.setRights(dst.normalize(destFullName), recycledRights));
    }
    if (copyParam.preserveTime && engine.terminal.isCapable('preservingTimestampUpload') && handle.modification) {
      await tolerate(copyParam, () =>
        dst.setTimes(dst.normalize(destFullName), { mtime: handle.modification, atime: handle.lastAccess || handle.modification }));
    }

    return { destFileName };
  }

  /** TSFTPFileSystem::Sink, generalized over the Adapter contract. */
  async sink(ctx) {
    const { engine, fileName, file, targetDir, copyParam, params, progress, flags, action } = ctx;
    const src = engine.adapterFor(SIDES.remote);
    const dst = engine.adapterFor(SIDES.local);
    let destFileName = ctx.destFileName;
    let destFullName = dst.join(targetDir, destFileName);
    let existing = ctx.existing;

    const partialExt = copyParam.partialFileExt === undefined ? PARTIAL_EXT : copyParam.partialFileExt;
    // TSFTPFileSystem::Sink's ResumeAllowed, with both of its refusals:
    //   * an ENCRYPTED download cannot be resumed, because the bytes already on
    //     disk are ciphertext whose stream position the far side no longer
    //     knows — splicing plaintext or a fresh cipher stream onto them
    //     produces a file that decrypts to rubbish and looks complete.
    //   * a PART of a split file already carries a deliberate offset. Treating
    //     it as a resume would write the part through the `.filepart` dance and
    //     rename it over the target while the other parts are still arriving.
    const sinkPartOffset = copyParam.partOffset === undefined ? -1 : copyParam.partOffset;
    let resumeAllowed =
      !progress.asciiTransfer &&
      allowResume(copyParam, progress.transferSize, destFileName) &&
      !!(src.caps && src.caps.resume) &&
      !engine.terminal.sessionData.encryptFiles &&
      sinkPartOffset < 0;

    let overwriteMode = OVERWRITE_MODE.overwrite;
    let resuming = false;
    let resumeOffset = 0;
    let destPartialFullName = destFullName + partialExt;

    const fileParams = new OverwriteFileParams({
      sourceSize: progress.transferSize,
      sourceTimestamp: file.mtime,
      sourcePrecision: file.modificationFmt,
      destSize: existing ? existing.size : 0,
      destTimestamp: existing ? existing.mtime : 0,
    });

    if (resumeAllowed) {
      const part = await statOrNull(dst, destPartialFullName);
      if (part) {
        resumeOffset = Number(part.size) || 0;
        const partialBigger = resumeOffset > progress.transferSize;
        if (!(params & COPY_FLAGS.noConfirmation) &&
            !(params & COPY_FLAGS.resume) &&
            !(flags & TRANSFER_FLAGS.autoResume) &&
            !resumeTransfer(copyParam, fileName)) {
          resuming = await engine.confirmResumeTransfer(destFileName, partialBigger, progress);
        } else {
          resuming = !partialBigger;
        }
        if (!resuming) {
          await dst.remove(dst.normalize(destPartialFullName), { directory: false });
          resumeOffset = 0;
        }
      }
    }

    if (existing && !resuming) {
      const confirmed = await engine.confirmOverwrite(
        fileName, destFileName, copyParam, params, progress, fileParams,
        { canAppend: canAppendTo(engine, dst, progress) });
      overwriteMode = confirmed.mode;
      if (confirmed.targetFileName !== destFileName) {
        destFileName = confirmed.targetFileName;
        destFullName = dst.join(targetDir, destFileName);
        destPartialFullName = destFullName + partialExt;
        if (resumeAllowed) {
          const stale = await statOrNull(dst, destPartialFullName);
          if (stale) await dst.remove(dst.normalize(destPartialFullName), { directory: false });
        }
        existing = await statOrNull(dst, destFullName);
      }
      // Appending or resuming writes into the real file, so the partial-file
      // dance is off for this transfer.
      if (overwriteMode !== OVERWRITE_MODE.overwrite) resumeAllowed = false;
    }

    const doResume = resumeAllowed && overwriteMode === OVERWRITE_MODE.overwrite;
    const writePath = doResume ? destPartialFullName : destFullName;
    if (action) action.destinationPath(destFullName).setSize(progress.transferSize);

    let readFrom = 0;
    let writeAt = 0;
    let append = false;
    if (doResume && resuming) {
      readFrom = resumeOffset;
      writeAt = resumeOffset;
      append = true;
    } else if (overwriteMode === OVERWRITE_MODE.append) {
      writeAt = Number((existing && existing.size) || 0);
      append = true;
    } else if (overwriteMode === OVERWRITE_MODE.resume) {
      readFrom = Number((existing && existing.size) || 0);
      writeAt = readFrom;
      append = true;
      addResumed(progress, readFrom);
      if (readFrom >= progress.transferSize) return { destFileName };
    }

    const partOffset = copyParam.partOffset === undefined ? -1 : copyParam.partOffset;
    if (partOffset >= 0) readFrom += partOffset;
    // One PART of a split file must stop where the next part begins. `readTo`
    // is inclusive, matching the Adapter contract's `createReadStream({ end })`;
    // a byte mover that ignores it would have every part read to EOF and the
    // merged file would be a multiple of its true length.
    const partSize = copyParam.partSize === undefined ? -1 : copyParam.partSize;
    const readTo = partSize >= 0 ? readFrom + partSize - 1 : undefined;

    this._throwIfCancelled(progress);
    await this._copyBytes({
      side: SIDES.remote,
      sourceAdapter: src,
      targetAdapter: dst,
      sourcePath: fileName,
      targetPath: writePath,
      finalPath: destFullName,
      size: progress.transferSize,
      readFrom,
      readTo,
      writeAt,
      append,
      text: !!progress.asciiTransfer,
      overwriteMode,
      copyParam,
      params,
      progress,
      onBytes: (n) => progress.addTransferred(n),
    });

    if (doResume) {
      if (existing) {
        try { await dst.remove(dst.normalize(destFullName), { directory: false }); } catch { /* raced */ }
      }
      await dst.rename(dst.normalize(writePath), dst.normalize(destFullName));
    }

    if (copyParam.preserveTime) {
      await engine.updateTargetTime(destFullName, file.mtime, file.modificationFmt);
    }
    await engine.updateTargetAttrs(destFullName, file, copyParam);

    return { destFileName };
  }

  /**
   * TSFTPFileSystem::DirectorySunk — stamp a DOWNLOADED directory with the
   * remote directory's timestamp, once its contents are all in it.
   *
   * It has to be here rather than in `Sink` because writing a file into a
   * directory updates that directory's own modification time: setting it before
   * the children land would set it and then let the file system overwrite it.
   * Failing is logged and ignored, exactly as UpdateTargetTime does — losing a
   * directory's timestamp must never fail a download that moved every byte.
   */
  async directorySunk(destFullName, file, copyParam) {
    if (!copyParam.preserveTime || !copyParam.preserveTimeDirs) return;
    await this.engine.updateTargetTime(destFullName, file.mtime, file.modificationFmt);
  }
}

// ===========================================================================
// helpers
// ===========================================================================

/**
 * TSFTPFileSystem::SFTPConfirmOverwrite's `CanAppend`, which decides whether
 * the overwrite question offers an Append button at all:
 *
 *   `!IsEncryptingFiles() && ((FVersion < 4) || !AsciiTransfer)`
 *
 * Both refusals matter and both destroy data if they are dropped. Appending
 * plaintext to the end of an ENCRYPTED file produces a file whose tail cannot
 * be decrypted and whose header no longer describes it — the transfer looks
 * like it worked and the file is gone. Appending to a file the far side is
 * converting line endings for writes at an offset that means something
 * different on each side. On top of those, the protocol has to be able to
 * write at an offset at all, which is what `caps.resume` says.
 */
function canAppendTo(engine, adapter, progress) {
  if (engine.terminal.sessionData && engine.terminal.sessionData.encryptFiles) return false;
  if (progress && progress.asciiTransfer) return false;
  return !!(adapter && adapter.caps && adapter.caps.resume);
}

async function statOrNull(adapter, p) {
  try { return await adapter.stat(adapter.normalize(p)); } catch { return null; }
}

/**
 * Why an existing target may veto the resumable route — TSFTPFileSystem::Source
 * (SftpFileSystem.cpp:4674-4700).
 *
 * The thing being guarded is not the write, it is the FINISH. Resuming does not
 * overwrite the target in place: it fills `<name>.filepart`, then `remove`s the
 * target and `rename`s the part onto the name. The file that ends up at that
 * path is therefore a brand new one this session created, and two properties of
 * the old file do not survive being recreated:
 *
 *   * a symbolic link. Removing it bins the POINTER and leaves the file it
 *     pointed at orphaned; the rename then drops an ordinary file where the
 *     link used to be, so the user's link is gone and the data they meant to
 *     replace was never touched (4674-4680);
 *   * its owner. A file belonging to a colleague in a shared directory quietly
 *     becomes yours, and preserving rights afterwards cannot put the owner back
 *     — chown is not ours to call (4691-4700).
 *
 * Returns WinSCP's own log line, or '' when the resume may go ahead. It answers
 * with a string rather than a boolean because the reason is the useful part: an
 * upload that silently stops resuming is indistinguishable from a slow server.
 *
 * ONE function for two callers on purpose. `AdapterFileSystem.source` and
 * `queue.js`'s `_copyBytes` both perform that delete-and-rename, and the queue
 * is the route a click in the UI actually takes — a second copy of this rule is
 * a rule that eventually disagrees with itself, which is how the queue came to
 * replace symlinks that the session path had been refusing all along.
 *
 * WinSCP has a THIRD arm between these two, `DoesFileLookLikeSymLink`
 * (4616-4623, `FVersion < 4 && rights == 0777 && Size < 100`), and it is
 * deliberately not ported. It is a heuristic for a problem this port does not
 * have: SSH_FXP_ATTRS in SFTP-3 does not say whether a file is a link, so
 * WinSCP guesses from the mode and the size. protocols/sftp.js:1325-1327
 * `lstat`s and reads the type out of the mode bits, so the first arm already
 * has ground truth on SFTP-3. Porting the guess on top of the fact would only
 * refuse resume for real 0777 files under 100 bytes — and its `FVersion < 4`
 * gate has no meaning in a function that also serves FTP, WebDAV and S3.
 */
function resumeRefusalReason(existing, userName) {
  if (!existing) return '';
  if (existing.isSymlink || existing.type === 'link') {
    return 'Existing file is symbolic link, not doing resumable transfer.';
  }
  // `ownerName` is the load-bearing half, and the reason this is a guard rather
  // than a catastrophe. WinSCP tests `!Owner.Name.IsEmpty()` and concedes in
  // the comment above its own check that it "won't for work for SFTP-3
  // (OpenSSH) as it does not provide owner name (only UID) and we know only
  // logged in username (not UID)". ssh2 asks for SFTP-3 and nothing else, so
  // sftp.js:1345 hands the adapter String(uid); reading "1000" as somebody
  // called 1000 makes the comparison against "alice" false for every file on
  // every server, which would not tighten this check — it would switch
  // resumable uploads off for everyone. The one adapter that genuinely reports
  // a NAME is ftp.js (UNIX.ownername, and the `ls -l` listing fallback), and
  // FTP sets caps.resume from REST STREAM, so this arm is live exactly there.
  const owner = ownerName(existing.owner);
  if (owner && !sameUserName(owner, userName)) {
    return `Existing file is owned by another user [${existing.owner}], not doing resumable transfer.`;
  }
  return '';
}

/**
 * "Preserve overwritten remote files to recycle bin" — the recycle WinSCP does
 * on the UPLOAD path, not the delete path.
 *
 * TSFTPFileSystem::SFTPOpenRemote (SftpFileSystem.cpp:5226-5270) is where this
 * lives, and the way it is spelled there is worth keeping in mind because it
 * is what pins the ORDERING. WinSCP does not stat-then-recycle-then-write; it
 * asks for the target with SSH_FXF_EXCL specifically so the create FAILS when
 * something is already there (5132-5136, whose comment says the existence has
 * to be discovered "even if overwrite confirmation is disabled"), recycles the
 * file from the catch, and lets the enclosing do/while retry the open — which
 * now succeeds, because the original has been moved out of the way. The
 * replacement is never written until the original is safe. This port has no
 * exclusive-create to hang that on, so the caller must do the same thing the
 * blunt way: call this BEFORE a single byte is written, and treat a `recycled`
 * answer as meaning the target no longer exists.
 *
 * The guards, in WinSCP's own order:
 *   * the site has to have asked for it, and named a bin (5227-5228);
 *   * SFTP only. Not a capability check — no remote adapter advertises
 *     `caps.recycleBin` (protocols/sftp.js sets it false, and base.js defaults
 *     it false), because that flag means the OS trash and only the local
 *     backend has one. WinSCP's own gate is the protocol: SessionData.cpp,
 *     SessionInfo.cpp and SftpFileSystem.cpp are the only files that mention
 *     OverwrittenToRecycleBin, and SiteAdvanced.cpp:1038 greys the checkbox out
 *     for everything else, which is what the "(SFTP only)" caption means;
 *   * a symlink is never recycled (5251-5255). Moving it would put the LINK in
 *     the bin and then create a plain file where the link used to be, so the
 *     thing the user wanted preserved — the file at the other end — is
 *     untouched while their link is gone;
 *   * a file already in the bin is not recycled again (TTerminal::IsRecycledFile,
 *     Terminal.cpp:4307-4310).
 *
 * Failure is NOT fatal by default. `if (!FTerminal->RecycleFile(...)) { //
 * Allow normal overwrite` (5259-5262) sets DontRecycle, which drops the EXCL
 * flag on the retry and turns the transfer back into an ordinary truncating
 * overwrite. A bin the user cannot write to must not cost them the upload, so
 * this returns `{ recycled: false }` rather than throwing. `tolerateFailure:
 * false` is for the one caller WinSCP treats differently — the resume
 * rename-over, wrapped in a FILE_OPERATION_LOOP with DELETE_ON_RESUME_ERROR
 * (4955-4957) so the user gets retry/skip/abort. Swallowing there would be
 * worse than useless: the caller's fallback is to DELETE the file, so a
 * silently-failed recycle would destroy exactly the file it was asked to keep.
 *
 * Returns `{ recycled, rights }`. `rights` is the mode of the file that went
 * into the bin, which the caller chmods onto the replacement — SFTPOpenRemote
 * records it at 5266-5267 and PreserveExistingRights applies it at 4804/4826,
 * so that preserving a file does not silently change the permissions of the
 * name it used to occupy.
 */
async function recycleOverwritten(dst, targetPath, existing, sessionData, logEvent, options) {
  const log = typeof logEvent === 'function' ? logEvent : () => {};
  const tolerateFailure = !options || options.tolerateFailure !== false;
  const sd = sessionData || {};
  const bin = sd.recycleBinPath;
  if (!sd.overwrittenToRecycleBin || !bin) return { recycled: false };
  if (!dst || dst.protocolName !== 'SFTP') return { recycled: false };
  if (!existing) return { recycled: false };

  if (existing.isSymlink || existing.type === 'link') {
    log('Existing file is a symbolic link, it will not be moved to a recycle bin.');
    return { recycled: false };
  }
  if (samePath(excludeTrailingSlash(extractFilePath(targetPath)), bin)) return { recycled: false };

  const newName = includeTrailingSlash(bin) +
    maskFileName(extractFileName(targetPath), recycleFileMask(Date.now()));
  try {
    log(`Moving file "${targetPath}" to remote recycle bin '${bin}'.`);
    await dst.rename(dst.normalize(targetPath), dst.normalize(newName));
  } catch (e) {
    if (!tolerateFailure) throw e;
    // Allow normal overwrite — SftpFileSystem.cpp:5261.
    log(`Cannot move file "${targetPath}" to remote recycle bin '${bin}', ` +
      `it will be overwritten: ${(e && e.message) || e}`);
    return { recycled: false };
  }
  return { recycled: true, rights: existing.rights || undefined };
}

async function tolerate(copyParam, fn) {
  try { await fn(); } catch (e) { if (!copyParam.ignorePermErrors) throw e; }
}

/** The reverse side — ReverseOperationSide. */
function reverseSide(side) {
  return side === SIDES.local ? SIDES.remote : SIDES.local;
}

function describeTimestamp(ms, precision) {
  if (!ms || precision === MODIFICATION_FMT.NONE) return 'unknown';
  return new Date(reduceDateTimePrecision(ms, precision === undefined ? MODIFICATION_FMT.FULL : precision)).toISOString();
}

/** Accept bare paths as well as `{ fileName, file }` pairs. */
function normalizeCopyList(fileList) {
  return (fileList || []).map((item) => {
    if (typeof item === 'string') return { fileName: item, file: null, handle: null };
    if (item && typeof item === 'object' && 'fileName' in item) {
      return { fileName: item.fileName, file: item.file || null, handle: item.handle || null };
    }
    return { fileName: item.fullFileName || item.name || '', file: item, handle: null };
  });
}

/**
 * One engine per terminal, kept on the terminal itself so the overwrite
 * "to all" answers and the parallel cursor are shared by everything that
 * transfers on that session — which is exactly what makes "Yes to all"
 * actually mean all of them.
 */
function transferEngineFor(terminal, options) {
  if (!terminal) throw new TerminalError('A transfer engine needs a terminal.');
  if (terminal.__transferEngine) {
    // Late-supplied dependencies (queue.js hands over its byte mover after the
    // terminal exists) update the engine rather than building a second one.
    const e = terminal.__transferEngine;
    if (options) {
      if (options.localAdapter) e.local = options.localAdapter;
      if (options.copyBytes) e.copyBytes = options.copyBytes;
      if (options.fileSystem) e.fileSystem = options.fileSystem;
      if (options.actionsLog) e.actionsLog = options.actionsLog;
    }
    return e;
  }
  const engine = new TransferEngine(terminal, options);
  Object.defineProperty(terminal, '__transferEngine', {
    value: engine, enumerable: false, configurable: true, writable: true,
  });
  return engine;
}

module.exports = {
  // constants
  COPY_FLAGS, TRANSFER_FLAGS, BATCH_OVERWRITE, OVERWRITE_MODE, OVERWRITE_ANSWERS,
  QUEUE_FILE_STATE, LOCAL_INVALID_CHARS, TOKENIZIBLE_CHARS,
  TOKEN_PREFIX, TOKEN_REPLACEMENT, NO_REPLACEMENT, MAX_EMPTY_DIRECTORY_DEPTH,
  // copy-param logic
  validLocalFileName, restoreChars, changeFileName, allowResume, useAsciiTransfer,
  remoteFileRights, localFileReadOnly, resumeTransfer, skipTransfer, allowAnyTransfer,
  isReservedName, limitsTransferReconnects,
  // progress helpers terminal.js did not need
  rollbackTransfer, addResumed, setAsciiTransfer,
  // classes
  OverwriteFileParams, CollectedFileList, ParallelOperation, TransferAction,
  StandaloneHost, SimpleProgress, TransferEngine, AdapterFileSystem,
  // wiring
  transferEngineFor, normalizeCopyList, canAppendTo, recycleOverwritten,
  resumeRefusalReason,
  extractFileNameLocal, extractFileDirLocal,
};
