// session.js — a live session: the adapter, its state, its log, and every
// question the protocol needs a human to answer.
//
// The rule that shapes this file: **nothing here ever answers a security
// question on the user's behalf.** An unknown host key, a changed host key, an
// untrusted certificate, a password, a passphrase, a keyboard-interactive
// challenge, a second factor — each one is sent to the renderer as a prompt
// with a correlation id and this module waits for the answer. There is no
// "accept if we cannot ask" path, because that is how a man in the middle gets
// through a file-transfer client.
//
// Adapters (design/main/protocols/*.js) receive this object as `session` and
// call back into it:
//
//   session.verifyHostKey({ host, port, algorithm, fingerprintSHA256, fingerprintMD5, keyType })
//        -> Promise<boolean>          accepted?
//   session.verifyCertificate({ host, port, subject, issuer, fingerprintSHA256, fingerprintSHA1,
//                               validFrom, validTo, errors })
//        -> Promise<boolean>
//   session.promptCredential({ kind, name, instructions, prompts:[{text, echo}] })
//        -> Promise<string[]|null>    null = the user cancelled
//   session.banner(text)              display a server banner
//   session.logLine(kind, text)       write to the session log
'use strict';
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const { SessionLog } = require('./logging');

/** Protocol name -> adapter module, resolved lazily so a session that never
 *  uses S3 does not pay for loading it (and a missing module is reported when
 *  it is actually needed, naming the file). */
const ADAPTERS = {
  local: './protocols/local',
  sftp: './protocols/sftp',
  scp: './protocols/scp',
  ftp: './protocols/ftp',
  ftps: './protocols/ftp',
  webdav: './protocols/webdav',
  s3: './protocols/s3',
};

const DEFAULT_PORTS = { sftp: 22, scp: 22, ftp: 21, webdav: 80, s3: 443, local: 0 };

/**
 * Require a sibling module and fail loudly when it is missing. Other agents own
 * the protocol backends; if one has not landed yet we say exactly which file is
 * absent instead of silently degrading into a stub that pretends to transfer
 * files.
 */
function requireAdapterModule(protocol) {
  const rel = ADAPTERS[String(protocol || '').toLowerCase()];
  if (!rel) throw new Error(`Unknown protocol "${protocol}". Expected one of: ${Object.keys(ADAPTERS).join(', ')}.`);
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(rel.replace('./', ''))) {
      throw new Error(`The ${protocol} backend is not available: design/main/${rel.slice(2)}.js could not be loaded (${e.message}).`);
    }
    throw e;
  }
}

/** Adapter modules may export the class directly or under a name. */
function adapterClassOf(mod, protocol) {
  if (typeof mod === 'function') return mod;
  const named = mod && (mod.Adapter || mod.default ||
    mod[protocol.toUpperCase() + 'Adapter'] ||
    mod[protocol[0].toUpperCase() + protocol.slice(1) + 'Adapter']);
  if (typeof named === 'function') return named;
  const fn = mod && Object.values(mod).find((v) => typeof v === 'function' && v.prototype && v.prototype.connect);
  if (fn) return fn;
  throw new Error(`The ${protocol} backend does not export an adapter class.`);
}

let seq = 0;
function newSessionId() { return `s${Date.now().toString(36)}${(++seq).toString(36)}`; }

const PROMPT_KINDS = new Set([
  'password', 'newPassword', 'passphrase', 'keyboardInteractive', 'twoFactor',
  'account', 'hostKey', 'certificate', 'custom',
]);

class Session extends EventEmitter {
  /**
   * @param {object} data  resolved site data (secrets already decrypted)
   * @param {object} deps  { config, emit, id }
   */
  constructor(data, deps) {
    super();
    const d = deps || {};
    this.id = d.id || newSessionId();
    this.config = d.config;
    this.data = { ...data };
    this.data.portNumber = Number(this.data.portNumber) || DEFAULT_PORTS[String(this.data.protocol || 'sftp').toLowerCase()] || 0;

    /** How the session talks to the outside world. Injected so this class is
     *  testable without Electron. */
    this._send = d.emit || (() => {});

    this.state = {
      status: 'closed',            // closed | connecting | connected | reconnecting | failed
      localPath: this.data.localDirectory || '',
      remotePath: this.data.remoteDirectory || '',
      selection: { local: [], remote: [] },
      view: {
        showHidden: undefined,     // undefined = follow the global preference
        sortBy: 'name',
        sortDesc: false,
        columns: null,
        viewStyle: null,
      },
      openedAt: 0,
      lastError: null,
    };

    this.log = new SessionLog({
      getPrefs: () => (this.config ? this.config.prefs.logging : {}),
      session: this.data,
      started: new Date(),
    });
    this.log.on('line', (rec) => this._send('event:log', { sessionId: this.id, line: rec }));
    // Everything the site could possibly leak, scrubbed for the life of the log.
    for (const f of ['password', 'passphrase', 'proxyPassword', 'tunnelPassword', 'tunnelPassphrase', 'encryptKey', 's3SessionToken']) {
      if (this.data[f]) this.log.registerSecret(this.data[f]);
    }

    this.adapter = null;
    this._pending = new Map();     // correlation id -> { resolve, reject, timer }
    this._promptSeq = 0;
    this._cache = new Map();       // remote dir -> { at, entries }
    this._reconnect = { attempts: 0, timer: null, wanted: false, startedAt: 0 };
    this._closing = false;
  }

  // ------------------------------------------------------------ identity
  get protocol() { return String(this.data.protocol || 'sftp').toLowerCase(); }
  get name() { return this.data.name || this.data.hostName || this.protocol; }
  get hostPort() { return `${this.data.hostName}:${this.data.portNumber}`; }
  get connected() { return !!(this.adapter && this.adapter.connected); }

  info() {
    return {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      hostName: this.data.hostName,
      portNumber: this.data.portNumber,
      userName: this.data.userName,
      color: this.data.color || '',
      status: this.state.status,
      connected: this.connected,
      openedAt: this.state.openedAt,
      caps: this.adapter ? { ...this.adapter.caps } : null,
      home: this.adapter ? this.adapter.home : '/',
      localPath: this.state.localPath,
      remotePath: this.state.remotePath,
      lastError: this.state.lastError,
    };
  }

  // ------------------------------------------------------------- prompts
  /**
   * Ask the renderer something and wait. Every security question in this file
   * goes through here; there is deliberately no default answer and no timeout
   * that resolves to "yes".
   */
  ask(kind, payload, options) {
    if (!PROMPT_KINDS.has(kind)) return Promise.reject(new Error(`Unknown prompt kind: ${kind}`));
    const o = options || {};
    const id = `${this.id}-p${++this._promptSeq}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, kind, timer: null };
      if (o.timeoutMs) {
        // A timeout CANCELS. It never accepts.
        entry.timer = setTimeout(() => {
          this._pending.delete(id);
          this.log.add('error', `The ${kind} prompt timed out and was cancelled.`);
          resolve(null);
        }, o.timeoutMs);
      }
      this._pending.set(id, entry);
      this._send('event:prompt', { sessionId: this.id, promptId: id, kind, payload });
      this.emit('prompt', { promptId: id, kind, payload });
    });
  }

  /** Called from IPC when the renderer answers. */
  answerPrompt(promptId, answer) {
    const entry = this._pending.get(promptId);
    if (!entry) return false;
    this._pending.delete(promptId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(answer === undefined ? null : answer);
    return true;
  }

  /** Cancel everything outstanding — on disconnect, or when the window closes. */
  _cancelPrompts(reason) {
    for (const [id, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this._pending.delete(id);
      entry.resolve(null);
      this._send('event:prompt-cancelled', { sessionId: this.id, promptId: id, reason: reason || 'cancelled' });
    }
  }

  // ---------------------------------------------- the adapter's callbacks
  logLine(kind, text) { return this.log.add(kind, text); }

  banner(text) {
    this.log.add('info', text);
    this._send('event:session', { sessionId: this.id, type: 'banner', text });
  }

  /**
   * Host-key verification. Ported behaviour:
   *   * a key we already trust for this host:port is accepted silently;
   *   * a key pinned in the site data (data.hostKey) is accepted silently;
   *   * ANY other key is shown to the user — new, or worse, changed — and the
   *     answer decides. There is no third path.
   */
  async verifyHostKey(key) {
    const hostPort = `${key.host || this.data.hostName}:${key.port || this.data.portNumber}`;
    const shown = key.fingerprintSHA256 || key.fingerprint || '';

    // A fingerprint pinned on the site itself (or supplied with /hostkey).
    const pinned = String(this.data.hostKey || '').trim();
    if (pinned && fingerprintMatches(pinned, key)) {
      this.log.add('info', `Host key for ${hostPort} matches the fingerprint configured for this site.`);
      return true;
    }

    const known = this.config ? this.config.knownHostKey(hostPort) : null;
    if (known && fingerprintMatches(known.fingerprint, key)) {
      this.log.add('debug', `Host key for ${hostPort} is already trusted.`);
      return true;
    }

    const changed = !!known;
    this.log.add(changed ? 'error' : 'info',
      `${changed ? 'The host key for' : 'Unknown host key for'} ${hostPort} (${key.algorithm || key.keyType || 'unknown'}): ${shown}` +
      (changed ? ` — it does NOT match the key stored on ${new Date(known.addedAt || 0).toISOString().slice(0, 10)}.` : ''));

    const answer = await this.ask('hostKey', {
      hostPort,
      changed,
      expected: changed ? known.fingerprint : '',
      expectedAlgorithm: changed ? known.algorithm : '',
      algorithm: key.algorithm || key.keyType || '',
      fingerprintSHA256: key.fingerprintSHA256 || '',
      fingerprintMD5: key.fingerprintMD5 || '',
      keyLength: key.keyLength || 0,
    });

    // answer: { accept: boolean, remember: boolean } — anything else is a no.
    if (!answer || !answer.accept) {
      this.log.add('error', `The host key for ${hostPort} was rejected.`);
      return false;
    }
    if (answer.remember && this.config) {
      this.config.rememberHostKey(hostPort, key.fingerprintSHA256 || key.fingerprint || '', key.algorithm || key.keyType || '');
      this.log.add('info', `The host key for ${hostPort} was accepted and stored.`);
    } else {
      this.log.add('info', `The host key for ${hostPort} was accepted for this session only.`);
    }
    return true;
  }

  /** TLS/SSL certificate verification. Same rule: the user decides. */
  async verifyCertificate(cert) {
    const hostPort = `${cert.host || this.data.hostName}:${cert.port || this.data.portNumber}`;
    const key = `cert:${hostPort}`;
    const known = this.config ? this.config.knownHostKey(key) : null;
    if (known && known.fingerprint && known.fingerprint === (cert.fingerprintSHA256 || cert.fingerprint)) {
      this.log.add('debug', `Certificate for ${hostPort} is already trusted.`);
      return true;
    }
    if (cert.trusted && (!cert.errors || !cert.errors.length)) {
      // Verified by the system trust store with no errors: nothing to ask.
      this.log.add('debug', `Certificate for ${hostPort} verified against the system trust store.`);
      return true;
    }

    this.log.add('error', `Certificate for ${hostPort} could not be verified: ${(cert.errors || ['unknown reason']).join('; ')}`);
    const answer = await this.ask('certificate', {
      hostPort,
      subject: cert.subject || '',
      issuer: cert.issuer || '',
      fingerprintSHA256: cert.fingerprintSHA256 || '',
      fingerprintSHA1: cert.fingerprintSHA1 || '',
      validFrom: cert.validFrom || '',
      validTo: cert.validTo || '',
      errors: cert.errors || [],
      pem: cert.pem || '',
    });
    if (!answer || !answer.accept) {
      this.log.add('error', `The certificate for ${hostPort} was rejected.`);
      return false;
    }
    if (answer.remember && this.config) {
      this.config.rememberHostKey(key, cert.fingerprintSHA256 || cert.fingerprint || '', 'certificate');
    }
    return true;
  }

  /**
   * Credentials. `kind` distinguishes password / passphrase / keyboard-
   * interactive / two-factor so the dialog can say what is actually being
   * asked for, and so a saved password is only ever reused for the one kind it
   * was saved for.
   */
  async promptCredential(request) {
    const kind = request && request.kind ? request.kind : 'password';
    const prompts = (request && request.prompts) || [{ text: 'Password:', echo: false }];

    // A stored password answers the FIRST connection's password prompt only.
    // Re-prompting on a retry is deliberate: silently replaying a wrong stored
    // password is how accounts get locked out.
    if (kind === 'password' && this.data.password && !this._passwordUsed) {
      this._passwordUsed = true;
      this.log.add('debug', 'Using the stored password for this site.');
      return [this.data.password];
    }
    if (kind === 'passphrase' && this.data.passphrase && !this._passphraseUsed) {
      this._passphraseUsed = true;
      this.log.add('debug', 'Using the stored key passphrase for this site.');
      return [this.data.passphrase];
    }

    const answer = await this.ask(kind === 'keyboardInteractive' || kind === 'twoFactor' ? kind : (kind === 'newPassword' ? 'newPassword' : (kind === 'passphrase' ? 'passphrase' : (kind === 'account' ? 'account' : 'password'))), {
      name: request.name || this.name,
      instructions: request.instructions || '',
      prompts: prompts.map((p) => ({ text: p.text, echo: !!p.echo })),
      userName: this.data.userName,
      hostPort: this.hostPort,
      canRemember: kind === 'password' || kind === 'passphrase',
    });

    if (!answer || !Array.isArray(answer.results)) {
      this.log.add('error', 'The credential prompt was cancelled.');
      return null;
    }
    // The answers are secrets from this moment on.
    for (const r of answer.results) this.log.registerSecret(r);
    if (answer.remember && this.config && this.data.id) {
      const field = kind === 'passphrase' ? 'passphrase' : 'password';
      this.config.updateSite(this.data.id, { [field]: answer.results[0], savePassword: true });
    }
    return answer.results;
  }

  // ------------------------------------------------------------- connect
  async connect() {
    if (this.connected) return this.info();
    this._closing = false;
    this.state.status = 'connecting';
    this.state.lastError = null;
    this._emitState();

    this.log.startupInfo({ version: (this.config && this.config.appVersion) || '' });
    this.log.add('info', `Connecting to ${this.hostPort} over ${this.protocol.toUpperCase()}…`);

    try {
      const mod = requireAdapterModule(this.protocol);
      const Cls = adapterClassOf(mod, this.protocol);
      this.adapter = new Cls(this);
      this._wireAdapter(this.adapter);

      await this.adapter.connect(this.data);
      this.adapter.connected = true;

      this.state.status = 'connected';
      this.state.openedAt = Date.now();
      this._reconnect.attempts = 0;
      if (!this.state.remotePath) {
        this.state.remotePath = this.data.remoteDirectory ||
          (this.config && this.config.prefs.defaultDirIsHome === false ? '/' : (this.adapter.home || '/'));
      }
      this.log.add('info', `Connected. ${this.adapter.protocolName} — ${describeServer(this.adapter.serverInfo)}`);
      this.log.actions.record('cwd', { path: this.state.remotePath });
      this._emitState();
      return this.info();
    } catch (e) {
      this.state.status = 'failed';
      this.state.lastError = { message: e.message, code: e.code || 'CONNECT_FAILED' };
      this.log.exception(e);
      this._emitState();
      this._scheduleReconnect(e);
      throw e;
    }
  }

  _wireAdapter(a) {
    a.on('log', (kind, text) => this.log.add(kind, text));
    a.on('banner', (text) => this.banner(text));
    a.on('progress', (p) => this._send('event:progress', { sessionId: this.id, ...p }));
    a.on('close', (reason) => this._onAdapterClosed(reason));
    a.on('error', (e) => {
      this.log.exception(e);
      this._send('event:session', { sessionId: this.id, type: 'error', message: e.message });
    });
  }

  _onAdapterClosed(reason) {
    if (this.adapter) this.adapter.connected = false;
    if (this._closing) return;
    this.state.status = 'closed';
    this.log.add('error', `The connection was closed${reason ? `: ${reason}` : '.'}`);
    this._emitState();
    this._scheduleReconnect(new Error(reason || 'Connection closed'));
  }

  /**
   * Automatic reconnect, per prefs.security.sessionReopen*:
   *   sessionReopenAuto        ms between attempts for a foreground session
   *   sessionReopenBackground  ms between attempts for a queue-only session
   *   sessionReopenTimeout     total ms to keep trying; 0 = forever
   *   sessionReopenAutoStall   ms of no data before a stalled session counts as
   *                            broken; 0 = never
   */
  _scheduleReconnect(cause) {
    const sec = (this.config && this.config.prefs.security) || {};
    const delay = Number(sec.sessionReopenAuto) || 0;
    if (!delay || this._closing || !this._reconnectWanted()) return;

    if (!this._reconnect.startedAt) this._reconnect.startedAt = Date.now();
    const budget = Number(sec.sessionReopenTimeout) || 0;
    if (budget && Date.now() - this._reconnect.startedAt > budget) {
      this.log.add('error', 'Giving up reconnecting: the reconnect timeout elapsed.');
      this._reconnect.startedAt = 0;
      return;
    }

    this._reconnect.attempts++;
    this.state.status = 'reconnecting';
    this._emitState();
    this.log.add('info', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnect.attempts})… — ${cause ? cause.message : ''}`);

    if (this._reconnect.timer) clearTimeout(this._reconnect.timer);
    this._reconnect.timer = setTimeout(() => {
      this._reconnect.timer = null;
      // Reset the one-shot credential flags: a reconnect legitimately needs to
      // authenticate again, and the stored password is the right first answer.
      this._passwordUsed = false;
      this._passphraseUsed = false;
      this.connect().catch(() => { /* connect() already logged and rescheduled */ });
    }, delay);
  }

  _reconnectWanted() {
    // Never auto-reconnect a session the user deliberately closed, and never
    // for the local backend (there is nothing to reconnect to).
    return this.protocol !== 'local' && !this._closing;
  }

  /** Reconnect now, on the user's command. */
  async reconnect() {
    if (this._reconnect.timer) { clearTimeout(this._reconnect.timer); this._reconnect.timer = null; }
    this._reconnect.attempts = 0;
    this._reconnect.startedAt = 0;
    this._passwordUsed = false;
    this._passphraseUsed = false;
    await this.disconnect({ keepOpen: true });
    return this.connect();
  }

  async disconnect(options) {
    const o = options || {};
    this._closing = !o.keepOpen;
    if (this._reconnect.timer) { clearTimeout(this._reconnect.timer); this._reconnect.timer = null; }
    this._cancelPrompts('disconnected');
    if (this.adapter) {
      try { await this.adapter.disconnect(); } catch (e) { this.log.debug(`Disconnect: ${e.message}`); }
      this.adapter.removeAllListeners();
      this.adapter = null;
    }
    this._cache.clear();
    this.state.status = 'closed';
    this.log.add('info', 'Session closed.');
    this._emitState();
    if (!o.keepOpen) {
      this.log.close();
      this.emit('closed');
    }
  }

  _emitState() {
    this._send('event:session', { sessionId: this.id, type: 'state', info: this.info() });
    this.emit('state', this.info());
  }

  // ------------------------------------------------------- directory cache
  /** Remote listings are cached per session so navigating back is instant. */
  async list(remotePath, options) {
    const o = options || {};
    this._requireAdapter();
    const p = this.adapter.normalize(remotePath || this.state.remotePath || '/');
    const useCache = this.data.cacheDirectories !== false && !o.refresh;
    if (useCache) {
      const hit = this._cache.get(p);
      if (hit) { this.log.debug(`Directory listing for ${p} served from the cache.`); return hit.entries; }
    }
    const entries = await this.adapter.list(p);
    if (this.data.cacheDirectories !== false) this._cache.set(p, { at: Date.now(), entries });
    this.log.actions.record('ls', { destination: p });
    return entries;
  }

  /** After a write, the affected directory's cached listing is a lie. */
  invalidate(remotePath) {
    if (!remotePath) { this._cache.clear(); return; }
    if (!this.adapter) { this._cache.clear(); return; }
    const p = this.adapter.normalize(remotePath);
    this._cache.delete(p);
    this._cache.delete(this.adapter.dirname(p));
  }

  clearCache() { this._cache.clear(); }

  cacheInfo() {
    return [...this._cache.entries()].map(([p, v]) => ({ path: p, at: v.at, count: v.entries.length }));
  }

  _requireAdapter() {
    if (!this.adapter || !this.adapter.connected) {
      const e = new Error('The session is not connected.');
      e.code = 'NOT_CONNECTED';
      throw e;
    }
    return this.adapter;
  }

  // ------------------------------------------------------------ per-session
  setState(patch) {
    const p = patch || {};
    if (typeof p.localPath === 'string') this.state.localPath = p.localPath;
    if (typeof p.remotePath === 'string') {
      this.state.remotePath = p.remotePath;
      this.log.actions.record('cwd', { path: p.remotePath });
    }
    if (p.selection) this.state.selection = { ...this.state.selection, ...p.selection };
    if (p.view) this.state.view = { ...this.state.view, ...p.view };
    // "Remember last used directory" is per site, not per window.
    if (this.data.updateDirectories !== false && this.config && this.data.id) {
      this.config.updateSite(this.data.id, {
        localDirectory: this.state.localPath,
        remoteDirectory: this.state.remotePath,
      });
    }
    this._emitState();
    return this.state;
  }

  getState() { return { ...this.state, id: this.id }; }

  // ------------------------------------------------------ change password
  /**
   * Change the account password on the server. SSH exposes this through the
   * authentication layer; a protocol that cannot do it says so rather than
   * pretending to succeed.
   */
  async changePassword(oldPassword, newPassword) {
    const a = this._requireAdapter();
    if (typeof a.changePassword !== 'function') {
      const e = new Error(`${a.protocolName} cannot change the account password.`);
      e.code = 'NOT_SUPPORTED';
      throw e;
    }
    this.log.registerSecret(newPassword);
    this.log.add('info', 'Changing the account password…');
    await a.changePassword(oldPassword, newPassword);
    this.log.add('info', 'The account password was changed.');
    // The stored password is now wrong; update it only if one was stored.
    if (this.config && this.data.id && this.data.savePassword) {
      this.config.updateSite(this.data.id, { password: newPassword, savePassword: true });
    }
    this.data.password = newPassword;
    return true;
  }

  // ---------------------------------------------------------- session URL
  /**
   * GenerateUrl.dfm: the session URL / script / .NET assembly code the user
   * copies out. `flags` mirrors WinSCP's sufXxx set.
   */
  generateUrl(flags) {
    const f = {
      userName: true, password: false, hostKey: false, winscpSpecific: false,
      remoteDirectory: false, rawSettings: false, ...(flags || {}),
    };
    const d = this.data;
    const proto = this.protocol === 'ftp' && d.ftps && d.ftps !== 'none' ? 'ftps' : this.protocol;
    let url = f.winscpSpecific ? 'winscp-' : '';
    url += `${proto}://`;
    if (f.userName && d.userName) {
      url += encodeURIComponent(d.userName);
      if (f.password && d.password) url += ':' + encodeURIComponent(d.password);
      if (f.hostKey && d.hostKey) url += `;fingerprint=${encodeURIComponent(d.hostKey)}`;
      if (f.rawSettings) {
        for (const [k, v] of Object.entries(this._rawSettingsForUrl())) {
          url += `;${encodeURIComponent(k.toLowerCase())}=${encodeURIComponent(String(v))}`;
        }
      }
      url += '@';
    }
    const host = String(d.hostName || '');
    url += host.includes(':') ? `[${host}]` : encodeURIComponent(host);
    if (d.portNumber && d.portNumber !== DEFAULT_PORTS[this.protocol]) url += ':' + d.portNumber;
    url += '/';
    if (f.remoteDirectory && this.state.remotePath && this.state.remotePath !== '/') {
      url += this.state.remotePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    }
    return url;
  }

  /** Only the settings that actually differ from the protocol's defaults. */
  _rawSettingsForUrl() {
    const d = this.data;
    const out = {};
    if (d.ftps && d.ftps !== 'none') out.Ftps = d.ftps;
    if (d.ftpPasvMode === false) out.FtpPasvMode = 0;
    if (d.compression) out.Compression = 1;
    if (d.publicKeyFile) out.PublicKeyFile = d.publicKeyFile;
    if (d.s3DefaultRegion) out.S3DefaultRegion = d.s3DefaultRegion;
    if (d.timeout && d.timeout !== 15) out.Timeout = d.timeout;
    return out;
  }

  /**
   * The other tabs of GenerateUrl: a scripting snippet and a .NET snippet.
   * The password is only ever included when explicitly requested, and the
   * caller is told so it can put the warning next to the box.
   */
  generateCode(kind, flags) {
    const f = { userName: true, password: false, hostKey: true, ...(flags || {}) };
    const d = this.data;
    const url = this.generateUrl({ ...f, winscpSpecific: false });
    const includesSecret = !!(f.password && d.password);
    switch (String(kind || 'url')) {
      case 'script': {
        const lines = [
          'open ' + quoteScript(url) +
            (f.hostKey && d.hostKey ? ` -hostkey=${quoteScript(d.hostKey)}` : '') +
            (d.publicKeyFile ? ` -privatekey=${quoteScript(d.publicKeyFile)}` : ''),
          this.state.remotePath && this.state.remotePath !== '/' ? `cd ${quoteScript(this.state.remotePath)}` : '',
          'exit',
        ].filter(Boolean);
        return { kind: 'script', text: lines.join('\n'), includesSecret };
      }
      case 'net': {
        const text = [
          'var sessionOptions = new SessionOptions',
          '{',
          `    Protocol = Protocol.${netProtocol(this.protocol)},`,
          `    HostName = ${csString(d.hostName)},`,
          d.portNumber && d.portNumber !== DEFAULT_PORTS[this.protocol] ? `    PortNumber = ${d.portNumber},` : '',
          d.userName ? `    UserName = ${csString(d.userName)},` : '',
          f.password && d.password ? '    Password = /* supply at run time */ null,' : '',
          f.hostKey && d.hostKey ? `    SshHostKeyFingerprint = ${csString(d.hostKey)},` : '',
          '};',
          '',
          'using (var session = new Session())',
          '{',
          '    session.Open(sessionOptions);',
          '}',
        ].filter((l) => l !== '').join('\n');
        // The .NET snippet deliberately never embeds the password literal:
        // generated code gets pasted into repositories.
        return { kind: 'net', text, includesSecret: false };
      }
      default:
        return { kind: 'url', text: url, includesSecret };
    }
  }

  // ------------------------------------------------------ file system info
  /**
   * FileSystemInfo.dfm: what the server is, what it can do, and how much room
   * is left. Capabilities come from the adapter's `caps` so the dialog and the
   * greyed-out commands can never disagree.
   */
  async fileSystemInfo(spacePath) {
    const a = this._requireAdapter();
    const si = a.serverInfo || {};
    const info = {
      protocol: a.protocolName,
      protocolBaseName: this.protocol,
      remoteSystem: si.remoteSystem || si.system || '',
      serverVersion: si.version || si.serverVersion || '',
      serverSoftware: si.software || '',
      sessionProtocol: si.sessionProtocol || '',
      cryptographicProtocol: si.cryptographicProtocol || '',
      compression: si.compression || '',
      hostKey: si.hostKey || null,
      certificate: si.certificate || null,
      additional: si.additional || {},
      capabilities: { ...a.caps },
      home: a.home,
      space: null,
    };
    if (a.caps.spaceInfo) {
      try {
        info.space = await a.spaceInfo(spacePath || this.state.remotePath || '/');
      } catch (e) {
        info.spaceError = e.message;
      }
    }
    return info;
  }

  /** Run a remote command through the adapter. */
  async exec(command, options) {
    const a = this._requireAdapter();
    if (!a.caps.exec) {
      const e = new Error(`${a.protocolName} cannot execute remote commands.`);
      e.code = 'NOT_SUPPORTED';
      throw e;
    }
    this.log.add('send', command);
    const res = await a.exec(command, options);
    this.log.actions.record('call', { command }, res && res.exitCode ? { ok: false, message: `Exit code ${res.exitCode}` } : { ok: true });
    return res;
  }
}

// ------------------------------------------------------------- helpers

function fingerprintMatches(stored, key) {
  if (!stored) return false;
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^ssh-[a-z0-9-]+\s+/i, '').replace(/^sha256:/, '');
  const want = norm(stored);
  return [key.fingerprintSHA256, key.fingerprintMD5, key.fingerprint]
    .filter(Boolean).some((f) => norm(f) === want);
}

function describeServer(si) {
  if (!si) return 'server details unavailable';
  return [si.software, si.version, si.remoteSystem].filter(Boolean).join(' ') || 'server details unavailable';
}

function quoteScript(s) { return `"${String(s).replace(/"/g, '""')}"`; }
function csString(s) { return `"${String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function netProtocol(p) {
  switch (p) {
    case 'sftp': return 'Sftp';
    case 'scp': return 'Scp';
    case 'ftp': return 'Ftp';
    case 'webdav': return 'Webdav';
    case 's3': return 'S3';
    default: return 'Sftp';
  }
}

// ========================================================= SessionManager

/** Every open session, addressable by id. Sessions are independent: one
 *  reconnecting does not stall another, and closing one never touches another's
 *  cache or log. */
class SessionManager extends EventEmitter {
  constructor(deps) {
    super();
    const d = deps || {};
    this.config = d.config;
    this._send = d.emit || (() => {});
    this.sessions = new Map();
  }

  /**
   * @param {object} siteOrData  a site id, or full session data
   */
  async open(siteOrData, options) {
    const o = options || {};
    let data = siteOrData;
    if (typeof siteOrData === 'string') {
      data = this.config ? this.config.resolveSite(siteOrData) : null;
      if (!data) throw new Error(`No such site: ${siteOrData}`);
    }
    const s = new Session(data, { config: this.config, emit: this._send });
    this.sessions.set(s.id, s);
    s.once('closed', () => this.sessions.delete(s.id));
    this.emit('opened', s);
    if (o.connect !== false) {
      try {
        await s.connect();
      } catch (e) {
        // Keep the session object so the UI can show the error and offer
        // Reconnect; a failed connect is not a reason to lose the tab.
        this.emit('failed', s, e);
        if (o.closeOnFailure) { this.sessions.delete(s.id); throw e; }
        throw e;
      }
    }
    return s;
  }

  get(id) { return this.sessions.get(id) || null; }
  require(id) {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error(`No such session: ${id}`); e.code = 'NO_SUCH_SESSION'; throw e; }
    return s;
  }

  list() { return [...this.sessions.values()].map((s) => s.info()); }

  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.disconnect();
    this.sessions.delete(id);
    this.emit('closed', id);
    return true;
  }

  /** Shutdown: close every session, in parallel, and never hang on one. */
  async closeAll() {
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => s.disconnect().catch(() => undefined)));
    this.sessions.clear();
  }

  /** A workspace is the open sessions plus where each one is looking. */
  snapshotWorkspace() {
    return [...this.sessions.values()].map((s) => ({
      siteId: s.data.id || '',
      name: s.name,
      protocol: s.protocol,
      hostName: s.data.hostName,
      userName: s.data.userName,
      localPath: s.state.localPath,
      remotePath: s.state.remotePath,
    }));
  }
}

/** Resolve a local path that came from the renderer, refusing to escape root. */
function safeLocalPath(root, candidate) {
  const abs = path.resolve(root || process.cwd(), candidate || '');
  const base = path.resolve(root || process.cwd());
  if (base !== abs && !abs.startsWith(base + path.sep)) {
    const e = new Error('The path is outside the allowed root.');
    e.code = 'PATH_OUTSIDE_ROOT';
    throw e;
  }
  return abs;
}

/** True when a local path exists and is a directory. */
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { Session, SessionManager, safeLocalPath, isDir, DEFAULT_PORTS, ADAPTERS };
