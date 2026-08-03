'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The renderer module is ESM; extract the small pure operation without
// booting Electron or the dialog registration side effects.
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../design/renderer/ui/dialogs/locationprofiles.js'), 'utf8');
const body = source.match(/function normalizeProfile[\s\S]*?export function duplicateProfile[\s\S]*?\n}\n/)[0]
  .replace('export function duplicateProfile', 'function duplicateProfile');
const duplicateProfile = new Function(`${body}; return duplicateProfile;`)();

test('duplicating a location profile preserves its folder and order, clears shortcut, and avoids collisions', () => {
  const first = { name: 'Release', node: 'Work', local: 'C:\\release', remote: '/srv/release', shortCut: 'Ctrl+1' };
  const list = [first, { name: 'Release (copy)', node: 'Work', local: 'x', remote: 'y', shortCut: '' }, { name: 'Other' }];
  const copy = duplicateProfile(list, first);
  assert.equal(copy.name, 'Release (copy) 2');
  assert.equal(copy.node, 'Work');
  assert.equal(copy.shortCut, '');
  assert.deepEqual(list.map((p) => p.name), ['Release', 'Release (copy) 2', 'Release (copy)', 'Other']);
});
