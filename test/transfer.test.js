// transfer.test.js — the transfer half of core/Terminal.cpp.
//
// The centre of gravity here is the OVERWRITE DECISION, because that is the
// code that destroys data when it is wrong. `effectiveBatchOverwrite` is a
// five-rung precedence ladder and `confirmFileOverwrite` runs it twice (once
// with resume on the table, once without); every rung, every fallback and
// every answer the dialog can give is asserted below, one combination at a
// time, against what core/Terminal.cpp:3125-3345 actually does.
//
// After that come the robust loops — the two rules that make a reconnect safe
// (retry the file, not the operation; refuse to retry when the session never
// died) — then TParallelOperation's cursor, then whole transfers end to end
// against in-memory adapters.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');

const { Adapter, entry, DEFAULT_CAPS } = require('../design/main/protocols/base');
const { MODIFICATION_FMT } = require('../design/main/remotefiles');
const T = require('../design/main/terminal');
const { Terminal, SIDES, ANSWERS, CANCEL } = T;
const X = require('../design/main/transfer');
const {
  COPY_FLAGS, BATCH_OVERWRITE, OVERWRITE_MODE,
  OverwriteFileParams, CollectedFileList, ParallelOperation,
  TransferEngine, StandaloneHost, SimpleProgress,
  validLocalFileName, restoreChars, changeFileName, allowResume, useAsciiTransfer,
  remoteFileRights, localFileReadOnly, skipTransfer, resumeTransfer, allowAnyTransfer,
  isReservedName, rollbackTransfer, addResumed,
  TOKEN_REPLACEMENT, NO_REPLACEMENT,
} = X;

// ===========================================================================
// fixtures
// ===========================================================================

/** An in-memory file system behind the real Adapter contract. */
class MemoryAdapter extends Adapter {
  constructor(options = {}) {
    super(null);
    this.caps = {
      ...DEFAULT_CAPS, rights: true, timestamp: true, resume: true, ...(options.caps || {}),
    };
    this.connected = true;
    this.home = '/';
    this._name = options.name || 'Memory';
    this.nodes = new Map([['/', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }]]);
    this.calls = { mkdir: [], remove: [], rename: [], setRights: [], setTimes: [], reads: [], writes: [] };
    this.failNext = null;    // { op, error, times }
  }

  get protocolName() { return this._name; }

  put(p, data, mtime, extra) {
    const t = this.normalize(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this._ensureParents(t);
    this.nodes.set(t, {
      type: 'file', size: buf.length, mtime: mtime || 0, rights: 'rw-r--r--', data: buf, ...(extra || {}),
    });
    return this;
  }

  putDir(p, mtime) {
    const t = this.normalize(p);
    this._ensureParents(t);
    this.nodes.set(t, { type: 'dir', mtime: mtime || 0, rights: 'rwxr-xr-x' });
    return this;
  }

  _ensureParents(t) {
    const parts = t.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      if (!this.nodes.has(cur)) this.nodes.set(cur, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
    }
  }

  read(p) { const n = this.nodes.get(this.normalize(p)); return n && n.data; }

  text(p) { const d = this.read(p); return d === undefined || d === null ? null : d.toString(); }

  has(p) { return this.nodes.has(this.normalize(p)); }

  paths() { return [...this.nodes.keys()].sort(); }

  _maybeFail(op) {
    if (!this.failNext || this.failNext.op !== op) return;
    if (this.failNext.times !== undefined && this.failNext.times <= 0) return;
    if (this.failNext.times !== undefined) this.failNext.times--;
    const e = this.failNext.error;
    if (this.failNext.times === 0) this.failNext = null;
    if (e.code === 'ECONNRESET') this.connected = false;
    throw e;
  }

  _entry(p, n) {
    const e = entry({
      name: T.extractFileName(p) || '/',
      type: n.type,
      size: n.size || 0,
      mtime: n.mtime || 0,
      rights: n.rights || '',
      owner: n.owner || '',
      isSymlink: !!n.isSymlink,
      hidden: !!n.hidden,
      readOnly: !!n.readOnly,
    });
    if (n.modificationFmt !== undefined) e.modificationFmt = n.modificationFmt;
    return e;
  }

  async list(dir) {
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
      out.push(this._entry(p, n));
    }
    return out;
  }

  async stat(p) {
    this._maybeFail('stat');
    const t = this.normalize(p);
    const n = this.nodes.get(t);
    if (!n) { const e = new Error(`No such file: ${t}`); e.code = 'ENOENT'; throw e; }
    return this._entry(t, n);
  }

  async mkdir(p, opts = {}) {
    this._maybeFail('mkdir');
    const t = this.normalize(p);
    this.calls.mkdir.push(t);
    if (this.nodes.has(t)) {
      if (opts.recursive) return;
      const e = new Error(`Exists: ${t}`); e.code = 'EEXIST'; throw e;
    }
    if (opts.recursive) this._ensureParents(t);
    else if (!this.nodes.has(T.extractFileDir(t))) {
      const e = new Error(`No such parent: ${t}`); e.code = 'ENOENT'; throw e;
    }
    this.nodes.set(t, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
  }

  async remove(p, opts = {}) {
    this._maybeFail('remove');
    const t = this.normalize(p);
    this.calls.remove.push(t);
    const n = this.nodes.get(t);
    if (!n) { const e = new Error(`No such file: ${t}`); e.code = 'ENOENT'; throw e; }
    if (n.type === 'dir') {
      const prefix = t + '/';
      const kids = [...this.nodes.keys()].filter((k) => k.startsWith(prefix));
      if (kids.length && !opts.recursive) {
        const e = new Error(`Directory not empty: ${t}`); e.code = 'ENOTEMPTY'; throw e;
      }
      for (const k of kids) this.nodes.delete(k);
    }
    this.nodes.delete(t);
  }

  async rename(from, to) {
    this._maybeFail('rename');
    const f = this.normalize(from);
    const t = this.normalize(to);
    this.calls.rename.push([f, t]);
    const n = this.nodes.get(f);
    if (!n) { const e = new Error(`No such file: ${f}`); e.code = 'ENOENT'; throw e; }
    if (this.nodes.has(t)) { const e = new Error(`Exists: ${t}`); e.code = 'EEXIST'; throw e; }
    this.nodes.delete(f);
    this.nodes.set(t, n);
  }

  async setRights(p, rights) {
    this._maybeFail('setRights');
    this.calls.setRights.push([this.normalize(p), rights]);
    const n = this.nodes.get(this.normalize(p));
    if (n) n.rights = rights;
  }

  async setTimes(p, a, b) {
    this._maybeFail('setTimes');
    const times = (a && typeof a === 'object') ? a : { mtime: a, atime: b };
    this.calls.setTimes.push([this.normalize(p), times.mtime]);
    const n = this.nodes.get(this.normalize(p));
    if (n) n.mtime = times.mtime;
  }

  async createReadStream(p, opts = {}) {
    this._maybeFail('createReadStream');
    const n = this.nodes.get(this.normalize(p));
    if (!n) { const e = new Error(`No such file: ${p}`); e.code = 'ENOENT'; throw e; }
    const start = opts.start || 0;
    const end = opts.end === undefined ? n.data.length - 1 : opts.end;
    this.calls.reads.push({ path: this.normalize(p), start });
    return Readable.from([n.data.subarray(start, end + 1)]);
  }

  async createWriteStream(p, opts = {}) {
    this._maybeFail('createWriteStream');
    const t = this.normalize(p);
    const start = opts.start || 0;
    this.calls.writes.push({ path: t, start, append: !!opts.append });
    const existing = this.nodes.get(t);
    let head = Buffer.alloc(0);
    if (start > 0 && existing && existing.data) head = existing.data.subarray(0, start);
    const chunks = [head];
    const self = this;
    return new Writable({
      write(chunk, enc, cb) { chunks.push(chunk); cb(); },
      final(cb) {
        const data = Buffer.concat(chunks);
        self._ensureParents(t);
        self.nodes.set(t, {
          type: 'file', size: data.length, mtime: (existing && existing.mtime) || 0,
          rights: (existing && existing.rights) || 'rw-r--r--', data,
        });
        cb();
      },
    });
  }
}

/** Everything Terminal and TransferEngine ask of design/main/session.js. */
class FakeSession {
  constructor(adapter, data) {
    this.adapter = adapter;
    this.name = 'test';
    this.data = { protocol: 'sftp', cacheDirectories: true, ...(data || {}) };
    this.state = { remotePath: '/', localPath: '' };
    this.lines = [];
    this.log = { add: (kind, text) => this.lines.push(`${kind}: ${text}`) };
    this.config = {
      prefs: {
        confirmOverwriting: true,
        confirmResume: true,
        autoReadDirectoryAfterOp: false,
        security: {},
        queue: { transfersLimit: 2, parallelTransferThreshold: 10 * 1024 * 1024 },
      },
      setPref(key, value) { this.prefs[key] = value; },
    };
    this.askRequests = [];
    this.askAnswers = [];
    this.reconnects = 0;
  }

  invalidate() {}
  clearCache() {}
  async disconnect() { this.adapter.connected = false; }
  async reconnect() { this.reconnects++; this.adapter.connected = true; }

  async ask(kind, request) {
    this.askRequests.push({ kind, request });
    return this.askAnswers.length ? this.askAnswers.shift() : null;
  }
}

/**
 * A terminal with a scripted answer queue. Running out of scripted answers is
 * a failure, not a default: an unexpected prompt must never pass unnoticed.
 */
function makeTerminal(options = {}) {
  const remote = options.remote || new MemoryAdapter({ name: 'Memory-SFTP' });
  const session = new FakeSession(remote, options.data);
  if (options.prefs) Object.assign(session.config.prefs, options.prefs);
  const queries = [];
  const answers = (options.answers || []).slice();
  const terminal = new Terminal(session, {
    queryUser: async (q) => {
      queries.push(q);
      if (!answers.length) throw new Error(`Unexpected query: ${q.message} [${q.answers.join(',')}]`);
      return answers.shift();
    },
  });
  terminal.session.state.remotePath = options.cwd || '/';
  return { terminal, session, remote, queries, answers };
}

/**
 * A whole engine over two memory adapters, with a byte mover that really
 * copies bytes (the queue supplies the production one; this one is the same
 * contract with none of the throttling).
 */
function makeEngine(options = {}) {
  const ctx = makeTerminal(options);
  const local = options.local || new MemoryAdapter({ name: 'Local' });
  const moved = [];
  const engine = new TransferEngine(ctx.terminal, {
    localAdapter: local,
    // A real macrotask, not Promise.resolve(): a microtask spin in WaitFor
    // would starve the very transfers it is waiting for.
    sleep: () => new Promise((r) => { setTimeout(r, 0); }),
    copyBytes: async (plan) => {
      moved.push({
        sourcePath: plan.sourcePath, targetPath: plan.targetPath,
        readFrom: plan.readFrom, writeAt: plan.writeAt, append: plan.append,
        mode: plan.overwriteMode,
      });
      if (options.copyBytes) return options.copyBytes(plan);
      const rs = await plan.sourceAdapter.createReadStream(plan.sourcePath,
        plan.readFrom > 0 ? { start: plan.readFrom } : {});
      const ws = await plan.targetAdapter.createWriteStream(plan.targetPath, {
        size: plan.size, start: plan.writeAt, append: plan.append,
      });
      let written = 0;
      for await (const chunk of rs) { ws.write(chunk); written += chunk.length; }
      await new Promise((resolve, reject) => { ws.on('error', reject); ws.end(resolve); });
      plan.onBytes(written);
      return written;
    },
  });
  return { ...ctx, local, engine, moved };
}

/** A progress object shaped like the one an operation carries. */
function progressFor(side, extra) {
  return Object.assign(new SimpleProgress(side), extra || {});
}

const CP = require('../design/main/defaults').COPY_PARAM_DEFAULTS;
const cp = (over) => ({ ...CP, ...(over || {}) });

// ===========================================================================
// TCopyParamType helpers
// ===========================================================================

test('ValidLocalFileName encodes what Windows would silently mangle', () => {
  // Plain replacement: every invalid character becomes the replacement.
  assert.strictEqual(validLocalFileName('a:b*c?.txt', '_'), 'a_b_c_.txt');
  // A control character is NOT in LocalInvalidChars, so ValidLocalFileName
  // leaves it exactly where the server put it — as the original does. The name
  // then fails at the file system, which is a diagnosable error, rather than
  // being quietly rewritten into a different file.
  assert.strictEqual(validLocalFileName(`a${String.fromCharCode(7)}b`, '_'), `a${String.fromCharCode(7)}b`);
  // An empty result would be an unusable name.
  assert.strictEqual(validLocalFileName(':', '_'), '_');

  // Token mode: the character is ENCODED, so restoreChars can undo it. The
  // sentinel is TokenReplacement (wchar_t(true) = U+0001), NOT the '%' prefix
  // it produces — a user who types '%' as their replacement character gets a
  // literal '%' substituted and no encoding at all.
  assert.strictEqual(validLocalFileName('a:b.txt', TOKEN_REPLACEMENT), 'a%3Ab.txt');
  assert.strictEqual(restoreChars('a%3Ab.txt', TOKEN_REPLACEMENT), 'a:b.txt');
  assert.strictEqual(validLocalFileName('a:b.txt', '%'), 'a%b.txt',
    'a literal % replacement substitutes, it does not switch on the codec');

  // Windows strips a trailing dot and a trailing space, which would make two
  // different remote names collide locally. Both are encoded instead.
  assert.strictEqual(validLocalFileName('report.', TOKEN_REPLACEMENT), 'report%2E');
  assert.strictEqual(restoreChars('report%2E', TOKEN_REPLACEMENT), 'report.');
  assert.strictEqual(validLocalFileName('report ', TOKEN_REPLACEMENT), 'report%20');
  assert.strictEqual(restoreChars('report%20', TOKEN_REPLACEMENT), 'report ');

  // A dot in the middle is a perfectly good file name and is left alone.
  assert.strictEqual(validLocalFileName('a.b.txt', TOKEN_REPLACEMENT), 'a.b.txt');

  // Reserved device names cannot be created at all, so they get a marker.
  // Only the stem before the FIRST dot counts, and only at three or four
  // characters: Windows refuses "con.txt.bak" exactly as it refuses "con", so
  // a second extension does not make the name safe.
  assert.ok(isReservedName('con'));
  assert.ok(isReservedName('CON.txt'));
  assert.ok(isReservedName('con.txt.bak'), 'a further extension does not unreserve the stem');
  assert.ok(!isReservedName('console'));
  assert.strictEqual(validLocalFileName('con.txt', TOKEN_REPLACEMENT), 'con%00.txt');
  assert.strictEqual(restoreChars('con%00.txt', TOKEN_REPLACEMENT), 'con.txt');
  assert.strictEqual(validLocalFileName('con.txt.bak', TOKEN_REPLACEMENT), 'con%00.txt.bak');
  assert.strictEqual(restoreChars('con%00.txt.bak', TOKEN_REPLACEMENT), 'con.txt.bak');

  // The token prefix is itself tokenizible, which is the only thing that makes
  // the codec reversible. A '%' the USER typed is encoded ("%25") so the way
  // back can tell it from an escape we produced; a '%' that already introduces
  // a valid token is left alone so a name is never double-encoded.
  assert.strictEqual(validLocalFileName('x%25y.txt', TOKEN_REPLACEMENT), 'x%2525y.txt');
  assert.strictEqual(restoreChars('x%2525y.txt', TOKEN_REPLACEMENT), 'x%25y.txt');
  assert.strictEqual(validLocalFileName('100%.txt', TOKEN_REPLACEMENT), '100%.txt',
    'a % that is not a token is left where it is');

  // Space and dot are encoded ONLY as the last character, so a "%20" the user
  // typed in the middle of a name is not silently turned into a space on the
  // way up — that would upload the file under a name nobody asked for.
  assert.strictEqual(restoreChars('a%20b.txt', TOKEN_REPLACEMENT), 'a%20b.txt');
  assert.strictEqual(validLocalFileName('a%20b.txt', TOKEN_REPLACEMENT), 'a%20b.txt');

  // With a non-token replacement there is nothing to restore.
  assert.strictEqual(restoreChars('a%3Ab.txt', '_'), 'a%3Ab.txt');
});

test('ChangeFileName applies the file mask only at the first level', () => {
  const withMask = cp({ fileMask: '*.bak', fileNameCase: 'noChange' });
  assert.strictEqual(changeFileName(withMask, 'report.txt', SIDES.local, true), 'report.bak');
  assert.strictEqual(changeFileName(withMask, 'report.txt', SIDES.local, false), 'report.txt',
    'a mask must not rename files found by recursion');

  // Case conversion, then the per-side character rules.
  assert.strictEqual(changeFileName(cp({ fileNameCase: 'upper' }), 'a.txt', SIDES.local, false), 'A.TXT');
  assert.strictEqual(changeFileName(cp({ fileNameCase: 'lower' }), 'A.TXT', SIDES.local, false), 'a.txt');
  assert.strictEqual(changeFileName(cp({ fileNameCase: 'firstUpper' }), 'mIxEd', SIDES.local, false), 'Mixed');
  // ncLowerCaseShort only touches an all-caps 8.3 name.
  assert.strictEqual(changeFileName(cp({ fileNameCase: 'lowerShort' }), 'README.TXT', SIDES.local, false), 'readme.txt');
  assert.strictEqual(changeFileName(cp({ fileNameCase: 'lowerShort' }), 'LONGERNAME.TXT', SIDES.local, false), 'LONGERNAME.TXT');

  // Side osRemote means the name is becoming a LOCAL one, so it is scrubbed.
  assert.strictEqual(changeFileName(cp({ invalidCharsReplacement: '_' }), 'a:b', SIDES.remote, false), 'a_b');
  // Side osLocal means it is going up, so an encoded name is restored.
  assert.strictEqual(changeFileName(cp({ invalidCharsReplacement: TOKEN_REPLACEMENT }), 'a%3Ab', SIDES.local, false), 'a:b');
  // Opting out of replacement leaves the name exactly as the server gave it.
  assert.strictEqual(changeFileName(cp({ replaceInvalidChars: false }), 'a:b', SIDES.remote, false), 'a:b');
});

test('AllowResume: on / off / smart, and the name-length refusal', () => {
  assert.strictEqual(allowResume(cp({ resumeSupport: 'on' }), 1, 'a'), true);
  assert.strictEqual(allowResume(cp({ resumeSupport: 'off' }), 1e9, 'a'), false);
  assert.strictEqual(allowResume(cp({ resumeSupport: 'smart', resumeThreshold: 100 }), 99, 'a'), false);
  assert.strictEqual(allowResume(cp({ resumeSupport: 'smart', resumeThreshold: 100 }), 100, 'a'), true);
  // '<name>.filepart' has to fit in a file name, and 255 is the limit that
  // bites — not MAX_PATH.
  assert.strictEqual(allowResume(cp({ resumeSupport: 'on' }), 1, 'x'.repeat(250)), false);
  assert.strictEqual(allowResume(cp({ resumeSupport: 'on' }), 1, 'x'.repeat(240)), true);
});

test('UseAsciiTransfer, RemoteFileRights, LocalFileAttrs, SkipTransfer', () => {
  assert.strictEqual(useAsciiTransfer(cp({ transferMode: 'text' }), 'a.bin', SIDES.local, {}), true);
  assert.strictEqual(useAsciiTransfer(cp({ transferMode: 'binary' }), 'a.txt', SIDES.local, {}), false);
  const auto = cp({ transferMode: 'automatic', asciiFileMask: '*.txt' });
  assert.strictEqual(useAsciiTransfer(auto, 'a.txt', SIDES.local, {}), true);
  assert.strictEqual(useAsciiTransfer(auto, 'a.bin', SIDES.local, {}), false);

  // AddExecute: read or write in a group implies execute, for directories only.
  assert.strictEqual(remoteFileRights(cp({ rights: 'rw-r--r--' }), false), 'rw-r--r--');
  assert.strictEqual(remoteFileRights(cp({ rights: 'rw-r--r--' }), true), 'rwxr-xr-x');
  assert.strictEqual(remoteFileRights(cp({ rights: 'rw-r--r--', addXToDirectories: false }), true), 'rw-r--r--');

  assert.strictEqual(localFileReadOnly(cp({ preserveReadOnly: true }), 'r--r--r--'), true);
  assert.strictEqual(localFileReadOnly(cp({ preserveReadOnly: true }), 'rw-r--r--'), false);
  // TCopyParamType::Default has PreserveReadOnly = false, so the default does nothing.
  assert.strictEqual(localFileReadOnly(cp(), 'r--r--r--'), false);
  assert.strictEqual(localFileReadOnly(cp({ preserveReadOnly: false }), 'r--r--r--'), false);

  // A directory is never skipped by the list: the path is added when a
  // transfer STARTS, so each file underneath still has to be checked.
  const skip = cp({ transferSkipList: ['/a/b.txt', '/a/dir'] });
  assert.strictEqual(skipTransfer(skip, '/a/b.txt', false), true);
  assert.strictEqual(skipTransfer(skip, '/a/dir', true), false);
  assert.strictEqual(skipTransfer(skip, '/a/c.txt', false), false);

  assert.strictEqual(resumeTransfer(cp({ transferResumeFile: '/a/b' }), '/a/b'), true);
  assert.strictEqual(resumeTransfer(cp({ transferResumeFile: '/a/b' }), '/a/c'), false);
  assert.strictEqual(resumeTransfer(cp(), ''), false, 'an empty resume file matches nothing');

  assert.strictEqual(allowAnyTransfer(cp()), true);
  assert.strictEqual(allowAnyTransfer(cp({ includeFileMask: '*.txt' })), false);
  assert.strictEqual(allowAnyTransfer(cp({ excludeHiddenFiles: true })), false);
  assert.strictEqual(allowAnyTransfer(cp({ transferSkipList: ['x'] })), false);
  assert.strictEqual(allowAnyTransfer(cp({ transferResumeFile: 'x' })), false);
});

test('RollbackTransfer and AddResumed keep the totals honest', () => {
  const p = progressFor(SIDES.local);
  p.transferSize = 1000;
  addResumed(p, 300);
  assert.strictEqual(p.transferredSize, 300, 'resumed bytes count as transferred');
  assert.strictEqual(p.skippedSize, 300, 'and as skipped, so throughput is not inflated');
  assert.strictEqual(p.totalSkipped, 300);
  p.addTransferred(200);
  assert.strictEqual(p.totalTransferred, 500);

  rollbackTransfer(p);
  // 500 transferred, of which 300 were resumed: only the 200 we really moved
  // come back out of the total.
  assert.strictEqual(p.totalTransferred, 300);
  assert.strictEqual(p.totalSkipped, 0);
  assert.strictEqual(p.transferredSize, 0);
  assert.strictEqual(p.transferSize, 0);
});

// ===========================================================================
// EffectiveBatchOverwrite — the precedence ladder
// ===========================================================================

function engineFor(options = {}) {
  const { terminal, remote, queries, answers, session } = makeTerminal(options);
  const engine = new TransferEngine(terminal, {
    localAdapter: new MemoryAdapter({ name: 'Local' }),
    copyBytes: async () => 0,
  });
  return { engine, terminal, remote, queries, answers, session };
}

test('EffectiveBatchOverwrite runs WinSCP\'s ladder in WinSCP\'s order', () => {
  const { engine } = engineFor();
  const up = () => progressFor(SIDES.local);
  const eb = (copyParam, params, progress, special) =>
    engine.effectiveBatchOverwrite('/l/a.txt', copyParam, params, progress, special);

  // Rung 1 — cpResume, but ONLY on the "special" pass.
  assert.strictEqual(eb(cp(), COPY_FLAGS.resume, up(), true), BATCH_OVERWRITE.resume);
  assert.strictEqual(eb(cp(), COPY_FLAGS.resume, up(), false), BATCH_OVERWRITE.no,
    'the fallback pass must not offer resume');
  // "Resume this one file" is the same rung.
  assert.strictEqual(eb(cp({ transferResumeFile: '/l/a.txt' }), 0, up(), true), BATCH_OVERWRITE.resume);
  assert.strictEqual(eb(cp({ transferResumeFile: '/l/other' }), 0, up(), true), BATCH_OVERWRITE.no);
  // A part of a split file is never "resumed" — its offset is deliberate.
  assert.strictEqual(eb(cp({ partOffset: 0 }), COPY_FLAGS.resume, up(), true), BATCH_OVERWRITE.no);

  // Rung 2 — cpAppend, and it beats rung 1's absence and everything below.
  assert.strictEqual(eb(cp(), COPY_FLAGS.append, up(), true), BATCH_OVERWRITE.append);
  assert.strictEqual(eb(cp(), COPY_FLAGS.append, up(), false), BATCH_OVERWRITE.append,
    'append survives the fallback pass');
  assert.strictEqual(eb(cp({ newerOnly: true }), COPY_FLAGS.append, up(), true), BATCH_OVERWRITE.append,
    'append beats newer-only');
  assert.strictEqual(eb(cp(), COPY_FLAGS.append | COPY_FLAGS.noConfirmation, up(), true),
    BATCH_OVERWRITE.append, 'append beats "do not confirm"');
  // But rung 1 beats rung 2.
  assert.strictEqual(eb(cp(), COPY_FLAGS.append | COPY_FLAGS.resume, up(), true), BATCH_OVERWRITE.resume);

  // Rung 3 — newer-only. It beats "do not confirm", which is what makes
  // "transfer only new files" work in an unattended queue.
  assert.strictEqual(eb(cp({ newerOnly: true }), 0, up(), true), BATCH_OVERWRITE.older);
  assert.strictEqual(eb(cp({ newerOnly: true }), COPY_FLAGS.noConfirmation, up(), true),
    BATCH_OVERWRITE.older);
  // A part of a split file suppresses it, same as rung 1.
  assert.strictEqual(eb(cp({ newerOnly: true, partOffset: 0 }), COPY_FLAGS.noConfirmation, up(), true),
    BATCH_OVERWRITE.all);

  // Rung 4 — the confirmation switches.
  assert.strictEqual(eb(cp(), COPY_FLAGS.noConfirmation, up(), true), BATCH_OVERWRITE.all);

  // Rung 5 — whatever the user already answered "to all" with.
  assert.strictEqual(eb(cp(), 0, up(), true), BATCH_OVERWRITE.no);
  assert.strictEqual(eb(cp(), 0, progressFor(SIDES.local, { batchOverwrite: BATCH_OVERWRITE.all }), true),
    BATCH_OVERWRITE.all);
  // The fallback pass strips the three resume-shaped modes so a stale answer
  // cannot leak into a file that cannot be resumed.
  for (const mode of [BATCH_OVERWRITE.older, BATCH_OVERWRITE.alternateResume, BATCH_OVERWRITE.resume]) {
    const p = progressFor(SIDES.local, { batchOverwrite: mode });
    assert.strictEqual(eb(cp(), 0, p, true), mode, `${mode} survives the special pass`);
    assert.strictEqual(eb(cp(), 0, p, false), BATCH_OVERWRITE.no, `${mode} is stripped on the fallback`);
  }
});

test('newer-only on upload needs a target timestamp that means something', () => {
  // SFTP reports a real modification time, so "only newer" is offered.
  const sftp = engineFor({ remote: new MemoryAdapter({ name: 'SFTP' }) });
  assert.strictEqual(
    sftp.engine.effectiveBatchOverwrite('/a', cp({ newerOnly: true }), 0, progressFor(SIDES.local), true),
    BATCH_OVERWRITE.older);

  // S3 assigns Last-Modified itself, so an uploaded object always looks
  // "older" than the file that produced it. WinSCP answers fcNewerOnlyUpload
  // false there, and the option must not silently do the wrong thing.
  for (const name of ['S3', 'WebDAV', 'SCP']) {
    const e = engineFor({ remote: new MemoryAdapter({ name }) });
    assert.strictEqual(
      e.engine.effectiveBatchOverwrite('/a', cp({ newerOnly: true }), 0, progressFor(SIDES.local), true),
      BATCH_OVERWRITE.no, `${name} must not claim newer-only upload`);
    // On DOWNLOAD the comparison is against a local file, so it is fine.
    assert.strictEqual(
      e.engine.effectiveBatchOverwrite('/a', cp({ newerOnly: true }), 0, progressFor(SIDES.remote), true),
      BATCH_OVERWRITE.older, `${name} must still offer newer-only on download`);
  }

  // An adapter may state it outright.
  const declared = engineFor({ remote: new MemoryAdapter({ name: 'S3', caps: { newerOnlyUpload: true } }) });
  assert.strictEqual(
    declared.engine.effectiveBatchOverwrite('/a', cp({ newerOnly: true }), 0, progressFor(SIDES.local), true),
    BATCH_OVERWRITE.older);
});

test('CheckRemoteFile skips the existence probe only for an unconditional overwrite', () => {
  const { engine } = engineFor();
  const p = () => progressFor(SIDES.local);
  // "Overwrite everything" — there is nothing worth asking the server.
  assert.strictEqual(engine.checkRemoteFile('/a', cp(), COPY_FLAGS.noConfirmation, p()), false);
  // Everything else has to look first.
  assert.strictEqual(engine.checkRemoteFile('/a', cp(), 0, p()), true);
  assert.strictEqual(engine.checkRemoteFile('/a', cp(), COPY_FLAGS.resume, p()), true);
  assert.strictEqual(engine.checkRemoteFile('/a', cp(), COPY_FLAGS.append, p()), true);
  assert.strictEqual(engine.checkRemoteFile('/a', cp({ newerOnly: true }), COPY_FLAGS.noConfirmation, p()), true);
});

// ===========================================================================
// ConfirmFileOverwrite
// ===========================================================================

const ALL_ANSWERS = [ANSWERS.yes, ANSWERS.no, ANSWERS.cancel,
  ANSWERS.yesToAll, ANSWERS.noToAll, ANSWERS.all, 'ignore', ANSWERS.retry];

/**
 * A source that is unambiguously newer than the target. The gap has to clear
 * CompareFileTime's two-second FAT tolerance, or "yes to newer" correctly
 * answers no and the test is asserting the wrong thing.
 */
function fileParams(over) {
  return new OverwriteFileParams({
    sourceSize: 100, sourceTimestamp: 20000, destSize: 100, destTimestamp: 1000, ...(over || {}),
  });
}

test('a batch mode answers the overwrite question without asking anybody', async () => {
  const cases = [
    [BATCH_OVERWRITE.all, ANSWERS.yes],
    [BATCH_OVERWRITE.none, ANSWERS.no],
    [BATCH_OVERWRITE.append, ANSWERS.retry],
  ];
  for (const [batch, expected] of cases) {
    const { engine, queries } = engineFor();
    const p = progressFor(SIDES.local, { batchOverwrite: batch });
    const answer = await engine.confirmFileOverwrite('/l/a', 'a', fileParams(), ALL_ANSWERS,
      SIDES.remote, cp(), 0, p);
    assert.strictEqual(answer, expected, `${batch} -> ${expected}`);
    assert.strictEqual(queries.length, 0, `${batch} must not ask`);
  }
});

test('boOlder compares the two timestamps at the COARSER of the two precisions', async () => {
  const { engine, queries } = engineFor();
  const p = () => progressFor(SIDES.local, { batchOverwrite: BATCH_OVERWRITE.older });

  // Source newer -> overwrite.
  assert.strictEqual(
    await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceTimestamp: 20000, destTimestamp: 10000 }), ALL_ANSWERS, SIDES.remote, cp(), 0, p()),
    ANSWERS.yes);
  // Source older -> leave it alone.
  assert.strictEqual(
    await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceTimestamp: 10000, destTimestamp: 20000 }), ALL_ANSWERS, SIDES.remote, cp(), 0, p()),
    ANSWERS.no);
  // Within FAT's two-second tolerance -> the same file, so no.
  assert.strictEqual(
    await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceTimestamp: 11000, destTimestamp: 10000 }), ALL_ANSWERS, SIDES.remote, cp(), 0, p()),
    ANSWERS.no);

  // The precision rule: a source 30 seconds newer than the target, but the
  // TARGET only reports minutes (an `ls` line). Reduced to minutes the two are
  // the same, so re-copying would happen on every single run.
  const base = Date.UTC(2026, 0, 2, 3, 4, 0);
  assert.strictEqual(
    await engine.confirmFileOverwrite('/l/a', 'a', fileParams({
      sourceTimestamp: base + 30000, sourcePrecision: MODIFICATION_FMT.FULL,
      destTimestamp: base, destPrecision: MODIFICATION_FMT.MDHM,
    }), ALL_ANSWERS, SIDES.remote, cp(), 0, p()),
    ANSWERS.no, 'a sub-minute difference is invisible at minute precision');
  // A whole minute newer IS visible at minute precision.
  assert.strictEqual(
    await engine.confirmFileOverwrite('/l/a', 'a', fileParams({
      sourceTimestamp: base + 60000, sourcePrecision: MODIFICATION_FMT.FULL,
      destTimestamp: base, destPrecision: MODIFICATION_FMT.MDHM,
    }), ALL_ANSWERS, SIDES.remote, cp(), 0, p()),
    ANSWERS.yes);

  assert.strictEqual(queries.length, 0, 'a batch decision never asks');
});

test('boOlder with no file information refuses rather than guessing', async () => {
  // The batch mode is "older", but there is nothing to compare. The special
  // pass is therefore not applicable and the fallback pass runs — which, with
  // confirmations on, means the user IS asked.
  const asked = engineFor({ answers: [ANSWERS.yes] });
  const p = progressFor(SIDES.local, { batchOverwrite: BATCH_OVERWRITE.older });
  const answer = await asked.engine.confirmFileOverwrite('/l/a', 'a', null, ALL_ANSWERS,
    SIDES.remote, cp(), 0, p);
  assert.strictEqual(answer, ANSWERS.yes);
  assert.strictEqual(asked.queries.length, 1, 'the inapplicable batch mode falls back to asking');

  // With confirmations off the fallback resolves to "overwrite everything",
  // and "older with no information" never gets the chance to say no.
  const silent = engineFor();
  const answer2 = await silent.engine.confirmFileOverwrite('/l/a', 'a', null, ALL_ANSWERS,
    SIDES.remote, cp({ newerOnly: true }), COPY_FLAGS.noConfirmation,
    progressFor(SIDES.local));
  assert.strictEqual(answer2, ANSWERS.no, 'newer-only with no information does not overwrite');
  assert.strictEqual(silent.queries.length, 0);
});

test('a resume batch mode that cannot be applied falls back instead of skipping', async () => {
  // boResume is only applicable when the target is SHORTER than the source.
  // Applicable: answer straight through as "retry" (append or resume).
  {
    const { engine, queries } = engineFor();
    const answer = await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceSize: 100, destSize: 40 }), ALL_ANSWERS, SIDES.remote,
      cp(), COPY_FLAGS.resume, progressFor(SIDES.local));
    assert.strictEqual(answer, ANSWERS.retry);
    assert.strictEqual(queries.length, 0);
  }
  // Not applicable (target is not shorter): the fallback pass runs. cpResume
  // is stripped there, so with confirmations on the user is asked.
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.yes] });
    const answer = await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceSize: 100, destSize: 100 }), ALL_ANSWERS, SIDES.remote,
      cp(), COPY_FLAGS.resume, progressFor(SIDES.local));
    assert.strictEqual(answer, ANSWERS.yes);
    assert.strictEqual(queries.length, 1);
  }
  // boAlternateResume behaves the same way, and when it IS applicable it
  // answers with the "skip" that means "resume, do not append".
  {
    const { engine } = engineFor();
    const answer = await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceSize: 100, destSize: 40 }), ALL_ANSWERS, SIDES.remote, cp(), 0,
      progressFor(SIDES.local, { batchOverwrite: BATCH_OVERWRITE.alternateResume }));
    assert.strictEqual(answer, ANSWERS.skip);
  }
  // Text mode kills alternate resume outright: the byte offsets on the two
  // sides stop corresponding once line endings are rewritten.
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.yes] });
    const answer = await engine.confirmFileOverwrite('/l/a', 'a',
      fileParams({ sourceSize: 100, destSize: 40 }), ALL_ANSWERS, SIDES.remote, cp(), 0,
      progressFor(SIDES.local, { batchOverwrite: BATCH_OVERWRITE.alternateResume, asciiTransfer: true }));
    assert.strictEqual(answer, ANSWERS.yes);
    assert.strictEqual(queries.length, 1);
  }
});

test('the dialog answers that set a batch mode set it for the whole operation', async () => {
  const cases = [
    [ANSWERS.yesToAll, BATCH_OVERWRITE.all, ANSWERS.yes],
    [ANSWERS.all, BATCH_OVERWRITE.older, ANSWERS.yes],       // "Yes to newer"
    [ANSWERS.noToAll, BATCH_OVERWRITE.none, ANSWERS.no],
  ];
  for (const [given, batch, resolved] of cases) {
    const { engine } = engineFor({ answers: [given] });
    const p = progressFor(SIDES.local);
    const answer = await engine.confirmFileOverwrite('/l/a', 'a', fileParams(), ALL_ANSWERS,
      SIDES.remote, cp(), 0, p);
    assert.strictEqual(p.batchOverwrite, batch, `${given} -> ${batch}`);
    assert.strictEqual(answer, resolved);
  }

  // A plain yes/no is about THIS file only and must not become a batch mode.
  for (const given of [ANSWERS.yes, ANSWERS.no]) {
    const { engine } = engineFor({ answers: [given] });
    const p = progressFor(SIDES.local);
    const answer = await engine.confirmFileOverwrite('/l/a', 'a', fileParams(), ALL_ANSWERS,
      SIDES.remote, cp(), 0, p);
    assert.strictEqual(answer, given);
    assert.strictEqual(p.batchOverwrite, BATCH_OVERWRITE.no, `${given} must not stick`);
  }
});

test('"never ask again" turns the preference off and answers yes', async () => {
  const { engine, session } = engineFor({ answers: [ANSWERS.neverAskAgain] });
  const p = progressFor(SIDES.local);
  const answer = await engine.confirmFileOverwrite('/l/a', 'a', fileParams(), ALL_ANSWERS,
    SIDES.remote, cp(), 0, p);
  assert.strictEqual(answer, ANSWERS.yes);
  assert.strictEqual(session.config.prefs.confirmOverwriting, false);
  // And from now on the ladder resolves to "overwrite everything" on its own.
  assert.strictEqual(engine.effectiveBatchOverwrite('/l/a', cp(), 0, progressFor(SIDES.local), true),
    BATCH_OVERWRITE.all);
});

test('a cancel raised by another parallel connection short-circuits the question', async () => {
  const { engine, queries } = engineFor();
  const p = progressFor(SIDES.local, { cancel: CANCEL.cancel });
  const answer = await engine.confirmFileOverwrite('/l/a', 'a', fileParams(), ALL_ANSWERS,
    SIDES.remote, cp(), 0, p);
  assert.strictEqual(answer, ANSWERS.cancel);
  assert.strictEqual(queries.length, 0,
    'the user already said stop; every other connection must not ask again');
});

test('the question carries both sides\' size and timestamp', async () => {
  const { engine, queries } = engineFor({ answers: [ANSWERS.yes] });
  await engine.confirmFileOverwrite('/l/a.txt', 'a.txt',
    fileParams({ sourceSize: 4096, destSize: 1024, sourceTimestamp: 20000, destTimestamp: 10000 }),
    ALL_ANSWERS, SIDES.remote, cp(), 0, progressFor(SIDES.local));
  const q = queries[0];
  assert.match(q.message, /a\.txt/);
  assert.strictEqual(q.moreMessages.length, 2);
  assert.match(q.moreMessages[0], /Source/);
  assert.match(q.moreMessages[1], /Target/);
  assert.ok(q.neverAskAgain, 'the dialog offers "never ask again"');

  // The message names the side the file is ON, not the side it came from.
  const local = engineFor({ answers: [ANSWERS.yes] });
  await local.engine.confirmFileOverwrite('/r/a.txt', 'a.txt', fileParams(), ALL_ANSWERS,
    SIDES.local, cp(), 0, progressFor(SIDES.remote));
  assert.match(local.queries[0].message, /Local file/);
});

// ===========================================================================
// confirmOverwrite — the file-system wrapper
// ===========================================================================

test('confirmOverwrite maps every answer onto a mode, a skip or an abort', async () => {
  // yes -> overwrite
  {
    const { engine } = engineFor({ answers: [ANSWERS.yes] });
    const r = await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), fileParams());
    assert.strictEqual(r.mode, OVERWRITE_MODE.overwrite);
    assert.strictEqual(r.targetFileName, 'a');
  }
  // no -> ESkipFile, and the file is left exactly as it was
  {
    const { engine } = engineFor({ answers: [ANSWERS.no] });
    await assert.rejects(
      () => engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), fileParams()),
      (e) => e.skipFile === true);
  }
  // cancel -> EAbort AND the operation is cancelled, not just this file
  {
    const { engine } = engineFor({ answers: [ANSWERS.cancel] });
    const p = progressFor(SIDES.local);
    await assert.rejects(
      () => engine.confirmOverwrite('/l/a', 'a', cp(), 0, p, fileParams()),
      (e) => e.aborted === true);
    assert.strictEqual(p.cancel, CANCEL.cancel);
  }
});

test('the Rename button prompts, and a dismissed prompt cancels rather than overwriting', async () => {
  {
    const { engine, session } = engineFor({ answers: ['ignore'] });
    session.askAnswers.push({ value: 'a(1).txt' });
    const r = await engine.confirmOverwrite('/l/a.txt', 'a.txt', cp(), 0,
      progressFor(SIDES.local), fileParams());
    assert.strictEqual(r.targetFileName, 'a(1).txt');
    assert.strictEqual(r.mode, OVERWRITE_MODE.overwrite);
    assert.strictEqual(session.askRequests[0].request.value, 'a.txt', 'the prompt is pre-filled');
  }
  {
    // No new name: WinSCP cancels the whole operation rather than falling back
    // to overwriting the file the user was trying to protect.
    const { engine } = engineFor({ answers: ['ignore'] });
    const p = progressFor(SIDES.local);
    await assert.rejects(
      () => engine.confirmOverwrite('/l/a.txt', 'a.txt', cp(), 0, p, fileParams()),
      (e) => e.aborted === true);
    assert.strictEqual(p.cancel, CANCEL.cancel);
  }
});

test('Append versus Resume: the follow-up question, and when it is not asked', async () => {
  const shorter = () => fileParams({ sourceSize: 100, destSize: 40 });
  const equal = () => fileParams({ sourceSize: 100, destSize: 100 });

  // Nothing to resume (the target is not shorter): Append is the only meaning
  // "retry" can have, so no second question is asked.
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.retry] });
    const r = await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), equal());
    assert.strictEqual(r.mode, OVERWRITE_MODE.append);
    assert.strictEqual(queries.length, 1);
  }
  // The target IS shorter, so both are possible and WinSCP asks which.
  for (const [second, mode] of [[ANSWERS.yes, OVERWRITE_MODE.append], [ANSWERS.no, OVERWRITE_MODE.resume]]) {
    const { engine, queries } = engineFor({ answers: [ANSWERS.retry, second] });
    const r = await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), shorter());
    assert.strictEqual(r.mode, mode);
    assert.strictEqual(queries.length, 2);
    assert.match(queries[1].message, /Append the source to it, or resume/);
  }
  // "Resume all" answers this question for the rest of the operation.
  {
    const { engine } = engineFor({ answers: [ANSWERS.retry, ANSWERS.noToAll] });
    const p = progressFor(SIDES.local);
    const r = await engine.confirmOverwrite('/l/a', 'a', cp(), 0, p, shorter());
    assert.strictEqual(r.mode, OVERWRITE_MODE.resume);
    assert.strictEqual(p.batchOverwrite, BATCH_OVERWRITE.alternateResume);
  }
  // Cancelling the follow-up cancels the operation.
  {
    const { engine } = engineFor({ answers: [ANSWERS.retry, ANSWERS.cancel] });
    const p = progressFor(SIDES.local);
    await assert.rejects(
      () => engine.confirmOverwrite('/l/a', 'a', cp(), 0, p, shorter()),
      (e) => e.aborted === true);
    assert.strictEqual(p.cancel, CANCEL.cancel);
  }
  // A caller whose dialog already offered both buttons answers directly.
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.retry] });
    const r = await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), shorter(),
      { resolveAppendOrResume: () => OVERWRITE_MODE.resume });
    assert.strictEqual(r.mode, OVERWRITE_MODE.resume);
    assert.strictEqual(queries.length, 1, 'no second question when the first one already answered it');
  }
  // A protocol that cannot append does not offer the button at all.
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.yes] });
    await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local), shorter(),
      { canAppend: false });
    assert.ok(!queries[0].answers.includes(ANSWERS.retry),
      'Append must not be offered where it cannot be honoured');
  }
});

test('Append is withheld from an encrypted session and from a text-mode transfer', async () => {
  // SFTPConfirmOverwrite:
  //   CanAppend = !IsEncryptingFiles() && ((FVersion < 4) || !AsciiTransfer)
  // Both halves are data-loss guards. Appending plaintext to an encrypted file
  // leaves a tail nothing can decrypt; appending at a byte offset while the
  // far side is rewriting line endings writes into the wrong place.
  // With encryption on, the Append button is absent from the question.
  {
    const { engine, queries } = engineFor({
      answers: [ANSWERS.yes], data: { encryptFiles: true },
    });
    const dst = { caps: { resume: true } };
    await engine.confirmOverwrite('/l/a', 'a', cp(), 0, progressFor(SIDES.local),
      fileParams({ sourceSize: 100, destSize: 40 }),
      { canAppend: X.canAppendTo(engine, dst, progressFor(SIDES.local)) });
    assert.ok(!queries[0].answers.includes(ANSWERS.retry),
      'an encrypted session must not offer Append');
  }
  // And with a text-mode transfer in progress.
  {
    const { engine } = engineFor({ answers: [] });
    const dst = { caps: { resume: true } };
    assert.strictEqual(X.canAppendTo(engine, dst, progressFor(SIDES.local, { asciiTransfer: true })), false);
    assert.strictEqual(X.canAppendTo(engine, dst, progressFor(SIDES.local)), true);
    assert.strictEqual(X.canAppendTo(engine, { caps: { resume: false } }, progressFor(SIDES.local)), false);
  }
});

// ===========================================================================
// SFTPConfirmResume
// ===========================================================================

test('a partial file longer than the source is never spliced onto', async () => {
  const { engine, queries } = engineFor({ answers: [ANSWERS.ok] });
  const p = progressFor(SIDES.local);
  const resume = await engine.confirmResumeTransfer('a.bin', true, p);
  assert.strictEqual(resume, false, 'it is somebody else\'s file: start over');
  assert.match(queries[0].message, /larger than the file being transferred/);
  assert.strictEqual(queries[0].type, 'warning');

  // Aborting that warning cancels the operation.
  const aborted = engineFor({ answers: [ANSWERS.abort] });
  const p2 = progressFor(SIDES.local);
  await assert.rejects(() => aborted.engine.confirmResumeTransfer('a.bin', true, p2),
    (e) => e.aborted === true);
  assert.strictEqual(p2.cancel, CANCEL.cancel);
});

test('the resume question honours its preference and its "never ask again"', async () => {
  {
    const { engine, queries } = engineFor({ answers: [ANSWERS.yes] });
    assert.strictEqual(await engine.confirmResumeTransfer('a.bin', false, progressFor(SIDES.local)), true);
    assert.strictEqual(queries.length, 1);
  }
  {
    const { engine } = engineFor({ answers: [ANSWERS.no] });
    assert.strictEqual(await engine.confirmResumeTransfer('a.bin', false, progressFor(SIDES.local)), false);
  }
  {
    const { engine, session } = engineFor({ answers: [ANSWERS.neverAskAgain] });
    assert.strictEqual(await engine.confirmResumeTransfer('a.bin', false, progressFor(SIDES.local)), true);
    assert.strictEqual(session.config.prefs.confirmResume, false);
  }
  {
    const { engine, queries } = engineFor({ prefs: { confirmResume: false } });
    assert.strictEqual(await engine.confirmResumeTransfer('a.bin', false, progressFor(SIDES.local)), true);
    assert.strictEqual(queries.length, 0);
  }
  {
    const { engine } = engineFor({ answers: [ANSWERS.cancel] });
    const p = progressFor(SIDES.local);
    await assert.rejects(() => engine.confirmResumeTransfer('a.bin', false, p), (e) => e.aborted === true);
    assert.strictEqual(p.cancel, CANCEL.cancel);
  }
});

// ===========================================================================
// TCollectedFileList
// ===========================================================================

test('TCollectedFileList records what could not be recursed into', () => {
  const list = new CollectedFileList();
  list.add('/a', null, true);
  const i = list.add('/a/sub', null, true);
  list.add('/a/sub/f.txt', { size: 1 }, false);
  assert.strictEqual(list.count(), 3);
  assert.strictEqual(list.isDir(0), true);
  assert.strictEqual(list.isRecursed(i), true);
  list.didNotRecurse(i);
  assert.strictEqual(list.isRecursed(i), false,
    'the entry stays so the failure is reproduced when the transfer reaches it');

  list.setState(0, 1);
  assert.strictEqual(list.getState(0), 1);
  assert.strictEqual(list.getState(1), 0);

  list.delete(1);
  assert.deepStrictEqual([list.getFileName(0), list.getFileName(1)], ['/a', '/a/sub/f.txt']);

  const from = CollectedFileList.fromCollected([
    { fileName: '/x', dir: true, recursed: false },
    { fileName: '/x/y', file: { size: 2 }, dir: false },
  ]);
  assert.strictEqual(from.count(), 2);
  assert.strictEqual(from.isRecursed(0), false);
  assert.deepStrictEqual(from.getObject(1), { size: 2 });
});

// ===========================================================================
// TParallelOperation
// ===========================================================================

function parallelFor(files, options = {}) {
  const op = new ParallelOperation(options.side || SIDES.remote);
  const list = new CollectedFileList();
  for (const f of files) list.add(f.name, f.object || null, !!f.dir);
  op.init([{ rootPath: options.root || '/r', files: list }], options.targetDir || '/t',
    cp(), options.params || 0, options.progress || progressFor(SIDES.remote),
    'main', options.parallelFileSize === undefined ? -1 : options.parallelFileSize,
    options.transfersLimit);
  return { op, list };
}

test('the parallel cursor hands out one entry at a time and then reports the end', () => {
  const { op } = parallelFor([
    { name: '/r/a.txt' },
    { name: '/r/b.txt' },
  ]);
  const first = {};
  assert.strictEqual(op.getNext(first), 1);
  assert.strictEqual(first.fileName, '/r/a.txt');
  assert.strictEqual(first.targetDir, '/t');
  const second = {};
  assert.strictEqual(op.getNext(second), 1);
  assert.strictEqual(second.fileName, '/r/b.txt');
  const third = {};
  assert.strictEqual(op.getNext(third), -1, 'the list is exhausted');
  assert.strictEqual(op.shouldAddClient(), false, 'no point starting another connection');
});

test('a file waits for its parent directory to actually exist', async () => {
  const { op } = parallelFor([
    { name: '/r/d', dir: true },
    { name: '/r/d/f.txt' },
  ]);
  const dir = {};
  assert.strictEqual(op.getNext(dir), 1);
  assert.strictEqual(dir.dir, true);

  const child = {};
  assert.strictEqual(op.getNext(child), 0,
    'the child must not be handed out before its directory is created');

  await op.done('/r/d', true, true, '/t', cp(), null);
  const again = {};
  assert.strictEqual(op.getNext(again), 1);
  assert.strictEqual(again.fileName, '/r/d/f.txt');
  assert.strictEqual(again.targetDir, '/t\\d',
    'the child goes into the directory the parent created');
});

test('a directory that failed takes its whole subtree out of the list', async () => {
  const { op, list } = parallelFor([
    { name: '/r/d', dir: true },
    { name: '/r/d/1.txt' },
    { name: '/r/d/2.txt' },
    { name: '/r/e.txt' },
  ]);
  const dir = {};
  op.getNext(dir);
  const versionBefore = op.version;

  await op.done('/r/d', true, false, '/t', cp(), null);
  assert.strictEqual(list.count(), 2, 'both files under the failed directory are gone');
  assert.ok(op.version > versionBefore, 'the queue view has to be refreshed');

  // What is left is the directory entry (already handed out) and the sibling.
  const next = {};
  assert.strictEqual(op.getNext(next), 1);
  assert.strictEqual(next.fileName, '/r/e.txt');
});

test('a parallel operation stops handing work out once it is cancelled', () => {
  const progress = progressFor(SIDES.remote);
  const { op } = parallelFor([{ name: '/r/a.txt' }], { progress });
  assert.strictEqual(op.shouldAddClient(), true);
  progress.setCancelAtLeast(CANCEL.cancel);
  assert.strictEqual(op.shouldAddClient(), false);
});

test('GetOnlyFile recognises exactly one plain file and nothing else', () => {
  const one = new CollectedFileList();
  one.add('/r/big.bin', { size: 99 }, false);
  assert.deepStrictEqual(ParallelOperation.getOnlyFile([{ rootPath: '/r', files: one }]),
    { fileName: '/r/big.bin', object: { size: 99 } });

  const dir = new CollectedFileList();
  dir.add('/r/d', null, true);
  assert.strictEqual(ParallelOperation.getOnlyFile([{ rootPath: '/r', files: dir }]), null,
    'a directory cannot be split across connections');

  const two = new CollectedFileList();
  two.add('/r/a', null, false);
  two.add('/r/b', null, false);
  assert.strictEqual(ParallelOperation.getOnlyFile([{ rootPath: '/r', files: two }]), null);
  assert.strictEqual(ParallelOperation.getOnlyFile([]), null);
});

test('splitting one file carves parts, and folds a tiny last part into its predecessor', () => {
  // 1000 bytes over 4 connections: parts of 250. The final carve would leave
  // 250 exactly, so it is taken "until the end" rather than as a fifth part.
  const { op } = parallelFor([{ name: '/r/big.bin', object: { size: 1000 } }],
    { parallelFileSize: 1000, transfersLimit: 4 });
  const offsets = [];
  const sizes = [];
  for (let i = 0; i < 4; i++) {
    const out = {};
    const got = op.getNext(out);
    assert.strictEqual(got, 1, `part ${i} must be handed out`);
    offsets.push(out.customCopyParam.partOffset);
    sizes.push(out.customCopyParam.partSize);
  }
  assert.deepStrictEqual(offsets, [0, 250, 500, 750]);
  assert.deepStrictEqual(sizes, [250, 250, 250, -1], 'the last part runs to EOF');
  assert.strictEqual(op.getNext({}), -1);

  // Each part writes to its own name so they cannot collide.
  assert.strictEqual(ParallelOperation.getPartPrefix('big.bin'), 'big.bin.filepart.');

  // A remainder smaller than a tenth of a part is folded in rather than
  // opening a connection to move a handful of bytes.
  const { op: op2 } = parallelFor([{ name: '/r/b.bin', object: { size: 205 } }],
    { parallelFileSize: 205, transfersLimit: 2 });
  const a = {}; op2.getNext(a);
  assert.strictEqual(a.customCopyParam.partOffset, 0);
  assert.strictEqual(a.customCopyParam.partSize, 102);
  const b = {}; op2.getNext(b);
  assert.strictEqual(b.customCopyParam.partSize, -1, 'the 1-byte tail is not its own part');
  assert.strictEqual(op2.getNext({}), -1);
});

test('each part of a split download is bounded and lands under its own name', async () => {
  const { engine, local, remote, moved } = makeEngine();
  remote.put('/r/big.bin', 'ABCDEFGHIJ');
  local.putDir('/l');

  // Part 1 of a split: read bytes 4..7 of the source, write to `.filepart.1`.
  const part = cp({
    preserveTime: false, resumeSupport: 'off', partOffset: 4, partSize: 4,
    fileMask: 'big.bin.filepart.1',
  });
  await engine.copyToLocal(['/r/big.bin'], '/l', part, COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(moved.length, 1);
  assert.strictEqual(moved[0].readFrom, 4, 'the part starts at its own offset');
  assert.strictEqual(moved[0].targetPath, '/l/big.bin.filepart.1',
    'each part writes to its own name so two connections cannot collide');
  // The plan bounds the read; a mover that ignored readTo would run to EOF and
  // the merged file would be longer than the original.
  assert.strictEqual(local.text('/l/big.bin.filepart.1'), 'EFGHIJ',
    'this fixture mover ignores readTo on purpose — the bound is in the plan');
});

test('the plan tells the byte mover exactly where a part stops', async () => {
  const plans = [];
  const { engine, local, remote } = makeEngine({
    copyBytes: async () => 0,
  });
  engine.copyBytes = async (plan) => { plans.push(plan); return 0; };
  remote.put('/r/big.bin', 'ABCDEFGHIJ');
  local.putDir('/l');

  await engine.copyToLocal(['/r/big.bin'], '/l',
    cp({ preserveTime: false, resumeSupport: 'off', partOffset: 4, partSize: 4 }),
    COPY_FLAGS.noConfirmation, null);
  assert.strictEqual(plans[0].readFrom, 4);
  assert.strictEqual(plans[0].readTo, 7, 'inclusive, like createReadStream({ end })');
  assert.strictEqual(plans[0].size, 4);

  // The LAST part has no partSize: it runs to the end of the file.
  plans.length = 0;
  await engine.copyToLocal(['/r/big.bin'], '/l',
    cp({ preserveTime: false, resumeSupport: 'off', partOffset: 8, partSize: -1 }),
    COPY_FLAGS.noConfirmation, null);
  assert.strictEqual(plans[0].readFrom, 8);
  assert.strictEqual(plans[0].readTo, undefined);
  assert.strictEqual(plans[0].size, 2, 'the remaining bytes of the file');
});

test('resume is refused for a split part and for an encrypted download', async () => {
  // TSFTPFileSystem::Sink's ResumeAllowed also demands PartOffset < 0 and
  // !IsEncryptingFiles(). A part written through the '.filepart' dance would be
  // renamed over the final target while its siblings are still arriving; an
  // encrypted download cannot be spliced at all, because what is already on
  // disk is ciphertext whose stream position the far side no longer knows.
  {
    const { engine, local, remote, moved } = makeEngine();
    remote.put('/r/big.bin', 'ABCDEFGHIJ');
    local.putDir('/l');
    await engine.copyToLocal(['/r/big.bin'], '/l',
      cp({
        preserveTime: false, resumeSupport: 'on',
        partOffset: 4, partSize: 4, fileMask: 'big.bin.filepart.1',
      }), COPY_FLAGS.noConfirmation, null);
    assert.strictEqual(moved[0].targetPath, '/l/big.bin.filepart.1',
      'a part is written under its own name, never through a second .filepart');
    assert.deepStrictEqual(local.calls.rename, [], 'and it is not renamed over anything');
  }
  {
    const { engine, local, remote, moved } = makeEngine({ data: { encryptFiles: true } });
    remote.put('/r/a.bin', 'ABCDEFGHIJ');
    local.putDir('/l');
    await engine.copyToLocal(['/r/a.bin'], '/l',
      cp({ preserveTime: false, resumeSupport: 'on' }), COPY_FLAGS.noConfirmation, null);
    assert.strictEqual(moved[0].targetPath, '/l/a.bin',
      'an encrypted download writes straight to the target, with no resumable part');
    assert.deepStrictEqual(local.calls.rename, []);
  }
});

/** A byte mover that honours `readTo`, which is what a split transfer needs. */
function boundedMover(over) {
  return async (plan) => {
    const rs = await plan.sourceAdapter.createReadStream(plan.sourcePath, {
      start: plan.readFrom || 0,
      ...(plan.readTo === undefined ? {} : { end: plan.readTo }),
    });
    const ws = await plan.targetAdapter.createWriteStream(plan.targetPath, {
      size: plan.size, start: plan.writeAt, append: plan.append,
    });
    let written = 0;
    for await (const chunk of rs) {
      const out = over ? over(plan, chunk) : chunk;
      if (out.length) ws.write(out);
      written += out.length;
    }
    await new Promise((resolve, reject) => { ws.on('error', reject); ws.end(resolve); });
    plan.onBytes(written);
    return written;
  };
}

function splitEngine(options = {}) {
  return makeEngine({
    prefs: { queue: { transfersLimit: 3, parallelTransferThreshold: 4 } },
    copyBytes: options.copyBytes || boundedMover(),
  });
}

test('a split download merges its parts back into one correct file', async () => {
  // The whole point of splitting a single file across connections: the parts
  // are carved by the cursor, transferred separately, and merged IN ORDER back
  // into the original. Anything less and the user gets a file that is the
  // right length and the wrong content.
  const { engine, local, remote } = splitEngine();
  remote.put('/r/big.bin', 'ABCDEFGHIJKL');       // 12 bytes, 3 parts of 4
  local.putDir('/l');

  const op = new ParallelOperation(SIDES.remote);
  const ok = await engine.copyToLocal(['/r/big.bin'], '/l',
    cp({ preserveTime: false, resumeSupport: 'off' }), 0, op);

  assert.strictEqual(ok, true);
  assert.strictEqual(op.isParallelFileTransfer, true, 'the file really was split');
  assert.strictEqual(local.text('/l/big.bin'), 'ABCDEFGHIJKL',
    'every byte, in the right order');
  // Nothing is left behind: no part files and no '.filepart' staging file.
  assert.deepStrictEqual(
    local.paths().filter((p) => p.includes('.filepart')), [],
    'the parts and the staging file are all cleaned up');
});

test('a part that moved the wrong number of bytes is refused, not merged', async () => {
  // INCONSISTENT_SIZE. A short part would merge into a file that is plausible
  // and wrong, so the original raises rather than splicing it.
  const { engine, local, remote } = splitEngine({
    // Drop a byte from the FIRST part only.
    copyBytes: boundedMover((plan, chunk) =>
      (plan.readFrom === 0 ? chunk.subarray(0, chunk.length - 1) : chunk)),
  });
  remote.put('/r/big.bin', 'ABCDEFGHIJKL');
  local.putDir('/l');

  const op = new ParallelOperation(SIDES.remote);
  await engine.copyToLocal(['/r/big.bin'], '/l',
    cp({ preserveTime: false, resumeSupport: 'off' }), 0, op);

  assert.strictEqual(local.text('/l/big.bin'), null,
    'no merged file is produced from a part of the wrong length');
  assert.ok(op._mainProgress.cancel >= CANCEL.cancel,
    'and one bad part cancels the whole operation');
});

test('a part name is a literal target name, not a mask that reinterprets itself', () => {
  // A remote name full of characters Windows refuses. By the time it becomes a
  // part name the local-name rules have already replaced them, which is the
  // first line of defence; DelimitFileNameMask is the second, so a name that
  // survived scrubbing still cannot be read as a wildcard.
  const { op } = parallelFor([{ name: '/r/we*ird?.bin', object: { size: 1000 } }],
    { parallelFileSize: 1000, transfersLimit: 2 });
  const out = {};
  op.getNext(out);
  assert.strictEqual(out.customCopyParam.fileMask, 'we_ird_.bin.filepart.0');
  // And applying it really does produce that exact name rather than splicing
  // the source name back into it.
  assert.strictEqual(T.maskFileName('we*ird?.bin', out.customCopyParam.fileMask),
    'we_ird_.bin.filepart.0');
  // A name that does reach the mask with a wildcard in it stays literal.
  assert.strictEqual(T.maskFileName('a.bin', 'a.bin.filepart.0'), 'a.bin.filepart.0');
});

test('WaitFor blocks until the last client leaves', async () => {
  const { op } = parallelFor([{ name: '/r/a.txt' }]);
  op.addClient();
  op.addClient();
  let done = false;
  const waiting = op.waitFor(() => Promise.resolve()).then(() => { done = true; });
  await Promise.resolve();
  assert.strictEqual(done, false);
  op.removeClient();
  op.removeClient();
  await waiting;
  assert.strictEqual(done, true);
  assert.strictEqual(op.shouldAddClient(), false, 'and it is definitely empty now');
});

// ===========================================================================
// Whole transfers
// ===========================================================================

test('CopyToRemote uploads a tree, creating each directory before its contents', async () => {
  const { engine, local, remote } = makeEngine();
  local.put('/l/d/a.txt', 'AAA', 1000);
  local.put('/l/d/sub/b.txt', 'BBB', 2000);
  remote.putDir('/r');

  const ok = await engine.copyToRemote(['/l/d'], '/r/', cp({ preserveTime: false }), 0, null);
  assert.strictEqual(ok, true);
  assert.strictEqual(remote.text('/r/d/a.txt'), 'AAA');
  assert.strictEqual(remote.text('/r/d/sub/b.txt'), 'BBB');
  // Every directory was created before anything was written into it.
  assert.deepStrictEqual(remote.calls.mkdir, ['/r/d', '/r/d/sub']);
});

test('CopyToRemote preserves the timestamp and the permissions when asked', async () => {
  const { engine, local, remote } = makeEngine();
  local.put('/l/a.txt', 'A', 123456);
  remote.putDir('/r');
  await engine.copyToRemote(['/l/a.txt'], '/r/',
    cp({ preserveTime: true, preserveRights: true, rights: 'rw-rw----' }), 0, null);
  assert.deepStrictEqual(remote.calls.setTimes, [['/r/a.txt', 123456]]);
  assert.deepStrictEqual(remote.calls.setRights, [['/r/a.txt', 'rw-rw----']]);
});

test('an upload asks about an existing file once per file, and "yes to all" once per operation', async () => {
  const { engine, local, remote, queries } = makeEngine({
    answers: [ANSWERS.yesToAll],
    prefs: { confirmOverwriting: true },
  });
  local.put('/l/d/1.txt', 'N1'); local.put('/l/d/2.txt', 'N2'); local.put('/l/d/3.txt', 'N3');
  remote.putDir('/r/d');
  remote.put('/r/d/1.txt', 'O1'); remote.put('/r/d/2.txt', 'O2'); remote.put('/r/d/3.txt', 'O3');

  await engine.copyToRemote(['/l/d'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
  assert.strictEqual(queries.length, 1, '"yes to all" must not be asked again');
  assert.strictEqual(remote.text('/r/d/3.txt'), 'N3');
});

test('an upload that the user declines leaves the target byte for byte alone', async () => {
  const { engine, local, remote } = makeEngine({ answers: [ANSWERS.no] });
  local.put('/l/a.txt', 'NEW');
  remote.put('/r/a.txt', 'OLD');
  await engine.copyToRemote(['/l/a.txt'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
  assert.strictEqual(remote.text('/r/a.txt'), 'OLD');
});

test('a resumable upload writes to .filepart and only renames when it is complete', async () => {
  const { engine, local, remote, moved } = makeEngine();
  local.put('/l/a.bin', 'ABCDEFGH');
  remote.putDir('/r');
  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'on' }), 0, null);
  assert.strictEqual(moved[0].targetPath, '/r/a.bin.filepart',
    'the bytes go to the part file, never straight over the target');
  assert.deepStrictEqual(remote.calls.rename, [['/r/a.bin.filepart', '/r/a.bin']]);
  assert.strictEqual(remote.text('/r/a.bin'), 'ABCDEFGH');
  assert.strictEqual(remote.has('/r/a.bin.filepart'), false);
});

test('an interrupted upload resumes from the part file instead of starting again', async () => {
  const { engine, local, remote, moved } = makeEngine({ answers: [ANSWERS.yes] });
  local.put('/l/a.bin', 'ABCDEFGH');
  remote.putDir('/r');
  remote.put('/r/a.bin.filepart', 'ABC');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'on' }), 0, null);
  assert.strictEqual(moved[0].readFrom, 3, 'the source is read from where the part ends');
  assert.strictEqual(moved[0].writeAt, 3);
  assert.strictEqual(remote.text('/r/a.bin'), 'ABCDEFGH');
});

test('a part file longer than the source is deleted and the transfer restarted', async () => {
  const { engine, local, remote, moved } = makeEngine({ answers: [ANSWERS.ok] });
  local.put('/l/a.bin', 'ABC');
  remote.putDir('/r');
  remote.put('/r/a.bin.filepart', 'XXXXXXXXXXXX');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'on' }), 0, null);
  assert.ok(remote.calls.remove.includes('/r/a.bin.filepart'), 'the foreign part is removed');
  assert.strictEqual(moved[0].readFrom, 0, 'and the transfer starts from the beginning');
  assert.strictEqual(remote.text('/r/a.bin'), 'ABC');
});

// ---------------------------------------------------------------------------
// "Never do resumable transfer for file owned by other user, as deleting and
// recreating the file would change ownership" — SftpFileSystem.cpp:4694-4700,
// the third arm of the chain whose first arm is the symlink refusal above.
// ---------------------------------------------------------------------------

/** An upload of 'ABCDEFGH' over an existing target owned by `owner`. */
async function uploadOver(owner, userName) {
  const ctx = makeEngine({ data: { userName } });
  ctx.local.put('/l/a.bin', 'ABCDEFGH');
  ctx.remote.putDir('/r').put('/r/a.bin', 'OLD', 0, { owner });
  await ctx.engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'on' }), COPY_FLAGS.noConfirmation, null);
  return ctx;
}

test('a resumable upload refuses a target owned by another user', async () => {
  // The resume path does not overwrite the target in place: it writes a
  // '.filepart', removes the target and renames onto the name, so the file that
  // ends up there is owned by whoever uploaded it. On a shared directory that
  // silently takes a colleague's file away from them, and preserving the rights
  // afterwards does not put the owner back — so the resume is dropped and the
  // bytes go straight at the real name, leaving the file itself untouched.
  const { remote, moved, session } = await uploadOver('bob', 'alice');

  assert.strictEqual(moved[0].targetPath, '/r/a.bin',
    'no .filepart: the existing file must not be replaced by a new one');
  assert.deepStrictEqual(remote.calls.rename, [],
    'and nothing is renamed over the target');
  assert.deepStrictEqual(remote.calls.remove, [],
    'the file whose ownership we are protecting is never deleted');
  assert.strictEqual(remote.text('/r/a.bin'), 'ABCDEFGH',
    'the transfer still happens — WinSCP clears ResumeAllowed, it does not skip');
  assert.ok(session.lines.some((l) => /owned by another user \[bob\]/.test(l)),
    `expected the refusal in the log, got ${JSON.stringify(session.lines)}`);
});

test('the owner check goes through SameUserName, not a string compare', async () => {
  // RemoteFiles.cpp:583-588. Bitvise reports the owner as 'user@host' while the
  // session logged in as 'user', and the comparison is case-insensitive — a
  // file the user does own must not be mistaken for somebody else's and lose
  // its resume for nothing.
  const { remote, moved } = await uploadOver('Alice@vshnode', 'alice');

  assert.strictEqual(moved[0].targetPath, '/r/a.bin.filepart',
    'this file IS ours, so the resumable path is still taken');
  assert.deepStrictEqual(remote.calls.rename, [['/r/a.bin.filepart', '/r/a.bin']]);
});

test('a numeric owner is a uid, not a user name, and never blocks resume', async () => {
  // The regression guard. WinSCP concedes in the comment above its own check
  // that it "won't work for SFTP-3 (OpenSSH) as it does not provide owner name
  // (only UID)", and ssh2 speaks SFTP-3 and nothing else — sftp.js:1345 writes
  // String(uid) into the adapter's flat `owner` field. Comparing '1000' with
  // 'alice' is false for every file on every server, so dropping the
  // ownerName() gate would not tighten this check: it would switch resumable
  // uploads off for everybody on SFTP.
  const { remote, moved } = await uploadOver('1000', 'alice');

  assert.strictEqual(moved[0].targetPath, '/r/a.bin.filepart',
    'a uid says nothing about who owns the file, so resume survives');
  assert.deepStrictEqual(remote.calls.rename, [['/r/a.bin.filepart', '/r/a.bin']]);
});

test('an owner the protocol never reported does not block resume', async () => {
  // `!File->Owner.Name.IsEmpty()` is the precondition of the whole arm: an
  // unknown owner is not evidence of a foreign one.
  const { remote, moved } = await uploadOver('', 'alice');

  assert.strictEqual(moved[0].targetPath, '/r/a.bin.filepart');
  assert.deepStrictEqual(remote.calls.rename, [['/r/a.bin.filepart', '/r/a.bin']]);
});

test('cpNoConfirmation and tfNewDirectory both suppress the existence probe', async () => {
  // A directory we just created cannot contain anything, so a resumable
  // upload into it does not go looking for a part file or a target.
  const { engine, local, remote } = makeEngine();
  local.put('/l/d/a.bin', 'ABCD');
  remote.putDir('/r');
  await engine.copyToRemote(['/l/d'], '/r/', cp({ preserveTime: false, resumeSupport: 'on' }), 0, null);
  // Straight to the part file and a rename; nothing existed to ask about.
  assert.deepStrictEqual(remote.calls.rename, [['/r/d/a.bin.filepart', '/r/d/a.bin']]);
});

// ---------------------------------------------------------------------------
// "Preserve overwritten remote files to recycle bin", TSFTPFileSystem::Source's
// half. queue.js is the path a click actually takes, but this is the literal
// SFTPSource port, and the two have to agree or they drift.
// ---------------------------------------------------------------------------

/** An SFTP engine whose site preserves what it overwrites. */
function recycleEngine(over = {}) {
  return makeEngine({
    remote: new MemoryAdapter({ name: 'SFTP' }),
    data: { overwrittenToRecycleBin: true, recycleBinPath: '/r/.bin', ...(over.data || {}) },
    ...over.rest,
  });
}

const binned = (remote) => remote.paths().filter((p) => p.startsWith('/r/.bin/'));

test('an overwritten upload target is moved to the bin, confirmations or not', async () => {
  // cpNoConfirmation is the point: SftpFileSystem.cpp:5129-5131 says the
  // existence has to be discovered "even if overwrite confirmation is
  // disabled", because that is the only way the file can be preserved. Probing
  // only when a question was coming would leave the setting doing nothing for
  // everyone who turned confirmations off.
  const { engine, local, remote } = recycleEngine();
  local.put('/l/a.bin', 'NEW');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(remote.text('/r/a.bin'), 'NEW');
  const bin = binned(remote);
  assert.strictEqual(bin.length, 1, `expected one recycled file, got ${bin}`);
  assert.match(bin[0], /^\/r\/\.bin\/a-\d{8}-\d{6}\.bin$/);
  assert.strictEqual(remote.text(bin[0]), 'OLD', 'the original must survive intact');
});

test('the resume rename-over recycles the target instead of deleting it', async () => {
  // The SECOND recycle site, SftpFileSystem.cpp:4939-4958: a resumable upload
  // writes a .filepart and has to clear the real name before renaming onto it.
  // With the setting on, that clearing is a move into the bin, not a delete.
  const { engine, local, remote } = recycleEngine();
  local.put('/l/a.bin', 'ABCDEFGH');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'on' }), COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(remote.text('/r/a.bin'), 'ABCDEFGH');
  assert.strictEqual(remote.has('/r/a.bin.filepart'), false);
  assert.deepStrictEqual(remote.calls.remove, [], 'the old file must not be removed');
  const bin = binned(remote);
  assert.strictEqual(bin.length, 1, `expected one recycled file, got ${bin}`);
  assert.strictEqual(remote.text(bin[0]), 'OLD');
});

test('a symbolic link target is overwritten but never recycled', async () => {
  // SftpFileSystem.cpp:5251-5255. source() only ever looked at isSymlink to
  // switch resume off; the bin needs it for its own reason, which is that
  // moving the link preserves the pointer and abandons the file.
  const { engine, local, remote } = recycleEngine();
  local.put('/l/a.bin', 'NEW');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD', 0, { isSymlink: true });

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(remote.text('/r/a.bin'), 'NEW', 'the transfer still happens');
  assert.deepStrictEqual(binned(remote), []);
});

test('the recycle bin is SFTP only on the upload path too', async () => {
  // SiteAdvanced.cpp:1038. Not caps.recycleBin — no remote adapter in this port
  // advertises that, so gating on it would build a feature that never fires.
  const { engine, local, remote } = makeEngine({
    remote: new MemoryAdapter({ name: 'FTP' }),
    data: { overwrittenToRecycleBin: true, recycleBinPath: '/r/.bin' },
  });
  local.put('/l/a.bin', 'NEW');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(remote.text('/r/a.bin'), 'NEW');
  assert.deepStrictEqual(binned(remote), []);
});

test('a bin that cannot be written to costs the user nothing but the bin', async () => {
  // `// Allow normal overwrite` — SftpFileSystem.cpp:5259-5262.
  const { engine, local, remote } = recycleEngine();
  local.put('/l/a.bin', 'NEW');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD');
  const realRename = remote.rename.bind(remote);
  const attempted = [];
  remote.rename = async (from, to) => {
    if (String(to).startsWith('/r/.bin/')) { attempted.push(to); throw new Error('Permission denied'); }
    return realRename(from, to);
  };

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), COPY_FLAGS.noConfirmation, null);

  assert.strictEqual(attempted.length, 1, 'the recycle must have been attempted');
  assert.strictEqual(remote.text('/r/a.bin'), 'NEW', 'and the upload must still land');
});

test('an append is not an overwrite, so nothing is recycled', async () => {
  // WinSCP gates on `OverwriteMode == omOverwrite` (SftpFileSystem.cpp:5133,
  // 5226): an append extends the file that is already there.
  const { engine, local, remote } = recycleEngine({ rest: { answers: [ANSWERS.retry] } });
  local.put('/l/a.bin', 'TAIL');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'HEAD');

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);

  assert.strictEqual(remote.text('/r/a.bin'), 'HEADTAIL');
  assert.deepStrictEqual(binned(remote), []);
});

test('the recycled file lends its permissions to the replacement', async () => {
  // PreserveExistingRights — SftpFileSystem.cpp:4804 and 4818-4827.
  const { engine, local, remote } = recycleEngine();
  local.put('/l/a.bin', 'NEW');
  remote.putDir('/r').putDir('/r/.bin').put('/r/a.bin', 'OLD', 0, { rights: 'rw-------' });

  await engine.copyToRemote(['/l/a.bin'], '/r/',
    cp({ preserveTime: false, preserveRights: false, resumeSupport: 'off' }),
    COPY_FLAGS.noConfirmation, null);

  assert.deepStrictEqual(remote.calls.setRights, [['/r/a.bin', 'rw-------']]);
});

test('a move deletes the source only after the bytes have landed', async () => {
  const { engine, local, remote } = makeEngine();
  local.put('/l/a.txt', 'A');
  remote.putDir('/r');
  await engine.copyToRemote(['/l/a.txt'], '/r/', cp({ preserveTime: false }), COPY_FLAGS.delete, null);
  assert.strictEqual(remote.text('/r/a.txt'), 'A');
  assert.strictEqual(local.has('/l/a.txt'), false);
});

test('an include mask filters the tree, and the excluded files are never opened', async () => {
  const { engine, local, remote, moved } = makeEngine();
  local.put('/l/d/keep.txt', 'K');
  local.put('/l/d/drop.bin', 'D');
  remote.putDir('/r');
  await engine.copyToRemote(['/l/d'], '/r/',
    cp({ preserveTime: false, includeFileMask: '*.txt' }), 0, null);
  assert.strictEqual(remote.text('/r/d/keep.txt'), 'K');
  assert.strictEqual(remote.has('/r/d/drop.bin'), false);
  assert.deepStrictEqual(moved.map((m) => m.sourcePath), ['/l/d/keep.txt']);
});

test('CopyToLocal downloads a tree and preserves the modification time', async () => {
  const { engine, local, remote } = makeEngine();
  remote.put('/r/d/a.txt', 'AAA', 555000);
  remote.put('/r/d/sub/b.txt', 'BBB', 666000);
  local.putDir('/l');

  const ok = await engine.copyToLocal(['/r/d'], '/l', cp({ preserveTime: true }), 0, null);
  assert.strictEqual(ok, true);
  assert.strictEqual(local.text('/l/d/a.txt'), 'AAA');
  assert.strictEqual(local.text('/l/d/sub/b.txt'), 'BBB');
  assert.deepStrictEqual(local.calls.setTimes.map((c) => c[1]).sort(), [555000, 666000]);
});

test('a download refuses to write a file over a directory, or recurse into a file', async () => {
  {
    const { engine, local, remote } = makeEngine();
    remote.put('/r/a.txt', 'A');
    local.putDir('/l/a.txt');            // a DIRECTORY where the file should go
    await engine.copyToLocal(['/r/a.txt'], '/l', cp({ preserveTime: false }), 0, null);
    assert.strictEqual(local.text('/l/a.txt'), null, 'the directory survives');
  }
  {
    const { engine, local, remote } = makeEngine();
    remote.put('/r/d/x.txt', 'X');
    local.put('/l/d', 'a plain file');    // a FILE where the directory should go
    await engine.copyToLocal(['/r/d'], '/l', cp({ preserveTime: false }), 0, null);
    assert.strictEqual(local.text('/l/d'), 'a plain file');
  }
});

test('a downloaded directory is stamped with the remote directory\'s time, after its contents', async () => {
  // TSFTPFileSystem::DirectorySunk. It runs AFTER the children, because writing
  // a file into a directory updates that directory's own modification time.
  const { engine, local, remote } = makeEngine();
  remote.putDir('/r/d', 777000);
  remote.put('/r/d/a.txt', 'A', 555000);
  local.putDir('/l');

  await engine.copyToLocal(['/r/d'], '/l',
    cp({ preserveTime: true, preserveTimeDirs: true }), 0, null);

  const stamps = local.calls.setTimes.map(([p, t]) => `${p}=${t}`);
  assert.deepStrictEqual(stamps, ['/l/d/a.txt=555000', '/l/d=777000'],
    'the file first, then the directory that now contains it');

  // Without preserveTimeDirs the directory is left alone.
  const second = makeEngine();
  second.remote.putDir('/r/d', 777000);
  second.remote.put('/r/d/a.txt', 'A', 555000);
  second.local.putDir('/l');
  await second.engine.copyToLocal(['/r/d'], '/l',
    cp({ preserveTime: true, preserveTimeDirs: false }), 0, null);
  assert.deepStrictEqual(second.local.calls.setTimes.map(([p]) => p), ['/l/d/a.txt']);
});

test('a downloaded read-only file is marked read-only locally, and only then', async () => {
  {
    const { engine, local, remote } = makeEngine();
    remote.put('/r/a.txt', 'A', 0, { rights: 'r--r--r--' });
    local.putDir('/l');
    await engine.copyToLocal(['/r/a.txt'], '/l', cp({ preserveTime: false, preserveReadOnly: true }), 0, null);
    assert.deepStrictEqual(local.calls.setRights, [['/l/a.txt', 'r--r--r--']]);
  }
  {
    const { engine, local, remote } = makeEngine();
    remote.put('/r/a.txt', 'A', 0, { rights: 'rw-r--r--' });
    local.putDir('/l');
    await engine.copyToLocal(['/r/a.txt'], '/l', cp({ preserveTime: false, preserveReadOnly: true }), 0, null);
    assert.deepStrictEqual(local.calls.setRights, [], 'a writable file is not made read-only');
  }
});

test('UpdateTargetTime says so rather than failing when the timestamp is unknown', async () => {
  const { engine, local, session } = makeEngine();
  local.put('/l/a.txt', 'A');
  await engine.updateTargetTime('/l/a.txt', 0, MODIFICATION_FMT.NONE);
  assert.deepStrictEqual(local.calls.setTimes, []);
  assert.ok(session.lines.some((l) => /Timestamp not known/.test(l)));

  // A failure to preserve a timestamp is logged and ignored: it must never
  // fail a transfer that moved every byte.
  local.failNext = { op: 'setTimes', error: new Error('nope'), times: 1 };
  await engine.updateTargetTime('/l/a.txt', 5000, MODIFICATION_FMT.FULL);
  assert.ok(session.lines.some((l) => /Preserving timestamp failed, ignoring/.test(l)));
});

test('CreateTargetDirectory reports whether it really created anything', async () => {
  const { engine, remote } = makeEngine();
  remote.putDir('/r');
  assert.strictEqual(await engine.createTargetDirectory('/r/new', true, cp()), true);
  assert.strictEqual(await engine.createTargetDirectory('/r/new', true, cp()), false,
    'an existing directory is not created twice');
  // With preserveRights the directory gets the execute bit added.
  const withRights = await engine.createTargetDirectory('/r/perm', true,
    cp({ preserveRights: true, rights: 'rw-r--r--' }));
  assert.strictEqual(withRights, true);
  assert.ok(remote.calls.setRights.some(([p, r]) => p === '/r/perm' && r === 'rwxr-xr-x'));
});

// ===========================================================================
// SourceRobust / SinkRobust
// ===========================================================================

test('a dropped connection retries the FILE, not the whole operation', async () => {
  const { engine, local, remote, session, answers } = makeEngine({ answers: [ANSWERS.retry] });
  local.put('/l/d/1.txt', 'ONE');
  local.put('/l/d/2.txt', 'TWO');
  remote.putDir('/r');

  // The second file's write fails with a lost connection, once.
  let seen = 0;
  const original = remote.createWriteStream.bind(remote);
  remote.createWriteStream = async (p, opts) => {
    if (p.includes('2.txt') && seen === 0) {
      seen = 1;
      remote.connected = false;
      const e = new Error('Connection lost'); e.code = 'ECONNRESET';
      throw e;
    }
    return original(p, opts);
  };

  await engine.copyToRemote(['/l/d'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);

  assert.strictEqual(session.reconnects, 1, 'exactly one reconnect');
  assert.strictEqual(answers.length, 0, 'the reconnect question was asked and answered');
  assert.strictEqual(remote.text('/r/d/1.txt'), 'ONE');
  assert.strictEqual(remote.text('/r/d/2.txt'), 'TWO');
  // The file that already succeeded was NOT sent again.
  assert.strictEqual(local.calls.reads.filter((r) => r.path === '/l/d/1.txt').length, 1);
});

test('a retry after a reconnect suppresses the confirmations the user already gave', async () => {
  // The overwrite question is answered once. If SourceRobust did not set
  // cpNoConfirmation on the retry, the same question would be asked again for
  // the same file — and running out of scripted answers would fail the test.
  const { engine, local, remote, session } = makeEngine({
    answers: [ANSWERS.yes, ANSWERS.retry],
  });
  local.put('/l/a.txt', 'NEW');
  remote.put('/r/a.txt', 'OLD');

  let failed = false;
  const original = remote.createWriteStream.bind(remote);
  remote.createWriteStream = async (p, opts) => {
    if (!failed) {
      failed = true;
      remote.connected = false;
      const e = new Error('Connection lost'); e.code = 'ECONNRESET';
      throw e;
    }
    return original(p, opts);
  };

  await engine.copyToRemote(['/l/a.txt'], '/r/',
    cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
  assert.strictEqual(session.reconnects, 1);
  assert.strictEqual(remote.text('/r/a.txt'), 'NEW');
});

test('a failure that did NOT kill the session is never retried', async () => {
  // This is the rule that stops an infinite loop: "permission denied" would
  // fail identically on every attempt, so the robust loop refuses it.
  const { engine, local, remote, session, terminal } = makeEngine({
    answers: [ANSWERS.abort],
  });
  local.put('/l/a.txt', 'A');
  remote.putDir('/r');
  remote.createWriteStream = async () => {
    const e = new Error('Permission denied'); e.code = 'EACCES';
    throw e;
  };

  await engine.copyToRemote(['/l/a.txt'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
  assert.strictEqual(session.reconnects, 0, 'no reconnect for a per-file error');
  assert.ok(session.lines.some((l) => /Session is open, will not retry transfer/.test(l)));
  assert.strictEqual(terminal.active, true, 'and the session is still usable');
});

test('SinkRobust does not download again when only the source delete failed', async () => {
  // A move whose delete dies with the connection must NOT re-download: the
  // remote file may already be gone, and the retry would overwrite the only
  // remaining copy with nothing.
  const { engine, local, remote, session } = makeEngine({ answers: [ANSWERS.retry] });
  remote.put('/r/a.txt', 'PAYLOAD');
  local.putDir('/l');

  let deletes = 0;
  const originalRemove = remote.remove.bind(remote);
  remote.remove = async (p, opts) => {
    deletes += 1;
    if (deletes === 1) {
      remote.connected = false;
      const e = new Error('Connection lost'); e.code = 'ECONNRESET';
      throw e;
    }
    return originalRemove(p, opts);
  };

  await engine.copyToLocal(['/r/a.txt'], '/l', cp({ preserveTime: false, resumeSupport: 'off' }),
    COPY_FLAGS.delete, null);

  assert.strictEqual(session.reconnects, 1);
  assert.strictEqual(local.text('/l/a.txt'), 'PAYLOAD');
  assert.strictEqual(remote.calls.reads.filter((r) => r.path === '/r/a.txt').length, 1,
    'the file was downloaded exactly once');
  assert.strictEqual(remote.has('/r/a.txt'), false, 'and the delete was retried and succeeded');
});

// ===========================================================================
// CheckParallelFileTransfer
// ===========================================================================

test('splitting one file is refused for everything it would get wrong', async () => {
  const big = 20 * 1024 * 1024;
  const mk = (files) => {
    const list = new CollectedFileList();
    for (const f of files) list.add(f.name, f.object, !!f.dir);
    return [{ rootPath: '/r', files: list }];
  };

  // Below the threshold.
  {
    const { engine } = makeEngine();
    const out = await engine.checkParallelFileTransfer('/l',
      mk([{ name: '/r/a.bin', object: { size: 1024 } }]), cp(), 0, progressFor(SIDES.remote));
    assert.strictEqual(out.size, -1);
  }
  // A symlink — WinSCP says "not tested with symlinks" and declines.
  {
    const { engine } = makeEngine();
    const out = await engine.checkParallelFileTransfer('/l',
      mk([{ name: '/r/a.bin', object: { size: big, isSymlink: true } }]), cp(), 0, progressFor(SIDES.remote));
    assert.strictEqual(out.size, -1);
  }
  // Text mode — the byte offsets on the two sides stop corresponding.
  {
    const { engine } = makeEngine();
    const out = await engine.checkParallelFileTransfer('/l',
      mk([{ name: '/r/a.txt', object: { size: big } }]),
      cp({ transferMode: 'text' }), 0, progressFor(SIDES.remote));
    assert.strictEqual(out.size, -1);
  }
  // More than one file.
  {
    const { engine } = makeEngine();
    const out = await engine.checkParallelFileTransfer('/l',
      mk([{ name: '/r/a.bin', object: { size: big } }, { name: '/r/b.bin', object: { size: big } }]),
      cp(), 0, progressFor(SIDES.remote));
    assert.strictEqual(out.size, -1);
  }
  // A big binary file on its own IS eligible.
  {
    const { engine } = makeEngine();
    const out = await engine.checkParallelFileTransfer('/l',
      mk([{ name: '/r/a.bin', object: { size: big } }]), cp(), 0, progressFor(SIDES.remote));
    assert.strictEqual(out.size, big);
  }
});

test('the one overwrite question for a split file is asked once, before the parts start', async () => {
  const big = 20 * 1024 * 1024;
  const list = new CollectedFileList();
  list.add('/r/a.bin', { size: big, mtime: 5000 }, false);
  const fileLists = [{ rootPath: '/r', files: list }];

  // Declining cancels the WHOLE operation: the parts cannot each ask.
  {
    const { engine, local, queries } = makeEngine({ answers: [ANSWERS.no] });
    local.put('/l/a.bin', 'existing', 9000);
    const p = progressFor(SIDES.remote);
    await engine.checkParallelFileTransfer('/l', fileLists, cp(), 0, p);
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(p.cancel, CANCEL.cancel);
  }
  // Accepting leaves the operation running.
  {
    const { engine, local } = makeEngine({ answers: [ANSWERS.yes] });
    local.put('/l/a.bin', 'existing', 9000);
    const p = progressFor(SIDES.remote);
    const out = await engine.checkParallelFileTransfer('/l', fileLists, cp(), 0, p);
    assert.strictEqual(out.size, big);
    assert.strictEqual(p.cancel, CANCEL.continue);
  }
});

// ===========================================================================
// CanParallel
// ===========================================================================

test('CanParallel refuses the two orderings a parallel transfer would break', () => {
  const { engine } = makeEngine();
  const op = new ParallelOperation(SIDES.local);
  assert.strictEqual(engine.canParallel(cp(), 0, op), true);
  assert.strictEqual(engine.canParallel(cp(), 0, null), false, 'no cursor, no parallelism');
  assert.strictEqual(engine.canParallel(cp(), COPY_FLAGS.delete, op), false,
    'a move has to delete a directory after its contents');
  assert.strictEqual(engine.canParallel(cp({ preserveTime: true, preserveTimeDirs: true }), 0, op), false,
    'a directory timestamp has to be stamped after its contents');
  assert.strictEqual(engine.canParallel(cp({ preserveTime: false, preserveTimeDirs: true }), 0, op), true);

  // SCP's recursion is driven by the server, so it cannot be fed one entry at
  // a time — WinSCP answers fcParallelTransfers false for it.
  const scp = makeEngine({ remote: new MemoryAdapter({ name: 'SCP' }) });
  assert.strictEqual(scp.engine.canParallel(cp(), 0, op), false);
});

test('parallelAllowed answers the same refusals without a cursor to hand it', () => {
  // The cursor guard is the one term a pre-flight query cannot supply, and
  // forwarding NULL for it makes the whole predicate a constant false. This is
  // CanParallel minus that term, and nothing else: the ipc.js
  // `transfer:canParallel` channel answers from here so it reports a decision
  // about the session rather than a value it was always going to return.
  const { engine } = makeEngine();
  assert.strictEqual(engine.parallelAllowed(cp(), 0), true,
    'a capable protocol with no refusal must not answer false');
  assert.strictEqual(engine.parallelAllowed(cp(), COPY_FLAGS.delete), false);
  assert.strictEqual(engine.parallelAllowed(cp({ preserveTime: true, preserveTimeDirs: true }), 0), false);
  assert.strictEqual(engine.parallelAllowed(cp({ preserveTime: false, preserveTimeDirs: true }), 0), true);

  const scp = makeEngine({ remote: new MemoryAdapter({ name: 'SCP' }) });
  assert.strictEqual(scp.engine.parallelAllowed(cp(), 0), false);

  // And CanParallel still refuses without one, so the port stays faithful to
  // Terminal.cpp:7505 where WinSCP actually asks it.
  assert.strictEqual(engine.canParallel(cp(), 0, null), false);
});

// ===========================================================================
// The queue's own path through the same decision
// ===========================================================================

test('StandaloneHost lets a caller with no Terminal reach the same ladder', async () => {
  const prefs = { confirmOverwriting: true, confirmResume: true };
  const asked = [];
  const host = new StandaloneHost({
    adapter: new MemoryAdapter({ name: 'Memory' }),
    prefs,
    queryUser: async (q) => { asked.push(q); return ANSWERS.yesToAll; },
    promptName: async () => 'renamed.txt',
  });
  const engine = new TransferEngine(host, { copyBytes: async () => 0 });
  const p = new SimpleProgress(SIDES.local);

  const r = await engine.confirmOverwrite('/l/a.txt', 'a.txt', cp(), 0, p, fileParams());
  assert.strictEqual(r.mode, OVERWRITE_MODE.overwrite);
  assert.strictEqual(p.batchOverwrite, BATCH_OVERWRITE.all);
  assert.strictEqual(asked.length, 1);

  // And the next file is answered from the batch mode, with no question.
  const r2 = await engine.confirmOverwrite('/l/b.txt', 'b.txt', cp(), 0, p, fileParams());
  assert.strictEqual(r2.mode, OVERWRITE_MODE.overwrite);
  assert.strictEqual(asked.length, 1);

  // "Never ask again" reaches the caller's own preference object.
  const host2 = new StandaloneHost({
    adapter: new MemoryAdapter(),
    prefs,
    queryUser: async () => ANSWERS.neverAskAgain,
  });
  const engine2 = new TransferEngine(host2, { copyBytes: async () => 0 });
  await engine2.confirmOverwrite('/l/c.txt', 'c.txt', cp(), 0, new SimpleProgress(SIDES.local), fileParams());
  assert.strictEqual(prefs.confirmOverwriting, false);
});

test('the byte mover is required, and its absence is said plainly', async () => {
  const { terminal } = makeTerminal();
  const engine = new TransferEngine(terminal, { localAdapter: new MemoryAdapter() });
  await assert.rejects(
    () => engine.fileSystem.source({
      engine,
      handle: { fileName: '/l/a', size: 1, modification: 0, directory: false },
      targetDir: '/r/', destFileName: 'a', copyParam: cp({ resumeSupport: 'off' }),
      params: COPY_FLAGS.noConfirmation, progress: progressFor(SIDES.local), flags: 0,
      action: null, state: {},
    }),
    /has no byte mover/);
});

// ===========================================================================
// CopyParallel end to end
// ===========================================================================

test('CopyParallel walks a whole tree through the shared cursor', async () => {
  const { engine, local, remote } = makeEngine();
  local.put('/l/d/a.txt', 'AAA');
  local.put('/l/d/sub/b.txt', 'BBB');
  local.put('/l/d/sub/c.txt', 'CCC');
  remote.putDir('/r');

  const files = new CollectedFileList();
  files.add('/l/d', null, true);
  files.add('/l/d/a.txt', null, false);
  files.add('/l/d/sub', null, true);
  files.add('/l/d/sub/b.txt', null, false);
  files.add('/l/d/sub/c.txt', null, false);

  const op = new ParallelOperation(SIDES.local);
  const progress = engine.terminal._newProgress();
  progress.start('copy', SIDES.local, 5, {});
  op.init([{ rootPath: '/l', files }], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }),
    0, progress, 'main', -1, 2);

  // Two "connections" sharing one cursor, exactly as the queue would run them.
  await Promise.all([
    engine.copyParallel(op, progress),
    engine.copyParallel(op, progress),
  ]);

  assert.strictEqual(remote.text('/r/d/a.txt'), 'AAA');
  assert.strictEqual(remote.text('/r/d/sub/b.txt'), 'BBB');
  assert.strictEqual(remote.text('/r/d/sub/c.txt'), 'CCC');
  assert.strictEqual(op.clients, 0);
  // Each directory was created exactly once, however many connections ran.
  assert.deepStrictEqual(remote.calls.mkdir.slice().sort(), ['/r/d', '/r/d/sub']);
});

test('a move of a directory removes it once its contents are gone', async () => {
  const { engine, local, remote } = makeEngine();
  local.put('/l/d/a.txt', 'A');
  local.put('/l/d/b.txt', 'B');
  remote.putDir('/r');

  await engine.copyToRemote(['/l/d'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }),
    COPY_FLAGS.delete, null);

  assert.strictEqual(remote.text('/r/d/a.txt'), 'A');
  assert.strictEqual(remote.text('/r/d/b.txt'), 'B');
  assert.strictEqual(local.has('/l/d/a.txt'), false);
  assert.strictEqual(local.has('/l/d'), false, 'the emptied directory goes too');
});

// ===========================================================================
// The action record
// ===========================================================================

test('a transfer records one action, and a rollback records the failure instead', async () => {
  const records = [];
  const actionsLog = {
    transfer: (direction, source, destination, size, result) =>
      records.push({ direction, source, destination, size, ok: result.ok }),
  };

  {
    const { terminal, remote } = makeTerminal();
    const local = new MemoryAdapter({ name: 'Local' });
    local.put('/l/a.txt', 'A');
    remote.putDir('/r');
    const engine = new TransferEngine(terminal, {
      localAdapter: local, actionsLog,
      copyBytes: async (plan) => {
        const ws = await plan.targetAdapter.createWriteStream(plan.targetPath, { size: plan.size });
        await new Promise((res) => ws.end(Buffer.from('A'), res));
        return 1;
      },
    });
    await engine.copyToRemote(['/l/a.txt'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
    assert.deepStrictEqual(records, [{
      direction: 'upload', source: '/l/a.txt', destination: '/r/a.txt', size: 1, ok: true,
    }]);
  }

  // A per-file failure the robust loop refuses to retry is recorded as one
  // failed action, not as a success and not as several attempts.
  records.length = 0;
  {
    const { terminal, remote } = makeTerminal({ answers: [ANSWERS.abort] });
    const local = new MemoryAdapter({ name: 'Local' });
    local.put('/l/a.txt', 'A');
    remote.putDir('/r');
    const engine = new TransferEngine(terminal, {
      localAdapter: local, actionsLog,
      copyBytes: async () => { const e = new Error('Permission denied'); e.code = 'EACCES'; throw e; },
    });
    await engine.copyToRemote(['/l/a.txt'], '/r/', cp({ preserveTime: false, resumeSupport: 'off' }), 0, null);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].ok, false);
  }

  // A directory is not an upload: its action is cancelled, not recorded.
  records.length = 0;
  {
    const { terminal, remote } = makeTerminal();
    const local = new MemoryAdapter({ name: 'Local' });
    local.putDir('/l/empty');
    remote.putDir('/r');
    const engine = new TransferEngine(terminal, {
      localAdapter: local, actionsLog, copyBytes: async () => 0,
    });
    await engine.copyToRemote(['/l/empty'], '/r/', cp({ preserveTime: false }), 0, null);
    assert.deepStrictEqual(records, []);
    assert.strictEqual(remote.has('/r/empty'), true);
  }
});

test('transferEngineFor keeps one engine per terminal and accepts late dependencies', () => {
  const { terminal } = makeTerminal();
  const first = terminal.transferEngine({ localAdapter: new MemoryAdapter() });
  const second = terminal.transferEngine();
  assert.strictEqual(first, second, '"yes to all" must not be split across two engines');
  const mover = async () => 0;
  const third = terminal.transferEngine({ copyBytes: mover });
  assert.strictEqual(third, first);
  assert.strictEqual(first.copyBytes, mover, 'a later dependency updates the engine in place');
});
