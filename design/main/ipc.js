// ipc.js — the single IPC surface exposed to the renderer.
//
// Two rules, and every handler in this file obeys both:
//
//   1. NEVER THROW ACROSS THE BRIDGE. Every handler resolves to
//      { ok: true, value } or { ok: false, error: { message, code, detail } }.
//      An exception crossing the bridge arrives in the renderer as an opaque
//      "Error invoking remote method", which tells a user nothing and a
//      developer almost nothing.
//
//   2. THE RENDERER IS UNTRUSTED INPUT. It is our own code today, but it is
//      also the process that renders remote file names, remote directory
//      listings and server banners. Every argument is type-checked, every id is
//      looked up rather than trusted, every size is capped, and every path is
//      checked against the root it is supposed to be under.
//
// Modules owned by other parts of the port (queue, sync, find, masks) are
// required lazily. If one is missing the handler fails with a message naming
// the file — a stub that silently does nothing is far worse than an error.
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const { ipcMain, shell, clipboard, dialog, app, BrowserWindow } = require('electron');

const P = require('./paths');
const customcmd = require('./customcmd');
const dimsum = require('./dimsum');
const { SessionManager } = require('./session');
const { EditorManager } = require('./editors');
const { History } = require('./history');
const { Updates } = require('./updates');
const { AutoUpdater } = require('./autoupdate');

// ------------------------------------------------------------- envelopes

function ok(value) { return { ok: true, value: value === undefined ? null : value }; }

function err(e, code) {
  const message = e && e.message ? e.message : String(e);
  return {
    ok: false,
    error: {
      message,
      code: code || (e && e.code) || 'ERROR',
      detail: e && e.detail ? e.detail : undefined,
    },
  };
}

// ------------------------------------------------------------ validation

class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_ARGUMENT'; }
}

const LIMITS = {
  path: 4096,
  name: 1024,
  text: 8 * 1024 * 1024,      // an editor buffer
  command: 32 * 1024,
  list: 10000,                // items in an array argument
  small: 4096,
};

function need(cond, message) { if (!cond) throw new ValidationError(message); }

function str(v, label, max) {
  need(typeof v === 'string', `${label} must be a string.`);
  need(v.length <= (max || LIMITS.small), `${label} is too long (limit ${max || LIMITS.small}).`);
  // A NUL truncates a path in every native API underneath us.
  need(!v.includes('\0'), `${label} must not contain a null character.`);
  return v;
}

function optStr(v, label, max) { return v === undefined || v === null ? '' : str(v, label, max); }

function num(v, label, min, max) {
  need(typeof v === 'number' && Number.isFinite(v), `${label} must be a number.`);
  if (min !== undefined) need(v >= min, `${label} must be at least ${min}.`);
  if (max !== undefined) need(v <= max, `${label} must be at most ${max}.`);
  return v;
}

function bool(v, label) { need(typeof v === 'boolean', `${label} must be true or false.`); return v; }

function obj(v, label) {
  need(v !== null && typeof v === 'object' && !Array.isArray(v), `${label} must be an object.`);
  return v;
}

function optObj(v, label) { return v === undefined || v === null ? {} : obj(v, label); }

function arr(v, label, max) {
  need(Array.isArray(v), `${label} must be an array.`);
  need(v.length <= (max || LIMITS.list), `${label} has too many items (limit ${max || LIMITS.list}).`);
  return v;
}

function strArr(v, label, max) { return arr(v, label, max).map((x, i) => str(x, `${label}[${i}]`, LIMITS.path)); }

/**
 * A remote path from the renderer. Normalized through the adapter (which is
 * what actually defines the separator for this protocol) and then checked to
 * be inside the session's root — a listing that came back containing `../..`
 * must not be able to walk the panel out of the tree it is browsing.
 */
function remotePath(session, p, label) {
  const raw = str(p === undefined || p === null ? '/' : p, label || 'path', LIMITS.path);
  const adapter = session.adapter;
  need(adapter, 'The session is not connected.');
  const normalized = adapter.normalize(raw.startsWith('/') || adapter.sep !== '/' ? raw : adapter.join(session.state.remotePath || '/', raw));
  const root = adapter.normalize(session.data.rootDirectory || '/');
  if (root !== '/' && root !== '') {
    const inside = normalized === root || normalized.startsWith(root.endsWith('/') ? root : root + '/');
    need(inside, `The path is outside this session's root (${root}).`);
  }
  return normalized;
}

/**
 * A local path from the renderer. Absolute, real, and — when the session
 * declares a local root — inside it.
 */
function localPath(session, p, label) {
  const raw = str(p, label || 'localPath', LIMITS.path);
  const abs = path.resolve(raw);
  const root = session && session.data && session.data.localRootDirectory;
  if (root) {
    const base = path.resolve(root);
    const inside = abs === base || abs.startsWith(base + path.sep);
    need(inside, `The local path is outside this session's local root (${base}).`);
  }
  return abs;
}

// -------------------------------------------------- lazily owned modules

/**
 * Modules other agents own. Required on first use so a partially built tree
 * still runs everything that does not depend on the missing piece.
 */
function lazy(rel, describe) {
  let mod;
  let tried = false;
  return () => {
    if (tried) {
      if (mod) return mod;
      throw new Error(`${describe} is unavailable: design/main/${rel.slice(2)}.js could not be loaded.`);
    }
    tried = true;
    try {
      mod = require(rel);
    } catch (e) {
      mod = null;
      throw new Error(`${describe} is unavailable: design/main/${rel.slice(2)}.js could not be loaded (${e.message}).`);
    }
    return mod;
  };
}

const queueModule = lazy('./queue', 'The transfer queue');
const syncModule = lazy('./sync', 'Synchronization');
const findModule = lazy('./find', 'File search');
const masksModule = lazy('./masks', 'File-mask matching');
// The subsystems reconciled in this pass. Each was a complete, tested module
// that nothing imported; every one of them is reachable from here now, which is
// the difference between "ported" and "written" under docs/porting-mandate.md.
const messagesModule = lazy('./messages', "WinSCP's message resources");
const dirviewModule = lazy('./dirview', 'The file-panel model');
const patheditModule = lazy('./pathedit', 'The path edit and history model');
const explorerModule = lazy('./explorershell', 'The explorer shell');
const interfacesModule = lazy('./interfaces', 'The Commander and Explorer interfaces');
const uiModule = lazy('./userinterface', 'The user-interface contract');
const terminalModule = lazy('./terminal', 'The session terminal');
const transferModule = lazy('./transfer', 'The transfer engine');

/**
 * Drop the keys the renderer did not set, so a module's own defaults win
 * instead of being overwritten with `undefined`.
 */
function stripUndefined(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// ==================================================================== IPC

class Ipc {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {() => BrowserWindow|null} deps.getWindow
   * @param {string} deps.version
   */
  constructor(deps) {
    const d = deps || {};
    this.config = d.config;
    this.getWindow = d.getWindow || (() => BrowserWindow.getAllWindows()[0] || null);
    this.version = d.version || app.getVersion();

    /**
     * Everything the main process pushes goes through here, and only to the
     * window that is actually alive.
     *
     * `webContents.send` structure-clones its payload, and THROWS when it
     * cannot — on a function, a socket, an EventEmitter, a live adapter. That
     * throw propagates back into whatever emitted the event, which for a
     * background watcher or a queue pump means an unhandled exception that
     * takes the whole main process down. A push is a notification; it must
     * never be able to kill the app. So a payload that will not travel is
     * reported as a log line, which always will.
     */
    this.emit = (channel, payload) => {
      const w = this.getWindow();
      if (!w || w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) return;
      try {
        w.webContents.send(channel, payload);
      } catch (e) {
        if (process.env.WINSCP_MATERIAL_DEBUG) console.error(`[ipc] ${channel} payload could not be sent:`, e);
        // Never recurse: this second send carries strings only.
        try {
          w.webContents.send('event:log', {
            source: 'ipc',
            kind: 'error',
            text: `An internal ${channel} notification could not be delivered to the window: ${e && e.message ? e.message : String(e)}`,
          });
        } catch { /* the window is going away; there is nowhere left to report */ }
      }
    };

    this.sessions = new SessionManager({ config: this.config, emit: this.emit });
    this.editors = new EditorManager({ config: this.config, sessions: this.sessions, emit: this.emit });
    this.history = new History(P.history(), {
      getPrefs: () => (this.config ? this.config.prefs.versionHistory : {}),
    });
    this.updates = new Updates({ config: this.config, currentVersion: this.version, emit: this.emit });
    // Silent background updating, Chrome-style: it downloads and stages on its
    // own and never asks. `updates` above stays for the explicit "Check for
    // Updates…" command, which is the only path that reports anything.
    this.autoUpdate = new AutoUpdater({
      config: this.config,
      logger: (entry) => this.emit('event:log', { source: 'updater', ...entry }),
    });
    // Passive only — a surface may render this, nothing may interrupt over it.
    this.autoUpdate.on('state', (s) => this.emit('event:update-state', s));
    this.commands = new customcmd.CustomCommandRunner({
      onOutput: (o) => this.emit('event:console', o),
    });
    this.commands.on('finished', (o) => this.emit('event:console', { ...o, done: true }));

    // The transfer queue copies its settings out of the preferences ONCE, when
    // it is built — and it is built the first time anything asks for the queue
    // list, which the renderer does while it is still starting up. Every later
    // change to "Transfers limit", "Confirm overwrites", "Keep done items for"
    // and the rest therefore landed in the store and nowhere else: the setting
    // moved, the behaviour did not, until the app was restarted. Re-apply them
    // whenever the store changes, on every path that can change it.
    if (this.config && typeof this.config.on === 'function') {
      const publishConfig = () => this.emit('event:config', publicConfig(this.config));
      this.config.on('pref-changed', () => {
        this.refreshQueuePrefs();
        publishConfig();
      });
      // Site, folder and workspace mutations use this event. Publish the same
      // credential-free document as config:get so menus and toolbars refresh
      // immediately after a save instead of waiting for an app restart.
      this.config.on('sites-changed', publishConfig);
      this.config.on('changed', () => {
        this.refreshQueuePrefs();
        publishConfig();
      });
    }

    if (this.config && typeof this.config.attachHistory === 'function') {
      this.config.attachHistory({
        // config.js calls snapshot() synchronously and ignores the result; the
        // promise is swallowed here so a history failure can never surface as
        // an unhandled rejection in the middle of the user's save.
        snapshot: (label, state) => { this.history.snapshot(label, state).catch(() => undefined); },
      });
    }

    /** Lazily created queue/sync instances, one per app. */
    this._queue = null;
    this._sync = null;

    /**
     * The orchestration layer's own state.
     *
     * `_panels` is what the renderer pushes over `explorer:setPanels`; every
     * predicate ExplorerShell answers is derived from it, so the main process
     * never has to guess what the user has selected. `_asks` is the round trip
     * for a confirmation: a refusal ported from WinSCP is only a refusal if it
     * genuinely waits for an answer, so `ask()` returns a promise the renderer
     * settles over `ui:answer` and NEVER a default.
     */
    this._panels = { local: null, remote: null };
    this._asks = new Map();
    this._askSeq = 0;
    this._explorer = null;

    this._registered = [];
  }

  // ------------------------------------------------------------ plumbing
  handle(channel, fn) {
    const wrapped = async (_event, ...args) => {
      try {
        return ok(await fn(...args));
      } catch (e) {
        // Log it where a developer will see it; the renderer gets the envelope.
        if (process.env.WINSCP_MATERIAL_DEBUG) console.error(`[ipc] ${channel}:`, e);
        return err(e);
      }
    };
    ipcMain.handle(channel, wrapped);
    this._registered.push(channel);
  }

  get channels() { return this._registered.slice(); }

  session(id) { return this.sessions.require(str(id, 'sessionId', 128)); }

  /** The one transfer queue, created on first use and wired to the renderer. */
  queue() {
    if (this._queue) return this._queue;
    const mod = queueModule();
    if (typeof mod.TransferQueue !== 'function') throw new Error('design/main/queue.js does not export TransferQueue.');
    const q = new mod.TransferQueue({ prefs: this.config ? this.config.prefs : undefined });

    // Every queue event becomes one renderer event, with the internals left
    // behind: `view()` is the only shape that crosses the bridge.
    //
    // This list has to be the events design/main/queue.js ACTUALLY emits.
    // `item-removed`, `item-state` and `once-done` were never emitted by
    // anything, and `item-updated` — which is every state change, every
    // pause, every resume and every removal — was not forwarded at all, so a
    // queue panel driven by these events could only ever see an item appear
    // and then, much later, finish.
    for (const ev of ['item-added', 'item-updated', 'item-done', 'item-error',
      'queue-updated', 'idle', 'reconnect-expired']) {
      q.on(ev, (payload, extra) => this.emit('event:queue', { type: ev, item: payload, extra }));
    }
    q.on('progress', (item) => this.emit('event:progress', { kind: 'transfer', item }));

    // `reconnect` is NOT in that list, and must not be put back into it.
    //
    // Its payload carries the live `retry`/`fail` callbacks the queue item is
    // blocked on, and `emit` above structure-clones — a function makes
    // webContents.send throw, emit swallows that as an undeliverable push, and
    // the item is then awaiting a promise that nothing in this process can ever
    // settle. Worse, queue.js checks `listenerCount('reconnect')` BEFORE
    // emitting and skips its own unsupervised backoff when anything is
    // listening, so the blanket forwarder simultaneously took the decision and
    // failed to make it: the FIRST dropped connection parked a queued transfer
    // for the lifetime of the process, holding one of the `transfersLimit`
    // slots with it. The reconnect budget this file now feeds the queue is only
    // reachable because something here actually answers.
    //
    // This is WinSCP's TTerminal::QueryReopen seam. It answers Retry rather
    // than asking, because an unattended queue must recover from a dropped
    // connection on its own (the same reasoning terminal.js:1308 records for
    // the timeout answer); the user's Abort is closing the session, which
    // removes it from the manager and is what `fail()` reports here.
    q.on('reconnect', (e) => {
      const message = e && e.error
        ? String(e.error.message || e.error) : 'The connection was lost.';
      this.emit('event:queue', {
        type: 'reconnect',
        item: e && e.item,
        extra: { attempt: e && e.attempt, error: message },
      });
      const session = e && e.session;
      if (!session || !session.id || !this.sessions.get(session.id)) { e.fail(); return; }
      // security.sessionReopenBackground — "ms between attempts for a session
      // with queued work" (session.js:534), shorter than sessionReopenAuto
      // because something is waiting. docs/sessions-and-sites/reconnection.md
      // has promised this behaviour since it was written; nothing read the
      // preference. The session's own timer is reconnecting in parallel — this
      // is how long the QUEUE waits before touching the adapter again. Whether
      // there is a round after this one is the item's SessionReopenTimeout
      // budget's decision, not a count kept out here.
      const sec = (this.config && this.config.prefs.security) || {};
      const delay = Math.max(0, Number(sec.sessionReopenBackground) || 0);
      const timer = setTimeout(() => e.retry(), delay);
      // A pending reconnect must not be the reason the process stays alive.
      if (typeof timer.unref === 'function') timer.unref();
    });

    // A query or a prompt from inside a transfer is a decision the user must
    // make; it goes out on the prompt channel like every other one.
    //
    // queue.js emits ONE object — `{ item, query, respond }` — and `respond` is
    // a live function. Forwarding that object as the correlation id put a
    // function into a structured clone, so the event never reached the window:
    // the transfer sat in `query` forever with nobody able to answer it. The id
    // the renderer hands back to queue:answerQuery is the ITEM's id, so that is
    // what crosses as `promptId`, and only cloneable data goes with it.
    q.on('query', (e) => this.emit('event:prompt', {
      promptId: e && e.item ? e.item.id : '',
      kind: 'custom',
      payload: { source: 'queue', item: e && e.item, query: e && e.query },
    }));
    q.on('prompt', (e) => this.emit('event:prompt', {
      promptId: e && e.item ? e.item.id : '',
      kind: 'password',
      payload: { source: 'queue', item: e && e.item, prompt: e && e.prompt },
    }));

    this._queue = q;
    return q;
  }

  /**
   * Push the current preferences into a queue that is already running.
   *
   * Only the settings the queue reads out of `queuePrefs` are replaced; the
   * things that are RUNTIME state rather than preference — whether the queue is
   * enabled, whether it is paused, what is in it — are left exactly as the user
   * left them. A preference change must not restart a paused transfer.
   */
  refreshQueuePrefs() {
    const q = this._queue;
    if (!q || !this.config) return false;
    const prefs = this.config.prefs;
    q.prefs = prefs;
    q.queuePrefs = { ...q.queuePrefs, ...(prefs.queue || {}) };
    const limit = Number(prefs.queue && prefs.queue.transfersLimit);
    if (Number.isFinite(limit) && limit >= 1 && limit <= 32 && typeof q.setTransfersLimit === 'function') {
      try { q.setTransfersLimit(limit); } catch { /* the queue keeps the limit it was running with */ }
    }
    return true;
  }

  /** sync.js is a module of functions rather than a class; use it as one. */
  sync() {
    if (this._sync) return this._sync;
    this._sync = syncModule();
    return this._sync;
  }

  /** The local-side adapter every transfer needs on one end. */
  localAdapter() {
    if (this._local) return this._local;
    let mod;
    try { mod = require('./protocols/local'); } catch (e) {
      throw new Error(`The local backend is unavailable: design/main/protocols/local.js could not be loaded (${e.message}).`);
    }
    if (typeof mod.LocalAdapter !== 'function') throw new Error('design/main/protocols/local.js does not export LocalAdapter.');
    this._local = new mod.LocalAdapter({});
    this._local.connected = true;
    return this._local;
  }

  /**
   * Ask the user a question and WAIT for the answer.
   *
   * This is the seam every ported refusal hangs off. WinSCP's confirmations are
   * modal VCL dialogs; here they are a promise the renderer settles. What must
   * never happen is a default: answering "yes" on the renderer's behalf is a
   * data-loss bug and answering "no" is an invisible one, so an unanswered
   * question stays unanswered until the window that was asked goes away, at
   * which point it resolves to `cancel` — the only answer that is safe when
   * nobody is listening.
   *
   * @param {object} request  { kind, message, moreMessages, answers, ... }
   * @returns {Promise<string>} one of the answer names the request offered
   */
  ask(request) {
    const w = this.getWindow();
    if (!w || w.isDestroyed()) return Promise.resolve('cancel');
    this._askSeq += 1;
    const promptId = `ask-${Date.now().toString(36)}-${this._askSeq.toString(36)}`;
    return new Promise((resolve) => {
      this._asks.set(promptId, resolve);
      this.emit('event:prompt', {
        promptId,
        kind: 'question',
        payload: { source: 'shell', ...request },
      });
    });
  }

  /** Settle a pending `ask`. Returns false when the question is already gone. */
  answerAsk(promptId, answer) {
    const resolve = this._asks.get(promptId);
    if (!resolve) return false;
    this._asks.delete(promptId);
    resolve(answer);
    return true;
  }

  /** The one ExplorerShell, built over the live session manager and queue. */
  explorer() {
    if (this._explorer) return this._explorer;
    const mod = explorerModule();
    if (typeof mod.ExplorerShell !== 'function') {
      throw new Error('design/main/explorershell.js does not export ExplorerShell.');
    }
    this._explorer = new mod.ExplorerShell({
      config: this.config,
      ask: (request) => this.ask(request),
      note: (n) => this.emit('event:notify', { source: 'shell', ...n }),
      panels: (side) => this._panels[side === 'local' ? 'local' : 'remote'],
      session: () => this.sessions.active(),
      sessions: () => this.sessions.all(),
      setActiveSession: (s) => this.sessions.setActive(s && s.id ? s.id : s),
      queue: this.queue(),
      editors: this.editors,
      clipboard: {
        readText: () => clipboard.readText(),
        writeText: (t) => clipboard.writeText(String(t)),
      },
      ops: this.explorerOps(),
    });
    return this._explorer;
  }

  /**
   * The operations ExplorerShell decides about but does not perform.
   *
   * Anything absent stays absent: the module throws `NotSupportedError` for an
   * operation it has no implementation for, which is the honest outcome — a
   * silent no-op would report success for work that never happened.
   */
  explorerOps() {
    const remoteAdapter = () => {
      const s = this.sessions.active();
      need(s && s.adapter && s.adapter.connected, 'The session is not connected.');
      return { s, a: s.adapter };
    };
    return {
      directoryExists: async (side, p) => {
        if (side === 'local') { try { return (await fsp.stat(path.resolve(p))).isDirectory(); } catch { return false; } }
        const { a } = remoteAdapter();
        try { return (await a.stat(a.normalize(p))).type === 'dir'; } catch { return false; }
      },
      createDirectory: async (side, p) => {
        if (side === 'local') { await fsp.mkdir(path.resolve(p), { recursive: true }); return path.resolve(p); }
        const { s, a } = remoteAdapter();
        const target = a.normalize(p);
        await a.mkdir(target);
        s.invalidate(a.dirname(target));
        return target;
      },
      deleteFiles: async (files, options) => {
        const { s, a } = remoteAdapter();
        const o = options || {};
        const removed = [];
        for (const f of files) {
          await a.remove(a.normalize(f), { recursive: true, toRecycleBin: !!o.toRecycleBin });
          s.log.actions.record('rm', { filename: f });
          removed.push(f);
        }
        s.invalidate();
        return removed;
      },
      deleteLocalFiles: async (files, options) => {
        const o = options || {};
        const removed = [];
        for (const f of files) {
          const full = path.resolve(f);
          if (o.toRecycleBin !== false) await shell.trashItem(full);
          else await fsp.rm(full, { recursive: true, force: false });
          removed.push(full);
        }
        return removed;
      },
      moveFiles: async (files, target) => {
        const { s, a } = remoteAdapter();
        for (const f of files) {
          const dst = a.join(a.normalize(target), a.basename(f));
          await a.rename(a.normalize(f), dst);
          s.log.actions.record('mv', { filename: f, destination: dst });
        }
        s.invalidate();
        return files.length;
      },
      lockFiles: async (files) => {
        const { a } = remoteAdapter();
        for (const f of files) await a.lockFile(a.normalize(f));
        return files.length;
      },
      unlockFiles: async (files) => {
        const { a } = remoteAdapter();
        for (const f of files) await a.unlockFile(a.normalize(f));
        return files.length;
      },
      changePath: (side, p) => {
        const s = this.sessions.active();
        if (!s) return false;
        s.setState(side === 'local' ? { localPath: path.resolve(p) } : { remotePath: p });
        this.emit('event:session', { type: 'path', sessionId: s.id, side, path: p });
        return true;
      },
      closeSession: (session) => this.sessions.close(session && session.id ? session.id : String(session)),
      disconnectSession: async (session) => {
        const s = session && session.id ? session : this.sessions.active();
        if (!s) return false;
        await s.disconnect({ keepOpen: true });
        return true;
      },
      saveWorkspace: (name, sessions) => {
        need(this.config, 'The configuration store is not available.');
        return this.config.saveWorkspace(String(name),
          sessions === undefined ? this.sessions.snapshotWorkspace() : sessions);
      },
      // The transfer path. Both directions go through the queue, which is the
      // one byte mover in this application (see queue.moveBytes).
      copyToRemote: (files, target, copyParam) =>
        this.enqueueTransfer('upload', files, target, copyParam),
      copyToLocal: (files, target, copyParam) =>
        this.enqueueTransfer('download', files, target, copyParam),
      customCommand: (line, options) => {
        const o = options || {};
        return o.local
          ? this.commands.runLocal(line, { cwd: o.cwd })
          : this.commands.runRemote(this.sessions.active(), line, {});
      },
    };
  }

  /** Queue a transfer the way `queue:add` does, from inside the main process. */
  enqueueTransfer(direction, files, target, copyParam) {
    const session = this.sessions.active();
    need(session, 'There is no active session.');
    const q = this.queue();
    const local = this.localAdapter();
    const remote = session.adapter;
    need(remote && remote.connected, 'The session is not connected.');
    const added = [];
    for (const f of files) {
      added.push(q.view(q.add(direction === 'upload'
        ? {
          side: 'upload',
          source: path.resolve(f),
          target,
          targetIsDir: true,
          sourceAdapter: local,
          targetAdapter: remote,
          copyParam,
          session,
        }
        : {
          side: 'download',
          source: f,
          target: path.resolve(target),
          targetIsDir: true,
          sourceAdapter: remote,
          targetAdapter: local,
          copyParam,
          session,
        })));
    }
    return added;
  }

  /**
   * The session's Terminal, with the queue wired in as its byte mover.
   *
   * This is what closes the transfer half's reachability gap: `transfer.js`
   * decides and `queue.js` moves, and the two are joined here rather than each
   * growing its own copy of the other's job.
   */
  terminalFor(session) {
    let t = session.__terminal;
    if (!t) {
      const mod = terminalModule();
      if (typeof mod.Terminal !== 'function') throw new Error('design/main/terminal.js does not export Terminal.');
      t = new mod.Terminal(session, {
        config: this.config,
        queryUser: async (query) => this.ask({ kind: 'terminal', sessionId: session.id, ...query }),
        // `p` is the LIVE OperationProgress, and its two callbacks are own
        // properties — so webContents.send's structured clone refuses the whole
        // payload, emit() swallows the DataCloneError as an undeliverable push,
        // and a foreground transfer reports nothing at all while it runs.
        // snapshot() is the shape that was written to cross the bridge
        // (terminal.js OperationProgress::snapshot), so send that.
        onProgress: (p) => this.emit('event:progress', {
          kind: 'operation',
          sessionId: session.id,
          progress: (p && typeof p.snapshot === 'function') ? p.snapshot() : p,
        }),
      });
      Object.defineProperty(session, '__terminal', {
        value: t, enumerable: false, configurable: true, writable: true,
      });
    }
    // The byte mover is attached on EVERY path through here, not only on the
    // one that constructs. terminal.js exports its own terminalFor() that sets
    // session.__terminal WITHOUT it; anything reaching that one first would
    // leave an early return handing back an engine whose every Source/Sink
    // throws "this transfer engine has no byte mover". transferEngineFor()
    // re-supplies late dependencies rather than building a second engine, so
    // paying for this on each call costs two assignments and closes the hole.
    t.transferEngine({
      localAdapter: this.localAdapter(),
      copyBytes: (plan) => this.queue().moveBytes(plan),
    });
    return t;
  }

  // =========================================================== registration
  registerAll() {
    this.registerApp();
    this.registerConfig();
    this.registerSession();
    this.registerFs();
    this.registerQueue();
    this.registerSync();
    this.registerEditor();
    this.registerHistory();
    this.registerMessages();
    this.registerPanel();
    this.registerExplorer();
    this.registerInterface();
    this.registerUi();
    this.registerTransfer();
    return this.channels;
  }

  dispose() {
    for (const c of this._registered) ipcMain.removeHandler(c);
    this._registered.length = 0;
    // A pending confirmation whose window is going away must not leave the
    // operation that asked it parked on a promise nobody can settle.
    for (const resolve of this._asks.values()) resolve('cancel');
    this._asks.clear();
  }

  // ------------------------------------------------------------- app:*
  registerApp() {
    this.handle('app:info', () => ({
      name: app.getName(),
      version: this.version,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale ? app.getLocale() : 'en',
      paths: { root: P.root(), logs: P.logs(), temp: P.temp(), history: P.history(), themes: P.themes() },
      firstRun: !fs.existsSync(P.config()),
    }));

    this.handle('app:quit', () => { app.quit(); return true; });

    this.handle('app:window', (action) => {
      const a = str(action, 'action', 32);
      const w = this.getWindow();
      if (!w) throw new Error('There is no window to act on.');
      switch (a) {
        case 'minimize': w.minimize(); break;
        case 'maximize': w.maximize(); break;
        case 'unmaximize': w.unmaximize(); break;
        case 'toggle-maximize': if (w.isMaximized()) w.unmaximize(); else w.maximize(); break;
        case 'close': w.close(); break;
        case 'fullscreen': w.setFullScreen(!w.isFullScreen()); break;
        default: throw new ValidationError(`Unknown window action: ${a}`);
      }
      return { maximized: w.isMaximized(), fullScreen: w.isFullScreen() };
    });

    this.handle('app:windowState', () => {
      const w = this.getWindow();
      if (!w) return { maximized: false, fullScreen: false, focused: false };
      return { maximized: w.isMaximized(), fullScreen: w.isFullScreen(), focused: w.isFocused() };
    });

    this.handle('app:openExternal', async (url) => {
      const u = str(url, 'url', LIMITS.path);
      // Only ever hand the OS a scheme that cannot run a local program.
      const parsed = new URL(u);
      need(['https:', 'http:', 'mailto:'].includes(parsed.protocol), 'Only http, https and mailto links can be opened.');
      await shell.openExternal(u);
      return true;
    });

    this.handle('app:showItemInFolder', (p) => {
      shell.showItemInFolder(path.resolve(str(p, 'path', LIMITS.path)));
      return true;
    });

    this.handle('app:clipboardWrite', (text) => {
      clipboard.writeText(str(text, 'text', LIMITS.text));
      return true;
    });

    this.handle('app:clipboardRead', () => clipboard.readText());

    this.handle('app:pickPath', async (options) => {
      const o = optObj(options, 'options');
      const w = this.getWindow();
      const props = [];
      if (o.directory) props.push('openDirectory'); else props.push('openFile');
      if (o.multiple) props.push('multiSelections');
      if (o.save) {
        const r = await dialog.showSaveDialog(w, {
          title: optStr(o.title, 'title', 256) || undefined,
          defaultPath: o.defaultPath ? path.resolve(str(o.defaultPath, 'defaultPath', LIMITS.path)) : undefined,
        });
        return r.canceled ? null : [r.filePath];
      }
      const r = await dialog.showOpenDialog(w, {
        title: optStr(o.title, 'title', 256) || undefined,
        defaultPath: o.defaultPath ? path.resolve(str(o.defaultPath, 'defaultPath', LIMITS.path)) : undefined,
        properties: props,
        filters: Array.isArray(o.filters) ? o.filters.slice(0, 20) : undefined,
      });
      return r.canceled ? null : r.filePaths;
    });

    // ---- dim sum ----------------------------------------------------
    this.handle('app:dimsum', (options) => {
      const o = optObj(options, 'options');
      const prefs = this.config ? this.config.prefs.dimSum : { seen: [] };
      // One fresh draw per launch, decided by the caller (main.js) — the
      // renderer asking twice must not get two chances.
      const dish = dimsum.pick(o.excludeSeen === false ? [] : (prefs.seen || []));
      if (!dish) return null;
      return { ...dish, dataUri: dimsum.dataUri(dish.id), status: dimsum.status() };
    });

    this.handle('app:dimsumSeen', (id) => {
      const i = str(id, 'id', 32);
      if (!this.config) return false;
      const seen = (this.config.prefs.dimSum.seen || []).filter((x) => x !== i);
      seen.push(i);
      this.config.setPrefs({ dimSum: { seen: seen.slice(-500), lastShownLaunch: Date.now() } });
      return true;
    });

    this.handle('app:codeName', (used) => {
      const list = used === undefined ? [] : strArr(used, 'used', 5000);
      const c = dimsum.codeName(list);
      return c ? { ...c, dataUri: dimsum.dataUri(c.id) } : null;
    });

    this.handle('app:catalog', () => ({ status: dimsum.status(), items: dimsum.catalog().map((d) => ({ id: d.id, en: d.en, zh: d.zh, file: d.file })) }));

    // ---- updates ----------------------------------------------------
    this.handle('app:checkUpdates', (options) => this.updates.check({ ...optObj(options, 'options'), reason: 'user' }));
    this.handle('app:lastUpdateResult', () => this.updates.lastResult());
    // Read-only view of the silent updater, for a passive indicator.
    this.handle('app:updateState', () => this.autoUpdate.snapshot());
    // Applying is user-initiated only. Nothing calls this on a timer, and
    // nothing calls it because an update merely became ready.
    this.handle('app:applyUpdateAndRestart', () => this.autoUpdate.applyAndRestart());

    // ---- custom commands --------------------------------------------
    this.handle('app:customCommandPrompts', (command, options) => {
      const c = str(command, 'command', LIMITS.command);
      const o = optObj(options, 'options');
      return {
        prompts: customcmd.collectPrompts(c, { local: !!o.local }),
        execs: customcmd.collectExecs(c, { local: !!o.local }),
        isFileCommand: customcmd.isFileCommand(c, { local: !!o.local }),
        isFileListCommand: customcmd.isFileListCommand(c, { local: !!o.local }),
        isSiteCommand: customcmd.isSiteCommand(c, { local: !!o.local }),
      };
    });

    this.handle('app:customCommandPreview', (command, req) => {
      const c = str(command, 'command', LIMITS.command);
      const r = optObj(req, 'request');
      const session = r.sessionId ? this.session(r.sessionId) : null;
      const data = session ? session.data : {};
      // A PREVIEW never resolves !P: showing the password on screen because
      // someone clicked "preview" is exactly the leak this feature invites.
      return customcmd.expand(c, { ...data, password: '' }, buildCommandContext(session, r), {
        local: !!r.local,
        answers: optObj(r.answers, 'answers'),
        execResults: optObj(r.execResults, 'execResults'),
      });
    });

    this.handle('app:runCustomCommand', async (req) => {
      const r = obj(req, 'request');
      const command = str(r.command, 'command', LIMITS.command);
      const local = !!r.local;
      customcmd.validate(command, { local });

      const session = r.sessionId ? this.session(r.sessionId) : null;
      const ctx = buildCommandContext(session, r);
      const data = session ? session.data : {};
      const line = customcmd.expand(command, data, ctx, {
        local,
        answers: optObj(r.answers, 'answers'),
        execResults: optObj(r.execResults, 'execResults'),
      });

      const secrets = [data.password, data.passphrase].filter(Boolean);
      if (session) session.log.add('info', `Custom command: ${customcmd.redactForLog(line, secrets)}`);

      const result = local
        ? await this.commands.runLocal(line, { cwd: r.cwd ? path.resolve(str(r.cwd, 'cwd', LIMITS.path)) : undefined, secrets })
        : await this.commands.runRemote(session, line, { secrets });

      if (r.copyResults) clipboard.writeText(result.output);
      return {
        ...result,
        // The command line is echoed back for the console panel — redacted,
        // because `!P` may well have expanded into it.
        command: customcmd.redactForLog(line, secrets),
        showResults: !!r.showResults,
      };
    });

    this.handle('app:cancelCustomCommand', (id) => this.commands.cancel(str(id, 'id', 64)));

    // ---- masks (the regex builder and the mask editor both use this) ----
    this.handle('app:maskMatches', (mask, name, options) => {
      const mod = masksModule();
      need(typeof mod.FileMask === 'function', 'design/main/masks.js does not export the FileMask matcher.');
      const o = optObj(options, 'options');
      const m = new mod.FileMask(str(mask, 'mask', LIMITS.small));
      return m.matches(str(name, 'name', LIMITS.path), {
        isDir: o.isDir === true,
        path: optStr(o.path, 'options.path', LIMITS.path) || undefined,
        size: o.size === undefined ? undefined : num(o.size, 'options.size', 0),
        mtime: o.mtime === undefined ? undefined : num(o.mtime, 'options.mtime', 0),
      });
    });

    /** Validate a mask before it is saved, so a bad one is caught in the editor. */
    this.handle('app:maskValidate', (mask) => {
      const mod = masksModule();
      const source = str(mask, 'mask', LIMITS.small);
      try {
        if (typeof mod.validate === 'function') mod.validate(source);
        else new mod.FileMask(source);
        return { valid: true, error: '' };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    });
  }

  // ---------------------------------------------------------- config:*
  registerConfig() {
    const cfg = () => {
      need(this.config, 'The configuration store is not available.');
      return this.config;
    };

    this.handle('config:get', () => publicConfig(cfg()));

    this.handle('config:getPref', (dotted) => cfg().getPref(str(dotted, 'preference', 256)));

    this.handle('config:setPref', (dotted, value, label) => {
      const key = str(dotted, 'preference', 256);
      need(value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value), 'The value has an unsupported type.');
      need(JSON.stringify(value === undefined ? null : value).length <= 2 * 1024 * 1024, 'The value is too large.');
      return cfg().setPref(key, value, optStr(label, 'label', 256) || undefined);
    });

    this.handle('config:setPrefs', (patch, label) => {
      const p = obj(patch, 'patch');
      need(JSON.stringify(p).length <= 4 * 1024 * 1024, 'The patch is too large.');
      cfg().setPrefs(p, optStr(label, 'label', 256) || undefined);
      return true;
    });

    this.handle('config:sites', () => cfg().sites.map(publicSite));
    this.handle('config:site', (id) => { const s = cfg().siteById(str(id, 'id', 128)); return s ? publicSite(s) : null; });

    this.handle('config:siteAdd', (site) => publicSite(cfg().addSite(validateSite(site))));
    this.handle('config:siteUpdate', (id, patch) => {
      const s = cfg().updateSite(str(id, 'id', 128), validateSite(patch, true));
      need(s, 'No such site.');
      return publicSite(s);
    });
    this.handle('config:siteRemove', (id) => cfg().removeSite(str(id, 'id', 128)));
    this.handle('config:siteDuplicate', (id, name) => {
      const s = cfg().duplicateSite(str(id, 'id', 128), optStr(name, 'name', LIMITS.name) || undefined);
      need(s, 'No such site.');
      return publicSite(s);
    });
    this.handle('config:siteMove', (id, folder) => {
      const s = cfg().moveSite(str(id, 'id', 128), optStr(folder, 'folder', LIMITS.path));
      return s ? publicSite(s) : null;
    });

    this.handle('config:folderAdd', (p) => cfg().addFolder(str(p, 'folder', LIMITS.path)));
    this.handle('config:folderRename', (from, to) => cfg().renameFolder(str(from, 'from', LIMITS.path), str(to, 'to', LIMITS.path)));
    this.handle('config:folderRemove', (p, deleteSites) => cfg().removeFolder(str(p, 'folder', LIMITS.path), deleteSites === true));

    this.handle('config:workspaceSave', (name, sessions) => cfg().saveWorkspace(
      str(name, 'name', LIMITS.name),
      sessions === undefined ? this.sessions.snapshotWorkspace() : arr(sessions, 'sessions', 200)));
    this.handle('config:workspaceRemove', (name) => cfg().removeWorkspace(str(name, 'name', LIMITS.name)));
    this.handle('config:workspaces', () => cfg().data.workspaces);

    this.handle('config:bookmarks', (key) => cfg().bookmarksFor(str(key, 'key', LIMITS.name)));
    this.handle('config:bookmarkAdd', (key, side, value, name) => {
      const s = str(side, 'side', 16);
      need(s === 'local' || s === 'remote', 'side must be "local" or "remote".');
      cfg().addBookmark(str(key, 'key', LIMITS.name), s, str(value, 'value', LIMITS.path), optStr(name, 'name', LIMITS.name));
      return true;
    });
    this.handle('config:bookmarkRemove', (key, side, value) => {
      const s = str(side, 'side', 16);
      need(s === 'local' || s === 'remote', 'side must be "local" or "remote".');
      cfg().removeBookmark(str(key, 'key', LIMITS.name), s, str(value, 'value', LIMITS.path));
      return true;
    });

    this.handle('config:historyPush', (key, value) => { cfg().pushHistory(str(key, 'key', LIMITS.name), str(value, 'value', LIMITS.path)); return true; });
    this.handle('config:historyClear', (key) => { cfg().clearHistory(key === undefined ? undefined : str(key, 'key', LIMITS.name)); return true; });

    this.handle('config:hostKeys', () => cfg().data.hostKeys);
    this.handle('config:forgetHostKey', (hostPort) => { cfg().forgetHostKey(str(hostPort, 'hostPort', LIMITS.name)); return true; });

    // ---- master password -------------------------------------------
    // The password itself is never echoed back and never logged. These
    // handlers return a boolean, deliberately: "wrong password" and nothing
    // more, so a caller cannot probe for detail.
    this.handle('config:masterEnable', (password) => cfg().enableMasterPassword(str(password, 'password', 1024)));
    this.handle('config:masterChange', (oldPassword, newPassword) =>
      cfg().changeMasterPassword(str(oldPassword, 'password', 1024), str(newPassword, 'newPassword', 1024)));
    this.handle('config:masterDisable', (password) => cfg().disableMasterPassword(str(password, 'password', 1024)));
    this.handle('config:unlock', (password) => cfg().unlock(str(password, 'password', 1024)));
    this.handle('config:needsUnlock', () => cfg().needsUnlock());

    this.handle('config:flush', () => { cfg().flush(); return true; });

    this.handle('config:export', async (file) => {
      const target = path.resolve(str(file, 'file', LIMITS.path));
      // Secrets are exported in their PROTECTED form, never in clear: an
      // exported config is a file people email to themselves.
      const state = cfg().exportState();
      await fsp.writeFile(target, JSON.stringify(state, null, 2), 'utf8');
      return target;
    });

    this.handle('config:import', async (file, label) => {
      const source = path.resolve(str(file, 'file', LIMITS.path));
      const st = await fsp.stat(source);
      need(st.size <= 32 * 1024 * 1024, 'The configuration file is too large.');
      const state = JSON.parse(await fsp.readFile(source, 'utf8'));
      obj(state, 'configuration');
      cfg().importState(state, optStr(label, 'label', 256) || `Imported settings from ${path.basename(source)}`);
      return true;
    });
  }

  // --------------------------------------------------------- session:*
  registerSession() {
    this.handle('session:open', async (req) => {
      const r = obj(req, 'request');
      const s = await this.sessions.open(
        r.siteId ? str(r.siteId, 'siteId', 128) : validateSite(r.data || r.session),
        { connect: r.connect !== false });
      return s.info();
    });

    this.handle('session:list', () => this.sessions.list());
    this.handle('session:info', (id) => this.session(id).info());
    this.handle('session:close', (id) => this.sessions.close(str(id, 'sessionId', 128)));
    this.handle('session:reconnect', async (id) => (await this.session(id).reconnect()));
    // Disconnect is not Close. WinSCP's "Disconnect Session" leaves the tab
    // sitting there so "Reconnect Session" has something to reconnect; retiring
    // the session here made the very next command answer "No such session".
    this.handle('session:disconnect', async (id) => { await this.session(id).disconnect({ keepOpen: true }); return true; });

    this.handle('session:answerPrompt', (sessionId, promptId, answer) => {
      const s = this.session(sessionId);
      const pid = str(promptId, 'promptId', 128);
      // The answer shape is validated per prompt kind so a malformed reply
      // cannot be mistaken for consent.
      const a = answer === null || answer === undefined ? null : obj(answer, 'answer');
      if (a && a.results !== undefined) strArr(a.results, 'answer.results', 32);
      if (a && a.accept !== undefined) bool(a.accept, 'answer.accept');
      if (a && a.remember !== undefined) bool(a.remember, 'answer.remember');
      return s.answerPrompt(pid, a);
    });

    this.handle('session:setState', (id, patch) => this.session(id).setState(optObj(patch, 'patch')));
    this.handle('session:getState', (id) => this.session(id).getState());

    this.handle('session:url', (id, flags) => this.session(id).generateUrl(optObj(flags, 'flags')));
    this.handle('session:code', (id, kind, flags) =>
      this.session(id).generateCode(optStr(kind, 'kind', 32) || 'url', optObj(flags, 'flags')));

    this.handle('session:fsInfo', (id, spacePath) => {
      const s = this.session(id);
      return s.fileSystemInfo(spacePath === undefined ? undefined : remotePath(s, spacePath, 'path'));
    });

    this.handle('session:changePassword', async (id, oldPassword, newPassword) => {
      const s = this.session(id);
      return s.changePassword(str(oldPassword, 'password', 1024), str(newPassword, 'newPassword', 1024));
    });

    this.handle('session:exec', async (id, command, options) => {
      const s = this.session(id);
      return s.exec(str(command, 'command', LIMITS.command), optObj(options, 'options'));
    });

    this.handle('session:log', (id, since) => {
      const s = this.session(id);
      return { lines: s.log.window(since === undefined ? 0 : num(since, 'since', 0)), fileName: s.log.fileName };
    });
    this.handle('session:logClear', (id) => { this.session(id).log.clearWindow(); return true; });
    this.handle('session:logText', (id) => this.session(id).log.toText());

    this.handle('session:clearCache', (id, p) => {
      const s = this.session(id);
      if (p === undefined) s.clearCache(); else s.invalidate(remotePath(s, p, 'path'));
      return true;
    });
    this.handle('session:cacheInfo', (id) => this.session(id).cacheInfo());
  }

  // -------------------------------------------------------------- fs:*
  registerFs() {
    const adapterOf = (id) => {
      const s = this.session(id);
      need(s.adapter && s.adapter.connected, 'The session is not connected.');
      return { s, a: s.adapter };
    };
    const capable = (a, cap, what) => {
      need(a.caps[cap], `${a.protocolName} does not support ${what}.`);
    };

    this.handle('fs:list', async (id, p, options) => {
      const { s } = adapterOf(id);
      const o = optObj(options, 'options');
      return s.list(remotePath(s, p, 'path'), { refresh: o.refresh === true });
    });

    this.handle('fs:stat', async (id, p) => {
      const { s, a } = adapterOf(id);
      return a.stat(remotePath(s, p, 'path'));
    });

    this.handle('fs:realpath', async (id, p) => {
      const { s, a } = adapterOf(id);
      return a.realpath(remotePath(s, p, 'path'));
    });

    this.handle('fs:readlink', async (id, p) => {
      const { s, a } = adapterOf(id);
      capable(a, 'symlink', 'symbolic links');
      return a.readlink(remotePath(s, p, 'path'));
    });

    this.handle('fs:mkdir', async (id, p) => {
      const { s, a } = adapterOf(id);
      const target = remotePath(s, p, 'path');
      await a.mkdir(target);
      s.invalidate(a.dirname(target));
      s.log.actions.record('mkdir', { filename: target });
      return target;
    });

    this.handle('fs:remove', async (id, paths, options) => {
      const { s, a } = adapterOf(id);
      const o = optObj(options, 'options');
      const list = strArr(paths, 'paths', 20000).map((x) => remotePath(s, x, 'path'));
      const removed = [];
      const failed = [];
      for (const target of list) {
        try {
          await a.remove(target, { recursive: o.recursive !== false, toRecycleBin: o.toRecycleBin === true });
          removed.push(target);
          s.log.actions.record('rm', { filename: target });
        } catch (e) {
          failed.push({ path: target, message: e.message });
          if (!this.config || !this.config.prefs.continueOnError) break;
        }
      }
      s.invalidate();
      return { removed, failed };
    });

    this.handle('fs:rename', async (id, from, to) => {
      const { s, a } = adapterOf(id);
      capable(a, 'rename', 'renaming');
      const src = remotePath(s, from, 'from');
      const dst = remotePath(s, to, 'to');
      await a.rename(src, dst);
      s.invalidate(a.dirname(src));
      s.invalidate(a.dirname(dst));
      s.log.actions.record('mv', { filename: src, destination: dst });
      return dst;
    });

    this.handle('fs:symlink', async (id, target, linkPath, hard) => {
      const { s, a } = adapterOf(id);
      capable(a, hard === true ? 'hardlink' : 'symlink', hard === true ? 'hard links' : 'symbolic links');
      const link = remotePath(s, linkPath, 'linkPath');
      await a.symlink(str(target, 'target', LIMITS.path), link, hard === true);
      s.invalidate(a.dirname(link));
      return link;
    });

    this.handle('fs:setRights', async (id, paths, rights, options) => {
      const { s, a } = adapterOf(id);
      capable(a, 'rights', 'permissions');
      const o = optObj(options, 'options');
      const r = str(rights, 'rights', 16);
      need(/^[0-7]{3,4}$|^[-rwxsStT]{9,10}$/.test(r), 'rights must be an octal mode or a 9-character permission string.');
      const list = strArr(paths, 'paths', 20000).map((x) => remotePath(s, x, 'path'));
      for (const target of list) {
        await a.setRights(target, r, { recursive: o.recursive === true, addXToDirectories: o.addXToDirectories !== false });
        s.log.actions.record('chmod', { filename: target, permissions: r });
      }
      s.invalidate();
      return list.length;
    });

    this.handle('fs:setOwner', async (id, paths, owner, group, options) => {
      const { s, a } = adapterOf(id);
      capable(a, 'owner', 'ownership');
      const o = optObj(options, 'options');
      const list = strArr(paths, 'paths', 20000).map((x) => remotePath(s, x, 'path'));
      for (const target of list) {
        await a.setOwner(target, optStr(owner, 'owner', 256), optStr(group, 'group', 256), { recursive: o.recursive === true });
        s.log.actions.record('chown', { filename: target, owner: optStr(owner, 'owner', 256), group: optStr(group, 'group', 256) });
      }
      s.invalidate();
      return list.length;
    });

    this.handle('fs:setTimes', async (id, p, mtime, atime) => {
      const { s, a } = adapterOf(id);
      capable(a, 'timestamp', 'timestamps');
      const target = remotePath(s, p, 'path');
      await a.setTimes(target, num(mtime, 'mtime', 0), atime === undefined ? num(mtime, 'mtime', 0) : num(atime, 'atime', 0));
      s.invalidate(a.dirname(target));
      s.log.actions.record('touch', { filename: target });
      return true;
    });

    this.handle('fs:readFile', async (id, p, options) => {
      const { s, a } = adapterOf(id);
      const o = optObj(options, 'options');
      const target = remotePath(s, p, 'path');
      const max = o.maxBytes === undefined ? LIMITS.text : num(o.maxBytes, 'maxBytes', 1, LIMITS.text);
      const st = await a.stat(target);
      need(st.size <= max, `The file is larger than ${max} bytes; use the transfer queue instead.`);
      const buf = await a.readFile(target);
      return { base64: buf.toString('base64'), size: buf.length };
    });

    this.handle('fs:writeFile', async (id, p, base64) => {
      const { s, a } = adapterOf(id);
      const target = remotePath(s, p, 'path');
      const b64 = str(base64, 'content', Math.ceil(LIMITS.text * 4 / 3) + 16);
      const buf = Buffer.from(b64, 'base64');
      need(buf.length <= LIMITS.text, 'The content is too large for a direct write.');
      await a.writeFile(target, buf);
      s.invalidate(a.dirname(target));
      s.log.actions.record('upload', { filename: target, size: String(buf.length) });
      return buf.length;
    });

    this.handle('fs:calculateSize', async (id, dirs, correlationId) => {
      const { s, a } = adapterOf(id);
      const list = strArr(dirs, 'dirs', 5000).map((x) => remotePath(s, x, 'path'));
      const cid = optStr(correlationId, 'correlationId', 64);
      let total = { bytes: 0, files: 0, dirs: 0 };
      for (const d of list) {
        const r = await a.calculateSize(d, (p) => {
          if (cid) this.emit('event:progress', { correlationId: cid, sessionId: s.id, kind: 'calculateSize', ...p });
        });
        total = { bytes: total.bytes + r.bytes, files: total.files + r.files, dirs: total.dirs + r.dirs };
      }
      return total;
    });

    this.handle('fs:checksum', async (id, p, algorithm) => {
      const { s, a } = adapterOf(id);
      capable(a, 'checksum', 'checksums');
      return a.checksum(remotePath(s, p, 'path'), str(algorithm, 'algorithm', 32));
    });

    this.handle('fs:spaceInfo', async (id, p) => {
      const { s, a } = adapterOf(id);
      capable(a, 'spaceInfo', 'space information');
      return a.spaceInfo(remotePath(s, p, 'path'));
    });

    // ---- the local side, which the panels browse without a session ----
    this.handle('fs:localList', async (p, options) => {
      const dir = path.resolve(str(p, 'path', LIMITS.path));
      const o = optObj(options, 'options');
      const items = await fsp.readdir(dir, { withFileTypes: true });
      need(items.length <= 200000, 'The directory has too many entries to list.');
      const out = [];
      for (const it of items) {
        const full = path.join(dir, it.name);
        let st = null;
        try { st = await fsp.lstat(full); } catch { continue; }
        const isLink = st.isSymbolicLink();
        let target = st;
        if (isLink) { try { target = await fsp.stat(full); } catch { target = st; } }
        out.push({
          name: it.name,
          type: target.isDirectory() ? 'dir' : (isLink ? 'link' : 'file'),
          size: target.isDirectory() ? 0 : target.size,
          mtime: Math.floor(st.mtimeMs),
          rights: '',
          owner: '',
          group: '',
          linkTarget: '',
          isSymlink: isLink,
          hidden: isHiddenWin(it.name),
          readOnly: false,
          raw: null,
        });
      }
      if (o.includeParent && path.dirname(dir) !== dir) {
        out.unshift({ name: '..', type: 'dir', size: 0, mtime: 0, rights: '', owner: '', group: '', linkTarget: '', isSymlink: false, hidden: false, readOnly: false, raw: null });
      }
      return { path: dir, entries: out };
    });

    this.handle('fs:localStat', async (p) => {
      const full = path.resolve(str(p, 'path', LIMITS.path));
      const st = await fsp.stat(full);
      return { path: full, size: st.size, mtime: Math.floor(st.mtimeMs), type: st.isDirectory() ? 'dir' : 'file' };
    });

    this.handle('fs:localMkdir', async (p) => {
      const full = path.resolve(str(p, 'path', LIMITS.path));
      await fsp.mkdir(full, { recursive: true });
      return full;
    });

    this.handle('fs:localRemove', async (paths, options) => {
      const o = optObj(options, 'options');
      const list = strArr(paths, 'paths', 20000).map((x) => path.resolve(x));
      const removed = [];
      const failed = [];
      for (const full of list) {
        try {
          if (o.toRecycleBin !== false) await shell.trashItem(full);
          else await fsp.rm(full, { recursive: true, force: false });
          removed.push(full);
        } catch (e) { failed.push({ path: full, message: e.message }); }
      }
      return { removed, failed };
    });

    this.handle('fs:localRename', async (from, to) => {
      const src = path.resolve(str(from, 'from', LIMITS.path));
      const dst = path.resolve(str(to, 'to', LIMITS.path));
      await fsp.rename(src, dst);
      return dst;
    });

    this.handle('fs:localDrives', async () => {
      if (process.platform !== 'win32') return [{ path: '/', label: '/' }];
      const out = [];
      for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
        const root = `${String.fromCharCode(c)}:\\`;
        try { await fsp.access(root); out.push({ path: root, label: root }); } catch { /* not present */ }
      }
      return out;
    });

    // ---- find --------------------------------------------------------
    /** Running searches, so one can be cancelled without cancelling another. */
    this._finders = new Map();

    this.handle('fs:find', (req) => {
      const r = obj(req, 'request');
      const mod = findModule();
      need(typeof mod.find === 'function', 'design/main/find.js does not export find().');

      const session = r.sessionId ? this.session(r.sessionId) : null;
      const adapter = session ? session.adapter : this.localAdapter();
      need(adapter && adapter.connected, 'The session is not connected.');
      const root = session
        ? remotePath(session, r.root || '/', 'root')
        : path.resolve(str(r.root, 'root', LIMITS.path));

      const cid = optStr(r.correlationId, 'correlationId', 64) || `find-${Date.now().toString(36)}`;
      const finder = mod.find(adapter, root, stripUndefined({
        mask: optStr(r.mask, 'mask', LIMITS.small) || undefined,
        text: optStr(r.text, 'text', LIMITS.small) || undefined,
        regex: r.regex === undefined ? undefined : bool(r.regex, 'regex'),
        caseSensitive: r.caseSensitive === undefined ? undefined : bool(r.caseSensitive, 'caseSensitive'),
        recursive: r.recursive === undefined ? undefined : bool(r.recursive, 'recursive'),
        maxResults: r.maxResults === undefined ? 10000 : num(r.maxResults, 'maxResults', 1, 200000),
      }));

      this._finders.set(cid, finder);
      // Results stream as they are found: a search over a slow server must show
      // its first hit long before it shows its last.
      if (typeof finder.on === 'function') {
        finder.on('match', (hit) => this.emit('event:progress', { correlationId: cid, kind: 'find', hit }));
        finder.on('error', (e, at) => this.emit('event:progress', { correlationId: cid, kind: 'find', error: e.message, at }));
        finder.on('done', (summary) => {
          this._finders.delete(cid);
          this.emit('event:progress', { correlationId: cid, kind: 'find', done: true, count: (summary && summary.results ? summary.results.length : 0), cancelled: !!(summary && summary.cancelled) });
        });
      }
      return { correlationId: cid };
    });

    this.handle('fs:findCancel', (correlationId) => {
      const f = this._finders.get(str(correlationId, 'correlationId', 64));
      if (!f) return false;
      if (typeof f.cancel === 'function') f.cancel();
      else if (typeof f.abort === 'function') f.abort();
      return true;
    });
  }

  // ----------------------------------------------------------- queue:*
  registerQueue() {
    /** Build the queue spec for one file, with the adapters on the right ends. */
    const specFor = (session, direction, file, target, copyParam) => {
      const local = this.localAdapter();
      const remote = session.adapter;
      need(remote && remote.connected, 'The session is not connected.');
      if (direction === 'upload') {
        return {
          side: 'upload',
          source: path.resolve(file),
          target: remotePath(session, target, 'target'),
          targetIsDir: true,
          sourceAdapter: local,
          targetAdapter: remote,
          copyParam,
          session,
        };
      }
      if (direction === 'download') {
        return {
          side: 'download',
          source: remotePath(session, file, 'file'),
          target: path.resolve(target),
          targetIsDir: true,
          sourceAdapter: remote,
          targetAdapter: local,
          copyParam,
          session,
        };
      }
      // remote-copy: both ends are the same server.
      need(remote.caps.copyRemote || remote.caps.exec, `${remote.protocolName} cannot copy files on the server.`);
      return {
        side: 'remote-copy',
        source: remotePath(session, file, 'file'),
        target: remotePath(session, target, 'target'),
        targetIsDir: true,
        sourceAdapter: remote,
        targetAdapter: remote,
        copyParam,
        session,
      };
    };

    this.handle('queue:add', (req) => {
      const r = obj(req, 'request');
      const q = this.queue();
      const session = this.session(r.sessionId);
      const direction = str(r.direction, 'direction', 16);
      need(['upload', 'download', 'remote-copy'].includes(direction), 'direction must be upload, download or remote-copy.');
      const files = strArr(r.files, 'files', 200000);
      need(files.length, 'No files were given to transfer.');
      const target = r.target === undefined
        ? (direction === 'upload' ? session.state.remotePath : session.state.localPath)
        : str(r.target, 'target', LIMITS.path);
      need(target, 'No transfer target was given.');
      const copyParam = optObj(r.copyParam, 'copyParam');

      const added = [];
      for (const f of files) added.push(q.view(q.add(specFor(session, direction, f, target, copyParam))));
      return added;
    });

    this.handle('queue:list', () => this.queue().list());
    this.handle('queue:item', (id) => {
      const q = this.queue();
      const it = q.get(str(id, 'id', 128));
      return it ? q.view(it) : null;
    });

    this.handle('queue:pause', (id) => {
      const q = this.queue();
      return id === undefined || id === null ? q.pauseAll() : q.pauseItem(str(id, 'id', 128));
    });
    this.handle('queue:resume', (id) => {
      const q = this.queue();
      return id === undefined || id === null ? q.resumeAll() : q.resumeItem(str(id, 'id', 128));
    });
    this.handle('queue:cancel', (id) => this.queue().remove(str(id, 'id', 128)));
    this.handle('queue:move', (id, delta) => {
      const q = this.queue();
      const d = num(delta, 'delta', -1, 1);
      need(d === -1 || d === 1, 'delta must be -1 or 1.');
      return d < 0 ? q.moveUp(str(id, 'id', 128)) : q.moveDown(str(id, 'id', 128));
    });
    this.handle('queue:clear', () => this.queue().removeDone());
    this.handle('queue:setEnabled', (on) => this.queue().setEnabled(bool(on, 'enabled')));
    this.handle('queue:setLimit', (n) => this.queue().setTransfersLimit(num(n, 'limit', 1, 32)));
    this.handle('queue:setSpeed', (id, bytesPerSecond) => this.queue().setSpeedLimit(
      id === undefined || id === null ? null : str(id, 'id', 128),
      num(bytesPerSecond, 'bytesPerSecond', 0, 1024 * 1024 * 1024)));
    this.handle('queue:answerQuery', (id, answer, options) =>
      this.queue().answerQuery(str(id, 'id', 128), str(answer, 'answer', 64), optObj(options, 'options')));
    this.handle('queue:answerPrompt', (id, value) =>
      this.queue().answerPrompt(str(id, 'id', 128), str(value, 'value', 4096)));
  }

  // ------------------------------------------------------------ sync:*
  registerSync() {
    /** Comparison options, validated here so sync.js sees only clean input. */
    const syncOptions = (r) => ({
      mode: optStr(r.mode, 'mode', 32) || undefined,
      direction: optStr(r.direction, 'direction', 32) || undefined,
      criteria: optStr(r.criteria, 'criteria', 32) || undefined,
      recursive: r.recursive === undefined ? undefined : bool(r.recursive, 'recursive'),
      fileMask: optStr(r.fileMask, 'fileMask', LIMITS.small) || undefined,
      caseSensitive: r.caseSensitive === undefined ? undefined : bool(r.caseSensitive, 'caseSensitive'),
      transferMode: optStr(r.transferMode, 'transferMode', 32) || undefined,
      copyParam: optObj(r.copyParam, 'copyParam'),
      timeTolerance: r.timeTolerance === undefined ? undefined : num(r.timeTolerance, 'timeTolerance', 0, 86400000),
      dstMode: optStr(r.dstMode, 'dstMode', 16) || undefined,
      timeDifference: r.timeDifference === undefined ? undefined : num(r.timeDifference, 'timeDifference', -86400, 86400),
    });

    /** The comparison result, kept here so apply() gets the real context object
     *  back — the checklist that crosses the bridge is a plain, safe copy. */
    this._checklists = new Map();

    this.handle('sync:compare', async (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      need(session.adapter && session.adapter.connected, 'The session is not connected.');
      const s = this.sync();
      need(typeof s.compare === 'function', 'design/main/sync.js does not export compare().');

      const result = await s.compare(
        this.localAdapter(), path.resolve(str(r.localPath, 'localPath', LIMITS.path)),
        session.adapter, remotePath(session, r.remotePath, 'remotePath'),
        stripUndefined(syncOptions(r)));

      // The checklist itself is small and JSON-safe; the context is not, so it
      // stays here under a token the renderer hands back to sync:apply.
      const token = `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this._checklists.set(token, result);
      // Bound the memory: a user comparing all afternoon must not accumulate
      // every checklist they looked at.
      if (this._checklists.size > 16) this._checklists.delete(this._checklists.keys().next().value);
      return { token, items: result.items, counts: result.counts };
    });

    this.handle('sync:apply', async (req) => {
      const r = obj(req, 'request');
      const s = this.sync();
      need(typeof s.apply === 'function', 'design/main/sync.js does not export apply().');
      const checklist = this._checklists.get(str(r.token, 'token', 64));
      need(checklist, 'That comparison is no longer available; run the comparison again.');

      // Only the ticked flags come back from the renderer, matched by index —
      // never a whole re-serialized checklist, which could be edited into
      // deleting something the comparison never proposed.
      if (r.checked !== undefined) {
        const checked = arr(r.checked, 'checked', 500000);
        need(checked.length === checklist.items.length, 'The checked flags do not match the comparison.');
        checklist.items.forEach((it, i) => { it.checked = !!checked[i]; });
      }

      return s.apply(checklist, this.queue(), {
        onlyChecked: r.onlyChecked !== false,
        performDeletions: r.performDeletions !== false,
        copyParam: optObj(r.copyParam, 'copyParam'),
      });
    });

    this.handle('sync:keepUpToDate', (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      need(session.adapter && session.adapter.connected, 'The session is not connected.');
      const s = this.sync();
      need(typeof s.startWatch === 'function', 'design/main/sync.js does not export startWatch().');

      const watcher = s.startWatch(
        this.localAdapter(), path.resolve(str(r.localPath, 'localPath', LIMITS.path)),
        session.adapter, remotePath(session, r.remotePath, 'remotePath'),
        this.queue(), stripUndefined(syncOptions(r)));

      const id = `kutd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this._watchers = this._watchers || new Map();
      this._watchers.set(id, watcher);
      if (watcher && typeof watcher.on === 'function') {
        // design/main/sync.js's watcher emits `started`, `changes`, `tick`,
        // `error` and `stopped`. `change` and `synchronized` were never emitted
        // by it, so "Keep remote directory up to date" ran and reported
        // absolutely nothing back to the window that started it.
        for (const ev of ['started', 'changes', 'tick', 'error', 'stopped']) {
          watcher.on(ev, (payload) => this.emit('event:sync', { type: ev, id, payload: syncPayload(ev, payload, this) }));
        }
      }

      // `startWatch()` starts the watcher, so its own `started` fires before
      // this handler has a listener attached — and before the renderer even has
      // the id to correlate it with. Announce it here, where both exist, so the
      // event stream a window subscribes to actually begins at the beginning.
      const native = !!(watcher && watcher._native);
      this.emit('event:sync', { type: 'started', id, payload: { native } });
      // And in the reply too, so a caller that never subscribes still learns
      // whether this is a real file-system watch or a polling timer.
      return { id, native };
    });

    this.handle('sync:stop', (id) => {
      const s = this.sync();
      const key = str(id, 'id', 128);
      const watcher = this._watchers && this._watchers.get(key);
      need(watcher, 'No such keep-up-to-date watcher.');
      if (typeof s.stopWatch === 'function') s.stopWatch(watcher);
      else if (typeof watcher.stop === 'function') watcher.stop();
      this._watchers.delete(key);
      return true;
    });
  }

  // ---------------------------------------------------------- editor:*
  registerEditor() {
    this.handle('editor:open', (req) => {
      const r = obj(req, 'request');
      if (r.localPath && !r.remotePath) {
        return this.editors.openLocal({
          localPath: path.resolve(str(r.localPath, 'localPath', LIMITS.path)),
          mode: optStr(r.mode, 'mode', 16) || 'auto',
          external: optStr(r.external, 'external', LIMITS.path),
          encoding: optStr(r.encoding, 'encoding', 16) || undefined,
          sessionId: optStr(r.sessionId, 'sessionId', 128),
        });
      }
      const session = this.session(r.sessionId);
      return this.editors.openRemote({
        sessionId: session.id,
        remotePath: remotePath(session, r.remotePath, 'remotePath'),
        mode: optStr(r.mode, 'mode', 16) || 'auto',
        external: optStr(r.external, 'external', LIMITS.path),
        encoding: optStr(r.encoding, 'encoding', 16) || undefined,
      });
    });

    this.handle('editor:read', (id) => this.editors.read(str(id, 'id', 64)));
    this.handle('editor:setEncoding', (id, encoding) => this.editors.setEncoding(str(id, 'id', 64), str(encoding, 'encoding', 16)));
    this.handle('editor:save', (id, text, options) => {
      const o = optObj(options, 'options');
      return this.editors.save(str(id, 'id', 64), str(text, 'text', LIMITS.text), { force: o.force === true });
    });
    this.handle('editor:upload', (id, options) => this.editors.upload(str(id, 'id', 64), { force: optObj(options, 'options').force === true }));
    this.handle('editor:close', (id, options) => this.editors.close(str(id, 'id', 64), optObj(options, 'options')));
    this.handle('editor:list', () => this.editors.list());
    this.handle('editor:orphans', () => this.editors.findOrphans());
    this.handle('editor:discardOrphans', (paths) => this.editors.discardOrphans(strArr(paths, 'paths', 20000)));
  }


  // -------------------------------------------------------- messages:*
  //
  // WinSCP's five STRINGTABLE resources, extracted into
  // design/renderer/messages.json and resolved by design/main/messages.js.
  // Every sentence the original shows a user is in there with its printf shape,
  // so a module that needs one asks for it by resource id instead of
  // transcribing the English into its own source and drifting from it.
  registerMessages() {
    const M = () => messagesModule();

    /**
     * design/winscp-i18n.js is an ES module and this is CommonJS. Node 22.12
     * resolves `require()` of ESM on its own, but Electron 33 embeds Node
     * 20.18, which does not — so messages.js's synchronous fallback quietly
     * gave up and every message rendered in plain English at every funny level
     * in the SHIPPED app while the test suite, on a newer Node, saw the
     * dictionary and passed. A dynamic import works on every version.
     *
     * The promise is awaited by the handler that needs it rather than blocking
     * registration, and a failure to load is survivable: the message still
     * renders in WinSCP's own English rather than the app losing the ability to
     * say anything at all.
     */
    const voices = M().loadVoices().then((dict) => {
      if (!dict) {
        this.emit('event:log', {
          source: 'messages',
          kind: 'warning',
          text: 'The bilingual dictionary could not be loaded; messages render in English only.',
        });
      }
      return !!dict;
    });

    /** One message, formatted. `fmtLoad` throws on a missing argument, by design. */
    this.handle('messages:load', (id, args) => {
      const m = M();
      const key = str(id, 'id', 128);
      need(m.has(key), `No such message resource: ${key}`);
      const list = args === undefined || args === null ? [] : arr(args, 'args', 32);
      return list.length ? m.fmtLoad(key, ...list) : m.loadStr(key);
    });

    /** The metadata a caller needs before it can format: arity and shape. */
    this.handle('messages:meta', (id) => {
      const m = M();
      const key = str(id, 'id', 128);
      need(m.has(key), `No such message resource: ${key}`);
      return { ...m.meta(key), params: m.paramsOf(key), arity: m.arityOf(key), help: m.helpKeyword(key) };
    });

    /** The whole table, for a renderer that wants to resolve locally. */
    this.handle('messages:table', () => ({
      ids: messagesModule().ids(),
      excluded: messagesModule().EXCLUDED_BY_POLICY,
    }));

    /**
     * The bilingual render. The resource English is the fact; the dictionary
     * supplies the Cantonese and the five funny levels around it.
     */
    this.handle('messages:voiced', async (id, options) => {
      await voices;
      const m = M();
      const key = str(id, 'id', 128);
      need(m.has(key), `No such message resource: ${key}`);
      const o = optObj(options, 'options');
      const language = optStr(o.language, 'options.language', 8) || 'en';
      need(m.LANG_MODES.includes(language), 'options.language must be en, yue or both.');
      // Two INDEPENDENT funny levels, one per language, as the shared
      // instructions require: the English voice and the Cantonese voice are
      // adjusted separately and neither changes the facts the resource states.
      return m.voiced(key, {
        language,
        enLevel: o.enLevel === undefined ? 3 : num(o.enLevel, 'options.enLevel', 1, 5),
        yueLevel: o.yueLevel === undefined ? 3 : num(o.yueLevel, 'options.yueLevel', 1, 5),
      }, ...(o.args === undefined ? [] : arr(o.args, 'options.args', 32)));
    });

    /**
     * The `**` and `$$` tags WinSCP wraps a headline and an interactive prompt
     * in. Splitting them is what lets a long error render as a headline plus
     * collapsible detail instead of one undifferentiated block.
     */
    this.handle('messages:split', (text) => {
      const m = M();
      const s = str(text, 'text', LIMITS.text);
      return {
        ...m.extractMainInstructions(s),
        firstParagraph: m.mainInstructionsFirstParagraph(s),
        unformatted: m.unformatMessage(s),
        interactiveAt: m.findInteractiveMsgStart(s),
      };
    });
  }

  // ----------------------------------------------------------- panel:*
  //
  // design/main/dirview.js and design/main/pathedit.js — the models inside
  // WinSCP's file panels, drive trees and path edits. The renderer owns the
  // DOM; these own the RULES, so there is one comparator, one filter, one
  // rename refusal and one mask validator rather than a second set that agrees
  // until the day it does not.
  registerPanel() {
    const dv = () => dirviewModule();
    const pe = () => patheditModule();
    const sideOf = (v) => {
      const s = optStr(v, 'side', 16) || 'remote';
      need(s === 'local' || s === 'remote', 'side must be "local" or "remote".');
      return s;
    };
    const entriesOf = (v) => arr(v || [], 'entries', 200000);

    this.handle('panel:columns', (s) => dv().columnsFor(sideOf(s)));
    this.handle('panel:sortAscendingByDefault', (s, key) =>
      dv().sortAscendingByDefault(sideOf(s), str(key, 'key', 64)));

    /**
     * The sort state and its SortStr persistence format ("index;direction"),
     * which is what a WinSCP INI actually carries. `click` names the column a
     * header click landed on: clicking the current column flips the direction,
     * clicking another starts it at THAT column's default — which for Size and
     * Date modified is descending, not ascending.
     */
    this.handle('panel:sortState', (req) => {
      const r = optObj(req, 'request');
      const state = new (dv().SortState)(sideOf(r.side));
      if (r.sortStr) state.sortStr = str(r.sortStr, 'sortStr', 64);
      if (r.click) state.sortBy(str(r.click, 'click', 64));
      else if (r.column) state.setSort(str(r.column, 'column', 64), r.ascending !== false);
      return { column: state.column, ascending: state.ascending, sortStr: state.sortStr };
    });

    /**
     * TUnixDirView::LoadFiles / TDirViewInt::LoadFiles — the mask filter, the
     * hidden-file rule, the counters the status bar shows, and the sort.
     */
    this.handle('panel:buildView', (req) => {
      const r = obj(req, 'request');
      const d = dv();
      const s = sideOf(r.side);
      const view = d.buildView({
        files: entriesOf(r.entries),
        side: s,
        mask: optStr(r.mask, 'mask', LIMITS.small),
        showHiddenFiles: r.showHiddenFiles !== false,
        showInaccesibleDirectories: r.showInaccesibleDirectories !== false,
      });
      if (r.sortColumn) {
        const key = str(r.sortColumn, 'sortColumn', 64);
        view.items = d.sortItems(view.items, {
          side: s,
          sortColumn: key,
          sortAscending: r.ascending === undefined
            ? d.sortAscendingByDefault(s, key) : bool(r.ascending, 'ascending'),
          alwaysSortDirectoriesByName: r.alwaysSortDirectoriesByName === true,
          naturalOrderNumericalSorting: r.naturalOrderNumericalSorting !== false,
        });
      }
      return view;
    });

    /** The Copy-file-list-to-clipboard payload, byte for byte. */
    this.handle('panel:export', (req) => {
      const r = obj(req, 'request');
      const d = dv();
      const kind = optStr(r.kind, 'kind', 32) || d.PANEL_EXPORT.FileList;
      const dir = optStr(r.path, 'path', LIMITS.path);
      const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir;
      const lines = d.panelExport(kind, {
        items: entriesOf(r.entries),
        pathName: dir,
        // FullFileList prefixes the directory the panel is showing; the model
        // has no way to know that path, so the panel supplies it here.
        fullPath: (item) => (dir ? `${trimmed}/${d.itemFileName(item)}` : d.itemFileName(item)),
      });
      return { lines, text: d.stringsToText(lines, optStr(r.eol, 'eol', 8) || undefined) };
    });

    /** TUnixDirView::CanEdit and the invalid-character refusal behind it. */
    this.handle('panel:validateRename', (req) => {
      const r = obj(req, 'request');
      const d = dv();
      const s = sideOf(r.side);
      const item = optObj(r.item, 'item');
      // CanEdit ANDs in IsCapable[fcRename] with no default-allow: an edit box
      // that promises a rename the protocol cannot perform is worse than a
      // greyed-out one, so an unstated capability counts as absent.
      const can = d.canEdit(item, {
        renameCapable: r.renameCapable === true,
        loading: r.loading === true,
        readOnly: r.readOnly === true,
        isRecycleBin: r.isRecycleBin === true,
      });
      if (!can) return { canEdit: false, action: 'refuse', error: '' };
      return { canEdit: true, ...d.validateRename(item, optStr(r.name, 'name', LIMITS.name), s) };
    });

    /** ComposeMaskStr / ValidateMask, with the 0-based caret offset. */
    this.handle('panel:composeMask', (lines, directory) =>
      dirviewModule().composeMaskStr(strArr(lines, 'lines', 2000), directory === true));

    this.handle('panel:validateMask', (mask, forceDirectoryMasks) => dirviewModule().validateMask(
      str(mask, 'mask', LIMITS.small),
      forceDirectoryMasks === undefined || forceDirectoryMasks === null
        ? undefined : num(forceDirectoryMasks, 'forceDirectoryMasks', 0, 1)));

    /** ProcessChangedFiles — the Compare-panels marking. */
    this.handle('panel:compare', (req) => {
      const r = obj(req, 'request');
      return dirviewModule().compareWithPanel(
        entriesOf(r.items), entriesOf(r.otherItems), {
          criteria: r.criteria === undefined ? undefined : strArr(r.criteria, 'criteria', 8),
          existingOnly: r.existingOnly === true,
          caseSensitive: r.caseSensitive === true,
          side: sideOf(r.side),
        });
    });

    // ---- pathedit ---------------------------------------------------
    this.handle('path:segments', (p, s) => patheditModule().pathSegments(str(p, 'path', LIMITS.path), sideOf(s)));
    this.handle('path:complete', (typed, candidates) => patheditModule().completeInline(
      str(typed, 'typed', LIMITS.path), strArr(candidates, 'candidates', 20000)));
    this.handle('path:completions', (typed, list, options) => patheditModule().pathCompletions(
      str(typed, 'typed', LIMITS.path), strArr(list, 'entries', 20000), optObj(options, 'options')));
    this.handle('path:word', (text, caret, direction) => {
      const p = pe();
      const t = str(text, 'text', LIMITS.path);
      const c = num(caret, 'caret', 0, t.length);
      const d = optStr(direction, 'direction', 16) || 'at';
      if (d === 'left') return p.wordLeft(t, c);
      if (d === 'right') return p.wordRight(t, c);
      return p.wordAt(t, c);
    });
    this.handle('path:saveToHistory', (list, value, options) => patheditModule().saveToHistory(
      strArr(list, 'list', 5000), str(value, 'value', LIMITS.path), optObj(options, 'options')));
    this.handle('path:minimize', (p, chars) =>
      patheditModule().minimizeStr(str(p, 'path', LIMITS.path), num(chars, 'chars', 1, 4096)));
  }

  // -------------------------------------------------------- explorer:*
  //
  // design/main/explorershell.js — the orchestration half of
  // forms/CustomScpExplorer.cpp. Everything here is a DECISION: what a command
  // applies to, whether it may run at all, which confirmation to ask and what
  // to do with the answer. The renderer stopped computing these itself; it
  // pushes its panel state and asks.
  registerExplorer() {
    const E = () => this.explorer();

    /** The renderer's panels, as the shell needs to see them. */
    this.handle('explorer:setPanels', (patch) => {
      const p = obj(patch, 'panels');
      const mod = explorerModule();
      for (const s of ['local', 'remote']) {
        if (p[s] === undefined) continue;
        if (p[s] === null) { this._panels[s] = null; continue; }
        const spec = obj(p[s], `panels.${s}`);
        this._panels[s] = new mod.PanelState({
          side: s,
          local: spec.local === undefined ? s === 'local' : !!spec.local,
          path: optStr(spec.path, 'path', LIMITS.path),
          entries: arr(spec.entries || [], 'entries', 200000),
          selected: strArr(spec.selected || [], 'selected', 200000),
          focusedName: spec.focusedName === undefined || spec.focusedName === null
            ? null : str(spec.focusedName, 'focusedName', LIMITS.name),
          hasFocus: spec.hasFocus === true,
          foreground: spec.foreground !== false,
          enabled: spec.enabled !== false,
          mask: optStr(spec.mask, 'mask', LIMITS.small),
        });
      }
      if (p.currentSide !== undefined) {
        const s = str(p.currentSide, 'currentSide', 16);
        need(s === 'local' || s === 'remote', 'currentSide must be "local" or "remote".');
        E().currentSide = s;
      }
      if (p.sessionId !== undefined && p.sessionId !== null) {
        this.sessions.setActive(str(p.sessionId, 'sessionId', 128));
      }
      if (p.localBrowserMode !== undefined) E().localBrowserMode = !!p.localBrowserMode;
      if (p.synchronizeBrowsing !== undefined) E().synchronizeBrowsing = !!p.synchronizeBrowsing;
      return true;
    });

    /**
     * Whether a command may run, and on what — TCustomScpExplorerForm's
     * UpdateControls predicates. This is the one that stops "Delete" and
     * "Delete focused" disagreeing about which files they mean.
     */
    this.handle('explorer:state', (name, context) =>
      E().commandState(str(name, 'command', 64), optObj(context, 'context')));

    this.handle('explorer:fileList', (s, options) =>
      E().createFileList(optStr(s, 'side', 16) || 'current', optObj(options, 'options')));

    /**
     * The delete path in full: recycle-versus-delete decided from the SITE's
     * setting rather than the protocol's, the two SEPARATE confirmation
     * preferences (confirmRecycling and confirmDeleting), and the
     * already-in-the-recycle-bin case that must not be recycled twice.
     */
    this.handle('explorer:delete', (s, files, alternative) =>
      E().executeDeleteFileOperation(
        optStr(s, 'side', 16) || 'current',
        files === undefined || files === null ? undefined : strArr(files, 'files', 200000),
        alternative === true));

    this.handle('explorer:deleteDecision', (s, files, alternative) =>
      E().deleteDecision(
        optStr(s, 'side', 16) || 'current',
        files === undefined || files === null ? [] : strArr(files, 'files', 200000),
        alternative === true));

    this.handle('explorer:fileOperation', (operation, s, options) => {
      const o = optObj(options, 'options');
      return E().executeFileOperationOnSelection(
        str(operation, 'operation', 32),
        optStr(s, 'side', 16) || 'current',
        o.onFocused === true,
        o.noConfirmation === true,
        o.param);
    });

    /** TransferPresetAutoSelect — run it on every remote directory load. */
    this.handle('explorer:presetAutoSelect', () => E().transferPresetAutoSelect());
    this.handle('explorer:presetAutoSelectData', () => E().transferPresetAutoSelectData());

    /** The queue predicates: what Pause/Resume/Up/Down may do to THIS item. */
    this.handle('explorer:queueOp', (operation, context) =>
      E().allowQueueOperation(str(operation, 'operation', 32), optObj(context, 'context')));
    this.handle('explorer:defaultQueueOp', (item) => E().defaultQueueOperation(optObj(item, 'item')));

    /** The three meanings of a double click, resolved the way WinSCP does. */
    this.handle('explorer:doubleClick', (s, entry) =>
      E().resolveDoubleClick(optStr(s, 'side', 16) || 'current', optObj(entry, 'entry')));

    this.handle('explorer:canPaste', () => E().canPasteFromClipBoard());
    this.handle('explorer:paste', (options) => E().pasteFromClipBoardPlan(optObj(options, 'options')));

    /** Drag and drop: which operation a drop effect means, and where it lands. */
    this.handle('explorer:dropEffect', (spec) => E().chooseDropEffect(obj(spec, 'spec')));
    this.handle('explorer:dropTarget', (spec) => E().ddGetTarget(obj(spec, 'spec')));
    this.handle('explorer:dragDrop', (spec) => E().dragDropFileOperation(obj(spec, 'spec')));

    /** Closing: the pending-queue warning and the workspace branch. */
    this.handle('explorer:canCloseQueue', () => E().canCloseQueue());
    this.handle('explorer:closeQuery', (options) => E().formCloseQuery(optObj(options, 'options')));
    this.handle('explorer:closeTab', () => E().closeTab());

    /** Synchronized browsing, including its refusal ladder. */
    this.handle('explorer:syncBrowse', (spec) => E().applySynchronizeBrowsing(obj(spec, 'spec')));
    this.handle('explorer:syncOptions', (params) => E().getSynchronizeOptions(optObj(params, 'params')));
    this.handle('explorer:fullSyncOptions', () => E().fullSynchronizeOptions());

    /** Custom commands: the tri-state that depends on which menu is asking. */
    this.handle('explorer:customCommandState', (command, onFocused, listType) =>
      E().customCommandState(str(command, 'command', LIMITS.command), onFocused === true,
        optStr(listType, 'listType', 32) || undefined));

    /** The answer channel every ported confirmation waits on. */
    this.handle('explorer:answer', (promptId, answer) =>
      this.answerAsk(str(promptId, 'promptId', 128), str(answer, 'answer', 64)));
  }

  // ------------------------------------------------------- interface:*
  //
  // design/main/interfaces.js — TScpCommanderForm and TScpExplorerForm as pure
  // decisions. The renderer's toolbars, panel arrangement, shortcut tables and
  // workspace handling take their answers from here instead of each carrying a
  // shallower copy of the same per-mode rules.
  registerInterface() {
    const I = () => interfacesModule();
    const modeOf = (v) => {
      const m = optStr(v, 'mode', 16) || 'commander';
      need(m === 'commander' || m === 'explorer', 'mode must be "commander" or "explorer".');
      return m;
    };

    this.handle('interface:shortcuts', (m, options) => I().shortcutsFor(modeOf(m), optObj(options, 'options')));
    this.handle('interface:allowedAction', (m, action, phase) =>
      I().allowedAction(modeOf(m), str(action, 'action', 64), optStr(phase, 'phase', 16) || undefined));
    this.handle('interface:commands', (m) => I().commandsFor(modeOf(m)));
    this.handle('interface:panels', (m, options) => I().panelArrangement(modeOf(m), optObj(options, 'options')));
    this.handle('interface:bands', (m) => I().bandsFor(modeOf(m)));
    this.handle('interface:components', (m) => I().componentsFor(modeOf(m)));
    this.handle('interface:statusBars', (m) => I().statusBarsFor(modeOf(m)));

    this.handle('interface:restoreParams', (m, stored) =>
      I().restoreParams(modeOf(m), optObj(stored, 'stored')));
    this.handle('interface:storeParams', (m, state) =>
      I().storeParams(modeOf(m), optObj(state, 'state')));

    this.handle('interface:toolbarLayout', (text) => I().parseToolbarsLayout(str(text, 'layout', 64 * 1024)));
    this.handle('interface:formatToolbarLayout', (layout) => I().formatToolbarsLayout(optObj(layout, 'layout')));

    this.handle('interface:doubleClickAction', (m, context) =>
      I().doubleClickAction(modeOf(m), optObj(context, 'context')));

    // ---- workspaces --------------------------------------------------
    //
    // `stored` is the saved workspace/site list; the live sessions come from
    // the session manager, so a caller cannot pass a workspace that does not
    // match what is actually open.
    const storedWorkspaces = () => {
      need(this.config, 'The configuration store is not available.');
      const data = this.config.data || {};
      return Array.isArray(data.workspaces) ? data.workspaces : [];
    };

    this.handle('interface:workspaceCollect', (options) =>
      I().collectWorkspace(storedWorkspaces(),
        this.sessions.all().map((s) => ({
          active: s === this.sessions.active(),
          stateData: { ...s.state, name: s.name, siteId: s.data.id || '' },
          sessionData: s.data,
        })),
        optObj(options, 'options')));

    this.handle('interface:workspacePasswordDecision', (dataList, state) =>
      I().workspacePasswordDecision(arr(dataList, 'dataList', 500),
        this.sessions.all().map((s) => ({ sessionData: s.data })),
        optObj(state, 'state')));

    this.handle('interface:workspaceList', (name) =>
      I().folderOrWorkspaceList(storedWorkspaces(), optStr(name, 'name', LIMITS.name)));

    this.handle('interface:workspaceOpen', (name, options) =>
      I().openFolderOrWorkspace(storedWorkspaces(), str(name, 'name', LIMITS.name),
        optObj(options, 'options')));

    // ---- synchronized browsing ---------------------------------------
    this.handle('interface:syncBrowseLocal', (prev, next, remote) =>
      I().synchronizeBrowsingLocal(str(prev, 'prev', LIMITS.path), str(next, 'next', LIMITS.path),
        str(remote, 'remote', LIMITS.path)));
    this.handle('interface:syncBrowseRemote', (prev, next, local) =>
      I().synchronizeBrowsingRemote(str(prev, 'prev', LIMITS.path), str(next, 'next', LIMITS.path),
        str(local, 'local', LIMITS.path)));

    this.handle('interface:tabHint', (m, session, state) =>
      I().tabHintDetails(modeOf(m), optObj(session, 'session'), optObj(state, 'state')));
  }

  // --------------------------------------------------------------- ui:*
  //
  // design/main/userinterface.js — the message-dialog contract from
  // windows/WinInterface.cpp: which buttons a question offers, which one is the
  // default, what Escape answers, and when the never-ask-again box may appear
  // at all. The renderer draws; this decides.
  registerUi() {
    const U = () => uiModule();

    /**
     * CreateMoreMessageDialogEx. `answers` is a list of answer NAMES (or the
     * bit mask); the reply carries the button list, the default, the Escape
     * answer and the never-ask-again box, all decided here rather than by the
     * renderer's own idea of which button looks primary.
     */
    this.handle('ui:messageDialog', (spec) => {
      const s = obj(spec, 'spec');
      need(Array.isArray(s.answers) || typeof s.answers === 'number',
        'spec.answers must be a list of answer names or an answer mask.');
      return U().buildMessageDialog(
        optStr(s.message, 'spec.message', LIMITS.text),
        s.moreMessages === undefined ? null : s.moreMessages,
        optStr(s.type, 'spec.type', 32) || undefined,
        s.answers,
        optStr(s.helpKeyword, 'spec.helpKeyword', 128) || undefined,
        optObj(s.params, 'spec.params'));
    });

    /** Which answer a click produced, including the never-ask-again conversion. */
    this.handle('ui:resolveAnswer', (dialog, raw) =>
      U().resolveMessageAnswer(obj(dialog, 'dialog'), optObj(raw, 'answer')));

    /**
     * NeverAskAgainCheckClick — ticking the box disables every button but the
     * positive one, so a NEGATIVE answer can never be made permanent. "No, and
     * never ask again" would refuse every future transfer with nothing on
     * screen to say why.
     */
    this.handle('ui:neverAskAgain', (dialog, checked, override) => {
      const r = U().neverAskAgainEnablement(obj(dialog, 'dialog'), bool(checked, 'checked'),
        override === undefined || override === null ? undefined : num(override, 'override', 0));
      // The model answers with Maps keyed by answer name; the bridge carries
      // plain JSON, and a Map that arrives as `{}` would read as "every button
      // is enabled" — the exact opposite of what this decides.
      return {
        positiveAnswer: r.positiveAnswer,
        enabled: Object.fromEntries(r.enabled),
        dropDown: Object.fromEntries([...r.dropDown].map(([k, v]) => [k, v])),
      };
    });

    this.handle('ui:mayOfferNeverAskAgain', (question) =>
      U().mayOfferNeverAskAgain(str(question, 'question', 64)));
    this.handle('ui:neverAskAgainSetting', (question) =>
      U().neverAskAgainSetting(str(question, 'question', 64)));
    this.handle('ui:answerList', (mask) => U().answerList(num(mask, 'mask', 0)));

    /**
     * An exception, as a dialog. ShouldDisplayException is the caller's gate:
     * asking for a dialog for a silent abort is a caller defect and is reported
     * as one rather than rendering an empty box.
     */
    this.handle('ui:exceptionDialog', (spec) => {
      const s = obj(spec, 'spec');
      const e = Object.assign(new Error(optStr(s.message, 'spec.message', LIMITS.text)), {
        name: optStr(s.name, 'spec.name', 128) || 'Error',
        code: optStr(s.code, 'spec.code', 64) || undefined,
      });
      need(U().shouldDisplayException(e), 'That exception is not one a dialog is shown for.');
      return U().buildExceptionDialog(e, optStr(s.type, 'spec.type', 32) || undefined,
        optObj(s.options, 'spec.options'));
    });
    this.handle('ui:timeoutCaption', (caption, seconds) =>
      U().formatTimeoutCaption(str(caption, 'caption', 256), num(seconds, 'seconds', 0, 86400)));
    this.handle('ui:formCaption', (title) => U().formatFormCaption(optStr(title, 'title', 256)));
    this.handle('ui:mainFormCaption', (title) => U().formatMainFormCaption(optStr(title, 'title', 256)));

    /** The answer channel — the same one explorer:answer settles. */
    this.handle('ui:answer', (promptId, answer) =>
      this.answerAsk(str(promptId, 'promptId', 128), str(answer, 'answer', 64)));
  }

  // -------------------------------------------------------- transfer:*
  //
  // The SESSION transfer path — TTerminal::CopyToRemote / CopyToLocal through
  // design/main/transfer.js. It is not the queue: the queue is a background
  // pump the user can pause and reorder, this is the foreground operation with
  // its own robust retry loop, its own directory recursion and its own
  // parallel-file splitting. Both move their bytes through queue.moveBytes,
  // which is what stops the two growing separate ideas of what a resume is.
  registerTransfer() {
    const copyParamOf = (v) => {
      const cp = optObj(v, 'copyParam');
      need(JSON.stringify(cp).length <= 64 * 1024, 'The transfer settings are too large.');
      return cp;
    };

    this.handle('transfer:copyToRemote', async (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      need(session.adapter && session.adapter.connected, 'The session is not connected.');
      const t = this.terminalFor(session);
      const files = strArr(r.files, 'files', 200000).map((f) => path.resolve(f));
      need(files.length, 'No files were given to transfer.');
      const target = remotePath(session, r.target, 'target');
      // TTerminal::CopyToRemote returns a boolean: false when the operation was
      // cancelled or an error was not recovered from. It is reported as
      // `completed` rather than as the reply's own `ok`, so a caller cannot
      // read "the request was handled" as "every file moved".
      const completed = await t.copyToRemote(files, target, copyParamOf(r.copyParam),
        r.params === undefined ? 0 : num(r.params, 'params', 0));
      return { completed: completed !== false, target };
    });

    this.handle('transfer:copyToLocal', async (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      need(session.adapter && session.adapter.connected, 'The session is not connected.');
      const t = this.terminalFor(session);
      const files = strArr(r.files, 'files', 200000).map((f) => remotePath(session, f, 'file'));
      need(files.length, 'No files were given to transfer.');
      const target = path.resolve(str(r.target, 'target', LIMITS.path));
      const completed = await t.copyToLocal(files, target, copyParamOf(r.copyParam),
        r.params === undefined ? 0 : num(r.params, 'params', 0));
      return { completed: completed !== false, target };
    });

    /**
     * CanParallel — whether this session may spread a transfer over several
     * connections at all. Asked before the transfer so the answer can be
     * reported rather than discovered halfway through.
     *
     * It answers `parallelAllowed`, not `canParallel`: TTerminal::CanParallel
     * opens with `ParallelOperation != NULL` and there is no cursor to hand a
     * pre-flight query, so forwarding it would make this channel a constant
     * `false` whatever the protocol, the copy parameters or the flags. The
     * cursor guard stays where WinSCP put it, inside CopyToRemote/CopyToLocal.
     */
    this.handle('transfer:canParallel', (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      const engine = this.terminalFor(session).transferEngine();
      return engine.parallelAllowed(copyParamOf(r.copyParam),
        r.params === undefined ? 0 : num(r.params, 'params', 0));
    });

    /** The copy-parameter helpers a transfer dialog needs, from one place. */
    this.handle('transfer:changeFileName', (copyParam, name, s, firstLevel) =>
      transferModule().changeFileName(copyParamOf(copyParam), str(name, 'name', LIMITS.name),
        optStr(s, 'side', 16) === 'local' ? 'local' : 'remote', firstLevel !== false, {}));
    this.handle('transfer:allowResume', (copyParam, size, name) => transferModule().allowResume(
      copyParamOf(copyParam), num(size, 'size', 0), optStr(name, 'name', LIMITS.name)));
    this.handle('transfer:useAsciiTransfer', (copyParam, name, s) => transferModule().useAsciiTransfer(
      copyParamOf(copyParam), str(name, 'name', LIMITS.name),
      optStr(s, 'side', 16) === 'remote' ? 'remote' : 'local', {}));
  }

  // --------------------------------------------------------- history:*
  registerHistory() {
    // Reads wait for the writes already in flight. config.js records revisions
    // without awaiting them (a history write must never delay a save), so a
    // read that did not wait would show a log one event out of date.
    const settled = () => this.history.settled();

    this.handle('history:list', async (options) => {
      await settled();
      const o = optObj(options, 'options');
      const r = await this.history.list({
        limit: o.limit === undefined ? undefined : num(o.limit, 'limit', 1, 100000),
        since: o.since === undefined ? undefined : num(o.since, 'since', 0),
        until: o.until === undefined ? undefined : num(o.until, 'until', 0),
        action: o.action === undefined ? undefined : (Array.isArray(o.action) ? strArr(o.action, 'action', 50) : str(o.action, 'action', 64)),
      });
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:actions', async () => {
      await settled();
      const r = await this.history.actions();
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:read', async (rev) => {
      await settled();
      const r = await this.history.read(str(rev, 'revision', 64));
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:diff', async (a, b) => {
      await settled();
      const r = await this.history.diff(str(a, 'a', 64), b === undefined ? undefined : str(b, 'b', 64));
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:snapshot', async (label) => {
      need(this.config, 'The configuration store is not available.');
      const r = await this.history.snapshot(str(label, 'label', 256), this.config.exportState());
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:restore', async (rev, label) => {
      need(this.config, 'The configuration store is not available.');
      const revision = str(rev, 'revision', 64);
      const read = await this.history.read(revision);
      if (!read.ok) throw Object.assign(new Error(read.error.message), { code: read.error.code });
      // importState() flushes and then records a NEW revision through
      // config.attachHistory, which is what keeps the history append-only:
      // the revision that was current a moment ago is still there to go back to.
      this.config.importState(read.value, optStr(label, 'label', 256) || `Restored revision ${revision.slice(0, 8)}`);
      // Wait for that new revision to land before replying, so the panel that
      // refreshes on this reply sees the restore in the log.
      await settled();
      const now = await this.history.list({ limit: 1 });
      this.emit('event:config', { type: 'restored', revision });
      return { restored: revision, newRevision: now.ok && now.value[0] ? now.value[0].oid : null };
    });

    this.handle('history:prune', async () => {
      const r = await this.history.prune(true);
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:export', async (file) => {
      const target = path.resolve(str(file, 'file', LIMITS.path));
      const r = await this.history.export_();
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      await fsp.writeFile(target, JSON.stringify(r.value, null, 2), 'utf8');
      return target;
    });
  }
}

// ---------------------------------------------------------------- helpers

/**
 * A keep-up-to-date event, reduced to what can actually cross the bridge.
 *
 * `sync.apply()` hands the watcher the queue's INTERNAL items (each holding a
 * gate, a promise and two live adapters) and its deletion records (each holding
 * an adapter). None of that survives a structured clone, and the attempt to
 * clone it threw inside the watcher's own emit — which is to say, watching a
 * directory took the application down. `view()` is the only queue shape allowed
 * across, exactly as it is for `event:queue`.
 */
function syncPayload(type, payload, ipc) {
  if (!payload || typeof payload !== 'object') return payload === undefined ? null : payload;
  if (type === 'error') {
    return { message: payload.message || String(payload), code: payload.code || 'SYNC_ERROR' };
  }
  if (type !== 'changes') return { ...payload };
  const view = (it) => {
    try { return ipc.queue().view(it); } catch { return { id: it && it.id, source: it && it.source, target: it && it.target }; }
  };
  return {
    items: (payload.items || []).map(view),
    deletions: (payload.deletions || []).map((d) => ({
      path: d && d.path,
      action: d && d.item ? d.item.action : '',
      isDirectory: !!(d && d.item && d.item.isDirectory),
    })),
  };
}

/** A site as the renderer may see it: no secret ever leaves the main process. */
function publicSite(s) {
  const out = { ...s };
  for (const f of ['password', 'passphrase', 'proxyPassword', 'tunnelPassword', 'tunnelPassphrase', 'encryptKey', 's3SessionToken']) {
    // Report only WHETHER something is stored, never its value, its length, or
    // its ciphertext.
    out[f] = out[f] ? '__stored__' : '';
  }
  return out;
}

/** The complete configuration document safe to clone into the renderer. */
function publicConfig(config) {
  return {
    prefs: config.prefs,
    sites: config.sites.map(publicSite),
    folders: config.data.folders,
    workspaces: config.data.workspaces,
    needsUnlock: config.needsUnlock(),
  };
}

const PROTOCOLS = new Set(['sftp', 'scp', 'ftp', 'webdav', 's3', 'local']);

/** Validate site data coming from the renderer before it reaches the store. */
function validateSite(site, partial) {
  const s = obj(site, 'site');
  const out = {};
  const copy = (k, fn) => { if (s[k] !== undefined) out[k] = fn(s[k]); };

  copy('id', (v) => str(v, 'site.id', 128));
  copy('name', (v) => str(v, 'site.name', LIMITS.name));
  copy('folder', (v) => str(v, 'site.folder', LIMITS.path));
  copy('protocol', (v) => {
    const p = str(v, 'site.protocol', 16).toLowerCase();
    need(PROTOCOLS.has(p), `Unknown protocol: ${p}`);
    return p;
  });
  copy('hostName', (v) => str(v, 'site.hostName', 512));
  copy('portNumber', (v) => num(v, 'site.portNumber', 0, 65535));
  copy('userName', (v) => str(v, 'site.userName', 512));
  copy('password', (v) => str(v, 'site.password', 4096));
  copy('passphrase', (v) => str(v, 'site.passphrase', 4096));
  copy('note', (v) => str(v, 'site.note', 8192));
  copy('color', (v) => str(v, 'site.color', 32));

  // Everything else is passed through after a size check: defaults.js is the
  // schema, and rejecting an unknown key here would break every option the
  // Preferences UI adds later.
  for (const [k, v] of Object.entries(s)) {
    if (k in out) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = v;
  }
  need(JSON.stringify(out).length <= 512 * 1024, 'The site data is too large.');
  if (!partial) need(out.protocol === 'local' || out.hostName, 'A site needs a host name.');
  return out;
}

/** The file context a custom command expands against. */
function buildCommandContext(session, r) {
  const files = Array.isArray(r.files) ? strArr(r.files, 'files', 20000) : [];
  const local = !!r.local;
  return {
    fileName: optStr(r.fileName, 'fileName', LIMITS.path) || files[0] || '',
    fileList: r.fileList !== undefined ? str(r.fileList, 'fileList', 1024 * 1024) : customcmd.fileListOf(files, { local }),
    remotePath: optStr(r.remotePath, 'remotePath', LIMITS.path) || (session ? session.state.remotePath : '/'),
    localPath: optStr(r.localPath, 'localPath', LIMITS.path) || (session ? session.state.localPath : ''),
    localFileName: optStr(r.localFileName, 'localFileName', LIMITS.path),
  };
}

/**
 * Windows marks hidden files with a file attribute, and Node does not surface
 * it (`fs.Stats.mode` carries POSIX bits only). Rather than guess, the local
 * backend — design/main/protocols/local.js, which does have a platform-native
 * path for this — is the authority; this listing reports the portable signal
 * only, so a dot-file is hidden everywhere and nothing is falsely claimed.
 */
function isHiddenWin(name) {
  return String(name || '').startsWith('.');
}

module.exports = { Ipc, ok, err, publicSite, validateSite, ValidationError, LIMITS };
