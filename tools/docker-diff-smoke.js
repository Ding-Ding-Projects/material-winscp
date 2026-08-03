// docker-diff-smoke.js — an opt-in, throwaway-server smoke for the real app.
//
// This is intentionally not part of `npm test`: Docker is a useful local
// integration dependency, not a requirement for the deterministic unit and
// in-process end-to-end suites. The script starts two isolated containers,
// drives the real Electron bridge against both, and removes only the two
// containers it created.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startApp } = require('../test/helpers/app-harness');

const DOCKER = process.env.DOCKER || 'docker';
const PREFIX = `winscp-docker-diff-${process.pid}-${Date.now().toString(36)}`;
const NAMES = { sftp: `${PREFIX}-sftp`, ftp: `${PREFIX}-ftp` };
const PASSWORD = `ephemeral-${crypto.randomBytes(18).toString('hex')}`;
const USER = 'diffuser';
const CONTAINER_LIMITS = ['--cpus', '1', '--memory', '512m', '--pids-limit', '128'];

async function createSecretEnv() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${PREFIX}-secrets-`));
  const file = path.join(root, 'docker.env');
  await fsp.writeFile(file, [
    `SFTP_USER=${USER}`,
    `SFTP_PASSWORD=${PASSWORD}`,
    `FTP_USER_NAME=${USER}`,
    `FTP_USER_PASS=${PASSWORD}`,
    `FTP_USER_HOME=/home/ftpusers/${USER}`,
    '',
  ].join('\n'), { mode: 0o600 });
  return { root, file };
}

function docker(args, options = {}) {
  const { allowFailure, timeout = 60000, ...spawnOptions } = options;
  const result = spawnSync(DOCKER, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    ...spawnOptions,
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : result.error.message;
    if (!allowFailure) throw new Error(`Docker could not complete: ${reason}`);
    return '';
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Docker ${args[0] || 'command'} failed${detail ? `: ${detail}` : '.'}`);
  }
  return String(result.stdout || '').trim();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Reserve a contiguous host range briefly, then let Docker claim it. */
async function freePortRange(size, start = 20000, end = 45000) {
  for (let base = start; base + size <= end; base += size + 1) {
    const servers = [];
    try {
      for (let i = 0; i < size; i++) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(base + i, '127.0.0.1', resolve);
        });
        servers.push(server);
      }
      for (const server of servers) await new Promise((resolve) => server.close(() => resolve()));
      return base;
    } catch {
      for (const server of servers) await new Promise((resolve) => server.close(() => resolve()));
    }
  }
  throw new Error(`Could not find ${size} consecutive free localhost ports.`);
}

async function waitForPort(port, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`${label} did not listen on 127.0.0.1:${port}.`);
}

function readFtpReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let multiCode = null;
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const finish = (reply) => { cleanup(); resolve(reply); };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('FTP control connection closed before its reply'));
    const onTimeout = () => fail(new Error('FTP control reply timed out'));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        if (match[2] === '-' && multiCode === null) {
          multiCode = match[1];
          continue;
        }
        if (multiCode === null || (match[1] === multiCode && match[2] === ' ')) {
          finish({ code: Number(match[1]), line });
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
    socket.setTimeout(2000);
  });
}

async function waitForFtpBanner(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    let socket = null;
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection({ host: '127.0.0.1', port });
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', reject);
        candidate.setTimeout(2000, () => { candidate.destroy(); reject(new Error('FTP connect timed out')); });
      });
      const banner = await readFtpReply(socket);
      if (banner.code !== 220) throw new Error(`FTP banner was ${banner.code}`);
      socket.write('QUIT\r\n');
      await readFtpReply(socket).catch(() => undefined);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      if (socket) socket.destroy();
      await sleep(150);
    }
  }
  throw new Error(`the Docker FTP server did not provide a complete banner: ${lastError && lastError.message}`);
}

function removeContainer(name) {
  try {
    // Docker Desktop can occasionally leave a stopped container in a removal
    // transition. Never let that daemon state turn one failed attempt into a
    // 100-minute retry loop, and never reuse the name while removal is still
    // pending.
    docker(['rm', '--force', '--volumes', name], { allowFailure: true, timeout: 10000 });
    const remaining = docker([
      'inspect', '--format', '{{.State.Status}}', name,
    ], { allowFailure: true, timeout: 3000 });
    if (remaining) {
      console.error(`Docker container ${name} is still present after cleanup: ${remaining}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Could not clean up Docker container ${name}: ${error.message}`);
    return false;
  }
}

async function startSftp(secretFile) {
  docker([
    'run', '--detach', '--rm', '--name', NAMES.sftp, ...CONTAINER_LIMITS,
    '--env-file', secretFile,
    '--publish', '127.0.0.1::22',
    '--entrypoint', '/bin/sh', 'atmoz/sftp:latest',
    '-c', 'exec /entrypoint "$SFTP_USER:$SFTP_PASSWORD:::upload"',
  ]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const published = docker(['port', NAMES.sftp, '22/tcp'], { allowFailure: true });
    const match = published.match(/:(\d+)\s*$/m);
    if (match) {
      const port = Number(match[1]);
      await waitForPort(port, 'the Docker SFTP server');
      return { port, root: '/upload' };
    }
    await sleep(150);
  }
  throw new Error('Docker SFTP did not publish a port.');
}

async function startFtp(secretFile) {
  // Pure-FTPd advertises its passive ports in the PASV response. Mapping the
  // same contiguous range on the host keeps that response truthful.
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const start = 20000 + attempt * 12;
    let base;
    try { base = await freePortRange(11, start, start + 11); } catch { continue; }
    try {
      docker([
        'run', '--detach', '--rm', '--name', NAMES.ftp, ...CONTAINER_LIMITS,
        '--env-file', secretFile,
        '--env', 'PUBLICHOST=127.0.0.1',
        '--env', `FTP_PASSIVE_PORTS=${base + 1}:${base + 10}`,
        '--publish', `127.0.0.1:${base}:21`,
        '--publish', `127.0.0.1:${base + 1}-${base + 10}:${base + 1}-${base + 10}`,
        'stilliard/pure-ftpd:latest',
      ]);
      await waitForPort(base, 'the Docker FTP server');
      // Pure-FTPd publishes port 21 before its account setup is complete. A
      // TCP accept is therefore not a sufficient readiness signal: wait for a
      // complete banner, then let the real app own the only login attempt.
      await waitForFtpBanner(base);
      return { port: base, root: '/' };
    } catch (error) {
      lastError = error;
      if (!removeContainer(NAMES.ftp)) {
        throw new Error(`Docker FTP startup failed and ${NAMES.ftp} could not be cleaned up: ${error.message}`);
      }
    }
  }
  throw lastError || new Error('Docker FTP did not find a usable port range.');
}

function siteFor(kind, server) {
  return {
    name: `Docker ${kind.toUpperCase()} diff smoke`,
    protocol: kind,
    hostName: '127.0.0.1',
    portNumber: server.port,
    userName: USER,
    password: PASSWORD,
    savePassword: true,
    timeout: 15,
    cacheDirectories: false,
    updateDirectories: false,
    ...(kind === 'sftp' ? {
      tryAgent: false,
      authKI: false,
      sshNoUserAuth: false,
      publicKeyFile: '',
    } : {
      ftpPasvMode: true,
      ftpListAll: 'auto',
      ftpPingType: 'off',
      ftps: 'none',
    }),
  };
}

async function openSession(app, kind, server) {
  const site = await app.ok('config.addSite', siteFor(kind, server));
  let reply = null;
  if (kind === 'sftp') {
    const opening = app.api('session.open', { siteId: site.id, connect: true });
    const prompt = await app.waitForEvent('event:prompt', (p) => p.kind === 'hostKey', 30000);
    await app.ok('session.answerPrompt', prompt.sessionId, prompt.promptId,
      { accept: true, remember: true });
    reply = await opening;
  } else {
    // Pure-FTPd can finish its banner a fraction before its authentication
    // worker is ready. Retry the real application session, rather than making
    // a second FTP client compete for one of the container's limited slots.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        reply = await app.api('session.open', { siteId: site.id, connect: true });
      } catch (error) {
        reply = { ok: false, error: { message: error.message } };
      }
      if (reply.ok || attempt === 4) break;
      await sleep(500);
    }
  }
  assert.equal(reply.ok, true, `${kind} Docker session failed: ${JSON.stringify(reply.error)}`);
  assert.equal(reply.value.connected, true);
  return { id: reply.value.id, siteId: site.id };
}

async function mkdir(app, sessionId, remotePath) {
  const reply = await app.api('fs.mkdir', sessionId, remotePath);
  assert.equal(reply.ok, true, `Could not create remote directory ${remotePath}`);
}

async function writeRemote(app, sessionId, remotePath, value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  await app.ok('fs.writeFile', sessionId, remotePath, content.toString('base64'));
}

function remoteJoin(root, relative) {
  return root === '/' ? `/${relative}` : `${root}/${relative}`;
}

async function readRemote(app, sessionId, remotePath) {
  const result = await app.ok('fs.readFile', sessionId, remotePath);
  return Buffer.from(result.base64, 'base64');
}

async function makeLocalTree(root) {
  await fsp.mkdir(path.join(root, 'nested'), { recursive: true });
  const files = {
    'same.txt': 'same',
    'local-only.txt': 'local-only',
    'different-size.bin': 'local version is longer',
    'same-size-diff.txt': 'abcd',
    'nested/local-deep.txt': 'deep local',
    '你好 remote.txt': 'unicode and spaces',
    'include.mask.txt': 'mask candidate',
    'empty.local': '',
    'Case.txt': 'case-folded pair',
  };
  for (const [relative, value] of Object.entries(files)) {
    await fsp.writeFile(path.join(root, relative), value);
  }
  return files;
}

async function makeRemoteTree(app, sessionId, root) {
  await mkdir(app, sessionId, remoteJoin(root, 'nested'));
  const files = {
    'same.txt': 'same',
    'remote-only.txt': 'remote-only',
    'different-size.bin': 'short',
    'same-size-diff.txt': 'wxyz',
    'nested/remote-deep.txt': 'deep remote',
    '你好 space.txt': 'unicode and spaces',
    'ignore.bin': 'not selected by mask',
    'empty.remote': '',
    'case.txt': 'case-folded pair',
  };
  for (const [relative, value] of Object.entries(files)) {
    await writeRemote(app, sessionId, remoteJoin(root, relative), value);
  }
  return files;
}

function itemName(item) {
  return item.local?.name || item.remote?.name || '';
}

async function waitForDone(app, ids) {
  const pending = new Set(ids);
  while (pending.size) {
    const event = await app.waitForEvent('event:queue',
      (p) => (p.type === 'item-done' && p.item && pending.has(p.item.id))
        || p.type === 'item-error', 30000);
    if (event.type === 'item-error') {
      throw new Error(`Docker queue item failed: ${JSON.stringify(event)}`);
    }
    assert.equal(event.item.state, 'done', `Docker transfer ${event.item.id} did not finish cleanly`);
    assert.equal(event.item.error, null);
    pending.delete(event.item.id);
  }
}

async function compareAndApply(app, kind, sessionId, localPath, remotePath) {
  const result = await app.ok('sync.compare', {
    sessionId,
    localPath,
    remotePath,
    direction: 'remote',
    mode: 'synchronize',
    criteria: 'size',
    recursive: true,
    deleteFiles: true,
    existingOnly: false,
    caseSensitive: false,
    transferMode: 'binary',
    copyParam: { transferMode: 'binary', preserveTime: false },
    preview: true,
  });

  assert.ok(result.items.length >= 9,
    `${kind} diff checklist was suspiciously small: ${JSON.stringify(result.counts)}`);
  assert.ok(result.counts.upload >= 3, `${kind} missed local uploads: ${JSON.stringify(result.counts)}`);
  assert.ok(result.counts.deleteRemote >= 2,
    `${kind} missed remote-only deletions: ${JSON.stringify(result.counts)}`);

  const byName = new Map(result.items.map((item) => [itemName(item), item]));
  assert.equal(byName.get('local-only.txt')?.action, 'upload');
  assert.equal(byName.get('different-size.bin')?.action, 'upload');
  assert.equal(byName.get('remote-only.txt')?.action, 'deleteRemote');
  assert.equal(byName.get('same-size-diff.txt'), undefined,
    `${kind} treated equal-size content as detectable without a checksum`);
  assert.ok([...byName.keys()].some((name) => name.includes('你好')),
    `${kind} lost the Unicode filename during comparison`);
  assert.ok([...byName.values()].some((item) => /nested[\\/]/.test(item.local?.path || '')),
    `${kind} did not recurse into nested directories`);
  // Keep the diff smoke focused on protocol correctness rather than making a
  // small Docker SSH daemon the concurrency benchmark. The normal queue and
  // parallel-transfer suites cover the higher setting separately.
  await app.ok('queue.setLimit', 1);
  const applied = await app.ok('sync.apply', {
    token: result.token,
    checked: result.items.map((item) => item.checked),
    onlyChecked: true,
    performDeletions: true,
  });
  await waitForDone(app, (applied.items || []).map((item) => item.id));
  await sleep(1000);
  await app.ok('session.disconnect', sessionId);
  await app.ok('session.reconnect', sessionId);

  const listing = await app.ok('fs.list', sessionId, remotePath, { refresh: true });
  assert.ok(listing.some((entry) => entry.name === 'local-only.txt'));
  assert.ok(listing.every((entry) => entry.name !== 'remote-only.txt'));
  assert.ok((await readRemote(app, sessionId, remoteJoin(remotePath, 'different-size.bin')))
    .equals(Buffer.from('local version is longer')));
  assert.ok((await readRemote(app, sessionId, remoteJoin(remotePath, 'same-size-diff.txt')))
    .equals(Buffer.from('wxyz')),
  `${kind} changed an equal-size file that the size criterion cannot distinguish`);

  // Exercise a one-way download comparison and the recursion boundary after
  // the upload pass. This catches a direction flip that a single mirror test
  // would never see.
  await writeRemote(app, sessionId, remoteJoin(remotePath, 'download-only.txt'), 'from remote');
  await fsp.writeFile(path.join(localPath, 'delete-on-local.txt'), 'delete when mirroring local side');
  const reverse = await app.ok('sync.compare', {
    sessionId,
    localPath,
    remotePath,
    direction: 'local',
    mode: 'synchronize',
    criteria: 'size',
    recursive: false,
    deleteFiles: true,
    existingOnly: false,
    caseSensitive: false,
    transferMode: 'binary',
    copyParam: { transferMode: 'binary' },
    preview: true,
  });
  assert.equal(reverse.items.find((item) => itemName(item) === 'download-only.txt')?.action,
    'download', `${kind} did not detect the remote-only download`);
  assert.equal(reverse.items.find((item) => itemName(item) === 'delete-on-local.txt')?.action,
    'deleteLocal', `${kind} did not detect the local-only delete`);
  assert.ok(!reverse.items.some((item) => /nested[\\/]/.test(item.local?.path || '')),
    `${kind} crossed a non-recursive comparison boundary`);

  // Exercise the policy switches independently of the main mirror. A single
  // happy-path comparison can pass while the UI silently ignores a mask or
  // turns a non-destructive preview into a deletion plan.
  await writeRemote(app, sessionId, remoteJoin(remotePath, 'mask.txt'), 'remote mask');
  await writeRemote(app, sessionId, remoteJoin(remotePath, 'mask.bin'), 'remote binary');
  await fsp.writeFile(path.join(localPath, 'mask.txt'), 'local mask');
  await fsp.writeFile(path.join(localPath, 'mask.bin'), 'local binary');
  const masked = await app.ok('sync.compare', {
    sessionId, localPath, remotePath, direction: 'remote', mode: 'synchronize',
    criteria: 'size', recursive: true, deleteFiles: false, existingOnly: false,
    caseSensitive: false, fileMask: '*.txt', transferMode: 'binary',
    copyParam: { transferMode: 'binary' }, preview: true,
  });
  assert.equal(masked.items.some((item) => itemName(item) === 'mask.txt'), true,
    `${kind} ignored an include mask for a matching file`);
  assert.equal(masked.items.some((item) => itemName(item) === 'mask.bin'), false,
    `${kind} let a non-matching file through an include mask`);
  assert.equal(masked.items.some((item) => item.action === 'deleteRemote' && item.checked), false,
    `${kind} checked a deletion when deleteFiles was disabled`);

  await writeRemote(app, sessionId, remoteJoin(remotePath, 'existing-only-remote.txt'), 'remote only');
  await fsp.writeFile(path.join(localPath, 'existing-only-local.txt'), 'local only');
  const existingOnly = await app.ok('sync.compare', {
    sessionId, localPath, remotePath, direction: 'remote', mode: 'synchronize',
    criteria: 'size', recursive: false, deleteFiles: true, existingOnly: true,
    caseSensitive: false, transferMode: 'binary', copyParam: { transferMode: 'binary' },
    preview: true,
  });
  assert.equal(existingOnly.items.some((item) => itemName(item) === 'existing-only-local.txt' && item.checked), false,
    `${kind} existingOnly checked a new upload`);
  assert.equal(existingOnly.items.some((item) => itemName(item) === 'existing-only-remote.txt' && item.checked), false,
    `${kind} existingOnly checked a new deletion`);

  // Checksum support is protocol/server dependent. When the real server
  // advertises it, require the comparison engine to use it; when it does not,
  // keep the smoke honest by recording an explicit unsupported result rather
  // than silently pretending a size comparison was a checksum comparison.
  let checksum = { supported: false };
  let remoteChecksum = null;
  try {
    await writeRemote(app, sessionId, remoteJoin(remotePath, 'checksum-probe.txt'), 'BBBB');
    await fsp.writeFile(path.join(localPath, 'checksum-probe.txt'), 'AAAA');
    remoteChecksum = await app.ok('fs.checksum', sessionId,
      remoteJoin(remotePath, 'checksum-probe.txt'), 'sha256');
  } catch (error) {
    checksum = { supported: false, reason: String(error.message || error).slice(0, 160) };
  }
  if (remoteChecksum !== null) {
    const checked = await app.ok('sync.compare', {
      sessionId, localPath, remotePath, direction: 'remote', mode: 'synchronize',
      criteria: 'checksum', recursive: false, deleteFiles: false, existingOnly: false,
      caseSensitive: false, fileMask: 'checksum-probe.txt', transferMode: 'binary',
      copyParam: { transferMode: 'binary' }, preview: true,
    });
    assert.equal(checked.items.find((item) => itemName(item) === 'checksum-probe.txt')?.action,
      'upload', `${kind} checksum comparison missed an equal-size content change`);
    checksum = { supported: true, items: checked.items.length };
  }

  return {
    checklistItems: result.items.length,
    upload: result.counts.upload,
    deleteRemote: result.counts.deleteRemote,
    reverseItems: reverse.items.length,
    maskedItems: masked.items.length,
    existingOnlyItems: existingOnly.items.length,
    checksum,
  };
}

async function main() {
  let app = null;
  let localRoot = null;
  let secretRoot = null;
  try {
    // Pulls are deliberately explicit: a missing image is an actionable setup
    // failure, not permission to silently fall back to an in-process fake.
    docker(['image', 'inspect', 'atmoz/sftp:latest']);
    docker(['image', 'inspect', 'stilliard/pure-ftpd:latest']);
    const secrets = await createSecretEnv();
    secretRoot = secrets.root;
    const [sftp, ftp] = await Promise.all([startSftp(secrets.file), startFtp(secrets.file)]);
    await fsp.rm(secretRoot, { recursive: true, force: true });
    secretRoot = null;
    localRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-docker-diff-'));
    app = await startApp();
    await app.ok('config.setPrefs', { logging: { enabled: true, level: 2 } }, 'docker diff smoke logging');

    const results = {};
    for (const [kind, server] of [['sftp', sftp], ['ftp', ftp]]) {
      const session = await openSession(app, kind, server);
      const localPath = path.join(localRoot, kind);
      await fsp.mkdir(localPath, { recursive: true });
      await makeLocalTree(localPath);
      await makeRemoteTree(app, session.id, server.root);
      results[kind] = await compareAndApply(app, kind, session.id, localPath, server.root);
      await app.ok('session.close', session.id);
      console.log(`${kind}: ${JSON.stringify(results[kind])}`);
    }
    console.log(`Docker diff smoke passed for ${Object.keys(results).length} real protocols.`);
  } finally {
    if (app) await app.stop().catch(() => undefined);
    if (localRoot) await fsp.rm(localRoot, { recursive: true, force: true }).catch(() => undefined);
    if (secretRoot) await fsp.rm(secretRoot, { recursive: true, force: true }).catch(() => undefined);
    removeContainer(NAMES.sftp);
    removeContainer(NAMES.ftp);
    console.log('Throwaway Docker cleanup requested; any daemon-side removal failure was reported above.');
  }
}

main().catch((error) => {
  console.error(`Docker diff smoke failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
