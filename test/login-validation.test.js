import test from 'node:test';
import assert from 'node:assert/strict';
import { folderSites, validateLoginSite } from '../design/renderer/ui/dialogs/login.js';

test('folder opening includes sites nested in child folders', () => {
  const first = { kind: 'site', id: 'one' };
  const second = { kind: 'site', id: 'two' };
  assert.deepEqual(folderSites({
    kind: 'folder',
    children: [first, { kind: 'folder', children: [{ kind: 'folder', children: [second] }] }],
  }), [first, second]);
});

test('folder traversal ignores non-folder, non-site tree records', () => {
  assert.deepEqual(folderSites({
    kind: 'folder',
    children: [{ kind: 'workspace', children: [{ kind: 'site', id: 'not-opened' }] }],
  }), []);
});

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
