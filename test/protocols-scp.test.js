'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const {
  ScpAdapter,
  ScpSink,
  ByteReader,
  parseControl,
  parseListingLine,
  listingSize,
  modeString,
  transferMode,
} = require('../design/main/protocols/scp');

function ackReader() {
  return {
    readBytes: async () => Buffer.from([0]),
    readLine: async () => '',
  };
}

test.describe('SCP adapter contract', () => {
  test('quotes remote paths and does not double-prefix a stored $? return variable', () => {
    const adapter = new ScpAdapter({
      returnVar: '$?',
      clearAliases: false,
      unsetNationalVars: false,
    });

    assert.equal(adapter._scp(['-f'], '/tmp/a; rm -rf /'), "scp -f -- '/tmp/a; rm -rf /'");
    const wrapped = adapter._wrap('echo safe');
    assert.match(wrapped, /echo 'WinSCP-material-rc:'"\$\?"/);
    assert.doesNotMatch(wrapped, /\$\$\?/);

    assert.throws(
      () => new ScpAdapter({ returnVar: 'status; rm -rf /' })._wrap('true'),
      (error) => error.code === 'INVALID_INPUT' && error.category === 'validation',
    );
  });

  test('normalizes shell failures and returns the exitCode used by command callers', async () => {
    const seen = [];
    const adapter = new ScpAdapter({ returnVar: '$?' }, {
      transport: {
        exec: async (command) => {
          seen.push(command);
          return { code: 0, stdout: `before\nWinSCP-material-rc:7\n`, stderr: '' };
        },
      },
    });

    const streamed = [];
    const result = await adapter.exec('echo safe', { onStdout: (text) => streamed.push(text) });
    assert.equal(result.code, 7);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'before\n');
    assert.deepEqual(streamed, ['before\n']);
    assert.match(seen[0], /echo 'WinSCP-material-rc:'"\$\?"/);

    const failing = new ScpAdapter({}, {
      transport: {
        exec: async () => ({ code: 1, stdout: '', stderr: 'Permission denied' }),
      },
    });
    await assert.rejects(
      () => failing._mustRun('chmod 0600 -- /secret', 'Changing permissions'),
      (error) => error.category === 'permission'
        && error.code === 'EACCES'
        && error.protocol === 'SCP'
        && error.operation === 'Changing permissions',
    );
  });

  test('falls back to shasum when the GNU checksum utility is unavailable', async () => {
    const commands = [];
    const adapter = new ScpAdapter({}, {
      transport: {
        exec: async (command) => {
          commands.push(command);
          if (command.startsWith('sha256sum ')) return { code: 127, stdout: '', stderr: 'not found' };
          return { code: 0, stdout: 'ABCDEF  /tmp/file', stderr: '' };
        },
      },
    });

    assert.equal(await adapter.checksum('/tmp/file', 'sha-256'), 'abcdef');
    assert.deepEqual(commands, ["sha256sum -- '/tmp/file'", "shasum -a 256 -- '/tmp/file'"]);
  });

  test('falls back to OpenSSL digest when other checksum utilities are unavailable', async () => {
    const commands = [];
    const adapter = new ScpAdapter({}, {
      transport: {
        exec: async (command) => {
          commands.push(command);
          if (command.startsWith('sha512sum ') || command.startsWith('shasum ')) {
            return { code: 127, stdout: '', stderr: 'not found' };
          }
          return { code: 0, stdout: 'SHA2-512(/tmp/file)= 0123456789abcdef', stderr: '' };
        },
      },
    });

    assert.equal(await adapter.checksum('/tmp/file', 'sha-512'), '0123456789abcdef');
    assert.deepEqual(commands, [
      "sha512sum -- '/tmp/file'",
      "shasum -a 512 -- '/tmp/file'",
      "openssl dgst -sha512 -- '/tmp/file'",
    ]);
  });

  test('drains login-shell startup output before probing the working directory', async () => {
    const commands = [];
    const logs = [];
    const adapter = new ScpAdapter({ returnVar: '$?' }, {
      transport: {
        connected: true,
        on() {},
        exec: async (command) => {
          commands.push(command);
          if (commands.length === 1) return { code: 0, stdout: 'Welcome banner\n', stderr: '' };
          if (commands.length === 2) return { code: 0, stdout: '/home/demo\n', stderr: '' };
          return { code: 0, stdout: 'Linux 6.1\n', stderr: '' };
        },
      },
    });
    adapter.on('log', (event) => logs.push(event));

    await adapter.connect();

    assert.equal(commands.length, 3);
    assert.match(commands[0], /^:; echo/);
    assert.match(commands[1], /^pwd; echo/);
    assert.equal(adapter.home, '/home/demo');
    assert.ok(logs.some((event) => /Discarded shell startup output \(15 bytes\)/.test(event.message)));
  });

  test('rejects malformed records, oversized control lines, and unsafe modes', async () => {
    assert.throws(() => parseControl('C0999 1 file'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('E unexpected'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('C0644 9007199254740992 file'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('T1 9007199254740992 1 0'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('T1 0 1 9007199254740992'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('T9007199254741 0 1 0'), (error) => error.code === 'EPROTO');
    assert.throws(() => parseControl('T1 0 9007199254741 0'), (error) => error.code === 'EPROTO');
    assert.equal(parseControl('C0644 4 file').size, 4);
    assert.equal(modeString('0755'), '0755');
    assert.throws(() => modeString('0999'), (error) => error.code === 'INVALID_INPUT');
    assert.equal(transferMode({ mode: 0o644 }, { dirMode: '0644' }, true), 0o755);
    assert.equal(transferMode({ mode: 0o644 }, { dirMode: '0644', addXToDirectories: false }, true), 0o644);

    const source = new PassThrough();
    const reader = new ByteReader(source, 1024, 8);
    source.end('123456789\n');
    await assert.rejects(() => reader.readLine(), (error) => error.category === 'protocol' && error.code === 'EPROTO');
  });

  test('listing sizes reject unsafe and overflowing remote values', () => {
    assert.equal(listingSize(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(listingSize(Number.MAX_SAFE_INTEGER + 1), 0);
    const row = parseListingLine('-rw-r--r-- 1 user group 9007199254740992 Jan 1 2024 giant', {
      now: Date.parse('2024-06-01T00:00:00Z'),
    });
    assert.equal(row.size, 0);
  });

  test('preserves special POSIX mode bits in SCP transfer headers', () => {
    assert.equal(modeString(0o4755), '4755', 'setuid must remain in the four-digit mode field');
    assert.equal(modeString(0o2644), '2644', 'setgid must remain in the four-digit mode field');
    assert.equal(modeString(0o1777), '1777', 'sticky bit must remain in the four-digit mode field');
  });

  test('never sends more bytes than the SCP header declares and reports progress', async () => {
    const channel = new PassThrough();
    const progress = [];
    const sink = new ScpSink(channel, ackReader(), 3, null, (bytes) => progress.push(bytes));
    await new Promise((resolve, reject) => {
      sink.once('finish', resolve);
      sink.once('error', reject);
      sink.end(Buffer.from('abc'));
    });
    assert.deepEqual(progress, [3]);

    const oversized = new ScpSink(new PassThrough(), ackReader(), 3);
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        oversized.once('finish', resolve);
        oversized.once('error', reject);
        oversized.end(Buffer.from('abcd'));
      }),
      (error) => error.code === 'INVALID_INPUT' && /exceeded its declared size/.test(error.message),
    );
  });

  test('does not report a truncated recursive download as successful', async () => {
    const channel = new PassThrough();
    const adapter = new ScpAdapter({}, { transport: { execRaw: async () => channel } });
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'material-scp-truncated-'));
    try {
      const transfer = adapter.downloadDirectory('/remote', root);
      channel.end(Buffer.from('D0755 0 remote\nC0644 2 file\nab\0'));
      await assert.rejects(transfer, (error) => error.category === 'protocol' && error.code === 'EPROTO');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
