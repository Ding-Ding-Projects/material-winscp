'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let driveview;

test.before(async () => {
  driveview = await import(pathToFileURL(path.join(ROOT, 'design', 'renderer', 'ui', 'driveview.js')).href);
});

test('UNC server shares are roots, so parent navigation never escapes the share', () => {
  assert.equal(driveview.uncRootOf('\\\\SERVER\\Share\\folder\\child'), '\\\\SERVER\\Share');
  assert.equal(driveview.driveParentOf('local', '\\\\SERVER\\Share'), null);
  assert.equal(driveview.driveParentOf('local', '\\\\SERVER\\Share\\folder'), '\\\\SERVER\\Share');
  assert.equal(driveview.driveParentOf('local', '\\\\SERVER'), null);
});

test('long UNC spellings normalize to the same tree root', () => {
  const ordinary = '\\\\server\\share\\folder';
  assert.equal(driveview.normalizeLocal('\\\\?\\UNC\\server\\share\\folder'), ordinary);
  assert.equal(driveview.normalizeLocal('//server/share/folder'), ordinary);
  assert.equal(driveview.uncRootOf('\\\\?\\UNC\\server\\share\\folder'), '\\\\server\\share');
});

test('drive roots keep their virtual-root boundary', () => {
  assert.equal(driveview.driveParentOf('local', 'C:\\'), null);
  assert.equal(driveview.driveJoinPath('local', 'C:\\', 'Users'), 'C:\\Users');
});
