// dirview.js — the directory view's non-visual model.
//
// WinSCP's file panels are VCL list views (source/components/DirView.cpp,
// UnixDirView.cpp, UnixDriveView.cpp, IEDriveInfo.cpp) sitting on the packages
// in source/packages/filemng and source/packages/my. The *controls* are Win32;
// the model inside them is not, and it is what a panel actually is:
//
//   * the column sets, their default widths and which start hidden
//   * the sort comparators for every column, natural numeric order, and
//     "always sort directories by name"
//   * the Norton-style selection model, including the Explorer-style variant,
//     and the focused-versus-selected distinction every command depends on
//   * incremental search across the three search modes
//   * the mask filter and the hidden/filtered counts the status bar shows
//   * the back/forward path history
//   * the directory tree the drive views render
//   * the mask-edit validation and the file-list-to-text formatting that
//     "Copy file list to clipboard" produces
//
// Everything here is pure: no DOM, no Electron, no I/O. It operates on the
// plain entry objects protocols/base.js `entry()` produces, so the renderer's
// ui/panels.js and ui/panelcolumns.js can use it as their model rather than
// each reimplementing sorting.
//
// Where a behaviour is VCL-specific with no meaning here (pixel scroll offsets,
// icon caching queues, drag-drop effect negotiation) the *intent* is ported and
// the comment says so.

'use strict';

const C = require('./common');
const masks = require('./masks');

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

/**
 * TDirViewCol — the local panel's columns, in WinSCP's own order.
 * DirViewColProperties.pas.
 */
const DIR_VIEW_COL = {
  Name: 'name', Size: 'size', Type: 'type', Changed: 'changed',
  Attr: 'attr', Ext: 'ext',
};

/**
 * TUnixDirViewCol — the remote panel's columns.
 * UnixDirViewColProperties.pas.
 */
const UNIX_DIR_VIEW_COL = {
  Name: 'name', Size: 'size', Changed: 'changed', Rights: 'rights',
  Owner: 'owner', Group: 'group', Ext: 'ext', LinkTarget: 'linkTarget',
  Type: 'type',
};

/** DefaultDirViewCaptions/Widths/Alignments/Visible, transcribed. */
const LOCAL_COLUMNS = Object.freeze([
  Object.freeze({ key: 'name', caption: 'Name', width: 150, align: 'left', visible: true }),
  Object.freeze({ key: 'size', caption: 'Size', width: 80, align: 'right', visible: true }),
  Object.freeze({ key: 'type', caption: 'Type', width: 125, align: 'left', visible: true }),
  Object.freeze({ key: 'changed', caption: 'Date modified', width: 130, align: 'left', visible: true }),
  Object.freeze({ key: 'attr', caption: 'Attr', width: 45, align: 'left', visible: true }),
  // Ext keeps its width 20 but starts hidden: DefaultDirViewVisible's last
  // element is False, so a fresh local panel has no Ext column.
  Object.freeze({ key: 'ext', caption: 'Ext', width: 20, align: 'left', visible: false }),
]);

/** DefaultUnixDirViewCaptions/Widths/Alignments/Visible, transcribed. */
const REMOTE_COLUMNS = Object.freeze([
  Object.freeze({ key: 'name', caption: 'Name', width: 150, align: 'left', visible: true }),
  Object.freeze({ key: 'size', caption: 'Size', width: 80, align: 'right', visible: true }),
  Object.freeze({ key: 'changed', caption: 'Date modified', width: 130, align: 'left', visible: true }),
  Object.freeze({ key: 'rights', caption: 'Rights', width: 100, align: 'left', visible: true }),
  Object.freeze({ key: 'owner', caption: 'Owner', width: 130, align: 'left', visible: true }),
  Object.freeze({ key: 'group', caption: 'Group', width: 130, align: 'left', visible: true }),
  Object.freeze({ key: 'ext', caption: 'Ext', width: 0, align: 'left', visible: false }),
  Object.freeze({ key: 'linkTarget', caption: 'Link target', width: 150, align: 'left', visible: false }),
  // TypeVisible defaults to True in the published property, but
  // DefaultUnixDirViewVisible says False and that array is what the constructor
  // applies — so a fresh remote panel has no Type column.
  Object.freeze({ key: 'type', caption: 'Type', width: 125, align: 'left', visible: false }),
]);

function isLocalSide(side) {
  return side === 'local';
}

/** A fresh, mutable copy of one side's column set. */
function columnsFor(side) {
  return (isLocalSide(side) ? LOCAL_COLUMNS : REMOTE_COLUMNS).map((c) => ({ ...c }));
}

function columnIndex(side, key) {
  return (isLocalSide(side) ? LOCAL_COLUMNS : REMOTE_COLUMNS).findIndex((c) => c.key === key);
}

/**
 * TCustomUnixDirView/TDirViewInt::SortAscendingByDefault — clicking Size or
 * Date modified for the first time sorts DESCENDING, because the biggest and
 * the newest are what a user is looking for. Every other column starts
 * ascending.
 */
function sortAscendingByDefault(side, key) {
  if (isLocalSide(side)) return !(key === DIR_VIEW_COL.Size || key === DIR_VIEW_COL.Changed);
  return !(key === UNIX_DIR_VIEW_COL.Size || key === UNIX_DIR_VIEW_COL.Changed);
}

// ---------------------------------------------------------------------------
// item accessors
// ---------------------------------------------------------------------------
//
// TCustomDirView declares ItemFileName/ItemFileSize/ItemIsDirectory/... as
// abstract and each concrete view implements them over its own record type.
// Here there is one record type — the `entry()` shape — so these are functions
// rather than virtual methods, and they tolerate a TRemoteFile-shaped object
// too so a caller holding one does not have to convert first.

const PARENT_DIRECTORY = '..';

function itemFileName(item) {
  if (item == null) return '';
  return String(item.name !== undefined ? item.name : (item.fileName || ''));
}

function itemIsParentDirectory(item) {
  if (item == null) return false;
  if (item.isParentDirectory !== undefined) return !!item.isParentDirectory;
  return itemFileName(item) === PARENT_DIRECTORY;
}

function itemIsDirectory(item) {
  if (item == null) return false;
  if (item.isDirectory !== undefined) return !!item.isDirectory;
  return item.type === 'dir' || itemIsParentDirectory(item);
}

/**
 * TUnixDirView::ItemIsFile — note the name lies: it is "is not the parent
 * directory". A directory IS a file by this test, which is why the commands
 * that use it (delete, properties) work on directories too.
 */
function itemIsFile(item) {
  return !itemIsParentDirectory(item);
}

/**
 * Resolve the action behind TUnixDirView::ExecuteFile.
 *
 * The UI owns actually changing directories or opening properties; the model
 * owns the decision so double-click and keyboard Enter cannot drift apart.
 * Directories (including the synthetic parent row) always enter when the
 * configured action is `changeDir`. The open action returns the item that the
 * caller should focus before opening its properties/editor affordance.
 */
function resolveExecuteFile(item, options) {
  if (!item) return { action: 'noop', item: null };
  const o = options || {};
  const action = o.action === 'changeDir' ? 'changeDir' : 'open';
  if (action === 'changeDir' && itemIsDirectory(item)) {
    return { action, item };
  }
  if (action === 'open') return { action, item };
  return { action: 'open', item };
}

/**
 * GetItemFileSize — a directory has no size until one is calculated, and a
 * calculated size wins over the reported one. The remote view returns -1 for an
 * uncalculated directory; the local view returns 0. Both are reproduced: the
 * caller says which side it is asking about.
 */
function itemFileSize(item, side) {
  if (item == null) return 0;
  const calculated = item.calculatedSize;
  if (isLocalSide(side)) {
    // TDirViewInt::GetItemFileSize: Size first, then CalculatedSize, else 0.
    if (typeof item.size === 'number' && item.size >= 0 && !itemIsDirectory(item)) return item.size;
    if (typeof calculated === 'number' && calculated >= 0) return calculated;
    return typeof item.size === 'number' && item.size >= 0 ? item.size : 0;
  }
  if (typeof calculated === 'number' && calculated >= 0) return calculated;
  return typeof item.size === 'number' ? item.size : 0;
}

function itemFileTime(item) {
  if (item == null) return 0;
  if (typeof item.mtime === 'number') return item.mtime;
  if (item.modification instanceof Date) return item.modification.getTime();
  if (typeof item.modification === 'number') return item.modification;
  return 0;
}

/**
 * The extension the Ext column shows and sorts on. WinSCP uses
 * ExtractFileExt, which returns everything from the LAST dot including the dot,
 * and returns nothing for a name whose only dot is the first character — so
 * ".bashrc" has no extension.
 */
function itemExtension(item) {
  if (itemIsDirectory(item)) return '';
  if (item && item.extension !== undefined) return String(item.extension);
  return C.extractFileExt(itemFileName(item));
}

/**
 * IsUnixHiddenFile — a dot-file is hidden, but "." and ".." are NOT, because
 * IsUnixHiddenFile checks IsRealFile first. This matters: protocols/base.js
 * derives `hidden` from a leading dot alone, which marks the parent directory
 * hidden, and a panel with "show hidden files" off would then have no way up.
 */
function itemIsHidden(item) {
  if (item == null) return false;
  const name = itemFileName(item);
  if (!C.isRealFile(name)) return false;
  return !!item.hidden;
}

/** The Attr column: DOS attribute letters, in WinSCP's order. */
function itemAttr(item) {
  if (item == null) return '';
  let out = '';
  if (itemIsDirectory(item)) out += 'd';
  if (item.readOnly) out += 'r';
  if (itemIsHidden(item)) out += 'h';
  if (item.isSymlink) out += 'l';
  const raw = item.raw || {};
  if (raw.system) out += 's';
  if (raw.archive) out += 'a';
  return out;
}

const TYPE_NAME_PARENT = 'Parent directory';
const TYPE_NAME_DIRECTORY = 'File Folder';

/**
 * The Type column. WinSCP asks the shell for the local side and the server's
 * own type name for the remote side; neither exists here, so the extension
 * drives it and the shape ("<EXT> File", STextFileExt in CustomDirView.pas) is
 * WinSCP's own.
 */
function itemTypeName(item) {
  if (item == null) return '';
  if (item.typeName) return String(item.typeName);
  if (itemIsParentDirectory(item)) return TYPE_NAME_PARENT;
  if (itemIsDirectory(item)) return TYPE_NAME_DIRECTORY;
  const ext = itemExtension(item).replace(/^\./, '');
  return ext ? `${ext.toUpperCase()} File` : 'File';
}

function itemOwner(item) {
  if (item == null) return '';
  const owner = item.owner;
  if (owner && typeof owner === 'object') return String(owner.displayText || '');
  return String(owner || '');
}

function itemGroup(item) {
  if (item == null) return '';
  const group = item.group;
  if (group && typeof group === 'object') return String(group.displayText || '');
  return String(group || '');
}

function itemRights(item) {
  if (item == null) return '';
  const rights = item.rights;
  if (rights && typeof rights === 'object') return String(rights.text || rights.octal || '');
  return String(rights || '');
}

function itemLinkTarget(item) {
  if (item == null) return '';
  return String(item.linkTarget || item.linkTo || '');
}

/** oi* — the overlay badges ItemOverlayIndexes composes for one row. */
const OVERLAY = Object.freeze({
  None: 0x00, DirUp: 0x01, Link: 0x02, BrokenLink: 0x04, Partial: 0x08, Encrypted: 0x10,
});

function itemOverlayIndexes(item) {
  let result = OVERLAY.None;
  if (item == null) return result;
  if (itemIsParentDirectory(item)) result |= OVERLAY.DirUp;
  if (item.isSymlink) result |= item.brokenLink ? OVERLAY.BrokenLink : OVERLAY.Link;
  if (item.isEncrypted) result |= OVERLAY.Encrypted;
  if (item.partial) result |= OVERLAY.Partial;
  return result;
}

/**
 * GetColumnText / GetDisplayInfo — the exact string one cell shows. Incremental
 * search in "all columns" mode searches these, so it has to be the displayed
 * text and not the underlying value.
 *
 * `format` supplies the two presentations this module refuses to guess:
 * `size(bytes)` and `time(ms)`. Without them the numbers are rendered plainly,
 * which keeps the function total.
 */
function columnText(item, key, side, format) {
  if (item == null) return '';
  const f = format || {};
  const formatSize = typeof f.size === 'function' ? f.size : ((n) => String(n));
  const formatTime = typeof f.time === 'function' ? f.time : ((n) => (n ? new Date(n).toISOString() : ''));

  switch (key) {
    case 'name':
      return itemFileName(item);
    case 'size': {
      // A directory's size cell is EMPTY until a size is calculated — the
      // remote view checks CalculatedSize >= 0 before it formats anything.
      if (itemIsDirectory(item)) {
        const calculated = item.calculatedSize;
        if (typeof calculated !== 'number' || calculated < 0) return '';
        return formatSize(calculated);
      }
      const size = typeof item.size === 'number' ? item.size : 0;
      return size >= 0 ? formatSize(size) : '';
    }
    case 'changed':
      return formatTime(itemFileTime(item));
    case 'rights':
      return itemRights(item);
    case 'owner':
      return itemOwner(item);
    case 'group':
      return itemGroup(item);
    case 'ext':
      return itemExtension(item).replace(/^\./, '');
    case 'linkTarget':
      return itemLinkTarget(item);
    case 'type':
      return itemTypeName(item);
    case 'attr':
      return itemAttr(item);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

/**
 * CompareFile (UnixDirView.cpp) and CompareFile (DirViewInt.pas).
 *
 * Both do the same three things before they look at the sort column:
 *   1. the parent directory is always first,
 *   2. directories are always before files,
 *   3. and NEITHER of those decisions is reversed by a descending sort —
 *      the negation lives inside the branch where both items are the same
 *      kind. A descending sort that buried ".." at the bottom would leave the
 *      user no way up.
 *
 * When AlwaysSortDirectoriesByName is on, directories skip the column
 * comparison entirely and fall through to the name.
 */
function compareItems(item1, item2, options) {
  const o = options || {};
  const side = o.side === 'local' ? 'local' : 'remote';
  const natural = !!o.naturalOrderNumericalSorting;
  const ascending = o.sortAscending !== false;
  const key = o.sortColumn || 'name';

  if (item1 === item2) return 0;
  if (item1 == null) return -1;
  if (item2 == null) return 1;

  const parent1 = itemIsParentDirectory(item1);
  const parent2 = itemIsParentDirectory(item2);
  if (parent1 && !parent2) return -1;
  if (!parent1 && parent2) return 1;

  const dir1 = itemIsDirectory(item1);
  const dir2 = itemIsDirectory(item2);
  if (dir1 && !dir2) return -1;
  if (!dir1 && dir2) return 1;

  let result = 0;

  if (!(dir1 && o.alwaysSortDirectoriesByName)) {
    switch (key) {
      case 'name':
        break;                                   // falls through to the name
      case 'size':
        result = C.compareNumber(itemFileSize(item1, side), itemFileSize(item2, side));
        break;
      case 'changed':
        result = C.compareNumber(itemFileTime(item1), itemFileTime(item2));
        break;
      case 'rights':
        // AnsiCompareText: case-insensitive, not natural.
        result = C.compareText(itemRights(item1), itemRights(item2));
        break;
      case 'owner':
        result = compareToken(item1.owner, item2.owner);
        break;
      case 'group':
        result = compareToken(item1.group, item2.group);
        break;
      case 'attr':
        result = C.compareText(itemAttr(item1), itemAttr(item2));
        break;
      case 'ext':
        // A directory has no extension, so directories fall through to the
        // name instead of all comparing equal.
        if (!dir1) {
          result = isLocalSide(side)
            // The local view sorts on "<ext> <name>", so files with the same
            // extension are already in name order before the fallback runs.
            ? C.compareLogicalText(
              `${itemExtension(item1)} ${itemFileName(item1)}`,
              `${itemExtension(item2)} ${itemFileName(item2)}`, natural)
            : C.compareLogicalText(itemExtension(item1), itemExtension(item2), natural);
        }
        break;
      case 'linkTarget':
        result = C.compareLogicalText(itemLinkTarget(item1), itemLinkTarget(item2), natural);
        break;
      case 'type':
        result = C.compareLogicalText(itemTypeName(item1), itemTypeName(item2), natural);
        // Same type name: the extension breaks the tie, but only for files.
        if (result === 0 && !dir1) {
          result = C.compareLogicalText(itemExtension(item1), itemExtension(item2), natural);
        }
        break;
      default:
        break;
    }
  }

  if (result === 0) {
    result = C.compareLogicalText(itemFileName(item1), itemFileName(item2), natural);
  }

  return ascending ? result : -result;
}

/**
 * TRemoteToken::Compare — a named token sorts before an unnamed one, and an
 * unnamed token with an id sorts before one with neither, so a listing that
 * reports numeric ids mixed with names still has a total order. Plain strings
 * (what the adapters produce) take the name path.
 */
function compareToken(token1, token2) {
  const t1 = token1 && typeof token1 === 'object' ? token1 : { name: String(token1 || '') };
  const t2 = token2 && typeof token2 === 'object' ? token2 : { name: String(token2 || '') };
  const name1 = String(t1.name || '');
  const name2 = String(t2.name || '');
  if (name1 !== '') {
    if (name2 !== '') return C.compareText(name1, name2);
    return -1;
  }
  if (name2 !== '') return 1;
  if (t1.idValid) {
    if (t2.idValid) return C.compareNumber(t1.id, t2.id);
    return -1;
  }
  if (t2.idValid) return 1;
  return 0;
}

/** A comparator bound to one sort state, for Array.prototype.sort. */
function makeComparator(options) {
  const o = options || {};
  return (a, b) => compareItems(a, b, o);
}

/** Sorts a copy, so a caller can keep the unsorted listing. */
function sortItems(items, options) {
  return items.slice().sort(makeComparator(options));
}

/**
 * TCustomIEListView's sort state, plus its SortStr persistence format
 * ("%d;%d" — the column INDEX and the direction as 0/1).
 */
class SortState {
  constructor(side, column, ascending) {
    this.side = side === 'local' ? 'local' : 'remote';
    this.column = column || 'name';
    this.ascending = ascending === undefined ? true : !!ascending;
  }

  /**
   * SortBy: clicking the column that is already sorted flips the direction;
   * clicking a different column starts it at that column's default direction.
   * Returns true when anything changed, because SetSort re-sorts only then.
   */
  sortBy(column) {
    if (columnIndex(this.side, column) < 0) return false;
    if (column === this.column) return this.setSort(column, !this.ascending);
    return this.setSort(column, sortAscendingByDefault(this.side, column));
  }

  setSort(column, ascending) {
    if (columnIndex(this.side, column) < 0) return false;
    const asc = !!ascending;
    if (this.column === column && this.ascending === asc) return false;
    this.column = column;
    this.ascending = asc;
    return true;
  }

  /** TIEListViewColProperties::GetSortStr. */
  get sortStr() {
    return `${columnIndex(this.side, this.column)};${this.ascending ? 1 : 0}`;
  }

  /**
   * SetSortStr. A column index past the end of the column set is IGNORED
   * rather than clamped — a layout saved by a build with more columns must not
   * silently start sorting by the wrong one.
   */
  set sortStr(value) {
    const parts = String(value == null ? '' : value).split(';');
    const set = isLocalSide(this.side) ? LOCAL_COLUMNS : REMOTE_COLUMNS;
    const index = Number.parseInt(parts[0], 10);
    if (Number.isFinite(index) && index >= 0 && index < set.length) {
      this.column = set[index].key;
    }
    if (parts.length > 1) {
      const asc = Number.parseInt(parts[1], 10);
      if (Number.isFinite(asc)) this.ascending = asc !== 0;
    }
  }

  comparatorOptions(extra) {
    return {
      side: this.side,
      sortColumn: this.column,
      sortAscending: this.ascending,
      ...(extra || {}),
    };
  }
}

// ---------------------------------------------------------------------------
// loading a listing into the view
// ---------------------------------------------------------------------------

/**
 * TUnixDirView::LoadFiles — which of the server's files reach the panel, and
 * the three counters the status bar reports.
 *
 * The order of the tests matters and is WinSCP's:
 *   1. hidden files (and inaccessible directories) are counted as HIDDEN and
 *      never looked at again;
 *   2. only then does the mask run, and only against real files — "." and ".."
 *      are never filtered out, so a mask can never strip the way back up;
 *   3. whatever survives is visible, and its size joins FilesSize.
 *
 * `matchMask(name, isDirectory, size, modification, mask, allowImplicitMatches)`
 * is the OnMatchMask hook. Omitted, design/main/masks.js is used, which is what
 * WinSCP wires it to.
 */
function buildView(options) {
  const o = options || {};
  const files = Array.isArray(o.files) ? o.files : [];
  const showHiddenFiles = o.showHiddenFiles !== false;
  const showInaccesibleDirectories = o.showInaccesibleDirectories !== false;
  const mask = String(o.mask || '');
  const match = typeof o.matchMask === 'function' ? o.matchMask : defaultMatchMask;

  const items = [];
  let hiddenCount = 0;
  let filteredCount = 0;
  let filesSize = 0;
  let hasParentDir = false;

  for (const file of files) {
    const name = itemFileName(file);
    const isDir = itemIsDirectory(file);
    const isHidden = itemIsHidden(file);
    const inaccessible = !!file.isInaccesibleDirectory;

    if ((!showHiddenFiles && isHidden) || (!showInaccesibleDirectories && inaccessible)) {
      hiddenCount += 1;
    } else if (mask !== '' && C.isRealFile(name)
      && !match(name, isDir, typeof file.size === 'number' ? file.size : 0, itemFileTime(file), mask, true)) {
      filteredCount += 1;
    } else {
      items.push(file);
      filesSize += typeof file.size === 'number' ? file.size : 0;
      if (itemIsParentDirectory(file)) hasParentDir = true;
    }
  }

  if (o.sort) items.sort(makeComparator(o.sort));

  return { items, hiddenCount, filteredCount, filesSize, hasParentDir };
}

// TCustomScpExplorerForm keeps ONE parsed mask and re-parses only when the
// string changes, because the panel matches this against every file in a
// directory. The same cache here, for the same reason.
let matchMaskCacheKey = null;
let matchMaskCacheValue = null;

/**
 * TCustomScpExplorerForm::DirViewMatchMask — the OnMatchMask handler the panel
 * is wired to.
 *
 * The second half is the subtle part: an IMPLICIT match — one that only got
 * through because the mask has no include list at all — is rejected unless the
 * caller allows it. Loading the panel allows it (a mask of "|*.bak" is an
 * exclude-only filter and everything else must stay visible); selecting by
 * mask does not (an exclude-only mask must not select every file).
 */
function defaultMatchMask(name, isDirectory, size, modification, mask, allowImplicitMatches) {
  const maskStr = String(mask == null ? '' : mask);
  if (matchMaskCacheKey !== maskStr) {
    try {
      matchMaskCacheValue = masks.parse(maskStr);
    } catch {
      // An unparseable mask filters nothing, exactly as an empty one does. The
      // mask editor is where a bad mask is reported; the panel must not go
      // blank because a half-typed mask does not parse yet.
      matchMaskCacheValue = null;
    }
    matchMaskCacheKey = maskStr;
  }
  if (!matchMaskCacheValue) return true;

  // The panel has no path, only a name, so no path mask can apply here — the
  // C++ comment says the same about its Local/RecurseInclude arguments.
  const result = masks.matchesEx(name, {
    isDir: !!isDirectory,
    size,
    mtime: modification || 0,
  }, matchMaskCacheValue);
  return result.matched && (!!allowImplicitMatches || !result.implicit);
}

/**
 * TStatusFileInfo — the six numbers the panel's status bar renders. Kept as one
 * record because DoUpdateStatusBar compares the whole record and only fires
 * when something actually changed.
 */
function statusFileInfo(view, selection) {
  const v = view || {};
  const s = selection || {};
  return {
    filesCount: Array.isArray(v.items) ? v.items.length : 0,
    selectedCount: typeof s.selectedCount === 'number' ? s.selectedCount : 0,
    filesSize: v.filesSize || 0,
    selectedSize: typeof s.selectedSize === 'number' ? s.selectedSize : 0,
    hiddenCount: v.hiddenCount || 0,
    filteredCount: v.filteredCount || 0,
  };
}

function sameStatusFileInfo(a, b) {
  if (!a || !b) return false;
  return a.filesCount === b.filesCount && a.selectedCount === b.selectedCount
    && a.filesSize === b.filesSize && a.selectedSize === b.selectedSize
    && a.hiddenCount === b.hiddenCount && a.filteredCount === b.filteredCount;
}

// ---------------------------------------------------------------------------
// select by mask
// ---------------------------------------------------------------------------

/** DefaultFileFilter — no masks, directories excluded. */
function defaultFileFilter() {
  return { masks: '', directories: false };
}

/**
 * TUnixDirView::ItemMatchesFilter.
 *
 * An empty mask matches everything. Otherwise the file is tested normally, and
 * a directory gets a SECOND chance when the filter's Directories flag is on —
 * tested as though it were a file, so "*.txt" with "include directories" also
 * picks up a directory called "notes.txt". WinSCP passes
 * AllowImplicitMatches=false here: selecting by mask never implicitly matches.
 */
function itemMatchesFilter(item, filter, matchMask) {
  const f = filter || defaultFileFilter();
  const maskStr = String(f.masks || '');
  if (maskStr === '') return true;

  const match = typeof matchMask === 'function' ? matchMask : defaultMatchMask;
  const name = itemFileName(item);
  const isDir = itemIsDirectory(item);
  const size = typeof item.size === 'number' ? item.size : 0;
  const modification = itemFileTime(item);

  if (match(name, isDir, size, modification, maskStr, false)) return true;
  if (isDir && f.directories && match(name, false, size, modification, maskStr, false)) return true;
  return false;
}

/**
 * TCustomScpExplorerForm::SelectSameExt — the filter behind "Select files with
 * the same extension". A file with no extension gets the mask "*." , which is
 * WinSCP's mask for "no extension", not "everything".
 */
function sameExtensionFilter(fileName, unixPath) {
  const ext = unixPath ? unixExtractFileExt(fileName) : C.extractFileExt(fileName);
  return { masks: `*${ext === '' ? '.' : ext}`, directories: false };
}

function unixExtractFileExt(fileName) {
  const name = String(fileName);
  const slash = name.lastIndexOf('/');
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

// ---------------------------------------------------------------------------
// the selection model
// ---------------------------------------------------------------------------

/** TNortonLikeMode. */
const NORTON_LIKE = Object.freeze({ On: 'on', Off: 'off', Keyboard: 'keyboard' });

/** TSelectMode. */
const SELECT_MODE = Object.freeze({ All: 'all', None: 'none', Invert: 'invert' });

/** TSelectMethod — how the last selection change was made. */
const SELECT_METHOD = Object.freeze({ NoneYet: 'noneYet', Mouse: 'mouse', Keyboard: 'keyboard' });

/**
 * TCustomNortonLikeListView plus the parts of TCustomDirView that constrain it.
 *
 * The model WinSCP maintains and that every command reads:
 *
 *   * `focusedIndex` is where the cursor is; `selected` is what is checked.
 *     They are INDEPENDENT — a focused row is not thereby selected, which is
 *     the whole point of a Norton-style panel and the reason WinSCP has both
 *     "…Focused" and plain variants of most commands.
 *   * `markedCount`/`markedFile` collapse the two: with a selection, the
 *     selection is what is marked; with none, the focused row is — unless
 *     NortonLike is off, where an empty selection really means nothing.
 *   * the parent directory can never be selected (CanChangeSelection), so
 *     "select all" never puts ".." into a delete.
 *
 * `nlOn` (the default) is Norton behaviour: moving the cursor never changes
 * the selection. `nlOff` is Explorer behaviour: moving the cursor moves a
 * single selection with it. `nlKeyboard` is Explorer for the mouse and Norton
 * for the keyboard, which is why it needs `anyAndAllSelectedImplicitly` — an
 * implicit selection made by clicking may be discarded, an explicit one may
 * not.
 */
class SelectionModel {
  constructor(options) {
    const o = options || {};
    this.items = Array.isArray(o.items) ? o.items : [];
    this.nortonLike = o.nortonLike || NORTON_LIKE.On;
    this.multiSelect = o.multiSelect !== false;
    this.side = o.side === 'local' ? 'local' : 'remote';
    this.caseSensitive = o.caseSensitive !== undefined ? !!o.caseSensitive : this.side !== 'local';

    this._selected = new Set();          // indices
    this.focusedIndex = -1;
    this.lastSelectMethod = SELECT_METHOD.NoneYet;
    this.selectingImplicitly = false;
    this.anyAndAllSelectedImplicitly = false;

    this._savedSelection = false;
    this._savedSelectionFile = '';
    this._savedSelectionLastFile = '';
    this._savedNames = [];
  }

  /** Replaces the listing. The selection does not survive, exactly as ClearItems. */
  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this._selected.clear();
    this.focusedIndex = this.items.length ? Math.min(Math.max(this.focusedIndex, -1), this.items.length - 1) : -1;
    this.anyAndAllSelectedImplicitly = false;
    return this;
  }

  get count() { return this.items.length; }

  get selCount() { return this._selected.size; }

  get focusedItem() {
    return this.focusedIndex >= 0 && this.focusedIndex < this.items.length
      ? this.items[this.focusedIndex] : null;
  }

  isSelected(index) { return this._selected.has(index); }

  selectedIndices() {
    return [...this._selected].sort((a, b) => a - b);
  }

  selectedItems() {
    return this.selectedIndices().map((i) => this.items[i]);
  }

  /**
   * CanChangeSelection — the parent directory is never selectable, and nothing
   * is selectable while the view is loading (a selection made against a listing
   * that is being replaced would apply to the wrong files).
   */
  canChangeSelection(index, loading) {
    if (loading) return false;
    const item = this.items[index];
    if (!item) return false;
    return !itemIsParentDirectory(item);
  }

  setSelected(index, select, options) {
    const o = options || {};
    if (index < 0 || index >= this.items.length) return false;
    if (select && !this.canChangeSelection(index, o.loading)) return false;
    if (!this.multiSelect && select) this._selected.clear();

    const had = this._selected.has(index);
    if (select === had) return false;

    if (select) {
      this._selected.add(index);
      if (this.selectingImplicitly && this._selected.size === 1) {
        this.anyAndAllSelectedImplicitly = true;
      } else if (!this.selectingImplicitly) {
        this.anyAndAllSelectedImplicitly = false;
      }
    } else {
      this._selected.delete(index);
      if (this._selected.size === 0 || !this.selectingImplicitly) {
        this.anyAndAllSelectedImplicitly = false;
      }
    }
    return true;
  }

  /**
   * SelectAll(Mode, Exclude). `exclude` is the index WMLButtonUp keeps when a
   * plain click collapses the selection to the row under the cursor.
   */
  selectAll(mode, exclude) {
    let changed = false;
    for (let index = 0; index < this.items.length; index += 1) {
      if (index === exclude) continue;
      let next;
      if (mode === SELECT_MODE.All) next = true;
      else if (mode === SELECT_MODE.None) next = false;
      else if (mode === SELECT_MODE.Invert) next = !this._selected.has(index);
      else next = false;
      if (this.setSelected(index, next)) changed = true;
    }
    return changed;
  }

  /**
   * SelectCurrentItem(FocusNext) — what Insert and Space do: toggle the focused
   * row, then optionally step down. With nothing focused WinSCP falls back to
   * the first item.
   */
  selectCurrentItem(focusNext) {
    if (!this.items.length) return false;
    const index = this.focusedIndex >= 0 ? this.focusedIndex : 0;
    const previousMethod = this.lastSelectMethod;
    this.lastSelectMethod = SELECT_METHOD.Keyboard;
    const changed = this.setSelected(index, !this._selected.has(index));
    this.lastSelectMethod = previousMethod;
    if (focusNext && index + 1 < this.items.length) this.focusedIndex = index + 1;
    return changed;
  }

  /** SelectFiles(Filter, Select) — select or unselect by mask. */
  selectFiles(filter, select, matchMask) {
    let changed = false;
    for (let index = 0; index < this.items.length; index += 1) {
      if (this._selected.has(index) === !!select) continue;
      if (itemMatchesFilter(this.items[index], filter, matchMask)) {
        if (this.setSelected(index, !!select)) changed = true;
      }
    }
    return changed;
  }

  /**
   * ClosestUnselected — the row the cursor should land on once the selection is
   * deleted: the first UNSELECTED row below, or failing that above. Returns
   * null when everything is selected, which is honest: there is nowhere to go.
   *
   * A focused-but-unselected row is only redirected when NortonLike is on and
   * nothing at all is selected, because in that state the focused row is what
   * the operation is about to consume.
   */
  closestUnselected(index) {
    const i = index === undefined ? this.focusedIndex : index;
    if (i < 0 || i >= this.items.length) return null;
    const consumed = this._selected.has(i)
      || (this.nortonLike !== NORTON_LIKE.Off && this._selected.size === 0);
    if (!consumed) return i;

    let j = i + 1;
    while (j < this.items.length && this._selected.has(j)) j += 1;
    if (j >= this.items.length || this._selected.has(j)) {
      j = i - 1;
      while (j >= 0 && this._selected.has(j)) j -= 1;
    }
    if (j >= 0 && j < this.items.length && !this._selected.has(j)) return j;
    return null;
  }

  /**
   * GetMarkedCount — with a selection it is the selection; with none the
   * focused row counts as one, but only while Norton-like behaviour is on.
   */
  get markedCount() {
    if (this._selected.size > 0 || this.nortonLike === NORTON_LIKE.Off) return this._selected.size;
    return this.focusedItem ? 1 : 0;
  }

  /** GetMarkedFile — the single file a command with no selection acts on. */
  get markedFile() {
    if (this._selected.size > 0) return this.items[this.selectedIndices()[0]];
    if (this.focusedItem && this.nortonLike !== NORTON_LIKE.Off) return this.focusedItem;
    return null;
  }

  /**
   * OperateOnFocusedFile — the rule that decides whether a command acts on the
   * focused row or on the selection. `focused` is the caller asking for the
   * focused-file variant; `onlyFocused` forces it.
   */
  operateOnFocusedFile(focused, onlyFocused) {
    return !!this.focusedItem
      && ((focused && !this._selected.has(this.focusedIndex)) || this._selected.size === 0 || !!onlyFocused);
  }

  /**
   * AnyFileSelected — whether a command should be enabled at all.
   *
   * `filesOnly` is the "Edit" case: with a selection it counts SELECTED FILES
   * (WinSCP's own comment notes this should really be "only files selected");
   * with none it refuses a directory outright.
   *
   * `focusedFileOnlyWhenFocused` exists because a toolbar button must not act
   * on a focused row in a panel that does not have the keyboard — the caller
   * supplies `panelFocused`.
   */
  anyFileSelected(options) {
    const o = options || {};
    if (o.onlyFocused
      || (this._selected.size === 0
        && (!o.focusedFileOnlyWhenFocused || o.panelFocused))) {
      const item = this.focusedItem;
      return !!item && itemIsFile(item) && (!o.filesOnly || !itemIsDirectory(item));
    }
    if (o.filesOnly) return this.selectedItems().some((item) => !itemIsDirectory(item));
    // The parent directory cannot be selected, so any selection counts.
    return this._selected.size > 0;
  }

  /**
   * CustomCreateFileList — the list of names a command receives. This is the
   * single place the focused/selected decision turns into concrete files, so
   * every command agrees about what it is operating on.
   *
   * `fullPath(item)` produces ItemFullFileName; without it the bare names are
   * returned, which is what CreateFileList(FullPath=false) gives.
   */
  createFileList(options) {
    const o = options || {};
    const path = typeof o.fullPath === 'function' ? o.fullPath : null;
    const name = (item) => (path ? path(item) : itemFileName(item));
    if (this.operateOnFocusedFile(o.focused, o.onlyFocused)) {
      const item = this.focusedItem;
      return item ? [name(item)] : [];
    }
    return this.selectedItems().map(name);
  }

  /** CreateFocusedFileList — always the focused row, whatever is selected. */
  createFocusedFileList(fullPath) {
    return this.createFileList({ focused: false, onlyFocused: true, fullPath });
  }

  /** The same decision, returning the items rather than their names. */
  markedItems(options) {
    const o = options || {};
    if (this.operateOnFocusedFile(o.focused, o.onlyFocused)) {
      const item = this.focusedItem;
      return item ? [item] : [];
    }
    return this.selectedItems();
  }

  /** GetFilesMarkedSize — the total the status bar reports for a command. */
  markedSize() {
    return this.markedItems().reduce((sum, item) => sum + itemFileSize(item, this.side), 0);
  }

  selectedSize() {
    return this.selectedItems().reduce((sum, item) => sum + itemFileSize(item, this.side), 0);
  }

  /**
   * FindFileItem — the case rule is per side: a remote panel is case sensitive
   * (FCaseSensitive is set true in TUnixDirView's constructor), a local one is
   * not. Getting this wrong silently focuses the wrong file after a rename.
   */
  findFileIndex(fileName) {
    if (fileName === '' || fileName == null) return -1;
    const target = String(fileName);
    const equal = this.caseSensitive
      ? (a, b) => a === b
      : (a, b) => a.toLowerCase() === b.toLowerCase();
    // The optimisation WinSCP keeps: the focused row is checked first, because
    // Load and RestoreState both look up the same name in a row.
    const focused = this.focusedItem;
    if (focused && equal(target, itemFileName(focused))) return this.focusedIndex;
    for (let index = 0; index < this.items.length; index += 1) {
      if (equal(target, itemFileName(this.items[index]))) return index;
    }
    return -1;
  }

  focusByName(fileName) {
    const index = this.findFileIndex(fileName);
    if (index < 0) return false;
    this.focusedIndex = index;
    return true;
  }

  /**
   * SaveSelection — before a delete. It records the focused name AND the
   * closest unselected name, so RestoreSelection can land the cursor on a row
   * that still exists once the selection is gone.
   */
  saveSelection() {
    this._savedSelectionFile = '';
    this._savedSelectionLastFile = '';
    const focused = this.focusedItem;
    if (focused) this._savedSelectionLastFile = itemFileName(focused);
    const closest = this.closestUnselected();
    if (closest != null) this._savedSelectionFile = itemFileName(this.items[closest]);
    this._savedSelection = true;
    return this;
  }

  /**
   * RestoreSelection — only moves the cursor when the focused row is gone or
   * has changed. If the row survived the operation the cursor stays where the
   * user left it.
   */
  restoreSelection() {
    this._savedSelection = false;
    const focused = this.focusedItem;
    if (this._savedSelectionLastFile !== ''
      && (!focused || itemFileName(focused) !== this._savedSelectionLastFile)) {
      const index = this.findFileIndex(this._savedSelectionFile);
      if (index >= 0) this.focusedIndex = index;
    }
    if (!this.focusedItem) this.focusSomething();
    return this.focusedIndex;
  }

  discardSavedSelection() {
    this._savedSelection = false;
    return this;
  }

  get selectionSaved() { return this._savedSelection; }

  /** SaveSelectedNames — survives a reload, which reuses none of the objects. */
  saveSelectedNames() {
    this._savedNames = this.selectedItems().map(itemFileName);
    return this._savedNames.slice();
  }

  /**
   * RestoreSelectedNames — note it SETS every row, so a row that was selected
   * after the save but whose name was not saved becomes unselected. That is
   * WinSCP's behaviour and it is what makes "restore selection" idempotent.
   */
  restoreSelectedNames(names) {
    const list = names === undefined ? this._savedNames : names;
    const set = this.caseSensitive
      ? new Set(list.map(String))
      : new Set(list.map((n) => String(n).toLowerCase()));
    const has = (name) => (this.caseSensitive ? set.has(name) : set.has(name.toLowerCase()));
    for (let index = 0; index < this.items.length; index += 1) {
      this.setSelected(index, has(itemFileName(this.items[index])));
    }
    return this._selected.size;
  }

  get selectedNamesSaved() { return this._savedNames.length > 0; }

  clearSavedNames() { this._savedNames = []; return this; }

  /**
   * FocusSomething — a panel with rows always has one focused, otherwise the
   * keyboard has nothing to move. In Norton mode WinSCP simulates a Down key
   * first, which lands on the first row without selecting it.
   */
  focusSomething() {
    if (this.focusedIndex >= 0 && this.focusedIndex < this.items.length) return this.focusedIndex;
    this.focusedIndex = this.items.length ? 0 : -1;
    return this.focusedIndex;
  }

  /**
   * The mouse-down half of the Norton rules, as a decision rather than a Win32
   * message: given the modifiers, what may a click do?
   *
   *   dontSelect   — a plain click may not ADD to the selection
   *   dontUnselect — a plain click may not REMOVE from it
   *
   * With nlOn both hold, so clicking around a panel never disturbs a
   * selection the user built. With nlKeyboard a plain click outside the
   * selection clears it immediately (clearSelection), because the alternative
   * — clearing on mouse-up — would break dragging.
   */
  mouseDownRules(shift, overSelectedRow) {
    const norton = this.nortonLike;
    const plain = !shift.ctrl && !shift.shift;
    const selectingImplicitly = plain;
    return {
      dontSelect: norton === NORTON_LIKE.On && plain,
      dontUnselect: norton === NORTON_LIKE.On && !shift.ctrl,
      selectingImplicitly,
      clearSelection: selectingImplicitly && norton === NORTON_LIKE.Keyboard && !overSelectedRow,
    };
  }

  /**
   * The keyboard half. Space and the navigation keys go through here.
   * `dontUnselect` is true whenever the selection is explicit, so arrowing
   * around never throws away a selection the user typed Insert to build.
   */
  keyDownRules(shift) {
    const norton = this.nortonLike;
    return {
      dontSelect: norton !== NORTON_LIKE.Off && !shift.shift,
      dontUnselect: norton === NORTON_LIKE.On
        || (norton === NORTON_LIKE.Keyboard && !this.anyAndAllSelectedImplicitly),
    };
  }

  /**
   * WMLButtonUp: a plain click that did not drag collapses the selection onto
   * the focused row, and marks it implicit so a later keystroke may replace it.
   */
  clickCollapse(focusedIndex) {
    this.selectingImplicitly = true;
    try {
      this.selectAll(SELECT_MODE.None, focusedIndex);
    } finally {
      this.selectingImplicitly = false;
    }
    this.anyAndAllSelectedImplicitly = true;
  }
}

// ---------------------------------------------------------------------------
// renaming in place
// ---------------------------------------------------------------------------

/** coInvalidDosChars — what a local file name may not contain. */
const INVALID_DOS_CHARS = '\\/:*?"<>|';

/** TUnixDirView's FInvalidNameChars: a remote name may not contain a slash. */
const INVALID_UNIX_NAME_CHARS = '/';

function invalidNameChars(side) {
  return isLocalSide(side) ? INVALID_DOS_CHARS : INVALID_UNIX_NAME_CHARS;
}

/**
 * TCustomDirView::CanEdit — the four refusals in front of in-place rename.
 *
 * The parent directory is the one people forget: without that test, F2 on ".."
 * offers to rename the directory you came from.
 *
 * `renameCapable` is TUnixDirView::CanEdit's extra condition — the protocol
 * must actually support rename, or the edit box is a promise nothing can keep.
 */
function canEdit(item, options) {
  const o = options || {};
  if (!item) return false;
  if (o.loading) return false;
  if (o.readOnly) return false;
  if (o.isRecycleBin) return false;
  if (itemIsParentDirectory(item)) return false;
  if (o.renameCapable === false) return false;
  return true;
}

/**
 * TCustomDirView::KeyPress — a character that cannot appear in a name is
 * swallowed (with a beep) rather than typed, so the invalid name never forms.
 */
function isInvalidNameChar(ch, side) {
  return typeof ch === 'string' && ch.length === 1 && invalidNameChars(side).includes(ch);
}

const ERROR_INVALID_NAME = 'Filename contains invalid characters:';

/**
 * TCustomDirView::Edit — the rename REFUSAL, which must not be softened into a
 * silent rename of a mangled name.
 *
 * An empty name is not an error: it is how the VCL reports a cancelled edit, so
 * nothing happens and loading resumes. A name containing a forbidden character
 * is refused with the character list spelled out space-separated (WinSCP
 * inserts a space between every character so the list is readable), and the
 * user is offered the choice between retrying and abandoning the edit. A name
 * equal to the old one is accepted and does nothing, which is what stops a
 * pointless round trip to the server.
 */
function validateRename(item, newName, side) {
  const name = newName == null ? '' : String(newName);
  if (name.length === 0) return { action: 'cancel' };

  const invalid = invalidNameChars(side);
  let found = false;
  for (const ch of name) {
    if (invalid.includes(ch)) { found = true; break; }
  }
  if (found) {
    const spaced = Array.from(invalid).join(' ');
    return {
      action: 'refuse',
      error: `${ERROR_INVALID_NAME} ${spaced}`,
      invalidChars: invalid,
      // The dialog offers OK (retry the edit) and Abort (give up); anything
      // that just swallowed the error would leave the user thinking it worked.
      retryable: true,
    };
  }

  if (item && name === itemFileName(item)) return { action: 'unchanged' };
  return { action: 'rename', name };
}

// ---------------------------------------------------------------------------
// incremental search
// ---------------------------------------------------------------------------

/** TIncrementalSearch — WinSCP's PanelSearch preference. */
const INCREMENTAL_SEARCH = Object.freeze({
  Off: 'off',                    // isOff
  NameStartOnly: 'nameStartOnly', // isNameStartOnly
  Name: 'name',                  // isName
  All: 'all',                    // isAll
});

/** TIncrementalSearchState. */
class IncrementalSearchState {
  constructor() { this.reset(); }

  reset() {
    this.searching = false;
    this.text = '';
    this.haveNext = false;
    return this;
  }
}

/**
 * FormatIncrementalSearchStatus — "Search: %s" with "(press Tab for next)"
 * appended only when another match exists. With no text yet the placeholder
 * "(start typing)" stands in for it, so the status bar says what to do.
 *
 * The strings are returned as a structured result too, because this port's
 * status bar is localized and must not be handed a pre-composed English line.
 */
const INC_SEARCH = 'Search: %s';
const INC_NEXT_SEARCH = '(press Tab for next)';
const INC_SEARCH_TYPE = '(start typing)';

function formatIncrementalSearchStatus(state) {
  const s = state || {};
  const text = C.defaultStr(s.text, INC_SEARCH_TYPE);
  let result = INC_SEARCH.replace('%s', text);
  if (s.haveNext && s.text) result += ` ${INC_NEXT_SEARCH}`;
  return result;
}

/**
 * GetNextFile — the search wraps in both directions, which is what makes
 * "current item, then everything else, then stop" terminate.
 */
function nextSearchIndex(index, count, reverse) {
  if (count <= 0) return -1;
  if (!reverse) {
    const next = index + 1;
    return next >= count ? 0 : next;
  }
  const next = index - 1;
  return next < 0 ? count - 1 : next;
}

/**
 * SearchFile — the heart of incremental search.
 *
 * Starts at the focused row (or the first row), optionally skips it, and walks
 * — wrapping — until it comes back to where it started. Returns -1 when
 * nothing matches, which is what makes the caller beep rather than move the
 * cursor somewhere arbitrary.
 *
 * The three modes are WinSCP's:
 *   nameStartOnly  the typed text must be a PREFIX of the name
 *   name           it may appear anywhere in the name
 *   all            it may appear in any VISIBLE column's displayed text
 *
 * Matching is "semi case sensitive": an all-lowercase needle ignores case, a
 * needle with any capital in it does not. So typing "readme" finds README, and
 * typing "README" finds only README.
 */
function searchFile(items, text, options) {
  const o = options || {};
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return -1;
  const mode = o.mode || INCREMENTAL_SEARCH.NameStartOnly;
  if (mode === INCREMENTAL_SEARCH.Off) return -1;
  const needle = String(text == null ? '' : text);
  if (needle === '') return -1;

  const current = (typeof o.currentIndex === 'number' && o.currentIndex >= 0
    && o.currentIndex < list.length) ? o.currentIndex : 0;
  let index = current;
  if (o.skipCurrent) index = nextSearchIndex(index, list.length, !!o.reverse);

  const columns = Array.isArray(o.columns) ? o.columns : null;

  for (;;) {
    const item = list[index];
    let matches = false;
    if (mode === INCREMENTAL_SEARCH.NameStartOnly) {
      matches = C.containsTextSemiCaseSensitive(itemFileName(item).substring(0, needle.length), needle);
    } else if (mode === INCREMENTAL_SEARCH.Name) {
      matches = C.containsTextSemiCaseSensitive(itemFileName(item), needle);
    } else if (mode === INCREMENTAL_SEARCH.All) {
      // Report view searches every VISIBLE column; any other view style has
      // only the name on screen, so it searches column 0 alone.
      const keys = columns || [{ key: 'name', visible: true }];
      for (const column of keys) {
        if (column.visible === false) continue;
        if (C.containsTextSemiCaseSensitive(columnText(item, column.key, o.side, o.format), needle)) {
          matches = true;
          break;
        }
      }
    }

    if (matches) return index;

    index = nextSearchIndex(index, list.length, !!o.reverse);
    if (index === current) return -1;
  }
}

/**
 * IncrementalSearch — one keystroke's worth of work. Returns what the panel
 * should do rather than doing it, so the renderer owns focus and scrolling.
 *
 * `haveNext` is computed by searching AGAIN from the match; without it the
 * status bar would promise a Tab that goes nowhere.
 */
function incrementalSearch(items, text, options) {
  const o = options || {};
  const index = searchFile(items, text, o);
  if (index < 0) {
    // WinSCP beeps and leaves the state untouched, so a typo does not destroy
    // the prefix the user has already matched.
    return { found: false, index: -1, state: o.state || new IncrementalSearchState() };
  }
  const nextIndex = searchFile(items, text, { ...o, currentIndex: index, skipCurrent: true });
  const state = o.state || new IncrementalSearchState();
  state.searching = true;
  state.text = String(text);
  state.haveNext = nextIndex >= 0 && nextIndex !== index;
  return { found: true, index, state };
}

/**
 * DirViewKeyPress — which keystrokes feed the search. Control characters never
 * do, and a space only does once a search is already running, because before
 * that the space belongs to "toggle selection".
 */
function acceptsSearchKey(key, options) {
  const o = options || {};
  if (o.mode === INCREMENTAL_SEARCH.Off) return false;
  if (typeof key !== 'string' || key.length !== 1) return false;
  if (o.ctrl || o.alt || o.meta) return false;
  if (key === ' ') return !!o.searching;
  return key.charCodeAt(0) > 0x20;
}

// ---------------------------------------------------------------------------
// path history
// ---------------------------------------------------------------------------

const DEFAULT_HISTORY_COUNT = 200;

/**
 * TCustomDirView's back/forward history.
 *
 * The layout is WinSCP's and is worth stating because it is not a plain stack:
 * `paths` holds the back entries first (there are `backCount` of them) and then
 * the forward entries. Index 0 of `historyPath()` is the CURRENT path, negative
 * indices go back and positive ones go forward.
 */
class PathHistory {
  constructor(options) {
    const o = options || {};
    this.paths = [];
    this.backCount = 0;
    this.maxHistoryCount = o.maxHistoryCount || DEFAULT_HISTORY_COUNT;
    this.currentPath = o.currentPath || '';
    this._historyPath = o.currentPath || '';
    this._dontRecordPath = false;
    this.onChange = typeof o.onChange === 'function' ? o.onChange : null;
  }

  get forwardCount() { return this.paths.length - this.backCount; }

  /** GetHistoryPath. */
  historyPath(index) {
    if (index === 0) return this.currentPath;
    if (index < 0) return this.paths[index + this.backCount];
    return this.paths[index + this.backCount - 1];
  }

  /**
   * LimitHistorySize — the BACK entries are dropped first (oldest first), and
   * only once there are none left does it start dropping forward entries. So
   * the way back from where you are is the last thing to go.
   */
  limitHistorySize() {
    while (this.paths.length > this.maxHistoryCount) {
      if (this.backCount > 0) {
        this.paths.shift();
        this.backCount -= 1;
      } else {
        this.paths.pop();
      }
    }
    return this;
  }

  setMaxHistoryCount(value) {
    if (this.maxHistoryCount === value) return false;
    this.maxHistoryCount = value;
    this.changed();
    return true;
  }

  changed() {
    this.limitHistorySize();
    if (this.onChange) this.onChange(this);
    return this;
  }

  /**
   * PathChanged — records the path we just LEFT, and drops the whole forward
   * list, because navigating somewhere new makes the old forward branch
   * unreachable. Navigating to the path you are already on records nothing.
   */
  pathChanged(newPath) {
    const path = String(newPath == null ? '' : newPath);
    this.currentPath = path;
    if (!this._dontRecordPath && this._historyPath !== '' && this._historyPath !== path) {
      this.paths.length = this.backCount;   // drop the forward entries
      this.paths.push(this._historyPath);
      this.backCount += 1;
      this.changed();
    }
    this._historyPath = path;
    return this;
  }

  /**
   * HistoryGo — moving `index` steps (negative back, positive forward). The
   * path we are leaving is inserted at the boundary and the one we arrived at
   * is removed, so the two lists stay the right length and going back then
   * forward returns exactly where you were.
   *
   * `navigate(path)` performs the actual directory change. It runs with
   * recording suppressed, because the history already knows about this move —
   * without that, going back would push a new back entry and you could never
   * leave.
   */
  historyGo(index, navigate) {
    if (index === 0) return false;
    const target = this.historyPath(index);
    if (target === undefined) return false;
    const previous = this._historyPath;
    this._dontRecordPath = true;
    try {
      if (typeof navigate === 'function') navigate(target);
      this.currentPath = target;
      this._historyPath = target;
    } finally {
      this._dontRecordPath = false;
    }
    this.paths.splice(this.backCount, 0, previous);
    this.paths.splice(index + this.backCount, 1);
    this.backCount += index;
    this.changed();
    return true;
  }

  /** The list a Back or Forward dropdown renders, nearest first. */
  backList() {
    const out = [];
    for (let i = -1; i >= -this.backCount; i -= 1) out.push(this.historyPath(i));
    return out;
  }

  forwardList() {
    const out = [];
    for (let i = 1; i <= this.forwardCount; i += 1) out.push(this.historyPath(i));
    return out;
  }

  save() {
    return { paths: this.paths.slice(), backCount: this.backCount };
  }

  restore(state) {
    if (!state) {
      this.paths = [];
      this.backCount = 0;
    } else {
      this.paths = Array.isArray(state.paths) ? state.paths.slice() : [];
      this.backCount = typeof state.backCount === 'number' ? state.backCount : 0;
    }
    this.changed();
    return this;
  }
}

// ---------------------------------------------------------------------------
// view state
// ---------------------------------------------------------------------------

/**
 * SaveItemsState/RestoreItemsState — remembering where a panel was scrolled to
 * across a reload, without which every refresh throws the user back to the top.
 *
 * The rule: if the focused row was on screen, remember its OFFSET from the top
 * row and restore that offset, so the row stays under the same pixel. If it was
 * not on screen, remember the top row's index instead and restore the scroll
 * position rather than the focus.
 */
function saveItemsState(options) {
  const o = options || {};
  const focusedIndex = typeof o.focusedIndex === 'number' ? o.focusedIndex : -1;
  const topIndex = typeof o.topIndex === 'number' ? o.topIndex : -1;
  const items = Array.isArray(o.items) ? o.items : [];

  if (focusedIndex >= 0 && focusedIndex < items.length) {
    const focusedShown = !!o.focusedVisible;
    let shownItemOffset;
    if (topIndex < 0) {
      // Seen with one user only: a report view with rows but no top item.
      return { focusedItem: itemFileName(items[focusedIndex]), focusedShown: false, shownItemOffset: 0 };
    }
    shownItemOffset = focusedShown ? focusedIndex - topIndex : topIndex;
    return { focusedItem: itemFileName(items[focusedIndex]), focusedShown, shownItemOffset };
  }
  return { focusedItem: '', focusedShown: false, shownItemOffset: topIndex >= 0 ? topIndex : -1 };
}

/**
 * The scroll/focus decision RestoreItemsState makes, returned as data. The
 * renderer applies it; the arithmetic — including the guard for the case where
 * index 0 was focused and visible yet the top item was index 1, which produces
 * a negative index — lives here.
 */
function restoreItemsState(state, options) {
  const s = state || {};
  const o = options || {};
  const count = typeof o.count === 'number' ? o.count : 0;
  const visibleRowCount = typeof o.visibleRowCount === 'number' ? o.visibleRowCount : 0;
  const focusIndex = typeof o.focusIndex === 'number' ? o.focusIndex : -1;

  const result = { focusIndex: focusIndex >= 0 ? focusIndex : -1, topIndex: -1, makeVisible: -1 };

  if (focusIndex >= 0 && s.focusedShown) {
    const top = focusIndex - (s.shownItemOffset || 0);
    if (top >= 0 && top < count) result.topIndex = top;
  }

  if (!s.focusedShown && (s.shownItemOffset >= 0) && count > 0) {
    if (s.shownItemOffset < count - visibleRowCount) result.topIndex = s.shownItemOffset;
    else result.makeVisible = count - 1;
  } else if (focusIndex >= 0) {
    result.makeVisible = focusIndex;
  }

  return result;
}

/**
 * TDirViewState — everything a panel restores when a session is reopened or a
 * tab is reactivated: where it was, how it was sorted, what mask was on, and
 * which row was focused.
 */
function saveState(options) {
  const o = options || {};
  const history = o.history ? o.history.save() : { paths: [], backCount: 0 };
  const items = saveItemsState(o);
  return {
    historyPaths: history.paths,
    backCount: history.backCount,
    sortStr: o.sortStr || '',
    mask: o.mask || '',
    focusedItem: items.focusedItem,
    focusedShown: items.focusedShown,
    shownItemOffset: items.shownItemOffset,
    // TCustomUnixDriveView::SaveState — the expanded directories, sorted.
    expandedNodes: Array.isArray(o.expandedNodes) ? o.expandedNodes.slice().sort() : [],
  };
}

// ---------------------------------------------------------------------------
// the mask filter
// ---------------------------------------------------------------------------

/**
 * SetMask plus AnnounceState. WinSCP keeps TWO masks: `mask` is what the user
 * typed and what the path label shows, `effectiveMask` is what the CURRENT
 * listing was filtered with. They differ for exactly one moment — while a
 * restored state's mask is announced but the directory has not been read yet —
 * and the difference is what stops a redundant reload.
 */
class MaskFilter {
  constructor(mask) {
    this.mask = String(mask || '');
    this.effectiveMask = this.mask;
    this.announcedMask = null;
  }

  /** AnnounceState: an incoming state's mask becomes effective immediately. */
  announce(state) {
    if (state && typeof state.mask === 'string') {
      this.announcedMask = state.mask;
      this.effectiveMask = state.mask;
    } else {
      this.announcedMask = null;
      this.effectiveMask = this.mask;
    }
    return this;
  }

  /** Returns whether the listing has to be re-read. */
  setMask(value) {
    const next = String(value == null ? '' : value);
    if (this.mask === next) return { changed: false, reload: false };
    this.mask = next;
    if (this.effectiveMask !== next) {
      this.effectiveMask = next;
      return { changed: true, reload: true };
    }
    return { changed: true, reload: false };
  }

  /**
   * UpdatePathLabelCaption — the mask is shown beside the path, but never on an
   * empty label: a disconnected remote panel showing a bare filter mask would
   * read as if it had filtered a directory it has not even opened.
   */
  pathLabel(pathName) {
    const caption = String(pathName || '');
    return { caption, mask: caption === '' ? '' : this.mask };
  }
}

// ---------------------------------------------------------------------------
// mask-edit validation
// ---------------------------------------------------------------------------

const FILE_MASKS_DELIMITERS = ';,';
const INCLUDE_EXCLUDE_MASKS_DELIMITER = '|';
const ALL_FILE_MASKS_DELIMITERS = FILE_MASKS_DELIMITERS + INCLUDE_EXCLUDE_MASKS_DELIMITER;
const DIRECTORY_MASK_DELIMITERS = '/\\';
const FILE_MASKS_DELIMITER_STR = '; ';

/**
 * TFileMasks::MakeDirectoryMask — a directory mask ends in a separator. If the
 * mask already contains one, the SAME kind is appended, so "docs\sub" becomes
 * "docs\sub\" and "docs/sub" becomes "docs/sub/"; with none, a slash is used.
 */
function makeDirectoryMask(str) {
  let s = String(str);
  if (s === '') return s;
  if (DIRECTORY_MASK_DELIMITERS.includes(s[s.length - 1])) return s;
  // DirectoryMaskDelimiters[1] in the C++ is a 1-BASED index into "/\", so the
  // fallback separator is the forward slash, not the backslash.
  let delimiter = DIRECTORY_MASK_DELIMITERS[0];
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (DIRECTORY_MASK_DELIMITERS.includes(s[i])) { delimiter = s[i]; break; }
  }
  s += delimiter;
  return s;
}

/**
 * TFileMasks::ComposeMaskStr(TStrings, Directory) — turns one memo of the mask
 * editor into a mask string.
 *
 * Two things here are easy to get wrong and both lose user data:
 *   * a delimiter INSIDE a mask is doubled (";" becomes ";;"), because that is
 *     how the grammar escapes it — a file genuinely called "a;b" must survive;
 *   * for directory masks the trailing separator is added, but the validation
 *     is run against the version WITHOUT it, because appending a slash to a
 *     size or time mask would make it parse as a name and skip its own checks.
 */
function composeMaskStr(lines, directory) {
  const list = Array.isArray(lines) ? lines : String(lines || '').split(/\r\n|\r|\n/);
  const parts = [];
  const partsNoDirMask = [];

  for (const raw of list) {
    let str = String(raw == null ? '' : raw).trim();
    if (str === '') continue;

    let escaped = '';
    for (const ch of str) {
      escaped += ALL_FILE_MASKS_DELIMITERS.includes(ch) ? ch + ch : ch;
    }
    str = escaped;

    let noDirMask;
    if (directory) {
      noDirMask = str;
      str = makeDirectoryMask(str);
    } else {
      while (str.length > 0 && DIRECTORY_MASK_DELIMITERS.includes(str[str.length - 1])) {
        str = str.slice(0, -1);
      }
      noDirMask = str;
    }

    parts.push(str);
    partsNoDirMask.push(noDirMask);
  }

  const result = parts.join(FILE_MASKS_DELIMITER_STR);
  const validation = validateMask(partsNoDirMask.join(FILE_MASKS_DELIMITER_STR), directory ? 1 : 0);
  return { mask: result, valid: validation.ok, error: validation };
}

/**
 * TFileMasks::ComposeMaskStr(4 x TStrings) — the whole Edit-mask dialog into
 * one mask. Include masks first, then "| ", then the exclude masks; directory
 * masks are appended to their side.
 */
function composeMasks(includeFiles, excludeFiles, includeDirectories, excludeDirectories) {
  const includeFile = composeMaskStr(includeFiles || [], false);
  const includeDir = composeMaskStr(includeDirectories || [], true);
  const excludeFile = composeMaskStr(excludeFiles || [], false);
  const excludeDir = composeMaskStr(excludeDirectories || [], true);

  const include = joinMaskList(includeFile.mask, includeDir.mask);
  const exclude = joinMaskList(excludeFile.mask, excludeDir.mask);

  let mask = include;
  if (exclude !== '') {
    if (mask !== '') mask += ' ';
    mask += `${INCLUDE_EXCLUDE_MASKS_DELIMITER} ${exclude}`;
  }

  const failed = [includeFile, includeDir, excludeFile, excludeDir].find((r) => !r.valid);
  return { mask, valid: !failed, error: failed ? failed.error : { ok: true } };
}

function joinMaskList(first, second) {
  if (first === '') return second;
  if (second === '') return first;
  return first + FILE_MASKS_DELIMITER_STR + second;
}

/**
 * TFileMasks::NormalizeMask — "*" and "*.*" mean "everything", so they are
 * collapsed to the caller's any-mask rather than stored as a filter. Without
 * this a user who types "*" into the filter box gets a panel that claims to be
 * filtered.
 */
function normalizeMask(mask, anyMask) {
  const any = anyMask === undefined ? '*.*' : anyMask;
  return masks.isEffectiveFileNameMask(mask) ? String(mask) : any;
}

/**
 * ValidateMask/ValidateMaskEdit. `forceDirectoryMasks` is WinSCP's tri-state:
 * -1 leave it to the mask itself, 0 forbid directory masks, 1 require them.
 *
 * The result carries `start`/`length` because the dialog SELECTS the offending
 * part of the text — telling a user their mask is wrong without showing them
 * where is barely better than not telling them.
 */
function validateMask(mask, forceDirectoryMasks) {
  const options = {};
  if (forceDirectoryMasks === 0) options.forceDirectoryMasks = 0;
  else if (forceDirectoryMasks === 1) options.forceDirectoryMasks = 1;
  const result = masks.validate(String(mask == null ? '' : mask), options);
  if (result.ok) return { ok: true, mask: String(mask == null ? '' : mask) };
  return {
    ok: false,
    error: result.error,
    // The dialog does SelStart = ErrorStart - 1, i.e. it converts WinSCP's
    // 1-based position to a 0-based caret offset. That conversion belongs here
    // so no caller has to remember it.
    selectionStart: Math.max(0, (result.start || 1) - 1),
    selectionLength: result.length || 0,
  };
}

// ---------------------------------------------------------------------------
// exporting the file list
// ---------------------------------------------------------------------------

/** TPanelExport. */
const PANEL_EXPORT = Object.freeze({ Path: 'path', FileList: 'fileList', FullFileList: 'fullFileList' });

/**
 * TCustomScpExplorerForm::PanelExport — what "Copy file list to clipboard"
 * actually produces.
 *
 * A name containing a space is wrapped in double quotes, because the output is
 * meant to be pasteable onto a command line where an unquoted space is two
 * arguments. Nothing else is escaped: WinSCP does not escape an embedded quote,
 * and inventing an escape here would produce a different string from the one
 * the user's other tools expect.
 */
function panelExport(exportKind, options) {
  const o = options || {};
  if (exportKind === PANEL_EXPORT.Path) return [String(o.pathName || '')];

  const fullPath = exportKind === PANEL_EXPORT.FullFileList;
  const items = Array.isArray(o.items) ? o.items : [];
  const path = typeof o.fullPath === 'function' ? o.fullPath : itemFileName;
  return items.map((item) => {
    const name = fullPath ? String(path(item)) : itemFileName(item);
    return name.includes(' ') ? `"${name}"` : name;
  });
}

/**
 * StringsToText — one line goes to the clipboard bare, several go with a
 * trailing newline. That asymmetry is deliberate in WinSCP: pasting a single
 * file name into a text box should not append a line break.
 */
function stringsToText(lines, eol) {
  const list = Array.isArray(lines) ? lines : [];
  const sep = eol === undefined ? '\r\n' : eol;
  if (list.length === 1) return String(list[0]);
  if (list.length === 0) return '';
  return list.map(String).join(sep) + sep;
}

/** The two together: the exact clipboard payload for a file-list copy. */
function fileListToText(exportKind, options) {
  return stringsToText(panelExport(exportKind, options), options && options.eol);
}

// ---------------------------------------------------------------------------
// comparing two panels
// ---------------------------------------------------------------------------

/** TCompareCriteria. */
const COMPARE_CRITERIA = Object.freeze({ Time: 'time', Size: 'size' });

/**
 * ProcessChangedFiles — "Select newer/different files", the panel-to-panel
 * comparison behind the Compare command.
 *
 * The rules that matter:
 *   * directories are never compared, so a whole tree is never selected by it;
 *   * a file missing on the other side counts as changed unless `existingOnly`;
 *   * timestamps are reduced to the COARSER of the two precisions before they
 *     are compared, so an FTP listing with minute precision does not report
 *     every file as different from a local one with seconds;
 *   * with second precision, one extra millisecond is allowed on the other
 *     side to absorb rounding;
 *   * size is only consulted when the times came out equal.
 */
function compareWithPanel(items, otherItems, options) {
  const o = options || {};
  const criteria = new Set(Array.isArray(o.criteria) ? o.criteria : [COMPARE_CRITERIA.Time]);
  const existingOnly = !!o.existingOnly;
  const caseSensitive = !!o.caseSensitive;
  const precisionOf = typeof o.precision === 'function' ? o.precision : () => 'second';

  const index = new Map();
  for (const other of (otherItems || [])) {
    const name = itemFileName(other);
    index.set(caseSensitive ? name : name.toLowerCase(), other);
  }

  const changed = [];
  for (const item of (items || [])) {
    if (itemIsDirectory(item)) continue;
    const name = itemFileName(item);
    const mirror = index.get(caseSensitive ? name : name.toLowerCase());
    let isChanged = false;
    let sameTime = true;

    if (!mirror) {
      isChanged = !existingOnly;
    } else {
      if (criteria.has(COMPARE_CRITERIA.Time)) {
        const precision = lessPrecision(precisionOf(item), precisionOf(mirror));
        let time = reducePrecision(itemFileTime(item), precision);
        let mirrorTime = reducePrecision(itemFileTime(mirror), precision);
        sameTime = time === mirrorTime;
        if (precision === 'second') mirrorTime += 1;
        isChanged = time > mirrorTime;
      }
      if (!isChanged && sameTime && criteria.has(COMPARE_CRITERIA.Size)) {
        isChanged = itemFileSize(item, o.side) !== itemFileSize(mirror, o.side);
      }
    }

    if (isChanged) changed.push(item);
  }
  return changed;
}

const PRECISION_ORDER = ['none', 'day', 'minute', 'second', 'millisecond'];

function lessPrecision(a, b) {
  const ia = PRECISION_ORDER.indexOf(a);
  const ib = PRECISION_ORDER.indexOf(b);
  return PRECISION_ORDER[Math.min(ia < 0 ? PRECISION_ORDER.length - 1 : ia,
    ib < 0 ? PRECISION_ORDER.length - 1 : ib)];
}

function reducePrecision(ms, precision) {
  const t = typeof ms === 'number' ? ms : 0;
  switch (precision) {
    case 'none': return 0;
    case 'day': return Math.floor(t / 86400000) * 86400000;
    case 'minute': return Math.floor(t / 60000) * 60000;
    case 'second': return Math.floor(t / 1000) * 1000;
    default: return t;
  }
}

// ---------------------------------------------------------------------------
// the directory tree (drive view)
// ---------------------------------------------------------------------------

/**
 * TCustomUnixDriveView / TCustomDriveView as a data structure.
 *
 * A tree of directories keyed by path. What is ported is the model:
 * inserting a path and every ancestor it needs, keeping each node's children
 * sorted the way the view sorts them, finding a node by path (and finding the
 * nearest EXISTING ancestor when the exact node is not loaded), filtering
 * hidden and inaccessible directories, and remembering which nodes were
 * expanded across a reload.
 *
 * The Win32 parts — image indexes, drag targets, LockWindowUpdate — are the
 * renderer's problem and are not here.
 */
class DirectoryTree {
  constructor(options) {
    const o = options || {};
    this.unixPath = o.unixPath !== false;
    this.rootName = o.rootName || (this.unixPath ? '/ <root>' : '');
    this.showHiddenDirs = o.showHiddenDirs !== false;
    this.showInaccesibleDirectories = o.showInaccesibleDirectories !== false;
    this.naturalOrderNumericalSorting = !!o.naturalOrderNumericalSorting;
    this.root = null;
    this._byPath = new Map();
    this._pendingDelete = new Set();
    this.selectedPath = '';
  }

  get separator() { return this.unixPath ? '/' : '\\'; }

  isRootPath(path) {
    const p = String(path || '');
    if (this.unixPath) return p === '' || p === '/';
    return /^[A-Za-z]:[\\/]?$/.test(p);
  }

  excludeTrailing(path) {
    const p = String(path || '');
    if (this.isRootPath(p)) return this.unixPath ? '/' : p;
    if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) return p.slice(0, -1);
    return p;
  }

  parentOf(path) {
    const p = this.excludeTrailing(path);
    if (this.isRootPath(p)) return '';
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (i <= 0) return this.unixPath ? '/' : '';
    return p.slice(0, i);
  }

  nameOf(path) {
    const p = this.excludeTrailing(path);
    if (this.isRootPath(p)) return this.rootName;
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  }

  join(parent, name) {
    const p = this.excludeTrailing(parent);
    if (this.isRootPath(p) && this.unixPath) return `/${name}`;
    return p + this.separator + name;
  }

  /** DoCompareText — the tree sorts exactly the way the panel sorts names. */
  compareNames(name1, name2) {
    return C.compareLogicalText(name1, name2, this.naturalOrderNumericalSorting);
  }

  /**
   * LoadPath — makes sure a node exists for `path`, creating every missing
   * ancestor on the way. Returns the node.
   */
  loadPath(path, file) {
    let p = this.excludeTrailing(path === '' || path == null ? (this.unixPath ? '/' : '') : path);
    const existing = this._byPath.get(p);
    if (existing) return existing;

    let parent = null;
    if (!this.isRootPath(p)) {
      const parentPath = this.parentOf(p);
      if (parentPath !== '') parent = this.loadPath(parentPath);
    }
    return this._addNode(parent, p, file);
  }

  _addNode(parent, path, file) {
    const node = {
      path,
      name: this.nameOf(path),
      parent,
      children: [],
      expanded: false,
      file: file || null,
      loaded: false,
    };
    this._byPath.set(path, node);
    if (parent) {
      parent.children.push(node);
      this.sortChildren(parent);
    } else if (!this.root) {
      this.root = node;
    }
    return node;
  }

  sortChildren(node) {
    if (!node) return;
    node.children.sort((a, b) => this.compareNames(a.name, b.name));
  }

  /**
   * UpdatePath — reconciles one node's children with a fresh listing.
   *
   * Only real, visible directories become children. A child that is no longer
   * in the listing is deleted — unless the current selection is inside it, in
   * which case the deletion is REMEMBERED and retried later (NodeTryDelete),
   * because removing the node the user is standing on would drop them
   * somewhere arbitrary.
   */
  updatePath(path, files) {
    const node = this._byPath.get(this.excludeTrailing(path));
    if (!node) return null;
    const listing = Array.isArray(files) ? files : [];
    const seen = new Map(node.children.map((child) => [child.name, child]));

    for (const file of listing) {
      const name = itemFileName(file);
      if (!itemIsDirectory(file) || !C.isRealFile(name)) continue;
      if (!this.showHiddenDirs && file.hidden) continue;
      if (!this.showInaccesibleDirectories && file.isInaccesibleDirectory) continue;

      const existing = seen.get(name);
      if (existing) {
        existing.file = file;
        seen.delete(name);
      } else {
        this._addNode(node, this.join(node.path, name), file);
      }
    }

    for (const orphan of seen.values()) this.nodeTryDelete(orphan, true);

    node.loaded = true;
    this.sortChildren(node);
    return node;
  }

  /**
   * NodeTryDelete — refuses to remove a node that holds the selection, and
   * remembers it so CheckPendingDeletes can finish the job once the selection
   * has moved.
   */
  nodeTryDelete(node, rememberIfFails) {
    if (!node) return false;
    const selected = this.selectedPath;
    const blocked = selected !== ''
      && (selected === node.path || this.isAncestorPath(node.path, selected));
    if (blocked) {
      if (rememberIfFails) this._pendingDelete.add(node.path);
      return false;
    }
    this.deleteNode(node);
    return true;
  }

  /** CheckPendingDeletes — retried whenever the selection moves. */
  checkPendingDeletes() {
    let removed = 0;
    for (const path of [...this._pendingDelete]) {
      const node = this._byPath.get(path);
      if (!node) { this._pendingDelete.delete(path); continue; }
      if (this.nodeTryDelete(node, false)) { this._pendingDelete.delete(path); removed += 1; }
    }
    return removed;
  }

  get pendingDeletes() { return [...this._pendingDelete]; }

  deleteNode(node) {
    if (!node) return false;
    for (const child of node.children.slice()) this.deleteNode(child);
    if (node.parent) {
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    }
    this._byPath.delete(node.path);
    this._pendingDelete.delete(node.path);
    if (this.root === node) this.root = null;
    return true;
  }

  isAncestorPath(ancestor, path) {
    const a = this.excludeTrailing(ancestor);
    const p = this.excludeTrailing(path);
    if (a === p) return false;
    const prefix = a.endsWith('/') || a.endsWith('\\') ? a : a + this.separator;
    return p.startsWith(prefix) || (this.unixPath && a === '/' && p.startsWith('/'));
  }

  /** FindNodeToPath — the exact node for a path, or null. */
  findNodeToPath(path) {
    return this._byPath.get(this.excludeTrailing(path)) || null;
  }

  /**
   * FindPathNode — the deepest node that DOES exist on the way to `path`. What
   * the drive view selects when the exact directory has not been loaded: the
   * nearest ancestor, never nothing.
   */
  findPathNode(path) {
    let p = this.excludeTrailing(path);
    for (;;) {
      const node = this._byPath.get(p);
      if (node) return node;
      if (this.isRootPath(p) || p === '') return this.root;
      p = this.parentOf(p);
      if (p === '') return this.root;
    }
  }

  /** NodeIsHidden — a node with no listing entry falls back to the name. */
  nodeIsHidden(node) {
    if (!node) return false;
    if (node.file) return !!node.file.hidden;
    return node.name.startsWith('.') && node.name !== '.' && node.name !== '..';
  }

  setSelectedPath(path) {
    this.selectedPath = this.excludeTrailing(path);
    this.checkPendingDeletes();
    return this.selectedPath;
  }

  /** SaveState — the expanded directories, sorted, so the shape survives. */
  saveExpanded() {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.expanded && node.children.length) out.push(node.path);
      for (const child of node.children) walk(child);
    };
    walk(this.root);
    return out.sort();
  }

  /** LoadNodeState/RestoreState — re-expand what was expanded. */
  restoreExpanded(paths) {
    const set = new Set(paths || []);
    let count = 0;
    for (const [path, node] of this._byPath) {
      const expand = set.has(path);
      if (node.expanded !== expand) count += 1;
      node.expanded = expand;
    }
    return count;
  }

  /** Every node, depth-first, which is the order the tree renders in. */
  flatten(options) {
    const o = options || {};
    const visibleOnly = o.visibleOnly !== false;
    const out = [];
    const walk = (node, depth) => {
      if (!node) return;
      out.push({ node, depth });
      if (visibleOnly && !node.expanded) return;
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(this.root, 0);
    return out;
  }
}

// ---------------------------------------------------------------------------
// drive info (local side)
// ---------------------------------------------------------------------------

/**
 * TDriveInfoInt's naming and path rules, which the local drive view and the
 * local path combo both depend on. The parts that need the Windows shell
 * (icons, volume labels, readiness) are the main process's job; these are the
 * pure ones.
 */

const FIRST_DRIVE = 'A';
const LAST_DRIVE = 'Z';
const SYSTEM_DRIVE = 'C';

/** IsRealDrive — a real drive is a single letter; anything else is a UNC root. */
function isRealDrive(drive) {
  const d = String(drive || '');
  return d.length === 1 && d.toUpperCase() >= FIRST_DRIVE && d.toUpperCase() <= LAST_DRIVE;
}

function isUncPath(path) {
  const p = String(path || '');
  return p.startsWith('\\\\') || p.startsWith('//');
}

/**
 * GetDriveKey — the key a path is filed under. A drive letter is upper-cased
 * so "c:\x" and "C:\X" share one entry; a UNC path is lower-cased because
 * servers and shares are not case sensitive. A path that is neither is an
 * error, not a silent empty key.
 */
function driveKey(path) {
  const drive = C.extractFileDrive(path);
  if (drive.length === 2 && drive[1] === ':') return drive[0].toUpperCase();
  if (isUncPath(path)) return drive.toLowerCase();
  throw new Error(`Invalid drive: ${path}`);
}

/** GetDriveRoot. */
function driveRoot(drive) {
  const d = String(drive || '');
  if (isRealDrive(d)) return `${d}:\\`;
  return C.includeTrailingBackslash(d);
}

/** GetSimpleName — "C:" for a real drive, the share itself for a UNC root. */
function driveSimpleName(drive) {
  const d = String(drive || '');
  return isRealDrive(d) ? `${d}:` : d;
}

/**
 * IsFixedDrive — everything except a floppy. UseABDrives makes A: and B: count
 * as fixed for the people who still have one.
 */
function isFixedDrive(drive, useABDrives) {
  if (!isRealDrive(drive)) return true;
  const firstFixed = useABDrives ? FIRST_DRIVE : SYSTEM_DRIVE;
  return String(drive).toUpperCase() >= firstFixed;
}

/**
 * GetPrettyName's composition — "C: Windows" rather than "Windows (C:)".
 * When the shell display name already ends in " (C:)" that suffix is removed,
 * so the letter is not printed twice.
 */
function drivePrettyName(drive, displayName, options) {
  const o = options || {};
  const simple = driveSimpleName(drive);
  if (!displayName) return simple;

  if (o.remote) {
    if (isRealDrive(drive)) {
      const network = String(o.networkName || '');
      return `${simple} ${C.extractFileName(network)} (${C.extractFileDir(network)})`;
    }
    return simple;
  }

  let pretty = `${simple} ${displayName}`;
  const suffix = ` (${simple})`;
  const at = pretty.indexOf(suffix);
  if (at >= 0) pretty = pretty.slice(0, at) + pretty.slice(at + suffix.length);
  return pretty;
}

/**
 * TDirView's FLastPaths — the directory each drive was last in, so switching
 * back to D: returns where you were rather than to D:\.
 *
 * `exists(path)` reports whether the remembered directory still exists; when it
 * does not, the drive's root is returned instead of a path that would fail.
 */
class LastPaths {
  constructor() { this.paths = new Map(); }

  record(path) {
    const p = String(path || '');
    if (p === '') return this;
    try {
      this.paths.set(driveKey(p), p);
    } catch {
      // A path with no drive (a relative one, or a remote path handed to the
      // local view by mistake) simply is not remembered.
    }
    return this;
  }

  tryGet(drive, exists) {
    const key = String(drive || '');
    if (!this.paths.has(key)) return { found: false, path: '' };
    const path = this.paths.get(key);
    if (typeof exists === 'function' && !exists(path)) {
      return { found: true, path: isRealDrive(key) ? `${key}:` : key };
    }
    return { found: true, path };
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  // columns
  DIR_VIEW_COL, UNIX_DIR_VIEW_COL, LOCAL_COLUMNS, REMOTE_COLUMNS,
  columnsFor, columnIndex, sortAscendingByDefault, columnText,

  // item accessors
  PARENT_DIRECTORY, OVERLAY,
  itemFileName, itemIsParentDirectory, itemIsDirectory, itemIsFile,
  resolveExecuteFile,
  itemFileSize, itemFileTime, itemExtension, itemAttr, itemTypeName, itemIsHidden,
  itemOwner, itemGroup, itemRights, itemLinkTarget, itemOverlayIndexes,

  // sorting
  compareItems, compareToken, makeComparator, sortItems, SortState,

  // loading and filtering
  buildView, statusFileInfo, sameStatusFileInfo, defaultMatchMask,
  defaultFileFilter, itemMatchesFilter, sameExtensionFilter, MaskFilter,

  // selection
  NORTON_LIKE, SELECT_MODE, SELECT_METHOD, SelectionModel,

  // renaming
  INVALID_DOS_CHARS, INVALID_UNIX_NAME_CHARS, ERROR_INVALID_NAME,
  invalidNameChars, canEdit, isInvalidNameChar, validateRename,

  // incremental search
  INCREMENTAL_SEARCH, IncrementalSearchState, searchFile, incrementalSearch,
  nextSearchIndex, acceptsSearchKey, formatIncrementalSearchStatus,
  INC_SEARCH, INC_NEXT_SEARCH, INC_SEARCH_TYPE,

  // history and state
  DEFAULT_HISTORY_COUNT, PathHistory, saveItemsState, restoreItemsState, saveState,

  // masks
  makeDirectoryMask, composeMaskStr, composeMasks, normalizeMask, validateMask,
  FILE_MASKS_DELIMITERS, INCLUDE_EXCLUDE_MASKS_DELIMITER,
  DIRECTORY_MASK_DELIMITERS, FILE_MASKS_DELIMITER_STR,

  // export
  PANEL_EXPORT, panelExport, stringsToText, fileListToText,

  // comparison
  COMPARE_CRITERIA, compareWithPanel,

  // tree and drives
  DirectoryTree, LastPaths,
  isRealDrive, isFixedDrive, isUncPath, driveKey, driveRoot,
  driveSimpleName, drivePrettyName,
};
