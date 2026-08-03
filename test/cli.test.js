'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const cli = require('../bin/winscp');

function output() {
  let text = '';
  return {
    stream: { write(chunk) { text += String(chunk); return true; } },
    text: () => text,
  };
}

test('headless CLI prints help and version without opening the app', async () => {
  const help = output();
  assert.equal(await cli.runCli(['--help'], { stdout: help.stream, stderr: help.stream }), 0);
  assert.match(help.text(), /winscp drag plan/);
  assert.match(help.text(), /winscp run/);

  const version = output();
  assert.equal(await cli.runCli(['--version'], { stdout: version.stream, stderr: version.stream }), 0);
  assert.match(version.text(), /^\d+\.\d+\.\d+\n$/);

  const extension = output();
  assert.equal(await cli.runCli([
    'drag', 'extension-status', '--windows-build', '17134', '--json',
  ], { stdout: extension.stream, stderr: extension.stream }), 0);
  assert.equal(JSON.parse(extension.text()).brokenOnThisWindows, true);
});

test('nested drag and drop help stays headless and succeeds', async () => {
  for (const args of [
    ['drag', '--help'],
    ['drop', '-h'],
    ['drag', 'plan', '--help'],
    ['drop', 'target', 'help'],
  ]) {
    const nested = output();
    assert.equal(await cli.runCli(args, { stdout: nested.stream, stderr: nested.stream }), 0);
    assert.match(nested.text(), /winscp drag plan/);
    assert.equal(nested.text().includes('No session manager is available'), false);
  }
});

test('URL parsing is headless and redacts credentials in structured output', async () => {
  const result = output();
  assert.equal(await cli.runCli([
    'url', 'parse', 'sftp://alice:secret@example.com:2222/home/report.txt', '--want-file', '--pretty',
  ], { stdout: result.stream, stderr: result.stream }), 0);
  const parsed = JSON.parse(result.text());
  assert.equal(parsed.url, 'sftp://alice:***@example.com:2222/home/report.txt');
  assert.equal(parsed.session.protocol, 'sftpOnly');
  assert.equal(parsed.session.hostName, 'example.com');
  assert.equal(parsed.session.fileName, 'report.txt');
  assert.equal(parsed.session.remoteDirectory, '/home/');
  assert.equal(parsed.session.hasPassword, true);
  assert.equal(result.text().includes('secret'), false, 'URL utilities must not print passwords');
});

test('URL generation supports protocol, user, IPv6 and WinSCP-specific schemes', async () => {
  const generated = cli.generateSessionUrl([
    '--protocol', 'sftp', '--host', '2001:db8::1', '--port', '2222', '--username', 'alice', '--specific',
  ]);
  assert.equal(generated.url, 'winscp-sftp://alice@[2001:db8::1]:2222/');
  assert.match(generated.openCommand, /^sftp:\/\/alice@\[2001:db8::1\]:2222\//);

  const result = output();
  assert.equal(await cli.runCli([
    'url', 'generate', '--protocol', 'ftps', '--host', 'files.example.com', '--username', 'backup',
  ], { stdout: result.stream, stderr: result.stream }), 0);
  assert.equal(JSON.parse(result.text()).url, 'ftps://backup@files.example.com/');
});

test('URL utilities reject malformed input before any session starts', async () => {
  assert.throws(() => cli.parseSessionUrl(['not-a-session']), /supported session URL/);
  assert.throws(() => cli.generateSessionUrl(['--host', 'example.com', '--port', '0']), /1 through 65535/);
  assert.throws(() => cli.generateSessionUrl(['--protocol', 'telnet', '--host', 'example.com']), /must be one of/);
});

test('simulation output is compact JSON by default and pretty JSON on request', async () => {
  const compact = output();
  assert.equal(await cli.runCli(['drag', 'plan', '--source', 'remote'], {
    stdout: compact.stream, stderr: compact.stream,
  }), 0);
  assert.equal(compact.text().includes('\n  '), false);
  assert.deepEqual(JSON.parse(compact.text()).source, 'remote');

  const pretty = output();
  assert.equal(await cli.runCli(['drag', 'plan', '--source', 'remote', '--pretty'], {
    stdout: pretty.stream, stderr: pretty.stream,
  }), 0);
  assert.match(pretty.text(), /\n  "command":/);
  assert.deepEqual(JSON.parse(pretty.text()).source, 'remote');
});

test('drag plan rejects stray positional arguments instead of reporting a no-op plan', () => {
  assert.throws(() => cli.dragPlan(['--source', 'remote', 'typo']), /does not accept positional arguments/);
});

test('winscp-com prints help and version without starting the console runner', () => {
  const entry = path.join(__dirname, '..', 'bin', 'winscp-com.js');
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /console-compatible WinSCP command line/);
  assert.equal(help.stderr, '');

  const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${require('../package.json').version}\n`);
  assert.equal(version.stderr, '');
});

test('convenience commands translate to the existing console runner switches', () => {
  assert.deepEqual(cli.buildConsoleArgs([
    'deploy.txt', '--parameter', 'production', '--command', 'exit', 'sftp://host/',
  ], 'script'), [
    '/console', '/script=deploy.txt', '/parameter', 'production', '/command', 'exit', 'sftp://host/',
  ]);
  assert.deepEqual(cli.buildConsoleArgs([
    '--command', 'open sftp://host/', '--command', 'exit', '--session', 'stored-site',
  ], 'command'), [
    '/console', '/command', 'open sftp://host/', 'exit', 'stored-site',
  ]);
  assert.deepEqual(cli.buildConsoleArgs(['open sftp://host/', 'exit'], 'command'), [
    '/console', '/command', 'open sftp://host/', 'exit',
  ]);
});

test('convenience commands group repeated variadic switches for the console parser', () => {
  assert.deepEqual(cli.buildConsoleArgs([
    '--parameter', 'production', '--parameter', 'eu-west',
    '--command', 'echo one', '--command', 'echo two',
  ], 'command'), [
    '/console', '/parameter', 'production', 'eu-west',
    '/command', 'echo one', 'echo two',
  ]);
});

test('the executable convenience command consumes every command and exits', () => {
  const entry = path.join(__dirname, '..', 'bin', 'winscp.js');
  const run = spawnSync(process.execPath, [entry, 'command', 'echo one', 'echo two', 'exit'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /one/);
  assert.match(run.stdout, /two/);
  assert.equal(run.stdout.includes('winscp> '), false, 'batch commands must not fall into an interactive prompt');
  assert.equal(run.stderr, '');
});

test('the executable legacy run accepts repeated variadic switches', () => {
  const entry = path.join(__dirname, '..', 'bin', 'winscp.js');
  const run = spawnSync(process.execPath, [
    entry, 'run', '/command', 'echo one', '/command', 'echo two', '/command', 'exit',
  ], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /one/);
  assert.match(run.stdout, /two/);
  assert.equal(run.stdout.includes('winscp> '), false);
  assert.equal(run.stdout.includes('Opening session using command-line parameter'), false);
  assert.equal(run.stderr, '');
});

test('convenience commands forward the console runner control switches', () => {
  assert.deepEqual(cli.buildConsoleArgs([
    'deploy.txt', '--log', 'run.log', '--loglevel', '2', '--xmllog', 'actions.xml',
    '--xmllogrequired', '--xmlgroups=false', '--stdout', 'chunked', '--stdin', 'binary',
    '--nointeractiveinput', '--unsafe', '--command', 'exit',
  ], 'script'), [
    '/console', '/script=deploy.txt', '/command', 'exit',
    '/log=run.log', '/loglevel=2', '/xmllog=actions.xml', '/stdout=chunked', '/stdin=binary',
    '/xmllogrequired', '/nointeractiveinput', '/unsafe', '/xmlgroups=off',
  ]);
});

test('convenience commands forward INI and raw-settings switches', () => {
  assert.deepEqual(cli.buildConsoleArgs([
    'deploy.txt', '--ini', 'nul', '--rawsettings', 'FSProtocol2\u003d2', '--command', 'exit',
  ], 'script'), [
    '/console', '/script=deploy.txt', '/command', 'exit', '/ini=nul',
    '/rawsettings=FSProtocol2\u003d2',
  ]);
});

test('drag plan uses the safe ambiguous-result rule and capability checks', () => {
  const remoteToLocal = cli.dragPlan([
    '--source', 'remote', '--result', 'invalid', '--last-effect', 'move', '--queue',
  ]);
  assert.equal(remoteToLocal.operation, 'move');
  assert.equal(remoteToLocal.forceQueue, true);

  const localToRemote = cli.dragPlan([
    '--source', 'local', '--last-effect', 'move', '--allow-move=false', '--read-only',
  ]);
  assert.equal(localToRemote.operation, 'copy');
  assert.equal(localToRemote.accepted.ok, false);
  assert.match(localToRemote.accepted.reason, /read-only/);

  const sessionTab = cli.dragPlan([
    '--source', 'remote', '--destination', 'remote', '--onto-session-tab', '--same-session',
    '--last-effect', 'move', '--target-available=false',
  ]);
  assert.equal(sessionTab.operation, null);
  assert.equal(sessionTab.effectiveOperation, null);
  assert.throws(() => cli.dragPlan(['--source', 'local', '--destination', 'local']), /local-to-local/);
  assert.throws(() => cli.dragPlan(['--soruce', 'local']), /unknown option/);
  assert.throws(() => cli.dragPlan(['--windows-build', 'nope']), /windows-build/);
});

test('drop classify reports files, directories and missing paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winscp-cli-classify-'));
  const file = path.join(root, 'file.txt');
  const dir = path.join(root, 'folder');
  fs.writeFileSync(file, 'hello');
  fs.mkdirSync(dir);
  try {
    const result = cli.classifyDrop([file, dir, path.join(root, 'gone.txt'), '--last-effect', 'move']);
    assert.equal(result.operation, 'move');
    assert.equal(result.effectiveOperation, 'move');
    assert.deepEqual(result.classification.files.map((item) => item.name), ['file.txt']);
    assert.deepEqual(result.classification.directories.map((item) => item.name), ['folder']);
    assert.equal(result.classification.missing.length, 1);
    assert.equal(result.accepted.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drag stage exercises the real temporary-folder payload and cleans it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winscp-cli-stage-'));
  const file = path.join(root, 'report.txt');
  fs.writeFileSync(file, 'report');
  try {
    const result = await cli.stageDrag([file]);
    assert.equal(result.operation, 'copy');
    assert.equal(result.requestedOperation, 'copy');
    assert.equal(result.sourcePreserved, true);
    assert.deepEqual(result.shellPayload, { file: result.payload[0] });
    assert.equal(fs.existsSync(result.stagingDirectoryBeforeCleanup), false);
    assert.equal(result.cleanedUp, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drag stage rejects an empty path instead of staging the current directory', async () => {
  await assert.rejects(() => cli.stageDrag(['--file=']), /paths cannot be empty/);
});

test('drop classify refuses empty and missing-only drops', () => {
  assert.throws(() => cli.classifyDrop([]), /at least one PATH/);
  const result = cli.classifyDrop(['definitely-not-present.txt', '--last-effect', 'move']);
  assert.equal(result.operation, null);
  assert.equal(result.effectiveOperation, null);
  assert.equal(result.classification.items.length, 0);
  assert.equal(result.accepted.ok, false);
  assert.match(result.accepted.reason, /No existing files or directories/);
});

test('drop target exercises the same Explorer target policy as IPC', async () => {
  const queue = output();
  assert.equal(await cli.runCli(['drop', 'target', '--queue', '--default-download-target', 'C:\\Downloads'], {
    stdout: queue.stream, stderr: queue.stream,
  }), 0);
  assert.deepEqual(JSON.parse(queue.text()), {
    command: 'drop target', ok: true, directory: 'C:\\Downloads', forceQueue: true,
    counterName: 'DownloadsDragDropQueue',
  });
  assert.equal(cli.dropTarget([]).ok, false);
  assert.equal(cli.dropTarget(['--queue', '--default-download-target', '   ']).ok, false);
  assert.equal(cli.dropTarget(['--fake-file-target', 'C:\\Temp\\scp12345\\report.txt']).directory, 'C:\\Temp\\scp12345');
});
