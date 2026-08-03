import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseAction } from '../design/renderer/ui/dialogs/checklist.js';

test('reversing a Do nothing row is gated with a direction-specific reason', () => {
  const item = { action: 'nothing', reason: 'identical' };
  const result = reverseAction(item);

  assert.deepEqual(result, {
    ok: false,
    reasonKey: 'txClNoReverseNothing',
    item,
  });
});
