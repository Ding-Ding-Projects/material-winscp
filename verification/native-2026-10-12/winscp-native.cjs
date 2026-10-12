'use strict';
// Run with workspace Node 22. No installation, package operations, or application network transfers.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const EVIDENCE = __dirname;
const REPO = path.resolve(EVIDENCE, '../winscp-verify');
const ASAR = path.join(REPO, 'out/WinSCP Material-win32-x64/resources/app.asar');
const APP = syncFs.existsSync(ASAR) ? ASAR : REPO;
const EXPECTED = '0fe6fc793681410f48fcb08cfc72b6e9e9e3a383';
const ELECTRON = require(path.join(REPO, 'node_modules/electron'));
const report = { expectedCommit: EXPECTED, app: APP, binding: APP === ASAR ? 'packaged-asar' : 'source-fallback',
  started: new Date().toISOString(), cases: [], captures: [], limitations: [
    'Native hidden offscreen Electron runtime with real packaged modules, preload and renderer; task-controlled lifecycle host.',
    'Installer and normal application lifecycle acceptance are not exercised.',
    'Failure injection replaces named backend methods only in this disposable test process.'
  ] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
class NativeApp {
  constructor(root) { this.root = root; this.id = 0; this.pending = new Map(); this.stderr = ''; }
  async start() {
    await fs.mkdir(this.root, { recursive: true });
    let resolveHello;
    const hello = new Promise(r => { resolveHello = r; });
    this.server = net.createServer(socket => {
      this.socket = socket;
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8'); let pos;
        while ((pos = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.id === 0) { resolveHello(m.value); continue; }
          const p = this.pending.get(m.id); if (!p) continue;
          this.pending.delete(m.id); clearTimeout(p.timer);
          m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
        }
      });
    });
    await new Promise(r => this.server.listen(0, '127.0.0.1', r));
    const env = { ...process.env, WINSCP_VERIFY_ROOT: this.root, WINSCP_VERIFY_APP: APP,
      WINSCP_VERIFY_RPC: String(this.server.address().port), ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      TEMP: this.root, TMP: this.root };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(ELECTRON, [path.join(EVIDENCE, 'winscp-native-host.cjs')], {
      cwd: this.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + b.toString()).slice(-12000); });
    this.child.stdout.on('data', () => {});
    this.child.once('exit', (code, signal) => { this.exit = { code, signal }; });
    const deadline = Date.now() + 60000;
    let ready;
    hello.then(v => { ready = v; });
    while (!ready) {
      if (this.exit) throw new Error('Electron exited: ' + JSON.stringify(this.exit) + '\n' + this.stderr);
      if (Date.now() > deadline) throw new Error('Native boot timeout\n' + this.stderr);
      await sleep(80);
    }
    this.runtime = ready;
    await this.wait('document.querySelectorAll("*").length > 100 && !!window.api', 'renderer startup');
    await this.eval(`(async()=>{ window.__verifyEditor = await import('./ui/dialogs/editor.js');
      window.__verifyHistory = await import('./ui/historypanel.js'); return true; })()`);
    await this.eval(`(async()=>{const {notify}=await import('./ui/notifications.js');notify.info('Native verification fixture','Disposable local profile initialized.');return true;})()`);
    await sleep(500); // Let startup's persisted tab/UI state settle before test baselines.
    return this;
  }
  send(cmd, args = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC timeout: ' + cmd)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }
  eval(src) { return this.send('eval', { src }); }
  async wait(src, name, timeout = 12000) {
    const end = Date.now() + timeout;
    while (!(await this.eval(src))) { if (Date.now() > end) throw new Error('UI wait failed: ' + name); await sleep(70); }
  }
  inspect() { return this.send('inspect'); }
  async api(name, ...args) { const r = await this.send('api', { name, args }); assert.equal(r.ok, true, JSON.stringify(r)); return r.value; }
  mode(value) { return this.send('mode', { value }); }
  async open(file, text) {
    const id = await this.eval(`(async()=>{const h=await window.__verifyEditor.openEditor({localPath:${JSON.stringify(file)}}); return h && h.id;})()`);
    assert.ok(id, 'native renderer opened an editor');
    await this.wait(`document.querySelectorAll('.mw textarea.ed-text').length>0`, 'editor textarea');
    if (text !== undefined) await this.eval(`(()=>{const a=[...document.querySelectorAll('.mw textarea.ed-text')].at(-1);a.value=${JSON.stringify(text)};a.dispatchEvent(new Event('input',{bubbles:true}));return a.value;})()`);
    return id;
  }
  async closePrompt(repeat = false) {
    await this.eval(`(()=>{const h=window.__verifyEditor.listEditorWindows().at(-1); const b=h.element.querySelector('.mw-head > button'); b.click(); ${repeat ? 'b.click();' : ''} return true;})()`);
    await this.wait(`!!document.querySelector('.modal .modal-actions .is-danger')`, 'unsaved changes prompt');
  }
  async action(label, repeat = false) {
    return this.eval(`(()=>{const d=[...document.querySelectorAll('.modal')].at(-1);const b=[...d.querySelectorAll('.modal-actions button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing action '+${JSON.stringify(label)});b.click();${repeat ? 'b.click();' : ''} return true;})()`);
  }
  async escape() {
    await this.eval(`(()=>{const d=[...document.querySelectorAll('.modal')].at(-1); d.focus(); d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;})()`);
  }
  async history(oid) {
    if (!(await this.eval(`!!document.querySelector('.hp-row')`))) await this.eval(`window.__verifyHistory.openHistoryPanel();true`);
    await this.wait(`Array.from(document.querySelectorAll('.hp-row')).some(r=>r.textContent.includes(${JSON.stringify(oid.slice(0, 7))}))`, 'history revision row');
  }
  async restorePrompt(oid) {
    await this.history(oid);
    await this.eval(`(()=>{const r=Array.from(document.querySelectorAll('.hp-row')).find(r=>r.textContent.includes(${JSON.stringify(oid.slice(0, 7))}));r.querySelector('.hp-row-tools .btn-text').click();return true;})()`);
    await this.wait(`Array.from(document.querySelectorAll('.modal-actions button')).some(b=>b.textContent.trim()==='Restore')`, 'restore confirmation');
  }
  async capture(name) { const r = await this.send('screenshot', { file: path.join(EVIDENCE, 'winscp-' + name + '.png') }); report.captures.push(r); return r; }
  async stop() {
    if (this.socket && !this.exit) { try { await this.send('quit'); } catch {} }
    const end = Date.now() + 5000;
    while (this.child && !this.exit && Date.now() < end) await sleep(50);
    if (this.child && !this.exit) this.child.kill();
    if (this.socket) this.socket.destroy();
    if (this.server) await new Promise(r => this.server.close(r));
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }
}
async function checkSafety(app, expectedHash) {
  const s = await app.inspect();
  assert.equal(s.sessions, 0); assert.equal(s.queue, 0);
  assert.equal(s.hidden, true); assert.equal(s.offscreen, true);
  if (expectedHash) {
    assert.equal(s.stableConfigHash, s.baselineStableConfigHash, 'All config except exact notification/search UI histories preserved; changed paths: ' + s.configDelta.join(', '));
    assert.ok(s.configDelta.every(p => p === 'prefs.notifications.history' || p.startsWith('prefs.notifications.history.') ||
      p === 'prefs.search.history-panel' || p.startsWith('prefs.search.history-panel.')), 'Only declared operational UI history paths changed: ' + s.configDelta.join(', '));
    for (const check of s.restoreChecks) { assert.deepEqual(check.changedPaths, []); assert.equal(check.beforeHash, check.afterHash); }
  }
  return s;
}
async function one(name, fn) {
  const rootBase = path.join(EVIDENCE, 'winscp-data');
  await fs.mkdir(rootBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(rootBase, name + '-'));
  const app = new NativeApp(root);
  const result = { name, root, started: new Date().toISOString() };
  try { await app.start(); result.runtime = app.runtime; result.evidence = await fn(app); result.status = 'passed'; }
  catch (e) { result.status = 'failed'; result.error = e.stack; result.stderr = app.stderr;
    try { result.failureState = await app.inspect(); } catch {}
    try { await app.capture(name + '-failure'); } catch (captureError) { result.captureError = captureError.message; } }
  finally { try { await app.stop(); } catch (e) { result.stopError = e.message; } result.finished = new Date().toISOString(); report.cases.push(result); }
  console.log(JSON.stringify({ case: name, status: result.status, error: result.error && result.error.split('\n')[0] }));
}
async function local(app, name = 'original.txt') {
  const file = path.join(app.root, name); const original = Buffer.from('Saved original\r\nDo not overwrite.\r\n');
  await fs.writeFile(file, original); return { file, original };
}
async function assertOriginal(f) { assert.deepEqual(await fs.readFile(f.file), f.original); }
const DRAFT = 'Unsaved native draft\n繁體中文 · café · 🐈\n';
async function discardFixture(app) {
  const f = await local(app); await app.open(f.file, DRAFT); await app.closePrompt(); await app.action('Discard');
  await app.wait(`window.__verifyEditor.listEditorWindows().length===0`, 'editor closed after discard');
  const s = await app.inspect(); const row = s.rows.find(r => r.action === 'discarded');
  assert.ok(row, 'discarded revision recorded');
  const rev = await app.send('revision', { oid: row.oid }); assert.equal(rev.ok, true);
  return { ...f, row, discard: rev.value.editorDiscard };
}
async function main() {
  report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(report.commit, EXPECTED);
  report.asarSha256 = APP === ASAR ? sha(await fs.readFile(ASAR)) : null;
  report.hostSha256 = sha(await fs.readFile(path.join(EVIDENCE, 'winscp-native-host.cjs')));
  report.driverSha256 = sha(await fs.readFile(__filename));
  await one('discard-cancel-repeat-success', async app => {
    const f = await local(app); const id = await app.open(f.file, DRAFT);
    const before = await app.inspect(); await app.closePrompt(true);
    assert.equal(await app.eval(`document.querySelectorAll('.modal .is-danger').length`), 1);
    await app.capture('discard-confirmation'); await app.action('Cancel');
    assert.equal(await app.eval(`window.__verifyEditor.listEditorWindows()[0].dirty`), true);
    assert.equal((await app.inspect()).calls.close, before.calls.close);
    await app.closePrompt(); await app.escape();
    assert.equal(await app.eval(`window.__verifyEditor.listEditorWindows()[0].text`), DRAFT);
    assert.equal((await app.inspect()).calls.close, before.calls.close);
    await app.closePrompt(); await app.action('Discard');
    await app.wait(`window.__verifyEditor.listEditorWindows().length===0`, 'discard success');
    let s = await app.inspect(); assert.equal(s.calls.close, before.calls.close + 1);
    const row = s.rows.find(r => r.action === 'discarded'); assert.ok(row);
    const rec = (await app.send('revision', { oid: row.oid })).value.editorDiscard;
    assert.notEqual(rec.localPath, f.file); assert.deepEqual(await fs.readFile(rec.localPath), Buffer.from(DRAFT)); await assertOriginal(f);
    await app.capture('discard-recovery-notice');
    const secondDraft = DRAFT + 'Second discard.\n';
    await app.open(f.file, secondDraft); await app.closePrompt(true); await app.action('Discard');
    await app.wait(`window.__verifyEditor.listEditorWindows().length===0`, 'second discard');
    s = await app.inspect(); const secondRow = s.rows.find(r => r.action === 'discarded' && r.oid !== row.oid);
    const second = (await app.send('revision', { oid: secondRow.oid })).value.editorDiscard;
    assert.notEqual(second.localPath, rec.localPath); assert.deepEqual(await fs.readFile(rec.localPath), Buffer.from(DRAFT));
    assert.deepEqual(await fs.readFile(second.localPath), Buffer.from(secondDraft)); await assertOriginal(f);
    return { firstEditor: id, firstRevision: row.oid, secondRevision: secondRow.oid, firstRecovery: rec.localPath,
      secondRecovery: second.localPath, draftSha256: sha(Buffer.from(DRAFT)), safety: await checkSafety(app) };
  });
  await one('discard-close-failure', async app => {
    const f = await local(app); await app.open(f.file, DRAFT); await app.mode('close-fail');
    await app.closePrompt(); await app.action('Discard');
    await app.wait(`document.querySelector('.toast.is-error')!==null`, 'close failure notification');
    assert.equal(await app.eval(`window.__verifyEditor.listEditorWindows()[0].dirty`), true);
    assert.equal((await app.inspect()).editors.length, 1); await assertOriginal(f);
    await app.capture('discard-close-failure'); return checkSafety(app);
  });
  await one('discard-repeated-action', async app => {
    const f = await local(app); await app.open(f.file, DRAFT); const before = await app.inspect();
    await app.closePrompt(); await app.action('Discard', true);
    await sleep(500);
    const s = await app.inspect(); await assertOriginal(f);
    const rows = s.rows.filter(r => r.action === 'discarded'); assert.equal(rows.length, 1);
    assert.equal(s.calls.recoveryCopy, before.calls.recoveryCopy + 1);
    assert.equal(s.editors.length, 0);
    const rec = (await app.send('revision', { oid: rows[0].oid })).value.editorDiscard;
    assert.deepEqual(await fs.readFile(rec.localPath), Buffer.from(DRAFT));
    await app.capture('discard-repeated-action');
    const remaining = await app.eval(`window.__verifyEditor.listEditorWindows().map(h=>({id:h.id,dirty:h.dirty,text:h.text}))`);
    assert.equal(remaining.length, 0, 'Repeated Discard activation must also close the renderer editor: ' + JSON.stringify(remaining));
    return { repeatedActivations: 2, copies: 1, revisions: 1, safety: await checkSafety(app) };
  });
  await one('discard-copy-failure', async app => {
    const f = await local(app); await app.open(f.file, DRAFT); await app.mode('copy-fail');
    await app.closePrompt(); await app.action('Discard');
    await app.wait(`window.__verifyEditor.listEditorWindows().length===0`, 'best-effort failed copy closes');
    const s = await app.inspect(); const row = s.rows.find(r => r.action === 'discarded');
    const rev = (await app.send('revision', { oid: row.oid })).value.editorDiscard;
    assert.equal(rev.bytesBase64, null); await assertOriginal(f);
    const notices = await app.eval(`document.querySelector('.toast-stack').textContent`);
    assert.match(notices, /no recovery copy is available/i); await app.capture('discard-copy-failure');
    return { revision: row.oid, notices, safety: await checkSafety(app) };
  });
  await one('restore-cancel-repeat-success', async app => {
    const f = await discardFixture(app); await fs.unlink(f.discard.localPath);
    await app.history(f.row.oid); const hash = await app.send('currentConfig'); const before = await app.inspect();
    await app.restorePrompt(f.row.oid); await app.capture('restore-confirmation'); await app.action('Cancel');
    assert.equal((await app.inspect()).calls.restoreDiscard, before.calls.restoreDiscard);
    await app.restorePrompt(f.row.oid); await app.escape();
    assert.equal((await app.inspect()).calls.restoreDiscard, before.calls.restoreDiscard);
    await app.mode('restore-delay'); await app.restorePrompt(f.row.oid); await app.action('Restore', true);
    await app.wait(`window.__verifyEditor.listEditorWindows().length===1`, 'first restored editor');
    let s = await app.inspect(); assert.equal(s.calls.restoreDiscard, before.calls.restoreDiscard + 1);
    assert.equal(s.rows.length, before.rows.length + 1); const first = s.editors[0];
    assert.equal(first.localOnly, true); assert.equal(first.remotePath, ''); assert.equal(first.sessionId, '');
    assert.deepEqual(await fs.readFile(first.localPath), Buffer.from(DRAFT)); await assertOriginal(f);
    await app.action('Close'); await app.capture('restore-success'); await checkSafety(app, hash);
    await app.mode(''); await app.restorePrompt(f.row.oid); await app.action('Restore');
    await app.wait(`window.__verifyEditor.listEditorWindows().length===2`, 'second restored editor');
    s = await app.inspect(); const second = s.editors.find(e => e.id !== first.id);
    assert.notEqual(first.localPath, second.localPath); assert.deepEqual(await fs.readFile(second.localPath), Buffer.from(DRAFT));
    await fs.writeFile(first.localPath, 'Owned test copy modified');
    assert.deepEqual(await fs.readFile(second.localPath), Buffer.from(DRAFT)); await assertOriginal(f);
    return { revision: f.row.oid, firstRecovery: first.localPath, secondRecovery: second.localPath,
      deletedOriginalRecovery: f.discard.localPath, safety: await checkSafety(app, hash) };
  });
  for (const failure of ['copy-fail', 'open-fail', 'audit-fail']) {
    await one('restore-' + failure, async app => {
      const f = await discardFixture(app); await app.history(f.row.oid); const hash = await app.send('currentConfig'); const before = await app.inspect();
      const temp = path.join(app.root, 'temp'); const beforeDirs = await fs.readdir(temp);
      await app.restorePrompt(f.row.oid); await app.mode(failure); await app.action('Restore');
      await app.wait(`document.querySelector('.toast.is-error')!==null`, 'restore failure notification');
      const s = await app.inspect(); assert.equal(s.rows.length, before.rows.length);
      const notices = await app.eval(`Array.from(document.querySelectorAll('.toast.is-error')).map(t=>t.textContent).join(String.fromCharCode(10))`);
      if (failure === 'audit-fail') {
        assert.equal(s.editors.length, 1); assert.deepEqual(await fs.readFile(s.editors[0].localPath), Buffer.from(DRAFT));
        assert.match(notices, /new history revision could not be recorded/i);
      } else {
        assert.equal(s.editors.length, 0); assert.deepEqual(await fs.readdir(temp), beforeDirs);
        assert.match(notices, /restore did not happen/i);
      }
      await assertOriginal(f); await app.capture('restore-' + failure);
      return { notices, safety: await checkSafety(app, hash) };
    });
  }
  await one('restore-malformed-revision', async app => {
    const oid = await app.send('seed', { discard: { fileName: 'test.txt', bytesBase64: '%%%' } });
    await app.history(oid); const hash = await app.send('currentConfig'); const before = await app.inspect();
    await app.restorePrompt(oid); await app.action('Restore');
    await app.wait(`document.querySelector('.toast.is-error')!==null`, 'invalid recovery notification');
    const s = await app.inspect(); assert.equal(s.rows.length, before.rows.length); assert.equal(s.editors.length, 0);
    await app.capture('restore-malformed-revision'); return checkSafety(app, hash);
  });
}
main().catch(e => { report.fatal = e.stack; console.error(e.stack); }).finally(async () => {
  report.finished = new Date().toISOString(); report.passed = report.cases.filter(c => c.status === 'passed').length;
  report.failed = report.cases.filter(c => c.status === 'failed').length;
  await fs.writeFile(path.join(EVIDENCE, 'winscp-native-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fatal: !!report.fatal,
    report: path.join(EVIDENCE, 'winscp-native-report.json') }));
  process.exitCode = report.failed || report.fatal ? 1 : 0;
});
