// winconfig.js — the layer between the raw configuration store and the
// application's behaviour.
//
// Port of windows/WinConfiguration.cpp, windows/CustomWinConfiguration.cpp and
// windows/GUIConfiguration.cpp. `config.js` is the store: it reads and writes
// JSON atomically and knows nothing about what an option *means*. This module
// is everything WinSCP puts on top of that:
//
//   * the version-upgrade migrations WinSCP performs when it reads an older
//     configuration. This is the part that silently loses settings when it is
//     wrong, so every migration here names the C++ it comes from and every one
//     of them is covered by a test that starts from an old-shaped object.
//   * the editor list — masks, matching order, the derived display name, and
//     the legacy single-editor record that older versions stored instead.
//   * the custom command list and the extension mechanism (`.WinSCPextension`
//     files: directives, option controls, dependency refusals, ordering,
//     deletion tracking and shortcut overrides).
//   * the transfer preset list with its auto-selection rules.
//   * the bookmark store and the location profiles that share it.
//   * the "interface" state: Commander vs Explorer, panel/toolbar/column
//     layouts, and the per-panel state each interface remembers.
//   * the file-colour rules.
//   * the temporary-directory policy.
//
// WHY a separate module: WinSCP's TWinConfiguration is a 5,000-line god object
// because it is also the VCL glue. Everything here is data in, data out, so it
// can be tested headlessly — which is the only way the migrations get checked
// at all, since by definition nobody runs them twice.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const masks = require('./masks');
const { PREF_DEFAULTS, COPY_PARAM_DEFAULTS } = require('./defaults');

// ---------------------------------------------------------------------------
// enumerations
//
// WinSCP stores enums as their ordinal, so every list below is ORDER-SENSITIVE:
// the index is the on-disk value. Renaming a member is safe; reordering one
// silently rewrites the user's setting to a different one.
// ---------------------------------------------------------------------------

/** TEditor: edInternal, edExternal, edOpen. */
const EDITOR = ['internal', 'external', 'open'];

/**
 * TDoubleClickAction. The header says "constants must be compatible with legacy
 * CopyOnDoubleClick", which was a bool: false(0) meant open, true(1) meant copy.
 * dcaEdit was appended as 2 and is the current default.
 */
const DOUBLE_CLICK_ACTION = ['open', 'copy', 'edit'];

/** TResolvedDoubleClickAction — what a double click actually does, once resolved. */
const RESOLVED_DOUBLE_CLICK = ['none', 'changeDir', 'open', 'copy', 'edit'];

/** TAutoSwitch — asOn, asOff, asAuto. Matches PuTTY's FORCE_ON/FORCE_OFF/AUTO. */
const AUTO_SWITCH = ['on', 'off', 'auto'];

/**
 * TFormatBytesStyle. BaseUtils.pas: "order chosen so that for previous bool
 * value, false maps to fbNone and true maps to the new default fbKilobytes".
 * That comment is the whole migration.
 */
const FORMAT_BYTES = ['none', 'kilo', 'short'];

/** TNortonLikeMode (NortonLikeListView.pas): nlOn, nlOff, nlKeyboard. */
const NORTON_LIKE = ['on', 'off', 'keyboard'];

/** TIncrementalSearch: isOff = -1, then isNameStartOnly, isName, isAll. */
const PANEL_SEARCH = ['nameStart', 'name', 'all'];

/** TQueueViewShow. */
const QUEUE_VIEW_SHOW = ['show', 'hideWhenEmpty', 'hide'];

/** TPathInCaption: picShort, picFull, picNone. */
const PATH_IN_CAPTION = ['short', 'full', 'none'];

/** TSessionTabNameFormat. */
const SESSION_TAB_NAME_FORMAT = ['none', 'shortPath', 'shortPathTrunc'];

/** TInterface: ifCommander, ifExplorer. */
const INTERFACE = ['commander', 'explorer'];

/** TStoreTransition. */
const STORE_TRANSITION = ['init', 'standard', 'storeFresh', 'storeMigrated', 'storeAcknowledged'];

/** TGenerateUrlCodeTarget. */
const GENERATE_URL_CODE_TARGET = ['url', 'script', 'assembly'];

/** TScriptFormat. */
const SCRIPT_FORMAT = ['scriptFile', 'batchFile', 'commandLine', 'powerShell'];

/** TLocaleFlagOverride. */
const LOCALE_FLAG_OVERRIDE = ['languageIfRecommended', 'language', 'always', 'never'];

/** TConnectionType: ctUndefined = -1, ctDirect, ctAuto, ctProxy. */
const CONNECTION_TYPE = ['direct', 'auto', 'proxy'];

/**
 * Custom-command parameter bits. ccApplyToDirectories/ccRecursive come from
 * core/Terminal.h; the rest are GUIConfiguration.cpp's `ccUser << n`.
 */
const CC = {
  APPLY_TO_DIRECTORIES: 0x001,
  RECURSIVE: 0x002,
  LOCAL: 0x100,
  SHOW_RESULTS: 0x200,
  COPY_RESULTS: 0x400,
  REMOTE_FILES: 0x800,
  SHOW_RESULTS_IN_MSGBOX: 0x1000,
  SET: 0x80000000,
};

/** TCustomCommandType::TOptionKind. */
const OPTION_KIND = ['unknown', 'label', 'link', 'separator', 'group',
  'textBox', 'file', 'dropDownList', 'comboBox', 'checkBox'];

/** TCustomCommandType::TOptionFlag. */
const OPTION_FLAG = { RUN: 0x01, CONFIG: 0x02, SITE: 0x04 };

/**
 * TGUIConfiguration::Default's FDefaultPuttyPath. The pre-3.7.1 quoting repair
 * compares against THIS, not against whatever the store currently holds.
 */
const DEFAULT_PUTTY_PATH = '%PROGRAMFILES%\\PuTTY\\putty.exe';

/** The default external editor, and the file extension an extension carries. */
const DEFAULT_EXTERNAL_EDITOR = 'notepad.exe';
const EXTENSION_EXT = '.WinSCPextension';

/** TBookmarks::FSharedKey — TNamedObjectList::HiddenPrefix + "shared". */
const HIDDEN_PREFIX = '_!_';
const SHARED_BOOKMARKS_KEY = HIDDEN_PREFIX + 'shared';

/** TCopyParamList::FInvalidChars — a preset name is a storage key. */
const PRESET_INVALID_CHARS = '/\\[]';

/** The shell command placeholder ReformatFileNameCommand appends. */
const SHELL_COMMAND_FILE_NAME_PATTERN = '!.!';

/** Extension search roots, by the path id that prefixes an extension's id. */
const EXTENSIONS_SUBFOLDER = 'Extensions';
const EXTENSION_PATH_IDS = { COMMON: 'common', COMMON_EXT: 'commonext', USER_EXT: 'userext' };

/** The store shape this module understands. `migrate()` brings older ones here. */
const CONFIG_VERSION = 2;

// ---------------------------------------------------------------------------
// small helpers ported from core/Common.cpp
//
// These look trivial and are not: the editor display name, IsDefaultList and
// the PuTTY-path repair all hinge on exactly how a command line splits.
// ---------------------------------------------------------------------------

function isString(v) { return typeof v === 'string'; }
function sameText(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/** AddToList: append with a delimiter, but never a leading or doubled one. */
function addToList(list, value, delimiter) {
  if (!value) return list;
  if (!list) return String(value);
  return list.endsWith(delimiter) ? list + value : list + delimiter + value;
}

/** CutToChar: the head before `ch`, with the tail returned alongside it. */
function cutToChar(str, ch, trim) {
  const s = String(str == null ? '' : str);
  const p = s.indexOf(ch);
  let head;
  let tail;
  if (p >= 0) { head = s.slice(0, p); tail = s.slice(p + 1); } else { head = s; tail = ''; }
  if (trim) { head = head.replace(/\s+$/, ''); tail = tail.replace(/^\s+/, ''); }
  return { head, tail };
}

/** Split a delimited list, ignoring empty pieces — ParseExtensionList. */
function parseList(s, delimiter) {
  const out = [];
  let rest = String(s || '');
  while (rest) {
    const { head, tail } = cutToChar(rest, delimiter, false);
    if (head) out.push(head);
    rest = tail;
    if (!head && !tail) break;
  }
  return out;
}

/**
 * SplitCommand. A quoted program keeps its spaces; an unquoted one ends at the
 * first space. An opening quote with no closing quote is a refusal, not a
 * guess — WinSCP raises INVALID_SHELL_COMMAND and so do we.
 */
function splitCommand(command) {
  let cmd = String(command == null ? '' : command).trim();
  let program = '';
  let params = '';
  if (cmd && cmd[0] === '"') {
    cmd = cmd.slice(1);
    const p = cmd.indexOf('"');
    if (p < 0) throw new Error(`Invalid shell command syntax: "${cmd}`);
    program = cmd.slice(0, p).trim();
    params = cmd.slice(p + 1).trim();
  } else {
    const p = cmd.indexOf(' ');
    if (p >= 0) { program = cmd.slice(0, p + 1).trim(); params = cmd.slice(p + 1).trim(); } else { program = cmd; }
  }
  const b = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  const dir = b >= 0 ? program.slice(0, b + 1).trim() : '';
  return { program, params, dir };
}

/** AddQuotes: quote only when needed, exactly as WinSCP does. */
function addQuotes(s) { return String(s).includes(' ') ? `"${s}"` : String(s); }

/** FormatCommand. */
function formatCommand(program, params) {
  const p = String(program || '').trim();
  const a = String(params || '').trim();
  return addQuotes(p) + (a ? ' ' + a : '');
}

/** ExtractProgramName: base name of the program, extension stripped. */
function extractProgramName(command) {
  let program;
  try { program = splitCommand(command).program; } catch { program = String(command || ''); }
  const b = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  let name = b >= 0 ? program.slice(b + 1) : program;
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  return name;
}

/** ReformatFileNameCommand: make sure the command carries the "!.!" argument. */
function reformatFileNameCommand(command) {
  if (!command) return '';
  const { program, params } = splitCommand(command);
  const p = params.includes(SHELL_COMMAND_FILE_NAME_PATTERN)
    ? params
    : params + (params ? ' ' : '') + SHELL_COMMAND_FILE_NAME_PATTERN;
  return formatCommand(program, p);
}

/** MakeValidFileName: the temporary-directory policy uses it on session names. */
function makeValidFileName(name) {
  const illegal = ':;,=+<>|"[] \\/?*';
  let out = String(name == null ? '' : name);
  for (const ch of illegal) out = out.split(ch).join('-');
  return out;
}

/** CalculateCompoundVersion / ZeroBuildNumber / StrToCompoundVersion. */
function compoundVersion(major, minor, release) {
  return 10000 * ((release || 0) + 100 * ((minor || 0) + 100 * (major || 0)));
}
function zeroBuildNumber(v) { return Math.trunc(v / 10000) * 10000; }
function strToCompoundVersion(s) {
  const parts = String(s || '').split('.');
  const n = (i) => Math.min(parseInt(parts[i], 10) || 0, 99);
  return compoundVersion(n(0), n(1), parts.length > 2 ? n(2) : 0);
}

/** CompareVersion: field by field, missing fields read as zero. */
function compareVersion(v1, v2) {
  const a = String(v1 || '').split('.');
  const b = String(v2 || '').split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i], 10) || 0;
    const y = parseInt(b[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// --- Delphi CommaText ------------------------------------------------------
//
// The file-colour list and a bookmark list's opened nodes are stored as a
// TStringList's CommaText. A naive split on "," corrupts every mask that
// contains a space or a comma, which is most of them ("*.tmp; *.bak").

/** TStrings.CommaText getter: quote anything with whitespace, a comma or a quote. */
function listToCommaText(list) {
  return (list || []).map((raw) => {
    const s = String(raw == null ? '' : raw);
    let needsQuote = s.length === 0;
    for (const ch of s) {
      if (ch <= ' ' || ch === '"' || ch === ',') { needsQuote = true; break; }
    }
    return needsQuote ? `"${s.split('"').join('""')}"` : s;
  }).join(',');
}

/**
 * TStrings.CommaText setter with the default StrictDelimiter=False, so runs of
 * whitespace separate items too. That is why the writer above quotes on space.
 */
function commaTextToList(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] <= ' ') i++;
    if (i >= s.length) break;
    let value = '';
    if (s[i] === '"') {
      i++;
      for (;;) {
        if (i >= s.length) break;
        if (s[i] === '"') {
          if (s[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += s[i];
        i++;
      }
    } else {
      while (i < s.length && s[i] > ' ' && s[i] !== ',') { value += s[i]; i++; }
    }
    out.push(value);
    while (i < s.length && s[i] <= ' ') i++;
    if (i < s.length && s[i] === ',') i++;
  }
  return out;
}

// --- colours ---------------------------------------------------------------
//
// TColor is a Windows COLORREF: 0x00BBGGRR. StoreColor writes it as six hex
// digits, so a stored "0000FF" is RED, not blue. Getting this backwards is
// invisible in code review and glaring on screen.

/** RestoreColor: "BBGGRR" (or "#RRGGBB") -> "#RRGGBB". */
function colorFromWinscp(s) {
  const raw = String(s || '').trim().replace(/^\$/, '');
  if (/^#/.test(raw)) return raw.toUpperCase();
  if (!/^[0-9a-fA-F]{1,8}$/.test(raw)) return '';
  const v = parseInt(raw, 16);
  const r = v & 0xFF;
  const g = (v >> 8) & 0xFF;
  const b = (v >> 16) & 0xFF;
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** StoreColor: "#RRGGBB" -> "BBGGRR", six digits, upper case. */
function colorToWinscp(css) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(css || '').trim());
  if (!m) return '000000';
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return (((b << 16) | (g << 8) | r) >>> 0).toString(16).padStart(6, '0').toUpperCase();
}

// ---------------------------------------------------------------------------
// enum coercion
//
// A stored value may be an ordinal (WinSCP, or an imported INI) or one of our
// names. Anything unrecognised falls back to the default rather than becoming
// `undefined` — a config that half-loads is worse than one that resets.
// ---------------------------------------------------------------------------

function fromEnum(list, value, fallback) {
  if (isString(value) && list.includes(value)) return value;
  if (typeof value === 'number' && list[value] !== undefined) return list[value];
  if (typeof value === 'boolean') return list[value ? 1 : 0] !== undefined ? list[value ? 1 : 0] : fallback;
  if (isString(value) && /^-?\d+$/.test(value)) {
    const i = parseInt(value, 10);
    if (list[i] !== undefined) return list[i];
  }
  return fallback;
}

function toEnum(list, name) {
  const i = list.indexOf(name);
  return i < 0 ? 0 : i;
}

/**
 * TIncrementalSearch is the one enum whose ordinals start at -1 (isOff), so it
 * cannot share fromEnum. WinSCP's three "on" variants (name start, whole name,
 * all columns) collapse to this port's single 'typing' — see docs; the
 * distinction is a listview detail we do not reproduce.
 */
function panelSearchFromWinscp(value) {
  if (isString(value)) {
    if (['off', 'typing', 'ctrl'].includes(value)) return value;
    if (value === 'nameStart' || value === 'name' || value === 'all') return 'typing';
  }
  if (typeof value === 'number') return value < 0 ? 'off' : 'typing';
  return PREF_DEFAULTS.panel.incrementalSearch;
}

// ---------------------------------------------------------------------------
// TEditorData / TEditorPreferences / TEditorList
// ---------------------------------------------------------------------------

/**
 * One row of the editor list: a mask, which editor handles it, and the external
 * command when there is one.
 */
class EditorPreferences {
  constructor(data) {
    const d = data || {};
    this.mask = d.mask === undefined ? '*.*' : String(d.mask);
    this.editor = fromEnum(EDITOR, d.editor === undefined ? d.type : d.editor, 'internal');
    this.external = String(d.external || d.externalEditor || '');
    this.externalText = d.externalText !== undefined ? !!d.externalText : !!d.externalParams;
    this.sdiExternal = !!(d.sdiExternal || d.sDIExternal);
    this.detectMdiExternal = !!(d.detectMdiExternal || d.detectMDIExternalEditor);
    this._mask = null;
    this._name = '';
  }

  static from(o) { return o instanceof EditorPreferences ? o : new EditorPreferences(o); }

  /** TEditorPreferences::LegacyDefaults — what a pre-list configuration meant. */
  static legacyDefaults() {
    const e = new EditorPreferences({ editor: 'internal' });
    e.external = DEFAULT_EXTERNAL_EDITOR;
    e.externalEditorOptionsAutodetect();
    return e;
  }

  /**
   * TEditorData::ExternalEditorOptionsAutodetect. Third-party editors all cope
   * with any EOL style, so binary transfer is right for them; Notepad before
   * Windows 10 1809 did not, hence the one exception. Notepad is treated as SDI
   * even on Windows 11, where notepad.exe fronts the MDI store app — the
   * process lives as long as the tab does, which is what "SDI" is used for.
   */
  externalEditorOptionsAutodetect(options) {
    const opts = options || {};
    const program = extractProgramName(reformatFileNameCommand(this.external));
    if (sameText(program, extractProgramName(DEFAULT_EXTERNAL_EDITOR))) {
      this.externalText = opts.win10Build17763 === undefined ? false : !opts.win10Build17763;
      this.sdiExternal = true;
    }
    return this;
  }

  equals(other) {
    const o = EditorPreferences.from(other);
    return this.mask === o.mask && this.editor === o.editor && this.external === o.external
      && this.externalText === o.externalText && this.sdiExternal === o.sdiExternal
      && this.detectMdiExternal === o.detectMdiExternal;
  }

  /** The compiled mask, built once — the list is consulted per opened file. */
  compiled() {
    if (!this._mask) this._mask = new masks.FileMask(this.mask);
    return this._mask;
  }

  /** TEditorPreferences::Matches. */
  matches(fileName, local, params) {
    const p = params || {};
    const name = masks.baseOf(String(fileName || '')) || String(fileName || '');
    return this.compiled().matches(name, {
      isDir: false, path: fileName, size: p.size, mtime: p.mtime, now: p.now, local,
    });
  }

  /** TEditorPreferences::ExtractExternalEditorName. */
  extractExternalEditorName() {
    return extractProgramName(reformatFileNameCommand(this.external)).trim();
  }

  /**
   * TEditorPreferences::GetName. For an external editor the display name is the
   * program's base name with the extension dropped and the case normalised:
   * "NOTEPAD.EXE" and "notepad.exe" both read as "Notepad".
   */
  get name() {
    if (this._name) return this._name;
    if (this.editor === 'internal') { this._name = 'Internal editor'; return this._name; }
    if (this.editor === 'open') { this._name = 'Opening editor'; return this._name; }
    const { program } = splitCommand(reformatFileNameCommand(this.external));
    let name = masks.baseOf(program.replace(/\\/g, '/')) || program;
    const dot = name.lastIndexOf('.');
    if (dot > 0) name = name.slice(0, dot);
    if (name && name.toUpperCase() === name) name = name.toLowerCase();
    if (name && name.toLowerCase() === name) name = name.slice(0, 1).toUpperCase() + name.slice(1);
    this._name = name;
    return this._name;
  }

  /** The stored shape, matching design/main/defaults.js's `editor.list`. */
  toJSON() {
    return {
      mask: this.mask,
      type: this.editor,
      external: this.external,
      externalParams: this.externalText,
      sDIExternal: this.sdiExternal,
      detectMDIExternalEditor: this.detectMdiExternal,
    };
  }
}

/** TEditorList: ordered, first match wins, with a modified flag for saving. */
class EditorList {
  constructor(items) {
    this.items = (items || []).map(EditorPreferences.from);
    this.modified = false;
  }

  get count() { return this.items.length; }
  get(i) { return this.items[i]; }
  modify() { this.modified = true; }
  saved() { this.modified = false; }

  /** TEditorList::Find — the FIRST matching row wins, so order is the rule. */
  find(fileName, local, params) {
    return this.items.find((e) => e.matches(fileName, local, params)) || null;
  }

  add(editor) { return this.insert(this.count, editor); }

  insert(index, editor) {
    this.items.splice(index, 0, EditorPreferences.from(editor));
    this.modify();
    return this;
  }

  /** TEditorList::Change — an identical replacement is not a modification. */
  change(index, editor) {
    const next = EditorPreferences.from(editor);
    if (this.items[index] && this.items[index].equals(next)) return false;
    this.items[index] = next;
    this.modify();
    return true;
  }

  move(from, to) {
    if (from === to) return false;
    const [item] = this.items.splice(from, 1);
    this.items.splice(to, 0, item);
    this.modify();
    return true;
  }

  delete(index) {
    if (index < 0 || index >= this.items.length) throw new RangeError(`No editor at index ${index}`);
    this.items.splice(index, 1);
    this.modify();
    return true;
  }

  equals(other) {
    const o = other instanceof EditorList ? other : new EditorList(other);
    return this.count === o.count && this.items.every((e, i) => e.equals(o.items[i]));
  }

  /**
   * TEditorList::IsDefaultList — true while every row is either the internal
   * editor or the default external one. WinSCP uses it to decide whether to
   * offer the editor auto-configuration, so a user who has already chosen an
   * editor is not nagged.
   */
  isDefaultList() {
    return this.items.every((e) => {
      if (e.editor === 'internal') return true;
      if (e.editor !== 'external') return false;
      return sameText(e.extractExternalEditorName(), extractProgramName(DEFAULT_EXTERNAL_EDITOR));
    });
  }

  toJSON() { return this.items.map((e) => e.toJSON()); }
}

/**
 * TWinConfiguration::LoadFrom's editor migration. When the stored configuration
 * has no editor LIST it is from a version that stored a single editor, and that
 * record has to be turned into a list without losing the alternative:
 *
 *   internal + an external command -> internal first, then that external one
 *   external with no command       -> internal only (the command is gone)
 *   external with a command        -> that external one, then internal
 *
 * Get this wrong and the user's external editor quietly disappears on upgrade.
 */
function editorListFromLegacy(legacy) {
  const primary = EditorPreferences.from(legacy || EditorPreferences.legacyDefaults());
  let alternative = null;
  if (primary.editor === 'internal') {
    if (primary.external) {
      alternative = EditorPreferences.from(primary.toJSON());
      alternative.editor = 'external';
      primary.external = '';
    }
  } else if (!primary.external) {
    primary.editor = 'internal';
  } else {
    alternative = EditorPreferences.from(primary.toJSON());
    alternative.editor = 'internal';
  }
  const list = new EditorList([primary]);
  if (alternative) list.add(alternative);
  list.saved();
  return list;
}

// ---------------------------------------------------------------------------
// TCustomCommandType / TCustomCommandList / the extension mechanism
// ---------------------------------------------------------------------------

/** Bit mask <-> the `{remote, applyToDirectories, ...}` shape config.js stores. */
function paramsFromBits(bits) {
  const b = bits | 0;
  return {
    remote: (b & CC.LOCAL) === 0,
    applyToDirectories: !!(b & CC.APPLY_TO_DIRECTORIES),
    recursive: !!(b & CC.RECURSIVE),
    showResults: !!(b & CC.SHOW_RESULTS),
    copyResults: !!(b & CC.COPY_RESULTS),
    remoteFiles: !!(b & CC.REMOTE_FILES),
    showResultsInMsgBox: !!(b & CC.SHOW_RESULTS_IN_MSGBOX),
  };
}

function paramsToBits(params) {
  const p = params || {};
  let b = 0;
  if (p.remote === false) b |= CC.LOCAL;
  if (p.applyToDirectories) b |= CC.APPLY_TO_DIRECTORIES;
  if (p.recursive) b |= CC.RECURSIVE;
  if (p.showResults) b |= CC.SHOW_RESULTS;
  if (p.copyResults) b |= CC.COPY_RESULTS;
  if (p.remoteFiles) b |= CC.REMOTE_FILES;
  if (p.showResultsInMsgBox) b |= CC.SHOW_RESULTS_IN_MSGBOX;
  return b;
}

/** One option control declared by an extension's `@option` directive. */
class CommandOption {
  constructor(o) {
    const d = o || {};
    this.id = String(d.id || '');
    this.flags = d.flags === undefined ? OPTION_FLAG.CONFIG : d.flags | 0;
    this.kind = d.kind || 'unknown';
    this.caption = String(d.caption || '');
    this.default = String(d.default === undefined ? '' : d.default);
    this.params = (d.params || []).map(String);
    this.fileCaption = String(d.fileCaption || '');
    this.fileFilter = String(d.fileFilter || '');
    this.fileInitial = String(d.fileInitial || '');
    this.fileExt = String(d.fileExt || '');
  }

  /** TOption::GetIsControl — the id "-" marks decoration, not a control. */
  get isControl() { return this.id !== '-'; }

  /** TOption::CanHavePatterns — only free text can carry a "!" pattern. */
  canHavePatterns() { return this.kind === 'textBox' || this.kind === 'file'; }

  /**
   * TOption::HasPatterns. A run-only option whose default contains patterns is
   * resolved at run time, so it must not be escaped as a literal.
   */
  hasPatterns(hasAnyPatterns) {
    return this.canHavePatterns()
      && !!(this.flags & OPTION_FLAG.RUN)
      && !(this.flags & OPTION_FLAG.CONFIG)
      && !!hasAnyPatterns(this.default);
  }

  equals(other) {
    const o = other instanceof CommandOption ? other : new CommandOption(other);
    return this.id === o.id && this.flags === o.flags && this.kind === o.kind
      && this.caption === o.caption && this.default === o.default
      && this.params.length === o.params.length && this.params.every((p, i) => p === o.params[i])
      && this.fileCaption === o.fileCaption && this.fileFilter === o.fileFilter
      && this.fileInitial === o.fileInitial && this.fileExt === o.fileExt;
  }

  toJSON() {
    return {
      id: this.id, flags: this.flags, kind: this.kind, caption: this.caption,
      default: this.default, params: this.params.slice(),
      fileCaption: this.fileCaption, fileFilter: this.fileFilter,
      fileInitial: this.fileInitial, fileExt: this.fileExt,
    };
  }
}

/** An extension file that is not one — thrown so callers can skip it quietly. */
class ExtensionError extends Error {
  constructor(message) { super(message); this.name = 'ExtensionError'; }
}

/**
 * TCustomCommandType: a custom command, or an extension (which is a custom
 * command with an id, a source file and option controls).
 */
class CustomCommandType {
  constructor(o) {
    const d = o || {};
    this.id = String(d.id || '');
    this.name = String(d.name || '');
    this.command = String(d.command || '');
    this.params = d.params === undefined ? 0
      : (typeof d.params === 'number' ? d.params : paramsToBits(d.params));
    this.shortCut = d.shortCut || '';
    this.shortCutOriginal = d.shortCutOriginal || '';
    this.fileName = String(d.fileName || '');
    this.description = String(d.description || '');
    this.homePage = String(d.homePage || '');
    this.optionsPage = String(d.optionsPage || '');
    this.options = (d.options || []).map((x) => new CommandOption(x));
  }

  static from(o) { return o instanceof CustomCommandType ? o : new CustomCommandType(o); }

  get flags() { return paramsFromBits(this.params); }
  set flags(v) { this.params = paramsToBits(v); }

  /** TCustomCommandType::HasCustomShortCut — differs from what the file declared. */
  hasCustomShortCut() { return this.shortCut !== this.shortCutOriginal; }

  equals(other) {
    const o = CustomCommandType.from(other);
    return this.name === o.name && this.command === o.command && this.params === o.params
      && this.shortCut === o.shortCut && this.shortCutOriginal === o.shortCutOriginal
      && this.id === o.id && this.fileName === o.fileName && this.description === o.description
      && this.homePage === o.homePage && this.optionsPage === o.optionsPage
      && this.options.length === o.options.length
      && this.options.every((x, i) => x.equals(o.options[i]));
  }

  optionsCount() { return this.options.length; }
  option(i) { return this.options[i]; }

  /** TCustomCommandType::AnyOptionWithFlag. */
  anyOptionWithFlag(flag) { return this.options.some((o) => (o.flags & flag) !== 0); }

  /**
   * TCustomCommandType::GetOptionKey. An option flagged `-site` is stored per
   * site, so the same extension can hold a different value for each server.
   */
  optionKey(option, site) {
    const o = option instanceof CommandOption ? option : new CommandOption(option);
    let key = `${this.id}\\${o.id}`;
    if (o.flags & OPTION_FLAG.SITE) key += `\\${site || ''}`;
    return key;
  }

  /**
   * TCustomCommandType::GetCommandWithExpandedOptions. A value the user has
   * actually set is escaped, because it is data; an untouched default is not,
   * because the extension author may have written a pattern into it.
   */
  commandWithExpandedOptions(optionValues, site, helpers) {
    const h = helpers || {};
    const escape = h.escape || ((s) => s);
    const expandEnv = h.expandEnvironmentVariables || ((s) => s);
    const values = optionValues instanceof Map ? optionValues : new Map(Object.entries(optionValues || {}));
    let result = this.command;
    for (const option of this.options) {
      if (!option.isControl) continue;
      const key = this.optionKey(option, site);
      const set = values.has(key);
      const value = set ? String(values.get(key)) : option.default;
      let text = option.kind === 'file' ? expandEnv(value) : value;
      if (set || !option.canHavePatterns()) text = escape(text);
      result = replaceTextAll(result, `%${option.id}%`, text);
    }
    return result;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, command: this.command, params: this.params,
      shortCut: this.shortCut, shortCutOriginal: this.shortCutOriginal,
      fileName: this.fileName, description: this.description,
      homePage: this.homePage, optionsPage: this.optionsPage,
      options: this.options.map((o) => o.toJSON()),
    };
  }
}

/** ReplaceText: case-insensitive replace-all, which is what VCL's ReplaceText is. */
function replaceTextAll(subject, find, replacement) {
  if (!find) return subject;
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return String(subject).replace(re, () => replacement);
}

/** TCustomCommandType::GetExtensionId — the base name before ".WinSCPextension". */
function extensionIdOfFileName(name) {
  const s = String(name || '');
  const p = s.toUpperCase().indexOf(EXTENSION_EXT.toUpperCase());
  // "> 0" not ">= 0": a file called exactly ".WinSCPextension" has no id.
  if (p <= 0) return '';
  const after = p + EXTENSION_EXT.length;
  if (after !== s.length && s[after] !== '.') return '';
  return s.slice(0, p);
}

/** ExtractExtensionBaseName: every extension is trimmed, not just the last one. */
function extensionBaseName(filePath) {
  const base = masks.baseOf(String(filePath || '').replace(/\\/g, '/'));
  return cutToChar(base, '.', true).head;
}

/**
 * TCustomCommandType::ParseOption — the `@option` grammar:
 *
 *   @option <id> [-run|-config|-site]... <kind> [caption] [default] [params...]
 *
 * Returns null when the line is not a valid option, which the caller turns into
 * the same refusal WinSCP raises (EXTENSION_DIRECTIVE_ERROR).
 */
function parseExtensionOption(value, baseName) {
  const tokens = cutTokens(value);
  if (!tokens.length) return null;

  const option = new CommandOption({ id: tokens.shift(), flags: 0 });
  let ok = true;
  let kindName = '';
  while (tokens.length && tokens[0].startsWith('-')) {
    const flag = tokens.shift().toLowerCase();
    if (flag === '-run') option.flags |= OPTION_FLAG.RUN;
    else if (flag === '-config') option.flags |= OPTION_FLAG.CONFIG;
    else if (flag === '-site') option.flags |= OPTION_FLAG.SITE;
    else ok = false;
  }
  if ((option.flags & (OPTION_FLAG.RUN | OPTION_FLAG.CONFIG)) === 0) option.flags |= OPTION_FLAG.CONFIG;
  kindName = (tokens.shift() || '').toLowerCase();
  if (!ok) return null;

  let defaultCaption = '';
  let defaultDefault = '';
  let defaultParams = [];

  const DECORATION = { label: 'label', link: 'link', separator: 'separator', group: 'group' };
  const CONTROL = { textbox: 'textBox', file: 'file', dropdownlist: 'dropDownList', combobox: 'comboBox', checkbox: 'checkBox' };

  if (DECORATION[kindName]) {
    option.kind = DECORATION[kindName];
    ok = !option.isControl;
  } else if (CONTROL[kindName]) {
    option.kind = CONTROL[kindName];
    ok = option.isControl;
  } else if (kindName === 'sessionlogfile') {
    option.kind = 'file';
    ok = option.isControl;
    defaultCaption = 'Session log file';
    option.fileCaption = 'Select session log file';
    option.fileFilter = 'Log files (*.log)|*.log|All files (*.*)|*.*';
    // Mirrors TConfiguration::GetDefaultLogFileName.
    option.fileInitial = `%TEMP%\\${baseName}.log`;
    option.fileExt = 'log';
  } else if (kindName === 'pausecheckbox') {
    option.kind = 'checkBox';
    ok = option.isControl;
    defaultCaption = 'Keep the window open when finished';
    defaultDefault = '-pause';
    defaultParams = ['-pause'];
  } else {
    option.kind = 'unknown';
  }

  if (ok && option.kind !== 'unknown' && option.kind !== 'separator') {
    if (tokens.length) {
      option.caption = tokens.shift();
    } else if (defaultCaption) {
      option.caption = defaultCaption;
    } else {
      ok = false;
    }
    if (ok) {
      if (tokens.length) {
        option.default = tokens.shift();
        while (tokens.length) option.params.push(tokens.shift());
      } else {
        option.default = defaultDefault;
      }
      if (option.params.length === 0) option.params = defaultParams.slice();
    }
  }

  return ok ? option : null;
}

/**
 * DoCutToken with EscapeQuotesInQuotesOnly, called repeatedly — CutTokenEx.
 *
 * A quote does not have to open the token: it TOGGLES quoting wherever it
 * appears, so `Log"my file".txt` is one token `Logmy file.txt`, and only inside
 * quotes does `""` mean a literal quote (outside them it is an empty string,
 * which is how an extension author writes an intentionally blank default).
 * Only space and tab separate; a newline does not, because the caller has
 * already split the file into lines.
 */
function cutTokens(s) {
  const str = String(s == null ? '' : s);
  const isSep = (c) => c === ' ' || c === '\t';
  const out = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && isSep(str[i])) i++;
    if (i >= str.length) break;
    let token = '';
    let quoting = false;
    while (i < str.length) {
      if (!quoting && isSep(str[i])) break;
      if (str[i] === '"' && str[i + 1] === '"' && quoting) { token += '"'; i += 2; continue; }
      if (str[i] === '"') { i++; quoting = !quoting; continue; }
      token += str[i];
      i++;
    }
    out.push(token);
    if (i < str.length) i++;
  }
  return out;
}

/**
 * TCustomCommandType::LoadExtension. An extension is a *script* whose leading
 * comment block carries the directives, so the parser:
 *
 *   - accepts "@", "rem ", "#", ";", "'" and "//" as comment markers,
 *   - stops at the first line that is not a comment (but still finishes a
 *     continuation started by a trailing "^"),
 *   - refuses the file when no known directive was found at all, or when @name
 *     or @command is missing, or when a @require dependency is not satisfied.
 *
 * The refusals matter: WinSCP silently skips a file that throws here, and an
 * extension that half-loads would show a menu entry that cannot run.
 */
function parseExtension(text, options) {
  const opts = options || {};
  const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
  const command = new CustomCommandType({ id: opts.id || '', fileName: opts.fileName || '' });
  // An extension defaults to running locally; "@side remote" clears the bit.
  command.params = CC.LOCAL;

  const baseName = extensionBaseName(opts.fileName || opts.baseName || '');
  const translate = opts.translate || ((id, s) => s);
  const versions = opts.versions || {};
  const optionIds = new Set();
  let anythingFound = false;
  let extensionLine = '';
  let stop = false;

  for (let index = 0; !stop && index < lines.length; index++) {
    let line = lines[index].trim();
    if (line) {
      line = line.split('\t').join(' ');
      let isComment = false;
      if (line.startsWith('@')) {
        isComment = true;
      } else if (/^rem /i.test(line)) {
        isComment = true; line = line.slice(4);
      } else if (line.startsWith('#') || line.startsWith(';') || line.startsWith("'")) {
        isComment = true; line = line.slice(1);
      } else if (line.startsWith('//')) {
        isComment = true; line = line.slice(2);
      }
      if (!isComment) {
        // Ignore this and every later line, but still finish a pending "^".
        stop = true;
        line = '';
      } else {
        line = line.trim();
      }
    }

    const continuation = line.length > 0 && line[line.length - 1] === '^';
    if (continuation) line = line.slice(0, -1).trim();
    extensionLine = addToList(extensionLine, line, ' ');
    if (continuation) continue;

    const p = extensionLine.indexOf(' ');
    if (extensionLine && extensionLine[0] === '@' && p >= 1) {
      const key = extensionLine.slice(1, p).toLowerCase();
      const directive = '@' + key;
      const value = extensionLine.slice(p + 1).trim();
      let knownKey = true;

      switch (key) {
        case 'name':
          command.name = translate(command.id, value);
          break;
        case 'command':
          command.command = value;
          break;
        case 'require': {
          const dependencyVersion = value;
          const cut = cutToChar(value, ' ', true);
          const dependency = cut.head.toLowerCase();
          const wanted = cut.tail.trim();
          let failed;
          if (dependency === 'winscp') {
            failed = strToCompoundVersion(wanted) > (versions.winscp === undefined
              ? strToCompoundVersion(opts.appVersion || '0.0.0') : versions.winscp);
          } else if (['.net', '.netcore', 'powershell', 'pwsh', 'windows'].includes(dependency)) {
            const have = versions[dependency];
            // An unknown host version cannot satisfy a requirement.
            failed = have === undefined || compareVersion(wanted, have) > 0;
          } else {
            failed = true;
          }
          if (failed) throw new ExtensionError(`The extension requires ${dependencyVersion}, which is not available.`);
          break;
        }
        case 'side':
          if (sameText(value, 'Local')) command.params |= CC.LOCAL;
          else if (sameText(value, 'Remote')) command.params &= ~CC.LOCAL;
          else throw new ExtensionError(`Invalid value "${value}" of the ${directive} directive.`);
          break;
        case 'flag': {
          const FLAGS = {
            applytodirectories: CC.APPLY_TO_DIRECTORIES,
            recursive: CC.RECURSIVE,
            showresults: CC.SHOW_RESULTS,
            copyresults: CC.COPY_RESULTS,
            remotefiles: CC.REMOTE_FILES,
            showresultsinmsgbox: CC.SHOW_RESULTS_IN_MSGBOX,
          };
          const bit = FLAGS[value.toLowerCase()];
          if (!bit) throw new ExtensionError(`Invalid value "${value}" of the ${directive} directive.`);
          command.params |= bit;
          break;
        }
        case 'shortcut': {
          const shortCut = normalizeShortCut(value);
          if (!shortCut) throw new ExtensionError(`Invalid value "${value}" of the ${directive} directive.`);
          command.shortCut = shortCut;
          command.shortCutOriginal = shortCut;
          break;
        }
        case 'option': {
          const option = parseExtensionOption(value, baseName);
          if (!option || (option.isControl && optionIds.has(option.id.toLowerCase()))) {
            throw new ExtensionError(`Invalid value "${value}" of the ${directive} directive.`);
          }
          option.caption = translate(command.id, option.caption);
          command.options.push(option);
          // Decoration shares the id "-", so only controls claim their id.
          if (option.isControl) optionIds.add(option.id.toLowerCase());
          break;
        }
        case 'description':
          command.description = translate(command.id, value);
          break;
        case 'homepage':
          command.homePage = value;
          break;
        case 'optionspage':
          command.optionsPage = value;
          break;
        case 'author':
        case 'version':
        case 'source':
          // Recorded by the author, not used by the program.
          break;
        default:
          knownKey = false;
      }
      if (knownKey) anythingFound = true;
    }
    extensionLine = '';
  }

  if (!anythingFound) throw new ExtensionError('The file is not a WinSCP extension.');
  if (!command.name) throw new ExtensionError('The extension is missing the @name directive.');
  if (!command.command) throw new ExtensionError('The extension is missing the @command directive.');
  if (opts.fileName) command.command = command.command.split('%EXTENSION_PATH%').join(opts.fileName);
  return command;
}

// --- shortcuts -------------------------------------------------------------
//
// A TShortCut is a Word: the low byte is the virtual key code, plus scShift,
// scCtrl and scAlt in the top bits. WinSCP stores those integers, and this port
// stores the text form, so both directions are needed for a round trip.

const SC_SHIFT = 0x2000;
const SC_CTRL = 0x4000;
const SC_ALT = 0x8000;

/**
 * IsCustomShortCut. WinSCP allows a custom command or an extension EXACTLY two
 * ranges: Ctrl+0..Ctrl+9 and Shift+Ctrl+Alt+A..Shift+Ctrl+Alt+Z. Everything
 * else is refused, because anything looser would shadow a menu accelerator or
 * ordinary typing in the panel. NormalizeCustomShortCut additionally folds
 * Ctrl+Numpad0..9 onto Ctrl+0..9 so the two keyboards agree.
 */
function isCustomShortCutCode(code) {
  const c = code | 0;
  const ctrlDigit = c >= (SC_CTRL | 0x30) && c <= (SC_CTRL | 0x39);
  const shiftCtrlAltLetter = c >= (SC_SHIFT | SC_CTRL | SC_ALT | 0x41)
    && c <= (SC_SHIFT | SC_CTRL | SC_ALT | 0x5A);
  return ctrlDigit || shiftCtrlAltLetter;
}

function normalizeCustomShortCutCode(code) {
  const c = code | 0;
  // VK_NUMPAD0 = 0x60.
  if (c >= (SC_CTRL | 0x60) && c <= (SC_CTRL | 0x69)) return (c - 0x60) + 0x30;
  return c;
}

/** ShortCutToText, in Delphi's order: Shift, then Ctrl, then Alt, then the key. */
function shortCutToText(code) {
  const c = code | 0;
  if (!c) return '';
  const key = c & 0xFF;
  let name;
  if (key >= 0x30 && key <= 0x39) name = String.fromCharCode(key);
  else if (key >= 0x41 && key <= 0x5A) name = String.fromCharCode(key);
  else if (key >= 0x60 && key <= 0x69) name = `Num ${key - 0x60}`;
  else if (key >= 0x70 && key <= 0x87) name = `F${key - 0x6F}`;
  else return '';
  let out = '';
  if (c & SC_SHIFT) out += 'Shift+';
  if (c & SC_CTRL) out += 'Ctrl+';
  if (c & SC_ALT) out += 'Alt+';
  return out + name;
}

/** TextToShortCut, restricted to the key names shortCutToText can produce. */
function textToShortCut(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  let key = parts.pop();
  if (!key) return 0;
  let code = 0;
  for (const part of parts) {
    if (sameText(part, 'shift')) code |= SC_SHIFT;
    else if (sameText(part, 'ctrl')) code |= SC_CTRL;
    else if (sameText(part, 'alt')) code |= SC_ALT;
    else return 0;
  }
  const num = /^Num\s*([0-9])$/i.exec(key);
  if (num) return code | (0x60 + Number(num[1]));
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/i.exec(key);
  if (fn) return code | (0x6F + Number(fn[1]));
  key = key.toUpperCase();
  if (key.length !== 1) return 0;
  const ch = key.charCodeAt(0);
  if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A)) return code | ch;
  return 0;
}

/**
 * The text form of a shortcut a custom command or extension may claim, or ""
 * when WinSCP would refuse it. Accepts either the text or WinSCP's integer.
 */
function normalizeShortCut(value) {
  const code = normalizeCustomShortCutCode(shortCutCode(value));
  if (!code || !isCustomShortCutCode(code)) return '';
  return shortCutToText(code);
}

/** The integer form of whatever the caller has: text, integer, or "". */
function shortCutCode(value) {
  if (typeof value === 'number') return value | 0;
  const s = String(value || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return textToShortCut(s);
}

/**
 * The text form, WITHOUT the custom-shortcut refusal. The load path applies a
 * stored shortcut as-is (TWinConfiguration::LoadExtensionList does not
 * re-validate), so refusing here would drop a shortcut the user really has.
 */
function shortCutText(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value || '').trim())) {
    return shortCutToText(normalizeCustomShortCutCode(shortCutCode(value)));
  }
  return String(value || '');
}

/** TCustomCommandList. */
class CustomCommandList {
  constructor(items) {
    this.items = (items || []).map(CustomCommandType.from);
    this.modified = false;
  }

  get count() { return this.items.length; }
  get(i) { return this.items[i]; }
  reset() { this.modified = false; }
  modify() { this.modified = true; }
  clear() { this.items = []; }

  add(nameOrCommand, command, params) {
    if (nameOrCommand instanceof CustomCommandType || (nameOrCommand && typeof nameOrCommand === 'object')) {
      return this.insert(this.count, nameOrCommand);
    }
    return this.insert(this.count, new CustomCommandType({ name: nameOrCommand, command, params }));
  }

  insert(index, command) {
    this.items.splice(index, 0, CustomCommandType.from(command));
    this.modify();
    return this;
  }

  /** TCustomCommandList::Change — replacing a command with its equal is a no-op. */
  change(index, command) {
    const next = CustomCommandType.from(command);
    if (this.items[index] && this.items[index].equals(next)) return false;
    this.items[index] = next;
    this.modify();
    return true;
  }

  move(from, to) {
    if (from === to) return false;
    const [item] = this.items.splice(from, 1);
    this.items.splice(to, 0, item);
    this.modify();
    return true;
  }

  delete(index) {
    if (index < 0 || index >= this.items.length) throw new RangeError(`No custom command at index ${index}`);
    this.items.splice(index, 1);
    this.modify();
    return true;
  }

  findByName(name) { return this.items.find((c) => c.name === name) || null; }
  findByShortCut(shortCut) { return shortCut ? (this.items.find((c) => c.shortCut === shortCut) || null) : null; }

  /** TCustomCommandList::FindIndexByFileName — same file, however it is spelled. */
  findIndexByFileName(fileName) {
    const want = normalizePathForCompare(fileName);
    return this.items.findIndex((c) => c.fileName && normalizePathForCompare(c.fileName) === want);
  }

  /**
   * TCustomCommandList::SortBy — the saved order first, then anything new,
   * alphabetically. So installing an extension puts it at the end rather than
   * shuffling the menu the user already knows.
   */
  sortBy(ids) {
    const order = new Map((ids || []).map((id, i) => [id, i]));
    this.items = this.items.slice().sort((a, b) => {
      const i1 = order.has(a.id) ? order.get(a.id) : -1;
      const i2 = order.has(b.id) ? order.get(b.id) : -1;
      if (i1 < 0 && i2 >= 0) return 1;
      if (i2 < 0 && i1 >= 0) return -1;
      if (i1 < 0 && i2 < 0) return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      return i1 - i2;
    });
    return this;
  }

  shortCuts() { return this.items.filter((c) => c.shortCut).map((c) => c.shortCut); }

  equals(other) {
    const o = other instanceof CustomCommandList ? other : new CustomCommandList(other);
    return this.count === o.count && this.items.every((c, i) => c.equals(o.items[i]));
  }

  assign(other) {
    const o = other instanceof CustomCommandList ? other : new CustomCommandList(other);
    this.items = o.items.map((c) => CustomCommandType.from(c.toJSON()));
    this.modify();
    return this;
  }

  toJSON() { return this.items.map((c) => c.toJSON()); }
}

function normalizePathForCompare(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve the two roots used by WinConfiguration before any child path is
 * compared.  Portable mode deliberately makes user data beside the app;
 * callers may still override either root for tests and embedded launchers.
 */
function configurationRoots(options) {
  const o = options || {};
  const appRoot = path.resolve(expandEnvironmentVariables(String(o.appDir || process.cwd()), o.env));
  const portable = o.portable === true || (o.portable !== false && fs.existsSync(path.join(appRoot, 'winscp.ini')));
  const userRoot = o.userDataDir
    ? path.resolve(expandEnvironmentVariables(String(o.userDataDir), o.env))
    : (portable ? appRoot : path.resolve(expandEnvironmentVariables(String(o.defaultUserDataDir || path.join(os.homedir(), '.winscp-material')), o.env)));
  return { appRoot, userRoot, portable };
}

/**
 * TWinConfiguration::DefaultLocalized's custom commands, exactly as WinSCP
 * seeds them. Kept here as the reference the "are these still the defaults?"
 * check compares against, since a user who never touched the list must not be
 * asked to migrate one.
 */
function winscpDefaultCustomCommands() {
  return [
    { name: 'Execute', command: '"./!"', params: 0 },
    { name: 'Touch', command: 'touch "!"', params: CC.APPLY_TO_DIRECTORIES | CC.RECURSIVE },
    { name: 'Tar/GZip', command: 'tar -cz  -f "!?&Archive name:?archive.tgz!" !&', params: CC.APPLY_TO_DIRECTORIES },
    { name: 'UnTar/GZip', command: 'tar -xz --directory="!?&Target directory:?.!" -f "!"', params: 0 },
    { name: 'Grep', command: 'grep "!?&Text to find:?!" !&', params: CC.SHOW_RESULTS },
    { name: 'Print', command: 'notepad.exe /p "!"', params: CC.LOCAL },
  ].map((c) => new CustomCommandType(c));
}

// --- extension discovery ---------------------------------------------------

/** TWinConfiguration::GetExtensionsPaths, expressed as {pathId: directory}. */
function extensionsPaths(roots) {
  const r = roots || {};
  // WinSCP resolves configured roots before comparing them with discovered
  // files.  Do the same here: portable launchers commonly pass a relative
  // directory or a %VAR% path, and comparing that spelling with an absolute
  // path otherwise makes extension IDs silently become "foreign".
  const resolveRoot = (value, fallback) => {
    const raw = expandEnvironmentVariables(String(value || fallback));
    return path.resolve(raw);
  };
  const exeParent = resolveRoot(r.appDir, process.cwd());
  const userData = resolveRoot(r.userDataDir, path.join(os.homedir(), '.winscp-material'));
  return [
    [EXTENSION_PATH_IDS.COMMON, exeParent],
    [EXTENSION_PATH_IDS.COMMON_EXT, path.join(exeParent, EXTENSIONS_SUBFOLDER)],
    [EXTENSION_PATH_IDS.USER_EXT, path.join(userData, EXTENSIONS_SUBFOLDER)],
  ];
}

/** TWinConfiguration::GetExtensionId — "<pathId>/<baseName>", or "" when foreign. */
function extensionIdOfPath(extensionPath, roots) {
  const dir = normalizePathForCompare(path.dirname(String(extensionPath || '')));
  const nameId = extensionIdOfFileName(path.basename(String(extensionPath || '')));
  if (!nameId) return '';
  for (const [pathId, directory] of extensionsPaths(roots)) {
    if (normalizePathForCompare(directory) === dir) return `${pathId}/${nameId}`;
  }
  return '';
}

/** TWinConfiguration::GetProvisionaryExtensionId — before it has been installed. */
function provisionaryExtensionId(fileName) {
  return `${EXTENSION_PATH_IDS.USER_EXT}/${extensionBaseName(fileName)}`;
}

/** TWinConfiguration::UniqueExtensionName — the translation lookup strips digits. */
function uniqueExtensionName(name, counter) { return `${name}${counter}`; }

/**
 * TWinConfiguration::LoadExtensionList. Reads every extension found under the
 * search roots, honouring the three stored lists:
 *
 *   deleted   ids the user removed but whose file could not be deleted, so the
 *             extension must stay hidden. The list is REBUILT from what is
 *             actually still on disk, so a re-installed extension reappears
 *             instead of staying invisible forever.
 *   order     the menu order, with new extensions appended.
 *   shortCuts per-id overrides of the shortcut the file declares.
 *
 * A file that fails to parse is skipped, not reported — WinSCP swallows it so
 * one bad file in a folder cannot stop the program from starting.
 */
function loadExtensionList(options) {
  const opts = options || {};
  const readDir = opts.readDir || ((dir) => {
    try { return fs.readdirSync(dir); } catch { return []; }
  });
  const readFile = opts.readFile || ((file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  });

  const deleted = new Set(parseList(opts.deleted, '|'));
  const stillDeleted = [];
  const list = new CustomCommandList();

  for (const [pathId, directory] of extensionsPaths(opts.roots)) {
    for (const entry of readDir(directory)) {
      const nameId = extensionIdOfFileName(entry);
      if (!nameId) continue;
      const id = `${pathId}/${nameId}`;
      if (deleted.has(id)) { stillDeleted.push(id); continue; }
      const file = path.join(directory, entry);
      const text = readFile(file);
      if (text == null) continue;
      try {
        list.add(parseExtension(text, {
          id, fileName: file, translate: opts.translate, versions: opts.versions, appVersion: opts.appVersion,
        }));
      } catch {
        // Skip invalid extension files, exactly as DoLoadExtensionList does.
      }
    }
  }

  list.sortBy(parseList(opts.order, '|'));

  for (const entry of parseList(opts.shortCuts, '|')) {
    const { head, tail } = cutToChar(entry, '=', false);
    for (const command of list.items) {
      if (command.id === tail) command.shortCut = shortCutText(head);
    }
  }

  list.reset();
  return { list, deleted: stillDeleted.join('|') };
}

/**
 * TWinConfiguration::SetExtensionList, minus the file deletion the caller owns.
 * Returns the three bookkeeping strings that go back into the store: which ids
 * are still deleted, the new order, and the shortcuts that differ from the file.
 */
function extensionListState(list, previousDeleted, undeletableIds) {
  const deleted = new Set(parseList(previousDeleted, '|'));
  for (const id of undeletableIds || []) deleted.add(id);
  const items = (list instanceof CustomCommandList ? list : new CustomCommandList(list)).items;
  let order = '';
  for (const command of items) {
    order = addToList(order, command.id, '|');
    // Anything present again is no longer deleted, however it got back.
    deleted.delete(command.id);
  }
  let shortCuts = '';
  for (const command of items) {
    if (command.hasCustomShortCut()) shortCuts = addToList(shortCuts, `${command.shortCut}=${command.id}`, '|');
  }
  return { deleted: [...deleted].sort().join('|'), order, shortCuts };
}

// ---------------------------------------------------------------------------
// TCopyParamRule / TCopyParamList
// ---------------------------------------------------------------------------

const RULE_FIELDS = ['hostName', 'userName', 'remoteDirectory', 'localDirectory'];

/**
 * TCopyParamRule. Four masks; every populated one must match and an empty one
 * is not a constraint. Host and user match as plain names, the two directories
 * match as PATHS with forced directory masks — that is what lets a rule say
 * "/var/www" and have "/var/www/site" match it too.
 */
class CopyParamRule {
  constructor(data) {
    const d = data || {};
    for (const f of RULE_FIELDS) this[f] = String(d[f] || '');
  }

  get empty() { return RULE_FIELDS.every((f) => !this[f]); }

  equals(other) {
    const o = other instanceof CopyParamRule ? other : new CopyParamRule(other);
    return RULE_FIELDS.every((f) => this[f] === o[f]);
  }

  static match(mask, value, isPath, local, forceDirectoryMasks) {
    if (!mask) return true;
    const m = new masks.FileMask(mask, { forceDirectoryMasks });
    const v = String(value == null ? '' : value);
    if (!isPath) return m.matches(v, { isDir: false });
    const unix = v.replace(/\\/g, '/');
    const name = masks.baseOf(unix.replace(/\/+$/, '')) || unix;
    return m.matches(name, { isDir: true, path: unix, local });
  }

  matches(context) {
    const c = context || {};
    return CopyParamRule.match(this.hostName, c.hostName, false, true, 0)
      && CopyParamRule.match(this.userName, c.userName, false, true, 0)
      && CopyParamRule.match(this.remoteDirectory, c.remoteDirectory, true, false, 1)
      && CopyParamRule.match(this.localDirectory, c.localDirectory, true, true, 1);
  }

  /** TCopyParamRule::GetInfoStr — what the preset list shows in its Rule column. */
  infoStr(separator) {
    const sep = separator === undefined ? '; ' : separator;
    const parts = [];
    if (this.hostName) parts.push(`Host name: ${this.hostName}`);
    if (this.userName) parts.push(`User name: ${this.userName}`);
    if (this.remoteDirectory) parts.push(`Remote directory: ${this.remoteDirectory}`);
    if (this.localDirectory) parts.push(`Local directory: ${this.localDirectory}`);
    return parts.join(sep);
  }

  toJSON() {
    const out = {};
    for (const f of RULE_FIELDS) out[f] = this[f];
    return out;
  }
}

/**
 * TCopyParamList: named transfer presets, some carrying an auto-selection rule.
 * A name is a storage key, so "/", "\", "[" and "]" are refused rather than
 * quietly mangled.
 */
class CopyParamList {
  constructor(items) {
    this.items = (items || []).map((p) => ({
      id: p.id || '',
      name: String(p.name || ''),
      copyParam: { ...(p.copyParam || {}) },
      rule: p.rule && !new CopyParamRule(p.rule).empty ? new CopyParamRule(p.rule) : null,
    }));
    this.modified = false;
  }

  static validateName(name) {
    for (const ch of PRESET_INVALID_CHARS) {
      if (String(name).includes(ch)) {
        throw new Error(`The name "${name}" cannot contain any of the characters ${PRESET_INVALID_CHARS}.`);
      }
    }
    return true;
  }

  get count() { return this.items.length; }
  get(i) { return this.items[i]; }
  reset() { this.modified = false; }
  modify() { this.modified = true; }
  get names() { return this.items.map((p) => p.name); }
  indexOfName(name) { return this.items.findIndex((p) => p.name === name); }
  get anyRule() { return this.items.some((p) => p.rule); }

  add(name, copyParam, rule) { return this.insert(this.count, name, copyParam, rule); }

  insert(index, name, copyParam, rule) {
    CopyParamList.validateName(name);
    if (this.indexOfName(name) >= 0) throw new Error(`A transfer preset named "${name}" already exists.`);
    this.items.splice(index, 0, {
      id: (copyParam && copyParam.id) || '',
      name: String(name),
      copyParam: { ...(copyParam || {}) },
      rule: rule && !new CopyParamRule(rule).empty ? new CopyParamRule(rule) : null,
    });
    this.modify();
    return this;
  }

  change(index, name, copyParam, rule) {
    CopyParamList.validateName(name);
    const current = this.items[index];
    const nextRule = rule && !new CopyParamRule(rule).empty ? new CopyParamRule(rule) : null;
    const sameRule = (!current.rule && !nextRule) || (current.rule && nextRule && current.rule.equals(nextRule));
    if (current.name === name && sameRule
        && JSON.stringify(current.copyParam) === JSON.stringify(copyParam || {})) {
      return false;
    }
    this.items[index] = { id: current.id, name: String(name), copyParam: { ...(copyParam || {}) }, rule: nextRule };
    this.modify();
    return true;
  }

  move(from, to) {
    if (from === to) return false;
    const [item] = this.items.splice(from, 1);
    this.items.splice(to, 0, item);
    this.modify();
    return true;
  }

  delete(index) {
    if (index < 0 || index >= this.items.length) throw new RangeError(`No transfer preset at index ${index}`);
    this.items.splice(index, 1);
    this.modify();
    return true;
  }

  /** TCopyParamList::Find — the FIRST rule that matches wins, in list order. */
  find(context) {
    return this.items.findIndex((p) => p.rule && p.rule.matches(context));
  }

  equals(other) {
    const o = other instanceof CopyParamList ? other : new CopyParamList(other);
    if (this.count !== o.count) return false;
    return this.items.every((p, i) => {
      const q = o.items[i];
      const sameRule = (!p.rule && !q.rule) || (p.rule && q.rule && p.rule.equals(q.rule));
      return p.name === q.name && sameRule && JSON.stringify(p.copyParam) === JSON.stringify(q.copyParam);
    });
  }

  toJSON() {
    return this.items.map((p) => ({
      id: p.id,
      name: p.name,
      // The flattened rule the preset editor shows beside the name.
      autoSelect: p.rule ? RULE_FIELDS.map((f) => p.rule[f]).filter(Boolean).join(' ') : '',
      rule: p.rule ? p.rule.toJSON() : null,
      copyParam: { ...p.copyParam },
    }));
  }
}

/**
 * TGUIConfiguration::GetCopyParamPreset. A preset overrides everything EXCEPT
 * the three options WinSCP deliberately keeps global — resume support, the
 * resume threshold and the local invalid-character replacement. They describe
 * the machine, not the transfer, so a preset must not be able to change them.
 */
const PRESET_NON_CONFIGURABLE = ['resumeSupport', 'resumeThreshold', 'invalidCharsReplacement'];

function copyParamPreset(name, defaultCopyParam, list) {
  const base = { ...COPY_PARAM_DEFAULTS, ...(defaultCopyParam || {}) };
  if (!name) return base;
  const l = list instanceof CopyParamList ? list : new CopyParamList(list);
  const index = l.indexOfName(name);
  if (index < 0) return base;
  const merged = { ...base, ...l.items[index].copyParam };
  for (const field of PRESET_NON_CONFIGURABLE) merged[field] = base[field];
  return merged;
}

// ---------------------------------------------------------------------------
// bookmarks and location profiles
// ---------------------------------------------------------------------------

/**
 * TBookmark. A bookmark holds BOTH sides — that is what makes it a location
 * profile: opening it moves the local and the remote panel together.
 */
class Bookmark {
  constructor(data) {
    const d = data || {};
    this.node = String(d.node || '');
    this.name = String(d.name || '');
    this.local = String(d.local || '');
    this.remote = String(d.remote || '');
    this.shortCut = d.shortCut || '';
  }

  static key(node, name) { return `${node || ''}${name || ''}`; }
  get key() { return Bookmark.key(this.node, this.name); }

  // TBookmarkList's FBookmarks has CaseSensitive = false, so "Docs" and "docs"
  // are the SAME bookmark: WinSCP refuses the second one rather than creating a
  // near-duplicate the user cannot tell apart, and FindByName finds either.
  static sameKey(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

  /** TBookmark::GetSideDirectory. */
  sideDirectory(side) { return side === 'local' ? this.local : this.remote; }

  toJSON() {
    return { node: this.node, name: this.name, local: this.local, remote: this.remote, shortCut: this.shortCut };
  }
}

/**
 * TBookmarkList. Ordered, keyed by node+name, and it REFUSES a duplicate rather
 * than overwriting one — losing a bookmark to a name collision is exactly the
 * silent data loss this layer exists to prevent.
 */
class BookmarkList {
  constructor(data) {
    const d = Array.isArray(data) ? { bookmarks: data } : (data || {});
    this.items = (d.bookmarks || d.items || []).map((b) => new Bookmark(b));
    this.openedNodes = (d.openedNodes || []).map(String);
    this.modified = false;
  }

  get count() { return this.items.length; }
  get(i) { return this.items[i]; }
  indexOf(bookmark) { return this.items.findIndex((b) => Bookmark.sameKey(b.key, bookmark.key)); }

  add(bookmark) { return this.insert(this.count, bookmark); }

  insert(index, bookmark) {
    const b = bookmark instanceof Bookmark ? bookmark : new Bookmark(bookmark);
    if (!b.name) throw new Error('A bookmark needs a name.');
    if (this.items.some((x) => Bookmark.sameKey(x.key, b.key))) {
      throw new Error(`Bookmark "${b.name}" already exists.`);
    }
    this.items.splice(index, 0, b);
    this.modified = true;
    return b;
  }

  insertBefore(before, bookmark) { return this.insert(this.indexOf(before), bookmark); }

  /**
   * TBookmarkList::MoveTo. The index correction is not cosmetic: without it a
   * drag "before" an item lands after it whenever the source is above the
   * target, because removing the source shifts everything below it up.
   */
  moveTo(target, bookmark, before) {
    let newIndex = this.indexOf(target);
    const oldIndex = this.indexOf(bookmark);
    if (before && newIndex > oldIndex) newIndex--;
    else if (!before && newIndex < oldIndex) newIndex++;
    const [item] = this.items.splice(oldIndex, 1);
    this.items.splice(newIndex, 0, item);
    this.modified = true;
    return true;
  }

  delete(bookmark) {
    const i = this.indexOf(bookmark);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.modified = true;
    return true;
  }

  /** Renaming has to check the new key, or two bookmarks collide silently. */
  rename(bookmark, name, node) {
    const next = new Bookmark({ ...bookmark.toJSON(), name, node: node === undefined ? bookmark.node : node });
    if (!Bookmark.sameKey(next.key, bookmark.key) && this.items.some((x) => Bookmark.sameKey(x.key, next.key))) {
      throw new Error(`Bookmark "${next.name}" already exists.`);
    }
    const target = this.items[this.indexOf(bookmark)];
    target.name = next.name;
    target.node = next.node;
    this.modified = true;
    return target;
  }

  findByName(node, name) {
    const key = Bookmark.key(node, name);
    return this.items.find((b) => Bookmark.sameKey(b.key, key)) || null;
  }

  findByShortCut(shortCut) {
    return shortCut ? (this.items.find((b) => b.shortCut === shortCut) || null) : null;
  }

  shortCuts() { return this.items.filter((b) => b.shortCut).map((b) => b.shortCut); }

  nodeOpened(node) { return this.openedNodes.includes(node); }

  setNodeOpened(node, open) {
    const i = this.openedNodes.indexOf(node);
    if ((i >= 0) === !!open) return false;
    if (open) this.openedNodes.push(node); else this.openedNodes.splice(i, 1);
    this.openedNodes.sort();
    this.modified = true;
    return true;
  }

  /** The nodes (folders) actually in use, in first-seen order. */
  nodes() {
    const seen = [];
    for (const b of this.items) if (b.node && !seen.includes(b.node)) seen.push(b.node);
    return seen;
  }

  assign(other) {
    const o = other instanceof BookmarkList ? other : new BookmarkList(other);
    this.items = o.items.map((b) => new Bookmark(b.toJSON()));
    this.openedNodes = o.openedNodes.slice();
    this.modified = o.modified;
    return this;
  }

  toJSON() {
    return { bookmarks: this.items.map((b) => b.toJSON()), openedNodes: this.openedNodes.slice() };
  }

  /**
   * The `{local, remote, shortCuts}` shape design/main/config.js reads. Written
   * alongside the canonical list so the two never drift: this is the only place
   * that produces it.
   */
  toLegacy() {
    const shortCuts = {};
    for (const b of this.items) if (b.shortCut) shortCuts[b.name] = b.shortCut;
    return {
      local: this.items.filter((b) => b.local).map((b) => ({ path: b.local, name: b.name })),
      remote: this.items.filter((b) => b.remote).map((b) => ({ path: b.remote, name: b.name })),
      shortCuts,
    };
  }

  /** Rebuild from that legacy shape, pairing the two sides by bookmark name. */
  static fromLegacy(legacy) {
    const l = legacy || {};
    const byName = new Map();
    const take = (side, entries) => {
      for (const e of entries || []) {
        const name = e.name || e.path || '';
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, new Bookmark({ name }));
        byName.get(name)[side] = e.path || '';
      }
    };
    take('local', l.local);
    take('remote', l.remote);
    for (const [name, shortCut] of Object.entries(l.shortCuts || {})) {
      if (!byName.has(name)) byName.set(name, new Bookmark({ name }));
      byName.get(name).shortCut = shortCut;
    }
    const list = new BookmarkList({ bookmarks: [...byName.values()], openedNodes: l.openedNodes || [] });
    list.modified = false;
    return list;
  }
}

/**
 * TBookmarks: one bookmark list per session key, plus the shared list that the
 * location-profiles dialog uses when "use location profiles" is on.
 */
class Bookmarks {
  constructor(data) {
    this.lists = new Map();
    for (const [key, value] of Object.entries(data || {})) {
      const isCanonical = value && (Array.isArray(value.bookmarks) || Array.isArray(value.items));
      this.lists.set(key, isCanonical ? new BookmarkList(value) : BookmarkList.fromLegacy(value));
    }
  }

  keys() { return [...this.lists.keys()].sort(); }
  has(key) { return this.lists.has(key); }
  get(key) { return this.lists.get(key) || null; }

  /** Auto-vivify: asking for a session's bookmarks creates its list. */
  ensure(key) {
    if (!this.lists.has(key)) this.lists.set(key, new BookmarkList());
    return this.lists.get(key);
  }

  set(key, list) { this.ensure(key).assign(list); return this.lists.get(key); }
  get shared() { return this.ensure(SHARED_BOOKMARKS_KEY); }
  set shared(list) { this.set(SHARED_BOOKMARKS_KEY, list); }
  clear() { this.lists.clear(); }
  modifyAll(modified) { for (const l of this.lists.values()) l.modified = !!modified; }

  /** Both shapes, so config.js's readers keep working unchanged. */
  toJSON() {
    const out = {};
    for (const [key, list] of this.lists) out[key] = { ...list.toLegacy(), ...list.toJSON() };
    return out;
  }
}

// ---------------------------------------------------------------------------
// interface state
// ---------------------------------------------------------------------------

/**
 * The column layouts WinSCP ships. The format is
 * "<sortColumn>;<ascending>;<...>|<width,visible>;...|<column order>", written
 * verbatim so a configuration exported from here can be read by WinSCP.
 */
const SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT = '0;1;0|150,1;70,1;150,1;79,1;62,1;55,0;20,0;150,0;125,0;@96|6;7;8;0;1;2;3;4;5';
const SCP_COMMANDER_REMOTE_DIR_VIEW_PARAMS_DEFAULT = SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT;
const SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT = '0;1;0|150,1;70,1;120,1;150,1;55,0;55,0;@96|5;0;1;2;3;4';

const SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT = [
  'Queue=1::0+-1', 'Menu=1:TopDock:0+0', 'Buttons=1:TopDock:2+0', 'Selection=0:TopDock:3+0',
  'Session=0:TopDock:6+0', 'Preferences=1:TopDock:4+0', 'Sort=0:TopDock:5+0', 'Address=1:TopDock:1+0',
  'Updates=1:TopDock:4+393', 'Transfer=1:TopDock:4+171', 'CustomCommands=0:TopDock:7+0',
].join(',') + ',PixelsPerInch=96';

const SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT = [
  'Queue=1::0+-1', 'Menu=1:TopDock:0+0', 'Preferences=1:TopDock:1+228', 'Session=0:TopDock:1+602',
  'Sort=0:TopDock:2+0', 'Commands=1:TopDock:1+0', 'Updates=1:TopDock:1+596', 'Transfer=1:TopDock:1+341',
  'CustomCommands=0:TopDock:3+0', 'RemoteHistory=1:RemoteTopDock:0+172', 'RemoteNavigation=1:RemoteTopDock:0+252',
  'RemotePath=1:RemoteTopDock:0+0', 'RemoteFile=1:RemoteTopDock:1+0', 'RemoteSelection=1:RemoteTopDock:1+345',
  'LocalHistory=1:LocalTopDock:0+207', 'LocalNavigation=1:LocalTopDock:0+287', 'LocalPath=1:LocalTopDock:0+0',
  'LocalFile=1:LocalTopDock:1+0', 'LocalSelection=1:LocalTopDock:1+329', 'Toolbar2=0:BottomDock:1+0',
  'CommandLine=0:BottomDock:0+0',
].join(',') + ',PixelsPerInch=96';

const QUEUE_VIEW_LAYOUT_DEFAULT_WIDE = '70,250,250,80,80,80,100,;96';
const QUEUE_VIEW_LAYOUT_DEFAULT_NARROW = '70,160,160,80,80,80,100,;96';

/** TCustomWinConfiguration::FormatDefaultWindowParams / FormatDefaultWindowSize. */
function formatDefaultWindowParams(width, height) { return `-1;-1;${width};${height};0;96`; }
function formatDefaultWindowSize(width, height) { return `${width},${height},96`; }

/**
 * TWinConfiguration::Default's window sizing. WinSCP clamps its default window
 * to the work area so a small screen never opens a window it cannot show.
 */
function defaultInterfaceState(workArea) {
  const w = (workArea && workArea.width) || 1280;
  const h = (workArea && workArea.height) || 800;
  const explorerWidth = Math.min(w - 40, 960);
  const explorerHeight = Math.min(h - 30, 720);
  const commanderWidth = Math.min(w - 40, 1090);
  const commanderHeight = Math.min(h - 30, 700);
  const panel = (dirViewParams) => ({
    dirViewParams,
    viewStyle: 'report',
    statusBar: true,
    driveView: false,
    driveViewHeight: 100,
    driveViewWidth: 100,
    lastPath: '',
  });
  return {
    scpExplorer: {
      windowParams: formatDefaultWindowParams(explorerWidth, explorerHeight),
      dirViewParams: SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT,
      toolbarsLayout: SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT,
      toolbarsButtons: '',
      sessionsTabs: true,
      statusBar: true,
      lastLocalTargetDirectory: '',
      viewStyle: 'icon',
      showFullAddress: true,
      driveView: true,
      driveViewWidth: 180,
    },
    scpCommander: {
      windowParams: formatDefaultWindowParams(commanderWidth, commanderHeight),
      localPanelWidth: 0.5,
      toolbarsLayout: SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT,
      toolbarsButtons: '',
      sessionsTabs: true,
      statusBar: true,
      currentPanel: 'local',
      nortonLikeMode: 'keyboard',
      preserveLocalDirectory: false,
      compareByTime: true,
      compareBySize: false,
      swappedPanels: false,
      treeOnLeft: false,
      explorerKeyboardShortcuts: false,
      systemContextMenu: false,
      localPanel: panel(SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT),
      remotePanel: panel(SCP_COMMANDER_REMOTE_DIR_VIEW_PARAMS_DEFAULT),
      otherLocalPanelDirViewParams: SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT,
      otherLocalPanelViewStyle: 'report',
      otherLocalPanelLastPath: '',
    },
    queueView: {
      height: 140,
      layout: w > 1000 ? QUEUE_VIEW_LAYOUT_DEFAULT_WIDE : QUEUE_VIEW_LAYOUT_DEFAULT_NARROW,
      show: 'hideWhenEmpty',
      lastHideShow: 'hideWhenEmpty',
      toolBar: true,
      label: true,
      fileList: false,
      fileListHeight: 90,
    },
  };
}

/** TScpCommanderConfiguration::CompareCriterias. */
function compareCriterias(commander) {
  const c = commander || {};
  const out = [];
  if (c.compareByTime) out.push('time');
  if (c.compareBySize) out.push('size');
  return out;
}

/**
 * TWinConfiguration::ResolveDoubleClickAction. The surprising rule is the first
 * one: on a protocol where the panel cannot tell a symlinked directory from a
 * file (symlink resolution off, or the files are encrypted), a double click
 * changes directory instead of honouring the configured action — otherwise
 * entering a directory would become impossible. `alwaysRespectDoubleClickAction`
 * is the escape hatch for a user who would rather it did not guess.
 */
function resolveDoubleClickAction(options) {
  const o = options || {};
  if (o.isDirectory) return 'changeDir';
  if (o.hasSession && !o.resolvingSymlinks && !o.encryptingFiles && !o.alwaysRespectDoubleClickAction) {
    return 'changeDir';
  }
  const action = fromEnum(DOUBLE_CLICK_ACTION, o.doubleClickAction, 'edit');
  return action;
}

// ---------------------------------------------------------------------------
// file colours
// ---------------------------------------------------------------------------

const FILE_COLOR_SEPARATOR = ':';

/** TFileColorData: a mask and the colour files matching it are painted in. */
class FileColorData {
  constructor(data) {
    const d = data || {};
    this.mask = String(d.mask || '');
    this.color = String(d.color || '');
    this._mask = null;
  }

  /** TFileColorData::Load — "BBGGRR:mask", the mask keeping any colons it has. */
  static parse(s) {
    const { head, tail } = cutToChar(String(s || ''), FILE_COLOR_SEPARATOR, true);
    return new FileColorData({ color: colorFromWinscp(head), mask: tail });
  }

  /** TFileColorData::Save. */
  save() { return colorToWinscp(this.color) + FILE_COLOR_SEPARATOR + this.mask; }

  matches(name, params) {
    if (!this._mask) this._mask = new masks.FileMask(this.mask);
    return this._mask.matches(name, params || {});
  }

  toJSON() { return { mask: this.mask, color: this.color }; }
}

/** TFileColorData::LoadList / SaveList — a CommaText of "BBGGRR:mask" items. */
function loadFileColors(s) { return commaTextToList(s).map((item) => FileColorData.parse(item)); }
function saveFileColors(list) {
  return listToCommaText((list || []).map((c) => (c instanceof FileColorData ? c : new FileColorData(c)).save()));
}

/** The first rule that matches paints the file — later rules do not override. */
function fileColorFor(list, name, params) {
  for (const raw of list || []) {
    const rule = raw instanceof FileColorData ? raw : new FileColorData(raw);
    if (rule.mask && rule.matches(name, params)) return rule.color;
  }
  return '';
}

// ---------------------------------------------------------------------------
// temporary-directory policy
// ---------------------------------------------------------------------------

/** ExpandEnvironmentVariables for the %VAR% form Windows configurations use. */
function expandEnvironmentVariables(s, env) {
  const e = env || process.env;
  return String(s || '').replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(e).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : e[key];
  });
}

/**
 * The temporary-directory policy, ported from TWinConfiguration's
 * ExpandedTemporaryDirectory / TemporaryDir / FindTemporaryFolders /
 * CleanupTemporaryFolders and TCustomScpExplorerForm::
 * TemporaryDirectoryForRemoteFiles.
 *
 * Two rules are easy to get wrong and both are load-bearing:
 *
 *  * the generated folder name is "scp" + minutes + milliseconds, which is
 *    exactly five digits — the same width as the "scp?????" mask used to find
 *    leftovers later. Change the name format and cleanup stops finding them.
 *  * "deterministic" mode does NOT create a unique folder: the point is that
 *    editing the same remote file twice reuses the same local path, so an
 *    external editor's "recent files" keeps working. It therefore has no root
 *    directory to delete afterwards, which is why `rootDirectory` comes back
 *    empty and the caller must not remove anything.
 */
class TemporaryDirectoryPolicy {
  constructor(options) {
    const o = options || {};
    this.directory = String(o.directory || '');
    this.appendSession = !!o.appendSession;
    this.appendPath = o.appendPath === undefined ? true : !!o.appendPath;
    this.deterministic = !!o.deterministic;
    this.cleanup = o.cleanup === undefined ? true : !!o.cleanup;
    this.confirmCleanup = o.confirmCleanup === undefined ? true : !!o.confirmCleanup;
    this.env = o.env;
    this.systemTemp = o.systemTemp || os.tmpdir();
    this.fs = o.fs || fs;
    this.now = o.now || (() => new Date());
  }

  /** TWinConfiguration::ExpandedTemporaryDirectory. */
  expandedTemporaryDirectory() {
    const expanded = expandEnvironmentVariables(this.directory, this.env).trim();
    if (!expanded) return this.systemTemp;
    return path.resolve(expanded);
  }

  /** UniqTempDir. `mask` yields the glob used to find previous runs' folders. */
  temporaryDir(mask) {
    const base = this.expandedTemporaryDirectory();
    if (mask) return path.join(base, 'scp?????');
    for (;;) {
      const d = this.now();
      const stamp = String(d.getMinutes()).padStart(2, '0') + String(d.getMilliseconds()).padStart(3, '0');
      const candidate = path.join(base, `scp${stamp}`);
      let exists = false;
      try { exists = this.fs.statSync(candidate).isDirectory(); } catch { exists = false; }
      if (!exists) return candidate;
    }
  }

  /** TWinConfiguration::DoFindTemporaryFolders. */
  findTemporaryFolders(onlyFirst) {
    const base = this.expandedTemporaryDirectory();
    const out = [];
    let entries;
    try { entries = this.fs.readdirSync(base); } catch { return out; }
    for (const entry of entries) {
      if (!/^scp\d{5}$/.test(entry)) continue;
      const full = path.join(base, entry);
      try { if (!this.fs.statSync(full).isDirectory()) continue; } catch { continue; }
      out.push(full);
      if (onlyFirst) break;
    }
    return out.sort();
  }

  anyTemporaryFolders() { return this.findTemporaryFolders(true).length > 0; }

  /**
   * TWinConfiguration::CleanupTemporaryFolders. Every folder is attempted even
   * after one fails, and the failures are reported together — deleting three of
   * four and reporting only the first would leave the user hunting.
   */
  cleanupTemporaryFolders(folders) {
    const list = folders || this.findTemporaryFolders(false);
    const failed = [];
    for (const folder of list) {
      try { this.fs.rmSync(folder, { recursive: true, force: true }); } catch { failed.push(folder); }
      try { if (this.fs.statSync(folder)) failed.push(folder); } catch { /* gone, as intended */ }
    }
    if (failed.length) {
      const error = new Error(`Error deleting temporary directory:\n${[...new Set(failed)].join('\n')}`);
      error.folders = [...new Set(failed)];
      throw error;
    }
    return list;
  }

  /** TCustomScpExplorerForm::TemporaryDirectoryForRemoteFiles. */
  temporaryDirectoryFor(remoteDirectory, options) {
    const o = options || {};
    const simple = !!o.simple;
    let rootDirectory = '';
    let result;
    if (!this.deterministic || simple) {
      rootDirectory = withTrailingSep(this.temporaryDir(false));
      result = rootDirectory;
    } else {
      result = withTrailingSep(this.expandedTemporaryDirectory());
    }
    if (this.appendSession && !simple) {
      result = withTrailingSep(path.join(result, makeValidFileName(o.sessionName || '')));
    }
    if (this.appendPath && !simple) {
      let remote = String(remoteDirectory || '');
      if (remote.startsWith('/')) remote = remote.slice(1);
      const local = (o.validLocalPath || defaultValidLocalPath)(remote.replace(/\//g, path.sep));
      result = withTrailingSep(path.join(result, local));
    }
    return { directory: result, rootDirectory };
  }
}

function withTrailingSep(p) { return p.endsWith(path.sep) ? p : p + path.sep; }

/** TCopyParamType::ValidLocalPath, reduced to the character substitution. */
function defaultValidLocalPath(p) {
  return String(p || '').split(path.sep)
    .map((segment) => segment.replace(/[:*?"<>|]/g, '_'))
    .join(path.sep);
}

// ---------------------------------------------------------------------------
// version history
// ---------------------------------------------------------------------------

/** TWinConfiguration::DoIsBeta. */
function isBetaRelease(releaseType) {
  return sameText(releaseType, 'beta') || sameText(releaseType, 'rc');
}

/** Parse the ";"-separated "<compoundVersion>,<releaseType>" history. */
function parseVersionHistory(s) {
  return parseList(s, ';').map((entry) => {
    const { head, tail } = cutToChar(entry, ',', true);
    const version = parseInt(head, 10);
    return { version: Number.isFinite(version) ? version : 0, releaseType: tail };
  });
}

/**
 * TWinConfiguration::AddVersionToHistory. The build number is zeroed before the
 * comparison, so daily builds of the same release do not each add an entry.
 */
function addVersionToHistory(history, version, releaseType) {
  const current = zeroBuildNumber(version);
  const present = parseVersionHistory(history).some((e) => zeroBuildNumber(e.version) === current);
  if (present) return String(history || '');
  return addToList(String(history || ''), `${current},${releaseType || ''}`, ';');
}

/** TWinConfiguration::GetAnyBetaInVersionHistory. */
function anyBetaInVersionHistory(history) {
  return parseVersionHistory(history).some((e) => isBetaRelease(e.releaseType));
}

// ---------------------------------------------------------------------------
// the version-upgrade migrations
//
// Each entry is `{ name, apply(prefs, context) -> boolean }`. `apply` returns
// true when it changed something, so the caller can report exactly which
// migrations ran — a migration that silently does nothing is indistinguishable
// from one that is broken, and this is the code path nobody exercises twice.
//
// Every migration is idempotent: running the whole list against an
// already-current configuration must change nothing.
// ---------------------------------------------------------------------------

function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

const MIGRATIONS = [
  {
    name: 'interface',
    // TCustomWinConfiguration stores TInterface as an ordinal.
    apply(prefs) {
      if (typeof prefs.interface === 'number' || /^\d+$/.test(String(prefs.interface))) {
        prefs.interface = fromEnum(INTERFACE, prefs.interface, 'commander');
        return true;
      }
      return false;
    },
  },
  {
    name: 'doubleClickAction',
    // KEYEX(Enum, DoubleClickAction, L"CopyOnDoubleClick"): the setting is
    // still read from the key a bool used to live in, and the enum's ordinals
    // were chosen so false->open and true->copy survive the change of type.
    //
    // The key is NOT deleted afterwards: this port also uses `copyOnDoubleClick`
    // as a live preference of its own ("copy on double-click even when another
    // action is set", WinSCP's AlwaysRespectDoubleClickAction inverted), and
    // removing it would take that control's backing store with it.
    apply(prefs) {
      let changed = false;
      if (has(prefs, 'copyOnDoubleClick')
          && (!has(prefs, 'doubleClickAction') || !DOUBLE_CLICK_ACTION.includes(prefs.doubleClickAction))) {
        prefs.doubleClickAction = fromEnum(DOUBLE_CLICK_ACTION, prefs.copyOnDoubleClick, 'open');
        changed = true;
      }
      if (typeof prefs.doubleClickAction === 'number' || typeof prefs.doubleClickAction === 'boolean') {
        prefs.doubleClickAction = fromEnum(DOUBLE_CLICK_ACTION, prefs.doubleClickAction, 'edit');
        changed = true;
      }
      if (prefs.panel && (typeof prefs.panel.doubleClickAction === 'number'
          || typeof prefs.panel.doubleClickAction === 'boolean')) {
        prefs.panel.doubleClickAction = fromEnum(DOUBLE_CLICK_ACTION, prefs.panel.doubleClickAction, 'edit');
        changed = true;
      }
      return changed;
    },
  },
  {
    name: 'formatSizeBytes',
    // BaseUtils.pas chose the enum order so the previous bool still reads
    // correctly: false -> fbNone, true -> fbKilobytes.
    apply(prefs) {
      if (typeof prefs.formatSizeBytes === 'boolean' || typeof prefs.formatSizeBytes === 'number') {
        prefs.formatSizeBytes = fromEnum(FORMAT_BYTES, prefs.formatSizeBytes, 'kilo');
        return true;
      }
      return false;
    },
  },
  {
    name: 'nortonLikeMode',
    // KEYEX(Enum, ScpCommander.NortonLikeMode, L"ExplorerStyleSelection").
    // The old bool meant "use Explorer-style selection", so true is nlOff.
    apply(prefs) {
      const c = prefs.scpCommander;
      if (!c) return false;
      let changed = false;
      if (has(c, 'explorerStyleSelection')) {
        const legacy = c.explorerStyleSelection;
        delete c.explorerStyleSelection;
        if (typeof c.nortonLikeMode !== 'string') {
          c.nortonLikeMode = fromEnum(NORTON_LIKE, legacy, 'keyboard');
        }
        changed = true;
      }
      if (typeof c.nortonLikeMode === 'number') {
        c.nortonLikeMode = fromEnum(NORTON_LIKE, c.nortonLikeMode, 'keyboard');
        changed = true;
      }
      // `panel.explorerStyleSelection` is deliberately NOT read here: in this
      // port that is a live preference of its own, and mirroring it would
      // override the correct nlKeyboard default on a fresh configuration.
      return changed;
    },
  },
  {
    name: 'toolbarsLayout',
    // static KeyName(): "ToolbarsLayout2" falls back to the pre-rename
    // "ToolbarsLayout" when only the old one is present.
    apply(prefs) {
      let changed = false;
      for (const key of ['scpExplorer', 'scpCommander']) {
        const block = prefs[key];
        if (!block) continue;
        if (has(block, 'toolbarsLayoutOld')) {
          if (!block.toolbarsLayout) block.toolbarsLayout = block.toolbarsLayoutOld;
          delete block.toolbarsLayoutOld;
          changed = true;
        }
      }
      return changed;
    },
  },
  {
    name: 'panelSearch',
    // TIncrementalSearch's ordinals start at -1, so it cannot go through the
    // ordinary enum coercion.
    apply(prefs) {
      if (!prefs.panel) return false;
      const v = prefs.panel.incrementalSearch;
      if (typeof v === 'number' || (isString(v) && !['off', 'typing', 'ctrl'].includes(v))) {
        prefs.panel.incrementalSearch = panelSearchFromWinscp(v);
        return true;
      }
      return false;
    },
  },
  {
    name: 'ddTransferConfirmation',
    // WinSCP renamed this key to "DDTransferConfirmation2" when it became a
    // tri-state, and deliberately did NOT migrate the old value: stored as a
    // bool, false is 0 and asOn is also 0, so a straight read would turn
    // "confirmation off" into "confirmation always on" — inverted. Dropping
    // the stale key resets the option to asAuto, which is what WinSCP does.
    apply(prefs) {
      if (has(prefs, 'dDTransferConfirmationLegacy')) {
        delete prefs.dDTransferConfirmationLegacy;
        return true;
      }
      if (typeof prefs.dDTransferConfirmation === 'boolean') {
        prefs.dDTransferConfirmation = true;
        return false;
      }
      return false;
    },
  },
  {
    name: 'editorList',
    // TWinConfiguration::LoadFrom. An empty list means a configuration written
    // before the list existed; the single legacy editor becomes one or two rows.
    apply(prefs) {
      if (!prefs.editor) return false;
      const list = prefs.editor.list;
      if (Array.isArray(list) && list.length) return false;
      const legacy = prefs.editor.legacy || {
        editor: prefs.editor.editor,
        external: prefs.editor.externalEditor || prefs.editor.external || '',
        externalText: prefs.editor.externalEditorText,
        sdiExternal: prefs.editor.sDIExternalEditor,
        detectMdiExternal: prefs.editor.detectMDIExternalEditor,
      };
      const seed = (legacy.editor || legacy.external)
        ? EditorPreferences.from(legacy)
        : EditorPreferences.legacyDefaults();
      prefs.editor.list = editorListFromLegacy(seed).toJSON();
      delete prefs.editor.legacy;
      delete prefs.editor.externalEditor;
      delete prefs.editor.externalEditorText;
      delete prefs.editor.sDIExternalEditor;
      delete prefs.editor.detectMDIExternalEditor;
      return true;
    },
  },
  {
    name: 'copyParamList',
    // TGUIConfiguration::LoadData reads CopyParamList as a COUNT, where -1 is
    // the sentinel for "the user never touched the list, use the defaults".
    // Presets stored with only the flattened `autoSelect` string get a real
    // four-field rule so auto-selection can actually run.
    apply(prefs, context) {
      let changed = false;
      if (prefs.copyParamListCount === -1) {
        delete prefs.copyParamListCount;
        if (!Array.isArray(prefs.copyParamList) || !prefs.copyParamList.length) {
          prefs.copyParamList = clone((context && context.defaultPresets) || []);
        }
        changed = true;
      } else if (has(prefs, 'copyParamListCount')) {
        delete prefs.copyParamListCount;
        changed = true;
      }
      for (const preset of prefs.copyParamList || []) {
        if (preset.rule) continue;
        const auto = String(preset.autoSelect || '').trim();
        if (!auto) { preset.rule = null; continue; }
        // A flattened rule only ever held the host-name mask unambiguously.
        preset.rule = new CopyParamRule({ hostName: auto.split(/\s+/)[0] }).toJSON();
        changed = true;
      }
      return changed;
    },
  },
  {
    name: 'customCommands',
    // TWinConfiguration::LoadData: the list is the user's own once either the
    // CustomCommands key exists or the "CustomCommandsNone" marker does. The
    // marker exists precisely so that an EMPTY list is not mistaken for
    // "never configured" and re-seeded with the defaults on every start.
    apply(prefs, context) {
      if (prefs.customCommandsNone) {
        delete prefs.customCommandsNone;
        prefs.customCommands = [];
        return true;
      }
      if (!Array.isArray(prefs.customCommands) || prefs.customCommands.length) return false;
      if (!context || !context.defaultCustomCommands) return false;
      prefs.customCommands = clone(context.defaultCustomCommands);
      return true;
    },
  },
  {
    name: 'updatesConnectionType',
    // "for backward compatibility the default is decided based on value of
    // ProxyHost" — a configuration that predates the setting had a proxy
    // exactly when it had a proxy host.
    apply(prefs) {
      const u = prefs.updates;
      if (!u) return false;
      if (u.connectionType === undefined || u.connectionType === null
          || u.connectionType === -1 || u.connectionType === 'undefined') {
        u.connectionType = u.proxyHost ? 'proxy' : 'auto';
        return true;
      }
      if (typeof u.connectionType === 'number') {
        u.connectionType = fromEnum(CONNECTION_TYPE, u.connectionType, 'auto');
        return true;
      }
      return false;
    },
  },
  {
    name: 'puttyPath',
    // "Make it compatible with versions prior to 3.7.1 that have not saved
    // PuttyPath with quotes." Without the quotes, a path containing a space
    // splits and the parameters become part of the program name.
    apply(prefs, context) {
      const i = prefs.integration;
      if (!i || !i.puttyPath) return false;
      if (i.puttyPath.startsWith('"')) return false;
      const expanded = expandEnvironmentVariables(i.puttyPath, context && context.env);
      // IsPathToSameFile(ExpandEnvironmentVariables(FPuttyPath), FDefaultPuttyPathOnly):
      // BOTH sides are expanded, because the shipped default is written with
      // %ProgramFiles% in it. Comparing the expanded path against the unexpanded
      // default never matches, and comparing it against the stored value always
      // does — either way the "is it really a program?" guard stops working.
      const defaultPath = expandEnvironmentVariables(
        (context && context.defaultPuttyPath) || '', context && context.env);
      const isDefault = !!defaultPath
        && normalizePathForCompare(expanded) === normalizePathForCompare(defaultPath);
      const exists = context && context.fileExists ? context.fileExists(expanded) : false;
      if (!isDefault && !exists) return false;
      const quoted = formatCommand(i.puttyPath, '');
      // AddQuotes only quotes a path containing a space, so a path without one
      // comes back unchanged — report that as "nothing done", or every load
      // would claim to have migrated it.
      if (quoted === i.puttyPath) return false;
      i.puttyPath = quoted;
      return true;
    },
  },
  {
    name: 'sessionRememberPassword',
    // KEYEX(Bool, SessionRememberPassword, L"QueueRememberPassword") — the
    // setting outgrew the queue but kept reading the queue's key.
    apply(prefs) {
      if (!prefs.queue || !has(prefs.queue, 'queueRememberPassword')) return false;
      if (!has(prefs.queue, 'rememberPassword') || prefs.queue.rememberPassword === undefined) {
        prefs.queue.rememberPassword = !!prefs.queue.queueRememberPassword;
      }
      delete prefs.queue.queueRememberPassword;
      return true;
    },
  },
  {
    name: 'fileColors',
    // TFileColorData::LoadList — stored as a CommaText of "BBGGRR:mask" until
    // this port gave it a real array. The colour is BGR, not RGB.
    apply(prefs) {
      if (typeof prefs.fileColors !== 'string') return false;
      prefs.fileColors = loadFileColors(prefs.fileColors).map((c) => c.toJSON());
      return true;
    },
  },
  {
    name: 'bookmarks',
    // TBookmarks holds one list per session key, where each bookmark carries
    // BOTH directories. The earlier shape kept two independent arrays, which
    // cannot express a location profile at all.
    apply(prefs) {
      const b = prefs.bookmarks;
      if (!b || typeof b !== 'object') return false;
      let changed = false;
      for (const [key, value] of Object.entries(b)) {
        if (!value || Array.isArray(value.bookmarks)) continue;
        const list = BookmarkList.fromLegacy(value);
        b[key] = { ...list.toLegacy(), ...list.toJSON() };
        changed = true;
      }
      return changed;
    },
  },
  {
    name: 'versionHistory',
    // TWinConfiguration::AddVersionToHistory, called from both Default() and
    // LoadFrom() so the history records every version that ever read the file.
    apply(prefs, context) {
      if (!context || !context.compoundVersion) return false;
      const before = prefs.versionHistoryVersions || '';
      const after = addVersionToHistory(before, context.compoundVersion, context.releaseType);
      if (after === before) return false;
      prefs.versionHistoryVersions = after;
      return true;
    },
  },
];

/**
 * Run every migration over `prefs` in place.
 *
 * `fromVersion` is informational: the migrations are written to be idempotent
 * and to detect the old shape themselves, because a configuration edited by
 * hand or restored from a version-history revision can carry an old shape under
 * a current version number. Trusting the number alone is how settings get lost.
 */
function migrate(prefs, options) {
  const opts = options || {};
  const context = {
    compoundVersion: opts.compoundVersion,
    releaseType: opts.releaseType,
    defaultPresets: opts.defaultPresets,
    defaultCustomCommands: opts.defaultCustomCommands,
    defaultPuttyPath: opts.defaultPuttyPath,
    fileExists: opts.fileExists,
    env: opts.env,
  };
  const applied = [];
  for (const migration of MIGRATIONS) {
    let changed = false;
    try {
      changed = !!migration.apply(prefs, context);
    } catch (e) {
      // One bad migration must not abandon the rest of the configuration.
      applied.push(`${migration.name}!${e.message}`);
      continue;
    }
    if (changed) applied.push(migration.name);
  }
  return { prefs, applied, version: CONFIG_VERSION };
}

// ---------------------------------------------------------------------------
// TWinConfiguration
// ---------------------------------------------------------------------------

/**
 * The application-behaviour layer over a `Config` store.
 *
 * Everything is read through the store, so a preference changed anywhere is
 * seen here immediately, and everything written goes back through the store's
 * setters, so it lands in the version history like any other change.
 */
class WinConfiguration {
  constructor(config, options) {
    const o = options || {};
    this.config = config;
    this.appVersion = o.appVersion || '0.1.0';
    this.releaseType = o.releaseType || '';
    this.workArea = o.workArea || { width: 1280, height: 800 };
    this.roots = o.roots || {};
    this.env = o.env;
    this.configurationRoots = configurationRoots({ ...this.roots, appDir: o.appDir || this.roots.appDir,
      userDataDir: o.userDataDir || this.roots.userDataDir, portable: o.portable, env: this.env,
      defaultUserDataDir: o.defaultUserDataDir });
    this.defaultPresets = o.defaultPresets || [];
    this.defaultCustomCommands = o.defaultCustomCommands || [];
    this.migrationsApplied = [];
  }

  get prefs() { return this.config.prefs; }
  get compoundVersion() { return strToCompoundVersion(this.appVersion); }

  /** The resolved roots are immutable for a running configuration instance. */
  get portableMode() { return this.configurationRoots.portable; }
  get appRoot() { return this.configurationRoots.appRoot; }
  get userDataRoot() { return this.configurationRoots.userRoot; }

  /** Persist the current store immediately, returning the durable file paths. */
  flush() {
    this.config.flush();
    return { config: path.join(this.userDataRoot, 'winscp-material.json'),
      hostKeys: path.join(this.userDataRoot, 'hostkeys.json') };
  }

  /** Re-read persisted state after an external editor/import changed the file. */
  reload() {
    this.config.load();
    this._editorList = null;
    this._customCommandList = null;
    this._copyParamList = null;
    this._bookmarks = null;
    return this.load();
  }

  /**
   * Bring a just-loaded store up to the current shape and fill in anything the
   * defaults could not: the interface state depends on the screen, and the
   * version history depends on which build is running.
   */
  load() {
    const result = migrate(this.prefs, {
      compoundVersion: this.compoundVersion,
      releaseType: this.releaseType,
      defaultPresets: this.defaultPresets,
      defaultCustomCommands: this.defaultCustomCommands,
      // TGUIConfiguration::Default's FDefaultPuttyPath, not whatever is stored:
      // passing the stored value would make every path look like the default.
      defaultPuttyPath: DEFAULT_PUTTY_PATH,
      env: this.env,
      fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    });
    this.migrationsApplied = result.applied;
    this.applyInterfaceDefaults();
    if (this.config.data) this.config.data.version = CONFIG_VERSION;
    if (result.applied.length) this.config.save('Upgraded the configuration');
    return this;
  }

  /** Fill only the layout fields the store left empty — never overwrite one. */
  applyInterfaceDefaults() {
    const defaults = defaultInterfaceState(this.workArea);
    const fill = (target, source) => {
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (!target[key] || typeof target[key] !== 'object') target[key] = {};
          fill(target[key], value);
        } else if (target[key] === undefined || target[key] === '') {
          target[key] = value;
        }
      }
    };
    fill(this.prefs.scpExplorer || (this.prefs.scpExplorer = {}), defaults.scpExplorer);
    fill(this.prefs.scpCommander || (this.prefs.scpCommander = {}), defaults.scpCommander);
    // The queue view is sized from the work area too (TWinConfiguration::Default
    // picks the wide column layout only above 1000 logical pixels), so it has to
    // be filled here as well or that decision is computed and then discarded.
    fill(this.prefs.queueView || (this.prefs.queueView = {}), defaults.queueView);
    return this;
  }

  // ------------------------------------------------------------- interface
  get interface() { return fromEnum(INTERFACE, this.prefs.interface, 'commander'); }
  set interface(v) { this.config.setPref('interface', fromEnum(INTERFACE, v, 'commander'), 'Changed the interface'); }

  get scpExplorer() { return this.prefs.scpExplorer; }
  get scpCommander() { return this.prefs.scpCommander; }

  compareCriterias() { return compareCriterias(this.prefs.scpCommander); }

  /**
   * TWinConfiguration::UseDarkTheme — asAuto follows the system, so this is the
   * one place the tri-state resolves to a real yes/no.
   */
  useDarkTheme(systemIsDark) {
    const mode = (this.prefs.theme && this.prefs.theme.mode) || 'light';
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return !!systemIsDark;
  }

  resolveDoubleClickAction(options) {
    return resolveDoubleClickAction({
      doubleClickAction: (this.prefs.panel && this.prefs.panel.doubleClickAction) || this.prefs.doubleClickAction,
      alwaysRespectDoubleClickAction: !!this.prefs.alwaysRespectDoubleClickAction,
      ...(options || {}),
    });
  }

  // --------------------------------------------------------------- editors
  get editorList() {
    if (!this._editorList) this._editorList = new EditorList((this.prefs.editor && this.prefs.editor.list) || []);
    return this._editorList;
  }

  set editorList(list) {
    const next = list instanceof EditorList ? list : new EditorList(list);
    if (this.editorList.equals(next)) return;
    this._editorList = next;
    this.config.setPref('editor.list', next.toJSON(), 'Changed the editor list');
    next.saved();
  }

  /** TWinConfiguration::DefaultEditorForFile. */
  defaultEditorForFile(fileName, local, params) {
    return this.editorList.find(fileName, local, params);
  }

  // -------------------------------------------------------- custom commands
  get customCommandList() {
    if (!this._customCommandList) this._customCommandList = new CustomCommandList(this.prefs.customCommands || []);
    return this._customCommandList;
  }

  set customCommandList(list) {
    const next = list instanceof CustomCommandList ? list : new CustomCommandList(list);
    if (this.customCommandList.equals(next)) return;
    this._customCommandList = next;
    this.config.setPref('customCommands', next.toJSON(), 'Changed the custom commands');
    next.reset();
  }

  /** True while the user has not touched the shipped command list. */
  customCommandsAreDefaults() {
    const shipped = new CustomCommandList(this.defaultCustomCommands);
    return this.customCommandList.equals(shipped)
      || this.customCommandList.equals(new CustomCommandList(winscpDefaultCustomCommands()));
  }

  get extensionList() {
    if (!this._extensionList) this._extensionList = new CustomCommandList(this.prefs.extensions || []);
    return this._extensionList;
  }

  /** TWinConfiguration::LoadExtensionList, wired to this configuration. */
  loadExtensions(options) {
    const state = this.prefs.extensionState || {};
    const result = loadExtensionList({
      roots: this.roots,
      deleted: state.deleted,
      order: state.order,
      shortCuts: state.shortCuts,
      appVersion: this.appVersion,
      versions: { winscp: this.compoundVersion },
      ...(options || {}),
    });
    this._extensionList = result.list;
    this.config.setPrefs({
      extensions: result.list.toJSON(),
      extensionState: { ...state, deleted: result.deleted },
    }, 'Reloaded the extensions');
    return result.list;
  }

  /** TWinConfiguration::SetExtensionList: order, deletions and shortcuts. */
  setExtensionList(list, undeletableIds) {
    const next = list instanceof CustomCommandList ? list : new CustomCommandList(list);
    const state = this.prefs.extensionState || {};
    const nextState = extensionListState(next, state.deleted, undeletableIds);
    this._extensionList = next;
    this.config.setPrefs({ extensions: next.toJSON(), extensionState: nextState }, 'Changed the extensions');
    return next;
  }

  /** TWinConfiguration::CustomCommandShortCuts — commands and extensions both. */
  customCommandShortCuts() {
    return [...this.customCommandList.shortCuts(), ...this.extensionList.shortCuts()];
  }

  // -------------------------------------------------------- transfer presets
  get copyParamList() {
    if (!this._copyParamList) this._copyParamList = new CopyParamList(this.prefs.copyParamList || []);
    return this._copyParamList;
  }

  set copyParamList(list) {
    const next = list instanceof CopyParamList ? list : new CopyParamList(list);
    if (this.copyParamList.equals(next)) return;
    // Keep the active name meaningful when the list editor renames or removes
    // that preset. Write both fields in one patch so a debounced save cannot
    // persist a list with a dangling selection.
    const current = this.copyParamCurrent;
    const selected = current && next.indexOfName(current) >= 0 ? current : '';
    const previousList = this._copyParamList;
    this._copyParamList = next;
    try {
      this.config.setPrefs({
        copyParamList: next.toJSON(),
        ...(selected === current ? {} : { copyParamCurrent: selected }),
      }, 'Changed the transfer presets');
      next.reset();
    } catch (error) {
      this._copyParamList = previousList;
      throw error;
    }
  }

  get copyParamCurrent() { return this.prefs.copyParamCurrent || ''; }
  set copyParamCurrent(name) { this.config.setPref('copyParamCurrent', name || '', 'Changed the transfer preset'); }

  /** TGUIConfiguration::GetCopyParamIndex — "" means the default settings. */
  get copyParamIndex() {
    return this.copyParamCurrent ? this.copyParamList.indexOfName(this.copyParamCurrent) : -1;
  }

  set copyParamIndex(i) {
    this.copyParamCurrent = i < 0 ? '' : (this.copyParamList.names[i] || '');
  }

  /** TGUIConfiguration::GetHasCopyParamPreset. */
  hasCopyParamPreset(name) { return !name || this.copyParamList.indexOfName(name) >= 0; }

  copyParamPreset(name) { return copyParamPreset(name, this.prefs.copyParam, this.copyParamList); }

  get currentCopyParam() { return this.copyParamPreset(this.copyParamCurrent); }

  /** The preset a session auto-selects, or null. First matching rule wins. */
  autoSelectPreset(context) {
    const i = this.copyParamList.find(context);
    return i < 0 ? null : this.copyParamList.get(i);
  }

  // ------------------------------------------------------------- bookmarks
  get bookmarks() {
    if (!this._bookmarks) this._bookmarks = new Bookmarks(this.prefs.bookmarks || {});
    return this._bookmarks;
  }

  bookmarksFor(key) { return this.bookmarks.ensure(key); }

  /** The shared list the location-profiles dialog edits. */
  get locationProfiles() { return this.bookmarks.shared; }

  get useLocationProfiles() { return !!this.prefs.useLocationProfiles; }
  set useLocationProfiles(v) {
    this.config.setPref('useLocationProfiles', !!v, 'Changed the location-profile mode');
  }

  /** Persist the bookmark store in both shapes and clear the modified flags. */
  saveBookmarks(reason) {
    this.config.setPref('bookmarks', this.bookmarks.toJSON(), reason || 'Changed the bookmarks');
    this.bookmarks.modifyAll(false);
    return this;
  }

  // ---------------------------------------------------------- file colours
  get fileColors() { return (this.prefs.fileColors || []).map((c) => new FileColorData(c)); }
  set fileColors(list) {
    this.config.setPref('fileColors', (list || []).map((c) => (c instanceof FileColorData ? c : new FileColorData(c)).toJSON()),
      'Changed the file colours');
  }

  fileColorFor(name, params) { return fileColorFor(this.fileColors, name, params); }

  // ---------------------------------------------------- temporary directory
  temporaryDirectoryPolicy(overrides) {
    return new TemporaryDirectoryPolicy({
      directory: this.prefs.dDTemporaryDirectory || '',
      appendSession: !!this.prefs.temporaryDirectoryAppendSession,
      appendPath: this.prefs.temporaryDirectoryAppendPath !== false,
      deterministic: !!this.prefs.temporaryDirectoryDeterministic,
      cleanup: this.prefs.temporaryDirectoryCleanup !== false,
      confirmCleanup: this.prefs.confirmTemporaryDirectoryCleanup !== false,
      env: this.env,
      ...(overrides || {}),
    });
  }

  // ------------------------------------------------------- version history
  get versionHistory() { return parseVersionHistory(this.prefs.versionHistoryVersions || ''); }
  get anyBetaInVersionHistory() { return anyBetaInVersionHistory(this.prefs.versionHistoryVersions || ''); }
  get isBeta() { return isBetaRelease(this.releaseType); }
}

module.exports = {
  // the configuration layer
  WinConfiguration,
  CONFIG_VERSION,
  migrate,
  MIGRATIONS,

  // enums
  EDITOR, DOUBLE_CLICK_ACTION, RESOLVED_DOUBLE_CLICK, AUTO_SWITCH, FORMAT_BYTES,
  NORTON_LIKE, PANEL_SEARCH, QUEUE_VIEW_SHOW, PATH_IN_CAPTION, SESSION_TAB_NAME_FORMAT,
  INTERFACE, STORE_TRANSITION, GENERATE_URL_CODE_TARGET, SCRIPT_FORMAT,
  LOCALE_FLAG_OVERRIDE, CONNECTION_TYPE, CC, OPTION_KIND, OPTION_FLAG,
  DEFAULT_EXTERNAL_EDITOR, EXTENSION_EXT, SHARED_BOOKMARKS_KEY, HIDDEN_PREFIX,
  PRESET_INVALID_CHARS, EXTENSION_PATH_IDS,
  fromEnum, toEnum, panelSearchFromWinscp,

  // editors
  EditorPreferences, EditorList, editorListFromLegacy,

  // custom commands and extensions
  CustomCommandType, CustomCommandList, CommandOption, ExtensionError,
  parseExtension, parseExtensionOption, loadExtensionList, extensionListState,
  extensionIdOfFileName, extensionIdOfPath, provisionaryExtensionId, uniqueExtensionName,
  extensionsPaths, extensionBaseName, winscpDefaultCustomCommands,
  configurationRoots,
  paramsFromBits, paramsToBits, cutTokens,
  normalizeShortCut, shortCutToText, textToShortCut, shortCutCode, shortCutText,
  isCustomShortCutCode, normalizeCustomShortCutCode,

  // transfer presets
  CopyParamRule, CopyParamList, copyParamPreset, PRESET_NON_CONFIGURABLE, RULE_FIELDS,

  // bookmarks and location profiles
  Bookmark, BookmarkList, Bookmarks,

  // interface state
  defaultInterfaceState, compareCriterias, resolveDoubleClickAction,
  formatDefaultWindowParams, formatDefaultWindowSize,
  SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT, SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT,
  SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT, SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT,

  // file colours
  FileColorData, loadFileColors, saveFileColors, fileColorFor,
  colorToWinscp, colorFromWinscp,

  // temporary directory
  TemporaryDirectoryPolicy, expandEnvironmentVariables, makeValidFileName,

  // version history
  parseVersionHistory, addVersionToHistory, anyBetaInVersionHistory, isBetaRelease,
  compoundVersion, zeroBuildNumber, strToCompoundVersion, compareVersion,

  // shared helpers, exported because the tests assert their edge cases
  addToList, cutToChar, parseList, splitCommand, formatCommand, addQuotes,
  extractProgramName, reformatFileNameCommand,
  commaTextToList, listToCommaText, sameText,
};
