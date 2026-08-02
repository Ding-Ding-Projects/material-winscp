// A REAL FTP server, in this process, for the end-to-end protocol tests.
//
// `ftp-srv` is a complete FTP implementation (control connection, PASV/EPSV,
// PORT/EPRT, REST, APPE, AUTH TLS) but it stops short of RFC 3659 — no MLSD,
// no MLST, no MFMT — it advertises no checksum command, and it does not
// advertise `REST STREAM` in FEAT. Those are exactly the paths WinSCP prefers
// against a modern server, so this helper registers genuine implementations of
// them into ftp-srv's own command registry, plus fixes for two ftp-srv bugs
// (see `SIZE` and the blacklist note below) that would otherwise make the
// server behave differently on Windows than on Linux.
//
// Everything is written against the RFC or the draft, not against our parser:
// MLSD emits `cdir`/`pdir` entries and a `perm` fact the way ProFTPD does,
// MFMT answers `213 Modify=...` the way vsftpd does, and HASH answers
// `213 <alg> <start>-<end> <digest> <path>` the way Cerberus does. Nothing here
// special-cases the client, and every digest is computed from the real bytes.
//
// Everything binds to port 0. A fixed port makes the suite fail on a busy
// machine and flake in CI, and the passive port is drawn the same way rather
// than walking ftp-srv's default 1024..65535 range.
'use strict';

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const FtpSrv = require('ftp-srv');
const FtpFileSystem = require('ftp-srv').FileSystem;

// Deep imports: ftp-srv exposes no public hook for adding a command, and the
// alternative — forking it — would mean the tests no longer run against the
// real server. Pinned to the devDependency, and asserted rather than assumed.
const registry = require('ftp-srv/src/commands/registry');
const siteRegistry = require('ftp-srv/src/commands/registration/site/registry');

if (!registry || !registry.LIST || !registry.FEAT || !siteRegistry) {
  throw new Error('ftp-srv internals moved; test/helpers/ftp-server.js needs updating');
}

// Every FtpServer instance registers three process signal handlers of its own.
// A suite that stands up a dozen servers would otherwise trip the warning.
process.setMaxListeners(100);

// ---------------------------------------------------------------------------
// RFC 3659 additions
// ---------------------------------------------------------------------------

/** `YYYYMMDDHHMMSS` in UTC — the MLSx / MFMT time-val. */
function timeVal(when) {
  const d = new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Parse a time-val back into epoch ms. */
function parseTimeVal(text) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * One MLSx fact line. `type` is overridden for the `cdir` / `pdir` entries a
 * conforming server puts at the head of an MLSD listing.
 */
function mlsxLine(stat, name, typeOverride) {
  const type = typeOverride || (stat.isDirectory() ? 'dir' : 'file');
  const writable = (stat.mode & 0o200) !== 0;
  const facts = [`type=${type}`];
  if (type === 'file') facts.push(`size=${stat.size}`);
  facts.push(`modify=${timeVal(stat.mtime)}`);
  facts.push(`UNIX.mode=0${(stat.mode & 0o777).toString(8).padStart(3, '0')}`);
  facts.push('UNIX.ownername=ftpuser');
  facts.push('UNIX.groupname=ftpgroup');
  // RFC 3659 §7.5.1: the letters a client may act on. A file the server will
  // not let you write reports read letters only, which is how the panel learns
  // to render the read-only column without a second round trip.
  if (type === 'file') facts.push(`perm=${writable ? 'adfrw' : 'r'}`);
  else facts.push(`perm=${writable ? 'flcdmpe' : 'el'}`);
  return `${facts.join(';')}; ${name}`;
}

/**
 * The pathname a conforming server puts on its `cdir` / `pdir` entries.
 *
 * RFC 3659 §7.2 asks for "a valid pathname", and ProFTPD, vsftpd and IIS all
 * answer with the directory's own path — NOT with `.` and `..`. That
 * distinction matters to a client: a parser that only drops entries literally
 * named `.` or `..` keeps the real ones and lists every directory twice.
 */
function cdirNames(cwd, arg) {
  const dir = (arg && arg !== '.' ? arg : cwd) || '/';
  const cdir = dir.replace(/\\/g, '/');
  const parent = cdir === '/' ? '/' : (cdir.replace(/\/[^/]+\/?$/, '') || '/');
  return { cdir, pdir: parent };
}

const MLSD = {
  directive: 'MLSD',
  syntax: '{{cmd}} [<path>]',
  description: 'Lists the contents of a directory in a machine-readable format',
  flags: { feat: 'MLSD' },
  handler: async function mlsdHandler({ log, command } = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    const target = command.arg || '.';
    try {
      await this.connector.waitForConnection();
      this.commandSocket.pause();
      const stat = await this.fs.get(target);
      if (!stat.isDirectory()) return this.reply(501, 'Not a directory');
      const files = await this.fs.list(target);

      const socket = this.connector.socket;
      const { cdir, pdir } = cdirNames(this.fs.currentDirectory(), command.arg);
      const letters = [
        { raw: true, socket, message: mlsxLine(stat, cdir, 'cdir') },
        { raw: true, socket, message: mlsxLine(stat, pdir, 'pdir') },
      ];
      for (const f of files) letters.push({ raw: true, socket, message: mlsxLine(f, f.name) });

      await this.reply(150);
      await this.reply({}, ...letters);
      return await this.reply(226);
    } catch (err) {
      if (log) log.error(err);
      return this.reply(451, err.message || 'No directory');
    } finally {
      this.connector.end();
      this.commandSocket.resume();
    }
  },
};

const MLST = {
  directive: 'MLST',
  syntax: '{{cmd}} [<path>]',
  description: 'Provides data about exactly the object named on its command line',
  // The fact list a client may ask for with OPTS MLST, advertised the way
  // RFC 3659 §7.8 shows it (a '*' marks a fact that is on by default).
  flags: { feat: 'MLST type*;size*;modify*;perm*;UNIX.mode*;UNIX.ownername*;UNIX.groupname*;' },
  handler: async function mlstHandler({ log, command } = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    const target = command.arg || '.';
    try {
      const stat = await this.fs.get(target);
      return await this.reply(250, `Listing ${target}`,
        { raw: true, message: ` ${mlsxLine(stat, target)}` }, 'End');
    } catch (err) {
      if (log) log.error(err);
      return this.reply(550, err.message || 'No such file');
    }
  },
};

const MFMT = {
  directive: 'MFMT',
  syntax: '{{cmd}} <time-val> <path>',
  description: 'Modify the last modification time of a file',
  flags: { feat: 'MFMT' },
  handler: async function mfmtHandler({ log, command } = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    const arg = command.arg || '';
    const sp = arg.indexOf(' ');
    if (sp < 0) return this.reply(501, 'Syntax: MFMT <time-val> <path>');
    const stamp = arg.slice(0, sp);
    const target = arg.slice(sp + 1);
    const when = parseTimeVal(stamp);
    if (when === null) return this.reply(501, 'Bad time-val');
    if (typeof this.fs.setTimes !== 'function') return this.reply(502, 'Not supported by file system');
    try {
      await this.fs.setTimes(target, when);
      // RFC 3659 §7.7: the reply echoes the time actually set.
      return await this.reply(213, `Modify=${timeVal(when)}; ${target}`);
    } catch (err) {
      if (log) log.error(err);
      return this.reply(550, err.message || 'Could not set the modification time');
    }
  },
};

/**
 * SIZE, with ftp-srv's zero-size bug taken out.
 *
 * ftp-srv replies `this.reply(213, {message: stat.size})`, and its reply
 * builder swaps in a default string whenever the message is falsy — so a
 * zero-byte object answers `213 File status okay` instead of `213 0`. That
 * makes the server behave differently on Windows (where a directory's size is
 * 0) than on Linux (where it is 4096), which is exactly the sort of accident
 * that hides a client bug on one platform and finds it on the other.
 */
const SIZE = {
  directive: 'SIZE',
  syntax: '{{cmd}} <path>',
  description: 'Return the size of a file',
  flags: { feat: 'SIZE' },
  handler: async function sizeHandler({ log, command } = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    try {
      const stat = await this.fs.get(command.arg);
      return await this.reply(213, String(stat.size));
    } catch (err) {
      if (log) log.error(err);
      return this.reply(550, err.message || 'No such file');
    }
  },
};

// ---------------------------------------------------------------------------
// checksums — the two conventions that exist in the field
// ---------------------------------------------------------------------------

const HASH_ALGS = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-512': 'sha512',
  MD5: 'md5',
};

/** CRC-32, the one digest node:crypto does not ship. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let b = 0; b < 8; b++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c >>> 0).toString(16).padStart(8, '0');
}

async function digestOf(fsPath, alg) {
  const buf = await fsp.readFile(fsPath);
  if (alg === 'crc32') return { hex: crc32(buf), size: buf.length };
  return { hex: crypto.createHash(alg).update(buf).digest('hex'), size: buf.length };
}

/**
 * The pathname argument of a checksum verb, read the way the drafts define it.
 *
 * `draft-twine-ftpmd5` (XMD5/XSHA1/…) and `draft-bryan-ftpext-hash` (HASH) both
 * allow a byte range after the pathname — `XSHA256 /f 0 1024` — so the
 * pathname cannot simply be "everything after the directive". Serv-U and
 * GlobalSCAPE therefore terminate an unquoted name at the first space and
 * require a name containing one to be quoted, which is exactly why the client
 * has to quote it. Taking the argument from `command.raw` rather than
 * `command.arg` is deliberate: ftp-srv's parser strips every `"` from the line
 * and rejoins the remaining tokens with spaces, which would make quoting
 * invisible and the client's handling of it untestable.
 */
function checksumPathArg(raw, directive) {
  let rest = String(raw || '').replace(/[\r\n]+$/, '');
  const head = new RegExp(`^\\s*${directive}\\s+`, 'i');
  if (!head.test(rest)) return null;
  rest = rest.replace(head, '');
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end < 0) return null;          // an unterminated quote is a syntax error
    return rest.slice(1, end);
  }
  // Unquoted: the name ends at the first space, and whatever follows is the
  // optional range. A name with a space in it is therefore truncated — the
  // failure the quoting exists to prevent.
  const sp = rest.indexOf(' ');
  return sp < 0 ? rest : rest.slice(0, sp);
}

/**
 * The generic HASH command (draft-bryan-ftpext-hash), as Cerberus and
 * FileZilla Server implement it: `OPTS HASH <alg>` selects, `HASH <path>`
 * answers `213 <alg> <start>-<end> <digest> <path>`. Quoted path names are
 * accepted, because servers that take a trailing range have to allow them.
 */
const HASH = {
  directive: 'HASH',
  syntax: '{{cmd}} <path>',
  description: 'Compute a cryptographic hash of a file',
  flags: { feat: 'HASH SHA-1*;SHA-256;SHA-512;MD5' },
  handler: async function hashHandler({ log, command } = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    const name = HASH_ALGS[this.hashAlgorithm || 'SHA-1'] ? (this.hashAlgorithm || 'SHA-1') : 'SHA-1';
    const arg = checksumPathArg(command.raw, 'HASH');
    if (arg === null) return this.reply(501, 'Syntax: HASH <pathname>');
    try {
      const { fsPath } = this.fs._resolvePath(arg);
      const { hex, size } = await digestOf(fsPath, HASH_ALGS[name]);
      return await this.reply(213, `${name} 0-${size} ${hex} ${arg}`);
    } catch (err) {
      if (log) log.error(err);
      return this.reply(550, err.message || 'No such file');
    }
  },
};

/** The older algorithm-specific verbs: `XSHA1 <path>` -> `213 <digest>`. */
function xCommand(directive, alg) {
  return {
    directive,
    syntax: `{{cmd}} <path>`,
    description: `Compute the ${alg} digest of a file`,
    flags: { feat: directive },
    handler: async function xHandler({ log, command } = {}) {
      if (!this.fs) return this.reply(550, 'File system not instantiated');
      const arg = checksumPathArg(command.raw, directive);
      if (arg === null) return this.reply(501, `Syntax: ${directive} <pathname>`);
      try {
        const { fsPath } = this.fs._resolvePath(arg);
        const { hex } = await digestOf(fsPath, alg);
        return await this.reply(213, hex);
      } catch (err) {
        if (log) log.error(err);
        return this.reply(550, err.message || 'No such file');
      }
    },
  };
}

/** `OPTS HASH SHA-256` selects the algorithm for the next HASH command. */
function installHashOption() {
  const opts = registry.OPTS;
  registry.OPTS = {
    ...opts,
    handler: function optsHandler(args) {
      const arg = (args && args.command && args.command.arg) || '';
      const [option, value] = arg.split(' ');
      if (String(option).toUpperCase() !== 'HASH') return opts.handler.call(this, args);
      const wanted = String(value || '').toUpperCase();
      if (!HASH_ALGS[wanted]) return this.reply(501, 'Unknown hash algorithm');
      this.hashAlgorithm = wanted;
      return this.reply(200, wanted);
    },
  };
}

/**
 * FEAT, filtered by the connection's blacklist.
 *
 * ftp-srv's own FEAT walks the whole registry, so a blacklisted command is
 * still advertised and the client is told the server can do something it will
 * refuse. That matters here because the blacklist is how a test asks for a
 * server that genuinely predates RFC 3659.
 */
const FEAT = {
  directive: 'FEAT',
  syntax: '{{cmd}}',
  description: 'Get the feature list implemented by the server',
  flags: { no_auth: true },
  handler: function featHandler() {
    const blocked = new Set((this.commands.blacklist || []).map((c) => String(c).toUpperCase()));
    // Per-connection FEAT text, so a test can ask for a server whose HASH
    // offers an algorithm we do not implement without redefining the command
    // for every other server in the process.
    const overrides = this.featOverrides || {};
    const feats = ['UTF8'];
    for (const directive of Object.keys(registry)) {
      if (blocked.has(directive.toUpperCase())) continue;
      if (Object.prototype.hasOwnProperty.call(overrides, directive.toUpperCase())) {
        const replacement = overrides[directive.toUpperCase()];
        if (replacement) feats.push(replacement);
        continue;
      }
      const feat = registry[directive] && registry[directive].flags && registry[directive].flags.feat;
      if (feat) feats.push(feat);
    }
    const letters = [...new Set(feats)].sort().map((f) => ({ message: ` ${f}`, raw: true }));
    return this.reply(211, 'Extensions supported', ...letters, 'End');
  },
};

/**
 * LIST for a server that never learned `ls` flags.
 *
 * RFC 959 gives LIST a pathname, not options; `LIST -a` is a convention, and a
 * server that does not implement it reads `-a` as the name of a file. IIS and
 * several embedded daemons then answer `150` / `226` with an EMPTY listing —
 * not an error — so a client that locks onto the first command that did not
 * fail reports every directory as empty. `connection.listNoFlags` turns this
 * behaviour on for one server so that fallback can be exercised.
 */
function installListFlagBehaviour() {
  const base = registry.LIST;
  registry.LIST = {
    ...base,
    handler: function listHandler(args) {
      if (!this.listNoFlags) return base.handler.call(this, args);
      const command = args && args.command;
      const flags = (command && command.flags) || [];
      if (!flags.length) return base.handler.call(this, args);
      // The flags were never flags: they are part of a pathname this server
      // does not have, and the reply is an empty listing rather than an error.
      const merged = { ...command, arg: [...flags, command.arg].filter(Boolean).join(' '), flags: [] };
      const self = this;
      return (async () => {
        await self.connector.waitForConnection();
        self.commandSocket.pause();
        try {
          await self.reply(150);
          await self.reply({ socket: self.connector.socket, useEmptyMessage: true });
          await self.reply(226);
        } finally {
          self.connector.end();
          self.commandSocket.resume();
        }
      })().then(() => merged);
    },
  };
}

function installExtensions() {
  registry.MLSD = MLSD;
  registry.MLST = MLST;
  registry.MFMT = MFMT;
  registry.FEAT = FEAT;
  registry.SIZE = SIZE;
  registry.HASH = HASH;
  registry.XSHA1 = xCommand('XSHA1', 'sha1');
  registry.XSHA256 = xCommand('XSHA256', 'sha256');
  registry.XMD5 = xCommand('XMD5', 'md5');
  registry.XCRC = xCommand('XCRC', 'crc32');
  installHashOption();
  installListFlagBehaviour();
  // REST is implemented by ftp-srv but never advertised. A client that honours
  // FEAT (ours does) therefore concludes the server cannot resume.
  if (!(registry.REST.flags && registry.REST.flags.feat)) {
    registry.REST = { ...registry.REST, flags: { ...(registry.REST.flags || {}), feat: 'REST STREAM' } };
  }
  // Almost no server reports SITE CHMOD through FEAT; SITE HELP is how it is
  // discovered in the field, and it is what our adapter asks.
  if (!siteRegistry.HELP) {
    siteRegistry.HELP = {
      handler: function siteHelpHandler() {
        return this.reply(214, 'The following SITE commands are recognized',
          { raw: true, message: ' CHMOD' }, 'End');
      },
    };
  }
}

installExtensions();

// ---------------------------------------------------------------------------
// file system
// ---------------------------------------------------------------------------

/** ftp-srv's FileSystem plus the one call MFMT needs. */
class TestFileSystem extends FtpFileSystem {
  /**
   * ftp-srv builds its initial working directory with node's `path.normalize`,
   * which on Windows hands the client `\`. FTP paths are POSIX on the wire, so
   * a server answering `257 "\"` is one no client can navigate. Real FTP
   * daemons never do this; neither does the one these tests run against.
   */
  currentDirectory() {
    return super.currentDirectory().replace(/\\/g, '/');
  }

  /**
   * MKD creates exactly one directory, which is what RFC 959 says and what
   * every real FTP daemon does.
   *
   * ftp-srv calls `fs.mkdir(fsPath, { recursive: true })`, so one `MKD a/b/c`
   * quietly builds the whole chain. A client whose "create directories
   * recursively" walks the path one level at a time would then look identical
   * to one that does not bother — and the one that does not bother is broken
   * against every server in the field.
   */
  async mkdir(p) {
    const { fsPath } = this._resolvePath(p);
    await fsp.mkdir(fsPath);   // no `recursive`: a missing parent is an error
    return fsPath;
  }

  /**
   * `REST <n>` followed by `STOR` overwrites from byte n of the existing file.
   *
   * ftp-srv opens the target with `flags: 'w+'` and then seeks to `start`,
   * which truncates the file first — so a resumed upload comes back as `n`
   * zero bytes followed by the tail, and the bytes the client already sent are
   * gone. A real daemon opens the file for update. Without this the server
   * corrupts every correctly-resumed upload, which reads exactly like a client
   * bug.
   */
  write(fileName, opts = {}) {
    const start = opts.start;
    if (!opts.append && start > 0) {
      const { fsPath, clientPath } = this._resolvePath(fileName);
      // 'r+' keeps what is already there; 'w+' is the fallback for a REST into
      // a file that does not exist yet, where a hole is the correct result.
      const flags = fs.existsSync(fsPath) ? 'r+' : 'w+';
      const stream = fs.createWriteStream(fsPath, { flags, start });
      stream.once('close', () => stream.end());
      return { stream, clientPath };
    }
    return super.write(fileName, opts);
  }

  setTimes(p, when) {
    const { fsPath } = this._resolvePath(p);
    const seconds = when / 1000;
    return fsp.utimes(fsPath, seconds, seconds);
  }
}

// ---------------------------------------------------------------------------
// a self-signed certificate, generated here, never committed
// ---------------------------------------------------------------------------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const derSeq = (...parts) => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts) => tlv(0x31, Buffer.concat(parts));
const derCtx = (n, ...parts) => tlv(0xa0 | n, Buffer.concat(parts));
const derBool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const derOctet = (b) => tlv(0x04, b);
const derUtf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));

function derOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [];
    let v = p;
    do { stack.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function derInteger(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0x00 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}

function derBitString(buf) {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derUtcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function pem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * A self-signed X.509 certificate for `localhost` / `127.0.0.1`, built here.
 *
 * Node ships no certificate *writer* — `crypto.X509Certificate` only reads —
 * so the TBS structure is assembled as DER and signed with `crypto.sign`. That
 * is the whole point: no key material is committed to the repository and every
 * run gets a fresh one. P-256 is used because generating it is instant, where
 * a 2048-bit RSA key would add a visible pause to the suite.
 */
function generateSelfSigned({ commonName = 'localhost', days = 1 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // ecdsa-with-SHA256 takes no parameters, unlike the RSA algorithm ids.
  const sigAlg = derSeq(derOid('1.2.840.10045.4.3.2'));
  const name = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(commonName))));

  const now = Date.now();
  const validity = derSeq(
    derUtcTime(new Date(now - 60 * 60 * 1000)),   // a clock a minute slow must still accept it
    derUtcTime(new Date(now + days * 24 * 60 * 60 * 1000)),
  );

  const generalNames = derSeq(
    tlv(0x82, Buffer.from(commonName, 'ascii')),  // [2] dNSName
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),       // [7] iPAddress
  );
  const extensions = derCtx(3, derSeq(
    derSeq(derOid('2.5.29.19'), derBool(true), derOctet(derSeq(derBool(true)))),   // basicConstraints CA
    derSeq(derOid('2.5.29.17'), derOctet(generalNames)),                           // subjectAltName
    derSeq(derOid('2.5.29.37'), derOctet(derSeq(derOid('1.3.6.1.5.5.7.3.1')))),    // EKU serverAuth
  ));

  const tbs = derSeq(
    derCtx(0, derInteger(Buffer.from([2]))),      // v3
    derInteger(crypto.randomBytes(8)),
    sigAlg,
    name,
    validity,
    name,
    spki,
    extensions,
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = derSeq(tbs, sigAlg, derBitString(signature));

  return {
    cert: pem('CERTIFICATE', certDer),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

/** A bunyan-shaped sink that keeps every line instead of printing it. */
function captureLog(lines) {
  const record = (level) => (...args) => {
    lines.push(`${level} ${args.map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ')}`);
  };
  const log = {
    child: () => log,
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  };
  return log;
}

/**
 * Start a real FTP server on an ephemeral port.
 *
 * options:
 *   users        { name: password } accepted by USER/PASS
 *   anonymous    accept `USER anonymous` with any password
 *   tls          `{ cert, key }` to enable AUTH TLS (or implicit when
 *                `implicit` is set)
 *   implicit     wrap the control connection in TLS from byte one (FTPS/990)
 *   blacklist    directives to refuse *and* to leave out of FEAT
 *   feat         `{ HASH: 'HASH BLAKE2B-256' }` — replace (or with a falsy
 *                value, suppress) one directive's FEAT line for this server
 *   listNoFlags  answer `LIST -a` with an empty listing and a 226, the way a
 *                server that reads `-a` as a file name does
 *   root         serve this directory instead of a fresh temp one
 */
async function startFtpServer(options = {}) {
  const root = options.root || await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-ftpd-'));
  const host = '127.0.0.1';
  const logLines = [];
  const scheme = options.implicit ? 'ftps' : 'ftp';

  const server = new FtpSrv({
    url: `${scheme}://${host}:0`,
    pasv_url: host,
    anonymous: !!options.anonymous,
    tls: options.tls || false,
    // NOT ftp-srv's own `blacklist` option: it normalizes entries with
    // lodash's `upperCase`, which splits words at a letter/digit boundary, so
    // `XSHA1` is stored as `XSHA 1` and never matches the directive it was
    // meant to block. The list is applied per connection below instead, where
    // ftp-srv's own comparison (a plain `toUpper`) does match.
    blacklist: [],
    log: captureLog(logLines),
    timeout: 0,
  });

  const blacklist = (options.blacklist || []).map((c) => String(c).toUpperCase());
  const featOverrides = {};
  for (const [k, v] of Object.entries(options.feat || {})) featOverrides[k.toUpperCase()] = v;
  server.on('connect', ({ connection }) => {
    connection.commands.blacklist = blacklist.slice();
    connection.featOverrides = featOverrides;
    connection.listNoFlags = !!options.listNoFlags;
  });

  // ftp-srv's default passive port picker walks 1024..65535 from the bottom,
  // which collides with whatever else is running on the machine. Ask the OS
  // for a free port instead — the same thing we do for the control socket.
  server.getNextPasvPort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const users = options.users || {};
  const logins = [];
  const loginAttempts = [];
  server.on('login', ({ connection, username, password }, resolve, reject) => {
    logins.push(username);
    // The password itself is never stored or printed — a digest is enough for a
    // test to prove that a particular credential was, or was not, put on the
    // wire (the anonymous login must not send the account password).
    loginAttempts.push({
      username,
      passwordSha256: crypto.createHash('sha256').update(String(password ?? '')).digest('hex'),
    });
    if (options.anonymous && username === 'anonymous') {
      resolve({ fs: new TestFileSystem(connection, { root }) });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(users, username) && users[username] === password) {
      resolve({ fs: new TestFileSystem(connection, { root }) });
      return;
    }
    reject(new Error('Bad username or password'));
  });

  const clientErrors = [];
  server.on('client-error', ({ context, error }) => {
    clientErrors.push(`${context}: ${error && error.message}`);
  });

  await server.listen();
  const port = server.server.address().port;

  return {
    server,
    host,
    port,
    root,
    logLines,
    logins,
    loginAttempts,
    clientErrors,
    async close() {
      await server.close();
      if (!options.root) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

module.exports = {
  startFtpServer,
  generateSelfSigned,
  timeVal,
  parseTimeVal,
  mlsxLine,
  checksumPathArg,
  TestFileSystem,
};
