// config.js — the configuration store: preferences, sites, workspaces,
// bookmarks, transfer presets and custom commands.
//
// Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
// truncated config. Every mutation is offered to the version-history store so
// a deleted site or a changed setting can be undone.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const P = require('./paths');
const crypt = require('./crypto');
const { SESSION_DEFAULTS, COPY_PARAM_DEFAULTS, PREF_DEFAULTS } = require('./defaults');

/** Secret-bearing fields, protected on write and unwrapped on demand. */
const SECRET_FIELDS = ['password', 'passphrase', 'proxyPassword', 'tunnelPassword',
  'tunnelPassphrase', 'encryptKey', 's3SessionToken'];

const DEFAULT_PRESETS = [
  { id: 'default', name: 'Default', autoSelect: '', copyParam: {} },
  { id: 'text', name: 'Text', autoSelect: '', copyParam: { transferMode: 'text' } },
  { id: 'binary', name: 'Binary', autoSelect: '', copyParam: { transferMode: 'binary' } },
  {
    id: 'exclude-temp', name: 'Exclude temporary files', autoSelect: '',
    copyParam: { includeFileMask: '| *.tmp; *.bak; Thumbs.db; .DS_Store' },
  },
];

const DEFAULT_CUSTOM_COMMANDS = [
  { id: 'cc-execute', name: 'Execute', command: '"./!"', params: { remote: true, applyToDirectories: false, recursive: false, showResults: false, copyResults: false } },
  { id: 'cc-touch', name: 'Touch', command: 'touch "!"', params: { remote: true, applyToDirectories: true, recursive: false, showResults: false, copyResults: false } },
  { id: 'cc-targz', name: 'Tar/GZip', command: 'tar -czf "!?&Archive name:?archive.tgz!" !&', params: { remote: true, applyToDirectories: true, recursive: false, showResults: false, copyResults: false } },
  { id: 'cc-untargz', name: 'UnTar/GZip', command: 'tar -xzf "!" -C "!?&Extract to:?.!"', params: { remote: true, applyToDirectories: false, recursive: false, showResults: false, copyResults: false } },
  { id: 'cc-grep', name: 'Grep', command: 'grep "!?&Text to find:?!" !&', params: { remote: true, applyToDirectories: false, recursive: false, showResults: true, copyResults: false } },
  { id: 'cc-checksum', name: 'Checksum (SHA-256)', command: 'sha256sum !&', params: { remote: true, applyToDirectories: false, recursive: false, showResults: true, copyResults: true } },
];

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
      out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    }
    return out;
  }
  return over === undefined ? base : over;
}

function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

let nextId = 1;
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class Config extends EventEmitter {
  constructor() {
    super();
    this.data = {
      version: 1,
      prefs: clone(PREF_DEFAULTS),
      sites: [],
      folders: [],
      workspaces: [],
      hostKeys: {},
      loaded: false,
    };
    this.data.prefs.copyParamList = clone(DEFAULT_PRESETS);
    this.data.prefs.customCommands = clone(DEFAULT_CUSTOM_COMMANDS);
    this._saveTimer = null;
    this._history = null;
  }

  /** The version-history store is injected to avoid a circular require. */
  attachHistory(history) { this._history = history; }

  load() {
    const file = P.config();
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data.prefs = deepMerge(clone(PREF_DEFAULTS), raw.prefs || {});
        if (!raw.prefs || !raw.prefs.copyParamList || !raw.prefs.copyParamList.length) {
          this.data.prefs.copyParamList = clone(DEFAULT_PRESETS);
        }
        if (!raw.prefs || !raw.prefs.customCommands || !raw.prefs.customCommands.length) {
          this.data.prefs.customCommands = clone(DEFAULT_CUSTOM_COMMANDS);
        }
        this.data.sites = (raw.sites || []).map((s) => deepMerge(clone(SESSION_DEFAULTS), s));
        this.data.folders = raw.folders || [];
        this.data.workspaces = raw.workspaces || [];
        this.data.version = raw.version || 1;
      } catch (e) {
        // A corrupt config must not lose the user's sites: keep the bad file.
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch { /* best effort */ }
        this.emit('error', new Error('Configuration could not be read and was reset: ' + e.message));
      }
    }
    if (fs.existsSync(P.hostkeys())) {
      try { this.data.hostKeys = JSON.parse(fs.readFileSync(P.hostkeys(), 'utf8')); } catch { this.data.hostKeys = {}; }
    }
    this.data.loaded = true;
    return this;
  }

  /** Atomic write. Debounced by save(); call flush() to force it out now. */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const file = P.config();
    P.ensure(path.dirname(file));
    const payload = JSON.stringify({
      version: this.data.version,
      prefs: this.data.prefs,
      sites: this.data.sites,
      folders: this.data.folders,
      workspaces: this.data.workspaces,
    }, null, 2);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
    fs.writeFileSync(P.hostkeys(), JSON.stringify(this.data.hostKeys, null, 2), 'utf8');
    this.emit('saved');
  }

  save(reason) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        this.flush();
        this._snapshot(reason || 'Updated settings');
      } catch (e) { this.emit('error', e); }
    }, 150);
  }

  /** Record a revision. A history failure must never fail the user's action. */
  _snapshot(label) {
    if (!this._history || !this.data.prefs.versionHistory.enabled) return;
    try { this._history.snapshot(label, this.exportState()); } catch { /* logged by history */ }
  }

  exportState() {
    return {
      prefs: clone(this.data.prefs),
      sites: clone(this.data.sites),
      folders: clone(this.data.folders),
      workspaces: clone(this.data.workspaces),
    };
  }

  /** Restore is itself a new revision — history stays append-only. */
  importState(state, label) {
    if (state.prefs) this.data.prefs = deepMerge(clone(PREF_DEFAULTS), state.prefs);
    if (state.sites) this.data.sites = state.sites.map((s) => deepMerge(clone(SESSION_DEFAULTS), s));
    if (state.folders) this.data.folders = state.folders;
    if (state.workspaces) this.data.workspaces = state.workspaces;
    this.flush();
    this._snapshot(label || 'Restored an earlier revision');
    this.emit('changed');
  }

  // ---------------------------------------------------------------- prefs
  get prefs() { return this.data.prefs; }

  getPref(dotted) {
    return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data.prefs);
  }

  setPref(dotted, value, label) {
    const keys = dotted.split('.');
    const last = keys.pop();
    let o = this.data.prefs;
    for (const k of keys) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
    if (JSON.stringify(o[last]) === JSON.stringify(value)) return false;  // no-op writes no revision
    o[last] = value;
    this.save(label || `Changed setting ${dotted}`);
    this.emit('pref-changed', dotted, value);
    return true;
  }

  setPrefs(patch, label) {
    this.data.prefs = deepMerge(this.data.prefs, patch);
    this.save(label || 'Changed settings');
    this.emit('pref-changed', null, patch);
  }

  // ---------------------------------------------------------------- sites
  get sites() { return this.data.sites; }

  siteById(id) { return this.data.sites.find((s) => s.id === id) || null; }

  /** Full session data with secrets decrypted, for actually connecting. */
  resolveSite(id) {
    const s = this.siteById(id);
    if (!s) return null;
    const out = clone(s);
    for (const f of SECRET_FIELDS) if (out[f]) out[f] = crypt.unprotect(s[f]);
    return out;
  }

  addSite(site) {
    const s = deepMerge(clone(SESSION_DEFAULTS), site || {});
    s.id = s.id || newId('site');
    for (const f of SECRET_FIELDS) {
      if (s[f] && !s[f].startsWith('mp:') && !s[f].startsWith('os:')) s[f] = s.savePassword || f !== 'password' ? crypt.protect(s[f]) : '';
    }
    this.data.sites.push(s);
    this.save(`Added the site "${s.name || s.hostName}"`);
    this.emit('sites-changed');
    return s;
  }

  updateSite(id, patch) {
    const i = this.data.sites.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const merged = deepMerge(this.data.sites[i], patch);
    for (const f of SECRET_FIELDS) {
      const v = patch[f];
      if (v !== undefined) {
        merged[f] = v === '' ? '' : (v.startsWith('mp:') || v.startsWith('os:') ? v : crypt.protect(v));
      }
    }
    if (patch.savePassword === false) merged.password = '';
    this.data.sites[i] = merged;
    this.save(`Updated the site "${merged.name || merged.hostName}"`);
    this.emit('sites-changed');
    return merged;
  }

  removeSite(id) {
    const i = this.data.sites.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [gone] = this.data.sites.splice(i, 1);
    this.save(`Deleted the site "${gone.name || gone.hostName}"`);
    this.emit('sites-changed');
    return true;
  }

  duplicateSite(id, name) {
    const s = this.siteById(id);
    if (!s) return null;
    const copy = clone(s);
    copy.id = newId('site');
    copy.name = name || `${s.name} (copy)`;
    this.data.sites.push(copy);
    this.save(`Duplicated the site "${s.name}"`);
    this.emit('sites-changed');
    return copy;
  }

  moveSite(id, folder) {
    return this.updateSite(id, { folder: folder || '' });
  }

  // -------------------------------------------------------------- folders
  addFolder(folderPath) {
    if (!folderPath || this.data.folders.includes(folderPath)) return false;
    this.data.folders.push(folderPath);
    this.save(`Added the site folder "${folderPath}"`);
    this.emit('sites-changed');
    return true;
  }

  renameFolder(from, to) {
    this.data.folders = this.data.folders.map((f) => (f === from ? to : (f.startsWith(from + '/') ? to + f.slice(from.length) : f)));
    for (const s of this.data.sites) {
      if (s.folder === from) s.folder = to;
      else if (s.folder.startsWith(from + '/')) s.folder = to + s.folder.slice(from.length);
    }
    this.save(`Renamed the site folder "${from}" to "${to}"`);
    this.emit('sites-changed');
    return true;
  }

  removeFolder(folderPath, deleteSites) {
    this.data.folders = this.data.folders.filter((f) => f !== folderPath && !f.startsWith(folderPath + '/'));
    if (deleteSites) {
      this.data.sites = this.data.sites.filter((s) => s.folder !== folderPath && !s.folder.startsWith(folderPath + '/'));
    } else {
      for (const s of this.data.sites) {
        if (s.folder === folderPath || s.folder.startsWith(folderPath + '/')) s.folder = '';
      }
    }
    this.save(`Deleted the site folder "${folderPath}"`);
    this.emit('sites-changed');
    return true;
  }

  // ----------------------------------------------------------- workspaces
  saveWorkspace(name, sessions) {
    const i = this.data.workspaces.findIndex((w) => w.name === name);
    const w = { name, sessions, savedAt: Date.now() };
    if (i >= 0) this.data.workspaces[i] = w; else this.data.workspaces.push(w);
    this.save(`Saved the workspace "${name}"`);
    this.emit('sites-changed');
    return w;
  }

  removeWorkspace(name) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.name !== name);
    this.save(`Deleted the workspace "${name}"`);
    this.emit('sites-changed');
    return true;
  }

  // ------------------------------------------------------------ host keys
  knownHostKey(hostPort) { return this.data.hostKeys[hostPort] || null; }

  rememberHostKey(hostPort, fingerprint, algorithm) {
    this.data.hostKeys[hostPort] = { fingerprint, algorithm, addedAt: Date.now() };
    this.save(`Accepted the host key for ${hostPort}`);
  }

  forgetHostKey(hostPort) {
    delete this.data.hostKeys[hostPort];
    this.save(`Forgot the host key for ${hostPort}`);
  }

  // ------------------------------------------------------------ histories
  pushHistory(key, value) {
    if (!value) return;
    const h = this.data.prefs.history;
    const list = (h[key] || []).filter((v) => v !== value);
    list.unshift(value);
    h[key] = list.slice(0, this.data.prefs.maxHistoryEntries);
    this.save();  // combo history is noise in the revision log
  }

  clearHistory(key) {
    if (key) delete this.data.prefs.history[key];
    else this.data.prefs.history = {};
    this.save('Cleared the recent-entry history');
  }

  // ------------------------------------------------------------ bookmarks
  bookmarksFor(key) {
    const b = this.data.prefs.bookmarks[key];
    return b || { local: [], remote: [], shortCuts: {} };
  }

  addBookmark(key, side, value, name) {
    const b = this.data.prefs.bookmarks[key] || { local: [], remote: [], shortCuts: {} };
    if (!b[side].some((x) => x.path === value)) b[side].push({ path: value, name: name || value });
    this.data.prefs.bookmarks[key] = b;
    this.save(`Added a ${side} bookmark for ${value}`);
  }

  removeBookmark(key, side, value) {
    const b = this.data.prefs.bookmarks[key];
    if (!b) return;
    b[side] = b[side].filter((x) => x.path !== value);
    this.save(`Removed a ${side} bookmark for ${value}`);
  }

  // -------------------------------------------------------- master password
  enableMasterPassword(password) {
    const verifier = crypt.makeVerifier(password);
    // Re-wrap every stored secret under the new master key.
    const plain = this.data.sites.map((s) => {
      const o = {};
      for (const f of SECRET_FIELDS) o[f] = crypt.unprotect(s[f]);
      return o;
    });
    crypt.unlockMaster(password, verifier);
    this.data.prefs.security.useMasterPassword = true;
    this.data.prefs.security.masterPasswordVerifier = verifier;
    this.data.sites.forEach((s, i) => {
      for (const f of SECRET_FIELDS) s[f] = plain[i][f] ? crypt.protect(plain[i][f]) : '';
    });
    this.save('Enabled the master password');
    return true;
  }

  changeMasterPassword(oldPassword, newPassword) {
    if (!crypt.unlockMaster(oldPassword, this.data.prefs.security.masterPasswordVerifier)) return false;
    return this.enableMasterPassword(newPassword);
  }

  disableMasterPassword(password) {
    if (!crypt.unlockMaster(password, this.data.prefs.security.masterPasswordVerifier)) return false;
    const plain = this.data.sites.map((s) => {
      const o = {};
      for (const f of SECRET_FIELDS) o[f] = crypt.unprotect(s[f]);
      return o;
    });
    crypt.lockMaster();
    this.data.prefs.security.useMasterPassword = false;
    this.data.prefs.security.masterPasswordVerifier = '';
    this.data.sites.forEach((s, i) => {
      for (const f of SECRET_FIELDS) s[f] = plain[i][f] ? crypt.protect(plain[i][f]) : '';
    });
    this.save('Disabled the master password');
    return true;
  }

  unlock(password) {
    return crypt.unlockMaster(password, this.data.prefs.security.masterPasswordVerifier);
  }

  needsUnlock() {
    return this.data.prefs.security.useMasterPassword && !crypt.hasMaster();
  }
}

module.exports = { Config, SECRET_FIELDS, DEFAULT_PRESETS, DEFAULT_CUSTOM_COMMANDS, newId, deepMerge, clone };
