// commands.test.js — the test that keeps the port honest.
//
// design/renderer/actions.js is generated from WinSCP's own NonVisual.dfm and
// holds all 301 actions the application can perform. This file asserts that
// every single one of them resolves to a registered handler in
// design/renderer/ui/commands.js, that anything declared unavailable says why
// in words a user can act on, and that all 79 keyboard shortcuts are wired with
// their conflicts resolved rather than silently swallowed.
//
// The renderer is native ES modules and the test runner is CommonJS, so the
// modules are pulled in with dynamic import(). commands.js, panelcolumns.js and
// panels.js are deliberately free of DOM access at import time precisely so
// this can run headless.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const R = (rel) => pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', rel)).href;

let ACTIONS;
let ACTION_CATEGORIES;
let C;          // ui/commands.js
let PC;         // ui/panelcolumns.js
let P;          // ui/panels.js
let BUS;

test.before(async () => {
  ({ ACTIONS, ACTION_CATEGORIES } = await import(R('actions.js')));
  C = await import(R('ui/commands.js'));
  ({ bus: BUS } = await import(R('state.js')));
  PC = await import(R('ui/panelcolumns.js'));
  P = await import(R('ui/panels.js'));
});

/* ------------------------------------------------------------------ */
/* the coverage guarantee                                              */
/* ------------------------------------------------------------------ */

test('every WinSCP action resolves to a registered handler', () => {
  assert.equal(ACTIONS.length, 301, 'the extracted action list changed size');
  const missing = [];
  for (const action of ACTIONS) {
    const cmd = C.getCommand(action.name);
    if (!cmd) { missing.push(action.name); continue; }
    assert.equal(cmd.name, action.name);
    assert.equal(typeof cmd._spec.run, 'function', `${action.name} has no run()`);
  }
  assert.deepEqual(missing, [], `actions with no handler: ${missing.join(', ')}`);
});

test('the registry holds exactly the extracted actions — no extras, no gaps', () => {
  const registered = C.listActionCommands().map((c) => c.name).sort();
  const expected = ACTIONS.map((a) => a.name).sort();
  assert.deepEqual(registered, expected);
});

test('the coverage report is internally consistent', () => {
  const cov = C.commandCoverage();
  assert.equal(cov.total, ACTIONS.length);
  assert.equal(cov.registered, ACTIONS.length);
  assert.deepEqual(cov.missing, []);
  assert.equal(cov.bound + cov.declared.length, cov.total);
  // Every category in actions.js is represented in the per-category ledger.
  for (const category of ACTION_CATEGORIES) {
    assert.ok(cov.byCategory[category], `no coverage entry for ${category}`);
  }
  const summed = Object.values(cov.byCategory).reduce((n, v) => n + v.total, 0);
  assert.equal(summed, ACTIONS.length);
});

test('anything declared unavailable states a real reason', () => {
  const cov = C.commandCoverage();
  for (const d of cov.declared) {
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length > 40, `${d.name}'s reason is too short to be useful: ${d.reason}`);
    // A reason must explain, not merely refuse.
    assert.ok(!/^(not implemented|todo|tbd)/i.test(d.reason.trim()), `${d.name} has a placeholder reason`);
    assert.ok(C.getCommand(d.name), `${d.name} is declared but not registered`);
  }
  // The ledger is honest about how many are declared rather than bound.
  assert.ok(cov.declared.length <= 5,
    `${cov.declared.length} actions are declared unavailable; that number should only ever go down`);
});

test('the coverage report renders as readable text', () => {
  const text = C.coverageReport();
  assert.match(text, /Actions: 301/);
  assert.match(text, /Shortcuts: 79 actions/);
  for (const category of ACTION_CATEGORIES) assert.ok(text.includes(category), `${category} missing from the report`);
});

/* ------------------------------------------------------------------ */
/* descriptors                                                         */
/* ------------------------------------------------------------------ */

test('every command carries the metadata the UI renders', () => {
  for (const cmd of C.listActionCommands()) {
    assert.equal(typeof cmd.id, 'string');
    assert.ok(cmd.id.startsWith('winscp.'));
    assert.ok(['local', 'remote', 'current', 'both'].includes(cmd.side), `${cmd.name} has side ${cmd.side}`);
    assert.ok(['command', 'toggle', 'radio'].includes(cmd.kind));
    assert.equal(typeof cmd.icon, 'string');
    assert.ok(cmd.icon.length > 0);
    assert.equal(typeof cmd.category, 'string');
  }
});

test('every command has a non-empty user-facing label', () => {
  for (const action of ACTIONS) {
    const label = C.actionLabel(action.name);
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `${action.name} renders an empty label`);
    // A label that is still the class name means neither an i18n key nor a
    // caption was found, which is what WinSCP shows for a programmatic action.
    if (label === action.name) {
      assert.ok(!action.caption || action.caption === action.name,
        `${action.name} has caption "${action.caption}" but renders as its class name`);
    }
  }
});

test('side is preserved from the extracted action unless the handler pins it', () => {
  // Local*/Remote* names must never resolve to the other side.
  for (const cmd of C.listActionCommands()) {
    if (/^Local/.test(cmd.name)) assert.notEqual(cmd.side, 'remote', `${cmd.name} resolved to the remote side`);
    if (/^Remote/.test(cmd.name)) assert.notEqual(cmd.side, 'local', `${cmd.name} resolved to the local side`);
  }
});

test('resolveSide follows the name, then the caller, then the focused panel', () => {
  const local = C.getCommand('LocalDeleteAction2');
  const remote = C.getCommand('RemoteDeleteAction2');
  const current = C.getCommand('CurrentDeleteAction');
  assert.equal(C.resolveSide(local, {}), 'local');
  assert.equal(C.resolveSide(remote, {}), 'remote');
  // An explicit side in the invocation wins for a Current* action…
  assert.equal(C.resolveSide(current, { side: 'local' }), 'local');
  // …and with no workspace and no override, the remote panel is the default,
  // which is the only panel the Explorer interface has.
  assert.equal(C.resolveSide(current, {}), 'remote');
});

/* ------------------------------------------------------------------ */
/* keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

test('all 79 shortcut-carrying actions are wired', () => {
  const withShortcut = ACTIONS.filter((a) => a.shortcut);
  assert.equal(withShortcut.length, 79);
  const claimed = new Set();
  for (const [, names] of C.SHORTCUTS) for (const n of names) claimed.add(n);
  for (const a of withShortcut) {
    assert.ok(claimed.has(a.name), `${a.name} carries ${a.shortcut} but is not in the shortcut table`);
  }
  assert.equal(claimed.size, 79);
});

test('shortcut normalisation is stable and idempotent', () => {
  const cases = [
    ['Ctrl+Num +', 'Ctrl+Num+'],
    ['Alt+Num -', 'Alt+Num-'],
    ['Num *', 'Num*'],
    ['Shift+Alt+Enter', 'Ctrl' in {} ? '' : 'Alt+Shift+Enter'],
    ['Alt+Left', 'Alt+ArrowLeft'],
    ['Backspace', 'Backspace'],
    ['Ctrl+\\', 'Ctrl+\\'],
    ['Ctrl+.', 'Ctrl+.'],
    ['F1', 'F1'],
    ['Ctrl+F3', 'Ctrl+F3'],
    ['Ctrl+Shift+L', 'Ctrl+Shift+L'],
  ];
  for (const [raw, want] of cases) {
    const got = C.normalizeShortcut(raw);
    assert.equal(got, want, `${raw} normalised to ${got}`);
    assert.equal(C.normalizeShortcut(got), got, `${got} is not idempotent`);
  }
});

test('every shortcut in actions.js normalises to something non-empty', () => {
  for (const a of ACTIONS) {
    if (!a.shortcut) continue;
    const key = C.normalizeShortcut(a.shortcut);
    assert.ok(key && key.length, `${a.name}'s shortcut "${a.shortcut}" normalised to nothing`);
    assert.ok(C.SHORTCUTS.has(key), `${key} is not in the shortcut table`);
  }
});

test('shortcut conflicts are detected, not swallowed', () => {
  const conflicts = C.shortcutConflicts();
  // Local/Remote/Current triples share a shortcut by design and are resolved by
  // the focused panel, so they must NOT be reported.
  for (const c of conflicts) {
    assert.ok(c.actions.length > 1);
    assert.ok(['local', 'remote', 'current', 'both'].includes(c.side));
  }
  const byShortcut = new Set(conflicts.map((c) => c.shortcut));
  assert.ok(!byShortcut.has('Ctrl+F3'), 'the Local/Remote/Current sort triple was reported as a conflict');
  assert.ok(!byShortcut.has('Alt+ArrowLeft'), 'the Local/Remote Back pair was reported as a conflict');
  // WinSCP itself binds Ctrl+Shift+M twice; the port reports it rather than
  // pretending one of the two commands does not exist.
  assert.ok(byShortcut.has('Ctrl+Shift+M'), 'the known Ctrl+Shift+M conflict is no longer reported');
  assert.equal(conflicts.length, 1, `unexpected shortcut conflicts: ${JSON.stringify(conflicts)}`);
});

test('a shortcut resolves to one action, preferring the focused side', () => {
  // With no workspace the default side is remote, so Ctrl+F3 must land on the
  // remote sort rather than the local one.
  assert.equal(C.resolveShortcut('Ctrl+F3'), 'RemoteSortByNameAction2');
  assert.equal(C.resolveShortcut('Ctrl+F3', { side: 'local' }), 'LocalSortByNameAction2');
  assert.equal(C.resolveShortcut('Alt+ArrowLeft', { side: 'local' }), 'LocalBackAction');
  assert.equal(C.resolveShortcut('Ctrl+A'), 'SelectAllAction');
  assert.equal(C.resolveShortcut('Nope+Q'), null);
});

test('shortcut resolution accepts human-formatted metadata spellings', () => {
  // Native menus and the command palette pass stored shortcut metadata, not
  // necessarily the canonical event spelling. The action must remain reachable
  // when case and separator whitespace differ.
  assert.equal(C.resolveShortcut('ctrl + f3'), 'RemoteSortByNameAction2');
  assert.equal(C.resolveShortcut('CMD+SHIFT+L'), C.resolveShortcut('Meta+Shift+L'));
});

test('focused variants are never reachable from the keyboard', () => {
  // A *Focused* action belongs to the right-click menu; letting it win a
  // shortcut would silently act on one row instead of the whole selection.
  for (const [, names] of C.SHORTCUTS) {
    const resolved = C.resolveShortcut(C.normalizeShortcut(names[0] && ACTIONS.find((a) => a.name === names[0]).shortcut));
    if (!resolved) continue;
    const cmd = C.getCommand(resolved);
    assert.ok(!cmd.focused, `${resolved} is a focused variant but won a shortcut`);
  }
});

/* ------------------------------------------------------------------ */
/* state evaluation without a UI                                       */
/* ------------------------------------------------------------------ */

test('commandState answers for every action with no panels attached', () => {
  for (const action of ACTIONS) {
    const st = C.commandState(action.name);
    assert.equal(st.exists, true, `${action.name} reported as missing`);
    assert.equal(typeof st.enabled, 'boolean');
    assert.equal(typeof st.visible, 'boolean');
    if (st.reason !== null && st.reason !== undefined) assert.equal(typeof st.reason, 'string');
    // Nothing that needs a panel may claim to be enabled when there is none.
    if (st.enabled && /Selected Operation|Focused Operation|Selection/.test(action.category)) {
      assert.fail(`${action.name} is enabled with no panel attached`);
    }
  }
});

test('commandState is stable for an unknown name', () => {
  const st = C.commandState('NoSuchAction');
  assert.equal(st.exists, false);
  assert.equal(st.enabled, false);
  assert.match(st.reason, /not a WinSCP action/);
});

test('ShowHiddenFilesAction is unavailable without a workspace to update', () => {
  const state = C.commandState('ShowHiddenFilesAction');
  assert.equal(state.enabled, false);
  assert.equal(state.reason, null);
});

test('QueueShowAction reopens the existing queue surface after saving', async () => {
  let opened = 0;
  const off = BUS.on('queue:open', () => { opened += 1; });
  try {
    await C.getCommand('QueueShowAction')._spec.run({});
    assert.equal(opened, 1);
  } finally {
    off();
  }
});

/* ------------------------------------------------------------------ */
/* the column model                                                    */
/* ------------------------------------------------------------------ */

test('the column sets match WinSCP\'s own defaults', () => {
  assert.deepEqual(PC.LOCAL_COLUMNS.map((c) => c.key), ['name', 'size', 'type', 'changed', 'attr', 'ext']);
  assert.deepEqual(PC.REMOTE_COLUMNS.map((c) => c.key),
    ['name', 'size', 'changed', 'rights', 'owner', 'group', 'ext', 'linkTarget', 'type']);
  // Widths and default visibility come from DirViewColProperties.pas.
  assert.equal(PC.LOCAL_COLUMNS[0].width, 150);
  assert.equal(PC.LOCAL_COLUMNS[1].width, 80);
  assert.equal(PC.LOCAL_COLUMNS[1].align, 'right');
  assert.equal(PC.LOCAL_COLUMNS.find((c) => c.key === 'ext').visible, false);
  assert.equal(PC.REMOTE_COLUMNS.find((c) => c.key === 'linkTarget').visible, false);
  assert.equal(PC.REMOTE_COLUMNS.find((c) => c.key === 'type').visible, false);
});

test('every sort action names a column its panel actually has', () => {
  const local = new Set(PC.LOCAL_COLUMNS.map((c) => c.key));
  const remote = new Set(PC.REMOTE_COLUMNS.map((c) => c.key));
  for (const cmd of C.listActionCommands()) {
    if (cmd.category !== 'Sort' || /Ascending|SortColumn/.test(cmd.name)) continue;
    const set = cmd.side === 'local' ? local : cmd.side === 'remote' ? remote : new Set([...local, ...remote]);
    const key = cmd.name.replace(/^(Local|Remote|Current)SortBy/, '').replace(/Action\d?$/, '').toLowerCase();
    const mapped = { rights: 'rights', attr: 'attr' }[key] || key;
    assert.ok(set.has(mapped), `${cmd.name} sorts by "${mapped}", which the ${cmd.side} panel has no column for`);
  }
});

test('natural order sorts numbers as numbers', () => {
  const names = ['file10.txt', 'file9.txt', 'File1.txt', 'file100.txt', 'a.txt'];
  const sorted = names.slice().sort(PC.naturalCompare);
  assert.deepEqual(sorted, ['a.txt', 'File1.txt', 'file9.txt', 'file10.txt', 'file100.txt']);
  assert.ok(PC.naturalCompare('007', '7') < 0);
  assert.equal(PC.naturalCompare('same', 'same'), 0);
});

test('the comparator keeps "..", then directories, then files', () => {
  const cmp = PC.makeComparator({ key: 'size', ascending: true }, { natural: true });
  const rows = [
    { name: 'b.txt', type: 'file', size: 10 },
    { name: '..', type: 'dir', size: 0 },
    { name: 'zdir', type: 'dir', size: 0 },
    { name: 'a.txt', type: 'file', size: 5 },
    { name: 'adir', type: 'dir', size: 0 },
  ];
  const sorted = rows.slice().sort(cmp).map((r) => r.name);
  assert.equal(sorted[0], '..');
  assert.deepEqual(sorted.slice(1, 3).sort(), ['adir', 'zdir']);
  assert.deepEqual(sorted.slice(3), ['a.txt', 'b.txt']);
});

test('"always sort directories by name" ignores the active COLUMN, not the direction', () => {
  const rows = [
    { name: 'zeta', type: 'dir', mtime: 5000 },
    { name: 'alpha', type: 'dir', mtime: 9000 },
  ];
  // The column is ignored: alpha is the newer directory but still sorts by name.
  const up = PC.makeComparator({ key: 'changed', ascending: true }, { alwaysSortDirectoriesByName: true });
  assert.deepEqual(rows.slice().sort(up).map((r) => r.name), ['alpha', 'zeta']);
  // The DIRECTION is not ignored. DirViewInt.pas keeps ConsiderDirection True
  // through this fallback and UnixDirView.cpp negates after it, so a descending
  // sort reverses the directories along with the files. Leaving them ascending
  // produced a panel where the folders and the files ran opposite ways.
  const down = PC.makeComparator({ key: 'changed', ascending: false }, { alwaysSortDirectoriesByName: true });
  assert.deepEqual(rows.slice().sort(down).map((r) => r.name), ['zeta', 'alpha']);
});

test('two parent entries compare equal, so the comparator stays antisymmetric', () => {
  const cmp = PC.makeComparator({ key: 'name', ascending: true });
  const a = { name: '..', type: 'dir' };
  const b = { name: '..', type: 'dir' };
  // compare(a,b) === -compare(b,a) is what Array.prototype.sort requires;
  // returning -1 both ways is undefined behaviour that can reorder other rows.
  assert.equal(cmp(a, b), 0);
  assert.equal(cmp(a, b), -cmp(b, a));
});

test('Size and Date modified start descending the first time they are clicked', () => {
  // TCustomIEListView::SortAscendingByDefault — the biggest and the newest
  // belong at the top, which is why anyone clicks those headers.
  assert.equal(PC.sortAscendingByDefault('name'), true);
  assert.equal(PC.sortAscendingByDefault('ext'), true);
  assert.equal(PC.sortAscendingByDefault('size'), false);
  assert.equal(PC.sortAscendingByDefault('changed'), false);
});

test('cell text formats what each column shows', () => {
  const entry = {
    name: 'notes.TXT', type: 'file', size: 2048, mtime: Date.UTC(2020, 0, 2, 3, 4),
    rights: 'rw-r--r--', owner: 'root', group: 'wheel', linkTarget: '', hidden: false,
  };
  assert.equal(PC.cellText(entry, 'name'), 'notes.TXT');
  assert.equal(PC.cellText(entry, 'ext'), 'TXT');
  assert.equal(PC.cellText(entry, 'rights'), 'rw-r--r--');
  assert.equal(PC.cellText(entry, 'owner'), 'root');
  assert.equal(PC.cellText(entry, 'type'), 'Text Document');
  assert.match(PC.cellText(entry, 'changed'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(PC.cellText({ name: '..', type: 'dir' }, 'size'), '');
  // A leading dot is part of the name, not an extension — WinSCP's rule.
  assert.equal(PC.extensionOf('.bashrc'), '');
  assert.equal(PC.extensionOf('archive.tar.gz'), 'gz');
});

test('column auto-size measures the header from the owning panel side', () => {
  const previousDocument = global.document;
  global.document = {
    createElement: () => ({ getContext: () => ({
      font: '', measureText: (value) => ({ width: String(value).length }),
    }) }),
  };
  try {
    const remote = PC.makeMeasurer(() => [], () => '13px system-ui', { side: 'remote', padding: 0 });
    const local = PC.makeMeasurer(() => [], () => '13px system-ui', { side: 'local', padding: 0 });
    // `rights` exists only on the remote set. The local measurer must use its
    // Name fallback rather than borrowing the longer remote header label.
    assert.ok(remote('rights') > local('rights'));
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

/* ------------------------------------------------------------------ */
/* file masks                                                          */
/* ------------------------------------------------------------------ */

const F = (name, over) => ({ name, type: 'file', size: 0, mtime: 0, ...(over || {}) });
const D = (name) => ({ name, type: 'dir', size: 0, mtime: 0 });

test('name masks follow WinSCP\'s rules', () => {
  const rows = [
    ['*.txt', F('a.txt'), true],
    ['*.txt', F('a.TXT'), true],
    ['*.txt', F('a.txt.bak'), false],
    ['a*.txt; b?.doc', F('abc.txt'), true],
    ['a*.txt; b?.doc', F('b1.doc'), true],
    ['a*.txt; b?.doc', F('b12.doc'), false],
    ['a*.txt, b?.doc', F('b1.doc'), true],
    ['[abc]*.log', F('boot.log'), true],
    ['[abc]*.log', F('zoot.log'), false],
    ['[a-c]*.log', F('catalog.log'), true],
    ['[!a-c]*.log', F('catalog.log'), false],
    ['[!a-c]*.log', F('zoot.log'), true],
    ['*.*', F('readme'), true],
    ['*.', F('readme'), true],
    ['*.', F('readme.txt'), false],
    ['', F('anything'), true],
  ];
  for (const [mask, entry, want] of rows) {
    assert.equal(P.compileMask(mask)(entry), want, `${mask} against ${entry.name}`);
  }
});

test('directory masks only match directories', () => {
  const m = P.compileMask('node_modules/');
  assert.equal(m(D('node_modules')), true);
  assert.equal(m(F('node_modules')), false);
});

test('an exclude clause removes matches from the include clause', () => {
  const m = P.compileMask('*.log | debug*.log');
  assert.equal(m(F('server.log')), true);
  assert.equal(m(F('debug1.log')), false);
});

test('size bounds treat a bare integer as bytes, not a year', () => {
  const m = P.compileMask('*.bin>2019');
  assert.equal(m(F('a.bin', { size: 3000 })), true);
  assert.equal(m(F('a.bin', { size: 100 })), false);
  const range = P.compileMask('*>1M<=10M');
  assert.equal(range(F('x', { size: 5 * 1024 * 1024 })), true);
  assert.equal(range(F('x', { size: 10 * 1024 * 1024 })), true);
  assert.equal(range(F('x', { size: 11 * 1024 * 1024 })), false);
  assert.equal(range(F('x', { size: 1024 })), false);
});

test('time bounds accept absolute and relative forms', () => {
  const abs = P.compileMask('*.log>2019-01-01');
  assert.equal(abs(F('a.log', { mtime: new Date(2020, 0, 1).getTime() })), true);
  assert.equal(abs(F('a.log', { mtime: new Date(2018, 0, 1).getTime() })), false);
  const rel = P.compileMask('*.log>30D');
  assert.equal(rel(F('a.log', { mtime: Date.now() - 86400000 })), true);
  assert.equal(rel(F('a.log', { mtime: Date.now() - 60 * 86400000 })), false);
});

test('path masks match the whole path, not just the name', () => {
  const m = P.compileMask('/var/log/*.log');
  assert.equal(m(F('syslog.log'), '/var/log/syslog.log'), true);
  assert.equal(m(F('syslog.log'), '/home/me/syslog.log'), false);
});

/* ------------------------------------------------------------------ */
/* the menu trees                                                      */
/* ------------------------------------------------------------------ */

test('every menu leaf names a real action', async () => {
  const M = await import(R('ui/menus.js'));
  const seen = new Set();
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node || node.separator) continue;
      if (node.action) {
        assert.ok(C.getCommand(node.action), `menu entry "${node.action}" is not a registered action`);
        seen.add(node.action);
      }
      if (node.items) walk(node.items);
    }
  };
  walk(M.COMMANDER_MENUS.flatMap((m) => m.items));
  walk(M.EXPLORER_MENUS.flatMap((m) => m.items));
  // The two menu bars between them should reach most of the action set; the
  // rest live on toolbars, context menus and the queue panel.
  assert.ok(seen.size > 150, `the menu bars only reach ${seen.size} actions`);
});

test('every toolbar button names a real action', async () => {
  const T = await import(R('ui/toolbars.js'));
  for (const band of Object.values(T.BANDS)) {
    for (const item of band.items || []) {
      if (item.separator || item.widget) continue;
      assert.ok(C.getCommand(item.action), `toolbar band ${band.id} references "${item.action}"`);
    }
  }
});

test('band toggles exist for every declared band', async () => {
  const T = await import(R('ui/toolbars.js'));
  // Each band that the View menu can toggle must have an action behind it.
  const toggles = C.listActionCommands().filter((c) => /BandAction|ToolBar2Action/.test(c.name));
  assert.ok(toggles.length >= 26, `only ${toggles.length} band toggles are registered`);
  for (const iface of ['commander', 'explorer']) {
    const bands = [...T.bandsFor(iface), ...T.bandsFor(iface, 'local'), ...T.bandsFor(iface, 'remote')];
    assert.ok(bands.length > 0, `${iface} has no bands`);
    for (const band of bands) assert.equal(typeof band.label, 'string');
  }
});
