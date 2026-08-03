// sftp-extensions.js — the depth behind `sftp.js`: SFTP extended requests,
// server-capability negotiation, WinSCP's broken-server workaround matrix, and
// the SSH-layer error/banner/host-key rules ported from `core/SecureShell.cpp`.
//
// Why this file exists at all
// ---------------------------
// `ssh2` gives us SFTP version 3 and a hand-picked set of OpenSSH extended
// requests. WinSCP's `core/SftpFileSystem.cpp` speaks a much wider dialect: it
// parses the whole SSH_FXP_VERSION extension block, decides what the server can
// do from it, and sends nine different extended requests — most of which `ssh2`
// has no method for. Answering "the library cannot do it" would make every one
// of those capabilities permanently `false`, which is *not* the same statement
// as "the server does not offer it": a real OpenSSH box does offer them.
//
// So the extended requests are built and sent on the wire here, against the SFTP
// channel `ssh2` already owns:
//
//   * OUTBOUND — an SSH_FXP_EXTENDED packet is assembled byte for byte and
//     written through the channel with the same SSH window accounting `ssh2`
//     itself performs (`tryWritePayload` in `ssh2/lib/protocol/SFTP.js`).
//     Bypassing that accounting would desynchronise the peer's flow-control
//     window and eventually wedge the channel, so it is reproduced, not skipped.
//   * INBOUND — `SFTP.prototype.push` is wrapped once, per process, so we can
//     see the raw SSH_FXP_EXTENDED_REPLY payload. `ssh2` parses only the three
//     replies it knows (`statvfs`, `limits`, `users-groups-by-id`) and *discards
//     the body* of everything else, which is exactly the body `check-file`,
//     `md5-hash@openssh.com` and `space-available` carry their answer in. The
//     wrapper observes and copies; it never alters what `ssh2` receives, and
//     when the library's shape ever changes it fails closed — `available`
//     becomes false and every raw request refuses with a plain message rather
//     than corrupting the channel.
//
// The same wrapper recovers the *raw bytes* of the VERSION extension pairs.
// `ssh2` stores them UTF-8-decoded, which destroys `vendor-id`, `supported2`
// and `fs-roots@vandyke.com` — binary structures whose bytes are not text.
//
// Nothing here logs a secret: extended requests carry paths, algorithm names
// and hashes, never credentials.
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- constants

/** SFTP packet types (draft-ietf-secsh-filexfer). */
const SFTP_PACKET = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8,
  SETSTAT: 9, FSETSTAT: 10, OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14,
  RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, SYMLINK: 20,
  LINK: 21, BLOCK: 22, UNBLOCK: 23,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
  EXTENDED: 200, EXTENDED_REPLY: 201,
};

/** SSH_FX_* status codes and the messages WinSCP shows for them. */
const SFTP_STATUS_MESSAGE = [
  'Unexpected OK response.',
  'Unexpected EOF response.',
  'No such file or directory.',
  'Permission denied.',
  'General failure (server should provide error description).',
  'Bad message (badly formatted packet or protocol incompatibility).',
  'No connection.',
  'Connection lost.',
  'The server does not support the operation.',
  'Invalid handle.',
  'The file path does not exist or is invalid.',
  'File already exists.',
  'The file is on read-only media, or the media is write protected.',
  'There is no media available in the drive.',
  'There is insufficient free space on the filesystem.',
  "Operation cannot be completed because it would exceed the user's storage quota.",
  'Principal (%s) is unknown to the server.',
  'The file could not be opened because it is locked by another process.',
  'The directory is not empty.',
  'The specified file is not a directory.',
  'The filename is not valid.',
  'Too many symbolic links encountered.',
  'The file cannot be deleted.',
  'One of the parameters was out of range, or the parameters specified cannot be used together.',
  'The specified file was a directory in a context where a directory cannot be used.',
  'Byte range lock conflict.',
  'Byte range lock refused.',
  'An operation was attempted on a file for which a delete operation is pending.',
  'The file is corrupt; an filesystem integrity check should be run.',
  'The name specified can not be assigned as an owner of a file.',
  'The name specified can not be assigned as the primary group of a file.',
  'The requested operation could not be completed because the specified byte range lock has not been granted.',
];

const SSH_FX_OK = 0;
const SSH_FX_FAILURE = 4;
const SSH_FX_OP_UNSUPPORTED = 8;

/**
 * WinSCP appends this to every SSH_FX_FAILURE, because "General failure" on its
 * own has sent more people to the forum than any other message in the product.
 */
const SFTP_STATUS_4_HINT = [
  'Common reasons for the Error code 4 are:',
  '- Renaming a file to a name of already existing file.',
  '- Creating a directory that already exists.',
  '- Moving a remote file to a different filesystem (HDD).',
  '- Uploading a file to a full filesystem (HDD).',
  "- Exceeding a user disk quota.",
].join('\n');

/** Every extension name WinSCP knows by name (`SFTP_EXT_*`). */
const EXT = {
  OWNER_GROUP: 'owner-group-query@generic-extensions',
  OWNER_GROUP_REPLY: 'owner-group-query-reply@generic-extensions',
  NEWLINE: 'newline',
  SUPPORTED: 'supported',
  SUPPORTED2: 'supported2',
  FSROOTS: 'fs-roots@vandyke.com',
  VENDOR_ID: 'vendor-id',
  VERSIONS: 'versions',
  SPACE_AVAILABLE: 'space-available',
  CHECK_FILE: 'check-file',
  CHECK_FILE_NAME: 'check-file-name',
  CHECK_FILE_HANDLE: 'check-file-handle',
  STATVFS: 'statvfs@openssh.com',
  FSTATVFS: 'fstatvfs@openssh.com',
  HARDLINK: 'hardlink@openssh.com',
  COPY_FILE: 'copy-file',
  COPY_DATA: 'copy-data',
  LIMITS: 'limits@openssh.com',
  POSIX_RENAME: 'posix-rename@openssh.com',
  FSYNC: 'fsync@openssh.com',
  LSETSTAT: 'lsetstat@openssh.com',
  EXPAND_PATH: 'expand-path@openssh.com',
  HOME_DIRECTORY: 'home-directory',
  MD5_HASH: 'md5-hash',
  MD5_HASH_HANDLE: 'md5-hash-handle',
  USERS_GROUPS_BY_ID: 'users-groups-by-id@openssh.com',
};

/** Attribute-mask bits from the `supported`/`supported2` structures. */
const ATTR = {
  SIZE: 0x00000001,
  UIDGID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACMODTIME: 0x00000008,
  ACCESSTIME: 0x00000008,
  CREATETIME: 0x00000010,
  MODIFYTIME: 0x00000020,
  ACL: 0x00000040,
  OWNERGROUP: 0x00000080,
  SUBSECOND_TIMES: 0x00000100,
  BITS: 0x00000200,
  ALLOCATION_SIZE: 0x00000400,
  TEXT_HINT: 0x00000800,
  MIME_TYPE: 0x00001000,
  LINK_COUNT: 0x00002000,
  UNTRANSLATED_NAME: 0x00004000,
  CTIME: 0x00008000,
  EXTENDED: 0x80000000,
};

/** `statvfs@openssh.com` f_flag bits. */
const STATVFS_ST_RDONLY = 0x1;
const STATVFS_ST_NOSUID = 0x2;

const SFTP_MIN_VERSION = 0;
const SFTP_STANDARD_VERSION = 3;
const SFTP_MAX_VERSION = 6;
/** WinSCP's `SFTP_MAX_PACKET_LEN`; a longer reply is a protocol violation. */
const SFTP_MAX_PACKET_LEN = 1024000;

/** `SSH_FXP_REALPATH` control bytes (SFTP 6). */
const REALPATH_NO_CHECK = 0x01;
const REALPATH_STAT_IF = 0x02;
const REALPATH_STAT_ALWAYS = 0x03;

/** OGQ_LIST_* selectors for `owner-group-query@generic-extensions`. */
const OGQ_LIST_OWNERS = 0x01;
const OGQ_LIST_GROUPS = 0x02;

/**
 * WinSCP's checksum algorithm registry for SFTP, in the order
 * draft-ietf-secsh-filexfer-extensions-00 defines — with MD5 moved behind the
 * SHA family, because offering MD5 first would have people picking it.
 * Left: the name the UI uses. Right: the name that goes on the wire.
 */
const CHECKSUM_ALGS = [
  ['sha-1', 'sha1'],
  ['sha-224', 'sha224'],
  ['sha-256', 'sha256'],
  ['sha-384', 'sha384'],
  ['sha-512', 'sha512'],
  ['md5', 'md5'],
  ['crc32', 'crc32'],
];

// -------------------------------------------------------------- wire codec

/** Build an SFTP packet body. Lengths are big-endian, strings length-prefixed. */
class PacketWriter {
  constructor() { this.parts = []; this.length = 0; }

  _push(buf) { this.parts.push(buf); this.length += buf.length; return this; }

  byte(v) { return this._push(Buffer.from([v & 0xff])); }

  bool(v) { return this.byte(v ? 1 : 0); }

  uint32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(v >>> 0, 0);
    return this._push(b);
  }

  /**
   * 64-bit big-endian. Values above 2^53 cannot be represented exactly by a
   * JavaScript number, so a BigInt is accepted and used verbatim when the caller
   * has one — a file offset past 9 PB is not hypothetical on an object store.
   */
  uint64(v) {
    const b = Buffer.allocUnsafe(8);
    if (typeof v === 'bigint') { b.writeBigUInt64BE(v, 0); return this._push(b); }
    const n = Number(v) || 0;
    b.writeUInt32BE(Math.floor(n / 4294967296) >>> 0, 0);
    b.writeUInt32BE(n >>> 0, 4);
    return this._push(b);
  }

  /** A length-prefixed string. `encoding` carries WinSCP's UTF-8 switch. */
  string(v, encoding = 'utf8') {
    const body = Buffer.isBuffer(v) ? v : Buffer.from(String(v), encoding);
    this.uint32(body.length);
    return this._push(body);
  }

  /** Raw bytes with no length prefix (a hash, or a pre-encoded struct). */
  raw(buf) { return this._push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }

  toBuffer() { return Buffer.concat(this.parts, this.length); }
}

/**
 * Read an SFTP packet body. Every accessor refuses to run off the end, because
 * a truncated reply from a broken server must be an error we report, not an
 * exception from deep inside Buffer with no context attached.
 */
class PacketReader {
  constructor(buf, offset = 0) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    this.pos = offset;
  }

  get remaining() { return Math.max(0, this.buf.length - this.pos); }

  _need(n, what) {
    if (this.remaining < n) {
      throw new Error(`The server's reply ended early: ${what} needs ${n} more byte(s), ${this.remaining} left`);
    }
  }

  canRead(n) { return this.remaining >= n; }

  byte() { this._need(1, 'a byte'); return this.buf[this.pos++]; }

  bool() { return this.byte() !== 0; }

  uint32() {
    this._need(4, 'a 32-bit field');
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint16() {
    this._need(2, 'a 16-bit field');
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  uint64() {
    this._need(8, 'a 64-bit field');
    const hi = this.buf.readUInt32BE(this.pos);
    const lo = this.buf.readUInt32BE(this.pos + 4);
    this.pos += 8;
    return hi * 4294967296 + lo;
  }

  /** Length-prefixed bytes. */
  bytes() {
    const len = this.uint32();
    this._need(len, 'a string body');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(encoding = 'utf8') { return this.bytes().toString(encoding); }

  /** Everything from here to the end, as raw bytes. */
  rest() {
    const out = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return out;
  }

  /**
   * WinSCP's `CanGetString`: is there a length-prefixed string here, and how
   * long is it? Used to tell VShell's malformed `versions` value from a
   * correctly encoded one without throwing.
   */
  peekStringSize() {
    if (this.remaining < 4) return null;
    const len = this.buf.readUInt32BE(this.pos);
    if (this.remaining < 4 + len) return null;
    return len;
  }
}

/**
 * WinSCP's `DisplayableStr`: quote a value that is printable ASCII, hex-dump
 * anything else. Extension values go straight into the session log and half of
 * them are binary structures; printing those raw would corrupt the log.
 */
function displayableStr(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value == null ? '' : value), 'latin1');
  let displayable = true;
  for (const b of buf) {
    if ((b < 0x20 || b > 0x7e) && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0x08) {
      displayable = false;
      break;
    }
  }
  if (!displayable) return '0x' + buf.toString('hex').toUpperCase();
  let out = '"';
  for (const b of buf) {
    if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x08) out += '\\b';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

// ------------------------------------------------------- server identification

/**
 * WinSCP's `IsOpenSSH()`. Sun SSH is a fork of OpenSSH and inherited its bugs,
 * so it must answer to the same workarounds.
 */
function isOpenSSH(ident) {
  const s = String(ident || '');
  return s.startsWith('OpenSSH') || s.startsWith('Sun_SSH');
}

/**
 * `TSecureShell::Open()`'s implementation sniffing. The identification string
 * is the *only* thing a server tells us before we have to decide which of its
 * bugs to work around, so this mapping is load-bearing rather than cosmetic.
 */
function detectSshImplementation(ident) {
  const s = String(ident || '');
  if (isOpenSSH(s)) return 'openssh';
  // e.g. "mod_sftp/0.9.8"
  if (s.startsWith('mod_sftp')) return 'proftpd';
  // e.g. "5.25 FlowSsh: Bitvise SSH Server (WinSSHD) 6.07"
  if (s.includes('FlowSsh')) return 'bitvise';
  // e.g. "srtSSHServer_10.00"
  if (s.includes('srtSSHServer')) return 'titan';
  if (s.includes('OpenVMS')) return 'openvms';
  if (s.includes('CerberusFTPServer')) return 'cerberus';
  return 'unknown';
}

/**
 * The wider vendor list `TSecureShell::CollectUsage()` recognises. WinSCP only
 * counts these, but the same strings are what the workarounds below key on, so
 * they are identified rather than lumped into "other".
 */
function detectServerVendor(ident) {
  const s = String(ident || '');
  const impl = detectSshImplementation(s);
  if (impl !== 'unknown') return impl;
  if (s.includes('Serv-U')) return 'serv-u';
  if (s.includes('WS_FTP')) return 'ws_ftp';
  if (s.includes('GlobalSCAPE')) return 'globalscape';
  if (s.includes('CompleteFTP')) return 'completeftp';
  if (s.includes('CoreFTP')) return 'coreftp';
  if (s.includes('SSHD-CORE')) return 'apache-mina';
  if (s.includes('Syncplify')) return 'syncplify';
  if (s.includes('zFTPServer')) return 'zftpserver';
  if (s.includes('Momentum SSH Server')) return 'momentum';
  if (s.startsWith('Foxit-WAC-Server')) return 'foxit-wac';
  if (s.includes('VShell')) return 'vshell';
  return 'unknown';
}

/**
 * `TSecureShell::CanChangePassword()`. OpenSSH's `userauth_passwd` and
 * ProFTPD's `sftp_auth_password` both refuse a password change outright, so
 * offering the command against them would be a dialog that can only fail.
 */
function canChangePassword(implementation) {
  return implementation !== 'openssh' && implementation !== 'proftpd';
}

/**
 * ProFTPD's major version, from `mod_sftp/<major>.<minor>.<patch>`. Bug 4080
 * (the link-argument order) was fixed when that major went from 0 to 1, so the
 * number is the whole test.
 */
function proftpdMajorVersion(ident) {
  const m = /^mod_sftp\/(\d+)/.exec(String(ident || ''));
  return m ? Number(m[1]) : 0;
}

// ------------------------------------------------- VERSION extension parsing

/**
 * Parse the `supported` / `supported2` structure. Both start with the same five
 * 32-bit fields; `supported2` then adds two 16-bit vectors and two counted name
 * lists, which were only defined in revision 08 while the extension itself
 * appeared in revision 07 — so a short value is normal and must not throw.
 */
function parseSupport(value, name) {
  const r = new PacketReader(value);
  const support = {
    loaded: true,
    source: name,
    attributeMask: 0,
    attributeBits: 0,
    openFlags: 0,
    accessMask: 0,
    maxReadSize: 0,
    openBlockVector: 0,
    blockVector: 0,
    attribExtensions: [],
    extensions: [],
  };
  support.attributeMask = r.uint32();
  support.attributeBits = r.uint32();
  support.openFlags = r.uint32();
  support.accessMask = r.uint32();
  support.maxReadSize = r.uint32();
  if (name === EXT.SUPPORTED) {
    while (r.remaining > 0) support.extensions.push(r.string('latin1'));
    return support;
  }
  if (r.canRead(2)) support.openBlockVector = r.uint16();
  if (r.canRead(2)) support.blockVector = r.uint16();
  if (r.canRead(4)) {
    const count = r.uint32();
    for (let i = 0; i < count && r.remaining > 0; i++) support.attribExtensions.push(r.string('latin1'));
  }
  if (r.canRead(4)) {
    const count = r.uint32();
    for (let i = 0; i < count && r.remaining > 0; i++) support.extensions.push(r.string('latin1'));
  }
  return support;
}

/** `vendor-id`: who wrote the server, and which build. */
function parseVendorId(value) {
  const r = new PacketReader(value);
  return {
    vendorName: r.string(),
    productName: r.string(),
    productVersion: r.string(),
    productBuildNumber: r.uint64(),
  };
}

/**
 * `fs-roots@vandyke.com`: the drive letters a Windows server exposes, so the
 * panel can offer them instead of pretending the tree has one root. A malformed
 * entry aborts the *whole* list, exactly as WinSCP does — a half-decoded root
 * list would navigate the user somewhere that does not exist.
 */
function parseFsRoots(value) {
  const r = new PacketReader(value);
  const roots = [];
  const detail = [];
  try {
    while (r.remaining > 0) {
      const marker = r.uint32();
      if (marker !== 1) break;
      const drive = r.byte();
      const type = r.byte();
      roots.push(String.fromCharCode(drive) + ':');
      detail.push({ drive: String.fromCharCode(drive), type });
    }
  } catch {
    return { roots: [], detail: [], failed: true };
  }
  return { roots, detail, failed: false };
}

/**
 * `versions`. VShell up to 4.0.3 encoded this as a length-prefixed string
 * inside the value rather than as the value itself; WinSCP tries that reading
 * first and falls back to the plain one, so both spellings show the same list.
 */
function parseVersions(value) {
  const r = new PacketReader(value);
  const size = r.peekStringSize();
  if (size !== null && size === r.remaining - 4) {
    return { versions: r.string('latin1'), format: 'vshell' };
  }
  return { versions: Buffer.from(value).toString('latin1'), format: 'standard' };
}

/**
 * Parse the extension name/value pairs from SSH_FXP_VERSION into everything the
 * rest of the port needs to know about the server.
 *
 * @param pairs  `[{ name, value: Buffer }]` — raw bytes. Pass `{name: 'string'}`
 *               only when the raw bytes were unavailable; values that were
 *               lossily decoded are then refused rather than misparsed.
 * @param opts   `{ version, log }`
 */
function parseServerExtensions(pairs, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const version = Number.isFinite(opts.version) ? opts.version : SFTP_STANDARD_VERSION;

  const list = normalizeExtensionPairs(pairs);
  const result = {
    version,
    names: [],
    supported: new Set(),
    display: [],
    unknown: [],
    eol: '\r\n',
    eolFromServer: false,
    support: {
      loaded: false,
      source: null,
      attributeMask: 0,
      attributeBits: 0,
      openFlags: 0,
      accessMask: 0,
      maxReadSize: 0,
      openBlockVector: 0,
      blockVector: 0,
      attribExtensions: [],
      extensions: [],
    },
    vendor: null,
    fixedPaths: null,
    versions: null,
    statVfsV2: false,
    hardlinkV1: false,
    limitsV1: false,
  };

  // WinSCP only reads the extension block for SFTP 3 and newer; earlier
  // versions have no such field and the bytes would be someone else's.
  if (version < 3) return result;

  for (const { name, value } of list) {
    const display = displayableStr(value);

    if (name === EXT.NEWLINE) {
      const eol = value.toString('latin1');
      log('info', `Server requests EOL sequence ${display}.`);
      if (eol.length < 1 || eol.length > 2) {
        throw new Error(`Server requires unsupported end-of-line sequence (${display}).`);
      }
      result.eol = eol;
      result.eolFromServer = true;
    } else if ((name === EXT.SUPPORTED && !result.support.loaded) || name === EXT.SUPPORTED2) {
      // "supported" must never overwrite "supported2": Bitvise sends both, and
      // only the second carries the extension list we act on.
      try {
        result.support = parseSupport(value, name);
        for (const e of result.support.extensions) result.supported.add(e);
        log('debug',
          `Server support information (${name}): attribute mask ${hex(result.support.attributeMask)}, `
          + `attribute bits ${hex(result.support.attributeBits)}, open flags ${hex(result.support.openFlags)}, `
          + `access mask ${hex(result.support.accessMask)}, open block vector ${hex(result.support.openBlockVector)}, `
          + `block vector ${hex(result.support.blockVector)}, max read size ${result.support.maxReadSize}`);
        if (result.support.attribExtensions.length) {
          log('debug', `  Attribute extensions (${result.support.attribExtensions.length}): ${result.support.attribExtensions.join(', ')}`);
        }
        if (result.support.extensions.length) {
          log('debug', `  Extensions (${result.support.extensions.length}): ${result.support.extensions.join(', ')}`);
        }
      } catch (e) {
        log('warn', `Failed to decode ${name} extension: ${e.message}`);
      }
    } else if (name === EXT.VENDOR_ID) {
      try {
        result.vendor = parseVendorId(value);
        log('info', `Server software: ${result.vendor.productName} ${result.vendor.productVersion} (${result.vendor.productBuildNumber}) by ${result.vendor.vendorName}`);
      } catch (e) {
        log('warn', `Failed to decode ${name} extension: ${e.message}`);
      }
    } else if (name === EXT.FSROOTS) {
      const parsed = parseFsRoots(value);
      if (parsed.failed) log('warn', `Failed to decode ${name} extension`);
      result.fixedPaths = parsed.roots;
      if (parsed.roots.length) log('info', `File system roots: ${parsed.roots.join(', ')}`);
    } else if (name === EXT.VERSIONS) {
      const parsed = parseVersions(value);
      result.versions = parsed.versions;
      log('info', parsed.format === 'vshell'
        ? `SFTP versions supported by the server (VShell format): ${parsed.versions}`
        : `SFTP versions supported by the server: ${parsed.versions}`);
    } else if (name === EXT.STATVFS) {
      const v = value.toString('latin1');
      if (v === '2') { result.statVfsV2 = true; log('debug', `Supports ${name} extension version ${v}`); }
      else log('debug', `Unsupported ${name} extension version ${v}`);
    } else if (name === EXT.HARDLINK) {
      const v = value.toString('latin1');
      if (v === '1') { result.hardlinkV1 = true; log('debug', `Supports ${name} extension version ${v}`); }
      else log('debug', `Unsupported ${name} extension version ${v}`);
    } else if (name === EXT.LIMITS) {
      const v = value.toString('latin1');
      if (v === '1') { result.limitsV1 = true; log('debug', `Supports ${name} extension version ${v}`); }
      else log('debug', `Unsupported ${name} extension version ${v}`);
    } else if (name === EXT.COPY_FILE || name === EXT.COPY_DATA
      || name === EXT.SPACE_AVAILABLE || name === EXT.CHECK_FILE || name === EXT.POSIX_RENAME) {
      log('debug', `Supports extension ${name}=${display}`);
    } else {
      result.unknown.push(name);
      log('debug', `Unknown server extension ${name}=${display}`);
    }

    result.names.push(name);
    result.supported.add(name);
    result.display.push(display ? `${name}=${display}` : name);
  }

  return result;
}

function hex(n) { return '0x' + (n >>> 0).toString(16); }

/**
 * Accept either the raw pair list this module's capture produces, or `ssh2`'s
 * `_extensions` object. In the second case the value has already been through a
 * UTF-8 decode, which is lossless only for text values — a structure containing
 * a byte above 0x7F comes back with U+FFFD where its bytes were. Those are
 * marked so the parser above skips the structural readings instead of decoding
 * nonsense with total confidence.
 */
function normalizeExtensionPairs(pairs) {
  if (!pairs) return [];
  if (Array.isArray(pairs)) {
    return pairs.map((p) => ({
      name: String(p.name),
      value: Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value == null ? '' : p.value), 'latin1'),
      lossy: false,
    }));
  }
  return Object.keys(pairs).map((name) => {
    const raw = pairs[name];
    const text = String(raw == null ? '' : raw);
    return {
      name,
      // The bytes are gone; latin1 at least preserves what survived, and the
      // replacement character tells us the decode already destroyed something.
      value: Buffer.from(text, 'utf8'),
      lossy: text.includes('�'),
    };
  });
}

/** WinSCP's `SupportsExtension`: announced directly, or inside supported/supported2. */
function supportsExtension(caps, name) {
  return !!(caps && caps.supported && caps.supported.has(name));
}

// ------------------------------------------------------ capability resolution

/**
 * `TSFTPFileSystem::IsCapable`, in full. Every answer here decides whether a
 * command in the UI is offered or greyed out, so a wrong `true` is a menu entry
 * that can only produce an error.
 *
 * @param ctx `{ caps, implementation, version, encrypting, localEol }`
 */
function resolveCapabilities(ctx = {}) {
  const caps = ctx.caps || parseServerExtensions([], { version: ctx.version });
  const version = Number.isFinite(ctx.version) ? ctx.version : caps.version;
  const impl = ctx.implementation || 'unknown';
  const encrypting = !!ctx.encrypting;
  const support = caps.support || { loaded: false, attributeMask: 0 };
  const bitvise = impl === 'bitvise';
  const has = (n) => supportsExtension(caps, n);

  return {
    // SSH_FXP_RENAME only exists from version 2.
    rename: version >= 2,
    remoteMove: version >= 2,
    // Symlinks exist from version 3; an encrypted site cannot have them at all,
    // because the link target would have to be written in clear.
    symbolicLink: version >= 3 && !encrypting,
    resolveSymlink: version >= 3 && !encrypting,
    modeChanging: !support.loaded || (support.attributeMask & ATTR.PERMISSIONS) !== 0,
    modeChangingUpload: !support.loaded || (support.attributeMask & ATTR.PERMISSIONS) !== 0,
    // Numeric ids only exist on the wire up to version 3; from 4 the attribute
    // block carries names.
    groupOwnerChangingByID: version <= 3,
    ownerChanging: version <= 3
      || (version >= 4 && (!support.loaded || (support.attributeMask & ATTR.OWNERGROUP) !== 0)),
    groupChanging: version <= 3
      || (version >= 4 && (!support.loaded || (support.attributeMask & ATTR.OWNERGROUP) !== 0)),
    nativeTextMode: !encrypting && version >= 4,
    textMode: !encrypting
      && (version >= 4 || caps.eol !== (ctx.localEol || '\r\n')),
    userGroupListing: has(EXT.OWNER_GROUP),
    // VShell reports owner/group in `supported` but omits them from READDIR
    // replies, and Bitvise before 6.21 sends no `supported` at all — both need
    // the extra per-file stat that this flag turns on.
    loadingAdditionalProperties:
      (support.loaded && (support.attributeMask & (ATTR.PERMISSIONS | ATTR.OWNERGROUP)) !== 0)
      || bitvise,
    checkingSpaceAvailable: has(EXT.SPACE_AVAILABLE) || caps.statVfsV2 || bitvise,
    // The specification says `check-file`; VShell 4.0.3 announces the *request*
    // name `check-file-name` instead, and refusing it would lose checksums on
    // every VShell server.
    calculatingChecksum: !encrypting
      && (has(EXT.CHECK_FILE) || has(EXT.CHECK_FILE_NAME) || bitvise),
    remoteCopy: has(EXT.COPY_FILE) || has(EXT.COPY_DATA) || bitvise,
    hardLink: version >= 6 || caps.hardlinkV1,
    changePassword: canChangePassword(impl),
    posixRename: has(EXT.POSIX_RENAME),
    fsync: has(EXT.FSYNC),
    lsetstat: has(EXT.LSETSTAT),
    expandPath: has(EXT.EXPAND_PATH),
    homeDirectory: has(EXT.HOME_DIRECTORY),
    limits: caps.limitsV1,
    statvfs: caps.statVfsV2 || bitvise,
  };
}

// --------------------------------------------------------- the bug workarounds

/**
 * Every entry below exists because a real server broke, and each is named for
 * the server that broke it. `applies()` is the detection; `workaround` is what
 * we do instead. Keeping them in a table rather than scattered through the
 * adapter means the session log can *list* which workarounds are active, which
 * is the first question anyone debugging a weird server asks.
 */
const SFTP_BUGS = [
  {
    id: 'signedTimestamps',
    server: 'OpenSSH and most SFTP 3 servers',
    symptom: 'Timestamps before 1970 (and after 2038) are sent as signed 32-bit values, though the protocol says unsigned.',
    workaround: 'Read the 32-bit time fields as signed for SFTP 3 and older.',
    applies: (c) => c.version < 4 && (c.bug('signedTS') === 'on' || c.bug('signedTS') === 'auto'),
  },
  {
    id: 'symlinkArgumentOrderReversed',
    server: 'OpenSSH, ProFTPD/mod_sftp 0.x',
    symptom: 'SSH_FXP_SYMLINK takes its two paths the wrong way round compared with the specification.',
    workaround: 'Send the link target first and the link name second.',
    applies: (c) => {
      if (c.bug('symlink') === 'on') return true;
      if (c.bug('symlink') === 'off') return false;
      if (c.version >= 6) {
        // SSH_FXP_LINK got the order right — except in ProFTPD 0.x, which
        // copied OpenSSH's mistake into its LINK implementation too (bug 4080).
        return c.implementation === 'proftpd' && proftpdMajorVersion(c.ident) === 0;
      }
      return c.implementation === 'openssh' || c.implementation === 'proftpd';
    },
  },
  {
    id: 'hardlinkArgumentOrderReversed',
    server: 'OpenSSH',
    symptom: 'hardlink@openssh.com is specified with the reversed argument order, to mirror the symlink bug.',
    workaround: 'Always send the existing path first — the "wrong" order is the correct one for this extension.',
    applies: () => true,
  },
  {
    id: 'realPathControlByteMisread',
    server: 'ProFTPD/mod_sftp',
    symptom: 'SSH_FXP_REALPATH_STAT_ALWAYS (0x03) is bit-tested wrongly and read as SSH_FXP_REALPATH_NO_CHECK (0x01), so a missing path silently succeeds.',
    workaround: 'Send SSH_FXP_REALPATH_STAT_IF (0x02) instead, the only value that conforms and still works.',
    applies: (c) => c.version >= 6 && c.implementation === 'proftpd',
  },
  {
    id: 'realPathMalformedForMissingPath',
    server: 'ProFTPD/mod_sftp 1.3.5rc1 – 1.3.5-stable',
    symptom: 'A completely malformed response is sent for a non-existent path when NO_CHECK is in force (bug 4160).',
    workaround: 'Always send a control byte that makes the request fail rather than relying on the default.',
    applies: (c) => c.version >= 6,
  },
  {
    id: 'noUtf8Strings',
    server: 'Foxit-WAC-Server',
    symptom: 'Strings are sent in the local code page while claiming SFTP 3, where UTF-8 is not mandatory.',
    workaround: 'Do not encode or decode as UTF-8 for this server.',
    applies: (c) => c.notUtf === 'auto' && String(c.ident || '').startsWith('Foxit-WAC-Server'),
  },
  {
    id: 'lstatUnsupported',
    server: 'FTPShell Server',
    symptom: 'SSH_FXP_LSTAT is answered with SSH_FX_OP_UNSUPPORTED, so a directory cannot be probed before entering it.',
    workaround: 'Fall back to opening the directory and closing it again — which then cannot enter a traverse-only (chmod 110) directory.',
    applies: () => true,
    // The adapter's read-only stat() probe falls back to STAT when this status
    // is observed. Destructive operations intentionally keep LSTAT so a
    // symlink cannot be mistaken for its target.
    enforced: true,
  },
  {
    id: 'statusMessageOmitted',
    server: 'Cisco SFTP servers',
    symptom: 'SSH_FXP_STATUS arrives with no message field even at version 3, where the field is mandatory.',
    workaround: 'Treat the message and the language tag as optional and report "None" for the server text.',
    applies: () => true,
    // The tolerance is in the SSH library's own status parser, not in anything
    // this file does, so it is documented rather than announced as ours.
    enforced: false,
  },
  {
    id: 'languageTagOmitted',
    server: 'SSH-2.0-Maverick_SSHD, CIGNA SFTP Server',
    symptom: 'The language tag is missing from SSH_FXP_STATUS.',
    workaround: 'Stop reading the status packet once the message has been taken.',
    applies: () => true,
    enforced: false,
  },
  {
    id: 'fileTypeZero',
    server: 'SSH-2.0-cryptlib',
    symptom: 'SSH_FXP_LSTAT answers with file type 0, which the protocol does not define.',
    workaround: 'Map type 0 to "unknown" instead of rejecting the reply.',
    applies: (c) => c.version >= 4,
  },
  {
    id: 'uidGidFlagWithoutFields',
    server: 'SSH-2.0-3.2.0 F-SECURE SSH – Process Software MultiNet',
    symptom: 'SSH_FILEXFER_ATTR_UIDGID is set on a version 4 attribute block, where those fields no longer exist.',
    workaround: 'Only read the numeric uid/gid pair when the version is below 4.',
    applies: (c) => c.version >= 4,
  },
  {
    id: 'versionsExtensionIsStruct',
    server: 'VShell before 4.0.3',
    symptom: 'The "versions" extension value is a length-prefixed string inside the value rather than the value itself.',
    workaround: 'Try the structure reading first, fall back to the plain one.',
    applies: () => true,
  },
  {
    id: 'checkFileAnnouncedByRequestName',
    server: 'VShell 4.0.3',
    symptom: 'The checksum extension is announced as "check-file-name" — the request name — instead of "check-file".',
    workaround: 'Accept either name as evidence that checksums work.',
    applies: () => true,
  },
  {
    id: 'extensionsNotAnnounced',
    server: 'Bitvise WinSSHD before 6.21',
    symptom: 'No extension list is sent at all, though space-available, checksums and remote copy all work.',
    workaround: 'Enable those capabilities on the identification string alone and let the request fail if the server really cannot.',
    applies: (c) => c.implementation === 'bitvise',
  },
  {
    id: 'copyFileCannotOverwrite',
    server: 'ProFTPD/mod_sftp, Bitvise WinSSHD',
    symptom: 'copy-file refuses to overwrite an existing target, though the specification does not require that.',
    workaround: 'Open the destination with SSH_FXF_EXCL on the copy-data path too, so both paths refuse identically rather than one silently overwriting.',
    applies: () => true,
  },
  {
    id: 'higherVersionThanRequested',
    server: 'ProFTPD/mod_sftp',
    symptom: 'The negotiated version can come back higher than the one we asked for (proftpd issue 1200).',
    workaround: 'Log it and continue, rather than treating it as a protocol violation.',
    applies: (c) => c.implementation === 'proftpd',
  },
  {
    id: 'spaceAvailableAllocationUnitIs16Bit',
    server: 'ProFTPD/mod_sftp',
    symptom: 'bytes-per-allocation-unit is sent as a 16-bit field instead of 32-bit (bug 4079).',
    workaround: 'Accept a 32-bit field, then a 16-bit one, then no field at all.',
    applies: () => true,
  },
  {
    id: 'limitedPacketSize',
    server: 'OpenSSH sftp-server, Momentum SSH Server',
    symptom: 'Packets larger than the server\'s internal buffer are dropped or the connection is closed.',
    workaround: 'Cap the outgoing packet size at the documented limit for that server.',
    applies: (c) => (c.implementation === 'openssh' && c.version === 3 && !c.supportLoaded)
      || String(c.ident || '').includes('Momentum SSH Server'),
  },
];

/**
 * Resolve the whole matrix for one server.
 *
 * @param ctx `{ implementation, ident, version, bugs: { signedTS, symlink },
 *              notUtf, supportLoaded }`
 * `active` carries only the workarounds this code actually performs, because it
 * is what the session log announces and what `serverInfo.workarounds` shows the
 * user. An entry we merely tolerate — or, worse, have not implemented — goes to
 * `documented` instead: announcing it would be a claim about our own behaviour
 * that is not true, and a debugging log nobody can trust is worse than none.
 *
 * @returns `{ <id>: boolean, active: [...], documented: [...] }`
 */
function resolveSftpBugs(ctx = {}) {
  const bugs = ctx.bugs || {};
  const context = {
    implementation: ctx.implementation || detectSshImplementation(ctx.ident),
    ident: ctx.ident || '',
    version: Number.isFinite(ctx.version) ? ctx.version : SFTP_STANDARD_VERSION,
    notUtf: ctx.notUtf || 'auto',
    supportLoaded: !!ctx.supportLoaded,
    bug: (name) => normalizeAutoSwitch(bugs[name]),
  };
  const out = { active: [], documented: [] };
  for (const bug of SFTP_BUGS) {
    const on = !!bug.applies(context);
    out[bug.id] = on;
    if (!on) continue;
    const entry = {
      id: bug.id, server: bug.server, workaround: bug.workaround, symptom: bug.symptom,
    };
    if (bug.enforced === false) out.documented.push(entry);
    else out.active.push(entry);
  }
  return out;
}

/** WinSCP's `TAutoSwitch`: on / off / auto, and anything else means auto. */
function normalizeAutoSwitch(v) {
  if (v === true || v === 'on' || v === 1) return 'on';
  if (v === false || v === 'off' || v === 0) return 'off';
  return 'auto';
}

/**
 * `DoStartup`'s version ceiling. WinSCP only asks for SFTP 6 from servers it
 * has actually seen implement it; everything else is held at 3, because a
 * half-finished version 4+ implementation breaks in ways that look like data
 * corruption rather than like a protocol error.
 */
function resolveMaxSftpVersion(configured, implementation) {
  let max;
  if (configured === undefined || configured === null || configured < 0) {
    if (implementation === 'openssh' || implementation === 'proftpd' || implementation === 'bitvise') {
      max = SFTP_MAX_VERSION;
    } else {
      max = SFTP_STANDARD_VERSION;
    }
  } else {
    max = Number(configured);
  }
  return Math.min(max, SFTP_MAX_VERSION);
}

/** The negotiated version WinSCP refuses outright. */
function checkNegotiatedVersion(version) {
  if (version < SFTP_MIN_VERSION || version > SFTP_MAX_VERSION) {
    throw new Error(`Version of SFTP server (${version}) is not supported. Supported versions are ${SFTP_MIN_VERSION} to ${SFTP_MAX_VERSION}.`);
  }
  return version;
}

/**
 * `DoStartup`'s packet-size ceiling. The four bytes are the length prefix the
 * limit does not count.
 *
 * @param ctx `{ configured, limits, implementation, version, supportLoaded, ident }`
 */
function resolveMaxPacketSize(ctx = {}) {
  const configured = Number(ctx.configured) || 0;
  if (configured > 0) return { size: configured, reason: 'configured for this site' };
  const overhead = 4;
  if (ctx.limits && Number(ctx.limits.maxPacketLength) > 0) {
    const size = Math.min(0xffffffff, Number(ctx.limits.maxPacketLength));
    return { size: size + overhead, reason: `the server's limits@openssh.com limit of ${size} + ${overhead} bytes` };
  }
  if (ctx.implementation === 'openssh' && ctx.version === 3 && !ctx.supportLoaded) {
    return { size: overhead + 256 * 1024, reason: "OpenSSH sftp-server's 256 kB limit" };
  }
  if (String(ctx.ident || '').includes('Momentum SSH Server')) {
    return { size: overhead + 32 * 1024, reason: "Momentum sftp-server's 32 kB limit" };
  }
  return { size: 0, reason: 'no limit known' };
}

/**
 * `DoStartup`'s UTF-8 decision. The interesting case is `auto` at SFTP 3, where
 * UTF-8 is *not* mandatory: WinSCP starts optimistic and turns it off the first
 * time a server sends a string that is not valid UTF-8, rather than mangling
 * every name from then on.
 */
function resolveUtfMode(ctx = {}) {
  const notUtf = normalizeAutoSwitch(ctx.notUtf);
  const version = Number.isFinite(ctx.version) ? ctx.version : SFTP_STANDARD_VERSION;
  if (notUtf === 'off') return { mode: 'on', reason: 'UTF-8 strings are configured for this site' };
  if (notUtf === 'on') return { mode: 'off', reason: 'UTF-8 strings are turned off for this site' };
  if (String(ctx.ident || '').startsWith('Foxit-WAC-Server')) {
    return { mode: 'off', reason: 'the server is known not to use UTF-8 strings' };
  }
  if (version >= 4) return { mode: 'on', reason: 'UTF-8 is mandatory from SFTP version 4' };
  return { mode: 'auto', reason: 'SFTP 3 does not mandate UTF-8; it is used until the server sends an invalid string' };
}

/**
 * The `auto` mode's downgrade. WinSCP's `GetUtfString` flips the switch the
 * first time a string does not decode, and announces it once.
 */
function detectUtf8(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  // A pure-ASCII string tells us nothing either way, so it must not flip the
  // switch — WinSCP's DetectUTF8Encoding returns "UTF-8" for it.
  const decoded = buf.toString('utf8');
  if (decoded.includes('�')) return 'ansi';
  return 'utf8';
}

/** The realpath control byte for this server, or `null` below SFTP 6. */
function realPathControlByte(version, implementation) {
  if (version < 6) return null;
  return implementation === 'proftpd' ? REALPATH_STAT_IF : REALPATH_STAT_ALWAYS;
}

// -------------------------------------------------- raw extended-request path

let SFTPClass = null;
let patchState = { patched: false, attempted: false, error: null };
const TAP = Symbol('winscp.sftp.tap');
const RAW_EXTENSIONS = Symbol('winscp.sftp.rawVersionExtensions');

function loadSftpClass() {
  if (SFTPClass !== null) return SFTPClass;
  try {
    // Guarded on purpose: if this internal path ever moves, the raw extension
    // layer reports itself unavailable rather than taking the process down.
    ({ SFTP: SFTPClass } = require('ssh2/lib/protocol/SFTP.js'));
  } catch {
    SFTPClass = false;
  }
  return SFTPClass;
}

/**
 * A frame observer that runs beside `ssh2`'s own parser on the same byte
 * stream. It keeps no payload it does not need: a packet type we do not care
 * about is *skipped* by arithmetic, so a running download does not pay for a
 * second copy of every data packet.
 */
class FrameTap {
  constructor() {
    this.lenBytes = 0;
    this.len = 0;
    this.pos = 0;
    this.type = 0;
    this.want = false;
    this.buf = null;
    this.broken = false;
    this.sawVersion = false;
    this.onVersion = null;
    this.onExtendedReply = null;
    this.pending = 0;
  }

  reset() {
    this.lenBytes = 0; this.len = 0; this.pos = 0; this.buf = null; this.want = false;
  }

  /** True when there is nothing this tap would keep, so it can skip cheaply. */
  get idle() { return this.sawVersion && this.pending === 0; }

  feed(data) {
    if (this.broken || !data || !data.length) return;
    let p = 0;
    while (p < data.length) {
      if (this.lenBytes < 4) {
        let nb = Math.min(4 - this.lenBytes, data.length - p);
        this.lenBytes += nb;
        while (nb--) this.len = (this.len * 256) + data[p++];
        if (this.lenBytes < 4) return;
        if (this.len === 0 || this.len > SFTP_MAX_PACKET_LEN) {
          // Either a protocol violation ssh2 is about to reject, or a framing
          // desync on our side. Either way, stop observing rather than guess.
          this.broken = true;
          return;
        }
        if (p >= data.length) return;
      }
      if (this.pos === 0) {
        this.type = data[p];
        this.want = (this.type === SFTP_PACKET.EXTENDED_REPLY && this.pending > 0)
          || (this.type === SFTP_PACKET.VERSION && !this.sawVersion);
        if (this.want) this.buf = Buffer.allocUnsafe(this.len);
      }
      const take = Math.min(this.len - this.pos, data.length - p);
      if (this.want) this.buf.set(data.subarray(p, p + take), this.pos);
      this.pos += take;
      p += take;
      if (this.pos < this.len) return;

      const type = this.type;
      const body = this.buf;
      this.reset();
      if (body) this._deliver(type, body);
    }
  }

  _deliver(type, body) {
    try {
      if (type === SFTP_PACKET.VERSION) {
        this.sawVersion = true;
        if (this.onVersion) this.onVersion(body);
      } else if (type === SFTP_PACKET.EXTENDED_REPLY && this.onExtendedReply) {
        this.onExtendedReply(body);
      }
    } catch {
      // An observer must never break the connection it is observing.
      this.broken = true;
    }
  }
}

/**
 * Parse the VERSION packet body into raw name/value pairs. `ssh2` keeps only a
 * UTF-8 decode of these, which is lossy for every binary extension value.
 */
function parseVersionPacket(body) {
  // body[0] is the packet type; the version follows.
  const r = new PacketReader(body, 1);
  const version = r.uint32();
  const pairs = [];
  while (r.remaining > 0) {
    let name;
    let value;
    try {
      name = r.string('latin1');
      value = Buffer.from(r.bytes());
    } catch {
      break;
    }
    pairs.push({ name, value });
  }
  return { version, pairs };
}

/**
 * Wrap `SFTP.prototype.push` once per process so every SFTP channel can be
 * observed. The wrapper is a pass-through: it copies what a registered tap
 * wants and then calls the original with the untouched argument.
 */
function installTapSupport() {
  if (patchState.attempted) return patchState.patched;
  patchState.attempted = true;
  const SFTP = loadSftpClass();
  if (!SFTP || typeof SFTP.prototype.push !== 'function') {
    patchState.error = 'This build of ssh2 does not expose the SFTP channel in the expected shape';
    return false;
  }
  const original = SFTP.prototype.push;
  function push(data) {
    let tap = this[TAP];
    if (tap === undefined && !this.server) {
      // Created on the first inbound byte so the VERSION packet — which arrives
      // before any caller can reach this instance — is still captured.
      tap = new FrameTap();
      tap.onVersion = (body) => {
        try { this[RAW_EXTENSIONS] = parseVersionPacket(body).pairs; } catch { this[RAW_EXTENSIONS] = null; }
      };
      this[TAP] = tap;
    }
    if (tap && data && !tap.idle) tap.feed(data);
    if (tap && data === null) tap.broken = true;
    return original.call(this, data);
  }
  SFTP.prototype.push = push;
  patchState.patched = true;
  return true;
}

/** The raw VERSION extension pairs for this channel, or `null`. */
function rawVersionExtensions(sftp) {
  return (sftp && sftp[RAW_EXTENSIONS]) || null;
}

/**
 * Send one SFTP packet on an `ssh2` SFTP channel with the same SSH window
 * accounting `ssh2` performs. Writing straight to `channelData` would leave our
 * bytes uncounted, the peer's window would drift from ours, and the channel
 * would stall some minutes later with nothing in the log to explain it.
 */
function sendPacket(sftp, packet) {
  const outgoing = sftp && sftp.outgoing;
  if (!outgoing || !sftp._protocol || typeof sftp._protocol.channelData !== 'function') {
    throw new Error('This build of ssh2 does not expose the SFTP channel in the expected shape');
  }
  if (outgoing.state !== 'open') throw new Error('The SFTP channel is not open');

  let p = 0;
  const len = packet.length;
  while (len - p > 0 && outgoing.window > 0) {
    const take = Math.min(len - p, outgoing.window, outgoing.packetSize);
    outgoing.window -= take;
    sftp._protocol.channelData(outgoing.id,
      (p === 0 && take === len) ? packet : packet.subarray(p, p + take));
    p += take;
  }
  if (len - p > 0) {
    // Out of window mid-packet. ssh2 parks the remainder on the same queue and
    // drains it from CHANNEL_WINDOW_ADJUST; joining that queue keeps ordering
    // correct instead of letting our tail overtake its head.
    sftp._waitWindow = true;
    sftp._buffer.push(packet.subarray(p, len));
    if (typeof sftp._chunkcb !== 'function') sftp._chunkcb = drainQueue;
  }
}

/**
 * The drain `ssh2` installs when *it* runs out of window. We only install this
 * when nothing is armed — a window that reaches zero through ssh2's own write
 * already carries ssh2's drain, and both operate on the same queue.
 */
function drainQueue() {
  this._chunkcb = undefined;
  const queue = this._buffer;
  while (queue.length) {
    const payload = queue[0];
    const outgoing = this.outgoing;
    if (outgoing.state !== 'open') { queue.length = 0; return; }
    let p = 0;
    while (payload.length - p > 0 && outgoing.window > 0) {
      const take = Math.min(payload.length - p, outgoing.window, outgoing.packetSize);
      outgoing.window -= take;
      this._protocol.channelData(outgoing.id,
        (p === 0 && take === payload.length) ? payload : payload.subarray(p, p + take));
      p += take;
    }
    if (payload.length - p > 0) {
      queue[0] = payload.subarray(p);
      this._waitWindow = true;
      this._chunkcb = drainQueue;
      return;
    }
    queue.shift();
  }
}

/**
 * The extended-request layer for one SFTP channel.
 *
 * Constructing it does not talk to the server; every request states plainly
 * whether the server advertised the extension, and `force` is how WinSCP's
 * Bitvise branch — "it works even though it announces nothing" — is expressed
 * without pretending the advertisement existed.
 */
class SftpExtensions {
  /**
   * @param sftp   an `ssh2` SFTP channel (the object `client.sftp()` yields)
   * @param opts   `{ caps, implementation, encoding, log }`
   */
  constructor(sftp, opts = {}) {
    this.sftp = sftp;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.encoding = opts.encoding === 'latin1' ? 'latin1' : 'utf8';
    this.implementation = opts.implementation || 'unknown';
    this.pending = new Map();
    this.available = installTapSupport();
    this.unavailableReason = this.available ? null : patchState.error;

    const raw = rawVersionExtensions(sftp);
    this.rawExtensions = raw;
    if (opts.caps) this.caps = opts.caps;
    else {
      this.caps = parseServerExtensions(raw || (sftp && sftp._extensions) || {}, {
        version: sftp && sftp._version,
        log: (level, message) => this.log(level, message),
      });
    }

    if (this.available && sftp && sftp[TAP]) {
      const tap = sftp[TAP];
      tap.onExtendedReply = (body) => this._onExtendedReply(body);
      this.tap = tap;
    } else {
      this.tap = null;
      if (!this.available) {
        this.log('warn', `SFTP extended requests are unavailable: ${this.unavailableReason}`);
      }
    }

    // A channel that goes away must not leave a caller waiting forever.
    if (sftp && typeof sftp.once === 'function') {
      const fail = (e) => this._failAll(e instanceof Error ? e : new Error('The SFTP channel closed'));
      sftp.once('close', () => fail(new Error('The SFTP channel closed before the server answered')));
      sftp.once('end', () => fail(new Error('The SFTP channel ended before the server answered')));
    }
  }

  /** Which extension names the server announced, for the session log. */
  get announced() { return this.caps ? this.caps.names.slice() : []; }

  supports(name) { return supportsExtension(this.caps, name); }

  _failAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    if (this.tap) this.tap.pending = 0;
  }

  _onExtendedReply(body) {
    const r = new PacketReader(body, 1);
    let reqid;
    try { reqid = r.uint32(); } catch { return; }
    const entry = this.pending.get(reqid);
    if (!entry) return;
    this.pending.delete(reqid);
    if (this.tap) this.tap.pending = this.pending.size;
    clearTimeout(entry.timer);
    entry.settled = true;
    entry.resolve(new PacketReader(body, r.pos));
  }

  /**
   * Send an SSH_FXP_EXTENDED request and wait for its reply.
   *
   * Resolves with a `PacketReader` positioned at the reply body for an
   * SSH_FXP_EXTENDED_REPLY, or with `null` when the server answered
   * SSH_FXP_STATUS with SSH_FX_OK — which is the correct answer for the
   * extensions that only act (hardlink, fsync, posix-rename, copy-data).
   *
   * @param name    the extension name
   * @param build   a callback given a `PacketWriter` to append the arguments
   * @param opts    `{ timeoutMs }`
   */
  request(name, build, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.available) {
        reject(new Error(`The extended request "${name}" cannot be sent: ${this.unavailableReason}`));
        return;
      }
      const sftp = this.sftp;
      if (!sftp || typeof sftp._writeReqid !== 'number' || !sftp._requests) {
        reject(new Error('This build of ssh2 does not expose the SFTP channel in the expected shape'));
        return;
      }

      const body = new PacketWriter();
      body.string(name, 'latin1');
      if (typeof build === 'function') build(body, this.encoding);
      const payload = body.toBuffer();

      const reqid = sftp._writeReqid = (sftp._writeReqid + 1) >>> 0;
      const packet = Buffer.allocUnsafe(4 + 1 + 4 + payload.length);
      packet.writeUInt32BE(1 + 4 + payload.length, 0);
      packet[4] = SFTP_PACKET.EXTENDED;
      packet.writeUInt32BE(reqid, 5);
      payload.copy(packet, 9);

      const entry = { resolve, reject, settled: false, timer: null, name };
      this.pending.set(reqid, entry);
      if (this.tap) this.tap.pending = this.pending.size;

      // ssh2 owns the request table, so the same id is registered there: a
      // status reply, or the channel being torn down, then lands here through
      // ssh2's own bookkeeping instead of leaking a request forever.
      sftp._requests[reqid] = {
        extended: name,
        cb: (err) => {
          if (entry.settled) return;             // the tap already answered
          const held = this.pending.get(reqid);
          if (held !== entry) return;
          this.pending.delete(reqid);
          if (this.tap) this.tap.pending = this.pending.size;
          clearTimeout(entry.timer);
          entry.settled = true;
          if (err) reject(decorateStatusError(err, name));
          else resolve(null);
        },
      };

      const timeoutMs = Number(opts.timeoutMs) || 0;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (entry.settled) return;
          this.pending.delete(reqid);
          if (this.tap) this.tap.pending = this.pending.size;
          delete sftp._requests[reqid];
          entry.settled = true;
          reject(new Error(`Timeout waiting for server to respond to ${name}`));
        }, timeoutMs);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      }

      this.log('debug', `SFTP extended request ${name}`);
      try {
        sendPacket(sftp, packet);
      } catch (e) {
        this.pending.delete(reqid);
        if (this.tap) this.tap.pending = this.pending.size;
        delete sftp._requests[reqid];
        entry.settled = true;
        clearTimeout(entry.timer);
        reject(e);
      }
    });
  }

  /** Send without waiting — the one case WinSCP does this is `vendor-id`. */
  send(name, build) {
    if (!this.available) throw new Error(`The extended request "${name}" cannot be sent: ${this.unavailableReason}`);
    const sftp = this.sftp;
    const body = new PacketWriter();
    body.string(name, 'latin1');
    if (typeof build === 'function') build(body, this.encoding);
    const payload = body.toBuffer();
    const reqid = sftp._writeReqid = (sftp._writeReqid + 1) >>> 0;
    const packet = Buffer.allocUnsafe(4 + 1 + 4 + payload.length);
    packet.writeUInt32BE(1 + 4 + payload.length, 0);
    packet[4] = SFTP_PACKET.EXTENDED;
    packet.writeUInt32BE(reqid, 5);
    payload.copy(packet, 9);
    // The reply is deliberately not reserved: WinSCP sends its identification
    // and does not care what the server thinks of it.
    sftp._requests[reqid] = { extended: name, cb: () => {} };
    sendPacket(sftp, packet);
    return reqid;
  }

  _refuse(name, forced) {
    if (forced) return;
    throw new Error(`The server does not offer the "${name}" extension`);
  }

  // ---- the extensions ---------------------------------------------------

  /**
   * `statvfs@openssh.com`. WinSCP requires version "2"; Bitvise answers it
   * without announcing anything, which is what `force` is for.
   */
  async statvfs(path, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.caps.statVfsV2) this._refuse(EXT.STATVFS, force);
    const r = await this.request(EXT.STATVFS, (w, enc) => w.string(path, enc), opts);
    return this._readStatVfs(r);
  }

  /** `fstatvfs@openssh.com` — the same answer for an already-open handle. */
  async fstatvfs(handle, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.FSTATVFS)) this._refuse(EXT.FSTATVFS, force);
    const r = await this.request(EXT.FSTATVFS, (w) => w.string(handle), opts);
    return this._readStatVfs(r);
  }

  _readStatVfs(r) {
    if (!r) throw new Error('The server acknowledged statvfs without sending the file system information');
    const st = {
      blockSize: r.uint64(),
      fundamentalBlockSize: r.uint64(),
      blocks: r.uint64(),
      freeBlocks: r.uint64(),
      availableBlocks: r.uint64(),
      fileInodes: r.uint64(),
      freeFileInodes: r.uint64(),
      availableFileInodes: r.uint64(),
      filesystemId: r.uint64(),
      flags: r.uint64(),
      nameMax: r.uint64(),
    };
    st.readOnly = (st.flags & STATVFS_ST_RDONLY) !== 0;
    st.noSuid = (st.flags & STATVFS_ST_NOSUID) !== 0;
    const named = [];
    if (st.readOnly) named.push('read-only');
    if (st.noSuid) named.push('no-setuid');
    const rest = st.flags & ~(STATVFS_ST_RDONLY | STATVFS_ST_NOSUID);
    if (rest !== 0) named.push('0x' + rest.toString(16));
    st.flagNames = named.length ? named : ['none'];
    // WinSCP reports the *device* totals from f_bsize, and has no
    // bytes-available-to-user figure to report from this extension at all.
    st.total = st.blockSize * st.blocks;
    st.unused = st.blockSize * st.freeBlocks;
    st.availableToUser = 0;
    st.unusedAvailableToUser = st.blockSize * st.availableBlocks;
    st.bytesPerAllocationUnit = st.blockSize > 0xffffffff ? 0 : st.blockSize;
    return st;
  }

  /**
   * `space-available`. The `bytes-per-allocation-unit` field was only added in
   * revision 07 while the extension appeared in revision 06, and ProFTPD sends
   * it as 16 bits (bug 4079) — so three shapes are all legal here.
   */
  async spaceAvailable(path, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.SPACE_AVAILABLE)) this._refuse(EXT.SPACE_AVAILABLE, force);
    const r = await this.request(EXT.SPACE_AVAILABLE, (w, enc) => w.string(path, enc), opts);
    if (!r) throw new Error('The server acknowledged space-available without sending the figures');
    const out = {
      bytesOnDevice: r.uint64(),
      unusedBytesOnDevice: r.uint64(),
      bytesAvailableToUser: r.uint64(),
      unusedBytesAvailableToUser: r.uint64(),
      bytesPerAllocationUnit: 0,
    };
    if (r.canRead(4)) {
      out.bytesPerAllocationUnit = r.uint32();
    } else if (r.canRead(2)) {
      this.log('debug', 'Assuming ProFTPD/mod_sftp bug of 2-byte bytes-per-allocation-unit field');
      out.bytesPerAllocationUnit = r.uint16();
      out.allocationUnitWas16Bit = true;
    } else {
      this.log('debug', 'Missing bytes-per-allocation-unit field');
    }
    return out;
  }

  /** `hardlink@openssh.com`. Its argument order mirrors OpenSSH's symlink bug. */
  async hardlink(existingPath, newPath, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.caps.hardlinkV1) this._refuse(EXT.HARDLINK, force);
    await this.request(EXT.HARDLINK, (w, enc) => {
      w.string(existingPath, enc);
      w.string(newPath, enc);
    }, opts);
    return true;
  }

  /** `posix-rename@openssh.com` — replaces the target atomically. */
  async posixRename(oldPath, newPath, opts = {}) {
    if (!this.supports(EXT.POSIX_RENAME)) this._refuse(EXT.POSIX_RENAME, opts.force);
    await this.request(EXT.POSIX_RENAME, (w, enc) => {
      w.string(oldPath, enc);
      w.string(newPath, enc);
    }, opts);
    return true;
  }

  /** `fsync@openssh.com` — flush an open handle to the server's disk. */
  async fsync(handle, opts = {}) {
    if (!this.supports(EXT.FSYNC)) this._refuse(EXT.FSYNC, opts.force);
    await this.request(EXT.FSYNC, (w) => w.string(handle), opts);
    return true;
  }

  /** `limits@openssh.com` — the server's own packet and handle ceilings. */
  async limits(opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.caps.limitsV1) this._refuse(EXT.LIMITS, force);
    const r = await this.request(EXT.LIMITS, null, opts);
    if (!r) throw new Error('The server acknowledged limits@openssh.com without sending any');
    return {
      maxPacketLength: r.uint64(),
      maxReadLength: r.uint64(),
      maxWriteLength: r.uint64(),
      maxOpenHandles: r.uint64(),
    };
  }

  /**
   * `copy-file` — a whole-file server-side copy. ProFTPD and Bitvise both
   * refuse to overwrite an existing target even though the specification does
   * not require that, so `overwrite: true` is offered but documented as a
   * request the server may decline.
   */
  async copyFile(fromPath, toPath, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.COPY_FILE)) this._refuse(EXT.COPY_FILE, force);
    await this.request(EXT.COPY_FILE, (w, enc) => {
      w.string(fromPath, enc);
      w.string(toPath, enc);
      w.bool(!!opts.overwrite);
    }, opts);
    return true;
  }

  /**
   * `copy-data` — copy a byte range between two *open handles*. `length: 0`
   * means "to the end of the source", which is what the whole-file copy uses.
   */
  async copyData(readHandle, writeHandle, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.COPY_DATA)) this._refuse(EXT.COPY_DATA, force);
    await this.request(EXT.COPY_DATA, (w) => {
      w.string(readHandle);
      w.uint64(opts.readOffset || 0);
      w.uint64(opts.length || 0);
      w.string(writeHandle);
      w.uint64(opts.writeOffset || 0);
    }, opts);
    return true;
  }

  /**
   * `check-file-name` / `check-file-handle` — the hash extension from
   * draft-ietf-secsh-filexfer-extensions-00. The reply names the algorithm the
   * server actually used, then carries the hashes as raw bytes: one for the
   * whole range when `blockSize` is 0, otherwise one per block.
   *
   * @param opts `{ algorithms, startOffset, length, blockSize, force }`
   */
  async checkFile(path, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.CHECK_FILE) && !this.supports(EXT.CHECK_FILE_NAME)) {
      this._refuse(EXT.CHECK_FILE, force);
    }
    const algorithms = normalizeChecksumAlgorithms(opts.algorithms);
    const blockSize = Number(opts.blockSize) || 0;
    const r = await this.request(EXT.CHECK_FILE_NAME, (w, enc) => {
      w.string(path, enc);
      w.string(algorithms, 'latin1');
      w.uint64(opts.startOffset || 0);
      w.uint64(opts.length || 0);
      w.uint32(blockSize);
    }, opts);
    return readCheckFileReply(r, blockSize);
  }

  /** The same request against an already-open handle. */
  async checkFileHandle(handle, opts = {}) {
    const force = opts.force || this.implementation === 'bitvise';
    if (!this.supports(EXT.CHECK_FILE) && !this.supports(EXT.CHECK_FILE_HANDLE)) {
      this._refuse(EXT.CHECK_FILE, force);
    }
    const algorithms = normalizeChecksumAlgorithms(opts.algorithms);
    const blockSize = Number(opts.blockSize) || 0;
    const r = await this.request(EXT.CHECK_FILE_HANDLE, (w) => {
      w.string(handle);
      w.string(algorithms, 'latin1');
      w.uint64(opts.startOffset || 0);
      w.uint64(opts.length || 0);
      w.uint32(blockSize);
    }, opts);
    return readCheckFileReply(r, blockSize);
  }

  /**
   * `md5-hash` — OpenSSH's older single-algorithm hash. `quickCheckHash` is the
   * first 32 bytes of the client's own hash: when it is supplied and does not
   * match, the server answers with an empty hash rather than reading the whole
   * file, which is the whole point of the extension.
   */
  async md5Hash(path, opts = {}) {
    if (!this.supports(EXT.MD5_HASH)) this._refuse(EXT.MD5_HASH, opts.force);
    const r = await this.request(EXT.MD5_HASH, (w, enc) => {
      w.string(path, enc);
      w.uint64(opts.startOffset || 0);
      w.uint64(opts.length || 0);
      w.string(opts.quickCheckHash || Buffer.alloc(0));
    }, opts);
    return readMd5HashReply(r);
  }

  /** `md5-hash-handle` — the same, against an open handle. */
  async md5HashHandle(handle, opts = {}) {
    if (!this.supports(EXT.MD5_HASH_HANDLE)) this._refuse(EXT.MD5_HASH_HANDLE, opts.force);
    const r = await this.request(EXT.MD5_HASH_HANDLE, (w) => {
      w.string(handle);
      w.uint64(opts.startOffset || 0);
      w.uint64(opts.length || 0);
      w.string(opts.quickCheckHash || Buffer.alloc(0));
    }, opts);
    return readMd5HashReply(r);
  }

  /**
   * `owner-group-query@generic-extensions` — the list of names a server will
   * accept for chown/chgrp, so the properties dialog can offer a list instead
   * of asking the user to guess.
   */
  async ownerGroupQuery(which, opts = {}) {
    if (!this.supports(EXT.OWNER_GROUP)) this._refuse(EXT.OWNER_GROUP, opts.force);
    const selector = which === 'groups' ? OGQ_LIST_GROUPS : OGQ_LIST_OWNERS;
    const r = await this.request(EXT.OWNER_GROUP, (w) => w.byte(selector), opts);
    if (!r) throw new Error('The server acknowledged owner-group-query without sending a list');
    const replyName = r.string('latin1');
    if (replyName !== EXT.OWNER_GROUP_REPLY) {
      throw new Error(`Invalid response to ${EXT.OWNER_GROUP}`);
    }
    const count = r.uint32();
    const names = [];
    for (let i = 0; i < count && r.remaining > 0; i++) names.push(r.string(this.encoding));
    return names;
  }

  /** `home-directory` — the server's idea of a user's home, without a shell. */
  async homeDirectory(userName = '', opts = {}) {
    if (!this.supports(EXT.HOME_DIRECTORY)) this._refuse(EXT.HOME_DIRECTORY, opts.force);
    const r = await this.request(EXT.HOME_DIRECTORY, (w, enc) => w.string(userName, enc), opts);
    if (!r) throw new Error('The server acknowledged home-directory without sending a path');
    return readNameReplyPath(r, this.encoding);
  }

  /**
   * `lsetstat@openssh.com` — set attributes on a symbolic link *without*
   * following it. Plain SSH_FXP_SETSTAT follows the link, so "preserve
   * timestamps" applied to a link silently rewrites the target's timestamp
   * instead of the link's, and the synchronizer then never converges.
   *
   * @param attrs `{ mode, uid, gid, atime, mtime, size }` — epoch seconds
   */
  async lsetstat(path, attrs = {}, opts = {}) {
    if (!this.supports(EXT.LSETSTAT)) this._refuse(EXT.LSETSTAT, opts.force);
    await this.request(EXT.LSETSTAT, (w, enc) => {
      w.string(path, enc);
      writeAttributes(w, attrs);
    }, opts);
    return true;
  }

  /** `expand-path@openssh.com` — tilde and variable expansion, server side. */
  async expandPath(path, opts = {}) {
    if (!this.supports(EXT.EXPAND_PATH)) this._refuse(EXT.EXPAND_PATH, opts.force);
    const r = await this.request(EXT.EXPAND_PATH, (w, enc) => w.string(path, enc), opts);
    if (!r) throw new Error('The server acknowledged expand-path without sending a path');
    return readNameReplyPath(r, this.encoding);
  }

  /**
   * `vendor-id` — tell the server who we are. WinSCP sends this and reserves
   * the reply without reading it, because nothing depends on the answer.
   */
  identify(info = {}) {
    if (!this.supports(EXT.VENDOR_ID)) this._refuse(EXT.VENDOR_ID, false);
    return this.send(EXT.VENDOR_ID, (w, enc) => {
      w.string(info.vendorName || '', enc);
      w.string(info.productName || '', enc);
      w.string(info.productVersion || '', enc);
      w.uint64(Number(info.productBuildNumber) || 0);
    });
  }
}

/**
 * The SFTP 3 attribute block: a flag word, then only the fields the flags
 * claim, in a fixed order. Sending a field whose flag is clear — or the other
 * way round — desynchronises the whole packet, which is why this is built from
 * one list rather than from separate branches.
 *
 * Access and modification time go together in version 3: there is one flag for
 * the pair, so setting only one still has to send both.
 */
function writeAttributes(w, attrs = {}) {
  let flags = 0;
  if (attrs.size !== undefined) flags |= ATTR.SIZE;
  if (attrs.uid !== undefined && attrs.gid !== undefined) flags |= ATTR.UIDGID;
  if (attrs.mode !== undefined) flags |= ATTR.PERMISSIONS;
  if (attrs.atime !== undefined || attrs.mtime !== undefined) flags |= ATTR.ACMODTIME;
  w.uint32(flags);
  if (flags & ATTR.SIZE) w.uint64(attrs.size);
  if (flags & ATTR.UIDGID) { w.uint32(attrs.uid); w.uint32(attrs.gid); }
  if (flags & ATTR.PERMISSIONS) w.uint32(attrs.mode);
  if (flags & ATTR.ACMODTIME) {
    const atime = attrs.atime === undefined ? attrs.mtime : attrs.atime;
    const mtime = attrs.mtime === undefined ? attrs.atime : attrs.mtime;
    w.uint32(atime);
    w.uint32(mtime);
  }
  return flags;
}

/**
 * The reply body of `check-file-*`: the algorithm the server chose, then the
 * hashes as raw bytes with no length prefix at all.
 */
function readCheckFileReply(r, blockSize) {
  if (!r) throw new Error('The server acknowledged the checksum request without sending a checksum');
  const algorithm = r.string('latin1');
  const bytes = Buffer.from(r.rest());
  const out = { algorithm, hex: bytes.toString('hex'), bytes, blocks: [] };
  if (blockSize > 0 && bytes.length > 0) {
    const size = hashLength(algorithm);
    if (size > 0 && bytes.length % size === 0) {
      for (let i = 0; i < bytes.length; i += size) {
        out.blocks.push(bytes.subarray(i, i + size).toString('hex'));
      }
    }
  }
  if (!out.blocks.length && bytes.length) out.blocks.push(out.hex);
  return out;
}

function readMd5HashReply(r) {
  if (!r) throw new Error('The server acknowledged the checksum request without sending a checksum');
  const name = r.string('latin1');
  // OpenSSH echoes "md5-hash" first; a server that omits it has put the hash
  // where the name should be, and a 16-byte "name" is exactly that.
  let bytes;
  if (name === EXT.MD5_HASH || name === EXT.MD5_HASH_HANDLE) bytes = Buffer.from(r.bytes());
  else bytes = Buffer.from(name, 'latin1');
  return { algorithm: 'md5', hex: bytes.toString('hex'), bytes, matched: bytes.length > 0 };
}

/** SSH_FXP_NAME carries a count and then filename/longname/attrs per entry. */
function readNameReplyPath(r, encoding) {
  const count = r.uint32();
  if (count !== 1) throw new Error('Received SSH_FXP_NAME packet with zero or multiple records.');
  return r.string(encoding);
}

/** Hash lengths for splitting a blocked `check-file` reply. */
function hashLength(algorithm) {
  switch (String(algorithm).toLowerCase()) {
    case 'md5': return 16;
    case 'sha1': case 'sha-1': return 20;
    case 'sha224': case 'sha-224': return 28;
    case 'sha256': case 'sha-256': return 32;
    case 'sha384': case 'sha-384': return 48;
    case 'sha512': case 'sha-512': return 64;
    case 'crc32': return 4;
    default: return 0;
  }
}

/** The comma-separated algorithm preference list `check-file` expects. */
function normalizeChecksumAlgorithms(algorithms) {
  if (!algorithms) return CHECKSUM_ALGS.map((a) => a[1]).join(',');
  const list = Array.isArray(algorithms) ? algorithms : String(algorithms).split(',');
  const out = [];
  for (const raw of list) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    const known = CHECKSUM_ALGS.find((a) => a[0] === name || a[1] === name);
    const wire = known ? known[1] : name;
    if (!out.includes(wire)) out.push(wire);
  }
  return out.join(',');
}

/** Map a UI algorithm name onto its wire name, WinSCP's `FChecksumSftpAlgs`. */
function checksumAlgToWire(name) {
  const n = String(name || '').trim().toLowerCase();
  const known = CHECKSUM_ALGS.find((a) => a[0] === n || a[1] === n);
  // An unknown name is passed through, exactly as WinSCP does, so a server with
  // a private algorithm is still reachable.
  return known ? known[1] : n;
}

/**
 * Turn an `ssh2` status error into WinSCP's message for that code, including
 * the error-code-4 explanation that saves the user a search.
 */
function decorateStatusError(err, what) {
  const code = Number.isFinite(err && err.code) ? err.code : null;
  const known = code !== null && code < SFTP_STATUS_MESSAGE.length ? SFTP_STATUS_MESSAGE[code] : 'Unknown status code.';
  const serverText = err && err.message ? String(err.message) : '';
  const lines = [known, `Error code: ${code === null ? '?' : code}`];
  lines.push(`Error message from server: ${serverText || 'None'}`);
  if (code === SSH_FX_FAILURE) lines.push('', SFTP_STATUS_4_HINT);
  const out = new Error(lines.join('\n'));
  out.code = code;
  out.extendedRequest = what;
  out.unsupported = code === SSH_FX_OP_UNSUPPORTED;
  out.serverMessage = serverText;
  return out;
}

/** Is this status code the one that means "I do not implement that"? */
function isOperationUnsupported(err) {
  return !!err && Number(err.code) === SSH_FX_OP_UNSUPPORTED;
}

// ------------------------------------------------ SecureShell: error handling

/**
 * `TSecureShell::TranslatePuttyMessage`. A `%` in the pattern is a single
 * wildcard: everything before it must match as a prefix, everything after it as
 * a suffix, and the middle is captured and right-trimmed. The length test is
 * `>= length - 1` because the wildcard may capture nothing at all.
 */
function translatePuttyMessage(table, message) {
  const text = String(message == null ? '' : message);
  for (let index = 0; index < table.length; index++) {
    const entry = table[index];
    const original = entry.original;
    const div = original.indexOf('%');
    if (div < 0) {
      if (text === original) {
        return { index, entry, message: entry.translation, captured: null };
      }
    } else {
      const prefix = original.slice(0, div);
      const suffix = original.slice(div + 1);
      if (text.length >= original.length - 1
        && text.startsWith(prefix)
        && (suffix.length === 0 || text.endsWith(suffix))) {
        const captured = text.slice(prefix.length, text.length - suffix.length).replace(/\s+$/, '');
        return {
          index,
          entry,
          message: entry.translation.replace('%s', captured),
          captured,
        };
      }
    }
  }
  return null;
}

/**
 * The network-error table, in WinSCP's order — the order matters, because the
 * first four are the ones that set `FNoConnectionResponse`, i.e. "the SSH port
 * never answered", which is what makes the "did you mean FTP?" suggestion safe
 * to offer.
 */
const NETWORK_ERRORS = [
  { key: 'unexpectedClose', original: 'Remote side unexpectedly closed network connection', translation: 'Server unexpectedly closed network connection.', help: 'unexpected_close' },
  { key: 'refused', original: 'Network error: Connection refused', translation: 'Network error: Connection to "%s" refused.', help: 'net_refused' },
  { key: 'reset', original: 'Network error: Connection reset by peer', translation: 'Network error: Connection reset by peer.', help: 'net_reset' },
  { key: 'timeout', original: 'Network error: Connection timed out', translation: 'Network error: Connection to "%s" timed out.', help: 'net_timeout' },
  { key: 'noRoute', original: 'Network error: No route to host', translation: 'Network error: No route to host "%s".', help: 'net_noroute' },
  { key: 'aborted', original: 'Network error: Software caused connection abort', translation: 'Network error: Software caused connection abort', help: 'net_aborted' },
  { key: 'hostNotExist', original: 'Host does not exist', translation: 'Host "%s" does not exist.', help: 'net_hostnotexist' },
  { key: 'garbled', original: 'Incoming packet was garbled on decryption', translation: 'Incoming packet was garbled on decryption', help: 'net_garbled' },
];

/** `TSecureShell::TranslateAuthenticationMessage`. */
const AUTHENTICATION_MESSAGES = [
  { key: 'username', original: 'Using username "%".', translation: 'Using username "%s".' },
  { key: 'keyboardInteractive', original: 'Using keyboard-interactive authentication.', translation: 'Using keyboard-interactive authentication.' },
  { key: 'publicKeyAgent', original: 'Authenticating with public key "%" from agent', translation: 'Authenticating with public key "%s" from agent.' },
  { key: 'publicKey', original: 'Authenticating with public key "%"', translation: 'Authenticating with public key "%s".' },
  { key: 'publicKeyAgentRsa', original: 'Authenticated using RSA key "%" from agent', translation: 'Authenticating with public key "%s" from agent.' },
  { key: 'wrongPassphrase', original: 'Wrong passphrase', translation: 'Wrong passphrase.' },
  { key: 'wrongPassphraseDot', original: 'Wrong passphrase.', translation: 'Wrong passphrase.' },
  { key: 'accessDenied', original: 'Access denied', translation: 'Access denied.' },
  { key: 'tryPublicKey', original: 'Trying public key authentication.', translation: 'Trying public key authentication.' },
  { key: 'keyRefused', original: 'Server refused our public key.', translation: 'Server refused our key.', help: 'auth_key_refused' },
  { key: 'keyRefusedShort', original: 'Server refused our key', translation: 'Server refused our key.', help: 'auth_key_refused' },
];

/**
 * Messages that mean the *authentication* failed rather than the connection.
 * Retrying the same credentials against these produces the same answer, so the
 * classification below stops the reconnect loop instead of hammering a server
 * that has already said no — which is how accounts get locked out.
 */
const AUTH_HOPELESS_PATTERNS = [
  /^All configured authentication methods failed$/i,
  /No supported authentication methods available/i,
  /^Access denied\.?$/i,
  /^Authentication failed\.?$/i,
  /Too many authentication failures/i,
  /Permission denied \(publickey/i,
  /^Server refused our key\.?$/i,
  /^Server refused our public key\.?$/i,
  /^Wrong passphrase\.?$/i,
  /Cannot parse privateKey/i,
  /Encrypted [Oo]pen ?SSH private key detected, but no passphrase given/i,
];

/**
 * Messages that mean this host key will never be accepted by us. A reconnect
 * offers the same key and gets the same refusal, so these are not retriable —
 * looping on them would hide a possible man-in-the-middle behind a reconnect
 * animation.
 */
const HOST_KEY_PATTERNS = [
  /host key/i,
  /Host denied \(verification failed\)/i,
  /signature verification failed/i,
  /Handshake failed: no matching (?:host key format|key exchange algorithm)/i,
];

/**
 * Classify a failure from the SSH layer the way `TSecureShell` does.
 *
 * The three answers callers act on:
 *   - `fatal`     — the session is gone; nothing can continue on it.
 *   - `retriable` — a *reconnect* could plausibly succeed, so the reconnect
 *                   loop may run.
 *   - `authenticationHopeless` — the credentials were rejected; asking again
 *                   with the same ones is pointless and, on a server that
 *                   counts failures, harmful. WinSCP stops here rather than
 *                   re-prompting in a loop.
 *
 * @param error   an Error or a message string
 * @param ctx     `{ hostName, storedCredentialsTried, cancelled, closing, exitCode }`
 */
function classifySshError(error, ctx = {}) {
  const err = error instanceof Error ? error : new Error(String(error == null ? '' : error));
  const raw = String(err.message || '');
  const host = ctx.hostName || '';

  const result = {
    kind: 'unknown',
    key: null,
    message: raw,
    original: raw,
    help: null,
    fatal: true,
    retriable: false,
    authenticationHopeless: false,
    suggestFtp: false,
    ignored: false,
    level: err.level || null,
  };

  // WinSCP's PuttyFatalError: an error that arrives while we are tearing the
  // session down is logged and dropped. Reporting it would show the user a
  // failure for something they had already finished with.
  if (ctx.closing) {
    result.ignored = true;
    result.fatal = false;
    result.message = `Ignoring an error from the server while closing: ${raw}`;
    return result;
  }

  if (err.code === 'ERR_SSH_ALGORITHM_POLICY') {
    return Object.assign(result, {
      kind: 'policy',
      key: 'sshAlgorithmPolicy',
      help: 'ssh_policy',
      retriable: false,
    });
  }

  const net = translatePuttyMessage(NETWORK_ERRORS, raw);
  if (net) {
    result.kind = 'network';
    result.key = net.entry.key;
    result.help = net.entry.help || null;
    result.message = net.message.replace('%HOST%', host).replace('"%s"', host ? `"${host}"` : '"%s"');
    // The first four entries are the ones that mean the SSH port never
    // answered; only those justify probing for an FTP server behind it.
    result.suggestFtp = net.index <= 3;
    result.retriable = net.entry.key !== 'garbled';
    if (net.entry.key === 'garbled') result.kind = 'protocol';
    return result;
  }

  // ssh2 reports its own network failures through Node's error codes rather
  // than PuTTY's wording, so the same classification is reached from there too.
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'refused', retriable: true, suggestFtp: true,
      message: `Network error: Connection to "${host || 'the server'}" refused.`, help: 'net_refused',
    });
  }
  if (err.code === 'ETIMEDOUT' || /ETIMEDOUT|Timed out while waiting for handshake|Timed out connecting/.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'timeout', retriable: true, suggestFtp: true,
      message: `Network error: Connection to "${host || 'the server'}" timed out.`, help: 'net_timeout',
    });
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || /getaddrinfo/.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'hostNotExist', retriable: false, suggestFtp: false,
      message: `Host "${host || 'the server'}" does not exist.`, help: 'net_hostnotexist',
    });
  }
  if (err.code === 'ECONNRESET' || /ECONNRESET/.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'reset', retriable: true, suggestFtp: false,
      message: 'Network error: Connection reset by peer.', help: 'net_reset',
    });
  }
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
    return Object.assign(result, {
      kind: 'network', key: 'noRoute', retriable: true, suggestFtp: false,
      message: `Network error: No route to host "${host || 'the server'}".`, help: 'net_noroute',
    });
  }

  for (const pattern of AUTH_HOPELESS_PATTERNS) {
    if (pattern.test(raw)) {
      const auth = translatePuttyMessage(AUTHENTICATION_MESSAGES, raw);
      return Object.assign(result, {
        kind: 'authentication',
        key: auth ? auth.entry.key : 'authenticationFailed',
        help: auth && auth.entry.help ? auth.entry.help : 'auth_failed',
        message: auth ? auth.message : 'Authentication failed.',
        retriable: false,
        authenticationHopeless: true,
      });
    }
  }

  for (const pattern of HOST_KEY_PATTERNS) {
    if (pattern.test(raw)) {
      return Object.assign(result, {
        kind: 'host-key', key: 'hostKey', retriable: false, help: 'hostkey',
      });
    }
  }

  if (/proxy/i.test(raw)) {
    return Object.assign(result, { kind: 'proxy', key: 'proxy', retriable: true });
  }

  if (err.level === 'client-socket' || /socket hang up|EPIPE|read ECONN/.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'unexpectedClose', retriable: true,
      message: 'Server unexpectedly closed network connection.', help: 'unexpected_close',
    });
  }

  if (/No response from server/i.test(raw)) {
    return Object.assign(result, {
      kind: 'network', key: 'lostConnection', retriable: true, message: 'Lost connection.',
    });
  }

  return result;
}

/**
 * `TSecureShell::CheckConnection`'s message for a session that ended before it
 * was authenticated. Which of the two messages appears matters: "Credentials
 * were not specified" tells the user to fill something in, while
 * "Authentication failed" tells them what they filled in was wrong.
 */
function connectionClosedMessage(ctx = {}) {
  const exitCode = Number.isFinite(ctx.exitCode) ? ctx.exitCode : -1;
  let message;
  let hopeless = false;
  if (exitCode === 0 && ctx.cancelled) {
    if (ctx.storedCredentialsTried) { message = 'Authentication failed.'; hopeless = true; }
    else message = 'Credentials were not specified.';
    // The zero is PuTTY's own "we stopped", not something the server said.
    return { message, exitCode: -1, help: null, authenticationHopeless: hopeless };
  }
  message = 'Connection has been unexpectedly closed.';
  const out = { message, exitCode, help: 'not_connected', authenticationHopeless: false };
  if (exitCode >= 0) out.message += ` Server sent command exit status ${exitCode}.`;
  return out;
}

/**
 * `TSecureShell::TryFtp`'s refusals. WinSCP will only knock on port 21 for a
 * plain SFTP session on the standard port with no tunnel and no proxy —
 * anything else and the probe would be aimed at the wrong machine entirely.
 */
function shouldSuggestFtp(session = {}, classification = {}, options = {}) {
  if (options.tryFtpWhenSshFails === false) {
    return { suggest: false, reason: 'the "try FTP when SSH fails" option is off' };
  }
  if (!classification.suggestFtp) {
    return { suggest: false, reason: 'the failure was not a missing response from the SSH port' };
  }
  const protocol = String(session.fsProtocol || session.protocol || 'sftp').toLowerCase();
  if (protocol !== 'sftp') {
    return { suggest: false, reason: 'using a non-standard protocol, will not knock FTP port' };
  }
  if (Number(session.portNumber || 22) !== 22) {
    return { suggest: false, reason: 'using a non-standard port, will not knock FTP port' };
  }
  if (session.tunnel) return { suggest: false, reason: 'using a tunnel, will not knock FTP port' };
  const proxy = session.proxyMethod || 'none';
  if (proxy !== 'none') return { suggest: false, reason: 'using a proxy, will not knock FTP port' };
  return {
    suggest: true,
    reason: 'the SSH port did not respond',
    message: 'The server rejected SFTP connection, but it listens for FTP connections.\n\n'
      + 'Did you want to use FTP protocol instead of SFTP? Prefer using encryption.',
  };
}

// -------------------------------------------------------- SecureShell: banner

/**
 * `TConfiguration::BannerHash` — MD5 over the banner's UTF-16LE bytes. The
 * encoding is not incidental: it is what makes a hash stored by WinSCP and a
 * hash stored here describe the same banner.
 */
function bannerHash(banner) {
  return crypto.createHash('md5')
    .update(Buffer.from(String(banner == null ? '' : banner), 'utf16le'))
    .digest('hex')
    .toUpperCase();
}

/**
 * Banner display, ported from `TSecureShell::DisplayBanner` and
 * `TTerminal::DisplayBanner`.
 *
 * Two refusals worth keeping: a whitespace-only banner is never shown (PuTTY
 * calls back with a bare CRLF when the real banner had none), and a banner the
 * user has already dismissed with "never show again" stays dismissed until its
 * text changes — which is why the *hash* is stored rather than a boolean.
 *
 * @param store `{ get(sessionKey), set(sessionKey, {hash, params}) }`
 */
class BannerPolicy {
  constructor(store, options = {}) {
    this.store = store || memoryBannerStore();
    this.force = !!options.forceBanners;
  }

  /** Whether this banner should be put in front of the user at all. */
  shouldShow(sessionKey, banner) {
    if (!String(banner == null ? '' : banner).trim()) return false;
    if (this.force) return true;
    const stored = this.store.get(sessionKey) || {};
    return stored.hash !== bannerHash(banner);
  }

  /** Record the user's "never show this again" for this exact banner text. */
  neverShow(sessionKey, banner) {
    const stored = this.store.get(sessionKey) || {};
    this.store.set(sessionKey, { hash: bannerHash(banner), params: stored.params || 0 });
  }

  params(sessionKey) {
    const stored = this.store.get(sessionKey) || {};
    return stored.params || 0;
  }

  setParams(sessionKey, params) {
    const stored = this.store.get(sessionKey) || {};
    this.store.set(sessionKey, { hash: stored.hash || '', params: Number(params) || 0 });
  }
}

function memoryBannerStore() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
  };
}

// ------------------------------------------------ SecureShell: host key order

/**
 * The host-key families WinSCP offers, in its default order, mapped to the
 * algorithm names that go on the wire.
 */
const HOST_KEY_FAMILIES = {
  ed448: ['ssh-ed448'],
  ed25519: ['ssh-ed25519'],
  ecdsa: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
  rsa: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  dsa: ['ssh-dss'],
};

/** The certificate variants PuTTY offers ahead of the bare algorithms. */
const HOST_KEY_CERTIFICATES = {
  ed25519: ['ssh-ed25519-cert-v01@openssh.com'],
  ecdsa: ['ecdsa-sha2-nistp256-cert-v01@openssh.com', 'ecdsa-sha2-nistp384-cert-v01@openssh.com', 'ecdsa-sha2-nistp521-cert-v01@openssh.com'],
  rsa: ['rsa-sha2-512-cert-v01@openssh.com', 'rsa-sha2-256-cert-v01@openssh.com', 'ssh-rsa-cert-v01@openssh.com'],
  dsa: ['ssh-dss-cert-v01@openssh.com'],
};

/**
 * Resolve the host-key algorithm list for the first key exchange, exactly as
 * PuTTY's `ssh2_scan_kexinits` builds it: certificates first when a CA is
 * configured, then the algorithms we already hold a cached key for, then
 * everything else — each pass walking the user's own preference order.
 *
 * Preferring an algorithm we already have a key for is what stops a server
 * that offers several key types from asking the user to verify a *second*
 * fingerprint for a host they have already trusted.
 *
 * @param prefs   family names in preference order, `'WARN'` marking the point
 *                below which PuTTY would stop and warn
 * @param opts    `{ hasCachedKey(alg), preferKnown, acceptCertificates,
 *                   supported: [names] }`
 */
function resolveHostKeyOrder(prefs, opts = {}) {
  const families = Array.isArray(prefs) && prefs.length
    ? prefs
    : ['ed448', 'ed25519', 'ecdsa', 'rsa', 'WARN', 'dsa'];
  const hasCachedKey = typeof opts.hasCachedKey === 'function' ? opts.hasCachedKey : () => false;
  const preferKnown = opts.preferKnown !== false;
  const acceptCerts = !!opts.acceptCertificates;
  const supported = Array.isArray(opts.supported) ? opts.supported : null;
  const usable = (name) => !supported || supported.includes(name);

  const order = [];
  const seen = new Set();
  const add = (name, warn) => {
    if (seen.has(name) || !usable(name)) return;
    seen.add(name);
    order.push({ name, warn });
  };

  if (acceptCerts) {
    let warn = false;
    for (const family of families) {
      if (family === 'WARN') { warn = true; continue; }
      for (const name of HOST_KEY_CERTIFICATES[family] || []) add(name, warn);
    }
  }

  if (preferKnown) {
    let warn = false;
    for (const family of families) {
      if (family === 'WARN') { warn = true; continue; }
      for (const name of HOST_KEY_FAMILIES[family] || []) {
        if (hasCachedKey(name)) add(name, warn);
      }
    }
  }

  {
    let warn = false;
    for (const family of families) {
      if (family === 'WARN') { warn = true; continue; }
      for (const name of HOST_KEY_FAMILIES[family] || []) add(name, warn);
    }
  }

  const dropped = [];
  if (supported) {
    for (const family of families) {
      if (family === 'WARN') continue;
      for (const name of HOST_KEY_FAMILIES[family] || []) {
        if (!supported.includes(name) && !dropped.includes(family)) dropped.push(family);
      }
    }
  }

  return {
    order,
    list: order.map((e) => e.name),
    // Below the WARN marker PuTTY stops and asks. With no channel to ask on,
    // these are reported so the caller can drop them rather than negotiate
    // something the user was meant to be warned about.
    belowWarnThreshold: order.filter((e) => e.warn).map((e) => e.name),
    dropped,
  };
}

/**
 * `KeyTypeFromFingerprint`: the algorithm named at the front of a stored
 * fingerprint, in either of the two spellings WinSCP writes —
 * `"ssh-ed25519 255 SHA256:…"` and `"ssh-ed25519-SHA256:…"`. A configured
 * fingerprint is evidence that we already trust a key *of that type*, which is
 * what `resolveHostKeyOrder` needs to avoid a second verification prompt.
 */
function keyTypeFromFingerprint(fingerprint) {
  const text = String(fingerprint || '').trim();
  if (!text) return null;
  const all = [];
  for (const family of Object.keys(HOST_KEY_FAMILIES)) all.push(...HOST_KEY_FAMILIES[family]);
  for (const family of Object.keys(HOST_KEY_CERTIFICATES)) all.push(...HOST_KEY_CERTIFICATES[family]);
  // Longest first, so "rsa-sha2-512" is not shadowed by a shorter prefix.
  all.sort((a, b) => b.length - a.length);
  for (const name of all) {
    if (text.startsWith(name + ' ')) {
      const rest = text.slice(name.length + 1);
      const space = rest.indexOf(' ');
      // The middle field is the key size. Anything else means this is not a
      // fingerprint at all — most often an OpenSSH public key pasted whole.
      if (space > 0 && /^\d+$/.test(rest.slice(0, space))) return name;
      return null;
    }
    if (text.startsWith(name + '-')) return name;
  }
  return null;
}

/**
 * A later key exchange must reuse the algorithm the first one settled on:
 * offering the list again would let the server switch key type mid-session and
 * force a fresh fingerprint prompt in the middle of the user's work.
 */
function hostKeyOrderForRekey(chosenAlgorithm) {
  return { order: [{ name: chosenAlgorithm, warn: false }], list: [chosenAlgorithm], belowWarnThreshold: [], dropped: [] };
}

/**
 * PuTTY's cross-certification hint: algorithms the user prefers *more* than the
 * one that was actually negotiated, but for which no key is cached. WinSCP
 * surfaces these so the user can add them while the session is up, instead of
 * being surprised the next time the server picks a different key.
 */
function betterHostKeyAlgorithms(order, chosen, hasCachedKey) {
  const out = [];
  for (const entry of order) {
    if (entry.name === chosen) break;
    if (!hasCachedKey(entry.name)) out.push(entry.name);
  }
  return out;
}

module.exports = {
  // constants
  SFTP_PACKET,
  SFTP_STATUS_MESSAGE,
  SFTP_STATUS_4_HINT,
  SFTP_MAX_PACKET_LEN,
  SFTP_MIN_VERSION,
  SFTP_STANDARD_VERSION,
  SFTP_MAX_VERSION,
  SSH_FX_OK,
  SSH_FX_FAILURE,
  SSH_FX_OP_UNSUPPORTED,
  EXT,
  ATTR,
  CHECKSUM_ALGS,
  SFTP_BUGS,
  HOST_KEY_FAMILIES,
  HOST_KEY_CERTIFICATES,
  NETWORK_ERRORS,
  AUTHENTICATION_MESSAGES,
  REALPATH_NO_CHECK,
  REALPATH_STAT_IF,
  REALPATH_STAT_ALWAYS,
  OGQ_LIST_OWNERS,
  OGQ_LIST_GROUPS,

  // wire codec
  PacketWriter,
  PacketReader,
  displayableStr,

  // server identification
  isOpenSSH,
  detectSshImplementation,
  detectServerVendor,
  canChangePassword,
  proftpdMajorVersion,

  // negotiation
  parseServerExtensions,
  parseSupport,
  parseVendorId,
  parseFsRoots,
  parseVersions,
  parseVersionPacket,
  supportsExtension,
  resolveCapabilities,
  resolveSftpBugs,
  normalizeAutoSwitch,
  resolveMaxSftpVersion,
  checkNegotiatedVersion,
  resolveMaxPacketSize,
  resolveUtfMode,
  detectUtf8,
  realPathControlByte,

  // extended requests
  SftpExtensions,
  FrameTap,
  installTapSupport,
  rawVersionExtensions,
  sendPacket,
  normalizeChecksumAlgorithms,
  checksumAlgToWire,
  hashLength,
  writeAttributes,
  readCheckFileReply,
  readMd5HashReply,
  decorateStatusError,
  isOperationUnsupported,

  // SecureShell
  translatePuttyMessage,
  classifySshError,
  connectionClosedMessage,
  shouldSuggestFtp,
  bannerHash,
  BannerPolicy,
  resolveHostKeyOrder,
  keyTypeFromFingerprint,
  hostKeyOrderForRekey,
  betterHostKeyAlgorithms,
};
