// editors.js — the editor manager (WinSCP's EditorManager.cpp).
//
// Editing a remote file is a round trip with three places to get it wrong, and
// this module is careful about each:
//
//   1. DOWNLOAD to a temporary area we own, laid out per prefs so two files
//      called `config.ini` from two different servers cannot collide.
//   2. WATCH. The internal editor tells us when it saved; an external editor
//      does not, so we watch the file and upload when it settles.
//   3. UPLOAD — but only after re-checking that the REMOTE file has not changed
//      underneath us. Silently overwriting a colleague's edit is the one
//      failure mode of this feature that loses work, so it is a prompt, never
//      an assumption.
//
// Temporary files are removed per prefs.editor.keepTemporaryFiles and
// prefs.temporaryDirectoryCleanup; a file whose upload never succeeded is kept
// and reported as an orphan rather than deleted.
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const P = require('./paths');

/**
 * File-mask matching lives in masks.js, which another module owns. Resolve it
 * lazily and, if it is absent or does not export what the contract says, fail
 * with a message that names the file — never fall back to a "close enough"
 * matcher, because a wrong mask silently sends a file to the wrong editor.
 */
let _masks = null;
function masks() {
  if (_masks) return _masks;
  let mod;
  try {
    mod = require('./masks');
  } catch (e) {
    throw new Error(`design/main/masks.js could not be loaded, so editor masks cannot be evaluated: ${e.message}`);
  }
  if (typeof mod.FileMask !== 'function') {
    throw new Error('design/main/masks.js does not export the FileMask matcher.');
  }
  // FileMask parses once and answers many items; the editor list is short and
  // stable, so the compiled masks are cached by their source string.
  const cache = new Map();
  _masks = {
    matches(mask, name, params) {
      let m = cache.get(mask);
      if (!m) { m = new mod.FileMask(mask); cache.set(mask, m); }
      return m.matches(name, params || {});
    },
  };
  return _masks;
}

const BOMS = [
  { name: 'utf8bom', bytes: [0xef, 0xbb, 0xbf], encoding: 'utf8' },
  { name: 'utf16le', bytes: [0xff, 0xfe], encoding: 'utf16le' },
  { name: 'utf16be', bytes: [0xfe, 0xff], encoding: 'utf16be' },
];

/**
 * Encoding detection, in the order WinSCP resolves it:
 *   a BOM wins; otherwise valid UTF-8 is UTF-8; otherwise the file is ANSI and
 *   we say so rather than mangling it into replacement characters.
 */
function detectEncoding(buf, preference) {
  for (const bom of BOMS) {
    if (buf.length >= bom.bytes.length && bom.bytes.every((b, i) => buf[i] === b)) {
      return { encoding: bom.name, bom: true, detected: true };
    }
  }
  if (preference && preference !== 'auto') return { encoding: preference, bom: preference === 'utf8bom', detected: false };
  return isValidUtf8(buf)
    ? { encoding: 'utf8', bom: false, detected: true }
    : { encoding: 'ansi', bom: false, detected: true };
}

/** A strict UTF-8 validator: Buffer#toString would happily invent U+FFFD. */
function isValidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let extra;
    if (b <= 0x7f) { i++; continue; }
    else if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else return false;
    if (i + extra >= buf.length) return false;
    for (let k = 1; k <= extra; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return false;
    }
    // Reject overlong and out-of-range sequences.
    if (extra === 2 && b === 0xe0 && buf[i + 1] < 0xa0) return false;
    if (extra === 3 && b === 0xf0 && buf[i + 1] < 0x90) return false;
    if (extra === 3 && b === 0xf4 && buf[i + 1] > 0x8f) return false;
    i += extra + 1;
  }
  return true;
}

function decode(buf, encoding) {
  const startsWith = (bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
  switch (encoding) {
    // A forced encoding describes how to interpret the bytes; it does not
    // promise that a BOM is present. Only consume a marker that is actually
    // there, otherwise a BOM-less file loses its first character(s).
    case 'utf8bom': return (startsWith([0xef, 0xbb, 0xbf]) ? buf.subarray(3) : buf).toString('utf8');
    case 'utf16le': return (startsWith([0xff, 0xfe]) ? buf.subarray(2) : buf).toString('utf16le');
    case 'utf16be': {
      const body = startsWith([0xfe, 0xff]) ? buf.subarray(2) : buf;
      const swapped = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
      swapped.swap16();
      return swapped.toString('utf16le') + (body.length % 2 ? '\ufffd' : '');
    }
    case 'ansi': return buf.toString('latin1');
    case 'utf8':
    default: return buf.toString('utf8');
  }
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be': {
      const b = Buffer.from(text, 'utf16le');
      b.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
    }
    case 'ansi': return Buffer.from(text, 'latin1');
    case 'utf8':
    default: return Buffer.from(text, 'utf8');
  }
}

/** Names that are legal on a server but not on Windows. */
function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '') || 'file';
}

let seq = 0;
function newEditorId() { return `e${Date.now().toString(36)}${(++seq).toString(36)}`; }

class EditorManager extends EventEmitter {
  /**
 * @param {object} deps
 * @param {object} deps.config    the Config store
 * @param {object} deps.sessions  the SessionManager
 * @param {object} deps.history   append-only history store (optional)
 * @param {()=>object} deps.historyState  current restorable app state (optional)
 * @param {(ch:string, payload:object)=>void} [deps.emit]
   */
  constructor(deps) {
    super();
    const d = deps || {};
    this.config = d.config;
    this.sessions = d.sessions;
    this.history = d.history || null;
    this.historyState = typeof d.historyState === 'function' ? d.historyState : (() => ({}));
    this._send = d.emit || (() => {});
    /** id -> editor record */
    this.open = new Map();
  }

  prefs() { return (this.config && this.config.prefs.editor) || {}; }
  globalPrefs() { return (this.config && this.config.prefs) || {}; }

  /**
   * Which editor handles this file, per prefs.editor.list — first matching
   * mask wins, exactly as WinSCP's editor list is ordered.
   */
  editorFor(fileName) {
    const list = this.prefs().list || [];
    for (const e of list) {
      const mask = e.mask || '*.*';
      if (masks().matches(mask, fileName, { isDir: false })) return { ...e, mask };
    }
    return { mask: '*.*', type: 'internal', external: '', externalParams: true };
  }

  /**
   * The temporary path for a remote file, honouring
   * prefs.temporaryDirectoryAppendSession / AppendPath / Deterministic.
   * Deterministic paths reuse the same file for the same remote path, which is
   * what "single editor per file" needs; otherwise each open gets its own
   * folder so two edits of the same name cannot fight.
   */
  tempPathFor(session, remotePath) {
    const g = this.globalPrefs();
    const parts = [P.temp()];
    if (g.temporaryDirectoryAppendSession) parts.push(safeName(session.name));
    if (g.temporaryDirectoryAppendPath) {
      const dir = session.adapter ? session.adapter.dirname(remotePath) : path.posix.dirname(remotePath);
      for (const seg of String(dir).split('/')) if (seg) parts.push(safeName(seg));
    }
    if (!g.temporaryDirectoryDeterministic) parts.push(`${Date.now().toString(36)}${(seq++).toString(36)}`);
    const dir = path.join(...parts);
    const base = session.adapter ? session.adapter.basename(remotePath) : path.posix.basename(remotePath);
    return path.join(dir, safeName(base));
  }

  // ------------------------------------------------------------- opening
  /**
   * Download a remote file and start editing it.
   *
   * @param {object} req
   * @param {string} req.sessionId
   * @param {string} req.remotePath
   * @param {'auto'|'internal'|'external'} [req.mode]
   * @param {string} [req.encoding]   force an encoding instead of detecting
   * @param {string} [req.external]   a specific external program
   */
  async openRemote(req) {
    const session = this.sessions.require(req.sessionId);
    const adapter = session.adapter;
    if (!adapter || !adapter.connected) {
      const e = new Error('The session is not connected.'); e.code = 'NOT_CONNECTED'; throw e;
    }
    const remotePath = adapter.normalize(req.remotePath);
    const fileName = adapter.basename(remotePath);

    // "Single editor" reuses the existing editor for a file already open.
    if (this.prefs().singleEditor !== false) {
      for (const rec of this.open.values()) {
        if (rec.sessionId === session.id && rec.remotePath === remotePath) {
          this.emit('focus', rec.id);
          this._send('event:editor', { type: 'focus', id: rec.id });
          return this.describe(rec);
        }
      }
    }
    if (this.open.size >= (this.prefs().maxEditors || 500)) {
      const e = new Error(`Too many editors are open (limit ${this.prefs().maxEditors || 500}).`);
      e.code = 'TOO_MANY_EDITORS';
      throw e;
    }

    const chosen = req.external
      ? { type: 'external', external: req.external, externalParams: true, mask: '(explicit)' }
      : (req.mode === 'internal' ? { type: 'internal', mask: '(explicit)' } : this.editorFor(fileName));
    const type = req.mode && req.mode !== 'auto' ? req.mode : (chosen.type === 'external' && chosen.external ? 'external' : 'internal');

    const stat = await adapter.stat(remotePath);
    const local = this.tempPathFor(session, remotePath);
    await fsp.mkdir(path.dirname(local), { recursive: true });

    const buf = await adapter.readFile(remotePath);
    await fsp.writeFile(local, buf);
    session.log.actions.record('download', { filename: remotePath, destination: local, size: String(buf.length) });
    session.log.add('info', `Opened ${remotePath} for editing (${type} editor).`);

    const enc = detectEncoding(buf, req.encoding || this.prefs().encoding || 'auto');
    const localStat = await fsp.stat(local);

    const rec = {
      id: newEditorId(),
      sessionId: session.id,
      remotePath,
      fileName,
      localPath: local,
      type,
      external: chosen.external || '',
      encoding: enc.encoding,
      encodingDetected: enc.detected,
      /** What the remote file looked like when we took our copy. The change
       *  check compares against exactly this. */
      remoteStamp: { size: stat.size, mtime: stat.mtime },
      localStamp: { size: localStat.size, mtimeMs: localStat.mtimeMs },
      openedAt: Date.now(),
      dirty: false,
      uploads: 0,
      lastError: null,
      watcher: null,
      changePromise: null,
      child: null,
      closed: false,
    };
    this.open.set(rec.id, rec);

    try {
      if (type === 'external') await this._launchExternal(rec, chosen);
      else this._watch(rec);   // an internal editor may still be a separate window
    } catch (e) {
      await this._rollbackOpen(rec);
      throw e;
    }

    this._send('event:editor', { type: 'opened', editor: this.describe(rec) });
    this.emit('opened', rec);
    return this.describe(rec);
  }

  /** Open a local file with the same machinery (no upload on save). */
  async openLocal(req) {
    const local = path.resolve(req.localPath);
    const buf = await fsp.readFile(local);
    const enc = detectEncoding(buf, req.encoding || this.prefs().encoding || 'auto');
    const st = await fsp.stat(local);
    const rec = {
      id: newEditorId(),
      sessionId: req.sessionId || '',
      remotePath: '',
      fileName: path.basename(local),
      localPath: local,
      type: req.mode === 'external' ? 'external' : 'internal',
      external: req.external || '',
      encoding: enc.encoding,
      encodingDetected: enc.detected,
      remoteStamp: null,
      localStamp: { size: st.size, mtimeMs: st.mtimeMs },
      openedAt: Date.now(),
      dirty: false,
      uploads: 0,
      lastError: null,
      watcher: null,
      changePromise: null,
      child: null,
      closed: false,
      localOnly: true,
    };
    this.open.set(rec.id, rec);
    try {
      if (rec.type === 'external') await this._launchExternal(rec, { external: rec.external, externalParams: true });
    } catch (e) {
      await this._rollbackOpen(rec);
      throw e;
    }
    this._send('event:editor', { type: 'opened', editor: this.describe(rec) });
    return this.describe(rec);
  }

  // ----------------------------------------------------- internal editor
  /** The text the internal editor should show, decoded with the chosen encoding. */
  async read(id) {
    const rec = this._require(id);
    const buf = await fsp.readFile(rec.localPath);
    return {
      id: rec.id,
      text: decode(buf, rec.encoding),
      encoding: rec.encoding,
      encodingDetected: rec.encodingDetected,
      fileName: rec.fileName,
      remotePath: rec.remotePath,
      bytes: buf.length,
    };
  }

  /** Re-decode an already-open file under a different encoding. */
  async setEncoding(id, encoding) {
    const rec = this._require(id);
    if (!['auto', 'utf8', 'utf8bom', 'utf16le', 'utf16be', 'ansi'].includes(encoding)) {
      throw new Error(`Unknown encoding: ${encoding}`);
    }
    const buf = await fsp.readFile(rec.localPath);
    rec.encoding = encoding === 'auto' ? detectEncoding(buf, 'auto').encoding : encoding;
    rec.encodingDetected = encoding === 'auto';
    return this.read(id);
  }

  /**
   * Save from the internal editor: write the temp file, then upload.
   * `force` skips the remote-changed check, and is only ever set because the
   * user answered the prompt that check raises.
   */
  async save(id, text, options) {
    const o = options || {};
    const rec = this._require(id);
    const buf = encode(text, rec.encoding);
    await fsp.writeFile(rec.localPath, buf);
    const st = await fsp.stat(rec.localPath);
    rec.localStamp = { size: st.size, mtimeMs: st.mtimeMs };
    rec.dirty = true;
    if (rec.localOnly || !rec.remotePath) {
      rec.dirty = false;
      this._send('event:editor', {
        type: 'saved', id: rec.id, local: true,
        sessionId: rec.sessionId, remotePath: rec.remotePath, localPath: rec.localPath,
      });
      return { uploaded: false, local: true };
    }
    return this.editedFileUploaded(rec.id, { force: o.force });
  }

  // -------------------------------------------------------------- upload
  /**
   * Push the temporary copy back. Before writing, the remote file is stat'ed
   * again and compared with what we downloaded; a difference means somebody
   * else wrote to it and the caller is told rather than overwritten.
   */
  async upload(id, options) {
    const o = options || {};
    const rec = this._require(id);
    const session = this.sessions.get(rec.sessionId);
    if (!session || !session.adapter || !session.adapter.connected) {
      rec.lastError = 'The session is no longer connected; the edit is kept in the temporary file.';
      this._send('event:editor', { type: 'error', id: rec.id, message: rec.lastError, localPath: rec.localPath });
      const e = new Error(rec.lastError); e.code = 'NOT_CONNECTED'; throw e;
    }
    const adapter = session.adapter;

    if (!o.force) {
      let current = null;
      try { current = await adapter.stat(rec.remotePath); } catch { current = null; }
      if (current && rec.remoteStamp && changedSince(rec.remoteStamp, current)) {
        const detail = {
          id: rec.id,
          remotePath: rec.remotePath,
          was: rec.remoteStamp,
          now: { size: current.size, mtime: current.mtime },
        };
        this._send('event:editor', { type: 'remote-changed', ...detail });
        this.emit('remote-changed', detail);
        const e = new Error('The remote file has changed since it was opened for editing.');
        e.code = 'REMOTE_CHANGED';
        e.detail = detail;
        throw e;
      }
      if (!current) {
        // Deleted while we were editing: uploading recreates it, which is
        // usually what the user wants — but they should know.
        this._send('event:editor', { type: 'remote-missing', id: rec.id, remotePath: rec.remotePath });
      }
    }

    const buf = await fsp.readFile(rec.localPath);
    await adapter.writeFile(rec.remotePath, buf);
    rec.uploads++;
    rec.dirty = false;
    rec.lastError = null;
    try {
      const after = await adapter.stat(rec.remotePath);
      rec.remoteStamp = { size: after.size, mtime: after.mtime };
    } catch {
      rec.remoteStamp = { size: buf.length, mtime: Date.now() };
    }
    session.invalidate(adapter.dirname(rec.remotePath));
    session.log.actions.record('upload', { filename: rec.localPath, destination: rec.remotePath, size: String(buf.length) });
    session.log.add('info', `Uploaded the edited ${rec.remotePath} (${buf.length} bytes).`);
    this._send('event:editor', {
      type: 'uploaded', id: rec.id, bytes: buf.length, uploads: rec.uploads,
      sessionId: rec.sessionId, remotePath: rec.remotePath, localPath: rec.localPath,
    });
    this.emit('uploaded', rec);
    return { uploaded: true, bytes: buf.length, uploads: rec.uploads };
  }

  /**
   * ExecutedFileChanged — the editor manager's file-watcher callback. Keep the
   * named seam public so an editor implementation that reports a save directly
   * can use the same debounce/check/upload path as an external editor.
   */
  async executedFileChanged(id) {
    return this._onFileChanged(this._require(id));
  }

  /**
   * EditedFileUploaded — the completion seam shared by save, the watcher and
   * the close/shutdown flush. It deliberately remains a thin call into upload:
   * the remote stamp is refreshed only after the server accepted the bytes.
   */
  async editedFileUploaded(id, options) {
    return this.upload(id, options);
  }

  // ----------------------------------------------------- external editor
  async _launchExternal(rec, chosen) {
    const program = (chosen && chosen.external) || rec.external;
    if (!program) {
      const e = new Error('No external editor is configured for this file.');
      e.code = 'NO_EXTERNAL_EDITOR';
      throw e;
    }
    const { command, args } = splitProgram(program, rec.localPath, chosen && chosen.externalParams !== false);

    // Watch BEFORE launching: a fast editor can save before spawn() resolves.
    this._watch(rec);

    let child;
    try {
      child = cp.spawn(command, args, { detached: false, windowsHide: false, stdio: 'ignore' });
    } catch (e) {
      this._unwatch(rec);
      throw new Error(`The external editor could not be started: ${e.message}`);
    }
    rec.child = child;

    // spawn() reports executable failures asynchronously. Do not publish an
    // editor record until the process has actually started, otherwise a bad
    // association leaves a watcher and plaintext temporary behind.
    await new Promise((resolve, reject) => {
      const onSpawn = () => { child.removeListener('error', onError); resolve(); };
      const onError = (e) => { child.removeListener('spawn', onSpawn); reject(new Error(`The external editor could not be started: ${e.message}`)); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    }).catch((e) => {
      rec.child = null;
      this._unwatch(rec);
      throw e;
    });

    child.on('error', (e) => {
      rec.lastError = `The external editor failed: ${e.message}`;
      this._send('event:editor', { type: 'error', id: rec.id, message: rec.lastError });
    });

    child.on('exit', async (code) => {
      rec.child = null;
      this._send('event:editor', { type: 'external-exited', id: rec.id, exitCode: code });
      // Some editors write on exit; give the watcher its debounce window
      // before deciding nothing changed. earlyClose is WinSCP's name for the
      // "the editor handed the file to an already-running instance and exited
      // immediately" case, where the process exiting means nothing.
      const early = (Date.now() - rec.openedAt) < (this.prefs().earlyClose || 2) * 1000;
      setTimeout(() => {
        if (rec.closed) return;
        if (early) {
          // Keep watching: the real editor is another process we do not own.
          this._send('event:editor', { type: 'external-detached', id: rec.id });
          return;
        }
        this._flushAndClose(rec).catch(() => { /* reported through events */ });
      }, 750);
    });
  }

  // ------------------------------------------------------------ watching
  /**
   * Watch the temporary file. `fs.watch` fires several times for one save on
   * Windows (truncate + write + rename), so changes are debounced and the
   * size/mtime pair is compared before anything is uploaded.
   */
  _watch(rec) {
    if (rec.watcher) return;
    let timer = null;
    let watcher;
    try {
      watcher = fs.watch(rec.localPath, { persistent: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.executedFileChanged(rec.id).catch(() => { /* reported through events */ }), 300);
      });
    } catch (e) {
      // Some filesystems cannot watch; fall back to polling, which is slower
      // but never silently stops noticing saves.
      const poll = setInterval(() => this.executedFileChanged(rec.id).catch(() => { /* reported */ }), 1500);
      rec.watcher = { close: () => clearInterval(poll) };
      this.emit('watch-fallback', { id: rec.id, reason: e.message });
      return;
    }
    watcher.on('error', () => { /* the file went away; close() cleans up */ });
    rec.watcher = { close: () => { if (timer) clearTimeout(timer); watcher.close(); } };
  }

  _unwatch(rec) {
    if (!rec.watcher) return;
    try { rec.watcher.close(); } catch { /* already closed */ }
    rec.watcher = null;
  }

  async _rollbackOpen(rec) {
    rec.closed = true;
    this._unwatch(rec);
    if (rec.child) { try { rec.child.kill(); } catch { /* already gone */ } rec.child = null; }
    this.open.delete(rec.id);
    await this._removeTemp(rec);
  }

  async _onFileChanged(rec) {
    // Windows can report truncate/write/rename as overlapping callbacks.
    // Queue them per editor so each callback observes the latest stamp only
    // after the previous upload/conflict check has settled.
    const previous = rec.changePromise || Promise.resolve();
    const current = previous.then(() => this._processFileChanged(rec));
    rec.changePromise = current.finally(() => {
      if (rec.changePromise === current) rec.changePromise = null;
    });
    return current;
  }

  async _processFileChanged(rec) {
    if (rec.closed) return { changed: false, reason: 'closed' };
    let st;
    try { st = await fsp.stat(rec.localPath); } catch { return { changed: false, reason: 'missing' }; }
    if (rec.localStamp && st.size === rec.localStamp.size && st.mtimeMs === rec.localStamp.mtimeMs) {
      return { changed: false, reason: 'unchanged' };
    }
    rec.localStamp = { size: st.size, mtimeMs: st.mtimeMs };
    rec.dirty = true;
    this._send('event:editor', {
      type: 'changed', id: rec.id, bytes: st.size,
      sessionId: rec.sessionId, remotePath: rec.remotePath, localPath: rec.localPath,
    });

    if (rec.localOnly || !rec.remotePath) return { changed: true, uploaded: false, local: true };
    try {
      const result = await this.editedFileUploaded(rec.id, {});
      return { changed: true, ...result };
    } catch (e) {
      if (e.code === 'REMOTE_CHANGED') return { changed: true, uploaded: false, conflict: true };
      rec.lastError = e.message;
      this._send('event:editor', {
        type: 'error', id: rec.id, message: e.message,
        sessionId: rec.sessionId, remotePath: rec.remotePath, localPath: rec.localPath,
      });
      return { changed: true, uploaded: false, error: e };
    }
  }

  // -------------------------------------------------------------- closing
  async _flushAndClose(rec) {
    if (rec.dirty && rec.remotePath && !rec.localOnly) {
      try { await this.editedFileUploaded(rec.id, {}); } catch { /* the close path reports the orphan */ }
    }
    return this.close(rec.id, {});
  }

  /**
   * Close an editor. Temporary files go away unless the user asked to keep
   * them, or unless the edit never made it to the server — an unsaved edit is
   * kept and reported as an orphan, because deleting it would destroy the only
   * copy of the user's work.
   */
  async close(id, options) {
    const o = options || {};
    const rec = this.open.get(id);
    if (!rec) return false;
    rec.closed = true;
    this._unwatch(rec);
    if (rec.child) { try { rec.child.kill(); } catch { /* already gone */ } rec.child = null; }
    this.open.delete(id);

    const keep = this.prefs().keepTemporaryFiles === true ||
      this.globalPrefs().temporaryDirectoryCleanup === false ||
      o.keep === true;
    const orphan = rec.dirty && !rec.localOnly;

    // A discard is itself an auditable user action. Write it before the close
    // notification and before deleting the record. History is best effort by
    // contract: a broken history repository must never trap the user's close.
    let discardAudit = orphan ? { status: 'not-recorded', reason: 'history-unavailable' } : null;
    if (orphan && this.history && typeof this.history.snapshot === 'function') {
      const state = this.historyState() || {};
      try {
        const result = await this.history.snapshot(`Discarded unsaved document "${rec.fileName}"`, {
          ...state,
          editorDiscard: {
            id: rec.id,
            fileName: rec.fileName,
            sessionId: rec.sessionId,
            remotePath: rec.remotePath,
            localPath: rec.localPath,
          },
        });
        discardAudit = result && result.ok === false
          ? { status: 'not-recorded', reason: 'history-write-failed', code: result.error && result.error.code }
          : { status: 'recorded' };
      } catch { discardAudit = { status: 'not-recorded', reason: 'history-write-failed' }; }
    }

    if (orphan) {
      this._send('event:editor', {
        type: 'orphan', id: rec.id, localPath: rec.localPath, remotePath: rec.remotePath,
        discardAudit,
        message: 'The edit was not uploaded; the temporary file has been kept.',
      });
    } else if (!keep && !rec.localOnly) {
      await this._removeTemp(rec);
    }

    this._send('event:editor', { type: 'closed', id: rec.id, orphan });
    this.emit('closed', rec);
    return true;
  }

  async _removeTemp(rec) {
    try {
      await fsp.unlink(rec.localPath);
      // Remove the folders we created for this file, but only while they are
      // empty and only inside our own temp root.
      let dir = path.dirname(rec.localPath);
      const root = path.resolve(P.temp());
      while (path.resolve(dir).startsWith(root) && path.resolve(dir) !== root) {
        const left = await fsp.readdir(dir);
        if (left.length) break;
        await fsp.rmdir(dir);
        dir = path.dirname(dir);
      }
    } catch { /* a temp file we cannot delete is not worth failing a close over */ }
  }

  /** Close everything — used on shutdown. Uploads pending edits first. */
  async closeAll() {
    const all = [...this.open.values()];
    for (const rec of all) {
      try { await this._flushAndClose(rec); } catch { await this.close(rec.id, {}); }
    }
  }

  /** Temporary files left behind by a previous run (prefs.editor.warnOrphans). */
  async findOrphans() {
    const root = P.temp();
    const out = [];
    const walk = async (dir) => {
      let items = [];
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { await walk(full); continue; }
        const inUse = [...this.open.values()].some((r) => r.localPath === full);
        if (inUse) continue;
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch { /* vanished between readdir and stat */ }
      }
    };
    await walk(root);
    return out;
  }

  /** Delete orphans the user chose to discard. Never touches anything outside temp. */
  async discardOrphans(paths) {
    const root = path.resolve(P.temp());
    let removed = 0;
    for (const p of paths || []) {
      const abs = path.resolve(p);
      if (!abs.startsWith(root + path.sep)) continue;   // refuse anything outside our own temp
      try { await fsp.unlink(abs); removed++; } catch { /* already gone */ }
    }
    return removed;
  }

  list() { return [...this.open.values()].map((r) => this.describe(r)); }

  describe(rec) {
    return {
      id: rec.id,
      sessionId: rec.sessionId,
      remotePath: rec.remotePath,
      localPath: rec.localPath,
      fileName: rec.fileName,
      type: rec.type,
      external: rec.external,
      encoding: rec.encoding,
      encodingDetected: rec.encodingDetected,
      dirty: rec.dirty,
      uploads: rec.uploads,
      openedAt: rec.openedAt,
      lastError: rec.lastError,
      localOnly: !!rec.localOnly,
    };
  }

  _require(id) {
    const rec = this.open.get(id);
    if (!rec) { const e = new Error(`No such editor: ${id}`); e.code = 'NO_SUCH_EDITOR'; throw e; }
    return rec;
  }
}

/** The remote file is different from the copy we took. */
function changedSince(was, now) {
  if (!was || !now) return false;
  if (Number(now.size) !== Number(was.size)) return true;
  // Servers report second resolution at best; a whole-second difference is a
  // real change, sub-second jitter is not.
  const a = Math.floor(Number(was.mtime || 0) / 1000);
  const b = Math.floor(Number(now.mtime || 0) / 1000);
  return a !== b;
}

/**
 * An external editor entry may be a bare path or a command line with
 * arguments, with or without a `!.!` placeholder for the file (WinSCP's
 * convention). Anything without a placeholder gets the file appended.
 */
function splitProgram(program, file, withParams) {
  const parts = tokenizeCommandLine(String(program));
  const command = parts.shift() || '';
  let args = withParams === false ? [] : parts;
  const PLACEHOLDER = /!\.!|"%1"|%1/;
  if (args.some((a) => PLACEHOLDER.test(a))) {
    args = args.map((a) => a.replace(/!\.!|"%1"|%1/g, file));
  } else {
    args = args.concat([file]);
  }
  return { command, args };
}

/** Split a command line respecting double quotes — Windows paths have spaces. */
function tokenizeCommandLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = {
  EditorManager,
  detectEncoding, isValidUtf8, decode, encode,
  splitProgram, tokenizeCommandLine, changedSince, safeName,
};
