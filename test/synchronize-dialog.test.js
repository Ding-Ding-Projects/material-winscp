'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('keep-up-to-date controls expose stable start/stop state while awaiting IPC', async () => {
  const { watcherUiState } = await import('../design/renderer/ui/dialogs/synchronize.js');

  assert.deepStrictEqual(watcherUiState(null), {
    action: 'start', busy: false, labelKey: 'txKutdStart',
  });
  assert.deepStrictEqual(watcherUiState(null, 'start'), {
    action: 'start', busy: true, labelKey: 'txKutdStarting',
  });
  assert.deepStrictEqual(watcherUiState('kutd-1', 'stop'), {
    action: 'stop', busy: true, labelKey: 'txKutdStopping',
  });
  assert.deepStrictEqual(watcherUiState('kutd-1'), {
    action: 'stop', busy: false, labelKey: 'txKutdStop',
  });
});
