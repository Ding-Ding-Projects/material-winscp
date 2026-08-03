// scp.js — the SCP/shell protocol: a real SSH connection (borrowed wholesale
// from sftp.js) driving `ls`, the usual POSIX tools, and the actual SCP wire
// protocol for transfers.
//
// SCP is not a file-management protocol. Everything except the byte transfer is
// a shell command whose output has to be parsed, which is why the listing
// parser below is the largest thing in the file and why so many of the session
// options exist: `ls` differs between every Unix ever shipped.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const nodePath = require('path');
const { PassThrough, Writable } = require('stream');
const { once } = require('events');

const { Adapter, entry } = require('./base');
const { SshTransport, shellQuote, parseRights, normalizeTimes } = require('./sftp');
const { normalizeError } = require('../exceptions');

const NUL = Buffer.from([0]);
const RETURN_MARKER = 'WinSCP-material-rc:';
const MAX_CONTROL_LINE = 64 * 1024;

function scpError(error, context = {}) {
  const source = error instanceof Error ? error : new Error(String(error || ''));
  return normalizeError(source, { protocol: 'SCP', ...context });
}

function scpProtocolError(message, operation = 'transfer') {
  return scpError(new Error(message), {
    category: 'protocol', code: 'EPROTO', operation,
  });
}

function scpValidationError(message, operation = 'transfer') {
  return scpError(new Error(message), {
    category: 'validation', operation,
  });
}

function scpRemoteError(message, operation = 'transfer') {
  const permission = /\b(permission denied|access denied|not permitted|operation not permitted)\b/i.test(message);
  return scpError(new Error(message), {
    category: permission ? 'permission' : 'protocol',
    code: permission ? 'EACCES' : 'EPROTO',
    operation,
  });
}

function checkedMode(mode) {
  const text = typeof mode === 'string' ? mode.trim() : '';
  const n = typeof mode === 'string'
    ? (/^[0-7]{3,4}$/.test(text) ? parseInt(text, 8) : NaN)
    : Number(mode);
  if (!Number.isSafeInteger(n) || n < 0 || n > 0o7777) {
    throw scpValidationError(`SCP mode must be an octal value from 0000 through 7777; received ${String(mode)}.`, 'permissions');
  }
  return n;
}

function checkedOffset(value, operation) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw scpValidationError(`SCP ${operation} offset must be a non-negative integer.`, operation);
  }
  return n;
}

function checkedEpochMilliseconds(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw scpValidationError(`SCP ${label} must be a non-negative epoch time in milliseconds.`, 'upload');
  }
  return n;
}

// ------------------------------------------------------------- ls parsing

const LS_LINE = /^([-bcdlpsDwt?])([rwxsStTlL-]{9})([+.@]*)\s+(\d+)\s+(.*)$/;

// The four date shapes GNU and BSD `ls` actually emit, in the order they are
// cheapest to tell apart. `--full-time` is the first; the classic "Mon DD" one
// is last because it is the ambiguous one (it has no year).
const DATE_FORMS = [
  /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[+-]\d{4})?)(?:\s+|$)/,
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?:\s+|$)/,
  /^([A-Za-z]{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))(?:\s+|$)/,
  /^(\d{1,2}\s+[A-Za-z]{3}\s+(?:\d{1,2}:\d{2}|\d{4}))(?:\s+|$)/,
];

const TYPE_BY_CHAR = {
  '-': 'file', d: 'dir', l: 'link', b: 'special', c: 'special',
  p: 'special', s: 'special', D: 'special', w: 'special', t: 'special', '?': 'special',
};

function tokensWithOffsets(s) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push({ text: m[0], at: m.index });
  return out;
}

/** 'Jan  2 03:04' has no year: it is within the last twelve months. */
function parseLsDate(text, now) {
  const nowMs = now === undefined ? Date.now() : now;
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*([+-]\d{4})?$/.exec(text);
  if (iso) {
    const tz = iso[3] ? ' ' + iso[3] : '';
    const t = Date.parse(`${iso[1]}T${iso[2].length === 5 ? iso[2] + ':00' : iso[2]}${iso[3] ? iso[3].slice(0, 3) + ':' + iso[3].slice(3) : ''}`);
    if (!Number.isNaN(t)) return t;
    const fallback = Date.parse(`${iso[1]} ${iso[2]}${tz}`);
    return Number.isNaN(fallback) ? 0 : fallback;
  }
  const classic = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})$/.exec(text)
    || (() => {
      const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}:\d{2}|\d{4})$/.exec(text);
      return m ? [m[0], m[2], m[1], m[3]] : null;
    })();
  if (!classic) return 0;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(classic[1].toLowerCase());
  if (month < 0) return 0;
  const day = Number(classic[2]);
  if (/^\d{4}$/.test(classic[3])) return new Date(Number(classic[3]), month, day).getTime();
  const [hh, mm] = classic[3].split(':').map(Number);
  const nowDate = new Date(nowMs);
  let t = new Date(nowDate.getFullYear(), month, day, hh, mm).getTime();
  // A date more than a day ahead of "now" belongs to last year.
  if (t > nowMs + 86400000) t = new Date(nowDate.getFullYear() - 1, month, day, hh, mm).getTime();
  return t;
}

/** Remote `ls` output is untrusted; keep only exact safe byte counts. */
function listingSize(value) {
  const size = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

/**
 * Parse one `ls -l` line. Returns null when the line is not a listing line —
 * `total 12`, a warning on stdout, a shell banner.
 */
function parseListingLine(line, opts = {}) {
  if (!line || !line.trim()) return null;
  const m = LS_LINE.exec(line);
  if (!m) return null;

  const typeChar = m[1];
  const rights = m[2];
  const acl = m[3] || '';
  const links = Number(m[4]);
  const rest = m[5];

  const toks = tokensWithOffsets(rest);
  let dateIndex = -1;
  let dateText = '';
  let nameAt = -1;
  for (let i = 1; i < toks.length; i++) {
    for (const form of DATE_FORMS) {
      const d = form.exec(rest.slice(toks[i].at));
      if (!d) continue;
      // The token in front of the date is the size; without it this is a false
      // positive on a file name that happens to look like a date.
      if (!/^\d+$/.test(toks[i - 1].text)) continue;
      dateIndex = i;
      dateText = d[1];
      nameAt = toks[i].at + d[0].length;
      break;
    }
    if (dateIndex >= 0) break;
  }
  if (dateIndex < 0) return null;

  const size = listingSize(toks[dateIndex - 1].text);
  const names = toks.slice(0, dateIndex - 1).map((t) => t.text);
  let owner = '';
  let group = '';
  if (names.length >= 2) {
    // A device node puts "major," where the group would be followed by the
    // minor as the size; the two name columns are still the first two.
    owner = names[0];
    group = names[1];
  } else if (names.length === 1) {
    owner = names[0];
  }

  let name = rest.slice(nameAt);
  let linkTarget = '';
  const type = TYPE_BY_CHAR[typeChar] || 'special';
  if (type === 'link') {
    const arrow = name.lastIndexOf(' -> ');
    if (arrow >= 0) { linkTarget = name.slice(arrow + 4); name = name.slice(0, arrow); }
  }
  if (!name) return null;
  const timeDifferenceSeconds = Number(opts.timeDifferenceSeconds);

  return {
    name,
    type,
    size,
    mtime: parseLsDate(dateText, opts.now)
      + (Number.isFinite(timeDifferenceSeconds) ? timeDifferenceSeconds * 1000 : 0),
    rights,
    acl,
    links,
    owner,
    group,
    linkTarget,
    isSymlink: type === 'link',
    raw: { line, typeChar, dateText },
  };
}

/**
 * Parse a whole listing. `ignoreWarnings` decides what happens to a line the
 * parser does not recognise: skip it, or fail loudly so the user finds out the
 * server's `ls` is not one this port understands.
 */
function parseListing(text, opts = {}) {
  const out = [];
  const skipped = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^total\s+[\d.,]+[kKmMgG]?$/.test(line.trim())) continue;
    const row = parseListingLine(line, opts);
    if (row) { out.push(row); continue; }
    skipped.push(line);
    if (!opts.ignoreWarnings) {
      throw new Error(`The directory listing could not be parsed: ${line}`);
    }
  }
  return { entries: out, skipped };
}

// ------------------------------------------------------- SCP wire protocol

/**
 * A pull reader over an exec channel. The SCP protocol interleaves short
 * control lines with arbitrarily large payloads, so this has to both buffer
 * small reads and stream large ones without holding the file in memory.
 */
class ByteReader {
  constructor(src, highWaterMark = 1024 * 1024, maxControlLine = MAX_CONTROL_LINE) {
    this.src = src;
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this.high = highWaterMark;
    this.maxControlLine = maxControlLine;
    this._wake = null;
    src.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      if (this.buf.length >= this.high) src.pause();
      this._notify();
    });
    src.on('end', () => { this.ended = true; this._notify(); });
    src.on('close', () => { this.ended = true; this._notify(); });
    src.on('error', (e) => { this.error = e; this._notify(); });
  }

  _notify() { const w = this._wake; if (w) { this._wake = null; w(); } }
  _idle() { return new Promise((resolve) => { this._wake = resolve; }); }

  _take(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    if (this.buf.length < this.high) this.src.resume();
    return out;
  }

  async readBytes(n) {
    while (this.buf.length < n) {
      if (this.error) throw scpError(this.error, { operation: 'transfer' });
      if (this.ended) throw scpProtocolError('The SCP transfer ended before all the data arrived');
      await this._idle();
    }
    return this._take(n);
  }

  async readLine() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        if (i > this.maxControlLine) throw scpProtocolError('The SCP peer sent an oversized control record.');
        const line = this._take(i + 1).subarray(0, i).toString('utf8');
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      if (this.buf.length > this.maxControlLine) throw scpProtocolError('The SCP peer sent an oversized control record.');
      if (this.error) throw scpError(this.error, { operation: 'transfer' });
      if (this.ended) throw scpProtocolError('The SCP transfer ended in the middle of a control line');
      await this._idle();
    }
  }

  /** Move exactly `n` bytes into `dest`, honouring its backpressure. */
  async pipeBytes(n, dest, onProgress) {
    let left = n;
    while (left > 0) {
      if (!this.buf.length) {
        if (this.error) throw scpError(this.error, { operation: 'transfer' });
        if (this.ended) throw scpProtocolError('The SCP transfer ended before all the data arrived');
        await this._idle();
        continue;
      }
      const chunk = this._take(Math.min(left, this.buf.length));
      left -= chunk.length;
      if (onProgress) onProgress(chunk.length);
      if (!dest.write(chunk)) await once(dest, 'drain');
    }
  }
}

/** Read the single status byte the peer sends after every record. */
async function expectAck(reader) {
  const b = await reader.readBytes(1);
  if (b[0] === 0) return;
  const message = (await reader.readLine()).trim();
  throw scpRemoteError(message || (b[0] === 1
    ? 'The remote scp reported a problem' : 'The remote scp reported a fatal error'));
}

function writeAck(channel) {
  if (channel.destroyed || channel.writableEnded) {
    throw scpProtocolError('The SCP channel closed before the peer acknowledged the record.');
  }
  try {
    channel.write(NUL);
  } catch (error) {
    throw scpError(error, { category: 'transport', code: error.code || 'EPIPE', operation: 'transfer' });
  }
}

/** 'C0644 1234 name' */
function parseControl(line) {
  const kind = line[0];
  if (kind === 'C' || kind === 'D') {
    const m = /^[CD]([0-7]{4})\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) throw scpProtocolError(`The remote scp sent a record this client cannot read: ${line}`);
    const size = Number(m[2]);
    if (!Number.isSafeInteger(size)) throw scpProtocolError('The remote scp sent a file size outside the safe integer range.');
    return { kind, mode: parseInt(m[1], 8), size, name: m[3] };
  }
  if (kind === 'T') {
    const m = /^T(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
    if (!m || m.slice(1).some((value) => !Number.isSafeInteger(Number(value)))) {
      throw scpProtocolError(`The remote scp sent a time record this client cannot read: ${line}`);
    }
    const mtimeSeconds = Number(m[1]);
    const atimeSeconds = Number(m[3]);
    const mtime = mtimeSeconds * 1000;
    const atime = atimeSeconds * 1000;
    if (!Number.isSafeInteger(mtime) || !Number.isSafeInteger(atime)) {
      throw scpProtocolError(`The remote scp sent a timestamp outside the safe millisecond range: ${line}`);
    }
    return { kind, mtime, atime };
  }
  if (line === 'E') return { kind: 'E' };
  if (line.charCodeAt(0) === 1 || line.charCodeAt(0) === 2) {
    throw scpRemoteError(line.slice(1).trim() || 'The remote scp reported an error');
  }
  throw scpProtocolError(`Unexpected SCP record: ${line}`);
}

/** SCP recursive records contain one basename, never a path. */
function safeRecordName(name) {
  const text = String(name);
  if (!text || text === '.' || text === '..' || /[\\/\0]/.test(text)) {
    throw scpProtocolError(`The remote SCP record contains an unsafe local name: ${text}`, 'download');
  }
  return text;
}

function outboundRecordName(name) {
  const text = String(name);
  if (!text || text === '.' || text === '..' || /[\0\r\n]/.test(text)) {
    throw scpValidationError(`The local name cannot be represented in an SCP control record: ${text}`, 'upload');
  }
  return text;
}

function modeString(mode) {
  const n = checkedMode(mode);
  return n.toString(8).padStart(4, '0');
}

/**
 * The mode to put in an SCP record. Windows has no POSIX bits — every file
 * reports 0666 and every directory 0666 too — so sending them would create
 * world-writable, non-traversable directories on the server. On such a host the
 * transfer defaults are used instead, and a directory always keeps its +x.
 */
function transferMode(stat, opts, isDir) {
  const override = isDir ? opts.dirMode : opts.mode;
  if (override !== undefined && override !== null) {
    const mode = checkedMode(override);
    return isDir && opts.addXToDirectories !== false ? mode | 0o111 : mode;
  }
  if (process.platform === 'win32') return isDir ? 0o755 : 0o644;
  const mode = stat.mode & 0o7777;
  return checkedMode(isDir && opts.addXToDirectories !== false ? mode | 0o111 : mode);
}

/** The writable half of an upload: forwards to the channel, then finishes the
 *  SCP record and waits for the server's acknowledgement before 'finish'. */
class ScpSink extends Writable {
  constructor(channel, reader, size, onDone, onProgress) {
    super();
    this.channel = channel;
    this.reader = reader;
    this.size = size;
    this.written = 0;
    this._onDone = onDone;
    this._onProgress = onProgress;
  }
  _write(chunk, enc, cb) {
    if (this.written + chunk.length > this.size) {
      cb(scpValidationError(`SCP upload exceeded its declared size of ${this.size} bytes.`, 'upload'));
      return;
    }
    this.written += chunk.length;
    try {
      if (this.channel.write(chunk)) {
        if (this._onProgress) this._onProgress(chunk.length);
        cb();
      } else this.channel.once('drain', () => {
        if (this._onProgress) this._onProgress(chunk.length);
        cb();
      });
    } catch (e) { cb(e); }
  }
  _final(cb) {
    (async () => {
      if (this.written !== this.size) {
        throw scpValidationError(`SCP was told to expect ${this.size} bytes but ${this.written} were written.`, 'upload');
      }
      writeAck(this.channel);
      await expectAck(this.reader);
      if (this._onDone) await this._onDone();
      this.channel.end();
    })().then(() => cb(), cb);
  }
  _destroy(err, cb) { try { this.channel.destroy(); } catch { /* already gone */ } cb(err); }
}

// ------------------------------------------------------------------ adapter

class ScpAdapter extends Adapter {
  /**
   * @param session  resolved session data
   * @param options  { hostKeyVerifier, keyboardInteractive, transport }
   */
  constructor(session, options = {}) {
    super(session);
    this.options = options;
    this.transport = options.transport || null;
    this._ownsTransport = false;
    this._fullTime = null;       // resolved on the first listing when 'auto'
    this.caps = {
      ...this.caps,
      rights: true,
      owner: true,
      symlink: true,
      hardlink: true,
      exec: true,
      resume: false,           // SCP starts every transfer at byte zero
      timestamp: true,
      recycleBin: false,
      checksum: true,
      find: true,
      rename: true,
      move: true,
      copyRemote: true,        // `cp -a` on the server, no round trip
      calculateSize: true,
      nativeMove: true,
      hiddenFiles: true,
      spaceInfo: true,
    };
  }

  get protocolName() { return 'SCP'; }

  _log(level, message) { this.emit('log', { level, message }); }

  /** The listing is bytes; `notUtf` says whether to read them as UTF-8. */
  get _encoding() { return this.session.notUtf === 'on' ? 'latin1' : 'utf8'; }

  // ---- lifecycle -------------------------------------------------------
  async connect() {
    if (!this.transport) {
      this.transport = new SshTransport(this.session, this.options);
      this._ownsTransport = true;
    }
    this.transport.on('log', (e) => this.emit('log', e));
    this.transport.on('close', () => { this.connected = false; this.emit('close'); });
    if (!this.transport.connected) await this.transport.connect();
    this.connected = true;

    // WinSCP's TSCPFileSystem drains one command before startup probing. A
    // login shell may print a banner/MOTD on that first exec channel; consume
    // it here so it cannot become the apparent output of `pwd` or `uname`.
    const startup = await this._run(':');
    if (startup.code !== 0) {
      throw scpError(new Error(`Could not skip the shell startup message: ${(startup.stderr || startup.stdout || '').trim() || `exit code ${startup.code}`}`), {
        category: 'protocol', code: 'EPROTO', operation: 'startup',
      });
    }
    if (startup.stdout || startup.stderr) {
      this._log('debug', `Discarded shell startup output (${[startup.stdout, startup.stderr].filter(Boolean).join('').length} bytes)`);
    }

    const pwd = await this._run('pwd');
    this.home = this.normalize((pwd.stdout || '').trim() || '/');

    const uname = await this._run('uname -sr').catch(() => ({ stdout: '' }));
    this.serverInfo = { protocol: 'SCP', system: (uname.stdout || '').trim(), home: this.home };

    for (const command of this.session.postLoginCommands || []) {
      if (!command) continue;
      const res = await this._run(command);
      this._log('info', `Post-login command "${command}" exited with ${res.code}`);
    }

    this._log('info', `SCP session ready; working directory ${this.home}`);
    return this.serverInfo;
  }

  async disconnect() {
    this.connected = false;
    if (this._ownsTransport && this.transport) await this.transport.disconnect();
    this.transport = null;
  }

  // ---- shell plumbing --------------------------------------------------

  /**
   * Wrap a command the way WinSCP's shell session does: strip aliases and
   * locale variables so the output is predictable, run it through the
   * configured shell, and read the exit status out of the configured return
   * variable when one is set.
   */
  _wrap(command) {
    const s = this.session;
    const prefix = [];
    if (s.clearAliases) prefix.push('unalias -a 2>/dev/null; true');
    if (s.unsetNationalVars) {
      prefix.push('unset LANG LANGUAGE LC_CTYPE LC_COLLATE LC_MONETARY LC_NUMERIC LC_TIME LC_MESSAGES LC_ALL 2>/dev/null; true');
    }
    let full = prefix.length ? `${prefix.join('; ')}; ${command}` : command;
    if (s.returnVar) {
      const returnVar = String(s.returnVar).trim().replace(/^\$/, '');
      if (returnVar !== '?' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(returnVar)) {
        throw scpValidationError('SCP returnVar must be "$?"/"?" or a shell variable name.', 'shell');
      }
      full = `${full}; echo ${shellQuote(RETURN_MARKER)}"$${returnVar}"`;
    }
    if (s.shell) full = `${s.shell} -c ${shellQuote(full)}`;
    return full;
  }

  async _run(command, opts = {}) {
    if (!this.transport) throw new Error('Not connected');
    const res = await this.transport.exec(this._wrap(command), { encoding: this._encoding, ...opts });
    let { code, stdout } = res;
    if (this.session.returnVar) {
      // The shell's own status is not visible when a return variable is
      // configured, so it is echoed and read back out of the output.
      const m = new RegExp(`^${RETURN_MARKER.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(-?\\d+)\\s*$`, 'm').exec(String(stdout || ''));
      if (m) { code = Number(m[1]); stdout = stdout.replace(m[0], ''); }
    }
    return { code, signal: res.signal, stdout, stderr: res.stderr };
  }

  async _mustRun(command, what) {
    const res = await this._run(command);
    if (res.code !== 0) {
      const message = `${what} failed: ${(res.stderr || res.stdout || '').trim() || `exit code ${res.code}`}`;
      const permission = /\b(permission denied|access denied|not permitted|operation not permitted)\b/i.test(message);
      throw scpError(new Error(message), {
        category: permission ? 'permission' : 'protocol',
        code: permission ? 'EACCES' : 'EPROTO',
        operation: what,
      });
    }
    return res;
  }

  // ---- reading ---------------------------------------------------------

  /** `--full-time` is a GNU extension; 'auto' finds out once and remembers. */
  async _wantFullTime() {
    const setting = this.session.sCPLsFullTime;
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    if (this._fullTime !== null) return this._fullTime;
    const probe = await this._run(`${this.session.listingCommand || 'ls -la'} --full-time /dev/null`);
    this._fullTime = probe.code === 0;
    this._log('debug', `Server ls ${this._fullTime ? 'supports' : 'does not support'} --full-time`);
    return this._fullTime;
  }

  _lsCommand(target, extra) {
    const base = this.session.listingCommand || 'ls -la';
    const sep = this.session.scp1Compatibility ? '' : '-- ';
    return `${base}${extra ? ' ' + extra : ''} ${sep}${shellQuote(target)}`;
  }

  async list(dir) {
    const target = this.normalize(dir);
    const listPath = target.endsWith('/') ? target : target + '/';
    const fullTime = await this._wantFullTime();

    let res = await this._run(this._lsCommand(listPath, fullTime ? '--full-time' : ''));
    if (res.code !== 0 && fullTime && this.session.sCPLsFullTime === 'auto') {
      this._fullTime = false;
      this._log('debug', 'Retrying the listing without --full-time');
      res = await this._run(this._lsCommand(listPath, ''));
    }
    if (res.code !== 0) {
      throw new Error(`Could not list ${target}: ${(res.stderr || res.stdout || '').trim() || `exit code ${res.code}`}`);
    }
    if (res.stderr && res.stderr.trim()) {
      if (!this.session.ignoreLsWarnings) {
        throw scpError(new Error(`The listing command warned: ${res.stderr.trim()}`), {
          category: 'protocol', code: 'EPROTO', operation: 'list',
        });
      }
      this._log('warn', `The listing command warned: ${res.stderr.trim()}`);
    }

    const { entries, skipped } = parseListing(res.stdout, {
      ignoreWarnings: this.session.ignoreLsWarnings !== false,
      timeDifferenceSeconds: this.session.timeDifference,
    });
    if (skipped.length) this._log('debug', `Ignored ${skipped.length} unparsable listing line(s)`);

    return entries
      .filter((row) => row.name !== '.' && row.name !== '..')
      .map((row) => entry({
        name: row.name,
        type: row.type,
        size: row.size,
        mtime: row.mtime,
        rights: row.rights,
        owner: row.owner,
        group: row.group,
        linkTarget: row.linkTarget,
        isSymlink: row.isSymlink,
        hidden: row.name.startsWith('.'),
        readOnly: row.rights[1] !== 'w',
        raw: row.raw,
      }));
  }

  async stat(p) {
    const target = this.normalize(p);
    const fullTime = await this._wantFullTime();
    const res = await this._run(this._lsCommand(target, `-d${fullTime ? ' --full-time' : ''}`));
    if (res.code !== 0) throw scpError(new Error(`Could not stat ${target}: ${(res.stderr || res.stdout || '').trim() || `exit code ${res.code}`}`), {
      category: 'protocol', code: 'EPROTO', operation: 'stat',
    });
    const { entries } = parseListing(res.stdout, {
      ignoreWarnings: true,
      timeDifferenceSeconds: this.session.timeDifference,
    });
    if (!entries.length) throw new Error(`Could not stat ${target}: the listing was not understood`);
    const row = entries[0];
    return entry({
      name: this.basename(target),
      type: row.type,
      size: row.size,
      mtime: row.mtime,
      rights: row.rights,
      owner: row.owner,
      group: row.group,
      linkTarget: row.linkTarget,
      isSymlink: row.isSymlink,
      hidden: this.basename(target).startsWith('.'),
      readOnly: row.rights[1] !== 'w',
      raw: { ...row.raw, path: target },
    });
  }

  async realpath(p) {
    const target = this.normalize(p || '.');
    const res = await this._run(`cd ${shellQuote(target)} >/dev/null 2>&1 && pwd || readlink -f ${shellQuote(target)}`);
    const out = (res.stdout || '').trim();
    if (res.code !== 0 || !out) {
      throw new Error(`Could not resolve ${target}: ${(res.stderr || '').trim() || 'the server returned no canonical path'}`);
    }
    return this.normalize(out);
  }

  async readlink(p) {
    const target = this.normalize(p);
    const res = await this._run(`readlink ${shellQuote(target)}`);
    if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
    // Servers without readlink(1) still print the target in a long listing.
    const st = await this.stat(target);
    if (!st.linkTarget) throw new Error(`${target} is not a symbolic link`);
    return st.linkTarget;
  }

  // ---- writing ---------------------------------------------------------
  async mkdir(p, opts = {}) {
    const target = this.normalize(p);
    await this._mustRun(`mkdir ${opts.recursive ? '-p ' : ''}-- ${shellQuote(target)}`, `Creating ${target}`);
    return target;
  }

  async remove(p, opts = {}) {
    const target = this.normalize(p);
    const command = opts.recursive ? `rm -rf -- ${shellQuote(target)}` : `rm -f -- ${shellQuote(target)} || rmdir -- ${shellQuote(target)}`;
    await this._mustRun(command, `Deleting ${target}`);
  }

  async rename(from, to) {
    const src = this.normalize(from);
    const dst = this.normalize(to);
    await this._mustRun(`mv -f -- ${shellQuote(src)} ${shellQuote(dst)}`, `Renaming ${src}`);
    return dst;
  }

  async copyRemote(from, to, opts = {}) {
    const src = this.normalize(from);
    const dst = this.normalize(to);
    // Commander passes the resolved overwrite decision through the queue. SCP
    // has no copy primitive with an overwrite flag, so remove the exact target
    // first when overwrite was explicitly selected. Without this, `cp -a`
    // treats an existing directory as a container and silently changes the
    // destination name — a duplicate action that lies about where it landed.
    const command = opts.overwrite
      ? `rm -rf -- ${shellQuote(dst)} && cp -a -- ${shellQuote(src)} ${shellQuote(dst)}`
      : `cp -a -- ${shellQuote(src)} ${shellQuote(dst)}`;
    await this._mustRun(command, `Copying ${src}`);
    return dst;
  }

  async symlink(target, linkPath) {
    await this._mustRun(`ln -s -- ${shellQuote(target)} ${shellQuote(this.normalize(linkPath))}`, 'Creating the symbolic link');
  }

  async hardlink(existing, linkPath) {
    await this._mustRun(`ln -- ${shellQuote(this.normalize(existing))} ${shellQuote(this.normalize(linkPath))}`, 'Creating the hard link');
  }

  async setRights(p, rights, opts = {}) {
    const mode = typeof rights === 'number' ? rights : parseRights(rights);
    if (mode === null || !Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error(`"${rights}" is not a permission string or mode`);
    }
    const octal = (mode & 0o7777).toString(8);
    await this._mustRun(`chmod ${opts.recursive ? '-R ' : ''}${octal} -- ${shellQuote(this.normalize(p))}`, 'Changing permissions');
  }

  async setOwner(p, owner, group, opts = {}) {
    const who = group === undefined || group === null || group === '' ? String(owner) : `${owner}:${group}`;
    await this._mustRun(`chown ${opts.recursive ? '-R ' : ''}${shellQuote(who)} -- ${shellQuote(this.normalize(p))}`, 'Changing the owner');
  }

  /** `touch -t` is the portable form; -d/@epoch is GNU only. Both call shapes
   *  are accepted — see normalizeTimes() in sftp.js. */
  async setTimes(p, mtime, atime) {
    const t = normalizeTimes(mtime, atime);
    const target = shellQuote(this.normalize(p));
    const stamp = (ms) => {
      const d = new Date(ms);
      const two = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}.${two(d.getSeconds())}`;
    };
    await this._mustRun(`touch -m -t ${stamp(t.mtime)} -- ${target}`, 'Setting the modification time');
    if (t.atime !== t.mtime) {
      await this._mustRun(`touch -a -t ${stamp(t.atime)} -- ${target}`, 'Setting the access time');
    }
  }

  // ---- transfers -------------------------------------------------------

  _scp(flags, target) {
    const sep = this.session.scp1Compatibility ? '' : '-- ';
    return `scp ${flags.join(' ')} ${sep}${shellQuote(target)}`;
  }

  /**
   * `scp -f` makes the server the source. The header is read before the stream
   * is handed back so the caller can see the size and times up front; the
   * payload then streams straight through.
   */
  async createReadStream(p, opts = {}) {
    const start = checkedOffset(opts.start, 'download');
    if (start > 0) throw scpValidationError('SCP cannot resume a partial download; transfer the file again from the start or use SFTP.', 'download');
    const target = this.normalize(p);
    const flags = ['-f'];
    if (opts.preserveTime !== false) flags.push('-p');
    const channel = await this.transport.execRaw(this._scp(flags, target));
    const reader = new ByteReader(channel);

    writeAck(channel);
    let times = null;
    let header = null;
    try {
      for (;;) {
        const line = await reader.readLine();
        const rec = parseControl(line);
        if (rec.kind === 'T') { times = rec; writeAck(channel); continue; }
        if (rec.kind === 'D') {
          throw scpProtocolError(`${target} is a directory; use downloadDirectory() for a recursive SCP transfer`, 'download');
        }
        if (rec.kind === 'E') throw scpProtocolError(`${target} produced no file`, 'download');
        header = rec;
        break;
      }
    } catch (e) {
      try { channel.destroy(); } catch { /* gone */ }
      throw e;
    }
    writeAck(channel);

    const out = new PassThrough();
    out.scpInfo = {
      name: header.name,
      size: header.size,
      mode: header.mode,
      mtime: times ? times.mtime : 0,
      atime: times ? times.atime : 0,
    };
    this._log('debug', `scp -f ${target}: ${header.size} bytes`);

    (async () => {
      await reader.pipeBytes(header.size, out, opts.onProgress);
      await expectAck(reader);
      writeAck(channel);
      channel.end();
      out.end();
    })().catch((e) => { try { channel.destroy(); } catch { /* gone */ } out.destroy(e); });

    return out;
  }

  /**
   * `scp -t` makes the server the sink. SCP puts the length in the header, so
   * the size has to be known before the first byte moves — there is no way to
   * stream an unknown-length file over this protocol.
   */
  async createWriteStream(p, opts = {}) {
    const size = Number(opts.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw scpValidationError('SCP needs the file size as a non-negative integer before the upload starts; pass { size } to createWriteStream().', 'upload');
    }
    const start = checkedOffset(opts.start, 'upload');
    if (start > 0) throw scpValidationError('SCP cannot resume a partial upload; transfer the file again from the start or use SFTP.', 'upload');
    const target = this.normalize(p);
    const recordName = outboundRecordName(this.basename(target));
    const preserve = opts.mtime !== undefined && opts.mtime !== null;
    const flags = ['-t'];
    if (preserve) flags.push('-p');
    const channel = await this.transport.execRaw(this._scp(flags, target));
    const reader = new ByteReader(channel);

    try {
      await expectAck(reader);
      if (preserve) {
        const mtime = Math.floor(checkedEpochMilliseconds(opts.mtime, 'modification time') / 1000);
        const atime = Math.floor(checkedEpochMilliseconds(opts.atime === undefined ? opts.mtime : opts.atime, 'access time') / 1000);
        channel.write(`T${mtime} 0 ${atime} 0\n`);
        await expectAck(reader);
      }
      const mode = opts.mode === undefined ? 0o644 : opts.mode;
      channel.write(`C${modeString(mode)} ${size} ${recordName}\n`);
      await expectAck(reader);
    } catch (e) {
      try { channel.destroy(); } catch { /* gone */ }
      throw e;
    }
    this._log('debug', `scp -t ${target}: ${size} bytes`);

    return new ScpSink(channel, reader, size, null, opts.onProgress);
  }

  /**
   * Recursive download. `scp -rf` emits D/C/E records describing the whole
   * tree; this walks them and writes the tree out locally.
   */
  async downloadDirectory(remoteDir, localDir, opts = {}) {
    const target = this.normalize(remoteDir);
    const flags = ['-f', '-r'];
    if (opts.preserveTime !== false) flags.push('-p');
    const channel = await this.transport.execRaw(this._scp(flags, target));
    const reader = new ByteReader(channel);
    const stats = { files: 0, dirs: 0, bytes: 0 };

    try {
      writeAck(channel);
      const stack = [{ path: localDir, times: null }];
      await fsp.mkdir(localDir, { recursive: true });
      let times = null;

      let rootDirectory = false;
      for (;;) {
        if (rootDirectory && stack.length === 1) break;
        let line;
        try { line = await reader.readLine(); } catch (e) { throw e; }
        const rec = parseControl(line);
        if (rec.kind === 'T') { times = rec; writeAck(channel); continue; }

        if (rec.kind === 'E') {
          writeAck(channel);
          const done = stack.pop();
          // A directory's times arrive before its D record and can only be
          // applied once its contents have stopped touching it.
          if (done && done.times) {
            await fsp.utimes(done.path, new Date(done.times.atime), new Date(done.times.mtime)).catch(() => {});
          }
          times = null;
          if (rootDirectory && stack.length === 1) break;
          continue;
        }

        const parent = stack[stack.length - 1].path;
        const child = nodePath.join(parent, safeRecordName(rec.name));
        if (rec.kind === 'D') {
          if (stack.length === 1) rootDirectory = true;
          await fsp.mkdir(child, { recursive: true });
          stats.dirs++;
          stack.push({ path: child, times });
          times = null;
          writeAck(channel);
          continue;
        }

        writeAck(channel);
        const file = fs.createWriteStream(child, { mode: rec.mode & 0o777 });
        await reader.pipeBytes(rec.size, file, opts.onProgress);
        await new Promise((res, rej) => { file.on('error', rej); file.on('close', res); file.end(); });
        await expectAck(reader);
        writeAck(channel);
        stats.files++;
        stats.bytes += rec.size;
        if (times) { await fsp.utimes(child, new Date(times.atime), new Date(times.mtime)).catch(() => {}); times = null; }
        if (!rootDirectory && stack.length === 1) break;
      }
      channel.end();
    } catch (e) {
      try { channel.destroy(); } catch { /* gone */ }
      throw e;
    }
    this._log('info', `Downloaded ${stats.files} file(s) in ${stats.dirs} directory(ies) from ${target}`);
    return stats;
  }

  /** Recursive upload: the mirror image, emitting D/C/E for the local tree. */
  async uploadDirectory(localDir, remoteDir, opts = {}) {
    const target = this.normalize(remoteDir);
    const rootName = outboundRecordName(nodePath.basename(localDir));
    const preserve = opts.preserveTime !== false;
    const flags = ['-t', '-r'];
    if (preserve) flags.push('-p');
    const channel = await this.transport.execRaw(this._scp(flags, target));
    const reader = new ByteReader(channel);
    const stats = { files: 0, dirs: 0, bytes: 0 };

    const sendTimes = async (st) => {
      if (!preserve) return;
      channel.write(`T${Math.floor(st.mtimeMs / 1000)} 0 ${Math.floor(st.atimeMs / 1000)} 0\n`);
      await expectAck(reader);
    };

    const walk = async (dir, knownName) => {
      const st = await fsp.stat(dir);
      const directoryName = knownName || outboundRecordName(nodePath.basename(dir));
      await sendTimes(st);
      channel.write(`D${modeString(transferMode(st, opts, true))} 0 ${directoryName}\n`);
      await expectAck(reader);
      stats.dirs++;

      // Files first, then subdirectories: the server sees a complete directory
      // before it is asked to descend, which is what `scp -r` itself does.
      const names = await fsp.readdir(dir);
      const subdirs = [];
      for (const name of names) {
        const child = nodePath.join(dir, name);
        const cst = await fsp.lstat(child);
        if (cst.isDirectory()) { subdirs.push(child); continue; }
        if (!cst.isFile()) continue;             // sockets and devices have no SCP record
        const fileName = outboundRecordName(name);
        await sendTimes(cst);
        channel.write(`C${modeString(transferMode(cst, opts, false))} ${cst.size} ${fileName}\n`);
        await expectAck(reader);
        const rs = fs.createReadStream(child);
        for await (const chunk of rs) {
          if (!channel.write(chunk)) await once(channel, 'drain');
          if (opts.onProgress) opts.onProgress(chunk.length);
        }
        writeAck(channel);
        await expectAck(reader);
        stats.files++;
        stats.bytes += cst.size;
      }
      for (const child of subdirs) await walk(child);

      channel.write('E\n');
      await expectAck(reader);
    };

    try {
      await expectAck(reader);
      await walk(localDir, rootName);
      channel.end();
    } catch (e) {
      try { channel.destroy(); } catch { /* gone */ }
      throw e;
    }
    this._log('info', `Uploaded ${stats.files} file(s) in ${stats.dirs} directory(ies) to ${target}`);
    return stats;
  }

  // ---- optional --------------------------------------------------------
  async exec(command, opts = {}) {
    if (!this.transport) throw new Error('Not connected');
    const { onStdout, ...rest } = opts;
    const result = await this._run(command, {
      encoding: this._encoding,
      ...rest,
      ...(this.session.returnVar && onStdout ? {} : (onStdout ? { onStdout } : {})),
    });
    if (this.session.returnVar && onStdout && result.stdout) onStdout(result.stdout);
    return { ...result, exitCode: result.code };
  }

  async checksum(p, algorithm = 'sha256') {
    const alg = String(algorithm).toLowerCase().replace(/-/g, '');
    const tool = { md5: 'md5sum', sha1: 'sha1sum', sha256: 'sha256sum', sha512: 'sha512sum' }[alg];
    if (!tool) throw scpValidationError(`SCP does not support the checksum algorithm "${algorithm}".`, 'checksum');
    const target = shellQuote(this.normalize(p));
    let res = await this._run(`${tool} -- ${target}`);
    // BSD/macOS commonly has `shasum` but not the GNU `*sum` commands.
    // Retry only when the preferred command is unavailable, never on a real
    // checksum failure.
    if ((res.code === 126 || res.code === 127) && alg !== 'md5') {
      const bits = { sha1: 1, sha256: 256, sha512: 512 }[alg];
      const candidate = await this._run(`shasum -a ${bits} -- ${target}`);
      if (candidate.code === 0) res = candidate;
    }
    // Some BSD/minimal hosts have neither GNU *sum nor shasum, but do ship
    // OpenSSL. Retry only for an unavailable utility; real checksum errors
    // must remain visible to the caller.
    if (res.code === 126 || res.code === 127) {
      const digest = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha512: 'sha512' }[alg];
      const candidate = await this._run(`openssl dgst -${digest} -- ${target}`);
      if (candidate.code === 0) res = candidate;
    }
    if (res.code !== 0) throw scpError(new Error(`${tool} failed: ${(res.stderr || res.stdout || '').trim() || `exit code ${res.code}`}`), {
      category: 'protocol', code: 'EPROTO', operation: 'checksum',
    });
    const hex = /(?:^|=\s*)([0-9a-f]+)(?:\s|$)/i.exec(res.stdout.trim());
    if (!hex) throw new Error(`${tool} produced no usable output`);
    return hex[1].toLowerCase();
  }

  async spaceInfo(p) {
    const target = this.normalize(p || this.home || '/');
    const res = await this._run(`df -Pk -- ${shellQuote(target)}`);
    if (res.code !== 0) return null;
    const lines = res.stdout.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const nums = cols.filter((c) => /^\d+$/.test(c)).map(Number);
    if (nums.length < 3) return null;
    return {
      path: target,
      total: nums[0] * 1024,
      used: nums[1] * 1024,
      free: nums[2] * 1024,
      blockSize: 1024,
      device: cols[0],
      mountPoint: cols[cols.length - 1],
    };
  }
}

module.exports = {
  ScpAdapter,
  parseListing,
  parseListingLine,
  parseLsDate,
  listingSize,
  parseControl,
  modeString,
  transferMode,
  ByteReader,
  ScpSink,
  RETURN_MARKER,
};
