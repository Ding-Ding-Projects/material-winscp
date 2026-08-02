// e2e-webdav.test.js — the WebDAV adapter driven against a REAL WebDAV server.
//
// `protocols-webdav-parse.test.js` feeds captured XML to the multistatus parser.
// That proves the parser. It does not prove the protocol: it cannot tell you
// that the Depth header we send is one the server accepts, that our
// percent-encoding survives the round trip through the server's *different*
// encoding, that our Digest response hashes the same string the server hashed,
// or that a Range request really produces a 206 with the right bytes.
//
// So this file starts a real `node:http` WebDAV server on an ephemeral port,
// backed by a real temporary directory, and drives the real adapter — and then
// the real transfer queue and the real synchronizer — against it over real
// HTTP. Every assertion compares bytes that actually landed on disk.
//
// The namespace pair matters most. The same tree is served twice, once the way
// Apache mod_dav answers (`D:multistatus`, live properties under a second
// `lp1:` prefix bound to the same URI) and once the way sabre/dav and IIS
// answer (`xmlns="DAV:"`, no prefix at all). The adapter claims to resolve
// prefixes to namespace URIs rather than string-matching; these two tests are
// what make that claim checkable.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { WebDavAdapter } = require('../design/main/protocols/webdav');
const { LocalAdapter } = require('../design/main/protocols/local');
const { TransferQueue } = require('../design/main/queue');
const sync = require('../design/main/sync');
const { SESSION_DEFAULTS, PREF_DEFAULTS } = require('../design/main/defaults');
const { startWebDavServer } = require('./helpers/webdav-server');

// A fixture password. It is only ever handed to the adapter and to the server's
// own verifier; nothing in this file prints it, and neither does the adapter.
const USER = 'dav-user';
const SECRET = 'correct horse battery staple';

let tmpRoot;
const servers = [];

/** Start a server plus a connected adapter pointed at it. */
async function stand(options = {}) {
  const root = await fsp.mkdtemp(path.join(tmpRoot, 'dav-'));
  const server = await startWebDavServer({
    root, user: USER, password: SECRET, ...options,
  });
  servers.push(server);
  const adapter = makeAdapter(server, options);
  await adapter.connect();
  return { server, adapter, root };
}

function makeAdapter(server, options = {}, overrides = {}) {
  const session = {
    ...SESSION_DEFAULTS,
    protocol: 'webdav',
    hostName: '127.0.0.1',
    portNumber: server.port,
    userName: options.auth && options.auth !== 'none' ? (options.user || USER) : '',
    ftps: 'none',
    timeout: 20,
    ...overrides,
  };
  return new WebDavAdapter(session, {
    password: options.auth && options.auth !== 'none' ? (options.password || SECRET) : '',
    log: () => {},
  });
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Run the queue to completion, failing loudly on the first item error. */
async function runQueue(queue) {
  const errors = [];
  queue.on('item-error', ({ error }) => errors.push(error));
  queue.on('query', ({ respond }) => respond('overwrite'));
  await queue.idle();
  // `idle()` resolves on the edge; give any trailing state change a tick.
  await sleep(10);
  if (errors.length) throw errors[0];
}

test.before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-e2e-dav-'));
});

test.after(async () => {
  for (const s of servers) await s.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// connect / OPTIONS
// ---------------------------------------------------------------------------

test('connect talks OPTIONS, HEAD and PROPFIND to a real server', async () => {
  const { server, adapter } = await stand({ namespace: 'prefix' });
  assert.equal(adapter.connected, true);
  assert.equal(adapter.protocolName, 'WebDAV');
  assert.deepEqual(adapter.davClasses, ['1', '2', '3']);
  assert.ok(adapter.allowed.includes('PROPFIND'), 'the Allow header was parsed');
  assert.equal(adapter.caps.copyRemote, true, 'COPY is advertised, so caps say so');
  assert.equal(adapter.caps.nativeMove, true);

  const methods = server.requests.map((r) => r.method);
  assert.ok(methods.includes('OPTIONS'), 'OPTIONS really went over the wire');
  assert.ok(methods.includes('HEAD'));
  assert.ok(methods.includes('PROPFIND'));

  const propfind = server.requests.find((r) => r.method === 'PROPFIND');
  assert.equal(propfind.headers.depth, '0', 'the connect probe is Depth 0');
  await adapter.disconnect();
});

test('a server that does not advertise COPY and MOVE has those capabilities withdrawn', async () => {
  // The optimistic default is that a DAV server can COPY and MOVE, and the
  // previous test proves the default survives a server that really can. This
  // is the other half: an endpoint whose Allow header omits them must not be
  // reported as capable, or the UI offers a server-side rename that 405s.
  const { adapter } = await stand({
    namespace: 'prefix',
    allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL',
  });
  assert.equal(adapter.caps.copyRemote, false, 'COPY is not advertised, so caps must not claim it');
  assert.equal(adapter.caps.nativeMove, false);
  assert.equal(adapter.caps.rename, false);
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// the namespace pair
// ---------------------------------------------------------------------------

async function seedTree(root) {
  await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(root, 'docs', 'readme.bin'), Buffer.from('a readme'));
  await fsp.writeFile(path.join(root, 'top.bin'), Buffer.alloc(1234, 7));
  await fsp.mkdir(path.join(root, 'empty'));
}

for (const namespace of ['prefix', 'default']) {
  test(`PROPFIND Depth 1 is parsed with the DAV namespace ${namespace === 'prefix' ? 'carried on a prefix (mod_dav style)' : 'defaulted via xmlns="DAV:" (sabre/IIS style)'}`, async () => {
    const { adapter, root } = await stand({ namespace });
    await seedTree(root);

    const rows = await adapter.list('/');
    const byName = new Map(rows.map((r) => [r.name, r]));
    assert.deepEqual([...byName.keys()].sort(), ['docs', 'empty', 'top.bin']);
    assert.equal(byName.get('docs').type, 'dir');
    assert.equal(byName.get('empty').type, 'dir');
    assert.equal(byName.get('top.bin').type, 'file');
    assert.equal(byName.get('top.bin').size, 1234);
    assert.ok(byName.get('top.bin').mtime > 0, 'getlastmodified survived the parse');

    // The collection itself comes back in a Depth 1 answer and must not be
    // listed as one of its own children.
    assert.equal(rows.filter((r) => r.name === '/').length, 0);

    const st = await adapter.stat('/docs/readme.bin');
    assert.equal(st.type, 'file');
    assert.equal(st.size, 8);
    await adapter.disconnect();
  });
}

test('a foreign-namespace property is not mistaken for a DAV one', async () => {
  // The server emits <X:executable xmlns="http://apache.org/dav/props/">, which
  // a prefix-blind parser can confuse with a DAV: property of the same name.
  const { adapter, root } = await stand({ namespace: 'prefix' });
  await fsp.writeFile(path.join(root, 'plain.bin'), Buffer.alloc(9));
  const [row] = await adapter.list('/');
  assert.equal(row.name, 'plain.bin');
  assert.equal(row.type, 'file');
  assert.equal(row.size, 9);
  await adapter.disconnect();
});

test('quota properties from a 200 propstat drive spaceInfo, and their 404 twin does not', async () => {
  const { adapter } = await stand({ namespace: 'default', quota: { available: 900, used: 100 } });
  assert.equal(adapter.caps.spaceInfo, true);
  const info = await adapter.spaceInfo('/');
  assert.deepEqual(info, { bytesAvailable: 900, bytesUsed: 100, bytesTotal: 1000 });
  await adapter.disconnect();

  // The same server without quota answers a 404 propstat for those properties;
  // reading values out of it would report a zero-byte volume.
  const plain = await stand({ namespace: 'default' });
  assert.equal(plain.adapter.caps.spaceInfo, false);
  assert.equal(await plain.adapter.spaceInfo('/'), null);
  await plain.adapter.disconnect();
});

// ---------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------

test('names needing escaping survive the round trip through a different escaping', async () => {
  const { adapter, root } = await stand({ namespace: 'prefix' });
  // The server encodes hrefs with encodeURIComponent; the adapter encodes
  // request paths with its own RFC 3986 rules. If either side string-matched
  // instead of decoding, these names would not line up.
  const names = ['a space.bin', 'plus+sign.bin', 'brack[et].bin', '中文檔案.bin', "quote'.bin"];
  for (const n of names) await fsp.writeFile(path.join(root, n), Buffer.from(n, 'utf8'));

  const rows = await adapter.list('/');
  assert.deepEqual(rows.map((r) => r.name).sort(), [...names].sort());

  for (const n of names) {
    const got = await drain(await adapter.createReadStream(`/${n}`));
    assert.equal(got.toString('utf8'), n, `${n} round-tripped`);
  }
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

test('PUT then GET is byte-identical, and GET honours a byte Range', async () => {
  const { adapter, root } = await stand({ namespace: 'prefix' });
  const payload = crypto.randomBytes(70000);
  await adapter.writeFile('/blob.bin', payload);

  assert.ok(fs.existsSync(path.join(root, 'blob.bin')), 'the PUT reached the disk');
  assert.deepEqual(await fsp.readFile(path.join(root, 'blob.bin')), payload);

  const whole = await drain(await adapter.createReadStream('/blob.bin'));
  assert.deepEqual(whole, payload);

  const tail = await drain(await adapter.createReadStream('/blob.bin', { start: 40000 }));
  assert.deepEqual(tail, payload.subarray(40000));

  const middle = await drain(await adapter.createReadStream('/blob.bin', { start: 10, end: 19 }));
  assert.deepEqual(middle, payload.subarray(10, 20));
  await adapter.disconnect();
});

test('a server that does not advertise byte ranges refuses a ranged read instead of silently restarting', async () => {
  const { adapter, root } = await stand({ namespace: 'prefix', acceptRanges: false });
  await fsp.writeFile(path.join(root, 'noranges.bin'), Buffer.alloc(500, 3));
  await assert.rejects(
    () => adapter.createReadStream('/noranges.bin', { start: 100 }),
    /byte ranges|resume/i);
  const whole = await drain(await adapter.createReadStream('/noranges.bin'));
  assert.equal(whole.length, 500);
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// collections and the write verbs
// ---------------------------------------------------------------------------

test('MKCOL, recursive MKCOL, MOVE, COPY and DELETE all work against the server', async () => {
  const { adapter, root } = await stand({ namespace: 'default' });

  await adapter.mkdir('/one');
  assert.ok((await fsp.stat(path.join(root, 'one'))).isDirectory());

  // A recursive mkdir walks the chain and treats "405 already a collection"
  // as success — the second call must not throw.
  await adapter.mkdir('/one/two/three', { recursive: true });
  await adapter.mkdir('/one/two/three', { recursive: true });
  assert.ok((await fsp.stat(path.join(root, 'one', 'two', 'three'))).isDirectory());

  await adapter.writeFile('/one/two/file.bin', Buffer.from('hello'));
  await adapter.rename('/one/two/file.bin', '/one/two/renamed.bin');
  assert.equal(fs.existsSync(path.join(root, 'one', 'two', 'file.bin')), false);
  assert.equal((await fsp.readFile(path.join(root, 'one', 'two', 'renamed.bin'))).toString(), 'hello');

  await adapter.copy('/one/two/renamed.bin', '/one/copy.bin');
  assert.equal((await fsp.readFile(path.join(root, 'one', 'copy.bin'))).toString(), 'hello');
  assert.ok(fs.existsSync(path.join(root, 'one', 'two', 'renamed.bin')), 'COPY left the source alone');

  // COPY of a whole collection, Depth infinity.
  await adapter.copy('/one', '/clone');
  assert.equal((await fsp.readFile(path.join(root, 'clone', 'two', 'renamed.bin'))).toString(), 'hello');

  await adapter.remove('/clone');
  assert.equal(fs.existsSync(path.join(root, 'clone')), false);

  await assert.rejects(() => adapter.remove('/clone'), /404/);
  await adapter.disconnect();
});

test('calculateSize walks the collection tree over PROPFIND', async () => {
  const { adapter, root } = await stand({ namespace: 'prefix' });
  await fsp.mkdir(path.join(root, 'tree', 'inner'), { recursive: true });
  await fsp.writeFile(path.join(root, 'tree', 'a.bin'), Buffer.alloc(100));
  await fsp.writeFile(path.join(root, 'tree', 'inner', 'b.bin'), Buffer.alloc(250));
  const got = await adapter.calculateSize('/tree');
  assert.deepEqual(got, { bytes: 350, files: 2, dirs: 1 });
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// authentication, for real
// ---------------------------------------------------------------------------

test('Basic authentication is verified by the server, and a wrong password is refused', async () => {
  const { server, adapter, root } = await stand({ auth: 'basic', namespace: 'prefix' });
  await fsp.writeFile(path.join(root, 'secret.bin'), Buffer.from('ok'));
  const rows = await adapter.list('/');
  assert.deepEqual(rows.map((r) => r.name), ['secret.bin']);
  assert.ok(server.state.schemes.has('Basic'), 'the server checked a Basic credential');
  await adapter.disconnect();

  const wrong = makeAdapter(server, { auth: 'basic', password: 'not the password' });
  await assert.rejects(() => wrong.connect(), /401|Authentication/i);
  await wrong.disconnect();
});

test('Digest authentication is answered against a live challenge, not just hashed in isolation', async () => {
  const { server, adapter, root } = await stand({ auth: 'digest', namespace: 'default' });
  await fsp.writeFile(path.join(root, 'private.bin'), Buffer.from('digest ok'));

  // The server recomputed HA1, HA2 and the response itself; reaching this line
  // means the adapter's Digest header verified against a real challenge.
  assert.ok(server.state.schemes.has('Digest'), 'the server accepted a Digest response');
  assert.ok(server.state.challenges >= 1, 'the server really challenged');

  const rows = await adapter.list('/');
  assert.deepEqual(rows.map((r) => r.name), ['private.bin']);
  const body = await drain(await adapter.createReadStream('/private.bin'));
  assert.equal(body.toString(), 'digest ok');

  // Every subsequent request reuses the challenge with an increasing nonce
  // count; the server rejects a repeat, so a static nc would have failed above.
  assert.ok(server.state.lastNc > 1, `nonce count advanced (saw ${server.state.lastNc})`);

  // A PUT is streamed, so it cannot be replayed after a 401 — it has to carry
  // working credentials on the first attempt.
  await adapter.writeFile('/written-under-digest.bin', Buffer.from('streamed'));
  assert.equal((await fsp.readFile(path.join(root, 'written-under-digest.bin'))).toString(), 'streamed');
  await adapter.disconnect();

  const wrong = makeAdapter(server, { auth: 'digest', password: 'wrong secret' });
  await assert.rejects(() => wrong.connect(), /401|Authentication/i);
  await wrong.disconnect();
});

// ---------------------------------------------------------------------------
// the transfer queue, over real HTTP
// ---------------------------------------------------------------------------

test('the transfer queue uploads a tree to WebDAV and downloads it back byte-identically', async () => {
  const { adapter, root } = await stand({ namespace: 'prefix' });
  const local = new LocalAdapter({});
  await local.connect();

  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'stage-'));
  const src = path.join(stage, 'payload');
  await fsp.mkdir(path.join(src, 'nested'), { recursive: true });
  const files = {
    'big.bin': crypto.randomBytes(300000),
    'small.bin': Buffer.from('tiny'),
    'nested/deep.bin': crypto.randomBytes(65536),
  };
  for (const [name, buf] of Object.entries(files)) {
    await fsp.writeFile(path.join(src, ...name.split('/')), buf);
  }

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: src,
    target: '/payload',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: { transferMode: 'binary' },
  });
  await runQueue(queue);

  for (const [name, buf] of Object.entries(files)) {
    const landed = await fsp.readFile(path.join(root, 'payload', ...name.split('/')));
    assert.deepEqual(landed, buf, `${name} uploaded byte-identically`);
  }

  const back = path.join(stage, 'back');
  await fsp.mkdir(back, { recursive: true });
  const down = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  down.add({
    side: 'download',
    source: '/payload',
    target: path.join(back, 'payload'),
    sourceAdapter: adapter,
    targetAdapter: local,
    copyParam: { transferMode: 'binary' },
  });
  await runQueue(down);

  for (const [name, buf] of Object.entries(files)) {
    const landed = await fsp.readFile(path.join(back, 'payload', ...name.split('/')));
    assert.deepEqual(landed, buf, `${name} came back byte-identically`);
  }
  await local.disconnect();
  await adapter.disconnect();
});

test('a transfer split across parallel connections still produces the exact file', async () => {
  // WebDAV has no positioned write: a PUT replaces the whole resource. If the
  // adapter claims resume support, the queue splits a large file into ranged
  // chunks and issues one PUT per chunk to the same URL — every one of which
  // overwrites the last, leaving a file that is one chunk long. The result must
  // be the same bytes however the queue chose to move them.
  const { adapter, root } = await stand({ namespace: 'prefix' });
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'par-'));
  const payload = crypto.randomBytes(400000);
  await fsp.writeFile(path.join(stage, 'parallel.bin'), payload);

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: path.join(stage, 'parallel.bin'),
    target: '/parallel.bin',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: {
      transferMode: 'binary',
      parallelTransfers: 4,
      parallelTransferThreshold: 64 * 1024,
    },
  });
  await runQueue(queue);

  assert.deepEqual(await fsp.readFile(path.join(root, 'parallel.bin')), payload);
  await local.disconnect();
  await adapter.disconnect();
});

test('an interrupted upload is retried without corrupting the file', async () => {
  // A stalled transfer leaves a partial file behind. WebDAV cannot continue a
  // PUT from an offset, so the retry has to start over; what must never happen
  // is the tail being written on its own and renamed over the target.
  const { adapter, root } = await stand({ namespace: 'prefix' });
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'resume-'));
  const payload = crypto.randomBytes(200000);
  await fsp.writeFile(path.join(stage, 'resumed.bin'), payload);

  // Plant the partial file the way an aborted attempt would have left it.
  await fsp.writeFile(path.join(root, 'resumed.bin.filepart'), payload.subarray(0, 50000));

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: path.join(stage, 'resumed.bin'),
    target: '/resumed.bin',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: { transferMode: 'binary', resumeSupport: 'on' },
  });
  await runQueue(queue);

  assert.deepEqual(await fsp.readFile(path.join(root, 'resumed.bin')), payload);
  await local.disconnect();
  await adapter.disconnect();
});

test('a text-mode upload sends a body the server can actually finish reading', { timeout: 20000 }, async () => {
  // Text mode rewrites line endings, so the byte count the queue announces from
  // the source file is not the byte count that goes on the wire. A Content-Length
  // taken from the source size leaves the server waiting for bytes that never
  // come, and the transfer hangs until the timeout.
  const { adapter, root } = await stand({ namespace: 'prefix' });
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'text-'));
  const crlf = Buffer.from('one\r\ntwo\r\nthree\r\n'.repeat(500), 'utf8');
  await fsp.writeFile(path.join(stage, 'notes.txt'), crlf);

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: path.join(stage, 'notes.txt'),
    target: '/notes.txt',
    sourceAdapter: local,
    targetAdapter: adapter,
    // 'automatic' plus the default ASCII mask is what a user gets out of the
    // box for a .txt file, so this is the ordinary path, not an exotic one.
    copyParam: { transferMode: 'automatic' },
    session: { eolType: 'lf' },
  });
  await runQueue(queue);

  const landed = await fsp.readFile(path.join(root, 'notes.txt'));
  assert.deepEqual(landed, Buffer.from('one\ntwo\nthree\n'.repeat(500), 'utf8'),
    'CRLF was folded to LF and every byte arrived');
  await local.disconnect();
  await adapter.disconnect();
});

test('a server that drops the socket mid-PUT fails the upload without taking the process with it', async () => {
  // The PUT response is what `_final` waits on. When the socket dies part way
  // through the body there is never a response, the stream is destroyed
  // instead, and `_final` is never reached — so the promise that was waiting
  // for that response is rejected with nobody listening. Node treats an
  // unhandled rejection as fatal, which turns "a transfer was interrupted"
  // into "the application exited". The upload must fail; the process must not.
  const { adapter } = await stand({ namespace: 'prefix' });
  adapter.session.timeout = 5;

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    servers[servers.length - 1].faults.killPutAfter = 64 * 1024;

    // Larger than INLINE_PUT_LIMIT so the streaming path is used and the
    // request really is open while the bytes are going out.
    const ws = await adapter.createWriteStream('/dropped.bin', { size: 12 * 1024 * 1024 });
    const chunk = Buffer.alloc(256 * 1024, 9);
    const failed = new Promise((resolve) => { ws.once('error', resolve); });
    await assert.rejects(async () => {
      for (let i = 0; i < 48; i++) {
        if (!ws.write(chunk)) {
          await new Promise((resolve, reject) => {
            ws.once('drain', resolve);
            ws.once('error', reject);
          });
        }
      }
      await new Promise((resolve, reject) => {
        ws.once('error', reject);
        ws.once('finish', resolve);
        ws.end();
      });
    }, /ECONNRESET|socket|aborted|EPIPE|closed/i, 'the upload reports the broken connection');
    await failed;

    // Give any detached promise a turn to be reported before we look.
    await sleep(50);
    assert.deepEqual(unhandled.map((e) => e && e.message), [],
      'no promise was left rejected with nobody waiting on it');

    servers[servers.length - 1].faults.killPutAfter = null;
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// the synchronizer, over real HTTP
// ---------------------------------------------------------------------------

test('the synchronizer converges a local tree onto WebDAV and then back again', async () => {
  const { adapter, root } = await stand({ namespace: 'default' });
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'sync-'));
  await fsp.mkdir(path.join(stage, 'sub'), { recursive: true });
  const contents = {
    'alpha.bin': crypto.randomBytes(4096),
    'sub/beta.bin': crypto.randomBytes(8192),
  };
  for (const [name, buf] of Object.entries(contents)) {
    await fsp.writeFile(path.join(stage, ...name.split('/')), buf);
  }

  const opts = { direction: 'remote', mode: 'synchronize', criteria: 'size', recursive: true };
  const first = await sync.compare(local, stage, adapter, '/', opts);
  assert.ok(first.counts.upload >= 1, 'the comparison saw work to do');

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  const applied = await sync.apply(first, queue);
  assert.equal(applied.errors.length, 0);
  await runQueue(queue);

  for (const [name, buf] of Object.entries(contents)) {
    assert.deepEqual(await fsp.readFile(path.join(root, ...name.split('/'))), buf,
      `${name} landed byte-identically`);
  }

  // Convergence: running the same comparison again must find nothing to do.
  const second = await sync.compare(local, stage, adapter, '/', opts);
  assert.equal(second.counts.upload, 0, 'the second pass has nothing left to upload');
  assert.equal(second.counts.download, 0);

  // And the other direction, onto an empty local tree.
  const mirror = await fsp.mkdtemp(path.join(tmpRoot, 'mirror-'));
  const downOpts = { direction: 'local', mode: 'synchronize', criteria: 'size', recursive: true };
  const third = await sync.compare(local, mirror, adapter, '/', downOpts);
  assert.ok(third.counts.download >= 1);
  const downQueue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  await sync.apply(third, downQueue);
  await runQueue(downQueue);

  for (const [name, buf] of Object.entries(contents)) {
    assert.deepEqual(await fsp.readFile(path.join(mirror, ...name.split('/'))), buf);
  }
  const fourth = await sync.compare(local, mirror, adapter, '/', downOpts);
  assert.equal(fourth.counts.download, 0, 'the download side converged too');

  await local.disconnect();
  await adapter.disconnect();
});
