'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'design/renderer/ui/dialogs/customcommand.js'), 'utf8');

test('custom command editor validates the offered shortcut set before saving', () => {
  assert.match(source, /export const CUSTOM_COMMAND_SHORTCUTS/);
  assert.match(source, /export function validateShortcut/);
  assert.match(source, /if \(!shortcutResult\.ok\)/);
  assert.match(source, /Unsupported keyboard shortcut/);
});

test('custom command list rejects duplicate shortcuts case-insensitively', () => {
  assert.match(source, /export function normaliseShortcut/);
  assert.match(source, /export function shortcutConflict/);
  assert.match(source, /shortcutConflict\(saved\.shortcut, rows, saved\.id\)/);
  assert.match(source, /Shortcut already used/);
});

test('custom command inputs expose explicit accessible names', () => {
  assert.match(source, /aria-label': tx\('Custom command pattern'/);
  assert.match(source, /aria-label': tx\('Keyboard shortcut'/);
});

test('interactive prompt validation accepts prompts without a default', () => {
  assert.match(source, /if \(c === '\?'\).*prompt\[\?default\]/s);
  assert.match(source, /const end = cmd\.indexOf\('\!', i \+ 2\)/);
  assert.match(source, /aria-live': 'polite'/);
});

test('validation feedback is announced and associated with the command field', () => {
  assert.match(source, /role: 'status'/);
  assert.match(source, /aria-describedby', validation\.id/);
  assert.match(source, /role: 'alert'/);
});
