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
    '/console', '/command', 'open sftp://host/', '/command', 'exit', 'stored-site',
  ]);
  assert.deepEqual(cli.buildConsoleArgs(['open sftp://host/', 'exit'], 'command'), [
    '/console', '/command', 'open sftp://host/', '/command', 'exit',
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

test('drop classify refuses empty and missing-only drops', () => {
  assert.throws(() => cli.classifyDrop([]), /at least one PATH/);
  const result = cli.classifyDrop(['definitely-not-present.txt', '--last-effect', 'move']);
  assert.equal(result.operation, null);
  assert.equal(result.effectiveOperation, null);
  assert.equal(result.classification.items.length, 0);
});
