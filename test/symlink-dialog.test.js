'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('symlink validation requires one safe file-name segment', async () => {
  const dialog = await import(pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'symlink.js')).href);
  assert.equal(dialog.validateSymlinkName(''), 'required');
  assert.equal(dialog.validateSymlinkName('   '), 'required');
  assert.equal(dialog.validateSymlinkName('.'), 'dot-segment');
  assert.equal(dialog.validateSymlinkName('..'), 'dot-segment');
  assert.equal(dialog.validateSymlinkName('nested/name'), 'separator');
  assert.equal(dialog.validateSymlinkName('nested\\name'), 'separator');
  assert.equal(dialog.validateSymlinkName('bad\u0000name'), 'control');
  assert.equal(dialog.validateSymlinkName('shortcut.lnk'), '');
});
