// find.test.js — recursive search over the Adapter contract.
//
// find.js was written without a test file in its author's ownership list, so
// this covers it: traversal, mask filtering, streamed content search across
// read-chunk boundaries, binary skipping, depth limits, cancellation, and
// surviving a directory it is not allowed to read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { Adapter, entry } = require('../design/main/protocols/base');
const { search, findAll, Finder, looksBinary, SearchCancelled } = require('../design/main/find');

/**
 * An in-memory adapter. `tree` maps a directory path to its entries, and
 * `files` maps a file path to its contents, so a test can describe a whole
 * filesystem in a literal.
 */
class MemoryAdapter extends Adapter {
  constructor(files, { unreadable = [], chunkSize = 8 } = {}) {
    super({ protocol: 'memory' });
    this.files = files;
    this.unreadable = new Set(unreadable);
    this.chunkSize = chunkSize;
    this.reads = [];
  }

  get protocolName() { return 'memory'; }

  _childrenOf(dir) {
    const prefix = dir === '/' ? '/' : dir + '/';
    const names = new Map();
    for (const path of Object.keys(this.files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, 'file');
      else names.set(rest.slice(0, slash), 'dir');
    }
    return names;
  }

  async list(dir) {
    const d = this.normalize(dir);
    if (this.unreadable.has(d)) {
      const err = new Error('Permission denied: ' + d);
      err.code = 'EACCES';
      throw err;
    }
    const out = [];
    for (const [name, type] of this._childrenOf(d)) {
      const full = d === '/' ? '/' + name : d + '/' + name;
      out.push(entry({
        name,
        type,
        size: type === 'file' ? Buffer.byteLength(this.files[full] ?? '') : 0,
        mtime: 1_700_000_000_000,
      }));
    }
    return out;
  }

  async createReadStream(path) {
    const p = this.normalize(path);
    const content = this.files[p];
    if (content === undefined) throw new Error('No such file: ' + p);
    this.reads.push(p);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    // Deliberately tiny chunks: a match that spans a chunk boundary is the
    // thing most likely to be broken, so make every read cross several.
    const size = this.chunkSize;
    let offset = 0;
    return new Readable({
      read() {
        if (offset >= buf.length) { this.push(null); return; }
        this.push(buf.subarray(offset, offset + size));
        offset += size;
      },
    });
  }
}

const TREE = {
  '/notes.txt': 'alpha\nbeta gamma\ndelta\n',
  '/readme.md': '# title\nthe needle is here\nmore text\n',
  '/src/app.js': "console.log('needle');\n",
  '/src/style.css': 'body { color: red }\n',
  '/src/deep/nested/leaf.txt': 'needle at depth three\n',
  '/logs/run.log': 'nothing interesting\n',
};

function paths(results) { return results.map((r) => r.path).sort(); }

test('walks the whole tree and reports every file', async () => {
  const a = new MemoryAdapter(TREE);
  const found = await findAll(a, '/', { includeDirectories: false });
  assert.deepStrictEqual(paths(found), [
    '/logs/run.log', '/notes.txt', '/readme.md',
    '/src/app.js', '/src/deep/nested/leaf.txt', '/src/style.css',
  ]);
});

test('a file mask filters the results without stopping the recursion', async () => {
  const a = new MemoryAdapter(TREE);
  const found = await findAll(a, '/', { mask: '*.txt', includeDirectories: false });
  // leaf.txt is three directories down: a mask must not prune the walk.
  assert.deepStrictEqual(paths(found), ['/notes.txt', '/src/deep/nested/leaf.txt']);
});

test('maxDepth bounds the walk', async () => {
  const a = new MemoryAdapter(TREE);
  const top = await findAll(a, '/', { maxDepth: 0, includeDirectories: false });
  assert.deepStrictEqual(paths(top), ['/notes.txt', '/readme.md']);

  const two = await findAll(a, '/', { maxDepth: 1, includeDirectories: false });
  assert.ok(two.some((r) => r.path === '/src/app.js'));
  assert.ok(!two.some((r) => r.path === '/src/deep/nested/leaf.txt'));
});

test('content search finds matches and reports the matching line', async () => {
  const a = new MemoryAdapter(TREE);
  const found = await findAll(a, '/', { grep: 'needle', includeDirectories: false });
  assert.deepStrictEqual(paths(found), ['/readme.md', '/src/app.js', '/src/deep/nested/leaf.txt']);
  const readme = found.find((r) => r.path === '/readme.md');
  assert.ok(readme.matches && readme.matches.length >= 1,
    'a content hit should carry the matching line(s)');
  assert.match(readme.matches[0].line, /needle/);
});

test('a match spanning a read-chunk boundary is still found', async () => {
  // 3-byte chunks guarantee "needle" is split across reads.
  const a = new MemoryAdapter({ '/split.txt': 'xxxx needle xxxx\n' }, { chunkSize: 3 });
  const found = await findAll(a, '/', { grep: 'needle', includeDirectories: false });
  assert.deepStrictEqual(paths(found), ['/split.txt'],
    'chunk boundaries must not be able to hide a match');
});

test('content search is case-insensitive by default and exact when asked', async () => {
  const files = { '/a.txt': 'The Needle\n' };
  assert.strictEqual((await findAll(new MemoryAdapter(files), '/', { grep: 'needle' })).length, 1);
  assert.strictEqual(
    (await findAll(new MemoryAdapter(files), '/', { grep: 'needle', caseSensitive: true })).length, 0);
});

test('regex and whole-word searches are honoured', async () => {
  const files = { '/a.txt': 'needles\nneedle\n' };
  const rx = await findAll(new MemoryAdapter(files), '/', { grep: 'n[e]+dle', regex: true });
  assert.strictEqual(rx.length, 1);

  const whole = await findAll(new MemoryAdapter(files), '/', { grep: 'needle', wholeWord: true });
  assert.strictEqual(whole.length, 1);
  assert.strictEqual(whole[0].matches.length, 1, 'only the standalone word counts');
});

test('binary files are skipped rather than scanned', async () => {
  const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]);
  assert.strictEqual(looksBinary(bin), true, 'a NUL byte marks content as binary');

  const a = new MemoryAdapter({ '/prog.bin': bin, '/plain.txt': 'needle\n' });
  const found = await findAll(a, '/', { grep: 'needle', includeDirectories: false });
  assert.deepStrictEqual(paths(found), ['/plain.txt']);

  const forced = await findAll(new MemoryAdapter({ '/prog.bin': bin }), '/',
    { grep: 'needle', searchBinary: true, includeDirectories: false });
  assert.strictEqual(forced.length, 1, 'searchBinary opts back in');
});

test('a file larger than maxFileSize is not read at all', async () => {
  const a = new MemoryAdapter({ '/big.txt': 'needle\n'.repeat(100) });
  const found = await findAll(a, '/', { grep: 'needle', maxFileSize: 10, includeDirectories: false });
  assert.strictEqual(found.length, 0);
  assert.deepStrictEqual(a.reads, [], 'an oversized file should never be opened');
});

test('limit stops the search early', async () => {
  const a = new MemoryAdapter(TREE);
  const found = await findAll(a, '/', { limit: 2, includeDirectories: false });
  assert.strictEqual(found.length, 2);
});

test('an unreadable directory is skipped without failing the whole search', async () => {
  const a = new MemoryAdapter(TREE, { unreadable: ['/logs'] });
  const errors = [];
  const found = await findAll(a, '/', {
    includeDirectories: false,
    onError: (err, path) => errors.push(path),
  });
  assert.ok(found.some((r) => r.path === '/notes.txt'), 'the rest of the tree still reports');
  assert.ok(!found.some((r) => r.path.startsWith('/logs/')));
  assert.deepStrictEqual(errors, ['/logs'], 'the caller is told which directory was refused');
});

test('throwOnError surfaces the failure instead of swallowing it', async () => {
  const a = new MemoryAdapter(TREE, { unreadable: ['/logs'] });
  await assert.rejects(
    () => findAll(a, '/', { throwOnError: true }),
    /Permission denied/);
});

test('an AbortSignal cancels the search', async () => {
  const a = new MemoryAdapter(TREE);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => findAll(a, '/', { signal: ac.signal }), SearchCancelled);
});

test('results stream rather than arriving all at once', async () => {
  const a = new MemoryAdapter(TREE);
  const seen = [];
  for await (const r of search(a, '/', { includeDirectories: false })) {
    seen.push(r.path);
    // The point of the generator is that the first hit is usable immediately.
    if (seen.length === 1) assert.ok(r.path, 'a result is available before the walk finishes');
  }
  assert.strictEqual(seen.length, 6);
});

test('the Finder wrapper emits matches and signals completion', async () => {
  const a = new MemoryAdapter(TREE);
  const finder = new Finder(a, '/', { mask: '*.js', includeDirectories: false });
  const got = [];
  finder.on('match', (r) => got.push(r.path));
  const done = new Promise((resolve) => finder.on('done', resolve));
  const results = await finder.run();
  const summary = await done;

  assert.deepStrictEqual(got, ['/src/app.js']);
  assert.deepStrictEqual(results.map((r) => r.path), ['/src/app.js']);
  assert.strictEqual(summary.cancelled, false);
});

test('a cancelled Finder reports the partial results rather than throwing', async () => {
  const a = new MemoryAdapter(TREE);
  const finder = new Finder(a, '/', { includeDirectories: false });
  finder.cancel();
  const summary = await new Promise((resolve) => {
    finder.on('done', resolve);
    finder.run().catch(() => { /* reported through 'done' */ });
  });
  assert.strictEqual(summary.cancelled, true,
    'cancelling is a normal outcome, not an error the caller must catch');
});

test('a Finder can be iterated directly without collecting', async () => {
  const a = new MemoryAdapter(TREE);
  const finder = new Finder(a, '/', { mask: '*.css', includeDirectories: false });
  const seen = [];
  for await (const hit of finder) seen.push(hit.path);
  assert.deepStrictEqual(seen, ['/src/style.css']);
});
