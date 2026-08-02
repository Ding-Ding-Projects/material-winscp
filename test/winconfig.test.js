// winconfig.test.js — the layer between the config store and the application.
//
// The migrations are the reason this file exists. By definition nobody runs an
// upgrade twice, so a migration that drops a setting is discovered by the user
// and never by the developer. Every test below therefore starts from an
// old-shaped object and asserts what survived, and every migration is asserted
// to be a no-op the second time it runs.
//
// The rest covers the parts of WinConfiguration/GUIConfiguration whose edge
// cases came out of reading the C++: the editor list's derived names and its
// legacy-record split, the extension parser's refusals, the preset rule's path
// matching, the bookmark list's duplicate refusal, the BGR colour format and
// the temporary-directory naming that cleanup depends on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../design/main/winconfig');
const P = require('../design/main/paths');
const { Config, DEFAULT_PRESETS, DEFAULT_CUSTOM_COMMANDS } = require('../design/main/config');
const { PREF_DEFAULTS, COPY_PARAM_DEFAULTS } = require('../design/main/defaults');

/** A store rooted in a throwaway directory, so nothing touches the real one. */
function freshConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winconfig-test-'));
  P.setRoot(root);
  const config = new Config().load();
  return { config, root, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

// ===========================================================================
// helpers ported from core/Common.cpp
// ===========================================================================

test('addToList never produces a leading or doubled delimiter', () => {
  assert.equal(W.addToList('', 'a', '|'), 'a');
  assert.equal(W.addToList('a', 'b', '|'), 'a|b');
  assert.equal(W.addToList('a|', 'b', '|'), 'a|b');
  // An empty value adds nothing at all, delimiter included.
  assert.equal(W.addToList('a', '', '|'), 'a');
});

test('cutToChar splits at the first occurrence and trims each side on request', () => {
  assert.deepEqual(W.cutToChar('a,b,c', ',', false), { head: 'a', tail: 'b,c' });
  assert.deepEqual(W.cutToChar('abc', ',', false), { head: 'abc', tail: '' });
  assert.deepEqual(W.cutToChar('a  ,  b', ',', true), { head: 'a', tail: 'b' });
});

test('splitCommand keeps a quoted program together and refuses an unclosed quote', () => {
  assert.deepEqual(W.splitCommand('"C:\\Program Files\\Foo\\ed.exe" -x !.!'), {
    program: 'C:\\Program Files\\Foo\\ed.exe', params: '-x !.!', dir: 'C:\\Program Files\\Foo\\',
  });
  assert.deepEqual(W.splitCommand('notepad !.!'), { program: 'notepad', params: '!.!', dir: '' });
  assert.throws(() => W.splitCommand('"unclosed path\\ed.exe -x'), /Invalid shell command/);
});

test('reformatFileNameCommand appends the file placeholder exactly once', () => {
  assert.equal(W.reformatFileNameCommand('notepad'), 'notepad !.!');
  assert.equal(W.reformatFileNameCommand('notepad !.!'), 'notepad !.!');
  assert.equal(W.reformatFileNameCommand('"C:\\a b\\ed.exe"'), '"C:\\a b\\ed.exe" !.!');
  assert.equal(W.reformatFileNameCommand(''), '');
});

test('addQuotes quotes only when the value contains a space', () => {
  assert.equal(W.addQuotes('notepad.exe'), 'notepad.exe');
  assert.equal(W.addQuotes('C:\\a b\\x.exe'), '"C:\\a b\\x.exe"');
  assert.equal(W.formatCommand('C:\\a b\\x.exe', '-p'), '"C:\\a b\\x.exe" -p');
});

test('compound versions zero the build number so daily builds share an entry', () => {
  assert.equal(W.strToCompoundVersion('6.3.4'), W.compoundVersion(6, 3, 4));
  assert.equal(W.zeroBuildNumber(W.compoundVersion(6, 3, 4) + 17), W.compoundVersion(6, 3, 4));
  // StrToCompoundVersion clamps each field at 99.
  assert.equal(W.strToCompoundVersion('600.3.4'), W.compoundVersion(99, 3, 4));
  assert.equal(W.compareVersion('6.3', '6.3.0'), 0);
  assert.equal(W.compareVersion('6.3', '6.4'), -1);
});

// ===========================================================================
// CommaText — the format the file-colour list is stored in
// ===========================================================================

test('CommaText round-trips a mask containing spaces, commas and quotes', () => {
  const items = ['*.tmp; *.bak', 'plain', 'has,comma', 'say "hi"', ''];
  assert.deepEqual(W.commaTextToList(W.listToCommaText(items)), items);
});

test('CommaText treats unquoted whitespace as a delimiter, as Delphi does', () => {
  // This is why the writer quotes anything with a space: it is not decoration.
  assert.deepEqual(W.commaTextToList('a b,c'), ['a', 'b', 'c']);
  assert.deepEqual(W.commaTextToList('"a b",c'), ['a b', 'c']);
});

// ===========================================================================
// colours — TColor is BGR, not RGB
// ===========================================================================

test('a stored colour is BGR, so "0000FF" is red', () => {
  assert.equal(W.colorFromWinscp('0000FF'), '#FF0000');
  assert.equal(W.colorFromWinscp('FF0000'), '#0000FF');
  assert.equal(W.colorToWinscp('#FF0000'), '0000FF');
  assert.equal(W.colorToWinscp('#123456'), '563412');
  assert.equal(W.colorFromWinscp(W.colorToWinscp('#2E7D32')), '#2E7D32');
});

test('file colour rules save and load through the WinSCP list format', () => {
  const list = [{ mask: '*.tmp; *.bak', color: '#FF0000' }, { mask: '*.log', color: '#00FF00' }];
  const saved = W.saveFileColors(list);
  assert.equal(saved, '"0000FF:*.tmp; *.bak",00FF00:*.log');
  assert.deepEqual(W.loadFileColors(saved).map((c) => c.toJSON()), list);
});

test('the first matching file colour wins and a non-match paints nothing', () => {
  const list = [{ mask: '*.log', color: '#FF0000' }, { mask: '*.*', color: '#00FF00' }];
  assert.equal(W.fileColorFor(list, 'server.log'), '#FF0000');
  assert.equal(W.fileColorFor(list, 'notes.txt'), '#00FF00');
  assert.equal(W.fileColorFor([{ mask: '*.log', color: '#FF0000' }], 'notes.txt'), '');
});

test('a file colour keeps a mask that itself contains a colon', () => {
  // TFileColorData::Load cuts at the FIRST colon only.
  const parsed = W.FileColorData.parse('0000FF:*.txt>1M');
  assert.equal(parsed.color, '#FF0000');
  assert.equal(parsed.mask, '*.txt>1M');
});

// ===========================================================================
// the editor list
// ===========================================================================

test('an editor display name loses its extension and normalises its case', () => {
  const name = (external) => new W.EditorPreferences({ editor: 'external', external }).name;
  assert.equal(name('notepad.exe'), 'Notepad');
  assert.equal(name('NOTEPAD.EXE'), 'Notepad');
  assert.equal(name('"C:\\Program Files\\Vim\\gvim.exe"'), 'Gvim');
  assert.equal(new W.EditorPreferences({ editor: 'internal' }).name, 'Internal editor');
  assert.equal(new W.EditorPreferences({ editor: 'open' }).name, 'Opening editor');
});

test('the editor list returns the FIRST matching row, so order is the rule', () => {
  const list = new W.EditorList([
    { mask: '*.log', type: 'external', external: 'tail.exe' },
    { mask: '*.*', type: 'internal' },
  ]);
  assert.equal(list.find('server.log').external, 'tail.exe');
  assert.equal(list.find('notes.txt').editor, 'internal');
  list.move(1, 0);
  assert.equal(list.find('server.log').editor, 'internal');
});

test('a size-bounded editor mask only matches when the size is supplied', () => {
  const list = new W.EditorList([{ mask: '*.txt<1M', type: 'internal' }]);
  assert.ok(list.find('a.txt', true, { size: 1024 }));
  assert.equal(list.find('a.txt', true, { size: 5 * 1024 * 1024 }), null);
});

test('isDefaultList accepts the internal and default external editors only', () => {
  assert.ok(new W.EditorList([{ mask: '*.*', type: 'internal' }]).isDefaultList());
  assert.ok(new W.EditorList([{ mask: '*.*', type: 'external', external: 'notepad.exe' }]).isDefaultList());
  assert.equal(new W.EditorList([{ mask: '*.*', type: 'external', external: 'vim.exe' }]).isDefaultList(), false);
  // "open" is a deliberate user choice, so the list is no longer the default.
  assert.equal(new W.EditorList([{ mask: '*.*', type: 'open' }]).isDefaultList(), false);
});

test('changing an editor to an equal one is not a modification', () => {
  const list = new W.EditorList([{ mask: '*.*', type: 'internal' }]);
  list.saved();
  assert.equal(list.change(0, { mask: '*.*', type: 'internal' }), false);
  assert.equal(list.modified, false);
  assert.equal(list.change(0, { mask: '*.txt', type: 'internal' }), true);
  assert.equal(list.modified, true);
});

test('deleting a row that is not there is refused rather than ignored', () => {
  const list = new W.EditorList([{ mask: '*.*', type: 'internal' }]);
  assert.throws(() => list.delete(3), RangeError);
});

test('the legacy single editor becomes internal + the external one it named', () => {
  const list = W.editorListFromLegacy(new W.EditorPreferences({ editor: 'internal', external: 'vim.exe' }));
  assert.equal(list.count, 2);
  assert.equal(list.get(0).editor, 'internal');
  // The external command moves to the alternative row and leaves the first.
  assert.equal(list.get(0).external, '');
  assert.equal(list.get(1).editor, 'external');
  assert.equal(list.get(1).external, 'vim.exe');
});

test('a legacy external editor with no command falls back to the internal one', () => {
  const list = W.editorListFromLegacy(new W.EditorPreferences({ editor: 'external', external: '' }));
  assert.equal(list.count, 1);
  assert.equal(list.get(0).editor, 'internal');
});

test('a legacy external editor keeps its command and gains an internal fallback', () => {
  const list = W.editorListFromLegacy(new W.EditorPreferences({ editor: 'external', external: 'vim.exe' }));
  assert.equal(list.count, 2);
  assert.equal(list.get(0).editor, 'external');
  assert.equal(list.get(0).external, 'vim.exe');
  assert.equal(list.get(1).editor, 'internal');
  assert.equal(list.get(1).external, 'vim.exe');
});

test('Notepad is auto-detected as SDI, and as text only before Windows 10 1809', () => {
  const before = new W.EditorPreferences({ editor: 'external', external: 'notepad.exe' })
    .externalEditorOptionsAutodetect({ win10Build17763: false });
  assert.equal(before.externalText, true);
  assert.equal(before.sdiExternal, true);

  const after = new W.EditorPreferences({ editor: 'external', external: 'notepad.exe' })
    .externalEditorOptionsAutodetect({ win10Build17763: true });
  assert.equal(after.externalText, false, 'modern Notepad handles every EOL style');
  assert.equal(after.sdiExternal, true);

  // A third-party editor is left alone entirely.
  const other = new W.EditorPreferences({ editor: 'external', external: 'vim.exe' })
    .externalEditorOptionsAutodetect({ win10Build17763: false });
  assert.equal(other.externalText, false);
  assert.equal(other.sdiExternal, false);
});

// ===========================================================================
// custom commands
// ===========================================================================

test('custom command parameter bits round-trip through the stored flag object', () => {
  const bits = W.CC.APPLY_TO_DIRECTORIES | W.CC.RECURSIVE | W.CC.SHOW_RESULTS;
  const flags = W.paramsFromBits(bits);
  assert.equal(flags.remote, true, 'no ccLocal bit means the command runs remotely');
  assert.equal(flags.applyToDirectories, true);
  assert.equal(flags.recursive, true);
  assert.equal(W.paramsToBits(flags), bits);
  assert.equal(W.paramsFromBits(W.CC.LOCAL).remote, false);
});

test('sortBy keeps the saved order and appends new commands alphabetically', () => {
  const list = new W.CustomCommandList([
    { id: 'a', name: 'Zebra' }, { id: 'new2', name: 'Beta' },
    { id: 'b', name: 'Alpha' }, { id: 'new1', name: 'Alpha2' },
  ]);
  list.sortBy(['b', 'a']);
  assert.deepEqual(list.items.map((c) => c.id), ['b', 'a', 'new1', 'new2']);
});

test('a custom command list finds by name, by shortcut and by file path spelling', () => {
  const list = new W.CustomCommandList([
    { name: 'Grep', command: 'grep "!" !&', shortCut: 'Ctrl+1', fileName: 'C:\\Ext\\Grep.WinSCPextension.ps1' },
  ]);
  assert.equal(list.findByName('Grep').command, 'grep "!" !&');
  assert.equal(list.findByName('Nope'), null);
  assert.equal(list.findByShortCut('Ctrl+1').name, 'Grep');
  assert.equal(list.findByShortCut(''), null, 'no shortcut never matches the unbound commands');
  assert.equal(list.findIndexByFileName('c:/ext/grep.WinSCPextension.ps1'), 0);
  assert.equal(list.findIndexByFileName('c:/other/grep.WinSCPextension.ps1'), -1);
});

test('WinSCP only allows Ctrl+digit and Shift+Ctrl+Alt+letter as a custom shortcut', () => {
  assert.equal(W.normalizeShortCut('Ctrl+5'), 'Ctrl+5');
  assert.equal(W.normalizeShortCut('Shift+Ctrl+Alt+K'), 'Shift+Ctrl+Alt+K');
  assert.equal(W.normalizeShortCut('Ctrl+K'), '', 'Ctrl+letter would shadow a menu accelerator');
  assert.equal(W.normalizeShortCut('F5'), '');
  assert.equal(W.normalizeShortCut('Ctrl+Shift+5'), '');
  // NormalizeCustomShortCut folds the numeric keypad onto the number row.
  assert.equal(W.normalizeShortCut('Ctrl+Num 5'), 'Ctrl+5');
});

test('a shortcut round-trips through WinSCP\'s integer form', () => {
  assert.equal(W.textToShortCut('Ctrl+5'), 0x4035);
  assert.equal(W.shortCutToText(0x4035), 'Ctrl+5');
  assert.equal(W.shortCutToText(0xE041), 'Shift+Ctrl+Alt+A');
  assert.equal(W.normalizeShortCut(0xE041), 'Shift+Ctrl+Alt+A');
  assert.equal(W.shortCutToText(0), '');
});

test('the shipped default custom commands match the ones WinSCP seeds', () => {
  const defaults = W.winscpDefaultCustomCommands();
  assert.deepEqual(defaults.map((c) => c.name),
    ['Execute', 'Touch', 'Tar/GZip', 'UnTar/GZip', 'Grep', 'Print']);
  // Print is the only local one; Touch is the only recursive one.
  assert.equal(defaults.find((c) => c.name === 'Print').flags.remote, false);
  assert.equal(defaults.find((c) => c.name === 'Touch').flags.recursive, true);
  assert.equal(defaults.find((c) => c.name === 'Grep').flags.showResults, true);
});

// ===========================================================================
// the extension mechanism
// ===========================================================================

const ZIP_EXTENSION = [
  '# @name Zip',
  '# @command "pwsh -File %EXTENSION_PATH% %FILES%"',
  '# @description Compress the selected files',
  '# @side Remote',
  '# @flag ApplyToDirectories',
  '# @flag ShowResults',
  '# @shortcut Ctrl+3',
  '# @option Level -run dropdownlist "Compression level" 9 1 5 9',
  '# @option - separator',
  '# @homepage https://winscp.net/',
  'Write-Host "running"',
  '# @name NotSeenBecauseCodeStarted',
].join('\n');

test('an extension parses its directives, flags, shortcut and option controls', () => {
  const c = W.parseExtension(ZIP_EXTENSION, { id: 'userext/Zip', fileName: '/x/Zip.WinSCPextension.ps1' });
  assert.equal(c.name, 'Zip');
  assert.equal(c.description, 'Compress the selected files');
  assert.equal(c.homePage, 'https://winscp.net/');
  assert.equal(c.flags.remote, true, '@side Remote clears the ccLocal bit');
  assert.equal(c.flags.applyToDirectories, true);
  assert.equal(c.flags.showResults, true);
  assert.equal(c.shortCut, 'Ctrl+3');
  assert.equal(c.hasCustomShortCut(), false, 'the file declared it, so it is not an override');
  assert.equal(c.optionsCount(), 2);
  assert.equal(c.option(0).kind, 'dropDownList');
  assert.deepEqual(c.option(0).params, ['1', '5', '9']);
  assert.equal(c.option(1).isControl, false, 'the id "-" is decoration, not a control');
});

test('parsing stops at the first line of real code', () => {
  const c = W.parseExtension(ZIP_EXTENSION, { id: 'userext/Zip' });
  assert.equal(c.name, 'Zip', 'the @name after the code line is ignored');
});

test('%EXTENSION_PATH% is replaced with the extension\'s own file path', () => {
  const c = W.parseExtension(ZIP_EXTENSION, { id: 'x', fileName: 'C:\\Ext\\Zip.WinSCPextension.ps1' });
  assert.ok(c.command.includes('C:\\Ext\\Zip.WinSCPextension.ps1'));
  assert.equal(c.command.includes('%EXTENSION_PATH%'), false);
});

test('a "^" continues a directive onto the next line', () => {
  const c = W.parseExtension([
    '# @name Long ^',
    '# name here',
    '# @command echo 1',
  ].join('\n'), {});
  assert.equal(c.name, 'Long name here');
});

test('every comment marker WinSCP accepts introduces a directive', () => {
  for (const marker of ['#', ';', "'", '//', 'rem ', '']) {
    const c = W.parseExtension(`${marker}@name N\n${marker}@command echo 1\n`, {});
    assert.equal(c.name, 'N', `marker ${JSON.stringify(marker)}`);
  }
});

test('an extension missing @name or @command is refused', () => {
  assert.throws(() => W.parseExtension('# @command echo 1\n', {}), /@name/);
  assert.throws(() => W.parseExtension('# @name N\n', {}), /@command/);
});

test('a file with no directives at all is refused as not an extension', () => {
  assert.throws(() => W.parseExtension('# just a comment\necho 1\n', {}), /not a WinSCP extension/);
  assert.throws(() => W.parseExtension('', {}), /not a WinSCP extension/);
});

test('an unsatisfied @require is refused rather than half-loaded', () => {
  const text = '# @name N\n# @require winscp 9.9.9\n# @command echo 1\n';
  assert.throws(() => W.parseExtension(text, { versions: { winscp: W.strToCompoundVersion('6.0.0') } }),
    /requires winscp 9\.9\.9/);
  assert.doesNotThrow(() => W.parseExtension(text, { versions: { winscp: W.strToCompoundVersion('9.9.9') } }));
});

test('an unknown dependency, and a known one on an unknown host, both refuse', () => {
  assert.throws(() => W.parseExtension('# @name N\n# @require banana 1\n# @command x\n', {}), /requires banana 1/);
  assert.throws(() => W.parseExtension('# @name N\n# @require pwsh 7\n# @command x\n', {}), /requires pwsh 7/);
  assert.doesNotThrow(() => W.parseExtension('# @name N\n# @require pwsh 7\n# @command x\n',
    { versions: { pwsh: '7.4.1' } }));
});

test('an invalid @side, @flag, @shortcut or @option value is refused', () => {
  const bad = (line) => () => W.parseExtension(`# @name N\n# ${line}\n# @command x\n`, {});
  assert.throws(bad('@side Sideways'), /Invalid value/);
  assert.throws(bad('@flag Sideways'), /Invalid value/);
  assert.throws(bad('@shortcut Ctrl+K'), /Invalid value/);
  assert.throws(bad('@option Level label "x"'), /Invalid value/, 'a label may not claim a control id');
});

test('two option controls may not share an id', () => {
  const text = [
    '# @name N', '# @option Level textbox "A" 1', '# @option level textbox "B" 2', '# @command x',
  ].join('\n');
  assert.throws(() => W.parseExtension(text, {}), /Invalid value/);
});

test('several separators may share the "-" id, because they are not controls', () => {
  const text = ['# @name N', '# @option - separator', '# @option - separator', '# @command x'].join('\n');
  assert.equal(W.parseExtension(text, {}).optionsCount(), 2);
});

test('an option defaults to -config, and sessionlogfile/pausecheckbox carry defaults', () => {
  const text = [
    '# @name N',
    '# @option LogFile sessionlogfile',
    '# @option Pause -run pausecheckbox',
    '# @command x',
  ].join('\n');
  const c = W.parseExtension(text, { fileName: '/x/MyExt.WinSCPextension.ps1' });
  const log = c.option(0);
  assert.equal(log.kind, 'file');
  assert.equal(log.flags, W.OPTION_FLAG.CONFIG, 'neither -run nor -config given means -config');
  assert.equal(log.fileInitial, '%TEMP%\\MyExt.log', 'the base name drops every extension');
  assert.equal(log.fileExt, 'log');
  const pause = c.option(1);
  assert.equal(pause.kind, 'checkBox');
  assert.equal(pause.default, '-pause');
  assert.deepEqual(pause.params, ['-pause']);
});

test('an option value the user set is escaped; an untouched default is not', () => {
  const c = W.parseExtension([
    '# @name N',
    '# @option Path -run textbox "Path" !/',
    '# @command "run %Path%"',
  ].join('\n'), {});
  const escape = (s) => s.split('!').join('!!');
  // Untouched: the author may have written a pattern into the default.
  assert.equal(c.commandWithExpandedOptions({}, '', { escape }), '"run !/"');
  // Set by the user: it is data, so "!" must not become a pattern.
  assert.equal(c.commandWithExpandedOptions({ '\\Path': '/tmp/!x' }, '', { escape }),
    c.commandWithExpandedOptions({ [c.optionKey(c.option(0), '')]: '/tmp/!x' }, '', { escape }));
  assert.equal(c.commandWithExpandedOptions({ [c.optionKey(c.option(0), '')]: '/tmp/!x' }, '', { escape }),
    '"run /tmp/!!x"');
});

test('a -site option is stored per site, so two servers keep different values', () => {
  const c = W.parseExtension('# @name N\n# @option Dir -site textbox "Dir" .\n# @command x %Dir%\n', { id: 'userext/N' });
  const option = c.option(0);
  assert.equal(c.optionKey(option, 'alpha'), 'userext/N\\Dir\\alpha');
  assert.equal(c.optionKey(option, 'beta'), 'userext/N\\Dir\\beta');
  assert.ok(c.anyOptionWithFlag(W.OPTION_FLAG.SITE));
});

test('an extension id comes from the file name, and needs a base name', () => {
  assert.equal(W.extensionIdOfFileName('Zip.WinSCPextension.ps1'), 'Zip');
  assert.equal(W.extensionIdOfFileName('Zip.WinSCPextension'), 'Zip');
  assert.equal(W.extensionIdOfFileName('Zip.WINSCPEXTENSION.ps1'), 'Zip', 'the match is case-insensitive');
  assert.equal(W.extensionIdOfFileName('.WinSCPextension'), '', 'no base name, no id');
  assert.equal(W.extensionIdOfFileName('Zip.WinSCPextensionX'), '', 'must end there or at a dot');
  assert.equal(W.extensionIdOfFileName('readme.txt'), '');
});

test('the provisionary id and the base name drop every extension, not just the last', () => {
  assert.equal(W.extensionBaseName('/x/My.Great.WinSCPextension.ps1'), 'My');
  assert.equal(W.provisionaryExtensionId('My.WinSCPextension.ps1'), 'userext/My');
  assert.equal(W.uniqueExtensionName('Zip', 2), 'Zip2');
});

test('loading extensions honours the deleted list and rebuilds it from disk', () => {
  const files = {
    'C:/app/Extensions': {
      'Zip.WinSCPextension.ps1': '# @name Zip\n# @command echo zip\n',
      'Gone.WinSCPextension.ps1': '# @name Gone\n# @command echo gone\n',
      'broken.WinSCPextension.ps1': 'not an extension at all\n',
      'readme.txt': 'ignored',
    },
  };
  const key = (p) => String(p).replace(/\\/g, '/');
  const result = W.loadExtensionList({
    roots: { appDir: 'C:/app', userDataDir: 'C:/data' },
    deleted: 'commonext/Gone|commonext/NoLongerOnDisk',
    readDir: (dir) => Object.keys(files[key(dir)] || {}),
    readFile: (file) => {
      const dir = key(path.dirname(file));
      return (files[dir] || {})[path.basename(file)] || null;
    },
  });
  assert.deepEqual(result.list.items.map((c) => c.name), ['Zip'], 'deleted and broken files are skipped');
  assert.equal(result.deleted, 'commonext/Gone',
    'an id whose file is gone leaves the deleted list, so re-installing it works');
});

test('extension state records the order, the shortcut overrides and the deletions', () => {
  const list = new W.CustomCommandList([
    { id: 'userext/B', name: 'B', shortCut: 'Ctrl+2', shortCutOriginal: 'Ctrl+2' },
    { id: 'userext/A', name: 'A', shortCut: 'Ctrl+1', shortCutOriginal: '' },
  ]);
  const state = W.extensionListState(list, 'userext/A|userext/Old', ['userext/Undeletable']);
  assert.equal(state.order, 'userext/B|userext/A');
  assert.equal(state.shortCuts, 'Ctrl+1=userext/A', 'only an override, not what the file declared');
  assert.equal(state.deleted, 'userext/Old|userext/Undeletable',
    'A came back so it is no longer deleted; the undeletable file stays hidden');
});

// ===========================================================================
// transfer presets and their auto-selection rules
// ===========================================================================

test('an empty rule field is not a constraint and an empty rule never selects', () => {
  const rule = new W.CopyParamRule({ hostName: '*.example.com' });
  assert.ok(rule.matches({ hostName: 'web.example.com', userName: 'anyone' }));
  assert.equal(rule.matches({ hostName: 'web.other.net' }), false);
  assert.ok(new W.CopyParamRule({}).empty);
});

test('every populated rule field must match', () => {
  const rule = new W.CopyParamRule({ hostName: '*.example.com', userName: 'deploy' });
  assert.ok(rule.matches({ hostName: 'web.example.com', userName: 'deploy' }));
  assert.equal(rule.matches({ hostName: 'web.example.com', userName: 'root' }), false);
});

test('a directory rule matches the directory itself and anything beneath it', () => {
  const rule = new W.CopyParamRule({ remoteDirectory: '/var/www' });
  assert.ok(rule.matches({ remoteDirectory: '/var/www' }));
  assert.ok(rule.matches({ remoteDirectory: '/var/www/site/assets' }),
    'forced directory masks are what make a rule cover a subtree');
  assert.equal(rule.matches({ remoteDirectory: '/srv/other' }), false);
});

test('the first preset whose rule matches wins, in list order', () => {
  const list = new W.CopyParamList([
    { name: 'broad', rule: { hostName: '*.example.com' }, copyParam: {} },
    { name: 'specific', rule: { hostName: 'web.example.com' }, copyParam: {} },
    { name: 'none', copyParam: {} },
  ]);
  assert.equal(list.get(list.find({ hostName: 'web.example.com' })).name, 'broad');
  assert.equal(list.find({ hostName: 'other.net' }), -1);
  assert.ok(list.anyRule);
});

test('a preset name may not contain a storage-key character, nor repeat', () => {
  const list = new W.CopyParamList([]);
  assert.throws(() => list.add('a/b', {}), /cannot contain/);
  assert.throws(() => list.add('a[b]', {}), /cannot contain/);
  list.add('fine', {});
  assert.throws(() => list.add('fine', {}), /already exists/);
});

test('a preset overrides everything except the three global transfer options', () => {
  const defaults = { ...COPY_PARAM_DEFAULTS, resumeSupport: 'off', resumeThreshold: 999, invalidCharsReplacement: '#' };
  const list = new W.CopyParamList([{
    name: 'text',
    copyParam: { transferMode: 'text', resumeSupport: 'on', resumeThreshold: 1, invalidCharsReplacement: '@' },
  }]);
  const preset = W.copyParamPreset('text', defaults, list);
  assert.equal(preset.transferMode, 'text');
  // These describe the machine, not the transfer, so a preset cannot change them.
  assert.equal(preset.resumeSupport, 'off');
  assert.equal(preset.resumeThreshold, 999);
  assert.equal(preset.invalidCharsReplacement, '#');
});

test('an unknown or empty preset name yields the default transfer settings', () => {
  const list = new W.CopyParamList([{ name: 'text', copyParam: { transferMode: 'text' } }]);
  assert.equal(W.copyParamPreset('', { transferMode: 'binary' }, list).transferMode, 'binary');
  assert.equal(W.copyParamPreset('nope', { transferMode: 'binary' }, list).transferMode, 'binary');
});

test('changing a preset to an identical one is not a modification', () => {
  const list = new W.CopyParamList([{ name: 'a', copyParam: { transferMode: 'text' } }]);
  list.reset();
  assert.equal(list.change(0, 'a', { transferMode: 'text' }, null), false);
  assert.equal(list.modified, false);
  assert.equal(list.change(0, 'a', { transferMode: 'binary' }, null), true);
  assert.equal(list.modified, true);
});

test('a preset serialises both the structured rule and its flattened summary', () => {
  const list = new W.CopyParamList([{ name: 'a', rule: { hostName: 'h', userName: 'u' }, copyParam: {} }]);
  const json = list.toJSON()[0];
  assert.deepEqual(json.rule, { hostName: 'h', userName: 'u', remoteDirectory: '', localDirectory: '' });
  assert.equal(json.autoSelect, 'h u');
  assert.equal(new W.CopyParamRule(json.rule).infoStr(), 'Host name: h; User name: u');
});

// ===========================================================================
// bookmarks and location profiles
// ===========================================================================

test('a bookmark is keyed by node and name, and a duplicate is refused', () => {
  const list = new W.BookmarkList();
  list.add({ name: 'www', local: 'C:\\www', remote: '/var/www' });
  assert.throws(() => list.add({ name: 'www' }), /already exists/);
  // The same name in a different folder is a different bookmark.
  assert.doesNotThrow(() => list.add({ node: 'Work', name: 'www' }));
  assert.equal(list.count, 2);
  assert.throws(() => list.add({ name: '' }), /needs a name/);
});

test('a bookmark carries both sides, which is what makes it a location profile', () => {
  const list = new W.BookmarkList();
  const b = list.add({ name: 'www', local: 'C:\\www', remote: '/var/www' });
  assert.equal(b.sideDirectory('local'), 'C:\\www');
  assert.equal(b.sideDirectory('remote'), '/var/www');
  assert.equal(list.findByName('', 'www'), b);
  assert.equal(list.findByName('Work', 'www'), null);
});

test('renaming a bookmark onto an existing key is refused, not silently merged', () => {
  const list = new W.BookmarkList();
  const a = list.add({ name: 'a' });
  list.add({ name: 'b' });
  assert.throws(() => list.rename(a, 'b'), /already exists/);
  assert.equal(list.rename(a, 'c').name, 'c');
});

test('moveTo corrects the index so "before" really lands before', () => {
  const list = new W.BookmarkList();
  const a = list.add({ name: 'a' });
  const b = list.add({ name: 'b' });
  const c = list.add({ name: 'c' });
  // Without the correction, removing "a" first would shift "c" up by one.
  list.moveTo(c, a, true);
  assert.deepEqual(list.items.map((x) => x.name), ['b', 'a', 'c']);
  list.moveTo(b, c, false);
  assert.deepEqual(list.items.map((x) => x.name), ['b', 'c', 'a']);
});

test('opened nodes and shortcuts are tracked, and a no-op change is not a change', () => {
  const list = new W.BookmarkList();
  list.add({ node: 'Work', name: 'a', shortCut: 'Ctrl+1' });
  assert.deepEqual(list.nodes(), ['Work']);
  assert.deepEqual(list.shortCuts(), ['Ctrl+1']);
  assert.equal(list.findByShortCut('Ctrl+1').name, 'a');
  list.modified = false;
  assert.equal(list.setNodeOpened('Work', true), true);
  assert.equal(list.modified, true);
  list.modified = false;
  assert.equal(list.setNodeOpened('Work', true), false, 'already open');
  assert.equal(list.modified, false);
  assert.ok(list.nodeOpened('Work'));
});

test('the legacy two-array bookmark shape pairs back up by name', () => {
  const list = W.BookmarkList.fromLegacy({
    local: [{ path: 'C:\\www', name: 'www' }, { path: 'C:\\only', name: 'localOnly' }],
    remote: [{ path: '/var/www', name: 'www' }],
    shortCuts: { www: 'Ctrl+1' },
  });
  const www = list.findByName('', 'www');
  assert.equal(www.local, 'C:\\www');
  assert.equal(www.remote, '/var/www');
  assert.equal(www.shortCut, 'Ctrl+1');
  assert.equal(list.findByName('', 'localOnly').remote, '');
  // And back, so config.js's readers keep working.
  const legacy = list.toLegacy();
  assert.equal(legacy.local.length, 2);
  assert.equal(legacy.remote.length, 1);
  assert.deepEqual(legacy.shortCuts, { www: 'Ctrl+1' });
});

test('the shared bookmark list is the location-profile store', () => {
  const bookmarks = new W.Bookmarks({});
  bookmarks.shared.add({ name: 'prod', local: 'C:\\p', remote: '/p' });
  assert.equal(bookmarks.get(W.SHARED_BOOKMARKS_KEY).count, 1);
  assert.ok(W.SHARED_BOOKMARKS_KEY.startsWith(W.HIDDEN_PREFIX),
    'the hidden prefix keeps it out of the per-session list');
  bookmarks.ensure('sftp://user@host').add({ name: 'a' });
  assert.deepEqual(bookmarks.keys().length, 2);
});

// ===========================================================================
// interface state
// ===========================================================================

test('the default window never exceeds the work area', () => {
  const small = W.defaultInterfaceState({ width: 800, height: 600 });
  assert.equal(small.scpCommander.windowParams, W.formatDefaultWindowParams(760, 570));
  const large = W.defaultInterfaceState({ width: 3840, height: 2160 });
  assert.equal(large.scpCommander.windowParams, W.formatDefaultWindowParams(1090, 700));
  assert.equal(large.scpExplorer.windowParams, W.formatDefaultWindowParams(960, 720));
});

test('a wide screen gets the wider default queue layout', () => {
  assert.ok(W.defaultInterfaceState({ width: 1400, height: 900 }).queueView.layout.startsWith('70,250,250'));
  assert.ok(W.defaultInterfaceState({ width: 900, height: 700 }).queueView.layout.startsWith('70,160,160'));
});

test('the shipped column and toolbar layouts are the ones WinSCP writes', () => {
  const state = W.defaultInterfaceState({ width: 1280, height: 800 });
  assert.equal(state.scpExplorer.dirViewParams, W.SCP_EXPLORER_DIR_VIEW_PARAMS_DEFAULT);
  assert.equal(state.scpCommander.localPanel.dirViewParams, W.SCP_COMMANDER_LOCAL_DIR_VIEW_PARAMS_DEFAULT);
  assert.ok(state.scpCommander.toolbarsLayout.includes('CommandLine=0:BottomDock:0+0'));
  assert.ok(state.scpExplorer.toolbarsLayout.endsWith('PixelsPerInch=96'));
  assert.equal(state.scpCommander.nortonLikeMode, 'keyboard');
  assert.equal(state.scpCommander.currentPanel, 'local');
});

test('compare criteria come from the two commander flags', () => {
  assert.deepEqual(W.compareCriterias({ compareByTime: true, compareBySize: false }), ['time']);
  assert.deepEqual(W.compareCriterias({ compareByTime: true, compareBySize: true }), ['time', 'size']);
  assert.deepEqual(W.compareCriterias({}), []);
});

test('a double click on a file changes directory when the panel cannot tell', () => {
  // Symlink resolution off means a "file" may really be a directory.
  assert.equal(W.resolveDoubleClickAction({
    isDirectory: false, hasSession: true, resolvingSymlinks: false, doubleClickAction: 'edit',
  }), 'changeDir');
  // With resolution on, the configured action wins.
  assert.equal(W.resolveDoubleClickAction({
    isDirectory: false, hasSession: true, resolvingSymlinks: true, doubleClickAction: 'edit',
  }), 'edit');
  // Encrypted file names DISABLE the guess: the panel cannot try to enter a
  // name it cannot read, so the configured action is used instead.
  assert.equal(W.resolveDoubleClickAction({
    isDirectory: false, hasSession: true, resolvingSymlinks: false, encryptingFiles: true, doubleClickAction: 'copy',
  }), 'copy');
  // With no session at all there is nothing to guess about.
  assert.equal(W.resolveDoubleClickAction({
    isDirectory: false, hasSession: false, doubleClickAction: 'open',
  }), 'open');
  // ...unless the user has asked for the action to always be respected.
  assert.equal(W.resolveDoubleClickAction({
    isDirectory: false, hasSession: true, resolvingSymlinks: false,
    alwaysRespectDoubleClickAction: true, doubleClickAction: 'copy',
  }), 'copy');
  // A directory is always a directory.
  assert.equal(W.resolveDoubleClickAction({ isDirectory: true, doubleClickAction: 'edit' }), 'changeDir');
});

// ===========================================================================
// the temporary-directory policy
// ===========================================================================

test('the generated temporary folder name matches the mask cleanup searches for', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-temp-'));
  try {
    const policy = new W.TemporaryDirectoryPolicy({ directory: base });
    const dir = policy.temporaryDir(false);
    const mask = policy.temporaryDir(true);
    assert.equal(path.dirname(dir), path.resolve(base));
    assert.match(path.basename(dir), /^scp\d{5}$/);
    assert.equal(path.basename(mask), 'scp?????');
    assert.equal(path.basename(dir).length, path.basename(mask).length,
      'change the name width and cleanup stops finding leftovers');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an empty temporary directory falls back to the system one', () => {
  const policy = new W.TemporaryDirectoryPolicy({ directory: '', systemTemp: 'C:\\Sys\\Temp' });
  assert.equal(policy.expandedTemporaryDirectory(), 'C:\\Sys\\Temp');
});

test('environment variables in the temporary directory are expanded', () => {
  const policy = new W.TemporaryDirectoryPolicy({
    directory: '%MYTEMP%', env: { MYTEMP: path.join(os.tmpdir(), 'expanded') },
  });
  assert.equal(policy.expandedTemporaryDirectory(), path.resolve(path.join(os.tmpdir(), 'expanded')));
  assert.equal(W.expandEnvironmentVariables('%NOPE%/x', {}), '%NOPE%/x', 'an unknown variable is left alone');
});

test('finding and cleaning up leftover temporary folders', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-temp-'));
  try {
    fs.mkdirSync(path.join(base, 'scp12345'));
    fs.writeFileSync(path.join(base, 'scp12345', 'a.txt'), 'x');
    fs.mkdirSync(path.join(base, 'scp99999'));
    fs.mkdirSync(path.join(base, 'unrelated'));
    fs.writeFileSync(path.join(base, 'scp00000'), 'a file, not a folder');
    const policy = new W.TemporaryDirectoryPolicy({ directory: base });
    assert.deepEqual(policy.findTemporaryFolders(false).map((p) => path.basename(p)), ['scp12345', 'scp99999']);
    assert.equal(policy.findTemporaryFolders(true).length, 1);
    assert.ok(policy.anyTemporaryFolders());
    policy.cleanupTemporaryFolders();
    assert.equal(policy.anyTemporaryFolders(), false);
    assert.ok(fs.existsSync(path.join(base, 'unrelated')), 'nothing else is touched');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cleanup reports every folder it could not delete, not just the first', () => {
  const policy = new W.TemporaryDirectoryPolicy({
    directory: 'X',
    fs: { rmSync() { throw new Error('locked'); }, statSync() { throw new Error('gone'); }, readdirSync() { return []; } },
  });
  assert.throws(() => policy.cleanupTemporaryFolders(['a', 'b']), (e) => {
    assert.deepEqual(e.folders, ['a', 'b']);
    return /Error deleting temporary directory/.test(e.message);
  });
});

test('the deterministic temporary path is reused and owns no root to delete', () => {
  const base = path.join(os.tmpdir(), 'wc-det');
  const policy = new W.TemporaryDirectoryPolicy({ directory: base, deterministic: true, appendPath: true });
  const first = policy.temporaryDirectoryFor('/var/www');
  const second = policy.temporaryDirectoryFor('/var/www');
  assert.equal(first.directory, second.directory, 'the same remote path gives the same local path');
  assert.equal(first.rootDirectory, '', 'nothing to clean up, so the caller must not delete anything');
  assert.ok(first.directory.endsWith(path.join('var', 'www') + path.sep));
});

test('a non-deterministic temporary path gets a unique root that can be deleted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-temp-'));
  try {
    const policy = new W.TemporaryDirectoryPolicy({ directory: base, appendSession: true, appendPath: true });
    const r = policy.temporaryDirectoryFor('/var/www', { sessionName: 'user@host:22' });
    assert.ok(r.rootDirectory, 'there is a folder to remove afterwards');
    assert.ok(r.directory.startsWith(r.rootDirectory));
    // MakeValidFileName replaces the colon but leaves "@" alone.
    assert.ok(r.directory.includes('user@host-22'), 'the session name is made a valid file name');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the "simple" temporary path skips the session and path suffixes', () => {
  const base = path.join(os.tmpdir(), 'wc-simple');
  const policy = new W.TemporaryDirectoryPolicy({
    directory: base, appendSession: true, appendPath: true, deterministic: true,
  });
  const r = policy.temporaryDirectoryFor('/var/www', { simple: true, sessionName: 'host' });
  assert.equal(r.directory, r.rootDirectory);
  assert.equal(r.directory.includes('www'), false);
});

test('MakeValidFileName replaces every character Windows refuses', () => {
  assert.equal(W.makeValidFileName('a:b;c,d=e+f<g>h|i"j[k]l m\\n/o?p*q'),
    'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q');
});

// ===========================================================================
// version history
// ===========================================================================

test('a version is added to the history once, ignoring the build number', () => {
  const v = W.compoundVersion(6, 3, 4);
  let history = W.addVersionToHistory('', v + 17, 'stable');
  assert.equal(history, `${v},stable`);
  history = W.addVersionToHistory(history, v + 99, 'stable');
  assert.equal(history, `${v},stable`, 'the same release does not add a second entry');
  history = W.addVersionToHistory(history, W.compoundVersion(6, 3, 5), 'beta');
  assert.equal(history, `${v},stable;${W.compoundVersion(6, 3, 5)},beta`);
});

test('beta and rc count as beta, and the history remembers whether any was used', () => {
  assert.ok(W.isBetaRelease('beta'));
  assert.ok(W.isBetaRelease('RC'));
  assert.equal(W.isBetaRelease('stable'), false);
  assert.equal(W.anyBetaInVersionHistory('1,stable;2,beta'), true);
  assert.equal(W.anyBetaInVersionHistory('1,stable;2,'), false);
  assert.deepEqual(W.parseVersionHistory('10000,stable'), [{ version: 10000, releaseType: 'stable' }]);
});

// ===========================================================================
// the migrations
// ===========================================================================

/** Run the migrations over a partial prefs object and report what fired. */
function run(prefs, options) {
  return W.migrate(prefs, options);
}

test('a legacy CopyOnDoubleClick bool becomes the enum it was designed to become', () => {
  let p = { copyOnDoubleClick: true };
  assert.ok(run(p).applied.includes('doubleClickAction'));
  assert.equal(p.doubleClickAction, 'copy');

  p = { copyOnDoubleClick: false };
  run(p);
  assert.equal(p.doubleClickAction, 'open');

  // A configuration that already has the enum is left alone — this port also
  // uses `copyOnDoubleClick` as a live preference of its own, so the legacy
  // read must not overwrite a real value or delete the key.
  p = { copyOnDoubleClick: true, doubleClickAction: 'edit' };
  assert.equal(run(p).applied.includes('doubleClickAction'), false);
  assert.equal(p.doubleClickAction, 'edit');
  assert.equal(p.copyOnDoubleClick, true);

  // The ordinal form of the current key is normalised too.
  p = { doubleClickAction: 2 };
  run(p);
  assert.equal(p.doubleClickAction, 'edit');
});

test('a legacy FormatSizeBytes bool maps false to none and true to kilobytes', () => {
  const off = { formatSizeBytes: false };
  run(off);
  assert.equal(off.formatSizeBytes, 'none');
  const on = { formatSizeBytes: true };
  run(on);
  assert.equal(on.formatSizeBytes, 'kilo');
  const already = { formatSizeBytes: 'short' };
  assert.equal(run(already).applied.includes('formatSizeBytes'), false);
});

test('a legacy ExplorerStyleSelection bool becomes the Norton-like mode', () => {
  const explorerStyle = { scpCommander: { explorerStyleSelection: true } };
  run(explorerStyle);
  assert.equal(explorerStyle.scpCommander.nortonLikeMode, 'off');
  const nortonStyle = { scpCommander: { explorerStyleSelection: false } };
  run(nortonStyle);
  assert.equal(nortonStyle.scpCommander.nortonLikeMode, 'on');
  assert.equal('explorerStyleSelection' in nortonStyle.scpCommander, false);
});

test('a toolbar layout stored under the pre-rename key is picked up', () => {
  const p = { scpCommander: { toolbarsLayoutOld: 'Menu=1:TopDock:0+0', toolbarsLayout: '' } };
  assert.ok(run(p).applied.includes('toolbarsLayout'));
  assert.equal(p.scpCommander.toolbarsLayout, 'Menu=1:TopDock:0+0');

  // A layout already stored under the new key is NOT overwritten by the old one.
  const both = { scpExplorer: { toolbarsLayoutOld: 'old', toolbarsLayout: 'new' } };
  run(both);
  assert.equal(both.scpExplorer.toolbarsLayout, 'new');
});

test('the legacy single editor is turned into a list rather than dropped', () => {
  const p = {
    editor: {
      list: [], editor: 'external', externalEditor: 'vim.exe', externalEditorText: true, sDIExternalEditor: true,
    },
  };
  assert.ok(run(p).applied.includes('editorList'));
  assert.equal(p.editor.list.length, 2);
  assert.equal(p.editor.list[0].external, 'vim.exe');
  assert.equal(p.editor.list[0].type, 'external');
  assert.equal(p.editor.list[0].externalParams, true, 'the text-mode flag survives');
  assert.equal(p.editor.list[1].type, 'internal');
  assert.equal('externalEditor' in p.editor, false);
});

test('an empty editor list with no legacy record gets the shipped default pair', () => {
  const p = { editor: { list: [] } };
  run(p);
  assert.equal(p.editor.list.length, 2);
  assert.equal(p.editor.list[0].type, 'internal');
  assert.equal(p.editor.list[1].type, 'external');
  assert.equal(p.editor.list[1].external, W.DEFAULT_EXTERNAL_EDITOR);
});

test('a populated editor list is never rebuilt', () => {
  const p = { editor: { list: [{ mask: '*.txt', type: 'internal' }] } };
  assert.equal(run(p).applied.includes('editorList'), false);
  assert.equal(p.editor.list.length, 1);
});

test('the CopyParamList=-1 sentinel means "never configured", so seed the defaults', () => {
  const p = { copyParamListCount: -1, copyParamList: [] };
  assert.ok(run(p, { defaultPresets: DEFAULT_PRESETS }).applied.includes('copyParamList'));
  assert.equal(p.copyParamList.length, DEFAULT_PRESETS.length);
  assert.equal('copyParamListCount' in p, false);
});

test('a real preset count leaves an empty list empty', () => {
  const p = { copyParamListCount: 0, copyParamList: [] };
  run(p, { defaultPresets: DEFAULT_PRESETS });
  assert.deepEqual(p.copyParamList, [], 'the user deleted every preset; do not put them back');
});

test('a preset stored with only the flattened autoSelect gains a real rule', () => {
  const p = { copyParamList: [{ name: 'a', autoSelect: '*.example.com', copyParam: {} }] };
  run(p);
  assert.equal(p.copyParamList[0].rule.hostName, '*.example.com');
  const list = new W.CopyParamList(p.copyParamList);
  assert.equal(list.get(list.find({ hostName: 'web.example.com' })).name, 'a');
});

test('the CustomCommandsNone marker keeps an empty command list empty', () => {
  const p = { customCommandsNone: true, customCommands: [] };
  assert.ok(run(p, { defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS }).applied.includes('customCommands'));
  assert.deepEqual(p.customCommands, []);
  // Without the marker, an empty list means "never configured".
  const q = { customCommands: [] };
  run(q, { defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS });
  assert.equal(q.customCommands.length, DEFAULT_CUSTOM_COMMANDS.length);
});

test('the update connection type is derived from the proxy host when unset', () => {
  const withProxy = { updates: { proxyHost: 'proxy.local' } };
  run(withProxy);
  assert.equal(withProxy.updates.connectionType, 'proxy');
  const withoutProxy = { updates: { proxyHost: '' } };
  run(withoutProxy);
  assert.equal(withoutProxy.updates.connectionType, 'auto');
  const explicit = { updates: { connectionType: 'direct', proxyHost: 'x' } };
  run(explicit);
  assert.equal(explicit.updates.connectionType, 'direct');
});

test('an unquoted PuTTY path is quoted, but only when it names a real program', () => {
  const known = { integration: { puttyPath: 'C:\\Program Files\\PuTTY\\putty.exe' } };
  assert.ok(run(known, { defaultPuttyPath: 'C:\\Program Files\\PuTTY\\putty.exe' }).applied.includes('puttyPath'));
  assert.equal(known.integration.puttyPath, '"C:\\Program Files\\PuTTY\\putty.exe"');

  // A path that is neither the default nor an existing file is left alone: it
  // already carries parameters, so quoting the whole thing would break it.
  const custom = { integration: { puttyPath: 'kitty.exe -title !N' } };
  run(custom, { defaultPuttyPath: 'C:\\PuTTY\\putty.exe', fileExists: () => false });
  assert.equal(custom.integration.puttyPath, 'kitty.exe -title !N');

  // Already quoted, nothing to do.
  const quoted = { integration: { puttyPath: '"C:\\PuTTY\\putty.exe"' } };
  assert.equal(run(quoted, { defaultPuttyPath: 'C:\\PuTTY\\putty.exe' }).applied.includes('puttyPath'), false);
});

test('the queue\'s remember-password flag moves to the session setting', () => {
  const p = { queue: { queueRememberPassword: true } };
  assert.ok(run(p).applied.includes('sessionRememberPassword'));
  assert.equal(p.queue.rememberPassword, true);
  assert.equal('queueRememberPassword' in p.queue, false);
});

test('a file-colour string becomes the structured list, colours converted', () => {
  const p = { fileColors: '0000FF:*.log,"00FF00:*.tmp; *.bak"' };
  assert.ok(run(p).applied.includes('fileColors'));
  assert.deepEqual(p.fileColors, [
    { mask: '*.log', color: '#FF0000' },
    { mask: '*.tmp; *.bak', color: '#00FF00' },
  ]);
});

test('legacy bookmarks are paired into location profiles without losing a side', () => {
  const p = {
    bookmarks: {
      'sftp://host': {
        local: [{ path: 'C:\\www', name: 'www' }],
        remote: [{ path: '/var/www', name: 'www' }],
        shortCuts: {},
      },
    },
  };
  assert.ok(run(p).applied.includes('bookmarks'));
  const entry = p.bookmarks['sftp://host'];
  assert.equal(entry.bookmarks.length, 1);
  assert.equal(entry.bookmarks[0].local, 'C:\\www');
  assert.equal(entry.bookmarks[0].remote, '/var/www');
  assert.equal(entry.local.length, 1, 'the legacy shape is still written for existing readers');
});

test('the running version is recorded in the history on load', () => {
  const p = {};
  const v = W.compoundVersion(6, 3, 4);
  assert.ok(run(p, { compoundVersion: v, releaseType: 'stable' }).applied.includes('versionHistory'));
  assert.equal(p.versionHistoryVersions, `${v},stable`);
});

test('a numeric interface and panel search are normalised', () => {
  const p = { interface: 1, panel: { incrementalSearch: -1 } };
  run(p);
  assert.equal(p.interface, 'explorer');
  assert.equal(p.panel.incrementalSearch, 'off');
  const on = { panel: { incrementalSearch: 0 } };
  run(on);
  assert.equal(on.panel.incrementalSearch, 'typing');
});

test('the renamed drag-drop confirmation key is dropped, not read back inverted', () => {
  // Stored as a bool, false is 0 and asOn is also 0, so reading the old key
  // would turn "confirmation off" into "confirmation always on".
  const p = { dDTransferConfirmationLegacy: false, dDTransferConfirmation: true };
  assert.ok(run(p).applied.includes('ddTransferConfirmation'));
  assert.equal('dDTransferConfirmationLegacy' in p, false);
});

test('every migration is idempotent — running them twice changes nothing more', () => {
  const p = {
    copyOnDoubleClick: true,
    formatSizeBytes: false,
    scpCommander: { explorerStyleSelection: true, toolbarsLayoutOld: 'x', toolbarsLayout: '' },
    editor: { list: [], editor: 'external', externalEditor: 'vim.exe' },
    copyParamListCount: -1,
    copyParamList: [],
    customCommands: [],
    updates: { proxyHost: 'p' },
    integration: { puttyPath: 'C:\\PuTTY\\putty.exe' },
    queue: { queueRememberPassword: true },
    fileColors: '0000FF:*.log',
    bookmarks: { k: { local: [{ path: 'a', name: 'a' }], remote: [], shortCuts: {} } },
    panel: { incrementalSearch: 0 },
    interface: 0,
  };
  const options = {
    compoundVersion: W.compoundVersion(6, 3, 4),
    releaseType: 'stable',
    defaultPresets: DEFAULT_PRESETS,
    defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS,
    defaultPuttyPath: 'C:\\PuTTY\\putty.exe',
  };
  const first = run(p, options);
  assert.ok(first.applied.length >= 10, `expected many migrations, got ${first.applied}`);
  const snapshot = JSON.stringify(p);
  const second = run(p, options);
  assert.deepEqual(second.applied, [], `second pass should be a no-op, got ${second.applied}`);
  assert.equal(JSON.stringify(p), snapshot);
});

test('a migration that throws does not abandon the rest of the configuration', () => {
  const broken = { name: 'boom', apply() { throw new Error('kaboom'); } };
  W.MIGRATIONS.push(broken);
  try {
    const p = { formatSizeBytes: true };
    const result = W.migrate(p);
    assert.equal(p.formatSizeBytes, 'kilo', 'the migrations before and after it still ran');
    assert.ok(result.applied.some((a) => a.startsWith('boom!')));
  } finally {
    W.MIGRATIONS.splice(W.MIGRATIONS.indexOf(broken), 1);
  }
});

test('the current defaults need no migration at all', () => {
  const prefs = JSON.parse(JSON.stringify(PREF_DEFAULTS));
  prefs.copyParamList = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
  prefs.customCommands = JSON.parse(JSON.stringify(DEFAULT_CUSTOM_COMMANDS));
  const result = W.migrate(prefs, { defaultPresets: DEFAULT_PRESETS, defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS });
  // Only the editor list (shipped with one row) and the preset rules are shaped
  // by the migrations; nothing else in the shipped defaults is out of date.
  assert.deepEqual(result.applied.filter((a) => !['copyParamList'].includes(a)), []);
});

// ===========================================================================
// WinConfiguration over a real store
// ===========================================================================

test('load() migrates, fills the interface defaults and records the version', () => {
  const { config, cleanup } = freshConfig();
  try {
    config.prefs.formatSizeBytes = true;
    config.prefs.scpExplorer.toolbarsLayout = '';
    const win = new W.WinConfiguration(config, {
      appVersion: '6.3.4', releaseType: 'stable', workArea: { width: 1920, height: 1080 },
      defaultPresets: DEFAULT_PRESETS, defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS,
    }).load();
    assert.ok(win.migrationsApplied.includes('formatSizeBytes'));
    assert.equal(config.prefs.formatSizeBytes, 'kilo');
    assert.equal(config.prefs.scpExplorer.toolbarsLayout, W.SCP_EXPLORER_TOOLBARS_LAYOUT_DEFAULT);
    assert.equal(config.data.version, W.CONFIG_VERSION);
    assert.deepEqual(win.versionHistory, [{ version: W.compoundVersion(6, 3, 4), releaseType: 'stable' }]);
    assert.equal(win.anyBetaInVersionHistory, false);
  } finally { cleanup(); }
});

test('load() never overwrites a layout the user has already customised', () => {
  const { config, cleanup } = freshConfig();
  try {
    config.prefs.scpCommander.toolbarsLayout = 'Menu=1:TopDock:0+0';
    config.prefs.scpCommander.localPanelWidth = 0.3;
    new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    assert.equal(config.prefs.scpCommander.toolbarsLayout, 'Menu=1:TopDock:0+0');
    assert.equal(config.prefs.scpCommander.localPanelWidth, 0.3);
  } finally { cleanup(); }
});

test('the editor list is read from the store and written back on change', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    assert.equal(win.defaultEditorForFile('notes.txt').editor, 'internal');
    win.editorList = new W.EditorList([
      { mask: '*.log', type: 'external', external: 'tail.exe' },
      { mask: '*.*', type: 'internal' },
    ]);
    assert.equal(config.prefs.editor.list.length, 2);
    assert.equal(win.defaultEditorForFile('a.log').external, 'tail.exe');
    // Assigning an equal list is not a change and does not touch the store.
    const before = JSON.stringify(config.prefs.editor.list);
    win.editorList = new W.EditorList(config.prefs.editor.list);
    assert.equal(JSON.stringify(config.prefs.editor.list), before);
  } finally { cleanup(); }
});

test('the current transfer preset resolves through the preset list', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4', defaultPresets: DEFAULT_PRESETS }).load();
    assert.equal(win.copyParamIndex, -1, 'no preset means the default settings');
    assert.equal(win.currentCopyParam.transferMode, COPY_PARAM_DEFAULTS.transferMode);
    win.copyParamCurrent = 'Text';
    assert.equal(win.copyParamIndex, win.copyParamList.indexOfName('Text'));
    assert.equal(win.currentCopyParam.transferMode, 'text');
    assert.ok(win.hasCopyParamPreset('Text'));
    assert.equal(win.hasCopyParamPreset('Nope'), false);
    win.copyParamIndex = -1;
    assert.equal(win.copyParamCurrent, '');
  } finally { cleanup(); }
});

test('a preset auto-selects for a matching session and not for another', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4', defaultPresets: DEFAULT_PRESETS }).load();
    win.copyParamList = new W.CopyParamList([
      { name: 'Production', rule: { hostName: '*.prod.example' }, copyParam: { preserveTime: false } },
      { name: 'Plain', copyParam: {} },
    ]);
    assert.equal(win.autoSelectPreset({ hostName: 'web.prod.example' }).name, 'Production');
    assert.equal(win.autoSelectPreset({ hostName: 'web.dev.example' }), null);
  } finally { cleanup(); }
});

test('bookmarks persist in both shapes so existing readers keep working', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    win.bookmarksFor('sftp://host').add({ name: 'www', local: 'C:\\www', remote: '/var/www' });
    win.locationProfiles.add({ name: 'prod', local: 'C:\\p', remote: '/p' });
    win.saveBookmarks();
    const stored = config.prefs.bookmarks['sftp://host'];
    assert.equal(stored.bookmarks.length, 1);
    assert.deepEqual(config.bookmarksFor('sftp://host').local, [{ path: 'C:\\www', name: 'www' }]);
    assert.equal(config.prefs.bookmarks[W.SHARED_BOOKMARKS_KEY].bookmarks[0].name, 'prod');
    assert.equal(win.bookmarks.get('sftp://host').modified, false, 'saving clears the modified flags');
  } finally { cleanup(); }
});

test('file colours go through the store and resolve to a colour per file', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    win.fileColors = [{ mask: '*.log', color: '#FF0000' }];
    assert.deepEqual(config.prefs.fileColors, [{ mask: '*.log', color: '#FF0000' }]);
    assert.equal(win.fileColorFor('a.log'), '#FF0000');
    assert.equal(win.fileColorFor('a.txt'), '');
  } finally { cleanup(); }
});

test('the temporary-directory policy is built from the stored preferences', () => {
  const { config, cleanup } = freshConfig();
  try {
    config.prefs.temporaryDirectoryDeterministic = true;
    config.prefs.temporaryDirectoryAppendSession = true;
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    const policy = win.temporaryDirectoryPolicy();
    assert.equal(policy.deterministic, true);
    assert.equal(policy.appendSession, true);
    assert.equal(policy.appendPath, true);
    assert.equal(policy.cleanup, true);
  } finally { cleanup(); }
});

test('extensions are loaded from disk and their state is stored', () => {
  const { config, cleanup } = freshConfig();
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-app-'));
  try {
    fs.mkdirSync(path.join(appDir, 'Extensions'));
    fs.writeFileSync(path.join(appDir, 'Extensions', 'Zip.WinSCPextension.ps1'),
      '# @name Zip\n# @command echo zip\n# @shortcut Ctrl+4\n');
    const win = new W.WinConfiguration(config, {
      appVersion: '6.3.4', roots: { appDir, userDataDir: path.join(appDir, 'nothing') },
    }).load();
    const list = win.loadExtensions();
    assert.deepEqual(list.items.map((c) => c.name), ['Zip']);
    assert.equal(list.get(0).id, 'commonext/Zip');
    assert.equal(config.prefs.extensions.length, 1);
    assert.deepEqual(win.customCommandShortCuts().includes('Ctrl+4'), true);

    // Reordering and overriding a shortcut is recorded in the extension state.
    const changed = new W.CustomCommandList(config.prefs.extensions);
    changed.get(0).shortCut = 'Ctrl+7';
    win.setExtensionList(changed);
    assert.equal(config.prefs.extensionState.order, 'commonext/Zip');
    assert.equal(config.prefs.extensionState.shortCuts, 'Ctrl+7=commonext/Zip');
  } finally {
    cleanup();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('the dark-theme tri-state resolves against the system only on auto', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, { appVersion: '6.3.4' }).load();
    config.prefs.theme.mode = 'dark';
    assert.equal(win.useDarkTheme(false), true);
    config.prefs.theme.mode = 'light';
    assert.equal(win.useDarkTheme(true), false);
    config.prefs.theme.mode = 'system';
    assert.equal(win.useDarkTheme(true), true);
    assert.equal(win.useDarkTheme(false), false);
  } finally { cleanup(); }
});

test('the custom command list reports whether the user has touched it', () => {
  const { config, cleanup } = freshConfig();
  try {
    const win = new W.WinConfiguration(config, {
      appVersion: '6.3.4', defaultCustomCommands: DEFAULT_CUSTOM_COMMANDS,
    }).load();
    assert.equal(win.customCommandsAreDefaults(), true);
    const list = new W.CustomCommandList(config.prefs.customCommands);
    list.add('Mine', 'echo !', 0);
    win.customCommandList = list;
    assert.equal(win.customCommandsAreDefaults(), false);
    assert.equal(config.prefs.customCommands.length, DEFAULT_CUSTOM_COMMANDS.length + 1);
  } finally { cleanup(); }
});

// ===========================================================================
// regressions found while verifying against the C++
// ===========================================================================

test('a bookmark key separates node from name, so a split cannot collide', () => {
  // TBookmark::BookmarkKey is FORMAT(L"%s\1%s", (Node, Name)). Concatenating
  // the two without the separator makes ("Wor","ka") and ("Work","a") the same
  // bookmark, and the second add would be refused as a duplicate.
  const list = new W.BookmarkList();
  list.add({ node: 'Wor', name: 'ka', remote: '/one' });
  assert.doesNotThrow(() => list.add({ node: 'Work', name: 'a', remote: '/two' }));
  assert.equal(list.count, 2);
  assert.equal(list.findByName('Wor', 'ka').remote, '/one');
  assert.equal(list.findByName('Work', 'a').remote, '/two');
  assert.notEqual(W.Bookmark.key('Wor', 'ka'), W.Bookmark.key('Work', 'a'));
});

test('bookmark keys are case-insensitive, as TBookmarkList\'s list is', () => {
  // FBookmarks->CaseSensitive = false, so "Docs" and "docs" are one bookmark:
  // WinSCP refuses the second rather than showing two rows nobody can tell apart.
  const list = new W.BookmarkList();
  const docs = list.add({ node: 'Work', name: 'Docs', remote: '/docs' });
  assert.throws(() => list.add({ node: 'work', name: 'docs' }), /already exists/);
  assert.equal(list.findByName('WORK', 'DOCS'), docs);
  // Renaming onto a case variant of another key is refused too.
  const other = list.add({ node: 'Work', name: 'Other' });
  assert.throws(() => list.rename(other, 'DOCS'), /already exists/);
  // But changing only the case of a bookmark's own name is allowed.
  assert.equal(list.rename(docs, 'DOCS').name, 'DOCS');
});

test('a quote anywhere in a token toggles quoting, as DoCutToken does', () => {
  // CutTokenEx does not require the quote to open the token.
  assert.deepEqual(W.cutTokens('Log"my file".txt next'), ['Logmy file.txt', 'next']);
  assert.deepEqual(W.cutTokens('a "b c" d'), ['a', 'b c', 'd']);
  // Tabs separate as well as spaces; a newline never reaches here.
  assert.deepEqual(W.cutTokens('a\tb'), ['a', 'b']);
  // With EscapeQuotesInQuotesOnly, "" is a literal quote only INSIDE quotes;
  // outside them it is the deliberate empty string.
  assert.deepEqual(W.cutTokens('x "" y'), ['x', '', 'y']);
  assert.deepEqual(W.cutTokens('"a""b"'), ['a"b']);
});

test('an option caption may carry an embedded quoted run', () => {
  const option = W.parseExtensionOption('log -run textbox Path"a b".log default', 'ext');
  assert.equal(option.caption, 'Patha b.log');
  assert.equal(option.default, 'default');
});

test('the queue-view defaults are actually written, not just computed', () => {
  const wide = freshConfig();
  try {
    new W.WinConfiguration(wide.config, { appVersion: '6.3.4', workArea: { width: 1920, height: 1080 } }).load();
    assert.equal(wide.config.prefs.queueView.layout, '70,250,250,80,80,80,100,;96');
    assert.equal(wide.config.prefs.queueView.show, 'hideWhenEmpty');
    assert.equal(wide.config.prefs.queueView.height, 140);
  } finally { wide.cleanup(); }

  const narrow = freshConfig();
  try {
    new W.WinConfiguration(narrow.config, { appVersion: '6.3.4', workArea: { width: 900, height: 700 } }).load();
    assert.equal(narrow.config.prefs.queueView.layout, '70,160,160,80,80,80,100,;96');
  } finally { narrow.cleanup(); }
});

test('the PuTTY-path repair compares expanded paths on both sides', () => {
  // The shipped default is written with %PROGRAMFILES% in it, while an older
  // configuration stored the resolved path. Only expanding BOTH sides shows
  // they name the same program, and WinSCP quotes it even when that program
  // is not actually installed on this machine.
  const env = { PROGRAMFILES: 'C:\Program Files' };
  const stored = { integration: { puttyPath: 'C:\Program Files\PuTTY\putty.exe' } };
  const applied = W.migrate(stored, {
    defaultPuttyPath: '%PROGRAMFILES%\PuTTY\putty.exe', env, fileExists: () => false,
  }).applied;
  assert.ok(applied.includes('puttyPath'));
  assert.equal(stored.integration.puttyPath, '"C:\Program Files\PuTTY\putty.exe"');

  // And a genuinely different program with parameters is still left alone.
  const custom = { integration: { puttyPath: 'C:\Tools\kitty portable.exe -title !N' } };
  W.migrate(custom, {
    defaultPuttyPath: '%PROGRAMFILES%\PuTTY\putty.exe', env, fileExists: () => false,
  });
  assert.equal(custom.integration.puttyPath, 'C:\Tools\kitty portable.exe -title !N');
});
