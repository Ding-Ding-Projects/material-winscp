// sync.test.js — the comparison matrix.
//
// The bulk of this file is one table covering EVERY direction x mode x criteria
// combination against the same six-file fixture, because that matrix is where
// synchronization bugs live: a rule that looks obviously right for "remote +
// synchronize + time" quietly does the wrong thing for "local + mirror + size".
// Combinations WinSCP itself forbids are asserted to be refused rather than
// silently guessed at.
//
// A fixed timezone is requested before anything else so the DST assertions are
// deterministic; if the host will not honour it the test falls back to checking
// the invariants that hold in any zone.
'use strict';
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('stream');

const { Adapter, entry, DEFAULT_CAPS } = require('../design/main/protocols/base');
const sync = require('../design/main/sync');
const { TransferQueue } = require('../design/main/queue');
const { PREF_DEFAULTS } = require('../design/main/defaults');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// an in-memory Adapter (same contract as base.js)
// ---------------------------------------------------------------------------

class MemoryAdapter extends Adapter {
  constructor(name) {
    super(null);
    this.name = name;
    this.caps = { ...DEFAULT_CAPS, resume: true, timestamp: true, rights: true };
    this.connected = true;
    this.files = new Map([['/', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }]]);
    this.setTimesCalls = [];
  }

  get protocolName() { return this.name; }

  put(p, contents, mtime) {
    const np = this.normalize(p);
    this._ensureParents(np);
    this.files.set(np, {
      type: 'file',
      data: Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents)),
      mtime,
      rights: 'rw-r--r--',
    });
    return np;
  }

  putDir(p, mtime = 0) {
    const np = this.normalize(p);
    this._ensureParents(np);
    if (!this.files.has(np)) this.files.set(np, { type: 'dir', mtime, rights: 'rwxr-xr-x' });
    return np;
  }

  read(p) {
    const r = this.files.get(this.normalize(p));
    return r && r.type === 'file' ? r.data : null;
  }

  has(p) { return this.files.has(this.normalize(p)); }

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
      name: this.basename(np), type: r.type,
      size: r.type === 'dir' ? 0 : r.data.length, mtime: r.mtime, rights: r.rights,
    });
  }

  async mkdir(p) {
    const np = this.normalize(p);
    if (this.files.has(np)) { const e = new Error('exists'); e.code = 'EEXIST'; throw e; }
    this.files.set(np, { type: 'dir', mtime: Date.now(), rights: 'rwxr-xr-x' });
  }

  async remove(p, opts = {}) {
    const np = this.normalize(p);
    if (!this.files.has(np)) { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    if (opts.recursive) {
      for (const k of [...this.files.keys()]) {
        if (k === np || k.startsWith(`${np}/`)) this.files.delete(k);
      }
    } else this.files.delete(np);
  }

  async rename(a, b) {
    const from = this.normalize(a);
    const to = this.normalize(b);
    const r = this.files.get(from);
    this.files.delete(from);
    this.files.set(to, r);
  }

  async setTimes(p, times) {
    const r = this.files.get(this.normalize(p));
    if (!r) throw new Error(`No such file: ${p}`);
    r.mtime = times.mtime;
    this.setTimesCalls.push({ path: this.normalize(p), mtime: times.mtime });
  }

  async setRights(p, rights) {
    const r = this.files.get(this.normalize(p));
    if (r) r.rights = rights;
  }

  async createReadStream(p, opts = {}) {
    const rec = this.files.get(this.normalize(p));
    if (!rec || rec.type !== 'file') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    const start = opts.start || 0;
    const end = opts.end === undefined ? rec.data.length - 1 : opts.end;
    return Readable.from([Buffer.from(rec.data.subarray(start, end + 1))]);
  }

  async createWriteStream(p, opts = {}) {
    const np = this.normalize(p);
    const self = this;
    const start = opts.start || 0;
    if (start === 0 && !opts.append) {
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    } else if (!self.files.has(np)) {
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    }
    let pos = start;
    return new Writable({
      write(chunk, enc, cb) {
        const rec = self.files.get(np);
        let data = rec.data;
        if (pos > data.length) data = Buffer.concat([data, Buffer.alloc(pos - data.length)]);
        const head = data.subarray(0, pos);
        const ts = pos + chunk.length;
        const tail = data.length > ts ? data.subarray(ts) : Buffer.alloc(0);
        rec.data = Buffer.concat([head, Buffer.from(chunk), tail]);
        pos += chunk.length;
        cb();
      },
    });
  }
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

const T = 1600000000000;          // some fixed instant
const MIN = 60000;

/**
 * Six files covering every comparison outcome:
 *   same         identical on both sides
 *   localnewer   same size, local timestamp one minute ahead
 *   remotenewer  same size, remote timestamp one minute ahead
 *   sizediff     same timestamp, different size
 *   onlylocal    missing on the remote
 *   onlyremote   missing locally
 */
function fixture() {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l');
  remote.putDir('/r');

  local.put('/l/same.txt', 'aaaa', T);
  remote.put('/r/same.txt', 'aaaa', T);

  local.put('/l/localnewer.txt', 'aaaa', T + MIN);
  remote.put('/r/localnewer.txt', 'aaaa', T);

  local.put('/l/remotenewer.txt', 'aaaa', T);
  remote.put('/r/remotenewer.txt', 'aaaa', T + MIN);

  local.put('/l/sizediff.txt', 'aaaa', T);
  remote.put('/r/sizediff.txt', 'aaaaaaaa', T);

  local.put('/l/onlylocal.txt', 'aaaa', T);
  remote.put('/r/onlyremote.txt', 'aaaa', T);

  return { local, remote };
}

function summarize(checklist) {
  return checklist.items
    .filter((i) => i.action !== 'nothing')
    .map((i) => `${i.action}:${i.local.name || i.remote.name}`)
    .sort();
}

const U = (n) => `upload:${n}`;
const D = (n) => `download:${n}`;
const DR = (n) => `deleteRemote:${n}`;
const DL = (n) => `deleteLocal:${n}`;

/** Every valid combination and the actions it must produce on the fixture. */
const MATRIX = {
  // ---- direction: remote (make the remote match the local) --------------
  'remote|synchronize|time': [U('localnewer.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|synchronize|size': [U('sizediff.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|synchronize|either': [U('localnewer.txt'), U('sizediff.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|synchronize|none': [U('onlylocal.txt'), DR('onlyremote.txt')],
  // mirror makes the local side win even where the remote copy is newer
  'remote|mirror|time': [U('localnewer.txt'), U('remotenewer.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|mirror|size': [U('sizediff.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|mirror|either': [U('localnewer.txt'), U('remotenewer.txt'), U('sizediff.txt'), U('onlylocal.txt'), DR('onlyremote.txt')],
  'remote|mirror|none': [U('onlylocal.txt'), DR('onlyremote.txt')],
  // timestamp mode never creates or deletes, it only fixes clocks
  'remote|timestamp|time': [U('localnewer.txt'), U('remotenewer.txt')],
  'remote|timestamp|either': [U('localnewer.txt'), U('remotenewer.txt')],

  // ---- direction: local (make the local side match the remote) ----------
  'local|synchronize|time': [D('remotenewer.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|synchronize|size': [D('sizediff.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|synchronize|either': [D('remotenewer.txt'), D('sizediff.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|synchronize|none': [D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|mirror|time': [D('localnewer.txt'), D('remotenewer.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|mirror|size': [D('sizediff.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|mirror|either': [D('localnewer.txt'), D('remotenewer.txt'), D('sizediff.txt'), D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|mirror|none': [D('onlyremote.txt'), DL('onlylocal.txt')],
  'local|timestamp|time': [D('localnewer.txt'), D('remotenewer.txt')],
  'local|timestamp|either': [D('localnewer.txt'), D('remotenewer.txt')],

  // ---- direction: both (only "time" is a well-defined criteria) ---------
  'both|synchronize|time': [U('localnewer.txt'), U('onlylocal.txt'), D('remotenewer.txt'), D('onlyremote.txt')],
  'both|mirror|time': [U('localnewer.txt'), U('onlylocal.txt'), D('remotenewer.txt'), D('onlyremote.txt')],
  'both|timestamp|time': [U('localnewer.txt'), D('remotenewer.txt')],
};

const DIRECTIONS = ['local', 'remote', 'both'];
const MODES = ['synchronize', 'mirror', 'timestamp'];
const CRITERIA = ['time', 'size', 'either', 'none'];

test('every direction x mode x criteria combination', async (t) => {
  let valid = 0;
  let refused = 0;
  for (const direction of DIRECTIONS) {
    for (const mode of MODES) {
      for (const criteria of CRITERIA) {
        const key = `${direction}|${mode}|${criteria}`;
        const { local, remote } = fixture();
        // deleteFiles is its own axis and is illegal in timestamp mode; the
        // "timestamp + deleteFiles" refusal is asserted separately.
        const run = () => sync.compare(local, '/l', remote, '/r',
          { direction, mode, criteria, deleteFiles: mode !== 'timestamp', existingOnly: false });

        if (Object.prototype.hasOwnProperty.call(MATRIX, key)) {
          valid += 1;
          const checklist = await run();
          assert.deepStrictEqual(summarize(checklist), MATRIX[key].slice().sort(), key);
          // timestamp mode must flag its items so apply() never moves bytes
          const expectTimestampOnly = mode === 'timestamp';
          for (const item of checklist.items) {
            assert.strictEqual(item.timestampOnly, expectTimestampOnly, `${key} timestampOnly`);
          }
        } else {
          refused += 1;
          await assert.rejects(run, sync.SyncOptionError, `${key} should have been refused`);
        }
      }
    }
  }
  assert.strictEqual(valid, 23, 'valid combinations covered');
  assert.strictEqual(refused, 13, 'refused combinations covered');
  t.diagnostic(`${valid} valid combinations, ${refused} refused`);
});

test('the refusals say why', async () => {
  const { local, remote } = fixture();
  await assert.rejects(
    () => sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'size' }),
    /cannot be combined with direction "both"/);
  await assert.rejects(
    () => sync.compare(local, '/l', remote, '/r', { mode: 'timestamp', criteria: 'none', direction: 'local' }),
    /meaningless/);
  await assert.rejects(
    () => sync.compare(local, '/l', remote, '/r', { mode: 'timestamp', deleteFiles: true, direction: 'local' }),
    /never deletes/);
  await assert.rejects(
    () => sync.compare(local, '/l', remote, '/r', { direction: 'sideways' }),
    /Unknown direction/);
});

test('the checklist carries both sides and the reason', async () => {
  const { local, remote } = fixture();
  const checklist = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', deleteFiles: true });

  const byName = new Map(checklist.items.map((i) => [i.local.name || i.remote.name, i]));

  const ln = byName.get('localnewer.txt');
  assert.strictEqual(ln.action, 'upload');
  assert.strictEqual(ln.reason, 'local-newer');
  assert.deepStrictEqual(
    { size: ln.local.size, mtime: ln.local.mtime, exists: ln.local.exists },
    { size: 4, mtime: T + MIN, exists: true });
  assert.deepStrictEqual(
    { size: ln.remote.size, mtime: ln.remote.mtime, exists: ln.remote.exists },
    { size: 4, mtime: T, exists: true });

  const ol = byName.get('onlylocal.txt');
  assert.strictEqual(ol.action, 'upload');
  assert.strictEqual(ol.reason, 'new-on-local');
  assert.strictEqual(ol.remote.exists, false);
  assert.strictEqual(ol.remote.path, '/r/onlylocal.txt');

  const rn = byName.get('remotenewer.txt');
  assert.strictEqual(rn.reason, 'remote-newer');

  assert.deepStrictEqual(checklist.counts, {
    upload: 2, download: 2, deleteLocal: 0, deleteRemote: 0, nothing: 0,
  });
});

test('case-insensitive name collisions fail instead of dropping a checklist item', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/Readme.txt', 'one', T);
  local.put('/l/README.txt', 'two', T);

  await assert.rejects(
    () => sync.compare(local, '/l', remote, '/r', { direction: 'remote', criteria: 'time' }),
    /Case-insensitive name collision.*Readme\.txt.*README\.txt/);
  await assert.doesNotReject(
    () => sync.compare(local, '/l', remote, '/r', {
      direction: 'remote', criteria: 'time', caseSensitive: true,
    }));
});

test('preview includes the unchanged pairs so the whole tree is reviewable', async () => {
  const { local, remote } = fixture();
  const plain = await sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'time' });
  const preview = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', preview: true });

  assert.strictEqual(plain.counts.nothing, 0);
  assert.ok(preview.counts.nothing >= 2, 'same.txt and sizediff.txt are unchanged');
  const same = preview.items.find((i) => i.local.name === 'same.txt');
  assert.strictEqual(same.action, 'nothing');
  assert.strictEqual(same.reason, 'identical');
  assert.strictEqual(same.checked, false, 'an unchanged pair is never ticked');
});

test('checked reflects deleteFiles and existingOnly', async () => {
  {
    const { local, remote } = fixture();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'remote', criteria: 'time', deleteFiles: false });
    const del = c.items.find((i) => i.action === 'deleteRemote');
    assert.strictEqual(del.checked, false, 'deletions are unticked without deleteFiles');
  }
  {
    const { local, remote } = fixture();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'remote', criteria: 'time', deleteFiles: true });
    assert.strictEqual(c.items.find((i) => i.action === 'deleteRemote').checked, true);
  }
  {
    const { local, remote } = fixture();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'remote', criteria: 'time', existingOnly: true, deleteFiles: true });
    const brandNew = c.items.find((i) => i.reason === 'new-on-local');
    const remoteOnly = c.items.find((i) => i.reason === 'not-on-local');
    const update = c.items.find((i) => i.reason === 'local-newer');
    assert.strictEqual(brandNew.checked, false, 'existingOnly excludes brand new files');
    assert.strictEqual(remoteOnly.checked, true, 'existingOnly still permits deleting an extra target file');
    assert.strictEqual(update.checked, true, 'updates are still ticked');
  }
});

test('the time tolerance covers coarse filesystem timestamps', async () => {
  const build = (skew) => {
    const local = new MemoryAdapter('local');
    const remote = new MemoryAdapter('remote');
    local.putDir('/l'); remote.putDir('/r');
    local.put('/l/a.txt', 'aaaa', T + skew);
    remote.put('/r/a.txt', 'aaaa', T);
    return { local, remote };
  };

  // Under two seconds is "the same file" (FAT stores even seconds only).
  for (const skew of [0, 1, 999, 1999]) {
    const { local, remote } = build(skew);
    const c = await sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'time' });
    assert.strictEqual(summarize(c).length, 0, `skew ${skew} should compare equal`);
  }
  // Two seconds is a genuine difference.
  {
    const { local, remote } = build(2000);
    const c = await sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'time' });
    assert.deepStrictEqual(summarize(c), [U('a.txt')]);
  }
  // ...unless the caller widens the window, which is what a filesystem with
  // one-minute granularity needs.
  {
    const { local, remote } = build(30000);
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'both', criteria: 'time', timeTolerance: 60000 });
    assert.strictEqual(summarize(c).length, 0);
  }
});

test('DST handling: only dSTMode "win" shifts a remote timestamp', () => {
  const july = new Date(2020, 6, 15, 12, 0, 0).getTime();
  const january = new Date(2020, 0, 15, 12, 0, 0).getTime();

  assert.strictEqual(sync.adjustRemoteTime(july, 'unix', 0), july);
  assert.strictEqual(sync.adjustRemoteTime(july, 'keep', 0), july);
  assert.strictEqual(sync.adjustRemoteTime(january, 'unix', 0), january);
  assert.strictEqual(sync.adjustRemoteTime(july, 'win', 0), july + sync.dstDifferenceMs(july));

  // Standard time is the zero point, so a winter timestamp never moves.
  assert.strictEqual(sync.dstDifferenceMs(january), 0);

  // timeDifference is applied in every mode; it is a clock correction, not DST.
  assert.strictEqual(sync.adjustRemoteTime(july, 'unix', 3600), july + 3600000);
});

test('DST handling: the "everything looks changed" bug', async (t) => {
  const july = new Date(2020, 6, 15, 12, 0, 0).getTime();
  const shift = sync.dstDifferenceMs(july);

  const build = () => {
    const local = new MemoryAdapter('local');
    const remote = new MemoryAdapter('remote');
    local.putDir('/l'); remote.putDir('/r');
    // The same instant on both sides — nothing has actually changed.
    local.put('/l/a.txt', 'aaaa', july);
    remote.put('/r/a.txt', 'aaaa', july);
    return { local, remote };
  };

  {
    const { local, remote } = build();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'both', criteria: 'time', dSTMode: 'unix' });
    assert.strictEqual(summarize(c).length, 0,
      'the default mode must NOT think an untouched file changed');
  }

  const { local, remote } = build();
  const c = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', dSTMode: 'win' });

  if (shift !== 0) {
    // 'win' re-reads the remote timestamp through the offset in force at that
    // date. That is exactly the Windows/FAT rule some servers need — and
    // exactly why picking it by mistake makes a whole tree look modified.
    assert.deepStrictEqual(summarize(c), [U('a.txt')],
      'win mode shifts the remote side by the DST difference');
    t.diagnostic(`DST shift for July in this zone: ${shift / 3600000}h`);
  } else {
    assert.strictEqual(summarize(c).length, 0);
    t.diagnostic('this host observes no DST in July; the shift assertions are trivially satisfied');
  }
});

test('recursion, and directories that exist on one side only', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/sub/a.txt', 'aaaa', T + MIN);
  remote.put('/r/sub/a.txt', 'aaaa', T);
  local.put('/l/onlylocaldir/x.txt', 'x', T);
  remote.put('/r/onlyremotedir/y.txt', 'y', T);

  const deep = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', recursive: true });
  assert.deepStrictEqual(summarize(deep),
    [D('onlyremotedir'), U('a.txt'), U('onlylocaldir')].sort());
  // A one-sided directory is a single item covering the whole subtree.
  const dirItem = deep.items.find((i) => i.local.name === 'onlylocaldir');
  assert.strictEqual(dirItem.isDirectory, true);

  const shallow = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', recursive: false });
  assert.strictEqual(shallow.items.some((i) => i.local.name === 'a.txt'), false,
    'without recursion the nested file is never looked at');
});

test('the file mask filters both sides', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/keep.txt', 'a', T);
  local.put('/l/drop.log', 'a', T);
  remote.put('/r/alsodrop.log', 'a', T);

  const c = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time', fileMask: '*.txt' });
  assert.deepStrictEqual(summarize(c), [U('keep.txt')]);
});

test('case sensitivity decides whether two names are the same file', async () => {
  const build = () => {
    const local = new MemoryAdapter('local');
    const remote = new MemoryAdapter('remote');
    local.putDir('/l'); remote.putDir('/r');
    local.put('/l/README.txt', 'aaaa', T);
    remote.put('/r/readme.txt', 'aaaa', T);
    return { local, remote };
  };

  {
    const { local, remote } = build();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'both', criteria: 'time', caseSensitive: false });
    assert.strictEqual(summarize(c).length, 0, 'same file under a Windows-style comparison');
  }
  {
    const { local, remote } = build();
    const c = await sync.compare(local, '/l', remote, '/r',
      { direction: 'both', criteria: 'time', caseSensitive: true });
    assert.deepStrictEqual(summarize(c), [D('readme.txt'), U('README.txt')].sort(),
      'two different files under a POSIX-style comparison');
  }
});

test('a directory on one side and a file on the other is reported, not guessed at', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/thing', 'aaaa', T);
  remote.putDir('/r/thing', T);

  const c = await sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'time' });
  const it = c.items.find((i) => i.local.name === 'thing');
  assert.strictEqual(it.action, 'nothing');
  assert.strictEqual(it.reason, 'type-mismatch');
});

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

function makeQueue() {
  return new TransferQueue({ prefs: JSON.parse(JSON.stringify(PREF_DEFAULTS)), progressMs: 0 });
}

test('apply turns the checklist into real transfers', async () => {
  const { local, remote } = fixture();
  const checklist = await sync.compare(local, '/l', remote, '/r',
    { direction: 'both', criteria: 'time' });

  const q = makeQueue();
  const { items } = await sync.apply(checklist, q);
  assert.strictEqual(items.length, 4);
  await q.idle();

  for (const it of items) assert.strictEqual(it.state, 'done', it.error && it.error.message);
  // uploads landed
  assert.strictEqual(remote.read('/r/onlylocal.txt').toString(), 'aaaa');
  assert.strictEqual(remote.files.get('/r/localnewer.txt').mtime, T + MIN, 'timestamp travels');
  // downloads landed
  assert.strictEqual(local.read('/l/onlyremote.txt').toString(), 'aaaa');
  assert.strictEqual(local.files.get('/l/remotenewer.txt').mtime, T + MIN);

  // Re-comparing after the sync must find nothing left to do.
  const again = await sync.compare(local, '/l', remote, '/r', { direction: 'both', criteria: 'time' });
  assert.deepStrictEqual(summarize(again), []);
});

test('apply performs deletions and reports them', async () => {
  const { local, remote } = fixture();
  const checklist = await sync.compare(local, '/l', remote, '/r',
    { direction: 'remote', criteria: 'time', deleteFiles: true });

  const q = makeQueue();
  const result = await sync.apply(checklist, q, { performDeletions: false });
  assert.strictEqual(result.deletions.length, 1);
  assert.strictEqual(result.deletions[0].path, '/r/onlyremote.txt');
  assert.strictEqual(remote.has('/r/onlyremote.txt'), true, 'nothing deleted when asked not to');

  const checklist2 = await sync.compare(local, '/l', remote, '/r',
    { direction: 'remote', criteria: 'time', deleteFiles: true });
  const q2 = makeQueue();
  await sync.apply(checklist2, q2);
  await q2.idle();
  assert.strictEqual(remote.has('/r/onlyremote.txt'), false, 'the extra remote file is gone');
});

test('apply in timestamp mode sets times and never moves bytes', async () => {
  const { local, remote } = fixture();
  const checklist = await sync.compare(local, '/l', remote, '/r',
    { direction: 'remote', mode: 'timestamp', criteria: 'time' });

  const before = remote.read('/r/remotenewer.txt').toString();
  const q = makeQueue();
  const { items, errors } = await sync.apply(checklist, q);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(items.length, 0, 'timestamp mode queues no transfers');
  assert.strictEqual(q.items.length, 0);

  assert.strictEqual(remote.read('/r/remotenewer.txt').toString(), before, 'content untouched');
  assert.strictEqual(remote.files.get('/r/localnewer.txt').mtime, T + MIN);
  assert.strictEqual(remote.files.get('/r/remotenewer.txt').mtime, T);
  assert.deepStrictEqual(remote.setTimesCalls.map((c) => c.path).sort(),
    ['/r/localnewer.txt', '/r/remotenewer.txt']);
});

test('apply respects the checked flag', async () => {
  const { local, remote } = fixture();
  const checklist = await sync.compare(local, '/l', remote, '/r',
    { direction: 'remote', criteria: 'time', deleteFiles: false });
  // untick everything but one item
  for (const i of checklist.items) i.checked = false;
  checklist.items.find((i) => i.action === 'upload').checked = true;

  const q = makeQueue();
  const { items } = await sync.apply(checklist, q);
  assert.strictEqual(items.length, 1);
  await q.idle();
  assert.strictEqual(remote.has('/r/onlylocal.txt'), false, 'unticked items stay unticked');
});

test('apply keeps checklist filtering and timestamp preservation authoritative', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/a.txt', 'new', T + MIN);
  remote.put('/r/a.txt', 'old', T);
  const checklist = await sync.compare(local, '/l', remote, '/r', {
    direction: 'remote', criteria: 'time',
  });

  const q = makeQueue();
  const { items } = await sync.apply(checklist, q, {
    copyParam: { preserveTime: false, includeFileMask: '*.never-match' },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].copyParam.preserveTime, true,
    'a time comparison must carry the source timestamp into the transfer');
  assert.equal(items[0].copyParam.includeFileMask, '',
    'the already-filtered checklist must not be filtered a second time');
  await q.idle();
});

// ---------------------------------------------------------------------------
// keep remote directory up to date
// ---------------------------------------------------------------------------

test('startWatch uploads changes as they appear, and stopWatch stops it', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/first.txt', 'one', T);

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', intervalMs: 20,
  });

  try {
    // the immediate first pass catches what is already out of sync
    await waitFor(() => remote.has('/r/first.txt'), 4000, 'the initial upload');
    assert.strictEqual(remote.read('/r/first.txt').toString(), 'one');

    // a file created afterwards is picked up by a later tick
    local.put('/l/second.txt', 'two', T + MIN);
    await waitFor(() => remote.has('/r/second.txt'), 4000, 'the watched upload');
    assert.strictEqual(remote.read('/r/second.txt').toString(), 'two');
  } finally {
    sync.stopWatch(watcher);
  }

  assert.strictEqual(watcher.running, false);
  local.put('/l/third.txt', 'three', T + 2 * MIN);
  await sleep(80);
  assert.strictEqual(remote.has('/r/third.txt'), false, 'a stopped watcher enqueues nothing');
});

test('the watcher uses a native adapter watch when one is offered', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  let closed = false;
  let fire = null;
  local.watch = (path, cb) => { fire = cb; return { close() { closed = true; } }; };

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', intervalMs: 5,
  });
  assert.strictEqual(typeof fire, 'function', 'the native watcher must be used');
  assert.strictEqual(watcher._timer, null, 'no polling timer when a native watch exists');

  local.put('/l/a.txt', 'a', T);
  fire();
  await waitFor(() => remote.has('/r/a.txt'), 4000, 'the native-watch upload');

  sync.stopWatch(watcher);
  assert.strictEqual(closed, true, 'the native watcher is closed on stop');
});

test('syncOnStart false waits for a native change before comparing', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/already-there.txt', 'one', T);
  let fire;
  local.watch = (path, cb) => { fire = cb; return { close() {} }; };

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', syncOnStart: false,
  });
  try {
    await sleep(30);
    assert.equal(remote.has('/r/already-there.txt'), false,
      'disabling the initial comparison must not silently run it anyway');
    fire();
    await waitFor(() => remote.has('/r/already-there.txt'), 4000, 'the event-triggered upload');
  } finally {
    sync.stopWatch(watcher);
  }
});

test('native change bursts are coalesced into one comparison', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/burst.txt', 'burst', T);
  let fire;
  let localLists = 0;
  const originalList = local.list.bind(local);
  local.list = async (...args) => { localLists += 1; return originalList(...args); };
  local.watch = (path, cb) => { fire = cb; return { close() {} }; };

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', syncOnStart: false,
  });
  try {
    fire(); fire(); fire();
    await waitFor(() => remote.has('/r/burst.txt'), 4000, 'the coalesced upload');
    assert.equal(localLists, 1, 'three native notifications should schedule one comparison');
  } finally {
    sync.stopWatch(watcher);
  }
});

test('an item error emitted during queue.add does not leave a stale in-flight path', async () => {
  const { EventEmitter } = require('node:events');
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/fails.txt', 'fails', T);
  const queue = new EventEmitter();
  queue.add = (spec) => {
    const view = { source: spec.source };
    queue.emit('item-error', { item: view, error: new Error('queue rejected item') });
    return view;
  };

  const watcher = sync.startWatch(local, '/l', remote, '/r', queue, {
    direction: 'remote', criteria: 'time', syncOnStart: false,
  });
  try {
    await watcher.tick();
    assert.equal(watcher._inFlight.has('/l/fails.txt'), false,
      'cleanup that races queue.add must win over reservation bookkeeping');
  } finally {
    sync.stopWatch(watcher);
  }
});

test('removing a queued item releases the watcher in-flight guard', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/retry.txt', 'retry', T);
  const q = makeQueue();
  q.pauseAll();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', syncOnStart: false,
  });
  try {
    await watcher.tick();
    assert.equal(q.items.length, 1);
    assert.equal(watcher._inFlight.has('/l/retry.txt'), true);
    q.remove(q.items[0].id);
    await watcher.tick();
    assert.equal(q.items.length, 1,
      'the same changed file may be queued again after its previous row is removed');
  } finally {
    sync.stopWatch(watcher);
  }
});

test('a local-direction watcher uses the remote native change source', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  let fire;
  let watchedPath;
  remote.watch = (path, cb) => {
    watchedPath = path;
    fire = cb;
    return { close() {} };
  };
  local.watch = () => { throw new Error('the target side must not be watched'); };

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'local', criteria: 'time', intervalMs: 5,
  });
  try {
    assert.strictEqual(watchedPath, '/r');
    remote.put('/r/download.txt', 'remote', T);
    fire();
    await waitFor(() => local.has('/l/download.txt'), 4000, 'the native remote download');
    assert.strictEqual(local.read('/l/download.txt').toString(), 'remote');
  } finally {
    sync.stopWatch(watcher);
  }
});

test('a file mask does not prune directories before filtering their children', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  remote.putDir('/r/src');
  local.put('/l/src/keep.txt', 'a', T);
  local.put('/l/src/drop.log', 'a', T);

  const c = await sync.compare(local, '/l', remote, '/r', {
    direction: 'remote', criteria: 'time', recursive: true, fileMask: '*.txt',
  });
  assert.deepStrictEqual(summarize(c), [U('keep.txt')]);
});

test('excludeHiddenFiles removes hidden entries before they become checklist rows', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/.secret', 'secret', T);
  local.put('/l/visible.txt', 'visible', T);

  const hidden = await sync.compare(local, '/l', remote, '/r', {
    direction: 'remote', criteria: 'time', excludeHiddenFiles: true,
  });
  assert.deepEqual(hidden.items.map((item) => item.local.name), ['visible.txt']);
});

test('relative path masks are evaluated from each comparison root', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/src/keep.txt', 'new', T + MIN);
  remote.put('/r/src/keep.txt', 'old', T);
  local.put('/l/src/drop.log', 'new', T + MIN);
  remote.put('/r/src/drop.log', 'old', T);

  const c = await sync.compare(local, '/l', remote, '/r', {
    direction: 'remote', criteria: 'time', recursive: true, fileMask: 'src/*.txt',
  });
  assert.deepStrictEqual(summarize(c), [U('keep.txt')]);
});

test('case-insensitive updates preserve the existing target spelling', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/README.txt', 'new', T + MIN);
  remote.put('/r/readme.txt', 'old', T);

  const q = makeQueue();
  const checklist = await sync.compare(local, '/l', remote, '/r', {
    direction: 'remote', criteria: 'time', caseSensitive: false,
  });
  await sync.apply(checklist, q);
  await waitFor(() => remote.read('/r/readme.txt')?.toString() === 'new', 4000,
    'the case-preserving upload');
  assert.strictEqual(remote.has('/r/README.txt'), false, 'the update must not create a case-variant duplicate');
});

test('an invalid native change source stops the watcher before reporting the error', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  let fire;
  let closed = false;
  local.watch = (path, cb) => { fire = cb; return { close() { closed = true; } }; };

  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', intervalMs: 5,
  });
  const errors = [];
  watcher.on('error', (error) => errors.push(error));
  const invalid = new Error('watched directory disappeared');

  fire(invalid);
  fire();
  await sleep(30);

  assert.strictEqual(watcher.running, false);
  assert.strictEqual(closed, true);
  assert.deepStrictEqual(errors, [invalid]);
  assert.strictEqual(q.items.length, 0, 'an invalid monitor must enqueue no later change');
});

test('stopping during an in-flight comparison cannot enqueue its late result', async () => {
  const local = new MemoryAdapter('local');
  const remote = new MemoryAdapter('remote');
  local.putDir('/l'); remote.putDir('/r');
  local.put('/l/late.txt', 'late', T);
  const originalList = local.list.bind(local);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let blockedOnce = true;
  local.list = async (dir) => {
    if (blockedOnce) {
      blockedOnce = false;
      await blocked;
    }
    return originalList(dir);
  };
  const q = makeQueue();
  const watcher = sync.startWatch(local, '/l', remote, '/r', q, {
    direction: 'remote', criteria: 'time', intervalMs: 20,
  });
  sync.stopWatch(watcher);
  release();
  await sleep(30);
  assert.strictEqual(q.items.length, 0, 'a stopped watcher must discard late comparison results');
  assert.strictEqual(remote.has('/r/late.txt'), false);
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test('compareTime implements the two-second FAT window', () => {
  assert.strictEqual(sync.compareTime(1000, 1000), 0);
  assert.strictEqual(sync.compareTime(1000, 2999), 0);
  assert.strictEqual(sync.compareTime(1000, 3000), -1);
  assert.strictEqual(sync.compareTime(3000, 1000), 1);
  assert.strictEqual(sync.compareTime(1000, 1500, 100), -1, 'a custom tolerance is honoured');
  assert.strictEqual(sync.compareTime(1000, 1050, 100), 0);
});

test('validateOptions is exported for the UI to grey out impossible combinations', () => {
  assert.doesNotThrow(() => sync.validateOptions({
    ...sync.OPTION_DEFAULTS, direction: 'both', criteria: 'time', mode: 'synchronize',
  }));
  assert.throws(() => sync.validateOptions({
    ...sync.OPTION_DEFAULTS, direction: 'both', criteria: 'either', mode: 'synchronize',
  }), sync.SyncOptionError);
});

test('validateOptions refuses unsafe non-finite or negative clock settings', () => {
  for (const timeTolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => sync.validateOptions({
      ...sync.OPTION_DEFAULTS, timeTolerance,
    }), sync.SyncOptionError);
  }
  assert.throws(() => sync.validateOptions({
    ...sync.OPTION_DEFAULTS, timeDifference: Number.NEGATIVE_INFINITY,
  }), sync.SyncOptionError);
  assert.doesNotThrow(() => sync.validateOptions({
    ...sync.OPTION_DEFAULTS, timeTolerance: 0, timeDifference: -3600,
  }));
});

test('validateOptions refuses an unknown daylight-saving interpretation', () => {
  assert.throws(() => sync.validateOptions({
    ...sync.OPTION_DEFAULTS, dSTMode: 'mystery',
  }), /Unknown dSTMode/);
});
