'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('create-directory validation requires one safe path segment', async () => {
  const dialog = await import(pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'createdirectory.js')).href);
  assert.equal(dialog.validateDirectoryName(''), 'required');
  assert.equal(dialog.validateDirectoryName('   '), 'required');
  assert.equal(dialog.validateDirectoryName('.'), 'dot-segment');
  assert.equal(dialog.validateDirectoryName('..'), 'dot-segment');
  assert.equal(dialog.validateDirectoryName('nested/name'), 'separator');
  assert.equal(dialog.validateDirectoryName('nested\\name'), 'separator');
  assert.equal(dialog.validateDirectoryName('new-folder'), '');
});

test('OK keeps the modal open until asynchronous creation succeeds', async () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'createdirectory.js'), 'utf8');
  assert.match(source, /function submitAndClose\(\)[\s\S]*?create\(\)\.then\(\(created\) => \{ if \(created\) close\('action'\); \}\)/);
  assert.match(source, /onSelect: \(\) => \{ submitAndClose\(\); return true; \}/);
  assert.match(source, /return true;\n    \} catch \(err\)/);
  assert.match(source, /return false;\n    \}\n  \}/);
});
