// logging.js — the session log and the XML actions log.
//
// Three consumers, one writer:
//   * the log panel, which reads the in-memory ring (prefs.logging.logWindowLines);
//   * the log file, rotated the way WinSCP rotates it (logMaxSize / logMaxCount);
//   * the XML actions log, which is what scripting users diff and parse.
//
// REDACTION IS NOT OPTIONAL. Passwords, passphrases, tokens and key material
// are scrubbed before a line reaches any of the three, unless the user has
// explicitly turned on prefs.logging.logSensitive — and even then a private key
// body is never written, because "I wanted verbose logs" is not a decision to
// publish a private key into a file that gets attached to a forum post.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

/** WinSCP's line marks: see LogLineMarks in core/SessionInfo.cpp. */
const MARKS = { recv: '<', send: '>', error: '!', info: '.', debug: '*' };

/** Minimum log level at which each kind of line is written. */
const LEVEL_OF = { error: 0, info: 0, send: 0, recv: 0, debug: 1, debug2: 2 };

/** Always redacted, at every level, whatever logSensitive says. */
const KEY_BODY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PUTTY_KEY_RE = /(Private-Lines:\s*\d+\r?\n)(?:[A-Za-z0-9+/=]+\r?\n?)+/g;

/** Patterns that carry a secret in their value. */
const SENSITIVE_LINE_RES = [
  // FTP: `PASS hunter2`, `ACCT x`, `ADAT ...`
  [/^(\s*[>]?\s*(?:PASS|ACCT|ADAT)\s+)(\S.*)$/gim, '$1***'],
  // HTTP/WebDAV/S3 authorization headers and presigned signatures
  [/(Authorization:\s*\S+\s+)(\S+)/gi, '$1***'],
  [/(X-Amz-Signature=)[A-Za-z0-9]+/gi, '$1***'],
  [/(Proxy-Authorization:\s*\S+\s+)(\S+)/gi, '$1***'],
  // key=value forms that name themselves
  [/((?:password|passphrase|secret|token|credential|apikey|api_key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***'],
  // a URL with inline credentials
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]+@/gi, '$1:***@'],
];

const REDACTED = '***';

/**
 * `!` placeholders in prefs.logging.logFileName / actionsLogFileName.
 * Ported from GetExpandedLogFileName in core/SessionData.cpp:
 *   !Y year  !M month  !D day  !T hhmmss  !P pid  !@ host  !S session  !! a `!`
 * `%VAR%` environment variables are expanded first, as WinSCP does.
 */
function expandLogFileName(template, started, session) {
  const when = started instanceof Date ? started : new Date(started || Date.now());
  const two = (n) => String(n).padStart(2, '0');

  let s = String(template || '').replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name] || process.env[name.toUpperCase()];
    return v === undefined ? m : v;
  });
  // Strip quotes the way StripPathQuotes does — an old config may still carry them.
  s = s.replace(/^"(.*)"$/, '$1');

  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '!' || i + 1 >= s.length) { out += s[i]; continue; }
    const c = s[i + 1];
    let rep;
    switch (c.toLowerCase()) {
      case 'y': rep = String(when.getFullYear()); break;
      case 'm': rep = two(when.getMonth() + 1); break;
      case 'd': rep = two(when.getDate()); break;
      case 't': rep = two(when.getHours()) + two(when.getMinutes()) + two(when.getSeconds()); break;
      case 'p': rep = String(process.pid); break;
      case '@': rep = validFileName((session && session.hostName) || 'nohost'); break;
      case 's': rep = validFileName((session && (session.name || session.sessionName)) || 'nosession'); break;
      case '!': rep = '!'; break;
      default: rep = '!' + c; break;
    }
    out += rep;
    i++;
  }
  return out;
}

/** MakeValidFileName — a host name is not automatically a legal file name. */
function validFileName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_') || 'x';
}

function pad3(n) { return String(n).padStart(3, '0'); }

function timestamp(d) {
  const t = d || new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ` +
    `${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}.${pad3(t.getMilliseconds())}`;
}

function xmlEscape(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters are not legal in XML 1.0 and silently corrupt the file.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function xmlTime(ms) { return new Date(ms || Date.now()).toISOString(); }

// ============================================================== SessionLog

class SessionLog extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => object} deps.getPrefs   supplies prefs.logging
   * @param {object} [deps.session]        { name, hostName } for the placeholders
   * @param {Date}   [deps.started]
   */
  constructor(deps) {
    super();
    const d = deps || {};
    this.getPrefs = d.getPrefs || (() => ({}));
    this.session = d.session || {};
    this.started = d.started || new Date();

    this.ring = [];
    this._seq = 0;

    this._fd = null;
    this._fileName = '';
    this._fileSize = 0;
    this._fileTemplate = '';
    this._fileBroken = false;   // one open failure disables the file, not the log

    /** Literal secrets registered for this session; always scrubbed. */
    this._secrets = new Set();

    this.actions = new ActionsLog({ getPrefs: this.getPrefs, session: this.session, started: this.started, log: this });
  }

  prefs() {
    const p = this.getPrefs() || {};
    return {
      enabled: !!p.enabled,
      level: Number(p.level) || 0,
      logToFile: !!p.logToFile,
      logFileName: p.logFileName || '',
      logFileAppend: p.logFileAppend !== false,
      logMaxSize: Number(p.logMaxSize) || 0,
      logMaxCount: Number(p.logMaxCount) || 0,
      logSensitive: !!p.logSensitive,
      logWindowLines: Number(p.logWindowLines) || 800,
      actionsLogging: !!p.actionsLogging,
      actionsLogFileName: p.actionsLogFileName || '',
    };
  }

  /**
   * Register a literal secret so it is scrubbed wherever it appears, including
   * inside a URL or a command line we did not construct ourselves.
   */
  registerSecret(value) {
    if (typeof value === 'string' && value.length >= 3) this._secrets.add(value);
    return this;
  }

  forgetSecrets() { this._secrets.clear(); }

  /** The one place a line can become safe to write. */
  redact(text, prefs) {
    let s = String(text === undefined || text === null ? '' : text);

    // Never, under any setting. A verbose log is not a reason to spill a key.
    s = s.replace(KEY_BODY_RE, '-----BEGIN PRIVATE KEY----- ' + REDACTED + ' -----END PRIVATE KEY-----');
    s = s.replace(PUTTY_KEY_RE, (m, head) => head + REDACTED + '\n');

    const p = prefs || this.prefs();
    if (p.logSensitive) return s;

    for (const [re, rep] of SENSITIVE_LINE_RES) s = s.replace(re, rep);
    for (const secret of this._secrets) {
      if (!secret) continue;
      s = s.split(secret).join(REDACTED);
    }
    return s;
  }

  /**
   * Add a line. `kind` is one of recv/send/error/info/debug/debug2 and decides
   * both the mark WinSCP writes and the level at which the line appears.
   */
  add(kind, text) {
    const p = this.prefs();
    if (!p.enabled) return null;
    const need = LEVEL_OF[kind] === undefined ? 0 : LEVEL_OF[kind];
    if (need > p.level) return null;

    const safe = this.redact(text, p);
    const when = new Date();

    // A multi-line message becomes multiple log lines, as DoAdd does. A
    // trailing newline is a terminator, not an extra blank line.
    const lines = safe.split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    let last = null;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const rec = { seq: ++this._seq, at: when.getTime(), kind, mark: MARKS[kind] || MARKS.info, text: line };
      this._pushRing(rec, p);
      this._writeFile(rec, p);
      this.emit('line', rec);
      last = rec;
    }
    return last;
  }

  info(t) { return this.add('info', t); }
  error(t) { return this.add('error', t); }
  send(t) { return this.add('send', t); }
  recv(t) { return this.add('recv', t); }
  debug(t) { return this.add('debug', t); }
  debug2(t) { return this.add('debug2', t); }

  /** An exception, with its stack only at debug level. */
  exception(e) {
    this.add('error', e && e.message ? e.message : String(e));
    if (e && e.stack) this.add('debug', e.stack);
  }

  _pushRing(rec, p) {
    this.ring.push(rec);
    const max = Math.max(50, p.logWindowLines);
    if (this.ring.length > max) this.ring.splice(0, this.ring.length - max);
  }

  /** The log panel's view. `since` is a sequence number, so polling is cheap. */
  window(since) {
    if (!since) return this.ring.slice();
    return this.ring.filter((r) => r.seq > since);
  }

  clearWindow() { this.ring.length = 0; this.emit('cleared'); }

  // -------------------------------------------------------------- the file
  _openFile(p) {
    if (this._fd !== null || this._fileBroken) return;
    const name = expandLogFileName(p.logFileName, this.started, this.session);
    if (!name) { this._fileBroken = true; return; }
    try {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      this._fd = fs.openSync(name, p.logFileAppend ? 'a' : 'w');
      this._fileName = name;
      this._fileTemplate = p.logFileName;
      try { this._fileSize = fs.fstatSync(this._fd).size; } catch { this._fileSize = 0; }
      this.emit('file-opened', name);
      this._checkSize(0, p);
    } catch (e) {
      // Failing to open the log must not take the session with it: report it
      // once, keep the in-memory ring, and stop retrying every single line.
      this._fileBroken = true;
      this._fd = null;
      this.emit('file-error', e);
    }
  }

  _closeFile() {
    if (this._fd === null) return;
    try { fs.closeSync(this._fd); } catch { /* closing a broken fd is not news */ }
    this._fd = null;
  }

  _writeFile(rec, p) {
    if (!p.logToFile || !p.logFileName) return;
    // A changed template means a different file: reopen rather than keep
    // appending to the old one.
    if (this._fd !== null && this._fileTemplate !== p.logFileName) { this._closeFile(); this._fileBroken = false; }
    if (this._fd === null) this._openFile(p);
    if (this._fd === null) return;

    const line = Buffer.from(`${rec.mark} ${timestamp(new Date(rec.at))} ${rec.text}\r\n`, 'utf8');
    this._checkSize(line.length, p);
    if (this._fd === null) return;
    try {
      fs.writeSync(this._fd, line);
      this._fileSize += line.length;
    } catch (e) {
      this._fileBroken = true;
      this._closeFile();
      this.emit('file-error', e);
    }
  }

  /**
   * TSessionLog::CheckSize — when the file would pass logMaxSize, close it and
   * shift `name` -> `name.1` -> `name.2` ..., deleting anything past
   * logMaxCount, then reopen. Rotation is by rename so an open tail follows
   * the numbered file rather than silently reading a truncated one.
   */
  _checkSize(addition, p) {
    if (!p.logMaxSize || this._fd === null) return;
    if (this._fileSize + addition < p.logMaxSize) return;

    const base = this._fileName;
    this._closeFile();
    this._fileSize = 0;

    let index = 0;
    while (fs.existsSync(partName(base, index + 1))) index++;

    for (; index >= 0; index--) {
      const part = partName(base, index);
      try {
        if (p.logMaxCount > 0 && index >= p.logMaxCount) fs.unlinkSync(part);
        else fs.renameSync(part, partName(base, index + 1));
      } catch (e) {
        // A locked part stops the shift; keep logging to a fresh file rather
        // than losing the session's log entirely.
        this.emit('file-error', e);
        break;
      }
    }
    this.emit('rotated', base);
    this._openFile(p);
  }

  /** Everything a session logs at startup (TSessionLog::AddStartupInfo). */
  startupInfo(extra) {
    const p = this.prefs();
    if (!p.enabled) return;
    this.add('info', `WinSCP Material  ${(extra && extra.version) || ''}`.trim());
    this.add('info', `Node ${process.versions.node}  Electron ${process.versions.electron || 'n/a'}`);
    this.add('info', `${os.type()} ${os.release()} ${os.arch()}`);
    if (this.session.hostName) {
      this.add('info', `Session: ${this.session.name || this.session.hostName}`);
      this.add('info', `Host: ${this.session.hostName}:${this.session.portNumber || ''}  Protocol: ${this.session.protocol || ''}`);
      this.add('info', `User: ${this.session.userName || '(anonymous)'}`);
    }
    if (p.logToFile) this.add('info', `Logging to: ${expandLogFileName(p.logFileName, this.started, this.session)}`);
  }

  /** The whole log as text, for "copy log" / attaching to a bug report. */
  toText(since) {
    return this.window(since)
      .map((r) => `${r.mark} ${timestamp(new Date(r.at))} ${r.text}`)
      .join('\r\n');
  }

  close() {
    this._closeFile();
    this.actions.close();
    this.forgetSecrets();
    this.emit('closed');
  }

  get fileName() { return this._fileName; }
}

function partName(base, index) { return index >= 1 ? `${base}.${index}` : base; }

// ============================================================== ActionsLog

/**
 * The XML actions log (prefs.logging.actionsLogFileName). This is the machine-
 * readable half: one element per operation with its result, which is what
 * scripting users parse. It is written incrementally and the root element is
 * closed on close(), so a crashed session leaves a file that is obviously
 * truncated rather than one that looks complete and is not.
 */
class ActionsLog {
  constructor(deps) {
    const d = deps || {};
    this.getPrefs = d.getPrefs || (() => ({}));
    this.session = d.session || {};
    this.started = d.started || new Date();
    this.log = d.log || null;
    this._fd = null;
    this._fileName = '';
    this._broken = false;
    this._open = null;   // the action currently being recorded
  }

  _prefs() { return (this.log ? this.log.prefs() : this.getPrefs()) || {}; }

  _ensure() {
    const p = this._prefs();
    if (!p.actionsLogging || !p.actionsLogFileName) return false;
    if (this._broken) return false;
    if (this._fd !== null) return true;
    const name = expandLogFileName(p.actionsLogFileName, this.started, this.session);
    try {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      this._fd = fs.openSync(name, 'w');
      this._fileName = name;
      this._write(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<session xmlns="http://winscp.net/schema/session/1.0"' +
        ` name="${xmlEscape(this.session.name || this.session.hostName || '')}"` +
        ` start="${xmlTime(this.started.getTime())}">\n`);
      return true;
    } catch (e) {
      this._broken = true;
      this._fd = null;
      if (this.log) this.log.emit('file-error', e);
      return false;
    }
  }

  _write(text) {
    if (this._fd === null) return;
    try { fs.writeSync(this._fd, Buffer.from(text, 'utf8')); } catch (e) {
      this._broken = true;
      try { fs.closeSync(this._fd); } catch { /* ignore */ }
      this._fd = null;
      if (this.log) this.log.emit('file-error', e);
    }
  }

  /**
   * Record one action. `type` is the element name (upload, download, mkdir,
   * rm, mv, cp, chmod, chown, touch, call, ls, stat, checksum, cwd,
   * difference). `fields` become child elements; every value is redacted with
   * the same rules as the text log, because an action log ends up attached to
   * the same forum posts.
   */
  record(type, fields, result) {
    if (!this._ensure()) return false;
    const redact = (v) => (this.log ? this.log.redact(v) : v);
    const code = result && result.ok === false ? 0 : 1;
    let body = `  <${type} result="${code}">\n`;
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null || v === '') continue;
      body += `    <${k} value="${xmlEscape(redact(v))}" />\n`;
    }
    if (result && result.ok === false) {
      body += '    <result success="false">\n';
      body += `      <message>${xmlEscape(redact(result.message || 'Failed'))}</message>\n`;
      body += '    </result>\n';
    }
    body += `  </${type}>\n`;
    this._write(body);
    return true;
  }

  /** Convenience for the transfer path, which reports before and after. */
  transfer(direction, source, destination, size, result) {
    return this.record(direction === 'upload' ? 'upload' : 'download',
      { filename: source, destination, size: size === undefined ? '' : String(size) }, result);
  }

  close() {
    if (this._fd === null) return;
    this._write('</session>\n');
    try { fs.closeSync(this._fd); } catch { /* ignore */ }
    this._fd = null;
  }

  get fileName() { return this._fileName; }
}

module.exports = {
  SessionLog, ActionsLog, expandLogFileName, validFileName,
  MARKS, LEVEL_OF, timestamp, xmlEscape,
};
