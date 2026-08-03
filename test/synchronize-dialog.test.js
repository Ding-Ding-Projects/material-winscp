'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('keep-up-to-date controls expose stable start/stop state while awaiting IPC', async () => {
  const { watcherUiState } = await import('../design/renderer/ui/dialogs/synchronize.js');

  assert.deepStrictEqual(watcherUiState(null), {
    action: 'start', busy: false, closeDisabled: false, labelKey: 'txKutdStart',
  });
  assert.deepStrictEqual(watcherUiState(null, 'start'), {
    action: 'start', busy: true, closeDisabled: true, labelKey: 'txKutdStarting',
  });
  assert.deepStrictEqual(watcherUiState('kutd-1', 'stop'), {
    action: 'stop', busy: true, closeDisabled: true, labelKey: 'txKutdStopping',
  });
  assert.deepStrictEqual(watcherUiState('kutd-1'), {
    action: 'stop', busy: false, closeDisabled: false, labelKey: 'txKutdStop',
  });
});

test('watcher errors are assertive alerts while activity stays polite', async () => {
  const { watcherLogState } = await import('../design/renderer/ui/dialogs/synchronize.js');

  assert.deepStrictEqual(watcherLogState(), {
    role: 'status', 'aria-live': 'polite',
  });
  assert.deepStrictEqual(watcherLogState('error'), {
    role: 'alert', 'aria-live': 'assertive',
  });
});

test('keep-up-to-date tolerates queue errors without an item', async () => {
  const { Watcher } = require('../design/main/sync');
  const { EventEmitter } = require('node:events');
  const queue = new EventEmitter();
  const adapter = { normalize: (p) => p, join: (a, b) => `${a}/${b}`, list: async () => [], watch: () => ({ close() {} }) };
  const watcher = new Watcher(adapter, '/local', adapter, '/remote', queue);
  const errors = [];
  watcher.on('error', (error) => errors.push(error));
  watcher.start();
  assert.doesNotThrow(() => queue.emit('item-error', new Error('connection lost')));
  assert.equal(watcher.running, true);
  watcher.stop();
  assert.deepEqual(errors, []);
});
