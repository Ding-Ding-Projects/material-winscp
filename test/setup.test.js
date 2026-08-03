'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const setup = require('../design/main/setup');

test('removeShortcut is a safe no-op on non-Windows hosts', () => {
  if (process.platform === 'win32') return;
  const integration = new setup.WindowsIntegration({
    env: { USERPROFILE: '/tmp/material-winscp-test-user' },
    exePath: '/tmp/material-winscp-test-user/app.exe',
  });
  assert.equal(integration.removeShortcut({ name: 'not-a-shortcut', folder: 'desktop' }), false);
});
