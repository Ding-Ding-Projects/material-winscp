'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Session, SessionManager } = require('../design/main/session');
const { terminalFor } = require('../design/main/terminal');

function cacheAdapter() {
  return {
    connected: true,
    sep: '/',
    normalize(p) { return String(p || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'; },
    dirname(p) {
      const s = this.normalize(p);
      if (s === '/') return '/';
      return s.slice(0, s.lastIndexOf('/')) || '/';
    },
    async list(p) {
      const d = this.normalize(p);
      return [{ name: d === '/tree' ? 'child' : 'entry', type: 'file' }];
    },
    async disconnect() { this.connected = false; },
    removeAllListeners() {},
    caps: {},
  };
}

function configFor(security) {
  return {
    prefs: { logging: {}, security: { ...(security || {}) } },
    knownHostKey() { return null; },
  };
}

test('session directory listings are copy-on-read and recursive invalidation is scoped', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'cache.example' }, { emit() {} });
  session.adapter = cacheAdapter();

  const first = await session.list('/tree');
  first.push({ name: 'caller-mutation' });
  const second = await session.list('/tree');
  assert.deepEqual(second.map((e) => e.name), ['child']);

  await session.list('/tree/child');
  await session.list('/other');
  session.invalidate('/tree', { subDirs: true });
  assert.deepEqual(session.cacheInfo().map((e) => e.path), ['/other']);
});

test('disconnect clears the Terminal cache owned by that session', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'cache.example' }, { emit() {} });
  session.adapter = cacheAdapter();
  const terminal = terminalFor(session);
  terminal.directoryLoaded({ directory: '/tree', timestamp: 1, files: [{ name: 'child' }] });
  assert.equal(terminal.cache.size, 1);

  await session.disconnect({ keepOpen: true });
  assert.equal(terminal.cache.size, 0);
  assert.equal(terminal.changesCache.isEmpty, true);
});

test('a close event from a replaced adapter cannot take down the new adapter', () => {
  const session = new Session({ protocol: 'sftp', hostName: 'race.example' }, { emit() {} });
  const oldAdapter = new EventEmitter();
  oldAdapter.connected = true;
  const currentAdapter = new EventEmitter();
  currentAdapter.connected = true;

  session.adapter = oldAdapter;
  session._wireAdapter(oldAdapter);
  session.adapter = currentAdapter;
  session._wireAdapter(currentAdapter);
  session.state.status = 'connected';

  oldAdapter.emit('close', 'late close from the previous connection');
  assert.equal(currentAdapter.connected, true);
  assert.equal(session.state.status, 'connected');
});

test('reconnect uses bounded backoff and refuses to cross the total budget', () => {
  let now = 100;
  const session = new Session(
    { protocol: 'sftp', hostName: 'backoff.example' },
    { config: configFor({ sessionReopenAuto: 10, sessionReopenTimeout: 1000 }), emit() {}, now: () => now },
  );
  session._scheduleReconnect(new Error('first drop'));
  assert.equal(session._reconnect.timer._idleTimeout, 10);
  clearTimeout(session._reconnect.timer);
  session._reconnect.timer = null;

  now = 110;
  session._scheduleReconnect(new Error('second drop'));
  assert.equal(session._reconnect.timer._idleTimeout, 20);
  clearTimeout(session._reconnect.timer);
  session._reconnect.timer = null;

  session._reconnect.startedAt = 100;
  now = 1100;
  session._scheduleReconnect(new Error('deadline drop'));
  assert.equal(session._reconnect.timer, null);
});

test('a refused security prompt does not schedule an automatic reconnect', async () => {
  const session = new Session(
    { protocol: 'webdav', hostName: 'tls.example' },
    { config: configFor({ sessionReopenAuto: 10 }), emit() {}, now: () => 100 },
  );
  session.ask = async () => ({ accept: false });
  const accepted = await session.verifyCertificate({ host: 'tls.example', port: 443, errors: ['untrusted'] });
  assert.equal(accepted, false);
  session._scheduleReconnect(new Error('TLS certificate rejected'));
  assert.equal(session._reconnect.timer, null);
});

test('successful connection resets the reconnect budget window', async () => {
  const session = new Session(
    { protocol: 'local', hostName: 'local' },
    { config: configFor({ sessionReopenAuto: 0 }), emit() {}, now: () => 500 },
  );
  session._reconnect.startedAt = 123;
  await session.connect();
  assert.equal(session._reconnect.startedAt, 0);
  await session.disconnect({ keepOpen: true });
});

test('a stale active-session id cannot redirect commands to another session', async () => {
  const manager = new SessionManager();
  const first = await manager.open({ protocol: 'local', hostName: 'first' }, { connect: false });
  const second = await manager.open({ protocol: 'local', hostName: 'second' }, { connect: false });
  manager.setActive(second.id);

  assert.equal(manager.setActive('renderer-event-for-a-closed-tab'), second.id);
  assert.equal(manager.active(), second);

  await manager.close(second.id);
  assert.equal(manager.active(), first);
});

test('closeOnFailure disconnects and removes the failed session', async () => {
  const manager = new SessionManager();
  await assert.rejects(
    () => manager.open({ protocol: 'not-a-protocol', hostName: 'invalid' }, { closeOnFailure: true }),
    /Unknown protocol/,
  );
  assert.deepEqual(manager.all(), []);
});
