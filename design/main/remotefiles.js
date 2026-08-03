// remotefiles.js — the remote file and directory model.
//
// A faithful port of vendor/winscp/source/core/RemoteFiles.cpp. Everything the
// panels, the queue, the synchronizer and the properties dialog know about a
// remote file comes from here: what a file IS (`TRemoteFile`), what a listing
// IS (`TRemoteFileList` / `TRemoteDirectory`), what permissions ARE (`TRights`,
// including the "some of the selected files have this bit and some do not"
// state), and the unix path arithmetic every protocol shares.
//
// Two ideas in this file are worth reading before the code:
//
//  * **Modification precision.** A server does not always tell you the whole
//    timestamp. An `ls` listing older than six months has no time at all, a
//    recent one has no seconds and no year, SFTP has the lot. `MODIFICATION_FMT`
//    records how much of a timestamp is real, and `compareModification` reduces
//    BOTH sides to the coarser of the two before comparing — otherwise every
//    synchronization would re-copy every file whose remote timestamp merely
//    lacks seconds.
//  * **Symlink resolution and loops.** Following a link means asking the
//    server, so it is a callback (`resolver`), not a method. `linkedByFile`
//    chains the file back to the link that pointed at it, which is how a cycle
//    is detected: if any ancestor points at the same target, the whole chain is
//    marked cyclic and reported as a broken link rather than followed forever.
//
// Times are epoch milliseconds throughout, matching the adapter contract in
// protocols/base.js. Where WinSCP's behaviour depended on the VCL (the shell
// icon index, the locale-formatted "user" timestamp) the intent is implemented
// and the comment says so.
'use strict';

const C = require('./common');

const SYMLINK_STR = ' -> ';
const ROOT_DIRECTORY = '/';
const FILETYPE_DEFAULT = '-';
const FILETYPE_SYMLINK = 'L';
const FILETYPE_DIRECTORY = 'D';
const PARTIAL_EXT = '.filepart';

/** How much of a modification timestamp the server actually told us. */
const MODIFICATION_FMT = {
  NONE: 0,   // nothing at all
  MDHM: 1,   // month, day, hour, minute — a recent `ls` line, year guessed
  YMDHM: 2,  // as above but the year is real
  MDY: 3,    // month, day, year — an old `ls` line, no time at all
  FULL: 4,   // everything, to the second
};

// ---------------------------------------------------------------------------
// unix path arithmetic
// ---------------------------------------------------------------------------

/**
 * 'C:/foo' — a Windows path an FTP server hands back in unix shape. It has to
 * be treated as absolute even though it does not start with a slash, and its
 * three-character root ('C:/') keeps its trailing slash.
 */
function isUnixStyleWindowsPath(path) {
  const p = String(path);
  return p.length >= 3 && C.isLetter(p[0]) && p[1] === ':' && p[2] === '/';
}

function unixIsAbsolutePath(path) {
  const p = String(path);
  return (p.length >= 1 && p[0] === '/') || isUnixStyleWindowsPath(p);
}

/** Empty stays empty — it used to return '/', and callers depend on it not doing so. */
function unixIncludeTrailingBackslash(path) {
  const p = String(path);
  if (p !== '' && !p.endsWith('/')) return p + '/';
  return p;
}

/**
 * Keeps '/' for the root, and (unless `simple`) keeps 'C:/' whole — stripping
 * that slash would turn an absolute path into a drive-relative one.
 */
function unixExcludeTrailingBackslash(path, simple) {
  const p = String(path);
  if (p === '' || p === '/' || !p.endsWith('/') ||
      (!simple && p.length === 3 && isUnixStyleWindowsPath(p))) {
    return p;
  }
  return p.slice(0, -1);
}

function simpleUnixExcludeTrailingBackslash(path) {
  return unixExcludeTrailingBackslash(path, true);
}

function universalIncludeTrailingBackslash(unix, path) {
  return unix ? unixIncludeTrailingBackslash(path) : C.includeTrailingBackslash(path);
}

function universalExcludeTrailingBackslash(unix, path) {
  return unix ? unixExcludeTrailingBackslash(path) : C.excludeTrailingBackslash(path);
}

/** Adds the separator even for an empty second part — callers rely on it. */
function unixCombinePathsForce(path1, path2) {
  return unixIncludeTrailingBackslash(path1) + String(path2 === undefined ? '' : path2);
}

function unixCombinePaths(path1, path2) {
  return unixCombinePathsForce(path1, path2);
}

/** The variant that does NOT add a trailing slash for an empty second part. */
function unixCombinePathsSmart(path1, path2) {
  if (!path2) return String(path1);
  return unixCombinePaths(path1, path2);
}

function universalCombinePaths(unix, path1, path2) {
  return unix ? unixCombinePaths(path1, path2) : C.combinePaths(path1, path2);
}

function unixSamePath(path1, path2) {
  return unixIncludeTrailingBackslash(path1) === unixIncludeTrailingBackslash(path2);
}

/** A path is its own child: '/a/' is a child path of '/a'. */
function unixIsChildPath(parent, child) {
  const p = unixIncludeTrailingBackslash(parent);
  const c = unixIncludeTrailingBackslash(child);
  return c.slice(0, p.length) === p;
}

/** No trailing slash; '/x' gives '/', a name with no slash gives ''. */
function unixExtractFileDir(path) {
  const p = String(path);
  const pos = p.lastIndexOf('/');
  if (pos > 0) return p.slice(0, pos);
  return pos === 0 ? ROOT_DIRECTORY : '';
}

/** With the trailing slash. A name with no slash gives '' (not '/'). */
function unixExtractFilePath(path) {
  const p = String(path);
  const pos = p.lastIndexOf('/');
  return pos >= 0 ? p.slice(0, pos + 1) : '';
}

function unixExtractFileName(path) {
  const p = String(path);
  const pos = p.lastIndexOf('/');
  return pos >= 0 ? p.slice(pos + 1) : p;
}

/**
 * The extension INCLUDING the dot, or ''. Ported with its original quirk: the
 * dot is located inside the file name but the slice is taken from the whole
 * path, so a dot in a directory component of a path whose file name has no dot
 * yields nothing, while a name with a dot behaves normally.
 *
 * A dot-file IS its own extension ('.bashrc' -> '.bashrc'), because the C++
 * tests `LastDelimiter(".") > 0` on a 1-based index — position 1 counts. Delphi
 * ExtractFileExt agrees, and the Type/Ext sort column depends on the two
 * matching.
 */
function unixExtractFileExt(path) {
  const p = String(path);
  const fileName = unixExtractFileName(p);
  const pos = fileName.lastIndexOf('.');
  return pos >= 0 ? p.slice(pos) : '';
}

function extractFileName(path, unix) {
  return unix ? unixExtractFileName(path) : C.extractFileName(path);
}

/** Falls back to the whole path, so a UI label is never empty. */
function extractShortName(path, unix) {
  const result = extractFileName(path, unix);
  return result === '' ? String(path) : result;
}

/**
 * The deepest directory every listed path shares, or false when there is none.
 * `files` may be plain strings or objects with a `fullFileName`.
 */
function extractCommonPath(files) {
  if (!files || files.length === 0) return { ok: false, path: '' };
  let path = C.extractFilePath(fileListItemPath(files[0]));
  let ok = path !== '';
  if (ok) {
    for (let index = 1; index < files.length; index++) {
      const item = fileListItemPath(files[index]);
      while (path !== '' && item.slice(0, path.length) !== path) {
        const prevLen = path.length;
        path = C.extractFilePath(C.excludeTrailingBackslash(path));
        if (path.length === prevLen) {
          path = '';
          ok = false;
        }
      }
    }
  }
  return { ok, path };
}

function fileListItemPath(item) {
  if (item && typeof item === 'object') {
    // cloneStrings mirrors TStrings.Objects as { name, file }.  The object is
    // the authoritative path for a remote selection; its display name alone
    // is only a basename and cannot produce a common directory.
    if (item.file && typeof item.file === 'object' &&
        item.file.fullFileName !== undefined) {
      return item.file.fullFileName;
    }
    return item.fullFileName !== undefined ? item.fullFileName : String(item.name || '');
  }
  return String(item);
}

function unixExtractCommonPath(files) {
  if (!files || files.length === 0) return { ok: false, path: '' };
  let path = unixExtractFilePath(fileListItemPath(files[0]));
  let ok = path !== '';
  if (ok) {
    for (let index = 1; index < files.length; index++) {
      const item = fileListItemPath(files[index]);
      while (path !== '' && item.slice(0, path.length) !== path) {
        const prevLen = path.length;
        path = unixExtractFilePath(unixExcludeTrailingBackslash(path));
        if (path.length === prevLen) {
          path = '';
          ok = false;
        }
      }
    }
  }
  return { ok, path };
}

function isUnixRootPath(path) {
  return !path || path === ROOT_DIRECTORY;
}

/** '.' and '..' are not hidden files, however much they start with a dot. */
function isUnixHiddenFile(fileName) {
  return C.isRealFile(fileName) && !!fileName && fileName[0] === '.';
}

/**
 * AbsolutePath — resolve `path` against `base`, collapsing '..' and '.'.
 * '/../' at the very start collapses to '/', because the root has no parent
 * and a server that is asked for one answers with an error the user cannot act
 * on.
 */
function absolutePath(base, path) {
  const p = String(path === undefined ? '' : path);
  if (p === '') return String(base);
  // FTP on Windows can return an absolute path in drive-qualified Unix
  // spelling (C:/dir).  UnixIsAbsolutePath deliberately recognises that
  // shape; AbsolutePath must honour the same contract or it turns an
  // absolute target into base/C:/target.
  if (unixIsAbsolutePath(p)) return unixExcludeTrailingBackslash(p);

  let result = unixIncludeTrailingBackslash(unixIncludeTrailingBackslash(base) + p);
  let at;
  while ((at = result.indexOf('/../')) >= 0) {
    if (at === 0) {
      result = '/';
    } else {
      const at2 = result.slice(0, at).lastIndexOf('/');
      if (at2 < 0) break;
      result = result.slice(0, at2) + result.slice(at + 3);
    }
  }
  while ((at = result.indexOf('/./')) >= 0) {
    result = result.slice(0, at) + result.slice(at + 2);
  }
  return unixExcludeTrailingBackslash(result);
}

function fromUnixPath(path) { return C.fromUnixPath(path); }
function toUnixPath(path) { return C.toUnixPath(path); }

/** Removes the first directory component, leaving '...' in its place. */
function cutFirstDirectory(s, unix) {
  const sep = unix ? '/' : '\\';
  if (s === sep) return '';
  let str = s;
  let root = false;
  if (str[0] === sep) {
    root = true;
    str = str.slice(1);
  }
  if (str[0] === '.') str = str.slice(4); // an existing '...' + separator
  const p = str.indexOf(sep);
  if (p >= 0) {
    str = C.ELLIPSIS + sep + str.slice(p + 1);
  } else {
    str = '';
  }
  if (root) str = sep + str;
  return str;
}

/**
 * MinimizeName — shorten a path to fit a label by eating directories from the
 * left, keeping the drive and the file name. Truncates outright only when even
 * the bare name is too long.
 */
function minimizeName(fileName, maxLen, unix) {
  const sep = unix ? '/' : '\\';
  let result = String(fileName);
  let drive = '';
  let dir;
  let name;

  if (unix) {
    const p = result.lastIndexOf('/');
    if (p >= 0) {
      dir = result.slice(0, p + 1);
      name = result.slice(p + 1);
    } else {
      dir = '';
      name = result;
    }
  } else {
    dir = C.extractFilePath(result);
    name = C.extractFileName(result);
    if (dir.length >= 2 && dir[1] === ':') {
      drive = dir.slice(0, 2);
      dir = dir.slice(2);
    }
  }

  while ((dir !== '' || drive !== '') && result.length > maxLen) {
    if (dir === sep + C.ELLIPSIS + sep) dir = C.ELLIPSIS + sep;
    else if (dir === '') drive = '';
    else dir = cutFirstDirectory(dir, unix);
    result = drive + dir + name;
  }

  if (result.length > maxLen) result = result.slice(0, maxLen);
  return result;
}

/** A space-separated, quoted list of local names for a command line. */
function makeFileList(fileList) {
  let result = '';
  for (const fileName of fileList || []) {
    result = C.addToList(result, C.addQuotes(fileName), ' ');
  }
  return result;
}

/**
 * VMS keeps every revision of a file as 'NAME.EXT;3'. With the session's
 * "trim VMS versions" option on, the version suffix is dropped so the file
 * looks like one file with a stable name.
 */
function trimVmsVersion(fileName, trim) {
  if (!trim) return String(fileName);
  const name = String(fileName);
  const p = name.lastIndexOf(';');
  return p > 0 ? name.slice(0, p) : name;
}

/** True when the name carries a VMS revision suffix, e.g. 'LOGIN.COM;3'. */
function hasVmsVersion(fileName) {
  // A valid VMS name may be a single character (A;1).  The semicolon must
  // not be the first character, but it may be at index 1.
  return /;\d+$/.test(String(fileName)) && String(fileName).indexOf(';') > 0;
}

/**
 * The confirmation WinSCP asks before transferring several files onto ONE
 * target name — the accident that silently destroys all but the last file.
 * The message names the trailing slash that would have made it a directory.
 */
function formatMultiFilesToOneConfirmation(target, unix) {
  let dir;
  let name;
  let path;
  if (unix) {
    dir = unixExtractFileDir(target);
    name = unixExtractFileName(target);
    path = unixIncludeTrailingBackslash(target);
  } else {
    dir = C.extractFilePath(target);
    name = C.extractFileName(target);
    path = C.includeTrailingBackslash(target);
  }
  return C.mainInstructions(
    `Are you sure you want to transfer multiple files to a single file '${name}' in a directory '${dir}'?`) +
    '\n\nThe files will overwrite one another.\n\n' +
    `If you actually want to transfer all files to a directory '${path}', keeping their name, ` +
    'make sure you terminate the path with a slash.';
}

// ---------------------------------------------------------------------------
// modification precision
// ---------------------------------------------------------------------------

/** Zeroes the parts of a timestamp the server never actually told us. */
function reduceDateTimePrecision(ms, precision) {
  if (precision === MODIFICATION_FMT.NONE) return 0;
  if (precision === MODIFICATION_FMT.FULL) return ms;
  const d = new Date(ms);
  switch (precision) {
    case MODIFICATION_FMT.YMDHM:
    case MODIFICATION_FMT.MDHM:
      d.setSeconds(0, 0);
      break;
    case MODIFICATION_FMT.MDY:
      d.setHours(0, 0, 0, 0);
      break;
    default:
      return ms;
  }
  return d.getTime();
}

/** The coarser of two precisions — the only one a comparison may rely on. */
function lessDateTimePrecision(precision1, precision2) {
  return precision1 < precision2 ? precision1 : precision2;
}

/**
 * "Are these two timestamps actually the same file?" Both sides are reduced to
 * the coarser precision and then compared with the two-second FAT tolerance.
 * Returns -1/0/1 like the C++ CompareFileTime.
 */
function compareModification(ms1, precision1, ms2, precision2) {
  const precision = lessDateTimePrecision(precision1, precision2);
  return C.compareFileTime(
    reduceDateTimePrecision(ms1, precision),
    reduceDateTimePrecision(ms2, precision));
}

function sameModification(ms1, precision1, ms2, precision2) {
  return compareModification(ms1, precision1, ms2, precision2) === 0;
}

/**
 * ModificationStr — the exact `ls`-shaped string WinSCP writes to the log and
 * echoes back in a listing. Fixed English month names and fixed field widths;
 * this one is NOT locale dependent.
 */
function modificationStr(ms, precision) {
  if (precision === MODIFICATION_FMT.NONE) return '';
  const d = new Date(ms);
  const month = C.ENG_SHORT_MONTH_NAMES[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hour = String(d.getHours()).padStart(2, ' ');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  const year = String(d.getFullYear()).padStart(4, ' ');
  switch (precision) {
    case MODIFICATION_FMT.MDY:
      return `${month} ${day} ${String(d.getFullYear()).padStart(2, ' ')}`;
    case MODIFICATION_FMT.MDHM:
      return `${month} ${day} ${hour}:${min}`;
    case MODIFICATION_FMT.YMDHM:
      return `${month} ${day} ${hour}:${min} ${year}`;
    default:
      return `${month} ${day} ${hour}:${min}:${sec} ${year}`;
  }
}

/**
 * UserModificationStr — what the file panel's "Changed" column shows. Delphi
 * formats this with the user's Windows locale ('ddddd', 'ddddd t', 'ddddd tt');
 * there is no such setting here, so the shape is ISO-like by default and the
 * caller may pass its own formatter to localize it.
 */
function userModificationStr(ms, precision, format) {
  if (precision === MODIFICATION_FMT.NONE) return '';
  const d = new Date(ms);
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shortTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const longTime = `${shortTime}:${pad(d.getSeconds())}`;
  if (typeof format === 'function') return format(d, precision);
  switch (precision) {
    case MODIFICATION_FMT.MDY:
      return date;
    case MODIFICATION_FMT.MDHM:
    case MODIFICATION_FMT.YMDHM:
      return `${date} ${shortTime}`;
    default:
      return `${date} ${longTime}`;
  }
}

/** A timestamp with no time in it cannot meaningfully be shifted by seconds. */
function isTimeShiftingApplicable(precision) {
  return precision === MODIFICATION_FMT.MDHM ||
    precision === MODIFICATION_FMT.YMDHM ||
    precision === MODIFICATION_FMT.FULL;
}

function shiftTimeInSeconds(ms, precision, seconds) {
  if (seconds !== 0 && isTimeShiftingApplicable(precision)) return ms + seconds * 1000;
  return ms;
}

/**
 * How many characters at the end of the name are the ".filepart" marker (plus
 * its numeric suffix, if the transfer had to disambiguate). Zero when the name
 * is not a partial file.
 */
function getPartialFileExtLen(fileName) {
  const name = String(fileName);
  if (name.toLowerCase().endsWith(PARTIAL_EXT)) return PARTIAL_EXT.length;
  const p = name.lastIndexOf('.');
  if (p > 0 && p < name.length - 1) {
    if (C.isNumber(name.slice(p + 1)) &&
        name.slice(0, p).toLowerCase().endsWith(PARTIAL_EXT)) {
      return PARTIAL_EXT.length + (name.length - p);
    }
  }
  return 0;
}

/**
 * Bitvise reports a file's owner as 'user@host' while the session logs in as
 * 'user', so the part after '@' is ignored when deciding "is this mine?".
 */
function sameUserName(userName1, userName2) {
  const a = C.copyToChar(String(userName1 || ''), '@', true);
  const b = C.copyToChar(String(userName2 || ''), '@', true);
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * TRemoteToken::GetNameValid, for callers that only have the adapter contract.
 *
 * WinSCP keeps a file's owner as a TRemoteToken with two independent fields —
 * a name and a numeric id — and every ownership question it asks is guarded by
 * `!Owner.Name.IsEmpty()`, because a protocol that reports only a uid has told
 * it nothing it can compare against a login name. The adapter boundary in this
 * port flattens both meanings into one `owner` string: sftp.js writes
 * `String(uid)` because ssh2 speaks SFTP-3, whose attribute block has no
 * owner-name field at all; ftp.js writes UNIX.ownername when MLST supplies it
 * and the numeric UNIX.owner when it does not. That distinction has to be
 * recovered here or "1000" reads as somebody called 1000, and a comparison
 * against 'alice' is then false for every file on the server.
 */
function ownerName(owner) {
  const s = String(owner === undefined || owner === null ? '' : owner).trim();
  return /^\d+$/.test(s) ? '' : s;
}

/**
 * File type classification. WinSCP keeps the raw `ls` type character and
 * derives everything from it, which is why an unknown character (a door, a
 * whiteout) still lists rather than failing.
 */
function fileTypeName(typeChar) {
  switch (String(typeChar || '').toUpperCase()) {
    case FILETYPE_DIRECTORY: return 'dir';
    case FILETYPE_SYMLINK: return 'link';
    case 'B': return 'block-device';
    case 'C': return 'character-device';
    case 'P': return 'fifo';
    case 'S': return 'socket';
    case FILETYPE_DEFAULT: return 'file';
    default: return 'special';
  }
}

// ---------------------------------------------------------------------------
// TRights
// ---------------------------------------------------------------------------

const RIGHT = {
  UserIDExec: 0, GroupIDExec: 1, StickyBit: 2,
  UserRead: 3, UserWrite: 4, UserExec: 5,
  GroupRead: 6, GroupWrite: 7, GroupExec: 8,
  OtherRead: 9, OtherWrite: 10, OtherExec: 11,
};
const RIGHT_FIRST = RIGHT.UserIDExec;
const RIGHT_LAST = RIGHT.OtherExec;

const RIGHT_GROUP = { User: 0, Group: 1, Other: 2 };
/** S3 reuses the group/other columns for its ACL grants; same numbers, other names. */
const RIGHT_LEVEL = { None: -1, Read: 0, Write: 1, Exec: 2, Special: 3 };

const FLAG = {
  SetUID: 0o4000, SetGID: 0o2000, StickyBit: 0o1000,
  UserRead: 0o400, UserWrite: 0o200, UserExec: 0o100,
  GroupRead: 0o40, GroupWrite: 0o20, GroupExec: 0o10,
  OtherRead: 0o4, OtherWrite: 0o2, OtherExec: 0o1,
  Read: 0o444, Write: 0o222, Exec: 0o111,
  No: 0o0, Default: 0o644, All: 0o777,
  Specials: 0o7000, AllSpecials: 0o7777,
};

/** The three-state a multi-file properties dialog needs. */
const RIGHT_STATE = { No: 0, Yes: 1, Undef: 2 };

const BASIC_SYMBOLS = 'rwxrwxrwx';
const COMBINED_SYMBOLS = '--s--s--t';
const EXTENDED_SYMBOLS = '--S--S--T';
const MODE_GROUPS = 'ugo';
const TEXT_LEN = 9;
const UNDEF_SYMBOL = '$';
const UNSET_SYMBOL = '-';
/** Win32-OpenSSH prints '*' for permissions that mean nothing on Windows. */
const UNSET_SYMBOL_WIN = '*';

class RightsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RightsError';
  }
}

/**
 * TRights — a permission set that can be partially unknown.
 *
 * `set` and `unset` are two independent bit masks. A bit present in neither is
 * UNDEFINED: that is what the properties dialog shows as a greyed checkbox
 * when the selection contains files that disagree, and what `chmod` must then
 * leave alone. `unknown` is different again — it means the server never told
 * us the permissions at all (a WebDAV or S3 listing), in which case the UI
 * shows the server's own text instead of a permission grid.
 */
class TRights {
  constructor(source) {
    this.allowUndef = false;
    this._set = 0;
    this._unset = 0;
    this._text = '';
    this.unknown = true;
    if (source instanceof TRights) {
      this.assign(source);
    } else if (typeof source === 'number') {
      this.allowUndef = false;
      this._set = 0;
      this._unset = 0;
      this.number = source;
    } else {
      this.number = 0;
      this.unknown = true;
    }
  }

  assign(source) {
    this.allowUndef = source.allowUndef;
    this._set = source._set;
    this._unset = source._unset;
    this._text = source._text;
    this.unknown = source.unknown;
    return this;
  }

  clone() {
    return new TRights().assign(this);
  }

  static rightToFlag(right) {
    return 1 << (RIGHT_LAST - right);
  }

  static calculateRight(group, level) {
    if (level === RIGHT_LEVEL.Special) return RIGHT.UserIDExec + group;
    return RIGHT.UserRead + level + (group * 3);
  }

  static calculateFlag(group, level) {
    return TRights.rightToFlag(TRights.calculateRight(group, level));
  }

  static calculatePermissions(group, level, level2, level3) {
    let permissions = TRights.calculateFlag(group, level);
    if (level2 !== undefined && level2 !== RIGHT_LEVEL.None) {
      permissions |= TRights.calculateFlag(group, level2);
    }
    if (level3 !== undefined && level3 !== RIGHT_LEVEL.None) {
      permissions |= TRights.calculateFlag(group, level3);
    }
    return permissions & 0xffff;
  }

  get numberSet() { return this._set; }
  get numberUnset() { return this._unset; }

  /** A bit is undefined when it is in neither mask. */
  get isUndef() { return ((this._set | this._unset) & 0xffff) !== FLAG.AllSpecials; }

  get number() { return this._set; }

  set number(value) {
    const v = value & 0xffff;
    if (this._set !== v || ((this._set | this._unset) & 0xffff) !== FLAG.AllSpecials) {
      this._set = v;
      this._unset = FLAG.AllSpecials & ~v;
      this._text = '';
    }
    this.unknown = false;
  }

  getRightUndef(right) {
    const flag = TRights.rightToFlag(right);
    if ((this._set & flag) !== 0) return RIGHT_STATE.Yes;
    if ((this._unset & flag) !== 0) return RIGHT_STATE.No;
    return RIGHT_STATE.Undef;
  }

  setRightUndef(right, value) {
    if (value !== this.getRightUndef(right)) {
      const flag = TRights.rightToFlag(right);
      switch (value) {
        case RIGHT_STATE.Yes:
          this._set |= flag;
          this._unset &= ~flag & 0xffff;
          break;
        case RIGHT_STATE.No:
          this._set &= ~flag & 0xffff;
          this._unset |= flag;
          break;
        default:
          this._set &= ~flag & 0xffff;
          this._unset &= ~flag & 0xffff;
          break;
      }
      this._text = '';
    }
    this.unknown = false;
    return this;
  }

  getRight(right) {
    return this.getRightUndef(right) === RIGHT_STATE.Yes;
  }

  setRight(right, value) {
    return this.setRightUndef(right, value ? RIGHT_STATE.Yes : RIGHT_STATE.No);
  }

  /**
   * The Windows read-only attribute mapped onto unix bits. Ported with the
   * original's inconsistency between the two accessors, because `attr` (and
   * therefore drag-and-drop) depends on the getter as written: SETTING
   * readOnly to true clears the write bits, but GETTING it reports true when
   * all three write bits are PRESENT. Do not "fix" one without the other —
   * they are separately observable.
   */
  get readOnly() {
    return this.getRight(RIGHT.UserWrite) && this.getRight(RIGHT.GroupWrite) &&
      this.getRight(RIGHT.OtherWrite);
  }

  set readOnly(value) {
    this.setRight(RIGHT.UserWrite, !value);
    this.setRight(RIGHT.GroupWrite, !value);
    this.setRight(RIGHT.OtherWrite, !value);
  }

  /**
   * The nine-character 'rwxr-xr-x' form. Undefined bits render as '$', which
   * is what the properties dialog round-trips for a mixed selection.
   */
  get text() {
    if (this._text !== '') return this._text;
    const result = new Array(TEXT_LEN);
    let flag = 0o1;
    let extendedFlag = 0o1000;
    let extendedPos = true;
    let i = TEXT_LEN;
    while (i >= 1) {
      let symbol;
      if (extendedPos && ((this._set & (flag | extendedFlag)) === (flag | extendedFlag))) {
        symbol = COMBINED_SYMBOLS[i - 1];
      } else if ((this._set & flag) !== 0) {
        symbol = BASIC_SYMBOLS[i - 1];
      } else if (extendedPos && ((this._set & extendedFlag) !== 0)) {
        symbol = EXTENDED_SYMBOLS[i - 1];
      } else if ((!extendedPos && ((this._unset & flag) === flag)) ||
                 (extendedPos && ((this._unset & (flag | extendedFlag)) === (flag | extendedFlag)))) {
        symbol = UNSET_SYMBOL;
      } else {
        symbol = UNDEF_SYMBOL;
      }
      result[i - 1] = symbol;
      flag <<= 1;
      i--;
      extendedPos = (i % 3) === 0;
      if (extendedPos) extendedFlag <<= 1;
    }
    return result.join('');
  }

  set text(value) {
    const v = String(value);
    if (v !== this.text) {
      if (v.length !== TEXT_LEN ||
          (!this.allowUndef && v.indexOf(UNDEF_SYMBOL) >= 0) ||
          v.indexOf(' ') >= 0) {
        throw new RightsError(`Invalid rights description '${value}'`);
      }

      this._set = 0;
      this._unset = 0;
      let flag = 0o1;
      let extendedFlag = 0o1000;
      let keepText = false;
      for (let i = TEXT_LEN; i >= 1; i--) {
        const ch = v[i - 1];
        if (ch === UNSET_SYMBOL || ch === UNSET_SYMBOL_WIN) {
          this._unset |= (flag | extendedFlag);
        } else if (ch === UNDEF_SYMBOL) {
          // leave the bit in neither mask
        } else if (ch === COMBINED_SYMBOLS[i - 1]) {
          this._set |= (flag | extendedFlag);
        } else if (ch === EXTENDED_SYMBOLS[i - 1]) {
          // 'S'/'T' — the special bit is on but the execute bit is off.
          this._set |= extendedFlag;
          this._unset |= flag;
        } else {
          // Anything else (an ACL letter, a server's own notation) still means
          // "this bit is set", but the original text is kept verbatim so the
          // UI does not silently rewrite what the server said.
          if (ch !== BASIC_SYMBOLS[i - 1]) keepText = true;
          this._set |= flag;
          if (i % 3 === 0) this._unset |= extendedFlag;
        }
        flag <<= 1;
        if (i % 3 === 1) extendedFlag <<= 1;
      }
      this._set &= 0xffff;
      this._unset &= 0xffff;
      this._text = keepText ? v : '';
    }
    this.unknown = false;
  }

  /** Used when a server reports permissions in a notation we cannot decode. */
  setTextOverride(value) {
    if (this._text !== value) {
      this._text = value;
      this.unknown = false;
    }
  }

  /** Four octal digits, from the SET bits only — undefined bits read as zero. */
  get octal() {
    const n = this._set;
    return String((n & 0o7000) >> 9) + String((n & 0o700) >> 6) +
      String((n & 0o70) >> 3) + String(n & 0o7);
  }

  set octal(value) {
    let v = String(value);
    if (v.length === 3) v = '0' + v;
    if (v !== this.octal) {
      let correct = v.length === 4;
      for (let i = 0; i < v.length && correct; i++) {
        correct = v[i] >= '0' && v[i] <= '7';
      }
      if (!correct) {
        throw new RightsError(`'${value}' is not valid permission in octal format.`);
      }
      this.number =
        ((v.charCodeAt(0) - 48) << 9) +
        ((v.charCodeAt(1) - 48) << 6) +
        ((v.charCodeAt(2) - 48) << 3) +
        (v.charCodeAt(3) - 48);
      this._text = '';
    }
    this.unknown = false;
  }

  /** '644' as the decimal number 644 — what a scripting interface exchanges. */
  get numberDecadic() {
    const n = this._set;
    return ((n & 0o7000) / 0o1000) * 1000 +
      ((n & 0o700) / 0o100) * 100 +
      ((n & 0o70) / 0o10) * 10 +
      (n & 0o7);
  }

  /**
   * The argument for `chmod`. A fully known set goes as octal; a partially
   * undefined one has to go as the symbolic 'u+rw,g-w' form, because octal
   * cannot say "leave this bit as it is". Directories get a leading fifth zero
   * — newer coreutils need it to clear setuid/setgid on a directory.
   */
  getChmodStr(directory) {
    if (this.isUndef) return this.modeStr;
    const result = this.octal;
    return directory !== 0 ? '0' + result : result;
  }

  /** The symbolic form: 'u+rwx,g+rx-w,o-rwx'. */
  get modeStr() {
    let result = '';
    for (let group = 0; group < 3; group++) {
      let setModeStr = '';
      let unsetModeStr = '';
      for (let mode = 0; mode < 3; mode++) {
        const index = (group * 3) + mode;
        const right = RIGHT.UserRead + index;
        switch (this.getRightUndef(right)) {
          case RIGHT_STATE.Yes: setModeStr += BASIC_SYMBOLS[index]; break;
          case RIGHT_STATE.No: unsetModeStr += BASIC_SYMBOLS[index]; break;
          default: break;
        }
      }
      const special = RIGHT.UserIDExec + group;
      const specialIndex = (group * 3) + 2;
      switch (this.getRightUndef(special)) {
        case RIGHT_STATE.Yes: setModeStr += COMBINED_SYMBOLS[specialIndex]; break;
        case RIGHT_STATE.No: unsetModeStr += COMBINED_SYMBOLS[specialIndex]; break;
        default: break;
      }
      if (setModeStr !== '' || unsetModeStr !== '') {
        if (result !== '') result += ',';
        result += MODE_GROUPS[group];
        if (setModeStr !== '') result += '+' + setModeStr;
        if (unsetModeStr !== '') result += '-' + unsetModeStr;
      }
    }
    return result;
  }

  /**
   * The "add x to directories" transfer option: a directory nobody may enter
   * is useless, so wherever read or write is granted, execute is granted too.
   */
  addExecute() {
    for (let group = 0; group < 3; group++) {
      if (this.getRightUndef(RIGHT.UserRead + (group * 3)) === RIGHT_STATE.Yes ||
          this.getRightUndef(RIGHT.UserWrite + (group * 3)) === RIGHT_STATE.Yes) {
        this.setRight(RIGHT.UserExec + (group * 3), true);
        this._text = '';
      }
    }
    this.unknown = false;
    return this;
  }

  /** Everything unknown — the starting point for a multi-file selection. */
  allUndef() {
    if (this._set !== 0 || this._unset !== 0) {
      this._set = 0;
      this._unset = 0;
      this._text = '';
    }
    this.unknown = false;
    return this;
  }

  equals(other) {
    if (typeof other === 'number') return this.number === (other & 0xffff);
    if (this.allowUndef || other.allowUndef) {
      for (let right = RIGHT_FIRST; right <= RIGHT_LAST; right++) {
        if (this.getRightUndef(right) !== other.getRightUndef(right)) return false;
      }
      return true;
    }
    return this.number === other.number;
  }

  /**
   * Intersection. With undefined allowed this is what turns a multi-file
   * selection into "the bits they agree on, the rest undefined" — the exact
   * state the properties dialog renders as a mixed checkbox.
   */
  andAssign(other) {
    if (typeof other === 'number') {
      this.number = this.number & other;
      return this;
    }
    if (this.allowUndef || other.allowUndef) {
      for (let right = RIGHT_FIRST; right <= RIGHT_LAST; right++) {
        if (this.getRightUndef(right) !== other.getRightUndef(right)) {
          this.setRightUndef(right, RIGHT_STATE.Undef);
        }
      }
    } else {
      this.number = this.number & other.number;
    }
    return this;
  }

  orAssign(other) {
    const n = typeof other === 'number' ? other : other.number;
    this.number = this.number | n;
    return this;
  }

  and(other) { return this.clone().andAssign(other); }
  or(other) { return this.clone().orAssign(other); }
  not() { return new TRights((~this.number) & 0xffff); }

  /**
   * Applies another set's decisions on top of this one: its granted bits are
   * added, its denied bits removed. The result is always fully defined,
   * because the numeric assignment fills in the complement — which is what
   * makes it usable as a chmod argument.
   */
  combine(other) {
    const result = this.clone();
    result.number = result.number | other.numberSet;
    result.number = result.number & (~other.numberUnset & 0xffff);
    return result;
  }

  toString() { return this.text; }
}

// ---------------------------------------------------------------------------
// TRemoteToken / TRemoteTokenList
// ---------------------------------------------------------------------------

/**
 * An owner or a group. Either a name, or a numeric id, or both — SFTP version
 * 3 gives names, version 4 gives ids, and some servers give neither.
 */
class TRemoteToken {
  constructor(name) {
    this.name = name === undefined ? '' : String(name);
    this._id = 0;
    this.idValid = false;
  }

  clone() {
    const t = new TRemoteToken(this.name);
    t._id = this._id;
    t.idValid = this.idValid;
    return t;
  }

  /** Clears the id but NOT the name, exactly as TRemoteToken::Clear does. */
  clear() {
    this._id = 0;
    this.idValid = false;
    return this;
  }

  get id() { return this._id; }
  set id(value) {
    this._id = value;
    this.idValid = true;
  }

  get nameValid() { return this.name !== ''; }
  get isSet() { return this.name !== '' || this.idValid; }

  equals(other) {
    return this.name === other.name && this.idValid === other.idValid &&
      (!this.idValid || this._id === other._id);
  }

  /** Named tokens sort before unnamed ones, and unnamed-with-id before neither. */
  compare(other) {
    if (this.name !== '') {
      if (other.name !== '') return C.compareText(this.name, other.name);
      return -1;
    }
    if (other.name !== '') return 1;
    if (this.idValid) {
      if (other.idValid) return C.compareNumber(this._id, other._id);
      return -1;
    }
    if (other.idValid) return 1;
    return 0;
  }

  /** What the column shows: the name if there is one, otherwise the raw id. */
  get displayText() {
    if (this.name !== '') return this.name;
    if (this.idValid) return String(this._id);
    return '';
  }

  get logText() { return `"${this.name}" [${this._id}]`; }
}

/** The server's user or group list, indexed by both name and id. */
class TRemoteTokenList {
  constructor() {
    this.tokens = [];
    this.nameMap = new Map();
    this.idMap = new Map();
  }

  duplicate() {
    const result = new TRemoteTokenList();
    for (const token of this.tokens) result.add(token.clone());
    return result;
  }

  clear() {
    this.tokens = [];
    this.nameMap.clear();
    this.idMap.clear();
  }

  add(token) {
    this.tokens.push(token);
    // std::map::insert keeps the FIRST entry for a duplicate key.
    if (token.idValid && !this.idMap.has(token.id)) this.idMap.set(token.id, this.tokens.length - 1);
    if (token.nameValid && !this.nameMap.has(token.name)) this.nameMap.set(token.name, this.tokens.length - 1);
  }

  /** A token with neither a name nor an id is dropped — winsshd/SFTP sends those. */
  addUnique(token) {
    if (token.idValid) {
      if (!this.idMap.has(token.id)) this.add(token);
    } else if (token.nameValid) {
      if (!this.nameMap.has(token.name)) this.add(token);
    }
  }

  exists(name) { return this.nameMap.has(name); }

  findById(id) {
    const index = this.idMap.get(id);
    return index === undefined ? null : this.tokens[index];
  }

  findByName(name) {
    const index = this.nameMap.get(name);
    return index === undefined ? null : this.tokens[index];
  }

  get count() { return this.tokens.length; }
  token(index) { return this.tokens[index]; }

  /** The lines the session log writes for a user or group list. */
  logLines(title) {
    if (this.tokens.length === 0) return [`No ${title} found.`];
    return [`Following ${title} found:`].concat(this.tokens.map((t) => '  ' + t.logText));
  }
}

// ---------------------------------------------------------------------------
// TRemoteFile
// ---------------------------------------------------------------------------

class ListLineError extends Error {
  constructor(line, cause) {
    super(`Unexpected directory listing line '${line}'.`);
    this.name = 'ListLineError';
    this.line = line;
    this.cause = cause;
  }
}

/** Delphi's StrToInt: strict, and a failure aborts the whole listing line. */
function strToIntStrict(s) {
  const t = C.trimBoth(s);
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`'${s}' is not a valid integer value`);
  return Number(t);
}

function tryStrToInt(s) {
  const t = C.trimBoth(s);
  if (!/^[+-]?\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * TRemoteFile — one entry in a remote directory.
 *
 * `terminal` here is not the whole session: it is the small context the file
 * genuinely needs — the login name, the group membership, whether the session
 * resolves symlinks, and the DST mode used when parsing a listing timestamp.
 */
class TRemoteFile {
  constructor(linkedByFile) {
    this.directory = null;
    this.owner = new TRemoteToken();
    this.group = new TRemoteToken();
    this.modificationFmt = MODIFICATION_FMT.FULL;
    this._size = 0;
    this.calculatedSize = -1;
    this.fileName = '';
    this.displayName = '';
    this.iNodeBlocks = 0;
    this.modification = 0;
    this.lastAccess = 0;
    this._iconIndex = -1;
    this.isSymLink = false;
    this.linkedFile = null;
    this.linkedByFile = linkedByFile || null;
    this.linkTo = '';
    this.rights = new TRights();
    this.humanRights = '';
    this.terminal = null;
    this._type = FILETYPE_DEFAULT;
    this.tags = '';
    this.cyclicLink = false;
    this._fullFileName = '';
    this._isHidden = -1;
    this.typeName = '';
    this.isEncrypted = false;
  }

  /**
   * A standalone duplicate carries its resolved full name, because it will
   * outlive the list that could have computed it.
   */
  duplicate(standalone) {
    const result = new TRemoteFile();
    if (this.linkedFile) {
      result.linkedFile = this.linkedFile.duplicate(true);
      result.linkedFile.linkedByFile = result;
    }
    result.rights = this.rights.clone();
    result.terminal = this.terminal;
    result.owner = this.owner.clone();
    result.group = this.group.clone();
    result.modificationFmt = this.modificationFmt;
    result._size = this._size;
    result.calculatedSize = this.calculatedSize;
    result.fileName = this.fileName;
    result.displayName = this.displayName;
    result.iNodeBlocks = this.iNodeBlocks;
    result.modification = this.modification;
    result.lastAccess = this.lastAccess;
    result._iconIndex = this._iconIndex;
    result.typeName = this.typeName;
    result.isSymLink = this.isSymLink;
    result.linkTo = this.linkTo;
    result._type = this._type;
    result.tags = this.tags;
    result.cyclicLink = this.cyclicLink;
    result.humanRights = this.humanRights;
    result.isEncrypted = this.isEncrypted;
    if (standalone !== false && (this._fullFileName !== '' || this.directory !== null)) {
      result._fullFileName = this.fullFileName;
    }
    return result;
  }

  /** A directory's own size is meaningless, so it reports zero. */
  get size() { return this.isDirectory ? 0 : this._size; }
  set size(value) { this._size = value; }

  get type() { return this._type; }
  set type(value) {
    this._type = value;
    this.isSymLink = String(value).toUpperCase() === FILETYPE_SYMLINK;
  }

  /** Follows the link when it is resolved — a link to a directory IS a directory. */
  get isDirectory() {
    if (this.isSymLink && this.linkedFile !== null) return this.linkedFile.isDirectory;
    return String(this._type).toUpperCase() === FILETYPE_DIRECTORY;
  }

  get isParentDirectory() { return this.fileName === C.PARENT_DIRECTORY; }
  get isThisDirectory() { return this.fileName === C.THIS_DIRECTORY; }

  get isHidden() {
    if (this._isHidden === 0) return false;
    if (this._isHidden === 1) return true;
    return isUnixHiddenFile(this.fileName);
  }

  set isHidden(value) { this._isHidden = value ? 1 : 0; }

  /**
   * A directory the logged-in user cannot enter, so the UI can grey it out
   * rather than let the user click into an error. Root may enter anything.
   *
   * The three execute bits are NOT tested the same way, and the asymmetry is
   * the original's: the "other" bit uses RightUndef != rsNo, so an UNDEFINED
   * bit still counts as possibly-executable, while the group and owner bits go
   * through Right[] which is true only for rsYes. A listing whose permission
   * column the server did not give us therefore stays accessible via "other"
   * rather than being greyed out wholesale.
   */
  get isInaccessibleDirectory() {
    if (!this.isDirectory) return false;
    const terminal = this.terminal || {};
    const userName = terminal.userName || '';
    const membership = terminal.membership;
    const memberOf = (name) => {
      if (!membership) return false;
      if (typeof membership.exists === 'function') return membership.exists(name);
      if (typeof membership.has === 'function') return membership.has(name);
      return Array.isArray(membership) && membership.indexOf(name) >= 0;
    };
    return !(
      sameUserName(userName, 'root') ||
      this.rights.getRightUndef(RIGHT.OtherExec) !== RIGHT_STATE.No ||
      (this.rights.getRight(RIGHT.GroupExec) && memberOf(this.group.name)) ||
      (this.rights.getRight(RIGHT.UserExec) && sameUserName(userName, this.owner.name))
    );
  }

  /**
   * A symlink we failed to follow. Only meaningful when the session resolves
   * symlinks at all — otherwise every link would look broken.
   */
  get brokenLink() {
    const resolving = this.terminal ? !!this.terminal.resolvingSymlinks : false;
    return this.isSymLink && (this.cyclicLink || !this.linkedFile) && resolving;
  }

  get extension() { return unixExtractFileExt(this.fileName); }

  get rightsStr() {
    // HumanRights is normally empty; a Perm-fact-only MLSD listing is the
    // exception, and then it is all we have.
    return this.rights.unknown ? this.humanRights : this.rights.text;
  }

  get modificationStr() { return modificationStr(this.modification, this.modificationFmt); }
  get userModificationStr() { return userModificationStr(this.modification, this.modificationFmt); }

  /** Setting a modification implies we know it exactly. */
  setModification(ms) {
    if (this.modification !== ms) {
      this.modificationFmt = MODIFICATION_FMT.FULL;
      this.modification = ms;
    }
  }

  isTimeShiftingApplicable() { return isTimeShiftingApplicable(this.modificationFmt); }

  /** Applies the session's manual time-shift to both timestamps at once. */
  shiftTimeInSeconds(seconds) {
    this.modification = shiftTimeInSeconds(this.modification, this.modificationFmt, seconds);
    this.lastAccess = shiftTimeInSeconds(this.lastAccess, this.modificationFmt, seconds);
  }

  /** Encrypted files carry a header the user should not see counted. */
  setEncrypted(overhead) {
    this.isEncrypted = true;
    const o = overhead === undefined ? 0 : overhead;
    if (this._size > o) this._size -= o;
  }

  /** The Windows attribute bits the drag-and-drop and shell integration need. */
  get attr() {
    let result = 0;
    if (this.rights.readOnly) result |= 0x00000001; // faReadOnly
    if (this.isHidden) result |= 0x00000002;        // faHidden
    return result;
  }

  get fullFileName() {
    if (this._fullFileName !== '') return this._fullFileName;
    if (this.directory === null) return '';
    if (this.isParentDirectory) return this.directory.parentPath;
    if (this.isDirectory) {
      return unixIncludeTrailingBackslash(this.directory.fullDirectory + this.fileName);
    }
    return this.directory.fullDirectory + this.fileName;
  }

  set fullFileName(value) { this._fullFileName = String(value); }

  get haveFullFileName() {
    return this._fullFileName !== '' || this.directory !== null;
  }

  /**
   * The icon index. WinSCP asks the Windows shell (SHGetFileInfo) for a real
   * icon; there is no such API here, so the classification the UI needs is
   * exposed instead and the renderer picks a Material icon from it.
   */
  get iconType() {
    if (this.isParentDirectory) return 'parent';
    if (this.isDirectory) return 'dir';
    if (this.isSymLink) return 'link';
    // The ".filepart" overlay is added on top of the underlying type, so the
    // partial suffix is stripped before classifying.
    const partial = getPartialFileExtLen(this.fileName);
    const name = partial > 0 ? this.fileName.slice(0, this.fileName.length - partial) : this.fileName;
    const ext = unixExtractFileExt(name);
    return ext ? 'ext:' + ext.slice(1).toLowerCase() : 'file';
  }

  get isPartial() { return getPartialFileExtLen(this.fileName) > 0; }

  /**
   * The `ls -l` line this file came from, regenerated. Used by the SCP backend
   * to echo a listing and by the log.
   */
  get listingStr() {
    const linkPart = this.isSymLink ? SYMLINK_STR + this.linkTo : '';
    const pad = (s, n) => String(s).padEnd(n, ' ');
    const padLeft = (s, n) => String(s).padStart(n, ' ');
    return `${this._type}${this.rights.text} ${padLeft(this.iNodeBlocks, 3)} ` +
      `${pad(this.owner.name, 8)} ${pad(this.group.name, 8)} ` +
      // Explicitly the raw size, even for a directory.
      `${padLeft(this._size, 9)} ${pad(this.modificationStr, 12)} ${this.fileName}${linkPart}`;
  }

  /**
   * Parse an `ls -l` line into this file. This is the single most defensive
   * routine in WinSCP, and every branch is a real server:
   *
   *  * MacOS appends '+', '@' or '.' to the permission column (sometimes after
   *    a space) for ACLs and extended attributes;
   *  * Android's BusyBox omits the link-count column entirely;
   *  * SSHFS prints 'd????????? ? ? ? ? ? name' when it cannot stat;
   *  * CygWin allows spaces in group names, so the group column is read until
   *    something parses as a size;
   *  * device nodes put 'major,' where the size would be, and the minor after;
   *  * `--full-time` has two different shapes, and the classic form's
   *    time-or-year field is a fixed six characters because the year may be
   *    left- or right-aligned and the separating space must not become part of
   *    the file name;
   *  * a listing without a year means "within the last twelve months", so a
   *    date in the future belongs to last year.
   *
   * A line that does not fit any of these throws ListLineError rather than
   * producing a plausible-looking wrong file.
   */
  setListingStr(value, options) {
    const opts = options || {};
    const nowMs = opts.now === undefined ? Date.now() : opts.now;
    const dstMode = opts.dstMode !== undefined ? opts.dstMode
      : (this.terminal && this.terminal.dstMode);
    let line = String(value);
    this._iconIndex = -1;

    try {
      let col = '';
      // Some servers separate columns with tabs.
      line = C.replaceChar(line, '\t', ' ');

      if (line.length === 0) throw new Error('empty line');
      this.type = line[0];
      line = line.slice(1);

      const getNCol = () => {
        if (line === '') throw new Error('unexpected end of line');
        const p = line.indexOf(' ');
        if (p >= 0) {
          col = line.slice(0, p);
          line = line.slice(p + 1);
        } else {
          col = line;
          line = '';
        }
      };
      const getCol = () => { getNCol(); line = C.trimLeft(line); };

      // The rights column may carry special bits (S, t) so undefined is allowed.
      this.rights.allowUndef = true;
      this.rights.text = line.slice(0, 9);
      line = line.slice(9);
      // ACL / extended attribute markers, with or without a leading space.
      if (line !== '' && (line[0] === '+' || line[0] === '@' || line[0] === '.')) {
        line = line.slice(1);
      } else if (line.length >= 2 && line[0] === ' ' &&
                 (line[1] === '+' || line[1] === '@' || line[1] === '.')) {
        line = line.slice(2);
      }
      line = C.trimLeft(line);

      getCol();
      const iNodeBlocks = tryStrToInt(col);
      if (iNodeBlocks === null) {
        // Not an integer: this system omits the column and we are already
        // looking at the owner (Android BusyBox).
        this.iNodeBlocks = 0;
      } else {
        this.iNodeBlocks = iNodeBlocks;
        getCol();
      }

      this.owner.name = col;

      // A group name may contain a space, so keep taking columns until one of
      // them parses as a size.
      this.group.name = '';
      getCol();
      let aSize = -1;
      do {
        this.group.name = this.group.name + col;
        getCol();
        if (this.group.name === '?' && col === '?') {
          aSize = 0;
        } else {
          // A device node has an extra 'major,' column; skip it.
          if (col.length > 0 && col[col.length - 1] === ',') getCol();
          const parsed = tryStrToInt(col);
          aSize = parsed === null ? -1 : parsed;
          if (aSize < 0) col = ' ' + col;
        }
      } while (aSize < 0);

      // The timestamp and name are only read when not already set, because
      // SCP fills them in from a separate source for the "file only" case.
      if (this.modification === 0) {
        let fullTime = false;
        let dayMonthFormat = false;
        let day = 0;
        let month = 0;
        let year = 0;
        let hour = 0;
        let min = 0;
        let sec = 0;

        getCol();
        if (col === '?') {
          getCol();
          this.modificationFmt = MODIFICATION_FMT.NONE;
          this.modification = 0;
          this.lastAccess = 0;
        } else {
          const col2Month = () => {
            for (let i = 0; i < 12; i++) {
              if (col.toLowerCase() === C.ENG_SHORT_MONTH_NAMES[i].toLowerCase()) {
                month = i + 1;
                return;
              }
            }
          };

          // 'dd mmm' or 'mmm dd'?
          const maybeDay = tryStrToInt(col);
          day = maybeDay === null ? 0 : maybeDay;
          if (day > 0) {
            dayMonthFormat = true;
            getCol();
          }
          month = 0;
          col2Month();

          if (month === 0 && col.length === 10 && col[4] === '-' && col[7] === '-') {
            // `--full-time`: yyyy-mm-dd hh:mm:ss.fffffffff +zzzz
            year = strToIntStrict(col.slice(0, 4));
            month = strToIntStrict(col.slice(5, 7));
            day = strToIntStrict(col.slice(8, 10));
            getCol();
            hour = strToIntStrict(col.slice(0, 2));
            min = strToIntStrict(col.slice(3, 5));
            sec = col.length >= 8 ? strToIntStrict(col.slice(6, 8)) : 0;
            this.modificationFmt = MODIFICATION_FMT.FULL;
            // Skip the time zone; do not trim the leading space of the name.
            getNCol();
          } else {
            if (month === 0) {
              // The other `--full-time`: 'ddd mmm dd hh:nn:ss yyyy'
              getCol();
              col2Month();
              if (month === 0) throw new Error('unrecognized month');
              fullTime = true;
            }

            if (day === 0) {
              getNCol();
              day = strToIntStrict(col);
            }
            if (day < 1 || day > 31) throw new Error('day out of range');

            if (fullTime) {
              getCol();
              if (col.length !== 8) throw new Error('bad full time');
              hour = strToIntStrict(col.slice(0, 2));
              min = strToIntStrict(col.slice(3, 5));
              sec = strToIntStrict(col.slice(6, 8));
              this.modificationFmt = MODIFICATION_FMT.FULL;
              getNCol();
              year = strToIntStrict(col);
            } else {
              if (dayMonthFormat) {
                getCol();
              } else {
                // The time-or-year field is exactly six characters wide; the
                // trailing space must go with it so a name starting with a
                // space survives.
                col = C.trimBoth(line.slice(0, 6));
                line = line.slice(6);
              }
              const p = col.indexOf(':');
              if (p >= 0) {
                hour = strToIntStrict(col.slice(0, p));
                min = strToIntStrict(col.slice(p + 1));
                if (hour > 23 || min > 59) throw new Error('time out of range');
                // No year: assume the current one, unless that would put the
                // file in the future, in which case it is last year.
                const now = new Date(nowMs);
                year = now.getFullYear();
                const currMonth = now.getMonth() + 1;
                const currDay = now.getDate();
                if (month > currMonth || (month === currMonth && day > currDay)) year--;
                sec = 0;
                this.modificationFmt = MODIFICATION_FMT.MDHM;
              } else {
                year = strToIntStrict(col);
                if (year > 10000) throw new Error('year out of range');
                hour = 0;
                min = 0;
                sec = 0;
                this.modificationFmt = MODIFICATION_FMT.MDY;
              }
            }
          }

          this.modification = new Date(year, month - 1, day, hour, min, sec, 0).getTime();
          // Only adjust when a time is actually known — shifting a default
          // midnight would be meaningless.
          if (this.modificationFmt === MODIFICATION_FMT.MDHM ||
              this.modificationFmt === MODIFICATION_FMT.FULL) {
            this.modification = C.adjustDateTimeFromUnix(this.modification, dstMode);
          }

          if (this.lastAccess === 0) this.lastAccess = this.modification;
        }

        // The separating space is already gone; any further space is part of
        // the name.
        if (this.fileName === '') {
          this._size = aSize;
          this.linkTo = '';
          if (this.isSymLink) {
            const p = line.indexOf(SYMLINK_STR);
            if (p >= 0) {
              this.linkTo = line.slice(p + SYMLINK_STR.length);
              line = line.slice(0, p);
            } else {
              throw new Error('symlink without a target');
            }
          }
          this.fileName = unixExtractFileName(line);
        }
      }
    } catch (e) {
      throw new ListLineError(value, e);
    }
    return this;
  }

  /**
   * Resolve this file's symlink through `resolver`, a function that returns a
   * TRemoteFile for a link target (the session's ReadSymlink). A resolver that
   * throws is reported, not propagated — a broken link must not abort the
   * whole listing.
   */
  findLinkedFile(resolver, onError) {
    this.linkedFile = null;
    this.cyclicLink = false;

    if (this.linkTo !== '') {
      // A cycle is any ancestor link pointing at the same target.
      let linkedBy = this.linkedByFile;
      while (linkedBy) {
        if (linkedBy.linkTo === this.linkTo) {
          this.cyclicLink = true;
          break;
        }
        linkedBy = linkedBy.linkedByFile;
      }
    }

    if (this.cyclicLink) {
      // Mark the whole chain, so none of them is followed again.
      let linkedBy = this.linkedByFile;
      while (linkedBy) {
        linkedBy.cyclicLink = true;
        linkedBy = linkedBy.linkedByFile;
      }
      return this;
    }

    try {
      const linked = resolver ? resolver(this) : null;
      if (linked && !(linked instanceof TRemoteFile)) {
        throw new TypeError('Symlink resolver returned an invalid remote file.');
      }
      if (linked) {
        linked.linkedByFile = this;
        linked.terminal = this.terminal;
        this.linkedFile = linked;
      }
    } catch (e) {
      if (typeof onError === 'function') onError(e);
    }
    return this;
  }

  /** Called once a listing entry is complete; only symlinks need more work. */
  complete(resolver, onError) {
    const resolving = this.terminal ? !!this.terminal.resolvingSymlinks : false;
    if (this.isSymLink && resolving) this.findLinkedFile(resolver, onError);
    return this;
  }

  /** Follows the whole chain to the file the link ultimately names. */
  resolve() {
    let result = this;
    const seen = new Set();
    while (result.linkedFile !== null && !seen.has(result)) {
      seen.add(result);
      result = result.linkedFile;
    }
    return result;
  }

  setTerminal(value) {
    this.terminal = value;
    if (this.linkedFile) this.linkedFile.setTerminal(value);
    return this;
  }
}

/** A directory entry created by hand rather than parsed — no timestamp at all. */
class TRemoteDirectoryFile extends TRemoteFile {
  constructor() {
    super();
    this.modification = 0;
    this.modificationFmt = MODIFICATION_FMT.NONE;
    this.lastAccess = 0;
    this.type = 'D';
  }
}

/** The '..' row the panel shows at the top of a listing. */
class TRemoteParentDirectory extends TRemoteDirectoryFile {
  constructor(terminal) {
    super();
    this.fileName = C.PARENT_DIRECTORY;
    this.terminal = terminal || null;
  }
}

// ---------------------------------------------------------------------------
// TRemoteFileList
// ---------------------------------------------------------------------------

/** Sortable columns, matching TUnixDirView's. */
const SORT_COLUMN = {
  Name: 'name', Size: 'size', Changed: 'changed', Rights: 'rights',
  Owner: 'owner', Group: 'group', Ext: 'ext', LinkTarget: 'linkTarget',
  Type: 'type',
};

function itemFileSize(file) {
  return file.calculatedSize >= 0 ? file.calculatedSize : file.size;
}

/**
 * The panel's sort. '..' always comes first and directories always come before
 * files — BEFORE the ascending flag is applied, so a descending sort does not
 * bury the parent entry at the bottom where nobody can find it. Every column
 * falls back to the name, so the order is total.
 */
function compareFiles(file1, file2, options) {
  const o = options || {};
  const natural = !!o.naturalOrderNumericalSorting;

  if (file1.isParentDirectory && !file2.isParentDirectory) return -1;
  if (!file1.isParentDirectory && file2.isParentDirectory) return 1;
  if (file1.isDirectory && !file2.isDirectory) return -1;
  if (!file1.isDirectory && file2.isDirectory) return 1;

  let result = 0;
  if (!(file1.isDirectory && o.alwaysSortDirectoriesByName)) {
    switch (o.sortColumn) {
      case SORT_COLUMN.Size:
        result = C.compareNumber(itemFileSize(file1), itemFileSize(file2));
        break;
      case SORT_COLUMN.Changed:
        result = C.compareNumber(file1.modification, file2.modification);
        break;
      case SORT_COLUMN.Rights:
        result = C.compareText(file1.rightsStr, file2.rightsStr);
        break;
      case SORT_COLUMN.Owner:
        result = file1.owner.compare(file2.owner);
        break;
      case SORT_COLUMN.Group:
        result = file1.group.compare(file2.group);
        break;
      case SORT_COLUMN.Ext:
        if (!file1.isDirectory) {
          result = C.compareLogicalText(file1.extension, file2.extension, natural);
        }
        break;
      case SORT_COLUMN.LinkTarget:
        result = C.compareLogicalText(file1.linkTo, file2.linkTo, natural);
        break;
      case SORT_COLUMN.Type:
        result = C.compareLogicalText(file1.typeName, file2.typeName, natural);
        if (result === 0 && !file1.isDirectory) {
          result = C.compareLogicalText(file1.extension, file2.extension, natural);
        }
        break;
      default:
        break;
    }
  }

  if (result === 0) {
    result = C.compareLogicalText(file1.fileName, file2.fileName, natural);
  }

  if (o.sortAscending === false) result = -result;
  return result;
}

/** A listing: the files, the directory they came from, and when it was read. */
class TRemoteFileList {
  constructor() {
    this.files = [];
    this._directory = '';
    this.timestamp = Date.now();
  }

  get count() { return this.files.length; }

  get directory() { return this._directory; }
  set directory(value) { this._directory = unixExcludeTrailingBackslash(value); }

  /** Always with a trailing slash, so a name can simply be appended. */
  get fullDirectory() { return unixIncludeTrailingBackslash(this._directory); }

  get isRoot() { return this._directory === ROOT_DIRECTORY; }

  get parentPath() { return unixExtractFilePath(this._directory); }

  get totalSize() {
    let result = 0;
    for (const file of this.files) result += file.size;
    return result;
  }

  addFile(file) {
    this.files.push(file);
    file.directory = this;
    return true;
  }

  /** Removes without destroying — the caller keeps the file. */
  extractFile(file) {
    const index = this.files.indexOf(file);
    if (index >= 0) this.files.splice(index, 1);
    file.directory = null;
    return file;
  }

  findFile(fileName) {
    for (const file of this.files) if (file.fileName === fileName) return file;
    return null;
  }

  reset() {
    this.timestamp = Date.now();
    // A reset releases the listing.  Keeping the old back-reference makes
    // removed entries continue to manufacture full names from a directory
    // they no longer belong to, and leaves hidden parent entries alive across
    // a refresh.
    for (const file of this.files) file.directory = null;
    this.files = [];
  }

  /** Copies are NOT standalone: they still resolve their name via the copy list. */
  duplicateTo(copy) {
    copy.reset();
    for (const file of this.files) copy.addFile(file.duplicate(false));
    copy._directory = this._directory;
    copy.timestamp = this.timestamp;
    return copy;
  }

  sort(options) {
    this.files.sort((a, b) => compareFiles(a, b, options));
    return this;
  }

  /**
   * The C++ passes selections around as a TStrings whose Objects are the
   * files; the equivalent here is a list of `{ name, file }`. Cloning is
   * needed because a selection outlives the listing it came from.
   */
  static cloneStrings(list) {
    return (list || []).map((item) => ({
      name: item.name,
      file: item.file ? item.file.duplicate(true) : null,
    }));
  }

  static anyDirectory(list) {
    for (const item of list || []) {
      const file = item && item.file ? item.file : item;
      if (file && file.isDirectory) return true;
    }
    return false;
  }
}

/**
 * A listing owned by a session. It drops the '.' entry outright and keeps the
 * '..' entry aside so it can be shown or hidden without re-reading the
 * directory — which is what the "show parent directory" preference toggles.
 */
class TRemoteDirectory extends TRemoteFileList {
  constructor(terminal, template) {
    super();
    this.terminal = terminal || null;
    this.parentDirectory = null;
    this._includeParentDirectory = template ? template._includeParentDirectory : true;
  }

  get includeParentDirectory() { return this._includeParentDirectory; }

  set includeParentDirectory(value) {
    if (this._includeParentDirectory !== value) {
      this._includeParentDirectory = value;
      if (this.parentDirectory !== null) {
        if (value) super.addFile(this.parentDirectory);
        else this.extractFile(this.parentDirectory);
      }
    }
  }

  /** Returns false for the '.' entry, which is dropped rather than listed. */
  addFile(file) {
    if (file.isThisDirectory) return false;
    if (file.isParentDirectory) this.parentDirectory = file;
    if (!file.isParentDirectory || this._includeParentDirectory) {
      super.addFile(file);
    }
    file.terminal = this.terminal;
    return true;
  }

  duplicateTo(copy) {
    super.duplicateTo(copy);
    if (this.parentDirectory !== null && !this._includeParentDirectory) {
      copy.addFile(this.parentDirectory.duplicate(false));
    }
    return copy;
  }

  reset() {
    if (this.parentDirectory !== null && this.parentDirectory.directory === this) {
      this.parentDirectory.directory = null;
    }
    this.parentDirectory = null;
    super.reset();
  }

  get loaded() {
    return this.terminal !== null && !!this.terminal.active && this._directory !== '';
  }
}

// ---------------------------------------------------------------------------
// caches
// ---------------------------------------------------------------------------

/**
 * The directory cache. Keyed by the path without its trailing slash, so '/a'
 * and '/a/' are the same entry; a returned list is always a duplicate, because
 * the caller will mutate it.
 */
class TRemoteDirectoryCache {
  constructor() {
    this.entries = new Map();
  }

  get isEmpty() { return this.entries.size === 0; }

  clear() { this.entries.clear(); }

  hasFileList(directory) {
    return this.entries.has(unixExcludeTrailingBackslash(directory));
  }

  /** Used to decide whether a cached listing is still worth trusting. */
  hasNewerFileList(directory, timestamp) {
    const list = this.entries.get(unixExcludeTrailingBackslash(directory));
    return !!list && list.timestamp > timestamp;
  }

  getFileList(directory, fileList) {
    const list = this.entries.get(unixExcludeTrailingBackslash(directory));
    if (!list) return false;
    list.duplicateTo(fileList);
    return true;
  }

  addFileList(fileList) {
    const copy = new TRemoteFileList();
    fileList.duplicateTo(copy);
    // The same directory can already be cached when a second connection read
    // it, so replace rather than duplicate.
    this.doClearFileList(fileList.directory, false);
    this.entries.set(copy.directory, copy);
  }

  clearFileList(directory, subDirs) {
    this.doClearFileList(directory, subDirs);
  }

  doClearFileList(directory, subDirs) {
    const dir = unixExcludeTrailingBackslash(directory);
    this.entries.delete(dir);
    if (subDirs) {
      const withSlash = unixIncludeTrailingBackslash(dir);
      for (const key of Array.from(this.entries.keys())) {
        if (unixIsChildPath(withSlash, key)) this.entries.delete(key);
      }
    }
  }
}

/**
 * The directory-CHANGES cache: remembers that "cd link" from /home landed in
 * /var/www, so the breadcrumb can go back up through a symlink instead of
 * resolving to the physical parent. It is an ordered name=value list with a
 * cap, and reading an entry moves it to the end, which is what keeps the cap
 * evicting the least recently used change.
 */
class TRemoteDirectoryChangesCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.items = [];
  }

  get isEmpty() { return this.items.length === 0; }

  clear() { this.items = []; }

  indexOfName(name) {
    for (let i = 0; i < this.items.length; i++) if (this.items[i].name === name) return i;
    return -1;
  }

  /**
   * Ported with two quirks of the VCL string list underneath it: an entry
   * already at position 0 is updated in place rather than moved to the end (so
   * the very first change never becomes the most recent one), and setting an
   * EMPTY value deletes the entry rather than storing a blank.
   */
  setValue(name, value) {
    const index = this.indexOfName(name);
    if (index > 0) this.items.splice(index, 1);
    const again = this.indexOfName(name);
    if (!value) {
      if (again >= 0) this.items.splice(again, 1);
      return;
    }
    if (again >= 0) this.items[again].value = value;
    else this.items.push({ name, value });
  }

  getValue(name) {
    const index = this.indexOfName(name);
    const value = index >= 0 ? this.items[index].value : '';
    this.setValue(name, value);
    return value;
  }

  static directoryChangeKey(sourceDir, change) {
    if (!change) return { ok: false, key: '' };
    const absolute = unixIsAbsolutePath(change);
    if (!sourceDir && !absolute) return { ok: false, key: '' };
    return { ok: true, key: absolute ? change : sourceDir + ',' + change };
  }

  addDirectoryChange(sourceDir, change, targetDir) {
    if (!targetDir) return;
    // '//' marks "this path is a known destination", distinct from a mapping.
    this.setValue(targetDir, '//');
    if (absolutePath(sourceDir, change) !== targetDir) {
      const k = TRemoteDirectoryChangesCache.directoryChangeKey(sourceDir, change);
      if (k.ok) this.setValue(k.key, targetDir);
    }
  }

  clearDirectoryChange(sourceDir) {
    for (let index = 0; index < this.items.length; index++) {
      if (this.items[index].name.slice(0, sourceDir.length) === sourceDir) {
        this.items.splice(index, 1);
        index--;
      }
    }
  }

  /** Also clears the symlink's own key, so deleting a link forgets where it went. */
  clearDirectoryChangeTarget(targetDir) {
    const k = TRemoteDirectoryChangesCache.directoryChangeKey(
      unixExcludeTrailingBackslash(unixExtractFilePath(targetDir)),
      unixExtractFileName(targetDir));
    const key = k.ok ? k.key : '';
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (item.name.slice(0, targetDir.length) === targetDir ||
          item.value.slice(0, targetDir.length) === targetDir ||
          (key !== '' && item.name === key)) {
        this.items.splice(index, 1);
        index--;
      }
    }
  }

  getDirectoryChange(sourceDir, change) {
    let key = absolutePath(sourceDir, change);
    if (this.indexOfName(key) >= 0) {
      let targetDir = this.getValue(key);
      // Only a full path to a symbolic link stores something other than '//'.
      if (targetDir === '//') targetDir = key;
      return { ok: true, targetDir };
    }
    const k = TRemoteDirectoryChangesCache.directoryChangeKey(sourceDir, change);
    if (!k.ok) return { ok: false, targetDir: '' };
    key = k.key;
    const directory = this.getValue(key);
    if (!directory) return { ok: false, targetDir: '' };
    return { ok: true, targetDir: directory };
  }

  /** 'A' is a format marker; only the most recent maxSize entries are kept. */
  serialize() {
    let data = 'A';
    const items = this.items.length > this.maxSize
      ? this.items.slice(this.items.length - this.maxSize) : this.items;
    for (const item of items) data += `${item.name}=${item.value}\n`;
    return data;
  }

  deserialize(data) {
    this.items = [];
    if (!data) return this;
    for (const line of String(data).slice(1).split('\n')) {
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      this.items.push({ name: line.slice(0, eq), value: line.slice(eq + 1) });
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// TRemoteProperties
// ---------------------------------------------------------------------------

/** Which fields of a properties change the user actually touched. */
const VALID_PROPERTY = {
  Rights: 'rights', Group: 'group', Owner: 'owner',
  Modification: 'modification', LastAccess: 'lastAccess',
  Encrypt: 'encrypt', Tags: 'tags',
};

/**
 * The properties a change request carries. `valid` is the whole point: a field
 * that is not in it is NOT sent to the server, so a multi-file change that
 * only touched the group does not also rewrite everyone's permissions.
 */
class TRemoteProperties {
  constructor(source) {
    this.default();
    if (source) {
      this.valid = new Set(source.valid);
      this.recursive = source.recursive;
      this.rights = source.rights.clone();
      this.addXToDirectories = source.addXToDirectories;
      this.group = source.group.clone();
      this.owner = source.owner.clone();
      this.modification = source.modification;
      // Ported faithfully: the copy constructor really does initialise
      // LastAccess from rhp.Modification. Anything depending on LastAccess
      // after a copy sees the modification time.
      this.lastAccess = source.modification;
      this.encrypt = source.encrypt;
      this.tags = source.tags;
    }
  }

  default() {
    this.valid = new Set();
    this.addXToDirectories = false;
    this.rights = new TRights();
    this.rights.allowUndef = false;
    this.rights.number = 0;
    this.group = new TRemoteToken();
    this.owner = new TRemoteToken();
    this.recursive = false;
    this.encrypt = false;
    this.tags = '';
    this.modification = 0;
    this.lastAccess = 0;
    return this;
  }

  equals(other) {
    if (this.valid.size !== other.valid.size) return false;
    for (const v of this.valid) if (!other.valid.has(v)) return false;
    if (this.recursive !== other.recursive) return false;
    if (this.valid.has(VALID_PROPERTY.Rights) &&
        (!this.rights.equals(other.rights) || this.addXToDirectories !== other.addXToDirectories)) {
      return false;
    }
    if (this.valid.has(VALID_PROPERTY.Owner) && !this.owner.equals(other.owner)) return false;
    if (this.valid.has(VALID_PROPERTY.Group) && !this.group.equals(other.group)) return false;
    if (this.valid.has(VALID_PROPERTY.Modification) && this.modification !== other.modification) return false;
    if (this.valid.has(VALID_PROPERTY.LastAccess) && this.lastAccess !== other.lastAccess) return false;
    if (this.valid.has(VALID_PROPERTY.Encrypt) && this.encrypt !== other.encrypt) return false;
    if (this.valid.has(VALID_PROPERTY.Tags) && this.tags !== other.tags) return false;
    return true;
  }

  /**
   * What the properties dialog shows for a multi-file selection: the first
   * file seeds the values, every later file intersects them. A field the files
   * disagree about drops out of `valid` entirely, and permission BITS they
   * disagree about become undefined rather than the dialog picking a winner.
   */
  static commonProperties(files) {
    const common = new TRemoteProperties();
    let index = 0;
    for (const item of files || []) {
      const file = item && item.file ? item.file : item;
      if (index === 0) {
        if (!file.rights.unknown) {
          common.rights = file.rights.clone();
          // Undefined is allowed only where the file itself already had
          // undefined bits; the dialog enables it explicitly otherwise, and
          // only together with "recursive".
          common.rights.allowUndef = file.rights.isUndef;
          common.valid.add(VALID_PROPERTY.Rights);
        }
        if (file.owner.isSet) {
          common.owner = file.owner.clone();
          common.valid.add(VALID_PROPERTY.Owner);
        }
        if (file.group.isSet) {
          common.group = file.group.clone();
          common.valid.add(VALID_PROPERTY.Group);
        }
        common.tags = file.tags;
        common.valid.add(VALID_PROPERTY.Tags);
      } else {
        common.rights.allowUndef = true;
        common.rights.andAssign(file.rights);
        if (!common.owner.equals(file.owner)) {
          common.owner.clear();
          common.valid.delete(VALID_PROPERTY.Owner);
        }
        if (!common.group.equals(file.group)) {
          common.group.clear();
          common.valid.delete(VALID_PROPERTY.Group);
        }
        if (common.tags !== file.tags) {
          common.tags = '';
          common.valid.delete(VALID_PROPERTY.Tags);
        }
      }
      index++;
    }
    return common;
  }

  /**
   * What actually needs sending: a field the user did not change drops out.
   * A recursive change sends everything, because the subdirectories have not
   * been inspected and may well differ.
   */
  static changedProperties(originalProperties, newProperties) {
    // The C++ takes NewProperties by value, so the copy constructor's
    // LastAccess-from-Modification quirk applies here too. Harmless today
    // because nothing ever puts LastAccess into `valid`, but reproduced rather
    // than quietly corrected.
    const result = new TRemoteProperties(newProperties);
    if (!result.recursive) {
      if (result.rights.equals(originalProperties.rights) && !result.addXToDirectories) {
        result.valid.delete(VALID_PROPERTY.Rights);
      }
      if (result.group.equals(originalProperties.group)) {
        result.valid.delete(VALID_PROPERTY.Group);
      }
      if (result.owner.equals(originalProperties.owner)) {
        result.valid.delete(VALID_PROPERTY.Owner);
      }
      if (result.tags === originalProperties.tags) {
        result.valid.delete(VALID_PROPERTY.Tags);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// TSynchronizeChecklist
// ---------------------------------------------------------------------------

/**
 * The six things synchronization can decide to do about one name, plus "leave
 * it alone". New and Update are separate actions because they mean different
 * things to the user: one creates a file, the other overwrites an existing one,
 * and the confirmation, the overwrite rules and the reversal all differ.
 */
const SYNC_ACTION = {
  None: 0,
  UploadNew: 1,
  DownloadNew: 2,
  UploadUpdate: 3,
  DownloadUpdate: 4,
  DeleteRemote: 5,
  DeleteLocal: 6,
};
const SYNC_ACTION_COUNT = SYNC_ACTION.DeleteLocal;

/** Deleting says nothing about how much data moves, so its size is irrelevant. */
function isItemSizeIrrelevant(action) {
  return action === SYNC_ACTION.None ||
    action === SYNC_ACTION.DeleteRemote ||
    action === SYNC_ACTION.DeleteLocal;
}

/**
 * The mirror of an action, used by the "reverse" button in the checklist: the
 * opposite of "upload this new file" is "delete it locally", not "download it"
 * — there is nothing on the other side to download.
 */
function reverseSyncAction(action) {
  switch (action) {
    case SYNC_ACTION.UploadNew: return SYNC_ACTION.DeleteLocal;
    case SYNC_ACTION.DownloadNew: return SYNC_ACTION.DeleteRemote;
    case SYNC_ACTION.UploadUpdate: return SYNC_ACTION.DownloadUpdate;
    case SYNC_ACTION.DownloadUpdate: return SYNC_ACTION.UploadUpdate;
    case SYNC_ACTION.DeleteRemote: return SYNC_ACTION.DownloadNew;
    case SYNC_ACTION.DeleteLocal: return SYNC_ACTION.UploadNew;
    default: return SYNC_ACTION.None;
  }
}

/**
 * One row of the comparison checklist. `info1` is the local side and `info2`
 * the remote one; a row exists on one side only when the other's file name is
 * empty, which is what `isLocalOnly` / `isRemoteOnly` really test.
 */
class TSynchronizeChecklistItem {
  constructor() {
    this.action = SYNC_ACTION.None;
    this.isDirectory = false;
    this.info1 = {
      fileName: '', directory: '', modification: 0,
      modificationFmt: MODIFICATION_FMT.FULL, size: 0,
    };
    this.info2 = {
      fileName: '', directory: '', modification: 0,
      modificationFmt: MODIFICATION_FMT.FULL, size: 0,
    };
    this.imageIndex = -1;
    this.checked = true;
    this.remoteFile = null;
    this.directoryHasSize = false;
  }

  /** The remote name wins when both exist, because that is the one displayed. */
  getFileName() {
    return this.info2.fileName !== '' ? this.info2.fileName : this.info1.fileName;
  }

  isRemoteOnly() {
    return this.action === SYNC_ACTION.DownloadNew || this.action === SYNC_ACTION.DeleteRemote;
  }

  isLocalOnly() {
    return this.action === SYNC_ACTION.UploadNew || this.action === SYNC_ACTION.DeleteLocal;
  }

  /** A directory has no size until something has walked it. */
  hasSize() { return !this.isDirectory || this.directoryHasSize; }

  getBaseSize(action) {
    const a = action === undefined ? this.action : action;
    switch (a) {
      case SYNC_ACTION.UploadNew:
      case SYNC_ACTION.UploadUpdate:
      case SYNC_ACTION.DeleteLocal:
        return this.info1.size;
      case SYNC_ACTION.DownloadNew:
      case SYNC_ACTION.DownloadUpdate:
      case SYNC_ACTION.DeleteRemote:
        return this.info2.size;
      default:
        return 0;
    }
  }

  getSize(action) {
    const a = action === undefined ? this.action : action;
    return isItemSizeIrrelevant(a) ? 0 : this.getBaseSize(a);
  }

  getLocalPath() { return C.combinePaths(this.info1.directory, this.info1.fileName); }
  getLocalPath2() { return C.combinePaths(this.info2.directory, this.info2.fileName); }

  /** The "force" variants borrow the other side's name for a row that has none. */
  forceGetLocalPath() {
    return C.combinePaths(this.info1.directory, C.defaultStr(this.info1.fileName, this.info2.fileName));
  }

  forceGetLocalPath2() {
    return C.combinePaths(this.info2.directory, C.defaultStr(this.info2.fileName, this.info1.fileName));
  }

  /** No trailing slash, even for a directory — unlike TRemoteFile.fullFileName. */
  getRemotePath() { return unixCombinePaths(this.info2.directory, this.info2.fileName); }
  forceGetRemotePath() { return unixCombinePaths(this.info2.directory, this.getFileName()); }

  getLocalTarget() { return C.includeTrailingBackslash(this.info1.directory); }
  getLocalTarget2() { return C.includeTrailingBackslash(this.info2.directory); }
  getRemoteTarget() { return unixIncludeTrailingBackslash(this.info2.directory); }
}

/**
 * The comparison result the synchronize dialog shows and the user edits before
 * anything is transferred. Items sort by directory then by name, so a listing
 * of thousands of files reads as a tree walk rather than an arbitrary order.
 */
class TSynchronizeChecklist {
  constructor() {
    this.list = [];
  }

  get count() { return this.list.length; }

  add(item) { this.list.push(item); return item; }

  item(index) { return this.list[index]; }

  get checkedCount() {
    let result = 0;
    for (const item of this.list) if (item.checked) result++;
    return result;
  }

  static compare(item1, item2) {
    if (item1 === item2) return 0;
    let result;
    if (item1.info1.directory !== '') {
      result = item1.info1.directory === item2.info1.directory
        ? 0 : C.compareText(item1.info1.directory, item2.info1.directory);
    } else {
      result = item1.info2.directory === item2.info2.directory
        ? 0 : C.compareText(item1.info2.directory, item2.info2.directory);
    }
    if (result === 0) result = C.compareText(item1.getFileName(), item2.getFileName());
    return result;
  }

  /**
   * A checklist is usually produced almost sorted, and a quick sort is at its
   * worst on nearly sorted input, so a linear pass checks first.
   */
  sort() {
    const c = this.list.length;
    if (c === 0) return this;
    let sorted = true;
    for (let index = 1; index < c && sorted; index++) {
      if (TSynchronizeChecklist.compare(this.list[index - 1], this.list[index]) > 0) sorted = false;
    }
    if (!sorted) this.list.sort(TSynchronizeChecklist.compare);
    return this;
  }

  update(item, check, action) {
    item.checked = check;
    item.action = action;
    return item;
  }

  delete(item) {
    const index = this.list.indexOf(item);
    if (index >= 0) this.list.splice(index, 1);
    return item;
  }

  /** Records a directory's calculated size on whichever side actually has it. */
  updateDirectorySize(item, size) {
    if (!item.isDirectory) return item;
    item.directoryHasSize = true;
    if (item.isRemoteOnly()) item.info2.size = size;
    else if (item.isLocalOnly()) item.info1.size = size;
    // "Update" actions never apply to directories, so there is no third case.
    return item;
  }

  /** Iterates the checked items; returns null once there are no more. */
  getNextChecked(index) {
    let i = index;
    while (i < this.list.length) {
      const item = this.list[i];
      i++;
      if (item.checked) return { index: i, item };
    }
    return { index: i, item: null };
  }

  checkedItems() {
    return this.list.filter((item) => item.checked);
  }
}

/**
 * Progress across a whole synchronization. A delete has no bytes to move, so a
 * run of deletions would otherwise sit at 0% and then jump to 100%: each one is
 * charged a nominal 100 KB (1 MB for a directory) so the bar advances honestly
 * in proportion to the work remaining.
 */
class TSynchronizeProgress {
  constructor(checklist) {
    this.checklist = checklist;
    this.totalSize = -1;
    this.processedSize = 0;
  }

  itemSize(item) {
    switch (item.action) {
      case SYNC_ACTION.DeleteRemote:
      case SYNC_ACTION.DeleteLocal:
        return item.isDirectory ? 1024 * 1024 : 100 * 1024;
      default:
        return item.hasSize() ? item.getSize() : 1024 * 1024;
    }
  }

  itemProcessed(item) {
    this.processedSize += this.itemSize(item);
  }

  /**
   * The total is computed on the first call rather than in the constructor,
   * because directory sizes are usually still being calculated when the
   * checklist is created.
   */
  getProcessed(currentItemTransferred) {
    if (this.totalSize < 0) {
      this.totalSize = 0;
      for (const item of this.checklist.checkedItems()) {
        this.totalSize += this.itemSize(item);
      }
    }
    return this.processedSize + (currentItemTransferred || 0);
  }

  /** -1 for an operation whose progress cannot be known. */
  progress(currentItemTransferred, indeterminate) {
    if (indeterminate) return -1;
    const processed = this.getProcessed(currentItemTransferred);
    if (this.totalSize > 0) return Math.trunc((processed * 100) / this.totalSize);
    return 0;
  }

  /** Milliseconds remaining, extrapolated from the rate so far. */
  timeLeft(nowMs, startTimeMs, currentItemTransferred) {
    const processed = this.getProcessed(currentItemTransferred);
    if (processed <= 0) return 0;
    return ((nowMs - startTimeMs) / processed) * (this.totalSize - processed);
  }
}

module.exports = {
  // constants
  SYMLINK_STR, ROOT_DIRECTORY, FILETYPE_DEFAULT, FILETYPE_SYMLINK,
  FILETYPE_DIRECTORY, PARTIAL_EXT, MODIFICATION_FMT, SORT_COLUMN,
  RIGHT, RIGHT_GROUP, RIGHT_LEVEL, RIGHT_STATE, FLAG,
  BASIC_SYMBOLS, COMBINED_SYMBOLS, EXTENDED_SYMBOLS, MODE_GROUPS,
  UNDEF_SYMBOL, UNSET_SYMBOL, UNSET_SYMBOL_WIN, TEXT_LEN,
  VALID_PROPERTY,
  // paths
  isUnixStyleWindowsPath, unixIsAbsolutePath, unixIncludeTrailingBackslash,
  unixExcludeTrailingBackslash, simpleUnixExcludeTrailingBackslash,
  universalIncludeTrailingBackslash, universalExcludeTrailingBackslash,
  unixCombinePaths, unixCombinePathsForce, unixCombinePathsSmart,
  universalCombinePaths, unixSamePath, unixIsChildPath, unixExtractFileDir,
  unixExtractFilePath, unixExtractFileName, unixExtractFileExt,
  extractFileName, extractShortName, extractCommonPath, unixExtractCommonPath,
  isUnixRootPath, isUnixHiddenFile, absolutePath, fromUnixPath, toUnixPath,
  cutFirstDirectory, minimizeName, makeFileList, trimVmsVersion, hasVmsVersion,
  formatMultiFilesToOneConfirmation,
  // timestamps
  reduceDateTimePrecision, lessDateTimePrecision, compareModification,
  sameModification, modificationStr, userModificationStr,
  isTimeShiftingApplicable, shiftTimeInSeconds,
  // files
  getPartialFileExtLen, sameUserName, ownerName, fileTypeName, compareFiles,
  // classes
  TRights, RightsError, TRemoteToken, TRemoteTokenList, TRemoteFile,
  TRemoteDirectoryFile, TRemoteParentDirectory, TRemoteFileList,
  TRemoteDirectory, TRemoteDirectoryCache, TRemoteDirectoryChangesCache,
  TRemoteProperties, ListLineError,
  // synchronization checklist
  SYNC_ACTION, SYNC_ACTION_COUNT, isItemSizeIrrelevant, reverseSyncAction,
  TSynchronizeChecklistItem, TSynchronizeChecklist, TSynchronizeProgress,
};
