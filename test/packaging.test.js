'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const forge = require('../forge.config');

function isIgnored(relativePath) {
  const normalized = `/${relativePath.replaceAll('\\', '/')}`;
  return forge.packagerConfig.ignore.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(normalized) : new RegExp(pattern).test(normalized));
}

test('packaging excludes linked-agent worktrees from the shipped app', () => {
  assert.equal(isIgnored('.claude/worktrees/example/node_modules'), true);
});

test('packaging excludes its own output directory', () => {
  assert.equal(isIgnored('out/WinSCP Material-win32-x64/resources/app.asar'), true);
});
