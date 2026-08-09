'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { publicSite, publicWorkspaces, publicConfig } = require('../design/main/ipc');

const SECRET_FIELDS = [
  'password', 'passphrase', 'proxyPassword', 'tunnelPassword',
  'tunnelPassphrase', 'encryptKey', 's3SessionToken',
];

function secretFixture() {
  return Object.fromEntries(SECRET_FIELDS.map((field) => [field, `secret-${field}`]));
}

test('public site data masks every session secret and drops new credential-shaped fields', () => {
  const site = {
    id: 'site-1', name: 'Deploy', hostName: 'example.test', protocol: 'sftp',
    portNumber: 22, userName: 'alice', note: 'safe', ...secretFixture(),
    osCredentialCiphertext: 'os-ciphertext', proxyToken: 'proxy-token',
  };

  const result = publicSite(site);
  assert.deepEqual(
    Object.fromEntries(SECRET_FIELDS.map((field) => [field, result[field]])),
    Object.fromEntries(SECRET_FIELDS.map((field) => [field, '__stored__'])),
  );
  assert.equal(result.id, site.id);
  assert.equal(result.note, site.note);
  assert.equal('osCredentialCiphertext' in result, false);
  assert.equal('proxyToken' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-|ciphertext|proxy-token/);
});

test('public workspace listings sanitize nested session secrets while preserving safe fields', () => {
  const workspaces = [{
    name: 'Morning',
    sessions: [{ id: 'tab-1', hostName: 'example.test', ...secretFixture(),
      osCredentialCiphertext: 'machine-ciphertext', s3AccessToken: 'access-token' }],
  }];

  const result = publicWorkspaces(workspaces);
  const session = result[0].sessions[0];
  assert.equal(result[0].name, 'Morning');
  assert.equal(session.hostName, 'example.test');
  for (const field of SECRET_FIELDS) assert.equal(session[field], '__stored__', field);
  assert.equal('osCredentialCiphertext' in session, false);
  assert.equal('s3AccessToken' in session, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-|ciphertext|access-token/);
  assert.equal(workspaces[0].sessions[0].password, 'secret-password', 'input remains untouched');
});

test('public configuration sanitizes preferences, sites, and workspaces together', () => {
  const result = publicConfig({
    prefs: { language: 'en', savedApiToken: 'preference-token' },
    sites: [{ id: 'site-1', name: 'Safe', password: 'password' }],
    data: { folders: ['Work'], workspaces: [{ name: 'W', sessions: [{ id: 's', passphrase: 'phrase' }] }] },
    needsUnlock: () => false,
  });

  assert.deepEqual(result.prefs, { language: 'en' });
  assert.equal(result.sites[0].password, '__stored__');
  assert.equal(result.workspaces[0].sessions[0].passphrase, '__stored__');
  assert.equal(result.needsUnlock, false);
  assert.doesNotMatch(JSON.stringify(result), /preference-token|password"\s*:\s*"password|phrase"\s*:\s*"phrase/);
});
