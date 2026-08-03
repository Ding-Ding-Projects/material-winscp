// terminal.test.js — the session orchestrator.
//
// These tests are written against the *edge cases* found in core/Terminal.cpp,
// not the happy path: the ordering of a recursive delete, the recycle-bin
// decision that inverts on a modifier, the confirmation that must be asked
// before the ancestor check, the cache that must not be reloaded on a plain
// reload, and every branch of retry / skip / abort.
//
// Everything runs against an in-memory Adapter and a stand-in Session, so the
// suite is headless and deterministic.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Adapter, entry, DEFAULT_CAPS } = require('../design/main/protocols/base');
const T = require('../design/main/terminal');
const {
  Terminal, OperationProgress, DirectoryCache, DirectoryChangesCache,
  SkipFileError, AbortError, FatalError, TerminalError,
  classifyException, OPERATIONS, CANCEL, ANSWERS, DELETE_FLAGS, CALC_FLAGS, LOOP_FLAGS, SIDES,
} = T;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** An in-memory file system behind the real Adapter contract. */
class MemoryAdapter extends Adapter {
  constructor(caps) {
    super(null);
    this.caps = { ...DEFAULT_CAPS, rights: true, owner: true, symlink: true, timestamp: true, ...(caps || {}) };
    this.connected = true;
    this.home = '/home/me';
    this.nodes = new Map([['/', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }]]);
    this.calls = { list: 0, remove: [], rename: [], mkdir: [], setRights: [], setOwner: [], setTimes: [], symlink: [] };
    this.failNext = null;      // { op, error, times }
  }

  get protocolName() { return 'Memory'; }

  // --- fixture helpers ---
  add(path, node) {
    const p = this.normalize(path);
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      if (!this.nodes.has(cur)) this.nodes.set(cur, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
    }
    this.nodes.set(p, { type: 'file', size: 0, mtime: 0, rights: 'rw-r--r--', ...node });
    return this;
  }

  has(p) { return this.nodes.has(this.normalize(p)); }

  _maybeFail(op) {
    if (this.failNext && this.failNext.op === op) {
      if (this.failNext.times === undefined || this.failNext.times > 0) {
        if (this.failNext.times !== undefined) this.failNext.times--;
        const e = this.failNext.error;
        if (this.failNext.times === 0) this.failNext = null;
        if (e.code === 'ECONNRESET') this.connected = false;
        throw e;
      }
    }
  }

  _entryFor(p, node) {
    return entry({
      name: T.extractFileName(p) || '/',
      type: node.type,
      size: node.size || 0,
      mtime: node.mtime || 0,
      rights: node.rights || '',
      owner: node.owner || '',
      group: node.group || '',
      isSymlink: !!node.isSymlink,
      linkTarget: node.linkTarget || '',
    });
  }

  async list(dir) {
    this.calls.list++;
    this._maybeFail('list');
    const d = this.normalize(dir);
    const node = this.nodes.get(d);
    if (!node) { const e = new Error(`No such directory: ${d}`); e.code = 'ENOENT'; throw e; }
    if (node.type !== 'dir') { const e = new Error(`Not a directory: ${d}`); e.code = 'ENOTDIR'; throw e; }
    const prefix = d === '/' ? '/' : d + '/';
    const out = [];
    for (const [p, n] of this.nodes) {
      if (p === d || !p.startsWith(prefix)) continue;
      if (p.slice(prefix.length).includes('/')) continue;
      out.push(this._entryFor(p, n));
    }
    return out;
  }

  async stat(p) {
    this._maybeFail('stat');
    const n = this.nodes.get(this.normalize(p));
    if (!n) { const e = new Error(`No such file: ${p}`); e.code = 'ENOENT'; throw e; }
    return this._entryFor(this.normalize(p), n);
  }

  async mkdir(p, opts = {}) {
    this._maybeFail('mkdir');
    const t = this.normalize(p);
    this.calls.mkdir.push({ path: t, opts });
    if (this.nodes.has(t)) { const e = new Error(`Exists: ${t}`); e.code = 'EEXIST'; throw e; }
    if (!opts.recursive && !this.nodes.has(T.extractFileDir(t))) {
      const e = new Error(`No such parent: ${t}`); e.code = 'ENOENT'; throw e;
    }
    this.nodes.set(t, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
  }

  async remove(p, opts = {}) {
    this._maybeFail('remove');
    const t = this.normalize(p);
    this.calls.remove.push({ path: t, opts });
    const n = this.nodes.get(t);
    if (!n) { const e = new Error(`No such file: ${t}`); e.code = 'ENOENT'; throw e; }
    if (n.type === 'dir' && !n.isSymlink) {
      const prefix = t + '/';
      const children = [...this.nodes.keys()].filter((k) => k.startsWith(prefix));
      if (children.length && !opts.recursive) {
        const e = new Error(`Directory not empty: ${t}`); e.code = 'ENOTEMPTY'; throw e;
      }
      for (const c of children) this.nodes.delete(c);
    }
    this.nodes.delete(t);
  }

  async rename(from, to) {
    this._maybeFail('rename');
    const f = this.normalize(from);
    const t = this.normalize(to);
    this.calls.rename.push({ from: f, to: t });
    const n = this.nodes.get(f);
    if (!n) { const e = new Error(`No such file: ${f}`); e.code = 'ENOENT'; throw e; }
    if (this.nodes.has(t)) { const e = new Error(`Exists: ${t}`); e.code = 'EEXIST'; throw e; }
    for (const [k, v] of [...this.nodes]) {
      if (k === f || k.startsWith(f + '/')) {
        this.nodes.delete(k);
        this.nodes.set(t + k.slice(f.length), v);
      }
    }
  }

  async symlink(target, link) {
    this._maybeFail('symlink');
    this.calls.symlink.push({ target, link });
    this.nodes.set(this.normalize(link), { type: 'file', isSymlink: true, linkTarget: target, mtime: 0 });
  }

  async setRights(p, rights) {
    this._maybeFail('setRights');
    this.calls.setRights.push({ path: this.normalize(p), rights });
    const n = this.nodes.get(this.normalize(p));
    if (n) n.rights = rights;
  }

  async setOwner(p, owner, group) {
    this._maybeFail('setOwner');
    this.calls.setOwner.push({ path: this.normalize(p), owner, group });
  }

  async setTimes(p, mtime, atime) {
    this._maybeFail('setTimes');
    this.calls.setTimes.push({ path: this.normalize(p), mtime, atime });
  }
}

/** Everything Terminal asks of design/main/session.js, and nothing more. */
class FakeSession {
  constructor(adapter, data) {
    this.adapter = adapter;
    this.data = { protocol: 'sftp', hostName: 'h', cacheDirectories: true, cacheDirectoryChanges: true, ...(data || {}) };
    this.state = { remotePath: '/', localPath: '' };
    this.lines = [];
    this.log = {
      add: (kind, text) => { this.lines.push(`${kind}: ${text}`); },
      debug: (text) => { this.lines.push(`debug: ${text}`); },
    };
    this.config = { prefs: { confirmOverwriting: true, autoReadDirectoryAfterOp: true, security: {} } };
    this.invalidated = [];
    this.cleared = 0;
    this.reconnects = 0;
    this.disconnects = 0;
  }

  invalidate(p) { this.invalidated.push(p); }
  clearCache() { this.cleared++; }
  async disconnect() { this.disconnects++; this.adapter.connected = false; }
  async reconnect() { this.reconnects++; this.adapter.connected = true; }
  async ask() { return null; }
}

/**
 * Build a terminal with a scripted answer queue. Every query is recorded, and
 * running out of scripted answers is a test failure rather than a silent
 * default, so an unexpected prompt cannot pass unnoticed.
 */
function makeTerminal(options) {
  const o = options || {};
  const adapter = o.adapter || new MemoryAdapter(o.caps);
  const session = new FakeSession(adapter, o.data);
  if (o.prefs) Object.assign(session.config.prefs, o.prefs);
  const queries = [];
  const answers = (o.answers || []).slice();
  const terminal = new Terminal(session, {
    queryUser: async (q) => {
      queries.push(q);
      if (!answers.length) throw new Error(`Unexpected query: ${q.message} [${q.answers.join(',')}]`);
      return answers.shift();
    },
    now: o.now,
  });
  terminal.session.state.remotePath = o.cwd || '/';
  return { terminal, session, adapter, queries, answers };
}

// ===========================================================================
// path helpers — RemoteFiles.cpp
// ===========================================================================

test('unix path helpers keep WinSCP\'s exact trailing-slash rules', () => {
  // An empty path stays empty: turning "" into "/" would make an unknown
  // directory look like the root.
  assert.strictEqual(T.includeTrailingSlash(''), '');
  assert.strictEqual(T.includeTrailingSlash('/a'), '/a/');
  assert.strictEqual(T.includeTrailingSlash('/a/'), '/a/');
  // The root keeps its slash.
  assert.strictEqual(T.excludeTrailingSlash('/'), '/');
  assert.strictEqual(T.excludeTrailingSlash('/a/'), '/a');
  assert.strictEqual(T.excludeTrailingSlash(''), '');

  assert.ok(T.samePath('/a/b', '/a/b/'));
  assert.ok(!T.samePath('/a/b', '/a/bc'));

  assert.ok(T.isChildPath('/a', '/a/b'));
  assert.ok(T.isChildPath('/a', '/a'));
  assert.ok(!T.isChildPath('/a', '/ab/c'));

  assert.strictEqual(T.extractFileDir('/a/b'), '/a');
  assert.strictEqual(T.extractFileDir('/a'), '/');
  assert.strictEqual(T.extractFileDir('a'), '');
  assert.strictEqual(T.extractFilePath('/a/b'), '/a/');
  assert.strictEqual(T.extractFileName('/a/b'), 'b');
  assert.strictEqual(T.extractFileName('b'), 'b');
  assert.ok(T.isRootPath(''));
  assert.ok(T.isRootPath('/'));
  assert.ok(!T.isRealFile('.'));
  assert.ok(!T.isRealFile('..'));
  assert.ok(T.isRealFile('.hidden'));
});

test('expandFileName resolves one level of ".." and nothing more', () => {
  assert.strictEqual(T.expandFileName('sub', '/a/b'), '/a/b/sub');
  assert.strictEqual(T.expandFileName('..', '/a/b/c'), '/a/b');
  assert.strictEqual(T.expandFileName('/abs', '/a/b'), '/abs');
  // WinSCP's own TODO: "../.." is not resolved. Reproduced so the
  // directory-change cache keys match the original's.
  assert.strictEqual(T.expandFileName('../..', '/a/b/c'), '/a/b/c/../..');
});

test('maskFileName masks name and extension separately', () => {
  assert.strictEqual(T.maskFileName('report.txt', '*-old.*'), 'report-old.txt');
  assert.strictEqual(T.maskFileName('report.txt', '*.bak'), 'report.bak');
  assert.strictEqual(T.maskFileName('report.txt', 'copy?.*'), 'copyr.txt');
  // A leading dot is not a name/extension separator.
  assert.strictEqual(T.maskFileName('.bashrc', '*.bak'), '.bashrc.bak');
  // Non-effective masks leave the name alone.
  assert.strictEqual(T.maskFileName('report.txt', '*'), 'report.txt');
  assert.strictEqual(T.maskFileName('report.txt', '*.*'), 'report.txt');
  assert.strictEqual(T.maskFileName('report.txt', ''), 'report.txt');
});

// ===========================================================================
// exception classification — Exceptions.h
// ===========================================================================

test('exceptions are classified as fatal, skip, abort or plain error', () => {
  assert.strictEqual(classifyException(new AbortError()), 'abort');
  assert.strictEqual(classifyException(new SkipFileError('x')), 'skip');
  assert.strictEqual(classifyException(new FatalError('x')), 'fatal');

  const reset = new Error('read'); reset.code = 'ECONNRESET';
  assert.strictEqual(classifyException(reset), 'fatal');
  const notConnected = new Error('nope'); notConnected.code = 'NOT_CONNECTED';
  assert.strictEqual(classifyException(notConnected), 'fatal');
  assert.strictEqual(classifyException(new Error('socket hang up')), 'fatal');
  assert.strictEqual(classifyException(new Error('The connection was lost')), 'fatal');

  // A protocol error is NOT fatal: tearing down a working session because one
  // file was unreadable is worse than retrying the file.
  const perm = new Error('Permission denied'); perm.code = 'EACCES';
  assert.strictEqual(classifyException(perm), 'error');
  const noent = new Error('No such file'); noent.code = 'ENOENT';
  assert.strictEqual(classifyException(noent), 'error');
});

// ===========================================================================
// TRemoteDirectoryCache
// ===========================================================================

test('the directory cache is timestamped, copy-on-read and slash-insensitive', () => {
  const c = new DirectoryCache();
  c.addFileList({ directory: '/a/', timestamp: 100, files: [{ name: 'f' }] });

  assert.ok(c.hasFileList('/a'));
  assert.ok(c.hasFileList('/a/'));
  assert.ok(c.hasNewerFileList('/a', 99));
  assert.ok(!c.hasNewerFileList('/a', 100), 'equal timestamps are not newer');
  assert.ok(!c.hasNewerFileList('/b', 0));

  const got = c.getFileList('/a');
  got.files.push({ name: 'injected' });
  assert.strictEqual(c.getFileList('/a').files.length, 1, 'the cache handed out a live reference');
  assert.strictEqual(c.getFileList('/nope'), null);
});

test('clearing a directory optionally takes its whole subtree with it', () => {
  const c = new DirectoryCache();
  for (const d of ['/a', '/a/b', '/a/b/c', '/ab', '/z']) {
    c.addFileList({ directory: d, timestamp: 1, files: [] });
  }

  assert.deepStrictEqual(c.clearFileList('/a', false), ['/a']);
  assert.ok(c.hasFileList('/a/b'), 'a non-recursive clear must not touch children');

  const removed = c.clearFileList('/a', true).sort();
  assert.deepStrictEqual(removed, ['/a/b', '/a/b/c']);
  assert.ok(c.hasFileList('/ab'), '"/ab" is not a child of "/a"');
  assert.ok(c.hasFileList('/z'));
});

// ===========================================================================
// TRemoteDirectoryChangesCache
// ===========================================================================

test('the directory-changes cache remembers where a relative cd landed', () => {
  const c = new DirectoryChangesCache(100);
  c.addDirectoryChange('/home/me', 'link', '/var/data');

  assert.strictEqual(c.getDirectoryChange('/home/me', 'link'), '/var/data');
  assert.strictEqual(c.getDirectoryChange('/other', 'link'), null);
  // A target directory answers for itself.
  assert.strictEqual(c.getDirectoryChange('', '/var/data'), '/var/data');
});

test('a change whose target is just the expanded path is not stored twice', () => {
  const c = new DirectoryChangesCache(100);
  c.addDirectoryChange('/home/me', 'sub', '/home/me/sub');
  // Only the "//" self entry — the relative key would be redundant.
  assert.strictEqual(c.getDirectoryChange('/home/me', 'sub'), '/home/me/sub');
  assert.ok(!c.isEmpty);
});

test('clearing by source and by target both work, including the symlink hack', () => {
  const c = new DirectoryChangesCache(100);
  c.addDirectoryChange('/home/me', 'link', '/var/data');
  c.clearDirectoryChange('/home/me');
  assert.strictEqual(c.getDirectoryChange('/home/me', 'link'), null);

  const c2 = new DirectoryChangesCache(100);
  c2.addDirectoryChange('/home/me', 'link', '/var/data');
  c2.clearDirectoryChangeTarget('/var/data');
  assert.strictEqual(c2.getDirectoryChange('/home/me', 'link'), null);

  // Deleting the symlink itself drops the hop that went through its name.
  const c3 = new DirectoryChangesCache(100);
  c3.addDirectoryChange('/home/me', 'link', '/var/data');
  c3.clearDirectoryChangeTarget('/home/me/link');
  assert.strictEqual(c3.getDirectoryChange('/home/me', 'link'), null);
});

test('directory-change invalidation respects path boundaries', () => {
  const bySource = new DirectoryChangesCache(100);
  bySource.addDirectoryChange('/a', 'one', '/target-one');
  bySource.addDirectoryChange('/ab', 'two', '/target-two');
  bySource.clearDirectoryChange('/a');
  assert.strictEqual(bySource.getDirectoryChange('/ab', 'two'), '/target-two');

  const byTarget = new DirectoryChangesCache(100);
  byTarget.addDirectoryChange('/x', 'link', '/var/data');
  byTarget.addDirectoryChange('/y', 'link', '/var/database');
  byTarget.clearDirectoryChangeTarget('/var/data');
  assert.strictEqual(byTarget.getDirectoryChange('/y', 'link'), '/var/database');
});

test('the changes cache serializes only its newest maxSize entries', () => {
  const c = new DirectoryChangesCache(2);
  c.addDirectoryChange('/a', 'x', '/1');
  c.addDirectoryChange('/b', 'y', '/2');
  c.addDirectoryChange('/c', 'z', '/3');
  const data = c.serialize();
  assert.ok(data.startsWith('A'));

  const restored = new DirectoryChangesCache(2);
  restored.deserialize(data);
  assert.strictEqual(restored.getDirectoryChange('/c', 'z'), '/3');
  assert.strictEqual(restored.getDirectoryChange('/a', 'x'), null, 'the oldest entry should have been dropped');

  const empty = new DirectoryChangesCache(2);
  empty.deserialize('');
  assert.ok(empty.isEmpty);
});

// ===========================================================================
// OperationProgress — the "operation finished" accounting
// ===========================================================================

test('progress counts every finished file and only the successful ones twice', () => {
  const finished = [];
  const p = new OperationProgress(() => {}, (...a) => finished.push(a));
  p.start(OPERATIONS.delete, SIDES.remote, 3, { now: 1000 });

  p.finish('a', true);
  p.finish('b', false);
  p.finish('c', true);

  assert.strictEqual(p.filesFinished, 3);
  assert.strictEqual(p.filesFinishedSuccessfully, 2);
  assert.strictEqual(finished.length, 3);
  assert.strictEqual(finished[1][4], false, 'the failed file reports success=false');
  assert.strictEqual(finished[0][5], true, 'notCancelled is true while the operation runs');
});

test('a file finished after cancellation reports notCancelled=false', () => {
  const finished = [];
  const p = new OperationProgress(() => {}, (...a) => finished.push(a));
  p.start(OPERATIONS.delete, SIDES.remote, 1);
  p.setCancel(CANCEL.cancel);
  p.finish('a', false);
  assert.strictEqual(finished[0][5], false);
});

test('statistics separate uploads, downloads and deletions by side', () => {
  const p = new OperationProgress();
  p.start(OPERATIONS.copy, SIDES.local, 1);
  p.transferredSize = 500;
  p.succeeded();
  assert.strictEqual(p.statistics.filesUploaded, 1);
  assert.strictEqual(p.statistics.totalUploaded, 500);
  assert.strictEqual(p.statistics.filesDownloaded, 0);

  const q = new OperationProgress();
  q.start(OPERATIONS.delete, SIDES.remote, 2);
  q.succeeded();
  q.succeeded();
  assert.strictEqual(q.statistics.filesDeletedRemote, 2);
  assert.strictEqual(q.statistics.filesDeletedLocal, 0);
});

test('cancel never downgrades and a stopped transfer folds its remainder into skipped', () => {
  const p = new OperationProgress();
  p.start(OPERATIONS.copy, SIDES.remote, 1);
  p.setCancel(CANCEL.cancel);
  p.setCancelAtLeast(CANCEL.cancelFile);
  assert.strictEqual(p.cancel, CANCEL.cancel, 'a weaker cancel must not undo a stronger one');
  p.setCancelAtLeast(CANCEL.remoteAbort);
  assert.strictEqual(p.cancel, CANCEL.remoteAbort);

  const q = new OperationProgress();
  q.start(OPERATIONS.copy, SIDES.remote, 1);
  q.transferSize = 1000;
  q.addTransferred(400);
  q.stop();
  assert.strictEqual(q.totalSkipped, 600, 'the 600 bytes never transferred must be accounted for');
});

test('a direct cancellation request also cannot downgrade an operation', () => {
  const p = new OperationProgress();
  p.start(OPERATIONS.copy, SIDES.remote, 1);
  p.setCancel(CANCEL.cancel);
  p.setCancel(CANCEL.cancelFile);
  assert.strictEqual(p.cancel, CANCEL.cancel);
  p.stop();
  assert.strictEqual(p.done, true);
  assert.strictEqual(p.snapshot().done, true);
});

test('the terminal cancellation seam reaches the active foreground progress', () => {
  const { terminal } = makeTerminal();
  const progress = new OperationProgress();
  terminal.operationStart(progress, OPERATIONS.copy, SIDES.remote, 1);
  assert.strictEqual(terminal.cancelOperation(), true);
  assert.strictEqual(progress.cancel, CANCEL.cancel);
  terminal.operationStop(progress);
  assert.strictEqual(terminal.cancelOperation(), false, 'a finished operation cannot be cancelled');
});

test('suspending shifts the start time so a modal question does not wreck the rate', () => {
  const p = new OperationProgress();
  p.start(OPERATIONS.copy, SIDES.remote, 1, { now: 1000 });
  p.suspend(2000);
  p.resume(5000);
  assert.strictEqual(p.startTime, 4000, 'the 3s spent suspended is added back to the start');
  assert.strictEqual(p.suspended, false);
  // Resuming twice is a no-op rather than a double shift.
  p.resume(9000);
  assert.strictEqual(p.startTime, 4000);
});

test('starting a second operation clears the batch answers of the first', async () => {
  // TFileOperationProgressType::Start -> DoClear(Batch) -> TPersistence::Clear
  // resets SkipToAll and BatchOverwrite. A progress object reused without that
  // carries "skip all" into the next operation and silently skips every file
  // of it because of an answer given about entirely different files.
  const p = new OperationProgress();
  p.start(OPERATIONS.copy, SIDES.remote, 1);
  p.setSkipToAll();
  p.setBatchOverwrite('all');
  p.transferSize = 100;
  p.addTransferred(40);
  p.stop();
  assert.strictEqual(p.totalSkipped, 60);

  p.start(OPERATIONS.delete, SIDES.remote, 2);
  assert.strictEqual(p.skipToAll, false, 'a new operation asks its own questions');
  assert.strictEqual(p.batchOverwrite, 'no');
  assert.strictEqual(p.totalSkipped, 0);
  assert.strictEqual(p.totalTransferred, 0);
  assert.strictEqual(p.fileName, '');
});

test('a remote operation reports the file name, not the whole path', async () => {
  // SetFile keeps the full path in FullFileName and the bare name in FileName
  // for the remote side, because the progress surface has a column for a name.
  const p = new OperationProgress();
  p.start(OPERATIONS.delete, SIDES.remote, 1);
  p.setFile('/home/me/deep/report.txt');
  assert.strictEqual(p.fileName, 'report.txt');
  assert.strictEqual(p.fullFileName, '/home/me/deep/report.txt');

  // The local side keeps whatever it was given: those are Windows paths and
  // the unix splitter would mangle them.
  const q = new OperationProgress();
  q.start(OPERATIONS.copy, SIDES.local, 1);
  q.setFile('C:\\tmp\\report.txt');
  assert.strictEqual(q.fileName, 'C:\\tmp\\report.txt');
});

test('a numbered partial file counts as temporary, not just ".filepart"', async () => {
  // TemporaryTransferFile is GetPartialFileExtLen() > 0, so the disambiguated
  // form a resumed transfer writes ("report.filepart.2") is temporary too — a
  // plain endsWith(".filepart") test would count it as a real file and make
  // the calculated size disagree with what the transfer actually moves.
  const build = () => {
    const t = makeTerminal({ cwd: '/' });
    t.adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
    t.adapter.add('/d/keep.txt', { size: 10 });
    t.adapter.add('/d/half.filepart', { size: 20 });
    t.adapter.add('/d/other.filepart.2', { size: 40 });
    return t;
  };
  const dir = { name: 'd', type: 'dir', fullFileName: '/d', directory: '/' };

  const all = await build().terminal.calculateFilesSize([dir], { copyParam: {} });
  assert.strictEqual(all.size, 70, 'without the flag a partial file is just a file');

  const some = await build().terminal.calculateFilesSize([dir], {
    copyParam: {}, params: CALC_FLAGS.disallowTemporaryTransferFiles,
  });
  assert.strictEqual(some.size, 10, 'both partial forms are excluded');
});

// ===========================================================================
// directory reading and caching
// ===========================================================================

test('a directory read is cached and served from the cache on a plain reload', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', { size: 1 });

  await terminal.readDirectory(false);
  assert.strictEqual(adapter.calls.list, 1);
  assert.strictEqual(terminal.files.files.length, 1);
  assert.strictEqual(terminal.files.files[0].fullFileName, '/d/a.txt');

  // A *reload* deliberately does NOT serve the cache — the user asked for
  // fresh data — so it costs another listing. ("Cached directory not
  // reloaded" in the log means the cached copy was not used for the reload.)
  await terminal.readDirectory(true);
  assert.strictEqual(adapter.calls.list, 2);

  // forceCache is the exception: RefreshDirectory uses it to take the cached
  // copy it already knows is newer.
  await terminal.readDirectory(true, true);
  assert.strictEqual(adapter.calls.list, 2);

  // An ordinary (non-reload) read with the cache present uses the cache.
  await terminal.readDirectory(false);
  assert.strictEqual(adapter.calls.list, 2);
});

test('caching off means every read reaches the server', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', data: { cacheDirectories: false } });
  adapter.add('/d/a.txt', {});
  await terminal.readDirectory(false);
  await terminal.readDirectory(false);
  assert.strictEqual(adapter.calls.list, 2);

  // Refresh is a no-op with caching off, rather than a silent reload.
  await terminal.refreshDirectory();
  assert.strictEqual(adapter.calls.list, 2);
});

test('invalidating a directory clears the terminal cache and the session panel cache', async () => {
  const { terminal, session, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/sub/a.txt', {});
  await terminal.readDirectory(false);
  terminal.cache.addFileList({ directory: '/d/sub', timestamp: 1, files: [] });

  terminal.directoryModified('/d', true);
  assert.ok(!terminal.cache.hasFileList('/d'));
  assert.ok(!terminal.cache.hasFileList('/d/sub'));
  assert.ok(session.invalidated.includes('/d'), 'the session cache must be told too');
  assert.ok(session.invalidated.includes('/d/sub'));
  assert.strictEqual(terminal.files.timestamp, 0, 'the loaded listing is stale now and must say so');
});

test('refreshDirectory only reloads when the cache genuinely holds something newer', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', {});
  await terminal.readDirectory(false);
  const listsAfterFirst = adapter.calls.list;

  await terminal.refreshDirectory();
  assert.strictEqual(adapter.calls.list, listsAfterFirst, 'nothing newer, so nothing to do');

  terminal.cache.addFileList({ directory: '/d', timestamp: terminal.files.timestamp + 1000, files: [] });
  await terminal.refreshDirectory();
  assert.strictEqual(terminal.files.files.length, 0, 'the newer cached copy should have replaced the listing');
});

test('readDirectoryListing filters with the mask but caches the whole directory', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', { size: 10 });
  adapter.add('/d/b.log', { size: 20 });
  adapter.add('/d/c.txt', { size: 30 });

  const filtered = await terminal.readDirectoryListing('/d', '*.txt');
  assert.deepStrictEqual(filtered.files.map((f) => f.name).sort(), ['a.txt', 'c.txt']);

  const unfiltered = await terminal.customReadDirectoryListing('/d', false);
  assert.strictEqual(unfiltered.files.length, 3, 'the mask must not truncate what other callers see');
});

test('a listing that fails because the connection dropped is retried after reconnecting', async () => {
  const { terminal, adapter, session, queries } = makeTerminal({
    cwd: '/d', answers: [ANSWERS.retry],
  });
  adapter.add('/d/a.txt', {});
  const lost = new Error('read ECONNRESET'); lost.code = 'ECONNRESET';
  adapter.failNext = { op: 'list', error: lost, times: 1 };

  const files = await terminal.readDirectory(false);
  assert.strictEqual(session.reconnects, 1, 'the session should have been reopened');
  assert.strictEqual(files.files.length, 1, 'and the listing retried');
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(queries[0].type, 'error');
  assert.deepStrictEqual(queries[0].answers, [ANSWERS.retry, ANSWERS.abort]);
});

test('refusing to reconnect leaves the error reported, not swallowed', async () => {
  const { terminal, adapter, session } = makeTerminal({
    cwd: '/d', answers: [ANSWERS.abort],
  });
  const lost = new Error('read ECONNRESET'); lost.code = 'ECONNRESET';
  adapter.failNext = { op: 'list', error: lost, times: 10 };

  await assert.rejects(() => terminal.readDirectory(false), (e) => classifyException(e) === 'fatal');
  assert.strictEqual(session.reconnects, 0);
  // The transport already dropped, so there is nothing left to close; the
  // session must not be reopened behind the user's "abort".
  assert.strictEqual(session.disconnects, 0);
});

test('a listing that keeps dropping runs out of its reconnect budget', async () => {
  // Terminal.cpp:3759-3761 — "To match FTP upload/download, we also limit
  // directory listing. For simplicity, we limit it unconditionally, for all
  // protocols for any kind of errors." A directory that is unreadable because
  // the transport keeps dying must eventually be reported rather than re-listed
  // for the rest of the session.
  let clock = 1000;
  const { terminal, adapter, session, queries } = makeTerminal({
    cwd: '/d',
    now: () => clock,
    prefs: { security: { sessionReopenTimeout: 5000 } },
    answers: [ANSWERS.retry, ANSWERS.retry, ANSWERS.retry],
  });
  adapter.add('/d/a.txt', {});

  let attempts = 0;
  adapter.list = async () => {
    attempts += 1;
    clock += 4000;                     // under the ceiling on its own attempt...
    adapter.connected = false;
    const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET';
    throw e;
  };

  await assert.rejects(() => terminal.readDirectory(false), (e) => classifyException(e) === 'fatal');
  assert.strictEqual(attempts, 2, '...but cumulative, so the second drop is past it');
  assert.strictEqual(session.reconnects, 1);
  assert.strictEqual(queries.length, 1);
  assert.ok(session.lines.some((l) => /Retry interval expired, will not retry transfer/.test(l)));
});

test('a listing budget is not handed a fresh window by a transfer that moved bytes', async () => {
  // The flag CustomReadDirectory gives the loop is a FUNCTION-LOCAL that
  // nothing ever raises (Terminal.cpp:3760), not the terminal-wide
  // FFileTransferAny that DoProgress sets on every byte (Terminal.cpp:2277).
  // Binding the listing to the terminal's flag instead lets a transfer running
  // on the same session restart the listing's window, and an unreadable
  // directory is then re-listed for as long as anything else is downloading.
  let clock = 1000;
  const { terminal, adapter, session } = makeTerminal({
    cwd: '/d',
    now: () => clock,
    prefs: { security: { sessionReopenTimeout: 5000 } },
    answers: [ANSWERS.retry, ANSWERS.retry, ANSWERS.retry],
  });
  adapter.add('/d/a.txt', {});

  let attempts = 0;
  adapter.list = async () => {
    attempts += 1;
    // Exactly what terminal.js's own progress callback does when a byte lands
    // on some other operation sharing this terminal.
    terminal.fileTransferAny = true;
    clock += 4000;
    adapter.connected = false;
    const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET';
    throw e;
  };

  await assert.rejects(() => terminal.readDirectory(false), (e) => classifyException(e) === 'fatal');
  assert.strictEqual(attempts, 2, 'the transfer\'s progress must not reset the listing budget');
  assert.ok(session.lines.some((l) => /Retry interval expired, will not retry transfer/.test(l)));
  // And the listing must not have eaten the flag the transfer set, either.
  assert.strictEqual(terminal.fileTransferAny, true);
});

test('a robust loop reports outward that it saw bytes move', async () => {
  // Terminal.cpp:546. The reset arm sets FPrevAnyTransfer as well as restarting
  // the window, and the destructor hands that back to whichever scope owns the
  // flag. Skip it and an enclosing loop is told "nothing moved" by an operation
  // that moved bytes, and expires a window it should have restarted.
  const { terminal, adapter } = makeTerminal({ answers: [ANSWERS.retry] });
  const loop = new T.RobustLoop(terminal, null, { anyTransfer: terminal });
  assert.strictEqual(terminal.fileTransferAny, false, 'the constructor zeroes the borrowed flag');

  terminal.fileTransferAny = true;                 // a chunk landed
  adapter.connected = false;
  const lost = new Error('read ECONNRESET'); lost.code = 'ECONNRESET';

  assert.strictEqual(await loop.tryReopen(lost), true);
  assert.strictEqual(terminal.fileTransferAny, false, 'the reset arm consumes the flag');
  loop.dispose();
  assert.strictEqual(terminal.fileTransferAny, true,
    'and the destructor reports the progress outwards');
});

test('a robust loop with no flag has no reconnect budget at all', async () => {
  // The half of TryReopen that is easy to read backwards: ContinueReopen is
  // only ever called inside `if (FAnyTransfer != NULL)` (Terminal.cpp:538-559),
  // so a loop built without a flag ignores SessionReopenTimeout entirely. This
  // is what every non-FTP transfer gets, and it is deliberate.
  let clock = 1000;
  const { terminal, adapter, session } = makeTerminal({
    now: () => clock,
    prefs: { security: { sessionReopenTimeout: 5000 } },
    answers: [ANSWERS.retry],
  });
  const loop = new T.RobustLoop(terminal, null, {});
  clock += 1000 * 1000;                            // long past any ceiling
  adapter.connected = false;
  const lost = new Error('read ECONNRESET'); lost.code = 'ECONNRESET';

  assert.strictEqual(await loop.tryReopen(lost), true, 'still reconnects');
  assert.strictEqual(session.reconnects, 1);
  assert.ok(!session.lines.some((l) => /Retry interval expired/.test(l)));
});

test('retryOnFatal reconnects before retrying the command', async () => {
  const { terminal, adapter, session } = makeTerminal({ answers: [ANSWERS.retry] });
  let attempts = 0;
  const value = await terminal.fileOperationLoop(async () => {
    attempts++;
    if (attempts === 1) {
      adapter.connected = false;
      const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET';
      throw e;
    }
    return 'ok';
  }, { flags: LOOP_FLAGS.retryOnFatal, message: 'The command failed.' });
  assert.strictEqual(value, 'ok');
  assert.strictEqual(attempts, 2);
  assert.strictEqual(session.reconnects, 1);
});

test('the reconnect budget is one function, and zero still means forever', () => {
  // TTerminal::ContinueReopen (Terminal.cpp:2459-2464). The arithmetic is
  // exported because design/main/queue.js asks the same question about the same
  // preference: a queued transfer reaches this decision upstream by calling
  // TTerminal::CopyToRemote (Queue.cpp:2324), so a second copy of
  // `timeout === 0 || elapsed < timeout` living in the queue is how a setting
  // ends up honoured on one transfer path and ignored on the other.
  assert.strictEqual(typeof T.continueReopen, 'function',
    'queue.js imports this; it has to exist');

  // Zero is the SHIPPED DEFAULT (defaults.js:384) and it means indefinitely,
  // however long the outage has run.
  const forever = { security: { sessionReopenTimeout: 0 } };
  assert.strictEqual(T.continueReopen(forever, 0, 1), true);
  assert.strictEqual(T.continueReopen(forever, 0, 86400000), true);
  // A missing preferences object must not accidentally become a budget.
  assert.strictEqual(T.continueReopen(undefined, 0, 86400000), true);
  assert.strictEqual(T.continueReopen({}, 0, 86400000), true);

  const bounded = { security: { sessionReopenTimeout: 5000 } };
  assert.strictEqual(T.continueReopen(bounded, 1000, 5999), true);
  assert.strictEqual(T.continueReopen(bounded, 1000, 6000), false, 'the boundary is exclusive');
  assert.strictEqual(T.continueReopen(bounded, 1000, 60000), false);

  // And the terminal's own method must BE that function, not a twin of it.
  let clock = 1000;
  const { terminal } = makeTerminal({
    now: () => clock,
    prefs: { security: { sessionReopenTimeout: 5000 } },
  });
  for (const elapsed of [0, 4999, 5000, 50000]) {
    clock = 1000 + elapsed;
    assert.strictEqual(terminal.continueReopen(1000),
      T.continueReopen(terminal.prefs, 1000, clock),
      `the two disagreed after ${elapsed}ms`);
  }
});

test('a fatal error on a still-open session closes it before reporting', async () => {
  const { terminal, adapter, session } = makeTerminal({ cwd: '/d' });
  // Fatal by message while the transport still claims to be up: WinSCP closes
  // first, because a half-open session answers "connected" to the next command
  // and turns one failure into a cascade.
  adapter.failNext = { op: 'list', error: new Error('The connection was lost'), times: 10 };

  await assert.rejects(() => terminal.readDirectory(false), (e) => classifyException(e) === 'fatal');
  assert.strictEqual(session.disconnects, 1);
  assert.strictEqual(terminal.active, false);
});

// ===========================================================================
// transactions
// ===========================================================================

test('inside a transaction directory rereads are deferred and coalesced', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', {});

  terminal.beginTransaction();
  assert.ok(terminal.inTransaction());
  await terminal.reactOnCommand('deleteFile');
  await terminal.reactOnCommand('deleteFile');
  await terminal.reactOnCommand('deleteFile');
  assert.strictEqual(adapter.calls.list, 0, 'no reads while the transaction is open');

  await terminal.endTransaction();
  assert.strictEqual(adapter.calls.list, 1, 'exactly one read when it closes');
  assert.ok(!terminal.inTransaction());
});

test('ending a transaction that was never begun is refused', async () => {
  const { terminal } = makeTerminal();
  await assert.rejects(() => terminal.endTransaction(), TerminalError);
});

test('nested transactions only flush at the outermost end', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', {});
  terminal.beginTransaction();
  terminal.beginTransaction();
  await terminal.reactOnCommand('deleteFile');
  await terminal.endTransaction();
  assert.strictEqual(adapter.calls.list, 0);
  await terminal.endTransaction();
  assert.strictEqual(adapter.calls.list, 1);
});

test('autoReadDirectoryAfterOp off means a file operation does not reread', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', prefs: { autoReadDirectoryAfterOp: false } });
  adapter.add('/d/a.txt', {});
  await terminal.reactOnCommand('deleteFile');
  assert.strictEqual(adapter.calls.list, 0);
});

test('a local copy operation rereads the current directory like a remote copy', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a.txt', {});

  await terminal.reactOnCommand('copyToLocal');

  assert.strictEqual(adapter.calls.list, 1,
    'a completed local copy must not leave the panel cache stale');
});

test('local copy rereads are coalesced inside a transaction', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  terminal.beginTransaction();

  await terminal.reactOnCommand('copyToLocal');
  assert.strictEqual(adapter.calls.list, 0);

  await terminal.endTransaction();
  assert.strictEqual(adapter.calls.list, 1);
});

// ===========================================================================
// ProcessFiles — the operation loop
// ===========================================================================

test('processFiles finishes every file and reports success per file', async () => {
  const { terminal } = makeTerminal();
  const seen = [];
  const finished = [];
  terminal.on('finished', (r) => finished.push(r));

  const ok = await terminal.processFiles(['/a', '/b'], OPERATIONS.delete, async (name) => {
    seen.push(name);
  });

  assert.strictEqual(ok, true);
  assert.deepStrictEqual(seen, ['/a', '/b']);
  assert.deepStrictEqual(finished.map((f) => f.success), [true, true]);
  assert.strictEqual(terminal.lastOperation.filesFinishedSuccessfully, 2);
});

test('a skipped file is swallowed and the loop continues; the count still records it', async () => {
  const { terminal } = makeTerminal();
  const seen = [];
  const ok = await terminal.processFiles(['/a', '/b', '/c'], OPERATIONS.delete, async (name) => {
    seen.push(name);
    if (name === '/b') throw new SkipFileError('nope');
  });

  assert.strictEqual(ok, true, 'skipping a file does not fail the operation');
  assert.deepStrictEqual(seen, ['/a', '/b', '/c']);
  assert.strictEqual(terminal.lastOperation.filesFinished, 3);
  assert.strictEqual(terminal.lastOperation.filesFinishedSuccessfully, 2);
});

test('with exceptionOnFail set a skipped file is rethrown instead of swallowed', async () => {
  const { terminal } = makeTerminal();
  terminal.setExceptionOnFail(true);
  await assert.rejects(
    () => terminal.processFiles(['/a'], OPERATIONS.delete, async () => { throw new SkipFileError('nope'); }),
    SkipFileError);
  terminal.setExceptionOnFail(false);
  assert.strictEqual(terminal.exceptionOnFail, false);
});

test('turning exceptionOnFail off when it is already zero is an error', () => {
  const { terminal } = makeTerminal();
  assert.throws(() => terminal.setExceptionOnFail(false), TerminalError);
});

test('cancelling mid-list stops the loop there and reports failure', async () => {
  const { terminal } = makeTerminal();
  const seen = [];
  const ok = await terminal.processFiles(['/a', '/b', '/c'], OPERATIONS.delete, async (name) => {
    seen.push(name);
    if (name === '/b') terminal.operationProgress.setCancel(CANCEL.cancel);
  });

  assert.strictEqual(ok, false, 'a cancelled operation did not complete');
  assert.deepStrictEqual(seen, ['/a', '/b'], '/c must never be touched');
});

test('an abort propagates out of processFiles and still stops the operation cleanly', async () => {
  const { terminal } = makeTerminal();
  await assert.rejects(
    () => terminal.processFiles(['/a'], OPERATIONS.delete, async () => { throw new AbortError(); }),
    AbortError);
  assert.strictEqual(terminal.operationProgress, null, 'the progress must be popped even on abort');
  assert.strictEqual(terminal.lastOperation.filesFinished, 1);
});

// ===========================================================================
// delete
// ===========================================================================

test('deleting a directory removes its contents first, deepest last', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/' });
  adapter.add('/d/f1', {});
  adapter.add('/d/sub/f2', {});

  const dir = { name: 'd', type: 'dir', fullFileName: '/d', directory: '/', isSymlink: false };
  await terminal.deleteFile('/d', dir, 0);

  assert.deepStrictEqual(adapter.calls.remove.map((r) => r.path),
    ['/d/f1', '/d/sub/f2', '/d/sub', '/d']);
  assert.ok(!adapter.has('/d'));
});

test('a symlinked directory is unlinked, never walked into', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/' });
  adapter.add('/real/secret', {});
  adapter.nodes.set('/link', { type: 'dir', isSymlink: true, linkTarget: '/real', mtime: 0 });

  const link = { name: 'link', type: 'dir', fullFileName: '/link', directory: '/', isSymlink: true };
  await terminal.deleteFile('/link', link, 0);

  assert.deepStrictEqual(adapter.calls.remove.map((r) => r.path), ['/link']);
  assert.ok(adapter.has('/real/secret'), 'deleting through a symlink would destroy files outside the selection');
});

test('followDirectorySymlinks makes a symlinked directory recursable again', async () => {
  const { terminal } = makeTerminal({ data: { followDirectorySymlinks: true } });
  assert.ok(terminal.canRecurseToDirectory({ isSymlink: true }));
  const { terminal: t2 } = makeTerminal();
  assert.ok(!t2.canRecurseToDirectory({ isSymlink: true }));
  assert.ok(t2.canRecurseToDirectory({ isSymlink: false }));
});

test('the recycle bin is used, or bypassed, exactly as WinSCP decides', async () => {
  // deleteToRecycleBin on: the file is MOVED, with a timestamp in its name.
  const fixed = new Date(Date.UTC(2026, 7, 2, 3, 4, 5)).getTime();
  const a = makeTerminal({
    cwd: '/home', data: { deleteToRecycleBin: true, recycleBinPath: '/trash' },
    now: () => fixed,
  });
  a.adapter.add('/home/gone.txt', {});
  a.adapter.nodes.set('/trash', { type: 'dir', mtime: 0 });
  const f = { name: 'gone.txt', type: 'file', fullFileName: '/home/gone.txt', directory: '/home' };
  await a.terminal.deleteFile('/home/gone.txt', f, 0);

  assert.strictEqual(a.adapter.calls.remove.length, 0, 'recycling must not delete');
  assert.strictEqual(a.adapter.calls.rename.length, 1);
  assert.ok(/^\/trash\/gone-\d{8}-\d{6}\.txt$/.test(a.adapter.calls.rename[0].to),
    `unexpected recycle name: ${a.adapter.calls.rename[0].to}`);

  // dfForceDelete bypasses the bin entirely.
  const b = makeTerminal({ cwd: '/home', data: { deleteToRecycleBin: true, recycleBinPath: '/trash' } });
  b.adapter.add('/home/gone.txt', {});
  await b.terminal.deleteFile('/home/gone.txt', { name: 'gone.txt', type: 'file' }, DELETE_FLAGS.forceDelete);
  assert.deepStrictEqual(b.adapter.calls.remove.map((r) => r.path), ['/home/gone.txt']);

  // dfAlternative INVERTS the preference: with recycling on it deletes.
  const c = makeTerminal({ cwd: '/home', data: { deleteToRecycleBin: true, recycleBinPath: '/trash' } });
  c.adapter.add('/home/gone.txt', {});
  await c.terminal.deleteFile('/home/gone.txt', { name: 'gone.txt', type: 'file' }, DELETE_FLAGS.alternative);
  assert.deepStrictEqual(c.adapter.calls.remove.map((r) => r.path), ['/home/gone.txt']);

  // ...and with recycling off it recycles.
  const d = makeTerminal({ cwd: '/home', data: { deleteToRecycleBin: false, recycleBinPath: '/trash' } });
  d.adapter.add('/home/gone.txt', {});
  d.adapter.nodes.set('/trash', { type: 'dir', mtime: 0 });
  await d.terminal.deleteFile('/home/gone.txt', { name: 'gone.txt', type: 'file' }, DELETE_FLAGS.alternative);
  assert.strictEqual(d.adapter.calls.rename.length, 1);
});

test('a file already inside the recycle bin is deleted for real', async () => {
  const { terminal, adapter } = makeTerminal({
    cwd: '/trash', data: { deleteToRecycleBin: true, recycleBinPath: '/trash' },
  });
  adapter.add('/trash/old.txt', {});
  assert.ok(terminal.isRecycledFile('/trash/old.txt'));
  await terminal.deleteFile('/trash/old.txt', { name: 'old.txt', type: 'file' }, 0);
  assert.deepStrictEqual(adapter.calls.remove.map((r) => r.path), ['/trash/old.txt']);
});

test('with no recycle bin configured a delete is always a delete', async () => {
  const { terminal, adapter } = makeTerminal({
    cwd: '/home', data: { deleteToRecycleBin: true, recycleBinPath: '' },
  });
  adapter.add('/home/x', {});
  await terminal.deleteFile('/home/x', { name: 'x', type: 'file' }, 0);
  assert.strictEqual(adapter.calls.remove.length, 1);
});

test('deleteFiles counts every deletion into the statistics', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  const ok = await terminal.deleteFiles([
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { name: 'b', type: 'file', fullFileName: '/d/b', directory: '/d' },
  ], 0);
  assert.strictEqual(ok, true);
  assert.strictEqual(terminal.lastOperation.statistics.filesDeletedRemote, 2);
});

// ===========================================================================
// retry / skip / abort
// ===========================================================================

test('a per-file error offers retry, skip, skip-all and abort', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.retry] });
  adapter.add('/d/a', {});
  const err = new Error('Permission denied'); err.code = 'EACCES';
  adapter.failNext = { op: 'remove', error: err, times: 1 };

  await terminal.deleteFile('/d/a', { name: 'a', type: 'file' }, 0);
  assert.strictEqual(queries.length, 1);
  // "Skip all" is only offered when there IS an operation to skip the rest of;
  // a single-file call outside processFiles gets the three plain answers.
  assert.deepStrictEqual(queries[0].answers, [ANSWERS.retry, ANSWERS.skip, ANSWERS.abort]);
  assert.ok(!adapter.has('/d/a'), 'the retry should have succeeded');
});

test('answering skip leaves the file alone and does not fail the operation', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', answers: [ANSWERS.skip] });
  adapter.add('/d/a', {});
  const err = new Error('Permission denied'); err.code = 'EACCES';
  adapter.failNext = { op: 'remove', error: err, times: 5 };

  await terminal.deleteFile('/d/a', { name: 'a', type: 'file' }, 0);
  assert.ok(adapter.has('/d/a'), 'skip means the file survives');
});

test('answering abort raises an abort that stops the whole operation', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', answers: [ANSWERS.abort] });
  adapter.add('/d/a', {});
  const err = new Error('Permission denied'); err.code = 'EACCES';
  adapter.failNext = { op: 'remove', error: err, times: 5 };

  await assert.rejects(() => terminal.deleteFile('/d/a', { name: 'a', type: 'file' }, 0), AbortError);
});

test('"skip all" answers every later error without asking again', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.all] });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  adapter.add('/d/c', {});
  const err = new Error('Permission denied'); err.code = 'EACCES';
  adapter.failNext = { op: 'remove', error: err, times: 99 };

  const ok = await terminal.deleteFiles([
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { name: 'b', type: 'file', fullFileName: '/d/b', directory: '/d' },
    { name: 'c', type: 'file', fullFileName: '/d/c', directory: '/d' },
  ], 0);

  assert.strictEqual(queries.length, 1, 'the user must be asked exactly once');
  assert.strictEqual(ok, true, 'skipping is not cancelling');
  assert.ok(adapter.has('/d/a') && adapter.has('/d/b') && adapter.has('/d/c'));
});

test('a dismissed error prompt is read as abort, never as "carry on"', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  terminal._queryUser = async () => undefined;      // the renderer went away
  adapter.add('/d/a', {});
  const err = new Error('Permission denied'); err.code = 'EACCES';
  adapter.failNext = { op: 'remove', error: err, times: 5 };
  await assert.rejects(() => terminal.deleteFile('/d/a', { name: 'a', type: 'file' }, 0), AbortError);
  assert.ok(adapter.has('/d/a'));
});

// ===========================================================================
// rename / move / copy
// ===========================================================================

test('renaming to the same path is a no-op, not an error and not a round trip', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  const done = await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/a/', false, false, false);
  assert.strictEqual(done, false);
  assert.strictEqual(adapter.calls.rename.length, 0);
});

test('an existing target is confirmed before anything is touched', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.no] });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});

  const done = await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, false, false);
  assert.strictEqual(done, false);
  assert.strictEqual(adapter.calls.rename.length, 0);
  assert.strictEqual(adapter.calls.remove.length, 0, 'answering No must not delete the target');
  assert.match(queries[0].message, /already exists/);
  assert.strictEqual(queries[0].type, 'confirmation');
});

test('overwriting an existing directory asks a sterner question', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.no] });
  adapter.add('/d/a', {});
  adapter.nodes.set('/d/b', { type: 'dir', mtime: 0 });

  await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, false, false);
  assert.strictEqual(queries[0].type, 'warning');
  assert.ok(queries[0].moreMessages.some((m) => /cannot be recovered/i.test(m)));
});

test('answering yes deletes the target first when the protocol cannot rename over it', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', answers: [ANSWERS.yes] });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});

  const done = await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, false, false);
  assert.strictEqual(done, true);
  assert.deepStrictEqual(adapter.calls.remove.map((r) => r.path), ['/d/b']);
  assert.deepStrictEqual(adapter.calls.rename, [{ from: '/d/a', to: '/d/b' }]);
});

test('a protocol that can rename over an existing name does not delete first', async () => {
  const { terminal, adapter } = makeTerminal({
    cwd: '/d', answers: [ANSWERS.yes], caps: { moveOverExistingFile: true },
  });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  // The fixture refuses a rename onto an existing name, so the call fails —
  // what matters is that we did not pre-delete the target.
  await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, false, false)
    .catch(() => undefined);
  assert.strictEqual(adapter.calls.remove.length, 0);
});

test('confirmOverwriting off skips the question entirely', async () => {
  const { terminal, adapter, queries } = makeTerminal({
    cwd: '/d', prefs: { confirmOverwriting: false },
  });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  const done = await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, false, false);
  assert.strictEqual(done, true);
  assert.strictEqual(queries.length, 0);
});

test('"yes to all" is remembered for the rest of a batch move', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.yesToAll] });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  adapter.nodes.set('/t', { type: 'dir', mtime: 0 });
  adapter.add('/t/a', {});
  adapter.add('/t/b', {});

  await terminal.moveFiles([
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { name: 'b', type: 'file', fullFileName: '/d/b', directory: '/d' },
  ], '/t', '*.*', false);

  assert.strictEqual(queries.length, 1, 'the second file must not ask again');
  assert.ok(adapter.has('/t/a') && adapter.has('/t/b'));
});

test('"no to all" refuses the rest of the batch without asking', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.noToAll] });
  adapter.add('/d/a', { size: 1 });
  adapter.add('/d/b', { size: 1 });
  adapter.nodes.set('/t', { type: 'dir', mtime: 0 });
  adapter.add('/t/a', { size: 9 });
  adapter.add('/t/b', { size: 9 });

  await terminal.moveFiles([
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { name: 'b', type: 'file', fullFileName: '/d/b', directory: '/d' },
  ], '/t', '*.*', false);

  assert.strictEqual(queries.length, 1);
  assert.strictEqual(adapter.calls.rename.length, 0);
  assert.ok(adapter.has('/d/a') && adapter.has('/d/b'), 'nothing should have moved');
});

test('moving a directory onto its own ancestor is refused', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/home' });
  adapter.nodes.set('/home/me', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/home/me/dir', { type: 'dir', mtime: 0 });

  await assert.rejects(
    () => terminal.doRenameOrCopyFile(true, '/home/me/dir', null, '/home/me', false, true, false),
    (e) => e instanceof TerminalError && /ancestor/.test(e.message));
  assert.strictEqual(adapter.calls.rename.length, 0);
});

test('dontOverwrite neither asks nor pre-deletes', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.skip] });
  adapter.add('/d/a', {});
  adapter.add('/d/b', {});
  await terminal.doRenameOrCopyFile(true, '/d/a', null, '/d/b', false, true, false);
  assert.ok(!queries.some((q) => /already exists/.test(q.message)), 'no overwrite question');
  assert.strictEqual(adapter.calls.remove.length, 0, 'the target must survive');
  assert.ok(adapter.has('/d/b'));
});

test('a move applies the file mask to the target name', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/report.txt', {});
  adapter.nodes.set('/archive', { type: 'dir', mtime: 0 });

  await terminal.moveFiles(
    [{ name: 'report.txt', type: 'file', fullFileName: '/d/report.txt', directory: '/d' }],
    '/archive', '*-2026.*', false);

  assert.deepStrictEqual(adapter.calls.rename, [{ from: '/d/report.txt', to: '/archive/report-2026.txt' }]);
});

test('moving the directory you are standing in walks you up to one that exists', async () => {
  const { terminal, adapter, session } = makeTerminal({ cwd: '/home/me/work' });
  adapter.nodes.set('/home', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/home/me', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/home/me/work', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/elsewhere', { type: 'dir', mtime: 0 });

  await terminal.moveFiles(
    [{ name: 'work', type: 'dir', fullFileName: '/home/me/work', directory: '/home/me' }],
    '/elsewhere', '*.*', false);

  assert.ok(adapter.has('/elsewhere/work'));
  assert.strictEqual(session.state.remotePath, '/home/me',
    'the session must not be left standing in a directory that no longer exists');
});

test('server-side copy is refused when the protocol cannot do it', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', answers: [ANSWERS.skip] });
  adapter.add('/d/a', {});
  const done = await terminal.doRenameOrCopyFile(false, '/d/a', null, '/d/b', false, true, false);
  assert.strictEqual(done, false, 'the user skipped an operation the protocol cannot perform');
  assert.ok(!adapter.has('/d/b'));
});

// ===========================================================================
// create directory / link
// ===========================================================================

test('creating a directory that already exists in the listing is refused up front', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/d/sub', { type: 'dir', mtime: 0 });
  await terminal.readDirectory(false);

  await assert.rejects(() => terminal.createDirectory('sub', {}), /already exists/);
  assert.strictEqual(adapter.calls.mkdir.length, 0);
});

test('a new directory is created one level only, never the whole path silently', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  await terminal.createDirectory('/d/sub', {});
  assert.strictEqual(adapter.calls.mkdir[0].opts.recursive, false);
  assert.ok(adapter.has('/d/sub'));
});

test('directory properties are applied after the directory exists', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  await terminal.createDirectory('/d/sub', { rights: 'rwxr-x---' });
  assert.deepStrictEqual(adapter.calls.setRights, [{ path: '/d/sub', rights: 'rwxr-x---' }]);
});

test('a hard link on a protocol that has none is reported, not faked', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d', answers: [ANSWERS.skip] });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  await terminal.createLink('link', '/d/target', false);
  assert.strictEqual(adapter.calls.symlink.length, 0);
});

test('a symbolic link is created through the adapter', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  await terminal.createLink('/d/link', '/d/target', true);
  assert.deepStrictEqual(adapter.calls.symlink, [{ target: '/d/target', link: '/d/link' }]);
});

// ===========================================================================
// properties
// ===========================================================================

test('a directory gets execute added when read or write is set', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.nodes.set('/d/sub', { type: 'dir', mtime: 0 });
  await terminal.changeFileProperties('/d/sub',
    { name: 'sub', type: 'dir', fullFileName: '/d/sub', directory: '/d' },
    { rights: 'rw-r-----', addXToDirectories: true });
  assert.strictEqual(adapter.calls.setRights[0].rights, 'rwxr-x---');
});

test('a plain file never has execute added', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  await terminal.changeFileProperties('/d/a',
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { rights: 'rw-r--r--', addXToDirectories: true });
  assert.strictEqual(adapter.calls.setRights[0].rights, 'rw-r--r--');
});

test('setting only the owner supplies the current group, and vice versa', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', { owner: 'olduser', group: 'oldgroup' });
  const file = { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d', owner: 'olduser', group: 'oldgroup' };

  await terminal.changeFileProperties('/d/a', file, { owner: 'newuser' });
  assert.deepStrictEqual(adapter.calls.setOwner[0], { path: '/d/a', owner: 'newuser', group: 'oldgroup' });

  await terminal.changeFileProperties('/d/a', file, { group: 'newgroup' });
  assert.deepStrictEqual(adapter.calls.setOwner[1], { path: '/d/a', owner: 'olduser', group: 'newgroup' });
});

test('recursive properties reach the children before the directory itself', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  adapter.add('/d/f1', {});
  adapter.nodes.set('/d/sub', { type: 'dir', mtime: 0 });
  adapter.add('/d/sub/f2', {});

  await terminal.changeFileProperties('/d',
    { name: 'd', type: 'dir', fullFileName: '/d', directory: '/' },
    { rights: 'rw-r--r--', recursive: true });

  assert.deepStrictEqual(adapter.calls.setRights.map((c) => c.path),
    ['/d/f1', '/d/sub/f2', '/d/sub', '/d']);
});

test('changing a timestamp works with either adapter setTimes signature', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  await terminal.changeFileProperties('/d/a',
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d', mtime: 1 },
    { modification: 1700000000000 });
  assert.strictEqual(adapter.calls.setTimes[0].mtime, 1700000000000);

  // The FTP backend takes (path, { mtime }); dispatch is on arity.
  const objectStyle = [];
  const adapter2 = new MemoryAdapter();
  adapter2.setTimes = async (p, opts) => { objectStyle.push({ p, opts }); };
  const s2 = makeTerminal({ adapter: adapter2, cwd: '/d' });
  adapter2.add('/d/a', {});
  await s2.terminal.changeFileProperties('/d/a',
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' },
    { modification: 42 });
  assert.deepStrictEqual(objectStyle, [{ p: '/d/a', opts: { mtime: 42, atime: 42 } }]);
});

test('changing permissions on a protocol that cannot is reported, not silently skipped', async () => {
  const { terminal, adapter, queries } = makeTerminal({
    cwd: '/d', caps: { rights: false }, answers: [ANSWERS.skip],
  });
  adapter.add('/d/a', {});
  await terminal.changeFileProperties('/d/a',
    { name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' }, { rights: 'rwxrwxrwx' });
  assert.strictEqual(queries.length, 1);
  assert.match(queries[0].error.message, /cannot change permissions/);
  assert.strictEqual(adapter.calls.setRights.length, 0);
});

// ===========================================================================
// calculate size
// ===========================================================================

function sizeFixture(t) {
  t.adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  t.adapter.add('/d/a.txt', { size: 100 });
  t.adapter.add('/d/b.log', { size: 200 });
  t.adapter.nodes.set('/d/sub', { type: 'dir', mtime: 0 });
  t.adapter.add('/d/sub/c.txt', { size: 300 });
  return { name: 'd', type: 'dir', fullFileName: '/d', directory: '/', isSymlink: false };
}

test('directory sizes are calculated recursively with per-type counts', async () => {
  const t = makeTerminal({ cwd: '/' });
  const dir = sizeFixture(t);
  const res = await t.terminal.calculateFilesSize([dir], {});
  assert.strictEqual(res.size, 600);
  assert.strictEqual(res.stats.files, 3);
  assert.strictEqual(res.stats.directories, 2, 'the top directory and its subdirectory');
  assert.strictEqual(res.result, true);
});

test('the transfer mask filters what is counted, so the total matches the transfer', async () => {
  const t = makeTerminal({ cwd: '/' });
  const dir = sizeFixture(t);
  const res = await t.terminal.calculateFilesSize([dir], { copyParam: { includeFileMask: '*.txt' } });
  assert.strictEqual(res.size, 400, 'the .log file must not be counted');
});

test('excludeHiddenFiles beats an explicit include mask', async () => {
  // Awaited because DoAllowRemoteFileTransfer's third conjunct — the
  // cpNoEmptyDirectories clause, Terminal.cpp:5806 — is a listing. The
  // assertions themselves are unchanged.
  const { terminal } = makeTerminal();
  const hidden = { name: '.env', type: 'file', hidden: true, size: 1, mtime: 0, directory: '/d', fullFileName: '/d/.env' };
  assert.strictEqual(await terminal.allowRemoteFileTransfer(hidden, { includeFileMask: '*', excludeHiddenFiles: true }, false), false);
  assert.strictEqual(await terminal.allowRemoteFileTransfer(hidden, { includeFileMask: '*' }, false), true);
});

// ---------------------------------------------------------------------------
// cpNoEmptyDirectories in the REMOTE size calculation
//
// DoAllowRemoteFileTransfer is three conjuncts (Terminal.cpp:5803-5807) and
// this port only had two: the mask/hidden rules and the .filepart rule. The
// third — `!File->IsDirectory || !ExcludeEmptyDirectories || !IsEmptyRemoteDirectory(...)`
// — was missing, so the count reported directories the copy would then refuse.
// Bytes never diverged (a directory contributes none), which is why it hid:
// what was wrong was the directory count and the collected file list.
// ---------------------------------------------------------------------------

function emptyDirFixture(t) {
  t.adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  t.adapter.nodes.set('/d/full', { type: 'dir', mtime: 0 });
  t.adapter.add('/d/full/a.txt', { size: 100 });
  t.adapter.nodes.set('/d/empty', { type: 'dir', mtime: 0 });
  return { name: 'd', type: 'dir', fullFileName: '/d', directory: '/', isSymlink: false };
}

test('excludeEmptyDirectories leaves the empty directory out of the remote count', async () => {
  const control = makeTerminal({ cwd: '/' });
  const dir = emptyDirFixture(control);
  const off = await control.terminal.calculateFilesSize([dir], { copyParam: {} });
  assert.strictEqual(off.stats.directories, 3, 'the control: /d, /d/full and /d/empty');

  const t = makeTerminal({ cwd: '/' });
  emptyDirFixture(t);
  const res = await t.terminal.calculateFilesSize([dir], {
    copyParam: { excludeEmptyDirectories: true },
  });
  assert.strictEqual(res.stats.directories, 2, '/d/empty is not counted');
  assert.strictEqual(res.size, 100, 'bytes never disagreed — a directory contributes none');
});

test('the collected remote file list drops the directories the copy will refuse', async () => {
  // `collectFiles` is what a transfer is actually driven from
  // (transfer.js:459 builds from calculateFilesSize({collectFiles:true}).files),
  // so a stale entry here is a directory the copy is asked to create.
  const t = makeTerminal({ cwd: '/' });
  const dir = emptyDirFixture(t);
  const res = await t.terminal.calculateFilesSize([dir], {
    copyParam: { excludeEmptyDirectories: true }, collectFiles: true,
  });
  assert.deepStrictEqual(res.files.map((f) => f.fileName), ['/d', '/d/full', '/d/full/a.txt']);
});

test('emptiness is recursive on the remote side too', async () => {
  // IsEmptyRemoteDirectory is DoCalculateDirectorySize with csStopOnFirstFile
  // and `Stats.Files == 0`, so a directory holding nothing but empty
  // directories is empty all the way up. A one-level implementation would
  // count /d/hollow.
  const t = makeTerminal({ cwd: '/' });
  const dir = emptyDirFixture(t);
  t.adapter.nodes.set('/d/hollow', { type: 'dir', mtime: 0 });
  t.adapter.nodes.set('/d/hollow/deeper', { type: 'dir', mtime: 0 });
  const res = await t.terminal.calculateFilesSize([dir], {
    copyParam: { excludeEmptyDirectories: true },
  });
  assert.strictEqual(res.stats.directories, 2);
});

test('a remote directory holding only masked-out files counts as empty for the size too', async () => {
  // "Empty" is "empty for THIS transfer": the mask is applied by
  // calculateFileSize on the way past, so a directory of nothing but .log
  // files under an *.txt mask is empty exactly as the copy will find it.
  const t = makeTerminal({ cwd: '/' });
  const dir = emptyDirFixture(t);
  t.adapter.nodes.set('/d/logs', { type: 'dir', mtime: 0 });
  t.adapter.add('/d/logs/x.log', { size: 7 });
  const res = await t.terminal.calculateFilesSize([dir], {
    copyParam: { excludeEmptyDirectories: true, includeFileMask: '*.txt' },
  });
  assert.strictEqual(res.stats.directories, 2, '/d/logs holds nothing this transfer wants');
  assert.strictEqual(res.size, 100);
});

test('a remote directory that cannot be listed is not reported empty', async () => {
  // Terminal.cpp:6447 returns `Params.Result && (Stats.Files == 0)`, and
  // Params.Result is untouched by a listing that failed under csIgnoreErrors —
  // so the original answers "empty" and drops the directory and everything
  // under it. We also require the listing to have succeeded, which is the
  // value DoCalculateDirectorySize returns and the original discards
  // (Terminal.cpp:4785/4810). It matches what transfer.js isEmptyDirectory
  // already answers, and agreeing with the copy is this method's whole job.
  const t = makeTerminal({ cwd: '/' });
  emptyDirFixture(t);
  t.adapter.failNext = { op: 'list', error: Object.assign(new Error('denied'), { code: 'EACCES' }), times: 1 };
  const empty = await t.terminal.isEmptyRemoteDirectory(
    { name: 'empty', type: 'dir', fullFileName: '/d/empty', directory: '/d' }, {}, false);
  assert.strictEqual(empty, false);
});

test('allowDirs=false marks the result untrusted rather than guessing a size', async () => {
  const t = makeTerminal({ cwd: '/' });
  const dir = sizeFixture(t);
  const res = await t.terminal.calculateFilesSize([dir], { allowDirs: false });
  assert.strictEqual(res.result, false);
  assert.strictEqual(res.size, 0);
});

test('stopOnFirstFile stops descending once anything has been found', async () => {
  const t = makeTerminal({ cwd: '/' });
  const dir = sizeFixture(t);
  const listsBefore = t.adapter.calls.list;
  const res = await t.terminal.calculateFilesSize([dir], { params: CALC_FLAGS.stopOnFirstFile });
  assert.ok(res.stats.files > 0);
  assert.ok(t.adapter.calls.list - listsBefore <= 2, 'it must not walk the whole tree to answer "is it empty?"');
});

/** Make listing one directory fail, leaving the rest of the tree readable. */
function failListingOf(t, path, code) {
  const realList = t.adapter.list.bind(t.adapter);
  t.adapter.list = async (p) => {
    if (t.adapter.normalize(p) === path) {
      const e = new Error('Permission denied'); e.code = code || 'EACCES'; throw e;
    }
    return realList(p);
  };
}

test('an unreadable subdirectory is asked about once and skipped, keeping the partial total', async () => {
  // WinSCP asks here even with csIgnoreErrors: the *listing* has its own retry
  // loop inside CustomReadDirectoryListing, and csIgnoreErrors only covers
  // failures raised while walking what the listing returned. (Terminal.cpp
  // carries a TODO about exactly this.)
  const t = makeTerminal({ cwd: '/', answers: [ANSWERS.skip] });
  const dir = sizeFixture(t);
  failListingOf(t, '/d/sub');

  const res = await t.terminal.calculateFilesSize([dir], { params: CALC_FLAGS.ignoreErrors });
  assert.strictEqual(t.queries.length, 1);
  assert.strictEqual(res.size, 300, 'the two readable files still count');
  assert.strictEqual(res.stats.files, 2);
});

test('skipping an unreadable subdirectory does not lose what was already counted', async () => {
  const t = makeTerminal({ cwd: '/', answers: [ANSWERS.skip] });
  const dir = sizeFixture(t);
  failListingOf(t, '/d/sub');
  const res = await t.terminal.calculateFilesSize([dir], {});
  assert.strictEqual(res.size, 300);
  assert.strictEqual(res.stats.directories, 2, 'the unreadable directory is still a directory');
});

test('a listing that fails fatally during a size calculation is not "ignored"', async () => {
  const t = makeTerminal({ cwd: '/', answers: [ANSWERS.abort] });
  const dir = sizeFixture(t);
  failListingOf(t, '/d/sub', 'ECONNRESET');
  await assert.rejects(
    () => t.terminal.calculateFilesSize([dir], { params: CALC_FLAGS.ignoreErrors }),
    (e) => classifyException(e) === 'fatal');
});

test('a symlinked directory is not descended into when calculating size', async () => {
  const t = makeTerminal({ cwd: '/' });
  t.adapter.nodes.set('/real', { type: 'dir', mtime: 0 });
  t.adapter.add('/real/big', { size: 999 });
  const link = { name: 'link', type: 'dir', fullFileName: '/link', directory: '/', isSymlink: true };
  const res = await t.terminal.calculateFilesSize([link], {});
  assert.strictEqual(res.size, 0);
  assert.strictEqual(res.stats.symLinks, 1);
  assert.strictEqual(res.stats.directories, 1);
});

test('cancelling a size calculation aborts it', async () => {
  const t = makeTerminal({ cwd: '/' });
  const dir = sizeFixture(t);
  t.terminal.on('operation-start', () => {
    t.terminal.operationProgress.setCancel(CANCEL.cancel);
  });
  const res = await t.terminal.calculateFilesSize([dir], {});
  assert.strictEqual(res.size, 0);
});

// ===========================================================================
// capabilities, identity and lock
// ===========================================================================

test('capabilities are answered from the adapter, so the UI and the call agree', () => {
  const { terminal } = makeTerminal({ caps: { rights: false, owner: false, exec: true, copyRemote: true } });
  assert.strictEqual(terminal.isCapable('modeChanging'), false);
  assert.strictEqual(terminal.isCapable('ownerChanging'), false);
  assert.strictEqual(terminal.isCapable('secondaryShell'), true);
  assert.strictEqual(terminal.isCapable('remoteCopy'), true);
  assert.strictEqual(terminal.isCapable('locking'), false);
  assert.strictEqual(terminal.isCapable('nonsense'), false);
  // No adapter declares it, so the conservative answer stands.
  assert.strictEqual(terminal.isCapable('moveOverExistingFile'), false);
});

test('usableCopyParamAttrs disables what the protocol cannot honour', () => {
  const { terminal } = makeTerminal({ caps: { rights: false, timestamp: false, resume: false } });
  const attrs = terminal.usableCopyParamAttrs({});
  assert.strictEqual(attrs.general.noRights, true);
  assert.strictEqual(attrs.general.noResumeSupport, true);
  assert.strictEqual(attrs.upload.noPreserveTime, true);
  assert.strictEqual(attrs.download.noRights, true);
});

test('resolvingSymlinks needs both the site setting and the capability', () => {
  assert.strictEqual(makeTerminal().terminal.resolvingSymlinks, true);
  assert.strictEqual(makeTerminal({ data: { resolveSymlinks: false } }).terminal.resolvingSymlinks, false);
  assert.strictEqual(makeTerminal({ caps: { symlink: false } }).terminal.resolvingSymlinks, false);
});

test('locking is refused rather than pretended when the protocol has none', async () => {
  const { terminal, adapter, queries } = makeTerminal({ cwd: '/d', answers: [ANSWERS.skip] });
  adapter.add('/d/a', {});
  await terminal.lockFiles([{ name: 'a', type: 'file', fullFileName: '/d/a', directory: '/d' }]);
  assert.strictEqual(queries.length, 1);
  assert.match(queries[0].error.message, /cannot lock files/);
});

test('"is this the same file" is answered by path first, then by attributes', () => {
  const { terminal } = makeTerminal();
  const a = { fullFileName: '/d/a', type: 'file', size: 10, mtime: 5 };
  assert.ok(terminal.isSameFile(a, { fullFileName: '/d/a/', type: 'file', size: 99, mtime: 99 }));
  assert.ok(terminal.isSameFile(a, { fullFileName: '/other/a', type: 'file', size: 10, mtime: 5 }));
  assert.ok(!terminal.isSameFile(a, { fullFileName: '/d/b', type: 'file', size: 10, mtime: 5 }));
  assert.ok(!terminal.isSameFile(a, { fullFileName: '/other/a', type: 'file', size: 11, mtime: 5 }));
  assert.ok(!terminal.isSameFile(a, null));
});

// ===========================================================================
// current directory
// ===========================================================================

test('changing directory validates the target and records where we are', async () => {
  const { terminal, adapter, session } = makeTerminal({ cwd: '/' });
  adapter.nodes.set('/d', { type: 'dir', mtime: 0 });
  const landed = await terminal.changeDirectory('/d');
  assert.strictEqual(landed, '/d');
  assert.strictEqual(session.state.remotePath, '/d');
});

test('changing to a directory that does not exist is reported, not silently accepted', async () => {
  const { terminal, session, queries } = makeTerminal({ cwd: '/' });
  terminal._queryUser = async (q) => { queries.push(q); return ANSWERS.ok; };
  await terminal.changeDirectory('/nope');
  assert.strictEqual(session.state.remotePath, '/', 'we must not claim to be somewhere we are not');
});

test('a cached directory change is reused instead of another round trip', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/home/me' });
  adapter.nodes.set('/home/me', { type: 'dir', mtime: 0 });
  adapter.nodes.set('/var/data', { type: 'dir', mtime: 0 });
  terminal.changesCache.addDirectoryChange('/home/me', 'link', '/var/data');
  // Measure the change itself; the panel reload that follows it is a separate
  // (and deliberate) round trip.
  terminal.autoReadDirectory = false;

  const listsBefore = adapter.calls.list;
  const landed = await terminal.changeDirectory('link');
  assert.strictEqual(landed, '/var/data');
  assert.strictEqual(adapter.calls.list, listsBefore, 'the cached hop costs no listing');
});

test('home directory jumps are deliberately not recorded as directory changes', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/somewhere' });
  adapter.nodes.set('/home/me', { type: 'dir', mtime: 0 });
  await terminal.homeDirectory();
  assert.strictEqual(terminal.currentDirectorySync, '/home/me');
  assert.ok(terminal.changesCache.isEmpty, 'nothing should be keyed on "home"');
});

test('clearCaches empties both caches and the session panel cache', async () => {
  const { terminal, session, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  await terminal.readDirectory(false);
  terminal.changesCache.addDirectoryChange('/a', 'x', '/b');
  assert.ok(!terminal.areCachesEmpty);

  terminal.clearCaches();
  assert.ok(terminal.areCachesEmpty);
  assert.strictEqual(session.cleared, 1);
});

test('refresh after cache clearing rereads the current directory', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  await terminal.readDirectory(false);
  adapter.add('/d/b', {});
  terminal.clearCaches();
  await terminal.refreshDirectory();
  assert.deepStrictEqual(terminal.files.files.map((f) => f.name).sort(), ['a', 'b']);
});

// ===========================================================================
// file existence helpers
// ===========================================================================

test('fileExists and directoryExists answer without a dialog', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.add('/d/a', {});
  adapter.nodes.set('/d/sub', { type: 'dir', mtime: 0 });

  assert.strictEqual(await terminal.fileExists('/d/a'), true);
  assert.strictEqual(await terminal.fileExists('/d/nope'), false);
  assert.strictEqual(await terminal.directoryExists('/d/sub'), true);
  assert.strictEqual(await terminal.directoryExists('/d/a'), false);
});

test('an existence check that killed the session still propagates', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  const lost = new Error('read ECONNRESET'); lost.code = 'ECONNRESET';
  adapter.failNext = { op: 'stat', error: lost, times: 1 };
  await assert.rejects(() => terminal.fileExists('/d/a'),
    (e) => classifyException(e) === 'fatal');
});

test('terminalFor gives a session exactly one terminal, invisibly', () => {
  const session = new FakeSession(new MemoryAdapter());
  const a = T.terminalFor(session);
  const b = T.terminalFor(session);
  assert.strictEqual(a, b, 'two terminals would mean two directory caches');
  assert.ok(!Object.keys(session).includes('__terminal'), 'it must not be serialized over IPC');
  assert.ok(!JSON.stringify(session).includes('__terminal'));
  assert.throws(() => T.terminalFor(null), TerminalError);
});

test('operating on a disconnected session is a fatal error, not a silent no-op', async () => {
  const { terminal, adapter } = makeTerminal({ cwd: '/d' });
  adapter.connected = false;
  assert.strictEqual(terminal.active, false);
  await assert.rejects(() => terminal.readDirectory(false).then(() => { throw new Error('should not resolve'); }),
    (e) => e instanceof FatalError || classifyException(e) === 'fatal');
});
