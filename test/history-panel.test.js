'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'design/renderer/ui/historypanel.js');

test('the history panel localizes discarded revisions and names them in the empty state', async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  assert.match(source, /actDiscarded: \['Discarded', '捨棄'\]/);
  assert.match(source, /discarded: 'actDiscarded'/);
  assert.match(source, /or an unsaved document is discarded/);
  assert.match(source, /或者捨棄未儲存文件/);
});

test('discarded action labels do not fall through to the raw action id', async () => {
  const { actionLabel } = await import('../design/renderer/ui/historypanel.js');
  const labels = { actDiscarded: 'Discarded' };
  assert.equal(actionLabel('discarded', (key) => labels[key] || key), 'Discarded');
});
