'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

test('console live events are scoped to the owning session', async () => {
  const consoleDialog = await import(pathToFileURL(
    path.join(ROOT, 'design', 'renderer', 'ui', 'dialogs', 'console.js')).href);

  assert.equal(consoleDialog.isConsoleEventForSession(
    { sessionId: 'session-a', text: 'one' }, 'session-a'), true);
  assert.equal(consoleDialog.isConsoleEventForSession(
    { sessionId: 'session-b', text: 'two' }, 'session-a'), false);
  assert.equal(consoleDialog.isConsoleEventForSession(null, 'session-a'), false);
  assert.equal(consoleDialog.isConsoleEventForSession({ text: 'unscoped' }, 'session-a'), false);
});
