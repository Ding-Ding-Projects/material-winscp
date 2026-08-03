// queue.test.js — real transfers between two in-memory adapters.
//
// Nothing here is simulated: the queue opens streams on one Adapter, writes
// them to another, and every assertion reads the bytes that actually landed.
// The fake adapters implement the base.js contract (list/stat/mkdir/rename/
// remove/setTimes/createReadStream/createWriteStream) including ranged reads
// and positioned writes, which is what lets resume and the parallel-chunk path
// be exercised for real.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('stream');

const { Adapter, entry, DEFAULT_CAPS } = require('../design/main/protocols/base');
const { TransferQueue, Throttle, TextConverter, validLocalFileName, changeFileName,
  allowResume, isConnectionError } = require('../design/main/queue');
const { PREF_DEFAULTS } = require('../design/main/defaults');
// The foreground engine's own half of the reconnect-budget decision, so the two
// transfer paths can be asserted to agree rather than assumed to.
const { TransferEngine, TRANSFER_FLAGS, limitsTransferReconnects } = require('../design/main/transfer');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Poll until `fn()` is truthy. Used instead of fixed sleeps around timing. */
async function waitFor(fn, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(4);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// an in-memory Adapter
// ---------------------------------------------------------------------------

class MemoryAdapter extends Adapter {
  constructor(name, options = {}) {
    super(null);
    this.name = name;
    this.caps = { ...DEFAULT_CAPS, resume: true, timestamp: true, rights: true };
    this.connected = true;
    // Keyed by `this.sep` rather than by a literal '/', so the Windows-shaped
    // subclass below shares every one of these methods unchanged.
    this.files = new Map([[this.sep, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }]]);
    this.chunkSize = options.chunkSize || 4096;
    this.readDelayMs = options.readDelayMs || 0;
    this.failRead = null;     // { path, afterBytes } — fires once
    this.reads = [];          // every createReadStream call, for assertions
    this.writes = [];
  }

  get protocolName() { return this.name; }

  put(p, contents, mtime = 1000000, extra) {
    const np = this.normalize(p);
    this._ensureParents(np);
    this.files.set(np, {
      type: 'file',
      data: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
      mtime,
      rights: 'rw-r--r--',
      ...(extra || {}),
    });
    return np;
  }

  putDir(p, mtime = 1000000) {
    const np = this.normalize(p);
    this._ensureParents(np);
    if (!this.files.has(np)) this.files.set(np, { type: 'dir', mtime, rights: 'rwxr-xr-x' });
    return np;
  }

  read(p) {
    const rec = this.files.get(this.normalize(p));
    return rec && rec.type === 'file' ? rec.data : null;
  }

  _ensureParents(np) {
    const parts = np.split(this.sep).filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `${this.sep}${parts[i]}`;
      if (!this.files.has(cur)) this.files.set(cur, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
    }
  }

  async list(dir) {
    const d = this.normalize(dir);
    const rec = this.files.get(d);
    if (!rec) { const e = new Error(`No such directory: ${d}`); e.code = 'ENOENT'; throw e; }
    if (rec.type !== 'dir') throw new Error(`Not a directory: ${d}`);
    const prefix = d === this.sep ? this.sep : `${d}${this.sep}`;
    const out = [];
    for (const [p, r] of this.files) {
      if (p === d || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes(this.sep)) continue;
      out.push(entry({
        name: rest,
        type: r.type,
        size: r.type === 'dir' ? 0 : r.data.length,
        mtime: r.mtime,
        rights: r.rights,
        // Every real Adapter fills `owner` — sftp.js with String(uid), ftp.js
        // with UNIX.ownername — and the resume path reads it. Dropping it here
        // meant the queue's ownership guard could never fire in a test.
        owner: r.owner || '',
        isSymlink: !!r.isSymlink,
        hidden: rest.startsWith('.'),
      }));
    }
    return out;
  }

  async stat(p) {
    const np = this.normalize(p);
    const r = this.files.get(np);
    if (!r) { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    return entry({
      name: this.basename(np),
      type: r.type,
      size: r.type === 'dir' ? 0 : r.data.length,
      mtime: r.mtime,
      rights: r.rights,
      owner: r.owner || '',
      isSymlink: !!r.isSymlink,
    });
  }

  async mkdir(p) {
    const np = this.normalize(p);
    if (this.files.has(np)) { const e = new Error(`Already exists: ${np}`); e.code = 'EEXIST'; throw e; }
    const parent = this.dirname(np);
    if (!this.files.has(parent)) { const e = new Error(`No such directory: ${parent}`); e.code = 'ENOENT'; throw e; }
    this.files.set(np, { type: 'dir', mtime: Date.now(), rights: 'rwxr-xr-x' });
  }

  async remove(p, opts = {}) {
    const np = this.normalize(p);
    const r = this.files.get(np);
    if (!r) { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    if (r.type === 'dir' && opts.recursive) {
      for (const k of [...this.files.keys()]) {
        if (k === np || k.startsWith(`${np}${this.sep}`)) this.files.delete(k);
      }
    } else {
      this.files.delete(np);
    }
  }

  async rename(from, to) {
    const a = this.normalize(from);
    const b = this.normalize(to);
    const r = this.files.get(a);
    if (!r) { const e = new Error(`No such file: ${a}`); e.code = 'ENOENT'; throw e; }
    this.files.delete(a);
    this.files.set(b, r);
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(`${a}${this.sep}`)) {
        this.files.set(b + k.slice(a.length), this.files.get(k));
        this.files.delete(k);
      }
    }
  }

  async setTimes(p, times) {
    const r = this.files.get(this.normalize(p));
    if (!r) throw new Error(`No such file: ${p}`);
    r.mtime = times.mtime;
  }

  async setRights(p, rights) {
    const r = this.files.get(this.normalize(p));
    if (!r) throw new Error(`No such file: ${p}`);
    r.rights = rights;
  }

  async createReadStream(p, opts = {}) {
    const np = this.normalize(p);
    const rec = this.files.get(np);
    if (!rec || rec.type !== 'file') { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    const start = opts.start || 0;
    const end = opts.end === undefined ? rec.data.length - 1 : opts.end;
    this.reads.push({ path: np, start, end });
    if (this.promptOnRead) {
      // A real backend asks for a passphrase in the middle of a transfer; the
      // queue must carry the question out and the answer back.
      const request = this.promptOnRead;
      this.promptOnRead = null;
      this.promptAnswer = await new Promise((resolve) => this.emit('prompt', request, resolve));
    }
    const data = rec.data.subarray(start, end + 1);
    const chunkSize = this.chunkSize;
    const delay = this.readDelayMs;
    const self = this;
    let sent = 0;
    async function* gen() {
      let off = 0;
      while (off < data.length) {
        if (delay) await sleep(delay);
        const fail = self.failRead;
        if (fail && fail.path === np && sent >= fail.afterBytes) {
          self.failRead = null;             // a dropped connection happens once
          const e = new Error('Connection lost while reading');
          e.code = 'ECONNRESET';
          throw e;
        }
        const c = Buffer.from(data.subarray(off, off + chunkSize));
        off += c.length;
        sent += c.length;
        yield c;
      }
    }
    return Readable.from(gen());
  }

  async createWriteStream(p, opts = {}) {
    const np = this.normalize(p);
    const parent = this.dirname(np);
    if (!this.files.has(parent)) { const e = new Error(`No such directory: ${parent}`); e.code = 'ENOENT'; throw e; }
    const start = opts.start || 0;
    this.writes.push({ path: np, start });
    const self = this;
    if (start === 0 && !opts.append) {
      // 'w' truncates, exactly like a real open()
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    } else if (!self.files.has(np)) {
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    }
    let pos = start;
    return new Writable({
      write(chunk, enc, cb) {
        // Commit every chunk immediately: a real file keeps the bytes written
        // before a connection dropped, and resume depends on exactly that.
        const rec = self.files.get(np);
        let data = rec.data;
        if (pos > data.length) data = Buffer.concat([data, Buffer.alloc(pos - data.length)]);
        const head = data.subarray(0, pos);
        const tailStart = pos + chunk.length;
        const tail = data.length > tailStart ? data.subarray(tailStart) : Buffer.alloc(0);
        rec.data = Buffer.concat([head, Buffer.from(chunk), tail]);
        rec.mtime = Date.now();
        pos += chunk.length;
        cb();
      },
    });
  }
}

/**
 * The same store, separated by '\' — i.e. shaped like protocols/local.js on
 * Windows (winPath.sep at local.js:66, surfaced through LocalAdapter's
 * `get sep()` at local.js:239).
 *
 * This exists because the queue's target adapter for a DOWNLOAD is the local
 * one, and a plan whose dstPaths are backslash-separated is the case that a
 * '/'-only prefix test gets silently and catastrophically wrong. Running that
 * case through an in-memory store rather than the real file system keeps the
 * coverage alive on a POSIX developer machine, where a real LocalAdapter
 * reports '/' and the bug simply cannot appear.
 */
class WindowsMemoryAdapter extends MemoryAdapter {
  get sep() { return '\\'; }

  normalize(p) {
    const s = String(p === undefined || p === null ? '' : p);
    const abs = s.startsWith('\\');
    const segs = s.split('\\').filter((seg) => seg && seg !== '.');
    return `${abs ? '\\' : ''}${segs.join('\\')}` || '\\';
  }

  join(...parts) {
    return this.normalize(parts.filter((p) => p !== '' && p !== null && p !== undefined).join('\\'));
  }

  dirname(p) {
    const n = this.normalize(p);
    const i = n.lastIndexOf('\\');
    return i <= 0 ? '\\' : n.slice(0, i);
  }

  basename(p) {
    const n = this.normalize(p);
    const i = n.lastIndexOf('\\');
    return i < 0 ? n : n.slice(i + 1);
  }
}

function makePair(options) {
  const local = new MemoryAdapter('local', options);
  const remote = new MemoryAdapter('remote', options);
  local.putDir('/l');
  remote.putDir('/r');
  return { local, remote };
}

/** A download pair whose LOCAL side separates with '\', as Windows does. */
function makeWindowsPair(options) {
  const local = new WindowsMemoryAdapter('local', options);
  const remote = new MemoryAdapter('remote', options);
  local.putDir('\\l');
  remote.putDir('/r');
  return { local, remote };
}

function prefs(overrides = {}) {
  const p = JSON.parse(JSON.stringify(PREF_DEFAULTS));
  Object.assign(p.queue, overrides.queue || {});
  delete overrides.queue;
  return Object.assign(p, overrides);
}

function bigBuffer(n, seed = 0) {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xFF;
  return b;
}

// ---------------------------------------------------------------------------

test('a single file upload lands byte for byte', async () => {
  const { local, remote } = makePair();
  const payload = bigBuffer(50000);
  local.put('/l/a.bin', payload, 1700000000000);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/a.bin',
    target: '/r/a.bin',
    sourceAdapter: local,
    targetAdapter: remote,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(remote.read('/r/a.bin').equals(payload), 'bytes must match exactly');
  assert.strictEqual(item.progress.bytes, payload.length);
  assert.strictEqual(item.progress.total, payload.length);
  assert.strictEqual(item.progress.filesDone, 1);
  assert.strictEqual(item.progress.filesTotal, 1);
  // preserveTime is on by default
  assert.strictEqual(remote.files.get('/r/a.bin').mtime, 1700000000000);
});

test('progress is reported while the transfer runs', async () => {
  const { local, remote } = makePair({ chunkSize: 1024 });
  local.put('/l/a.bin', bigBuffer(20000));

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const seen = [];
  q.on('progress', (p) => seen.push(p.progress.bytes));
  const done = [];
  q.on('item-done', (v) => done.push(v.id));

  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.ok(seen.length > 3, `expected several progress events, got ${seen.length}`);
  assert.ok(seen.some((b) => b > 0 && b < 20000), 'progress must be reported mid-flight');
  assert.strictEqual(seen[seen.length - 1], 20000);
  assert.deepStrictEqual(done, [item.id]);
  assert.ok(item.progress.cps > 0);
});

test('download applies invalid-character replacement and the case rule', async () => {
  const { local, remote } = makePair();
  remote.put('/r/Weird:Name?.TXT', Buffer.from('hi'));

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  q.add({
    side: 'download',
    source: '/r/Weird:Name?.TXT',
    target: '/l/',
    targetIsDir: true,
    sourceAdapter: remote,
    targetAdapter: local,
    copyParam: { fileNameCase: 'lower', transferMode: 'binary' },
  });
  await q.idle();

  assert.ok(local.read('/l/weird_name_.txt'), `got ${[...local.files.keys()].join(', ')}`);
});

test('queued downloads use reserved-name-safe local naming', async () => {
  const { local, remote } = makeWindowsPair();
  remote.put('/r/CON', 'device-safe');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'download', source: '/r/CON', target: '\\l\\', targetIsDir: true,
    sourceAdapter: remote, targetAdapter: local,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(local.read('\\l\\CON%00').toString(), 'device-safe');
});

test('recursive directory upload, correct ordering and mask filtering', async () => {
  const { local, remote } = makePair();
  local.put('/l/tree/a.txt', 'a');
  local.put('/l/tree/b.log', 'b');
  local.put('/l/tree/sub/c.txt', 'c');
  local.put('/l/tree/sub/deep/d.txt', 'd');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/tree',
    target: '/r/tree',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { includeFileMask: '*.txt' },
  });
  await q.idle();
  assert.strictEqual(item.state, 'done', item.error && item.error.message);

  assert.strictEqual(remote.read('/r/tree/a.txt').toString(), 'a');
  assert.strictEqual(remote.read('/r/tree/sub/c.txt').toString(), 'c');
  assert.strictEqual(remote.read('/r/tree/sub/deep/d.txt').toString(), 'd');
  assert.strictEqual(remote.read('/r/tree/b.log'), null, '*.log is filtered out');

  // A directory entry always precedes anything inside it.
  const order = item._plan.entries.map((e) => `${e.kind}:${e.dstPath}`);
  const dirAt = order.indexOf('dir:/r/tree/sub');
  const fileAt = order.indexOf('file:/r/tree/sub/c.txt');
  assert.ok(dirAt >= 0 && fileAt > dirAt, order.join(' | '));
  // Files of a directory come before its subdirectories.
  assert.ok(order.indexOf('file:/r/tree/a.txt') < order.indexOf('dir:/r/tree/sub'));
});

test('a directly selected file obeys the include mask like the foreground path', async () => {
  const { local, remote } = makePair();
  local.put('/l/notes.log', 'do not send');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/notes.log',
    target: '/r/notes.log',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { includeFileMask: '*.txt' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(item._plan.files, 0, 'the masked root file is not planned');
  assert.strictEqual(remote.read('/r/notes.log'), null, 'the masked root file is not transferred');
});

// ---------------------------------------------------------------------------
// excludeEmptyDirectories (cpNoEmptyDirectories)
// ---------------------------------------------------------------------------

test('excludeEmptyDirectories prunes the empty directories and keeps the rest', async () => {
  const { local, remote } = makePair();
  local.put('/l/tree/full/a.txt', 'a');
  local.put('/l/tree/full/deeper/b.txt', 'b');
  local.putDir('/l/tree/empty');
  local.putDir('/l/tree/empty/alsoempty');   // nested empties are empty all the way up
  local.putDir('/l/tree/bc');                // '/r/tree/b' must not claim this one

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/tree',
    target: '/r/tree',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { excludeEmptyDirectories: true },
  });
  await q.idle();
  assert.strictEqual(item.state, 'done', item.error && item.error.message);

  const dirs = item._plan.entries.filter((e) => e.kind === 'dir').map((e) => e.dstPath).sort();
  assert.deepStrictEqual(dirs, ['/r/tree', '/r/tree/full', '/r/tree/full/deeper']);
  assert.strictEqual(remote.read('/r/tree/full/a.txt').toString(), 'a');
  assert.strictEqual(remote.read('/r/tree/full/deeper/b.txt').toString(), 'b');
  assert.ok(!remote.files.has('/r/tree/empty'), 'an empty directory is not created');
  assert.ok(!remote.files.has('/r/tree/empty/alsoempty'));
  assert.ok(!remote.files.has('/r/tree/bc'));
});

test('a queued upload descends into a local directory symlink like the engine', async () => {
  // DirectorySource recurses into local directory symlinks even when the
  // remote-session follow setting is false. The queue used to skip the child
  // before its structural empty-directory prune, so its plan disagreed with
  // transfer.js and could drop the whole upload tree.
  const { local, remote } = makePair();
  local.putDir('/l/tree/linky');
  Object.assign(local.files.get('/l/tree/linky'), { isSymlink: true });
  local.put('/l/tree/linky/b.txt', 'b');
  remote.putDir('/r');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/tree',
    target: '/r/tree',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { excludeEmptyDirectories: true, followDirectorySymlinks: false },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(remote.read('/r/tree/linky/b.txt').toString(), 'b');
  assert.deepStrictEqual(
    item._plan.entries.filter((e) => e.kind === 'dir').map((e) => e.dstPath),
    ['/r/tree', '/r/tree/linky']);
});

test('excludeEmptyDirectories does not destroy a download to a Windows target', async () => {
  // queue.js:_buildPlan used to prune with a hard-coded '/' — `startsWith(dir +
  // '/')`. Every dstPath of a download is built by the LOCAL adapter's join,
  // which separates with '\' on Windows, so the test was false for EVERY
  // directory including ones stuffed with files. Since _run only mkdirs from
  // kind:'dir' entries and no adapter's createWriteStream creates parents, the
  // pruning took the whole tree with it and the first file died with ENOENT.
  const { local, remote } = makeWindowsPair();
  remote.put('/r/tree/full/a.txt', 'a');
  remote.put('/r/tree/full/deeper/b.txt', 'b');
  remote.putDir('/r/tree/empty');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'download',
    source: '/r/tree',
    target: '\\l\\tree',
    sourceAdapter: remote,
    targetAdapter: local,
    copyParam: { excludeEmptyDirectories: true },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  const dirs = item._plan.entries.filter((e) => e.kind === 'dir').map((e) => e.dstPath).sort();
  assert.deepStrictEqual(dirs, ['\\l\\tree', '\\l\\tree\\full', '\\l\\tree\\full\\deeper'],
    'the directories that hold files survive the prune');
  assert.strictEqual(local.read('\\l\\tree\\full\\a.txt').toString(), 'a');
  assert.strictEqual(local.read('\\l\\tree\\full\\deeper\\b.txt').toString(), 'b');
  assert.ok(!local.files.has('\\l\\tree\\empty'), 'the empty one is still pruned');
  assert.strictEqual(item.progress.filesDone, 2);
});

test('a Windows-separated download tree is unaffected when the option is off', async () => {
  // The control: without excludeEmptyDirectories the prune never runs, so this
  // passes with or without the fix and proves the fixture itself is sound —
  // any failure above is the predicate, not the backslash adapter.
  const { local, remote } = makeWindowsPair();
  remote.put('/r/tree/full/a.txt', 'a');
  remote.putDir('/r/tree/empty');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'download',
    source: '/r/tree',
    target: '\\l\\tree',
    sourceAdapter: remote,
    targetAdapter: local,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(local.read('\\l\\tree\\full\\a.txt').toString(), 'a');
  assert.ok(local.files.has('\\l\\tree\\empty'), 'without the option the empty directory is created');
});

test('an upload prunes a local directory holding only .filepart leftovers', async () => {
  // IsEmptyLocalDirectory hard-codes DisallowTemporaryTransferFiles=true for
  // its child predicate (Terminal.cpp:6199), so a half-finished download of
  // ours is not content. transfer.js's engine has honoured that since
  // isEmptyDirectory landed; _buildPlan pruned purely structurally, so the
  // same tree kept the directory here and dropped it there — one option, two
  // collectors, and whichever engine happened to run decided the answer.
  const { local, remote } = makePair();
  local.put('/l/tree/full/a.txt', 'a');
  local.put('/l/tree/leftovers/report.filepart', 'partial');
  local.put('/l/tree/numbered/report.filepart.2', 'partial');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/tree',
    target: '/r/tree',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { excludeEmptyDirectories: true },
  });
  await q.idle();
  assert.strictEqual(item.state, 'done', item.error && item.error.message);

  const dirs = item._plan.entries.filter((e) => e.kind === 'dir').map((e) => e.dstPath).sort();
  assert.deepStrictEqual(dirs, ['/r/tree', '/r/tree/full']);
  assert.ok(!remote.files.has('/r/tree/leftovers'));
  assert.ok(!remote.files.has('/r/tree/numbered'),
    'GetPartialFileExtLen, so the disambiguated ".filepart.2" form counts too');
  // The leftovers go with the directory that was dropped: _run only mkdirs
  // from kind:'dir' entries, so an orphaned file entry would be an ENOENT.
  assert.ok(!remote.files.has('/r/tree/leftovers/report.filepart'));
  assert.strictEqual(item.progress.filesDone, 1);
  assert.strictEqual(item._plan.files, 1, 'the announced totals describe the plan that ran');
  assert.strictEqual(item._plan.bytes, 1);
});

test('a .filepart beside a real file is still uploaded', async () => {
  // Only the emptiness question ignores temporaries. DoAllowLocalFileTransfer
  // disallows them solely when the caller asks, and the copy path never does,
  // so a leftover in a directory that survives goes up like anything else.
  const { local, remote } = makePair();
  local.put('/l/tree/full/a.txt', 'a');
  local.put('/l/tree/full/report.filepart', 'partial');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload',
    source: '/l/tree',
    target: '/r/tree',
    sourceAdapter: local,
    targetAdapter: remote,
    copyParam: { excludeEmptyDirectories: true },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(remote.read('/r/tree/full/report.filepart').toString(), 'partial');
});

test('a download does NOT treat a remote directory of .filepart leftovers as empty', async () => {
  // The asymmetry is the original's, not an oversight: IsEmptyRemoteDirectory
  // passes the caller's flag through (Terminal.cpp:6441) and the copy path
  // never sets it. Hardening the remote side would make this port skip a
  // directory WinSCP downloads.
  const { local, remote } = makePair();
  remote.put('/r/tree/leftovers/report.filepart', 'partial');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'download',
    source: '/r/tree',
    target: '/l/tree',
    sourceAdapter: remote,
    targetAdapter: local,
    copyParam: { excludeEmptyDirectories: true },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(local.read('/l/tree/leftovers/report.filepart').toString(), 'partial');
});

test('pause and resume of a single item', async () => {
  const { local, remote } = makePair({ chunkSize: 1024, readDelayMs: 10 });
  const payload = bigBuffer(20480);          // 20 chunks * 10ms
  local.put('/l/a.bin', payload);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });

  await waitFor(() => item.progress.bytes > 0, 4000, 'the first bytes to move');
  q.pauseItem(item.id);
  await sleep(60);
  assert.strictEqual(item.state, 'paused');
  const frozen = item.progress.bytes;
  assert.ok(frozen > 0 && frozen < payload.length, `frozen at ${frozen}`);
  await sleep(60);
  assert.strictEqual(item.progress.bytes, frozen, 'a paused item transfers nothing');

  q.resumeItem(item.id);
  await q.idle();
  assert.strictEqual(item.state, 'done');
  assert.ok(remote.read('/r/a.bin').equals(payload));
});

test('global pause stops every running item', async () => {
  const { local, remote } = makePair({ chunkSize: 512, readDelayMs: 8 });
  local.put('/l/a.bin', bigBuffer(8192));
  local.put('/l/b.bin', bigBuffer(8192, 7));

  const q = new TransferQueue({ prefs: prefs({ queue: { transfersLimit: 2 } }), progressMs: 0 });
  const a = q.add({ side: 'upload', source: '/l/a.bin', target: '/r/a.bin', sourceAdapter: local, targetAdapter: remote });
  const b = q.add({ side: 'upload', source: '/l/b.bin', target: '/r/b.bin', sourceAdapter: local, targetAdapter: remote });

  await waitFor(() => a.progress.bytes > 0 && b.progress.bytes > 0, 4000, 'both items to start');
  q.pauseAll();
  await sleep(50);
  assert.strictEqual(a.state, 'paused');
  assert.strictEqual(b.state, 'paused');
  const frozen = [a.progress.bytes, b.progress.bytes];
  await sleep(50);
  assert.deepStrictEqual([a.progress.bytes, b.progress.bytes], frozen);

  q.resumeAll();
  await q.idle();
  assert.strictEqual(a.state, 'done');
  assert.strictEqual(b.state, 'done');
});

test('the speed limit really throttles', async () => {
  const { local, remote } = makePair({ chunkSize: 2048 });
  const payload = bigBuffer(20000);
  local.put('/l/fast.bin', payload);
  local.put('/l/slow.bin', payload);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });

  const t0 = Date.now();
  q.add({ side: 'upload', source: '/l/fast.bin', target: '/r/fast.bin', sourceAdapter: local, targetAdapter: remote });
  await q.idle();
  const unthrottled = Date.now() - t0;

  const t1 = Date.now();
  const slow = q.add({
    side: 'upload', source: '/l/slow.bin', target: '/r/slow.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { cpsLimit: 20000 },        // 20000 bytes at 20000 B/s ~= 1s
  });
  await q.idle();
  const throttled = Date.now() - t1;

  assert.strictEqual(slow.state, 'done');
  assert.ok(remote.read('/r/slow.bin').equals(payload));
  assert.ok(throttled >= 700, `throttled transfer took only ${throttled}ms`);
  assert.ok(unthrottled < 400, `unthrottled transfer took ${unthrottled}ms`);
  assert.ok(throttled > unthrottled * 2, `${throttled}ms vs ${unthrottled}ms`);
});

test('the shared byte mover honors copyParam speed limits without a queue item', async () => {
  const { local, remote } = makePair({ chunkSize: 1024 });
  const payload = bigBuffer(8192);
  local.put('/l/foreground.bin', payload);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const started = Date.now();
  const copied = await q.moveBytes({
    sourceAdapter: local,
    targetAdapter: remote,
    sourcePath: '/l/foreground.bin',
    targetPath: '/r/foreground.bin',
    size: payload.length,
    // Session transfers arrive through the shared mover as a plan, not a
    // queue item; keep the string here because IPC callers can still be
    // form-shaped at this boundary.
    copyParam: { cpsLimit: String(payload.length) },
  });

  const elapsed = Date.now() - started;
  assert.strictEqual(copied, payload.length);
  assert.ok(elapsed >= 700, `foreground transfer ignored its limit: ${elapsed}ms`);
  assert.ok(remote.read('/r/foreground.bin').equals(payload));
});

test('setSpeedLimit changes the limit of an item already queued', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(4096));
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  const item = q.add({ side: 'upload', source: '/l/a.bin', target: '/r/a.bin', sourceAdapter: local, targetAdapter: remote });
  assert.strictEqual(q.setSpeedLimit(item.id, 12345), true);
  assert.strictEqual(item.cpsLimit, 12345);
  assert.strictEqual(item._throttle.rate, 12345);
  q.setEnabled(true);
  await q.idle();
  assert.strictEqual(item.state, 'done');
});

test('setSpeedLimit canonicalizes headless values and updates the copy snapshot', () => {
  const { local, remote } = makePair();
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });

  assert.equal(q.setSpeedLimit(item.id, '2048'), true);
  assert.equal(item.cpsLimit, 2048);
  assert.equal(item.copyParam.cpsLimit, 2048);
  assert.equal(q.view(item).cpsLimit, 2048);

  q.setSpeedLimit(item.id, 'not-a-rate');
  assert.equal(item.cpsLimit, 0);
  assert.equal(item.copyParam.cpsLimit, 0);
});

test('queue replaces an unsafe partial-file suffix before planning a target', () => {
  const { local, remote } = makePair();
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { partialFileExt: '/outside' },
  });
  assert.equal(item.copyParam.partialFileExt, '.filepart');
});

test('queue canonicalizes headless cpsLimit values before exposing the item', () => {
  const { local, remote } = makePair();
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });

  const numeric = q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote, copyParam: { cpsLimit: '2048' },
  });
  assert.strictEqual(numeric.copyParam.cpsLimit, 2048);
  assert.strictEqual(numeric.cpsLimit, 2048);
  assert.strictEqual(q.view(numeric).cpsLimit, 2048);

  const invalid = q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/b.txt',
    sourceAdapter: local, targetAdapter: remote, copyParam: { cpsLimit: '-1' },
  });
  assert.strictEqual(invalid.copyParam.cpsLimit, 0);
  assert.strictEqual(invalid.cpsLimit, 0);
});

test('setSpeedLimit immediately replaces an active bucket schedule', async () => {
  const { local, remote } = makePair({ chunkSize: 1024 });
  local.put('/l/a.bin', bigBuffer(4096));
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { cpsLimit: 2000 },
  });

  await waitFor(() => item.progress.bytes > 0, 4000, 'the throttled transfer to start');
  const started = Date.now();
  assert.strictEqual(q.setSpeedLimit(item.id, 0), true);
  await q.idle();

  assert.ok(Date.now() - started < 1000, 'removing the limit must not wait on old token debt');
  assert.ok(remote.read('/r/a.bin').equals(local.read('/l/a.bin')));
});

test('resume continues from the partial file instead of restarting', async () => {
  const { local, remote } = makePair({ chunkSize: 4096 });
  const payload = bigBuffer(40960);
  local.put('/l/big.bin', payload);
  // A previous attempt left 16 KB in the .filepart
  remote.put('/r/big.bin.filepart', payload.subarray(0, 16384));

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  local.reads.length = 0;
  const item = q.add({
    side: 'upload', source: '/l/big.bin', target: '/r/big.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(remote.read('/r/big.bin').equals(payload), 'the finished file must be whole');
  assert.strictEqual(remote.read('/r/big.bin.filepart'), null, 'the partial is renamed away');
  assert.deepStrictEqual(local.reads.map((r) => r.start), [16384],
    'the source must be read from the resume offset, not from zero');
  assert.strictEqual(item.progress.bytes, payload.length);
});

test('an equal-sized partial is adopted without rereading the source', async () => {
  const { local, remote } = makePair({ chunkSize: 4096 });
  const payload = bigBuffer(40960, 7);
  local.put('/l/big.bin', payload);
  remote.put('/r/big.bin.filepart', payload);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  local.reads.length = 0;
  const item = q.add({
    side: 'upload', source: '/l/big.bin', target: '/r/big.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(remote.read('/r/big.bin').equals(payload));
  assert.strictEqual(remote.read('/r/big.bin.filepart'), null);
  assert.deepStrictEqual(local.reads.map((r) => r.start), [payload.length],
    'a complete part is finalized, not copied again from byte zero');
});

test('smart resume respects the threshold', () => {
  const cp = { resumeSupport: 'smart', resumeThreshold: 102400, partialFileExt: '.filepart' };
  assert.strictEqual(allowResume(cp, 200000, 'a.bin'), true);
  assert.strictEqual(allowResume(cp, 1000, 'a.bin'), false);
  assert.strictEqual(allowResume({ ...cp, resumeSupport: 'on' }, 1, 'a.bin'), true);
  assert.strictEqual(allowResume({ ...cp, resumeSupport: 'off' }, 1e9, 'a.bin'), false);
  // A name that would overflow the 255-character limit once the extension is
  // appended cannot use a partial file at all.
  assert.strictEqual(allowResume({ ...cp, resumeSupport: 'on' }, 1e9, 'x'.repeat(250)), false);
});

test('a dropped connection resumes the item rather than restarting it', async () => {
  const { local, remote } = makePair({ chunkSize: 4096 });
  const payload = bigBuffer(40960);
  local.put('/l/big.bin', payload);
  local.failRead = { path: '/l/big.bin', afterBytes: 12288 };

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const reconnects = [];
  q.on('reconnect', (e) => {
    reconnects.push({ attempt: e.attempt, message: e.error.message });
    e.retry();                       // the session manager says "link is back"
  });

  local.reads.length = 0;
  const item = q.add({
    side: 'upload', source: '/l/big.bin', target: '/r/big.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(reconnects.length, 1);
  assert.strictEqual(reconnects[0].attempt, 1);
  assert.ok(remote.read('/r/big.bin').equals(payload));
  const starts = local.reads.map((r) => r.start);
  assert.strictEqual(starts[0], 0);
  assert.ok(starts[1] > 0, `second attempt restarted from ${starts[1]} instead of resuming`);
  assert.strictEqual(starts.length, 2, 'exactly one retry');
});

test('a reconnect retry does not re-ask an overwrite already answered', async () => {
  const { local, remote } = makePair({ chunkSize: 4096 });
  const payload = bigBuffer(40960, 11);
  local.put('/l/big.bin', payload);
  remote.put('/r/big.bin', 'old target');
  local.failRead = { path: '/l/big.bin', afterBytes: 12288 };

  const q = new TransferQueue({
    prefs: prefs({ queue: { noConfirmations: false } }), progressMs: 0,
  });
  let queries = 0;
  q.on('query', (e) => { queries += 1; e.respond('overwrite'); });
  q.on('reconnect', (e) => e.retry());
  const item = q.add({
    side: 'upload', source: '/l/big.bin', target: '/r/big.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(queries, 1,
    'the reconnect must carry the original overwrite decision into the retry');
  assert.ok(remote.read('/r/big.bin').equals(payload));
});

// ---------------------------------------------------------------------------
// the reconnect budget — Ding-Ding-Projects/material-winscp#28
//
// The queue used to cap reconnects at a hard-coded 5 and never look at
// security.sessionReopenTimeout, so "Keep reconnecting for 20 minutes" bought
// five attempts on the path twelve of the sixteen transfer commands take (the
// four `queue: 'off'` *NonQueueAction commands go foreground instead).
// WinSCP has no such counter: TUploadQueueItem::DoTransferExecute calls
// TTerminal::CopyToRemote (Queue.cpp:2324), so a queued transfer walks into the
// same TRobustOperationLoop as a foreground one and gets the same budget.
//
// The helper below drives one download that keeps losing its connection, with
// an injected clock so a timeout can be tested without waiting for one.
// ---------------------------------------------------------------------------

/** A pair whose REMOTE end names itself as `remoteName`. */
function makeNamedPair(remoteName, options) {
  const local = new MemoryAdapter('local', options);
  const remote = new MemoryAdapter(remoteName, options);
  local.putDir('/l');
  remote.putDir('/r');
  return { local, remote };
}

function reopenPrefs(timeoutMs) {
  const p = prefs();
  p.security.sessionReopenTimeout = timeoutMs;
  return p;
}

/**
 * Download /r/big.bin, dropping the connection `drops` times.
 *
 * `afterBytes: 0` drops before a single byte moves, which is the case the
 * budget is actually about; a non-zero value lets bytes land first, which is
 * what restarts the window (Terminal.cpp:542-547).
 *
 * The clock only ever advances inside the reconnect handler, so elapsed time is
 * exactly `drops * clockStepMs` and nothing depends on how fast the suite runs.
 */
async function droppingDownload(opts) {
  const { local, remote } = makeNamedPair(opts.remoteName, { chunkSize: 4096 });
  const payload = bigBuffer(opts.size || 81920);
  remote.put('/r/big.bin', payload);

  let clock = 1000000;
  const q = new TransferQueue({
    prefs: reopenPrefs(opts.timeoutMs),
    progressMs: 0,
    now: () => clock,
  });

  const arm = () => { remote.failRead = { path: '/r/big.bin', afterBytes: opts.afterBytes }; };
  let armed = 1;
  arm();

  const reconnects = [];
  const expired = [];
  q.on('reconnect-expired', (e) => expired.push(e));
  q.on('reconnect', (e) => {
    reconnects.push(e.attempt);
    clock += opts.clockStepMs;
    if (armed < opts.drops) { arm(); armed += 1; }
    e.retry();
  });

  const item = q.add({
    side: 'download',
    source: '/r/big.bin',
    target: '/l/big.bin',
    sourceAdapter: remote,
    targetAdapter: local,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();
  return { q, item, reconnects, expired, local, remote, payload };
}

test('a zero reconnect timeout still means forever, on the queue too', async () => {
  // The shipped default (defaults.js:384). This is the configuration almost
  // everyone runs, so a budget that only behaves correctly with a non-zero
  // preference set has not been tested where it matters:
  // TTerminal::ContinueReopen returns true unconditionally at zero
  // (Terminal.cpp:2461-2463) and the queue must do exactly the same.
  assert.strictEqual(PREF_DEFAULTS.security.sessionReopenTimeout, 0,
    'this test is about the SHIPPED default; if that changed, so must the test');

  const { item, reconnects, expired, local, payload } = await droppingDownload({
    remoteName: 'ftp',            // the one protocol that HAS a budget
    timeoutMs: 0,
    drops: 7,                     // more than the 5 the old fixed cap allowed
    afterBytes: 0,                // and not one byte moves to earn a reset
    clockStepMs: 3600000,         // an hour between each, to prove time is irrelevant
  });

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(reconnects.length, 7, 'zero means no ceiling at all');
  assert.strictEqual(expired.length, 0);
  assert.ok(local.read('/l/big.bin').equals(payload), 'and the file still lands whole');
});

test('a non-zero reconnect timeout is what stops a queued transfer retrying', async () => {
  // TRobustOperationLoop::TryReopen's else-arm (Terminal.cpp:548-555): no bytes
  // moved, so ContinueReopen(FStart) decides, and once the window is spent the
  // operation is reported rather than retried.
  const { item, reconnects, expired } = await droppingDownload({
    remoteName: 'ftp',
    timeoutMs: 5000,
    drops: 7,                     // armed to keep dropping; the budget stops it first
    afterBytes: 0,
    clockStepMs: 6000,            // one step past the window
  });

  assert.strictEqual(item.state, 'error');
  assert.strictEqual(item.error.code, 'ECONNRESET');
  assert.strictEqual(reconnects.length, 1,
    'the first drop is inside the window; the second is past it');
  assert.strictEqual(expired.length, 1, 'and the giving-up is announced, not silent');
  assert.strictEqual(expired[0].timeoutMs, 5000);
  assert.ok(expired[0].elapsedMs >= 5000);
});

test('bytes that actually moved restart the queue\'s reconnect window', async () => {
  // The other arm of the same branch (Terminal.cpp:542-547): a transfer making
  // progress between drops is not the failure the ceiling exists to stop, so
  // the window starts again. Seven drops an hour apart, against a five-second
  // budget, must therefore all be granted.
  const { item, reconnects, expired, local, payload } = await droppingDownload({
    remoteName: 'ftp',
    timeoutMs: 5000,
    drops: 7,
    afterBytes: 8192,             // each attempt moves 8KB before dying
    clockStepMs: 3600000,
  });

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(reconnects.length, 7);
  assert.strictEqual(expired.length, 0, 'progress must not spend the budget');
  assert.ok(local.read('/l/big.bin').equals(payload));
});

test('the queue and the foreground engine agree on WHICH transfers get a budget', async () => {
  // Setting tfUseFileTransferAny is what IMPOSES the ceiling, and WinSCP sets it
  // in exactly two places — TFTPFileSystem::CopyToLocal and ::CopyToRemote
  // (FtpFileSystem.cpp:1585, :1682). Every other protocol reconnects
  // indefinitely, upstream and here. Both transfer paths must reach that verdict
  // through the same test, or a setting gets honoured on one and not the other,
  // which is the defect this whole change exists to stop repeating.
  const engineGivesBudget = (adapter) => (TransferEngine.prototype.downloadFlags.call({
    remote: adapter,
    limitedTransferReconnects: TransferEngine.prototype.limitedTransferReconnects,
  }) & TRANSFER_FLAGS.useFileTransferAny) !== 0;

  for (const [name, expected] of [['ftp', true], ['ftps', true], ['sftp', false],
    ['scp', false], ['webdav', false], ['s3', false]]) {
    const a = new MemoryAdapter(name);
    assert.strictEqual(limitsTransferReconnects(a), expected, `${name}: the shared test`);
    assert.strictEqual(engineGivesBudget(a), expected, `${name}: the foreground engine`);
  }
  // caps.limitTransferReconnects overrides the protocol name, both ways.
  const stubborn = new MemoryAdapter('sftp');
  stubborn.caps.limitTransferReconnects = true;
  assert.strictEqual(limitsTransferReconnects(stubborn), true);
  assert.strictEqual(engineGivesBudget(stubborn), true);
});

test('a queued SFTP transfer keeps reconnecting, exactly as the engine lets it', async () => {
  // The behavioural half of the agreement above, kept separate so it stands on
  // its own evidence. `downloadFlags()` gives SFTP no tfUseFileTransferAny, so
  // TRobustOperationLoop never reaches ContinueReopen for it; the same seven
  // drops that expired the FTP item must therefore all be granted here, no
  // matter how long the outage ran.
  const { item, reconnects, expired } = await droppingDownload({
    remoteName: 'sftp',
    timeoutMs: 5000,
    drops: 7,
    afterBytes: 0,
    clockStepMs: 3600000,
  });
  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(reconnects.length, 7, 'SFTP has no ceiling, exactly as upstream');
  assert.strictEqual(expired.length, 0);
});

// ---------------------------------------------------------------------------
// …and the budget has to be REACHABLE, not merely correct.
//
// queue.js reads listenerCount('reconnect') BEFORE emitting and skips its own
// unsupervised backoff when anything is listening, so a listener that neither
// retries nor fails is worse than no listener at all: the item then awaits a
// promise nothing in the process can settle. design/main/ipc.js used to forward
// `reconnect` through the same blanket loop as every other queue event, which
// dropped the live `retry`/`fail` callbacks into a structured clone —
// webContents.send throws on a function and `emit` swallows that as an
// undeliverable push — so the FIRST dropped connection parked a queued transfer
// for the life of the process, holding a transfersLimit slot with it.
// ---------------------------------------------------------------------------

/** design/main/ipc.js outside Electron: only the four calls its constructor makes. */
function ipcWithQueue(securityOverrides) {
  const os = require('os');
  const nodePath = require('path');
  const electronId = require.resolve('electron');
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      app: {
        getPath: () => nodePath.join(os.tmpdir(), 'material-winscp-queue-test'),
        getVersion: () => '0.0.0-test',
        on() {},
      },
      ipcMain: { handle() {}, removeHandler() {} },
      BrowserWindow: { getAllWindows: () => [] },
      shell: {}, clipboard: {}, dialog: {},
    },
  };
  const { Ipc } = require('../design/main/ipc');
  const p = prefs();
  Object.assign(p.security, securityOverrides || {});
  const config = { prefs: p, sites: [], setPref() {}, on() {} };
  // getWindow returns null, which is the "no window yet" branch of Ipc.emit:
  // every renderer push becomes a no-op, exactly as it would before the window
  // opens. The reconnect decision must still be taken.
  const ipc = new Ipc({ config, version: '0.0.0-test', getWindow: () => null });
  return { ipc, queue: ipc.queue() };
}

test('the main process answers the queue\'s reconnect instead of parking it', async () => {
  const { ipc, queue: q } = ipcWithQueue({ sessionReopenBackground: 0 });
  assert.strictEqual(q.listenerCount('reconnect'), 1,
    'something must be listening, or the queue falls back to its own backoff');

  const { local, remote } = makeNamedPair('sftp', { chunkSize: 4096 });
  const payload = bigBuffer(40960);
  remote.put('/r/big.bin', payload);
  remote.failRead = { path: '/r/big.bin', afterBytes: 8192 };

  // The session has to be one the manager still knows about, because a session
  // the user closed is this port's Abort answer. Seeded directly: SessionManager
  // only gains sessions by really connecting one.
  const session = { id: 'sess-reconnect-test' };
  ipc.sessions.sessions.set(session.id, session);

  const item = q.add({
    side: 'download',
    source: '/r/big.bin',
    target: '/l/big.bin',
    sourceAdapter: remote,
    targetAdapter: local,
    session,
    copyParam: { resumeSupport: 'on' },
  });

  const outcome = await Promise.race([
    q.idle().then(() => 'settled'),
    sleep(2000).then(() => 'hung'),
  ]);
  assert.strictEqual(outcome, 'settled',
    'the reconnect was never answered, so the item waits forever');
  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(local.read('/l/big.bin').equals(payload));
});

test('a queued transfer whose session was closed is failed, not retried forever', async () => {
  // TTerminal::QueryReopen answers Retry by itself because an unattended queue
  // must recover on its own; the user's Abort is closing the session, which
  // removes it from the manager. Nothing here is registered, so `fail()`.
  const { queue: q } = ipcWithQueue({ sessionReopenBackground: 0 });
  const { local, remote } = makeNamedPair('sftp', { chunkSize: 4096 });
  remote.put('/r/big.bin', bigBuffer(40960));
  remote.failRead = { path: '/r/big.bin', afterBytes: 8192 };

  const item = q.add({
    side: 'download',
    source: '/r/big.bin',
    target: '/l/big.bin',
    sourceAdapter: remote,
    targetAdapter: local,
    session: { id: 'a-session-that-was-closed' },
    copyParam: { resumeSupport: 'on' },
  });

  const outcome = await Promise.race([
    q.idle().then(() => 'settled'),
    sleep(2000).then(() => 'hung'),
  ]);
  assert.strictEqual(outcome, 'settled');
  assert.strictEqual(item.state, 'error');
  assert.strictEqual(item.error.code, 'ECONNRESET');
});

test('maxReconnects survives as an explicit cap, and is off by default', () => {
  // Queue.cpp holds no retry counter, so nothing in the app sets one. The option
  // stays for an embedder that genuinely wants a count-based ceiling; what it
  // must never be again is the queue's entire reconnect policy.
  assert.strictEqual(new TransferQueue({ prefs: prefs() }).maxReconnects, 0);
  assert.strictEqual(new TransferQueue({ prefs: prefs(), maxReconnects: 3 }).maxReconnects, 3);
});

test('isConnectionError only claims real connection failures', () => {
  assert.strictEqual(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.strictEqual(isConnectionError(new Error('Connection lost while reading')), true);
  assert.strictEqual(isConnectionError(Object.assign(new Error('nope'), { code: 'EACCES' })), false);
  assert.strictEqual(isConnectionError(null), false);
});

test('an overwrite query is raised and every answer is honoured', async () => {
  const p = prefs({ queue: { noConfirmations: false } });

  // --- skip -----------------------------------------------------------
  {
    const { local, remote } = makePair();
    local.put('/l/a.txt', 'NEW', 2000);
    remote.put('/r/a.txt', 'OLD', 1000);
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    const queries = [];
    q.on('query', (e) => { queries.push(e.query); e.respond('skip'); });
    const item = q.add({
      side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
      sourceAdapter: local, targetAdapter: remote,
    });
    await q.idle();
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0].kind, 'overwrite');
    // both sides' size and time travel with the query
    assert.deepStrictEqual(
      { size: queries[0].source.size, mtime: queries[0].source.mtime }, { size: 3, mtime: 2000 });
    assert.deepStrictEqual(
      { size: queries[0].target.size, mtime: queries[0].target.mtime }, { size: 3, mtime: 1000 });
    assert.strictEqual(remote.read('/r/a.txt').toString(), 'OLD');
    assert.deepStrictEqual(item.skipped, ['/r/a.txt']);
    assert.strictEqual(item.state, 'done');
  }

  // --- overwrite, answered through the queue API rather than the event --
  {
    const { local, remote } = makePair();
    local.put('/l/a.txt', 'NEW', 2000);
    remote.put('/r/a.txt', 'OLD', 1000);
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    q.on('query', (e) => { q.answerQuery(e.item.id, 'overwrite'); });
    q.add({
      side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
      sourceAdapter: local, targetAdapter: remote,
    });
    await q.idle();
    assert.strictEqual(remote.read('/r/a.txt').toString(), 'NEW');
  }

  // --- rename -----------------------------------------------------------
  {
    const { local, remote } = makePair();
    local.put('/l/a.txt', 'NEW', 2000);
    remote.put('/r/a.txt', 'OLD', 1000);
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    q.on('query', (e) => e.respond('rename', { newName: 'a(1).txt' }));
    q.add({
      side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
      sourceAdapter: local, targetAdapter: remote,
    });
    await q.idle();
    assert.strictEqual(remote.read('/r/a.txt').toString(), 'OLD');
    assert.strictEqual(remote.read('/r/a(1).txt').toString(), 'NEW');
  }

  // --- overwrite-all asks once for a whole directory ---------------------
  {
    const { local, remote } = makePair();
    local.put('/l/d/1.txt', 'N1'); local.put('/l/d/2.txt', 'N2'); local.put('/l/d/3.txt', 'N3');
    remote.putDir('/r/d');
    remote.put('/r/d/1.txt', 'O1'); remote.put('/r/d/2.txt', 'O2'); remote.put('/r/d/3.txt', 'O3');
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    let asked = 0;
    q.on('query', (e) => { asked += 1; e.respond('overwrite-all'); });
    q.add({
      side: 'upload', source: '/l/d', target: '/r/d',
      sourceAdapter: local, targetAdapter: remote,
    });
    await q.idle();
    assert.strictEqual(asked, 1, 'overwrite-all must not ask again');
    assert.strictEqual(remote.read('/r/d/3.txt').toString(), 'N3');
  }

  // --- skip-all ---------------------------------------------------------
  {
    const { local, remote } = makePair();
    local.put('/l/d/1.txt', 'N1'); local.put('/l/d/2.txt', 'N2');
    remote.putDir('/r/d');
    remote.put('/r/d/1.txt', 'O1'); remote.put('/r/d/2.txt', 'O2');
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    let asked = 0;
    q.on('query', (e) => { asked += 1; e.respond('skip-all'); });
    q.add({ side: 'upload', source: '/l/d', target: '/r/d', sourceAdapter: local, targetAdapter: remote });
    await q.idle();
    assert.strictEqual(asked, 1);
    assert.strictEqual(remote.read('/r/d/1.txt').toString(), 'O1');
    assert.strictEqual(remote.read('/r/d/2.txt').toString(), 'O2');
  }

  // --- append -----------------------------------------------------------
  {
    const { local, remote } = makePair();
    local.put('/l/a.txt', 'TAIL');
    remote.put('/r/a.txt', 'HEAD');
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    q.on('query', (e) => e.respond('append'));
    q.add({ side: 'upload', source: '/l/a.txt', target: '/r/a.txt', sourceAdapter: local, targetAdapter: remote });
    await q.idle();
    assert.strictEqual(remote.read('/r/a.txt').toString(), 'HEADTAIL');
  }

  // --- resume from an existing (shorter) target -------------------------
  {
    const { local, remote } = makePair({ chunkSize: 1024 });
    const payload = bigBuffer(8192);
    local.put('/l/a.bin', payload);
    remote.put('/r/a.bin', payload.subarray(0, 3072));
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    const seen = [];
    q.on('query', (e) => { seen.push(e.query.canResume); e.respond('resume'); });
    local.reads.length = 0;
    const item = q.add({
      side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
      sourceAdapter: local, targetAdapter: remote,
      copyParam: { resumeSupport: 'on' },
    });
    await q.idle();
    assert.strictEqual(item.state, 'done', item.error && item.error.message);
    assert.deepStrictEqual(seen, [true], 'the query must advertise that resume is possible');
    assert.ok(remote.read('/r/a.bin').equals(payload));
    assert.deepStrictEqual(local.reads.map((r) => r.start), [3072]);
  }
});

// ---------------------------------------------------------------------------
// "Preserve overwritten remote files to recycle bin"
//
// TSFTPFileSystem::SFTPOpenRemote (SftpFileSystem.cpp:5226-5270). The setting
// only earns its name if the move happens BEFORE the replacement is written —
// afterwards there is nothing left to preserve — so the ordering is asserted
// here rather than assumed, along with every guard WinSCP puts around it.
// ---------------------------------------------------------------------------

/** The recycle bin lives on the site, so it reaches the queue on the session. */
const RECYCLE_SESSION = { data: { overwrittenToRecycleBin: true, recycleBinPath: '/r/.bin' } };

/**
 * A pair whose remote really is SFTP. The gate is the PROTOCOL, not a
 * capability: `caps.recycleBin` is false on every remote adapter in this port
 * (it means the OS trash, which only the local backend has), and WinSCP's own
 * gate is SiteAdvanced.cpp:1038 greying the checkbox out for anything but SFTP.
 */
function sftpPair(options) {
  const pair = makePair(options);
  pair.remote.name = 'SFTP';
  pair.remote.putDir('/r/.bin');
  return pair;
}

/** Everything sitting in the bin, so "exactly one file" can be asserted. */
async function binContents(remote, dir = '/r/.bin') {
  const files = await remote.list(dir);
  return files.map((f) => ({ name: f.name, data: remote.read(`${dir}/${f.name}`) }));
}

const STAMPED = /^a-\d{8}-\d{6}\.bin$/;

test('an overwritten remote file is moved to the recycle bin, not destroyed', async () => {
  const { local, remote } = sftpPair();
  const oldBytes = bigBuffer(5000, 7);
  const newBytes = bigBuffer(9000, 99);
  remote.put('/r/a.bin', oldBytes);
  local.put('/l/a.bin', newBytes);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(remote.read('/r/a.bin').equals(newBytes), 'the new bytes must land under the real name');

  const bin = await binContents(remote);
  assert.strictEqual(bin.length, 1, `expected one recycled file, got ${bin.map((f) => f.name)}`);
  // The `*-yyyymmdd-hhnnss.*` mask is Terminal.cpp:4318, and it is what stops a
  // second overwrite of the same name from burying the first copy.
  assert.match(bin[0].name, STAMPED);
  assert.ok(bin[0].data.equals(oldBytes), 'the recycled copy must be the original, byte for byte');
});

test('the recycle happens before the replacement is written, not after', async () => {
  // WinSCP gets this ordering from SSH_FXF_EXCL (SftpFileSystem.cpp:5132-5136):
  // the create FAILS while the old file is still there, and only the retry
  // after the recycle succeeds. Kill the write and the bin must still hold a
  // complete original — a recycle that ran afterwards would leave it empty.
  const { local, remote } = sftpPair();
  const oldBytes = bigBuffer(5000, 3);
  remote.put('/r/a.bin', oldBytes);
  local.put('/l/a.bin', bigBuffer(9000, 5));
  remote.createWriteStream = async () => {
    const e = new Error('Permission denied'); e.code = 'EACCES'; throw e;
  };

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  assert.strictEqual(item.state, 'error');
  const bin = await binContents(remote);
  assert.strictEqual(bin.length, 1, 'the original must already be in the bin when the write dies');
  assert.ok(bin[0].data.equals(oldBytes), 'and it must be complete');
});

test('the recycle bin is off unless the site asked for it', async () => {
  // Every other test in this file queues without a session, so this is also
  // what keeps them honest: no session data, no recycling, no behaviour change.
  const { local, remote } = sftpPair();
  remote.put('/r/a.bin', bigBuffer(500, 1));
  local.put('/l/a.bin', bigBuffer(600, 2));

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.deepStrictEqual(await binContents(remote), []);
});

test('the recycle bin is SFTP only, whatever the site setting says', async () => {
  // SiteAdvanced.cpp:1038, and the shipped "(SFTP only)" caption. SCP, FTP,
  // WebDAV and S3 never mention OverwrittenToRecycleBin in WinSCP at all.
  const { local, remote } = sftpPair();
  remote.name = 'FTP';
  remote.put('/r/a.bin', bigBuffer(500, 1));
  const newBytes = bigBuffer(600, 2);
  local.put('/l/a.bin', newBytes);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.deepStrictEqual(await binContents(remote), []);
  assert.ok(remote.read('/r/a.bin').equals(newBytes), 'the overwrite itself still happens');
});

test('a symbolic link is never moved to the recycle bin', async () => {
  // SftpFileSystem.cpp:5251-5255. Moving the LINK would bin the pointer and
  // leave the file it pointed at untouched — the opposite of preserving it.
  const { local, remote } = sftpPair();
  remote.put('/r/a.bin', bigBuffer(500, 1), 1000000, { isSymlink: true });
  const newBytes = bigBuffer(600, 2);
  local.put('/l/a.bin', newBytes);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const logs = [];
  q.on('log', (e) => logs.push(e.text));
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.deepStrictEqual(await binContents(remote), []);
  assert.ok(remote.read('/r/a.bin').equals(newBytes), 'the transfer still completes');
  assert.ok(logs.some((t) => /symbolic link/.test(t)), `no explanation was logged: ${logs}`);
});

test('a failed recycle degrades to a normal overwrite instead of failing the item', async () => {
  // `if (!FTerminal->RecycleFile(...)) { // Allow normal overwrite` —
  // SftpFileSystem.cpp:5259-5262. A bin the user cannot write to must not cost
  // them the upload.
  const { local, remote } = sftpPair();
  remote.put('/r/a.bin', bigBuffer(500, 1));
  const newBytes = bigBuffer(600, 2);
  local.put('/l/a.bin', newBytes);
  const realRename = remote.rename.bind(remote);
  const attempted = [];
  remote.rename = async (from, to) => {
    if (String(to).startsWith('/r/.bin/')) {
      attempted.push(to);
      throw new Error('Permission denied');
    }
    return realRename(from, to);
  };

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  // The attempt has to have happened, or this test would pass on a build that
  // never recycles at all — which is exactly the state this whole block exists
  // to rule out.
  assert.strictEqual(attempted.length, 1, 'the recycle must have been attempted');
  assert.match(attempted[0], /^\/r\/\.bin\/a-\d{8}-\d{6}\.bin$/);
  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(item.error, null);
  assert.ok(remote.read('/r/a.bin').equals(newBytes));
  assert.deepStrictEqual(await binContents(remote), []);
});

test('a file already in the recycle bin is not recycled a second time', async () => {
  // TTerminal::IsRecycledFile, Terminal.cpp:4307-4310.
  const { local, remote } = sftpPair();
  remote.put('/r/.bin/a.bin', bigBuffer(500, 1));
  const newBytes = bigBuffer(600, 2);
  local.put('/l/a.bin', newBytes);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/.bin/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  const bin = await binContents(remote);
  assert.deepStrictEqual(bin.map((f) => f.name), ['a.bin'], 'no stamped second copy');
  assert.ok(bin[0].data.equals(newBytes));
});

test('the recycled file lends its permissions to the replacement', async () => {
  // PreserveExistingRights — SftpFileSystem.cpp:4804 and 4818-4827. The name
  // survived, so its mode should too; otherwise switching the safety net on
  // quietly re-modes every file it protects.
  const { local, remote } = sftpPair();
  remote.put('/r/a.bin', bigBuffer(500, 1));
  remote.files.get('/r/a.bin').rights = 'rw-------';
  local.put('/l/a.bin', bigBuffer(600, 2));

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
    copyParam: { preserveRights: false },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(remote.files.get('/r/a.bin').rights, 'rw-------',
    'a fresh write would have left the adapter default rw-r--r--');
});

test('append and resume are not overwrites, so nothing is recycled', async () => {
  // WinSCP tests `OverwriteMode == omOverwrite` at SftpFileSystem.cpp:5133 and
  // 5226: both of these EXTEND the file that is already there, so there is
  // nothing being overwritten to preserve.
  const p = prefs({ queue: { noConfirmations: false } });

  {
    const { local, remote } = sftpPair();
    remote.put('/r/a.bin', Buffer.from('HEAD'));
    local.put('/l/a.bin', Buffer.from('TAIL'));
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    q.on('query', (e) => e.respond('append'));
    const item = q.add({
      side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
      sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
    });
    await q.idle();
    assert.strictEqual(item.state, 'done', item.error && item.error.message);
    assert.strictEqual(remote.read('/r/a.bin').toString(), 'HEADTAIL');
    assert.deepStrictEqual(await binContents(remote), []);
  }

  {
    const { local, remote } = sftpPair({ chunkSize: 1024 });
    const payload = bigBuffer(8192);
    local.put('/l/a.bin', payload);
    remote.put('/r/a.bin', payload.subarray(0, 3072));
    const q = new TransferQueue({ prefs: p, progressMs: 0 });
    q.on('query', (e) => e.respond('resume'));
    const item = q.add({
      side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
      sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
      copyParam: { resumeSupport: 'on' },
    });
    await q.idle();
    assert.strictEqual(item.state, 'done', item.error && item.error.message);
    assert.ok(remote.read('/r/a.bin').equals(payload));
    assert.deepStrictEqual(await binContents(remote), []);
  }
});

test('the partial-file path recycles the target instead of removing it', async () => {
  // The `.filepart` route reaches the target through `remove` + `rename`
  // (queue.js `_copyBytes`), which is the second place the existing file dies.
  // WinSCP's own resume rename-over recycles there too — SftpFileSystem.cpp
  // 4939-4958.
  const { local, remote } = sftpPair({ chunkSize: 1024 });
  const oldBytes = bigBuffer(4000, 11);
  const newBytes = bigBuffer(8192, 22);
  remote.put('/r/a.bin', oldBytes);
  local.put('/l/a.bin', newBytes);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote, session: RECYCLE_SESSION,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.strictEqual(remote.read('/r/a.bin.filepart'), null, 'the partial is renamed away');
  assert.ok(remote.read('/r/a.bin').equals(newBytes));
  const bin = await binContents(remote);
  assert.strictEqual(bin.length, 1, `expected one recycled file, got ${bin.map((f) => f.name)}`);
  assert.match(bin[0].name, STAMPED);
  assert.ok(bin[0].data.equals(oldBytes), 'the original must be in the bin, not removed');
});

// ---------------------------------------------------------------------------
// what the delete-and-rename refuses to replace
//
// SftpFileSystem.cpp:4674-4700 vetoes the resumable route for an existing
// target of two kinds, because `_copyBytes`'s partial-file path does not
// overwrite the target in place — it writes '<name>.filepart', REMOVES the
// target and renames the part onto the name, which recreates the file from
// scratch. transfer.js's `source()` has made this decision for a while; the
// queue is the route a click in the UI actually takes.
//
// `remote.writes` is what tells the two routes apart. A refused resume writes
// straight at '/r/a.bin'; an allowed one writes at '/r/a.bin.filepart'. Both
// leave the same bytes behind at the same name, so reading the file back
// cannot distinguish them — which is precisely why the bug was invisible.
// ---------------------------------------------------------------------------

/** Upload 8 KB over an existing '/r/a.bin' carrying `extra` stat fields. */
async function uploadOverTarget(extra, userName) {
  const { local, remote } = makePair({ chunkSize: 1024 });
  if (userName !== undefined) remote.session = { userName };
  const payload = bigBuffer(8192, 5);
  local.put('/l/a.bin', payload);
  remote.put('/r/a.bin', bigBuffer(500, 1), 1000000, extra);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const logs = [];
  q.on('log', (e) => logs.push(e.text));
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { resumeSupport: 'on' },
  });
  await q.idle();
  return { item, remote, logs, payload, paths: [...new Set(remote.writes.map((w) => w.path))] };
}

test('the queue does not resume over a symbolic link', async () => {
  // "If destination file is symlink, never do resumable transfer, as it would
  // delete the symlink" — SftpFileSystem.cpp:4674-4680. The queue took the
  // partial-file route regardless, so `remove` + `rename` replaced the link
  // with an ordinary file and whatever it pointed at was left orphaned.
  const r = await uploadOverTarget({ isSymlink: true });

  assert.strictEqual(r.item.state, 'done', r.item.error && r.item.error.message);
  assert.deepStrictEqual(r.paths, ['/r/a.bin'],
    'the bytes must go at the link itself, never through a part that is renamed over it');
  assert.ok(r.remote.read('/r/a.bin').equals(r.payload), 'the upload itself still happens');
  assert.ok(r.logs.some((l) => /symbolic link, not doing resumable transfer/.test(l)),
    `expected WinSCP's own refusal in the log, got ${JSON.stringify(r.logs)}`);
});

test('the queue does not resume over a file another user owns', async () => {
  // The third arm of the same chain (SftpFileSystem.cpp:4691-4700): deleting
  // and recreating the file hands a colleague's file to whoever uploaded over
  // it, and no amount of preserving rights afterwards puts the owner back.
  const r = await uploadOverTarget({ owner: 'bob' }, 'alice');

  assert.strictEqual(r.item.state, 'done', r.item.error && r.item.error.message);
  assert.deepStrictEqual(r.paths, ['/r/a.bin'],
    'a file owned by someone else must not be removed and recreated');
  assert.ok(r.logs.some((l) => /owned by another user \[bob\]/.test(l)),
    `expected WinSCP's own refusal in the log, got ${JSON.stringify(r.logs)}`);
});

test('a numeric owner is a uid and never stops the queue resuming', async () => {
  // The regression this guards is far worse than the bug it guards: ssh2 asks
  // for SFTP-3, whose attribute block has no owner-name field at all, so
  // sftp.js:1345 hands the adapter String(uid). Reading '1000' as somebody
  // called 1000 makes the comparison against 'alice' false for every file on
  // every server — resumable uploads would be off everywhere, silently.
  const r = await uploadOverTarget({ owner: '1000' }, 'alice');

  assert.strictEqual(r.item.state, 'done', r.item.error && r.item.error.message);
  assert.ok(r.paths.includes('/r/a.bin.filepart'),
    `a uid is not a user name, so resume must still take the partial route; wrote ${JSON.stringify(r.paths)}`);
  assert.strictEqual(r.remote.read('/r/a.bin.filepart'), null, 'the partial is renamed away');
  assert.ok(r.remote.read('/r/a.bin').equals(r.payload));
  assert.ok(!r.logs.some((l) => /owned by another user/.test(l)));
});

test('an owner that is this session, @host and all, still resumes', async () => {
  // RemoteFiles.cpp:583-588 — Bitvise reports the owner as 'user@host' while
  // the session logged in as 'user'. A plain string compare refuses to resume
  // over your own files on exactly those servers.
  const r = await uploadOverTarget({ owner: 'alice@host' }, 'alice');

  assert.strictEqual(r.item.state, 'done', r.item.error && r.item.error.message);
  assert.ok(r.paths.includes('/r/a.bin.filepart'),
    `your own file must still resume; wrote ${JSON.stringify(r.paths)}`);
  assert.ok(r.remote.read('/r/a.bin').equals(r.payload));
});

test('newerOnly skips a target that is already up to date', async () => {
  const { local, remote } = makePair();
  local.put('/l/old.txt', 'local', 1000);
  remote.put('/r/old.txt', 'remote', 5000);
  local.put('/l/new.txt', 'local', 9000);
  remote.put('/r/new.txt', 'remote', 5000);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  q.add({
    side: 'upload', source: '/l/old.txt', target: '/r/old.txt',
    sourceAdapter: local, targetAdapter: remote, copyParam: { newerOnly: true },
  });
  q.add({
    side: 'upload', source: '/l/new.txt', target: '/r/new.txt',
    sourceAdapter: local, targetAdapter: remote, copyParam: { newerOnly: true },
  });
  await q.idle();

  assert.strictEqual(remote.read('/r/old.txt').toString(), 'remote', 'older source is skipped');
  assert.strictEqual(remote.read('/r/new.txt').toString(), 'local', 'newer source is sent');
});

test('text mode converts line endings in both directions', async () => {
  // upload: CRLF -> LF
  {
    const { local, remote } = makePair({ chunkSize: 8 });
    local.put('/l/a.txt', Buffer.from('one\r\ntwo\r\nthree\r\n'));
    const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
    q.add({
      side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
      sourceAdapter: local, targetAdapter: remote,
      copyParam: { transferMode: 'text' },
    });
    await q.idle();
    assert.strictEqual(remote.read('/r/a.txt').toString(), 'one\ntwo\nthree\n');
  }
  // download: LF -> CRLF
  {
    const { local, remote } = makePair({ chunkSize: 8 });
    remote.put('/r/a.txt', Buffer.from('one\ntwo\nthree\n'));
    const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
    q.add({
      side: 'download', source: '/r/a.txt', target: '/l/a.txt',
      sourceAdapter: remote, targetAdapter: local,
      copyParam: { transferMode: 'text' },
    });
    await q.idle();
    assert.strictEqual(local.read('/l/a.txt').toString(), 'one\r\ntwo\r\nthree\r\n');
  }
});

test('automatic transfer mode consults the asciiFileMask', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.txt', Buffer.from('x\r\ny\r\n'));      // in the default ascii mask
  local.put('/l/a.jpg', Buffer.from('x\r\ny\r\n'));      // not

  // TCopyParamType::Default is tmBinary, so automatic mode is asked for here
  // rather than assumed — which is also what a user does when they pick it.
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const auto = { transferMode: 'automatic' };
  q.add({ side: 'upload', source: '/l/a.txt', target: '/r/a.txt', sourceAdapter: local, targetAdapter: remote, copyParam: auto });
  q.add({ side: 'upload', source: '/l/a.jpg', target: '/r/a.jpg', sourceAdapter: local, targetAdapter: remote, copyParam: auto });
  await q.idle();

  assert.strictEqual(remote.read('/r/a.txt').toString(), 'x\ny\n', 'text file converted');
  assert.strictEqual(remote.read('/r/a.jpg').toString(), 'x\r\ny\r\n', 'binary file untouched');
});

test('removeBOM and removeCtrlZ', async () => {
  const { local, remote } = makePair({ chunkSize: 4 });
  const body = Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello\r\nworld'), Buffer.from([0x1A]),
  ]);
  local.put('/l/a.txt', body);
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { transferMode: 'text', removeBOM: true, removeCtrlZ: true },
  });
  await q.idle();
  assert.strictEqual(remote.read('/r/a.txt').toString(), 'hello\nworld');
});

test('parallel chunks split one big file across several ranged streams', async () => {
  const { local, remote } = makePair({ chunkSize: 1024 });
  const payload = bigBuffer(65536);
  local.put('/l/huge.bin', payload);

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  local.reads.length = 0;
  const item = q.add({
    side: 'upload', source: '/l/huge.bin', target: '/r/huge.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { parallelTransfers: 4, parallelTransferThreshold: 16384, resumeSupport: 'off' },
  });
  await q.idle();

  assert.strictEqual(item.state, 'done', item.error && item.error.message);
  assert.ok(remote.read('/r/huge.bin').equals(payload), 'reassembled file must match');
  assert.strictEqual(local.reads.length, 4, `expected 4 ranged reads, got ${local.reads.length}`);
  assert.deepStrictEqual(local.reads.map((r) => r.start).sort((a, b) => a - b),
    [0, 16384, 32768, 49152]);
});

test('transfersLimit bounds how many items run at once', async () => {
  const { local, remote } = makePair({ chunkSize: 256, readDelayMs: 5 });
  for (let i = 0; i < 5; i++) local.put(`/l/f${i}.bin`, bigBuffer(2048, i));

  const q = new TransferQueue({ prefs: prefs({ queue: { transfersLimit: 2 } }), progressMs: 0 });
  let peak = 0;
  const items = [];
  for (let i = 0; i < 5; i++) {
    items.push(q.add({
      side: 'upload', source: `/l/f${i}.bin`, target: `/r/f${i}.bin`,
      sourceAdapter: local, targetAdapter: remote,
    }));
  }
  const poll = setInterval(() => {
    peak = Math.max(peak, items.filter((i) => i.state === 'active').length);
  }, 3);
  await q.idle();
  clearInterval(poll);

  assert.ok(peak <= 2, `ran ${peak} items at once with a limit of 2`);
  assert.ok(peak >= 2, 'the limit should actually be used');
  for (let i = 0; i < 5; i++) assert.ok(remote.read(`/r/f${i}.bin`), `f${i} missing`);
});

test('transfersLimit does not wrap large finite values through int32 coercion', () => {
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }) });
  q.setTransfersLimit(2147483648);
  assert.equal(q.transfersLimit, 2147483648);
});

test('IPC questions fail closed when their renderer window closes', async () => {
  const { EventEmitter } = require('events');
  const { ipc } = ipcWithQueue();
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.webContents = { isDestroyed: () => false, send() {} };
  ipc.getWindow = () => window;

  const pending = ipc.ask({ message: 'Confirm the operation.' });
  assert.equal(ipc._asks.size, 1);
  window.emit('closed');
  assert.equal(await pending, 'cancel');
  assert.equal(ipc._asks.size, 0);
});

test('answering an IPC question removes its window lifecycle listener', async () => {
  const { EventEmitter } = require('events');
  const { ipc } = ipcWithQueue();
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.webContents = { isDestroyed: () => false, send() {} };
  ipc.getWindow = () => window;

  const pending = ipc.ask({ message: 'Confirm the operation.' });
  const promptId = [...ipc._asks.keys()][0];
  assert.equal(ipc.answerAsk(promptId, 'yes'), true);
  assert.equal(await pending, 'yes');
  window.emit('closed');
  assert.equal(ipc._asks.size, 0);
});

test('parallel chunk failure aborts and settles sibling streams', async () => {
  const { local, remote } = makePair({ chunkSize: 1024, readDelayMs: 2 });
  const payload = bigBuffer(65536);
  local.put('/l/huge.bin', payload);
  const createReadStream = local.createReadStream.bind(local);
  local.createReadStream = async (...args) => {
    local.failRead = { path: '/l/huge.bin', afterBytes: 0 };
    return createReadStream(...args);
  };

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0, maxReconnects: 1 });
  const item = q.add({
    side: 'upload', source: '/l/huge.bin', target: '/r/huge.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { parallelTransfers: 4, parallelTransferThreshold: 16384, resumeSupport: 'off' },
  });
  await q.idle();

  assert.equal(item.state, 'error');
  assert.equal(item.error.code, 'ECONNRESET');
  assert.ok(item.progress.bytes < payload.length, 'failed parallel copy must not report completion');
});

test('cancellation during throttling does not write the delayed chunk', async () => {
  const { local, remote } = makePair({ chunkSize: 4 });
  local.put('/l/a.bin', Buffer.from('abcdefgh'));
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { cpsLimit: 1 },
  });
  await waitFor(() => item.state === 'active', 1000, 'transfer start');
  q.remove(item.id);
  await q.idle();
  assert.equal(remote.read('/r/a.bin'), null, 'cancelled transfer must not publish a target');
});

test('cancellation during parallel target seeding removes the public target', async () => {
  const { local, remote } = makePair();
  local.put('/l/huge.bin', bigBuffer(65536));
  const createWriteStream = remote.createWriteStream.bind(remote);
  remote.createWriteStream = async (path, options) => {
    const stream = await createWriteStream(path, options);
    if (options && options.flags === 'w') {
      const end = stream.end.bind(stream);
      stream.end = (...args) => setTimeout(() => end(...args), 25);
    }
    return stream;
  };
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/huge.bin', target: '/r/huge.bin',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { parallelTransfers: 4, parallelTransferThreshold: 16384, resumeSupport: 'off' },
  });
  await waitFor(() => item.state === 'active', 1000, 'transfer start');
  await new Promise((resolve) => setTimeout(resolve, 5));
  q.remove(item.id);
  await q.idle();
  assert.equal(remote.read('/r/huge.bin'), null, 'cancelled parallel transfer must not publish a target');
});

test('removing an item cancels a pending prompt so idle can settle', async () => {
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  const item = q.add({ id: 'prompt-cancel', source: '/l/a', target: '/r/a' });
  const prompt = q._prompt(item, { type: 'password', message: 'unlock' });

  assert.equal(item.state, 'prompt');
  assert.equal(q.remove(item.id), true);
  assert.equal(await prompt, null, 'removing the row must resolve its prompt');
  await q.idle();
  assert.equal(q.get(item.id), null);
});

test('idle stays pending for a queued item paused before it starts', async () => {
  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  const item = q.add({ id: 'paused-before-start', source: '/l/a', target: '/r/a' });
  assert.equal(q.pauseItem(item.id), true);

  let settled = false;
  const pending = q.idle().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'paused queued work is not idle');

  q.setEnabled(true);
  assert.equal(q.resumeItem(item.id), true);
  await q.idle();
  await pending;
});

test('queue management: enable/disable, reorder, delete, delete all done', async () => {
  const { local, remote } = makePair();
  for (const n of ['a', 'b', 'c']) local.put(`/l/${n}.txt`, n);

  const q = new TransferQueue({ prefs: prefs({ queue: { enabledByDefault: false } }), progressMs: 0 });
  assert.strictEqual(q.enabled, false);
  const a = q.add({ side: 'upload', source: '/l/a.txt', target: '/r/a.txt', sourceAdapter: local, targetAdapter: remote });
  const b = q.add({ side: 'upload', source: '/l/b.txt', target: '/r/b.txt', sourceAdapter: local, targetAdapter: remote });
  const c = q.add({ side: 'upload', source: '/l/c.txt', target: '/r/c.txt', sourceAdapter: local, targetAdapter: remote });
  assert.deepStrictEqual(q.items.map((i) => i.id), [a.id, b.id, c.id]);
  assert.strictEqual(a.state, 'queued', 'a disabled queue starts nothing');

  assert.strictEqual(q.moveDown(a.id), true);
  assert.deepStrictEqual(q.items.map((i) => i.id), [b.id, a.id, c.id]);
  assert.strictEqual(q.moveUp(c.id), true);
  assert.deepStrictEqual(q.items.map((i) => i.id), [b.id, c.id, a.id]);
  assert.strictEqual(q.moveUp(b.id), false, 'already first');

  assert.strictEqual(q.remove(c.id), true);
  assert.deepStrictEqual(q.items.map((i) => i.id), [b.id, a.id]);

  q.setEnabled(true);
  await q.idle();
  assert.strictEqual(remote.read('/r/c.txt'), null, 'a removed item never runs');
  assert.strictEqual(remote.read('/r/a.txt').toString(), 'a');

  assert.strictEqual(q.removeDone(), 2);
  assert.strictEqual(q.items.length, 0);
});

test('the "once done" action is reported when the queue drains', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.txt', 'a');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const idles = [];
  q.on('idle', (e) => idles.push(e.onceDone));
  q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { onceDoneOperation: 'disconnect' },
  });
  await q.idle();
  await sleep(5);
  assert.deepStrictEqual(idles, ['disconnect']);
});

test('"do not keep them" does not cancel the item\'s own "on completion" action', async () => {
  // keepDoneItemsFor: 0 is a real user choice ("Do not keep them"), and it makes
  // the sweep run synchronously the moment an item finishes. The idle
  // announcement used to read the action back off `items` — which the sweep had
  // just emptied — so the user picked "disconnect", the transfer completed, and
  // the app stayed connected. A per-item choice silently cancelled by an
  // unrelated display preference, with no error anywhere.
  const { local, remote } = makePair();
  local.put('/l/a.txt', 'a');

  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: 0 } }), progressMs: 0 });
  const idles = [];
  q.on('idle', (e) => idles.push(e.onceDone));
  q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { onceDoneOperation: 'disconnect' },
  });
  await q.idle();
  await sleep(5);

  assert.strictEqual(q.items.length, 0, 'the sweep really did run — otherwise this proves nothing');
  assert.deepStrictEqual(idles, ['disconnect'],
    'the request outlives the row it was made on');
});

test('the "once done" request does not leak into the next batch', async () => {
  // The other half of remembering it: a batch that asked to disconnect must not
  // answer for a later batch that did not.
  const { local, remote } = makePair();
  local.put('/l/a.txt', 'a');
  local.put('/l/b.txt', 'b');

  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: 0 } }), progressMs: 0 });
  const idles = [];
  q.on('idle', (e) => idles.push(e.onceDone));

  q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: { onceDoneOperation: 'disconnect' },
  });
  await q.idle();
  await sleep(5);

  q.add({
    side: 'upload', source: '/l/b.txt', target: '/r/b.txt',
    sourceAdapter: local, targetAdapter: remote,
    copyParam: {},
  });
  await q.idle();
  await sleep(5);

  assert.deepStrictEqual(idles, ['disconnect', 'none'],
    'the second batch asked for nothing and must be told nothing');
});

test('a failed item reports item-error and does not stop the queue', async () => {
  const { local, remote } = makePair();
  local.put('/l/ok.txt', 'ok');

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const errors = [];
  q.on('item-error', (e) => errors.push(e.item.id));

  const bad = q.add({
    side: 'upload', source: '/l/missing.txt', target: '/r/missing.txt',
    sourceAdapter: local, targetAdapter: remote,
  });
  const good = q.add({
    side: 'upload', source: '/l/ok.txt', target: '/r/ok.txt',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.strictEqual(bad.state, 'error');
  assert.match(bad.error.message, /No such file/);
  assert.deepStrictEqual(errors, [bad.id]);
  assert.strictEqual(good.state, 'done');
  assert.strictEqual(remote.read('/r/ok.txt').toString(), 'ok');
});

test('a prompt raised by an adapter reaches the UI and is answered', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.txt', 'a');

  local.promptOnRead = { kind: 'password', text: 'Passphrase:' };

  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  const asked = [];
  q.on('prompt', (e) => { asked.push(e.prompt); e.respond('hunter2'); });

  const item = q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.deepStrictEqual(asked, [{ kind: 'password', text: 'Passphrase:' }]);
  assert.strictEqual(local.promptAnswer, 'hunter2', 'the answer must reach the adapter');
  assert.strictEqual(item.state, 'done');
  assert.strictEqual(remote.read('/r/a.txt').toString(), 'a');
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test('Throttle paces to the configured rate', async () => {
  const t = new Throttle(10000);
  const start = Date.now();
  for (let i = 0; i < 5; i++) await t.take(2000);   // 10000 bytes at 10000 B/s
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 800, `paced for only ${elapsed}ms`);
  assert.ok(elapsed < 2500, `paced for ${elapsed}ms, far too long`);

  const off = new Throttle(0);
  const s2 = Date.now();
  await off.take(1e9);
  assert.ok(Date.now() - s2 < 50, 'rate 0 must not throttle at all');
});

test('TextConverter survives chunk boundaries', () => {
  const conv = new TextConverter('lf');
  // 'a\r' then '\nb' — the CRLF is split across two chunks
  const a = conv.convert(Buffer.from('a\r'));
  const b = conv.convert(Buffer.from('\nb'));
  const c = conv.flush();
  assert.strictEqual(Buffer.concat([a, b, c]).toString(), 'a\nb');

  const up = new TextConverter('crlf');
  const parts = ['li', 'ne1\n', 'line2\n'].map((s) => up.convert(Buffer.from(s)));
  parts.push(up.flush());
  assert.strictEqual(Buffer.concat(parts).toString(), 'line1\r\nline2\r\n');

  // a lone CR at the very end stays a lone CR
  const lone = new TextConverter('lf');
  const x = lone.convert(Buffer.from('a\r'));
  const y = lone.flush();
  assert.strictEqual(Buffer.concat([x, y]).toString(), 'a\r');
});

test('validLocalFileName and changeFileName', () => {
  assert.strictEqual(validLocalFileName('a:b*c?.txt', '_'), 'a_b_c_.txt');
  assert.strictEqual(validLocalFileName('trailing.', '_'), 'trailing_');
  assert.strictEqual(validLocalFileName('ok name.txt', '_'), 'ok name.txt');

  const cp = { fileNameCase: 'upper', replaceInvalidChars: true, invalidCharsReplacement: '_' };
  assert.strictEqual(changeFileName('a:b.txt', cp, true), 'A_B.TXT');
  assert.strictEqual(changeFileName('a:b.txt', cp, false), 'A:B.TXT', 'uploads keep the name');
  assert.strictEqual(changeFileName('MiXeD.TxT', { ...cp, fileNameCase: 'firstUpper' }, false), 'Mixed.txt');
  assert.strictEqual(changeFileName('MiXeD.TxT', { ...cp, fileNameCase: 'noChange' }, false), 'MiXeD.TxT');
});

test('answerQuery rejects an answer it does not know', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.txt', 'a');
  remote.put('/r/a.txt', 'b');
  const q = new TransferQueue({ prefs: prefs({ queue: { noConfirmations: false } }), progressMs: 0 });
  const item = q.add({
    side: 'upload', source: '/l/a.txt', target: '/r/a.txt',
    sourceAdapter: local, targetAdapter: remote,
  });
  await new Promise((resolve) => q.once('query', resolve));
  assert.throws(() => q.answerQuery(item.id, 'explode'), /Unknown overwrite answer/);
  q.answerQuery(item.id, 'skip');
  await q.idle();
  assert.strictEqual(item.state, 'done');
});

// ---------------------------------------------------------------------------
// "Keep completed items for" and "Beep when work finishes"
//
// Both settings were stored, rendered on their own row in the Preferences
// dialog, and read by absolutely nothing (issue #27). The guard meant to catch
// exactly that missed them because it scanned test/ as well as design/, and
// test/preferences.test.js names every key it asserts — so the guard was
// reading its own subject matter back as proof that something consumed them.
// ---------------------------------------------------------------------------

test('"do not keep completed items" removes the row the moment it finishes', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));

  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: 0 } }), progressMs: 0 });
  const seen = [];
  q.on('item-done', (v) => seen.push(`done:${v.id}`));
  q.on('item-updated', (v) => { if (v.state === 'removed') seen.push(`removed:${v.id}`); });

  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.deepStrictEqual(q.list().map((i) => i.id), [], 'the finished item is still listed');
  // The completion is still announced first: a row that vanishes without ever
  // saying it finished is a transfer the user cannot tell from a lost one.
  assert.deepStrictEqual(seen, [`done:${item.id}`, `removed:${item.id}`]);
});

test('"forever" keeps completed items however long ago they finished', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));

  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: -1 } }), progressMs: 0 });
  q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.strictEqual(q.list().length, 1);
  assert.strictEqual(q.pruneDoneItems(Date.now() + (365 * 24 * 3600 * 1000)), 0);
  assert.strictEqual(q.list().length, 1, 'nothing may sweep an item the user asked to keep');
});

test('a completed item is swept once its keep-for window has passed', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));

  // 15 seconds is the shipped default, so this is what the option does out of
  // the box.
  const q = new TransferQueue({ prefs: prefs(), progressMs: 0 });
  assert.strictEqual(q.queuePrefs.keepDoneItemsFor, 15);
  const a = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();
  assert.deepStrictEqual(q.list().map((i) => i.id), [a.id], 'swept far too early');

  // Still inside the window.
  assert.strictEqual(q.pruneDoneItems(a.finishedAt + 14999), 0);
  assert.strictEqual(q.list().length, 1);

  const removed = [];
  q.on('item-updated', (v) => { if (v.state === 'removed') removed.push(v.id); });
  assert.strictEqual(q.pruneDoneItems(a.finishedAt + 15000), 1);
  assert.deepStrictEqual(q.list(), []);
  assert.deepStrictEqual(removed, [a.id], 'the panel was never told the row went');
});

test('a failed item is never swept, however long it sits there', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));
  remote.createWriteStream = async () => { throw new Error('remote is read-only'); };

  const q = new TransferQueue({
    prefs: prefs({ queue: { keepDoneItemsFor: 0 } }), progressMs: 0, maxReconnects: 0,
  });
  const item = q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();

  assert.strictEqual(item.state, 'error');
  assert.strictEqual(q.pruneDoneItems(Date.now() + 3600000), 0);
  assert.deepStrictEqual(q.list().map((i) => i.state), ['error'],
    'a failure that deletes itself is the queue hiding its own bad news');
});

test('changing the preference on a running queue takes effect without a restart', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));

  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: -1 } }), progressMs: 0 });
  q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  await q.idle();
  assert.strictEqual(q.list().length, 1);

  // Exactly what ipc.js's refreshQueuePrefs does when the store changes. The
  // immediate sweep is this port's own choice — WinSCP's SetKeepDoneItemsFor
  // (Queue.cpp:1126-1136) only assigns the field and lets the next queue event
  // do it. See the comment at that call site for why we diverge.
  q.queuePrefs = { ...q.queuePrefs, keepDoneItemsFor: 0 };
  assert.strictEqual(q.pruneDoneItems(), 1);
  assert.deepStrictEqual(q.list(), []);
});

test('beepOnFinish sounds once when the queue drains, and only when it is on', async () => {
  // A batch that takes a real, measurable moment. WinSCP's test is strictly
  // "longer than", exactly as the row reads — "if it lasted longer than 0
  // seconds" — so a batch that finishes inside the same millisecond it started
  // is correctly silent, and a test that transferred two in-memory buffers
  // instantly would be asserting on the clock rather than on the setting.
  const run = async (overrides) => {
    const { local, remote } = makePair({ chunkSize: 256, readDelayMs: 3 });
    local.put('/l/a.bin', bigBuffer(1000));
    local.put('/l/b.bin', bigBuffer(1000));
    const q = new TransferQueue({ prefs: prefs(overrides), progressMs: 0 });
    const beeps = [];
    q.on('beep', (e) => beeps.push(e));
    q.add({
      side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
      sourceAdapter: local, targetAdapter: remote,
    });
    q.add({
      side: 'upload', source: '/l/b.bin', target: '/r/b.bin',
      sourceAdapter: local, targetAdapter: remote,
    });
    await q.idle();
    return beeps;
  };

  // Off is the default, and off means silent.
  assert.deepStrictEqual(await run({}), []);

  // On, with no minimum duration: one beep for the whole batch, not one per file.
  const on = await run({ beepOnFinish: true, beepOnFinishAfter: 0 });
  assert.strictEqual(on.length, 1, `expected one beep, got ${on.length}`);
  assert.ok(on[0].elapsedMs >= 0 && on[0].elapsedMs < 60000, `implausible duration ${on[0].elapsedMs}`);

  // On, but the work has to have lasted a minute first. Two small files in
  // memory do not, so nothing sounds — that is the half of the setting which
  // makes it bearable, and the half a careless implementation drops.
  assert.deepStrictEqual(await run({ beepOnFinish: true, beepOnFinishAfter: 60 }), []);
});

test('the beep clock runs from the start of the batch, not the last file', async () => {
  const { local, remote } = makePair();
  local.put('/l/a.bin', bigBuffer(1000));

  const q = new TransferQueue({
    prefs: prefs({ beepOnFinish: true, beepOnFinishAfter: 1 }), progressMs: 0,
  });
  const beeps = [];
  q.on('beep', (e) => beeps.push(e));

  q.add({
    side: 'upload', source: '/l/a.bin', target: '/r/a.bin',
    sourceAdapter: local, targetAdapter: remote,
  });
  // TCustomScpExplorerForm::AddQueueItem stamps QueueOperationStart only when
  // the queue was empty and OperationComplete measures from there, so a batch
  // that began two seconds ago beeps even though its last file took no time.
  q._busySince = Date.now() - 2000;
  await q.idle();

  assert.strictEqual(beeps.length, 1);
  assert.ok(beeps[0].elapsedMs >= 2000, `measured only ${beeps[0].elapsedMs}ms`);
});

test('retry starts a clean attempt while preserving resumable progress', async () => {
  const { local, remote } = makePair({ chunkSize: 128 });
  local.put('/l/a.bin', bigBuffer(1000));
  remote.createWriteStream = async () => { throw new Error('temporary failure'); };
  const q = new TransferQueue({ prefs: prefs({ queue: { keepDoneItemsFor: -1 } }), progressMs: 0 });
  const retries = [];
  q.on('item-retry', (event) => retries.push(event));
  const item = q.add({ source: '/l/a.bin', target: '/r/a.bin', sourceAdapter: local, targetAdapter: remote });
  await q.idle();
  assert.strictEqual(item.state, 'error');
  item.progress.cps = 99;
  item.progress.eta = 12;
  item.progress.currentFile = '/l/a.bin';
  remote.createWriteStream = MemoryAdapter.prototype.createWriteStream.bind(remote);
  assert.strictEqual(q.retry(item.id), true);
  await q.idle();
  assert.strictEqual(item.state, 'done');
  assert.strictEqual(item.retryCount, 1);
  assert.deepStrictEqual(retries.map((r) => r.attempt), [1]);
  assert.strictEqual(retries[0].item.retryCount, 1);
  assert.strictEqual(retries[0].item.progress.cps, 0);
  assert.strictEqual(retries[0].item.progress.eta, null);
  assert.strictEqual(retries[0].item.progress.currentFile, '');
  assert.strictEqual(remote.read('/r/a.bin').length, 1000);
});

test('retry appends failed work behind transfers already waiting', () => {
  const q = new TransferQueue({ prefs: { ...PREF_DEFAULTS, queue: { ...PREF_DEFAULTS.queue, enabledByDefault: false } } });
  const first = q.add({ id: 'failed', source: '/l/failed', target: '/r/failed' });
  const waiting = q.add({ id: 'waiting', source: '/l/waiting', target: '/r/waiting' });
  first.state = 'error';
  first.error = new Error('temporary failure');

  assert.equal(q.retry(first.id), true);
  assert.deepEqual(q.list().map((item) => item.id), [waiting.id, first.id]);
  assert.equal(q.get(first.id).state, 'queued');
});
