// electron-host.js — the Electron MAIN process the end-to-end suite drives.
//
// This file is not the application. It is the smallest possible main process
// that stands the application's REAL parts up in the REAL runtime:
//
//   * design/main/config.js — the real store, pointed at a temp data root;
//   * design/main/ipc.js    — the real handler table, registered on the real
//                             `ipcMain`, with the real validation;
//   * design/preload/preload.js — the real bridge, in a real sandboxed,
//                             context-isolated renderer;
//   * design/renderer/index.html — the real UI.
//
// Nothing is stubbed. A call made through this host takes exactly the path a
// user's click takes: renderer -> contextBridge -> ipcRenderer.invoke -> the
// Electron process boundary (with its structured clone) -> ipcMain -> ipc.js.
// That boundary is the whole point: an object that cannot be cloned, or a
// handler that throws, fails HERE and nowhere else.
//
// Two windows, deliberately:
//
//   main   the real preload and the real UI — how the application behaves.
//   abuse  a preload that exposes a generic invoke() — how a COMPROMISED
//          renderer behaves. preload.js refuses to offer a passthrough (that
//          refusal is one of its load-bearing decisions), so proving the
//          handler table is safe against arbitrary input needs a renderer that
//          does not play by preload.js's rules. That is the threat model, so it
//          is what the abuse window simulates.
//
// It speaks newline-delimited JSON over a loopback socket the test opened, not
// over stdout: Chromium writes to stdout whenever it feels like it, and a
// protocol sharing a pipe with that is a protocol that flakes.
'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');

const SPAWNED_AT = Number(process.env.WINSCP_E2E_T0) || Date.now();
const REPO = path.resolve(__dirname, '..', '..');
const DATA_ROOT = process.env.WINSCP_E2E_ROOT;
const RPC_PORT = Number(process.env.WINSCP_E2E_RPC);

const { app, BrowserWindow } = require('electron');

// A test machine has no GPU worth using and a headless one has none at all.
app.disableHardwareAcceleration();
// Chromium's own cache and profile go inside the temp root too, so a test run
// leaves nothing behind in the real user profile.
app.setPath('userData', path.join(DATA_ROOT, 'chromium-profile'));

// paths.js decides where every file the app owns lives, and it has to be
// redirected BEFORE anything reads it.
const P = require(path.join(REPO, 'design', 'main', 'paths.js'));
P.setRoot(DATA_ROOT);

const { Config } = require(path.join(REPO, 'design', 'main', 'config.js'));
const { Ipc } = require(path.join(REPO, 'design', 'main', 'ipc.js'));
const crypt = require(path.join(REPO, 'design', 'main', 'crypto.js'));

const timings = { spawned: SPAWNED_AT, ready: 0, windowCreated: 0, loaded: 0, apiAnswered: 0 };
const state = { config: null, ipc: null, main: null, abuse: null, socket: null };

// ------------------------------------------------------------------ transport

/** Frame one reply. Written as a single line so the reader can split on \n. */
function reply(id, ok, payload) {
  if (!state.socket) return;
  const line = JSON.stringify(ok ? { id, ok: true, value: payload } : { id, ok: false, error: String(payload) });
  state.socket.write(line + '\n');
}

function connectRpc() {
  return new Promise((resolve) => {
    const socket = net.connect(RPC_PORT, '127.0.0.1', () => resolve(socket));
    socket.setNoDelay(true);
    state.socket = socket;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        handle(message);
      }
    });
    // The test process going away must not leave an Electron behind.
    socket.on('close', () => { try { app.exit(0); } catch { process.exit(0); } });
    socket.on('error', () => { try { app.exit(0); } catch { process.exit(0); } });
  });
}

// -------------------------------------------------------------------- windows

/** A JS source literal for one argument, preserving `undefined`. */
function literal(v) {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

function makeWindow(kind) {
  const preload = kind === 'main'
    ? path.join(REPO, 'design', 'preload', 'preload.js')
    : path.join(__dirname, 'abuse-preload.js');

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    frame: false,
    webPreferences: {
      preload,
      // Exactly the application's own settings. Loosening any of them here
      // would make the suite prove something the shipped app does not do.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      // Chromium throttles a hidden window's timers, which would make every
      // timing assertion below a measurement of the throttle.
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', () => { /* the page's own noise is not ours */ });
  return win;
}

/**
 * Collect every event the main process pushes. The renderer is the only place
 * these can be observed, because `emit()` sends them to a webContents.
 */
const COLLECTOR = `
  (() => {
    if (window.__e2eEvents) return 'already';
    window.__e2eEvents = [];
    for (const name of window.api.events) {
      window.api.on(name, (payload) => {
        window.__e2eEvents.push({ event: name, payload, at: Date.now() });
      });
    }
    return window.api.events.length;
  })()
`;

// ------------------------------------------------------------------- commands

const HANDLERS = {
  ping: () => 'pong',

  timings: () => ({ ...timings, now: Date.now() }),

  /** Every channel ipc.js actually registered. */
  channels: () => state.ipc.channels,

  /** Whether the OS credential store is usable in this runtime. */
  cryptoInfo: () => ({
    osEncryption: crypt.isOsEncryptionAvailable(),
    configFile: P.config(),
    root: P.root(),
  }),

  /** Drive the app the way the UI does: through window.api. */
  async invoke(m) {
    const win = m.target === 'abuse' ? state.abuse : state.main;
    const src = `window.api.${m.path.join('.')}(${(m.args || []).map(literal).join(',')})`;
    return win.webContents.executeJavaScript(src, true);
  },

  /**
   * Drive the handler table the way a compromised renderer would: a raw
   * ipcRenderer.invoke, with whatever arguments the test wants. The reply says
   * whether the invoke REJECTED, which is the thing ipc.js promises never
   * happens.
   */
  async abuse(m) {
    const src = `window.__abuse.invoke(${literal(m.channel)}${(m.args || []).map((a) => ',' + literal(a)).join('')})`;
    return state.abuse.webContents.executeJavaScript(src, true);
  },

  /** Arbitrary read-only inspection of a page, for DOM assertions. */
  async eval(m) {
    const win = m.target === 'abuse' ? state.abuse : state.main;
    return win.webContents.executeJavaScript(m.src, true);
  },

  /** Take everything collected so far and start a fresh window. */
  async events() {
    return state.main.webContents.executeJavaScript(
      '(() => { const out = window.__e2eEvents || []; window.__e2eEvents = []; return out; })()', true);
  },

  /**
   * A real capture of the real window. A window that has never been shown has
   * nothing composited on Windows, so it is shown inactive (it never takes
   * focus), captured, and hidden again.
   */
  async screenshot(m) {
    const win = m.target === 'abuse' ? state.abuse : state.main;
    const wasVisible = win.isVisible();
    if (!wasVisible) win.showInactive();
    // One frame of grace so the compositor has something to hand over.
    await new Promise((r) => setTimeout(r, m.settleMs === undefined ? 400 : m.settleMs));
    const image = await win.capturePage();
    const png = image.toPNG();
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    fs.writeFileSync(m.file, png);
    if (!wasVisible) win.hide();
    return { file: m.file, bytes: png.length, size: image.getSize() };
  },

  /**
   * Start an update check and do NOT wait for it, exactly as main.js does not.
   * The suite points the proxy environment at a closed loopback port, so this
   * reaches no network and still exercises "the app stays usable while a check
   * is in flight".
   */
  updateProbe() {
    const started = Date.now();
    state.ipc.updates.check({ reason: 'startup' }).then(
      () => { state.updateProbe = { done: true, ms: Date.now() - started }; },
      () => { state.updateProbe = { done: true, failed: true, ms: Date.now() - started }; },
    );
    return { started };
  },

  updateProbeResult: () => state.updateProbe || { done: false },

  /** Force the debounced config writer out to disk right now. */
  flushConfig() { state.config.flush(); return P.config(); },

  quit() {
    setTimeout(() => app.exit(0), 20);
    return true;
  },
};

async function handle(message) {
  const fn = HANDLERS[message.cmd];
  if (!fn) return reply(message.id, false, `Unknown command: ${message.cmd}`);
  try {
    reply(message.id, true, await fn(message));
  } catch (e) {
    reply(message.id, false, e && e.stack ? e.stack : String(e));
  }
}

// ------------------------------------------------------------------ lifecycle

app.whenReady().then(async () => {
  timings.ready = Date.now();

  state.config = new Config().load();
  state.config.appVersion = app.getVersion();
  state.config.on('error', () => { /* reported through the RPC, never a dialog */ });

  state.ipc = new Ipc({
    config: state.config,
    getWindow: () => state.main,
    version: app.getVersion(),
  });
  state.ipc.registerAll();

  state.main = makeWindow('main');
  state.abuse = makeWindow('abuse');
  timings.windowCreated = Date.now();

  const index = path.join(REPO, 'design', 'renderer', 'index.html');
  await Promise.all([
    state.main.loadFile(index),
    state.abuse.loadFile(path.join(__dirname, 'e2e-blank.html')),
  ]);
  timings.loaded = Date.now();

  await state.main.webContents.executeJavaScript(COLLECTOR, true);
  timings.apiAnswered = Date.now();

  await connectRpc();
  state.socket.write(JSON.stringify({ id: 0, ok: true, value: { hello: true, timings } }) + '\n');
});

// A crash in here must arrive at the test as a message, not as a silent exit.
process.on('uncaughtException', (e) => {
  try { state.socket.write(JSON.stringify({ id: -1, ok: false, error: `uncaughtException: ${e && e.stack}` }) + '\n'); } catch { /* no socket yet */ }
});
process.on('unhandledRejection', (e) => {
  try { state.socket.write(JSON.stringify({ id: -1, ok: false, error: `unhandledRejection: ${e && (e.stack || e)}` }) + '\n'); } catch { /* no socket yet */ }
});

