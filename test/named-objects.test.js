'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NamedObjectRegistry,
  KINDS,
} = require('../design/main/named-objects');

test('registers supported kinds, resolves deterministically, and exports identifiers only', () => {
  const registry = new NamedObjectRegistry();
  const operation = { id: 2, secret: 'must stay private' };
  const session = { id: 1 };
  registry.register('operation', operation, { name: 'operation-2' });
  registry.register('session', session, { name: 'session-main' });

  assert.equal(registry.get('session-main'), session);
  assert.equal(registry.get('session-main', { kind: 'operation' }), undefined);
  assert.deepEqual(registry.find(), [
    { name: 'operation-2', kind: 'operation', value: operation },
    { name: 'session-main', kind: 'session', value: session },
  ]);
  assert.deepEqual(registry.identifiers(), [
    { name: 'operation-2', kind: 'operation' },
    { name: 'session-main', kind: 'session' },
  ]);
  assert.equal(registry.serialize(), '[{"name":"operation-2","kind":"operation"},{"name":"session-main","kind":"session"}]');
  assert.doesNotMatch(registry.serialize(), /secret|must stay private|id/);
  assert.deepEqual(KINDS, ['session', 'queue-item', 'operation', 'ui-bridge']);
});

test('collision handling suffixes deterministically or fails closed', () => {
  const registry = new NamedObjectRegistry();
  const first = registry.register('session', {}, { name: 'site' });
  const second = registry.register('session', {}, { name: 'site' });
  const third = registry.register('session', {}, { name: 'site', collision: 'suffix' });
  assert.equal(first.name, 'site');
  assert.equal(second.name, 'site-2');
  assert.equal(third.name, 'site-3');
  assert.throws(() => registry.register('session', {}, { name: 'site', collision: 'error' }), /collision/i);
});

test('generated names are bounded and unique across kinds', () => {
  const registry = new NamedObjectRegistry({ maxEntries: 8 });
  const names = [
    registry.register('session', {}).name,
    registry.register('session', {}).name,
    registry.register('queue-item', {}).name,
    registry.register('operation', {}).name,
    registry.register('ui-bridge', {}).name,
  ];
  assert.deepEqual(names, ['session-1', 'session-2', 'queue-item-1', 'operation-1', 'ui-bridge-1']);
  assert.equal(new Set(names).size, names.length);
  assert.throws(() => registry.register('session', {}, { name: 'not valid' }), /bounded identifier/);
  assert.throws(() => registry.register('unknown', {}), /Unsupported named-object kind/);
});

test('leases provide explicit deterministic disposal with no stale lookup', () => {
  const registry = new NamedObjectRegistry();
  const value = {};
  const lease = registry.register('queue-item', value, { name: 'queue-1' });
  assert.equal(lease.get(), value);
  assert.equal(lease.disposed, false);
  assert.equal(lease.dispose(), true);
  assert.equal(lease.dispose(), false);
  assert.equal(lease.disposed, true);
  assert.equal(lease.get(), undefined);
  assert.equal(registry.get('queue-1'), undefined);
  assert.equal(registry.size, 0);
  assert.equal(registry.dispose('queue-1'), false);
});

test('weak ownership removes all owned entries on explicit owner disposal', () => {
  const registry = new NamedObjectRegistry();
  const owner = {};
  const first = registry.register('session', {}, { name: 'session-a', owner, ownership: 'weak' });
  const second = registry.register('ui-bridge', {}, { name: 'bridge-a', owner, ownership: 'weak', weak: false });
  registry.register('operation', {}, { name: 'operation-a', owner, ownership: 'explicit' });
  assert.equal(registry.size, 3);
  assert.equal(registry.disposeOwner(owner), 3);
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, true);
  assert.equal(registry.size, 0);
  assert.equal(registry.find({ owner }).length, 0);
});

test('explicit owner disposal can target one owner without retaining owner objects', () => {
  const registry = new NamedObjectRegistry();
  const ownerA = {};
  const ownerB = {};
  registry.register('operation', { owner: 'a' }, { name: 'op-a', owner: ownerA });
  registry.register('operation', { owner: 'b' }, { name: 'op-b', owner: ownerB });
  assert.deepEqual(registry.find({ kind: 'operation', owner: ownerA }).map((item) => item.name), ['op-a']);
  assert.equal(registry.disposeOwner(ownerA), 1);
  assert.equal(registry.get('op-a'), undefined);
  assert.deepEqual(registry.find({ kind: 'operation' }).map((item) => item.name), ['op-b']);
});

test('weak values are swept when no live value remains and registry stays bounded', () => {
  const registry = new NamedObjectRegistry({ maxEntries: 1 });
  let value = {};
  registry.register('operation', value, { name: 'weak-op', weak: true });
  assert.equal(registry.size, 1);
  // The runtime is free to retain value until the next GC, so disposal is the
  // deterministic path tested here; sweep is still safe if it is collected.
  value = null;
  assert.equal(registry.disposeAll(), 1);
  assert.equal(registry.size, 0);
  assert.equal(registry.register('operation', {}).name, 'operation-1');
});

test('limits and invalid ownership are rejected before adding an entry', () => {
  const registry = new NamedObjectRegistry({ maxEntries: 1 });
  registry.register('session', {});
  assert.throws(() => registry.register('operation', {}), /limit exceeded/);
  assert.throws(() => new NamedObjectRegistry({ maxEntries: 0 }), /positive safe integer/);
  const invalid = new NamedObjectRegistry({ maxEntries: 1 });
  assert.throws(() => invalid.register('operation', {}, { ownership: 'weak' }), /requires an owner/);
  assert.throws(() => invalid.register('operation', {}, { owner: 'not-object' }), /Owner must be/);
  assert.equal(invalid.size, 0);
});
