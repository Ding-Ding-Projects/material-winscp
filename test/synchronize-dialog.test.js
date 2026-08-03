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

test('keep-up-to-date stops on an item error when continue-on-error is off', async () => {
  const { Watcher } = require('../design/main/sync');
  const { EventEmitter } = require('node:events');
  const queue = new EventEmitter();
  const adapter = { normalize: (p) => p, join: (a, b) => `${a}/${b}`, list: async () => [] };
  const watcher = new Watcher(adapter, '/local', adapter, '/remote', queue, {
    intervalMs: 1000, continueOnError: false,
  });
  const errors = [];
  const events = [];
  watcher.on('error', (error) => { errors.push(error); events.push('error'); });
  watcher.on('stopped', () => events.push('stopped'));
  watcher.start();
  const failure = new Error('upload failed');
  queue.emit('item-error', { item: { source: '/local/a.txt' }, error: failure });
  assert.equal(watcher.running, false);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(events, ['error', 'stopped'], 'the error is emitted before stopped clears the UI watcher state');
});

test('watcher reports an initial connection error after the caller subscribes', async () => {
  const { Watcher } = require('../design/main/sync');
  const { EventEmitter } = require('node:events');
  const queue = new EventEmitter();
  const adapter = {
    normalize: (p) => p,
    join: (a, b) => `${a}/${b}`,
    list: async () => { throw new Error('connection lost'); },
  };
  const watcher = new Watcher(adapter, '/local', adapter, '/remote', queue, { intervalMs: 1000 });
  const errors = [];
  watcher.start();
  watcher.on('error', (error) => errors.push(error.message));
  await new Promise((resolve) => setImmediate(resolve));
  watcher.stop();
  assert.deepEqual(errors, ['connection lost']);
});
