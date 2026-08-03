// ui/panelcolumns.js — the file panel's column model and header.
//
// The column sets are WinSCP's own, taken from
// source/packages/filemng/DirViewColProperties.pas (local) and
// UnixDirViewColProperties.pas (remote), including their default widths,
// alignments and which columns start hidden:
//
//   local   Name 150 | Size 80 (right) | Type 125 | Date modified 130 |
//           Attr 45 | Ext 20 (hidden)
//   remote  Name 150 | Size 80 (right) | Date modified 130 | Rights 100 |
//           Owner 130 | Group 130 | Ext (hidden) | Link target 150 (hidden) |
//           Type 125 (hidden)
//
// What lives here: visibility, order, widths, resize, reorder, auto-size,
// reset-to-layout, the sort key and direction, and the comparator — including
// WinSCP's natural numeric ordering and "always sort directories by name".
// The panel owns rows; this module owns the shape of the grid above them.

import { h, icon, uid, appearanceTarget, announce, clamp } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import { formatBytes, readPref, writePref, runAction, commandState, actionLabel } from './commands.js';

/* ================================================================== */
/* the column sets                                                     */
/* ================================================================== */

/**
 * `key` is this port's stable identifier (it is what the sort actions use),
 * `labelKey` is the i18n key, and `width`/`align`/`visible` are WinSCP's own
 * defaults so a fresh profile looks like a fresh WinSCP.
 */
export const LOCAL_COLUMNS = [
  { key: 'name', labelKey: 'colName', width: 150, align: 'left', visible: true, min: 80 },
  { key: 'size', labelKey: 'colSize', width: 80, align: 'right', visible: true, min: 60 },
  { key: 'type', labelKey: 'colType', width: 125, align: 'left', visible: true, min: 60 },
  { key: 'changed', labelKey: 'colChanged', width: 130, align: 'left', visible: true, min: 90 },
  { key: 'attr', labelKey: 'colAttr', width: 45, align: 'left', visible: true, min: 40 },
  { key: 'ext', labelKey: 'colExt', width: 60, align: 'left', visible: false, min: 40 },
];

export const REMOTE_COLUMNS = [
  { key: 'name', labelKey: 'colName', width: 150, align: 'left', visible: true, min: 80 },
  { key: 'size', labelKey: 'colSize', width: 80, align: 'right', visible: true, min: 60 },
  { key: 'changed', labelKey: 'colChanged', width: 130, align: 'left', visible: true, min: 90 },
  { key: 'rights', labelKey: 'colRights', width: 100, align: 'left', visible: true, min: 80 },
  { key: 'owner', labelKey: 'colOwner', width: 130, align: 'left', visible: true, min: 70 },
  { key: 'group', labelKey: 'colGroup', width: 130, align: 'left', visible: true, min: 70 },
  { key: 'ext', labelKey: 'colExt', width: 60, align: 'left', visible: false, min: 40 },
  { key: 'linkTarget', labelKey: 'colLinkTarget', width: 150, align: 'left', visible: false, min: 80 },
  { key: 'type', labelKey: 'colType', width: 125, align: 'left', visible: false, min: 60 },
];

export function defaultColumns(side) {
  return (side === 'local' ? LOCAL_COLUMNS : REMOTE_COLUMNS).map((c) => ({ ...c }));
}

/* ================================================================== */
/* cell values                                                         */
/* ================================================================== */

/** The file-type description WinSCP shows in the Type column. */
const TYPE_NAMES = {
  '': 'File', txt: 'Text Document', log: 'Log File', md: 'Markdown Document',
  html: 'HTML Document', htm: 'HTML Document', css: 'Style Sheet', js: 'JavaScript File',
  json: 'JSON File', xml: 'XML Document', yml: 'YAML File', yaml: 'YAML File',
  png: 'PNG Image', jpg: 'JPEG Image', jpeg: 'JPEG Image', gif: 'GIF Image',
  svg: 'SVG Image', webp: 'WebP Image', bmp: 'Bitmap Image', ico: 'Icon',
  pdf: 'PDF Document', zip: 'Compressed Archive', gz: 'Compressed Archive',
  tar: 'Archive', bz2: 'Compressed Archive', xz: 'Compressed Archive', '7z': 'Compressed Archive',
  exe: 'Application', dll: 'Application Extension', msi: 'Windows Installer Package',
  sh: 'Shell Script', bat: 'Batch File', cmd: 'Command Script', ps1: 'PowerShell Script',
  py: 'Python Script', rb: 'Ruby Script', pl: 'Perl Script', php: 'PHP Script',
  c: 'C Source', h: 'C Header', cpp: 'C++ Source', hpp: 'C++ Header',
  cs: 'C# Source', java: 'Java Source', go: 'Go Source', rs: 'Rust Source',
  conf: 'Configuration File', cfg: 'Configuration File', ini: 'Configuration File',
  sql: 'SQL Script', csv: 'Comma Separated Values', doc: 'Word Document',
  docx: 'Word Document', xls: 'Excel Worksheet', xlsx: 'Excel Worksheet',
  ppt: 'PowerPoint Presentation', pptx: 'PowerPoint Presentation',
  mp3: 'Audio File', wav: 'Audio File', mp4: 'Video File', mkv: 'Video File',
  key: 'Key File', pem: 'Certificate File', crt: 'Certificate File', pub: 'Public Key',
};

/** The extension WinSCP sorts and shows: everything after the LAST dot. */
export function extensionOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  // A leading dot is part of the name (".bashrc" has no extension in WinSCP).
  if (i <= 0) return '';
  return s.slice(i + 1);
}

export function baseNameOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i <= 0 ? s : s.slice(0, i);
}

export function typeOf(entry) {
  if (!entry) return '';
  if (entry.name === '..') return 'Parent Directory';
  if (entry.type === 'dir') return 'File Folder';
  if (entry.type === 'link' || entry.isSymlink) return 'Symbolic Link';
  const ext = extensionOf(entry.name).toLowerCase();
  return TYPE_NAMES[ext] || (ext ? `${ext.toUpperCase()} File` : 'File');
}

/** DOS-style attribute letters for the local Attr column. */
export function attrOf(entry) {
  if (!entry) return '';
  let out = '';
  if (entry.type === 'dir') out += 'd';
  if (entry.readOnly) out += 'r';
  if (entry.hidden) out += 'h';
  if (entry.isSymlink) out += 'l';
  if (entry.raw && entry.raw.system) out += 's';
  if (entry.raw && entry.raw.archive) out += 'a';
  return out;
}

export function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  // A fixed, sortable presentation: the panel is a table, not prose.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The display string for one cell. Never returns null, so a row never gaps. */
export function cellText(entry, key, opts = {}) {
  if (!entry) return '';
  switch (key) {
    case 'name': return entry.name;
    case 'ext': return entry.type === 'dir' ? '' : extensionOf(entry.name);
    case 'size':
      if (entry.type === 'dir') return entry.calculatedSize != null ? formatBytes(entry.calculatedSize, opts.sizeFormat) : '';
      return formatBytes(entry.size || 0, opts.sizeFormat);
    case 'type': return typeOf(entry);
    case 'changed': return formatTime(entry.mtime);
    case 'rights': return entry.rights || '';
    case 'attr': return attrOf(entry);
    case 'owner': return entry.owner || '';
    case 'group': return entry.group || '';
    case 'linkTarget': return entry.linkTarget || '';
    default: return '';
  }
}

/* ================================================================== */
/* sorting                                                             */
/* ================================================================== */

/**
 * WinSCP's "natural order numerical sorting": digit runs compare as numbers,
 * so file10 sorts after file9. Everything else is a case-insensitive compare
 * with a case-sensitive tiebreak, so "A" and "a" have a stable order.
 */
export function naturalCompare(a, b) {
  const s = String(a ?? '');
  const o = String(b ?? '');
  const re = /(\d+)|(\D+)/g;
  const as = s.toLowerCase().match(re) || [];
  const bs = o.toLowerCase().match(re) || [];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const x = as[i]; const y = bs[i];
    const xn = /^\d/.test(x); const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
      // "007" and "7" are the same number, so the digits break the tie the way
      // StrCmpLogicalW does — lexicographically, which puts the padded one
      // first and keeps the order stable instead of arbitrary.
      if (x !== y) return x < y ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (as.length !== bs.length) return as.length < bs.length ? -1 : 1;
  return s === o ? 0 : (s < o ? -1 : 1);
}

export function plainCompare(a, b) {
  const s = String(a ?? '').toLowerCase();
  const o = String(b ?? '').toLowerCase();
  if (s === o) return 0;
  return s < o ? -1 : 1;
}

/**
 * TCustomIEListView::SortAscendingByDefault — which direction a column starts
 * in the first time it is clicked.
 *
 * design/main/dirview.js is the authority (it is the port of the column sets
 * themselves, and `panel:sortAscendingByDefault` serves the same answer over
 * IPC); this is the same rule kept locally because a header click must not wait
 * on a round trip to decide which arrow to draw. Both column sets agree: only
 * Size and the modification date start descending.
 */
export function sortAscendingByDefault(key) {
  return !(key === 'size' || key === 'changed');
}

/** The raw value a column sorts on — not the display string. */
function sortValue(entry, key) {
  switch (key) {
    case 'name': return entry.name;
    case 'ext': return entry.type === 'dir' ? '' : extensionOf(entry.name).toLowerCase();
    case 'size': return entry.type === 'dir' ? (entry.calculatedSize ?? -1) : (entry.size || 0);
    case 'type': return typeOf(entry);
    case 'changed': return entry.mtime || 0;
    case 'rights': return entry.rights || '';
    case 'attr': return attrOf(entry);
    case 'owner': return entry.owner || '';
    case 'group': return entry.group || '';
    case 'linkTarget': return entry.linkTarget || '';
    default: return '';
  }
}

/**
 * Build the comparator for a sort state. `..` is always first, directories are
 * always before files (WinSCP never interleaves them), and
 * `alwaysSortDirectoriesByName` keeps directories in name order even when the
 * files beside them are sorted by size or date.
 */
export function makeComparator(sort, opts = {}) {
  const natural = opts.natural !== false;
  const dirsByName = !!opts.alwaysSortDirectoriesByName;
  const cmpText = natural ? naturalCompare : plainCompare;
  const dir = sort.ascending ? 1 : -1;
  const key = sort.key || 'name';

  return function compare(a, b) {
    // Two parent entries compare EQUAL. Returning -1 for both orders makes the
    // comparator non-antisymmetric, which is undefined behaviour for
    // Array.prototype.sort and can reorder unrelated rows around it.
    const ap = a.name === '..';
    const bp = b.name === '..';
    if (ap || bp) return ap && bp ? 0 : (ap ? -1 : 1);
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (dirsByName && ad === 0) {
      // The direction still applies here. DirViewInt.pas keeps ConsiderDirection
      // True through the AlwaysSortDirectoriesByName fallback — only the
      // parent-entry and directories-before-files decisions turn it off — and
      // UnixDirView.cpp negates inside the same-kind branch, after the
      // fallback. Returning early left the directories ascending while the
      // files beside them reversed.
      return cmpText(a.name, b.name) * dir;
    }
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    let r;
    if (typeof av === 'number' && typeof bv === 'number') r = av === bv ? 0 : (av < bv ? -1 : 1);
    else r = cmpText(av, bv);
    if (r === 0 && key !== 'name') r = cmpText(a.name, b.name);   // stable tiebreak
    return r * dir;
  };
}

/* ================================================================== */
/* the model                                                           */
/* ================================================================== */

/** Where a panel's layout is persisted, per interface style and side. */
function storageKey(side, interfaceMode) {
  return interfaceMode === 'explorer'
    ? 'scpExplorer.columns'
    : `scpCommander.${side === 'local' ? 'localPanel' : 'remotePanel'}.columns`;
}

/**
 * createColumnModel({ side, interfaceMode, onChange })
 *
 * The model is plain state plus persistence; the header below renders it.
 * `onChange(reason)` fires for anything that should repaint the rows.
 */
export function createColumnModel(opts = {}) {
  const side = opts.side === 'local' ? 'local' : 'remote';
  const interfaceMode = opts.interfaceMode || 'commander';
  const key = storageKey(side, interfaceMode);
  const listeners = new Set();

  let columns = defaultColumns(side);
  let sort = { key: 'name', ascending: true };

  restore();

  function restore() {
    const saved = readPref(key, null);
    if (!saved || typeof saved !== 'object') return;
    if (Array.isArray(saved.columns)) {
      const byKey = new Map(defaultColumns(side).map((c) => [c.key, c]));
      const out = [];
      for (const s of saved.columns) {
        const base = byKey.get(s.key);
        if (!base) continue;                 // a column this port no longer has
        out.push({
          ...base,
          width: clamp(Number(s.width) || base.width, base.min, 900),
          visible: s.visible !== undefined ? !!s.visible : base.visible,
        });
        byKey.delete(s.key);
      }
      // Anything added since the layout was saved keeps its default position.
      for (const c of byKey.values()) out.push({ ...c });
      if (out.length) columns = out;
    }
    if (saved.sort && typeof saved.sort.key === 'string' && columns.some((c) => c.key === saved.sort.key)) {
      sort = { key: saved.sort.key, ascending: saved.sort.ascending !== false };
    }
  }

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      writePref(key, {
        columns: columns.map((c) => ({ key: c.key, width: c.width, visible: c.visible })),
        sort: { ...sort },
      }, `Changed the ${side} panel columns`);
    }, 300);
  }

  function changed(reason) {
    for (const fn of Array.from(listeners)) {
      try { fn(reason, model); } catch (err) { console.error('[panelcolumns] listener failed', err); }
    }
    opts.onChange?.(reason, model);
    bus.emit('panel:columnsChanged', { side, reason });
  }

  const model = {
    side,
    interfaceMode,

    /** Every column, in display order, hidden ones included. */
    get all() { return columns; },
    /** The visible columns, in display order. */
    get visible() { return columns.filter((c) => c.visible); },

    has(k) { return columns.some((c) => c.key === k); },
    get(k) { return columns.find((c) => c.key === k) || null; },
    isVisible(k) { const c = model.get(k); return !!(c && c.visible); },
    label(k) { const c = model.get(k); return c ? t(c.labelKey) : k; },

    /** The name column is the row's identity, so it can never be hidden. */
    canHide(k) { return k !== 'name' && model.isVisible(k) && model.visible.length > 1; },

    setVisible(k, on) {
      const c = model.get(k);
      if (!c) return false;
      if (!on && !model.canHide(k)) {
        announce(`${model.label(k)} cannot be hidden — a panel always shows at least the name column.`);
        return false;
      }
      if (c.visible === !!on) return false;
      c.visible = !!on;
      // Sorting by a hidden column would leave the user no way to change it
      // back, so the sort falls back to the name.
      if (!c.visible && sort.key === k) sort = { key: 'name', ascending: true };
      persist(); changed('visibility');
      announce(`${model.label(k)}: ${on ? t('on') : t('off')}`);
      return true;
    },
    toggle(k) { return model.setVisible(k, !model.isVisible(k)); },

    width(k) { const c = model.get(k); return c ? c.width : 0; },
    setWidth(k, px) {
      const c = model.get(k);
      if (!c) return false;
      const next = clamp(Math.round(px), c.min || 40, 900);
      if (next === c.width) return false;
      c.width = next;
      persist(); changed('width');
      return true;
    },

    /** Move a column to a new index in the display order (drag-reorder). */
    move(k, index) {
      const from = columns.findIndex((c) => c.key === k);
      if (from < 0) return false;
      const to = clamp(index, 0, columns.length - 1);
      if (from === to) return false;
      const [c] = columns.splice(from, 1);
      columns.splice(to, 0, c);
      persist(); changed('order');
      return true;
    },

    /**
     * Fit every visible column to its widest cell. `measure(key)` comes from
     * the panel, which is the only thing that knows the rows and the font.
     */
    autoSize(measure) {
      let any = false;
      for (const c of model.visible) {
        const want = typeof measure === 'function' ? measure(c.key) : null;
        if (!want) continue;
        const next = clamp(Math.round(want), c.min || 40, 900);
        if (next !== c.width) { c.width = next; any = true; }
      }
      if (any) { persist(); changed('width'); }
      announce(t('reset'));
      return any;
    },

    resetLayout() {
      columns = defaultColumns(side);
      sort = { key: 'name', ascending: true };
      persist(); changed('reset');
      announce(`${t('reset')}: ${side === 'local' ? t('localPanel') : t('remotePanel')}`);
      return true;
    },

    /* ---- sorting ---- */
    get sort() { return { ...sort }; },
    setSort(k, ascending) {
      if (!model.has(k)) return false;
      const asc = ascending === undefined
        // Clicking the active column flips the direction; clicking a different
        // one starts it at THAT column's default. TCustomIEListView's
        // SortAscendingByDefault makes Size and Date modified start DESCENDING,
        // which is the point of clicking them — the biggest and the newest
        // belong at the top. Defaulting everything to ascending meant the first
        // click on Size put the empty files first.
        ? (sort.key === k ? !sort.ascending : sortAscendingByDefault(k))
        : !!ascending;
      sort = { key: k, ascending: asc };
      persist(); changed('sort');
      announce(`${model.label(k)}, ${asc ? t('sortAsc') : t('sortDesc')}`);
      return true;
    },
    setAscending(asc) { return model.setSort(sort.key, !!asc); },

    comparator() {
      return makeComparator(sort, {
        natural: readPref('panel.naturalOrderNumericalSorting', true) !== false,
        alwaysSortDirectoriesByName: readPref('panel.alwaysSortDirectoriesByName', false) === true,
      });
    },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    persist,
  };

  return model;
}

/* ================================================================== */
/* the header                                                          */
/* ================================================================== */

/**
 * createColumnHeader(model, opts) -> { element, sync(), destroy() }
 *
 * A real `role="row"` of `columnheader` cells: click to sort, drag the edge to
 * resize, drag the cell to reorder, double-click the edge to auto-size that
 * one column, and a context menu carrying the show/hide, auto-size and reset
 * commands — the same commands.js entries the menu bar uses.
 */
export function createColumnHeader(model, opts = {}) {
  const rowId = uid('colhead');
  const root = h('div', {
    class: 'fp-head', role: 'row', id: rowId,
    'aria-label': model.side === 'local' ? t('localPanel') : t('remotePanel'),
  });
  appearanceTarget(root, `panel-header-${model.side}`, `${model.side === 'local' ? 'Local' : 'Remote'} panel header`);

  let dragging = null;      // { key, startX, startWidth }
  let reordering = null;    // { key, overIndex }
  // The header is ONE tab stop: arrow keys move between the column headers and
  // this remembers which one carries tabindex="0" across a rebuild. Without it
  // only the first column is reachable, and sorting or resizing any other
  // column becomes impossible from the keyboard.
  let rovingKey = null;

  function cellFor(col, index) {
    const active = model.sort.key === col.key;
    const tabbable = rovingKey ? col.key === rovingKey : index === 0;
    const cell = h('div', {
      class: `fp-h${active ? ' is-sorted' : ''}`,
      role: 'columnheader', tabindex: tabbable ? '0' : '-1',
      'data-col': col.key,
      'aria-sort': active ? (model.sort.ascending ? 'ascending' : 'descending') : 'none',
      style: { width: `${col.width}px`, textAlign: col.align },
      draggable: 'true',
      title: t(col.labelKey),
    },
    h('span', { class: 'fp-h-label ellipsis' }, t(col.labelKey)),
    active ? icon(model.sort.ascending ? 'expand_less' : 'expand_more', 14) : null,
    h('span', { class: 'fp-h-grip', 'aria-hidden': 'true' }));

    cell.addEventListener('click', (e) => {
      if (e.target.classList.contains('fp-h-grip')) return;
      model.setSort(col.key);
      opts.onSort?.(model.sort);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); model.setSort(col.key); opts.onSort?.(model.sort); }
      else if (e.key === 'ArrowRight' && e.ctrlKey) { e.preventDefault(); model.setWidth(col.key, col.width + 16); }
      else if (e.key === 'ArrowLeft' && e.ctrlKey) { e.preventDefault(); model.setWidth(col.key, col.width - 16); }
    });

    const grip = cell.querySelector('.fp-h-grip');
    grip.addEventListener('pointerdown', (e) => {
      if (readPref('window.lockToolbars', false) === true) return;
      e.preventDefault(); e.stopPropagation();
      dragging = { key: col.key, startX: e.clientX, startWidth: col.width };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.key !== col.key) return;
      model.setWidth(col.key, dragging.startWidth + (e.clientX - dragging.startX));
    });
    grip.addEventListener('pointerup', () => { dragging = null; });
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const want = opts.measure ? opts.measure(col.key) : null;
      if (want) model.setWidth(col.key, want);
    });

    // Reordering: dragging the header cell itself, not its resize grip.
    cell.addEventListener('dragstart', (e) => {
      if (dragging) { e.preventDefault(); return; }
      reordering = { key: col.key };
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', col.key); } catch { /* some hosts refuse */ }
    });
    cell.addEventListener('dragover', (e) => {
      if (!reordering) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('is-droptarget');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('is-droptarget'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('is-droptarget');
      if (!reordering) return;
      const target = model.all.findIndex((c) => c.key === col.key);
      model.move(reordering.key, target);
      reordering = null;
    });
    cell.addEventListener('dragend', () => { reordering = null; root.querySelectorAll('.is-droptarget').forEach((n) => n.classList.remove('is-droptarget')); });

    return cell;
  }

  function sync() {
    while (root.firstChild) root.removeChild(root.firstChild);
    if (rovingKey && !model.visible.some((c) => c.key === rovingKey)) rovingKey = null;
    model.visible.forEach((col, i) => root.appendChild(cellFor(col, i)));
  }

  /** Roving focus across the header row — one tab stop, arrows to move. */
  function moveFocus(delta, absolute) {
    const cells = [...root.querySelectorAll('.fp-h')];
    if (!cells.length) return;
    const from = Math.max(0, cells.findIndex((c) => c.tabIndex === 0));
    const to = absolute === 'first' ? 0
      : absolute === 'last' ? cells.length - 1
        : Math.min(cells.length - 1, Math.max(0, from + delta));
    cells.forEach((c) => { c.tabIndex = -1; });
    cells[to].tabIndex = 0;
    rovingKey = cells[to].dataset.col;
    cells[to].focus();
  }

  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;   // Ctrl+Arrow resizes
    if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(-1); }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(0, 'first'); }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(0, 'last'); }
  });

  /* ---- the header's own context menu, straight from commands.js ---- */
  const COLUMN_ACTION = {
    local: {
      name: 'ShowHideLocalNameColumnAction2', size: 'ShowHideLocalSizeColumnAction2',
      type: 'ShowHideLocalTypeColumnAction2', changed: 'ShowHideLocalChangedColumnAction3',
      attr: 'ShowHideLocalAttrColumnAction2', ext: 'ShowHideLocalExtColumnAction2',
    },
    remote: {
      name: 'ShowHideRemoteNameColumnAction2', size: 'ShowHideRemoteSizeColumnAction2',
      type: 'ShowHideRemoteTypeColumnAction2', changed: 'ShowHideRemoteChangedColumnAction3',
      rights: 'ShowHideRemoteRightsColumnAction2', owner: 'ShowHideRemoteOwnerColumnAction2',
      group: 'ShowHideRemoteGroupColumnAction2', linkTarget: 'ShowHideRemoteLinkTargetColumnAction2',
      ext: 'ShowHideRemoteExtColumnAction2',
    },
  }[model.side];

  const AUTOSIZE = model.side === 'local' ? 'AutoSizeLocalColumnsAction' : 'AutoSizeRemoteColumnsAction';
  const RESET = model.side === 'local' ? 'ResetLayoutLocalColumnsAction' : 'ResetLayoutRemoteColumnsAction';

  registerContextMenu(root, (ctx) => {
    const col = ctx.target?.closest?.('.fp-h')?.dataset.col || null;
    const over = { side: model.side, panel: opts.panel, column: col };
    const items = [];
    if (col) {
      items.push(
        { label: actionLabel('SortColumnAscendingAction'), icon: 'expand_less', checked: model.sort.key === col && model.sort.ascending, radio: true, onSelect: () => runAction('SortColumnAscendingAction', over) },
        { label: actionLabel('SortColumnDescendingAction'), icon: 'expand_more', checked: model.sort.key === col && !model.sort.ascending, radio: true, onSelect: () => runAction('SortColumnDescendingAction', over) },
        SEPARATOR,
        {
          label: actionLabel('HideColumnAction'), icon: 'remove',
          disabled: !model.canHide(col),
          onSelect: () => runAction('HideColumnAction', over),
        },
        SEPARATOR,
      );
    }
    for (const c of model.all) {
      const action = COLUMN_ACTION[c.key];
      if (!action) continue;
      const st = commandState(action, over);
      items.push({
        label: t(c.labelKey),
        checked: model.isVisible(c.key),
        disabled: !st.enabled && !model.isVisible(c.key),
        keepOpen: true,
        onSelect: () => { runAction(action, over); sync(); },
      });
    }
    items.push(SEPARATOR,
      { label: actionLabel(AUTOSIZE), icon: 'unfold_more', shortcut: 'Ctrl+Num +', onSelect: () => { model.autoSize(opts.measure); sync(); } },
      { label: actionLabel(RESET), icon: 'restart_alt', onSelect: () => { model.resetLayout(); sync(); } });
    return items;
  });

  const off = model.subscribe(() => sync());
  sync();

  return {
    element: root,
    sync,
    destroy() { off(); root.remove(); },
  };
}

/* ================================================================== */
/* measuring                                                           */
/* ================================================================== */

let measureCanvas = null;

/**
 * Text width in the panel's own font, for auto-size. A canvas is used rather
 * than a hidden DOM node so measuring 100 000 rows costs no layout.
 */
export function measureText(text, font) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  ctx.font = font || '13px system-ui';
  return ctx.measureText(String(text ?? '')).width;
}

/**
 * A measure() for createColumnHeader/autoSize: the widest cell in the column
 * plus padding, capped so one absurd file name cannot push a column off screen.
 */
export function makeMeasurer(getEntries, getFont, opts = {}) {
  const pad = opts.padding ?? 26;
  const cap = opts.max ?? 480;
  const side = opts.side === 'local' ? 'local' : 'remote';
  return function measure(key) {
    const font = getFont();
    const entries = getEntries();
    // Commander has different local/remote column sets. Using the remote
    // defaults here made local-only columns (notably Attr) auto-size against
    // the wrong header, and made a future side-specific column silently fall
    // back to Name. Keep the measurement tied to the panel that owns it.
    let widest = measureText(t(defaultColumns(side).find((c) => c.key === key)?.labelKey || 'colName'), font) + 18;
    // Sampling keeps auto-size instant on a very large directory; the first
    // 4 000 rows determine the width, and the column can still be dragged.
    const limit = Math.min(entries.length, 4000);
    for (let i = 0; i < limit; i += 1) {
      const w = measureText(cellText(entries[i], key), font);
      if (w > widest) widest = w;
    }
    return Math.min(Math.ceil(widest) + pad, cap);
  };
}
