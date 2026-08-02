// End-to-end FTP: the REAL adapter against a REAL server over a real socket.
//
// Every other protocol test in this repository mocks the wire. That proves the
// parser and nothing else — a listing parser can be perfect while the client
// never manages to open a data connection. Here `ftp-srv` runs in this process
// on an ephemeral port, `FtpAdapter` dials it through `basic-ftp`, and the
// assertions are about bytes on disk at the far end.
//
// What that buys, specifically:
//   * MLSD, `LIST -a` and plain `LIST` are each forced and parsed from what
//     this server actually emits, rather than from a captured fixture.
//   * Active mode (PORT/EPRT) was written by hand because `basic-ftp` is
//     passive-only. Until now it had never met a server.
//   * The FTPS certificate verifier is proved to be *called*, and proved to
//     refuse the connection when it answers no.
//   * The transfer queue and the synchronizer run over the same socket, so
//     "byte-identical" means bytes that crossed a TCP connection.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { startFtpServer, generateSelfSigned, timeVal } = require('./helpers/ftp-server');
const { FtpAdapter } = require('../design/main/protocols/ftp');
const { LocalAdapter } = require('../design/main/protocols/local');
const { TransferQueue } = require('../design/main/queue');
const sync = require('../design/main/sync');
const { SESSION_DEFAULTS, PREF_DEFAULTS } = require('../design/main/defaults');

// Distinctive on purpose: the "nothing logs a password" test greps for it.
const PASSWORD = 'sw0rdf1sh-never-log-me';
const USER = 'alice';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function siteFor(srv, overrides = {}) {
  return {
    ...SESSION_DEFAULTS,
    protocol: 'ftp',
    hostName: '127.0.0.1',
    portNumber: srv.port,
    userName: USER,
    addressFamily: 'ipv4',
    // The keepalive is a timer that would fire in the middle of somebody
    // else's assertion; the transfers here are far shorter than any idle
    // timeout, so it has nothing to do.
    ftpPingType: 'off',
    timeout: 20,
    ...overrides,
  };
}

/** Connect a fresh adapter, hand it to `fn`, and always disconnect. */
async function withAdapter(srv, overrides, fn) {
  const logSink = [];
  const adapter = new FtpAdapter(siteFor(srv, overrides), {
    password: PASSWORD,
    log: (level, message) => logSink.push(`${level} ${message}`),
    ...(overrides._options || {}),
  });
  adapter.logSink = logSink;
  await adapter.connect();
  try {
    return await fn(adapter);
  } finally {
    await adapter.disconnect().catch(() => {});
  }
}

/** Every FTP directive this server has been asked for. */
function directives(srv) {
  const out = [];
  for (const line of srv.logLines) {
    const m = /"directive":"([A-Z]+)"/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function writeStream(ws, buf) {
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.on('finish', resolve);
    ws.end(buf);
  });
}

/** Deterministic pseudo-random bytes; a repeat run compares the same file. */
function bytes(n, seed = 1) {
  const b = Buffer.allocUnsafe(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function prefs(overrides = {}) {
  const p = JSON.parse(JSON.stringify(PREF_DEFAULTS));
  Object.assign(p.queue, overrides.queue || {});
  const rest = { ...overrides };
  delete rest.queue;
  return Object.assign(p, rest);
}

// ---------------------------------------------------------------------------
// the shared plain-FTP server
// ---------------------------------------------------------------------------

let srv;          // MLSD-capable, password + anonymous logins
let ftp;          // a connected FtpAdapter against it
let scratch;      // a local temp directory for downloads

test.before(async () => {
  srv = await startFtpServer({ users: { [USER]: PASSWORD }, anonymous: true });
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-ftpe2e-'));
  ftp = new FtpAdapter(siteFor(srv), { password: PASSWORD });
  await ftp.connect();
});

test.after(async () => {
  if (ftp) await ftp.disconnect().catch(() => {});
  if (srv) await srv.close();
  if (scratch) await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test('connect logs in and reads the server capabilities off FEAT', () => {
  assert.equal(ftp.connected, true);
  assert.equal(ftp.protocolName, 'FTP');
  assert.equal(ftp.home, '/', 'PWD answered a POSIX path');
  assert.deepEqual(srv.logins, [USER], 'the server saw exactly one login');

  const feats = ftp.serverInfo.features;
  for (const f of ['MLSD', 'MLST', 'MFMT', 'REST', 'SIZE', 'MDTM']) {
    assert.ok(feats.includes(f), `FEAT advertised ${f}`);
  }
  // These are read from FEAT, not assumed: the adapter must not offer resume
  // to the queue unless the server said REST STREAM.
  assert.equal(ftp.caps.resume, true, 'REST STREAM -> resume');
  assert.equal(ftp.caps.timestamp, true, 'MFMT -> timestamp');
  assert.equal(ftp.caps.rights, true, 'SITE HELP mentioned CHMOD -> rights');
  assert.equal(ftp.caps.checksum, true, 'HASH and the X-commands -> checksum');
  assert.equal(ftp.caps.owner, false, 'FTP has no portable chown');
});

test('anonymous login is accepted and never sends the account password', async () => {
  const before = srv.logins.length;
  await withAdapter(srv, { anonymous: true, userName: '', _options: { password: undefined } },
    async (a) => {
      assert.equal(a.connected, true);
      assert.equal(a.home, '/');
      const rows = await a.list('/');
      assert.ok(Array.isArray(rows));
    });
  assert.equal(srv.logins[before], 'anonymous');
});

test('an anonymous session sends the courtesy address, not the account password', async () => {
  // `srv` above uses ftp-srv's own `anonymous` shortcut, which answers 230 to
  // USER and never asks for PASS — so it cannot show what the client would
  // have sent. A real anonymous server does ask, so this one is built as a
  // plain account named `anonymous` whose password is the conventional
  // address: the login only succeeds if the client actually sent it.
  const pub = await startFtpServer({ users: { anonymous: 'anonymous@' } });
  try {
    await withAdapter(pub, { anonymous: true, userName: '', _options: { password: undefined } },
      async (a) => { assert.equal(a.connected, true); });
    assert.deepEqual(pub.logins, ['anonymous']);
    // The server keeps a digest of what PASS carried, never the value itself.
    assert.equal(pub.loginAttempts[0].passwordSha256,
      crypto.createHash('sha256').update('anonymous@').digest('hex'));
    assert.notEqual(pub.loginAttempts[0].passwordSha256,
      crypto.createHash('sha256').update(PASSWORD).digest('hex'),
      'the account password never went to the anonymous server');
  } finally {
    await pub.close();
  }
});

test('a wrong password is refused, and the refusal names no credential', async () => {
  const a = new FtpAdapter(siteFor(srv), { password: 'not-the-password' });
  await assert.rejects(() => a.connect(), (err) => {
    assert.match(err.message, /530|Authentication failed|Bad username or password/i);
    assert.ok(!err.message.includes('not-the-password'), 'the error quoted no credential');
    return true;
  });
  await a.disconnect().catch(() => {});
});

// ---------------------------------------------------------------------------
// listing — every path, against what this server really emits
// ---------------------------------------------------------------------------

test('MLSD is preferred and its facts reach the panel', async () => {
  await fsp.mkdir(path.join(srv.root, 'listing'), { recursive: true });
  await fsp.writeFile(path.join(srv.root, 'listing', 'report.bin'), bytes(1234, 7));
  await fsp.mkdir(path.join(srv.root, 'listing', 'nested'), { recursive: true });

  const rows = await ftp.list('/listing');
  assert.equal(ftp._listCommand, 'MLSD', 'MLSD was the command that worked');

  const names = rows.map((r) => r.name).sort();
  // This server names its cdir/pdir entries the way ProFTPD and vsftpd do —
  // `/listing` and `/`, not `.` and `..` — so dropping them means honouring
  // `type=cdir`/`type=pdir`. A parser that only filtered the literal names
  // would leave two spurious directories in this list.
  assert.deepEqual(names, ['nested', 'report.bin']);
  assert.ok(!names.includes('listing') && !names.includes('/'),
    'the cdir/pdir entries the server sent were dropped on their type fact');

  const file = rows.find((r) => r.name === 'report.bin');
  assert.equal(file.type, 'file');
  assert.equal(file.size, 1234);
  assert.equal(file.owner, 'ftpuser');
  assert.equal(file.group, 'ftpgroup');
  assert.match(file.rights, /^[rwx-]{9}$/);
  // MLSD timestamps are UTC to the second, which is the whole reason to prefer
  // it: compare against what the file system says rather than a fixture.
  const real = await fsp.stat(path.join(srv.root, 'listing', 'report.bin'));
  assert.ok(Math.abs(file.mtime - real.mtimeMs) < 1500,
    `MLSD mtime ${file.mtime} is within a second of ${real.mtimeMs}`);

  const dir = rows.find((r) => r.name === 'nested');
  assert.equal(dir.type, 'dir');
  assert.equal(dir.size, 0);
});

test('the MLSD perm fact is what marks a file read-only', async () => {
  const p = path.join(srv.root, 'listing', 'locked.bin');
  await fsp.writeFile(p, bytes(16, 3));
  await fsp.chmod(p, 0o444);
  try {
    const rows = await ftp.list('/listing');
    const locked = rows.find((r) => r.name === 'locked.bin');
    assert.equal(locked.readOnly, true, 'perm carried no write letter');
    const writable = rows.find((r) => r.name === 'report.bin');
    assert.equal(writable.readOnly, false);
  } finally {
    await fsp.chmod(p, 0o666);
    await fsp.rm(p, { force: true });
  }
});

test('LIST -a is parsed when MLSD is switched off', async () => {
  await withAdapter(srv, { ftpUseMlsd: 'off', ftpListAll: 'on' }, async (a) => {
    const rows = await a.list('/listing');
    assert.equal(a._listCommand, 'LIST -a');
    assert.deepEqual(rows.map((r) => r.name).sort(), ['nested', 'report.bin']);
    const file = rows.find((r) => r.name === 'report.bin');
    assert.equal(file.type, 'file');
    assert.equal(file.size, 1234);
    // A unix listing carries permissions and an owner column; the parser has
    // to find them without the field count being fixed.
    assert.match(file.rights, /^[rwx-]{9}$/);
    assert.ok(file.mtime > 0, 'a date was recovered from the ls-style line');
    assert.equal(rows.find((r) => r.name === 'nested').type, 'dir');
  });
});

test('plain LIST is parsed when the server predates MLSD', async () => {
  const old = await startFtpServer({
    users: { [USER]: PASSWORD },
    blacklist: ['MLSD', 'MLST'],
  });
  try {
    await fsp.mkdir(path.join(old.root, 'plain'), { recursive: true });
    await fsp.writeFile(path.join(old.root, 'plain', 'a file with spaces.bin'), bytes(77, 11));
    await fsp.mkdir(path.join(old.root, 'plain', 'child'), { recursive: true });

    await withAdapter(old, { ftpListAll: 'off' }, async (a) => {
      assert.ok(!a.serverInfo.features.includes('MLSD'),
        'the blacklisted command was left out of FEAT too');
      const rows = await a.list('/plain');
      assert.equal(a._listCommand, 'LIST');
      assert.deepEqual(rows.map((r) => r.name).sort(),
        ['a file with spaces.bin', 'child']);
      const spaced = rows.find((r) => r.name === 'a file with spaces.bin');
      assert.equal(spaced.size, 77, 'a name with spaces survived the ls parser');
      assert.equal(spaced.type, 'file');
    });
  } finally {
    await old.close();
  }
});

test('auto-detection falls back from MLSD to LIST on a server without it', async () => {
  const old = await startFtpServer({ users: { [USER]: PASSWORD }, blacklist: ['MLSD', 'MLST'] });
  try {
    await fsp.writeFile(path.join(old.root, 'only.bin'), bytes(5, 2));
    await withAdapter(old, {}, async (a) => {
      const rows = await a.list('/');
      assert.equal(a._listCommand, 'LIST -a', 'auto settled on the LIST variant');
      assert.deepEqual(rows.map((r) => r.name), ['only.bin']);
    });
  } finally {
    await old.close();
  }
});

test('an empty LIST -a is not accepted as the answer when LIST is still untried', async () => {
  // The failure this guards against is silent: a server that reads `-a` as a
  // file name answers 150/226 with nothing at all rather than an error, so a
  // client that keeps the first command that did not fail shows every
  // directory as empty and never tries plain LIST again.
  const iis = await startFtpServer({
    users: { [USER]: PASSWORD },
    blacklist: ['MLSD', 'MLST'],
    listNoFlags: true,
  });
  try {
    await fsp.writeFile(path.join(iis.root, 'present.bin'), bytes(50, 8));
    await withAdapter(iis, {}, async (a) => {
      const rows = await a.list('/');
      assert.equal(a._listCommand, 'LIST', 'the empty -a reply was rejected and LIST tried');
      assert.deepEqual(rows.map((r) => r.name), ['present.bin'],
        'the directory is not reported as empty');
    });
  } finally {
    await iis.close();
  }
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

test('stat identifies a file and a directory through MLST', async () => {
  const before = directives(srv).length;
  const file = await ftp.stat('/listing/report.bin');
  assert.ok(directives(srv).slice(before).includes('MLST'),
    'MLST really was the command, not the SIZE/MDTM fallback wearing its name');
  assert.equal(file.name, 'report.bin');
  assert.equal(file.type, 'file');
  assert.equal(file.size, 1234);

  const dir = await ftp.stat('/listing');
  assert.equal(dir.name, 'listing');
  assert.equal(dir.type, 'dir');

  assert.equal((await ftp.stat('/')).type, 'dir');
  await assert.rejects(() => ftp.stat('/listing/nope.bin'));
});

test('stat still tells a directory from a file without MLST', async () => {
  // Some servers answer SIZE for a directory (this one does). Believing that
  // reply would report the directory as a file, and the queue would then try
  // to stream it — so the directory probe has to be the one that decides.
  const old = await startFtpServer({ users: { [USER]: PASSWORD }, blacklist: ['MLSD', 'MLST'] });
  try {
    await fsp.mkdir(path.join(old.root, 'adir'), { recursive: true });
    await fsp.writeFile(path.join(old.root, 'afile.bin'), bytes(321, 5));
    await withAdapter(old, {}, async (a) => {
      const d = await a.stat('/adir');
      assert.equal(d.type, 'dir', 'a directory is a directory even when SIZE answers');
      assert.equal(d.name, 'adir');

      const f = await a.stat('/afile.bin');
      assert.equal(f.type, 'file');
      assert.equal(f.size, 321);
      assert.ok(f.mtime > 0, 'MDTM supplied the timestamp');

      await assert.rejects(() => a.stat('/missing.bin'));
    });
  } finally {
    await old.close();
  }
});

// ---------------------------------------------------------------------------
// directory and name operations
// ---------------------------------------------------------------------------

test('mkdir creates one level, and recursive creates the chain', async () => {
  await ftp.mkdir('/made');
  assert.ok(fs.existsSync(path.join(srv.root, 'made')));

  // MKD on this server creates exactly one directory, as RFC 959 says and as
  // every real daemon does — so a plain mkdir of a deep path must fail, and the
  // recursive one has to walk the chain a level at a time rather than hand the
  // whole path over and hope.
  await assert.rejects(() => ftp.mkdir('/made/deep/deeper/deepest'),
    /55\d|ENOENT|no such/i);
  assert.ok(!fs.existsSync(path.join(srv.root, 'made', 'deep')),
    'nothing was created by the non-recursive attempt');

  await ftp.mkdir('/made/deep/deeper/deepest', { recursive: true });
  assert.ok(fs.existsSync(path.join(srv.root, 'made', 'deep', 'deeper', 'deepest')));

  // A second recursive pass over an existing chain is not an error.
  await ftp.mkdir('/made/deep/deeper/deepest', { recursive: true });
});

test('rename moves a file, and moves it between directories', async () => {
  await fsp.writeFile(path.join(srv.root, 'made', 'before.bin'), bytes(64, 13));
  await ftp.rename('/made/before.bin', '/made/after.bin');
  assert.ok(!fs.existsSync(path.join(srv.root, 'made', 'before.bin')));
  assert.ok(fs.existsSync(path.join(srv.root, 'made', 'after.bin')));

  await ftp.rename('/made/after.bin', '/made/deep/moved.bin');
  assert.ok(fs.existsSync(path.join(srv.root, 'made', 'deep', 'moved.bin')));
  assert.equal(ftp.caps.nativeMove, true);
});

test('remove deletes a file, and a directory only when told to recurse', async () => {
  const dir = path.join(srv.root, 'doomed');
  await fsp.mkdir(path.join(dir, 'inner'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'one.bin'), bytes(10, 1));
  await fsp.writeFile(path.join(dir, 'inner', 'two.bin'), bytes(10, 2));

  // Same refusal as the local and SFTP backends: a non-empty directory is not
  // silently emptied because the caller forgot a flag.
  await assert.rejects(() => ftp.remove('/doomed'), /55\d|not empty|ENOTEMPTY/i);
  assert.ok(fs.existsSync(dir), 'the tree survived the refusal');

  await ftp.remove('/doomed', { recursive: true });
  assert.ok(!fs.existsSync(dir));

  const single = path.join(srv.root, 'single.bin');
  await fsp.writeFile(single, bytes(4, 4));
  await ftp.remove('/single.bin');
  assert.ok(!fs.existsSync(single));
});

test('setTimes writes the modification time back through MFMT', async () => {
  const p = path.join(srv.root, 'stamped.bin');
  await fsp.writeFile(p, bytes(32, 9));
  const when = Date.UTC(2019, 2, 14, 9, 26, 53);
  await ftp.setTimes('/stamped.bin', { mtime: when });

  const real = await fsp.stat(p);
  assert.ok(Math.abs(real.mtimeMs - when) < 1500,
    `the server's file really moved to ${new Date(when).toISOString()}`);
  // And the client reads it back the same way, which is what the synchronizer
  // depends on.
  const st = await ftp.stat('/stamped.bin');
  assert.equal(timeVal(st.mtime), timeVal(when));
});

test('setRights drives SITE CHMOD', async () => {
  const p = path.join(srv.root, 'chmodded.bin');
  await fsp.writeFile(p, bytes(8, 6));
  await ftp.setRights('/chmodded.bin', 'r--r--r--');
  try {
    const st = await fsp.stat(p);
    assert.equal(st.mode & 0o200, 0, 'the write bit is gone on the server side');
  } finally {
    await fsp.chmod(p, 0o666);
  }
});

test('checksum uses the algorithm-specific commands and gets the real digest', async () => {
  const payload = Buffer.from('the quick brown fox');
  await fsp.writeFile(path.join(srv.root, 'hashed.bin'), payload);
  const expect = (alg) => crypto.createHash(alg).update(payload).digest('hex');

  assert.equal(await ftp.checksum('/hashed.bin', 'sha-1'), expect('sha1'));
  assert.equal(await ftp.checksum('/hashed.bin', 'sha-256'), expect('sha256'));
  assert.equal(await ftp.checksum('/hashed.bin', 'md5'), expect('md5'));
  assert.match(await ftp.checksum('/hashed.bin', 'crc32'), /^[0-9a-f]{8}$/);

  // SHA-512 has no X-command here, so this one can only come back through the
  // generic HASH command — a different reply shape, parsed the same way.
  assert.equal(await ftp.checksum('/hashed.bin', 'sha-512'), expect('sha512'));

  assert.deepEqual([...ftp.serverInfo.checksumAlgorithms].sort(),
    ['crc32', 'md5', 'sha1', 'sha256', 'sha512'],
    'the dialog is told exactly which algorithms this server can do');

  await assert.rejects(() => ftp.checksum('/hashed.bin', 'whirlpool'),
    /Unknown checksum algorithm/i);
});

test('checksum quotes a file name containing a space', async () => {
  const payload = Buffer.from('spaces are legal in file names');
  await fsp.writeFile(path.join(srv.root, 'a hashed name.bin'), payload);
  assert.equal(await ftp.checksum('/a hashed name.bin', 'sha-256'),
    crypto.createHash('sha256').update(payload).digest('hex'));
});

test('a HASH-only server can still answer, instead of greying the command in and throwing', async () => {
  // Cerberus and FileZilla Server advertise HASH and none of the X-commands.
  // Reporting caps.checksum from HASH while only being able to send XSHA1 is
  // the "menu entry wired to a handler that throws" the mandate forbids.
  const only = await startFtpServer({
    users: { [USER]: PASSWORD },
    blacklist: ['XSHA1', 'XSHA256', 'XMD5', 'XCRC'],
  });
  try {
    const payload = Buffer.from('hash me with the generic command');
    await fsp.writeFile(path.join(only.root, 'h.bin'), payload);
    await withAdapter(only, {}, async (a) => {
      assert.equal(a.caps.checksum, true);
      assert.ok(!a.serverInfo.features.includes('XSHA1'));
      assert.equal(await a.checksum('/h.bin', 'sha-256'),
        crypto.createHash('sha256').update(payload).digest('hex'),
        'the capability the adapter advertised is one it can deliver');
      assert.equal(await a.checksum('/h.bin', 'md5'),
        crypto.createHash('md5').update(payload).digest('hex'));
      // CRC-32 is not in this server's HASH list and has no X-command left.
      await assert.rejects(() => a.checksum('/h.bin', 'crc32'), /does not support/i);
    });
  } finally {
    await only.close();
  }
});

test('a HASH server offering only algorithms we cannot compute is not advertised', async () => {
  // The reason caps.checksum is derived from the algorithm list rather than
  // from the mere presence of HASH: a server can advertise the command and
  // offer nothing we know how to ask for. Reporting the capability here would
  // put "Calculate checksum" in the menu wired to a handler that throws.
  const exotic = await startFtpServer({
    users: { [USER]: PASSWORD },
    blacklist: ['XSHA1', 'XSHA256', 'XMD5', 'XCRC'],
    feat: { HASH: 'HASH BLAKE2B-256*;STREEBOG-512' },
  });
  try {
    await fsp.writeFile(path.join(exotic.root, 'e.bin'), Buffer.from('exotic'));
    await withAdapter(exotic, {}, async (a) => {
      assert.ok(a.serverInfo.features.includes('HASH'), 'the server did advertise HASH');
      assert.deepEqual(a.serverInfo.checksumAlgorithms, [],
        'none of the offered algorithms is one we can request');
      assert.equal(a.caps.checksum, false,
        'so the capability is false even though HASH is present');
      await assert.rejects(() => a.checksum('/e.bin', 'sha-256'), /does not support/i);
    });
  } finally {
    await exotic.close();
  }
});

test('checksum refuses clearly on a server with no hash extension at all', async () => {
  const none = await startFtpServer({
    users: { [USER]: PASSWORD },
    blacklist: ['HASH', 'XSHA1', 'XSHA256', 'XMD5', 'XCRC'],
  });
  try {
    await fsp.writeFile(path.join(none.root, 'n.bin'), Buffer.from('x'));
    await withAdapter(none, {}, async (a) => {
      assert.equal(a.caps.checksum, false, 'the command is greyed out, not offered and broken');
      assert.deepEqual(a.serverInfo.checksumAlgorithms, []);
      await assert.rejects(() => a.checksum('/n.bin', 'sha-1'), /does not support .* checksums/i);
    });
  } finally {
    await none.close();
  }
});

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

test('a download streams the real bytes off the data connection', async () => {
  const payload = bytes(200 * 1024, 21);
  await fsp.writeFile(path.join(srv.root, 'download.bin'), payload);

  const got = await drain(await ftp.createReadStream('/download.bin'));
  assert.equal(got.length, payload.length);
  assert.ok(got.equals(payload), 'byte-identical after a real transfer');
});

test('an upload streams the real bytes onto the server', async () => {
  const payload = bytes(150 * 1024, 22);
  await writeStream(await ftp.createWriteStream('/upload.bin', { size: payload.length }), payload);

  const onDisk = await fsp.readFile(path.join(srv.root, 'upload.bin'));
  assert.ok(onDisk.equals(payload), 'byte-identical on the server file system');

  // readFile/writeFile are the editor's path over the same machinery.
  await ftp.writeFile('/small.bin', Buffer.from('a small edit'));
  assert.equal((await ftp.readFile('/small.bin')).toString(), 'a small edit');
});

test('REST resumes a download from a non-zero offset', async () => {
  const payload = bytes(64 * 1024, 23);
  await fsp.writeFile(path.join(srv.root, 'resume-down.bin'), payload);

  const offset = 40_000;
  const tail = await drain(await ftp.createReadStream('/resume-down.bin', { start: offset }));
  assert.equal(tail.length, payload.length - offset);
  assert.ok(tail.equals(payload.subarray(offset)), 'the tail matches from the exact byte');

  // The first half plus the resumed tail must reconstruct the file exactly.
  const head = await drain(await ftp.createReadStream('/resume-down.bin'));
  assert.ok(Buffer.concat([head.subarray(0, offset), tail]).equals(payload));
});

test('a resumed upload appends rather than truncating', async () => {
  const whole = bytes(50_000, 24);
  const cut = 30_000;
  const target = path.join(srv.root, 'resume-up.bin');

  await writeStream(await ftp.createWriteStream('/resume-up.bin', { size: cut }), whole.subarray(0, cut));
  assert.equal((await fsp.stat(target)).size, cut);

  await writeStream(await ftp.createWriteStream('/resume-up.bin', { start: cut }), whole.subarray(cut));
  const onDisk = await fsp.readFile(target);
  assert.ok(onDisk.equals(whole), 'the interrupted upload finished exactly where it stopped');
});

test('resume is refused outright when the server never advertised REST', async () => {
  const old = await startFtpServer({ users: { [USER]: PASSWORD }, blacklist: ['REST'] });
  try {
    await fsp.writeFile(path.join(old.root, 'x.bin'), bytes(100, 1));
    await withAdapter(old, {}, async (a) => {
      assert.equal(a.caps.resume, false);
      await assert.rejects(() => a.createReadStream('/x.bin', { start: 10 }), /REST/);
      await assert.rejects(() => a.createWriteStream('/x.bin', { start: 10 }), /REST/);
    });
  } finally {
    await old.close();
  }
});

test('passive mode is what the default session negotiates', () => {
  const seen = directives(srv);
  assert.ok(seen.includes('EPSV') || seen.includes('PASV'),
    'the transfers above went through a passive data connection');
  assert.ok(!seen.includes('PORT') && !seen.includes('EPRT'),
    'and never asked the server to dial back');
});

// ---------------------------------------------------------------------------
// active mode — the hand-written PORT/EPRT path
// ---------------------------------------------------------------------------

test('active mode lists, downloads and uploads over a server-initiated connection', async () => {
  const act = await startFtpServer({ users: { [USER]: PASSWORD } });
  try {
    const payload = bytes(90 * 1024, 31);
    await fsp.mkdir(path.join(act.root, 'act'), { recursive: true });
    await fsp.writeFile(path.join(act.root, 'act', 'down.bin'), payload);

    await withAdapter(act, { ftpPasvMode: false }, async (a) => {
      const rows = await a.list('/act');
      assert.deepEqual(rows.map((r) => r.name), ['down.bin']);
      assert.equal(rows[0].size, payload.length);

      const got = await drain(await a.createReadStream('/act/down.bin'));
      assert.ok(got.equals(payload), 'the active-mode download is byte-identical');

      const up = bytes(70 * 1024, 32);
      await writeStream(await a.createWriteStream('/act/up.bin', { size: up.length }), up);
      assert.ok((await fsp.readFile(path.join(act.root, 'act', 'up.bin'))).equals(up),
        'the active-mode upload is byte-identical');

      // And a resumed active transfer, since REST has to be sent before the
      // transfer command rather than after PORT.
      const tail = await drain(await a.createReadStream('/act/down.bin', { start: 60 * 1024 }));
      assert.ok(tail.equals(payload.subarray(60 * 1024)));

      // A resumed *upload* in active mode is a different code path again: it is
      // the one place the adapter sends REST + STOR rather than APPE, so the
      // offset has to reach the server before the transfer command.
      const whole = bytes(45_000, 33);
      const cut = 25_000;
      await writeStream(await a.createWriteStream('/act/resume.bin', { size: cut }),
        whole.subarray(0, cut));
      assert.equal((await fsp.stat(path.join(act.root, 'act', 'resume.bin'))).size, cut);
      await writeStream(await a.createWriteStream('/act/resume.bin', { start: cut }),
        whole.subarray(cut));
      assert.ok((await fsp.readFile(path.join(act.root, 'act', 'resume.bin'))).equals(whole),
        'REST + STOR over an active data connection reconstructed the file');
    });

    const seen = directives(act);
    assert.ok(seen.includes('PORT') || seen.includes('EPRT'),
      'the server was told where to dial');
    assert.ok(!seen.includes('PASV') && !seen.includes('EPSV'),
      'and passive mode was never used as a fallback');
    assert.deepEqual(act.clientErrors, [], 'no data-connection errors on the server side');
  } finally {
    await act.close();
  }
});

// ---------------------------------------------------------------------------
// FTPS
// ---------------------------------------------------------------------------

test('explicit FTPS asks the application about the certificate before logging in', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls });
  try {
    await fsp.writeFile(path.join(sec.root, 'secret.bin'), bytes(4096, 41));

    const calls = [];
    const a = new FtpAdapter(
      siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls' }),
      {
        password: PASSWORD,
        certVerifier: (host, cert, problem) => { calls.push({ host, cert, problem }); return true; },
      });
    await a.connect();
    try {
      assert.equal(calls.length, 1, 'the verifier was called exactly once');
      assert.equal(calls[0].host, 'localhost');
      assert.match(calls[0].problem, /self[-_ ]?signed/i,
        'the reason Node refused the chain was passed through');
      assert.equal(calls[0].cert.authorized, false);
      assert.match(calls[0].cert.fingerprint256, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
      assert.match(calls[0].cert.subject.CN, /localhost/);
      assert.ok(calls[0].cert.valid_to, 'the expiry a user would be shown is present');
      assert.equal(a.protocolName, 'FTPS');
      assert.deepEqual(a.serverInfo.certificate, calls[0].cert);

      // The data connection is TLS too, so this proves PROT P end to end.
      const got = await drain(await a.createReadStream('/secret.bin'));
      assert.ok(got.equals(bytes(4096, 41)), 'byte-identical over TLS');
      const rows = await a.list('/');
      assert.ok(rows.some((r) => r.name === 'secret.bin'));
    } finally {
      await a.disconnect().catch(() => {});
    }
  } finally {
    await sec.close();
  }
});

test('a verifier that answers no refuses the connection', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls });
  try {
    let called = 0;
    const a = new FtpAdapter(
      siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls' }),
      { password: PASSWORD, certVerifier: () => { called += 1; return false; } });

    await assert.rejects(() => a.connect(), /certificate rejected/i);
    assert.equal(called, 1);
    assert.equal(a.connected, false);
    assert.deepEqual(sec.logins, [], 'no credential was ever offered to the server');
    await a.disconnect().catch(() => {});
  } finally {
    await sec.close();
  }
});

test('an async verifier is awaited, and no verifier at all is not a free pass', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls });
  try {
    // Promise-returning verifier: the UI shows a dialog and answers later.
    const slow = new FtpAdapter(siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls' }), {
      password: PASSWORD,
      certVerifier: () => new Promise((r) => setTimeout(() => r(false), 20)),
    });
    await assert.rejects(() => slow.connect(), /certificate rejected/i);
    await slow.disconnect().catch(() => {});

    // With nothing injected the adapter must fall back to Node's verdict,
    // which for a self-signed certificate is "no".
    const bare = new FtpAdapter(siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls' }),
      { password: PASSWORD });
    await assert.rejects(() => bare.connect(), /certificate rejected/i);
    await bare.disconnect().catch(() => {});
    assert.deepEqual(sec.logins, []);
  } finally {
    await sec.close();
  }
});

test('a certificate file makes the chain verify without asking the user', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls });
  const pemFile = path.join(scratch, 'ftps-trust.pem');
  // Written at run time from the certificate this run generated; nothing about
  // it is committed.
  await fsp.writeFile(pemFile, tls.cert + tls.key);
  try {
    const calls = [];
    const a = new FtpAdapter(
      siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls', tlsCertificateFile: pemFile }),
      { password: PASSWORD, certVerifier: (h, cert) => { calls.push(cert); return cert.authorized; } });
    await a.connect();
    try {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].authorized, true, 'the PEM was used as a trust anchor');
      assert.equal(calls[0].problem, null);
      await ftpRoundTrip(a, sec, 'trusted.bin', bytes(2048, 42));
    } finally {
      await a.disconnect().catch(() => {});
    }
  } finally {
    await fsp.rm(pemFile, { force: true });
    await sec.close();
  }
});

test('implicit FTPS wraps the control connection from the first byte', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls, implicit: true });
  try {
    let called = 0;
    const a = new FtpAdapter(
      siteFor(sec, { hostName: 'localhost', ftps: 'implicit' }),
      { password: PASSWORD, certVerifier: () => { called += 1; return true; } });
    await a.connect();
    try {
      assert.equal(called, 1, 'the verifier ran on the implicit handshake too');
      assert.equal(a.protocolName, 'FTPS');
      assert.ok(!directives(sec).includes('AUTH'), 'no AUTH TLS upgrade was needed');
      await ftpRoundTrip(a, sec, 'implicit.bin', bytes(9000, 43));
    } finally {
      await a.disconnect().catch(() => {});
    }
  } finally {
    await sec.close();
  }
});

test('active mode over FTPS keeps us the TLS client on the server-opened socket', async () => {
  const tls = generateSelfSigned();
  const sec = await startFtpServer({ users: { [USER]: PASSWORD }, tls });
  try {
    const payload = bytes(40 * 1024, 44);
    await fsp.writeFile(path.join(sec.root, 'act-tls.bin'), payload);

    const a = new FtpAdapter(
      siteFor(sec, { hostName: 'localhost', ftps: 'explicitTls', ftpPasvMode: false }),
      { password: PASSWORD, certVerifier: () => true });
    await a.connect();
    try {
      const rows = await a.list('/');
      assert.ok(rows.some((r) => r.name === 'act-tls.bin'));
      const got = await drain(await a.createReadStream('/act-tls.bin'));
      assert.ok(got.equals(payload), 'RFC 4217 data connection carried the bytes intact');
      await ftpRoundTrip(a, sec, 'act-tls-up.bin', bytes(20 * 1024, 45));
    } finally {
      await a.disconnect().catch(() => {});
    }
    assert.ok(directives(sec).includes('PORT') || directives(sec).includes('EPRT'));
  } finally {
    await sec.close();
  }
});

/** Upload `payload`, read it back over the same connection, compare both ends. */
async function ftpRoundTrip(adapter, server, name, payload) {
  await writeStream(await adapter.createWriteStream(`/${name}`, { size: payload.length }), payload);
  assert.ok((await fsp.readFile(path.join(server.root, name))).equals(payload),
    `${name} landed byte-identical on the server`);
  const back = await drain(await adapter.createReadStream(`/${name}`));
  assert.ok(back.equals(payload), `${name} came back byte-identical`);
}

// ---------------------------------------------------------------------------
// the password must not be anywhere a human can read
// ---------------------------------------------------------------------------

test('no log line the adapter produces contains the password', async () => {
  const sink = [];
  const events = [];
  const a = new FtpAdapter(siteFor(srv), {
    password: PASSWORD,
    log: (level, message) => sink.push(`${level} ${message}`),
  });
  a.on('log', (e) => events.push(`${e.level} ${e.message}`));
  await a.connect();
  try {
    // Connecting sent a real USER/PASS, and the protocol dialogue is routed
    // into the session log, so the sink below is the log a user would open.
    assert.ok(sink.some((l) => /^send > USER /.test(l)), 'the dialogue reached the log');
    assert.ok(sink.some((l) => /^send > PASS /.test(l)), 'including the PASS command');
    assert.ok(sink.some((l) => /^recv < 2\d\d/.test(l)), 'and the server replies');

    // The surfaces a user or a support ticket can see. The server's own raw
    // socket trace is deliberately not included — the far end necessarily
    // receives the password in clear on a plain-FTP control connection, which
    // is what FTPS exists to fix, and it is not a surface this adapter owns.
    for (const line of [...sink, ...events]) {
      assert.ok(!line.includes(PASSWORD), `a log line leaked the password: ${line}`);
    }
    assert.ok(!JSON.stringify(a.serverInfo).includes(PASSWORD));
    assert.ok(!JSON.stringify(a.session.password || '').includes(PASSWORD),
      'the password was injected, never written into the site record');
  } finally {
    await a.disconnect().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// the transfer queue, over FTP
// ---------------------------------------------------------------------------

test('the transfer queue uploads a tree and downloads it back byte-identically', async () => {
  const local = new LocalAdapter({});
  await local.connect();
  const work = await fsp.mkdtemp(path.join(scratch, 'queue-'));
  const tree = path.join(work, 'tree');
  await fsp.mkdir(path.join(tree, 'inner'), { recursive: true });

  // One file over the 100 KB resume threshold, so the queue writes to
  // `<name>.filepart` and renames — the FTP rename path inside a transfer.
  const files = {
    'big.bin': bytes(140 * 1024, 51),
    'small.bin': bytes(900, 52),
    [path.join('inner', 'nested.bin')]: bytes(4096, 53),
  };
  for (const [rel, buf] of Object.entries(files)) {
    await fsp.writeFile(path.join(tree, rel), buf);
  }

  const q = new TransferQueue({ prefs: prefs({ confirmOverwriting: false }), progressMs: 0 });
  const errors = [];
  q.on('item-error', (e) => errors.push(e.error));

  q.add({
    side: 'upload',
    source: tree,
    target: '/queued',
    sourceAdapter: local,
    targetAdapter: ftp,
    copyParam: { transferMode: 'binary' },
  });
  await q.idle();
  assert.deepEqual(errors.map((e) => e.message), [], 'the upload raised no errors');

  const remoteRoot = path.join(srv.root, 'queued');
  for (const [rel, buf] of Object.entries(files)) {
    const onServer = await fsp.readFile(path.join(remoteRoot, rel));
    assert.ok(onServer.equals(buf), `${rel} uploaded byte-identically`);
  }
  assert.ok(!fs.existsSync(path.join(remoteRoot, 'big.bin.filepart')),
    'the partial file was renamed over the real name, not left behind');

  // Preserve-time is on by default, so the remote copies carry the local
  // timestamps — which is what makes the synchronizer converge below.
  const localBig = await fsp.stat(path.join(tree, 'big.bin'));
  const remoteBig = await fsp.stat(path.join(remoteRoot, 'big.bin'));
  assert.ok(Math.abs(localBig.mtimeMs - remoteBig.mtimeMs) < 2000,
    'MFMT carried the modification time across');

  // ... and back down again.
  const back = path.join(work, 'back');
  await fsp.mkdir(back, { recursive: true });
  const q2 = new TransferQueue({ prefs: prefs({ confirmOverwriting: false }), progressMs: 0 });
  q2.on('item-error', (e) => errors.push(e.error));
  q2.add({
    side: 'download',
    source: '/queued',
    target: back,
    targetIsDir: true,
    sourceAdapter: ftp,
    targetAdapter: local,
    copyParam: { transferMode: 'binary' },
  });
  await q2.idle();
  assert.deepEqual(errors.map((e) => e.message), []);

  // The download names its destination after the remote directory, so the
  // tree lands under `back/queued` rather than under its original local name.
  for (const [rel, buf] of Object.entries(files)) {
    const roundTripped = await fsp.readFile(path.join(back, 'queued', rel));
    assert.ok(roundTripped.equals(buf), `${rel} survived the round trip`);
  }
  await local.disconnect();
});

test('the queue resumes an interrupted upload from the partial file', async () => {
  const local = new LocalAdapter({});
  await local.connect();
  const work = await fsp.mkdtemp(path.join(scratch, 'resume-'));
  const payload = bytes(180 * 1024, 61);
  const source = path.join(work, 'interrupted.bin');
  await fsp.writeFile(source, payload);

  // Simulate the aftermath of a dropped connection: a `.filepart` holding the
  // first slice of the file. The queue must continue it, not start over.
  await fsp.mkdir(path.join(srv.root, 'resumed'), { recursive: true });
  await fsp.writeFile(path.join(srv.root, 'resumed', 'interrupted.bin.filepart'),
    payload.subarray(0, 100 * 1024));

  const q = new TransferQueue({ prefs: prefs({ confirmOverwriting: false }), progressMs: 0 });
  const errors = [];
  q.on('item-error', (e) => errors.push(e.error));
  q.add({
    side: 'upload',
    source,
    target: '/resumed/interrupted.bin',
    sourceAdapter: local,
    targetAdapter: ftp,
    copyParam: { transferMode: 'binary', resumeSupport: 'on' },
  });
  await q.idle();
  assert.deepEqual(errors.map((e) => e.message), []);

  const finished = await fsp.readFile(path.join(srv.root, 'resumed', 'interrupted.bin'));
  assert.ok(finished.equals(payload), 'the resumed upload reconstructed the file exactly');
  await local.disconnect();
});

// ---------------------------------------------------------------------------
// the synchronizer, over FTP
// ---------------------------------------------------------------------------

test('the synchronizer converges a local tree onto the FTP server', async () => {
  const local = new LocalAdapter({});
  await local.connect();
  const work = await fsp.mkdtemp(path.join(scratch, 'sync-'));
  const localDir = path.join(work, 'src');
  await fsp.mkdir(path.join(localDir, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(localDir, 'alpha.bin'), bytes(2048, 71));
  await fsp.writeFile(path.join(localDir, 'beta.bin'), bytes(3072, 72));
  await fsp.writeFile(path.join(localDir, 'sub', 'gamma.bin'), bytes(1024, 73));

  const remoteDir = '/synced';
  await ftp.mkdir(remoteDir);
  // Something on the server that is not on the client, so deleteFiles has real
  // work, and a stale copy of a file so an update has real work.
  await fsp.writeFile(path.join(srv.root, 'synced', 'obsolete.bin'), bytes(16, 74));
  await fsp.writeFile(path.join(srv.root, 'synced', 'beta.bin'), bytes(11, 75));
  await fsp.utimes(path.join(srv.root, 'synced', 'beta.bin'),
    new Date(Date.now() - 86400000), new Date(Date.now() - 86400000));

  const options = {
    direction: 'remote',
    mode: 'synchronize',
    criteria: 'time',
    recursive: true,
    deleteFiles: true,
    transferMode: 'binary',
  };

  const checklist = await sync.compare(local, localDir, ftp, remoteDir, options);
  const actions = checklist.items.map((i) => `${i.action}:${i.local.name || i.remote.name}`).sort();
  assert.ok(actions.includes('upload:alpha.bin'), 'the new file is queued for upload');
  assert.ok(actions.includes('upload:beta.bin'), 'the stale file is queued for update');
  assert.ok(actions.includes('deleteRemote:obsolete.bin'), 'the extra remote file is queued for deletion');

  const q = new TransferQueue({ prefs: prefs({ confirmOverwriting: false }), progressMs: 0 });
  const errors = [];
  q.on('item-error', (e) => errors.push(e.error));
  const applied = await sync.apply(checklist, q);
  assert.deepEqual(applied.errors.map((e) => e.error.message), []);
  await q.idle();
  assert.deepEqual(errors.map((e) => e.message), []);

  // Every byte arrived...
  for (const rel of ['alpha.bin', 'beta.bin', path.join('sub', 'gamma.bin')]) {
    const a = await fsp.readFile(path.join(localDir, rel));
    const b = await fsp.readFile(path.join(srv.root, 'synced', rel));
    assert.ok(a.equals(b), `${rel} matches on both sides`);
  }
  assert.ok(!fs.existsSync(path.join(srv.root, 'synced', 'obsolete.bin')),
    'the obsolete remote file was deleted');

  // ...and a second comparison finds nothing left to do. That is the whole
  // point: a synchronizer that never converges re-uploads the tree every run.
  const again = await sync.compare(local, localDir, ftp, remoteDir, options);
  assert.deepEqual(again.items.map((i) => `${i.action}:${i.local.name || i.remote.name}`), [],
    'the second pass is a no-op');
  await local.disconnect();
});
