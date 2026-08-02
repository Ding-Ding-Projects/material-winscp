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

/** Call a method on a lazily loaded module, naming it precisely if it is absent. */
function callOn(mod, names, label, ...args) {
  for (const n of [].concat(names)) {
    if (typeof mod[n] === 'function') return mod[n](...args);
  }
  throw new Error(`${label} is unavailable: the module exports none of ${[].concat(names).join('/')}.`);
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

    /** Everything the main process pushes goes through here, and only to the
     *  window that is actually alive. */
    this.emit = (channel, payload) => {
      const w = this.getWindow();
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    };

    this.sessions = new SessionManager({ config: this.config, emit: this.emit });
    this.editors = new EditorManager({ config: this.config, sessions: this.sessions, emit: this.emit });
    this.history = new History(P.history(), {
      getPrefs: () => (this.config ? this.config.prefs.versionHistory : {}),
    });
    this.updates = new Updates({ config: this.config, currentVersion: this.version, emit: this.emit });
    this.commands = new customcmd.CustomCommandRunner({
      onOutput: (o) => this.emit('event:console', o),
    });
    this.commands.on('finished', (o) => this.emit('event:console', { ...o, done: true }));

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

  queue() {
    if (this._queue) return this._queue;
    const mod = queueModule();
    const Cls = mod.Queue || mod.TransferQueue || mod.default;
    if (typeof Cls !== 'function') throw new Error('design/main/queue.js does not export a Queue class.');
    this._queue = new Cls({
      config: this.config,
      sessions: this.sessions,
      emit: (payload) => this.emit('event:queue', payload),
      onProgress: (payload) => this.emit('event:progress', payload),
    });
    return this._queue;
  }

  sync() {
    if (this._sync) return this._sync;
    const mod = syncModule();
    const Cls = mod.Synchronizer || mod.Sync || mod.default;
    if (typeof Cls === 'function') {
      this._sync = new Cls({ config: this.config, sessions: this.sessions, queue: () => this.queue(), emit: (p) => this.emit('event:sync', p) });
    } else {
      this._sync = mod;   // a plain function module is fine too
    }
    return this._sync;
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
    return this.channels;
  }

  dispose() {
    for (const c of this._registered) ipcMain.removeHandler(c);
    this._registered.length = 0;
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

    this.handle('config:get', () => ({
      prefs: cfg().prefs,
      sites: cfg().sites.map(publicSite),
      folders: cfg().data.folders,
      workspaces: cfg().data.workspaces,
      needsUnlock: cfg().needsUnlock(),
    }));

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
    this.handle('session:disconnect', async (id) => { await this.session(id).disconnect(); return true; });

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
    this.handle('fs:find', async (req) => {
      const r = obj(req, 'request');
      const mod = findModule();
      const session = r.sessionId ? this.session(r.sessionId) : null;
      const cid = optStr(r.correlationId, 'correlationId', 64);
      return callOn(mod, ['find', 'search', 'run'], 'File search', {
        session,
        adapter: session ? session.adapter : null,
        root: session ? remotePath(session, r.root || '/', 'root') : path.resolve(str(r.root, 'root', LIMITS.path)),
        mask: optStr(r.mask, 'mask', LIMITS.small),
        text: optStr(r.text, 'text', LIMITS.small),
        regex: r.regex === true,
        caseSensitive: r.caseSensitive === true,
        recursive: r.recursive !== false,
        maxResults: r.maxResults === undefined ? 10000 : num(r.maxResults, 'maxResults', 1, 200000),
        onResult: (hit) => { if (cid) this.emit('event:progress', { correlationId: cid, kind: 'find', hit }); },
      });
    });
  }

  // ----------------------------------------------------------- queue:*
  registerQueue() {
    this.handle('queue:add', (req) => {
      const r = obj(req, 'request');
      const q = this.queue();
      const session = this.session(r.sessionId);
      const direction = str(r.direction, 'direction', 16);
      need(['upload', 'download', 'remoteCopy', 'remoteMove'].includes(direction), 'Unknown transfer direction.');
      const files = strArr(r.files, 'files', 200000);
      return callOn(q, ['add', 'enqueue'], 'The transfer queue', {
        sessionId: session.id,
        session,
        direction,
        files: direction === 'upload' ? files.map((f) => path.resolve(f)) : files.map((f) => remotePath(session, f, 'file')),
        target: direction === 'upload' ? remotePath(session, r.target || session.state.remotePath, 'target') : path.resolve(str(r.target, 'target', LIMITS.path)),
        copyParam: optObj(r.copyParam, 'copyParam'),
        move: r.move === true,
        queueNow: r.queueNow !== false,
      });
    });

    this.handle('queue:list', () => callOn(this.queue(), ['list', 'items'], 'The transfer queue'));
    this.handle('queue:pause', (id) => callOn(this.queue(), ['pause'], 'The transfer queue', id === undefined ? undefined : str(id, 'id', 128)));
    this.handle('queue:resume', (id) => callOn(this.queue(), ['resume'], 'The transfer queue', id === undefined ? undefined : str(id, 'id', 128)));
    this.handle('queue:cancel', (id) => callOn(this.queue(), ['cancel', 'remove'], 'The transfer queue', str(id, 'id', 128)));
    this.handle('queue:move', (id, delta) => callOn(this.queue(), ['move', 'reorder'], 'The transfer queue', str(id, 'id', 128), num(delta, 'delta', -100000, 100000)));
    this.handle('queue:clear', (which) => callOn(this.queue(), ['clear'], 'The transfer queue', optStr(which, 'which', 32) || 'done'));
    this.handle('queue:setLimit', (n) => callOn(this.queue(), ['setLimit', 'setTransfersLimit'], 'The transfer queue', num(n, 'limit', 1, 32)));
    this.handle('queue:setSpeed', (id, bytesPerSecond) => callOn(this.queue(), ['setSpeed', 'setCpsLimit'], 'The transfer queue',
      id === undefined || id === null ? null : str(id, 'id', 128), num(bytesPerSecond, 'bytesPerSecond', 0, 1024 * 1024 * 1024)));
    this.handle('queue:retry', (id) => callOn(this.queue(), ['retry'], 'The transfer queue', str(id, 'id', 128)));
    this.handle('queue:answer', (id, answer) => callOn(this.queue(), ['answer', 'respond'], 'The transfer queue', str(id, 'id', 128), optObj(answer, 'answer')));
  }

  // ------------------------------------------------------------ sync:*
  registerSync() {
    this.handle('sync:compare', (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      const s = this.sync();
      const cid = optStr(r.correlationId, 'correlationId', 64);
      return callOn(s, ['compare', 'checklist', 'buildChecklist'], 'Synchronization', {
        session,
        localPath: path.resolve(str(r.localPath, 'localPath', LIMITS.path)),
        remotePath: remotePath(session, r.remotePath, 'remotePath'),
        mode: optStr(r.mode, 'mode', 32) || 'both',
        criteria: optStr(r.criteria, 'criteria', 32) || 'time',
        recursive: r.recursive !== false,
        deleteFiles: r.deleteFiles === true,
        mirror: r.mirror === true,
        copyParam: optObj(r.copyParam, 'copyParam'),
        onProgress: (p) => { if (cid) this.emit('event:progress', { correlationId: cid, kind: 'sync', ...p }); },
      });
    });

    this.handle('sync:apply', (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      return callOn(this.sync(), ['apply', 'synchronize', 'run'], 'Synchronization', {
        session,
        checklist: arr(r.checklist, 'checklist', 500000),
        queue: this.queue(),
        copyParam: optObj(r.copyParam, 'copyParam'),
      });
    });

    this.handle('sync:keepUpToDate', (req) => {
      const r = obj(req, 'request');
      const session = this.session(r.sessionId);
      return callOn(this.sync(), ['keepUpToDate', 'watch'], 'Synchronization', {
        session,
        localPath: path.resolve(str(r.localPath, 'localPath', LIMITS.path)),
        remotePath: remotePath(session, r.remotePath, 'remotePath'),
        options: optObj(r.options, 'options'),
      });
    });

    this.handle('sync:stop', (id) => callOn(this.sync(), ['stop', 'cancel'], 'Synchronization', id === undefined ? undefined : str(id, 'id', 128)));
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

  // --------------------------------------------------------- history:*
  registerHistory() {
    this.handle('history:list', async (options) => {
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
      const r = await this.history.actions();
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:read', async (rev) => {
      const r = await this.history.read(str(rev, 'revision', 64));
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.value;
    });

    this.handle('history:diff', async (a, b) => {
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
      this.emit('event:config', { type: 'restored', revision });
      return { restored: revision };
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
