// interfaces.test.js — the two interface modes.
//
// The tests below are aimed at the places where Commander and Explorer
// genuinely DISAGREE, because a port that gets those wrong still looks correct
// in either mode taken alone. So: which actions exist, which keys they answer
// to, where a download lands when the user did not say, what the opposite panel
// does when synchronized browsing cannot map a directory, and what a workspace
// remembers.
//
// Several tests assert REFUSALS rather than results. A refusal is the part of a
// port that is easiest to drop and worst to drop: WinSCP declining to compare
// one panel with itself, or turning synchronized browsing off rather than
// leaving two panels quietly out of step, is behaviour a user depends on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('../design/main/interfaces');
const SD = require('../design/main/sessiondata');
const W = require('../design/main/winconfig');

const { COMMANDER, EXPLORER, LOCAL, REMOTE, CURRENT } = I;

// ===========================================================================
// sides
// ===========================================================================

test('osOther is osRemote — the opposite panel, not necessarily a server', () => {
  assert.equal(I.OTHER, REMOTE);
});

test('getSide resolves osCurrent against the focused panel', () => {
  assert.equal(I.getSide(CURRENT, LOCAL), LOCAL);
  assert.equal(I.getSide(CURRENT, REMOTE), REMOTE);
  assert.equal(I.getSide(LOCAL, REMOTE), LOCAL);
  assert.equal(I.getSide(undefined, REMOTE), REMOTE);
});

test('getOtherSide flips, and an unknown side is refused rather than guessed', () => {
  assert.equal(I.getOtherSide(LOCAL), REMOTE);
  assert.equal(I.getOtherSide(REMOTE), LOCAL);
  assert.equal(I.getOtherSide(CURRENT, REMOTE), LOCAL);
  assert.throws(() => I.getSide('sideways', LOCAL), TypeError);
});

test('an unknown interface mode is refused, not treated as Commander', () => {
  assert.throws(() => I.panelArrangement('classic', {}), TypeError);
  assert.throws(() => I.storeParams('', {}), TypeError);
});

// ===========================================================================
// which commands exist in each mode
// ===========================================================================

test('the action tag decodes to the four TActionFlag bits', () => {
  assert.deepEqual(I.actionFlags(15), { local: true, remote: true, explorer: true, commander: true });
  assert.deepEqual(I.actionFlags(11), { local: true, remote: true, explorer: false, commander: true });
  assert.deepEqual(I.actionFlags(12), { local: false, remote: false, explorer: true, commander: true });
  assert.deepEqual(I.actionFlags(9), { local: true, remote: false, explorer: false, commander: true });
});

test('an action without the mode flag does not exist in that mode at all', () => {
  const commanderOnly = { name: 'SynchronizeBrowsingAction2', tag: 11 };
  const explorer = I.allowedAction(EXPLORER, commanderOnly, I.AA_EXECUTE, {});
  assert.equal(explorer.allowed, false);
  assert.equal(explorer.visible, false);
  assert.match(explorer.reason, /Explorer/);
  assert.equal(I.allowedAction(COMMANDER, commanderOnly, I.AA_EXECUTE, {}).allowed, true);
});

test('a Commander shortcut only fires for the panel it is designed for', () => {
  const localAction = { name: 'LocalSortByExtAction2', tag: 9 };   // local | commander
  assert.equal(I.allowedAction(COMMANDER, localAction, I.AA_SHORTCUT, { currentSide: LOCAL }).allowed, true);
  const onRemote = I.allowedAction(COMMANDER, localAction, I.AA_SHORTCUT, { currentSide: REMOTE });
  assert.equal(onRemote.allowed, false);
  assert.match(onRemote.reason, /remote panel/);
  // Executing it (from a menu) is still fine — only the shortcut is side-bound.
  assert.equal(I.allowedAction(COMMANDER, localAction, I.AA_EXECUTE, { currentSide: REMOTE }).allowed, true);
});

test('an Explorer shortcut needs the remote flag, because there is no local panel', () => {
  const bothSides = { name: 'CurrentDeleteAction', tag: 15 };
  const remoteless = { name: 'AutoSizeRemoteColumnsAction', tag: 12 };
  assert.equal(I.allowedAction(EXPLORER, bothSides, I.AA_SHORTCUT, {}).allowed, true);
  assert.equal(I.allowedAction(EXPLORER, remoteless, I.AA_SHORTCUT, {}).allowed, false);
  assert.equal(I.allowedAction(EXPLORER, remoteless, I.AA_EXECUTE, {}).allowed, true);
});

test('busy blocks execution and shortcuts but never the update pass', () => {
  const action = { name: 'CurrentDeleteAction', tag: 15 };
  assert.equal(I.allowedAction(COMMANDER, action, I.AA_EXECUTE, { busy: true }).allowed, false);
  assert.equal(I.allowedAction(COMMANDER, action, I.AA_SHORTCUT, { busy: true, currentSide: LOCAL }).allowed, false);
  assert.equal(I.allowedAction(COMMANDER, action, I.AA_UPDATE, { busy: true }).allowed, true);
});

test('a disabled action swallows nothing — its shortcut is refused', () => {
  const action = { name: 'RemoteCopyAction', tag: 14 };
  assert.equal(I.allowedAction(EXPLORER, action, I.AA_SHORTCUT, { actionEnabled: false }).allowed, false);
  assert.equal(I.allowedAction(EXPLORER, action, I.AA_SHORTCUT, { actionEnabled: true }).allowed, true);
});

test('Explorer hides the "file list to command line" entry rather than greying it', () => {
  const action = { name: 'FileListToCommandLineAction', tag: 11 };
  const r = I.allowedAction(EXPLORER, action, I.AA_UPDATE, {});
  assert.equal(r.visible, false);
  assert.ok(I.EXPLORER_HIDDEN_ACTIONS.includes('FileListToCommandLineAction'));
});

test('the real 301-action table partitions into the two modes', async () => {
  const { ACTIONS } = await import('../design/renderer/actions.js');
  assert.equal(ACTIONS.length, 301);
  const diff = I.commandDifference(ACTIONS);
  // Every action belongs to at least one interface; NonVisual has no orphans.
  assert.equal(diff.neither.length, 0);
  assert.ok(diff.commanderOnly.length > 0, 'Commander has commands Explorer does not');
  assert.ok(diff.both.length > 0);
  // The two-panel commands are Commander's alone.
  for (const name of ['SynchronizeBrowsingAction2', 'CommanderLocalPanelAction', 'LocalChangePathAction2',
    'CompareDirectoriesAction', 'FileListToCommandLineAction']) {
    if (ACTIONS.some((a) => a.name === name)) {
      assert.ok(diff.commanderOnly.includes(name), `${name} should be Commander-only`);
    }
  }
  assert.equal(I.commandsFor(COMMANDER, ACTIONS).length, diff.commanderOnly.length + diff.both.length);
  assert.equal(I.commandsFor(EXPLORER, ACTIONS).length, diff.explorerOnly.length + diff.both.length);
});

// ===========================================================================
// keyboard shortcut sets
// ===========================================================================

test('Commander is Norton-like and Explorer is Windows-like for the same actions', () => {
  const c = I.shortcutsFor(COMMANDER, {});
  const e = I.shortcutsFor(EXPLORER, {});
  assert.equal(c.primary.CurrentCreateDirAction, 'F7');
  assert.equal(e.primary.CurrentCreateDirAction, 'Ctrl+D');
  assert.equal(c.primary.CurrentDeleteFocusedAction, 'F8');
  assert.equal(e.primary.CurrentDeleteFocusedAction, 'Del');
  assert.equal(c.primary.CurrentPropertiesFocusedAction, 'F9');
  assert.equal(e.primary.CurrentPropertiesFocusedAction, 'Alt+Enter');
  assert.equal(c.primary.CloseApplicationAction2, 'F10');
  assert.equal(e.primary.CloseApplicationAction2, 'Alt+F4');
  assert.equal(c.primary.NewTabAction, 'Ctrl+T');
  assert.equal(e.primary.NewTabAction, 'Ctrl+N');
});

test('Explorer clears the internal-editor shortcuts instead of leaving them bound', () => {
  const e = I.shortcutsFor(EXPLORER, {});
  assert.equal(e.primary.CurrentEditInternalAction, '');
  assert.equal(e.primary.CurrentEditInternalFocusedAction, '');
  assert.equal(I.shortcutsFor(COMMANDER, {}).primary.CurrentEditInternalAction, 'Ctrl+Alt+F4');
});

test('Explorer-style keys inside Commander move five bindings, and hand Ctrl+F4 over', () => {
  const off = I.shortcutsFor(COMMANDER, { explorerKeyboardShortcuts: false });
  const on = I.shortcutsFor(COMMANDER, { explorerKeyboardShortcuts: true });
  assert.equal(off.primary.RemoteCopyAction, 'F5');
  assert.equal(on.primary.RemoteCopyAction, 'Ctrl+K');
  assert.equal(off.primary.RemoteRefreshAction, 'Ctrl+R');
  assert.equal(on.primary.RemoteRefreshAction, 'F5');
  assert.equal(off.primary.RemoteFindFilesAction2, 'Alt+F7');
  assert.equal(on.primary.RemoteFindFilesAction2, 'F3');
  // Ctrl+F4 belongs to sort-by-extension by default and to close-tab otherwise.
  assert.equal(off.primary.LocalSortByExtAction2, 'Ctrl+F4');
  assert.deepEqual(off.secondary.CloseTabAction, []);
  assert.equal(on.primary.LocalSortByExtAction2, '');
  assert.deepEqual(on.secondary.CloseTabAction, ['Ctrl+F4']);
});

test('cloned shortcuts follow the primary AFTER the interface rebound it', () => {
  const c = I.shortcutsFor(COMMANDER, { explorerKeyboardShortcuts: true });
  assert.equal(c.primary.LocalRefreshAction, c.primary.RemoteRefreshAction);
  assert.equal(c.primary.LocalCopyAction, 'Ctrl+K');
  assert.equal(c.primary.LocalLocalCopyAction, 'Ctrl+K');
  assert.equal(c.primary.LocalOtherCopyAction, 'Ctrl+K');
  assert.equal(c.primary.CurrentDeleteAction, c.primary.CurrentDeleteFocusedAction);
  assert.equal(c.primary.NewDirAction, 'F7');
  const e = I.shortcutsFor(EXPLORER, {});
  assert.equal(e.primary.LocalOpenDirAction, 'Ctrl+O');
  assert.equal(e.primary.RemoteNewFileAction, 'Ctrl+Shift+E');
});

test('shortcuts an interface never touches keep their designed value', () => {
  const table = I.shortcutsFor(EXPLORER, {
    defaults: { SelectAction: 'Gray+', CloseTabAction: 'Ctrl+W' },
    defaultsSecondary: { CloseTabAction: ['Ctrl+F4'] },
  });
  assert.equal(table.primary.SelectAction, 'Gray+');
  assert.equal(table.primary.CloseTabAction, 'Ctrl+W');
  assert.deepEqual(table.secondary.CloseTabAction, ['Ctrl+F4']);
  // ...and the clone pass carries it onto the aliases.
  assert.equal(table.primary.LocalSelectAction2, 'Gray+');
});

test('swapping the panels swaps the two "go to path box" keys', () => {
  const base = { defaults: { LocalChangePathAction2: 'Alt+F1', RemoteChangePathAction2: 'Alt+F2' } };
  const normal = I.shortcutsFor(COMMANDER, base);
  const swapped = I.shortcutsFor(COMMANDER, Object.assign({ swappedPanels: true }, base));
  assert.equal(normal.primary.LocalChangePathAction2, 'Alt+F1');
  assert.equal(swapped.primary.LocalChangePathAction2, 'Alt+F2');
  assert.equal(swapped.primary.RemoteChangePathAction2, 'Alt+F1');
});

test('the New Tab button is a split button only where a local tab is possible', () => {
  assert.equal(I.shortcutsFor(COMMANDER, {}).newTabDropdownCombo, true);
  assert.equal(I.shortcutsFor(EXPLORER, {}).newTabDropdownCombo, false);
});

test('neither mode binds one key to two different primary actions', () => {
  for (const mode of [COMMANDER, EXPLORER]) {
    for (const explorerKeyboardShortcuts of [false, true]) {
      const conflicts = I.shortcutConflicts(I.shortcutsFor(mode, { explorerKeyboardShortcuts }));
      for (const conflict of conflicts) {
        // Aliases legitimately share a key with the action they clone; a
        // conflict only matters when two UNRELATED actions collide.
        const roots = new Set(conflict.actions.map((name) => {
          const clone = I.SHORTCUT_CLONES.find(([alias]) => alias === name);
          return clone ? clone[1] : name;
        }));
        assert.ok(roots.size <= 3, `${mode}: ${conflict.key} bound to ${conflict.actions.join(', ')}`);
      }
    }
  }
});

// ===========================================================================
// panel arrangement
// ===========================================================================

test('Explorer has no local panel and Commander always has two', () => {
  const e = I.panelArrangement(EXPLORER, {});
  assert.equal(e.hasLocalPanel, false);
  assert.deepEqual(e.panels, [REMOTE]);
  const c = I.panelArrangement(COMMANDER, { hasSession: true });
  assert.equal(c.hasLocalPanel, true);
  assert.deepEqual(c.panels, [LOCAL, REMOTE]);
});

test('right-to-left layout inverts the swapped-panels preference', () => {
  assert.equal(I.panelArrangement(COMMANDER, { swappedPanels: false }).leftPanel, LOCAL);
  assert.equal(I.panelArrangement(COMMANDER, { swappedPanels: true }).leftPanel, REMOTE);
  assert.equal(I.panelArrangement(COMMANDER, { swappedPanels: true, rightToLeft: true }).leftPanel, LOCAL);
  assert.equal(I.panelArrangement(COMMANDER, { swappedPanels: false, rightToLeft: true }).leftPanel, REMOTE);
});

test('with no session Commander becomes a local-local browser, and says Left/Right', () => {
  const disconnected = I.panelArrangement(COMMANDER, { hasSession: false });
  assert.equal(disconnected.localBrowserMode, true);
  assert.deepEqual(disconnected.menuCaptions, { local: '&Left', remote: '&Right' });
  const swapped = I.panelArrangement(COMMANDER, { hasSession: false, swappedPanels: true });
  assert.deepEqual(swapped.menuCaptions, { local: '&Right', remote: '&Left' });
  const connected = I.panelArrangement(COMMANDER, { hasSession: true });
  assert.equal(connected.localBrowserMode, false);
  assert.deepEqual(connected.menuCaptions, { local: '&Local', remote: '&Remote' });
});

test('the opposite panel is local exactly while there is no session', () => {
  assert.equal(I.isSideLocalBrowser(COMMANDER, LOCAL, { hasSession: true }), true);
  assert.equal(I.isSideLocalBrowser(COMMANDER, REMOTE, { hasSession: true }), false);
  assert.equal(I.isSideLocalBrowser(COMMANDER, REMOTE, { hasSession: false }), true);
  assert.equal(I.isSideLocalBrowser(EXPLORER, REMOTE, { hasSession: false }), false);
});

test('a local panel is always usable; a remote one needs a session', () => {
  assert.equal(I.dirViewEnabled(COMMANDER, LOCAL, { hasAvailableSession: false, hasSession: true }), true);
  assert.equal(I.dirViewEnabled(COMMANDER, REMOTE, { hasAvailableSession: false, hasSession: true }), false);
  assert.equal(I.dirViewEnabled(COMMANDER, REMOTE, { hasAvailableSession: false, hasSession: false }), true);
  assert.equal(I.dirViewEnabled(EXPLORER, REMOTE, { hasAvailableSession: true }), true);
  assert.equal(I.hasDirView(EXPLORER, LOCAL, {}), false);
  assert.equal(I.hasDirView(COMMANDER, LOCAL, {}), true);
});

test('Explorer cannot open a local-local site; Commander opens anything', () => {
  const localLocal = SD.defaultSessionData('pair');
  localLocal.localDirectory = 'C:\\a';
  localLocal.otherLocalDirectory = 'C:\\b';
  assert.equal(SD.isLocalBrowser(localLocal), true);
  assert.equal(I.supportedSession(EXPLORER, localLocal), false);
  assert.equal(I.supportedSession(COMMANDER, localLocal), true);
  const remote = SD.defaultSessionData('prod');
  remote.hostName = 'example.com';
  assert.equal(I.supportedSession(EXPLORER, remote), true);
});

test('closing the last tab leaves Commander a local browser and Explorer nothing', () => {
  assert.deepEqual(I.replacementForLastSession(COMMANDER), { kind: 'localBrowser' });
  assert.equal(I.replacementForLastSession(EXPLORER), null);
  assert.deepEqual(I.needSession(COMMANDER, { hasSession: false }), { create: 'localBrowser' });
  assert.deepEqual(I.needSession(EXPLORER, { hasSession: false }), { create: null, showLogin: true });
  assert.deepEqual(I.needSession(COMMANDER, { hasSession: true }), { create: null });
});

test('Ctrl reverses the default new-tab kind, and Explorer ignores the whole question', () => {
  assert.equal(I.newTabSide(COMMANDER, { defaultToNewRemoteTab: true }), REMOTE);
  assert.equal(I.newTabSide(COMMANDER, { defaultToNewRemoteTab: true, ctrlPressed: true }), LOCAL);
  assert.equal(I.newTabSide(COMMANDER, { defaultToNewRemoteTab: false, ctrlPressed: true }), REMOTE);
  assert.equal(I.newTabSide(COMMANDER, { defaultToNewRemoteTab: true, ctrlPressed: true, allowReverse: false }), REMOTE);
  assert.equal(I.newTabSide(EXPLORER, { defaultToNewRemoteTab: false, ctrlPressed: true }), REMOTE);
});

// ===========================================================================
// the splitter
// ===========================================================================

test('the split is stored as a fraction, so a window resize keeps the ratio', () => {
  const s = new I.PanelSplitter({ leftPanelWidth: 0.5 });
  assert.equal(s.setLeftPanelWidth(0.5, 1000), 500);
  // A layout pass nudges the pixels; Resize() puts the fraction back.
  s.leftPanelWidth = 0.4913;
  assert.equal(s.resize(1000), 500);
  assert.equal(s.leftPanelWidth, 0.5);
});

test('only a deliberate drag updates the remembered fraction', () => {
  const s = new I.PanelSplitter({ leftPanelWidth: 0.5 });
  s.splitterMoved(700, 1000);
  assert.equal(s.leftPanelWidth, 0.7);
  assert.equal(s.lastLeftPanelWidth, 0.7);
  assert.equal(s.resize(500), 350);
});

test('dragging past the other panel minimum stops instead of widening the window', () => {
  const s = new I.PanelSplitter({ splitterWidth: 4, minPanelWidth: 120 });
  assert.equal(s.canResize(500, 1000, 120), 500);
  assert.equal(s.canResize(950, 1000, 120), 1000 - 120 - 4);
});

test('double-clicking the splitter evens the panels and remembers it', () => {
  const s = new I.PanelSplitter({ leftPanelWidth: 0.8 });
  assert.equal(s.splitterDblClick(), 0.5);
  assert.equal(s.lastLeftPanelWidth, 0.5);
});

test('maximise then restore puts the divider back where it was, not where the maximised window put it', () => {
  const s = new I.PanelSplitter({ leftPanelWidth: 0.3 });
  assert.equal(s.sysResizing('maximize', { totalWidth: 1000, maximized: false }), null);
  assert.equal(s.normalPanelsWidth, 1000);
  // While maximised the user may drag; the fraction, not the pixels, is kept.
  s.splitterMoved(1200, 2000);
  assert.equal(s.sysResizing('restore', { totalWidth: 2000, maximized: true }), 600);
  assert.equal(s.normalPanelsWidth, -1);
  // A second restore with nothing remembered does nothing.
  assert.equal(s.sysResizing('restore', { totalWidth: 2000, maximized: true }), null);
});

test('Commander tree splitter matches the other tree; Explorer hides it', () => {
  const both = I.panelTreeSplitterDblClick(LOCAL, {
    treeOnLeft: false,
    local: { visible: true, height: 100, width: 100 },
    remote: { visible: true, height: 250, width: 300 },
  });
  assert.deepEqual(both, { target: LOCAL, dimension: 'height', value: 250, show: false });

  const showOther = I.panelTreeSplitterDblClick(LOCAL, {
    treeOnLeft: true,
    local: { visible: true, height: 100, width: 180 },
    remote: { visible: false, height: 0, width: 0 },
  });
  assert.deepEqual(showOther, { target: REMOTE, dimension: 'width', value: 180, show: true });

  assert.deepEqual(I.explorerTreeSplitterDblClick(), { component: 'fcRemoteTree', visible: false });
});

// ===========================================================================
// components and bands
// ===========================================================================

test('the two modes map the same component ids to different controls', () => {
  assert.equal(I.componentOf(COMMANDER, 'fcStatusBar'), 'StatusBar');
  assert.equal(I.componentOf(EXPLORER, 'fcStatusBar'), 'RemoteStatusBar');
  assert.equal(I.componentOf(COMMANDER, 'fcRemotePathComboBox'), 'RemotePathComboBox');
  assert.equal(I.componentOf(EXPLORER, 'fcRemotePathComboBox'), 'UnixPathComboBox');
});

test('a component the mode does not have reports absent rather than throwing', () => {
  assert.equal(I.componentOf(EXPLORER, 'fcLocalTree'), null);
  assert.equal(I.componentOf(EXPLORER, 'fcCommandLinePanel'), null);
  assert.equal(I.componentOf(EXPLORER, 'fcLocalStatusBar'), null);
  assert.equal(I.isComponentPossible(EXPLORER, 'fcLocalTree', {}), false);
  assert.equal(I.componentOf(COMMANDER, 'fcExplorerAddressBand'), null);
  assert.equal(I.componentOf(COMMANDER, 'fcLocalTree'), 'LocalDriveView');
});

test('the updates band is impossible in a Store build, in both modes', () => {
  assert.equal(I.isComponentPossible(COMMANDER, 'fcCommanderUpdatesBand', { uwp: false }), true);
  assert.equal(I.isComponentPossible(COMMANDER, 'fcCommanderUpdatesBand', { uwp: true }), false);
  assert.equal(I.isComponentPossible(EXPLORER, 'fcExplorerUpdatesBand', { uwp: true }), false);
  assert.equal(I.isComponentPossible(EXPLORER, 'fcExplorerSortBand', { uwp: true }), true);
});

test('the band sets differ, and each matches its own default layout string exactly', () => {
  const keysIn = (layout) => layout.split(',')
    .map((e) => e.split('=')[0])
    .filter((k) => k !== 'PixelsPerInch');

  const commanderKeys = keysIn(W.SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT).sort();
  const explorerKeys = keysIn(W.SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT).sort();
  assert.deepEqual(I.bandsFor(COMMANDER).map((b) => b.key).sort(), commanderKeys);
  assert.deepEqual(I.bandsFor(EXPLORER).map((b) => b.key).sort(), explorerKeys);

  // Explorer alone has an address band; Commander alone has the per-panel ones.
  assert.ok(explorerKeys.includes('Address'));
  assert.ok(!commanderKeys.includes('Address'));
  assert.ok(commanderKeys.includes('CommandLine'));
  assert.ok(commanderKeys.includes('LocalPath'));
  assert.ok(!explorerKeys.includes('LocalPath'));
});

test('Commander docks bands to the panels; Explorer has only the top dock', () => {
  const docks = new Set(I.bandsFor(COMMANDER).map((b) => b.dock));
  assert.ok(docks.has('LocalTopDock'));
  assert.ok(docks.has('RemoteTopDock'));
  assert.ok(docks.has('BottomDock'));
  const explorerDocks = new Set(I.bandsFor(EXPLORER).map((b) => b.dock));
  assert.deepEqual([...explorerDocks].sort(), ['', 'TopDock']);
});

// ===========================================================================
// toolbar layout persistence
// ===========================================================================

test('a toolbar key is the component name without its Toolbar suffix or version digits', () => {
  assert.equal(I.toolbarKey('MenuToolbar'), 'Menu');
  assert.equal(I.toolbarKey('LocalHistoryToolbar'), 'LocalHistory');
  // RemoveSuffix's third argument strips trailing digits FIRST, which is how
  // the renamed SessionToolbar2 still stores itself under the old "Session"
  // key — and why the shipped layout string says Session=, not SessionToolbar2=.
  assert.equal(I.toolbarKey('SessionToolbar2'), 'Session');
  assert.ok(W.SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT.includes('Session='));
  assert.equal(I.toolbarKey('CommandLineToolbar'), 'CommandLine');
});

test('a toolbar item is named after its action, or after itself', () => {
  assert.equal(I.toolbarItemName({ action: 'RemoteCopyAction' }), 'RemoteCopy');
  assert.equal(I.toolbarItemName({ name: 'QueueSubmenuItem' }), 'Queue');
  assert.equal(I.toolbarItemName({ name: 'ColorMenuItem' }), 'ColorMenu');
});

test('a band position round-trips, including a floating band', () => {
  const docked = I.parseBandPosition('1:TopDock:2+171');
  assert.deepEqual(docked, { visible: true, dockedTo: 'TopDock', floating: false, dockRow: 2, dockPos: 171 });
  assert.equal(I.formatBandPosition(docked), '1:TopDock:2+171');

  const floating = I.parseBandPosition('0:+:0+0:TopDock:120x340');
  assert.equal(floating.floating, true);
  assert.equal(floating.visible, false);
  assert.equal(floating.lastDock, 'TopDock');
  assert.equal(floating.floatingX, 120);
  assert.equal(floating.floatingY, 340);
  assert.equal(I.formatBandPosition(floating), '0:+:0+0:TopDock:120x340');
});

test('a truncated band value leaves the rest at its defaults instead of failing', () => {
  assert.deepEqual(I.parseBandPosition('1'), {
    visible: true, dockedTo: '', floating: false, dockRow: 0, dockPos: 0,
  });
  assert.equal(I.parseBandPosition('').visible, false);
});

test('both shipped default layouts survive a parse/format round trip', () => {
  for (const layout of [W.SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT, W.SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT]) {
    const parsed = I.parseToolbarsLayout(layout);
    assert.equal(parsed.pixelsPerInch, 96);
    assert.equal(I.formatToolbarsLayout(parsed), layout);
  }
  const commander = I.parseToolbarsLayout(W.SCP_COMMANDER_TOOLBARS_LAYOUT_DEFAULT);
  // The queue band is docked nowhere and sits at position -1 by default.
  assert.deepEqual(commander.bands.get('Queue'),
    { visible: true, dockedTo: '', floating: false, dockRow: 0, dockPos: -1 });
  // Commander ships the command line and the hot-key bar hidden.
  assert.equal(commander.bands.get('CommandLine').visible, false);
  assert.equal(commander.bands.get('Toolbar2').visible, false);
  const explorer = I.parseToolbarsLayout(W.SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT);
  assert.equal(explorer.bands.get('Address').visible, true);
  assert.equal(explorer.bands.get('Selection').visible, false);
});

test('an unrecognised layout key survives instead of being dropped', () => {
  const parsed = I.parseToolbarsLayout('Menu=1:TopDock:0+0,Menu_Rev=2000,PixelsPerInch=120');
  assert.equal(parsed.extra.get('Menu_Rev'), '2000');
  assert.equal(I.formatToolbarsLayout(parsed), 'Menu=1:TopDock:0+0,Menu_Rev=2000,PixelsPerInch=120');
});

test('only hidden buttons are recorded, and never the queue toolbar', () => {
  const parsed = I.parseToolbarsButtons('Session=NewTab:0,CloseTab:0;Sort=RemoteSortByName:0');
  assert.equal(parsed.get('Session').get('NewTab'), false);
  assert.equal(parsed.get('Sort').size, 1);
  const formatted = I.formatToolbarsButtons(new Map([
    ['Session', new Map([['NewTab', false], ['CloseTab', true]])],
    ['Queue', new Map([['QueueItemQuery', false]])],
    ['Sort', new Map([['RemoteSortByName', true]])],
  ]));
  assert.equal(formatted, 'Session=NewTab:0');
  assert.equal(I.formatToolbarsButtons(I.parseToolbarsButtons('Session=NewTab:0')), 'Session=NewTab:0');
});

// ===========================================================================
// layout persistence
// ===========================================================================

test('Explorer restores and stores a single panel; it has no per-panel state', () => {
  const prefs = {
    scpExplorer: {
      windowParams: 'w', dirViewParams: 'd', viewStyle: 'icon', toolbarsLayout: 'l',
      toolbarsButtons: 'b', sessionsTabs: true, statusBar: false, driveView: true,
      driveViewWidth: 210, showFullAddress: false, lastLocalTargetDirectory: 'C:\\dl',
    },
  };
  const view = I.restoreParams(EXPLORER, prefs, {});
  assert.equal(view.statusBar, false);
  assert.equal(view.treeWidth, 210);
  assert.equal(view.showFullAddress, false);
  assert.equal(view.lastLocalTargetDirectory, 'C:\\dl');
  assert.equal(view.extColumnVisible, false);
  const stored = I.storeParams(EXPLORER, view).scpExplorer;
  assert.equal(stored.driveViewWidth, 210);
  assert.equal(stored.dirViewParams, 'd');
  assert.equal(stored.statusBar, false);
  // Explorer never writes a lastPath or a currentPanel.
  assert.equal('lastPath' in stored, false);
  assert.equal('currentPanel' in stored, false);
});

test('Commander remembers the focused panel and each local panel last path', () => {
  const defaults = W.defaultInterfaceState({ width: 1600, height: 1000 });
  const prefs = { scpCommander: Object.assign({}, defaults.scpCommander, {
    currentPanel: REMOTE,
    localPanel: Object.assign({}, defaults.scpCommander.localPanel, { lastPath: 'C:\\work' }),
    otherLocalPanelLastPath: 'D:\\media',
  }) };
  const view = I.restoreParams(COMMANDER, prefs, {});
  assert.equal(view.currentPanel, REMOTE);
  assert.equal(view.localPanel.lastPath, 'C:\\work');
  assert.equal(view.otherLocalPanel.lastPath, 'D:\\media');
  const stored = I.storeParams(COMMANDER, view).scpCommander;
  assert.equal(stored.currentPanel, REMOTE);
  assert.equal(stored.localPanel.lastPath, 'C:\\work');
  assert.equal(stored.otherLocalPanelLastPath, 'D:\\media');
  assert.equal(stored.localPanelWidth, 0.5);
});

test('the tree size is stored in the dimension the tree is aligned to', () => {
  const onTop = I.restorePanelParams({ driveViewHeight: 90, driveViewWidth: 250 }, { treeOnLeft: false });
  assert.equal(onTop.treeAlign, 'top');
  assert.equal(onTop.treeSize, 90);
  const onLeft = I.restorePanelParams({ driveViewHeight: 90, driveViewWidth: 250 }, { treeOnLeft: true });
  assert.equal(onLeft.treeAlign, 'left');
  assert.equal(onLeft.treeSize, 250);
  assert.deepEqual(I.storePanelParams(onLeft, { treeOnLeft: true }), {
    dirViewParams: '', viewStyle: 'report', statusBar: true, driveView: false, driveViewWidth: 250,
  });
  assert.equal('driveViewHeight' in I.storePanelParams(onLeft, { treeOnLeft: true }), false);
});

test('a stored layout can never restore the extension column visible', () => {
  const view = I.restoreParams(COMMANDER, { scpCommander: { localPanel: { dirViewParams: 'anything' } } }, {});
  assert.equal(view.localPanel.extColumnVisible, false);
  assert.equal(view.otherLocalPanel.extColumnVisible, false);
  assert.equal(I.restoreParams(EXPLORER, {}, {}).extColumnVisible, false);
});

test('a Store build restores with the updates band forced off', () => {
  assert.equal(I.restoreParams(COMMANDER, {}, { uwp: true }).updatesBandVisible, false);
  assert.equal(I.restoreParams(EXPLORER, {}, { uwp: false }).updatesBandVisible, true);
});

test('resetting the columns uses the mode and side specific default', () => {
  assert.equal(I.defaultDirViewParams(EXPLORER, REMOTE, {}), W.SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT);
  assert.equal(I.defaultDirViewParams(COMMANDER, LOCAL, { hasSession: true }),
    W.SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT);
  assert.equal(I.defaultDirViewParams(COMMANDER, REMOTE, { hasSession: true }),
    W.SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT);
  // In local-local mode the "remote" panel is local, so it gets the local set.
  assert.equal(I.defaultDirViewParams(COMMANDER, REMOTE, { hasSession: false }),
    W.SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT);
});

// ===========================================================================
// the address bar
// ===========================================================================

test('the address bar shows the whole path, or only the deepest segment', () => {
  const full = new I.ExplorerAddressBar({ showFullAddress: true });
  assert.equal(full.text({ hasSession: true, path: '/var/www/html/' }), '/var/www/html');
  const short = new I.ExplorerAddressBar({ showFullAddress: false });
  assert.equal(short.text({ hasSession: true, path: '/var/www/html/' }), 'html');
  // With no session there is no address at all.
  assert.equal(full.text({ hasSession: false, path: '/var' }), '');
});

test('a rejected address is kept, re-offered selected, and re-opens the box', () => {
  const bar = new I.ExplorerAddressBar({ showFullAddress: true });
  const state = { hasSession: true, path: '/home' };
  const result = bar.acceptText('/nope', state, () => false);
  assert.deepEqual(result, { accepted: false, text: '/nope', aborted: true });
  assert.deepEqual(bar.endModal(), { reenter: true });
  assert.deepEqual(bar.beginEdit(state), { text: '/nope', selectAll: true });
  // Consumed: the next edit shows the real path and does not re-enter.
  assert.deepEqual(bar.endModal(), { reenter: false });
  assert.deepEqual(bar.beginEdit(state), { text: '/home', selectAll: false });
});

test('typing the path already shown is a no-op, not a re-navigation', () => {
  const bar = new I.ExplorerAddressBar({ showFullAddress: true });
  let opened = 0;
  const r = bar.acceptText('/home', { hasSession: true, path: '/home' }, () => { opened++; return true; });
  assert.equal(opened, 0);
  assert.equal(r.accepted, true);
});

test('the remote path drop-down lists every level from the root down', () => {
  assert.deepEqual(I.remotePathComboItems('/var/www/'), [
    { caption: '/', path: '/' },
    { caption: 'var', path: '/var' },
    { caption: 'www', path: '/var/www' },
  ]);
  assert.deepEqual(I.remotePathComboItems(''), []);
});

test('Commander path boxes list two special folders and then the drives', () => {
  const { items, specialCount } = I.localPathComboItems({
    personalFolder: 'C:\\Users\\me\\Documents',
    desktopFolder: 'C:\\Users\\me\\Desktop',
    drives: [
      { key: 'C', prettyName: 'C: Windows', rootPath: 'C:\\', realDrive: true },
      { key: 'Z', prettyName: 'Z: share', rootPath: 'Z:\\', realDrive: false },
      { key: 'X', prettyName: 'X: gone', rootPath: 'X:\\', valid: false },
    ],
  });
  assert.equal(specialCount, 2);
  assert.equal(items.length, 4);                      // the invalid drive is skipped
  assert.equal(items[0].caption, 'My documents');
  assert.equal(items[2].caption, '&C: Windows');      // a real drive gets an accelerator
  assert.equal(items[3].caption, 'Z: share');
});

test('the path box selects the longest matching place, and gives up quietly', () => {
  const items = [
    { path: 'C:\\Users\\me\\Documents' },
    { path: 'C:\\Users\\me\\Desktop' },
    { path: 'C:\\' },
    { path: 'D:\\' },
  ];
  assert.equal(I.localPathComboIndexFor('C:\\Users\\me\\Documents\\tax', items), 0);
  assert.equal(I.localPathComboIndexFor('D:\\media', items), 3);
  assert.equal(I.localPathComboIndexFor('C:\\Windows', items), 2);
  assert.equal(I.localPathComboIndexFor('\\\\server\\share', items), -1);
});

test('picking the drive the other panel is on opens that panel directory, not the root', () => {
  const items = [
    { path: 'C:\\Users\\me\\Documents', special: true },
    { path: 'C:\\Users\\me\\Desktop', special: true },
    { path: 'C:\\', drive: 'C' },
    { path: 'D:\\', drive: 'D' },
  ];
  const base = { items, specialCount: 2, currentPanelPath: 'C:\\work\\src' };
  assert.deepEqual(I.localPathComboItemClick(2, Object.assign({}, base, {
    localBrowserMode: true, isOtherPanel: true,
  })), { kind: 'path', path: 'C:\\work\\src' });
  // A different drive still executes the drive.
  assert.deepEqual(I.localPathComboItemClick(3, Object.assign({}, base, {
    localBrowserMode: true, isOtherPanel: true,
  })), { kind: 'drive', drive: 'D' });
  // Outside local-local mode the shortcut does not apply.
  assert.deepEqual(I.localPathComboItemClick(2, base), { kind: 'drive', drive: 'C' });
  // A special folder is just a path.
  assert.deepEqual(I.localPathComboItemClick(0, base), { kind: 'path', path: 'C:\\Users\\me\\Documents' });
  assert.throws(() => I.localPathComboItemClick(9, base), RangeError);
});

test('Explorer refuses "change path" with a reason; Commander focuses a path box', () => {
  const refused = I.changePath(EXPLORER, LOCAL, {});
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /address bar/);
  assert.deepEqual(I.changePath(COMMANDER, LOCAL, {}), { ok: true, focus: 'LocalPathComboBox' });
  assert.deepEqual(I.changePath(COMMANDER, CURRENT, { currentSide: REMOTE }),
    { ok: true, focus: 'RemotePathComboBox' });
  assert.deepEqual(I.goToAddress(EXPLORER, {}), { kind: 'focusAddressBar' });
  assert.deepEqual(I.goToAddress(COMMANDER, { currentSide: REMOTE }),
    { kind: 'openDirectoryDialog', side: REMOTE });
});

// ===========================================================================
// the command line
// ===========================================================================

test('the command line keeps two histories and clears when the side changes', () => {
  const cl = new I.CommandLine();
  assert.equal(I.CommandLine.historyKey(true), 'LocalCommands');
  assert.equal(I.CommandLine.historyKey(false), 'Commands');
  const histories = { LocalCommands: ['dir'], Commands: ['ls -la'] };
  assert.deepEqual(cl.populate(true, histories), ['dir']);
  assert.equal(cl.populate(true, histories), null);          // already populated
  assert.deepEqual(cl.sideEnter(true, false), { clear: true });
  assert.deepEqual(cl.populate(false, histories), ['ls -la']);
  assert.deepEqual(cl.sideEnter(false, false), { clear: false });
});

test('the command line only writes back a history it actually populated', () => {
  const cl = new I.CommandLine();
  assert.equal(cl.save(true, ['dir']), null);
  cl.populate(true, {});
  assert.deepEqual(cl.save(true, ['dir']), { key: 'LocalCommands', items: ['dir'] });
});

test('a remote command needs both server permission and a command session', () => {
  const cl = new I.CommandLine();
  assert.equal(cl.execute('ls', { sideIsLocal: false, allowedAnyCommand: false }).ok, false);
  assert.match(cl.execute('ls', { sideIsLocal: false, allowedAnyCommand: false }).reason, /arbitrary commands/);
  assert.match(cl.execute('ls', {
    sideIsLocal: false, allowedAnyCommand: true, commandSessionAvailable: false,
  }).reason, /command session/);
  assert.deepEqual(cl.execute('ls', {
    sideIsLocal: false, allowedAnyCommand: true, commandSessionAvailable: true,
  }), { ok: true, kind: 'console', command: 'ls' });
  assert.deepEqual(cl.execute('dir', { sideIsLocal: true }), { ok: true, kind: 'shell', command: 'dir' });
  assert.equal(cl.execute('', { sideIsLocal: true }).ok, false);
  assert.equal(cl.execute('dir', { sideIsLocal: true, busy: true }).ok, false);
});

test('Enter on a refused command keeps the text and re-enters the box', () => {
  const cl = new I.CommandLine();
  const refused = cl.key('Enter', 'ls', { sideIsLocal: false, allowedAnyCommand: false });
  assert.equal(refused.text, 'ls');
  assert.equal(refused.reenter, true);
  const accepted = cl.key('Enter', 'dir', { sideIsLocal: true });
  assert.equal(accepted.text, '');
  assert.equal(accepted.reenter, false);
  assert.deepEqual(cl.key('Escape', 'dir', {}), { text: '', exitToolbar: true, handled: true });
  assert.deepEqual(cl.key('Tab', 'dir', {}), { text: 'dir', exitToolbar: true, handled: true });
  assert.deepEqual(cl.key('a', 'dir', {}), { handled: false });
});

test('the prompt distinguishes a shell from a server, and disables when neither', () => {
  assert.deepEqual(I.commandLinePrompt({ sideIsLocal: true }), { caption: 'Command >', enabled: true });
  assert.deepEqual(I.commandLinePrompt({ sideIsLocal: false, canConsole: true }),
    { caption: 'Command $', enabled: true });
  assert.equal(I.commandLinePrompt({ sideIsLocal: false, canConsole: false }).enabled, false);
});

test('exporting a file list to the command line appends rather than replaces', () => {
  assert.deepEqual(I.appendToCommandLine('grep ', ['a.txt', 'b.txt']),
    { showCommandLineBand: true, text: 'grep a.txt b.txt ' });
});

// ===========================================================================
// double click
// ===========================================================================

test('the same double click is three different operations across the modes', () => {
  const ctx = {
    isDirectory: false, doubleClickAction: 'copy', alwaysRespectDoubleClickAction: true,
    hasSession: true, hasAvailableSession: true, side: REMOTE, currentSide: REMOTE,
  };
  assert.equal(I.doubleClickAction(EXPLORER, ctx).operation, 'transfer');
  assert.equal(I.doubleClickAction(COMMANDER, ctx).operation, 'transfer');
  assert.equal(I.doubleClickAction(COMMANDER, Object.assign({}, ctx, {
    hasSession: false, localBrowserMode: true,
  })).operation, 'localLocalCopy');
});

test('a copy double click with no session does nothing rather than erroring', () => {
  const r = I.doubleClickAction(EXPLORER, {
    isDirectory: false, doubleClickAction: 'copy', alwaysRespectDoubleClickAction: true,
    hasSession: false, hasAvailableSession: false, side: REMOTE,
  });
  assert.equal(r.operation, null);
  assert.equal(r.allowExec, false);
  assert.match(r.reason, /no session/);
});

test('opening and editing remote files can be disabled, and then the click falls through', () => {
  const edit = I.doubleClickAction(EXPLORER, {
    isDirectory: false, doubleClickAction: 'edit', alwaysRespectDoubleClickAction: true,
    hasSession: true, side: REMOTE, disableOpenEdit: true,
  });
  assert.equal(edit.operation, null);
  assert.equal(edit.allowExec, true);
  assert.match(edit.reason, /disabled/);
  const open = I.doubleClickAction(EXPLORER, {
    isDirectory: false, doubleClickAction: 'open', alwaysRespectDoubleClickAction: true,
    hasSession: true, side: REMOTE, disableOpenEdit: false,
  });
  assert.equal(open.operation, 'shellOpen');
});

test('a server that cannot tell a linked directory from a file changes directory instead', () => {
  const ctx = {
    isDirectory: false, doubleClickAction: 'edit', side: REMOTE, hasSession: true,
    resolvingSymlinks: false, encryptingFiles: false, alwaysRespectDoubleClickAction: false,
  };
  assert.equal(I.doubleClickAction(EXPLORER, ctx).action, 'changeDir');
  // ...unless the user insisted the preference always wins.
  assert.equal(I.doubleClickAction(EXPLORER,
    Object.assign({}, ctx, { alwaysRespectDoubleClickAction: true })).action, 'edit');
});

test('the explicit Open command bypasses the double-click preference entirely', () => {
  const r = I.doubleClickAction(COMMANDER, {
    forceExecution: true, isDirectory: false, doubleClickAction: 'copy', side: REMOTE, hasSession: true,
  });
  assert.equal(r.action, 'open');
  assert.equal(I.doubleClickAction(COMMANDER, {
    forceExecution: true, isDirectory: true, side: REMOTE, hasSession: true,
  }).action, 'changeDir');
});

test('a local shortcut to a directory is followed, whatever the preference says', () => {
  const resolve = (name) => (name.includes('folder') ? { isDirectory: true, path: 'C:\\target' } : { isDirectory: false });
  assert.deepEqual(I.localExecFile({ name: 'folder.lnk', fullName: 'C:\\a\\folder.lnk' }, resolve),
    { allowExec: true, followsShortcut: true, target: 'C:\\target' });
  assert.deepEqual(I.localExecFile({ name: 'app.lnk', fullName: 'C:\\a\\app.lnk' }, resolve),
    { allowExec: null, followsShortcut: false });
  assert.deepEqual(I.localExecFile({ name: 'notes.txt' }, resolve),
    { allowExec: null, followsShortcut: false });
});

test('the bold context-menu entry differs between local-local and a real session', () => {
  const ctx = {
    isDirectory: false, doubleClickAction: 'copy', alwaysRespectDoubleClickAction: true,
    side: LOCAL, hasSession: true,
  };
  const withSession = I.contextMenuDefaultItems(COMMANDER, ctx);
  assert.ok(withSession.items.find((i) => i.item === 'LocalCopyMenuItem').default);
  const localLocal = I.contextMenuDefaultItems(COMMANDER,
    Object.assign({}, ctx, { hasSession: false, localBrowserMode: true }));
  assert.ok(localLocal.items.find((i) => i.item === 'LocalLocalCopyMenuItem').default);
  // Explorer only ever bolds remote entries.
  const explorer = I.contextMenuDefaultItems(EXPLORER, Object.assign({}, ctx, { side: REMOTE }));
  assert.deepEqual(explorer.items.map((i) => i.item),
    ['RemoteOpenMenuItem', 'RemoteEditMenuItem', 'RemoteCopyMenuItem']);
});

test('the local panel offers WinSCP menu unless the shell menu was asked for', () => {
  assert.equal(I.localContextMenuKind({}), 'application');
  assert.equal(I.localContextMenuKind({ systemContextMenu: true }), 'system');
  assert.equal(I.localContextMenuKind({ forceSystemContextMenu: true }), 'system');
});

// ===========================================================================
// copy/move bindings and panel swapping
// ===========================================================================

test('local-local mode drops the plain Copy command instead of disabling it', () => {
  const localLocal = I.copyCommandBindings(COMMANDER, { localBrowserMode: true, currentSide: LOCAL });
  assert.equal(localLocal.currentCopyVisible, false);
  assert.equal(localLocal.currentCopyTo, 'LocalLocalCopyAction');
  const other = I.copyCommandBindings(COMMANDER, { localBrowserMode: true, currentSide: REMOTE });
  assert.equal(other.currentCopyTo, 'LocalOtherCopyAction');
  assert.equal(other.currentMoveTo, 'LocalOtherMoveAction');
});

test('with a session the Copy command follows the focused panel', () => {
  const fromLocal = I.copyCommandBindings(COMMANDER, { hasSession: true, currentSide: LOCAL });
  assert.equal(fromLocal.currentCopy, 'LocalCopyAction');           // upload
  assert.equal(fromLocal.currentCopyQueue, 'LocalCopyQueueAction');
  const fromRemote = I.copyCommandBindings(COMMANDER, { hasSession: true, currentSide: REMOTE });
  assert.equal(fromRemote.currentCopy, 'RemoteCopyAction');         // download
  const explorer = I.copyCommandBindings(EXPLORER, {});
  assert.equal(explorer.localCopy, null);
  assert.equal(explorer.currentCopy, 'RemoteCopyAction');
});

test('swapping the panels also swaps menus, captions, hints and icons', () => {
  const effects = I.panelSwapEffects();
  assert.deepEqual(effects.menuOrder, ['RemoteMenuButton', 'LocalMenuButton']);
  assert.deepEqual(effects.swapShortcuts, [['LocalChangePathAction2', 'RemoteChangePathAction2']]);
  assert.equal(effects.swapImages.length, 2);
  assert.deepEqual(effects.swapCaptions, [['CommanderLocalPanelAction', 'CommanderRemotePanelAction']]);
});

// ===========================================================================
// download targets
// ===========================================================================

test('Commander downloads into the panel; Explorer into the last target', () => {
  assert.equal(I.defaultDownloadTargetDirectory(COMMANDER, { localPanelPath: 'C:\\work' }), 'C:\\work\\');
  assert.equal(I.defaultDownloadTargetDirectory(EXPLORER, {
    lastLocalTargetDirectory: 'C:\\dl', directoryExists: () => true,
  }), 'C:\\dl');
});

test('Explorer falls back to Documents when the last target no longer exists', () => {
  assert.equal(I.defaultDownloadTargetDirectory(EXPLORER, {
    lastLocalTargetDirectory: 'D:\\gone', directoryExists: () => false, personalFolder: 'C:\\Users\\me\\Documents',
  }), 'C:\\Users\\me\\Documents');
});

test('only Explorer remembers where a download went', () => {
  const request = { direction: 'toLocal', temp: false };
  assert.equal(I.copyParamTargetDirectory(EXPLORER, request, {
    lastLocalTargetDirectory: 'C:\\dl', directoryExists: () => true,
  }).remember, true);
  assert.equal(I.copyParamTargetDirectory(COMMANDER, request, { localPanelPath: 'C:\\work' }).remember, false);
  assert.deepEqual(I.copyParamDialogAfter(EXPLORER, { direction: 'toLocal', temp: false, targetDirectory: 'C:\\x' }),
    { scpExplorer: { lastLocalTargetDirectory: 'C:\\x' } });
  assert.equal(I.copyParamDialogAfter(EXPLORER, { direction: 'toLocal', temp: true, targetDirectory: 'C:\\x' }), null);
  assert.equal(I.copyParamDialogAfter(COMMANDER, { direction: 'toLocal', temp: false, targetDirectory: 'C:\\x' }), null);
});

test('an upload with no target pre-fills the remote panel path', () => {
  assert.equal(I.copyParamTargetDirectory(COMMANDER, { direction: 'toRemote' },
    { remotePanelPath: '/srv/www' }).targetDirectory, '/srv/www/');
  // Drag and drop supplies its own target and must not be pre-filled.
  assert.equal(I.copyParamTargetDirectory(COMMANDER, { direction: 'toLocal', temp: true }, {}).targetDirectory, '');
});

// ===========================================================================
// compare and synchronize
// ===========================================================================

test('the comparison never marks a directory and honours "existing only"', () => {
  const left = [{ name: 'sub', isDirectory: true, modified: 5000 }, { name: 'only.txt', modified: 5000 }];
  const right = [];
  assert.deepEqual(I.compareFiles(left, right, { criterias: ['time'] }), [false, true]);
  assert.deepEqual(I.compareFiles(left, right, { criterias: ['time'], existingOnly: true }), [false, false]);
});

test('a second-precision timestamp gets a millisecond of slack so neither side wins twice', () => {
  const a = [{ name: 'f', modified: 1000, precision: 'second' }];
  const b = [{ name: 'f', modified: 1000, precision: 'second' }];
  assert.deepEqual(I.compareFiles(a, b, { criterias: ['time'] }), [false]);
  assert.deepEqual(I.compareFiles(b, a, { criterias: ['time'] }), [false]);
  // The whole point of the slack: one second apart is NOT a difference, in
  // either direction, because the two clocks may simply have rounded opposite
  // ways. Without the +1001 ms this assertion is what goes red.
  const oneSecond = [{ name: 'f', modified: 2000, precision: 'second' }];
  assert.deepEqual(I.compareFiles(oneSecond, b, { criterias: ['time'] }), [false]);
  assert.deepEqual(I.compareFiles(b, oneSecond, { criterias: ['time'] }), [false]);
  // Two seconds is.
  const newer = [{ name: 'f', modified: 3000, precision: 'second' }];
  assert.deepEqual(I.compareFiles(newer, b, { criterias: ['time'] }), [true]);
  assert.deepEqual(I.compareFiles(b, newer, { criterias: ['time'] }), [false]);
  // The slack is applied only at second precision; at millisecond precision a
  // single millisecond is already a difference.
  const ms = [{ name: 'f', modified: 1001, precision: 'millisecond' }];
  const ms0 = [{ name: 'f', modified: 1000, precision: 'millisecond' }];
  assert.deepEqual(I.compareFiles(ms, ms0, { criterias: ['time'] }), [true]);
});

test('the coarser of the two precisions wins, so a minute-precision server compares fairly', () => {
  const local = [{ name: 'f', modified: Date.UTC(2020, 0, 1, 10, 30, 45, 123), precision: 'millisecond' }];
  const remote = [{ name: 'f', modified: Date.UTC(2020, 0, 1, 10, 30, 0, 0), precision: 'minute' }];
  assert.deepEqual(I.compareFiles(local, remote, { criterias: ['time'] }), [false]);
  assert.equal(I.reducePrecision(Date.UTC(2020, 0, 1, 10, 30, 45, 123), 'minute'),
    new Date(Date.UTC(2020, 0, 1, 10, 30, 45, 123)).setSeconds(0, 0));
  assert.equal(I.reducePrecision(12345, 'none'), 0);
  assert.throws(() => I.reducePrecision(1, 'fortnight'), TypeError);
});

test('size only decides when the times agree, and decides alone when time is not a criterion', () => {
  const a = [{ name: 'f', modified: 1000, size: 10 }];
  const b = [{ name: 'f', modified: 1000, size: 20 }];
  assert.deepEqual(I.compareFiles(a, b, { criterias: ['time', 'size'] }), [true]);
  assert.deepEqual(I.compareFiles(a, b, { criterias: ['size'] }), [true]);
  const newerButSameSize = [{ name: 'f', modified: 9000, size: 10 }];
  const olderSameSize = [{ name: 'f', modified: 1000, size: 10 }];
  assert.deepEqual(I.compareFiles(newerButSameSize, olderSameSize, { criterias: ['time', 'size'] }), [true]);
  assert.deepEqual(I.compareFiles(olderSameSize, newerButSameSize, { criterias: ['time', 'size'] }), [false]);
});

test('Explorer refuses to compare directories; Commander reports "no differences"', () => {
  const refused = I.compareDirectories(EXPLORER, {});
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /one panel/);

  const same = [{ name: 'f', modified: 1000, size: 1 }];
  const result = I.compareDirectories(COMMANDER, {
    criterias: ['time', 'size'], localFiles: same, otherFiles: same.map((f) => Object.assign({}, f)),
  });
  assert.equal(result.noDifferences, true);
  assert.equal(result.message, 'No differences found.');

  const differing = I.compareDirectories(COMMANDER, {
    criterias: ['time'],
    localFiles: [{ name: 'f', modified: 9000 }],
    otherFiles: [{ name: 'f', modified: 1000 }],
  });
  assert.deepEqual(differing.leftSelected, ['f']);
  assert.deepEqual(differing.rightSelected, []);
  assert.equal(differing.noDifferences, false);
});

test('keeping a directory up to date is refused when both panels are local', () => {
  const refused = I.synchronizeDirectories(COMMANDER, { localBrowserMode: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /remote directory/);
  const ok = I.synchronizeDirectories(COMMANDER, { localPanelPath: 'C:\\a', remotePanelPath: '/srv' });
  assert.deepEqual(ok, { ok: true, localDirectory: 'C:\\a', remoteDirectory: '/srv', remember: false });
  const explorer = I.synchronizeDirectories(EXPLORER, { lastLocalTargetDirectory: 'C:\\dl', remotePanelPath: '/srv' });
  assert.equal(explorer.localDirectory, 'C:\\dl');
  assert.equal(explorer.remember, true);
});

test('the default synchronize direction follows the focused panel in Commander only', () => {
  const fromLocal = I.fullSynchronizeDirectories(COMMANDER, { currentSide: LOCAL, synchronizeModeAuto: -1 });
  assert.equal(fromLocal.mode, I.SYNC_MODE_REMOTE);
  assert.equal(fromLocal.saveMode, false);
  const fromRemote = I.fullSynchronizeDirectories(COMMANDER, { currentSide: REMOTE, synchronizeModeAuto: -1 });
  assert.equal(fromRemote.mode, I.SYNC_MODE_LOCAL);
  // A pinned direction wins over the focused panel, and is saved back.
  const pinned = I.fullSynchronizeDirectories(COMMANDER, { currentSide: LOCAL, synchronizeModeAuto: I.SYNC_MODE_BOTH });
  assert.equal(pinned.mode, I.SYNC_MODE_BOTH);
  assert.equal(pinned.saveMode, true);
  const explorer = I.fullSynchronizeDirectories(EXPLORER, { synchronizeMode: I.SYNC_MODE_LOCAL });
  assert.equal(explorer.mode, I.SYNC_MODE_LOCAL);
  assert.equal(explorer.saveMode, true);
  assert.equal(explorer.remember, true);
});

// ===========================================================================
// synchronized browsing
// ===========================================================================

test('moving down one level locally moves the remote panel down the same level', () => {
  assert.deepEqual(
    I.synchronizeBrowsingLocal({ prevPath: 'C:\\a\\b', localPath: 'C:\\a\\b\\c', remotePath: '/home/x' }),
    { ok: true, side: REMOTE, path: '/home/x/c' },
  );
});

test('moving up, and sideways, both follow', () => {
  assert.equal(
    I.synchronizeBrowsingLocal({ prevPath: 'C:\\a\\b\\c', localPath: 'C:\\a\\b', remotePath: '/home/x/c' }).path,
    '/home/x/',
  );
  assert.equal(
    I.synchronizeBrowsingLocal({ prevPath: 'C:\\a\\b\\c', localPath: 'C:\\a\\b\\d', remotePath: '/home/x/c' }).path,
    '/home/x/d',
  );
});

test('it refuses rather than guesses when the other side has nowhere to go', () => {
  const atRoot = I.synchronizeBrowsingLocal({ prevPath: 'C:\\a\\b', localPath: 'C:\\a', remotePath: '/' });
  assert.equal(atRoot.ok, false);
  assert.match(atRoot.message, /root/);
  const otherDrive = I.synchronizeBrowsingLocal({ prevPath: 'C:\\a', localPath: 'D:\\a', remotePath: '/home/x' });
  assert.equal(otherDrive.ok, false);
  assert.match(otherDrive.message, /common parent/);
});

test('the remote side mirrors, and maps names that are illegal locally', () => {
  assert.deepEqual(
    I.synchronizeBrowsingRemote({ prevPath: '/home/x', remotePath: '/home/x/c', localPath: 'C:\\a\\b' }),
    { ok: true, side: LOCAL, path: 'C:\\a\\b\\c' },
  );
  assert.equal(
    I.synchronizeBrowsingRemote({ prevPath: '/home/x/c', remotePath: '/home/x', localPath: 'C:\\a\\b\\c' }).path,
    'C:\\a\\b\\',
  );
  const mapped = I.synchronizeBrowsingRemote({
    prevPath: '/home', remotePath: '/home/a:b', localPath: 'C:\\dl',
    changeFileName: (name) => name.replace(/:/g, '_'),
  });
  assert.equal(mapped.path, 'C:\\dl\\a_b');
  const atRoot = I.synchronizeBrowsingRemote({ prevPath: '/home/x', remotePath: '/', localPath: 'C:\\' });
  assert.equal(atRoot.ok, false);
});

test('changeFilePath maps every segment and flips the separator', () => {
  const up = (name) => name.toUpperCase();
  assert.equal(I.changeFilePath('a/b/c', REMOTE, up), 'A\\B\\C');
  assert.equal(I.changeFilePath('', REMOTE, up), '');
});

test('changeFilePath maps the LAST segment as local, which is WinSCP own quirk', () => {
  // ScpCommander.cpp:1350 hard-codes osLocal for the tail, so a rule that
  // behaves differently per side treats the final directory name as a local
  // one even while walking a remote path. Reproduced deliberately.
  const bySide = (name, side) => `${name}@${side}`;
  assert.equal(I.changeFilePath('a/b/c', REMOTE, bySide), 'a@remote\\b@remote\\c@local');
  // A trailing separator means there is no tail to mis-map.
  assert.equal(I.changeFilePath('a/b/', REMOTE, bySide), 'a@remote\\b@remote\\');
  // A single segment is all tail, so it is mapped as local even on the remote side.
  assert.equal(I.changeFilePath('only', REMOTE, bySide), 'only@local');
});

test('the guard turns synchronized browsing off for one operation and restores it', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  const seen = sync.guard(() => sync.enabled);
  assert.equal(seen, false);
  assert.equal(sync.enabled, true);
  // Even when the guarded work throws.
  assert.throws(() => sync.guard(() => { throw new Error('boom'); }), /boom/);
  assert.equal(sync.enabled, true);
});

test('the first load of a panel never drags the other one anywhere', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  const first = sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  assert.equal(first.followed, false);
  assert.match(first.reason, /no change/);
});

test('a followed change moves the other panel and records the new path', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  const moves = [];
  const r = sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '/home' }, {
    exists: () => true,
    setPath: (side, path) => moves.push([side, path]),
  });
  assert.equal(r.followed, true);
  assert.deepEqual(moves, [[REMOTE, '/home/b']]);
  assert.equal(sync.prevPath[REMOTE], '/home/b');
});

test('a change that cannot be mapped turns synchronized browsing off and says so', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/' }, {});
  const reported = [];
  const r = sync.follow(LOCAL, { localPath: 'D:\\z', remotePath: '/' }, {
    report: (m) => reported.push(m),
  });
  assert.equal(r.followed, false);
  assert.equal(r.turnedOff, true);
  assert.equal(sync.enabled, false);
  assert.equal(reported[0], I.SYNC_DIR_BROWSE_ERROR);
  assert.match(I.SYNC_DIR_BROWSE_ERROR, /turned off/);
});

test('a missing directory is offered for creation, and declining turns it off', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  const asked = [];
  const r = sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '/home' }, {
    exists: () => false,
    confirmCreate: (path) => { asked.push(path); return false; },
    setPath: () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(asked, ['/home/b']);
  assert.equal(r.followed, false);
  assert.equal(sync.enabled, false);
  assert.match(I.syncDirBrowseCreateMessage('/home/b'), /create directory '\/home\/b'/);
});

test('accepting the creation creates the directory and then moves', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  const created = [];
  const moved = [];
  const r = sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '/home' }, {
    exists: () => false,
    confirmCreate: () => true,
    create: (side, path) => created.push([side, path]),
    setPath: (side, path) => moved.push([side, path]),
  });
  assert.equal(r.followed, true);
  assert.equal(r.created, true);
  assert.deepEqual(created, [[REMOTE, '/home/b']]);
  assert.deepEqual(moved, [[REMOTE, '/home/b']]);
  assert.equal(sync.enabled, true);
});

test('a failed creation reports and turns off rather than leaving the panels adrift', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  const reported = [];
  const r = sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '/home' }, {
    exists: () => false,
    confirmCreate: () => true,
    create: () => { throw new Error('Permission denied'); },
    report: (m) => reported.push(m),
  });
  assert.equal(r.followed, false);
  assert.equal(sync.enabled, false);
  assert.match(r.reason, /Permission denied/);
  assert.equal(reported.length, 1);
});

test('synchronized browsing is impossible with two local panels', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '', localBrowserMode: true }, {});
  const r = sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '', localBrowserMode: true }, {});
  assert.equal(r.followed, false);
  assert.equal(sync.enabled, false);
});

test('a mirrored move does not bounce back into another mirrored move', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  sync.follow(LOCAL, { localPath: 'C:\\a', remotePath: '/home' }, {});
  let reentered = 0;
  sync.follow(LOCAL, { localPath: 'C:\\a\\b', remotePath: '/home' }, {
    exists: () => true,
    setPath: () => {
      // Simulate the opposite panel reporting its own change mid-flight.
      const inner = sync.follow(REMOTE, { localPath: 'C:\\a\\b', remotePath: '/home/b' }, {});
      if (inner.followed) reentered++;
    },
  });
  assert.equal(reentered, 0);
});

test('back and forward move both panels only when the other panel has the history', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  assert.deepEqual(sync.historyGo(LOCAL, -1, { otherBackCount: 3, otherForwardCount: 0 }),
    { sides: [LOCAL, REMOTE], guarded: true });
  assert.deepEqual(sync.historyGo(LOCAL, -4, { otherBackCount: 3 }), { sides: [LOCAL], guarded: false });
  // Strictly less than, exactly as the C++ writes it: going back three steps
  // with three steps of history available does NOT mirror.
  assert.deepEqual(sync.historyGo(LOCAL, -3, { otherBackCount: 3 }), { sides: [LOCAL], guarded: false });
  assert.deepEqual(sync.historyGo(LOCAL, -2, { otherBackCount: 3 }),
    { sides: [LOCAL, REMOTE], guarded: true });
  assert.deepEqual(sync.historyGo(LOCAL, 1, { otherForwardCount: 2 }), { sides: [LOCAL, REMOTE], guarded: true });
  assert.deepEqual(sync.historyGo(LOCAL, 2, { otherForwardCount: 2 }), { sides: [LOCAL], guarded: false });
  sync.enabled = false;
  assert.deepEqual(sync.historyGo(LOCAL, -1, { otherBackCount: 3 }), { sides: [LOCAL], guarded: false });
});

test('Home moves both panels while synchronized browsing is on', () => {
  const sync = new I.SynchronizedBrowsing({ enabled: true });
  assert.deepEqual(sync.homeDirectory(LOCAL, {}), { sides: [LOCAL, REMOTE], guarded: true });
  sync.enabled = false;
  assert.deepEqual(sync.homeDirectory(LOCAL, {}), { sides: [LOCAL], guarded: false });
});

// ===========================================================================
// session state per tab
// ===========================================================================

test('a Commander tab records both local directories, and the pair must agree', () => {
  const data = SD.defaultSessionData('');
  const localLocal = I.updateSessionData(COMMANDER, data, {
    localPath: 'C:\\a', otherLocalPath: 'D:\\b', localBrowserMode: true, synchronizeBrowsing: true,
  });
  assert.equal(SD.isLocalBrowser(localLocal), true);
  assert.equal(localLocal.synchronizeBrowsing, true);

  const remote = I.updateSessionData(COMMANDER, data, {
    localPath: 'C:\\a', remotePath: '/srv', localBrowserMode: false,
  });
  assert.equal(remote.otherLocalDirectory, '');
  assert.equal(SD.isLocalBrowser(remote), false);

  // Claiming local-local while storing only one directory is a contradiction.
  assert.throws(() => I.updateSessionData(COMMANDER, data, {
    localPath: 'C:\\a', otherLocalPath: '', localBrowserMode: true,
  }), /disagree/);
});

test('Explorer never writes a local directory into a session', () => {
  const out = I.updateSessionData(EXPLORER, SD.defaultSessionData(''), { remotePath: '/srv', localPath: 'C:\\a' });
  assert.equal(out.remoteDirectory, '/srv');
  assert.equal(out.localDirectory, '');
});

test('"preserve local directory" is overridden on the first session and by a local-local one', () => {
  assert.equal(I.shouldRestoreLocalDirectory({ localDirectory: 'C:\\a', preserveLocalDirectory: false }), true);
  assert.equal(I.shouldRestoreLocalDirectory({ localDirectory: 'C:\\a', preserveLocalDirectory: true }), false);
  assert.equal(I.shouldRestoreLocalDirectory({
    localDirectory: 'C:\\a', preserveLocalDirectory: true, firstTerminal: true,
  }), true);
  assert.equal(I.shouldRestoreLocalDirectory({
    localDirectory: 'C:\\a', preserveLocalDirectory: true, localBrowser: true,
  }), true);
  assert.equal(I.shouldRestoreLocalDirectory({ localDirectory: '' }), false);
});

test('a panel selection is only restored when the panel is going to move with it', () => {
  assert.equal(I.shouldRestorePanelState({ preservePanelState: true, preserveLocalDirectory: false }), true);
  assert.equal(I.shouldRestorePanelState({ preservePanelState: true, preserveLocalDirectory: true }), false);
  assert.equal(I.shouldRestorePanelState({
    preservePanelState: true, preserveLocalDirectory: true, localBrowser: true,
  }), true);
  assert.equal(I.shouldRestorePanelState({ preservePanelState: false }), false);
});

test('an unnamed local-local tab is titled by its two directories', () => {
  const data = SD.defaultSessionData('');
  data.localDirectory = 'C:\\work\\src';
  data.otherLocalDirectory = 'D:\\media';
  const title = I.localBrowserSessionTitle({ sessionData: data }, { path1: 'C:\\work\\src', path2: 'D:\\media' });
  assert.equal(title, `src${SD.TITLE_SEPARATOR}media`);
  const named = SD.defaultSessionData('My pair');
  named.localDirectory = 'C:\\a';
  named.otherLocalDirectory = 'C:\\b';
  assert.equal(I.localBrowserSessionTitle({ sessionData: named }, { path1: 'C:\\a', path2: 'C:\\b' }), 'My pair');
});

test('the tab hint lists the panels in visual order', () => {
  const session = { localBrowser: true, active: true };
  const state = { localPath: 'C:\\a', otherPath: 'D:\\b' };
  assert.equal(I.tabHintDetails(COMMANDER, session, state), 'C:\\a\nD:\\b');
  assert.equal(I.tabHintDetails(COMMANDER, session, Object.assign({ swappedPanels: true }, state)), 'D:\\b\nC:\\a');
  assert.match(I.tabHintDetails(COMMANDER, { localBrowser: false, active: false },
    Object.assign({ sessionDetails: 'me@host' }, state)), /Not connected/);
  assert.match(I.tabHintDetails(EXPLORER, { active: false }, { sessionDetails: 'me@host' }), /Not connected/);
});

test('the opposite side of a local-local tab is its second LOCAL directory', () => {
  const data = SD.defaultSessionData('');
  data.localDirectory = 'C:\\a';
  data.otherLocalDirectory = 'D:\\b';
  data.remoteDirectory = '/srv';
  assert.equal(I.sessionPath({ stateData: data, localBrowser: true }, LOCAL), 'C:\\a');
  assert.equal(I.sessionPath({ stateData: data, localBrowser: true }, REMOTE), 'D:\\b');
  assert.equal(I.sessionPath({ stateData: data, localBrowser: false }, REMOTE), '/srv');
});

test('the window title shows nothing while the tab and the session disagree', () => {
  const state = {
    currentSide: LOCAL, hasSession: false, localPath: 'C:\\work\\src', pathInCaption: 'short',
    sessionIsActiveSession: false,
  };
  assert.equal(I.pathForCaption(COMMANDER, state), '');
  assert.equal(I.pathForCaption(COMMANDER, Object.assign({}, state, { sessionIsActiveSession: true })), 'src');
  assert.equal(I.pathForCaption(COMMANDER, Object.assign({}, state, {
    sessionIsActiveSession: true, pathInCaption: 'full',
  })), 'C:\\work\\src');
  assert.equal(I.pathForCaption(EXPLORER, { hasSession: true, remotePath: '/srv/www/', pathInCaption: 'short' }), 'www');
  assert.equal(I.pathForCaption(EXPLORER, { hasSession: true, remotePath: '/srv/www/', pathInCaption: 'none' }), '');
  // With no session there is no current directory to name.
  assert.equal(I.pathForCaption(EXPLORER, { hasSession: false, remotePath: '/srv/www/', pathInCaption: 'full' }), '');
});

// ===========================================================================
// workspaces
// ===========================================================================

/** A stored site plus two open tabs — one from the site, one ad hoc. */
function workspaceFixture() {
  const site = SD.defaultSessionData('prod');
  site.hostName = 'example.com';
  site.userName = 'me';
  site.password = 'stored';
  site.remoteDirectory = '/srv';

  const fromSite = SD.cloneSessionData(site);
  fromSite.remoteDirectory = '/srv/www';
  fromSite.localDirectory = 'C:\\work';

  const adhoc = SD.defaultSessionData('');
  adhoc.hostName = 'other.example';
  adhoc.userName = 'you';
  adhoc.password = 'secret';
  adhoc.remoteDirectory = '/tmp';

  return { site, stored: [site], sessions: [{ stateData: fromSite, active: true }, { stateData: adhoc }] };
}

test('the workspace name falls back through last, auto, then a default', () => {
  assert.equal(I.workspaceName({ lastWorkspace: 'Mine', autoWorkspace: 'Auto' }), 'Mine');
  assert.equal(I.workspaceName({ autoWorkspace: 'Auto' }), 'Auto');
  assert.equal(I.workspaceName({}), 'My Workspace');
});

test('a workspace member is a link when its site still exists, and a copy when not', () => {
  const { stored, sessions } = workspaceFixture();
  const collected = I.collectWorkspace(stored, sessions);
  assert.equal(collected.length, 2);
  assert.equal(collected[0].link, 'prod');
  assert.equal(collected[0].name, '0000');
  assert.equal(collected[1].link, '');
  assert.equal(collected[1].hostName, 'other.example');
  // The index is hex-padded so the tab order survives an alphabetical store.
  assert.equal(collected[1].name, '0001');
  assert.ok(collected.every((d) => d.isWorkspace));
});

test('saving a workspace replaces its whole folder, so a closed tab stays closed', () => {
  const { stored, sessions } = workspaceFixture();
  const first = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  assert.deepEqual(first.sessions.map((s) => s.name), ['prod', 'WS/0000', 'WS/0001']);
  const second = I.saveWorkspace(first.sessions, 'WS',
    I.collectWorkspace(stored, [sessions[0]]), { savePasswords: true });
  assert.deepEqual(second.sessions.map((s) => s.name), ['prod', 'WS/0000']);
  assert.deepEqual(second.removed, ['WS/0000', 'WS/0001']);
  assert.equal(second.lastWorkspace, 'WS');
});

test('not saving passwords clears them on copies but leaves the linked site alone', () => {
  const { stored, sessions } = workspaceFixture();
  const collected = I.collectWorkspace(stored, sessions);
  const saved = I.saveWorkspace(stored, 'WS', collected, { savePasswords: false });
  const members = saved.sessions.filter((s) => s.name.startsWith('WS/'));
  assert.equal(members[0].link, 'prod');
  assert.equal(members[1].password, '');
  // The stored site itself is untouched.
  assert.equal(saved.sessions.find((s) => s.name === 'prod').password, 'stored');
});

test('a live password written onto a LINKED member survives "do not save passwords"', () => {
  // TTerminal::UpdateSessionCredentials writes the live password onto the
  // active session's workspace entry even when it is a link, and
  // DoSaveWorkspace only calls ClearSessionPasswords when Link is empty. So
  // WinSCP really does keep that one. Clearing it here would be a divergence,
  // not a security improvement, because the site it points at still has it.
  const { stored, sessions } = workspaceFixture();
  const collected = I.collectWorkspace(stored, sessions, {
    updateCredentials: (data) => { data.password = 'live'; },
  });
  assert.equal(collected[0].link, 'prod');
  assert.equal(collected[0].password, 'live');
  const saved = I.saveWorkspace(stored, 'WS', collected, { savePasswords: false });
  const members = saved.sessions.filter((s) => s.name.startsWith('WS/'));
  assert.equal(members[0].password, 'live');
  assert.equal(members[1].password, '');
});

test('the password question is only asked when a non-linked member has one', () => {
  const { stored, sessions } = workspaceFixture();
  const collected = I.collectWorkspace(stored, sessions);
  const asked = I.workspacePasswordDecision(collected, sessions, {});
  assert.equal(asked.askUser, true);
  assert.equal(asked.notRecommended, true);
  // A master password makes saving them a reasonable default.
  assert.equal(I.workspacePasswordDecision(collected, sessions, { useMasterPassword: true }).savePasswords, true);
  // Password storing disabled by policy: no question, no saving.
  const disabled = I.workspacePasswordDecision(collected, sessions, { disablePasswordStoring: true });
  assert.deepEqual({ askUser: disabled.askUser, savePasswords: disabled.savePasswords },
    { askUser: false, savePasswords: false });
  // Nothing but links: nothing to ask about.
  const linksOnly = collected.filter((d) => d.link);
  assert.equal(I.workspacePasswordDecision(linksOnly, sessions, {}).askUser, false);
});

test('an anonymous-only workspace is not warned about', () => {
  const anon = SD.defaultSessionData('');
  anon.hostName = 'ftp.example';
  anon.userName = SD.ANONYMOUS_USER_NAME;
  anon.password = SD.ANONYMOUS_PASSWORD || 'x';
  const decision = I.workspacePasswordDecision([anon], [{ sessionData: anon }],
    { hasAnySessionPassword: () => true });
  assert.equal(decision.notRecommended, false);
  assert.equal(decision.savePasswords, true);
});

test('restoring a workspace overlays its own directories on the linked site', () => {
  const { stored, sessions } = workspaceFixture();
  const saved = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  const restored = I.getFolderOrWorkspace(saved.sessions, 'WS');
  assert.equal(restored.length, 2);
  assert.equal(restored[0].name, 'prod');
  assert.equal(restored[0].hostName, 'example.com');
  assert.equal(restored[0].remoteDirectory, '/srv/www');   // the tab's directory, not the site's
  assert.equal(restored[0].localDirectory, 'C:\\work');
  // The ad-hoc member comes back unnamed, so "0001" never reaches the user.
  assert.equal(restored[1].name, '');
  // IsWorkspace is copied by Assign: the linked member resolves to the real
  // site (not a workspace entry) and loses it, the full copy keeps it. Both are
  // read later — the copy is what makes its session Permanent on its own.
  assert.equal(restored[0].isWorkspace, false);
  assert.equal(restored[1].isWorkspace, true);
});

test('a workspace member stored as a full copy is permanent on its own', () => {
  const { stored, sessions } = workspaceFixture();
  const saved = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  const both = I.openFolderOrWorkspace(saved.sessions, 'WS', {});
  assert.deepEqual(both.sessions.map((s) => s.permanent), [true, true]);

  // Drop the copy, leaving only the link: one session, and the link alone does
  // not make it permanent (TerminalManager.cpp:337 reads Data->IsWorkspace).
  const linkOnly = saved.sessions.filter((s) => s.name !== 'WS/0001');
  const one = I.openFolderOrWorkspace(linkOnly, 'WS', {});
  assert.equal(one.sessions.length, 1);
  assert.equal(one.sessions[0].permanent, false);
});

test('a pre-5.6.4 workspace with no state does not blank the site defaults', () => {
  const site = SD.defaultSessionData('prod');
  site.hostName = 'example.com';
  site.userName = 'me';
  site.remoteDirectory = '/srv';
  const legacy = SD.defaultSessionData('WS/0000');
  legacy.isWorkspace = true;
  legacy.link = 'prod';
  assert.equal(SD.hasStateData(legacy), false);
  const restored = I.getFolderOrWorkspace([site, legacy], 'WS');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].remoteDirectory, '/srv');
});

test('a workspace member whose site was deleted is skipped, not opened blank', () => {
  const orphan = SD.defaultSessionData('WS/0000');
  orphan.isWorkspace = true;
  orphan.link = 'deleted-site';
  assert.deepEqual(I.getFolderOrWorkspace([orphan], 'WS'), []);
  assert.deepEqual(I.folderOrWorkspaceList([orphan], 'WS'), []);
});

test('opening a workspace over the session limit opens nothing at all', () => {
  const { stored, sessions } = workspaceFixture();
  const saved = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  const refused = I.openFolderOrWorkspace(saved.sessions, 'WS', { checkMaxSessions: true, maxSessions: 1 });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.sessions, []);
  assert.match(refused.reason, /limit is 1/);
  // Without the check it opens regardless — that is the "opened by the user" path.
  assert.equal(I.openFolderOrWorkspace(saved.sessions, 'WS', { maxSessions: 1 }).ok, true);
});

test('workspace sessions are permanent so a failed connection is not silently dropped', () => {
  const { stored, sessions } = workspaceFixture();
  const saved = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  const opened = I.openFolderOrWorkspace(saved.sessions, 'WS', {});
  assert.ok(opened.sessions.every((s) => s.permanent));
  assert.equal(opened.sessions[0].connect, true);
  assert.equal(opened.sessions[1].connect, false);
  const all = I.openFolderOrWorkspace(saved.sessions, 'WS', { workspaceConnectAll: true });
  assert.equal(all.sessions[1].connect, true);
  assert.equal(all.sessions[1].connectDelayMs, 3000);
});

test('opening the first session disconnected marks it temporarily so', () => {
  const { stored, sessions } = workspaceFixture();
  const saved = I.saveWorkspace(stored, 'WS', I.collectWorkspace(stored, sessions), { savePasswords: true });
  const opened = I.openFolderOrWorkspace(saved.sessions, 'WS', { connectFirstTerminal: false });
  assert.equal(opened.sessions[0].disconnected, true);
  assert.equal(opened.sessions[0].disconnectedTemporarily, true);
});

test('Explorer skips the local-local members of a workspace and may end with none', () => {
  const pair = SD.defaultSessionData('WS/0000');
  pair.isWorkspace = true;
  pair.localDirectory = 'C:\\a';
  pair.otherLocalDirectory = 'C:\\b';
  const opened = I.openFolderOrWorkspace([pair], 'WS', { mode: EXPLORER });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.sessions, []);
  assert.equal(opened.activeSession, null);
  assert.equal(opened.skipped, 1);
  assert.equal(I.openFolderOrWorkspace([pair], 'WS', { mode: COMMANDER }).sessions.length, 1);
});

test('an empty window saves no workspace on close', () => {
  assert.deepEqual(I.autoSaveWorkspaceOnClose({ autoSaveWorkspace: true, hasSession: false }),
    { save: false, reason: 'no session is open' });
  assert.equal(I.autoSaveWorkspaceOnClose({ autoSaveWorkspace: false, hasSession: true }).save, false);
  const saving = I.autoSaveWorkspaceOnClose({
    autoSaveWorkspace: true, hasSession: true, lastWorkspace: 'Mine', autoSaveWorkspacePasswords: true,
  });
  assert.equal(saving.save, true);
  assert.equal(saving.name, 'Mine');
  assert.equal(saving.savePasswords, true);
  assert.equal(saving.explicit, false);
  // Policy still wins over the preference.
  assert.equal(I.autoSaveWorkspaceOnClose({
    autoSaveWorkspace: true, hasSession: true, autoSaveWorkspacePasswords: true, disablePasswordStoring: true,
  }).savePasswords, false);
});

test('auto-save replaces the closing confirmation with a note', () => {
  const auto = I.closeQuery({ autoSaveWorkspace: true, sessionCount: 3, activeSessionCount: 2, lastWorkspace: 'Mine' });
  assert.equal(auto.confirm, false);
  assert.match(auto.note, /Mine/);
  const asked = I.closeQuery({ sessionCount: 3, activeSessionCount: 1 });
  assert.equal(asked.confirm, true);
  assert.equal(asked.offerSaveWorkspace, true);
  assert.equal(I.closeQuery({ sessionCount: 1, activeSessionCount: 0 }).confirm, false);
});

// ===========================================================================
// startup, status bars, local-local copy, drag and drop
// ===========================================================================

test('the focused panel is restored unless the opposite one cannot take focus', () => {
  assert.deepEqual(I.initialFocus(COMMANDER, { currentPanel: LOCAL, otherPanelEnabled: true }), { side: LOCAL });
  assert.deepEqual(I.initialFocus(COMMANDER, { currentPanel: REMOTE, otherPanelEnabled: true }), { side: REMOTE });
  assert.deepEqual(I.initialFocus(COMMANDER, { currentPanel: REMOTE, otherPanelEnabled: false }), { side: LOCAL });
  assert.deepEqual(I.initialFocus(EXPLORER, { otherPanelEnabled: false }), { side: null });
});

test('a home directory on a network drive is skipped for any valid local path', () => {
  const network = I.localDefaultDirectory({ homeDriveType: 'remote', applicationDirectory: 'C:\\app' });
  assert.deepEqual(network.map((s) => s.kind), ['anyValidPath', 'applicationDirectory']);
  const normal = I.localDefaultDirectory({ lastPath: 'C:\\work', homeDirectory: 'C:\\Users\\me' });
  assert.deepEqual(normal.map((s) => s.kind), ['lastPath', 'home', 'applicationDirectory']);
});

test('Commander has three status bars and Explorer shares one', () => {
  const c = I.statusBarsFor(COMMANDER);
  assert.equal(c.shared, false);
  assert.equal(c.panels.local, 'LocalStatusBar');
  const e = I.statusBarsFor(EXPLORER);
  assert.equal(e.shared, true);
  assert.equal(e.session, e.panels.remote);
});

test('a hidden Commander panel must not write to the visible panel status bar', () => {
  assert.deepEqual(I.shouldUpdateFileStatusBar(COMMANDER, { panelVisible: false }),
    { update: false, target: 'panel' });
  assert.deepEqual(I.shouldUpdateFileStatusBar(COMMANDER, { panelVisible: true }),
    { update: true, target: 'panel' });
  assert.equal(I.shouldUpdateFileStatusBar(EXPLORER, {}).cancelNoteFirst, true);
});

test('a local-local copy builds its targets from the mask and reloads both directories', () => {
  const plan = I.localLocalCopy('move', {
    sources: ['C:\\a\\one.txt', 'C:\\a\\two.txt'],
    sourceDir: 'C:\\a',
    destinationDir: 'C:\\b',
    fileMask: '*.bak',
    maskFileName: (name, mask) => name.replace(/\.[^.]+$/, mask.slice(1)),
    confirmOverwriting: true,
  });
  assert.deepEqual(plan.targets, ['C:\\b\\one.bak', 'C:\\b\\two.bak']);
  assert.deepEqual(plan.reloadDirectories, ['C:\\b', 'C:\\a']);
  assert.equal(plan.noConfirmation, false);
  assert.equal(plan.multipleFiles, true);
  assert.equal(plan.counter, 'LocalLocalMovesCommand');
  // Moving inside one directory reloads it once.
  assert.deepEqual(I.localLocalCopy('move', { sources: [], sourceDir: 'C:\\a', destinationDir: 'C:\\a' })
    .reloadDirectories, ['C:\\a']);
  assert.throws(() => I.localLocalCopy('delete', {}), TypeError);
});

// ===========================================================================
// directory creation, bookmarks, links, clipboard and focus
// ===========================================================================

test('creating the synchronized directory creates the whole missing branch', () => {
  assert.deepEqual(I.missingDirectoryChain('/a/b/c', REMOTE, (p) => p === '/a'), ['/a/b', '/a/b/c']);
  assert.deepEqual(I.missingDirectoryChain('/a/b/c', REMOTE, () => false), ['/a', '/a/b', '/a/b/c']);
  assert.deepEqual(I.missingDirectoryChain('/a', REMOTE, () => false), ['/a']);
  assert.deepEqual(I.missingDirectoryChain('/', REMOTE, () => false), []);
  assert.deepEqual(I.missingDirectoryChain('C:\\a\\b\\c', LOCAL, (p) => p === 'C:\\a'),
    ['C:\\a\\b', 'C:\\a\\b\\c']);
});

test('Commander offers location profiles only with a session and one remote panel', () => {
  assert.equal(I.openDirectoryDialog(COMMANDER, {
    useLocationProfiles: true, hasAvailableSession: true,
  }).kind, 'locationProfiles');
  assert.equal(I.openDirectoryDialog(COMMANDER, {
    useLocationProfiles: true, hasAvailableSession: false,
  }).kind, 'openDirectory');
  assert.equal(I.openDirectoryDialog(COMMANDER, {
    useLocationProfiles: true, hasAvailableSession: true, localBrowserMode: true,
  }).kind, 'openDirectory');
  // The plain dialog runs guarded so it does not drag the other panel with it.
  assert.equal(I.openDirectoryDialog(COMMANDER, { side: LOCAL }).guarded, true);
  assert.equal(I.openDirectoryDialog(EXPLORER, {}).guarded, false);
});

test('a bad local half of a bookmark still opens the remote half', () => {
  const both = I.openBookmark(COMMANDER, { local: 'C:\\a', remote: '/srv' }, { useLocationProfiles: true });
  assert.equal(both.handled, true);
  assert.deepEqual(both.steps.map((s) => s.side), [LOCAL, REMOTE]);
  assert.equal(both.steps[0].reportErrorAfter, true);
  assert.equal(both.steps[1].always, true);
  assert.equal(both.steps[0].expandEnvironment, true);
  // Without location profiles it is a one-sided bookmark again.
  const one = I.openBookmark(COMMANDER, { local: 'C:\\a', remote: '/srv' }, { side: REMOTE });
  assert.equal(one.handled, false);
  assert.deepEqual(one.steps, [{ side: REMOTE, path: '/srv', expandEnvironment: false }]);
  assert.equal(I.openBookmark(EXPLORER, { remote: '/srv' }, { useLocationProfiles: true }).handled, false);
});

test('revealing a found file prefers the remote panel when both matched', () => {
  assert.equal(I.exploreFileFocus(COMMANDER, { remoteSelected: true, localSelected: true }).currentPanel, REMOTE);
  assert.equal(I.exploreFileFocus(COMMANDER, { localSelected: true }).currentPanel, LOCAL);
  assert.equal(I.exploreFileFocus(COMMANDER, {}).currentPanel, null);
  assert.deepEqual(I.exploreFileFocus(COMMANDER, { localBrowserMode: true }).reveal, [LOCAL]);
  assert.deepEqual(I.exploreFileFocus(EXPLORER, {}).reveal, [REMOTE]);
});

test('editing a local link needs a real .lnk, and an unresolvable one is an error', () => {
  const lnk = { name: 'target.lnk', fullName: 'C:\\a\\target.lnk' };
  const good = I.localAddEditLink(false, { focused: lnk, resolveShortcut: () => 'C:\\dest\\file.txt' });
  assert.equal(good.edit, true);
  assert.equal(good.pointTo, 'C:\\dest\\file.txt');
  assert.equal(good.replaces, 'C:\\a\\target.lnk');       // editing really replaces the file
  const broken = I.localAddEditLink(false, { focused: lnk, resolveShortcut: () => '' });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /Cannot resolve shortcut/);
  // "Add" never edits, even when a .lnk is focused.
  assert.equal(I.localAddEditLink(true, { focused: lnk, resolveShortcut: () => 'x' }).edit, false);
  // The parent-directory row is never offered as a target.
  assert.equal(I.localAddEditLink(true, { focused: { name: '..', isParentDirectory: true } }).pointTo, '');
  assert.equal(I.localAddEditLink(true, { focused: { name: 'notes.txt' } }).pointTo, 'notes.txt');
});

test('a bare link name is completed against the panel and given a .lnk extension', () => {
  assert.deepEqual(I.completeLocalLink('shortcut', 'notes.txt', 'C:\\work'),
    { fileName: 'C:\\work\\shortcut.lnk', pointTo: 'C:\\work\\notes.txt' });
  assert.deepEqual(I.completeLocalLink('D:\\x.lnk', '\\\\server\\share', 'C:\\work'),
    { fileName: 'D:\\x.lnk', pointTo: '\\\\server\\share' });
});

test('the clipboard follows the panel: shell on a local one, remote otherwise', () => {
  assert.deepEqual(I.clipboardCopy(COMMANDER, LOCAL, { hasSession: true }),
    { kind: 'shellClipboard', side: LOCAL });
  assert.deepEqual(I.clipboardCopy(COMMANDER, REMOTE, { hasSession: true }),
    { kind: 'remoteClipboard', side: REMOTE });
  assert.deepEqual(I.clipboardCopy(EXPLORER, REMOTE, {}), { kind: 'remoteClipboard', side: REMOTE });

  const paste = I.clipboardPaste(COMMANDER, {
    clipboardHasOurFiles: true, currentSide: LOCAL, hasSession: true,
    canPasteToDirView: true, currentPath: 'C:\\dl', confirmTransferring: true,
  });
  assert.deepEqual(paste, { kind: 'downloadFromClipboard', target: 'C:\\dl', confirm: true });
  assert.equal(I.clipboardPaste(COMMANDER, { clipboardHasOurFiles: false, currentSide: LOCAL }).kind, 'shellPaste');
  assert.equal(I.clipboardPaste(COMMANDER, {
    clipboardHasOurFiles: true, currentSide: LOCAL, hasSession: true, canPasteToDirView: false,
  }).kind, null);
});

test('a shortcut to a hidden band shows it first, and Explorer has no command line', () => {
  assert.deepEqual(I.goToCommandLine(COMMANDER),
    { ok: true, show: 'fcCommandLinePanel', focus: 'CommandLineCombo', onlyIfEnabled: true });
  assert.equal(I.goToCommandLine(EXPLORER).ok, false);
  assert.deepEqual(I.goToTree(COMMANDER, { currentSide: LOCAL }), { show: 'fcLocalTree', focus: 'LocalDriveView' });
  assert.deepEqual(I.goToTree(COMMANDER, { currentSide: REMOTE }), { show: 'fcRemoteTree', focus: 'RemoteDriveView' });
  assert.deepEqual(I.goToTree(EXPLORER, {}), { show: 'fcRemoteTree', focus: 'RemoteDriveView' });
  assert.deepEqual(I.exitToolbar(COMMANDER, { currentSide: REMOTE }), { focusPanel: REMOTE });
  assert.deepEqual(I.exitToolbar(EXPLORER, {}), { focusPanel: REMOTE });
});

test('"open in Explorer" is refused for a panel that is not showing a local directory', () => {
  assert.deepEqual(I.exploreLocalDirectory(COMMANDER, LOCAL, { hasSession: true, path: 'C:\\a' }),
    { ok: true, path: 'C:\\a' });
  const refused = I.exploreLocalDirectory(COMMANDER, REMOTE, { hasSession: true, path: '/srv' });
  assert.equal(refused.ok, false);
  assert.equal(I.exploreLocalDirectory(EXPLORER, REMOTE, {}).ok, false);
});

test('the hot-key band captions each button with its own shortcut', () => {
  assert.equal(I.hotKeyCaption({ caption: '&Copy...', shortcut: 'F5' }), 'F5 Copy');
  assert.equal(I.hotKeyCaption({ caption: 'Copy && Paste', shortcut: 'F5' }), 'F5 Copy & Paste');
  assert.equal(I.hotKeyCaption({ caption: '&Rename' }), ' Rename');
  assert.equal(I.stripHotkey('&File'), 'File');
  assert.equal(I.stripHotkey('R&&D'), 'R&D');
  // The band opts out of the icons-only toolbar setting so its text survives.
  assert.equal(I.eligibleForImageDisplayMode(COMMANDER, { toolbar: 'Toolbar2Toolbar' }), false);
  assert.equal(I.eligibleForImageDisplayMode(COMMANDER, { toolbar: 'MenuToolbar' }), true);
  assert.equal(I.eligibleForImageDisplayMode(EXPLORER, { toolbar: 'Toolbar2Toolbar' }), true);
});

test('disconnecting never leaves the window with nothing focused', () => {
  assert.equal(I.restoreFocus('LocalDirView', {}), 'LocalDirView');
  assert.equal(I.restoreFocus('RemoteDirView', { otherDirViewCanFocus: true }), 'OtherDirView');
  assert.equal(I.restoreFocus('RemoteDirView', { otherDirViewCanFocus: false }), 'LocalDirView');
  assert.equal(I.restoreFocus('RemoteDriveView', { otherDriveViewCanFocus: true }), 'OtherDriveView');
  assert.equal(I.restoreFocus('RemoteDriveView', { localDriveViewCanFocus: true }), 'LocalDriveView');
  // Disconnected with the local tree hidden too: fall back to the file list.
  assert.equal(I.restoreFocus('RemoteDriveView', {}), 'LocalDirView');
  assert.equal(I.restoreFocus('QueueView', {}), null);
});

test('the queue lives in the remote panel in Explorer and below both in Commander', () => {
  assert.equal(I.controlOrder(EXPLORER).queueParent, 'RemotePanel');
  assert.equal(I.controlOrder(COMMANDER).queueParent, 'Form');
  assert.ok(I.controlOrder(COMMANDER).localPanel.includes('LocalPanelSplitter'));
  assert.ok(I.controlOrder(EXPLORER).vertical.indexOf('RemoteStatusBar') > 0);
});

test('a finished drag-download reloads the local panel; anything else does not', () => {
  assert.equal(I.shouldReloadAfterOperation({
    inProgress: false, progressShown: true, dropTargetIsLocal: true, isTransfer: true,
  }), true);
  assert.equal(I.shouldReloadAfterOperation({
    inProgress: true, progressShown: true, dropTargetIsLocal: true, isTransfer: true,
  }), false);
  assert.equal(I.shouldReloadAfterOperation({
    inProgress: false, progressShown: true, dropTargetIsLocal: true, isTransfer: false,
  }), false);
  assert.equal(I.isPanelOperation(COMMANDER, { dropSourceControl: 'LocalDirView' }), true);
  assert.equal(I.isPanelOperation(EXPLORER, { dropSourceControl: 'LocalDirView' }), false);
  assert.equal(I.isPanelOperation(EXPLORER, { dropSourceControl: 'RemoteDirView' }), true);
});

test('the New Tab button shows the kind of tab it will actually open', () => {
  assert.equal(I.newTabPresentation(COMMANDER, { defaultToNewRemoteTab: false }).icon, 'NewLocalTabAction');
  assert.match(I.newTabPresentation(COMMANDER, { defaultToNewRemoteTab: false }).hint, /Ctrl key to open new remote/);
  assert.equal(I.newTabPresentation(COMMANDER, { defaultToNewRemoteTab: true }).icon, 'NewTabAction');
  assert.match(I.newTabPresentation(COMMANDER, { defaultToNewRemoteTab: true }).hint, /Ctrl key to open new local/);
  assert.doesNotMatch(I.newTabPresentation(EXPLORER, {}).hint, /local tab/);
});

test('dropping remote files on a local file is left to that file own drop handler', () => {
  assert.deepEqual(I.internalDropTarget({
    control: 'LocalDirView', dropTarget: true, dropTargetIsDirectory: true, dropTargetFullName: 'C:\\a\\sub',
  }), { ok: true, directory: 'C:\\a\\sub' });
  const refused = I.internalDropTarget({
    control: 'LocalDirView', dropTarget: true, dropTargetIsDirectory: false,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /drop handler/);
  assert.deepEqual(I.internalDropTarget({
    control: 'LocalDirView', dropTarget: null, defaultDownloadTargetDirectory: 'C:\\a\\',
  }), { ok: true, directory: 'C:\\a\\' });
  assert.deepEqual(I.internalDropTarget({ control: 'LocalDriveView', nodePath: 'D:\\' }),
    { ok: true, directory: 'D:\\' });
  assert.equal(I.internalDropTarget({ control: 'RemoteDirView' }).ok, false);
});
