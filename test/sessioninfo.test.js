// sessioninfo.test.js — core/SessionInfo.h/.cpp's identity and runtime seam.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SESSION_STATUS, FileSystemInfo, SessionInfo } = require('../design/main/sessioninfo');
const { defaultSessionData } = require('../design/main/sessiondata');
const { Session } = require('../design/main/session');

function site(fields = {}) {
  return { ...defaultSessionData('prod'), hostName: 'example.com', userName: 'martin', ...fields };
}

test('a new SessionInfo has the core closed-session defaults', () => {
  const info = SessionInfo.fromSessionData(site());
  assert.equal(info.status, SESSION_STATUS.CLOSED);
  assert.equal(info.connected, false);
  assert.equal(info.protocol, 'sftp');
  assert.equal(info.protocolBaseName, 'SFTP');
  assert.equal(info.protocolName, 'SFTP');
  assert.equal(info.securityProtocolName, 'SSH');
  assert.equal(info.hostPort, 'example.com:22');
  assert.equal(info.sessionName, 'prod');
  assert.equal(info.displayName, 'prod');
  assert.equal(info.CSCipher, '');
  assert.equal(info.CSCompression, '');
  assert.match(info.loginTime.toISOString(), /^\d{4}-\d\d-\d\dT/);
});

test('protocol identity follows sessiondata protocol and security settings', () => {
  const cases = [
    ['scp', 'SCP', 'SCP', 'SSH'],
    ['sftpOnly', 'SFTP', 'SFTP', 'SSH'],
    ['ftp', 'FTP', 'FTP', ''],
    ['ftp', 'FTP', 'FTPS', 'TLS/SSL', { ftps: 'explicitTls' }],
    ['webdav', 'WebDAV', 'WebDAV', '', { ftps: 'none' }],
    ['webdav', 'WebDAV', 'WebDAVS', 'TLS/SSL', { ftps: 'explicitTls' }],
    ['s3', 'S3', 'Amazon S3', '', { ftps: 'none' }],
    ['s3', 'S3', 'Amazon S3', 'HTTPS', { ftps: 'implicit' }],
  ];
  for (const [protocol, base, name, security, extra = {}] of cases) {
    const info = SessionInfo.fromSessionData(site({ protocol, ...extra }));
    assert.deepEqual([info.protocolBaseName, info.protocolName, info.securityProtocolName], [base, name, security]);
  }
});

test('missing ports use the protocol-aware sessiondata default and IPv6 is display-safe', () => {
  const ftp = SessionInfo.fromSessionData(site({ protocol: 'ftp', portNumber: 0 }));
  assert.equal(ftp.portNumber, 21);
  const implicit = SessionInfo.fromSessionData(site({ protocol: 'ftp', ftps: 'implicit', portNumber: 0 }));
  assert.equal(implicit.portNumber, 990);
  const ipv6 = SessionInfo.fromSessionData(site({ hostName: '2001:db8::7', portNumber: 2222 }));
  assert.equal(ipv6.hostPort, '[2001:db8::7]:2222');
});

test('display fields preserve site naming and never expose credentials', () => {
  const info = SessionInfo.fromSessionData(site({
    name: '', password: 'do-not-leak', passphrase: 'also-do-not-leak',
  }));
  assert.equal(info.sessionName, 'martin@example.com');
  assert.deepEqual(info.displayFields(), {
    sessionName: 'martin@example.com', displayName: 'martin@example.com', protocol: 'SFTP',
    hostName: 'example.com', portNumber: 22, userName: 'martin', hostPort: 'example.com:22',
    status: 'closed',
  });
  assert.doesNotMatch(info.serialize(), /do-not-leak|also-do-not-leak|password|passphrase/i);
});

test('fromSession captures the live Session shape without requiring IPC changes', () => {
  const info = SessionInfo.fromSession({
    id: 'runtime-1',
    data: site({ id: 'site-1', protocol: 'webdav', ftps: 'explicitTls' }),
    state: { status: 'connected', openedAt: 1234, localPath: 'C:\\work', remotePath: '/srv' },
    connected: true,
    adapter: {
      protocolName: 'WebDAVS', home: '/home',
      caps: { find: true, rename: false },
      serverInfo: { software: 'dav-server', token: 'redact-me', version: '1.2' },
    },
  });
  assert.equal(info.sessionId, 'runtime-1');
  assert.equal(info.siteId, 'site-1');
  assert.equal(info.status, SESSION_STATUS.OPENED);
  assert.equal(info.stateStatus, 'connected');
  assert.equal(info.connected, true);
  assert.equal(info.protocolName, 'WebDAVS');
  assert.deepEqual(info.capabilities, { find: true, rename: false });
  assert.deepEqual(info.serverInfo, { software: 'dav-server', version: '1.2' });
  assert.equal(info.localPath, 'C:\\work');
  assert.equal(info.remotePath, '/srv');
});

test('fromSession accepts the repository Session class without a bridge or adapter shim', () => {
  const live = new Session(site({ id: 'site-2', protocol: 'scp' }), { id: 'runtime-2' });
  const info = SessionInfo.fromSession(live);
  assert.equal(info.sessionId, 'runtime-2');
  assert.equal(info.siteId, 'site-2');
  assert.equal(info.protocolName, 'SCP');
  assert.equal(info.status, SESSION_STATUS.CLOSED);
  assert.equal(info.hostPort, 'example.com:22');
});

test('live certificate facts under adapter serverInfo reach the secret-free snapshot', () => {
  const live = new Session(site({ id: 'site-cert', protocol: 'ftp', ftps: 'explicitTls' }), { id: 'runtime-cert' });
  live.adapter = {
    connected: true,
    serverInfo: {
      certificate: {
        subject: 'CN=files.example.com',
        fingerprint: 'AA:BB',
        fingerprint256: '11:22',
        privateKey: 'must-not-escape',
      },
    },
  };
  const info = live.info();
  assert.equal(info.certificateFingerprintSHA1, 'AA:BB');
  assert.equal(info.certificateFingerprintSHA256, '11:22');
  assert.equal(info.certificate.subject, 'CN=files.example.com');
  assert.equal(info.certificate.privateKey, undefined);
  assert.doesNotMatch(JSON.stringify(info), /must-not-escape|privateKey/i);
});

test('live Session.info publishes the canonical identity while retaining renderer aliases', () => {
  const live = new Session(site({ id: 'site-3', password: 'secret', protocol: 'sftp' }), { id: 'runtime-3' });
  const info = live.info();
  assert.equal(info.sessionId, 'runtime-3');
  assert.equal(info.id, 'runtime-3');
  assert.equal(info.name, 'prod');
  assert.equal(info.protocolName, 'SFTP');
  assert.equal(info.caps, null);
  assert.deepEqual(info.capabilities, {});
  assert.doesNotMatch(JSON.stringify(info), /secret|password|passphrase/i);
});

test('config-shaped lookup resolves the site and keeps encrypted values out of the snapshot', () => {
  const data = site({ id: 'site-1', password: 'mp:encrypted', proxyPassword: 'mp:proxy' });
  const config = { siteById: (id) => id === 'site-1' ? data : null };
  const info = SessionInfo.fromConfig(config, 'site-1');
  assert.equal(info.siteId, 'site-1');
  assert.equal(SessionInfo.fromConfig(config, 'missing'), null);
  assert.doesNotMatch(info.serialize(), /mp:encrypted|mp:proxy/);
});

test('serialization is canonical across input property order and round-trips', () => {
  const a = SessionInfo.fromSessionData(site({ hostName: 'h', userName: 'u', portNumber: 2222 }), {
    sessionId: 's1', status: 'connecting', loginTime: '2026-01-02T03:04:05.000Z',
    serverInfo: { z: 2, a: 1 }, capabilities: { zed: true, alpha: false },
  });
  const b = SessionInfo.fromSessionData({ ...site({ portNumber: 2222, userName: 'u', hostName: 'h' }) }, {
    capabilities: { alpha: false, zed: true }, serverInfo: { a: 1, z: 2 },
    loginTime: new Date('2026-01-02T03:04:05.000Z'), status: 'connecting', sessionId: 's1',
  });
  assert.equal(a.serialize(), b.serialize());
  const restored = SessionInfo.fromJSON(a.serialize());
  assert.deepEqual(restored.toJSON(), a.toJSON());
  assert.equal(restored.loginTime.toISOString(), '2026-01-02T03:04:05.000Z');
});

test('unsupported and malformed snapshots fail closed', () => {
  assert.throws(() => SessionInfo.fromJSON('{"version":99}'), /Unsupported SessionInfo version/);
  assert.throws(() => SessionInfo.fromJSON('{broken'), /Invalid SessionInfo JSON/);
  assert.throws(() => SessionInfo.fromJSON([]), /must be an object/);
});

test('FileSystemInfo carries the upstream server/capability identity canonically', () => {
  const sessionInfo = SessionInfo.fromSessionData(site({ protocol: 'sftp' }), { capabilities: { resume: true } });
  const fs = new FileSystemInfo({ sessionInfo, info: {
    protocol: 'SFTP', remoteSystem: 'Linux', version: '9.1', software: 'OpenSSH',
    sessionProtocol: 'SFTP v3', cryptographicProtocol: 'SSH-2', compression: 'none',
    additional: { z: 'last', a: 'first' }, token: 'omit',
  }, capabilities: { resume: true, rename: false }, home: '/home/martin' });
  assert.equal(fs.protocolBaseName, 'SFTP');
  assert.equal(fs.remoteSystem, 'Linux');
  assert.equal(fs.home, '/home/martin');
  assert.deepEqual(fs.capabilities, { rename: false, resume: true });
  assert.doesNotMatch(fs.serialize(), /token|omit/);
  assert.equal(fs.serialize(), new FileSystemInfo({ sessionInfo, info: {
    protocol: 'SFTP', remoteSystem: 'Linux', version: '9.1', software: 'OpenSSH',
    sessionProtocol: 'SFTP v3', cryptographicProtocol: 'SSH-2', compression: 'none',
    additional: { a: 'first', z: 'last' },
  }, capabilities: { rename: false, resume: true }, home: '/home/martin' }).serialize());
});
