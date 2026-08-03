import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateChecklist, reverseAction, sortChecklistItems } from '../design/renderer/ui/dialogs/checklist.js';

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

test('Calculate summarizes only checked rows without mutating the checklist', () => {
  const rows = [
    { action: 'upload', checked: true, local: { size: 1024 } },
    { action: 'download', checked: false, remote: { size: 2048 } },
    { action: 'deleteRemote', checked: true, remote: { exists: true } },
  ];
  const before = structuredClone(rows);

  assert.deepEqual(calculateChecklist(rows), {
    counts: { upload: 1, download: 0, deleteLocal: 0, deleteRemote: 1, nothing: 0, timestamp: 0 },
    bytes: { upload: 1024, download: 0 },
    acted: 2,
    deletions: 1,
    total: 3,
  });
  assert.deepEqual(rows, before);
});
