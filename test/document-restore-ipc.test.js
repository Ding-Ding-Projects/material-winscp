'use strict';

// Exercise the shipping registered IPC envelopes, Config, EditorManager and
// on-disk Git history. Only Electron's transport/window shell is substituted;
// these are headless integration tests, not Windows GUI acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const handlers = new Map();
const electronId = require.resolve('electron');
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: {
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', on() {} },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler() {} },
  BrowserWindow: { getAllWindows: () => [] }, shell: {}, clipboard: {}, dialog: {},
} };
const P = require('../design/main/paths');
const { Config } = require('../design/main/config');
const { Ipc } = require('../design/main/ipc');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-restore-ipc-'));
  P.setRoot(root);
  const config = new Config();
  config.on('error', () => {});
  const ipc = new Ipc({ config, getWindow: () => null, version: '0.0.0-test' });
  ipc.history.on('error', () => {});
  ipc.registerHistory();
  ipc.registerEditor();
  const invoke = (name, ...args) => handlers.get(name)({}, ...args);
  t.after(async () => { clearTimeout(config._saveTimer); await ipc.history.settled(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, ipc, config, invoke };
}

async function discard(f, bytes = 'unsaved draft') {
  const original = path.join(f.root, 'original.txt');
  await fs.writeFile(original, 'saved original');
  const opened = await f.ipc.editors.openLocal({ localPath: original });
  const closed = await f.invoke('editor:close', opened.id, { discard: true, text: bytes });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const rows = await f.invoke('history:list');
  return { original, revision: rows.value[0].oid };
}

test('local discard preserves the original and history restore recovers exact bytes through IPC', async (t) => {
  const f = await fixture(t);
  const text = 'draft\r\n廣東話 end';
  const { original, revision } = await discard(f, text);
  assert.equal(await fs.readFile(original, 'utf8'), 'saved original');
  const state = (await f.invoke('history:read', revision)).value;
  await fs.rm(state.editorDiscard.localPath);
  const result = await f.invoke('history:restore', revision);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.value.recoveredDocument);
  assert.deepEqual(await fs.readFile(result.value.recoveredDocument.localPath), Buffer.from(text));
  assert.equal(result.value.recoveredDocument.localOnly, true);
  assert.equal(result.value.recoveredDocument.remotePath, '');
  assert.equal(result.value.recoveredDocument.sessionId, '');
  const rows = (await f.invoke('history:list')).value;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'restored');
  assert.equal(rows[1].oid, revision);
  assert.equal(result.value.newRevision, rows[0].oid);
});

test('repeated and concurrent restores create separate copies without rewinding settings or disclosing credentials', async (t) => {
  const f = await fixture(t);
  const { revision, original } = await discard(f);
  f.config.data.prefs.language = 'zh-HK';
  f.config.data.sites = [{ id: 'current', password: { encrypted: 'ciphertext-test-fixture' } }];
  const current = f.config.exportState();
  const [first, second] = await Promise.all([
    f.invoke('history:restore', revision), f.invoke('history:restore', revision),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.value.recoveredDocument.localPath, second.value.recoveredDocument.localPath);
  await fs.writeFile(first.value.recoveredDocument.localPath, 'edit recovered copy');
  assert.equal(await fs.readFile(second.value.recoveredDocument.localPath, 'utf8'), 'unsaved draft');
  assert.equal(await fs.readFile(original, 'utf8'), 'saved original');
  assert.deepEqual(f.config.exportState(), current);
  assert.doesNotMatch(JSON.stringify([first, second]), /ciphertext-test-fixture|password|prefs/);
  assert.equal((await f.invoke('history:list')).value.length, 3);
  const restoredState = (await f.invoke('history:read', first.value.newRevision)).value;
  assert.deepEqual(restoredState.sites, current.sites);
  const again = await f.invoke('history:restore', first.value.newRevision);
  assert.equal(again.ok, true);
  assert.equal(await fs.readFile(again.value.recoveredDocument.localPath, 'utf8'), 'unsaved draft');
});

test('missing, malformed and metadata-only revisions never create a copy or claim success', async (t) => {
  const f = await fixture(t);
  for (const bytesBase64 of [undefined, null, '%%%', 'YR==', 'a===', 123]) {
    const snap = await f.ipc.history.snapshot('Discarded legacy document', { editorDiscard: { fileName: 'x', bytesBase64 } });
    const before = (await f.invoke('history:list')).value.length;
    const result = await f.invoke('history:restore', snap.value.oid);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_RECOVERY_BYTES');
    assert.equal((await f.invoke('history:list')).value.length, before);
    assert.equal(f.ipc.editors.list().length, 0);
  }
  assert.equal((await f.invoke('history:restore', 'does-not-exist')).ok, false);
  assert.deepEqual(await f.ipc.editors.findOrphans(), []);
});

test('hostile historical names and paths cannot overwrite files and binary/empty bytes survive', async (t) => {
  const f = await fixture(t);
  const victim = path.join(f.root, 'victim.txt');
  await fs.writeFile(victim, 'untouched');
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0, 0, 0x80, 0xff])]) {
    const snap = await f.ipc.history.snapshot('Discarded document', { editorDiscard: {
      fileName: '../../CON:\\..\\victim.txt\u0000', localPath: victim,
      remotePath: '/secret', sessionId: 'do-not-connect', encoding: 'utf16le',
      bytesBase64: bytes.toString('base64'),
    } });
    const result = await f.invoke('history:restore', snap.value.oid);
    assert.equal(result.ok, true, JSON.stringify(result));
    const rec = result.value.recoveredDocument;
    assert.ok(rec.localPath.startsWith(path.join(f.root, 'temp') + path.sep));
    assert.match(path.basename(rec.localPath), /^recovered-/);
    assert.deepEqual(await fs.readFile(rec.localPath), bytes);
    assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
    assert.equal(f.ipc.sessions.sessions.size, 0);
  }
});

test('write/open failures leave history untouched; audit failure reports a retained usable copy', async (t) => {
  const f = await fixture(t);
  const { revision } = await discard(f);
  const originalCopy = f.ipc.editors.recoveryCopy;
  f.ipc.editors.recoveryCopy = async () => { throw new Error('write failed'); };
  assert.equal((await f.invoke('history:restore', revision)).ok, false);
  assert.equal((await f.invoke('history:list')).value.length, 1);
  f.ipc.editors.recoveryCopy = originalCopy;
  const originalOpen = f.ipc.editors.openLocal;
  f.ipc.editors.openLocal = async () => { throw new Error('open failed'); };
  const before = await fs.readdir(P.temp());
  assert.equal((await f.invoke('history:restore', revision)).ok, false);
  assert.deepEqual(await fs.readdir(P.temp()), before);
  assert.equal((await f.invoke('history:list')).value.length, 1);
  f.ipc.editors.openLocal = originalOpen;
  f.ipc.history.snapshot = async () => ({ ok: false, error: { code: 'EIO' } });
  const result = await f.invoke('history:restore', revision);
  assert.equal(result.ok, true);
  assert.equal(result.value.auditRecorded, false);
  assert.equal(result.value.newRevision, null);
  assert.equal(await fs.readFile(result.value.recoveredDocument.localPath, 'utf8'), 'unsaved draft');
});

test('invalid restore label is rejected before filesystem/history mutation', async (t) => {
  const f = await fixture(t);
  const { revision } = await discard(f);
  const before = await fs.readdir(P.temp());
  assert.equal((await f.invoke('history:restore', revision, {})).ok, false);
  assert.deepEqual(await fs.readdir(P.temp()), before);
  assert.equal((await f.invoke('history:list')).value.length, 1);
});

test('oversized recovery rejects before decoding/writing, leaving history bytes intact', async (t) => {
  const f = await fixture(t);
  const { LIMITS } = require('../design/main/ipc');
  f.ipc.history.read = async () => ({ ok: true, value: { editorDiscard: {
    bytesBase64: 'AAAA'.repeat(Math.ceil((LIMITS.text * 4 + 3) / 3) + 1),
  } } });
  const result = await f.invoke('history:restore', 'HEAD');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RECOVERY_TOO_LARGE');
  assert.deepEqual(await f.ipc.editors.findOrphans(), []);
  assert.equal((await f.invoke('history:list')).value.length, 0);
});

// Run the production modal callbacks without claiming a rendered GUI test.
async function restoreModal(invoke) {
  const source = await fs.readFile(path.join(__dirname, '../design/renderer/ui/historypanel.js'), 'utf8');
  const start = source.indexOf('  let restorePending = false;');
  const end = source.indexOf('\n  function promptLabel', start);
  assert.ok(start > 0 && end > start);
  let modal;
  const notices = [];
  const events = [];
  const make = new Function('openModal', 'h', 's', 't', 'paragraphs', 'fmtTime', 'callMain', 'notify', 'announce', 'refresh', 'bus',
    source.slice(start, end) + '\nreturn confirmRestore;');
  const confirm = make((m) => { modal = m; }, () => ({}), (k, ...a) => [k, ...a].join(' '), (k) => k,
    () => [], () => '', (_name, ...args) => invoke(...args),
    { success: (...a) => notices.push(['success', ...a]), error: (...a) => notices.push(['error', ...a]) },
    () => {}, async () => {}, { emit: (...a) => events.push(a) });
  return { confirm, get modal() { return modal; }, notices, events };
}

test('history confirmation cancellation is inert and repeated activation cannot duplicate an in-flight restore', async (t) => {
  const f = await fixture(t);
  const { revision } = await discard(f);
  let calls = 0;
  const ui = await restoreModal(async (...args) => { calls++; return (await f.invoke('history:restore', ...args)).value; });
  const row = { oid: revision, short: revision.slice(0, 8), label: 'Discarded document', time: Date.now() };
  ui.confirm(row);
  ui.modal.actions[0].onSelect?.(); // Cancel only dismisses; no mutation callback.
  assert.equal(calls, 0);
  assert.equal((await f.invoke('history:list')).value.length, 1);
  ui.confirm(row);
  const action = ui.modal.actions[1].onSelect;
  await Promise.all([action(), action()]);
  assert.equal(calls, 1);
  assert.equal((await f.invoke('history:list')).value.length, 2);
  assert.equal(ui.events[0][0], 'editor:opened');
  assert.equal(ui.notices[0][0], 'success');
  assert.match(ui.notices[0][2], /hpDocumentRestored/);
});

test('history UI reports partial audit failure without a false full-success notice', async () => {
  const ui = await restoreModal(async () => ({ recoveredDocument: { id: 'recovered', localPath: 'recovered.txt' }, auditRecorded: false }));
  ui.confirm({ oid: 'revision', short: 'revision', label: 'Discarded document' });
  await ui.modal.actions[1].onSelect();
  assert.equal(ui.notices[0][0], 'error');
  assert.match(ui.notices[0][2], /hpDocumentAuditFailed/);
  assert.equal(ui.events[0][0], 'editor:opened');
});

test('editor Cancel and Escape preserve unsaved buffer and invoke no close IPC', async () => {
  const source = await fs.readFile(path.join(__dirname, '../design/renderer/ui/dialogs/editor.js'), 'utf8');
  const start = source.indexOf('  function confirmClose() {');
  const end = source.indexOf('\n  /* ---------------- events from main', start);
  let modal, calls = 0;
  const state = { id: 'editor', text: 'unsaved', saved: 'saved' };
  const confirm = new Function('isDirty', 'state', 'openModal', 't', 'h', 'record', 'callMain', 'notify', 'save',
    source.slice(start, end) + '\nreturn confirmClose;')(() => true, state, (m) => { modal = m; }, (x) => x, () => ({}),
    { fileName: 'original' }, () => { calls++; }, {}, () => {});
  for (const reason of ['cancel', 'escape', 'scrim']) {
    const decision = confirm();
    if (reason === 'cancel') modal.actions[0].onSelect();
    else modal.onClose(reason);
    assert.equal(await decision, false);
    assert.equal(calls, 0);
    assert.equal(state.text, 'unsaved');
    assert.equal(state.saved, 'saved');
  }
});

test('a stored discard revision restores document bytes even when no recovery path exists', async (t) => {
  const f = await fixture(t);
  const snap = await f.ipc.history.snapshot('Discarded unsaved document', {
    ...f.config.exportState(), editorDiscard: { fileName: 'notes.txt', encoding: 'utf8',
      localPath: path.join(f.root, 'already-removed.txt'), bytesBase64: Buffer.from('recover me').toString('base64') },
  });
  const result = await f.invoke('history:restore', snap.value.oid);
  assert.equal(result.ok, true);
  assert.ok(result.value.recoveredDocument, 'shipping history:restore must materialize a document, not only import configuration');
  assert.equal(await fs.readFile(result.value.recoveredDocument.localPath, 'utf8'), 'recover me');
});

test('failed local discard recovery never overwrites original or advertises stale bytes', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.root, 'original.txt');
  await fs.writeFile(original, 'saved original');
  const record = await f.ipc.editors.openLocal({ localPath: original });
  const events = [];
  f.ipc.editors._send = (_channel, e) => events.push(e);
  f.ipc.editors.recoveryCopy = async () => { throw new Error('disk full'); };
  const result = await f.invoke('editor:close', record.id, { discard: true, text: 'unsaved' });
  assert.equal(result.ok, true);
  assert.equal(result.value, true);
  assert.equal(await fs.readFile(original, 'utf8'), 'saved original');
  const row = (await f.invoke('history:list')).value[0];
  const state = (await f.invoke('history:read', row.oid)).value;
  assert.equal(state.editorDiscard.bytesBase64, null);
  assert.equal(state.editorDiscard.sourceLocalPath, original);
  assert.equal(events.find((e) => e.type === 'orphan').recoveryAvailable, false);
  assert.equal((await f.invoke('history:restore', row.oid)).ok, false);
  assert.equal(f.ipc.editors.list().length, 0);
});

test('long filename and repeated revision labels remain restorable through the history UI and real IPC', async (t) => {
  const f = await fixture(t);
  const name = 'a'.repeat(220) + '.txt';
  const snap = await f.ipc.history.snapshot(`Discarded unsaved document "${name}"`, {
    ...f.config.exportState(), editorDiscard: { fileName: name, encoding: 'utf8', bytesBase64: 'ZHJhZnQ=' },
  });
  const ui = await restoreModal(async (...args) => {
    assert.ok(args[1].length <= 256);
    const result = await f.invoke('history:restore', ...args);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  });
  for (let i = 0; i < 3; i++) {
    const row = (await f.invoke('history:list')).value[0];
    ui.confirm(row);
    await ui.modal.actions[1].onSelect();
    assert.equal(ui.notices.at(-1)[0], 'success');
    const record = ui.events.at(-1)[1];
    assert.equal(await fs.readFile(record.localPath, 'utf8'), 'draft');
  }
  assert.equal((await f.invoke('history:list')).value.length, 4);
  assert.ok(snap.ok);
});
