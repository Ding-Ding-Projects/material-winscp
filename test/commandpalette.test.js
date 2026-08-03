'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const R = (rel) => pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', rel)).href;

let P;
test.before(async () => { P = await import(R('ui/commandpalette.js')); });

test('palette inventory keeps every registered command and preference destination', async () => {
  const app = await import(R('app.js'));
  const commands = [
    { id: 'test.one', label: 'One command', category: 'Test', run() {} },
    { id: 'test.two', label: 'Two command', shortcut: 'Ctrl+2', run() {} },
  ];
  const settings = P.preferenceDestinations(() => false);
  const entries = P.paletteEntries(commands, settings);
  assert.equal(entries.filter((e) => e.type === 'command').length, commands.length);
  assert.deepEqual(entries.filter((e) => e.type === 'command').map((e) => e.commandId), commands.map((c) => c.id));
  assert.ok(settings.some((e) => e.type === 'destination' && e.pageId === 'appearance'));
  assert.ok(settings.some((e) => e.type === 'setting' && e.key === 'language'));
  assert.equal(typeof app.listCommands, 'function');
});

test('setting destinations teleport by page and exact control without exposing secrets', () => {
  const settings = P.preferenceDestinations((key) => key === 'language' ? 'en' : key === 'security.masterPasswordVerifier' ? 'do-not-show' : false);
  const language = settings.find((e) => e.type === 'setting' && e.key === 'language');
  assert.ok(language);
  assert.equal(language.pageId, 'languages');
  assert.equal(language.value, 'English');
  assert.ok(language.fields.includes('language'));

  const master = settings.find((e) => e.type === 'setting' && e.key === 'security.masterPasswordVerifier');
  if (master) {
    assert.equal(master.value, 'Protected value');
    assert.ok(!master.fields.includes('do-not-show'));
  }
});

test('unavailable settings remain keyboard-reachable destinations', () => {
  const settings = P.preferenceDestinations(() => false);
  const pending = settings.find((e) => e.type === 'setting' && e.pending);
  assert.ok(pending, 'the preference schema should expose at least one pending setting');
  assert.equal(typeof pending.run, 'function');
  assert.equal(typeof pending.value, 'string');
});

test('palette search corpus contains both destination context and command metadata', () => {
  const settings = P.preferenceDestinations(() => 22);
  const transfer = settings.find((e) => e.type === 'setting' && e.key === 'queue.transfersLimit');
  assert.ok(transfer);
  assert.ok(transfer.fields.includes('queue.transfersLimit'));
  assert.ok(transfer.fields.some((v) => String(v).includes('22')));

  const [command] = P.paletteEntries([{ id: 'queue.pauseAll', labelKey: 'suspendAll', category: 'Queue', shortcut: 'Ctrl+Q', run() {} }], []);
  assert.ok(command.fields.includes('queue.pauseAll'));
  assert.ok(command.fields.includes('Queue'));
  assert.equal(command.shortcut, 'Ctrl+Q');
});

test('palette filtering is active only when the search bar has a query', () => {
  const entries = P.paletteEntries([
    { id: 'alpha', label: 'Alpha command', run() {} },
    { id: 'beta', label: 'Beta command', run() {} },
  ], []);
  const predicate = { ok: true, test: (value) => String(value).toLowerCase().includes('alpha') };
  assert.equal(P.filterPaletteEntries(entries, predicate, true).length, 1);
  assert.equal(P.filterPaletteEntries(entries, predicate, false).length, 2);
});
