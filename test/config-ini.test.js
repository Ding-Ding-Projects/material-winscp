// config-ini.test.js — the live configuration store's WinSCP INI boundary.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const P = require('../design/main/paths');
const { Config } = require('../design/main/config');
const { defaultSessionData } = require('../design/main/sessiondata');

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-winscp-config-'));
  P.setRoot(root);
  try { return fn(root); } finally {
    P.setRoot(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ini = [
  '[Sessions\\Work/Prod]',
  'FSProtocol=1',
  'HostName=prod.example.com',
  'UserName=deploy',
  'PortNumber=2200',
  'PasswordPlain=p%40ss',
  'Password=machine-bound-cipher',
  'ProxyPassword=machine-bound-proxy-cipher',
  '',
].join('\r\n');

test('Config exports a folder-aware, credential-free WinSCP INI', () => withRoot((root) => {
  const config = new Config();
  const site = defaultSessionData('Prod');
  site.id = 'site-1';
  site.folder = 'Work';
  site.hostName = 'prod.example.com';
  site.userName = 'deploy';
  site.password = 'os:opaque';
  site.savePassword = true;
  config.data.sites = [site];

  const target = path.join(root, 'backup.ini');
  const result = config.exportFile(target);
  const text = fs.readFileSync(target, 'utf8');

  assert.equal(result.format, 'ini');
  assert.equal(result.secretsOmitted, true);
  assert.match(text, /\[Sessions\\Work\/Prod\]/);
  assert.match(text, /HostName=prod\.example\.com/);
  assert.doesNotMatch(text, /Password(?:Plain)?=/i);
  assert.doesNotMatch(text, /opaque/);
}));

test('Config imports INI hierarchy, protects portable passwords, and rejects machine ciphertext', () => withRoot((root) => {
  const source = path.join(root, 'WinSCP.ini');
  fs.writeFileSync(source, ini, 'utf8');
  const config = new Config();

  const result = config.importFile(source, 'Imported a WinSCP INI');
  const site = config.sites[0];

  assert.equal(result.format, 'ini');
  assert.equal(result.imported, 1);
  assert.equal(site.name, 'Prod');
  assert.equal(site.folder, 'Work');
  assert.equal(site.hostName, 'prod.example.com');
  assert.equal(site.userName, 'deploy');
  assert.equal(site.portNumber, 2200);
  assert.notEqual(site.password, 'machine-bound-cipher');
  assert.notEqual(site.password, 'p@ss');
  assert.notEqual(site.proxyPassword, 'machine-bound-proxy-cipher');
  assert.deepEqual(config.data.folders, ['Work']);
}));

test('a portable WinSCP INI beside app data is migrated into the JSON store on load', () => withRoot((root) => {
  fs.writeFileSync(P.ini(), ini, 'utf8');
  const config = new Config().load();

  assert.equal(config.sites.length, 1);
  assert.equal(config.sites[0].name, 'Prod');
  assert.equal(config.sites[0].folder, 'Work');
  assert.equal(fs.existsSync(P.config()), true);
  const stored = JSON.parse(fs.readFileSync(P.config(), 'utf8'));
  assert.equal(stored.sites[0].password === 'p@ss', false);
  assert.equal(stored.sites[0].password === 'machine-bound-cipher', false);
}));

test('JSON load and import re-protect clear-text session secrets', () => withRoot((root) => {
  const clearSite = { name: 'Clear', hostName: 'clear.example.com', password: 'plain-password', savePassword: true };
  fs.writeFileSync(P.config(), JSON.stringify({ sites: [clearSite] }), 'utf8');
  const loaded = new Config().load();
  assert.notEqual(loaded.sites[0].password, 'plain-password');
  loaded.flush();
  assert.doesNotMatch(fs.readFileSync(P.config(), 'utf8'), /plain-password/);

  loaded.importState({ sites: [{ name: 'Imported', hostName: 'imported.example.com', password: 'another-password', savePassword: true }] });
  assert.notEqual(loaded.sites[0].password, 'another-password');
  assert.doesNotMatch(fs.readFileSync(P.config(), 'utf8'), /another-password/);
}));

test('failed JSON import rolls back the live configuration before reporting the write error', () => withRoot(() => {
  const config = new Config();
  config.data.prefs.language = 'en';
  config.data.sites = [{ id: 'existing', name: 'Existing' }];
  config.data.folders = ['Existing'];
  config.data.workspaces = [{ name: 'Existing workspace' }];
  const before = config.exportState();
  const failure = new Error('simulated disk failure');
  config.flush = () => { throw failure; };

  assert.throws(() => config.importState({
    prefs: { language: 'yue' },
    sites: [{ name: 'Imported' }],
    folders: ['Imported'],
    workspaces: [{ name: 'Imported workspace' }],
  }), failure);
  assert.deepEqual(config.exportState(), before);
}));

test('failed INI import rolls back sites and folders before reporting the write error', () => withRoot(() => {
  const config = new Config();
  config.data.sites = [{ id: 'existing', name: 'Existing' }];
  config.data.folders = ['Existing'];
  const before = { sites: config.data.sites, folders: config.data.folders };
  const failure = new Error('simulated disk failure');
  config.flush = () => { throw failure; };

  assert.throws(() => config.importIni(ini, 'Imported a WinSCP INI'), failure);
  assert.deepEqual(config.data.sites, before.sites);
  assert.deepEqual(config.data.folders, before.folders);
}));
