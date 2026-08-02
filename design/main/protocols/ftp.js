// ftp.js — FTP and FTPS (explicit AUTH TLS and implicit TLS).
//
// Built on `basic-ftp` for the control connection and the passive data path,
// with three things written here because the library does not cover them:
//
//   * A listing parser for the LIST styles WinSCP has to deal with in the
//     field — unix, DOS/IIS and VMS — plus MLSD. `basic-ftp` ships unix/DOS
//     parsers but no VMS, and it throws away facts we render in the panel
//     (owner, group, permissions, link targets), so `parseListing()` below is
//     the single entry point and is exported so it can be tested without a
//     server.
//   * Active mode (PORT/EPRT). `basic-ftp` is passive-only: its transfer
//     helpers require `ftp.dataSocket` to already be connected before the
//     transfer command is sent, which is exactly backwards for active mode
//     where the server dials us *after* RETR/STOR. `_activeTransfer()` drives
//     that sequence directly on the FTP context.
//   * Certificate verification that asks the application instead of silently
//     trusting or silently refusing. See `_tlsOptions()` / `_verifyPeer()`.
//
// The control connection is a single, strictly serialized resource: FTP has no
// multiplexing, so every operation goes through `_run()`, which also keeps the
// keepalive ping from interleaving with a transfer.
'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { PassThrough } = require('stream');
const { Client, FTPError } = require('basic-ftp');
const { Adapter, entry } = require('./base');

// ---------------------------------------------------------------------------
// Listing parsers
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** `-rw-r--r--` style permission block → the 9-character rights string. */
function permsFromUnix(block) {
  // Strip the leading type character and any trailing ACL marker ('+', '.').
  const body = block.slice(1).replace(/[+.@]+$/, '');
  return body.length >= 9 ? body.slice(0, 9) : body.padEnd(9, '-');
}

function typeFromUnixChar(c) {
  if (c === 'd') return 'dir';
  if (c === 'l') return 'link';
  if (c === '-' || c === 'f') return 'file';
  return 'special';        // b c p s D (block, char, fifo, socket, Door)
}

/**
 * A unix listing line, e.g.
 *   `drwxr-xr-x   4 root     wheel        4096 Jan 12  2019 folder`
 *
 * Field counts vary (missing group, extra ACL column, AIX/Novell dialects), so
 * rather than a single monster regex we anchor on the date — the one field
 * whose shape is predictable — and read outwards from it. The name is taken as
 * a slice of the original line so that names containing runs of spaces survive.
 */
function parseUnixLine(line, now) {
  if (!/^[bcdlpsSD\-fw]/.test(line)) return null;
  const head = line.match(/^([bcdlpsSD\-fw])([rwxstST\-]{9}[+.@]?)\s+/);
  if (!head) return null;

  // Two date shapes are in the wild: `Mon DD HH:MM` / `Mon DD  YYYY`, and the
  // numeric `YYYY-MM-DD HH:MM` some Windows-hosted unix emulations produce.
  //
  // A user or group literally named "Jan" can make the first regex hit fire on
  // the wrong field, so every candidate is validated: the month has to be real
  // and the field immediately before it has to look like a size. The first
  // candidate that passes both is the date.
  const alpha = /\s([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2}(?::\d{2})?)\s/g;
  const numeric = /\s(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s/g;

  const fieldsBefore = (index) => {
    const middle = line.slice(head[0].length, index).trim().split(/\s+/).filter(Boolean);
    if (!middle.length) return null;
    // links [owner [group ...]] size — size is always last and always numeric
    // (character devices print `major, minor`, which we score as size 0).
    const last = middle[middle.length - 1];
    if (!/^\d+$/.test(last) && !/^\d+,$/.test(last)) return null;
    return middle;
  };

  let mtime = 0;
  let middle = null;
  let dateEnd = -1;

  let m;
  while ((m = numeric.exec(line)) !== null) {
    const fields = fieldsBefore(m.index);
    if (!fields) continue;
    const [hh, mi, ss] = m[4].split(':').map(Number);
    mtime = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mi, ss || 0).getTime();
    middle = fields; dateEnd = m.index + m[0].length;
    break;
  }
  if (!middle) {
    while ((m = alpha.exec(line)) !== null) {
      const month = MONTHS[m[1].toLowerCase()];
      if (month === undefined) continue;
      const fields = fieldsBefore(m.index);
      if (!fields) continue;
      const day = Number(m[2]);
      if (/^\d{4}$/.test(m[3])) {
        mtime = new Date(Number(m[3]), month, day).getTime();
      } else {
        // No year in the listing: it is implied to be within the last six
        // months. Guessing the current year and stepping back when that lands
        // in the future is what every FTP client does, and it is why FTP
        // timestamps without MLSD are approximate.
        const ref = now || new Date();
        const [hh, mi, ss] = m[3].split(':').map(Number);
        let d = new Date(ref.getFullYear(), month, day, hh, mi, ss || 0);
        if (d.getTime() - ref.getTime() > 24 * 3600 * 1000) {
          d = new Date(ref.getFullYear() - 1, month, day, hh, mi, ss || 0);
        }
        mtime = d.getTime();
      }
      middle = fields; dateEnd = m.index + m[0].length;
      break;
    }
  }
  if (!middle) return null;

  const sizeTok = middle[middle.length - 1];
  const size = /^\d+$/.test(sizeTok) ? Number(sizeTok) : 0;
  const names = middle.slice(1, -1);
  const owner = names[0] || '';
  const group = names[1] || '';

  let name = line.slice(dateEnd).replace(/[\r\n]+$/, '');
  const type = typeFromUnixChar(line[0]);
  let linkTarget = '';
  if (type === 'link') {
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) { linkTarget = name.slice(arrow + 4); name = name.slice(0, arrow); }
  }
  if (!name || name === '.' || name === '..') return null;

  return entry({
    name,
    type,
    size,
    mtime,
    rights: permsFromUnix(head[1] + head[2]),
    owner,
    group,
    linkTarget,
    isSymlink: type === 'link',
    raw: line,
  });
}

/**
 * A DOS / IIS listing line, e.g.
 *   `04-27-00  09:09PM       <DIR>          licensed`
 *   `12-05-1996  05:03PM              45876 README.TXT`
 */
function parseDosLine(line) {
  const m = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{2}):(\d{2})\s*([AaPp][Mm])?\s+(<DIR>|<JUNCTION>|[\d,]+)\s+(.*)$/.exec(line);
  if (!m) return null;
  let year = Number(m[3]);
  // Two-digit years: IIS pivots at 70, matching the convention every other FTP
  // client picked so listings from the 1990s do not land in 2090.
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
  let hour = Number(m[4]);
  const ampm = (m[6] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const mtime = new Date(year, Number(m[1]) - 1, Number(m[2]), hour, Number(m[5])).getTime();
  const isDir = m[7].startsWith('<');
  const name = m[8].replace(/[\r\n]+$/, '');
  if (!name || name === '.' || name === '..') return null;
  return entry({
    name,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : Number(m[7].replace(/,/g, '')),
    mtime,
    raw: line,
  });
}

const VMS_MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** `(RWED,RWED,RE,)` → `rwxrw-r--`-ish. VMS Delete has no unix equivalent. */
function rightsFromVms(prot) {
  const groups = String(prot || '').split(',');
  // system,owner,group,world — we render owner/group/world, as unix does.
  const pick = (g) => {
    const s = (g || '').toUpperCase();
    return (s.includes('R') ? 'r' : '-') + (s.includes('W') ? 'w' : '-') + (s.includes('E') ? 'x' : '-');
  };
  return pick(groups[1]) + pick(groups[2]) + pick(groups[3]);
}

/**
 * VMS listing entries, e.g.
 *   `DIRECTORY.DIR;1      1/9    2-JUN-2005 07:12 [SYSTEM]  (RWED,RWED,RE,)`
 *
 * VMS wraps long names onto their own line with the rest of the record
 * indented underneath, so this takes the already-joined record text.
 */
function parseVmsRecord(text, opts) {
  const trimVersions = !opts || opts.trimVmsVersions !== false;
  const m = /^([^\s;]+);(\d+)\s+(\d+)(?:\/(\d+))?\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?/
    .exec(text.trim());
  if (!m) return null;
  const month = VMS_MONTHS[m[6].toUpperCase()];
  if (month === undefined) return null;
  const mtime = new Date(Number(m[7]), month, Number(m[5]), Number(m[8]), Number(m[9]), Number(m[10] || 0)).getTime();

  let name = m[1];
  const version = m[2];
  let type = 'file';
  if (/\.DIR$/i.test(name)) { type = 'dir'; name = name.replace(/\.DIR$/i, ''); }
  else if (!trimVersions) name = `${name};${version}`;

  // VMS reports allocation in 512-byte blocks, used/allocated.
  const size = Number(m[3]) * 512;
  const ownerField = (m[11] || '').split(',');
  return entry({
    name,
    type,
    size: type === 'dir' ? 0 : size,
    mtime,
    rights: m[12] ? rightsFromVms(m[12]) : '',
    owner: (ownerField[1] || ownerField[0] || '').trim(),
    group: ownerField.length > 1 ? (ownerField[0] || '').trim() : '',
    raw: text,
  });
}

/**
 * An MLSD line (RFC 3659), e.g.
 *   `type=file;size=1234;modify=20200303092200;UNIX.mode=0644; report.txt`
 *
 * Facts may not contain a space, so the first space ends them.
 */
function parseMlsdLine(line) {
  const sp = line.indexOf(' ');
  if (sp < 0) return null;
  const name = line.slice(sp + 1).replace(/[\r\n]+$/, '');
  if (!name || name === '.' || name === '..') return null;

  // A fact list with no `name=value` in it is not an MLSD line at all — it is
  // ordinary prose that happens to contain a space. Without this check the
  // MLSD parser swallows every unrecognised line in auto-detect mode.
  const factText = line.slice(0, sp);
  if (!factText.includes('=')) return null;

  const facts = {};
  for (const part of factText.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    facts[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  const t = (facts.type || '').toLowerCase();
  // 'cdir'/'pdir' are the current and parent directory; the panel adds those
  // itself, and listing them twice confuses recursive walks.
  if (t === 'cdir' || t === 'pdir') return null;

  let type = 'file';
  if (t === 'dir') type = 'dir';
  else if (t.startsWith('os.unix=slink') || t === 'link') type = 'link';

  let mtime = 0;
  const mod = facts.modify;
  if (mod && /^\d{14}/.test(mod)) {
    // MLSD timestamps are UTC, which is the whole reason MLSD is preferable.
    mtime = Date.UTC(
      Number(mod.slice(0, 4)), Number(mod.slice(4, 6)) - 1, Number(mod.slice(6, 8)),
      Number(mod.slice(8, 10)), Number(mod.slice(10, 12)), Number(mod.slice(12, 14)),
      mod.length > 15 ? Number(mod.slice(15, 18).padEnd(3, '0')) : 0,
    );
  }

  let rights = '';
  const mode = facts['unix.mode'];
  if (mode && /^[0-7]{3,4}$/.test(mode)) {
    const bits = mode.slice(-3).split('').map(Number);
    rights = bits.map((b) => (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-')).join('');
  }

  return entry({
    name,
    type,
    size: Number(facts.size || facts.sizd || 0) || 0,
    mtime,
    rights,
    owner: facts['unix.ownername'] || facts['unix.owner'] || '',
    group: facts['unix.groupname'] || facts['unix.group'] || '',
    linkTarget: t.startsWith('os.unix=slink:') ? facts.type.slice('OS.unix=slink:'.length) : '',
    isSymlink: type === 'link',
    // RFC 3659 `perm` letters: any of w/c/d/f/a/m means something can be
    // changed. Their complete absence is the server saying "read only".
    readOnly: facts.perm !== undefined && !/[wcdfam]/i.test(facts.perm),
    raw: line,
  });
}

/** Which dialect a raw listing is written in. Exported for the tests. */
function detectListingStyle(raw) {
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim());
  let mlsd = 0; let dos = 0; let unix = 0; let vms = 0;
  for (const line of lines.slice(0, 40)) {
    if (/^\s*(type|size|modify|perm)=/i.test(line)) { mlsd++; continue; }
    if (/^[bcdlpsSD\-fw][rwxstST\-]{9}/.test(line)) { unix++; continue; }
    if (/^\d{2}-\d{2}-\d{2,4}\s+\d{2}:\d{2}/.test(line)) { dos++; continue; }
    if (/^[^\s;]+;\d+/.test(line) || /^\s+\d+\/\d+\s+\d{1,2}-[A-Za-z]{3}-\d{4}/.test(line)) { vms++; continue; }
  }
  const best = Math.max(mlsd, unix, dos, vms);
  if (!best) return 'unknown';
  if (best === mlsd) return 'mlsd';
  if (best === unix) return 'unix';
  if (best === dos) return 'dos';
  return 'vms';
}

/**
 * Parse a raw directory listing into normalized entries.
 *
 * The style is auto-detected rather than configured, because a single session
 * can hit both styles (a unix server exporting a VMS-backed mount, or a proxy
 * that rewrites listings), and because it makes the parser testable in
 * isolation from a connection.
 */
function parseListing(raw, opts) {
  const style = (opts && opts.style) || detectListingStyle(raw);
  const lines = String(raw).split(/\r?\n/);
  const out = [];

  if (style === 'vms') {
    // Join wrapped records: a bare `NAME.EXT;1` line continues on the next.
    const records = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (/^(Directory\s|Total of\s|%|\s*$)/i.test(line.trim()) && !/^[^\s;]+;\d+/.test(line.trim())) continue;
      if (/^[^\s;]+;\d+\s*$/.test(line.trim()) && i + 1 < lines.length) {
        records.push(`${line.trim()} ${lines[i + 1].trim()}`);
        i++;
      } else {
        records.push(line);
      }
    }
    for (const rec of records) {
      const e = parseVmsRecord(rec, opts);
      if (e) out.push(e);
    }
    return out;
  }

  const now = (opts && opts.now) || new Date();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^total\s+\d+/i.test(line.trim())) continue;   // unix `ls -l` header
    let e = null;
    if (style === 'mlsd') e = parseMlsdLine(line);
    else if (style === 'dos') e = parseDosLine(line);
    else if (style === 'unix') e = parseUnixLine(line, now);
    else e = parseMlsdLine(line) || parseUnixLine(line, now) || parseDosLine(line);
    if (e) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Option plumbing
// ---------------------------------------------------------------------------

// WinSCP names code pages the way Windows does; Node names them the way ICU
// does, and only supports a handful. Anything unknown falls back to latin1,
// which at least round-trips bytes rather than mangling them into U+FFFD.
const CODE_PAGES = {
  'utf-8': 'utf8', utf8: 'utf8', 65001: 'utf8',
  ascii: 'ascii', 'us-ascii': 'ascii',
  'iso-8859-1': 'latin1', latin1: 'latin1', 'windows-1252': 'latin1', 1252: 'latin1', 28591: 'latin1',
  'ucs-2': 'utf16le', 'utf-16le': 'utf16le', 1200: 'utf16le',
};

const TLS_VERSIONS = {
  tls10: 'TLSv1', tls11: 'TLSv1.1', tls12: 'TLSv1.2', tls13: 'TLSv1.3',
  ssl3: 'TLSv1',   // SSLv3 is not offered by Node at all; TLS 1.0 is the floor.
};

function encodingFor(codePage) {
  if (!codePage) return 'utf8';
  return CODE_PAGES[String(codePage).toLowerCase()] || 'latin1';
}

/** `rwxr-xr-x` or `755` → the octal number SITE CHMOD wants. */
function rightsToOctal(rights) {
  if (/^[0-7]{3,4}$/.test(String(rights))) return String(rights);
  const s = String(rights).padEnd(9, '-').slice(0, 9);
  let out = '';
  for (let i = 0; i < 9; i += 3) {
    out += String((s[i] !== '-' ? 4 : 0) + (s[i + 1] !== '-' ? 2 : 0) + (s[i + 2] !== '-' ? 1 : 0));
  }
  return out;
}

/** Date → `YYYYMMDDHHMMSS` in UTC, the format MFMT and MDTM use. */
function ftpTimestamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * A write stream that does not report `finish` until the server has actually
 * acknowledged the transfer. Without this the queue would mark an upload done
 * the moment the last byte left the process, and a 552 quota error arriving a
 * moment later would have nowhere to go.
 */
class FtpUploadStream extends PassThrough {
  constructor() {
    super();
    this.transfer = null;
  }

  _final(cb) {
    super._final((err) => {
      if (err) { cb(err); return; }
      if (!this.transfer) { cb(); return; }
      this.transfer.then(() => cb(), (e) => cb(e));
    });
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

class FtpAdapter extends Adapter {
  /**
   * @param session  a site record shaped like SESSION_DEFAULTS
   * @param options  host services injected by session.js:
   *                 `certVerifier(host, cert, problem)` → boolean|Promise<boolean>
   *                 `log(level, message)`
   *                 `password` / `passphrase` overrides resolved from crypto.js
   */
  constructor(session, options = {}) {
    super(session);
    this.options = options;
    this.client = null;
    this.cwd = '/';
    this.features = new Map();
    this._lock = Promise.resolve();
    this._keepalive = null;
    this._busy = false;
    this._listCommand = null;   // locked in once one works, like WinSCP does
    this.caps = {
      ...this.caps,
      rights: false,          // set from FEAT/SITE HELP after login
      owner: false,           // FTP has no portable chown
      symlink: false,         // no portable symlink creation
      exec: false,            // SITE EXEC is not a shell and is near-extinct
      resume: false,          // set from `REST STREAM` in FEAT
      timestamp: false,       // set from MFMT/MDTM in FEAT
      checksum: false,        // set from XCRC/XMD5/XSHA in FEAT
      copyRemote: false,
      nativeMove: true,       // RNFR/RNTO moves within the server
      hiddenFiles: true,
      spaceInfo: false,
    };
  }

  get protocolName() { return this.session.ftps && this.session.ftps !== 'none' ? 'FTPS' : 'FTP'; }

  // -- serialization -------------------------------------------------------

  /**
   * FTP multiplexes nothing: one control connection, one command at a time.
   * Everything funnels through here so a keepalive ping can never land in the
   * middle of a listing and a second panel refresh can never race a transfer.
   */
  _run(fn) {
    const run = this._lock.then(async () => {
      this._busy = true;
      try { return await fn(); } finally { this._busy = false; }
    });
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  _log(level, message) {
    if (this.options.log) this.options.log(level, message);
    this.emit('log', { level, message });
  }

  // -- TLS -----------------------------------------------------------------

  _tlsOptions() {
    const s = this.session;
    const opts = {
      servername: s.hostName,
      minVersion: TLS_VERSIONS[s.minTlsVersion] || 'TLSv1',
      maxVersion: TLS_VERSIONS[s.maxTlsVersion] || 'TLSv1.3',
      // Verification is NOT disabled here — it is moved into `_verifyPeer()`,
      // which runs before a single credential byte is sent. Node's built-in
      // check can only say yes or no; WinSCP's model is to show the user the
      // fingerprint of an unknown certificate and let them decide, and that
      // decision has to happen after the handshake exposes the certificate.
      // With no verifier injected, `_verifyPeer()` refuses anything Node's own
      // chain validation rejected, so the default is strictly no weaker.
      rejectUnauthorized: false,
    };
    if (s.tlsCertificateFile) {
      // WinSCP's "Client certificate" field: a PEM holding the client cert and
      // its key, and often the CA that signed the server too.
      const pem = fs.readFileSync(s.tlsCertificateFile);
      opts.cert = pem;
      opts.key = pem;
      opts.ca = pem;
    }
    return opts;
  }

  /**
   * Ask the application about the peer certificate. Returning false, or having
   * no verifier at all when Node's chain validation already failed, closes the
   * connection before login.
   */
  async _verifyPeer() {
    const socket = this.client.ftp.socket;
    if (!socket || typeof socket.getPeerCertificate !== 'function') return;
    const cert = socket.getPeerCertificate(true);
    const authorized = socket.authorized === true;
    const problem = authorized ? null : String(socket.authorizationError || 'certificate not trusted');
    const summary = {
      subject: cert.subject, issuer: cert.issuer,
      valid_from: cert.valid_from, valid_to: cert.valid_to,
      fingerprint: cert.fingerprint, fingerprint256: cert.fingerprint256,
      serialNumber: cert.serialNumber, subjectaltname: cert.subjectaltname,
      authorized, problem,
    };
    this.serverInfo.certificate = summary;

    let accepted = authorized;
    if (this.options.certVerifier) {
      accepted = await this.options.certVerifier(this.session.hostName, summary, problem);
    }
    if (!accepted) {
      this.client.close();
      throw new Error(`TLS certificate rejected for ${this.session.hostName}: ${problem || 'not accepted'}`);
    }
  }

  // -- lifecycle -----------------------------------------------------------

  async connect() {
    const s = this.session;
    const timeoutMs = Math.max(0, Number(s.timeout || 15)) * 1000;

    // `allowSeparateTransferHost: false` is basic-ftp's "always dial the host
    // we are already talking to", which is exactly WinSCP's "Force IP address
    // for passive mode connections". Left at true, basic-ftp still ignores a
    // private address advertised by a public server, which is the 'auto'
    // behaviour WinSCP defaults to.
    this.client = new Client(timeoutMs);
    this.client.ftp.verbose = false;
    this.client.ftp.encoding = encodingFor(s.codePage);
    if (s.addressFamily === 'ipv4') this.client.ftp.ipFamily = 4;
    else if (s.addressFamily === 'ipv6') this.client.ftp.ipFamily = 6;

    const secure = s.ftps === 'implicit' ? 'implicit' : (s.ftps === 'explicitTls' || s.ftps === 'explicit');
    const tlsOptions = secure ? this._tlsOptions() : null;
    const port = Number(s.portNumber) || (s.ftps === 'implicit' ? 990 : 21);

    if (secure === 'implicit') {
      await this.client.connectImplicitTLS(s.hostName, port, tlsOptions);
      await this._verifyPeer();
    } else {
      await this.client.connect(s.hostName, port);
      if (secure) {
        await this.client.useTLS(tlsOptions, 'AUTH TLS');
        await this._verifyPeer();
      }
    }

    if (secure && s.sslSessionReuse === false) {
      // basic-ftp always offers the control connection's TLS session to the
      // data connection (most FTPS servers require it). The only hook to turn
      // that off without forking the transfer strategy is the getter it reads.
      const sock = this.client.ftp.socket;
      sock.getSession = () => undefined;
    }

    await this._login();

    // TYPE I / STRU F / OPTS UTF8 / PBSZ+PROT for TLS.
    await this.client.useDefaultSettings();
    if (encodingFor(s.codePage) !== 'utf8') {
      // useDefaultSettings() turns UTF-8 on; a session pinned to a code page
      // must turn it back off or the server re-encodes names underneath us.
      await this.client.sendIgnoringError('OPTS UTF8 OFF');
      this.client.ftp.encoding = encodingFor(s.codePage);
    }

    try { this.features = await this.client.features(); } catch { this.features = new Map(); }
    await this._applyFeatures();

    if (!s.ftpPasvMode) {
      // Active mode is driven by `_activeTransfer()`; make sure basic-ftp's
      // passive preparation never runs behind our back.
      this.client.prepareTransfer = async () => { throw new Error('active mode handled by the adapter'); };
    }

    for (const cmd of s.postLoginCommands || []) {
      if (cmd) await this.client.sendIgnoringError(cmd);
    }

    this.home = await this.client.pwd();
    this.cwd = this.home;
    this.connected = true;
    this._startKeepalive();
    return { home: this.home, features: [...this.features.keys()] };
  }

  /** USER / PASS / ACCT. basic-ftp's `login()` rejects 332, which is the one
   *  case `ftpAccount` exists for. */
  _login() {
    const s = this.session;
    const user = s.anonymous ? 'anonymous' : (s.userName || 'anonymous');
    const password = s.anonymous
      ? (this.options.password || 'anonymous@')
      : (this.options.password !== undefined ? this.options.password : s.password);
    const account = s.ftpAccount || '';
    const ftp = this.client.ftp;

    return ftp.handle(`USER ${user}`, (res, task) => {
      if (res instanceof Error) { task.reject(res); return; }
      if (res.code >= 200 && res.code < 300) { task.resolve(res); return; }
      if (res.code === 331) { ftp.send(`PASS ${password || ''}`); return; }
      if (res.code === 332) {
        if (!account) { task.reject(new Error('Server requires an FTP account (ACCT); none configured')); return; }
        ftp.send(`ACCT ${account}`);
        return;
      }
      task.reject(new FTPError(res));
    });
  }

  /** Turn the FEAT reply into capability flags instead of guessing. */
  async _applyFeatures() {
    const has = (name) => this.features.has(name.toUpperCase());
    const featValue = (name) => this.features.get(name.toUpperCase()) || '';

    this.caps.resume = has('REST') && /STREAM/i.test(featValue('REST'));
    this.caps.timestamp = has('MFMT') || has('MDTM');
    this.caps.checksum = has('XCRC') || has('XMD5') || has('XSHA1') || has('XSHA256') || has('HASH');
    this.serverInfo.features = [...this.features.keys()];

    // SITE CHMOD is not reported by FEAT on most servers, so ask SITE HELP.
    let chmod = /CHMOD/i.test(featValue('SITE'));
    if (!chmod) {
      try {
        const help = await this.client.sendIgnoringError('SITE HELP');
        chmod = /CHMOD/i.test(help.message || '');
      } catch { chmod = false; }
    }
    this.caps.rights = chmod;
    this._siteChmod = chmod;
  }

  _startKeepalive() {
    const s = this.session;
    const seconds = Number(s.ftpPingInterval || 0);
    const type = s.ftpPingType || 'off';
    if (type === 'off' || !(seconds > 0)) return;
    this._keepalive = setInterval(() => {
      // Never queue behind real work: if the connection is busy it is by
      // definition not idle, and a queued NOOP would only delay a transfer.
      if (this._busy || !this.connected) return;
      this._run(async () => {
        if (type === 'directory') await this._rawList(this.cwd);
        else await this.client.sendIgnoringError('NOOP');
      }).catch((e) => this._log('debug', `keepalive failed: ${e.message}`));
    }, seconds * 1000);
    if (this._keepalive.unref) this._keepalive.unref();
  }

  async disconnect() {
    if (this._keepalive) { clearInterval(this._keepalive); this._keepalive = null; }
    this.connected = false;
    if (this.client) {
      try { await this.client.sendIgnoringError('QUIT'); } catch { /* the socket may already be gone */ }
      this.client.close();
      this.client = null;
    }
  }

  // -- active mode ---------------------------------------------------------

  /**
   * Drive one active-mode (PORT/EPRT) transfer.
   *
   * Active mode inverts the connection: we listen, tell the server where, and
   * it dials us after the transfer command. `basic-ftp`'s helpers cannot
   * express that (they require a live data socket up front), so the control
   * dialogue is handled here directly.
   *
   * @param command   the transfer command, e.g. `RETR /path` or `STOR /path`
   * @param pre       commands to send before it (REST for a resumed transfer)
   * @param wire      (dataSocket) => Promise, pipes the payload
   */
  _activeTransfer(command, pre, wire) {
    const ftp = this.client.ftp;
    const control = ftp.socket;
    const host = control.localAddress;
    const useV6 = control.localFamily === 'IPv6' || String(host).includes(':');

    return new Promise((resolve, reject) => {
      const server = net.createServer();
      let settled = false;
      let dataDone = false;
      let controlDone = false;
      let controlRes = null;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch { /* already closing */ }
        reject(err);
      };
      const maybeDone = (task) => {
        if (settled || !dataDone || !controlDone) return;
        settled = true;
        try { server.close(); } catch { /* already closing */ }
        task.resolve(controlRes);
        resolve(controlRes);
      };

      server.on('error', fail);
      server.listen(0, host, async () => {
        const addr = server.address();
        // EPRT works for both families and is what modern servers prefer;
        // PORT is the IPv4 fallback for servers that never learned RFC 2428.
        const portCmd = useV6
          ? `EPRT |2|${host}|${addr.port}|`
          : `PORT ${host.split('.').join(',')},${addr.port >> 8},${addr.port & 255}`;

        let accepted = null;
        const waitForData = new Promise((res) => server.once('connection', (sock) => { accepted = sock; res(sock); }));

        try {
          const portRes = await ftp.request(portCmd);
          if (portRes.code >= 400) { fail(new FTPError(portRes)); return; }
          for (const p of pre || []) {
            const r = await ftp.request(p);
            if (r.code >= 400) { fail(new FTPError(r)); return; }
          }

          await ftp.handle(command, (res, task) => {
            if (res instanceof Error) { fail(res); task.reject(res); return; }
            if (res.code === 150 || res.code === 125) {
              waitForData.then(async (raw) => {
                let sock = raw;
                if (control instanceof tls.TLSSocket) {
                  // RFC 4217: the FTP client stays the TLS client on the data
                  // connection even though the server opened the TCP session.
                  sock = tls.connect({
                    ...this.client.ftp.tlsOptions,
                    socket: raw,
                    session: this.session.sslSessionReuse === false ? undefined : control.getSession(),
                  });
                  await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
                }
                try {
                  await wire(sock);
                  dataDone = true;
                  maybeDone(task);
                } catch (e) { fail(e); task.reject(e); }
              }, (e) => { fail(e); task.reject(e); });
              return;
            }
            if (res.code >= 200 && res.code < 300) {
              controlDone = true; controlRes = res;
              maybeDone(task);
              return;
            }
            if (res.code >= 400) {
              if (accepted) accepted.destroy();
              fail(new FTPError(res));
              task.reject(new FTPError(res));
            }
          });
        } catch (e) { fail(e); }
      });
    });
  }

  // -- reading -------------------------------------------------------------

  /** Which LIST variants to try, most informative first. */
  _listCandidates() {
    const s = this.session;
    const mlsd = s.ftpUseMlsd || 'auto';
    const all = s.ftpListAll || 'auto';
    const out = [];
    const supportsMlsd = this.features.has('MLSD') || this.features.has('MLST');
    if (mlsd === 'on' || (mlsd === 'auto' && supportsMlsd)) out.push('MLSD');
    if (mlsd !== 'on') {
      if (all === 'on' || all === 'auto') out.push('LIST -a');
      if (all !== 'on') out.push('LIST');
    }
    return out.length ? out : ['LIST'];
  }

  /**
   * Fetch the raw listing text. basic-ftp owns the data-connection dance, so we
   * borrow `client.list()` but swap in a parser that just captures the bytes —
   * that keeps the fallback between LIST variants in our hands (basic-ftp locks
   * onto the first command that does not error, and `LIST -a` does not error on
   * a server that treats `-a` as a filename; it just returns nothing).
   */
  async _rawList(dir) {
    const candidates = this._listCommand ? [this._listCommand] : this._listCandidates();
    let raw = '';
    let lastErr = null;
    const original = this.client.parseList;
    for (const cmd of candidates) {
      raw = '';
      try {
        if (this.session.ftpPasvMode === false) {
          const path = dir && dir !== '/' ? ` ${dir}` : '';
          const chunks = [];
          await this._activeTransfer(`${cmd}${path}`, [], (sock) => new Promise((res, rej) => {
            sock.on('data', (c) => chunks.push(c));
            sock.on('end', res);
            sock.on('error', rej);
          }));
          raw = Buffer.concat(chunks).toString(this.client.ftp.encoding);
        } else {
          this.client.parseList = (text) => { raw = text; return []; };
          this.client.availableListCommands = [cmd];
          await this.client.list(dir);
        }
      } catch (e) {
        lastErr = e;
        if (!(e instanceof FTPError)) { this.client.parseList = original; throw e; }
        continue;
      } finally {
        this.client.parseList = original;
      }
      // `LIST -a` silently returning nothing means the server took `-a` as a
      // filename. Only accept the empty result from the last candidate.
      const empty = !raw.trim();
      if (empty && cmd === 'LIST -a' && candidates.length > 1) continue;
      this._listCommand = cmd;
      return raw;
    }
    if (lastErr) throw lastErr;
    return raw;
  }

  async list(dir) {
    const path = this.normalize(dir || this.cwd);
    return this._run(async () => {
      const raw = await this._rawList(path);
      return parseListing(raw, { trimVmsVersions: this.session.trimVMSVersions !== false });
    });
  }

  async stat(p) {
    const path = this.normalize(p);
    if (path === '/') return entry({ name: '/', type: 'dir' });
    return this._run(async () => {
      // MLST is the only command that answers "what is this path" precisely.
      if (this.features.has('MLST')) {
        const res = await this.client.sendIgnoringError(`MLST ${path}`);
        if (res.code >= 200 && res.code < 300) {
          for (const line of String(res.message).split(/\r?\n/)) {
            if (!/^\s*\S+=/.test(line)) continue;
            const e = parseMlsdLine(line.trim());
            if (e) { e.name = this.basename(path); return e; }
          }
        }
      }
      // Otherwise: SIZE + MDTM identify a file; a successful CWD identifies a
      // directory. Both are near-universal even where FEAT is not.
      let size = null; let mtime = 0;
      try { size = await this.client.size(path); } catch { size = null; }
      try { mtime = (await this.client.lastMod(path)).getTime(); } catch { mtime = 0; }
      if (size !== null) {
        return entry({ name: this.basename(path), type: 'file', size, mtime });
      }
      const back = this.cwd;
      try {
        await this.client.cd(path);
        await this.client.cd(back);
        return entry({ name: this.basename(path), type: 'dir', mtime });
      } catch { /* not a directory either */ }
      // Last resort: find it in the parent listing (VMS and some mainframes
      // support neither SIZE nor MDTM).
      const items = parseListing(await this._rawList(this.dirname(path)), {
        trimVmsVersions: this.session.trimVMSVersions !== false,
      });
      const want = this.basename(path);
      const found = items.find((i) => i.name === want);
      if (found) return found;
      throw new Error(`No such file or directory: ${path}`);
    });
  }

  async realpath(p) {
    const path = this.normalize(p);
    return this._run(async () => {
      const back = this.cwd;
      try {
        await this.client.cd(path);
        const real = await this.client.pwd();
        await this.client.cd(back);
        return real;
      } catch {
        return path;
      }
    });
  }

  /** `cd` is not part of the contract but the panel keeps a current directory
   *  so relative commands (and the 'directory' keepalive) stay cheap. */
  async chdir(p) {
    const path = this.normalize(p);
    return this._run(async () => {
      await this.client.cd(path);
      this.cwd = await this.client.pwd();
      return this.cwd;
    });
  }

  // -- writing -------------------------------------------------------------

  async mkdir(p, opts = {}) {
    const path = this.normalize(p);
    return this._run(async () => {
      if (opts.recursive) {
        const parts = path.split('/').filter(Boolean);
        let cur = path.startsWith('/') ? '' : '.';
        for (const part of parts) {
          cur = `${cur}/${part}`;
          const res = await this.client.sendIgnoringError(`MKD ${cur}`);
          // 550 here is almost always "already exists", which is not an error
          // for a recursive mkdir. A genuine permission failure surfaces on the
          // next level down or on the first write.
          if (res.code >= 400 && res.code !== 550 && res.code !== 521) throw new FTPError(res);
        }
        return;
      }
      await this.client.send(`MKD ${path}`);
    });
  }

  async remove(p, opts = {}) {
    const path = this.normalize(p);
    const info = await this.stat(path).catch(() => null);
    const isDir = info ? info.type === 'dir' : false;
    if (isDir && opts.recursive !== false) {
      const items = await this.list(path);
      for (const it of items) {
        await this.remove(this.join(path, it.name), opts);
      }
    }
    return this._run(async () => {
      if (isDir) await this.client.send(`RMD ${path}`);
      else await this.client.send(`DELE ${path}`);
    });
  }

  async rename(from, to) {
    const a = this.normalize(from);
    const b = this.normalize(to);
    return this._run(() => this.client.rename(a, b));
  }

  async setTimes(p, { mtime }) {
    const path = this.normalize(p);
    const stamp = ftpTimestamp(mtime);
    return this._run(async () => {
      if (this.features.has('MFMT')) {
        await this.client.send(`MFMT ${stamp} ${path}`);
        return;
      }
      // Pre-MFMT servers accept the non-standard two-argument MDTM that
      // ProFTPD and Serv-U popularised. There is no third option.
      const res = await this.client.sendIgnoringError(`MDTM ${stamp} ${path}`);
      if (res.code >= 400) throw new Error(`Server does not support setting timestamps (${res.message})`);
    });
  }

  async setRights(p, rights) {
    if (!this._siteChmod) throw new Error('Server does not advertise SITE CHMOD');
    const path = this.normalize(p);
    const octal = rightsToOctal(rights);
    return this._run(() => this.client.send(`SITE CHMOD ${octal} ${path}`));
  }

  // -- streaming -----------------------------------------------------------

  async createReadStream(p, opts = {}) {
    const path = this.normalize(p);
    const start = Number(opts.start || 0);
    if (start > 0 && !this.caps.resume) throw new Error('Server does not support REST; cannot resume');
    const out = new PassThrough();

    const transfer = this._run(async () => {
      if (this.session.ftpPasvMode === false) {
        const pre = start > 0 ? [`REST ${start}`] : [];
        return this._activeTransfer(`RETR ${path}`, pre, (sock) => new Promise((res, rej) => {
          sock.on('error', rej);
          out.on('error', rej);
          sock.pipe(out);
          sock.on('end', res);
        }));
      }
      return this.client.downloadTo(out, path, start);
    });
    transfer.catch((e) => out.destroy(e));
    return out;
  }

  async createWriteStream(p, opts = {}) {
    const path = this.normalize(p);
    const start = Number(opts.start || 0);
    if (start > 0 && !this.caps.resume) throw new Error('Server does not support REST; cannot resume');
    const src = new FtpUploadStream();

    src.transfer = this._run(async () => {
      if (this.session.ftpPasvMode === false) {
        const pre = start > 0 ? [`REST ${start}`] : [];
        return this._activeTransfer(`STOR ${path}`, pre, (sock) => new Promise((res, rej) => {
          sock.on('error', rej);
          src.on('error', rej);
          src.pipe(sock);
          sock.on('close', res);
          sock.on('finish', res);
        }));
      }
      // APPE is the portable way to resume an upload: REST+STOR is accepted by
      // fewer servers and silently truncates on some of them.
      if (start > 0) return this.client.appendFrom(src, path);
      return this.client.uploadFrom(src, path);
    });
    src.transfer.catch((e) => { if (!src.destroyed) src.destroy(e); });
    return src;
  }

  // -- optional ------------------------------------------------------------

  async checksum(p, algorithm = 'sha-1') {
    const path = this.normalize(p);
    const map = { 'sha-1': 'XSHA1', sha1: 'XSHA1', 'sha-256': 'XSHA256', sha256: 'XSHA256', md5: 'XMD5', crc32: 'XCRC' };
    const cmd = map[String(algorithm).toLowerCase()];
    if (!cmd || !this.features.has(cmd)) throw new Error(`Server does not support ${algorithm} checksums`);
    return this._run(async () => {
      const res = await this.client.send(`${cmd} ${path}`);
      const m = /([0-9a-fA-F]{8,128})\s*$/.exec(res.message);
      if (!m) throw new Error(`Unparseable checksum reply: ${res.message}`);
      return m[1].toLowerCase();
    });
  }
}

module.exports = {
  FtpAdapter,
  parseListing,
  detectListingStyle,
  parseUnixLine,
  parseDosLine,
  parseVmsRecord,
  parseMlsdLine,
  rightsToOctal,
  ftpTimestamp,
};
