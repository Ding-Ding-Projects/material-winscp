// base.js — the contract every file-system backend implements.
//
// The panels, the queue and the synchronizer only ever talk to this interface,
// so adding a protocol never touches the UI. Anything a protocol genuinely
// cannot do reports `false` in `caps` rather than throwing at the call site —
// the UI greys the command out instead of offering an action that will fail.
'use strict';
const { EventEmitter } = require('events');

/** A directory entry, normalized across every protocol. */
function entry(o) {
  return {
    name: o.name,
    type: o.type || 'file',          // file | dir | link | special
    size: o.size || 0,
    mtime: o.mtime || 0,             // epoch ms
    rights: o.rights || '',          // 'rwxr-xr-x'
    owner: o.owner || '',
    group: o.group || '',
    linkTarget: o.linkTarget || '',
    isSymlink: !!o.isSymlink,
    hidden: !!o.hidden || (o.name || '').startsWith('.'),
    readOnly: !!o.readOnly,
    raw: o.raw || null,
  };
}

const DEFAULT_CAPS = {
  rights: false,          // chmod / permission column
  owner: false,           // chown / owner+group columns
  symlink: false,         // create and resolve symbolic links
  hardlink: false,
  exec: false,            // remote shell command execution
  resume: false,          // restartable transfers
  timestamp: false,       // preserve modification time
  recycleBin: false,
  checksum: false,
  find: true,             // recursive search (client-side walk otherwise)
  rename: true,
  move: true,
  copyRemote: false,      // server-side duplicate without a round trip
  calculateSize: true,
  nativeMove: true,
  hiddenFiles: true,
  spaceInfo: false,
};

class Adapter extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.caps = { ...DEFAULT_CAPS };
    this.connected = false;
    this.home = '/';
    this.serverInfo = {};
  }

  /** Human-readable protocol name, shown in the UI and the log. */
  get protocolName() { return 'unknown'; }

  /** Path helpers — overridden by the local backend for Windows separators. */
  get sep() { return '/'; }

  join(...parts) {
    const joined = parts.filter((p) => p !== '' && p !== null && p !== undefined).join('/');
    return this.normalize(joined);
  }

  normalize(p) {
    if (!p) return '/';
    const abs = p.startsWith('/');
    const out = [];
    for (const seg of p.split(/[\\/]+/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/') || '/';
  }

  dirname(p) {
    const n = this.normalize(p);
    if (n === '/') return '/';
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  }

  basename(p) {
    const n = this.normalize(p);
    const i = n.lastIndexOf('/');
    return i < 0 ? n : n.slice(i + 1);
  }

  // ---- lifecycle -------------------------------------------------------
  async connect() { throw new Error('connect() not implemented'); }
  async disconnect() { this.connected = false; }

  // ---- reading ---------------------------------------------------------
  async list() { throw new Error('list() not implemented'); }
  async stat() { throw new Error('stat() not implemented'); }
  async realpath(p) { return this.normalize(p); }
  async readlink() { throw new Error('readlink() not supported'); }

  // ---- writing ---------------------------------------------------------
  async mkdir() { throw new Error('mkdir() not implemented'); }
  async remove() { throw new Error('remove() not implemented'); }
  async rename() { throw new Error('rename() not implemented'); }
  async symlink() { throw new Error('symlink() not supported'); }
  async setRights() { throw new Error('setRights() not supported'); }
  async setOwner() { throw new Error('setOwner() not supported'); }
  async setTimes() { throw new Error('setTimes() not supported'); }

  // ---- streaming -------------------------------------------------------
  async createReadStream() { throw new Error('createReadStream() not implemented'); }
  async createWriteStream() { throw new Error('createWriteStream() not implemented'); }

  /** Whole-file helpers, used by the editor for small files. */
  async readFile(p) {
    const chunks = [];
    const rs = await this.createReadStream(p);
    for await (const c of rs) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async writeFile(p, buf) {
    const ws = await this.createWriteStream(p, { size: buf.length });
    await new Promise((res, rej) => {
      ws.on('error', rej);
      ws.on('close', res);
      ws.on('finish', res);
      ws.end(buf);
    });
  }

  // ---- optional --------------------------------------------------------
  async exec() { throw new Error('exec() not supported by this protocol'); }
  async checksum() { throw new Error('checksum() not supported by this protocol'); }
  async spaceInfo() { return null; }

  /** Recursive size, used by "Calculate directory sizes". */
  async calculateSize(dir, onProgress, signal) {
    let bytes = 0; let files = 0; let dirs = 0;
    const walk = async (p) => {
      if (signal && signal.aborted) throw new Error('Aborted');
      let items;
      try { items = await this.list(p); } catch { return; }
      for (const it of items) {
        if (it.name === '.' || it.name === '..') continue;
        if (it.type === 'dir') { dirs++; await walk(this.join(p, it.name)); }
        else { files++; bytes += it.size; }
        if (onProgress) onProgress({ bytes, files, dirs });
      }
    };
    await walk(dir);
    return { bytes, files, dirs };
  }
}

module.exports = { Adapter, entry, DEFAULT_CAPS };
