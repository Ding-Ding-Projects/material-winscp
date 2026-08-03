import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLoginSite } from '../design/renderer/ui/dialogs/login.js';

test('Login validation rejects missing hosts before opening a session', () => {
  assert.deepEqual(validateLoginSite({ portNumber: 22 }), {
    field: 'hostName', message: 'Enter a host name.',
  });
});

test('Login validation accepts a trimmed host and valid port', () => {
  assert.equal(validateLoginSite({ hostName: ' example.com ', portNumber: 22 }), null);
});

test('Login validation rejects ports outside the TCP range', () => {
  assert.equal(validateLoginSite({ hostName: 'example.com', portNumber: 0 }).field, 'portNumber');
  assert.equal(validateLoginSite({ hostName: 'example.com', portNumber: 65536 }).field, 'portNumber');
  assert.equal(validateLoginSite({ hostName: 'example.com', portNumber: '22.5' }).field, 'portNumber');
});
