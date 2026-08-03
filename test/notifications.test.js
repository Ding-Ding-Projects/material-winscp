// notifications.test.js — persistence and safety contracts for the renderer centre.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let notifications;
let state;
test.before(async () => {
  notifications = await import(pathToFileURL(path.join(ROOT, 'design/renderer/ui/notifications.js')).href);
  state = await import(pathToFileURL(path.join(ROOT, 'design/renderer/state.js')).href);
  state.setPersistenceEnabled(false);
});

test('notification snapshots survive reload without persisting executable actions', () => {
  const onSelect = () => { throw new Error('must not be persisted'); };
  const snapshot = notifications.serializeNotification({
    id: 'transfer-7', kind: 'error', title: 'Transfer failed', body: '/safe/path',
    at: 1234, read: false, dismissed: true, progress: 4,
    actions: [{ label: 'Retry', onSelect }],
  });

  assert.deepEqual(snapshot, {
    id: 'transfer-7', kind: 'error', title: 'Transfer failed', body: '/safe/path',
    at: 1234, read: false, dismissed: true, progress: 1,
  });
  assert.equal('actions' in snapshot, false);
  assert.deepEqual(notifications.restoreNotification(snapshot).actions, []);
});

test('stored history is restored and malformed rows are ignored', () => {
  state.store.set('notifications.history', [
    { id: 'old-1', kind: 'warning', title: 'Saved warning', body: '', at: 5, read: true },
    { id: '', kind: 'error', title: 'Should be ignored', at: 6 },
    null,
  ]);

  assert.deepEqual(notifications.notificationHistory(), [{
    id: 'old-1', kind: 'warning', title: 'Saved warning', body: '', at: 5,
    read: true, dismissed: false, actions: [],
  }]);

  notifications.clearHistory();
  assert.deepEqual(notifications.notificationHistory(), []);
});

test('the production module writes history through the existing notifications preference', () => {
  const source = fs.readFileSync(path.join(ROOT, 'design/renderer/ui/notifications.js'), 'utf8');
  assert.match(source, /store\.get\('notifications\.history'\)/);
  assert.match(source, /store\.set\('notifications\.history'/);
  assert.match(source, /persistCurrent\('notifications'\)/);
});

test('progress values are normalized before they reach the accessible bar', () => {
  const source = fs.readFileSync(path.join(ROOT, 'design/renderer/ui/notifications.js'), 'utf8');
  assert.match(source, /progress: normalizedProgress\(opts\.progress\)/);
  assert.match(source, /record\.progress = normalizedProgress\(record\.progress\)/);
  assert.match(source, /function normalizedProgress\(value\)/);
  assert.match(source, /function keepLatestToastVisible\(\)/);
  assert.match(source, /stack\(\)\.appendChild\(el\);[\s\S]*?keepLatestToastVisible\(\);/);
});
