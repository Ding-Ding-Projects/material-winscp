// local.js — the local file system, as seen by the Commander's local panel.
//
// This is the only adapter whose paths are not POSIX. Windows brings three
// things the POSIX helpers in base.js cannot express: a virtual root above the
// drive letters (what Explorer calls "This PC"), drive-rooted paths, and UNC
// shares. The path helpers are therefore split out as two pure objects —
// `winPath` and `posixPath` — so the shapes can be tested on any host rather
// than only on the host that happens to run the suite.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const nodePath = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Adapter, entry } = require('./base');

// ---------------------------------------------------------------- path shapes

// `\\?\` and `\\.\` are the Win32 "long path" escapes. They are an encoding of
// an ordinary path, not a different kind of path, so they are unwrapped before
// anything else looks at the string.
const LONG_UNC = /^[\\/]{2}[?.][\\/]UNC[\\/]/i;
const LONG_LOCAL = /^[\\/]{2}[?.][\\/]/;
const UNC = /^[\\/]{2}([^\\/]+)(?:[\\/]+([^\\/]+))?([\\/].*)?$/;
const DRIVE = /^([A-Za-z]):(.*)$/;

function splitSegments(rest, sep) {
  const out = [];
  for (const seg of String(rest).split(sep)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

/** Break a Windows path into { root, segs }. `root` is '' at the virtual root. */
function parseWin(p) {
  let s = p == null ? '' : String(p);
  if (LONG_UNC.test(s)) s = '\\\\' + s.slice(8);
  else if (LONG_LOCAL.test(s)) s = s.slice(4);

  let m = UNC.exec(s);
  if (m) {
    const root = '\\\\' + m[1] + (m[2] ? '\\' + m[2] : '');
    return { kind: 'unc', root, segs: splitSegments(m[3] || '', /[\\/]+/) };
  }
  m = DRIVE.exec(s);
  if (m) {
    return { kind: 'drive', root: m[1].toUpperCase() + ':\\', segs: splitSegments(m[2], /[\\/]+/) };
  }
  return { kind: 'relative', root: '', segs: splitSegments(s, /[\\/]+/) };
}

function composeWin(parsed) {
  const { kind, root, segs } = parsed;
  if (kind === 'drive') return root + segs.join('\\');
  if (kind === 'unc') return root + (segs.length ? '\\' + segs.join('\\') : '');
  return segs.join('\\');
}

/** Windows path helpers. The virtual root — the drive list — is `''`. */
const winPath = {
  sep: '\\',
  root: '',
  normalize(p) { return composeWin(parseWin(p)); },
  join(...parts) {
    const usable = parts.filter((p) => p !== '' && p !== null && p !== undefined);
    return winPath.normalize(usable.join('\\'));
  },
  dirname(p) {
    const parsed = parseWin(p);
    if (!parsed.segs.length) return '';          // a drive or share root sits under "This PC"
    parsed.segs.pop();
    return composeWin(parsed);
  },
  basename(p) {
    const parsed = parseWin(p);
    // A root has no last segment; showing 'C:\' beats showing nothing.
    if (!parsed.segs.length) return parsed.root;
    return parsed.segs[parsed.segs.length - 1];
  },
  /** True for 'C:\' and '\\server\share' — a place with no parent directory. */
  isRoot(p) {
    const parsed = parseWin(p);
    return parsed.kind !== 'relative' && !parsed.segs.length;
  },
  isVirtualRoot(p) { return winPath.normalize(p) === ''; },
  isAbsolute(p) { return parseWin(p).kind !== 'relative'; },
  rootOf(p) { return parseWin(p).root; },
};

/** POSIX path helpers. Backslash is a legal file-name character here, so unlike
 *  base.js this splits on '/' only. */
const posixPath = {
  sep: '/',
  root: '/',
  normalize(p) {
    if (!p) return '/';
    const abs = String(p).startsWith('/');
    const segs = splitSegments(p, /\/+/);
    const joined = segs.join('/');
    if (abs) return '/' + joined;
    return joined || '/';
  },
  join(...parts) {
    const usable = parts.filter((p) => p !== '' && p !== null && p !== undefined);
    return posixPath.normalize(usable.join('/'));
  },
  dirname(p) {
    const n = posixPath.normalize(p);
    if (n === '/') return '/';
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  },
  basename(p) {
    const n = posixPath.normalize(p);
    if (n === '/') return '/';
    const i = n.lastIndexOf('/');
    return i < 0 ? n : n.slice(i + 1);
  },
  isRoot(p) { return posixPath.normalize(p) === '/'; },
  isVirtualRoot(p) { return posixPath.normalize(p) === '/'; },
  isAbsolute(p) { return String(p || '').startsWith('/'); },
  rootOf(p) { return posixPath.isAbsolute(p) ? '/' : ''; },
};

function helpersFor(platform) { return platform === 'win32' ? winPath : posixPath; }

// ------------------------------------------------------------------- helpers

function rightsFromMode(mode) {
  const bit = (v, c) => ((v & 1) ? c : '-');
  const trio = (v) => bit(v >> 2, 'r') + bit(v >> 1, 'w') + bit(v, 'x');
  const s = (trio((mode >> 6) & 7) + trio((mode >> 3) & 7) + trio(mode & 7)).split('');
  if (mode & 0o4000) s[2] = s[2] === 'x' ? 's' : 'S';
  if (mode & 0o2000) s[5] = s[5] === 'x' ? 's' : 'S';
  if (mode & 0o1000) s[8] = s[8] === 'x' ? 't' : 'T';
  return s.join('');
}

function typeOfStat(st) {
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'special';
}

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

/** Electron is absent when the suite runs under plain node, and the npm package
 *  exports a path string rather than the API when required outside Electron. */
function electronShell() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' ? e.shell : null;
  } catch { return null; }
}

// Node's fs.Stats carries FILE_ATTRIBUTE_READONLY (as the write bits) but not
// FILE_ATTRIBUTE_HIDDEN or _SYSTEM, and there is no Node API that exposes them.
// `attrib` is the cheap way to get the whole directory's attributes in one go,
// which is what WinSCP's local panel reads from GetFileAttributes.
async function windowsAttributes(dir) {
  const prefix = dir.endsWith('\\') ? dir : dir + '\\';
  let stdout;
  try {
    ({ stdout } = await execFileAsync('attrib', ['/D', prefix + '*'],
      { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;   // an unreadable or enormous directory falls back to fs.Stats
  }
  const needle = prefix.toLowerCase();
  const map = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    const flags = line.slice(0, i);
    const name = line.slice(i + prefix.length);
    if (!name || name.includes('\\')) continue;
    map.set(name.toLowerCase(), {
      archive: flags.includes('A'),
      readOnly: flags.includes('R'),
      system: flags.includes('S'),
      hidden: flags.includes('H'),
    });
  }
  return map;
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ------------------------------------------------------------------ adapter

class LocalAdapter extends Adapter {
  constructor(session = {}) {
    super(session);
    // `session.platform` exists so the Windows shapes can be exercised on a
    // POSIX host; the file-system calls always use the real platform.
    this.platform = session.platform || process.platform;
    this.p = helpersFor(this.platform);
    this.isWindows = this.platform === 'win32';

    const shell = electronShell();
    this._trash = shell && typeof shell.trashItem === 'function' ? shell : null;

    this.caps = {
      ...this.caps,
      rights: !this.isWindows,
      owner: !this.isWindows,
      symlink: true,
      hardlink: true,
      exec: false,
      resume: true,
      timestamp: true,
      recycleBin: !!this._trash,
      checksum: true,
      find: true,
      rename: true,
      move: true,
      copyRemote: false,
      calculateSize: true,
      nativeMove: true,
      hiddenFiles: true,
      spaceInfo: typeof fsp.statfs === 'function',
    };
    this.home = os.homedir();
  }

  get protocolName() { return 'Local'; }
  get sep() { return this.p.sep; }

  normalize(p) { return this.p.normalize(p); }
  join(...parts) { return this.p.join(...parts); }
  dirname(p) { return this.p.dirname(p); }
  basename(p) { return this.p.basename(p); }
  isRoot(p) { return this.p.isRoot(p); }
  /** The drive list on Windows; identical to '/' elsewhere. */
  isVirtualRoot(p) { return this.isWindows && this.p.isVirtualRoot(p); }

  _log(level, message) { this.emit('log', { level, message }); }

  // ---- lifecycle -------------------------------------------------------
  async connect() {
    this.connected = true;
    this.home = os.homedir();
    this.serverInfo = {
      platform: process.platform,
      release: os.release(),
      hostName: os.hostname(),
      tempDir: os.tmpdir(),
    };
    this._log('info', `Local file system ready (${process.platform} ${os.release()})`);
    return this.serverInfo;
  }

  async disconnect() { this.connected = false; }

  // ---- reading ---------------------------------------------------------
  async list(dir) {
    const target = this.normalize(dir);
    if (this.isVirtualRoot(target)) return this._listDrives();

    const names = await fsp.readdir(target);
    const attrs = this.isWindows ? await windowsAttributes(target) : null;

    const rows = await Promise.all(names.map(async (name) => {
      const full = this.join(target, name);
      let st;
      try { st = await fsp.lstat(full); } catch { return null; }  // vanished mid-listing

      let linkTarget = '';
      let type = typeOfStat(st);
      let size = st.size;
      if (st.isSymbolicLink()) {
        try { linkTarget = await fsp.readlink(full); } catch { /* dangling link */ }
        try {
          const resolved = await fsp.stat(full);
          type = resolved.isDirectory() ? 'dir' : 'file';
          size = resolved.size;
        } catch { type = 'link'; }
      }

      const attr = attrs ? attrs.get(name.toLowerCase()) : null;
      const readOnly = attr ? attr.readOnly : !(st.mode & 0o200);
      const hidden = attr ? (attr.hidden || attr.system) : name.startsWith('.');

      return entry({
        name,
        type,
        size,
        mtime: st.mtimeMs,
        rights: this.isWindows ? '' : rightsFromMode(st.mode),
        owner: this.isWindows ? '' : String(st.uid),
        group: this.isWindows ? '' : String(st.gid),
        linkTarget,
        isSymlink: st.isSymbolicLink(),
        hidden,
        readOnly,
        raw: { ino: st.ino, dev: st.dev, mode: st.mode, ctime: st.ctimeMs, atime: st.atimeMs, attributes: attr || null },
      });
    }));

    return rows.filter(Boolean);
  }

  /** "This PC": every drive letter that currently answers, with its free space. */
  async _listDrives() {
    const present = await Promise.all(DRIVE_LETTERS.map(async (letter) => {
      const root = letter + ':\\';
      try { await fsp.stat(root); } catch { return null; }
      let space = null;
      try { space = await this.spaceInfo(root); } catch { /* removable media without a disk */ }
      return entry({
        name: letter + ':',
        type: 'dir',
        size: 0,
        mtime: 0,
        raw: { drive: true, path: root, total: space ? space.total : 0, free: space ? space.free : 0 },
      });
    }));
    return present.filter(Boolean);
  }

  async stat(p) {
    const target = this.normalize(p);
    if (this.isVirtualRoot(target)) {
      return entry({ name: '', type: 'dir', raw: { virtualRoot: true } });
    }
    const st = await fsp.lstat(target);
    let type = typeOfStat(st);
    let size = st.size;
    let linkTarget = '';
    if (st.isSymbolicLink()) {
      try { linkTarget = await fsp.readlink(target); } catch { /* dangling */ }
      try {
        const resolved = await fsp.stat(target);
        type = resolved.isDirectory() ? 'dir' : 'file';
        size = resolved.size;
      } catch { type = 'link'; }
    }
    let hidden = this.basename(target).startsWith('.');
    let readOnly = !(st.mode & 0o200);
    if (this.isWindows) {
      const attrs = await windowsAttributes(this.dirname(target));
      const attr = attrs ? attrs.get(this.basename(target).toLowerCase()) : null;
      if (attr) { hidden = attr.hidden || attr.system; readOnly = attr.readOnly; }
    }
    return entry({
      name: this.basename(target),
      type,
      size,
      mtime: st.mtimeMs,
      rights: this.isWindows ? '' : rightsFromMode(st.mode),
      owner: this.isWindows ? '' : String(st.uid),
      group: this.isWindows ? '' : String(st.gid),
      linkTarget,
      isSymlink: st.isSymbolicLink(),
      hidden,
      readOnly,
      raw: { path: target, ino: st.ino, dev: st.dev, mode: st.mode, ctime: st.ctimeMs, atime: st.atimeMs },
    });
  }

  async realpath(p) {
    const target = this.normalize(p);
    if (this.isVirtualRoot(target)) return target;
    try { return this.normalize(await fsp.realpath(target)); } catch { return target; }
  }

  async readlink(p) { return fsp.readlink(this.normalize(p)); }

  async exists(p) {
    try { await fsp.lstat(this.normalize(p)); return true; } catch { return false; }
  }

  // ---- writing ---------------------------------------------------------
  async mkdir(p, opts = {}) {
    const target = this.normalize(p);
    await fsp.mkdir(target, { recursive: opts.recursive !== false });
    this._log('debug', `Created directory ${target}`);
    return target;
  }

  /**
   * Delete. `opts.toRecycleBin` asks for the Recycle Bin; when it is not
   * available the call fails rather than quietly deleting for good — a
   * permanent delete only happens when the caller passed
   * `allowPermanentFallback`, i.e. when the user was actually asked.
   */
  async remove(p, opts = {}) {
    const target = this.normalize(p);
    if (opts.toRecycleBin) {
      if (this._trash) {
        try {
          await this._trash.trashItem(nodePath.resolve(target));
          this._log('debug', `Moved ${target} to the Recycle Bin`);
          return;
        } catch (e) {
          if (!opts.allowPermanentFallback) {
            throw new Error(`"${target}" could not be moved to the Recycle Bin (${e.message}). Nothing was deleted.`);
          }
          this._log('warn', `Recycle Bin refused ${target}; deleting permanently as requested`);
        }
      } else if (!opts.allowPermanentFallback) {
        throw new Error('The Recycle Bin is not available in this process. Nothing was deleted.');
      }
    }

    const st = await fsp.lstat(target);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (opts.recursive) await fsp.rm(target, { recursive: true, force: true });
      else await fsp.rmdir(target);
    } else {
      await fsp.unlink(target);
    }
    this._log('debug', `Deleted ${target}`);
  }

  async rename(from, to, opts = {}) {
    const src = this.normalize(from);
    const dst = this.normalize(to);
    try {
      await fsp.rename(src, dst);
    } catch (e) {
      // A move between volumes is not a rename; copy-then-delete is what the
      // shell does, and what the user asked for.
      if (e.code !== 'EXDEV' || opts.noCrossDevice) throw e;
      this._log('debug', `${src} and ${dst} are on different volumes; copying`);
      await fsp.cp(src, dst, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
      const st = await fsp.lstat(src);
      if (st.isDirectory() && !st.isSymbolicLink()) await fsp.rm(src, { recursive: true, force: true });
      else await fsp.unlink(src);
    }
    this._log('debug', `Renamed ${src} to ${dst}`);
    return dst;
  }

  /** Windows refuses symbolic links without Developer Mode or elevation, so a
   *  directory link falls back to a junction, which needs neither. */
  async symlink(target, linkPath, type) {
    const link = this.normalize(linkPath);
    const wantsDir = type === 'dir' || type === 'junction';
    if (!this.isWindows) {
      await fsp.symlink(target, link);
      return { kind: 'symlink' };
    }
    const absoluteTarget = nodePath.isAbsolute(target)
      ? target
      : nodePath.resolve(nodePath.dirname(link), target);
    let isDir = wantsDir;
    if (!wantsDir) {
      try { isDir = (await fsp.stat(absoluteTarget)).isDirectory(); } catch { isDir = false; }
    }
    try {
      await fsp.symlink(target, link, isDir ? 'dir' : 'file');
      return { kind: 'symlink' };
    } catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EACCES') && isDir) {
        await fsp.symlink(absoluteTarget, link, 'junction');
        this._log('warn', `Created a junction for ${link}; symbolic links need Developer Mode or elevation`);
        return { kind: 'junction' };
      }
      throw e;
    }
  }

  async hardlink(existing, linkPath) {
    await fsp.link(this.normalize(existing), this.normalize(linkPath));
  }

  /** chmod. On Windows only the write bit survives — it is the read-only flag. */
  async setRights(p, rights) {
    const mode = typeof rights === 'number' ? rights : parseRights(rights);
    if (mode === null) throw new Error(`"${rights}" is not a permission string or mode`);
    await fsp.chmod(this.normalize(p), mode);
  }

  async setOwner(p, uid, gid) {
    if (this.isWindows) throw new Error('Windows has no POSIX owner to set');
    await fsp.chown(this.normalize(p), Number(uid), Number(gid));
  }

  /** Times are epoch milliseconds, matching entry().mtime. Both call shapes are
   *  accepted — see normalizeTimes(). */
  async setTimes(p, mtime, atime) {
    const t = normalizeTimes(mtime, atime);
    await fsp.utimes(this.normalize(p), new Date(t.atime), new Date(t.mtime));
  }

  // ---- streaming -------------------------------------------------------
  async createReadStream(p, opts = {}) {
    const target = this.normalize(p);
    const options = { flags: 'r' };
    if (Number(opts.start) > 0) options.start = Number(opts.start);
    if (Number.isFinite(opts.end)) options.end = Number(opts.end);
    if (opts.highWaterMark) options.highWaterMark = opts.highWaterMark;
    return fs.createReadStream(target, options);
  }

  /** `start > 0` resumes a partial transfer: 'r+' keeps the bytes already on
   *  disk instead of truncating them the way 'w' would. */
  async createWriteStream(p, opts = {}) {
    const target = this.normalize(p);
    const start = Number(opts.start) || 0;
    if (start > 0) {
      try { await fsp.access(target); } catch { await fsp.writeFile(target, ''); }
      return fs.createWriteStream(target, { flags: 'r+', start });
    }
    return fs.createWriteStream(target, {
      flags: opts.append ? 'a' : 'w',
      mode: opts.mode === undefined ? 0o666 : opts.mode,
    });
  }

  // ---- optional --------------------------------------------------------
  async checksum(p, algorithm = 'sha256') {
    const alg = String(algorithm).toLowerCase().replace(/^sha-/, 'sha');
    const hash = crypto.createHash(alg);
    const rs = fs.createReadStream(this.normalize(p));
    for await (const chunk of rs) hash.update(chunk);
    return hash.digest('hex');
  }

  /** Free/total for the volume holding `p`. */
  async spaceInfo(p) {
    if (typeof fsp.statfs !== 'function') return null;
    let target = this.normalize(p || this.home);
    if (this.isVirtualRoot(target)) target = this.normalize(this.home);
    const probe = this.isWindows ? (this.p.rootOf(target) || target) : target;
    const st = await fsp.statfs(probe);
    const block = Number(st.bsize);
    const total = Number(st.blocks) * block;
    const free = Number(st.bavail) * block;
    return {
      path: probe,
      total,
      free,
      used: total - Number(st.bfree) * block,
      blockSize: block,
    };
  }
}

/**
 * Normalize the two shapes a caller can hand `setTimes()`.
 *
 * The IPC layer calls it positionally — `setTimes(path, mtime, atime)` — while
 * the transfer queue and the synchronizer call it with an object, because that
 * is what "preserve timestamps" needs to pass around. Understanding only one of
 * them does not fail loudly here: `new Date(Number({mtime}))` is an Invalid
 * Date, which `utimes` accepts, so a downloaded file quietly gets a nonsense
 * timestamp and a synchronized tree never converges.
 *
 * Deliberately duplicated from sftp.js rather than imported: the local panel
 * must not drag the SSH stack in behind it.
 */
function normalizeTimes(mtime, atime) {
  const ms = (v) => (v instanceof Date ? v.getTime() : Number(v));
  const isObject = mtime !== null && typeof mtime === 'object' && !(mtime instanceof Date);
  const m = ms(isObject ? mtime.mtime : mtime);
  const rawA = isObject ? mtime.atime : atime;
  const a = rawA === undefined || rawA === null ? m : ms(rawA);
  if (!Number.isFinite(m)) {
    throw new Error('setTimes() needs a modification time in epoch milliseconds');
  }
  return { mtime: m, atime: Number.isFinite(a) ? a : m };
}

/** 'rwxr-xr-x' or '0644' or '644' to a numeric mode. */
function parseRights(rights) {
  const s = String(rights || '').trim();
  if (/^0?[0-7]{3,4}$/.test(s)) return parseInt(s, 8);
  if (!/^[-rwxsStT]{9}$/.test(s)) return null;
  let mode = 0;
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1];
  for (let i = 0; i < 9; i++) if (s[i] !== '-') mode |= bits[i];
  if (s[2] === 's' || s[2] === 'S') { mode |= 0o4000; if (s[2] === 'S') mode &= ~0o100; }
  if (s[5] === 's' || s[5] === 'S') { mode |= 0o2000; if (s[5] === 'S') mode &= ~0o10; }
  if (s[8] === 't' || s[8] === 'T') { mode |= 0o1000; if (s[8] === 'T') mode &= ~0o1; }
  return mode;
}

module.exports = {
  LocalAdapter,
  winPath,
  posixPath,
  helpersFor,
  parseRights,
  rightsFromMode,
  normalizeTimes,
};
