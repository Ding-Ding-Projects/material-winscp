'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScpAdapter } = require('../design/main/protocols/scp');

function adapter(commands) {
  const result = new ScpAdapter({});
  result._mustRun = async (command, label) => {
    commands.push({ command, label });
  };
  return result;
}

test('SCP Commander remote-copy honors an explicit overwrite target', async () => {
  const commands = [];
  const scp = adapter(commands);

  assert.equal(await scp.copyRemote('/source/file', '/target/file', { overwrite: true }), '/target/file');
  assert.equal(commands.length, 1);
  assert.match(commands[0].command, /^rm -rf -- '\/target\/file' && cp -a -- '\/source\/file' '\/target\/file'$/);
});

test('SCP Commander remote-copy preserves no-overwrite semantics by default', async () => {
  const commands = [];
  const scp = adapter(commands);

  await scp.copyRemote('/source/file', '/target/file');
  assert.equal(commands[0].command, "cp -a -- '/source/file' '/target/file'");
});
