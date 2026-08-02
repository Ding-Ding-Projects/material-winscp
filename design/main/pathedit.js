// pathedit.js — the path edit, the path label and the history combo box.
//
// Ported from source/packages/my/HistoryComboBox.cpp/.h and PathLabel.pas, the
// path-word-break procedure in source/windows/VCLCommon.cpp, and the path combo
// boxes in source/forms/CustomScpExplorer.cpp and ScpCommander.cpp.
//
// These are text controls in WinSCP, but almost nothing in them is drawing:
//
//   * a history list with WinSCP's exact save rules — deduplicate, most recent
//     first, trimmed to a maximum, saved on drop-down and on leaving the field
//   * word-wise caret movement that stops at path separators rather than at
//     English word boundaries, so Ctrl+Left in "/var/log/nginx" walks the path
//   * the path label's breadcrumbs: which prefix a click on a given character
//     selects, and how a path is shortened when it does not fit
//   * the path combo box contents for both sides, and which directory each
//     entry navigates to
//   * inline completion, the way a VCL combo box completes as you type
//
// Pure logic: no DOM, no Electron, no I/O.

'use strict';

const C = require('./common');

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/** THistoryComboBox's published defaults. */
const DEFAULT_MAX_HISTORY_SIZE = 30;
const DEFAULT_HISTORY_DROP_DOWN_COUNT = 16;
const DEFAULT_HISTORY_AUTO_COMPLETE = false;

/** THistorySaveOn — when the current text joins the history. */
const HISTORY_SAVE_ON = Object.freeze({ Exit: 'exit', DropDown: 'dropDown' });
const DEFAULT_HISTORY_SAVE_ON = Object.freeze([HISTORY_SAVE_ON.Exit, HISTORY_SAVE_ON.DropDown]);

/**
 * ::SaveToHistory — the one function every history list in WinSCP goes through.
 *
 * An empty string is never stored (so tabbing through an empty field does not
 * fill the history with blanks), an existing occurrence is REMOVED first rather
 * than left in place, the entry goes to the front, and the list is then trimmed
 * from the END so the oldest entries are what is lost.
 *
 * The trim runs even when nothing was added, which is how lowering the maximum
 * takes effect immediately.
 *
 * Returns a new array; the caller decides what to do with it.
 */
function saveToHistory(strings, text, maxHistorySize) {
  const max = maxHistorySize === undefined ? DEFAULT_MAX_HISTORY_SIZE : maxHistorySize;
  const out = Array.isArray(strings) ? strings.slice() : [];
  const value = text == null ? '' : String(text);

  if (value !== '') {
    // A while loop, not one splice: the C++ deletes EVERY occurrence, which
    // matters for a list that was loaded from a file somebody hand-edited.
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i] === value) out.splice(i, 1);
    }
    out.unshift(value);
  }

  while (out.length > max) out.pop();
  return out;
}

/**
 * THistoryComboBox as a model.
 *
 * The events are named for what the user did, not for a Windows message, and
 * each returns whether the history changed so a caller can persist only when
 * there is something to persist.
 */
class HistoryCombo {
  constructor(options) {
    const o = options || {};
    this.items = Array.isArray(o.items) ? o.items.slice() : [];
    this.text = o.text == null ? '' : String(o.text);
    this.saveOn = new Set(o.saveOn || DEFAULT_HISTORY_SAVE_ON);
    this.maxHistorySize = o.maxHistorySize === undefined
      ? DEFAULT_MAX_HISTORY_SIZE : o.maxHistorySize;
    this.dropDownCount = o.dropDownCount === undefined
      ? DEFAULT_HISTORY_DROP_DOWN_COUNT : o.dropDownCount;
    this.autoComplete = o.autoComplete === undefined
      ? DEFAULT_HISTORY_AUTO_COMPLETE : !!o.autoComplete;
    this.historyKey = o.historyKey || '';
    this.droppedDown = false;
    this.itemIndex = -1;
  }

  /** SetMaxHistorySize — lowering the limit trims immediately. */
  setMaxHistorySize(value) {
    this.maxHistorySize = value;
    let changed = false;
    while (this.items.length > this.maxHistorySize) { this.items.pop(); changed = true; }
    return changed;
  }

  /** AddToHistory — and ItemIndex := 0, so the field now shows a stored entry. */
  addToHistory() {
    if (this.text === '') return false;
    const before = this.items;
    this.items = saveToHistory(this.items, this.text, this.maxHistorySize);
    this.itemIndex = 0;
    return before.length !== this.items.length || before[0] !== this.items[0];
  }

  /** DoExit — leaving the field saves it, if SaveOn says so. */
  exit() {
    if (!this.saveOn.has(HISTORY_SAVE_ON.Exit)) return false;
    return this.addToHistory();
  }

  /** DropDown — opening the list saves the typed text first, so it is in it. */
  dropDown() {
    this.droppedDown = true;
    if (!this.saveOn.has(HISTORY_SAVE_ON.DropDown)) return false;
    return this.addToHistory();
  }

  close() { this.droppedDown = false; return this; }

  /**
   * KeyDown. Two behaviours, both easy to lose:
   *
   *   * Up/Down (without Alt) on text that is NOT already in the list saves it
   *     first, so stepping through the history does not silently discard what
   *     the user had typed.
   *   * Ctrl+Delete while the list is open CLEARS the whole history. It is a
   *     destructive command with no confirmation in WinSCP, and it is only
   *     available when the control actually keeps a history.
   *
   * Returns `{ handled, historyChanged }`; `handled` means the key must not
   * reach the default handler.
   */
  keyDown(key, shift) {
    const s = shift || {};
    if ((key === 'ArrowDown' || key === 'ArrowUp') && !s.alt
      && this.saveOn.has(HISTORY_SAVE_ON.DropDown)) {
      if (!this.items.includes(this.text)) {
        return { handled: false, historyChanged: this.addToHistory() };
      }
    }
    if (this.droppedDown && key === 'Delete' && s.ctrl && this.saveOn.size > 0) {
      const had = this.items.length > 0;
      this.items = [];
      this.itemIndex = -1;
      return { handled: true, historyChanged: had };
    }
    return { handled: false, historyChanged: false };
  }

  /**
   * Change — THistoryComboBox reports the DATA attached to the item whose text
   * matches, looked up by text rather than by ItemIndex, because ItemIndex is
   * not reliable while the user is typing.
   */
  setText(text) {
    this.text = text == null ? '' : String(text);
    this.itemIndex = this.items.indexOf(this.text);
    return this.itemIndex;
  }

  /** SaveToHistory — the explicit "remember this" a dialog calls on OK. */
  save() {
    const changed = this.addToHistory();
    return changed;
  }
}

// ---------------------------------------------------------------------------
// inline completion
// ---------------------------------------------------------------------------

/**
 * A VCL combo box with AutoComplete finds the first item that starts with what
 * has been typed, puts it in the field, and SELECTS the part it added — so the
 * next keystroke replaces the suggestion rather than appending to it.
 *
 * Two refusals matter:
 *   * deleting never completes. Without that, backspace is unusable: it removes
 *     a character and completion immediately puts it back.
 *   * an empty field never completes, or the field would fill itself the moment
 *     it is cleared.
 *
 * Matching is case-insensitive but the SUGGESTION keeps the stored item's case
 * while the typed prefix keeps the user's, so typing "doc" against "Documents"
 * gives "documents"… which is wrong. WinSCP's combo replaces the whole text
 * with the item, so that is what this does: the field shows "Documents" with
 * "uments" selected.
 */
function completeInline(text, items, options) {
  const o = options || {};
  const typed = text == null ? '' : String(text);
  if (o.deleting || typed === '') {
    return { text: typed, selectionStart: typed.length, selectionEnd: typed.length, completed: false };
  }
  const lower = typed.toLowerCase();
  for (const item of (items || [])) {
    const candidate = String(item);
    if (candidate.length > typed.length && candidate.toLowerCase().startsWith(lower)) {
      return {
        text: candidate,
        selectionStart: typed.length,
        selectionEnd: candidate.length,
        completed: true,
      };
    }
  }
  return { text: typed, selectionStart: typed.length, selectionEnd: typed.length, completed: false };
}

/**
 * The completion candidates for a partially typed path: the entries of the
 * directory already typed, joined back onto it. `list(dir)` supplies the names
 * — this module never touches a filesystem.
 *
 * "/var/lo" asks for the contents of "/var" and offers "/var/log"; "/var/"
 * asks for "/var" and offers everything in it.
 */
function pathCompletions(text, list, options) {
  const o = options || {};
  const unix = o.unix !== false;
  const separator = unix ? '/' : '\\';
  const typed = text == null ? '' : String(text);
  const cut = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'));
  const dir = cut < 0 ? '' : typed.slice(0, cut + 1);
  const prefix = cut < 0 ? typed : typed.slice(cut + 1);

  const lookupDir = dir === '' ? (o.currentPath || '') : dir;
  let names;
  try {
    names = list(stripTrailingSeparator(lookupDir, separator) || (unix ? '/' : lookupDir)) || [];
  } catch {
    // A directory that cannot be read completes to nothing rather than
    // throwing out of a keystroke handler.
    return [];
  }

  const lower = prefix.toLowerCase();
  const out = [];
  for (const name of names) {
    const n = String(name);
    if (n === '.' || n === '..') continue;
    if (prefix !== '' && !n.toLowerCase().startsWith(lower)) continue;
    out.push(dir + n);
  }
  // Sorted the way the panel sorts names, so the first suggestion is the first
  // one the user would see in the panel.
  out.sort((a, b) => C.compareLogicalText(a, b, o.naturalOrderNumericalSorting !== false));
  return out;
}

function stripTrailingSeparator(path, separator) {
  let p = String(path || '');
  while (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) p = p.slice(0, -1);
  if (p === separator) return p;
  return p;
}

// ---------------------------------------------------------------------------
// path-aware word breaks
// ---------------------------------------------------------------------------

/**
 * PathWordBreakProc (VCLCommon.cpp). WinSCP replaces the edit control's word
 * breaking so Ctrl+Left/Right in a path field moves between path components
 * instead of between English words.
 *
 * The delimiter set is WinSCP's own and includes the comma, the semicolon and
 * the equals sign, because the same procedure is installed on the mask combo
 * boxes, where those separate one mask from the next.
 */
const PATH_WORD_DELIMITERS = '\\/ ;,.\r\n=';

function isPathWordDelimiter(ch) {
  return typeof ch === 'string' && ch.length === 1 && PATH_WORD_DELIMITERS.includes(ch);
}

/**
 * WB_LEFT — skip any run of delimiters to the left of the caret, then stop
 * after the previous delimiter. Positions are 0-based caret offsets; the C++
 * works in 1-based character indexes and the conversion is done here so no
 * caller has to.
 */
function wordLeft(text, position) {
  const s = String(text == null ? '' : text);
  let current = Math.max(0, Math.min(position, s.length));
  while (current > 0 && isPathWordDelimiter(s[current - 1])) current -= 1;
  // Everything strictly left of the caret; the last delimiter in it is where
  // the previous word starts.
  for (let i = current - 1; i > 0; i -= 1) {
    if (isPathWordDelimiter(s[i - 1])) return i;
  }
  return 0;
}

/**
 * WB_RIGHT — move to just past the next delimiter, then skip any consecutive
 * delimiters, so Ctrl+Right in "/var//log" lands on "log" and not between the
 * two slashes.
 */
function wordRight(text, position) {
  const s = String(text == null ? '' : text);
  let current = Math.max(0, Math.min(position, s.length));
  if (current >= s.length) return s.length;
  while (current < s.length && !isPathWordDelimiter(s[current])) current += 1;
  while (current < s.length && isPathWordDelimiter(s[current])) current += 1;
  return current;
}

/**
 * What double-clicking a path component selects: the component under the
 * caret, without its surrounding delimiters.
 */
function wordAt(text, position) {
  const s = String(text == null ? '' : text);
  const at = Math.max(0, Math.min(position, s.length));
  let start = at;
  while (start > 0 && !isPathWordDelimiter(s[start - 1])) start -= 1;
  let end = at;
  while (end < s.length && !isPathWordDelimiter(s[end])) end += 1;
  return { start, end, text: s.slice(start, end) };
}

// ---------------------------------------------------------------------------
// the path label
// ---------------------------------------------------------------------------

/** ConvertPath — swaps the two separators, in both directions at once. */
function convertPath(path, s1, s2) {
  let out = '';
  for (const ch of String(path == null ? '' : path)) {
    if (ch === s1) out += s2;
    else if (ch === s2) out += s1;
    else out += ch;
  }
  return out;
}

function convertPathToWin(path) { return convertPath(path, '/', '\\'); }
function convertPathToUnix(path) { return convertPath(path, '\\', '/'); }

/**
 * MinimizeStr — the path label's shortening: append an ellipsis and then remove
 * characters from just before it until the text fits. It never removes the last
 * character, so a truly narrow label still shows "x...".
 *
 * `measure(text)` is the caller's text measurement; without it the width is
 * counted in characters, which is what a monospaced console needs anyway.
 */
function minimizeStr(text, width, measure) {
  const m = typeof measure === 'function' ? measure : ((s) => s.length);
  let buf = String(text == null ? '' : text);
  if (m(buf) <= width) return buf;
  buf += '...';
  for (;;) {
    if (buf.length <= 4) break;
    // Delete(Buf, Length(Buf) - 3, 1): the character immediately before "...".
    buf = buf.slice(0, buf.length - 4) + buf.slice(buf.length - 3);
    if (m(buf) <= width) break;
  }
  return buf;
}

/**
 * HotTrackPath, as a pure function.
 *
 * The path label is a row of clickable breadcrumbs, and this is the rule that
 * turns a horizontal position into the prefix that would be navigated to: walk
 * the path one separator-terminated component at a time until the accumulated
 * prefix is at least as wide as the position.
 *
 * A UNC path's "\\server\share" is taken whole, because "\\server" alone is not
 * a place you can go.
 *
 * Returns the prefix INCLUDING its trailing separator, exactly as the label
 * computes it; `pathClickTarget` is what strips it.
 */
function hotTrackPath(displayPath, position, options) {
  const o = options || {};
  const unix = !!o.unixPath;
  const separator = unix ? '/' : '\\';
  const measure = typeof o.measure === 'function' ? o.measure : ((s) => s.length);
  const path0 = String(displayPath == null ? '' : displayPath);
  if (path0 === '' || position < 0) return '';
  if (position >= measure(path0)) return null;   // past the path: the mask area

  let result = '';
  let path = path0;
  for (;;) {
    if (path === '') break;

    if (!unix && result === '' && isUncPath(path)) {
      result = extractUncRoot(path);
      if (path.slice(result.length, result.length + 1) === separator) result += separator;
      path = path.slice(result.length);
    } else {
      const at = path.indexOf(separator);
      if (at >= 0) {
        result += path.slice(0, at + 1);
        path = path.slice(at + 1);
      } else {
        result += path;
        path = '';
      }
    }

    if (measure(result) >= position || path === '') break;
  }
  return result;
}

/**
 * TCustomPathLabel::Click — what a breadcrumb click actually navigates to. The
 * trailing separator is removed unless the prefix IS the separator, because
 * "/" with its slash removed is nothing at all.
 */
function pathClickTarget(hotPath, options) {
  const o = options || {};
  const separator = o.unixPath ? '/' : '\\';
  let path = String(hotPath == null ? '' : hotPath);
  if (path.endsWith(separator) && path !== separator) path = path.slice(0, -1);
  return path;
}

function isUncPath(path) {
  const p = String(path || '');
  return p.startsWith('\\\\') || p.startsWith('//');
}

function extractUncRoot(path) {
  const p = String(path);
  // \\server\share — the drive of a UNC path is the server AND the share.
  const m = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)/.exec(p);
  return m ? m[1] : p;
}

/**
 * The breadcrumbs a path label renders: every prefix a user could click, with
 * the label to show for each. The last one is the current directory itself.
 */
function pathSegments(path, options) {
  const o = options || {};
  const unix = !!o.unixPath;
  const separator = unix ? '/' : '\\';
  const p = String(path == null ? '' : path);
  if (p === '') return [];

  const out = [];
  let index = 0;

  if (!unix && isUncPath(p)) {
    const root = extractUncRoot(p);
    out.push({ label: root, path: root });
    index = root.length;
    if (p[index] === separator) index += 1;
  } else if (unix && p.startsWith('/')) {
    out.push({ label: '/', path: '/' });
    index = 1;
  } else if (!unix && /^[A-Za-z]:/.test(p)) {
    out.push({ label: p.slice(0, 2), path: `${p.slice(0, 2)}\\` });
    index = 2;
    if (p[index] === separator) index += 1;
  }

  let current = out.length ? out[out.length - 1].path : '';
  while (index < p.length) {
    let at = p.indexOf(separator, index);
    if (at < 0) at = p.length;
    const name = p.slice(index, at);
    if (name !== '') {
      current = joinPath(current, name, separator);
      out.push({ label: name, path: current });
    }
    index = at + 1;
  }
  return out;
}

function joinPath(base, name, separator) {
  if (base === '') return name;
  if (base.endsWith(separator)) return base + name;
  return base + separator + name;
}

// ---------------------------------------------------------------------------
// the path combo boxes
// ---------------------------------------------------------------------------

const UNIX_DEFAULT_ROOT_NAME = '/ <root>';

/**
 * TCustomScpExplorerForm::UpdateRemotePathComboBox — the remote path combo
 * lists the current directory's ANCESTORS, root first, current last.
 *
 * "/var/log/nginx" becomes [ "/ <root>", "var", "log", "nginx" ] and the
 * selected item is the last one, so the closed combo shows where you are and
 * opening it offers every way up.
 */
function remotePathComboItems(path) {
  const p = String(path == null ? '' : path);
  if (p === '') return [];
  const items = [];
  let current = unixExcludeTrailingSlash(p);
  while (!isUnixRootPath(current)) {
    const at = current.lastIndexOf('/');
    if (at < 0) break;
    items.unshift(current.slice(at + 1));
    current = current.slice(0, at);
  }
  items.unshift(UNIX_DEFAULT_ROOT_NAME);
  return items;
}

/**
 * DoRemotePathComboBoxItemClick — the directory a given entry navigates to.
 * The entry is `index` steps from the END of the list, so it climbs that many
 * levels from the current path.
 *
 * The empty-result guard is WinSCP's "VanDyke style paths" comment: some
 * servers report paths that climb to nothing, and root is the right answer.
 */
function remotePathComboTarget(path, index, count) {
  let result = unixExcludeTrailingSlash(String(path == null ? '' : path));
  let i = index;
  while (i < count - 1) {
    result = unixExtractFileDir(result);
    i += 1;
  }
  if (result === '') result = '/';
  return result;
}

function isUnixRootPath(path) {
  const p = String(path || '');
  return p === '' || p === '/';
}

function unixExcludeTrailingSlash(path) {
  const p = String(path || '');
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

function unixExtractFileDir(path) {
  const p = unixExcludeTrailingSlash(String(path || ''));
  const at = p.lastIndexOf('/');
  if (at < 0) return '';
  if (at === 0) return '/';
  return p.slice(0, at);
}

/**
 * LocalPathComboUpdate — which entry of the LOCAL path combo is current. The
 * local combo lists special folders and drive roots rather than ancestors, so
 * the current entry is the first one that is a PREFIX of the current path.
 *
 * The comparison is SamePaths — case-insensitive with the trailing separator
 * normalised — because "C:\" and "c:" name the same drive.
 */
function localPathComboIndex(paths, currentPath) {
  const list = Array.isArray(paths) ? paths : [];
  const current = String(currentPath || '');
  for (let index = 0; index < list.length; index += 1) {
    const candidate = String(list[index] || '');
    if (C.samePaths(candidate, current.substring(0, candidate.length))) return index;
  }
  // WinSCP's own comment here is "what to do if not?" — it leaves the combo
  // alone rather than selecting something wrong, and so does this.
  return -1;
}

/**
 * The local path combo's entries: the two special folders first (their count is
 * what tells a click whether it is a folder or a drive), then one root per
 * valid drive. Drive letters get an accelerator prefix in WinSCP; that is a
 * Win32 menu convention with no meaning here, so it is dropped and the entry
 * carries the letter instead.
 */
function localPathComboEntries(options) {
  const o = options || {};
  const entries = [];
  if (o.personalFolder) entries.push({ kind: 'folder', label: o.personalLabel || 'My documents', path: o.personalFolder });
  if (o.desktopFolder) entries.push({ kind: 'folder', label: o.desktopLabel || 'Desktop', path: o.desktopFolder });
  const specialCount = entries.length;
  for (const drive of (o.drives || [])) {
    if (drive.valid === false) continue;
    entries.push({
      kind: 'drive',
      label: drive.prettyName || drive.name || drive.key,
      path: drive.root,
      drive: drive.key,
    });
  }
  return { entries, specialCount };
}

// ---------------------------------------------------------------------------

module.exports = {
  // history
  DEFAULT_MAX_HISTORY_SIZE, DEFAULT_HISTORY_DROP_DOWN_COUNT,
  DEFAULT_HISTORY_AUTO_COMPLETE, HISTORY_SAVE_ON, DEFAULT_HISTORY_SAVE_ON,
  saveToHistory, HistoryCombo,

  // completion
  completeInline, pathCompletions,

  // word breaks
  PATH_WORD_DELIMITERS, isPathWordDelimiter, wordLeft, wordRight, wordAt,

  // path label
  convertPath, convertPathToWin, convertPathToUnix, minimizeStr,
  hotTrackPath, pathClickTarget, pathSegments,

  // path combos
  UNIX_DEFAULT_ROOT_NAME, remotePathComboItems, remotePathComboTarget,
  localPathComboIndex, localPathComboEntries,
};
