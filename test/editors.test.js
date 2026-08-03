// editors.test.js — the CustomScpExplorer file-editing round trip.
//
// These tests exercise the real EditorManager seams that correspond to
// ExecutedFileChanged and EditedFileUploaded. The adapter is an in-memory
// remote, but the temporary copy, watcher callback, conflict guard, upload
// event and cleanup are all the production implementation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const P = require('../design/main/paths');
const { EditorManager } = require('../design/main/editors');

function fixture(initial = 'before') {
  const files = new Map([['/notes.txt', { data: Buffer.from(initial), mtime: 1000 }]]);
  const actions = [];
  const logs = [];
  const session = {
    id: 's-edit',
    name: 'Editor test',
    adapter: {
      connected: true,
      normalize: (p) => String(p),
      basename: (p) => path.posix.basename(String(p)),
      dirname: (p) => path.posix.dirname(String(p)),
      async stat(p) {
        const file = files.get(String(p));
        if (!file) throw new Error('missing');
        return { size: file.data.length, mtime: file.mtime };
      },
      async readFile(p) {
        const file = files.get(String(p));
        if (!file) throw new Error('missing');
        return Buffer.from(file.data);
      },
      async writeFile(p, data) {
        const current = files.get(String(p));
        files.set(String(p), { data: Buffer.from(data), mtime: (current?.mtime || 1000) + 1000 });
      },
    },
    invalidate() {},
    log: {
      actions: { record: (action) => actions.push(action) },
      add: (...args) => logs.push(args[1] || args[0]),
    },
  };
  const emitted = [];
  const manager = new EditorManager({
    config: {
      prefs: {
        editor: { singleEditor: false, maxEditors: 20, keepTemporaryFiles: false, encoding: 'auto' },
        temporaryDirectoryAppendSession: false,
        temporaryDirectoryAppendPath: false,
        temporaryDirectoryDeterministic: false,
        temporaryDirectoryCleanup: true,
      },
    },
    sessions: { require: (id) => { assert.equal(id, session.id); return session; }, get: (id) => id === session.id ? session : null },
    emit: (_channel, event) => emitted.push(event),
  });
  return { files, actions, logs, session, manager, emitted };
}

test('ExecuteFile opens the remote copy and EditedFileUploaded saves it back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-'));
  P.setRoot(root);
  const f = fixture();
  try {
    const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal' });
    assert.equal((await f.manager.read(opened.id)).text, 'before');

    const saved = await f.manager.save(opened.id, 'after', {});
    assert.deepEqual(saved, { uploaded: true, bytes: 5, uploads: 1 });
    assert.equal((await f.session.adapter.readFile('/notes.txt')).toString(), 'after');
    assert.ok(f.emitted.some((e) => e.type === 'uploaded'
      && e.id === opened.id && e.sessionId === f.session.id && e.remotePath === '/notes.txt'));
    assert.ok(f.actions.some((a) => a === 'upload'));
    assert.ok(f.logs.some((line) => /Uploaded the edited/.test(line)));

    await f.manager.close(opened.id, {});
    await assert.rejects(() => fs.stat(opened.localPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('forced Unicode encodings preserve content when the file has no BOM', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-encoding-'));
  P.setRoot(root);
  try {
    for (const [encoding, bytes, expected] of [
      ['utf8bom', Buffer.from('alpha'), 'alpha'],
      ['utf16le', Buffer.from('alpha', 'utf16le'), 'alpha'],
      ['utf16be', (() => { const b = Buffer.from('alpha', 'utf16le'); b.swap16(); return b; })(), 'alpha'],
    ]) {
      const f = fixture();
      f.files.set('/notes.txt', { data: bytes, mtime: 1000 });
      const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal', encoding });
      assert.equal((await f.manager.read(opened.id)).text, expected, encoding);
      await f.manager.close(opened.id, {});
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the preload bridge exposes the direct file-changed IPC seam', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'design/preload/preload.js'), 'utf8');
  const ipcSource = await fs.readFile(path.join(__dirname, '..', 'design/main/ipc.js'), 'utf8');
  assert.match(source, /fileChanged: \(id\) => call\('editor:fileChanged', id\)/);
  assert.match(ipcSource, /this\.handle\('editor:fileChanged', \(id\) => this\.editors\.executedFileChanged/);
});

test('the renderer upload IPC route reaches EditedFileUploaded', async () => {
  const ipcSource = await fs.readFile(path.join(__dirname, '..', 'design/main/ipc.js'), 'utf8');
  assert.match(ipcSource, /this\.handle\('editor:upload',[\s\S]*?this\.editors\.editedFileUploaded/);
});

test('ExecutedFileChanged uses the same conflict guard as an internal save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-'));
  P.setRoot(root);
  const f = fixture();
  try {
    const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal' });
    await fs.writeFile(opened.localPath, 'my edit');
    f.files.set('/notes.txt', { data: Buffer.from('someone else'), mtime: 3000 });

    const result = await f.manager.executedFileChanged(opened.id);
    assert.equal(result.changed, true);
    assert.equal(result.conflict, true);
    assert.equal(result.uploaded, false);
    assert.equal((await f.session.adapter.readFile('/notes.txt')).toString(), 'someone else');
    assert.ok(f.emitted.some((e) => e.type === 'remote-changed' && e.id === opened.id));
    assert.equal(f.manager.list()[0].dirty, true, 'the temporary edit remains recoverable');

    await f.manager.close(opened.id, {});
    assert.ok(f.emitted.some((e) => e.type === 'orphan' && e.id === opened.id));
    await fs.rm(opened.localPath, { force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overlapping file-changed callbacks serialize uploads and keep the final edit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-watch-'));
  P.setRoot(root);
  const f = fixture();
  try {
    const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal' });
    const originalWrite = f.session.adapter.writeFile;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let writes = 0;
    f.session.adapter.writeFile = async (...args) => {
      writes++;
      if (writes === 1) await gate;
      return originalWrite(...args);
    };
    await fs.writeFile(opened.localPath, 'first');
    const first = f.manager.executedFileChanged(opened.id);
    await new Promise((resolve) => setImmediate(resolve));
    await fs.writeFile(opened.localPath, 'second');
    const second = f.manager.executedFileChanged(opened.id);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].uploaded, true);
    assert.equal(results[1].uploaded, true);
    assert.equal(writes, 2);
    assert.equal((await f.session.adapter.readFile('/notes.txt')).toString(), 'second');
    await f.manager.close(opened.id, {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed external launch rolls back its watcher, registry record, and temporary copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-launch-'));
  P.setRoot(root);
  const f = fixture();
  const originalSpawn = cp.spawn;
  try {
    cp.spawn = () => {
      const child = new (require('node:events').EventEmitter)();
      child.kill = () => {};
      process.nextTick(() => child.emit('error', Object.assign(new Error('editor missing'), { code: 'ENOENT' })));
      return child;
    };

    await assert.rejects(
      () => f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'external', external: 'missing-editor.exe' }),
      /could not be started: editor missing/,
    );
    assert.deepEqual(f.manager.list(), []);
    const files = await f.manager.findOrphans();
    assert.deepEqual(files, []);
  } finally {
    cp.spawn = originalSpawn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('discarding an unsaved remote edit records an audit revision before close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-history-'));
  P.setRoot(root);
  const f = fixture();
  const revisions = [];
  f.manager.history = { snapshot: async (label, state) => { revisions.push({ label, state }); } };
  f.manager.historyState = () => ({ prefs: { versionHistory: { enabled: true } }, sites: [] });
  try {
    const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal' });
    f.manager.open.get(opened.id).dirty = true;
    await f.manager.close(opened.id, {});
    assert.equal(revisions.length, 1);
    assert.match(revisions[0].label, /Discarded unsaved document/);
    assert.deepEqual(revisions[0].state.editorDiscard, {
      id: opened.id, fileName: 'notes.txt', sessionId: f.session.id,
      remotePath: '/notes.txt', localPath: opened.localPath,
    });
    assert.ok(f.emitted.some((e) => e.type === 'orphan' && e.id === opened.id));
    assert.equal(f.emitted.find((e) => e.type === 'orphan').discardAudit.status, 'recorded');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('discarding an unsaved edit reports when the audit could not be recorded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-editor-history-failure-'));
  P.setRoot(root);
  const f = fixture();
  f.manager.history = { snapshot: async () => ({ ok: false, error: { code: 'HISTORY_ERROR' } }) };
  try {
    const opened = await f.manager.openRemote({ sessionId: f.session.id, remotePath: '/notes.txt', mode: 'internal' });
    f.manager.open.get(opened.id).dirty = true;
    await f.manager.close(opened.id, {});
    const orphan = f.emitted.find((e) => e.type === 'orphan');
    assert.deepEqual(orphan.discardAudit, { status: 'not-recorded', reason: 'history-write-failed', code: 'HISTORY_ERROR' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the renderer bridge consumes command-layer editor:opened records and panels repaint uploads', async () => {
  const editorSource = await fs.readFile(path.join(__dirname, '..', 'design/renderer/ui/dialogs/editor.js'), 'utf8');
  const panelSource = await fs.readFile(path.join(__dirname, '..', 'design/renderer/ui/panels.js'), 'utf8');
  assert.match(editorSource, /bus\.on\('editor:opened'/);
  assert.match(editorSource, /openExistingEditor\(record\)/);
  assert.match(panelSource, /backend\.on\('event:editor'/);
  assert.match(panelSource, /refresh\(true\)/);
});
