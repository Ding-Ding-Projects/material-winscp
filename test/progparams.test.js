'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSwitches } = require('../design/main/progparams');

test('production startup parsing preserves upstream first-switch semantics', () => {
  const parsed = parseSwitches(['/ini=first.ini', '/ini=second.ini', '/log:run.log']);
  assert.deepEqual(parsed.switches.get('ini'), { value: 'first.ini', valueSet: true });
  assert.deepEqual(parsed.switches.get('log'), { value: 'run.log', valueSet: true });
});

test('production parsing shares end-of-switch and path rules with core/Option', () => {
  const parsed = parseSwitches(['/rawsettings[2]', 'A=1', 'B=2', '//', '/not-a-switch', '/home/martin']);
  assert.deepEqual(parsed.switches.get('rawsettings'), { value: '2', valueSet: true });
  assert.deepEqual(parsed.params, ['A=1', 'B=2', '/not-a-switch', '/home/martin']);
});

test('production parsing accepts both switch marks without treating a path as a switch', () => {
  const parsed = parseSwitches(['-console', '-timeout:45', '/var/log/winscp']);
  assert.equal(parsed.switches.get('console').valueSet, false);
  assert.equal(parsed.switches.get('timeout').value, '45');
  assert.deepEqual(parsed.params, ['/var/log/winscp']);
});
