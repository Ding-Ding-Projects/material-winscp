'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const forge = require('../forge.config');
const workflow = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

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

test('CI refuses an incomplete Squirrel update set', () => {
  assert.match(workflow, /missing=\(\)/);
  assert.match(workflow, /missing\+=\("\.nupkg"\)/);
  assert.match(workflow, /missing\+=\("RELEASES"\)/);
  assert.match(workflow, /required Squirrel artefacts/);
});
