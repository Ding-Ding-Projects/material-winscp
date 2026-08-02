// script.js — WinSCP's scripting engine.
//
// This is a port of `core/Script.cpp` (TOptions / TScriptProcParams /
// TScriptCommands / TScript / TManagementScript) plus the option parser in
// `core/Option.cpp` and the tokenizer `DoCutToken` from `core/Common.cpp`.
//
// Three things about it are load-bearing and are ported literally rather than
// "improved", because scripts written against WinSCP depend on them:
//
//   1. **The tokenizer.** `"` toggles quoting, `""` is a literal quote, and a
//      token ends at the first unquoted space or tab. Everything a user types
//      into a `.txt` script goes through it, so a "cleaner" shell-style parser
//      would silently change the meaning of thousands of existing scripts.
//   2. **Switch detection.** A token is a switch only when it starts with a
//      switch mark AND every character up to the value delimiter is a letter,
//      `?`, or (for `--x`) a dash. `TScriptProcParams` additionally drops `/`
//      from the switch marks, which is the only reason `cd /home/martin` works
//      inside a script while `/home/martin` on the command line is a switch.
//   3. **Command resolution by unique prefix.** `synchr` runs `synchronize`,
//      `l` is ambiguous (lcd/lls/lpwd) and is refused by name, and an unknown
//      command is an error rather than a no-op.
//
// What the C++ calls a TTerminal is represented here by a small facade over an
// Adapter (see `ScriptTerminal`): the script never talks to a protocol
// directly, and it never reimplements a transfer — `get`, `put`, `cp` and
// `synchronize` all go through the existing TransferQueue and sync engine.
'use strict';

const nodePath = require('path');
const fs = require('fs');

const { isEffectiveFileNameMask, FileMask } = require('./masks');
const { COPY_PARAM_DEFAULTS } = require('./defaults');
// The port numbers are TSessionData's own constants; `sessiondata.js` is the
// port of that file and owns them, so the scripting surface reads them rather
// than carrying a second set that can drift.
const { FTP_PORT, FTPS_IMPLICIT_PORT } = require('./sessiondata');

// ---------------------------------------------------------------------------
// messages — transcribed from resource/TextsCore1.rc and TextsCore2.rc
// ---------------------------------------------------------------------------

const MSG = {
  COMMAND_UNKNOWN: (c) => `Unknown command '${c}'.`,
  COMMAND_AMBIGUOUS: (c, m) => `Ambiguous command '${c}'. Possible matches are: ${m}`,
  MISSING_PARAMS: (c) => `Missing parameter for command '${c}'.`,
  TOO_MANY_PARAMS: (c) => `Too many parameters for command '${c}'.`,
  UNKNOWN_SWITCH: (s) => `Unknown switch '${s}'.`,
  NO_SESSION: 'No session.',
  SESSION_INDEX_INVALID: (i) => `Invalid session number '${i}'.`,
  OPTION_UNKNOWN: (o) => `Unknown option '${o}'.`,
  VALUE_UNKNOWN: (v, o) => `Unknown value '${v}' of option '${o}'.`,
  MATCH_NO_MATCH: (m) => `No file matching '${m}' found.`,
  NOT_FILE_ERROR: (f) => `'${f}' is not file!`,
  FILE_NOT_EXISTS: (f) => `File or folder '${f}' does not exist.`,
  CHANGE_DIR_ERROR: (d) => `Error changing directory to '${d}'.`,
  MOVE_FILE_ERROR: (f, t) => `Error moving file '${f}' to '${t}'.`,
  COPY_FILE_ERROR: (f, t) => `Error copying file '${f}' to '${t}'.`,
  NOTSUPPORTED: 'Operation not supported.',
  CANNOT_OPEN_SESSION_FOLDER: 'Cannot open site folder or workspace.',
  STREAM_IN_SCRIPT_ERROR:
    'When uploading streamed data, only one source can be specified and the target must specify a filename.',
  AMBIGUOUS_SLASH_IN_PATH:
    'Selecting files using a path ending with slash is ambiguous. Remove the slash to select the folder. '
    + 'Append * mask to select all files in the folder.',
  ACTIVE_SESSION: (i, n) => `Active session: [${i}] ${n}`,
  SESSION_CLOSED: (n) => `Session '${n}' closed.`,
  SYNCHRONIZE: (l, a, r) => `Local '${l}' ${a} Remote '${r}'`,
  SYNCHRONIZE_DELETED: (f) => `'${f}' deleted`,
  KEEPING_UP_TO_DATE: 'Watching for changes, press Ctrl-C to abort...',
  SYNCHRONIZE_COLLECTING: 'Comparing...',
  SYNCHRONIZE_SYNCHRONIZING: 'Synchronizing...',
  SYNCHRONIZE_NODIFFERENCE: 'Nothing to synchronize.',
  SYNCHRONIZE_CHECKLIST: 'Differences found:',
  SYNC_UPLOAD_NEW: (l) => `New local file ${l}`,
  SYNC_DOWNLOAD_NEW: (r) => `New remote file ${r}`,
  SYNC_UPLOAD_UPDATE: (l, r) => `Local file ${l} newer than remote file ${r}`,
  SYNC_DOWNLOAD_UPDATE: (r, l) => `Remote file ${r} newer than local file ${l}`,
  SYNC_DELETE_REMOTE: (r) => `Orphan remote file ${r}`,
  SYNC_DELETE_LOCAL: (l) => `Orphan local file ${l}`,
  NON_DEFAULT_COPY_PARAM: 'Using configured transfer settings different from factory defaults.',
  NON_DEFAULT_SYNC_PARAM: 'Using configured synchronization options different from factory defaults.',
  FILEMASK_INCLUDE_EXCLUDE: 'Switch -filemask overrides obsolete options include/exclude.',
  HOST_PROMPT: 'Host: ',
  SITE_WARNING: 'In scripting you should not rely on saved sites, use this command instead:',
  CMDLINE_SESSION:
    "Opening session using command-line parameter in scripting is deprecated. Use 'open' command instead.",
  CMDLINE_PARAMETERS:
    'Scripting does not use standalone parameters. The parameters you have specified on command-line '
    + 'will not be used. Your command-line syntax is probably wrong.',
  USER_TERMINATED: 'Terminated by user.',
  // WinSCP's own wording (TextsCore1.rc, MULTI_FILES_TO_ONE), flattened from a
  // confirmation dialog into a scripted warning. The trailing-slash hint is the
  // useful half: this message almost always means the user meant a directory.
  MULTI_FILES_TO_ONE: (t) =>
    `Warning: transferring multiple files to a single file '${t}'. The files will `
    + 'overwrite one another. If you meant to transfer them into a directory, '
    + 'keeping their names, terminate the path with a slash.',
};

// ---------------------------------------------------------------------------
// tokenizer — DoCutToken (core/Common.cpp)
// ---------------------------------------------------------------------------

/**
 * Cut the first token off `str`.
 *
 * `escapeQuotesInQuotesOnly` mirrors CutTokenEx: with it, `""` outside quotes
 * means an empty string; without it (the plain CutToken the script parser uses)
 * `""` always means a literal quote character.
 *
 * @returns {{ok:boolean, token:string, rest:string, raw:string, separator:string}}
 */
function cutToken(str, escapeQuotesInQuotesOnly = false) {
  const s = str === undefined || str === null ? '' : String(str);
  let token = '';
  let i = 0;

  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= s.length) return { ok: false, token: '', rest: '', raw: '', separator: '' };

  let quoting = false;
  while (i < s.length) {
    const c = s[i];
    if (!quoting && (c === ' ' || c === '\t')) break;
    if (c === '"' && i + 1 < s.length && s[i + 1] === '"'
        && (!escapeQuotesInQuotesOnly || quoting)) {
      i += 2;
      token += '"';
    } else if (c === '"') {
      i++;
      quoting = !quoting;
    } else {
      token += c;
      i++;
    }
  }

  const raw = s.slice(0, i);
  let separator = '';
  if (i < s.length) { separator = s[i]; i++; }
  return { ok: true, token, rest: s.slice(i), raw, separator };
}

/** Split a whole command line into tokens (TOptions::Parse). */
function tokenize(cmdLine) {
  const out = [];
  let rest = cmdLine;
  for (;;) {
    const t = cutToken(rest);
    if (!t.ok) break;
    out.push(t.token);
    rest = t.rest;
  }
  return out;
}

/** AddQuotes: quote only when the value contains a space, as the C++ does. */
function addQuotes(s) {
  const str = String(s === undefined || s === null ? '' : s);
  return str.includes(' ') ? `"${str}"` : str;
}

// ---------------------------------------------------------------------------
// file-name masks — MaskFilePart / MaskFileName / IsFileNameMask
// ---------------------------------------------------------------------------

/**
 * MaskFilePart. `*` consumes the rest of the part, `?` consumes one character,
 * `\` escapes the next character, and anything else is literal (and eats one
 * character of the source, which is why `mv a.txt b.txt` renames rather than
 * appends).
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

/** MaskFileName: apply an operation mask such as `*.bak` to one file name. */
function maskFileName(fileName, mask) {
  if (!isEffectiveFileNameMask(mask || '')) return fileName;
  const p = mask.lastIndexOf('.');
  if (p >= 0) {
    const p2 = fileName.lastIndexOf('.');
    // A dot at position 0 is part of the name (".htaccess"), not a separator.
    let ext = p2 > 0 ? fileName.slice(p2 + 1) : '';
    ext = maskFilePart(ext, mask.slice(p + 1)).result;
    let base = p2 > 0 ? fileName.slice(0, p2) : fileName;
    base = maskFilePart(base, mask.slice(0, p)).result;
    return ext !== '' ? `${base}.${ext}` : base;
  }
  return maskFilePart(fileName, mask).result;
}

/** IsFileNameMask: does the mask actually vary with the input? */
function isFileNameMask(mask) {
  if (!mask) return true;               // an empty mask is the same as `*`
  return maskFilePart('', mask).masked;
}

// ---------------------------------------------------------------------------
// path helpers — the unix half of core/RemoteFiles.cpp
// ---------------------------------------------------------------------------

function unixExcludeTrailingSlash(p) {
  if (!p || p === '/' || !p.endsWith('/')) return p;
  return p.slice(0, -1);
}

function unixIncludeTrailingSlash(p) {
  if (!p) return '/';
  return p.endsWith('/') ? p : `${p}/`;
}

/** UnixExtractFilePath — includes the trailing slash, or '' when there is none. */
function unixExtractFilePath(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

function unixExtractFileName(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function winExcludeTrailingSlash(p) {
  if (!p) return p;
  if (/^[A-Za-z]:[\\/]$/.test(p) || p === '\\' || p === '/') return p;
  return /[\\/]$/.test(p) ? p.slice(0, -1) : p;
}

function localExtractFilePath(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(0, i + 1) : '';
}

function localExtractFileName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function isRealFile(name) { return name !== '.' && name !== '..'; }

// ---------------------------------------------------------------------------
// TOptions
// ---------------------------------------------------------------------------

const ARRAY_VALUE_DELIMITER = '[';
const ARRAY_VALUE_END = ']';

function isLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/** A parsed command line: an ordered mix of switches and positional params. */
class Options {
  constructor(source) {
    this.switchMarks = source ? source.switchMarks : '/-';
    this.switchValueDelimiters = source ? source.switchValueDelimiters : `=:${ARRAY_VALUE_DELIMITER}`;
    this.options = source ? source.options.map((o) => ({ ...o })) : [];
    this.originalOptions = source ? source.originalOptions.map((o) => ({ ...o })) : [];
    this.noMoreSwitches = source ? source.noMoreSwitches : false;
    this.paramCount = source ? source.paramCount : 0;
  }

  clone() { return new Options(this); }

  parse(cmdLine) {
    for (const token of tokenize(cmdLine)) this.add(token);
    return this;
  }

  add(value) {
    const v = String(value === undefined || value === null ? '' : value);

    // `--` (or `//`) ends switch processing: everything after it is a parameter.
    if (!this.noMoreSwitches && v.length === 2 && v[0] === v[1]
        && this.switchMarks.includes(v[0])) {
      this.noMoreSwitches = true;
      this.originalOptions = this.options.map((o) => ({ ...o }));
      return;
    }

    let isSwitch = false;
    let idx = 0;
    let switchMark = '';
    let valueDelimiter = '';

    if (!this.noMoreSwitches && v.length >= 2 && this.switchMarks.includes(v[0])) {
      idx = 1;
      isSwitch = true;
      switchMark = v[0];
      while (isSwitch && idx < v.length) {
        const c = v[idx];
        if (this.switchValueDelimiters.includes(c)) { valueDelimiter = c; break; }
        // `/home/martin` must stay a parameter, so anything that is not a
        // letter, `?`, or a `--long-switch` dash ends the switch hypothesis.
        if (c === '?' || isLetter(c) || (c === '-' && switchMark === '-' && v[1] === '-')) {
          idx++;
          continue;
        }
        isSwitch = false;
        break;
      }
    }

    const option = { type: 'param', name: '', value: v, valueSet: false, used: false, switchMark: '' };
    if (isSwitch) {
      option.type = 'switch';
      option.name = v.slice(1, idx);
      option.value = v.slice(idx + 1);
      if (valueDelimiter === ARRAY_VALUE_DELIMITER && option.value.endsWith(ARRAY_VALUE_END)) {
        option.value = option.value.slice(0, -1);
      }
      option.valueSet = idx < v.length;
      option.switchMark = switchMark;
    } else {
      this.paramCount++;
    }

    this.options.push(option);
    this.originalOptions = this.options.map((o) => ({ ...o }));
  }

  /** 1-based, exactly like TOptions::Param. Marks the parameter as used. */
  param(index) {
    let remaining = index;
    for (const o of this.options) {
      if (o.type !== 'param') continue;
      remaining--;
      if (remaining === 0) { o.used = true; return o.value; }
    }
    return '';
  }

  params() {
    return this.options.filter((o) => o.type === 'param').map((o) => o.value);
  }

  consumeParam() {
    const v = this.param(1);
    this._paramsProcessed(1, 1);
    return v;
  }

  get empty() { return this.options.length === 0; }

  /**
   * Find a switch and mark it used.
   * @returns {{found:boolean, value:string, valueSet:boolean, paramsStart:number, paramsCount:number}}
   */
  locateSwitch(name, caseSensitive = false) {
    let paramsStart = 0;
    let found = false;
    let value = '';
    let valueSet = false;
    let index = 0;

    while (index < this.options.length && !found) {
      const o = this.options[index];
      if (o.type === 'param') paramsStart++;
      else if ((!caseSensitive && o.name.toLowerCase() === String(name).toLowerCase())
               || (caseSensitive && o.name === name)) {
        found = true;
        value = o.value;
        valueSet = o.valueSet;
        o.used = true;
      }
      index++;
    }

    let paramsCount = 0;
    if (found) {
      paramsStart++;
      while (index + paramsCount < this.options.length
             && this.options[index + paramsCount].type === 'param') {
        paramsCount++;
      }
    } else {
      paramsStart = 0;
    }
    return { found, value, valueSet, paramsStart, paramsCount };
  }

  findSwitch(name) { return this.locateSwitch(name).found; }

  switchValueOf(name) {
    const r = this.locateSwitch(name);
    return r.found ? r.value : undefined;
  }

  /** FindSwitch(Switch, TStrings*) — consume the parameters that follow it. */
  findSwitchParams(name, paramsMax = -1, caseSensitive = false) {
    const r = this.locateSwitch(name, caseSensitive);
    if (!r.found) return null;
    let count = r.paramsCount;
    const asInt = Number(r.value);
    if (r.value !== '' && Number.isInteger(asInt) && asInt < count) count = asInt;
    if (paramsMax >= 0 && count > paramsMax) count = paramsMax;
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.param(r.paramsStart + i));
    this._paramsProcessed(r.paramsStart, count);
    return out;
  }

  switchValue(name, def = '') {
    const r = this.locateSwitch(name);
    const v = r.found ? r.value : '';
    return v === '' ? def : v;
  }

  /** The `on|off|<int>` form used by /xmlgroups and friends. */
  switchValueBool(name, def, defaultOnNonExistence = def) {
    const r = this.locateSwitch(name);
    if (!r.found) return defaultOnNonExistence;
    if (r.value === '') return def;
    if (/^on$/i.test(r.value)) return true;
    if (/^off$/i.test(r.value)) return false;
    const n = Number(r.value);
    if (Number.isInteger(n)) return n !== 0;
    throw new ScriptError(`Value '${r.value}' is not a valid boolean.`);
  }

  /** The first switch nobody looked at — how "Unknown switch" is detected. */
  unusedSwitch() {
    for (const o of this.options) {
      if (o.type === 'switch' && !o.used) return o.name;
    }
    return null;
  }

  wasSwitchAdded() {
    const last = this.options[this.options.length - 1];
    if (!last || last.type !== 'switch') return null;
    return { name: last.name, value: last.value, switchMark: last.switchMark };
  }

  logOptions(onLogOption) {
    for (const o of this.originalOptions) {
      if (o.type === 'param') onLogOption(`Parameter: ${o.value}`);
      else {
        const delim = o.value === '' ? '' : this.switchValueDelimiters[0];
        onLogOption(`Switch:    ${this.switchMarks[0]}${o.name}${delim}${o.value}`);
      }
    }
  }

  _paramsProcessed(paramsStart, paramsCount) {
    if (paramsCount <= 0) return;
    let start = paramsStart;
    let index = 0;
    while (index < this.options.length && start > 0) {
      if (this.options[index].type === 'param') {
        start--;
        if (start === 0) {
          let n = paramsCount;
          while (n > 0) {
            this.options.splice(index, 1);
            this.paramCount--;
            n--;
          }
        }
      }
      index++;
    }
  }
}

/**
 * The parameters of one script command.
 *
 * `/` is removed from the switch marks — inside a script only `-x` is a switch,
 * so `cd /home/martin` and `get /var/log/*.log .` behave as users expect.
 */
class ScriptProcParams extends Options {
  constructor(fullCommand, paramsStr) {
    super();
    this.switchMarks = this.switchMarks.replace('/', '');
    this.fullCommand = fullCommand;
    this.paramsStr = paramsStr === undefined ? '' : paramsStr;
    this.parse(this.paramsStr);
  }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

class ScriptError extends Error {
  constructor(message) { super(message); this.name = 'ScriptError'; }
}

/** Raised where WinSCP calls NotSupported(). */
class NotSupportedError extends ScriptError {
  constructor(message) { super(message || MSG.NOTSUPPORTED); this.name = 'NotSupportedError'; }
}

/** Raised by `exit`/abort paths that must unwind without being reported. */
class ScriptAbort extends Error {
  constructor(message) { super(message || 'Aborted'); this.name = 'ScriptAbort'; }
}

function notSupported() { throw new NotSupportedError(); }

// ---------------------------------------------------------------------------
// command resolution
// ---------------------------------------------------------------------------

/**
 * TScriptCommands::FindCommand — exact match first, then unique prefix.
 * @returns {{index:number, matches:string}} index -1 unknown, -2 ambiguous.
 */
function findCommand(names, command) {
  const lower = String(command).toLowerCase();
  const exact = names.findIndex((n) => n.toLowerCase() === lower);
  if (exact >= 0) return { index: exact, matches: names[exact] };

  let matches = '';
  let count = 0;
  let index = -1;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (lower.length <= n.length && n.slice(0, lower.length).toLowerCase() === lower) {
      matches = matches ? `${matches}, ${n}` : n;
      count++;
      index = i;
    }
  }
  if (count === 0) return { index: -1, matches: '' };
  if (count > 1) return { index: -2, matches };
  return { index, matches };
}

const TOGGLE_NAMES = ['off', 'on'];
const BATCH_MODE_NAMES = ['off', 'on', 'abort', 'continue'];
const TRANSFER_MODE_NAMES = ['binary', 'ascii', 'automatic'];
const IN_OUT_PARAM = '-';

// TScript::TFileListType
const FLT = {
  DEFAULT: 0x00,
  DIRECTORIES: 0x01,
  QUERY_SERVER: 0x02,
  MASK: 0x04,
  LATEST: 0x08,
  ONLY_FILE: 0x10,
};

// TTerminal synchronization params, kept as flags so `option` can toggle them.
const SP = {
  DELETE: 0x0002,
  NO_CONFIRMATION: 0x0004,
  EXISTING_ONLY: 0x0008,
  MIRROR: 0x0040,
  TIMESTAMP: 0x0100,
  NOT_BY_TIME: 0x0200,
  BY_CHECKSUM: 0x0400,
  BY_SIZE: 0x0800,
  CASE_SENSITIVE: 0x1000,
};
const SP_ACCEPTED = SP.EXISTING_ONLY | SP.TIMESTAMP | SP.NOT_BY_TIME | SP.BY_SIZE
  | SP.BY_CHECKSUM | SP.CASE_SENSITIVE;
const SP_DEFAULT = 0;

/** WinSCP's 2-minute floor on reconnect time once batch mode is on. */
const BATCH_SESSION_REOPEN_TIMEOUT = 2 * 60 * 1000;

const SHELL_CHECKSUM_ALGS = {
  'sha-512': 'sha512sum',
  'sha-384': 'sha384sum',
  'sha-256': 'sha256sum',
  'sha-224': 'sha224sum',
  'sha-1': 'sha1sum',
  md5: 'md5sum',
};

const ENG_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// listing formatting — TRemoteFile::GetListingStr
// ---------------------------------------------------------------------------

function pad(s, n) { return String(s).padEnd(n); }
function padStart(s, n) { return String(s).padStart(n); }

/** ModificationStr with mfFull: "Jan  1 12:34:56 2024". */
function modificationStr(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${ENG_SHORT_MONTHS[d.getMonth()]} ${padStart(d.getDate(), 2)} `
    + `${padStart(d.getHours(), 2)}:${two(d.getMinutes())}:${two(d.getSeconds())} `
    + `${String(d.getFullYear()).padStart(4)}`;
}

function typeChar(e) {
  if (e.type === 'dir') return 'd';
  if (e.type === 'link' || e.isSymlink) return 'l';
  return '-';
}

/** `%s%s %3s %-8s %-8s %9s %-12s %s%s` */
function listingStr(e) {
  const rights = (e.rights || '').padEnd(9, '-');
  const link = (e.type === 'link' || e.isSymlink) && e.linkTarget ? ` -> ${e.linkTarget}` : '';
  return `${typeChar(e)}${rights} ${padStart(e.nodeBlocks === undefined ? 1 : e.nodeBlocks, 3)} `
    + `${pad(e.owner || '', 8)} ${pad(e.group || '', 8)} ${padStart(e.size || 0, 9)} `
    + `${pad(modificationStr(e.mtime), 12)} ${e.name}${link}`;
}

// ---------------------------------------------------------------------------
// the terminal facade
// ---------------------------------------------------------------------------

/**
 * What TTerminal is to `Script.cpp`, this is to an Adapter: a connected remote
 * end with a current directory, a display name and the handful of operations
 * the scripting commands need. It deliberately owns no transfer logic.
 */
class ScriptTerminal {
  /**
   * @param {object} opts
   *   adapter        the connected Adapter
   *   name           the session name shown by `session` and `close`
   *   session        the owning Session (optional; used for close and logging)
   *   currentDirectory  starting remote directory
   */
  constructor(opts) {
    const o = opts || {};
    this.adapter = o.adapter;
    this.name = o.name || (this.adapter ? this.adapter.protocolName : 'session');
    this.session = o.session || null;
    this._cwd = o.currentDirectory || (this.adapter && this.adapter.home) || '/';
    this.active = true;
  }

  get currentDirectory() { return this._cwd; }
  set currentDirectory(v) { this._cwd = v; }

  isCapable(cap) { return !!(this.adapter && this.adapter.caps && this.adapter.caps[cap]); }

  /** Absolute-ise a path the user typed against the current directory. */
  absolute(p) {
    if (!p) return this._cwd;
    if (p.startsWith('/')) return p;
    return unixIncludeTrailingSlash(this._cwd) + p;
  }

  async homeDirectory() {
    const home = this.adapter.home || '/';
    return this.changeDirectory(home);
  }

  async changeDirectory(dir) {
    const target = this.absolute(dir);
    // Listing is the portable existence test: every adapter implements it, and
    // it also warms the panel cache the way TTerminal::ChangeDirectory does.
    const resolved = await this.adapter.realpath(target);
    await this.adapter.list(resolved);
    this._cwd = unixExcludeTrailingSlash(resolved) || '/';
    if (this.session && this.session.state) this.session.state.remotePath = this._cwd;
    return this._cwd;
  }

  async readDirectory(dir) {
    const entries = await this.adapter.list(this.absolute(dir));
    return entries.filter((e) => isRealFile(e.name));
  }

  async readFile(p) {
    const target = unixExcludeTrailingSlash(this.absolute(p));
    const st = await this.adapter.stat(target);
    return { ...st, name: st.name || unixExtractFileName(target), fullFileName: target };
  }

  async deleteFile(p, isDirectory) {
    await this.adapter.remove(this.absolute(p), { recursive: !!isDirectory });
  }

  async createDirectory(p) {
    await this.adapter.mkdir(this.absolute(p), { recursive: true });
  }

  async createLink(linkName, target) {
    await this.adapter.symlink(target, this.absolute(linkName));
  }

  async setRights(p, octal) {
    await this.adapter.setRights(this.absolute(p), octal);
  }

  async move(from, to, opts = {}) {
    // WinSCP passes the overwrite flag straight to the file system; adapters
    // that can express it (WebDAV's Overwrite header) must see it.
    await this.adapter.rename(this.absolute(from), this.absolute(to), opts);
  }

  async anyCommand(command, onOutput) {
    const res = await this.adapter.exec(command);
    const emit = (text, isError) => {
      for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        if (line !== '' || text.trim() !== '') onOutput(line, isError);
      }
    };
    if (res && res.stdout) emit(res.stdout.replace(/\n$/, ''), false);
    if (res && res.stderr) emit(res.stderr.replace(/\n$/, ''), true);
    return res;
  }

  /**
   * WinSCP asks the file system for the hash, and falls back to running
   * `sha1sum` etc. over a shell session. Both routes are kept.
   */
  async calculateChecksum(alg, filePath) {
    if (this.isCapable('checksum')) {
      return this.adapter.checksum(this.absolute(filePath), alg);
    }
    if (!this.isCapable('exec')) notSupported();
    const tool = SHELL_CHECKSUM_ALGS[String(alg).toLowerCase()] || alg;
    const quoted = `'${this.absolute(filePath).replace(/'/g, `'\\''`)}'`;
    const res = await this.adapter.exec(`${tool} -- ${quoted}`);
    if (res.code !== 0) {
      throw new ScriptError(`${tool} failed: ${(res.stderr || '').trim() || `exit code ${res.code}`}`);
    }
    const m = /^([0-9a-f]+)[\s*]/i.exec(`${res.stdout.trim()} `);
    if (!m) throw new ScriptError(`${tool} produced no usable output`);
    return m[1].toLowerCase();
  }

  async close() {
    this.active = false;
    if (this.session && typeof this.session.disconnect === 'function') {
      await this.session.disconnect();
    } else if (this.adapter && typeof this.adapter.disconnect === 'function') {
      await this.adapter.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// TScript
// ---------------------------------------------------------------------------

class Script {
  /**
   * @param {object} deps
   *   limitedOutput   trim long file names in progress lines (cfLimitedOutput)
   *   queue           TransferQueue — get/put/cp/synchronize run through it
   *   sync            the sync module (defaults to ./sync)
   *   localAdapter    an Adapter for the local file system
   *   config          Config, for the configured copy params
   *   fs              node fs, injectable for tests
   *   onPrint         (script, text, isError) => void
   *   onPrintProgress (script, first, text) => void
   *   onShowExtendedException (terminal, error) => void ; presence means
   *                   "errors are reported, not thrown"
   *   onQueryCancel   (script) => boolean
   *   onProgress      (script, progress) => void
   *   onSynchronizeStartStop  (script, local, remote, copyParam, params) => Promise
   *   log             (kind, text, terminal) => void
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.limitedOutput = !!deps.limitedOutput;
    this.fs = deps.fs || fs;
    this.queue = deps.queue || null;
    this.sync = deps.sync || null;
    this.config = deps.config || null;

    this.terminal = null;
    this.loggingTerminal = null;

    this.onPrint = deps.onPrint || null;
    this.onPrintProgress = deps.onPrintProgress || null;
    this.onShowExtendedException = deps.onShowExtendedException || null;
    this.onQueryCancel = deps.onQueryCancel || null;
    this.onProgress = deps.onProgress || null;
    this.onSynchronizeStartStop = deps.onSynchronizeStartStop || null;
    this.onLog = deps.log || null;

    this.groups = false;
    this.wantsProgress = false;
    this.usageWarnings = true;
    this.onTransferOut = deps.onTransferOut || null;
    this.onTransferIn = deps.onTransferIn || null;

    this.includeFileMaskOptionUsed = false;
    this.pendingLogLines = [];
    this.printInformation = false;
    this.logProtocol = deps.logProtocol === undefined ? 0 : deps.logProtocol;
    this.progressFileNameLimit = deps.progressFileNameLimit || 25;

    this._localDirectory = deps.localDirectory || process.cwd();

    this._init();
  }

  _init() {
    // Defaults are the SCRIPT defaults, not the interactive ones: a script runs
    // with batch=abort and confirm=off so it never blocks on a prompt, and
    // StartInteractive() swaps in the interactive pair when the user takes over.
    this.batch = 'abort';
    this.interactiveBatch = 'off';
    this.confirm = false;
    this.interactiveConfirm = true;

    const configured = this.config && this.config.prefs
      ? Number(this.config.prefs.sessionReopenTimeout) : 0;
    this.sessionReopenTimeout = Number.isFinite(configured) ? configured : 0;
    this.interactiveSessionReopenTimeout = this.sessionReopenTimeout;
    if (this.sessionReopenTimeout === 0) {
      this.sessionReopenTimeout = BATCH_SESSION_REOPEN_TIMEOUT;
    }

    this.echo = false;
    this.failOnNoMatch = false;
    this.synchronizeParams = SP_DEFAULT;
    this.synchronizeMode = -1;
    this.keepingUpToDate = false;
    this.synchronizeIntro = '';
    this.warnNonDefaultCopyParam = false;
    this.warnNonDefaultSynchronizeParams = false;

    this._copyParam = { ...COPY_PARAM_DEFAULTS, fileMask: '' };

    this.commands = [];
    this._register('help', 'Displays help', HELP.help, this.helpProc, 0, -1, false);
    this._register('man', '', HELP.help, this.helpProc, 0, -1, false);
    // `call` has no switches of its own, but the remote command may have some.
    this._register('call', 'Executes arbitrary remote command', HELP.call, this.callProc, 1, -1, true);
    this._register('!', '', HELP.call, this.callProc, 1, -1, true);
    this._register('pwd', 'Prints remote working directory', HELP.pwd, this.pwdProc, 0, 0, false);
    this._register('cd', 'Changes remote working directory', HELP.cd, this.cdProc, 0, 1, false);
    this._register('ls', 'Lists the contents of remote directory', HELP.ls, this.lsProc, 0, 1, false);
    this._register('dir', '', HELP.ls, this.lsProc, 0, 1, false);
    this._register('rm', 'Removes remote file', HELP.rm, this.rmProc, 1, -1, true);
    this._register('rmdir', 'Removes remote directory', HELP.rmdir, this.rmDirProc, 1, -1, false);
    this._register('mv', 'Moves or renames remote file', HELP.mv, this.mvProc, 2, -1, false);
    this._register('rename', '', HELP.mv, this.mvProc, 2, -1, false);
    this._register('cp', 'Duplicates remote file', HELP.cp, this.cpProc, 2, -1, false);
    this._register('chmod', 'Changes permissions of remote file', HELP.chmod, this.chModProc, 2, -1, false);
    this._register('ln', 'Creates remote symbolic link', HELP.ln, this.lnProc, 2, 2, false);
    this._register('symlink', '', HELP.ln, this.lnProc, 2, 2, false);
    this._register('mkdir', 'Creates remote directory', HELP.mkdir, this.mkDirProc, 1, 1, false);
    this._register('get', 'Downloads file from remote directory to local directory', HELP.get, this.getProc, 0, -1, true);
    this._register('recv', '', HELP.get, this.getProc, 0, -1, true);
    this._register('mget', '', HELP.get, this.getProc, 0, -1, true);
    this._register('put', 'Uploads file from local directory to remote directory', HELP.put, this.putProc, 0, -1, true);
    this._register('send', '', HELP.put, this.putProc, 0, -1, true);
    this._register('mput', '', HELP.put, this.putProc, 0, -1, true);
    this._register('option', 'Sets or shows value of script options', HELP.option, this.optionProc, -1, 2, false);
    this._register('ascii', '', HELP.option, this.asciiProc, 0, 0, false);
    this._register('binary', '', HELP.option, this.binaryProc, 0, 0, false);
    this._register('synchronize', 'Synchronizes remote directory with local one', HELP.synchronize, this.synchronizeProc, 0, -1, true);
    this._register('keepuptodate', 'Continuously reflects changes in local directory on remote one', HELP.keepuptodate, this.keepUpToDateProc, 0, 2, true);
    // `echo` has no switches either, but must tolerate dashes in its argument.
    this._register('echo', 'Displays its arguments as message', HELP.echo, this.echoProc, -1, -1, true);
    this._register('stat', 'Retrieves attributes of remote file', HELP.stat, this.statProc, 1, 1, false);
    this._register('checksum', 'Calculates checksum of remote file', HELP.checksum, this.checksumProc, 2, 2, false);
    this._register('copyid', '', '', this.copyIdProc, 1, 1, false);
  }

  _register(name, description, help, proc, minParams, maxParams, switches) {
    this.commands.push({ name, description, help, proc, minParams, maxParams, switches });
    this.commands.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1
      : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  }

  get commandNames() { return this.commands.map((c) => c.name); }

  // ---- copy params ------------------------------------------------------

  get copyParam() { return this._copyParam; }

  set copyParam(value) {
    this._copyParam = { ...COPY_PARAM_DEFAULTS, fileMask: '', ...(value || {}) };
    this.warnNonDefaultCopyParam = this.hasNonDefaultCopyParams();
  }

  hasNonDefaultCopyParams() {
    const base = { ...COPY_PARAM_DEFAULTS, fileMask: '' };
    for (const k of Object.keys(base)) {
      if (JSON.stringify(this._copyParam[k]) !== JSON.stringify(base[k])) return true;
    }
    return false;
  }

  checkDefaultCopyParam() {
    if (!this.warnNonDefaultCopyParam) return;
    // Warn once, and only when the settings still differ: a script that starts
    // from the GUI's configured defaults is not reproducible elsewhere.
    if (this.hasNonDefaultCopyParams()) this.printLine(MSG.NON_DEFAULT_COPY_PARAM);
    this.warnNonDefaultCopyParam = false;
  }

  setSynchronizeParams(value) {
    this.synchronizeParams = value & SP_ACCEPTED;
    this.warnNonDefaultSynchronizeParams = this.synchronizeParams !== (SP_DEFAULT & SP_ACCEPTED);
  }

  checkDefaultSynchronizeParams() {
    if (!this.warnNonDefaultSynchronizeParams) return;
    this.printLine(MSG.NON_DEFAULT_SYNC_PARAM);
    this.warnNonDefaultSynchronizeParams = false;
  }

  // ---- output and logging ----------------------------------------------

  log(kind, text, terminal) {
    const str = `Script: ${text}`;
    const target = terminal || this.loggingTerminal || this.terminal;
    const sessionLog = target && target.session ? target.session.log : null;
    if (sessionLog) sessionLog.add(kind, str);
    else this.pendingLogLines.push({ kind, text: str });
    if (this.onLog) this.onLog(kind, str, target);
  }

  /**
   * Replay everything logged before a session existed. WinSCP does this so a
   * `/log` file opened by `open` still contains the `option` commands that ran
   * before it.
   */
  logPendingLines(terminal) {
    const sessionLog = terminal && terminal.session ? terminal.session.log : null;
    if (!sessionLog || this.pendingLogLines.length === 0) return;
    sessionLog.add('info', 'Script: Retrospectively logging previous script records:');
    for (const line of this.pendingLogLines) sessionLog.add(line.kind, line.text);
    this.pendingLogLines.length = 0;
  }

  print(text, isError = false) {
    if (this.onPrint) this.onPrint(this, text, !!isError);
  }

  printLine(text, isError = false, terminal) {
    this.log('output', text, terminal);
    this.print(`${text}\n`, isError);
  }

  printProgress(first, text) {
    if (this.onPrintProgress) this.onPrintProgress(this, first, text);
  }

  getLogCmd(fullCommand /* , command, params */) { return fullCommand; }

  // ---- errors -----------------------------------------------------------

  handleExtendedException(error, terminal) {
    const handled = !!this.onShowExtendedException;
    if (handled) this.onShowExtendedException(terminal || this.terminal, error);
    return handled;
  }

  checkSession() {
    if (!this.terminal) throw new ScriptError(MSG.NO_SESSION);
  }

  static requireParams(params, minParams) {
    if (params.paramCount < minParams) {
      throw new ScriptError(MSG.MISSING_PARAMS(params.fullCommand));
    }
  }

  checkParams(params) {
    const unused = params.unusedSwitch();
    if (unused !== null) throw new ScriptError(MSG.UNKNOWN_SWITCH(unused));
  }

  /**
   * NoMatch: with `option failonnomatch on` an empty match is an error, and
   * without it the script says so and carries on. Getting this backwards is
   * the classic silent-success script bug, hence the explicit option.
   */
  noMatch(message) {
    if (this.failOnNoMatch) throw new ScriptError(message);
    this.printLine(message);
  }

  noMatchMask(mask, error) {
    let message = MSG.MATCH_NO_MATCH(mask);
    if (error) message += ` (${error})`;
    this.noMatch(message);
  }

  // ---- the command loop -------------------------------------------------

  startInteractive() {
    this.batch = this.interactiveBatch;
    this.confirm = this.interactiveConfirm;
    this.sessionReopenTimeout = this.interactiveSessionReopenTimeout;
  }

  /**
   * Run one script line.
   *
   * Note the comment test: WinSCP checks the FIRST character of the *untrimmed*
   * line, so `  ; note` is not a comment — it is parsed and fails as an unknown
   * command. Ported as-is; scripts in the wild rely on `;` being column one.
   */
  async command(cmd) {
    try {
      const line = cmd === undefined || cmd === null ? '' : String(cmd);
      if (line.trim() === '') return;
      if (line[0] === ';' || line[0] === '#') return;

      const cut = cutToken(line);
      if (!cut.ok) return;

      const commandName = cut.token;
      const paramsStr = cut.rest;
      const logCmd = this.getLogCmd(line, commandName, paramsStr);
      this.log('input', logCmd);

      if (this.logProtocol >= 1) {
        const afterCmd = cutToken(logCmd);
        if (afterCmd.ok) {
          const resolved = this.resolveCommand(commandName);
          const logged = new ScriptProcParams(resolved, afterCmd.rest);
          logged.logOptions((s) => this.log('input', s));
        }
      }

      if (this.echo) this.printLine(logCmd);

      try {
        await this.execute(commandName, paramsStr);
      } catch (e) {
        // Duplicated on purpose (see the C++): the inner catch keeps a failure
        // inside the XML <group> the command opened.
        if (!this.handleExtendedException(e)) throw e;
      }
    } catch (e) {
      if (e instanceof ScriptAbort) throw e;
      if (!this.handleExtendedException(e)) throw e;
    }
  }

  resolveCommand(name) {
    const r = findCommand(this.commandNames, name);
    return r.index >= 0 ? this.commandNames[r.index] : '';
  }

  commandInfo(name) {
    const r = findCommand(this.commandNames, name);
    return r.index >= 0 ? this.commands[r.index] : null;
  }

  async execute(commandName, paramsStr) {
    const r = findCommand(this.commandNames, commandName);
    if (r.index === -2) throw new ScriptError(MSG.COMMAND_AMBIGUOUS(commandName, r.matches));
    if (r.index < 0) throw new ScriptError(MSG.COMMAND_UNKNOWN(commandName));

    const command = this.commands[r.index];
    const params = new ScriptProcParams(command.name, paramsStr);

    if (params.paramCount < command.minParams) {
      throw new ScriptError(MSG.MISSING_PARAMS(command.name));
    }
    if (command.maxParams >= 0 && params.paramCount > command.maxParams) {
      throw new ScriptError(MSG.TOO_MANY_PARAMS(command.name));
    }
    // A command that declares no switches refuses them up front; one that does
    // checks later, after the switches it knows about have been consumed.
    if (!command.switches) this.checkParams(params);

    return command.proc.call(this, params);
  }

  // ---- file lists -------------------------------------------------------

  /**
   * CreateFileList: turn the parameters in [start, end] into remote files,
   * expanding masks against the server listing.
   *
   * @returns {Promise<Array<{path:string, file:object|null}>>}
   */
  async createFileList(params, start, end, listType = FLT.DEFAULT) {
    const result = [];
    const fileLists = new Map();

    for (let i = start; i <= end; i++) {
      const fileName = params.param(i);

      if (unixExcludeTrailingSlash(fileName) !== fileName) {
        this.printLine(MSG.AMBIGUOUS_SLASH_IN_PATH);
      }

      if (listType & FLT.DIRECTORIES) {
        result.push({ path: fileName, file: { name: unixExtractFileName(fileName), type: 'dir' } });
        continue;
      }

      if ((listType & FLT.MASK) && isMaskString(unixExtractFileName(fileName))) {
        const fileDirectory = unixExtractFilePath(fileName);
        const directory = fileDirectory || unixIncludeTrailingSlash(this.terminal.currentDirectory);

        let listing = fileLists.get(directory);
        if (!listing) {
          listing = await this.terminal.readDirectory(directory);
          fileLists.set(directory, listing);
        }

        const maskStr = unixExtractFileName(fileName);
        const mask = new FileMask(maskStr);
        let anyFound = false;
        for (const e of listing) {
          if (!isRealFile(e.name)) continue;
          // MatchesFileName(name, /*Directory*/ false): a wildcard on the
          // command line selects by name, so a directory is matched by the
          // file half of the mask rather than being implicitly included.
          if (!mask.matches(e.name, { isDir: false, size: e.size, mtime: e.mtime })) continue;
          result.push({
            path: fileDirectory + e.name,
            file: (listType & FLT.QUERY_SERVER) ? e : null,
          });
          anyFound = true;
        }
        if (!anyFound) this.noMatchMask(maskStr, '');
        continue;
      }

      let file = null;
      if (listType & FLT.QUERY_SERVER) {
        file = await this.terminal.readFile(unixExcludeTrailingSlash(fileName));
      }
      result.push({ path: fileName, file });
    }

    if ((listType & FLT.LATEST) && result.length > 1) {
      let latest = 0;
      for (let i = 1; i < result.length; i++) {
        const a = result[latest].file ? result[latest].file.mtime || 0 : 0;
        const b = result[i].file ? result[i].file.mtime || 0 : 0;
        if (a < b) latest = i;
      }
      const keep = result[latest];
      result.length = 0;
      result.push(keep);
    }

    if (listType & FLT.ONLY_FILE) {
      for (const r of result) {
        if (r.file && r.file.type === 'dir') {
          throw new ScriptError(MSG.NOT_FILE_ERROR(r.file.name || r.path));
        }
      }
    }

    return result;
  }

  /**
   * CreateLocalFileList. A name with no wildcard that does not exist is kept in
   * the list so the transfer reports the real "file not found" — except with
   * `-latest`, which has to fail immediately because there is nothing to
   * compare timestamps of.
   */
  createLocalFileList(params, start, end, listType) {
    const result = [];
    let latestName = '';
    let latestModification = 0;

    for (let i = start; i <= end; i++) {
      const original = params.param(i);
      const fileName = winExcludeTrailingSlash(original);
      if (fileName !== original) this.printLine(MSG.AMBIGUOUS_SLASH_IN_PATH);

      if (!(listType & FLT.MASK)) { result.push({ path: fileName, file: null }); continue; }

      const resolved = this.resolveLocalPath(fileName);
      const base = localExtractFileName(resolved);
      const dir = localExtractFilePath(resolved) || `${this.localDirectory}${nodePath.sep}`;
      const hasWildcard = base.includes('*') || base.includes('?');

      let anyFound = false;
      let error = '';

      if (hasWildcard) {
        let names = [];
        try {
          names = this.fs.readdirSync(dir);
        } catch (e) {
          error = e.code === 'ENOENT' ? '' : e.message;
        }
        const mask = new FileMask(base);
        for (const name of names) {
          if (!isRealFile(name)) continue;
          let st = null;
          try { st = this.fs.statSync(nodePath.join(dir, name)); } catch { continue; }
          const isDir = st.isDirectory();
          const mtime = st.mtimeMs || 0;
          // FindFirstFile matches on the name alone, directories included.
          if (!mask.matches(name, { isDir: false, size: isDir ? 0 : st.size, mtime })) continue;
          const full = nodePath.join(dir, name);
          result.push({ path: full, file: { name, type: isDir ? 'dir' : 'file', size: st.size, mtime } });
          if (mtime > latestModification) { latestModification = mtime; latestName = full; }
          anyFound = true;
        }
      } else {
        let st = null;
        try { st = this.fs.statSync(resolved); } catch { st = null; }
        if (st) {
          const isDir = st.isDirectory();
          const mtime = st.mtimeMs || 0;
          result.push({
            path: resolved,
            file: { name: base, type: isDir ? 'dir' : 'file', size: st.size, mtime },
          });
          if (mtime > latestModification) { latestModification = mtime; latestName = resolved; }
          anyFound = true;
        } else if (listType & FLT.LATEST) {
          throw new ScriptError(MSG.FILE_NOT_EXISTS(fileName));
        } else {
          result.push({ path: resolved, file: null });
          anyFound = true;
        }
      }

      if (!anyFound) this.noMatchMask(base, error);
    }

    if (listType & FLT.LATEST) {
      result.length = 0;
      if (latestName) {
        result.push({ path: latestName, file: { name: localExtractFileName(latestName), type: 'file' } });
      }
    }

    return result;
  }

  /**
   * CheckMultiFilesToOne: WinSCP asks the user in the GUI; in a script it says
   * so and proceeds, because a script has nobody to ask.
   */
  checkMultiFilesToOne(fileList, target, unix) {
    const name = unix ? unixExtractFileName(target) : localExtractFileName(target);
    if (!isFileNameMask(name) && fileList.length > 1) {
      this.printLine(MSG.MULTI_FILES_TO_ONE(target));
    }
  }

  // ---- switch handling --------------------------------------------------

  /** TransferParamParams: the flags that are about the operation, not the copy. */
  transferParamParams(params) {
    const out = { noConfirmation: !this.confirm, delete: false, resume: false, append: false };
    if (params.findSwitch('delete')) out.delete = true;
    if (params.findSwitch('resume')) out.resume = true;
    else if (params.findSwitch('append')) out.append = true;
    return out;
  }

  /** CopyParamParams: `-preservetime`, `-permissions=644`, `-speed=…`, … */
  copyParamParams(copyParam, params) {
    if (!this.wantsProgress) {
      // Nothing displays the total, so do not pay for computing it.
      copyParam.calculateSize = false;
    }

    if (params.findSwitch('nopreservetime')) {
      copyParam.preserveTime = false;
      copyParam.preserveTimeDirs = false;
    }

    let r = params.locateSwitch('preservetime');
    if (r.found) {
      copyParam.preserveTime = true;
      if (String(r.value).toLowerCase() === 'all') copyParam.preserveTimeDirs = true;
    }

    if (params.findSwitch('nopermissions')) copyParam.preserveRights = false;

    r = params.locateSwitch('permissions');
    if (r.found) {
      copyParam.preserveRights = true;
      copyParam.rights = rightsFromOctal(r.value);
      copyParam.rightsOctal = r.value;
    }

    r = params.locateSwitch('speed');
    if (r.found) {
      let cps;
      if (r.value === '') cps = 0;
      else {
        const n = parseInt(r.value, 10);
        if (!Number.isFinite(n)) throw new ScriptError(MSG.VALUE_UNKNOWN(r.value, 'speed'));
        cps = n * 1024;
        if (cps < 0) cps = 0;
      }
      copyParam.cpsLimit = cps;
    }

    r = params.locateSwitch('transfer');
    if (r.found) copyParam.transferMode = parseTransferModeName(r.value);

    r = params.locateSwitch('filemask');
    if (r.found) {
      copyParam.includeFileMask = r.value;
      if (this.includeFileMaskOptionUsed) this.printLine(MSG.FILEMASK_INCLUDE_EXCLUDE);
    }

    r = params.locateSwitch('resumesupport');
    if (r.found) {
      const toggle = findCommand(TOGGLE_NAMES, r.value);
      if (toggle.index >= 0) {
        copyParam.resumeSupport = toggle.index === 1 ? 'on' : 'off';
      } else {
        const threshold = parseInt(r.value, 10);
        if (!Number.isFinite(threshold) || !/^-?\d+$/.test(String(r.value).trim())) {
          throw new ScriptError(MSG.VALUE_UNKNOWN('resumesupport', r.value));
        }
        copyParam.resumeSupport = 'smart';
        copyParam.resumeThreshold = threshold * 1024;
      }
    }

    if (params.findSwitch('noneweronly')) copyParam.newerOnly = false;
    if (params.findSwitch('neweronly')) copyParam.newerOnly = true;

    const raw = params.findSwitchParams('rawtransfersettings');
    if (raw) {
      for (const setting of raw) {
        const eq = setting.indexOf('=');
        if (eq < 0) continue;
        const key = setting.slice(0, eq);
        const value = setting.slice(eq + 1);
        copyParam[key] = coerceRawValue(value);
      }
    }

    return copyParam;
  }

  // ---- the local working directory --------------------------------------

  /**
   * WinSCP uses the process working directory. Doing that here would change it
   * for the whole application (the GUI, the queue, every other session), so the
   * script keeps its own and resolves relative paths against it.
   */
  get localDirectory() { return this._localDirectory; }

  set localDirectory(v) { this._localDirectory = v; }

  resolveLocalPath(p) {
    if (!p) return this._localDirectory;
    return nodePath.resolve(this._localDirectory, p);
  }

  changeLocalDirectory(directory) {
    const target = this.resolveLocalPath(directory);
    let st;
    try { st = this.fs.statSync(target); } catch { st = null; }
    if (!st || !st.isDirectory()) throw new ScriptError(MSG.CHANGE_DIR_ERROR(directory));
    this._localDirectory = target;
    return target;
  }

  // ---- commands ---------------------------------------------------------

  async helpProc(params) {
    let output = '';
    if (params.paramCount === 0) {
      for (const c of this.commands) {
        if (c.description) output += `${pad(c.name, 8)} ${c.description}\n`;
      }
    } else {
      for (let i = 1; i <= params.paramCount; i++) {
        const name = params.param(i);
        const info = this.commandInfo(name);
        if (!info) throw new ScriptError(MSG.COMMAND_UNKNOWN(name));
        output += info.help;
      }
    }
    this.print(output);
  }

  async callProc(params) {
    this.checkSession();
    if (!this.terminal.isCapable('exec')) notSupported();
    await this.terminal.anyCommand(params.paramsStr, (line, isError) => {
      this.printLine(line, isError);
    });
  }

  async echoProc(params) {
    this.printLine(params.paramsStr);
  }

  async statProc(params) {
    this.checkSession();
    const file = await this.terminal.readFile(unixExcludeTrailingSlash(params.param(1)));
    this.printLine(listingStr(file));
  }

  async checksumProc(params) {
    this.checkSession();
    if (!this.terminal.isCapable('checksum') && !this.terminal.isCapable('exec')) notSupported();

    const alg = params.param(1);
    const fileList = await this.createFileList(params, 2, 2, FLT.QUERY_SERVER);
    if (fileList.length !== 1 || (fileList[0].file && fileList[0].file.type === 'dir')) {
      throw new ScriptError(MSG.NOT_FILE_ERROR(fileList.length ? fileList[0].path : params.param(2)));
    }
    const hash = await this.terminal.calculateChecksum(alg, fileList[0].path);
    this.printLine(`${hash} ${unixExtractFileName(fileList[0].path)}`);
  }

  async copyIdProc(params) {
    this.checkSession();
    const fileName = this.resolveLocalPath(params.param(1));
    const key = String(this.fs.readFileSync(fileName)).trim();
    if (!key) throw new ScriptError(MSG.FILE_NOT_EXISTS(fileName));
    // The public key half only — a private key in authorized_keys would be a
    // catastrophe, so refuse anything that does not look like a public key.
    if (/PRIVATE KEY/i.test(key) || !/^(ssh-|ecdsa-|sk-)/.test(key)) {
      throw new ScriptError(`'${fileName}' is not an SSH public key file.`);
    }
    if (!this.terminal.isCapable('exec')) notSupported();
    this.printInformation = true;
    try {
      const command = 'umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys';
      const res = await this.terminal.adapter.exec(command, { stdin: `${key}\n` });
      if (res && res.code !== 0) {
        throw new ScriptError((res.stderr || '').trim() || `Command failed with exit code ${res.code}`);
      }
      this.printLine('Public key was added to the authorized keys.');
    } finally {
      this.printInformation = false;
    }
  }

  async pwdProc() {
    this.checkSession();
    this.printLine(this.terminal.currentDirectory);
  }

  async cdProc(params) {
    this.checkSession();
    if (params.paramCount === 0) await this.terminal.homeDirectory();
    else await this.terminal.changeDirectory(params.param(1));
    this.printLine(this.terminal.currentDirectory);
  }

  async lsProc(params) {
    this.checkSession();

    let directory = '';
    let mask = null;
    let maskStr = '';
    if (params.paramCount > 0) {
      directory = params.param(1);
      maskStr = unixExtractFileName(directory);
      if (isMaskString(maskStr)) {
        mask = new FileMask(maskStr);
        directory = unixExtractFilePath(directory);
      } else {
        maskStr = '';
      }
    }
    if (!directory) directory = this.terminal.currentDirectory;

    const entries = await this.terminal.readDirectory(directory);
    // ReadDirectoryListing matches every entry as a file name, directories
    // included — `ls *.html` lists only the HTML, not every subdirectory.
    const shown = mask
      ? entries.filter((e) => mask.matches(e.name, { isDir: false, size: e.size, mtime: e.mtime }))
      : entries;

    if (shown.length > 0) {
      for (const e of shown) this.printLine(listingStr(e));
    } else if (mask) {
      this.noMatchMask(maskStr, '');
    }
  }

  async rmProc(params) {
    this.checkSession();
    const onlyFile = params.findSwitch('onlyfile');
    const listType = FLT.QUERY_SERVER | FLT.MASK | (onlyFile ? FLT.ONLY_FILE : 0);
    const fileList = await this.createFileList(params, 1, params.paramCount, listType);
    this.checkParams(params);
    for (const f of fileList) {
      await this.terminal.deleteFile(f.path, f.file && f.file.type === 'dir');
      this.printLine(f.path);
    }
  }

  async rmDirProc(params) {
    this.checkSession();
    const fileList = await this.createFileList(params, 1, params.paramCount, FLT.DIRECTORIES);
    for (const f of fileList) {
      await this.terminal.deleteFile(f.path, true);
      this.printLine(f.path);
    }
  }

  async mvProc(params) { return this._doMvOrCp(params, 'move', false); }

  async cpProc(params) { return this._doMvOrCp(params, 'copyRemote', true); }

  async _doMvOrCp(params, capability, isCopy) {
    this.checkSession();
    if (!this.terminal.isCapable(capability)) notSupported();

    const fileList = await this.createFileList(params, 1, params.paramCount - 1,
      FLT.MASK | FLT.QUERY_SERVER);

    const rawTarget = params.param(params.paramCount);
    const targetDirectory = unixExtractFilePath(rawTarget);
    const fileMask = unixExtractFileName(rawTarget);
    const target = unixIncludeTrailingSlash(targetDirectory || this.terminal.currentDirectory) + fileMask;
    this.checkMultiFilesToOne(fileList, target, true);

    for (const f of fileList) {
      const name = unixExtractFileName(f.path);
      const newName = maskFileName(name, fileMask);
      const dest = unixIncludeTrailingSlash(
        targetDirectory || unixExtractFilePath(f.path) || this.terminal.currentDirectory) + newName;

      // TTerminal::DoRenameOrCopyFile: a target that is the same path as the
      // source is skipped outright, not renamed onto itself.
      if (unixExcludeTrailingSlash(this.terminal.absolute(f.path))
          === unixExcludeTrailingSlash(this.terminal.absolute(dest))) {
        continue;
      }

      // Script mv/cp always pass DontOverwrite=true, so WinSCP neither asks
      // about an existing target nor deletes it first — the operation fails.
      // Most adapters here would happily clobber, so the refusal is enforced
      // before the call rather than left to the protocol.
      await this._refuseExistingTarget(dest, f.path, isCopy);

      if (isCopy) await this._copyRemoteFile(f, dest);
      else await this.terminal.move(f.path, dest, { overwrite: false });
      this.printLine(f.path);
    }
  }

  /** The DontOverwrite half of DoRenameOrCopyFile. */
  async _refuseExistingTarget(dest, source, isCopy) {
    let exists = false;
    try {
      await this.terminal.readFile(dest);
      exists = true;
    } catch {
      // Anything that is not "it is there" means there is nothing to protect.
      exists = false;
    }
    if (exists) {
      throw new ScriptError(
        `${isCopy ? MSG.COPY_FILE_ERROR(source, dest) : MSG.MOVE_FILE_ERROR(source, dest)} `
        + `File '${dest}' already exists.`);
    }
  }

  async _copyRemoteFile(file, dest) {
    const adapter = this.terminal.adapter;
    if (typeof adapter.copy === 'function') {
      await adapter.copy(this.terminal.absolute(file.path), this.terminal.absolute(dest),
        { overwrite: false });
      return;
    }
    if (!this.queue) throw new ScriptError('No transfer queue is available for cp.');
    // No server-side COPY verb: go through the queue, which streams it back and
    // forth over the same connection. Same result, more bytes.
    this._beginTransfer(false);
    await this._runQueueItems([this.queue.add({
      side: 'remote-copy',
      source: this.terminal.absolute(file.path),
      target: this.terminal.absolute(dest),
      targetIsDir: false,
      sourceAdapter: adapter,
      targetAdapter: adapter,
      copyParam: { ...this._copyParam },
      session: this.terminal.session,
    })]);
  }

  async chModProc(params) {
    this.checkSession();
    if (!this.terminal.isCapable('rights')) notSupported();
    const octal = params.param(1);
    // Validate before touching anything: half a chmod is worse than none.
    rightsFromOctal(octal);
    const fileList = await this.createFileList(params, 2, params.paramCount, FLT.MASK);
    for (const f of fileList) {
      await this.terminal.setRights(f.path, octal);
      this.printLine(f.path);
    }
  }

  async lnProc(params) {
    this.checkSession();
    if (!this.terminal.isCapable('symlink')) notSupported();
    await this.terminal.createLink(params.param(2), params.param(1));
    this.printLine(params.param(2));
  }

  async mkDirProc(params) {
    this.checkSession();
    await this.terminal.createDirectory(params.param(1));
    this.printLine(params.param(1));
  }

  // ---- transfers --------------------------------------------------------

  async getProc(params) {
    this.checkSession();
    this.resetTransfer();

    const latest = params.findSwitch('latest');
    let onlyFile = params.findSwitch('onlyfile');
    this.checkDefaultCopyParam();
    const copyParam = { ...this._copyParam };
    this.copyParamParams(copyParam, params);
    const transferParams = this.transferParamParams(params);

    Script.requireParams(params, 1);
    const lastFileParam = params.paramCount === 1 ? 1 : params.paramCount - 1;

    let streamOut = false;
    if (this.onTransferOut && params.paramCount > 1
        && params.param(params.paramCount).toLowerCase() === IN_OUT_PARAM) {
      streamOut = true;
      onlyFile = true;
    }

    const listType = FLT.QUERY_SERVER | FLT.MASK
      | (latest ? FLT.LATEST : 0) | (onlyFile ? FLT.ONLY_FILE : 0);
    const fileList = await this.createFileList(params, 1, lastFileParam, listType);

    let targetDirectory = '';
    if (!streamOut) {
      if (params.paramCount === 1) {
        targetDirectory = this.localDirectory;
        copyParam.fileMask = '';
      } else {
        const rawTarget = params.param(params.paramCount);
        targetDirectory = localExtractFilePath(rawTarget) || this.localDirectory;
        targetDirectory = this.resolveLocalPath(targetDirectory);
        copyParam.fileMask = localExtractFileName(rawTarget);
        const target = nodePath.join(targetDirectory, copyParam.fileMask);
        this.checkMultiFilesToOne(fileList, target, false);
      }
    }

    this.checkParams(params);

    if (streamOut) {
      for (const f of fileList) {
        const buf = await this.terminal.adapter.readFile(this.terminal.absolute(f.path));
        this.onTransferOut(this, buf);
        // "Once we issue <download> we must terminate the data stream"
        // (Terminal.cpp:8402, in the __finally of every streamed sink). The
        // zero-length call IS the terminator, and it is PER FILE, not once at
        // the end: without it a /stdout=chunked reader has no way to tell where
        // one file stops and the next begins, so a multi-file `get` produces
        // one unsplittable blob.
        this.onTransferOut(this, Buffer.alloc(0));
      }
      return;
    }

    await this._transfer(fileList, targetDirectory, copyParam, transferParams, true);
  }

  async putProc(params) {
    this.checkSession();
    this.resetTransfer();

    const latest = params.findSwitch('latest');
    this.checkDefaultCopyParam();
    const copyParam = { ...this._copyParam };
    this.copyParamParams(copyParam, params);
    const transferParams = this.transferParamParams(params);

    Script.requireParams(params, 1);
    const lastFileParam = params.paramCount === 1 ? 1 : params.paramCount - 1;

    // Streaming in only applies when `-` is the very first parameter.
    const streamIn = !!this.onTransferIn
      && params.param(1).toLowerCase() === IN_OUT_PARAM;
    if (streamIn && params.paramCount > 2) throw new ScriptError(MSG.STREAM_IN_SCRIPT_ERROR);

    const fileList = streamIn
      ? []
      : this.createLocalFileList(params, 1, lastFileParam, FLT.MASK | (latest ? FLT.LATEST : 0));

    let targetDirectory;
    if (params.paramCount === 1) {
      targetDirectory = this.terminal.currentDirectory;
      copyParam.fileMask = '';
    } else {
      const rawTarget = params.param(params.paramCount);
      targetDirectory = unixExtractFilePath(rawTarget) || this.terminal.currentDirectory;
      copyParam.fileMask = unixExtractFileName(rawTarget);
      const target = unixIncludeTrailingSlash(targetDirectory) + copyParam.fileMask;
      this.checkMultiFilesToOne(fileList, target, true);
    }

    this.checkParams(params);

    if (streamIn) {
      if (isFileNameMask(copyParam.fileMask)) throw new ScriptError(MSG.STREAM_IN_SCRIPT_ERROR);
      const data = await this.onTransferIn(this);
      const dest = unixIncludeTrailingSlash(targetDirectory) + copyParam.fileMask;
      await this.terminal.adapter.writeFile(this.terminal.absolute(dest), Buffer.from(data || ''));
      this.printLine(dest);
      return;
    }

    await this._transfer(fileList, targetDirectory, copyParam, transferParams, false);
  }

  /**
   * Hand the file list to the transfer queue and wait for it. This is the only
   * place transfers happen; the script never opens a stream itself.
   */
  async _transfer(fileList, targetDirectory, copyParam, transferParams, toLocal) {
    if (fileList.length === 0) return;
    if (!this.queue) throw new ScriptError('No transfer queue is available for this command.');

    const localAdapter = await this._requireLocalAdapter();
    const remoteAdapter = this.terminal.adapter;
    const sourceAdapter = toLocal ? remoteAdapter : localAdapter;
    const targetAdapter = toLocal ? localAdapter : remoteAdapter;

    const cp = { ...copyParam };
    delete cp.fileMask;
    if (transferParams.resume) cp.overwriteMode = 'resume';
    else if (transferParams.append) cp.overwriteMode = 'append';

    this._beginTransfer(!transferParams.noConfirmation);
    const items = [];
    for (const f of fileList) {
      const sourcePath = toLocal ? this.terminal.absolute(f.path) : f.path;
      const name = toLocal ? unixExtractFileName(f.path) : localExtractFileName(f.path);
      const targetName = maskFileName(name, copyParam.fileMask || '');
      const target = toLocal
        ? nodePath.join(targetDirectory, targetName)
        : unixIncludeTrailingSlash(this.terminal.absolute(targetDirectory)) + targetName;

      items.push(this.queue.add({
        side: toLocal ? 'download' : 'upload',
        source: sourcePath,
        target,
        targetIsDir: false,
        sourceAdapter,
        targetAdapter,
        copyParam: cp,
        session: this.terminal.session,
      }));
    }

    const results = await this._runQueueItems(items);

    // `-delete` is the script's own step: the queue moves bytes, it does not
    // decide that the source should stop existing.
    if (transferParams.delete) {
      for (let i = 0; i < items.length; i++) {
        if (results[i].state !== 'done') continue;
        const f = fileList[i];
        if (toLocal) await this.terminal.deleteFile(f.path, f.file && f.file.type === 'dir');
        else await localAdapter.remove(f.path, { recursive: !!(f.file && f.file.type === 'dir') });
      }
    }

    const failed = results.filter((r) => r.state === 'error');
    if (failed.length) throw new ScriptError(failed[0].error || 'Transfer failed.');
  }

  /**
   * WinSCP passes `cpNoConfirmation` with each transfer; the queue here reads
   * one flag, so the script sets it for the duration of its own transfers and
   * puts the caller's value back afterwards.
   */
  _beginTransfer(confirm) {
    if (!this.queue) return;
    this._savedNoConfirmations = this.queue.queuePrefs.noConfirmations;
    this.queue.queuePrefs.noConfirmations = !confirm;
  }

  _endTransfer() {
    if (!this.queue || this._savedNoConfirmations === undefined) return;
    this.queue.queuePrefs.noConfirmations = this._savedNoConfirmations;
    this._savedNoConfirmations = undefined;
  }

  /**
   * Run queued items to completion, answering overwrite queries the way the
   * current `batch`/`confirm` options say to.
   */
  async _runQueueItems(items) {
    const queue = this.queue;
    const ids = new Set(items.map((i) => i.id));

    const onQuery = ({ item, respond }) => {
      if (!ids.has(item.id)) return;
      if (!this.confirm) { respond('overwrite-all'); return; }
      if (this.batch === 'continue') { respond('skip'); return; }
      if (this.batch !== 'off') { respond('skip'); this._batchRefused = true; return; }
      // Interactive: without a console to ask, the safe answer is to refuse.
      respond('skip');
    };

    let first = true;
    const onUpdated = (view) => {
      if (!ids.has(view.id) || view.state !== 'active') return;
      this._reportProgress(view, first);
      first = false;
    };

    this._batchRefused = false;
    queue.prependListener('query', onQuery);
    queue.on('item-updated', onUpdated);
    try {
      await queue.idle();
    } finally {
      queue.removeListener('query', onQuery);
      queue.removeListener('item-updated', onUpdated);
      this._endTransfer();
    }

    const results = items.map((i) => {
      const view = queue.get(i.id) ? queue.view(queue.get(i.id)) : { state: i.state, error: null };
      return { id: i.id, state: view.state, error: view.error };
    });

    if (this._batchRefused) {
      throw new ScriptError('Overwrite confirmation was refused in batch mode.');
    }
    return results;
  }

  /** `%-*s | %14s | %6.1f KB/s | %-6.6s | %3d%%` */
  _reportProgress(view, first) {
    const limit = this.progressFileNameLimit;
    let name = view.progress.currentFile || view.source || '';
    if (this.limitedOutput) name = minimizeName(name, limit);
    const transferred = view.progress.bytes;
    const sizeStr = transferred < 1024 ? `${transferred} B` : `${Math.floor(transferred / 1024)} KB`;
    const cps = (view.progress.cps || 0) / 1024;
    const mode = view.copyParam.transferMode === 'text' ? 'ascii' : 'binary';
    const total = view.progress.total || 0;
    const pct = total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0;
    const message = `${pad(name, limit)} | ${padStart(sizeStr, 14)} | `
      + `${padStart(cps.toFixed(1), 6)} KB/s | ${pad(mode.slice(0, 6), 6)} | ${padStart(pct, 3)}%`;
    this.printProgress(first, message);

    if (this.onProgress && this.wantsProgress) {
      const progress = {
        operation: view.side === 'download' ? 'copy' : 'copy',
        side: view.side === 'download' ? 'remote' : 'local',
        fileName: view.progress.currentFile,
        directory: view.target,
        overallProgress: pct,
        fileProgress: pct,
        cps: view.progress.cps || 0,
        cancel: false,
      };
      this.onProgress(this, progress);
      if (progress.cancel) this.queue.remove(view.id);
    }
  }

  resetTransfer() { /* TScript::ResetTransfer is a hook; the base does nothing. */ }

  async _requireLocalAdapter() {
    if (this._localAdapter) return this._localAdapter;
    if (this.deps.localAdapter) { this._localAdapter = this.deps.localAdapter; return this._localAdapter; }
    // Required lazily so this module stays loadable without a protocol backend.
    const { LocalAdapter } = require('./protocols/local');
    const a = new LocalAdapter({});
    await a.connect();
    this._localAdapter = a;
    return a;
  }

  // ---- options ----------------------------------------------------------

  async optionProc(params) {
    const optionName = params.paramCount >= 1 ? params.param(1) : '';
    const valueName = params.paramCount >= 2 ? params.param(2) : '';
    this.optionImpl(optionName, valueName);
  }

  async asciiProc() { this.optionImpl('transfer', 'ascii'); }

  async binaryProc() { this.optionImpl('transfer', 'binary'); }

  /**
   * `option [name [value]]`. With no name it lists the four options WinSCP
   * lists (echo, batch, confirm, reconnecttime, failonnomatch); transfer,
   * synchdelete, include and exclude are settable but deliberately omitted
   * from the listing, exactly as in the C++.
   */
  optionImpl(optionNameIn, valueName) {
    const NAMES = ['echo', 'batch', 'confirm', 'transfer', 'synchdelete',
      'exclude', 'include', 'reconnecttime', 'failonnomatch'];
    const ECHO = 0; const BATCH = 1; const CONFIRM = 2; const TRANSFER = 3;
    const SYNCHDELETE = 4; const EXCLUDE = 5; const INCLUDE = 6;
    const RECONNECTTIME = 7; const FAILONNOMATCH = 8;

    let option = -1;
    let optionName = optionNameIn;
    if (optionName) {
      const r = findCommand(NAMES, optionName);
      if (r.index < 0) throw new ScriptError(MSG.OPTION_UNKNOWN(optionName));
      option = r.index;
      optionName = NAMES[option];
    }

    const opt = (o) => option < 0 || option === o;
    const listFormat = (name, value) => `${pad(name, 15)} ${pad(value, 10)}`;
    const setValue = valueName !== '' && valueName !== undefined;
    let printReconnectTime = false;

    if (opt(ECHO)) {
      if (setValue) {
        const v = findCommand(TOGGLE_NAMES, valueName);
        if (v.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
        this.echo = v.index === 1;
      }
      this.printLine(listFormat(NAMES[ECHO], TOGGLE_NAMES[this.echo ? 1 : 0]));
    }

    if (opt(BATCH)) {
      if (setValue) {
        const v = findCommand(BATCH_MODE_NAMES, valueName);
        if (v.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
        this.batch = BATCH_MODE_NAMES[v.index];
        this.interactiveBatch = this.batch;
        // Batch mode with an unlimited reconnect time would hang forever with
        // nobody to interrupt it, so WinSCP caps it at two minutes and says so.
        if (this.batch !== 'off' && this.sessionReopenTimeout === 0) {
          this.sessionReopenTimeout = BATCH_SESSION_REOPEN_TIMEOUT;
          this.interactiveSessionReopenTimeout = this.sessionReopenTimeout;
          printReconnectTime = true;
        }
      }
      this.printLine(listFormat(NAMES[BATCH], this.batch));
    }

    if (opt(CONFIRM)) {
      if (setValue) {
        const v = findCommand(TOGGLE_NAMES, valueName);
        if (v.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
        this.confirm = v.index === 1;
        this.interactiveConfirm = this.confirm;
      }
      this.printLine(listFormat(NAMES[CONFIRM], TOGGLE_NAMES[this.confirm ? 1 : 0]));
    }

    if (option === TRANSFER) {
      if (setValue) this._copyParam.transferMode = parseTransferModeName(valueName);
      const modeIndex = TRANSFER_MODE_NAMES.indexOf(
        this._copyParam.transferMode === 'text' ? 'ascii' : this._copyParam.transferMode);
      this.printLine(listFormat(NAMES[TRANSFER],
        TRANSFER_MODE_NAMES[modeIndex < 0 ? 0 : modeIndex]));
    }

    if (option === SYNCHDELETE) {
      if (setValue) {
        const v = findCommand(TOGGLE_NAMES, valueName);
        if (v.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
        this.synchronizeParams = (this.synchronizeParams & ~SP.DELETE)
          | (v.index === 1 ? SP.DELETE : 0);
      }
      this.printLine(listFormat(NAMES[SYNCHDELETE],
        TOGGLE_NAMES[(this.synchronizeParams & SP.DELETE) ? 1 : 0]));
    }

    const CLEAR = 'clear';

    if (option === INCLUDE) {
      if (setValue) {
        this._copyParam.includeFileMask = valueName === CLEAR ? '' : valueName;
        this.includeFileMaskOptionUsed = valueName !== CLEAR;
      }
      this.printLine(listFormat(NAMES[INCLUDE], this._copyParam.includeFileMask));
    }

    if (option === EXCLUDE) {
      if (setValue) {
        this._copyParam.includeFileMask = valueName === CLEAR ? '' : `|${valueName}`;
        this.includeFileMaskOptionUsed = valueName !== CLEAR;
      }
      // Yes, it prints "include" — the two options share one mask, and the C++
      // labels both listings with the include name.
      this.printLine(listFormat(NAMES[INCLUDE], this._copyParam.includeFileMask));
    }

    if (opt(RECONNECTTIME) || printReconnectTime) {
      if (setValue && !printReconnectTime) {
        let value;
        if (String(valueName).toLowerCase() === TOGGLE_NAMES[0]) value = 0;
        else {
          const n = Number(valueName);
          if (!/^-?\d+$/.test(String(valueName).trim()) || !Number.isFinite(n)) {
            throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
          }
          value = n * 1000;
        }
        this.sessionReopenTimeout = value;
        this.interactiveSessionReopenTimeout = value;
      }
      const shown = this.sessionReopenTimeout === 0
        ? TOGGLE_NAMES[0] : String(Math.floor(this.sessionReopenTimeout / 1000));
      this.printLine(listFormat(NAMES[RECONNECTTIME], shown));
    }

    if (opt(FAILONNOMATCH)) {
      if (setValue) {
        const v = findCommand(TOGGLE_NAMES, valueName);
        if (v.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN(valueName, optionName));
        this.failOnNoMatch = v.index === 1;
      }
      this.printLine(listFormat(NAMES[FAILONNOMATCH], TOGGLE_NAMES[this.failOnNoMatch ? 1 : 0]));
    }
  }

  // ---- synchronization --------------------------------------------------

  synchronizeDirectories(params, firstParam) {
    const localDirectory = params.paramCount >= firstParam
      ? params.param(firstParam) : this.localDirectory;
    const remoteDirectory = params.paramCount >= firstParam + 1
      ? params.param(firstParam + 1) : this.terminal.currentDirectory;
    return { localDirectory, remoteDirectory };
  }

  async synchronizeProc(params) {
    this.checkSession();
    this.resetTransfer();

    const MODE_NAMES = ['remote', 'local', 'both'];

    this.checkDefaultCopyParam();
    const copyParam = { ...this._copyParam };
    this.copyParamParams(copyParam, params);

    Script.requireParams(params, 1);
    if (params.paramCount > 3) throw new ScriptError(MSG.TOO_MANY_PARAMS('synchronize'));

    const modeName = params.param(1);
    const modeResult = findCommand(MODE_NAMES, modeName);
    this.synchronizeMode = modeResult.index;

    try {
      if (this.synchronizeMode < 0) throw new ScriptError(MSG.OPTION_UNKNOWN(modeName));

      const { localDirectory, remoteDirectory } = this.synchronizeDirectories(params, 2);

      this.checkDefaultSynchronizeParams();
      let synchronizeParams = this.synchronizeParams | SP.NO_CONFIRMATION;

      if (params.findSwitch('delete')) synchronizeParams |= SP.DELETE;
      if (params.findSwitch('mirror') && this.synchronizeMode !== 2) synchronizeParams |= SP.MIRROR;

      const criteria = params.locateSwitch('criteria');
      if (criteria.found) {
        synchronizeParams = applyCriteria(synchronizeParams, criteria.value);
      }
      const preview = params.findSwitch('preview');

      // "both" has no authoritative side, so size/checksum criteria cannot mean
      // anything; WinSCP quietly drops them rather than guessing a winner.
      if (this.synchronizeMode === 2) {
        synchronizeParams &= ~(SP.NOT_BY_TIME | SP.BY_SIZE | SP.BY_CHECKSUM);
      }

      this.checkParams(params);

      if ((synchronizeParams & SP.BY_CHECKSUM)
          && !this.terminal.isCapable('checksum') && !this.terminal.isCapable('exec')) {
        notSupported();
      }

      this.printLine(MSG.SYNCHRONIZE_COLLECTING);

      const checklist = await this._collect(localDirectory, remoteDirectory,
        MODE_NAMES[this.synchronizeMode], copyParam, synchronizeParams);

      const checked = checklist.items.filter((i) => i.checked && i.action !== 'nothing');
      if (checked.length === 0) { this.noMatch(MSG.SYNCHRONIZE_NODIFFERENCE); return; }

      if (preview) {
        this.printLine(MSG.SYNCHRONIZE_CHECKLIST);
        this.synchronizePreview(localDirectory, remoteDirectory, checked);
        return;
      }

      this.printLine(MSG.SYNCHRONIZE_SYNCHRONIZING);
      await this._apply(checklist, copyParam, synchronizeParams);
    } finally {
      this.synchronizeMode = -1;
    }
  }

  async _collect(localDirectory, remoteDirectory, direction, copyParam, synchronizeParams) {
    const syncModule = this.sync || require('./sync');
    const localAdapter = await this._requireLocalAdapter();
    const options = syncOptionsFrom(direction, synchronizeParams, copyParam);
    this.printProgress(false, MSG.SYNCHRONIZE(
      winExcludeTrailingSlash(this.resolveLocalPath(localDirectory)),
      arrowFor(direction),
      unixExcludeTrailingSlash(this.terminal.absolute(remoteDirectory))));
    return syncModule.compare(
      localAdapter, this.resolveLocalPath(localDirectory),
      this.terminal.adapter, this.terminal.absolute(remoteDirectory), options);
  }

  async _apply(checklist, copyParam, synchronizeParams) {
    const syncModule = this.sync || require('./sync');
    if (!this.queue) throw new ScriptError('No transfer queue is available for synchronize.');
    const cp = { ...copyParam };
    delete cp.fileMask;
    // "Overwrite confirmations are always off for the command" — synchronize
    // has already decided which side wins, so a prompt would be noise.
    this._beginTransfer(false);
    const result = await syncModule.apply(checklist, this.queue, {
      onlyChecked: true,
      performDeletions: !!(synchronizeParams & SP.DELETE),
      copyParam: cp,
    });
    for (const d of result.deletions) this.printLine(MSG.SYNCHRONIZE_DELETED(d.path));
    await this._runQueueItems(result.items);
    if (result.errors.length) {
      const e = result.errors[0].error;
      throw new ScriptError(e && e.message ? e.message : String(e));
    }
    // Break the line after the last transfer, as the C++ does.
    this.print('');
    return result;
  }

  /** SynchronizeFileRecord: `./relative/path [size, modification]`. */
  synchronizeFileRecord(rootDirectory, item, local) {
    const info = local ? item.local : item.remote;
    const sep = local ? nodePath.sep : '/';
    const dir = info.directory.endsWith(sep) ? info.directory : info.directory + sep;
    let path = dir + info.name;
    if (path.toLowerCase().startsWith(rootDirectory.toLowerCase())) {
      path = `.${path.slice(rootDirectory.length - 1)}`;
    }
    if (item.isDirectory) return path.endsWith(sep) ? path : path + sep;
    return `${path} [${info.size}, ${modificationStr(info.mtime)}]`;
  }

  synchronizePreview(localDirectory, remoteDirectory, items) {
    const localRoot = (() => {
      const p = this.resolveLocalPath(localDirectory);
      return p.endsWith(nodePath.sep) ? p : p + nodePath.sep;
    })();
    const remoteRoot = unixIncludeTrailingSlash(this.terminal.absolute(remoteDirectory));

    for (const item of items) {
      const localRecord = this.synchronizeFileRecord(localRoot, item, true);
      const remoteRecord = this.synchronizeFileRecord(remoteRoot, item, false);
      let message;
      switch (item.action) {
        case 'upload':
          message = item.remote.exists
            ? MSG.SYNC_UPLOAD_UPDATE(localRecord, remoteRecord)
            : MSG.SYNC_UPLOAD_NEW(localRecord);
          break;
        case 'download':
          message = item.local.exists
            ? MSG.SYNC_DOWNLOAD_UPDATE(remoteRecord, localRecord)
            : MSG.SYNC_DOWNLOAD_NEW(remoteRecord);
          break;
        case 'deleteRemote': message = MSG.SYNC_DELETE_REMOTE(remoteRecord); break;
        case 'deleteLocal': message = MSG.SYNC_DELETE_LOCAL(localRecord); break;
        default: continue;
      }
      this.printLine(message);
    }
  }

  /** The one-shot synchronize the keepuptodate watcher calls on every tick. */
  async synchronize(localDirectory, remoteDirectory, copyParam, synchronizeParams) {
    try {
      this.keepingUpToDate = true;
      const checklist = await this._collect(localDirectory, remoteDirectory, 'remote',
        copyParam, synchronizeParams);
      if (checklist.items.some((i) => i.checked && i.action !== 'nothing')) {
        await this._apply(checklist, copyParam, synchronizeParams);
      }
      this.print('');
      this.keepingUpToDate = false;
      return checklist;
    } catch (e) {
      this.keepingUpToDate = false;
      this.handleExtendedException(e);
      throw e;
    }
  }

  async keepUpToDateProc(params) {
    if (!this.onSynchronizeStartStop) throw new ScriptAbort('keepuptodate needs a watcher host.');

    this.checkSession();
    this.resetTransfer();

    this.checkDefaultCopyParam();
    const copyParam = { ...this._copyParam };
    this.copyParamParams(copyParam, params);

    const { localDirectory, remoteDirectory } = this.synchronizeDirectories(params, 1);

    this.checkDefaultSynchronizeParams();
    let synchronizeParams = this.synchronizeParams | SP.NO_CONFIRMATION;
    if (params.findSwitch('delete')) synchronizeParams |= SP.DELETE;

    this.checkParams(params);

    this.printLine(MSG.KEEPING_UP_TO_DATE);

    await this.onSynchronizeStartStop(this, localDirectory, remoteDirectory,
      copyParam, synchronizeParams);
  }

  queryCancel() {
    return this.onQueryCancel ? !!this.onQueryCancel(this) : false;
  }
}

// ---------------------------------------------------------------------------
// TManagementScript — the session-owning half
// ---------------------------------------------------------------------------

class ManagementScript extends Script {
  /**
   * @param {object} deps  everything Script takes, plus
   *   sessionManager  SessionManager used by `open`
   *   storedSessions  { findByName(name), isFolder(name), isWorkspace(name) }
   *   parseUrl        (url, options) => site data
   *   onInput         (script, prompt) => Promise<string>
   */
  constructor(deps = {}) {
    super(deps);
    this.sessionManager = deps.sessionManager || null;
    this.storedSessions = deps.storedSessions || null;
    this.parseUrl = deps.parseUrl || parseOpenUrl;
    this.onInput = deps.onInput || null;
    this.terminals = [];
    this.continue = true;

    this._register('exit', 'Closes all sessions and terminates the program', HELP.exit, this.exitProc, 0, 0, false);
    this._register('bye', '', HELP.exit, this.exitProc, 0, 0, false);
    this._register('open', 'Connects to server', HELP.open, this.openProc, 0, -1, true);
    this._register('close', 'Closes session', HELP.close, this.closeProc, 0, 1, false);
    this._register('session', 'Lists connected sessions or selects active session', HELP.session, this.sessionProc, 0, 1, false);
    this._register('lpwd', 'Prints local working directory', HELP.lpwd, this.lPwdProc, 0, 0, false);
    this._register('lcd', 'Changes local working directory', HELP.lcd, this.lCdProc, 1, 1, false);
    this._register('lls', 'Lists the contents of local directory', HELP.lls, this.lLsProc, 0, 1, false);
  }

  /** Passwords never reach the log: `open` lines are masked before logging. */
  getLogCmd(fullCommand, command) {
    if (this.resolveCommand(command).toLowerCase() !== 'open') return fullCommand;
    return maskPasswordInCommandLine(fullCommand);
  }

  async input(prompt, allowEmpty) {
    for (;;) {
      if (!this.onInput) throw new ScriptAbort('No input source.');
      const value = await this.onInput(this, prompt);
      const str = value === undefined || value === null ? '' : String(value);
      if (str.trim() !== '' || allowEmpty) return str;
    }
  }

  printActiveSession() {
    const index = this.terminals.indexOf(this.terminal) + 1;
    this.printLine(MSG.ACTIVE_SESSION(index, this.terminal.name));
  }

  findSession(index) {
    const i = parseInt(index, 10);
    if (!Number.isFinite(i) || i <= 0 || i > this.terminals.length) {
      throw new ScriptError(MSG.SESSION_INDEX_INVALID(index));
    }
    return this.terminals[i - 1];
  }

  handleExtendedException(error, terminal) {
    const result = super.handleExtendedException(error, terminal);
    const t = terminal || this.terminal;
    // A fatal error leaves a session that cannot be used again; drop it so the
    // next command reports "No session" instead of failing obscurely.
    if (t && t === this.terminal && error && error.fatal) {
      this.doClose(t).catch(() => {});
    }
    return result;
  }

  async connect(session, options, checkParams) {
    try {
      if (this.storedSessions
          && ((this.storedSessions.isFolder && this.storedSessions.isFolder(session))
            || (this.storedSessions.isWorkspace && this.storedSessions.isWorkspace(session)))) {
        throw new ScriptError(MSG.CANNOT_OPEN_SESSION_FOLDER);
      }

      let data = null;
      if (this.storedSessions && this.storedSessions.findByName) {
        data = this.storedSessions.findByName(session);
      }
      if (data) {
        // A stored site still takes the command-line switches, and consuming
        // them here is also what stops `open mysite -privatekey=x` from being
        // reported as an unknown switch below.
        data = { ...data, fromStoredSite: true };
        applyOpenSwitches(data, options);
      } else {
        data = this.parseUrl(session, options);
      }
      if (!data) throw new ScriptError(`Site '${session}' does not exist.`);

      if (checkParams) {
        if (options && options.paramCount > 1) throw new ScriptError(MSG.TOO_MANY_PARAMS('open'));
        if (options) this.checkParams(options);
      }

      if (session && data.fromStoredSite && this.batch !== 'off' && this.usageWarnings) {
        // A stored site makes a script unreproducible on another machine, so
        // WinSCP prints the equivalent explicit command.
        this.printLine(MSG.SITE_WARNING);
        this.printLine(`open ${generateOpenCommandArgs(data)}`);
      }

      if (!data.hostName) {
        data.hostName = await this.input(MSG.HOST_PROMPT, false);
      }

      const terminal = await this._newTerminal(data);
      this.terminals.push(terminal);
      this.terminal = terminal;
      this.logPendingLines(terminal);

      if (data.localDirectory) {
        try { this.changeLocalDirectory(data.localDirectory); } catch (e) {
          if (!this.handleExtendedException(e)) throw e;
        }
      }

      this.printActiveSession();
      return terminal;
    } catch (e) {
      if (e instanceof ScriptAbort) throw e;
      if (!this.handleExtendedException(e)) throw e;
      return null;
    }
  }

  async _newTerminal(data) {
    if (this.deps.openTerminal) return this.deps.openTerminal(data);
    if (!this.sessionManager) throw new ScriptError('No session manager is available for open.');
    const session = await this.sessionManager.open(data, { connect: true, closeOnFailure: true });
    const adapter = session.adapter;
    const terminal = new ScriptTerminal({
      adapter,
      session,
      name: data.name || data.hostName || adapter.protocolName,
      currentDirectory: data.remoteDirectory || adapter.home || '/',
    });
    if (data.remoteDirectory) await terminal.changeDirectory(data.remoteDirectory);
    return terminal;
  }

  async doClose(terminal) {
    const index = this.terminals.indexOf(terminal);
    const wasActive = this.terminal === terminal;
    try {
      const name = terminal.name;
      await terminal.close();
      if (index >= 0) this.terminals.splice(index, 1);
      if (wasActive) this.terminal = null;
      this.printLine(MSG.SESSION_CLOSED(name));
    } finally {
      if (wasActive) {
        if (this.terminals.length > 0) {
          this.terminal = index < this.terminals.length
            ? this.terminals[index] : this.terminals[0];
          this.printActiveSession();
        } else {
          this.printLine(MSG.NO_SESSION);
        }
      }
    }
  }

  async closeAll() {
    while (this.terminals.length > 0) {
      const t = this.terminals.pop();
      try { await t.close(); } catch { /* shutting down; a close error changes nothing */ }
    }
    this.terminal = null;
  }

  // ---- commands ---------------------------------------------------------

  async exitProc() { this.continue = false; }

  async openProc(params) {
    await this.connect(params.paramCount > 0 ? params.param(1) : '', params, true);
  }

  async closeProc(params) {
    this.checkSession();
    const terminal = params.paramCount === 0 ? this.terminal : this.findSession(params.param(1));
    await this.doClose(terminal);
  }

  async sessionProc(params) {
    this.checkSession();
    if (params.paramCount === 0) {
      for (let i = 0; i < this.terminals.length; i++) {
        this.printLine(`${padStart(i + 1, 3)}  ${this.terminals[i].name}`);
      }
      this.printActiveSession();
    } else {
      this.terminal = this.findSession(params.param(1));
      this.printActiveSession();
    }
  }

  async lPwdProc() { this.printLine(this.localDirectory); }

  async lCdProc(params) {
    this.changeLocalDirectory(params.param(1));
    this.printLine(this.localDirectory);
  }

  /**
   * `lls`. Column widths come from the FIRST row only — a WinSCP quirk that
   * makes a later long date overflow its column; ported so the output matches.
   */
  async lLsProc(params) {
    let directory = '';
    let mask = '';
    if (params.paramCount > 0) {
      directory = params.param(1);
      mask = localExtractFileName(directory);
      if (isMaskString(mask)) directory = localExtractFilePath(directory);
      else mask = '';
    }
    const dir = this.resolveLocalPath(directory || this.localDirectory);
    if (!mask) mask = '*.*';

    let names;
    try {
      names = this.fs.readdirSync(dir);
    } catch (e) {
      this.noMatchMask(mask, e.code === 'ENOENT' ? '' : e.message);
      return;
    }

    const fileMask = new FileMask(mask);
    const rows = [];
    for (const name of names) {
      if (name === '.') continue;
      let st;
      try { st = this.fs.statSync(nodePath.join(dir, name)); } catch { continue; }
      const isDir = st.isDirectory();
      if (!fileMask.matches(name, { isDir: false, size: isDir ? 0 : st.size, mtime: st.mtimeMs })) continue;
      rows.push({ name, isDir, size: st.size, mtime: st.mtimeMs });
    }

    if (rows.length === 0) { this.noMatchMask(mask, ''); return; }

    let dateLen = 0;
    let timeLen = 0;
    let first = true;
    for (const row of rows) {
      const d = new Date(row.mtime);
      const dateStr = fixedDate(d);
      const timeStr = fixedTime(d);
      if (first) {
        if (timeLen < timeStr.length) timeLen = timeStr.length;
        if (dateLen < dateStr.length) dateLen = dateStr.length;
        first = false;
      }
      const sizeStr = row.isDir ? '<DIR>' : padStart(row.size.toLocaleString('en-US'), 14);
      this.printLine(`${pad(dateStr, dateLen)}  ${pad(timeStr, timeLen)}    ${pad(sizeStr, 14)} ${row.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** TFileMasks::IsMask — does the string contain a wildcard at all? */
function isMaskString(str) {
  return typeof str === 'string' && /[?*[]/.test(str);
}

function parseTransferModeName(name) {
  const r = findCommand(TRANSFER_MODE_NAMES, name);
  if (r.index < 0) throw new ScriptError(MSG.VALUE_UNKNOWN('transfer', name));
  // The queue calls the ascii mode "text".
  return ['binary', 'text', 'automatic'][r.index];
}

/** `-permissions=644` → the rights string the copy params use. */
function rightsFromOctal(octal) {
  const digits = String(octal).trim();
  // Three or four octal digits, exactly as the help text says. A partially
  // valid value such as `64x` must be refused rather than quietly become 064.
  if (!/^[0-7]{3,4}$/.test(digits)) throw new ScriptError(MSG.VALUE_UNKNOWN(octal, 'permissions'));
  const n = parseInt(digits, 8);
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) {
    out += (n & (1 << (8 - i))) ? bits[i] : '-';
  }
  // setuid/setgid/sticky, exactly as WinSCP's four-digit form allows.
  if (n & 0o4000) out = out.slice(0, 2) + (out[2] === 'x' ? 's' : 'S') + out.slice(3);
  if (n & 0o2000) out = out.slice(0, 5) + (out[5] === 'x' ? 's' : 'S') + out.slice(6);
  if (n & 0o1000) out = out.slice(0, 8) + (out[8] === 'x' ? 't' : 'T');
  return out;
}

function coerceRawValue(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  return value;
}

/** `-criteria=` accepts a name or a comma-separated list. */
function applyCriteria(synchronizeParams, value) {
  const NAMED = ['none', 'either', 'both'];
  const named = findCommand(NAMED, value);
  let params = synchronizeParams;
  if (named.index >= 0) {
    if (named.index === 0) {
      params |= SP.NOT_BY_TIME;
      params &= ~SP.BY_SIZE;
    } else {
      params &= ~SP.NOT_BY_TIME;
      params |= SP.BY_SIZE;
    }
    return params;
  }

  const LIST = ['time', 'size', 'checksum'];
  let acc = SP.NOT_BY_TIME;
  let ok = true;
  for (const token of String(value).split(',')) {
    const t = token.trim();
    if (t === '') continue;
    const r = findCommand(LIST, t);
    if (r.index === 0) acc &= ~SP.NOT_BY_TIME;
    else if (r.index === 1) acc |= SP.BY_SIZE;
    else if (r.index === 2) acc |= SP.BY_CHECKSUM;
    else { ok = false; break; }
  }
  if (ok) {
    params &= ~(SP.NOT_BY_TIME | SP.BY_SIZE | SP.BY_CHECKSUM);
    params |= acc;
  }
  return params;
}

/** Translate the flag word into the option object sync.js expects. */
function syncOptionsFrom(direction, synchronizeParams, copyParam) {
  const notByTime = !!(synchronizeParams & SP.NOT_BY_TIME);
  const bySize = !!(synchronizeParams & SP.BY_SIZE);
  let criteria = 'time';
  if (notByTime && bySize) criteria = 'size';
  else if (notByTime) criteria = 'none';
  else if (bySize) criteria = 'either';

  let mode = 'synchronize';
  if (synchronizeParams & SP.TIMESTAMP) mode = 'timestamp';
  else if (synchronizeParams & SP.MIRROR) mode = 'mirror';

  return {
    direction,
    mode,
    criteria: direction === 'both' ? 'time' : criteria,
    deleteFiles: !!(synchronizeParams & SP.DELETE),
    existingOnly: !!(synchronizeParams & SP.EXISTING_ONLY),
    caseSensitive: !!(synchronizeParams & SP.CASE_SENSITIVE),
    recursive: true,
    fileMask: copyParam.includeFileMask || '',
    transferMode: copyParam.transferMode === 'text' ? 'text' : copyParam.transferMode,
    excludeHiddenFiles: !!copyParam.excludeHiddenFiles,
    followDirectorySymlinks: !!copyParam.followDirectorySymlinks,
    copyParam,
  };
}

function arrowFor(direction) {
  if (direction === 'remote') return '=>';
  if (direction === 'local') return '<=';
  return '<=>';
}

/** MinimizeName: keep the tail, elide the middle with "...". */
function minimizeName(name, limit) {
  if (name.length <= limit) return name;
  if (limit <= 3) return name.slice(name.length - limit);
  return `...${name.slice(name.length - (limit - 3))}`;
}

function fixedDate(d) {
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function fixedTime(d) {
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Values that must never appear in a log or a title. */
const SENSITIVE_SWITCHES = ['password', 'passphrase', 'newpassword', 'privatekeypassphrase',
  'tunnelpassword', 'secure', 'clientcertpassphrase'];
const PASSWORD_MASK = '***';

/**
 * MaskPasswordInCommandLine: replace the password in a URL and in any sensitive
 * switch, so `open sftp://u:p@h` can be logged and echoed without leaking.
 */
function maskPasswordInCommandLine(commandLine) {
  let rest = String(commandLine);
  const out = [];
  let seenUrl = false;
  let first = true;

  for (;;) {
    const cut = cutToken(rest);
    if (!cut.ok) break;
    rest = cut.rest;
    let piece = cut.raw;

    if (first) { first = false; out.push(piece); continue; }

    const token = cut.token;
    const markMatch = /^([-/])([A-Za-z?][A-Za-z0-9?-]*)([=:])?([\s\S]*)$/.exec(token);
    if (markMatch) {
      const name = markMatch[2].toLowerCase();
      if (SENSITIVE_SWITCHES.includes(name)) {
        piece = `${markMatch[1]}${markMatch[2]}=${PASSWORD_MASK}`;
      }
    } else if (!seenUrl) {
      seenUrl = true;
      piece = addQuotes(maskPasswordInUrl(token));
    }
    out.push(piece);
  }
  return out.join(' ');
}

function maskPasswordInUrl(url) {
  return String(url).replace(
    /^([a-z0-9+.-]+:\/\/)([^/@]*?):([^/@]*)@/i,
    (_m, scheme, user) => `${scheme}${user}:${PASSWORD_MASK}@`);
}

/**
 * The `open` command's URL and switch parsing. It intentionally accepts the
 * switches the help text documents and nothing else, so a typo is reported as
 * an unknown switch instead of being silently ignored.
 */
function parseOpenUrl(url, options) {
  const data = {
    protocol: 'sftp',
    hostName: '',
    portNumber: 0,
    userName: '',
    password: '',
    ftps: 'none',
    remoteDirectory: '',
  };

  const text = String(url || '').trim();
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(text);
  let authority = text;

  if (m) {
    const scheme = m[1].toLowerCase();
    const known = {
      sftp: ['sftp', 'none'], scp: ['scp', 'none'],
      ftp: ['ftp', 'none'], ftps: ['ftp', 'implicit'], ftpes: ['ftp', 'explicitTls'],
      dav: ['webdav', 'none'], davs: ['webdav', 'implicit'],
      http: ['webdav', 'none'], https: ['webdav', 'implicit'],
      s3: ['s3', 'implicit'],
    };
    if (!known[scheme]) throw new ScriptError(`Unknown protocol '${scheme}'.`);
    data.protocol = known[scheme][0];
    data.ftps = known[scheme][1];
    authority = m[2];
  }

  const slash = authority.indexOf('/');
  if (slash >= 0) {
    const remote = authority.slice(slash);
    if (remote !== '/') data.remoteDirectory = decodeURIComponent(remote);
    authority = authority.slice(0, slash);
  }

  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const credentials = authority.slice(0, at);
    authority = authority.slice(at + 1);
    const colon = credentials.indexOf(':');
    data.userName = decodeURIComponent(colon < 0 ? credentials : credentials.slice(0, colon));
    if (colon >= 0) data.password = decodeURIComponent(credentials.slice(colon + 1));
  }

  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    data.hostName = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after.startsWith(':')) data.portNumber = Number(after.slice(1)) || 0;
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      data.hostName = decodeURIComponent(authority.slice(0, colon));
      data.portNumber = Number(authority.slice(colon + 1)) || 0;
    } else {
      data.hostName = decodeURIComponent(authority);
    }
  }

  // A port given in the URL is DEFINED, and a TLS switch must not overwrite it.
  const portNumberDefined = data.portNumber > 0;
  applyOpenSwitches(data, options, portNumberDefined);

  if (!data.portNumber) {
    // TSessionData::GetDefaultPort — implicit FTPS is 990. Answering 21 for it
    // connected to the plaintext control port and then tried to negotiate TLS
    // on a socket the server never expected it on.
    data.portNumber = data.protocol === 'ftp'
      ? (data.ftps === 'implicit' ? FTPS_IMPLICIT_PORT : FTP_PORT)
      : ({ sftp: 22, scp: 22, webdav: data.ftps === 'implicit' ? 443 : 80, s3: 443 }[data.protocol] || 0);
  }
  return data;
}

/**
 * The switches the `open` help text documents, applied onto session data.
 *
 * Every one of them is looked up even when it is absent, because looking a
 * switch up is what marks it "used" — anything left over afterwards is what
 * `checkParams` reports as an unknown switch.
 */
function applyOpenSwitches(data, options, portNumberDefined) {
  if (!options) return data;

  const take = (name) => {
    const r = options.locateSwitch(name);
    return r.found ? r.value : undefined;
  };

  const privateKey = take('privatekey');
  if (privateKey !== undefined) data.publicKeyFile = privateKey;
  const clientCert = take('clientcert');
  if (clientCert !== undefined) data.tlsClientCertificate = clientCert;
  const passphrase = take('passphrase');
  if (passphrase !== undefined) data.passphrase = passphrase;
  const username = take('username');
  if (username !== undefined) data.userName = username;
  const password = take('password');
  if (password !== undefined) data.password = password;
  // -sessionname names the session in the log and the tab. Not consuming it at
  // all meant an existing script carrying it stopped with "Unknown switch".
  const sessionName = take('sessionname');
  if (sessionName !== undefined) data.name = sessionName;
  const newPassword = take('newpassword');
  if (newPassword !== undefined) {
    // ChangePassword is the flag that actually triggers the change; recording
    // the new password without it left the switch doing nothing at all.
    data.newPassword = newPassword;
    data.changePassword = true;
  }
  const timeout = take('timeout');
  if (timeout !== undefined) data.timeout = Number(timeout) || 0;

  // -hostkey and -certificate are the SAME assignment in the original, and both
  // set FOverrideCachedHostKey — without it a fingerprint pinned on the command
  // line does not override the one already cached, which is not what the user
  // asked for.
  const hostKey = take('hostkey');
  const certificate = take('certificate');
  const pinned = hostKey !== undefined ? hostKey : certificate;
  if (pinned !== undefined) {
    data.hostKey = pinned;
    data.overrideCachedHostKey = true;
  }

  data.ftpPasvMode = options.switchValueBool('passive', data.ftpPasvMode !== false, data.ftpPasvMode !== false);

  // Every TLS switch reads its VALUE as a boolean, so `-implicit=off` turns
  // implicit TLS OFF. Treating the switch's mere presence as "on" dialled an
  // implicit-TLS connection for a user who had explicitly asked for plaintext —
  // a wrong-protocol connection, not a missing feature. The port defaults
  // follow the same rule: implicit FTPS is 990, not 21, and an explicit port in
  // the URL always wins.
  if (options.findSwitch('implicit')) {
    const enabled = options.switchValueBool('implicit', true);
    data.ftps = enabled ? 'implicit' : 'none';
    if (!portNumberDefined && enabled) data.portNumber = FTPS_IMPLICIT_PORT;
  }
  // Backward compatibility with 5.5.x: -explicitssl and -explicittls.
  if (options.findSwitch('explicitssl')) {
    const enabled = options.switchValueBool('explicitssl', true);
    data.ftps = enabled ? 'explicitSsl' : 'none';
    if (!portNumberDefined && enabled) data.portNumber = FTP_PORT;
  }
  if (options.findSwitch('explicit') || options.findSwitch('explicittls')) {
    const name = options.findSwitch('explicit') ? 'explicit' : 'explicittls';
    const enabled = options.switchValueBool(name, true);
    data.ftps = enabled ? 'explicitTls' : 'none';
    if (!portNumberDefined && enabled) data.portNumber = FTP_PORT;
  }

  if (options.findSwitch('passwordsfromfiles')) data.passwordsFromFiles = true;
  // `-filezilla` selects a different site source; consumed here so it is not
  // reported as unknown even where no FileZilla site list is available.
  options.findSwitch('filezilla');

  const raw = options.findSwitchParams('rawsettings');
  if (raw) {
    data.rawSettings = { ...(data.rawSettings || {}) };
    for (const setting of raw) {
      const eq = setting.indexOf('=');
      if (eq < 0) continue;
      data.rawSettings[setting.slice(0, eq)] = setting.slice(eq + 1);
    }
  }
  return data;
}

/** GenerateOpenCommandArgs, with every secret masked. */
function generateOpenCommandArgs(data) {
  const scheme = data.protocol === 'webdav'
    ? (data.ftps === 'implicit' ? 'davs' : 'dav')
    : (data.protocol === 'ftp' && data.ftps === 'implicit' ? 'ftps' : data.protocol);
  const user = data.userName ? `${encodeURIComponent(data.userName)}${data.password ? `:${PASSWORD_MASK}` : ''}@` : '';
  const port = data.portNumber ? `:${data.portNumber}` : '';
  let out = addQuotes(`${scheme}://${user}${data.hostName}${port}/`);
  if (data.hostKey) out += ` -hostkey=${addQuotes(data.hostKey)}`;
  if (data.publicKeyFile) out += ` -privatekey=${addQuotes(data.publicKeyFile)}`;
  return out;
}

// ---------------------------------------------------------------------------
// help texts — transcribed from resource/TextsCore2.rc
// ---------------------------------------------------------------------------

const HELP = {
  help:
    'help [ <command> [ <command2> ... ] ]\n'
    + '  Displays list of commands when no parameters are specified.\n'
    + '  Displays help for each command when some are specified.\n'
    + 'alias:\n  man\nexamples:\n  help\n  help ls\n',
  exit:
    'exit\n  Closes all sessions and terminates the program.\nalias:\n  bye\n',
  open:
    'open <site>\n'
    + 'open sftp|scp|ftp[es]|dav[s]|s3 :// [ <user> [ :password ] @ ] <host> [ :<port> ]\n'
    + '  Establishes connection to given host. Use either name of the site or\n'
    + '  specify host, username, port and protocol directly.\n'
    + 'switches:\n'
    + '  -privatekey=<file> SSH private key file\n'
    + '  -hostkey=<fingerprint> Fingerprint of server host key (SFTP and SCP only).\n'
    + '  -clientcert=<file> TLS/SSL client certificate file\n'
    + '  -certificate=<fingerprint> Fingerprint of TLS/SSL certificate\n'
    + '                     (FTPS and WebDAVS only)\n'
    + '  -passphrase=<phr>  Private key passphrase\n'
    + '  -passive=on|off    Passive mode (FTP protocol only)\n'
    + '  -implicit          Implicit TLS/SSL (FTP protocol only)\n'
    + '  -explicit          Explicit TLS/SSL (FTP protocol only)\n'
    + '  -timeout=<sec>     Server response timeout\n'
    + '  -username=<user>   An alternative way to provide a username\n'
    + '  -password=<password> An alternative way to provide a password\n'
    + '  -rawsettings setting1=value1 setting2=value2 ...\n'
    + '                     Configures any site settings using raw format\n'
    + '                     as in an INI file\n'
    + '  -newpassword=<password> Changes password to <password>\n'
    + '  -passwordsfromfiles Read all passwords from files\n'
    + 'examples:\n  open\n  open sftp://martin@example.com:2222 -privatekey=mykey.ppk\n'
    + '  open martin@example.com\n  open example.com\n',
  close:
    'close [ <session> ]\n'
    + '  Closes session specified by its number. When session number is not\n'
    + '  specified, closes currently selected session.\n'
    + 'examples:\n  close\n  close 1\n',
  session:
    'session [ <session> ]\n'
    + '  Makes session specified by its number active. When session number\n'
    + '  is not specified, lists connected sessions.\n'
    + 'examples:\n  session\n  session 1\n',
  pwd: 'pwd\n  Prints current remote working directory for active session.\n',
  cd:
    'cd [ <directory> ]\n'
    + '  Changes remote working directory for active session.\n'
    + '  If directory is not specified, changes to home directory.\n'
    + 'examples:\n  cd /home/martin\n  cd\n',
  ls:
    'ls [ <directory> ]/[ <wildcard> ]\n'
    + '  Lists the contents of specified remote directory. If directory is \n'
    + '  not specified, lists working directory.\n'
    + '  When wildcard is specified, it is treated as set of files to list.\n'
    + '  Otherwise, all files are listed.\n'
    + 'alias:\n  dir\neffective option:\n  failonnomatch\n'
    + 'examples:\n  ls\n  ls *.html\n  ls /home/martin\n',
  lpwd: 'lpwd\n  Prints current local working directory (valid for all sessions).\n',
  lcd: 'lcd <directory>\n  Changes local working directory for all sessions.\nexample:\n  lcd d:\\\n',
  lls:
    'lls [ <directory> ]\\[ <wildcard> ]\n'
    + '  Lists the contents of specified local directory. If directory is \n'
    + '  not specified, lists working directory.\n'
    + '  When wildcard is specified, it is treated as set of files to list.\n'
    + '  Otherwise, all files are listed.\n'
    + 'effective option:\n  failonnomatch\n'
    + 'examples:\n  lls\n  lls *.html\n  lls d:\\\n',
  rm:
    'rm <file> [ <file2> ... ]\n'
    + '  Removes one or more remote files. If remote recycle bin is\n'
    + '  configured, moves file to the bin instead of deleting it.\n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + 'effective option:\n  failonnomatch\n'
    + 'examples:\n  rm index.html\n  rm index.html about.html\n  rm *.html\n',
  rmdir:
    'rmdir <directory> [ <directory2> ... ]\n'
    + '  Removes one or more remote directories. If remote recycle bin is\n'
    + '  configured, moves directory to the bin instead of deleting it.\n'
    + 'example:\n  rmdir public_html\n',
  mv:
    'mv <file> [ <file2> ... ] [ <directory>/ ][ <newname> ]\n'
    + '  Moves or renames one or more remote files. Destination directory or new\n'
    + '  name or both must be specified. Destination directory must end with \n'
    + '  slash. Operation mask can be used instead of new name.\n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + 'alias:\n  rename\neffective option:\n  failonnomatch\n'
    + 'examples:\n  mv index.html public_html/\n  mv index.html about.*\n'
    + '  mv index.html public_html/about.*\n'
    + '  mv public_html/index.html public_html/about.html /home/martin/*.bak\n'
    + '  mv *.html /home/backup/*.bak\n',
  cp:
    'cp <file> [ <file2> ... ] [ <directory>/ ][ <newname> ]\n'
    + '  Duplicates one or more remote files. Destination directory or new\n'
    + '  name or both must be specified. Destination directory must end with\n'
    + '  slash. Operation mask can be used instead of new name.\n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + 'effective option:\n  failonnomatch\n'
    + 'examples:\n  cp index.html public_html/\n  cp index.html about.*\n'
    + '  cp index.html public_html/about.*\n'
    + '  cp public_html/index.html public_html/about.html /home/martin/*.bak\n'
    + '  cp *.html /home/backup/*.bak\n',
  chmod:
    'chmod <mode> <file> [ <file2> ... ]\n'
    + '  Changes permissions of one or more remote files. Mode can be specified\n'
    + '  as three or four-digit octal number.\n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + 'effective option:\n  failonnomatch\n'
    + 'examples:\n  chmod 644 index.html about.html\n  chmod 1700 /home/martin/public_html\n'
    + '  chmod 644 *.html\n',
  ln: 'ln <target> <symlink>\n  Creates remote symbolic link.\nalias:\n  symlink\n'
    + 'example:\n  ln /home/martin/public_html www\n',
  mkdir: 'mkdir <directory>\n  Creates remote directory.\nexample:\n  mkdir public_html\n',
  get:
    'get <file> [ [ <file2> ... ] <directory>\\[ <newname> ] ]\n'
    + '  Downloads one or more files from remote directory to local directory.\n'
    + '  If only one parameter is specified downloads the file to local working\n'
    + '  directory. If more parameters are specified, all except the last one\n'
    + '  specify set of files to download. The last parameter specifies target\n'
    + '  local directory and optionally operation mask to store file(s) under\n'
    + '  different name. Destination directory must end with backslash. \n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + "  To download more files to current working directory use '.\\' as the\n"
    + '  last parameter.\n'
    + 'alias:\n  recv, mget\n'
    + 'switches:\n'
    + '  -delete          Delete source remote file(s) after transfer\n'
    + '  -resume          Resume transfer if possible (SFTP and FTP protocols only)\n'
    + '  -append          Append file to end of target file (SFTP protocol only)\n'
    + '  -preservetime    Preserve timestamp\n'
    + '  -nopreservetime  Do not preserve timestamp\n'
    + '  -speed=<kbps>    Limit transfer speed (in KB/s)\n'
    + '  -transfer=<mode> Transfer mode: binary, ascii, automatic\n'
    + '  -filemask=<mask> Sets file mask.\n'
    + '  -resumesupport=<state> Configures resume support.\n'
    + "                   Possible values are 'on', 'off' or threshold\n"
    + '  -neweronly       Transfer new and updated files only\n'
    + '  -latest          Transfer the latest file only\n'
    + 'effective options:\n  confirm, failonnomatch, reconnecttime\n'
    + 'examples:\n  get index.html\n  get -delete index.html about.html .\\\n'
    + '  get index.html about.html d:\\www\\\n  get public_html/index.html d:\\www\\about.*\n'
    + '  get *.html *.png d:\\www\\*.bak\n',
  put:
    'put <file> [ [ <file2> ... ] <directory>/[ <newname> ] ]\n'
    + '  Uploads one or more files from local directory to remote directory.\n'
    + '  If only one parameter is specified uploads the file to remote working\n'
    + '  directory. If more parameters are specified, all except the last one\n'
    + '  specify set of files to upload. The last parameter specifies target\n'
    + '  remote directory and optionally operation mask to store file(s) under\n'
    + '  different name. Destination directory must end with slash. \n'
    + '  Filename can be replaced with wildcard to select multiple files.\n'
    + "  To upload more files to current working directory use './' as the\n"
    + '  last parameter.\n'
    + 'alias:\n  send, mput\n'
    + 'switches:\n'
    + '  -delete             Delete source local file(s) after transfer\n'
    + '  -resume             Resume transfer if possible (SFTP and FTP protocols only)\n'
    + '  -append             Append file to end of target file (SFTP protocol only)\n'
    + '  -preservetime       Preserve timestamp\n'
    + '  -nopreservetime     Do not preserve timestamp\n'
    + '  -permissions=<mode> Set permissions\n'
    + '  -nopermissions      Keep default permissions\n'
    + '  -speed=<kbps>       Limit transfer speed (in KB/s)\n'
    + '  -transfer=<mode>    Transfer mode: binary, ascii, automatic\n'
    + '  -filemask=<mask>    Sets file mask.\n'
    + '  -resumesupport=<state> Configures resume support.\n'
    + "                      Possible values are 'on', 'off' or threshold\n"
    + '  -neweronly          Transfer new and updated files only\n'
    + '  -latest             Transfer the latest file only\n'
    + 'effective options:\n  confirm, failonnomatch, reconnecttime\n'
    + 'examples:\n  put index.html\n  put -delete index.html about.html ./\n'
    + '  put -permissions=644 index.html about.html /home/martin/public_html/\n'
    + '  put d:\\www\\index.html about.*\n  put *.html *.png /home/martin/backup/*.bak\n',
  option:
    'option [ <option> [ <value> ] ]\n'
    + '  If no parameters are specified, lists all script options and their\n'
    + '  values. When one parameter is specified only, shows value of the option.\n'
    + '  When two parameters are specified sets value of the option.\n'
    + '  Initial values of some options are taken from application configuration,\n'
    + '  however modifing the options does not change the application\n'
    + '  configuration.\n'
    + 'options are:\n'
    + '  echo     on|off\n'
    + '           Toggles echoing of command being executed.\n'
    + '           Commands affected: all\n'
    + '  batch    on|off|abort|continue\n'
    + '           Toggles batch mode (all prompts are automatically replied\n'
    + "           negatively). When 'on', it is recommended to set 'confirm'\n"
    + "           to 'off' to allow overwrites. With 'abort', script is aborted\n"
    + "           when any error occurs. With 'continue', all errors are ignored.\n"
    + '           Reconnect time is automatically limited do 120s, if not limited yet.\n'
    + '           Commands affected: nearly all\n'
    + '  confirm  on|off\n'
    + '           Toggles confirmations (overwrite, etc.).\n'
    + '           Commands affected: get, put\n'
    + '  reconnecttime off | <sec>\n'
    + '           Time limit in seconds to try reconnecting broken sessions.\n'
    + '           Commands affected: get, put, synchronize, keepuptodate\n'
    + '  failonnomatch on|off\n'
    + "           When 'on', commands fail when file mask matches no files.\n"
    + "           When 'off', commands do nothing when file mask matches no files.\n"
    + '           Commands affected: get, put, rm, mv, chmod, ls, lls\n'
    + 'examples:\n  option\n  option batch\n  option confirm off\n',
  synchronize:
    'synchronize local|remote|both [ <local directory> [ <remote directory> ] ]\n'
    + "  When the first parameter is 'local' synchronises local directory with\n"
    + "  remote one. When the first parameter is 'remote' synchronises remote\n"
    + "  directory with local one. When the first parameter is 'both' synchronises\n"
    + '  directories one against the other.\n'
    + '  When directories are not specified, current working directories are\n'
    + '  synchronized.\n'
    + '  Note: Overwrite confirmations are always off for the command.\n'
    + 'switches:\n'
    + '  -preview             Preview changes only, do not synchronize\n'
    + '  -delete              Delete obsolete files\n'
    + '  -mirror              Mirror mode (synchronize also older files).\n'
    + "                       Ignored for 'both'.\n"
    + "  -criteria=<criteria> Comparison criteria. Possible values are 'none', 'time',\n"
    + "                       'size' and 'either'. Ignored for 'both' mode.\n"
    + '  -permissions=<mode>  Set permissions\n'
    + '  -nopermissions       Keep default permissions\n'
    + '  -speed=<kbps>        Limit transfer speed (in KB/s)\n'
    + '  -transfer=<mode>     Transfer mode: binary, ascii, automatic\n'
    + '  -filemask=<mask>     Sets file mask.\n'
    + '  -resumesupport=<state> Configures resume support.\n'
    + "                       Possible values are 'on', 'off' or threshold\n"
    + 'effective options:\n  reconnecttime\n'
    + 'examples:\n  synchronize remote -delete\n  synchronize both d:\\www /home/martin/public_html\n',
  keepuptodate:
    'keepuptodate [ <local directory> [ <remote directory> ] ]\n'
    + '  Watches for changes in local directory and reflects them on remote one.\n'
    + '  When directories are not specified, current working directories are\n'
    + '  synchronized. To stop watching for changes press Ctrl-C.\n'
    + '  Note: Overwrite confirmations are always off for the command.\n'
    + 'switches:\n'
    + '  -delete             Delete obsolete files\n'
    + '  -permissions=<mode> Set permissions\n'
    + '  -nopermissions      Keep default permissions\n'
    + '  -speed=<kbps>       Limit transfer speed (in KB/s)\n'
    + '  -transfer=<mode>    Transfer mode: binary, ascii, automatic\n'
    + '  -filemask=<mask>    Sets file mask.\n'
    + '  -resumesupport=<state> Configures resume support.\n'
    + "                      Possible values are 'on', 'off' or threshold\n"
    + 'effective options:\n  reconnecttime\n'
    + 'examples:\n  keepuptodate -delete\n  keepuptodate d:\\www /home/martin/public_html\n',
  call:
    'call <command>\n'
    + '  With SFTP and SCP protocols, executes arbitrary remote shell command.\n'
    + '  If current session does not allow execution of arbitrary remote command\n'
    + '  separate shell session will be automatically opened.\n'
    + '  With FTP protocol, executes a protocol command.\n'
    + '  The command must not require user input.\n'
    + 'alias:\n  !\nexample:\n  call touch index.html\n',
  echo: 'echo <message>\n  Prints message onto script output.\nexample:\n  echo Starting upload...\n',
  stat: 'stat <file>\n  Retrieves and lists attributes of specified remote file.\nexample:\n  stat index.html\n',
  checksum: 'checksum <alg> <file>\n  Calculates checksum of remote file.\nexample:\n  checksum sha-1 index.html\n',
};

module.exports = {
  Script,
  ManagementScript,
  ScriptTerminal,
  Options,
  ScriptProcParams,
  ScriptError,
  NotSupportedError,
  ScriptAbort,
  cutToken,
  tokenize,
  addQuotes,
  findCommand,
  maskFilePart,
  maskFileName,
  isFileNameMask,
  isMaskString,
  listingStr,
  modificationStr,
  minimizeName,
  parseTransferModeName,
  rightsFromOctal,
  applyCriteria,
  syncOptionsFrom,
  maskPasswordInCommandLine,
  parseOpenUrl,
  applyOpenSwitches,
  generateOpenCommandArgs,
  unixExcludeTrailingSlash,
  unixIncludeTrailingSlash,
  unixExtractFilePath,
  unixExtractFileName,
  localExtractFilePath,
  localExtractFileName,
  winExcludeTrailingSlash,
  BATCH_MODE_NAMES,
  TOGGLE_NAMES,
  TRANSFER_MODE_NAMES,
  BATCH_SESSION_REOPEN_TIMEOUT,
  FLT,
  SP,
  MSG,
  HELP,
};
