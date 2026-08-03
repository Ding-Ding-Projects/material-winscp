'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../design/main/winapi');

test('Windows paths normalize separators, drives, UNC roots, and long-path prefixes', () => {
  assert.equal(W.normalizePath('c:/Users/test/../notes.txt', { platform: 'win32' }), 'C:\\Users\\notes.txt');
  assert.equal(W.normalizePath('C:', { platform: 'win32' }), 'C:\\');
  assert.equal(W.normalizePath('\\\\?\\C:\\work\\file.txt', { platform: 'win32' }), 'C:\\work\\file.txt');
  assert.equal(W.normalizePath('\\\\?\\UNC\\server\\share\\folder', { platform: 'win32' }), '\\\\server\\share\\folder');
  assert.equal(W.normalizeDrive('d:/', { platform: 'win32' }).root, 'D:\\');
  assert.deepEqual(W.normalizeDrive('\\\\server\\share', { platform: 'win32' }), {
    ok: true,
    kind: 'unc',
    drive: null,
    root: '\\\\server\\share',
    path: '\\\\server\\share',
    isRoot: true,
  });
});

test('POSIX normalization remains POSIX and drive normalization is explicitly unsupported', () => {
  assert.equal(W.normalizePath('/var/tmp/../file', { platform: 'linux' }), '/var/file');
  assert.equal(W.normalizePath('folder\\name', { platform: 'linux' }), 'folder\\name');
  const result = W.normalizeDrive('/mnt/data', { platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.code, W.UNSUPPORTED_PLATFORM);
});

test('path inputs fail safely instead of reaching a native operation', () => {
  assert.throws(() => W.normalizePath('bad\0path', { platform: 'win32' }), (error) => error.code === 'INVALID_INPUT');
  const api = W.createWinApi({ platform: 'linux', shell: { openPath() { throw new Error('must not run'); } } });
  const result = api.checkOpenFile('bad\0path');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_INPUT');
});

test('display metrics use logical viewport dimensions and display scale', () => {
  const metrics = W.displayMetrics({
    bounds: { x: 10, y: 20, width: 1200, height: 800 },
    display: { id: 7, scaleFactor: 1.25, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  });
  assert.equal(metrics.scaleFactor, 1.25);
  assert.deepEqual(metrics.viewport, { x: 10, y: 20, width: 1200, height: 800 });
  assert.deepEqual(metrics.physicalViewport, { width: 1500, height: 1000 });
  assert.equal(metrics.displayId, 7);
  assert.deepEqual(metrics.workArea, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('display metric reads tolerate a closing window and invalid scale', () => {
  const metrics = W.displayMetrics({
    window: { getContentBounds() { throw new Error('closing'); }, getBounds() { return { width: 640, height: 480 }; } },
    scaleFactor: 'not-a-number',
  });
  assert.equal(metrics.scaleFactor, 1);
  assert.deepEqual(metrics.viewport, { x: 0, y: 0, width: 640, height: 480 });
});

test('keyboard notation uses platform conventions without changing shortcut meaning', () => {
  assert.equal(W.formatShortcut(['Control', 'Shift', 'p'], { platform: 'win32' }), 'Ctrl+Shift+P');
  assert.equal(W.formatShortcut('cmd+shift+p', { platform: 'darwin' }), '⌘⇧P');
  assert.equal(W.keyboardNotation('linux').primaryModifier, 'Control');
  assert.equal(W.keyboardNotation('darwin').primaryModifier, 'Meta');
});

test('shell capability checks and open-file results are honest', async () => {
  const opened = [];
  const api = W.createWinApi({
    platform: 'win32',
    shell: {
      async openPath(value) { opened.push(value); return ''; },
      showItemInFolder(value) { opened.push(`reveal:${value}`); },
    },
  });
  assert.equal(api.capabilities().shell.openPath, true);
  assert.deepEqual(await api.openFile('C:/work/report.txt'), { ok: true, operation: 'openPath', platform: 'win32', path: 'C:\\work\\report.txt' });
  assert.deepEqual(api.revealFile('C:/work/report.txt'), { ok: true, operation: 'showItemInFolder', platform: 'win32', path: 'C:\\work\\report.txt' });
  assert.deepEqual(opened, ['C:\\work\\report.txt', 'reveal:C:\\work\\report.txt']);

  const unavailable = W.createWinApi({ platform: 'linux' });
  const result = await unavailable.openFile('/tmp/report.txt');
  assert.equal(result.ok, false);
  assert.equal(result.code, W.UNSUPPORTED_PLATFORM);
});

test('non-Windows never probes or invokes a Windows-only backend', async () => {
  let touched = false;
  const backend = new Proxy({}, {
    get() { touched = true; throw new Error('Windows backend was probed'); },
    ownKeys() { touched = true; throw new Error('Windows backend was enumerated'); },
  });
  const api = W.createWinApi({ platform: 'linux', windows: backend });
  assert.deepEqual(api.capabilities().windowsBackend, { available: false, operations: [] });
  const result = await api.callWindows('getScaleFactor');
  assert.equal(result.code, W.UNSUPPORTED_PLATFORM);
  assert.equal(touched, false);
});

test('Windows backend calls are structured and backend failures are not successes', async () => {
  const api = W.createWinApi({
    platform: 'win32',
    windows: {
      getScaleFactor: () => 1.5,
      fail: () => { throw new Error('native call denied'); },
    },
  });
  assert.deepEqual(await api.callWindows('getScaleFactor'), { ok: true, operation: 'win32:getScaleFactor', platform: 'win32', value: 1.5 });
  const failed = await api.callWindows('fail');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'OPERATION_FAILED');
  assert.equal(await api.callWindows('missing').then((value) => value.code), W.UNSUPPORTED_OPERATION);
});

test('Windows backend calls do not reach inherited or malformed operations', async () => {
  const api = W.createWinApi({ platform: 'win32', windows: { ownOperation: () => 'ok' } });
  assert.equal((await api.callWindows('constructor')).code, W.UNSUPPORTED_OPERATION);
  assert.equal((await api.callWindows('')).code, 'INVALID_INPUT');
  assert.equal((await api.callWindows(null)).code, 'INVALID_INPUT');
  assert.deepEqual(await api.callWindows('ownOperation'), {
    ok: true, operation: 'win32:ownOperation', platform: 'win32', value: 'ok',
  });
});

test('external URL opening is scheme-restricted and unavailable shells fail cleanly', async () => {
  const calls = [];
  const api = W.createWinApi({ platform: 'darwin', shell: { async openExternal(url) { calls.push(url); } } });
  assert.deepEqual(await api.openExternal('https://example.test/docs'), { ok: true, operation: 'openExternal', platform: 'darwin' });
  assert.equal((await api.openExternal('file:///etc/passwd')).code, 'INVALID_INPUT');
  assert.deepEqual(calls, ['https://example.test/docs']);
  assert.equal((await W.createWinApi({ platform: 'linux' }).openExternal('https://example.test')).code, W.UNSUPPORTED_PLATFORM);
});
