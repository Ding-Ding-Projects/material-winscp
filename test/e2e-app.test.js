// e2e-app.test.js — does the APPLICATION work, not just its libraries?
//
// Every other suite in this repository tests a module. This one tests the
// product: it boots the real Electron main process, loads the real preload into
// a real sandboxed renderer showing the real UI, stands a REAL SSH/SFTP server
// up on an ephemeral port, and then does what a user does — make a site,
// connect, answer the host-key question, list, upload, download, rename, delete,
// disconnect — entirely through the IPC surface the renderer is given.
//
// The distinction matters. A unit test that mocks the wire proves the parser.
// It cannot prove that the session layer hands the adapter the shape the
// adapter expects, that a host-key prompt reaches a human, that a reply can
// survive Electron's structured clone, or that the queue's events are the
// events the renderer subscribes to. Those are the failures a user meets first,
// and they only show up here.
//
// Everything is ephemeral: port 0 for both the test server and the harness's
// control socket, a fresh temp directory per app, no fixed paths, and proxy
// variables pointed at a dead loopback port so nothing can reach the network.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { startApp, stopAll, startSftpServer, siteFor, REPO } = require('./helpers/app-harness');

const SHOTS = path.join(REPO, 'design', 'screenshots');

/** A port nothing is listening on — bound, read, and released. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** A TCP endpoint that accepts and then says nothing, ever. */
async function blackHole() {
  const sockets = [];
  const server = net.createServer((s) => { sockets.push(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * Open a session and answer the host-key question the way a user would. The
 * open call cannot be awaited first: it is BLOCKED on the prompt, which is the
 * behaviour under test.
 */
async function connectAnswering(app, siteId, answer = { accept: true, remember: true }) {
  const opening = app.api('session.open', { siteId, connect: true });
  const prompt = await app.waitForEvent('event:prompt', (p) => p.kind === 'hostKey', 20000);
  const answered = await app.api('session.answerPrompt', prompt.sessionId, prompt.promptId, answer);
  assert.ok(answered.ok, `answering the host-key prompt failed: ${JSON.stringify(answered)}`);
  return { reply: await opening, prompt };
}

// =========================================================== the app boots

test.describe('the application boots and stays usable', () => {
  let app;

  test.before(async () => { app = await startApp(); });
  test.after(async () => { if (app) await app.stop(); });

  test.it('starts the real main process and loads the real renderer', async () => {
    const info = await app.ok('app.info');
    assert.equal(info.platform, process.platform);
    assert.ok(info.electron, 'app:info must report the Electron version it is running under');
    // The data root is the throwaway one, not the user's real profile.
    assert.ok(info.paths.root.startsWith(os.tmpdir()), `the app wrote to ${info.paths.root}`);

    assert.equal(await app.evaluate('document.title'), 'WinSCP Material');
    // A page that loaded but never ran its modules would still have a title.
    const nodes = await app.waitForRenderer(40);
    assert.ok(nodes > 40, `the renderer produced only ${nodes} elements`);
    assert.equal(await app.evaluate('typeof window.api'), 'object');
    assert.equal(await app.evaluate('typeof window.require'), 'undefined',
      'the renderer must have no Node primitives');
  });

  test.it('registers the whole IPC surface', async () => {
    const channels = await app.channels();
    assert.ok(channels.length >= 120, `only ${channels.length} channels registered`);
    for (const required of ['app:info', 'config:get', 'session:open', 'fs:list', 'queue:add', 'sync:compare', 'editor:open', 'history:list']) {
      assert.ok(channels.includes(required), `${required} is not registered`);
    }
    // No duplicates: ipcMain.handle would have thrown, but a silent overwrite
    // in a refactor is exactly the kind of thing nobody notices.
    assert.equal(new Set(channels).size, channels.length);
  });

  test.it('captures the real window', async () => {
    await fsp.mkdir(SHOTS, { recursive: true });
    const shot = path.join(SHOTS, 'e2e-app-boot.png');
    const result = await app.screenshot(shot);
    assert.ok(fs.existsSync(shot));
    const png = await fsp.readFile(shot);
    assert.ok(png.length > 1000, `the capture is only ${png.length} bytes`);
    // A PNG, not whatever else happened to land there.
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(result.size.width > 0 && result.size.height > 0);
  });

  test.it('answers while nothing is reachable on the network', async () => {
    // The harness points every proxy variable at a closed loopback port, so an
    // outbound request fails locally and instantly. The app must not care.
    const started = Date.now();
    const info = await app.ok('app.info');
    assert.ok(Date.now() - started < 3000, 'app:info took too long with no network');
    assert.ok(info.version);

    const port = await closedPort();
    const site = await app.ok('config.addSite', {
      name: 'Nothing listening', protocol: 'sftp', hostName: '127.0.0.1',
      portNumber: port, userName: 'nobody', timeout: 3,
    });
    const failed = await app.api('session.open', { siteId: site.id, connect: true });
    assert.equal(failed.ok, false, 'connecting to a closed port must not report success');
    assert.match(failed.error.message, /ECONNREFUSED|refused|connect/i);

    // And the app is still alive and answering afterwards.
    assert.ok((await app.ok('config.get')).prefs);
    assert.ok(Array.isArray(await app.ok('session.list')));
  });
});

// ======================================== a real server, driven through IPC

test.describe('a real SFTP server, driven through the real IPC surface', () => {
  let app;
  let server;
  let siteId;
  let sessionId;
  let localDir;

  const REMOTE_TEXT = 'The bytes have to survive the round trip.\nLine two.\n';

  test.before(async () => {
    server = await startSftpServer();
    app = await startApp();
    // The session log ships off, as WinSCP's does. Turn it on before anything
    // connects, so what the protocol layer says is actually recorded.
    await app.ok('config.setPrefs', { logging: { enabled: true, level: 1 } }, 'e2e: session log on');
    localDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-e2e-local-'));
    // Something for the very first listing to find, put there by the SERVER's
    // own filesystem rather than by us over the wire.
    await fsp.mkdir(path.join(server.root, 'preexisting'), { recursive: true });
    await fsp.writeFile(path.join(server.root, 'readme.txt'), 'placed on the server\n');
  });

  test.after(async () => {
    if (app) await app.stop();
    if (server) await server.close();
    if (localDir) await fsp.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test.it('stores the site without ever handing the password back', async () => {
    const site = await app.ok('config.addSite', siteFor(server, { rootDirectory: '/' }));
    siteId = site.id;
    assert.equal(site.password, '__stored__',
      'a site crossing the bridge must report only THAT a password is stored');
    assert.ok(!JSON.stringify(site).includes(server.password));
  });

  test.it('connects only after the host key is accepted by the user', async () => {
    const { reply, prompt } = await connectAnswering(app, siteId);
    assert.ok(reply.ok, `session.open failed: ${JSON.stringify(reply.error)}`);
    sessionId = reply.value.id;

    assert.equal(prompt.payload.changed, false, 'a first connection is a NEW key, not a changed one');
    assert.match(prompt.payload.fingerprintSHA256, /^SHA256:/);
    assert.equal(prompt.payload.fingerprintSHA256, server.fingerprint,
      'the fingerprint shown to the user must be the one the server actually presented');

    assert.equal(reply.value.connected, true);
    assert.equal(reply.value.protocol, 'sftp');
    assert.equal(reply.value.caps.rights, true, 'SFTP declares permission support');
    // The server saw a real password authentication, not a bypass.
    assert.deepEqual(server.stats.auth.filter((a) => a.accepted).map((a) => a.method), ['password']);
  });

  test.it('remembers the accepted host key, so the second connection is silent', async () => {
    const keys = await app.ok('config.hostKeys');
    assert.ok(keys[`127.0.0.1:${server.port}`], 'the accepted key was not stored');

    const second = await app.ok('session.open', { siteId, connect: true });
    assert.equal(second.connected, true);
    await app.drainEvents();
    // Nothing may have been asked this time.
    const asked = app.seenEvents.filter((e) => e.event === 'event:prompt' && e.payload.kind === 'hostKey');
    assert.equal(asked.length, 1, 'a trusted host key must not be re-asked');
    await app.ok('session.close', second.id);
  });

  test.it('lists what is really on the server', async () => {
    const entries = await app.ok('fs.list', sessionId, '/');
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['preexisting', 'readme.txt']);
    const dir = entries.find((e) => e.name === 'preexisting');
    assert.equal(dir.type, 'dir');
    const file = entries.find((e) => e.name === 'readme.txt');
    assert.equal(file.type, 'file');
    assert.equal(file.size, (await fsp.stat(path.join(server.root, 'readme.txt'))).size);
    // Every column the UI renders exists for every protocol.
    for (const field of ['name', 'type', 'size', 'mtime', 'rights', 'owner', 'group', 'isSymlink', 'hidden']) {
      assert.ok(field in file, `the listing is missing ${field}`);
    }
  });

  test.it('creates a directory that really appears on the server', async () => {
    const made = await app.ok('fs.mkdir', sessionId, '/uploads');
    assert.equal(made, '/uploads');
    assert.ok(fs.existsSync(path.join(server.root, 'uploads')), 'mkdir did not reach the server');
  });

  /** Queue one transfer and wait for the queue to say it finished. */
  async function transfer(request) {
    const added = await app.ok('queue.add', request);
    assert.equal(added.length, 1);
    const done = await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item && p.item.id === added[0].id, 30000);
    assert.equal(done.item.state, 'done');
    assert.equal(done.item.error, null);
    return done.item;
  }

  test.it('uploads a text file, and the server ends up with POSIX line endings', async () => {
    const local = path.join(localDir, 'upload.txt');
    await fsp.writeFile(local, REMOTE_TEXT, 'utf8');

    // `.txt` is in the default asciiFileMask, so in AUTOMATIC transfer mode
    // this is a text-mode transfer and line endings are translated on the way —
    // WinSCP's own behaviour, and the reason the binary round trip below exists
    // as a separate test. Automatic is asked for explicitly because
    // TCopyParamType::Default is tmBinary, exactly as WinSCP ships it.
    const item = await transfer({
      sessionId, direction: 'upload', files: [local], target: '/uploads',
      copyParam: { transferMode: 'automatic' },
    });
    assert.equal(item.progress.filesDone, 1);

    const landed = path.join(server.root, 'uploads', 'upload.txt');
    assert.ok(fs.existsSync(landed), 'the transfer queue reported done but the file is not on the server');
    const onServer = await fsp.readFile(landed, 'utf8');
    assert.equal(onServer, REMOTE_TEXT);
    assert.ok(!onServer.includes('\r'), 'a text-mode upload must leave POSIX line endings on the server');
  });

  test.it('round-trips a binary file through the queue, byte for byte', async () => {
    const payload = crypto.randomBytes(96 * 1024);
    const local = path.join(localDir, 'queue-binary.bin');
    await fsp.writeFile(local, payload);

    await transfer({
      sessionId, direction: 'upload', files: [local], target: '/uploads',
      copyParam: { transferMode: 'binary' },
    });
    const onServer = await fsp.readFile(path.join(server.root, 'uploads', 'queue-binary.bin'));
    assert.ok(onServer.equals(payload), 'the uploaded bytes differ from the source');

    const back = path.join(localDir, 'roundtrip');
    await fsp.mkdir(back, { recursive: true });
    await transfer({
      sessionId, direction: 'download', files: ['/uploads/queue-binary.bin'], target: back,
      copyParam: { transferMode: 'binary' },
    });
    const returned = await fsp.readFile(path.join(back, 'queue-binary.bin'));
    assert.equal(returned.length, payload.length);
    assert.ok(returned.equals(payload), 'the bytes that came back differ from the bytes that went out');
  });

  test.it('writes a small file directly, and reads exactly those bytes back', async () => {
    // The editor's path: base64 in, base64 out, no queue involved.
    const payload = crypto.randomBytes(4096);
    const written = await app.ok('fs.writeFile', sessionId, '/uploads/binary.bin', payload.toString('base64'));
    assert.equal(written, payload.length);

    const onServer = await fsp.readFile(path.join(server.root, 'uploads', 'binary.bin'));
    assert.ok(onServer.equals(payload), 'the bytes on the server differ from the bytes sent');

    const read = await app.ok('fs.readFile', sessionId, '/uploads/binary.bin');
    assert.equal(read.size, payload.length);
    assert.ok(Buffer.from(read.base64, 'base64').equals(payload),
      'the bytes read back differ from the bytes written');
  });

  test.it('downloads the text file back, with this platform\'s line endings', async () => {
    const target = path.join(localDir, 'down');
    await fsp.mkdir(target, { recursive: true });

    await transfer({
      sessionId, direction: 'download', files: ['/uploads/upload.txt'], target,
      copyParam: { transferMode: 'automatic' },
    });

    const landed = path.join(target, 'upload.txt');
    assert.ok(fs.existsSync(landed), 'the download reported done but nothing arrived locally');
    const text = await fsp.readFile(landed, 'utf8');
    // Text mode again: the content is identical, the line terminator is the
    // local one. Asserting byte equality here would be asserting that the
    // ported behaviour is wrong.
    assert.equal(text.replace(/\r\n/g, '\n'), REMOTE_TEXT);
    if (process.platform === 'win32') {
      assert.ok(text.includes('\r\n'), 'a text-mode download on Windows must produce CRLF');
    } else {
      assert.equal(text, REMOTE_TEXT);
    }
  });

  test.it('checksums the remote file over a real exec channel', async () => {
    const expected = crypto.createHash('sha256').update(REMOTE_TEXT, 'utf8').digest('hex');
    const got = await app.ok('fs.checksum', sessionId, '/uploads/upload.txt', 'sha256');
    assert.equal(got, expected);
    assert.ok(server.stats.exec.some((c) => c.includes('sha256sum')),
      'the checksum must have gone over a real command channel');
  });

  test.it('renames on the server, and the server agrees', async () => {
    const renamed = await app.ok('fs.rename', sessionId, '/uploads/upload.txt', '/uploads/renamed.txt');
    assert.equal(renamed, '/uploads/renamed.txt');
    assert.equal(fs.existsSync(path.join(server.root, 'uploads', 'upload.txt')), false);
    assert.ok(fs.existsSync(path.join(server.root, 'uploads', 'renamed.txt')));
    assert.equal(await fsp.readFile(path.join(server.root, 'uploads', 'renamed.txt'), 'utf8'), REMOTE_TEXT);

    // And the panel sees the new name, not the cached old one.
    const entries = await app.ok('fs.list', sessionId, '/uploads', { refresh: true });
    assert.deepEqual(entries.map((e) => e.name).sort(), ['binary.bin', 'queue-binary.bin', 'renamed.txt']);
  });

  test.it('deletes on the server, and the file is really gone', async () => {
    const result = await app.ok('fs.remove', sessionId, ['/uploads/renamed.txt']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.removed, ['/uploads/renamed.txt']);
    assert.equal(fs.existsSync(path.join(server.root, 'uploads', 'renamed.txt')), false);
  });

  test.it('reports server and protocol information from the live session', async () => {
    const info = await app.ok('session.fsInfo', sessionId);
    assert.equal(info.protocol, 'SFTP');
    assert.equal(info.protocolBaseName, 'sftp');
    assert.equal(info.capabilities.rename, true);
    assert.equal(info.home, '/');
  });

  test.it('logged the session without ever logging the password', async () => {
    const text = await app.ok('session.logText', sessionId);
    assert.ok(text.includes('SFTP'), 'the session log is empty');
    assert.ok(!text.includes(server.password), 'the password reached the session log');
    // The adapter's own lines have to arrive as real text, not as "[object Object]"
    // or "undefined" — which is what a mismatched log signature produces.
    assert.ok(!text.includes('[object Object]'), 'an adapter log line arrived as an object');
    assert.ok(/host key|authenticated|SFTP session ready/i.test(text),
      'no protocol-level line reached the session log');
  });

  test.it('disconnects, stays addressable, and reconnects on command', async () => {
    assert.equal(await app.ok('session.disconnect', sessionId), true);

    // Disconnect is not Close: the session is still there, which is the only
    // reason "Reconnect Session" has anything to act on.
    const info = await app.ok('session.info', sessionId);
    assert.equal(info.connected, false);
    assert.equal(info.status, 'closed');

    // And an operation on a disconnected session is refused, not attempted.
    const refused = await app.refused('fs.list', sessionId, '/');
    assert.match(refused.message, /not connected/i);

    const back = await app.ok('session.reconnect', sessionId);
    assert.equal(back.connected, true, 'a disconnected session could not be reconnected');
    assert.deepEqual((await app.ok('fs.list', sessionId, '/uploads')).map((e) => e.name).sort(),
      ['binary.bin', 'queue-binary.bin']);

    // Closing, by contrast, really does retire it.
    assert.equal(await app.ok('session.close', sessionId), true);
    const gone = await app.refused('session.info', sessionId);
    assert.equal(gone.code, 'NO_SUCH_SESSION');
  });
});

// ============================== the queue and the synchronizer talk back

test.describe('the transfer queue and the synchronizer report back to the window', () => {
  let app;
  let server;
  let sessionId;
  let localDir;

  test.before(async () => {
    server = await startSftpServer();
    app = await startApp();
    localDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-e2e-kutd-'));

    // WinSCP's queue runs without confirmations by default. Turning them on is
    // the whole point here: an overwrite confirmation is a decision only the
    // user can make, so it has to actually arrive. This must happen before the
    // first queue call, because that is when the queue is built.
    await app.ok('config.setPrefs', { queue: { noConfirmations: false, transfersLimit: 1 } }, 'e2e: confirmations on');

    const site = await app.ok('config.addSite', siteFor(server, { name: 'Queue e2e', rootDirectory: '/' }));
    const { reply } = await connectAnswering(app, site.id);
    assert.ok(reply.ok, `could not connect: ${JSON.stringify(reply.error)}`);
    sessionId = reply.value.id;
  });

  test.after(async () => {
    if (app) await app.stop();
    if (server) await server.close();
    if (localDir) await fsp.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test.it('asks before overwriting, and the answer actually unblocks the transfer', async () => {
    await fsp.writeFile(path.join(server.root, 'clash.bin'), 'the version already on the server');
    const local = path.join(localDir, 'clash.bin');
    await fsp.writeFile(local, 'the version being uploaded');

    const added = await app.ok('queue.add', {
      sessionId, direction: 'upload', files: [local], target: '/',
      copyParam: { transferMode: 'binary' },
    });
    const itemId = added[0].id;

    // The query has to reach the window. It carries a live `respond` callback
    // on the main side, which is not cloneable, so anything that forwards the
    // raw event object never arrives and the transfer hangs in `query`.
    const asked = await app.waitForEvent('event:prompt',
      (p) => p.payload && p.payload.source === 'queue' && p.payload.query, 20000);
    assert.equal(asked.promptId, itemId, 'the prompt must be correlated by the item id');
    assert.equal(asked.payload.query.kind, 'overwrite');
    assert.equal(asked.payload.query.file, '/clash.bin');
    assert.equal(asked.payload.query.target.size, 'the version already on the server'.length);
    assert.equal(asked.payload.query.source.size, 'the version being uploaded'.length);

    assert.equal(await app.ok('queue.answerQuery', itemId, 'overwrite'), true);

    const done = await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item && p.item.id === itemId, 20000);
    assert.equal(done.item.state, 'done');
    assert.equal(await fsp.readFile(path.join(server.root, 'clash.bin'), 'utf8'),
      'the version being uploaded');
  });

  test.it('takes "skip" for an answer and leaves the server file alone', async () => {
    const local = path.join(localDir, 'clash.bin');
    await fsp.writeFile(local, 'a third version that must never land');

    const added = await app.ok('queue.add', {
      sessionId, direction: 'upload', files: [local], target: '/',
      copyParam: { transferMode: 'binary' },
    });
    const itemId = added[0].id;

    await app.waitForEvent('event:prompt',
      (p) => p.promptId === itemId && p.payload && p.payload.query, 20000);
    assert.equal(await app.ok('queue.answerQuery', itemId, 'skip'), true);

    const done = await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item && p.item.id === itemId, 20000);
    assert.equal(done.item.skipped.length, 1);
    assert.equal(await fsp.readFile(path.join(server.root, 'clash.bin'), 'utf8'),
      'the version being uploaded', 'a skipped transfer overwrote the server file anyway');
  });

  test.it('reports every state change, not only the first and the last', async () => {
    // Stop the pump so the item cannot race through every state before the
    // events can be observed.
    await app.ok('queue.setEnabled', false);
    const off = await app.waitForEvent('event:queue', (p) => p.type === 'queue-updated', 10000);
    assert.equal(off.item.enabled, false);

    const local = path.join(localDir, 'staged.bin');
    await fsp.writeFile(local, crypto.randomBytes(2048));
    const added = await app.ok('queue.add', {
      sessionId, direction: 'upload', files: [local], target: '/',
      copyParam: { transferMode: 'binary' },
    });
    const itemId = added[0].id;
    await app.waitForEvent('event:queue', (p) => p.type === 'item-added' && p.item.id === itemId, 10000);

    await app.ok('queue.pause', itemId);
    const paused = await app.waitForEvent('event:queue',
      (p) => p.type === 'item-updated' && p.item.id === itemId && p.item.state === 'paused', 10000);
    assert.equal(paused.item.state, 'paused');

    await app.ok('queue.resume', itemId);
    await app.waitForEvent('event:queue',
      (p) => p.type === 'item-updated' && p.item.id === itemId && p.item.state !== 'paused', 10000);

    await app.ok('queue.setEnabled', true);
    const done = await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item.id === itemId, 20000);
    assert.equal(done.item.state, 'done');
    assert.ok(fs.existsSync(path.join(server.root, 'staged.bin')));
  });

  test.it('keeps a directory up to date and says what it did', async () => {
    const watched = path.join(localDir, 'watched');
    await fsp.mkdir(watched, { recursive: true });
    await fsp.mkdir(path.join(server.root, 'watched'), { recursive: true });
    // Put the file there BEFORE starting, so the watcher's immediate first pass
    // has something to do and the test never waits on a poll interval.
    await fsp.writeFile(path.join(watched, 'kutd.bin'), 'keep me up to date');

    const started = await app.ok('sync.keepUpToDate', {
      sessionId, localPath: watched, remotePath: '/watched',
      direction: 'remote', recursive: true,
      copyParam: { transferMode: 'binary' },
    });
    assert.ok(started.id);
    assert.equal(typeof started.native, 'boolean');

    // Every one of these is an event name that was never forwarded before.
    await app.waitForEvent('event:sync', (p) => p.id === started.id && p.type === 'started', 15000);
    const changes = await app.waitForEvent('event:sync',
      (p) => p.id === started.id && p.type === 'changes', 20000);
    assert.ok(changes.payload.items.length >= 1, 'the watcher reported no work');
    await app.waitForEvent('event:sync', (p) => p.id === started.id && p.type === 'tick', 15000);

    await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item && /kutd\.bin$/.test(p.item.source || ''), 20000);
    assert.equal(await fsp.readFile(path.join(server.root, 'watched', 'kutd.bin'), 'utf8'),
      'keep me up to date');

    assert.equal(await app.ok('sync.stop', started.id), true);
    await app.waitForEvent('event:sync', (p) => p.id === started.id && p.type === 'stopped', 10000);
  });

  test.it('applies a queue preference to the queue that is already running', async () => {
    // The queue exists long before this test: the renderer asks for the queue
    // list while it is still starting up, and the queue copies its settings out
    // of the preferences at that moment. A setting changed afterwards used to
    // reach the store and nothing else, so "Confirm overwrites" only took
    // effect after a restart. Prove it takes effect now, in both directions.
    const local = path.join(localDir, 'livepref.bin');
    await fsp.writeFile(path.join(server.root, 'livepref.bin'), 'on the server');

    // OFF: the confirmation must stop being asked.
    await app.ok('config.setPrefs', { queue: { noConfirmations: true } }, 'e2e: confirmations off');
    await fsp.writeFile(local, 'silent overwrite');
    const quiet = await app.ok('queue.add', {
      sessionId, direction: 'upload', files: [local], target: '/',
      copyParam: { transferMode: 'binary' },
    });
    await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item.id === quiet[0].id, 20000);
    assert.equal(await fsp.readFile(path.join(server.root, 'livepref.bin'), 'utf8'), 'silent overwrite');
    assert.equal(app.seenEvents.some((e) => e.event === 'event:prompt' && e.payload.promptId === quiet[0].id),
      false, 'the confirmation was still asked after it was switched off');

    // ON again: it must come back without a restart.
    await app.ok('config.setPrefs', { queue: { noConfirmations: false } }, 'e2e: confirmations on');
    await fsp.writeFile(local, 'asked about again');
    const asked = await app.ok('queue.add', {
      sessionId, direction: 'upload', files: [local], target: '/',
      copyParam: { transferMode: 'binary' },
    });
    await app.waitForEvent('event:prompt',
      (p) => p.promptId === asked[0].id && p.payload && p.payload.query, 20000);
    await app.ok('queue.answerQuery', asked[0].id, 'skip');
    await app.waitForEvent('event:queue',
      (p) => p.type === 'item-done' && p.item.id === asked[0].id, 20000);
    assert.equal(await fsp.readFile(path.join(server.root, 'livepref.bin'), 'utf8'), 'silent overwrite');
  });
});

// ===================================================== the contract, abused

test.describe('the IPC contract holds against a hostile renderer', () => {
  let app;
  let server;
  let sessionId;

  test.before(async () => {
    server = await startSftpServer();
    app = await startApp();
    // A session confined to a subdirectory: everything outside it is out of
    // bounds, which is what makes an escaping path testable at all.
    await fsp.mkdir(path.join(server.root, 'sandbox'), { recursive: true });
    await fsp.writeFile(path.join(server.root, 'secret-outside.txt'), 'must never be reachable\n');
    await fsp.writeFile(path.join(server.root, 'sandbox', 'inside.txt'), 'fine\n');

    const site = await app.ok('config.addSite', siteFor(server, {
      name: 'Confined', rootDirectory: '/sandbox', remoteDirectory: '/sandbox',
    }));
    const { reply } = await connectAnswering(app, site.id);
    assert.ok(reply.ok, `could not connect: ${JSON.stringify(reply.error)}`);
    sessionId = reply.value.id;
  });

  test.after(async () => {
    if (app) await app.stop();
    if (server) await server.close();
  });

  test.it('refuses a path that walks out of the session root', async () => {
    for (const escape of [
      '/sandbox/../secret-outside.txt',
      '../secret-outside.txt',
      '/sandbox/../../../../etc/passwd',
      '/sandbox/sub/../../secret-outside.txt',
      '..\\secret-outside.txt',
    ]) {
      const error = await app.refused('fs.list', sessionId, escape);
      assert.match(error.message, /outside this session's root/i, `${escape} was not refused`);
    }
    // The same guard, on every path-taking operation — not just listing.
    await app.refused('fs.stat', sessionId, '/sandbox/../secret-outside.txt');
    await app.refused('fs.readFile', sessionId, '/sandbox/../secret-outside.txt');
    await app.refused('fs.mkdir', sessionId, '/sandbox/../escaped');
    await app.refused('fs.remove', sessionId, ['/sandbox/../secret-outside.txt']);
    await app.refused('fs.rename', sessionId, '/sandbox/inside.txt', '/sandbox/../moved.txt');
    await app.refused('queue.add', { sessionId, direction: 'download', files: ['/sandbox/../secret-outside.txt'], target: os.tmpdir() });

    // Nothing above may have actually happened.
    assert.ok(fs.existsSync(path.join(server.root, 'secret-outside.txt')));
    assert.equal(fs.existsSync(path.join(server.root, 'escaped')), false);
    assert.equal(fs.existsSync(path.join(server.root, 'moved.txt')), false);
    // And the legitimate path inside the root still works, so the guard is a
    // guard and not a blanket refusal.
    assert.deepEqual((await app.ok('fs.list', sessionId, '/sandbox')).map((e) => e.name), ['inside.txt']);
  });

  test.it('answers an unknown session id with an envelope, never a throw', async () => {
    for (const channel of ['session:info', 'session:getState', 'session:logText', 'fs:list', 'fs:stat']) {
      const out = await app.raw(channel, 'no-such-session-id', '/');
      assert.equal(out.threw, false, `${channel} threw across the bridge`);
      assert.equal(out.reply.ok, false);
      assert.equal(out.reply.error.code, 'NO_SUCH_SESSION');
    }
    // session:close is deliberately forgiving — closing what is not open is not
    // an error — but it still has to answer with an envelope.
    const closed = await app.raw('session:close', 'no-such-session-id');
    assert.equal(closed.threw, false);
    assert.equal(closed.reply.ok, true);
    assert.equal(closed.reply.value, false);
  });

  test.it('rejects an oversized argument instead of passing it on', async () => {
    const longPath = '/sandbox/' + 'a'.repeat(5000);
    const tooLong = await app.raw('fs:list', sessionId, longPath);
    assert.equal(tooLong.threw, false);
    assert.equal(tooLong.reply.ok, false);
    assert.match(tooLong.reply.error.message, /too long/i);
    assert.equal(tooLong.reply.error.code, 'INVALID_ARGUMENT');

    // A value too large for the configuration store.
    const bigValue = await app.raw('config:setPref', 'general.note', 'x'.repeat(2 * 1024 * 1024 + 64));
    assert.equal(bigValue.threw, false);
    assert.equal(bigValue.reply.ok, false);
    assert.match(bigValue.reply.error.message, /too large/i);

    // More items than any real selection could hold.
    const tooMany = await app.raw('fs:remove', sessionId, new Array(20001).fill('/sandbox/inside.txt'));
    assert.equal(tooMany.threw, false);
    assert.equal(tooMany.reply.ok, false);
    assert.match(tooMany.reply.error.message, /too many items/i);

    // A NUL truncates a path in every native API underneath us.
    const nul = await app.raw('fs:stat', sessionId, '/sandbox/inside.txt\u0000.png');
    assert.equal(nul.threw, false);
    assert.equal(nul.reply.ok, false);
    assert.match(nul.reply.error.message, /null character/i);
  });

  test.it('never lets a handler throw across the bridge, whatever it is sent', async () => {
    const channels = await app.channels();

    // Excluded because invoking them ENDS or LEAVES the process under test, not
    // because they are exempt from the contract: quitting, closing the window,
    // opening a native modal that never returns headlessly, launching Explorer
    // or a browser, or restarting into an update.
    const SIDE_EFFECTS = new Set([
      'app:quit', 'app:window', 'app:pickPath', 'app:applyUpdateAndRestart',
      'app:showItemInFolder', 'app:openExternal', 'app:checkUpdates',
    ]);

    const SHAPES = [
      [],
      [null],
      [12345],
      [{ unexpected: true, nested: { deep: [1, 2, 3] } }],
      [['an', 'array', 'where', 'a', 'string', 'belongs']],
      ['x'.repeat(100000)],
      [true, false, 0],
    ];

    const violations = [];
    let checked = 0;
    for (const channel of channels) {
      if (SIDE_EFFECTS.has(channel)) continue;
      for (const args of SHAPES) {
        const out = await app.raw(channel, ...args);
        checked += 1;
        if (out.threw) {
          violations.push(`${channel} threw: ${out.message} (args ${JSON.stringify(args)})`);
          continue;
        }
        const reply = out.reply;
        if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
          violations.push(`${channel} returned ${JSON.stringify(reply)} rather than an envelope`);
          continue;
        }
        if (reply.ok === false && (!reply.error || typeof reply.error.message !== 'string')) {
          violations.push(`${channel} failed without a message: ${JSON.stringify(reply)}`);
        }
      }
    }
    assert.deepEqual(violations, [], `IPC contract violations:\n${violations.join('\n')}`);
    assert.ok(checked > 800, `only ${checked} channel/argument combinations were exercised`);
  });

  test.it('exposes no generic passthrough on the real bridge', async () => {
    // preload.js's central decision: the renderer can reach exactly the named
    // functions in that file and nothing else.
    assert.equal(await app.evaluate('typeof window.api.invoke'), 'undefined');
    assert.equal(await app.evaluate('typeof window.api.send'), 'undefined');
    assert.equal(await app.evaluate('typeof window.require'), 'undefined');
    assert.equal(await app.evaluate('typeof window.process'), 'undefined');
    assert.equal(await app.evaluate('typeof window.Buffer'), 'undefined');
    // And an event name outside the allowlist is refused rather than wired up.
    assert.equal(
      await app.evaluate('(() => { try { window.api.on("event:not-a-real-event", () => {}); return "allowed"; } catch (e) { return "refused"; } })()'),
      'refused');
  });

  test.it('validates types rather than trusting the renderer', async () => {
    const cases = [
      ['config:setPref', [123, 'x'], /must be a string/i],
      ['queue:setLimit', ['many'], /must be a number/i],
      ['queue:setEnabled', ['yes'], /must be true or false/i],
      ['config:siteAdd', ['not an object'], /must be an object/i],
      ['config:siteAdd', [{ protocol: 'gopher', hostName: 'h' }], /Unknown protocol/i],
      ['config:siteAdd', [{ protocol: 'sftp' }], /needs a host name/i],
      ['fs:setRights', [null, ['/x'], 'not-a-mode'], /./],
      ['app:openExternal', ['file:///C:/Windows/System32/cmd.exe'], /http, https and mailto/i],
    ];
    for (const [channel, args, pattern] of cases) {
      const out = await app.raw(channel, ...args);
      assert.equal(out.threw, false, `${channel} threw`);
      assert.equal(out.reply.ok, false, `${channel} accepted ${JSON.stringify(args)}`);
      assert.match(out.reply.error.message, pattern, `${channel}: ${out.reply.error.message}`);
    }
  });
});

// ================================================ startup is never blocking

test.describe('startup never waits on the network', () => {
  let app;
  let hole;

  test.before(async () => {
    // A proxy that accepts the connection and then never answers. Anything the
    // app does on a network path will hang forever against it — which is the
    // only way to tell "fast because it is asynchronous" apart from "fast
    // because the request happened to fail quickly".
    hole = await blackHole();
    app = await startApp({
      env: {
        HTTP_PROXY: `http://127.0.0.1:${hole.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${hole.port}`,
        http_proxy: `http://127.0.0.1:${hole.port}`,
        https_proxy: `http://127.0.0.1:${hole.port}`,
      },
    });
  });

  test.after(async () => {
    if (app) await app.stop();
    if (hole) await hole.close();
  });

  test.it('has a usable window before anything network-bound could finish', async () => {
    const t = await app.bootTimings();
    assert.ok(t.ready > 0 && t.loaded >= t.ready);
    // Generous, because a cold CI runner is slow — but far below any network
    // timeout, which is the claim being made.
    assert.ok(t.loaded - t.spawned < 30000, `the window took ${t.loaded - t.spawned}ms to load`);
    assert.ok(t.apiAnswered - t.loaded < 10000, 'the bridge was not usable once the page had loaded');
  });

  test.it('stays responsive with a network request stuck in flight', async () => {
    // Exactly what main.js does at startup: fire the check, never await it.
    await app.updateProbe();

    // Give it a moment to be genuinely stuck rather than merely not started.
    await new Promise((r) => setTimeout(r, 250));
    const inFlight = await app.updateProbeResult();
    assert.equal(inFlight.done, false,
      'the update check finished instantly, so this proves nothing about blocking');

    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      const info = await app.ok('app.info');
      const took = Date.now() - started;
      assert.ok(info.version);
      assert.ok(took < 2000, `app:info took ${took}ms while an update check was stuck`);
    }

    // The UI is not merely answering IPC; it is still running.
    assert.equal(await app.evaluate('document.readyState'), 'complete');
    assert.ok(await app.waitForRenderer(40) > 40);

    // And it is still stuck, so nothing above was measured after it gave up.
    assert.equal((await app.updateProbeResult()).done, false);
  });

  test.it('does not hold the config store hostage to any of that', async () => {
    const started = Date.now();
    await app.ok('config.setPref', 'general.confirmDelete', false, 'e2e');
    await app.ok('config.flush');
    assert.ok(Date.now() - started < 3000);
    const raw = JSON.parse(await app.readConfigBytes());
    assert.equal(raw.prefs.general.confirmDelete, false);
  });
});

// ================================================= credentials, end to end

test.describe('a saved password round-trips without ever being readable', () => {
  let app;
  let server;
  const PASSWORD = 'e2e-P@ssw0rd-never-in-clear-4Kx9';

  test.before(async () => {
    server = await startSftpServer({ password: PASSWORD });
    app = await startApp();
  });

  test.after(async () => {
    if (app) await app.stop();
    if (server) await server.close();
  });

  test.it('protects the secret on disk, and still authenticates with it', async () => {
    const site = await app.ok('config.addSite', siteFor(server, { name: 'Credential round trip' }));
    await app.ok('config.flush');

    const onDisk = await app.readConfigBytes();
    assert.ok(onDisk.length > 0);
    assert.ok(!onDisk.includes(PASSWORD), 'the password is in the configuration file in clear');
    // Nor in any encoding the file could plausibly carry it in.
    assert.ok(!onDisk.includes(Buffer.from(PASSWORD, 'utf8').toString('base64')));
    assert.ok(!onDisk.includes(Buffer.from(PASSWORD, 'utf8').toString('hex')));

    const stored = JSON.parse(onDisk).sites.find((s) => s.id === site.id);
    const { osEncryption } = await app.cryptoInfo();
    if (osEncryption) {
      // Wrapped by the OS credential store, and self-describing about it.
      assert.match(stored.password, /^os:/, `the stored form was ${JSON.stringify(stored.password).slice(0, 40)}`);
      // The real proof: the site alone, with no password supplied anywhere,
      // authenticates against the live server.
      const { reply } = await connectAnswering(app, site.id);
      assert.ok(reply.ok, `the stored password did not authenticate: ${JSON.stringify(reply.error)}`);
      assert.equal(reply.value.connected, true);
      assert.ok(server.stats.auth.some((a) => a.accepted && a.method === 'password'));
      await app.ok('session.close', reply.value.id);
    } else {
      // crypto.js refuses to write a secret it cannot protect. That is the
      // documented behaviour, and it is the safe one.
      assert.equal(stored.password, '',
        'with no OS protection available the secret must not be stored at all');
    }
  });

  test.it('never hands the secret back across the bridge', async () => {
    const sites = await app.ok('config.sites');
    const site = sites.find((s) => s.name === 'Credential round trip');
    assert.equal(site.password, '__stored__');
    assert.ok(!JSON.stringify(sites).includes(PASSWORD));

    const one = await app.ok('config.site', site.id);
    assert.equal(one.password, '__stored__');

    // Exporting is the file people email to themselves: still no plaintext.
    const target = path.join(os.tmpdir(), `winscp-e2e-export-${process.pid}.json`);
    await app.ok('config.export', target);
    const exported = await fsp.readFile(target, 'utf8');
    assert.ok(!exported.includes(PASSWORD), 'the exported configuration contains the password');
    await fsp.rm(target, { force: true });

    // And a generated session URL only carries it when explicitly asked for.
    const openReply = await app.ok('session.open', { siteId: site.id, connect: false });
    const url = await app.ok('session.url', openReply.id, {});
    assert.ok(!url.includes(PASSWORD), 'the session URL leaked the password');
    await app.ok('session.close', openReply.id);
  });

  test.it('keeps the secret out of every log the run produced', async () => {
    const info = await app.ok('app.info');
    const roots = [info.paths.logs, info.paths.root];
    const offenders = [];
    for (const dir of roots) {
      if (!fs.existsSync(dir)) continue;
      for (const name of await fsp.readdir(dir)) {
        const full = path.join(dir, name);
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
        const text = await fsp.readFile(full, 'latin1');
        if (text.includes(PASSWORD)) offenders.push(full);
      }
    }
    assert.deepEqual(offenders, [], `the password appears in: ${offenders.join(', ')}`);
  });
});

// Any app still running when the process is on its way out is a leaked
// Electron; the per-suite `after` hooks are the primary path and this is the
// backstop for a suite that failed before reaching one.
process.on('exit', () => { stopAll().catch(() => undefined); });
