// app-harness.js — boot the real application and drive it, for any suite that
// needs more than a unit test.
//
// What this gives a test:
//
//   startApp()          the real Electron main process, the real config store,
//                       the real ipc.js handler table, the real preload and the
//                       real renderer — pointed at a throwaway data root.
//   app.api(...)        one call through the real bridge: renderer ->
//                       contextBridge -> ipcRenderer -> ipcMain -> ipc.js.
//   app.raw(channel)    the same handler table, driven the way a compromised
//                       renderer would drive it, so the contract can be abused.
//   app.waitForEvent()  the events the main process pushes, observed where they
//                       actually arrive: in the page.
//   startSftpServer()   re-exported from ./sftp-server.js — a real SSH/SFTP
//                       server on an ephemeral port.
//
// Rules this file keeps, because they are what makes the suite trustworthy:
//
//   * NOTHING is stubbed. If a call cannot be made through the real bridge, the
//     test fails rather than falling back to calling the module directly.
//   * NO fixed port and NO shared directory. Everything is ephemeral, so two
//     runs on one machine cannot interfere.
//   * NO network. The child inherits proxy variables pointed at a closed
//     loopback port, so anything that tries to reach the internet fails locally
//     and instantly instead of hanging or, worse, succeeding.
//   * EVERY app is stopped in an `after` hook. `stopAll()` is a backstop for a
//     suite that fails before its own teardown runs.
'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startSftpServer } = require('./sftp-server');

const REPO = path.resolve(__dirname, '..', '..');
const HOST_SCRIPT = path.join(__dirname, 'electron-host.js');

/** Electron's launcher, as installed by the devDependency. */
function electronBinary() {
  // The `electron` package's main export is the absolute path to the binary.
  // Requiring it from a Node process is the documented way to find it.
  const bin = require('electron');
  if (typeof bin !== 'string' || !fs.existsSync(bin)) {
    throw new Error('The Electron binary could not be located; run `npm install` first.');
  }
  return bin;
}

/** Every app this process started, so a failed test cannot leak one. */
const LIVE = new Set();

function timeout(ms, what) {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${what}.`)), ms);
    if (t.unref) t.unref();
  });
}

class AppUnderTest {
  constructor(options) {
    this.options = options;
    this.root = options.root;
    this.configFile = path.join(this.root, 'winscp-material.json');
    this.child = null;
    this.socket = null;
    this._server = null;
    this._nextId = 1;
    this._pending = new Map();
    this._events = [];
    this._stderr = '';
    this._exited = null;
    this.timings = null;
  }

  // ------------------------------------------------------------- lifecycle
  async start() {
    await fsp.mkdir(this.root, { recursive: true });

    // The child dials back to us, rather than us dialling it: only one side can
    // choose an ephemeral port and know it.
    const ready = new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this.socket = socket;
        socket.setNoDelay(true);
        this._readLines(socket, resolve, reject);
      });
      this._server.once('error', reject);
      this._server.listen(0, '127.0.0.1');
    });

    await new Promise((r) => this._server.once('listening', r));
    const rpcPort = this._server.address().port;

    const env = {
      ...process.env,
      WINSCP_E2E_ROOT: this.root,
      WINSCP_E2E_RPC: String(rpcPort),
      WINSCP_E2E_T0: String(Date.now()),
      // No test may reach the internet. Port 1 on loopback is closed, so any
      // outbound HTTP(S) attempt fails immediately and locally.
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
      NO_PROXY: '',
      // Electron's own crash reporter and first-run machinery have nothing to
      // do here and only slow the boot down.
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // A test may point the proxy at something that hangs rather than
      // refuses, which is how "startup does not block on the network" is
      // proved rather than asserted.
      ...(this.options.env || {}),
    };

    this.child = spawn(electronBinary(), [HOST_SCRIPT, '--no-sandbox'], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    LIVE.add(this);

    this.child.stdout.on('data', () => { /* Chromium noise; the protocol is on the socket */ });
    this.child.stderr.on('data', (d) => { this._stderr = (this._stderr + d.toString()).slice(-16384); });
    this.child.on('exit', (code, signal) => {
      this._exited = { code, signal };
      for (const [, entry] of this._pending) {
        entry.reject(new Error(`The application exited (code ${code}${signal ? ', ' + signal : ''}) with a call in flight.\n${this._stderr}`));
      }
      this._pending.clear();
    });

    const hello = await Promise.race([
      ready,
      timeout(this.options.bootTimeoutMs || 60000, 'the application to boot')
        .catch((e) => { throw new Error(`${e.message}\nElectron stderr:\n${this._stderr}`); }),
    ]);
    this.timings = hello.timings;
    return this;
  }

  _readLines(socket, resolveHello, rejectHello) {
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
        if (message.id === 0) { resolveHello(message.value); continue; }
        if (message.id === -1) {
          // An uncaught error inside the host: fail whatever is in flight, and
          // remember it so a later assertion can name it.
          this._hostError = message.error;
          continue;
        }
        const entry = this._pending.get(message.id);
        if (!entry) continue;
        this._pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error));
      }
    });
    socket.on('error', rejectHello);
  }

  _send(cmd, extra, waitMs) {
    if (this._exited) {
      return Promise.reject(new Error(`The application has exited (code ${this._exited.code}).\n${this._stderr}`));
    }
    const id = this._nextId++;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    this.socket.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    return Promise.race([
      promise,
      timeout(waitMs || this.options.callTimeoutMs || 30000, `${cmd} ${extra && extra.path ? extra.path.join('.') : (extra && extra.channel) || ''}`),
    ]);
  }

  async stop() {
    LIVE.delete(this);
    if (this.child && !this._exited) {
      try { await this._send('quit', {}, 5000); } catch { /* it may already be going */ }
      await Promise.race([
        new Promise((r) => this.child.once('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (!this._exited) { try { this.child.kill(); } catch { /* already gone */ } }
    }
    if (this._server) await new Promise((r) => this._server.close(r));
    if (this.options.keepRoot !== true) {
      await fsp.rm(this.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- driving
  /**
   * One call through the real bridge. `dotted` names a function on the preload
   * surface, e.g. 'session.open' or 'fs.list'.
   *
   * Returns the envelope the renderer sees: { ok, value } or { ok, error }.
   */
  api(dotted, ...args) {
    return this._send('invoke', { target: 'main', path: String(dotted).split('.'), args });
  }

  /** The same, but asserts `ok` and returns the value — for the happy path. */
  async ok(dotted, ...args) {
    const reply = await this.api(dotted, ...args);
    assert.ok(reply && reply.ok === true,
      `${dotted} failed: ${reply && reply.error ? `${reply.error.code}: ${reply.error.message}` : JSON.stringify(reply)}`);
    return reply.value;
  }

  /** The same, but asserts the call was REFUSED, and returns the error. */
  async refused(dotted, ...args) {
    const reply = await this.api(dotted, ...args);
    assert.ok(reply && reply.ok === false, `${dotted} was expected to be refused but returned ok.`);
    return reply.error;
  }

  /**
   * A raw invoke from the hostile-renderer window. Resolves to
   * `{ threw: false, reply }` or `{ threw: true, message }` — the latter is the
   * failure ipc.js's contract forbids.
   */
  raw(channel, ...args) {
    return this._send('abuse', { channel, args });
  }

  /** Read-only inspection of a page (DOM assertions). */
  evaluate(src, target) { return this._send('eval', { src, target: target || 'main' }); }

  /** Set the real BrowserWindow content viewport for narrow-layout smoke tests. */
  resize(width, height) { return this._send('resize', { width, height }); }

  /**
   * Wait until the renderer has actually built its interface.
   *
   * `did-finish-load` fires when the document is parsed, not when a module
   * graph has finished booting, so a DOM assertion made the instant the page
   * loads is a race — it measures how busy the machine is, not whether the UI
   * came up.
   */
  async waitForRenderer(minNodes, timeoutMs) {
    const want = minNodes || 40;
    const deadline = Date.now() + (timeoutMs || 20000);
    let count = 0;
    while (Date.now() < deadline) {
      count = await this.evaluate('document.querySelectorAll("*").length');
      if (count >= want) return count;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`The renderer built only ${count} elements in ${timeoutMs || 20000}ms (wanted ${want}).`);
  }

  channels() { return this._send('channels', {}); }

  cryptoInfo() { return this._send('cryptoInfo', {}); }

  flushConfig() { return this._send('flushConfig', {}); }

  bootTimings() { return this._send('timings', {}); }

  updateProbe() { return this._send('updateProbe', {}); }

  updateProbeResult() { return this._send('updateProbeResult', {}); }

  async screenshot(file, options) {
    const target = path.isAbsolute(file) ? file : path.join(REPO, file);
    return this._send('screenshot', { file: target, ...(options || {}) }, 30000);
  }

  // ----------------------------------------------------------------- events
  /** Drain whatever the main process has pushed since the last drain. */
  async drainEvents() {
    const batch = await this._send('events', {});
    this._events.push(...batch);
    return batch;
  }

  /**
   * Wait until an event the main process pushed matches. Events are collected
   * in the page, so this is observing the real push, not a hook into ipc.js.
   */
  async waitForEvent(name, predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    const seen = this._events.filter((e) => e.event === name && (!predicate || predicate(e.payload)));
    if (seen.length) return seen[0].payload;
    while (Date.now() < deadline) {
      await this.drainEvents();
      const hit = this._events.find((e) => e.event === name && (!predicate || predicate(e.payload)));
      if (hit) return hit.payload;
      await new Promise((r) => setTimeout(r, 60));
    }
    // Name what DID arrive: "the event never came" and "the event came with a
    // payload the predicate did not expect" are very different bugs.
    const summary = this._events.map((e) => {
      const p = e.payload || {};
      const detail = [p.type, p.kind, p.item && p.item.id, p.item && p.item.state,
        p.error && (p.error.message || p.error)].filter(Boolean).join('/');
      return detail ? `${e.event}(${detail})` : e.event;
    });
    throw new Error(`Timed out waiting for ${name}. Seen: ${JSON.stringify(summary)}`);
  }

  /** Everything drained so far, for an assertion about what did NOT happen. */
  get seenEvents() { return this._events.slice(); }

  /** The on-disk configuration, as bytes — for "is the secret in there?". */
  readConfigBytes() { return fsp.readFile(this.configFile, 'utf8'); }
}

/**
 * Boot the application.
 *
 * @param {object} [options]
 * @param {string} [options.root]          data root; a fresh temp dir by default
 * @param {boolean} [options.keepRoot]     leave the root on disk after stop()
 * @param {number} [options.bootTimeoutMs]
 * @returns {Promise<AppUnderTest>}
 */
async function startApp(options = {}) {
  const root = options.root || await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-e2e-app-'));
  const app = new AppUnderTest({ ...options, root });
  await app.start();
  return app;
}

/** Stop anything still running. A backstop for a suite that failed mid-test. */
async function stopAll() {
  await Promise.all([...LIVE].map((a) => a.stop().catch(() => undefined)));
}

/**
 * Site data pointing at a live test server, with everything that would make the
 * test non-deterministic turned off.
 */
function siteFor(server, extra = {}) {
  return {
    name: extra.name || 'E2E SFTP',
    protocol: 'sftp',
    hostName: server.host,
    portNumber: server.port,
    userName: server.username,
    password: server.password,
    savePassword: true,
    // Never let an unrelated agent, key file or interactive method answer
    // first: the test is about the password path unless it says otherwise.
    tryAgent: false,
    authKI: false,
    sshNoUserAuth: false,
    publicKeyFile: '',
    timeout: 10,
    // A cached listing would hide a server-side change the test just made.
    cacheDirectories: false,
    // The site must not write its "last used directory" back into the store
    // under the test's feet.
    updateDirectories: false,
    ...extra,
  };
}

module.exports = {
  startApp,
  stopAll,
  startSftpServer,
  siteFor,
  AppUnderTest,
  REPO,
};
