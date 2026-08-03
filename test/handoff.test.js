'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { outstanding } = require('../tools/handoff.js');

test('handoff ranks outstanding units by weighted remaining work', () => {
  const rows = outstanding();
  assert.ok(rows.length > 0);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].remaining >= rows[i].remaining,
      `${rows[i - 1].stem} should precede ${rows[i].stem}`);
  }

  const queue = rows.find((row) => row.stem === 'core/Queue');
  assert.ok(queue);
  assert.equal(queue.lines, 3760);
  assert.equal(queue.progress, 0.45);
  assert.equal(queue.remaining, 2068);
});
