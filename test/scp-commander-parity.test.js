'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScpAdapter } = require('../design/main/protocols/scp');
const {
  entriesForDragPaths,
  normalizePanelDragPayload,
  panelDropMoveRequested,
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
