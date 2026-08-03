'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'design/renderer/ui/dialogs/editor.js');
const preferencesSourcePath = path.join(__dirname, '..', 'design/renderer/ui/dialogs/editorpreferences.js');

test('editor preferences keep keyboard reorder inside filtered visible rows', async () => {
  const source = await fs.readFile(preferencesSourcePath, 'utf8');
  assert.match(source, /export function moveEditorSelection\(visibleIndices, selected, key\)/);
  assert.match(source, /moveEditorSelection\(visible\(\)\.map\(\(\{ i: rowIndex \}\) => rowIndex\), i, event\.key\)/);
  assert.match(source, /data-editor-index/);
  assert.match(source, /querySelector\(`\[data-editor-index="\$\{destination\}"\]`\)/);
});

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

test('an upload completion cannot clean text typed after its save snapshot', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const eventStart = source.indexOf("else if (e.type === 'uploaded')");
  const eventEnd = source.indexOf("else if (e.type === 'orphan')", eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart);
  const branch = source.slice(eventStart, eventEnd);
  assert.match(branch, /updateStatus\(\)/);
  assert.doesNotMatch(branch, /state\.saved\s*=\s*state\.text/);
  assert.match(source.slice(source.indexOf('async function save(force)'), eventStart),
    /if \(state\.text === snapshot\) state\.saved = snapshot;/);
});

test('reload and encoding changes refresh the detected-encoding state', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const applyStart = source.indexOf('async function applyEncoding(next)');
  const reloadStart = source.indexOf('function reload()', applyStart);
  const reloadAction = source.indexOf("callMain('editor.read', state.id)", reloadStart);
  assert.ok(applyStart >= 0 && reloadStart > applyStart && reloadAction > reloadStart);
  assert.match(source.slice(applyStart, reloadStart), /state\.encodingDetected = res\.encodingDetected;/);
  assert.match(source.slice(reloadAction, source.indexOf('\n            } catch', reloadAction)),
    /state\.encodingDetected = res\.encodingDetected;/);
});

test('modeless close serializes an async unsaved-changes decision', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const closeStart = source.indexOf('async function close(reason)');
  const closeEnd = source.indexOf('\n  requestAnimationFrame', closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  const close = source.slice(closeStart, closeEnd);
  assert.match(source.slice(source.lastIndexOf('let closed = false;', closeStart), closeEnd), /let closing = false;/);
  assert.match(close, /if \(closed \|\| closing\) return false;/);
  assert.match(close, /closing = true;/);
  assert.match(close, /if \(okToClose === false\) \{ closing = false; return false; \}/);
});

test('editor exposes selection-aware clipboard editing with read-only guards', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  assert.match(source, /async function cutSelection\(\)/);
  assert.match(source, /async function pasteClipboard\(\)/);
  assert.match(source, /function deleteSelection\(\)/);
  assert.match(source, /if \(state\.readOnly\) return false;/);
  assert.match(source, /app\.clipboardRead/);
  assert.match(source, /Ctrl\+S/);
  assert.match(source, /function undo\(\)/);
  assert.match(source, /function redo\(\)/);
  assert.match(source, /disabled: state\.readOnly \|\| !history\.undo\.length/);
  assert.match(source, /disabled: state\.readOnly \|\| !history\.redo\.length/);
});

test('editor keyboard commands reach the same save, find, and navigation actions as its menus', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const keyboard = source.slice(source.indexOf("textarea.addEventListener('keydown'"), source.indexOf('/* ---------------- saving', source.indexOf("textarea.addEventListener('keydown'")));
  assert.match(keyboard, /key === 's'[\s\S]*?save\(false\)/);
  assert.match(keyboard, /key === 'g'[\s\S]*?goToInput\.focus\(\)/);
  assert.match(keyboard, /key === 'f'[\s\S]*?find\.focus\(\)/);
  assert.match(keyboard, /key === 'z'[\s\S]*?e\.shiftKey \? redo\(\) : undo\(\)/);
  assert.match(keyboard, /key === 'y'[\s\S]*?redo\(\)/);
  assert.match(keyboard, /e\.key === 'F3'[\s\S]*?findNext\(e\.shiftKey \? -1 : 1\)/);
});
