import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseAction, sortChecklistItems } from '../design/renderer/ui/dialogs/checklist.js';

test('reversing a Do nothing row is gated with a direction-specific reason', () => {
  const item = { action: 'nothing', reason: 'identical' };
  const result = reverseAction(item);

  assert.deepEqual(result, {
    ok: false,
    reasonKey: 'txClNoReverseNothing',
    item,
  });
});

test('sorting is stable and does not mutate checklist rows', () => {
  const rows = [
    { action: 'upload', local: { name: 'beta' }, remote: { directory: '/x' } },
    { action: 'download', local: { name: 'alpha' }, remote: { directory: '/x' } },
    { action: 'nothing', local: { name: 'alpha' }, remote: { directory: '/y' } },
  ];
  const sorted = sortChecklistItems(rows, 'name');
  assert.deepEqual(sorted, [rows[1], rows[2], rows[0]]);
  assert.deepEqual(rows, [rows[0], rows[1], rows[2]]);
  assert.deepEqual(sortChecklistItems(rows, 'action', 'desc').map((r) => r.action), ['upload', 'nothing', 'download']);
});
