// sftp-extensions.test.js — the SFTP extended-request layer, the server
// capability matrix, the broken-server workarounds, and the SSH-layer error,
// banner and host-key rules.
//
// The extended requests are exercised against a REAL SFTP server over a REAL
// socket. `ssh2`'s own server-mode SFTP hard-codes its VERSION reply with no
// extension pairs, so a server built on it physically cannot advertise an
// extension — which is exactly why those code paths were untested before. This
// file therefore accepts the `sftp` subsystem as a plain channel and speaks the
// SFTP wire protocol by hand, which is what a real OpenSSH server does anyway.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { Server, utils, Client } = require('ssh2');
const ext = require('../design/main/protocols/sftp-extensions');
const { SftpAdapter, SshTransport, signedSeconds, applySshSendBuffer } = require('../design/main/protocols/sftp');
const { generateKeyPair } = require('./helpers/sftp-server');

test('SiteAdvanced sendBuf reaches ssh2 highWaterMark and rejects invalid imports', () => {
  assert.equal(applySshSendBuffer({}, 131072).highWaterMark, 131072);
  assert.deepEqual(applySshSendBuffer({}, 0), {});
  assert.deepEqual(applySshSendBuffer({}, 'not-a-number'), {});
});

const P = ext.SFTP_PACKET;

test('SFTP EOF ends a pipelined read cleanly, including an empty file', async () => {
  const adapter = new SftpAdapter({ sftpDownloadQueue: 1 });
  adapter.sftp = {
    open(path, flags, mode, cb) { cb(null, 'handle'); },
    read(handle, buffer, offset, length, position, cb) {
      const error = new Error('End of file');
      error.code = 1; // SSH_FX_EOF
      cb(error);
    },
    close(handle, cb) { cb(); },
  };

  const stream = await adapter.createReadStream('/empty');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, []);
  assert.equal(stream.destroyed, true);
});

test('SFTP recursive removal lstat-probes directory entries without attributes', async () => {
  const adapter = new SftpAdapter({});
  const calls = [];
  adapter.sftp = {};
  adapter._call = async (method, path) => {
    calls.push([method, path]);
    if (method === 'lstat' && path === '/root') return { mode: 0o40755 };
    if (method === 'lstat' && path === '/root/child') return { mode: 0o40755 };
    if (method === 'readdir' && path === '/root') return [{ filename: 'child', attrs: {} }];
    if (method === 'readdir' && path === '/root/child') return [];
    return undefined;
  };

  await adapter.remove('/root', { recursive: true });

  assert.deepEqual(calls, [
    ['lstat', '/root'],
    ['readdir', '/root'],
    ['lstat', '/root/child'],
    ['readdir', '/root/child'],
    ['rmdir', '/root/child'],
    ['rmdir', '/root'],
  ]);
});

// ------------------------------------------------------------- test server

let HOST_KEY = null;
function hostKey() {
  // Via the shared validating generator: ssh2's own parser rejects about
  // 0.3% of what its generator produces (see helpers/sftp-server.js).
  if (!HOST_KEY) HOST_KEY = generateKeyPair('ed25519');
  return HOST_KEY;
}

function u32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function u64(v) {
  const b = Buffer.allocUnsafe(8);
  b.writeUInt32BE(Math.floor(v / 4294967296) >>> 0, 0);
  b.writeUInt32BE(v >>> 0, 4);
  return b;
}
function str(v) {
  const body = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
  return Buffer.concat([u32(body.length), body]);
}
function packet(type, body) {
  const b = body || Buffer.alloc(0);
  return Buffer.concat([u32(1 + b.length), Buffer.from([type]), b]);
}

/**
 * A hand-written SFTP server. `opts.extensions` is the list of name/value pairs
 * it announces in SSH_FXP_VERSION; `opts.handlers` answers extended requests.
 * Everything it receives is recorded, so a test can assert the exact bytes a
 * request put on the wire rather than only its effect.
 */
function startRawSftpServer(opts = {}) {
  const received = [];
  const key = hostKey();
  // Every live connection is tracked so `close()` can end it. `server.close()`
  // alone only stops accepting and then waits for the existing connections —
  // so a subtest that fails its assertion before reaching `adapter.disconnect()`
  // would leave its socket open and hang the whole file in the `finally`,
  // turning a one-line assertion failure into an opaque suite timeout.
  const clients = new Set();
  const server = new Server({ hostKeys: [key.private], ident: opts.ident }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    // A client that walks away mid-handshake — which is exactly what a rejected
    // host key looks like from here — must not take the test process down.
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('subsystem', (acceptSub, reject, info) => {
          if (info.name !== 'sftp') return reject();
          const channel = acceptSub();
          driveSftp(channel, opts, received);
          return undefined;
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        fingerprint: 'SHA256:' + require('crypto').createHash('sha256')
          .update(key.public).digest('base64').replace(/=+$/, ''),
        close: () => new Promise((r) => {
          for (const client of clients) { try { client.end(); } catch { /* already gone */ } }
          clients.clear();
          server.close(r);
        }),
      });
    });
  });
}

function driveSftp(channel, opts, received) {
  let buf = Buffer.alloc(0);
  const extensions = opts.extensions || [];
  const handlers = opts.handlers || {};

  channel.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const type = buf[4];
      const body = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
      try { handle(type, Buffer.from(body)); } catch (e) { channel.write(status(0, 4, e.message)); }
    }
  });

  function status(reqid, code, message) {
    return packet(P.STATUS, Buffer.concat([u32(reqid), u32(code), str(message || ''), str('')]));
  }

  function handle(type, body) {
    if (type === P.INIT) {
      const pairs = [];
      for (const [name, value] of extensions) {
        pairs.push(str(name), str(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'latin1')));
      }
      channel.write(packet(P.VERSION, Buffer.concat([u32(opts.version || 3), ...pairs])));
      return;
    }
    const r = new ext.PacketReader(body, 0);
    const reqid = r.uint32();
    if (type === P.REALPATH) {
      const path = r.string();
      const resolved = path === '.' ? (opts.home || '/home/test') : path;
      channel.write(packet(P.NAME, Buffer.concat([
        u32(reqid), u32(1), str(resolved), str(resolved), u32(0),
      ])));
      return;
    }
    if (type === P.EXTENDED) {
      const name = r.string('latin1');
      received.push({ name, body: body.subarray(r.pos) });
      const handler = handlers[name];
      if (!handler) { channel.write(status(reqid, 8, 'The server does not support the operation.')); return; }
      const reply = handler(new ext.PacketReader(body, r.pos), reqid);
      if (reply === undefined || reply === null) { channel.write(status(reqid, 0, 'OK')); return; }
      if (typeof reply === 'number') { channel.write(status(reqid, reply, 'refused')); return; }
      channel.write(packet(P.EXTENDED_REPLY, Buffer.concat([u32(reqid), reply])));
      return;
    }
    if (type === P.OPEN) {
      const path = r.string();
      channel.write(packet(P.HANDLE, Buffer.concat([u32(reqid), str('h:' + path)])));
      return;
    }
    if (type === P.SYMLINK) {
      // Recorded in wire order, first string then second, with no opinion about
      // which is which — that is precisely what the test is checking.
      received.push({ name: 'SYMLINK', first: r.string(), second: r.string() });
      channel.write(status(reqid, 0, 'OK'));
      return;
    }
    if (type === P.CLOSE || type === P.SETSTAT || type === P.FSETSTAT) {
      channel.write(status(reqid, 0, 'OK'));
      return;
    }
    if (type === P.STAT || type === P.LSTAT) {
      // size + permissions + times, SFTP 3 attribute block
      channel.write(packet(P.ATTRS, Buffer.concat([
        u32(reqid), u32(0x01 | 0x04 | 0x08), u64(11), u32(0o100644), u32(1000), u32(1000),
      ])));
      return;
    }
    channel.write(status(reqid, 8, 'The server does not support the operation.'));
  }
}

/** Connect an adapter to a raw server, with the host key accepted. */
async function connectAdapter(srv, session = {}) {
  const adapter = new SftpAdapter({
    hostName: '127.0.0.1',
    portNumber: srv.port,
    userName: 'test',
    password: 'test',
    timeout: 10,
    ...session,
  }, {
    hostKeyVerifier: () => true,
  });
  const logs = [];
  adapter.on('log', (e) => logs.push(e));
  const info = await adapter.connect();
  return { adapter, info, logs };
}

// ---------------------------------------------------------------- wire codec

test('the SFTP wire codec', async (t) => {
  await t.test('round-trips every field type', () => {
    const w = new ext.PacketWriter();
    w.byte(7).uint32(0xdeadbeef).uint64(0x1_0000_0002).string('naïve').bool(true).raw(Buffer.from([1, 2]));
    const r = new ext.PacketReader(w.toBuffer());
    assert.equal(r.byte(), 7);
    assert.equal(r.uint32(), 0xdeadbeef);
    assert.equal(r.uint64(), 4294967298);
    assert.equal(r.string(), 'naïve');
    assert.equal(r.bool(), true);
    assert.deepEqual([...r.rest()], [1, 2]);
  });

  await t.test('writes a 64-bit value above 2^32 correctly', () => {
    const w = new ext.PacketWriter().uint64(0x1234_5678_9abc);
    assert.equal(w.toBuffer().toString('hex'), '0000123456789abc');
  });

  await t.test('accepts a BigInt for a value beyond exact double precision', () => {
    const w = new ext.PacketWriter().uint64(2n ** 63n + 5n);
    assert.equal(w.toBuffer().readBigUInt64BE(0), 2n ** 63n + 5n);
  });

  await t.test('refuses a truncated reply instead of returning nonsense', () => {
    const r = new ext.PacketReader(Buffer.from([0, 0, 0, 5, 1, 2]));
    assert.throws(() => r.string(), /ended early/);
  });

  await t.test('honours the latin1 encoding a non-UTF-8 server needs', () => {
    const w = new ext.PacketWriter().string('café', 'latin1');
    // 4 bytes, not 5: latin1 is one byte per character.
    assert.equal(w.toBuffer().readUInt32BE(0), 4);
  });

  await t.test('displayableStr quotes text and hex-dumps binary', () => {
    assert.equal(ext.displayableStr(Buffer.from('ab\r\n')), '"ab\\r\\n"');
    assert.equal(ext.displayableStr(Buffer.from([0x00, 0xff])), '0x00FF');
    assert.equal(ext.displayableStr(Buffer.from('a"b\\c')), '"a\\"b\\\\c"');
  });
});

// -------------------------------------------------------- server identification

test('server identification', async (t) => {
  await t.test('recognises the servers WinSCP keys its workarounds on', () => {
    assert.equal(ext.detectSshImplementation('OpenSSH_8.9p1 Ubuntu-3'), 'openssh');
    // Sun SSH is an OpenSSH fork and inherits its bugs.
    assert.equal(ext.detectSshImplementation('Sun_SSH_1.1.5'), 'openssh');
    assert.equal(ext.detectSshImplementation('mod_sftp/0.9.8'), 'proftpd');
    assert.equal(ext.detectSshImplementation('5.25 FlowSsh: Bitvise SSH Server (WinSSHD) 6.07'), 'bitvise');
    assert.equal(ext.detectSshImplementation('srtSSHServer_10.00'), 'titan');
    assert.equal(ext.detectSshImplementation('OpenVMS_SSH'), 'openvms');
    assert.equal(ext.detectSshImplementation('CerberusFTPServer_11'), 'cerberus');
    assert.equal(ext.detectSshImplementation('SomethingElse_1.0'), 'unknown');
  });

  await t.test('only matches OpenSSH at the start, not anywhere in the string', () => {
    assert.equal(ext.isOpenSSH('OpenSSH_9.0'), true);
    assert.equal(ext.isOpenSSH('NotReallyOpenSSH_9.0'), false);
  });

  await t.test('identifies the wider vendor list too', () => {
    assert.equal(ext.detectServerVendor('Serv-U_15.1'), 'serv-u');
    assert.equal(ext.detectServerVendor('1.36_sshlib GlobalSCAPE'), 'globalscape');
    assert.equal(ext.detectServerVendor('SSHD-CORE-0.11.0'), 'apache-mina');
    assert.equal(ext.detectServerVendor('1.77 sshlib: Momentum SSH Server'), 'momentum');
    assert.equal(ext.detectServerVendor('Foxit-WAC-Server-3.0'), 'foxit-wac');
  });

  await t.test('refuses to offer a password change to servers that cannot do one', () => {
    // OpenSSH's userauth_passwd and ProFTPD's sftp_auth_password both refuse.
    assert.equal(ext.canChangePassword('openssh'), false);
    assert.equal(ext.canChangePassword('proftpd'), false);
    assert.equal(ext.canChangePassword('bitvise'), true);
  });

  await t.test('reads the ProFTPD major version the link bug depends on', () => {
    assert.equal(ext.proftpdMajorVersion('mod_sftp/0.9.8'), 0);
    assert.equal(ext.proftpdMajorVersion('mod_sftp/1.0.0'), 1);
    assert.equal(ext.proftpdMajorVersion('OpenSSH_9.0'), 0);
  });
});

// ------------------------------------------------------- VERSION negotiation

test('SSH_FXP_VERSION extension parsing', async (t) => {
  const pair = (name, value) => ({ name, value: Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'latin1') });

  await t.test('records the plain flag extensions and their versions', () => {
    const caps = ext.parseServerExtensions([
      pair('statvfs@openssh.com', '2'),
      pair('hardlink@openssh.com', '1'),
      pair('limits@openssh.com', '1'),
      pair('posix-rename@openssh.com', '1'),
    ]);
    assert.equal(caps.statVfsV2, true);
    assert.equal(caps.hardlinkV1, true);
    assert.equal(caps.limitsV1, true);
    assert.equal(ext.supportsExtension(caps, 'posix-rename@openssh.com'), true);
  });

  await t.test('refuses a statvfs or hardlink version it does not implement', () => {
    const caps = ext.parseServerExtensions([
      pair('statvfs@openssh.com', '1'),
      pair('hardlink@openssh.com', '2'),
      pair('limits@openssh.com', '7'),
    ]);
    // Announced, but not at a version we speak — so the capability is off even
    // though the name is present.
    assert.equal(caps.statVfsV2, false);
    assert.equal(caps.hardlinkV1, false);
    assert.equal(caps.limitsV1, false);
    assert.equal(ext.supportsExtension(caps, 'statvfs@openssh.com'), true);
  });

  await t.test('takes the EOL sequence from "newline"', () => {
    const caps = ext.parseServerExtensions([pair('newline', '\n')]);
    assert.equal(caps.eol, '\n');
    assert.equal(caps.eolFromServer, true);
  });

  await t.test('refuses an end-of-line sequence it cannot honour', () => {
    // WinSCP treats this as fatal: a three-byte EOL would corrupt every
    // text-mode transfer silently.
    assert.throws(
      () => ext.parseServerExtensions([pair('newline', '\r\n\r')]),
      /unsupported end-of-line sequence/);
    assert.throws(
      () => ext.parseServerExtensions([pair('newline', '')]),
      /unsupported end-of-line sequence/);
  });

  await t.test('does not let "supported" overwrite "supported2"', () => {
    const supported2 = Buffer.concat([
      u32(0x8f), u32(0), u32(0), u32(0), u32(32768),
      Buffer.from([0, 0]), Buffer.from([0, 0]),
      u32(0),
      u32(1), str('check-file'),
    ]);
    const supported = Buffer.concat([
      u32(0x01), u32(0), u32(0), u32(0), u32(4096), str('space-available'),
    ]);
    const caps = ext.parseServerExtensions([
      pair('supported2', supported2),
      pair('supported', supported),
    ]);
    assert.equal(caps.support.source, 'supported2');
    assert.equal(caps.support.attributeMask, 0x8f);
    assert.equal(caps.support.maxReadSize, 32768);
    // Both lists still contribute to what the server supports…
    assert.equal(ext.supportsExtension(caps, 'check-file'), true);
    // …but the *structure* came from supported2.
    assert.equal(caps.support.extensions.includes('check-file'), true);
  });

  await t.test('accepts "supported" when it arrives alone', () => {
    const supported = Buffer.concat([
      u32(0x85), u32(0), u32(0), u32(0), u32(4096), str('space-available'), str('check-file'),
    ]);
    const caps = ext.parseServerExtensions([pair('supported', supported)]);
    assert.equal(caps.support.source, 'supported');
    assert.deepEqual(caps.support.extensions, ['space-available', 'check-file']);
  });

  await t.test('tolerates a supported2 that stops after the five fixed fields', () => {
    // Revision 07 defined the extension; the block vectors and name lists only
    // arrived in revision 08, so a short value is legal.
    const short = Buffer.concat([u32(1), u32(2), u32(3), u32(4), u32(5)]);
    const caps = ext.parseServerExtensions([pair('supported2', short)]);
    assert.equal(caps.support.loaded, true);
    assert.equal(caps.support.maxReadSize, 5);
    assert.deepEqual(caps.support.extensions, []);
  });

  await t.test('decodes vendor-id, which is binary and would not survive a UTF-8 decode', () => {
    const value = Buffer.concat([str('Acme'), str('Acme SFTP'), str('7.0.5.3'), u64(70005003)]);
    const caps = ext.parseServerExtensions([pair('vendor-id', value)]);
    assert.deepEqual(caps.vendor, {
      vendorName: 'Acme', productName: 'Acme SFTP', productVersion: '7.0.5.3', productBuildNumber: 70005003,
    });
  });

  await t.test('decodes the VanDyke file system roots', () => {
    const value = Buffer.concat([
      u32(1), Buffer.from([0x43, 0x03]),
      u32(1), Buffer.from([0x44, 0x05]),
    ]);
    const caps = ext.parseServerExtensions([pair('fs-roots@vandyke.com', value)]);
    assert.deepEqual(caps.fixedPaths, ['C:', 'D:']);
  });

  await t.test('abandons the whole root list when an entry is malformed', () => {
    // A half-decoded root list would navigate the user to a path that is not
    // there, so WinSCP clears it rather than keeping the good half.
    const value = Buffer.concat([u32(1), Buffer.from([0x43, 0x03]), u32(9), Buffer.from([0x44, 0x05])]);
    const caps = ext.parseServerExtensions([pair('fs-roots@vandyke.com', value)]);
    assert.deepEqual(caps.fixedPaths, ['C:']);
  });

  await t.test('reads "versions" in both VShell\'s spelling and the correct one', () => {
    const vshell = str('3,4,5,6');
    assert.equal(ext.parseServerExtensions([pair('versions', vshell)]).versions, '3,4,5,6');
    assert.equal(ext.parseServerExtensions([pair('versions', '3,4,5,6')]).versions, '3,4,5,6');
  });

  await t.test('reports an unknown extension rather than dropping it silently', () => {
    const caps = ext.parseServerExtensions([pair('something@example.com', 'x')]);
    assert.deepEqual(caps.unknown, ['something@example.com']);
    assert.equal(ext.supportsExtension(caps, 'something@example.com'), true);
  });

  await t.test('reads nothing from the extension block below SFTP 3', () => {
    const caps = ext.parseServerExtensions([pair('statvfs@openssh.com', '2')], { version: 2 });
    assert.deepEqual(caps.names, []);
    assert.equal(caps.statVfsV2, false);
  });

  await t.test('accepts ssh2\'s already-decoded extension object as a fallback', () => {
    const caps = ext.parseServerExtensions({ 'posix-rename@openssh.com': '1', 'statvfs@openssh.com': '2' });
    assert.equal(caps.statVfsV2, true);
    assert.equal(ext.supportsExtension(caps, 'posix-rename@openssh.com'), true);
  });

  await t.test('parses a real VERSION packet body byte for byte', () => {
    const body = Buffer.concat([
      Buffer.from([P.VERSION]), u32(3),
      str('posix-rename@openssh.com'), str('1'),
      str('statvfs@openssh.com'), str('2'),
    ]);
    const parsed = ext.parseVersionPacket(body);
    assert.equal(parsed.version, 3);
    assert.deepEqual(parsed.pairs.map((p) => p.name),
      ['posix-rename@openssh.com', 'statvfs@openssh.com']);
    assert.equal(parsed.pairs[1].value.toString(), '2');
  });
});

// ------------------------------------------------------ capability resolution

test('capability resolution', async (t) => {
  const capsFrom = (names) => ext.parseServerExtensions(
    names.map((n) => ({ name: n, value: Buffer.from(n === 'statvfs@openssh.com' ? '2' : '1') })));

  await t.test('a bare SFTP 3 server can rename and link but not much else', () => {
    const a = ext.resolveCapabilities({ caps: capsFrom([]), version: 3, implementation: 'openssh' });
    assert.equal(a.rename, true);
    assert.equal(a.symbolicLink, true);
    assert.equal(a.hardLink, false);
    assert.equal(a.checkingSpaceAvailable, false);
    assert.equal(a.calculatingChecksum, false);
    assert.equal(a.remoteCopy, false);
    // No "supported" block means no restriction is known, so chmod is offered.
    assert.equal(a.modeChanging, true);
    assert.equal(a.groupOwnerChangingByID, true);
  });

  await t.test('space-available and statvfs each enable free-space reporting', () => {
    assert.equal(ext.resolveCapabilities({ caps: capsFrom(['space-available']), version: 5 }).checkingSpaceAvailable, true);
    assert.equal(ext.resolveCapabilities({ caps: capsFrom(['statvfs@openssh.com']), version: 3 }).checkingSpaceAvailable, true);
  });

  await t.test('VShell\'s "check-file-name" counts as a checksum offer', () => {
    // The specification says the *extension* is "check-file"; VShell 4.0.3
    // announces the request name instead, and rejecting it would lose
    // checksums on every VShell server.
    assert.equal(ext.resolveCapabilities({ caps: capsFrom(['check-file-name']), version: 5 }).calculatingChecksum, true);
    assert.equal(ext.resolveCapabilities({ caps: capsFrom(['check-file']), version: 5 }).calculatingChecksum, true);
  });

  await t.test('Bitvise gets the capabilities it never advertises', () => {
    const a = ext.resolveCapabilities({ caps: capsFrom([]), version: 3, implementation: 'bitvise' });
    assert.equal(a.checkingSpaceAvailable, true);
    assert.equal(a.calculatingChecksum, true);
    assert.equal(a.remoteCopy, true);
    assert.equal(a.loadingAdditionalProperties, true);
    // …and nobody else does.
    const other = ext.resolveCapabilities({ caps: capsFrom([]), version: 3, implementation: 'titan' });
    assert.equal(other.checkingSpaceAvailable, false);
    assert.equal(other.loadingAdditionalProperties, false);
  });

  await t.test('an encrypted site loses the capabilities encryption breaks', () => {
    const a = ext.resolveCapabilities({ caps: capsFrom(['check-file']), version: 5, encrypting: true });
    // A symlink target and a checksum would both have to be in clear.
    assert.equal(a.symbolicLink, false);
    assert.equal(a.resolveSymlink, false);
    assert.equal(a.calculatingChecksum, false);
    assert.equal(a.textMode, false);
  });

  await t.test('a "supported" block that omits permissions withdraws chmod', () => {
    const supported = Buffer.concat([u32(0x01), u32(0), u32(0), u32(0), u32(4096)]);
    const caps = ext.parseServerExtensions([{ name: 'supported', value: supported }]);
    const a = ext.resolveCapabilities({ caps, version: 5 });
    assert.equal(a.modeChanging, false);
    assert.equal(a.ownerChanging, false);
    assert.equal(a.loadingAdditionalProperties, false);
  });

  await t.test('hard links come from either SFTP 6 or the OpenSSH extension', () => {
    assert.equal(ext.resolveCapabilities({ caps: capsFrom([]), version: 6 }).hardLink, true);
    assert.equal(ext.resolveCapabilities({ caps: capsFrom(['hardlink@openssh.com']), version: 3 }).hardLink, true);
  });

  await t.test('text mode is offered when the server\'s EOL differs from ours', () => {
    const caps = ext.parseServerExtensions([{ name: 'newline', value: Buffer.from('\n') }]);
    assert.equal(ext.resolveCapabilities({ caps, version: 3, localEol: '\r\n' }).textMode, true);
    const same = ext.parseServerExtensions([{ name: 'newline', value: Buffer.from('\r\n') }]);
    assert.equal(ext.resolveCapabilities({ caps: same, version: 3, localEol: '\r\n' }).textMode, false);
  });
});

// ---------------------------------------------------------- the bug matrix

test('the broken-server workaround matrix', async (t) => {
  await t.test('signed timestamps are assumed below SFTP 4 and never above it', () => {
    assert.equal(ext.resolveSftpBugs({ version: 3, implementation: 'openssh' }).signedTimestamps, true);
    assert.equal(ext.resolveSftpBugs({ version: 4, implementation: 'openssh' }).signedTimestamps, false);
    assert.equal(ext.resolveSftpBugs({ version: 3, bugs: { signedTS: 'off' } }).signedTimestamps, false);
    assert.equal(ext.resolveSftpBugs({ version: 4, bugs: { signedTS: 'on' } }).signedTimestamps, false);
  });

  await t.test('the symlink argument order follows the server, not the specification', () => {
    const at = (implementation, version, ident) => ext.resolveSftpBugs({ implementation, version, ident })
      .symlinkArgumentOrderReversed;
    assert.equal(at('openssh', 3), true);
    assert.equal(at('proftpd', 3, 'mod_sftp/0.9.8'), true);
    assert.equal(at('bitvise', 3), false);
    assert.equal(at('titan', 3), false);
    // SSH_FXP_LINK got the order right — except in ProFTPD 0.x, which followed
    // the bug into its LINK implementation too (proftpd bug 4080).
    assert.equal(at('openssh', 6), false);
    assert.equal(at('proftpd', 6, 'mod_sftp/0.9.8'), true);
    assert.equal(at('proftpd', 6, 'mod_sftp/1.0.0'), false);
  });

  await t.test('the symlink workaround can be forced on or off by the site', () => {
    assert.equal(ext.resolveSftpBugs({ implementation: 'titan', version: 3, bugs: { symlink: 'on' } })
      .symlinkArgumentOrderReversed, true);
    assert.equal(ext.resolveSftpBugs({ implementation: 'openssh', version: 3, bugs: { symlink: 'off' } })
      .symlinkArgumentOrderReversed, false);
  });

  await t.test('the hardlink extension is always "reversed", by definition', () => {
    // It was specified that way on purpose, to mirror the symlink bug.
    assert.equal(ext.resolveSftpBugs({ implementation: 'titan', version: 3 }).hardlinkArgumentOrderReversed, true);
  });

  await t.test('ProFTPD gets the realpath control byte it can actually read', () => {
    assert.equal(ext.realPathControlByte(6, 'proftpd'), ext.REALPATH_STAT_IF);
    assert.equal(ext.realPathControlByte(6, 'openssh'), ext.REALPATH_STAT_ALWAYS);
    assert.equal(ext.realPathControlByte(3, 'proftpd'), null);
  });

  await t.test('Foxit is the one server told not to use UTF-8', () => {
    assert.equal(ext.resolveUtfMode({ ident: 'Foxit-WAC-Server-3.0', version: 3 }).mode, 'off');
    assert.equal(ext.resolveUtfMode({ ident: 'OpenSSH_9.0', version: 3 }).mode, 'auto');
    assert.equal(ext.resolveUtfMode({ ident: 'OpenSSH_9.0', version: 4 }).mode, 'on');
    assert.equal(ext.resolveUtfMode({ ident: 'OpenSSH_9.0', version: 3, notUtf: 'on' }).mode, 'off');
    assert.equal(ext.resolveUtfMode({ ident: 'OpenSSH_9.0', version: 3, notUtf: 'off' }).mode, 'on');
  });

  await t.test('the auto UTF-8 mode turns itself off on the first invalid string', () => {
    assert.equal(ext.detectUtf8(Buffer.from('naïve', 'utf8')), 'utf8');
    assert.equal(ext.detectUtf8(Buffer.from('naïve', 'latin1')), 'ansi');
    // Pure ASCII proves nothing and must not flip the switch.
    assert.equal(ext.detectUtf8(Buffer.from('plain')), 'utf8');
  });

  await t.test('the packet ceiling comes from the server that needs one', () => {
    assert.equal(ext.resolveMaxPacketSize({ configured: 1234 }).size, 1234);
    assert.equal(ext.resolveMaxPacketSize({ limits: { maxPacketLength: 100 } }).size, 104);
    assert.equal(ext.resolveMaxPacketSize({ implementation: 'openssh', version: 3, supportLoaded: false }).size,
      4 + 256 * 1024);
    // A server that sent a "supported" block is not the old sftp-server.
    assert.equal(ext.resolveMaxPacketSize({ implementation: 'openssh', version: 3, supportLoaded: true }).size, 0);
    assert.equal(ext.resolveMaxPacketSize({ ident: '1.77 sshlib: Momentum SSH Server' }).size, 4 + 32 * 1024);
    assert.equal(ext.resolveMaxPacketSize({ implementation: 'titan', version: 3 }).size, 0);
  });

  await t.test('only well-known servers are asked for SFTP 6', () => {
    assert.equal(ext.resolveMaxSftpVersion(undefined, 'openssh'), 6);
    assert.equal(ext.resolveMaxSftpVersion(undefined, 'proftpd'), 6);
    assert.equal(ext.resolveMaxSftpVersion(undefined, 'bitvise'), 6);
    assert.equal(ext.resolveMaxSftpVersion(undefined, 'titan'), 3);
    assert.equal(ext.resolveMaxSftpVersion(-1, 'unknown'), 3);
    assert.equal(ext.resolveMaxSftpVersion(4, 'unknown'), 4);
    assert.equal(ext.resolveMaxSftpVersion(99, 'openssh'), 6);
  });

  await t.test('a version outside the supported range is refused outright', () => {
    assert.equal(ext.checkNegotiatedVersion(3), 3);
    assert.throws(() => ext.checkNegotiatedVersion(7), /not supported.*0 to 6/s);
    assert.throws(() => ext.checkNegotiatedVersion(-1), /not supported/);
  });

  await t.test('the signed-timestamp reading really changes the date', () => {
    // 0xFFFFFFFE unsigned is a day in 2106; read signed it is two seconds
    // before 1970, which is what the server actually meant.
    assert.equal(signedSeconds(4294967294), -2);
    assert.equal(signedSeconds(2147483648), -2147483648);
    // Everything inside the positive 32-bit range is untouched.
    assert.equal(signedSeconds(1700000000), 1700000000);
    assert.equal(signedSeconds(0), 0);
    // A value beyond 32 bits came from a version 4+ 64-bit field and is not a
    // wrapped negative at all.
    assert.equal(signedSeconds(4294967296 + 5), 4294967301);
  });

  await t.test('the adapter applies the reading only when the workaround is on', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.bugs.signedTimestamps, true, 'SFTP 3 assumes signed timestamps');
      assert.equal(adapter._seconds(4294967294), -2);
      adapter.bugs.signedTimestamps = false;
      assert.equal(adapter._seconds(4294967294), 4294967294);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('the server packet ceiling becomes the streaming packet size', async () => {
    const srv = await startRawSftpServer({
      extensions: [['limits@openssh.com', '1']],
      handlers: { 'limits@openssh.com': () => Buffer.concat([u64(32768), u64(1), u64(1), u64(1)]) },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter._packetSize(), 32768 + 4);
      // The site's own setting still wins over the server's ceiling.
      adapter.session.sftpMaxPacketSize = 4096;
      assert.equal(adapter._packetSize(), 4096);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('every active workaround names the server it exists for', () => {
    const bugs = ext.resolveSftpBugs({ implementation: 'openssh', ident: 'OpenSSH_9.0', version: 3 });
    assert.ok(bugs.active.length > 0);
    for (const entry of bugs.active) {
      assert.ok(entry.server && entry.workaround, `${entry.id} must name its server and workaround`);
    }
    assert.ok(bugs.active.some((b) => b.id === 'signedTimestamps'));
  });
});

// ------------------------------------------------- extended requests, on the wire

test('SFTP extended requests against a real server', async (t) => {
  await t.test('statvfs@openssh.com reports free space from a server that offers it', async () => {
    const srv = await startRawSftpServer({
      extensions: [['statvfs@openssh.com', '2']],
      handlers: {
        'statvfs@openssh.com': () => Buffer.concat([
          u64(4096), u64(4096), u64(1000), u64(400), u64(300),
          u64(64), u64(60), u64(55), u64(0x1234), u64(1), u64(255),
        ]),
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      // The capability is genuinely available now, not permanently false.
      assert.equal(adapter.caps.spaceInfo, true);
      const space = await adapter.spaceInfo('/');
      assert.equal(space.source, 'statvfs@openssh.com');
      assert.equal(space.total, 4096 * 1000);
      assert.equal(space.free, 4096 * 300);
      assert.equal(space.used, 4096 * 600);
      assert.equal(space.files, 64);
      assert.equal(space.readOnly, true);   // f_flag bit 1 is ST_RDONLY
      assert.equal(space.nameMax, 255);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('space-available is preferred over statvfs when both are offered', async () => {
    const srv = await startRawSftpServer({
      extensions: [['space-available', ''], ['statvfs@openssh.com', '2']],
      handlers: {
        'space-available': () => Buffer.concat([u64(900), u64(500), u64(700), u64(400), u32(512)]),
        'statvfs@openssh.com': () => { throw new Error('statvfs should not have been used'); },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const space = await adapter.spaceInfo('/data');
      assert.equal(space.source, 'space-available');
      assert.equal(space.total, 900);
      assert.equal(space.free, 400);
      assert.equal(space.blockSize, 512);
      assert.deepEqual(srv.received.map((r) => r.name), ['space-available']);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('space-available tolerates ProFTPD\'s 16-bit allocation unit', async () => {
    const srv = await startRawSftpServer({
      extensions: [['space-available', '']],
      handlers: {
        // proftpd bug 4079: the field is two bytes, not four.
        'space-available': () => Buffer.concat([u64(1), u64(2), u64(3), u64(4), Buffer.from([0x02, 0x00])]),
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const space = await adapter.spaceInfo('/');
      assert.equal(space.blockSize, 512);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('space-available tolerates the field being absent entirely', async () => {
    const srv = await startRawSftpServer({
      extensions: [['space-available', '']],
      handlers: { 'space-available': () => Buffer.concat([u64(1), u64(2), u64(3), u64(4)]) },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const space = await adapter.spaceInfo('/');
      assert.equal(space.blockSize, 0);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('hardlink@openssh.com creates the link, existing path first', async () => {
    const srv = await startRawSftpServer({
      extensions: [['hardlink@openssh.com', '1']],
      handlers: { 'hardlink@openssh.com': () => null },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.caps.hardlink, true);
      await adapter.hardlink('/a/original', '/a/link');
      const req = srv.received.find((r) => r.name === 'hardlink@openssh.com');
      const r = new ext.PacketReader(req.body);
      assert.equal(r.string(), '/a/original');
      assert.equal(r.string(), '/a/link');
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('hardlink is refused when the server never offered it', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.caps.hardlink, false);
      await assert.rejects(() => adapter.hardlink('/a', '/b'), /does not offer hard links/);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('posix-rename@openssh.com is used when the site asks for it', async () => {
    const srv = await startRawSftpServer({
      extensions: [['posix-rename@openssh.com', '1']],
      handlers: { 'posix-rename@openssh.com': () => null },
    });
    try {
      const { adapter, info } = await connectAdapter(srv, { usePosixRename: true });
      assert.equal(info.posixRename, true);
      await adapter.rename('/a/one', '/a/two');
      const req = srv.received.find((r) => r.name === 'posix-rename@openssh.com');
      const r = new ext.PacketReader(req.body);
      assert.equal(r.string(), '/a/one');
      assert.equal(r.string(), '/a/two');
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('limits@openssh.com is asked for and caps the packet size', async () => {
    const srv = await startRawSftpServer({
      extensions: [['limits@openssh.com', '1']],
      handlers: {
        'limits@openssh.com': () => Buffer.concat([u64(65536), u64(32768), u64(32768), u64(64)]),
      },
    });
    try {
      const { adapter, info } = await connectAdapter(srv);
      assert.deepEqual(info.limits, {
        maxPacketLength: 65536, maxReadLength: 32768, maxWriteLength: 32768, maxOpenHandles: 64,
      });
      assert.equal(info.maxPacketSize, 65536 + 4);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('check-file returns a real checksum without needing shell access', async () => {
    const digest = require('crypto').createHash('sha256').update('hello world').digest();
    const srv = await startRawSftpServer({
      extensions: [['check-file', '']],
      handlers: {
        'check-file-name': (r) => {
          const path = r.string();
          const algs = r.string('latin1');
          assert.equal(path, '/data/file.txt');
          assert.equal(algs, 'sha256');
          assert.equal(r.uint64(), 0);      // start offset
          assert.equal(r.uint64(), 0);      // length: to the end
          assert.equal(r.uint32(), 0);      // block size: one hash
          return Buffer.concat([str('sha256'), digest]);
        },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.serverAbilities.calculatingChecksum, true);
      const hash = await adapter.checksum('/data/file.txt', 'sha256');
      assert.equal(hash, digest.toString('hex'));
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('a blocked check-file reply is split into per-block hashes', async () => {
    const a = Buffer.alloc(20, 1);
    const b = Buffer.alloc(20, 2);
    const srv = await startRawSftpServer({
      extensions: [['check-file', '']],
      handlers: { 'check-file-name': () => Buffer.concat([str('sha1'), a, b]) },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const res = await adapter.ext.checkFile('/f', { algorithms: ['sha-1'], blockSize: 4096 });
      assert.equal(res.algorithm, 'sha1');
      assert.deepEqual(res.blocks, [a.toString('hex'), b.toString('hex')]);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('a server that answers check-file with OP_UNSUPPORTED falls through', async () => {
    const srv = await startRawSftpServer({
      extensions: [['check-file', '']],
      // Advertised but not implemented — exactly what an over-eager
      // announcement looks like from the client side.
      handlers: { 'check-file-name': () => 8 },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      // An SFTP-only account, which is the case the extension exists for: the
      // honest answer is a refusal that names the reason, not a wrong checksum.
      adapter.caps.exec = false;
      await assert.rejects(() => adapter.checksum('/f', 'sha256'),
        /offers no checksum extension and this account has no shell access/);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('md5-hash is used for md5 when check-file is absent', async () => {
    const digest = require('crypto').createHash('md5').update('x').digest();
    const srv = await startRawSftpServer({
      extensions: [['md5-hash', '']],
      handlers: {
        'md5-hash': (r) => {
          assert.equal(r.string(), '/f');
          assert.equal(r.uint64(), 0);
          assert.equal(r.uint64(), 0);
          assert.equal(r.bytes().length, 0);   // no quick-check hash
          return Buffer.concat([str('md5-hash'), str(digest)]);
        },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const res = await adapter.ext.md5Hash('/f');
      assert.equal(res.hex, digest.toString('hex'));
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('fsync@openssh.com flushes an open handle', async () => {
    let seen = null;
    const srv = await startRawSftpServer({
      extensions: [['fsync@openssh.com', '1']],
      handlers: { 'fsync@openssh.com': (r) => { seen = r.string(); return null; } },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      await adapter.fsync('handle-1');
      assert.equal(seen, 'handle-1');
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('copy-file copies on the server without moving bytes to the client', async () => {
    let args = null;
    const srv = await startRawSftpServer({
      extensions: [['copy-file', '']],
      handlers: {
        'copy-file': (r) => { args = [r.string(), r.string(), r.bool()]; return null; },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.caps.copyRemote, true);
      await adapter.copyRemote('/a', '/b');
      assert.deepEqual(args, ['/a', '/b', false]);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('copy-data opens both files and copies between the handles', async () => {
    let args = null;
    const srv = await startRawSftpServer({
      extensions: [['copy-data', '']],
      handlers: {
        'copy-data': (r) => {
          args = { read: r.string(), readOffset: r.uint64(), length: r.uint64(), write: r.string(), writeOffset: r.uint64() };
          return null;
        },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      await adapter.copyRemote('/src', '/dst');
      assert.equal(args.read, 'h:/src');
      assert.equal(args.write, 'h:/dst');
      assert.equal(args.length, 0);       // 0 means "to the end of the source"
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('lsetstat@openssh.com sets a link\'s own attributes, not its target\'s', async () => {
    let seen = null;
    const srv = await startRawSftpServer({
      extensions: [['lsetstat@openssh.com', '1']],
      handlers: {
        'lsetstat@openssh.com': (r) => {
          const path = r.string();
          const flags = r.uint32();
          const mode = (flags & 0x04) ? r.uint32() : null;
          const atime = (flags & 0x08) ? r.uint32() : null;
          const mtime = (flags & 0x08) ? r.uint32() : null;
          seen = { path, flags, mode, atime, mtime };
          assert.equal(r.remaining, 0, 'the attribute block must contain exactly what its flags claim');
          return null;
        },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      await adapter.ext.lsetstat('/a/link', { mode: 0o644, mtime: 1700000000 });
      assert.equal(seen.path, '/a/link');
      assert.equal(seen.mode, 0o644);
      // Version 3 has one flag for both times, so an mtime-only request still
      // sends an atime — the mtime, so nothing is silently zeroed.
      assert.equal(seen.mtime, 1700000000);
      assert.equal(seen.atime, 1700000000);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('owner-group-query lists the names the server will accept', async () => {
    const srv = await startRawSftpServer({
      extensions: [['owner-group-query@generic-extensions', '']],
      handlers: {
        'owner-group-query@generic-extensions': (r) => {
          const which = r.byte();
          const names = which === 1 ? ['root', 'alice'] : ['wheel'];
          return Buffer.concat([
            str('owner-group-query-reply@generic-extensions'),
            u32(names.length), ...names.map((n) => str(n)),
          ]);
        },
      },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const lists = await adapter.listUsersGroups();
      assert.deepEqual(lists, { owners: ['root', 'alice'], groups: ['wheel'] });
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('an extension the server never announced is refused, not sent', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const { adapter } = await connectAdapter(srv);
      await assert.rejects(() => adapter.ext.posixRename('/a', '/b'), /does not offer/);
      await assert.rejects(() => adapter.ext.spaceAvailable('/'), /does not offer/);
      assert.deepEqual(srv.received, []);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('Bitvise is asked anyway, because it announces nothing', async () => {
    const srv = await startRawSftpServer({
      extensions: [],
      handlers: { 'space-available': () => Buffer.concat([u64(10), u64(5), u64(8), u64(4), u32(1)]) },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      // The real server is not Bitvise, so pretend for the capability decision
      // the way the identification string would.
      adapter.implementation = 'bitvise';
      adapter.ext.implementation = 'bitvise';
      adapter.caps.spaceInfo = true;
      const space = await adapter.spaceInfo('/');
      assert.equal(space.total, 10);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('a server error is reported with WinSCP\'s message for that status code', async () => {
    const srv = await startRawSftpServer({
      extensions: [['posix-rename@openssh.com', '1']],
      handlers: { 'posix-rename@openssh.com': () => 4 },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      await assert.rejects(() => adapter.ext.posixRename('/a', '/b'), (e) => {
        assert.match(e.message, /General failure/);
        assert.match(e.message, /Error code: 4/);
        // Error 4 is the one WinSCP explains, because on its own it says nothing.
        assert.match(e.message, /Renaming a file to a name of already existing file/);
        assert.equal(e.code, 4);
        return true;
      });
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('an outstanding request is rejected when the channel goes away', async () => {
    const srv = await startRawSftpServer({
      extensions: [['statvfs@openssh.com', '2']],
      // Never answers: the request has to be ended by the disconnect, not hang.
      handlers: { 'statvfs@openssh.com': () => new Promise(() => {}) },
    });
    try {
      const { adapter } = await connectAdapter(srv);
      const pending = adapter.ext.statvfs('/');
      const guard = pending.then(() => 'resolved', (e) => e.message);
      setTimeout(() => { adapter.disconnect(); }, 50);
      const message = await guard;
      assert.match(String(message), /closed|ended|No response/i);
    } finally { await srv.close(); }
  });

  await t.test('the whole negotiation is reported in serverInfo', async () => {
    const supported2 = Buffer.concat([
      u32(0x85), u32(0), u32(0), u32(0), u32(32768),
      Buffer.from([0, 0]), Buffer.from([0, 0]), u32(0), u32(1), str('check-file'),
    ]);
    const srv = await startRawSftpServer({
      extensions: [
        ['supported2', supported2],
        ['newline', '\n'],
        ['vendor-id', Buffer.concat([str('Acme'), str('Acme SFTP'), str('1.0'), u64(7)])],
        ['posix-rename@openssh.com', '1'],
      ],
    });
    try {
      const { adapter, info } = await connectAdapter(srv);
      assert.equal(info.sftpVersion, 3);
      assert.equal(info.eol, '\n');
      assert.deepEqual(info.software, {
        vendorName: 'Acme', productName: 'Acme SFTP', productVersion: '1.0', productBuildNumber: 7,
      });
      assert.equal(info.abilities.calculatingChecksum, true);
      assert.equal(info.extendedRequests, true, 'the raw extended-request path must be available');
      assert.ok(info.workarounds.length > 0);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('the raw VERSION bytes are captured, not ssh2\'s lossy decode', async () => {
    // A vendor-id value contains a 64-bit integer; UTF-8-decoding it destroys
    // the bytes, so recovering the product name at all proves the raw capture.
    const value = Buffer.concat([str('V'), str('P'), str('1'), u64(0xdeadbeef)]);
    const srv = await startRawSftpServer({ extensions: [['vendor-id', value]] });
    try {
      const { adapter } = await connectAdapter(srv);
      assert.equal(adapter.serverCaps.vendor.productBuildNumber, 0xdeadbeef);
      // ssh2's own copy really is damaged, which is why the capture exists.
      const lossy = ext.parseServerExtensions(adapter.sftp._extensions);
      assert.notDeepEqual(lossy.vendor, adapter.serverCaps.vendor);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------ checksum algorithms

test('checksum algorithm names', async (t) => {
  await t.test('maps the UI names onto the wire names', () => {
    assert.equal(ext.checksumAlgToWire('sha-256'), 'sha256');
    assert.equal(ext.checksumAlgToWire('SHA-1'), 'sha1');
    assert.equal(ext.checksumAlgToWire('md5'), 'md5');
    assert.equal(ext.checksumAlgToWire('crc32'), 'crc32');
    // An unknown name is passed through, so a private algorithm still works.
    assert.equal(ext.checksumAlgToWire('blake3'), 'blake3');
  });

  await t.test('offers the full list in WinSCP\'s order, MD5 behind the SHA family', () => {
    const list = ext.normalizeChecksumAlgorithms().split(',');
    assert.deepEqual(list, ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'md5', 'crc32']);
    assert.ok(list.indexOf('md5') > list.indexOf('sha512'));
  });

  await t.test('de-duplicates and normalises a caller-supplied list', () => {
    assert.equal(ext.normalizeChecksumAlgorithms(['sha-256', 'sha256', ' md5 ']), 'sha256,md5');
  });

  await t.test('knows the hash lengths a blocked reply is split by', () => {
    assert.equal(ext.hashLength('sha256'), 32);
    assert.equal(ext.hashLength('md5'), 16);
    assert.equal(ext.hashLength('crc32'), 4);
    assert.equal(ext.hashLength('unknown'), 0);
  });
});

test('the SFTP 3 attribute block', async (t) => {
  await t.test('sends exactly the fields its flag word claims', () => {
    const w = new ext.PacketWriter();
    const flags = ext.writeAttributes(w, { mode: 0o755 });
    assert.equal(flags, 0x04);
    // Four bytes of flags plus four of mode, and nothing else — a stray field
    // would push every following byte of the packet out of place.
    assert.equal(w.toBuffer().length, 8);
  });

  await t.test('sends both times when only one was asked for', () => {
    const w = new ext.PacketWriter();
    ext.writeAttributes(w, { atime: 5 });
    const r = new ext.PacketReader(w.toBuffer());
    assert.equal(r.uint32(), 0x08);
    assert.equal(r.uint32(), 5);
    assert.equal(r.uint32(), 5);
  });

  await t.test('omits the owner pair unless both halves are given', () => {
    const w = new ext.PacketWriter();
    // A uid with no gid cannot be encoded, and guessing one would change the
    // file's group behind the user's back.
    assert.equal(ext.writeAttributes(w, { uid: 1000 }), 0);
    const both = new ext.PacketWriter();
    assert.equal(ext.writeAttributes(both, { uid: 1000, gid: 100 }), 0x02);
  });

  await t.test('writes the fields in the protocol\'s fixed order', () => {
    const w = new ext.PacketWriter();
    ext.writeAttributes(w, { size: 9, uid: 1, gid: 2, mode: 0o600, mtime: 7, atime: 6 });
    const r = new ext.PacketReader(w.toBuffer());
    assert.equal(r.uint32(), 0x01 | 0x02 | 0x04 | 0x08);
    assert.equal(r.uint64(), 9);
    assert.equal(r.uint32(), 1);
    assert.equal(r.uint32(), 2);
    assert.equal(r.uint32(), 0o600);
    assert.equal(r.uint32(), 6);
    assert.equal(r.uint32(), 7);
    assert.equal(r.remaining, 0);
  });
});

// --------------------------------------------------- SecureShell classification

test('SSH error classification', async (t) => {
  await t.test('translates PuTTY\'s network messages into WinSCP\'s', () => {
    const c = ext.classifySshError('Network error: Connection refused', { hostName: 'example.org' });
    assert.equal(c.kind, 'network');
    assert.equal(c.key, 'refused');
    assert.match(c.message, /Connection to "example\.org" refused/);
    assert.equal(c.retriable, true);
    // Only a failure that means "the SSH port never answered" justifies the
    // FTP suggestion; probing otherwise would knock on a stranger's door.
    assert.equal(c.suggestFtp, true);
  });

  await t.test('only the first four network errors suggest FTP', () => {
    for (const [msg, expected] of [
      ['Remote side unexpectedly closed network connection', true],
      ['Network error: Connection refused', true],
      ['Network error: Connection reset by peer', true],
      ['Network error: Connection timed out', true],
      ['Network error: No route to host', false],
      ['Network error: Software caused connection abort', false],
      ['Host does not exist', false],
      ['Incoming packet was garbled on decryption', false],
    ]) {
      assert.equal(ext.classifySshError(msg).suggestFtp, expected, msg);
    }
  });

  await t.test('a garbled packet is fatal and not worth retrying', () => {
    const c = ext.classifySshError('Incoming packet was garbled on decryption');
    assert.equal(c.kind, 'protocol');
    assert.equal(c.retriable, false);
    assert.equal(c.fatal, true);
  });

  await t.test('a rejected credential stops the retry loop', () => {
    for (const msg of [
      'All configured authentication methods failed',
      'No supported authentication methods available (server sent: publickey)',
      'Access denied',
      'Server refused our key',
      'Wrong passphrase',
    ]) {
      const c = ext.classifySshError(msg);
      assert.equal(c.kind, 'authentication', msg);
      assert.equal(c.authenticationHopeless, true, msg);
      // Retrying the same credentials produces the same answer, and on a server
      // that counts failures it locks the account.
      assert.equal(c.retriable, false, msg);
    }
  });

  await t.test('classifies Node\'s own socket errors the same way', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:22'), { code: 'ECONNREFUSED' });
    assert.equal(ext.classifySshError(refused, { hostName: 'h' }).key, 'refused');
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
    const c = ext.classifySshError(dns, { hostName: 'nope' });
    assert.equal(c.key, 'hostNotExist');
    // A name that does not resolve will not resolve on a retry either.
    assert.equal(c.retriable, false);
  });

  await t.test('an error arriving while closing is logged and dropped', () => {
    const c = ext.classifySshError('Remote side unexpectedly closed network connection', { closing: true });
    assert.equal(c.ignored, true);
    assert.equal(c.fatal, false);
    assert.match(c.message, /Ignoring an error from the server while closing/);
  });

  await t.test('distinguishes "wrong password" from "no password given"', () => {
    const tried = ext.connectionClosedMessage({ exitCode: 0, cancelled: true, storedCredentialsTried: true });
    assert.equal(tried.message, 'Authentication failed.');
    assert.equal(tried.authenticationHopeless, true);
    const untried = ext.connectionClosedMessage({ exitCode: 0, cancelled: true, storedCredentialsTried: false });
    assert.equal(untried.message, 'Credentials were not specified.');
    assert.equal(untried.authenticationHopeless, false);
    // The zero exit code came from us, not the server, so it is not reported.
    assert.equal(tried.exitCode, -1);
  });

  await t.test('a real server exit code is reported with the message', () => {
    const c = ext.connectionClosedMessage({ exitCode: 255 });
    assert.match(c.message, /unexpectedly closed.*exit status 255/s);
  });

  await t.test('the PuTTY message translator handles its wildcard exactly', () => {
    const table = [
      { key: 'user', original: 'Using username "%".', translation: 'Using username "%s".' },
      { key: 'plain', original: 'Access denied', translation: 'Access denied.' },
    ];
    assert.equal(ext.translatePuttyMessage(table, 'Using username "bob".').message, 'Using username "bob".');
    assert.equal(ext.translatePuttyMessage(table, 'Access denied').message, 'Access denied.');
    // The wildcard may capture nothing at all, which is why the length test is
    // `>= length - 1` rather than `>= length`.
    assert.equal(ext.translatePuttyMessage(table, 'Using username "".').captured, '');
    assert.equal(ext.translatePuttyMessage(table, 'Access granted'), null);
  });

  await t.test('the wildcard capture is right-trimmed, as PuTTY\'s is', () => {
    const table = [{ key: 'k', original: 'Authenticating with public key "%"', translation: 'Authenticating with public key "%s".' }];
    assert.equal(ext.translatePuttyMessage(table, 'Authenticating with public key "id  "').captured, 'id');
  });
});

test('the FTP suggestion', async (t) => {
  const failure = ext.classifySshError('Network error: Connection refused');

  await t.test('is offered for a plain SFTP session on the standard port', () => {
    const r = ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 22 }, failure);
    assert.equal(r.suggest, true);
    assert.match(r.message, /listens for FTP connections/);
  });

  await t.test('is refused for anything that would knock on the wrong door', () => {
    // A non-standard port, a tunnel or a proxy all mean port 21 on this host is
    // not the machine the user was trying to reach.
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 2222 }, failure).suggest, false);
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 22, tunnel: true }, failure).suggest, false);
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 22, proxyMethod: 'socks5' }, failure).suggest, false);
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'scp', portNumber: 22 }, failure).suggest, false);
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 22 }, failure, { tryFtpWhenSshFails: false }).suggest, false);
  });

  await t.test('is refused when the port answered and something else went wrong', () => {
    const other = ext.classifySshError('Incoming packet was garbled on decryption');
    assert.equal(ext.shouldSuggestFtp({ fsProtocol: 'sftp', portNumber: 22 }, other).suggest, false);
  });
});

// ------------------------------------------------------------------ banners

test('the server banner', async (t) => {
  await t.test('hashes the banner the way WinSCP stores it', () => {
    // MD5 over UTF-16LE, so a hash written by WinSCP describes the same banner.
    const expected = require('crypto').createHash('md5')
      .update(Buffer.from('Welcome', 'utf16le')).digest('hex').toUpperCase();
    assert.equal(ext.bannerHash('Welcome'), expected);
  });

  await t.test('shows a banner once and then respects "never show again"', () => {
    const policy = new ext.BannerPolicy();
    assert.equal(policy.shouldShow('site', 'Welcome'), true);
    policy.neverShow('site', 'Welcome');
    assert.equal(policy.shouldShow('site', 'Welcome'), false);
    // A *changed* banner is new information and is shown again.
    assert.equal(policy.shouldShow('site', 'Welcome, and note the maintenance window'), true);
  });

  await t.test('never shows a banner that is only whitespace', () => {
    // PuTTY calls back with a bare CRLF when the real banner had none; an empty
    // dialog is worse than no dialog.
    const policy = new ext.BannerPolicy();
    assert.equal(policy.shouldShow('site', '\r\n'), false);
    assert.equal(policy.shouldShow('site', '   '), false);
    assert.equal(policy.shouldShow('site', ''), false);
  });

  await t.test('forceBanners overrides a stored dismissal', () => {
    const store = new Map();
    const backing = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    new ext.BannerPolicy(backing).neverShow('site', 'Welcome');
    assert.equal(new ext.BannerPolicy(backing, { forceBanners: true }).shouldShow('site', 'Welcome'), true);
  });

  await t.test('keeps the per-site parameters beside the hash', () => {
    const policy = new ext.BannerPolicy();
    policy.neverShow('site', 'Welcome');
    policy.setParams('site', 3);
    assert.equal(policy.params('site'), 3);
    assert.equal(policy.shouldShow('site', 'Welcome'), false);
  });
});

// ------------------------------------------------------- host key preferences

test('host key algorithm preference', async (t) => {
  await t.test('follows the site\'s own order', () => {
    const r = ext.resolveHostKeyOrder(['rsa', 'ed25519', 'ecdsa', 'WARN', 'dsa']);
    assert.equal(r.list[0], 'rsa-sha2-512');
    assert.ok(r.list.indexOf('ssh-ed25519') < r.list.indexOf('ecdsa-sha2-nistp256'));
    assert.deepEqual(r.belowWarnThreshold, ['ssh-dss']);
  });

  await t.test('offers an algorithm we already hold a key for first', () => {
    // Otherwise a server with several key types can pick one we have never
    // seen, and the user is asked to verify a fingerprint for a host they
    // already trust.
    const r = ext.resolveHostKeyOrder(['ed448', 'ed25519', 'ecdsa', 'rsa'], {
      hasCachedKey: (alg) => alg === 'ssh-rsa',
    });
    assert.equal(r.list[0], 'ssh-rsa');
    assert.ok(r.list.includes('ssh-ed25519'));
  });

  await t.test('does not reorder when the preference is turned off', () => {
    const r = ext.resolveHostKeyOrder(['ed25519', 'rsa'], {
      hasCachedKey: (alg) => alg === 'ssh-rsa',
      preferKnown: false,
    });
    assert.equal(r.list[0], 'ssh-ed25519');
  });

  await t.test('puts certificate algorithms ahead of everything when accepted', () => {
    const r = ext.resolveHostKeyOrder(['ed25519', 'rsa'], { acceptCertificates: true });
    assert.equal(r.list[0], 'ssh-ed25519-cert-v01@openssh.com');
    assert.ok(r.list.includes('ssh-ed25519'));
  });

  await t.test('drops what this SSH library cannot offer, and says which', () => {
    const supported = ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'];
    const r = ext.resolveHostKeyOrder(['ed448', 'ed25519', 'ecdsa', 'rsa'], { supported });
    assert.ok(!r.list.includes('ssh-ed448'));
    assert.ok(!r.list.some((n) => n.startsWith('ecdsa')));
    assert.ok(r.dropped.includes('ed448'));
    assert.ok(r.dropped.includes('ecdsa'));
  });

  await t.test('a later key exchange reuses the algorithm the first one chose', () => {
    // Offering the list again would let the server switch key type mid-session
    // and force a fresh fingerprint prompt in the middle of the user's work.
    const r = ext.hostKeyOrderForRekey('ssh-ed25519');
    assert.deepEqual(r.list, ['ssh-ed25519']);
  });

  await t.test('names the preferred algorithms we hold no key for', () => {
    const order = ext.resolveHostKeyOrder(['ed25519', 'ecdsa', 'rsa']).order;
    const better = ext.betterHostKeyAlgorithms(order, 'ssh-rsa', () => false);
    assert.ok(better.includes('ssh-ed25519'));
    assert.ok(!better.includes('ssh-rsa'));
  });

  await t.test('reads the key type out of a stored fingerprint', () => {
    assert.equal(ext.keyTypeFromFingerprint('ssh-ed25519 255 SHA256:abc'), 'ssh-ed25519');
    assert.equal(ext.keyTypeFromFingerprint('ssh-ed25519-SHA256:abc'), 'ssh-ed25519');
    assert.equal(ext.keyTypeFromFingerprint('rsa-sha2-512 2048 SHA256:abc'), 'rsa-sha2-512');
    // An OpenSSH public key pasted whole is not a fingerprint.
    assert.equal(ext.keyTypeFromFingerprint('ssh-ed25519 AAAAC3NzaC1lZDI1'), null);
    assert.equal(ext.keyTypeFromFingerprint(''), null);
  });
});

// --------------------------------------------- transport-level classification

test('the transport reports why a connection failed', async (t) => {
  await t.test('a refused connection is retriable and suggests FTP', async () => {
    // Bind and immediately close, so the port is certainly not listening.
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const transport = new SshTransport({
      hostName: '127.0.0.1', portNumber: port, userName: 'x', password: 'y', timeout: 5,
    }, { hostKeyVerifier: () => true });

    await assert.rejects(() => transport.connect(), (e) => {
      assert.ok(e.ssh, 'the failure must carry its classification');
      assert.equal(e.ssh.kind, 'network');
      assert.equal(e.ssh.retriable, true);
      assert.equal(e.ftpSuggestion.suggest, false, 'a non-standard port must not be probed');
      return true;
    });
  });

  await t.test('a rejected host key is not retriable', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const transport = new SshTransport({
        hostName: '127.0.0.1', portNumber: srv.port, userName: 'x', password: 'y', timeout: 5,
      }, { hostKeyVerifier: () => false });
      await assert.rejects(() => transport.connect(), (e) => {
        assert.ok(e.ssh);
        assert.equal(e.ssh.retriable, false);
        return true;
      });
    } finally { await srv.close(); }
  });

  await t.test('copy-data removes a partial destination when the copy fails', async () => {
    const srv = await startRawSftpServer({ extensions: [['copy-data', '']] });
    try {
      const { adapter } = await connectAdapter(srv);
      const calls = [];
      adapter._call = async (method, path) => {
        calls.push([method, path]);
        if (method === 'open' && path === '/src') return 'read-handle';
        if (method === 'open' && path === '/dst') return 'write-handle';
        if (method === 'close') return undefined;
        if (method === 'unlink') return undefined;
        throw new Error('copy refused');
      };
      adapter.ext.copyData = async () => { throw new Error('copy refused'); };
      await assert.rejects(() => adapter.copyRemote('/src', '/dst'), /copy refused/);
      assert.deepEqual(calls, [
        ['open', '/src'], ['open', '/dst'],
        ['close', 'read-handle'], ['close', 'write-handle'],
        ['unlink', '/dst'],
      ]);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('copy-data does not remove an existing destination when exclusive create fails', async () => {
    const srv = await startRawSftpServer({ extensions: [['copy-data', '']] });
    try {
      const { adapter } = await connectAdapter(srv);
      const calls = [];
      adapter._call = async (method, path) => {
        calls.push([method, path]);
        if (method === 'open' && path === '/src') return 'read-handle';
        if (method === 'open' && path === '/dst') throw new Error('destination exists');
        if (method === 'close') return undefined;
        if (method === 'unlink') throw new Error('unlink must not run');
        throw new Error(`unexpected ${method}`);
      };
      await assert.rejects(() => adapter.copyRemote('/src', '/dst'), /destination exists/);
      assert.deepEqual(calls, [['open', '/src'], ['open', '/dst'], ['close', 'read-handle']]);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });

  await t.test('failed host-key verification aborts the socket and leaves retry state clean', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const transport = new SshTransport({
        hostName: '127.0.0.1', portNumber: srv.port, userName: 'x', password: 'wrong', timeout: 5,
      }, { hostKeyVerifier: () => false });
      await assert.rejects(() => transport.connect());
      assert.equal(transport.socket, null);
      assert.equal(transport.client, null);
      assert.equal(transport.tunnelClient, null);
      assert.equal(transport._closing, false);
    } finally { await srv.close(); }
  });

  await t.test('the banner is reported with the decision about showing it', async () => {
    const key = hostKey();
    const banner = 'Authorised users only.\n';
    const server = new Server({ hostKeys: [key.private], banner }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const policy = new ext.BannerPolicy();
    const transport = new SshTransport({
      hostName: '127.0.0.1', portNumber: port, userName: 'x', password: 'y', timeout: 5,
    }, { hostKeyVerifier: () => true, bannerPolicy: policy, sessionKey: 'site' });
    const seen = [];
    transport.on('banner', (text, info) => seen.push({ text, ...info }));
    try {
      await transport.connect();
      assert.equal(seen.length, 1);
      assert.equal(seen[0].show, true);
      assert.equal(seen[0].text.trim(), 'Authorised users only.');
      assert.equal(seen[0].hash, ext.bannerHash(seen[0].text));
      assert.equal(transport.banners.length, 1);
    } finally {
      await transport.disconnect();
      await new Promise((r) => server.close(r));
    }
  });

  await t.test('reports the server identification the workarounds key on', async () => {
    const srv = await startRawSftpServer({ extensions: [] });
    try {
      const { adapter, info } = await connectAdapter(srv);
      assert.match(info.sshImplementation, /ssh2js/i);
      assert.equal(typeof info.implementation, 'string');
      assert.equal(adapter.transport.sshImplementation.startsWith('SSH-2.0-'), false);
      await adapter.disconnect();
    } finally { await srv.close(); }
  });
});

test('explicit SSH algorithm policies fail closed', async (t) => {
  for (const [label, setting] of [
    ['cipher', { cipherList: ['des'] }],
    ['key exchange', { kexList: ['WARN', 'dh-group1-sha1'] }],
    ['host-key', { hostKeyList: ['ed448'] }],
  ]) {
    await t.test(`does not fall back when the ${label} list is unusable`, async () => {
      const server = net.createServer();
      const sockets = new Set();
      let wireBytes = 0;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('data', (data) => { wireBytes += data.length; });
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const transport = new SshTransport({
        hostName: '127.0.0.1', portNumber: port, userName: 'test', password: 'not-a-secret',
        timeout: 5, ...setting,
      }, { hostKeyVerifier: () => true });
      try {
        await assert.rejects(() => transport.connect(), (error) => {
          assert.equal(error.code, 'ERR_SSH_ALGORITHM_POLICY');
          assert.equal(error.ssh.kind, 'policy');
          assert.equal(error.ssh.retriable, false);
          assert.match(error.message, new RegExp(`SSH ${label} policy`));
          return true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(wireBytes, 0, 'the SSH client must not fall back and start a handshake');
      } finally {
        await transport.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

// --------------------------------------------------------- window accounting

test('the raw send path respects the SSH window', async (t) => {
  await t.test('a packet larger than one channel packet is split, not dropped', () => {
    const sent = [];
    const fake = {
      outgoing: { state: 'open', id: 1, window: 1000, packetSize: 100 },
      _protocol: { channelData: (id, data) => sent.push(data.length) },
      _buffer: [],
      _waitWindow: false,
      _chunkcb: undefined,
    };
    ext.sendPacket(fake, Buffer.alloc(250));
    assert.deepEqual(sent, [100, 100, 50]);
    assert.equal(fake.outgoing.window, 750);
    assert.equal(fake._buffer.length, 0);
  });

  await t.test('the remainder is queued when the window runs out mid-packet', () => {
    const sent = [];
    const fake = {
      outgoing: { state: 'open', id: 1, window: 60, packetSize: 100 },
      _protocol: { channelData: (id, data) => sent.push(data.length) },
      _buffer: [],
      _waitWindow: false,
      _chunkcb: undefined,
    };
    ext.sendPacket(fake, Buffer.alloc(200));
    assert.deepEqual(sent, [60]);
    assert.equal(fake._waitWindow, true);
    assert.equal(fake._buffer.length, 1);
    assert.equal(fake._buffer[0].length, 140);
    // A drain must be armed, or the tail would never leave.
    assert.equal(typeof fake._chunkcb, 'function');

    fake.outgoing.window = 1000;
    fake._chunkcb.call(fake);
    assert.deepEqual(sent, [60, 100, 40]);
    assert.equal(fake._buffer.length, 0);
  });

  await t.test('refuses to write to a channel that is not open', () => {
    const fake = {
      outgoing: { state: 'closed', id: 1, window: 100, packetSize: 100 },
      _protocol: { channelData: () => { throw new Error('must not be called'); } },
      _buffer: [], _waitWindow: false, _chunkcb: undefined,
    };
    assert.throws(() => ext.sendPacket(fake, Buffer.alloc(10)), /not open/);
  });

  await t.test('refuses a library whose channel is not the expected shape', () => {
    assert.throws(() => ext.sendPacket({}, Buffer.alloc(1)), /expected shape/);
  });
});

// ------------------------------------------------------------------ the tap

test('the inbound frame observer', async (t) => {
  await t.test('reassembles a packet split across several chunks', () => {
    const tap = new ext.FrameTap();
    const seen = [];
    tap.pending = 1;
    tap.sawVersion = true;
    tap.onExtendedReply = (body) => seen.push(Buffer.from(body));
    const body = Buffer.concat([Buffer.from([P.EXTENDED_REPLY]), u32(7), Buffer.from('hi')]);
    const frame = Buffer.concat([u32(body.length), body]);
    for (const byte of frame) tap.feed(Buffer.from([byte]));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].readUInt32BE(1), 7);
  });

  await t.test('skips packets it does not want without copying them', () => {
    const tap = new ext.FrameTap();
    tap.sawVersion = true;
    tap.pending = 0;
    let called = 0;
    tap.onExtendedReply = () => { called++; };
    const data = Buffer.concat([Buffer.from([P.DATA]), u32(1), Buffer.alloc(4096, 9)]);
    tap.feed(Buffer.concat([u32(data.length), data]));
    assert.equal(called, 0);
    assert.equal(tap.buf, null);
  });

  await t.test('stops observing rather than guessing when framing looks wrong', () => {
    const tap = new ext.FrameTap();
    // A length beyond the protocol maximum means we are out of step with the
    // stream; the library will report it, and a guess here would be worse.
    tap.feed(Buffer.concat([u32(99999999), Buffer.alloc(4)]));
    assert.equal(tap.broken, true);
  });

  await t.test('handles two packets arriving in one chunk', () => {
    const tap = new ext.FrameTap();
    tap.sawVersion = true;
    tap.pending = 2;
    const seen = [];
    tap.onExtendedReply = (b) => seen.push(b.readUInt32BE(1));
    const one = Buffer.concat([Buffer.from([P.EXTENDED_REPLY]), u32(1)]);
    const two = Buffer.concat([Buffer.from([P.EXTENDED_REPLY]), u32(2)]);
    tap.feed(Buffer.concat([u32(one.length), one, u32(two.length), two]));
    assert.deepEqual(seen, [1, 2]);
  });
});

/**
 * A leak guard, not a test of the port.
 *
 * Every server in this file is closed in a `finally`, yet the process used to
 * sit there after the last assertion passed — `node --test` waits for the event
 * loop to drain, so one un-destroyed socket turns a green suite into a hang,
 * and a hang in CI looks like an infrastructure problem rather than a bug in a
 * test. This names whatever is still holding the loop open instead.
 */
test('the suite leaves no handle holding the event loop open', async () => {
  // Give in-flight teardown a moment: closing an ssh2 server resolves before
  // its sockets have finished unwinding.
  await new Promise((r) => setTimeout(r, 500));

  const active = process.getActiveResourcesInfo()
    // These are the runner's own, and are always present.
    .filter((k) => !/^(TTYWrap|Immediate|Timeout|SignalWrap|ProcessWrap|PipeWrap|FSReqCallback)$/.test(k));

  assert.deepEqual(active, [],
    'something in this file is still open after every test finished: ' + JSON.stringify(active));
});

// ------------------------------------------- SSH_FXP_SYMLINK argument order

// The whole point of the symlink workaround is the bytes on the wire, and the
// bytes are what these assert. Getting this wrong does not produce an error:
// the server happily creates the link at the *target's* path, so the user's
// link is silently in the wrong place and something else has been overwritten.
test('SSH_FXP_SYMLINK argument order on the wire', async (t) => {
  const symlinkOrder = async (opts, session = {}) => {
    const srv = await startRawSftpServer(opts);
    try {
      const { adapter } = await connectAdapter(srv, session);
      await adapter.symlink('/the/target', '/the/link');
      await adapter.disconnect();
      return srv.received.find((r) => r.name === 'SYMLINK');
    } finally { await srv.close(); }
  };

  await t.test('a conforming server gets the specification order, link first', async () => {
    const req = await symlinkOrder({ ident: 'ExampleSFTP_1.0' });
    assert.deepEqual([req.first, req.second], ['/the/link', '/the/target']);
  });

  await t.test('OpenSSH gets its own reversed order, target first', async () => {
    const req = await symlinkOrder({ ident: 'OpenSSH_9.6' });
    assert.deepEqual([req.first, req.second], ['/the/target', '/the/link']);
  });

  await t.test('Sun SSH is an OpenSSH fork and gets the reversed order too', async () => {
    // ssh2's own test is `/^SSH-2.0-(OpenSSH|dropbear)/`, which does not match
    // Sun_SSH; WinSCP's IsOpenSSH() does. Without the compensation this server
    // would receive the specification order.
    const req = await symlinkOrder({ ident: 'Sun_SSH_1.1.3' });
    assert.deepEqual([req.first, req.second], ['/the/target', '/the/link']);
  });

  await t.test('ProFTPD/mod_sftp followed the bug deliberately', async () => {
    const req = await symlinkOrder({ ident: 'mod_sftp/0.9.8' });
    assert.deepEqual([req.first, req.second], ['/the/target', '/the/link']);
  });

  await t.test('dropbear keeps the reversed order the SSH library knows about', async () => {
    // WinSCP has never heard of dropbear, but its SFTP subsystem is OpenSSH's
    // sftp-server in practice. Replacing the library's answer with WinSCP's
    // instead of adding to it would send this server the wrong order.
    const req = await symlinkOrder({ ident: 'dropbear_2022.83' });
    assert.deepEqual([req.first, req.second], ['/the/target', '/the/link']);
  });

  await t.test('the site can force the workaround off, as asOff does', async () => {
    const req = await symlinkOrder({ ident: 'OpenSSH_9.6' }, { sftpBugs: { symlink: 'off' } });
    assert.deepEqual([req.first, req.second], ['/the/link', '/the/target']);
  });

  await t.test('the site can force the workaround on for a server we do not know', async () => {
    const req = await symlinkOrder({ ident: 'ExampleSFTP_1.0' }, { sftpBugs: { symlink: 'on' } });
    assert.deepEqual([req.first, req.second], ['/the/target', '/the/link']);
  });
});

// ------------------------------------------------- the banner event contract

test('the banner reaches its consumer as text', async (t) => {
  await t.test('the first argument is the banner string, not a decision object', () => {
    const transport = new SshTransport({ hostName: 'h', portNumber: 22 }, {});
    const seen = [];
    transport.on('banner', (text, info) => seen.push({ text, info }));
    transport._banner({ label: 'session', host: 'h', port: 22 }, 'Welcome to the server\n');
    assert.equal(seen.length, 1);
    // session.js does `a.on('banner', (text) => this.banner(text))` and the
    // renderer puts that value straight into a notification, so anything other
    // than a string shows the user "[object Object]".
    assert.equal(typeof seen[0].text, 'string');
    assert.equal(seen[0].text, 'Welcome to the server\n');
    assert.equal(seen[0].info.hash, ext.bannerHash('Welcome to the server\n'));
    assert.equal(seen[0].info.show, true);
  });

  await t.test('a whitespace-only banner is never emitted at all', () => {
    const transport = new SshTransport({ hostName: 'h', portNumber: 22 }, {});
    let count = 0;
    transport.on('banner', () => { count++; });
    transport._banner({ label: 'session', host: 'h', port: 22 }, '\r\n');
    assert.equal(count, 0);
  });
});

// -------------------------------------- what the workaround log may claim

test('the workaround log only claims what the code really does', async (t) => {
  await t.test('a workaround this port does not implement is documented, not announced', () => {
    const bugs = ext.resolveSftpBugs({ implementation: 'openssh', ident: 'OpenSSH_9.6', version: 3 });
    const activeIds = bugs.active.map((b) => b.id);
    const documentedIds = bugs.documented.map((b) => b.id);
    // stat() falls back to STAT for FTPShell, while mutating operations remain
    // deliberately strict about LSTAT so a symlink target cannot be touched.
    assert.ok(activeIds.includes('lstatUnsupported'));
    assert.ok(!documentedIds.includes('lstatUnsupported'));
    // The two SSH_FXP_STATUS tolerances belong to the SSH library's parser.
    assert.ok(!activeIds.includes('statusMessageOmitted'));
    assert.ok(!activeIds.includes('languageTagOmitted'));
    // The detection itself is still available, so nothing is lost.
    assert.equal(bugs.lstatUnsupported, true);
    assert.equal(bugs.statusMessageOmitted, true);
  });

  await t.test('everything still announced is something this code performs', () => {
    const bugs = ext.resolveSftpBugs({ implementation: 'openssh', ident: 'OpenSSH_9.6', version: 3 });
    assert.deepEqual(bugs.active.map((b) => b.id).sort(), [
      'checkFileAnnouncedByRequestName',
      'copyFileCannotOverwrite',
      'hardlinkArgumentOrderReversed',
      'limitedPacketSize',
      'lstatUnsupported',
      'signedTimestamps',
      'spaceAvailableAllocationUnitIs16Bit',
      'symlinkArgumentOrderReversed',
      'versionsExtensionIsStruct',
    ]);
  });
});

test('SFTP stat falls back from unsupported lstat without fabricating link metadata', async (t) => {
  const adapter = new SftpAdapter({});
  adapter.bugs = { lstatUnsupported: true };
  const calls = [];
  adapter._call = async (method, path) => {
    calls.push([method, path]);
    if (method === 'lstat') {
      const error = new Error('unsupported');
      error.code = 8; // SSH_FX_OP_UNSUPPORTED
      throw error;
    }
    return { mode: 0o040755, size: 0, mtime: 1700000000, atime: 1700000000, uid: 7, gid: 9 };
  };
  const row = await adapter.stat('/traverse-only');
  assert.equal(row.type, 'dir');
  assert.equal(row.isSymlink, false);
  assert.equal(row.raw.lstatFallback, true);
  assert.deepEqual(calls, [['lstat', '/traverse-only'], ['stat', '/traverse-only']]);
  await t.test('an unrelated lstat failure is not downgraded', async () => {
    const other = new SftpAdapter({});
    other.bugs = { lstatUnsupported: true };
    other._call = async () => { const e = new Error('permission denied'); e.code = 3; throw e; };
    await assert.rejects(() => other.stat('/private'), /permission denied/);
  });
});

test('SFTP stat fallback preserves a followed special-file type', async () => {
  const adapter = new SftpAdapter({});
  adapter.bugs = { lstatUnsupported: true };
  adapter._call = async (method) => {
    if (method === 'lstat') {
      const error = new Error('unsupported');
      error.code = 8;
      throw error;
    }
    return { mode: 0o020600, size: 0, mtime: 1700000000, atime: 1700000000, uid: 7, gid: 9 };
  };
  const row = await adapter.stat('/device');
  assert.equal(row.type, 'special');
  assert.equal(row.isSymlink, false);
  assert.equal(row.raw.lstatFallback, true);
});
