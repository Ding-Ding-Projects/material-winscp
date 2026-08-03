import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateChecklist, partitionForApply, reverseAction, sortChecklistItems,
} from '../design/renderer/ui/dialogs/checklist.js';

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

test('sorting keeps selection and overrides attached to their original rows', () => {
  const original = [
    {
      action: 'upload', checked: true,
      local: { name: 'z.txt', directory: '/local', path: '/local/z.txt' },
      remote: { name: 'z.txt', directory: '/remote', path: '/remote/z.txt' },
    },
    {
      action: 'download', checked: true,
      local: { name: 'a.txt', directory: '/local', path: '/local/a.txt' },
      remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt' },
    },
  ];
  const sorted = sortChecklistItems(original.map((item) => ({ ...item })), 'name');
  sorted[0] = { ...sorted[0], checked: false };

  const selection = partitionForApply(original, sorted);
  assert.deepEqual(selection.checked, [true, false], 'the unticked a.txt row stays unticked');
  assert.deepEqual(selection.overrides, []);

  sorted[1] = { ...sorted[1], action: 'deleteLocal', checked: true };
  const changed = partitionForApply(original, sorted);
  assert.deepEqual(changed.checked, [false, false], 'the overridden z.txt row is withheld from the engine');
  assert.equal(changed.overrides.length, 1);
  assert.equal(changed.overrides[0].index, 0, 'the override uses comparison order for IPC');
  assert.equal(changed.overrides[0].item.local.path, '/local/z.txt');
});
