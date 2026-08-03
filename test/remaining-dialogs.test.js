'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dialog = (name) => fs.readFileSync(
  path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', `${name}.js`),
  'utf8',
).replace(/\r\n/g, '\n');

test('Rights keeps its modal open until the bridge confirms the write', () => {
  const source = dialog('rights');
  assert.match(source, /onSelect: \(closeDialog\) => \{/);
  assert.match(source, /\.then\(\(count\) => \{[\s\S]*closeDialog\('action'\);/);
  assert.match(source, /\.catch\(\(err\) => \{[\s\S]*notify\.error/);
});

test('Properties keeps failures and no-op validation in the dialog', () => {
  const source = dialog('properties');
  assert.match(source, /apply\(\)\.then\(\(applied\) => \{ if \(applied\) close\('action'\); \}\)/);
  assert.match(source, /return false;/);
  assert.match(source, /catch \(err\)/);
  assert.match(source, /propsTagRequired/);
  assert.match(source, /return true;\n        \}\n        const clash/);
});

test('Properties does not report a partial local size as complete', () => {
  const source = dialog('properties');
  assert.match(source, /throw new Error\(`Could not read/);
  assert.match(source, /statsCalculated = false;/);
});

test('Symlink closes only after successful creation', () => {
  const source = dialog('symlink');
  assert.match(source, /createLink\(\)\.then\(\(created\) => \{ if \(created\) close\('action'\); \}\)/);
  assert.match(source, /return true;\n    \} catch \(err\)/);
});

test('Cleanup keeps the confirmation modal while removals are running', () => {
  const source = dialog('cleanup');
  assert.match(source, /onSelect: \(closeDialog\) => \{[\s\S]*runRemoval\(rows, closeDialog\);[\s\S]*return true;/);
  assert.match(source, /closeDialog\?\.\('removed'\)/);
});

test('File Find retains a wholly failed delete confirmation for retry', () => {
  const source = dialog('filefind');
  assert.match(source, /onSelect: \(closeDialog\) => \{[\s\S]*removeHits\(hits, closeDialog\);[\s\S]*return true;/);
  assert.match(source, /if \(!failed\.length \|\| removed\.length\) closeDialog\?\.\('deleted'\)/);
});

test('Custom-command preview invalidation covers early validation exits', () => {
  const source = dialog('customcommand');
  assert.match(source, /async function refresh\(\) \{[\s\S]*const seq = \+\+previewSeq;[\s\S]*if \(!result\.ok \|\| !draft\.command\.trim\(\)/);
});

test('Bookmark mutations restore the persisted selection after a failed write', () => {
  const source = dialog('opendirectory');
  assert.match(source, /list\.setItems\(items, false\)/);
  assert.match(source, /if \(!await save\([^\n]+\)\) \{ restore\(before\); return; \}/);
  assert.match(source, /Promise\.resolve\(props\.onAssign\(combo\)\)/);
});

test('Location-profile writes restore stored data and keep name validation open', () => {
  const source = dialog('locationprofiles');
  assert.match(source, /const restored = await readProfiles\(sessionKey\)/);
  assert.match(source, /if \(!await save\([^\n]+\)\) return false;/);
  assert.match(source, /Promise\.resolve\(props\.onOk\(name, folderInput\.value\.trim\(\)\)\)/);
});

test('async remaining-dialog actions keep the modal open until commit finishes', () => {
  const remote = dialog('remotetransfer');
  assert.match(remote, /onSelect: \(closeDialog\) => \{/);
  assert.match(remote, /void queue\(\)\.then\(\(queued\) => \{[\s\S]*closeDialog\('action'\);/);
  assert.match(remote, /return true;/);

  const mask = dialog('selectmask');
  assert.match(mask, /if \(applying\) return true;/);
  assert.match(mask, /void apply\(\)\.then\(\(\) => close\('action'\)\)\.catch/);
  assert.match(mask, /return true;/);

  const copy = dialog('copyparams');
  assert.match(copy, /if \(confirming\) return true;/);
  assert.match(copy, /void confirm\(\)\.then\(\(\) => close\('action'\)\)\.catch/);
  assert.match(copy, /async function confirm\(\)/);
});
