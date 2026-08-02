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
    this.files = new Map([['/', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }]]);
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
    const parts = np.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      if (!this.files.has(cur)) this.files.set(cur, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
    }
  }

  async list(dir) {
    const d = this.normalize(dir);
    const rec = this.files.get(d);
    if (!rec) { const e = new Error(`No such directory: ${d}`); e.code = 'ENOENT'; throw e; }
    if (rec.type !== 'dir') throw new Error(`Not a directory: ${d}`);
    const prefix = d === '/' ? '/' : `${d}/`;
    const out = [];
    for (const [p, r] of this.files) {
      if (p === d || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push(entry({
        name: rest,
        type: r.type,
        size: r.type === 'dir' ? 0 : r.data.length,
        mtime: r.mtime,
        rights: r.rights,
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
        if (k === np || k.startsWith(`${np}/`)) this.files.delete(k);
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
      if (k.startsWith(`${a}/`)) {
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

function makePair(options) {
  const local = new MemoryAdapter('local', options);
  const remote = new MemoryAdapter('remote', options);
  local.putDir('/l');
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
