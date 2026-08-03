'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function module() { return import('../design/renderer/ui/dialogs/session.js'); }

test('SessionDialog validates remote and local endpoints without accepting bad ports', async () => {
  const { validateSessionEndpoint } = await module();
  assert.equal(validateSessionEndpoint({ hostName: 'example.test', portNumber: 22 }), null);
  assert.equal(validateSessionEndpoint({ hostName: 'example.test', portNumber: 0 }).field, 'portNumber');
  assert.equal(validateSessionEndpoint({ hostName: 'example.test', portNumber: 65536 }).field, 'portNumber');
  assert.equal(validateSessionEndpoint({ protocol: 'local' }).field, 'localDirectory');
});

test('SessionDialog state strips every credential field before retaining state', async () => {
  const { secretFreeSessionState } = await module();
  const safe = secretFreeSessionState({ hostName: 'h', password: 'secret', passphrase: 'key', note: 'n' });
  assert.deepEqual(safe, { hostName: 'h', note: 'n' });
  assert.doesNotMatch(JSON.stringify(safe), /secret|passphrase/i);
});

test('closing is idempotent and invalidates a pending reconnect', async () => {
  const { createSessionLifecycle } = await module();
  const states = [];
  const lifecycle = createSessionLifecycle((state) => states.push(state));
  const token = lifecycle.beginReconnect();
  assert.equal(lifecycle.close(), true);
  assert.equal(lifecycle.close(), false);
  assert.equal(lifecycle.finishReconnect(token, true), false);
  assert.deepEqual(states.map((state) => state.status), ['reconnecting', 'closed']);
});

test('only one reconnect owner may finish, and failures remain explicit', async () => {
  const { createSessionLifecycle } = await module();
  const states = [];
  const lifecycle = createSessionLifecycle((state) => states.push(state));
  const token = lifecycle.beginReconnect();
  assert.equal(lifecycle.beginReconnect(), null);
  assert.equal(lifecycle.finishReconnect(token, false, 'offline'), true);
  assert.deepEqual(states.at(-1), { status: 'disconnected', error: 'offline' });
});
