// e2e-s3.test.js — the S3 adapter driven against a REAL S3-compatible server.
//
// `protocols-s3sig.test.js` checks our SigV4 against AWS's published vectors.
// That is worth having, but a vector is a fixed string: it cannot tell you that
// the path we sent is the path we signed, that a query string arrived in the
// order it was signed in, or that a header added after signing quietly
// invalidated the request. The server in `helpers/s3-server.js` recomputes the
// canonical request from the bytes that actually arrive and answers 403
// SignatureDoesNotMatch when it disagrees — so every single request in this
// file is a signature test as well as a behaviour test.
//
// It also enforces the S3 rules that only bite against a server: a non-final
// multipart part below 5 MiB is rejected, DeleteObjects requires Content-MD5,
// and a truncated ListObjectsV2 has to be followed with a continuation token.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { S3Adapter } = require('../design/main/protocols/s3');
const { LocalAdapter } = require('../design/main/protocols/local');
const { TransferQueue } = require('../design/main/queue');
const sync = require('../design/main/sync');
const { SESSION_DEFAULTS, PREF_DEFAULTS } = require('../design/main/defaults');
const { startS3Server, MIN_PART_SIZE } = require('./helpers/s3-server');

const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
// A fixture secret. It is handed to the adapter and to the server's own
// verifier and is never printed by either.
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const REGION = 'us-east-1';

let tmpRoot;
const servers = [];

async function stand(options = {}) {
  const server = await startS3Server({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: REGION,
    buckets: ['bucket-one'],
    ...options,
  });
  servers.push(server);
  const adapter = makeAdapter(server);
  await adapter.connect();
  return { server, adapter };
}

function makeAdapter(server, overrides = {}, secret = SECRET_KEY) {
  const session = {
    ...SESSION_DEFAULTS,
    protocol: 's3',
    hostName: '127.0.0.1',
    portNumber: server.port,
    userName: ACCESS_KEY,
    // The endpoint is plain HTTP on an ephemeral port, which is what every
    // self-hosted S3 server looks like during development. WinSCP models this
    // with the session's Encryption setting, not with the port number.
    ftps: 'none',
    s3UrlStyle: 'path',
    s3DefaultRegion: REGION,
    timeout: 20,
    ...overrides,
  };
  return new S3Adapter(session, { password: secret, log: () => {} });
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function runQueue(queue) {
  const errors = [];
  queue.on('item-error', ({ error }) => errors.push(error));
  queue.on('query', ({ respond }) => respond('overwrite'));
  await queue.idle();
  await sleep(10);
  if (errors.length) throw errors[0];
}

/** Write `buf` through the adapter in `chunk`-sized pieces, as a transfer would. */
async function streamWrite(adapter, p, buf, chunk = 64 * 1024) {
  const ws = await adapter.createWriteStream(p, { size: buf.length });
  const done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.on('finish', resolve);
  });
  for (let i = 0; i < buf.length; i += chunk) {
    if (!ws.write(buf.subarray(i, Math.min(buf.length, i + chunk)))) {
      await new Promise((r) => ws.once('drain', r));
    }
  }
  ws.end();
  await done;
}

test.before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-e2e-s3-'));
});

test.after(async () => {
  for (const s of servers) await s.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the signature, verified by a server rather than by a vector
// ---------------------------------------------------------------------------

test('connect signs a real request and the server accepts it', async () => {
  const { server, adapter } = await stand();
  assert.equal(adapter.connected, true);
  assert.equal(adapter.protocolName, 'Amazon S3');
  assert.equal(adapter.serverInfo.buckets, 1);
  const first = server.requests[0];
  assert.ok(/^AWS4-HMAC-SHA256 /.test(first.headers.authorization), 'a SigV4 header went on the wire');
  assert.ok(first.headers['x-amz-content-sha256'], 'the payload hash was declared');
  await adapter.disconnect();
});

test('the server rejects a wrongly signed request with 403, so acceptance means something', async () => {
  const { server } = await stand();
  const wrong = makeAdapter(server, {}, 'not-the-secret-key');
  // connect() tolerates a failed ListBuckets (a scoped account cannot do it),
  // so the refusal is asserted on an operation that cannot be shrugged off.
  await wrong.connect();
  await assert.rejects(() => wrong.list('/bucket-one'), /SignatureDoesNotMatch/);
  await wrong.disconnect();
});

test('keys that need escaping are signed exactly as they are sent', async () => {
  // A space or a plus sign in a key is the classic SignatureDoesNotMatch: S3
  // signs the path as sent, and every other AWS service double-encodes it.
  const { server, adapter } = await stand();
  const names = ['plain.bin', 'a space.bin', 'plus+sign.bin', 'tilde~and(parens).bin', '中文.bin'];
  for (const n of names) await adapter.writeFile(`/bucket-one/${n}`, Buffer.from(n, 'utf8'));

  const bucket = server.buckets.get('bucket-one');
  for (const n of names) {
    assert.ok(bucket.objects.has(n), `${n} arrived under its real key`);
    const got = await drain(await adapter.createReadStream(`/bucket-one/${n}`));
    assert.equal(got.toString('utf8'), n);
  }
  await adapter.disconnect();
});

test('an HTTPS endpoint addressed by IP literal is reachable at all', async () => {
  // Node refuses to put an IP address in the TLS ServerName extension, and it
  // refuses *synchronously* — `https.request()` throws ERR_INVALID_ARG_VALUE
  // before a packet is sent — so an adapter that always sets `servername`
  // cannot talk to an HTTPS endpoint addressed by IP at all. Every MinIO or
  // Ceph box reached by address rather than name is exactly that endpoint.
  //
  // No certificate is needed to prove this: the failure being tested happens
  // before the socket opens. So point the adapter at a closed loopback port
  // over HTTPS and insist the error we get is a *transport* failure. If the
  // SNI is wrong, the request never gets far enough to fail that way.
  const probe = await startS3Server({});
  const deadPort = probe.port;
  await probe.close();          // free the port so nothing answers on it

  for (const host of ['127.0.0.1', '::1']) {
    const adapter = new S3Adapter({
      ...SESSION_DEFAULTS,
      protocol: 's3',
      hostName: host,
      portNumber: deadPort,
      userName: ACCESS_KEY,
      ftps: 'implicit',         // really HTTPS, which is what makes SNI apply
      s3UrlStyle: 'path',
      s3DefaultRegion: REGION,
      timeout: 5,
    }, { password: SECRET_KEY, log: () => {} });
    assert.equal(adapter.secure, true, 'the session asked for TLS');

    let failure = null;
    try {
      // connect() tolerates a failed ListBuckets, so use an operation that
      // has to reach the wire and cannot be shrugged off.
      await adapter.list('/bucket-one');
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, `${host}: the request against a dead port must fail`);
    assert.notEqual(failure.code, 'ERR_INVALID_ARG_VALUE',
      `${host}: the request was rejected by Node before it left the process`);
    assert.doesNotMatch(String(failure.message), /ServerName/i,
      `${host}: SNI must be omitted for an IP literal, not sent and rejected`);
    assert.match(String(failure.code || failure.message),
      /ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL|ETIMEDOUT|socket|Timed out/i,
      `${host}: the failure should be the dead port, not the SNI (${failure.message})`);
    await adapter.disconnect();
  }
});

// ---------------------------------------------------------------------------
// buckets, prefixes and the folder marker
// ---------------------------------------------------------------------------

test('the service root lists buckets, and CreateBucket adds one', async () => {
  const { server, adapter } = await stand();
  let rows = await adapter.list('/');
  assert.deepEqual(rows.map((r) => r.name), ['bucket-one']);
  assert.equal(rows[0].type, 'dir');

  await adapter.mkdir('/bucket-two');
  assert.ok(server.buckets.has('bucket-two'));
  rows = await adapter.list('/');
  assert.deepEqual(rows.map((r) => r.name).sort(), ['bucket-one', 'bucket-two']);

  const st = await adapter.stat('/bucket-two');
  assert.equal(st.type, 'dir');
  await adapter.disconnect();
});

test('a prefix is a directory and its zero-byte marker is never shown as a file', async () => {
  const { server, adapter } = await stand();
  await adapter.mkdir('/bucket-one/folder');
  const bucket = server.buckets.get('bucket-one');
  assert.ok(bucket.objects.has('folder/'), 'the marker object really exists on the server');
  assert.equal(bucket.objects.get('folder/').body.length, 0);

  await adapter.writeFile('/bucket-one/folder/inside.bin', Buffer.from('in'));
  await adapter.writeFile('/bucket-one/loose.bin', Buffer.from('out'));
  await adapter.writeFile('/bucket-one/implied/deep/file.bin', Buffer.from('deep'));

  const top = await adapter.list('/bucket-one');
  const byName = new Map(top.map((r) => [r.name, r]));
  assert.deepEqual([...byName.keys()].sort(), ['folder', 'implied', 'loose.bin']);
  assert.equal(byName.get('folder').type, 'dir');
  assert.equal(byName.get('implied').type, 'dir', 'a prefix with no marker is still a folder');
  assert.equal(byName.get('loose.bin').type, 'file');
  // The marker is the folder, not a zero-byte file sitting inside it.
  const inside = await adapter.list('/bucket-one/folder');
  assert.deepEqual(inside.map((r) => r.name), ['inside.bin']);
  assert.equal(inside.filter((r) => r.name === '' || r.name === 'folder').length, 0);

  assert.equal((await adapter.stat('/bucket-one/folder')).type, 'dir');
  assert.equal((await adapter.stat('/bucket-one/implied')).type, 'dir');
  assert.equal((await adapter.stat('/bucket-one/loose.bin')).type, 'file');
  await adapter.disconnect();
});

test('ListObjectsV2 follows the continuation token across more than one page', async () => {
  // The server hands back at most three items a page, so a listing of eight
  // has to be assembled from three requests. A client that stopped at the
  // first page would silently show a third of the bucket.
  const { server, adapter } = await stand({ pageSize: 3 });
  const names = [];
  for (let i = 0; i < 8; i++) {
    const n = `page-${String(i).padStart(2, '0')}.bin`;
    names.push(n);
    await adapter.writeFile(`/bucket-one/${n}`, Buffer.from(n));
  }
  await adapter.mkdir('/bucket-one/zzz-folder');

  const before = server.requests.length;
  const rows = await adapter.list('/bucket-one');
  const listCalls = server.requests.slice(before)
    .filter((r) => r.method === 'GET' && r.query['list-type'] === '2');
  assert.ok(listCalls.length >= 3, `the listing was paged (${listCalls.length} requests)`);
  assert.ok(listCalls.some((r) => r.query['continuation-token']), 'a continuation token was sent back');

  assert.deepEqual(rows.map((r) => r.name).sort(), [...names, 'zzz-folder'].sort());
  assert.equal(rows.find((r) => r.name === 'zzz-folder').type, 'dir');
  await adapter.disconnect();
});

test('the s3MaxKeys site setting reaches the wire as max-keys', async () => {
  const { server, adapter } = await stand({ pageSize: 1000 });
  const paged = makeAdapter(server, { s3MaxKeys: 2 });
  await paged.connect();
  for (let i = 0; i < 5; i++) {
    await adapter.writeFile(`/bucket-one/mk-${i}.bin`, Buffer.from(`${i}`));
  }
  const before = server.requests.length;
  const rows = await paged.list('/bucket-one');
  const calls = server.requests.slice(before).filter((r) => r.query['list-type'] === '2');
  assert.ok(calls.every((r) => r.query['max-keys'] === '2'), 'max-keys was honoured');
  assert.ok(calls.length >= 3, 'and it really produced several pages');
  assert.equal(rows.length, 5);
  await paged.disconnect();
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// object I/O
// ---------------------------------------------------------------------------

test('PutObject then GetObject is byte-identical, and Range works', async () => {
  const { adapter } = await stand();
  const payload = crypto.randomBytes(120000);
  await adapter.writeFile('/bucket-one/blob.bin', payload);

  assert.deepEqual(await drain(await adapter.createReadStream('/bucket-one/blob.bin')), payload);
  assert.deepEqual(
    await drain(await adapter.createReadStream('/bucket-one/blob.bin', { start: 100000 })),
    payload.subarray(100000));
  assert.deepEqual(
    await drain(await adapter.createReadStream('/bucket-one/blob.bin', { start: 5, end: 14 })),
    payload.subarray(5, 15));

  const st = await adapter.stat('/bucket-one/blob.bin');
  assert.equal(st.size, payload.length);
  assert.ok(st.mtime > 0);
  assert.equal(await adapter.checksum('/bucket-one/blob.bin'),
    crypto.createHash('md5').update(payload).digest('hex'),
    'the ETag of a single-part object really is its MD5');
  await adapter.disconnect();
});

test('CopyObject is server side, and a rename is a copy followed by a delete', async () => {
  const { server, adapter } = await stand();
  const payload = crypto.randomBytes(4096);
  await adapter.writeFile('/bucket-one/original.bin', payload);

  await adapter.copy('/bucket-one/original.bin', '/bucket-one/copied.bin');
  const bucket = server.buckets.get('bucket-one');
  assert.deepEqual(bucket.objects.get('copied.bin').body, payload);
  assert.ok(bucket.objects.has('original.bin'), 'a copy leaves the source alone');
  // Server side means the bytes never came back to us.
  assert.ok(server.requests.some((r) => r.method === 'PUT' && r.headers['x-amz-copy-source']),
    'the copy was asked for with x-amz-copy-source');

  await adapter.rename('/bucket-one/original.bin', '/bucket-one/moved.bin');
  assert.equal(bucket.objects.has('original.bin'), false);
  assert.deepEqual(bucket.objects.get('moved.bin').body, payload);

  // And a whole prefix.
  await adapter.writeFile('/bucket-one/tree/a.bin', Buffer.from('a'));
  await adapter.writeFile('/bucket-one/tree/sub/b.bin', Buffer.from('b'));
  await adapter.rename('/bucket-one/tree', '/bucket-one/renamed-tree');
  assert.equal(bucket.objects.has('tree/a.bin'), false);
  assert.equal(bucket.objects.get('renamed-tree/a.bin').body.toString(), 'a');
  assert.equal(bucket.objects.get('renamed-tree/sub/b.bin').body.toString(), 'b');
  await adapter.disconnect();
});

test('deleting a prefix uses DeleteObjects with a Content-MD5 the server verifies', async () => {
  const { server, adapter } = await stand();
  for (let i = 0; i < 4; i++) await adapter.writeFile(`/bucket-one/bulk/f${i}.bin`, Buffer.from(`${i}`));
  await adapter.mkdir('/bucket-one/bulk');

  const before = server.requests.length;
  await adapter.remove('/bucket-one/bulk');
  const bulk = server.requests.slice(before).find((r) => r.method === 'POST' && 'delete' in r.query);
  assert.ok(bulk, 'the bulk delete really used the DeleteObjects call');
  assert.ok(bulk.headers['content-md5'], 'and carried the Content-MD5 S3 insists on');

  const bucket = server.buckets.get('bucket-one');
  assert.equal([...bucket.objects.keys()].filter((k) => k.startsWith('bulk/')).length, 0);
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// multipart
// ---------------------------------------------------------------------------

test('a large upload becomes a real multipart upload and reassembles byte-identically', async () => {
  const { server, adapter } = await stand();
  // Two and a bit parts at S3's 5 MiB floor, which is the part size WinSCP
  // itself uses (S3FileSystem.cpp: S3MinMultiPartChunkSize).
  const payload = crypto.randomBytes(MIN_PART_SIZE * 2 + 777);
  const before = server.requests.length;
  await streamWrite(adapter, '/bucket-one/multi.bin', payload);
  const during = server.requests.slice(before);

  assert.ok(during.some((r) => r.method === 'POST' && 'uploads' in r.query), 'CreateMultipartUpload');
  const parts = during.filter((r) => r.method === 'PUT' && r.query.partNumber);
  assert.ok(parts.length >= 3, `the body really was split (${parts.length} parts)`);
  assert.ok(during.some((r) => r.method === 'POST' && r.query.uploadId), 'CompleteMultipartUpload');

  const stored = server.buckets.get('bucket-one').objects.get('multi.bin');
  assert.deepEqual(stored.body, payload, 'the server reassembled exactly what we sent');
  assert.match(stored.etag, /-\d+$/, 'a multipart object carries a part-count ETag');
  assert.equal(server.uploads.size, 0, 'no upload was left open');

  assert.deepEqual(await drain(await adapter.createReadStream('/bucket-one/multi.bin')), payload);
  // The ETag of a multipart object is not an MD5 and must not be offered as one.
  await assert.rejects(() => adapter.checksum('/bucket-one/multi.bin'), /uploaded in parts/);
  await adapter.disconnect();
});

test('a failed part aborts the upload so no orphan parts are left behind', async () => {
  const { server, adapter } = await stand();
  server.faults.failPart = 2;
  const payload = crypto.randomBytes(MIN_PART_SIZE * 2 + 4096);

  const before = server.requests.length;
  await assert.rejects(() => streamWrite(adapter, '/bucket-one/doomed.bin', payload), /500|InternalError/);
  const during = server.requests.slice(before);

  const aborts = during.filter((r) => r.method === 'DELETE' && r.query.uploadId);
  assert.equal(aborts.length, 1, 'AbortMultipartUpload was sent exactly once');
  assert.equal(server.uploads.size, 0, 'the server is holding no orphan parts');
  assert.equal(server.buckets.get('bucket-one').objects.has('doomed.bin'), false,
    'and no half-assembled object was created');
  server.faults.failPart = null;
  await adapter.disconnect();
});

// ---------------------------------------------------------------------------
// the transfer queue and the synchronizer, over real HTTP
// ---------------------------------------------------------------------------

test('the transfer queue uploads a tree to S3 and downloads it back byte-identically', async () => {
  const { adapter } = await stand();
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
    target: '/bucket-one/payload',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: { transferMode: 'binary' },
  });
  await runQueue(queue);

  for (const [name, buf] of Object.entries(files)) {
    const got = await drain(await adapter.createReadStream(`/bucket-one/payload/${name}`));
    assert.deepEqual(got, buf, `${name} uploaded byte-identically`);
  }

  const back = path.join(stage, 'back');
  await fsp.mkdir(back, { recursive: true });
  const down = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  down.add({
    side: 'download',
    source: '/bucket-one/payload',
    target: path.join(back, 'payload'),
    sourceAdapter: adapter,
    targetAdapter: local,
    copyParam: { transferMode: 'binary' },
  });
  await runQueue(down);

  for (const [name, buf] of Object.entries(files)) {
    assert.deepEqual(await fsp.readFile(path.join(back, 'payload', ...name.split('/'))), buf,
      `${name} came back byte-identically`);
  }
  await local.disconnect();
  await adapter.disconnect();
});

test('a transfer split across parallel connections still produces the exact object', async () => {
  // S3 has no positioned write. If the adapter claims resume support the queue
  // splits the file into ranged chunks and hands each one to its own write
  // stream against the same key — every one of which is a complete PutObject,
  // so the object ends up holding whichever chunk finished last.
  const { adapter } = await stand();
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'par-'));
  const payload = crypto.randomBytes(400000);
  await fsp.writeFile(path.join(stage, 'parallel.bin'), payload);

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: path.join(stage, 'parallel.bin'),
    target: '/bucket-one/parallel.bin',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: {
      transferMode: 'binary',
      parallelTransfers: 4,
      parallelTransferThreshold: 64 * 1024,
    },
  });
  await runQueue(queue);

  assert.deepEqual(await drain(await adapter.createReadStream('/bucket-one/parallel.bin')), payload);
  await local.disconnect();
  await adapter.disconnect();
});

test('an interrupted upload is retried without corrupting the object', async () => {
  const { adapter } = await stand();
  const local = new LocalAdapter({});
  await local.connect();
  const stage = await fsp.mkdtemp(path.join(tmpRoot, 'resume-'));
  const payload = crypto.randomBytes(200000);
  await fsp.writeFile(path.join(stage, 'resumed.bin'), payload);
  // The remains of an aborted attempt, exactly as the queue would have left it.
  await adapter.writeFile('/bucket-one/resumed.bin.filepart', payload.subarray(0, 50000));

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  queue.add({
    side: 'upload',
    source: path.join(stage, 'resumed.bin'),
    target: '/bucket-one/resumed.bin',
    sourceAdapter: local,
    targetAdapter: adapter,
    copyParam: { transferMode: 'binary', resumeSupport: 'on' },
  });
  await runQueue(queue);

  assert.deepEqual(await drain(await adapter.createReadStream('/bucket-one/resumed.bin')), payload);
  await local.disconnect();
  await adapter.disconnect();
});

test('the synchronizer converges a local tree onto S3 and then back again', async () => {
  const { adapter } = await stand();
  const local = new LocalAdapter({});
  await local.connect();
  await adapter.mkdir('/bucket-one/synced');

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
  const first = await sync.compare(local, stage, adapter, '/bucket-one/synced', opts);
  assert.ok(first.counts.upload >= 1);

  const queue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  const applied = await sync.apply(first, queue);
  assert.equal(applied.errors.length, 0);
  await runQueue(queue);

  for (const [name, buf] of Object.entries(contents)) {
    const got = await drain(await adapter.createReadStream(`/bucket-one/synced/${name}`));
    assert.deepEqual(got, buf, `${name} landed byte-identically`);
  }

  const second = await sync.compare(local, stage, adapter, '/bucket-one/synced', opts);
  assert.equal(second.counts.upload, 0, 'the second pass has nothing left to upload');
  assert.equal(second.counts.download, 0);

  const mirror = await fsp.mkdtemp(path.join(tmpRoot, 'mirror-'));
  const downOpts = { direction: 'local', mode: 'synchronize', criteria: 'size', recursive: true };
  const third = await sync.compare(local, mirror, adapter, '/bucket-one/synced', downOpts);
  assert.ok(third.counts.download >= 1);
  const downQueue = new TransferQueue({ prefs: PREF_DEFAULTS, progressMs: 0 });
  await sync.apply(third, downQueue);
  await runQueue(downQueue);

  for (const [name, buf] of Object.entries(contents)) {
    assert.deepEqual(await fsp.readFile(path.join(mirror, ...name.split('/'))), buf);
  }
  const fourth = await sync.compare(local, mirror, adapter, '/bucket-one/synced', downOpts);
  assert.equal(fourth.counts.download, 0, 'the download side converged too');

  await local.disconnect();
  await adapter.disconnect();
});
