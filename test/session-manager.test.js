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

test('disconnect cancels an active Terminal operation before closing the adapter', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'cancel.example' }, { emit() {} });
  const terminal = terminalFor(session);
  let cancelled = 0;
  terminal.cancelOperation = () => { cancelled++; return true; };

  await session.disconnect({ keepOpen: true });

  assert.equal(cancelled, 1);
});

test('concurrent disconnects share one adapter teardown', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'once.example' }, { emit() {} });
  let disconnects = 0;
  let release;
  const adapter = cacheAdapter();
  adapter.disconnect = async () => {
    disconnects++;
    await new Promise((resolve) => { release = resolve; });
    adapter.connected = false;
  };
  session.adapter = adapter;

  const first = session.disconnect({ keepOpen: true });
  const second = session.disconnect({ keepOpen: true });
  assert.strictEqual(first, second);
  assert.equal(disconnects, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(session.state.status, 'closed');
});

test('connect waits for an in-flight disconnect instead of returning a stale adapter', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'connect-race.example' }, { emit() {} });
  const adapter = cacheAdapter();
  let release;
  adapter.disconnect = async () => {
    await new Promise((resolve) => { release = resolve; });
    adapter.connected = false;
  };
  session.adapter = adapter;
  session.state.status = 'connected';

  const closing = session.disconnect({ keepOpen: true });
  let connects = 0;
  session._connect = async () => {
    connects++;
    return session.info();
  };

  let settled = false;
  const reconnecting = session.connect().then((info) => {
    settled = true;
    return info;
  });
  await Promise.resolve();

  assert.equal(settled, false, 'connect must not resolve while teardown is pending');
  assert.equal(connects, 0, 'a new adapter must not be created before teardown finishes');

  release();
  await closing;
  const info = await reconnecting;
  assert.equal(connects, 1);
  assert.equal(info.status, 'closed');
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

test('an adapter close retires the dead adapter before reconnect is scheduled', () => {
  const session = new Session(
    { protocol: 'sftp', hostName: 'closed.example' },
    { config: configFor({ sessionReopenAuto: 10 }), emit() {} },
  );
  const adapter = new EventEmitter();
  adapter.connected = true;
  session.adapter = adapter;
  session._wireAdapter(adapter);

  adapter.emit('close', 'network dropped');

  assert.equal(session.adapter, null);
  assert.equal(adapter.listenerCount('close'), 0);
  assert.equal(adapter.listenerCount('error'), 0);
  assert.ok(session._reconnect.timer, 'the retry remains scheduled after cleanup');
  clearTimeout(session._reconnect.timer);
  session._reconnect.timer = null;
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

test('negative automatic reconnect delays disable the retry timer', () => {
  const session = new Session(
    { protocol: 'sftp', hostName: 'invalid-delay.example' },
    { config: configFor({ sessionReopenAuto: -1 }), emit() {} },
  );
  session._scheduleReconnect(new Error('connection dropped'));
  assert.equal(session._reconnect.timer, null);
  assert.equal(session.state.status, 'closed');
});

test('negative automatic reconnect timeout disables the retry timer', () => {
  const session = new Session(
    { protocol: 'sftp', hostName: 'invalid-timeout.example' },
    { config: configFor({ sessionReopenAuto: 10, sessionReopenTimeout: -1 }), emit() {} },
  );
  session._scheduleReconnect(new Error('connection dropped'));
  assert.equal(session._reconnect.timer, null);
  assert.equal(session._reconnect.startedAt, 0);
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

test('exec fails closed when a stale capability flag has no implementation', async () => {
  const session = new Session({ protocol: 'sftp', hostName: 'capability.example' }, { emit() {} });
  session.adapter = { connected: true, protocolName: 'SFTP', caps: { exec: true } };

  await assert.rejects(
    () => session.exec('echo should-not-run'),
    (error) => error && error.code === 'NOT_SUPPORTED' && /cannot execute remote commands/.test(error.message),
  );
});

test('IPv6 host keys use an unambiguous bracketed host-port key', async () => {
  const lookedUp = [];
  const session = new Session(
    { protocol: 'sftp', hostName: '2001:db8::1', portNumber: 2222 },
    {
      config: {
        prefs: { logging: {}, security: {} },
        knownHostKey(key) { lookedUp.push(key); return { fingerprint: 'SHA256:known' }; },
      },
      emit() {},
    },
  );

  assert.equal(session.hostPort, '[2001:db8::1]:2222');
  assert.equal(await session.verifyHostKey({
    host: '2001:db8::1', port: 2222, fingerprintSHA256: 'SHA256:known', algorithm: 'ssh-ed25519',
  }), true);
  assert.deepEqual(lookedUp, ['[2001:db8::1]:2222']);
});
