'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('select-mask preview distinguishes an empty panel from a populated one', async () => {
  const dialog = await import(pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'selectmask.js')).href);
  assert.equal(dialog.selectMaskPreviewEmptyState([]), 'empty');
  assert.equal(dialog.selectMaskPreviewEmptyState([{ name: 'readme.md' }]), 'populated');
});
