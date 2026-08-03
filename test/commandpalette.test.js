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

test('preference jump focuses the concrete editor inside the matched row', async () => {
  const preferences = await import(R('ui/dialogs/preferences.js'));
  let focused = 0;
  const input = { focus: (options) => { focused += 1; assert.deepEqual(options, { preventScroll: true }); } };
  const row = { querySelector: (selector) => { assert.match(selector, /input/); return input; } };
  assert.equal(preferences.focusPreferenceControl(row), input);
  assert.equal(focused, 1);
});

test('unavailable settings remain keyboard-reachable destinations', () => {
  const settings = P.preferenceDestinations(() => false);
  const pending = settings.find((e) => e.type === 'setting' && e.pending);
  assert.ok(pending, 'the preference schema should expose at least one pending setting');
  assert.equal(typeof pending.run, 'function');
  assert.equal(typeof pending.value, 'string');
});

test('safe primitive settings expose inline controls without exposing protected or unavailable flows', () => {
  const settings = P.preferenceDestinations(() => false);
  const inline = settings.filter((entry) => entry.type === 'setting' && entry.inline);
  assert.ok(inline.length > 0, 'the palette should expose at least one live primitive control');
  assert.ok(inline.some((entry) => entry.control.type === 'check'));
  assert.ok(inline.some((entry) => entry.control.type === 'number'));
  assert.ok(inline.every((entry) => entry.control && !entry.control.secret && !entry.control.actionId
    && !entry.control.danger && !entry.pending));

  const master = settings.find((entry) => entry.key === 'security.useMasterPassword');
  if (master) assert.equal(master.inline, false, 'master-password changes need the Preferences flow');
  assert.equal(P.canInlinePreference({ type: 'text', secret: true }), false);
  assert.equal(P.canInlinePreference({ type: 'text', actionId: 'masterPassword' }), false);
  assert.equal(P.canInlinePreference({ type: 'check', key: 'logging.logSensitive', danger: true }), false);
  assert.equal(P.canInlinePreference({ type: 'check', key: 'timeoutOnStartup' }), false);
  assert.equal(P.canInlinePreference({ type: 'select' }), true);
});

test('palette keyboard ownership leaves nested editors, palette buttons and clearing queries alone', () => {
  assert.equal(P.shouldHandlePaletteKey({ key: 'ArrowDown', inRegexBuilder: true }), false);
  assert.equal(P.shouldHandlePaletteKey({ key: 'Enter', inInlineControl: true }), false);
  assert.equal(P.shouldHandlePaletteKey({ key: 'Enter', inPaletteButton: true }), false);
  assert.equal(P.shouldHandlePaletteKey({ key: 'ArrowDown', inPaletteButton: true }), false);
  assert.equal(P.shouldHandlePaletteKey({ key: 'Escape', inPaletteButton: true }), true);
  assert.equal(P.shouldHandlePaletteKey({ key: 'Escape', inInlineControl: true }), true);
  assert.equal(P.shouldHandlePaletteKey({ key: 'Escape', searchHasValue: true }), false);
  assert.equal(P.shouldHandlePaletteKey({ key: 'ArrowDown' }), true);
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

test('palette registers every Advanced Site Settings and appearance destination', async () => {
  const advanced = await import(R('ui/dialogs/siteadvanced.js'));
  const appearance = await import(R('ui/appearance.js'));
  const destinations = P.paletteDestinations();
  const page = destinations.find((entry) => entry.destinationKind === 'site-advanced-page');
  const control = destinations.find((entry) => entry.destinationKind === 'site-advanced-control');
  const property = destinations.find((entry) => entry.destinationKind === 'appearance-property');
  assert.equal(destinations.filter((entry) => entry.destinationKind === 'site-advanced-page').length, advanced.SITE_ADVANCED_PAGES.length);
  assert.equal(destinations.filter((entry) => entry.destinationKind === 'site-advanced-control').length, advanced.allAdvancedControls().length);
  assert.equal(destinations.filter((entry) => entry.destinationKind === 'appearance-property').length,
    appearance.PROPS.length * appearance.STATES.length);
  assert.ok(page.fields.includes(page.pageId));
  assert.ok(control.fields.includes(control.controlKey));
  assert.ok(property.fields.includes(property.propertyKey));
  assert.equal(typeof page.run, 'function');
  assert.equal(typeof control.run, 'function');
  assert.equal(typeof property.run, 'function');
});

test('filtered result sets start keyboard selection at their first match', () => {
  const entries = P.paletteEntries([
    { id: 'alpha', label: 'Alpha command', run() {} },
    { id: 'beta', label: 'Beta command', run() {} },
    { id: 'gamma', label: 'Gamma command', run() {} },
  ], []);
  const predicate = { ok: true, test: (value) => String(value).toLowerCase().includes('a') };
  const filtered = P.filterPaletteEntries(entries, predicate, true);
  assert.deepEqual(filtered.map((entry) => entry.commandId), ['alpha', 'beta', 'gamma']);
  // The renderer uses this reset before painting the new result set, making
  // the first match the Enter target after typing.
  assert.equal(P.firstPaletteIndex(filtered.length), 0);
  assert.equal(P.firstPaletteIndex(0), -1);
});

test('deferred initial focus is skipped after palette teardown', () => {
  assert.equal(P.shouldFocusPalette(false), true);
  assert.equal(P.shouldFocusPalette(true), false);
});
