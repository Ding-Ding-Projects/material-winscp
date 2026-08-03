'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScpAdapter } = require('../design/main/protocols/scp');
const {
  entriesForDragPaths,
  normalizePanelDragPayload,
  panelDropMoveRequested,
  panelDropEffectSpec,
  negotiatePanelDropEffect,
  normalizeOsDropPaths,
} = require('../design/renderer/ui/panels.js');

function adapter(commands) {
  const result = new ScpAdapter({});
  result._mustRun = async (command, label) => {
    commands.push({ command, label });
  };
  return result;
}

test('SCP Commander remote-copy honors an explicit overwrite target', async () => {
  const commands = [];
  const scp = adapter(commands);

  assert.equal(await scp.copyRemote('/source/file', '/target/file', { overwrite: true }), '/target/file');
  assert.equal(commands.length, 1);
  assert.match(commands[0].command, /^rm -rf -- '\/target\/file' && cp -a -- '\/source\/file' '\/target\/file'$/);
});

test('SCP Commander remote-copy preserves no-overwrite semantics by default', async () => {
  const commands = [];
  const scp = adapter(commands);

  await scp.copyRemote('/source/file', '/target/file');
  assert.equal(commands[0].command, "cp -a -- '/source/file' '/target/file'");
});

test('Commander drag/drop uses the paths captured at drag start', () => {
  const entries = [{ name: 'first.txt', type: 'file' }, { name: 'second.txt', type: 'file' }];
  const selectedAtDrop = entriesForDragPaths(
    entries,
    ['C:\\Work\\first.txt'],
    (entry) => `C:/Work/${entry.name}`,
    true,
  );

  assert.deepEqual(selectedAtDrop.map((entry) => entry.name), ['first.txt']);
});

test('Commander drag/drop refuses malformed private payloads instead of swallowing them', () => {
  assert.deepEqual(normalizePanelDragPayload({ side: 'remote', paths: [] }), {
    ok: false, reason: 'invalidPaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'other', paths: ['/a'] }), {
    ok: false, reason: 'invalidSourceSide',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a', ''], panelId: 3 }), {
    ok: false, reason: 'invalidPaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a'], preferredEffect: 'delete' }), {
    ok: false, reason: 'invalidPreferredEffect',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a', '/a'] }), {
    ok: false, reason: 'duplicatePaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['C:\\A', 'c:\\a'] }), {
    ok: false, reason: 'duplicatePaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a', 3] }), {
    ok: false, reason: 'invalidPaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a\0b'] }), {
    ok: false, reason: 'invalidPaths',
  });
  assert.deepEqual(normalizePanelDragPayload({ side: 'local', paths: ['/a'], panelId: 3 }), {
    ok: false, reason: 'invalidPanelId',
  });
});

test('Commander OS drops refuse partial or duplicate file payloads', () => {
  assert.deepEqual(normalizeOsDropPaths([{ path: 'C:\\a.txt' }, { name: 'virtual item' }]), {
    ok: false, reason: 'invalidFiles',
  });
  assert.deepEqual(normalizeOsDropPaths([{ path: 'C:\\a.txt' }, { path: 'c:/A.TXT' }]), {
    ok: false, reason: 'duplicateFiles',
  });
  assert.deepEqual(normalizeOsDropPaths([{ path: 'C:\\a.txt' }, { path: 'C:\\b.txt' }]), {
    ok: true, paths: ['C:\\a.txt', 'C:\\b.txt'],
  });
});

test('Commander drag/drop ignores a source path resolver that throws', () => {
  assert.deepEqual(entriesForDragPaths(
    [{ name: 'file.txt' }], ['/file.txt'], () => { throw new Error('stale row'); },
  ), []);
  assert.deepEqual(entriesForDragPaths([{ name: 'file.txt' }], ['/file.txt'], null), []);
});

test('Commander drag/drop move preference honours default move and Ctrl copy', () => {
  assert.equal(panelDropMoveRequested({ allowMove: true, startAsMove: true }), true);
  assert.equal(panelDropMoveRequested({ allowMove: true, startAsMove: true, ctrlKey: true }), false);
  assert.equal(panelDropMoveRequested({ allowMove: true, shiftKey: true }), true);
  assert.equal(panelDropMoveRequested({ allowMove: false, startAsMove: true }), false);
});

test('Commander panel drops describe the same target/effect policy as main', () => {
  assert.deepEqual(panelDropEffectSpec({
    sourceSide: 'remote', targetSide: 'local', sessionId: 'session-1',
    dropTarget: 'C:\\Downloads', effect: 2, ctrlKey: false, allowMove: true,
  }), {
    effect: 2, fromRemotePanel: true, ontoDirView: true, fromDirView: true,
    ontoRemotePanel: false, dropTarget: 'C:\\Downloads', ctrl: false,
    allowMove: true, sessionId: 'session-1',
  });
});

test('Commander panel drops fail closed when main rejects or cannot negotiate', async () => {
  const calls = [];
  const bridge = {
    present: true,
    explorer: async (name, spec) => { calls.push([name, spec]); return 2; },
  };
  assert.equal(await negotiatePanelDropEffect(bridge, {
    effect: 1, sessionId: 'session-1', ontoRemotePanel: true,
  }, 1), 2);
  assert.deepEqual(calls.map(([name]) => name), ['setPanels', 'dropEffect']);

  assert.equal(await negotiatePanelDropEffect({
    present: true, explorer: async () => 0,
  }, { effect: 1 }, 1), 0);
  assert.equal(await negotiatePanelDropEffect({
    present: true, explorer: async () => { throw new Error('bridge closed'); },
  }, { effect: 1 }, 2), 0);
  assert.equal(await negotiatePanelDropEffect({ present: false }, { effect: 2 }, 2), 0);
  assert.equal(await negotiatePanelDropEffect(null, { effect: 1 }, 1), 0);
});
