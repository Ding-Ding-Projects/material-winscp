'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Setup = require('../design/main/setup');

const PUBLIC = Buffer.from('public-key').toString('base64');
const PRIVATE = Buffer.from('private-key').toString('base64');

function ppk({ encrypted = false } = {}) {
  const lines = [
    'PuTTY-User-Key-File-3: ssh-ed25519',
    `Encryption: ${encrypted ? 'aes256-cbc' : 'none'}`,
    'Comment: test metadata only',
    'Public-Lines: 1',
    PUBLIC,
  ];
  if (encrypted) lines.push(
    'Key-Derivation: Argon2id',
    'Argon2-Memory: 8192',
    'Argon2-Passes: 3',
    'Argon2-Parallelism: 1',
    'Argon2-Salt: 00112233445566778899aabbccddeeff',
  );
  lines.push(
    'Private-Lines: 1',
    PRIVATE,
    `Private-MAC: ${'a'.repeat(64)}`,
    '',
  );
  return lines.join('\n');
}

function withKey(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-putty-tools-'));
  const key = path.join(dir, 'deploy.ppk');
  const program = path.join(dir, 'material-test-putty.exe');
  fs.writeFileSync(key, contents);
  return Promise.resolve()
    .then(() => fn({ dir, key, program }))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('PuTTY launcher preflight accepts encrypted v3 metadata without reading a passphrase', async () => {
  await withKey(ppk({ encrypted: true }), async ({ key, program }) => {
    const calls = [];
    const result = await Setup.openSessionInPutty(
      { protocol: 'sftp', hostName: 'example.test', publicKeyFile: key },
      {
        puttyPath: program,
        exists: (candidate) => candidate === program,
        env: {},
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { unref() {} };
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], key);
    assert.equal(result.usedPasswordPipe, false);
    assert.equal(calls[0].args.includes('test metadata only'), false);
  });
});
test('PuTTY launcher refuses a malformed .ppk before spawning the external client', async () => {
  await withKey('not a PuTTY private key', async ({ key, program }) => {
    let spawned = false;
    await assert.rejects(
      () => Setup.openSessionInPutty(
        { protocol: 'sftp', hostName: 'example.test', publicKeyFile: key },
        {
          puttyPath: program,
          exists: (candidate) => candidate === program,
          env: {},
          spawn: () => { spawned = true; return { unref() {} }; },
        },
      ),
      (error) => error && error.code === 'INVALID_KEY' && /could not be validated/u.test(error.message),
    );
    assert.equal(spawned, false);
  });
});
