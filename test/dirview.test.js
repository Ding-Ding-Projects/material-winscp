// dirview.test.js — the directory-view model and the path edit.
//
// Covers design/main/dirview.js and design/main/pathedit.js, the port of
// source/components/ and the filemng/my packages behind it. The assertions are
// written against WinSCP's own behaviour, including the edge cases that are
// easy to get wrong and expensive when you do:
//
//   * a descending sort must not bury ".." or interleave directories
//   * "always sort directories by name" must not leak into the file order
//   * the parent directory must never become selectable
//   * a focused row is not a selected row, and the commands must agree
//   * an exclude-only mask must not select every file
//   * a mask delimiter inside a name must survive being composed
//   * the back/forward history must be reversible

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dv = require('../design/main/dirview');
const pe = require('../design/main/pathedit');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** An entry() shaped object, which is what the adapters produce. */
function file(name, extra) {
  return {
    name,
    type: 'file',
    size: 0,
    mtime: 0,
    rights: '',
    owner: '',
    group: '',
    linkTarget: '',
    isSymlink: false,
    hidden: name.startsWith('.'),
    readOnly: false,
    raw: null,
    ...(extra || {}),
  };
}

test('ExecuteFile resolves directory entry and open actions', () => {
  const directory = file('reports', { type: 'dir' });
  const regular = file('notes.txt', { type: 'file' });

  assert.deepStrictEqual(dv.resolveExecuteFile(directory, { action: 'changeDir' }), {
    action: 'changeDir', item: directory,
  });
  assert.deepStrictEqual(dv.resolveExecuteFile(regular, { action: 'changeDir' }), {
    action: 'open', item: regular,
  });
  assert.deepStrictEqual(dv.resolveExecuteFile(directory, { action: 'open' }), {
    action: 'open', item: directory,
  });
  assert.deepStrictEqual(dv.resolveExecuteFile(null), { action: 'noop', item: null });
});

function dir(name, extra) {
  return file(name, { type: 'dir', ...(extra || {}) });
}

/**
 * protocols/base.js derives `hidden` from a leading dot, which would mark ".."
 * hidden; WinSCP's IsUnixHiddenFile checks IsRealFile first, so it does not.
 * The panel model is expected to agree with WinSCP, and there is a test for it.
 */
function parent() {
  return dir('..');
}

function names(items) {
  return items.map((i) => i.name);
}

/* ================================================================== */
/* columns                                                             */
/* ================================================================== */

test('the column sets are WinSCP\'s own, in WinSCP\'s order', () => {
  assert.deepStrictEqual(dv.LOCAL_COLUMNS.map((c) => c.key),
    ['name', 'size', 'type', 'changed', 'attr', 'ext']);
  assert.deepStrictEqual(dv.REMOTE_COLUMNS.map((c) => c.key),
    ['name', 'size', 'changed', 'rights', 'owner', 'group', 'ext', 'linkTarget', 'type']);

  // DefaultDirViewWidths / DefaultUnixDirViewWidths.
  assert.strictEqual(dv.LOCAL_COLUMNS[0].width, 150);
  assert.strictEqual(dv.LOCAL_COLUMNS[3].width, 130);
  assert.strictEqual(dv.REMOTE_COLUMNS[3].width, 100);

  // Size is the only right-aligned column on either side.
  assert.strictEqual(dv.LOCAL_COLUMNS.filter((c) => c.align === 'right').length, 1);
  assert.strictEqual(dv.REMOTE_COLUMNS.filter((c) => c.align === 'right').length, 1);
  assert.strictEqual(dv.REMOTE_COLUMNS[1].align, 'right');
});

test('Ext starts hidden on both sides, and so do the remote Link target and Type', () => {
  const local = dv.columnsFor('local');
  const remote = dv.columnsFor('remote');
  assert.strictEqual(local.find((c) => c.key === 'ext').visible, false);
  assert.strictEqual(remote.find((c) => c.key === 'ext').visible, false);
  assert.strictEqual(remote.find((c) => c.key === 'linkTarget').visible, false);
  assert.strictEqual(remote.find((c) => c.key === 'type').visible, false);
  // Everything else is visible out of the box.
  assert.strictEqual(remote.filter((c) => c.visible).length, 6);
  assert.strictEqual(local.filter((c) => c.visible).length, 5);
});

test('columnsFor returns a fresh copy so a panel cannot mutate the defaults', () => {
  const a = dv.columnsFor('remote');
  a[0].width = 999;
  assert.strictEqual(dv.columnsFor('remote')[0].width, 150);
  assert.strictEqual(dv.REMOTE_COLUMNS[0].width, 150);
});

test('Size and Date modified sort DESCENDING on the first click, everything else ascending', () => {
  for (const side of ['local', 'remote']) {
    assert.strictEqual(dv.sortAscendingByDefault(side, 'size'), false);
    assert.strictEqual(dv.sortAscendingByDefault(side, 'changed'), false);
    assert.strictEqual(dv.sortAscendingByDefault(side, 'name'), true);
    assert.strictEqual(dv.sortAscendingByDefault(side, 'ext'), true);
  }
  assert.strictEqual(dv.sortAscendingByDefault('local', 'attr'), true);
  assert.strictEqual(dv.sortAscendingByDefault('remote', 'rights'), true);
});

/* ================================================================== */
/* sorting                                                             */
/* ================================================================== */

test('the parent directory is first and directories precede files, ascending', () => {
  const items = [file('b.txt'), dir('zdir'), parent(), file('a.txt'), dir('adir')];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'name', sortAscending: true })),
    ['..', 'adir', 'zdir', 'a.txt', 'b.txt']);
});

test('a DESCENDING sort still keeps ".." first and directories before files', () => {
  // This is the one that costs a user their way out of a directory if it is
  // wrong: the negation lives inside the same-kind branch in the C++.
  const items = [file('b.txt'), dir('zdir'), parent(), file('a.txt'), dir('adir')];
  const sorted = dv.sortItems(items, { side: 'remote', sortColumn: 'name', sortAscending: false });
  assert.strictEqual(sorted[0].name, '..');
  assert.deepStrictEqual(names(sorted), ['..', 'zdir', 'adir', 'b.txt', 'a.txt']);
});

test('size sorts numerically, not as text, and directories keep their block', () => {
  const items = [file('a', { size: 9 }), file('b', { size: 100 }), dir('d'), file('c', { size: 20 })];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'size', sortAscending: true })),
    ['d', 'a', 'c', 'b']);
});

test('a directory\'s calculated size is what the size sort uses once it exists', () => {
  const items = [dir('big', { calculatedSize: 5000 }), dir('small', { calculatedSize: 10 }), dir('unknown')];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'size', sortAscending: true })),
    ['unknown', 'small', 'big']);
});

test('alwaysSortDirectoriesByName leaves the FILES sorted by the column', () => {
  const items = [
    dir('zdir', { calculatedSize: 1 }), dir('adir', { calculatedSize: 9999 }),
    file('big', { size: 900 }), file('small', { size: 1 }),
  ];
  const sorted = dv.sortItems(items, {
    side: 'remote', sortColumn: 'size', sortAscending: true, alwaysSortDirectoriesByName: true,
  });
  // The directories ignore their sizes; the files do not.
  assert.deepStrictEqual(names(sorted), ['adir', 'zdir', 'small', 'big']);
});

test('natural numeric order puts file9 before file10, and plain order does not', () => {
  const items = [file('file10'), file('file9'), file('file1')];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'name', naturalOrderNumericalSorting: true })),
    ['file1', 'file9', 'file10']);
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'name', naturalOrderNumericalSorting: false })),
    ['file1', 'file10', 'file9']);
});

test('every column falls back to the name, so the order is total and stable', () => {
  const items = [file('c', { mtime: 5 }), file('a', { mtime: 5 }), file('b', { mtime: 5 })];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'changed', sortAscending: true })),
    ['a', 'b', 'c']);
});

test('the Ext column sorts directories by name, because a directory has no extension', () => {
  const items = [dir('zdir'), dir('adir'), file('b.aaa'), file('a.zzz')];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'ext', sortAscending: true })),
    ['adir', 'zdir', 'b.aaa', 'a.zzz']);
});

test('the local Ext sort keys on "<ext> <name>", so same-extension files are name-ordered', () => {
  const items = [file('z.txt'), file('a.txt'), file('m.bin')];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'local', sortColumn: 'ext', sortAscending: true })),
    ['m.bin', 'a.txt', 'z.txt']);
});

test('the Type column breaks a tie on the extension, but only for files', () => {
  const items = [file('b.zzz'), file('a.zzz')];
  // Same type name (both "ZZZ File"), same extension: falls back to the name.
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'type', sortAscending: true })),
    ['a.zzz', 'b.zzz']);
});

test('the owner column follows TRemoteToken::Compare — named before unnamed, id before neither', () => {
  const named = { name: 'root' };
  const idOnly = { name: '', idValid: true, id: 1000 };
  const idOnly2 = { name: '', idValid: true, id: 2000 };
  const nothing = { name: '' };
  assert.ok(dv.compareToken(named, idOnly) < 0);
  assert.ok(dv.compareToken(idOnly, nothing) < 0);
  assert.strictEqual(dv.compareToken(idOnly, idOnly2) < 0, true);
  assert.strictEqual(dv.compareToken(nothing, nothing), 0);
  // Plain strings, which is what the adapters produce, take the name path.
  assert.ok(dv.compareToken('alice', 'bob') < 0);
  assert.strictEqual(dv.compareToken('Alice', 'alice'), 0);   // AnsiCompareText
});

test('rights sort case-insensitively as text, never naturally', () => {
  const items = [file('a', { rights: 'rwxr-xr-x' }), file('b', { rights: 'rw-r--r--' })];
  assert.deepStrictEqual(
    names(dv.sortItems(items, { side: 'remote', sortColumn: 'rights', sortAscending: true })),
    ['b', 'a']);
});

test('SortState.sortBy flips the direction only on the column already sorted', () => {
  const state = new dv.SortState('remote');
  assert.strictEqual(state.column, 'name');
  assert.strictEqual(state.ascending, true);

  assert.strictEqual(state.sortBy('name'), true);
  assert.strictEqual(state.ascending, false);           // flipped

  assert.strictEqual(state.sortBy('size'), true);
  assert.strictEqual(state.column, 'size');
  assert.strictEqual(state.ascending, false);           // size's default

  assert.strictEqual(state.sortBy('size'), true);
  assert.strictEqual(state.ascending, true);            // flipped back

  // A column the side does not have is refused rather than silently accepted.
  assert.strictEqual(state.sortBy('attr'), false);
  assert.strictEqual(state.column, 'size');
});

test('setSort reports no change when nothing changed, so nothing re-sorts', () => {
  const state = new dv.SortState('local', 'name', true);
  assert.strictEqual(state.setSort('name', true), false);
  assert.strictEqual(state.setSort('name', false), true);
});

test('SortStr round-trips through the "index;ascending" format WinSCP persists', () => {
  const state = new dv.SortState('remote');
  state.setSort('group', false);
  assert.strictEqual(state.sortStr, '5;0');

  const restored = new dv.SortState('remote');
  restored.sortStr = '5;0';
  assert.strictEqual(restored.column, 'group');
  assert.strictEqual(restored.ascending, false);

  const local = new dv.SortState('local');
  local.sortStr = '4;1';
  assert.strictEqual(local.column, 'attr');
  assert.strictEqual(local.ascending, true);
});

test('a SortStr naming a column this build does not have is ignored, not clamped', () => {
  const state = new dv.SortState('local', 'size', false);
  state.sortStr = '99;1';
  assert.strictEqual(state.column, 'size');    // unchanged
  assert.strictEqual(state.ascending, true);   // the direction still applies
  state.sortStr = 'rubbish';
  assert.strictEqual(state.column, 'size');
});

/* ================================================================== */
/* loading a listing                                                   */
/* ================================================================== */

test('hidden files are counted as hidden and never reach the mask', () => {
  const files = [parent(), file('.bashrc'), file('a.txt'), file('b.bin')];
  const view = dv.buildView({ files, showHiddenFiles: false, mask: '*.txt' });
  assert.deepStrictEqual(names(view.items), ['..', 'a.txt']);
  assert.strictEqual(view.hiddenCount, 1);
  assert.strictEqual(view.filteredCount, 1);   // b.bin, not .bashrc
  assert.strictEqual(view.hasParentDir, true);
});

test('a mask never filters out the parent directory', () => {
  const view = dv.buildView({ files: [parent(), file('a.bin')], mask: '*.txt' });
  assert.deepStrictEqual(names(view.items), ['..']);
  assert.strictEqual(view.filteredCount, 1);
});

test('inaccessible directories are hidden separately from hidden files', () => {
  const files = [dir('ok'), dir('locked', { isInaccesibleDirectory: true })];
  const shown = dv.buildView({ files, showInaccesibleDirectories: true });
  assert.strictEqual(shown.items.length, 2);
  const hidden = dv.buildView({ files, showInaccesibleDirectories: false });
  assert.deepStrictEqual(names(hidden.items), ['ok']);
  assert.strictEqual(hidden.hiddenCount, 1);
  assert.strictEqual(hidden.filteredCount, 0);
});

test('filesSize totals only what is visible', () => {
  const files = [file('a', { size: 10 }), file('.b', { size: 100 }), file('c', { size: 5 })];
  assert.strictEqual(dv.buildView({ files, showHiddenFiles: true }).filesSize, 115);
  assert.strictEqual(dv.buildView({ files, showHiddenFiles: false }).filesSize, 15);
});

test('an unparseable mask filters nothing rather than blanking the panel', () => {
  const view = dv.buildView({ files: [file('a.txt'), file('b.bin')], mask: '[' });
  assert.strictEqual(view.items.length, 2);
  assert.strictEqual(view.filteredCount, 0);
});

test('buildView sorts when a sort is supplied and preserves order when it is not', () => {
  const files = [file('b'), file('a')];
  assert.deepStrictEqual(names(dv.buildView({ files }).items), ['b', 'a']);
  assert.deepStrictEqual(
    names(dv.buildView({ files, sort: { side: 'remote', sortColumn: 'name' } }).items), ['a', 'b']);
});

test('statusFileInfo compares by value, so the status bar only repaints on a real change', () => {
  const view = dv.buildView({ files: [file('a', { size: 3 })] });
  const a = dv.statusFileInfo(view, { selectedCount: 0, selectedSize: 0 });
  const b = dv.statusFileInfo(view, { selectedCount: 0, selectedSize: 0 });
  assert.ok(dv.sameStatusFileInfo(a, b));
  assert.ok(!dv.sameStatusFileInfo(a, dv.statusFileInfo(view, { selectedCount: 1, selectedSize: 3 })));
});

/* ================================================================== */
/* the mask filter and select-by-mask                                  */
/* ================================================================== */

test('an empty filter matches everything', () => {
  assert.strictEqual(dv.itemMatchesFilter(file('anything'), dv.defaultFileFilter()), true);
});

test('a directory only matches a file mask when the filter includes directories', () => {
  const filter = { masks: '*.txt', directories: false };
  assert.strictEqual(dv.itemMatchesFilter(dir('notes.txt'), filter), false);
  assert.strictEqual(dv.itemMatchesFilter(dir('notes.txt'), { ...filter, directories: true }), true);
  assert.strictEqual(dv.itemMatchesFilter(file('notes.txt'), filter), true);
});

test('the implicit-match refusal is what stops "*.txt" selecting every directory', () => {
  // A file mask says nothing about directories, so every directory is an
  // IMPLICIT match. Loading the panel allows that (directories stay visible
  // under a file filter); selecting by mask does not (Select "*.txt" must not
  // select every folder).
  assert.strictEqual(dv.defaultMatchMask('anything', true, 0, 0, '*.txt', true), true);
  assert.strictEqual(dv.defaultMatchMask('anything', true, 0, 0, '*.txt', false), false);
  assert.strictEqual(dv.buildView({ files: [dir('sub'), file('a.bin')], mask: '*.txt' }).items.length, 1);
});

test('an exclude-only mask is an EXPLICIT enough match to select by, exclude list being non-empty', () => {
  // DoMatches only reports an implicit match when the exclude list is empty
  // too, so "|*.bak" selects everything that is not a .bak — which is what a
  // user asking for "not .bak" means.
  assert.strictEqual(dv.defaultMatchMask('keep.txt', false, 0, 0, '|*.bak', false), true);
  assert.strictEqual(dv.defaultMatchMask('old.bak', false, 0, 0, '|*.bak', false), false);
  assert.strictEqual(dv.itemMatchesFilter(file('keep.txt'), { masks: '|*.bak', directories: false }), true);
  assert.strictEqual(dv.itemMatchesFilter(file('old.bak'), { masks: '|*.bak', directories: false }), false);
});

test('sameExtensionFilter uses "*." for a file with no extension, not "*"', () => {
  assert.deepStrictEqual(dv.sameExtensionFilter('readme.txt'), { masks: '*.txt', directories: false });
  assert.deepStrictEqual(dv.sameExtensionFilter('Makefile'), { masks: '*.', directories: false });
  assert.deepStrictEqual(dv.sameExtensionFilter('/etc/hosts', true), { masks: '*.', directories: false });
});

test('MaskFilter reloads only when the effective mask actually changed', () => {
  const filter = new dv.MaskFilter('');
  assert.deepStrictEqual(filter.setMask('*.txt'), { changed: true, reload: true });
  assert.deepStrictEqual(filter.setMask('*.txt'), { changed: false, reload: false });

  // A restored state announces its mask, which becomes effective immediately;
  // applying the same mask afterwards must not re-read the directory.
  const restored = new dv.MaskFilter('');
  restored.announce({ mask: '*.log' });
  assert.deepStrictEqual(restored.setMask('*.log'), { changed: true, reload: false });
});

test('the path label hides the mask when there is no path to show it beside', () => {
  const filter = new dv.MaskFilter('*.txt');
  assert.deepStrictEqual(filter.pathLabel('/var/log'), { caption: '/var/log', mask: '*.txt' });
  assert.deepStrictEqual(filter.pathLabel(''), { caption: '', mask: '' });
});

/* ================================================================== */
/* the selection model                                                 */
/* ================================================================== */

function model(extra) {
  return new dv.SelectionModel({
    items: [parent(), file('a'), file('b'), file('c'), dir('d')],
    side: 'remote',
    ...(extra || {}),
  });
}

test('the parent directory can never be selected', () => {
  const m = model();
  assert.strictEqual(m.setSelected(0, true), false);
  m.selectAll(dv.SELECT_MODE.All);
  assert.deepStrictEqual(names(m.selectedItems()), ['a', 'b', 'c', 'd']);
  assert.strictEqual(m.selCount, 4);
});

test('nothing is selectable while the view is loading', () => {
  const m = model();
  assert.strictEqual(m.setSelected(1, true, { loading: true }), false);
  assert.strictEqual(m.selCount, 0);
});

test('a focused row is not a selected row', () => {
  const m = model();
  m.focusedIndex = 2;
  assert.strictEqual(m.selCount, 0);
  assert.strictEqual(m.isSelected(2), false);
  // …but it is what a command with no selection acts on.
  assert.strictEqual(m.markedCount, 1);
  assert.strictEqual(m.markedFile.name, 'b');
});

test('with NortonLike off an empty selection really means nothing', () => {
  const m = model({ nortonLike: dv.NORTON_LIKE.Off });
  m.focusedIndex = 2;
  assert.strictEqual(m.markedCount, 0);
  assert.strictEqual(m.markedFile, null);
});

test('operateOnFocusedFile: the focused row wins when it is outside the selection', () => {
  const m = model();
  m.focusedIndex = 1;               // 'a'
  m.setSelected(2, true);           // 'b' selected, 'a' focused
  assert.strictEqual(m.operateOnFocusedFile(true, false), true);
  assert.deepStrictEqual(m.createFileList({ focused: true }), ['a']);
  // The plain variant still uses the selection.
  assert.strictEqual(m.operateOnFocusedFile(false, false), false);
  assert.deepStrictEqual(m.createFileList({ focused: false }), ['b']);
});

test('operateOnFocusedFile: a focused row INSIDE the selection does not override it', () => {
  const m = model();
  m.focusedIndex = 2;
  m.setSelected(2, true);
  m.setSelected(3, true);
  assert.strictEqual(m.operateOnFocusedFile(true, false), false);
  assert.deepStrictEqual(m.createFileList({ focused: true }), ['b', 'c']);
});

test('createFocusedFileList always means the focused row, whatever is selected', () => {
  const m = model();
  m.focusedIndex = 1;
  m.setSelected(2, true);
  m.setSelected(3, true);
  assert.deepStrictEqual(m.createFocusedFileList(), ['a']);
});

test('createFileList can render full paths through the caller\'s own joiner', () => {
  const m = model();
  m.setSelected(1, true);
  assert.deepStrictEqual(m.createFileList({ fullPath: (i) => `/home/${i.name}` }), ['/home/a']);
});

test('anyFileSelected refuses a directory when the command is files-only', () => {
  const m = model();
  m.focusedIndex = 4;                       // the directory
  assert.strictEqual(m.anyFileSelected({ filesOnly: false }), true);
  assert.strictEqual(m.anyFileSelected({ filesOnly: true }), false);
  m.focusedIndex = 0;                       // '..'
  assert.strictEqual(m.anyFileSelected({ filesOnly: false }), false);
});

test('anyFileSelected with focusedFileOnlyWhenFocused refuses an unfocused panel', () => {
  const m = model();
  m.focusedIndex = 1;
  assert.strictEqual(
    m.anyFileSelected({ focusedFileOnlyWhenFocused: true, panelFocused: true }), true);
  assert.strictEqual(
    m.anyFileSelected({ focusedFileOnlyWhenFocused: true, panelFocused: false }), false);
});

test('anyFileSelected counts selected FILES for a files-only command', () => {
  const m = model();
  m.setSelected(4, true);                   // only the directory
  assert.strictEqual(m.anyFileSelected({ filesOnly: true }), false);
  m.setSelected(1, true);                   // now a file too
  assert.strictEqual(m.anyFileSelected({ filesOnly: true }), true);
});

test('closestUnselected finds the row below, then above, then gives up honestly', () => {
  const m = model();
  m.setSelected(1, true);
  m.setSelected(2, true);
  assert.strictEqual(m.closestUnselected(1), 3);       // 'c', below the block

  const all = model();
  all.selectAll(dv.SELECT_MODE.All);
  all.focusedIndex = 2;
  // Everything selectable is selected; the parent is not selected, so it is the
  // one row left to stand on.
  assert.strictEqual(all.closestUnselected(2), 0);
});

test('closestUnselected returns null when every row is going to be consumed', () => {
  // A panel at the root has no '..' to fall back on, so selecting everything
  // really does leave nowhere for the cursor to stand. WinSCP returns nil here
  // and the caller must cope; returning an out-of-range index instead would
  // focus a row that does not exist.
  const m = new dv.SelectionModel({
    items: [{ name: 'a', type: 'file' }, { name: 'b', type: 'file' }],
  });
  m.selectAll(dv.SELECT_MODE.All);
  assert.strictEqual(m.closestUnselected(0), null);
  assert.strictEqual(m.closestUnselected(1), null);
});

test('closestUnselected returns the row itself when nothing is going to be consumed', () => {
  const m = model({ nortonLike: dv.NORTON_LIKE.Off });
  m.focusedIndex = 2;
  assert.strictEqual(m.closestUnselected(2), 2);
});

test('selectAll invert leaves the parent directory alone', () => {
  const m = model();
  m.setSelected(1, true);
  m.selectAll(dv.SELECT_MODE.Invert);
  assert.deepStrictEqual(names(m.selectedItems()), ['b', 'c', 'd']);
});

test('selectAll(none, exclude) keeps the excluded row, which is what a plain click does', () => {
  const m = model();
  m.selectAll(dv.SELECT_MODE.All);
  m.selectAll(dv.SELECT_MODE.None, 2);
  assert.deepStrictEqual(names(m.selectedItems()), ['b']);
});

test('selectCurrentItem toggles the focused row and steps down', () => {
  const m = model();
  m.focusedIndex = 1;
  assert.strictEqual(m.selectCurrentItem(true), true);
  assert.strictEqual(m.isSelected(1), true);
  assert.strictEqual(m.focusedIndex, 2);
  m.focusedIndex = 1;
  m.selectCurrentItem(false);
  assert.strictEqual(m.isSelected(1), false);
});

test('selectFiles selects by mask and unselects by the same mask', () => {
  const m = new dv.SelectionModel({
    items: [parent(), file('a.txt'), file('b.bin'), file('c.txt')],
    side: 'remote',
  });
  m.selectFiles({ masks: '*.txt', directories: false }, true);
  assert.deepStrictEqual(names(m.selectedItems()), ['a.txt', 'c.txt']);
  m.selectFiles({ masks: '*.txt', directories: false }, false);
  assert.strictEqual(m.selCount, 0);
});

test('findFileIndex is case sensitive on the remote side and not on the local side', () => {
  const remote = new dv.SelectionModel({ items: [file('README')], side: 'remote' });
  assert.strictEqual(remote.findFileIndex('README'), 0);
  assert.strictEqual(remote.findFileIndex('readme'), -1);

  const local = new dv.SelectionModel({ items: [file('README')], side: 'local' });
  assert.strictEqual(local.findFileIndex('readme'), 0);
});

test('findFileIndex refuses an empty name rather than matching the first row', () => {
  const m = model();
  assert.strictEqual(m.findFileIndex(''), -1);
  assert.strictEqual(m.findFileIndex(null), -1);
});

test('save/restoreSelection lands the cursor on a row that survived the delete', () => {
  const m = model();
  m.focusedIndex = 2;                 // 'b'
  m.setSelected(2, true);
  m.setSelected(3, true);
  m.saveSelection();
  assert.strictEqual(m.selectionSaved, true);

  // 'b' and 'c' are gone.
  m.setItems([parent(), file('a'), dir('d')]);
  m.focusedIndex = -1;
  m.restoreSelection();
  assert.strictEqual(m.focusedItem.name, 'd');   // the closest unselected row
  assert.strictEqual(m.selectionSaved, false);
});

test('restoreSelection leaves the cursor alone when the focused row survived', () => {
  const m = model();
  m.focusedIndex = 1;                 // 'a', not selected
  m.setSelected(2, true);
  m.saveSelection();
  m.setItems([parent(), file('a'), file('c'), dir('d')]);
  m.focusedIndex = 1;                 // still on 'a'
  m.restoreSelection();
  assert.strictEqual(m.focusedItem.name, 'a');
});

test('save/restoreSelectedNames survives a reload that replaces every object', () => {
  const m = model();
  m.setSelected(1, true);
  m.setSelected(3, true);
  assert.deepStrictEqual(m.saveSelectedNames(), ['a', 'c']);
  assert.strictEqual(m.selectedNamesSaved, true);

  m.setItems([parent(), file('a'), file('b'), file('c')]);
  assert.strictEqual(m.selCount, 0);
  assert.strictEqual(m.restoreSelectedNames(), 2);
  assert.deepStrictEqual(names(m.selectedItems()), ['a', 'c']);
});

test('restoreSelectedNames UNSELECTS anything not in the saved list', () => {
  const m = model();
  m.setSelected(1, true);
  m.saveSelectedNames();
  m.setSelected(2, true);
  m.restoreSelectedNames();
  assert.deepStrictEqual(names(m.selectedItems()), ['a']);
});

test('focusSomething focuses the first row of a non-empty panel and nothing of an empty one', () => {
  const m = model();
  assert.strictEqual(m.focusSomething(), 0);
  const empty = new dv.SelectionModel({ items: [] });
  assert.strictEqual(empty.focusSomething(), -1);
});

test('markedSize and selectedSize follow the focused/selected decision', () => {
  const m = new dv.SelectionModel({
    items: [parent(), file('a', { size: 10 }), file('b', { size: 20 })],
    side: 'remote',
  });
  m.focusedIndex = 1;
  assert.strictEqual(m.markedSize(), 10);       // nothing selected: the focused row
  m.setSelected(2, true);
  assert.strictEqual(m.selectedSize(), 20);
  assert.strictEqual(m.markedSize(), 20);
});

test('the Norton mouse rules never disturb an existing selection with a plain click', () => {
  const m = model();
  const rules = m.mouseDownRules({ ctrl: false, shift: false }, false);
  assert.strictEqual(rules.dontSelect, true);
  assert.strictEqual(rules.dontUnselect, true);
  assert.strictEqual(rules.clearSelection, false);   // nlOn clears on mouse UP

  const withCtrl = m.mouseDownRules({ ctrl: true, shift: false }, false);
  assert.strictEqual(withCtrl.dontSelect, false);
  assert.strictEqual(withCtrl.dontUnselect, false);
});

test('Explorer-style (nlKeyboard) clears the selection when clicking outside it', () => {
  const m = model({ nortonLike: dv.NORTON_LIKE.Keyboard });
  assert.strictEqual(m.mouseDownRules({ ctrl: false, shift: false }, false).clearSelection, true);
  assert.strictEqual(m.mouseDownRules({ ctrl: false, shift: false }, true).clearSelection, false);
});

test('the keyboard rules protect an EXPLICIT selection in nlKeyboard mode', () => {
  const m = model({ nortonLike: dv.NORTON_LIKE.Keyboard });
  // A selection built by clicking is implicit and may be replaced.
  m.clickCollapse(1);
  assert.strictEqual(m.keyDownRules({ shift: false }).dontUnselect, false);
  // One built with Insert is explicit and may not.
  m.setSelected(2, true);
  assert.strictEqual(m.anyAndAllSelectedImplicitly, false);
  assert.strictEqual(m.keyDownRules({ shift: false }).dontUnselect, true);
});

test('Shift+navigation is allowed to extend the selection in every mode', () => {
  for (const mode of [dv.NORTON_LIKE.On, dv.NORTON_LIKE.Keyboard, dv.NORTON_LIKE.Off]) {
    const m = model({ nortonLike: mode });
    assert.strictEqual(m.keyDownRules({ shift: true }).dontSelect, false);
  }
});

/* ================================================================== */
/* renaming in place                                                   */
/* ================================================================== */

test('the parent directory can never be renamed', () => {
  assert.strictEqual(dv.canEdit(parent(), {}), false);
  assert.strictEqual(dv.canEdit(file('a'), {}), true);
});

test('rename is refused while loading, on a read-only panel and in the recycle bin', () => {
  const item = file('a');
  assert.strictEqual(dv.canEdit(item, { loading: true }), false);
  assert.strictEqual(dv.canEdit(item, { readOnly: true }), false);
  assert.strictEqual(dv.canEdit(item, { isRecycleBin: true }), false);
});

test('rename is refused when the protocol cannot rename, rather than promising one', () => {
  assert.strictEqual(dv.canEdit(file('a'), { renameCapable: false }), false);
  assert.strictEqual(dv.canEdit(file('a'), { renameCapable: true }), true);
});

test('the invalid character sets are per side, and the DOS one is the full list', () => {
  assert.strictEqual(dv.invalidNameChars('remote'), '/');
  assert.strictEqual(dv.invalidNameChars('local'), '\\/:*?"<>|');
  assert.strictEqual(dv.isInvalidNameChar('/', 'remote'), true);
  assert.strictEqual(dv.isInvalidNameChar(':', 'remote'), false);
  assert.strictEqual(dv.isInvalidNameChar(':', 'local'), true);
});

test('an empty rename is a cancelled edit, not an error', () => {
  assert.deepStrictEqual(dv.validateRename(file('a'), ''), { action: 'cancel' });
  assert.deepStrictEqual(dv.validateRename(file('a'), null), { action: 'cancel' });
});

test('a name with a forbidden character is REFUSED and says which characters', () => {
  const result = dv.validateRename(file('a'), 'a/b', 'remote');
  assert.strictEqual(result.action, 'refuse');
  assert.ok(result.error.includes('invalid characters'));
  assert.strictEqual(result.retryable, true);

  const local = dv.validateRename(file('a'), 'a:b', 'local');
  assert.strictEqual(local.action, 'refuse');
  // The character list is spelled out space-separated so it is readable.
  assert.ok(local.error.endsWith('\\ / : * ? " < > |'), local.error);
});

test('renaming a file to its own name does nothing rather than hitting the server', () => {
  assert.deepStrictEqual(dv.validateRename(file('a.txt'), 'a.txt', 'remote'), { action: 'unchanged' });
  assert.deepStrictEqual(dv.validateRename(file('a.txt'), 'b.txt', 'remote'),
    { action: 'rename', name: 'b.txt' });
});

test('a colon is legal in a remote name and illegal in a local one', () => {
  assert.strictEqual(dv.validateRename(file('a'), 'time:12', 'remote').action, 'rename');
  assert.strictEqual(dv.validateRename(file('a'), 'time:12', 'local').action, 'refuse');
});

/* ================================================================== */
/* incremental search                                                  */
/* ================================================================== */

const searchItems = [
  parent(), file('alpha.txt'), file('Beta.txt'), file('gamma.log'), file('alphabet.md'),
];

test('nameStartOnly matches a prefix, name matches anywhere', () => {
  assert.strictEqual(
    dv.searchFile(searchItems, 'ta.', { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 }), -1);
  assert.strictEqual(
    dv.searchFile(searchItems, 'ta.', { mode: dv.INCREMENTAL_SEARCH.Name, currentIndex: 0 }), 2);
});

test('search is semi case sensitive — a lowercase needle ignores case, a capital does not', () => {
  assert.strictEqual(
    dv.searchFile(searchItems, 'beta', { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 }), 2);
  assert.strictEqual(
    dv.searchFile(searchItems, 'Beta', { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 }), 2);
  assert.strictEqual(
    dv.searchFile(searchItems, 'BETA', { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 }), -1);
});

test('search wraps and stops when it comes back to where it started', () => {
  // From 'gamma.log' the next 'alpha…' below is 'alphabet.md'; from below the
  // end it wraps round to 'alpha.txt'.
  assert.strictEqual(
    dv.searchFile(searchItems, 'alpha', { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 3 }), 4);
  assert.strictEqual(
    dv.searchFile(searchItems, 'alpha',
      { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 4, skipCurrent: true }), 1);
  assert.strictEqual(
    dv.searchFile(searchItems, 'nothinghere', { mode: dv.INCREMENTAL_SEARCH.Name, currentIndex: 0 }), -1);
});

test('skipCurrent finds the NEXT match, and reverse walks backwards', () => {
  assert.strictEqual(
    dv.searchFile(searchItems, 'alpha',
      { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 1, skipCurrent: true }), 4);
  assert.strictEqual(
    dv.searchFile(searchItems, 'alpha',
      { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 4, skipCurrent: true, reverse: true }), 1);
});

test('"all columns" mode searches the displayed text of every VISIBLE column', () => {
  const items = [file('x', { owner: 'martin' }), file('y', { owner: 'root' })];
  const columns = [{ key: 'name', visible: true }, { key: 'owner', visible: true }];
  assert.strictEqual(
    dv.searchFile(items, 'mart', { mode: dv.INCREMENTAL_SEARCH.All, columns, currentIndex: 0 }), 0);
  // Hide the owner column and the same text is no longer findable.
  const hidden = [{ key: 'name', visible: true }, { key: 'owner', visible: false }];
  assert.strictEqual(
    dv.searchFile(items, 'mart', { mode: dv.INCREMENTAL_SEARCH.All, columns: hidden, currentIndex: 0 }), -1);
});

test('search is off when the preference says off', () => {
  assert.strictEqual(
    dv.searchFile(searchItems, 'alpha', { mode: dv.INCREMENTAL_SEARCH.Off, currentIndex: 0 }), -1);
});

test('incrementalSearch reports haveNext only when another match really exists', () => {
  const many = dv.incrementalSearch(searchItems, 'alpha',
    { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 });
  assert.strictEqual(many.found, true);
  assert.strictEqual(many.index, 1);
  assert.strictEqual(many.state.haveNext, true);

  const one = dv.incrementalSearch(searchItems, 'gamma',
    { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0 });
  assert.strictEqual(one.state.haveNext, false);
});

test('a failed search leaves the state untouched, so a typo does not lose the prefix', () => {
  const state = new dv.IncrementalSearchState();
  state.searching = true;
  state.text = 'alph';
  const result = dv.incrementalSearch(searchItems, 'alphz',
    { mode: dv.INCREMENTAL_SEARCH.NameStartOnly, currentIndex: 0, state });
  assert.strictEqual(result.found, false);
  assert.strictEqual(state.text, 'alph');
  assert.strictEqual(state.searching, true);
});

test('the search status names what to do and only promises Tab when Tab works', () => {
  assert.strictEqual(dv.formatIncrementalSearchStatus({ text: '', haveNext: false }),
    'Search: (start typing)');
  assert.strictEqual(dv.formatIncrementalSearchStatus({ text: 'al', haveNext: false }),
    'Search: al');
  assert.strictEqual(dv.formatIncrementalSearchStatus({ text: 'al', haveNext: true }),
    'Search: al (press Tab for next)');
});

test('control characters never feed the search, and space only does once it is running', () => {
  const mode = dv.INCREMENTAL_SEARCH.Name;
  assert.strictEqual(dv.acceptsSearchKey('a', { mode }), true);
  assert.strictEqual(dv.acceptsSearchKey('a', { mode, ctrl: true }), false);
  assert.strictEqual(dv.acceptsSearchKey('Enter', { mode }), false);
  assert.strictEqual(dv.acceptsSearchKey(' ', { mode, searching: false }), false);
  assert.strictEqual(dv.acceptsSearchKey(' ', { mode, searching: true }), true);
  assert.strictEqual(dv.acceptsSearchKey('a', { mode: dv.INCREMENTAL_SEARCH.Off }), false);
});

test('nextSearchIndex wraps in both directions', () => {
  assert.strictEqual(dv.nextSearchIndex(2, 3, false), 0);
  assert.strictEqual(dv.nextSearchIndex(0, 3, true), 2);
  assert.strictEqual(dv.nextSearchIndex(0, 0, false), -1);
});

/* ================================================================== */
/* path history                                                        */
/* ================================================================== */

test('the history records where you came from, not where you are', () => {
  const h = new dv.PathHistory({ currentPath: '/home' });
  h.pathChanged('/home/user');
  assert.strictEqual(h.backCount, 1);
  assert.strictEqual(h.historyPath(0), '/home/user');
  assert.strictEqual(h.historyPath(-1), '/home');
  assert.strictEqual(h.forwardCount, 0);
});

test('navigating to the path you are already on records nothing', () => {
  const h = new dv.PathHistory({ currentPath: '/home' });
  h.pathChanged('/home');
  assert.strictEqual(h.backCount, 0);
});

test('back then forward returns exactly where you were', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  h.pathChanged('/c');
  assert.strictEqual(h.backCount, 2);
  assert.deepStrictEqual(h.backList(), ['/b', '/a']);

  const visited = [];
  assert.strictEqual(h.historyGo(-1, (p) => visited.push(p)), true);
  assert.deepStrictEqual(visited, ['/b']);
  assert.strictEqual(h.currentPath, '/b');
  assert.strictEqual(h.backCount, 1);
  assert.strictEqual(h.forwardCount, 1);
  assert.deepStrictEqual(h.backList(), ['/a']);
  assert.deepStrictEqual(h.forwardList(), ['/c']);

  h.historyGo(1);
  assert.strictEqual(h.currentPath, '/c');
  assert.strictEqual(h.backCount, 2);
  assert.strictEqual(h.forwardCount, 0);
});

test('going somewhere new drops the forward branch', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  h.pathChanged('/c');
  h.historyGo(-1);
  assert.strictEqual(h.forwardCount, 1);
  h.pathChanged('/d');
  assert.strictEqual(h.forwardCount, 0);
  assert.deepStrictEqual(h.backList(), ['/b', '/a']);
});

test('going back does not itself push a back entry — you could never leave', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  const before = h.backCount;
  h.historyGo(-1);
  assert.strictEqual(h.backCount, before - 1);
});

test('the history is trimmed from the OLDEST back entry, so the way back survives longest', () => {
  const h = new dv.PathHistory({ currentPath: '/0', maxHistoryCount: 3 });
  for (let i = 1; i <= 6; i += 1) h.pathChanged(`/${i}`);
  assert.strictEqual(h.paths.length, 3);
  assert.deepStrictEqual(h.backList(), ['/5', '/4', '/3']);
});

test('lowering maxHistoryCount trims immediately', () => {
  const h = new dv.PathHistory({ currentPath: '/0' });
  for (let i = 1; i <= 5; i += 1) h.pathChanged(`/${i}`);
  assert.strictEqual(h.paths.length, 5);
  h.setMaxHistoryCount(2);
  assert.strictEqual(h.paths.length, 2);
});

test('history save/restore round-trips', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  h.pathChanged('/c');
  const saved = h.save();
  const restored = new dv.PathHistory({ currentPath: '/c' });
  restored.restore(saved);
  assert.deepStrictEqual(restored.backList(), ['/b', '/a']);
  restored.restore(null);
  assert.strictEqual(restored.backCount, 0);
  assert.strictEqual(restored.paths.length, 0);
});

test('historyGo(0) does nothing at all', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  assert.strictEqual(h.historyGo(0), false);
  assert.strictEqual(h.currentPath, '/b');
});

/* ================================================================== */
/* view state                                                          */
/* ================================================================== */

test('a visible focused row remembers its OFFSET from the top row', () => {
  const items = [file('a'), file('b'), file('c'), file('d')];
  const state = dv.saveItemsState({ items, focusedIndex: 3, topIndex: 1, focusedVisible: true });
  assert.deepStrictEqual(state, { focusedItem: 'd', focusedShown: true, shownItemOffset: 2 });

  const restore = dv.restoreItemsState(state, { count: 4, visibleRowCount: 3, focusIndex: 3 });
  assert.strictEqual(restore.topIndex, 1);
});

test('an off-screen focused row remembers the SCROLL position instead', () => {
  const items = [file('a'), file('b'), file('c')];
  const state = dv.saveItemsState({ items, focusedIndex: 0, topIndex: 2, focusedVisible: false });
  assert.deepStrictEqual(state, { focusedItem: 'a', focusedShown: false, shownItemOffset: 2 });
});

test('restoring survives a listing that shrank past the remembered offset', () => {
  const state = { focusedItem: 'a', focusedShown: false, shownItemOffset: 40 };
  const restore = dv.restoreItemsState(state, { count: 10, visibleRowCount: 5, focusIndex: -1 });
  assert.strictEqual(restore.topIndex, -1);
  assert.strictEqual(restore.makeVisible, 9);       // the last row, not row 40
});

test('a negative computed top index is refused rather than applied', () => {
  // The situation WinSCP's comment records: index 0 focused and visible, yet
  // the top item reported as index 1.
  const state = { focusedItem: 'a', focusedShown: true, shownItemOffset: 1 };
  const restore = dv.restoreItemsState(state, { count: 3, visibleRowCount: 3, focusIndex: 0 });
  assert.strictEqual(restore.topIndex, -1);
});

test('saveState carries history, sort, mask, focus and the expanded tree, sorted', () => {
  const h = new dv.PathHistory({ currentPath: '/a' });
  h.pathChanged('/b');
  const state = dv.saveState({
    history: h,
    sortStr: '1;0',
    mask: '*.txt',
    items: [file('x'), file('y')],
    focusedIndex: 1,
    topIndex: 0,
    focusedVisible: true,
    expandedNodes: ['/var/log', '/etc', '/var'],
  });
  assert.deepStrictEqual(state.historyPaths, ['/a']);
  assert.strictEqual(state.backCount, 1);
  assert.strictEqual(state.sortStr, '1;0');
  assert.strictEqual(state.mask, '*.txt');
  assert.strictEqual(state.focusedItem, 'y');
  assert.deepStrictEqual(state.expandedNodes, ['/etc', '/var', '/var/log']);
});

/* ================================================================== */
/* mask-edit validation                                                */
/* ================================================================== */

test('a delimiter inside a mask is doubled so a name containing one survives', () => {
  const composed = dv.composeMaskStr(['a;b', 'c,d', 'e|f'], false);
  assert.strictEqual(composed.mask, 'a;;b; c,,d; e||f');
});

test('composing a directory mask appends the separator, matching the one already used', () => {
  assert.strictEqual(dv.composeMaskStr(['docs'], true).mask, 'docs/');
  assert.strictEqual(dv.composeMaskStr(['a\\b'], true).mask, 'a\\b\\');
  assert.strictEqual(dv.composeMaskStr(['a/b'], true).mask, 'a/b/');
  assert.strictEqual(dv.composeMaskStr(['a/b/'], true).mask, 'a/b/');
});

test('a FILE mask has its trailing separators stripped, not added', () => {
  assert.strictEqual(dv.composeMaskStr(['docs/'], false).mask, 'docs');
  assert.strictEqual(dv.composeMaskStr(['docs\\\\'], false).mask, 'docs');
});

test('blank memo lines are dropped and the rest are trimmed', () => {
  assert.strictEqual(dv.composeMaskStr(['  *.txt  ', '', '   ', '*.log'], false).mask, '*.txt; *.log');
  // A string is accepted as well as an array, split on line breaks.
  assert.strictEqual(dv.composeMaskStr('*.txt\n*.log', false).mask, '*.txt; *.log');
});

test('a directory mask is validated WITHOUT its trailing separator', () => {
  // ">1M/" would parse as a name and skip the size check entirely; the
  // validation therefore runs against ">1M".
  const ok = dv.composeMaskStr(['>1M'], true);
  assert.strictEqual(ok.mask, '>1M/');
  assert.strictEqual(ok.valid, true);

  const bad = dv.composeMaskStr(['>notasize'], true);
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.error.error);
});

test('composeMasks assembles the whole editor into include | exclude', () => {
  const result = dv.composeMasks(['*.txt'], ['*.bak'], ['docs'], ['tmp']);
  assert.strictEqual(result.mask, '*.txt; docs/ | *.bak; tmp/');
  assert.strictEqual(result.valid, true);
});

test('composeMasks with only excludes still produces a usable mask', () => {
  assert.strictEqual(dv.composeMasks([], ['*.bak'], [], []).mask, '| *.bak');
});

test('composeMasks with nothing at all is the empty mask', () => {
  assert.strictEqual(dv.composeMasks([], [], [], []).mask, '');
});

test('normalizeMask collapses "*" and "*.*" to the any-mask instead of storing a filter', () => {
  assert.strictEqual(dv.normalizeMask('*'), '*.*');
  assert.strictEqual(dv.normalizeMask('*.*'), '*.*');
  assert.strictEqual(dv.normalizeMask(''), '*.*');
  assert.strictEqual(dv.normalizeMask('*.txt'), '*.txt');
  assert.strictEqual(dv.normalizeMask('*', ''), '');
});

test('validateMask reports where the error is, as a 0-based caret offset', () => {
  const ok = dv.validateMask('*.txt');
  assert.strictEqual(ok.ok, true);

  const bad = dv.validateMask('>rubbish');
  assert.strictEqual(bad.ok, false);
  assert.ok(typeof bad.error === 'string' && bad.error.length > 0);
  assert.strictEqual(typeof bad.selectionStart, 'number');
  assert.ok(bad.selectionStart >= 0);
  assert.ok(bad.selectionLength > 0);
});

test('validateMask can require or forbid directory masks', () => {
  assert.strictEqual(dv.validateMask('docs/', 1).ok, true);
  assert.strictEqual(dv.validateMask('*.txt', -1).ok, true);
});

/* ================================================================== */
/* the clipboard file list                                             */
/* ================================================================== */

test('a name containing a space is quoted, so the list pastes onto a command line', () => {
  const items = [file('a b.txt'), file('c.txt'), file('d  e.bin')];
  assert.deepStrictEqual(dv.panelExport(dv.PANEL_EXPORT.FileList, { items }),
    ['"a b.txt"', 'c.txt', '"d  e.bin"']);
});

test('the full list uses the caller\'s full paths', () => {
  const items = [file('a.txt')];
  assert.deepStrictEqual(
    dv.panelExport(dv.PANEL_EXPORT.FullFileList, { items, fullPath: (i) => `/var/log/${i.name}` }),
    ['/var/log/a.txt']);
});

test('exporting the path exports exactly one line', () => {
  assert.deepStrictEqual(dv.panelExport(dv.PANEL_EXPORT.Path, { pathName: '/var/log' }), ['/var/log']);
});

test('one line goes to the clipboard bare; several go with a trailing newline', () => {
  assert.strictEqual(dv.stringsToText(['only']), 'only');
  assert.strictEqual(dv.stringsToText(['a', 'b']), 'a\r\nb\r\n');
  assert.strictEqual(dv.stringsToText([]), '');
});

test('fileListToText is the exact clipboard payload', () => {
  const items = [file('a b.txt'), file('c.txt')];
  assert.strictEqual(dv.fileListToText(dv.PANEL_EXPORT.FileList, { items }), '"a b.txt"\r\nc.txt\r\n');
  assert.strictEqual(dv.fileListToText(dv.PANEL_EXPORT.FileList, { items: [file('one.txt')] }), 'one.txt');
});

test('an embedded quote is left alone, because WinSCP does not escape it either', () => {
  assert.deepStrictEqual(dv.panelExport(dv.PANEL_EXPORT.FileList, { items: [file('a "b" c.txt')] }),
    ['"a "b" c.txt"']);
});

/* ================================================================== */
/* comparing two panels                                                */
/* ================================================================== */

test('compare selects the newer file, and never a directory', () => {
  const local = [dir('sub'), file('a.txt', { mtime: 2000 }), file('b.txt', { mtime: 1000 })];
  const remote = [dir('sub'), file('a.txt', { mtime: 1000 }), file('b.txt', { mtime: 2000 })];
  const changed = dv.compareWithPanel(local, remote, {
    criteria: [dv.COMPARE_CRITERIA.Time], precision: () => 'millisecond',
  });
  assert.deepStrictEqual(names(changed), ['a.txt']);
});

test('a file missing on the other side counts as changed unless existingOnly', () => {
  const local = [file('only.txt', { mtime: 1 })];
  assert.deepStrictEqual(names(dv.compareWithPanel(local, [], {})), ['only.txt']);
  assert.deepStrictEqual(names(dv.compareWithPanel(local, [], { existingOnly: true })), []);
});

test('timestamps are reduced to the COARSER of the two precisions before comparing', () => {
  const onTheMinute = 1_000_020_000;                        // exactly 16667 minutes
  const local = [file('a', { mtime: onTheMinute + 30_000 })];
  const remote = [file('a', { mtime: onTheMinute })];
  // At second precision the local one is newer.
  assert.strictEqual(dv.compareWithPanel(local, remote, {
    criteria: [dv.COMPARE_CRITERIA.Time], precision: () => 'second',
  }).length, 1);
  // At minute precision — which is all an FTP listing gives — they are equal.
  assert.strictEqual(dv.compareWithPanel(local, remote, {
    criteria: [dv.COMPARE_CRITERIA.Time],
    precision: (item) => (item === local[0] ? 'second' : 'minute'),
  }).length, 0);
});

test('size is only consulted when the times came out equal', () => {
  const local = [file('a', { mtime: 1000, size: 10 })];
  const remote = [file('a', { mtime: 1000, size: 20 })];
  assert.strictEqual(dv.compareWithPanel(local, remote, {
    criteria: [dv.COMPARE_CRITERIA.Time], precision: () => 'millisecond',
  }).length, 0);
  assert.strictEqual(dv.compareWithPanel(local, remote, {
    criteria: [dv.COMPARE_CRITERIA.Time, dv.COMPARE_CRITERIA.Size], precision: () => 'millisecond',
  }).length, 1);
});

/* ================================================================== */
/* column text                                                         */
/* ================================================================== */

test('a directory shows no size until one is calculated', () => {
  assert.strictEqual(dv.columnText(dir('d'), 'size', 'remote', { size: (n) => `${n} B` }), '');
  assert.strictEqual(
    dv.columnText(dir('d', { calculatedSize: 4096 }), 'size', 'remote', { size: (n) => `${n} B` }),
    '4096 B');
});

test('the Ext cell drops the dot and a directory has none', () => {
  assert.strictEqual(dv.columnText(file('a.tar.gz'), 'ext'), 'gz');
  assert.strictEqual(dv.columnText(dir('a.tar.gz'), 'ext'), '');
  // A leading dot is part of the name, not an extension.
  assert.strictEqual(dv.columnText(file('.bashrc'), 'ext'), '');
});

test('the Attr cell reports the DOS attribute letters in WinSCP\'s order', () => {
  assert.strictEqual(dv.columnText(dir('d', { readOnly: true, hidden: true }), 'attr'), 'drh');
  assert.strictEqual(dv.columnText(file('f', { raw: { system: true, archive: true } }), 'attr'), 'sa');
});

test('a token-shaped owner renders its display text', () => {
  const item = file('a', { owner: { name: '', idValid: true, id: 1000, displayText: '1000' } });
  assert.strictEqual(dv.columnText(item, 'owner'), '1000');
  assert.strictEqual(dv.columnText(file('a', { owner: 'root' }), 'owner'), 'root');
});

test('overlay badges compose rather than replace one another', () => {
  const link = file('l', { isSymlink: true });
  assert.strictEqual(dv.itemOverlayIndexes(link), dv.OVERLAY.Link);
  const broken = file('l', { isSymlink: true, brokenLink: true, isEncrypted: true });
  assert.strictEqual(dv.itemOverlayIndexes(broken), dv.OVERLAY.BrokenLink | dv.OVERLAY.Encrypted);
  assert.strictEqual(dv.itemOverlayIndexes(parent()), dv.OVERLAY.DirUp);
});

test('itemIsFile means "not the parent directory" — a directory IS a file by it', () => {
  assert.strictEqual(dv.itemIsFile(dir('sub')), true);
  assert.strictEqual(dv.itemIsFile(parent()), false);
});

/* ================================================================== */
/* the directory tree                                                  */
/* ================================================================== */

test('loadPath creates every missing ancestor', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  const node = tree.loadPath('/var/log/nginx');
  assert.strictEqual(node.path, '/var/log/nginx');
  assert.ok(tree.findNodeToPath('/var'));
  assert.ok(tree.findNodeToPath('/var/log'));
  assert.strictEqual(tree.root.path, '/');
  assert.strictEqual(tree.root.name, '/ <root>');
});

test('children are kept in the order the panel sorts names', () => {
  const tree = new dv.DirectoryTree({ unixPath: true, naturalOrderNumericalSorting: true });
  tree.loadPath('/x/dir10');
  tree.loadPath('/x/dir9');
  tree.loadPath('/x/dir1');
  assert.deepStrictEqual(tree.findNodeToPath('/x').children.map((c) => c.name),
    ['dir1', 'dir9', 'dir10']);
});

test('updatePath adds new directories, keeps existing ones and removes the gone', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  tree.loadPath('/x');
  tree.updatePath('/x', [dir('a'), dir('b'), file('notadir')]);
  assert.deepStrictEqual(tree.findNodeToPath('/x').children.map((c) => c.name), ['a', 'b']);

  tree.updatePath('/x', [dir('b'), dir('c')]);
  assert.deepStrictEqual(tree.findNodeToPath('/x').children.map((c) => c.name), ['b', 'c']);
  assert.strictEqual(tree.findNodeToPath('/x/a'), null);
});

test('updatePath skips "." and ".." and honours the hidden/inaccessible switches', () => {
  const tree = new dv.DirectoryTree({ unixPath: true, showHiddenDirs: false, showInaccesibleDirectories: false });
  tree.loadPath('/x');
  tree.updatePath('/x', [
    dir('.'), dir('..'), dir('.git'), dir('locked', { isInaccesibleDirectory: true }), dir('src'),
  ]);
  assert.deepStrictEqual(tree.findNodeToPath('/x').children.map((c) => c.name), ['src']);
});

test('a node holding the selection is not deleted, and the deletion is retried later', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  tree.loadPath('/x/gone/deeper');
  tree.updatePath('/x', [dir('gone')]);
  tree.setSelectedPath('/x/gone/deeper');

  tree.updatePath('/x', []);                     // 'gone' is no longer listed
  assert.ok(tree.findNodeToPath('/x/gone'), 'the node under the cursor survives');
  assert.deepStrictEqual(tree.pendingDeletes, ['/x/gone']);

  tree.setSelectedPath('/x');                    // the cursor moves away
  assert.strictEqual(tree.findNodeToPath('/x/gone'), null);
  assert.deepStrictEqual(tree.pendingDeletes, []);
});

test('findPathNode falls back to the nearest ancestor that does exist', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  tree.loadPath('/var/log');
  assert.strictEqual(tree.findPathNode('/var/log/nginx/sites').path, '/var/log');
  assert.strictEqual(tree.findPathNode('/nowhere').path, '/');
});

test('the expanded set survives a save and restore', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  tree.loadPath('/a/b/c');
  tree.findNodeToPath('/a').expanded = true;
  tree.findNodeToPath('/a/b').expanded = true;
  const saved = tree.saveExpanded();
  assert.deepStrictEqual(saved, ['/a', '/a/b']);

  const fresh = new dv.DirectoryTree({ unixPath: true });
  fresh.loadPath('/a/b/c');
  fresh.restoreExpanded(saved);
  assert.strictEqual(fresh.findNodeToPath('/a').expanded, true);
  assert.strictEqual(fresh.findNodeToPath('/a/b/c').expanded, false);
});

test('flatten stops at a collapsed node, which is what the tree renders', () => {
  const tree = new dv.DirectoryTree({ unixPath: true });
  tree.loadPath('/a/b');
  assert.deepStrictEqual(tree.flatten().map((r) => r.node.path), ['/']);
  tree.findNodeToPath('/').expanded = true;
  assert.deepStrictEqual(tree.flatten().map((r) => r.node.path), ['/', '/a']);
  assert.deepStrictEqual(tree.flatten({ visibleOnly: false }).map((r) => r.node.path),
    ['/', '/a', '/a/b']);
});

test('a Windows tree uses backslashes and drive roots', () => {
  const tree = new dv.DirectoryTree({ unixPath: false, rootName: 'C:' });
  const node = tree.loadPath('C:\\Users\\me');
  assert.strictEqual(node.path, 'C:\\Users\\me');
  assert.strictEqual(tree.findNodeToPath('C:\\Users').name, 'Users');
});

test('a Windows tree treats case-only refreshes as the same cached node and selection path', () => {
  const tree = new dv.DirectoryTree({ unixPath: false, rootName: 'C:' });
  tree.loadPath('C:\\Work');
  tree.updatePath('C:\\Work', [{ name: 'Reports', type: 'dir' }]);
  tree.setSelectedPath('c:\\work\\reports');

  tree.updatePath('c:\\work', [{ name: 'reports', type: 'dir' }]);

  assert.ok(tree.findNodeToPath('C:\\WORK\\REPORTS'));
  assert.strictEqual(tree.findNodeToPath('C:\\Work').children.length, 1);
  assert.deepStrictEqual(tree.pendingDeletes, []);
});

/* ================================================================== */
/* drive info                                                          */
/* ================================================================== */

test('a drive key upper-cases a letter and lower-cases a UNC path', () => {
  assert.strictEqual(dv.driveKey('c:\\temp'), 'C');
  assert.strictEqual(dv.driveKey('C:/temp'), 'C');
  assert.strictEqual(dv.driveKey('\\\\SERVER\\Share\\x'), '\\\\server\\share');
});

test('a path with no drive is an error, not a silent empty key', () => {
  assert.throws(() => dv.driveKey('relative\\path'), /Invalid drive/);
});

test('drive roots and simple names', () => {
  assert.strictEqual(dv.driveRoot('C'), 'C:\\');
  assert.strictEqual(dv.driveRoot('\\\\srv\\share'), '\\\\srv\\share\\');
  assert.strictEqual(dv.driveSimpleName('C'), 'C:');
  assert.strictEqual(dv.driveSimpleName('\\\\srv\\share'), '\\\\srv\\share');
});

test('isRealDrive is a single letter; a UNC root is not one', () => {
  assert.strictEqual(dv.isRealDrive('C'), true);
  assert.strictEqual(dv.isRealDrive('c'), true);
  assert.strictEqual(dv.isRealDrive('C:'), false);
  assert.strictEqual(dv.isRealDrive('\\\\srv\\share'), false);
});

test('isFixedDrive treats A: and B: as floppies unless UseABDrives is on', () => {
  assert.strictEqual(dv.isFixedDrive('A'), false);
  assert.strictEqual(dv.isFixedDrive('B'), false);
  assert.strictEqual(dv.isFixedDrive('C'), true);
  assert.strictEqual(dv.isFixedDrive('A', true), true);
  assert.strictEqual(dv.isFixedDrive('\\\\srv\\share'), true);
});

test('the pretty name does not print the drive letter twice', () => {
  assert.strictEqual(dv.drivePrettyName('C', 'Windows (C:)'), 'C: Windows');
  assert.strictEqual(dv.drivePrettyName('C', 'Local Disk'), 'C: Local Disk');
  assert.strictEqual(dv.drivePrettyName('C', ''), 'C:');
});

test('LastPaths returns you to where you were on that drive, or to its root if it is gone', () => {
  const last = new dv.LastPaths();
  last.record('D:\\projects\\app');
  assert.deepStrictEqual(last.tryGet('D', () => true), { found: true, path: 'D:\\projects\\app' });
  assert.deepStrictEqual(last.tryGet('D', () => false), { found: true, path: 'D:' });
  assert.deepStrictEqual(last.tryGet('E', () => true), { found: false, path: '' });
});

test('LastPaths ignores a path it cannot key, rather than throwing out of navigation', () => {
  const last = new dv.LastPaths();
  assert.doesNotThrow(() => last.record('/var/log'));
  assert.deepStrictEqual(last.tryGet('/var/log', () => true), { found: false, path: '' });
});

/* ================================================================== */
/* pathedit — history combo                                            */
/* ================================================================== */

test('saveToHistory moves an existing entry to the front instead of duplicating it', () => {
  let list = ['b', 'a', 'c'];
  list = pe.saveToHistory(list, 'a');
  assert.deepStrictEqual(list, ['a', 'b', 'c']);
});

test('saveToHistory removes EVERY existing occurrence', () => {
  assert.deepStrictEqual(pe.saveToHistory(['a', 'b', 'a'], 'a'), ['a', 'b']);
});

test('an empty string is never stored', () => {
  assert.deepStrictEqual(pe.saveToHistory(['a'], ''), ['a']);
  assert.deepStrictEqual(pe.saveToHistory([], ''), []);
});

test('the history is trimmed from the end, oldest first', () => {
  const list = pe.saveToHistory(['a', 'b', 'c'], 'd', 3);
  assert.deepStrictEqual(list, ['d', 'a', 'b']);
});

test('the trim runs even when nothing was added, so lowering the limit takes effect', () => {
  assert.deepStrictEqual(pe.saveToHistory(['a', 'b', 'c'], '', 2), ['a', 'b']);
});

test('the combo saves on drop-down and on exit, per SaveOn', () => {
  const combo = new pe.HistoryCombo({ items: [], text: '/var/log' });
  assert.strictEqual(combo.dropDown(), true);
  assert.deepStrictEqual(combo.items, ['/var/log']);
  assert.strictEqual(combo.itemIndex, 0);

  const exitOnly = new pe.HistoryCombo({ text: '/etc', saveOn: [pe.HISTORY_SAVE_ON.Exit] });
  assert.strictEqual(exitOnly.dropDown(), false);
  assert.deepStrictEqual(exitOnly.items, []);
  assert.strictEqual(exitOnly.exit(), true);
  assert.deepStrictEqual(exitOnly.items, ['/etc']);
});

test('a combo that saves nothing never grows a history', () => {
  const combo = new pe.HistoryCombo({ text: '/x', saveOn: [] });
  combo.dropDown();
  combo.exit();
  assert.deepStrictEqual(combo.items, []);
});

test('Up/Down saves typed text that is not already in the list, so it is not lost', () => {
  const combo = new pe.HistoryCombo({ items: ['/etc'], text: '/var' });
  const result = combo.keyDown('ArrowDown', {});
  assert.strictEqual(result.historyChanged, true);
  assert.deepStrictEqual(combo.items, ['/var', '/etc']);

  // Text already in the list is not re-saved.
  const same = new pe.HistoryCombo({ items: ['/etc'], text: '/etc' });
  assert.strictEqual(same.keyDown('ArrowUp', {}).historyChanged, false);

  // Alt+Down opens the list rather than stepping, so it saves nothing.
  const alt = new pe.HistoryCombo({ items: [], text: '/var' });
  assert.strictEqual(alt.keyDown('ArrowDown', { alt: true }).historyChanged, false);
});

test('Ctrl+Delete clears the whole history, but only while the list is open', () => {
  const combo = new pe.HistoryCombo({ items: ['/a', '/b'], text: '/a' });
  assert.deepStrictEqual(combo.keyDown('Delete', { ctrl: true }), { handled: false, historyChanged: false });
  combo.dropDown();
  const result = combo.keyDown('Delete', { ctrl: true });
  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.historyChanged, true);
  assert.deepStrictEqual(combo.items, []);
});

test('lowering the combo\'s maximum trims it there and then', () => {
  const combo = new pe.HistoryCombo({ items: ['a', 'b', 'c', 'd'] });
  assert.strictEqual(combo.setMaxHistorySize(2), true);
  assert.deepStrictEqual(combo.items, ['a', 'b']);
  assert.strictEqual(combo.setMaxHistorySize(2), false);
});

test('setText reports the matching item by TEXT, because ItemIndex is unreliable', () => {
  const combo = new pe.HistoryCombo({ items: ['/a', '/b'] });
  assert.strictEqual(combo.setText('/b'), 1);
  assert.strictEqual(combo.setText('/typed'), -1);
});

test('the combo defaults match THistoryComboBox\'s published defaults', () => {
  const combo = new pe.HistoryCombo({});
  assert.strictEqual(combo.maxHistorySize, 30);
  assert.strictEqual(combo.dropDownCount, 16);
  assert.strictEqual(combo.autoComplete, false);
  assert.deepStrictEqual([...combo.saveOn].sort(), ['dropDown', 'exit']);
});

/* ================================================================== */
/* pathedit — completion                                               */
/* ================================================================== */

test('inline completion offers the first matching item and selects what it added', () => {
  const result = pe.completeInline('doc', ['Desktop', 'Documents', 'Downloads']);
  assert.strictEqual(result.text, 'Documents');
  assert.strictEqual(result.selectionStart, 3);
  assert.strictEqual(result.selectionEnd, 9);
  assert.strictEqual(result.completed, true);
});

test('deleting never completes — otherwise backspace is unusable', () => {
  const result = pe.completeInline('doc', ['Documents'], { deleting: true });
  assert.strictEqual(result.text, 'doc');
  assert.strictEqual(result.completed, false);
});

test('an empty field never completes itself', () => {
  assert.strictEqual(pe.completeInline('', ['Documents']).completed, false);
});

test('completion needs something to add, so an exact match is not a completion', () => {
  assert.strictEqual(pe.completeInline('Documents', ['Documents']).completed, false);
});

test('path completion asks only for the directory already typed', () => {
  const asked = [];
  const list = (d) => { asked.push(d); return ['log', 'lib', 'local']; };
  const out = pe.pathCompletions('/usr/lo', list, { unix: true });
  assert.deepStrictEqual(asked, ['/usr']);
  assert.deepStrictEqual(out, ['/usr/local', '/usr/log']);
});

test('path completion after a separator offers everything in that directory', () => {
  const out = pe.pathCompletions('/usr/', () => ['bin', 'lib', '.', '..'], { unix: true });
  assert.deepStrictEqual(out, ['/usr/bin', '/usr/lib']);
});

test('a directory that cannot be read completes to nothing rather than throwing', () => {
  assert.deepStrictEqual(pe.pathCompletions('/root/x', () => { throw new Error('EACCES'); }, {}), []);
});

/* ================================================================== */
/* pathedit — word breaks                                              */
/* ================================================================== */

test('Ctrl+Left walks back one path component', () => {
  const path = '/var/log/nginx';
  assert.strictEqual(pe.wordLeft(path, path.length), 9);   // start of "nginx"
  assert.strictEqual(pe.wordLeft(path, 9), 5);             // start of "log"
  assert.strictEqual(pe.wordLeft(path, 5), 1);             // start of "var"
  assert.strictEqual(pe.wordLeft(path, 1), 0);
  assert.strictEqual(pe.wordLeft(path, 0), 0);
});

test('Ctrl+Right skips a run of consecutive separators', () => {
  assert.strictEqual(pe.wordRight('/var//log', 1), 6);
  assert.strictEqual(pe.wordRight('/var/log', 0), 1);
  assert.strictEqual(pe.wordRight('/var/log', 8), 8);
});

test('the delimiter set includes the mask separators, because the mask combos use it too', () => {
  for (const ch of ['\\', '/', ' ', ';', ',', '.', '=', '\r', '\n']) {
    assert.strictEqual(pe.isPathWordDelimiter(ch), true, `${JSON.stringify(ch)} should be a delimiter`);
  }
  assert.strictEqual(pe.isPathWordDelimiter('a'), false);
  assert.strictEqual(pe.isPathWordDelimiter('-'), false);
});

test('wordAt selects the component under the caret without its separators', () => {
  assert.deepStrictEqual(pe.wordAt('/var/log/nginx', 6), { start: 5, end: 8, text: 'log' });
  assert.deepStrictEqual(pe.wordAt('*.txt;*.log', 8), { start: 8, end: 11, text: 'log' });
});

/* ================================================================== */
/* pathedit — the path label                                           */
/* ================================================================== */

test('convertPath swaps both separators at once', () => {
  assert.strictEqual(pe.convertPathToWin('/var/log'), '\\var\\log');
  assert.strictEqual(pe.convertPathToUnix('C:\\Users'), 'C:/Users');
  // Both directions in one pass, which is what ConvertPath does.
  assert.strictEqual(pe.convertPath('a/b\\c', '/', '\\'), 'a\\b/c');
});

test('minimizeStr trims from just before the ellipsis and never past four characters', () => {
  assert.strictEqual(pe.minimizeStr('/var/log/nginx', 100), '/var/log/nginx');
  const short = pe.minimizeStr('/var/log/nginx', 8);
  assert.ok(short.endsWith('...'), short);
  assert.ok(short.length <= 8, short);
  assert.strictEqual(pe.minimizeStr('/var/log/nginx', 1).length, 4);
});

test('a breadcrumb click resolves to the prefix under the cursor', () => {
  // Character widths, so the positions are the character offsets.
  const path = '/var/log/nginx';
  assert.strictEqual(pe.hotTrackPath(path, 1, { unixPath: true }), '/');
  assert.strictEqual(pe.hotTrackPath(path, 5, { unixPath: true }), '/var/');
  assert.strictEqual(pe.hotTrackPath(path, 9, { unixPath: true }), '/var/log/');
  assert.strictEqual(pe.hotTrackPath(path, 13, { unixPath: true }), path);
});

test('a position past the whole path is not a breadcrumb', () => {
  assert.strictEqual(pe.hotTrackPath('/var', 99, { unixPath: true }), null);
  assert.strictEqual(pe.hotTrackPath('', 0, { unixPath: true }), '');
});

test('a UNC path\'s server and share are one breadcrumb, because half of it is not a place', () => {
  const path = '\\\\server\\share\\dir';
  assert.strictEqual(pe.hotTrackPath(path, 2, {}), '\\\\server\\share\\');
});

test('the click target drops the trailing separator, except at the root', () => {
  assert.strictEqual(pe.pathClickTarget('/var/log/', { unixPath: true }), '/var/log');
  assert.strictEqual(pe.pathClickTarget('/', { unixPath: true }), '/');
  assert.strictEqual(pe.pathClickTarget('C:\\Users\\', {}), 'C:\\Users');
});

test('pathSegments produces every prefix a user can click', () => {
  assert.deepStrictEqual(pe.pathSegments('/var/log/nginx', { unixPath: true }), [
    { label: '/', path: '/' },
    { label: 'var', path: '/var' },
    { label: 'log', path: '/var/log' },
    { label: 'nginx', path: '/var/log/nginx' },
  ]);
});

test('pathSegments handles a drive root and a UNC root', () => {
  assert.deepStrictEqual(pe.pathSegments('C:\\Users\\me', {}), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'me', path: 'C:\\Users\\me' },
  ]);
  assert.deepStrictEqual(pe.pathSegments('\\\\srv\\share\\dir', {}), [
    { label: '\\\\srv\\share', path: '\\\\srv\\share' },
    { label: 'dir', path: '\\\\srv\\share\\dir' },
  ]);
});

test('pathSegments of an empty path is empty, not a phantom root', () => {
  assert.deepStrictEqual(pe.pathSegments('', { unixPath: true }), []);
});

/* ================================================================== */
/* pathedit — the path combos                                          */
/* ================================================================== */

test('the remote path combo lists the ancestors, root first and current last', () => {
  assert.deepStrictEqual(pe.remotePathComboItems('/var/log/nginx'),
    ['/ <root>', 'var', 'log', 'nginx']);
  assert.deepStrictEqual(pe.remotePathComboItems('/'), ['/ <root>']);
  assert.deepStrictEqual(pe.remotePathComboItems(''), []);
});

test('a trailing slash does not produce an empty entry', () => {
  assert.deepStrictEqual(pe.remotePathComboItems('/var/log/'), ['/ <root>', 'var', 'log']);
});

test('choosing an entry climbs that many levels', () => {
  const path = '/var/log/nginx';
  const items = pe.remotePathComboItems(path);
  assert.strictEqual(items.length, 4);
  assert.strictEqual(pe.remotePathComboTarget(path, 3, 4), '/var/log/nginx');
  assert.strictEqual(pe.remotePathComboTarget(path, 2, 4), '/var/log');
  assert.strictEqual(pe.remotePathComboTarget(path, 1, 4), '/var');
  assert.strictEqual(pe.remotePathComboTarget(path, 0, 4), '/');
});

test('a path that climbs past the top lands on the root, not on nothing', () => {
  assert.strictEqual(pe.remotePathComboTarget('/var', 0, 5), '/');
});

test('the local path combo selects the first entry that is a prefix of the current path', () => {
  const paths = ['C:\\Users\\me\\Documents', 'C:\\Users\\me\\Desktop', 'C:\\', 'D:\\'];
  assert.strictEqual(pe.localPathComboIndex(paths, 'C:\\Users\\me\\Documents\\work'), 0);
  assert.strictEqual(pe.localPathComboIndex(paths, 'C:\\Windows'), 2);
  assert.strictEqual(pe.localPathComboIndex(paths, 'D:\\projects'), 3);
});

test('a current path that matches nothing leaves the combo alone rather than picking wrong', () => {
  assert.strictEqual(pe.localPathComboIndex(['C:\\'], '\\\\srv\\share\\x'), -1);
});

test('the local combo entries put the special folders first and report how many there are', () => {
  const built = pe.localPathComboEntries({
    personalFolder: 'C:\\Users\\me\\Documents',
    desktopFolder: 'C:\\Users\\me\\Desktop',
    drives: [
      { key: 'C', root: 'C:\\', prettyName: 'C: Local Disk' },
      { key: 'A', root: 'A:\\', valid: false },
    ],
  });
  assert.strictEqual(built.specialCount, 2);
  assert.deepStrictEqual(built.entries.map((e) => e.kind), ['folder', 'folder', 'drive']);
  assert.strictEqual(built.entries[2].label, 'C: Local Disk');
});
