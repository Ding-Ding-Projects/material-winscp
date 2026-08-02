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
 * whole tree for a consumer of every key the preferences surface writes, and
 * holds the schema's own PENDING_KEYS list to exactly the set with none.
 *
 * It fails in both directions on purpose. An option that quietly stops being
 * honoured fails, and so does one that gains a consumer while still telling the
 * user on its row that nothing reads it — the note has to go when the wiring
 * lands, or the note becomes the new lie.
 */
test('every option either has a consumer or says on its own row that it has none', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { schema } = await load();

  // The preferences surface itself is excluded: it declares and writes these
  // keys, so a reference from here proves nothing about anything honouring them.
  const SURFACE = new Set([
    'prefpages.js', 'preferences.js', 'copyparams.js', 'editorpreferences.js',
    'customcommand.js', 'defaults.js',
  ]);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && !SURFACE.has(entry.name)) files.push(p);
    }
  };
  const repo = path.join(__dirname, '..');
  walk(path.join(repo, 'design'));
  walk(path.join(repo, 'test'));
  const blobs = files.map((f) => fs.readFileSync(f, 'utf8'));

  const escape = (s) => Array.from(s)
    .map((ch) => (/[A-Za-z0-9_]/.test(ch) ? ch : `\${ch}`)).join('');

  const orphans = [];
  for (const key of schema.allKeys()) {
    const leaf = key.split('.').pop();
    // Either the whole dotted path appears, or the leaf appears as a property
    // name / string key somewhere — which is how a consumer reads it after
    // destructuring a prefs object.
    //
    // The leading class must NOT exclude `.`, however tempting it looks. A
    // consumer almost never writes the dotted path: it holds the sub-object and
    // reads `cp.excludeEmptyDirectories`, `p.showOnStartup`,
    // `this.prefs().maxEditors`. Excluding a preceding dot made every one of
    // those invisible, so the scan called three honoured options orphans and the
    // dialog told users nothing acted on them — the guard producing exactly the
    // lie it exists to catch, in reverse.
    const re = new RegExp(`[^A-Za-z0-9_]${escape(leaf)}[^A-Za-z0-9_]`);
    if (!blobs.some((s) => s.includes(key) || re.test(s))) orphans.push(key);
  }

  const declared = [...schema.PENDING_KEYS].sort();
  assert.deepEqual(orphans.sort(), declared,
    'PENDING_KEYS no longer matches the options nothing reads — either an option '
    + 'lost its consumer, or one gained a consumer and is still telling the user it has none');

  // And the note really is rendered for them: a list nobody shows is a list
  // nobody reads.
  const prefpages = fs.readFileSync(
    path.join(repo, 'design', 'renderer', 'ui', 'dialogs', 'prefpages.js'), 'utf8');
  assert.match(prefpages, /if \(isPending\(control\.key\)\) \{/,
    'the pending note is no longer rendered on the row');
  assert.match(prefpages, /nothing in this build acts on it yet/);
});
