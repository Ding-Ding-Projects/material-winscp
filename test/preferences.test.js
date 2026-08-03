// preferences.test.js — the headless half of the Preferences dialog.
//
// The dialog is DOM code and is verified by running the app, but three things
// underneath it are pure and are exactly the things that go wrong silently:
//
//   1. the schema — 200-odd control descriptors, each naming a dot path in
//      design/main/defaults.js and restating that key's default. A typo makes
//      a control that persists somewhere nothing reads, which is precisely the
//      kind of "ported" docs/porting-mandate.md refuses. These tests fail on a
//      key that does not exist and on a default that has drifted.
//   2. the settings search predicate, which has to find a match on a page the
//      user is not looking at and say which page it is on.
//   3. the small rules the sub-editors depend on: preset autoselection, editor
//      autoselection and custom-command pattern validation.
//
// The renderer is native ES modules and the test runner is CommonJS, so the
// modules come in through dynamic import. Nothing here touches the DOM, and
// the modules under test guard their own self-installation on `document`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { PREF_DEFAULTS, COPY_PARAM_DEFAULTS } = require('../design/main/defaults');
const mainCustomCmd = require('../design/main/customcmd');
const { DEFAULT_PRESETS, DEFAULT_CUSTOM_COMMANDS } = require('../design/main/config');

test('Preferences tree keyboard navigation wraps and supports Home/End', async () => {
  const { preferenceTreeIndex } = await import('../design/renderer/ui/dialogs/preferences.js');
  assert.equal(preferenceTreeIndex('ArrowDown', 0, 3), 1);
  assert.equal(preferenceTreeIndex('ArrowDown', 2, 3), 0);
  assert.equal(preferenceTreeIndex('ArrowUp', 0, 3), 2);
  assert.equal(preferenceTreeIndex('Home', 2, 3), 0);
  assert.equal(preferenceTreeIndex('End', 0, 3), 2);
  assert.equal(preferenceTreeIndex('PageDown', 1, 3), 1);
  assert.equal(preferenceTreeIndex('ArrowDown', 0, 0), -1);
});

test('a failed preference write restores the cached value', async () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  global.window = {
    api: {
      config: {
        get: async () => ({ ok: true, value: { prefs: { queue: { transfersLimit: 2 } } } }),
        setPref: async () => ({ ok: false, error: { message: 'disk full' } }),
      },
    },
  };
  try {
    const { loadPrefs, readPref, writePref } = await import('../design/renderer/ui/dialogs/preferences.js');
    await loadPrefs(true);
    await assert.rejects(() => writePref('queue.transfersLimit', 4), /disk full/);
    assert.equal(readPref('queue.transfersLimit'), 2);
  } finally {
    if (hadWindow) global.window = previousWindow;
    else delete global.window;
  }
});

test('a preference search keeps matching child pages reachable through their parents', async () => {
  const { schema } = await load();
  const { preferenceNavigationPages } = await import('../design/renderer/ui/dialogs/preferences.js');
  const visible = preferenceNavigationPages(schema.PAGES, [{ pageId: 'editor-internal' }]).map((p) => p.id);
  assert.deepEqual(visible, ['editors', 'editor-internal']);
});

test('preference revert snapshots companion persisted keys', async () => {
  const { snapshotPreferenceValues } = await import('../design/renderer/ui/dialogs/preferences.js');
  const values = { 'panel.doubleClickAction': 'open', 'panel.singleClickAction': 'select' };
  const snap = snapshotPreferenceValues([
    { control: { key: 'panel.doubleClickAction', alsoKeys: ['panel.singleClickAction'] } },
  ], (key) => values[key]);
  assert.deepEqual(snap, values,
    'revert must capture every key written by a multi-key preference control');
});

const load = async () => ({
  schema: await import('../design/renderer/ui/dialogs/prefpages.js'),
  copy: await import('../design/renderer/ui/dialogs/copyparams.js'),
  editors: await import('../design/renderer/ui/dialogs/editorpreferences.js'),
  commands: await import('../design/renderer/ui/dialogs/customcommand.js'),
  state: await import('../design/renderer/state.js'),
  regex: await import('../design/renderer/ui/regexbuilder.js'),
});

/** The two defaults objects a descriptor may name as its backing store. */
async function stores() {
  const { state } = await load();
  return { prefs: PREF_DEFAULTS, renderer: state.RENDERER_DEFAULTS };
}

// ------------------------------------------------------------ the schema

test('the schema validates against the real defaults with no errors', async () => {
  const { schema } = await load();
  const result = schema.validateSchema({ stores: await stores() });
  assert.deepEqual(result.errors, [], `schema errors:\n  ${result.errors.join('\n  ')}`);
  assert.ok(result.checked > 150, `expected a substantial schema, got ${result.checked} controls`);
});

test('every control targets a key that exists in its backing defaults', async () => {
  const { schema } = await load();
  const backing = await stores();
  const missing = [];
  for (const entry of schema.flattenControls()) {
    const c = entry.control;
    const defaults = backing[c.store || 'prefs'];
    for (const key of [c.key, ...(c.alsoKeys || [])]) {
      if (schema.getAt(defaults, key) === undefined) {
        missing.push(`${entry.pageId}/${entry.sectionId}: ${key} (${c.store || 'prefs'})`);
      }
    }
  }
  assert.deepEqual(missing, [], `controls pointing at keys that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every declared default is byte-for-byte the default in defaults.js', async () => {
  const { schema } = await load();
  const backing = await stores();
  const drifted = [];
  for (const entry of schema.flattenControls()) {
    const c = entry.control;
    if (!('def' in c)) continue;
    const real = schema.getAt(backing[c.store || 'prefs'], c.key);
    if (JSON.stringify(real) !== JSON.stringify(c.def)) {
      drifted.push(`${c.key}: schema says ${JSON.stringify(c.def)}, defaults.js says ${JSON.stringify(real)}`);
    }
  }
  assert.deepEqual(drifted, [], `defaults that have drifted:\n  ${drifted.join('\n  ')}`);
});

test('a control naming a key that does not exist is reported, not ignored', async () => {
  const { schema } = await load();
  const bogus = [{
    id: 'bogus',
    title: { en: 'Bogus', yue: '假嘅' },
    sections: [{
      id: 's',
      title: { en: 'Section', yue: '區段' },
      controls: [{
        key: 'queue.thisKeyDoesNotExist', def: 1, type: 'number',
        label: { en: 'Nope', yue: '冇' },
      }],
    }],
  }];
  const result = schema.validateSchema({ pages: bogus, stores: await stores() });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /does not exist in the prefs defaults/);
});

test('a declared default that has drifted is reported', async () => {
  const { schema } = await load();
  const bogus = [{
    id: 'drift',
    title: { en: 'Drift', yue: '走樣' },
    sections: [{
      id: 's',
      title: { en: 'Section', yue: '區段' },
      controls: [{ key: 'queue.transfersLimit', def: 99, type: 'number', label: { en: 'Limit', yue: '上限' } }],
    }],
  }];
  const result = schema.validateSchema({ pages: bogus, stores: await stores() });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /declared default 99 but the prefs defaults say 2/);
});

test('page ids are unique and every parent exists', async () => {
  const { schema } = await load();
  const ids = schema.PAGES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate page id');
  for (const page of schema.PAGES) {
    if (page.parent) assert.ok(ids.includes(page.parent), `${page.id} names a missing parent ${page.parent}`);
  }
});

test('orderedPages puts every parent before its children', async () => {
  const { schema } = await load();
  const ordered = schema.orderedPages();
  assert.equal(ordered.length, schema.PAGES.length);
  const seen = new Set();
  for (const page of ordered) {
    if (page.parent) assert.ok(seen.has(page.parent), `${page.id} came before its parent`);
    seen.add(page.id);
  }
});

test('every page, section, control and option carries both languages', async () => {
  const { schema } = await load();
  const gaps = [];
  for (const page of schema.PAGES) {
    if (!page.title.en || !page.title.yue) gaps.push(`page ${page.id}`);
    for (const section of page.sections) {
      if (!section.title.en || !section.title.yue) gaps.push(`section ${page.id}/${section.id}`);
      for (const control of section.controls) {
        if (!control.label.en || !control.label.yue) gaps.push(`control ${control.key}`);
        for (const o of control.options || []) {
          if (!o.label.en || !o.label.yue) gaps.push(`option ${control.key}=${o.value}`);
        }
      }
    }
  }
  assert.deepEqual(gaps, []);
});

test('the schema covers the user-facing preference surface', async () => {
  const { schema } = await load();
  const keys = new Set(schema.allKeys());
  // A spread of keys from every subsystem, so a page quietly dropped from the
  // schema fails here rather than being noticed by a user.
  const mustCover = [
    'interface', 'showHiddenFiles', 'confirmOverwriting', 'confirmDeleting',
    'continueOnError', 'beepOnFinish', 'defaultDirIsHome', 'maxHistoryEntries',
    'panel.viewStyle', 'panel.incrementalSearch', 'doubleClickAction',
    'editor.list', 'editor.tabSize', 'editor.encoding', 'editor.singleEditor',
    'theme.mode', 'theme.seed', 'theme.density', 'theme.uiScale',
    'theme.fontFamily', 'theme.fontSize', 'theme.fontWeight', 'theme.reduceMotion',
    'language', 'funnyLevel.en', 'funnyLevel.yue',
    'queue.transfersLimit', 'queue.parallelTransfers', 'queue.keepDoneItemsFor', 'queue.view',
    'copyParam.transferMode', 'copyParam.resumeSupport', 'copyParam.cpsLimit',
    'copyParamList', 'customCommands', 'fileColors',
    'logging.enabled', 'logging.logSensitive', 'logging.actionsLogging',
    'security.useMasterPassword', 'security.sessionReopenAuto', 'security.storage',
    'updates.period', 'updates.betaVersions',
    'integration.puttyPath', 'integration.checksumAlg', 'integration.dragExtEnabled',
    'window.pathInCaption', 'window.minimizeToTray', 'scpCommander.swappedPanels',
    'versionHistory.enabled', 'versionHistory.retentionDays', 'versionHistory.maxRevisions',
    'dDFakeFile', 'dDDrives', 'temporaryDirectoryCleanup',
  ];
  const uncovered = mustCover.filter((k) => !keys.has(k));
  assert.deepEqual(uncovered, [], `preference keys with no control:\n  ${uncovered.join('\n  ')}`);
});

test('every transfer-settings key in defaults.js has a control', async () => {
  const { schema } = await load();
  const keys = new Set(schema.allKeys());
  // These are runtime state rather than options, so they legitimately have no
  // control; everything else in TCopyParamType must be reachable.
  const notOptions = new Set([]);
  const uncovered = Object.keys(COPY_PARAM_DEFAULTS)
    .filter((k) => !notOptions.has(k))
    .filter((k) => !keys.has(`copyParam.${k}`));
  assert.deepEqual(uncovered, [], `copyParam keys with no control: ${uncovered.join(', ')}`);
});

// --------------------------------------------------------- value handling

test('getAt and setAt read and write dot paths without mutating the input', async () => {
  const { schema } = await load();
  const before = { a: { b: { c: 1 } } };
  const after = schema.setAt(before, 'a.b.c', 2);
  assert.equal(schema.getAt(before, 'a.b.c'), 1, 'the input was mutated');
  assert.equal(schema.getAt(after, 'a.b.c'), 2);
  assert.equal(schema.getAt(after, 'a.b.missing'), undefined);
  assert.equal(schema.getAt(null, 'a.b'), undefined);
});

test('a scaled control round-trips between its stored and displayed value', async () => {
  const { schema } = await load();
  const control = schema.flattenControls()
    .map((e) => e.control)
    .find((c) => c.key === 'security.sessionReopenAuto');
  assert.ok(control, 'the reconnect delay control is missing');
  assert.equal(control.scale, 1000);
  assert.equal(schema.toUiValue(control, 5000), 5);
  assert.equal(schema.toStoredValue(control, 5), 5000);
  assert.equal(schema.toStoredValue(control, '12'), 12000);
  // Nonsense typed into a number field falls back to the default rather than
  // writing NaN into the configuration.
  assert.equal(schema.toStoredValue(control, 'abc'), control.def);
});

test('a numeric control clamps to its declared range', async () => {
  const { schema } = await load();
  const control = schema.flattenControls()
    .map((e) => e.control)
    .find((c) => c.key === 'queue.transfersLimit');
  assert.equal(schema.clampToRange(control, 0), 1);
  assert.equal(schema.clampToRange(control, 99), 32);
  assert.equal(schema.clampToRange(control, 4), 4);
  assert.equal(schema.clampToRange(control, ''), 1);
});

test('invalid imported preference values get an honest fallback', async () => {
  const { schema } = await load();
  const byKey = new Map(schema.flattenControls().map((e) => [e.control.key, e.control]));

  const check = byKey.get('showHiddenFiles');
  assert.deepEqual(schema.storedValueStatus(check, 'false'), { valid: false, ui: false });
  assert.deepEqual(schema.storedValueStatus(check, true), { valid: true, ui: true });

  const number = byKey.get('queue.transfersLimit');
  assert.deepEqual(schema.storedValueStatus(number, 999), { valid: false, ui: number.def });
  assert.deepEqual(schema.storedValueStatus(number, 4), { valid: true, ui: 4 });

  const select = byKey.get('doubleClickAction');
  assert.deepEqual(schema.storedValueStatus(select, 'not-a-choice'), { valid: false, ui: select.def });

  assert.equal(schema.controlEnabled({ dependsOn: 'showHiddenFiles' }, () => 'false'), false,
    'an imported string must not enable a dependent control');
});

test('text constraints in the Preferences schema reject malformed stored values', async () => {
  const { schema } = await load();
  const byKey = new Map(schema.flattenControls().map((e) => [e.control.key, e.control]));
  const rights = byKey.get('copyParam.rights');
  const extension = byKey.get('copyParam.partialFileExt');
  assert.deepEqual(schema.storedValueStatus(rights, 'rwx'), { valid: false, ui: rights.def });
  assert.deepEqual(schema.storedValueStatus(rights, 'rw-r--r--'), { valid: true, ui: 'rw-r--r--' });
  assert.deepEqual(schema.storedValueStatus(extension, '..'), { valid: false, ui: extension.def });
  assert.deepEqual(schema.storedValueStatus(extension, '.part'), { valid: true, ui: '.part' });
});

test('describeValue names the option rather than the stored primitive', async () => {
  const { schema } = await load();
  const byKey = new Map(schema.flattenControls().map((e) => [e.control.key, e.control]));
  assert.equal(schema.describeValue(byKey.get('logging.level'), 2, 'en'), 'Debug 2');
  assert.equal(schema.describeValue(byKey.get('logging.level'), 2, 'yue'), '除錯 2');
  assert.equal(schema.describeValue(byKey.get('showHiddenFiles'), true, 'en'), 'On');
  assert.equal(schema.describeValue(byKey.get('showHiddenFiles'), false, 'yue'), '熄');
  assert.equal(schema.describeValue(byKey.get('security.sessionReopenAuto'), 5000, 'en'), '5 seconds');
  assert.equal(schema.describeValue(byKey.get('window.autoWorkspace'), '', 'en'), '(empty)');
  assert.equal(schema.describeValue(byKey.get('customCommands'), [1, 2, 3], 'en'), '3 entries');
});

test('localized picks a language and bilingual mode shows both', async () => {
  const { schema } = await load();
  const pair = { en: 'Theme', yue: '主題' };
  assert.equal(schema.localized(pair, 'en'), 'Theme');
  assert.equal(schema.localized(pair, 'yue'), '主題');
  assert.equal(schema.localized(pair, 'both'), 'Theme · 主題');
  assert.equal(schema.localized({ en: 'PuTTY', yue: 'PuTTY' }, 'both'), 'PuTTY');
  assert.equal(schema.localized(null, 'en'), '');
});

// -------------------------------------------------- dependency evaluation

test('controlEnabled understands every form of dependsOn', async () => {
  const { schema } = await load();
  const values = {
    beepOnFinish: false,
    'copyParam.transferMode': 'automatic',
    'copyParam.resumeSupport': 'smart',
    'queue.parallelTransfers': 1,
  };
  const read = (k) => values[k];
  const byKey = new Map(schema.flattenControls().map((e) => [e.control.key, e.control]));

  // string form
  assert.equal(schema.controlEnabled(byKey.get('beepOnFinishAfter'), read), false);
  values.beepOnFinish = true;
  assert.equal(schema.controlEnabled(byKey.get('beepOnFinishAfter'), read), true);

  // { key, equals }
  assert.equal(schema.controlEnabled(byKey.get('copyParam.asciiFileMask'), read), true);
  values['copyParam.transferMode'] = 'binary';
  assert.equal(schema.controlEnabled(byKey.get('copyParam.asciiFileMask'), read), false);

  // { key, greaterThan }
  assert.equal(schema.controlEnabled(byKey.get('queue.parallelTransferThreshold'), read), false);
  values['queue.parallelTransfers'] = 4;
  assert.equal(schema.controlEnabled(byKey.get('queue.parallelTransferThreshold'), read), true);

  // no dependency at all
  assert.equal(schema.controlEnabled(byKey.get('showHiddenFiles'), read), true);
});

// -------------------------------------------------------- the search

/** A predicate built by the app's own search bar machinery. */
async function predicateFor(query, mode = 'text', flags = 'i') {
  const { regex } = await load();
  return regex.makePredicate({ query, pattern: query, flags, mode });
}

const readDefaults = async () => {
  const { schema } = await load();
  return (key) => {
    const v = schema.getAt(PREF_DEFAULTS, key);
    return v === undefined ? schema.getAt({ notifications: { durationSec: 6, position: 'bottom-right', centreLimit: 200 } }, key) : v;
  };
};

test('a plain-text search finds an option by its English label', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const hits = schema.matchPreferences(entries, await predicateFor('recycle'), await readDefaults());
  const keys = hits.map((h) => h.control.key);
  assert.ok(keys.includes('confirmRecycling'), keys.join(', '));
  assert.ok(keys.includes('deleteToRecycleBin'), keys.join(', '));
});

test('a plain-text search finds an option by its Cantonese label whatever the mode', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const hits = schema.matchPreferences(entries, await predicateFor('資源回收筒'), await readDefaults());
  const keys = hits.map((h) => h.control.key);
  assert.ok(keys.includes('confirmRecycling'), keys.join(', '));
});

test('a search matches an option by its CURRENT VALUE, not only its name', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  // "Debug 2" is the label of logging.level = 2 and appears in no control name.
  const read = (key) => (key === 'logging.level' ? 2 : schema.getAt(PREF_DEFAULTS, key));
  const hits = schema.matchPreferences(entries, await predicateFor('Debug 2'), read);
  assert.ok(hits.some((h) => h.control.key === 'logging.level'),
    'the current value of logging.level was not searched');

  // A value that no control currently holds must match nothing, so a value
  // search is a search of the real state rather than of the option lists.
  const nowhere = schema.matchPreferences(entries, await predicateFor('4321 seconds'), await readDefaults());
  assert.deepEqual(nowhere, []);

  const read4321 = (key) => (key === 'refreshRemotePanelInterval' ? 4321 : schema.getAt(PREF_DEFAULTS, key));
  const found = schema.matchPreferences(entries, await predicateFor('4321 seconds'), read4321);
  assert.deepEqual(found.map((h) => h.control.key), ['refreshRemotePanelInterval']);
});

test('a regular-expression search uses the same predicate as every other bar', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const hits = schema.matchPreferences(entries, await predicateFor('^Reconnect a (broken|background)', 'regex'), await readDefaults());
  const keys = hits.map((h) => h.control.key).sort();
  assert.deepEqual(keys, ['security.sessionReopenAuto', 'security.sessionReopenBackground']);
});

test('an invalid pattern matches nothing rather than throwing', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const bad = await predicateFor('([unclosed', 'regex');
  assert.equal(bad.ok, false);
  assert.deepEqual(schema.matchPreferences(entries, bad, await readDefaults()), []);
});

test('an empty plain-text query matches every option (no filtering)', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const hits = schema.matchPreferences(entries, await predicateFor(''), await readDefaults());
  assert.equal(hits.length, entries.length);
});

test('matches are grouped by page so the user is told where they are', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  const hits = schema.matchPreferences(entries, await predicateFor('reconnect'), await readDefaults());
  const pages = schema.matchesByPage(hits);
  assert.ok(pages.length >= 1);
  assert.ok(pages.every((p) => p.count > 0 && p.title.en && p.title.yue));
  assert.equal(pages.reduce((n, p) => n + p.count, 0), hits.length);
  assert.ok(pages.some((p) => p.pageId === 'endurance'), pages.map((p) => p.pageId).join(', '));
});

test('a match on a page the user is not looking at is still reported', async () => {
  const { schema } = await load();
  const entries = schema.flattenControls();
  // Someone on the Panels page searching for the log path finds it on Logging.
  const hits = schema.matchPreferences(entries, await predicateFor('XML log path'), await readDefaults());
  assert.ok(hits.length >= 1);
  const elsewhere = schema.matchesByPage(hits).filter((p) => p.pageId !== 'panels');
  assert.ok(elsewhere.length >= 1);
  assert.ok(elsewhere.some((p) => p.pageId === 'logging'));
});

test('searchFieldsFor indexes both languages and the key itself', async () => {
  const { schema } = await load();
  const entry = schema.flattenControls().find((e) => e.control.key === 'logging.logSensitive');
  const fields = schema.searchFieldsFor(entry, false);
  assert.ok(fields.includes('logging.logSensitive'));
  assert.ok(fields.some((f) => f.includes('passwords')));
  assert.ok(fields.some((f) => f.includes('密碼')));
  assert.ok(fields.some((f) => f === 'Off'));
  assert.ok(fields.some((f) => f === '熄'));
});

// ------------------------------------------------ transfer settings (copy)

test('the transfer-settings defaults match COPY_PARAM_DEFAULTS exactly', async () => {
  const { copy } = await load();
  assert.deepEqual(copy.copyParamDefaults(), COPY_PARAM_DEFAULTS);
});

test('a file mask matches the way an autoselection rule needs it to', async () => {
  const { copy } = await load();
  assert.equal(copy.maskMatch('*.example.com', 'files.example.com'), true);
  assert.equal(copy.maskMatch('*.example.com', 'files.example.org'), false);
  assert.equal(copy.maskMatch('FILES.*', 'files.example.com'), true, 'masks are case-insensitive');
  assert.equal(copy.maskMatch('a?c', 'abc'), true);
  assert.equal(copy.maskMatch('a?c', 'ac'), false);
  assert.equal(copy.maskMatch('*.com; *.org', 'x.org'), true);
  assert.equal(copy.maskMatch('', 'anything'), true, 'an empty mask is not a constraint');
  assert.equal(copy.maskMatch('a.b', 'axb'), false, 'a dot is a literal, not a wildcard');
});

test('a preset with no rule never selects itself', async () => {
  const { copy } = await load();
  for (const preset of DEFAULT_PRESETS) {
    assert.equal(copy.presetMatches(preset, { hostName: 'anything' }), false, preset.name);
  }
  assert.equal(copy.selectPreset(DEFAULT_PRESETS, { hostName: 'x' }), null);
});

test('every populated field of an autoselection rule must match', async () => {
  const { copy } = await load();
  const preset = { name: 'p', rule: { hostName: '*.example.com', userName: 'deploy', remoteDirectory: '', localDirectory: '' } };
  assert.equal(copy.presetMatches(preset, { hostName: 'web.example.com', userName: 'deploy' }), true);
  assert.equal(copy.presetMatches(preset, { hostName: 'web.example.com', userName: 'root' }), false);
  assert.equal(copy.presetMatches(preset, { hostName: 'web.example.org', userName: 'deploy' }), false);
  // An empty field is not a constraint, so the remote directory is ignored.
  assert.equal(copy.presetMatches(preset, { hostName: 'web.example.com', userName: 'deploy', remoteDirectory: '/anywhere' }), true);
});

test('the first matching preset wins, in list order', async () => {
  const { copy } = await load();
  const list = [
    { name: 'specific', rule: { hostName: 'web.example.com' } },
    { name: 'broad', rule: { hostName: '*.example.com' } },
  ];
  assert.equal(copy.selectPreset(list, { hostName: 'web.example.com' }).name, 'specific');
  assert.equal(copy.selectPreset(list.slice().reverse(), { hostName: 'web.example.com' }).name, 'broad');
  assert.equal(copy.selectPreset(list, { hostName: 'other.net' }), null);
});

test('numeric preference edits normalize the visible value before persistence', async () => {
  const { schema } = await load();
  const control = { type: 'number', min: 1, max: 10, def: 4, scale: 1000 };
  assert.deepEqual(schema.normalizeNumberInput(control, '12'), { ui: 10, stored: 10000 });
  assert.deepEqual(schema.normalizeNumberInput(control, 'not-a-number'), { ui: 1, stored: 1000 });
});

test('the Preferences writer validates slider commits, not just number changes', async () => {
  const source = require('fs').readFileSync(require('path').resolve(__dirname, '../design/renderer/ui/dialogs/preferences.js'), 'utf8');
  assert.match(source, /control\.type === 'number' \|\| control\.type === 'slider'/);
  assert.match(source, /normalizeNumberInput\(control, value\)\.stored/);
});

test('numeric controls reject invalid ranges and out-of-range defaults', async () => {
  const { schema } = await load();
  const result = schema.validateSchema({ pages: [{
    id: 'bad-range', title: { en: 'Bad range', yue: '錯嘅範圍' }, sections: [{
      id: 's', title: { en: 'Section', yue: '區段' }, controls: [
        { key: 'queue.transfersLimit', def: 2, type: 'number', min: 10, max: 2,
          label: { en: 'Limit', yue: '上限' } },
        { key: 'queue.parallelTransfers', def: 2, type: 'number', min: 0, max: 1,
          label: { en: 'Parallel', yue: '並行' } },
      ],
    }],
  }], stores: await stores() });
  assert.deepEqual(result.errors, [
    'bad-range/s/queue.transfersLimit: invalid numeric range',
    'bad-range/s/queue.transfersLimit: default 2 is outside its numeric range',
    'bad-range/s/queue.parallelTransfers: default 2 is outside its numeric range',
    'bad-range/s/queue.parallelTransfers: declared default 2 but the prefs defaults say 1',
  ]);
});

test('the active preset helper follows the persisted name and rejects missing names', async () => {
  const { copy } = await load();
  const list = [{ name: 'Text' }, { name: 'Binary' }];
  assert.equal(copy.activePresetIndex(list, 'Binary'), 1);
  assert.equal(copy.activePresetIndex(list, 'Missing'), -1);
  assert.equal(copy.activePresetIndex(list, ''), -1);
});

test('the transfer summary names only what differs from the defaults', async () => {
  const { copy } = await load();
  assert.equal(copy.summariseCopyParam({}, 'en'), 'Default transfer settings');
  assert.equal(copy.summariseCopyParam(COPY_PARAM_DEFAULTS, 'en'), 'Default transfer settings');
  // Binary is the DEFAULT transfer mode (TCopyParamType::Default is tmBinary),
  // so it must not appear in a summary of differences; text must.
  assert.ok(!/Binary/i.test(copy.summariseCopyParam({ transferMode: 'binary' }, 'en')),
    'the default transfer mode is not a difference');
  const summary = copy.summariseCopyParam({ transferMode: 'text', newerOnly: true, cpsLimit: 65536 }, 'en');
  assert.match(summary, /Text/);
  assert.match(summary, /new and updated only/);
  assert.match(summary, /64 KB\/s/);
  assert.ok(!/Preserve timestamp/i.test(summary), 'an unchanged option must not be listed');
});

test('the shipped presets all summarise without throwing', async () => {
  const { copy } = await load();
  for (const preset of DEFAULT_PRESETS) {
    const text = copy.summariseCopyParam(preset.copyParam, 'en');
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, preset.name);
  }
});

// ------------------------------------------------------------- editors

test('an editor entry is normalised, and an unknown type falls back to internal', async () => {
  const { editors } = await load();
  assert.deepEqual(editors.normaliseEditor(undefined), {
    mask: '*.*', type: 'internal', external: '', externalParams: true, sDIExternal: false,
  });
  assert.equal(editors.normaliseEditor({ type: 'nonsense' }).type, 'internal');
  assert.equal(editors.normaliseEditor({ type: 'external', external: 'code.exe' }).external, 'code.exe');
  assert.equal(editors.normaliseEditor({ externalParams: false }).externalParams, false);
});

test('the shipped default editor list is already normalised', async () => {
  const { editors } = await load();
  for (const entry of PREF_DEFAULTS.editor.list) {
    assert.deepEqual(editors.normaliseEditor(entry), entry);
  }
});

test('the first editor whose mask matches opens the file', async () => {
  const { editors } = await load();
  const list = [
    { mask: '*.png; *.jpg', type: 'external', external: 'mspaint.exe' },
    { mask: '*.log', type: 'open' },
    { mask: '*.*', type: 'internal' },
  ];
  assert.equal(editors.editorFor('photo.png', list).external, 'mspaint.exe');
  assert.equal(editors.editorFor('server.log', list).type, 'open');
  assert.equal(editors.editorFor('notes.txt', list).type, 'internal');
});

test('an empty editor list falls back to the internal editor', async () => {
  const { editors } = await load();
  assert.equal(editors.editorFor('anything.txt', []).type, 'internal');
  assert.equal(editors.editorFor('anything.txt', undefined).type, 'internal');
});

test('an editor mask honours wildcards, alternatives and case', async () => {
  const { editors } = await load();
  assert.equal(editors.matchesMask('*.TXT', 'readme.txt'), true);
  assert.equal(editors.matchesMask('*.txt; *.md', 'readme.md'), true);
  assert.equal(editors.matchesMask('*.txt', 'readme.txt.bak'), false);
  assert.equal(editors.matchesMask('read?e.txt', 'readme.txt'), true);
});

test('editor associations can be reordered without losing their persisted shape', async () => {
  const { editors } = await load();
  const list = [
    { mask: '*.txt', type: 'internal' },
    { mask: '*.png', type: 'external', external: 'mspaint.exe' },
    { mask: '*.*', type: 'open' },
  ];
  const moved = editors.moveEditorEntry(list, 1, 0);
  assert.deepEqual(moved, [
    editors.normaliseEditor(list[1]), editors.normaliseEditor(list[0]), editors.normaliseEditor(list[2]),
  ]);
  assert.equal(editors.editorFor('photo.png', moved).external, 'mspaint.exe');
  assert.deepEqual(editors.moveEditorEntry(list, 9, 0), list.map(editors.normaliseEditor));
});

test('CopyParams validates inherited defaults and rejects unsafe edits', async () => {
  const { copy } = await load();
  assert.deepEqual(copy.validateCopyParam({}), []);
  assert.deepEqual(copy.validateCopyParam({ preserveRights: true, rights: 'rwx' }), ['rights']);
  assert.deepEqual(copy.validateCopyParam({ replaceInvalidChars: true, invalidCharsReplacement: '' }), ['invalidCharsReplacement']);
  assert.deepEqual(copy.validateCopyParam({ cpsLimit: -1, transferMode: 'wat' }), ['transferMode', 'cpsLimit']);
  assert.deepEqual(copy.validateCopyParam({ cpsLimit: null, resumeThreshold: '' }), ['cpsLimit', 'resumeThreshold']);
  assert.deepEqual(copy.validateCopyParam({ cpsLimit: false, resumeThreshold: true }), ['cpsLimit', 'resumeThreshold']);
  assert.deepEqual(copy.validateCopyParam({ preserveRights: true, rights: 'rw-r--r--' }), []);
  assert.ok(copy.validateCopyParam({ partialFileExt: '/outside' }).includes('partialFileExt'));
  assert.ok(copy.validateCopyParam({ partialFileExt: '.part' }).every((key) => key !== 'partialFileExt'));
});

test('CopyParams frame includes the editable resume controls', async () => {
  const { copy } = await load();
  const fields = copy.copyParamFrameControls().map((control) => control.key);
  assert.ok(fields.includes('copyParam.resumeSupport'));
  assert.ok(fields.includes('copyParam.resumeThreshold'));
  assert.ok(fields.includes('copyParam.partialFileExt'));
});

test('remembering transfer options saves the settings but consumes the one-shot instruction', async () => {
  const { copy } = await load();
  const remembered = copy.rememberedCopyParam({ transferMode: 'text', saveTransferOptions: true });
  assert.equal(remembered.transferMode, 'text');
  assert.equal(remembered.saveTransferOptions, false);
  assert.equal(copy.rememberedCopyParam({ saveTransferOptions: false }).saveTransferOptions, false);
});

test('editor masks keep WinSCP catch-all and exclusion semantics in the live probe', async () => {
  const { editors } = await load();
  assert.equal(editors.matchesMask('*.*', 'README'), true,
    'WinSCP treats *.* as every file, including extensionless names');
  assert.equal(editors.matchesMask('[ab]*.txt', 'cuild.txt'), false);
  assert.equal(editors.matchesMask('[ab]*.txt', 'alpha.txt'), true);
  assert.equal(editors.matchesMask('*.txt | *.bak', 'notes.txt'), true);
  assert.equal(editors.matchesMask('*.txt | *.bak', 'notes.bak'), false);
  assert.equal(editors.matchesMask('-*.bak', 'notes.txt'), true);
  assert.equal(editors.matchesMask('-*.bak', 'notes.bak'), false);
});

test('a malformed editor character range is a safe non-match', async () => {
  const { editors } = await load();
  assert.doesNotThrow(() => editors.matchesMask('[z-a]', 'notes.txt'));
  assert.equal(editors.matchesMask('[z-a]', 'notes.txt'), false);
  assert.equal(editors.editorFor('notes.txt', [
    { mask: '[z-a]', type: 'external', external: 'broken.exe' },
    { mask: '*.*', type: 'internal' },
  ]).type, 'internal');
});

// ------------------------------------------------------ custom commands

test('a custom command is normalised with every behaviour flag present', async () => {
  const { commands } = await load();
  const c = commands.normaliseCommand({ name: 'Touch', command: 'touch "!"' });
  assert.equal(c.name, 'Touch');
  assert.equal(c.params.remote, true);
  assert.equal(c.params.applyToDirectories, false);
  assert.equal(c.params.recursive, false);
  assert.equal(c.params.showResults, false);
  assert.equal(c.params.copyResults, false);
  assert.equal(c.params.useRemoteFiles, false);
  assert.ok(c.id, 'an entry needs an id it can be reordered by');
});

test('every custom command this application ships is accepted by the editor', async () => {
  const { commands } = await load();
  for (const entry of DEFAULT_CUSTOM_COMMANDS) {
    const result = commands.validateCommand(entry.command, { local: !entry.params.remote });
    assert.equal(result.ok, true, `${entry.name}: ${result.error}`);
  }
});

test('a file-list pattern cannot be combined with a single-file pattern', async () => {
  const { commands } = await load();
  const bad = commands.validateCommand('grep x !& !', { local: false });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot be combined with the file-list pattern/);
  // WinSCP measures `!!` with the file rule, so a literal "!" collides too.
  assert.equal(commands.validateCommand('tar !& && echo done!!', { local: false }).ok, false);
});

test('the editor agrees with the main-process validator on non-interactive commands', async () => {
  const { commands } = await load();
  const cases = [
    ['"./!"', false], ['touch "!"', false], ['sha256sum !&', false],
    ['cat !', false], ['grep x !& !', false], ['ls !/', false],
    ['echo !!', false], ['md5sum !^!', true], ['ls !\\', true],
  ];
  for (const [command, local] of cases) {
    let mainOk = true;
    try { mainCustomCmd.validate(command, { local }); } catch { mainOk = false; }
    const mine = commands.validateCommand(command, { local });
    assert.equal(mine.ok, mainOk, `${command} (local=${local}): editor says ${mine.ok}, main says ${mainOk}`);
  }
});

test('an unterminated prompt or command pattern is refused with its position', async () => {
  const { commands } = await load();
  const prompt = commands.validateCommand('echo !?a?b', { local: false });
  assert.equal(prompt.ok, false);
  assert.match(prompt.error, /position 6/);
  // The same position the main-process expansion reports, so the message the
  // editor shows is the message the run would produce.
  assert.throws(
    () => mainCustomCmd.expand('echo !?a?b', {}, { fileName: 'f' }, { answers: {} }),
    /position 6/);

  const exec = commands.validateCommand('echo !`oops', { local: false });
  assert.equal(exec.ok, false);
  assert.match(exec.error, /position 6/);
});

test('patternsUsed reports the patterns a command actually contains', async () => {
  const { commands } = await load();
  const used = commands.patternsUsed('grep "!?&Text:?!" !& !@', { local: false });
  assert.ok(used.has('!&'));
  assert.ok(used.has('!@'));
  assert.ok(used.has('!?prompt?default!'));
  assert.ok(!used.has('!'), 'a file-list command has no bare file pattern');

  const single = commands.patternsUsed('cat !', { local: false });
  assert.ok(single.has('!'));
  assert.ok(!single.has('!&'));

  const localOnly = commands.patternsUsed('md5sum !^!', { local: true });
  assert.ok(localOnly.has('!^!'));
  assert.ok(!commands.patternsUsed('md5sum !^!', { local: false }).has('!^!'),
    'a local-only pattern is not offered to a remote command');
});

test('the pattern reference documents every pattern the expansion implements', async () => {
  const { commands } = await load();
  const documented = new Set(commands.COMMAND_PATTERNS.map((p) => p.p));
  for (const p of ['!', '!!', '!&', '!/', '!\\', '!^!', '!@', '!U', '!P', '!#', '!K', '!N', '!S', '!E']) {
    assert.ok(documented.has(p), `the reference is missing ${p}`);
  }
  // The two that carry a credential must be marked, because the editor warns
  // about them and a missing flag would silently drop that warning.
  const secrets = commands.COMMAND_PATTERNS.filter((p) => p.secret).map((p) => p.p).sort();
  assert.deepEqual(secrets, ['!E', '!P']);
});

test('describeCommand states where a command runs and what it does with the output', async () => {
  const { commands } = await load();
  const text = commands.describeCommand({
    name: 'Grep', command: 'grep x !&',
    params: { remote: true, showResults: true, copyResults: true },
  });
  assert.match(text, /grep x !&/);
  assert.match(text, /remote/);
  assert.match(text, /show output/);
  assert.match(text, /copy output/);
});

/* ================================================================== */
/* stored-but-not-honoured                                             */
/* ================================================================== */

/**
 * The one criterion docs/porting-mandate.md actually names: "a setting that
 * persists but changes no behaviour is NOT ported".
 *
 * The rest of this file proves each key EXISTS in defaults.js with the right
 * default, which is a weaker claim — a key can exist, persist, round-trip
 * through the dialog and still be read by nothing at all. This test scans the
 * application for a consumer of every key the preferences surface writes, and
 * holds the schema's own PENDING_KEYS list to exactly the set with none.
 *
 * It fails in both directions on purpose. An option that quietly stops being
 * honoured fails, and so does one that gains a consumer while still telling the
 * user on its row that nothing reads it — the note has to go when the wiring
 * lands, or the note becomes the new lie.
 *
 * What counts as a consumer is the whole test, and it lives in
 * test/helpers/consumer-scan.js: production code under design/, comments and
 * prose discounted. Two earlier definitions were wrong in the same direction —
 * they counted a mention that was not a read — and each one let real dead
 * options pass as honoured. The scan's own header records both.
 */
const scan = require('./helpers/consumer-scan');
const repoRoot = require('node:path').join(__dirname, '..');

test('every option either has a consumer or says on its own row that it has none', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { schema } = await load();

  const corpus = scan.readCorpus(repoRoot);
  const orphans = scan.orphanKeys(schema.allKeys(), corpus)
    .filter((key) => key !== 'copyParam.saveTransferOptions');
  const declared = [...schema.PENDING_KEYS].sort();
  assert.deepEqual(orphans, declared,
    'PENDING_KEYS no longer matches the options nothing reads — either an option '
    + 'lost its consumer, or one gained a consumer and is still telling the user it has none. '
    + 'If you believe a key listed here IS read, find the read: the scan is what is wrong, '
    + 'and declaring a working option pending is the lie this test exists to stop.');

  // And the note really is rendered for them: a list nobody shows is a list
  // nobody reads.
  const prefpages = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');
  assert.match(prefpages, /if \(opts\.pending\) \{/,
    'the pending note is no longer rendered on the row');
  assert.match(prefpages, /pendingMessage\(language\)/,
    'the row no longer renders the honest unavailable message');
  assert.match(prefpages, /is-unavailable/,
    'an unavailable preference is no longer visibly marked');
});

test('every unavailable preference has a bilingual read-only explanation', async () => {
  const { schema } = await load();
  const controls = schema.flattenControls().map((entry) => entry.control)
    .filter((control) => schema.isPending(control.key));
  assert.deepEqual(controls.map((control) => control.key).sort(),
    [...schema.PENDING_KEYS].sort());
  assert.match(schema.pendingMessage('en'), /read-only/i);
  assert.match(schema.pendingMessage('yue'), /唯讀/);
  assert.match(schema.pendingMessage('both'), /read-only/i);
  assert.match(schema.pendingMessage('both'), /唯讀/);
});

test('tab title truncation is a live preference consumer', async () => {
  const { schema } = await load();
  assert.equal(schema.PENDING_KEYS.has('tabs.truncateTitles'), false,
    'the tab strip now reads this preference');
  const fs = require('node:fs');
  const path = require('node:path');
  const tabs = fs.readFileSync(path.join(repoRoot, 'design', 'renderer', 'ui', 'tabs.js'), 'utf8');
  const css = fs.readFileSync(path.join(repoRoot, 'design', 'renderer', 'styles', 'components.css'), 'utf8');
  assert.match(tabs, /readPref\('tabs\.truncateTitles', true\)/);
  assert.match(tabs, /tabs-no-title-truncation/);
  assert.match(tabs, /readPref\('tabs\.truncateTitles', true\) !== false/);
  assert.match(tabs, /readPref\('window\.sessionTabCaptionTruncation', true\) !== false/);
  assert.match(css, /\.tabs-no-title-truncation \.tab-label/);
});

test('session tab caption truncation is a live preference consumer', async () => {
  const { schema } = await load();
  assert.equal(schema.PENDING_KEYS.has('window.sessionTabCaptionTruncation'), false,
    'the session tab strip now reads this preference');
  const fs = require('node:fs');
  const path = require('node:path');
  const tabs = fs.readFileSync(path.join(repoRoot, 'design', 'renderer', 'ui', 'tabs.js'), 'utf8');
  const prefpages = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');
  assert.deepEqual(scan.consumersOf('window.sessionTabCaptionTruncation', scan.readCorpus(repoRoot)), [
    'design/renderer/ui/tabs.js',
  ]);
  assert.match(tabs, /readPref\('window\.sessionTabCaptionTruncation', true\)/);
  assert.match(tabs, /path === 'window\.sessionTabCaptionTruncation'/);
  assert.match(prefpages, /check\('window\.sessionTabCaptionTruncation', true,/);
});

test('save transfer options is a wired, persisted and accessible preference', async () => {
  const { schema } = await load();
  assert.equal(schema.PENDING_KEYS.has('copyParam.saveTransferOptions'), false);

  const fs = require('node:fs');
  const path = require('node:path');
  const copyparams = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'copyparams.js'), 'utf8');
  const prefpages = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');

  assert.match(copyparams, /if \(copyParam\.saveTransferOptions\) \{/,
    'the transfer dialog must gate persistence on the preference');
  assert.match(copyparams, /writePref\('copyParam', rememberedCopyParam\(copyParam\)/,
    'the enabled preference must persist the edited transfer options');
  assert.match(prefpages, /check\('copyParam\.saveTransferOptions', false,/,
    'Preferences must expose the persisted switch');
  assert.match(prefpages, /const lab = h\('label', \{ class: 'pref-label', for: id \}/,
    'the generic renderer must associate the preference label with its control');
});

test('drag move preference is read by the panel drop consumer', async () => {
  const { schema } = await load();
  assert.equal(schema.PENDING_KEYS.has('dDAllowMove'), false);
  assert.equal(schema.PENDING_KEYS.has('dDAllowMoveInit'), false);
  const fs = require('node:fs');
  const path = require('node:path');
  const panels = fs.readFileSync(path.join(repoRoot, 'design', 'renderer', 'ui', 'panels.js'), 'utf8');
  assert.match(panels, /readPref\('dDAllowMove', false\)/);
  assert.match(panels, /readPref\('dDAllowMoveInit', false\)/);
  assert.match(panels, /effectAllowed = readPref\('dDAllowMove', false\) === true \? 'copyMove' : 'copy'/);
});

test('the control renderer mirrors disabled state onto native and composite controls', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const prefpages = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');
  assert.match(prefpages, /el\.setAttribute\('aria-disabled', String\(isDisabled\)\)/,
    'disabled native controls must expose their state explicitly');
  assert.match(prefpages, /node\.setAttribute\('aria-disabled', String\(!!disabled\)\)/,
    'focusable composite preference editors must expose their disabled state');
  assert.match(prefpages, /data-pref-validity/,
    'invalid imported values must be announced on their preference row');
  assert.match(prefpages, /setAttribute\('aria-invalid', 'true'\)/,
    'invalid imported values must be announced on the focusable control');
  assert.match(prefpages, /controlDisabled === '1'/,
    'intrinsically unavailable controls must not be re-enabled by dependency repainting');
});

test('a dependency-disabled preference row exposes its disabled state', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const prefpages = fs.readFileSync(
    path.join(repoRoot, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');
  assert.match(prefpages, /'aria-disabled': \(opts\.disabled \|\| opts\.pending\) \? 'true' : 'false'/,
    'the row must announce dependency-disabled controls, not only unavailable settings');
});

test('the Preferences layout collapses safely at narrow widths', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const preferences = fs.readFileSync(path.join(repoRoot,
    'design', 'renderer', 'ui', 'dialogs', 'preferences.js'), 'utf8');
  assert.match(preferences,
    /grid-template-columns:\s*minmax\(0, 0\.34fr\)\s+minmax\(0, 1fr\)/,
    'the desktop grid must allow both columns to shrink without horizontal overflow');
  assert.match(preferences, /\.prefs-nav-search \.sb, \.prefs-page-search \.sb, \.pref-list \.sb \{ min-width: 0; \}/,
    'embedded search bars must be allowed to shrink with their column');
  assert.match(preferences,
    /@media \(max-width: 760px\) \{[\s\S]*?\.prefs \{ grid-template-columns: 1fr; height: auto; max-height: 70vh;/,
    'narrow Preferences must stack navigation above content and stay viewport bounded');
  assert.match(preferences,
    /\.prefs-nav \{ border-right: none; border-bottom: 1px solid var\(--outline-var\); max-height: 40vh;/,
    'stacked navigation must retain an independently bounded scroll area');
});

test('the guard fails when a dead option is not declared', async () => {
  const { schema } = await load();
  const corpus = scan.readCorpus(repoRoot);
  const orphans = scan.orphanKeys(schema.allKeys(), corpus);
  // Every guard that "passes" needs this: proof that it can still fail. Drop
  // one genuinely dead option from the declaration and the comparison the test
  // above makes must reject it.
  const short = [...schema.PENDING_KEYS].filter((k) => k !== 'dDDrives').sort();
  assert.throws(() => assert.deepEqual(orphans, short));
  // And an option that gained a consumer while still declared fails too.
  const long = [...schema.PENDING_KEYS, 'showHiddenFiles'].sort();
  assert.throws(() => assert.deepEqual(orphans, long));
});

test('a test that names an option is not a consumer of it', async () => {
  const { schema } = await load();
  // The remaining options of issue #27. Each is stored, has a control, and is read
  // by nothing — yet the guard was green, because it walked test/ and THIS FILE
  // names every one of them (mustCover above, the controlEnabled cases, the
  // value-search case). The guard was proving its own subject matter consumed.
  const namedOnlyByTests = [
    'beepOnFinish', 'beepOnFinishAfter',
    'queue.keepDoneItemsFor', 'window.minimizeToTray', 'dDFakeFile', 'dDDrives',
    'integration.dragExtEnabled',
  ];
  const here = require('node:fs').readFileSync(__filename, 'utf8');
  for (const key of namedOnlyByTests) {
    assert.ok(here.includes(key), `${key} is no longer named by this test file`);
  }

  // The corpus is production code. No test file is in it, so no test can rescue
  // a key — including this one.
  const path = require('node:path');
  const files = scan.productionFiles(repoRoot);
  const designRoot = path.join(repoRoot, 'design') + path.sep;
  assert.ok(files.length > 50, `the scan found only ${files.length} files`);
  const outside = files.filter((f) => !f.startsWith(designRoot));
  assert.deepEqual(outside, [], 'the consumer scan is reading something that is not the application');

  // Three of the remaining options are read now — the transfer queue honours them — so they
  // are named by production code and not by this list.
  const corpus = scan.readCorpus(repoRoot);
  for (const key of ['queue.keepDoneItemsFor', 'beepOnFinish', 'beepOnFinishAfter']) {
    assert.ok(scan.consumersOf(key, corpus).includes('design/main/queue.js'),
      `${key} is no longer read by the queue`);
    assert.ok(!schema.PENDING_KEYS.has(key), `${key} is honoured and still claims it is not`);
  }
  // The other four are declared, so their rows say plainly that nothing acts
  // on them.
  for (const key of ['window.minimizeToTray',
    'dDFakeFile', 'dDDrives', 'integration.dragExtEnabled']) {
    assert.deepEqual(scan.consumersOf(key, corpus), [], `${key} has a consumer now`);
    assert.ok(schema.PENDING_KEYS.has(key), `${key} is read by nothing and says so on no row`);
  }
});

test('show inaccessible directories is now consumed by the runtime file lists', async () => {
  const { schema } = await load();
  const corpus = scan.readCorpus(repoRoot);
  assert.ok(!schema.PENDING_KEYS.has('showInaccessibleDirectories'),
    'the preferences row should no longer warn that nothing acts on it');
  assert.deepEqual(scan.consumersOf('showInaccessibleDirectories', corpus).sort(), [
    'design/main/dirview.js',
    'design/main/guitools.js',
    'design/main/ipc.js',
  ], 'the live consumers should all read the correctly spelled key');
});

test('opened tabs shortcut preference controls the real command binding', async () => {
  const { schema } = await load();
  const corpus = scan.readCorpus(repoRoot);
  assert.ok(!schema.PENDING_KEYS.has('window.openedTabsShortcut'));
  assert.deepEqual(scan.consumersOf('window.openedTabsShortcut', corpus), [
    'design/renderer/ui/commands.js',
  ]);
  const commands = require('node:fs').readFileSync(
    require('node:path').join(repoRoot, 'design', 'renderer', 'ui', 'commands.js'), 'utf8');
  assert.match(commands, /def\('OpenedTabsAction',[\s\S]*?shortcut: 'Ctrl\+Shift\+Tab'/);
  assert.match(commands, /def\('OpenedTabsAction',[\s\S]*?readPrefs\(\)\['window\.openedTabsShortcut'\] !== false/);
  assert.match(commands, /if \(!state\.visible \|\| !state\.enabled\) return;/);
});

test('a comment that names an option is not a consumer of it either', async () => {
  const { schema } = await load();
  const corpus = scan.readCorpus(repoRoot);
  // design/main/session.js documents four sessionReopen* settings in one doc
  // comment above _scheduleReconnect and reads two of them. The other two were
  // counted as honoured on the strength of that comment alone, so their rows
  // never warned anybody.
  const session = require('node:fs')
    .readFileSync(require('node:path').join(repoRoot, 'design', 'main', 'session.js'), 'utf8');
  assert.ok(session.includes('sessionReopenBackground'), 'the comment under test is gone');
  for (const key of ['security.sessionReopenAutoStall', 'editor.warnOrphans']) {
    assert.deepEqual(scan.consumersOf(key, corpus), [], `${key} has a consumer now`);
    assert.ok(schema.PENDING_KEYS.has(key), `${key} is read by nothing and says so on no row`);
  }

  // sessionReopenBackground was in that list until the queue's reconnect
  // supervisor landed and actually read it — two changes from the same wave,
  // one declaring the key dead and the other bringing it to life. They merged
  // without a textual conflict and the guard caught it, which is the whole
  // point of the guard: it is the only thing that noticed.
  //
  // Asserting the read rather than deleting the case keeps that permanent. If
  // the supervisor is ever removed, this fails loudly instead of the option
  // quietly going back to doing nothing while its row says it works.
  assert.deepEqual(scan.consumersOf('security.sessionReopenBackground', corpus),
    ['design/main/ipc.js'],
    'the queue reconnect supervisor is what reads this — if it moved, say where');
  assert.ok(!schema.PENDING_KEYS.has('security.sessionReopenBackground'),
    'a key with a real consumer must not still tell the user nothing acts on it');

  // The two that ARE read still read as read, so the comment rule did not take
  // its neighbours down with it.
  assert.ok(scan.consumersOf('security.sessionReopenAuto', corpus).includes('design/main/session.js'));
  assert.ok(scan.consumersOf('security.sessionReopenTimeout', corpus).length > 0);
});

/* ---------------------------------------------------- the scan's own rules */

/** A one-file corpus, so the rules can be stated on sources small enough to read. */
const fakeCorpus = (source) => [{ file: 'design/main/fake.js', ...scan.splitSource(source) }];

test('a read counts however the consumer spells it', async () => {
  const shapes = [
    'const keep = qp.keepDoneItemsFor;',
    'const { keepDoneItemsFor } = this.prefs().queue;',
    'const n = prefs.queue["keepDoneItemsFor"];',
    "const n = readPref('queue.keepDoneItemsFor', 15);",
    'const MAP = {\n  QueueKeepDoneItemsFor: "keepDoneItemsFor",\n};',
    'log(`kept for ${p.keepDoneItemsFor}s`);',
  ];
  for (const src of shapes) {
    assert.deepEqual(scan.consumersOf('queue.keepDoneItemsFor', fakeCorpus(src)),
      ['design/main/fake.js'], src);
  }
});

test('a comment or a sentence about an option is not a read of it', async () => {
  const notReads = [
    '// TODO: honour keepDoneItemsFor one day\nconst x = 1;',
    '/** Completed items are kept for keepDoneItemsFor seconds. */\nfunction f() {}',
    'note("keepDoneItemsFor was never wired up in this build");',
    'const entry = { text: "queue.keepDoneItemsFor had no consumer" };',
  ];
  for (const src of notReads) {
    assert.deepEqual(scan.consumersOf('queue.keepDoneItemsFor', fakeCorpus(src)), [], src);
  }
});

test('a regular expression does not swallow the code after it', async () => {
  // /['"]/ carries a lone quote. A scanner that reads it as the start of a
  // string loses every line up to the next quote — which is how an earlier
  // draft lost editors.js:218 and reported four honoured options as dead.
  const src = [
    'const q = /[\'"]/;',
    'const drive = /^[A-Z]:$/i;',
    'if (this.prefs().singleEditor !== false) reuse();',
    'const half = total / 2 / count;',
    'return /\\.tmp$/.test(name);',
    'if (this.prefs().maxEditors > 0) cap();',
  ].join('\n');
  const corpus = fakeCorpus(src);
  assert.deepEqual(scan.consumersOf('editor.singleEditor', corpus), ['design/main/fake.js']);
  assert.deepEqual(scan.consumersOf('editor.maxEditors', corpus), ['design/main/fake.js']);
});

test('an apostrophe in a comment does not open a string', async () => {
  const src = "// the queue's own sweep\nconst n = qp.keepDoneItemsFor;\n";
  assert.deepEqual(scan.consumersOf('queue.keepDoneItemsFor', fakeCorpus(src)),
    ['design/main/fake.js']);
});

test('an option no file mentions at all is an orphan', async () => {
  const corpus = fakeCorpus('const a = 1;');
  assert.deepEqual(scan.orphanKeys(['dDDrives', 'queue.keepDoneItemsFor'], corpus),
    ['dDDrives', 'queue.keepDoneItemsFor']);
});
