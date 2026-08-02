// e2e-sftp.test.js — the SFTP and SCP adapters against a REAL SSH server.
//
// Everything in this file talks to `test/helpers/sftp-server.js`, which is an
// `ssh2` Server listening on an ephemeral port of the loopback interface with a
// real temporary directory behind it. Nothing is stubbed on the client side:
// the adapter opens a TCP socket, negotiates a key exchange, authenticates,
// opens an SFTP channel or an exec channel, and every assertion below reads
// what actually landed on the server's disk or what the server actually saw on
// the wire.
//
// That distinction matters. `test/queue.test.js` proves the queue's logic
// against in-memory adapters; this file proves the protocol. A unit test that
// mocks the wire cannot tell you that a resumed download really issues its
// first read at the offset instead of at zero — the server has to say so, and
// here it does.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const nodePath = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');

const { startSftpServer, generateKeyPair } = require('./helpers/sftp-server');
const { SftpAdapter, SshTransport } = require('../design/main/protocols/sftp');
const { ScpAdapter } = require('../design/main/protocols/scp');
const { LocalAdapter } = require('../design/main/protocols/local');
const { TransferQueue } = require('../design/main/queue');
const { compare, apply } = require('../design/main/sync');
const { SESSION_DEFAULTS, PREF_DEFAULTS } = require('../design/main/defaults');

// ---------------------------------------------------------------------------
// secrets, and the log lines that must never contain them
// ---------------------------------------------------------------------------

const PASSWORD = 'sup3r-s3cret-passw0rd-Y5nQ';
const KI_ANSWER = 'one-time-token-8842-Zq';
const PASSPHRASE = 'key-passphrase-7Hk2-vault';

/** Every log line every adapter or transport emitted during this whole file.
 *  The last test in the file asserts that not one of them leaks a credential. */
const ALL_LOGS = [];

function captureLogs(emitter, label) {
  emitter.on('log', (e) => ALL_LOGS.push(`${label} ${e.level} ${e.message}`));
  return emitter;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** A session pointing at the running test server, with the host defaults that
 *  would otherwise reach out to this machine (the SSH agent) turned off. */
function sessionFor(srv, extra = {}) {
  return {
    ...SESSION_DEFAULTS,
    hostName: srv.host,
    portNumber: srv.port,
    userName: srv.username,
    password: PASSWORD,
    tryAgent: false,          // never touch the developer's real Pageant
    authKI: false,
    timeout: 20,
    ...extra,
  };
}

/** Accepts any host key and records what it was asked about. */
function recordingVerifier(seen) {
  return async (hostPort, sha256, algorithm) => {
    seen.push({ hostPort, sha256, algorithm });
    return true;
  };
}

async function connectSftp(srv, sessionExtra = {}, options = {}) {
  const adapter = new SftpAdapter(sessionFor(srv, sessionExtra), {
    hostKeyVerifier: async () => true,
    ...options,
  });
  captureLogs(adapter, 'sftp');
  await adapter.connect();
  return adapter;
}

async function tempDir(prefix) {
  return fsp.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

const TEMP_DIRS = [];
async function scratch(prefix) {
  const d = await tempDir(prefix);
  TEMP_DIRS.push(d);
  return d;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** A digest of a whole local tree: relative POSIX path -> 'dir' or a hash. */
async function localTree(root) {
  const out = new Map();
  const walk = async (dir, rel) => {
    for (const name of (await fsp.readdir(dir)).sort()) {
      const full = nodePath.join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = await fsp.lstat(full);
      if (st.isDirectory()) { out.set(key, 'dir'); await walk(full, key); }
      else out.set(key, sha256(await fsp.readFile(full)));
    }
  };
  await walk(root, '');
  return out;
}

/** The same digest, taken through the adapter — so it is the PROTOCOL's view. */
async function remoteTree(adapter, root) {
  const out = new Map();
  const walk = async (dir, rel) => {
    const rows = (await adapter.list(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      const full = adapter.join(dir, row.name);
      const key = rel ? `${rel}/${row.name}` : row.name;
      if (row.type === 'dir') { out.set(key, 'dir'); await walk(full, key); }
      else out.set(key, sha256(await adapter.readFile(full)));
    }
  };
  await walk(adapter.normalize(root), '');
  return out;
}

function newQueue(extra = {}) {
  return new TransferQueue({
    prefs: { ...PREF_DEFAULTS, queue: { ...PREF_DEFAULTS.queue, noConfirmations: true } },
    progressMs: 0,
    ...extra,
  });
}

/** Add one item, wait for the queue to drain, and surface any failure. */
async function runQueue(queue, spec) {
  const failures = [];
  const onError = (e) => failures.push(e.error);
  queue.on('item-error', onError);
  const item = queue.add(spec);
  await queue.idle();
  queue.removeListener('item-error', onError);
  if (failures.length) throw failures[0];
  return item;
}

// ===========================================================================
// host-key verification
// ===========================================================================

describe('SFTP: host-key verification against a real server', () => {
  let srv;
  before(async () => { srv = await startSftpServer({ password: PASSWORD }); });
  after(async () => { await srv.close(); });

  it('offers the server\'s real fingerprint to the verifier and connects when it says yes', async () => {
    const seen = [];
    const adapter = new SftpAdapter(sessionFor(srv), { hostKeyVerifier: recordingVerifier(seen) });
    captureLogs(adapter, 'hostkey-accept');
    await adapter.connect();
    try {
      assert.equal(seen.length, 1, 'the verifier is consulted exactly once');
      assert.equal(seen[0].hostPort, `${srv.host}:${srv.port}`);
      assert.equal(seen[0].sha256, srv.fingerprint,
        'the fingerprint offered is the one the server actually presented');
      assert.match(seen[0].algorithm, /^ssh-ed25519$/);
      assert.equal(adapter.connected, true);
    } finally {
      await adapter.disconnect();
    }
  });

  it('REFUSES the connection when the verifier rejects the key', async () => {
    const before = srv.stats.auth.length;
    const adapter = new SftpAdapter(sessionFor(srv), { hostKeyVerifier: async () => false });
    captureLogs(adapter, 'hostkey-reject');
    try {
      await assert.rejects(() => adapter.connect(), (err) => {
        assert.match(err.message, /handshake|host key|verification|failed/i);
        return true;
      });
      assert.equal(adapter.connected, false);
      assert.equal(srv.stats.auth.length, before,
        'the client never got as far as offering a credential');
    } finally {
      // If this ever regresses, the connection is LIVE, and a live client keeps
      // the loopback server — and therefore the whole runner — alive. Tearing
      // it down here means a regression fails the run instead of hanging it.
      await adapter.disconnect().catch(() => {});
    }
  });

  it('REFUSES the connection when NO verifier is supplied at all', async () => {
    const before = srv.stats.auth.length;
    const adapter = new SftpAdapter(sessionFor(srv), {});     // no hostKeyVerifier
    captureLogs(adapter, 'hostkey-missing');
    try {
      await assert.rejects(() => adapter.connect());
      assert.equal(adapter.connected, false);
      assert.equal(srv.stats.auth.length, before);
      assert.ok(ALL_LOGS.some((l) => /No host-key verifier was supplied/.test(l)),
        'the refusal is explained in the session log');
    } finally {
      await adapter.disconnect().catch(() => {});
    }
  });

  it('refuses when the verifier throws', async () => {
    const adapter = new SftpAdapter(sessionFor(srv), {
      hostKeyVerifier: async () => { throw new Error('the user closed the dialog'); },
    });
    captureLogs(adapter, 'hostkey-throw');
    try {
      await assert.rejects(() => adapter.connect());
      assert.equal(adapter.connected, false);
    } finally {
      await adapter.disconnect().catch(() => {});
    }
  });
});

// ===========================================================================
// authentication
// ===========================================================================

describe('SFTP: authentication against a real server', () => {
  it('authenticates with a password', async () => {
    const srv = await startSftpServer({ password: PASSWORD });
    try {
      const adapter = await connectSftp(srv);
      assert.deepEqual(srv.stats.auth.filter((a) => a.accepted),
        [{ method: 'password', accepted: true }]);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  it('refuses a wrong password rather than connecting anyway', async () => {
    const srv = await startSftpServer({ password: PASSWORD });
    try {
      const adapter = new SftpAdapter(sessionFor(srv, { password: 'not-the-password' }),
        { hostKeyVerifier: async () => true });
      captureLogs(adapter, 'badpassword');
      await assert.rejects(() => adapter.connect());
      assert.ok(srv.stats.auth.every((a) => !a.accepted));
    } finally { await srv.close(); }
  });

  it('authenticates with a public key from a key file', async () => {
    const pair = generateKeyPair('ed25519');
    const srv = await startSftpServer({ authorizedKey: pair.public });
    const dir = await scratch('winscp-e2e-key-');
    const keyFile = nodePath.join(dir, 'id_ed25519');
    await fsp.writeFile(keyFile, pair.private);
    try {
      const adapter = await connectSftp(srv, { password: '', publicKeyFile: keyFile });
      assert.ok(srv.stats.auth.some((a) => a.method === 'publickey' && a.accepted),
        'the server accepted a real public-key signature');
      assert.equal(adapter.connected, true);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  it('is REFUSED when the key file is not the authorized key', async () => {
    // Without this, "authenticates with a public key" only proves that a
    // signature was offered — not that the server checked it, and not that a
    // stranger's key is turned away.
    const authorized = generateKeyPair('ed25519');
    const stranger = generateKeyPair('ed25519');
    const srv = await startSftpServer({ authorizedKey: authorized.public });
    const dir = await scratch('winscp-e2e-key-');
    const keyFile = nodePath.join(dir, 'id_stranger');
    await fsp.writeFile(keyFile, stranger.private);
    try {
      const adapter = new SftpAdapter(
        sessionFor(srv, { password: '', publicKeyFile: keyFile }),
        { hostKeyVerifier: async () => true });
      captureLogs(adapter, 'badkey');
      await assert.rejects(() => adapter.connect());
      assert.equal(adapter.connected, false);
      assert.ok(srv.stats.auth.every((a) => !a.accepted),
        'the server accepted nothing at all');
    } finally { await srv.close(); }
  });

  it('authenticates with a passphrase-protected key file', async () => {
    const pair = generateKeyPair('ed25519', { passphrase: PASSPHRASE, cipher: 'aes256-cbc' });
    const srv = await startSftpServer({ authorizedKey: pair.public });
    const dir = await scratch('winscp-e2e-key-');
    const keyFile = nodePath.join(dir, 'id_locked');
    await fsp.writeFile(keyFile, pair.private);
    try {
      const adapter = await connectSftp(srv,
        { password: '', publicKeyFile: keyFile, passphrase: PASSPHRASE });
      assert.ok(srv.stats.auth.some((a) => a.method === 'publickey' && a.accepted));
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  it('answers a keyboard-interactive challenge through the injected prompt handler', async () => {
    const srv = await startSftpServer({
      allowPassword: false,
      allowKeyboardInteractive: true,
      kiPrompts: [{ prompt: 'Verification code: ', echo: false }],
      kiExpect: KI_ANSWER,
    });
    const asked = [];
    try {
      const adapter = new SftpAdapter(
        sessionFor(srv, { password: '', authKI: true, authKIPassword: false }),
        {
          hostKeyVerifier: async () => true,
          keyboardInteractive: async (req) => { asked.push(req); return [KI_ANSWER]; },
        });
      captureLogs(adapter, 'ki');
      await adapter.connect();
      assert.equal(asked.length, 1);
      assert.equal(asked[0].prompts[0].prompt, 'Verification code: ');
      assert.equal(asked[0].prompts[0].echo, false);
      assert.ok(srv.stats.auth.some((a) => a.method === 'keyboard-interactive' && a.accepted));
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  it('answers a single non-echoed keyboard-interactive prompt from the stored password', async () => {
    const srv = await startSftpServer({
      allowPassword: false,
      allowKeyboardInteractive: true,
      kiExpect: PASSWORD,
    });
    try {
      // authKIPassword is WinSCP's "attempt keyboard-interactive with the
      // password"; with it on, no prompt handler should be needed at all.
      const adapter = await connectSftp(srv, { authKI: true, authKIPassword: true });
      assert.ok(srv.stats.auth.some((a) => a.method === 'keyboard-interactive' && a.accepted));
      await adapter.disconnect();
    } finally { await srv.close(); }
  });
});

// ===========================================================================
// file operations
// ===========================================================================

describe('SFTP: file operations against a real server', () => {
  let srv;
  let a;

  before(async () => {
    srv = await startSftpServer({ password: PASSWORD });
    a = await connectSftp(srv);
  });
  after(async () => { await a.disconnect(); await srv.close(); });

  it('reports the home directory and the server info from a real handshake', () => {
    assert.equal(a.home, '/');
    assert.equal(a.serverInfo.protocol, 'SFTP');
    assert.equal(a.protocolName, 'SFTP');
  });

  it('lists a directory with rights, owner, group, size and mtime', async () => {
    const when = Math.floor(Date.now() / 1000) * 1000 - 3600_000;
    await fsp.writeFile(nodePath.join(srv.root, 'listed.txt'), 'twelve bytes');
    await fsp.utimes(nodePath.join(srv.root, 'listed.txt'), new Date(when), new Date(when));
    await fsp.mkdir(nodePath.join(srv.root, 'listed-dir'), { recursive: true });

    const rows = await a.list('/');
    const file = rows.find((r) => r.name === 'listed.txt');
    const dir = rows.find((r) => r.name === 'listed-dir');

    assert.ok(file, 'the file the server really has is in the listing');
    assert.equal(file.type, 'file');
    assert.equal(file.size, 12);
    assert.equal(file.rights, 'rw-r--r--');
    assert.equal(file.mtime, when);
    // owner/group come out of the longname, not the numeric attribute block
    assert.equal(file.owner, 'wsuser');
    assert.equal(file.group, 'wsgroup');
    assert.ok(/wsuser/.test(file.raw.longname));

    assert.ok(dir);
    assert.equal(dir.type, 'dir');
    assert.equal(dir.rights, 'rwxr-xr-x');
  });

  it('never surfaces "." or ".." as content, though the server really sends them', async () => {
    // The assertion below is only worth anything if the server actually puts
    // '.' and '..' in the READDIR reply, which a real OpenSSH server does.
    // Prove that first, straight off the channel, so a future change to the
    // helper cannot quietly turn this test into one that asserts nothing.
    const raw = await new Promise((resolve, reject) => {
      a.sftp.readdir('/', { full: true }, (err, list) => (err ? reject(err) : resolve(list)));
    });
    const rawNames = raw.map((r) => r.filename);
    assert.ok(rawNames.includes('.') && rawNames.includes('..'),
      'the server offered "." and ".." on the wire');

    const rows = await a.list('/');
    assert.equal(rows.some((r) => r.name === '.' || r.name === '..'), false);
  });

  it('stats a single file', async () => {
    const st = await a.stat('/listed.txt');
    assert.equal(st.name, 'listed.txt');
    assert.equal(st.type, 'file');
    assert.equal(st.size, 12);
    assert.equal(st.rights, 'rw-r--r--');
  });

  it('fails a stat of something that is not there', async () => {
    await assert.rejects(() => a.stat('/definitely-absent'));
  });

  it('canonicalizes a path with a real REALPATH round trip', async () => {
    assert.equal(await a.realpath('.'), '/');
    assert.equal(await a.realpath('/listed-dir/../listed-dir'), '/listed-dir');
  });

  it('creates directories, including recursively', async () => {
    await a.mkdir('/made');
    assert.equal((await a.stat('/made')).type, 'dir');
    await a.mkdir('/deep/a/b/c', { recursive: true });
    assert.equal((await a.stat('/deep/a/b/c')).type, 'dir');
    assert.ok(fs.existsSync(nodePath.join(srv.root, 'deep', 'a', 'b', 'c')),
      'the directories exist on the real file system, not just in a reply');
  });

  it('renames a file', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'before.txt'), 'x');
    await a.rename('/before.txt', '/after.txt');
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'before.txt')), false);
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'after.txt')), true);
  });

  it('removes a file, and removes a directory tree recursively', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'doomed.txt'), 'x');
    await a.remove('/doomed.txt');
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'doomed.txt')), false);

    await fsp.mkdir(nodePath.join(srv.root, 'tree', 'inner'), { recursive: true });
    await fsp.writeFile(nodePath.join(srv.root, 'tree', 'one.txt'), '1');
    await fsp.writeFile(nodePath.join(srv.root, 'tree', 'inner', 'two.txt'), '2');
    await assert.rejects(() => a.remove('/tree'), 'a non-empty directory is not silently emptied');
    await a.remove('/tree', { recursive: true });
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'tree')), false);
  });

  it('creates a symbolic link, reads it back, and resolves it in a listing', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'link-target.txt'), 'pointed at');
    await a.symlink('/link-target.txt', '/the-link');
    assert.equal(await a.readlink('/the-link'), '/link-target.txt');

    const row = (await a.list('/')).find((r) => r.name === 'the-link');
    assert.ok(row);
    assert.equal(row.isSymlink, true);
    assert.equal(row.linkTarget, '/link-target.txt');
    assert.equal(row.type, 'file', 'a link to a file resolves to a file');

    const st = await a.stat('/the-link');
    assert.equal(st.isSymlink, true);
    assert.equal(st.size, 'pointed at'.length, 'stat follows the link for the size');

    await a.remove('/the-link');
  });

  it('changes permissions with setRights and reads them back', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'perms.txt'), 'p');
    await a.setRights('/perms.txt', 'rwxr-x---');
    assert.equal((await a.stat('/perms.txt')).rights, 'rwxr-x---');
    await a.setRights('/perms.txt', 0o644);
    assert.equal((await a.stat('/perms.txt')).rights, 'rw-r--r--');
    await assert.rejects(() => a.setRights('/perms.txt', 'nonsense'));
  });

  it('sets the modification time, in both the positional and the object form', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'stamped.txt'), 's');
    const first = Math.floor((Date.now() - 86400_000) / 1000) * 1000;
    await a.setTimes('/stamped.txt', first);
    assert.equal((await a.stat('/stamped.txt')).mtime, first);

    // The queue and the synchronizer both call setTimes with the object form,
    // so the adapter has to understand it or "preserve timestamps" silently
    // writes a NaN date onto every transferred file.
    const second = Math.floor((Date.now() - 172800_000) / 1000) * 1000;
    await a.setTimes('/stamped.txt', { mtime: second, atime: second });
    assert.equal((await a.stat('/stamped.txt')).mtime, second);
  });

  it('downloads a file as a stream, byte for byte, one request at a time', async () => {
    const payload = crypto.randomBytes(300_000);
    await fsp.writeFile(nodePath.join(srv.root, 'download.bin'), payload);
    srv.stats.reads.length = 0;
    const rs = await a.createReadStream('/download.bin');
    const chunks = [];
    for await (const c of rs) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), payload);

    // docs/protocol-gaps.md records that the streaming path does NOT pipeline,
    // which is a real throughput difference from WinSCP. Measure it here rather
    // than asserting it in prose: a client with one request in flight produces
    // a contiguous, strictly increasing run of offsets, and a pipelining one
    // would not.
    const reads = srv.stats.reads.filter((r) => r.path === '/download.bin');
    assert.ok(reads.length > 1, 'the file needed more than one READ');
    let at = 0;
    for (const r of reads) {
      assert.equal(r.offset, at, 'each READ starts exactly where the last one ended');
      at += r.returned;      // what the server RETURNED, which is short at EOF
    }
    assert.equal(at, payload.length, 'the reads add up to the whole file');
  });

  it('uploads a file as a stream, byte for byte', async () => {
    const payload = crypto.randomBytes(250_000);
    const ws = await a.createWriteStream('/upload.bin');
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('close', resolve);
      ws.end(payload);
    });
    assert.deepEqual(await fsp.readFile(nodePath.join(srv.root, 'upload.bin')), payload);
  });

  it('resumes a download from a non-zero offset — the server sees the offset, not zero', async () => {
    const payload = crypto.randomBytes(200_000);
    await fsp.writeFile(nodePath.join(srv.root, 'resume-down.bin'), payload);
    const offset = 120_000;

    srv.stats.reads.length = 0;
    const rs = await a.createReadStream('/resume-down.bin', { start: offset });
    const chunks = [];
    for await (const c of rs) chunks.push(c);

    assert.deepEqual(Buffer.concat(chunks), payload.subarray(offset));
    const reads = srv.stats.reads.filter((r) => r.path === '/resume-down.bin');
    assert.ok(reads.length > 0, 'the server actually served READ requests');
    assert.equal(reads[0].offset, offset, 'the FIRST read starts at the resume offset');
    assert.equal(reads.some((r) => r.offset < offset), false,
      'nothing before the offset was re-read');
  });

  it('resumes an upload from a non-zero offset — the server sees writes at the offset', async () => {
    const payload = crypto.randomBytes(180_000);
    const offset = 100_000;
    const target = '/resume-up.bin';

    const first = await a.createWriteStream(target);
    await new Promise((resolve, reject) => {
      first.on('error', reject); first.on('close', resolve);
      first.end(payload.subarray(0, offset));
    });
    assert.equal((await a.stat(target)).size, offset);

    srv.stats.writes.length = 0;
    const second = await a.createWriteStream(target, { start: offset });
    await new Promise((resolve, reject) => {
      second.on('error', reject); second.on('close', resolve);
      second.end(payload.subarray(offset));
    });

    const writes = srv.stats.writes.filter((w) => w.path === target);
    assert.ok(writes.length > 0);
    assert.equal(writes[0].offset, offset, 'the continuation starts where the file stopped');
    assert.equal(writes.some((w) => w.offset < offset), false,
      'the bytes already on the server were not written again');
    assert.deepEqual(await fsp.readFile(nodePath.join(srv.root, 'resume-up.bin')), payload);
  });

  it('runs a remote command and reports stdout, stderr and the exit code', async () => {
    const ok = await a.exec('echo hello-from-the-server');
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout.trim(), 'hello-from-the-server');
    assert.equal(ok.stderr, '');

    const bad = await a.exec('echo partial; sha256sum -- /nope-not-here');
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout.trim(), 'partial');
    assert.match(bad.stderr, /No such file/);
  });

  it('computes a checksum that matches the real bytes', async () => {
    const payload = crypto.randomBytes(4096);
    await fsp.writeFile(nodePath.join(srv.root, 'sum.bin'), payload);
    assert.equal(await a.checksum('/sum.bin', 'sha256'), sha256(payload));
    assert.equal(await a.checksum('/sum.bin', 'md5'),
      crypto.createHash('md5').update(payload).digest('hex'));
    await assert.rejects(() => a.checksum('/nope-not-here'));
  });

  it('reports capabilities that match what the server actually offers', async () => {
    assert.equal(a.caps.resume, true);
    assert.equal(a.caps.rights, true);
    assert.equal(a.caps.symlink, true);
    assert.equal(a.caps.exec, true);
    // The test server advertises no OpenSSH extensions, and the adapter must
    // report that honestly rather than assuming them.
    assert.equal(a.caps.spaceInfo, false);
    assert.equal(a.caps.hardlink, false);
    assert.equal(a.caps.copyRemote, false);
    assert.equal(await a.spaceInfo('/'), null);
    await assert.rejects(() => a.hardlink('/listed.txt', '/hard-link'),
      /does not offer hard links/i);
  });
});

// ===========================================================================
// a channel that dies under a stream we already handed out
// ===========================================================================

describe('SFTP: a stream whose channel dies after handover', () => {
  // This is the defect that took the whole main process down: read a file in
  // the editor, press Disconnect, and the CLOSE still in flight comes back as
  // an 'error' on a stream nobody is listening to any more. An unhandled
  // 'error' event is a process-level throw, not a rejected promise, so it
  // cannot be caught by the caller — the adapter has to own the listener.
  //
  // node:test turns an uncaughtException into a failed run, so if the adapter
  // stops adopting its streams this test fails rather than passing quietly.
  it('does not raise an unhandled error event when the session is torn down', async () => {
    const srv = await startSftpServer({ password: PASSWORD });
    try {
      const adapter = await connectSftp(srv);
      // Big enough that the transfer is certainly still in flight — the reads
      // are issued one at a time, so a 20 MB file cannot be done in the tick
      // between starting to flow and calling disconnect().
      await fsp.writeFile(nodePath.join(srv.root, 'torn.bin'), Buffer.alloc(20 * 1024 * 1024, 7));

      const rs = await adapter.createReadStream('/torn.bin');
      let seen = 0;
      rs.on('data', (c) => { seen += c.length; });      // NO 'error' listener here
      await waitFor(() => seen > 0, 5000, 'the download to start');
      assert.ok(seen < 20 * 1024 * 1024, 'the stream is genuinely still running');

      await adapter.disconnect();
      // Give the doomed requests time to come back as errors.
      await sleep(400);
      assert.ok(ALL_LOGS.some((l) => /stream error after handover/.test(l)),
        'the adapter caught and logged the late channel error itself');
    } finally { await srv.close(); }
  });
});

// ===========================================================================
// the transfer queue, driven over a real SFTP connection
// ===========================================================================

describe('SFTP: the transfer queue against a real server', () => {
  let srv;
  let remote;
  let local;
  let localRoot;

  before(async () => {
    srv = await startSftpServer({ password: PASSWORD });
    remote = await connectSftp(srv);
    local = new LocalAdapter();
    captureLogs(local, 'local');
    await local.connect();
    localRoot = await scratch('winscp-e2e-local-');
  });
  after(async () => { await remote.disconnect(); await srv.close(); });

  it('uploads a multi-file tree recursively, byte for byte, reporting progress', async () => {
    const tree = nodePath.join(localRoot, 'up-tree');
    await fsp.mkdir(nodePath.join(tree, 'nested', 'deeper'), { recursive: true });
    const payloads = {
      'one.bin': crypto.randomBytes(40_000),
      'two.bin': crypto.randomBytes(15_000),
      'nested/three.bin': crypto.randomBytes(90_000),
      'nested/deeper/four.bin': crypto.randomBytes(1),
    };
    for (const [rel, buf] of Object.entries(payloads)) {
      await fsp.writeFile(nodePath.join(tree, ...rel.split('/')), buf);
    }
    await remote.mkdir('/queue-up');

    const queue = newQueue();
    const progress = [];
    queue.on('progress', (p) => progress.push({ ...p.progress }));

    const item = await runQueue(queue, {
      side: 'upload',
      source: tree,
      target: '/queue-up',
      targetIsDir: true,
      sourceAdapter: local,
      targetAdapter: remote,
      copyParam: { transferMode: 'binary' },
    });

    assert.equal(item.state, 'done');
    assert.equal(item.progress.filesTotal, 4);
    assert.equal(item.progress.filesDone, 4);
    assert.equal(item.progress.bytes, item.progress.total);
    assert.ok(progress.length > 1, 'progress was reported while the bytes moved');
    assert.ok(progress.some((p) => p.bytes > 0 && p.bytes < p.total),
      'progress was reported part-way through, not only at the end');

    const landed = await remoteTree(remote, '/queue-up/up-tree');
    const expected = await localTree(tree);
    assert.deepEqual([...landed.entries()].sort(), [...expected.entries()].sort());

    // And the same bytes really are on the server's disk.
    for (const [rel, buf] of Object.entries(payloads)) {
      const onDisk = await fsp.readFile(nodePath.join(srv.root, 'queue-up', 'up-tree', ...rel.split('/')));
      assert.deepEqual(onDisk, buf);
    }
  });

  it('downloads a multi-file tree recursively, byte for byte', async () => {
    await fsp.mkdir(nodePath.join(srv.root, 'down-tree', 'inner'), { recursive: true });
    const payloads = {
      'alpha.bin': crypto.randomBytes(70_000),
      'inner/beta.bin': crypto.randomBytes(33_000),
      'inner/gamma.bin': crypto.randomBytes(0),
    };
    for (const [rel, buf] of Object.entries(payloads)) {
      await fsp.writeFile(nodePath.join(srv.root, 'down-tree', ...rel.split('/')), buf);
    }
    const dest = nodePath.join(localRoot, 'downloads');
    await fsp.mkdir(dest, { recursive: true });

    const queue = newQueue();
    const item = await runQueue(queue, {
      side: 'download',
      source: '/down-tree',
      target: dest,
      targetIsDir: true,
      sourceAdapter: remote,
      targetAdapter: local,
      copyParam: { transferMode: 'binary' },
    });

    assert.equal(item.state, 'done');
    const landed = await localTree(nodePath.join(dest, 'down-tree'));
    assert.deepEqual([...landed.entries()].sort(), [
      ['alpha.bin', sha256(payloads['alpha.bin'])],
      ['inner', 'dir'],
      ['inner/beta.bin', sha256(payloads['inner/beta.bin'])],
      ['inner/gamma.bin', sha256(payloads['inner/gamma.bin'])],
    ].sort());
  });

  it('pause really stops the bytes, and resume finishes the transfer intact', async () => {
    const payload = crypto.randomBytes(900_000);
    await fsp.writeFile(nodePath.join(srv.root, 'paused.bin'), payload);
    const dest = nodePath.join(localRoot, 'paused-out');
    await fsp.mkdir(dest, { recursive: true });

    const queue = newQueue();
    const item = queue.add({
      side: 'download',
      source: '/paused.bin',
      target: dest,
      targetIsDir: true,
      sourceAdapter: remote,
      targetAdapter: local,
      // A speed limit is what makes this deterministic: without it a 900 KB
      // file over loopback is gone before the pause could ever land.
      copyParam: { transferMode: 'binary', cpsLimit: 250_000, resumeSupport: 'off' },
    });

    await waitFor(() => item.progress.bytes > 0, 8000, 'the transfer to start moving');
    assert.ok(item.progress.bytes < payload.length, 'the transfer is genuinely still running');

    queue.pauseItem(item.id);
    assert.equal(item.state, 'paused');

    // The queue stops BETWEEN chunks, not mid-write, so exactly one chunk that
    // was already inside the throttle's window still lands. At 250 KB/s a
    // 64 KB chunk occupies 262 ms, so a second of grace is comfortably more
    // than the one chunk in flight and comfortably less than the ten seconds
    // the rest of the file would need.
    await sleep(1200);
    const frozenAt = item.progress.bytes;
    assert.ok(frozenAt > 0 && frozenAt < payload.length, 'paused part-way through');

    await sleep(1000);
    assert.equal(item.progress.bytes, frozenAt, 'not one byte moved while paused');
    assert.equal(item.state, 'paused');

    queue.resumeItem(item.id);
    await queue.idle();
    assert.equal(item.state, 'done');
    assert.deepEqual(await fsp.readFile(nodePath.join(dest, 'paused.bin')), payload);
  });

  it('a resumed download continues from the partial file instead of restarting', async () => {
    const payload = crypto.randomBytes(300_000);
    await fsp.writeFile(nodePath.join(srv.root, 'resumed-down.bin'), payload);
    const dest = nodePath.join(localRoot, 'resume-down');
    await fsp.mkdir(dest, { recursive: true });
    const already = 175_000;
    // Exactly the state an interrupted transfer leaves behind.
    await fsp.writeFile(nodePath.join(dest, 'resumed-down.bin.filepart'), payload.subarray(0, already));

    srv.stats.reads.length = 0;
    const queue = newQueue();
    const item = await runQueue(queue, {
      side: 'download',
      source: '/resumed-down.bin',
      target: dest,
      targetIsDir: true,
      sourceAdapter: remote,
      targetAdapter: local,
      copyParam: { transferMode: 'binary', resumeSupport: 'on' },
    });

    assert.equal(item.state, 'done');
    const reads = srv.stats.reads.filter((r) => r.path === '/resumed-down.bin');
    assert.ok(reads.length > 0);
    assert.equal(reads[0].offset, already, 'the resumed read starts where the part file stopped');
    assert.equal(reads.some((r) => r.offset < already), false,
      'the bytes already on disk were not fetched a second time');
    assert.deepEqual(await fsp.readFile(nodePath.join(dest, 'resumed-down.bin')), payload);
    assert.equal(fs.existsSync(nodePath.join(dest, 'resumed-down.bin.filepart')), false,
      'the part file is renamed away once the content is complete');
  });

  it('a resumed upload continues from the partial file instead of restarting', async () => {
    const payload = crypto.randomBytes(280_000);
    const srcDir = nodePath.join(localRoot, 'resume-up-src');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(nodePath.join(srcDir, 'resumed-up.bin'), payload);
    await remote.mkdir('/resume-up');
    const already = 160_000;
    await fsp.writeFile(nodePath.join(srv.root, 'resume-up', 'resumed-up.bin.filepart'),
      payload.subarray(0, already));

    srv.stats.writes.length = 0;
    const queue = newQueue();
    const item = await runQueue(queue, {
      side: 'upload',
      source: nodePath.join(srcDir, 'resumed-up.bin'),
      target: '/resume-up',
      targetIsDir: true,
      sourceAdapter: local,
      targetAdapter: remote,
      copyParam: { transferMode: 'binary', resumeSupport: 'on' },
    });

    assert.equal(item.state, 'done');
    const writes = srv.stats.writes.filter((w) => w.path === '/resume-up/resumed-up.bin.filepart');
    assert.ok(writes.length > 0, 'the upload really went to the partial file');
    assert.equal(writes[0].offset, already, 'the resumed write starts at the partial length');
    assert.equal(writes.some((w) => w.offset < already), false);
    assert.deepEqual(await fsp.readFile(nodePath.join(srv.root, 'resume-up', 'resumed-up.bin')), payload);
  });

  it('preserves the modification time across a real transfer', async () => {
    const when = Math.floor((Date.now() - 5 * 86400_000) / 1000) * 1000;
    const srcDir = nodePath.join(localRoot, 'stamp-src');
    await fsp.mkdir(srcDir, { recursive: true });
    const file = nodePath.join(srcDir, 'stamped.bin');
    await fsp.writeFile(file, crypto.randomBytes(2048));
    await fsp.utimes(file, new Date(when), new Date(when));
    await remote.mkdir('/stamped');

    const queue = newQueue();
    await runQueue(queue, {
      side: 'upload',
      source: file,
      target: '/stamped',
      targetIsDir: true,
      sourceAdapter: local,
      targetAdapter: remote,
      copyParam: { transferMode: 'binary', preserveTime: true },
    });

    assert.equal((await remote.stat('/stamped/stamped.bin')).mtime, when);
  });
});

// ===========================================================================
// the synchronizer, driven over a real SFTP connection
// ===========================================================================

describe('SFTP: the synchronizer against a real server', () => {
  let srv;
  let remote;
  let local;
  let localRoot;

  const BASE = Math.floor((Date.now() - 7 * 86400_000) / 1000) * 1000;
  const NEWER = BASE + 600_000;

  before(async () => {
    srv = await startSftpServer({ password: PASSWORD });
    remote = await connectSftp(srv);
    local = new LocalAdapter();
    captureLogs(local, 'local');
    await local.connect();
    localRoot = await scratch('winscp-e2e-sync-');

    const put = async (dir, rel, body, when) => {
      const full = nodePath.join(dir, ...rel.split('/'));
      await fsp.mkdir(nodePath.dirname(full), { recursive: true });
      await fsp.writeFile(full, body);
      await fsp.utimes(full, new Date(when), new Date(when));
    };

    const L = nodePath.join(localRoot, 'L');
    const R = nodePath.join(srv.root, 'R');
    await fsp.mkdir(L, { recursive: true });
    await fsp.mkdir(R, { recursive: true });

    await put(L, 'same.bin', 'identical on both sides', BASE);
    await put(R, 'same.bin', 'identical on both sides', BASE);

    await put(L, 'newer-local.bin', 'the local copy, edited later', NEWER);
    await put(R, 'newer-local.bin', 'the remote copy, older', BASE);

    await put(L, 'newer-remote.bin', 'the local copy, older', BASE);
    await put(R, 'newer-remote.bin', 'the remote copy, edited later', NEWER);

    await put(L, 'only-local.bin', 'exists only on the local side', BASE);
    await put(R, 'only-remote.bin', 'exists only on the remote side', BASE);

    await put(L, 'sub/inner-local.bin', 'inside a shared subdirectory', BASE);
    await put(R, 'sub/inner-remote.bin', 'also inside it', BASE);
  });
  after(async () => { await remote.disconnect(); await srv.close(); });

  it('produces the checklist a human would expect', async () => {
    const list = await compare(local, nodePath.join(localRoot, 'L'), remote, '/R', {
      direction: 'both', mode: 'synchronize', criteria: 'time', recursive: true,
    });

    // A checklist item names the file, and carries the directory it sits in on
    // each side, so a nested file is identified by its parent rather than by a
    // relative path.
    const seen = list.items
      .map((i) => {
        const name = i.local.exists ? i.local.name : i.remote.name;
        const parent = (i.action === 'upload' ? i.local.directory : i.remote.directory);
        return `${i.action} ${parent.replace(/^.*[\\/]/, '')}/${name}`;
      })
      .sort();

    assert.deepEqual(seen, [
      'download R/newer-remote.bin',
      'download R/only-remote.bin',
      'download sub/inner-remote.bin',
      'upload L/newer-local.bin',
      'upload L/only-local.bin',
      'upload sub/inner-local.bin',
    ].sort());

    assert.equal(list.counts.upload, 3);
    assert.equal(list.counts.download, 3);
    assert.equal(list.counts.deleteLocal, 0);
    assert.equal(list.counts.deleteRemote, 0);
    assert.ok(list.items.every((i) => i.checked));
    // same.bin is genuinely identical, so it must not appear at all.
    assert.equal(list.items.some((i) => i.local.name === 'same.bin' || i.remote.name === 'same.bin'),
      false);
  });

  it('applies the checklist and the two trees converge', async () => {
    const queue = newQueue();
    const failures = [];
    queue.on('item-error', (e) => failures.push(e.error));

    const list = await compare(local, nodePath.join(localRoot, 'L'), remote, '/R', {
      direction: 'both', mode: 'synchronize', criteria: 'time', recursive: true,
    });
    const applied = await apply(list, queue, {});
    assert.equal(applied.items.length, 6);
    assert.deepEqual(applied.errors, []);

    await queue.idle();
    assert.deepEqual(failures.map((e) => e.message), []);

    const after = await compare(local, nodePath.join(localRoot, 'L'), remote, '/R', {
      direction: 'both', mode: 'synchronize', criteria: 'time', recursive: true,
    });
    assert.deepEqual(after.counts,
      { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, nothing: 0 },
      `the trees still differ: ${JSON.stringify(after.items.map((i) => `${i.action} ${i.local.name || i.remote.name}`))}`);

    // Belt and braces: the actual bytes on both sides now agree.
    const left = await localTree(nodePath.join(localRoot, 'L'));
    const right = await remoteTree(remote, '/R');
    assert.deepEqual([...left.entries()].sort(), [...right.entries()].sort());
  });
});

// ===========================================================================
// SCP, over the same SSH transport
// ===========================================================================

describe('SCP: the shell protocol against a real server', () => {
  let srv;
  let transport;
  let scp;
  let sftp;
  let local;
  let localRoot;

  before(async () => {
    srv = await startSftpServer({ password: PASSWORD });
    transport = new SshTransport(sessionFor(srv), { hostKeyVerifier: async () => true });
    captureLogs(transport, 'transport');
    await transport.connect();

    scp = new ScpAdapter(sessionFor(srv), { transport });
    captureLogs(scp, 'scp');
    await scp.connect();

    // The same authenticated connection carries an SFTP channel too — which is
    // exactly what the session manager does when it switches protocol.
    sftp = new SftpAdapter(sessionFor(srv), { transport });
    captureLogs(sftp, 'sftp-shared');
    await sftp.connect();

    local = new LocalAdapter();
    await local.connect();
    localRoot = await scratch('winscp-e2e-scp-');
  });
  after(async () => {
    await scp.disconnect();
    await sftp.disconnect();
    await transport.disconnect();
    await srv.close();
  });

  it('connects over a shared transport and reports the working directory', () => {
    assert.equal(scp.home, '/');
    assert.equal(scp.protocolName, 'SCP');
    assert.match(scp.serverInfo.system, /Linux/);
    assert.equal(srv.stats.connections, 1, 'one TCP connection carried both protocols');
  });

  it('lists a directory by parsing the server\'s real ls output', async () => {
    const when = Math.floor(Date.now() / 1000) * 1000 - 7200_000;
    await fsp.mkdir(nodePath.join(srv.root, 'scp-list'), { recursive: true });
    await fsp.writeFile(nodePath.join(srv.root, 'scp-list', 'thing.txt'), 'nine bytes');
    await fsp.utimes(nodePath.join(srv.root, 'scp-list', 'thing.txt'), new Date(when), new Date(when));
    await fsp.mkdir(nodePath.join(srv.root, 'scp-list', 'kids'), { recursive: true });

    const rows = await scp.list('/scp-list');
    const file = rows.find((r) => r.name === 'thing.txt');
    assert.ok(file);
    assert.equal(file.type, 'file');
    assert.equal(file.size, 10);
    assert.equal(file.rights, 'rw-r--r--');
    assert.equal(file.owner, 'wsuser');
    assert.equal(file.group, 'wsgroup');
    assert.equal(file.mtime, when, 'the --full-time listing gives the exact second');
    assert.equal(rows.find((r) => r.name === 'kids').type, 'dir');
    assert.equal(rows.some((r) => r.name === '.' || r.name === '..'), false);
  });

  it('stats a single file over the shell', async () => {
    const st = await scp.stat('/scp-list/thing.txt');
    assert.equal(st.name, 'thing.txt');
    assert.equal(st.type, 'file');
    assert.equal(st.size, 10);
  });

  it('creates, renames and removes through real shell commands', async () => {
    await scp.mkdir('/scp-ops/deep', { recursive: true });
    assert.ok(fs.existsSync(nodePath.join(srv.root, 'scp-ops', 'deep')));

    await fsp.writeFile(nodePath.join(srv.root, 'scp-ops', 'from.txt'), 'x');
    await scp.rename('/scp-ops/from.txt', '/scp-ops/to.txt');
    assert.ok(fs.existsSync(nodePath.join(srv.root, 'scp-ops', 'to.txt')));

    await scp.remove('/scp-ops/to.txt');
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'scp-ops', 'to.txt')), false);
    await scp.remove('/scp-ops', { recursive: true });
    assert.equal(fs.existsSync(nodePath.join(srv.root, 'scp-ops')), false);
  });

  it('makes and reads a symbolic link', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'scp-link-target.txt'), 'aimed at');
    await scp.symlink('/scp-link-target.txt', '/scp-link');
    assert.equal(await scp.readlink('/scp-link'), '/scp-link-target.txt');
    const row = (await scp.list('/')).find((r) => r.name === 'scp-link');
    assert.equal(row.isSymlink, true);
    assert.equal(row.linkTarget, '/scp-link-target.txt');
    await scp.remove('/scp-link');
  });

  it('changes permissions and timestamps through chmod and touch', async () => {
    await fsp.writeFile(nodePath.join(srv.root, 'scp-perms.txt'), 'p');
    await scp.setRights('/scp-perms.txt', 'rwxr-x---');
    assert.equal((await scp.stat('/scp-perms.txt')).rights, 'rwxr-x---');

    const when = Math.floor((Date.now() - 3 * 86400_000) / 1000) * 1000;
    srv.stats.exec.length = 0;
    await scp.setTimes('/scp-perms.txt', when);
    assert.equal((await scp.stat('/scp-perms.txt')).mtime, when);

    // The object form the queue and the synchronizer use.
    const other = Math.floor((Date.now() - 4 * 86400_000) / 1000) * 1000;
    await scp.setTimes('/scp-perms.txt', { mtime: other, atime: other });
    assert.equal((await scp.stat('/scp-perms.txt')).mtime, other);

    // Neither call asked for an access time that differs from the modification
    // time, so neither should have paid for a second `touch` round trip.
    const touches = srv.stats.exec.filter((c) => /touch\s+-a\b/.test(c));
    assert.deepEqual(touches, [],
      'no access-time touch is issued when the two times are the same');

    // And when they genuinely differ, the second touch IS issued.
    srv.stats.exec.length = 0;
    const atime = other + 3600_000;
    await scp.setTimes('/scp-perms.txt', { mtime: other, atime });
    assert.equal(srv.stats.exec.filter((c) => /touch\s+-a\b/.test(c)).length, 1);
    assert.equal((await scp.stat('/scp-perms.txt')).mtime, other);
  });

  it('runs a command, checksums a file and reads the free space', async () => {
    const res = await scp.exec('echo scp-side');
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), 'scp-side');

    const payload = crypto.randomBytes(2048);
    await fsp.writeFile(nodePath.join(srv.root, 'scp-sum.bin'), payload);
    assert.equal(await scp.checksum('/scp-sum.bin'), sha256(payload));

    const space = await scp.spaceInfo('/');
    assert.ok(space && space.total > 0 && space.free > 0);
  });

  it('downloads a file over the real SCP wire protocol', async () => {
    const payload = crypto.randomBytes(120_000);
    await fsp.writeFile(nodePath.join(srv.root, 'scp-down.bin'), payload);
    const rs = await scp.createReadStream('/scp-down.bin');
    assert.equal(rs.scpInfo.name, 'scp-down.bin');
    assert.equal(rs.scpInfo.size, payload.length);
    const chunks = [];
    for await (const c of rs) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), payload);
  });

  it('uploads a file over the real SCP wire protocol', async () => {
    const payload = crypto.randomBytes(90_000);
    const ws = await scp.createWriteStream('/scp-up.bin', { size: payload.length, mode: 0o644 });
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end(payload);
    });
    assert.deepEqual(await fsp.readFile(nodePath.join(srv.root, 'scp-up.bin')), payload);
  });

  it('refuses to pretend it can resume, because SCP cannot', async () => {
    assert.equal(scp.caps.resume, false);
    await assert.rejects(() => scp.createReadStream('/scp-down.bin', { start: 1000 }),
      /cannot resume/i);
    await assert.rejects(() => scp.createWriteStream('/scp-nosize.bin', {}),
      /needs the file size/i);
  });

  it('transfers a whole tree in both directions with scp -r', async () => {
    const tree = nodePath.join(localRoot, 'scp-tree');
    await fsp.mkdir(nodePath.join(tree, 'inner'), { recursive: true });
    const payloads = {
      'top.bin': crypto.randomBytes(20_000),
      'inner/deep.bin': crypto.randomBytes(45_000),
    };
    for (const [rel, buf] of Object.entries(payloads)) {
      await fsp.writeFile(nodePath.join(tree, ...rel.split('/')), buf);
    }
    await scp.mkdir('/scp-recursive', { recursive: true });

    const up = await scp.uploadDirectory(tree, '/scp-recursive');
    assert.equal(up.files, 2);
    assert.deepEqual(
      await fsp.readFile(nodePath.join(srv.root, 'scp-recursive', 'scp-tree', 'inner', 'deep.bin')),
      payloads['inner/deep.bin']);

    const back = nodePath.join(localRoot, 'scp-back');
    const down = await scp.downloadDirectory('/scp-recursive/scp-tree', back);
    assert.equal(down.files, 2);
    assert.deepEqual([...(await localTree(nodePath.join(back, 'scp-tree'))).entries()].sort(),
      [...(await localTree(tree)).entries()].sort());
  });

  it('drives the transfer queue over SCP, both ways, byte for byte', async () => {
    const tree = nodePath.join(localRoot, 'scp-queue');
    await fsp.mkdir(nodePath.join(tree, 'sub'), { recursive: true });
    const payloads = {
      'q1.bin': crypto.randomBytes(30_000),
      'sub/q2.bin': crypto.randomBytes(12_345),
    };
    for (const [rel, buf] of Object.entries(payloads)) {
      await fsp.writeFile(nodePath.join(tree, ...rel.split('/')), buf);
    }
    await scp.mkdir('/scp-queue-target', { recursive: true });

    const queue = newQueue();
    const up = await runQueue(queue, {
      side: 'upload',
      source: tree,
      target: '/scp-queue-target',
      targetIsDir: true,
      sourceAdapter: local,
      targetAdapter: scp,
      copyParam: { transferMode: 'binary' },
    });
    assert.equal(up.state, 'done');
    for (const [rel, buf] of Object.entries(payloads)) {
      assert.deepEqual(
        await fsp.readFile(nodePath.join(srv.root, 'scp-queue-target', 'scp-queue', ...rel.split('/'))),
        buf);
    }

    const dest = nodePath.join(localRoot, 'scp-queue-back');
    await fsp.mkdir(dest, { recursive: true });
    const down = await runQueue(queue, {
      side: 'download',
      source: '/scp-queue-target/scp-queue',
      target: dest,
      targetIsDir: true,
      sourceAdapter: scp,
      targetAdapter: local,
      copyParam: { transferMode: 'binary' },
    });
    assert.equal(down.state, 'done');
    assert.deepEqual([...(await localTree(nodePath.join(dest, 'scp-queue'))).entries()].sort(),
      [...(await localTree(tree)).entries()].sort());
  });
});

// ===========================================================================
// nothing secret ever reached the log
// ===========================================================================

describe('no credential ever reaches the session log', () => {
  after(async () => {
    for (const dir of TEMP_DIRS) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('produced log lines, and none of them contains a password or key material', () => {
    assert.ok(ALL_LOGS.length > 50,
      `the suite must actually have logged something (got ${ALL_LOGS.length} lines)`);

    const secrets = [PASSWORD, KI_ANSWER, PASSPHRASE];
    for (const secret of secrets) {
      const leak = ALL_LOGS.find((line) => line.includes(secret));
      // Report the log LEVEL and a redacted position rather than the line, so
      // a failure here does not itself print the secret.
      assert.equal(leak === undefined, true,
        `a log line leaked a credential (${secrets.indexOf(secret)}) at index ${ALL_LOGS.indexOf(leak)}`);
    }

    // Key material has a recognisable shape even when it is not one of the
    // literals above.
    const keyish = ALL_LOGS.find((l) => /BEGIN (OPENSSH|RSA|EC|ENCRYPTED) PRIVATE KEY/.test(l));
    assert.equal(keyish, undefined, 'a private key body reached the log');
  });
});
