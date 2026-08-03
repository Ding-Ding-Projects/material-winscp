'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const loadDialog = () => import('../design/renderer/ui/dialogs/remotetransfer.js');

test('remote transfer validation refuses empty, unavailable, and unsafe targets', async () => {
  const { validateRemoteTransfer } = await loadDialog();
  const base = { files: [{ path: '/source/a.txt' }], sessions: [{ id: 's1' }], canCopy: true };
  assert.equal(validateRemoteTransfer({ ...base, files: [] }), 'noFiles');
  assert.equal(validateRemoteTransfer({ ...base, target: '   ' }), 'noTarget');
  assert.equal(validateRemoteTransfer({ ...base, sessions: [] , target: '/dest/*' }), 'noSession');
  assert.equal(validateRemoteTransfer({ ...base, target: '/dest/*', canCopy: false }), 'unsupported');
  assert.equal(validateRemoteTransfer({ ...base, files: [{}, {}], target: '/dest/final.txt' }), 'multiToOne');
});

test('remote transfer validation accepts a masked multi-file target', async () => {
  const { validateRemoteTransfer } = await loadDialog();
  assert.equal(validateRemoteTransfer({
    files: [{ path: '/source/a.txt' }, { path: '/source/b.txt' }],
    target: '/dest/*.bak', sessions: [{ id: 's1' }], canCopy: true,
  }), '');
});
