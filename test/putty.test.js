'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const P = require('../design/main/putty');

const PUBLIC = Buffer.from('public-key').toString('base64');
const PRIVATE = Buffer.from('private-key').toString('base64');

function ppk({ version = 3, algorithm = 'ssh-ed25519', encryption = 'none', comment = 'deploy key', kdf = encryption !== 'none' && version === 3 } = {}) {
  const lines = [
    `PuTTY-User-Key-File-${version}: ${algorithm}`,
    `Encryption: ${encryption}`,
    `Comment: ${comment}`,
    'Public-Lines: 1',
    PUBLIC,
  ];
  if (kdf) lines.push(
    'Key-Derivation: Argon2id',
    'Argon2-Memory: 8192',
    'Argon2-Passes: 3',
    'Argon2-Parallelism: 1',
    'Argon2-Salt: 00112233445566778899aabbccddeeff',
  );
  lines.push(
    'Private-Lines: 1',
    PRIVATE,
    'Private-MAC: ' + 'a'.repeat(version === 3 ? 64 : 40),
    '',
  );
  return lines.join('\n');
}

test('strictly parses safe PuTTY key metadata without exposing key payloads', () => {
  const result = P.parsePuttyKeyMetadata(ppk({ encryption: 'aes256-cbc' }), {
    filePath: '"C:\\Keys\\deploy.ppk"',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    format: 'ppk',
    version: 3,
    algorithm: 'ssh-ed25519',
    encryption: 'aes256-cbc',
    encrypted: true,
    comment: 'deploy key',
    publicLineCount: 1,
    privateLineCount: 1,
    hasPrivateMaterial: true,
    hasPrivateMac: true,
    filePath: 'C:\\Keys\\deploy.ppk',
    keyDerivation: {
      algorithm: 'Argon2id', memoryKiB: 8192, passes: 3, parallelism: 1,
      salt: '00112233445566778899aabbccddeeff',
    },
  });
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('accepts PuTTY v2 and legacy supported algorithms', () => {
  const result = P.parsePuttyKeyMetadata(ppk({ version: 2, algorithm: 'ssh-rsa' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.version, 2);
  assert.equal(result.value.algorithm, 'ssh-rsa');
});

test('accepts the upstream PPK v3 Argon2 metadata block without deriving a key', () => {
  const result = P.parsePuttyKeyMetadata(ppk({ encryption: 'aes256-cbc' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.keyDerivation, {
    algorithm: 'Argon2id', memoryKiB: 8192, passes: 3, parallelism: 1,
    salt: '00112233445566778899aabbccddeeff',
  });
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test('rejects malformed or resource-amplifying PPK v3 KDF metadata', () => {
  for (const input of [
    ppk({ encryption: 'aes256-cbc' }).replace('Argon2-Memory: 8192', 'Argon2-Memory: 0'),
    ppk({ encryption: 'aes256-cbc' }).replace('Key-Derivation: Argon2id', 'Key-Derivation: scrypt'),
    ppk({ encryption: 'aes256-cbc' }).replace('Argon2-Salt: 00112233445566778899aabbccddeeff', 'Argon2-Salt: xyz'),
    ppk({ encryption: 'aes256-cbc' }).replace('Argon2-Parallelism: 1', 'Argon2-Parallelism: 2048'),
  ]) {
    assert.deepEqual(P.parsePuttyKeyMetadata(input), { ok: false, error: 'Invalid PuTTY metadata.' });
  }
});

test('malformed PPK metadata fails closed with a non-reflective error', () => {
  const cases = [
    ppk({ algorithm: 'ssh-magic' }),
    ppk().replace('Public-Lines: 1', 'Public-Lines: 0'),
    ppk().replace(PUBLIC, PUBLIC.slice(0, -1) + '!'),
    ppk().replace('Private-MAC: ' + 'a'.repeat(64), 'Private-MAC: secret-passphrase'),
    ppk() + 'unexpected trailing line\n',
    ppk().replace('Encryption: none', 'Encryption: chacha20'),
  ];
  for (const input of cases) {
    const result = P.parsePuttyKeyMetadata(input);
    assert.deepEqual(result, { ok: false, error: 'Invalid PuTTY metadata.' });
    assert.equal(JSON.stringify(result).includes('secret-passphrase'), false);
  }
});

test('rejects duplicate and reordered PPK headers instead of guessing', () => {
  const duplicate = ppk().replace('Comment: deploy key', 'Comment: deploy key\nComment: second');
  const reordered = ppk().replace('Encryption: none\nComment:', 'Comment: deploy key\nEncryption: none\nComment:');
  assert.equal(P.parsePuttyKeyMetadata(duplicate).ok, false);
  assert.equal(P.parsePuttyKeyMetadata(reordered).ok, false);
});

test('normalizes executable/key paths but refuses command fragments and bad markers', () => {
  assert.equal(P.normalizePuttyPath('"%PROGRAMFILES%\\PuTTY\\putty.exe"'),
    '%PROGRAMFILES%\\PuTTY\\putty.exe');
  assert.equal(P.normalizePuttyPath('C:/Keys/../Keys/id.ppk'), 'C:\\Keys\\id.ppk');
  assert.equal(P.normalizePuttyPath('C:\\PuTTY\\putty.exe -load site'), null);
  assert.equal(P.normalizePuttyPath('C:\\PuTTY\\putty.exe & whoami'), null);
  assert.equal(P.normalizePuttyPath('%BROKEN\\putty.exe'), null);
  assert.equal(P.normalizePuttyPath('"C:\\PuTTY\\putty.exe'), null);
});

test('normalizes only supported algorithm aliases and rejects unknown values', () => {
  assert.equal(P.normalizePuttyAlgorithm('kex', 'diffie-hellman-group14-sha1'), 'dh-group14-sha1');
  assert.equal(P.normalizePuttyAlgorithm('hostKey', 'ssh-ed25519'), 'ed25519');
  assert.equal(P.normalizePuttyAlgorithm('cipher', 'warning'), 'WARN');
  assert.deepEqual(P.normalizePuttyAlgorithmList('cipher', 'aes, chacha20;WARN'),
    ['aes', 'chacha20', 'WARN']);
  assert.equal(P.normalizePuttyAlgorithm('kex', 'made-up-kex'), null);
  assert.equal(P.normalizePuttyAlgorithmList('cipher', 'aes aes'), null);
  assert.equal(P.normalizePuttyAlgorithmList('unknown', 'aes'), null);
});

test('projects PuTTY config into supported safe fields and redacts secret fields', () => {
  const result = P.parsePuttyConfig([
    'HostName=example.test',
    'PortNumber=2222',
    'Protocol=ssh-2',
    'Cipher=aes,chacha20,WARN',
    'KEX=diffie-hellman-group14-sha1,ecdh',
    'HostKey=ssh-ed25519,rsa-sha2-512',
    'PrivateKeyFile="C:\\Keys\\deploy.ppk"',
    'Password=super-secret-passphrase',
    'FutureSetting=ignored safely',
  ].join('\n'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.values, {
    hostName: 'example.test',
    portNumber: 2222,
    protocol: 'ssh',
    cipher: ['aes', 'chacha20', 'WARN'],
    kex: ['dh-group14-sha1', 'ecdh'],
    hostKey: ['ed25519', 'rsa'],
    privateKeyFile: 'C:\\Keys\\deploy.ppk',
  });
  assert.deepEqual(result.value.redactedKeys, ['Password']);
  assert.deepEqual(result.value.ignoredKeys, ['FutureSetting']);
  assert.equal(JSON.stringify(result).includes('super-secret-passphrase'), false);
});

test('parses PuTTY raw settings that carry several assignments on one line', () => {
  const result = P.parsePuttyConfig(
    'HostName=example.test PortNumber=22 Protocol=ssh PrivateKeyFile="C:\\Program Files\\id.ppk"',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.values, {
    hostName: 'example.test',
    portNumber: 22,
    protocol: 'ssh',
    privateKeyFile: 'C:\\Program Files\\id.ppk',
  });
});

test('config parser fails closed on invalid ports, algorithms, duplicate keys, and syntax', () => {
  for (const config of [
    'PortNumber=65536',
    'Protocol=ftp',
    'Cipher=aes,unknown',
    'HostName=one\nHostName=two',
    'HostName missing equals',
  ]) {
    assert.deepEqual(P.parsePuttyConfig(config), { ok: false, error: 'Invalid PuTTY metadata.' });
  }
});

test('object configs accept registry-style scalar values without retaining unknown data', () => {
  const result = P.parsePuttyConfig({
    HostName: 'example.test',
    PortNumber: 22,
    Compression: 1,
    AgentFwd: 'yes',
    Password: 'do-not-return',
    Unknown: 'ignored',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.values, {
    hostName: 'example.test', portNumber: 22, compression: true, agentForwarding: true,
  });
  assert.deepEqual(result.value.redactedKeys, ['Password']);
  assert.deepEqual(result.value.ignoredKeys, ['Unknown']);
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
});

test('file metadata reads are bounded and report unreadable input generically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-putty-'));
  try {
    const file = path.join(dir, 'key.ppk');
    fs.writeFileSync(file, ppk());
    const result = P.readPuttyKeyMetadata(file);
    assert.equal(result.ok, true);
    assert.equal(result.value.filePath, file);
    assert.deepEqual(P.readPuttyKeyMetadata(path.join(dir, 'missing.ppk')), {
      ok: false, error: 'Invalid PuTTY metadata.',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
