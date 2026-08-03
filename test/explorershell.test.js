// explorershell.test.js — forms/CustomScpExplorer.cpp and the synchronized
// browsing its ScpCommander subclass adds.
//
// The rows here are the behaviours that are easy to get wrong by simplifying:
// the focused item counting as a selection ONLY while the panel has focus and
// the window is frontmost; the alternative-delete flag inverting the recycle
// preference in both directions; a queued transfer reporting "did not proceed";
// unticking "do not show again" promoting the tri-state UP rather than down; a
// protocol with no secondary shell being REFUSED rather than asked; "move up"
// in the queue being refused when the item above is already running; and
// synchronized browsing turning itself off rather than guessing a mapping.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const E = require('../design/main/explorershell');
const { CopyParamList } = require('../design/main/winconfig');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function panel(spec) { return new E.PanelState(spec); }

function fakeConfig(prefs) {
  const store = { ...(prefs || {}) };
  const writes = [];
  return {
    prefs: store,
    writes,
    setPref(name, value, label) { writes.push({ name, value, label }); store[name] = value; },
    currentCopyParam: { transferMode: 'binary' },
  };
}

function fakeSession(over) {
  return {
    id: 's1',
    name: 'test',
    protocol: 'sftp',
    protocolName: 'SFTP',
    active: true,
    localBrowser: false,
    commandSessionOpened: false,
    encryptingFiles: false,
    caps: {
      rights: true, owner: true, symlink: true, exec: true, resume: true,
      timestamp: true, checksum: true, rename: true, move: true, copyRemote: false,
      calculateSize: true, textMode: true,
    },
    sessionData: {
      sessionName: 'test',
      hostName: 'example.org',
      userName: 'joe',
      deleteToRecycleBin: false,
      recycleBinPath: '',
      resolveSymlinks: true,
    },
    currentDirectory: '/home/joe',
    usableCopyParamAttrs() { return { general: {}, upload: {}, download: {} }; },
    ...(over || {}),
  };
}

/**
 * A shell wired to fakes. `answers` is consumed in order by the ask channel,
 * so a test states exactly which confirmations it expects to be asked.
 */
function makeShell(over) {
  const o = over || {};
  const asked = [];
  const notes = [];
  const calls = [];
  const answers = [...(o.answers || [])];
  const config = o.config || fakeConfig(o.prefs);
  const session = o.session === undefined ? fakeSession() : o.session;
  const panels = o.panels || {};
  const ops = new Proxy(o.ops || {}, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== 'string') return undefined;
      return (...args) => { calls.push({ name, args }); return true; };
    },
    has() { return true; },
  });
  const shell = new E.ExplorerShell({
    config,
    session: () => session,
    sessions: () => (o.sessions || (session ? [session] : [])),
    setActiveSession: (s) => calls.push({ name: 'setActiveSession', args: [s] }),
    panels: (side) => panels[side] || null,
    queue: o.queue || null,
    clipboard: o.clipboard || null,
    editors: o.editors || null,
    copyDialog: o.copyDialog || null,
    ops,
    ask: async (request) => {
      asked.push(request);
      if (!answers.length) throw new Error(`unexpected confirmation: ${request.name}`);
      return answers.shift();
    },
    note: (n) => notes.push(n),
    ...(o.shell || {}),
  });
  shell._test = { asked, notes, calls, config, session, answersLeft: () => answers.length };
  return shell;
}

test('SetProperties dispatches local-local workspaces to the focused local panel', async () => {
  const calls = [];
  const local = panel({ side: 'local', local: true, entries: [{ name: 'note.txt' }], selected: ['note.txt'] });
  const shell = makeShell({
    panels: { local },
    ops: {
      setLocalProperties: (...args) => { calls.push(args); return true; },
    },
    shell: { localBrowserMode: true, currentSide: 'local' },
  });
  const result = await shell.executeFileOperation('setProperties', 'current', [{ name: 'note.txt' }]);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'local');
  assert.equal(calls[0][2].local, true);
});

test('SetProperties builds capability context and selected tokens beyond the first 100 entries', () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ name: `f${i}`, owner: `owner${i}`, group: `group${i}` }));
  const shell = makeShell({
    panels: { remote: panel({ side: 'remote', entries }) },
    session: fakeSession({ caps: {
      ...fakeSession().caps, ownerChanging: true, groupChanging: true,
      modeChanging: true, aclChangingFiles: true, groupOwnerChangingByID: true, tags: true,
    } }),
  });
  const context = shell.setPropertiesContext('remote', [{ name: 'selected', owner: 'picked', group: 'picked-group' }]);
  assert.equal(context.local, false);
  assert.equal(context.capabilities.owner, true);
  assert.equal(context.capabilities.group, true);
  assert.ok(context.users.includes('picked'));
  assert.ok(context.groups.includes('picked-group'));
});

const ENTRIES = [
  { name: '..' },
  { name: 'alpha.txt', size: 10 },
  { name: 'beta.log', size: 20 },
  { name: 'sub', isDirectory: true },
];

// ===========================================================================
// PanelState — "what is selected, and what does that mean"
// ===========================================================================

test('AnyFileSelected: the focused item counts only when the panel is focused AND frontmost', () => {
  const base = { side: 'remote', path: '/p', entries: ENTRIES, focusedName: 'alpha.txt' };

  // No selection, panel focused, window frontmost -> the focused item counts.
  assert.strictEqual(panel({ ...base, hasFocus: true, foreground: true })
    .anyFileSelected(false, false, true), true);

  // Same, but the panel does not have the focus.
  assert.strictEqual(panel({ ...base, hasFocus: false, foreground: true })
    .anyFileSelected(false, false, true), false);

  // Focused, but another application is in front — WinSCP checks
  // GetForegroundWindow() precisely so a toolbar cannot act on a stale focus.
  assert.strictEqual(panel({ ...base, hasFocus: true, foreground: false })
    .anyFileSelected(false, false, true), false);

  // With focusedFileOnlyWhenFocused off, none of that matters.
  assert.strictEqual(panel({ ...base, hasFocus: false, foreground: false })
    .anyFileSelected(false, false, false), true);
});

test('AnyFileSelected: onlyFocused ignores the selection entirely', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['beta.log'], focusedName: 'sub' });
  // The focused item is a directory, so filesOnly refuses it even though a
  // file is selected.
  assert.strictEqual(p.anyFileSelected(true, true, true), false);
  assert.strictEqual(p.anyFileSelected(true, false, true), true);
});

test('AnyFileSelected: "..\" is not a file, so a focus on it never counts', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, focusedName: '..', hasFocus: true });
  assert.strictEqual(p.anyFileSelected(true, false, true), false);
});

test('AnyFileSelected: filesOnly consults FFilesSelected, not SelCount', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['sub'] });
  assert.strictEqual(p.anyFileSelected(false, false, false), true);   // something is selected
  assert.strictEqual(p.anyFileSelected(false, true, false), false);   // but no *file* is
});

test('the parent directory can never enter the selection', () => {
  const p = panel({ side: 'remote', entries: ENTRIES }).selectAll(E.SELECT_MODES.all);
  assert.deepStrictEqual([...p.selectedNames].sort(), ['alpha.txt', 'beta.log', 'sub']);
  assert.strictEqual(p.selCount, 3);
  assert.strictEqual(p.filesCount, 3);
  assert.strictEqual(p.selectedAllFiles(), true);
});

test('OperateOnFocusedFile: a focused item outside the selection wins over it', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['beta.log'], focusedName: 'alpha.txt' });
  assert.deepStrictEqual(p.createFileList({ focused: true }).map((f) => f.name), ['alpha.txt']);
  // ... but a focused item that IS selected falls back to the whole selection.
  const q = panel({ side: 'remote', entries: ENTRIES, selected: ['beta.log'], focusedName: 'beta.log' });
  assert.deepStrictEqual(q.createFileList({ focused: true }).map((f) => f.name), ['beta.log']);
  // ... and without `focused` the selection is used even when the focus differs.
  assert.deepStrictEqual(p.createFileList({}).map((f) => f.name), ['beta.log']);
});

test('createFileList: remote lists names, local lists full paths', () => {
  const remote = panel({ side: 'remote', path: '/home/joe', entries: ENTRIES, selected: ['alpha.txt'] });
  assert.deepStrictEqual(remote.createFileList({}).map((f) => f.path), ['alpha.txt']);
  assert.deepStrictEqual(remote.createFileList({ fullPath: true }).map((f) => f.path), ['/home/joe/alpha.txt']);

  const local = panel({ side: 'local', path: 'C:\\work', entries: ENTRIES, selected: ['alpha.txt'] });
  assert.deepStrictEqual(local.createFileList({}).map((f) => f.path), ['C:\\work\\alpha.txt']);
});

test('createFocusedFileList is exactly the focused item, selection or not', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt', 'beta.log'], focusedName: 'sub' });
  assert.deepStrictEqual(p.createFocusedFileList(false).map((f) => f.name), ['sub']);
});

test('saveSelection restores only names that still exist; a failure discards it', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt', 'beta.log'] });
  p.saveSelection();
  p.entries = p.entries.filter((e) => e.name !== 'beta.log');
  p.selectedNames = new Set();
  p.restoreSelection();
  assert.deepStrictEqual([...p.selectedNames], ['alpha.txt']);

  p.saveSelection();
  p.discardSavedSelection();
  p.selectedNames = new Set();
  p.restoreSelection();
  assert.deepStrictEqual([...p.selectedNames], []);
});

test('SelectSameExt: a file with no extension selects other extensionless files', () => {
  const entries = [{ name: '..' }, { name: 'README' }, { name: 'LICENSE' }, { name: 'a.txt' }];
  const p = panel({ side: 'remote', entries, focusedName: 'README' });
  const r = p.selectSameExt(true);
  assert.strictEqual(r.mask, '*.');
  assert.deepStrictEqual([...p.selectedNames].sort(), ['LICENSE', 'README']);
});

test('SelectSameExt: a real extension selects its siblings only', () => {
  const p = panel({ side: 'remote', entries: ENTRIES, focusedName: 'alpha.txt' });
  const r = p.selectSameExt(true);
  assert.strictEqual(r.mask, '*.txt');
  assert.deepStrictEqual([...p.selectedNames], ['alpha.txt']);
});

// ===========================================================================
// side resolution
// ===========================================================================

test('GetSide / GetOtherSide resolve "current" and "other" against the focused panel', () => {
  const shell = makeShell({ panels: { local: panel({ side: 'local' }), remote: panel({ side: 'remote' }) } });
  shell.currentSide = 'local';
  assert.strictEqual(shell.getSide(), 'local');
  assert.strictEqual(shell.getSide('current'), 'local');
  assert.strictEqual(shell.getSide('other'), 'remote');
  assert.strictEqual(shell.getOtherSide('current'), 'remote');
  assert.strictEqual(shell.getOtherSide('remote'), 'local');
});

test('IsSideLocalBrowser: a local-local workspace makes BOTH sides local', () => {
  const shell = makeShell({ panels: { local: panel({ side: 'local' }), remote: panel({ side: 'remote' }) } });
  assert.strictEqual(shell.isSideLocalBrowser('remote'), false);
  shell.localBrowserMode = true;
  assert.strictEqual(shell.isSideLocalBrowser('remote'), true);
});

test('the explorer interface has no local panel at all', () => {
  const shell = makeShell({ panels: { local: panel({ side: 'local' }), remote: panel({ side: 'remote' }) } });
  shell.supportsLocalBrowser = false;
  assert.strictEqual(shell.hasDirView('local'), false);
  assert.strictEqual(shell.hasDirView('remote'), true);
});

test('DirViewEnabled is false for a remote panel with no usable session', () => {
  const shell = makeShell({ session: null, panels: { remote: panel({ side: 'remote' }) } });
  assert.strictEqual(shell.dirViewEnabled('remote'), false);
  const live = makeShell({ panels: { remote: panel({ side: 'remote' }) } });
  assert.strictEqual(live.dirViewEnabled('remote'), true);
});

// ===========================================================================
// pure helpers
// ===========================================================================

test('DelimitFileNameMask escapes the characters that would turn a name into a pattern', () => {
  assert.strictEqual(E.delimitFileNameMask('report?2024*.txt'), 'report\\?2024\\*.txt');
  assert.strictEqual(E.delimitFileNameMask('plain.txt'), 'plain.txt');
  assert.strictEqual(E.delimitFileNameMask('a\\b'), 'a\\\\b');
});

test('ExtractCommonPath gives up when there is no shared root', () => {
  assert.strictEqual(E.extractCommonPath(['C:\\a\\b\\', 'C:\\a\\c\\'], false), 'C:\\a');
  assert.strictEqual(E.extractCommonPath(['C:\\a\\', 'D:\\a\\'], false), '');
  assert.strictEqual(E.extractCommonPath(['/x/y/', '/x/y/z/'], true), '/x/y');
});

test('the interactive pass removes prompts before file patterns are counted', () => {
  // Without the pass the bare `!` inside the prompt body reads as the file
  // pattern and a non-file command would be mistaken for a file command.
  assert.strictEqual(E.stripInteractivePatterns('echo "!?Sure?yes!"', false), 'echo "yes"');
});

// ===========================================================================
// delete — the refusal that matters most
// ===========================================================================

test('the alternative flag INVERTS the recycle preference, in both directions', () => {
  const recycling = makeShell({ prefs: { deleteToRecycleBin: true } });
  assert.strictEqual(recycling.deleteDecision('local', ['a'], false).recycle, true);
  assert.strictEqual(recycling.deleteDecision('local', ['a'], true).recycle, false);

  const deleting = makeShell({ prefs: { deleteToRecycleBin: false } });
  assert.strictEqual(deleting.deleteDecision('local', ['a'], false).recycle, false);
  assert.strictEqual(deleting.deleteDecision('local', ['a'], true).recycle, true);
});

test('remote recycling needs a recycle-bin path and a file not already in it', () => {
  const withBin = makeShell({
    session: fakeSession({
      sessionData: { sessionName: 't', deleteToRecycleBin: true, recycleBinPath: '/trash' },
      isRecycledFile: (name) => String(name).startsWith('/trash/'),
    }),
  });
  assert.strictEqual(withBin.deleteDecision('remote', ['/home/a'], false).recycle, true);
  // Already in the bin: recycling it again would only move it inside the bin.
  assert.strictEqual(withBin.deleteDecision('remote', ['/trash/a'], false).recycle, false);

  const noBin = makeShell({
    session: fakeSession({ sessionData: { sessionName: 't', deleteToRecycleBin: true, recycleBinPath: '' } }),
  });
  assert.strictEqual(noBin.deleteDecision('remote', ['/home/a'], false).recycle, false);
});

test('the delete confirmation names the file, or counts them', () => {
  const shell = makeShell({ prefs: { deleteToRecycleBin: false } });
  assert.strictEqual(shell.deleteDecision('remote', ['/home/a.txt'], false).query,
    "Are you sure you want to delete file 'a.txt'?");
  assert.strictEqual(shell.deleteDecision('remote', ['/a', '/b', '/c'], false).query,
    'Are you sure you want to delete 3 selected files?');

  const recycle = makeShell({ prefs: { deleteToRecycleBin: true } });
  assert.strictEqual(recycle.deleteDecision('local', ['C:\\x\\a.txt'], false).query,
    "Are you sure you want to move file 'a.txt' to recycle bin?");
});

test('cancelling the delete confirmation genuinely does not delete', async () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] });
  const shell = makeShell({ panels: { remote: p }, answers: ['cancel'], prefs: { confirmDeleting: true } });
  const result = await shell.executeDeleteFileOperation('remote', ['alpha.txt'], false);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(shell._test.calls.filter((c) => c.name === 'deleteFiles').length, 0);
});

test('"never ask again" on the delete confirmation writes the matching preference', async () => {
  const shell = makeShell({
    panels: { remote: panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] }) },
    answers: ['neverAskAgain'],
    prefs: { confirmDeleting: true, confirmRecycling: true },
  });
  const result = await shell.executeDeleteFileOperation('remote', ['alpha.txt'], false);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(shell._test.config.prefs.confirmDeleting, false);
  assert.strictEqual(shell._test.config.prefs.confirmRecycling, true);   // untouched
  assert.strictEqual(shell._test.calls.filter((c) => c.name === 'deleteFiles').length, 1);
});

test('deleting nothing is refused rather than asked about', async () => {
  const shell = makeShell({ panels: { remote: panel({ side: 'remote', entries: ENTRIES }) } });
  await assert.rejects(() => shell.executeDeleteFileOperation('remote', [], false), E.AbortError);
});

test('a delete that throws discards the saved selection instead of restoring it', async () => {
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] });
  const shell = makeShell({
    panels: { remote: p },
    ops: { deleteFiles: () => { throw new Error('server said no'); } },
  });
  await assert.rejects(() => shell.deleteFiles('remote', ['alpha.txt'], false), /server said no/);
  assert.strictEqual(p._savedSelection, null);
});

// ===========================================================================
// transfer parameters — CopyParamDialog
// ===========================================================================

function copyShell(over) {
  const o = over || {};
  return makeShell({
    prefs: { confirmTransferring: true, dDTransferConfirmation: 'auto', ...(o.prefs || {}) },
    panels: {
      local: panel({ side: 'local', path: 'C:\\work', entries: ENTRIES, selected: ['alpha.txt'] }),
      remote: panel({ side: 'remote', path: '/home/joe', entries: ENTRIES }),
    },
    queue: o.queue,
    session: o.session,
    copyDialog: o.copyDialog || (async () => ({ ok: true })),
    answers: o.answers,
  });
}

test('a transfer the dialog sends to the queue reports "did not proceed"', async () => {
  const added = [];
  const shell = copyShell({
    queue: { add: async (spec) => { added.push(spec); return { id: 'q1' }; } },
    copyDialog: async () => ({ ok: true, copyParam: { queue: true } }),
  });
  const result = await shell.copyParamDialog({
    direction: E.DIRECTIONS.toRemote,
    type: E.TRANSFER_TYPES.copy,
    files: [{ name: 'alpha.txt', path: 'C:\\work\\alpha.txt' }],
    targetDirectory: '/home/joe',
  });
  assert.strictEqual(result.queued, true);
  // proceed is false even though the user pressed OK — the foreground transfer
  // must NOT also run.
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].direction, 'upload');
  // The source selection is cleared so the files cannot be queued twice.
  assert.strictEqual(shell.panel('local').selCount, 0);
});

test('a temporary download is never queued, however the preset is set', async () => {
  const added = [];
  const shell = copyShell({
    queue: { add: async (s) => { added.push(s); return { id: 'q' }; } },
    copyDialog: async () => ({ ok: true, copyParam: { queue: true } }),
  });
  const result = await shell.copyParamDialog({
    direction: E.DIRECTIONS.toLocal,
    type: E.TRANSFER_TYPES.copy,
    temp: true,
    files: ['a.txt'],
    targetDirectory: 'C:\\temp',
  });
  assert.strictEqual(result.queued, false);
  assert.strictEqual(result.proceed, true);
  assert.strictEqual(added.length, 0);
});

test('the queue checkbox is disabled while the session encrypts files', async () => {
  let seen = null;
  const shell = copyShell({
    session: fakeSession({ encryptingFiles: true }),
    copyDialog: async (req) => { seen = req; return { ok: true }; },
  });
  await shell.copyParamDialog({
    direction: E.DIRECTIONS.toRemote, type: E.TRANSFER_TYPES.copy, files: ['a'], targetDirectory: '/t',
  });
  assert.strictEqual(seen.options.disableQueue, true);
});

test('"newer only" is disabled for an upload the protocol cannot do it on', async () => {
  let sftp = null;
  await copyShell({ copyDialog: async (r) => { sftp = r; return { ok: true }; } })
    .copyParamDialog({ direction: E.DIRECTIONS.toRemote, type: E.TRANSFER_TYPES.copy, files: ['a'], targetDirectory: '/t' });
  assert.notStrictEqual(sftp.copyParamAttrs.noNewerOnly, true);

  let dav = null;
  await copyShell({
    session: fakeSession({ protocol: 'webdav', protocolName: 'WebDAV' }),
    copyDialog: async (r) => { dav = r; return { ok: true }; },
  }).copyParamDialog({ direction: E.DIRECTIONS.toRemote, type: E.TRANSFER_TYPES.copy, files: ['a'], targetDirectory: '/t' });
  assert.strictEqual(dav.copyParamAttrs.noNewerOnly, true);
});

test('"do not show again" is pre-ticked only for drag and drop, and only while auto', () => {
  const auto = makeShell({ prefs: { dDTransferConfirmation: 'auto' } });
  assert.strictEqual(auto.getDoNotShowCopyDialogDefault(true), true);
  assert.strictEqual(auto.getDoNotShowCopyDialogDefault(false), false);

  const on = makeShell({ prefs: { dDTransferConfirmation: 'on' } });
  assert.strictEqual(on.getDoNotShowCopyDialogDefault(true), false);
});

test('unticking "do not show again" promotes the tri-state from auto to on', () => {
  const shell = makeShell({ prefs: { dDTransferConfirmation: 'auto' } });
  shell.handleDoNotShowCopyDialogAgain(true, false);
  assert.strictEqual(shell._test.config.prefs.dDTransferConfirmation, 'on');
});

test('ticking it for a drag turns it off and offers an undo', () => {
  const shell = makeShell({ prefs: { dDTransferConfirmation: 'auto' } });
  shell.handleDoNotShowCopyDialogAgain(true, true);
  assert.strictEqual(shell._test.config.prefs.dDTransferConfirmation, 'off');
  const note = shell._test.notes.find((n) => n.name === 'ddTransferConfirmOff');
  assert.ok(note && typeof note.undo === 'function');
  note.undo();
  assert.strictEqual(shell._test.config.prefs.dDTransferConfirmation, 'on');
});

test('ticking it outside a drag turns the ordinary transfer confirmation off', () => {
  const shell = makeShell({ prefs: { confirmTransferring: true, dDTransferConfirmation: 'auto' } });
  shell.handleDoNotShowCopyDialogAgain(false, true);
  assert.strictEqual(shell._test.config.prefs.confirmTransferring, false);
  // The drag setting is a separate decision and must not be dragged along.
  assert.strictEqual(shell._test.config.prefs.dDTransferConfirmation, 'auto');
});

test('cancelling the transfer dialog stops the transfer', async () => {
  const shell = copyShell({ copyDialog: async () => ({ ok: false }) });
  const result = await shell.executeCopyMoveFileOperation(
    E.OPERATIONS.copy, 'local', [{ name: 'alpha.txt', path: 'C:\\work\\alpha.txt' }], false,
    { targetDirectory: '/home/joe' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(shell._test.calls.filter((c) => c.name === 'copyToRemote').length, 0);
});

test('Param.Queue overrides the preset, but "auto" leaves it alone', async () => {
  const seen = [];
  const mk = (queue) => copyShell({
    copyDialog: async (r) => { seen.push(r.copyParam.queue); return { ok: false }; },
    prefs: { copyParam: { queue: true } },
  }).executeCopyMoveFileOperation(E.OPERATIONS.copy, 'local', ['a'], false,
    { targetDirectory: '/t', queue });

  await mk('off');
  await mk('on');
  await mk('auto');
  assert.deepStrictEqual(seen, [false, true, undefined]);
});

test('ExecuteCopyOperationCommand: coAllFiles when the whole directory is selected', () => {
  const p = panel({ side: 'local', entries: ENTRIES, selected: ['alpha.txt', 'beta.log', 'sub'] });
  const shell = makeShell({ panels: { local: p }, prefs: { interface: 'commander' } });
  const param = shell.copyOperationParams('local', [E.COPY_COMMAND_FLAGS.shortCutHint, E.COPY_COMMAND_FLAGS.queue]);
  assert.strictEqual(param.options.allFiles, true);
  assert.strictEqual(param.options.shortCutHint, true);
  assert.strictEqual(param.queue, 'on');
});

test('the shortcut hint is dropped where its key is not bound', () => {
  const p = panel({ side: 'local', entries: ENTRIES });
  const explorer = makeShell({ panels: { local: p }, prefs: { interface: 'explorer' } });
  assert.strictEqual(explorer.copyOperationParams('local', [E.COPY_COMMAND_FLAGS.shortCutHint]).options.shortCutHint,
    undefined);
  const commanderWithExplorerKeys = makeShell({
    panels: { local: p },
    prefs: { interface: 'commander', scpCommander: { explorerKeyboardShortcuts: true } },
  });
  assert.strictEqual(
    commanderWithExplorerKeys.copyOperationParams('local', [E.COPY_COMMAND_FLAGS.shortCutHint]).options.shortCutHint,
    undefined);
});

test('moving a running transfer to the queue resumes the interrupted file and skips the finished ones', () => {
  const shell = makeShell({});
  const plan = shell.moveTransferToQueuePlan({
    direction: E.DIRECTIONS.toRemote,
    files: ['a', 'b', 'c'],
    targetDirectory: '/t',
    copyParam: { queueNoConfirmation: true },
    transferResumeList: ['a', 'b'],
  });
  assert.strictEqual(plan.copyParam.transferResumeFile, 'b');
  assert.deepStrictEqual(plan.copyParam.transferSkipList, ['a']);
  assert.strictEqual(plan.params.noConfirmation, true);
});

test('moving a running delete to the queue drops what is already gone', () => {
  const shell = makeShell({});
  const remote = shell.moveDeleteToQueuePlan({ remote: true, files: ['/a', '/A', '/b'], deletedFiles: ['/a'] });
  assert.deepStrictEqual(remote.files, ['/A', '/b']);   // case sensitive remotely
  const local = shell.moveDeleteToQueuePlan({ remote: false, files: ['C:\\a', 'C:\\A', 'C:\\b'], deletedFiles: ['C:\\a'] });
  assert.deepStrictEqual(local.files, ['C:\\b']);       // case insensitive locally
});

// ===========================================================================
// the command (secondary shell) session
// ===========================================================================

test('a capability the protocol already has needs no confirmation', async () => {
  const shell = makeShell({});
  assert.strictEqual(await shell.ensureCommandSessionFallback('calculatingChecksum'), true);
  assert.strictEqual(shell._test.asked.length, 0);
});

test('a protocol with no shell at all is REFUSED, not asked', async () => {
  const shell = makeShell({
    session: fakeSession({ protocol: 'webdav', caps: { checksum: false, exec: false } }),
  });
  await assert.rejects(() => shell.ensureCommandSessionFallback('calculatingChecksum'), E.NotSupportedError);
  assert.strictEqual(shell._test.asked.length, 0);
});

test('declining the shell-session confirmation stops the operation', async () => {
  const shell = makeShell({
    session: fakeSession({ caps: { exec: true, checksum: false } }),
    answers: ['cancel'],
    ops: { openCommandSession: () => { throw new Error('must not open'); } },
  });
  assert.strictEqual(await shell.ensureCommandSessionFallback('calculatingChecksum'), false);
  assert.strictEqual(shell._test.asked[0].name, 'commandSession');
});

test('"never ask again" on the shell-session confirmation opens it and remembers', async () => {
  let opened = 0;
  const shell = makeShell({
    session: fakeSession({ caps: { exec: true, checksum: false } }),
    answers: ['neverAskAgain'],
    prefs: { confirmCommandSession: true },
    ops: { openCommandSession: () => { opened++; return true; } },
  });
  assert.strictEqual(await shell.ensureCommandSessionFallback('calculatingChecksum'), true);
  assert.strictEqual(opened, 1);
  assert.strictEqual(shell._test.config.prefs.confirmCommandSession, false);
});

test('CanCalculateChecksum refuses a shell checksum over encrypted files', () => {
  const plain = makeShell({ session: fakeSession({ caps: { exec: true, checksum: false } }) });
  assert.strictEqual(plain.canCalculateChecksum(), true);
  // The shell would hash the ciphertext, which matches nothing the user can
  // compare against — so WinSCP refuses rather than returning a useless number.
  const encrypted = makeShell({
    session: fakeSession({ caps: { exec: true, checksum: false }, encryptingFiles: true }),
  });
  assert.strictEqual(encrypted.canCalculateChecksum(), false);
});

// ===========================================================================
// custom command state — the tri-state
// ===========================================================================

function ccShell(over) {
  const o = over || {};
  return makeShell({
    session: o.session === undefined ? fakeSession() : o.session,
    panels: {
      local: o.local || panel({ side: 'local', path: 'C:\\w', entries: ENTRIES }),
      remote: o.remote || panel({ side: 'remote', path: '/r', entries: ENTRIES }),
    },
    ...(o.rest || {}),
  });
}

test('a remote command that touches no files is enabled anywhere but hidden in the file menu', () => {
  const shell = ccShell({});
  const cmd = { command: 'uptime', params: {} };
  assert.strictEqual(shell.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.enabled);
  assert.strictEqual(shell.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.nonFile), E.COMMAND_STATE.enabled);
  assert.strictEqual(shell.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.file), E.COMMAND_STATE.hidden);
});

test('a remote file command is disabled with nothing selected and enabled with a selection', () => {
  const cmd = { command: 'grep -n x !', params: {} };
  const empty = ccShell({});
  assert.strictEqual(empty.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.disabled);

  const selected = ccShell({
    remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  assert.strictEqual(selected.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.enabled);
});

test('a remote command is disabled outright on a protocol with no shell', () => {
  const shell = ccShell({
    session: fakeSession({ protocol: 's3', caps: { exec: false } }),
    remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  assert.strictEqual(shell.customCommandRemoteAllowed(), false);
  assert.strictEqual(shell.customCommandState({ command: 'grep x !', params: {} }, false, E.COMMAND_LIST_TYPE.all),
    E.COMMAND_STATE.disabled);
});

test('a "diff"-style local command needs a selection on BOTH panels', () => {
  const cmd = { command: 'diff !^ !', params: { local: true } };

  const onlyRemote = ccShell({
    remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  assert.strictEqual(onlyRemote.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.disabled);

  const both = ccShell({
    local: panel({ side: 'local', path: 'C:\\w', entries: ENTRIES, selected: ['alpha.txt'] }),
    remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  assert.strictEqual(both.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.enabled);
  // In the "both sides" menu it is always offered.
  assert.strictEqual(both.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.both), E.COMMAND_STATE.enabled);
  assert.strictEqual(both.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.nonFile), E.COMMAND_STATE.hidden);
});

test('a local command that expands session patterns is disabled with no session', () => {
  const cmd = { command: 'winscp.com /command "open !S"', params: { local: true } };
  const withSession = ccShell({});
  assert.strictEqual(withSession.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.enabled);
  const without = ccShell({ session: null });
  assert.strictEqual(without.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all), E.COMMAND_STATE.disabled);
});

test('AdHocCustomCommandValidate refuses an impossible command instead of running it', () => {
  const shell = ccShell({});
  assert.throws(() => shell.adHocCustomCommandValidate({ command: 'grep x !', params: {} }, false),
    /cannot be executed right now/);
});

// ===========================================================================
// remote (server-side) copy and move
// ===========================================================================

test('a server-side copy needs the secondary shell for directories on a shell-copy protocol', () => {
  const shell = makeShell({
    session: fakeSession({ caps: { exec: true, copyRemote: true, move: true } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) },
  });
  const files = [{ name: 'alpha.txt', entry: { isDirectory: false } }];
  const dirs = [{ name: 'sub', entry: { isDirectory: true } }];
  assert.strictEqual(shell.needSecondarySessionForRemoteCopy(files), false);
  assert.strictEqual(shell.needSecondarySessionForRemoteCopy(dirs), true);
});

test('a protocol with no server-side copy always needs the fallback', () => {
  const shell = makeShell({
    session: fakeSession({ caps: { exec: false, copyRemote: false } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) },
  });
  assert.strictEqual(shell.needSecondarySessionForRemoteCopy([{ name: 'a', entry: { isDirectory: false } }]), true);
});

test('the remote-copy request delimits a single file name used as a mask', () => {
  const shell = makeShell({
    session: fakeSession({ caps: { exec: false, copyRemote: true, move: true } }),
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: ENTRIES }) },
  });
  const one = shell.remoteTransferRequest({ files: ['/home/joe/what?.txt'] });
  assert.strictEqual(one.fileMask, 'what\\?.txt');
  assert.strictEqual(one.target, '/home/joe/');
  assert.strictEqual(one.multi, false);

  const many = shell.remoteTransferRequest({ files: ['/a', '/b'] });
  assert.strictEqual(many.fileMask, E.ANY_MASK);
  assert.strictEqual(many.multi, true);
});

test('how much direct copying the dialog may offer follows the capability matrix', () => {
  const mk = (caps, over) => makeShell({
    session: fakeSession({ caps, ...(over || {}) }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) },
  }).remoteTransferRequest({ files: [{ name: 'a', entry: { isDirectory: false } }] });

  // Native server-side copy: nothing to confirm.
  assert.strictEqual(mk({ copyRemote: true, exec: false }).allowDirectCopy, E.DIRECT_REMOTE_COPY.allow);
  // Shell only: the shell has to be opened first, and that is a confirmation.
  assert.strictEqual(mk({ copyRemote: false, exec: true }).allowDirectCopy,
    E.DIRECT_REMOTE_COPY.confirmCommandSession);
  // Neither: the dialog must not offer a direct copy at all.
  assert.strictEqual(mk({ copyRemote: false, exec: false }).allowDirectCopy, E.DIRECT_REMOTE_COPY.disallow);
  // Shell already open: no confirmation needed.
  assert.strictEqual(mk({ copyRemote: false, exec: true }, { commandSessionOpened: true }).allowDirectCopy,
    E.DIRECT_REMOTE_COPY.allow);
});

test('a direct remote copy whose shell fallback fails does not copy anything', async () => {
  // RemoteTransferFiles calls CommandSessionFallback() directly, NOT
  // EnsureCommandSessionFallback — the confirmation already happened inside the
  // remote-copy dialog (drcConfirmCommandSession). So the only question left
  // here is whether the shell actually came up; when it does not, WinSCP simply
  // does not copy, and does not silently fall back to the slow route either.
  const failing = makeShell({
    session: fakeSession({ caps: { exec: true, copyRemote: false, move: true } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }) },
    ops: { openCommandSession: () => false },
  });
  const result = await failing.remoteTransferFiles(
    [{ name: 'alpha.txt', path: '/r/alpha.txt', entry: { isDirectory: false } }], true, false, null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.refused, 'commandSession');
  assert.strictEqual(failing._test.calls.filter((c) => c.name === 'copyFiles').length, 0);

  // With the shell already open there is nothing to fall back to, and the copy
  // goes ahead.
  const open = makeShell({
    session: fakeSession({ caps: { exec: true, copyRemote: false, move: true }, commandSessionOpened: true }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }) },
  });
  const ok = await open.remoteTransferFiles(
    [{ name: 'alpha.txt', path: '/r/alpha.txt', entry: { isDirectory: false } }], true, false, null);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(open._test.calls.filter((c) => c.name === 'copyFiles').length, 1);
});

// ===========================================================================
// queue
// ===========================================================================

function queueShell(items, over) {
  return makeShell({
    queue: { list: () => items, enabled: true, setEnabled() {} },
    ...(over || {}),
  });
}

test('DefaultQueueOperation maps the item state to what a double-click does', () => {
  const shell = queueShell([]);
  const map = {
    pending: 'itemExecute', query: 'itemQuery', error: 'itemError',
    prompt: 'itemPrompt', active: 'itemPause', paused: 'itemResume', done: 'none',
  };
  for (const [state, op] of Object.entries(map)) {
    assert.strictEqual(shell.defaultQueueOperation({ id: 'x', state }), op, state);
  }
  assert.strictEqual(shell.defaultQueueOperation(null), 'none');
});

test('"move up" is refused when the item above is not itself pending', () => {
  const items = [
    { id: 'a', state: 'active', operation: 'copy' },
    { id: 'b', state: 'pending', operation: 'copy' },
    { id: 'c', state: 'pending', operation: 'copy' },
  ];
  const shell = queueShell(items);
  // b is pending but a above it is running — moving b up would put it ahead of
  // a transfer already in flight.
  assert.strictEqual(shell.allowQueueOperation('itemUp', { item: items[1] }), false);
  assert.strictEqual(shell.allowQueueOperation('itemUp', { item: items[2] }), true);
  assert.strictEqual(shell.allowQueueOperation('itemDown', { item: items[2] }), false);
  assert.strictEqual(shell.allowQueueOperation('itemDown', { item: items[1] }), true);
});

test('queue operations that need a live item are refused with none focused', () => {
  const shell = queueShell([{ id: 'a', state: 'pending', operation: 'copy' }]);
  for (const op of ['itemExecute', 'itemDelete', 'itemPause', 'itemResume', 'itemQuery', 'itemSpeed']) {
    assert.strictEqual(shell.allowQueueOperation(op, {}), false, op);
  }
  assert.strictEqual(shell.allowQueueOperation('preferences', {}), true);
});

test('pause-all / resume-all / delete-all-done read the whole list', () => {
  const shell = queueShell([
    { id: 'a', state: 'active', operation: 'copy' },
    { id: 'b', state: 'done', operation: 'copy' },
  ]);
  assert.strictEqual(shell.allowQueueOperation('pauseAll', {}), true);
  assert.strictEqual(shell.allowQueueOperation('resumeAll', {}), false);
  assert.strictEqual(shell.allowQueueOperation('deleteAllDone', {}), true);
  assert.strictEqual(shell.allowQueueOperation('deleteAll', {}), true);
  assert.strictEqual(shell.allowQueueOperation('onceEmpty', {}), true);
});

test('"go to queue" is refused when the queue view is not there to go to', () => {
  const shell = queueShell([]);
  assert.strictEqual(shell.allowQueueOperation('goTo', { queueViewVisible: false, queueViewEnabled: true }), false);
  assert.strictEqual(shell.allowQueueOperation('goTo', { queueViewVisible: true, queueViewEnabled: true }), true);
});

test('CanCloseQueue asks before terminating pending transfers, and takes no for an answer', async () => {
  const empty = queueShell([{ id: 'a', state: 'done', operation: 'copy' }]);
  assert.strictEqual(await empty.canCloseQueue(), true);
  assert.strictEqual(empty._test.asked.length, 0);

  const busy = queueShell([{ id: 'a', state: 'active', operation: 'copy' }], { answers: ['cancel'] });
  assert.strictEqual(await busy.canCloseQueue(), false);
  assert.match(busy._test.asked[0].message, /terminate all transfers immediately/i);

  const insisting = queueShell([{ id: 'a', state: 'active', operation: 'copy' }], { answers: ['ok'] });
  assert.strictEqual(await insisting.canCloseQueue(), true);
});

test('closing a tab is blocked by the queue confirmation', async () => {
  const shell = queueShell([{ id: 'a', state: 'pending', operation: 'copy' }], { answers: ['cancel'] });
  assert.strictEqual(await shell.closeTab(), false);
  assert.strictEqual(shell._test.calls.filter((c) => c.name === 'closeSession').length, 0);
});

// ===========================================================================
// session and window lifecycle
// ===========================================================================

test('the last local browser cannot be closed', () => {
  const localOnly = fakeSession({ localBrowser: true });
  const alone = makeShell({ session: localOnly, sessions: [localOnly] });
  assert.strictEqual(alone.canCloseSession(localOnly), false);
  const withCompany = makeShell({ session: localOnly, sessions: [localOnly, fakeSession({ id: 's2' })] });
  assert.strictEqual(withCompany.canCloseSession(localOnly), true);
  assert.strictEqual(withCompany.canCloseSession(fakeSession({ id: 's2' })), true);
});

test('closeTab enforces the last local-browser workspace floor on the production path', async () => {
  const localOnly = fakeSession({ localBrowser: true });
  const shell = makeShell({
    session: localOnly,
    sessions: [localOnly],
    queue: { list: () => [] },
  });

  assert.strictEqual(await shell.closeTab(), false);
  assert.strictEqual(shell._test.calls.filter((c) => c.name === 'closeSession').length, 0);
});

test('FormCloseQuery offers Yes/No/Cancel only when no workspace will be saved', async () => {
  const withoutAutoSave = makeShell({
    prefs: { confirmClosingSession: true, window: { autoSaveWorkspace: false } },
    queue: { list: () => [] },
    answers: ['yes'],
  });
  const r1 = await withoutAutoSave.formCloseQuery({});
  assert.deepStrictEqual(withoutAutoSave._test.asked[0].buttons, ['yes', 'no', 'cancel']);
  assert.match(withoutAutoSave._test.asked[0].message, /without saving a workspace/);
  assert.strictEqual(r1.canClose, true);

  const withAutoSave = makeShell({
    prefs: { confirmClosingSession: true, window: { autoSaveWorkspace: true, autoWorkspace: 'Daily' } },
    queue: { list: () => [] },
    answers: ['ok'],
  });
  await withAutoSave.formCloseQuery({});
  assert.deepStrictEqual(withAutoSave._test.asked[0].buttons, ['ok', 'cancel']);
  assert.match(withAutoSave._test.asked[0].message, /Workspace 'Daily' will be automatically saved/);
});

test('answering "No" saves a workspace rather than refusing to close', async () => {
  let saved = 0;
  const shell = makeShell({
    prefs: { confirmClosingSession: true, window: { autoSaveWorkspace: false } },
    queue: { list: () => [] },
    answers: ['no'],
    ops: { saveWorkspace: () => { saved++; return true; } },
  });
  const r = await shell.formCloseQuery({});
  assert.strictEqual(saved, 1);
  assert.strictEqual(r.saveWorkspace, true);
  assert.strictEqual(r.canClose, true);
});

test('open editors block the close, and Ignore warns rather than silently deleting', async () => {
  const shell = makeShell({
    prefs: { confirmClosingSession: false },
    queue: { list: () => [] },
    answers: ['cancel'],
  });
  const r = await shell.formCloseQuery({ editorsOpen: true });
  assert.strictEqual(r.canClose, false);
  assert.match(shell._test.asked[0].message, /may remain in temporary directory/);
});

test('a busy application refuses to close without asking anything', async () => {
  const shell = makeShell({ queue: { list: () => [] } });
  const r = await shell.formCloseQuery({ busy: true });
  assert.strictEqual(r.canClose, false);
  assert.strictEqual(shell._test.asked.length, 0);
});

test('NeedSession only terminates when the user genuinely had a chance to act', () => {
  const shell = makeShell({
    session: null,
    prefs: { showLoginWhenNoSession: false, window: { keepOpenWhenNoSession: false } },
  });
  // Starting up with no login dialog: the user has had no chance yet.
  assert.strictEqual(shell.needSession(true).terminate, false);
  assert.strictEqual(shell.needSession(false).terminate, true);

  const keepOpen = makeShell({
    session: null,
    prefs: { showLoginWhenNoSession: true, window: { keepOpenWhenNoSession: true } },
  });
  assert.strictEqual(keepOpen.needSession(false).terminate, false);
});

test('RenameTab refuses a slash, because site names are hierarchical', () => {
  const shell = makeShell({});
  assert.throws(() => shell.renameTab('a/b', 'old'), /cannot include a slash/);
  assert.throws(() => shell.renameTab('   ', 'old'), /cannot be empty/);
  assert.deepStrictEqual(shell.renameTab('same', 'same'), { changed: false, name: 'same' });
  assert.deepStrictEqual(shell.renameTab('new', 'old'), { changed: true, name: 'new' });
});

test('DuplicateTab carries the disconnected flags so a duplicate does not dial out', () => {
  const shell = makeShell({
    session: fakeSession({ disconnected: true, disconnectedTemporarily: true, permanent: true }),
  });
  const plan = shell.duplicateTabPlan();
  assert.strictEqual(plan.disconnected, true);
  assert.strictEqual(plan.disconnectedTemporarily, true);
  assert.strictEqual(plan.permanent, true);
});

test('clicking the "+" tab opens a session instead of switching to nothing', () => {
  const shell = makeShell({});
  assert.deepStrictEqual(shell.sessionTabSwitched(null), { switched: false, newTab: true });
  const s = fakeSession({ id: 's9' });
  const r = shell.sessionTabSwitched({ session: s });
  assert.strictEqual(r.switched, true);
  assert.strictEqual(shell._test.calls.some((c) => c.name === 'setActiveSession'), true);
});

// ===========================================================================
// drag and drop
// ===========================================================================

test('a drop on the remote panel\'s free space is refused', () => {
  const shell = makeShell({});
  const effect = shell.chooseDropEffect({
    effect: 1, fromRemotePanel: true, ontoDirView: true, fromDirView: true, dropTarget: null,
  });
  assert.strictEqual(effect, 0);
});

test('a remote drop onto the current directory is refused, while a child remains valid', () => {
  const shell = makeShell({
    panels: { remote: panel({ side: 'remote', path: '/srv/project', entries: ENTRIES }) },
  });
  const base = {
    effect: 1, fromRemotePanel: true, ontoDirView: true, fromDirView: true,
  };
  assert.strictEqual(shell.chooseDropEffect({ ...base, dropTarget: '/srv/project/' }), 0);
  assert.strictEqual(shell.chooseDropEffect({ ...base, dropTarget: '/srv/project/archive' }), 2);
});

test('inside the remote panel the default is move, and Ctrl means copy', () => {
  const shell = makeShell({ session: fakeSession({ caps: { move: true, copyRemote: true } }) });
  const base = { effect: 1, fromRemotePanel: true, ontoDirView: true, fromDirView: true, dropTarget: 'sub' };
  assert.strictEqual(shell.chooseDropEffect(base), 2);                       // MOVE
  assert.strictEqual(shell.chooseDropEffect({ ...base, ctrl: true }), 1);    // COPY
});

test('a protocol that cannot move falls back to copy rather than doing nothing', () => {
  const shell = makeShell({ session: fakeSession({ caps: { move: false, copyRemote: true } }) });
  const effect = shell.chooseDropEffect({
    effect: 1, fromRemotePanel: true, ontoDirView: true, fromDirView: true, dropTarget: 'sub',
  });
  assert.strictEqual(effect, 1);
});

test('dragging all files requires the panel to report an all-file selection', () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', filesCount: 2, entries: ENTRIES, selected: ['alpha.txt'] }),
    },
  });
  assert.strictEqual(shell.draggingAllFilesFromDirView('local', [
    { name: 'alpha.txt' }, { name: 'beta.txt' },
  ], 'local'), false);

  const all = makeShell({
    panels: {
      local: panel({ side: 'local', entries: ENTRIES, selected: ['alpha.txt', 'beta.log', 'sub'] }),
    },
  });
  assert.strictEqual(all.draggingAllFilesFromDirView('local', [
    { name: 'alpha.txt' }, { name: 'beta.log' }, { name: 'sub' },
  ], 'local'), true);
});

test('an ambiguous drag result prefers copy — a wrong move deletes the source', () => {
  const shell = makeShell({});
  assert.strictEqual(shell.dropResultOperation('invalid', 0), 'copy');
  assert.strictEqual(shell.dropResultOperation('invalid', 2), 'move');
  assert.strictEqual(shell.dropResultOperation('copy', 2), 'copy');
  assert.strictEqual(shell.dropResultOperation('none', 2), null);
});

test('a drop on the queue view forces the transfer into the background', () => {
  const shell = makeShell({});
  const target = shell.ddGetTarget({ ontoQueueView: true, defaultDownloadTarget: 'C:\\down' });
  assert.deepStrictEqual(
    { ok: target.ok, directory: target.directory, forceQueue: target.forceQueue },
    { ok: true, directory: 'C:\\down', forceQueue: true });

  const unknown = shell.ddGetTarget({});
  assert.strictEqual(unknown.ok, false);
});

test('a queue drop is refused when its download target is blank', () => {
  const shell = makeShell({});
  for (const defaultDownloadTarget of ['', '   ', undefined, null]) {
    const target = shell.ddGetTarget({ ontoQueueView: true, defaultDownloadTarget });
    assert.strictEqual(target.ok, false, `blank target ${String(defaultDownloadTarget)} must be refused`);
    assert.strictEqual(target.counterName, 'DownloadsDragDropQueueTargetUnknown');
  }
});

test('fake-file and external-extension targets refuse whitespace-only handshakes', () => {
  const shell = makeShell({});
  for (const spec of [
    { fakeFileDropTarget: '   ' },
    { externalDropDirectory: '\t\r\n' },
  ]) {
    const target = shell.ddGetTarget(spec);
    assert.deepStrictEqual(target, {
      ok: false,
      forceQueue: false,
      counterName: 'DownloadsDragDropExternalExtTargetUnknown',
    });
  }
});

test('the lack-of-temp-space warning can be refused, and switched off for good', async () => {
  const refusing = makeShell({
    prefs: { dDWarnLackOfTempSpace: true, dDWarnLackOfTempSpaceRatio: 1.1 },
    answers: ['no'],
  });
  assert.strictEqual(await refusing.warnLackOfTempSpace('C:\\t', 1000, { freeSpace: 10 }), false);

  const forever = makeShell({
    prefs: { dDWarnLackOfTempSpace: true, dDWarnLackOfTempSpaceRatio: 1.1 },
    answers: ['neverAskAgain'],
  });
  assert.strictEqual(await forever.warnLackOfTempSpace('C:\\t', 1000, { freeSpace: 10 }), true);
  assert.strictEqual(forever._test.config.prefs.dDWarnLackOfTempSpace, false);

  // Plenty of room: nothing is asked at all.
  const roomy = makeShell({ prefs: { dDWarnLackOfTempSpace: true } });
  assert.strictEqual(await roomy.warnLackOfTempSpace('C:\\t', 100, { freeSpace: 1e9 }), true);
  assert.strictEqual(roomy._test.asked.length, 0);
});

test('a drop suppresses the transfer dialog only when the preference says off', async () => {
  const seen = [];
  const mk = (setting) => copyShell({
    prefs: { dDTransferConfirmation: setting },
    copyDialog: async (r) => { seen.push(r); return { ok: false }; },
  }).dragDropFileOperation({
    effect: 1, files: [{ name: 'alpha.txt', path: 'C:\\work\\alpha.txt' }], targetPath: '/home/joe',
  });

  await mk('on');
  assert.strictEqual(seen.length, 1);
  await mk('off');
  assert.strictEqual(seen.length, 1);   // no dialog was shown the second time
});

test('a refused or unknown drop effect never becomes an upload', async () => {
  const calls = [];
  const shell = copyShell({
    ops: {
      copyToRemote: (...args) => { calls.push(args); return true; },
    },
  });
  for (const effect of [0, 4, 99, 'not-a-drop-effect']) {
    const result = await shell.dragDropFileOperation({
      effect,
      files: [{ name: 'alpha.txt', path: 'C:\\work\\alpha.txt' }],
      targetPath: '/home/joe',
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'invalidDropEffect' });
  }
  assert.strictEqual(calls.length, 0);
});

// ===========================================================================
// transfer preset auto-selection
// ===========================================================================

function presetConfig(prefs) {
  const list = new CopyParamList([
    { name: 'Text', copyParam: { transferMode: 'ascii' }, rule: { hostName: 'example.org' } },
    { name: 'Big', copyParam: { transferMode: 'binary' }, rule: { remoteDirectory: '/big' } },
  ]);
  const store = { ...(prefs || {}) };
  return {
    prefs: store,
    copyParamList: list,
    copyParamCurrent: '',
    get copyParamIndex() { return this.copyParamCurrent ? list.indexOfName(this.copyParamCurrent) : -1; },
    setPref(name, value) { store[name] = value; },
    currentCopyParam: {},
  };
}

test('a matching rule selects its preset and notes why', () => {
  const config = presetConfig({ copyParamAutoSelectNotice: true });
  const shell = makeShell({
    config,
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: [] }) },
  });
  const r = shell.transferPresetAutoSelect();
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.name, 'Text');
  assert.match(r.message, /Transfer settings preset 'Text' was automatically selected/);
  assert.match(r.message, /Autoselection rule/);
});

test('re-selecting the same preset changes nothing, so a hand-picked one survives', () => {
  const config = presetConfig({});
  const shell = makeShell({
    config,
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: [] }) },
  });
  assert.strictEqual(shell.transferPresetAutoSelect().changed, true);
  // The user then picks something else by hand...
  config.copyParamCurrent = 'Big';
  // ... and browsing within the same rule's territory must not undo that.
  assert.strictEqual(shell.transferPresetAutoSelect().changed, false);
  assert.strictEqual(config.copyParamCurrent, 'Big');
});

test('leaving every rule returns to the default and says so', () => {
  const config = presetConfig({});
  const shell = makeShell({
    config,
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: [] }) },
  });
  shell.transferPresetAutoSelect();
  const other = makeShell({
    config,
    session: fakeSession({ sessionData: { sessionName: 't', hostName: 'other.net', userName: 'joe' } }),
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: [] }) },
  });
  other.copyParamAutoSelected = 'Text';
  const r = other.transferPresetAutoSelect();
  assert.strictEqual(r.changed, true);
  assert.strictEqual(config.copyParamCurrent, '');
  assert.match(r.message, /Returned back to default transfer settings/);
});

test('auto-selection is suppressed while the app is moving the panel itself', () => {
  const config = presetConfig({});
  const shell = makeShell({
    config,
    panels: { remote: panel({ side: 'remote', path: '/home/joe', entries: [] }) },
  });
  shell.allowTransferPresetAutoSelect = false;
  assert.deepStrictEqual(shell.transferPresetAutoSelect(), { changed: false, reason: 'suppressed' });
});

// ===========================================================================
// file editing and execution
// ===========================================================================

test('RemoteExecuteForceText: the internal editor always, an external one only when it says so', () => {
  const shell = makeShell({});
  assert.strictEqual(shell.remoteExecuteForceText(E.EXECUTE_FILE_BY.internalEditor, null), true);
  assert.strictEqual(shell.remoteExecuteForceText(E.EXECUTE_FILE_BY.externalEditor,
    { externalEditorText: true }), true);
  assert.strictEqual(shell.remoteExecuteForceText(E.EXECUTE_FILE_BY.externalEditor,
    { externalEditorText: false }), false);
  // "Open" hands the file to the shell untouched — a binary must not be
  // mangled into text mode.
  assert.strictEqual(shell.remoteExecuteForceText(E.EXECUTE_FILE_BY.shell, null), false);
});

test('TemporaryFileCopyParam turns off everything that would alter the file', () => {
  const shell = makeShell({ prefs: { copyParam: { fileNameCase: 'lower', preserveRights: true, newerOnly: true, fileMask: '*.bak', includeFileMask: '*.c' } } });
  const cp = shell.temporaryFileCopyParam(true);
  assert.strictEqual(cp.fileNameCase, 'noChange');
  assert.strictEqual(cp.preserveRights, false);
  assert.strictEqual(cp.preserveReadOnly, false);
  assert.strictEqual(cp.newerOnly, false);
  assert.strictEqual(cp.fileMask, '');
  assert.strictEqual(cp.includeFileMask, '');
  assert.strictEqual(cp.replaceInvalidChars, true);
  assert.strictEqual(cp.transferMode, 'ascii');
  assert.notStrictEqual(shell.temporaryFileCopyParam(false).transferMode, 'ascii');
});

test('ExecuteFileNormalize resolves "default editor" to a real one, including the shell', () => {
  const mk = (editor) => makeShell({
    config: { prefs: {}, defaultEditorForFile: () => editor, setPref() {} },
  }).executeFileNormalize({ executeFileBy: E.EXECUTE_FILE_BY.defaultEditor, fileName: 'a.txt' });

  assert.strictEqual(mk(null).executeFileBy, E.EXECUTE_FILE_BY.internalEditor);
  assert.strictEqual(mk({ data: { editor: 'internal' } }).executeFileBy, E.EXECUTE_FILE_BY.internalEditor);
  assert.strictEqual(mk({ data: { editor: 'open' } }).executeFileBy, E.EXECUTE_FILE_BY.shell);
  const ext = mk({ data: { editor: 'external', externalEditor: 'np.exe' } });
  assert.strictEqual(ext.executeFileBy, E.EXECUTE_FILE_BY.externalEditor);
  assert.strictEqual(ext.externalEditor.externalEditor, 'np.exe');
});

test('a file already open in another editor is REFUSED, not opened twice', () => {
  const refusing = makeShell({
    editors: { canAddFile: () => ({ ok: false }) },
  });
  assert.throws(() => refusing.canOpenForEdit('/r/', 'a.txt'), /already opened in external editor/);

  // When the other editor is one of ours, the existing window is focused instead.
  const focusing = makeShell({
    editors: { canAddFile: () => ({ ok: false, token: 'editor-1' }) },
  });
  assert.deepStrictEqual(focusing.canOpenForEdit('/r/', 'a.txt'),
    { ok: false, focusExisting: true, token: 'editor-1' });
});

test('EditorCheckNotModified needs both the preference and a recorded timestamp', () => {
  const on = makeShell({ prefs: { editorCheckNotModified: true } });
  assert.strictEqual(on.editorCheckNotModified({ sourceTimestamp: 1 }), true);
  assert.strictEqual(on.editorCheckNotModified({}), false);
  const off = makeShell({ prefs: { editorCheckNotModified: false } });
  assert.strictEqual(off.editorCheckNotModified({ sourceTimestamp: 1 }), false);
});

test('double-click resolution honours the preference, and "Open" overrides it', () => {
  const copying = makeShell({
    prefs: { panel: { doubleClickAction: 'copy' } },
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(copying.resolveDoubleClick('remote', { isDirectory: false }), 'copy');
  assert.strictEqual(copying.resolveDoubleClick('remote', { isDirectory: true }), 'changeDir');

  copying.forceExecution = true;
  assert.strictEqual(copying.resolveDoubleClick('remote', { isDirectory: false }), 'open');
  assert.strictEqual(copying.resolveDoubleClick('remote', { isDirectory: true }), 'changeDir');
});

test('a locked-down build refuses to open or edit remote files', () => {
  const shell = makeShell({
    prefs: { disableOpenEdit: true, panel: { doubleClickAction: 'edit' } },
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(shell.resolveDoubleClick('remote', { isDirectory: false }), 'none');
});

test('double-click copy is refused when there is no session to copy to', () => {
  const shell = makeShell({
    session: null,
    prefs: { panel: { doubleClickAction: 'copy' } },
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(shell.resolveDoubleClick('remote', { isDirectory: false }), 'none');
});

// ===========================================================================
// synchronize
// ===========================================================================

test('"selected files only" is offered when EITHER panel has a selection', () => {
  const neither = makeShell({
    panels: { local: panel({ side: 'local', entries: ENTRIES }), remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(neither.synchronizeAllowSelectedOnly(), false);

  const localOnly = makeShell({
    panels: {
      local: panel({ side: 'local', entries: ENTRIES, selected: ['alpha.txt'] }),
      remote: panel({ side: 'remote', entries: ENTRIES }),
    },
  });
  assert.strictEqual(localOnly.synchronizeAllowSelectedOnly(), true);
});

test('the selected-only filter is the union of both panels, sorted', () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', path: 'C:\\w', entries: ENTRIES, selected: ['beta.log'] }),
      remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt', 'beta.log'] }),
    },
  });
  const options = shell.getSynchronizeOptions({ selectedOnly: true });
  // "beta.log" appears twice on purpose — WinSCP sets Duplicates := dupAccept,
  // because a name selected on both sides must not cancel itself out.
  assert.deepStrictEqual(options.filter, ['alpha.txt', 'beta.log', 'beta.log']);
  assert.deepStrictEqual(shell.getSynchronizeOptions({ selectedOnly: false }).filter, null);
});

test('synchronization options disable what the protocol genuinely cannot do', () => {
  const dav = makeShell({
    session: fakeSession({ protocol: 'webdav', caps: { timestamp: false, checksum: false, exec: false } }),
    panels: { local: panel({ side: 'local', entries: [] }), remote: panel({ side: 'remote', entries: [] }) },
  });
  const options = dav.fullSynchronizeOptions();
  assert.strictEqual(options.disableTimestamp, true);
  assert.strictEqual(options.disableByChecksum, true);
});

test('a checksum synchronization on a protocol with neither checksum nor shell is refused', async () => {
  const shell = makeShell({
    session: fakeSession({ protocol: 'webdav', caps: { checksum: false, exec: false } }),
  });
  await assert.rejects(() => shell.ensureSynchronizeCapabilities({ byChecksum: true }), E.NotSupportedError);
  assert.strictEqual(await shell.ensureSynchronizeCapabilities({ byChecksum: false }), true);
});

test('watching too many directories asks before doubling the budget, and aborts on no', async () => {
  const raising = makeShell({ prefs: { maxWatchDirectories: 500 }, answers: ['yes'] });
  assert.strictEqual(await raising.tooManyWatchDirectories(500), 1000);

  const remembering = makeShell({ prefs: { maxWatchDirectories: 500 }, answers: ['neverAskAgain'] });
  assert.strictEqual(await remembering.tooManyWatchDirectories(500), 1000);
  assert.strictEqual(remembering._test.config.prefs.maxWatchDirectories, 1000);

  const refusing = makeShell({ prefs: { maxWatchDirectories: 500 }, answers: ['no'] });
  await assert.rejects(() => refusing.tooManyWatchDirectories(500), E.AbortError);

  // Below the configured ceiling it is simply raised, with nothing asked.
  const quiet = makeShell({ prefs: { maxWatchDirectories: 500 } });
  assert.strictEqual(await quiet.tooManyWatchDirectories(100), 500);
});

// ===========================================================================
// synchronized browsing (ScpCommander.cpp)
// ===========================================================================

test('moving the local panel deeper moves the remote one deeper too', () => {
  const shell = makeShell({});
  assert.strictEqual(
    shell.synchronizeBrowsingLocal('C:\\work\\proj', 'C:\\work\\proj\\src', '/srv/proj'),
    '/srv/proj/src');
});

test('moving the local panel sideways walks up and back down on the remote side', () => {
  const shell = makeShell({});
  assert.strictEqual(
    shell.synchronizeBrowsingLocal('C:\\work\\proj\\src', 'C:\\work\\other', '/srv/proj/src'),
    '/srv/other');
});

test('moving the remote panel drives the local one, the same way round', () => {
  const shell = makeShell({});
  assert.strictEqual(
    shell.synchronizeBrowsingRemote('/srv/proj', '/srv/proj/src', 'C:\\work\\proj'),
    'C:\\work\\proj\\src\\');
  assert.strictEqual(
    shell.synchronizeBrowsingRemote('/srv/proj/src', '/srv/other', 'C:\\work\\proj\\src'),
    'C:\\work\\other\\');
});

test('a move with no mapping aborts rather than inventing one', () => {
  const shell = makeShell({});
  // Walking up past the remote root: there is nowhere to go.
  assert.throws(() => shell.synchronizeBrowsingLocal('C:\\a\\b', 'C:\\x', '/'), E.AbortError);
  // Different drives share no root at all.
  assert.throws(() => shell.synchronizeBrowsingLocal('C:\\a', 'D:\\a', '/srv'), E.AbortError);
});

test('synchronized browsing turns itself off when it cannot map the move', async () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', path: 'D:\\elsewhere', entries: [] }),
      remote: panel({ side: 'remote', path: '/srv', entries: [] }),
    },
  });
  shell.synchronizeBrowsing = true;
  const r = await shell.applySynchronizeBrowsing({ side: 'local', prevPath: 'C:\\a', newPath: 'D:\\elsewhere' });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.disabled, true);
  assert.strictEqual(shell.synchronizeBrowsing, false);
  assert.strictEqual(shell._test.notes.some((n) => n.name === 'syncDirBrowseError'), true);
});

test('a missing opposite directory is offered for creation; declining turns browsing off', async () => {
  const mk = (answer) => {
    const shell = makeShell({
      answers: [answer],
      panels: {
        local: panel({ side: 'local', path: 'C:\\work\\proj\\src', entries: [] }),
        remote: panel({ side: 'remote', path: '/srv/proj', entries: [] }),
      },
      ops: { directoryExists: () => false },
    });
    shell.synchronizeBrowsing = true;
    return shell;
  };

  const declining = mk('no');
  const r1 = await declining.applySynchronizeBrowsing({
    side: 'local', prevPath: 'C:\\work\\proj', newPath: 'C:\\work\\proj\\src',
  });
  assert.strictEqual(r1.applied, false);
  assert.strictEqual(declining.synchronizeBrowsing, false);
  assert.match(declining._test.asked[0].message, /Do you want to try to create directory '\/srv\/proj\/src'/);

  const accepting = mk('yes');
  const r2 = await accepting.applySynchronizeBrowsing({
    side: 'local', prevPath: 'C:\\work\\proj', newPath: 'C:\\work\\proj\\src',
  });
  assert.strictEqual(r2.applied, true);
  assert.strictEqual(accepting.synchronizeBrowsing, true);
  assert.strictEqual(accepting._test.calls.some((c) => c.name === 'createDirectory'), true);
  assert.strictEqual(accepting._test.calls.some((c) => c.name === 'changePath'), true);
});

test('synchronized browsing does nothing while it is off, or re-entrant, or unchanged', async () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', path: 'C:\\a\\b', entries: [] }),
      remote: panel({ side: 'remote', path: '/x/y', entries: [] }),
    },
  });
  assert.strictEqual((await shell.applySynchronizeBrowsing({ side: 'local', prevPath: 'C:\\a', newPath: 'C:\\a\\b' })).applied, false);

  shell.synchronizeBrowsing = true;
  // The path did not actually change.
  assert.strictEqual((await shell.applySynchronizeBrowsing({ side: 'local', prevPath: 'C:\\a\\b', newPath: 'C:\\a\\b' })).applied, false);

  shell.synchronisingBrowse = true;
  assert.strictEqual((await shell.applySynchronizeBrowsing({ side: 'local', prevPath: 'C:\\a', newPath: 'C:\\a\\b' })).applied, false);
});

test('preset auto-selection is suppressed for the duration of a synchronized move', async () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', path: 'C:\\work\\proj\\src', entries: [] }),
      remote: panel({ side: 'remote', path: '/srv/proj', entries: [] }),
    },
    ops: {
      directoryExists: () => true,
      changePath: () => {
        // Inside the move the flag must be off, or every synchronized step
        // would fight the user's chosen preset.
        assert.strictEqual(shell.allowTransferPresetAutoSelect, false);
        return true;
      },
    },
  });
  shell.synchronizeBrowsing = true;
  await shell.applySynchronizeBrowsing({ side: 'local', prevPath: 'C:\\work\\proj', newPath: 'C:\\work\\proj\\src' });
  assert.strictEqual(shell.allowTransferPresetAutoSelect, true);
  assert.strictEqual(shell.synchronisingBrowse, false);
});

// ===========================================================================
// links and clipboard
// ===========================================================================

test('CanAddEditLink needs symlink support AND symlink resolution turned on', () => {
  const ok = makeShell({});
  assert.strictEqual(ok.canAddEditLink('remote'), true);

  const notResolving = makeShell({
    session: fakeSession({ sessionData: { sessionName: 't', resolveSymlinks: false } }),
  });
  assert.strictEqual(notResolving.canAddEditLink('remote'), false);

  const noSymlinks = makeShell({ session: fakeSession({ caps: { symlink: false } }) });
  assert.strictEqual(noSymlinks.canAddEditLink('remote'), false);

  // The local side can always make one.
  assert.strictEqual(noSymlinks.canAddEditLink('local'), true);
});

test('LinkFocused is true only for a link the panel is actually resolving', () => {
  const entries = [{ name: '..' }, { name: 'link', isSymLink: true, linkTo: '/t' }, { name: 'plain' }];
  const shell = makeShell({ panels: { remote: panel({ side: 'remote', entries, focusedName: 'link' }) } });
  assert.strictEqual(shell.linkFocused(), true);

  const onPlain = makeShell({ panels: { remote: panel({ side: 'remote', entries, focusedName: 'plain' }) } });
  assert.strictEqual(onPlain.linkFocused(), false);
});

test('CanPasteFromClipBoard accepts files, a session URL, or a single-line path', () => {
  const mkPanel = () => ({ remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) });

  const withFiles = makeShell({ panels: mkPanel(), clipboard: { files: () => ['C:\\a'], text: () => '' } });
  assert.strictEqual(withFiles.canPasteFromClipBoard(), true);

  const withUrl = makeShell({
    session: null, panels: {},
    clipboard: { files: () => [], text: () => 'sftp://joe@example.org/' },
  });
  assert.strictEqual(withUrl.canPasteFromClipBoard(), true);

  const withPath = makeShell({ panels: mkPanel(), clipboard: { files: () => [], text: () => '/srv/data' } });
  assert.strictEqual(withPath.canPasteFromClipBoard(), true);

  // Multi-line text is not a path and not a URL.
  const multi = makeShell({ panels: mkPanel(), clipboard: { files: () => [], text: () => 'a\nb' } });
  assert.strictEqual(multi.canPasteFromClipBoard(), false);
});

test('pasting an unsafe session URL asks first and aborts on refusal', async () => {
  const shell = makeShell({
    session: null, panels: {},
    clipboard: { files: () => [], text: () => 'sftp://joe@example.org/' },
    answers: ['cancel'],
  });
  await assert.rejects(() => shell.pasteFromClipBoardPlan({ unsafeSettings: true }), E.AbortError);

  const accepting = makeShell({
    session: null, panels: {},
    clipboard: { files: () => [], text: () => 'sftp://joe@example.org/' },
    answers: ['ok'],
  });
  const plan = await accepting.pasteFromClipBoardPlan({ unsafeSettings: true });
  assert.strictEqual(plan.action, 'newSession');
});

test('pasting our own remote files becomes a server-side copy', async () => {
  const other = fakeSession({ id: 's2' });
  const shell = makeShell({
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) },
    clipboard: { files: () => [], text: () => '', ourFiles: () => ({ files: ['/a/x'], session: other }) },
  });
  const plan = await shell.pasteFromClipBoardPlan({});
  assert.strictEqual(plan.action, 'remoteCopy');
  assert.strictEqual(plan.fromSession, other);
});

// ===========================================================================
// the aggregate predicate the UI asks
// ===========================================================================

test('commandState answers the predicates that genuinely live in this file', () => {
  const shell = makeShell({
    panels: {
      local: panel({ side: 'local', path: 'C:\\w', entries: ENTRIES }),
      remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }),
    },
    queue: { list: () => [], enabled: true },
  });
  assert.strictEqual(shell.commandState('copy', { side: 'remote' }).enabled, true);
  assert.strictEqual(shell.commandState('copy', { side: 'local' }).enabled, false);
  assert.strictEqual(shell.commandState('delete', { side: 'remote' }).enabled, true);
  assert.strictEqual(shell.commandState('queueEnabled', {}).checked, true);
});

test('commandState hides what does not apply and explains what is merely disabled', () => {
  const shell = makeShell({
    session: fakeSession({ protocol: 's3', caps: { move: false, copyRemote: true, checksum: false, exec: false } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }) },
  });
  const move = shell.commandState('remoteMove', { side: 'remote' });
  assert.strictEqual(move.enabled, false);
  assert.match(move.reason, /cannot move files on the server/);

  const lock = shell.commandState('lock', { side: 'remote' });
  assert.strictEqual(lock.visible, false);

  const checksum = shell.commandState('checksum', { side: 'remote' });
  assert.strictEqual(checksum.enabled, false);
  assert.match(checksum.reason, /cannot compute checksums/);

  assert.strictEqual(shell.commandState('somethingElse', {}).visible, false);
});

test('every remote command is refused outright when there is no session', () => {
  const shell = makeShell({ session: null, panels: { remote: panel({ side: 'remote', entries: ENTRIES }) } });
  for (const name of ['copy', 'move', 'remoteCopy', 'checksum', 'console']) {
    assert.strictEqual(shell.commandState(name, { side: 'remote' }).enabled, false, name);
  }
});

// ===========================================================================
// the confirmation channel itself
// ===========================================================================

test('an unwired confirmation channel refuses loudly rather than guessing', async () => {
  const shell = new E.ExplorerShell({
    config: fakeConfig({ confirmDeleting: true, deleteToRecycleBin: false }),
    session: () => fakeSession(),
    panels: () => panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  // Neither a silent yes (which would delete) nor a silent no (which would be
  // a mystery) — it throws so the wiring bug is visible.
  await assert.rejects(() => shell.executeDeleteFileOperation('remote', ['alpha.txt'], false),
    E.ConfirmationUnavailableError);
});

test('an unwired transfer dialog does not read as "the user cancelled"', async () => {
  const shell = makeShell({
    prefs: { confirmTransferring: true },
    panels: {
      local: panel({ side: 'local', path: 'C:\\w', entries: ENTRIES, selected: ['alpha.txt'] }),
      remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }),
    },
    copyDialog: null,
  });
  await assert.rejects(() => shell.copyParamDialog({
    direction: E.DIRECTIONS.toRemote, type: E.TRANSFER_TYPES.copy, files: ['a'], targetDirectory: '/r',
  }), E.ConfirmationUnavailableError);
});

test('an operation with no backing implementation says so instead of pretending', async () => {
  const shell = new E.ExplorerShell({
    config: fakeConfig({ confirmDeleting: false }),
    session: () => fakeSession(),
    panels: () => panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] }),
  });
  await assert.rejects(() => shell.deleteFiles('remote', ['alpha.txt'], false), E.NotSupportedError);
});

// ===========================================================================
// Verification pass — behaviours the original suite asserted in prose but not
// in code, plus the three divergences the C++ comparison turned up.
// ===========================================================================

test('".." can never enter a selection, however the caller names it', () => {
  // CanChangeSelection refuses the parent entry, so "select everything and
  // delete" can never ask the server to remove the directory above.
  const p = panel({ side: 'remote', entries: ENTRIES, selected: ['..', 'alpha.txt'] });
  assert.deepStrictEqual(p.selection.map((e) => e.name), ['alpha.txt']);
  assert.strictEqual(p.selCount, 1);
  assert.deepStrictEqual(p.createFileList({ fullPath: false }).map((f) => f.name), ['alpha.txt']);

  p.selectAll(E.SELECT_MODES.all);
  assert.ok(!p.selectedNames.has('..'));
  p.selectAll(E.SELECT_MODES.invert);
  assert.ok(!p.selectedNames.has('..'));
});

test('a FAILED delete discards the saved selection instead of restoring it', async () => {
  // DeleteFiles (CustomScpExplorer.cpp:4368) restores in the success path and
  // discards in catch(...) — leaving a highlight over names the server may or
  // may not still have is worse than leaving none.
  const remote = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt', 'beta.log'] });
  const shell = makeShell({
    panels: { remote },
    ops: {
      deleteFiles() {
        // The panel reloads mid-operation, exactly as it does when the server
        // reports the directory back after a partial delete.
        remote.selectedNames = new Set();
        throw new Error('permission denied');
      },
    },
  });
  await assert.rejects(() => shell.deleteFiles('remote', ['alpha.txt'], false), /permission denied/);
  assert.strictEqual(remote._savedSelection, null, 'the saved selection must be discarded');
  assert.deepStrictEqual([...remote.selectedNames], [],
    'a failed delete must NOT put the old highlight back');

  // …and the success path really does put it back, so the two halves differ.
  const ok = panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] });
  const good = makeShell({ panels: { remote: ok }, ops: { deleteFiles: () => true } });
  ok.selectedNames = new Set(['alpha.txt']);
  await good.deleteFiles('remote', ['alpha.txt'], false);
  assert.deepStrictEqual([...ok.selectedNames], ['alpha.txt']);
});

test('a LOCAL custom command using session patterns is disabled with no session', () => {
  // TFileCustomCommand::IsSessionCommand, not "has patterns but no files":
  // a command that operates on files AND expands !@ still needs a session.
  const withSession = makeShell({
    panels: {
      local: panel({ side: 'local', entries: ENTRIES, selected: ['alpha.txt'], hasFocus: true }),
      remote: panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] }),
    },
  });
  const cmd = { command: 'scp !^! user@!@:/tmp', params: { local: true } };
  assert.strictEqual(withSession.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all),
    E.COMMAND_STATE.enabled);

  const noSession = makeShell({
    session: null,
    panels: {
      local: panel({ side: 'local', entries: ENTRIES, selected: ['alpha.txt'], hasFocus: true }),
      remote: panel({ side: 'remote', entries: ENTRIES, selected: ['alpha.txt'] }),
    },
  });
  assert.strictEqual(noSession.customCommandState(cmd, false, E.COMMAND_LIST_TYPE.all),
    E.COMMAND_STATE.disabled);
});

test('IsSessionCommand covers every pattern that can only come from a session', () => {
  const o = { local: true, interactive: false };
  for (const p of ['!@', '!S', '!E', '!p', '!U', '!#', '!N', '!/']) {
    assert.ok(E.isSessionCommand(`run ${p}`, o), `${p} is a session pattern`);
  }
  assert.ok(!E.isSessionCommand('run !', o));
  assert.ok(!E.isSessionCommand('run !^!', o));
  assert.ok(!E.isSessionCommand('run nothing', o));
});

test('the synchronize "timestamp" mode needs fcTimestampChanging, not upload preservation', () => {
  // SCP preserves timestamps on upload but cannot set one afterwards
  // (ScpFileSystem.cpp:443), so WinSCP greys the mode out. Offering it would
  // start a synchronization whose only action the protocol cannot perform.
  const scp = makeShell({
    session: fakeSession({ protocol: 'scp', caps: { ...fakeSession().caps, timestamp: true } }),
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(scp.canChangeTimestamp(), false);
  assert.strictEqual(scp.fullSynchronizeOptions().disableTimestamp, true);

  const sftp = makeShell({ panels: { remote: panel({ side: 'remote', entries: ENTRIES }) } });
  assert.strictEqual(sftp.canChangeTimestamp(), true);
  assert.strictEqual(sftp.fullSynchronizeOptions().disableTimestamp, false);

  // An adapter that declares the capability wins over the protocol table.
  const declared = makeShell({
    session: fakeSession({ protocol: 'ftp', caps: { ...fakeSession().caps, timestampChanging: true } }),
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(declared.canChangeTimestamp(), true);
});

test('a session that does not resolve symlinks treats a double-click as "go in"', () => {
  // ResolveDoubleClickAction (WinConfiguration.cpp:3054): with resolution off
  // the panel cannot tell a directory link from a file, so opening it in an
  // editor would try to download a directory.
  const data = { ...fakeSession().sessionData, resolveSymlinks: false };
  const unresolved = makeShell({
    prefs: { panel: { doubleClickAction: 'edit' } },
    session: fakeSession({ sessionData: data }),
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(unresolved.resolveDoubleClick('remote', { isDirectory: false }), 'changeDir');

  // AlwaysRespectDoubleClickAction is the opt-out.
  const respected = makeShell({
    prefs: { panel: { doubleClickAction: 'edit' }, alwaysRespectDoubleClickAction: true },
    session: fakeSession({ sessionData: data }),
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(respected.resolveDoubleClick('remote', { isDirectory: false }), 'edit');

  // File encryption hides the real file the same way.
  const encrypting = makeShell({
    prefs: { panel: { doubleClickAction: 'edit' } },
    session: fakeSession({ encryptingFiles: true }),
    panels: { remote: panel({ side: 'remote', entries: ENTRIES }) },
  });
  assert.strictEqual(encrypting.resolveDoubleClick('remote', { isDirectory: false }), 'edit');

  // …and an explicit "Open" still overrides everything.
  unresolved.forceExecution = true;
  assert.strictEqual(unresolved.resolveDoubleClick('remote', { isDirectory: false }), 'open');
});

test('"Open" on a LOCAL file hands it to the shell rather than the editor', () => {
  // DoDirViewExecFile acts on rdcaOpen only when Remote; on the local side the
  // dir view shell-executes the file itself. Answering "edit" would silently
  // substitute the internal editor for the user's file association.
  const shell = makeShell({
    prefs: { panel: { doubleClickAction: 'open' } },
    panels: { local: panel({ side: 'local', path: 'C:\w', entries: ENTRIES }) },
  });
  assert.strictEqual(shell.resolveDoubleClick('local', { isDirectory: false }), 'open');
});

test('a copy through the temporary folder uploads its CONTENTS, not the folder', async () => {
  // RemoteTransferFiles' slow route (CustomScpExplorer.cpp:4660) enumerates the
  // scratch directory with Recursive = false and uploads those entries. Handing
  // the scratch directory itself to CopyToRemote would create a directory on
  // the server — and with the single-file mask applied, a directory named after
  // the file the user asked to copy.
  const uploads = [];
  const shell = makeShell({
    session: fakeSession({ caps: { exec: false, copyRemote: false, move: true } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES, selected: ['alpha.txt'] }) },
    ops: {
      copyToLocal: () => true,
      listLocalDirectory: () => ['alpha.txt'],
      copyToRemote: (files, target, copyParam) => { uploads.push({ files, target, copyParam }); return true; },
      removeTree: () => true,
    },
  });
  const r = await shell.remoteTransferFiles(
    [{ name: 'alpha.txt', path: '/r/alpha.txt', entry: { isDirectory: false } }], true, false, null);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.viaTemporaryDirectory, true);
  assert.strictEqual(uploads.length, 1);
  assert.deepStrictEqual(uploads[0].files.map((f) => f.name), ['alpha.txt']);
  assert.strictEqual(uploads[0].target, '/r/');
  // The mask is what renames the single file at the destination.
  assert.strictEqual(uploads[0].copyParam.fileMask, 'alpha.txt');
});

test('a temporary-folder copy that downloaded nothing uploads nothing', async () => {
  const uploads = [];
  const shell = makeShell({
    session: fakeSession({ caps: { exec: false, copyRemote: false, move: true } }),
    panels: { remote: panel({ side: 'remote', path: '/r', entries: ENTRIES }) },
    ops: {
      copyToLocal: () => true,
      listLocalDirectory: () => [],
      copyToRemote: (...a) => { uploads.push(a); return true; },
      removeTree: () => true,
    },
  });
  const r = await shell.remoteTransferFiles(
    [{ name: 'alpha.txt', path: '/r/alpha.txt', entry: { isDirectory: false } }], true, false, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(uploads.length, 0, 'an empty scratch folder must not become an upload');
});
