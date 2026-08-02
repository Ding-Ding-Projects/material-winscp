// sftp-server.js — a REAL SSH server, in this process, on an ephemeral port.
//
// `ssh2` ships a full server implementation; what it does not ship is a
// back end. This file is that back end: a genuine SFTP v3 subsystem and a
// genuine `exec` channel (including the actual SCP wire protocol) sitting on
// top of a temporary directory. The adapters under test therefore speak real
// SSH over a real TCP socket to something that answers like a real server —
// nothing about the client side is mocked.
//
// Two deliberate departures from "just call fs", both because the suite has to
// give the same answer on Windows as it does on Linux:
//
//   * POSIX permission bits are kept in a side table. Windows has no mode bits
//     to store, so a chmod round trip through the real file system would come
//     back as 'rw-rw-rw-' there and 'rwxr-xr-x' on Linux, and the test would be
//     asserting the host rather than the protocol.
//   * Symbolic links are kept in a side table for the same reason: creating one
//     on Windows needs Developer Mode or elevation, so a real fs.symlink would
//     make the test pass or fail depending on who is logged in.
//
// Everything else — bytes, sizes, timestamps, directory structure — is the real
// file system in a real temp directory.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const nodePath = require('path');
const crypto = require('crypto');

const { Server, utils } = require('ssh2');
const { STATUS_CODE } = utils.sftp;

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o20000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One host key per process: generating an ed25519 pair is cheap, but a suite
// that starts a dozen servers should not pay for it a dozen times, and a stable
// key means a test can pin the fingerprint it expects to be offered.
let HOST_KEY = null;
function hostKey() {
  if (!HOST_KEY) HOST_KEY = utils.generateKeyPairSync('ed25519');
  return HOST_KEY;
}

/** OpenSSH's SHA256 fingerprint of a key in SSH wire format. */
function sha256Fingerprint(wire) {
  return 'SHA256:' + crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '');
}

function rightsFromMode(mode) {
  const bit = (v, c) => ((v & 1) ? c : '-');
  const trio = (v) => bit(v >> 2, 'r') + bit(v >> 1, 'w') + bit(v, 'x');
  return trio((mode >> 6) & 7) + trio((mode >> 3) & 7) + trio(mode & 7);
}

function typeChar(mode) {
  const fmt = mode & 0o170000;
  if (fmt === S_IFDIR) return 'd';
  if (fmt === S_IFLNK) return 'l';
  if (fmt === S_IFCHR) return 'c';
  return '-';
}

// --------------------------------------------------------------------- vfs

/**
 * The served file system: a real directory, plus the two side tables described
 * at the top of the file. Every path crossing this boundary is POSIX and
 * rooted at '/', which is also what keeps Windows path separators out of the
 * protocol entirely.
 */
class ServedFs {
  constructor(root, options = {}) {
    this.root = root;
    this.modes = new Map();          // virtual path -> POSIX mode bits (no type)
    this.links = new Map();          // virtual path -> symlink target
    this.owner = options.owner || 'wsuser';
    this.group = options.group || 'wsgroup';
    this.uid = options.uid === undefined ? 1000 : options.uid;
    this.gid = options.gid === undefined ? 1000 : options.gid;
  }

  /** POSIX-normalize, and refuse to leave the served root. */
  normalize(p, cwd = '/') {
    let raw = String(p === undefined || p === null || p === '' ? '.' : p);
    if (!raw.startsWith('/')) raw = cwd.replace(/\/+$/, '') + '/' + raw;
    const out = [];
    for (const seg of raw.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return '/' + out.join('/');
  }

  real(vpath) {
    const v = this.normalize(vpath);
    return nodePath.join(this.root, ...v.split('/').filter(Boolean));
  }

  isDevNull(vpath) { return this.normalize(vpath) === '/dev/null'; }

  mode(vpath, isDir) {
    const v = this.normalize(vpath);
    if (this.modes.has(v)) return this.modes.get(v);
    return isDir ? 0o755 : 0o644;
  }

  setMode(vpath, mode) { this.modes.set(this.normalize(vpath), mode & 0o7777); }

  /** Keep the side tables in step with a rename or a delete. */
  movePrefix(from, to) {
    const a = this.normalize(from);
    const b = this.normalize(to);
    for (const table of [this.modes, this.links]) {
      for (const key of [...table.keys()]) {
        if (key === a || key.startsWith(a + '/')) {
          table.set(b + key.slice(a.length), table.get(key));
          table.delete(key);
        }
      }
    }
  }

  dropPrefix(vpath) {
    const a = this.normalize(vpath);
    for (const table of [this.modes, this.links]) {
      for (const key of [...table.keys()]) {
        if (key === a || key.startsWith(a + '/')) table.delete(key);
      }
    }
  }

  /** lstat, in SFTP attribute shape (seconds, POSIX mode). Never follows. */
  async lstat(vpath) {
    const v = this.normalize(vpath);
    if (this.links.has(v)) {
      const target = this.links.get(v);
      return {
        mode: S_IFLNK | 0o777,
        uid: this.uid, gid: this.gid,
        size: Buffer.byteLength(target),
        atime: 0, mtime: 0,
        linkTarget: target,
      };
    }
    if (this.isDevNull(v)) {
      return { mode: S_IFCHR | 0o666, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
    }
    const st = await fsp.lstat(this.real(v));
    const isDir = st.isDirectory();
    return {
      mode: (isDir ? S_IFDIR : S_IFREG) | this.mode(v, isDir),
      uid: this.uid,
      gid: this.gid,
      size: isDir ? 0 : st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  }

  /** stat, which does follow a symbolic link (one hop is all the tests need). */
  async stat(vpath) {
    const v = this.normalize(vpath);
    if (this.links.has(v)) {
      const target = this.links.get(v);
      const resolved = target.startsWith('/') ? target : this.normalize(target, dirnameV(v));
      return this.lstat(resolved);
    }
    return this.lstat(v);
  }

  async readdir(vpath) {
    const v = this.normalize(vpath);
    const names = await fsp.readdir(this.real(v));
    const prefix = v === '/' ? '/' : v + '/';
    for (const key of this.links.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        names.push(key.slice(prefix.length));
      }
    }
    names.sort();
    const out = [];
    for (const name of names) {
      const child = v === '/' ? '/' + name : v + '/' + name;
      let attrs;
      try { attrs = await this.lstat(child); } catch { continue; }
      out.push({ name, attrs, longname: this.longname(name, attrs) });
    }
    return out;
  }

  /** The `ls -l` line an OpenSSH server puts in a READDIR reply. It is where
   *  the owner and group NAMES come from — the attribute block only has ids. */
  longname(name, attrs) {
    const d = new Date(attrs.mtime * 1000);
    const stamp = attrs.mtime
      ? `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : 'Jan  1  1970';
    const suffix = (attrs.mode & 0o170000) === S_IFLNK && attrs.linkTarget
      ? ` -> ${attrs.linkTarget}` : '';
    return `${typeChar(attrs.mode)}${rightsFromMode(attrs.mode)} 1 ${this.owner} ${this.group} `
      + `${String(attrs.size).padStart(8, ' ')} ${stamp} ${name}${suffix}`;
  }
}

function dirnameV(v) {
  const i = v.lastIndexOf('/');
  return i <= 0 ? '/' : v.slice(0, i);
}

function basenameV(v) {
  const i = v.lastIndexOf('/');
  return i < 0 ? v : v.slice(i + 1);
}

// -------------------------------------------------------------- shell words

/**
 * Split a command line the way a POSIX shell would: single quotes are literal
 * (with the `'\''` escape our own shellQuote() emits), double quotes allow the
 * backslash escape, and unquoted whitespace separates.
 */
function tokenize(line) {
  const out = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      has = true;
      i++;
      while (i < line.length && line[i] !== "'") { cur += line[i]; i++; }
      i++;                                        // the closing quote
      continue;
    }
    if (c === '"') {
      has = true;
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; continue; }
        cur += line[i]; i++;
      }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; has = true; i += 2; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      i++;
      continue;
    }
    cur += c; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

/** Split on `;`, `&&` and `||`, outside quotes. */
function splitCommands(line) {
  const parts = [];
  let cur = '';
  let join = ';';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === ';') { parts.push({ join, text: cur }); cur = ''; join = ';'; continue; }
    if (c === '&' && line[i + 1] === '&') { parts.push({ join, text: cur }); cur = ''; join = '&&'; i++; continue; }
    if (c === '|' && line[i + 1] === '|') { parts.push({ join, text: cur }); cur = ''; join = '||'; i++; continue; }
    cur += c;
  }
  parts.push({ join, text: cur });
  return parts.filter((p) => p.text.trim().length);
}

/** Pull the redirections out of an argument list; the destinations do not
 *  matter here, only that the stream is silenced. */
function stripRedirections(argv) {
  const out = [];
  const silence = { stdout: false, stderr: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '>/dev/null' || a === '1>/dev/null') { silence.stdout = true; continue; }
    if (a === '2>/dev/null') { silence.stderr = true; continue; }
    if (a === '2>&1') { continue; }
    if (a === '>' || a === '1>' || a === '2>') { i++; if (a === '2>') silence.stderr = true; else silence.stdout = true; continue; }
    out.push(a);
  }
  return { argv: out, silence };
}

// -------------------------------------------------------------- byte reader

/** Pull-style reader over an exec channel; the SCP protocol needs both short
 *  control lines and exact-length payloads off the same stream. */
class ChannelReader {
  constructor(src) {
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this._wake = null;
    src.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._notify(); });
    src.on('end', () => { this.ended = true; this._notify(); });
    src.on('close', () => { this.ended = true; this._notify(); });
    src.on('error', (e) => { this.error = e; this._notify(); });
  }

  _notify() { const w = this._wake; if (w) { this._wake = null; w(); } }
  _idle() { return new Promise((r) => { this._wake = r; }); }

  _take(n) { const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return out; }

  async bytes(n) {
    while (this.buf.length < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error('the SCP peer closed mid-record');
      await this._idle();
    }
    return this._take(n);
  }

  async line() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) return this._take(i + 1).subarray(0, i).toString('utf8');
      if (this.error) throw this.error;
      if (this.ended) throw new Error('the SCP peer closed mid-line');
      await this._idle();
    }
  }
}

// ------------------------------------------------------------------- server

/**
 * Start the server.
 *
 * options:
 *   root                    directory to serve (a fresh temp dir by default)
 *   username, password      the password credential that will be accepted
 *   authorizedKey           an OpenSSH public key line that will be accepted
 *   allowPassword           default true
 *   allowPublicKey          default true when authorizedKey is set
 *   allowKeyboardInteractive  default false
 *   kiPrompts               prompts to send, default one non-echo "Password:"
 *   kiExpect                the answer that is accepted (default: password)
 */
async function startSftpServer(options = {}) {
  const ownsRoot = !options.root;
  const root = options.root
    || await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'winscp-e2e-sftp-'));
  await fsp.mkdir(root, { recursive: true });

  const vfs = new ServedFs(root, options);
  const key = hostKey();
  const parsedHostKey = utils.parseKey(key.private);
  const fingerprint = sha256Fingerprint(parsedHostKey.getPublicSSH());

  const username = options.username || 'winscp';
  const password = options.password || 'correct horse battery staple';
  const allowPassword = options.allowPassword !== false;
  const authorizedKey = options.authorizedKey || null;
  const allowPublicKey = options.allowPublicKey === undefined ? !!authorizedKey : !!options.allowPublicKey;
  const allowKI = !!options.allowKeyboardInteractive;
  const kiPrompts = options.kiPrompts || [{ prompt: 'Password: ', echo: false }];
  const kiExpect = options.kiExpect === undefined ? password : options.kiExpect;

  // Everything the tests want to assert about what the SERVER actually saw.
  const stats = {
    auth: [],            // { method, accepted }
    reads: [],           // { path, offset, length }
    writes: [],          // { path, offset, length }
    exec: [],            // command strings
    connections: 0,
  };

  const parsedAuthorized = authorizedKey ? utils.parseKey(authorizedKey) : null;

  const server = new Server({
    hostKeys: [key.private],
    ident: 'SSH-2.0-WinSCPMaterialTestServer_1.0',
  }, (client) => {
    stats.connections += 1;

    client.on('error', () => { /* a test that asserts a refusal tears the socket down */ });

    client.on('authentication', (ctx) => {
      const record = (accepted) => stats.auth.push({ method: ctx.method, accepted });
      if (ctx.username !== username) { record(false); return ctx.reject(); }

      if (ctx.method === 'password') {
        if (allowPassword && ctx.password === password) { record(true); return ctx.accept(); }
        record(false);
        return ctx.reject();
      }

      if (ctx.method === 'publickey') {
        if (!allowPublicKey || !parsedAuthorized) { record(false); return ctx.reject(); }
        if (ctx.key.algo !== parsedAuthorized.type
            || !ctx.key.data.equals(parsedAuthorized.getPublicSSH())) {
          record(false);
          return ctx.reject();
        }
        // A signature only arrives on the second round trip; the first is the
        // client asking whether this key would be acceptable at all.
        if (ctx.signature && !parsedAuthorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
          record(false);
          return ctx.reject();
        }
        record(true);
        return ctx.accept();
      }

      if (ctx.method === 'keyboard-interactive') {
        if (!allowKI) { record(false); return ctx.reject(); }
        return ctx.prompt(kiPrompts, 'Test server', 'Answer the prompt', (answers) => {
          const ok = (answers || [])[0] === kiExpect;
          record(ok);
          if (ok) ctx.accept(); else ctx.reject();
        });
      }

      record(false);
      return ctx.reject(allowKI
        ? ['password', 'publickey', 'keyboard-interactive']
        : ['password', 'publickey']);
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          serveSftp(acceptSftp(), vfs, stats);
        });
        session.on('exec', (acceptExec, rejectExec, info) => {
          stats.exec.push(info.command);
          const stream = acceptExec();
          runCommandLine(info.command, stream, vfs).then((code) => {
            stream.exit(typeof code === 'number' ? code : 0);
            stream.end();
          }).catch((err) => {
            try { stream.stderr.write(`${err.message}\n`); } catch { /* channel gone */ }
            try { stream.exit(1); stream.end(); } catch { /* channel gone */ }
          });
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.end();
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });

  const address = server.address();

  return {
    host: '127.0.0.1',
    port: address.port,
    root,
    vfs,
    username,
    password,
    fingerprint,
    stats,
    hostKeyPublic: key.public,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // A client that is still connected keeps the server open; the tests
        // disconnect first, but a failed test must not hang the runner.
        setTimeout(resolve, 500).unref();
      });
      // A suite that leaves a served tree behind on every run fills the temp
      // directory; a caller who supplied its own root keeps it.
      if (ownsRoot) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ------------------------------------------------------------------- sftp

function errnoStatus(err) {
  if (!err) return STATUS_CODE.FAILURE;
  if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function serveSftp(sftp, vfs, stats) {
  const handles = new Map();
  let nextHandle = 1;

  const makeHandle = (record) => {
    const id = nextHandle++;
    handles.set(id, record);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    return buf;
  };
  const lookup = (buf) => (buf && buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : null);

  const guard = (reqid, fn) => {
    Promise.resolve().then(fn).catch((err) => sftp.status(reqid, errnoStatus(err)));
  };

  sftp.on('REALPATH', (reqid, p) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    sftp.name(reqid, [{ filename: v, longname: v, attrs: {} }]);
  }));

  sftp.on('OPENDIR', (reqid, p) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    const st = await vfs.stat(v);
    if ((st.mode & 0o170000) !== S_IFDIR) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const rows = await vfs.readdir(v);
    // A real OpenSSH server puts '.' and '..' in every READDIR reply — they are
    // ordinary directory entries at the protocol level, and it is the CLIENT's
    // job to drop them. A helper that quietly omitted them would let an adapter
    // that never filtered pass the test that says it does, and would then walk
    // a tree forever the first time it met a real server.
    const self = await vfs.lstat(v);
    const parent = await vfs.lstat(dirnameV(v));
    rows.unshift(
      { name: '.', attrs: self, longname: vfs.longname('.', self) },
      { name: '..', attrs: parent, longname: vfs.longname('..', parent) },
    );
    return sftp.handle(reqid, makeHandle({ type: 'dir', rows, sent: false }));
  }));

  sftp.on('READDIR', (reqid, handle) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec || rec.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (rec.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    rec.sent = true;
    return sftp.name(reqid, rec.rows.map((r) => ({
      filename: r.name,
      longname: r.longname,
      attrs: r.attrs,
    })));
  }));

  sftp.on('OPEN', (reqid, filename, pflags, attrs) => guard(reqid, async () => {
    const v = vfs.normalize(filename);
    const flags = utils.sftp.flagsToString(pflags) || 'r';
    const fd = await fsp.open(vfs.real(v), flags);
    if (attrs && attrs.mode !== undefined) vfs.setMode(v, attrs.mode);
    return sftp.handle(reqid, makeHandle({ type: 'file', fd, path: v }));
  }));

  sftp.on('READ', (reqid, handle, offset, length) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec || rec.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    // `length` is what the client ASKED for; `returned` is what it got. Near
    // EOF those differ, and a test that wants to prove the reads are contiguous
    // has to add up the second, not the first.
    const record = { path: rec.path, offset: Number(offset), length, returned: 0 };
    stats.reads.push(record);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await rec.fd.read(buf, 0, length, Number(offset));
    record.returned = bytesRead;
    if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
    return sftp.data(reqid, buf.subarray(0, bytesRead));
  }));

  sftp.on('WRITE', (reqid, handle, offset, data) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec || rec.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    stats.writes.push({ path: rec.path, offset: Number(offset), length: data.length });
    await rec.fd.write(data, 0, data.length, Number(offset));
    return sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('CLOSE', (reqid, handle) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(handle.readUInt32BE(0));
    if (rec.type === 'file') await rec.fd.close();
    return sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('LSTAT', (reqid, p) => guard(reqid, async () => {
    sftp.attrs(reqid, await vfs.lstat(p));
  }));

  sftp.on('STAT', (reqid, p) => guard(reqid, async () => {
    sftp.attrs(reqid, await vfs.stat(p));
  }));

  sftp.on('FSTAT', (reqid, handle) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec || rec.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    return sftp.attrs(reqid, await vfs.lstat(rec.path));
  }));

  const applyAttrs = async (v, attrs) => {
    if (!attrs) return;
    if (attrs.mode !== undefined) vfs.setMode(v, attrs.mode);
    if (attrs.atime !== undefined && attrs.mtime !== undefined) {
      await fsp.utimes(vfs.real(v), new Date(attrs.atime * 1000), new Date(attrs.mtime * 1000));
    }
    if (attrs.uid !== undefined && attrs.gid !== undefined) {
      vfs.uid = attrs.uid;
      vfs.gid = attrs.gid;
    }
  };

  sftp.on('SETSTAT', (reqid, p, attrs) => guard(reqid, async () => {
    await applyAttrs(vfs.normalize(p), attrs);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('FSETSTAT', (reqid, handle, attrs) => guard(reqid, async () => {
    const rec = lookup(handle);
    if (!rec || rec.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    await applyAttrs(rec.path, attrs);
    return sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('MKDIR', (reqid, p, attrs) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    await fsp.mkdir(vfs.real(v));
    if (attrs && attrs.mode !== undefined) vfs.setMode(v, attrs.mode);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('RMDIR', (reqid, p) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    await fsp.rmdir(vfs.real(v));
    vfs.dropPrefix(v);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('REMOVE', (reqid, p) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    if (vfs.links.has(v)) { vfs.links.delete(v); return sftp.status(reqid, STATUS_CODE.OK); }
    await fsp.unlink(vfs.real(v));
    vfs.dropPrefix(v);
    return sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('RENAME', (reqid, from, to) => guard(reqid, async () => {
    const a = vfs.normalize(from);
    const b = vfs.normalize(to);
    if (vfs.links.has(a)) {
      vfs.links.set(b, vfs.links.get(a));
      vfs.links.delete(a);
      return sftp.status(reqid, STATUS_CODE.OK);
    }
    await fsp.rename(vfs.real(a), vfs.real(b));
    vfs.movePrefix(a, b);
    return sftp.status(reqid, STATUS_CODE.OK);
  }));

  // ssh2 unswaps OpenSSH's reversed SYMLINK fields on both sides, so a server
  // handler always receives (linkPath, targetPath) whoever the peer is.
  sftp.on('SYMLINK', (reqid, linkPath, target) => guard(reqid, async () => {
    vfs.links.set(vfs.normalize(linkPath), String(target));
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('READLINK', (reqid, p) => guard(reqid, async () => {
    const v = vfs.normalize(p);
    if (!vfs.links.has(v)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    const target = vfs.links.get(v);
    return sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
  }));

  sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));

  // A client that walks away mid-transfer leaves its handles open. A real
  // server reaps them when the channel dies; not doing so here would turn an
  // unrelated test failure into a "FileHandle closed during garbage
  // collection" error that buries the real one.
  const reap = () => {
    for (const rec of handles.values()) {
      if (rec.type === 'file') rec.fd.close().catch(() => {});
    }
    handles.clear();
  };
  sftp.on('end', reap);
  sftp.on('close', reap);
}

// ------------------------------------------------------------------- shell

/** `touch -t` stamps: [[CC]YY]MMDDhhmm[.ss], interpreted in local time. */
function parseTouchStamp(s) {
  const m = /^(?:(\d{2})?(\d{2}))?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(s);
  if (!m) return null;
  const century = m[1] === undefined ? String(new Date().getFullYear()).slice(0, 2) : m[1];
  const year = m[2] === undefined ? new Date().getFullYear() : Number(century + m[2]);
  return new Date(year, Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] || 0));
}

function twoDigit(n) { return String(n).padStart(2, '0'); }

function offsetString(d) {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return sign + twoDigit(Math.floor(abs / 60)) + twoDigit(abs % 60);
}

function lsLine(vfs, name, attrs, fullTime) {
  const d = new Date(attrs.mtime * 1000);
  const stamp = fullTime
    ? `${d.getFullYear()}-${twoDigit(d.getMonth() + 1)}-${twoDigit(d.getDate())} `
      + `${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}:${twoDigit(d.getSeconds())}.000000000 ${offsetString(d)}`
    : `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}`;
  const suffix = (attrs.mode & 0o170000) === S_IFLNK && attrs.linkTarget ? ` -> ${attrs.linkTarget}` : '';
  return `${typeChar(attrs.mode)}${rightsFromMode(attrs.mode)} 1 ${vfs.owner} ${vfs.group} `
    + `${String(attrs.size).padStart(6, ' ')} ${stamp} ${name}${suffix}`;
}

/**
 * Run a whole command LINE — the `;`/`&&`/`||` sequence WinSCP's shell session
 * builds — and return the exit status of the last command that ran.
 */
async function runCommandLine(command, stream, vfs) {
  const parts = splitCommands(command);
  const io = {
    cwd: '/',
    out: (s) => { stream.write(s); },
    err: (s) => { stream.stderr.write(s); },
    stream,
  };
  let code = 0;
  for (const part of parts) {
    if (part.join === '&&' && code !== 0) continue;
    if (part.join === '||' && code === 0) continue;
    code = await runOne(part.text.trim(), io, vfs);
  }
  return code;
}

async function runOne(text, io, vfs) {
  const raw = tokenize(text);
  const { argv, silence } = stripRedirections(raw);
  if (!argv.length) return 0;
  const out = silence.stdout ? () => {} : io.out;
  const err = silence.stderr ? () => {} : io.err;
  const cmd = argv[0];
  const args = argv.slice(1);

  // Options and their operands, with `--` ending the option list.
  const flags = [];
  const operands = [];
  let endOfFlags = false;
  for (const a of args) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith('-') && a.length > 1) { flags.push(a); continue; }
    operands.push(a);
  }
  const hasFlag = (...names) => flags.some((f) => names.some((n) => (n.startsWith('--') ? f === n : f.startsWith('-') && !f.startsWith('--') && f.includes(n.slice(1)))));

  switch (cmd) {
    case 'true': case ':': return 0;
    case 'false': return 1;
    case 'unalias': case 'unset': case 'export': return 0;

    case 'echo':
      out(operands.concat(flags).join(' ') + '\n');
      return 0;

    case 'pwd':
      out(io.cwd + '\n');
      return 0;

    case 'cd': {
      const v = vfs.normalize(operands[0] || '/', io.cwd);
      try {
        const st = await vfs.stat(v);
        if ((st.mode & 0o170000) !== S_IFDIR) throw new Error('not a directory');
      } catch {
        err(`cd: ${operands[0]}: No such file or directory\n`);
        return 1;
      }
      io.cwd = v;
      return 0;
    }

    case 'uname':
      out('Linux 5.15.0-winscp-material-test\n');
      return 0;

    case 'ls': return lsCommand(flags, operands, io, vfs, out, err, hasFlag);

    case 'mkdir': {
      const v = vfs.normalize(operands[0], io.cwd);
      try {
        await fsp.mkdir(vfs.real(v), { recursive: hasFlag('-p') });
        return 0;
      } catch (e) { err(`mkdir: cannot create directory '${operands[0]}': ${e.code}\n`); return 1; }
    }

    case 'rmdir': {
      const v = vfs.normalize(operands[0], io.cwd);
      try { await fsp.rmdir(vfs.real(v)); vfs.dropPrefix(v); return 0; }
      catch (e) { err(`rmdir: failed to remove '${operands[0]}': ${e.code}\n`); return 1; }
    }

    case 'rm': {
      const force = hasFlag('-f');
      let status = 0;
      for (const operand of operands) {
        const v = vfs.normalize(operand, io.cwd);
        if (vfs.links.has(v)) { vfs.links.delete(v); continue; }
        try {
          const st = await fsp.lstat(vfs.real(v));
          if (st.isDirectory()) {
            if (!hasFlag('-r', '-R')) { err(`rm: cannot remove '${operand}': Is a directory\n`); status = 1; continue; }
            await fsp.rm(vfs.real(v), { recursive: true, force: true });
          } else {
            await fsp.unlink(vfs.real(v));
          }
          vfs.dropPrefix(v);
        } catch (e) {
          if (!force) { err(`rm: cannot remove '${operand}': ${e.code}\n`); status = 1; }
        }
      }
      return status;
    }

    case 'mv': {
      const a = vfs.normalize(operands[0], io.cwd);
      const b = vfs.normalize(operands[1], io.cwd);
      try {
        if (vfs.links.has(a)) { vfs.links.set(b, vfs.links.get(a)); vfs.links.delete(a); return 0; }
        await fsp.rename(vfs.real(a), vfs.real(b));
        vfs.movePrefix(a, b);
        return 0;
      } catch (e) { err(`mv: cannot move '${operands[0]}': ${e.code}\n`); return 1; }
    }

    case 'cp': {
      const a = vfs.normalize(operands[0], io.cwd);
      const b = vfs.normalize(operands[1], io.cwd);
      try {
        const st = await vfs.stat(a);
        const isDir = (st.mode & 0o170000) === S_IFDIR;
        await fsp.cp(vfs.real(a), vfs.real(b), { recursive: true, preserveTimestamps: true });
        vfs.setMode(b, vfs.mode(a, isDir));
        return 0;
      } catch (e) { err(`cp: cannot copy '${operands[0]}': ${e.code}\n`); return 1; }
    }

    case 'ln': {
      const target = operands[0];
      const link = vfs.normalize(operands[1], io.cwd);
      if (hasFlag('-s')) { vfs.links.set(link, target); return 0; }
      try { await fsp.link(vfs.real(vfs.normalize(target, io.cwd)), vfs.real(link)); return 0; }
      catch (e) { err(`ln: failed to create link: ${e.code}\n`); return 1; }
    }

    case 'readlink': {
      const v = vfs.normalize(operands[0], io.cwd);
      if (vfs.links.has(v)) { out(vfs.links.get(v) + '\n'); return 0; }
      if (hasFlag('-f')) {
        try { await vfs.stat(v); out(v + '\n'); return 0; } catch { return 1; }
      }
      return 1;
    }

    case 'chmod': {
      const mode = parseInt(operands[0], 8);
      if (Number.isNaN(mode)) { err('chmod: invalid mode\n'); return 1; }
      const targets = operands.slice(1);
      for (const t of targets) {
        const v = vfs.normalize(t, io.cwd);
        try { await vfs.stat(v); } catch { err(`chmod: cannot access '${t}'\n`); return 1; }
        vfs.setMode(v, mode);
        if (hasFlag('-R')) {
          for (const child of await walkAll(vfs, v)) vfs.setMode(child, mode);
        }
      }
      return 0;
    }

    case 'chown': {
      // Nothing in a temp directory owned by the test user can change hands.
      err('chown: changing ownership: Operation not permitted\n');
      return 1;
    }

    case 'touch': {
      let stampIndex = flags.indexOf('-t');
      let stamp = null;
      if (stampIndex >= 0) {
        // `-t` takes its argument as the next word, which the flag/operand
        // split above pushed into `operands`.
        stamp = parseTouchStamp(operands[0]);
        operands.shift();
      }
      const when = stamp || new Date();
      for (const t of operands) {
        const v = vfs.normalize(t, io.cwd);
        try {
          const st = await fsp.stat(vfs.real(v));
          const atime = hasFlag('-a') ? when : st.atime;
          const mtime = hasFlag('-m') || !hasFlag('-a') ? when : st.mtime;
          await fsp.utimes(vfs.real(v), atime, mtime);
        } catch {
          await fsp.writeFile(vfs.real(v), '');
          await fsp.utimes(vfs.real(v), when, when);
        }
      }
      return 0;
    }

    case 'df': {
      const v = vfs.normalize(operands[0] || '/', io.cwd);
      out('Filesystem 1024-blocks Used Available Capacity Mounted on\n');
      out(`/dev/testfs 1048576 262144 786432 25% ${v === '/' ? '/' : '/'}\n`);
      return 0;
    }

    case 'sha256sum': case 'sha1sum': case 'sha512sum': case 'md5sum': {
      const algo = { sha256sum: 'sha256', sha1sum: 'sha1', sha512sum: 'sha512', md5sum: 'md5' }[cmd];
      const v = vfs.normalize(operands[0], io.cwd);
      try {
        const data = await fsp.readFile(vfs.real(v));
        out(`${crypto.createHash(algo).update(data).digest('hex')}  ${operands[0]}\n`);
        return 0;
      } catch { err(`${cmd}: ${operands[0]}: No such file or directory\n`); return 1; }
    }

    case 'scp': return scpCommand(flags, operands, io, vfs, err);

    default:
      err(`sh: ${cmd}: command not found\n`);
      return 127;
  }
}

async function walkAll(vfs, v) {
  const out = [];
  const stack = [v];
  while (stack.length) {
    const dir = stack.pop();
    let rows;
    try { rows = await vfs.readdir(dir); } catch { continue; }
    for (const r of rows) {
      const child = dir === '/' ? '/' + r.name : dir + '/' + r.name;
      out.push(child);
      if ((r.attrs.mode & 0o170000) === S_IFDIR) stack.push(child);
    }
  }
  return out;
}

async function lsCommand(flags, operands, io, vfs, out, err, hasFlag) {
  const fullTime = flags.includes('--full-time');
  const target = vfs.normalize(operands[0] || '.', io.cwd);
  const showAll = hasFlag('-a');

  if (vfs.isDevNull(target)) {
    // `ls --full-time /dev/null` is exactly how the SCP adapter finds out
    // whether this server's ls is the GNU one, so /dev/null has to exist.
    const attrs = await vfs.lstat(target);
    out(lsLine(vfs, '/dev/null', attrs, fullTime) + '\n');
    return 0;
  }

  let attrs;
  try { attrs = await vfs.lstat(target); }
  catch { err(`ls: cannot access '${operands[0]}': No such file or directory\n`); return 2; }

  if (hasFlag('-d') || (attrs.mode & 0o170000) !== S_IFDIR) {
    out(lsLine(vfs, operands[0] || target, attrs, fullTime) + '\n');
    return 0;
  }

  const rows = await vfs.readdir(target);
  out(`total ${rows.length}\n`);
  if (showAll) {
    out(lsLine(vfs, '.', await vfs.lstat(target), fullTime) + '\n');
    out(lsLine(vfs, '..', await vfs.lstat(dirnameV(target)), fullTime) + '\n');
  }
  for (const r of rows) {
    if (!showAll && r.name.startsWith('.')) continue;
    out(lsLine(vfs, r.name, r.attrs, fullTime) + '\n');
  }
  return 0;
}

// --------------------------------------------------------------------- scp

const NUL = Buffer.from([0]);

/** The server half of the SCP wire protocol, for both directions. */
async function scpCommand(flags, operands, io, vfs, err) {
  const stream = io.stream;
  const reader = new ChannelReader(stream);
  const source = flags.some((f) => f.startsWith('-') && !f.startsWith('--') && f.includes('f'));
  const sink = flags.some((f) => f.startsWith('-') && !f.startsWith('--') && f.includes('t'));
  const recursive = flags.some((f) => f.startsWith('-') && !f.startsWith('--') && f.includes('r'));
  const preserve = flags.some((f) => f.startsWith('-') && !f.startsWith('--') && f.includes('p'));
  const target = vfs.normalize(operands[0] || '.', io.cwd);

  const expectAck = async () => {
    const b = await reader.bytes(1);
    if (b[0] !== 0) {
      const message = b[0] === 1 || b[0] === 2 ? (await reader.line()).trim() : '';
      throw new Error(message || 'the scp client reported an error');
    }
  };
  const write = (buf) => new Promise((resolve) => {
    if (stream.write(buf)) resolve(); else stream.once('drain', resolve);
  });

  try {
    if (source) {
      await expectAck();
      const attrs = await vfs.lstat(target);
      const isDir = (attrs.mode & 0o170000) === S_IFDIR;
      if (isDir && !recursive) { err(`scp: ${operands[0]}: not a regular file\n`); return 1; }

      const sendFile = async (vpath, name, a) => {
        if (preserve) {
          await write(`T${a.mtime} 0 ${a.atime} 0\n`);
          await expectAck();
        }
        await write(`C${'0' + (a.mode & 0o7777).toString(8).padStart(3, '0').slice(-3)} ${a.size} ${name}\n`);
        await expectAck();
        const data = await fsp.readFile(vfs.real(vpath));
        await write(data);
        await write(NUL);
        await expectAck();
      };

      const sendDir = async (vpath, name) => {
        const a = await vfs.lstat(vpath);
        if (preserve) {
          await write(`T${a.mtime} 0 ${a.atime} 0\n`);
          await expectAck();
        }
        await write(`D${'0' + (a.mode & 0o7777).toString(8).padStart(3, '0').slice(-3)} 0 ${name}\n`);
        await expectAck();
        for (const row of await vfs.readdir(vpath)) {
          const child = vpath === '/' ? '/' + row.name : vpath + '/' + row.name;
          if ((row.attrs.mode & 0o170000) === S_IFDIR) await sendDir(child, row.name);
          else if ((row.attrs.mode & 0o170000) !== S_IFLNK) await sendFile(child, row.name, row.attrs);
        }
        await write('E\n');
        await expectAck();
      };

      if (isDir) await sendDir(target, basenameV(target));
      else await sendFile(target, basenameV(target), attrs);
      return 0;
    }

    if (sink) {
      await write(NUL);
      let targetIsDir = false;
      try { targetIsDir = ((await vfs.stat(target)).mode & 0o170000) === S_IFDIR; } catch { targetIsDir = false; }
      if (recursive && !targetIsDir) { await fsp.mkdir(vfs.real(target), { recursive: true }); targetIsDir = true; }

      const stack = [{ path: target, isRoot: true }];
      let times = null;

      for (;;) {
        let line;
        try { line = await reader.line(); } catch { break; }   // the client closed: done
        if (!line.length) continue;
        const kind = line[0];

        if (kind === 'T') {
          const m = /^T(\d+)\s+\d+\s+(\d+)\s+\d+$/.exec(line);
          if (!m) { await write(Buffer.from([1])); await write('bad time record\n'); return 1; }
          times = { mtime: Number(m[1]), atime: Number(m[2]) };
          await write(NUL);
          continue;
        }

        if (kind === 'E') {
          const done = stack.pop();
          if (done && done.times) {
            await fsp.utimes(vfs.real(done.path), new Date(done.times.atime * 1000), new Date(done.times.mtime * 1000));
          }
          await write(NUL);
          times = null;
          if (!stack.length) break;
          continue;
        }

        const m = /^([CD])(\d{4})\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) { await write(Buffer.from([1])); await write(`bad record: ${line}\n`); return 1; }
        const mode = parseInt(m[2], 8);
        const size = Number(m[3]);
        const name = m[4];
        const top = stack[stack.length - 1];
        // The very first record of a non-recursive transfer names the file the
        // client is sending; where it LANDS is decided by the target argument,
        // exactly as scp(1) does — into the directory if the target is one,
        // otherwise at the target path itself.
        const dest = top.isRoot && !targetIsDir ? top.path
          : (top.path === '/' ? '/' + name : top.path + '/' + name);

        if (m[1] === 'D') {
          await fsp.mkdir(vfs.real(dest), { recursive: true });
          vfs.setMode(dest, mode);
          stack.push({ path: dest, times });
          times = null;
          await write(NUL);
          continue;
        }

        await write(NUL);
        const data = size ? await reader.bytes(size) : Buffer.alloc(0);
        await fsp.writeFile(vfs.real(dest), data);
        vfs.setMode(dest, mode);
        const trailer = await reader.bytes(1);
        if (trailer[0] !== 0) { err('scp: protocol error after payload\n'); return 1; }
        await write(NUL);
        if (times) {
          await fsp.utimes(vfs.real(dest), new Date(times.atime * 1000), new Date(times.mtime * 1000));
          times = null;
        }
      }
      return 0;
    }

    err('scp: neither -f nor -t was given\n');
    return 1;
  } catch (e) {
    err(`scp: ${e.message}\n`);
    return 1;
  }
}

module.exports = {
  startSftpServer,
  ServedFs,
  tokenize,
  splitCommands,
  rightsFromMode,
};
