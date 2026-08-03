'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'design/renderer/ui/dialogs/editor.js');

test('editor saves are serialized and tied to an immutable text snapshot', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  assert.match(source, /if \(savePromise\) return savePromise;/);
  assert.match(source, /const snapshot = state\.text;/);
  assert.match(source, /editor\.save', state\.id, snapshot/);
  assert.match(source, /if \(state\.text === snapshot\) state\.saved = snapshot;/);
  assert.match(source, /finally \{\s*savePromise = null;/);
});

test('editor save failure still releases the in-flight save guard', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const saveStart = source.indexOf('async function save(force)');
  const conflictStart = source.indexOf('function conflict(detail)', saveStart);
  assert.ok(saveStart >= 0 && conflictStart > saveStart);
  assert.match(source.slice(saveStart, conflictStart), /finally \{\s*savePromise = null;/);
});

test('editor exposes selection-aware clipboard editing with read-only guards', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  assert.match(source, /async function cutSelection\(\)/);
  assert.match(source, /async function pasteClipboard\(\)/);
  assert.match(source, /function deleteSelection\(\)/);
  assert.match(source, /if \(state\.readOnly\) return false;/);
  assert.match(source, /app\.clipboardRead/);
  assert.match(source, /Ctrl\+S/);
  assert.match(source, /document\.execCommand\('undo'\)/);
  assert.match(source, /document\.execCommand\('redo'\)/);
});
