'use strict';
// Task-only native verifier. Production modules are loaded unchanged from app.asar.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const ROOT = path.resolve(process.env.WINSCP_VERIFY_ROOT);
const APP = path.resolve(process.env.WINSCP_VERIFY_APP);
const blocked = [];
const deny = (kind) => { blocked.push(kind); throw Object.assign(new Error('Verification blocked outbound ' + kind), { code: 'VERIFY_NETWORK_BLOCKED' }); };
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const o = typeof a[0] === 'object' ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : 'localhost' };
  if (o.path || !['127.0.0.1', '::1', 'localhost'].includes(o.host || 'localhost')) return deny('tcp');
  return socketConnect.apply(this, args);
};
for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  mod.request = () => deny(name); mod.get = () => deny(name);
}
require('node:tls').connect = () => deny('tls');
require('node:dgram').createSocket = () => deny('udp');
global.fetch = async () => deny('fetch');
const { app, BrowserWindow, session, ipcMain, net: electronNet } = require('electron');
electronNet.request = () => deny('electron-net');
electronNet.fetch = async () => deny('electron-fetch');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(ROOT, 'chromium-profile'));
app.setPath('temp', ROOT);
app.setPath('logs', path.join(ROOT, 'logs'));
const P = require(path.join(APP, 'design/main/paths.js'));
P.setRoot(ROOT);
const { Config } = require(path.join(APP, 'design/main/config.js'));
const { Ipc } = require(path.join(APP, 'design/main/ipc.js'));
let win, config, ipc, rpc;
let mode = '', baselineConfig = null;
const calls = { close: 0, recoveryCopy: 0, restoreDiscard: 0, openLocal: 0, snapshot: 0 };
const stateHash = () => crypto.createHash('sha256').update(JSON.stringify(config.exportState())).digest('hex');
function stableHash(state) {
  const value = JSON.parse(JSON.stringify(state));
  // Exactly these two renderer-owned histories legitimately persist on notification/close.
  for (const [parent, key] of [['notifications', 'history'], ['search', 'history-panel']]) {
    if (!value.prefs[parent]) continue;
    delete value.prefs[parent][key];
    if (!Object.keys(value.prefs[parent]).length) delete value.prefs[parent];
  }
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const restoreChecks = [];
const ui = async (src) => {
  try { return await win.webContents.executeJavaScript(src, true); }
  catch (e) { throw new Error(e.message + '\nVerification expression: ' + src); }
};
function delta(a, b, prefix = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [prefix];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => delta(a[k], b[k], prefix ? prefix + '.' + k : k));
}
const handlers = {
  eval: (m) => ui(m.src),
  async api(m) { return ui(`window.api.${m.name}(...${JSON.stringify(m.args || [])})`); },
  mode(m) { mode = m.value || ''; return mode; },
  async inspect() {
    await ipc.history.settled();
    const rows = await ipc.history.list({ limit: 100 });
    return { configHash: stateHash(), sessions: ipc.sessions.sessions.size,
      queue: ipc.queue().list().length, editors: ipc.editors.list(), rows: rows.value || [],
      calls: { ...calls }, networkBlocks: [...blocked], hidden: !win.isVisible(),
      offscreen: win.webContents.isOffscreen(), root: P.root(),
      configDelta: baselineConfig ? delta(baselineConfig, config.exportState()) : [],
      stableConfigHash: stableHash(config.exportState()),
      baselineStableConfigHash: baselineConfig ? stableHash(baselineConfig) : null,
      restoreChecks: [...restoreChecks] };
  },
  async revision(m) { return ipc.history.read(m.oid); },
  async seed(m) {
    const r = await ipc.history.snapshot('Discarded test-only revision', {
      ...config.exportState(), editorDiscard: m.discard,
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.value.oid;
  },
  async currentConfig() {
    await new Promise(r => setTimeout(r, 300));
    // Synthetic, intentionally nonfunctional protected-value fixture; no real credential is read.
    config.data.prefs.nativeVerificationMarker = 'current-after-discard';
    config.data.sites = [{ id: 'verification-only', name: 'Verification fixture',
      hostName: '', savePassword: true, password: 'os:synthetic-nonfunctional-verification-fixture' }];
    config.data.hostKeys = { 'verification.invalid:22': { fingerprint: 'SYNTHETIC-NONFUNCTIONAL-FIXTURE' } };
    config.flush();
    baselineConfig = config.exportState();
    return stateHash();
  },
  async screenshot(m) {
    if (win.isVisible() || !win.webContents.isOffscreen()) throw new Error('Window isolation failed');
    const target = path.resolve(m.file);
    const evidence = path.resolve(__dirname) + path.sep;
    if (!target.startsWith(evidence)) throw new Error('Capture path outside evidence');
    await new Promise(r => setTimeout(r, 250));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error('Offscreen capture was empty');
    const bytes = image.toPNG();
    await fsp.writeFile(target, bytes);
    return { file: target, bytes: bytes.length, size: image.getSize(), hidden: !win.isVisible(), offscreen: true };
  },
  async quit() { setTimeout(() => app.exit(0), 25); return true; },
};
function send(message) { if (rpc) rpc.write(JSON.stringify(message) + '\n'); }
async function handle(m) {
  try { if (!handlers[m.cmd]) throw new Error('Unknown verification command'); send({ id: m.id, ok: true, value: await handlers[m.cmd](m) }); }
  catch (e) { send({ id: m.id, ok: false, error: e.stack || String(e) }); }
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => {
    blocked.push('renderer-web-request'); cb({ cancel: true });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  config = new Config();
  config.on('error', () => {});
  config.data.prefs.language = 'en';
  config.data.prefs.disclosureAccepted = true;
  config.data.prefs.funnyLevel = { en: 1, yue: 1 };
  config.data.prefs.nativeVerificationMarker = 'before-discard';
  config.data.prefs.scpCommander.localPanel.lastPath = ROOT;
  config.flush();
  ipc = new Ipc({ config, getWindow: () => win, version: '0.1.0-native-verification' });
  ipc.history.on('error', () => {});
  for (const name of ['close', 'recoveryCopy', 'restoreDiscard', 'openLocal']) {
    const original = ipc.editors[name].bind(ipc.editors);
    ipc.editors[name] = async (...args) => {
      calls[name]++;
      if ((mode === 'close-fail' && name === 'close') ||
          (mode === 'copy-fail' && name === 'recoveryCopy') ||
          (mode === 'open-fail' && name === 'openLocal')) {
        throw Object.assign(new Error('Test-controlled ' + mode), { code: 'EIO' });
      }
      if (mode === 'restore-delay' && name === 'restoreDiscard') await new Promise(r => setTimeout(r, 300));
      return original(...args);
    };
  }
  const snapshot = ipc.history.snapshot.bind(ipc.history);
  ipc.history.snapshot = async (...args) => {
    calls.snapshot++;
    if (mode === 'audit-fail') return { ok: false, error: { code: 'EIO', message: 'Test-controlled audit failure' } };
    return snapshot(...args);
  };
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => register(channel, channel !== 'history:restore' ? listener : async (...args) => {
    const before = config.exportState();
    const result = await listener(...args);
    const after = config.exportState();
    restoreChecks.push({ ok: result.ok, beforeHash: crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex'),
      afterHash: crypto.createHash('sha256').update(JSON.stringify(after)).digest('hex'), changedPaths: delta(before, after) });
    return result;
  });
  ipc.registerAll();
  win = new BrowserWindow({ width: 1440, height: 1000, show: false, frame: false,
    webPreferences: { preload: path.join(APP, 'design/preload/preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, webviewTag: false, spellcheck: false,
      webSecurity: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
  await win.loadFile(path.join(APP, 'design/renderer/index.html'));
  rpc = net.connect(Number(process.env.WINSCP_VERIFY_RPC), '127.0.0.1');
  await new Promise((resolve, reject) => { rpc.once('connect', resolve); rpc.once('error', reject); });
  let buffer = '';
  rpc.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  rpc.on('close', () => app.exit(0));
  rpc.on('error', () => app.exit(1));
  send({ id: 0, ok: true, value: { app: APP, root: ROOT, electron: process.versions.electron,
    node: process.versions.node, platform: process.platform, arch: process.arch } });
}).catch(e => { process.stderr.write(e.stack + '\n'); app.exit(1); });
process.on('unhandledRejection', e => { process.stderr.write(String(e && e.stack || e) + '\n'); });
